// Accounts <-> game glue, in whichever thread hosts the Dig Royale game
// (main thread in production, a worker in local dev).
//
// sockets.js calls:
//   bridge.onConnect(socket, req, manager)  as a socket is welcomed
//   bridge.onGuestId(socket)                the 'GI' packet (guest tracking)
//   bridge.resolveName(socket, name)        in the 's' spawn packet
//   bridge.applyIdentity(socket, body)      when the body is created (sends AC + DU)
//   bridge.afterDeathPacket(socket)         right after 'F' (sends the stored RK)
//   bridge.onClose(socket)                  after the socket is gone
// dig_royale.js reads socket.account for the account-keyed resume.
//
// Packets (server -> client), JSON as one string unless noted:
//   AC  {username, userId, rank: RankSnap, dust, dustCarried}   at spawn, accounts
//   DU  carriedMilli, balanceMilli, deltaMilli, kind            numbers; kind 0 sync,
//       1 pickup, 2 bank, 3 kill, 4 death loss, 5 placement, 6 quest,
//       7 chest / boss / shop reward, 8 streak. At most
//       4/s per socket (du() coalesces), except forced ones (bank, death).
//   RK  the life result (rankHooks), after 'F'
//   RKP the raid placement result (rankHooks), at raid end
//   STK {kind:'play'|'win', streak, best, rewardMilli, nextMilli, reset}
//       a streak moved (rankHooks.noteStreak); not sent for a win reset
//
// Presence and blocks (bus, game <-> main):
//   -> main {t:'join', userId, sid}     an account socket was welcomed
//   -> main {t:'leave', userId, sid}    it closed
//   -> main {t:'status', players:[{userId, sid, alive, score, place, rank}]}
//                                       every 10 s, all account sockets here
//   <- main {t:'blocksChanged', userId} reload socket.account.blocked (the
//      internal ids hidden from that account's chat, either direction)
//   <- main {t:'dustChanged', userId}   an admin changed the balance: reload it
//   <- main {t:'adminGemsFind'|'adminGemsGive', ...}   Discord /dust (adminGems.js)
//
// Daily quests and achievements (progressHooks.js): DQ at spawn and on
// progress, ACH on an unlock.
//
// Only the royale game has accounts; active() is false in the tutorial.
// Ranked and dust are off under ROYALE_DEBUG unless ACCOUNTS_ALLOW_DEBUG=1
// outside production (rankedOn / debugOn).
'use strict';

const accounts = require('../index');
const rankStore = require('../rankStore');

const DU_MIN_MS = 250;
const STATUS_MS = 10 * 1000;

let manager = null;
let unsub = null;
let statusTimer = null;

function active() {
    return !!(Config.dig_royale && !Config.tutorial && accounts.enabled());
}

// Debug flags, read once accounts are up (config.isProd is known by then).
let flags = null;
function debugFlags() {
    if (flags) return flags;
    const dbg = !!process.env.ROYALE_DEBUG;
    const allow = process.env.ACCOUNTS_ALLOW_DEBUG === '1';
    const host = String(process.env.PUBLIC_HOST || '');
    const prod = accounts.config.isProd || process.env.NODE_ENV === 'production' ||
        (!!host && !/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(host));
    const f = { blocked: dbg && !(allow && !prod), debug: dbg && allow && !prod };
    if (accounts.enabled()) flags = f;
    return f;
}

// Ranked + dust: accounts on in the royale, and not a plain ROYALE_DEBUG run.
function rankedOn() {
    return active() && !debugFlags().blocked;
}

// The DBG rank / dust hooks: ROYALE_DEBUG + ACCOUNTS_ALLOW_DEBUG=1, never in production.
function debugOn() {
    return rankedOn() && debugFlags().debug;
}

