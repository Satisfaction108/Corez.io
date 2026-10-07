// The Core: the raid's last fight. When the final storm cycle starts, a huge
// crystal heart surfaces beside the Center Vault and the last circle closes
// on the pair of them. It takes a whole raid's focused fire (about a
// minute, see healthFor), throws a shockwave every few seconds that shoves
// tanks back and cracks the rock around it, and fights back as it breaks:
// from SHARD_BELOW its six barrels fire bolts at whoever is close and it
// sends out drones that chase them (both dodgeable, both shot down by
// players' bullets, drones and traps, blocked by rock, killed on vault and
// shop pads), from RAGE_BELOW a bit faster and more drones, and
// the shockwave hurts. Hits are a share of the target's max health, metered
// per target (CAP_S), so grown and tiny tanks last about as long. The
// shockwave is telegraphed (FX corecharge), and so is the start of each
// attack phase. ROYALE_CORE_ATTACK=shards brings back the old shard volleys. Breaking it: it caves in to a bright point for
// COLLAPSE_MS (FX corecollapse), then blows (FX coredead) and throws all
// CORE_BANK gems across the final circle. Nothing is banked for anyone:
// grab what you can and get it to the vault before the storm shuts.
//
// The site is picked at raid start (so storm.js can aim the final circle at
// it): CORE_OFFSET from the Center Vault in a random direction, and the final
// circle centres halfway between the two. The rock around the site is
// cleared to an arena when it surfaces: everything inside ARENA_R, a lane to
// the vault, and about half of the rock out to COVER_R (cover).
//
// ROYALE_CORE=0 turns it off (the final circle goes back to a random centre).
'use strict';

const gems = require('./gems.js');

const ON = process.env.ROYALE_CORE !== '0';
const CORE_OFFSET = 330;
const ARENA_R = 250;
const LANE_R = 150;
const COVER_R = 560;
const COVER_KEEP = 0.45;           // share of the rock in the cover ring that stays
const ZONE_R = 640;                // no regrow around the site while the Core stands
const AFTER_MS = 25_000;           // ...and this long after it breaks
const WARN_S = 30;                 // "something is waking" this long before it surfaces
const PULSE_MS = 8000;
const PULSE_FAST_MS = 5500;        // below half health
const PULSE_FIRST_MS = 6000;
const PULSE_R = 620;
const PULSE_PUSH = 24;             // outward kick at the rim of the Core, u/tick
const PULSE_DMG = 0.12;            // of max health hugging the Core, from SHARD_BELOW (and PULSE_RAGE_DMG below RAGE_BELOW); 0.08 Oct 6, back to 0.12 Oct 7 now it fades out and the dodge works
// Oct 7 2026: it fades to nothing at PULSE_R (it was half strength out
// there, so nobody in the arena could get clear of it): backing off on the
// wind-up is the dodge
const PULSE_RAGE_DMG = 0.18;       // 0.12 Oct 6, back to 0.18 Oct 7: standing in it is the careless death
const CHARGE_MS = 1100;            // the telegraph before a shockwave (was 900)
const SHARD_CHARGE_MS = 600;       // ...and before a volley of shards
const PULSE_ROCK = 0.55;           // of a rock's max health
const SHARD_BELOW = 0.5;
const RAGE_BELOW = 0.25;
const SHARD_MS = 2200;
const SHARD_RAGE_MS = 1300;
const PULSE_RAGE_MS = 5000;        // was 4200 (Oct 6: the Core killed in ~6 s)
const SHARD_R = 950;
const SHARD_N = 3;
const SHARD_RAGE_N = 4;
const SHARD_FLIGHT_MS = 650;       // where it lands is marked this long first
const SHARD_HIT_R = 70;
const SHARD_DMG = 0.13;            // of max health: it was barely felt at 0.09
const SHARD_RAGE_DMG = 0.17;
// Oct 6 2026: bolts and drones instead of the shards (they were undodgeable
// for a grown tank and killed in ~6 s). Standing still in the open next to
// it in rage, a tank loses about half its health in 10 s.
const SHARD_ATTACK = process.env.ROYALE_CORE_ATTACK === 'shards';
const BARRELS = 6;
const BARREL_SPIN = 0.0025;        // rad per tick the barrel ring turns
const BOLT_MS = 1200, BOLT_RAGE_MS = 850;
const BOLT_TARGETS = 3, BOLT_RAGE_TARGETS = 4;
const BOLT_R = 950;                // fires at tanks this close
// Oct 7 2026: bolts were noclip with 2000 health, so nothing a player fired
// could touch them ("I can't even kill its bullets"), and at 12 u/tick they
// outran an average bullet (basic ~9). Now they fly at bullet speed (~1.1 s
// to cross 300) and anyone's shots meet them: every hostile bullet, drone or
// trap that touches one takes BOLT_HP off it (its damage; traps count
// double), a hit blunts it (what lands scales with what is left) and it
// breaks at zero. About 5 shots of an average basic, 2-3 shells, 3 drones.
const BOLT_SPEED = 9;              // u/tick (was 12)
const BOLT_RANGE = 1100;
const BOLT_RADIUS = 12;
const BOLT_HIT = 0.045;            // of max health a bolt at full strength, rage too (was 0.03: most are shot down or blunted now)
const BOLT_HP = 70;                // in shot damage: an average basic bullet is ~16
const BOLT_TRAP_MULT = 2;          // a trap is a wall: it counts double
const BOLT_BLOCK_WEAR = 0.5;       // a drone or trap that stops one loses this share of its max health (scaled by the bolt's strength)
const DRONE_MAX = 4, DRONE_RAGE_MAX = 6;
const DRONE_MS = 2600, DRONE_RAGE_MS = 1700;
const DRONE_SPEED = 5.5;
const DRONE_SENSE = 900;           // chases tanks this close to it...
const DRONE_LEASH = 1200;          // ...and this close to the Core
const DRONE_LIFE_MS = 15_000;
const DRONE_HP = 120;              // a few shots from anyone (~0.8 s of an average basic; was 60, shot down before it ever touched anyone)
const DRONE_HIT = 0.025;           // of max health a touch...
const DRONE_HIT_MS = 700;          // ...at most this often from one drone
// a target's Core damage (bolts and drones, not the shockwave) refills at
// CAP_S of max health a second, up to CAP_BURST
const CAP_S = 0.035, CAP_BURST = 0.06;   // was 0.03 / 0.045
const LAST_HIT_GEMS = 1000;
const CORE_BANK = 20_000;          // split among the players who broke it
const MIN_SHARE_AT = 0.02;         // dealt at least this share: never less than MIN_SHARE
const MIN_SHARE = 500;
const SPRAY_GEMS = 300;            // the little that still hits the ground
const LAST_HIT_PTS = 800;
const COLLAPSE_MS = 1600;          // caving in before it blows
const SPEW_PIECES = 100;          // each one is an entity with two props: more costs every client a lot in the final circle
const SPEW_EDGE = 0.92;            // gems land out to this share of the circle
const SPEW_MAX_R = 2400;
const GEM_TRAVEL = 21;             // a gem launched at v slides about 21 * v (measured)

