// Auto stats (server/game/terrain/autoStats.js): node scripts/test/autoStats.test.js
//
//   root cause  a level 45 Basic with all 50 points unspent deals about a
//               seventh of the damage per second of a built bot (Bullet
//               Damage x3.65 per shot at 7 points, Reload about x1.9)
//   place       the template fills exactly the points in hand, never past a
//               cap, shaped for guns or for a rammer
//   tick        20 s into a life with no combat point spent: placed and
//               told; anyone who spent even one point keeps their choices;
//               not before the wait, not twice, not in the tutorial, not
//               when switched off
//   wiring      dig_royale arms it on every life and a new raid's respec,
//               and calls it from the once-a-second stamp loop
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

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
const auto = require(path.join(SERVER, 'game', 'terrain', 'autoStats.js'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sum = (a) => a.reduce((x, y) => x + (y | 0), 0);

function player(cls = 'basic') {
    const t = new Entity({ x: 0, y: 0 });
    t.define(cls);
    t.isPlayer = true; t.team = -1;
    const said = [];
    t.socket = { talk() {}, status: {}, camera: { x: 0, y: 0 } };
    t.socket.player = { body: t };
    t.sendMessage = (m) => said.push(String(m));
    t.said = said;
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
    return t;
}

test('root cause: an unspent Basic hits for a fraction of a built bot', () => {
    const p = player();
    assert.equal(p.skill.points, 50, 'level 45 with 50 points in hand');
    assert.equal(sum(p.skill.raw), 0, 'and none spent');
    const bot = new Entity({ x: 0, y: 0 });
    bot.define('basic'); bot.isBot = true; bot.botSkill = 0.4;
    while (bot.skill.level < 45) { bot.skill.score += bot.skill.levelScore; bot.skill.maintain(); }
    handler.configureBotStats(bot);
    const dps = (sk) => sk.dam / sk.rld;
    const ratio = dps(bot.skill) / dps(p.skill);
    log('     built bot / unspent player damage per second (same tank): x' + ratio.toFixed(2));
    assert.ok(ratio > 5, 'more than five times: ' + ratio.toFixed(2));
    auto.setEnabled(true);
    p._autoStatsAt = 1;
    assert.equal(auto.tick(p, Date.now()), true);
    const after = dps(bot.skill) / dps(p.skill);
    log('     after auto stats: x' + after.toFixed(2));
    assert.ok(after < 1.2, 'level with the bot: ' + after.toFixed(2));
    p.kill(); bot.kill();
});

test('place: exactly the points in hand, never past a cap', () => {
    assert.equal(sum(auto.GUN_BUILD), 50);
    assert.equal(sum(auto.RAM_BUILD), 50);
    const caps = Array(11).fill(9);
    const full = auto.placeBuild(Array(11).fill(0), 50, caps);
    assert.deepEqual(full.raw, auto.GUN_BUILD);
    assert.equal(full.left, 0);
    // more points (a twist, the shop): all placed, round robin past the template
    const more = auto.placeBuild(Array(11).fill(0), 56, caps);
    assert.equal(sum(more.raw), 56);
    assert.ok(more.raw.every(v => v <= 9));
    // fewer: scaled down, all placed
    const less = auto.placeBuild(Array(11).fill(0), 20, caps);
    assert.equal(sum(less.raw), 20);
    // a class that caps a stat at 0: skipped, the points go elsewhere
    const c2 = caps.slice(); c2[3] = 0; c2[0] = 2;
    const capped = auto.placeBuild(Array(11).fill(0), 50, c2);
    assert.equal(capped.raw[3], 0);
    assert.ok(capped.raw[0] <= 2);
    assert.equal(sum(capped.raw), 50);
    // everything capped: the rest stays in hand
    const tiny = auto.placeBuild(Array(11).fill(0), 50, Array(11).fill(2));
    assert.equal(sum(tiny.raw), 22);
    assert.equal(tiny.left, 28);
    // a rammer builds body
    const ram = auto.placeBuild(Array(11).fill(0), 50, caps, true);
    assert.equal(sum(ram.raw.slice(0, 5)), 0, 'no gun stats');
});

test('tick: placed 20 s in when nothing is spent; a chosen build is never touched', () => {
    auto.setEnabled(true);
    assert.equal(auto.AFTER_MS, +process.env.ROYALE_AUTO_STATS_MS > 0 ? +process.env.ROYALE_AUTO_STATS_MS : 20_000);
    const t0 = Date.now();
    const p = player();
    auto.arm(p, t0);
    assert.equal(auto.tick(p, t0 + auto.AFTER_MS - 100), false, 'not before the wait');
    assert.equal(sum(p.skill.raw), 0);
    assert.equal(auto.tick(p, t0 + auto.AFTER_MS + 10), true, 'then placed');
    assert.equal(p.skill.points, 0);
    assert.deepEqual(p.skill.raw.slice(0, 11), auto.GUN_BUILD);
    assert.ok(p.said.some(m => /Your 50 unspent stat points went into a balanced build/.test(m)), p.said.join(' | '));
    assert.equal(auto.tick(p, t0 + auto.AFTER_MS + 2000), false, 'once a life');
    // one point spent: left alone
    const q = player();
    q.skill.upgrade('dam');
    auto.arm(q, t0);
    assert.equal(auto.tick(q, t0 + auto.AFTER_MS + 10), false);
    assert.equal(q.skill.points, 49, 'their own choice');
    // only Mining Power spent: still placed (a combat build is what's missing)
    const m = player();
    m.skill.upgrade('min');
    auto.arm(m, t0);
    assert.equal(auto.tick(m, t0 + auto.AFTER_MS + 10), true);
    assert.equal(m.skill.points, 0);
    // the tutorial scripts its own stats; the switch turns it off
    const r = player();
    auto.arm(r, t0);
    Config.tutorial = true;
    try { assert.equal(auto.tick(r, t0 + auto.AFTER_MS + 10), false); } finally { Config.tutorial = false; }
    auto.setEnabled(false);
    try { r._autoStatsAt = 1; assert.equal(auto.tick(r, t0 + auto.AFTER_MS + 10), false); } finally { auto.setEnabled(true); }
    // a bot never
    const b = player(); b.isPlayer = false; b.isBot = true; b._autoStatsAt = 1;
    assert.equal(auto.tick(b, Date.now()), false);
    for (const o of [p, q, m, r, b]) o.kill();
});

test('wiring: armed every life and every new raid, ticked once a second', () => {
    const dr = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.match(dr, /body\.botSoftUntil = now\(\) \+ body\.botSoftMs;\n\s*autoStats\.arm\(body, now\(\), !!body\.socket && careerLives\(body\.socket\) < autoStats\.NEW_LIVES\);/, 'freshRaidBody arms it (new players flagged)');
    assert.match(dr, /body\._shopStatPts = 0;\n\s*if \(body\.socket\) autoStats\.arm\(body, now\(\), careerLives\(body\.socket\) < autoStats\.NEW_LIVES\);/, 'a new raid re-arms it');
    assert.match(dr, /guard\('auto stats', \(\) => autoStats\.tick\(body, t\)\)/, 'the stamp loop ticks it');
});

test('newbie: no build picked, Mining Power lifted to 5 for free, their own points untouched', () => {
    const raw = Array(11).fill(0); raw[10] = 1; raw[3] = 4;
    const sk = { raw: raw.slice(), caps: Array(11).fill(9), points: 30, set(r) { this.raw = r.slice(); } };
    const said = [];
    const b = { isPlayer: true, socket: {}, skill: sk, refreshBodyAttributes() {}, sendMessage: m => said.push(m), isDead: () => false };
    auto.arm(b, 1000, true);
    assert.equal(b._autoStatsNew, true);
    assert.equal(b._autoStatsAt, 1000 + auto.NEW_AFTER_MS);
    assert.equal(auto.tick(b, 1000 + auto.NEW_AFTER_MS), true);
    assert.equal(sk.raw[10], auto.NEW_MINING, 'mining lifted to 5');
    assert.equal(sk.raw[3], 4, 'their own choice kept');
    assert.equal(sk.points, 30, 'the free points cost nothing');
    assert.ok(said.length === 1);
    // already at 5 or more: nothing
    const sk2 = { raw: Object.assign(Array(11).fill(0), { 10: 7 }), caps: Array(11).fill(9), points: 0, set(r) { this.raw = r.slice(); } };
    assert.equal(auto.newbieMining({ refreshBodyAttributes() {}, sendMessage() {} }, sk2), false);
    // a regular player is armed as before (off unless ROYALE_AUTO_STATS)
    auto.arm(b, 1000, false);
    assert.equal(b._autoStatsNew, false);
    assert.equal(b._autoStatsAt, 1000 + auto.AFTER_MS);
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
