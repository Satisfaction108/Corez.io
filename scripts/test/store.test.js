// Item Shop / Locker tests (Phase 3): node scripts/test/store.test.js
//
// Focused on the store logic (server/accounts/store.js + shared/cosmetics.js)
// against a throwaway database, plus one bare-HTTP check of the route
// wiring. No game server. Data goes under $DATA_DIR if set, otherwise the
// OS temp dir; it is removed when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `store-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-store-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
delete process.env.DB_PATH;
delete process.env.PUBLIC_HOST;
delete process.env.PUBLIC_ORIGIN;
delete process.env.ALLOWED_ORIGINS;
delete process.env.SHOP_SEED_SALT;
process.env.NODE_ENV = 'test';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'store-test-secret-0123456789-abcdefghijklmnop';

const C = require('../../shared/cosmetics.js');
const accounts = require('../../server/accounts');
const store = require('../../server/accounts/store');
const users = accounts.users;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TODAY = 20720;                       // a fixed UTC day
const NOW = TODAY * DAY + 5 * HOUR;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const d = () => accounts.db.handle();

let seq = 0;
function mkUser(dustMilli = 0) {
    const r = users.create({ username: 'buyer' + (++seq) + 'x', recoveryHash: null, now: NOW - 10 * DAY });
    assert.ok(r.ok, 'user created');
    d().run('UPDATE users SET dust_milli = ? WHERE id = ?', dustMilli, r.user.id);
    return users.byId(r.user.id);
}
function befriend(a, b, at) {
    d().run('INSERT INTO friendships (user_lo, user_hi, created_at) VALUES (?, ?, ?)', Math.min(a.id, b.id), Math.max(a.id, b.id), at);
}
let keyN = 0;
const key = () => 'test-key-' + (++keyN).toString().padStart(4, '0');
function code(fn) {
    try { fn(); } catch (e) { return e.status + ':' + e.code; }
    return 'ok';
}
const count = (sql, ...p) => d().get(sql, ...p).n;
const balance = u => d().get('SELECT dust_milli FROM users WHERE id = ?', u.id).dust_milli;
const today = () => store.rotationFor(TODAY, 2, NOW);

// ---- catalog ----

