// Invite / referral tests: node scripts/test/invite.test.js
//
//   migration  v3 -> v4 keeps every dust_ledger row and adds the 'referral' kind
//   codes      stable 7-char Crockford codes, look-alike folding
//   capture    a sign-up with body.ref or the dw_ref cookie records a pending
//              referral; nothing else can (existing accounts, repeats)
//   qualify    self / same browser / same network / one per address rejected,
//              a finished real life required, expiry
//   rewards    3 gemdust each, the name style at 3 and the custom skin at 5,
//              each exactly once; SSE push to the referrer
//   shop       the exclusive name style is never in a rotation, never
//              purchasable or giftable, but equips once granted
//   routes     GET /api/invite, the Discord /invites and /history referrals
//
// Data goes under $DATA_DIR if set, otherwise the OS temp dir; it is removed
// when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `invite-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-invite-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'SHOP_SEED_SALT', 'DISCORD_BOT_TOKEN']) delete process.env[k];
Object.assign(process.env, {
    NODE_ENV: 'test',
    ACCOUNTS_ENABLED: 'true',
    SESSION_SECRET: 'invite-test-secret-0123456789-abcdefghijklmnop',
    DISCORD_ADMIN_GUILD_ID: '222222222222222222',
    ADMIN_DISCORD_IDS: '333333333333333333',
});

const C = require('../../shared/cosmetics.js');
const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const migrations = require('../../server/accounts/migrations');
const referrals = require('../../server/accounts/referrals');
const store = require('../../server/accounts/store');
const events = require('../../server/accounts/routes/events');
const commands = require('../../server/accounts/discord/commands');
const users = accounts.users;
const rankStore = accounts.rankStore;

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const D = () => accounts.db.handle();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- HTTP ----
let BASE = '', ORIGIN = '';
class Jar {
    constructor(init) { this.c = { ...(init || {}) }; }
    header() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join('; '); }
    take(res) {
        for (const sc of res.headers.getSetCookie()) {
            const pair = sc.split(';')[0];
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
            if (/;\s*max-age=0/i.test(sc) || value === '') delete this.c[name];
            else this.c[name] = value;
        }
    }
}
async function req(method, p, body, opts = {}) {
    const headers = { 'X-DW': '1', Origin: ORIGIN, ...(opts.headers || {}) };
    if (opts.jar) headers.Cookie = opts.jar.header();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    if (opts.jar) opts.jar.take(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* */ }
    return { status: res.status, json, text, setCookies };
}
const from = ip => ({ 'X-Forwarded-For': ip });

let seq = 0;
const uname = p => (p || 'u') + (++seq) + 'x';
async function signup(ip, opts = {}) {
    const username = opts.username || uname('inv');
    const jar = opts.jar || new Jar();
    if (opts.cookieRef) jar.c.dw_ref = opts.cookieRef;
    const body = { username, password: 'invite-test-pass-' + seq };
    if (opts.ref) body.ref = opts.ref;
    const r = await req('POST', '/api/auth/signup', body, { jar, headers: from(ip) });
    assert.equal(r.status, 201, r.text);
    return { jar, row: users.byUsername(username), username, password: body.password, res: r };
}
const refOf = id => D().get('SELECT * FROM referrals WHERE referee_id = ?', id);

// A settled ranked life: durationMs long, `basis` points.
let lifeN = 0;
function playLife(userId, durationMs, basis = 0, reason = 'death') {
    const now = Date.now();
    const lifeId = 'life-' + (++lifeN) + '-' + userId;
    rankStore.openLife({ lifeId, userId, raidKey: 'test:1', serverId: 't', startedAt: now - durationMs, basisStart: 0, raidPtsStart: 0 });
    return rankStore.settleLife({ lifeId, userId, reason, now, basis, countedBefore: 0, durationMs, sources: [] });
}

// A referrer with a session from `ip`.
async function referrer(ip) {
    const u = await signup(ip);
    return { ...u, code: referrals.codeFor(u.row.id) };
}

// ===================================================================

