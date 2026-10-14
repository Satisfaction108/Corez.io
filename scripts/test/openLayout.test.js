'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
delete process.env.ROYALE_DEBUG;
const ROOT = fs.mkdtempSync(path.join(process.env.DATA_DIR || os.tmpdir(), 'dw-open-layout-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const log = console.log;
console.log = () => {};
try {
    require(path.join(SERVER, 'loaders', 'loader.js'));
    new definitionCombiner({
        groups: path.join(SERVER, 'lib', 'definitions', 'groups'),
        addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons'),
    }).loadDefinitions();
} finally { console.log = log; }
Config.dig_royale = true;
Config.tutorial = false;

const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
const royaleLayout = require(path.join(SERVER, 'game', 'terrain', 'royaleLayout.js'));
const openLayout = require(path.join(SERVER, 'game', 'terrain', 'openLayout.js'));
const dropIn = require(path.join(SERVER, 'game', 'terrain', 'dropIn.js'));
const spawnReach = require(path.join(SERVER, 'game', 'terrain', 'spawnReach.js'));
const mapScale = require(path.join(SERVER, 'game', 'terrain', 'mapScale.js'));
const { ORE } = require(path.join(SERVER, 'game', 'terrain', 'terrainGrid.js'));
const { socketManager } = require(path.join(SERVER, 'game', 'network', 'sockets.js'));
const Biomes = require(path.join(REPO, 'shared', 'rockBiomes.js'));

const LIVE = require(path.join(SERVER, 'game', 'gamemodes', 'config', 'dig_royale.js')).dig_royale_terrain;
const TILES = LIVE.room_width, TILE_W = 420, W = TILES * TILE_W;
const LEGACY = Object.assign({}, LIVE);
delete LEGACY.open_layout;
global.gameManager = {
    room: { width: W, height: W, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
};

function build({ terrain = LIVE, seed = LIVE.seed, tutorial = false, raidStart = true } = {}) {
    Config.dig_royale_terrain = terrain;
    Config.tutorial = tutorial;
    const quiet = console.log;
    console.log = () => {};
    try {
        const g = mapGen.generate({ cols: TILES, rows: TILES, tileWidth: TILE_W, seed, fullLattice: true });
        global.gameManager.terrainGrid = g;
        g.buildContour();
        if (raidStart) royaleLayout.carveMatchPois(g);
        return g;
    } finally {
        console.log = quiet;
        Config.tutorial = false;
        Config.dig_royale_terrain = LIVE;
    }
}

const KEY = (i, j) => i * 100003 + j;
const legacy = build({ terrain: LEGACY });
const grid = build();
global.gameManager.terrainGrid = grid;
const R = grid.circleRadius;
const diskCells = (g) => [...g.rocks.values()].filter(r => r.worldPoly && Math.hypot(r.worldCx, r.worldCy) <= g.circleRadius);
const openShare = (g) => { const d = diskCells(g); return d.filter(r => !r.alive).length / d.length; };
const pitKeys = (g) => new Set((g.spawnPits || []).map(p => { const c = spawnReach.cellAt(g, p.x, p.y); return c ? c.k : -1; }));
const layoutKeys = (g) => {
    const pits = pitKeys(g);
    const out = [];
    const inner = g.circleRadius - 100;
    for (const r of g.rocks.values()) if (r.worldPoly && !r.alive && !pits.has(r.k) && Math.hypot(r.worldCx, r.worldCy) <= inner) out.push(r.k);
    return out.sort((a, b) => a - b).join(',');
};
const sites = (g) => [...(g.vaultSites || []), ...(g.shopSites || []), ...(g.outpostSites || [])];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('open floor: about a quarter of the disk is open, the legacy map stays solid', () => {
    const live = openShare(grid), old = openShare(legacy);
    assert.ok(live >= 0.22 && live <= 0.33, 'open share ' + live.toFixed(3));
    assert.ok(old < 0.1, 'legacy open share ' + old.toFixed(3));
    assert.ok(grid.openLayout && grid.openLayout.links >= sites(grid).length - 1, 'corridors join every pad');
    assert.equal(legacy.openLayout, undefined);
});

test('one network: every pad joins the centre through corridors 3+ cells wide', () => {
    const open = (r) => !!r && !!r.worldPoly && !r.alive;
    const wide = (r) => {
        if (!open(r)) return false;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (!open(grid.rocks.get(KEY(r.vi + di, r.vj + dj)))) return false;
        return true;
    };
    let start = null, bd = Infinity;
    for (const r of grid.rocks.values()) {
        if (!r.worldPoly || !wide(r)) continue;
        const d = Math.hypot(r.worldCx, r.worldCy);
        if (d < bd) { bd = d; start = r; }
    }
    assert.ok(start && bd < 300, 'the centre is wide open');
    const seen = new Set([start.k]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
        const r = queue[i];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = grid.rocks.get(KEY(r.vi + di, r.vj + dj));
            if (n && !seen.has(n.k) && wide(n)) { seen.add(n.k); queue.push(n); }
        }
    }
    for (const s of sites(grid)) {
        let near = Infinity;
        for (const k of seen) { const r = grid.rocks.get(k); near = Math.min(near, Math.hypot(r.worldCx - s.x, r.worldCy - s.y)); }
        assert.ok(near <= 200, s.name + ' is ' + Math.round(near) + ' from the 3-wide network');
    }
});

test('pads: every vault, shop and bank pad is clear rock-free ground', () => {
    for (const s of sites(grid)) {
        const r = (s.r || 95) * 0.8;
        for (let i = 0; i <= 8; i++) {
            const a = i * Math.PI / 4, d = i === 8 ? 0 : r;
            assert.equal(grid.pointInRock(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d), false, s.name + ' pad has rock on it');
        }
    }
});

test('rock and ore stay: every ring keeps rock, the rim stays a wall, ore and emeralds are there', () => {
    const bands = [[0, 0.25, 0.5], [0.25, 0.45, 0.35], [0.45, 0.65, 0.35], [0.65, 0.85, 0.6], [0.85, 1.0, 0.9]];
    for (const [a, b, min] of bands) {
        const cells = diskCells(grid).filter(r => { const f = Math.hypot(r.worldCx, r.worldCy) / R; return f >= a && f < b; });
        const rock = cells.filter(r => r.alive).length / cells.length;
        assert.ok(rock >= min, a + '-' + b + ' keeps ' + rock.toFixed(2) + ' rock');
    }
    const live = [...grid.rocks.values()].filter(r => r.alive);
    assert.ok(live.length >= diskCells(grid).length * 0.65, live.length + ' live rocks');
    const ore = live.filter(r => r.ore).length;
    assert.ok(ore >= 550 && ore <= 900, ore + ' ore rocks');
    assert.equal(live.filter(r => r.ore === ORE.EMERALD).length, Math.max(3, Math.round(3 * mapScale.lin(R))));
    const bare = live.filter(r => r.ore && !(r.deposits && r.deposits.length)).length;
    assert.ok(bare <= Math.max(2, ore * 0.01), bare + ' ore rocks without deposits');
    for (const r of grid.rocks.values()) if (r.canyon) assert.equal(r.ore, ORE.NONE, 'carved cells hold no ore');
});

test('ore share: the open map rolls more ore per rock, same tiers, deposits near the old total', () => {
    assert.ok(grid.oreShare > royaleLayout.ORE_SHARE, 'boosted share ' + grid.oreShare);
    assert.equal(legacy.oreShare, undefined);
    assert.equal(royaleLayout.oreShareOf(legacy), royaleLayout.ORE_SHARE);
    const salt = grid.oreSalt || 7;
    let kept = 0, base = 0;
    for (const r of grid.rocks.values()) {
        if (!r.alive || r.canyon || r.soft || r.ore === ORE.EMERALD || !r.worldPoly) continue;
        const old = royaleLayout.radialOre(r, R, salt, royaleLayout.ORE_SHARE);
        assert.equal(royaleLayout.radialOre(r, R, salt), r.ore, 'regrowth rolls with the live share');
        if (!old) continue;
        base++;
        if (r.ore === old) kept++;
    }
    assert.equal(kept, base, 'every rock that held ore at the old share keeps its tier');
    const deposits = (g) => [...g.rocks.values()].reduce((a, r) => a + (r.alive && r.deposits && Math.hypot(r.worldCx, r.worldCy) <= g.circleRadius ? r.deposits.length : 0), 0);
    const ratio = deposits(grid) / deposits(legacy);
    assert.ok(ratio >= 0.9 && ratio <= 1.12, 'deposits at ' + ratio.toFixed(2) + ' of the solid map');
});

test('newcomer ore: a landing in open ground near a vault gets its soft ore on the nearest wall', () => {
    const saved = new Map();
    for (const r of grid.rocks.values()) saved.set(r.k, { ore: r.ore, deposits: r.deposits, maxHealth: r.maxHealth, health: r.health, soft: r.soft });
    let spots = 0, full = 0, far = 0;
    try {
        for (const v of grid.vaultSites) {
            for (let i = 0; i < 24; i++) {
                const a = i / 24 * Math.PI * 2, d = 520 + (i % 4) * 80;
                const x = v.x + Math.cos(a) * d, y = v.y + Math.sin(a) * d;
                if (grid.pointInRock(x, y)) continue;
                spots++;
                const at = grid.rockEvents.length;
                const n = dropIn.seedOreOnWay(grid, x, y, v);
                const evs = grid.rockEvents.slice(at);
                assert.equal(evs.length, n);
                if (n >= 4) full++;
                for (const ev of evs) {
                    const r = grid.rocks.get(ev.k);
                    assert.ok(ev.bl === 1 && ev.ore > 0 && r.alive && r.soft && r.ore !== ORE.EMERALD && !r.canyon, 'a soft ore rock');
                    const was = saved.get(ev.k);
                    const eq = r.health / grid.plainRockHealth / (r.bHard || 1);
                    assert.ok(eq <= spawnReach.REACH.HARD_ROCK_EQ || r.health <= was.health, 'seeding never walls a landing in');
                    if (Math.hypot(r.worldCx - x, r.worldCy - y) > 800) far++;
                    Object.assign(r, saved.get(ev.k));
                }
                grid.rockEvents.length = at;
            }
        }
    } finally {
        for (const r of grid.rocks.values()) Object.assign(r, saved.get(r.k));
    }
    assert.ok(spots >= 10, 'open landing spots ' + spots);
    assert.ok(full >= spots * 0.95, full + ' of ' + spots + ' landings got all their ore');
    assert.equal(far, 0, 'seeded rock is near the landing');
});

test('biomes: all six keep real rock, obsidian still rings the centre', () => {
    const count = new Array(Biomes.N).fill(0);
    for (const r of grid.rocks.values()) if (r.alive && !r.canyon && r.biome >= 0) count[r.biome]++;
    const line = Biomes.BIOMES.map((b, i) => b.id + ' ' + count[i]).join(', ');
    for (let i = 0; i < Biomes.N; i++) assert.ok(count[i] >= 30, Biomes.BIOMES[i].name + ': ' + line);
    const inner = [...grid.rocks.values()].filter(r => r.alive && !r.canyon && r.worldPoly)
        .sort((a, b) => Math.hypot(a.worldCx, a.worldCy) - Math.hypot(b.worldCx, b.worldCy)).slice(0, 10);
    assert.ok(inner.every(r => r.biome === Biomes.IDX.obsidian), 'the rocks nearest the centre are obsidian');
});

test('spawn pits: same count as before, dug inside rock bands', () => {
    const want = Math.round(48 * mapScale.area(R));
    assert.equal(grid.spawnPits.length, want);
    let inside = 0;
    for (const p of grid.spawnPits) {
        const c = spawnReach.cellAt(grid, p.x, p.y);
        assert.ok(c && !c.alive && c.canyon, 'a pit is an open canyon cell');
        let rockSides = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = grid.rocks.get(KEY(c.vi + di, c.vj + dj)); if (n && n.alive) rockSides++; }
        if (rockSides >= 3) inside++;
    }
    assert.ok(inside >= want * 0.9, inside + ' of ' + want + ' pits sit in rock');
});

test('vault plazas: a clear pad with the rock wall close by', () => {
    for (const v of grid.vaultSites) {
        let near = 0, onPad = 0;
        for (const r of grid.rocks.values()) {
            if (!r.alive || !r.worldPoly) continue;
            const d = Math.hypot(r.worldCx - v.x, r.worldCy - v.y);
            if (d < 900) near++;
            if (d < (v.r || 95) + 60) onPad++;
        }
        assert.ok(near >= 20, v.name + ' has ' + near + ' rocks within 900');
        assert.equal(onPad, 0, v.name + ' pad crowded by rock');
    }
    const spots = openLayout.pillarSpots([{ kind: 'vault', x: 0, y: 0, r: 700, pad: 260 }, { kind: 'shop', x: 2000, y: 0, r: 400 }], [], [], Object.assign({}, openLayout.DEFAULTS, { pillars_per_vault: 3 }), 1);
    assert.equal(spots.length, 3, 'pillars still available when asked for');
});

test('spawn reach: open plaza ground and every pit can be got out of', () => {
    spawnReach.invalidate();
    const zone = { x: 0, y: 0, r: R + 100 };
    let n = 0;
    for (let i = 0; i < 400 && n < 60; i++) {
        const a = i * 2.399963, d = Math.sqrt((i % 97) / 97) * (R - 300);
        const x = Math.cos(a) * d, y = Math.sin(a) * d;
        if (grid.pointInRock(x, y)) continue;
        n++;
        const res = spawnReach.check(grid, x, y, { zone });
        assert.equal(res.ok, true, 'stuck at ' + Math.round(x) + ',' + Math.round(y) + ' ' + res.reason);
    }
    assert.ok(n >= 40, 'sampled open ground ' + n);
    const stuckPits = (g) => {
        global.gameManager.terrainGrid = g;
        spawnReach.invalidate();
        const z = { x: 0, y: 0, r: g.circleRadius + 100 };
        return g.spawnPits.filter(p => !spawnReach.check(g, p.x, p.y, { zone: z }).ok).length;
    };
    const live = stuckPits(grid), old = stuckPits(legacy);
    global.gameManager.terrainGrid = grid;
    spawnReach.invalidate();
    assert.ok(live <= Math.max(old + 3, grid.spawnPits.length * 0.08), live + ' pits ringed in (legacy map ' + old + ')');
});

test('geometry untouched: same cell grid and rock polygons, clients learn the layout from TG', () => {
    assert.deepEqual(grid.serialize(), legacy.serialize());
    for (const r of grid.rocks.values()) {
        const o = legacy.rocks.get(r.k);
        assert.ok(o, 'lattice cell missing');
        assert.deepEqual(r.worldPoly, o.worldPoly);
        assert.equal(r.biome, o.biome);
    }
    const sm = Object.create(socketManager.prototype);
    const packet = sm.terrainPacket();
    assert.equal(packet[0], 'TG');
    assert.deepEqual(JSON.parse(packet[3]), legacy.serialize());
    const state = new Map(JSON.parse(packet[4]).map(e => [e.k, e]));
    for (const r of grid.rocks.values()) {
        if (r.alive || r.growing) continue;
        assert.ok(state.has(r.k) && state.get(r.k).d === 1, 'dead rock ' + r.k + ' missing from TG');
    }
    const ore = JSON.parse(packet[5]);
    for (const [k] of ore) assert.ok(grid.rocks.get(k).alive, 'ore listed on an open cell');
});

test('deterministic: one seed, one layout, every boot and both modes; another seed, another map', () => {
    const want = layoutKeys(grid);
    assert.equal(layoutKeys(build()), want);
    const prev = process.env.ROYALE_ALWAYS_ON;
    process.env.ROYALE_ALWAYS_ON = prev === '1' ? '0' : '1';
    try { assert.equal(layoutKeys(build()), want); } finally { if (prev === undefined) delete process.env.ROYALE_ALWAYS_ON; else process.env.ROYALE_ALWAYS_ON = prev; }
    const other = build({ seed: LIVE.seed + 12 });
    const a = new Set(want.split(',')), b = other ? layoutKeys(other).split(',') : [];
    const differ = b.filter(k => !a.has(k)).length;
    assert.ok(differ > 0, 'another seed moved ' + differ + ' cells');
    assert.ok(Math.abs(openShare(other) - openShare(grid)) < 0.04, 'same open share on another seed');
    global.gameManager.terrainGrid = grid;
});

test('tutorial: the open layout never runs there', () => {
    const withCfg = build({ tutorial: true, raidStart: false });
    const without = build({ tutorial: true, raidStart: false, terrain: LEGACY });
    assert.equal(withCfg.openLayout, undefined);
    assert.equal(layoutKeys(withCfg), layoutKeys(without));
    assert.ok(openShare(withCfg) < 0.1, 'tutorial map stays solid');
    global.gameManager.terrainGrid = grid;
});

test('settings: defaults fill in, a missing block turns it off', () => {
    assert.equal(openLayout.settings(null), null);
    assert.equal(openLayout.settings(undefined), null);
    const o = openLayout.settings({ open_target: 0.4 });
    assert.equal(o.open_target, 0.4);
    assert.equal(o.corridor_width, openLayout.DEFAULTS.corridor_width);
    assert.ok(openLayout.settings(true).open_target > 0);
    assert.ok(openLayout.DEFAULTS.corridor_width >= 3 * grid._cellWorld, 'corridors at least three rocks wide');
});

test('always-on: mined rock regrows, a fully mined block comes back, canyon stays open', () => {
    const run = (ao) => {
        const prev = process.env.ROYALE_ALWAYS_ON;
        process.env.ROYALE_ALWAYS_ON = ao ? '1' : '0';
        try {
            const g = build();
            g.tankSource = () => [];
            const fresh = (r) => r && r.alive && !r.canyon && r.worldPoly && r.ore !== ORE.EMERALD;
            const near = (c, lo, hi) => [...g.rocks.values()].filter(r => r.worldPoly && Math.hypot(r.worldCx - c.worldCx, r.worldCy - c.worldCy) > lo && Math.hypot(r.worldCx - c.worldCx, r.worldCy - c.worldCy) <= hi);
            let centre = null;
            for (const r of g.rocks.values()) {
                const d = Math.hypot(r.worldCx, r.worldCy);
                if (!fresh(r) || d < 1500 || d > g.circleRadius - 700) continue;
                if (near(r, -1, 440).every(fresh)) { centre = r; break; }
            }
            assert.ok(centre, 'a solid patch to cut a block from');
            const block = near(centre, -1, 260);
            const moat = near(centre, 260, 440);
            for (const r of moat) { r.alive = false; r.health = 0; r.diedAt = 0; r.canyon = true; }
            const t0 = 1e12;
            const others = [...g.rocks.values()].filter(r => fresh(r) && !block.includes(r)).filter((r, i) => i % 7 === 0);
            for (const r of block.concat(others)) { r.alive = false; r.health = 0; r.diedAt = t0; }
            for (let t = t0; t <= t0 + 8 * 60000; t += 500) g.regrowTick(t);
            const canyonUp = [...g.rocks.values()].filter(r => r.canyon && (r.alive || r.growing)).length;
            return { block: block.filter(r => r.alive).length / block.length, others: others.filter(r => r.alive).length / others.length, canyonUp };
        } finally {
            if (prev === undefined) delete process.env.ROYALE_ALWAYS_ON; else process.env.ROYALE_ALWAYS_ON = prev;
            global.gameManager.terrainGrid = grid;
        }
    };
    const on = run(true), off = run(false);
    assert.equal(on.canyonUp, 0, 'canyon cells never regrow');
    assert.equal(off.canyonUp, 0, 'canyon cells never regrow');
    assert.ok(on.others >= 0.99, 'mined rock regrows (' + on.others.toFixed(2) + ')');
    assert.ok(off.others >= 0.99, 'mined rock regrows outside always-on too (' + off.others.toFixed(2) + ')');
    assert.equal(on.block, 1, 'a block mined out to its last rock comes back in always-on');
    assert.equal(off.block, 0, 'raids leave it to the next raid wipe');
});

test('cost: planning the layout stays cheap', () => {
    const real = openLayout.plan;
    let ms = 0, res = null;
    openLayout.plan = (...args) => {
        const t0 = process.hrtime.bigint();
        res = real(...args);
        ms = Number(process.hrtime.bigint() - t0) / 1e6;
        return res;
    };
    try { build({ raidStart: false }); } finally { openLayout.plan = real; }
    assert.ok(res && res.carve.length > 500, 'plan carves the plazas');
    assert.ok(res.open <= res.cells * 0.34, 'plan stays near its target');
    assert.ok(ms < 3000, 'plan took ' + ms.toFixed(0) + ' ms');
    log('     plan ' + ms.toFixed(0) + ' ms, ' + res.carve.length + ' cells carved, ' + res.links + ' corridors, ' + res.pillars + ' pillars');
    global.gameManager.terrainGrid = grid;
});

(async () => {
    let fail = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { fail++; console.log('FAIL ' + t.name + '\n     ' + (e && e.message)); }
    }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { }
    console.log(fail ? fail + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(fail ? 1 : 0);
})();
