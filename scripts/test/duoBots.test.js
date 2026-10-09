// Duos: every bot plays in a pair (Oct 8: bots were solo rows on the team board): node scripts/test/duoBots.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const SERVER = path.join(__dirname, '..', '..', 'server');
global.Config = { royale_duos: true };
global.entities = new Map();
const duo = require(path.join(SERVER, 'game', 'duo', 'duoRaid.js'));

const tests = [];
const test = (n, f) => tests.push([n, f]);
const bot = (team, extra = {}) => ({ team, isBot: true, isDuoBot: true, isDead: () => false, ...extra });

test('a lone bot gets the next bot as its partner', () => {
    const a = bot(-301);
    const p = duo.botSpawnPlan([a]);
    assert.equal(p.team, -301);
    assert.equal(p.near, a);
});
test('a full pair is left alone: the next bot starts a new pair', () => {
    const p = duo.botSpawnPlan([bot(-301), bot(-301)]);
    assert.ok(p.team !== -301 && p.near === null && p.duo);
});
test('with two pairs and a lone bot, the lone one is filled', () => {
    const lone = bot(-303);
    const p = duo.botSpawnPlan([bot(-301), bot(-301), bot(-302), bot(-302), lone]);
    assert.equal(p.team, -303);
    assert.equal(p.near, lone);
});
test('dead bots and bot teammates of humans never count', () => {
    const p = duo.botSpawnPlan([bot(-301, { isDead: () => true }), bot(-302, { isTeamBot: true })]);
    assert.equal(p.near, null);
});
test('linking gives both the same team key and each other as mates', () => {
    const a = bot(-310), b = bot(-310);
    duo.linkBotDuo(b, [a, b]);
    assert.equal(a.duoMate, b); assert.equal(b.duoMate, a);
    assert.ok(a.duoTeamKey && a.duoTeamKey === b.duoTeamKey);
});
test('dig_royale keeps the bot count even on the duo server', () => {
    const src = require('fs').readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.match(src, /if \(Config\.royale_duos\) cap -= \(\(cap % 2\) \+ 2\) % 2;/);
    assert.match(src, /if \(!plan\) plan = duo\.botSpawnPlan\(enemyBots\(\)\);/);
});

let failed = 0;
for (const [n, f] of tests) {
    try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
