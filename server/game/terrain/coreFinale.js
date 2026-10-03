// The Core: the raid's last fight. When the final storm cycle starts, a huge
// crystal heart surfaces beside the Center Vault and the last circle closes
// on the pair of them. It takes a whole raid's focused fire (about 1.5-2
// minutes, see healthFor), throws a shockwave every few seconds that shoves
// tanks back and cracks the rock around it, and fights back as it breaks:
// from SHARD_BELOW crystal shards at whoever is close, from RAGE_BELOW faster
// and more of them, and the shockwave hurts. Every attack is telegraphed
// (FX corecharge: the heart glows up, a ring closes on it) and the shards
// mark where they land. Breaking it: it caves in to a bright point for
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
const PULSE_DMG = 0.14;            // of max health at the rim, only below RAGE_BELOW
const CHARGE_MS = 900;             // the telegraph before a shockwave
const SHARD_CHARGE_MS = 600;       // ...and before a volley of shards
const PULSE_ROCK = 0.55;           // of a rock's max health
const SHARD_BELOW = 0.5;
const RAGE_BELOW = 0.25;
const SHARD_MS = 2200;
const SHARD_RAGE_MS = 1300;
const PULSE_RAGE_MS = 4200;
const SHARD_R = 950;
const SHARD_N = 3;
const SHARD_RAGE_N = 4;
const SHARD_FLIGHT_MS = 650;       // where it lands is marked this long first
const SHARD_HIT_R = 70;
const SHARD_DMG = 0.09;            // of max health (was 0.12)
const SHARD_RAGE_DMG = 0.12;       // (was 0.16)
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
// Halved on Oct 3: the fight dragged, so a full raid breaks it in about a minute.
const HP_BASE = 75_000, HP_HUMAN = 45_000, HP_BOT = 12_500, HP_MIN = 150_000, HP_MAX = 1_100_000;
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
let zone = null;
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

function pulse(t, fighters) {
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
        if (rage) hurt(b, PULSE_DMG * (0.5 + 0.5 * k), t);
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
        shards.push({ x, y, at: t + SHARD_FLIGHT_MS, dmg: rage ? SHARD_RAGE_DMG : SHARD_DMG });
        if (hooks.fxAt) hooks.fxAt(x, y, 'coreshard', SHARD_FLIGHT_MS);
    }
}

function landShards(t, fighters) {
    if (!shards.length) return;
    const keep = [];
    for (const s of shards) {
        if (s.at > t) { keep.push(s); continue; }
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
    // bots leave players alone while it stands (controllers.js reads this)
    global.royaleCoreTruce = state === 'up' && !!core && alive(core);
    if (state !== 'up' || !core) return;
    if (!alive(core)) { onBroken(core); return; }
    core.invuln = false;
    core._inStorm = false;
    if (core.pinX !== undefined) { core.x = core.pinX; core.y = core.pinY; core.velocity.x = 0; core.velocity.y = 0; }
    const list = fighters || [];
    landShards(t, list);
    const f = frac();
    // the telegraph: CHARGE_MS (shards SHARD_CHARGE_MS) of glow and a closing ring first
    if (charge && t >= charge.at) {
        const kind = charge.kind;
        charge = null;
        if (kind === 'pulse') { nextPulseAt = t + (f < RAGE_BELOW ? PULSE_RAGE_MS : f < 0.5 ? PULSE_FAST_MS : PULSE_MS); pulse(t, list); }
        else { nextShardAt = t + (f < RAGE_BELOW ? SHARD_RAGE_MS : SHARD_MS); fireShards(t, list); }
    }
    if (!charge && t >= nextPulseAt - CHARGE_MS) startCharge('pulse', Math.max(t, nextPulseAt - CHARGE_MS) + CHARGE_MS);
    else if (!charge && f < SHARD_BELOW && t >= nextShardAt) startCharge('shard', t + SHARD_CHARGE_MS);
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

module.exports = {
    ON, CORE_OFFSET, ARENA_R, LANE_R, COVER_R, ZONE_R, PULSE_R, SHARD_BELOW, RAGE_BELOW, LAST_HIT_GEMS, LAST_HIT_PTS,
    HP_MAX, CORE_BANK, MIN_SHARE, SPRAY_GEMS, splitPayout, SHARD_DMG, SHARD_RAGE_DMG, PULSE_DMG, CHARGE_MS, SHARD_CHARGE_MS, SHARD_FLIGHT_MS,
    COLLAPSE_MS, SPEW_PIECES, spew,
    attach, enabled, newRaid, clear, tick, snapshot, current, siteOf, planSite, carveArena, healthFor, gemsFor, erupt,
    debugSpawn, debugHp, _state: () => ({ state, warned, lastErr, shards: shards.length, frac: frac(), charge: charge && charge.kind }),
};
