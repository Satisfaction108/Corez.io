import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUTDIR = path.join(ROOT, 'out');
fs.mkdirSync(OUTDIR, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT = 8765, CDP_PORT = 9333;
const mode = process.argv[2] || 'video';
const extra = process.argv.slice(3);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
}).listen(HTTP_PORT, '127.0.0.1');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cine-chrome-'));
const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1920,1080', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function cleanup() {
    try { chrome.kill('SIGKILL'); } catch {}
    try { server.close(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function wsUrl() {
    for (let i = 0; i < 150; i++) {
        try {
            const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
            const pg = j.find(x => x.type === 'page');
            if (pg) return pg.webSocketDebuggerUrl;
        } catch {}
        await sleep(200);
    }
    throw new Error('chrome did not start');
}

const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') console.error('PAGE EXCEPTION', JSON.stringify(m.params.exceptionDetails).slice(0, 1500));
    if (m.method === 'Runtime.consoleAPICalled') console.log('PAGE', m.params.type, m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 800));
});
const send = (method, params = {}) => new Promise(res => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1500));
    return r.result.result.value;
}

try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/${process.env.PAGE || 'index.html'}` });
    let ready = false;
    for (let i = 0; i < 300 && !ready; i++) { await sleep(100); try { ready = await evaluate('window.__ready === true'); } catch {} }
    if (!ready) throw new Error('page never became ready');
    console.log('renderer', await evaluate(`(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`));
    const cuesJson = await evaluate('JSON.stringify(window.CUES || null)');
    if (cuesJson !== 'null') fs.writeFileSync(path.join(OUTDIR, 'cues.json'), cuesJson);
    if (mode === 'stills') {
        const dir = path.join(OUTDIR, 'stills');
        fs.mkdirSync(dir, { recursive: true });
        for (const t of extra[0].split(',').map(Number)) {
            const b64 = await evaluate(`renderTime(${t}, 'png')`);
            fs.writeFileSync(path.join(dir, `t${t.toFixed(2)}.png`), Buffer.from(b64, 'base64'));
            console.log('still', t);
        }
    } else {
        const fps = await evaluate('window.FPS');
        const dur = await evaluate('window.DURATION');
        const from = extra[0] ? Math.round(Number(extra[0]) * fps) : 0;
        const to = extra[1] ? Math.round(Number(extra[1]) * fps) : Math.round(dur * fps);
        const file = path.join(OUTDIR, extra[2] || 'video.mp4');
        const ff = spawn('/opt/homebrew/bin/ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
        const t0 = Date.now();
        for (let f = from; f < to; f++) {
            const b64 = await evaluate(`renderFrame(${f}, 'jpeg')`);
            if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
            if (f % 60 === 0) console.log(`frame ${f}/${to} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
        ff.stdin.end();
        await new Promise(r => ff.on('close', r));
        console.log('wrote', file, ((Date.now() - t0) / 1000).toFixed(1) + 's');
    }
} catch (e) {
    console.error(e);
    process.exitCode = 1;
} finally {
    ws.close();
    cleanup();
    process.exit();
}
