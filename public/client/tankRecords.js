const KEY = "dwTankPB";
let cache = null;

const FEATURED_POOL = [
    "Annihilator", "Hybrid", "Skimmer", "Destroyer",
    "Overlord", "Manager", "Factory", "Battleship",
    "Penta Shot", "Spreadshot", "Triplet", "Streamliner",
    "Predator", "Ranger", "Stalker", "Crossbow",
    "Fighter", "Booster", "Bomber", "Auto-Tri-Angle",
    "Auto-Gunner", "Nailgun", "Minigun", "Sprayer",
    "Builder", "Architect", "Gunner Trapper", "Boomer",
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

export function dailyFeaturedFor(dayKey) {
    const dk = String(dayKey || new Date(Math.floor(Date.now() / 86400000) * 86400000).toISOString().slice(0, 10));
    const rand = mulberry32(fnv1a("dw-featured-" + dk));
    const pool = FEATURED_POOL.slice();
    const picked = [];
    while (picked.length < 3 && pool.length) {
        const idx = Math.floor(rand() * pool.length) % pool.length;
        picked.push(pool.splice(idx, 1)[0]);
    }
    return picked;
}

function load() {
    if (cache) return cache;
    cache = {};
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === "object") cache = obj;
        }
    } catch {}
    return cache;
}

function save() {
    if (!cache) return;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
}

export function get(tankName) {
    if (!tankName) return null;
    const map = load();
    const rec = map[String(tankName)];
    return rec && (rec.s > 0 || rec.k > 0) ? rec : null;
}

export function getRecord(tankName) {
    const rec = get(tankName);
    if (!rec) return null;
    return { score: rec.s | 0, kills: rec.k | 0, playMs: rec.t | 0, s: rec.s | 0, k: rec.k | 0, t: rec.t | 0 };
}

export function allRecords() {
    const map = load();
    const out = [];
    for (const [tank, rec] of Object.entries(map)) {
        if (!rec || ((rec.s | 0) <= 0 && (rec.k | 0) <= 0)) continue;
        out.push({ tank, score: rec.s | 0, kills: rec.k | 0, playMs: rec.t | 0 });
    }
    out.sort((a, b) => (b.score - a.score) || (b.kills - a.kills));
    return out;
}

export function recordLife(tankName, score, kills, playMs) {
    const name = String(tankName || "").trim();
    score = Math.max(0, score | 0);
    kills = Math.max(0, kills | 0);
    playMs = Math.max(0, playMs | 0);
    if (!name || name === "Basic" || (score <= 0 && kills <= 0)) return null;
    const map = load();
    const prev = map[name] || { s: 0, k: 0, t: 0 };
    const prevScore = prev.s | 0;
    const newPB = score >= 100 && score > prevScore;
    if (score > prevScore || kills > (prev.k | 0) || (score === prevScore && playMs > (prev.t | 0))) {
        map[name] = {
            s: Math.max(prevScore, score),
            k: Math.max(prev.k | 0, kills),
            t: score > prevScore ? (playMs || prev.t || 0) : Math.max(prev.t | 0, playMs),
        };
        save();
        try {
            if (typeof window !== "undefined" && typeof window.renderHomeDailyAndRecords === "function") {
                window.renderHomeDailyAndRecords();
            }
        } catch {}
    }
    return { newPB, prevScore, score: map[name] ? map[name].s : score, kills: map[name] ? map[name].k : kills, playMs: map[name] ? (map[name].t | 0) : playMs, tank: name };
}

if (typeof window !== "undefined") {
    window.tankRecords = {
        get,
        getRecord,
        allRecords,
        recordLife,
        recordRun: recordLife,
        dailyFeaturedFor,
    };
}
