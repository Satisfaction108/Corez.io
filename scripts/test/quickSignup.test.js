// One-tap "Keep my stuff" sign-up (no password): node scripts/test/quickSignup.test.js
//
//   quick      POST /api/auth/quick makes a passwordless account, a session and a recovery code
//   names      the username rules, profanity filter and holds apply
//   limits     the per-IP sign-up cap (shared with password sign-ups)
//   referral   an invite code is recorded like any sign-up
//   guest      the guest's bank, stats and achievements move onto it
//   login      password login turns it away cleanly
//   recover    the recovery code logs it in elsewhere (no new password), once
//   password   a password can be added later from a live session
//   nudge      client/keepNudgeLogic.js: when a guest's raid results ask
//
// Same throwaway-database setup as accounts.test.js.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-quick-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI']) delete process.env[k];
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'quick-test-secret-0123456789-abcdefghijklmnop';

const accounts = require('../../server/accounts');
const users = accounts.users;
const sessions = accounts.sessions;
const ratelimit = accounts.ratelimit;
const D = () => accounts.db.handle();
const guests = require('../../server/accounts/guests');
const banks = require('../../server/accounts/banks');
const achievements = require('../../server/accounts/achievements');
const referrals = require('../../server/accounts/referrals');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let BASE = '', ORIGIN = '';
class Jar {
    constructor() { this.c = {}; }
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
    const headers = { Origin: ORIGIN, ...(opts.headers || {}) };
    if (opts.jar) headers.Cookie = opts.jar.header();
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
    if (opts.jar) opts.jar.take(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* */ }
    return { status: res.status, json, text, setCookies: res.headers.getSetCookie() };
}
const get = (p, opts) => req('GET', p, undefined, opts);
const post = (p, body, opts) => req('POST', p, body === undefined ? {} : body, opts);
const errCode = r => r.json && r.json.error && r.json.error.code;
const from = ip => ({ 'X-Forwarded-For': ip });
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
function expireReauth(jar) {
    const found = sessions.fromCookieHeader(jar.header());
    assert.ok(found, 'jar has a live session');
    D().run('UPDATE sessions SET reauth_until = 0 WHERE id = ?', found.session.id);
}

const Q = { jar: new Jar(), name: 'Quick_Digger', id: 0, code: '' };

test('quick: a passwordless account, logged in, with a recovery code', async () => {
    ratelimit.reset();
    const r = await post('/api/auth/quick', { username: Q.name, password: 'ignored-anyway-1' }, { jar: Q.jar });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.user.username, Q.name);
    assert.equal(r.json.user.hasPassword, false);
    assert.equal(r.json.user.discord, null);
    assert.match(r.json.recoveryCode, CODE_RE);
    Q.code = r.json.recoveryCode;
    const sc = r.setCookies.find(c => c.startsWith('dw_sid='));
    assert.ok(sc && sc.includes('HttpOnly') && sc.includes('Max-Age=5184000'), 'long-lived session cookie');
    assert.ok(r.setCookies.some(c => c.startsWith('dw_dev=')), 'device cookie');
    const row = users.byUsername(Q.name);
    Q.id = row.id;
    assert.equal(row.password_hash, null, 'no password stored (the sent one is ignored)');
    assert.ok(row.recovery_hash.startsWith('scrypt$'));
    const audit = D().get("SELECT detail FROM audit_log WHERE user_id = ? AND action = 'signup'", Q.id);
    assert.deepEqual(JSON.parse(audit.detail), { method: 'quick' });
    const me = await get('/api/me', { jar: Q.jar });
    assert.equal(me.json.user.username, Q.name);
    assert.equal(me.json.user.hasPassword, false);
});

test('quick: a session cookie already in the browser is replaced, not reused', async () => {
    ratelimit.reset();
    const jar = new Jar();
    jar.c.dw_sid = 'attacker-chosen-token-0123456789abcdef';
    const r = await post('/api/auth/quick', { username: 'Fixation_Dig' }, { jar });
    assert.equal(r.status, 201, r.text);
    assert.notEqual(jar.c.dw_sid, 'attacker-chosen-token-0123456789abcdef');
    assert.equal(sessions.fromToken('attacker-chosen-token-0123456789abcdef'), null);
});

