// Phase 5 tests: node scripts/test/phase5.test.js
//
//   discord   Ed25519 verification with a locally generated key, the
//             /discord/interactions endpoint over HTTP (PING, 401, admin
//             gating + audit, grantdust floor, ban/unban, reset link,
//             player commands)
//   quests    deterministic assignment, progress -> completion -> exempt
//             quest dust (DQ + DU kind 6), paid once, GET /api/quests
//   ach       event / counter / stat unlocks, ACH once, the 'ach' bus message
//   backup    encrypt/decrypt round trip, tamper + wrong key refused, a real
//             runBackup restored by scripts/restore-backup.js, rotation
//
// Data goes under $DATA_DIR if set, otherwise the OS temp dir; it is removed
// when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const nodeCrypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `phase5-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-phase5-test-'));
const DATA_DIR = path.join(ROOT, 'data');

// ---- a local Discord application ----
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
const PUB_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const APP = '111111111111111111', GUILD = '222222222222222222', ADMIN = '333333333333333333', OTHER = '444444444444444444';
const BACKUP_KEY = nodeCrypto.randomBytes(32).toString('base64');

process.env.DATA_DIR = DATA_DIR;
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ROYALE_DEBUG', 'ACCOUNTS_ALLOW_DEBUG', 'DISCORD_BOT_TOKEN',
    'DISCORD_ANNOUNCE_CHANNEL_ID', 'DISCORD_BACKUP_CHANNEL_ID']) delete process.env[k];
Object.assign(process.env, {
    NODE_ENV: 'test', ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'phase5-test-secret-0123456789-abcdefghijkl',
    DISCORD_APP_ID: APP, DISCORD_PUBLIC_KEY: PUB_HEX, DISCORD_ADMIN_GUILD_ID: GUILD, ADMIN_DISCORD_IDS: ADMIN,
    BACKUP_ENCRYPTION_KEY: BACKUP_KEY, PORT: '3000',
});

