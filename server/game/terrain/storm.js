// Shrinking safe circle. Starts at live and closes at a constant rate until
// the map is fully covered, then holds until someone wins.
// BR pacing: lobby 100s + loadout 30s + 8min storm ≈ 10.2min total,
// so the whole match is always over well within ~12 minutes.

const DAMAGE_FRAC = 0.05;
const DAMAGE_EVERY_MS = 1500;
const CLOSE_MS = 8 * 60 * 1000;

let state = {
    active: false,
    cx: 0,
    cy: 0,
    maxR: 1,
    startAt: 0,
    closeMs: CLOSE_MS,
};

function maxRadius() {
    const tg = global.gameManager && global.gameManager.terrainGrid;
    if (tg && tg.circleRadius) return tg.circleRadius;
    const room = global.gameManager && global.gameManager.room;
    if (!room) return 2800;
    return Math.min(room.width, room.height) / 2 * 0.96;
}

function start() {
    state.active = true;
    state.cx = 0;
    state.cy = 0;
    state.maxR = maxRadius();
    state.startAt = Date.now();
    state.closeMs = CLOSE_MS;
}

function stop() {
    state.active = false;
}

function radius(now = Date.now()) {
    if (!state.active) return maxRadius();
    const t = Math.max(0, Math.min(1, (now - state.startAt) / state.closeMs));
    return state.maxR * (1 - t);
}

function inStorm(x, y, now = Date.now()) {
    if (!state.active) return false;
    const r = radius(now);
    const dx = x - state.cx, dy = y - state.cy;
    return dx * dx + dy * dy > r * r;
}

function snapshot(now = Date.now()) {
    return {
        a: state.active ? 1 : 0,
        cx: state.cx,
        cy: state.cy,
        r: radius(now),
        max: state.maxR,
        n: radius(now + 250),
    };
}

function tickDamage(now = Date.now()) {
    if (!state.active) return;
    for (const body of entities.values()) {
        if (!body || body.isDead?.() || body.isGhost) continue;
        if (!(body.isPlayer || body.isBot)) continue;
        if (body.royaleFrozen || body.royaleLobby) continue;
        if (!inStorm(body.x, body.y, now)) {
            body._stormHurtAt = 0;
            continue;
        }
        if (now - (body._stormHurtAt || 0) < DAMAGE_EVERY_MS) continue;
        body._stormHurtAt = now;
        if (!body.health || !(body.health.max > 0)) continue;
        body.invuln = false;
        const dmg = body.health.max * DAMAGE_FRAC;
        body.health.amount -= dmg;
        if (body.health.amount <= 0) {
            body.deathCause = "storm";
            body.dontSendDeathMessage = true;
            if (body.sendMessage) body.sendMessage("The storm closed in.");
        }
    }
}

module.exports = { start, stop, radius, inStorm, snapshot, tickDamage, DAMAGE_EVERY_MS };
