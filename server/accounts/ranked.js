// Ranked maths: no database, no game state, so every rule here is unit
// tested on its own (scripts/test/ranked.test.js). The tables themselves
// (divisions, curve, fares, placement map, dust rates) live in
// shared/ranks.js, which the client loads too.
//
// Units: raid points are whole numbers; RP is stored whole. The curve is
// evaluated exactly in 1/192 RP (every rate is a whole number of those), so
// the RP of a raid does not depend on how it was split into lives:
// curveGain(a, b) + curveGain(a + b, c) === curveGain(a, b + c).
'use strict';

const R = require('../../shared/ranks.js');

const MIN_FARE_MS = 30 * 1000;          // shorter lives never pay the fare
const PLACEMENT_MIN_MS = 60 * 1000;     // a placement life counts from 60 s, or with points
const SPAWN_KILL_MS = 15 * 1000;        // victim alive less than this: the kill pays nothing
const SAME_VICTIM_PAID = 2;             // the 3rd+ kill of one account in a raid pays nothing
const BONUS_MIN_RAID_MS = 5 * 60 * 1000;
// Ends that never charge the fare. A disconnect does; a spawn-killed life
// is exempted per life (noFare).
const NO_FARE_REASONS = new Set(['shutdown', 'crash', 'raidend']);

const UNITS = 192;
const CURVE_UNITS = R.CURVE.map(([to, rate]) => [to, Math.round(rate * UNITS)]);

// Raid points -> RP in 1/192 units, exact for whole points.
function curveUnits(points) {
    const p = Math.max(0, Math.floor(+points || 0));
    let units = 0, from = 0;
    for (const [to, k] of CURVE_UNITS) {
        const span = Math.min(p, to) - from;
        if (span <= 0) break;
        units += span * k;
        from = to;
    }
    return units;
}

// Whole RP for `delta` new points when the account already counted
// `countedBefore` this raid (before the life cap).
function curveGain(countedBefore, delta) {
    const a = Math.max(0, Math.floor(+countedBefore || 0));
    const d = Math.max(0, Math.floor(+delta || 0));
    return Math.floor(curveUnits(a + d) / UNITS) - Math.floor(curveUnits(a) / UNITS);
}

// The same, capped at LIFE_CAP.
function lifeGain(countedBefore, delta) {
    return Math.min(R.LIFE_CAP, curveGain(countedBefore, delta));
}

function fareFor({ division, durationMs, reason, noFare, placement }) {
    if (placement || noFare || NO_FARE_REASONS.has(reason)) return 0;
    if (!(durationMs >= MIN_FARE_MS)) return 0;
    return R.DIVISIONS[Math.max(0, Math.min(R.LEGEND, division | 0))].fare;
}

// gain - fare, never below the floor of the division the player is in now.
// -> {rp, division, delta}
function applyDelta(rp, gain, fare) {
    rp = Math.max(0, Math.floor(+rp || 0));
    const floor = R.floorOf(R.divisionOf(rp));
    const next = Math.max(floor, rp + Math.max(0, gain | 0) - Math.max(0, fare | 0));
    return { rp: next, division: R.divisionOf(next), delta: next - rp };
}

function countsForPlacement(durationMs, basis) {
    return durationMs >= PLACEMENT_MIN_MS || basis > 0;
}

// Three counted placement lives -> the starting division (average of the
// best two bases, capped at Gold I) and the RP they earned, kept inside it.
function placementFinish(bases, gain) {
    const best = (bases || []).map(b => Math.max(0, +b || 0)).sort((a, b) => b - a).slice(0, 2);
    const avg = best.length ? best.reduce((a, b) => a + b, 0) / best.length : 0;
    const division = R.placementStart(avg);
    const d = R.DIVISIONS[division];
    return { division, rp: d.floor + Math.min(Math.max(0, gain | 0), d.size - 1), avg };
}

