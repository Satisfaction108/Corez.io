// Achievements: node scripts/test/achievements.test.js
//
//   catalog     ~80 of them in 8 categories, tiers numbered, no dashes in the copy
//   migration   v13 from a v12 file: backup first, rows kept, the guest table,
//               the data column and the 'achievement' ledger kind
//   triggers    a sample from every category through the game hooks
//   first steps at least 5 within a new player's first minutes
//   once        no double unlock, no double pay, across sockets too
//   tiers       one counter feeds I, II, III; set and max tracks
//   guests      stored per guest id, carried over (and paid) on signup, once
//   rarity      share of players per achievement, cached
//   stage 0     only First Steps raise a card; the rest wait and come out later
//   wiring      the game calls the hooks where it should
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `ach-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-ach-test-'));
fs.mkdirSync(ROOT, { recursive: true });
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ROYALE_DEBUG']) delete process.env[k];
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'achievements-test-secret-0123456789-abcdefgh';
global.Config = { dig_royale: true };

const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const migrations = require('../../server/accounts/migrations');
const guests = require('../../server/accounts/guests');
const store = require('../../server/accounts/achievements');
const C = require('../../shared/achievements.js');
const COS = require('../../shared/cosmetics.js');
const D = () => dbmod.handle();

let ach = null;     // game/achHooks.js, after initMain
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let seq = 0;
function mkUser() {
    const r = accounts.users.create({ username: ('ach_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const gid = (n) => (n.toString(16) + 'c'.repeat(32)).slice(0, 32);
function mkSocket(o) {
    const s = { id: 'sock' + (++seq), account: null, guestId: null, packets: [], terminated: false, player: { body: null } };
    if (o.user) s.account = { id: o.user.id, publicId: o.user.public_id, username: o.user.username, blocked: new Set() };
    if (o.guest) s.guestId = o.guest;
    s.talk = (type, ...args) => s.packets.push([type, ...args]);
    return s;
}
function mkBody(socket, extra) {
    const b = Object.assign({ socket, id: ++seq, x: 0, y: 0, health: { amount: 100, max: 100 }, carriedGems: 0, royaleBornAt: Date.now() - 60000 }, extra || {});
    socket.player.body = b;
    return b;
}
const achIds = (s) => s.packets.filter(p => p[0] === 'ACH').map(p => JSON.parse(p[1]).id);
const dust = (userId) => D().get('SELECT dust_milli FROM users WHERE id = ?', userId).dust_milli | 0;
const ledger = (userId) => D().all("SELECT delta_milli, ref FROM dust_ledger WHERE user_id = ? AND kind = 'achievement' ORDER BY id", userId);
const rock = (biome, ore) => ({ biome, ore });

// ===================================================================

test('catalog: about 80 in 8 categories, tiers numbered, rewards small, no dashes', () => {
    assert.ok(C.DEFS.length >= 60 && C.DEFS.length <= 85, 'count ' + C.DEFS.length);
    assert.deepEqual(C.CATS.map(c => c.id), ['first', 'combat', 'mining', 'banking', 'tanks', 'abilities', 'raid', 'secret']);
    for (const c of C.CATS) assert.ok(C.DEFS.some(a => a.cat === c.id), c.id);
    const first = C.DEFS.filter(a => a.cat === 'first');
    assert.ok(first.length >= 5);
    assert.ok(C.DEFS.filter(a => a.secret).every(a => a.cat === 'secret'));
    // the twelve older ids are all still there
    for (const id of ['first_blood', 'bot_buster', 'banker', 'tycoon', 'podium', 'champion', 'boss_slayer', 'survivor', 'streaker', 'hoarder', 'emerald_eye', 'veteran']) assert.ok(C.BY_ID.has(id), id);
    assert.deepEqual(C.TRACKS.get('kills').map(a => [a.id, a.tier]), [['first_blood', 0], ['kills_1', 1], ['kills_2', 2], ['kills_3', 3]]);
    assert.deepEqual(C.TRACKS.get('banked').map(a => a.tier), [1, 2, 3]);
    for (const a of C.DEFS) {
        assert.ok(!/[–—]/.test(a.name + a.desc), a.id);
        assert.ok(a.name.length <= 24 && a.desc.length <= 60, a.id + ' copy is short');
        if (a.item) { const it = COS.byId(a.item); assert.ok(it && it.exclusive && it.price === 0 && it.earn === a.id, a.item); }
    }
    const total = C.DEFS.reduce((s, a) => s + a.rewardMilli, 0);
    assert.ok(total < 100 * 1000, 'the whole list pays under 100 dust: ' + total);
});

test('migration: v12 -> v13 backs up first and keeps every row', () => {
    const dir = path.join(ROOT, 'mig');
    const file = path.join(dir, 'v12.db');
    const raw = dbmod.open({ path: file, migrate: false });
    for (const m of migrations.MIGRATIONS.filter(m => m.version <= 12)) raw.tx(() => { m.up(raw); raw.exec(`PRAGMA user_version = ${m.version}`); });
    assert.equal(raw.userVersion(), 12);
    raw.run("INSERT INTO users (id, public_id, username, username_lc, created_at, dust_milli) VALUES (1, 'DW-TESTONE1', 'old', 'old', 1, 5000)");
    raw.run("INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at) VALUES (1, 'banker', 10000, 123)");
    raw.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 5000, 5000, 'daily', 1)");
    assert.throws(() => raw.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 1, 5001, 'achievement', 1)"), /CHECK/);
    raw.close();
    const m = dbmod.open({ path: file, migrate: true, backupDir: path.join(dir, 'backups') });
    assert.equal(m.userVersion(), migrations.latestVersion());
    assert.ok(migrations.latestVersion() >= 13);
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^pre-migrate-v13-.+\.db$/);
    assert.equal(m.get("SELECT unlocked_at FROM user_achievements WHERE user_id = 1 AND achievement_id = 'banker'").unlocked_at, 123);
    assert.equal(m.get("SELECT kind FROM dust_ledger WHERE user_id = 1").kind, 'daily');
    m.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 1, 5001, 'achievement', 2)");
    m.run("UPDATE user_achievements SET data = '[\"x\"]' WHERE user_id = 1");
    m.run("INSERT INTO guest_achievements (guest_id, achievement_id, unlocked_at) VALUES (?, 'fs_rock', 1)", gid(9));
    assert.throws(() => m.run("INSERT INTO guest_achievements (guest_id, achievement_id) VALUES ('short', 'fs_rock')"), /CHECK/);
    assert.match(m.get("SELECT sql FROM sqlite_master WHERE name = 'guest_achievements'").sql, /STRICT\s*$/);
    assert.ok(m.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'guest_achievements_unlocked'"));
    m.close();
});

test('triggers: First Steps all land in a new player\'s first minutes', () => {
    const u = mkUser();
    const s = mkSocket({ user: u });
    const b = mkBody(s, { skill: { amount: () => 1, cap: () => 12 } });
    ach.onRock(b, rock(0, 0));
    ach.onGem(b, 1);
    ach.onSkillUp(b, 'rld');
    ach.onUpgrade(b, 1, 'Twin');
    ach.onBank(b, 120);
    ach.onDeath({ socket: null, id: 999 }, { killer: b, victimBot: true });
    ach.onGrow(b, 1.25);
    ach.onAbility(b, 'grapple');
    const got = achIds(s);
    for (const a of C.DEFS.filter(x => x.cat === 'first')) assert.ok(got.includes(a.id), a.id + ' unlocked');
    // the packet carries what the card shows
    const p = JSON.parse(s.packets.find(x => x[0] === 'ACH')[1]);
    for (const k of ['id', 'cat', 'name', 'desc', 'icon', 'color', 'tier', 'secret', 'rewardMilli', 'item', 'guest']) assert.ok(k in p, k);
    assert.equal(p.guest, 0);
    // paid: 0.25 dust each, kind 'achievement', and the HUD told (DU kind 7)
    const firsts = C.DEFS.filter(x => x.cat === 'first');
    assert.ok(ledger(u.id).filter(r => /^ach:fs_/.test(r.ref)).length === firsts.length);
    assert.ok(s.packets.some(x => x[0] === 'DU' && x[4] === 7));
});

test('triggers: a sample from every category', () => {
    const u = mkUser();
    const s = mkSocket({ user: u });
    const b = mkBody(s, { skill: { amount: () => 12, cap: () => 12 } });
    const other = mkSocket({ user: mkUser() });
    const ob = mkBody(other);
    // combat
    ach.onDeath(ob, { killer: b, victimBot: false, streak: 5, avenged: true, crown: { how: 'steal' } });
    ach.onBoss(b);
    ach.onCoreHit(b);
    ach.onCoreBreak(b);
    // mining: biomes and ores
    ach.onRock(b, rock(5, 0));        // obsidian
    ach.onRock(b, rock(0, 1));        // sandstone ore
    ach.onRock(b, rock(3, 3));        // crystal shard
    ach.onRock(b, rock(2, 2));        // vein
    ach.onRock(b, rock(4, 4));        // emerald
    ach.onPerkBurst(b, 3);
    // banking
    b.health.amount = 8;
    ach.onDeposit(b, 2500);
    ach.onFlash(b);
    b.carriedGems = 3100;
    ach.onGem(b, 2);
    // tanks
    ach.onSkillUp(b, 'min');
    ach.onUpgrade(b, 3, 'Penta Shot');
    ach.onUpgrade(b, 4, 'Sequoia');
    ach.onGrow(b, 4.1);
    // abilities
    for (const id of ['grapple', 'burrow', 'shock', 'radar', 'wall', 'smoke', 'rush', 'pad']) ach.onAbility(b, id);
    // raid
    ach.onRaidEnd(s, { place: 1, alive: true, crown: true, played: true });
    ach.onChest(b);
    const got = new Set(achIds(s));
    for (const id of ['first_blood', 'streaker', 'revenge', 'crown_ko', 'crown_steal', 'boss_slayer', 'core_hit', 'core_break',
        'bi_obsidian', 'bi_sandstone', 'bi_crystal', 'ore_vein', 'ore_shard', 'ore_emerald', 'chain_blast',
        'fat_stack', 'close_call', 'flash_vault', 'hoarder',
        'stat_max', 'tank_t3', 'tank_t4', 'tank_t5', 'grow_2', 'grow_4',
        'ab_grapple', 'ab_pad', 'ab_all',
        'raid_survive', 'podium', 'champion', 'crown_win', 'chest_open']) assert.ok(got.has(id), id);
    // the victim was a player knocked out by a player: theirs is games only
    assert.deepEqual(achIds(other), []);
    // items come with some: Core Breaker's name style is owned now
    assert.ok(D().get("SELECT 1 AS x FROM owned_items WHERE user_id = ? AND item_id = 'ns_corebreaker'", u.id));
    assert.ok(D().get("SELECT 1 AS x FROM owned_items WHERE user_id = ? AND item_id = 'ns_crownkeeper'", u.id));
});

test('triggers: secrets (deaths, fling, pacifist, tourist) and the timed ones', () => {
    const s = mkSocket({ user: mkUser() });
    let b = mkBody(s);
    ach.onDeath(b, { cause: 'rock' });
    b = mkBody(s); ach.onDeath(b, { cause: 'storm' });
    b = mkBody(s); ach.onDeath(b, { cause: 'core', carried: 1500 });
    b = mkBody(s); b._achDepCutAt = Date.now() - 500; ach.onDeath(b, { killer: null });
    // Pacifist: 2,000 banked in one life without a hit on a tank...
    b = mkBody(s);
    ach.onBank(b, 1500);
    b._dealtAt = Date.now();        // ...this life hit someone: no more
    ach.onBank(b, 900);
    assert.ok(!achIds(s).includes('pacifist'));
    b = mkBody(s);
    ach.onBank(b, 1200); ach.onBank(b, 900);
    assert.ok(achIds(s).includes('pacifist'));
    // Tourist: all 6 biomes in one raid (a new raid starts over)
    ach.onRaidStart(7);
    for (let i = 0; i < 5; i++) ach.onRock(b, rock(i, 0));
    ach.onRaidStart(8);
    ach.onRock(b, rock(5, 0));
    assert.ok(!achIds(s).includes('tourist'));
    for (let i = 0; i < 5; i++) ach.onRock(b, rock(i, 0));
    assert.ok(achIds(s).includes('tourist'));
    // shockwaves into the storm: your own (Self Yeet), someone else (Get Out)
    ach.init({ inStorm: () => true, isFinal: () => true });
    ach.onFlingEnd(b, b);
    const victim = mkBody(mkSocket({ guest: gid(77) }));
    ach.onFlingEnd(victim, b);
    // Air Mail: off your pad, then knocked out by you
    const flown = { socket: null, id: 4242, _padBy: b, _padAt: Date.now() };
    ach.onDeath(flown, { killer: b, victimBot: true });
    // Great Escape: grapple out under 30% while hit, still alive later
    b.health.amount = 20; b.hitAt = Date.now() - 500;
    const t0 = Date.now();
    ach.onAbility(b, 'grapple', t0);
    assert.ok(ach._escapes.has(b));
    b._achEscapeAt = t0 - 7000;
    ach.tick(Date.now() + 5000);      // also: the final circle and Survivor checks
    const got = new Set(achIds(s));
    for (const id of ['rock_bottom', 'forecast', 'icarus', 'butterfingers', 'cookie_jar', 'yeet', 'fling_storm', 'pad_kill', 'grapple_escape', 'final_circle']) assert.ok(got.has(id), id);
    // secret cards say so
    assert.equal(JSON.parse(s.packets.find(p => p[0] === 'ACH' && JSON.parse(p[1]).id === 'rock_bottom')[1]).secret, 1);
    ach.init({ inStorm: () => false, isFinal: () => false });
});

test('once: no double unlock, no double pay, two sockets of one account', () => {
    const u = mkUser();
    const s1 = mkSocket({ user: u });
    const b1 = mkBody(s1);
    ach.onBoss(b1); ach.onBoss(b1); ach.onBoss(b1);
    assert.equal(achIds(s1).filter(x => x === 'boss_slayer').length, 1);
    // a second socket (another tab) has its own state but the database decides
    const s2 = mkSocket({ user: u });
    const b2 = mkBody(s2);
    ach.onBoss(b2);
    assert.deepEqual(achIds(s2).filter(x => x === 'boss_slayer'), []);
    assert.equal(ledger(u.id).filter(r => r.ref === 'ach:boss_slayer').length, 1);
    assert.deepEqual(store.unlock({ kind: 'a', id: u.id }, 'boss_slayer'), { fresh: false, rewardMilli: 0, balanceMilli: null, item: null });
    const before = dust(u.id);
    store.unlock({ kind: 'a', id: u.id }, 'boss_slayer');
    assert.equal(dust(u.id), before);
});

test('tiers: one counter feeds I, II and III; set and max tracks; saved and reloaded', () => {
    const u = mkUser();
    const s = mkSocket({ user: u });
    const b = mkBody(s);
    for (let i = 0; i < 299; i++) ach.onRock(b, rock(-1, 0));
    assert.ok(!achIds(s).includes('rocks_1'));
    ach.onRock(b, rock(-1, 0));
    assert.ok(achIds(s).includes('rocks_1'));
    assert.ok(!achIds(s).includes('rocks_2'));
    // banked jumps two tiers at once: both cards, in order
    ach.onBank(b, 80000);
    const ids = achIds(s);
    assert.ok(ids.indexOf('banker') >= 0 && ids.indexOf('bank_2') > ids.indexOf('banker'));
    assert.ok(!ids.includes('tycoon'));
    // tanks tried is a set: the same tank twice counts once
    for (const t of ['Twin', 'Twin', 'Sniper', 'Flank Guard', 'Machine Gun', 'Pounder', 'Director', 'Trapper', 'Smasher', 'Triple Shot']) ach.onUpgrade(b, 1, t);
    assert.ok(!achIds(s).includes('tried_10'));
    ach.onUpgrade(b, 2, 'Hunter');
    assert.ok(achIds(s).includes('tried_10'));
    // written within SAVE_MS (and on close); a fresh socket picks it up
    ach.onClose(s);
    const row = D().get("SELECT progress, data FROM user_achievements WHERE user_id = ? AND achievement_id = 'c:rocks'", u.id);
    assert.equal(row.progress, 300);
    assert.equal(JSON.parse(D().get("SELECT data FROM user_achievements WHERE user_id = ? AND achievement_id = 'c:tanks'", u.id).data).length, 10);
    const list = store.list(u.id);
    const r2 = list.find(a => a.id === 'rocks_2');
    assert.equal(r2.progress, 300);
    assert.equal(r2.goal, 3000);
    assert.equal(r2.tier, 2);
    assert.equal(list.find(a => a.id === 'tycoon').progress, 80000);
    const s2 = mkSocket({ user: u });
    const st = ach.stateOf(s2);
    assert.equal(st.n.get('rocks'), 300);
    assert.equal(st.sets.get('tanks').size, 10);
});

test('tiers: old lifetime stats seed the counters, past goals unlock quietly', () => {
    const u = mkUser();
    D().run('INSERT OR IGNORE INTO user_stats (user_id, updated_at) VALUES (?, 1)', u.id);
    D().run('UPDATE user_stats SET kills = 30, gems_banked = 12000, lives = 3 WHERE user_id = ?', u.id);
    const s = mkSocket({ user: u });
    const st = ach.stateOf(s);
    assert.ok(st.have.has('first_blood') && st.have.has('kills_1') && st.have.has('banker'));
    assert.deepEqual(achIds(s), [], 'no cards for old progress');
    assert.equal(store.list(u.id).find(a => a.id === 'veteran').progress, 3);
});

test('guests: earned and stored per guest id, carried over on signup and paid then, once', () => {
    const g = gid(1);
    guests.seen(g, Date.now(), null);
    const s = mkSocket({ guest: g });
    const b = mkBody(s);
    ach.onRock(b, rock(5, 0));
    ach.onBoss(b);
    for (let i = 0; i < 40; i++) ach.onRock(b, rock(1, 0));
    const p = JSON.parse(s.packets.find(x => x[0] === 'ACH')[1]);
    assert.equal(p.guest, 1, 'the card says sign up to keep it');
    assert.ok(!s.packets.some(x => x[0] === 'DU'), 'no dust for a guest');
    ach.onClose(s);
    const rows = D().all('SELECT achievement_id AS id FROM guest_achievements WHERE guest_id = ? AND unlocked_at IS NOT NULL', g).map(r => r.id).sort();
    assert.deepEqual(rows, ['bi_obsidian', 'boss_slayer', 'fs_rock']);
    assert.equal(D().get("SELECT progress FROM guest_achievements WHERE guest_id = ? AND achievement_id = 'c:b_clay'", g).progress, 40);
    const gl = store.listFor({ kind: 'g', id: g });
    assert.equal(gl.find(a => a.id === 'bi_clay').progress, 40);
    // signs up: the bridge path (guests.converted then achHooks.adoptGuest)
    const u = mkUser();
    // the account already had one of them: that one is not paid twice
    store.unlock({ kind: 'a', id: u.id }, 'fs_rock');
    const d0 = dust(u.id);
    const sock = mkSocket({ user: u });
    sock.guestId = g;
    assert.equal(guests.converted(g, u.id), true);
    const r = ach.adoptGuest(sock, g, u.id);
    assert.deepEqual(r.moved.sort(), ['bi_obsidian', 'boss_slayer']);
    const want = C.BY_ID.get('bi_obsidian').rewardMilli + C.BY_ID.get('boss_slayer').rewardMilli;
    assert.equal(r.rewardMilli, want);
    assert.equal(dust(u.id), d0 + want);
    assert.equal(D().get('SELECT COUNT(*) AS n FROM guest_achievements WHERE guest_id = ?', g).n, 0, 'guest rows gone');
    assert.equal(D().get("SELECT progress FROM user_achievements WHERE user_id = ? AND achievement_id = 'c:b_clay'", u.id).progress, 40);
    // the original unlock time came along
    assert.ok(D().get("SELECT unlocked_at FROM user_achievements WHERE user_id = ? AND achievement_id = 'boss_slayer'", u.id).unlocked_at <= Date.now());
    // once only
    const again = store.adoptGuest(g, u.id);
    assert.deepEqual(again.moved, []);
    assert.equal(dust(u.id), d0 + want);
    // and the reloaded socket state is the account's
    assert.equal(ach.stateOf(sock).owner.kind, 'a');
});

test('guests: an older account gets nothing from a guest browser', () => {
    const g = gid(2);
    store.unlock({ kind: 'g', id: g }, 'fs_gem');
    const u = mkUser();
    D().run('UPDATE users SET created_at = ? WHERE id = ?', Date.now() - 3 * store.NEW_ACCOUNT_MS, u.id);
    assert.deepEqual(store.adoptGuest(g, u.id).moved, []);
    assert.equal(D().get('SELECT COUNT(*) AS n FROM guest_achievements WHERE guest_id = ?', g).n, 1, 'the guest keeps it');
});

test('rarity: share of players per achievement, cached, secrets hidden in lists', () => {
    // a clean slate for the count
    D().run('DELETE FROM user_achievements');
    D().run('DELETE FROM guest_achievements');
    store._resetRarity();
    const owners = [];
    for (let i = 0; i < 8; i++) owners.push({ kind: 'a', id: mkUser().id });
    owners.push({ kind: 'g', id: gid(50) }, { kind: 'g', id: gid(51) });
    for (const o of owners) store.unlock(o, 'fs_rock');
    store.unlock(owners[0], 'champion');
    store.unlock(owners[8], 'tourist');
    const r = store.rarity(Date.now(), true);
    assert.equal(r.players, 10);
    assert.equal(r.pct.fs_rock, 100);
    assert.equal(r.pct.champion, 10);
    assert.equal(r.pct.tourist, 10);
    assert.equal(r.pct.kills_3, 0);
    // cached: a new unlock shows up only after RARITY_MS (or a forced recount)
    store.unlock(owners[1], 'champion');
    assert.equal(store.rarity().pct.champion, 10);
    assert.equal(store.rarity(Date.now() + store.RARITY_MS + 1).pct.champion, 20);
    // lists carry it; an unfound secret is ??? with no hint of its reward item
    const l = store.listFor(owners[1]);
    assert.equal(l.find(a => a.id === 'champion').rarity, 20);
    const sec = l.find(a => a.id === 'rock_bottom');
    assert.equal(sec.name, '???');
    assert.equal(sec.item, null);
    assert.equal(sec.icon, 'secret');
    assert.equal(store.listFor(owners[8]).find(a => a.id === 'tourist').name, 'Tourist');
});

test('stage 0: only First Steps raise a card; the rest wait and come out later', async () => {
    const L = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'achievementsLogic.js')).href);
    const first = { id: 'fs_rock', cat: 'first' };
    const boss = { id: 'boss_slayer', cat: 'combat' };
    assert.equal(L.admit(first, 0), 'show');
    assert.equal(L.admit(boss, 0), 'hold');
    assert.equal(L.admit(boss, 1), 'show');
    assert.equal(L.admit(boss, null), 'show', 'unknown stage is a veteran');
    assert.equal(L.admit(null, 0), 'drop');
    // held ones: still stage 0 -> nothing; later -> out, folded when many
    const held = [boss, { id: 'chest_open', cat: 'raid' }, { id: 'ore_vein', cat: 'mining' }];
    assert.deepEqual(L.release(held, 0).show, []);
    assert.equal(L.release(held, 0).rest.length, 3);
    assert.deepEqual(L.release(held.slice(0, 2), 1).show.map(d => d.id), ['boss_slayer', 'chest_open']);
    const r = L.release(held, 2);
    assert.equal(r.summary, 3);
    assert.deepEqual(r.rest, []);
    // the queue: one card at a time, a burst folds into "+N"
    const q = [];
    for (let i = 0; i < 9; i++) L.enqueue(q, { id: 'a' + i, cat: 'mining' });
    L.enqueue(q, { id: 'a0', cat: 'mining' });
    assert.equal(q.length, L.MAX_WAIT);
    assert.equal(q[q.length - 1].summary, 6);
    assert.equal(L.durationFor(2), L.CARD_FAST_MS);
    assert.equal(L.durationFor(0), L.CARD_MS);
    // the words
    const t = L.cardText({ id: 'kills_2', name: 'Brawler', desc: 'Knock out 150 players', tier: 2, rewardMilli: 1000 });
    assert.deepEqual([t.label, t.title, t.tier, t.reward], ['Achievement unlocked', 'Brawler', 'II', '+1 gemdust']);
    assert.equal(L.cardText({ id: 'x', name: 'X', rewardMilli: 250, guest: 1 }).reward, 'Sign up to keep your rewards');
    assert.equal(L.cardText({ id: 'y', name: 'Y', secret: 1, rewardMilli: 500, item: 'ns_bedrock' }, 'Bedrock').reward, '+0.5 gemdust and Bedrock name style');
    assert.equal(L.cardText({ summary: 4 }).title, '+4 unlocked');
});

test('performance: a bot or a held achievement returns at once', () => {
    const botBody = { socket: undefined, id: 1 };
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 100000; i++) { ach.onRock(botBody, rock(1, 1)); ach.onGem(botBody, 1); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 250, 'bots: ' + ms.toFixed(1) + ' ms for 200k calls');
    const s = mkSocket({ user: mkUser() });
    const b = mkBody(s);
    ach.onBoss(b);
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < 100000; i++) ach.onBoss(b);
    const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.ok(ms2 < 250, 'held: ' + ms2.toFixed(1) + ' ms for 100k calls');
});

test('wiring: the game calls the hooks', () => {
    const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
    const dr = rd('server/game/gamemodes/scripts/dig_royale.js');
    for (const re of [/achHooks\.onBank\(body, amount\)/, /achHooks\.onDeath\(body, \{/, /achHooks\.onBoss\(killer\)/, /achHooks\.onChest\(body\)/,
        /achHooks\.onGrow\(body, stage\)/, /body\.on\('upgrade'/, /body\.on\('skillUp'/, /achHooks\.onRaidEnd\(client/, /achHooks\.onRaidStart\(raidId\)/, /achHooks\.tick\(t\)/]) assert.match(dr, re);
    assert.match(rd('server/game/terrain/terrainGrid.js'), /global\.royaleAch\.onRock\(owner, rock\)/);
    assert.match(rd('server/game/terrain/gems.js'), /global\.royaleAch\.onGem\(toucher/);
    assert.match(rd('server/game/terrain/vault.js'), /global\.royaleAch\.onDeposit\(body, d\.total\)/);
    assert.match(rd('server/game/terrain/vault.js'), /global\.royaleAch\.onDepositCut\(body\)/);
    assert.match(rd('server/game/terrain/shop.js'), /global\.royaleAch\.onFlash\(body\)/);
    const ab = rd('server/game/terrain/abilities.js');
    assert.match(ab, /global\.royaleAch\.onAbility\(body, id, t\)/);
    assert.match(ab, /global\.royaleAch\.onFlingEnd\(body, by\)/);
    assert.match(ab, /b\._padBy = p\.owner/);
    assert.match(rd('server/game/terrain/raidPerks.js'), /global\.royaleAch\.onPerkBurst\(owner, broke\)/);
    assert.match(rd('server/game/terrain/coreFinale.js'), /global\.royaleAch\.onCoreHit\(root\)/);
    assert.match(rd('server/game/entities/entity.js'), /this\.emit\("upgrade", \{ body: this, tier: upTier \}\)/);
    const br = rd('server/accounts/game/bridge.js');
    assert.match(br, /require\('\.\/achHooks'\)\.adoptGuest\(socket, socket\.guestId, socket\.account\.id\)/);
    assert.match(br, /require\('\.\/achHooks'\)\.onClose\(socket\)/);
    assert.match(rd('public/client/socketinit.js'), /window\.dwAch\(d\)/);
});

// ===================================================================

(async () => {
    const quietLog = console.log;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quietLog(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    ach = require('../../server/accounts/game/achHooks');
    ach._force(true);
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
