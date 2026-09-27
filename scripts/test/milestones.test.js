// Bank milestone tests: node scripts/test/milestones.test.js
//
// Rungs are reached by real deposits only. A rung's bonus lands in the bank
// (and on the raid board) but must not count toward the next rung, or ~45k of
// deposits would cascade 25k -> 50k -> 100k and end past 200k banked.
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const TERRAIN = path.join(__dirname, '..', '..', 'server', 'game', 'terrain');

// milestones.js only needs gems.setBanked / talkGems; stub the module so the
// terrain grid (and the rest of the game) never loads.
const gemsPath = require.resolve(path.join(TERRAIN, 'gems.js'));
require.cache[gemsPath] = {
    id: gemsPath, filename: gemsPath, loaded: true,
    exports: {
        setBanked(body, n) { n = Math.max(0, Math.round(n)); body.socket.gemBanked = n; body.bankedGems = n; return n; },
        talkGems() {},
    },
};
global.Config = { tutorial: false, dig_royale: false };

const { checkBanked, BANK_MILESTONES } = require(path.join(TERRAIN, 'milestones.js'));

function fakeBody() {
    const talks = [];
    const socket = { gemBanked: 0, talk: (...m) => talks.push(m) };
    return { socket, talks };
}
// what vault.js / outposts.js do per chunk: credit the bank, then check
function deposit(body, amount) {
    body.socket.gemBanked = (body.socket.gemBanked || 0) + amount;
    checkBanked(body, amount);
}
const bonusUpTo = (n) => BANK_MILESTONES.filter(m => m.at <= n).reduce((a, m) => a + m.bonus, 0);

let failed = 0;
function test(name, fn) {
    try { fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

test('45k of deposits does not cascade into the 50k/100k rungs', () => {
    const b = fakeBody();
    for (let i = 0; i < 45; i++) deposit(b, 1000);
    const rungs = b.talks.filter(t => t[0] === 'MS').map(t => t[2]);
    assert.deepEqual(rungs, [100, 500, 1000, 2500, 5000, 10000, 25000]);
    assert.equal(b.socket.gemDeposited, 45000);
    assert.equal(b.socket.gemBanked, 45000 + bonusUpTo(45000));
    assert.ok(b.socket.gemBanked < 100000, 'banked ' + b.socket.gemBanked);
});

test('a single huge deposit pays every rung it really crossed, once', () => {
    const b = fakeBody();
    deposit(b, 60000);
    assert.equal(b.socket.gemBanked, 60000 + bonusUpTo(60000));
    deposit(b, 1);
    assert.equal(b.talks.filter(t => t[0] === 'MS').length, BANK_MILESTONES.filter(m => m.at <= 60000).length);
});

test('the next rung still needs the real deposits', () => {
    const b = fakeBody();
    deposit(b, 99999);
    assert.ok(!b.talks.some(t => t[0] === 'MS' && t[2] === 100000));
    deposit(b, 1);
    assert.ok(b.talks.some(t => t[0] === 'MS' && t[2] === 100000));
});

test('spending the bank does not undo progress or re-pay rungs', () => {
    const b = fakeBody();
    deposit(b, 3000);
    const paid = b.talks.length;
    b.socket.gemBanked = 0;          // shop spree
    deposit(b, 1000);
    assert.equal(b.talks.length, paid);
    assert.equal(b.socket.gemDeposited, 4000);
});

test('tutorial never pays rungs', () => {
    global.Config.tutorial = true;
    try {
        const b = fakeBody();
        deposit(b, 30000);
        assert.equal(b.talks.length, 0);
        assert.equal(b.socket.gemBanked, 30000);
    } finally { global.Config.tutorial = false; }
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all milestone tests passed');
