// Accounts backend tests (Phase 1): node scripts/test/accounts.test.js
//
// Runs against a throwaway database: a fresh folder under $DATA_DIR if that
// is set (point it at a scratch directory), otherwise under the OS temp dir.
// The HTTP layer is driven through a bare http.createServer that only calls
// accounts.handleHttp, so no game server is needed. Discord is faked by
// swapping the OAuth module's fetch.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ---- environment (before the accounts modules are loaded) ----
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `accounts-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-accounts-test-'));
const DATA_DIR = path.join(ROOT, 'data');
process.env.DATA_DIR = DATA_DIR;
delete process.env.DB_PATH;
delete process.env.PUBLIC_HOST;
delete process.env.PUBLIC_ORIGIN;
delete process.env.ALLOWED_ORIGINS;
delete process.env.DISCORD_CLIENT_ID;
delete process.env.DISCORD_CLIENT_SECRET;
delete process.env.DISCORD_REDIRECT_URI;
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'accounts-test-secret-0123456789-abcdefghijklmnop';

const accounts = require('../../server/accounts');
const C = accounts.crypto;
const N = accounts.names;
const users = accounts.users;
const sessions = accounts.sessions;
const dbmod = accounts.db;
const migrations = require('../../server/accounts/migrations');
const discordOAuth = require('../../server/accounts/routes/discordOAuth');

const S = String.fromCharCode;
const DAY = 24 * 60 * 60 * 1000;

// ---- tiny runner ----
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- HTTP helpers ----
let BASE = '';      // what fetch dials
let ORIGIN = '';    // what the browser would send as Origin

class Jar {
    constructor(init) { this.c = { ...(init || {}) }; }
    header() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join('; '); }
    take(res) {
        for (const sc of res.headers.getSetCookie()) {
            const pair = sc.split(';')[0];
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (/;\s*max-age=0/i.test(sc) || value === '') delete this.c[name];
            else this.c[name] = value;
        }
    }
    clone() { return new Jar(this.c); }
}

async function req(method, p, body, opts = {}) {
    const headers = { 'X-DW': '1', ...(opts.headers || {}) };
    if (opts.origin !== null) headers.Origin = opts.origin || ORIGIN;
    if (opts.jar) headers.Cookie = opts.jar.header();
    let payload;
    if (body !== undefined) {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
        if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    if (opts.jar) opts.jar.take(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers, setCookies, location: res.headers.get('location') };
}
const get = (p, opts) => req('GET', p, undefined, opts);
const post = (p, body, opts) => req('POST', p, body === undefined ? {} : body, opts);

function errCode(r) { return r.json && r.json.error && r.json.error.code; }

// The test server's peer is loopback, which clientIp trusts, so this is how
// a request "comes from" another client address (as Caddy would send it).
const from = ip => ({ 'X-Forwarded-For': ip });

function tally(results) {
    const out = {};
    for (const r of results) {
        const k = r.status + (errCode(r) ? ':' + errCode(r) : '');
        out[k] = (out[k] || 0) + 1;
    }
    return out;
}

function expireReauth(jar) {
    const found = sessions.fromCookieHeader(jar.header());
    assert.ok(found, 'jar has a live session');
    dbmod.handle().run('UPDATE sessions SET reauth_until = 0 WHERE id = ?', found.session.id);
}

const kicks = [];
accounts.bus.onGame(msg => kicks.push(msg));

// ---- fake Discord ----
const DISCORD_USERS = {
    'code-new': { id: '111111111111111111', username: 'newdigger', global_name: 'New Digger', avatar: 'a_' + 'f'.repeat(32) },
    'code-link': { id: '222222222222222222', username: 'linker', global_name: null, avatar: null },
    'code-third': { id: '444444444444444444', username: 'third', global_name: 'Third', avatar: null },
    'code-fourth': { id: '555555555555555555', username: 'fourth', global_name: 'Fourth', avatar: null },
    'code-victim': { id: '666666666666666666', username: 'victim', global_name: 'Victim', avatar: null },
    'code-thief': { id: '777777777777777777', username: 'thief', global_name: 'Thief', avatar: null },
};
const revokedTokens = [];
let tokenExchanges = 0;
async function fakeDiscordFetch(url, init = {}) {
    if (url.endsWith('/oauth2/token')) {
        tokenExchanges++;
        assert.match(String(init.headers.Authorization), /^Basic /);
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('grant_type'), 'authorization_code');
        const code = form.get('code');
        if (!DISCORD_USERS[code]) return new Response('{"error":"invalid_grant"}', { status: 400 });
        return Response.json({ access_token: 'tok-' + code, token_type: 'Bearer', scope: 'identify' });
    }
    if (url.endsWith('/users/@me')) {
        const code = String(init.headers.Authorization).replace('Bearer tok-', '');
        return Response.json(DISCORD_USERS[code]);
    }
    if (url.endsWith('/oauth2/token/revoke')) {
        revokedTokens.push(new URLSearchParams(init.body).get('token'));
        return new Response(null, { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
}

// Runs /auth/discord/start + /callback with the given code; returns the
// callback's redirect target.
async function discordFlow(jar, mode, code, opts = {}) {
    const start = await get('/auth/discord/start?mode=' + mode, { jar, headers: opts.headers });
    assert.equal(start.status, 302);
    if (!start.location.startsWith('https://discord.com/')) return { start: start.location, callback: null };
    const state = new URL(start.location).searchParams.get('state');
    if (opts.beforeCallback) opts.beforeCallback(jar);
    const cb = await get(`/auth/discord/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(opts.state || state)}`, { jar, headers: opts.headers });
    assert.equal(cb.status, 302);
    return { start: start.location, callback: cb.location, res: cb, startRes: start };
}

// ===================================================================
// Unit tests
// ===================================================================

test('crypto: scrypt hash round trip and tamper rejection', async () => {
    const h = await C.hashPassword('correct horse battery');
    assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await C.verifyPassword('correct horse battery', h), true);
    assert.equal(await C.verifyPassword('correct horse batterx', h), false);
    const parts = h.split('$');
    const hash = Buffer.from(parts[5], 'base64');
    hash[0] ^= 1;
    assert.equal(await C.verifyPassword('correct horse battery', [...parts.slice(0, 5), hash.toString('base64')].join('$')), false);
    assert.equal(await C.verifyPassword('correct horse battery', h.replace('$32768$', '$16384$')), false);
    assert.equal(await C.verifyPassword('x', null), false);
    assert.equal(await C.verifyPassword('x', 'scrypt$garbage'), false);
    assert.equal(await C.dummyVerify('anything'), false);
    assert.notEqual(await C.hashPassword('same'), await C.hashPassword('same'), 'salted');
});

test('crypto: signed values round trip; tamper, expiry and purpose rejected', () => {
    const t = C.sign('pending', { d: '123456789', n: 'Name' }, 60000);
    assert.equal(C.verifySigned('pending', t).d, '123456789');
    assert.equal(C.verifySigned('oauth', t), null, 'wrong purpose');
    const [body, sig] = t.split('.');
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    obj.d = '999999999';
    assert.equal(C.verifySigned('pending', Buffer.from(JSON.stringify(obj)).toString('base64url') + '.' + sig), null, 'body tamper');
    const badSig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    assert.equal(C.verifySigned('pending', body + '.' + badSig), null, 'sig tamper');
    assert.equal(C.verifySigned('pending', C.sign('pending', { d: '1' }, -1)), null, 'expired');
    for (const junk of ['', 'abc', 'a.b.c', '.x', undefined, null, 42]) assert.equal(C.verifySigned('pending', junk), null);
    assert.equal(C.randomToken().length, 43);
    assert.match(C.sha256('x'), /^[0-9a-f]{64}$/);
});

test('crypto: Crockford base32, public ids and recovery codes', () => {
    assert.equal(C.crockfordEncode(Buffer.from([0, 0, 0, 0, 0])), '00000000');
    assert.equal(C.crockfordEncode(Buffer.from([255, 255, 255, 255, 255])), 'ZZZZZZZZ');
    assert.equal(C.crockfordNormalize('abcd-efgh-ijkl'), 'ABCDEFGH1JK1');
    assert.equal(C.crockfordNormalize(' o0 Il - oO '), '001100');
    const ids = new Set();
    for (let i = 0; i < 200; i++) {
        const id = C.newPublicId();
        assert.match(id, /^DW-[0-9A-HJKMNP-TV-Z]{8}$/);
        ids.add(id);
    }
    assert.equal(ids.size, 200);
    const code = C.newRecoveryCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const typed = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    assert.equal(C.normalizeRecoveryCode(typed), code.replace(/-/g, ''));
    assert.equal(C.normalizeRecoveryCode('UUUU-UUUU-UUUU'), null, 'U is not Crockford');
    assert.equal(C.normalizeRecoveryCode('ABC'), null);
});

test('names: username validation (length, chars, underscores, reserved, leet profanity)', () => {
    for (const ok of ['Cool_Guy_99', 'abc', 'grape_juice', 'Scunthorpe', 'a_b', 'xX_Pro_Xx', '_lead', 'trail_', 'Digger__2']) {
        assert.deepEqual(N.validateUsername(ok), { ok: true }, ok);
    }
    const reason = n => N.validateUsername(n).reason;
    assert.equal(reason('ab'), 'too_short');
    assert.equal(reason('a'.repeat(17)), 'too_long');
    assert.equal(reason('bad name'), 'invalid_chars');
    assert.equal(reason('bad-name'), 'invalid_chars');
    assert.equal(reason('caf' + S(0xE9)), 'invalid_chars');
    assert.equal(reason('____'), 'underscores');
    assert.equal(reason('a___b'), 'underscores');
    assert.equal(reason(''), 'type');
    assert.equal(reason(null), 'type');
    for (const r of ['admin', 'Adm1n', 'ADMIN_bob', 'Moderator', 'DigWars', 'digwars_team', 'm_o_d', 'Sys_Admin', 'Guest', 'nu11']) {
        assert.equal(reason(r), 'reserved', r);
    }
    for (const p of ['sh1t_lord', 'BigShitGuy', 'xXH1tl3rXx', 'fuuuck', 'Sh1tHead', 'f_u_c_k', 'shit99']) {
        assert.equal(reason(p), 'profanity', p);
    }
    assert.ok(N.validateUsername('admin').message, 'has a human message');
});

test('names: guest name sanitising (section sign, bidi, zero-width, controls, length)', () => {
    assert.equal(N.sanitizeGuestName(S(0xA7) + 'cRed' + S(0xA7) + 'r'), 'cRedr');
    assert.equal(N.sanitizeGuestName(S(0x202E) + 'evil' + S(0x202C)), 'evil');
    assert.equal(N.sanitizeGuestName(S(0x2066) + 'iso' + S(0x2069) + S(0x200F) + S(0x200E) + S(0x061C)), 'iso');
    assert.equal(N.sanitizeGuestName('a' + S(0x200B) + 'b' + S(0xFEFF) + 'c' + S(0x200D) + 'd' + S(0x2060)), 'abcd');
    assert.equal(N.sanitizeGuestName('a' + S(0) + S(7) + S(0x1B) + S(0x7F) + S(0x85) + 'b'), 'ab');
    assert.equal(N.sanitizeGuestName('  a \t\n  b  '), 'a b');
    assert.equal(N.sanitizeGuestName(S(0x3164)), '', 'hangul filler blank name');
    assert.equal(N.sanitizeGuestName('x'.repeat(40)), 'x'.repeat(24));
    const emoji = String.fromCodePoint(0x1F600);
    assert.equal(Array.from(N.sanitizeGuestName(emoji.repeat(30))).length, 24, 'counts code points');
    assert.equal(N.sanitizeGuestName('x' + S(0x301).repeat(12)), 'x' + S(0x301) + S(0x301), 'zalgo capped');
    assert.equal(N.sanitizeGuestName(null), '');
    assert.equal(N.sanitizeGuestName(undefined), '');
    assert.equal(N.sanitizeGuestName(123), '123');
});

test('names: password rules', () => {
    const reason = (p, u) => N.validatePassword(p, u).reason;
    assert.equal(reason('short'), 'too_short');
    assert.equal(reason('a'.repeat(129)), 'too_long');
    assert.equal(reason('password123'), 'common');
    assert.equal(reason('PassWord123'), 'common');
    assert.equal(reason('CoolGuy99', 'coolguy99'), 'same_as_username');
    assert.equal(reason(undefined), 'type');
    assert.deepEqual(N.validatePassword('correct horse battery', 'someone'), { ok: true });
    assert.ok(N.COMMON_PASSWORDS.size >= 180);
});

test('names: foldConfusables (Cyrillic, Greek, fullwidth, accents; digits kept)', () => {
    const F = N.foldConfusables;
    // Cyrillic i, e, O, e
    assert.equal(F('D' + S(0x456) + 'gg' + S(0x435) + 'r_' + S(0x41E) + 'n' + S(0x435)), 'digger_one');
    assert.equal(F(S(0x430, 0x435, 0x43E, 0x440, 0x441, 0x443, 0x445, 0x456, 0x458, 0x455, 0x501, 0x261, 0x578)), 'aeopcyxijsdgn');
    assert.equal(F(S(0x391, 0x392, 0x395, 0x396, 0x397, 0x399, 0x39A, 0x39C, 0x39D, 0x39F, 0x3A1, 0x3A4, 0x3A5, 0x3A7)), 'abezhikmnoptyx');
    assert.equal(F(S(0xFF24, 0xFF49, 0xFF47, 0xFF47, 0xFF45, 0xFF52, 0xFF3F, 0xFF11)), 'digger_1', 'fullwidth');
    assert.equal(F('D' + S(0x308) + 'igge' + S(0x301, 0x301) + 'r'), 'digger', 'combining marks');
    assert.equal(F(S(0xC9) + 'cole'), 'ecole', 'precomposed accent');
    assert.equal(F('Digger01'), 'digger01', 'digits are not folded');
    assert.equal(F('Cool_Guy_99'), 'cool_guy_99', 'ASCII folds to its lowercase');
    assert.equal(F(null), '');
});

test('ratelimit: ipKey groups IPv6 by /64; IPv4 (and ::ffff:-mapped) unchanged', () => {
    const K = accounts.ratelimit.ipKey;
    assert.equal(K('203.0.113.9'), '203.0.113.9');
    assert.equal(K('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(K('::FFFF:cb00:7109'), '203.0.113.9', 'hex-written mapped address');
    assert.equal(K('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(K('2001:0DB8:0001:0002:ffff:eeee:dddd:cccc'), '2001:db8:1:2::/64');
    assert.equal(K('[2001:db8:1:2::77]'), '2001:db8:1:2::/64');
    assert.equal(K('fe80::1%en0'), 'fe80:0:0:0::/64');
    assert.equal(K('2001:db8:1:2::192.0.2.1'), '2001:db8:1:2::/64');
    assert.notEqual(K('2001:db8:1:2::1'), K('2001:db8:1:3::1'));
    assert.equal(K('not-an-ip'), 'not-an-ip');
});

test('ratelimit: take() checks everything before charging, and refunds', () => {
    const R = accounts.ratelimit;
    R.reset();
    const now = Date.now();
    for (let i = 0; i < 5; i++) assert.ok(R.take([['loginFail', 'k1'], ['loginIpFail', 'ip1']], now).ok);
    // loginFail k1 is full: nothing else may be charged by the failing take.
    const blocked = R.take([['loginIpFail', 'ip1'], ['loginFail', 'k1']], now);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfter > 0);
    let ipCount = 0;
    while (R.take([['loginIpFail', 'ip1']], now).ok) ipCount++;
    assert.equal(ipCount, R.WINDOWS.loginIpFail.limit - 5, 'the blocked take charged nothing');
    // Refund hands the event back (and only once).
    R.reset();
    const t = R.take([['passwordFail', 7], null, ['loginUser', 'someone']], now);
    for (let i = 0; i < 4; i++) R.take([['passwordFail', 7]], now);
    assert.equal(R.check('passwordFail', 7, now).ok, false);
    t.refund();
    t.refund();
    assert.equal(R.check('passwordFail', 7, now).ok, true);
    assert.ok(R.take([['passwordFail', 7]], now).ok);
    assert.equal(R.take([['passwordFail', 7]], now).ok, false);
    R.reset();
});

test('crypto: scrypt gate runs 2 at a time, queues 32, then fails fast with BusyError', async () => {
    const h = await C.hashPassword('gate-test-pass');
    assert.deepEqual(C.scryptLoad(), { active: 0, queued: 0 });
    assert.deepEqual(C.SCRYPT_GATE, { max: 2, queueMax: 32 });
    const jobs = Array.from({ length: 40 }, () => C.verifyPassword('gate-test-pass', h));
    assert.deepEqual(C.scryptLoad(), { active: 2, queued: 32 });
    // Unknown-user dummy checks go through the same gate.
    const dummy = C.dummyVerify('whatever');
    const settled = await Promise.allSettled([...jobs, dummy]);
    const fulfilled = settled.filter(x => x.status === 'fulfilled');
    const rejected = settled.filter(x => x.status === 'rejected');
    assert.equal(fulfilled.length, 34);
    assert.ok(fulfilled.every(x => x.value === true), 'queued checks still give the right answer');
    assert.equal(rejected.length, 7);
    assert.ok(rejected.every(x => x.reason instanceof C.BusyError && x.reason.code === 'busy'));
    assert.equal(settled[40].status, 'rejected', 'dummyVerify was refused too');
    assert.deepEqual(C.scryptLoad(), { active: 0, queued: 0 }, 'gate drains');
    assert.equal(await C.verifyPassword('gate-test-pass', h), true);
    assert.equal(await C.dummyVerify('whatever'), false);
});

// ===================================================================
// Database and migrations
// ===================================================================

test('db: file permissions, schema, pragmas', () => {
    const d = dbmod.handle();
    assert.ok(d, 'initMain opened the database');
    assert.equal(fs.statSync(DATA_DIR).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(DATA_DIR, 'digwars.db')).mode & 0o777, 0o600);
    const tables = d.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(r => r.name);
    for (const t of ['users', 'username_holds', 'sessions', 'password_resets', 'rank_lives', 'raid_results', 'dust_ledger',
        'purchases', 'owned_items', 'shop_rotations', 'friendships', 'friend_requests', 'blocks', 'user_stats',
        'user_achievements', 'daily_quests', 'audit_log', 'meta']) {
        assert.ok(tables.includes(t), 'table ' + t);
        assert.match(d.get("SELECT sql FROM sqlite_master WHERE name = ?", t).sql, /\)\s*STRICT\s*$/, t + ' is STRICT');
    }
    assert.equal(d.userVersion(), migrations.latestVersion());
    assert.equal(d.get('PRAGMA journal_mode').journal_mode, 'wal');
    assert.equal(d.get('PRAGMA foreign_keys').foreign_keys, 1);
    assert.equal(d.get('PRAGMA busy_timeout').timeout, 5000);
    // Row objects are plain.
    assert.equal(Object.getPrototypeOf(d.get('SELECT 1 AS x')), Object.prototype);
    // CHECKs hold.
    assert.throws(() => d.run('INSERT INTO friendships (user_lo, user_hi, created_at) VALUES (2, 1, 0)'), /CHECK|FOREIGN/);
});

test('db: nested tx rolls back only the savepoint; async callbacks refused', async () => {
    const d = dbmod.handle();
    d.tx(() => {
        d.run("INSERT INTO meta (key, value) VALUES ('t-outer', '1')");
        assert.throws(() => d.tx(() => {
            d.run("INSERT INTO meta (key, value) VALUES ('t-inner', '1')");
            throw new Error('boom');
        }), /boom/);
    });
    assert.ok(d.get("SELECT 1 AS x FROM meta WHERE key = 't-outer'"));
    assert.equal(d.get("SELECT 1 AS x FROM meta WHERE key = 't-inner'"), null);
    assert.throws(() => d.tx(async () => { d.run("INSERT INTO meta (key, value) VALUES ('t-async', '1')"); }), /synchronous/);
    await new Promise(r => setImmediate(r));
    assert.equal(d.get("SELECT 1 AS x FROM meta WHERE key = 't-async'"), null);
    d.run("DELETE FROM meta WHERE key LIKE 't-%'");
});

test('migrations: idempotent, pre-migrate backup, newer schema refused', () => {
    const dir = path.join(ROOT, 'mig');
    const file = path.join(dir, 'a.db');
    const a = dbmod.open({ path: file, migrate: true });
    assert.equal(a.userVersion(), 1);
    a.close();
    const b = dbmod.open({ path: file, migrate: true });
    assert.equal(b.userVersion(), 1);
    assert.deepEqual(migrations.apply(b).applied, [], 'second run applies nothing');
    b.close();
    assert.ok(!fs.existsSync(path.join(dir, 'backups')), 'no backup for a brand new file or a no-op');

    // Existing non-empty v0 file gets a VACUUM INTO copy first.
    const legacy = path.join(dir, 'legacy.db');
    const raw = dbmod.open({ path: legacy, migrate: false });
    raw.exec("CREATE TABLE legacy (x INTEGER) STRICT; INSERT INTO legacy VALUES (7);");
    raw.close();
    const m = dbmod.open({ path: legacy, migrate: true, backupDir: path.join(dir, 'backups') });
    assert.equal(m.userVersion(), 1);
    m.close();
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^pre-migrate-v1-.+\.db$/);
    assert.equal(fs.statSync(path.join(dir, 'backups', backups[0])).mode & 0o777, 0o600);
    const copy = dbmod.open({ path: path.join(dir, 'backups', backups[0]), migrate: false });
    assert.equal(copy.get('SELECT x FROM legacy').x, 7);
    assert.equal(copy.userVersion(), 0);
    copy.close();

    // A file from a newer build is left alone.
    const future = dbmod.open({ path: path.join(dir, 'future.db'), migrate: false });
    future.exec('PRAGMA user_version = 99');
    future.close();
    const origError = console.error;
    console.error = () => {};
    try {
        assert.equal(dbmod.open({ path: path.join(dir, 'future.db'), migrate: true }), null);
    } finally {
        console.error = origError;
    }
});

// ===================================================================
// HTTP: routing, CSRF, config
// ===================================================================

test('http: route ownership and JSON 404s', async () => {
    const fakeReq = url => ({ url, method: 'GET', headers: {}, socket: {} });
    assert.equal(accounts.owns('/api/getAddonAuthors'), false);
    assert.equal(accounts.owns('/api/sendPlayer'), false);
    assert.equal(accounts.owns('/index.html'), false);
    assert.equal(accounts.owns('/apix'), false);
    assert.equal(accounts.handleHttp(fakeReq('/api/getAddonAuthors?token=x'), {}), false);
    assert.equal(accounts.handleHttp(fakeReq('/client/app.js'), {}), false);

    const stat = await get('/index.html');
    assert.equal(stat.status, 418, 'not claimed: falls through to the static server');
    for (const p of ['/api/nope', '/api', '/auth/nope', '/discord/interactions-soon', '/api/me/']) {
        const r = await get(p);
        assert.equal(r.status, 404, p);
        assert.equal(errCode(r), 'not_found', p);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.match(r.headers.get('content-type'), /^application\/json/);
    }
    const wrongMethod = await post('/api/me', {});
    assert.equal(wrongMethod.status, 405);
});

test('http: /api/config and guest /api/me', async () => {
    const cfg = await get('/api/config');
    assert.equal(cfg.status, 200);
    assert.deepEqual(cfg.json, { accounts: true, discordLogin: false, publicOrigin: 'http://localhost:3000' });
    const me = await get('/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json, { user: null, pendingDiscord: null });
    assert.equal(me.headers.get('cache-control'), 'no-store');
});

test('http: CSRF (Origin 403, Sec-Fetch-Site 403, content-type 415), body limits', async () => {
    const body = { username: 'Csrf_Tester', password: 'tunnel-vision-42' };
    let r = await post('/api/auth/signup', body, { origin: null });
    assert.equal(r.status, 403);
    assert.equal(errCode(r), 'bad_origin');
    r = await post('/api/auth/signup', body, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await post('/api/auth/signup', body, { origin: 'null' });
    assert.equal(r.status, 403);
    r = await post('/api/auth/signup', body, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
    r = await post('/api/auth/signup', JSON.stringify(body), { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 415);
    assert.equal(errCode(r), 'unsupported_media_type');
    r = await post('/api/auth/signup', 'username=x', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 415);
    r = await post('/api/auth/signup', '{"username":', {});
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'bad_json');
    r = await post('/api/auth/signup', '[1,2]', {});
    assert.equal(r.status, 400);
    r = await post('/api/auth/signup', { username: 'x', pad: 'y'.repeat(20 * 1024) });
    assert.equal(r.status, 413);
    // Same-origin fetches (Sec-Fetch-Site: same-origin, charset param) pass the guard.
    r = await post('/api/auth/signup', { username: 'ab', password: 'x' }, { headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' } });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'invalid_username');
    assert.equal(dbmod.handle().get("SELECT count(*) AS n FROM users WHERE username_lc = 'csrf_tester'").n, 0);
});

// ===================================================================
// HTTP: signup, login, sessions
// ===================================================================

const A = { jar: new Jar(), username: 'Digger_One', password: 'tunnel-vision-42', id: 0, recovery: '' };

test('signup: creates the account, returns the User shape, recovery code and session cookie', async () => {
    const r = await post('/api/auth/signup', { username: A.username, password: A.password }, { jar: A.jar });
    assert.equal(r.status, 201, r.text);
    const u = r.json.user;
    assert.match(u.userId, /^DW-[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.equal(u.username, 'Digger_One');
    assert.equal(u.hasPassword, true);
    assert.equal(u.discord, null);
    assert.equal(typeof u.createdAt, 'number');
    assert.equal(u.usernameChangeAt, 0);
    // RankSnap (Phase 2): a new account is in placement
    assert.deepEqual(u.rank, {
        division: null, name: 'Unranked', tier: null, rp: 0, into: 0, size: 0, pct: 0,
        placement: { done: false, lives: 0, of: 3 }, legendNo: 0, peak: { division: null, name: 'Unranked' },
    });
    assert.equal(u.dust, 0);
    assert.equal(u.refundTokens, 3);
    assert.deepEqual(u.equipped, { nameStyle: null, skin: null, customColor: null });
    assert.deepEqual(Object.keys(u).sort(), ['createdAt', 'discord', 'dust', 'equipped', 'hasPassword', 'rank', 'refundTokens', 'userId', 'username', 'usernameChangeAt']);
    assert.match(r.json.recoveryCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    A.recovery = r.json.recoveryCode;
    const sc = r.setCookies.find(c => c.startsWith('dw_sid='));
    assert.ok(sc, 'session cookie set');
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=5184000']) assert.ok(sc.includes(attr), attr);
    assert.ok(!sc.includes('Secure'), 'no Secure over http');
    const row = users.byUsername('digger_one');
    A.id = row.id;
    assert.ok(row.recovery_hash.startsWith('scrypt$'));
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'signup'", A.id));

    const me = await get('/api/me', { jar: A.jar });
    assert.equal(me.json.user.username, 'Digger_One');
    assert.equal(me.json.user.userId, u.userId);
});

test('signup: taken / invalid / weak / availability', async () => {
    let r = await post('/api/auth/signup', { username: 'DIGGER_ONE', password: 'another-pass-77' });
    assert.equal(r.status, 409);
    assert.equal(errCode(r), 'username_taken');
    r = await post('/api/auth/signup', { username: 'admin', password: 'another-pass-77' });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'invalid_username');
    assert.equal(r.json.error.reason, 'reserved');
    r = await post('/api/auth/signup', { username: 'sh1t_lord', password: 'another-pass-77' });
    assert.equal(r.json.error.reason, 'profanity');
    r = await post('/api/auth/signup', { username: 'Fresh_Digger', password: 'password123' });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'weak_password');
    assert.equal(r.json.error.reason, 'common');
    r = await post('/api/auth/signup', { username: 'Fresh_Digger', password: 'fresh_digger' });
    assert.equal(r.json.error.reason, 'same_as_username');
    r = await post('/api/auth/signup', { username: 42, password: ['x'] });
    assert.equal(errCode(r), 'invalid_username');

    assert.deepEqual((await get('/api/auth/username-available?name=DIGGER_ONE')).json, { available: false, reason: 'taken' });
    assert.deepEqual((await get('/api/auth/username-available?name=Fresh_Digger')).json, { available: true });
    assert.deepEqual((await get('/api/auth/username-available?name=ab')).json, { available: false, reason: 'too_short' });
    assert.deepEqual((await get('/api/auth/username-available?name=Digger_One', { jar: A.jar })).json, { available: true }, 'own name');
});

test('signup: capped accounts per IP per hour, then 429', async () => {
    accounts.ratelimit.reset();
    const cap = accounts.ratelimit.WINDOWS.signup.limit;
    for (let i = 0; i < cap; i++) {
        const r = await post('/api/auth/signup', { username: 'Limit_Dig' + i, password: 'limit-pass-' + i + 'xx' });
        assert.equal(r.status, 201, r.text);
    }
    const r = await post('/api/auth/signup', { username: 'Limit_Dig' + cap, password: 'limit-pass-capxx' });
    assert.equal(r.status, 429);
    assert.equal(errCode(r), 'rate_limited');
    assert.ok(r.json.error.retryAfter > 0);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    accounts.ratelimit.reset();
});

test('login: wrong password 401, lockout 429 after 5, then success sets a session', async () => {
    accounts.ratelimit.reset();
    let r = await post('/api/auth/login', { username: 'nobody_at_all', password: 'whatever-pass' });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_credentials');
    for (let i = 0; i < 5; i++) {
        r = await post('/api/auth/login', { username: A.username, password: 'wrong-password-' + i });
        assert.equal(r.status, 401, 'attempt ' + i);
        assert.equal(errCode(r), 'bad_credentials');
    }
    r = await post('/api/auth/login', { username: A.username, password: A.password });
    assert.equal(r.status, 429, 'locked out even with the right password');
    assert.equal(errCode(r), 'rate_limited');
    assert.ok(r.json.error.retryAfter > 0 && r.json.error.retryAfter <= 15 * 60);
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'login_locked'", A.id));
    accounts.ratelimit.reset();

    const jar = new Jar();
    r = await post('/api/auth/login', { username: 'dIgGeR_oNe', password: A.password }, { jar });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.username, 'Digger_One');
    assert.ok(jar.c.dw_sid);
    A.jar2 = jar;
});

test('sessions: fromCookieHeader parses the cookie and joins the user', () => {
    const found = sessions.fromCookieHeader('other=1; ' + A.jar2.header() + '; x=y');
    assert.ok(found);
    assert.equal(found.user.id, A.id);
    assert.equal(found.user.username, 'Digger_One');
    assert.equal(found.session.user_id, A.id);
    assert.ok(found.session.expires_at > Date.now() + 59 * DAY);
    assert.ok(found.session.reauth_until > Date.now(), 'password login opens the reauth window');
    assert.equal(Object.getPrototypeOf(found.user), Object.prototype);
    assert.equal(sessions.fromCookieHeader('dw_sid=' + 'x'.repeat(43)), null);
    assert.equal(sessions.fromCookieHeader('dw_sid=short'), null);
    assert.equal(sessions.fromCookieHeader(''), null);
    assert.equal(sessions.fromCookieHeader(undefined), null);
    assert.equal(users.byId(A.id).username, 'Digger_One');
    assert.equal(users.byId(999999), null);
    assert.equal(users.byPublicId(users.toPublic(users.byId(A.id)).userId.toLowerCase()).id, A.id);
    assert.equal(users.isRegisteredName('DIGGER_ONE'), true);
    assert.equal(users.isRegisteredName('nobody_here'), false);
    assert.equal(users.isRegisteredName('~weird name'), false);
});

test('sessions: rolling touch at most hourly re-sends the cookie', async () => {
    const found = sessions.fromCookieHeader(A.jar2.header());
    let r = await get('/api/me', { jar: A.jar2 });
    assert.equal(r.setCookies.length, 0, 'fresh session: no re-send');
    dbmod.handle().run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', Date.now() - 2 * 60 * 60 * 1000, Date.now() + DAY, found.session.id);
    r = await get('/api/me', { jar: A.jar2 });
    assert.ok(r.setCookies.some(c => c.startsWith('dw_sid=') && c.includes('Max-Age=5184000')));
    assert.ok(sessions.fromCookieHeader(A.jar2.header()).session.expires_at > Date.now() + 59 * DAY);
});

test('logout: 204, clears the cookie, kills only that session', async () => {
    const old = A.jar2.header();
    const r = await post('/api/auth/logout', {}, { jar: A.jar2 });
    assert.equal(r.status, 204);
    assert.ok(r.setCookies.some(c => c.startsWith('dw_sid=;') && c.includes('Max-Age=0')));
    assert.equal(A.jar2.c.dw_sid, undefined);
    assert.equal(sessions.fromCookieHeader(old), null);
    const stale = await get('/api/me', { jar: new Jar(Object.fromEntries([old.split('=')])) });
    assert.equal(stale.json.user, null);
    assert.ok(stale.setCookies.some(c => c.startsWith('dw_sid=;')), 'stale cookie cleared');
    assert.equal((await get('/api/me', { jar: A.jar })).json.user.username, 'Digger_One', 'other session alive');
    assert.equal((await post('/api/auth/logout', {})).status, 204, 'logout without a session is fine');
});

test('login: banned accounts get 403 banned {until, reason}', async () => {
    const until = Date.now() + 60 * 60 * 1000;
    dbmod.handle().run('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?', until, 'testing bans', A.id);
    try {
        const r = await post('/api/auth/login', { username: A.username, password: A.password });
        assert.equal(r.status, 403);
        assert.equal(errCode(r), 'banned');
        assert.equal(r.json.error.until, until);
        assert.equal(r.json.error.reason, 'testing bans');
        assert.equal((await get('/api/me', { jar: A.jar })).json.user, null, 'banned: /api/me shows nobody');
        assert.ok(sessions.fromCookieHeader(A.jar.header()).user.banned_until, 'game bridge still sees the banned row');
    } finally {
        dbmod.handle().run('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?', A.id);
    }
});

// ===================================================================
// HTTP: abuse limits (bursts, IPv6, busy, known devices)
// ===================================================================

async function signupAt(ip, username, password, jar = new Jar()) {
    const r = await post('/api/auth/signup', { username, password }, { jar, headers: from(ip) });
    assert.equal(r.status, 201, r.text);
    return { jar, id: users.byUsername(username).id, recovery: r.json.recoveryCode, username, password };
}

test('login: 200 parallel wrong passwords from one IP -> 5 checked (401), the rest 429', async () => {
    accounts.ratelimit.reset();
    const u = await signupAt('198.18.0.1', 'Burst_Target', 'burst-target-pass-1');
    const rs = await Promise.all(Array.from({ length: 200 }, (_, i) =>
        post('/api/auth/login', { username: 'Burst_Target', password: 'wrong-guess-' + i }, { headers: from('198.18.0.2') })));
    assert.deepEqual(tally(rs), { '401:bad_credentials': 5, '429:rate_limited': 195 });
    const locked = await post('/api/auth/login', { username: u.username, password: u.password }, { headers: from('198.18.0.2') });
    assert.equal(locked.status, 429, 'that IP stays locked out for this name, even with the right password');
    const owner = await post('/api/auth/login', { username: u.username, password: u.password }, { headers: from('198.18.0.3') });
    assert.equal(owner.status, 200, 'the owner elsewhere is not locked out by 5 failures');
    // Unknown usernames are capped the same way (the dummy check is charged too).
    const ghost = await Promise.all(Array.from({ length: 60 }, (_, i) =>
        post('/api/auth/login', { username: 'Ghost_' + (i % 3), password: 'wrong-guess-' + i }, { headers: from('198.18.0.4') })));
    assert.deepEqual(tally(ghost), { '401:bad_credentials': 15, '429:rate_limited': 45 });
    accounts.ratelimit.reset();
});

test('recover / reauth / signup: parallel bursts are capped at the limit', async () => {
    accounts.ratelimit.reset();
    const u = await signupAt('198.18.1.1', 'Burst_Recover', 'burst-recover-pass-1');
    let rs = await Promise.all(Array.from({ length: 50 }, () =>
        post('/api/auth/recover', { username: u.username, recoveryCode: 'AAAA-BBBB-CCCC', newPassword: 'new-pass-burst-1' }, { headers: from('198.18.1.2') })));
    assert.deepEqual(tally(rs), { '401:bad_recovery': 5, '429:rate_limited': 45 });

    // POST /api/auth/reauth (current-password check): 5 per account.
    rs = await Promise.all(Array.from({ length: 30 }, (_, i) =>
        post('/api/auth/reauth', { currentPassword: 'wrong-guess-' + i }, { jar: u.jar, headers: from('198.18.1.3') })));
    assert.deepEqual(tally(rs), { '401:bad_password': 5, '429:rate_limited': 25 });
    const after = await post('/api/auth/reauth', { currentPassword: u.password }, { jar: u.jar, headers: from('198.18.1.3') });
    assert.equal(after.status, 429, 'locked for this account even with the right password');

    // Accounts created per IP: 12 an hour, however many arrive at once.
    rs = await Promise.all(Array.from({ length: 30 }, (_, i) =>
        post('/api/auth/signup', { username: 'Burst_Sign' + i, password: 'burst-sign-pass-' + i }, { headers: from('198.18.1.4') })));
    assert.deepEqual(tally(rs), { 201: accounts.ratelimit.WINDOWS.signup.limit, '429:rate_limited': 30 - accounts.ratelimit.WINDOWS.signup.limit });
    // Two racing signups for one name: both are charged, the loser (409 after
    // hashing) hands its charge back.
    accounts.ratelimit.reset();
    rs = await Promise.all([0, 1].map(() =>
        post('/api/auth/signup', { username: 'Race_Name', password: 'race-name-pass-1' }, { headers: from('198.18.1.5') })));
    assert.deepEqual(tally(rs), { 201: 1, '409:username_taken': 1 });
    let room = 0;
    while (accounts.ratelimit.take([['signup', '198.18.1.5']]).ok) room++;
    assert.equal(room, accounts.ratelimit.WINDOWS.signup.limit - 1);
    accounts.ratelimit.reset();
});

test('IPv6: one /64 shares the per-IP limits; ::ffff:-mapped counts as the IPv4 address', async () => {
    accounts.ratelimit.reset();
    const u = await signupAt('198.18.2.1', 'Six_Target', 'six-target-pass-1');
    for (let i = 1; i <= 5; i++) {
        const r = await post('/api/auth/login', { username: u.username, password: 'wrong-guess-' + i }, { headers: from('2001:db8:77:1::' + i.toString(16)) });
        assert.equal(r.status, 401, 'attempt ' + i);
    }
    let r = await post('/api/auth/login', { username: u.username, password: u.password }, { headers: from('2001:db8:77:1:ffff:ffff:ffff:ffff') });
    assert.equal(r.status, 429, 'a fresh address in the same /64 is the same client');
    r = await post('/api/auth/login', { username: u.username, password: u.password }, { headers: from('2001:db8:77:2::1') });
    assert.equal(r.status, 200, 'the next /64 is somebody else');

    for (let i = 0; i < 5; i++) {
        r = await post('/api/auth/login', { username: u.username, password: 'wrong-guess-' + i }, { headers: from('192.0.2.55') });
        assert.equal(r.status, 401);
    }
    r = await post('/api/auth/login', { username: u.username, password: u.password }, { headers: from('::ffff:192.0.2.55') });
    assert.equal(r.status, 429);
    accounts.ratelimit.reset();
});

test('api limit: always charged per IP, so rotating sessions cannot multiply it', async () => {
    accounts.ratelimit.reset();
    const ip = '198.18.3.1';
    const u = await signupAt(ip, 'Api_Rotator', 'api-rotator-pass-1');
    const jars = [u.jar];
    for (let i = 0; i < 4; i++) {
        const jar = new Jar();
        assert.equal((await post('/api/auth/login', { username: u.username, password: u.password }, { jar, headers: from(ip) })).status, 200);
        jars.push(jar);
    }
    const rs = await Promise.all(Array.from({ length: 300 }, (_, i) => get('/api/account/sessions', { jar: jars[i % jars.length], headers: from(ip) })));
    const t = tally(rs);
    assert.equal(t[200] + 5, accounts.ratelimit.WINDOWS.api.limit, JSON.stringify(t));
    assert.equal(t['429:rate_limited'], 300 - t[200]);
    // Another IP with the same sessions is not affected by that IP's budget.
    assert.equal((await get('/api/account/sessions', { jar: jars[0], headers: from('198.18.3.2') })).status, 200);
    accounts.ratelimit.reset();
});

test('scrypt gate: a flood of logins gets 503 busy + Retry-After: 2, never a 500 or a counted failure', async () => {
    accounts.ratelimit.reset();
    const rs = await Promise.all(Array.from({ length: 120 }, (_, i) =>
        post('/api/auth/login', { username: 'Flood_' + i, password: 'flood-guess-' + i }, { headers: from('198.19.' + (i >> 8) + '.' + (i & 255)) })));
    const t = tally(rs);
    assert.ok(t['503:busy'] > 0, JSON.stringify(t));
    assert.equal(t['401:bad_credentials'] + t['503:busy'], 120, JSON.stringify(t));
    const busy = rs.find(r => r.status === 503);
    assert.equal(busy.headers.get('retry-after'), '2');
    assert.equal(busy.json.error.retryAfter, 2);
    assert.deepEqual(C.scryptLoad(), { active: 0, queued: 0 });
    // A busy answer is not charged: that client still has all 5 attempts.
    const i = rs.findIndex(r => r.status === 503);
    const ip = '198.19.' + (i >> 8) + '.' + (i & 255);
    for (let n = 0; n < 5; n++) {
        const r = await post('/api/auth/login', { username: 'Flood_' + i, password: 'again-' + n }, { headers: from(ip) });
        assert.equal(r.status, 401, 'attempt ' + n);
    }
    assert.equal((await post('/api/auth/login', { username: 'Flood_' + i, password: 'again-x' }, { headers: from(ip) })).status, 429);
    accounts.ratelimit.reset();
});

test('dw_dev: set on login; lets the owner past a username lockout, nobody else', async () => {
    accounts.ratelimit.reset();
    const owner = await signupAt('198.18.4.1', 'Device_Owner', 'device-owner-pass-1');
    const other = await signupAt('198.18.4.2', 'Device_Other', 'device-other-pass-1');
    const devJar = new Jar();
    const login = await post('/api/auth/login', { username: owner.username, password: owner.password }, { jar: devJar, headers: from('198.18.4.1') });
    assert.equal(login.status, 200);
    const sc = login.setCookies.find(c => c.startsWith('dw_dev='));
    assert.ok(sc, 'dw_dev set on login');
    for (const attr of ['Path=/api/auth', 'HttpOnly', 'SameSite=Lax', 'Max-Age=31536000']) assert.ok(sc.includes(attr), attr);
    assert.ok(!sc.includes('Secure'), 'no Secure over http');
    const ownerDev = devJar.c.dw_dev;
    assert.equal(sessions.deviceUserId(decodeURIComponent(ownerDev)), owner.id);

    // Somebody fails 11 times from 11 addresses: the username backoff kicks in.
    for (let i = 0; i < 11; i++) {
        const r = await post('/api/auth/login', { username: owner.username, password: 'wrong-guess-' + i }, { headers: from('198.18.5.' + (i + 1)) });
        assert.equal(r.status, i < 10 ? 401 : 429, 'attacker attempt ' + i);
    }
    const creds = { username: owner.username, password: owner.password };
    let r = await post('/api/auth/login', creds, { headers: from('198.18.6.1') });
    assert.equal(r.status, 429, 'no dw_dev: locked out');
    r = await post('/api/auth/login', creds, { jar: new Jar({ dw_dev: other.jar.c.dw_dev }), headers: from('198.18.6.2') });
    assert.equal(r.status, 429, "another account's dw_dev does not help");
    // Other's genuine cookie with the user id swapped: the signature no longer matches.
    const [body, sig] = decodeURIComponent(other.jar.c.dw_dev).split('.');
    const swapped = { ...JSON.parse(Buffer.from(body, 'base64url').toString()), u: owner.id };
    const forged = Buffer.from(JSON.stringify(swapped)).toString('base64url') + '.' + sig;
    r = await post('/api/auth/login', creds, { jar: new Jar({ dw_dev: encodeURIComponent(forged) }), headers: from('198.18.6.3') });
    assert.equal(r.status, 429, 'tampered dw_dev');
    const wrongPurpose = C.sign('pending', { u: owner.id }, 60000);
    r = await post('/api/auth/login', creds, { jar: new Jar({ dw_dev: encodeURIComponent(wrongPurpose) }), headers: from('198.18.6.4') });
    assert.equal(r.status, 429, 'a signed value for another purpose');
    // Per-IP limits still apply with a valid dw_dev.
    for (let i = 0; i < 5; i++) {
        r = await post('/api/auth/login', { username: owner.username, password: 'wrong-dev-' + i }, { jar: new Jar({ dw_dev: ownerDev }), headers: from('198.18.6.5') });
        assert.equal(r.status, 401);
    }
    r = await post('/api/auth/login', creds, { jar: new Jar({ dw_dev: ownerDev }), headers: from('198.18.6.5') });
    assert.equal(r.status, 429, 'the per-IP lockout is not skipped');
    r = await post('/api/auth/login', creds, { jar: new Jar({ dw_dev: ownerDev }), headers: from('198.18.6.6') });
    assert.equal(r.status, 200, 'owner with dw_dev gets in');

    // Recovery: the per-username cap (5/hour across IPs) is skipped the same way.
    for (let i = 0; i < 5; i++) {
        r = await post('/api/auth/recover', { username: owner.username, recoveryCode: 'AAAA-BBBB-CCC' + i, newPassword: 'recovered-dev-1' }, { headers: from('198.18.7.' + (i + 1)) });
        assert.equal(r.status, 401);
    }
    const rec = { username: owner.username, recoveryCode: owner.recovery, newPassword: 'recovered-dev-1' };
    r = await post('/api/auth/recover', rec, { headers: from('198.18.7.20') });
    assert.equal(r.status, 429, 'recoverUser cap without dw_dev');
    r = await post('/api/auth/recover', rec, { jar: new Jar({ dw_dev: other.jar.c.dw_dev }), headers: from('198.18.7.21') });
    assert.equal(r.status, 429, "another account's dw_dev");
    const recJar = new Jar({ dw_dev: ownerDev });
    r = await post('/api/auth/recover', rec, { jar: recJar, headers: from('198.18.7.22') });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.setCookies.some(c => c.startsWith('dw_dev=')), 'recovery login renews dw_dev');
    accounts.ratelimit.reset();
});

test('guest names: look-alike spellings of a username count as registered', async () => {
    accounts.ratelimit.reset();
    await signupAt('198.18.8.1', 'Mimic_Me', 'mimic-me-pass-1');
    assert.equal(users.isRegisteredName('Mimic_Me'), true);
    assert.equal(users.isRegisteredName('mimic_me'), true);
    assert.equal(users.isRegisteredName(S(0x41C) + 'im' + S(0x456) + 'c_M' + S(0x435)), true, 'Cyrillic M, i, e');
    assert.equal(users.isRegisteredName(S(0x39C) + S(0x399) + 'mic_me'), true, 'Greek capitals');
    assert.equal(users.isRegisteredName(S(0xFF2D, 0xFF49, 0xFF4D, 0xFF49, 0xFF43, 0xFF3F, 0xFF2D, 0xFF45)), true, 'fullwidth');
    assert.equal(users.isRegisteredName('M' + S(0xEF) + 'mic_M' + S(0xE9)), true, 'accents');
    assert.equal(users.isRegisteredName(N.sanitizeGuestName('M' + S(0x200B) + 'imic_Me')), true, 'zero-width (sanitised first)');
    assert.equal(users.isRegisteredName('Mimic_You'), false);
    assert.equal(users.isRegisteredName('M1mic_Me'), false, 'digits are not folded');
    assert.equal(users.isRegisteredName('Mimic Me'), false);
    accounts.ratelimit.reset();
});

test('http: production logs once when X-Forwarded-For comes from an untrusted peer', () => {
    const httpmod = require('../../server/accounts/http');
    const errors = [];
    const origError = console.error;
    const origWarn = console.warn;
    const wasProd = accounts.config.isProd;
    console.error = (...a) => errors.push(a.join(' '));
    console.warn = () => {};
    const fake = (peer, xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: peer } });
    try {
        accounts.config.isProd = false;
        httpmod.clientIp(fake('10.60.1.2', '1.2.3.4'));
        assert.equal(errors.length, 0, 'not in dev');
        accounts.config.isProd = true;
        httpmod.clientIp(fake('127.0.0.1', '1.2.3.4'));
        httpmod.clientIp(fake('10.60.1.2'));
        assert.equal(errors.length, 0, 'trusted peer, or no header');
        assert.equal(httpmod.clientIp(fake('::ffff:10.60.1.2', '1.2.3.4')), '10.60.1.2', 'header ignored');
        httpmod.clientIp(fake('10.60.1.3', '5.6.7.8'));
        assert.equal(errors.length, 1, 'logged once');
        assert.match(errors[0], /TRUSTED_PROXIES/);
        assert.match(errors[0], /came from 10\.60\.1\.2,/);
        assert.match(errors[0], /TRUSTED_PROXIES=10\.60\.1\.2/);
    } finally {
        accounts.config.isProd = wasProd;
        console.error = origError;
        console.warn = origWarn;
    }
});

// ===================================================================
// HTTP: account settings
// ===================================================================

test('rename: works once, 14-day cooldown, old name held for its owner only', async () => {
    let r = await post('/api/account/username', { username: 'Digger_Two' }, { jar: A.jar });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.username, 'Digger_Two');
    assert.ok(Math.abs(r.json.user.usernameChangeAt - (Date.now() + 14 * DAY)) < 60000);
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'username_change'", A.id));

    r = await post('/api/account/username', { username: 'Digger_Three' }, { jar: A.jar });
    assert.equal(r.status, 429);
    assert.equal(errCode(r), 'cooldown');
    assert.ok(Math.abs(r.json.error.availableAt - (Date.now() + 14 * DAY)) < 60000);

    // Somebody else cannot take the old name while it is held.
    accounts.ratelimit.reset();
    r = await post('/api/auth/signup', { username: 'digger_one', password: 'squatter-pass-1' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.reason, 'held');
    assert.deepEqual((await get('/api/auth/username-available?name=Digger_One')).json, { available: false, reason: 'held' });
    assert.deepEqual((await get('/api/auth/username-available?name=Digger_One', { jar: A.jar })).json, { available: true });
    assert.equal(users.isRegisteredName('digger_one'), true, 'held names still get the guest ~ prefix');
    assert.equal(users.isRegisteredName('Digger_Two'), true);

    r = await post('/api/account/username', { username: 'bad name' }, { jar: A.jar });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'invalid_username');

    // Two weeks later, without a fresh re-auth: the password is required.
    dbmod.handle().run('UPDATE users SET username_changed_at = ? WHERE id = ?', Date.now() - 15 * DAY, A.id);
    expireReauth(A.jar);
    r = await post('/api/account/username', { username: 'Digger_One' }, { jar: A.jar });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_password');
    r = await post('/api/account/username', { username: 'Digger_One', currentPassword: 'not-my-password' }, { jar: A.jar });
    assert.equal(r.status, 401);
    r = await post('/api/account/username', { username: 'Digger_One', currentPassword: A.password }, { jar: A.jar });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.username, 'Digger_One', 'owner reclaimed the held name');
    const holds = dbmod.handle().all('SELECT username_lc FROM username_holds WHERE user_id = ?', A.id).map(h => h.username_lc);
    assert.deepEqual(holds, ['digger_two']);
    accounts.ratelimit.reset();
});

test('password change: needs the current password (or fresh reauth), revokes other sessions', async () => {
    accounts.ratelimit.reset();
    const other = new Jar();
    assert.equal((await post('/api/auth/login', { username: A.username, password: A.password }, { jar: other })).status, 200);
    expireReauth(A.jar);
    const newPassword = 'new-tunnel-77';
    let r = await post('/api/account/password', { newPassword }, { jar: A.jar });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_password');
    r = await post('/api/account/password', { newPassword, currentPassword: 'wrong-one-here' }, { jar: A.jar });
    assert.equal(r.status, 401);
    r = await post('/api/account/password', { newPassword: 'password1', currentPassword: A.password }, { jar: A.jar });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'weak_password');
    r = await post('/api/account/password', { newPassword, currentPassword: A.password }, { jar: A.jar });
    assert.equal(r.status, 204, r.text);
    assert.equal((await get('/api/me', { jar: other })).json.user, null, 'other session revoked');
    assert.equal((await get('/api/me', { jar: A.jar })).json.user.username, 'Digger_One', 'this session kept');
    assert.equal((await post('/api/auth/login', { username: A.username, password: A.password })).status, 401);
    A.password = newPassword;
    const fresh = new Jar();
    assert.equal((await post('/api/auth/login', { username: A.username, password: A.password }, { jar: fresh })).status, 200);
    // Fresh reauth window (just logged in): no current password needed.
    r = await post('/api/account/password', { newPassword: 'newer-tunnel-88' }, { jar: fresh });
    assert.equal(r.status, 204);
    A.password = 'newer-tunnel-88';
    A.jar = fresh;
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'password_change'", A.id));
    accounts.ratelimit.reset();
});

test('recovery code: regenerate needs credentials; old code stops working', async () => {
    expireReauth(A.jar);
    let r = await post('/api/account/recovery-code', {}, { jar: A.jar });
    assert.equal(r.status, 401);
    r = await post('/api/account/recovery-code', { currentPassword: A.password }, { jar: A.jar });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.recoveryCode, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    assert.notEqual(r.json.recoveryCode, A.recovery);
    const oldCode = A.recovery;
    A.recovery = r.json.recoveryCode;
    r = await post('/api/auth/recover', { username: A.username, recoveryCode: oldCode, newPassword: 'recovered-pass-9' });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_recovery');
    accounts.ratelimit.reset();
});

test('recover: code redeems once, rotates, revokes sessions, kicks the game', async () => {
    kicks.length = 0;
    let r = await post('/api/auth/recover', { username: A.username, recoveryCode: 'AAAA-BBBB-CCCC', newPassword: 'recovered-pass-9' });
    assert.equal(r.status, 401);
    r = await post('/api/auth/recover', { username: A.username, recoveryCode: A.recovery, newPassword: 'password1' });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'weak_password');
    const typed = A.recovery.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'i');
    const jar = new Jar();
    r = await post('/api/auth/recover', { username: 'DIGGER_ONE', recoveryCode: typed, newPassword: 'recovered-pass-9' }, { jar });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.username, 'Digger_One');
    assert.notEqual(r.json.recoveryCode, A.recovery);
    assert.equal((await get('/api/me', { jar: A.jar })).json.user, null, 'old sessions revoked');
    assert.equal((await get('/api/me', { jar })).json.user.username, 'Digger_One');
    assert.deepEqual(kicks.map(k => [k.t, k.userId]), [['kick', A.id]]);
    assert.equal(typeof kicks[0].reason, 'string');
    r = await post('/api/auth/recover', { username: A.username, recoveryCode: A.recovery, newPassword: 'recovered-pass-10' });
    assert.equal(r.status, 401, 'a used code does not work twice');
    A.password = 'recovered-pass-9';
    A.jar = jar;
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'recovery_used'", A.id));
    accounts.ratelimit.reset();
});

test('reset: admin reset token works once', async () => {
    const token = users.createResetToken(A.id, 'admin:test');
    let r = await post('/api/auth/reset', { token: 'x'.repeat(43), newPassword: 'reset-pass-123' });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'invalid_token');
    const jar = new Jar();
    r = await post('/api/auth/reset', { token, newPassword: 'reset-pass-123' }, { jar });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.username, 'Digger_One');
    assert.equal((await get('/api/me', { jar: A.jar })).json.user, null, 'sessions revoked');
    r = await post('/api/auth/reset', { token, newPassword: 'reset-pass-456' });
    assert.equal(r.status, 400, 'single use');
    A.password = 'reset-pass-123';
    A.jar = jar;
    assert.equal((await post('/api/auth/login', { username: A.username, password: A.password })).status, 200);
});

test('sessions list and revoke', async () => {
    const extra = new Jar();
    assert.equal((await post('/api/auth/login', { username: A.username, password: A.password }, { jar: extra })).status, 200);
    let r = await get('/api/account/sessions', { jar: A.jar });
    assert.equal(r.status, 200);
    const list = r.json.sessions;
    assert.ok(list.length >= 2);
    assert.equal(list.filter(s => s.current).length, 1);
    const target = sessions.fromCookieHeader(extra.header()).session.id;
    r = await post('/api/account/sessions/revoke', { id: target }, { jar: A.jar });
    assert.equal(r.status, 204);
    assert.equal((await get('/api/me', { jar: extra })).json.user, null);
    r = await post('/api/account/sessions/revoke', { id: target }, { jar: A.jar });
    assert.equal(r.status, 404);
    assert.equal((await get('/api/account/sessions')).status, 401, 'needs a session');
});

test('delete: confirm + password, soft delete holds the username', async () => {
    accounts.ratelimit.reset();
    const jar = new Jar();
    let r = await post('/api/auth/signup', { username: 'Doomed_Digger', password: 'doomed-pass-1' }, { jar });
    assert.equal(r.status, 201);
    const id = users.byUsername('doomed_digger').id;
    r = await post('/api/account/delete', { confirm: 'delete' }, { jar });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'confirm_required');
    expireReauth(jar);
    r = await post('/api/account/delete', { confirm: 'DELETE' }, { jar });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_password');
    r = await post('/api/account/delete', { confirm: 'DELETE', currentPassword: 'wrong-pass-00' }, { jar });
    assert.equal(r.status, 401);
    kicks.length = 0;
    r = await post('/api/account/delete', { confirm: 'DELETE', currentPassword: 'doomed-pass-1' }, { jar });
    assert.equal(r.status, 204, r.text);
    assert.ok(r.setCookies.some(c => c.startsWith('dw_sid=;')));
    assert.deepEqual(kicks.map(k => k.userId), [id]);
    assert.equal(users.byId(id), null);
    assert.ok(users.byId(id, { includeDeleted: true }).deleted_at);
    assert.equal(users.byUsername('Doomed_Digger'), null);
    assert.equal((await post('/api/auth/login', { username: 'Doomed_Digger', password: 'doomed-pass-1' })).status, 401);
    r = await post('/api/auth/signup', { username: 'doomed_DIGGER', password: 'other-pass-22' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.reason, 'held');
    assert.equal(users.isRegisteredName('Doomed_Digger'), true);
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'account_delete'", id));
    assert.equal(dbmod.handle().get('SELECT count(*) AS n FROM sessions WHERE user_id = ?', id).n, 0);
    // The sweep hard-deletes it after 30 days (and the hold goes with it).
    dbmod.handle().run('UPDATE users SET deleted_at = ? WHERE id = ?', Date.now() - 31 * DAY, id);
    const swept = accounts.sweep();
    assert.equal(swept.users, 1);
    assert.equal(users.byId(id, { includeDeleted: true }), null);
    assert.equal(users.isRegisteredName('Doomed_Digger'), false);
    accounts.ratelimit.reset();
});

// ===================================================================
// HTTP: Discord OAuth (fake Discord)
// ===================================================================

test('discord: not configured -> 302 discord_disabled', async () => {
    const r = await get('/auth/discord/start?mode=login');
    assert.equal(r.status, 302);
    assert.equal(r.location, '/?auth=error&reason=discord_disabled');
    const cb = await get('/auth/discord/callback?code=x&state=y');
    assert.equal(cb.location, '/?auth=error&reason=discord_disabled');
});

const D = { jar: new Jar(), id: 0 };

test('discord: start sets a signed state cookie; bad state rejected', async () => {
    process.env.DISCORD_CLIENT_ID = '123456789012345678';
    process.env.DISCORD_CLIENT_SECRET = 'fake-client-secret';
    accounts.config.load();
    discordOAuth.setFetchForTests(fakeDiscordFetch);
    assert.equal((await get('/api/config')).json.discordLogin, true);

    const jar = new Jar();
    const start = await get('/auth/discord/start?mode=login', { jar });
    assert.equal(start.status, 302);
    const u = new URL(start.location);
    assert.equal(u.origin + u.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(u.searchParams.get('client_id'), '123456789012345678');
    assert.equal(u.searchParams.get('scope'), 'identify');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/discord/callback');
    assert.ok(u.searchParams.get('state').length >= 24);
    const sc = start.setCookies.find(c => c.startsWith('dw_oauth='));
    for (const attr of ['Path=/auth/discord', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600']) assert.ok(sc.includes(attr), attr);

    const bad = await get('/auth/discord/callback?code=code-new&state=forged-state-value', { jar });
    assert.equal(bad.location, '/?auth=error&reason=state');
    assert.ok(bad.setCookies.some(c => c.startsWith('dw_oauth=;') && c.includes('Path=/auth/discord')), 'state cookie is single use');
    const noCookie = await get('/auth/discord/callback?code=code-new&state=' + u.searchParams.get('state'));
    assert.equal(noCookie.location, '/?auth=error&reason=state');
    const clean = await discordFlow(new Jar(), 'login', 'code-new');
    assert.equal(clean.callback, '/?auth=pick-username', 'sanity: a clean flow works');
    const cancelJar = new Jar();
    const cancelStart = await get('/auth/discord/start?mode=login', { jar: cancelJar });
    const cancelState = new URL(cancelStart.location).searchParams.get('state');
    const cancelled = await get('/auth/discord/callback?error=access_denied&state=' + cancelState, { jar: cancelJar });
    assert.equal(cancelled.location, '/?auth=error&reason=access_denied');
    const unknown = await discordFlow(new Jar(), 'login', 'code-bogus');
    assert.equal(unknown.callback, '/?auth=error&reason=exchange');
    assert.equal((await get('/auth/discord/start?mode=sideways')).location, '/?auth=error&reason=bad_mode');
    assert.equal((await get('/auth/discord/start?mode=link')).location, '/?auth=error&reason=not_logged_in');
});

test('discord: new user -> pick-username with dw_pending; /api/me shows it; token revoked', async () => {
    revokedTokens.length = 0;
    const flow = await discordFlow(D.jar, 'login', 'code-new');
    assert.equal(flow.callback, '/?auth=pick-username');
    const pc = flow.res.setCookies.find(c => c.startsWith('dw_pending='));
    for (const attr of ['Path=/api', 'HttpOnly', 'SameSite=Lax', 'Max-Age=900']) assert.ok(pc.includes(attr), attr);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(revokedTokens, ['tok-code-new'], 'Discord token revoked, never kept');
    const me = await get('/api/me', { jar: D.jar });
    assert.deepEqual(me.json, {
        user: null,
        pendingDiscord: { name: 'New Digger', avatarUrl: `https://cdn.discordapp.com/avatars/111111111111111111/a_${'f'.repeat(32)}.png?size=64` },
    });
});

