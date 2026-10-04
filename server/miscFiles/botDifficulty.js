// How hard raid bots play against one particular player: a number from 0
// (a brand-new player) to 1 (the best we ever want them). Bots read it per
// target, so one bot fighting a newcomer and a veteran plays each differently.
// dig_royale.js stamps it on every human body about once a second
// (body.botDifficulty); controllers.js and subFunctions.shotMult read it.
//
// Who gets what:
//   new player             0, fading into the numbers below (newness)
//   signed in, ranked      Bronze I 0.20 ... Gold I 0.45 ... Diamond I 0.70
//                          ... Legend 0.95 (+ up to 0.08 for a strong raid)
//   signed in, in placement / guests   the higher of
//       this raid:  0.15 + 0.70 * (1 - e^-(score/10000 + kills/10))
//                   score 0 -> 0.15, 2k + 1 kill -> 0.33, 5k + 3 -> 0.54,
//                   10k + 5 -> 0.69, 20k + 10 -> 0.82
//       time played in all:  0.15 + 0.45 * (1 - e^-(minutes/15))
//                   10 min -> 0.37, 15 -> 0.43, 30 -> 0.54, 60 -> 0.59
//       never past 0.85 (placement 0.5). The next raid starts from 60% of
//       the best reached this session.
//   under bot mercy (dying to bots over and over)      at most 0.15
//   idle a minute (no real input, whatever the above)   at least 0.5
//   bots, bosses, anything else                        0.5
//
// Newness (1 brand new .. 0 not new) is the lower of two fades: total play
// time (account or guest play_ms plus this session), full for the first
// 5 minutes and gone at 12; and lives started, full for the first 5 and gone
// by the 9th. A strong player who rarely dies stops being new on the clock;
// one who dies a lot stops on lives (mercy still covers them).
//
// 0.5 plays like the 07e28b1 tuning.
//
// Lock-on (ROYALE_BOTS_LOCKON, on unless set to 0): once a player is past
// the newcomer fade, bots stop holding back. Signed-in ranked players get 1
// straight away; guests climb on play time (0.55 when newness ends at 5
// minutes, 1 by 15 minutes in all) or on a strong raid, whichever is higher.
// Above 0.5 every knob runs from the 07e28b1 value to a lock-on value: near
// zero aim error, full lead, ~0.1-0.2 s reactions, full damage, longer and
// further fights, up to three hunters on a rich veteran. Below 0.5 nothing
// changes, so newcomers and players under mercy get exactly the old bots.
// With lock-on off the old mapping and the old ceiling (1 softer than the
// bots before 07e28b1) come back.
'use strict';

const activity = require('../game/network/activity.js');
const Ranks = require('../../shared/ranks.js');

const NEUTRAL = 0.5;
const RANK_LO = 0.2, RANK_HI = 0.95, RANK_PERF = 0.08;
const GUEST_LO = 0.15, GUEST_HI = 0.85, PLACEMENT_HI = 0.5;
const PERF_SCORE = 10000, PERF_KILLS = 10;
const SESSION_KEEP = 0.6;
const MERCY_MAX = 0.15;
// the difficulty climbs Bronze I .. Legend I and stays at the top past it
const LEGEND = Ranks.LEGEND;
const TIME_HI = 0.6, TIME_TAU_MS = 15 * 60_000;
const NEW_FULL_MS = 5 * 60_000, NEW_END_MS = 12 * 60_000;
const NEW_FULL_LIVES = 5, NEW_END_LIVES = 9;
const LOCK_FULL_MS = 15 * 60_000, LOCK_FROM = 0.55, LOCK_PERF = 1.5, LOCK_KEEP = 0.9;
// rich veterans: this much carried (or hunted level 2) lets a third bot on
const RICH_CARRY = 1500;

let lockOn = process.env.ROYALE_BOTS_LOCKON !== '0';
function setLockOn(v) { lockOn = !!v; }
function isLockOn() { return lockOn; }

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
function lerp(a, b, d) { return a + (b - a) * clamp01(d); }
// 0 at or below NEUTRAL, 1 at the top: how far into lock-on a difficulty is
function lockShare(d) { return lockOn && d > NEUTRAL ? clamp01((d - NEUTRAL) / (1 - NEUTRAL)) : 0; }
// a knob: the old curve up to NEUTRAL, then on toward its lock-on value
function knob(d, old, lock) {
    const h = lockShare(d);
    return h > 0 ? lerp(old(NEUTRAL), lock, h) : old(d);
}

