// Builds /tanks (public/tanks/): node scripts/build-tanks.js [--atlas | --no-atlas]
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const PUBLIC = path.join(REPO, 'public');
const OUT = process.env.TANKS_OUT || path.join(PUBLIC, 'tanks');
const MAP_FILE = path.join(__dirname, 'tanks', 'atlas.map.json');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARGS = new Set(process.argv.slice(2));
const COLOR = '10 0 1 0 false';          // the player's blue, as on the upgrade tiles
const CELL = { s: 48, l: 104 }, COLS = 32;

const BRANCH_COLORS = {
    'Twin': '#3f8cff', 'Sniper': '#3fd27a', 'Machine Gun': '#ff5068', 'Flank Guard': '#c070ff',
    'Director': '#ffc23a', 'Pounder': '#ff8a2e', 'Trapper': '#2fd8ea', 'Smasher': '#d153cc', 'Splitter': '#9bd24a',
};

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ---- the tree, as the game defines it ------------------------------------
function loadTree() {
    for (const k of ['ROYALE_TANKS', 'ROYALE_TANKS_T5_FREE']) delete process.env[k];
    const log = console.log, info = console.info, warn = console.warn;
    console.log = console.info = console.warn = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
        Config.dig_royale = true;
        const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
        global.gameManager = {
            room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
            views: [{ check: () => true, add() {}, remove() {} }], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
            socketManager: { players: [], clients: [], broadcast() {} },
        };
        global.gameManager.gameHandler = new gameHandler(global.gameManager);
    } finally { console.log = log; console.info = info; console.warn = warn; }

    const keyOf = new Map(); for (const k in Class) keyOf.set(Class[k], k);
    const root = 'basic';
    const tier = new Map([[root, 1]]), parents = new Map([[root, []]]), kids = new Map(), order = [root];
    const q = [root];
    while (q.length) {
        const k = q.shift(), d = Class[k];
        const list = [];
        // the slot is the tier: UPGRADES_TIER_t holds Tier t + 1 tanks
        for (let t = 1; t <= 4; t++) for (let e of (d && d['UPGRADES_TIER_' + t]) || []) {
            if (Array.isArray(e)) { if (e.length !== 1) continue; e = e[0]; }
            const ck = typeof e === 'string' ? e : keyOf.get(e);
            if (!ck || !Class[ck] || list.some(x => x[0] === ck)) continue;
            list.push([ck, t + 1]);
        }
        kids.set(k, list.map(x => x[0]));
        for (const [ck, t] of list) {
            if (!tier.has(ck)) { tier.set(ck, t); parents.set(ck, []); order.push(ck); q.push(ck); }
            if (!parents.get(ck).includes(k)) parents.get(ck).push(k);
        }
    }
    return { root, order, tier, parents, kids };
}

function buildMockups(order) {
    const { buildMockup } = require(path.join(SERVER, 'miscFiles', 'mockups.js'));
    const log = console.log; console.log = () => {};
    const out = new Map();
    try {
        for (const k of order) {
            const d = Class[k];
            if (mockupMap[d.index] === undefined) buildMockup(k, global.gameManager);
            out.set(k, mockupData[mockupMap[d.index]]);
        }
    } finally { console.log = log; }
    return out;
}

// a picture's identity: the mockup's geometry, not its names or indexes
function lookOf(m) {
    const strip = (o) => {
        if (Array.isArray(o)) return o.map(strip);
        if (!o || typeof o !== 'object') return typeof o === 'number' ? Math.round(o * 1e3) / 1e3 : o;
        const r = {};
        // position is sampled (miscFiles/mockups.js)
        for (const k of Object.keys(o).sort()) if (!['index', 'name', 'className', 'statnames', 'upgradeTooltip', 'upgradeName', 'rerootUpgradeTree', 'position'].includes(k)) r[k] = strip(o[k]);
        return r;
    };
    return sha(JSON.stringify(strip(m)));
}
function rendererHash() {
    const app = fs.readFileSync(path.join(PUBLIC, 'client', 'app.js'), 'utf8');
    const a = app.indexOf('const drawEntity = (() => {'), b = app.indexOf('window.dwDrawEntity = drawEntity;');
    const part = a >= 0 && b > a ? app.slice(a, b) : app;
    return sha([part, ...['gameDraw.js', 'color.js', 'util.js'].map(f => fs.readFileSync(path.join(PUBLIC, 'client', f), 'utf8')), JSON.stringify(CELL), COLOR, 'rim1'].join('\n'));
}