test('discord complete: forged / expired / missing pending cookie rejected', async () => {
    const good = D.jar.c.dw_pending;
    const [body, sig] = decodeURIComponent(good).split('.');
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    obj.d = '333333333333333333';
    const forgedBody = new Jar({ dw_pending: encodeURIComponent(Buffer.from(JSON.stringify(obj)).toString('base64url') + '.' + sig) });
    let r = await post('/api/auth/discord/complete', { username: 'Forged_Digger' }, { jar: forgedBody });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'pending_expired');
    const forgedSig = new Jar({ dw_pending: encodeURIComponent(body + '.' + C.randomToken(32)) });
    assert.equal((await post('/api/auth/discord/complete', { username: 'Forged_Digger' }, { jar: forgedSig })).status, 401);
    const expired = C.sign('pending', { d: '111111111111111111', n: 'New Digger', a: null }, -1000);
    assert.equal((await post('/api/auth/discord/complete', { username: 'Forged_Digger' }, { jar: new Jar({ dw_pending: encodeURIComponent(expired) }) })).status, 401);
    const wrongPurpose = C.sign('oauth', { d: '111111111111111111', s: 'x', m: 'login', u: 0 }, 60000);
    assert.equal((await post('/api/auth/discord/complete', { username: 'Forged_Digger' }, { jar: new Jar({ dw_pending: encodeURIComponent(wrongPurpose) }) })).status, 401);
    assert.equal((await post('/api/auth/discord/complete', { username: 'Forged_Digger' })).status, 401);
    assert.equal(users.byUsername('Forged_Digger'), null);
    assert.equal(users.byDiscordId('333333333333333333'), null);
});

