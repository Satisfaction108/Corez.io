'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLAY_MS = Math.max(8000, +process.env.NET_PLAY_MS || 20000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
async function check(name, fn) {
    const s = Date.now();
    try { const note = await fn(); results.push(true); console.log(`ok   ${name} (${Date.now() - s} ms)${note ? ' - ' + note : ''}`); }
    catch (e) { results.push(false); console.log(`FAIL ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 10).join('\n     ')}`); }
}

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

async function loadSmooth() {
    const url = pathToFileURL(path.join(REPO, 'public', 'client', 'netSmooth.js')).href + '?t=' + Date.now();
    const m = await import(url);
    return m.netSmooth;
}

function simulate(ns, { lat, jit, stalls, teleportAt }) {
    const rand = rng(9);
    const tr = ns.track();
    const arr = [];
    let last = 0;
    for (let k = 0; k < 900; k++) {
        const stamp = 50000 + k * 1000 / 30;
        let x = 600 * Math.sin(k / 40), y = k * 4;
        if (teleportAt && k >= teleportAt) x += 2000;
        let at = stamp + 3000 + lat + (rand() * 2 - 1) * jit;
        for (const [k0, ms] of stalls) if (k >= k0 && k < k0 + Math.ceil(ms / 33.3)) at = Math.max(at, 50000 + 3000 + lat + k0 * 1000 / 30 + ms);
        at = Math.max(at, last);
        last = at;
        arr.push([at, stamp, x, y]);
    }
    let ai = 0, px = null, py = null;
    const steps = [];
    let tpFrame = -1, frameNo = 0, afterTp = null;
    for (let t = arr[0][0]; t < arr[arr.length - 1][0]; t += 1000 / 60) {
        while (ai < arr.length && arr[ai][0] <= t) { const a = arr[ai++]; ns.onSnapshot(a[1], a[0]); ns.push(tr, a[1], a[2], a[3], 0); }
        ns.frame(t);
        const r = ns.entity(tr, t);
        frameNo++;
        if (!r) continue;
        if (px !== null) {
            const d = Math.hypot(r.x - px, r.y - py);
            if (d > 1000 && tpFrame < 0) { tpFrame = frameNo; afterTp = r.x; }
            else steps.push(d);
        }
        px = r.x; py = r.y;
    }
    steps.sort((a, b) => a - b);
    return { max: steps[steps.length - 1], p99: steps[Math.floor(steps.length * 0.99)], tpFrame, afterTp, stats: ns.stats() };
}

function portFree(port) {
    return new Promise(res => {
        const s = net.createServer();
        s.once('error', () => res(false));
        s.once('listening', () => s.close(() => res(true)));
        s.listen(port, '127.0.0.1');
    });
}
async function freeBase(from) {
    for (let p = from; p < from + 600; p += 10) {
        let ok = true;
        for (let i = 0; i <= 7 && ok; i++) ok = await portFree(p + i);
        if (ok) return p;
    }
    throw new Error('no free port from ' + from);
}

function lagProxy(listen, target, lat, jit, every, seed) {
    const rand = rng(seed);
    const st = { until: 0, next: Date.now() + every };
    const timer = setInterval(() => {
        const now = Date.now();
        if (now >= st.next) { const d = 300 + 500 * rand(); st.until = now + d; st.next = now + d + every * (0.6 + 0.8 * rand()); }
    }, 5);
    const lane = (dst) => {
        const q = [];
        let last = 0, armed = null;
        const pump = () => {
            armed = null;
            const now = Date.now();
            if (now < st.until) { armed = setTimeout(pump, st.until - now); return; }
            while (q.length && q[0][0] <= now) { const c = q.shift()[1]; if (!dst.destroyed) dst.write(c); }
            if (q.length) armed = setTimeout(pump, Math.max(1, q[0][0] - now));
        };
        return (chunk) => {
            const now = Date.now();
            let t = Math.max(last, now + lat + (rand() * 2 - 1) * jit);
            last = t;
            q.push([t, chunk]);
            if (!armed) armed = setTimeout(pump, Math.max(0, t - now));
        };
    };
    const srv = net.createServer((c) => {
        c.setNoDelay(true);
        const u = net.connect(target, '127.0.0.1');
        u.setNoDelay(true);
        c.on('data', lane(u));
        u.on('data', lane(c));
        const bail = () => { try { c.destroy(); } catch (e) { } try { u.destroy(); } catch (e) { } };
        c.on('error', bail); u.on('error', bail); c.on('close', bail); u.on('close', bail);
    });
    srv.listen(listen, '127.0.0.1');
    return { close: () => { clearInterval(timer); srv.close(); } };
}

