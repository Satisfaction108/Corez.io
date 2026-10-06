// Sidekicks help you mine
'use strict';

const C = require('../../../shared/cosmetics.js');

const ON = process.env.ROYALE_SIDEKICK_DIG !== '0';
// 0.1 (a basic shot's dig) x 4 (a Pounder gun's dig power, mining.digPower) x 0.4
const POUNDER_REF = 0.16;
const SEARCH_MS = 400;
const FIRE_MS = 1000;        // a shot a second (sidekickMath.DIG_GAP on the client)
const SPEED = 600;           // world units a second (sidekickMath.DIG_SPEED)
const RANGE = 420;           // a rock this far from its owner's centre, at most
const FRONT = 90;            // looks for rock this far in front of its owner...
const FRONT_R = 300;         // ...within this of that spot
const KEEP_FRONT = 170;      // an owner mining elsewhere pulls it off a rock further than this from the front spot
const MINING_MS = 1500;      // the owner's shots hit rock this recently: it is mining
const MAX_FIRES = 24;        // shots across every sidekick in one tick

let firedThisTick = 0;

const tgOf = () => global.gameManager && global.gameManager.terrainGrid;
const rx = (r) => r.worldCx || r.wx;
const ry = (r) => r.worldCy || r.wy;
const live = (r) => !!r && r.alive;

function shareOf(kick) { return C.sidekickDigShare(C.byNid(kick && kick.nid)); }
// rock damage per shot, before PLAIN_ROCK_MULT
function damageFor(kick, base) { return (base || 0) * POUNDER_REF * shareOf(kick); }

function inRange(b, r) {
    const dx = rx(r) - b.x, dy = ry(r) - b.y;
    return dx * dx + dy * dy <= RANGE * RANGE;
}
// The rock in front of the owner (what it is mining), else the nearest
function findRock(tg, b) {
    const f = b.facing || 0, s = (b.size || 20) + FRONT;
    const fx = b.x + Math.cos(f) * s, fy = b.y + Math.sin(f) * s;
    let r = tg.nearestRock(fx, fy, FRONT_R);
    if (live(r) && inRange(b, r)) return r;
    r = tg.nearestRock(b.x, b.y, RANGE);
    return live(r) && inRange(b, r) ? r : null;
}
function keep(b, r, t) {
    if (!live(r) || !inRange(b, r)) return false;
    if (t - (b._rockHitAt || 0) > MINING_MS) return true;
    const f = b.facing || 0, s = (b.size || 20) + FRONT;
    const dx = rx(r) - (b.x + Math.cos(f) * s), dy = ry(r) - (b.y + Math.sin(f) * s);
    return dx * dx + dy * dy <= KEEP_FRONT * KEEP_FRONT;
}

// The first rock on the line from the owner to `to` (a shot can't pass through rock)
const LINE_STEP = 14, LINE_R = 5;
function firstOnLine(tg, b, to) {
    const x1 = rx(to), y1 = ry(to);
    const dx = x1 - b.x, dy = y1 - b.y, len = Math.hypot(dx, dy);
    if (!(len > 0) || !tg.rockHitByCircle) return to;
    const ux = dx / len, uy = dy / len;
    for (let d = (b.size || 20) + LINE_R; d < len; d += LINE_STEP) {
        const r = tg.rockHitByCircle(b.x + ux * d, b.y + uy * d, LINE_R);
        if (r && r.alive) return r;
    }
    return to;
}

// One shot lands: rock damage, gems to the owner
function land(tg, rock, raw, owner) {
    if (!tg || !rock || !(rock.alive || rock.growing) || !(raw > 0)) return false;
    const gems = require('./gems.js');
    const wasGrowing = rock.growing;
    const dmg = rock.ore ? raw : raw * gems.PLAIN_ROCK_MULT;
    const before = rock.health;
    const x = rx(rock), y = ry(rock);
    const broke = tg.damageRock(rock, dmg, x, y, false, null);
    if (owner && owner.socket && !owner.royaleLobby) {
        gems.chipHit(rock, owner, Math.min(dmg, Math.max(0, before)), x, y, wasGrowing);
        if (broke && !wasGrowing && rock.ore) gems.spawnOreBurst(rock, owner);
    }
    return broke;
}

function beginTick() { firedThisTick = 0; }

// e: a sidekicks.js row ({ body, kick, hidden })
function step(e, t) {
    if (!ON || !e || !e.body) return false;
    const b = e.body;
    const tg = tgOf();
    let d = e.dig;
    if (!d) d = e.dig = { rock: null, searchAt: t + (b.id % 8) * 50, fireAt: t + FIRE_MS / 2, hitAt: 0, hitRock: null, hitDmg: 0 };
    if (d.hitRock && t >= d.hitAt) { const r = d.hitRock; d.hitRock = null; land(tg, r, d.hitDmg, b); }
    const before = d.rock;
    if (!tg || e.hidden || b.royaleLobby || b.royaleFrozen || !(tg.baseRockHealth > 0)) {
        d.rock = null;
        return before !== null;
    }
    if (d.rock && !live(d.rock)) d.rock = null;
    if (t >= d.searchAt) {
        d.searchAt = t + SEARCH_MS;
        if (!d.rock || !keep(b, d.rock, t)) d.rock = findRock(tg, b);
    }
    if (d.rock && !d.hitRock && t >= d.fireAt && firedThisTick < MAX_FIRES) {
        firedThisTick++;
        d.fireAt = t + FIRE_MS;
        d.rock = firstOnLine(tg, b, d.rock);
        const dist = Math.hypot(rx(d.rock) - b.x, ry(d.rock) - b.y);
        d.hitRock = d.rock;
        d.hitAt = t + Math.max(0, dist - (b.size || 20)) / SPEED * 1000;
        d.hitDmg = damageFor(e.kick, tg.baseRockHealth);
    }
    return d.rock !== before;
}

// [ownerId, x, y] while it has a rock, [ownerId] when it has none
function targetOf(id, e) {
    const r = e.dig && e.dig.rock;
    return r ? [id, Math.round(rx(r)), Math.round(ry(r))] : [id];
}

module.exports = { firstOnLine, ON, POUNDER_REF, SEARCH_MS, FIRE_MS, SPEED, RANGE, MAX_FIRES, shareOf, damageFor, step, beginTick, targetOf, land };
