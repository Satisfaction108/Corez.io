// Raid pacing: something worth hearing about every 60-90 s. The big beats
// already have their own clocks (blooms and events once per storm cycle,
// the boss every ~14 min, the storm moving every 7 min); dig_royale.js
// reports each one here with note(). When the raid goes quiet for longer
// than the current gap, this fills it, taking turns:
//
//   supply drop  an extra epic chest with a kit item, dropped near a player
//                who is actually playing (chests.spawnSupplyDrop)
//   bounty       the raid leader (or whoever is hauling the most) is marked
//                for BOUNTY_MS; whoever takes them down collects, and if
//                they live through it they get paid instead
//
// Nothing fires in the storm spawn lock, between raids, or with nobody to
// see it.
'use strict';

const GAP_MIN_MS = 60_000;
const GAP_MAX_MS = 90_000;
const BOUNTY_MS = 90_000;
const BOUNTY_GEMS = 300;
const BOUNTY_MIN_SCORE = 400;      // nobody worth a bounty below this
const SUPPLY_DIST = 750;

let lastBeatAt = 0;
let gap = GAP_MAX_MS;
let lastFiller = 'bounty';
let bounty = null;              // { body, key, name, until, gems, at }
let log = [];                   // recent beats, for tests and DBG
let hooks = null;

// dig_royale.js: humans(), fighters(), scoreOf(body), keyOf(body),
// announce(text, feed), fxAt(x, y, kind), live() (a raid is running),
// idle(sock) (no real input lately)
function attach(h) { hooks = h; }

function rollGap() { return GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS); }

function note(kind, t = Date.now()) {
    lastBeatAt = t;
    gap = rollGap();
    log.push({ kind, at: t });
    if (log.length > 40) log.shift();
}

function storm() { return require('./storm.js'); }
function compass(x, y) {
    const a = Math.atan2(y, x);
    const dirs = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
    const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return Math.hypot(x, y) < 500 ? "the centre" : "the " + dirs[i];
}
const alive = e => !!e && !(e.isDead && e.isDead()) && !e.isGhost;

function activeHumans() {
    const list = hooks && hooks.humans ? hooks.humans() : [];
    return list.filter(b => b.socket && !(hooks.idle && hooks.idle(b.socket)));
}

function supplyDrop(t) {
    // the scheduled sky drops (supplyDrops.js) cover this when they're on
    try { if (require('./supplyDrops.js').enabled()) return false; } catch { /* */ }
    const people = activeHumans();
    if (!people.length) return false;
    // one of the players at random, so everyone gets one near them over a raid
    const who = people[(Math.random() * people.length) | 0];
    const chests = require('./chests.js');
    const o = chests.spawnSupplyDrop(who.x, who.y, SUPPLY_DIST);
    if (!o) return false;
    const where = compass(o.x, o.y);
    if (hooks.announce) hooks.announce("Supply drop landing in " + where + ". There's a kit item inside.", { event: 1, kind: 'supply', name: where });
    if (hooks.fxAt) hooks.fxAt(o.x, o.y, 'supply');
    note('supply', t);
    return true;
}

function startBounty(t) {
    const list = hooks && hooks.fighters ? hooks.fighters() : [];
    let best = null, bs = BOUNTY_MIN_SCORE - 1;
    for (const b of list) {
        if (!alive(b) || b.isRoyaleBoss) continue;
        if (b.socket && hooks.idle && hooks.idle(b.socket)) continue;
        if (storm().inStorm(b.x, b.y, t)) continue;
        // score, or a heavy satchel counts nearly as much
        const s = Math.max(hooks.scoreOf ? hooks.scoreOf(b) : 0, ((b.carriedGems || 0) | 0) * 0.8);
        if (s > bs) { bs = s; best = b; }
    }
    if (!best) return false;
    bounty = { body: best, key: hooks.keyOf ? hooks.keyOf(best) : null, name: best.name || "Someone", until: t + BOUNTY_MS, gems: BOUNTY_GEMS, at: t };
    if (hooks.announce) hooks.announce("Bounty on " + bounty.name + ". " + BOUNTY_GEMS + " gems to whoever takes them down.", { event: 1, kind: 'bounty', name: bounty.name });
    if (best.socket && hooks.callout) hooks.callout(best, "bounty", "You're the bounty", 0, "Stay alive " + Math.round(BOUNTY_MS / 1000) + "s for a payout", 3500);
    note('bounty', t);
    return true;
}

function tick(t = Date.now()) {
    if (!hooks || (hooks.live && !hooks.live())) return;
    if (!lastBeatAt) note('start', t);
    if (bounty) {
        if (!alive(bounty.body)) bounty = null;
        else if (t >= bounty.until) {
            const b = bounty.body;
            bounty = null;
            // lived through it
            if (b.socket && hooks.pay && !(hooks.idle && hooks.idle(b.socket))) {
                hooks.pay(b, BOUNTY_GEMS, 'bountySurvive');
                if (hooks.callout) hooks.callout(b, "bounty", "You outlasted the bounty", 0, "+" + BOUNTY_GEMS + " gems");
            }
        }
    }
    if (t - lastBeatAt < gap) return;
    try { if (storm().locked(t)) return; } catch { /* */ }
    if (!activeHumans().length) { lastBeatAt = t - gap + 10_000; return; }
    // take turns; if one can't happen right now, try the other
    const order = lastFiller === 'supply' ? ['bounty', 'supply'] : ['supply', 'bounty'];
    for (const kind of order) {
        const ok = kind === 'supply' ? supplyDrop(t) : (!bounty && startBounty(t));
        if (ok) { lastFiller = kind; return; }
    }
    // nothing to do: look again in a bit
    lastBeatAt = t - gap + 10_000;
}

// A kill: the bounty pays out to whoever took the target down.
// -> the gems paid (0 if it wasn't the bounty)
function onKill(killer, victim) {
    if (!bounty || bounty.body !== victim) return 0;
    const gems = bounty.gems;
    bounty = null;
    if (killer && killer.socket && hooks && hooks.pay) {
        hooks.pay(killer, gems, 'bounty');
        if (hooks.callout) hooks.callout(killer, "bounty", "Bounty claimed", 0, "+" + gems + " gems");
    }
    return gems;
}

function current() { return bounty && alive(bounty.body) ? bounty : null; }

function snapshot(t = Date.now()) {
    const b = current();
    if (!b) return null;
    let at = b.body;
    try { at = require('./abilities.js').shownAt(b.body); } catch { at = b.body; }     // smoke: where it went in
    return { e: b.body.id, x: Math.round(at.x), y: Math.round(at.y), name: b.name, gems: b.gems, ms: Math.max(0, b.until - t) };
}

function reset(t = Date.now()) {
    bounty = null;
    lastBeatAt = t;
    gap = rollGap();
    log = [];
}

// DBG supply / bounty: fire that filler now
function debugFire(kind, t = Date.now()) { return kind === 'bounty' ? startBounty(t) : supplyDrop(t); }

module.exports = { attach, note, tick, debugFire, onKill, current, snapshot, reset, recent: () => log.slice(), GAP_MIN_MS, GAP_MAX_MS, BOUNTY_MS, BOUNTY_GEMS };