// Ten times what it used to be at the base. A maxed tank puts ~700-1500 a
// second into it (a bot less), so ~1000 per human and ~400 per bot of
// focused fire: one player with five bots ~2 minutes, a full raid of 6-20
// humans 95-120 s. The Core is not a raid boss, so bossGuard's caps don't
// apply to it.
// Oct 3: three quarters of what it was (halved felt too quick), so a full
// raid breaks it in about a minute and a half.
// Oct 7 2026 (owner): about half of that, so three average players and a bot
// break it in about 2 minutes in the balance sim (it was ~3) and a full raid
// in ~40-45 s. Shootable bolts soak some of the fire, which is why it took
// more than the first cut (75_000 / 45_000 / 12_500 / 150_000 / 1_100_000).
// Was 112_500 / 67_500 / 18_750 / 225_000 / 1_650_000.
const HP_BASE = 58_500, HP_HUMAN = 35_000, HP_BOT = 9_750, HP_MIN = 117_000, HP_MAX = 855_000;
function healthFor(humans, bots) {
    return Math.round(Math.max(HP_MIN, Math.min(HP_MAX, HP_BASE + HP_HUMAN * humans + HP_BOT * bots)));
}
function gemsFor() { return CORE_BANK; }
// { body -> gems } for a pool split by damage dealt; bots get nothing
function splitPayout(dealtBy, pool = CORE_BANK) {
    let total = 0;
    for (const h of dealtBy.values()) total += Math.max(0, h.dmg || 0);
    const out = new Map();
    if (!(total > 0)) return out;
    for (const h of dealtBy.values()) {
        if (!h.body || !h.body.isPlayer || !(h.dmg > 0)) continue;
        const share = h.dmg / total;
        let n = Math.round(pool * share / 10) * 10;
        if (share >= MIN_SHARE_AT) n = Math.max(n, MIN_SHARE);
        if (n > 0) out.set(h.body, n);
    }
    return out;
}

let hooks = {};
let site = null;        // { x, y, mid: {x, y}, vault: {x, y} } for this raid
let core = null;
let state = 'idle';     // idle | planned | up | down
let warned = false;
let nextPulseAt = 0;
let nextShardAt = 0;
let charge = null;      // { kind: 'pulse' | 'shard', at } the attack being telegraphed
let shards = [];
let bolts = [];         // { e, vx, vy, left, at }
let drones = [];        // { e, until, hits: Map(target id -> ms) }
let nextBoltAt = 0;
let nextDroneAt = 0;
let phase = 0;          // 0 calm, 1 firing, 2 rage: a rise is telegraphed
let barrelAng = 0;let zone = null;
// what the fight did (tests and the balance sim read it through _state)
const freshStats = () => ({ bolts: 0, boltHits: 0, shotHits: 0, boltsShot: 0, drones: 0, dronesShot: 0, droneHits: 0, pulses: 0, pulseHits: 0 });
let stats = freshStats();
let hitters = new Map();
let coreGems = 0;
let brokeBy = "";
let brokeAt = 0;
let blast = null;       // { x, y, at } the caved-in Core, waiting to blow
let lastErr = "";

// dig_royale.js: humans(), fighters(), announce(kind, text, sub, dur) (every
// client), feed(entry), fxAt(x, y, kind), toast(text, ms), payGems(body, n),
// addPts(body, n), callout(body, kind, text, pts, sub, dur)
function attach(h) { hooks = h || {}; }
function enabled() { return ON && !!Config.dig_royale && !Config.tutorial; }

function storm() { return require('./storm.js'); }
function tg() { return global.gameManager && global.gameManager.terrainGrid; }
const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());

