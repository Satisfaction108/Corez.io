// Supply drops, the way battle royales do them: FIRST_MS into a raid and then
// every GAP_MS a crate falls out of the sky near the players (never on top of
// anyone). WARN_MS ahead it is announced with a ping, a minimap icon with a
// countdown and a beam of light on the spot, so people converge and fight
// over it. It falls in like a spawn (the client's sky drop, FALL_MS), smashes
// the rock where it lands, and is an epic chest from then on. Breaking it
// pays a kit item and CRATE_GEMS gems like any epic chest, plus a new ability
// for the raid (abilities.grant; a bot gets one with giveBot).
//
// Bots go for it on their own: it's a chest (chests.js), and their chest goal
// takes it. current() is there for anything else that wants to know.
//
// ROYALE_SUPPLY=0 turns it off (pacing.js then drops its own, as before).
'use strict';

const padGeom = require('./padGeom.js');

const ON = process.env.ROYALE_SUPPLY !== '0';
const FIRST_MS = 45_000;
const GAP_MS = [60_000, 75_000];
const WARN_MS = 10_000;
const FALL_MS = 1500;
const CRATE_GEMS = 1050;
const NEAR = [450, 800];          // from the player it is dropped by
const CLEAR = 320;                // from every tank
const SMASH_R = 170;
// an epic chest is SIZE 40; the crate is 1.8x that. FOOT_R is the ground it
// needs (chests.js holds the same radius against regrowth while it stands)
const CRATE_SIZE = 72;
const FOOT_R = Math.round(CRATE_SIZE * 1.45);
const FX_RANGE = 2600;
// nobody stands where it lands: from the warning on, a tank inside the
// footprint (plus CLEAR_MARGIN) rolls out at CLEAR_SPEED u/tick (no damage, no
// teleport, like a pad's expel); still inside at the hit, it's put on the rim
const RETRY_MS = 3000;            // no spot this time: look again this soon
const CLEAR_MARGIN = 40;
const CLEAR_SPEED = 7;
const WARN_EVERY_MS = 3000;

let hooks = {};
let plan = null;                  // { x, y, at, falling, where }
let crate = null;
let nextAt = 0;
let count = 0;

// dig_royale.js: humans(), fighters(), clients(), idle(sock), live(),
// raidAge(t), announce(text, feed), callout(body, kind, text, pts, sub, dur),
// compass(x, y)
function attach(h) { hooks = h || {}; }
function enabled() { return ON && !!Config.dig_royale && !Config.tutorial; }
const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());
function storm() { return require('./storm.js'); }
function tg() { return global.gameManager && global.gameManager.terrainGrid; }

function allPads() {
    const out = [];
    try { for (const v of require('./vault.js').getVaults()) out.push(v); } catch { /* */ }
    try { for (const o of require('./outposts.js').getOutposts()) out.push(o); } catch { /* */ }
    try { for (const s of require('./shop.js').getShops()) out.push(s); } catch { /* */ }
    return out.filter(Boolean);
}

