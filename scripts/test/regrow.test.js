'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.Config = { dig_royale: true };
global.gameManager = { room: { width: 5460, height: 5460 } };

const mapGen = require('../../server/game/terrain/mapGen.js');
const { REGROW } = require('../../server/game/terrain/terrainGrid.js');
const blooms = require('../../server/game/terrain/blooms.js');

const grid = mapGen.generate({ cols: 13, rows: 13, tileWidth: 420, fullLattice: true });
grid.buildVoronoiColliders();

// the client's rise formula, lifted straight from terrainRenderer.js
const CLIENT = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'client', 'terrainRenderer.js'), 'utf8');
const CLIENT_GROW_MS = +(/const GROW_MS\s*=\s*(\d+)/.exec(CLIENT) || [])[1];
const clientRise = new Function('return ' + /const riseElapsed = (\(g, nowMs\) => [^;]+);/.exec(CLIENT)[1])();
const clientRate = new Function('return ' + /const riseRate = (\(s\) => [^;]+);/.exec(CLIENT)[1])();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let tanks = [];
grid.tankSource = () => tanks;
let bloomNow = null;
blooms.current = () => bloomNow;

// plain cells in solid rock, well apart from each other
const used = [];
function solidCell() {
    for (const r of grid.rocks.values()) {
        if (!r.alive || r.canyon || r.ore || !r.worldPoly || r.growing) continue;
        const d = Math.hypot(r.worldCx, r.worldCy);
        if (d < 500 || d > 2200) continue;
        if (!grid._hasLivingNeighbour(r)) continue;
        if (used.some(u => Math.hypot(u.worldCx - r.worldCx, u.worldCy - r.worldCy) < 900)) continue;
        used.push(r);
        return r;
    }
    throw new Error('no solid cell left');
}
function kill(r, t) { r.alive = false; r.health = 0; r.diedAt = t; r.noRegrowUntil = 0; }
// The grid reads Date.now() in a couple of places (the rise offset it sends,
// the join snapshot), so the test clock drives that too.
let fakeNow = Date.now();
Date.now = () => fakeNow;
function tick(t) { fakeNow = t; grid.regrowTick(t); }
// run the regrow pass every 500 ms from t0 to t1 (inclusive), calling fn(t)
function run(t0, t1, fn) {
    for (let t = t0; t <= t1; t += REGROW.PACING_MS) { tick(t); if (fn) fn(t); }
}
function events(k) { const out = grid.rockEvents.filter(e => e.k === k); return out; }
function reset() { grid.rockEvents.length = 0; tanks = []; bloomNow = null; }
let clock = fakeNow + 10_000;

test('constants: a short wait and a 5 s rise, the shape timeline mirrored on the client', () => {
    assert.equal(REGROW.BASE_DELAY_MS, 18_000);
    assert.equal(REGROW.MIN_DELAY_MS, 8_000);
    assert.equal(REGROW.DEFICIT_MS_PER_GAP, 250);
    assert.equal(REGROW.GROW_MS, 16_000);
    assert.equal(REGROW.RISE_MS, 5_000);
    assert.equal(REGROW.RISE_RATE, REGROW.GROW_MS / REGROW.RISE_MS);
    assert.equal(REGROW.BLOOM_DELAY_MS, 5_000);
    assert.equal(REGROW.BLOOM_START, 0.45);
    assert.equal(REGROW.ORPHAN_DELAY_MS, 60_000);
    assert.equal(CLIENT_GROW_MS, REGROW.GROW_MS, 'terrainRenderer GROW_MS');
    assert.equal(clientRate(REGROW.RISE_RATE), REGROW.RISE_RATE, 'the client draws the full pace');
    assert.equal(clientRate(REGROW.RISE_RATE * REGROW.NEAR_RATE), REGROW.RISE_RATE * REGROW.NEAR_RATE);
    assert.ok(Math.abs(REGROW.NEAR_RATE - 1 / 2.4) < 1e-9);
});

test('timing: waits the delay, then rises over 5 s at full pace', () => {
    reset();
    const rock = solidCell();
    const t0 = clock; clock += 200_000;
    kill(rock, t0);
    grid._lastRegrowTick = 0;
    let startedAt = 0, doneAt = 0;
    run(t0, t0 + 30_000, t => {
        if (!startedAt && rock.growing) startedAt = t;
        if (startedAt && !doneAt && rock.alive) doneAt = t;
    });
    const lo = REGROW.BASE_DELAY_MS - REGROW.DEFICIT_MS_PER_GAP;
    assert.ok(startedAt >= t0 + lo && startedAt < t0 + REGROW.BASE_DELAY_MS + 600, 'started at +' + (startedAt - t0));
    const ev = events(rock.k).find(e => e.r === 1);
    assert.ok(ev && ev.s === REGROW.RISE_RATE, 'full pace on the wire');
    assert.ok(doneAt >= startedAt + REGROW.RISE_MS && doneAt < startedAt + REGROW.RISE_MS + 600, 'rose in ' + (doneAt - startedAt));
    assert.ok(events(rock.k).some(e => e.r === 2));
});

