// A guest who signs up keeps their progress: node scripts/test/guestTransfer.test.js
//
//   bank       what the guest had banked moves onto the new account, once
//   lease      a raid the guest was in when they signed up banks onto the account
//   stats      lives, kills and play time count on the new account
//   old        logging in to an older account on a guest browser moves nothing
//   wiring     bridge.js tells the player
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-guestmove-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS']) delete process.env[k];
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'guestmove-test-secret-0123456789-abcdefghij';

const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const banks = require('../../server/accounts/banks');
const guests = require('../../server/accounts/guests');
const D = () => dbmod.handle();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let seq = 0;
function mkUser() {
    const r = accounts.users.create({ username: ('gm_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const gid = (n) => (n.toString(16) + 'b'.repeat(32)).slice(0, 32);
function guestWithBank(id, gems) {
    guests.seen(id, Date.now(), null);
    banks.checkout('g:' + id, 'seed-' + id);
    banks.release('seed-' + id, gems);
    assert.equal(banks.peek('g:' + id), gems);
}

test('bank: a guest who signs up brings their banked gems, once', () => {
    const g = gid(1);
    guestWithBank(g, 4200);
    const u = mkUser();
    assert.equal(guests.converted(g, u.id), true, 'first time');
    assert.equal(banks.claimGuest(g, u.id), 4200);
    assert.equal(banks.peek('a:' + u.id), 4200);
    assert.equal(banks.peek('g:' + g), 0);
    assert.equal(guests.converted(g, u.id), false, 'only once');
    assert.equal(banks.claimGuest(g, u.id), 0, 'nothing left to move');
    assert.equal(banks.peek('a:' + u.id), 4200);
});

test('lease: a raid the guest was in when they signed up banks onto the account', () => {
    const g = gid(2);
    guestWithBank(g, 1000);
    assert.equal(banks.checkout('g:' + g, 'raid-g2'), 1000, 'the guest takes it into a raid');
    const u = mkUser();
    guests.converted(g, u.id);
    assert.equal(banks.claimGuest(g, u.id), 0, 'nothing at rest while the raid holds it');
    // the raid ends for the guest tab with 1,800 banked
    banks.release('raid-g2', 1800);
    assert.equal(banks.peek('a:' + u.id), 1800, 'onto the account');
    assert.equal(banks.peek('g:' + g), 0);
});

test('lease: a stale guest lease written back goes to the account too', () => {
    const g = gid(3);
    guestWithBank(g, 500);
    banks.checkout('g:' + g, 'raid-g3', Date.now() - banks.STALE_MS - 1000);
    const u = mkUser();
    guests.converted(g, u.id);
    banks.recoverStale(Date.now());
    assert.equal(banks.peek('a:' + u.id), 500);
});

test('stats: lives, kills and play time count on the new account', () => {
    const g = gid(4);
    guests.seen(g, Date.now(), null);
    guests.life(g, { kills: 3, botKills: 5, score: 900, ms: 120000 });
    guests.life(g, { kills: 1, botKills: 0, score: 200, ms: 30000 });
    const u = mkUser();
    guests.converted(g, u.id);
    const s = D().get('SELECT lives, kills, bot_kills, play_ms FROM user_stats WHERE user_id = ?', u.id);
    assert.deepEqual({ ...s }, { lives: 2, kills: 4, bot_kills: 5, play_ms: 150000 });
});

test('old: logging in to an older account on a guest browser moves nothing', () => {
    const g = gid(5);
    guestWithBank(g, 3000);
    const u = mkUser();
    D().run('UPDATE users SET created_at = ? WHERE id = ?', Date.now() - 3 * banks.NEW_ACCOUNT_MS, u.id);
    assert.equal(guests.converted(g, u.id), true);
    assert.equal(banks.claimGuest(g, u.id), 0);
    assert.equal(banks.peek('a:' + u.id), 0);
    assert.equal(banks.peek('g:' + g), 3000, 'the guest keeps it');
    const s = D().get('SELECT lives FROM user_stats WHERE user_id = ?', u.id);
    assert.ok(!s || s.lives === 0, 'no stats either');
});

test('wiring: the bridge moves the bank and says so', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'accounts', 'game', 'bridge.js'), 'utf8');
    assert.match(src, /\n\s+guests\.converted\(socket\.guestId, socket\.account\.id\);/);
    assert.match(src, /claimGuest\(socket\.guestId, socket\.account\.id\)/);
    assert.match(src, /Your guest progress came with you/);
});

(async () => {
    const quietLog = console.log;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietLog(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); quietLog('ok   ' + t.name); }
        catch (e) { failed++; quietLog('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
    }
    try { accounts.shutdown(); } catch (e) { /* */ }
    quietLog(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