function hash01(k, s) {
    let h = (Math.imul((k | 0) + 1, 374761393) ^ Math.imul((s | 0) + 7, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1540483477);
    h ^= h >>> 15;
    return (h >>> 0) / 0x100000000;
}

// the vault the finale is built around: the one nearest the map centre
function centerVault() {
    let best = null;
    try {
        for (const v of require('./vault.js').getVaults()) {
            if (!best || Math.hypot(v.x, v.y) < Math.hypot(best.x, best.y)) best = v;
        }
    } catch { /* */ }
    return best || { x: 0, y: 0, r: 95 };
}

function planSite(ang = Math.random() * Math.PI * 2) {
    const v = centerVault();
    const x = v.x + Math.cos(ang) * CORE_OFFSET, y = v.y + Math.sin(ang) * CORE_OFFSET;
    return { x, y, mid: { x: (x + v.x) / 2, y: (y + v.y) / 2 }, vault: { x: v.x, y: v.y } };
}

// New raid: the old Core (if any) goes without paying, a new site is picked
// and the storm is told where to close the final circle.
function newRaid() {
    clear();
    if (!enabled()) { try { storm().setFinalCenter(null); } catch { /* */ } return; }
    site = planSite();
    state = 'planned';
    warned = false;
    try { storm().setFinalCenter(site.mid.x, site.mid.y); } catch { /* */ }
}

function clear() {
    if (core && alive(core)) { core._cleared = true; try { core.kill(); } catch { /* */ } }
    core = null;
    if (zone) { zone.until = Date.now(); zone = null; }
    state = 'idle';
    shards = [];
    killBrood();
    phase = 0;
    charge = null;
    hitters.clear();
    coreGems = 0;
    brokeBy = "";
    brokeAt = 0;
    blast = null;
    global.royaleCoreTruce = false;
}

// Clears the arena: returns how many rocks went.
function carveArena(s) {
    const grid = tg();
    if (!grid || !grid.rocks) return 0;
    let n = 0;
    const segD = (px, py) => {
        const ax = s.x, ay = s.y, bx = s.vault.x, by = s.vault.y;
        const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2));
        return Math.hypot(px - (ax + t * ex), py - (ay + t * ey));
    };
    for (const rock of grid.rocks.values()) {
        if (!rock || !(rock.alive || rock.growing)) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        const d = Math.hypot(rx - s.x, ry - s.y);
        if (d > COVER_R + 160) continue;
        let go = d <= ARENA_R || segD(rx, ry) <= LANE_R;
        if (!go && rock.worldPoly && d <= ARENA_R + 160) {
            for (const p of rock.worldPoly) { if (Math.hypot(p[0] - s.x, p[1] - s.y) <= ARENA_R) { go = true; break; } }
        }
        if (!go && d <= COVER_R && hash01(rock.k, 31) > COVER_KEEP) go = true;
        if (!go) continue;
        // an emerald stays put unless it sits right on the Core
        if (rock.ore === 4 && d > ARENA_R * 0.6) continue;
        try { grid.damageRock(rock, rock.health + rock.maxHealth + 1, rx, ry, false, null); n++; } catch { /* */ }
    }
    try { require('./spawnReach.js').invalidate(); } catch { /* */ }
    return n;
}

function spawnCore() {
    if (!site || core) return null;
    const f = hooks.fighters ? hooks.fighters() : [];
    const humans = hooks.humans ? hooks.humans().length : 0;
    const bots = Math.max(0, f.length - humans);
    carveArena(site);
    // nothing stays buried under it: chests in the arena go (and come back elsewhere)
    try { require('./chests.js').retireNear(site.x, site.y, ARENA_R + 120); } catch { /* */ }
    const grid = tg();
    try { if (grid && grid.addNoRegrowZone) zone = grid.addNoRegrowZone(site.x, site.y, ZONE_R, Number.MAX_SAFE_INTEGER); } catch { /* */ }
    let o;
    try {
        o = new Entity({ x: site.x, y: site.y });
        o.define('royaleCore');
    } catch (e) { lastErr = String(e && e.stack || e); state = 'idle'; return null; }
    o.team = TEAM_ROOM;
    // the chest rules: hard cover, only tanks and their shots hurt it
    o.isLootChest = true;
    o.isRoyaleCore = true;
    o.name = "The Core";
    o.alwaysActive = true;
    o.regenEvery = 1e9;
    o.settings.leaderboardable = false;
    o.refreshBodyAttributes();
    const hp = healthFor(humans, bots);
    o.health.set(hp);
    o.health.amount = hp;
    if (o.shield) { o.shield.max = 0; o.shield.amount = 0; }
    o.pinX = o.x; o.pinY = o.y;
    o.coreBornAt = Date.now();
    o.on('damage', ({ damageInflictor = [] } = {}) => {
        const t = Date.now();
        // what this tick lands, split among whoever put it there
        const each = damageInflictor.length ? Math.min(o.damageReceived || 0, o.health.amount + (o.shield ? o.shield.amount : 0)) / damageInflictor.length : 0;
        for (const src of damageInflictor) {
            let root = src, hops = 0;
            while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
            if (root && (root.isPlayer || root.isBot)) {
                // picking this fight drops a newcomer's last-blow mercy (bossGuard)
                if (root.isPlayer) root._hitBossAt = t;
                if (root.socket && !root._achCore && global.royaleAch) { root._achCore = 1; global.royaleAch.onCoreHit(root); }
                const h = hitters.get(root.id);
                hitters.set(root.id, { body: root, at: t, n: (h ? h.n : 0) + 1, dmg: (h ? h.dmg : 0) + each });
            }
        }
    });
    o.on('dead', () => { try { onBroken(o); } catch (e) { lastErr = String(e && e.stack || e); } });
    core = o;
    coreGems = gemsFor(humans, bots);
    state = 'up';
    nextPulseAt = Date.now() + PULSE_FIRST_MS;
    nextShardAt = 0;
    nextBoltAt = 0; nextDroneAt = 0; phase = 0;
    stats = freshStats();
    const fmt = (n) => n.toLocaleString('en-US');
    if (hooks.announce) hooks.announce('core', "THE CORE HAS SURFACED", "Break it and " + fmt(coreGems) + " gems blow out across the circle. Bank what you grab.", 4800);
    if (hooks.feed) hooks.feed({ core: 1, spawn: 1, g: coreGems });
    if (hooks.toast) hooks.toast("The Core has surfaced at the centre. Break it, grab the gems, bank them next door.", 9000);
    if (hooks.fxAt) hooks.fxAt(site.x, site.y, 'coreup');
    return o;
}

function rootKiller(o) {
    for (const k of (o.finalKillers || [])) {
        let root = k, hops = 0;
        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
        if (root && (root.isPlayer || root.isBot) && alive(root)) return root;
    }
    let best = null, bestAt = 0;
    for (const h of hitters.values()) if (alive(h.body) && h.at > bestAt) { best = h.body; bestAt = h.at; }
    return best;
}

function erupt(x, y, total) {
    let mult = (ore) => 1;
    try { const rm = require('./raidMods.js'); mult = (ore) => rm.gemValueMult(ore); } catch { /* */ }
    const pieces = gems.splitValue(total, { share: { 4: 0.2, 3: 0.4, 2: 0.25, 1: 0.15 }, shardValue: 120, maxPieces: 90 });
    const t = Date.now();
    pieces.forEach((p, i) => {
        const ang = (i / pieces.length) * Math.PI * 2 * 3 + Math.random() * 0.6;
        const sp = 3 + Math.random() * 8;
        const g = gems.spawnGem(x + Math.cos(ang) * 40, y + Math.sin(ang) * 40, Math.round(p.v * mult(p.ore)), p.cls, p.size,
            Math.cos(ang) * sp, Math.sin(ang) * sp, p.ore);
        if (g) { g.gemNoMagnetUntil = t + 1100 + (i % 30) * 25; g.gemLong = true; }
    });
    return pieces.length;
}