function init(socketManager) {
    manager = socketManager;
    if (unsub) return;
    unsub = accounts.bus.onGame(msg => {
        // Discord /dust
        if (require('./adminGems').handle(manager, msg)) return;
        // Discord /raidreset: this server's raid resets into a staging wait
        if (msg && msg.t === 'raidReset') {
            if (typeof Config === 'undefined' || !Config.dig_royale || Config.tutorial) return;
            let until = 0, players = 0;
            try {
                const dr = require('../../game/gamemodes/scripts/dig_royale.js');
                until = dr.beginStaging(msg.ms, { bots: msg.bots !== false });
                players = (manager && manager.clients ? manager.clients.filter(c => c && !c.terminated).length : 0);
            } catch (e) { console.error('[accounts] raid reset failed: ' + ((e && e.stack) || e)); }
            try { accounts.bus.toMain({ t: 'raidResetDone', reqId: msg.reqId, until, players, duos: !!Config.royale_duos }); } catch (e) { /* */ }
            return;
        }
        if (!msg || !manager) return;
        if (msg.t === 'kick') {
            for (const s of manager.clients.slice()) {
                if (s.account && s.account.id === msg.userId) kickOut(s, msg.reason || 'You got signed out. Log in again.');
            }
        } else if (msg.t === 'blocksChanged') {
            for (const s of manager.clients) if (s.account && s.account.id === msg.userId) loadBlocks(s);
        } else if (msg.t === 'dustChanged') {
            if (rankedOn()) require('./dustHooks').reloadBalance(msg.userId);
        } else if (msg.t === 'broadcast' && typeof msg.text === 'string') {
            try { manager.broadcast(msg.text); } catch (e) { /* */ }
        }
    });
    statusTimer = setInterval(sendStatus, STATUS_MS);
    if (statusTimer.unref) statusTimer.unref();
}

function loadBlocks(socket) {
    try {
        socket.account.blocked = accounts.friends.blockSet(socket.account.id);
    } catch (e) {
        socket.account.blocked = socket.account.blocked || new Set();
    }
}

// Every account socket here with its raid standing, for the friends list.
function sendStatus() {
    if (!manager || !active()) return;
    let byBody = null;
    try {
        if (Config.dig_royale) {
            byBody = new Map();
            for (const r of require('../../game/gamemodes/scripts/dig_royale.js').boardSnapshot()) byBody.set(r.id, r);
        }
    } catch (e) { byBody = null; }
    const players = [];
    for (const s of manager.clients) {
        if (!s.account || s.terminated) continue;
        const body = s.player && s.player.body;
        const row = body && byBody ? byBody.get(body.id) : null;
        players.push({
            userId: s.account.id, sid: s.id,
            alive: !!(row ? row.alive : body && !(body.isDead && body.isDead())),
            score: row ? row.score | 0 : null,
            place: row ? row.place | 0 : null,
            rank: body ? body.rankCode | 0 : 0,
        });
    }
    try { accounts.bus.toMain({ t: 'status', players }); } catch (e) { /* main gone */ }
}

// KO first so the client stops its auto-reconnect, then the raid cleanup
// (a resume snapshot only if the caller didn't mark leftOnPurpose), then the socket.
const STALE_MS = 5000;
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
    socket.account = { id: user.id, publicId: user.public_id, username: user.username, blocked: new Set() };
    loadBlocks(socket);

    // Newest session wins. KO turns off the kicked tab's auto-reconnect, so
    // there is no loop. Don't rate-limit this: flaky wifi leaves half-open
    // sockets behind on every reconnect. An old socket that has gone quiet
    // (no packet or pong for STALE_MS; sockets.js pings every 3 s) is that
    // half-open leftover, most likely this same tab coming back: its raid is
    // saved for the resume instead of thrown away.
    const t = Date.now();
    for (const o of socketManager.clients.slice()) {
        if (o === socket || !o.account || o.account.id !== user.id) continue;
        if (!(o._seenAt && t - o._seenAt > STALE_MS)) o.leftOnPurpose = true;
        kickOut(o, 'You logged in on another tab or device.');
    }
    try { accounts.bus.toMain({ t: 'join', userId: user.id, sid: socket.id }); } catch (e) { /* */ }
}