class Page {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pend = new Map(); this.errors = [];
        ws.on('message', (m) => {
            const d = JSON.parse(m);
            if (d.id && this.pend.has(d.id)) {
                const p = this.pend.get(d.id); this.pend.delete(d.id);
                if (d.error) p.rej(new Error(JSON.stringify(d.error))); else p.res(d.result);
                return;
            }
            if (d.method === 'Runtime.exceptionThrown') {
                const x = d.params.exceptionDetails || {};
                this.errors.push('exception: ' + ((x.exception && x.exception.description) || x.text || '').split('\n').slice(0, 3).join(' | '));
            } else if (d.method === 'Page.javascriptDialogOpening') {
                this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
            }
        });
    }
    send(method, params = {}) {
        return new Promise((res, rej) => {
            const i = ++this.id;
            this.pend.set(i, { res, rej });
            this.ws.send(JSON.stringify({ id: i, method, params }));
        });
    }
    async eval(expr) {
        const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
        if (r.exceptionDetails) throw new Error('eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        return r.result.value;
    }
}

const PROBE = (wsPort) => `(() => {
    const NW = window.WebSocket;
    const W = function (url, p) {
        url = String(url).replace(/^(wss?:\\/\\/)(localhost|127\\.0\\.0\\.1)(:\\d+)?/, 'ws://localhost:${wsPort}');
        return p !== undefined ? new NW(url, p) : new NW(url);
    };
    W.prototype = NW.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) W[k] = NW[k];
    window.WebSocket = W;
    const N = window.__net = { on: false, own: [], rem: {}, frames: 0 };
    const raf = () => {
        requestAnimationFrame(raf);
        const g = window.global;
        if (!N.on || !g || !g.player) return;
        N.frames++;
        N.own.push([performance.now(), g.player.renderx, g.player.rendery]);
        const me = g.selfEnt ? g.selfEnt.id : -1;
        for (const e of g.entities || []) {
            if (!e || !e.render || !e.nameplate || e.id === me) continue;
            if (e.render.status && e.render.status.getFade && e.render.status.getFade() < 1) continue;
            (N.rem[e.id] || (N.rem[e.id] = [])).push([N.frames, e.render.x, e.render.y]);
        }
    };
    requestAnimationFrame(raf);
})()`;

