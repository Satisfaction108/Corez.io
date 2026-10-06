// Core lucky drop: node scripts/test/coreDrop.test.js
//
//   chance      ROYALE_CORE_DROP_CHANCE (default 0.2), clamped, rolled once per break
//   pool        lobby shop cosmetics only: no retired / exclusive / achievement /
//               invite / free / starter items; never one the player owns;
//               owns everything = no drop
//   account     granted at once (owned_items, the Locker), slam + feed line
//   guest       saved for signup, granted by adoptGuest, "Sign up to keep it"
//   wiring      coreFinale.blow -> hooks.loot -> coreDrop.onBreak; client slam + feed
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-coredrop-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ROYALE_DEBUG', 'ROYALE_CORE_DROP_CHANCE']) delete process.env[k];
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'coredrop-test-secret-0123456789-abcdefghij';
global.Config = { dig_royale: true };

const accounts = require('../../server/accounts');
const ach = require('../../server/accounts/achievements');
const store = require('../../server/accounts/store');
const COS = require('../../shared/cosmetics.js');
const CD = require('../../server/game/terrain/coreDrop.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let seq = 0;
function mkUser() {
    const r = accounts.users.create({ username: ('cd_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const gid = (n) => (n.toString(16) + 'd'.repeat(32)).slice(0, 32);
function mkBody(o) {
    const s = { id: 'sock' + (++seq), account: null, guestId: null, terminated: false, packets: [] };
    if (o.user) s.account = { id: o.user.id, username: o.user.username };
    if (o.guest) s.guestId = o.guest;
    s.talk = (...a) => s.packets.push(a);
    return { socket: s, name: o.name || 'Digger' };
}
function mkHooks() {
    const h = { callouts: [], fed: [] };
    h.callout = (body, kind, text, pts, sub, dur) => h.callouts.push({ kind, text, pts, sub, dur });
    h.feed = (e) => h.fed.push(e);
    return h;
}
const zero = () => 0;

test('chance: 0.2 by default, env override, clamped', () => {
    assert.equal(CD.chance(), 0.2);
    process.env.ROYALE_CORE_DROP_CHANCE = '0.5';
    assert.equal(CD.chance(), 0.5);
    process.env.ROYALE_CORE_DROP_CHANCE = '7';
    assert.equal(CD.chance(), 1);
    process.env.ROYALE_CORE_DROP_CHANCE = '-1';
    assert.equal(CD.chance(), 0);
    process.env.ROYALE_CORE_DROP_CHANCE = 'nope';
    assert.equal(CD.chance(), 0.2);
    delete process.env.ROYALE_CORE_DROP_CHANCE;
    // the roll: under 0.2 drops, at or over it never (fake bridge, nothing owned)
    const granted = [];
    CD.setBridge({ lootOwner: () => ({ kind: 'a', id: 1 }), lootOwned: () => new Set(), lootGrant: (o, id) => { granted.push(id); return true; } });
    assert.equal(CD.onBreak(mkBody({}), mkHooks(), () => 0.2), null, '0.2 is a miss');
    assert.equal(CD.onBreak(mkBody({}), mkHooks(), () => 0.95), null);
    assert.ok(CD.onBreak(mkBody({}), mkHooks(), () => 0.19), '0.19 is a hit');
    assert.equal(granted.length, 1);
    // about 20% over many breaks
    let hits = 0, s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    for (let i = 0; i < 5000; i++) if (CD.onBreak(mkBody({}), mkHooks(), rnd)) hits++;
    assert.ok(hits > 850 && hits < 1150, 'hits ' + hits);
    // nobody to keep it (accounts off, no guest id): no drop
    CD.setBridge({ lootOwner: () => null, lootOwned: () => new Set(), lootGrant: () => true });
    assert.equal(CD.onBreak(mkBody({}), mkHooks(), zero), null);
    // a bot or a closed socket: nothing
    assert.equal(CD.onBreak({ name: 'bot' }, mkHooks(), zero), null);
    CD.setBridge(null);
});

test('pool: lobby shop items only, never an owned or excluded one', () => {
    assert.ok(CD.POOL.length > 20, 'pool ' + CD.POOL.length);
    const cats = new Set(CD.POOL.map(it => it.cat));
    for (const c of ['nameStyle', 'skin', 'sidekick', 'sdSkin', 'sdName']) assert.ok(cats.has(c), 'has ' + c);
    for (const it of CD.POOL) {
        assert.ok(!it.retired && !it.exclusive && !it.earn, it.id + ' excluded kind');
        assert.ok(it.price > 0, it.id + ' free');
        assert.notEqual(it.id, COS.BASIC_SIDEKICK_ID);
        assert.notEqual(it.id, COS.INVITE_STYLE_ID);
    }
    for (const it of COS.ITEMS) if (it.exclusive || it.earn || it.retired) assert.ok(!CD.POOL.includes(it), it.id + ' must not drop');
    // never owned
    const owned = new Set(CD.POOL.slice(0, CD.POOL.length - 3).map(it => it.id));
    for (let i = 0; i < 500; i++) {
        const it = CD.pick(owned);
        assert.ok(it && !owned.has(it.id));
    }
    // every item can come up (flat pick)
    const seen = new Set();
    for (let i = 0; i < CD.POOL.length; i++) seen.add(CD.pick(new Set(), () => (i + 0.5) / CD.POOL.length).id);
    assert.equal(seen.size, CD.POOL.length);
    assert.equal(CD.pick(new Set(CD.POOL.map(it => it.id))), null, 'owns everything: no drop');
});

test('account: granted at once, in the Locker, slam + feed', () => {
    const u = mkUser();
    const body = mkBody({ user: u, name: 'Breaker' });
    const h = mkHooks();
    const it = CD.onBreak(body, h, zero);
    assert.ok(it, 'dropped');
    assert.ok(store.ownedSet(u.id).has(it.id), 'owned');
    assert.equal(h.callouts.length, 1);
    const c = h.callouts[0];
    assert.equal(c.kind, 'coreloot');
    assert.equal(c.text, 'CORE LOOT!');
    assert.equal(c.sub, 'You got ' + it.name + ' (' + COS.RARITIES[it.rarity].name + '). It is in your Locker.');
    assert.ok(c.dur >= 4000, 'a must-see slam');
    assert.deepEqual(h.fed, [{ cloot: 1, by: 'Breaker', item: it.name, rar: it.rarity }]);
    for (const x of [c.text, c.sub]) assert.ok(!/—/.test(x), 'no em dashes');
    // keeps dropping new things until the account owns the whole pool, then nothing
    const got = new Set([it.id]);
    for (let i = 0; i < CD.POOL.length + 5; i++) {
        // the roll always hits, the pick is random
        const n = CD.onBreak(body, mkHooks(), (() => { let f = true; return () => (f ? (f = false, 0) : Math.random()); })());
        if (!n) break;
        assert.ok(!got.has(n.id), 'never a repeat: ' + n.id);
        got.add(n.id);
    }
    assert.equal(got.size, CD.POOL.length, 'the whole pool');
    const last = mkHooks();
    assert.equal(CD.onBreak(body, last, zero), null, 'owns everything: no drop');
    assert.equal(last.callouts.length + last.fed.length, 0, 'and no announcement');
});

test('guest: saved for signup, granted on adoption', () => {
    const g = gid(++seq);
    const body = mkBody({ guest: g, name: 'Guesty' });
    const h = mkHooks();
    const it = CD.onBreak(body, h, zero);
    assert.ok(it);
    assert.deepEqual(ach.guestLoot(g), [it.id]);
    assert.match(h.callouts[0].sub, /Sign up to keep it\.$/);
    assert.equal(h.fed[0].cloot, 1);
    // a second drop is never the same item
    const it2 = CD.onBreak(body, mkHooks(), zero);
    assert.ok(it2 && it2.id !== it.id);
    assert.deepEqual(ach.guestLoot(g).sort(), [it.id, it2.id].sort());
    // signup: the account gets both, once
    const u = mkUser();
    const res = ach.adoptGuest(g, u.id);
    assert.deepEqual(res.loot.slice().sort(), [it.id, it2.id].sort());
    const owned = store.ownedSet(u.id);
    assert.ok(owned.has(it.id) && owned.has(it2.id));
    assert.deepEqual(ach.guestLoot(g), [], 'guest rows gone');
    const again = ach.adoptGuest(g, u.id);
    assert.ok(!again.loot, 'nothing twice');
});

test('wiring: the break, the hook, the client', () => {
    const cf = rd('server/game/terrain/coreFinale.js');
    assert.match(cf, /if \(b\.killer && b\.killer\.socket && hooks\.loot\) \{ try \{ hooks\.loot\(b\.killer\); \}/);
    const dr = rd('server/game/gamemodes/scripts/dig_royale.js');
    assert.match(dr, /loot: \(body\) => require\('\.\.\/\.\.\/terrain\/coreDrop\.js'\)\.onBreak\(body, \{/);
    const rh = rd('public/client/raidHeat.js');
    assert.ok(rh.includes('case "coreloot":'), 'the winner slam');
    assert.ok(rh.includes('if (f.cloot) return'), 'the feed line');
    assert.ok(rh.includes('" in the Core"'));
    const br = rd('server/accounts/game/bridge.js');
    assert.ok(br.includes("require('../retention').grantItem(d, o.id, itemId, now)"));
    assert.ok(br.includes('Your Core loot came with you'));
});

(async () => {
    const quietLog = console.log;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietLog(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); quietLog('ok   ' + t.name); }
        catch (e) { failed++; quietLog('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n     ')); }
    }
    try { accounts.shutdown(); } catch (e) { /* */ }
    quietLog(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
