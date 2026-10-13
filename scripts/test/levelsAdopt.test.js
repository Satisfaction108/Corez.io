'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..', '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-lvadopt-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'TRUSTED_PROXIES', 'DISCORD_BOT_TOKEN', 'ROYALE_DEBUG', 'LEVELS', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI']) delete process.env[k];
Object.assign(process.env, { NODE_ENV: 'test', ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'lvadopt-test-secret-0123456789-abcdefghijklm', PORT: '3000' });
global.Config = { dig_royale: true };

const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const levels = require('../../server/accounts/levels');
const guests = require('../../server/accounts/guests');
const banks = require('../../server/accounts/banks');
const achievements = require('../../server/accounts/achievements');
const retention = require('../../server/accounts/retention');
const dailyScores = require('../../server/accounts/dailyScores');
const scrypto = require('../../server/accounts/crypto');
const L = require('../../shared/levels.js');
const D = () => dbmod.handle();

let hooks = null;
let BASE = '', ORIGIN = '';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const DAY = 24 * 3600e3;

let seq = 0;
const gid = () => ((++seq).toString(16) + 'a'.repeat(32)).slice(0, 32);
const uname = (p) => (p + '_' + (++seq) + '_' + Math.floor(Math.random() * 1e3)).slice(0, 16);
function mkUser(opts = {}) {
    const r = accounts.users.create({ username: uname('la'), recoveryHash: null, passwordHash: opts.passwordHash || null });
    assert.ok(r.ok, JSON.stringify(r));
    if (opts.createdAt) D().run('UPDATE users SET created_at = ? WHERE id = ?', opts.createdAt, r.user.id);
    return accounts.users.byId(r.user.id);
}
const userRow = (id) => D().get('SELECT xp, level, xp_day AS day, xp_day_n AS dayXp, dust_milli FROM users WHERE id = ?', id);
const guestRow = (g) => D().get('SELECT xp, level, xp_day_n AS dayXp, xp_to FROM guests WHERE guest_id = ?', g);
const levelItems = (id) => D().all("SELECT item_id FROM owned_items WHERE user_id = ? AND source = 'level' ORDER BY item_id", id).map(r => r.item_id);
const grantRows = (id) => D().get('SELECT COUNT(*) AS n FROM level_grants WHERE user_id = ?', id).n;
const levelDust = (id) => D().get("SELECT COALESCE(SUM(delta_milli), 0) AS m FROM dust_ledger WHERE user_id = ? AND kind = 'level'", id).m;

function guestAt(level, extra = 0, now = Date.now()) {
    const g = gid();
    guests.seen(g, now, null);
    const want = L.START[level] + extra;
    let left = want, t = now - 3 * DAY;
    while (left > 0) {
        const n = Math.min(left, L.DAY_CAP);
        levels.addXp({ kind: 'g', id: g }, n, 'test', left - n > 0 ? t : now);
        left -= n;
        t += DAY / 3;
    }
    assert.equal(guestRow(g).xp, want);
    return g;
}

class Jar {
    constructor(c) { this.c = Object.assign({}, c || {}); }
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
let ipSeq = 0;
async function post(p, body, jar) {
    const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Forwarded-For': '10.44.' + Math.floor(++ipSeq / 250) + '.' + (ipSeq % 250 + 1) };
    if (jar) headers.Cookie = jar.header();
    const res = await fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body || {}), redirect: 'manual' });
    if (jar) jar.take(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { void e; }
    return { status: res.status, json, text };
}

function checkCarried(r, g, level) {
    assert.ok(r.json.carried, 'the response says what came over: ' + r.text);
    assert.equal(r.json.carried.level, level);
    assert.equal(r.json.level.level, level, 'the menu can paint the level at once');
    assert.equal(r.json.level.owner, 'account');
    assert.equal(guestRow(g).xp, 0);
    assert.equal(guestRow(g).xp_to, accounts.users.byUsername(r.json.user.username).id);
}

