// Achievements: the database side.
//
// The catalog is shared/achievements.js. Rows live in user_achievements
// (accounts) and guest_achievements (guest browsers), same shape:
//   '<id>'     one achievement; unlocked_at is set once, never cleared
//   'c:<trk>'  a counter several achievements read (progress, and for 'set'
//              tracks the list in data); unlocked_at stays NULL
// An owner is {kind:'a', id:<user id>} or {kind:'g', id:<guest id>}.
//
// Unlocking is idempotent: only the call that sets unlocked_at reports the
// unlock and pays (an account: its dust, ledger kind 'achievement', and the
// item if it has one). A guest's rewards wait: when that browser signs up,
// adoptGuest moves its rows onto the new account and pays them then.
//
// The game thread counts in memory (game/achHooks.js) and writes counters
// in batches (saveCounters); unlocks are written at once.
'use strict';

const db = require('./db');
const dust = require('./dust');
const C = require('../../shared/achievements.js');

const DEFS = C.DEFS;
const BY_ID = C.BY_ID;
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
const RARITY_MS = 10 * 60 * 1000;
const SET_MAX = 64;          // a 'set' track keeps at most this many keys
const GUEST_RE = /^[a-f0-9]{32}$/;

function h() { return db.handle(); }

function tableOf(owner) {
    if (owner && owner.kind === 'a' && Number.isInteger(owner.id) && owner.id > 0) return { t: 'user_achievements', col: 'user_id' };
    if (owner && owner.kind === 'g' && GUEST_RE.test(String(owner.id))) return { t: 'guest_achievements', col: 'guest_id' };
    return null;
}
const acct = (userId) => ({ kind: 'a', id: userId });

function parseSet(data) {
    if (!data) return [];
    try { const v = JSON.parse(data); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, SET_MAX) : []; } catch (e) { return []; }
}

// Everything stored for an owner -> {have: Map(id -> unlockedAt), counters: Map(track -> {n, set})}
function load(owner) {
    const d = h();
    const T = tableOf(owner);
    const out = { have: new Map(), counters: new Map() };
    if (!d || !T) return out;
    for (const r of d.all(`SELECT achievement_id AS id, progress, unlocked_at AS at, data FROM ${T.t} WHERE ${T.col} = ?`, owner.id)) {
        if (r.id.startsWith('c:')) out.counters.set(r.id.slice(2), { n: r.progress | 0, set: parseSet(r.data) });
        else if (r.at != null) out.have.set(r.id, r.at);
    }
    return out;
}

// Lifetime totals the older stat tables already have, so nobody starts the
// new counters from zero: accounts from user_stats, guests from guests.
function seeds(owner) {
    const d = h();
    if (!d) return {};
    if (owner.kind === 'a') {
        const s = d.get('SELECT kills, bot_kills, gems_banked, raid_wins, lives FROM user_stats WHERE user_id = ?', owner.id);
        return s ? { kills: s.kills | 0, botkills: s.bot_kills | 0, banked: s.gems_banked | 0, wins: s.raid_wins | 0, games: s.lives | 0 } : {};
    }
    const g = d.get('SELECT kills, bot_kills, games FROM guests WHERE guest_id = ?', owner.id);
    return g ? { kills: g.kills | 0, botkills: g.bot_kills | 0, games: g.games | 0 } : {};
}

function payAccount(d, userId, def, now, refPrefix) {
    let balanceMilli = null, item = null;
    if (def.rewardMilli > 0) balanceMilli = dust.creditExempt(userId, def.rewardMilli, 'achievement', (refPrefix || 'ach:') + def.id, now);
    if (def.item) {
        const retention = require('./retention');
        if (retention.grantItem(d, userId, def.item, now)) item = def.item;
    }
    return { balanceMilli, item };
}

// -> {fresh, rewardMilli, balanceMilli, item}; fresh only for the call that
// set it. An account is paid in the same transaction.
function unlock(owner, id, now = Date.now(), progress) {
    const d = h();
    const def = BY_ID.get(id);
    const T = tableOf(owner);
    const none = { fresh: false, rewardMilli: 0, balanceMilli: null, item: null };
    if (!d || !def || !T) return none;
    return d.tx(() => {
        const fresh = d.run(`INSERT INTO ${T.t} (${T.col}, achievement_id, progress, unlocked_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(${T.col}, achievement_id) DO UPDATE SET unlocked_at = excluded.unlocked_at,
                      progress = MAX(progress, excluded.progress)
                  WHERE unlocked_at IS NULL`, owner.id, id, Math.max(def.goal, progress | 0), now).changes > 0;
        if (!fresh) return none;
        if (owner.kind !== 'a') return { fresh: true, rewardMilli: def.rewardMilli, balanceMilli: null, item: def.item, guest: true };
        const p = payAccount(d, owner.id, def, now);
        return { fresh: true, rewardMilli: def.rewardMilli, balanceMilli: p.balanceMilli, item: p.item };
    });
}

