'use strict';

const BONUS_MULT = 1.25;
const BONUS_PCT = 25;

const FEATURED_POOL = [
    'Annihilator', 'Hybrid', 'Skimmer', 'Destroyer',
    'Overlord', 'Manager', 'Factory', 'Battleship',
    'Penta Shot', 'Spreadshot', 'Triplet', 'Streamliner',
    'Predator', 'Ranger', 'Stalker', 'Crossbow',
    'Fighter', 'Booster', 'Bomber', 'Auto-Tri-Angle',
    'Auto-Gunner', 'Nailgun', 'Minigun', 'Sprayer',
    'Builder', 'Architect', 'Gunner Trapper', 'Boomer',
];

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function dayKeyOf(t = Date.now()) {
    return new Date(Math.floor(t / 86400000) * 86400000).toISOString().slice(0, 10);
}

let cachedDay = '';
let cachedList = [];
let cachedSet = new Set();
let cachedExpandedDay = '';
let cachedExpandedSet = null;

function forDay(dayKey) {
    const dk = String(dayKey || dayKeyOf());
    if (dk === cachedDay && cachedList.length) return cachedList;
    const rand = mulberry32(fnv1a('dw-featured-' + dk));
    const pool = FEATURED_POOL.slice();
    const picked = [];
    while (picked.length < 3 && pool.length) {
        const idx = Math.floor(rand() * pool.length) % pool.length;
        picked.push(pool.splice(idx, 1)[0]);
    }
    cachedDay = dk;
    cachedList = picked;
    cachedSet = new Set(picked);
    cachedExpandedDay = '';
    cachedExpandedSet = null;
    return cachedList;
}

function expandedSetForDay(dayKey) {
    const list = forDay(dayKey);
    const dk = cachedDay;
    if (cachedExpandedSet && cachedExpandedDay === dk) return cachedExpandedSet;
    const full = new Set(list);
    if (typeof Class !== 'undefined' && Class) {
        const queue = [];
        const seenDefs = new Set();
        for (const k of Object.keys(Class)) {
            const def = Class[k];
            if (def && typeof def === 'object' && def.LABEL && full.has(String(def.LABEL))) {
                queue.push(def);
                seenDefs.add(def);
            }
        }
        while (queue.length) {
            const cur = queue.shift();
            for (let t = 0; t <= 9; t++) {
                const arr = cur['UPGRADES_TIER_' + t];
                if (!Array.isArray(arr)) continue;
                for (let entry of arr) {
                    if (Array.isArray(entry)) entry = entry[0];
                    const child = typeof entry === 'string' ? Class[entry] : entry;
                    if (!child || typeof child !== 'object' || seenDefs.has(child)) continue;
                    seenDefs.add(child);
                    if (child.LABEL) full.add(String(child.LABEL));
                    queue.push(child);
                }
            }
        }
        cachedExpandedDay = dk;
        cachedExpandedSet = full;
    }
    return full;
}

function isFeaturedBody(body, dayKey) {
    if (!body) return false;
    const set = expandedSetForDay(dayKey);
    const label = String(body.label || '');
    if (label && set.has(label)) return true;
    if (body.defs) {
        const defs = Array.isArray(body.defs) ? body.defs : [body.defs];
        for (const k of defs) {
            const def = typeof k === 'string' && typeof Class !== 'undefined' ? Class[k] : k;
            const pl = def && def.LABEL ? String(def.LABEL) : '';
            if (pl && set.has(pl)) return true;
        }
    }
    if (Array.isArray(body.tankPath)) {
        for (const k of body.tankPath) {
            const def = typeof k === 'string' && typeof Class !== 'undefined' ? Class[k] : k;
            const pl = def && def.LABEL ? String(def.LABEL) : '';
            if (pl && set.has(pl)) return true;
        }
    }
    return false;
}

function multForBody(body, dayKey) {
    return isFeaturedBody(body, dayKey) ? BONUS_MULT : 1;
}

module.exports = {
    BONUS_MULT,
    BONUS_PCT,
    FEATURED_POOL,
    forDay,
    isFeaturedBody,
    multForBody,
};