test('discord complete: creates a Discord-only account with a recovery code', async () => {
    accounts.ratelimit.reset();
    let r = await post('/api/auth/discord/complete', { username: 'admin' }, { jar: D.jar });
    assert.equal(r.status, 400);
    assert.equal(errCode(r), 'invalid_username');
    r = await post('/api/auth/discord/complete', { username: 'Digger_One' }, { jar: D.jar });
    assert.equal(r.status, 409);
    r = await post('/api/auth/discord/complete', { username: 'Discord_Digger' }, { jar: D.jar });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.user.username, 'Discord_Digger');
    assert.equal(r.json.user.hasPassword, false);
    assert.deepEqual(r.json.user.discord, {
        id: '111111111111111111', name: 'New Digger',
        avatarUrl: `https://cdn.discordapp.com/avatars/111111111111111111/a_${'f'.repeat(32)}.png?size=64`,
    });
    assert.match(r.json.recoveryCode, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    assert.ok(r.setCookies.some(c => c.startsWith('dw_pending=;') && c.includes('Path=/api')), 'pending cookie cleared');
    assert.equal(D.jar.c.dw_pending, undefined);
    D.id = users.byUsername('discord_digger').id;
    const me = await get('/api/me', { jar: D.jar });
    assert.equal(me.json.user.username, 'Discord_Digger');
    assert.equal(me.json.pendingDiscord, null);
});

