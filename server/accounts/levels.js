'use strict';

const db = require('./db');
const dust = require('./dust');
const store = require('./store');
const users = require('./users');
const C = require('../../shared/cosmetics.js');
const L = require('../../shared/levels.js');

const GUEST_RE = /^[a-f0-9]{32}$/;
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
const MERGE_DAYS = 7;
const OFF = process.env.LEVELS === 'off';

function h() { return db.handle(); }
function on() { return !OFF && !!h(); }

function validOwner(o) {
    return !!o && ((o.kind === 'a' && Number.isInteger(o.id) && o.id > 0) || (o.kind === 'g' && GUEST_RE.test(String(o.id))));
}

function readRow(d, o) {
    if (o.kind === 'a') return d.get('SELECT xp, level, xp_day AS day, xp_day_n AS dayXp, created_at FROM users WHERE id = ? AND deleted_at IS NULL', o.id);
    return d.get('SELECT xp, level, xp_day AS day, xp_day_n AS dayXp, xp_to AS movedTo FROM guests WHERE guest_id = ?', o.id);
}

function itemView(id) {
    const it = id ? C.byId(id) : null;
    return it ? { id: it.id, name: it.name, cat: it.cat, rarity: it.rarity } : null;
}

function rewardView(r, guest, extra) {
    if (!r) return null;
    return Object.assign({
        level: r.level,
        dustMilli: r.dustMilli,
        item: itemView(r.item),
        title: r.title || null,
        milestone: !!r.milestone,
        text: L.rewardText(r, C),
        line: L.upLine(r, C, guest),
        guest: !!guest,
    }, extra || {});
}

function grantItem(d, userId, itemId, now) {
    const it = C.byId(itemId);
    if (!it || it.retired) return false;
    const fresh = d.run("INSERT OR IGNORE INTO owned_items (user_id, item_id, source, purchase_id, acquired_at) VALUES (?, ?, 'level', NULL, ?)",
        userId, it.id, now).changes > 0;
    if (!fresh) return false;
    const col = store.SLOT_COL[it.cat];
    if (col) {
        const extra = it.cat === 'sdSkin' || it.cat === 'sdName' ? ' AND equip_sidekick IS NOT NULL' : '';
        d.run(`UPDATE users SET ${col} = ? WHERE id = ? AND ${col} IS NULL${extra}`, it.id, userId);
    }
    return true;
}

function grantLevels(d, userId, from, to, now) {
    const out = [];
    let balanceMilli = null, dustMilli = 0;
    for (const r of L.rewardsBetween(from, to)) {
        if (!d.run('INSERT OR IGNORE INTO level_grants (user_id, level, at) VALUES (?, ?, ?)', userId, r.level, now).changes) continue;
        let item = null, had = null, milli = r.dustMilli;
        if (r.item) {
            if (grantItem(d, userId, r.item, now)) item = r.item;
            else { had = r.item; milli += r.fallbackMilli | 0; }
        }
        if (milli > 0) {
            const b = dust.creditExempt(userId, milli, 'level', 'level:' + r.level, now);
            if (b != null) { balanceMilli = b; dustMilli += milli; } else milli = 0;
        }
        d.run('UPDATE level_grants SET dust_milli = ?, item_id = ? WHERE user_id = ? AND level = ?', milli, item, userId, r.level);
        const paid = { level: r.level, item, title: r.title, dustMilli: milli, milestone: r.milestone };
        out.push(rewardView(paid, false, { had: itemView(had) }));
    }
    return { ups: out, balanceMilli, dustMilli };
}

function addXp(o, amount, reason, now = Date.now()) {
    const d = h();
    if (!d || OFF || !validOwner(o)) return null;
    const want = Math.max(0, Math.floor(+amount || 0));
    if (!want) return null;
    return d.tx(() => {
        if (o.kind === 'g') d.run('INSERT INTO guests (guest_id, first_seen, last_seen) VALUES (?, ?, ?) ON CONFLICT(guest_id) DO NOTHING', o.id, now, now);
        const row = readRow(d, o);
        if (!row) return null;
        const day = L.dayOf(now);
        const cap = L.capDay({ day: row.day, dayXp: row.dayXp }, want, day);
        const fromLevel = Math.max(1, row.level | 0);
        const xp = (row.xp | 0) + cap.add;
        const lv = L.levelOf(xp);
        const level = Math.max(fromLevel, lv.level);
        if (o.kind === 'a') d.run('UPDATE users SET xp = ?, level = ?, xp_day = ?, xp_day_n = ? WHERE id = ?', xp, level, cap.day, cap.dayXp, o.id);
        else d.run('UPDATE guests SET xp = ?, level = ?, xp_day = ?, xp_day_n = ? WHERE guest_id = ?', xp, level, cap.day, cap.dayXp, o.id);
        let ups = [], balanceMilli = null, dustMilli = 0;
        if (level > fromLevel) {
            if (o.kind === 'a') {
                const g = grantLevels(d, o.id, fromLevel, level, now);
                ups = g.ups; balanceMilli = g.balanceMilli; dustMilli = g.dustMilli;
                users.audit(o.id, 'level_up', { from: fromLevel, to: level, xp, reason: String(reason || '').slice(0, 24), dustMilli }, { now, actor: 'system' });
            } else ups = L.rewardsBetween(fromLevel, level).map(r => rewardView(r, true));
        }
        return { gained: cap.add, wanted: want, capped: cap.capped, xp, level, from: fromLevel, ups, balanceMilli, dustMilli, dayXp: cap.dayXp, day };
    });
}