test('bloom: 5 s wait, then the last 55% of the rise', () => {
    reset();
    const rock = solidCell();
    bloomNow = { x: rock.wx, y: rock.wy, r: 340, until: Infinity };
    const t0 = clock; clock += 100_000;
    kill(rock, t0);
    grid._lastRegrowTick = 0;
    let startedAt = 0, doneAt = 0;
    run(t0, t0 + 20_000, t => {
        if (!startedAt && rock.growing) startedAt = t;
        if (!doneAt && rock.alive) doneAt = t;
    });
    assert.ok(startedAt >= t0 + 5000 && startedAt < t0 + 5600, 'started at +' + (startedAt - t0));
    const riseMs = REGROW.RISE_MS * (1 - REGROW.BLOOM_START);
    assert.ok(doneAt - startedAt >= riseMs && doneAt - startedAt < riseMs + 600, 'rose in ' + (doneAt - startedAt));
    const ev = events(rock.k).find(e => e.r === 1);
    assert.equal(ev.e, Math.round(REGROW.GROW_MS * REGROW.BLOOM_START), 'clients start the drawing 45% in');
    assert.ok(Math.abs((doneAt - t0) - (REGROW.BLOOM_DELAY_MS + riseMs)) <= 1100, 'total ' + (doneAt - t0));
});

test('hold: a cell a tank stands on waits for it to leave, the wall further off still rises slowly', () => {
    reset();
    const under = solidCell(), off = solidCell();
    const t0 = clock; clock += 100_000;
    kill(under, t0); kill(off, t0);
    const tank = { x: under.worldCx + 30, y: under.worldCy, size: 24 };
    const watcher = { x: off.worldCx + 230, y: off.worldCy, size: 24 };
    tanks = [tank, watcher];
    grid._lastRegrowTick = 0;
    run(t0, t0 + REGROW.BASE_DELAY_MS + 4000);
    assert.equal(under.growing || under.alive, false, 'nothing rises under the tank');
    assert.ok(off.growing && off.growRate < REGROW.RISE_RATE, 'a cell beside a tank rises, slowed');
    tank.x += 2000;
    let startedAt = 0;
    run(t0 + REGROW.BASE_DELAY_MS + 4500, t0 + REGROW.BASE_DELAY_MS + 8000, t => { if (!startedAt && under.growing) startedAt = t; });
    assert.ok(startedAt && startedAt <= t0 + REGROW.BASE_DELAY_MS + 5000, 'it rises once the tank has gone');
    tanks = [];
    run(t0 + REGROW.BASE_DELAY_MS + 8500, t0 + REGROW.BASE_DELAY_MS + 30_000);
    assert.ok(under.alive && off.alive);
});

