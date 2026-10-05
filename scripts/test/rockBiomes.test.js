// Rock biomes (shared/rockBiomes.js): node scripts/test/rockBiomes.test.js
//
//   determinism  the field is a pure function of position and seed: the same
//                seed gives the same map on every boot and every load of the
//                module, another seed gives another map
//   smooth       neighbouring rocks never jump from one pure biome to
//                another; a seam is spread over a few rocks
//   every biome  all six show up on the real raid map, inside out in the
//                right order (obsidian, magma, crystal, sandstone; moss and
//                clay out past the crystal)
//   agree        the client (the real terrainRenderer.js, run here with its
//                imports stubbed) colours every rock from the TG packet alone
//                and lands on the server's biome for every rock; ore rocks
//                look just like their biome; no rock is near-black; rocks
//                in one biome differ from each other; the HUD names the rock
//                under you
//   numbers      the toughness table (biome x ore, about 0.8x to 2x of
//                today), every rock's health follows it, gems pay the same
//                factor so gems per second of digging stay within a few
//                percent of today in every biome; regrowth applies it the
//                same way; softened spawn rock stays soft; the spawn-escape
//                check still calls fresh plain rock of any biome diggable;
//                the tutorial has none
//   geometry     rock polygons are the same before and after the biomes go
//                on, and the same as before this feature existed; the client
//                voronoi code and the shader's geometry are untouched
//   wiring       served at /shared/rockBiomes.js, loaded by index.html, the
//                seed reaches init, the maps and the HUD note use it
//
// Builds the real 16x16 Dig Royale map in this process (no game server).
'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
delete process.env.ROYALE_DEBUG;
const ROOT = fs.mkdtempSync(path.join(process.env.DATA_DIR || os.tmpdir(), 'dw-biomes-test-'));
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

const BIOMES_PATH = path.join(REPO, 'shared', 'rockBiomes.js');
const B = require(BIOMES_PATH);
const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
const { ORE, ORE_HP, rockTough, rockPay } = require(path.join(SERVER, 'game', 'terrain', 'terrainGrid.js'));
const spawnReach = require(path.join(SERVER, 'game', 'terrain', 'spawnReach.js'));
const royaleLayout = require(path.join(SERVER, 'game', 'terrain', 'royaleLayout.js'));
const { socketManager } = require(path.join(SERVER, 'game', 'network', 'sockets.js'));