// The 'GI' packet: this browser's lasting guest id (sockets.js). Guests get
// a visit counted; a logged-in socket marks that guest as converted.
function onGuestId(socket) {
    if (!active() || !socket.guestId) return;
    const guests = require('../guests');
    if (socket.account) {
        // a guest who just signed up: their bank comes with them
        if (!guests.converted(socket.guestId, socket.account.id)) return;
        let moved = 0;
        try { moved = require('../banks').claimGuest(socket.guestId, socket.account.id); } catch (e) { /* */ }
        if (moved > 0) {
            try { socket.talk('m', 8000, 'Your guest progress came with you: ' + moved.toLocaleString('en-US') + ' banked gems are in your account now.'); } catch (e) { /* */ }
        }
        // and the achievements it earned, rewards paid now
        const ach = require('./achHooks').adoptGuest(socket, socket.guestId, socket.account.id);
        if (ach && ach.moved.length) {
            const n = ach.moved.length;
            const dust = ach.rewardMilli / 1000;
            try { socket.talk('m', 8000, n + (n === 1 ? ' achievement' : ' achievements') + ' came with you' + (dust > 0 ? ': +' + (+dust.toFixed(2)) + ' gemdust.' : '.')); } catch (e) { /* */ }
        }
        // Core loot found as a guest (terrain/coreDrop.js): granted in the adoption above
        if (ach && ach.loot && ach.loot.length) {
            try { socket.talk('m', 8000, 'Your Core loot came with you. Find it in your Locker.'); } catch (e) { /* */ }
        }
    } else guests.seen(socket.guestId, Date.now(), socket.guestSource || null);
}

