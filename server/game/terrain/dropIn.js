// Drop-in spawns. Every spawn falls out of the sky: the client draws the
// fall (skyDrop.js) and the tank is held on its landing spot until it hits,
// FALL_MS later (a first drop of the raid falls longer than a respawn). Input
// works again from the hit. The landing smashes the plain rock
// around the tank (ore rocks stay standing, ready to shoot) and shoves anyone
// close. Your first drop of the raid blows a crater CRATER_R wide and the
// meteor's ore sticks in its rim: SEED rocks there turn into soft ore, the
// gems right where you land. Nothing is handed out: the gems come from
// shooting them, so the satchel and the score start exactly where they always
// did and no loose gems lie around a spawn.
//
// A new player who has not banked yet this raid also lands close to a vault
// (VAULT_RING away), on open ground nobody else is near, with a few soft ore
// rocks put on the way there, so the first bank can happen inside a minute.
//
// ROYALE_DROPIN=0 turns the landing off; ROYALE_FIRST_VAULT=0 the placement.
'use strict';

const gems = require('./gems.js');
const spawnReach = require('./spawnReach.js');
const padGeom = require('./padGeom.js');

const ON = process.env.ROYALE_DROPIN !== '0';
const FIRST_VAULT = process.env.ROYALE_FIRST_VAULT !== '0';
const FALL_MS = { first: 2000, respawn: 1200, bot: 1000 };
const ACTION_ON = process.env.ROYALE_ACTION_SPAWN !== '0';
const ACTION_RING = [520, 900];     // from the nearest enemy
const IMPACT_R = 200;              // a respawn, measured to the rock's outline
const CRATER_R = 310;              // the first drop of a raid
const REACH_MAX = 380;             // a landing in open ground reaches out to the nearest wall, this far at most
const PUSH_R = 320;
const PUSH = 9;
const SEED = { first: 4, newbie: 6 };   // rim rocks turned to ore on a first drop
const RIM = [CRATER_R - 40, CRATER_R + 170];
const FX_RANGE = 2800;              // others see a drop this far off (its streak crosses the screen)
const VAULT_RING = [520, 760];
const VAULT_CLEAR = 1100;          // nobody else this close to the landing (else the normal safe spawn)
const VAULT_TRIES = 16;
const ORE_ON_WAY = 4;
const ORE_SOFT = 0.35;

let hooks = {};
let queue = [];

// dig_royale.js: clients() (connected sockets), carve(tg, x, y, r, zone)
function attach(h) { hooks = h || {}; }
function enabled() { return ON && !!Config.dig_royale && !Config.tutorial; }

const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());
function tg() { return global.gameManager && global.gameManager.terrainGrid; }
function storm() { return require('./storm.js'); }

// How far the landing smashes: never less than the tank needs (a grown tank
// is a lot wider than the base radius).
function smashR(body, base) {
    const size = (body && (body.realSize || body.size)) || 30;
    return Math.round(Math.max(base, size * 1.6 + 90));
}
// Respawns favour open ground (often an old crater), and a landing with no
// plain rock inside its radius broke nothing at all. Then it reaches out to
// the nearest wall instead: up to that wall plus about one cell.
function reachR(x, y, R) {
    const grid = tg();
    const face = grid && grid.rocks && grid.constructor && grid.constructor._polyFace;
    if (!face) return R;
    let near = Infinity;
    for (const rock of grid.rocks.values()) {
        if (!rock || !rock.alive || rock.ore || rock.canyon || !rock.worldPoly) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if ((rx - x) ** 2 + (ry - y) ** 2 > (REACH_MAX + (rock.maxPolyRadius || 120)) ** 2) continue;
        const f = face(rock.worldPoly, x, y);
        const d = f.inside ? 0 : f.dist;
        if (d <= R) return R;
        if (d < near) near = d;
    }
    return near < REACH_MAX ? Math.round(Math.min(REACH_MAX, near + 100)) : R;
}