function wantedItems(level) {
    return L.rewardsBetween(1, level).filter(r => r.item).map(r => r.item).sort();
}

test('quick signup: the guest\'s level, unlocks and gemdust come over in the signup itself', async () => {
    accounts.ratelimit.reset();
    const g = guestAt(9, 7);
    const jar = new Jar();
    const r = await post('/api/auth/quick', { username: uname('Quick'), guestId: g }, jar);
    assert.equal(r.status, 201, r.text);
    checkCarried(r, g, 9);
    const u = accounts.users.byUsername(r.json.user.username);
    assert.equal(userRow(u.id).xp, L.START[9] + 7);
    assert.equal(userRow(u.id).level, 9);
    assert.deepEqual(levelItems(u.id), wantedItems(9));
    assert.deepEqual(r.json.carried.items.map(i => i.id).sort(), wantedItems(9));
    const paid = L.rewardsBetween(1, 9).reduce((s, x) => s + x.dustMilli, 0);
    assert.equal(levelDust(u.id), paid);
    assert.equal(r.json.carried.dustMilli, paid);
    assert.equal(r.json.user.dust * 1000, userRow(u.id).dust_milli, 'the user in the response already has the dust');
    const lv = await post('/api/levels', { guestId: g }, jar);
    assert.equal(lv.status, 200);
    assert.equal(lv.json.owner, 'account');
    assert.equal(lv.json.level, 9);
    assert.equal(lv.json.adoptedNow, null, 'nothing is left to move');
    const gv = await post('/api/levels', { guestId: g });
    assert.equal(gv.json.owner, 'guest');
    assert.equal(gv.json.level, 1);
    assert.equal(gv.json.moved, true);
    assert.deepEqual(gv.json.saved.items, [], 'the guest has nothing waiting any more');
});

test('quick signup: a browser that was once logged in to another account still carries over (the reported bug)', async () => {
    accounts.ratelimit.reset();
    const old = mkUser({ createdAt: Date.now() - 30 * DAY });
    const g = gid();
    guests.seen(g, Date.now(), null);
    assert.equal(guests.converted(g, old.id), true, 'this browser played logged in to an old account first');
    levels.addXp({ kind: 'g', id: g }, L.START[4] + 5, 'test');
    banks.checkout('g:' + g, 'seed-' + g);
    banks.release('seed-' + g, 900);
    const r = await post('/api/auth/quick', { username: uname('Again'), guestId: g }, new Jar());
    assert.equal(r.status, 201, r.text);
    checkCarried(r, g, 4);
    assert.equal(r.json.carried.bankGems, 900, 'the bank comes too');
    assert.equal(userRow(old.id).xp, 0, 'the old account got nothing');
    assert.equal(banks.peek('a:' + old.id), 0);
});

test('password signup: carries the guest\'s level too', async () => {
    accounts.ratelimit.reset();
    const g = guestAt(6);
    const r = await post('/api/auth/signup', { username: uname('Pass'), password: 'a-long-pass-phrase-77', guestId: g }, new Jar());
    assert.equal(r.status, 201, r.text);
    checkCarried(r, g, 6);
    assert.deepEqual(levelItems(accounts.users.byUsername(r.json.user.username).id), wantedItems(6));
});

test('discord signup: carries the guest\'s level too', async () => {
    accounts.ratelimit.reset();
    const g = guestAt(5);
    const pending = scrypto.sign('pending', { d: '4040404040404040' + (seq % 90 + 10), n: 'Disco Digger', a: null }, 60000);
    const jar = new Jar({ dw_pending: encodeURIComponent(pending) });
    const r = await post('/api/auth/discord/complete', { username: uname('Disco'), guestId: g }, jar);
    assert.equal(r.status, 201, r.text);
    checkCarried(r, g, 5);
    assert.ok(accounts.users.byUsername(r.json.user.username).discord_id);
});

