// Retention: node scripts/test/retention.test.js
//
//   clock      shared/daily.js: unlock after 20 h, claimable to 48 h, a miss
//              drops back 2 days (never to 0), the week wraps, the
//              come-back countdown and its server-skew math, the ping time
//   claim      accounts: gems + dust (ledger kind 'daily'), Buddy on day 3,
//              a sidekick skin on day 7, fallback dust for what they own;
//              a second claim is refused, racing claims pay once
//   reset      a missed window drops back gently and restarts the streak
//   guests     gems into the guest bank (via banks.credit), day 3 / 7 items
//              owed for sign up; a raid holding a lease loses nothing
//   adopt      a guest browser that signs up brings its track and owed items
//   http       POST /api/daily, /api/daily/claim (guests and accounts),
//              CSRF, made-up guest ids capped per IP
//   push       subscription storage (allowlisted push services only, upsert,
//              per-owner cap, unsubscribe), the daily and Raid Night pings
//              with a fake push service, dead endpoints dropped, back-off
//   crypto     aes128gcm against the RFC 8291 example, VAPID token checks
//   flags      RETENTION_DAILY=0 and WEB_PUSH=0 switch things off
//   migration  v11 -> v12 keeps the dust ledger, writes the backup
//   client     the wiring (scripts, service worker, finale strip), no em dashes
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const nodeCrypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-retention-test-'));
const DATA_DIR = path.join(ROOT, 'data');
const REPO = path.join(__dirname, '..', '..');

// a VAPID pair just for this run
const vapid = (() => {
    const e = nodeCrypto.createECDH('prime256v1');
    e.generateKeys();
    return { pub: e.getPublicKey().toString('base64url'), priv: e.getPrivateKey().toString('base64url') };
})();

process.env.DATA_DIR = DATA_DIR;
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'TRUSTED_PROXIES', 'DISCORD_BOT_TOKEN',
    'RETENTION_DAILY', 'WEB_PUSH', 'WEB_PUSH_SUBJECT']) delete process.env[k];
Object.assign(process.env, {
    NODE_ENV: 'test', ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'retention-test-secret-0123456789-abcdefghij', PORT: '3000',
    WEB_PUSH_PUBLIC_KEY: vapid.pub, WEB_PUSH_PRIVATE_KEY: vapid.priv, WEB_PUSH_SUBJECT: 'mailto:test@corez.io',
});
if (process.argv.includes('--flags-off')) Object.assign(process.env, { RETENTION_DAILY: '0', WEB_PUSH: '0' });

const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const migrations = require('../../server/accounts/migrations');
const banks = require('../../server/accounts/banks');
const guests = require('../../server/accounts/guests');
const retention = require('../../server/accounts/retention');
const push = require('../../server/accounts/push');
const webpush = require('../../server/accounts/webpush');
const store = require('../../server/accounts/store');
const ratelimit = require('../../server/accounts/ratelimit');
const DY = require('../../shared/daily.js');
const EV = require('../../shared/events.js');
const C = require('../../shared/cosmetics.js');

