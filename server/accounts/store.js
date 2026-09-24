// Item Shop and Locker: the database side.
//
// Rotation: one row per UTC day in shop_rotations, generated on first use
// from mulberry32(fnv1a(SHOP_SEED_SALT + day)) and never recomputed, so a
// rotation is fixed once anyone has seen it. 2 Featured (Epic/Legendary,
// Epic weighted 2:1) + 4 Daily (Common/Uncommon/Rare, at most 2 skins);
// items Featured on either of the previous 2 days are skipped. Permanent
// items (Custom Color) are always for sale.
//
// Every money move runs in one db.tx (BEGIN IMMEDIATE): idempotency replay,
// offer check, ownership, the conditional balance UPDATE (402 if short),
// then purchases + owned_items + dust_ledger + audit_log rows. Errors are
// thrown as HttpError from inside the transaction, which rolls it back.
//
// Prices and results are milli-dust internally; responses carry both
// milli (`...Milli`) and dust units, like /api/me's `dust`.
'use strict';

const db = require('./db');
const config = require('./config');
const users = require('./users');
const { HttpError } = require('./http');
const C = require('../../shared/cosmetics.js');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const RESET_GRACE_MS = 120 * 1000;       // yesterday's rotation still sells this long after reset
const REFUND_WINDOW_MS = 24 * HOUR;
const GIFT_FRIEND_AGE_MS = 48 * HOUR;
const GIFTS_PER_DAY = 5;
const GIFT_PRESETS = 4;                  // preset message index 0..3 (the client owns the wording)
const FEATURED_COUNT = 2;
const DAILY_COUNT = 4;
const DAILY_MAX_SKINS = 2;
const FEATURED_SKIP_DAYS = 2;
const FEATURED_WEIGHT = { epic: 2, legendary: 1 };
const DAILY_RARITIES = new Set(['common', 'uncommon', 'rare']);
const HISTORY_LIMIT = 50;
const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;

function h() { return db.handle(); }
function dayOf(ms) { return Math.floor(ms / DAY); }
function resetsAt(day) { return (day + 1) * DAY; }
function fail(status, code, message, extra) { throw new HttpError(status, code, message, extra); }

// ---- deterministic rotation ----

function fnv1a(str) {
    let hsh = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        hsh ^= s.charCodeAt(i);
        hsh = Math.imul(hsh, 0x01000193);
    }
    return hsh >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function sellable(it) { return !it.retired && !it.permanent; }

// Weighted draw without replacement. items in catalog order, so the result
// only depends on the seed.
function drawWeighted(rand, pool, n, weightOf) {
    const left = pool.slice(), out = [];
    while (out.length < n && left.length) {
        const total = left.reduce((s, it) => s + weightOf(it), 0);
        let r = rand() * total, i = 0;
        for (; i < left.length - 1; i++) {
            r -= weightOf(left[i]);
            if (r < 0) break;
        }
        out.push(left.splice(i, 1)[0]);
    }
    return out;
}

// Pure: the rotation for `day`, given the ids Featured on the previous days.
// -> {featured:[ids], daily:[ids]}
function generate(day, recentFeatured = [], salt = config.shopSeedSalt) {
    const rand = mulberry32(fnv1a(String(salt) + day));
    const skip = new Set(recentFeatured);
    const fPool = C.ITEMS.filter(it => sellable(it) && FEATURED_WEIGHT[it.rarity]);
    let pool = fPool.filter(it => !skip.has(it.id));
    if (pool.length < FEATURED_COUNT) pool = fPool;   // catalog too small to skip: never show an empty slot
    const featured = drawWeighted(rand, pool, FEATURED_COUNT, it => FEATURED_WEIGHT[it.rarity]);

    const dPool = C.ITEMS.filter(it => sellable(it) && DAILY_RARITIES.has(it.rarity));
    const daily = [];
    let skins = 0;
    const left = dPool.slice();
    while (daily.length < DAILY_COUNT && left.length) {
        const i = Math.floor(rand() * left.length);
        const it = left.splice(i, 1)[0];
        if (it.cat === 'skin') {
            if (skins >= DAILY_MAX_SKINS) continue;
            skins++;
        }
        daily.push(it);
    }
    return { featured: featured.map(it => it.id), daily: daily.map(it => it.id) };
}