test('migration: v3 -> v4 keeps dust_ledger rows and ids, adds the referral kind', () => {
    const file = path.join(ROOT, 'mig', 'v3.db');
    const db = dbmod.open({ path: file, migrate: false });
    db.tx(() => {
        for (const m of migrations.MIGRATIONS.filter(x => x.version <= 3)) m.up(db);
        db.exec('PRAGMA user_version = 3');
    });
    db.run(`INSERT INTO users (id, public_id, username, username_lc, created_at) VALUES (1, 'DW-AAAAAAAA', 'Old', 'old', 1)`);
    for (let i = 1; i <= 50; i++) {
        db.run('INSERT INTO dust_ledger (id, user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)',
            i * 3, 100, i * 100, i % 2 ? 'gems' : 'quest', 'r' + i, i);
    }
    assert.throws(() => db.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 1, 1, 'referral', 1)"), /CHECK/);
    const before = db.all('SELECT * FROM dust_ledger ORDER BY id');
    const res = migrations.apply(db, { backupDir: path.join(ROOT, 'mig', 'backups') });
    assert.deepEqual(res.applied, migrations.MIGRATIONS.filter(x => x.version >= 4).map(x => x.version));
    assert.ok(res.backup && fs.existsSync(res.backup), 'pre-migration backup');
    assert.equal(db.userVersion(), migrations.latestVersion());
    assert.deepEqual(db.all('SELECT * FROM dust_ledger ORDER BY id'), before);
    db.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 1, 1, 'referral', 1)");
    assert.throws(() => db.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 1, 1, 'bogus', 1)"), /CHECK/);
    assert.ok(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'dust_ledger_user'"));
    assert.equal(db.get('PRAGMA foreign_key_check'), null);
    assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
    // the ledger still cascades with its user
    db.run('DELETE FROM users WHERE id = 1');
    assert.equal(db.get('SELECT count(*) AS n FROM dust_ledger').n, 0);
    db.close();
});

test('codes: stable, 7 Crockford chars, unique, look-alikes fold', async () => {
    const a = await signup('198.51.100.1'), b = await signup('198.51.100.2');
    const ca = referrals.codeFor(a.row.id), cb = referrals.codeFor(b.row.id);
    assert.match(ca, /^[0-9A-HJKMNP-TV-Z]{7}$/);
    assert.equal(referrals.codeFor(a.row.id), ca, 'stable');
    assert.notEqual(ca, cb);
    assert.equal(referrals.normalizeCode(ca.toLowerCase()), ca);
    assert.equal(referrals.normalizeCode(ca.slice(0, 3) + '-' + ca.slice(3)), ca);
    assert.equal(referrals.normalizeCode('0O1IL00'), '0011100');
    assert.equal(referrals.normalizeCode('SHORT'), '');
    assert.equal(referrals.normalizeCode('<script>'), '');
    assert.equal(referrals.normalizeCode({}), '');
    assert.equal(referrals.ownerOf(ca.toLowerCase()).id, a.row.id);
    assert.equal(referrals.ownerOf('ZZZZZZZ'), null);
    assert.equal(referrals.linkFor(ca), accounts.config.publicOrigin + '/?ref=' + ca);
    // a banned owner's code does nothing
    D().run('UPDATE users SET banned_until = ? WHERE id = ?', Date.now() + DAY, b.row.id);
    assert.equal(referrals.ownerOf(cb), null);
    D().run('UPDATE users SET banned_until = NULL WHERE id = ?', b.row.id);
});

test('capture: body.ref and the dw_ref cookie record a pending referral, the cookie is cleared', async () => {
    const A = await referrer('198.51.101.1');
    const viaBody = await signup('198.51.101.2', { ref: A.code.toLowerCase() });
    let r = refOf(viaBody.row.id);
    assert.equal(r.referrer_id, A.row.id);
    assert.equal(r.status, 'pending');
    assert.equal(r.method, 'password');
    assert.match(r.ip_hash, /^[0-9a-f]{32}$/);
    assert.notEqual(r.ip_hash, '198.51.101.2');
    const viaCookie = await signup('198.51.101.3', { cookieRef: A.code });
    r = refOf(viaCookie.row.id);
    assert.equal(r && r.status, 'pending');
    assert.ok(viaCookie.res.setCookies.some(c => /^dw_ref=;/.test(c) && /Max-Age=0/i.test(c)), 'dw_ref cleared');
    // unknown or junk codes: a normal sign-up, no row
    const junk = await signup('198.51.101.4', { ref: 'ZZZZZZZ' });
    assert.equal(refOf(junk.row.id), null);
    const none = await signup('198.51.101.5');
    assert.equal(refOf(none.row.id), null);
});