test('discord: existing user logs in; reauth; Discord-only delete needs reauth', async () => {
    const jar = new Jar();
    const flow = await discordFlow(jar, 'login', 'code-new');
    assert.equal(flow.callback, '/?auth=ok');
    assert.equal((await get('/api/me', { jar })).json.user.username, 'Discord_Digger');
    D.jar = jar;

    expireReauth(D.jar);
    let r = await post('/api/account/delete', { confirm: 'DELETE' }, { jar: D.jar });
    assert.equal(r.status, 403);
    assert.equal(errCode(r), 'reauth_required');
    r = await post('/api/account/username', { username: 'Discord_Digger2' }, { jar: D.jar });
    assert.equal(r.status, 403);
    assert.equal(errCode(r), 'reauth_required');

    const re = await discordFlow(D.jar, 'reauth', 'code-new');
    assert.equal(new URL(re.start).searchParams.get('prompt'), 'consent');
    assert.equal(re.callback, '/?auth=reauth-ok');
    assert.ok(sessions.fromCookieHeader(D.jar.header()).session.reauth_until > Date.now());
    // Reauth with a different Discord account is refused.
    expireReauth(D.jar);
    const wrong = await discordFlow(D.jar, 'reauth', 'code-link');
    assert.equal(wrong.callback, '/?auth=error&reason=reauth_mismatch');
    assert.equal(sessions.fromCookieHeader(D.jar.header()).session.reauth_until, 0);
});