test('catalog: unique ids/nids, cats, prices from the plan, colour stops readable', () => {
    assert.equal(new Set(C.ITEMS.map(i => i.id)).size, C.ITEMS.length);
    assert.equal(new Set(C.ITEMS.map(i => i.nid)).size, C.ITEMS.length);
    for (const it of C.ITEMS) {
        assert.ok(it.nid > 0 && C.isCat(it.cat) && C.RARITIES[it.rarity], it.id);
        assert.equal(C.byId(it.id), it);
        assert.equal(C.byNid(it.nid), it);
        if (it.style && it.style.stops) for (const s of it.style.stops) assert.ok(C.isColorAllowed(s), it.id + ' ' + s);
        if (it.skin) assert.ok(it.skin.pattern && it.skin.accent && it.skin.altAccent, it.id);
    }
    const price = id => C.byId(id).price;
    assert.equal(price('ns_custom'), 8000);
    assert.equal(price('ns_sunset'), 25000);
    assert.equal(price('ns_prism_shard'), 250000);
    assert.equal(price('sk_hazard_stripes'), 35000);
    assert.equal(price('sk_molten_core'), 500000);
    assert.deepEqual(C.byId('ns_sunset').style.stops, ['#ffb347', '#ff6a5c', '#c850c0']);
    // 39 for sale, the invite reward, and 4 achievement rewards (shared/achievements.js `item`)
    assert.equal(C.ITEMS.filter(i => i.cat === 'nameStyle').length, 44);
    assert.deepEqual(C.ITEMS.filter(i => i.earn).map(i => i.id), ['ns_corebreaker', 'ns_crownkeeper', 'ns_bedrock', 'ns_olive']);
    assert.equal(C.ITEMS.filter(i => i.cat === 'nameStyle' && !i.exclusive).length, 39);
    assert.equal(C.ITEMS.filter(i => i.cat === 'skin').length, 40);
    // every rarity is stocked in both categories, and wire numbers stay in range
    for (const cat of C.CATS) for (const r of C.RARITY_ORDER) assert.ok(C.ITEMS.some(i => i.cat === cat && i.rarity === r), cat + ' ' + r);
    const NIDS = { nameStyle: [1, 99], skin: [101, 199], sidekick: [201, 299], sdSkin: [301, 399], sdName: [401, 499] };
    for (const it of C.ITEMS) assert.ok(it.nid >= NIDS[it.cat][0] && it.nid <= NIDS[it.cat][1], it.id);
    // the items people already own keep their ids and wire numbers
    const kept = { ns_sunset: 2, ns_copper_vein: 3, ns_glacier: 4, ns_candy: 5, ns_mint_rush: 6, ns_ember: 7, ns_amethyst: 8, ns_toxic: 9,
        ns_magma_flow: 10, ns_aurora: 11, ns_emerald_crown: 12, ns_prism_shard: 13, ns_ringleader: 14,
        sk_hazard_stripes: 101, sk_riveted_plate: 102, sk_cave_camo: 103, sk_strata: 104, sk_hex_armor: 105, sk_drill_circuit: 106,
        sk_crystal_facets: 107, sk_gold_vein: 108, sk_lava_cracks: 109, sk_permafrost: 110, sk_emerald_heart: 111, sk_molten_core: 112 };
    for (const [id, nid] of Object.entries(kept)) assert.equal(C.byId(id) && C.byId(id).nid, nid, id);
    // prices sit on the ladder for their rarity; exclusives are free and unsold
    const ladder = { nameStyle: { common: [8, 35], uncommon: [40, 45], rare: [50, 65], epic: [110, 125], legendary: [240, 250] },
        skin: { common: [30, 35], uncommon: [60, 75], rare: [110, 140], epic: [240, 260], legendary: [450, 500] },
        sidekick: { common: [20, 50], uncommon: [75, 95], rare: [130, 160], epic: [260, 300], legendary: [500, 650] },
        sdSkin: { common: [20, 25], uncommon: [40, 45], rare: [70, 75], epic: [140, 140], legendary: [260, 260] },
        sdName: { common: [15, 15], uncommon: [25, 25], rare: [40, 40], epic: [80, 80], legendary: [160, 160] } };
    for (const it of C.ITEMS) {
        if (it.exclusive) { assert.equal(it.price, 0, it.id); continue; }
        const [lo, hi] = ladder[it.cat][it.rarity], d = it.price / C.MILLI;
        assert.ok(d >= lo && d <= hi, it.id + ' ' + d);
    }
    // name outlines stay dark enough to frame the fill on any background
    for (const it of C.ITEMS) if (it.style && it.style.rim) assert.ok(C.luminance(it.style.rim) < 0.05, it.id + ' rim');
    assert.equal(C.byNid(0), null);
});

test('catalog: isColorAllowed (format + WCAG luminance >= 0.137)', () => {
    assert.equal(C.isColorAllowed('#ffffff'), true);
    assert.equal(C.isColorAllowed('#ff6a5c'), true);
    assert.equal(C.isColorAllowed('#000000'), false);
    assert.equal(C.isColorAllowed('#1e1d1b'), false);
    assert.equal(C.isColorAllowed('#3a3a3a'), false);
    assert.equal(C.isColorAllowed('#FFFFFF'), false, 'lowercase only');
    assert.equal(C.isColorAllowed('fff'), false);
    assert.equal(C.isColorAllowed('#ffffff; x'), false);
    assert.ok(C.contrast('#777777', C.FLOOR_COLOR) >= 3 === C.isColorAllowed('#777777'));
});

// ---- rotation ----

test('rotation: deterministic, 2 featured epic/legendary + 8 daily (<= 4 skins), no permanents', () => {
    assert.deepEqual(store.generate(123, []), store.generate(123, []));
    assert.notDeepEqual(store.generate(123, [], 'a'), store.generate(123, [], 'b'));
    for (let day = 0; day < 400; day++) {
        const g = store.generate(day, []);
        assert.equal(g.featured.length, 2);
        assert.equal(g.daily.length, 8);
        assert.equal(new Set([...g.featured, ...g.daily]).size, 10);
        for (const id of g.featured) assert.ok(['epic', 'legendary'].includes(C.byId(id).rarity));
        for (const id of g.daily) assert.ok(['common', 'uncommon', 'rare'].includes(C.byId(id).rarity));
        assert.ok(g.daily.filter(id => C.byId(id).cat === 'skin').length <= 4);
        assert.ok(![...g.featured, ...g.daily].includes('ns_custom'));
    }
    // epic is drawn about twice as often as legendary per item
    const hits = { epic: 0, legendary: 0 };
    for (let day = 0; day < 3000; day++) for (const id of store.generate(day, []).featured) hits[C.byId(id).rarity]++;
    assert.ok(hits.epic > hits.legendary * 1.2, JSON.stringify(hits));
});

