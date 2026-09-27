// Spawn reachability (server/game/terrain/spawnReach.js) on a real Dig
// Royale terrain build, no game server:
//   node scripts/test/spawnReach.test.js
//
// Builds the live map's lattice (13x13 tiles, royale layout), then hand-makes
// the pockets the old spawn picker dropped people into (a cell ringed by
// shard / emerald / regrowing rock, a mined-out cell about to close, a way
// out that leaves the zone) and checks the rule, the exit-tunnel planner and
// the storm-rescue planner on each.
'use strict';

const assert = require('node:assert/strict');

global.Config = { dig_royale: true };
global.gameManager = { room: { width: 5460, height: 5460 } };

const mapGen = require('../../server/game/terrain/mapGen.js');
const { ORE, ORE_HP } = require('../../server/game/terrain/terrainGrid.js');
const reach = require('../../server/game/terrain/spawnReach.js');

const grid = mapGen.generate({ cols: 13, rows: 13, tileWidth: 420, fullLattice: true });
grid.buildVoronoiColliders();
const adj = reach.adjacency(grid);
const PLAIN = grid.baseRockHealth * 1.3;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// a fresh plain-rock cell well away from every pad/pit, all neighbours alive
// plain rock too (and theirs), so each test starts from solid ground
const used = new Set();
function solidCell() {
    for (const r of grid.rocks.values()) {
        if (used.has(r.k) || !r.alive || r.canyon || r.ore || !r.worldPoly) continue;
        const d = Math.hypot(r.worldCx, r.worldCy);
        if (d < 600 || d > 2000) continue;
        const ring = adj.get(r.k) || [];
        if (ring.length < 5) continue;
        let ok = true;
        for (const n of ring) {
            if (used.has(n.k) || !n.alive || n.canyon || n.ore) { ok = false; break; }
            for (const m of adj.get(n.k) || []) if (used.has(m.k) || !m.alive || m.canyon) { ok = false; break; }
            if (!ok) break;
        }
        if (!ok) continue;
        used.add(r.k);
        for (const n of ring) { used.add(n.k); for (const m of adj.get(n.k) || []) used.add(m.k); }
        return r;
    }
    throw new Error('no solid cell left');
}
function kill(r, t = Date.now()) { r.alive = false; r.health = 0; r.diedAt = t; r.noRegrowUntil = t + 120_000; }
function setOre(r, ore) { r.ore = ore; r.maxHealth = PLAIN * ORE_HP[ore]; r.health = r.maxHealth; r.alive = true; r.growing = false; }
const at = (r) => [r.worldCx, r.worldCy];
const bigZone = { x: 0, y: 0, r: 2800 };
function fresh() { reach.invalidate(); }

test('adjacency: every cell has 2..8 neighbours, symmetric', () => {
    let n = 0;
    for (const [k, list] of adj) {
        assert.ok(list.length <= 8);
        for (const o of list) assert.ok((adj.get(o.k) || []).some(x => x.k === k), 'asymmetric ' + k + '-' + o.k);
        n++;
    }
    assert.ok(n > 2000);
});

test('cellAt agrees with pointInRock', () => {
    for (let i = 0; i < 500; i++) {
        const x = (Math.random() - 0.5) * 5000, y = (Math.random() - 0.5) * 5000;
        const c = reach.cellAt(grid, x, y), p = grid.pointInRock(x, y);
        if (p) assert.equal(c, p);
        else if (c) assert.ok(!c.alive);
    }
});

test('a drop pit is escapable (soft rock around it)', () => {
    fresh();
    let ok = 0;
    for (const p of grid.spawnPits) if (reach.check(grid, p.x, p.y, { zone: bigZone }).ok) ok++;
    assert.ok(ok >= grid.spawnPits.length * 0.9, ok + '/' + grid.spawnPits.length);
});

test('a lone mined-out cell in plain rock: escapable by digging', () => {
    const c = solidCell(); kill(c); fresh();
    const res = reach.check(grid, ...at(c), { zone: bigZone });
    assert.equal(res.ok, true); assert.equal(res.via, 'dig');
});

test('a pocket ringed by fresh shard is enclosed; one plain side opens it', () => {
    const c = solidCell(); kill(c);
    const ring = adj.get(c.k);
    for (const n of ring) setOre(n, ORE.SHARD);
    fresh();
    const res = reach.check(grid, ...at(c), { zone: bigZone });
    assert.equal(res.ok, false); assert.equal(res.reason, 'enclosed');
    setOre(ring[0], ORE.NONE); fresh();
    assert.equal(reach.check(grid, ...at(c), { zone: bigZone }).ok, true);
});