test('capture: existing accounts cannot be referred', async () => {
    const A = await referrer('198.51.102.1');
    const old = await signup('198.51.102.2');
    // logging in with a code does nothing
    const lr = await req('POST', '/api/auth/login', { username: old.username, password: old.password, ref: A.code }, { headers: from('198.51.102.2') });
    assert.equal(lr.status, 200);
    assert.equal(refOf(old.row.id), null);
    // an account older than the sign-up request is refused outright
    D().run('UPDATE users SET created_at = ? WHERE id = ?', Date.now() - 10 * MIN, old.row.id);
    assert.equal(referrals.recordSignup({ user: old.row, method: 'password', code: A.code, ip: '198.51.102.9' }), null);
    assert.equal(refOf(old.row.id), null);
    // and one referral per account, ever
    const fresh = await signup('198.51.102.3', { ref: A.code });
    const B = await referrer('198.51.102.4');
    assert.equal(referrals.recordSignup({ user: fresh.row, method: 'password', code: B.code, ip: '198.51.102.3' }), null);
    assert.equal(refOf(fresh.row.id).referrer_id, A.row.id);
});

test('qualify: own code in the same browser (dw_dev) and the same network are rejected', async () => {
    const A = await referrer('198.51.103.1');
    // A logs out and makes an alt in the same browser, from another address
    await req('POST', '/api/auth/logout', {}, { jar: A.jar, headers: from('198.51.103.1') });
    assert.ok(A.jar.c.dw_dev, 'browser remembers A');
    const alt = await signup('198.51.103.77', { jar: A.jar, ref: A.code });
    assert.deepEqual([refOf(alt.row.id).status, refOf(alt.row.id).reason], ['rejected', 'same_device']);
    // same address as A's session
    const alt2 = await signup('198.51.103.1', { ref: A.code });
    assert.deepEqual([refOf(alt2.row.id).status, refOf(alt2.row.id).reason], ['rejected', 'same_network']);
    // IPv6: same /64 counts as the same network
    const V = await referrer('2001:db8:1:2::10');
    const v6 = await signup('2001:db8:1:2::99', { ref: V.code });
    assert.equal(refOf(v6.row.id).reason, 'same_network');
    // a rejected referral never pays, even after a real life
    playLife(alt2.row.id, 5 * MIN, 100);
    assert.equal(referrals.evaluate(alt2.row.id), null);
    assert.equal(D().get('SELECT dust_milli FROM users WHERE id = ?', A.row.id).dust_milli, 0);
});

test('qualify: needs a finished life of real length', async () => {
    const A = await referrer('198.51.104.1');
    const F = await signup('198.51.104.2', { ref: A.code });
    assert.equal(referrals.evaluate(F.row.id), null, 'no life yet');
    playLife(F.row.id, 20 * 1000, 0);
    assert.equal(referrals.evaluate(F.row.id), null, '20 s, no points');
    playLife(F.row.id, 20 * 1000, 50);
    assert.equal(referrals.evaluate(F.row.id), null, '20 s even with points');
    playLife(F.row.id, 10 * MIN, 0, 'shutdown');
    assert.equal(referrals.evaluate(F.row.id), null, 'a server shutdown is not a finished life');
    rankStore.openLife({ lifeId: 'open-' + F.row.id, userId: F.row.id, raidKey: 'k', startedAt: Date.now() - 10 * MIN, basisStart: 0, raidPtsStart: 0 });
    assert.equal(referrals.evaluate(F.row.id), null, 'an open life does not count');
    assert.equal(refOf(F.row.id).status, 'pending');
    playLife(F.row.id, 40 * 1000, 25);
    const res = referrals.evaluate(F.row.id);
    assert.equal(res.status, 'qualified');
    assert.equal(refOf(F.row.id).status, 'qualified');

    const G = await signup('198.51.104.3', { ref: A.code });
    playLife(G.row.id, 2 * MIN + 1000, 0);
    assert.equal(referrals.evaluate(G.row.id).status, 'qualified', '2 minutes without points');
});

