// Achievements: the database side (user_achievements rows).
//
// Three kinds:
//   stat     unlocked when a user_stats column reaches the goal; checked by
//            the game thread after a life settles, after a raid placement
//            and after a dust flush that banked gems (checkStats)
//   counter  progress kept in user_achievements.progress (addProgress)
//   event    unlocked the moment the game sees it happen (unlock)
// Unlocking is idempotent: the row's unlocked_at is only ever set once, and
// only a call that set it reports the unlock (so the ACH packet / 'ach' SSE
// goes out once).
'use strict';

const db = require('./db');

const DEFS = [
    { id: 'first_blood', name: 'First Blood', desc: 'Knock out another player',       kind: 'stat',    stat: 'kills',       goal: 1 },
    { id: 'bot_buster',  name: 'Bot Buster',  desc: 'Knock out 50 bots',              kind: 'stat',    stat: 'bot_kills',   goal: 50 },
    { id: 'banker',      name: 'Banker',      desc: 'Bank 10,000 gems',               kind: 'stat',    stat: 'gems_banked', goal: 10000 },
    { id: 'tycoon',      name: 'Tycoon',      desc: 'Bank 250,000 gems',              kind: 'stat',    stat: 'gems_banked', goal: 250000 },
    { id: 'podium',      name: 'Podium',      desc: 'Finish a raid in the top 3',     kind: 'stat',    stat: 'top3',        goal: 1 },
    { id: 'champion',    name: 'Champion',    desc: 'Win a raid',                     kind: 'stat',    stat: 'raid_wins',   goal: 1 },
    { id: 'boss_slayer', name: 'Boss Slayer', desc: 'Land the final hit on a boss',   kind: 'event',                        goal: 1 },
    { id: 'survivor',    name: 'Survivor',    desc: 'Survive 30 minutes without dying', kind: 'event',                     goal: 1 },
    { id: 'streaker',    name: 'Streaker',    desc: 'Get a 5-knockout streak',        kind: 'event',                        goal: 1 },
    { id: 'hoarder',     name: 'Hoarder',     desc: 'Carry 3,000 gems at once',       kind: 'event',                        goal: 1 },
    { id: 'emerald_eye', name: 'Emerald Eye', desc: 'Grab 25 emeralds',               kind: 'counter',                      goal: 25 },
    { id: 'veteran',     name: 'Veteran',     desc: 'Play 250 games',                 kind: 'stat',    stat: 'lives',       goal: 250 },
];
const BY_ID = new Map(DEFS.map(a => [a.id, a]));
const STAT_DEFS = DEFS.filter(a => a.kind === 'stat');

function h() { return db.handle(); }

function unlockedSet(userId) {
    const d = h();
    if (!d) return new Set();
    return new Set(d.all('SELECT achievement_id AS id FROM user_achievements WHERE user_id = ? AND unlocked_at IS NOT NULL', userId).map(r => r.id));
}

// -> true if this call unlocked it
function unlock(userId, id, now = Date.now()) {
    const d = h();
    const def = BY_ID.get(id);
    if (!d || !def) return false;
    return d.run(`INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id, achievement_id) DO UPDATE SET unlocked_at = excluded.unlocked_at,
                      progress = MAX(progress, excluded.progress)
                  WHERE unlocked_at IS NULL`, userId, id, def.goal, now).changes > 0;
}

// Counter achievements. -> {progress, unlocked (by this call)}
function addProgress(userId, id, n, now = Date.now()) {
    const d = h();
    const def = BY_ID.get(id);
    n = Math.max(0, n | 0);
    if (!d || !def || !n) return { progress: 0, unlocked: false };
    return d.tx(() => {
        d.run(`INSERT INTO user_achievements (user_id, achievement_id, progress) VALUES (?, ?, ?)
               ON CONFLICT(user_id, achievement_id) DO UPDATE SET progress = progress + excluded.progress
               WHERE unlocked_at IS NULL`, userId, id, n);
        const row = d.get('SELECT progress, unlocked_at FROM user_achievements WHERE user_id = ? AND achievement_id = ?', userId, id);
        const progress = row ? row.progress | 0 : 0;
        const unlocked = !!row && row.unlocked_at == null && progress >= def.goal && unlock(userId, id, now);
        return { progress, unlocked };
    });
}

// Stat achievements the account now qualifies for. -> ids unlocked by this call
function checkStats(userId, now = Date.now()) {
    const d = h();
    if (!d) return [];
    const stats = d.get('SELECT * FROM user_stats WHERE user_id = ?', userId);
    if (!stats) return [];
    const have = unlockedSet(userId);
    const out = [];
    for (const a of STAT_DEFS) {
        if (have.has(a.id) || (stats[a.stat] | 0) < a.goal) continue;
        if (unlock(userId, a.id, now)) out.push(a.id);
    }
    return out;
}

// Every achievement with this account's progress (GET /api/achievements).
function list(userId) {
    const d = h();
    const rows = new Map(d.all('SELECT achievement_id, progress, unlocked_at FROM user_achievements WHERE user_id = ?', userId)
        .map(r => [r.achievement_id, r]));
    const stats = d.get('SELECT * FROM user_stats WHERE user_id = ?', userId) || {};
    return DEFS.map(a => {
        const r = rows.get(a.id);
        const unlockedAt = r && r.unlocked_at != null ? r.unlocked_at : null;
        let progress = a.kind === 'stat' ? stats[a.stat] | 0 : r ? r.progress | 0 : 0;
        if (unlockedAt != null) progress = a.goal;
        return { id: a.id, name: a.name, desc: a.desc, goal: a.goal, progress: Math.min(a.goal, progress), unlockedAt };
    });
}

module.exports = { DEFS, BY_ID, unlockedSet, unlock, addProgress, checkStats, list };