test('names: rules, profanity, taken and held names apply', async () => {
    ratelimit.reset();
    let r = await post('/api/auth/quick', { username: 'QUICK_DIGGER' });
    assert.equal(r.status, 409);
    assert.equal(errCode(r), 'username_taken');
    r = await post('/api/auth/quick', { username: 'admin' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.reason, 'reserved');
    r = await post('/api/auth/quick', { username: 'sh1t_lord' });
    assert.equal(r.json.error.reason, 'profanity');
    r = await post('/api/auth/quick', { username: 'ab' });
    assert.equal(errCode(r), 'invalid_username');
    r = await post('/api/auth/quick', { username: 'has space' });
    assert.equal(errCode(r), 'invalid_username');
    r = await post('/api/auth/quick', { username: { x: 1 } });
    assert.equal(errCode(r), 'invalid_username');
    r = await post('/api/auth/quick', {});
    assert.equal(errCode(r), 'invalid_username');
    // a renamed account's old name stays held for it
    const u = users.create({ username: 'Holder_One', recoveryHash: null }).user;
    assert.ok(users.rename(u.id, 'Holder_Two').ok);
    r = await post('/api/auth/quick', { username: 'holder_one' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.reason, 'held');
    // no account was made by any of these
    assert.equal(D().get("SELECT COUNT(*) AS c FROM users WHERE username_lc IN ('admin','sh1t_lord','ab')").c, 0);
});

test('limits: the per-IP account cap applies, shared with password sign-ups', async () => {
    ratelimit.reset();
    const cap = ratelimit.WINDOWS.signup.limit;
    const ip = { headers: from('203.0.113.7') };
    const pw = await post('/api/auth/signup', { username: 'Cap_Pw', password: 'cap-pass-0000' }, ip);
    assert.equal(pw.status, 201, pw.text);
    for (let i = 1; i < cap; i++) {
        const r = await post('/api/auth/quick', { username: 'Cap_Quick' + i }, ip);
        assert.equal(r.status, 201, r.text);
    }
    let r = await post('/api/auth/quick', { username: 'Cap_Quick_X' }, ip);
    assert.equal(r.status, 429);
    assert.equal(errCode(r), 'rate_limited');
    r = await post('/api/auth/signup', { username: 'Cap_Pw2', password: 'cap-pass-1111' }, ip);
    assert.equal(r.status, 429, 'password sign-up shares the cap');
    r = await post('/api/auth/quick', { username: 'Cap_Other' }, { headers: from('198.51.100.9') });
    assert.equal(r.status, 201, 'another address is fine');
    // failed attempts are capped too (signupTry)
    ratelimit.reset();
    const tries = ratelimit.WINDOWS.signupTry.limit;
    for (let i = 0; i < tries; i++) await post('/api/auth/quick', { username: 'admin' }, ip);
    r = await post('/api/auth/quick', { username: 'Fine_Name' }, ip);
    assert.equal(r.status, 429);
    ratelimit.reset();
});

test('csrf: a cross-site or form post is refused like the other auth routes', async () => {
    const res = await fetch(BASE + '/api/auth/quick', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"username":"Csrf_Dig"}' });
    assert.equal(res.status, 403);
    const res2 = await fetch(BASE + '/api/auth/quick', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=Csrf_Dig' });
    assert.equal(res2.status, 415);
    assert.equal(users.byUsername('Csrf_Dig'), null);
});

test('referral: an invite code is recorded and the cookie dropped', async () => {
    ratelimit.reset();
    const referrer = users.create({ username: 'Ref_Owner', recoveryHash: null }).user;
    const code = referrals.codeFor(referrer.id);
    const jar = new Jar();
    jar.c[referrals.REF_COOKIE] = code;
    const r = await post('/api/auth/quick', { username: 'Ref_Friend' }, { jar });
    assert.equal(r.status, 201, r.text);
    const row = D().get('SELECT referrer_id, referee_id FROM referrals WHERE referee_id = ?', users.byUsername('Ref_Friend').id);
    assert.ok(row, 'referral recorded');
    assert.equal(row.referrer_id, referrer.id);
    assert.equal(jar.c[referrals.REF_COOKIE], undefined, 'ref cookie cleared');
});

test('guest: the bank, stats and achievements move onto the quick account', async () => {
    ratelimit.reset();
    const g = 'c'.repeat(31) + '1';
    guests.seen(g, Date.now(), null);
    guests.life(g, { kills: 2, botKills: 4, score: 700, ms: 90000 });
    banks.checkout('g:' + g, 'seed-q');
    banks.release('seed-q', 2500);
    const def = achievements.DEFS.find(d => !d.secret && d.rewardMilli > 0 && !d.id.startsWith('c:'));
    D().run('INSERT INTO guest_achievements (guest_id, achievement_id, progress, unlocked_at) VALUES (?, ?, ?, ?)', g, def.id, def.goal, Date.now() - 1000);
    const jar = new Jar();
    const r = await post('/api/auth/quick', { username: 'Guest_Keeper' }, { jar });
    assert.equal(r.status, 201, r.text);
    const uid = users.byUsername('Guest_Keeper').id;
    // what bridge.js onGuestId does when this browser connects logged in
    assert.equal(guests.converted(g, uid), true);
    assert.equal(banks.claimGuest(g, uid), 2500);
    assert.equal(banks.peek('a:' + uid), 2500);
    const s = D().get('SELECT lives, kills, bot_kills, play_ms FROM user_stats WHERE user_id = ?', uid);
    assert.deepEqual({ ...s }, { lives: 1, kills: 2, bot_kills: 4, play_ms: 90000 });
    // and what the menu's achievements panel does (POST /api/achievements)
    const a = await post('/api/achievements', { guestId: g }, { jar });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.guest, false);
    assert.deepEqual(a.json.adoptedNow.ids, [def.id]);
    assert.equal(a.json.adoptedNow.rewardMilli, def.rewardMilli);
});

test('login: a password login is turned away cleanly', async () => {
    ratelimit.reset();
    for (const password of ['', 'anything-at-all', 'x'.repeat(2000)]) {
        const r = await post('/api/auth/login', { username: Q.name, password });
        assert.equal(r.status, 401, r.text);
        assert.equal(errCode(r), 'bad_credentials');
    }
    const r = await post('/api/auth/login', { username: Q.name, password: null });
    assert.equal(r.status, 401);
    ratelimit.reset();
});

test('recover: the code logs a new device in without a password, once', async () => {
    ratelimit.reset();
    let r = await post('/api/auth/recover', { username: Q.name, recoveryCode: 'AAAA-BBBB-CCCC', newPassword: '' });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_recovery');
    const phone = new Jar();
    r = await post('/api/auth/recover', { username: Q.name.toUpperCase(), recoveryCode: Q.code.toLowerCase() }, { jar: phone });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.username, Q.name);
    assert.equal(r.json.user.hasPassword, false);
    assert.match(r.json.recoveryCode, CODE_RE);
    assert.notEqual(r.json.recoveryCode, Q.code);
    assert.equal((await get('/api/me', { jar: phone })).json.user.username, Q.name, 'new device logged in');
    assert.equal((await get('/api/me', { jar: Q.jar })).json.user.username, Q.name, 'the first device stays logged in');
    assert.equal(users.byId(Q.id).password_hash, null);
    assert.ok(D().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'recovery_login'", Q.id));
    r = await post('/api/auth/recover', { username: Q.name, recoveryCode: Q.code, newPassword: '' });
    assert.equal(r.status, 401, 'a used code does not work twice');
    Q.phone = phone;
    ratelimit.reset();
});

test('recover: an account WITH a password still has to pick a new one', async () => {
    ratelimit.reset();
    const jar = new Jar();
    let r = await post('/api/auth/signup', { username: 'Pw_Holder', password: 'pw-holder-123' }, { jar });
    assert.equal(r.status, 201);
    const code = r.json.recoveryCode;
    r = await post('/api/auth/recover', { username: 'Pw_Holder', recoveryCode: code, newPassword: '' });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'weak_password');
    assert.equal(r.setCookies.find(c => c.startsWith('dw_sid=') && !/max-age=0/i.test(c)), undefined, 'no session');
    r = await post('/api/auth/recover', { username: 'Pw_Holder', recoveryCode: code, newPassword: 'pw-holder-456' });
    assert.equal(r.status, 200, 'the code was not spent by the refusal');
    ratelimit.reset();
});

test('password: a quick account adds one later from its session, then logs in with it', async () => {
    ratelimit.reset();
    expireReauth(Q.jar);
    // sensitive changes past the first 10 minutes ask for a password first
    let r = await post('/api/account/username', { username: 'Quick_Renamed' }, { jar: Q.jar });
    assert.equal(r.status, 403);
    assert.equal(errCode(r), 'password_needed');
    r = await post('/api/auth/reauth', {}, { jar: Q.jar });
    assert.equal(r.status, 403);
    assert.equal(errCode(r), 'password_needed');
    // a weak one is still refused
    r = await post('/api/account/password', { newPassword: 'password1' }, { jar: Q.jar });
    assert.equal(errCode(r), 'weak_password');
    // no old password needed when there is none
    r = await post('/api/account/password', { newPassword: 'quick-now-has-1' }, { jar: Q.jar });
    assert.equal(r.status, 204, r.text);
    assert.ok(users.byId(Q.id).password_hash);
    assert.ok(D().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'password_set'", Q.id));
    assert.equal((await get('/api/me', { jar: Q.jar })).json.user.hasPassword, true);
    assert.equal((await get('/api/me', { jar: Q.phone })).json.user, null, 'other sessions revoked, as for any new password');
    r = await post('/api/auth/login', { username: Q.name, password: 'quick-now-has-1' });
    assert.equal(r.status, 200, r.text);
    // now the usual rules: changing it needs the current one
    r = await post('/api/account/password', { newPassword: 'quick-other-22' }, { jar: Q.jar });
    assert.equal(r.status, 401);
    // and it can open the re-auth window (to link Discord) with it
    r = await post('/api/auth/reauth', { currentPassword: 'quick-now-has-1' }, { jar: Q.jar });
    assert.equal(r.status, 204);
    ratelimit.reset();
});

test('password: inside its first 10 minutes a quick account can open the link window', async () => {
    ratelimit.reset();
    const jar = new Jar();
    assert.equal((await post('/api/auth/quick', { username: 'Fresh_Quick' }, { jar })).status, 201);
    const r = await post('/api/auth/reauth', {}, { jar });
    assert.equal(r.status, 204);
});

test('password: a Discord-only account still needs a fresh Discord check for its first password', async () => {
    const u = users.create({ username: 'Disc_Only', recoveryHash: null, discord: { id: '999000999000999000', name: 'd', avatar: null } }).user;
    const s = sessions.create(u.id, { method: 'discord', reauth: false });
    const jar = new Jar();
    jar.c.dw_sid = s.token;
    const r = await post('/api/account/password', { newPassword: 'disc-only-pass-1' }, { jar });
    assert.equal(r.status, 403);
    assert.equal(errCode(r), 'reauth_required');
});

test('nudge: when a guest\'s raid results offer "Keep my stuff"', async () => {
    const KL = await import('../../public/client/keepNudgeLogic.js');
    const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
    const T0 = 1e12;
    let st = mem();
    // accounts never; the first raid is nobody's personal best
    assert.equal(KL.decide({ guest: false, raidId: 1, place: 1, isWin: true, now: T0 }, st), null);
    st = mem();
    assert.equal(KL.decide({ guest: true, raidId: 1, place: 9, score: 900, prevBest: 0, now: T0 }, st), null);
    // the 2nd finished raid asks once
    let o = KL.decide({ guest: true, raidId: 2, place: 9, score: 100, prevBest: 900, now: T0 }, st);
    assert.equal(o.why, 'second');
    assert.equal(o.headline, 'Keep your progress?');
    assert.equal(KL.decide({ guest: true, raidId: 2, place: 1, isWin: true, now: T0 }, st), null, 'once per raid');
    assert.equal(KL.decide({ guest: true, raidId: 3, place: 9, score: 100, prevBest: 900, now: T0 }, st), null, 'only on the 2nd');
    o = KL.decide({ guest: true, raidId: 4, place: 9, score: 4210, prevBest: 900, now: T0 }, st);
    assert.equal(o.headline, 'New best: 4,210. Keep it?');
    o = KL.decide({ guest: true, raidId: 5, place: 3, score: 10, prevBest: 4210, now: T0 }, st);
    assert.equal(o.headline, 'Top 3! Keep your stats?');
    o = KL.decide({ guest: true, raidId: 6, place: 1, isWin: true, now: T0 }, st);
    assert.equal(o.why, 'win');
    // "Not now": quiet for a day, then back
    KL.dismiss(st, T0);
    assert.equal(KL.decide({ guest: true, raidId: 7, place: 1, isWin: true, now: T0 + 3600e3 }, st), null);
    assert.ok(KL.decide({ guest: true, raidId: 8, place: 1, isWin: true, now: T0 + KL.QUIET_MS + 1 }, st));
    // a storage that throws (private mode) never breaks the results
    const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
    assert.doesNotThrow(() => KL.decide({ guest: true, raidId: 9, place: 1, isWin: true }, bad));
    assert.equal(KL.decide({ guest: true, raidId: 9, place: 1 }, null), null);
    // a top 3 on the 2nd raid uses up the 2nd-raid ask
    st = mem();
    KL.decide({ guest: true, raidId: 1, place: 9, now: T0 }, st);
    assert.equal(KL.decide({ guest: true, raidId: 2, place: 2, now: T0 }, st).why, 'top3');
    assert.equal(KL.decide({ guest: true, raidId: 3, place: 9, now: T0 }, st), null);
});

(async () => {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietLog(...a); };
    console.warn = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietWarn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    const server = http.createServer((rq, rs) => { if (!accounts.handleHttp(rq, rs)) { rs.writeHead(418); rs.end('static'); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    BASE = `http://127.0.0.1:${port}`;
    ORIGIN = `http://localhost:${port}`;
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); quietLog('ok   ' + t.name); }
        catch (e) { failed++; quietLog('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
    }
    server.close();
    try { accounts.shutdown(); } catch (e) { /* */ }
    quietLog(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
})();