// 0..1: how well this raid is going
function perfShare(score, kills) {
    const p = Math.max(0, +score || 0) / PERF_SCORE + Math.max(0, +kills || 0) / PERF_KILLS;
    return 1 - Math.exp(-p);
}
function fromRaid(score, kills) {
    return GUEST_LO + (GUEST_HI - GUEST_LO) * perfShare(score, kills);
}
// a guest's floor from time played, whatever this raid looks like
function fromTime(playMs) {
    return GUEST_LO + (TIME_HI - GUEST_LO) * (1 - Math.exp(-Math.max(0, +playMs || 0) / TIME_TAU_MS));
}
// playMs: total time played; lives: lives started, this one included
function newness(playMs, lives) {
    const byTime = 1 - clamp01(((+playMs || 0) - NEW_FULL_MS) / (NEW_END_MS - NEW_FULL_MS));
    const byLives = 1 - clamp01(((lives | 0) - NEW_FULL_LIVES) / (NEW_END_LIVES - NEW_FULL_LIVES));
    return Math.min(byTime, byLives);
}
// rankCode (shared/ranks.js rankCode/fromCode): 0 none, 20 placement, the
// rest a division
function rankedDivision(code) {
    const r = Ranks.fromCode(code);
    return r && !r.placement ? r.division : null;
}
function fromRank(code) {
    const div = rankedDivision(code);
    if (div == null) return null;
    return RANK_LO + (RANK_HI - RANK_LO) * Math.min(div, LEGEND) / LEGEND;
}

// p: { newbie, newness, rankCode, score, kills, sessionBest, playMs }
function forPlayer(p) {
    const fresh = p.newbie ? 1 : clamp01(+p.newness || 0);
    if (fresh >= 1) return 0;
    return settled(p) * (1 - fresh);
}
// lock-on: a guest's floor from time played
function lockFromTime(playMs) {
    return LOCK_FROM + (1 - LOCK_FROM) * clamp01(((+playMs || 0) - NEW_FULL_MS) / (LOCK_FULL_MS - NEW_FULL_MS));
}
// what the player gets once they are not new at all
function settled(p) {
    if (lockOn) return settledLockOn(p);
    const rank = fromRank(p.rankCode);
    if (rank != null) return Math.min(RANK_HI, rank + RANK_PERF * perfShare(p.score, p.kills));
    let d = Math.max(fromRaid(p.score, p.kills), fromTime(p.playMs));
    const best = +p.sessionBest || 0;
    if (best > GUEST_LO) d = Math.max(d, GUEST_LO + (best - GUEST_LO) * SESSION_KEEP);
    if ((p.rankCode | 0) === Ranks.CODE_PLACEMENT) d = Math.min(d, PLACEMENT_HI);
    return Math.min(GUEST_HI, d);
}
function settledLockOn(p) {
    if (rankedDivision(p.rankCode) != null) return 1;
    let d = Math.max(lockFromTime(p.playMs), GUEST_LO + (1 - GUEST_LO) * clamp01(perfShare(p.score, p.kills) * LOCK_PERF));
    const best = +p.sessionBest || 0;
    if (best > GUEST_LO) d = Math.max(d, best * LOCK_KEEP);
    return clamp01(d);
}

// The difficulty a bot plays at against `root` (a target's root body). A
// player idle past activity.IDLE_PROTECT_MS loses the newcomer softening and
// mercy: at least NEUTRAL, whoever they are.
function of(root, now = Date.now()) {
    if (!root || !root.isPlayer) return NEUTRAL;
    let d = root.botNewbie ? 0 : root.botDifficulty != null ? root.botDifficulty : NEUTRAL;
    if (activity.unprotected(root, now)) return clamp01(Math.max(d, NEUTRAL));
    if ((root.socket?.botMercyUntil || 0) > now) d = Math.min(d, MERCY_MAX);
    return clamp01(d);
}

