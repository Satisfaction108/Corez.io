'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..', '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-levels-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'TRUSTED_PROXIES', 'DISCORD_BOT_TOKEN', 'ROYALE_DEBUG', 'LEVELS']) delete process.env[k];
Object.assign(process.env, { NODE_ENV: 'test', ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'levels-test-secret-0123456789-abcdefghijklm', PORT: '3000' });
global.Config = { dig_royale: true };

const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const migrations = require('../../server/accounts/migrations');
const levels = require('../../server/accounts/levels');
const L = require('../../shared/levels.js');
const C = require('../../shared/cosmetics.js');
const D = () => dbmod.handle();

let hooks = null;
let base = '';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let seq = 0;
function mkUser(opts = {}) {
    const r = accounts.users.create({ username: ('lv_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null, now: opts.now });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}
const gid = (n) => (n.toString(16) + 'e'.repeat(32)).slice(0, 32);
const A = (u) => ({ kind: 'a', id: u.id });
const G = (g) => ({ kind: 'g', id: g });
function mkSocket(o) {
    const s = { id: 'sock' + (++seq), account: null, guestId: null, packets: [], terminated: false, player: { body: null }, lastInputAt: Date.now() };
    if (o.user) s.account = { id: o.user.id, publicId: o.user.public_id, username: o.user.username, blocked: new Set() };
    if (o.guest) s.guestId = o.guest;
    s.talk = (type, ...args) => s.packets.push([type, ...args]);
    return s;
}
function mkBody(socket, extra) {
    const b = Object.assign({ socket, id: ++seq, x: 0, y: 0, isDead: () => false, royaleBornAt: Date.now() - 60000 }, extra || {});
    socket.player.body = b;
    return b;
}
const lvPackets = (s) => s.packets.filter(p => p[0] === 'LV').map(p => JSON.parse(p[1]));
const lastLv = (s) => { const a = lvPackets(s); return a[a.length - 1]; };
const userRow = (id) => D().get('SELECT xp, level, xp_day_n AS dayXp, dust_milli FROM users WHERE id = ?', id);
const guestRow = (g) => D().get('SELECT xp, level, xp_day_n AS dayXp, xp_to FROM guests WHERE guest_id = ?', g);
const owned = (id) => D().all('SELECT item_id, source FROM owned_items WHERE user_id = ? ORDER BY item_id', id);
const ledger = (id) => D().all("SELECT delta_milli, ref FROM dust_ledger WHERE user_id = ? AND kind = 'level' ORDER BY id", id);

test('curve: level 2 in a first session, level 5 in two light days, later levels slower, 100 at the top', () => {
    assert.equal(L.MAX_LEVEL, 100);
    assert.equal(L.NEED.length, 101);
    for (let l = 2; l < L.MAX_LEVEL; l++) assert.ok(L.NEED[l] >= L.NEED[l - 1], 'need grows at ' + l);
    assert.ok(L.NEED[99] > 10 * L.NEED[1], 'the last levels are much slower');
    assert.equal(L.NEED[100], 0);
    const session = (min, gems, botKills) => min * L.XP.minute + gems / L.XP.gemsPerXp + botKills * L.XP.botKill + L.XP.raidPlayed;
    assert.ok(session(6, 300, 2) >= L.START[2], 'six minutes and a small bank reach level 2: ' + session(6, 300, 2) + ' vs ' + L.START[2]);
    const lightDay = session(20, 1200, 5);
    assert.ok(2 * lightDay >= L.START[5] && lightDay < L.START[5], 'level 5 takes about two light days: ' + lightDay + ' a day vs ' + L.START[5]);
    assert.ok(L.TOTAL / L.DAY_CAP >= 50, 'nobody reaches 100 in under 50 days: ' + L.TOTAL);
    assert.deepEqual(L.levelOf(0), { level: 1, into: 0, need: L.NEED[1], total: 0, max: false });
    assert.equal(L.levelOf(L.START[2] - 1).level, 1);
    assert.equal(L.levelOf(L.START[2]).level, 2);
    assert.equal(L.levelOf(L.START[7] + 5).into, 5);
    assert.equal(L.levelOf(L.TOTAL).level, 100);
    assert.equal(L.levelOf(L.TOTAL * 3).max, true);
    assert.equal(L.levelOf(-5).level, 1);
});

test('table: every level gives something, only cosmetics, gemdust and titles, no stat buffs', () => {
    assert.equal(L.REWARDS.length, 99);
    const KEYS = ['level', 'dustMilli', 'item', 'fallbackMilli', 'title', 'milestone'].sort();
    let lastCos = 1;
    for (const r of L.REWARDS) {
        assert.deepEqual(Object.keys(r).sort(), KEYS, 'level ' + r.level + ' only has reward fields');
        assert.ok(r.dustMilli > 0 || r.item || r.title, 'level ' + r.level + ' gives something');
        assert.ok(r.dustMilli >= 0 && r.dustMilli <= 100000, 'level ' + r.level + ' dust is bounded');
        if (r.item) {
            const it = C.byId(r.item);
            assert.ok(it && C.CATS.includes(it.cat) && !it.retired, r.item + ' is a catalog cosmetic');
            if (it.exclusive) assert.ok(it.lvl === r.level && it.price === 0 && !it.earn, r.item + ' is this level\'s own reward');
            else assert.ok(r.fallbackMilli > 0, r.item + ' pays dust when it is already owned');
            if (it.cat === 'sidekick') assert.ok(['common', 'uncommon'].includes(it.rarity), r.item + ' digs no harder than a cheap shop sidekick');
        }
        if (r.item || r.title) { assert.ok(r.level - lastCos <= 5, 'something new by level ' + r.level); lastCos = r.level; }
    }
    assert.doesNotMatch(JSON.stringify(L.REWARDS), /damage|health|speed|reload|regen|penetrat|boost|buff|mult|shield|armor|gems/i);
    const LOOK = new Set(['nid', 'id', 'cat', 'name', 'rarity', 'price', 'style', 'skin', 'kick', 'look', 'blurb', 'exclusive', 'permanent', 'retired', 'lvl']);
    for (const r of L.REWARDS.filter(x => x.item)) for (const k of Object.keys(C.byId(r.item))) assert.ok(LOOK.has(k), r.item + ' has only look fields, not ' + k);
    for (const l of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
        const r = L.rewardAt(l);
        assert.ok(r.milestone && r.item && r.title && r.dustMilli >= 5000, 'milestone ' + l);
        assert.ok(C.byId(r.item).exclusive || l === 10, l + ' gives a level-only item');
    }
    assert.ok(L.DUST_TOTAL < 600 * 1000, 'all 100 levels pay under 600 gemdust: ' + L.DUST_TOTAL);
    for (const id of L.LEVEL_ITEMS) {
        const it = C.byId(id);
        assert.ok(it.exclusive && it.price === 0, id);
        assert.equal(L.rewardAt(it.lvl).item, id);
        if (it.style) for (const s of it.style.stops) assert.ok(C.isColorAllowed(s), id + ' ' + s);
    }
    assert.equal(L.titleFor(1), 'Rookie');
    assert.equal(L.titleFor(12), 'Prospector');
    assert.equal(L.titleFor(50), 'Legend');
    assert.equal(L.titleFor(100), 'Overlord');
    const copy = L.REWARDS.map(r => L.upLine(r, C, false) + L.upLine(r, C, true) + L.rewardText(r, C)).join(' ') + L.TITLES.map(t => t.title).join(' ');
    assert.doesNotMatch(copy, /[\u2013\u2014]/);
    assert.equal(L.upLine(L.rewardAt(8), C, false), 'Level 8! You unlocked the Pumpkin skin.');
    assert.equal(L.upLine(L.rewardAt(8), C, true), 'Level 8! The Pumpkin skin is saved for when you sign up.');
    assert.equal(L.nextLine(7, C), 'Next: Pumpkin skin at Lvl 8');
    assert.equal(L.nextLine(100, C), '');
});

test('xp rules: raid and event places, the per day cap', () => {
    assert.equal(L.raidXp(1, true), 40);
    assert.equal(L.raidXp(3, true), 24);
    assert.equal(L.raidXp(7, true), 12);
    assert.equal(L.raidXp(30, true), 6);
    assert.equal(L.raidXp(1, false), 0);
    assert.equal(L.eventXp(1, 20), 50);
    assert.equal(L.eventXp(8, 20), 12);
    assert.equal(L.eventXp(15, 20), 6);
    const a = L.capDay({ day: 5, dayXp: 990 }, 50, 5);
    assert.deepEqual([a.add, a.dayXp, a.capped], [10, 1000, true]);
    const b = L.capDay({ day: 5, dayXp: 1000 }, 50, 6);
    assert.deepEqual([b.add, b.dayXp, b.capped], [50, 50, false]);
    assert.equal(L.capDay(null, 30, 1).add, 30);
});

test('accrual: banking, kills and active play earn XP on the server, idle time earns none', () => {
    const u = mkUser();
    const s = mkSocket({ user: u });
    const b = mkBody(s);
    hooks.onBank(b, 400);
    hooks.onDeath({ socket: null, id: 1 }, { killer: b, victimBot: true });
    const vs = mkSocket({ user: mkUser() });
    const v = mkBody(vs, { royaleBornAt: Date.now() - 60000 });
    hooks.onDeath(v, { killer: b, victimBot: false });
    hooks.onDeath(v, { killer: b, victimBot: false });
    hooks.onDeath(v, { killer: b, victimBot: false });
    hooks.flush(s, s._lv);
    assert.equal(userRow(u.id).xp, 400 / L.XP.gemsPerXp + L.XP.botKill + 2 * L.XP.kill, 'the same victim pays twice at most');
    const fresh = mkSocket({ user: mkUser() });
    const fb = mkBody(fresh, { royaleBornAt: Date.now() - 1000 });
    hooks.onDeath(fb, { killer: b, victimBot: false });
    hooks.flush(s, s._lv);
    assert.equal(userRow(u.id).xp, 20 + 4 + 24, 'a spawn kill pays nothing');
    const p = lastLv(s);
    assert.equal(p.lv, L.levelOf(48).level);
    assert.equal(p.xp, 48);
    assert.ok('into' in p && 'need' in p && 'next' in p && 'life' in p);
    s.lastInputAt = Date.now() - 5 * 60000;
    hooks.onBank(b, 400);
    hooks.flush(s, s._lv);
    assert.equal(userRow(u.id).xp, 48, 'an idle tank earns nothing for banking');
    const t0 = Date.now() + 100000;
    hooks._reset();
    const live = { socketManager: { clients: [s] } };
    const old = global.gameManager;
    global.gameManager = live;
    try {
        for (let i = 0; i <= 60; i++) { s.lastInputAt = t0 + i * 1000; hooks.tick(t0 + i * 1000); }
        hooks.flush(s, s._lv, t0 + 61000);
        const afterActive = userRow(u.id).xp;
        assert.ok(afterActive - 48 >= L.XP.minute - 1 && afterActive - 48 <= L.XP.minute, 'a minute of play: ' + (afterActive - 48));
        hooks._reset();
        for (let i = 0; i <= 120; i++) hooks.tick(t0 + 200000 + i * 1000);
        hooks.flush(s, s._lv, t0 + 330000);
        assert.equal(userRow(u.id).xp, afterActive, 'two minutes with no input earn nothing');
        b.isDead = () => true;
        s.lastInputAt = t0 + 400000;
        hooks._reset();
        for (let i = 0; i <= 30; i++) hooks.tick(t0 + 400000 + i * 1000);
        hooks.flush(s, s._lv, t0 + 431000);
        assert.equal(userRow(u.id).xp, afterActive, 'dead time earns nothing');
    } finally { global.gameManager = old; }
});

test('death card: the life\'s XP goes out on death, then the next life starts at zero', () => {
    const u = mkUser();
    const s = mkSocket({ user: u });
    const b = mkBody(s);
    hooks.onBank(b, 1200);
    hooks.onDeath(b, { killer: null, cause: 'player' });
    const p = lastLv(s);
    assert.equal(p.dead, 1);
    assert.equal(p.life, 60);
    assert.equal(s._lv.life, 0);
    hooks.onRaidEnd(s, { place: 1, played: true });
    assert.equal(userRow(u.id).xp, 100);
});

test('cap: a day past the cap earns nothing more until the next UTC day', () => {
    const u = mkUser();
    const day = Date.UTC(2026, 9, 12, 10);
    const r1 = levels.addXp(A(u), 990, 'test', day);
    assert.equal(r1.gained, 990);
    const r2 = levels.addXp(A(u), 50, 'test', day + 3600e3);
    assert.equal(r2.gained, 10);
    assert.equal(r2.capped, true);
    const r3 = levels.addXp(A(u), 50, 'test', day + 3 * 3600e3);
    assert.equal(r3.gained, 0);
    const r4 = levels.addXp(A(u), 50, 'test', day + 24 * 3600e3);
    assert.equal(r4.gained, 50);
    assert.equal(userRow(u.id).xp, 1050);
    assert.equal(levels.status(A(u), day + 24 * 3600e3).dayXp, 50);
});

test('unlocks: level ups pay once, items owned with source level, worn when the slot is empty, owned shop items pay dust', () => {
    const u = mkUser();
    D().run("INSERT INTO owned_items (user_id, item_id, source, acquired_at) VALUES (?, 'sd_twinny', 'purchase', 1)", u.id);
    const now = Date.UTC(2026, 9, 12, 12);
    let r = levels.addXp(A(u), L.START[8], 'test', now);
    assert.equal(r.level, 8);
    assert.deepEqual(r.ups.map(x => x.level), [2, 3, 4, 5, 6, 7, 8]);
    assert.equal(r.ups[r.ups.length - 1].line, 'Level 8! You unlocked the Pumpkin skin.');
    assert.deepEqual(owned(u.id).filter(x => x.source === 'level').map(x => x.item_id), ['ns_lv_sprout', 'sk_lv_pumpkin']);
    const eq = D().get('SELECT equip_name_style AS ns, equip_skin AS sk FROM users WHERE id = ?', u.id);
    assert.deepEqual([eq.ns, eq.sk], ['ns_lv_sprout', 'sk_lv_pumpkin']);
    const dust8 = L.rewardsBetween(1, 8).reduce((s, x) => s + x.dustMilli, 0);
    assert.equal(ledger(u.id).reduce((s, x) => s + x.delta_milli, 0), dust8);
    assert.equal(userRow(u.id).dust_milli, dust8);
    r = levels.addXp(A(u), L.START[10] - L.START[8], 'test', now + 24 * 3600e3);
    assert.equal(r.level, 10);
    const ten = r.ups.find(x => x.level === 10);
    assert.equal(ten.item, null);
    assert.equal(ten.had.id, 'sd_twinny');
    assert.equal(ten.dustMilli, L.rewardAt(10).dustMilli + L.rewardAt(10).fallbackMilli);
    assert.equal(D().get('SELECT count(*) AS n FROM level_grants WHERE user_id = ?', u.id).n, 9);
    D().run('UPDATE users SET level = 1 WHERE id = ?', u.id);
    const again = levels.addXp(A(u), 1, 'test', now + 2);
    assert.equal(again.dustMilli, 0, 'a level is never paid twice');
    assert.equal(ledger(u.id).length, new Set(ledger(u.id).map(x => x.ref)).size);
});

test('guests: XP on the guest row, unlocks saved for sign up, carried over once to a new account', () => {
    const g = gid(++seq);
    const s = mkSocket({ guest: g });
    const b = mkBody(s);
    hooks.onBank(b, (L.START[4] + 10) * L.XP.gemsPerXp);
    const res = hooks.flush(s, s._lv);
    assert.equal(res.level, 4);
    assert.ok(res.ups.every(x => x.guest), 'the guest is told it waits');
    assert.equal(res.ups.find(x => x.level === 3).line, 'Level 3! The Sprout name style is saved for when you sign up.');
    assert.deepEqual([guestRow(g).xp, guestRow(g).level], [L.START[4] + 10, 4]);
    const p = lastLv(s);
    assert.equal(p.guest, 1);
    assert.ok(p.ups.some(x => /saved for when you sign up/.test(x.line)));
    const st = levels.status(G(g));
    assert.equal(st.owner, 'guest');
    assert.deepEqual(st.saved.items.map(i => i.id), ['ns_lv_sprout']);
    assert.equal(st.saved.dustMilli, 2000);
    const u = mkUser();
    const us = mkSocket({ user: u });
    us.guestId = g;
    const ad = hooks.adoptGuest(us, g, u.id);
    assert.equal(ad.moved, true);
    assert.equal(ad.level, 4);
    assert.equal(userRow(u.id).xp, L.START[4] + 10);
    assert.deepEqual(owned(u.id).map(x => [x.item_id, x.source]), [['ns_lv_sprout', 'level']]);
    assert.equal(userRow(u.id).dust_milli, 2000);
    assert.equal(guestRow(g).xp_to, u.id);
    assert.equal(guestRow(g).xp, 0);
    assert.equal(levels.adoptGuest(u.id, g).moved, false, 'once');
    assert.equal(lastLv(us).adopted, 1);
    assert.equal(lastLv(us).lv, 4);
    assert.equal(levels.status(G(g)).moved, true);
});

test('grant api: the Always-On hook takes a socket, a body or an owner, capped per call and per day', () => {
    const u = mkUser();
    const s = mkSocket({ user: u });
    const b = mkBody(s);
    const old = global.gameManager;
    global.gameManager = { socketManager: { clients: [s] } };
    try {
        assert.equal(levels.grant(s, 30, 'event').gained, 30);
        assert.equal(levels.grant(b, 20, 'event').gained, 20);
        assert.equal(levels.grant(A(u), 10, 'event').gained, 10);
        assert.equal(levels.eventPlaced(A(u), 1, 12).gained, 50);
        assert.equal(levels.grant(A(u), 5000, 'event').gained, L.XP.grantMax);
        assert.equal(userRow(u.id).xp, 110 + L.XP.grantMax);
        assert.ok(lvPackets(s).length >= 4, 'the socket hears about it');
        s.lastInputAt = Date.now() - 10 * 60000;
        assert.equal(levels.grant(s, 30, 'event'), null, 'an idle player gets no event XP');
        const g = gid(++seq);
        assert.equal(levels.grant(G(g), 25, 'event').gained, 25);
        assert.equal(guestRow(g).xp, 25);
        assert.equal(levels.grant({ nope: 1 }, 25), null);
        assert.equal(levels.grant(A(u), 0), null);
    } finally { global.gameManager = old; }
});

test('migration: v14 -> v15 keeps owned items and the ledger, adds the level source and kind', () => {
    const dir = path.join(ROOT, 'mig');
    const file = path.join(dir, 'v14.db');
    fs.mkdirSync(dir, { recursive: true });
    const raw = dbmod.open({ path: file, migrate: false });
    for (const m of migrations.MIGRATIONS.filter(m => m.version <= 14)) raw.tx(() => { m.up(raw); raw.exec(`PRAGMA user_version = ${m.version}`); });
    assert.equal(raw.userVersion(), 14);
    raw.run("INSERT INTO users (id, public_id, username, username_lc, created_at, dust_milli) VALUES (1, 'DW-TESTONE1', 'old', 'old', 1, 5000)");
    raw.run("INSERT INTO owned_items (user_id, item_id, source, acquired_at) VALUES (1, 'sk_racer', 'purchase', 5)");
    raw.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 5000, 5000, 'achievement', 1)");
    raw.run("INSERT INTO guests (guest_id, first_seen, last_seen) VALUES (?, 1, 1)", gid(77));
    assert.throws(() => raw.run("INSERT INTO owned_items (user_id, item_id, source, acquired_at) VALUES (1, 'sk_split', 'level', 6)"), /CHECK/);
    raw.close();
    const m = dbmod.open({ path: file, migrate: true, backupDir: path.join(dir, 'backups') });
    assert.equal(m.userVersion(), migrations.latestVersion());
    assert.ok(migrations.latestVersion() >= 15);
    assert.match(fs.readdirSync(path.join(dir, 'backups'))[0], /^pre-migrate-v15-.+\.db$/);
    assert.equal(m.get("SELECT source FROM owned_items WHERE user_id = 1 AND item_id = 'sk_racer'").source, 'purchase');
    assert.equal(m.get('SELECT kind FROM dust_ledger WHERE user_id = 1').kind, 'achievement');
    m.run("INSERT INTO owned_items (user_id, item_id, source, acquired_at) VALUES (1, 'sk_split', 'level', 6)");
    m.run("INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, created_at) VALUES (1, 1000, 6000, 'level', 2)");
    assert.throws(() => m.run("INSERT INTO owned_items (user_id, item_id, source, acquired_at) VALUES (1, 'sk_pip', 'stolen', 6)"), /CHECK/);
    const u = m.get('SELECT xp, level, xp_day, xp_day_n FROM users WHERE id = 1');
    assert.deepEqual([u.xp, u.level, u.xp_day, u.xp_day_n], [0, 1, 0, 0]);
    const g = m.get('SELECT xp, level, xp_to FROM guests WHERE guest_id = ?', gid(77));
    assert.deepEqual([g.xp, g.level, g.xp_to], [0, 1, null]);
    m.run('INSERT INTO level_grants (user_id, level, at) VALUES (1, 2, 3)');
    assert.throws(() => m.run('INSERT INTO level_grants (user_id, level, at) VALUES (1, 2, 4)'), /UNIQUE|PRIMARY/);
    assert.throws(() => m.run('INSERT INTO level_grants (user_id, level, at) VALUES (1, 101, 4)'), /CHECK/);
    assert.match(m.get("SELECT sql FROM sqlite_master WHERE name = 'owned_items'").sql, /STRICT\s*$/);
    assert.ok(m.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'dust_ledger_user'"));
    m.close();
});

async function api(p, body, { cookie = '', ip = '10.9.' + (seq % 250) + '.' + ((++seq) % 250) } = {}) {
    const headers = { 'Content-Type': 'application/json', Origin: base, 'X-Forwarded-For': ip };
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    let json = null;
    try { json = await r.json(); } catch (e) { void e; }
    return { status: r.status, json };
}

test('http: POST /api/levels for a guest, then the new account takes the guest\'s levels', async () => {
    const g = gid(++seq);
    levels.addXp(G(g), L.START[9] + 3, 'test');
    let r = await api('/api/levels', { guestId: g });
    assert.equal(r.status, 200);
    assert.equal(r.json.level, 9);
    assert.equal(r.json.owner, 'guest');
    assert.equal(r.json.title, 'Digger');
    assert.equal(r.json.nextLine, 'Next: Twinny sidekick at Lvl 10');
    assert.deepEqual(r.json.saved.items.map(i => i.id), ['ns_lv_sprout', 'sk_lv_pumpkin']);
    assert.equal((await api('/api/levels', {})).status, 400);
    const u = mkUser();
    const cookie = 'dw_sid=' + accounts.sessions.create(u.id, { method: 'password' }).token;
    r = await api('/api/levels', { guestId: g }, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.owner, 'account');
    assert.equal(r.json.level, 9);
    assert.equal(r.json.adoptedNow.level, 9);
    assert.ok(r.json.adoptedNow.ups.some(x => x.item && x.item.id === 'sk_lv_pumpkin'));
    r = await api('/api/levels', { guestId: g }, { cookie });
    assert.equal(r.json.adoptedNow, null);
    const sh = await fetch(base + '/shared/levels.js');
    assert.equal(sh.status, 200);
    assert.match(await sh.text(), /DWLevels/);
});

test('wiring: the hooks, the bridge, the client and the shared file are hooked up, no comments, no dashes', () => {
    const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
    const ah = rd('server/accounts/game/achHooks.js');
    for (const re of [/levels\(\)\.onBank\(body, amount\)/, /levels\(\)\.onDeath\(victim, i\)/, /levels\(\)\.onRaidEnd\(socket, r\)/, /levels\(\)\.tick\(t\)/, /levels\(\)\.onClose\(socket\)/]) assert.match(ah, re);
    assert.match(rd('server/accounts/game/bridge.js'), /require\('\.\/levelHooks'\)\.adoptGuest\(socket, socket\.guestId, socket\.account\.id\)/);
    assert.match(rd('server/accounts/index.js'), /'levels\.js'\]\)/);
    assert.match(rd('public/index.html'), /<script src="\/shared\/levels\.js"><\/script>/);
    assert.match(rd('public/client/socketinit.js'), /case 'LV':/);
    for (const f of ['shared/levels.js', 'server/accounts/levels.js', 'server/accounts/game/levelHooks.js', 'server/accounts/routes/levels.js', 'public/client/levelsHud.js', 'public/client/account/levels.js', 'scripts/test/levels.test.js']) {
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
    base = `http://127.0.0.1:${server.address().port}`;
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
