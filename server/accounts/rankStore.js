// Ranked: the database side. The maths is in ranked.js; this file opens and
// settles rank_lives rows, moves users.rp / division / peak / placement, pays
// the raid placement bonus, and builds the RankSnap every client packet and
// /api/me carry:
//   {division (0..18) | null in placement, name, tier, rp, into, size, pct,
//    placement:{done, lives, of}, legendNo, peak:{division, name}}
//
// A life is settled exactly once: UPDATE rank_lives ... WHERE ended_at IS
// NULL decides, and a second settle of the same life returns null. Lives a
// crash left open are closed at boot with delta 0 (closeOrphans).
'use strict';

const db = require('./db');
const dust = require('./dust');
const ranked = require('./ranked');
const R = require('../../shared/ranks.js');

const LEGEND_CACHE_MS = 60 * 1000;
// rank_lives.end_reason spells the raid end with an underscore
const DB_REASON = { death: 'death', raidend: 'raid_end', disconnect: 'disconnect', shutdown: 'shutdown', crash: 'crash' };

function h() { return db.handle(); }
function isRanked(row) { return !!row && row.ranked_at != null; }

function parseBases(text) {
    try {
        const a = JSON.parse(text || '[]');
        return Array.isArray(a) ? a.map(n => Math.max(0, +n || 0)).slice(0, R.PLACEMENT_LIVES) : [];
    } catch (e) { return []; }
}

// Legend #N, cached per user for a minute (fresh:true skips the cache, for
// a result the player is about to see).
const legendCache = new Map();
function legendRank(row, opts = {}) {
    if (!row || !isRanked(row) || R.divisionOf(row.rp) !== R.LEGEND) return 0;
    const now = opts.now || Date.now();
    const hit = legendCache.get(row.id);
    if (!opts.fresh && hit && hit.rp === row.rp && now - hit.at < LEGEND_CACHE_MS) return hit.n;
    const d = h();
    if (!d) return hit ? hit.n : 0;
    const at = row.legend_at == null ? now : row.legend_at;
    const r = d.get(
        `SELECT count(*) AS n FROM users WHERE legend_at IS NOT NULL AND deleted_at IS NULL AND id <> ?
           AND (rp > ? OR (rp = ? AND (legend_at < ? OR (legend_at = ? AND id < ?))))`,
        row.id, row.rp, row.rp, at, at, row.id);
    const n = 1 + (r ? r.n | 0 : 0);
    legendCache.set(row.id, { n, rp: row.rp, at: now });
    if (legendCache.size > 5000) legendCache.clear();
    return n;
}

function snapshot(row, opts = {}) {
    if (!row) return null;
    const of = R.PLACEMENT_LIVES;
    if (!isRanked(row)) {
        return {
            division: null, name: R.nameOf(null), tier: null, rp: 0, into: 0, size: 0, pct: 0,
            placement: { done: false, lives: Math.min(of, row.placement_lives | 0), of },
            legendNo: 0, peak: { division: null, name: R.nameOf(null) },
        };
    }
    const p = R.progressOf(row.rp | 0);
    const peak = Math.max(p.division, row.peak_division | 0);
    return {
        division: p.division, name: p.name, tier: p.tier, rp: row.rp | 0, into: p.into, size: p.size,
        pct: Math.round(p.pct * 10000) / 10000,
        placement: { done: true, lives: of, of },
        legendNo: legendRank(row, opts),
        peak: { division: peak, name: R.nameOf(peak) },
    };
}

// Nameplate / board code for a user row.
function codeOf(row) {
    if (!row) return R.CODE_NONE;
    return isRanked(row) ? R.rankCode(R.divisionOf(row.rp), false) : R.rankCode(null, true);
}