// Throws `total` gems out of (x, y) across the storm's circle, each aimed at
// a spot on open ground and launched hard enough to slide there.
function spew(x, y, total, t) {
    let mult = (ore) => 1;
    try { const rm = require('./raidMods.js'); mult = (ore) => rm.gemValueMult(ore); } catch { /* */ }
    let cx = x, cy = y, R = 1400;
    try { const st = storm().snapshot(t); if (st && st.r > 0) { cx = st.cx; cy = st.cy; R = st.r; } } catch { /* */ }
    R = Math.min(SPEW_MAX_R, Math.max(500, R * SPEW_EDGE));
    const g = tg();
    const pieces = gems.splitValue(total, { share: { 4: 0.2, 3: 0.4, 2: 0.25, 1: 0.15 }, shardValue: 150, maxPieces: SPEW_PIECES });
    pieces.forEach((p, i) => {
        let tx = cx, ty = cy;
        for (let k = 0; k < 8; k++) {
            const a = Math.random() * Math.PI * 2, r = R * Math.sqrt(Math.random());
            tx = cx + Math.cos(a) * r; ty = cy + Math.sin(a) * r;
            if (!g || !g.pointInRock || !g.pointInRock(tx, ty)) break;
        }
        const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy) || 1;
        const v = Math.min(120, d / GEM_TRAVEL);
        const gem = gems.spawnGem(x + dx / d * 30, y + dy / d * 30, Math.round(p.v * mult(p.ore)), p.cls, p.size, dx / d * v, dy / d * v, p.ore);
        // no magnet until it has landed
        if (gem) { gem.gemNoMagnetUntil = t + 1400 + (i % 20) * 30; gem.gemLong = true; }
    });
    return pieces.length;
}

function onBroken(o) {
    if (o !== core || state !== 'up') return;
    killBrood();
    state = 'down';
    core = null;
    brokeAt = Date.now();
    if (zone) zone.until = brokeAt + AFTER_MS + COLLAPSE_MS;
    if (o._cleared) return;
    const killer = rootKiller(o);
    brokeBy = killer ? String(killer.name || "Someone") : "";
    // it caves in first; tick() blows it COLLAPSE_MS later
    blast = { x: o.x, y: o.y, at: brokeAt + COLLAPSE_MS, killer };
    if (hooks.fxAt) hooks.fxAt(o.x, o.y, 'corecollapse', COLLAPSE_MS);
    if (killer && killer.socket) {
        if (global.royaleAch) { try { global.royaleAch.onCoreBreak(killer); } catch (e) { /* */ } }
        if (hooks.addPts) hooks.addPts(killer, LAST_HIT_PTS);
        if (hooks.callout) hooks.callout(killer, 'corebreak', "YOU BROKE THE CORE", LAST_HIT_PTS, "Get clear, it's about to blow.", 2600);
    }
}

function blow(t) {
    const b = blast;
    blast = null;
    spew(b.x, b.y, coreGems || CORE_BANK, t);
    if (hooks.fxAt) hooks.fxAt(b.x, b.y, 'coredead');
    if (hooks.announce) hooks.announce('coredown', "THE CORE IS DOWN", "Gems everywhere. Grab them and bank them before the storm shuts!", 4200, b.killer);
    if (hooks.feed) hooks.feed({ core: 1, broke: 1, by: brokeBy, g: coreGems });
    // the lucky drop for the breaker (terrain/coreDrop.js), after its slam
    if (b.killer && b.killer.socket && hooks.loot) { try { hooks.loot(b.killer); } catch (e) { /* */ } }
}

// its bolts and drones go with it
function killBrood() {
    for (const b of bolts) { try { if (b.e && !b.e.isDead?.()) b.e.kill(); } catch { /* */ } }
    for (const d of drones) { try { if (d.e && !d.e.isDead?.()) d.e.kill(); } catch { /* */ } }
    bolts = [];
    drones = [];
}

function hurt(body, frac, t) {
    if (!body.health || !(body.health.max > 0)) return;
    if ((body.spawnGraceUntil || 0) > t || body.godmode || body.royaleFrozen || body.invuln || body.padSafe) return;
    // the Core is the raid's last fight: it hits everyone the same, new
    // players included (no boss mercy here, a hit is 16% at most anyway)
    const dmg = body.health.max * frac;
    if (!(dmg > 0)) return;
    body.hitAt = t;
    if (body.shield && body.shield.amount > 0) {
        const soak = Math.min(body.shield.amount, dmg);
        body.shield.amount -= soak;
        body.health.amount -= (dmg - soak);
    } else body.health.amount -= dmg;
    body._lastDamageAt = t;
    if (body.health.amount <= 0) {
        body.deathCause = "core";
        body.dontSendDeathMessage = true;
    }
}

// A bolt or drone landing on `body`: `frac` of max health, metered per target
// (CAP_S a second, CAP_BURST stored). Returns the share that landed.
function projectileHit(body, frac, t = Date.now()) {
    if (!body || !body.health || !(body.health.max > 0)) return 0;
    if ((body.spawnGraceUntil || 0) > t || body.godmode || body.royaleFrozen || body.invuln || body.padSafe) return 0;
    const m = body._coreMeter || (body._coreMeter = { left: CAP_BURST, at: t });
    m.left = Math.min(CAP_BURST, m.left + Math.max(0, t - m.at) / 1000 * CAP_S);
    m.at = t;
    const f = Math.min(frac, m.left);
    if (!(f > 0)) return 0;
    m.left -= f;
    hurt(body, f, t);
    return f;
}
function eligible(b, t) {
    return alive(b) && !b.royaleFrozen && !((b.spawnGraceUntil || 0) > t) && !b.padSafe && !b.godmode;
}
function pads() {
    const out = [];
    try { for (const v of require('./vault.js').getVaults()) out.push(v); } catch { /* */ }
    try { for (const p of require('./shop.js').getShops()) out.push(p); } catch { /* */ }
    return out;
}
function onAnyPad(list, x, y, margin) {
    const padGeom = require('./padGeom.js');
    for (let i = 0; i < list.length; i++) if (padGeom.insidePad(list[i], x, y, margin)) return true;
    return false;
}

