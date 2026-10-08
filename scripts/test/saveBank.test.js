// Save codes and the persistent bank: node scripts/test/saveBank.test.js
//
//   store  on a throwaway database, in this process:
//          the v8 -> v9 migration (backup first, every row kept); banks.js
//          checkout / release / the 50,000 cap, two sessions at once never
//          spending the same gems, a crashed lease coming back from its
//          checkpoint; saves.js single use, the 7 day expiry, the mode
//          binding, one restore per 10 minutes per account, guest and IP
//   e2e    one local server (ports 6190-6193, ROYALE_DEBUG=1, a scratch
//          DATA_DIR) and socket-level clients:
//          bank    kept across a disconnect, a death (10% lost), the 45 s
//                  resume (not counted twice) and a new raid; never score or
//                  growth; two tabs of one guest can't duplicate it
//          save    the 20 s hold (moving, getting hurt, the storm stop it),
//                  the code, the tank gone at once with nothing dropped, the
//                  life settled as a leave
//          restore class, satchel, points and growth back (past the respawn
//                  cap), the points and satchel never count for rank or
//                  placement, single use, the 10 minute gap, expiry
//          SAVEBANK_E2E=0 skips it.
//
// Data goes under $DATA_DIR if set (point it at a scratch directory),
// otherwise the OS temp dir; it is removed when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

