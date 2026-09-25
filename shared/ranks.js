// Ranked rules, shared by the server (require) and the client (<script>
// served at /shared/ranks.js, exposes window.DWRanks). One table decides
// division sizes, per-life fares, the diminishing-returns curve, placement
// and the gemdust rates, so both sides always agree.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWRanks = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const RULES_VERSION = 1;
    const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'emerald', 'legend'];
    const TIER_NAMES = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', emerald: 'Emerald', legend: 'Legend' };
    const ROMAN = ['', 'I', 'II', 'III'];

    // [floor RP, size RP, fare per life]; Legend has no top.
    const TABLE = [
        [0, 120, 0], [120, 160, 0], [280, 200, 0],
        [480, 240, 0], [720, 280, 0], [1000, 320, 0],
        [1320, 380, 0], [1700, 440, 0], [2140, 500, 0],
        [2640, 560, 3], [3200, 640, 4], [3840, 720, 5],
        [4560, 820, 6], [5380, 960, 7], [6340, 1100, 8],
        [7440, 1650, 9], [9090, 1800, 10], [10890, 1950, 11],
        [12840, Infinity, 12],
    ];
    const DIVISIONS = TABLE.map(([floor, size, fare], i) => {
        const tier = TIERS[Math.min(6, Math.floor(i / 3))];
        const div = i === 18 ? 0 : (i % 3) + 1;
        return Object.freeze({ i, tier, div, name: TIER_NAMES[tier] + (div ? ' ' + ROMAN[div] : ''), floor, size, fare });
    });
    const LEGEND = 18;

    // Raid points -> RP, cheaper the more of the raid you have already
    // counted, so one long life and many short ones earn the same.
    const CURVE = [[1500, 1 / 12], [4000, 1 / 24], [8000, 1 / 48], [16000, 1 / 96], [Infinity, 1 / 192]];
    function curve(points) {
        let p = Math.max(0, +points || 0), rp = 0, from = 0;
        for (const [to, rate] of CURVE) {
            const span = Math.min(p, to) - from;
            if (span <= 0) break;
            rp += span * rate;
            from = to;
        }
        return rp;
    }
    const LIFE_CAP = 200;

    const PLACEMENT_LIVES = 3;
    const PLACEMENT_STEPS = [[300, 0], [600, 1], [900, 2], [1300, 3], [1800, 4], [2500, 5]];
    function placementStart(avgBasis) {
        for (const [under, div] of PLACEMENT_STEPS) if (avgBasis < under) return div;
        return 6;   // Gold I is the highest a placement can start you
    }

    const PLACEMENT_BONUS_RP = [40, 30, 22, 15, 12, 10, 8, 8, 8, 8];
    const PLACEMENT_BONUS_DUST_MILLI = [2000, 1000, 500];

    // Gemdust, in thousandths so every rate is a whole number.
    const DUST_MILLI_PER_GEM = { 1: 10, 2: 20, 3: 50, 4: 100 };   // copper, azurite, purple, emerald
    const KILL_DUST_MILLI = { player: 250, bot: 125 };
    const DAILY_SOFT_CAP_MILLI = 50000;

    // In-raid rewards, all in one place to tune. dustMilli goes to account
    // holders through the same pending pot as gem and kill dust (daily soft
    // cap applies, ledger kind 'other', a DU pop on the HUD); pts are raid
    // points on the board score (s.extra), so they count toward the rank
    // basis and turn into RP like everything else. Kills keep
    // KILL_DUST_MILLI above; the boss's own score is bosses.js kind.score.
    const REWARDS = Object.freeze({
        chest: Object.freeze({
            common: Object.freeze({ dustMilli: 50, pts: 25 }),     // 0.05 gemdust
            epic: Object.freeze({ dustMilli: 150, pts: 60 }),      // 0.15 gemdust
        }),
        boss: Object.freeze({
            finalDustMilli: 500,        // the final blow (plus the boss score)
            assistDustMilli: 200,       // anyone else with >= assistShare of the damage
            assistPts: 40,
            assistShare: 0.15,
        }),
        shop: Object.freeze({
            dustMilli: 20,              // 0.02 gemdust per purchase at a shop pad
            pts: 5,
            perRaidCap: 10,             // purchases per account per raid that pay
        }),
    });
    const SOFT_CAP_RATE = 0.25;

    function clampIndex(i) { return Math.max(0, Math.min(LEGEND, i | 0)); }
    function divisionOf(rp) {
        rp = Math.max(0, +rp || 0);
        for (let i = LEGEND; i >= 0; i--) if (rp >= DIVISIONS[i].floor) return i;
        return 0;
    }
    function floorOf(i) { return DIVISIONS[clampIndex(i)].floor; }
    function nameOf(i) { return i == null ? 'Unranked' : DIVISIONS[clampIndex(i)].name; }
    function tierOf(i) { return i == null ? null : DIVISIONS[clampIndex(i)].tier; }
    function isTierUp(from, to) { return from != null && to != null && TIERS.indexOf(tierOf(to)) > TIERS.indexOf(tierOf(from)); }
    function progressOf(rp) {
        const i = divisionOf(rp), d = DIVISIONS[i];
        const into = Math.max(0, Math.round(rp - d.floor));
        return { division: i, name: d.name, tier: d.tier, into, size: d.size === Infinity ? 0 : d.size, pct: d.size === Infinity ? 1 : Math.min(1, into / d.size) };
    }

    // Nameplates and board rows carry one small number.
    const CODE_NONE = 0, CODE_PLACEMENT = 20;
    function rankCode(division, inPlacement) {
        if (inPlacement) return CODE_PLACEMENT;
        return division == null ? CODE_NONE : clampIndex(division) + 1;
    }
    function fromCode(code) {
        code |= 0;
        if (code === CODE_PLACEMENT) return { placement: true, division: null };
        if (code < 1 || code > 19) return null;
        return { placement: false, division: code - 1 };
    }

    return Object.freeze({
        RULES_VERSION, TIERS, TIER_NAMES, DIVISIONS, LEGEND, CURVE, curve, LIFE_CAP,
        PLACEMENT_LIVES, placementStart, PLACEMENT_BONUS_RP, PLACEMENT_BONUS_DUST_MILLI,
        DUST_MILLI_PER_GEM, KILL_DUST_MILLI, DAILY_SOFT_CAP_MILLI, SOFT_CAP_RATE, REWARDS,
        divisionOf, floorOf, nameOf, tierOf, isTierUp, progressOf,
        CODE_NONE, CODE_PLACEMENT, rankCode, fromCode,
    });
});