const TILES = 16, TILE_W = 420, SEED = 11, W = TILES * TILE_W;
global.gameManager = {
    room: { width: W, height: W, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
};
function build(seed = SEED, contour = true) {
    const quiet = console.log;
    console.log = () => {};
    try {
        const g = mapGen.generate({ cols: TILES, rows: TILES, tileWidth: TILE_W, seed, fullLattice: true });
        global.gameManager.terrainGrid = g;
        if (contour) g.buildContour(); else g.buildVoronoiColliders();
        return g;
    } finally { console.log = quiet; }
}
const grid = build();
const raidRocks = [...grid.rocks.values()].filter(r => r.alive && !r.canyon);
const unit = (r) => B.latticeUnit(r.vi, r.vj, grid.cols, grid.rows);
const radius = (r) => Math.hypot(...unit(r));
const ID = B.IDX;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('determinism: one seed, one map, every boot', () => {
    const w = new Array(B.N), w2 = new Array(B.N);
    for (let i = 0; i < 400; i++) {
        const x = Math.sin(i * 12.9898) * 1.1, y = Math.cos(i * 78.233) * 1.1;
        B.weightsAt(x, y, SEED, w);
        B.weightsAt(x, y, SEED, w2);
        assert.deepEqual(w, w2);
        let sum = 0;
        for (const v of w) { assert.ok(v >= 0 && v <= 1, 'weight in 0..1'); sum += v; }
        assert.ok(Math.abs(sum - 1) < 1e-9, 'weights sum to 1');
    }
    // a fresh copy of the module (another process, the browser) agrees
    delete require.cache[require.resolve(BIOMES_PATH)];
    const B2 = require(BIOMES_PATH);
    assert.notEqual(B2, B);
    for (const r of raidRocks) {
        assert.deepEqual(B2.rockWeights(r.vi, r.vj, grid.cols, grid.rows, SEED), B.rockWeights(r.vi, r.vj, grid.cols, grid.rows, SEED));
    }
    // a second boot of the same map: the same biome and numbers on every rock
    const again = build();
    for (const r of grid.rocks.values()) {
        const o = again.rocks.get(r.k);
        assert.equal(o.biome, r.biome);
        assert.equal(o.bHard, r.bHard);
        assert.equal(o.bOre, r.bOre);
    }
    assert.equal(again.biomeSeed, SEED);
    // another seed is another layout
    let differ = 0;
    for (const r of raidRocks) if (B.rockBiome(r.vi, r.vj, grid.cols, grid.rows, SEED + 1) !== r.biome) differ++;
    assert.ok(differ > raidRocks.length * 0.1, 'seed changes the map (' + differ + ' rocks moved)');
    global.gameManager.terrainGrid = grid;
});

test('smooth: seams blend over a few rocks, no hard jumps', () => {
    const byKey = new Map(raidRocks.map(r => [r.k, r]));
    const w = (r) => B.rockWeights(r.vi, r.vj, grid.cols, grid.rows, SEED);
    const tones = (wt) => B.tonesFor(wt, [], 0);
    let pairs = 0, worstW = 0, worstFace = 0, jumps = 0;
    for (const a of raidRocks) {
        for (const [di, dj] of [[1, 0], [0, 1]]) {
            const b = byKey.get((a.vi + di) * 100003 + (a.vj + dj));
            if (!b) continue;
            pairs++;
            const wa = w(a), wb = w(b), ta = tones(wa), tb = tones(wb);   // biome tones, no per-rock variation
            for (let i = 0; i < B.N; i++) worstW = Math.max(worstW, Math.abs(wa[i] - wb[i]));
            for (let ch = 6; ch < 9; ch++) worstFace = Math.max(worstFace, Math.abs(ta[ch] - tb[ch]));
            if (B.dominant(wa) !== B.dominant(wb) && Math.max(...wa) > 0.95 && Math.max(...wb) > 0.95) jumps++;
        }
    }
    assert.ok(pairs > 3000, 'checked the whole map');
    assert.equal(jumps, 0, 'a pure biome never touches another pure one');
    assert.ok(worstW <= 0.55, 'a biome weight moves at most about half way per rock (worst ' + worstW.toFixed(2) + ')');
    // the palettes sit up to ~90 apart a channel (sandstone vs crystal
    // blue) and the seam leans to the biome ahead (squared weights, so no
    // grey in-between rocks), so one step across a seam can be ~70
    assert.ok(worstFace <= 76, 'neighbouring faces differ by at most 76 a channel (worst ' + worstFace + ')');
    // the bands blend over more than one rock: count rocks clearly in between
    let mixed = 0;
    for (const r of raidRocks) { const wt = w(r); if (Math.max(...wt) < 0.8) mixed++; }
    assert.ok(mixed > raidRocks.length * 0.08, 'plenty of in-between rocks (' + mixed + ')');
});

test('every biome: all six on the real map, inside out', () => {
    const count = new Array(B.N).fill(0), rad = new Array(B.N).fill(0);
    for (const r of raidRocks) { count[r.biome]++; rad[r.biome] += radius(r); }
    const mean = rad.map((v, i) => v / Math.max(1, count[i]));
    const line = B.BIOMES.map((b, i) => b.id + ' ' + count[i] + ' @' + mean[i].toFixed(2)).join(', ');
    for (let i = 0; i < B.N; i++) assert.ok(count[i] >= 30, B.BIOMES[i].name + ' has ' + count[i] + ' rocks: ' + line);
    assert.ok(mean[ID.obsidian] < mean[ID.magma] && mean[ID.magma] < mean[ID.crystal] && mean[ID.crystal] < mean[ID.sandstone], 'journey order: ' + line);
    assert.ok(mean[ID.moss] > mean[ID.crystal] && mean[ID.clay] > mean[ID.moss], 'pockets sit out past the crystal: ' + line);
    // the Core and the last storm are within ~0.1 of the centre: obsidian
    const core = raidRocks.filter(r => radius(r) < 0.1);
    assert.ok(core.length && core.every(r => r.biome === ID.obsidian), 'the very centre is obsidian');
    log('     ' + line);
});

let tr = null;
async function clientRenderer() {
    if (tr) return tr;
    // the real client module, its three imports stubbed (no DOM needed for
    // the biome table)
    const src = fs.readFileSync(path.join(REPO, 'public', 'client', 'terrainRenderer.js'), 'utf8')
        .replace(/^import .*$/mg, '');
    const stub = 'const config = { graphical: {}, game: {} }; const global = {}; const gameSound = {};\n';
    globalThis.window = { DWBiomes: B };
    const file = path.join(ROOT, 'terrainRenderer.mjs');
    fs.writeFileSync(file, stub + src);
    await import(url.pathToFileURL(file).href);
    tr = globalThis.window.terrainRenderer;
    return tr;
}

test('agree: the client colours every rock from the TG packet alone', async () => {
    // the packet the server sends (sockets.js terrainPacket)
    const sm = Object.create(socketManager.prototype);
    const packet = sm.terrainPacket();
    const m = packet.slice(1);   // what the client's 'TG' handler gets
    const cols = m[0], rows = m[1], seed = m[11] | 0;
    assert.equal(seed, SEED, 'the biome seed rides at the end of TG');
    assert.equal(seed, grid.biomeSeed);
    const R = await clientRenderer();
    R._ore = new Map(JSON.parse(m[4]));
    R._setBiomes(seed, cols, rows);
    assert.ok(R._bio, 'biomes on');

    // what the shader reads for a rock: 6 texels (ink, dark, face, light,
    // rim, gem), rgb each, then the rim texel's alpha (its strength), the
    // ink texel's (the seam glow) and the gem texel's (the veins)
    const texel = (k) => {
        const vi = Math.floor(k / 100003), vj = k - vi * 100003;
        const o = ((vj + 8) * 128 * 6 + (vi + 8) * 6) * 4, out = [];
        for (let q = 0; q < 6; q++) out.push(R._bio.tex[o + q * 4], R._bio.tex[o + q * 4 + 1], R._bio.tex[o + q * 4 + 2]);
        out.push(R._bio.tex[o + 4 * 4 + 3], R._bio.tex[o + 3], R._bio.tex[o + 5 * 4 + 3]);
        return out;
    };
    // ore: the tier (0 none); an ore rock's veins take the ore's colour
    const tones = (r, ore) => B.rockTones(r.vi, r.vj, cols, rows, seed, [], 0, ore | 0);
    const lum = (t, q) => 0.2126 * t[q * 3] + 0.7152 * t[q * 3 + 1] + 0.0722 * t[q * 3 + 2];
    let ore = 0, darkest = 255, darkestInk = 255;
    const faces = new Array(B.N).fill(0).map(() => new Set());
    for (const r of grid.rocks.values()) {
        assert.equal(R.biomeOf(r.k), r.biome, 'rock ' + r.k + ' biome');
        if (!r.alive) continue;
        const has = R._ore.has(r.k), want = tones(r, R._ore.get(r.k) | 0);
        if (has) ore++;
        assert.deepEqual(texel(r.k), want, 'rock ' + r.k + ' tones');
        // an ore rock: exactly its biome's own stone
        if (has) {
            const plain = tones(r, 0);
            assert.deepEqual(want.slice(0, 15), plain.slice(0, 15), 'ore rock ' + r.k + ' the same stone as a plain one');
        } else faces[r.biome].add(want.slice(6, 9).join(','));
        darkest = Math.min(darkest, lum(want, 2));
        darkestInk = Math.min(darkestInk, lum(want, 0));
    }
    assert.ok(ore > 100, 'ore rocks checked');
    // nothing as dark as the old near-black rock (classic face luminance 41,
    // its ink 14), at the owner's 3.7-of-5 brightness (rockBiomes BRIGHT)
    assert.ok(darkest >= 44, 'darkest rock face (ore included) luminance ' + darkest.toFixed(1));
    assert.ok(darkestInk >= 15, 'darkest seam ink luminance ' + darkestInk.toFixed(1));
    // rocks in one biome are not all one colour
    for (let b = 0; b < B.N; b++) assert.ok(faces[b].size >= 20, B.BIOMES[b].id + ' has ' + faces[b].size + ' different faces');
    log('     darkest face L' + darkest.toFixed(0) + ', darkest ink L' + darkestInk.toFixed(0) + ', faces per biome ' + faces.map(f => f.size).join('/'));

    // ore comes to a plain rock: its cell flips, and only it is re-shaded
    const plain = raidRocks.find(r => !R._ore.has(r.k));
    R._bioPatch.clear();
    R._ore.set(plain.k, 2);
    R._oreLook(plain.k);
    assert.deepEqual([...R._bioPatch], [plain.k]);
    assert.ok(R._bioUpload);
    const flipped = texel(plain.k), b0 = tones(plain, 0);
    assert.deepEqual(flipped, tones(plain, 2));
    R._ore.delete(plain.k);
    R._oreLook(plain.k);
    assert.deepEqual(texel(plain.k), b0, 'and back to its biome');
    R._bioPatch.clear();
    R._oreLook(plain.k);
    assert.equal(R._bioPatch.size, 0, 'no change, no re-shade');

    // the HUD note names the rock under the player
    const hw = W / 2;
    for (const r of raidRocks.filter((_, i) => i % 7 === 0)) {
        assert.equal(B.biomeAt(r.wx / hw, r.wy / hw, cols, rows, seed), r.biome, 'note at rock ' + r.k);
    }

    // no seed (the tutorial, another mode): classic rock
    R._setBiomes(0, cols, rows);
    assert.equal(R._bio, null);
    assert.equal(R.biomeOf(plain.k), -1);
});

test('numbers: biome x ore toughness, paid back in gems', () => {
    const T = (b, ore) => B.toughness(B.BIOMES[ID[b]].hard, ore);
    // the table: soft rim, medium middle, tough magma, very tough obsidian
    const hard = (b) => B.BIOMES[ID[b]].hard;
    assert.ok(hard('sandstone') <= 0.85 && hard('clay') <= 0.9, 'sandstone and clay are soft');
    assert.ok(Math.abs(hard('moss') - 1) <= 0.1 && Math.abs(hard('crystal') - 1) <= 0.1, 'moss and crystal are medium');
    assert.ok(hard('magma') >= 1.2 && hard('obsidian') >= 1.4 && hard('obsidian') > hard('magma'), 'magma tough, obsidian very tough');
    assert.ok(hard('clay') < hard('moss') && hard('crystal') < hard('magma'), 'tougher inward');
    // ore: copper < vein (azurite) < shard < emerald, plain no tougher than copper
    const OT = B.ORE_TOUGH;
    assert.ok(OT[ORE.NONE] <= OT[ORE.COPPER] && OT[ORE.COPPER] < OT[ORE.VEIN] && OT[ORE.VEIN] < OT[ORE.SHARD] && OT[ORE.SHARD] < OT[ORE.EMERALD]);
    assert.ok(Math.abs(T('sandstone', ORE.NONE) - 0.8) < 0.05 && Math.abs(T('sandstone', ORE.COPPER) - 0.8) < 0.05, 'sandstone plain/copper ~0.8x');
    assert.ok(Math.abs(T('obsidian', ORE.EMERALD) - 2) < 0.1, 'obsidian emerald ~2x');
    const table = ['sandstone', 'clay', 'moss', 'crystal', 'magma', 'obsidian'].map(b =>
        b + ' ' + [ORE.NONE, ORE.COPPER, ORE.VEIN, ORE.SHARD, ORE.EMERALD].map(o => T(b, o).toFixed(2)).join('/'));
    log('     toughness (plain/copper/vein/shard/emerald): ' + table.join(' | '));

    for (const r of grid.rocks.values()) {
        assert.ok(r.bHard >= 0.79 && r.bHard <= 1.51, 'rock toughness ' + r.bHard);
        assert.ok(r.bOre >= 0.75 && r.bOre <= 1.25, 'rock ore chance ' + r.bOre);
        assert.ok(r.bUp >= 0 && r.bUp <= 0.25);
    }
    // every rock's health: plain x the ore's own x biome x ore toughness;
    // the spawn plaza and drop pits are softened to 30% of a flat rock
    let checked = 0, soft = 0;
    for (const r of raidRocks) {
        const flat = grid.plainRockHealth * (ORE_HP[r.ore] || 1);
        if (r.soft) {
            soft++;
            assert.ok(Math.abs(r.maxHealth - Math.max(10, flat * 0.3)) < 1e-6, 'soft rock ' + r.k + ' is 30% of a flat rock whatever its biome');
            assert.equal(rockPay(r), 1, 'soft rock pays flat');
        } else {
            assert.ok(Math.abs(r.maxHealth / (flat * B.toughness(r.bHard, r.ore)) - 1) < 1e-9, 'rock ' + r.k + ' health');
            assert.equal(rockPay(r), B.toughness(r.bHard, r.ore));
        }
        checked++;
    }
    assert.ok(checked > 1500, checked + ' rocks, ' + soft + ' soft');
    // every place that softens rock for a spawn or a newcomer keeps it at
    // a flat rock's health (no biome toughness) and marks it soft, so it
    // pays the old flat gems
    const SOFTENERS = [['terrain', 'royaleLayout.js'], ['terrain', 'dropIn.js'], ['terrain', 'raidOpening.js'],
        ['terrain', 'newcomerDirector.js'], ['gamemodes', 'scripts', 'dig_royale.js']];
    for (const f of SOFTENERS) {
        const src = fs.readFileSync(path.join(SERVER, 'game', ...f), 'utf8');
        const lines = src.split('\n');
        let n = 0;
        lines.forEach((ln, i) => {
            if (!/maxHealth = Math\.max\(10,/.test(ln)) return;
            n++;
            assert.ok(!/rockTough|bHard/.test(ln), f.join('/') + ':' + (i + 1) + ' softens from a flat rock');
            assert.ok(lines.slice(i, i + 4).some(l => /rock\.soft = true/.test(l)), f.join('/') + ':' + (i + 1) + ' marks it soft');
        });
        assert.ok(n >= 1, f.join('/') + ' still softens rock');
    }
    // and a soft rock in the toughest biome is exactly as soft as anywhere
    const obs = raidRocks.find(r => r.alive && !r.ore && r.biome === ID.obsidian && r.bHard > 1.45);
    const fake = { ...obs, soft: true };
    assert.equal(rockPay(fake), 1, 'soft obsidian pays flat');
    assert.equal(rockPay(obs), obs.bHard, 'hard obsidian pays its toughness');

    // gems pay the toughness: spawnOreBurst scales every gem by rockPay
    const gemsSrc = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'gems.js'), 'utf8');
    assert.ok(/value \*= rockPay\(rock\);/.test(gemsSrc), 'gems.js pays the toughness');

    // gems per second of digging, biome by biome, against today's flat map
    // (no toughness, no tilt). Expected gems per rock: copper 3.5 deposits
    // x 15, vein 2.5 x 30, shard 150, emerald 500.
    const VALUE = { [ORE.NONE]: 0, [ORE.COPPER]: 52.5, [ORE.VEIN]: 75, [ORE.SHARD]: 150, [ORE.EMERALD]: 500 };
    const acc = () => ({ v: 0, h: 0, ov: 0, oh: 0 });
    const now = B.BIOMES.map(acc), old = B.BIOMES.map(acc), all = [acc(), acc()];
    const R0 = grid.circleRadius;
    const add = (a, v, h, ore) => { a.v += v; a.h += h; if (ore) { a.ov += v; a.oh += h; } };
    for (const r of raidRocks) {
        for (let salt = 1; salt <= 60; salt++) {
            const a = royaleLayout.radialOre(r, R0, salt * 7919);
            const b = royaleLayout.radialOre({ ...r, bOre: 1, bUp: 0 }, R0, salt * 7919);
            const t = B.toughness(r.bHard, a);
            add(now[r.biome], VALUE[a] * t, ORE_HP[a] * t, a); add(all[0], VALUE[a] * t, ORE_HP[a] * t, a);
            add(old[r.biome], VALUE[b], ORE_HP[b], b); add(all[1], VALUE[b], ORE_HP[b], b);
        }
    }
    const rate = (n, o) => (n.v / n.h) / (o.v / o.h), oreRate = (n, o) => (n.ov / n.oh) / (o.ov / o.oh);
    const rows = [];
    for (let i = 0; i < B.N; i++) {
        const g = rate(now[i], old[i]), go = oreRate(now[i], old[i]), dig = now[i].h / old[i].h;
        rows.push(B.BIOMES[i].id + ' dig x' + dig.toFixed(2) + ' gems/s x' + g.toFixed(2) + ' (ore rocks x' + go.toFixed(2) + ')');
        assert.ok(g >= 0.95 && g <= 1.2, B.BIOMES[i].id + ' gems per dig-second x' + g.toFixed(3));
        assert.ok(Math.abs(go - 1) <= 0.05, B.BIOMES[i].id + ' gems per dig-second on ore rocks x' + go.toFixed(3));
    }
    const mapWide = rate(all[0], all[1]);
    assert.ok(Math.abs(mapWide - 1) <= 0.08, 'map-wide gems per dig-second x' + mapWide.toFixed(3));
    assert.ok(Math.abs(all[0].h / all[1].h - 1) <= 0.1, 'the map as a whole digs about as fast as today');
    assert.ok(rate(now[ID.obsidian], old[ID.obsidian]) >= rate(now[ID.sandstone], old[ID.sandstone]), 'the centre is at least as rich per second');
    log('     ' + rows.join(' | ') + ' | map x' + mapWide.toFixed(3));

    // the copper-only twist still means copper only
    global.royaleMods = { ore: 'copper' };
    try {
        for (const r of raidRocks.slice(0, 300)) {
            const o = royaleLayout.radialOre(r, R0, 77);
            assert.ok(o === ORE.NONE || o === ORE.COPPER);
        }
    } finally { global.royaleMods = null; }

    // regrowth: the same toughness, applied the same way, and never soft
    for (const pick of [r => r.biome === ID.obsidian && r.bHard > 1.45, r => r.biome === ID.magma, r => r.biome === ID.sandstone && r.bHard < 0.82]) {
        const rock = raidRocks.find(r => pick(r) && r.alive && !r.soft);
        assert.ok(rock, 'a rock to regrow');
        rock.soft = true;   // as if softened for a spawn before it was dug
        grid.damageRock(rock, rock.health + 1);
        assert.ok(grid.startRegrow(rock, Date.now()));
        assert.equal(rock.soft, false, 'regrown rock is full strength');
        const want = grid.plainRockHealth * (ORE_HP[rock.ore] || 1) * B.toughness(rock.bHard, rock.ore);
        assert.ok(Math.abs(rock.maxHealth / want - 1) < 1e-9, 'regrow health follows biome x ore');
    }

    // the spawn-escape check: fresh plain rock of every biome is diggable
    // (compared with a plain rock of its own biome), fresh ore is a wall
    const ctx = { plain: grid.plainRockHealth, now: Date.now(), zone: null };
    for (let b = 0; b < B.N; b++) {
        const r = raidRocks.find(x => x.alive && !x.soft && !x.ore && x.biome === b && Math.abs(x.bHard - B.BIOMES[b].hard) < 1e-6);
        assert.ok(r, B.BIOMES[b].id + ' plain rock');
        const c = spawnReach.classify(grid, r, ctx);
        assert.equal(c.kind, 'rock', B.BIOMES[b].id + ' fresh plain rock is diggable');
        assert.ok(Math.abs(c.cost - B.BIOMES[b].hard) < 1e-6, 'and costs its real health');
        const cop = { ...r, ore: ORE.COPPER, health: r.health * ORE_HP[ORE.COPPER] };
        assert.equal(spawnReach.classify(grid, cop, ctx).kind, 'wall', B.BIOMES[b].id + ' fresh copper is a wall');
    }

    // the tutorial (seed 0): no biomes, every rock as before
    const g2 = build();
    royaleLayout.setBiomes(g2, 0);
    for (const r of g2.rocks.values()) {
        assert.ok(r.bHard === 1 && r.bOre === 1 && r.bUp === 0 && r.biome === -1);
        assert.equal(rockTough(r, ORE.EMERALD), 1, 'no toughness without biomes');
    }
    assert.equal(g2.biomeSeed, 0);
    global.gameManager.terrainGrid = grid;
});

