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
// Round 10 leader bounty: whoever leads the board by LEADER.minLead or more
// carries a standing bounty of 10% of their lead over #2 (min 150, cap 2,500),
// paid by the raid to whoever takes them down (the leader loses nothing extra,
// banked gems stay safe). Same rule for humans and bots. It takes the bounty
// slot (the RY bounty marker and badge) while it lasts.
// Off since Oct 7 (the owner didn't like bounties; hunted and TOP TARGET stay):
// ROYALE_LEADER_BOUNTY=1 turns it back on, ROYALE_BOUNTY=1 the filler bounty.
const LEADER_ON = process.env.ROYALE_LEADER_BOUNTY === '1';
const BOUNTY_ON = process.env.ROYALE_BOUNTY === '1';
const LEADER = { frac: 0.10, min: 150, cap: 2500, minLead: 1000, minScore: 1500, everyMs: 1000, announceGapMs: 40_000 };
function leaderBountyFor(lead, score = Infinity) {
    if (!LEADER_ON || !(lead >= LEADER.minLead) || !(score >= LEADER.minScore)) return 0;
    return Math.max(LEADER.min, Math.min(LEADER.cap, Math.round((lead * LEADER.frac) / 5) * 5));
}
let leaderAt = 0;
// Round 12 leader hunt (late-raid tension, the same for a human or a bot #1):
// after the raid's opening grace, whoever leads #2 by HUNT.ratio or more is
// a priority target for bots within HUNT.r (controllers.js leaderPull, more
// the bigger the lead), and their spot is pinged on every minimap every
// HUNT.pingMs (shown HUNT.showMs). ROYALE_LEADER_HUNT=0 turns it off.
const HUNT_ON = process.env.ROYALE_LEADER_HUNT !== '0';
const HUNT = {
    ratio: +process.env.ROYALE_LEADER_HUNT_RATIO || 1.5, minScore: 1500, r: 2400, pingMs: 30_000, showMs: 6000,
    openMs: (() => { const v = parseFloat(process.env.ROYALE_OPEN_GRACE_S); return (Number.isFinite(v) && v >= 0 ? v : 180) * 1000; })(),
};
let hunt = null;                // { id, key, ratio, lead, name }
let huntPing = null;            // { id, x, y, name, at, ratio }
// the board's #1 over #2 as a ratio (Infinity with nobody else on points)
function leadRatio(score, lead) {
    const second = Math.max(0, score - lead);
    return second > 0 ? score / second : (score > 0 ? Infinity : 0);
}
function huntFor(L, t) {
    if (!HUNT_ON || !L || !alive(L.body) || L.body.royaleFrozen || !(L.score >= HUNT.minScore)) return null;
    const t0 = global.royaleRaidStartAt || 0;
    if (!(t0 > 0) || t - t0 < HUNT.openMs) return null;
    const ratio = leadRatio(L.score, L.lead);
    return ratio >= HUNT.ratio ? { id: L.body.id, key: L.key, ratio: Math.min(ratio, 5), lead: L.lead, name: L.body.name || "Someone" } : null;
}
function huntTick(L, t) {
    hunt = huntFor(L, t);
    global.royaleLeaderHunt = hunt;
    if (!hunt) return;
    if (huntPing && huntPing.id === hunt.id && t - huntPing.at < HUNT.pingMs) return;
    const b = L.body;
    let at = b;
    try { at = require('./abilities.js').shownAt(b); } catch { at = b; }
    const n = huntPing && huntPing.id === b.id && t - huntPing.at < HUNT.pingMs * 2 ? huntPing.n + 1 : 0;
    huntPing = { id: b.id, x: Math.round(at.x), y: Math.round(at.y), name: hunt.name, at: t, ratio: Math.round(hunt.ratio * 10) / 10, n };
    // the plate on the first ping of a run, then every third (the rest is the minimap)
    if (n % 3 === 0 && b.socket && hooks.callout) hooks.callout(b, "bounty", "You're the target", 0, "Leading " + (hunt.ratio >= 5 ? "big" : huntPing.ratio + "x") + ": your spot was pinged to everyone", 3000);
}
// RY: the latest leader ping while it shows, else null
function huntSnapshot(t = Date.now()) {
    if (!huntPing || t - huntPing.at > HUNT.showMs) return null;
    return { id: huntPing.id, x: huntPing.x, y: huntPing.y, name: huntPing.name, r: huntPing.ratio, ms: Math.max(0, HUNT.showMs - (t - huntPing.at)) };
}
let leaderAnnouncedAt = -Infinity;
let leaderAnnouncedKey = null;

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
    if (!BOUNTY_ON) return false;
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