test('rotation: every item for sale turns up within a season', () => {
    const seen = new Set();
    // from Oct 6 2026, after Jack's Raid Night hold
    const from = Math.ceil(Date.UTC(2026, 9, 6) / 864e5);
    for (let day = from; day < from + 120; day++) {
        const g = store.generate(day, []);
        g.featured.forEach(id => seen.add(id)); g.daily.forEach(id => seen.add(id));
        store.generateSidekicks(day).forEach(id => seen.add(id));
    }
    const missing = C.ITEMS.filter(it => !it.permanent && !it.exclusive && !it.retired && !seen.has(it.id)).map(it => it.id);
    assert.deepEqual(missing, []);
});

test('catalog: skin accents swap off a team colour they would vanish into', () => {
    const it = C.byId('sk_sapphire');
    assert.equal(C.accentFor(it, '#3d7cf0'), it.skin.altAccent, 'blue on blue');
    assert.equal(C.accentFor(it, '#ff6c6e'), it.skin.accent);
    assert.equal(C.accentFor(C.byId('sk_sash'), '#3d7cf0'), '#ff5a5f', 'red reads fine on blue');
    assert.equal(C.accent2For(C.byId('sk_lava_cracks'), '#ec7b0f'), C.byId('sk_lava_cracks').skin.alt2);
    assert.equal(C.accent2For(C.byId('sk_racer'), '#3d7cf0'), null);
});

test('rotation: persisted per day, and skips items featured in the previous 2 days', () => {
    const start = TODAY - 60;
    for (let day = start; day <= TODAY; day++) {
        const r = store.rotationFor(day, 2, NOW);
        if (day >= start + 2) {
            const prev = [...store.readRotation(day - 1).featured, ...store.readRotation(day - 2).featured];
            for (const id of r.featured) assert.ok(!prev.includes(id), `day ${day} repeats ${id}`);
        }
    }
    // a stored rotation never changes, even if the salt does
    const before = store.readRotation(TODAY);
    const salt = accounts.config.shopSeedSalt;
    accounts.config.shopSeedSalt = 'something-else';
    try { assert.deepEqual(store.rotationFor(TODAY, 2, NOW), before); } finally { accounts.config.shopSeedSalt = salt; }
    assert.equal(count('SELECT COUNT(*) AS n FROM shop_rotations WHERE day = ?', TODAY), 1);
});

// ---- purchase ----

test('purchase: 402 when short (nothing written), then charges once per idempotency key', () => {
    const u = mkUser(1000);
    const id = today().daily[0];
    const item = C.byId(id);
    assert.equal(code(() => store.purchase(u.id, { itemId: id, day: TODAY, idempotencyKey: key() }, { now: NOW })), '402:insufficient_dust');
    assert.equal(count('SELECT COUNT(*) AS n FROM purchases WHERE user_id = ?', u.id), 0);
    assert.equal(balance(u), 1000);

    d().run('UPDATE users SET dust_milli = ? WHERE id = ?', item.price + 500, u.id);
    const k = key();
    const r1 = store.purchase(u.id, { itemId: id, day: TODAY, idempotencyKey: k }, { now: NOW });
    assert.equal(r1.balanceMilli, 500);
    const r2 = store.purchase(u.id, { itemId: id, day: TODAY, idempotencyKey: k }, { now: NOW + 1000 });
    assert.equal(r2.replayed, true);
    assert.equal(r2.purchaseId, r1.purchaseId);
    assert.equal(balance(u), 500, 'charged once');
    assert.equal(count('SELECT COUNT(*) AS n FROM purchases WHERE user_id = ?', u.id), 1);
    assert.equal(count('SELECT COUNT(*) AS n FROM owned_items WHERE user_id = ? AND item_id = ? AND source = ?', u.id, id, 'purchase'), 1);
    const led = d().get("SELECT * FROM dust_ledger WHERE user_id = ? AND kind = 'purchase'", u.id);
    assert.equal(led.delta_milli, -item.price);
    assert.equal(led.balance_milli, 500);
    assert.equal(count("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = 'store_purchase'", u.id), 1);

    // same key, different item -> conflict; new key, same item -> already owned
    assert.equal(code(() => store.purchase(u.id, { itemId: today().daily[1], day: TODAY, idempotencyKey: k }, { now: NOW })), '409:idempotency_conflict');
    d().run('UPDATE users SET dust_milli = 10000000 WHERE id = ?', u.id);
    assert.equal(code(() => store.purchase(u.id, { itemId: id, day: TODAY, idempotencyKey: key() }, { now: NOW })), '409:already_owned');
    assert.equal(code(() => store.purchase(u.id, { itemId: id, day: TODAY, idempotencyKey: 'short' }, { now: NOW })), '400:bad_idempotency_key');
    assert.equal(code(() => store.purchase(u.id, { itemId: 'nope', day: TODAY, idempotencyKey: key() }, { now: NOW })), '404:unknown_item');
});