test('discord: unlink needs a password; set one then unlink', async () => {
    let r = await post('/api/account/discord/unlink', { currentPassword: 'anything-here' }, { jar: D.jar });
    assert.equal(r.status, 409);
    assert.equal(errCode(r), 'no_password');
    // Reauth window closed (the mismatch test above): a first password needs
    // a fresh Discord login, but never a current password.
    r = await post('/api/account/password', { newPassword: 'discord-digger-pw' }, { jar: D.jar });
    assert.equal(r.status, 403);
    assert.equal(errCode(r), 'reauth_required');
    assert.equal((await discordFlow(D.jar, 'reauth', 'code-new')).callback, '/?auth=reauth-ok');
    r = await post('/api/account/password', { newPassword: 'discord-digger-pw' }, { jar: D.jar });
    assert.equal(r.status, 204, 'first password after reauth, no current password');
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'password_set'", D.id));
    r = await post('/api/account/discord/unlink', {}, { jar: D.jar });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_password');
    r = await post('/api/account/discord/unlink', { currentPassword: 'discord-digger-pw' }, { jar: D.jar });
    assert.equal(r.status, 204);
    const me = await get('/api/me', { jar: D.jar });
    assert.equal(me.json.user.discord, null);
    assert.equal(me.json.user.hasPassword, true);
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'discord_unlink'", D.id));
});

