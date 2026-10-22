// Mining combo: rocks only, capped at +25%: node scripts/test/miningCombo.test.js
//
// The chain used to be extended by every gem pickup and paid up to +100% on
// loose gems too. It now comes from destroying rock, and its bonus is paid on
// that rock's payout. The fifth rock in a chain is the first at the +25% cap.
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
global.Config = { dig_royale: true };
const gems = require(path.join(SERVER, 'game', 'terrain', 'gems.js'));
const ORE = { COPPER: 1, VEIN: 2, SHARD: 3, EMERALD: 4 };

const spawned = [];
const oldEntity = global.Entity, oldProp = global.Prop, oldTeam = global.TEAM_ROOM, oldNow = Date.now;
global.TEAM_ROOM = -100;
global.Entity = class {
    constructor(p) { this.x = p.x; this.y = p.y; this.velocity = { x: 0, y: 0 }; spawned.push(this); }
    define() {}
    refreshBodyAttributes() {}
};
global.Prop = class { define() {} };
Date.now = () => 1_000_000;
Config.dig_royale = true;

try {
    assert.equal(gems.COMBO_STEP, 0.1);
    assert.equal(gems.COMBO_CAP, 0.25);

    const breaker = { id: 9, x: 100, y: 0, carriedGems: 0, gemCap: 8000 };
    const rock = () => ({ ore: ORE.COPPER, soft: true, wx: 0, wy: 0,
        deposits: [{ wx: 0, wy: 0, wr: 9, big: false }] });
    const base = gems.payoutOf(rock(), breaker);
    const expect = [0, 0.1, 0.2, 0.25, 0.25];

    for (let i = 0; i < expect.length; i++) {
        spawned.length = 0;
        gems.spawnOreBurst(rock(), breaker);
        const got = spawned.reduce((n, g) => n + g.gemValue, 0);
        assert.equal(breaker._comboN, i + 1, 'rock ' + (i + 1) + ' extends the chain');
        assert.equal(got, Math.round(base * (1 + expect[i])), 'rock ' + (i + 1) + ' bonus');
    }

    // a loose gem is collected at full value and leaves the chain alone
    const body = {
        id: 77, x: 0, y: 0, realSize: 20, team: 0, velocity: { x: 0, y: 0 },
        carriedGems: 0, gemCap: 8000, isDead: () => false,
        refreshBodyAttributes() {},
    };
    body._comboN = 3;
    body._comboUntil = Date.now() + 2500;
    const loose = {
        x: 0, y: 0, realSize: 5, velocity: { x: 0, y: 0 }, gemValue: 100,
        gemOre: ORE.COPPER, gemBornAt: Date.now(), gemRestAt: Date.now(),
        kill() { this.dead = true; }, isDead() { return !!this.dead; },
    };
    gems.tickGem(loose, {}, [body]);
    assert.equal(body.carriedGems, 100, 'the loose gem paid its own value, no chain bonus');
    assert.equal(body._comboN, 3, 'collecting a loose gem did not extend the chain');
    assert.ok(loose.dead, 'it was picked up');

    // an expired chain is not sent to the meter as if it were still running
    const packets = [];
    const live = { socket: { gemBanked: 0, bankKept: 0, talk: (...a) => packets.push(a) },
        carriedGems: 0, gemCap: 8000, _comboN: 4 };
    live._comboUntil = Date.now() - 1;
    gems.talkGems(live, 0);
    assert.equal(packets[packets.length - 1][6], 0, 'expired chain: meter off');
    live._comboUntil = Date.now() + 2500;
    gems.talkGems(live, 0);
    assert.equal(packets[packets.length - 1][6], 4, 'live chain: meter on');
} finally {
    global.Entity = oldEntity; global.Prop = oldProp; global.TEAM_ROOM = oldTeam;
    Date.now = oldNow;
}

console.log('all passed');
process.exit(0);