test('purchase: rotation check (today, yesterday within 120 s of reset, permanent any day)', () => {
    const u = mkUser(10000000);
    const rot = today();
    const offered = new Set([...rot.featured, ...rot.daily]);
    const notOffered = C.ITEMS.find(it => !it.permanent && !offered.has(it.id));
    assert.equal(code(() => store.purchase(u.id, { itemId: notOffered.id, day: TODAY, idempotencyKey: key() }, { now: NOW })), '409:not_in_shop');
    assert.equal(code(() => store.purchase(u.id, { itemId: rot.featured[0], day: TODAY - 3, idempotencyKey: key() }, { now: NOW })), '409:shop_rotated');

    // yesterday's shop still sells for 120 s after the reset
    const yday = store.rotationFor(TODAY - 1, 2, NOW);
    const yItem = yday.daily.find(id => !offered.has(id)) || yday.daily[0];
    const reset = TODAY * DAY;
    assert.equal(code(() => store.purchase(u.id, { itemId: yItem, day: TODAY - 1, idempotencyKey: key() }, { now: reset + 121 * 1000 })), '409:shop_rotated');
    assert.equal(code(() => store.purchase(u.id, { itemId: yItem, day: TODAY - 1, idempotencyKey: key() }, { now: reset + 60 * 1000 })), 'ok');

    // Custom Color: permanent, any day value, a colour is validated and stored
    assert.equal(code(() => store.purchase(u.id, { itemId: 'ns_custom', day: null, idempotencyKey: key(), color: '#101010' }, { now: NOW })), '400:bad_color');
    assert.equal(code(() => store.purchase(u.id, { itemId: 'ns_custom', day: null, idempotencyKey: key(), color: '#FF8800' }, { now: NOW })), 'ok');
    assert.equal(users.byId(u.id).custom_color, '#ff8800');
});

// ---- refund ----

test('refund: returns dust, uses a token, removes + unequips; rules on time, gifts, tokens', () => {
    const u = mkUser(10000000);
    const skin = today().daily.find(id => C.byId(id).cat === 'skin') || today().featured[0];
    const item = C.byId(skin);
    const p = store.purchase(u.id, { itemId: skin, day: TODAY, idempotencyKey: key() }, { now: NOW });
    store.equip(u.id, item.cat, skin, null);
    assert.equal(store.cosmeticsFor(users.byId(u.id))[item.cat === 'skin' ? 'skinNid' : 'nameStyleNid'], item.nid);

    const r = store.refund(u.id, p.purchaseId, { now: NOW + HOUR });
    assert.equal(r.balanceMilli, 10000000);
    assert.equal(r.refundTokens, 2);
    assert.equal(r.equipped[item.cat], null);
    assert.equal(store.owns(u.id, skin), false);
    assert.equal(store.cosmeticsFor(users.byId(u.id)).skinNid, 0);
    assert.equal(d().get("SELECT delta_milli FROM dust_ledger WHERE user_id = ? AND kind = 'refund'", u.id).delta_milli, item.price);
    assert.equal(code(() => store.refund(u.id, p.purchaseId, { now: NOW + HOUR })), '409:already_refunded');

    // 24 h window
    const p2 = store.purchase(u.id, { itemId: today().daily[0] === skin ? today().daily[1] : today().daily[0], day: TODAY, idempotencyKey: key() }, { now: NOW });
    assert.equal(code(() => store.refund(u.id, p2.purchaseId, { now: NOW + 24 * HOUR })), '409:refund_expired');
    // someone else's purchase
    const other = mkUser(0);
    assert.equal(code(() => store.refund(other.id, p2.purchaseId, { now: NOW })), '404:not_found');
    // out of tokens
    d().run('UPDATE users SET refund_tokens = 0 WHERE id = ?', u.id);
    assert.equal(code(() => store.refund(u.id, p2.purchaseId, { now: NOW + HOUR })), '409:no_refund_tokens');
    assert.equal(store.owns(u.id, p2.itemId), true, 'nothing changed');
});