// ---- layout --------------------------------------------------------------- Basic top
const L = { tile: 48, px: 62, row: 92, stack: 66, gapX: 46, gapY: 64, head: 34, maxW: 4700, left: 70 };
function layout(T) {
    const prim = new Map();                      // primary parent: the first one found
    for (const k of T.order) if (k !== T.root) prim.set(k, T.parents.get(k)[0]);
    const pk = new Map(); for (const k of T.order) pk.set(k, []);
    for (const [k, p] of prim) pk.get(p).push(k);
    // one block per line: Basic's own upgrades, grouped by their branch
    let D = null; try { D = require(path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js')); } catch (e) { /* classic */ }
    const dBranch = new Map(D ? D.tanks.map(t => [t.key, t.branch]) : []);
    const groups = [];
    for (const r of pk.get(T.root)) {
        const g = dBranch.get(r) && Class[dBranch.get(r)] && dBranch.get(r) !== r ? dBranch.get(r) : r;
        let grp = groups.find(x => x.key === g);
        if (!grp) groups.push(grp = { key: g, roots: [] });
        grp.roots.push(r);
    }
    for (const grp of groups) grp.roots.sort((a, b) => (a === grp.key ? -1 : b === grp.key ? 1 : 0));
    const pos = new Map();
    const blocks = [];
    for (const grp of groups) {
        const top = Math.min(...grp.roots.map(r => T.tier.get(r)));
        let col = 0, deepest = 0;
        const cols = new Map();
        const place = (k) => {
            const t = T.tier.get(k);
            const down = pk.get(k).filter(c => T.tier.get(c) <= 4);
            if (t >= 4 || !down.length) {
                const c = col++;
                cols.set(k, c);
                const five = pk.get(k).filter(c2 => T.tier.get(c2) === 5);
                five.forEach((f, i) => { cols.set(f, c); pos.set(f, { blk: blocks.length, c, y: (5 - top) * L.row - 12 + i * L.stack }); });
                deepest = Math.max(deepest, five.length);
                return [c, c];
            }
            let lo = Infinity, hi = -Infinity;
            for (const c of down) { const [a, z] = place(c); lo = Math.min(lo, a); hi = Math.max(hi, z); }
            cols.set(k, (lo + hi) / 2);
            return [lo, hi];
        };
        for (const r of grp.roots) place(r);
        for (const [k, c] of cols) if (!pos.has(k)) pos.set(k, { blk: blocks.length, c, y: (T.tier.get(k) - top) * L.row });
        const w = col * L.px, h = (5 - top) * L.row - 12 + Math.max(0, deepest - 1) * L.stack + L.tile;
        blocks.push({ root: grp.key, roots: grp.roots, w, h, n: [...cols.keys()].length });
    }
    // rows of blocks, first fit in line order (a wide page, like a screen)
    const rows = [];
    for (const bl of blocks) {
        let r = rows.find(r => r.w + L.gapX + bl.w <= L.maxW);
        if (!r) rows.push(r = { w: -L.gapX, h: 0, list: [] });
        r.list.push(bl); r.w += L.gapX + bl.w; r.h = Math.max(r.h, bl.h);
    }
    let y = L.tile + 70;
    for (const r of rows) {
        let x = L.left;
        for (const bl of r.list) { bl.x = x; bl.y = y + L.head; x += bl.w + L.gapX; }
        y += r.h + L.gapY + L.head;
    }
    const out = new Map();
    out.set(T.root, { x: 10, y: 0 });
    for (const [k, p] of pos) {
        const bl = blocks[p.blk];
        out.set(k, { x: Math.round(bl.x + p.c * L.px), y: Math.round(bl.y + p.y) });
    }
    let W = 0, H = 0; for (const p of out.values()) { W = Math.max(W, p.x + L.tile); H = Math.max(H, p.y + L.tile); }
    return { pos: out, prim, blocks, W: W + 40, H: H + 40 };
}

// ---- the atlas, drawn by the game's renderer in headless Chrome ----------
function portFree(port) {
    return new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(port, '127.0.0.1'); });
}
async function freePort(from) { for (let p = from; p < from + 400; p++) if (await portFree(p)) return p; throw new Error('no free port'); }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/json' };
function staticServer(port) {
    return new Promise(res => {
        const srv = http.createServer((q, s) => {
            let u = decodeURIComponent(q.url.split('?')[0]);
            if (u === '/') u = '/index.html';
            const f = path.normalize(path.join(u.startsWith('/shared/') ? REPO : PUBLIC, u));
            if (!f.startsWith(REPO)) { s.writeHead(403); return s.end(); }
            fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); s.end(b); });
        }).listen(port, '127.0.0.1', () => res(srv));
    });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function renderAtlas(list) {
    const WS = require(path.join(REPO, 'node_modules', 'ws'));
    const httpPort = await freePort(4870), cdpPort = await freePort(9870);
    const srv = await staticServer(httpPort);
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-atlas-'));
    const ch = spawn('nice', ['-n', '15', CHROME, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
        '--user-data-dir=' + prof, '--remote-debugging-port=' + cdpPort, 'about:blank'], { stdio: 'ignore' });
    try {
        let pg;
        for (let i = 0; i < 120 && !pg; i++) { try { pg = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t => t.type === 'page'); } catch (e) { /* not up yet */ } if (!pg) await sleep(250); }
        if (!pg) throw new Error('Chrome did not start');
        const ws = new WS(pg.webSocketDebuggerUrl, { maxPayload: 512 << 20 });
        await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
        let id = 0; const pend = new Map();
        ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
        const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return r.result && r.result.result && r.result.result.value; };
        await send('Page.enable'); await send('Runtime.enable');
        // the real menu page: app.js sets window.dwDrawEntity as it loads
        await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/index.html` });
        let ok = false;
        for (let i = 0; i < 240 && !ok; i++) { await sleep(250); try { ok = await ev('!!(window.dwDrawEntity && window.global)'); } catch (e) { /* navigating */ } }
        if (!ok) throw new Error('the client never set window.dwDrawEntity');
        // turrets are mockups of their own, looked up by index like in the game
        const all = {};
        const add = (m) => { if (!m || m.index == null) return; if (all[m.index] === undefined) all[m.index] = m.position && m.position.middle ? m : { ...m, position: { axis: 2, middle: { x: 0, y: 0 } } }; for (const t of m.turrets || []) add(t); };
        for (const t of list) add(t.mockup);
        const payload = JSON.stringify({ list: list.map(t => [t.cell, t.mockIndex]), mockups: all, CELL, COLS, COLOR });
        await ev(`window.__tanksIn = ${payload}; true`);
        const res = await ev(`(async () => {
            const IN = window.__tanksIn;
            const { util } = await import('/client/util.js');
            const { gameDraw } = await import('/client/gameDraw.js');
            const { color: themes } = await import('/client/color.js');
            const g = window.global, draw = window.dwDrawEntity;
            const had = gameDraw.color; gameDraw.color = themes.dark; gameDraw.colorCache = {};
            const saved = g.mockups; g.mockups = IN.mockups;
            const n = IN.list.reduce((m, t) => Math.max(m, t[0] + 1), 0), rows = Math.ceil(n / IN.COLS);
            const W = 360, sc = document.createElement('canvas'); sc.width = sc.height = W;
            const s = sc.getContext('2d', { willReadFrequently: true });
            const out = {};
            for (const key of ['s', 'l']) { const cv = document.createElement('canvas'); cv.width = IN.COLS * IN.CELL[key]; cv.height = rows * IN.CELL[key]; out[key] = cv; }
            const rot = -Math.PI / 4, r0 = 26, tmp = {}, rimC = {};
            for (const key of ['s', 'l']) { tmp[key] = document.createElement('canvas'); rimC[key] = document.createElement('canvas'); tmp[key].width = tmp[key].height = rimC[key].width = rimC[key].height = IN.CELL[key]; }
            for (const [cell, idx] of IN.list) {
                const pic = util.getEntityImageFromMockup(String(idx), IN.COLOR);
                pic.realSize = pic.size;
                s.setTransform(1, 0, 0, 1, 0, 0); s.clearRect(0, 0, W, W); s.lineCap = s.lineJoin = 'round';
                draw(IN.COLOR, W / 2, W / 2, pic, 1, 1, r0 / pic.size, 1, rot, true, s);
                const d = s.getImageData(0, 0, W, W).data;
                let x0 = W, y0 = W, x1 = 0, y1 = 0;
                for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
                if (x1 < x0) { x0 = y0 = W / 2 - r0; x1 = y1 = W / 2 + r0; }
                const half = Math.max(x1 - x0, y1 - y0) / 2 + 1, mx = (x0 + x1) / 2 - W / 2, my = (y0 + y1) / 2 - W / 2;
                for (const key of ['s', 'l']) {
                    // the tank plus a light rim, so dark barrels and spikes read on any theme
                    const C = IN.CELL[key], f = (C * 0.43) / half, c = out[key].getContext('2d');
                    const cx = (cell % IN.COLS) * C, cy = Math.floor(cell / IN.COLS) * C;
                    const tc = tmp[key].getContext('2d'), hc = rimC[key].getContext('2d');
                    tc.setTransform(1, 0, 0, 1, 0, 0); tc.clearRect(0, 0, C, C); tc.lineCap = tc.lineJoin = 'round';
                    draw(IN.COLOR, C / 2 - mx * f, C / 2 - my * f, pic, 1, 1, r0 * f / pic.size, 1, rot, true, tc);
                    hc.globalCompositeOperation = 'copy'; hc.drawImage(tmp[key], 0, 0);
                    hc.globalCompositeOperation = 'source-in'; hc.fillStyle = 'rgba(255,243,217,0.92)'; hc.fillRect(0, 0, C, C);
                    hc.globalCompositeOperation = 'source-over';
                    const rw = Math.max(1, C / 56 * 1.3);
                    for (let i = 0; i < 8; i++) c.drawImage(rimC[key], cx + Math.cos(i * Math.PI / 4) * rw, cy + Math.sin(i * Math.PI / 4) * rw);
                    c.drawImage(tmp[key], cx, cy);
                }
            }
            g.mockups = saved; gameDraw.color = had; gameDraw.colorCache = {};
            return { s: out.s.toDataURL('image/webp', 0.8), l: out.l.toDataURL('image/webp', 0.8) };
        })()`);
        ws.close();
        if (!res || !/^data:image\/webp/.test(res.s || '')) throw new Error('no WebP from Chrome');
        return { s: Buffer.from(res.s.split(',')[1], 'base64'), l: Buffer.from(res.l.split(',')[1], 'base64') };
    } finally {
        try { ch.kill(); } catch (e) { /* gone */ }
        srv.close();
        setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* */ } }, 500);
    }
}

// ---- main -----------------------------------------------------------------
async function main() {
    const t0 = Date.now();
    const T = loadTree();
    const mocks = buildMockups(T.order);
    const lay = layout(T);
    const id = new Map(T.order.map((k, i) => [k, i]));
    const lineOf = new Map(); lay.blocks.forEach(b => b.roots.forEach(r => lineOf.set(r, b.root)));
    const branchOf = (k) => { let c = k; while (c && lay.prim.get(c) !== T.root && lay.prim.get(c)) c = lay.prim.get(c); return lineOf.get(c) || null; };
    const branchKeys = lay.blocks.map(b => b.root);
    const branches = branchKeys.map(k => { const name = String(Class[k].LABEL); return { name, color: BRANCH_COLORS[name] || '#a597b0' }; });

    // pictures: reuse the atlas where every look is already in it
    fs.mkdirSync(OUT, { recursive: true });
    const rh = rendererHash();
    let map = null; try { map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch (e) { /* first build */ }
    const looks = T.order.map(k => lookOf(mocks.get(k)));
    const haveFiles = fs.existsSync(path.join(OUT, 'atlas-s.webp')) && fs.existsSync(path.join(OUT, 'atlas-l.webp'));
    const current = map && map.renderer === rh && haveFiles && looks.every(h => map.cells[h] != null);
    let note = 'atlas current';
    if (!current || ARGS.has('--atlas')) {
        const canChrome = !ARGS.has('--no-atlas') && fs.existsSync(CHROME);
        if (canChrome) {
            const cells = {}; const list = [];
            looks.forEach((h, i) => { if (cells[h] == null) { cells[h] = Object.keys(cells).length; const m = mocks.get(T.order[i]); list.push({ cell: cells[h], mockIndex: m.index, mockup: m }); } });
            const img = await renderAtlas(list);
            fs.writeFileSync(path.join(OUT, 'atlas-s.webp'), img.s);
            fs.writeFileSync(path.join(OUT, 'atlas-l.webp'), img.l);
            map = { renderer: rh, cell: CELL, cols: COLS, count: list.length, cells, builtAt: new Date().toISOString() };
            fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
            fs.writeFileSync(MAP_FILE, JSON.stringify(map));
            note = 'atlas redrawn (' + list.length + ' pictures)';
        } else {
            const miss = map ? looks.filter(h => map.cells[h] == null).length : looks.length;
            note = 'atlas NOT redrawn (' + (ARGS.has('--no-atlas') ? '--no-atlas' : 'no Chrome') + '): ' + (map && map.renderer !== rh ? 'renderer changed, ' : '') + miss + ' picture(s) missing, drawn as circles';
            console.warn('[tanks] ' + note + '. Run `node scripts/build-tanks.js --atlas` on a machine with Chrome.');
        }
    }
    const cellOf = (i) => (map && haveFilesNow() && map.cells[looks[i]] != null ? map.cells[looks[i]] : -1);
    function haveFilesNow() { return fs.existsSync(path.join(OUT, 'atlas-s.webp')); }

    const tanks = T.order.map((k, i) => {
        const p = lay.pos.get(k), b = branchOf(k);
        return [String(Class[k].LABEL), T.tier.get(k), b ? branchKeys.indexOf(b) : -1,
            T.parents.get(k).map(x => id.get(x)), T.kids.get(k).map(x => id.get(x)), cellOf(i), p.x, p.y,
            k === T.root ? -1 : id.get(lay.prim.get(k))];
    });
    const atlasV = map ? sha(map.builtAt + map.renderer).slice(0, 8) : '0';
    const data = {
        v: 1, count: tanks.length, w: lay.W, h: lay.H, tile: L.tile,
        branches,
        blocks: lay.blocks.map(b => ({ b: branchKeys.indexOf(b.root), x: b.x, y: b.y - L.head, w: b.w, h: b.h + L.head, n: b.n })),
        atlas: { cols: map ? map.cols : COLS, s: { src: '/tanks/atlas-s.webp?v=' + atlasV, cell: CELL.s }, l: { src: '/tanks/atlas-l.webp?v=' + atlasV, cell: CELL.l } },
        // [name, tier, branch, parents, upgrades, picture cell, x, y, primary parent]
        tanks,
    };
    fs.writeFileSync(path.join(OUT, 'tanks.json'), JSON.stringify(data));
    const size = ['tanks.json', 'atlas-s.webp', 'atlas-l.webp', 'index.html', 'tanks.js', 'tanks.css'].reduce((n, f) => { try { return n + fs.statSync(path.join(OUT, f)).size; } catch (e) { return n; } }, 0);
    console.log(`[tanks] ${tanks.length} tanks, ${branches.length} lines, layout ${lay.W}x${lay.H}, ${note}, ${(size / 1048576).toFixed(2)} MB in ${path.relative(REPO, OUT) || OUT}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().then(() => process.exit(0), (e) => { console.error('[tanks] build failed: ' + (e && e.stack || e)); process.exit(1); });
