'use strict';

const emit = process.emitWarning;
process.emitWarning = (w, ...a) => { if (!/MODULE_TYPELESS|module syntax/.test(String(w) + a.join(' '))) emit.call(process, w, ...a); };

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const REPO = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

let passed = 0;
const ok = (name) => { passed++; console.log('ok   ' + name); };

(async () => {
    const K = await import(pathToFileURL(path.join(REPO, 'public/client/gunKick.js')).href);
    {
        assert.equal(K.kickAt(0, 0), 0);
        assert.equal(K.kickAt(K.KICK_IN_MS, 0), 1);
        assert.equal(K.kickAt(K.KICK_MS, 0), 0);
        assert.equal(K.kickAt(-5, 0), 0);
        assert.equal(K.kickAt(NaN, 0), 0);
        let last = 1;
        for (let ms = K.KICK_IN_MS; ms <= K.KICK_MS; ms += 4) {
            const v = K.kickAt(ms, 0);
            assert.ok(v <= last + 1e-9, 'springs back without bouncing at ' + ms);
            last = v;
        }
        const early = K.kickAt(K.KICK_IN_MS + K.KICK_OUT_MS * 0.25, 0), late = K.kickAt(K.KICK_IN_MS + K.KICK_OUT_MS * 0.75, 0);
        assert.ok(1 - early > late, 'eases out: most of the way back in the first half');
        assert.ok(Math.abs(K.kickAt(0, 0.6) - 0.6) < 1e-9, 'a shot mid-kick starts from where the barrel is');
        assert.ok(K.KICK_SHARE >= 0.1 && K.KICK_SHARE <= 0.2, 'kicks back 10-20% of the barrel');
        assert.ok(K.KICK_MS >= 100 && K.KICK_MS <= 170, 'back in place within ~150 ms');
        ok('gun kick curve');
    }
    {
        const si = read('public/client/socketinit.js');
        const physics = si.slice(si.indexOf('function physics('), si.indexOf('const GunContainer'));
        assert.ok(!/new |\[|\{\s*\w+:/.test(physics.replace(/\{ g\.position = 0; return; \}/, '')), 'no allocation in the per-frame kick');
        assert.ok(/z\.guns\.fire\(i, time\)/.test(si), 'kicks are keyed by the shot time');
        ok('gun kick wiring');
    }
    {
        const gd = read('public/client/gameDraw.js');
        const pal = JSON.parse(/tankPalette: Object\.freeze\((\[[^\]]+\])\)/.exec(gd)[1].replace(/'/g, '"'));
        const base = +/TANK_PALETTE_BASE: (\d+)/.exec(gd)[1];
        const server = /ROYALE_PALETTE = \[([^\]]+)\]/.exec(read('server/loaders/global.js'))[1].split(',').map(Number);
        assert.deepEqual(server, pal.map((_, i) => base + i), 'the server hands out exactly the client palette');
        assert.deepEqual(pal.slice(0, 4), ['#00b2e1', '#f14e54', '#00e16e', '#bf7ff5'], 'diep team colours first');
        assert.equal(new Set(pal).size, pal.length, 'every colour unique');
        for (const hex of pal) {
            const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
            assert.ok(l >= 0.44, hex + ' is too dark');
            assert.ok(mx >= 0.88, hex + ' is muddy');
        }
        const tut = read('server/game/tutorialSession.js');
        const red = JSON.parse(/RED_LIKE = new Set\((\[[^\]]+\])\)/.exec(tut)[1]);
        for (const n of red) { const hex = pal[n - base]; assert.ok(parseInt(hex.slice(1, 3), 16) > 0xe0 && parseInt(hex.slice(3, 5), 16) < 0x90, n + ' is red-like'); }
        const pv = read('public/client/account/previews.js');
        for (const m of pv.matchAll(/\['\w+', (\d+)\]/g)) assert.ok(+m[1] >= base && +m[1] < base + pal.length, 'preview swatch ' + m[1] + ' is a palette colour');
        ok('tank palette');
    }
    {
        const app = read('public/client/app.js');
        const de = app.slice(app.indexOf('const drawEntity = (() => {'), app.indexOf('window.dwDrawEntity = drawEntity;'));
        assert.ok(!/gameDraw\.setColor\(/.test(de), 'tanks use the diep edge rule');
        assert.equal((de.match(/gameDraw\.setEntityColor\(context, /g) || []).length, 2, 'guns and hulls share the edge rule');
        assert.ok(/gameDraw\.TANK_GUN/.test(de), 'grey barrels are the diep grey');
        ok('drawEntity style');
    }
    {
        globalThis.window = globalThis;
        globalThis.location = { hash: '', search: '', href: 'http://x/', protocol: 'http:', host: 'x', hostname: 'x' };
        globalThis.DWCosmetics = require(path.join(REPO, 'shared', 'cosmetics.js'));
        const C = await import(pathToFileURL(path.join(REPO, 'public/client/account/cosmetics.js')).href);
        const fills = [];
        const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { if (k === 'fillStyle') fills.push(v); o[k] = v; return true; } });
        let styled = 0;
        for (const it of DWCosmetics.ITEMS.filter(i => i.cat === 'skin')) {
            const st = C.barrelStyleOf(it.nid);
            if (!st) continue;
            styled++;
            assert.equal(C.barrelStyleOf(it.nid), st, 'barrel style cached');
            fills.length = 0;
            C.paintBarrel(ctx, 0, 0, 20, 8, 1.2, 0.3, 2, it.nid, 6);
            assert.ok(fills.includes(DWCosmetics.SKIN_SWATCHES[it.skin.colors[0]][0]), it.id + ' barrel uses its main colour');
        }
        assert.ok(styled >= 6 && styled <= 16, styled + ' skins dress their barrels');
        assert.equal(C.barrelStyleOf(0), null);
        ok('skin barrels');
    }
    {
        const cfg = read('public/client/config.js');
        const chunk = +/borderChunk: ([\d.]+)/.exec(cfg)[1];
        assert.ok(chunk >= 7 && chunk <= 8, 'a bold diep border at level 45: ' + chunk);
        const app = read('public/client/app.js');
        assert.ok(/const back = 0, front = length \* 2 - position;/.test(app), 'the kick shortens barrels from the muzzle, the base stays under the body');
        assert.ok(/rootStroke = lineWidthMult \* Math\.max\(minBorder, ratio \* gameDraw\.entityBorder\(/.test(app), 'turrets share their tank\'s border width');
        const gd = read('public/client/gameDraw.js');
        const f = new Function('config', 'return ' + /entityBorder: (\(size\) => [^\n]+),\n/.exec(gd)[1])({ graphical: { borderChunk: chunk } });
        assert.ok(Math.abs(f(24) - chunk) < 1e-9, 'level 45 gets the full border');
        assert.ok(f(12.27) < f(24) && f(12.27) > chunk * 0.5, 'smaller tanks get a thinner border');
        assert.ok(f(1000) <= chunk * 1.5 && f(0) >= chunk * 0.5, 'clamped');
        ok('borders');
    }
    {
        const prev = { pal: global.ROYALE_PALETTE, tc: global.royaleTeamColors, assign: global.assignTeamColor };
        global.ROYALE_PALETTE = [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61];
        global.royaleTeamColors = new Map();
        global.assignTeamColor = (team, socket) => solo.assign(team, socket);
        const solo = require(path.join(REPO, 'server/game/terrain/soloColor.js'));
        try {
            const firsts = new Set();
            for (let r = 1; r <= 12; r++) {
                global.royaleTeamColors = new Map();
                firsts.add(solo.colorFor({ guestId: 'owner' }, -9000 - r, 500 + r, null));
            }
            assert.ok(firsts.size >= 4, 'the same person lands on different colours raid to raid: ' + [...firsts]);
            global.royaleTeamColors = new Map();
            const a = solo.colorFor({ guestId: 'gA' }, -9101, 900, null);
            assert.equal(solo.colorFor({ guestId: 'gA' }, -9102, 900, null), a, 'one colour per person per raid');
            const firstPicks = new Set();
            for (let i = 0; i < 30; i++) { global.royaleTeamColors = new Map(); firstPicks.add(solo.assign(-9200 - i, { guestId: 'p' + i })); }
            assert.ok(firstPicks.size >= 6, 'first spawners do not all get one colour');
            assert.equal(solo.colorFor({ guestId: 'gB' }, -9300, 901, { team: -9300, color: 55 }), 55, 'a resume keeps its colour');
        } finally { global.ROYALE_PALETTE = prev.pal; global.royaleTeamColors = prev.tc; global.assignTeamColor = prev.assign; }
        ok('varied colours');
    }
    console.log(passed + '/7 passed');
})().catch(e => { console.error(e); process.exit(1); });