// ---- gifts ----

test('gift: friends >= 48 h, no blocks, recipient must not own, 5 a day, preset 0-3, not refundable', () => {
    const a = mkUser(10000000), b = mkUser(0), c = mkUser(0);
    const id = today().featured[0];
    const g = (to, extra = {}) => store.gift(a.id, { itemId: id, day: TODAY, toUserId: to.public_id, idempotencyKey: key(), preset: 1, ...extra }, { now: NOW });

    assert.equal(code(() => g(b)), '403:not_friends');
    befriend(a, b, NOW - 47 * HOUR);
    assert.equal(code(() => g(b)), '403:friends_too_new');
    d().run('UPDATE friendships SET created_at = ? WHERE user_lo = ? AND user_hi = ?', NOW - 49 * HOUR, Math.min(a.id, b.id), Math.max(a.id, b.id));
    d().run('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', b.id, a.id, NOW);
    assert.equal(code(() => g(b)), '403:not_friends', 'blocked looks like not friends');
    d().run('DELETE FROM blocks WHERE blocker_id = ?', b.id);
    assert.equal(code(() => g(b, { preset: 4 })), '400:bad_preset');
    assert.equal(code(() => g(a)), '400:self_gift');

    const before = balance(a);
    const r = g(b);
    assert.equal(r.to.userId, b.public_id);
    assert.equal(balance(a), before - C.byId(id).price);
    assert.equal(d().get('SELECT source FROM owned_items WHERE user_id = ? AND item_id = ?', b.id, id).source, 'gift');
    assert.equal(store.owns(a.id, id), false, 'the sender does not get it');
    assert.equal(code(() => g(b)), '409:recipient_owns');
    assert.equal(code(() => store.refund(a.id, r.purchaseId, { now: NOW })), '409:gift_not_refundable');

    // history on both sides
    const hb = store.history(b.id, NOW).entries.find(e => e.purchaseId === r.purchaseId);
    assert.equal(hb.direction, 'received');
    assert.equal(hb.from.userId, a.public_id);
    assert.equal(hb.price, 0);
    const ha = store.history(a.id, NOW).entries.find(e => e.purchaseId === r.purchaseId);
    assert.equal(ha.direction, 'sent');
    assert.equal(ha.refundable, false);

    // daily cap: 4 more distinct items to c, then the 6th fails
    befriend(a, c, NOW - 10 * DAY);
    const ids = [...today().daily, today().featured[1]];
    for (let i = 0; i < 4; i++) store.gift(a.id, { itemId: ids[i], day: TODAY, toUserId: c.public_id, idempotencyKey: key(), preset: 0 }, { now: NOW });
    assert.equal(code(() => store.gift(a.id, { itemId: ids[4], day: TODAY, toUserId: c.public_id, idempotencyKey: key(), preset: 0 }, { now: NOW })), '429:gift_limit');
    assert.equal(store.storeView(users.byId(a.id), NOW).giftsLeft, 0);
    // next day the cap resets
    assert.equal(store.storeView(users.byId(a.id), NOW + DAY).giftsLeft, 5);
});

// ---- locker ----

