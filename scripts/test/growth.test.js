// Growth mode tests: node scripts/test/growth.test.js
//
//   curve      size from growth score: smooth, rising, 2x at the respawn cap
//              score, bending toward the live ceiling past 2.3x
//   spawn      a respawn comes back at the size a quarter of its score
//              earns, never above 2x; a reconnect keeps its growth score
//   life       this life's earnings add onto the spawn's growth score, with
//              no jump; size never shrinks inside a life; a stage crossing
//              calls back once
//   perks      slower; health and damage creep up to 1.6x at a 100k score;
//              the view follows size^0.45 up to its cap
//   damage     a grown tank's shots (and a grown bot's) hit harder, rock
//              digging and its budget rise by the same factor
//   bots       a bot grows from twice its score (growth only, not the board)
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
        prev = g;
    }
    assert.equal(growth.RESPAWN_CAP, 2);
    assert.ok(Math.abs(growth.multFor(growth.CAP_SCORE) - growth.RESPAWN_CAP) < 1e-9);
    // 2x comes about a quarter sooner than the old 5656
    assert.ok(growth.CAP_SCORE > 3800 && growth.CAP_SCORE < 5656 * 0.76, 'cap score ' + growth.CAP_SCORE);
    // no ceiling, and it keeps going: each doubling past 2x adds more than the last
    const d1 = growth.multFor(40000) - growth.multFor(20000), d2 = growth.multFor(80000) - growth.multFor(40000);
    assert.ok(d1 > 0.4 && d2 > d1, 'steady tail ' + d1 + ' ' + d2);
    // no kink where the log hands over to the tail
    const at = growth.CAP_SCORE;
    assert.ok(Math.abs((growth.multFor(at + 10) - growth.multFor(at)) - (growth.multFor(at) - growth.multFor(at - 10))) < 1e-4, 'smooth join');
    assert.ok(growth.multFor(1000) > 1.25, 'the first kills show');
    assert.ok(growth.multFor(1e6) > 5, 'no cap');
});

test('spawn', () => {
    const a = fakeBody();
    growth.onSpawn(a, 12000);
    assert.equal(a._growEff, 3000);
    assert.equal(a.growthMult, growth.multFor(3000));
    assert.ok(a.growthMult < growth.multFor(12000));
    assert.equal(a.sizeMultiplier, a.growthMult);
    assert.ok(a.refreshed >= 1);
    // a quarter of the cap score is not enough for the cap
    const q = fakeBody();
    growth.onSpawn(q, growth.CAP_SCORE);
    assert.ok(q.growthMult > 1.3 && q.growthMult < 1.6);
    const b = fakeBody();
    growth.onSpawn(b, 60000);
    assert.equal(b.growthMult, growth.RESPAWN_CAP);
    assert.equal(b._growEff, growth.CAP_SCORE);
    const c = fakeBody();
    growth.onSpawn(c, 0);
    assert.equal(c.growthMult, 1);
    // a reconnect carries the growth score it had, cap or not
    const r = fakeBody();
    growth.onSpawn(r, 60000, 20000);
    assert.equal(r.growthMult, growth.multFor(20000));
    assert.ok(r.growthMult > growth.RESPAWN_CAP);
});

