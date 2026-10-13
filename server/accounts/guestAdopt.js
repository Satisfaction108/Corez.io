'use strict';

const guests = require('./guests');
const users = require('./users');

let errAt = 0;
function safe(what, fn, fallback) {
    try { return fn(); } catch (e) {
        const t = Date.now();
        if (t - errAt > 10000) { errAt = t; console.error('[accounts] guest carry over (' + what + ') failed: ' + ((e && e.message) || e)); }
        return fallback;
    }
}

function adoptAll(userId, guestId, now = Date.now()) {
    const out = { stats: false, bankGems: 0, achievements: [], achDustMilli: 0, items: [], loot: [], daily: null, champMilli: 0, levels: null };
    if (!guests.valid(guestId) || !Number.isInteger(userId) || userId <= 0) return out;
    out.stats = safe('stats', () => guests.converted(guestId, userId, now), false);
    out.bankGems = safe('bank', () => require('./banks').claimGuest(guestId, userId, now), 0) | 0;
    const ach = safe('achievements', () => require('./achievements').adoptGuest(guestId, userId, now), null);
    if (ach) {
        out.achievements = ach.moved || [];
        out.achDustMilli = ach.rewardMilli | 0;
        out.items = (ach.items || []).slice();
        out.loot = (ach.loot || []).slice();
    }
    const daily = safe('daily', () => require('./retention').adoptGuest(userId, guestId, now), null);
    if (daily && daily.moved) out.daily = { items: daily.items || [], dustMilli: daily.dustMilli | 0 };
    out.champMilli = safe('champ', () => require('./dailyScores').adoptGuest(guestId, userId, now), 0) | 0;
    const lv = safe('levels', () => require('./levels').adoptGuest(userId, guestId, now), null);
    if (lv && lv.moved) out.levels = lv;
    return out;
}

function anything(r) {
    return !!(r && (r.bankGems > 0 || r.achievements.length || r.items.length || r.daily || r.champMilli > 0 || r.levels));
}

function itemsOf(r) {
    const C = require('../../shared/cosmetics.js');
    const ids = new Set();
    const out = [];
    const add = (id) => {
        const it = id ? C.byId(id) : null;
        if (!it || ids.has(it.id)) return;
        ids.add(it.id);
        out.push({ id: it.id, name: it.name, cat: it.cat, rarity: it.rarity });
    };
    if (r.levels) for (const u of r.levels.ups) if (u.item) add(u.item.id);
    for (const id of r.items) add(id);
    if (r.daily) for (const it of r.daily.items) add(it && it.id);
    return out;
}

function clientView(r) {
    if (!anything(r)) return null;
    const lv = r.levels;
    return {
        level: lv ? lv.level : null,
        levelXp: lv ? lv.guestXp : 0,
        levelLeft: lv ? lv.left : 0,
        levelFrom: lv ? lv.from : null,
        levelUps: lv ? lv.ups : [],
        items: itemsOf(r),
        achievements: r.achievements.length,
        bankGems: r.bankGems,
        dustMilli: (lv ? lv.dustMilli : 0) + r.achDustMilli + (r.daily ? r.daily.dustMilli : 0) + r.champMilli,
        daily: !!r.daily,
    };
}

function forAuth(user, guestId, now = Date.now()) {
    if (!user || !guests.valid(guestId)) return { carried: null, level: null, user: null };
    const r = adoptAll(user.id, guestId, now);
    const carried = clientView(r);
    let level = null;
    try { level = require('./levels').status({ kind: 'a', id: user.id }, now); } catch (e) { level = null; }
    const fresh = carried ? users.byId(user.id) : null;
    return { carried, level: level && level.on ? level : null, user: fresh };
}

module.exports = { adoptAll, anything, clientView, forAuth };
