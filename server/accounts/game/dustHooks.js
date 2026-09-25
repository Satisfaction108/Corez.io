// Gemdust in the game thread.
//
// Every combatant (bots and guests too) carries body.dustCarried, in
// milli-dust, so dust is conserved when gems change hands:
//   pickup      + gem.gemDust ?? DUST_MILLI_PER_GEM[gem.gemOre]   (gems.js tickGem)
//   banking     the removed share of the satchel, times the bank's efficiency
//               (vault 1, outpost 0.8, flash vault 0.7; never Deep Pockets)
//   insurance   exactly a quarter of the carried dust is banked at death
//   death       the rest rides on the dropped pieces (gem.gemDust), split by
//               value with the remainder on the largest, so a pickup of a
//               death drop never mints anything new
// The starter kit, debug grants, milestones, quest rewards, the next-raid
// bonus and the combo bonus add gems but never dust. Only accounts get a
// balance: banked and kill dust go to a per-account pending pot (soft cap
// applied as it is earned) and reach the database in one transaction every
// 5 s, and at once on death, bank completion, disconnect and raid end.
'use strict';

const R = require('../../../shared/ranks.js');
const dust = require('../dust');

const FLUSH_MS = 5000;

let bridgeMod = null, progressMod = null;
function bridge() { return bridgeMod || (bridgeMod = require('./bridge')); }
function progress() { return progressMod || (progressMod = require('./progressHooks')); }
function on() { return bridge().rankedOn(); }

// ---- pure helpers (unit tested) ----

// Dust leaving with `removed` of `before` satchel gems; the last gems out
// take whatever is left, so chunks always sum to the whole.
function bankShare(dustCarried, removed, before) {
    dustCarried = Math.max(0, dustCarried | 0);
    if (!dustCarried || !(removed > 0)) return 0;
    if (!(before > removed)) return dustCarried;
    return Math.min(dustCarried, Math.floor(dustCarried * removed / before));
}

// Efficiency in whole thousandths with the fraction carried to the next
// chunk. -> {credit, remK}
function effCredit(moved, eff, remK) {
    const k = Math.round(Math.max(0, Math.min(1, +eff || 0)) * 1000);
    const total = Math.max(0, moved | 0) * k + Math.max(0, remK | 0);
    const credit = Math.floor(total / 1000);
    return { credit, remK: total - credit * 1000 };
}

function insuranceShare(dustCarried) {
    return Math.floor(Math.max(0, dustCarried | 0) / 4);
}

// Dust per dropped piece, by value; exact sum, remainder on the largest.
function splitDeath(total, values) {
    const out = values.map(() => 0);
    total = Math.max(0, total | 0);
    const sumV = values.reduce((a, v) => a + (v > 0 ? v : 0), 0);
    if (!total || !(sumV > 0)) return out;
    let big = -1, given = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!(v > 0)) continue;
        out[i] = Math.floor(total * v / sumV);
        given += out[i];
        if (big < 0 || v > values[big]) big = i;
    }
    out[big] += total - given;
    return out;
}

// ---- per-account pending dust ----

// userId -> {id, balance (database, as of the last flush), day, earned
// (gross today), gems, kill, other (pending, past the cap), remK, gemsBanked}
const accts = new Map();
let lastFlushAt = 0;
let lastErrAt = 0;
let creditListener = null;     // (userId, milli) for the open life's tally
let refFn = () => null;        // ledger ref (the raid key)

function setCreditListener(fn) { creditListener = typeof fn === 'function' ? fn : null; }
function setRef(fn) { refFn = typeof fn === 'function' ? fn : () => null; }

function stateOf(userId) {
    let a = accts.get(userId);
    if (a) return a;
    const s = dust.loadState(userId);
    if (!s) return null;
    a = { id: userId, balance: s.balance, day: s.day, earned: s.earned, gems: 0, kill: 0, other: 0, remK: 0, gemsBanked: 0, ref: null };
    accts.set(userId, a);
    return a;
}

function accountOf(body) {
    const acct = body && body.socket && body.socket.account;
    return acct && acct.id ? stateOf(acct.id) : null;
}