function parseIds(json) {
    try {
        const a = JSON.parse(json);
        return Array.isArray(a) ? a.filter(x => typeof x === 'string') : [];
    } catch (e) { return []; }
}

function readRotation(day) {
    const r = h().get('SELECT featured, daily FROM shop_rotations WHERE day = ?', day | 0);
    return r ? { day: day | 0, featured: parseIds(r.featured), daily: parseIds(r.daily) } : null;
}

// The persisted rotation for `day`, generating (and storing) it and, if
// needed, the days it depends on. depth bounds that look-back: the oldest
// days generated without history are only there to seed the skip rule.
function rotationFor(day, depth = FEATURED_SKIP_DAYS, now = Date.now()) {
    day |= 0;
    const have = readRotation(day);
    if (have) return have;
    const recent = [];
    if (depth > 0) {
        for (let k = 1; k <= FEATURED_SKIP_DAYS; k++) recent.push(...rotationFor(day - k, depth - 1, now).featured);
    }
    const g = generate(day, recent);
    h().run('INSERT OR IGNORE INTO shop_rotations (day, featured, daily, created_at) VALUES (?, ?, ?, ?)',
        day, JSON.stringify(g.featured), JSON.stringify(g.daily), now);
    return readRotation(day) || { day, ...g };
}

function inRotation(rot, id) {
    return rot.featured.includes(id) || rot.daily.includes(id);
}

// Throws unless `item` can be bought from the shop the client saw (`day`).
function checkOffered(item, day, now) {
    if (item.retired) fail(404, 'not_in_shop', 'That item is not for sale.');
    if (item.permanent) return;
    const today = dayOf(now);
    const d = Number(day);
    if (!Number.isInteger(d)) fail(400, 'bad_request', 'Missing shop day.');
    if (d === today) {
        if (!inRotation(rotationFor(today, FEATURED_SKIP_DAYS, now), item.id)) fail(409, 'not_in_shop', 'That item is not in today\'s shop.');
        return;
    }
    if (d === today - 1 && now - today * DAY <= RESET_GRACE_MS && inRotation(rotationFor(d, FEATURED_SKIP_DAYS, now), item.id)) return;
    fail(409, 'shop_rotated', 'The shop has reset. Take another look.', { day: today });
}

// ---- ownership ----

function ownedRows(userId) {
    return h().all('SELECT item_id, source, purchase_id, acquired_at FROM owned_items WHERE user_id = ? ORDER BY acquired_at DESC, item_id', userId);
}

function ownedSet(userId) {
    return new Set(ownedRows(userId).map(r => r.item_id));
}

function owns(userId, itemId) {
    return !!h().get('SELECT 1 AS x FROM owned_items WHERE user_id = ? AND item_id = ?', userId, itemId);
}

// The equipped ids, dropping anything no longer owned or no longer in the
// catalog (the columns are normally kept in step; this is the safety net).
function equippedOf(row, owned) {
    const set = owned || ownedSet(row.id);
    const ok = (id, cat) => {
        const it = id ? C.byId(id) : null;
        return it && it.cat === cat && !it.retired && set.has(id) ? id : null;
    };
    const nameStyle = ok(row.equip_name_style, 'nameStyle');
    return {
        nameStyle,
        skin: ok(row.equip_skin, 'skin'),
        customColor: row.custom_color && C.isColorAllowed(row.custom_color) ? row.custom_color : null,
    };
}

// For the game at spawn: wire numbers and the nameplate colour.
// -> {nameStyleNid, skinNid, nameColor: '#rrggbb'|null}
function cosmeticsFor(row) {
    const out = { nameStyleNid: 0, skinNid: 0, nameColor: null };
    if (!row || !h()) return out;
    const eq = equippedOf(row);
    const style = eq.nameStyle ? C.byId(eq.nameStyle) : null;
    if (style) {
        if (style.id === C.CUSTOM_COLOR_ID) {
            if (eq.customColor) { out.nameStyleNid = style.nid; out.nameColor = eq.customColor; }
        } else {
            out.nameStyleNid = style.nid;
        }
    }
    const skin = eq.skin ? C.byId(eq.skin) : null;
    if (skin) out.skinNid = skin.nid;
    return out;
}

// ---- shapes ----

