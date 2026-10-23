'use strict';

const ON = process.env.ROYALE_HUNTED !== '0';
const HUNTED_AT = 500;
const HUNTED_OFF = 500;
const TOP_AT = 500;
const TOP_LEAD = 150;
const EVERY_MS = 500;
const HUNTER_R = 1500;
const BOUNTY = { 1: { frac: 0.15, pts: 250 }, 2: { frac: 0.2, pts: 350 } };
const BOUNTY_MAX = 800;
const TOP_FEED_GAP_MS = 30_000;

let lastAt = 0;
let top = null;
const tops = new Map();
let list = [];
let epoch = 1;
let hooks = {};

function attach(h) { hooks = h || {}; }

const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());
function teamsOn() { return typeof Config !== 'undefined' && !!Config.royale_teams; }
const isTeam = (t) => t === -1 || t === -2;

function bankedThisRaid(body) {
    const holder = body.socket || body;
    return holder._huntBankEpoch === epoch;
}
function onBanked(body) {
    if (!body) return;
    (body.socket || body)._huntBankEpoch = epoch;
}
function exempt(body) {
    return !!(body.socket && body.botNewbie && !bankedThisRaid(body));
}

function sameSide(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.team != null && a.team === b.team;
}

function levelFor(score, prev) {
    if (score >= HUNTED_AT) return 1;
    if (prev > 0 && score >= HUNTED_OFF) return 1;
    return 0;
}

function scoreOf(b) {
    try { return hooks.scoreOf ? (hooks.scoreOf(b) | 0) : 0; } catch { return 0; }
}

function pickTop(cands, holder) {
    let best = null, bestS = -1;
    for (const b of cands) { const v = scoreOf(b); if (v > bestS) { bestS = v; best = b; } }
    if (!best || bestS < TOP_AT) return null;
    if (holder && holder !== best && cands.includes(holder) && bestS - scoreOf(holder) < TOP_LEAD) return holder;
    return best;
}

function say(body, kind, text, sub, dur) {
    if (!body || !body.socket || !hooks.callout) return;
    try { hooks.callout(body, kind, text, 0, sub, dur); } catch { /* */ }
}

function onChange(body, prev, next, t) {
    if (next > prev) {
        const sub = teamsOn() && isTeam(body.team)
            ? "You're your team's #1, so the other team can see you on the map."
            : "You're #1 on the leaderboard, so everyone can see you on the map.";
        say(body, 'toptarget', "YOU'RE HUNTED", sub, 3200);
        if (hooks.feed && t - (body._huntFeedAt || 0) > TOP_FEED_GAP_MS) {
            body._huntFeedAt = t;
            try { hooks.feed({ hunt: 1, name: body.name || "Someone", g: body.carriedGems | 0 }); } catch { /* */ }
        }
    } else if (next === 0 && prev > 0) {
        say(body, 'safe', "SAFE", "Someone passed you on the leaderboard, so the hunt is off.", 1800);
    }
}

function tick(t, fighters) {
    if (!ON || t - lastAt < EVERY_MS) return;
    lastAt = t;
    const live = [];
    const groups = new Map();
    const teams = teamsOn();
    for (const b of fighters || []) {
        if (!alive(b) || b.royaleFrozen) { if (b) b.huntedLevel = 0; continue; }
        live.push(b);
        if (exempt(b)) continue;
        const g = teams && isTeam(b.team) ? b.team : 'all';
        let arr = groups.get(g);
        if (!arr) groups.set(g, arr = []);
        arr.push(b);
    }
    const marked = new Set();
    for (const [g, cands] of groups) {
        const holder = pickTop(cands, tops.get(g));
        if (holder) { tops.set(g, holder); marked.add(holder); } else tops.delete(g);
    }
    for (const g of [...tops.keys()]) if (!groups.has(g)) tops.delete(g);
    top = tops.get('all') || null;
    list = [];
    for (const b of live) {
        const prev = b.huntedLevel | 0;
        const next = marked.has(b) ? 2 : 0;
        b.huntedLevel = next;
        if (next !== prev) onChange(b, prev, next, t);
        if (!next) { b._huntersNear = 0; continue; }
        let n = 0;
        for (const o of live) {
            if (sameSide(o, b) || o.isRoyaleBoss || o.isTitan) continue;
            const dx = o.x - b.x, dy = o.y - b.y;
            if (dx * dx + dy * dy <= HUNTER_R * HUNTER_R) n++;
        }
        b._huntersNear = n;
        list.push(b);
    }
}

function seenAt(b) { try { return require('./abilities.js').shownAt(b); } catch { return b; } }
function snapshot() {
    if (!ON) return undefined;
    const out = [];
    for (const b of list) {
        if (!alive(b) || !b.huntedLevel) continue;
        const at = seenAt(b);     // in a smoke cloud: where it went in
        out.push({ e: b.id, x: Math.round(at.x), y: Math.round(at.y), l: b.huntedLevel, g: Math.floor((b.carriedGems | 0) / 10) * 10,
            n: String(b.name || "Someone").slice(0, 16), tm: b.team });
    }
    return out;
}

// RY you.hunt for the hunted player themselves
function forClient(body) {
    if (!ON || !alive(body) || !body.huntedLevel) return undefined;
    return { l: body.huntedLevel, n: body._huntersNear | 0 };
}

// The kill: the bounty owed to `killer`, or null. `level` is what the victim
// was marked at when it died (onDeath has cleared it by now).
function onKill(killer, victim, carried, level = victim && victim.huntedLevel) {
    if (!ON || !victim) return null;
    const l = level | 0;
    victim.huntedLevel = 0;
    if (top === victim) top = null;
    for (const [g, b] of tops) if (b === victim) tops.delete(g);
    if (!l || !killer || killer === victim || sameSide(killer, victim)) return null;
    const b = BOUNTY[l] || BOUNTY[1];
    const gems = Math.min(BOUNTY_MAX, Math.round((Math.max(0, carried | 0) * b.frac) / 5) * 5);
    return { gems, pts: b.pts, level: l };
}

function onDeath(body) {
    if (!body) return;
    body.huntedLevel = 0;
    body._huntersNear = 0;
    if (top === body) top = null;
    for (const [g, b] of tops) if (b === body) tops.delete(g);
}

function reset() {
    lastAt = 0;
    top = null;
    tops.clear();
    for (const b of list) if (b) { b.huntedLevel = 0; b._huntersNear = 0; }
    list = [];
    epoch++;
}

function current() { return list.filter(b => alive(b) && b.huntedLevel); }
function topTarget() { return alive(top) && top.huntedLevel === 2 ? top : null; }
function topOf(team) { const b = tops.get(team); return alive(b) && b.huntedLevel === 2 ? b : null; }

module.exports = {
    ON, HUNTED_AT, HUNTED_OFF, TOP_AT, TOP_LEAD, EVERY_MS, HUNTER_R, BOUNTY, BOUNTY_MAX,
    attach, tick, snapshot, forClient, onKill, onDeath, onBanked, bankedThisRaid, reset, current, topTarget, topOf, levelFor,
};
