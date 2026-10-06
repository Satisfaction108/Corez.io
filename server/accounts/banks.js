// The persistent bank: banked gems that outlast a raid, a disconnect and
// the session. Accounts keep theirs in users.bank_gems, guests in
// guests.bank_gems (keyed by the browser's guest id, the amount is only
// ever what the server wrote). Owners are 'a:<user id>' or 'g:<guest id>'.
//
// A game server never reads the balance and writes it back later. It takes
// the whole balance out in one transaction (checkout), which leaves 0 at
// rest and a lease row holding what was taken; the game spends and earns
// on that in memory and puts the result back when the player is done with
// it (release). So a second tab, a Duos raid next to a Solo one, or two raid
// workers can never spend the same gems twice: whoever checks out second
// finds what is at rest, which is nothing while the first one plays.
//
// While a lease is out the game checkpoints what it holds every few
// seconds. A lease nobody touched for STALE_MS (a crashed or stuck thread)
// is written back from its checkpoint by the main thread (recoverStale);
// if that session does come back, its release only adds the difference.
// At boot nothing is playing yet, so every lease left over is written back.
//
// Every balance at rest is capped at CAP.
//
// A guest who signs up keeps their bank: once the browser's guest id shows up
// on an account made around the same time (guests.converted), claimGuest moves
// what the guest has at rest onto the account, and a guest lease still out
// (a raid they were in when they signed up) releases onto the account too.
'use strict';

const db = require('./db');

const CAP = 50000;
const STALE_MS = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const GUEST_RE = /^[a-f0-9]{32}$/;
// only an account made within this long of the guest turning into it
const NEW_ACCOUNT_MS = DAY;

// 'a:12' -> {kind:'a', id:12}, 'g:<hex>' -> {kind:'g', id:'<hex>'}, else null
function parseOwner(owner) {
    const s = String(owner || '');
    if (s.startsWith('a:')) {
        const id = Number(s.slice(2));
        return Number.isInteger(id) && id > 0 ? { kind: 'a', id } : null;
    }
    if (s.startsWith('g:') && GUEST_RE.test(s.slice(2))) return { kind: 'g', id: s.slice(2) };
    return null;
}

function clamp(n) {
    return Math.max(0, Math.min(CAP, Math.floor(+n || 0)));
}

function atRest(d, o) {
    const r = o.kind === 'a'
        ? d.get('SELECT bank_gems AS g FROM users WHERE id = ? AND deleted_at IS NULL', o.id)
        : d.get('SELECT bank_gems AS g FROM guests WHERE guest_id = ?', o.id);
    return r ? Math.max(0, r.g | 0) : 0;
}

function setAtRest(d, o, value, now) {
    const v = clamp(value);
    if (o.kind === 'a') {
        d.run('UPDATE users SET bank_gems = ? WHERE id = ?', v, o.id);
    } else {
        d.run(`INSERT INTO guests (guest_id, first_seen, last_seen, bank_gems) VALUES (?, ?, ?, ?)
            ON CONFLICT(guest_id) DO UPDATE SET bank_gems = excluded.bank_gems`, o.id, now, now, v);
    }
    return v;
}

// A guest that became a new account banks into that account from then on.
function mergeTarget(d, o) {
    if (!o || o.kind !== 'g') return o;
    const r = d.get(`SELECT g.converted_user_id AS u FROM guests g JOIN users u ON u.id = g.converted_user_id
        WHERE g.guest_id = ? AND u.deleted_at IS NULL AND u.created_at >= g.converted_at - ?`, o.id, NEW_ACCOUNT_MS);
    return r && r.u ? { kind: 'a', id: r.u } : o;
}

// The guest's bank onto the new account. -> gems moved (0 if none or the
// account isn't the one this guest just became)
function claimGuest(guestId, userId, now = Date.now()) {
    const d = db.handle();
    if (!d || !GUEST_RE.test(String(guestId || '')) || !userId) return 0;
    return d.tx(() => {
        const g = { kind: 'g', id: guestId };
        const to = mergeTarget(d, g);
        if (!to || to.kind !== 'a' || to.id !== userId) return 0;
        const n = atRest(d, g);
        if (!(n > 0)) return 0;
        setAtRest(d, g, 0, now);
        setAtRest(d, to, atRest(d, to) + n, now);
        return n;
    });
}