test('discord: link ok, link taken, session must match the one that started', async () => {
    accounts.ratelimit.reset();
    let flow = await discordFlow(A.jar, 'link', 'code-link');
    assert.equal(flow.callback, '/?link=ok');
    const me = await get('/api/me', { jar: A.jar });
    assert.deepEqual(me.json.user.discord, { id: '222222222222222222', name: 'linker', avatarUrl: null });
    assert.ok(dbmod.handle().get("SELECT 1 AS x FROM audit_log WHERE user_id = ? AND action = 'discord_link'", A.id));

    flow = await discordFlow(D.jar, 'link', 'code-link');
    assert.equal(flow.callback, '/?link=taken');
    assert.equal(users.byId(D.id).discord_id, null);

    // Start as D, finish with A's session cookie: refused.
    flow = await discordFlow(D.jar.clone(), 'link', 'code-new', {
        beforeCallback: jar => { jar.c.dw_sid = A.jar.c.dw_sid; },
    });
    assert.equal(flow.callback, '/?auth=error&reason=session');
    assert.equal(users.byId(A.id).discord_id, '222222222222222222');
    assert.equal(users.byId(D.id).discord_id, null);
});

const L = { jar: null, id: 0, password: '', recovery: '' };

test('discord link: needs a fresh session at start and callback; POST /api/auth/reauth opens it', async () => {
    accounts.ratelimit.reset();
    Object.assign(L, await signupAt('198.18.9.1', 'Link_Owner', 'link-owner-pass-1'));
    expireReauth(L.jar);
    let flow = await discordFlow(L.jar, 'link', 'code-third');
    assert.equal(flow.start, '/?auth=error&reason=reauth_required');
    assert.equal(flow.callback, null);

    let r = await post('/api/auth/reauth', { currentPassword: L.password });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'unauthorized');
    r = await post('/api/auth/reauth', {}, { jar: L.jar });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_password');
    r = await post('/api/auth/reauth', { currentPassword: 'wrong-pass-00' }, { jar: L.jar });
    assert.equal(r.status, 401);
    assert.equal(errCode(r), 'bad_password');
    assert.equal(sessions.fromCookieHeader(L.jar.header()).session.reauth_until, 0);
    r = await post('/api/auth/reauth', { currentPassword: L.password }, { jar: L.jar });
    assert.equal(r.status, 204, r.text);
    assert.ok(sessions.fromCookieHeader(L.jar.header()).session.reauth_until > Date.now());

    flow = await discordFlow(L.jar, 'link', 'code-third');
    assert.equal(flow.callback, '/?link=ok');
    assert.equal(users.byId(L.id).discord_id, '444444444444444444');

    // The window is checked again when Discord sends the browser back.
    users.unlinkDiscord(L.id);
    flow = await discordFlow(L.jar, 'link', 'code-third', { beforeCallback: expireReauth });
    assert.equal(flow.callback, '/?auth=error&reason=reauth_required');
    assert.equal(users.byId(L.id).discord_id, null);
});