function itemView(item, owned) {
    return { ...item, priceDust: item.price / C.MILLI, owned: !!(owned && owned.has(item.id)) };
}

function giftsSentToday(userId, now) {
    const r = h().get('SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND is_gift = 1 AND created_at >= ?', userId, dayOf(now) * DAY);
    return r ? r.n | 0 : 0;
}

function balanceOf(userId) {
    const r = h().get('SELECT dust_milli, refund_tokens FROM users WHERE id = ?', userId);
    return r ? { milli: r.dust_milli | 0, refundTokens: r.refund_tokens | 0 } : { milli: 0, refundTokens: 0 };
}

// GET /api/store
function storeView(row, now = Date.now()) {
    const day = dayOf(now);
    const rot = rotationFor(day, FEATURED_SKIP_DAYS, now);
    const owned = ownedSet(row.id);
    const pick = ids => ids.map(C.byId).filter(Boolean).map(it => itemView(it, owned));
    const bal = balanceOf(row.id);
    return {
        day,
        resetsAt: resetsAt(day),
        now,
        balance: bal.milli / C.MILLI,
        balanceMilli: bal.milli,
        refundTokens: bal.refundTokens,
        giftsLeft: Math.max(0, GIFTS_PER_DAY - giftsSentToday(row.id, now)),
        featured: pick(rot.featured),
        daily: pick(rot.daily),
        permanent: C.ITEMS.filter(it => it.permanent && !it.retired).map(it => itemView(it, owned)),
    };
}

// ---- money ----

function checkIdem(key) {
    if (typeof key !== 'string' || !IDEM_RE.test(key)) fail(400, 'bad_idempotency_key', 'Missing or malformed idempotencyKey (8-64 of A-Z a-z 0-9 _ -).');
    return key;
}

function itemOrFail(itemId) {
    const item = C.byId(typeof itemId === 'string' ? itemId : '');
    if (!item) fail(404, 'unknown_item', 'No such item.');
    return item;
}

// A key already used by this buyer: replay it if it was the same request.
function replay(userId, key, itemId, isGift) {
    const p = h().get('SELECT item_id, is_gift, result FROM purchases WHERE user_id = ? AND idem_key = ?', userId, key);
    if (!p) return null;
    if (p.item_id !== itemId || (p.is_gift | 0) !== (isGift ? 1 : 0) || !p.result) {
        fail(409, 'idempotency_conflict', 'That idempotencyKey was already used for a different request.');
    }
    let r;
    try { r = JSON.parse(p.result); } catch (e) { r = {}; }
    return { ...r, replayed: true };
}

// Takes `price` from the account or throws 402.
function charge(userId, price) {
    const r = h().run('UPDATE users SET dust_milli = dust_milli - ? WHERE id = ? AND deleted_at IS NULL AND dust_milli >= ?', price, userId, price);
    if (!r.changes) {
        const have = balanceOf(userId).milli;
        fail(402, 'insufficient_dust', 'Not enough gemdust.', { balance: have / C.MILLI, balanceMilli: have, price: price / C.MILLI, priceMilli: price });
    }
    return balanceOf(userId).milli;
}

