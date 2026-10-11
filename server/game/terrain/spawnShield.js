'use strict';

const CAP_MS = 25000;
const UI_HOLD_MS = 3000;

function arm(body, t = Date.now()) {
    if (!body) return;
    body.shieldCapAt = t + CAP_MS;
    body.shieldUiUntil = 0;
}

function noteUi(body, t = Date.now()) {
    if (!body || !body.invuln || !body.socket) return false;
    const cap = body.shieldCapAt || 0;
    if (cap && t >= cap) return false;
    const until = t + UI_HOLD_MS;
    body.shieldUiUntil = cap ? Math.min(cap, until) : until;
    return true;
}

function uiBusy(body, t = Date.now()) {
    return !!body && (body.shieldUiUntil || 0) > t;
}

function capped(body, t = Date.now()) {
    const cap = body && body.shieldCapAt || 0;
    return !!cap && t >= cap;
}

function capLeft(body, t = Date.now()) {
    const cap = body && body.shieldCapAt || 0;
    return cap ? Math.max(0, cap - t) : 0;
}

module.exports = { CAP_MS, UI_HOLD_MS, arm, noteUi, uiBusy, capped, capLeft };
