'use strict';

const KINDS = {
    storm: { id: 'storm', name: 'Storm Circle', ms: 200_000, verb: 'Get inside the circle and stay alive.' },
    core: { id: 'core', name: 'Core Siege', ms: 240_000, verb: 'Break the Core for a share of its gems.' },
    rush: { id: 'rush', name: 'Gem Rush', ms: 180_000, verb: 'Mine the rich rock and bank what you find.' },
    hill: { id: 'hill', name: 'King of the Vault', ms: 180_000, verb: 'Hold the ground around the vault.' },
    boss: { id: 'boss', name: 'Boss Hunt', ms: 240_000, verb: 'Hurt the boss and land the last hit.' },
    meteor: { id: 'meteor', name: 'Meteor Shower', ms: 100_000, verb: 'Grab the ore the meteors leave behind.' },
};
const ORDER = ['storm', 'core', 'rush', 'boss'];
const WARN_MS = 45_000;
const GAP_MIN_MS = Math.round(2.5 * 60_000);
const GAP_MAX_MS = Math.round(3.5 * 60_000);
const BREATHER_MS = 35_000;
const FIRST_MS = 45_000;
const PODIUM = [500, 300, 200];
const ACTIVITY_CAP = 2000;

function envMs(k, d) {
    const v = parseFloat(process.env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
}

function pickKind(history, rng = Math.random, allowed = ORDER) {
    const pool = allowed.filter(k => KINDS[k]);
    if (!pool.length) return null;
    const last = history.length ? history[history.length - 1] : null;
    let cands = pool.filter(k => k !== last);
    if (!cands.length) cands = pool.slice();
    const ageOf = (k) => {
        for (let i = history.length - 1; i >= 0; i--) if (history[i] === k) return history.length - 1 - i;
        return Infinity;
    };
    const overdue = cands.filter(k => ageOf(k) >= pool.length);
    const fresh = cands.filter(k => ageOf(k) >= Math.min(3, pool.length - 1));
    let choose = overdue.length ? overdue : fresh.length ? fresh : cands;
    if (overdue.length) {
        const oldest = Math.max(...overdue.map(ageOf));
        choose = overdue.filter(k => ageOf(k) === oldest);
    }
    return choose[Math.floor(rng() * choose.length) % choose.length];
}

const DIRS = ['East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest', 'North', 'Northeast'];
function compassName(x, y, mapR = 4000) {
    if (Math.hypot(x, y) < mapR * 0.18) return 'the Centre';
    const a = Math.atan2(y, x);
    const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return 'the ' + DIRS[i];
}

function regions(mapR) {
    const out = [];
    const d = mapR * 0.55;
    for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        const x = Math.round(Math.cos(a) * d), y = Math.round(Math.sin(a) * d);
        out.push({ id: i, x, y, name: 'the ' + DIRS[i] });
    }
    out.push({ id: 8, x: 0, y: 0, name: 'the Centre' });
    return out;
}

function pickRegion(list, last, rng = Math.random, mapR = 4000) {
    if (!list || !list.length) return null;
    if (!last) return list[Math.floor(rng() * list.length) % list.length];
    const scored = list.filter(r => r.id !== last.id).map(r => ({ r, d: Math.hypot(r.x - last.x, r.y - last.y) }));
    if (!scored.length) return list[0];
    const far = scored.filter(s => s.d >= mapR * 0.75);
    const pool = far.length ? far : scored.sort((a, b) => b.d - a.d).slice(0, 3);
    return pool[Math.floor(rng() * pool.length) % pool.length].r;
}

function nextStartAt(prevStartAt, prevEndAt, rng = Math.random, gapMin = GAP_MIN_MS, gapMax = GAP_MAX_MS, breather = BREATHER_MS) {
    const gap = gapMin + (gapMax - gapMin) * rng();
    return Math.round(Math.max(prevStartAt + gap, prevEndAt + breather));
}

function scaleFor(tanks) {
    const n = Math.max(1, tanks | 0);
    return {
        tanks: n,
        stormR: Math.round(Math.max(1250, Math.min(1900, 1050 + 60 * n))),
        stormEnd: Math.round(Math.max(220, Math.min(380, 160 + 14 * n))),
        rushR: Math.round(Math.max(460, Math.min(680, 400 + 18 * n))),
        hillR: Math.round(Math.max(320, Math.min(440, 280 + 9 * n))),
        hillPps: 10,
        coreHp: Math.max(0.45, Math.min(0.9, 0.35 + 0.05 * n)),
        coreGems: Math.round(Math.max(4000, Math.min(12000, 2500 + 600 * n)) / 100) * 100,
    };
}

function ranked(scores) {
    const list = [];
    for (const e of scores.values ? scores.values() : scores) {
        if (!e || !(e.pts > 0)) continue;
        list.push(e);
    }
    list.sort((a, b) => (b.pts - a.pts) || ((a.at || 0) - (b.at || 0)));
    return list;
}

function awardsFor(scores, podium = PODIUM, cap = ACTIVITY_CAP) {
    return ranked(scores).map((e, i) => {
        const base = Math.min(cap, Math.max(0, Math.round(e.pts)));
        const bonus = i < podium.length ? podium[i] : 0;
        return { key: e.key, name: e.name, place: i + 1, pts: base + bonus, base, bonus, isBot: !!e.isBot, c: e.c };
    });
}

function placeOf(scores, key) {
    const list = ranked(scores);
    for (let i = 0; i < list.length; i++) if (list[i].key === key) return { place: i + 1, pts: Math.round(list[i].pts), of: list.length };
    return { place: 0, pts: 0, of: list.length };
}

function ordinal(n) {
    n |= 0;
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
    return n + s;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function dayKey(ms) { return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10); }
function nextResetAt(ms) { return (Math.floor(ms / DAY_MS) + 1) * DAY_MS; }

module.exports = {
    KINDS, ORDER, WARN_MS, GAP_MIN_MS, GAP_MAX_MS, BREATHER_MS, FIRST_MS, PODIUM, ACTIVITY_CAP, DAY_MS, DIRS,
    envMs, pickKind, regions, pickRegion, compassName, nextStartAt, scaleFor, ranked, awardsFor, placeOf, ordinal, dayKey, nextResetAt,
};