// a bolt from the barrel facing each of the nearest tanks, aimed where they are now
function fireBolts(t, fighters) {
    const near = [];
    for (const b of fighters) {
        if (!eligible(b, t)) continue;
        const d = Math.hypot(b.x - core.x, b.y - core.y);
        if (d <= BOLT_R) near.push({ b, d });
    }
    near.sort((a, c) => a.d - c.d);
    const cr = core.realSize || core.size || 100;
    const step = Math.PI * 2 / BARRELS;
    for (const { b } of near.slice(0, phase >= 2 ? BOLT_RAGE_TARGETS : BOLT_TARGETS)) {
        const want = Math.atan2(b.y - core.y, b.x - core.x);
        const k = Math.round((want - barrelAng) / step);
        const a = barrelAng + k * step;
        const sx = core.x + Math.cos(a) * (cr + 16), sy = core.y + Math.sin(a) * (cr + 16);
        const dx = b.x - sx, dy = b.y - sy, d = Math.hypot(dx, dy) || 1;
        let o;
        try {
            o = new Entity({ x: sx, y: sy }, core);
            o.define('royaleCoreBolt');
            o.team = core.team;
            o.source = core;
            o.noclip = true;
            o.isCoreShot = true;
            o.settings.diesAtRange = false;
            o.alwaysActive = true;
            o.refreshBodyAttributes();
            o.damage = 1;
            o.velocity.x = 0; o.velocity.y = 0;
            o.facing = Math.atan2(dy, dx);
        } catch (e) { lastErr = String(e && e.stack || e); continue; }
        bolts.push({ e: o, vx: dx / d * BOLT_SPEED, vy: dy / d * BOLT_SPEED, left: BOLT_RANGE, at: t, hp: BOLT_HP });
        stats.bolts++;
    }
}

// Hostile shots that can meet a bolt: anything a tank fired (bullets, drones,
// traps, swarms, minions), never the Core's own and never rock-only perk shots
const SHOT_TYPES = new Set(['bullet', 'drone', 'trap', 'swarm', 'satellite', 'minion']);
function shotOfTank(o) {
    if (!o || o.isCoreShot || o.rockOnly || !SHOT_TYPES.has(o.type) || o.isGhost || (o.isDead && o.isDead())) return false;
    if (core && o.team === core.team) return false;
    if (!(o.health && o.health.amount > 0)) return false;
    let root = o.master, hops = 0;
    while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
    return !!root && root !== o && (root.isPlayer || root.isBot || root.type === 'tank');
}
// the shots near a bolt's path this tick (global.grid is the engine's
// collision grid; it holds this tick's entities)
function shotsNear(x0, y0, x1, y1, pad) {
    const g = global.grid;
    if (!g || !g.query) return [];
    const out = [];
    for (const o of g.query(Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad)) {
        if (shotOfTank(o)) out.push(o);
    }
    return out;
}
// First touch (0..1 of the step) between a bolt moving a -> b and a shot
// moving q0 -> q1 over the same step, or -1. Relative motion, closest
// approach, so neither can tunnel through the other.
function sweptTouch(ax, ay, bx, by, qx0, qy0, qx1, qy1, r) {
    const rx = ax - qx0, ry = ay - qy0;
    const dx = (bx - ax) - (qx1 - qx0), dy = (by - ay) - (qy1 - qy0);
    const c = rx * rx + ry * ry - r * r;
    if (c <= 0) return 0;
    const a = dx * dx + dy * dy;
    if (!(a > 1e-9)) return -1;
    const bq = rx * dx + ry * dy;
    const disc = bq * bq - a * c;
    if (bq >= 0 || disc < 0) return -1;
    const s = (-bq - Math.sqrt(disc)) / a;
    return s <= 1 ? s : -1;
}
// A shot meets bolt `s`: the bolt loses the shot's damage, the shot is
// spent (the one that breaks it flies on with the damage it had to spare). Returns true if it broke.
function shotHitsBolt(s, o) {
    const blocker = o.type === 'trap' || o.type === 'drone' || o.type === 'satellite' || o.type === 'minion';
    const power = Math.max(0, +o.damage || 0) * (o.type === 'trap' ? BOLT_TRAP_MULT : 1);
    const before = s.hp;
    const str = before / BOLT_HP;
    s.hp -= power;
    stats.shotHits++;
    const sp = Math.hypot(s.vx, s.vy) || 1, ux = s.vx / sp, uy = s.vy / sp;
    if (blocker && o.health && o.health.max > 0) {
        // a drone or trap takes the hit like a body: worn and knocked back
        o.health.amount -= o.health.max * BOLT_BLOCK_WEAR * str;
        if (o.velocity) { o.velocity.x += ux * 4 * str; o.velocity.y += uy * 4 * str; }
        if (o.health.amount <= 0) { try { o.kill(); } catch { /* */ } }
    } else if (!(power > before)) {
        // a bullet is spent on it, as bullet meets bullet
        try { o.kill(); } catch { /* */ }
    } else {
        // the one that breaks it flies on with what it had to spare, a little slower
        o.damage = power - before;
        if (o.velocity) { o.velocity.x *= 0.85; o.velocity.y *= 0.85; }
    }
    if (s.hp <= 0) { stats.boltsShot++; return true; }
    // the bolt takes the hit where you can see it: smaller, and knocked slower
    const k = Math.min(1, power / BOLT_HP);
    s.vx *= 1 - 0.25 * k; s.vy *= 1 - 0.25 * k;
    try { s.e.SIZE = BOLT_RADIUS * (0.55 + 0.45 * s.hp / BOLT_HP); } catch { /* */ }
    return false;
}

