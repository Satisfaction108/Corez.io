"use strict";
// Dead-link timing for sockets.js checkLinks.
//
// Every socket gets a websocket ping every PING_EVERY_MS and the browser's
// network stack answers it, so a background tab (timers throttled, no
// animation frames) keeps its link: it never goes quiet. A frozen page does
// go quiet: Chrome's energy saver, Edge's sleeping tabs, a suspended laptop
// or phone stop the page, its socket stops reading and the pongs stop with
// it. Chrome also closes a frozen page's socket when it wakes, so there the
// drop is the right call (the tank leaves the world and the raid is held for
// the resume). The client says when its tab goes hidden, frozen or back
// ('VZ'); a hidden tab that goes quiet without freezing (a browser that
// stalls background pages) gets HIDDEN_DEAD_MS before the link is dropped,
// a frozen one the normal time. The 5 minute idle kick applies either way.
const PING_EVERY_MS = 3000;
const debugMs = (k) => (process.env.ROYALE_DEBUG && parseInt(process.env[k], 10) > 0) ? parseInt(process.env[k], 10) : 0;
const DEAD_AFTER_MS = debugMs("DEAD_LINK_MS") || 12000;
const HIDDEN_DEAD_MS = debugMs("HIDDEN_DEAD_LINK_MS") || 30000;

// How long this socket may stay silent before it counts as dead.
function deadAfter(socket) {
    return socket && socket._tabHiddenAt ? Math.max(DEAD_AFTER_MS, HIDDEN_DEAD_MS) : DEAD_AFTER_MS;
}
function isDead(socket, t) {
    const seen = socket._seenAt || t;
    return t - seen > deadAfter(socket);
}
// 'VZ' [state]: 0 visible, 1 hidden, 2 frozen (about to be).
function noteVisibility(socket, state, t) {
    if (state === 1) { if (!socket._tabHiddenAt) socket._tabHiddenAt = t; }
    else socket._tabHiddenAt = 0;
}

module.exports = { PING_EVERY_MS, DEAD_AFTER_MS, HIDDEN_DEAD_MS, deadAfter, isDead, noteVisibility };
