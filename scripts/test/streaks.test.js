// Play / win streak tests: node scripts/test/streaks.test.js
//
//   rules      streaks.js pure rules: day rollover, missed day, flat from
//              day 7; win increments, reset, not-played raids, daily cap
//   migration  v4 -> v5 keeps every dust_ledger row (a copy of the local
//              data/digwars.db when there is one, plus a synthetic v4 file)
//              and adds user_streaks and the streak ledger kinds
//   hooks      rankHooks on a fake raid: the day's first counted life pays
//              (DU kind 8, STK, the 'streak' bus message), short and voided
//              lives don't; raid wins, a loss, AFK and voided raids, a duo
//              team win for both partners (not an AFK partner)
//   once       a life, a day and a raid pay once, across a "restart" too
//   guests     never get a row, a packet or dust
//   views      /api/quests streaks view, the Discord /profile fields
//
// Data goes under $DATA_DIR if set, otherwise the OS temp dir; it is removed
// when everything passes. The local data/digwars.db is only ever copied,
// never opened.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `streaks-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-streaks-test-'));
fs.mkdirSync(ROOT, { recursive: true });
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ROYALE_DEBUG', 'ACCOUNTS_ALLOW_DEBUG', 'DISCORD_BOT_TOKEN']) delete process.env[k];
Object.assign(process.env, {
    NODE_ENV: 'test',
    ACCOUNTS_ENABLED: 'true',
    SESSION_SECRET: 'streaks-test-secret-0123456789-abcdefghijklmnop',
});

const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const migrations = require('../../server/accounts/migrations');
const streaks = require('../../server/accounts/streaks');
const rankStore = require('../../server/accounts/rankStore');
const commands = require('../../server/accounts/discord/commands');