// A spot NEAR from one of the players (the one with the most company, so it
// lands where a fight can happen), clear of everyone, inside the zone. When
// that finds nothing the rules relax step by step: a wider ring, less room
// round other tanks and the drop pits, then anywhere in the zone. Rock never
// counts against a spot (the landing clears its footprint); only emeralds,
// pads, the map edge and the storm are hard no's.
const STAGES = [
    { ring: NEAR, clear: CLEAR, pit: 330, edge: 320 },
    { ring: [350, 1100], clear: 220, pit: 200, edge: 220 },
    { ring: [250, 1500], clear: 140, pit: 0, edge: 140 },
    { ring: null, clear: 140, pit: 0, edge: 120 },
];
const TRIES = 36;
// never on top of each other: this far from any other supply crate (down or
// on its way), and clear of every chest's footprint
const CRATE_GAP = 900;
const CHEST_GAP = FOOT_R + 150;
function others() {
    const out = [];
    if (crate && alive(crate) && !crate._opened) out.push({ x: crate.x, y: crate.y, gap: CRATE_GAP });
    if (plan) out.push({ x: plan.x, y: plan.y, gap: CRATE_GAP });
    try {
        for (const c of require('./chests.js').alive()) {
            if (!c || c._opened || c === crate) continue;
            out.push({ x: c.x, y: c.y, gap: c.supplyDrop ? CRATE_GAP : CHEST_GAP });
        }
    } catch { /* */ }
    return out;
}
function pickSpot(t) {
    const people = (hooks.humans ? hooks.humans() : []).filter(b => alive(b) && !(hooks.idle && b.socket && hooks.idle(b.socket)));
    if (!people.length) return null;
    const fighters = (hooks.fighters ? hooks.fighters() : []).filter(alive);
    const crowd = (b) => fighters.filter(o => o !== b && Math.hypot(o.x - b.x, o.y - b.y) < 1400).length;
    people.sort((a, b) => crowd(b) - crowd(a) || Math.random() - 0.5);
    const st = storm().snapshot(t);
    const grid = tg();
    const mapR = ((grid && grid.circleRadius) || 2700) - 260;
    const pads = allPads();
    const zoneR = st && st.a ? (st.r || 0) : Infinity;
    const taken = others();
    const ok = (x, y, g) => {
        for (const o of taken) if ((o.x - x) ** 2 + (o.y - y) ** 2 < o.gap * o.gap) return false;
        if (Math.hypot(x, y) > mapR) return false;
        if (st && st.a && Math.hypot(x - st.cx, y - st.cy) > zoneR - g.edge) return false;
        if (pads.some(p => padGeom.insidePad(p, x, y, 260))) return false;
        if (fighters.some(o => Math.hypot(o.x - x, o.y - y) < g.clear)) return false;
        // chests keep off the drop pits (a fresh spawn lands there)
        if (g.pit && grid && grid.spawnPits && grid.spawnPits.some(q => Math.hypot(q.x - x, q.y - y) < g.pit)) return false;
        // the landing smashes what's under it, but never an emerald
        return !(grid && emeraldUnder(grid, x, y));
    };
    for (const g of STAGES) {
        if (!g.ring) {
            // anywhere in the zone (or on the map when there's no storm)
            const cx = st && st.a ? st.cx || 0 : 0, cy = st && st.a ? st.cy || 0 : 0;
            const R = Math.max(0, Math.min(mapR, zoneR - g.edge));
            for (let i = 0; i < TRIES * 3; i++) {
                const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * R;
                const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
                if (ok(x, y, g)) return { x, y };
            }
            continue;
        }
        for (const who of people.slice(0, 3)) {
            for (let i = 0; i < TRIES; i++) {
                const a = Math.random() * Math.PI * 2, d = g.ring[0] + Math.random() * (g.ring[1] - g.ring[0]);
                const x = who.x + Math.cos(a) * d, y = who.y + Math.sin(a) * d;
                if (ok(x, y, g)) return { x, y };
            }
        }
    }
    return null;
}

// how far (x, y) is from a rock's outline (0 inside it)
function rockDist(grid, rock, x, y) {
    const f = grid.constructor._polyFace(rock.worldPoly, x, y);
    return f.inside ? 0 : f.dist;
}
function emeraldUnder(grid, x, y) {
    if (!grid.rocks || !grid.constructor._polyFace) return false;
    for (const rock of grid.rocks.values()) {
        if (!rock || rock.ore !== 4 || !rock.alive || !rock.worldPoly) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if ((rx - x) ** 2 + (ry - y) ** 2 > (FOOT_R + (rock.maxPolyRadius || 120)) ** 2) continue;
        if (rockDist(grid, rock, x, y) <= FOOT_R) return true;
    }
    return false;
}

function talkAll(fn) {
    for (const c of (hooks.clients ? hooks.clients() : [])) { try { fn(c); } catch { /* */ } }
}