function moveBolts(t, fighters, padList) {
    if (!bolts.length) return;
    const grid = tg();
    for (let i = bolts.length - 1; i >= 0; i--) {
        const s = bolts[i], e = s.e;
        const dt = Math.min(3, Math.max(0.2, (t - s.at) / 33.3));
        s.at = t;
        let dead = !e || e.isDead?.() || s.left <= 0;
        if (!dead) {
            const steps = Math.max(1, Math.ceil(BOLT_SPEED * dt / BOLT_RADIUS));
            const sx = s.vx * dt / steps, sy = s.vy * dt / steps;
            // players' shots in reach of this tick's path
            const shots = shotsNear(e.x, e.y, e.x + s.vx * dt, e.y + s.vy * dt, BOLT_RADIUS + 60);
            for (let k = 0; k < steps && !dead; k++) {
                const ax = e.x, ay = e.y;
                e.x += sx; e.y += sy;
                s.left -= Math.hypot(sx, sy);
                // shots first: they meet it before it reaches the tank behind them
                for (let j = 0; j < shots.length && !dead; j++) {
                    const o = shots[j];
                    if (!o || !shotOfTank(o)) { shots[j] = null; continue; }
                    const ovx = (o.velocity && o.velocity.x) || 0, ovy = (o.velocity && o.velocity.y) || 0;
                    const f0 = 1 - k / steps, f1 = 1 - (k + 1) / steps;
                    const r = BOLT_RADIUS * (0.55 + 0.45 * Math.max(0, s.hp) / BOLT_HP) + (o.realSize || o.size || 6);
                    if (sweptTouch(ax, ay, e.x, e.y, o.x - ovx * dt * f0, o.y - ovy * dt * f0, o.x - ovx * dt * f1, o.y - ovy * dt * f1, r) < 0) continue;
                    shots[j] = null;
                    if (shotHitsBolt(s, o)) dead = true;
                }
                if (dead) break;
                for (const b of fighters) {
                    if (!alive(b)) continue;
                    const r = BOLT_RADIUS + (b.realSize || b.size || 30);
                    if ((b.x - e.x) ** 2 + (b.y - e.y) ** 2 > r * r) continue;
                    // a blunted bolt lands what is left of it
                    if (projectileHit(b, BOLT_HIT * Math.max(0, s.hp) / BOLT_HP, t) > 0) stats.boltHits++;
                    dead = true;
                    break;
                }
                if (dead) break;
                if (onAnyPad(padList, e.x, e.y, BOLT_RADIUS)) { dead = true; break; }
                if (grid && grid.rockHitByCircle && (grid.rockHitByCircle(e.x, e.y, BOLT_RADIUS)
                    || (grid.growingRockHitByCircle && grid.growingRockHitByCircle(e.x, e.y, BOLT_RADIUS, t)))) { dead = true; break; }
                if (s.left <= 0) dead = true;
            }
            e.velocity.x = 0; e.velocity.y = 0; e.accel.x = 0; e.accel.y = 0;
        }
        if (dead) {
            try { if (e && !e.isDead?.()) e.kill(); } catch { /* */ }
            bolts.splice(i, 1);
        }
    }
}

function spawnDrone(t) {
    const cr = core.realSize || core.size || 100;
    const a = barrelAng + Math.random() * Math.PI * 2;
    let o;
    try {
        o = new Entity({ x: core.x + Math.cos(a) * (cr + 30), y: core.y + Math.sin(a) * (cr + 30) }, core);
        o.define('royaleCoreDrone');
        o.team = core.team;
        o.source = core;
        o.controllers = [];
        o.isCoreShot = true;
        o.settings.diesAtRange = false;
        o.alwaysActive = true;
        o.refreshBodyAttributes();
        o.health.set(DRONE_HP);
        o.health.amount = DRONE_HP;
        if (o.shield) { o.shield.max = 0; o.shield.amount = 0; }
        o.damp = 0.05;
        o.velocity.x = Math.cos(a) * DRONE_SPEED; o.velocity.y = Math.sin(a) * DRONE_SPEED;
    } catch (e) { lastErr = String(e && e.stack || e); return null; }
    drones.push({ e: o, until: t + DRONE_LIFE_MS, hits: new Map() });
    stats.drones++;
    return o;
}

function tickDrones(t, fighters, padList) {
    if (!drones.length) return;
    const padGeom = require('./padGeom.js');
    for (let i = drones.length - 1; i >= 0; i--) {
        const d = drones[i], e = d.e;
        const shot = !!e && ((e.isDead && e.isDead()) || (e.health && e.health.amount <= 0));
        let dead = !e || shot || t >= d.until
            || Math.hypot(e.x - core.x, e.y - core.y) > DRONE_LEASH + 400;
        if (shot) stats.dronesShot++;
        // a pad kills it outright, and the rim is a wall before that
        if (!dead && onAnyPad(padList, e.x, e.y, 0)) dead = true;
        if (dead) {
            try { if (e && !e.isDead?.()) e.kill(); } catch { /* */ }
            drones.splice(i, 1);
            continue;
        }
        for (const p of padList) { try { padGeom.keepOut(e, p, 6, 'core:' + (p.id != null ? p.id : p.x + ',' + p.y), true); } catch { /* */ } }
        const er = e.realSize || e.size || 16;
        let best = null, bestD = DRONE_SENSE;
        for (const b of fighters) {
            if (!eligible(b, t)) continue;
            const dd = Math.hypot(b.x - e.x, b.y - e.y);
            if (dd < bestD && Math.hypot(b.x - core.x, b.y - core.y) <= DRONE_LEASH) { best = b; bestD = dd; }
            // a touch: the share, at most every DRONE_HIT_MS per target
            if (dd <= er + (b.realSize || b.size || 30) + 6 && t - (d.hits.get(b.id) || 0) >= DRONE_HIT_MS) {
                d.hits.set(b.id, t);
                if (projectileHit(b, DRONE_HIT, t) > 0) stats.droneHits++;
            }
        }
        // chase, or circle the Core
        let gx, gy;
        if (best) { gx = best.x; gy = best.y; }
        else {
            const cr = core.realSize || core.size || 100;
            const a = Math.atan2(e.y - core.y, e.x - core.x) + 0.35;
            gx = core.x + Math.cos(a) * (cr + 140); gy = core.y + Math.sin(a) * (cr + 140);
        }
        const dx = gx - e.x, dy = gy - e.y, dl = Math.hypot(dx, dy) || 1;
        const sp = best ? DRONE_SPEED : DRONE_SPEED * 0.6;
        e.velocity.x += (dx / dl * sp - e.velocity.x) * 0.2;
        e.velocity.y += (dy / dl * sp - e.velocity.y) * 0.2;
    }
}

