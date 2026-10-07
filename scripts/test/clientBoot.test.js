// Client boot smoke test: node scripts/test/clientBoot.test.js
//
// No unit test loads app.js, so a bad top-level line there (round 5: a
// `HUD` read before `const HUD` ran, a TDZ error) showed every player a black
// screen and nothing failed. This starts a local server, opens the page in
// headless Chrome over CDP, presses Play and fails on:
//   - any uncaught exception (Runtime.exceptionThrown) or console.error
//   - the game never starting (window.dwPlaying)
//   - a blank canvas (the three game layers composed and sampled)
// then dies once (DBG kill), presses Enter on the death card and checks it
// drops back in, with the same checks.
//
//   CHROME=/path/to/chrome    another Chrome (default: the macOS app)
//   CLIENT_BUILD=obfuscated   serve the built client (npm run build) instead
//   HEAVY_LOCK=/some/dir.lock take this mkdir lock while running (shared
//                             machines: one heavy process at a time)
//   BOOT_WAIT_MS=8000         how long to watch the game after Play
//
// Skips (exit 0, "skipped: no Chrome") when Chrome isn't installed. Only
// kills the server and Chrome it started itself.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WAIT_MS = Math.max(3000, +process.env.BOOT_WAIT_MS || 8000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) { console.log('skipped: no Chrome (' + CHROME + ')'); process.exit(0); }
let WS;
try { WS = require(path.join(REPO, 'node_modules', 'ws')); } catch (e) { console.log('skipped: no ws module'); process.exit(0); }

function portFree(port) {
    return new Promise(res => {
        const s = net.createServer();
        s.once('error', () => res(false));
        s.once('listening', () => s.close(() => res(true)));
        s.listen(port, '127.0.0.1');
    });
}
// a base port with base..base+5 all free (server, tutorial, duo, dig wars, chrome)
async function freeBase(from = 4200) {
    for (let p = from; p < from + 600; p += 10) {
        let ok = true;
        for (let i = 0; i <= 5 && ok; i++) ok = await portFree(p + i);
        if (ok) return p;
    }
    throw new Error('no free port from ' + from);
}