// Gross gem/kill dust earned now -> milli credited after the daily soft cap.
function earn(a, grossMilli, kind, now = Date.now()) {
    if (!a || !(grossMilli > 0)) return 0;
    const day = dust.dayOf(now);
    if (a.day !== day) { a.day = day; a.earned = 0; }
    const c = dust.softCap(a.earned, grossMilli);
    a.earned = c.earned;
    a.remK += c.creditK;
    const whole = Math.floor(a.remK / 1000);
    a.remK -= whole * 1000;
    a[kind] += whole;
    a.ref = refFn() || a.ref;
    if (whole && creditListener) { try { creditListener(a.id, whole); } catch (e) { /* tally only */ } }
    return whole;
}

function balanceOf(userId) {
    const a = userId ? stateOf(userId) : null;
    return a ? a.balance + a.gems + a.kill + a.other : 0;
}

function carriedOf(body) {
    return body && !body.isDead?.() ? Math.max(0, body.dustCarried | 0) : 0;
}

// [carriedMilli, balanceMilli] for a DU packet.
function valuesFor(socket) {
    const body = socket && socket.player && socket.player.body;
    return [carriedOf(body), socket && socket.account ? balanceOf(socket.account.id) : 0];
}

function flushList(list, now = Date.now()) {
    const rows = [];
    for (const a of list) {
        if (a.gems || a.kill || a.other || a.gemsBanked) {
            rows.push({ userId: a.id, gems: a.gems, kill: a.kill, other: a.other, day: a.day, earned: a.earned, gemsBanked: a.gemsBanked, ref: a.ref });
        }
    }
    if (!rows.length) return true;
    let res;
    try { res = dust.flush(rows, now); } catch (e) {
        // busy or broken: keep it pending for the next flush
        if (now - lastErrAt > 10000) { lastErrAt = now; console.error('[accounts] dust flush failed: ' + ((e && e.stack) || e)); }
        return false;
    }
    const banked = [];
    for (const a of list) {
        if (!(a.gems || a.kill || a.other || a.gemsBanked)) continue;
        if (res.has(a.id)) a.balance = res.get(a.id);
        if (a.gemsBanked) banked.push(a.id);
        a.gems = 0; a.kill = 0; a.other = 0; a.gemsBanked = 0;
    }
    // gems_banked moved: banker / tycoon
    for (const id of banked) {
        try { progress().checkStats(bridge().socketOf(id), id); } catch (e) { /* achievements only */ }
    }
    return true;
}

// -> the account's balance after the flush
function flushAccount(userId, now = Date.now()) {
    const a = accts.get(userId);
    if (!a) return balanceOf(userId);
    flushList([a], now);
    return a.balance + a.gems + a.kill + a.other;
}

function flushAll(now = Date.now()) {
    lastFlushAt = now;
    if (accts.size) flushList([...accts.values()], now);
}

function tick(t) {
    if (t - lastFlushAt >= FLUSH_MS) flushAll(t);
    bridge().tickDU(t);
}

// ---- game events ----

function onPickup(body, gem) {
    if (!body || !gem || !on()) return;
    const m = Math.max(0, (gem.gemDust ?? R.DUST_MILLI_PER_GEM[gem.gemOre] ?? 0) | 0);
    if (!m) return;
    body.dustCarried = (body.dustCarried | 0) + m;
    if (body.socket && body.socket.account) {
        bridge().du(body.socket, m, 1);
        try { progress().onPickup(body, gem); } catch (e) { /* quests only */ }
    }
}

// `removed` of the `before` gems in the satchel went into a bank at
// `eff`. -> dust that left the satchel
function onSatchelOut(body, removed, before, eff) {
    if (!body || !on()) return 0;
    const a = accountOf(body);
    if (a && removed > 0) {
        a.gemsBanked += Math.floor(removed);
        try { progress().onBank(body.socket, removed); } catch (e) { /* quests only */ }
    }
    const moved = bankShare(body.dustCarried, removed, before);
    if (!moved) return 0;
    body.dustCarried = (body.dustCarried | 0) - moved;
    const e = effCredit(moved, eff, body._dustRemK);
    body._dustRemK = e.remK;
    if (a && e.credit) {
        const got = earn(a, e.credit, 'gems');
        bridge().du(body.socket, got, 2);
    }
    return moved;
}