// Queue the landing for a body that has just been placed. gems: the spill
// (0 for a respawn).
// opts.big: the first drop's long fall and crater without seeding ore (a
// fresh drop after a reload)
function land(body, spill = 0, t = Date.now(), opts = null) {
    if (!enabled() || !body) return null;
    const big = spill > 0 || !!(opts && opts.big);
    const ms = big ? FALL_MS.first : FALL_MS.respawn;
    const drop = { body, x: body.x, y: body.y, at: t + ms, ms, seed: Math.max(0, spill | 0), r: 0 };
    drop.r = reachR(body.x, body.y, smashR(body, big ? CRATER_R : IMPACT_R));
    queue.push(drop);
    hold(drop);
    // your own client always hears it (its camera may still be where you
    // died), everyone else when they can see the spot
    const own = body.socket || null;
    const send = (c) => { try { c.talk('FX', Math.round(body.x), Math.round(body.y), 'dropin', body.id | 0, drop.r, ms); } catch { /* */ } };
    if (own) send(own);
    for (const c of (hooks.clients ? hooks.clients() : [])) {
        if (c === own) continue;
        const cam = c.camera;
        if (!cam || Math.abs(cam.x - body.x) > FX_RANGE || Math.abs(cam.y - body.y) > FX_RANGE) continue;
        send(c);
    }
    return drop;
}

// A bot's spawn falls in too (shorter, no crater), seen by whoever's near,
// and it is held until it lands like a player.
function landBot(body, t = Date.now()) {
    if (!enabled() || !body || body.socket) return null;
    const ms = FALL_MS.bot;
    const drop = { body, x: body.x, y: body.y, at: t + ms, ms, seed: 0, r: reachR(body.x, body.y, smashR(body, IMPACT_R)) };
    queue.push(drop);
    hold(drop);
    for (const c of (hooks.clients ? hooks.clients() : [])) {
        const cam = c.camera;
        if (!cam || Math.abs(cam.x - body.x) > FX_RANGE || Math.abs(cam.y - body.y) > FX_RANGE) continue;
        try { c.talk('FX', Math.round(body.x), Math.round(body.y), 'dropin', body.id | 0, drop.r, ms); } catch { /* */ }
    }
    return drop;
}

// how many rim rocks a landing turns to ore (0 for a respawn)
function spillFor(first, newbie) {
    if (!first) return 0;
    return newbie ? SEED.newbie : SEED.first;
}

function impact(d, t) {
    const grid = tg();
    // the tank may have moved during the flight (it can't, it is shielded and
    // most people don't move that fast): land where it is
    const b = alive(d.body) ? d.body : null;
    const x = b && Math.hypot(b.x - d.x, b.y - d.y) < 250 ? b.x : d.x;
    const y = b && Math.hypot(b.x - d.x, b.y - d.y) < 250 ? b.y : d.y;
    // the size now: sockets.js fills the levels (and the hull doubles) after
    // the landing was queued
    const R = Math.max(d.r || IMPACT_R, b ? smashR(b, 0) : 0);
    const broke = grid && grid.rocks ? smashAround(grid, x, y, R) : 0;
    if (process.env.SPAWN_DEBUG) console.log('[DROP-IN]', b ? b.name : '-', 'at', Math.round(x), Math.round(y), 'r', R, 'broke', broke);
    // a shove for anyone standing where it lands
    const near = [];
    try {
        for (const p of (global.gameManager.socketManager?.players || [])) if (p && alive(p.body)) near.push(p.body);
        for (const o of (global.gameManager.gameHandler?.bots || [])) if (alive(o)) near.push(o);
    } catch { /* */ }
    for (const o of near) {
        if (o === b) continue;
        const dx = o.x - x, dy = o.y - y, dist = Math.hypot(dx, dy) || 1;
        if (dist > PUSH_R) continue;
        const k = 1 - dist / PUSH_R;
        o.velocity.x += dx / dist * PUSH * (0.4 + 0.6 * k);
        o.velocity.y += dy / dist * PUSH * (0.4 + 0.6 * k);
    }
    if (d.seed > 0 && grid && grid.rocks) seedRim(grid, x, y, d.seed);
}

// Every rock whose outline comes within R of (x, y): the plain ones break, a
// rising one breaks whatever it will be (it has no ore to drop yet). Live
// ore stays standing for you to mine, emeralds and carved floor always.
// Checked against the outline, not the cell's centre or corners: a pocket's
// wall is a cell's flat side, and those used to be missed.
function smashAround(grid, x, y, R) {
    const face = grid.constructor && grid.constructor._polyFace;
    let n = 0;
    for (const rock of grid.rocks.values()) {
        if (!rock || !(rock.alive || rock.growing) || rock.canyon || !rock.worldPoly) continue;
        if (rock.alive && rock.ore) continue;
        if (rock.ore === 4) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if ((rx - x) ** 2 + (ry - y) ** 2 > (R + (rock.maxPolyRadius || 120)) ** 2) continue;
        if (face) { const f = face(rock.worldPoly, x, y); if (!f.inside && f.dist > R) continue; }
        else if ((rx - x) ** 2 + (ry - y) ** 2 > R * R) continue;
        try { if (grid.damageRock(rock, rock.health + 1, rx, ry, false, null)) n++; } catch { /* */ }
    }
    if (n) { try { spawnReach.invalidate(); } catch { /* */ } }
    return n;
}