test('equip: owned only, right slot, custom colour rule; cosmeticsFor feeds the game', () => {
    const u = mkUser(10000000);
    const style = today().daily.find(id => C.byId(id).cat === 'nameStyle') || today().featured.find(id => C.byId(id).cat === 'nameStyle');
    assert.equal(code(() => store.equip(u.id, 'nameStyle', style, null)), '403:not_owned');
    assert.equal(code(() => store.equip(u.id, 'hat', null, null)), '400:bad_slot');
    store.purchase(u.id, { itemId: style, day: TODAY, idempotencyKey: key() }, { now: NOW });
    assert.equal(code(() => store.equip(u.id, 'skin', style, null)), '400:bad_item');
    assert.equal(store.equip(u.id, 'nameStyle', style, null).equipped.nameStyle, style);
    let cos = store.cosmeticsFor(users.byId(u.id));
    assert.deepEqual(cos, { nameStyleNid: C.byId(style).nid, skinNid: 0, nameColor: null });

    // Custom Color needs a readable colour
    store.purchase(u.id, { itemId: 'ns_custom', day: TODAY, idempotencyKey: key() }, { now: NOW });
    assert.equal(code(() => store.equip(u.id, 'nameStyle', 'ns_custom', null)), '400:color_required');
    assert.equal(code(() => store.equip(u.id, 'nameStyle', 'ns_custom', '#202020')), '400:bad_color');
    const eq = store.equip(u.id, 'nameStyle', 'ns_custom', '#7FDBFF').equipped;
    assert.deepEqual({ nameStyle: eq.nameStyle, skin: eq.skin, customColor: eq.customColor }, { nameStyle: 'ns_custom', skin: null, customColor: '#7fdbff' });
    cos = store.cosmeticsFor(users.byId(u.id));
    assert.deepEqual(cos, { nameStyleNid: C.byId('ns_custom').nid, skinNid: 0, nameColor: '#7fdbff' });
    assert.equal(users.toPublic(users.byId(u.id)).equipped.nameStyle, 'ns_custom', '/api/me reads the columns');

    // unequip; an equipped id that is not owned is ignored by the game
    assert.equal(store.equip(u.id, 'nameStyle', null, null).equipped.nameStyle, null);
    d().run("UPDATE users SET equip_skin = 'sk_molten_core' WHERE id = ?", u.id);
    assert.equal(store.cosmeticsFor(users.byId(u.id)).skinNid, 0);
    const lk = store.lockerView(users.byId(u.id));
    assert.equal(lk.owned.length, 2);
    assert.equal(lk.equipped.skin, null);
    assert.ok(lk.owned.every(o => o.owned && o.nid && o.acquiredAt));
});

test('storeView: shape, owned flags, balance', () => {
    const u = mkUser(123456);
    const id = today().featured[1];
    d().run('UPDATE users SET dust_milli = 1000000 WHERE id = ?', u.id);
    store.purchase(u.id, { itemId: id, day: TODAY, idempotencyKey: key() }, { now: NOW });
    const v = store.storeView(users.byId(u.id), NOW);
    assert.equal(v.day, TODAY);
    assert.equal(v.resetsAt, (TODAY + 1) * DAY);
    assert.equal(v.featured.length, 2);
    assert.equal(v.daily.length, 8);
    assert.deepEqual(v.permanent.map(i => i.id), ['ns_custom', 'sd_buddy']);
    assert.equal(v.featured.find(i => i.id === id).owned, true);
    assert.equal(v.balanceMilli, 1000000 - C.byId(id).price);
    assert.equal(v.balance, v.balanceMilli / 1000);
    assert.equal(v.refundTokens, 3);
    const any = v.daily[0];
    assert.ok(any.name && any.rarity && any.nid && any.price && (any.style || any.skin) && typeof any.owned === 'boolean');
});

test('http: guests get 401 on store/locker routes; /shared/cosmetics.js is served', async () => {
    const server = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(418); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        for (const p of ['/api/store', '/api/store/history', '/api/locker']) {
            const r = await fetch(base + p);
            assert.equal(r.status, 401, p);
        }
        const r = await fetch(base + '/api/store/purchase', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:' + server.address().port },
            body: JSON.stringify({ itemId: 'ns_custom', idempotencyKey: 'abcdefgh' }),
        });
        assert.equal(r.status, 401);
        const js = await fetch(base + '/shared/cosmetics.js');
        assert.equal(js.status, 200);
        assert.match(await js.text(), /DWCosmetics/);
    } finally {
        server.close();
    }
});

async function main() {
    const log = console.log, warn = console.warn;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) log(...a); };
    console.warn = (...a) => { if (!String(a[0]).startsWith('[accounts]')) warn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        const started = Date.now();
        try {
            await t.fn();
            log(`ok   ${t.name} (${Date.now() - started} ms)`);
        } catch (e) {
            failed++;
            log(`FAIL ${t.name}\n     ${((e && e.stack) || e).toString().split('\n').slice(0, 6).join('\n     ')}`);
        }
    }
    accounts.shutdown();
    log(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else log('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
