// The persistent bank, game side (the store is accounts/banks.js).
//
// socket.gemBanked stays the one number everything spends and earns on
// (shop, vault, bases, contracts, admin gifts). This file only decides
// where it starts and where it goes:
//
//   checkOut   a player's first spawn on this socket: the account's (or the
//              guest's) bank is taken out of the database into
//              socket.gemBanked, and socket.bankKept remembers how much of it
//              came in from before
//   tick       every CHECKPOINT_MS the lease records what the socket holds,
//              so a crash loses a few seconds at most
//   release    the socket is done (leaving, a drop nobody resumed, a save):
//              the bank goes back, capped at banks.CAP
//   newRaid    a new raid on the same socket: the bank stays, trimmed to the
//              cap, and all of it now counts as brought in
// deathLoss off by default (banked gems are always safe); with
//              ROYALE_SAVINGS_DEATH_LOSS=1 dying costs DEATH_SHARE of the
//              savings (the kept part brought in from
//
// The 45 s resume carries the lease inside the snapshot (dig_royale
// saveResume copies socket fields), so a reconnect keeps the same gems and
// never checks out a second time; a snapshot nobody claims is released.
//
// bankKept is only for the HUD split and never feeds score or growth: the
// raid board counts banking events (stat.banked), not the balance. Spending
// comes out of this raid's gems first, then the kept part
'use strict';

const crypto = require('crypto');

const CHECKPOINT_MS = 15 * 1000;
const DEATH_SHARE = 0.75;       // On death, you keep 25% of your banked gems as a starter stash for the next life
const DEATH_MAX = 50000;
const SESSION_KEEP_SHARE = 0.25;
const SESSION_KEEP_MAX = 800;
// Dying trims banked shop gems down to a 25% starter stash (up to 800) so
// every life starts hungry while still rewarding your previous life's banking.
let deathLossOn = process.env.ROYALE_SAVINGS_DEATH_LOSS !== '0';
function setDeathLoss(v) { deathLossOn = !!v; }
function deathLossEnabled() { return deathLossOn; }

let banksMod = null;
function banks() { return banksMod || (banksMod = require('../../accounts/banks.js')); }
let bridgeMod = null;
function bridge() { return bridgeMod || (bridgeMod = require('../../accounts/game/bridge.js')); }

function cap() { return banks().CAP; }

// Accounts on and a real raid (not the tutorial).
function on() {
    try { return !!(Config.dig_royale && !Config.tutorial && bridge().active()); } catch (e) { return false; }
}

function ownerOf(socket) {
    if (!socket) return null;
    if (socket.account && socket.account.id) return 'a:' + socket.account.id;
    if (socket.guestId && /^[a-f0-9]{32}$/.test(socket.guestId)) return 'g:' + socket.guestId;
    return null;
}

function logErr(what, e) {
    const t = Date.now();
    if (t - (logErr.at || 0) < 10000) return;
    logErr.at = t;
    console.error('[bank] ' + what + ' failed: ' + ((e && e.stack) || e));
}

// Keeps bankKept within the balance: a spend eats this raid's gems first
function fixKept(socket) {
    if (!socket) return 0;
    const b = Math.max(0, (socket.gemBanked || 0) | 0);
    if ((socket.bankKept | 0) > b) socket.bankKept = b;
    return socket.bankKept | 0;
}

function kept(socket) {
    return socket ? Math.max(0, Math.min((socket.bankKept | 0), (socket.gemBanked || 0) | 0)) : 0;
}

// The part of the bank this raid put there.
function raidPart(socket) {
    return socket ? Math.max(0, ((socket.gemBanked || 0) | 0) - kept(socket)) : 0;
}