test('discord link: never replaces a linked Discord (start, callback, users.linkDiscord)', async () => {
    let r = await post('/api/auth/reauth', { currentPassword: L.password }, { jar: L.jar });
    assert.equal(r.status, 204);
    assert.equal((await discordFlow(L.jar, 'link', 'code-third')).callback, '/?link=ok');
    let flow = await discordFlow(L.jar, 'link', 'code-fourth');
    assert.equal(flow.start, '/?link=already_linked', 'refused before going to Discord');

    // A flow started while unlinked, finished after another Discord got linked.
    users.unlinkDiscord(L.id);
    flow = await discordFlow(L.jar, 'link', 'code-fourth', {
        beforeCallback: () => users.linkDiscord(L.id, { id: '444444444444444444', name: 'Third', avatar: null }),
    });
    assert.equal(flow.callback, '/?link=already_linked');
    assert.equal(users.byId(L.id).discord_id, '444444444444444444');
    assert.deepEqual(users.linkDiscord(L.id, { id: '555555555555555555', name: 'Fourth' }), { ok: false, code: 'already_linked' });
    assert.equal(users.linkDiscord(L.id, { id: '444444444444444444', name: 'Third' }).ok, true, 'the same Discord again is fine');

    // The owner unlinks (password) and then links the new one.
    r = await post('/api/account/discord/unlink', { currentPassword: L.password }, { jar: L.jar });
    assert.equal(r.status, 204);
    assert.equal((await discordFlow(L.jar, 'link', 'code-fourth')).callback, '/?link=ok');
    assert.equal(users.byId(L.id).discord_id, '555555555555555555');
});