test('fresh copper counts as a wall, a softened (30%) copper does not', () => {
    const c = solidCell(); kill(c);
    const ring = adj.get(c.k);
    for (const n of ring) setOre(n, ORE.COPPER);
    fresh();
    assert.equal(reach.check(grid, ...at(c), { zone: bigZone }).ok, false);
    ring[1].health = ring[1].maxHealth * 0.3; fresh();
    assert.equal(reach.check(grid, ...at(c), { zone: bigZone }).ok, true);
});

test('an emerald ring: enclosed, no exit tunnel, no rescue tunnel', () => {
    const c = solidCell(); kill(c);
    for (const n of adj.get(c.k)) setOre(n, ORE.EMERALD);
    fresh();
    assert.equal(reach.check(grid, ...at(c), { zone: bigZone }).ok, false);
    assert.equal(reach.exitPath(grid, ...at(c), { zone: bigZone, maxCells: 8 }), null);
    assert.equal(reach.exitPath(grid, ...at(c), { rescue: true, toZone: { x: 0, y: 0, r: 300 }, maxCells: 30 }), null);
});

test('a ring of regrowing rock is a wall (rescue may break it)', () => {
    const c = solidCell(); kill(c);
    for (const n of adj.get(c.k)) { n.alive = false; n.growing = true; n.health = PLAIN * 0.25; }
    fresh();
    assert.equal(reach.check(grid, ...at(c), { zone: bigZone }).ok, false);
    const p = reach.exitPath(grid, ...at(c), { rescue: true, toZone: { x: 0, y: 0, r: Math.hypot(...at(c)) - 250 }, maxCells: 10 });
    assert.ok(p && p.length >= 1);
    assert.ok(p.every(r => r.ore !== ORE.EMERALD));
});

test('a mined-out cell about to regrow is not a spawn', () => {
    const c = solidCell();
    c.alive = false; c.health = 0; c.diedAt = Date.now() - 20_000; c.noRegrowUntil = 0;
    fresh();
    const res = reach.check(grid, ...at(c), { zone: bigZone });
    assert.equal(res.ok, false); assert.equal(res.reason, 'start-closing');
    c.noRegrowUntil = Date.now() + 30_000; fresh();
    assert.equal(reach.check(grid, ...at(c), { zone: bigZone }).ok, true);
});

test('joined to an open region: escapes via the region', () => {
    const c = solidCell(); kill(c);
    // a 6-cell tunnel starting next door
    let cur = c; const tunnel = [];
    for (let i = 0; i < 6; i++) {
        const nx = (adj.get(cur.k) || []).find(n => n.alive && !tunnel.includes(n) && n !== c);
        kill(nx); tunnel.push(nx); cur = nx;
    }
    for (const n of adj.get(c.k)) if (!tunnel.includes(n)) setOre(n, ORE.SHARD);
    fresh();
    const res = reach.check(grid, ...at(c), { zone: bigZone });
    assert.equal(res.ok, true); assert.equal(res.via, 'region');
});

test('a way out that only leads into the storm does not count', () => {
    const c = solidCell(); kill(c); fresh();
    const tiny = { x: c.worldCx, y: c.worldCy, r: 30 };   // only the start cell's centre is in the zone
    assert.equal(reach.check(grid, ...at(c), { zone: tiny }).ok, false);
});

test('exit tunnel from a planned pocket reaches an open region, plain rock only, never emerald', () => {
    const c = solidCell();
    // an open region 3 cells away
    let cur = c; const path = [c];
    for (let i = 0; i < 3; i++) { cur = adj.get(cur.k).find(n => !path.includes(n)); path.push(cur); }
    const far = cur; kill(far);
    const region = [far];
    for (const n of adj.get(far.k)) { if (region.length >= 6) break; if (!path.includes(n)) { kill(n); region.push(n); } }
    // an emerald on the direct line forces a detour
    setOre(path[2], ORE.EMERALD);
    fresh();
    const p = reach.exitPath(grid, ...at(c), { zone: bigZone, assumeOpen: new Set([c.k]), maxCells: 8 });
    assert.ok(p, 'tunnel found');
    assert.ok(p.every(r => r.ore !== ORE.EMERALD && (!r.alive || r.health <= PLAIN * 1.05)));
    // dig it: the pocket escapes via the region now
    kill(c);
    for (const r of p) kill(r);
    fresh();
    const res = reach.check(grid, ...at(c), { zone: bigZone });
    assert.equal(res.ok, true); assert.equal(res.via, 'region');
});

test('cheap: 500 checks well under 1 ms each on average', () => {
    fresh();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 500; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.random() * 2300;
        reach.check(grid, Math.cos(a) * d, Math.sin(a) * d, { zone: bigZone });
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms / 500 < 1, (ms / 500).toFixed(3) + ' ms/check');
});

(async () => {
    let fail = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { fail++; console.log('FAIL ' + t.name + '\n     ' + (e && e.message)); }
    }
    console.log(fail ? fail + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(fail ? 1 : 0);
})();