// sha256 of every rock polygon on this map, from the code before the biomes
// existed. The biomes must never move a vertex; if rock geometry is changed
// on purpose some day, update this pin along with it.
const GEOMETRY_PIN = '9384d55b71ced151';
const SOURCE_PINS = { glslGeometry: 'a188445866c30408', vh2: 'c3379e0cb7db54f6', boundary: 'e0c73cfd5fbad76d' };
test('geometry: the same rock polygons before and after', () => {
    const polys = (g) => {
        const h = crypto.createHash('sha256');
        for (const k of [...g.rocks.keys()].sort((a, b) => a - b)) {
            const r = g.rocks.get(k);
            h.update(k + ':' + (r.worldPoly ? r.worldPoly.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';') : 'none') + '|' + r.wx + ',' + r.wy + '\n');
        }
        return h.digest('hex').slice(0, 16);
    };
    // the bare lattice (no layout, no biomes) against the full raid build
    const bare = build(SEED, false);
    for (const r of grid.rocks.values()) {
        const o = bare.rocks.get(r.k);
        assert.deepEqual(r.worldPoly, o.worldPoly, 'rock ' + r.k + ' polygon');
        assert.equal(r.wx, o.wx); assert.equal(r.wy, o.wy);
    }
    assert.equal(polys(grid), GEOMETRY_PIN, 'rock polygons match the pre-biome build');
    assert.equal(polys(bare), GEOMETRY_PIN);
    global.gameManager.terrainGrid = grid;
    // the client's copies: seed jitter, silhouette, the shader's voronoi
    const src = fs.readFileSync(path.join(REPO, 'public', 'client', 'terrainRenderer.js'), 'utf8');
    const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
    const sh = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
    assert.equal(sh(cut('vec2 hash2(vec2 p){', 'float nl=length(mr);')), SOURCE_PINS.glslGeometry, 'shader voronoi untouched');
    assert.equal(sh(cut('    _vh2(i, j) {', '    _buildVoronoiDebugSegs() {')), SOURCE_PINS.vh2, 'client seed jitter untouched');
    assert.equal(sh(cut('    _buildVoronoiBoundary() {', '    _buildNoiseTile() {')), SOURCE_PINS.boundary, 'client silhouette untouched');
    // and the colour block only picks tones, read at the rock's own seed cell
    const fs2 = cut('if(u_bioOn>.5){', 'const float INK');
    assert.ok(/vec2 bc=n\+mg\+vec2\(8\.\);/.test(fs2), 'tones read at the seed cell');
    assert.ok(!/\b(md|mr|mg|bd|nl|lt)\s*=/.test(fs2.replace(/vec2 bc=n\+mg\+vec2\(8\.\);/, '')), 'nothing geometric assigned');
});

test('wiring: served, loaded, passed through, drawn', () => {
    const acc = fs.readFileSync(path.join(SERVER, 'accounts', 'index.js'), 'utf8');
    assert.ok(/SHARED_FILES = new Set\(\[[^\]]*'rockBiomes\.js'/.test(acc), 'served at /shared/rockBiomes.js');
    const html = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
    assert.ok(html.indexOf('<script src="/shared/rockBiomes.js"></script>') > 0 &&
        html.indexOf('/shared/rockBiomes.js') < html.indexOf('./client/app.js'), 'loaded before the game modules');
    const si = fs.readFileSync(path.join(REPO, 'public', 'client', 'socketinit.js'), 'utf8');
    assert.ok(/terrainRenderer\.init\(cells, cols, rows, rockState, oreState, oreSalt, m\[11\] \| 0\)/.test(si), 'TG seed reaches init');
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.ok(/paths\.aliveBio/.test(app) && /tr\.biomeOf\(k\)/.test(app), 'maps tint by biome');
    assert.ok(/push\(hudNote\(3, "biome", biome\.name, biome\.ui\)\)/.test(app), 'quiet note, lowest priority');
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log('ok   ' + t.name);
        } catch (e) {
            failed++;
            console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
        }
    }
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