// One life, settled. `user`: {rp, ranked, placementLives, placementBasis:[],
// placementGain}; `life`: {basis, countedBefore, durationMs, reason, noFare}.
// -> {gain, rawGain, capped, fare, delta, rp, division, ranked, placementLives,
//     placementBasis, placementGain, placement:null|{...}, counted}
function settle(user, life) {
    const basis = Math.max(0, Math.floor(+life.basis || 0));
    const rawGain = curveGain(life.countedBefore, basis);
    const gain = Math.min(R.LIFE_CAP, rawGain);
    const out = {
        basis, gain, rawGain, capped: rawGain > R.LIFE_CAP, fare: 0, delta: 0,
        rp: Math.max(0, user.rp | 0), division: R.divisionOf(user.rp | 0), ranked: !!user.ranked,
        placementLives: user.placementLives | 0, placementBasis: (user.placementBasis || []).slice(),
        placementGain: user.placementGain | 0, placement: null, counted: true,
    };
    if (!user.ranked) {
        out.counted = countsForPlacement(life.durationMs, basis);
        if (out.counted) {
            out.placementLives += 1;
            out.placementBasis.push(basis);
            out.placementGain += gain;
        }
        out.delta = out.counted ? gain : 0;
        let startDivision = null;
        const finished = out.placementLives >= R.PLACEMENT_LIVES;
        if (finished) {
            const f = placementFinish(out.placementBasis, out.placementGain);
            out.rp = f.rp;
            out.division = f.division;
            out.ranked = true;
            startDivision = f.division;
        }
        out.placement = { inPlacement: !finished, lives: Math.min(R.PLACEMENT_LIVES, out.placementLives), of: R.PLACEMENT_LIVES, finished, startDivision };
        return out;
    }
    out.fare = fareFor({ division: out.division, durationMs: life.durationMs, reason: life.reason, noFare: life.noFare });
    const a = applyDelta(out.rp, gain, out.fare);
    out.rp = a.rp;
    out.division = a.division;
    out.delta = a.delta;
    return out;
}

// Raid-end bonus for the board place (bots count for places, only accounts
// are paid). -> {eligible, rp, dustMilli}
function placementBonus({ place, rows, score, raidMs }) {
    place |= 0;
    const eligible = score > 0 && raidMs >= BONUS_MIN_RAID_MS && place >= 1 && place <= 10 &&
        place <= Math.max(3, Math.ceil((rows | 0) / 2));
    if (!eligible) return { eligible: false, rp: 0, dustMilli: 0 };
    return { eligible: true, rp: R.PLACEMENT_BONUS_RP[place - 1] | 0, dustMilli: R.PLACEMENT_BONUS_DUST_MILLI[place - 1] | 0 };
}

// What one kill is worth to the killer. pts: every point the kill paid
// (kill score, streak, shutdown, bounty); priorKills: earlier kills of this
// victim by this killer's account in this raid.
// -> {discount (points taken off the rank basis), dustMilli, spawnKill, filtered}
function killFilter({ victimIsBot, victimAliveMs, priorKills, pts }) {
    pts = Math.max(0, +pts || 0);
    if (victimAliveMs < SPAWN_KILL_MS) return { discount: pts, dustMilli: 0, spawnKill: true, filtered: true };
    if (!victimIsBot && (priorKills | 0) >= SAME_VICTIM_PAID) return { discount: pts, dustMilli: 0, spawnKill: false, filtered: true };
    if (victimIsBot) return { discount: Math.ceil(pts / 2), dustMilli: R.KILL_DUST_MILLI.bot, spawnKill: false, filtered: false };
    return { discount: 0, dustMilli: R.KILL_DUST_MILLI.player, spawnKill: false, filtered: false };
}

// Legend #N: 1 + Legends with more RP; equal RP goes to whoever reached
// Legend first (then the older account). rows: [{id, rp, legendAt}].
function legendOrder(rows) {
    return rows.slice().sort((a, b) => (b.rp - a.rp) || ((a.legendAt ?? Infinity) - (b.legendAt ?? Infinity)) || (a.id - b.id));
}
function legendNo(rows, id) {
    const i = legendOrder(rows).findIndex(r => r.id === id);
    return i < 0 ? 0 : i + 1;
}

// Split `total` RP across labelled point sources by their share of the
// basis; the rounding remainder goes to the largest. -> [[label, rp], ...]
function splitParts(total, sources) {
    const list = sources.filter(([, pts]) => pts > 0);
    const sum = list.reduce((a, [, pts]) => a + pts, 0);
    if (!(total > 0) || !(sum > 0)) return [];
    const parts = list.map(([label, pts]) => [label, Math.floor(total * pts / sum)]);
    const left = total - parts.reduce((a, [, rp]) => a + rp, 0);
    let big = 0;
    for (let i = 1; i < list.length; i++) if (list[i][1] > list[big][1]) big = i;
    parts[big][1] += left;
    return parts.filter(([, rp]) => rp > 0);
}

module.exports = {
    MIN_FARE_MS, PLACEMENT_MIN_MS, SPAWN_KILL_MS, SAME_VICTIM_PAID, BONUS_MIN_RAID_MS, NO_FARE_REASONS,
    curveUnits, curveGain, lifeGain, fareFor, applyDelta, countsForPlacement, placementFinish, settle,
    placementBonus, killFilter, legendOrder, legendNo, splitParts,
};