test('signup without a guest id: the game connection still carries it over (old clients)', async () => {
    accounts.ratelimit.reset();
    const g = guestAt(3);
    const r = await post('/api/auth/quick', { username: uname('NoId') }, new Jar());
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.carried, null);
    const u = accounts.users.byUsername(r.json.user.username);
    const s = mkSocket(u, g);
    require('../../server/accounts/game/bridge').onGuestId(s);
    assert.equal(userRow(u.id).level, 3);
    assert.ok(s.packets.some(p => p[0] === 'm' && /Your levels came with you: you are Level 3/.test(p[2])), 'the player is told in game');
});

function mkSocket(u, g) {
    const s = { id: 'ls' + (++seq), guestId: g || null, packets: [], terminated: false, player: { body: null }, lastInputAt: Date.now() };
    if (u) s.account = { id: u.id, publicId: u.public_id, username: u.username, blocked: new Set() };
    s.talk = (type, ...args) => s.packets.push([type, ...args]);
    return s;
}

test('login to an existing account: recent guest XP joins inside today\'s cap, the rest joins on later days', async () => {
    accounts.ratelimit.reset();
    const pw = 'existing-pass-phrase-42';
    const u = mkUser({ createdAt: Date.now() - 20 * DAY, passwordHash: await scrypto.hashPassword(pw) });
    levels.addXp({ kind: 'a', id: u.id }, 900, 'test');
    assert.equal(userRow(u.id).dayXp, 900);
    const g = gid();
    guests.seen(g, Date.now(), null);
    levels.addXp({ kind: 'g', id: g }, 300, 'test');
    const r = await post('/api/auth/login', { username: u.username, password: pw, guestId: g }, new Jar());
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.carried, r.text);
    assert.equal(r.json.carried.levelXp, 100, 'only what fits under today\'s cap');
    assert.equal(r.json.carried.levelLeft, 200);
    assert.equal(userRow(u.id).xp, 1000);
    assert.equal(userRow(u.id).dayXp, L.DAY_CAP);
    assert.equal(guestRow(g).xp, 200, 'the rest stays with the guest, never lost');
    const again = levels.adoptGuest(u.id, g);
    assert.equal(again.moved, false, 'nothing more today');
    assert.equal(again.capped, true);
    const tomorrow = Date.now() + DAY;
    const later = levels.adoptGuest(u.id, g, tomorrow);
    assert.equal(later.moved, true);
    assert.equal(later.guestXp, 200);
    assert.equal(userRow(u.id).xp, 1200);
    assert.equal(guestRow(g).xp, 0);
    assert.equal(levels.adoptGuest(u.id, g, tomorrow).moved, false, 'once');
});

test('login to an existing account: guest XP older than a week stays the guest\'s', () => {
    const u = mkUser({ createdAt: Date.now() - 60 * DAY });
    const g = gid();
    guests.seen(g, Date.now(), null);
    levels.addXp({ kind: 'g', id: g }, 250, 'test', Date.now() - (levels.MERGE_DAYS + 2) * DAY);
    const r = levels.adoptGuest(u.id, g);
    assert.equal(r.moved, false);
    assert.equal(r.left, 250);
    assert.equal(guestRow(g).xp, 250);
    assert.equal(userRow(u.id).xp, 0);
});

test('login via the menu (Discord login, recover): POST /api/levels merges for an existing account', async () => {
    const u = mkUser({ createdAt: Date.now() - 10 * DAY });
    const jar = new Jar({ dw_sid: accounts.sessions.create(u.id, { method: 'discord' }).token });
    const g = gid();
    guests.seen(g, Date.now(), null);
    levels.addXp({ kind: 'g', id: g }, L.START[3] + 4, 'test');
    const r = await post('/api/levels', { guestId: g }, jar);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.level, 3);
    assert.equal(r.json.adoptedNow.level, 3);
    assert.equal(r.json.adoptedNow.xp, L.START[3] + 4);
    assert.deepEqual(levelItems(u.id), wantedItems(3));
});

