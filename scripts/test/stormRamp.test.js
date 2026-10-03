// Storm damage ramp tests: node scripts/test/stormRamp.test.js
//
// Storm damage grows with how long a tank has been out in the storm, so a
// new player who wanders out gets a warning before it gets serious.
//
//   warning    the first 5 s cost only a few percent of health
//   ramp       full damage (7% a hit) by 18 s, 1.6x of that from 30 s on
//   reset      a short dip back inside holds the ramp, 3 s inside resets it
//   cloak      Storm Cloak halves every hit, the ramp still climbs
//   anchor     Storm Anchor (and the medkit) stop the damage and pause the ramp
//   final      the last storm's closing hold skips the warning, ramps 3x
//              faster and hits 1.35x harder, so it kills faster than the old
//              flat damage did
//   stages     storm 1 hits at half strength, storm 2 at 0.8, later ones full
//   spawn      a fresh spawn's shield still keeps the storm off
//   entity     a real tank in the game loop dies of it, logged as "storm"
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

// the loader and definition combiner log every file they touch
const log = console.log;
console.log = () => {};
try {
    require(path.join(SERVER, 'loaders', 'loader.js'));
    new definitionCombiner({
        groups: path.join(SERVER, 'lib', 'definitions', 'groups'),
        addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons'),
    }).loadDefinitions();
} finally { console.log = log; }

const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
global.gameManager = {
    room: { width: 6000, height: 6000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;

const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));

const TICK = 1000 / 30;
let clock = 5_000_000;
const realNow = Date.now;
Date.now = () => clock;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const fakes = [];
function fresh(mods) {
    global.royaleMods = mods || {};
    for (const f of fakes.splice(0)) entities.delete(f.id);
    clock += 60 * 60 * 1000;
    storm.setCycles(4);
    storm.setLockMs(20_000);
    storm.start();
}
let fakeId = 1e7;
// a plain combatant: 100 health, no shield, standing where told
function body(x, y, extra) {
    const b = Object.assign({
        id: fakeId++, isPlayer: true, x, y,
        health: { amount: 100, max: 100 }, shield: { amount: 0, max: 0 },
        isDead() { return this.health.amount <= 0; },
    }, extra || {});
    entities.set(b.id, b);
    fakes.push(b);
    return b;
}
// far outside the full-size circle (it's 3000 across a 6000 room)
const OUT = 5200;
function run(ms, onTick) {
    const end = clock + ms;
    while (clock < end) {
        clock += TICK;
        storm.tickDamage(clock);
        if (onTick && onTick() === false) break;
    }
}
function lost(b) { return 100 - b.health.amount; }
// seconds outside until a 100-health, unshielded body dies
function timeToDeath(setupBody) {
    const b = setupBody();
    const t0 = clock;
    run(120_000, () => b.health.amount > 0);
    return (clock - t0) / 1000;
}

test('warning: the first 5 s barely scratch', () => {
    fresh();
    const b = body(OUT, 0);
    run(5000);
    assert.ok(b._inStorm, 'it is out in the storm');
    assert.ok(lost(b) > 0, 'it does hurt');
    assert.ok(lost(b) < 6, 'under 6% in 5 s, lost ' + lost(b).toFixed(2));
    // the old flat 7% a hit took 35% in the same time
});

test('ramp: full damage by 18 s, more than that from 30 s', () => {
    fresh();
    assert.equal(storm.rampMult(0), 0.12);
    assert.equal(storm.rampMult(18), 1);
    assert.equal(storm.rampMult(30), storm.RAMP_MAX);
    assert.equal(storm.rampMult(90), storm.RAMP_MAX);
    // eased, never falls back
    let prev = 0;
    for (let s = 0; s <= 40; s += 0.25) {
        const m = storm.rampMult(s);
        assert.ok(m >= prev - 1e-9, 'rises at ' + s);
        prev = m;
    }
    const b = body(OUT, 0, { health: { amount: 1e9, max: 100 } });
    const hits = [];
    let last = b.health.amount;
    run(40_000, () => { if (b.health.amount < last) { hits.push({ t: storm.exposureOf(b).sec, d: last - b.health.amount }); last = b.health.amount; } });
    const at = s => hits.find(h => h.t >= s);
    // the first storm is the gentle stage
    const S = storm.stageMult();
    assert.equal(S, storm.STAGE_MULT[0]);
    assert.ok(Math.abs(hits[0].d - 7 * 0.12 * S) < 0.01, 'first hit is 12% of a full one: ' + hits[0].d);
    assert.ok(Math.abs(at(18).d - 7 * S) < 0.3, 'about 7 at 18 s: ' + at(18).d);
    assert.ok(Math.abs(at(31).d - 7 * storm.RAMP_MAX * S) < 0.01, '1.6x from 30 s: ' + at(31).d);
    const ttd = timeToDeath(() => body(OUT, 800));
    assert.ok(ttd > 30 && ttd < 45, 'a full-health tank lasts 30-45 s out in the first storm, got ' + ttd);
    ramp.ttd = ttd;
});
const ramp = {};

test('reset: a short dip holds the ramp, 3 s inside resets it', () => {
    fresh();
    const b = body(OUT, 0);
    run(12_000);
    const held = storm.exposureOf(b).sec;
    assert.ok(held > 11.5, 'about 12 s in: ' + held);
    // two seconds back inside: still where it was
    b.x = 0;
    run(2000);
    assert.equal(b._inStorm, false);
    assert.ok(Math.abs(storm.exposureOf(b).sec - held) < 1e-6, 'held while briefly inside');
    b.x = OUT;
    run(500);
    assert.ok(storm.exposureOf(b).sec > held, 'and climbs again from there');
    // three and a half seconds inside: back to the warning
    b.x = 0;
    run(3500);
    assert.equal(storm.exposureOf(b).sec, 0, 'reset');
    b.x = OUT;
    const before = b.health.amount;
    run(TICK);
    assert.ok(Math.abs((before - b.health.amount) - 7 * 0.12 * storm.stageMult()) < 0.01, 'the next hit is a warning one again');
});