test('discord link: a stolen session cannot swap in the thief\'s Discord (Discord-only account)', async () => {
    accounts.ratelimit.reset();
    const victim = new Jar();
    assert.equal((await discordFlow(victim, 'login', 'code-victim')).callback, '/?auth=pick-username');
    let r = await post('/api/auth/discord/complete', { username: 'Link_Victim' }, { jar: victim });
    assert.equal(r.status, 201, r.text);
    const victimId = users.byUsername('link_victim').id;
    expireReauth(victim);
    const thief = new Jar({ dw_sid: victim.c.dw_sid });
    assert.equal((await discordFlow(thief, 'link', 'code-thief')).start, '/?link=already_linked');
    r = await post('/api/auth/reauth', { currentPassword: 'anything-at-all' }, { jar: thief });
    assert.equal(r.status, 403, 'no password to re-auth with');
    assert.equal(errCode(r), 'reauth_required');
    assert.equal((await discordFlow(thief, 'reauth', 'code-thief')).callback, '/?auth=error&reason=reauth_mismatch');
    r = await post('/api/account/password', { newPassword: 'thief-pass-123' }, { jar: thief });
    assert.equal(r.status, 403);
    assert.equal(users.byId(victimId).discord_id, '666666666666666666');
    assert.equal(users.byId(victimId).password_hash, null);
    // Even straight after a genuine re-auth, a second Discord is refused.
    assert.equal((await discordFlow(victim, 'reauth', 'code-victim')).callback, '/?auth=reauth-ok');
    assert.equal((await discordFlow(victim, 'link', 'code-thief')).start, '/?link=already_linked');
    assert.equal(users.byId(victimId).discord_id, '666666666666666666');
});

test('recover and reset responses show the linked Discord', async () => {
    accounts.ratelimit.reset();
    let r = await post('/api/auth/recover', { username: 'Link_Owner', recoveryCode: L.recovery, newPassword: 'link-owner-pass-2' }, { headers: from('198.18.9.2') });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.discord.id, '555555555555555555');
    const token = users.createResetToken(L.id, 'admin:test');
    r = await post('/api/auth/reset', { token, newPassword: 'link-owner-pass-3' }, { headers: from('198.18.9.2') });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.discord.id, '555555555555555555');
});

test('discord callback: each state works once; per-IP rate limit', async () => {
    accounts.ratelimit.reset();
    const jar = new Jar();
    const start = await get('/auth/discord/start?mode=login', { jar });
    const state = new URL(start.location).searchParams.get('state');
    const saved = jar.c.dw_oauth;
    const before = tokenExchanges;
    const cb = await get(`/auth/discord/callback?code=code-new&state=${state}`, { jar });
    assert.equal(cb.location, '/?auth=pick-username');
    const replay = await get(`/auth/discord/callback?code=code-new&state=${state}`, { jar: new Jar({ dw_oauth: saved }) });
    assert.equal(replay.location, '/?auth=error&reason=state', 'a copied state cookie is refused');
    assert.equal(tokenExchanges, before + 1, 'no second code exchange');

    // 30 parallel replays of one state from one IP: 20 get through the
    // limiter, exactly one of those is exchanged.
    accounts.ratelimit.reset();
    const j2 = new Jar();
    const s2 = await get('/auth/discord/start?mode=login', { jar: j2 });
    const st2 = new URL(s2.location).searchParams.get('state');
    const n0 = tokenExchanges;
    const rs = await Promise.all(Array.from({ length: 30 }, () =>
        get(`/auth/discord/callback?code=code-new&state=${st2}`, { jar: new Jar({ dw_oauth: j2.c.dw_oauth }), headers: from('198.18.10.1') })));
    const byLoc = {};
    for (const r of rs) byLoc[r.location] = (byLoc[r.location] || 0) + 1;
    assert.deepEqual(byLoc, {
        '/?auth=pick-username': 1,
        '/?auth=error&reason=state': 19,
        '/?auth=error&reason=rate_limited': 10,
    });
    assert.equal(tokenExchanges, n0 + 1);
    // Another address is unaffected.
    assert.equal((await discordFlow(new Jar(), 'login', 'code-new', { headers: from('198.18.10.2') })).callback, '/?auth=pick-username');
    accounts.ratelimit.reset();
});

test('worker thread: initWorker opens its own connection and reads sessions', async () => {
    const { Worker } = require('worker_threads');
    const code = `
        const { parentPort, workerData } = require('worker_threads');
        const accounts = require(workerData.mod);
        const ok = accounts.initWorker();
        const found = accounts.sessions.fromCookieHeader(workerData.cookie);
        parentPort.postMessage({
            ok,
            busy: accounts.db.handle().get('PRAGMA busy_timeout').timeout,
            registered: accounts.users.isRegisteredName('digger_ONE'),
            user: found && found.user.username,
        });
        accounts.shutdown();
    `;
    const w = new Worker(code, { eval: true, workerData: { mod: path.join(__dirname, '..', '..', 'server', 'accounts'), cookie: A.jar.header() } });
    const msg = await new Promise((resolve, reject) => {
        w.once('message', resolve);
        w.once('error', reject);
    });
    await new Promise(r => w.once('exit', r));
    assert.deepEqual(msg, { ok: true, busy: 250, registered: true, user: 'Digger_One' });
    assert.equal((await get('/api/me', { jar: A.jar })).json.user.username, 'Digger_One', 'main connection unaffected');
});

test('logout-all: revokes every session and kicks game sockets', async () => {
    kicks.length = 0;
    const second = new Jar();
    assert.equal((await post('/api/auth/login', { username: A.username, password: A.password }, { jar: second })).status, 200);
    const r = await post('/api/auth/logout-all', {}, { jar: A.jar });
    assert.equal(r.status, 204);
    assert.equal((await get('/api/me', { jar: second })).json.user, null);
    assert.equal((await get('/api/me', { jar: A.jar })).json.user, null);
    assert.equal(dbmod.handle().get('SELECT count(*) AS n FROM sessions WHERE user_id = ?', A.id).n, 0);
    assert.deepEqual(kicks.map(k => [k.t, k.userId]), [['kick', A.id]]);
});

test('bus: game -> main path', () => {
    const got = [];
    const off = accounts.bus.onMain((serverId, msg) => got.push([serverId, msg.t]));
    accounts.bus.toMain({ t: 'presence' });
    accounts.bus.fromGame('dw', { t: 'rankUp' });
    off();
    accounts.bus.toMain({ t: 'ignored' });
    assert.deepEqual(got, [['main', 'presence'], ['dw', 'rankUp']]);
    const posted = [];
    accounts.bus.setWorkerPoster(m => posted.push(m.t));
    accounts.bus.toGame({ t: 'kick', userId: 1, reason: 'x' });
    accounts.bus.setWorkerPoster(null);
    assert.deepEqual(posted, ['kick']);
});

// ===================================================================
// Disabled mode (keep last: it shuts the module down)
// ===================================================================

test('disabled: game-safe answers when accounts are off', async () => {
    accounts.shutdown();
    assert.equal(accounts.enabled(), false);
    assert.deepEqual((await get('/api/config')).json, { accounts: false, discordLogin: false, publicOrigin: 'http://localhost:3000' });
    assert.deepEqual((await get('/api/me', { jar: D.jar })).json, { user: null, pendingDiscord: null });
    let r = await post('/api/auth/signup', { username: 'Late_Digger', password: 'late-pass-123' });
    assert.equal(r.status, 503);
    assert.equal(errCode(r), 'accounts_unavailable');
    r = await get('/api/auth/username-available?name=abc');
    assert.equal(r.status, 503);
    r = await get('/auth/discord/start?mode=login');
    assert.equal(r.location, '/?auth=error&reason=accounts_unavailable');
    assert.equal((await get('/api/nope')).status, 404);
    assert.equal((await post('/api/auth/logout', {})).status, 204);
    assert.equal(accounts.sessions.fromCookieHeader(D.jar.header()), null);
    assert.equal(accounts.users.isRegisteredName('Digger_One'), false);
    assert.equal(accounts.users.byId(1), null);
    assert.equal(accounts.names.sanitizeGuestName(S(0xA7) + 'x'), 'x');
});

// ===================================================================

async function main() {
    // The module's own [accounts] info/warn lines are expected noise here
    // (migrations, the deliberately failing Discord exchange).
    const quietLog = console.log;
    const quietWarn = console.warn;
    console.log = (...args) => { if (!String(args[0]).startsWith('[accounts]')) quietLog(...args); };
    console.warn = (...args) => { if (!String(args[0]).startsWith('[accounts]')) quietWarn(...args); };
    const ok = accounts.initMain();
    assert.equal(ok, true, 'initMain');

    const server = http.createServer((req, res) => {
        if (!accounts.handleHttp(req, res)) {
            res.writeHead(418);
            res.end('static');
        }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    BASE = `http://127.0.0.1:${port}`;
    ORIGIN = `http://localhost:${port}`;

    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        const started = Date.now();
        try {
            await t.fn();
            quietLog(`ok   ${t.name} (${Date.now() - started} ms)`);
        } catch (e) {
            failed++;
            quietLog(`FAIL ${t.name}\n     ${((e && e.stack) || e).toString().split('\n').slice(0, 6).join('\n     ')}`);
        }
    }
    server.close();
    accounts.shutdown();
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