test('double adoption: signup, the menu, the game connection and a save code never pay twice', async () => {
    accounts.ratelimit.reset();
    const g = guestAt(10, 3);
    const jar = new Jar();
    const r = await post('/api/auth/quick', { username: uname('Twice'), guestId: g }, jar);
    assert.equal(r.status, 201, r.text);
    const u = accounts.users.byUsername(r.json.user.username);
    const before = { row: userRow(u.id), grants: grantRows(u.id), dust: levelDust(u.id), items: levelItems(u.id) };
    assert.equal(before.row.level, 10);
    assert.equal((await post('/api/levels', { guestId: g }, jar)).json.adoptedNow, null);
    assert.equal((await post('/api/auth/quick', { username: uname('Twice2'), guestId: g }, new Jar())).json.carried, null, 'a second account on the same browser gets nothing');
    const s = mkSocket(u, g);
    require('../../server/accounts/game/bridge').onGuestId(s);
    assert.equal(hooks.adoptGuest(s, g, u.id).moved, false);
    assert.equal(levels.adoptGuest(u.id, g).moved, false);
    const after = { row: userRow(u.id), grants: grantRows(u.id), dust: levelDust(u.id), items: levelItems(u.id) };
    assert.deepEqual(after, before);
    assert.ok(!s.packets.some(p => p[0] === 'm' && /levels came with you/.test(p[2])), 'no second message');
    assert.equal(before.grants, 9);
});

test('no XP: a guest with nothing, a guest id never seen, and no guest id all sign up cleanly at level 1', async () => {
    accounts.ratelimit.reset();
    const g = gid();
    guests.seen(g, Date.now(), null);
    for (const body of [{ guestId: g }, { guestId: gid() }, {}, { guestId: 'not-a-guest-id' }]) {
        const r = await post('/api/auth/quick', Object.assign({ username: uname('Empty') }, body), new Jar());
        assert.equal(r.status, 201, r.text);
        assert.equal(r.json.carried, null);
        const u = accounts.users.byUsername(r.json.user.username);
        assert.equal(userRow(u.id).level, 1);
        assert.equal(grantRows(u.id), 0);
        if (body.guestId === g) assert.equal(r.json.level.level, 1, 'the level view still comes back');
    }
});

test('together: bank, stats, achievements, daily rewards, champion dust and levels all move in the one signup', async () => {
    accounts.ratelimit.reset();
    const g = guestAt(4);
    guests.life(g, { kills: 3, botKills: 5, score: 900, ms: 120000 });
    banks.checkout('g:' + g, 'seed-' + g);
    banks.release('seed-' + g, 1800);
    const def = achievements.DEFS.find(d => !d.secret && d.rewardMilli > 0 && !d.id.startsWith('c:'));
    D().run('INSERT INTO guest_achievements (guest_id, achievement_id, progress, unlocked_at) VALUES (?, ?, ?, ?)', g, def.id, def.goal, Date.now() - 1000);
    retention.claim({ kind: 'g', id: g }, Date.now() - 2 * DAY);
    retention.claim({ kind: 'g', id: g }, Date.now() - DAY + 3600e3);
    dailyScores.available();
    D().run('INSERT INTO ao_daily_champs (day, place, who, name, score, dust_milli, paid_at, created_at) VALUES (?, 2, ?, ?, 500, 10000, NULL, ?)', 'd' + seq, 'g:' + g, 'Guest', Date.now());
    const r = await post('/api/auth/quick', { username: uname('All'), guestId: g }, new Jar());
    assert.equal(r.status, 201, r.text);
    const c = r.json.carried;
    const u = accounts.users.byUsername(r.json.user.username);
    assert.equal(c.level, 4);
    assert.equal(c.bankGems, 1800);
    assert.equal(banks.peek('a:' + u.id), 1800);
    assert.equal(c.achievements, 1);
    assert.equal(c.daily, true);
    assert.ok(D().get('SELECT 1 AS x FROM daily_track WHERE user_id = ?', u.id));
    const st = D().get('SELECT lives, kills, bot_kills FROM user_stats WHERE user_id = ?', u.id);
    assert.deepEqual({ ...st }, { lives: 1, kills: 3, bot_kills: 5 });
    assert.ok(c.dustMilli >= 10000 + def.rewardMilli + L.rewardsBetween(1, 4).reduce((s, x) => s + x.dustMilli, 0));
    assert.equal(D().get("SELECT paid_at IS NOT NULL AS p FROM ao_daily_champs WHERE who = ?", 'a:' + u.id).p, 1);
    const s = mkSocket(u, g);
    require('../../server/accounts/game/bridge').onGuestId(s);
    assert.equal(s.packets.filter(p => p[0] === 'm').length, 0, 'the game connection finds nothing left to say');
});

