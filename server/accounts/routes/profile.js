// GET /api/profile?u=<username | DW- id>   (accounts only; 404 when either
//     side has blocked the other, same as a missing player)
// GET /api/leaderboard?limit=100          (anyone; `me` is null for guests)
//
// The Top 100 is ranked accounts only (placement finished, not deleted, not
// banned), by rp, cached 60 s. Legend #N follows rankStore.legendRank's order
// (rp, then who reached Legend first, then id).
'use strict';

const db = require('../db');
const users = require('../users');
const friends = require('../friends');
const rankStore = require('../rankStore');
const store = require('../store');
const events = require('./events');
const { HttpError, str } = require('../http');
const R = require('../../../shared/ranks.js');

const BOARD_CACHE_MS = 60 * 1000;
const BOARD_MAX = 100;
const FAR = 9e15;

function h() { return db.handle(); }

function tiersReached(row) {
    if (!row || row.ranked_at == null) return [];
    const peak = Math.max(R.divisionOf(row.rp | 0), row.peak_division | 0);
    return R.TIERS.slice(0, R.TIERS.indexOf(R.tierOf(peak)) + 1);
}

function statsOf(userId) {
    const s = h().get('SELECT * FROM user_stats WHERE user_id = ?', userId) || {};
    return {
        lives: s.lives | 0, kills: s.kills | 0, raidWins: s.raid_wins | 0, top3: s.top3 | 0,
        gemsBanked: s.gems_banked | 0, bestLife: s.best_life | 0,
    };
}

function relation(me, other) {
    if (me === other) return 'self';
    if (friends.areFriends(me, other)) return 'friend';
    if (h().get('SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ?', me, other)) return 'outgoing';
    if (h().get('SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ? AND silent = 0', other, me)) return 'incoming';
    return 'none';
}

function lookup(u) {
    const q = str(u, 32).trim();
    if (!q) return null;
    return /^dw-/i.test(q) ? users.byPublicId(q) : users.byUsername(q);
}

// -> Profile
function profileOf(row, viewerId, now = Date.now()) {
    const snap = rankStore.snapshot(row, { now });
    const cos = store.cosmeticsFor(row);
    const rel = relation(viewerId, row.id);
    const f = rel === 'friend' ? h().get('SELECT created_at FROM friendships WHERE user_lo = ? AND user_hi = ?',
        Math.min(viewerId, row.id), Math.max(viewerId, row.id)) : null;
    return {
        userId: row.public_id,
        username: row.username,
        createdAt: row.created_at,
        rank: snap,
        peak: { division: snap.peak.division, name: snap.peak.name, tier: R.tierOf(snap.peak.division), rp: row.ranked_at == null ? 0 : row.peak_rp | 0 },
        tiers: tiersReached(row),
        achievements: h().all('SELECT achievement_id AS id, unlocked_at AS unlockedAt FROM user_achievements WHERE user_id = ? AND unlocked_at IS NOT NULL ORDER BY unlocked_at',
            row.id),
        stats: statsOf(row.id),
        nameStyleNid: cos.nameStyleNid, skinNid: cos.skinNid, nameColor: cos.nameColor,
        relation: rel,
        friendsSince: f ? f.created_at : null,
        presence: rel === 'friend' || rel === 'self' ? events.presenceOf(row) : null,
    };
}

function getProfile(ctx) {
    const a = ctx.requireAuth();
    const row = lookup(ctx.query.get('u'));
    if (!row || (row.id !== a.user.id && friends.blockedEitherWay(a.user.id, row.id))) {
        throw new HttpError(404, 'user_not_found', 'No such player.');
    }
    ctx.json(200, profileOf(row, a.user.id));
}

// ---- leaderboard ----

let boardCache = null;   // {at, rows}

function boardRow(row, place, legendNo) {
    const div = R.divisionOf(row.rp | 0);
    const cos = store.cosmeticsFor(row);
    return {
        place, userId: row.public_id, username: row.username, rp: row.rp | 0,
        division: div, name: R.nameOf(div), tier: R.tierOf(div), legendNo,
        nameStyleNid: cos.nameStyleNid, nameColor: cos.nameColor,
    };
}

const RANKED_WHERE = 'ranked_at IS NOT NULL AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until <= ?)';

function topRows(now) {
    if (boardCache && now - boardCache.at < BOARD_CACHE_MS) return boardCache.rows;
    const list = h().all(`SELECT * FROM users WHERE ${RANKED_WHERE}
                          ORDER BY rp DESC, COALESCE(legend_at, ${FAR}) ASC, id ASC LIMIT ${BOARD_MAX}`, now);
    let legends = 0;
    const rows = list.map((r, i) => boardRow(r, i + 1, R.divisionOf(r.rp | 0) === R.LEGEND ? ++legends : 0));
    boardCache = { at: now, rows };
    return rows;
}

function myRow(row, now) {
    if (!row || row.ranked_at == null) return null;
    const lat = row.legend_at == null ? FAR : row.legend_at;
    const ahead = h().get(`SELECT count(*) AS n FROM users WHERE ${RANKED_WHERE} AND id <> ?
                             AND (rp > ? OR (rp = ? AND (COALESCE(legend_at, ${FAR}) < ? OR (COALESCE(legend_at, ${FAR}) = ? AND id < ?))))`,
        now, row.id, row.rp, row.rp, lat, lat, row.id).n | 0;
    // everyone ahead of a Legend is a Legend too, so Legend #N is the place
    return boardRow(row, ahead + 1, R.divisionOf(row.rp | 0) === R.LEGEND ? ahead + 1 : 0);
}

function getLeaderboard(ctx) {
    const now = Date.now();
    const lim = Math.max(1, Math.min(BOARD_MAX, parseInt(ctx.query.get('limit'), 10) || BOARD_MAX));
    const a = ctx.auth();
    const rows = topRows(now);
    ctx.json(200, { updatedAt: boardCache.at, rows: rows.slice(0, lim), me: a ? myRow(users.byId(a.user.id) || a.user, now) : null });
}

function clearCache() { boardCache = null; }

function register(router) {
    router.add('GET', '/api/profile', getProfile);
    router.add('GET', '/api/leaderboard', getLeaderboard);
}

module.exports = { register, profileOf, tiersReached, clearCache, topRows, statsOf };
