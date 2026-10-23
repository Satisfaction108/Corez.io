'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const IDLE_MS = Math.max(2000, +process.env.VOID_IDLE_MS || 12000);
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
async function freeBase(from) {
    for (let p = from; p < from + 600; p += 10) {
        let ok = true;
        for (let i = 0; i <= 5 && ok; i++) ok = await portFree(p + i);
        if (ok) return p;
    }
    throw new Error('no free port from ' + from);
}

class Page {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pend = new Map(); this.errors = []; this.warns = [];
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
                else if (d.params.type === 'warning') this.warns.push(line.slice(0, 200));
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

const CANVAS_PROBE = `(() => {
    const ids = ['gameCanvas-background', 'gameCanvas-gameplay', 'gameCanvas'];
    const W = 480, H = 270, o = document.createElement('canvas');
    o.width = W; o.height = H;
    const c = o.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    for (const id of ids) {
        const cv = document.getElementById(id);
        if (!cv || !cv.width || !cv.height) continue;
        try { c.drawImage(cv, 0, 0, W, H); } catch (e) { }
    }
    const px = c.getImageData(0, 0, W, H).data;
    const seen = new Set();
    for (let gy = 0; gy < 27; gy++) for (let gx = 0; gx < 48; gx++) {
        const i = ((gy * 10 + 5) * W + (gx * 10 + 5)) * 4;
        seen.add((px[i] >> 4) + ',' + (px[i + 1] >> 4) + ',' + (px[i + 2] >> 4));
    }
    return seen.size;
})()`;

const WORLD = `(() => {
    const t = window.terrainRenderer, g = window.royaleState(), v = t._view || {};
    return { playing: window.dwPlaying(), ready: !!t.ready, inits: t.inits | 0, scenes: t.scenes | 0,
        view: [v.tlx, v.tly].map(n => Math.round(n * 100) / 100), viewOk: isFinite(v.tlx) && isFinite(v.tly),
        rv: g.player.renderv, rx: g.player.renderx, ry: g.player.rendery, void: window.dwVoid() };
})()`;

async function main() {
    const base = await freeBase(+process.env.VOID_PORT || 4300);
    const port = base, cdpPort = base + 5;
    const origin = 'http://localhost:' + port;
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-void-rejoin-'));
    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ...process.env, ROYALE_DEBUG: '1', SOLO_RAIDS: '1', BOT_CHAT_AI: 'false',
        SESSION_SECRET: 'void-rejoin-test-secret-0123456789-abcdefgh', DATA_DIR: dataDir, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
        TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port),
        TUT_PORT: String(port + 1), DUO_PORT: String(port + 2), DW_PORT: String(port + 3) };
    delete env.NODE_ENV;
    for (const k of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_APP_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_ADMIN_GUILD_ID', 'ADMIN_DISCORD_IDS', 'DISCORD_ANNOUNCE_CHANNEL_ID', 'DISCORD_BACKUP_CHANNEL_ID', 'BACKUP_ENCRYPTION_KEY', 'WEB_PUSH_PUBLIC_KEY', 'WEB_PUSH_PRIVATE_KEY', 'WEB_PUSH_SUBJECT']) env[k] = '';
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
        server = spawn(process.execPath, ['index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
        let up = false;
        for (let i = 0; i < 240 && !up; i++) {
            if (server.exitCode !== null) throw new Error('server exited (' + server.exitCode + '), log ' + logFile);
            try { up = (await fetch(origin + '/api/config')).status === 200; } catch (e) { }
            if (!up) await sleep(250);
        }
        if (!up) throw new Error('server never answered on ' + origin);
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + path.join(ROOT, 'chrome'),
            '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--window-size=1280,800',
            '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'],
        { stdio: ['ignore', 'ignore', 'ignore'] });
        let target = null;
        for (let i = 0; i < 80 && !target; i++) {
            try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t => t.type === 'page'); } catch (e) { }
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
        const world = () => page.eval(WORLD);
        const waitFor = async (expr, ms) => {
            for (let t = 0; t < ms; t += 250) { if (await page.eval(expr)) return true; await sleep(250); }
            return false;
        };
        const play = async () => {
            await page.eval(`document.getElementById('startButton').click(), true`);
            if (!(await waitFor('window.dwPlaying()', 30000))) throw new Error('never got into the raid after Play');
        };
        const drawsRock = async (when) => {
            const a = await world();
            await sleep(1200);
            const b = await world();
            const colours = await page.eval(CANVAS_PROBE);
            if (!b.ready) throw new Error('no terrain ' + when + ': ' + JSON.stringify(b));
            if (!(b.scenes > a.scenes + 10)) throw new Error('the rock pass stopped drawing ' + when + ': ' + JSON.stringify([a, b]));
            if (!b.viewOk || !isFinite(b.rx) || !isFinite(b.ry) || !(b.rv > 0)) throw new Error('the camera is broken ' + when + ': ' + JSON.stringify(b));
            if (colours < 30) throw new Error('the canvas looks like the void ' + when + ': ' + colours + ' colours, ' + JSON.stringify(b));
            return { w: b, colours };
        };

        await check('home: the page loads', async () => {
            await page.send('Page.navigate', { url: origin + '/' });
            if (!(await waitFor(`document.readyState === 'complete' && !!document.getElementById('startButton') && typeof window.dwPlaying === 'function'`, 30000).catch(() => false)))
                throw new Error('the page never finished loading');
            await sleep(1000);
            noErrors('on the home page');
        });

        await check('first raid: rock draws', async () => {
            await play();
            await sleep(2500);
            const r = await drawsRock('in the first raid');
            noErrors('in the first raid');
            return r.colours + ' colours';
        });

        await check('menu: Home, then the menu stays open with its world running', async () => {
            await page.eval(`window.royaleState().exit(), true`);
            await sleep(300);
            if (await page.eval('window.dwPlaying()')) throw new Error('still in the raid after exit');
            await sleep(IDLE_MS);
            const home = await page.eval(`!!(window.dwHomeWorld && window.dwHomeWorld.ready())`);
            noErrors('on the menu');
            return 'home world ' + (home ? 'running' : 'off');
        });

        await check('second raid: Play again in the same tab is not the void', async () => {
            await play();
            await sleep(2500);
            const r = await drawsRock('after rejoining');
            if (r.w.void.heals || r.w.void.asks) throw new Error('needed the safety net, the root cause is back: ' + JSON.stringify(r.w.void));
            noErrors('after rejoining');
            return r.colours + ' colours';
        });

        await check('a frame on the wrong clock does not break the camera', async () => {
            await page.eval(`window.dwRenderFrame(Date.now()), true`);
            await sleep(400);
            const r = await drawsRock('after an epoch tick');
            return r.colours + ' colours';
        });

        await check('self-heal: lost terrain is asked for again within a few seconds', async () => {
            const a = await world();
            await page.eval(`window.terrainRenderer.ready = false, true`);
            if (!(await waitFor(`window.terrainRenderer.ready && window.terrainRenderer.inits > ${a.inits}`, 6000))) throw new Error('no TG came back: ' + JSON.stringify(await world()));
            const r = await drawsRock('after the resync');
            if (!(r.w.void.asks > a.void.asks)) throw new Error('the void watch did not ask: ' + JSON.stringify(r.w.void));
            return 'asks ' + r.w.void.asks;
        });

        await check('self-heal: a broken camera comes back', async () => {
            await page.eval(`(() => { const p = window.royaleState().player; p.renderv = NaN; return true; })()`);
            await sleep(600);
            const r = await drawsRock('after a NaN zoom');
            return 'heals ' + r.w.void.heals;
        });

        await check('respawn: the watch re-arms after a death', async () => {
            let dead = false;
            for (let i = 0; i < 4 && !dead; i++) {
                await page.eval(`window.royaleTalk('DBG', 'kill'), true`);
                dead = await waitFor('!window.dwPlaying()', 2500);
            }
            if (!dead) throw new Error('DBG kill did not take: ' + JSON.stringify(await world()));
            await sleep(400);
            await page.eval(`(() => { try { window.royaleState().canvas.respawn(); } catch (e) { } return true; })()`);
            if (!(await waitFor('window.dwPlaying()', 20000))) {
                await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
                await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                if (!(await waitFor('window.dwPlaying()', 20000))) throw new Error('never respawned');
            }
            await sleep(1500);
            const a = await world();
            await page.eval(`window.terrainRenderer.ready = false, true`);
            if (!(await waitFor(`window.terrainRenderer.ready && window.terrainRenderer.inits > ${a.inits}`, 6000))) throw new Error('no TG after the respawn: ' + JSON.stringify(await world()));
            await drawsRock('after the respawn');
            noErrors('around the respawn');
        });
    } catch (e) {
        results.push(false);
        console.log('FAIL setup\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
    } finally {
        try { if (ws) ws.close(); } catch (e) { }
        for (const ch of [chrome, server]) {
            if (!ch || ch.exitCode !== null) continue;
            ch.kill(ch === server ? 'SIGINT' : 'SIGTERM');
            await new Promise(res => { if (ch.exitCode !== null) res(); else ch.once('exit', res); setTimeout(res, 6000); });
            if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGKILL');
        }
        fs.closeSync(out);
    }
    const failed = results.filter(r => !r).length;
    console.log(failed ? `${failed} of ${results.length} failed (server log in ${logFile})` : `all ${results.length} passed`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    return failed;
}

main().then(f => process.exit(f ? 1 : 0), e => { console.error(e); process.exit(1); });