// hooks.leader() -> { body, key, score, lead } for the board's #1 (body null
// while they're down), or null
function leaderTick(t) {
    if (!hooks || !hooks.leader || t - leaderAt < LEADER.everyMs) return;
    leaderAt = t;
    let L = null;
    try { L = hooks.leader(); } catch { L = null; }
    try { huntTick(L, t); } catch { hunt = null; global.royaleLeaderHunt = null; }
    if (!LEADER_ON) return;
    const gems = L ? leaderBountyFor(L.lead, L.score) : 0;
    const body = gems && L && alive(L.body) && !L.body.royaleFrozen ? L.body : null;
    if (!body) {
        if (bounty && bounty.leader) bounty = null;
        return;
    }
    if (bounty && bounty.leader && bounty.body === body) { bounty.gems = gems; bounty.lead = L.lead; return; }
    // a new leader (or the first): the slot is theirs, a filler bounty gives way
    const key = L.key != null ? L.key : (hooks.keyOf ? hooks.keyOf(body) : null);
    bounty = { body, key, name: body.name || "Someone", until: Infinity, gems, lead: L.lead, at: t, leader: true };
    if (key !== leaderAnnouncedKey && t - leaderAnnouncedAt >= LEADER.announceGapMs) {
        leaderAnnouncedKey = key;
        leaderAnnouncedAt = t;
        if (hooks.announce) hooks.announce("Bounty on the leader: " + bounty.name + ". " + gems.toLocaleString('en-US') + " gems to whoever takes them down.", { event: 1, kind: 'bounty', name: bounty.name, lead: 1 });
        if (body.socket && hooks.callout) hooks.callout(body, "bounty", "Bounty on the leader", 0, "You lead the raid. Everyone gets paid for taking you down.", 3500);
    }
}

function tick(t = Date.now()) {
    if (!hooks || (hooks.live && !hooks.live())) return;
    if (!lastBeatAt) note('start', t);
    leaderTick(t);
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
// `mult` is the kill's share (a bot victim pays a share, like every kill bonus).
// The leader bounty pays bots too (hooks.payAny), the same rule for everyone.
function onKill(killer, victim, mult = 1) {
    if (!bounty || bounty.body !== victim) return 0;
    const b = bounty;
    bounty = null;
    if (b.leader) {
        leaderAt = 0;       // the next tick picks the next leader
        if (!killer || killer === victim || (killer.team != null && killer.team === victim.team)) return 0;
        const gems = Math.max(0, Math.round((b.gems * (mult > 0 ? mult : 0)) / 5) * 5);
        if (!gems || !hooks) return 0;
        const pay = hooks.payAny || hooks.pay;
        if (pay) pay(killer, gems, 'leaderBounty');
        if (killer.socket && hooks.callout) hooks.callout(killer, "bounty", "Leader bounty claimed", 0, "+" + gems.toLocaleString('en-US') + " gems banked");
        if (hooks.announce) hooks.announce((killer.name || "Someone") + " took down the leader " + b.name + " for " + gems.toLocaleString('en-US') + " bounty gems.", null);
        return gems;
    }
    const gems = b.gems;
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
    // a leader bounty has no clock (ms 0) and says so (lead: 1)
    return { e: b.body.id, x: Math.round(at.x), y: Math.round(at.y), name: b.name, gems: b.gems, ms: b.leader ? 0 : Math.max(0, b.until - t), lead: b.leader ? 1 : undefined };
}

function reset(t = Date.now()) {
    bounty = null;
    hunt = null; huntPing = null; global.royaleLeaderHunt = null;
    leaderAt = 0;
    leaderAnnouncedAt = -Infinity;
    leaderAnnouncedKey = null;
    lastBeatAt = t;
    gap = rollGap();
    log = [];
}

// DBG supply / bounty: fire that filler now
function debugFire(kind, t = Date.now()) { return kind === 'bounty' ? startBounty(t) : supplyDrop(t); }

module.exports = { BOUNTY_ON, HUNT, HUNT_ON, leadRatio, huntFor, huntSnapshot, hunt: () => hunt, LEADER, LEADER_ON, leaderBountyFor, leaderTick, attach, note, tick, debugFire, onKill, current, snapshot, reset, recent: () => log.slice(), GAP_MIN_MS, GAP_MAX_MS, BOUNTY_MS, BOUNTY_GEMS };