const MIN = 60 * 1000;
const DAY = streaks.DAY;
const D = () => accounts.db.handle();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let seq = 0;
function mkUser(prefix = 'st') {
    const r = accounts.users.create({ username: (prefix + '_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const row = id => D().get('SELECT * FROM user_streaks WHERE user_id = ?', id);
const balance = id => D().get('SELECT dust_milli FROM users WHERE id = ?', id).dust_milli;
const ledger = (id, kind) => D().all('SELECT delta_milli, ref FROM dust_ledger WHERE user_id = ? AND kind = ? ORDER BY id', id, kind);

// ===================================================================
// Rules
// ===================================================================

test('rules: play streak rolls over by UTC day, a missed day starts over, flat from day 7', () => {
    const d0 = 20000;
    let st = { cur: 0, best: 0, day: 0 };
    const pays = [];
    for (let i = 0; i < 10; i++) {
        const n = streaks.nextPlay(st, d0 + i);
        assert.equal(n.changed, true);
        assert.equal(n.cur, i + 1);
        pays.push(n.pay);
        st = n;
        // the same day again: nothing
        const again = streaks.nextPlay(st, d0 + i);
        assert.deepEqual([again.changed, again.pay, again.cur], [false, 0, i + 1]);
    }
    assert.deepEqual(pays, [250, 500, 750, 1000, 1250, 1500, 2000, 2000, 2000, 2000]);
    // skip a day: back to 1, best kept
    const broke = streaks.nextPlay(st, d0 + 11);
    assert.deepEqual([broke.cur, broke.best, broke.pay], [1, 10, 250]);
    // a clock that went backwards never pays
    assert.equal(streaks.nextPlay({ cur: 3, best: 3, day: d0 }, d0 - 1).changed, false);
    // UTC: 23:59:59 and 00:00:00 are different days
    const mid = DAY * 20001;
    assert.equal(streaks.dayOf(mid - 1) + 1, streaks.dayOf(mid));
});

test('rules: win streak grows on played wins, a played loss resets, unplayed raids change nothing, daily cap', () => {
    const day = 20000;
    let st = { cur: 0, best: 0, raid: null, day: 0, dayMilli: 0 };
    const pays = [];
    for (let i = 1; i <= 7; i++) {
        const n = streaks.nextWin(st, { raidKey: 'r' + i, day, win: true, played: true });
        assert.equal(n.cur, i);
        pays.push(n.pay);
        st = n;
    }
    // 250 + 500 + 750 + 1000 + 1250 = 3750, then 1250 more hits the 5000 cap at 1250, then 0
    assert.deepEqual(pays, [250, 500, 750, 1000, 1250, 1250, 0]);
    assert.equal(st.dayMilli, streaks.WIN_DAY_CAP_MILLI);
    // the same raid twice: nothing
    assert.equal(streaks.nextWin(st, { raidKey: 'r7', day, win: true, played: true }).changed, false);
    // a raid not really played (AFK, voided, late join): nothing, win or not
    assert.equal(streaks.nextWin(st, { raidKey: 'r8', day, win: false, played: false }).changed, false);
    assert.equal(streaks.nextWin(st, { raidKey: 'r8', day, win: true, played: false }).changed, false);
    // a new UTC day pays again
    const next = streaks.nextWin(st, { raidKey: 'r9', day: day + 1, win: true, played: true });
    assert.deepEqual([next.cur, next.pay, next.dayMilli], [8, 1250, 1250]);
    // a played loss resets, best stays
    const lost = streaks.nextWin(next, { raidKey: 'r10', day: day + 1, win: false, played: true });
    assert.deepEqual([lost.cur, lost.best, lost.pay, lost.reset], [0, 8, 0, true]);
    // losing again with nothing to lose is not a "reset"
    assert.equal(streaks.nextWin(lost, { raidKey: 'r11', day: day + 1, win: false, played: true }).reset, false);
});

// ===================================================================
// Migration
// ===================================================================

function seedLedger(db, n) {
    const kinds = ['gems', 'kill', 'placement', 'quest', 'purchase', 'refund', 'gift', 'admin', 'referral', 'other'];
    const u = db.get('SELECT id FROM users ORDER BY id LIMIT 1');
    let uid = u && u.id;
    if (!uid) {
        db.run(`INSERT INTO users (public_id, username, username_lc, created_at) VALUES ('DW-ZZZZZZZZ', 'Seed', 'seed', 1)`);
        uid = db.get('SELECT id FROM users WHERE username_lc = ?', 'seed').id;
    }
    for (let i = 1; i <= n; i++) {
        db.run('INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            uid, 100 + i, 1000 * i, kinds[i % kinds.length], 'seed:' + i, i);
    }
    return uid;
}

function checkMigrated(db, before) {
    assert.equal(db.userVersion(), migrations.latestVersion());
    assert.deepEqual(db.all('SELECT * FROM dust_ledger ORDER BY id'), before, 'every ledger row, same ids');
    const uid = before[0].user_id;
    db.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (?, 1, 1, 'streak_play', 1)", uid);
    db.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (?, 1, 1, 'streak_win', 1)", uid);
    assert.throws(() => db.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (?, 1, 1, 'bogus', 1)", uid), /CHECK/);
    assert.ok(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'dust_ledger_user'"));
    assert.ok(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'user_streaks'"));
    assert.equal(db.get('PRAGMA foreign_key_check'), null);
    assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
}

test('migration: v4 -> v5 on a synthetic v4 file keeps the ledger, adds streaks; backup first', () => {
    const file = path.join(ROOT, 'mig', 'v4.db');
    const db = dbmod.open({ path: file, migrate: false });
    db.tx(() => {
        for (const m of migrations.MIGRATIONS.filter(x => x.version <= 4)) m.up(db);
        db.exec('PRAGMA user_version = 4');
    });
    const uid = seedLedger(db, 60);
    assert.throws(() => db.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (?, 1, 1, 'streak_play', 1)", uid), /CHECK/);
    const before = db.all('SELECT * FROM dust_ledger ORDER BY id');
    const res = migrations.apply(db, { backupDir: path.join(ROOT, 'mig', 'backups') });
    assert.deepEqual(res.applied, migrations.MIGRATIONS.filter(x => x.version >= 5).map(x => x.version));
    assert.ok(res.backup && fs.existsSync(res.backup), 'pre-migration backup');
    // the backup is the v4 file, untouched
    const bk = dbmod.open({ path: res.backup, migrate: false });
    assert.equal(bk.userVersion(), 4);
    assert.equal(bk.get('SELECT count(*) AS n FROM dust_ledger').n, 60);
    bk.close();
    checkMigrated(db, before);
    // the streak row cascades with its user like the ledger does
    db.run('INSERT INTO user_streaks (user_id, updated_at) VALUES (?, 1)', uid);
    db.run('DELETE FROM users WHERE id = ?', uid);
    assert.equal(db.get('SELECT count(*) AS n FROM dust_ledger').n, 0);
    assert.equal(db.get('SELECT count(*) AS n FROM user_streaks').n, 0);
    db.close();
});

test('migration: a copy of the local data/digwars.db (with ledger rows added) migrates to v5', () => {
    const src = path.join(REPO, 'data', 'digwars.db');
    if (!fs.existsSync(src)) return 'skipped: no local data/digwars.db';
    const dir = path.join(ROOT, 'prodcopy');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'digwars.db');
    // plain file copies (with the WAL): the original is never opened
    fs.copyFileSync(src, file);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, file + ext);
    const db = dbmod.open({ path: file, migrate: false });
    const from = db.userVersion();
    if (from !== 4) { db.close(); return 'skipped: local copy is at v' + from; }
    const had = db.get('SELECT count(*) AS n FROM dust_ledger').n;
    seedLedger(db, 40);
    const before = db.all('SELECT * FROM dust_ledger ORDER BY id');
    const counts = {};
    for (const t of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
        counts[t.name] = db.get(`SELECT count(*) AS n FROM "${t.name}"`).n;
    }
    const res = migrations.apply(db, { backupDir: path.join(dir, 'backups') });
    assert.deepEqual(res.applied, migrations.MIGRATIONS.filter(x => x.version >= 5).map(x => x.version));
    assert.ok(res.backup && fs.existsSync(res.backup));
    checkMigrated(db, before);
    for (const [name, n] of Object.entries(counts)) {
        if (name === 'dust_ledger') continue;
        assert.equal(db.get(`SELECT count(*) AS n FROM "${name}"`).n, n, name + ' rows kept');
    }
    db.close();
    return `${had} existing + 40 seeded ledger rows, ${Object.keys(counts).length} tables`;
});

// ===================================================================
// Hooks harness (rankHooks on a fake raid, like ranked.test.js)
// ===================================================================

let rankHooks = null, bridge = null;
const H = { stats: new Map(), clients: [], raidId: 100, order: null };
const bus = [];
let sockSeq = 0;
function mkSocket(user) {
    const s = { id: 'sock' + (++sockSeq), account: user ? { id: user.id, publicId: user.public_id, username: user.username } : null, packets: [], terminated: false, player: { body: null } };
    s.talk = (type, ...args) => s.packets.push([type, ...args]);
    return s;
}
function mkBody(socket, extra = {}) {
    const b = { id: 1000 + (++sockSeq), socket, rankCode: 0, dustCarried: 0, carriedGems: 0, isDead: () => false, ...extra };
    if (socket) socket.player.body = b;
    return b;
}
function mkStat(key) {
    const s = { key, banked: 0, kills: 0, killPts: 0, extra: 0, revengeBonus: 0, carried: 0, alive: true };
    H.stats.set(key, s);
    return s;
}
const packets = (sock, type) => sock.packets.filter(p => p[0] === type);
const stk = sock => packets(sock, 'STK').map(p => JSON.parse(p[1]));
const du8 = sock => packets(sock, 'DU').filter(p => p[4] === 8).map(p => p[3]);
function reset() { H.clients.length = 0; H.stats.clear(); H.order = null; bus.length = 0; }

// A player in the harness: socket, body, stat.
function player(user) {
    const sock = mkSocket(user);
    H.clients.push(sock);
    const body = mkBody(sock);
    const s = mkStat('s:' + sock.id);
    return { user, sock, body, s };
}
// A life that ran `ms` (and `activeMs` of active survival), then died.
function liveAndDie(p, ms, opts = {}) {
    rankHooks.lifeStart(p.body, p.s);
    p.s.lifeStartAt -= ms;
    p.s.lifeSurviveMs = opts.activeMs || 0;
    if (opts.banked) p.s.banked += opts.banked;
    rankHooks.onDeath(p.body, p.s);
    return p.sock._rkPending;
}
function setPlayDay(userId, day, cur) {
    D().run('UPDATE user_streaks SET play_day = ?, play_cur = ? WHERE user_id = ?', day, cur, userId);
}

test('hooks: harness attaches', () => {
    global.Config = { dig_royale: true };
    rankHooks = require('../../server/accounts/game/rankHooks');
    bridge = require('../../server/accounts/game/bridge');
    rankHooks.attach({
        stats: () => H.stats, clients: () => H.clients, raidId: () => H.raidId,
        board: () => H.order || [...H.stats.values()].map(s => ({ s, score: (s.banked | 0) + (s.killPts | 0) })).sort((a, b) => b.score - a.score),
        resumeMs: 300, serverId: 'harness',
    });
    accounts.bus.onMain((sid, msg) => { if (msg && msg.t === 'streak') bus.push(msg); });
    assert.equal(bridge.rankedOn(), true);
});

test('hooks: the day\'s first counted life pays the play streak once (DU 8, STK, bus); short lives do not count', () => {
    const p = player(mkUser());
    rankHooks.onRaidStart();
    // 20 s with nothing scored: not a counted life
    liveAndDie(p, 20000);
    assert.ok(!row(p.user.id));
    assert.equal(stk(p.sock).length, 0);
    // 20 s but it scored: counts (the placement rule)
    const rk = liveAndDie(p, 20000, { banked: 50 });
    assert.equal(rk.streak.streak, 1);
    assert.equal(rk.streak.rewardMilli, 250);
    assert.equal(rk.dust.balanceMilli, balance(p.user.id), 'RK balance includes the streak dust');
    assert.equal(balance(p.user.id), 250);
    assert.deepEqual(ledger(p.user.id, 'streak_play').map(r => r.delta_milli), [250]);
    assert.deepEqual(du8(p.sock), [250]);
    const card = stk(p.sock);
    assert.equal(card.length, 1);
    assert.deepEqual([card[0].kind, card[0].streak, card[0].rewardMilli, card[0].nextMilli], ['play', 1, 250, 500]);
    assert.deepEqual(bus.map(m => [m.t, m.userId, m.kind, m.streak]), [['streak', p.user.id, 'play', 1]]);
    // more lives the same day: nothing more
    liveAndDie(p, 3 * MIN);
    liveAndDie(p, 3 * MIN);
    assert.equal(ledger(p.user.id, 'streak_play').length, 1);
    assert.equal(stk(p.sock).length, 1);
    assert.equal(balance(p.user.id), 250);
    reset();
});

test('hooks: day rollover grows it, a missed day resets it to 1', () => {
    const p = player(mkUser());
    const today = streaks.dayOf(Date.now());
    rankHooks.onRaidStart();
    liveAndDie(p, 2 * MIN);
    // pretend that was yesterday, on day 4
    setPlayDay(p.user.id, today - 1, 4);
    let rk = liveAndDie(p, 2 * MIN);
    assert.deepEqual([rk.streak.streak, rk.streak.rewardMilli], [5, 1250]);
    assert.equal(row(p.user.id).play_best, 5);
    // day 7 and beyond pay the flat top reward
    setPlayDay(p.user.id, today - 1, 9);
    rk = liveAndDie(p, 2 * MIN);
    assert.deepEqual([rk.streak.streak, rk.streak.rewardMilli], [10, 2000]);
    // two days missed: back to day 1, best kept
    setPlayDay(p.user.id, today - 3, 10);
    rk = liveAndDie(p, 2 * MIN);
    assert.deepEqual([rk.streak.streak, rk.streak.rewardMilli, rk.streak.best], [1, 250, 10]);
    const v = streaks.view(p.user.id);
    assert.deepEqual([v.play.current, v.play.best, v.play.today, v.play.rewardMilli, v.play.nextMilli], [1, 10, true, 250, 500]);
    // the view shows a streak last played yesterday as alive, older ones as 0
    setPlayDay(p.user.id, today - 1, 6);
    assert.deepEqual([streaks.view(p.user.id).play.current, streaks.view(p.user.id).play.today], [6, false]);
    setPlayDay(p.user.id, today - 2, 6);
    assert.equal(streaks.view(p.user.id).play.current, 0);
    assert.equal(streaks.view(p.user.id).play.nextMilli, 250);
    reset();
});

test('hooks: a voided leave (first minute, nothing scored) never counts', () => {
    const p = player(mkUser());
    rankHooks.onRaidStart();
    rankHooks.lifeStart(p.body, p.s);
    p.s.lifeStartAt -= 30000;
    rankHooks.onDisconnect(p.sock, p.s, true);
    assert.equal(p.s.lifeOpen, false);
    assert.equal(D().get('SELECT count(*) AS n FROM rank_lives WHERE user_id = ?', p.user.id).n, 0, 'voided');
    assert.ok(!row(p.user.id));
    assert.equal(ledger(p.user.id, 'streak_play').length, 0);
    reset();
});

// One raid: every player's life settles at raid end. spec: [{p, banked, activeMs, lifeMs, joinedAgoMs}]
function raid(spec, order) {
    H.raidId++;
    H.stats.clear();
    for (const e of spec) H.stats.set(e.p.s.key, e.p.s);
    rankHooks.onRaidStart();
    for (const e of spec) {
        e.p.s.banked = 0; e.p.s.killPts = 0;
        rankHooks.lifeStart(e.p.body, e.p.s);
        e.p.s.lifeStartAt -= e.lifeMs != null ? e.lifeMs : 6 * MIN;
        e.p.s.lifeSurviveMs = e.activeMs != null ? e.activeMs : 3 * MIN;
        e.p.s.banked = e.banked | 0;
        const a = rankHooks._raidAcct.get(e.p.user.id);
        if (a) a.joinedAt -= e.joinedAgoMs != null ? e.joinedAgoMs : 6 * MIN;
        e.p.sock.packets.length = 0;
    }
    H.order = order ? order() : null;
    rankHooks.onRaidEnd();
    H.order = null;
    return rankHooks.raidKey();
}
const winOf = id => { const r = row(id); return r ? [r.win_cur, r.win_best] : [0, 0]; };

test('hooks: raid wins grow the win streak and pay; a played loss resets; AFK, late and voided raids change nothing', () => {
    const a = player(mkUser()), b = player(mkUser());
    const bot = { s: mkStat('b:1') };
    const botS = bot.s;
    const withBot = (spec, botBanked) => () => {
        const list = spec.map(e => e.p.s).concat(botBanked != null ? [botS] : []);
        botS.banked = botBanked | 0;
        return list.map(s => ({ s, score: (s.banked | 0) })).sort((x, y) => y.score - x.score);
    };
    // raid 1: a wins (bots count for places, as in the placement bonus)
    let spec = [{ p: a, banked: 900 }, { p: b, banked: 300 }];
    raid(spec, withBot(spec, 100));
    assert.deepEqual(winOf(a.user.id), [1, 1]);
    assert.equal(ledger(a.user.id, 'streak_win').length, 1);
    // the raid-end life is also the day's first: a play card, then the win card
    assert.deepEqual(stk(a.sock).map(c => [c.kind, c.streak, c.rewardMilli]), [['play', 1, 250], ['win', 1, 250]]);
    assert.deepEqual(du8(a.sock), [250, 250]);
    // b played and lost with no streak: nothing to reset, but the raid is booked
    assert.deepEqual(winOf(b.user.id), [0, 0]);
    // raid 2: a wins again
    const k2 = raid(spec, withBot(spec, 100));
    assert.deepEqual(winOf(a.user.id), [2, 2]);
    assert.equal(row(a.user.id).win_raid, k2);
    assert.deepEqual(stk(a.sock).map(c => [c.streak, c.rewardMilli, c.nextMilli]), [[2, 500, 750]]);
    // raid 3: a was AFK the whole raid (no active time): no reset, no win
    spec = [{ p: a, banked: 900, activeMs: 0 }, { p: b, banked: 1000 }];
    raid(spec, withBot(spec, 100));
    assert.deepEqual(winOf(a.user.id), [2, 2], 'AFK raid leaves it alone');
    // raid 4: a joined 3 minutes before the end: not played
    spec = [{ p: a, banked: 10, joinedAgoMs: 3 * MIN, lifeMs: 3 * MIN }, { p: b, banked: 1000 }];
    raid(spec, withBot(spec, 100));
    assert.deepEqual(winOf(a.user.id), [2, 2], 'late join leaves it alone');
    // raid 5: a bot takes #1 and a really played: reset (best stays), no card, the menu hears it
    bus.length = 0;
    spec = [{ p: a, banked: 900 }, { p: b, banked: 300 }];
    raid(spec, withBot(spec, 5000));
    assert.deepEqual(winOf(a.user.id), [0, 2]);
    assert.equal(stk(a.sock).filter(c => c.kind === 'win').length, 0, 'no in-raid card for a reset');
    assert.ok(bus.some(m => m.userId === a.user.id && m.kind === 'win' && m.reset === true));
    // raid 6: a voided life only (left in the first minute, nothing scored) is not "played"
    H.raidId++;
    H.stats.clear(); H.stats.set(a.s.key, a.s); H.stats.set(b.s.key, b.s);
    rankHooks.onRaidStart();
    D().run('UPDATE user_streaks SET win_cur = 3, win_best = 3 WHERE user_id = ?', a.user.id);
    rankHooks.lifeStart(a.body, a.s);
    rankHooks.lifeStart(b.body, b.s);
    a.s.banked = 0; b.s.banked = 500; b.s.lifeStartAt -= 6 * MIN; b.s.lifeSurviveMs = 3 * MIN;
    rankHooks._raidAcct.get(a.user.id).joinedAt -= 6 * MIN;
    rankHooks._raidAcct.get(b.user.id).joinedAt -= 6 * MIN;
    rankHooks.onDisconnect(a.sock, a.s, true);
    rankHooks.onRaidEnd();
    assert.deepEqual(winOf(a.user.id), [3, 3], 'voided life: no reset');
    H.stats.delete('b:1');
    reset();
});

test('hooks: duos, the winning team counts for both partners; an AFK partner gets nothing and keeps theirs', () => {
    global.Config.royale_duos = true;
    try {
        const a = player(mkUser()), b = player(mkUser()), c = player(mkUser()), d = player(mkUser());
        const teams = (spec, first) => () => {
            // boardOrder's duo shape: both partners carry the team's place
            const ts = spec.map(e => e.p.s);
            const win = first === 'ab' ? [ts[0], ts[1]] : [ts[2], ts[3]];
            const lose = first === 'ab' ? [ts[2], ts[3]] : [ts[0], ts[1]];
            const out = [];
            for (const s of win) out.push({ s, score: s.banked | 0, place: 1, rows: 3, teamScore: 2000 });
            for (const s of lose) out.push({ s, score: s.banked | 0, place: 2, rows: 3, teamScore: 500 });
            return out;
        };
        D().run('INSERT INTO user_streaks (user_id, win_cur, win_best, updated_at) VALUES (?, 2, 2, 1)', d.user.id);
        const spec = [{ p: a, banked: 1500 }, { p: b, banked: 500 }, { p: c, banked: 300 }, { p: d, banked: 200 }];
        raid(spec, teams(spec, 'ab'));
        assert.deepEqual(winOf(a.user.id), [1, 1]);
        assert.deepEqual(winOf(b.user.id), [1, 1], 'the partner with the smaller share wins too');
        assert.deepEqual(winOf(c.user.id), [0, 0]);
        assert.deepEqual(winOf(d.user.id), [0, 2], 'the losing team resets');
        // next raid: a is AFK, b carries the team
        const spec2 = [{ p: a, banked: 0, activeMs: 0 }, { p: b, banked: 1500 }, { p: c, banked: 300 }, { p: d, banked: 200 }];
        raid(spec2, teams(spec2, 'ab'));
        assert.deepEqual(winOf(b.user.id), [2, 2]);
        assert.deepEqual(winOf(a.user.id), [1, 1], 'AFK partner: no win, no reset');
    } finally { global.Config.royale_duos = false; }
    reset();
});

test('once: a life, a day and a raid pay once, even replayed after a "restart"', () => {
    const u = mkUser();
    const now = Date.now();
    // settleLife twice (a resume racing the disconnect timer): one settle, one play pay
    const lifeId = 'once-life-' + u.id;
    rankStore.openLife({ lifeId, userId: u.id, raidKey: 'once:1', serverId: 't', startedAt: now - 2 * MIN, basisStart: 0, raidPtsStart: 0 });
    const life = { lifeId, userId: u.id, reason: 'death', now, basis: 0, countedBefore: 0, durationMs: 2 * MIN, sources: [] };
    assert.equal(rankStore.settleLife(life).streak.rewardMilli, 250);
    assert.equal(rankStore.settleLife(life), null);
    // the streak module on its own, as a restarted process would call it
    assert.equal(D().tx(() => streaks.onLife(D(), u.id, now + 1000)), null, 'same UTC day');
    // a second life row the same day
    const l2 = 'once-life-2-' + u.id;
    rankStore.openLife({ lifeId: l2, userId: u.id, raidKey: 'once:1', serverId: 't', startedAt: now - 2 * MIN, basisStart: 0, raidPtsStart: 0 });
    assert.equal(rankStore.settleLife({ ...life, lifeId: l2 }).streak, null);
    assert.equal(ledger(u.id, 'streak_play').length, 1);
    // raid placement twice with the same key: one result, one win pay
    const place = { raidKey: 'once:raid:1', userId: u.id, place: 1, rows: 6, score: 900, raidMs: 6 * MIN, now, played: true };
    const r1 = rankStore.applyRaidPlacement(place);
    assert.deepEqual([r1.streak.streak, r1.streak.rewardMilli], [1, 250]);
    assert.equal(r1.balanceMilli, balance(u.id), 'placement result carries the balance after the streak dust');
    assert.equal(rankStore.applyRaidPlacement(place), null);
    assert.equal(D().tx(() => streaks.onRaid(D(), u.id, { raidKey: 'once:raid:1', win: true, played: true }, now)), null, 'win_raid guard');
    assert.equal(ledger(u.id, 'streak_win').length, 1);
    assert.deepEqual(winOf(u.id), [1, 1]);
    // ineligible #1 (under five minutes) with played: a loss by the placement rules
    rankStore.applyRaidPlacement({ ...place, raidKey: 'once:raid:2', raidMs: 4 * MIN });
    assert.deepEqual(winOf(u.id), [0, 1]);
    const total = D().get('SELECT sum(delta_milli) AS s FROM dust_ledger WHERE user_id = ?', u.id).s;
    assert.equal(total, balance(u.id), 'ledger sums to the balance');
});

test('guests: no row, no packet, no dust', () => {
    const sock = mkSocket(null);
    sock.guestId = 'g'.repeat(32);
    H.clients.push(sock);
    const body = mkBody(sock);
    const s = mkStat('s:' + sock.id);
    rankHooks.onRaidStart();
    rankHooks.lifeStart(body, s);
    s.lifeStartAt -= 5 * MIN;
    s.banked = 900;
    s.lifeSurviveMs = 3 * MIN;
    rankHooks.onDeath(body, s);
    assert.equal(sock._rkPending.guest, true);
    assert.equal(sock._rkPending.streak, undefined);
    rankHooks.lifeStart(body, s);
    s.lifeStartAt -= 6 * MIN;
    rankHooks.onRaidEnd();
    assert.equal(packets(sock, 'STK').length, 0);
    assert.equal(packets(sock, 'DU').length, 0);
    assert.equal(bus.length, 0);
    assert.equal(D().get("SELECT count(*) AS n FROM dust_ledger WHERE kind IN ('streak_play', 'streak_win') AND user_id NOT IN (SELECT id FROM users)").n, 0);
    reset();
});

test('views: the menu view and the Discord /profile fields', () => {
    const u = mkUser('pf');
    let v = streaks.view(u.id);
    assert.deepEqual(v.play, { current: 0, best: 0, today: false, rewardMilli: 0, nextMilli: 250, maxDay: 7, maxMilli: 2000, resetsAt: (streaks.dayOf(Date.now()) + 1) * DAY });
    assert.deepEqual(v.win, { current: 0, best: 0, nextMilli: 250, dayCapMilli: 5000 });
    D().run('INSERT INTO user_streaks (user_id, play_cur, play_best, play_day, win_cur, win_best, updated_at) VALUES (?, 3, 5, ?, 2, 4, 1)', u.id, streaks.dayOf(Date.now()));
    v = streaks.view(u.id);
    assert.deepEqual([v.play.current, v.play.today, v.play.rewardMilli, v.play.nextMilli, v.win.current, v.win.nextMilli], [3, true, 750, 1000, 2, 750]);
    const res = commands.handle({ type: 2, data: { name: 'profile', options: [{ name: 'username', value: u.username }] }, user: { id: '999999999999999999' } });
    const fields = res.data.embeds[0].fields;
    assert.equal(fields.find(f => f.name === 'Play streak').value, '3 days (best 5)');
    assert.equal(fields.find(f => f.name === 'Win streak').value, '2 (best 4)');
});

// ===================================================================

async function main() {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietLog(...a); };
    console.warn = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietWarn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        const started = Date.now();
        try {
            const note = await t.fn();
            quietLog(`ok   ${t.name} (${Date.now() - started} ms)${typeof note === 'string' ? ' - ' + note : ''}`);
        } catch (e) {
            failed++;
            quietLog(`FAIL ${t.name}\n     ${((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')}`);
        }
    }
    accounts.shutdown();
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
