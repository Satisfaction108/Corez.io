// Growth mode tests: node scripts/test/growth.test.js
//
//   curve      size from raid score: smooth, rising, 2.3x at the respawn cap
//              score, bending toward the live ceiling past it
//   spawn      a respawn comes back at its score's size, never above 2.3x
//   life       only this life's earnings grow past 2.3x; size never shrinks
//              inside a life; a stage crossing calls back once
//   perks      slower, tougher, harder rams, camera opens up less than arras'
//   off        royale_growth false: nothing grows
//   rammer     smasher-family caps give Mining Power 12 and the points past 9
//              still dig
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'server');
global.Config = { dig_royale: true, royale_growth: true, tutorial: false, skill_cap: 9 };

const growth = require(path.join(SERVER, 'game', 'terrain', 'growth.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fakeBody() {
    return {
        growthMult: 1, sizeMultiplier: 1, refreshed: 0,
        topSpeed: 1, acceleration: 1, damage: 1,
        health: { max: 100, set(v) { this.max = v; } },
        refreshBodyAttributes() { this.refreshed++; },
        isDead: () => false,
    };
}
// run the growth tick until the size settles on its target
function settle(body, score, onStage) {
    let t = settle.t = (settle.t || 1e6) + 1e5;
    let i = 0;
    do growth.tick(t += 33, [body], () => score, onStage);
    while (body.growthMult !== body._growTarget && ++i < 400);
}

test('curve', () => {
    assert.equal(growth.multFor(0), 1);
    let prev = 1;
    for (let s = 100; s <= 200000; s *= 1.3) {
        const g = growth.multFor(s);
        assert.ok(g > prev, 'rises at ' + s);
        assert.ok(g < growth.LIVE_CEIL, 'under the ceiling at ' + s);
        prev = g;
    }
    assert.ok(Math.abs(growth.multFor(growth.CAP_SCORE) - growth.RESPAWN_CAP) < 1e-9);
    assert.ok(growth.CAP_SCORE > 9000 && growth.CAP_SCORE < 11000);
    assert.ok(growth.multFor(1000) > 1.25, 'the first kills show');
    assert.ok(growth.multFor(1e7) > 3.2);
});

test('spawn', () => {
    const a = fakeBody();
    growth.onSpawn(a, 3000);
    assert.equal(a.growthMult, growth.multFor(3000));
    assert.equal(a.sizeMultiplier, a.growthMult);
    assert.ok(a.refreshed >= 1);
    const b = fakeBody();
    growth.onSpawn(b, 60000);
    assert.equal(b.growthMult, growth.RESPAWN_CAP);
    const c = fakeBody();
    growth.onSpawn(c, 0);
    assert.equal(c.growthMult, 1);
});

test('life', () => {
    const b = fakeBody();
    growth.onSpawn(b, 60000);
    const stages = [];
    // same score: stays at the cap
    settle(b, 60000);
    assert.equal(b.growthMult, growth.RESPAWN_CAP);
    // 12000 earned this life: grows on from the cap, as if from CAP_SCORE
    settle(b, 72000, (body, st) => stages.push(st));
    assert.ok(Math.abs(b.growthMult - growth.multFor(growth.CAP_SCORE + 12000)) < 1e-9);
    assert.ok(b.growthMult > growth.RESPAWN_CAP);
    assert.deepEqual(stages, [2.6]);
    // the score drops (carried gems spent or lost): no shrinking
    const g = b.growthMult;
    settle(b, 68000);
    assert.equal(b.growthMult, g);
    // and a later gain counts from the lower score
    settle(b, 69000);
    assert.ok(Math.abs(b.growthMult - growth.multFor(growth.CAP_SCORE + 13000)) < 1e-9);
});

test('ease', () => {
    const b = fakeBody();
    growth.onSpawn(b, 0);
    growth.tick(2e6, [b], () => 20000);
    growth.tick(2e6 + 33, [b], () => 20000);
    assert.ok(b.growthMult > 1 && b.growthMult < b._growTarget, 'grows over a moment, not in one frame');
    const before = b.refreshed;
    settle(b, 20000);
    assert.ok(b.refreshed - before < 60, 'stats refresh in steps, not every tick');
    assert.equal(b.growthMult, b._growTarget);
});

test('perks', () => {
    const b = fakeBody();
    b.growthMult = 2.3;
    growth.applyPerks(b);
    assert.ok(b.topSpeed < 0.8 && b.topSpeed > 0.65);
    assert.ok(Math.abs(b.health.max - 165) < 1e-9);
    assert.ok(b.damage > 1.4 && b.damage < 1.5);
    const view = Math.sqrt(2.3) * growth.fovMult(2.3);
    assert.ok(view > 1.2 && view < Math.sqrt(2.3));
    const n = fakeBody();
    growth.applyPerks(n);
    assert.equal(n.topSpeed, 1);
    assert.equal(n.health.max, 100);
});

test('off', () => {
    Config.royale_growth = false;
    try {
        const b = fakeBody();
        growth.onSpawn(b, 50000);
        assert.equal(b.growthMult, 1);
        growth.tick(3e6, [b], () => 50000);
        assert.equal(b.growthMult, 1);
    } finally { Config.royale_growth = true; }
    Config.tutorial = true;
    try { assert.equal(growth.enabled(), false); } finally { Config.tutorial = false; }
});

test('rammer', () => {
    global.Class = {};
    require(path.join(SERVER, 'lib', 'definitions', 'groups', 'generics.js'));
    const caps = Class.genericSmasher.SKILL_CAP;
    assert.equal(caps.MINING_POWER, 12);
    assert.equal(caps.BODY_DAMAGE, 12);
    assert.equal(caps.BULLET_DAMAGE, 0);
    // the last points of a 12-point bar are not dead
    const mining = require(path.join(SERVER, 'game', 'terrain', 'mining.js'));
    const owner = (pts, cap) => ({ skill: { raw: [0, 0, 0, 0, 0, 0, 12, 0, 0, 0, pts], caps: [12, 0, 0, 0, 0, 12, 12, 12, 12, 12, cap] }, guns: new Map() });
    const f9 = mining.skillFactor(owner(9, 12)), f12 = mining.skillFactor(owner(12, 12));
    assert.ok(f12 > f9, 'points 10-12 dig');
    // a normal 9-cap tank maxed is unchanged: 2.0x
    assert.ok(Math.abs(mining.skillFactor(owner(9, 9)) - 2.0) < 1e-9);
    assert.ok(mining.grindSecondsFor(owner(12, 12)) < mining.grindSecondsFor(owner(9, 12)));
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