function warn(t) {
    const spot = pickSpot(t);
    // nothing anywhere (everyone idle, or a tiny last circle): try again soon, never skip it
    if (!spot) { nextAt = t + RETRY_MS; return; }
    const where = hooks.compass ? hooks.compass(spot.x, spot.y) : "the zone";
    plan = { x: Math.round(spot.x), y: Math.round(spot.y), at: t + WARN_MS, falling: false, where };
    if (hooks.announce) hooks.announce("Supply drop incoming in " + where + ". A new ability inside.", { event: 1, kind: 'supply', name: where });
    talkAll(c => c.talk('FX', plan.x, plan.y, 'supplysoon', WARN_MS, CRATE_SIZE));
}

// Clear room where it lands: under the crate everything but an emerald goes
// (ore pays out like a dig), round it plain rock only, the ore stays.
function smash(x, y) {
    const grid = tg();
    if (!grid || !grid.rocks || !grid.constructor._polyFace) return;
    const gems = require('./gems.js');
    for (const rock of grid.rocks.values()) {
        if (!rock || !(rock.alive || rock.growing) || rock.canyon || !rock.worldPoly) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if ((rx - x) ** 2 + (ry - y) ** 2 > (SMASH_R + (rock.maxPolyRadius || 120)) ** 2) continue;
        const d = rockDist(grid, rock, x, y);
        if (d > (d <= FOOT_R ? FOOT_R : SMASH_R)) continue;
        if (d > FOOT_R && rock.ore) continue;
        if (rock.ore === 4 && rock.alive) continue;
        const ore = rock.alive ? rock.ore : 0;
        let gone = false;
        try { gone = grid.damageRock(rock, rock.health + 1, rx, ry, false, null); } catch { /* */ }
        if (gone && ore) { try { gems.spawnOreBurst(rock, null); } catch { /* */ } }
    }
    try { require('./spawnReach.js').invalidate(); } catch { /* */ }
}

// what's in it on top of the chest's own kit item and gems
function reward(body) {
    const abilities = require('./abilities.js');
    if (!abilities.ON || !alive(body)) return "";
    const pool = abilities.ABILITIES.filter(a => {
        if (body.socket) { const st = abilities.stateOf(body.socket); return !(st.own || []).includes(a.id); }
        return true;
    });
    if (!pool.length) return "";
    const pick = pool[(Math.random() * pool.length) | 0];
    if (body.socket) {
        // owned for the raid; it only takes the slot if the slot is empty
        if (abilities.addFound) abilities.addFound(body.socket, pick.id);
        else abilities.grant(body.socket, pick.id);
    } else abilities.giveBot(body, pick.id);
    return pick.name + " unlocked";
}

// tanks (players and bots) over the landing spot
function onSpot(p, extra) {
    const out = [];
    for (const b of (hooks.fighters ? hooks.fighters() : [])) {
        if (!alive(b)) continue;
        const r = FOOT_R + (b.realSize || 30) + extra;
        if ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 < r * r) out.push(b);
    }
    return out;
}
function awayFrom(p, b) {
    const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy);
    if (d > 1e-3) return { nx: dx / d, ny: dy / d, d };
    const a = Math.random() * Math.PI * 2;
    return { nx: Math.cos(a), ny: Math.sin(a), d: 0 };
}
// every tick of the warning and the fall
function clearSpot(p, t) {
    for (const b of onSpot(p, CLEAR_MARGIN)) {
        const { nx, ny } = awayFrom(p, b);
        if (!b.velocity) continue;
        const vOut = b.velocity.x * nx + b.velocity.y * ny;
        if (vOut < CLEAR_SPEED) { b.velocity.x += (CLEAR_SPEED - vOut) * nx; b.velocity.y += (CLEAR_SPEED - vOut) * ny; }
        if (b.accel) {
            const aIn = b.accel.x * nx + b.accel.y * ny;
            if (aIn < 0) { b.accel.x -= aIn * nx; b.accel.y -= aIn * ny; }
        }
        if (b.socket && b.sendMessage && t - (b._supplyWarnAt || 0) > WARN_EVERY_MS) {
            b._supplyWarnAt = t;
            try { b.sendMessage("Move! Supply drop incoming."); } catch { /* */ }
        }
    }
}
// the hit: anyone still under it goes to the rim, never inside the crate
function shoveOff(p) {
    const grid = tg();
    for (const b of onSpot(p, 4)) {
        const away = awayFrom(p, b);
        const rs = b.realSize || 30, rim = CRATE_SIZE + rs + 8;
        // straight out if that's open ground, else the nearest open way round
        let nx = away.nx, ny = away.ny;
        const base = Math.atan2(ny, nx);
        for (let i = 0; i < 12; i++) {
            const a = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 6);
            const cx = Math.cos(a), cy = Math.sin(a);
            if (grid && grid.rockHitByCircle && grid.rockHitByCircle(p.x + cx * rim, p.y + cy * rim, rs)) continue;
            nx = cx; ny = cy;
            break;
        }
        b.x = p.x + nx * rim; b.y = p.y + ny * rim;
        if (b.velocity) { b.velocity.x = nx * CLEAR_SPEED * 1.4; b.velocity.y = ny * CLEAR_SPEED * 1.4; }
    }
}