test('save code: an account restoring a guest\'s save takes that guest\'s levels, once', () => {
    const u = mkUser();
    const g = guestAt(3);
    const s = mkSocket(u, gid());
    const r = hooks.adoptGuest(s, g, u.id);
    assert.equal(r.moved, true);
    assert.equal(userRow(u.id).level, 3);
    assert.equal(hooks.adoptGuest(s, g, u.id).moved, false);
    const src = fs.readFileSync(path.join(REPO, 'server/game/terrain/saveCodes.js'), 'utf8');
    assert.match(src, /carryGuestLevels\(socket, res\.savedBy\)/);
    assert.match(src, /levelHooks'\)\.adoptGuest\(socket, g, socket\.account\.id\)/);
});

test('wiring: the client sends the guest id with every sign up and log in, the cache is per owner, no comments, no dashes', () => {
    const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
    const api = rd('public/client/account/api.js');
    for (const route of ['signup', 'quick', 'login', 'recover', 'discord/complete']) assert.match(api, new RegExp("'/api/auth/" + route.replace('/', '\\/') + "', withGuest\\("), route);
    const lv = rd('public/client/account/levels.js');
    assert.match(lv, /export function carried\(user, data\)/);
    assert.match(lv, /c\.by\[key\] = /);
    assert.match(rd('public/client/levelsEarly.js'), /c\.by\[key\]/);
    assert.match(rd('public/client/account/main.js'), /levels\.carried\(user, data\)/);
    assert.equal((rd('public/client/account/welcome.js').match(/hooks\.onAuthed\(r\.data\.user, '\w+', r\.data\)/g) || []).length, 5);
    for (const f of ['server/accounts/guestAdopt.js', 'server/accounts/levels.js', 'server/accounts/routes/levels.js', 'public/client/account/levels.js', 'public/client/levelsEarly.js', 'scripts/test/levelsAdopt.test.js']) {
        const src = rd(f);
        assert.doesNotMatch(src, /[\u2013\u2014]/, f + ' has no long dashes');
        assert.doesNotMatch(src, /^\s*(\/\/|\/\*|\*\s|<!--)/m, f + ' has no comment lines');
        assert.doesNotMatch(src, /[;,(){}\]]\s+\/\/\s/, f + ' has no trailing comments');
    }
});

(async () => {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...a) => { if (!/^\[(accounts|backup|discord|clientIp|push)\]/.test(String(a[0]))) quietLog(...a); };
    console.warn = (...a) => { if (!/^\[(accounts|backup|discord|clientIp|push)\]/.test(String(a[0]))) quietWarn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    hooks = require('../../server/accounts/game/levelHooks');
    hooks._force(true);
    const server = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    BASE = `http://127.0.0.1:${port}`;
    ORIGIN = `http://localhost:${port}`;
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); quietLog('ok   ' + t.name); }
        catch (e) { failed++; quietLog('FAIL ' + t.name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 8).join('\n     ')); }
    }
    server.close();
    try { accounts.shutdown(); } catch (e) { void e; }
    quietLog(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
})();