test('qualify: a later session on the referrer\'s network rejects it', async () => {
    const A = await referrer('198.51.105.1');
    const F = await signup('198.51.105.2', { ref: A.code });
    assert.equal(refOf(F.row.id).status, 'pending');
    const lr = await req('POST', '/api/auth/login', { username: F.username, password: F.password }, { headers: from('198.51.105.1') });
    assert.equal(lr.status, 200);
    playLife(F.row.id, 3 * MIN, 10);
    assert.deepEqual(referrals.evaluate(F.row.id), { status: 'rejected', reason: 'same_network' });
});

test('qualify: one counted invite per address', async () => {
    const A = await referrer('198.51.106.1');
    const B = await referrer('198.51.106.2');
    const F1 = await signup('203.0.113.50', { ref: A.code });
    const F2 = await signup('203.0.113.50', { ref: B.code });
    const F3 = await signup('203.0.113.50', { ref: A.code });
    for (const f of [F1, F2, F3]) playLife(f.row.id, 3 * MIN, 10);
    assert.equal(referrals.evaluate(F1.row.id).status, 'qualified');
    assert.deepEqual(referrals.evaluate(F2.row.id), { status: 'rejected', reason: 'ip_used' });
    assert.deepEqual(referrals.evaluate(F3.row.id), { status: 'rejected', reason: 'ip_used' });
    // the index backs it up
    assert.throws(() => D().run("UPDATE referrals SET status = 'qualified', reason = NULL WHERE referee_id = ?", F2.row.id), /UNIQUE/);
});

test('qualify: pending invites expire after 30 days', async () => {
    const A = await referrer('198.51.107.1');
    const F = await signup('198.51.107.2', { ref: A.code });
    D().run('UPDATE referrals SET created_at = ? WHERE referee_id = ?', Date.now() - referrals.PENDING_TTL_MS - 1000, F.row.id);
    referrals.sweep();
    assert.deepEqual([refOf(F.row.id).status, refOf(F.row.id).reason], ['rejected', 'expired']);
});

test('rewards: 3 gemdust each, name style at 3, custom skin at 5, each once; SSE push', async () => {
    const pushed = [];
    const realPush = events.push;
    events.push = (userId, type, data) => { pushed.push({ userId, type, data }); return 0; };
    try {
        const A = await referrer('198.51.108.1');
        const friends = [];
        for (let i = 0; i < 6; i++) friends.push(await signup('192.0.2.' + (10 + i), { ref: A.code }));
        for (let i = 0; i < 6; i++) {
            playLife(friends[i].row.id, 3 * MIN, 20);
            if (i === 1) {
                // through the bus, as the game reports it
                accounts.bus.toMain({ t: 'lifeSettled', userId: friends[i].row.id });
                await new Promise(r => setImmediate(r));
                await new Promise(r => setImmediate(r));
            } else {
                assert.equal(referrals.evaluate(friends[i].row.id).status, 'qualified');
            }
            assert.equal(refOf(friends[i].row.id).status, 'qualified', 'friend ' + i);
            const owned = store.owns(A.row.id, C.INVITE_STYLE_ID);
            assert.equal(owned, i >= 2, 'name style after the 3rd, not before (' + i + ')');
        }
        // again, from every path: nothing more is paid or granted
        referrals.sweep();
        referrals.evaluateFor(A.row.id);
        for (const f of friends) assert.equal(referrals.evaluate(f.row.id), null);

        const row = users.byId(A.row.id);
        assert.equal(row.dust_milli, 6 * 3000);
        const led = D().all("SELECT delta_milli, ref FROM dust_ledger WHERE user_id = ? AND kind = 'referral' ORDER BY id", A.row.id);
        assert.equal(led.length, 6);
        assert.ok(led.every(l => l.delta_milli === 3000 && /^referral:\d+$/.test(l.ref)));
        const item = D().get('SELECT source FROM owned_items WHERE user_id = ? AND item_id = ?', A.row.id, C.INVITE_STYLE_ID);
        assert.equal(item.source, 'grant');
        assert.deepEqual(D().all('SELECT tier FROM referral_rewards WHERE user_id = ? ORDER BY tier', A.row.id).map(r => r.tier), ['custom_skin', 'name_style']);
        assert.equal(D().get("SELECT count(*) AS n FROM audit_log WHERE user_id = ? AND action = 'referral_skin_earned'", A.row.id).n, 1);
        assert.equal(D().get("SELECT count(*) AS n FROM audit_log WHERE user_id = ? AND action = 'referral_name_style'", A.row.id).n, 1);

        const mine = pushed.filter(p => p.userId === A.row.id && p.type === 'invite');
        assert.equal(mine.length, 6);
        assert.equal(mine[0].data.username, friends[0].username);
        assert.equal(mine[0].data.rewardMilli, 3000);
        assert.deepEqual(mine[2].data.granted, ['name_style']);
        assert.deepEqual(mine[4].data.granted, ['custom_skin']);
        assert.deepEqual(mine[5].data.granted, []);

        const s = referrals.summary(A.row.id);
        assert.equal(s.count, 6);
        assert.equal(s.rewards.dustEarnedMilli, 18000);
        assert.equal(s.rewards.nameStyle.unlocked, true);
        assert.equal(s.rewards.customSkin.unlocked, true);

        // the granted style equips like anything else
        const eq = store.equip(A.row.id, 'nameStyle', C.INVITE_STYLE_ID);
        assert.equal(eq.equipped.nameStyle, C.INVITE_STYLE_ID);
        assert.equal(store.cosmeticsFor(users.byId(A.row.id)).nameStyleNid, C.INVITE_STYLE_ID && C.byId(C.INVITE_STYLE_ID).nid);
    } finally {
        events.push = realPush;
    }
});