// Counter rows: [{track, n, set?:[keys]}]. Only ever moves up.
function saveCounters(owner, list) {
    const d = h();
    const T = tableOf(owner);
    if (!d || !T || !list || !list.length) return;
    d.tx(() => {
        for (const c of list) {
            const data = c.set ? JSON.stringify(c.set.slice(0, SET_MAX)) : null;
            d.run(`INSERT INTO ${T.t} (${T.col}, achievement_id, progress, data) VALUES (?, ?, ?, ?)
                   ON CONFLICT(${T.col}, achievement_id) DO UPDATE SET progress = MAX(progress, excluded.progress),
                       data = COALESCE(excluded.data, data)`, owner.id, 'c:' + c.track, Math.max(0, c.n | 0), data);
        }
    });
}

// ---- rarity: share of players who have each one, cached ----

let rarityCache = null;
function rarity(now = Date.now(), force = false) {
    if (!force && rarityCache && now - rarityCache.at < RARITY_MS) return rarityCache;
    const d = h();
    const out = { at: now, players: 0, pct: {} };
    if (!d) return out;
    const n = new Map();
    for (const t of ['user_achievements', 'guest_achievements']) {
        for (const r of d.all(`SELECT achievement_id AS id, COUNT(*) AS c FROM ${t} WHERE unlocked_at IS NOT NULL GROUP BY achievement_id`)) {
            n.set(r.id, (n.get(r.id) || 0) + (r.c | 0));
        }
    }
    // a player is anyone who has unlocked anything at all
    const users = d.get('SELECT COUNT(DISTINCT user_id) AS c FROM user_achievements WHERE unlocked_at IS NOT NULL').c | 0;
    const guests = d.get('SELECT COUNT(DISTINCT guest_id) AS c FROM guest_achievements WHERE unlocked_at IS NOT NULL').c | 0;
    out.players = users + guests;
    for (const a of DEFS) {
        const c = n.get(a.id) || 0;
        out.pct[a.id] = out.players ? Math.round((c / out.players) * 1000) / 10 : 0;
    }
    rarityCache = out;
    return out;
}
function _resetRarity() { rarityCache = null; }

// ---- views ----

function progressOf(a, counters, sd) {
    if (!a.track) return 0;
    const c = counters.get(a.track);
    let n = c ? (a.mode === 'set' ? Math.max(c.n, c.set.length) : c.n) : 0;
    if (sd && sd[a.track] != null) n = Math.max(n, sd[a.track] | 0);
    return n;
}

// Every achievement with this owner's progress and how rare it is.
// Secret ones nobody here has unlocked come back as ???.
function listFor(owner, now = Date.now()) {
    const st = load(owner);
    const sd = tableOf(owner) ? seeds(owner) : {};
    const rar = rarity(now);
    return DEFS.map(a => {
        const at = st.have.has(a.id) ? st.have.get(a.id) : null;
        let progress = progressOf(a, st.counters, sd);
        if (at != null) progress = a.goal;
        const hidden = a.secret && at == null;
        return {
            id: a.id, cat: a.cat, name: hidden ? '???' : a.name, desc: hidden ? 'A secret. Keep playing to find it.' : a.desc,
            icon: hidden ? 'secret' : a.icon, color: a.color, tier: a.tier, secret: a.secret,
            goal: a.goal, progress: Math.min(a.goal, Math.max(0, progress)), unlockedAt: at,
            rewardMilli: a.rewardMilli, item: hidden ? null : a.item, rarity: rar.pct[a.id] || 0,
        };
    });
}

// Older callers: one account.
function list(userId) { return listFor(acct(userId)); }
function unlockedSet(userId) {
    const d = h();
    if (!d) return new Set();
    return new Set(d.all("SELECT achievement_id AS id FROM user_achievements WHERE user_id = ? AND unlocked_at IS NOT NULL AND achievement_id NOT LIKE 'c:%'", userId)
        .map(r => r.id).filter(id => BY_ID.has(id)));
}
function countFor(userId) { return unlockedSet(userId).size; }