function tick(t = Date.now()) {
    if (!queue.length) return;
    const keep = [];
    for (const d of queue) {
        if (d.at > t) { hold(d); keep.push(d); continue; }
        release(d);
        try { impact(d, t); } catch { /* */ }
    }
    queue = keep;
}

// Still in the air: it stays on its spot and takes no input at all. Until
// _dropHoldUntil (global.royaleInFall) the command packet is zeroed, the
// guns don't fire, and dash, abilities, kit items and upgrades are refused
// (sockets.js, loaders/global.js). Only the player's input: the raid itself
// (damage, contracts, the idle clock) goes on as normal, and the hold lifts
// on its own at the landing time even if nothing ticks.
global.royaleInFall = (b) => !!b && (b._dropHoldUntil || 0) > Date.now();
function hold(d) {
    const b = d.body;
    if (!alive(b)) return;
    b._dropHoldUntil = Math.max(b._dropHoldUntil || 0, d.at);
    b.x = d.x; b.y = d.y;
    if (b.velocity) { b.velocity.x = 0; b.velocity.y = 0; }
    if (b.accel) { b.accel.x = 0; b.accel.y = 0; }
    if (b.control) { b.control.fire = false; b.control.main = false; b.control.alt = false; b.control.goal = { x: b.x, y: b.y }; }
}
function release(d) {
    const b = d.body;
    if (b && b._dropHoldUntil <= d.at) b._dropHoldUntil = 0;
}

// A resume after a reload drops back in too, only on screen: no hold, no
// smash, nothing reset. The client draws the full fall and leaves the keys
// alone (the last field, 1, marks it as just a picture).
function visual(body) {
    if (!enabled() || !body || !body.socket) return false;
    // the full first-drop fall (zoom, haze, trail, impact), drawn only
    try { body.socket.talk('FX', Math.round(body.x), Math.round(body.y), 'dropin', body.id | 0, CRATER_R, FALL_MS.first, 1); } catch { return false; }
    return true;
}
// the body's landing is still to come (the client is drawing it in the air)
function inAir(body, t = Date.now()) { return queue.some(d => d.body === body && d.at > t); }

function reset() { for (const d of queue) release(d); queue = []; }

// ── first spawn of a new player: near a vault ──────────────────────────
function allPads() {
    const out = [];
    try { for (const v of require('./vault.js').getVaults()) out.push(v); } catch { /* */ }
    try { for (const o of require('./outposts.js').getOutposts()) out.push(o); } catch { /* */ }
    try { for (const s of require('./shop.js').getShops()) out.push(s); } catch { /* */ }
    return out.filter(Boolean);
}