test('cloak: every hit halved', () => {
    fresh();
    const plain = body(OUT, 0);
    const cloak = body(OUT, 400, { socket: { shop: { gear: { cloak: true }, kit: {} } } });
    run(20_000);
    assert.ok(Math.abs(lost(cloak) * 2 - lost(plain)) < 0.01, 'half of ' + lost(plain) + ', got ' + lost(cloak));
    assert.ok(Math.abs(storm.exposureOf(cloak).sec - storm.exposureOf(plain).sec) < 1e-6, 'same ramp');
});

test('anchor: no damage and the ramp waits', () => {
    fresh();
    const b = body(OUT, 0, { socket: { shop: { gear: {}, kit: {} } } });
    run(10_000);
    const sec = storm.exposureOf(b).sec, hp = b.health.amount;
    b.stormAnchorUntil = clock + 15_000;
    run(14_000);
    assert.equal(b.health.amount, hp, 'untouched while anchored');
    assert.ok(Math.abs(storm.exposureOf(b).sec - sec) < 1e-6, 'ramp paused');
    run(2000);
    assert.ok(b.health.amount < hp, 'hurts again once it runs out');
});

test('final: the last squeeze ramps faster and still kills', () => {
    fresh();
    storm.debugFinal(55);
    assert.equal(storm.cyclePhase(clock), 'hold');
    assert.equal(storm.snapshot(clock).fin, 1);
    const b = body(OUT, 0, { health: { amount: 1e9, max: 100 } });
    const hp0 = b.health.amount;
    run(TICK);
    assert.ok(hp0 - b.health.amount > 7 * 0.2, 'no warning hit in the final squeeze: ' + (hp0 - b.health.amount));
    run(4500);
    assert.ok(storm.exposureOf(b).mult >= 1.3, 'full damage and then some within ~5 s');
    const ttd = timeToDeath(() => body(OUT, 800));
    assert.ok(ttd < 13, 'dies faster than the old flat 15.4 s, got ' + ttd);
    ramp.finalTtd = ttd;
    // after it shuts the storm stays lethal
    fresh();
    storm.debugFinal(1);
    run(1500);
    assert.equal(storm.cyclePhase(clock), 'done');
    const ttd2 = timeToDeath(() => body(OUT, 1600));
    assert.ok(ttd2 < 13, 'after the end too: ' + ttd2);
});

test('stages: storm 1 stings, storm 2 hurts more, storm 3 is full', () => {
    fresh();
    const per = [];
    for (let cyc = 0; cyc < 3; cyc++) {
        // walk the clock into this cycle's shrink
        while (storm.snapshot(clock).c < cyc) run(5000);
        run(2000);
        assert.equal(storm.snapshot(clock).c, cyc, 'in storm ' + (cyc + 1));
        const b = body(OUT, 0, { health: { amount: 1e9, max: 100 } });
        const hp = b.health.amount;
        run(20_000);
        per.push(hp - b.health.amount);
        entities.delete(b.id);
    }
    assert.ok(per[0] < per[1] && per[1] < per[2], 'each storm hurts more: ' + per.map(d => d.toFixed(1)).join(' < '));
    assert.ok(Math.abs(per[0] / per[2] - storm.STAGE_MULT[0]) < 0.02, 'storm 1 at half: ' + (per[0] / per[2]).toFixed(3));
});

test('spawn: the spawn shield keeps it off', () => {
    fresh();
    const b = body(OUT, 0, { spawnGraceUntil: clock + 4000 });
    run(3900);
    assert.equal(b.health.amount, 100);
    assert.equal(storm.exposureOf(b).sec, 0, 'no ramp during the shield');
    run(2000);
    assert.ok(b.health.amount < 100);
});

test('entity: a real tank dies of the storm, logged as storm', () => {
    fresh();
    const tank = new Entity({ x: OUT, y: -600 });
    tank.define('basic');
    tank.isPlayer = true;
    tank.team = -1;
    tank.name = 'Tester';
    const msgs = [];
    tank.sendMessage = m => msgs.push(m);
    tank.alwaysActive = true;
    let dead = 0;
    tank.on('dead', () => dead++);
    handler.gameloop();
    const max = tank.health.max;
    assert.ok(max > 0);
    const t0 = clock;
    let lostIn5 = -1;
    for (let i = 0; i < 30 * 90 && !tank.isDead(); i++) {
        clock += TICK;
        storm.tickDamage(clock);
        handler.gameloop();
        if (lostIn5 < 0 && clock - t0 >= 5000) lostIn5 = 1 - tank.health.amount / max;
    }
    handler.gameloop();
    assert.ok(tank.isDead(), 'the storm finished it');
    assert.equal(tank.deathCause, 'storm');
    assert.equal(dead, 1, 'one death');
    assert.ok(msgs.includes('The storm closed in.'));
    assert.ok(lostIn5 >= 0 && lostIn5 < 0.08, 'barely hurt in the first 5 s: ' + lostIn5);
    ramp.tankTtd = (clock - t0) / 1000;
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
Date.now = realNow;
if (ramp.ttd) console.log(`     time to die from full health: ${ramp.ttd.toFixed(1)} s (final squeeze ${(ramp.finalTtd || 0).toFixed(1)} s, a real Basic with its shield ${(ramp.tankTtd || 0).toFixed(1)} s)`);
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
