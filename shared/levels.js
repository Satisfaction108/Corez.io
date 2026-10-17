(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWLevels = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_LEVEL = 100;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const DAY_CAP = 1000;

    const XP = Object.freeze({
        minute: 4,
        gemsPerXp: 20,
        kill: 12,
        botKill: 4,
        raidPlace: Object.freeze([40, 30, 24]),
        raidTop: 12,
        raidPlayed: 6,
        eventPlace: Object.freeze([50, 35, 25]),
        eventTop: 12,
        eventPlayed: 6,
        grantMax: 200,
    });

    function needFor(level) {
        const l = level | 0;
        if (l < 1 || l >= MAX_LEVEL) return 0;
        const n = l - 1;
        return Math.round((40 + 18 * n + 0.12 * n * n) / 10) * 10;
    }
    const NEED = [0];
    const START = [0, 0];
    for (let l = 1; l <= MAX_LEVEL; l++) {
        NEED[l] = needFor(l);
        if (l < MAX_LEVEL) START[l + 1] = START[l] + NEED[l];
    }
    const TOTAL = START[MAX_LEVEL];

    function levelOf(total) {
        const xp = Math.max(0, Math.floor(+total || 0));
        let lo = 1, hi = MAX_LEVEL;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (START[mid] <= xp) lo = mid; else hi = mid - 1;
        }
        const max = lo >= MAX_LEVEL;
        return { level: lo, into: max ? 0 : xp - START[lo], need: NEED[lo], total: xp, max };
    }

    const dayOf = (ms) => Math.floor((+ms || 0) / DAY_MS);

    function capDay(st, xp, day, cap) {
        const limit = cap == null ? DAY_CAP : cap;
        const same = st && (st.day | 0) === (day | 0);
        const had = same ? Math.max(0, st.dayXp | 0) : 0;
        const want = Math.max(0, Math.floor(+xp || 0));
        const add = Math.max(0, Math.min(want, limit - had));
        return { add, day: day | 0, dayXp: had + add, capped: add < want, left: Math.max(0, limit - had - add) };
    }

    function raidXp(place, played) {
        if (!played) return 0;
        const p = place | 0;
        if (p >= 1 && p <= XP.raidPlace.length) return XP.raidPlace[p - 1];
        if (p >= 1 && p <= 10) return XP.raidTop;
        return XP.raidPlayed;
    }

    function eventXp(place, field) {
        const p = place | 0;
        if (!(p >= 1)) return XP.eventPlayed;
        if (p <= XP.eventPlace.length) return XP.eventPlace[p - 1];
        const n = Math.max(1, field | 0);
        return p <= Math.ceil(n / 2) ? XP.eventTop : XP.eventPlayed;
    }

    const TITLES = Object.freeze([
        Object.freeze({ level: 1, title: 'Rookie' }),
        Object.freeze({ level: 5, title: 'Digger' }),
        Object.freeze({ level: 10, title: 'Prospector' }),
        Object.freeze({ level: 14, title: 'Tunneler' }),
        Object.freeze({ level: 20, title: 'Gem Hunter' }),
        Object.freeze({ level: 25, title: 'Vault Keeper' }),
        Object.freeze({ level: 30, title: 'Rockbreaker' }),
        Object.freeze({ level: 35, title: 'Veteran' }),
        Object.freeze({ level: 40, title: 'Champion' }),
        Object.freeze({ level: 45, title: 'Master Miner' }),
        Object.freeze({ level: 50, title: 'Legend' }),
        Object.freeze({ level: 55, title: 'Core Warden' }),
        Object.freeze({ level: 60, title: 'Earthshaker' }),
        Object.freeze({ level: 65, title: 'Grand Master' }),
        Object.freeze({ level: 70, title: 'Mythic Miner' }),
        Object.freeze({ level: 75, title: 'Voidwalker' }),
        Object.freeze({ level: 80, title: 'Starbreaker' }),
        Object.freeze({ level: 85, title: 'Apex Titan' }),
        Object.freeze({ level: 90, title: 'Immortal' }),
        Object.freeze({ level: 95, title: 'Sovereign' }),
        Object.freeze({ level: 100, title: 'Overlord' }),
    ]);
    const TITLE_AT = new Map(TITLES.map(t => [t.level, t.title]));

    const ITEMS_AT = Object.freeze({
        3: Object.freeze({ item: 'ns_lv_sprout' }),
        8: Object.freeze({ item: 'sk_lv_pumpkin' }),
        10: Object.freeze({ item: 'sd_twinny', fallbackMilli: 6000 }),
        12: Object.freeze({ item: 'sds_checker', fallbackMilli: 4000 }),
        16: Object.freeze({ item: 'sk_lv_coil' }),
        20: Object.freeze({ item: 'ns_lv_deep' }),
        23: Object.freeze({ item: 'sd_trio', fallbackMilli: 8000 }),
        27: Object.freeze({ item: 'sk_lv_crust' }),
        30: Object.freeze({ item: 'sk_lv_magma' }),
        33: Object.freeze({ item: 'ns_lv_ore' }),
        37: Object.freeze({ item: 'sds_frost', fallbackMilli: 8000 }),
        40: Object.freeze({ item: 'sk_lv_starforged' }),
        43: Object.freeze({ item: 'ns_lv_sunforge' }),
        47: Object.freeze({ item: 'sds_gold', fallbackMilli: 10000 }),
        50: Object.freeze({ item: 'ns_lv_legend' }),
        53: Object.freeze({ item: 'ns_lv_plasma' }),
        57: Object.freeze({ item: 'sd_quaddy', fallbackMilli: 12000 }),
        60: Object.freeze({ item: 'sk_lv_cobalt' }),
        63: Object.freeze({ item: 'ns_lv_nebula' }),
        67: Object.freeze({ item: 'sdn_candy', fallbackMilli: 15000 }),
        70: Object.freeze({ item: 'sk_lv_tempest' }),
        73: Object.freeze({ item: 'ns_lv_solar' }),
        77: Object.freeze({ item: 'sd_octo', fallbackMilli: 18000 }),
        80: Object.freeze({ item: 'sk_lv_abyssal' }),
        83: Object.freeze({ item: 'ns_lv_celestial' }),
        87: Object.freeze({ item: 'sdn_pixel', fallbackMilli: 24000 }),
        90: Object.freeze({ item: 'sk_lv_astral' }),
        93: Object.freeze({ item: 'sk_lv_eternal' }),
        97: Object.freeze({ item: 'sds_galaxy', fallbackMilli: 35000 }),
        100: Object.freeze({ item: 'ns_lv_overlord' }),
    });
    const MILESTONE_DUST = Object.freeze({ 10: 5000, 20: 8000, 30: 10000, 40: 12000, 50: 25000, 60: 30000, 70: 35000, 80: 45000, 90: 60000, 100: 100000 });
    const LEVEL_ITEMS = Object.freeze(Object.keys(ITEMS_AT).map(k => ITEMS_AT[k].item).filter(id => /_lv_/.test(id)));

    function plainDust(level) {
        if (level < 10) return 1000;
        if (level < 20) return 1500;
        if (level < 30) return 2000;
        if (level < 40) return 2500;
        if (level < 50) return 3000;
        if (level < 60) return 4000;
        if (level < 70) return 5000;
        if (level < 80) return 6500;
        if (level < 90) return 8000;
        return 10000;
    }

    const REWARDS = [];
    for (let l = 2; l <= MAX_LEVEL; l++) {
        const it = ITEMS_AT[l] || null;
        const title = TITLE_AT.get(l) || null;
        const milestone = l % 10 === 0;
        let dustMilli = 0;
        if (milestone) dustMilli = MILESTONE_DUST[l] | 0;
        else if (!it && !title) dustMilli = plainDust(l);
        REWARDS.push(Object.freeze({
            level: l,
            dustMilli,
            item: it ? it.item : null,
            fallbackMilli: it && it.fallbackMilli ? it.fallbackMilli : 0,
            title,
            milestone,
        }));
    }
    Object.freeze(REWARDS);

    function rewardAt(level) {
        const l = level | 0;
        return l >= 2 && l <= MAX_LEVEL ? REWARDS[l - 2] : null;
    }
    function rewardsBetween(from, to) {
        const out = [];
        for (let l = Math.max(2, (from | 0) + 1); l <= Math.min(MAX_LEVEL, to | 0); l++) out.push(REWARDS[l - 2]);
        return out;
    }
    function nextUnlock(level) {
        const l = Math.max(2, (level | 0) + 1);
        return l <= MAX_LEVEL ? REWARDS[l - 2] : null;
    }
    function titleFor(level) {
        let t = TITLES[0].title;
        for (const x of TITLES) if (x.level <= (level | 0)) t = x.title;
        return t;
    }

    const CAT_WORD = Object.freeze({ skin: 'skin', nameStyle: 'name style', sidekick: 'sidekick', sdSkin: 'sidekick skin', sdName: 'sidekick name style' });
    function itemName(id, C) {
        const it = id && C && C.byId ? C.byId(id) : null;
        if (!it) return '';
        return it.name + ' ' + (CAT_WORD[it.cat] || 'item');
    }
    const dustText = (milli) => {
        const v = (+milli || 0) / 1000;
        return (Number.isInteger(v) ? String(v) : String(+v.toFixed(2))) + ' gemdust';
    };
    function rewardBits(r, C) {
        if (!r) return [];
        const bits = [];
        if (r.item) bits.push(itemName(r.item, C) || 'a new item');
        if (r.title) bits.push('the ' + r.title + ' title');
        if (r.dustMilli > 0) bits.push(dustText(r.dustMilli));
        return bits;
    }
    function joinBits(bits) {
        if (bits.length <= 1) return bits[0] || '';
        return bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1];
    }
    function rewardText(r, C) { return joinBits(rewardBits(r, C)); }
    function shortText(r, C) {
        if (!r) return '';
        if (r.item) return itemName(r.item, C) || 'A new item';
        if (r.title) return r.title + ' title';
        return dustText(r.dustMilli);
    }
    function upLine(r, C, guest) {
        if (!r) return '';
        const head = 'Level ' + r.level + '!';
        const main = r.item ? 'the ' + itemName(r.item, C) : r.title ? 'the ' + r.title + ' title' : '';
        if (guest) {
            if (main) return head + ' ' + main.charAt(0).toUpperCase() + main.slice(1) + ' is saved for when you sign up.';
            return head + ' ' + dustText(r.dustMilli) + ' is saved for when you sign up.';
        }
        if (main) return head + ' You unlocked ' + main + '.';
        return head + ' You got ' + dustText(r.dustMilli) + '.';
    }
    function nextLine(level, C) {
        const n = nextUnlock(level);
        return n ? 'Next: ' + shortText(n, C) + ' at Lvl ' + n.level : '';
    }

    const DUST_TOTAL = REWARDS.reduce((s, r) => s + r.dustMilli, 0);

    return Object.freeze({
        MAX_LEVEL, DAY_MS, DAY_CAP, XP, NEED, START, TOTAL, TITLES, REWARDS, LEVEL_ITEMS, DUST_TOTAL,
        needFor, levelOf, dayOf, capDay, raidXp, eventXp, rewardAt, rewardsBetween, nextUnlock, titleFor,
        itemName, dustText, rewardBits, rewardText, shortText, upLine, nextLine,
    });
});
