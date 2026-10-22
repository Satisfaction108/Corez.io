// One gem, one readable number: node scripts/test/gemValueCap.test.js
//
// Rich Veins, biome toughness and the storm used to multiply into a single
// gem, so one emerald could read 1.8k+. The payout is now split into gems of
// at most twice the ore's base value; the rock still pays the same total.
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const gems = require(path.join(SERVER, 'game', 'terrain', 'gems.js'));
const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
const ORE = { COPPER: 1, VEIN: 2, SHARD: 3, EMERALD: 4 };

assert.deepEqual(gems.GEM_VALUE_CAP, { 1: 30, 2: 60, 3: 300, 4: 1000 });

const spawned = [];
const E = global.Entity, P = global.Prop, T = global.TEAM_ROOM;
global.TEAM_ROOM = -100;
global.Entity = class {
    constructor(p) {
        this.x = p.x; this.y = p.y;
        this.velocity = { x: 0, y: 0 };
        spawned.push(this);
    }
    define(cls) { this.cls = cls; }
    refreshBodyAttributes() {}
};
global.Prop = class { define() {} };
const oldStage = storm.gemStageMult;
const oldNow = Date.now;
Date.now = () => 1_000_000;
const freshBreaker = () => ({ id: 7, x: 100, y: 0, _pkfx: { value: 1.48 } });

try {
    storm.gemStageMult = () => 2;
    let breaker = freshBreaker();
    const rock = {
        ore: ORE.EMERALD, soft: false, biome: 5, bHard: 1.5,
        wx: 0, wy: 0,
        deposits: [{ wx: 0, wy: 0, wr: 22, big: true }],
    };
    const total = gems.payoutOf(rock, breaker);
    gems.spawnOreBurst(rock, breaker);
    const sum = spawned.reduce((n, g) => n + g.gemValue, 0);
    assert.equal(sum, total, 'the rock pays the same total');
    assert.ok(total > 2_000, 'the test rock is stacked: ' + total);
    assert.equal(spawned.length, 3, '1800+ pays as three capped gems');
    assert.ok(spawned.every(g => g.gemValue <= 1000), 'no single gem over 2x base');
    assert.equal(spawned[0].cls, 'gemPickupEmeraldCore', 'the big first piece keeps the emerald core look');
    assert.ok(spawned.slice(1).every(g => g.cls === 'gemPickupEmerald'), 'overflow pieces are normal emeralds');
    assert.ok(spawned.every(g => g.gemSourceId === 7), 'all pieces fly to the breaker');
    assert.ok(new Set(spawned.map(g => Math.round(g.x) + ':' + Math.round(g.y))).size > 1, 'pieces are spread out');

    // copper: 15 base, 30 cap, a little overflow (fresh chain: no combo yet)
    spawned.length = 0;
    breaker = freshBreaker();
    const copper = {
        ore: ORE.COPPER, soft: false, biome: 5, bHard: 1.5,
        wx: 0, wy: 0,
        deposits: [{ wx: 0, wy: 0, wr: 14, big: false }],
    };
    const cTotal = gems.payoutOf(copper, breaker);
    gems.spawnOreBurst(copper, breaker);
    assert.equal(spawned.reduce((n, g) => n + g.gemValue, 0), cTotal);
    assert.ok(spawned.every(g => g.gemValue <= 30), 'copper cap');
    assert.ok(spawned.length >= 2, 'overflow became another copper gem');

    // the storm is still worth something: same cap, more gems (each break
    // starts a fresh chain so the combo bonus does not muddy the comparison)
    storm.gemStageMult = () => 1;
    spawned.length = 0;
    breaker = freshBreaker();
    const calm = gems.payoutOf(rock, breaker);
    gems.spawnOreBurst(rock, breaker);
    const calmN = spawned.length;
    storm.gemStageMult = () => 2;
    spawned.length = 0;
    breaker = freshBreaker();
    const hot = gems.payoutOf(rock, breaker);
    gems.spawnOreBurst(rock, breaker);
    assert.ok(hot > calm && spawned.length > calmN, 'storm pays more total and more gems');
} finally {
    global.Entity = E; global.Prop = P; global.TEAM_ROOM = T;
    storm.gemStageMult = oldStage;
    Date.now = oldNow;
}

console.log('all passed');
process.exit(0);
