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
//   bots, bosses, anything else                        0.5
//
// Newness (1 brand new .. 0 not new) is the lower of two fades: total play
// time (account or guest play_ms plus this session), full for the first
// 5 minutes and gone at 12; and lives started, full for the first 5 and gone
// by the 9th. A strong player who rarely dies stops being new on the clock;
// one who dies a lot stops on lives (mercy still covers them).
//
// 0.5 plays like the 07e28b1 tuning. 1 is still softer than the bots before
// it, knob by knob (scripts/test/botDifficulty.test.js holds that).
'use strict';

const NEUTRAL = 0.5;
const RANK_LO = 0.2, RANK_HI = 0.95, RANK_PERF = 0.08;
const GUEST_LO = 0.15, GUEST_HI = 0.85, PLACEMENT_HI = 0.5;
const PERF_SCORE = 10000, PERF_KILLS = 10;
const SESSION_KEEP = 0.6;
const MERCY_MAX = 0.15;
const LEGEND = 18;
const TIME_HI = 0.6, TIME_TAU_MS = 15 * 60_000;
const NEW_FULL_MS = 5 * 60_000, NEW_END_MS = 12 * 60_000;
const NEW_FULL_LIVES = 5, NEW_END_LIVES = 9;

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
function lerp(a, b, d) { return a + (b - a) * clamp01(d); }

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
// rankCode: 0 none, 1..19 division + 1, 20 placement (shared/ranks.js)
function fromRank(code) {
    code |= 0;
    if (code < 1 || code > LEGEND + 1) return null;
    return RANK_LO + (RANK_HI - RANK_LO) * (code - 1) / LEGEND;
}

// p: { newbie, newness, rankCode, score, kills, sessionBest, playMs }
function forPlayer(p) {
    const fresh = p.newbie ? 1 : clamp01(+p.newness || 0);
    if (fresh >= 1) return 0;
    return settled(p) * (1 - fresh);
}
// what the player gets once they are not new at all
function settled(p) {
    const rank = fromRank(p.rankCode);
    if (rank != null) return Math.min(RANK_HI, rank + RANK_PERF * perfShare(p.score, p.kills));
    let d = Math.max(fromRaid(p.score, p.kills), fromTime(p.playMs));
    const best = +p.sessionBest || 0;
    if (best > GUEST_LO) d = Math.max(d, GUEST_LO + (best - GUEST_LO) * SESSION_KEEP);
    if ((p.rankCode | 0) === 20) d = Math.min(d, PLACEMENT_HI);
    return Math.min(GUEST_HI, d);
}

// The difficulty a bot plays at against `root` (a target's root body).
function of(root, now = Date.now()) {
    if (!root || !root.isPlayer) return NEUTRAL;
    let d = root.botNewbie ? 0 : root.botDifficulty != null ? root.botDifficulty : NEUTRAL;
    if ((root.socket?.botMercyUntil || 0) > now) d = Math.min(d, MERCY_MAX);
    return clamp01(d);
}

// ── the knobs, each as (bot skill, difficulty) ───────────────────────────
// (pre-07e28b1 formula in brackets: d = 1 must stay under it)

// cursor error, std dev in radians, re-rolled every 110 ms [(1-s)*0.07]
function aimError(s, d) { return lerp(0.05, 0.02, d) + (1 - s) * lerp(0.12, 0.075, d); }
// aim spring stiffness [0.16 + 0.22s]
function aimStiff(s, d) { return lerp(0.09, 0.145, d) + s * lerp(0.17, 0.21, d); }
// share of the full lead the bot aims ahead by [0.5 + 0.5s]
function leadShare(s, d) { return lerp(0.2, 0.45, d) + s * 0.5; }
// ms before a new target is engaged, r in 0..1 [160 + 380(1-s) + 160r]
function reactionMs(s, d, r) { return lerp(450, 210, d) + (1 - s) * lerp(550, 400, d) + r * lerp(300, 180, d); }
// trigger released before a burst [200 + 450r(1.4-s)]; burst length [1300 + 2400r]
function pauseMs(s, d, r) { return lerp(420, 230, d) + r * lerp(800, 480, d) * (1.4 - s); }
function burstMs(d, r) { return lerp(700, 1250, d) + r * lerp(1500, 2300, d); }
// bullet / drone / trap damage share [1]
function shotMult(d) { return lerp(0.64, 0.92, d); }
// bots that may hunt one player at once [2]
function maxHunters(d) { return d < 0.35 ? 1 : 2; }
// bots the director keeps within sight of a player [4]
function company(d) { return d < 0.3 ? 1 : d < 0.75 ? 2 : 3; }
// a bot starts a fight only when the trade looks at most this bad [1.2]
function initThreat(d) { return lerp(0.85, 1.2, d); }
// ...and only from this close [1400]
function initRange(d) { return lerp(800, 1400, d); }
// target choice: a player counts as this much farther away [0]
function targetPenalty(d) { return lerp(400, 0, d); }
// the soft window at the start of a life: its length share, the range at
// which a soft player gets fought anyway, and the aim it still costs
function softShare(d) { return lerp(1, 0.35, d); }
function softCloseR(d) { return lerp(320, 520, d); }
function softAim(d) { return lerp(0.7, 0.85, d); }
// auto turrets: extra aim noise and turn-rate share [0, 1]
function turretNoise(d) { return lerp(0.06, 0, d); }
function turretTurn(d) { return lerp(0.7, 1, d); }

module.exports = {
    NEUTRAL, NEW_FULL_MS, NEW_END_MS, NEW_FULL_LIVES, NEW_END_LIVES,
    lerp, perfShare, fromRaid, fromTime, fromRank, newness, forPlayer, settled, of,
    aimError, aimStiff, leadShare, reactionMs, pauseMs, burstMs, shotMult, maxHunters, company,
    initThreat, initRange, targetPenalty, softShare, softCloseR, softAim, turretNoise, turretTurn,
};