// -> gems brought in (0 if none, or not persisted here)
function checkOut(socket) {
    if (!socket || socket._bankOut) return 0;
    socket._bankOut = true;
    if (!on()) return 0;
    const owner = ownerOf(socket);
    if (!owner) return 0;
    const lease = crypto.randomBytes(12).toString('hex');
    let got = null;
    try { got = banks().checkout(owner, lease); } catch (e) { logErr('checkout', e); got = null; }
    if (got == null) return 0;
    socket._bankLease = lease;
    socket._bankOwner = owner;
    socket._bankSavedAt = Date.now();
    // Spawn in with a modest starter portion (25%, up to 800) of previous session's banked gems
    const starter = got > 0 ? Math.min(got, Math.min(SESSION_KEEP_MAX, Math.max(50, Math.round(got * SESSION_KEEP_SHARE)))) : 0;
    socket.gemBanked = Math.max(0, (socket.gemBanked || 0) | 0) + starter;
    socket.bankKept = (socket.bankKept | 0) + starter;
    return starter;
}

// holder: a socket, or a resume snapshot's sock copy
function release(holder) {
    if (!holder || !holder._bankLease) return null;
    const lease = holder._bankLease;
    holder._bankLease = null;
    let after = null;
    try { after = banks().release(lease, Math.max(0, (holder.gemBanked || 0) | 0)); } catch (e) { logErr('release', e); }
    return after;
}

function checkpoint(holder, t) {
    if (!holder || !holder._bankLease) return;
    holder._bankSavedAt = t;
    try { banks().checkpoint(holder._bankLease, Math.max(0, (holder.gemBanked || 0) | 0), t); } catch (e) { logErr('checkpoint', e); }
}

// clients: connected sockets; held: resume snapshots' sock copies
function tick(t, clients, held) {
    for (const s of clients) {
        if (s && s._bankLease && t - (s._bankSavedAt || 0) >= CHECKPOINT_MS) checkpoint(s, t);
    }
    if (held) for (const h of held) {
        if (h && h._bankLease && t - (h._bankSavedAt || 0) >= CHECKPOINT_MS) checkpoint(h, t);
    }
}

// The next raid on the same socket. -> gems trimmed off by the cap
function newRaid(socket) {
    if (!socket) return 0;
    const b = Math.max(0, (socket.gemBanked || 0) | 0);
    if (!socket._bankLease) {
        // nothing to carry it in (no accounts, no identity): a clean start
        socket.gemBanked = 0;
        socket.bankKept = 0;
        return 0;
    }
    const keep = Math.min(cap(), b);
    socket.gemBanked = keep;
    socket.bankKept = keep;
    checkpoint(socket, Date.now());
    return b - keep;
}

// -> gems lost (the caller takes them off)
function deathLossFor(body) {
    if (!deathLossOn) return 0;
    if (!body || !body.socket || body.isBot) return 0;
    if (!Config.dig_royale || Config.tutorial) return 0;
    const cause = body.deathCause || '';
    if (cause === 'raidend' || cause === 'despawn' || cause === 'saved' || body._savedOut) return 0;
    // already out of the raid (a disconnect or idle kick drops the satchel
    // after the cleanup): leaving is not dying
    if (body.royaleAlive === false || body.socket.leftOnPurpose || body.socket._drCleaned) return 0;
    try { if (require('./fairPlay.js').isProtected(body)) return 0; } catch { /* */ }
    const b = Math.max(0, (body.socket.gemBanked || 0) | 0);
    if (b <= 0) return 0;
    const keepStarter = Math.min(SESSION_KEEP_MAX, Math.round(b * (1 - DEATH_SHARE)));
    return Math.max(0, Math.min(DEATH_MAX, b - keepStarter));
}

// Takes a death's loss off the bank, leaving the starter portion for the next life
function takeDeathLoss(socket, loss) {
    if (!socket) return 0;
    const b = Math.max(0, (socket.gemBanked || 0) | 0);
    loss = Math.max(0, Math.min(b, loss | 0));
    const rem = b - loss;
    socket.bankKept = Math.min(kept(socket), rem);
    return rem;
}

// shutdown: every lease this thread holds goes back now
function releaseAll(clients, held) {
    for (const s of clients || []) release(s);
    for (const h of held || []) release(h);
}

module.exports = {
    CHECKPOINT_MS, DEATH_SHARE, DEATH_MAX, setDeathLoss, deathLossEnabled, cap, on, ownerOf, kept, raidPart, fixKept,
    checkOut, release, checkpoint, tick, newRaid, deathLossFor, takeDeathLoss, releaseAll,
};