// "$broadcast <text>" in raid chat, for accounts whose linked Discord is in
// ADMIN_DISCORD_IDS. -> true when handled (the line is not shown as chat).
const BROADCAST_GAP_MS = 5000;
function adminBroadcast(socket, raw) {
    if (!socket || !socket.account || !accounts.enabled()) return false;
    let row = null;
    try { row = accounts.users.byId(socket.account.id); } catch (e) { row = null; }
    const admins = accounts.config.discordBot && accounts.config.discordBot.adminIds;
    if (!row || !row.discord_id || !admins || !admins.has(String(row.discord_id))) return false;
    const text = String(raw).replace(/^\$broadcast\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const say = (t) => { try { socket.talk('m', 5000, t); } catch (e) { /* */ } };
    if (!text) { say('Usage: $broadcast <message>'); return true; }
    const now = Date.now();
    if (now - (socket._lastBroadcastAt || 0) < BROADCAST_GAP_MS) { say('Wait a few seconds between broadcasts.'); return true; }
    socket._lastBroadcastAt = now;
    try { accounts.users.audit(row.id, 'admin_broadcast', { text }, { actor: 'admin:' + row.discord_id }); } catch (e) { /* audit only */ }
    try { accounts.bus.toMain({ t: 'broadcast', text }); } catch (e) { say('Broadcast failed.'); }
    return true;
}

// The owner's spectator: "$spec" in raid chat (admins only, the same check
// as $broadcast). You become a ball that floats through everything, hidden
// from everyone else; the Command key shows or hides you again and the
// wheel zooms (sockets.js SPI / SPZ). "$spec" again leaves: the ball goes
// and you respawn as normal.
function isAdmin(socket) {
    if (!socket || !socket.account || !accounts.enabled()) return false;
    let row = null;
    try { row = accounts.users.byId(socket.account.id); } catch (e) { row = null; }
    const admins = accounts.config.discordBot && accounts.config.discordBot.adminIds;
    return !!(row && row.discord_id && admins && admins.has(String(row.discord_id)));
}
const SPEC_FOV = [1, 1.5, 2.2, 3.2, 4.5];
function adminSpec(socket) {
    if (!isAdmin(socket)) return false;
    const body = socket.player && socket.player.body;
    const say = (t) => { try { socket.talk('m', 5000, t); } catch (e) { /* */ } };
    if (!body || (body.isDead && body.isDead())) { say('Spawn first, then type $spec.'); return true; }
    if (body.adminSpec) {
        // leave: the ball goes quietly, the next spawn is a normal tank
        body.adminSpec = false;
        body.adminSpecHidden = false;
        body.carriedGems = 0;
        body.dontSendDeathMessage = true;
        body.deathCause = 'despawn';
        body.godmode = false;
        try { body.kill(); } catch (e) { /* */ }
        say('Spectator off. Respawn to play.');
        return true;
    }
    try { if ((body.carriedGems | 0) > 0) require('../../game/terrain/gems.js').dropGemsOnDeath(body, []); } catch (e) { /* */ }
    body.carriedGems = 0;
    body.define('adminSpectator');
    body.adminSpec = true;
    body.adminSpecHidden = true;
    body.adminSpecZoom = 1;
    body.noclip = true;
    body.godmode = true;
    body.invuln = false;
    body.passive = true;
    body.FOV = 1.6 * SPEC_FOV[1];
    try { body.refreshBodyAttributes(); } catch (e) { /* */ }
    say('Spectator on. You are hidden. Command shows or hides you, the wheel zooms, $spec again to stop.');
    return true;
}
// SPI: show or hide the spectator; SPZ: zoom one step (dir -1 in, +1 out)
function adminSpecInvis(socket) {
    const body = socket && socket.player && socket.player.body;
    if (!body || !body.adminSpec) return;
    const t = Date.now();
    if (t - (socket._specToggleAt || 0) < 250) return;
    socket._specToggleAt = t;
    body.adminSpecHidden = !body.adminSpecHidden;
    try { socket.talk('m', 2500, body.adminSpecHidden ? 'Hidden. Nobody can see you.' : 'Visible. Everyone can see you.'); } catch (e) { /* */ }
}
function adminSpecZoom(socket, dir) {
    const body = socket && socket.player && socket.player.body;
    if (!body || !body.adminSpec) return;
    const t = Date.now();
    if (t - (socket._specZoomAt || 0) < 90) return;
    socket._specZoomAt = t;
    body.adminSpecZoom = Math.max(0, Math.min(SPEC_FOV.length - 1, (body.adminSpecZoom | 0) + (dir > 0 ? 1 : -1)));
    body.FOV = 1.6 * SPEC_FOV[body.adminSpecZoom];
    try { body.refreshBodyAttributes(); } catch (e) { /* */ }
}

// Chat filter (network/raidChat.js): hide what `speaker` says from `viewer`.
function chatHidden(viewer, speaker) {
    const b = viewer && viewer.account && viewer.account.blocked;
    return !!(b && b.size && speaker && speaker.accountId && b.has(speaker.accountId));
}

// Accounts always play under their username. Guests keep a cleaned version
// of what they typed, marked when it would pass for someone's account. A rude
// name (or a guest name under 5 characters) plays as "Guest#1234"
// (shared/profanity.js), so nobody else ever sees it.
const profanity = require('../../../shared/profanity.js');
function resolveName(socket, name) {
    if (socket.account) {
        try {
            const row = accounts.users.byId(socket.account.id);
            if (row && !row.deleted_at) socket.account.username = row.username;
        } catch (e) { /* keep the cached name */ }
        return profanity.hasProfanity(socket.account.username) ? profanity.fallbackName(socket) : socket.account.username;
    }
    let clean = String(name == null ? '' : name);
    try { clean = accounts.names.sanitizeGuestName(clean); } catch (e) { /* fall back to what sockets.js cleaned */ }
    clean = profanity.guestName(clean, socket);
    if (clean && active()) {
        try { if (accounts.users.isRegisteredName(clean)) clean = '~' + clean.slice(0, 23); } catch (e) { /* */ }
    }
    if (socket.guestId && active()) require('../guests').named(socket.guestId, clean);
    return clean;
}

function nextUnlock(row) {
    try {
        const v = require('../store').storeView(row);
        let best = null;
        for (const it of [...(v.featured || []), ...(v.daily || []), ...(v.sidekicks || []), ...(v.permanent || [])]) {
            if (!it || it.owned || !(it.priceDust > 0)) continue;
            if (!best || it.priceDust < best.p) best = { n: String(it.name || 'an item').slice(0, 28), p: it.priceDust };
        }
        return best;
    } catch (e) { return null; }
}
function sendJson(socket, type, obj) {
    try { socket.talk(type, JSON.stringify(obj)); } catch (e) { /* socket closing */ }
}

// AC + a DU sync for this account (spawn, or after DBG rank).
function sendAccount(socket, row, body) {
    const dh = require('./dustHooks');
    sendJson(socket, 'AC', {
        username: row.username,
        userId: row.public_id,
        rank: rankStore.snapshot(row),
        dust: dh.balanceOf(row.id) / 1000,
        dustCarried: dh.carriedOf(body) / 1000,
        // the end screen's "next unlock": the cheapest lobby shop item you don't own yet
        nu: nextUnlock(row),
    });
    du(socket, 0, 0, true);
}

// Fresh user row at every spawn: cosmetics (owned items only; a Locker
// equip applies on the next spawn), the sidekick (body.sidekick), the
// nameplate rank code, then AC and DU.
// Custom Color rides the 7-char name colour prefix (body.nameColor);
// body.customNameColor feeds the board row's `nc`.
function applyIdentity(socket, body) {
    if (!body) return;
    body.accountId = socket.account ? socket.account.id : 0;
    body.nameStyleNid = 0;
    body.rankCode = 0;
    body.skinNid = 0;
    body.customNameColor = null;
    body.sidekick = null;
    // the Core Champion crown by the name: this connection's own win (guests
    // too), or an account's win in the last 24 h
    body.champUntil = socket._champUntil || 0;
    socket._rkPending = null;
    if (!socket.account || !active()) return;
    try { body.champUntil = Math.max(body.champUntil, rankStore.championUntil(socket.account.id)); } catch (e) { /* */ }
    try {
        const row = accounts.users.byId(socket.account.id);
        if (!row) return;
        // the equipped sidekick tags along (game/terrain/sidekicks.js picks it up)
        try { body.sidekick = accounts.store.sidekickFor(row); } catch (e) { body.sidekick = null; }
        const cos = accounts.store.cosmeticsFor(row);
        body.nameStyleNid = cos.nameStyleNid;
        body.skinNid = cos.skinNid;
        if (cos.nameColor) {
            body.nameColor = cos.nameColor;
            body.customNameColor = cos.nameColor;
        }
        if (!rankedOn()) return;
        body.rankCode = rankStore.codeOf(row);
        sendAccount(socket, row, body);
        require('./progressHooks').sendAll(socket);
    } catch (e) {
        console.error('[accounts] identity failed: ' + ((e && e.stack) || e));
    }
}

// ---- DU, coalesced per socket ----

const duQueue = new Set();

function sendDU(socket, q, now) {
    duQueue.delete(socket);
    q.pending = false;
    q.at = now;
    const delta = q.delta;
    const kind = q.kind < 0 ? 0 : q.kind;
    q.delta = 0;
    q.kind = -1;
    if (socket.terminated) return;
    try {
        const v = require('./dustHooks').valuesFor(socket);
        socket.talk('DU', v[0] | 0, v[1] | 0, Math.round(delta) | 0, kind);
    } catch (e) { /* socket closing */ }
}

// Queue a delta (milli) of `kind`. A pending different kind is sent first,
// so kinds never mix.
function du(socket, delta, kind, force = false) {
    if (!socket || !socket.account) return;
    const now = Date.now();
    const q = socket._du || (socket._du = { at: 0, delta: 0, kind: -1, pending: false });
    if (q.pending && q.kind !== kind && q.kind >= 0) sendDU(socket, q, now);
    q.delta += delta | 0;
    q.kind = kind;
    q.pending = true;
    if (force || now - q.at >= DU_MIN_MS) sendDU(socket, q, now);
    else duQueue.add(socket);
}

function tickDU(now = Date.now()) {
    if (!duQueue.size) return;
    for (const s of Array.from(duQueue)) {
        const q = s._du;
        if (!q || !q.pending || s.terminated) { duQueue.delete(s); continue; }
        if (now - q.at >= DU_MIN_MS) sendDU(s, q, now);
    }
}

// Right after 'F': the life result settled in onCombatantDead (or at raid end).
function afterDeathPacket(socket) {
    const p = socket && socket._rkPending;
    if (!p) return;
    socket._rkPending = null;
    sendJson(socket, 'RK', p);
}

function onClose(socket) {
    duQueue.delete(socket);
    // achievements (accounts and guests): counters written now
    try { require('./achHooks').onClose(socket); } catch (e) { /* */ }
    socket._rkPending = null;
    if (socket.account && !socket._presenceLeft) {
        socket._presenceLeft = true;
        try { accounts.bus.toMain({ t: 'leave', userId: socket.account.id, sid: socket.id }); } catch (e) { /* */ }
    }
    if (!socket.account || !rankedOn()) return;
    try { require('./dustHooks').onClose(socket); } catch (e) {
        console.error('[accounts] dust flush on close failed: ' + ((e && e.stack) || e));
    }
    // another live socket of the same account keeps the quest cache
    if (!socketOf(socket.account.id, socket)) {
        try { require('./progressHooks').onClose(socket); } catch (e) {
            console.error('[accounts] quest save on close failed: ' + ((e && e.stack) || e));
        }
    }
}

// The live game socket of an account (normally at most one). `except` is skipped.
function socketOf(userId, except = null) {
    if (!manager || !userId) return null;
    for (const s of manager.clients) {
        if (s !== except && !s.terminated && s.account && s.account.id === userId) return s;
    }
    return null;
}

// ── Core loot (terrain/coreDrop.js) ───────────────────────────────────
// Who keeps a lucky drop: an account, or a guest browser (saved for signup,
// achievements.addGuestLoot). null when accounts are off or nobody to keep it.
function lootOwner(socket) {
    if (!socket || !rankedOn()) return null;
    if (socket.account && socket.account.id) return { kind: 'a', id: socket.account.id };
    if (typeof socket.guestId === 'string' && /^[a-f0-9]{32}$/.test(socket.guestId)) return { kind: 'g', id: socket.guestId };
    return null;
}
// the item ids this owner already has (a guest: what the Core gave it so far)
function lootOwned(o) {
    if (!o) return new Set();
    if (o.kind === 'a') return require('../store').ownedSet(o.id);
    return new Set(require('../achievements').guestLoot(o.id));
}
// The grant: an account gets it at once through retention.grantItem (the
// owned_items row, put on if that slot is empty), a guest's waits for signup.
// -> true when it was new
function lootGrant(o, itemId, now = Date.now()) {
    if (!o) return false;
    if (o.kind === 'g') return require('../achievements').addGuestLoot(o.id, itemId, now);
    const d = accounts.db.handle();
    if (!d) return false;
    const fresh = d.tx(() => require('../retention').grantItem(d, o.id, itemId, now));
    if (fresh) { try { accounts.users.audit(o.id, 'core_loot', { itemId }, { now, actor: 'system' }); } catch (e) { /* best effort */ } }
    return !!fresh;
}

module.exports = {
    lootOwner, lootOwned, lootGrant,
    init, active, rankedOn, debugOn, onConnect, onGuestId, resolveName, adminBroadcast, adminSpec, adminSpecInvis, adminSpecZoom, applyIdentity, sendAccount, afterDeathPacket,
    du, tickDU, onClose, kickOut, chatHidden, sendStatus, loadBlocks, socketOf,
};