// Opens a life at spawn. -> {rp, division, ranked} | null
function openLife({ lifeId, userId, raidKey, serverId, startedAt, basisStart, raidPtsStart }) {
    const d = h();
    if (!d) return null;
    const u = d.get('SELECT rp, division, ranked_at FROM users WHERE id = ? AND deleted_at IS NULL', userId);
    if (!u) return null;
    d.run(`INSERT INTO rank_lives (life_id, user_id, raid_key, server_id, rules_version, started_at, basis_start, raid_pts_start,
               rp_before, div_before, placement)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lifeId, userId, raidKey, serverId || null, R.RULES_VERSION, startedAt, Math.floor(basisStart) | 0, Math.floor(raidPtsStart) | 0,
        u.rp | 0, u.division | 0, u.ranked_at == null ? 1 : 0);
    return { rp: u.rp | 0, division: u.division | 0, ranked: u.ranked_at != null };
}

function bumpStats(d, userId, now, set) {
    d.run('INSERT OR IGNORE INTO user_stats (user_id, updated_at) VALUES (?, ?)', userId, now);
    d.run(`UPDATE user_stats SET lives = lives + ?, deaths = deaths + ?, kills = kills + ?, bot_kills = bot_kills + ?,
               best_life = MAX(best_life, ?), play_ms = play_ms + ?, raids = raids + ?, raid_wins = raid_wins + ?,
               top3 = top3 + ?, updated_at = ? WHERE user_id = ?`,
        set.lives | 0, set.deaths | 0, set.kills | 0, set.botKills | 0, set.bestLife | 0, Math.max(0, set.playMs | 0),
        set.raids | 0, set.raidWins | 0, set.top3 | 0, now, userId);
}

// Writes the new rank columns; peak, ranked_at and legend_at follow.
function writeRank(d, u, next, now) {
    const division = next.ranked ? R.divisionOf(next.rp) : 0;
    const peakDiv = next.ranked ? Math.max(u.ranked_at != null ? u.peak_division | 0 : 0, division) : 0;
    const peakRp = next.ranked ? Math.max(u.ranked_at != null ? u.peak_rp | 0 : 0, next.rp) : 0;
    d.run(`UPDATE users SET rp = ?, division = ?, peak_division = ?, peak_rp = ?, placement_lives = ?, placement_basis = ?,
               placement_gain = ?, ranked_at = ?, legend_at = ? WHERE id = ?`,
        next.rp | 0, division, peakDiv, peakRp, next.placementLives | 0, JSON.stringify(next.placementBasis || []),
        next.placementGain | 0, next.ranked ? (u.ranked_at != null ? u.ranked_at : now) : null,
        division === R.LEGEND ? (u.legend_at != null ? u.legend_at : now) : u.legend_at, u.id);
}

function stateOf(u) {
    return {
        rp: u.rp | 0, ranked: isRanked(u), placementLives: u.placement_lives | 0,
        placementBasis: parseBases(u.placement_basis), placementGain: u.placement_gain | 0,
    };
}

// Settles one open life. `life`: {lifeId, userId, reason:'death'|'raidend'|
// 'disconnect'|'shutdown', now, basis, countedBefore, durationMs, noFare,
// kills, botKills, sources:[[label, pts]], dust:{lifeMilli, balanceMilli}}.
// -> the RK payload, or null if the life was already settled (or is gone).
function settleLife(life) {
    const d = h();
    if (!d) return null;
    const now = life.now || Date.now();
    return d.tx(() => {
        const row = d.get('SELECT * FROM rank_lives WHERE life_id = ?', life.lifeId);
        if (!row || row.ended_at != null || row.user_id !== life.userId) return null;
        const u = d.get('SELECT * FROM users WHERE id = ?', life.userId);
        const endedAt = Math.max(row.started_at, now);
        if (!u || u.deleted_at != null) {
            d.run(`UPDATE rank_lives SET ended_at = ?, end_reason = ?, basis = 0, gain = 0, fare = 0, delta = 0,
                       rp_after = rp_before, div_after = div_before WHERE life_id = ? AND ended_at IS NULL`,
                endedAt, DB_REASON[life.reason] || 'crash', life.lifeId);
            return null;
        }
        const before = snapshot(u, { now });
        const wasRanked = isRanked(u);
        const r = ranked.settle(stateOf(u), {
            basis: life.basis, countedBefore: life.countedBefore, durationMs: life.durationMs,
            reason: life.reason, noFare: !!life.noFare,
        });
        const done = d.run(`UPDATE rank_lives SET ended_at = ?, end_reason = ?, basis = ?, gain = ?, fare = ?, delta = ?,
                                rp_before = ?, rp_after = ?, div_before = ?, div_after = ?, placement = ?, kills = ?, bot_kills = ?, dust_milli = ?
                            WHERE life_id = ? AND ended_at IS NULL`,
            endedAt, DB_REASON[life.reason] || 'death', r.basis, r.gain, r.fare, r.delta,
            u.rp | 0, r.rp, u.division | 0, r.ranked ? R.divisionOf(r.rp) : 0, wasRanked ? 0 : 1,
            life.kills | 0, life.botKills | 0, (life.dust && life.dust.lifeMilli) | 0, life.lifeId);
        if (!done.changes) return null;
        writeRank(d, u, r, now);
        bumpStats(d, u.id, now, {
            lives: 1, deaths: life.reason === 'death' ? 1 : 0, kills: life.kills, botKills: life.botKills,
            bestLife: r.basis, playMs: life.durationMs,
        });
        const afterRow = d.get('SELECT * FROM users WHERE id = ?', u.id);
        const after = snapshot(afterRow, { fresh: true, now });
        const rankUp = wasRanked ? after.division > before.division : !!(r.placement && r.placement.finished);
        return {
            v: 1, guest: false, reason: life.reason, before, after,
            basis: r.basis, gain: r.gain, fare: r.fare, delta: r.delta, capped: r.capped,
            parts: ranked.splitParts(r.gain, life.sources || []),
            placement: r.placement,
            rankUp, tierUp: wasRanked && R.isTierUp(before.division, after.division), rankDown: false,
            legendNo: after.legendNo | 0,
            dust: { lifeMilli: (life.dust && life.dust.lifeMilli) | 0, balanceMilli: (life.dust && life.dust.balanceMilli) | 0 },
        };
    });
}

// Raid end, per account that played it: raid_results row, stats, and the
// placement bonus (RP without a fare, plus exempt dust). Idempotent per
// (raid_key, user). -> {raidKey, place, of, score, bonusRP, bonusDustMilli,
// before, after, rankUp, tierUp, balanceMilli, eligible} | null
function applyRaidPlacement({ raidKey, userId, place, rows, score, raidMs, now }) {
    const d = h();
    if (!d) return null;
    now = now || Date.now();
    return d.tx(() => {
        const u = d.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', userId);
        if (!u) return null;
        const bonus = ranked.placementBonus({ place, rows, score, raidMs });
        const ins = d.run(`INSERT INTO raid_results (raid_key, user_id, place, board_rows, score, raid_ms, rp_bonus, dust_milli, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(raid_key, user_id) DO NOTHING`,
            raidKey, userId, Math.max(1, place | 0), Math.max(1, rows | 0), Math.max(0, score | 0), Math.max(0, raidMs | 0),
            bonus.rp, bonus.dustMilli, now);
        if (!ins.changes) return null;
        const before = snapshot(u, { now });
        const wasRanked = isRanked(u);
        if (bonus.rp) {
            const s = stateOf(u);
            if (wasRanked) s.rp += bonus.rp;
            else s.placementGain += bonus.rp;
            writeRank(d, u, s, now);
        }
        let balanceMilli = u.dust_milli | 0;
        if (bonus.dustMilli) balanceMilli = dust.creditExempt(userId, bonus.dustMilli, 'placement', raidKey, now) ?? balanceMilli;
        // wins and top-3s count on the same terms as the bonus (score, 5 minutes in, board size)
        const counts = bonus.eligible;
        bumpStats(d, userId, now, { raids: 1, raidWins: counts && place === 1 ? 1 : 0, top3: counts && place <= 3 ? 1 : 0 });
        const after = snapshot(d.get('SELECT * FROM users WHERE id = ?', userId), { fresh: true, now });
        return {
            raidKey, place: place | 0, of: rows | 0, score: score | 0, bonusRP: bonus.rp, bonusDustMilli: bonus.dustMilli,
            before, after,
            rankUp: wasRanked && after.division > before.division,
            tierUp: wasRanked && R.isTierUp(before.division, after.division),
            balanceMilli,
            eligible: !!counts,
        };
    });
}

// At boot: lives a crash (or a kill -9) left open close with delta 0.
function closeOrphans(now = Date.now()) {
    const d = h();
    if (!d) return 0;
    return d.run(`UPDATE rank_lives SET ended_at = MAX(started_at, ?), end_reason = 'crash', basis = COALESCE(basis, 0),
                      gain = 0, fare = 0, delta = 0, rp_after = rp_before, div_after = div_before
                  WHERE ended_at IS NULL`, now).changes;
}

// Test hook (ROYALE_DEBUG + ACCOUNTS_ALLOW_DEBUG only): put an account at
// `rp`, ranked, placement done.
function debugSetRp(userId, rp, now = Date.now()) {
    const d = h();
    if (!d) return null;
    rp = Math.max(0, Math.min(1e7, Math.floor(+rp || 0)));
    const division = R.divisionOf(rp);
    d.run(`UPDATE users SET rp = ?, division = ?, peak_division = MAX(peak_division, ?), peak_rp = MAX(peak_rp, ?),
               placement_lives = ?, placement_gain = 0, ranked_at = COALESCE(ranked_at, ?),
               legend_at = CASE WHEN ? THEN COALESCE(legend_at, ?) ELSE NULL END
           WHERE id = ? AND deleted_at IS NULL`,
        rp, division, division, rp, R.PLACEMENT_LIVES, now, division === R.LEGEND, now, userId);
    legendCache.delete(userId);
    return d.get('SELECT * FROM users WHERE id = ?', userId);
}

module.exports = {
    DB_REASON, isRanked, snapshot, codeOf, legendRank, openLife, settleLife, applyRaidPlacement, closeOrphans, debugSetRp,
};