// ---- Core loot a guest found (game/terrain/coreDrop.js) ----
// A guest's lucky Core drops wait in one guest_achievements counter row
// (LOOT_ROW, the item ids in data) and are granted by adoptGuest at signup,
// like a guest's achievement items. No new table.
const LOOT_ROW = 'c:coreloot';
function guestLoot(guestId) {
    const d = h();
    if (!d || !GUEST_RE.test(String(guestId || ''))) return [];
    const r = d.get('SELECT data FROM guest_achievements WHERE guest_id = ? AND achievement_id = ?', guestId, LOOT_ROW);
    return r ? parseSet(r.data) : [];
}
// -> true when it was added (false: already on the list, bad id, no db)
function addGuestLoot(guestId, itemId, now = Date.now()) {
    const d = h();
    if (!d || !GUEST_RE.test(String(guestId || '')) || typeof itemId !== 'string') return false;
    return d.tx(() => {
        const list = guestLoot(guestId);
        if (list.includes(itemId) || list.length >= SET_MAX) return false;
        list.push(itemId);
        d.run(`INSERT INTO guest_achievements (guest_id, achievement_id, progress, data) VALUES (?, ?, ?, ?)
               ON CONFLICT(guest_id, achievement_id) DO UPDATE SET progress = excluded.progress, data = excluded.data`,
            guestId, LOOT_ROW, list.length, JSON.stringify(list));
        return true;
    });
}

// ---- a guest who signs up ----

// The browser's guest rows move onto the account (made in the last day),
// once: achievements it doesn't have yet are unlocked with their original
// time and paid now, counters keep the higher value, set lists merge. The
// guest rows are deleted, so a second call moves nothing.
// -> {moved: [ids newly unlocked], rewardMilli, balanceMilli, items: [ids]}
function adoptGuest(guestId, userId, now = Date.now()) {
    const d = h();
    const none = { moved: [], rewardMilli: 0, balanceMilli: null, items: [] };
    if (!d || !GUEST_RE.test(String(guestId || '')) || !Number.isInteger(userId)) return none;
    return d.tx(() => {
        const u = d.get('SELECT created_at FROM users WHERE id = ? AND deleted_at IS NULL', userId);
        if (!u || u.created_at < now - NEW_ACCOUNT_MS) return none;
        const conv = d.get('SELECT converted_user_id AS c FROM guests WHERE guest_id = ?', guestId);
        if (conv && conv.c != null && conv.c !== userId) return none;
        const rows = d.all('SELECT achievement_id AS id, progress, unlocked_at AS at, data FROM guest_achievements WHERE guest_id = ?', guestId);
        if (!rows.length) return none;
        const out = { moved: [], rewardMilli: 0, balanceMilli: null, items: [] };
        for (const r of rows) {
            // Core loot: the items it found are granted now (retention.grantItem)
            if (r.id === LOOT_ROW) {
                const retention = require('./retention');
                for (const id of parseSet(r.data)) if (retention.grantItem(d, userId, id, now)) { out.items.push(id); (out.loot || (out.loot = [])).push(id); }
                continue;
            }
            if (r.id.startsWith('c:')) {
                const mine = d.get('SELECT progress, data FROM user_achievements WHERE user_id = ? AND achievement_id = ?', userId, r.id);
                let data = r.data;
                if (mine && (mine.data || r.data)) {
                    const merged = Array.from(new Set(parseSet(mine.data).concat(parseSet(r.data)))).slice(0, SET_MAX);
                    data = JSON.stringify(merged);
                }
                d.run(`INSERT INTO user_achievements (user_id, achievement_id, progress, data) VALUES (?, ?, ?, ?)
                       ON CONFLICT(user_id, achievement_id) DO UPDATE SET progress = MAX(progress, excluded.progress), data = excluded.data`,
                    userId, r.id, r.progress | 0, data);
                continue;
            }
            const def = BY_ID.get(r.id);
            if (!def || r.at == null) continue;
            const fresh = d.run(`INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at) VALUES (?, ?, ?, ?)
                      ON CONFLICT(user_id, achievement_id) DO UPDATE SET unlocked_at = excluded.unlocked_at
                      WHERE unlocked_at IS NULL`, userId, r.id, def.goal, r.at).changes > 0;
            if (!fresh) continue;
            const p = payAccount(d, userId, def, now, 'ach_guest:');
            out.moved.push(r.id);
            out.rewardMilli += def.rewardMilli;
            if (p.balanceMilli != null) out.balanceMilli = p.balanceMilli;
            if (p.item) out.items.push(p.item);
        }
        d.run('DELETE FROM guest_achievements WHERE guest_id = ?', guestId);
        if (out.moved.length) {
            try {
                require('./users').audit(userId, 'achievements_adopt', { guest: guestId.slice(0, 6), ids: out.moved, rewardMilli: out.rewardMilli }, { now, actor: 'system' });
            } catch (e) { /* audit is best effort */ }
        }
        return out;
    });
}

module.exports = {
    DEFS, BY_ID, NEW_ACCOUNT_MS, RARITY_MS, SET_MAX,
    tableOf, load, seeds, unlock, saveCounters, rarity, listFor, list, unlockedSet, countFor, adoptGuest,
    LOOT_ROW, guestLoot, addGuestLoot,
    _resetRarity,
};