const accounts = require('../../server/accounts');
const verify = require('../../server/accounts/discord/verify');
const quests = require('../../server/accounts/quests');
const achievements = require('../../server/accounts/achievements');
const backup = require('../../server/accounts/backup');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const D = () => accounts.db.handle();
let seq = 0;
function mkUser(prefix = 'p5') {
    const r = accounts.users.create({ username: (prefix + '_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const row = id => D().get('SELECT * FROM users WHERE id = ?', id);

// ---- HTTP ----
let base = '';
function sign(body, ts = String(Math.floor(Date.now() / 1000))) {
    return { ts, sig: nodeCrypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex') };
}
async function interact(obj, opts = {}) {
    const body = JSON.stringify(obj);
    const s = sign(opts.signBody != null ? opts.signBody : body, opts.ts);
    const r = await fetch(base + '/discord/interactions', {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': opts.sig || s.sig, 'X-Signature-Timestamp': s.ts },
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* */ }
    return { status: r.status, json };
}
function cmd(name, options = [], who = ADMIN, guild = GUILD, extra = {}) {
    return { type: 2, application_id: APP, guild_id: guild || undefined, member: { user: { id: who, username: 'tester' } }, data: { name, options, ...extra } };
}
const o = (name, value, type = 3) => ({ name, type, value });

// ===================================================================
// Discord
// ===================================================================

test('verify: good signature, tampered body, stale timestamp, junk', () => {
    const body = '{"type":1}';
    const { ts, sig } = sign(body);
    assert.equal(verify.verify(PUB_HEX, sig, ts, body), true);
    assert.equal(verify.verify(PUB_HEX, sig, ts, body + ' '), false);
    const old = String(Math.floor(Date.now() / 1000) - 400);
    assert.equal(verify.verify(PUB_HEX, sign(body, old).sig, old, body), false);
    assert.equal(verify.verify(PUB_HEX, 'zz', ts, body), false);
    assert.equal(verify.verify(PUB_HEX, sig, 'abc', body), false);
    const other = nodeCrypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    assert.equal(verify.verify(other, sig, ts, body), false);
});

test('interactions: PING -> PONG, bad signature -> 401', async () => {
    const ok = await interact({ type: 1, application_id: APP });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { type: 1 });
    const bad = await interact({ type: 1, application_id: APP }, { signBody: '{"type":1,"x":1}' });
    assert.equal(bad.status, 401);
    const none = await interact({ type: 1 }, { sig: '00'.repeat(64) });
    assert.equal(none.status, 401);
});

test('interactions: admin gating (non-admin, wrong guild, DM) refused and audited', async () => {
    const u = mkUser();
    const before = D().get("SELECT count(*) AS n FROM audit_log WHERE action = 'admin_denied'").n;
    for (const [who, guild] of [[OTHER, GUILD], [ADMIN, '999999999999999999'], [ADMIN, null]]) {
        const r = await interact(cmd('grantdust', [o('user', u.username), o('amount', 5, 10), o('reason', 'x')], who, guild));
        assert.equal(r.status, 200);
        assert.equal(r.json.data.flags, 64);
        assert.match(r.json.data.content, /not allowed/);
    }
    assert.equal(row(u.id).dust_milli, 0);
    assert.equal(D().get("SELECT count(*) AS n FROM audit_log WHERE action = 'admin_denied'").n, before + 3);
});

test('interactions: /grantdust adds, claws back floored at 0, ledger + audit + game resync', async () => {
    const u = mkUser();
    const seen = [];
    const unsub = accounts.bus.onGame(m => seen.push(m));
    let r = await interact(cmd('grantdust', [o('user', u.username), o('amount', 5.5, 10), o('reason', 'event prize')]));
    assert.match(r.json.data.content, /Added 5\.5 dust/);
    assert.equal(r.json.data.flags, 64);
    assert.equal(row(u.id).dust_milli, 5500);
    r = await interact(cmd('grantdust', [o('user', u.public_id), o('amount', -100, 10), o('reason', 'oops')]));
    assert.match(r.json.data.content, /floored at 0/);
    assert.equal(row(u.id).dust_milli, 0);
    const led = D().all("SELECT delta_milli, balance_milli FROM dust_ledger WHERE user_id = ? AND kind = 'admin' ORDER BY id", u.id);
    assert.deepEqual(led, [{ delta_milli: 5500, balance_milli: 5500 }, { delta_milli: -5500, balance_milli: 0 }]);
    assert.equal(D().get("SELECT count(*) AS n FROM audit_log WHERE user_id = ? AND action = 'admin_grant_dust' AND actor = ?", u.id, 'admin:' + ADMIN).n, 2);
    assert.equal(seen.filter(m => m.t === 'dustChanged' && m.userId === u.id).length, 2);
    unsub();
});

test('interactions: /ban revokes sessions and kicks, /unban clears; /lookup, /resetpassword, /relink', async () => {
    const u = mkUser();
    accounts.sessions.create(u.id, { method: 'password' });
    const kicks = [];
    const unsub = accounts.bus.onGame(m => { if (m.t === 'kick') kicks.push(m); });
    let r = await interact(cmd('ban', [o('user', u.username), o('duration', '7d'), o('reason', 'cheating')]));
    assert.match(r.json.data.content, /Banned/);
    const b = row(u.id);
    assert.ok(b.banned_until > Date.now() + 6 * 86400000 && b.banned_until < Date.now() + 8 * 86400000);
    assert.equal(b.ban_reason, 'cheating');
    assert.equal(D().get('SELECT count(*) AS n FROM sessions WHERE user_id = ?', u.id).n, 0);
    assert.equal(kicks.length, 1);
    r = await interact(cmd('ban', [o('user', u.username), o('duration', 'perm'), o('reason', 'again')]));
    assert.ok(row(u.id).banned_until >= 8e15);
    r = await interact(cmd('unban', [o('user', u.username)]));
    assert.match(r.json.data.content, /Unbanned/);
    assert.equal(row(u.id).banned_until, null);
    unsub();

    r = await interact(cmd('lookup', [o('query', u.public_id.toLowerCase())]));
    assert.ok(r.json.data.content.includes(u.public_id));
    assert.equal(r.json.data.flags, 64);

    r = await interact(cmd('resetpassword', [o('user', u.username)]));
    const m = /#reset=([A-Za-z0-9_-]+)/.exec(r.json.data.content);
    assert.ok(m, r.json.data.content);
    assert.equal(accounts.users.peekResetToken(m[1]).id, u.id);
    // a second link replaces the first
    r = await interact(cmd('resetpassword', [o('user', u.username)]));
    assert.equal(accounts.users.peekResetToken(m[1]), null);
    const page = await fetch(base + '/auth/reset');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);

    const v = mkUser();
    const did = '555555555555555555';
    r = await interact(cmd('relink', [o('user', u.username), o('discord', did, 6)], ADMIN, GUILD, { resolved: { users: { [did]: { id: did, username: 'newdisc' } } } }));
    assert.equal(row(u.id).discord_id, did);
    r = await interact(cmd('relink', [o('user', v.username), o('discord', did, 6)]));
    assert.match(r.json.data.content, /force/);
    assert.equal(row(u.id).discord_id, did);
    r = await interact(cmd('relink', [o('user', v.username), o('discord', did, 6), o('force', true, 5)]));
    assert.equal(row(v.id).discord_id, did);
    assert.equal(row(u.id).discord_id, null);
});

test('interactions: player commands are public; /profile uses the linked account', async () => {
    const u = mkUser();
    D().run('UPDATE users SET discord_id = ? WHERE id = ?', '666666666666666666', u.id);
    let r = await interact(cmd('profile', [], '666666666666666666', null));
    assert.equal(r.json.type, 4);
    assert.equal(r.json.data.flags, undefined);
    assert.ok(r.json.data.embeds[0].title.includes(u.username.split('_')[0]));
    r = await interact(cmd('rank', [o('username', u.username)], OTHER, null));
    assert.match(r.json.data.content, /Placement/);
    r = await interact(cmd('profile', [], OTHER, null));
    assert.match(r.json.data.content, /isn't linked/);
    r = await interact(cmd('leaderboard', [], OTHER, null));
    assert.equal(r.json.type, 4);
    assert.deepEqual(r.json.data.allowed_mentions, { parse: [] });
});

// ===================================================================
// Quests + achievements (game-thread hooks on a fake socket)
// ===================================================================

let progress = null;
function mkSocket(user) {
    const s = { id: 'sock' + (++seq), account: { id: user.id, publicId: user.public_id, username: user.username }, packets: [], terminated: false, player: { body: null } };
    s.talk = (type, ...args) => s.packets.push([type, ...args]);
    return s;
}
const packets = (s, t) => s.packets.filter(p => p[0] === t);

test('quests: assignment is deterministic, one per tier, distinct events', () => {
    for (let uid = 1; uid < 200; uid++) {
        const a = quests.assign(uid, 20000);
        assert.deepEqual(a, quests.assign(uid, 20000));
        const defs = a.map(x => quests.BY_ID.get(x.id));
        assert.deepEqual(defs.map(d => d.tier), ['easy', 'medium', 'hard']);
        assert.equal(new Set(defs.map(d => d.event)).size, 3);
    }
    const days = new Set();
    for (let d = 0; d < 30; d++) days.add(quests.assign(7, 20000 + d).map(x => x.id).join());
    assert.ok(days.size > 5, 'rotates day to day');
});

test('quests: progress -> completion pays exempt quest dust once (DQ, DU kind 6), API view', async () => {
    global.Config = { dig_royale: true };
    progress = require('../../server/accounts/game/progressHooks');
    assert.equal(require('../../server/accounts/game/bridge').rankedOn(), true);
    const u = mkUser();
    // past today's soft cap: quest dust must still pay in full
    D().run('UPDATE users SET earn_day = ?, earn_day_milli = 999999 WHERE id = ?', Math.floor(Date.now() / 86400000), u.id);
    const sock = mkSocket(u);
    progress.sendAll(sock);
    assert.equal(packets(sock, 'DQ').length, 3);
    const c = progress.load(u.id);
    const q0 = c.list[0], q2 = c.list[2];
    // part way, then saved
    if (q0.goal > 1) {
        progress.bump(sock, q0.event, 1);
        progress.saveAll();
        assert.equal(D().get('SELECT progress FROM daily_quests WHERE user_id = ? AND slot = 0', u.id).progress, 1);
    }
    progress.bump(sock, q0.event, q0.goal);
    progress.bump(sock, q2.event, q2.goal);
    progress.bump(sock, q0.event, q0.goal);    // already done: nothing more
    const dq = packets(sock, 'DQ').map(p => JSON.parse(p[1]));
    const done0 = dq.filter(x => x.slot === 0 && x.done);
    assert.equal(done0.length, 1);
    assert.deepEqual(Object.keys(done0[0]).sort(), ['done', 'goal', 'id', 'progress', 'rewardMilli', 'slot', 'text']);
    assert.equal(done0[0].rewardMilli, 100);
    const du6 = packets(sock, 'DU').filter(p => p[4] === 6).map(p => p[3]);
    assert.deepEqual(du6, [100, 400]);
    assert.equal(row(u.id).dust_milli, 500);
    assert.deepEqual(D().all("SELECT delta_milli FROM dust_ledger WHERE user_id = ? AND kind = 'quest' ORDER BY id", u.id).map(r => r.delta_milli), [100, 400]);
    assert.equal(quests.complete(u.id, c.day, 0), null, 'paid once');
    // the menu API
    const s = accounts.sessions.create(u.id, { method: 'password' });
    const r = await fetch(base + '/api/quests', { headers: { Cookie: `${accounts.config.cookies.session}=${s.token}` } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.day, c.day);
    assert.equal(j.resetsAt, (c.day + 1) * 86400000);
    assert.deepEqual(j.quests.map(q => q.done), [true, false, true]);
    assert.deepEqual(Object.keys(j.quests[1]).sort(), ['done', 'goal', 'id', 'progress', 'rewardMilli', 'slot', 'text']);
    const ra = await fetch(base + '/api/achievements', { headers: { Cookie: `${accounts.config.cookies.session}=${s.token}` } });
    assert.equal((await ra.json()).achievements.length, 12);
});

test('achievements: event, counter and stat unlocks send ACH once and tell the main thread', () => {
    const u = mkUser();
    const sock = mkSocket(u);
    const bus = [];
    const unsub = accounts.bus.onMain((sid, m) => { if (m.t === 'ach') bus.push(m.id); });
    progress.onBoss({ socket: sock });
    progress.onBoss({ socket: sock });
    progress.onStreak({ socket: sock }, 4);
    progress.onStreak({ socket: sock }, 5);
    for (let i = 0; i < 25; i++) progress.onPickup({ socket: sock, carriedGems: 3100 }, { gemOre: 4 });
    progress.onPickup({ socket: sock, carriedGems: 10 }, { gemOre: 4 });
    D().run('UPDATE user_stats SET kills = 1, gems_banked = 12000, lives = 3 WHERE user_id = ?', u.id);
    progress.checkStats(sock, u.id);
    progress.checkStats(sock, u.id);
    const ids = packets(sock, 'ACH').map(p => JSON.parse(p[1]).id).sort();
    assert.deepEqual(ids, ['banker', 'boss_slayer', 'emerald_eye', 'first_blood', 'hoarder', 'streaker']);
    assert.deepEqual(bus.slice().sort(), ids);
    assert.deepEqual([...achievements.unlockedSet(u.id)].sort(), ids);
    const list = achievements.list(u.id);
    assert.equal(list.find(a => a.id === 'veteran').progress, 3);
    assert.equal(list.find(a => a.id === 'emerald_eye').unlockedAt != null, true);
    unsub();
});

// ===================================================================
// Backups
// ===================================================================

test('backup: encrypt/decrypt round trip; tamper and wrong key refused', async () => {
    const key = accounts.config.parseBackupKey(BACKUP_KEY);
    const plain = nodeCrypto.randomBytes(200000);
    const packed = await backup.pack(plain, key);
    assert.equal(packed.subarray(0, 4).toString(), 'DWB1');
    assert.ok((await backup.unpack(packed, key)).equals(plain));
    const bad = Buffer.from(packed); bad[bad.length - 5] ^= 1;
    await assert.rejects(backup.unpack(bad, key), /authentication/);
    await assert.rejects(backup.unpack(packed, nodeCrypto.randomBytes(32)), /authentication/);
    assert.throws(() => backup.decrypt(Buffer.from('nope'), key), /DWB1/);
    const parts = backup.splitParts(packed, 70000);
    assert.equal(parts.length, Math.ceil(packed.length / 70000));
    assert.ok(Buffer.concat(parts).equals(packed));
});

test('backup: runBackup -> restore-backup.js gives an intact copy of the database', async () => {
    const u = mkUser('bk');
    const res = await backup.runBackup({ upload: false });
    assert.ok(fs.existsSync(res.file));
    assert.equal((fs.statSync(res.file).mode & 0o777), 0o600);
    assert.equal(Number(D().get("SELECT value FROM meta WHERE key = 'backup_last_at'").value) > 0, true);
    // split it the way the Discord upload does, restore from the parts
    const parts = backup.splitParts(fs.readFileSync(res.file), 4096);
    parts.forEach((p, k) => fs.writeFileSync(`${res.file}.part${k + 1}of${parts.length}`, p));
    const out = path.join(ROOT, 'restored.db');
    const run = spawnSync(process.execPath, [path.join(REPO, 'scripts/restore-backup.js'), `${res.file}.part2of${parts.length}`, out],
        { env: { ...process.env, BACKUP_ENCRYPTION_KEY: BACKUP_KEY }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(backup.integrityCheck(out), 'ok');
    const { DatabaseSync } = require('node:sqlite');
    const r = new DatabaseSync(out, { readOnly: true });
    assert.equal(r.prepare('SELECT username FROM users WHERE id = ?').get(u.id).username, u.username);
    r.close();
    const wrong = spawnSync(process.execPath, [path.join(REPO, 'scripts/restore-backup.js'), res.file, out + '2'],
        { env: { ...process.env, BACKUP_ENCRYPTION_KEY: nodeCrypto.randomBytes(32).toString('base64') }, encoding: 'utf8' });
    assert.notEqual(wrong.status, 0);
});

test('backup: rotation keeps 14 daily, 8 weekly, 6 monthly', () => {
    const DAY = 86400000;
    const t0 = Date.UTC(2026, 8, 24, 3);
    const names = [];
    for (let d = 0; d < 400; d++) names.push(backup.fileName(t0 - d * DAY));
    names.push(backup.fileName(t0 - 3600000));          // two on the newest day
    names.push('pre-migrate-v1-2026.db', 'notes.txt');   // never touched
    const del = new Set(backup.planRotation(names));
    const kept = names.filter(n => !del.has(n) && backup.timeOf(n) != null);
    assert.ok(!del.has('pre-migrate-v1-2026.db') && !del.has('notes.txt'));
    assert.ok(kept.includes(backup.fileName(t0)));
    assert.ok(!kept.includes(backup.fileName(t0 - 3600000)), 'older copy of the same day goes');
    for (let d = 0; d < 14; d++) assert.ok(kept.includes(backup.fileName(t0 - d * DAY)));
    assert.ok(kept.length >= 14 && kept.length <= 14 + 8 + 6, 'kept ' + kept.length);
    const oldest = Math.min(...kept.map(backup.timeOf));
    assert.ok(t0 - oldest > 140 * DAY && t0 - oldest < 190 * DAY, 'monthly reach');
});

// ===================================================================

async function main() {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...args) => { if (!/^\[(accounts|backup|discord)\]/.test(String(args[0]))) quietLog(...args); };
    console.warn = (...args) => { if (!/^\[(accounts|backup|discord)\]/.test(String(args[0]))) quietWarn(...args); };
    assert.equal(accounts.initMain(), true, 'initMain');
    const server = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
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