for (const k of ['ROYALE_DEBUG', 'ROYALE_SAVE_HOLD_MS', 'ROYALE_RESUME_MS', 'ACCOUNTS_ALLOW_DEBUG']) delete process.env[k];

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `savebank-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-savebank-test-'));
const DATA_DIR = path.join(ROOT, 'data');
const E2E_DATA_DIR = path.join(ROOT, 'e2e-data');
const SECRET = 'savebank-test-secret-0123456789-abcdefghij';
process.env.DATA_DIR = DATA_DIR;
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS']) delete process.env[k];
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = SECRET;

const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const migrations = require('../../server/accounts/migrations');
const banks = require('../../server/accounts/banks');
const saves = require('../../server/accounts/saves');
const D = () => dbmod.handle();

let seq = 0;
function mkUser() {
    const r = accounts.users.create({ username: ('sv_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const gid = (n) => n.toString(16).padStart(32, 'a').slice(-32);
const leases = (owner) => D().get('SELECT count(*) AS n FROM bank_leases WHERE owner = ?', owner).n;

// ===================================================================
// store
// ===================================================================

test('migration: v8 -> v9 writes a backup first, keeps every row, adds saves, bank_gems and bank_leases', () => {
    const file = path.join(ROOT, 'mig', 'v8.db');
    const db = dbmod.open({ path: file, migrate: false });
    db.tx(() => {
        for (const m of migrations.MIGRATIONS.filter(x => x.version <= 8)) m.up(db);
        db.exec('PRAGMA user_version = 8');
    });
    db.run(`INSERT INTO users (id, public_id, username, username_lc, created_at) VALUES (1, 'DW-CCCCCCCC', 'Keep', 'keep', 1)`);
    for (let i = 1; i <= 10; i++) db.run('INSERT INTO guests (guest_id, first_seen, last_seen, games) VALUES (?, 1, 2, ?)', gid(i), i);
    const before = { users: db.all('SELECT * FROM users'), guests: db.all('SELECT * FROM guests') };
    const res = migrations.apply(db, { backupDir: path.join(ROOT, 'mig', 'backups') });
    // v9 here, and whatever came after it (v10: sidekick columns)
    assert.deepEqual(res.applied.slice(0, 1), [9]);
    assert.equal(res.applied[res.applied.length - 1], migrations.latestVersion());
    assert.ok(res.backup && fs.existsSync(res.backup), 'pre-migration backup');
    assert.match(path.basename(res.backup), /^pre-migrate-v9-/);
    const bk = dbmod.open({ path: res.backup, migrate: false });
    assert.equal(bk.userVersion(), 8);
    assert.equal(bk.get('SELECT count(*) AS n FROM guests').n, 10);
    bk.close();
    assert.equal(db.userVersion(), migrations.latestVersion());
    const strip = rows => rows.map(r => { const o = { ...r }; assert.equal(o.bank_gems, 0); delete o.bank_gems; for (const k of ['equip_sidekick', 'equip_sd_skin', 'equip_sd_name', 'sidekick_name', 'sidekick_color']) { if (k in o) assert.equal(o[k], null); delete o[k]; } return o; });
    assert.deepEqual(strip(db.all('SELECT * FROM users')), before.users);
    assert.deepEqual(strip(db.all('SELECT * FROM guests')), before.guests);
    assert.throws(() => db.run('UPDATE users SET bank_gems = -1 WHERE id = 1'), /CHECK/);
    assert.throws(() => db.run("INSERT INTO saves (code_hash, mode, data, created_at, expires_at) VALUES ('x', 'trios', '{}', 1, 2)"), /CHECK/);
    assert.throws(() => db.run("INSERT INTO bank_leases (lease_id, owner, at) VALUES ('l', 'x:1', 1)"), /CHECK/);
    assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
    assert.deepEqual(migrations.apply(db).applied, []);
    db.close();
});

test('banks: checkout takes the whole balance out, release puts it back, capped at 50,000', () => {
    const u = mkUser();
    const owner = 'a:' + u.id;
    assert.equal(banks.CAP, 50000);
    assert.equal(banks.checkout(owner, 'l1'), 0, 'a new account has nothing');
    assert.equal(banks.release('l1', 12345), 12345);
    assert.equal(banks.peek(owner), 12345);
    assert.equal(D().get('SELECT bank_gems FROM users WHERE id = ?', u.id).bank_gems, 12345, 'on the account row');
    assert.equal(banks.checkout(owner, 'l2'), 12345);
    assert.equal(banks.peek(owner), 0, 'nothing left at rest while it is out');
    assert.equal(leases(owner), 1);
    assert.equal(banks.release('l2', 80000), 50000, 'the cap');
    assert.equal(banks.release('l2', 999), null, 'a lease releases once');
    assert.equal(banks.peek(owner), 50000);
    assert.equal(leases(owner), 0);
});

test('banks: two sessions at once can never spend the same gems', () => {
    const u = mkUser();
    const owner = 'a:' + u.id;
    banks.checkout(owner, 'seed'); banks.release('seed', 5000);
    const a = banks.checkout(owner, 'tabA');
    const b = banks.checkout(owner, 'tabB');
    assert.equal(a, 5000);
    assert.equal(b, 0, 'the second tab finds nothing at rest');
    // A spends 1,000 at a shop, B banks 700 of its own
    banks.release('tabA', a - 1000);
    banks.release('tabB', b + 700);
    assert.equal(banks.peek(owner), 4700, 'what was really left plus what was earned');
    // and in the other order
    const c = banks.checkout(owner, 'tabC'), d2 = banks.checkout(owner, 'tabD');
    banks.release('tabD', d2 + 100);
    banks.release('tabC', c);
    assert.equal(banks.peek(owner), 4800);
});

test('banks: a crashed session comes back from its checkpoint; a late release only adds the difference', () => {
    const u = mkUser();
    const owner = 'a:' + u.id;
    banks.checkout(owner, 'seed'); banks.release('seed', 3000);
    const t0 = Date.now();
    assert.equal(banks.checkout(owner, 'crash', t0), 3000);
    assert.equal(banks.checkpoint('crash', 3600, t0 + 1000), true);
    // the stale sweep leaves a fresh lease alone
    assert.equal(banks.recoverStale(t0 + 2 * MIN), 0);
    assert.equal(banks.peek(owner), 0);
    // five quiet minutes: written back from the checkpoint
    banks.recoverStale(t0 + 7 * MIN);
    assert.equal(banks.peek(owner), 3600);
    // the thread was only stuck: its release adds what changed since (4000 - 3600)
    assert.equal(banks.release('crash', 4000), 4000);
    assert.equal(leases(owner), 0);
    // boot: every lease left over goes back and is gone
    banks.checkout(owner, 'boot1', t0);
    banks.checkpoint('boot1', 4200, t0);
    assert.equal(banks.peek(owner), 0);
    assert.ok(banks.recoverStale(Date.now(), 0, true) >= 1);
    assert.equal(banks.peek(owner), 4200);
    assert.equal(leases(owner), 0);
});

test('banks: guests keyed by guest id on the guests row; bad owners are refused', () => {
    const owner = 'g:' + gid(777);
    assert.equal(banks.checkout(owner, 'g1'), 0);
    assert.equal(banks.release('g1', 900), 900);
    assert.equal(D().get('SELECT bank_gems FROM guests WHERE guest_id = ?', gid(777)).bank_gems, 900);
    assert.equal(banks.checkout('g:nothex', 'bad1'), null);
    assert.equal(banks.checkout('a:0', 'bad2'), null);
    assert.equal(banks.checkout('x:12', 'bad3'), null);
    assert.equal(banks.parseOwner('g:' + gid(1)).kind, 'g');
});

test('saves: 25 random Crockford characters, only the hash stored, audited without an IP', () => {
    const u = mkUser();
    const made = saves.create({ mode: 'solo', userId: u.id, data: { v: 1, label: 'Sniper', carried: 400, pts: 900 }, score: 1100, ip: '203.0.113.9' });
    assert.match(made.code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    assert.ok(Math.abs(made.expiresAt - Date.now() - 7 * DAY) < 5000);
    const codes = new Set();
    for (let i = 0; i < 200; i++) codes.add(saves.newCode());
    assert.equal(codes.size, 200);
    assert.equal(D().get('SELECT count(*) AS n FROM saves WHERE data LIKE ?', '%' + made.code.replace(/-/g, '') + '%').n, 0);
    const row = D().get('SELECT code_hash, user_id, score FROM saves ORDER BY id DESC LIMIT 1');
    assert.equal(row.code_hash.length, 64);
    assert.equal(row.user_id, u.id);
    const a = D().get("SELECT user_id, ip, detail FROM audit_log WHERE action = 'save_create' ORDER BY id DESC LIMIT 1");
    assert.equal(a.user_id, u.id);
    assert.equal(a.ip, null);
    assert.equal(JSON.parse(a.detail).cls, 'Sniper');
    // typing it lower case, with spaces or look-alikes still works
    assert.equal(saves.normalize(made.code.toLowerCase().replace(/-/g, ' ')), made.code.replace(/-/g, ''));
    assert.equal(saves.normalize('ABC'), null);
});

test('saves: a code works once, only in its mode, and runs out after 7 days', () => {
    const u = mkUser(), v = mkUser();
    const t = Date.now();
    const made = saves.create({ mode: 'solo', userId: u.id, data: { pts: 500 } }, t);
    let r = saves.restore({ code: made.code, mode: 'duo', userId: v.id, ip: '198.51.100.1' }, t + 1000);
    assert.deepEqual([r.ok, r.reason, r.mode], [false, 'mode', 'solo']);
    r = saves.restore({ code: made.code, mode: 'solo', userId: v.id, ip: '198.51.100.1' }, t + 2000);
    assert.equal(r.ok, true, 'the wrong mode did not use it up');
    assert.equal(r.data.pts, 500);
    assert.equal(r.savedBy.userId, u.id);
    r = saves.restore({ code: made.code, mode: 'solo', userId: u.id, ip: '198.51.100.2' }, t + 20 * MIN);
    assert.deepEqual([r.ok, r.reason], [false, 'used']);
    const old = saves.create({ mode: 'duo', guestId: gid(55), data: { pts: 1 } }, t - 8 * DAY);
    r = saves.restore({ code: old.code, mode: 'duo', guestId: gid(56), ip: '198.51.100.3' }, t);
    assert.deepEqual([r.ok, r.reason], [false, 'expired']);
    r = saves.restore({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', mode: 'solo', userId: u.id }, t);
    assert.deepEqual([r.ok, r.reason], [false, 'unknown']);
    const used = D().get("SELECT detail FROM audit_log WHERE action = 'save_restore' ORDER BY id DESC LIMIT 1");
    assert.equal(JSON.parse(used.detail).savedBy, u.id);
});

test('saves: one restore per 10 minutes for an account, a guest, or an IP', () => {
    const u = mkUser(), w = mkUser();
    const t = Date.now() + 60 * MIN;     // clear of the other tests' restores
    const mk = () => saves.create({ mode: 'solo', userId: w.id, data: { pts: 1 } }, t).code;
    const c1 = mk(), c2 = mk(), c3 = mk(), c4 = mk(), c5 = mk();
    assert.equal(saves.restore({ code: c1, mode: 'solo', userId: u.id, ip: '192.0.2.10' }, t).ok, true);
    let r = saves.restore({ code: c2, mode: 'solo', userId: u.id, ip: '192.0.2.11' }, t + 9 * MIN);
    assert.deepEqual([r.ok, r.reason], [false, 'wait'], 'same account, another IP');
    assert.ok(r.waitMs > 50 * 1000 && r.waitMs <= MIN);
    r = saves.restore({ code: c2, mode: 'solo', guestId: gid(90), ip: '192.0.2.10' }, t + 9 * MIN);
    assert.deepEqual([r.ok, r.reason], [false, 'wait'], 'another player on the same IP');
    // the wait did not use the code up, and after 10 minutes it goes through
    assert.equal(saves.restore({ code: c2, mode: 'solo', userId: u.id, ip: '192.0.2.11' }, t + 10 * MIN + 1).ok, true);
    // guests: keyed by guest id
    assert.equal(saves.restore({ code: c3, mode: 'solo', guestId: gid(91), ip: '192.0.2.20' }, t).ok, true);
    r = saves.restore({ code: c4, mode: 'solo', guestId: gid(91), ip: '192.0.2.21' }, t + MIN);
    assert.deepEqual([r.ok, r.reason], [false, 'wait']);
    assert.equal(saves.restore({ code: c5, mode: 'solo', guestId: gid(92), ip: '192.0.2.22' }, t + MIN).ok, true, 'someone else is fine');
    // only a salted hash of the IP, gone after a day
    const ipCol = D().all('SELECT used_ip FROM saves WHERE used_ip IS NOT NULL').map(x => x.used_ip);
    assert.ok(ipCol.length >= 3 && ipCol.every(x => /^[0-9a-f]{32}$/.test(x) && !x.includes('192')));
    saves.sweep(t + 2 * DAY);
    assert.equal(D().get('SELECT count(*) AS n FROM saves WHERE used_ip IS NOT NULL AND used_at <= ?', t + DAY).n, 0);
});

// ===================================================================
// e2e
// ===================================================================

class Client {
    constructor(port, { cookie, token, name, guestId }) {
        const WebSocket = require(path.join(REPO, 'node_modules', 'ws'));
        this.ft = require('../../server/lib/fasttalk.js');
        const headers = { Origin: 'http://localhost:' + port };
        if (cookie) headers.Cookie = cookie;
        Object.assign(this, { log: [], closed: false, closeCode: null, name, token, guestId, spawnedOnce: false });
        this.ws = new WebSocket('ws://localhost:' + port, { headers });
        this.ws.binaryType = 'arraybuffer';
        this.ws.on('message', d => {
            const m = this.ft.decode(d);
            if (!m) return;
            const type = m.shift();
            this.log.push({ type, m, at: Date.now() });
            if (type === 'W') this.talk('k', '');
            if (type === 'w') { if (this.guestId) this.talk('GI', this.guestId, 'direct'); this.talk('RZ', this.token); this.talk('s', '', 1, 0, false, 0); }
            if (type === 'TG' && !this.spawnedOnce) { this.spawnedOnce = true; setTimeout(() => this.talk('s', this.name, 0, 0, false, 0), 200); }
        });
        this.ws.on('close', (code) => { this.closed = true; this.closeCode = code; });
        this.ws.on('error', err => { this.error = err; });
    }
    talk(...m) { try { this.ws.send(this.ft.encode(m)); } catch (e) { /* closed */ } }
    mark() { return this.log.length; }
    async waitFor(type, pred = () => true, from = 0, ms = 20000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const hit = this.log.slice(from).find(e => e.type === type && pred(e.m));
            if (hit) return hit;
            await sleep(50);
        }
        throw new Error(`${this.name}: timed out waiting for ${type}; saw ${[...new Set(this.log.slice(from).map(e => e.type))].join(',')}`);
    }
    async dbg(...args) {
        const i0 = this.mark();
        this.talk('DBG', ...args);
        return JSON.parse((await this.waitFor('KC', m => m[0] === 'dbg', i0, 5000)).m[1]);
    }
    async bank() { return (await this.dbg('bank')).bank; }
    // DBG kill sets health to -1, and health regen can land first and bring
    // the tank back (healthType 'dynamic'), so ask again until it sticks
    async die(from) {
        for (let i = 0; i < 8; i++) {
            this.talk('DBG', 'kill');
            try { return await this.waitFor('F', () => true, from, 1200); } catch (e) { /* again */ }
        }
        throw new Error(this.name + ' would not die');
    }
    async spawned() { await this.waitFor('c', () => true, 0, 20000); await sleep(600); }
    msgs(from = 0) { return this.log.slice(from).filter(e => e.type === 'm').map(e => String(e.m[e.m.length - 1])); }
    said(re, from = 0) { return this.msgs(from).some(x => re.test(x)); }
    async svs(from, pred = () => true, ms = 30000) { return JSON.parse((await this.waitFor('SVS', m => pred(JSON.parse(m[0])), from, ms)).m[0]); }
    still() { this.talk('C', 200, 0, 1, 0); }
    leave() { this.talk('LV'); setTimeout(() => { try { this.ws.close(); } catch (e) { /* */ } }, 150); }
    kill() { try { this.ws.terminate(); } catch (e) { /* */ } }
    close() { try { this.ws.close(); } catch (e) { /* */ } }
}

test('e2e: persistent bank, Save & leave, $restore (local server, ports 6190-6193)', async () => {
    if (process.env.SAVEBANK_E2E === '0') return 'skipped (SAVEBANK_E2E=0)';
    const port = 6190;
    const origin = 'http://localhost:' + port;
    fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
    // ROYALE_FAIR_PLAY=0: these test guests are brand new, so fair play would
    // protect them and a death would cost their savings nothing (bank.js)
    // ROYALE_SAVINGS_DEATH_LOSS=1: the savings tax is off by default since Oct 5 2026; this checks the old path
    const env = { ...process.env, ROYALE_DEBUG: '1', ACCOUNTS_ALLOW_DEBUG: '1', ROYALE_FAIR_PLAY: '0', ROYALE_SAVINGS_DEATH_LOSS: '1',
        SESSION_SECRET: SECRET, DATA_DIR: E2E_DATA_DIR, PUBLIC_ORIGIN: origin, PUBLIC_HOST: 'localhost:' + port,
        TRUSTED_PROXIES: '127.0.0.1', SINGLE_PROCESS: 'true', PORT: String(port), BR_PORT: String(port),
        TUT_PORT: String(port + 1), DUO_PORT: String(port + 2), DW_PORT: String(port + 3), BOT_CHAT_AI: 'false', NODE_ENV: 'development' };
    // blank, not unset: server/.env fills in whatever is missing, and a local
    // run must never post to Discord
    for (const k of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_APP_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN',
        'DISCORD_ADMIN_GUILD_ID', 'ADMIN_DISCORD_IDS', 'DISCORD_ANNOUNCE_CHANNEL_ID', 'DISCORD_BACKUP_CHANNEL_ID', 'BACKUP_ENCRYPTION_KEY', 'API_KEY']) env[k] = '';
    const logFile = path.join(ROOT, 'e2e-server.log');
    const out = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, ['index.js'], { cwd: REPO, env, stdio: ['ignore', out, out] });
    const clients = [];
    const open = (o) => { const c = new Client(port, o); clients.push(c); return c; };
    const { DatabaseSync } = require('node:sqlite');
    let db = null;
    const notes = [];
    try {
        for (let i = 0; i < 160; i++) {
            try { if ((await fetch(origin + '/api/config')).status === 200) break; } catch (e) { /* booting */ }
            await sleep(250);
        }
        let ready = false;
        for (let i = 0; i < 20 && !ready; i++) {
            const c = new Client(port, { name: 'Boot', token: 'tokBoot' + i + 'xxxxx' });
            for (let j = 0; j < 20 && !c.log.some(x => x.type === 'W'); j++) await sleep(100);
            ready = c.log.some(x => x.type === 'W');
            c.spawnedOnce = true;
            c.close();
            if (!ready) await sleep(500);
        }
        assert.ok(ready, 'game socket never welcomed a client');
        db = new DatabaseSync(path.join(E2E_DATA_DIR, 'digwars.db'));
        const q = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? { ...r } : r; };
        const tag = String(Math.floor(Math.random() * 900) + 100);

        // ---- the bank: kept across a disconnect, never score or growth ----
        const G = gid(0xbeef00 + Number(tag));
        const g1 = open({ name: 'Keeper' + tag, token: 'tokKeep1' + tag + 'aaaa', guestId: G });
        await g1.spawned();
        g1.talk('DBG', 'god');
        let b = await g1.bank();
        assert.equal(b.lease, true, 'a guest with an id has a lease');
        assert.equal(b.kept, 0);
        g1.talk('DBG', 'gems', 3000);
        await sleep(300);
        b = await g1.bank();
        assert.equal(b.banked, 3000);
        g1.leave();
        await sleep(800);
        assert.equal(q('SELECT bank_gems FROM guests WHERE guest_id = ?', G).bank_gems, 3000, 'written to the guest row on leaving');
        assert.equal(q('SELECT count(*) AS n FROM bank_leases WHERE owner = ?', 'g:' + G).n, 0);

        const g2 = open({ name: 'Keeper' + tag, token: 'tokKeep2' + tag + 'bbbb', guestId: G });
        await g2.spawned();
        g2.talk('DBG', 'god');
        b = await g2.bank();
        assert.equal(b.banked, 3000, 'back in the next session');
        assert.equal(b.kept, 3000, 'all of it brought in');
        assert.ok(g2.said(/You brought 3,000 gems/), 'told at spawn');
        const gem = g2.log.filter(e => e.type === 'GEM').pop().m;
        assert.equal(gem[3], 3000);
        assert.equal(gem[6], 3000, 'GEM carries the kept part for the HUD');
        assert.equal(b.stat.banked, 0, 'the board counts none of it');
        assert.ok(b.stat.score < 100, 'score: starter satchel only, ' + b.stat.score);
        // growth = board points + half the satchel (scoreOf/progressOf), never the bank
        assert.equal(b.growth.score, b.stat.score + Math.floor((b.stat.carried | 0) / 2), 'growth runs on the board score and the satchel, not the bank');
        assert.ok(b.growth.score < 100, 'the 3,000 brought in does not grow you, ' + b.growth.score);
        assert.equal(q('SELECT bank_gems FROM guests WHERE guest_id = ?', G).bank_gems, 0, 'nothing at rest while it is out');

        // ---- two tabs of the same guest at once ----
        const g3 = open({ name: 'KeeperTwo' + tag, token: 'tokKeep3' + tag + 'cccc', guestId: G });
        await g3.spawned();
        g3.talk('DBG', 'god');
        b = await g3.bank();
        assert.equal(b.banked, 0, 'the second tab gets nothing: the first one holds it');
        g3.talk('DBG', 'gems', 700);        // earned 700 in that tab
        g2.talk('DBG', 'gems', 2000);       // spent 1,000 in this one
        await sleep(300);
        g3.leave();
        await sleep(600);
        assert.equal(q('SELECT bank_gems FROM guests WHERE guest_id = ?', G).bank_gems, 700);

        // ---- dying costs 10% ----
        let i0 = g2.mark();
        g2.talk('DBG', 'god');              // off
        await g2.die(i0);
        await g2.waitFor('m', m => /Dying cost you 200 gems from your savings/.test(String(m[m.length - 1])), i0, 5000);
        b = await g2.bank();
        assert.equal(b.banked, 1800, '10% of 2,000 gone');
        assert.equal(b.kept, 1800, 'the loss comes out of the kept part once this raid has none');
        await sleep(3300);
        g2.talk('s', g2.name, 0, 0, false, 0);
        await g2.waitFor('c', () => true, i0, 10000);
        await sleep(500);
        g2.talk('DBG', 'god');
        b = await g2.bank();
        assert.equal(b.banked, 1800, 'a respawn does not bring the bank in again');

        // ---- the 45 s resume: the same gems, not twice ----
        g2.kill();
        await sleep(1500);
        assert.equal(q('SELECT count(*) AS n FROM bank_leases WHERE owner = ?', 'g:' + G).n, 1, 'the snapshot holds the lease');
        const g2r = open({ name: 'Keeper' + tag, token: g2.token, guestId: G });
        await g2r.waitFor('m', m => /Reconnected/.test(String(m[m.length - 1])), 0, 15000);
        b = await g2r.bank();
        assert.equal(b.banked, 1800, 'resumed with the same bank');
        assert.equal(b.kept, 1800);
        assert.equal(q('SELECT count(*) AS n FROM bank_leases WHERE owner = ?', 'g:' + G).n, 1, 'still one lease');
        assert.equal(q('SELECT bank_gems FROM guests WHERE guest_id = ?', G).bank_gems, 700, 'the other tab\'s gems wait at rest');
        g2r.talk('DBG', 'god');

        // ---- a new raid: the bank stays, all of it kept, none of it score ----
        const raid0 = b.raidId;
        g2r.talk('DBG', 'gems', 2500);      // banked 700 this raid on top of the 1,800 kept
        await sleep(300);
        b = await g2r.bank();
        assert.equal(b.kept, 1800);
        g2r.talk('DBG', 'raidend');
        await g2r.waitFor('KC', m => m[0] === 'raidend', 0, 10000);
        i0 = g2r.mark();
        // everyone goes down 1.6 s after, the next raid starts 15 s later
        await g2r.waitFor('F', () => true, i0, 10000);
        await sleep(16000);
        g2r.talk('s', g2r.name, 0, 0, false, 0);
        await g2r.waitFor('c', () => true, i0, 15000);
        await sleep(600);
        b = await g2r.bank();
        assert.equal(b.raidId, raid0 + 1, 'a new raid');
        assert.equal(b.banked, 2500, 'the raid end cost nothing, and the bank carried over');
        assert.equal(b.kept, 2500, 'all of it counts as brought in now');
        assert.equal(b.stat.banked, 0);
        g2r.leave();
        await sleep(800);
        assert.equal(q('SELECT bank_gems FROM guests WHERE guest_id = ?', G).bank_gems, 3200, '2,500 + the other tab\'s 700');
        notes.push('bank ok');

        // ---- Save & leave ----
        const signup = async (username) => {
            const r = await fetch(origin + '/api/auth/signup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password: 'correct-horse-9' }) });
            assert.equal(r.status, 201, 'signup ' + username);
            return r.headers.get('set-cookie').split(';')[0];
        };
        const uname = 'Saver' + tag;
        const cookie = await signup(uname);
        const uid = q('SELECT id FROM users WHERE username = ?', uname).id;
        const S = open({ cookie, name: uname, token: 'tokSaver' + tag + 'ssss' });
        await S.waitFor('AC');
        await S.spawned();
        S.talk('DBG', 'god');
        S.talk('DBG', 'carry', 500);
        await sleep(200);
        await S.dbg('score', 1600);
        await S.dbg('addgrowth', 6000);
        S.talk('DBG', 'gems', 900);
        await sleep(2500);                  // growth eases up to its target
        const pre = await S.bank();
        const preMe = await S.dbg('me');
        assert.ok(pre.growth.target > 2.05, 'grown past the 2x respawn cap: ' + pre.growth.target);
        const lifeId = q('SELECT life_id FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', uid).life_id;
        assert.ok(lifeId, 'an open ranked life');

        // moving stops it
        i0 = S.mark();
        S.still();
        S.talk('SV', 1);
        let st = await S.svs(i0);
        assert.deepEqual([st.st, st.ms], ['on', 20000], 'a 20 s hold');
        await sleep(1200);
        S.talk('C', 200, 0, 1, 1);          // W
        st = await S.svs(i0, x => x.st === 'off', 3000);
        assert.match(st.why, /You moved/);
        S.talk('C', 200, 0, 1, 0);
        // so does shooting
        await sleep(1100);
        i0 = S.mark();
        S.talk('SV', 1);
        await S.svs(i0);
        S.talk('C', 200, 0, 1, 16);         // lmb
        st = await S.svs(i0, x => x.st === 'off', 3000);
        assert.match(st.why, /You fired/);
        S.talk('C', 200, 0, 1, 0);
        // and getting hurt
        await sleep(1100);
        i0 = S.mark();
        S.talk('SV', 1);
        await S.svs(i0);
        await sleep(500);
        S.talk('DBG', 'hurt', 30);
        st = await S.svs(i0, x => x.st === 'off', 3000);
        assert.match(st.why, /took damage/);
        // not while moving to begin with
        await sleep(1100);
        i0 = S.mark();
        S.talk('C', 200, 0, 1, 4);          // A held
        await sleep(150);
        S.talk('SV', 1);
        st = await S.svs(i0, x => x.st === 'off', 3000);
        assert.match(st.why, /Stop moving/);
        S.talk('C', 200, 0, 1, 0);
        // nor in the storm
        await sleep(1100);
        S.talk('DBG', 'stormedge', 300);
        await sleep(300);
        i0 = S.mark();
        S.talk('SV', 1);
        st = await S.svs(i0, x => x.st === 'off', 3000);
        assert.match(st.why, /storm/);
        S.talk('DBG', 'stormedge', -900);
        await sleep(300);
        // a still one goes the full 20 s
        await sleep(1100);
        const carriedAtSave = (await S.dbg('me')).carried;
        i0 = S.mark();
        const tSave = Date.now();
        S.talk('SV', 1);
        await S.svs(i0);
        const done = await S.svs(i0, x => x.st !== 'on', 30000);
        const held = Date.now() - tSave;
        assert.equal(done.st, 'done', JSON.stringify(done));
        assert.ok(held >= 19800 && held <= 22500, 'held ' + held + ' ms');
        assert.match(done.code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
        assert.equal(done.mode, 'solo');
        for (let i = 0; i < 40 && !S.closed; i++) await sleep(100);
        assert.equal(S.closeCode, 4003, 'sent to the menu');
        const watcher = open({ name: 'Watch' + tag, token: 'tokWatch' + tag + 'wwww', guestId: gid(0xcafe00 + Number(tag)) });
        await watcher.spawned();
        watcher.talk('DBG', 'god');
        assert.ok(!(await watcher.dbg('humans')).humans.includes(uname), 'the saved tank is out of the world');
        const saveRow = q('SELECT user_id, mode, data, used_at FROM saves ORDER BY id DESC LIMIT 1');
        const data = JSON.parse(saveRow.data);
        assert.equal(saveRow.user_id, uid);
        assert.equal(saveRow.mode, 'solo');
        assert.equal(saveRow.used_at, null);
        assert.ok(data.carried >= carriedAtSave && data.carried >= 500, 'the satchel is in the code: ' + data.carried);
        assert.ok(data.score >= 1600, 'the score at the save: ' + data.score);
        assert.equal(data.pts, data.score, 'raid points (the satchel is not points)');
        assert.ok(data.growEff >= 7000, 'growth score saved: ' + data.growEff);
        assert.ok(Array.isArray(data.defs) && data.defs.length, 'the class');
        assert.equal(data.skillRaw.length, 11);
        assert.equal(q('SELECT bank_gems FROM users WHERE id = ?', uid).bank_gems, 900, 'the bank went home, not into the code');
        const life = q('SELECT end_reason FROM rank_lives WHERE life_id = ?', lifeId);
        assert.equal(life.end_reason, 'disconnect', 'settled as a normal leave');
        assert.ok(q("SELECT count(*) AS n FROM audit_log WHERE action = 'save_create' AND user_id = ?", uid).n === 1);
        assert.ok(/saved and left/.test(fs.readFileSync(logFile, 'utf8')));
        notes.push('saved after ' + (held / 1000).toFixed(1) + ' s');

        // ---- $restore: back, but none of it for rank ----
        const S2 = open({ cookie, name: uname, token: 'tokSaver' + tag + 'ssss' });
        await S2.waitFor('AC');
        await S2.spawned();
        assert.equal(S2.said(/Reconnected/), false, 'a save is not a resume');
        S2.talk('DBG', 'god');
        let b2 = await S2.bank();
        assert.equal(b2.banked, 900, 'the bank is back by itself');
        const pts0 = (await S2.dbg('rankpts')).rankpts;
        const basis0 = pts0.lifeBasis;
        i0 = S2.mark();
        S2.talk('M', '$restore ' + done.code.toLowerCase(), 0);
        await S2.waitFor('m', m => /Save restored/.test(String(m[m.length - 1])), i0, 5000);
        await sleep(2500);
        b2 = await S2.bank();
        const me2 = await S2.dbg('me');
        assert.equal(b2.stat.restoredPts, data.pts);
        assert.equal(b2.stat.score >= data.pts, true, 'the board shows the points: ' + b2.stat.score);
        assert.ok(b2.stat.earned < 200, 'placement leaves them out: earned ' + b2.stat.earned);
        assert.ok(me2.carried >= data.carried, 'the satchel is back');
        assert.equal(b2.banked, 900, 'the bank was not in the code (no copy of it)');
        assert.ok(Math.abs(b2.growth.target - pre.growth.target) < 0.08, 'growth back to the saved size: ' + b2.growth.target + ' vs ' + pre.growth.target);
        assert.ok(b2.growth.target > 2.05, 'past the respawn cap');
        const pts1 = (await S2.dbg('rankpts')).rankpts;
        assert.equal(pts1.lifeBasis, basis0, 'no rank points for the restored ones');
        // points earned after the restore do count
        await S2.dbg('score', b2.stat.score + 300);
        const pts2 = (await S2.dbg('rankpts')).rankpts;
        assert.equal(pts2.lifeBasis - basis0, 300, 'only what was earned after');
        const lifeR = q('SELECT life_id FROM rank_lives WHERE user_id = ? AND ended_at IS NULL', uid).life_id;
        // the chat never saw the code
        assert.ok(!watcher.log.some(e => e.type === 'CH' && e.m.some(v => String(v).includes(done.code))), 'not shown as chat');
        assert.ok(!fs.readFileSync(logFile, 'utf8').includes(done.code), 'not in the server log');
        assert.equal(q('SELECT used_user_id FROM saves ORDER BY id DESC LIMIT 1').used_user_id, uid);

        // single use
        i0 = S2.mark();
        S2.talk('M', '$restore ' + done.code, 0);
        await S2.waitFor('m', m => /already used/.test(String(m[m.length - 1])), i0, 5000);

        // another save (a guest this time), for the gap and the expiry
        const G2 = gid(0xdead00 + Number(tag));
        const W = open({ name: 'Second' + tag, token: 'tokSecond' + tag + 'kkk', guestId: G2 });
        await W.spawned();
        W.talk('DBG', 'god');
        W.still();
        await sleep(500);
        i0 = W.mark();
        W.talk('SV', 1);
        const done2 = await W.svs(i0, x => x.st !== 'on', 30000);
        assert.equal(done2.st, 'done');
        // the same account (and this IP) restored one a moment ago
        i0 = S2.mark();
        S2.talk('M', '$restore ' + done2.code, 0);
        await S2.waitFor('m', m => /restored a save not long ago/.test(String(m[m.length - 1])), i0, 5000);
        assert.equal(q('SELECT used_at FROM saves ORDER BY id DESC LIMIT 1').used_at, null, 'the gap does not use it up');
        // run it out: an expired code says so
        db.prepare('UPDATE saves SET expires_at = ? WHERE used_at IS NULL').run(Date.now() - 1000);
        i0 = S2.mark();
        S2.talk('M', '$restore ' + done2.code, 0);
        await S2.waitFor('m', m => /ran out/.test(String(m[m.length - 1])), i0, 5000);
        i0 = S2.mark();
        S2.talk('M', '$restore nope', 0);
        await S2.waitFor('m', m => /doesn't look like a save code/.test(String(m[m.length - 1])), i0, 5000);

        // the restored life settles on what it earned after the restore
        i0 = S2.mark();
        S2.talk('DBG', 'god');
        await S2.die(i0);
        await sleep(500);
        const settled = q('SELECT end_reason, basis FROM rank_lives WHERE life_id = ?', lifeR);
        assert.equal(settled.end_reason, 'death');
        assert.ok(settled.basis >= 300 && settled.basis < 450, 'the life ranks on ~300 earned points, not ' + data.pts + ': ' + settled.basis);
        notes.push('restored life basis ' + settled.basis + ' (restored ' + data.pts + ')');
        return notes.join(', ');
    } finally {
        for (const c of clients) c.close();
        if (db) try { db.close(); } catch (e) { /* */ }
        child.kill('SIGINT');
        await new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', res); setTimeout(res, 6000); });
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.closeSync(out);
    }
});

(async () => {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...args) => { if (!String(args[0]).startsWith('[accounts]')) quietLog(...args); };
    console.warn = (...args) => { if (!String(args[0]).startsWith('[accounts]')) quietWarn(...args); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        const s = Date.now();
        try {
            const note = await t.fn();
            quietLog(`ok   ${t.name} (${Date.now() - s} ms)${note ? ' - ' + note : ''}`);
        } catch (e) {
            failed++;
            quietLog(`FAIL ${t.name}\n     ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n     ')}`);
        }
    }
    try { accounts.shutdown(); } catch (e) { /* */ }
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
})();
