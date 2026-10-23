'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function available() {
    if (!fs.existsSync(CHROME)) return 'no Chrome (' + CHROME + ')';
    try { require(path.join(REPO, 'node_modules', 'ws')); } catch (e) { return 'no ws module'; }
    return '';
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
        if (p <= 3105 && p + 5 >= 3000) continue;
        let ok = true;
        for (let i = 0; i <= 5 && ok; i++) ok = await portFree(p + i);
        if (ok) return p;
    }
    throw new Error('no free port from ' + from);
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
                this.errors.push('exception: ' + ((x.exception && x.exception.description) || x.text || '').split('\n').slice(0, 4).join(' | '));
            } else if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'assert')) {
                this.errors.push('console.' + d.params.type + ': ' + (d.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 300));
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
    async keyDown(key, code, kc, extra = {}) {
        await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, text: key === 'Enter' ? '\r' : (key.length === 1 ? key : undefined) }, extra));
    }
    async keyUp(key, code, kc, extra = {}) {
        await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp', key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc }, extra));
    }
    async key(key, code, kc) { await this.keyDown(key, code, kc); await this.keyUp(key, code, kc); }
    async move(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
    async down(x, y, button = 'left') { await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 }); }
    async up(x, y, button = 'left') { await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 }); }
    async click(x, y) { await this.move(x, y); await this.down(x, y); await sleep(40); await this.up(x, y); }
    async shot(file) {
        const r = await this.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        return file;
    }
}

const PREP = `try {
  localStorage.setItem('digRoyaleTutorialDone_v1','1'); localStorage.setItem('digwarsTutorialDone_v3','1');
  localStorage.setItem('dwCoach_v1', JSON.stringify({status:'veteran',done:{}}));
  localStorage.setItem('dwChipHints_v1', JSON.stringify({all:1}));
} catch (e) {}`;

async function start(opts = {}) {
    const lock = process.env.HEAVY_LOCK || '';
    if (lock) {
        let got = false;
        for (let i = 0; i < 360 && !got; i++) {
            try { fs.mkdirSync(lock); got = true; } catch (e) { if (e.code !== 'EEXIST') throw e; await sleep(5000); }
        }
        if (!got) throw new Error('heavy lock busy: ' + lock);
    }
    const base = await freeBase(+process.env.TEST_PORT || opts.port || 4400);
    const port = base, cdpPort = base + 5, origin = 'http://localhost:' + port;
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-headless-'));
    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const env = Object.assign({}, process.env, { ROYALE_ALWAYS_ON: '0', ROYALE_DEBUG: '1', SOLO_RAIDS: '1', BOT_CHAT_AI: 'false',
        SESSION_SECRET: 'headless-test-secret-0123456789-abcdefgh', DATA_DIR: dataDir, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
        TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port),
        TUT_PORT: String(port + 1), DUO_PORT: String(port + 2), DW_PORT: String(port + 3) }, opts.env || {});
    delete env.NODE_ENV;
    for (const k of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_APP_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_ADMIN_GUILD_ID', 'ADMIN_DISCORD_IDS', 'DISCORD_ANNOUNCE_CHANNEL_ID', 'DISCORD_BACKUP_CHANNEL_ID', 'BACKUP_ENCRYPTION_KEY', 'WEB_PUSH_PUBLIC_KEY', 'WEB_PUSH_PRIVATE_KEY', 'WEB_PUSH_SUBJECT']) env[k] = '';
    const logFile = path.join(ROOT, 'server.log');
    const out = fs.openSync(logFile, 'w');
    const WS = require(path.join(REPO, 'node_modules', 'ws'));
    let server = null, chrome = null, ws = null;
    const stop = async () => {
        try { if (ws) ws.close(); } catch (e) { }
        for (const ch of [chrome, server]) {
            if (!ch || ch.exitCode !== null) continue;
            ch.kill(ch === server ? 'SIGINT' : 'SIGTERM');
            await new Promise(res => { if (ch.exitCode !== null) res(); else ch.once('exit', res); setTimeout(res, 6000); });
            if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGKILL');
        }
        try { fs.closeSync(out); } catch (e) { }
        if (lock) { try { fs.rmdirSync(lock); } catch (e) { } }
    };
    try {
        server = spawn(process.execPath, ['--no-lazy', 'index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
        let up = false;
        for (let i = 0; i < 240 && !up; i++) {
            if (server.exitCode !== null) throw new Error('server exited (' + server.exitCode + '), log ' + logFile);
            try { up = (await fetch(origin + '/api/config')).status === 200; } catch (e) { }
            if (!up) await sleep(250);
        }
        if (!up) throw new Error('server never answered on ' + origin);
        const W = opts.width || 1280, H = opts.height || 800;
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + path.join(ROOT, 'chrome'),
            '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--window-size=' + W + ',' + H,
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
        await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: !!opts.mobile });
        if (opts.mobile) {
            await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
            await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        }
        await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: opts.prep === undefined ? PREP : opts.prep });
        return { page, origin, logFile, root: ROOT, stop };
    } catch (e) {
        await stop();
        throw e;
    }
}

async function play(page, origin) {
    await page.send('Page.navigate', { url: origin + '/?t=' + Date.now() });
    let ready = false;
    for (let i = 0; i < 160 && !ready; i++) {
        await sleep(250);
        try { ready = await page.eval(`document.readyState === 'complete' && !!document.getElementById('startButton') && typeof window.dwPlaying === 'function'`); } catch (e) { }
    }
    if (!ready) throw new Error('the page never finished loading');
    await sleep(1200);
    await page.eval(`(() => { const g = document.getElementById('wlGuest'); if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()`).catch(() => {});
    await sleep(300);
    await page.eval(`document.getElementById('startButton').click(), true`);
    let playing = false;
    for (let i = 0; i < 160 && !playing; i++) { await sleep(250); playing = await page.eval('window.dwPlaying()').catch(() => false); }
    if (!playing) throw new Error('never got into the raid');
}

async function dbgMe(page) {
    const before = await page.eval('(window.dwDbgLog || []).length');
    await page.eval(`window.royaleTalk('DBG', 'me'), true`);
    for (let i = 0; i < 40; i++) {
        await sleep(100);
        const r = await page.eval(`(() => { const l = window.dwDbgLog || []; for (let i = l.length - 1; i >= 0; i--) { if (/"invuln"|"nobody"/.test(l[i].text)) return l[i].text; } return null; })()`);
        const n = await page.eval('(window.dwDbgLog || []).length');
        if (r && n > before) return JSON.parse(r);
    }
    return null;
}

async function runChecks(list) {
    const results = [];
    for (const [name, fn] of list) {
        const s = Date.now();
        try { const note = await fn(); results.push(true); console.log(`ok   ${name} (${Date.now() - s} ms)${note ? ' - ' + note : ''}`); }
        catch (e) { results.push(false); console.log(`FAIL ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 12).join('\n     ')}`); }
    }
    return results;
}

module.exports = { available, start, play, dbgMe, runChecks, sleep, REPO };