function ledger(userId, delta, balance, kind, ref, now) {
    h().run('INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        userId, delta, balance, kind, ref, now);
}

function colorOrFail(raw) {
    const c = C.normalizeColor(raw);
    if (!/^#[0-9a-f]{6}$/.test(c)) fail(400, 'bad_color', 'Pick a colour as #rrggbb.', { reason: 'format' });
    if (!C.isColorAllowed(c)) fail(400, 'bad_color', 'That colour is too dark to read on the cave floor.', { reason: 'too_dark' });
    return c;
}

// purchase(userId, {itemId, day, idempotencyKey, color?}, {now, ip})
// -> {purchaseId, itemId, priceMilli, price, balance, balanceMilli, replayed?}
function purchase(userId, input, opts = {}) {
    const now = opts.now || Date.now();
    const key = checkIdem(input.idempotencyKey);
    const item = itemOrFail(input.itemId);
    const color = input.color != null && input.color !== '' && item.id === C.CUSTOM_COLOR_ID ? colorOrFail(input.color) : null;
    const d = h();
    return d.tx(() => {
        const again = replay(userId, key, item.id, false);
        if (again) return again;
        checkOffered(item, input.day, now);
        if (owns(userId, item.id)) fail(409, 'already_owned', 'You already own that.');
        const balance = charge(userId, item.price);
        const pid = d.run('INSERT INTO purchases (user_id, idem_key, item_id, price_milli, day, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            userId, key, item.id, item.price, dayOf(now), now).lastInsertRowid;
        d.run('INSERT INTO owned_items (user_id, item_id, source, purchase_id, acquired_at) VALUES (?, ?, ?, ?, ?)', userId, item.id, 'purchase', pid, now);
        ledger(userId, -item.price, balance, 'purchase', 'purchase:' + pid, now);
        if (color) d.run('UPDATE users SET custom_color = ? WHERE id = ?', color, userId);
        users.audit(userId, 'store_purchase', { purchaseId: pid, itemId: item.id, priceMilli: item.price }, { now, ip: opts.ip });
        const result = { purchaseId: pid, itemId: item.id, priceMilli: item.price, price: item.price / C.MILLI, balance: balance / C.MILLI, balanceMilli: balance };
        d.run('UPDATE purchases SET result = ? WHERE id = ?', JSON.stringify(result), pid);
        return result;
    });
}

// friends for >= 48 h and no block either way. Blocked and not-friends look
// the same from outside.
function checkGiftable(fromId, toId, now) {
    const blocked = h().get('SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
        fromId, toId, toId, fromId);
    const lo = Math.min(fromId, toId), hi = Math.max(fromId, toId);
    const f = h().get('SELECT created_at FROM friendships WHERE user_lo = ? AND user_hi = ?', lo, hi);
    if (blocked || !f) fail(403, 'not_friends', 'You can only gift to friends.');
    if (now - f.created_at < GIFT_FRIEND_AGE_MS) {
        fail(403, 'friends_too_new', 'You can gift to a friend once you have been friends for 48 hours.', { availableAt: f.created_at + GIFT_FRIEND_AGE_MS });
    }
}

// gift(userId, {itemId, day, toUserId (public id), idempotencyKey, preset}, {now, ip})
// -> {purchaseId, itemId, to:{userId, username}, preset, priceMilli, price, balance, balanceMilli, giftsLeft, replayed?}
function gift(userId, input, opts = {}) {
    const now = opts.now || Date.now();
    const key = checkIdem(input.idempotencyKey);
    const item = itemOrFail(input.itemId);
    const preset = input.preset == null ? 0 : Number(input.preset);
    if (!Number.isInteger(preset) || preset < 0 || preset >= GIFT_PRESETS) fail(400, 'bad_preset', 'Pick one of the gift messages.');
    const d = h();
    return d.tx(() => {
        const again = replay(userId, key, item.id, true);
        if (again) return again;
        const to = users.byPublicId(typeof input.toUserId === 'string' ? input.toUserId : '');
        if (!to) fail(404, 'user_not_found', 'No such player.');
        if (to.id === userId) fail(400, 'self_gift', 'You cannot gift to yourself.');
        checkGiftable(userId, to.id, now);
        checkOffered(item, input.day, now);
        if (owns(to.id, item.id)) fail(409, 'recipient_owns', 'They already own that.');
        const sent = giftsSentToday(userId, now);
        if (sent >= GIFTS_PER_DAY) fail(429, 'gift_limit', `You can send ${GIFTS_PER_DAY} gifts a day.`, { resetsAt: resetsAt(dayOf(now)) });
        const balance = charge(userId, item.price);
        const pid = d.run(`INSERT INTO purchases (user_id, idem_key, item_id, price_milli, day, is_gift, recipient_id, gift_message, created_at)
                           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            userId, key, item.id, item.price, dayOf(now), to.id, preset, now).lastInsertRowid;
        d.run('INSERT INTO owned_items (user_id, item_id, source, purchase_id, acquired_at) VALUES (?, ?, ?, ?, ?)', to.id, item.id, 'gift', pid, now);
        ledger(userId, -item.price, balance, 'gift', 'gift:' + pid, now);
        users.audit(userId, 'store_gift', { purchaseId: pid, itemId: item.id, to: to.public_id, preset, priceMilli: item.price }, { now, ip: opts.ip });
        users.audit(to.id, 'store_gift_received', { purchaseId: pid, itemId: item.id }, { now, actor: 'system' });
        const result = {
            purchaseId: pid, itemId: item.id, to: { userId: to.public_id, username: to.username }, preset,
            priceMilli: item.price, price: item.price / C.MILLI, balance: balance / C.MILLI, balanceMilli: balance,
            giftsLeft: Math.max(0, GIFTS_PER_DAY - sent - 1),
        };
        d.run('UPDATE purchases SET result = ? WHERE id = ?', JSON.stringify(result), pid);
        return result;
    });
}

// refund(userId, purchaseId, {now, ip}) -> {purchaseId, itemId, refundedMilli, refunded, balance, balanceMilli, refundTokens, equipped}
function refund(userId, purchaseId, opts = {}) {
    const now = opts.now || Date.now();
    const id = Number(purchaseId);
    if (!Number.isInteger(id) || id <= 0) fail(400, 'bad_request', 'Missing purchaseId.');
    const d = h();
    return d.tx(() => {
        const p = d.get('SELECT * FROM purchases WHERE id = ? AND user_id = ?', id, userId);
        if (!p) fail(404, 'not_found', 'No such purchase.');
        if (p.is_gift) fail(409, 'gift_not_refundable', 'Gifts cannot be refunded.');
        if (p.refunded_at != null) fail(409, 'already_refunded', 'That purchase was already refunded.');
        if (now - p.created_at >= REFUND_WINDOW_MS) fail(409, 'refund_expired', 'Refunds are only possible within 24 hours of buying.');
        const u = d.get('SELECT refund_tokens FROM users WHERE id = ? AND deleted_at IS NULL', userId);
        if (!u || (u.refund_tokens | 0) <= 0) fail(409, 'no_refund_tokens', 'You have no refund tokens left.');
        const gone = d.run('DELETE FROM owned_items WHERE user_id = ? AND item_id = ? AND purchase_id = ?', userId, p.item_id, p.id).changes;
        if (!gone) fail(409, 'not_owned', 'That item is no longer in your Locker.');
        d.run('UPDATE purchases SET refunded_at = ? WHERE id = ? AND refunded_at IS NULL', now, p.id);
        const r = d.run(`UPDATE users SET dust_milli = dust_milli + ?, refund_tokens = refund_tokens - 1,
                             equip_name_style = CASE WHEN equip_name_style = ? THEN NULL ELSE equip_name_style END,
                             equip_skin = CASE WHEN equip_skin = ? THEN NULL ELSE equip_skin END
                         WHERE id = ? AND refund_tokens > 0 AND deleted_at IS NULL`,
            p.price_milli, p.item_id, p.item_id, userId);
        if (!r.changes) fail(409, 'no_refund_tokens', 'You have no refund tokens left.');
        const bal = balanceOf(userId);
        ledger(userId, p.price_milli, bal.milli, 'refund', 'refund:' + p.id, now);
        users.audit(userId, 'store_refund', { purchaseId: p.id, itemId: p.item_id, priceMilli: p.price_milli }, { now, ip: opts.ip });
        return {
            purchaseId: p.id, itemId: p.item_id, refundedMilli: p.price_milli, refunded: p.price_milli / C.MILLI,
            balance: bal.milli / C.MILLI, balanceMilli: bal.milli, refundTokens: bal.refundTokens,
            equipped: equippedOf(users.byId(userId)),
        };
    });
}

// GET /api/store/history: purchases and gifts sent, plus gifts received
// (except from players this account has blocked). Newest first.
function history(userId, now = Date.now()) {
    const d = h();
    const bal = balanceOf(userId);
    const rows = d.all(`
        SELECT p.id, p.user_id, p.item_id, p.price_milli, p.day, p.is_gift, p.recipient_id, p.gift_message, p.created_at, p.refunded_at,
               r.public_id AS r_pub, r.username AS r_name, r.deleted_at AS r_del,
               b.public_id AS b_pub, b.username AS b_name, b.deleted_at AS b_del
        FROM purchases p
        LEFT JOIN users r ON r.id = p.recipient_id
        LEFT JOIN users b ON b.id = p.user_id
        WHERE p.user_id = ?
           OR (p.recipient_id = ? AND NOT EXISTS (SELECT 1 FROM blocks k WHERE k.blocker_id = ? AND k.blocked_id = p.user_id))
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?`, userId, userId, userId, HISTORY_LIMIT);
    const owned = ownedRows(userId);
    const ownedBy = new Map(owned.map(o => [o.item_id, o.purchase_id]));
    return {
        refundTokens: bal.refundTokens,
        entries: rows.map(p => {
            const mine = p.user_id === userId;
            const direction = p.is_gift ? (mine ? 'sent' : 'received') : 'bought';
            const until = p.created_at + REFUND_WINDOW_MS;
            const refundable = direction === 'bought' && p.refunded_at == null && now < until && bal.refundTokens > 0 && ownedBy.get(p.item_id) === p.id;
            const person = direction === 'sent'
                ? (p.r_pub && p.r_del == null ? { userId: p.r_pub, username: p.r_name } : null)
                : direction === 'received' ? (p.b_pub && p.b_del == null ? { userId: p.b_pub, username: p.b_name } : null) : null;
            const item = C.byId(p.item_id);
            return {
                purchaseId: p.id,
                itemId: p.item_id,
                name: item ? item.name : p.item_id,
                cat: item ? item.cat : null,
                rarity: item ? item.rarity : null,
                direction,
                // what the account paid (0 for a gift received)
                priceMilli: mine ? p.price_milli : 0,
                price: mine ? p.price_milli / C.MILLI : 0,
                day: p.day,
                createdAt: p.created_at,
                refundedAt: p.refunded_at,
                refundable,
                refundableUntil: direction === 'bought' && p.refunded_at == null ? until : null,
                to: direction === 'sent' ? person : null,
                from: direction === 'received' ? person : null,
                preset: p.is_gift ? p.gift_message : null,
            };
        }),
    };
}

// ---- Locker ----

function lockerView(row) {
    const rows = ownedRows(row.id);
    const set = new Set(rows.map(r => r.item_id));
    const owned = [];
    for (const r of rows) {
        const it = C.byId(r.item_id);
        if (!it || it.retired) continue;
        owned.push({ ...it, priceDust: it.price / C.MILLI, owned: true, source: r.source, purchaseId: r.purchase_id, acquiredAt: r.acquired_at });
    }
    return { owned, equipped: equippedOf(row, set) };
}

// equip(userId, slot, itemId|null, color?, opts) -> {equipped}
// Takes effect on the next spawn.
function equip(userId, slot, itemId, color, opts = {}) {
    if (!C.isCat(slot)) fail(400, 'bad_slot', "slot must be 'nameStyle' or 'skin'.");
    const col = slot === 'nameStyle' ? 'equip_name_style' : 'equip_skin';
    const d = h();
    return d.tx(() => {
        const row = users.byId(userId);
        if (!row) fail(404, 'not_found', 'Account not found.');
        if (itemId == null || itemId === '') {
            d.run(`UPDATE users SET ${col} = NULL WHERE id = ?`, userId);
            return { equipped: equippedOf(users.byId(userId)) };
        }
        const item = itemOrFail(itemId);
        if (item.cat !== slot) fail(400, 'bad_item', 'That item does not go in that slot.');
        if (!owns(userId, item.id)) fail(403, 'not_owned', 'You do not own that.');
        if (item.id === C.CUSTOM_COLOR_ID) {
            const c = color != null && color !== '' ? colorOrFail(color) : row.custom_color;
            if (!c || !C.isColorAllowed(c)) fail(400, 'color_required', 'Pick a colour first.');
            d.run(`UPDATE users SET ${col} = ?, custom_color = ? WHERE id = ?`, item.id, c, userId);
        } else {
            d.run(`UPDATE users SET ${col} = ? WHERE id = ?`, item.id, userId);
        }
        return { equipped: equippedOf(users.byId(userId)) };
    });
}

module.exports = {
    DAY, RESET_GRACE_MS, REFUND_WINDOW_MS, GIFT_FRIEND_AGE_MS, GIFTS_PER_DAY, GIFT_PRESETS,
    FEATURED_COUNT, DAILY_COUNT, DAILY_MAX_SKINS,
    fnv1a, mulberry32, generate, rotationFor, readRotation, dayOf, resetsAt,
    ownedSet, owns, equippedOf, cosmeticsFor,
    storeView, purchase, gift, refund, history, lockerView, equip,
};