test('rewards: dust stops after PAID_MAX friends, the count does not', async () => {
    const A = await referrer('198.51.109.1');
    const d = D();
    // PAID_MAX counted invites already on the books
    for (let i = 0; i < referrals.PAID_MAX; i++) {
        d.run(`INSERT INTO referrals (referrer_id, referee_id, code, method, status, ip_hash, created_at, decided_at, reward_milli)
               VALUES (?, NULL, ?, 'password', 'qualified', ?, ?, ?, 3000)`, A.row.id, A.code, 'cap' + i, Date.now(), Date.now());
    }
    const F = await signup('192.0.2.200', { ref: A.code });
    playLife(F.row.id, 3 * MIN, 5);
    const res = referrals.evaluate(F.row.id);
    assert.equal(res.status, 'qualified');
    assert.equal(res.rewardMilli, 0);
    assert.equal(users.byId(A.row.id).dust_milli, 0);
    assert.equal(referrals.summary(A.row.id).count, referrals.PAID_MAX + 1);
});

test('shop: the exclusive name style is never sold, gifted or rotated', async () => {
    const it = C.byId(C.INVITE_STYLE_ID);
    assert.ok(it && it.exclusive && it.cat === 'nameStyle' && !it.permanent);
    for (const s of it.style.stops) assert.ok(C.isColorAllowed(s), s);
    for (let day = 0; day < 2000; day++) {
        const g = store.generate(day, []);
        assert.ok(!g.featured.includes(it.id) && !g.daily.includes(it.id), 'day ' + day);
    }
    const today = store.dayOf(Date.now());
    // force it into today's stored rotation: purchase still refuses it
    D().run('INSERT OR REPLACE INTO shop_rotations (day, featured, daily, created_at) VALUES (?, ?, ?, ?)',
        today, JSON.stringify([it.id, 'ns_aurora']), JSON.stringify(['ns_sunset']), Date.now());
    const buyer = await signup('198.51.110.1');
    D().run('UPDATE users SET dust_milli = 1000000 WHERE id = ?', buyer.row.id);
    const code = fn => { try { fn(); return 'ok'; } catch (e) { return e.status + ':' + e.code; } };
    assert.equal(code(() => store.purchase(buyer.row.id, { itemId: it.id, day: today, idempotencyKey: 'inv-test-key-1' })), '404:not_in_shop');
    const view = store.storeView(buyer.row);
    assert.ok(!view.permanent.some(x => x.id === it.id));
    const friend = await signup('198.51.110.2');
    D().run('INSERT INTO friendships (user_lo, user_hi, created_at) VALUES (?, ?, ?)', Math.min(buyer.row.id, friend.row.id), Math.max(buyer.row.id, friend.row.id), Date.now() - 5 * DAY);
    assert.equal(code(() => store.gift(buyer.row.id, { itemId: it.id, day: today, toUserId: friend.row.public_id, idempotencyKey: 'inv-test-key-2' })), '404:not_in_shop');
    assert.equal(code(() => store.equip(buyer.row.id, 'nameStyle', it.id)), '403:not_owned');
    assert.equal(users.byId(buyer.row.id).dust_milli, 1000000);
    D().run('DELETE FROM shop_rotations WHERE day = ?', today);
});

