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

    // Stamped on every rank_lives row (informational: nothing re-prices old
    // lives or resets RP when it changes).
    //   1  launch: Bronze..Emerald, then one open-ended Legend; curve 1/12..
    //   2  Legend I-III, six tiers above it (Corez is the open-ended top),
    //      RP per raid cut about a fifth (curve 1/15.., life cap, placement)
    const RULES_VERSION = 2;
    const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'emerald', 'legend',
        'mythic', 'titan', 'overlord', 'immortal', 'eternal', 'corez'];
    const TIER_NAMES = {
        bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', emerald: 'Emerald',
        legend: 'Legend', mythic: 'Mythic', titan: 'Titan', overlord: 'Overlord', immortal: 'Immortal', eternal: 'Eternal', corez: 'Corez',
    };
    const ROMAN = ['', 'I', 'II', 'III'];

    // [floor RP, size RP, fare per life]. Three divisions per tier; the last
    // row (Corez) is a single division with no top. Sizes grow by 150 a
    // division up to Legend III, then by 200.
    const TABLE = [
        [0, 120, 0], [120, 160, 0], [280, 200, 0],                 // Bronze
        [480, 240, 0], [720, 280, 0], [1000, 320, 0],              // Silver
        [1320, 380, 0], [1700, 440, 0], [2140, 500, 0],            // Gold
        [2640, 560, 3], [3200, 640, 4], [3840, 720, 5],            // Platinum
        [4560, 820, 6], [5380, 960, 7], [6340, 1100, 8],           // Diamond
        [7440, 1650, 9], [9090, 1800, 10], [10890, 1950, 11],      // Emerald
        [12840, 2100, 12], [14940, 2250, 13], [17190, 2400, 14],   // Legend
        [19590, 2600, 15], [22190, 2800, 16], [24990, 3000, 17],   // Mythic
        [27990, 3200, 18], [31190, 3400, 19], [34590, 3600, 20],   // Titan
        [38190, 3800, 21], [41990, 4000, 22], [45990, 4200, 23],   // Overlord
        [50190, 4400, 24], [54590, 4600, 25], [59190, 4800, 26],   // Immortal
        [63990, 5000, 27], [68990, 5200, 28], [74190, 5400, 29],   // Eternal
        [79590, Infinity, 30],                                     // Corez
    ];
    const TOP = TABLE.length - 1;
    const DIVISIONS = TABLE.map(([floor, size, fare], i) => {
        const tier = TIERS[Math.floor(i / 3)];
        const div = i === TOP ? 0 : (i % 3) + 1;
        return Object.freeze({ i, tier, div, name: TIER_NAMES[tier] + (div ? ' ' + ROMAN[div] : ''), floor, size, fare });
    });
    // Legend I. From here up a player also has a Legend #N (their place
    // among everyone at Legend or above); users.legend_at stamps the first
    // time they got here.
    const LEGEND = 18;

    // Raid points -> RP, cheaper the more of the raid you have already
    // counted, so one long life and many short ones earn the same.
    // Every rate is a whole number of 1/240 RP (ranked.js counts in those).
    const CURVE = [[1500, 1 / 15], [4000, 1 / 30], [8000, 1 / 60], [16000, 1 / 120], [Infinity, 1 / 240]];
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
    const LIFE_CAP = 160;

    const PLACEMENT_LIVES = 3;
    const PLACEMENT_STEPS = [[300, 0], [600, 1], [900, 2], [1300, 3], [1800, 4], [2500, 5]];
    function placementStart(avgBasis) {
        for (const [under, div] of PLACEMENT_STEPS) if (avgBasis < under) return div;
        return 6;   // Gold I is the highest a placement can start you
    }

    const PLACEMENT_BONUS_RP = [30, 22, 16, 11, 9, 8, 6, 6, 6, 6];
    const PLACEMENT_BONUS_DUST_MILLI = [2000, 1000, 500];

    // Gemdust, in thousandths so every rate is a whole number.
    const DUST_MILLI_PER_GEM = { 1: 10, 2: 20, 3: 50, 4: 100 };   // copper, azurite, purple, emerald
    const KILL_DUST_MILLI = { player: 250, bot: 125 };
    const DAILY_SOFT_CAP_MILLI = 50000;

    // In-raid rewards. dustMilli goes to account holders through the same
    // pending pot as gem and kill dust (daily soft cap, ledger kind 'other',
    // a DU pop on the HUD); pts go on the board score (s.extra) and count
    // toward the rank basis. Kills use KILL_DUST_MILLI above; the boss's own
    // score is bosses.js kind.score.
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
        // Rank-only points (s.rankOnly): they go into the rank basis (curve,
        // fare, LIFE_CAP as usual) but never onto the raid board score.
        // For scale: a kill is 200 pts, and the first 1500 pts of a raid
        // pay 1 RP per 15.
        survive: Object.freeze({
            ptsPerMin: 15,              // per active minute alive: 10 min = 150 pts (~10 RP), under a kill
            activeWindowMs: 20000,      // moved or pressed something fresh within this: active
            perLife: 300,               // 20 active minutes; staying alive past that pays nothing more
        }),
        damage: Object.freeze({
            ptsPerBar: 40,              // one full health+shield bar of a real player's damage
            perVictim: 40,              // per victim per life: one bar; the kill (200) pays the rest
            perLife: 200,               // five victims' worth per life
        }),
        // Duos: a duo life counts toward the same rank as a solo one, at this
        // share of its points (a partner does part of the work). Applied to
        // the life basis in rankHooks.lifeEnd; the raid placement bonus pays
        // the team's place to both partners.
        duo: Object.freeze({ rpMult: 0.8 }),
    });
    const DUO_RP_MULT = REWARDS.duo.rpMult;
    const SOFT_CAP_RATE = 0.25;

    function clampIndex(i) { return Math.max(0, Math.min(TOP, i | 0)); }
    function divisionOf(rp) {
        rp = Math.max(0, +rp || 0);
        for (let i = TOP; i >= 0; i--) if (rp >= DIVISIONS[i].floor) return i;
        return 0;
    }
    function floorOf(i) { return DIVISIONS[clampIndex(i)].floor; }
    function nameOf(i) { return i == null ? 'Unranked' : DIVISIONS[clampIndex(i)].name; }
    function tierOf(i) { return i == null ? null : DIVISIONS[clampIndex(i)].tier; }
    function isTierUp(from, to) { return from != null && to != null && TIERS.indexOf(tierOf(to)) > TIERS.indexOf(tierOf(from)); }
    // Legend I or above: the divisions that carry a Legend #N
    function isLegend(i) { return i != null && (i | 0) >= LEGEND; }
    // the open-ended top division (no bar, no "next")
    function isTop(i) { return i != null && (i | 0) >= TOP; }
    function progressOf(rp) {
        const i = divisionOf(rp), d = DIVISIONS[i];
        const into = Math.max(0, Math.round(rp - d.floor));
        return { division: i, name: d.name, tier: d.tier, into, size: d.size === Infinity ? 0 : d.size, pct: d.size === Infinity ? 1 : Math.min(1, into / d.size) };
    }

    // Nameplates and board rows carry one small number: 0 none, 20 in
    // placement, 1..19 divisions 0..18 (division + 1, Bronze I to Legend I,
    // the codes from before Legend split), then division + 2 from Legend II
    // up (21..38), stepping over 20.
    const CODE_NONE = 0, CODE_PLACEMENT = 20;
    const CODE_MAX = TOP + 2;
    function rankCode(division, inPlacement) {
        if (inPlacement) return CODE_PLACEMENT;
        if (division == null) return CODE_NONE;
        const i = clampIndex(division);
        return i + 1 < CODE_PLACEMENT ? i + 1 : i + 2;
    }
    function fromCode(code) {
        code |= 0;
        if (code === CODE_PLACEMENT) return { placement: true, division: null };
        if (code < 1 || code > CODE_MAX) return null;
        return { placement: false, division: code < CODE_PLACEMENT ? code - 1 : code - 2 };
    }

    return Object.freeze({
        RULES_VERSION, TIERS, TIER_NAMES, DIVISIONS, LEGEND, TOP, CURVE, curve, LIFE_CAP,
        PLACEMENT_LIVES, placementStart, PLACEMENT_BONUS_RP, PLACEMENT_BONUS_DUST_MILLI,
        DUST_MILLI_PER_GEM, KILL_DUST_MILLI, DAILY_SOFT_CAP_MILLI, SOFT_CAP_RATE, REWARDS, DUO_RP_MULT,
        divisionOf, floorOf, nameOf, tierOf, isTierUp, isLegend, isTop, progressOf,
        CODE_NONE, CODE_PLACEMENT, CODE_MAX, rankCode, fromCode,
    });
});
