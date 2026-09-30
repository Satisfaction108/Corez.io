// Discord admin /dust and /shoprotate: node scripts/test/adminCommands.test.js
//
//   gating    non-admins, the wrong guild and DMs are refused and audited,
//             and nothing changes
//   dust      banked gems reach a fake raid socket over the bus (bridge.js ->
//             adminGems.js): GEM resync + toast, audit row; not in a raid,
//             death screen, guests by name, same-name guests, bad amounts,
//             and a player on a second (Duos) server that the solo game
//             must not pay
//   shop      /shoprotate replaces today's row with a valid rotation
//             (both / featured / daily), audits it, and tells open menus
//             over SSE
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

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `admincmd-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-admincmd-test-'));
const DATA_DIR = path.join(ROOT, 'data');

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
const PUB_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const APP = '111111111111111111', GUILD = '222222222222222222', ADMIN = '333333333333333333', OTHER = '444444444444444444';

process.env.DATA_DIR = DATA_DIR;
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ROYALE_DEBUG', 'ACCOUNTS_ALLOW_DEBUG', 'DISCORD_BOT_TOKEN',
    'DISCORD_ANNOUNCE_CHANNEL_ID', 'DISCORD_BACKUP_CHANNEL_ID', 'SHOP_SEED_SALT']) delete process.env[k];
Object.assign(process.env, {
    NODE_ENV: 'test', ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'admincmd-test-secret-0123456789-abcdefghij',
    DISCORD_APP_ID: APP, DISCORD_PUBLIC_KEY: PUB_HEX, DISCORD_ADMIN_GUILD_ID: GUILD, ADMIN_DISCORD_IDS: ADMIN, PORT: '3000',
});

// the game side reads the global Config like the real game does
global.Config = { dig_royale: true, tutorial: false };

const accounts = require('../../server/accounts');
const bridge = require('../../server/accounts/game/bridge');
const store = require('../../server/accounts/store');
const C = require('../../shared/cosmetics.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const D = () => accounts.db.handle();
let seq = 0;
function mkUser(prefix = 'ad') {
    const r = accounts.users.create({ username: (prefix + '_' + (++seq) + '_' + Math.floor(Math.random() * 1e4)).slice(0, 16), recoveryHash: null });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user;
}

// ---- HTTP ----
let base = '', port = 0;
function sign(body, ts = String(Math.floor(Date.now() / 1000))) {
    return { ts, sig: nodeCrypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex') };
}
async function interact(obj) {
    const body = JSON.stringify(obj);
    const s = sign(body);
    const r = await fetch(base + '/discord/interactions', {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': s.sig, 'X-Signature-Timestamp': s.ts },
    });
    return { status: r.status, json: await r.json() };
}
function cmd(name, options = [], who = ADMIN, guild = GUILD) {
    return { type: 2, application_id: APP, guild_id: guild || undefined, member: { user: { id: who, username: 'tester' } }, data: { name, options } };
}
const o = (name, value, type = 3) => ({ name, type, value });
const content = r => r.json.data.content;

// ---- a fake raid server (the one bridge.init wires on this thread) ----
const manager = { clients: [] };
function mkSocket({ user = null, name, banked = 0, dead = false } = {}) {
    const s = { id: ++seq, account: user ? { id: user.id, publicId: user.public_id, username: user.username, blocked: new Set() } : null, packets: [], terminated: false, gemBanked: banked };
    s.talk = (type, ...args) => s.packets.push([type, ...args]);
    const body = { name: name || (user && user.username), socket: s, carriedGems: 40, gemCap: 4000, isDead: () => dead };
    s.player = { body };
    manager.clients.push(s);
    return s;
}
function inRaid(s) { accounts.bus.toMain({ t: 'join', userId: s.account.id, sid: s.id }); }
function drop(s) {
    manager.clients.splice(manager.clients.indexOf(s), 1);
    if (s.account) accounts.bus.toMain({ t: 'leave', userId: s.account.id, sid: s.id });
}
const packets = (s, t) => s.packets.filter(p => p[0] === t);
const audits = (action, extra = '', ...args) => D().all(`SELECT user_id, actor, detail FROM audit_log WHERE action = ? ${extra} ORDER BY id`, action, ...args)
    .map(a => ({ ...a, detail: JSON.parse(a.detail) }));

// ===================================================================

test('gating: non-admin, wrong guild and DM are refused, audited, and change nothing', async () => {
    global.servers = [{ id: 'br' }];
    const u = mkUser();
    const s = mkSocket({ user: u, banked: 100 });
    inRaid(s);
    const day = store.dayOf(Date.now());
    const rot = JSON.stringify(store.rotationFor(day));
    const before = audits('admin_denied').length;
    for (const [who, guild] of [[OTHER, GUILD], [ADMIN, '999999999999999999'], [ADMIN, null]]) {
        let r = await interact(cmd('dust', [o('player', u.username), o('amount', 500, 4)], who, guild));
        assert.equal(r.json.data.flags, 64);
        assert.match(content(r), /not allowed/);
        r = await interact(cmd('shoprotate', [], who, guild));
        assert.match(content(r), /not allowed/);
    }
    const denied = audits('admin_denied').slice(before);
    assert.equal(denied.length, 6);
    assert.deepEqual(denied.map(a => a.detail.command), ['dust', 'shoprotate', 'dust', 'shoprotate', 'dust', 'shoprotate']);
    assert.equal(s.gemBanked, 100);
    assert.equal(packets(s, 'GEM').length, 0);
    assert.equal(JSON.stringify(store.rotationFor(day)), rot);
    assert.equal(audits('admin_raid_gems', 'AND user_id = ?', u.id).length, 0);
    drop(s);
});

test('dust: an account in a raid gets banked gems, a GEM resync and a toast; audited', async () => {
    global.servers = [{ id: 'br' }];
    const u = mkUser();
    const s = mkSocket({ user: u, banked: 1200 });
    inRaid(s);
    const r = await interact(cmd('dust', [o('player', u.username), o('amount', 5000, 4), o('reason', 'stream giveaway')]));
    assert.equal(r.json.data.flags, 64);
    assert.match(content(r), /Sent 5,000 gems to/);
    assert.match(content(r), /Solo raid/);
    assert.match(content(r), /1,200 → 6,200/);
    assert.equal(s.gemBanked, 6200);
    assert.equal(s.player.body.bankedGems, 6200);
    const gem = packets(s, 'GEM');
    assert.equal(gem.length, 1);
    assert.equal(gem[0][4], 6200, 'GEM carries the new bank');
    assert.equal(gem[0][1], 40, 'carried untouched');
    assert.deepEqual(packets(s, 'm'), [['m', 6000, 'An admin sent you 5,000 gems.']]);
    const a = audits('admin_raid_gems', 'AND user_id = ?', u.id);
    assert.equal(a.length, 1);
    assert.equal(a[0].actor, 'admin:' + ADMIN);
    assert.equal(a[0].detail.delivered, true);
    assert.equal(a[0].detail.amount, 5000);
    assert.equal(a[0].detail.bankedAfter, 6200);
    assert.equal(a[0].detail.reason, 'stream giveaway');
    // gemdust is a different thing and stays put
    assert.equal(D().get('SELECT dust_milli FROM users WHERE id = ?', u.id).dust_milli, 0);
    drop(s);
});

test('dust: the gems come with as much growth (not board score), and the toast says so', async () => {
    global.servers = [{ id: 'br' }];
    const u = mkUser();
    const s = mkSocket({ user: u, banked: 0 });
    inRaid(s);
    // what dig_royale's addGrowth does: a growth-only bonus on the raid stat
    const stat = { score: 900, growBonus: 0 };
    global.royaleAddGrowth = (body, n) => { assert.equal(body, s.player.body); stat.growBonus += n; return stat.score + stat.growBonus; };
    try {
        const r = await interact(cmd('dust', [o('player', u.username), o('amount', 5000, 4)]));
        assert.match(content(r), /Sent 5,000 gems to/);
        assert.match(content(r), /grow as if they'd scored 5,000 more points \(growth score now 5,900\); board score unchanged/);
        assert.equal(stat.growBonus, 5000);
        assert.equal(stat.score, 900, 'the board score stays');
        assert.deepEqual(packets(s, 'm'), [['m', 6000, 'An admin sent you 5,000 gems. You grew!']]);
        const a = audits('admin_raid_gems', 'AND user_id = ?', u.id);
        assert.equal(a[0].detail.grew, true);
    } finally {
        delete global.royaleAddGrowth;
        drop(s);
    }
});

test('dust: offline, on the death screen, unknown names and bad amounts are refused', async () => {
    global.servers = [{ id: 'br' }];
    const u = mkUser();
    let r = await interact(cmd('dust', [o('player', u.username), o('amount', 10, 4)]));
    assert.match(content(r), /is not in a raid right now/);

    const s = mkSocket({ user: u, banked: 50, dead: true });
    inRaid(s);
    r = await interact(cmd('dust', [o('player', u.username), o('amount', 10, 4)]));
    assert.match(content(r), /death screen/);
    assert.equal(s.gemBanked, 50);

    r = await interact(cmd('dust', [o('player', 'nobody_here_xyz'), o('amount', 10, 4)]));
    assert.match(content(r), /nobody\\_here\\_xyz\*\* is not in a raid right now/);

    for (const bad of [0, -5, 1000001, 2.5]) {
        r = await interact(cmd('dust', [o('player', u.username), o('amount', bad, 4)]));
        assert.match(content(r), /whole number from 1 to 1,000,000/, String(bad));
    }
    assert.equal(s.gemBanked, 50);
    assert.equal(packets(s, 'GEM').length, 0);
    const a = audits('admin_raid_gems', 'AND user_id = ?', u.id);
    assert.deepEqual(a.map(x => x.detail.why), ['not_in_raid', 'dead', 'amount', 'amount', 'amount', 'amount']);
    assert.ok(a.every(x => x.detail.delivered === false && x.actor === 'admin:' + ADMIN));
    drop(s);
});

test('dust: guests by raid name; two guests with that name are refused', async () => {
    global.servers = [{ id: 'br' }];
    const g = mkSocket({ name: 'DiggyGuest', banked: 0 });
    let r = await interact(cmd('dust', [o('player', 'diggyguest'), o('amount', 750, 4)]));
    assert.match(content(r), /Sent 750 gems to \*\*DiggyGuest\*\* \(Solo raid, guest\)/);
    assert.equal(g.gemBanked, 750);
    assert.deepEqual(packets(g, 'm')[0], ['m', 6000, 'An admin sent you 750 gems.']);
    // a guest shown as ~name (it looks like an account's) matches the plain name
    const t = mkSocket({ name: '~Tilda', banked: 3 });
    r = await interact(cmd('dust', [o('player', 'Tilda'), o('amount', 7, 4)]));
    assert.match(content(r), /Sent 7 gems/);
    assert.equal(t.gemBanked, 10);

    const twin = mkSocket({ name: 'diggyGUEST', banked: 0 });
    r = await interact(cmd('dust', [o('player', 'DiggyGuest'), o('amount', 5, 4)]));
    assert.match(content(r), /2 players in raids are called/);
    assert.equal(g.gemBanked, 750);
    assert.equal(twin.gemBanked, 0);
    const a = audits('admin_raid_gems', "AND user_id IS NULL AND json_extract(detail, '$.query') = 'DiggyGuest'");
    assert.equal(a[a.length - 1].detail.why, 'ambiguous');
    assert.equal(a[a.length - 1].detail.guest, true);
    for (const s of [g, t, twin]) drop(s);
});

test('dust: a player on the Duos server is paid there, not by the solo game', async () => {
    global.servers = [{ id: 'br' }, { id: 'duo' }];
    const duoPaid = [];
    // the duo worker: its replies come back labelled 'duo' like server.js does
    const unsub = accounts.bus.onGame(m => {
        if (!m || m.name !== 'DuoGuy') return;
        if (m.t === 'adminGemsFind') {
            setTimeout(() => accounts.bus.fromGame('duo', { t: 'adminGemsFound', reqId: m.reqId, server: 'duo-token', alive: 1, dead: 0, name: 'DuoGuy', banked: 20 }), 20);
        } else if (m.t === 'adminGemsGive' && m.server === 'duo-token') {
            duoPaid.push(m.amount);
            setTimeout(() => accounts.bus.fromGame('duo', { t: 'adminGemsGiven', reqId: m.reqId, server: 'duo-token', ok: true, name: 'DuoGuy', before: 20, after: 20 + m.amount }), 20);
        }
    });
    const solo = mkSocket({ name: 'SoloGuy', banked: 0 });
    const t0 = Date.now();
    const r = await interact(cmd('dust', [o('player', 'DuoGuy'), o('amount', 300, 4)]));
    unsub();
    assert.match(content(r), /Sent 300 gems to \*\*DuoGuy\*\* \(Duos raid, guest\)\. Banked 20 → 320/);
    assert.deepEqual(duoPaid, [300]);
    assert.equal(solo.gemBanked, 0);
    assert.equal(packets(solo, 'm').length, 0);
    assert.ok(Date.now() - t0 < 900, 'both servers answered, so no timeout wait');
    drop(solo);
});

// ---- shop ----

function assertValid(rot, day) {
    const all = rot.featured.concat(rot.daily);
    assert.equal(rot.featured.length, 2);
    assert.equal(rot.daily.length, 8);
    assert.equal(new Set(all).size, all.length, 'no duplicates');
    const recent = new Set();
    for (let k = 1; k <= 2; k++) for (const id of store.readRotation(day - k).featured) recent.add(id);
    for (const id of rot.featured) {
        const it = C.byId(id);
        assert.ok(it && ['epic', 'legendary'].includes(it.rarity), id);
        assert.ok(!recent.has(id), 'featured on one of the last 2 days: ' + id);
    }
    let skins = 0;
    for (const id of rot.daily) {
        const it = C.byId(id);
        assert.ok(it && ['common', 'uncommon', 'rare'].includes(it.rarity), id);
        if (it.cat === 'skin') skins++;
    }
    assert.ok(skins <= 4, 'at most 4 skins');
    for (const id of all) {
        const it = C.byId(id);
        assert.ok(!it.exclusive && !it.permanent && !it.retired, id);
    }
}

function sse(cookie) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Cookie: cookie } }, res => {
            if (res.statusCode !== 200) return reject(new Error('sse status ' + res.statusCode));
            let buf = '';
            const got = [];
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buf += chunk;
                let k;
                while ((k = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, k);
                    buf = buf.slice(k + 2);
                    const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
                    if (ev && data) got.push({ event: ev[1], data: JSON.parse(data[1]) });
                }
            });
            resolve({
                wait: async (type, ms = 3000) => {
                    const end = Date.now() + ms;
                    while (Date.now() < end) {
                        const f = got.find(x => x.event === type);
                        if (f) return f.data;
                        await new Promise(r => setTimeout(r, 10));
                    }
                    throw new Error('no ' + type + ' event');
                },
                close: () => req.destroy(),
            });
        });
        req.on('error', reject);
    });
}

test('shoprotate: re-rolls today (both, featured, daily) under the rotation rules; audit + SSE', async () => {
    const now = Date.now();
    const day = store.dayOf(now);
    const first = store.rotationFor(day);
    const u = mkUser();
    const stream = await sse(accounts.config.cookies.session + '=' + accounts.sessions.create(u.id, { now }).token);
    await stream.wait('hello');

    let r = await interact(cmd('shoprotate', []));
    assert.equal(r.json.data.flags, 64);
    assert.match(content(r), /Re-rolled today's Featured and Daily/);
    assert.match(content(r), /Refreshed 1 open menu\./);
    const both = store.readRotation(day);
    assertValid(both, day);
    assert.equal(D().get('SELECT count(*) AS n FROM shop_rotations WHERE day = ?', day).n, 1, 'one row, replaced');
    assert.notDeepEqual(both, first);
    // the catalog is big enough that nothing that was up stays up
    for (const id of both.featured.concat(both.daily)) assert.ok(!first.featured.includes(id) && !first.daily.includes(id), id);
    for (const id of both.featured) assert.ok(content(r).includes(C.byId(id).name.replace(/([\\`*_~|>#[\]()<:@-])/g, '\\$1')), id);
    assert.deepEqual(await stream.wait('shopRotated'), { day, resetsAt: store.resetsAt(day) });
    stream.close();

    // the store API sells the new rotation, not the old one
    const view = store.storeView(D().get('SELECT * FROM users WHERE id = ?', u.id), now);
    assert.deepEqual(view.featured.map(x => x.id), both.featured);

    r = await interact(cmd('shoprotate', [o('which', 'featured')]));
    assert.match(content(r), /Re-rolled today's Featured\./);
    const feat = store.readRotation(day);
    assertValid(feat, day);
    assert.deepEqual(feat.daily, both.daily, 'daily kept');
    assert.notDeepEqual(feat.featured, both.featured);

    r = await interact(cmd('shoprotate', [o('which', 'daily')]));
    const daily = store.readRotation(day);
    assertValid(daily, day);
    assert.deepEqual(daily.featured, feat.featured, 'featured kept');
    assert.notDeepEqual(daily.daily, feat.daily);

    const a = audits('admin_shop_rotate');
    assert.equal(a.length, 3);
    assert.ok(a.every(x => x.actor === 'admin:' + ADMIN && x.detail.day === day));
    assert.deepEqual(a.map(x => x.detail.which), ['both', 'featured', 'daily']);
    assert.deepEqual(a[0].detail.before, { featured: first.featured, daily: first.daily });
    assert.deepEqual(a[2].detail.daily, daily.daily);

    // tomorrow's skip rule sees today's new Featured
    const tomorrow = store.rotationFor(day + 1);
    for (const id of tomorrow.featured) assert.ok(!daily.featured.includes(id), id);
});

test('shoprotate: many re-rolls stay valid; the same salt gives the same draw', () => {
    const day = store.dayOf(Date.now());
    for (let k = 0; k < 40; k++) {
        store.reroll(day, ['both', 'featured', 'daily'][k % 3]);
        assertValid(store.readRotation(day), day);
    }
    const cur = store.readRotation(day);
    const a = store.generate(day, [], 'x:reroll:abc', cur.featured.concat(cur.daily));
    const b = store.generate(day, [], 'x:reroll:abc', cur.featured.concat(cur.daily));
    assert.deepEqual(a, b);
    // no avoid list: the plain daily draw is unchanged by the new parameter
    assert.deepEqual(store.generate(day - 30, []), store.generate(day - 30, [], undefined, []));
});

// ===================================================================

async function main() {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...args) => { if (!/^\[(accounts|backup|discord)\]/.test(String(args[0]))) quietLog(...args); };
    console.warn = (...args) => { if (!/^\[(accounts|backup|discord)\]/.test(String(args[0]))) quietWarn(...args); };
    assert.equal(accounts.initMain(), true, 'initMain');
    bridge.init(manager);
    const server = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    base = `http://127.0.0.1:${port}`;
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