function attack(t, list) {
    const f = frac();
    const want = f < RAGE_BELOW ? 2 : f < SHARD_BELOW ? 1 : 0;
    // a new phase winds up first (the old shard telegraph)
    if (want > phase) {
        phase = want;
        if (hooks.fxAt) hooks.fxAt(core.x, core.y, 'corecharge', SHARD_CHARGE_MS, 0);
        nextBoltAt = Math.max(nextBoltAt, t + SHARD_CHARGE_MS);
        nextDroneAt = Math.max(nextDroneAt, t + SHARD_CHARGE_MS);
    } else if (want < phase) phase = want;
    barrelAng += BARREL_SPIN * Math.max(1, (t - (attack._at || t)) / 33.3);
    attack._at = t;
    const padList = pads();
    moveBolts(t, list, padList);
    tickDrones(t, list, padList);
    if (!phase) return;
    if (t >= nextBoltAt) { nextBoltAt = t + (phase >= 2 ? BOLT_RAGE_MS : BOLT_MS); fireBolts(t, list); }
    if (t >= nextDroneAt) {
        nextDroneAt = t + (phase >= 2 ? DRONE_RAGE_MS : DRONE_MS);
        let anyone = false;
        for (const b of list) if (eligible(b, t) && Math.hypot(b.x - core.x, b.y - core.y) <= DRONE_LEASH) { anyone = true; break; }
        if (anyone && drones.length < (phase >= 2 ? DRONE_RAGE_MAX : DRONE_MAX)) spawnDrone(t);
    }
}

function pulse(t, fighters) {
    stats.pulses++;
    if (hooks.fxAt) hooks.fxAt(core.x, core.y, 'corepulse');
    const rage = frac() < RAGE_BELOW;
    const cr = core.realSize || core.size || 100;
    for (const b of fighters) {
        if (!alive(b) || b.royaleFrozen) continue;
        const dx = b.x - core.x, dy = b.y - core.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > PULSE_R) continue;
        const k = 1 - Math.max(0, d - cr) / (PULSE_R - cr);
        const kick = PULSE_PUSH * (0.35 + 0.65 * k);
        b.velocity.x += dx / d * kick;
        b.velocity.y += dy / d * kick;
        if (frac() < SHARD_BELOW && k > 0) { hurt(b, (rage ? PULSE_RAGE_DMG : PULSE_DMG) * k, t); stats.pulseHits++; }
    }
    const grid = tg();
    if (!grid || !grid.rocks) return;
    for (const rock of grid.rocks.values()) {
        if (!rock || !(rock.alive || rock.growing)) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if ((rx - core.x) ** 2 + (ry - core.y) ** 2 > PULSE_R * PULSE_R) continue;
        const wasGrowing = rock.growing;
        let gone = false;
        try { gone = grid.damageRock(rock, rock.maxHealth * PULSE_ROCK, rx, ry, false, null); } catch { /* */ }
        if (gone && !wasGrowing && rock.ore) { try { gems.spawnOreBurst(rock, null); } catch { /* */ } }
    }
}

// Vault and shop pads are safe ground: nothing of the Core's lands on one
function onSafePad(x, y, margin = SHARD_HIT_R) {
    const padGeom = require('./padGeom.js');
    let pads = [];
    try { pads = require('./vault.js').getVaults(); } catch { /* */ }
    for (let i = 0; i < pads.length; i++) if (padGeom.insidePad(pads[i], x, y, margin)) return true;
    try { pads = require('./shop.js').getShops(); } catch { pads = []; }
    for (let i = 0; i < pads.length; i++) if (padGeom.insidePad(pads[i], x, y, margin)) return true;
    return false;
}
function fireShards(t, fighters) {
    const near = [];
    for (const b of fighters) {
        if (!alive(b) || b.royaleFrozen || (b.spawnGraceUntil || 0) > t) continue;
        const d = Math.hypot(b.x - core.x, b.y - core.y);
        if (d <= SHARD_R) near.push({ b, d });
    }
    near.sort((a, c) => a.d - c.d);
    const ticks = SHARD_FLIGHT_MS / 33;
    const rage = frac() < RAGE_BELOW;
    for (const { b } of near.slice(0, rage ? SHARD_RAGE_N : SHARD_N)) {
        // aimed where they will be, more or less: you can still juke it
        const x = b.x + (b.velocity.x || 0) * ticks * 0.7, y = b.y + (b.velocity.y || 0) * ticks * 0.7;
        if (onSafePad(x, y)) continue;
        shards.push({ x, y, at: t + SHARD_FLIGHT_MS, dmg: rage ? SHARD_RAGE_DMG : SHARD_DMG });
        if (hooks.fxAt) hooks.fxAt(x, y, 'coreshard', SHARD_FLIGHT_MS);
    }
}

function landShards(t, fighters) {
    if (!shards.length) return;
    const keep = [];
    for (const s of shards) {
        if (s.at > t) { keep.push(s); continue; }
        if (onSafePad(s.x, s.y)) continue;
        for (const b of fighters) {
            if (!alive(b)) continue;
            const r = SHARD_HIT_R + (b.realSize || 30);
            if ((b.x - s.x) ** 2 + (b.y - s.y) ** 2 <= r * r) hurt(b, s.dmg || SHARD_DMG, t);
        }
    }
    shards = keep;
}