test('near: a tank close by slows the rise, leaving picks it back up, clients follow exactly', () => {
    reset();
    const rock = solidCell();
    const t0 = clock; clock += 100_000;
    rock.diedAt = 0; rock.alive = false; rock.health = 0;
    fakeNow = t0;
    grid.startRegrow(rock, t0);
    const tank = { x: rock.worldCx + 200, y: rock.worldCy, size: 24 };
    tanks = [tank];
    // a client record made from the events, as terrainRenderer builds it
    // (received the instant they were sent; latency just shifts both)
    let g = null;
    const feed = (t) => {
        for (const e of grid.rockEvents.splice(0)) {
            if (e.k !== rock.k) continue;
            if (e.r === 1) g = { at: t, e0: e.e, rate: clientRate(e.s) };
            else if (e.r === 3 && g) { g.e0 = e.e; g.at = t; g.rate = clientRate(e.s); }
        }
    };
    const check = (t) => {
        const srv = grid.growthProgress(rock, t);
        const cli = Math.min(1, Math.max(0, clientRise(g, t) / CLIENT_GROW_MS));
        assert.ok(Math.abs(srv - cli) < 1 / 400, 'client ' + cli.toFixed(4) + ' vs server ' + srv.toFixed(4) + ' at +' + (t - t0));
    };
    grid._lastRegrowTick = 0;
    feed(t0);
    let slowSeen = false, doneAt = 0;
    for (let t = t0; t <= t0 + 25_000; t += REGROW.PACING_MS) {
        const pre = rock.growing ? grid.riseElapsed(rock, t) : 0;
        tick(t);
        if (rock.growing) assert.ok(Math.abs(grid.riseElapsed(rock, t) - pre) < 1e-6, 'a pace change never jumps the shape');
        feed(t);
        if (rock.growing) {
            if (rock.growRate < REGROW.RISE_RATE) slowSeen = true;
            check(t); check(t + 170); check(t + 330);
        } else if (!doneAt) doneAt = t;
    }
    assert.ok(slowSeen);
    const rise = doneAt - t0;
    const slowRise = REGROW.RISE_MS / REGROW.NEAR_RATE;
    assert.ok(rise >= slowRise && rise < slowRise + 600, 'slower with a tank near: ' + rise);

    // a second rock: the tank leaves halfway, the rest runs at full pace
    const r2 = solidCell();
    const t1 = clock; clock += 100_000;
    r2.diedAt = 0; r2.alive = false; r2.health = 0;
    tank.x = r2.worldCx - 150; tank.y = r2.worldCy + 120;
    grid.rockEvents.length = 0;
    fakeNow = t1;
    grid.startRegrow(r2, t1);
    grid._lastRegrowTick = 0;
    let done2 = 0;
    for (let t = t1; t <= t1 + 25_000; t += REGROW.PACING_MS) {
        if (t === t1 + 8000) { tank.x = r2.worldCx + 290; tank.y = r2.worldCy; }
        if (t === t1 + 9000) assert.ok(r2.growRate < REGROW.RISE_RATE, 'hysteresis: still slow just past NEAR_R');
        if (t === t1 + 9000) { tank.x = r2.worldCx + 2000; }
        tick(t);
        if (!done2 && !r2.growing) done2 = t;
    }
    const s = grid.rockEvents.filter(e => e.k === r2.k && e.r === 3).map(e => e.s);
    assert.deepEqual(s, [Math.round(REGROW.RISE_RATE * REGROW.NEAR_RATE * 1e4) / 1e4, REGROW.RISE_RATE], 'one slow down and one speed up on the wire');
    const want = 9000 + (REGROW.GROW_MS - 9000 * REGROW.RISE_RATE * REGROW.NEAR_RATE) / REGROW.RISE_RATE;
    assert.ok(Math.abs((done2 - t1) - want) <= 600, 'rose in ' + (done2 - t1) + ', want ~' + Math.round(want));

    // join mid-rise: the snapshot carries the pace too
    const r3 = solidCell();
    r3.diedAt = 0; r3.alive = false; r3.health = 0;
    const t2 = clock; clock += 100_000;
    tanks = [{ x: r3.worldCx, y: r3.worldCy + 100, size: 20 }];
    fakeNow = t2;
    grid.startRegrow(r3, t2);
    grid._lastRegrowTick = 0;
    tick(t2 + 3000);
    const snap = grid.rockStateSnapshot().find(e => e.k === r3.k);
    assert.ok(snap && Math.abs(snap.s - REGROW.RISE_RATE * REGROW.NEAR_RATE) < 1e-9, 'pace in the join snapshot');
    const jg = { at: t2 + 3000, e0: snap.r, rate: clientRate(snap.s) };
    const tq = t2 + 7000;
    assert.ok(Math.abs(clientRise(jg, tq) / CLIENT_GROW_MS - grid.growthProgress(r3, tq)) < 1 / 400);
});

test('fast: a wipe or Bulwark rise runs at full pace and ignores the tank next to it', () => {
    reset();
    const rock = solidCell();
    const t0 = clock; clock += 100_000;
    rock.diedAt = 0; rock.alive = false; rock.health = 0;
    tanks = [{ x: rock.worldCx + 60, y: rock.worldCy, size: 24 }];
    fakeNow = t0;
    grid.startRegrow(rock, t0, 0, { fast: true });
    const ev = events(rock.k).find(e => e.r === 1);
    assert.equal(ev.s, REGROW.FAST_RATE);
    grid._lastRegrowTick = 0;
    let doneAt = 0;
    run(t0, t0 + 12_000, t => { if (!doneAt && rock.alive) doneAt = t; });
    assert.ok(doneAt - t0 >= REGROW.RISE_MS && doneAt - t0 < REGROW.RISE_MS + 600, 'rose in ' + (doneAt - t0));
    assert.ok(!events(rock.k).some(e => e.r === 3), 'never slowed');
});

test('cheap: 300 tanks and 200 rising rocks, one pass well under a ms or two', () => {
    reset();
    const rising = [];
    for (const r of grid.rocks.values()) {
        if (rising.length >= 200) break;
        if (!r.alive || r.canyon || !r.worldPoly) continue;
        rising.push(r);
    }
    const saved = rising.map(r => ({ r, alive: r.alive, health: r.health, ore: r.ore, maxHealth: r.maxHealth, deposits: r.deposits, gen: r.gen }));
    const t0 = clock; clock += 100_000;
    for (const r of rising) { r.alive = false; r.health = 0; r.diedAt = 0; grid.startRegrow(r, t0); }
    for (let i = 0; i < 300; i++) tanks.push({ x: (Math.random() - 0.5) * 5000, y: (Math.random() - 0.5) * 5000, size: 24 });
    const n = 40;
    const a = process.hrtime.bigint();
    for (let i = 0; i < n; i++) grid._slowNearTanks(t0 + i * 500);
    const ms = Number(process.hrtime.bigint() - a) / 1e6 / n;
    assert.ok(ms < 2, 'one pass took ' + ms.toFixed(3) + ' ms');
    // put the map back
    for (const s of saved) {
        grid._unlistGrowing(s.r);
        Object.assign(s.r, { alive: s.alive, health: s.health, growing: false, ore: s.ore, maxHealth: s.maxHealth, deposits: s.deposits });
    }
    grid.rockEvents.length = 0;
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