// Gems paid in from outside a raid (the daily rewards track paid these until Oct
// is at rest, in one transaction (a savepoint inside the caller's), for the
// account a converted guest became. Safe while a lease is out: at rest is
// 0 then, and release / recoverStale only ever add to it, so the reward is
// kept and nobody can spend it twice. -> gems actually added (the cap can
// eat some), or null when the database is not there.
function credit(owner, gems, now = Date.now()) {
    const d = db.handle();
    const n = Math.max(0, Math.floor(+gems || 0));
    if (!d || !parseOwner(owner)) return null;
    if (!n) return 0;
    return d.tx(() => {
        const o = mergeTarget(d, parseOwner(owner));
        const before = atRest(d, o);
        return setAtRest(d, o, before + n, now) - before;
    });
}

// What is at rest for this owner right now (0 while a session holds it).
function peek(owner) {
    const d = db.handle();
    const o = parseOwner(owner);
    if (!d || !o) return 0;
    return atRest(d, o);
}

// Takes the whole balance out under leaseId. -> gems taken (0 if none), or
// null when the database is not there.
function checkout(owner, leaseId, now = Date.now()) {
    const d = db.handle();
    const o = parseOwner(owner);
    if (!d || !o || !leaseId) return null;
    return d.tx(() => {
        const g = Math.min(CAP, atRest(d, o));
        if (g > 0) setAtRest(d, o, 0, now);
        d.run('INSERT INTO bank_leases (lease_id, owner, taken, held, at) VALUES (?, ?, ?, ?, ?)', String(leaseId), String(owner), g, g, now);
        return g;
    });
}

// What the session holds right now, so a crash loses at most one step.
function checkpoint(leaseId, held, now = Date.now()) {
    const d = db.handle();
    if (!d || !leaseId) return false;
    return d.run('UPDATE bank_leases SET held = ?, at = ? WHERE lease_id = ?', clamp(held), now, String(leaseId)).changes > 0;
}

// The session is done: what it holds goes back to rest (capped) and the
// lease closes. A lease that was already written back by recoverStale only
// adds what changed since. -> the balance at rest after, or null (no lease:
// released before, or never taken)
function release(leaseId, final, now = Date.now()) {
    const d = db.handle();
    if (!d || !leaseId) return null;
    return d.tx(() => {
        const row = d.get('SELECT owner, recovered FROM bank_leases WHERE lease_id = ?', String(leaseId));
        if (!row) return null;
        d.run('DELETE FROM bank_leases WHERE lease_id = ?', String(leaseId));
        const o = mergeTarget(d, parseOwner(row.owner));
        if (!o) return null;
        const hold = clamp(final);
        const add = row.recovered != null ? hold - (row.recovered | 0) : hold;
        return setAtRest(d, o, atRest(d, o) + add, now);
    });
}

// Leases untouched for maxAgeMs go back from their last checkpoint. At boot
// (all = true) nothing can still be playing: every lease is written back and
// removed. -> number of leases written back
function recoverStale(now = Date.now(), maxAgeMs = STALE_MS, all = false) {
    const d = db.handle();
    if (!d) return 0;
    return d.tx(() => {
        const rows = all
            ? d.all('SELECT lease_id, owner, held, recovered FROM bank_leases')
            : d.all('SELECT lease_id, owner, held, recovered FROM bank_leases WHERE recovered IS NULL AND at <= ?', now - maxAgeMs);
        let n = 0;
        for (const r of rows) {
            const o = mergeTarget(d, parseOwner(r.owner));
            if (o) {
                const add = r.recovered != null ? (r.held | 0) - (r.recovered | 0) : (r.held | 0);
                if (add) setAtRest(d, o, atRest(d, o) + add, now);
                n++;
            }
            if (all) d.run('DELETE FROM bank_leases WHERE lease_id = ?', r.lease_id);
            else d.run('UPDATE bank_leases SET recovered = held, recovered_at = ? WHERE lease_id = ?', now, r.lease_id);
        }
        // written back a day ago and never heard from again
        if (!all) d.run('DELETE FROM bank_leases WHERE recovered_at IS NOT NULL AND recovered_at <= ?', now - DAY);
        return n;
    });
}

module.exports = { CAP, STALE_MS, NEW_ACCOUNT_MS, parseOwner, peek, credit, checkout, checkpoint, release, recoverStale, claimGuest };