function tick(t, fighters) {
    if (!enabled() || state === 'idle') return;
    let st;
    try { st = storm().snapshot(t); } catch { return; }
    if (state === 'planned') {
        if (!warned && st.cn > 1 && st.c === st.cn - 2 && st.hold && (st.left | 0) <= WARN_S) {
            warned = true;
            if (hooks.toast) hooks.toast("Something is waking up under the centre...", 8000);
            if (hooks.fxAt) hooks.fxAt(site.x, site.y, 'corewarn');
        }
        if (st.fin) spawnCore();
        return;
    }
    if (blast && t >= blast.at) { try { blow(t); } catch (e) { lastErr = String(e && e.stack || e); } }
    // bots leave players alone while it stands (controllers.js reads this);
    // the Crown Contest's sudden death ends the truce for good
    global.royaleCoreTruce = state === 'up' && !!core && alive(core) && !global.royaleCrownSD;
    if (state !== 'up' || !core) return;
    if (!alive(core)) { onBroken(core); return; }
    core.invuln = false;
    core._inStorm = false;
    if (core.pinX !== undefined) { core.x = core.pinX; core.y = core.pinY; core.velocity.x = 0; core.velocity.y = 0; }
    const list = fighters || [];
    landShards(t, list);
    if (!SHARD_ATTACK) attack(t, list);
    const f = frac();
    // the telegraph: CHARGE_MS (shards SHARD_CHARGE_MS) of glow and a closing ring first
    if (charge && t >= charge.at) {
        const kind = charge.kind;
        charge = null;
        if (kind === 'pulse') { nextPulseAt = t + (f < RAGE_BELOW ? PULSE_RAGE_MS : f < 0.5 ? PULSE_FAST_MS : PULSE_MS); pulse(t, list); }
        else { nextShardAt = t + (f < RAGE_BELOW ? SHARD_RAGE_MS : SHARD_MS); fireShards(t, list); }
    }
    if (!charge && t >= nextPulseAt - CHARGE_MS) startCharge('pulse', Math.max(t, nextPulseAt - CHARGE_MS) + CHARGE_MS);
    else if (SHARD_ATTACK && !charge && f < SHARD_BELOW && t >= nextShardAt) startCharge('shard', t + SHARD_CHARGE_MS);
}
function startCharge(kind, at) {
    charge = { kind, at };
    if (hooks.fxAt) hooks.fxAt(core.x, core.y, 'corecharge', Math.max(0, at - Date.now()), kind === 'pulse' ? 1 : 0);
}

function frac() {
    if (!core || !core.health || !(core.health.max > 0)) return 0;
    return Math.max(0, Math.min(1, core.health.amount / core.health.max));
}

// RY: s = soon (the warning), up, down. Positions only once it is announced.
function snapshot(t = Date.now()) {
    if (!enabled() || !site) return undefined;
    if (state === 'planned') return warned ? { s: 'soon', x: Math.round(site.x), y: Math.round(site.y) } : undefined;
    if (state === 'up' && core) {
        return { s: 'up', e: core.id, x: Math.round(core.x), y: Math.round(core.y), r: Math.round(core.realSize || core.size || 100),
            hp: Math.round(frac() * 1000) / 1000, g: coreGems, sh: frac() < RAGE_BELOW ? 2 : frac() < SHARD_BELOW ? 1 : 0,
            p: Math.max(0, nextPulseAt - t), vx: Math.round(site.vault.x), vy: Math.round(site.vault.y) };
    }
    if (state === 'down' && t - brokeAt < 60_000) return { s: 'down', x: Math.round(site.x), y: Math.round(site.y), by: brokeBy, vx: Math.round(site.vault.x), vy: Math.round(site.vault.y) };
    return undefined;
}

function current() { return core && alive(core) ? core : null; }
function siteOf() { return site; }

// ROYALE_DEBUG (DBG core): surface it now, or knock it down to `hpFrac`
function debugSpawn() {
    if (!site) { site = planSite(); state = 'planned'; }
    if (state !== 'up') { state = 'planned'; core = null; return spawnCore(); }
    return core;
}
function debugHp(f, by) {
    if (!core) return null;
    // 0: break it now, credited to `by`
    if (!(+f > 0)) {
        if (by) { core.finalKillers = [by]; hitters.set(by.id, { body: by, at: Date.now(), n: 1 }); }
        const c = core;
        try { c.kill(); } catch { /* */ }
        onBroken(c);
        return 0;
    }
    core.health.amount = Math.max(1, core.health.max * Math.min(1, +f));
    return frac();
}

module.exports = { onSafePad, projectileHit, SHARD_ATTACK, BOLT_HIT, BOLT_HP, BOLT_SPEED, BOLT_TRAP_MULT, sweptTouch, DRONE_HIT, DRONE_MAX, DRONE_RAGE_MAX, CAP_S, CAP_BURST, PULSE_RAGE_DMG,
    _brood: () => ({ bolts: bolts.map(b => b.e), boltHp: bolts.map(b => b.hp), drones: drones.map(d => d.e) }),
    _debugDrone: (x, y, t = Date.now()) => { if (!core) return null; const o = spawnDrone(t); if (o) { o.x = x; o.y = y; o.velocity.x = 0; o.velocity.y = 0; } return o; },
    ON, CORE_OFFSET, ARENA_R, LANE_R, COVER_R, ZONE_R, PULSE_R, SHARD_BELOW, RAGE_BELOW, LAST_HIT_GEMS, LAST_HIT_PTS,
    HP_MAX, CORE_BANK, MIN_SHARE, SPRAY_GEMS, splitPayout, SHARD_DMG, SHARD_RAGE_DMG, PULSE_DMG, CHARGE_MS, SHARD_CHARGE_MS, SHARD_FLIGHT_MS,
    COLLAPSE_MS, SPEW_PIECES, spew,
    attach, enabled, newRaid, clear, tick, snapshot, current, siteOf, planSite, carveArena, healthFor, gemsFor, erupt,
    debugSpawn, debugHp, _state: () => ({ state, warned, lastErr, shards: shards.length, bolts: bolts.length, drones: drones.length, phase, frac: frac(), charge: charge && charge.kind, stats: { ...stats } }),
};