async function browserCheck() {
    if (!fs.existsSync(CHROME)) { console.log('skipped: no Chrome (' + CHROME + ')'); return; }
    let WS;
    try { WS = require(path.join(REPO, 'node_modules', 'ws')); } catch (e) { console.log('skipped: no ws module'); return; }
    const base = await freeBase(+process.env.NET_PORT || 4700);
    const port = base, proxyPort = base + 6, cdpPort = base + 5;
    const origin = 'http://localhost:' + port;
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-net-smooth-'));
    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ...process.env, ROYALE_DEBUG: '1', SOLO_RAIDS: '1', BOT_CHAT_AI: 'false', ROYALE_FILL_CAP: '8',
        SESSION_SECRET: 'net-smooth-test-secret-0123456789-abcdefgh', DATA_DIR: dataDir, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
        TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port),
        TUT_PORT: String(port + 1), DUO_PORT: String(port + 2), DW_PORT: String(port + 3), SOLO_OVERFLOW_PORT: String(port + 4) };
    delete env.NODE_ENV;
    for (const k of Object.keys(env)) if (/^(DISCORD_|WEB_PUSH_|BACKUP_)/.test(k)) delete env[k];
    const logFile = path.join(ROOT, 'server.log');
    const out = fs.openSync(logFile, 'w');
    let server = null, chrome = null, ws = null, proxy = null, ok = false;
    try {
        server = spawn(process.execPath, ['index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
        let up = false;
        for (let i = 0; i < 240 && !up; i++) {
            if (server.exitCode !== null) throw new Error('server exited (' + server.exitCode + '), log ' + logFile);
            try { up = (await fetch(origin + '/api/config')).status === 200; } catch (e) { }
            if (!up) await sleep(250);
        }
        if (!up) throw new Error('server never answered on ' + origin);
        proxy = lagProxy(proxyPort, port, 250, 60, 6000, 3);
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + path.join(ROOT, 'chrome'),
            '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--window-size=1280,720',
            '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'ignore'] });
        let target = null;
        for (let i = 0; i < 80 && !target; i++) {
            try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t => t.type === 'page'); } catch (e) { }
            if (!target) await sleep(250);
        }
        if (!target) throw new Error('Chrome never opened a page on ' + cdpPort);
        ws = new WS(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        const page = new Page(ws);
        await page.send('Runtime.enable');
        await page.send('Page.enable');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
        await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE(proxyPort) });
        await page.send('Page.navigate', { url: origin + '/' });
        await check('lagged raid: plays smoothly behind a 250 ms / 60 ms jitter / stall proxy', async () => {
            let ready = false;
            for (let i = 0; i < 160 && !ready; i++) {
                await sleep(250);
                try { ready = await page.eval(`document.readyState === 'complete' && !!document.getElementById('startButton') && typeof window.dwPlaying === 'function'`); } catch (e) { }
            }
            if (!ready) throw new Error('the page never loaded');
            await sleep(1000);
            await page.eval(`document.getElementById('startButton').click(), true`);
            let playing = false;
            for (let i = 0; i < 200 && !playing; i++) { await sleep(250); playing = await page.eval('window.dwPlaying()'); }
            if (!playing) throw new Error('never got into the raid behind the proxy');
            await sleep(8000);
            await page.eval(`(() => { const t = window.royaleTalk; t('DBG', 'god'); t('DBG', 'botdiff', 100); t('DBG', 'huntme'); t('DBG', 'tobot'); return 1; })()`);
            await sleep(1500);
            await page.eval(`(() => {
                const cv = document.getElementById('gameCanvas') || document.querySelector('canvas');
                const K = { a: 65, d: 68 };
                const kev = (type, k) => { const e = new KeyboardEvent(type, { key: k, code: 'Key' + k.toUpperCase(), bubbles: true, cancelable: true });
                    Object.defineProperty(e, 'keyCode', { get: () => K[k] }); Object.defineProperty(e, 'which', { get: () => K[k] }); cv.dispatchEvent(e); };
                let i = 0;
                window.__net.drive = setInterval(() => { const k = i % 2 ? 'a' : 'd'; kev('keyup', i % 2 ? 'd' : 'a'); kev('keydown', k); i++; }, 1200);
                window.__net.on = true;
                return 1;
            })()`);
            await sleep(PLAY_MS);
            const raw = await page.eval(`(() => { const N = window.__net; N.on = false; clearInterval(N.drive); return { own: N.own, rem: N.rem, frames: N.frames, ns: window.dwNetSmooth ? window.dwNetSmooth.stats() : null }; })()`);
            if (page.errors.length) throw new Error(page.errors.length + ' page error(s):\n' + page.errors.slice(0, 6).join('\n'));
            if (!raw.ns) throw new Error('window.dwNetSmooth is missing');
            if (!(raw.ns.snapshots > 100)) throw new Error('netSmooth saw too few snapshots: ' + JSON.stringify(raw.ns));
            if (!(raw.frames > PLAY_MS / 1000 * 15)) throw new Error('too few frames: ' + raw.frames);
            const mins = PLAY_MS / 60000;
            let ownJumps = 0, ownFreeze = 0, run = 0;
            for (let i = 1; i < raw.own.length; i++) {
                const a = raw.own[i - 1], b = raw.own[i];
                const d = Math.hypot(b[1] - a[1], b[2] - a[2]);
                if (d > 60) ownJumps++;
                if (d < 0.05) run += b[0] - a[0]; else { if (run > 250) ownFreeze++; run = 0; }
            }
            let remJumps = 0, remFrames = 0;
            for (const id of Object.keys(raw.rem)) {
                const s = raw.rem[id];
                for (let i = 1; i < s.length; i++) {
                    if (s[i][0] - s[i - 1][0] !== 1) continue;
                    remFrames++;
                    if (Math.hypot(s[i][1] - s[i - 1][1], s[i][2] - s[i - 1][2]) > 60) remJumps++;
                }
            }
            const note = `own jumps ${ownJumps}, own freezes ${ownFreeze}, remote jumps ${remJumps} in ${remFrames} frames, delay ${raw.ns.delay} ms`;
            if (ownJumps / mins > 8) throw new Error('own camera teleports too often: ' + note);
            if (remFrames > 300 && remJumps / mins > 12) throw new Error('other tanks teleport too often: ' + note);
            return note;
        });
        ok = true;
    } catch (e) {
        results.push(false);
        console.log('FAIL setup\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
    } finally {
        try { if (ws) ws.close(); } catch (e) { }
        try { if (proxy) proxy.close(); } catch (e) { }
        for (const ch of [chrome, server]) {
            if (!ch || ch.exitCode !== null) continue;
            ch.kill(ch === server ? 'SIGINT' : 'SIGTERM');
            await new Promise(res => { if (ch.exitCode !== null) res(); else ch.once('exit', res); setTimeout(res, 6000); });
            if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGKILL');
        }
        fs.closeSync(out);
        if (ok && results.every(Boolean)) fs.rmSync(ROOT, { recursive: true, force: true });
        else console.log('server log: ' + logFile);
    }
}

