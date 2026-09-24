// Accounts <-> game glue, running in whichever thread hosts the Dig Royale
// game (the main thread in production, a worker in local dev).
//
// sockets.js calls:
//   bridge.onConnect(socket, req, manager)  as a socket is welcomed
//   bridge.resolveName(socket, name)        in the 's' spawn packet
//   bridge.applyIdentity(socket, body)      when the body is created
//   bridge.onClose(socket)                  after the socket is gone
// dig_royale.js reads socket.account for the account-keyed resume.
//
// Only the royale game has accounts: the tutorial worker never loads this
// file's database side (bridge.active() is false there) and plays exactly
// as before.
'use strict';

const accounts = require('../index');

let manager = null;
let unsub = null;

function active() {
    return !!(Config.dig_royale && !Config.tutorial && accounts.enabled());
}

function init(socketManager) {
    manager = socketManager;
    if (unsub) return;
    unsub = accounts.bus.onGame(msg => {
        if (!msg || msg.t !== 'kick' || !manager) return;
        for (const s of manager.clients.slice()) {
            if (s.account && s.account.id === msg.userId) kickOut(s, msg.reason || 'You were signed out.');
        }
    });
}

// KO first so the client stops its auto-reconnect, then the resume snapshot
// (the account key lets the other tab pick the raid up), then the socket.
function kickOut(socket, reason) {
    try { socket.talk('KO', String(reason)); } catch (e) { /* closing anyway */ }
    if (Config.dig_royale && !socket._drCleaned) {
        socket._drCleaned = true;
        try {
            require('../../game/gamemodes/scripts/dig_royale.js').disconnectCleanup(socket, (socket.player && socket.player.body) || null);
        } catch (e) { /* the close handler still removes the body */ }
    }
    try { socket.terminate(); } catch (e) { /* already gone */ }
}

function onConnect(socket, req, socketManager) {
    if (!manager) init(socketManager);
    socket.account = null;
    if (!active()) return;
    // A cross-site page can open a websocket to us with the player's cookie
    // attached; only trust the cookie from our own origin.
    const origin = req && req.headers && req.headers.origin;
    if (!origin || !accounts.config.isAllowedOrigin(origin)) return;
    let found = null;
    try { found = accounts.sessions.fromCookieHeader(req.headers.cookie || ''); } catch (e) {
        console.error('[accounts] session lookup failed: ' + ((e && e.stack) || e));
    }
    if (!found || !found.user) return;
    const user = found.user;
    if (accounts.users.isBanned(user)) {
        const until = user.banned_until && user.banned_until < 8e15 ? ' until ' + new Date(user.banned_until).toUTCString() : '';
        try { socket.talk('KO', 'This account is banned' + until + (user.ban_reason ? ': ' + user.ban_reason : '.')); } catch (e) { /* */ }
        try { socket.terminate(); } catch (e) { /* */ }
        return;
    }
    socket.account = { id: user.id, publicId: user.public_id, username: user.username };

    // Newest session wins. No loop to guard against: KO turns off the kicked
    // tab's auto-reconnect. (Limiting supersedes locked out players whose
    // flaky wifi left half-open sockets behind on every reconnect.)
    for (const o of socketManager.clients.slice()) {
        if (o !== socket && o.account && o.account.id === user.id) kickOut(o, 'You logged in somewhere else.');
    }
}

// Accounts always play under their username. Guests keep a cleaned version
// of what they typed, marked when it would pass for someone's account.
function resolveName(socket, name) {
    if (socket.account) {
        try {
            const row = accounts.users.byId(socket.account.id);
            if (row && !row.deleted_at) socket.account.username = row.username;
        } catch (e) { /* keep the cached name */ }
        return socket.account.username;
    }
    let clean = String(name == null ? '' : name);
    try { clean = accounts.names.sanitizeGuestName(clean); } catch (e) { /* fall back to what sockets.js cleaned */ }
    if (clean && active()) {
        try { if (accounts.users.isRegisteredName(clean)) clean = '~' + clean.slice(0, 23); } catch (e) { /* */ }
    }
    return clean;
}

function applyIdentity(socket, body) {
    if (!body) return;
    body.accountId = socket.account ? socket.account.id : 0;
}

function onClose(socket) {
    // Phase 1 keeps nothing per socket beyond socket.account.
}

module.exports = { init, active, onConnect, resolveName, applyIdentity, onClose, kickOut };