// ── the knobs, each as (bot skill, difficulty) ───────────────────────────
// (pre-07e28b1 formula in brackets; with lock-on off d = 1 stays under it)
const oldAimError = (s, d) => lerp(0.05, 0.02, d) + (1 - s) * lerp(0.12, 0.075, d);
const oldAimStiff = (s, d) => lerp(0.09, 0.145, d) + s * lerp(0.17, 0.21, d);
const oldReaction = (s, d, r) => lerp(450, 210, d) + (1 - s) * lerp(550, 400, d) + r * lerp(300, 180, d);
const oldPause = (s, d, r) => lerp(420, 230, d) + r * lerp(800, 480, d) * (1.4 - s);

// cursor error, std dev in radians, re-rolled every 110 ms [(1-s)*0.07]
function aimError(s, d) { return knob(d, x => oldAimError(s, x), 0.004 + (1 - s) * 0.008); }
// aim spring stiffness [0.16 + 0.22s]
function aimStiff(s, d) { return knob(d, x => oldAimStiff(s, x), 0.5 + s * 0.08); }
// aim spring damping (share of last tick's turn kept) [0.55 + 0.25s]
function aimDamp(s, d) { return knob(d, () => 0.55 + s * 0.25, 0.38); }
// share of the full lead the bot aims ahead by [0.5 + 0.5s]
function leadShare(s, d) { return knob(d, x => lerp(0.2, 0.45, x) + s * 0.5, 1); }
// ms before a new target is engaged, r in 0..1 [160 + 380(1-s) + 160r]
function reactionMs(s, d, r) { return knob(d, x => oldReaction(s, x, r), 70 + (1 - s) * 50 + r * 60); }
// trigger released before a burst [200 + 450r(1.4-s)]; burst length [1300 + 2400r]
function pauseMs(s, d, r) { return knob(d, x => oldPause(s, x, r), 40 + r * 90); }
function burstMs(d, r) { return knob(d, x => lerp(700, 1250, x) + r * lerp(1500, 2300, x), 2600 + r * 2400); }
// bullet / drone / trap damage share [1]
function shotMult(d) { return knob(d, x => lerp(0.64, 0.92, x), 1); }
// bots that may hunt one player at once [2]; lock-on lets a third onto a
// veteran with a fat satchel (or one the raid marks as the top target)
function maxHunters(d, carried = 0, hunted = 0) {
    if (d < 0.35) return 1;
    if (lockOn && d >= 0.8 && ((+carried || 0) >= RICH_CARRY || (hunted | 0) >= 2)) return 3;
    return 2;
}
// bots the director keeps within sight of a player [4]
function company(d) { return d < 0.3 ? 1 : d < 0.75 ? 2 : 3; }
// a bot starts a fight only when the trade looks at most this bad [1.2]
function initThreat(d) { return knob(d, x => lerp(0.85, 1.2, x), 1.7); }
// ...and only from this close [1400]
function initRange(d) { return knob(d, x => lerp(800, 1400, x), 1900); }
// target choice: a player counts as this much farther away [0]
function targetPenalty(d) { return knob(d, x => lerp(400, 0, x), 0); }
// the soft window at the start of a life: its length share, the range at
// which a soft player gets fought anyway, and the aim it still costs
function softShare(d) { return knob(d, x => lerp(1, 0.35, x), 0.2); }
function softCloseR(d) { return knob(d, x => lerp(320, 520, x), 650); }
function softAim(d) { return knob(d, x => lerp(0.7, 0.85, x), 0.95); }
// auto turrets: extra aim noise and turn-rate share [0, 1]
function turretNoise(d) { return knob(d, x => lerp(0.06, 0, x), 0); }
function turretTurn(d) { return knob(d, x => lerp(0.7, 1, x), 1.15); }
// how hard the bot plays the fight itself (dodging, cover, jukes): 0 below
// NEUTRAL, 1 at full lock-on
function tactics(d) { return lockShare(d); }

module.exports = {
    NEUTRAL, NEW_FULL_MS, NEW_END_MS, NEW_FULL_LIVES, NEW_END_LIVES, LOCK_FULL_MS, RICH_CARRY,
    setLockOn, isLockOn, lockShare, lockFromTime,
    lerp, perfShare, fromRaid, fromTime, fromRank, newness, forPlayer, settled, of,
    aimError, aimStiff, aimDamp, leadShare, reactionMs, pauseMs, burstMs, shotMult, maxHunters, company,
    initThreat, initRange, targetPenalty, softShare, softCloseR, softAim, turretNoise, turretTurn, tactics,
};
