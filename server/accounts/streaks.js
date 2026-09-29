// Play and win streaks (user_streaks rows), both paying gemdust exempt from
// the daily soft cap, like placement and quest dust.
//
// Play streak: UTC days (reset at 00:00 UTC) in a row with at least one
// counted life, by the rule ranked uses for placement (60 s, or any
// points; a voided leave never settles, so it never counts). The first
// counted life of a day pays PLAY_MILLI[day - 1], flat from day 7. A missed
// day starts over at 1. Paid inside rankStore.settleLife's transaction, so
// a life settles and pays exactly once and play_day decides the day.
//
// Win streak: raids in a row placed #1 on the terms the placement bonus
// and the Champion achievement use (score, 5 minutes in the raid, a board
// big enough; bots count for places like they do there). In duos the
// team's place is both partners' place. Only a raid the player really
// played moves it: a counted life this raid and at least WIN_ACTIVE_MS of
// active play (ranked's survival rule, so AFK and shielded time don't
// count). Such a raid without the win resets it to 0; a raid they didn't
// really play leaves it alone. Paid inside rankStore.applyRaidPlacement's
// transaction (once per raid and account); win_raid guards it too. Win
// dust stops at WIN_DAY_CAP_MILLI per UTC day, the streak keeps counting.
'use strict';

const db = require('./db');
const dust = require('./dust');

const DAY = 24 * 60 * 60 * 1000;
const PLAY_MILLI = [250, 500, 750, 1000, 1250, 1500, 2000];
const WIN_MILLI = [250, 500, 750, 1000, 1250];
const WIN_DAY_CAP_MILLI = 5000;
const WIN_ACTIVE_MS = 60 * 1000;

function h() { return db.handle(); }
function dayOf(ms) { return Math.floor(ms / DAY); }

const playReward = (n) => n > 0 ? PLAY_MILLI[Math.min(n, PLAY_MILLI.length) - 1] : 0;
const winReward = (n) => n > 0 ? WIN_MILLI[Math.min(n, WIN_MILLI.length) - 1] : 0;

// Pure. st: {cur, best, day}. -> {cur, best, day, pay, changed}
function nextPlay(st, day) {
    const last = st.day | 0;
    if (last >= day) return { cur: st.cur | 0, best: st.best | 0, day: last, pay: 0, changed: false };
    const cur = last === day - 1 && (st.cur | 0) > 0 ? (st.cur | 0) + 1 : 1;
    return { cur, best: Math.max(st.best | 0, cur), day, pay: playReward(cur), changed: true };
}

// Pure. st: {cur, best, raid, day, dayMilli}; r: {raidKey, day, win, played}
// -> {cur, best, raid, day, dayMilli, pay, changed, reset}
function nextWin(st, r) {
    const same = { cur: st.cur | 0, best: st.best | 0, raid: st.raid || null, day: st.day | 0, dayMilli: st.dayMilli | 0, pay: 0, changed: false, reset: false };
    if (!r.played || (st.raid && st.raid === r.raidKey)) return same;
    if (!r.win) return Object.assign(same, { cur: 0, raid: r.raidKey, changed: true, reset: same.cur > 0 });
    const cur = same.cur + 1;
    const dayMilli = same.day === r.day ? same.dayMilli : 0;
    const pay = Math.max(0, Math.min(winReward(cur), WIN_DAY_CAP_MILLI - dayMilli));
    return { cur, best: Math.max(same.best, cur), raid: r.raidKey, day: r.day, dayMilli: dayMilli + pay, pay, changed: true, reset: false };
}

function rowOf(d, userId) {
    return d.get('SELECT * FROM user_streaks WHERE user_id = ?', userId);
}

function ensureRow(d, userId, now) {
    d.run('INSERT OR IGNORE INTO user_streaks (user_id, updated_at) VALUES (?, ?)', userId, now);
    return rowOf(d, userId);
}

// A counted life settled (inside settleLife's transaction).
// -> {kind:'play', streak, best, rewardMilli, balanceMilli} | null (not the day's first)
function onLife(d, userId, now) {
    const row = ensureRow(d, userId, now);
    const day = dayOf(now);
    const n = nextPlay({ cur: row.play_cur, best: row.play_best, day: row.play_day }, day);
    if (!n.changed) return null;
    const done = d.run('UPDATE user_streaks SET play_cur = ?, play_best = ?, play_day = ?, updated_at = ? WHERE user_id = ? AND play_day < ?',
        n.cur, n.best, n.day, now, userId, day);
    if (!done.changes) return null;
    const balance = n.pay ? dust.creditExempt(userId, n.pay, 'streak_play', 'streak_play:' + day, now) : null;
    return { kind: 'play', streak: n.cur, best: n.best, rewardMilli: balance == null ? 0 : n.pay, balanceMilli: balance };
}

// The raid placement row was just written (inside applyRaidPlacement's
// transaction). r: {raidKey, win, played}
// -> {kind:'win', streak, best, rewardMilli, balanceMilli, reset} | null (nothing moved)
function onRaid(d, userId, r, now) {
    const row = ensureRow(d, userId, now);
    const n = nextWin({ cur: row.win_cur, best: row.win_best, raid: row.win_raid, day: row.win_day, dayMilli: row.win_day_milli },
        { raidKey: r.raidKey, day: dayOf(now), win: !!r.win, played: !!r.played });
    if (!n.changed) return null;
    const done = d.run(`UPDATE user_streaks SET win_cur = ?, win_best = ?, win_raid = ?, win_day = ?, win_day_milli = ?, updated_at = ?
                        WHERE user_id = ? AND (win_raid IS NULL OR win_raid <> ?)`,
        n.cur, n.best, n.raid, n.day, n.dayMilli, now, userId, r.raidKey);
    if (!done.changes) return null;
    const balance = n.pay ? dust.creditExempt(userId, n.pay, 'streak_win', 'streak_win:' + r.raidKey, now) : null;
    return { kind: 'win', streak: n.cur, best: n.best, rewardMilli: balance == null ? 0 : n.pay, balanceMilli: balance, reset: n.reset };
}

// What the menu shows. A play streak whose last day is before yesterday is
// already broken (0); `today` says whether today is already counted.
// -> {play:{current, best, today, rewardMilli, nextMilli, maxDay, maxMilli, resetsAt}, win:{current, best, nextMilli}}
function view(userId, now = Date.now()) {
    const d = h();
    const row = d ? rowOf(d, userId) : null;
    const day = dayOf(now);
    const pDay = row ? row.play_day | 0 : 0;
    const today = !!row && pDay === day && (row.play_cur | 0) > 0;
    const alive = !!row && pDay >= day - 1 && (row.play_cur | 0) > 0;
    const current = alive ? row.play_cur | 0 : 0;
    const winCur = row ? row.win_cur | 0 : 0;
    return {
        play: {
            current, best: row ? row.play_best | 0 : 0, today,
            // what today paid; nextMilli is what the next paying life gets
            rewardMilli: today ? playReward(current) : 0,
            nextMilli: playReward(current + 1),
            maxDay: PLAY_MILLI.length, maxMilli: PLAY_MILLI[PLAY_MILLI.length - 1],
            resetsAt: (day + 1) * DAY,
        },
        win: { current: winCur, best: row ? row.win_best | 0 : 0, nextMilli: winReward(winCur + 1), dayCapMilli: WIN_DAY_CAP_MILLI },
    };
}

module.exports = {
    DAY, PLAY_MILLI, WIN_MILLI, WIN_DAY_CAP_MILLI, WIN_ACTIVE_MS,
    dayOf, playReward, winReward, nextPlay, nextWin, onLife, onRaid, view,
};