async function takeLock(dir) {
    if (!dir) return false;
    for (let i = 0; i < 360; i++) {
        try { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner'), 'clientBoot.test.js ' + process.pid + ' ' + new Date().toISOString() + '\n'); return true; }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
        if (i === 0) console.log('waiting for the heavy lock ' + dir);
        await sleep(5000);
    }
    throw new Error('heavy lock busy for 30 min: ' + dir);
}
function dropLock(dir) {
    if (!dir) return;
    try { fs.rmSync(path.join(dir, 'owner'), { force: true }); fs.rmdirSync(dir); } catch (e) { /* */ }
}

// one CDP page session
class Page {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pend = new Map(); this.errors = []; this.logs = [];
        ws.on('message', (m) => {
            const d = JSON.parse(m);
            if (d.id && this.pend.has(d.id)) {
                const p = this.pend.get(d.id); this.pend.delete(d.id);
                if (d.error) p.rej(new Error(JSON.stringify(d.error))); else p.res(d.result);
                return;
            }
            if (d.method === 'Runtime.exceptionThrown') {
                const x = d.params.exceptionDetails || {};
                this.errors.push('exception: ' + ((x.exception && x.exception.description) || x.text || JSON.stringify(x)).split('\n').slice(0, 4).join(' | '));
            } else if (d.method === 'Runtime.consoleAPICalled') {
                const line = (d.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
                if (d.params.type === 'error' || d.params.type === 'assert') this.errors.push('console.' + d.params.type + ': ' + line.slice(0, 400));
                else this.logs.push(d.params.type + ': ' + line.slice(0, 200));
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
    async key(key, code, kc) {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, text: key === 'Enter' ? '\r' : undefined });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
    }
}

// the three game layers composed into one small canvas: how many distinct
// colours (quantized) on a 48 x 27 grid, and the brightest sample
const CANVAS_PROBE = `(() => {
    const ids = ['gameCanvas-background', 'gameCanvas-gameplay', 'gameCanvas'];
    const W = 480, H = 270, o = document.createElement('canvas');
    o.width = W; o.height = H;
    const c = o.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    let drawn = 0;
    for (const id of ids) {
        const cv = document.getElementById(id);
        if (!cv || !cv.width || !cv.height) continue;
        const st = getComputedStyle(cv);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        try { c.drawImage(cv, 0, 0, W, H); drawn++; } catch (e) { /* */ }
    }
    const px = c.getImageData(0, 0, W, H).data;
    const seen = new Set();
    let max = 0;
    for (let gy = 0; gy < 27; gy++) for (let gx = 0; gx < 48; gx++) {
        const i = ((gy * 10 + 5) * W + (gx * 10 + 5)) * 4;
        seen.add((px[i] >> 4) + ',' + (px[i + 1] >> 4) + ',' + (px[i + 2] >> 4));
        max = Math.max(max, px[i] + px[i + 1] + px[i + 2]);
    }
    return { drawn, colours: seen.size, max };
})()`;

async function main() {
    const lock = process.env.HEAVY_LOCK || '';
    await takeLock(lock);
    const base = await freeBase(+process.env.BOOT_PORT || 4200);
    const port = base, cdpPort = base + 5;
    const origin = 'http://localhost:' + port;
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-client-boot-'));
    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ...process.env, ROYALE_DEBUG: '1', SOLO_RAIDS: '1', BOT_CHAT_AI: 'false',
        SESSION_SECRET: 'client-boot-test-secret-0123456789-abcdefgh', DATA_DIR: dataDir, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
        TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port),
        TUT_PORT: String(port + 1), DUO_PORT: String(port + 2), DW_PORT: String(port + 3) };
    delete env.NODE_ENV;
    for (const k of Object.keys(env)) if (/^(DISCORD_|WEB_PUSH_|BACKUP_)/.test(k)) delete env[k];
    const logFile = path.join(ROOT, 'server.log');
    const out = fs.openSync(logFile, 'w');
    let server = null, chrome = null, ws = null;
    const results = [];
    const check = async (name, fn) => {
        const s = Date.now();
        try { const note = await fn(); results.push(true); console.log(`ok   ${name} (${Date.now() - s} ms)${note ? ' - ' + note : ''}`); }
        catch (e) { results.push(false); console.log(`FAIL ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 12).join('\n     ')}`); }
    };
    try {
        server = spawn(process.execPath, ['--no-lazy', 'index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
        let up = false;
        for (let i = 0; i < 240 && !up; i++) {
            if (server.exitCode !== null) throw new Error('server exited (' + server.exitCode + '), log ' + logFile);
            try { up = (await fetch(origin + '/api/config')).status === 200; } catch (e) { /* booting */ }
            if (!up) await sleep(250);
        }
        if (!up) throw new Error('server never answered on ' + origin);
        const profile = path.join(ROOT, 'chrome');
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
            '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--window-size=1280,800',
            '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'ignore'] });
        let target = null;
        for (let i = 0; i < 80 && !target; i++) {
            try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t => t.type === 'page'); } catch (e) { /* starting */ }
            if (!target) await sleep(250);
        }
        if (!target) throw new Error('Chrome never opened a page on ' + cdpPort);
        ws = new WS(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        const page = new Page(ws);
        await page.send('Runtime.enable');
        await page.send('Page.enable');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        const noErrors = (when) => {
            if (page.errors.length) throw new Error(page.errors.length + ' error(s) ' + when + ':\n' + page.errors.slice(0, 10).join('\n'));
        };

        await check('home: the page loads with no errors', async () => {
            await page.send('Page.navigate', { url: origin + '/' });
            let ready = false;
            for (let i = 0; i < 120 && !ready; i++) {
                await sleep(250);
                try { ready = await page.eval(`document.readyState === 'complete' && !!document.getElementById('startButton') && typeof window.dwPlaying === 'function'`); } catch (e) { /* navigating */ }
            }
            if (!ready) throw new Error('the page never finished loading (no startButton / dwPlaying)');
            await sleep(1500);
            noErrors('on the home page');
        });

        await check('play: the raid starts, the frame loop runs, no errors', async () => {
            await page.eval(`document.getElementById('startButton').click(), true`);
            let playing = false;
            for (let i = 0; i < 120 && !playing; i++) { await sleep(250); playing = await page.eval('window.dwPlaying()'); }
            if (!playing) throw new Error('never got into the raid after Play (dwPlaying false)');
            await sleep(WAIT_MS);
            noErrors('in the raid');
            if (!(await page.eval('window.dwPlaying()'))) throw new Error('fell out of the raid');
            const p = await page.eval(CANVAS_PROBE);
            if (!p.drawn) throw new Error('no game canvas to read');
            if (p.colours < 6 || p.max < 60) throw new Error('the canvas looks blank: ' + JSON.stringify(p));
            return p.colours + ' colours on the canvas';
        });

        await check('death card: dies, the card draws, Enter drops back in', async () => {
            await page.eval(`window.royaleTalk('DBG', 'kill'), true`);
            let dead = false;
            for (let i = 0; i < 40 && !dead; i++) { await sleep(250); dead = !(await page.eval('window.dwPlaying()')); }
            if (!dead) throw new Error('DBG kill did not take (ROYALE_DEBUG)');
            // asking right away: the death wait queues it (round 6), then
            // Enter like a player would
            await sleep(400);
            const q = await page.eval(`(() => { const g = window.royaleState(); const left = (g.raidRespawnAt || 0) - performance.now();
                try { g.canvas.respawn(); } catch (e) { return { err: String(e) }; }
                return { left: Math.round(left), queued: !!g.respawnQueued, pending: !!g.respawnPending }; })()`);
            if (q.err) throw new Error('respawn() threw: ' + q.err);
            if (q.left > 300 && !q.queued && !q.pending) throw new Error('asking during the death wait did not queue: ' + JSON.stringify(q));
            await page.key('Enter', 'Enter', 13);
            const queued = JSON.stringify(q);
            let back = false;
            for (let i = 0; i < 60 && !back; i++) { await sleep(250); back = await page.eval('window.dwPlaying()'); }
            noErrors('around the death card');
            if (!back) throw new Error('Enter on the death card never dropped back in (queued: ' + queued + ')');
            await sleep(2000);
            noErrors('after the respawn');
            const p = await page.eval(CANVAS_PROBE);
            if (p.colours < 6) throw new Error('the canvas looks blank after the respawn: ' + JSON.stringify(p));
            return 'queued ' + queued;
        });

        // the public tank tree (public/tanks, built by scripts/build-tanks.js)
        await check('tanks: /tanks serves the tree, its data and script, and draws', async () => {
            const html = await fetch(origin + '/tanks');
            const body = await html.text();
            if (html.status !== 200 || !body.includes('/tanks/tanks.js')) throw new Error('/tanks: ' + html.status);
            const js = await fetch(origin + '/tanks/tanks.js'), src = await js.text();
            if (js.status !== 200 || !/javascript/.test(js.headers.get('content-type') || '')) throw new Error('/tanks/tanks.js: ' + js.status + ' ' + js.headers.get('content-type'));
            if (process.env.CLIENT_BUILD === 'obfuscated' && src.includes('// The /tanks page')) throw new Error('/tanks/tanks.js is not the obfuscated build');
            const data = await (await fetch(origin + '/tanks/tanks.json')).json();
            if (!(data.count >= 700)) throw new Error('tanks.json count ' + data.count);
            await page.send('Page.navigate', { url: origin + '/tanks' });
            let ready = false;
            for (let i = 0; i < 80 && !ready; i++) { await sleep(250); try { ready = await page.eval('!!(window.dwTanks && window.dwTanks.ready())'); } catch (e) { /* navigating */ } }
            if (!ready) throw new Error('the tree never loaded its pictures');
            await page.eval('dwTanks.pick(dwTanks.find("Twin"), true), true');
            await sleep(600);
            noErrors('on /tanks');
            return data.count + ' tanks';
        });
    } catch (e) {
        results.push(false);
        console.log('FAIL setup\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
    } finally {
        try { if (ws) ws.close(); } catch (e) { /* */ }
        for (const ch of [chrome, server]) {
            if (!ch || ch.exitCode !== null) continue;
            ch.kill(ch === server ? 'SIGINT' : 'SIGTERM');
            await new Promise(res => { if (ch.exitCode !== null) res(); else ch.once('exit', res); setTimeout(res, 6000); });
            if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGKILL');
        }
        fs.closeSync(out);
        dropLock(lock);
    }
    const failed = results.filter(r => !r).length;
    console.log(failed ? `${failed} of ${results.length} failed (server log in ${logFile})` : `all ${results.length} passed` + (process.env.CLIENT_BUILD ? ' (CLIENT_BUILD=' + process.env.CLIENT_BUILD + ')' : ''));
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    return failed;
}

main().then(f => process.exit(f ? 1 : 0), e => { console.error(e); process.exit(1); });