const HOUR = 3600e3, DAYMS = 24 * HOUR;
const d = () => dbmod.handle();
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let seq = 0;
function mkUser(opts = {}) {
    const r = accounts.users.create({ username: ('rt_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    if (opts.createdAt) d().run('UPDATE users SET created_at = ? WHERE id = ?', opts.createdAt, r.user.id);
    return accounts.users.byId(r.user.id);
}
let gseq = 0;
const gid = () => (++gseq).toString(16).padStart(4, '0') + nodeCrypto.randomBytes(14).toString('hex');
const A = (u) => ({ kind: 'a', id: u.id });
const G = (g) => ({ kind: 'g', id: g });
const dustOf = (u) => d().get('SELECT dust_milli FROM users WHERE id = ?', u.id).dust_milli;
const owns = (u, id) => !!d().get('SELECT 1 AS x FROM owned_items WHERE user_id = ? AND item_id = ?', u.id, id);
const T0 = Date.UTC(2026, 9, 5, 18, 0, 0);   // a Monday, 6 PM UTC
const errCode = (fn) => { try { fn(); } catch (e) { return e.code || e.message; } return null; };

// ── clock (shared/daily.js) ────────────────────────────────────────────
test('clock: first visit is day 1, ready; then 20 h to unlock, 48 h to claim', () => {
    assert.deepEqual(DY.evaluate(null, T0), { day: 1, ready: true, readyAt: T0, expiresAt: null, missed: false, streak: 0, from: 1 });
    const st = { step: 1, streak: 1, claims: 1, lastClaimAt: T0 };
    const e1 = DY.evaluate(st, T0 + 19 * HOUR + 59 * 60e3);
    assert.equal(e1.ready, false);
    assert.equal(e1.day, 2);
    assert.equal(e1.readyAt, T0 + 20 * HOUR);
    assert.equal(e1.expiresAt, T0 + 48 * HOUR);
    assert.equal(DY.evaluate(st, T0 + 20 * HOUR).ready, true, 'exactly 20 h');
    const e2 = DY.evaluate(st, T0 + 48 * HOUR);
    assert.equal(e2.ready && !e2.missed && e2.day === 2, true, 'still fine at 48 h');
    const e3 = DY.evaluate(st, T0 + 48 * HOUR + 1);
    assert.equal(e3.missed, true);
    assert.equal(e3.day, 1, 'day 1 missed: back to day 1, never below');
});

test('clock: a miss drops back 2 days, the streak restarts, the week wraps', () => {
    const at = (step, streak) => ({ step, streak, claims: step + 3, lastClaimAt: T0 });
    const late = T0 + 50 * HOUR;
    assert.deepEqual([2, 3, 4, 5, 6].map(s => DY.evaluate(at(s, s), late).day), [1, 2, 3, 4, 5]);
    assert.equal(DY.evaluate(at(5, 5), late).from, 6, 'it says what it would have been');
    assert.equal(DY.evaluate(at(5, 5), late).streak, 0);
    assert.equal(DY.evaluate(at(7, 7), T0 + 21 * HOUR).day, 1, 'after day 7 comes day 1');
    assert.equal(DY.evaluate(at(7, 7), late).day, 1, 'a miss after day 7 is day 1 too');
    const next = DY.afterClaim({ step: 4, streak: 4, best: 6, claims: 9 }, DY.evaluate(at(4, 4), T0 + 21 * HOUR), T0 + 21 * HOUR);
    assert.deepEqual(next, { step: 5, streak: 5, best: 6, claims: 10, lastClaimAt: T0 + 21 * HOUR });
    assert.equal(DY.nextDay(7), 1);
    assert.equal(DY.nextDay(3), 4);
});

test('clock: the come-back countdown and its skew math', () => {
    assert.equal(DY.countdown(0), 'now');
    assert.equal(DY.countdown(-5), 'now');
    assert.equal(DY.countdown(1), '1s');
    assert.equal(DY.countdown(45e3), '45s');
    assert.equal(DY.countdown(60e3), '1m');
    assert.equal(DY.countdown(61e3), '2m', 'rounds up: never says ready early');
    assert.equal(DY.countdown(59 * 60e3), '59m');
    assert.equal(DY.countdown((14 * 60 + 32) * 60e3), '14h 32m');
    assert.equal(DY.countdown((14 * 60 + 31) * 60e3 + 1), '14h 32m');
    assert.equal(DY.countdown(3 * HOUR + 5 * 60e3), '3h 05m');
    assert.equal(DY.countdown(50 * HOUR), '2d 2h');
    // the server is 90 s ahead of this browser: the countdown follows the server
    const serverNow = 1e12, clientNow = serverNow - 90e3, skew = serverNow - clientNow;
    assert.equal(DY.leftMs(serverNow + 10 * 60e3, clientNow, skew), 10 * 60e3);
    assert.equal(DY.leftMs(serverNow + 10 * 60e3, clientNow + 60e3, skew), 9 * 60e3, 'a minute later on the client');
    assert.equal(DY.leftMs(serverNow - 1, clientNow, skew), 0, 'never negative');
});

test('clock: the ping lands at the usual time, inside the claim window', () => {
    // claimed 6 PM, usually plays at 9 PM: next day 9 PM (27 h later)
    assert.equal(DY.pingAt(T0, 21 * 60), T0 + 27 * HOUR);
    // usually plays at 1 PM: unlock is 2 PM next day, so 1 PM the day after that (43 h)
    assert.equal(DY.pingAt(T0, 13 * 60), T0 + 43 * HOUR);
    for (let m = 0; m < 1440; m += 37) {
        const t = DY.pingAt(T0, m);
        assert.ok(t >= T0 + DY.UNLOCK_MS && t < T0 + DY.GRACE_MS, 'minute ' + m);
    }
    assert.equal(DY.pingAt(T0, null), T0 + 24 * HOUR, 'no history: the time they claimed');
    assert.equal(DY.smoothMinute(null, 600), 600);
    assert.equal(DY.smoothMinute(600, 700), 630);
    assert.equal(DY.smoothMinute(1430, 10), 1436, 'the short way round midnight');
    assert.equal(DY.smoothMinute(10, 1430), 4);
});

// ── claiming (accounts) ────────────────────────────────────────────────
test('claim: day 1 pays gems into the bank and dust (ledger kind daily); a second claim is refused', () => {
    const u = mkUser();
    const before = dustOf(u);
    const r = retention.claim(A(u), T0);
    assert.equal(r.claimed.day, 1);
    assert.equal(r.claimed.gems, 300);
    assert.equal(r.claimed.dustMilli, 1000);
    assert.equal(dustOf(u), before + 1000);
    assert.equal(banks.peek('a:' + u.id), 300);
    const led = d().get("SELECT * FROM dust_ledger WHERE user_id = ? AND kind = 'daily'", u.id);
    assert.equal(led.delta_milli, 1000);
    assert.equal(led.balance_milli, before + 1000);
    assert.equal(led.ref, 'daily:1');
    assert.equal(r.status.ready, false);
    assert.equal(r.status.day, 2);
    assert.equal(r.status.tomorrow.gems, 500, 'tomorrow is shown before it is ready');
    assert.equal(errCode(() => retention.claim(A(u), T0 + 1000)), 'not_ready');
    assert.equal(errCode(() => retention.claim(A(u), T0 + 19 * HOUR)), 'not_ready');
    assert.equal(dustOf(u), before + 1000, 'paid once');
    assert.equal(d().get('SELECT count(*) AS n FROM daily_claims dc JOIN daily_track t ON t.id = dc.track_id WHERE t.user_id = ?', u.id).n, 1);
});

test('claim: racing requests pay once (the claims = ? guard and the claim row key)', () => {
    const u = mkUser();
    retention.claim(A(u), T0);
    // what a second tab would do with the state it read before the first claim landed
    const tr = d().get('SELECT * FROM daily_track WHERE user_id = ?', u.id);
    const stale = d().run('UPDATE daily_track SET step = 1, claims = 1 WHERE id = ? AND claims = ?', tr.id, 0).changes;
    assert.equal(stale, 0, 'a claim that read claims = 0 moves nothing');
    assert.throws(() => d().run('INSERT INTO daily_claims (track_id, claim_no, day, at) VALUES (?, 1, 1, ?)', tr.id, T0), /UNIQUE|PRIMARY/);
});

test('claim: a week of claims pays Buddy on day 3 and the Frosted skin on day 7, then wraps to day 1', () => {
    const u = mkUser();
    const t = (i) => T0 + i * 21 * HOUR;
    let gems = 0, dust = 0;
    for (let i = 0; i < 7; i++) {
        const r = retention.claim(A(u), t(i));
        assert.equal(r.claimed.day, i + 1);
        gems += r.claimed.gems; dust += r.claimed.dustMilli;
        if (i + 1 === 3) {
            assert.equal(r.claimed.item.id, C.BASIC_SIDEKICK_ID);
            assert.ok(owns(u, 'sd_buddy'));
            assert.equal(accounts.users.byId(u.id).equip_sidekick, 'sd_buddy', 'put on: no sidekick was equipped');
        }
        if (i + 1 === 7) {
            assert.equal(r.claimed.item.id, 'sds_frost');
            assert.equal(C.byId('sds_frost').rarity, 'rare');
            assert.equal(accounts.users.byId(u.id).equip_sd_skin, 'sds_frost', 'Buddy wears it');
        }
    }
    const expectGems = DY.TRACK.reduce((s, e) => s + e.gems, 0), expectDust = DY.TRACK.reduce((s, e) => s + e.dustMilli, 0);
    assert.equal(gems, expectGems);
    assert.equal(dust, expectDust);
    assert.equal(banks.peek('a:' + u.id), expectGems);
    const own = d().get("SELECT source FROM owned_items WHERE user_id = ? AND item_id = 'sd_buddy'", u.id);
    assert.equal(own.source, 'grant');
    // the ledger adds up
    let run = 0;
    for (const l of d().all("SELECT delta_milli, balance_milli FROM dust_ledger WHERE user_id = ? ORDER BY id", u.id)) { run += l.delta_milli; assert.equal(l.balance_milli, run); }
    const st = retention.status(A(u), t(7));
    assert.equal(st.day, 1, 'a new week');
    assert.equal(st.streak, 7);
    assert.equal(st.track[6].item.id, 'sds_checker', 'next week day 7 is the next skin they lack');
});

test('claim: an item they already own pays the fallback dust instead', () => {
    const u = mkUser();
    d().run("INSERT INTO owned_items (user_id, item_id, source, acquired_at) VALUES (?, 'sd_buddy', 'purchase', ?)", u.id, T0);
    for (let i = 0; i < 2; i++) retention.claim(A(u), T0 + i * 21 * HOUR);
    const st = retention.status(A(u), T0 + 2 * 21 * HOUR);
    assert.equal(st.today.item, null);
    assert.equal(st.today.had.id, 'sd_buddy');
    const before = dustOf(u);
    const r = retention.claim(A(u), T0 + 2 * 21 * HOUR);
    assert.equal(r.claimed.day, 3);
    assert.equal(r.claimed.dustMilli, DY.TRACK[2].fallbackMilli);
    assert.equal(dustOf(u) - before, 5000);
});

test('reset: missing the window drops back 2 days, not to 0, and restarts the flame', () => {
    const u = mkUser();
    let t = T0;
    for (let i = 0; i < 5; i++) { retention.claim(A(u), t); t += 22 * HOUR; }
    assert.equal(retention.status(A(u), t - 22 * HOUR + 30 * HOUR).streak, 5);
    const late = t - 22 * HOUR + 49 * HOUR;
    const st = retention.status(A(u), late);
    assert.equal(st.missed, true);
    assert.equal(st.from, 6);
    assert.equal(st.day, 4, 'day 6 would have been next: back to day 4');
    assert.equal(st.streak, 0);
    const r = retention.claim(A(u), late);
    assert.equal(r.claimed.day, 4);
    assert.equal(r.claimed.missed, true);
    const tr = d().get('SELECT step, streak, best FROM daily_track WHERE user_id = ?', u.id);
    assert.deepEqual({ ...tr }, { step: 4, streak: 1, best: 5 });
});

// ── guests ─────────────────────────────────────────────────────────────
test('guests: gems go into the guest bank, no dust, items are owed for sign up', () => {
    const g = gid();
    guests.seen(g, T0, null);
    const r1 = retention.claim(G(g), T0);
    assert.equal(r1.claimed.gems, 300);
    assert.equal(r1.claimed.dustMilli, 0);
    assert.equal(r1.balanceMilli, null);
    assert.equal(banks.peek('g:' + g), 300);
    retention.claim(G(g), T0 + 21 * HOUR);
    const st = retention.status(G(g), T0 + 42 * HOUR);
    assert.equal(st.owner, 'guest');
    assert.equal(st.today.day, 3);
    assert.equal(st.today.item.id, 'sd_buddy');
    assert.equal(st.today.signup, true, 'shown as sign up to claim');
    assert.equal(st.track[6].signup, true);
    const r3 = retention.claim(G(g), T0 + 42 * HOUR);
    assert.equal(r3.claimed.signup, true);
    assert.equal(banks.peek('g:' + g), 300 + 500 + 750);
    assert.deepEqual(retention.status(G(g), T0 + 43 * HOUR).owed.map(i => i.id), ['sd_buddy']);
});

test('guests: a raid holding the bank lease loses nothing and nobody spends it twice', () => {
    const g = gid();
    guests.seen(g, T0, null);
    banks.checkout('g:' + g, 'seed-' + g);
    banks.release('seed-' + g, 1000);
    assert.equal(banks.checkout('g:' + g, 'raid-' + g, T0), 1000, 'a raid takes it all');
    retention.claim(G(g), T0);                                 // claimed in another tab mid-raid
    assert.equal(banks.peek('g:' + g), 300, 'at rest while the raid holds the rest');
    assert.equal(banks.checkout('g:' + g, 'tab2-' + g, T0), 300, 'a second tab only finds the reward');
    banks.release('tab2-' + g, 300);
    banks.release('raid-' + g, 1400, T0 + HOUR);              // the raid banked 400 more
    assert.equal(banks.peek('g:' + g), 1700);
});

test('guests: a guest who signs up brings the track and gets the owed items', () => {
    const g = gid();
    guests.seen(g, T0, null);
    for (let i = 0; i < 3; i++) retention.claim(G(g), T0 + i * 21 * HOUR);
    const u = mkUser({ createdAt: Date.now() });
    const r = retention.adoptGuest(u.id, g, Date.now());
    assert.equal(r.moved, true);
    assert.deepEqual(r.items.map(i => i.id), ['sd_buddy']);
    assert.ok(owns(u, 'sd_buddy'));
    const tr = d().get('SELECT step, claims, streak FROM daily_track WHERE user_id = ?', u.id);
    assert.deepEqual({ ...tr }, { step: 3, claims: 3, streak: 3 });
    assert.equal(retention.adoptGuest(u.id, g, Date.now()).moved, false, 'once');
    assert.equal(errCode(() => retention.claim(G(g), Date.now() + 30 * HOUR)), 'adopted');
    assert.equal(retention.status(G(g), Date.now()).adopted, true);
    // an older account, or a guest someone else converted, moves nothing
    const g2 = gid();
    guests.seen(g2, T0, null);
    retention.claim(G(g2), T0);
    const old = mkUser({ createdAt: Date.now() - 3 * DAYMS });
    assert.equal(retention.adoptGuest(old.id, g2, Date.now()).moved, false);
    const other = mkUser(), mine = mkUser();
    guests.converted(g2, other.id);
    assert.equal(retention.adoptGuest(mine.id, g2, Date.now()).moved, false);
});

// ── HTTP ───────────────────────────────────────────────────────────────
let base = '', ipSeq = 0;
const freshIp = () => `10.7.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
async function api(p, body, { ip = freshIp(), cookie = '', origin = base } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip };
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    let json = null;
    try { json = await r.json(); } catch (e) { /* */ }
    return { status: r.status, json };
}
const code = (r) => r.json && r.json.error && r.json.error.code;
const cookieFor = (u) => 'dw_sid=' + accounts.sessions.create(u.id, { method: 'password' }).token;

test('http: a guest sees day 1, claims it, and is told when to come back', async () => {
    const g = gid();
    const s = await api('/api/daily', { guestId: g });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.on, true);
    assert.equal(s.json.day, 1);
    assert.equal(s.json.ready, true);
    assert.equal(s.json.track.length, 7);
    assert.equal(s.json.push.on, true);
    assert.equal(s.json.push.key, vapid.pub);
    assert.ok(s.json.shop && s.json.shop.name, 'a sidekick off today\'s shelf');
    const c = await api('/api/daily/claim', { guestId: g });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.claimed.gems, 300);
    assert.equal(c.json.status.ready, false);
    assert.ok(c.json.status.readyAt > Date.now() + 19 * HOUR);
    assert.equal(c.json.status.bank, 300);
    const again = await api('/api/daily/claim', { guestId: g });
    assert.equal(again.status, 409);
    assert.equal(code(again), 'not_ready');
    assert.ok(again.json.error.readyAt > Date.now());
});

test('http: accounts claim with their session; a new account adopts its browser\'s guest track', async () => {
    const g = gid();
    await api('/api/daily/claim', { guestId: g });
    const u = mkUser();
    const s = await api('/api/daily', { guestId: g }, { cookie: cookieFor(u) });
    assert.equal(s.status, 200);
    assert.equal(s.json.owner, 'account');
    assert.equal(s.json.claims, 1, 'the guest\'s day 1 came along');
    assert.ok(s.json.adoptedNow);
    assert.equal(s.json.ready, false, 'day 1 was claimed as a guest: day 2 unlocks tomorrow');
    assert.equal(s.json.day, 2);
    assert.equal(s.json.today.dustMilli, 1500, 'and as an account it pays dust too');
    const u2 = mkUser();
    const c = await api('/api/daily/claim', {}, { cookie: cookieFor(u2) });
    assert.equal(c.status, 200);
    assert.equal(c.json.claimed.dustMilli, 1000);
    assert.equal(typeof c.json.balanceMilli, 'number');
});

test('http: no owner, a cross-site post, and made-up guest ids are refused', async () => {
    assert.equal(code(await api('/api/daily', {})), 'no_owner');
    assert.equal(code(await api('/api/daily', { guestId: 'nope' })), 'no_owner');
    assert.equal((await api('/api/daily/claim', { guestId: gid() }, { origin: 'https://evil.example' })).status, 403);
    const ip = '10.66.6.6';
    let refused = 0;
    for (let i = 0; i < ratelimit.WINDOWS.dailyNew.limit + 2; i++) {
        ratelimit.clear('daily', ip);
        const r = await api('/api/daily/claim', { guestId: gid() }, { ip });
        if (r.status === 429) refused++;
    }
    assert.equal(refused, 2, 'only so many new guest tracks per address');
});

// ── push ───────────────────────────────────────────────────────────────
// a browser: its own P-256 pair and auth secret, like PushManager makes
function browserSub(host = 'fcm.googleapis.com') {
    const e = nodeCrypto.createECDH('prime256v1');
    e.generateKeys();
    const auth = nodeCrypto.randomBytes(16);
    return {
        priv: e.getPrivateKey(), auth,
        json: { endpoint: 'https://' + host + '/fcm/send/' + nodeCrypto.randomBytes(12).toString('hex'),
            keys: { p256dh: e.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    };
}
let pushed = [], reply = () => 201;
webpush.setFetchForTests(async (url, opts) => {
    pushed.push({ url, headers: opts.headers, body: opts.body });
    const st = reply(url);
    return new Response(null, { status: st, headers: st === 429 ? { 'Retry-After': '120' } : {} });
});

test('push: subscriptions are stored per owner, only for real push services', () => {
    const g = gid();
    const b = browserSub();
    assert.deepEqual(push.subscribe(G(g), b.json, {}, T0).ok, true);
    const row = d().get('SELECT * FROM push_subs WHERE endpoint = ?', b.json.endpoint);
    assert.equal(row.guest_id, g);
    assert.equal(row.user_id, null);
    assert.equal(row.daily, 1);
    for (const bad of ['http://fcm.googleapis.com/x/abcdefghijklmnopq', 'https://169.254.169.254/latest/meta-data/xx',
        'https://localhost:3000/api/admin/xxxxxxx', 'https://evil.example/fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/xxxxxxxxx',
        'https://user:pw@fcm.googleapis.com/fcm/send/xxxx']) {
        assert.equal(push.subscribe(G(g), { ...b.json, endpoint: bad }, {}, T0).code, 'bad_subscription', bad);
    }
    assert.equal(push.subscribe(G(g), { endpoint: b.json.endpoint, keys: { p256dh: 'AAAA', auth: b.json.keys.auth } }, {}, T0).code, 'bad_subscription');
    for (const host of ['updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-by3p.notify.windows.com']) {
        assert.equal(push.subscribe(G(g), browserSub(host).json, {}, T0).ok, true, host);
    }
    // the same browser logged in: the row moves to the account
    const u = mkUser();
    push.subscribe(A(u), b.json, { events: false }, T0 + 1000);
    const moved = d().get('SELECT * FROM push_subs WHERE endpoint = ?', b.json.endpoint);
    assert.equal(moved.user_id, u.id);
    assert.equal(moved.guest_id, null);
    assert.equal(moved.events, 0);
    // at most 4 devices per owner, the oldest go
    for (let i = 0; i < 6; i++) push.subscribe(A(u), browserSub().json, {}, T0 + 2000 + i);
    assert.equal(push.countFor(A(u)), push.MAX_PER_OWNER);
    assert.equal(push.unsubscribe(b.json.endpoint), false, 'the oldest was already dropped');
    const last = d().get('SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY seen_at DESC LIMIT 1', u.id).endpoint;
    assert.equal(push.unsubscribe(last), true);
    assert.equal(push.countFor(A(u)), push.MAX_PER_OWNER - 1);
});

test('push: the daily ping goes once, at the usual time, encrypted for that browser only', async () => {
    push.reset();
    d().run('DELETE FROM push_subs');
    const g = gid();
    retention.claim(G(g), T0);
    const b = browserSub();
    push.subscribe(G(g), b.json, {}, T0 + 60e3);
    d().run('UPDATE daily_track SET play_min = ? WHERE guest_id = ?', 20 * 60, g);   // usually plays 8 PM UTC
    pushed = []; reply = () => 201;
    assert.equal((await push.tick(T0 + 21 * HOUR)).sent, 0, 'unlocked, but not their time yet');
    const at = T0 + 26 * HOUR;                                     // next day 8 PM
    const r = await push.tick(at);
    assert.equal(r.daily, 1);
    assert.equal(pushed.length, 1);
    const p = pushed[0];
    assert.equal(p.url, b.json.endpoint);
    assert.equal(p.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(p.headers.Topic, 'daily');
    const msg = JSON.parse(webpush.decrypt(p.body, b.priv, b.auth).toString('utf8'));
    assert.equal(msg.title, 'Day 2 reward is ready');
    assert.match(msg.body, /^500 gems/);
    assert.ok(!/—/.test(msg.title + msg.body), 'no em dash');
    // the VAPID token: ES256 over our key, for that push service
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(p.headers.Authorization);
    assert.equal(m[2], vapid.pub);
    const [hh, cc, ss] = m[1].split('.');
    const claims = JSON.parse(Buffer.from(cc, 'base64url'));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:test@corez.io');
    const pubKey = nodeCrypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
        x: Buffer.from(vapid.pub, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(vapid.pub, 'base64url').subarray(33).toString('base64url') } });
    assert.ok(nodeCrypto.verify('sha256', Buffer.from(hh + '.' + cc), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(ss, 'base64url')));
    assert.equal((await push.tick(at + 5 * 60e3)).sent, 0, 'once per claim');
    assert.equal((await push.tick(at + 10 * HOUR)).sent, 0, 'still once');
    // they came back by themselves: no ping for the next one if seen after it unlocked
    retention.claim(G(g), at + HOUR);
    retention.status(G(g), at + HOUR + 21 * HOUR, { touch: true });
    assert.equal((await push.tick(at + HOUR + 26 * HOUR)).sent, 0, 'already back, no ping');
});

test('push: dead endpoints are dropped, errors back off, Raid Night goes out once', async () => {
    push.reset();
    d().run('DELETE FROM push_subs');
    const ev = EV.current(Date.UTC(2026, 9, 1));
    assert.ok(ev && ev.ev, 'an upcoming event in shared/events.js');
    const start = ev.ev.startMs;
    const subs = [browserSub(), browserSub(), browserSub(), browserSub()];
    subs.forEach((b, i) => push.subscribe(G(gid()), b.json, {}, start - 10 * DAYMS + i));
    reply = (url) => url === subs[0].json.endpoint ? 410 : url === subs[1].json.endpoint ? 404 : url === subs[2].json.endpoint ? 503 : 201;
    pushed = [];
    assert.equal((await push.tick(start - 50 * 60e3)).sent, 0, 'too early');
    const r = await push.tick(start - 30 * 60e3);
    assert.equal(r.event, 1);
    assert.equal(r.gone, 2);
    assert.equal(r.retry, 1);
    assert.equal(d().get('SELECT count(*) AS n FROM push_subs').n, 2, '404 and 410 deleted');
    const msg = JSON.parse(webpush.decrypt(pushed.find(p => p.url === subs[3].json.endpoint).body, subs[3].priv, subs[3].auth));
    assert.equal(msg.title, 'Raid Night in 30 minutes');
    const sick = d().get('SELECT fails, retry_at FROM push_subs WHERE endpoint = ?', subs[2].json.endpoint);
    assert.equal(sick.fails, 1);
    assert.ok(sick.retry_at > start - 30 * 60e3);
    pushed = [];
    assert.equal((await push.tick(start - 29 * 60e3)).sent, 0, 'the healthy one is not pinged twice, the sick one waits');
    assert.equal(pushed.length, 0);
    // it keeps failing: gone after MAX_FAILS
    for (let i = 0; i < push.MAX_FAILS; i++) d().run('UPDATE push_subs SET retry_at = 0 WHERE endpoint = ?', subs[2].json.endpoint), await push.tick(start - 20 * 60e3 + i);
    assert.equal(d().get('SELECT 1 AS x FROM push_subs WHERE endpoint = ?', subs[2].json.endpoint), null);
    assert.equal(push.eventDue(start - 2 * 60e3), null, 'too late to be useful');
    assert.equal(push.eventDue(start + 60e3), null, 'live: no reminder');
});

test('push: subscribe / unsubscribe over HTTP', async () => {
    const g = gid(), b = browserSub();
    const r = await api('/api/push/subscribe', { guestId: g, subscription: b.json });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(push.countFor(G(g)), 1);
    assert.equal((await api('/api/daily', { guestId: g })).json.push.subscribed, true);
    assert.equal(code(await api('/api/push/subscribe', { guestId: g, subscription: { ...b.json, endpoint: 'https://example.com/x/aaaaaaaaaaaa' } })), 'bad_subscription');
    assert.equal((await api('/api/push/unsubscribe', { endpoint: b.json.endpoint })).status, 200);
    assert.equal(push.countFor(G(g)), 0);
    assert.equal((await api('/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/never' })).status, 200, 'no oracle');
});

// ── crypto ─────────────────────────────────────────────────────────────
test('crypto: aes128gcm matches the RFC 8291 example byte for byte, and decrypts it', () => {
    const u = webpush.unb64u;
    const ua = u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
    const auth = u('BTBZMqHH6r4Tts7J_aSIgg');
    const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
    const out = webpush.encrypt('When I grow up, I want to be a watermelon', ua, auth,
        { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
    assert.equal(webpush.b64u(out), expected);
    // the intermediate values from Appendix A
    const ecdh = nodeCrypto.createECDH('prime256v1');
    ecdh.setPrivateKey(u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
    const k = webpush.derive(ecdh.computeSecret(ua), auth, ua, ecdh.getPublicKey(), u('DGv6ra1nlYgDCS1FRnbzlw'));
    assert.equal(webpush.b64u(k.ikm), 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg');
    assert.equal(webpush.b64u(k.prk), '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc');
    assert.equal(webpush.b64u(k.cek), 'oIhVW04MRdy2XN9CiKLxTg');
    assert.equal(webpush.b64u(k.nonce), '4h_95klXJ5E_qnoN');
    const plain = webpush.decrypt(u(expected), u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), auth);
    assert.equal(plain.toString(), 'When I grow up, I want to be a watermelon');
    // random salt and key every time, and a tampered body fails
    const a = webpush.encrypt('hi', ua, auth), b = webpush.encrypt('hi', ua, auth);
    assert.notEqual(webpush.b64u(a), webpush.b64u(b));
    const bad = Buffer.from(u(expected)); bad[bad.length - 1] ^= 1;
    assert.throws(() => webpush.decrypt(bad, u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), auth));
    assert.throws(() => webpush.encrypt('x'.repeat(webpush.MAX_PLAIN + 1), ua, auth), /too big/);
});

test('crypto: VAPID keys are checked (a mismatched pair turns push off)', () => {
    const other = webpush.generateKeys();
    assert.ok(webpush.parseKeys(vapid.pub, vapid.priv).value);
    assert.equal(webpush.parseKeys(other.publicKey, vapid.priv).value, null);
    assert.match(webpush.parseKeys(other.publicKey, vapid.priv).error, /does not belong/);
    assert.equal(webpush.parseKeys('', '').value, null);
    assert.equal(webpush.parseKeys('', '').error, '');
    assert.match(webpush.parseKeys('abc', 'def').error, /wrong size/);
});

test('keys: the generator writes a pair without printing the private key, and never overwrites one', () => {
    const env = path.join(ROOT, 'gen.env');
    fs.writeFileSync(env, 'PORT=3000\n');
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'gen-vapid-keys.js'), '--env', env, '--subject', 'mailto:a@b.c'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(env, 'utf8');
    const priv = /^WEB_PUSH_PRIVATE_KEY=(\S+)$/m.exec(text)[1], pub = /^WEB_PUSH_PUBLIC_KEY=(\S+)$/m.exec(text)[1];
    assert.ok(webpush.parseKeys(pub, priv).value, 'a valid pair');
    assert.ok(!r.stdout.includes(priv) && !r.stderr.includes(priv), 'the private key is never printed');
    assert.ok(r.stdout.includes(pub));
    assert.match(text, /^PORT=3000$/m);
    assert.match(text, /^WEB_PUSH_SUBJECT=mailto:a@b\.c$/m);
    assert.equal(fs.statSync(env).mode & 0o777, 0o600);
    const again = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'gen-vapid-keys.js'), '--env', env], { encoding: 'utf8' });
    assert.equal(again.status, 0);
    assert.equal(fs.readFileSync(env, 'utf8'), text, 'left alone');
});

// ── flags ──────────────────────────────────────────────────────────────
test('flags: RETENTION_DAILY=0 and WEB_PUSH=0 switch everything off', () => {
    const r = spawnSync(process.execPath, ['--no-warnings', __filename, '--flags-off'], { encoding: 'utf8', env: { ...process.env, DATA_DIR: path.join(ROOT, 'flags') } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { daily: false, claim: 'daily_off', push: false });
    const ex = fs.readFileSync(path.join(REPO, 'server', '.env.example'), 'utf8');
    for (const k of ['RETENTION_DAILY=1', 'WEB_PUSH=1', 'WEB_PUSH_PUBLIC_KEY=', 'WEB_PUSH_PRIVATE_KEY=', 'WEB_PUSH_SUBJECT=']) assert.match(ex, new RegExp('^' + k + '$', 'm'));
});

// ── migration ──────────────────────────────────────────────────────────
test('migration v12: from v11 the dust ledger is kept, the backup is written, daily rows fit', () => {
    const dir = path.join(ROOT, 'mig');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'v11.db');
    const raw = dbmod.open({ path: file, migrate: false });
    for (const m of migrations.MIGRATIONS.filter(m => m.version <= 11)) raw.tx(() => { m.up(raw); raw.exec('PRAGMA user_version = ' + m.version); });
    assert.equal(raw.userVersion(), 11);
    raw.run("INSERT INTO users (public_id, username, username_lc, created_at, dust_milli) VALUES ('DW-AAAAAAAA', 'Old', 'old', 1, 2500)");
    raw.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (1, 2500, 2500, 'quest', 'q', 1)");
    assert.throws(() => raw.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 1, 2501, 'daily', 2)"), /CHECK/);
    const r = migrations.apply(raw, { backupDir: path.join(dir, 'backups') });
    assert.deepEqual(r.applied, migrations.MIGRATIONS.filter(m => m.version >= 12).map(m => m.version));
    assert.equal(raw.userVersion(), migrations.latestVersion());
    assert.match(path.basename(r.backup), /^pre-migrate-v12-.+\.db$/);
    assert.ok(fs.existsSync(r.backup));
    const led = raw.all('SELECT id, kind, balance_milli FROM dust_ledger');
    assert.deepEqual(led.map(x => ({ ...x })), [{ id: 1, kind: 'quest', balance_milli: 2500 }]);
    raw.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (1, 1000, 3500, 'daily', 'daily:1', 3)");
    for (const t of ['daily_track', 'daily_claims', 'push_subs']) {
        assert.match(raw.get('SELECT sql FROM sqlite_master WHERE name = ?', t).sql, /\)\s*STRICT\s*$/, t + ' is STRICT');
    }
    assert.ok(raw.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'dust_ledger_user'"), 'the index came back');
    // a track is either an account's or a guest's, never both or neither
    assert.throws(() => raw.run('INSERT INTO daily_track (created_at) VALUES (1)'), /CHECK/);
    assert.throws(() => raw.run("INSERT INTO daily_track (user_id, guest_id, created_at) VALUES (1, ?, 1)", 'a'.repeat(32)), /CHECK/);
    assert.throws(() => raw.run('INSERT INTO daily_track (user_id, claims, created_at) VALUES (1, 1, 1)'), /CHECK/, 'claims need a time');
    assert.deepEqual(migrations.apply(raw).applied, [], 'nothing left to do');
    raw.close();
});

// ── client wiring ──────────────────────────────────────────────────────
test('client: scripts, service worker, finale strip and menu module are wired; no em dashes', () => {
    const PUB = path.join(REPO, 'public');
    const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
    const html = read(PUB, 'index.html');
    assert.match(html, /<script src="\/shared\/daily\.js"><\/script>/);
    const sw = read(PUB, 'service-worker.js');
    assert.match(sw, /addEventListener\(['"]push['"]/);
    assert.match(sw, /addEventListener\(['"]notificationclick['"]/);
    assert.match(sw, /\/api\/push\/unsubscribe/);
    assert.ok(!/addEventListener\(['"]fetch['"]/.test(sw), 'no fetch handler: nothing is cached or intercepted');
    const main = read(PUB, 'client', 'account', 'main.js');
    assert.match(main, /import \* as retention from '\.\/retention\.js'/);
    const fin = read(PUB, 'client', 'raidFinale.js');
    assert.match(fin, /drawComeBack\(c, 20, y, PW - 40, CB_H, now\)/);
    assert.match(fin, /Join the Discord/);
    for (const f of [path.join(PUB, 'client', 'account', 'retention.js'), path.join(PUB, 'client', 'raidFinale.js'), path.join(PUB, 'service-worker.js'),
        path.join(REPO, 'shared', 'daily.js'), path.join(REPO, 'server', 'accounts', 'retention.js'), path.join(REPO, 'server', 'accounts', 'push.js'),
        path.join(REPO, 'server', 'accounts', 'webpush.js'), path.join(REPO, 'server', 'accounts', 'routes', 'retention.js'),
        path.join(REPO, 'scripts', 'gen-vapid-keys.js')]) {
        assert.ok(!read(f).includes('—'), path.basename(f) + ' has no em dash');
    }
    // the shared module the client counts down with is served
    assert.ok(require('../../server/accounts').owns('/api/daily'));
});

// ===================================================================

async function flagsOff() {
    const log = console.log;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    accounts.initMain();
    const u = mkUser();
    const out = { daily: retention.status(A(u)).on, claim: errCode(() => retention.claim(A(u))), push: push.enabled() };
    accounts.shutdown();
    log(JSON.stringify(out));
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(0);
}

async function main() {
    if (process.argv.includes('--flags-off')) return flagsOff();
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...a) => { if (!/^\[(accounts|backup|discord|clientIp|push)\]/.test(String(a[0]))) quietLog(...a); };
    console.warn = (...a) => { if (!/^\[(accounts|backup|discord|clientIp|push)\]/.test(String(a[0]))) quietWarn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    push.stop();   // the tests drive tick() themselves
    const server = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        try { await t.fn(); quietLog('ok   ' + t.name); }
        catch (e) { failed++; quietLog('FAIL ' + t.name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 8).join('\n     ')); }
    }
    server.close();
    accounts.shutdown();
    webpush.setFetchForTests(null);
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