test('life', () => {
    const b = fakeBody();
    growth.onSpawn(b, 60000);
    const stages = [];
    // same score: stays at the cap
    settle(b, 60000);
    assert.equal(b.growthMult, growth.RESPAWN_CAP);
    // 8000 earned this life: grows on from the cap, as if from CAP_SCORE
    settle(b, 68000, (body, st) => stages.push(st));
    assert.ok(Math.abs(b.growthMult - growth.multFor(growth.CAP_SCORE + 8000)) < 1e-9);
    assert.ok(b.growthMult > growth.RESPAWN_CAP);
    assert.deepEqual(stages, [2.3]);
    // the score drops (carried gems spent or lost): no shrinking
    const g = b.growthMult;
    settle(b, 65000);
    assert.equal(b.growthMult, g);
    // and a later gain counts from the lower score
    settle(b, 66000);
    assert.ok(Math.abs(b.growthMult - growth.multFor(growth.CAP_SCORE + 9000)) < 1e-9);
    // under the cap: a quarter at spawn, then every point counts in full
    const u = fakeBody();
    growth.onSpawn(u, 8000);
    const g0 = u.growthMult;
    settle(u, 8000);
    assert.equal(u.growthMult, g0, 'no jump on the first tick of a life');
    settle(u, 8100);
    assert.ok(u.growthMult > g0 && u.growthMult - g0 < 0.025, 'a small gain is a small step');
    settle(u, 9000);
    assert.ok(Math.abs(u.growthMult - growth.multFor(2000 + 1000)) < 1e-9);
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
    // health and ram damage grow slowly: about 1.27x at 2.3x, 1.6x at a 100k score
    assert.ok(b.health.max > 120 && b.health.max < 135, 'health ' + b.health.max);
    assert.ok(b.damage > 1.2 && b.damage < 1.35, 'ram ' + b.damage);
    assert.ok(Math.abs(growth.healthMult(growth.multFor(100000)) - 1.6) < 1e-9);
    assert.ok(Math.abs(growth.damageMult(growth.multFor(100000)) - 1.6) < 1e-9);
    assert.ok(growth.healthMult(growth.multFor(1e6)) < 2.6, "slow past 100k too");
    let prev = 1;
    for (let s = 500; s <= 200000; s *= 2) {
        const h = growth.healthMult(growth.multFor(s));
        assert.ok(h > prev, 'rises at ' + s);
        prev = h;
    }
    // the view: arras' sqrt(size) times fovMult, size^0.45 up to VIEW_MAX, slower
    // than the tank grows so growing shows on screen
    const view = g => Math.sqrt(g) * growth.fovMult(g);
    assert.ok(Math.abs(view(2.3) - Math.pow(2.3, 0.45)) < 1e-9);
    assert.ok(view(2.3) > 1.4, 'a 2.3x tank sees clearly more');
    assert.ok(2.3 / view(2.3) > 1.5, 'and looks clearly bigger on screen');
    assert.ok(view(1.5) > 1.15 && view(1.5) < view(2));
    assert.equal(view(4), growth.VIEW_MAX);
    assert.ok(growth.VIEW_MAX <= 1.8);
    const n = fakeBody();
    growth.applyPerks(n);
    assert.equal(n.topSpeed, 1);
    assert.equal(n.health.max, 100);
    assert.equal(n.damage, 1);
    assert.equal(growth.fovMult(1), 1);
});

test('damage', () => {
    global.royaleGrowth = growth;
    const { shotMult } = require(path.join(SERVER, 'game', 'entities', 'subFunctions.js'));
    const g = growth.multFor(20000);
    const player = { isPlayer: true, growthMult: g };
    player.master = player;
    assert.ok(Math.abs(shotMult({ master: player }) - growth.damageMult(g)) < 1e-9);
    // a drone's bullet: two hops to the tank
    const drone = { master: player };
    assert.ok(Math.abs(shotMult({ master: drone }) - growth.damageMult(g)) < 1e-9);
    const small = { isPlayer: true, growthMult: 1 };
    small.master = small;
    assert.equal(shotMult({ master: small }), 1);
    // a grown bot: its difficulty share times the growth
    const bot = { isBot: true, botShotMult: 0.8, growthMult: g };
    bot.master = bot;
    assert.ok(Math.abs(shotMult({ master: bot }) - 0.8 * growth.damageMult(g)) < 1e-9);
    // rock: every hit and the per-second budget move together; slow past 100k too
    assert.equal(growth.mineMult(g), growth.damageMult(g));
    assert.ok(growth.mineMult(growth.multFor(1e6)) < 2.6);
    delete global.royaleGrowth;
});

test('bots', () => {
    assert.equal(growth.BOT_SCORE_MULT, 2);
    // a bot grows from twice its score: spawn and life both
    const bot = fakeBody(); bot.isBot = true;
    const human = fakeBody(); human.isPlayer = true;
    growth.onSpawn(bot, 8000);
    growth.onSpawn(human, 16000);
    assert.equal(bot.growthMult, human.growthMult);
    assert.equal(bot._growEff, growth.spawnEff(16000));
    settle(bot, 8000 + 3000);
    settle(human, 16000 + 6000);
    assert.ok(Math.abs(bot.growthMult - human.growthMult) < 1e-9, bot.growthMult + ' vs ' + human.growthMult);
    // from the same score the bot is bigger, and gets to 2x on half the points
    const p = fakeBody(), b = fakeBody(); b.isBot = true;
    growth.onSpawn(p, 0); growth.onSpawn(b, 0);
    settle(p, growth.CAP_SCORE / 2); settle(b, growth.CAP_SCORE / 2);
    assert.ok(b.growthMult > p.growthMult);
    assert.ok(Math.abs(b.growthMult - growth.RESPAWN_CAP) < 1e-9);
    // the multiplier is growth only: scoreFor is read, never written
    let reads = 0;
    growth.tick(9e6, [b], () => { reads++; return 5000; });
    assert.equal(reads, 1);
    assert.equal(growth.scoreMult(human), 1);
    assert.equal(growth.scoreMult(null), 1);
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