// A spot VAULT_RING from a safe vault: open ground (or a dug pocket if the
// hooks can carve one), inside where the storm will be in ~40 s, off every
// pad, VAULT_CLEAR from everyone else, and escapable (spawnReach). Returns
// { x, y, vault } or null.
function vaultSpot(self, fighters, t = Date.now()) {
    if (!enabled() || !FIRST_VAULT) return null;
    const grid = tg();
    if (!grid || !grid.pointInRock) return null;
    const st = storm().snapshot(t);
    const rNow = st.r || 0;
    const rAhead = Math.max(0, rNow - Math.max(0, rNow - (st.n || rNow)) * 4 * 40);
    const safeR = rAhead - 300;
    if (!(safeR > VAULT_RING[1])) return null;
    const vaults = (require('./vault.js').getVaults() || []).filter(v => Math.hypot(v.x - st.cx, v.y - st.cy) < safeR - 160);
    if (!vaults.length) return null;
    const others = (fighters || []).filter(b => b && b !== self && alive(b));
    try { const boss = require('./bosses.js').current(); if (boss) others.push(boss); } catch { /* */ }
    const pads = allPads();
    const mapR = (grid.circleRadius || 2700) - 220;
    const zone = { x: st.cx || 0, y: st.cy || 0, r: rAhead };
    const clearOf = (x, y) => { let m = Infinity; for (const o of others) { const d = Math.hypot(o.x - x, o.y - y); if (d < m) m = d; } return m; };
    let best = null, bestRock = null;
    for (let i = 0; i < VAULT_TRIES * vaults.length; i++) {
        const v = vaults[i % vaults.length];
        const a = Math.random() * Math.PI * 2;
        const dist = VAULT_RING[0] + Math.random() * (VAULT_RING[1] - VAULT_RING[0]);
        const x = v.x + Math.cos(a) * dist, y = v.y + Math.sin(a) * dist;
        if (Math.hypot(x - st.cx, y - st.cy) > safeR || Math.hypot(x, y) > mapR) continue;
        if (pads.some(p => padGeom.insidePad(p, x, y, 160))) continue;
        const clear = clearOf(x, y);
        if (clear < VAULT_CLEAR) continue;
        const score = Math.min(clear, 1600) - Math.abs(dist - 620) * 0.5 + Math.random() * 60;
        if (grid.pointInRock(x, y)) {
            if (!bestRock || score > bestRock.score) bestRock = { x, y, vault: v, score };
            continue;
        }
        if (!spawnReach.check(grid, x, y, { zone, now: t }).ok) continue;
        if (!best || score > best.score) best = { x, y, vault: v, score };
    }
    if (!best && bestRock && hooks.carve) {
        try { if (hooks.carve(grid, bestRock.x, bestRock.y, 80, zone)) best = bestRock; } catch { /* */ }
    }
    if (!best) return null;
    seedOreOnWay(grid, best.x, best.y, best.vault);
    return { x: best.x, y: best.y, vault: best.vault };
}

// The crater rim: the n plain rocks nearest the middle of the rim band, spread
// round it, turned into soft ore (one azurite vein, the rest copper).
function seedRim(grid, x, y, n) {
    const { ORE, ORE_HP } = require('./terrainGrid.js');
    const cands = [];
    for (const rock of grid.rocks.values()) {
        if (!rock || !rock.alive || rock.growing || rock.canyon || rock.ore) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        const dd = Math.hypot(rx - x, ry - y);
        if (dd < RIM[0] || dd > RIM[1]) continue;
        cands.push({ rock, a: Math.atan2(ry - y, rx - x), dd });
    }
    cands.sort((p, q) => p.dd - q.dd);
    const picked = [];
    for (const c of cands) {
        if (picked.length >= n) break;
        // keep them spread round the rim
        if (picked.some(p => Math.abs(Math.atan2(Math.sin(p.a - c.a), Math.cos(p.a - c.a))) < (Math.PI * 2) / (n * 1.6))) continue;
        picked.push(c);
    }
    // a cramped rim: fill up with the nearest ones left
    for (const c of cands) { if (picked.length >= n) break; if (!picked.includes(c)) picked.push(c); }
    // an amethyst shard, two azurite veins, the rest copper
    picked.forEach(({ rock }, i) => {
        const copperOnly = global.royaleMods && global.royaleMods.ore === 'copper';
        rock.ore = copperOnly ? ORE.COPPER : i === 0 ? ORE.SHARD : i <= 2 ? ORE.VEIN : ORE.COPPER;
        try { rock.deposits = grid._buildDeposits(rock); } catch { rock.deposits = null; }
        rock.maxHealth = Math.max(10, grid.plainRockHealth * (ORE_HP[rock.ore] || 1) * ORE_SOFT);
        rock.soft = true;   // the old flat gem pay, whatever the biome
        rock.health = rock.maxHealth;
        grid.rockEvents.push({ k: rock.k, h: 1, d: 0, ore: rock.ore, bl: 1 });
    });
    return picked.length;
}

