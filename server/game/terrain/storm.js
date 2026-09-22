// Raid storm: a clock, not a last-man filter. It squeezes the map so people
// collide, holds, then resets and squeezes again. Nobody wins the server.
const DAMAGE_FRAC = 0.07;
const DAMAGE_EVERY_MS = 1100;
const SHRINK_MS = 6 * 60 * 1000;
const HOLD_MS = 60 * 1000;
// raid modifiers stretch or squeeze the cycle
function shrinkMs() { return SHRINK_MS * ((global.royaleMods && global.royaleMods.stormShrinkMult) || 1); }
function holdMs() { return HOLD_MS * ((global.royaleMods && global.royaleMods.stormHoldMult) || 1); }
const MIN_FRAC = 0.20;
// Final-zone spawn lock: nobody (re)spawns in the last 45s of a cycle (the
// back end of the hold). The dead spectate. Never longer than 3/4 of the hold
// even when a raid twist stretches the cycle.
const LOCK_MS = 45 * 1000;
function lockMs() { return Math.min(LOCK_MS, holdMs() * 0.75); }

let state = {
    active: false,
    cx: 0,
    cy: 0,
    maxR: 1,
    cycle: 0,
    cycleStartAt: 0,
};

function maxRadius() {
    const tg = global.gameManager && global.gameManager.terrainGrid;
    if (tg && tg.circleRadius) return tg.circleRadius;
    const room = global.gameManager && global.gameManager.room;
    if (!room) return 2800;
    return Math.min(room.width, room.height) / 2;
}

function pickCenter(maxR) {
    const r = maxR * 0.18 * Math.random();
    const a = Math.random() * Math.PI * 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function start() {
    state.active = true;
    state.maxR = maxRadius();
    state.cycle = 0;
    state.cycleStartAt = Date.now();
    const c = pickCenter(state.maxR);
    state.cx = c.x;
    state.cy = c.y;
}

function stop() {
    state.active = false;
}

function ensureActive() {
    if (!state.active) start();
}

function cyclePhase(now = Date.now()) {
    const shrinkEnd = state.cycleStartAt + shrinkMs();
    const holdEnd = shrinkEnd + holdMs();
    if (now >= holdEnd) return "roll";
    if (now >= shrinkEnd) return "hold";
    return "shrink";
}

function maybeRoll(now = Date.now()) {
    if (!state.active) return;
    if (cyclePhase(now) !== "roll") return;
    state.cycle++;
    state.cycleStartAt = now;
    state.maxR = maxRadius();
    const c = pickCenter(state.maxR);
    state.cx = c.x;
    state.cy = c.y;
}

function radius(now = Date.now()) {
    if (!state.active) return maxRadius();
    maybeRoll(now);
    if (cyclePhase(now) === "hold") return state.maxR * MIN_FRAC;
    const t = Math.max(0, Math.min(1, (now - state.cycleStartAt) / shrinkMs()));
    return state.maxR * (1 - t * (1 - MIN_FRAC));
}

function phaseLeftSec(now = Date.now()) {
    if (!state.active) return 0;
    const ph = cyclePhase(now);
    if (ph === "shrink") return Math.max(0, Math.ceil((state.cycleStartAt + shrinkMs() - now) / 1000));
    if (ph === "hold") return Math.max(0, Math.ceil((state.cycleStartAt + shrinkMs() + holdMs() - now) / 1000));
    return 0;
}

function resetAt() {
    return state.cycleStartAt + shrinkMs() + holdMs();
}

function locked(now = Date.now()) {
    if (!state.active) return false;
    if (cyclePhase(now) === "roll") return false;
    return resetAt() - now <= lockMs();
}

function lockLeftSec(now = Date.now()) {
    if (!locked(now)) return 0;
    return Math.max(0, Math.ceil((resetAt() - now) / 1000));
}

function inStorm(x, y, now = Date.now()) {
    if (!state.active) return false;
    const r = radius(now);
    const dx = x - state.cx, dy = y - state.cy;
    return dx * dx + dy * dy > r * r;
}

function snapshot(now = Date.now()) {
    if (state.active) maybeRoll(now);
    return {
        a: state.active ? 1 : 0,
        cx: state.cx,
        cy: state.cy,
        r: state.active ? radius(now) : maxRadius(),
        max: state.maxR,
        n: state.active ? radius(now + 250) : maxRadius(),
        c: state.cycle | 0,
        hold: cyclePhase(now) === "hold" ? 1 : 0,
        left: phaseLeftSec(now),
        lock: locked(now) ? 1 : 0,
        lockLeft: lockLeftSec(now),
    };
}

function tickDamage(now = Date.now()) {
    if (!state.active) return;
    maybeRoll(now);
    for (const body of entities.values()) {
        if (!body || body.isDead?.() || body.isGhost) continue;
        if (!(body.isPlayer || body.isBot)) continue;
        if (body.royaleFrozen) continue;
        if (!inStorm(body.x, body.y, now)) {
            body._stormHurtAt = 0;
            body._inStorm = false;
            continue;
        }
        body._inStorm = true;
        // a fresh spawn keeps its shield even if the storm reached it
        if ((body.spawnGraceUntil || 0) > now) continue;
        body.invuln = false;
        if (now - (body._stormHurtAt || 0) < DAMAGE_EVERY_MS) continue;
        body._stormHurtAt = now;
        if (!body.health || !(body.health.max > 0)) continue;
        let dmgMult = 1;
        if (body.socket) { try { dmgMult = require('./shop.js').stormDamageMult(body); } catch { /* */ } }
        if (dmgMult <= 0) continue;
        const dmg = body.health.max * DAMAGE_FRAC * dmgMult * (global.royaleMods && global.royaleMods.stormDamageMult || 1);
        if (body.shield && body.shield.amount > 0) {
            const soak = Math.min(body.shield.amount, dmg);
            body.shield.amount -= soak;
            body.health.amount -= (dmg - soak);
        } else {
            body.health.amount -= dmg;
        }
        if (body.health.amount <= 0) {
            body.deathCause = "storm";
            body.dontSendDeathMessage = true;
            if (body.sendMessage) body.sendMessage("The storm closed in.");
        }
    }
}

module.exports = { start, stop, ensureActive, radius, inStorm, snapshot, tickDamage, cyclePhase, locked, lockLeftSec, shrinkMs, holdMs, DAMAGE_EVERY_MS, SHRINK_MS, HOLD_MS, LOCK_MS };
