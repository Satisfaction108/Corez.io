// Carriers get hunted. A tank hauling a lot of unbanked gems shows up on
// every minimap; the biggest haul in the raid is the TOP TARGET. Whoever
// takes a hunted tank down cashes a bounty on top of the gems it drops.
// Banking (or spending) back under the line takes the mark off.
//
//   level 1  HUNTED      carrying HUNTED_AT or more (stays on down to HUNTED_OFF)
//   level 2  TOP TARGET  the single biggest carrier, at TOP_AT or more
//
// body.huntedLevel is the shared state (bots read it too). Levels are worked
// out every EVERY_MS, not every tick. A brand new player (botNewbie) is left
// alone until they have banked once this raid (bots read the mark, so this only
//
// ROYALE_HUNTED=0 turns the whole thing off.
'use strict';

const ON = process.env.ROYALE_HUNTED !== '0';
const HUNTED_AT = 1500;
const HUNTED_OFF = 1200;
const TOP_AT = 2500;
const TOP_LEAD = 150;          // a new top target has to pass the old one by this much
const EVERY_MS = 500;
const HUNTER_R = 1500;         // enemies this close count as hunters
// bounty: a share of what they carried, paid by the raid (not out of the drop)
const BOUNTY = { 1: { frac: 0.15, pts: 150 }, 2: { frac: 0.2, pts: 300 } };
const BOUNTY_MAX = 800;
const TOP_FEED_GAP_MS = 30_000;

let lastAt = 0;
let top = null;
let list = [];
let epoch = 1;
let hooks = {};

// dig_royale.js: callout(body, kind, text, pts, sub, dur), feed(entry)
function attach(h) { hooks = h || {}; }

const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());

function bankedThisRaid(body) {
    const holder = body.socket || body;
    return holder._huntBankEpoch === epoch;
}
function onBanked(body) {
    if (!body) return;
    (body.socket || body)._huntBankEpoch = epoch;
}
// newbie window: a fully new player is not marked until their first bank
function exempt(body) {
    return !!(body.socket && body.botNewbie && !bankedThisRaid(body));
}

function sameSide(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.team != null && a.team === b.team;
}

function levelFor(carried, prev) {
    if (carried >= HUNTED_AT) return 1;
    if (prev > 0 && carried >= HUNTED_OFF) return 1;
    return 0;
}

function pickTop(cands) {
    let best = null;
    for (const b of cands) if (!best || (b.carriedGems | 0) > (best.carriedGems | 0)) best = b;
    if (!best) return null;
    // the current top keeps it until someone clearly passes them
    if (top && top !== best && cands.includes(top) && (best.carriedGems | 0) - (top.carriedGems | 0) < TOP_LEAD) return top;
    return best;
}

function say(body, kind, text, sub, dur) {
    if (!body || !body.socket || !hooks.callout) return;
    try { hooks.callout(body, kind, text, 0, sub, dur); } catch { /* */ }
}

function onChange(body, prev, next, t) {
    if (next > prev) {
        if (next === 2) {
            say(body, 'toptarget', "TOP TARGET", "Biggest haul in the raid. Everyone's after you.", 3200);
            if (hooks.feed && t - (body._huntFeedAt || 0) > TOP_FEED_GAP_MS) {
                body._huntFeedAt = t;
                try { hooks.feed({ hunt: 1, name: body.name || "Someone", g: body.carriedGems | 0 }); } catch { /* */ }
            }
        } else if (prev === 0) {
            say(body, 'hunted', "YOU'RE HUNTED", "Everyone sees you on the map. Bank it or fight.", 3000);
        }
    } else if (next === 0 && prev > 0) {
        const banking = !!(body.vaultDeposit || body.vaultOnPad || body.outpostDeposit);
        say(body, 'safe', "SAFE", banking ? "Banked. The hunt is off." : "You're off the map.", 1800);
    }
}

function tick(t, fighters) {
    if (!ON || t - lastAt < EVERY_MS) return;
    lastAt = t;
    const live = [];
    const cands = [];
    for (const b of fighters || []) {
        if (!alive(b) || b.royaleFrozen) { if (b) b.huntedLevel = 0; continue; }
        const lvl = exempt(b) ? 0 : levelFor(b.carriedGems | 0, b.huntedLevel | 0);
        b._huntBase = lvl;
        live.push(b);
        if (lvl && (b.carriedGems | 0) >= (b === top ? TOP_AT - TOP_LEAD : TOP_AT)) cands.push(b);
    }
    top = pickTop(cands);
    list = [];
    for (const b of live) {
        const prev = b.huntedLevel | 0;
        const next = b._huntBase ? (b === top ? 2 : 1) : 0;
        b.huntedLevel = next;
        if (next !== prev) onChange(b, prev, next, t);
        if (!next) { b._huntersNear = 0; continue; }
        let n = 0;
        for (const o of live) {
            if (sameSide(o, b) || o.isRoyaleBoss) continue;
            const dx = o.x - b.x, dy = o.y - b.y;
            if (dx * dx + dy * dy <= HUNTER_R * HUNTER_R) n++;
        }
        b._huntersNear = n;
        list.push(b);
    }
}

// RY: everyone's map. g is the haul rounded down to 10, tm the team (the
// client leaves its own team out).
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
}

function reset() {
    lastAt = 0;
    top = null;
    for (const b of list) if (b) { b.huntedLevel = 0; b._huntersNear = 0; }
    list = [];
    epoch++;
}

function current() { return list.filter(b => alive(b) && b.huntedLevel); }
function topTarget() { return alive(top) && top.huntedLevel === 2 ? top : null; }

module.exports = {
    ON, HUNTED_AT, HUNTED_OFF, TOP_AT, TOP_LEAD, EVERY_MS, HUNTER_R, BOUNTY, BOUNTY_MAX,
    attach, tick, snapshot, forClient, onKill, onDeath, onBanked, bankedThisRaid, reset, current, topTarget, levelFor,
};