function land(t) {
    const p = plan;
    plan = null;
    smash(p.x, p.y);
    shoveOff(p);
    let o = null;
    try {
        // exactly on the marker everyone watched, on the ground it just smashed
        o = require('./chests.js').spawnChest(p.x, p.y, true, { gems: CRATE_GEMS, item: require('./shop.js').randomKitId(), exact: true, size: CRATE_SIZE });
    } catch { o = null; }
    if (o) {
        o.supplyDrop = true;
        o.isSupplyCrate = true;
        o.onOpened = (body) => reward(body);
        crate = o;
        count++;
    }
    nextAt = t + GAP_MS[0] + Math.random() * (GAP_MS[1] - GAP_MS[0]);
}

function tick(t) {
    if (!enabled() || (hooks.live && !hooks.live())) return;
    if (crate && (!alive(crate) || crate._opened)) crate = null;
    const age = hooks.raidAge ? hooks.raidAge(t) : 0;
    if (!plan) {
        if (!nextAt) nextAt = t + Math.max(0, FIRST_MS - age - WARN_MS);
        if (t >= nextAt && !storm().locked(t)) warn(t);
        return;
    }
    clearSpot(plan, t);
    if (!plan.falling && t >= plan.at - FALL_MS) {
        plan.falling = true;
        talkAll(c => {
            const cam = c.camera;
            if (cam && (Math.abs(cam.x - plan.x) > FX_RANGE || Math.abs(cam.y - plan.y) > FX_RANGE)) return;
            c.talk('FX', plan.x, plan.y, 'supplyfall', FALL_MS, CRATE_SIZE);
        });
    }
    if (t >= plan.at) land(t);
}

// RY: s soon (with ms left) or down (the crate's entity id)
function snapshot(t = Date.now()) {
    if (!enabled()) return undefined;
    if (plan) return { s: 'soon', x: plan.x, y: plan.y, z: CRATE_SIZE, left: Math.max(0, plan.at - t) };
    if (crate && alive(crate) && !crate._opened) return { s: 'down', x: Math.round(crate.x), y: Math.round(crate.y), e: crate.id };
    return undefined;
}
// for the bot brain and anything else: where the drop is and what it's doing
function current(t = Date.now()) {
    if (plan) return { state: 'soon', x: plan.x, y: plan.y, at: plan.at, entity: null };
    if (crate && alive(crate) && !crate._opened) return { state: 'down', x: crate.x, y: crate.y, at: 0, entity: crate };
    return null;
}

function reset() { plan = null; crate = null; nextAt = 0; count = 0; }

// ROYALE_DEBUG (DBG supplydrop): the next one now
function debugNow(t = Date.now()) { if (!plan) { nextAt = 0; warn(t); } return plan; }

module.exports = { CRATE_GAP, CHEST_GAP, CLEAR_MARGIN, CRATE_SIZE, FOOT_R, ON, FIRST_MS, GAP_MS, WARN_MS, FALL_MS, CRATE_GEMS, attach, enabled, tick, snapshot, current, reset, debugNow, pickSpot, _count: () => count };
