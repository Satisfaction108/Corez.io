// Raid storm: a repeating cycle, not a last-man filter. It shrinks the zone,
// holds, then resets and shrinks again. A raid is a whole number of cycles
// (dig_royale sets it with setCycles): the last one does not reset, its hold
// keeps closing down to a small final circle and the raid ends right as it
// shuts.
const DAMAGE_FRAC = 0.07;
const DAMAGE_EVERY_MS = 1100;
// Storm damage ramps with how long you've been out in it. The first seconds
// are a warning (new players often don't know they have to move), then it
// climbs to the full DAMAGE_FRAC and past it, so sitting in the storm never
// pays. Points are [seconds outside, damage multiplier], eased in between.
const RAMP = [[0, 0.12], [5, 0.2], [18, 1], [30, 1.6]];
const RAMP_MAX = RAMP[RAMP.length - 1][1];
// back inside this long and the ramp starts over; a shorter dip holds it
const RAMP_RESET_MS = 3000;
// The raid's last hold (and after it shuts) is the showdown: the ramp runs
// this much faster, skips the warning (FINAL_RAMP_FLOOR_S) and hits harder,
// so hiding out in the storm there still kills faster than it used to.
const FINAL_RAMP_SPEED = 3;
const FINAL_RAMP_FLOOR_S = 5;
const FINAL_DAMAGE_MULT = 1.35;
// Stages: the first storm only stings, the second hurts, the last one is the
// showdown above. Indexed by cycle; later non-final cycles take full damage.
const STAGE_MULT = [0.5, 0.8];
function stageMult() {
    if (isFinal()) return 1;
    const m = STAGE_MULT[state.cycle];
    return m == null ? 1 : m;
}
function rampMult(sec) {
    if (!(sec > 0)) return RAMP[0][1];
    for (let i = 1; i < RAMP.length; i++) {
        const a = RAMP[i - 1], b = RAMP[i];
        if (sec >= b[0]) continue;
        const k = (sec - a[0]) / (b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * k * k * (3 - 2 * k);
    }
    return RAMP_MAX;
}
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
// The Crown Contest (crowns.js) keeps everyone in the last storm: no lock
// there at all. dig_royale passes a check, so a flag flip needs no restart.
let noFinalLock = null;
function setNoFinalLock(fn) { noFinalLock = typeof fn === 'function' ? fn : null; }
function lockMs() {
    if (noFinalLock && isFinal()) { try { if (noFinalLock()) return 0; } catch { /* */ } }
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

// The raid's last circle can be aimed (coreFinale.js puts it between the
// Core and the Center Vault); null = a random centre like every other cycle.
let finalCenter = null;
function setFinalCenter(x, y) {
    finalCenter = x == null || !isFinite(x) || !isFinite(y) ? null : { x: +x, y: +y };
}

function pickCenter(maxR) {
    if (finalCenter && isFinal()) return { x: finalCenter.x, y: finalCenter.y };
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
// ROYALE_DEBUG (DBG stormedge): move the zone's centre, for visual checks
function debugCenter(x, y) {
    if (!state.active) start();
    state.cx = +x || 0;
    state.cy = +y || 0;
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
    if (finalCenter && isFinal()) { state.cx = finalCenter.x; state.cy = finalCenter.y; }
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

function targetRadius(now = Date.now()) {
    const ph = cyclePhase(now);
    if (ph === "shrink") return state.maxR * MIN_FRAC;
    if (ph === "hold" && isFinal()) return state.maxR * FINAL_FRAC;
    return 0;
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
        // where this phase is closing to (0 while it holds still), for the map
        to: state.active ? targetRadius(now) : 0,
        c: state.cycle | 0,
        cn: cycles === Infinity ? 0 : cycles,
        fin: state.active && isFinal() ? 1 : 0,
        hold: cyclePhase(now) === "hold" ? 1 : 0,
        left: phaseLeftSec(now),
        lock: locked(now) ? 1 : 0,
        lockLeft: lockLeftSec(now),
    };
}

function finalSqueeze(now) {
    if (!state.active || !isFinal()) return false;
    const ph = cyclePhase(now);
    return ph === "hold" || ph === "done";
}

// How far into the ramp a body is: seconds outside (scaled in the final
// squeeze) and the damage multiplier that gives. The HUD reads this.
function exposureOf(body, now = Date.now()) {
    const sec = ((body && body._stormExpMs) || 0) / 1000;
    return { sec, mult: rampMult(sec) * stageMult() * (finalSqueeze(now) ? FINAL_DAMAGE_MULT : 1) * newcomerMult(body) };
}
// A player's first raids sting less (body.nxStormMult, newcomerDirector.js)
function newcomerMult(body) {
    const m = body && body.nxStormMult;
    return m > 0 && m < 1 ? m : 1;
}

function tickDamage(now = Date.now()) {
    if (!state.active) return;
    maybeRoll(now);
    const fin = finalSqueeze(now);
    const speed = fin ? FINAL_RAMP_SPEED : 1;
    for (const body of entities.values()) {
        if (!body || body.isDead?.() || body.isGhost) continue;
        if (!(body.isPlayer || body.isBot)) continue;
        if (body.royaleFrozen || body.adminSpec) continue;
        // real time since this body was last looked at, capped so a stall
        // never jumps the ramp
        const dt = body._stormSeenAt ? Math.max(0, Math.min(250, now - body._stormSeenAt)) : 0;
        body._stormSeenAt = now;
        if (!inStorm(body.x, body.y, now)) {
            body._inStorm = false;
            if (body._stormExpMs > 0) {
                body._stormOutMs = (body._stormOutMs || 0) + dt;
                if (body._stormOutMs >= RAMP_RESET_MS) {
                    body._stormExpMs = 0;
                    body._stormOutMs = 0;
                    body._stormHurtAt = 0;
                }
            }
            continue;
        }
        body._inStorm = true;
        body._stormOutMs = 0;
        // a fresh spawn keeps its shield even if the storm reached it
        if ((body.spawnGraceUntil || 0) > now) continue;
        body.invuln = false;
        let dmgMult = 1;
        if (body.socket) { try { dmgMult = require('./shop.js').stormDamageMult(body); } catch { /* */ } }
        // immune (Storm Anchor, medkit): no damage, and the ramp waits
        if (dmgMult <= 0) continue;
        body._stormExpMs = (body._stormExpMs || 0) + dt * speed;
        if (fin && body._stormExpMs < FINAL_RAMP_FLOOR_S * 1000) body._stormExpMs = FINAL_RAMP_FLOOR_S * 1000;
        if (now - (body._stormHurtAt || 0) < DAMAGE_EVERY_MS) continue;
        body._stormHurtAt = now;
        if (!body.health || !(body.health.max > 0)) continue;
        const ramp = rampMult(body._stormExpMs / 1000) * stageMult() * (fin ? FINAL_DAMAGE_MULT : 1);
        const dmg = body.health.max * DAMAGE_FRAC * ramp * dmgMult * newcomerMult(body) * (global.royaleMods && global.royaleMods.stormDamageMult || 1);
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

module.exports = { resetAt, start, stop, setLockMs, setNoFinalLock, setFinalCenter, setCycles, endAt, isFinal, debugSeek, debugFinal, debugCenter, ensureActive, radius, inStorm, snapshot, tickDamage, exposureOf, rampMult, cyclePhase, locked, lockLeftSec, shrinkMs, holdMs, DAMAGE_EVERY_MS, SHRINK_MS, HOLD_MS, CYCLE_MS, LOCK_MS, FINAL_LOCK_MS, MIN_FRAC, FINAL_FRAC, DAMAGE_FRAC, RAMP, RAMP_MAX, RAMP_RESET_MS, FINAL_RAMP_SPEED, FINAL_RAMP_FLOOR_S, FINAL_DAMAGE_MULT, STAGE_MULT, stageMult };
