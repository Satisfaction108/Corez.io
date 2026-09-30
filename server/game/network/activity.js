// Player activity: what counts as a real input, and how long a socket has
// gone without one. sockets.js feeds it; the idle kick (dig_royale.js),
// ranked (rankHooks.js) and the bots' newcomer protection (controllers.js)
// read it.
//
// Real input is a change in the held keys or mouse buttons, or the aim
// moving clearly away from where it was the last time input counted. The
// aim is compared with that anchor, not with the previous packet, so a
// cursor that jitters in place (or a zoom change rescaling a still cursor)
// never adds up to activity. Toggles (autofire, autospin), stat and upgrade
// presses are not input: a tank left on autofire is idle, and so is one
// with a key held down the whole time.
//
// Socket fields: lastInputAt (last real input), _idleFrom (the idle clock's
// floor: a fresh spawn, time spent frozen in the lobby), _chatAt (a chat
// line keeps you from the kick, never earns anything), _aimX/_aimY/_inBits
// (the anchor).
'use strict';

const debugMs = (name) => {
    const v = process.env.ROYALE_DEBUG ? parseInt(process.env[name], 10) : 0;
    return v > 0 ? v : 0;
};

// no input (or chat) for this long in a raid: the tank is removed and the
// player sent to the menu. ROYALE_IDLE_KICK_MS shortens it for local tests.
const IDLE_KICK_MS = debugMs('ROYALE_IDLE_KICK_MS') || 5 * 60 * 1000;
// no input for this long: bots stop sparing the player (grace, soft window,
// newcomer difficulty, mercy) and the spawn shield drops
const IDLE_PROTECT_MS = debugMs('ROYALE_IDLE_PROTECT_MS') || 60 * 1000;
const AIM_TURN = 0.15;      // radians from the anchor
const AIM_NEAR = 30;        // closer than this to the tank the angle is noise...
const AIM_MOVE = 60;        // ...so it has to move this far instead
const AIM_STRETCH = 0.5;    // or the cursor's distance changes by half (and AIM_MOVE)

function aimMoved(socket, x, y) {
    const ax = socket._aimX, ay = socket._aimY;
    if (ax == null || ay == null) return true;
    const r0 = Math.hypot(ax, ay), r1 = Math.hypot(x, y);
    if (r0 < AIM_NEAR || r1 < AIM_NEAR) return Math.hypot(x - ax, y - ay) > AIM_MOVE;
    let turn = Math.abs(Math.atan2(y, x) - Math.atan2(ay, ax));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > AIM_TURN) return true;
    const dr = Math.abs(r1 - r0);
    return dr > AIM_MOVE && dr > r0 * AIM_STRETCH;
}

// A command packet: target (the aim, relative to the tank) and the key and
// button bits. -> true when it counted as input
function noteCommand(socket, x, y, bits, t = Date.now()) {
    if (!socket) return false;
    if (bits === socket._inBits && !aimMoved(socket, x, y)) return false;
    socket._inBits = bits;
    socket._aimX = x;
    socket._aimY = y;
    socket.lastInputAt = t;
    return true;
}

// A deliberate click that is not a command packet (spectate Prev/Next/Watch).
function noteAction(socket, t = Date.now()) {
    if (socket) socket.lastInputAt = t;
}

function noteChat(socket, t = Date.now()) {
    if (socket) socket._chatAt = t;
}

// The idle clock restarts here (a fresh spawn, a frozen lobby tick).
function resetClock(socket, t = Date.now()) {
    if (socket) socket._idleFrom = t;
}

// ms since the last real input (or the clock's floor)
function inputIdleMs(socket, t = Date.now()) {
    if (!socket) return 0;
    const at = Math.max(socket.lastInputAt || 0, socket._idleFrom || 0);
    return at ? Math.max(0, t - at) : 0;
}

// ...for the kick, where a chat line counts too
function idleMs(socket, t = Date.now()) {
    if (!socket) return 0;
    const at = Math.max(socket.lastInputAt || 0, socket._idleFrom || 0, socket._chatAt || 0);
    return at ? Math.max(0, t - at) : 0;
}

// Bots ignore every newcomer protection for this body's player.
function unprotected(root, t = Date.now()) {
    return !!(root && root.isPlayer && root.socket && inputIdleMs(root.socket, t) > IDLE_PROTECT_MS);
}

module.exports = {
    IDLE_KICK_MS, IDLE_PROTECT_MS,
    aimMoved, noteCommand, noteAction, noteChat, resetClock, inputIdleMs, idleMs, unprotected,
};