function savedFor(level) {
    const list = L.rewardsBetween(1, level);
    const items = list.filter(r => r.item).map(r => itemView(r.item)).filter(Boolean);
    const titles = list.filter(r => r.title).map(r => r.title);
    const dustMilli = list.reduce((s, r) => s + r.dustMilli, 0);
    return { items, titles, dustMilli, levels: list.length };
}

function view(o, row, now) {
    const xp = row ? row.xp | 0 : 0;
    const lv = L.levelOf(xp);
    const level = Math.max(lv.level, row ? row.level | 0 : 1);
    const st = level > lv.level ? L.levelOf(L.START[level]) : lv;
    const day = L.dayOf(now);
    const dayXp = row && (row.day | 0) === day ? row.dayXp | 0 : 0;
    const next = L.nextUnlock(level);
    const guest = o.kind === 'g';
    return {
        on: true,
        owner: guest ? 'guest' : 'account',
        xp,
        level,
        into: level > lv.level ? 0 : st.into,
        need: st.need,
        max: level >= L.MAX_LEVEL,
        title: L.titleFor(level),
        dayXp,
        dayCap: L.DAY_CAP,
        next: next ? rewardView(next, guest) : null,
        nextLine: L.nextLine(level, C),
        saved: guest ? savedFor(level) : null,
        moved: !!(row && row.movedTo),
        now,
    };
}

function status(o, now = Date.now()) {
    const d = h();
    if (!d || OFF) return { on: false, now };
    if (!validOwner(o)) return { on: false, now };
    return view(o, readRow(d, o), now);
}

function adoptGuest(userId, guestId, now = Date.now()) {
    const d = h();
    const none = { moved: false, xp: 0, level: 1, guestXp: 0, left: 0, capped: false, fresh: false, ups: [], dustMilli: 0, balanceMilli: null };
    if (!d || OFF || !GUEST_RE.test(String(guestId || '')) || !Number.isInteger(userId)) return none;
    return d.tx(() => {
        const u = d.get('SELECT id, created_at, xp, level, xp_day AS day, xp_day_n AS dayXp FROM users WHERE id = ? AND deleted_at IS NULL', userId);
        if (!u) return none;
        const g = d.get('SELECT xp, xp_day AS day, xp_day_n AS dayXp FROM guests WHERE guest_id = ?', guestId);
        const pool = g ? Math.max(0, g.xp | 0) : 0;
        if (!pool) return none;
        const day = L.dayOf(now);
        const fresh = u.created_at >= now - NEW_ACCOUNT_MS;
        if (!fresh && (g.day | 0) < day - MERGE_DAYS) return Object.assign({}, none, { left: pool });
        const guestToday = (g.day | 0) === day ? Math.min(pool, Math.max(0, g.dayXp | 0)) : 0;
        const userToday = (u.day | 0) === day ? Math.max(0, u.dayXp | 0) : 0;
        const room = Math.max(0, L.DAY_CAP - userToday);
        const today = fresh ? Math.min(guestToday, room) : Math.min(pool, room);
        const take = fresh ? today + (pool - guestToday) : today;
        if (!(take > 0)) return Object.assign({}, none, { left: pool, capped: true, fresh });
        const left = pool - take;
        if (!d.run('UPDATE guests SET xp = ?, level = ?, xp_to = ? WHERE guest_id = ? AND xp = ?', left, L.levelOf(left).level, userId, guestId, pool).changes) return none;
        const fromLevel = Math.max(1, u.level | 0);
        const xp = (u.xp | 0) + take;
        const level = Math.max(fromLevel, L.levelOf(xp).level);
        d.run('UPDATE users SET xp = ?, level = ?, xp_day = ?, xp_day_n = ? WHERE id = ?', xp, level, day, userToday + today, userId);
        const gr = level > fromLevel ? grantLevels(d, userId, fromLevel, level, now) : { ups: [], balanceMilli: null, dustMilli: 0 };
        users.audit(userId, 'level_adopt', { guest: guestId.slice(0, 6), xp: take, left, fresh, from: fromLevel, to: level, dustMilli: gr.dustMilli }, { now, actor: 'system' });
        return { moved: true, xp, level, from: fromLevel, guestXp: take, left, capped: left > 0, fresh, ups: gr.ups, dustMilli: gr.dustMilli, balanceMilli: gr.balanceMilli };
    });
}

function grants(userId) {
    const d = h();
    if (!d || !Number.isInteger(userId)) return [];
    return d.all('SELECT level, at, dust_milli AS dustMilli, item_id AS itemId FROM level_grants WHERE user_id = ? ORDER BY level', userId);
}

function viewOf(o, row, now = Date.now()) { return view(o, row, now); }

function hooks() { return require('./game/levelHooks'); }

function grant(owner, xp, reason, opts) {
    try { return hooks().grant(owner, xp, reason, opts); } catch (e) { return null; }
}

function eventPlaced(owner, place, field, opts) {
    return grant(owner, L.eventXp(place, field), 'event', opts);
}

module.exports = {
    NEW_ACCOUNT_MS, MERGE_DAYS, on, validOwner, addXp, status, viewOf, adoptGuest, grants, grant, eventPlaced, rewardView, savedFor, grantItem,
};