// A spawn near the action: ACTION_RING from a fight (or a vault, or rich
// ore), never closer than ACTION_RING[0] to any enemy, open ground inside
// the zone, escapable. null = the normal safe spawn.
function actionSpot(self, fighters, t = Date.now()) {
    if (!enabled() || !ACTION_ON) return null;
    const grid = tg();
    if (!grid || !grid.pointInRock) return null;
    const st = storm().snapshot(t);
    const rAhead = Math.max(0, (st.r || 0) - Math.max(0, (st.r || 0) - (st.n || st.r || 0)) * 4 * 25);
    const safeR = rAhead - 380;
    if (!(safeR > 600)) return null;
    const others = (fighters || []).filter(b => b && b !== self && alive(b) && !(self && self.team != null && b.team === self.team));
    // never into a raid boss's lap either (it isn't in the fighter list)
    try { const boss = require('./bosses.js').current(); if (boss && alive(boss)) others.push(boss); } catch { /* */ }
    const pads = allPads();
    const mapR = (grid.circleRadius || 2700) - 240;
    const zone = { x: st.cx || 0, y: st.cy || 0, r: rAhead };
    // where things happen: fights first, then vaults, then rich ore
    const hot = [];
    for (const b of others) if (t - Math.max(b._lastDamageAt || 0, b.hitAt || 0) < 6000) hot.push({ x: b.x, y: b.y, w: 3 });
    try { for (const v of require('./vault.js').getVaults()) hot.push({ x: v.x, y: v.y, w: 1.5 }); } catch { /* */ }
    if (grid.rocks) {
        let n = 0;
        for (const r of grid.rocks.values()) {
            if (n >= 40) break;
            if (r && r.alive && (r.ore === 3 || r.ore === 4)) { hot.push({ x: r.worldCx || r.wx, y: r.worldCy || r.wy, w: 1 }); n++; }
        }
    }
    if (!hot.length) return null;
    const clearOf = (x, y) => { let m = Infinity; for (const o of others) { const d = Math.hypot(o.x - x, o.y - y); if (d < m) m = d; } return m; };
    let best = null;
    for (let i = 0; i < 40; i++) {
        const h = hot[(Math.random() * hot.length) | 0];
        const a = Math.random() * Math.PI * 2, dd = ACTION_RING[0] + Math.random() * (ACTION_RING[1] - ACTION_RING[0]);
        const x = h.x + Math.cos(a) * dd, y = h.y + Math.sin(a) * dd;
        if (Math.hypot(x - zone.x, y - zone.y) > safeR || Math.hypot(x, y) > mapR) continue;
        if (pads.some(p => padGeom.insidePad(p, x, y, 160))) continue;
        const clear = clearOf(x, y);
        if (clear < ACTION_RING[0]) continue;
        if (grid.pointInRock(x, y)) continue;
        const score = h.w * 400 - Math.abs(clear - 700) + Math.random() * 80;
        if (best && score <= best.score) continue;
        if (!spawnReach.check(grid, x, y, { zone, now: t }).ok) continue;
        best = { x, y, score };
    }
    return best ? { x: best.x, y: best.y } : null;
}

// A few soft ore rocks along the way from the landing to the vault.
function seedOreOnWay(grid, x, y, v) {
    const { ORE, ORE_HP } = require('./terrainGrid.js');
    const ex = v.x - x, ey = v.y - y, l2 = ex * ex + ey * ey || 1;
    const picks = [];
    for (const rock of grid.rocks.values()) {
        if (!rock || !rock.alive || rock.growing || rock.canyon || rock.ore === ORE.EMERALD) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        const k = ((rx - x) * ex + (ry - y) * ey) / l2;
        if (k < 0.12 || k > 0.8) continue;
        const off = Math.hypot(rx - (x + k * ex), ry - (y + k * ey));
        if (off > 130) continue;
        picks.push({ rock, k, off });
    }
    picks.sort((a, b) => a.off - b.off);
    let n = 0;
    for (const { rock } of picks) {
        if (n >= ORE_ON_WAY) break;
        const ore = n === 0 ? ORE.VEIN : ORE.COPPER;
        if (!rock.ore || rock.ore < ore) {
            rock.ore = ore;
            try { rock.deposits = grid._buildDeposits(rock); } catch { rock.deposits = null; }
        }
        rock.maxHealth = Math.max(10, grid.plainRockHealth * (ORE_HP[rock.ore] || 1) * ORE_SOFT);
        rock.soft = true;   // the old flat gem pay, whatever the biome
        rock.health = rock.maxHealth;
        grid.rockEvents.push({ k: rock.k, h: 1, d: 0, ore: rock.ore, bl: 1 });
        n++;
    }
    return n;
}

module.exports = { smashAround, smashR, ON, FIRST_VAULT, ACTION_ON, ACTION_RING, FALL_MS, IMPACT_R, inAir, visual, landBot, actionSpot, CRATER_R, SEED, VAULT_RING, attach, enabled, land, spillFor, tick, reset, vaultSpot, seedOreOnWay, seedRim };