// A deposit finished: write it now and always tell the client.
function onBankDone(body) {
    if (!body || !body.socket || !body.socket.account || !on()) return;
    flushAccount(body.socket.account.id);
    bridge().du(body.socket, 0, 2, true);
}

// Insurance at death: a quarter of the carried dust is banked with the
// insured gems.
function onInsured(body) {
    if (!body || !on()) return 0;
    const moved = insuranceShare(body.dustCarried);
    if (!moved) return 0;
    body.dustCarried = (body.dustCarried | 0) - moved;
    const a = accountOf(body);
    if (a) bridge().du(body.socket, earn(a, moved, 'gems'), 2);
    return moved;
}

// Death: everything still carried moves onto the dropped pieces (values in
// gems). -> dust per piece, or null when dust is off (leave gemDust unset)
function onDeathDrop(body, values) {
    if (!body || !on()) return null;
    const lost = Math.max(0, body.dustCarried | 0);
    body.dustCarried = 0;
    body._dustRemK = 0;
    if (body.socket && body.socket.account) bridge().du(body.socket, -lost, 4, true);
    return splitDeath(lost, values || []);
}

function creditKill(socket, milli) {
    if (!socket || !socket.account || !on()) return 0;
    const a = stateOf(socket.account.id);
    const got = earn(a, milli, 'kill');
    if (a) bridge().du(socket, got, 3);
    return got;
}

// Chest / boss / shop rewards (R.REWARDS): soft-capped like kill dust,
// ledger kind 'other', a DU pop (kind 7) on the HUD.
function creditReward(socket, milli) {
    if (!socket || !socket.account || !on() || !(milli > 0)) return 0;
    const a = stateOf(socket.account.id);
    const got = earn(a, milli | 0, 'other');
    if (a) bridge().du(socket, got, 7);
    return got;
}

// Exempt credit already written to the database (placement bonus).
function noteExternalCredit(userId, milli, balanceAfter) {
    const a = accts.get(userId);
    if (a && balanceAfter != null) a.balance = balanceAfter | 0;
    if (a && milli && creditListener) { try { creditListener(userId, milli); } catch (e) { /* */ } }
}

// The main thread changed the balance (Discord /grantdust): reload it and
// resync the HUD. Pending gem/kill dust stays pending.
function reloadBalance(userId) {
    const a = accts.get(userId);
    if (!a) return;
    const s = dust.loadState(userId);
    if (s) a.balance = s.balance;
    const sock = bridge().socketOf(userId);
    if (sock) bridge().du(sock, 0, 0, true);
}

// Resume: the carried dust leaves with the carried gems, and comes back.
function stash(body) {
    if (!body) return 0;
    const m = Math.max(0, body.dustCarried | 0);
    body.dustCarried = 0;
    return m;
}
function restore(body, milli) {
    if (!body || !on()) return;
    body.dustCarried = Math.max(0, milli | 0);
    if (body.socket && body.socket.account) bridge().du(body.socket, 0, 0, true);
}

function zero(body) {
    if (body) { body.dustCarried = 0; body._dustRemK = 0; }
}

// Socket gone: write its account's pending dust and forget the state.
function onClose(socket) {
    const id = socket && socket.account && socket.account.id;
    if (!id || !accts.has(id)) return;
    flushAccount(id);
    const a = accts.get(id);
    if (a && !a.gems && !a.kill && !a.other && !a.gemsBanked) accts.delete(id);
}

// DBG dust <milli> (debug mode only; the caller checks).
function debugSetCarried(body, milli) {
    if (!body) return;
    body.dustCarried = Math.max(0, Math.min(1e9, milli | 0));
    if (body.socket && body.socket.account) bridge().du(body.socket, 0, 0, true);
}

module.exports = {
    FLUSH_MS, bankShare, effCredit, insuranceShare, splitDeath,
    setCreditListener, setRef, balanceOf, carriedOf, valuesFor, flushAccount, flushAll, tick,
    onPickup, onSatchelOut, onBankDone, onInsured, onDeathDrop, creditKill, creditReward, noteExternalCredit, reloadBalance,
    stash, restore, zero, onClose, debugSetCarried,
    _accts: accts,
};