async function main() {
    const ns = await loadSmooth();
    await check('logic: smooth motion through 250 ms / 60 ms jitter with 700 ms stalls', async () => {
        ns.reset();
        const r = simulate(ns, { lat: 250, jit: 60, stalls: [[200, 700], [520, 500]], teleportAt: 0 });
        if (!(r.max < 30)) throw new Error('a frame jumped ' + r.max.toFixed(1) + ' units: ' + JSON.stringify(r.stats));
        if (r.stats.delay !== 0) throw new Error('other tanks must be drawn at their latest position, delay was ' + r.stats.delay);
        return 'max step ' + r.max.toFixed(1) + ', p99 ' + r.p99.toFixed(1) + ', delay ' + r.stats.delay + ' ms';
    });
    await check('logic: local play keeps a short delay and no extrapolation', async () => {
        ns.reset();
        const r = simulate(ns, { lat: 1, jit: 2, stalls: [], teleportAt: 0 });
        if (!(r.stats.delay < 45)) throw new Error('delay ' + r.stats.delay + ' ms on a clean link');
        if (!(r.max < 12)) throw new Error('a frame jumped ' + r.max.toFixed(1));
        return 'delay ' + r.stats.delay + ' ms, max step ' + r.max.toFixed(1);
    });
    await check('logic: a real teleport cuts at once instead of sliding', async () => {
        ns.reset();
        const r = simulate(ns, { lat: 120, jit: 20, stalls: [], teleportAt: 450 });
        if (r.tpFrame < 0) throw new Error('the 2000-unit teleport never showed as one jump');
        if (!(r.max < 30)) throw new Error('the teleport was smeared over frames: max other step ' + r.max.toFixed(1));
        return 'cut on frame ' + r.tpFrame;
    });
    ns.reset();
    await browserCheck();
    const failed = results.filter(r => !r).length;
    console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
    return failed;
}

main().then(f => process.exit(f ? 1 : 0), e => { console.error(e); process.exit(1); });
