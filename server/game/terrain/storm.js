// Raid storm: a clock, not a last-man filter. It squeezes the map so people
// collide, holds, then resets and squeezes again. Nobody wins the server.
const DAMAGE_FRAC = 0.07;
const DAMAGE_EVERY_MS = 1100;
const SHRINK_MS = 4 * 60 * 1000;
const HOLD_MS = 30 * 1000;
const MIN_FRAC = 0.12;

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
    const shrinkEnd = state.cycleStartAt + SHRINK_MS;
    const holdEnd = shrinkEnd + HOLD_MS;
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
    const t = Math.max(0, Math.min(1, (now - state.cycleStartAt) / SHRINK_MS));
    return state.maxR * (1 - t * (1 - MIN_FRAC));
}

function phaseLeftSec(now = Date.now()) {
    if (!state.active) return 0;
    const ph = cyclePhase(now);
    if (ph === "shrink") return Math.max(0, Math.ceil((state.cycleStartAt + SHRINK_MS - now) / 1000));
    if (ph === "hold") return Math.max(0, Math.ceil((state.cycleStartAt + SHRINK_MS + HOLD_MS - now) / 1000));
    return 0;
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
        body.invuln = false;
        if (now - (body._stormHurtAt || 0) < DAMAGE_EVERY_MS) continue;
        body._stormHurtAt = now;
        if (!body.health || !(body.health.max > 0)) continue;
        const dmg = body.health.max * DAMAGE_FRAC;
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

module.exports = { start, stop, ensureActive, radius, inStorm, snapshot, tickDamage, cyclePhase, DAMAGE_EVERY_MS, SHRINK_MS, HOLD_MS };