test('routes: GET /api/invite (guest 401, code + link + generic statuses)', async () => {
    const guest = await req('GET', '/api/invite', undefined, { headers: from('198.51.111.9') });
    assert.equal(guest.status, 401);
    const A = await signup('198.51.111.1');
    let r = await req('GET', '/api/invite', undefined, { jar: A.jar, headers: from('198.51.111.1') });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.code, /^[0-9A-HJKMNP-TV-Z]{7}$/);
    assert.equal(r.json.link, accounts.config.publicOrigin + '/?ref=' + r.json.code);
    assert.equal(r.json.count, 0);
    assert.equal(r.json.rewards.perFriendMilli, 3000);
    assert.equal(r.json.rewards.nameStyle.itemId, C.INVITE_STYLE_ID);
    const code = r.json.code;
    const ok = await signup('192.0.2.77', { ref: code });
    const bad = await signup('198.51.111.1', { ref: code });
    playLife(ok.row.id, 3 * MIN, 5);
    // opening the panel decides anything that is ready
    r = await req('GET', '/api/invite', undefined, { jar: A.jar, headers: from('198.51.111.1') });
    assert.equal(r.json.count, 1);
    assert.equal(r.json.rewards.dustEarnedMilli, 3000);
    const byName = new Map(r.json.recent.map(x => [x.username, x]));
    assert.equal(byName.get(ok.username).status, 'qualified');
    assert.equal(byName.get(bad.username).status, 'rejected');
    assert.equal(byName.get(bad.username).reason, 'not_eligible', 'no detail for the referrer');
    assert.ok(!('ip_hash' in r.json.recent[0]));
});

test('discord: /invites for a player, /history referrals and /lookup for admins', async () => {
    const A = await referrer('198.51.112.1');
    const F = await signup('192.0.2.140', { ref: A.code });
    playLife(F.row.id, 3 * MIN, 5);
    referrals.evaluate(F.row.id);
    const pub = commands.handle({ type: 2, data: { name: 'invites', options: [{ name: 'username', value: A.username }] }, user: { id: '999999999999999999' } });
    const emb = pub.data.embeds[0];
    assert.match(emb.description, /\*\*1\*\* friend joined/);
    assert.match(emb.description, /Ringleader/);
    assert.ok(!emb.description.includes(A.code), 'someone else\'s link is not shown');
    assert.ok(commands.PLAYER_COMMANDS.some(c => c.name === 'invites' && c.integration_types && c.contexts));
    const admin = { type: 2, guild_id: '222222222222222222', member: { user: { id: '333333333333333333' } } };
    const hist = commands.handle({ ...admin, data: { name: 'history', options: [{ name: 'user', value: A.username }, { name: 'what', value: 'referrals' }] } });
    assert.match(hist.data.embeds[0].description, new RegExp(F.username));
    assert.match(hist.data.embeds[0].description, /qualified/);
    const look = commands.handle({ ...admin, data: { name: 'lookup', options: [{ name: 'query', value: A.username }] } });
    assert.match(look.data.content, /Invites: 1 counted/);
    const choices = commands.ADMIN_COMMANDS.find(c => c.name === 'history').options[1].choices.map(c => c.value);
    assert.ok(choices.includes('referrals'));
});

async function main() {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietLog(...a); };
    console.warn = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietWarn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    const server = http.createServer((q, s) => { if (!accounts.handleHttp(q, s)) { s.writeHead(418); s.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    BASE = `http://127.0.0.1:${server.address().port}`;
    ORIGIN = `http://localhost:${server.address().port}`;
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        accounts.ratelimit.reset();
        const started = Date.now();
        try {
            await t.fn();
            quietLog(`ok   ${t.name} (${Date.now() - started} ms)`);
        } catch (e) {
            failed++;
            quietLog(`FAIL ${t.name}\n     ${((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')}`);
        }
    }
    server.close();
    accounts.shutdown();
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
