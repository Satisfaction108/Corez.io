// Raid storm schedule tests: node scripts/test/stormRaid.test.js
//
//   cycles     every cycle is 7 min (6 shrink + 1 hold), twist or not, so a
//              4-cycle raid is exactly 28 min and ends on a cycle boundary
//   twist      Fast Storm shrinks in 3.3 min and the hold takes the rest
//   final      the last cycle does not reset: its hold closes from 20% to 7%
//              of the map and the storm stays shut after the end
//   lock       the spawn lock covers 20 s of a cycle, 30 s of the last one,
//              and lifts once the raid is over
//   debug      DBG raidleft lands in the last cycle with N seconds to go
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'server');
global.Config = { dig_royale: true };
global.entities = new Map();

const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
const MIN = 60 * 1000;

let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fresh(mods) {
    global.royaleMods = mods || {};
    clock = 1_000_000;
    storm.setCycles(4);
    storm.setLockMs(20_000);
    storm.start();
}

test('cycles: 7 min each, the raid is 4 of them', () => {
    fresh();
    assert.equal(storm.CYCLE_MS, 7 * MIN);
    assert.equal(storm.shrinkMs(), 6 * MIN);
    assert.equal(storm.holdMs(), 1 * MIN);
    assert.equal(storm.endAt() - clock, 28 * MIN);
    const t0 = clock;
    for (let c = 0; c < 4; c++) {
        clock = t0 + c * 7 * MIN + 1000;
        const s = storm.snapshot(clock);
        assert.equal(s.c, c, 'cycle ' + c);
        assert.equal(s.fin, c === 3 ? 1 : 0);
        assert.equal(s.cn, 4);
    }
    // the cycles start exactly on the boundaries, even when the roll is seen late
    fresh();
    clock = t0 + 14 * MIN + 250;
    storm.snapshot(clock);
    clock = t0 + 21 * MIN - 1;
    assert.equal(storm.snapshot(clock).c, 2);
    clock = t0 + 21 * MIN;
    assert.equal(storm.snapshot(clock).c, 3);
});

test('twist: fast storm keeps the cycle length', () => {
    fresh({ stormShrinkMult: 0.55 });
    assert.equal(storm.shrinkMs(), Math.round(6 * MIN * 0.55));
    assert.equal(storm.shrinkMs() + storm.holdMs(), 7 * MIN);
    assert.equal(storm.endAt() - clock, 28 * MIN);
    // a twist that stretches the hold takes it out of the shrink
    global.royaleMods = { stormHoldMult: 2 };
    assert.equal(storm.holdMs(), 2 * MIN);
    assert.equal(storm.shrinkMs(), 5 * MIN);
    // switching twists at every cycle still lands the raid on the same end
    fresh();
    const t0 = clock;
    const plan = [{}, { stormShrinkMult: 0.55 }, { stormHoldMult: 2 }, { stormShrinkMult: 0.55 }];
    for (let c = 0; c < 4; c++) {
        clock = t0 + c * 7 * MIN;
        storm.snapshot(clock);
        global.royaleMods = plan[c];
        clock += 3 * MIN;
        assert.equal(storm.snapshot(clock).c, c);
    }
    clock = t0 + 28 * MIN - 1;
    assert.equal(storm.cyclePhase(clock), 'hold');
    clock = t0 + 28 * MIN;
    assert.equal(storm.cyclePhase(clock), 'done');
});

test('final: the last hold closes to the small circle and stays shut', () => {
    fresh();
    const t0 = clock, maxR = storm.snapshot(clock).max;
    clock = t0 + 7 * MIN - 1;
    assert.ok(Math.abs(storm.radius(clock) - maxR * storm.MIN_FRAC) < 1, 'a normal hold sits at 20%');
    clock = t0 + 27 * MIN;
    assert.ok(Math.abs(storm.radius(clock) - maxR * storm.MIN_FRAC) < 1, 'the last hold starts at 20%');
    clock = t0 + 27.5 * MIN;
    const mid = storm.radius(clock);
    assert.ok(mid < maxR * storm.MIN_FRAC && mid > maxR * storm.FINAL_FRAC, 'closing');
    clock = t0 + 28 * MIN;
    assert.ok(Math.abs(storm.radius(clock) - maxR * storm.FINAL_FRAC) < 1, 'shut at 7%');
    clock = t0 + 29 * MIN;
    const s = storm.snapshot(clock);
    assert.equal(s.c, 3, 'no fifth cycle');
    assert.ok(Math.abs(s.r - maxR * storm.FINAL_FRAC) < 1);
});

test('lock: 20 s per cycle, 30 s at the end, off after it', () => {
    fresh();
    const t0 = clock;
    clock = t0 + 7 * MIN - 21_000;
    assert.equal(storm.locked(clock), false);
    clock = t0 + 7 * MIN - 19_000;
    assert.equal(storm.locked(clock), true);
    clock = t0 + 28 * MIN - 31_000;
    storm.snapshot(clock);
    assert.equal(storm.locked(clock), false);
    clock = t0 + 28 * MIN - 29_000;
    assert.equal(storm.locked(clock), true);
    clock = t0 + 28 * MIN + 500;
    assert.equal(storm.locked(clock), false);
});

test('debug: raidleft jumps into the last cycle', () => {
    fresh();
    clock += 3 * MIN;
    const end = storm.debugFinal(40);
    assert.equal(end, clock + 40_000);
    const s = storm.snapshot(clock);
    assert.equal(s.c, 3);
    assert.equal(s.fin, 1);
    assert.equal(s.hold, 1);
    assert.equal(s.lock, 0);
    clock += 15_000;
    assert.equal(storm.locked(clock), true);
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
Date.now = realNow;
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
