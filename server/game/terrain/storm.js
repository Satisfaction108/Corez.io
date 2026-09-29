// Raid storm: a repeating cycle, not a last-man filter. It shrinks the zone,
// holds, then resets and shrinks again. A raid is a whole number of cycles
// (dig_royale sets it with setCycles): the last one does not reset, its hold
// keeps closing down to a small final circle and the raid ends right as it
// shuts.
const DAMAGE_FRAC = 0.07;
const DAMAGE_EVERY_MS = 1100;
const SHRINK_MS = 6 * 60 * 1000;
const HOLD_MS = 60 * 1000;
// Every cycle is this long whatever the twist, so the raid clock never
// moves. A twist trades shrink time for hold time instead.
const CYCLE_MS = SHRINK_MS + HOLD_MS;
const MIN_PHASE_MS = 45 * 1000;
function shrinkMs() {
    const m = global.royaleMods || {};
    let ms = SHRINK_MS;
    if (m.stormShrinkMult) ms = SHRINK_MS * m.stormShrinkMult;
    else if (m.stormHoldMult) ms = CYCLE_MS - HOLD_MS * m.stormHoldMult;
    return Math.round(Math.max(MIN_PHASE_MS, Math.min(CYCLE_MS - MIN_PHASE_MS, ms)));
}
function holdMs() { return CYCLE_MS - shrinkMs(); }
const MIN_FRAC = 0.20;
// the last cycle's hold closes from MIN_FRAC down to this
const FINAL_FRAC = 0.07;
// Final-zone spawn lock: nobody (re)spawns in the last 45s of a cycle (end of
// the hold); the dead spectate. Capped at 3/4 of the hold when a twist
// changes the cycle. The raid's last cycle locks for FINAL_LOCK_MS.
const LOCK_MS = 45 * 1000;
const FINAL_LOCK_MS = 30 * 1000;
// dig_royale sets the live value from its FIRST_MINUTES block (setLockMs)
let lockOverride = 0;
function setLockMs(ms) { lockOverride = Math.max(0, +ms || 0); }
function lockMs() {
    const base = isFinal() ? Math.max(FINAL_LOCK_MS, lockOverride || LOCK_MS) : (lockOverride || LOCK_MS);
    return Math.min(base, holdMs() * 0.75);
}
// cycles per raid; Infinity = the storm just keeps cycling
let cycles = Infinity;
function setCycles(n) { cycles = n > 0 ? Math.floor(n) : Infinity; }
function isFinal() { return state.cycle >= cycles - 1; }

let state = {
    active: false,
    cx: 0,
    cy: 0,
    maxR: 1,
    cycle: 0,
    cycleStartAt: 0,
    startAt: 0,
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
    state.cycleStartAt = state.startAt = Date.now();
    const c = pickCenter(state.maxR);
    state.cx = c.x;
    state.cy = c.y;
}

// ROYALE_DEBUG (DBG stormat): jump to `sec` seconds into the current cycle
function debugSeek(sec) {
    if (!state.active) start();
    state.cycleStartAt = Date.now() - Math.max(0, +sec || 0) * 1000;
}
// ROYALE_DEBUG (DBG raidleft): jump into the raid's last cycle with `sec`
// seconds to go. Returns the new end time.
function debugFinal(sec) {
    if (!state.active) start();
    const t = Date.now();
    const left = Math.max(1, +sec || 0) * 1000;
    if (cycles !== Infinity) state.cycle = cycles - 1;
    state.cycleStartAt = t + left - CYCLE_MS;
    state.startAt = state.cycleStartAt - state.cycle * CYCLE_MS;
    return endAt();
}
// When the raid's last cycle shuts (Infinity while the storm cycles forever)
function endAt() {
    if (cycles === Infinity) return Infinity;
    return state.startAt + cycles * CYCLE_MS;
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
    if (now >= holdEnd) return isFinal() ? "done" : "roll";
    if (now >= shrinkEnd) return "hold";
    return "shrink";
}

function maybeRoll(now = Date.now()) {
    if (!state.active) return;
    if (cyclePhase(now) !== "roll") return;
    // from the boundary itself, so the cycles never drift off the raid clock
    for (let i = 0; i < 1000 && cyclePhase(now) === "roll"; i++) {
        state.cycleStartAt = resetAt();
        state.cycle++;
    }
    state.maxR = maxRadius();
    const c = pickCenter(state.maxR);
    state.cx = c.x;
    state.cy = c.y;
}

// peek: a look ahead that must not roll the cycle early
function radius(now = Date.now(), peek = false) {
    if (!state.active) return maxRadius();
    if (!peek) maybeRoll(now);
    const ph = cyclePhase(now);
    if (ph === "roll") return state.maxR;
    if (ph === "done") return state.maxR * FINAL_FRAC;
    if (ph === "hold") {
        if (!isFinal()) return state.maxR * MIN_FRAC;
        const k = Math.max(0, Math.min(1, (now - state.cycleStartAt - shrinkMs()) / holdMs()));
        return state.maxR * (MIN_FRAC - (MIN_FRAC - FINAL_FRAC) * k);
    }
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
    const ph = cyclePhase(now);
    if (ph === "roll" || ph === "done") return false;
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
        n: state.active ? radius(now + 250, true) : maxRadius(),
        c: state.cycle | 0,
        cn: cycles === Infinity ? 0 : cycles,
        fin: state.active && isFinal() ? 1 : 0,
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

module.exports = { start, stop, setLockMs, setCycles, endAt, isFinal, debugSeek, debugFinal, ensureActive, radius, inStorm, snapshot, tickDamage, cyclePhase, locked, lockLeftSec, shrinkMs, holdMs, DAMAGE_EVERY_MS, SHRINK_MS, HOLD_MS, CYCLE_MS, LOCK_MS, FINAL_LOCK_MS, MIN_FRAC, FINAL_FRAC };
