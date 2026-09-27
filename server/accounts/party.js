// Duo parties: main thread only, all in memory (parties are ephemeral, a
// restart simply empties them). routes/party.js wraps this for HTTP and
// pushes the live events; the duo game server learns about a party only
// through the signed ticket a member brings (partyTicket.js).
//
// A party is at most two members. Members are keyed by a member key (mk):
//   'u:<internal user id>'  an account (identified by its session cookie)
//   'g:<random>'            a guest, identified by a bearer token the server
//                           minted for this tab (sent back in X-Party-Guest)
// Every party has a short join code, so guests (and anyone else) can team
// up without accounts. Accounts can also invite an online friend who is on
// the menu; the invite lives 60 s.
//
// Liveness: a guest member who stops polling (tab closed) for 45 s is
// dropped; an account member who has been offline for 60 s is dropped. A
// member in the duo raid (the game server says so over the bus) is never
// dropped while playing.
//
// Everything that changes a party calls hooks.changed(party, why, extra), and
// the route layer fans that out. Rules that need the database (friends,
// blocks, presence) come in through hooks too, so tests can stub them.
'use strict';

const nodeCrypto = require('crypto');

const MAX_MEMBERS = 2;
const INVITE_MS = 60 * 1000;
const GUEST_IDLE_MS = 45 * 1000;
const ACCOUNT_IDLE_MS = 60 * 1000;
const GUEST_TOKEN_IDLE_MS = 6 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0, 1
const CODE_LEN = 5;
const MAX_PARTIES = 20000;
const MAX_GUESTS = 50000;
const MAX_INVITES_PER_TARGET = 5;

class PartyError extends Error {
    constructor(status, code, message) {
        super(message || code);
        this.status = status;
        this.code = code;
    }
}
const fail = (status, code, message) => { throw new PartyError(status, code, message); };

const hooks = {
    now: () => Date.now(),
    changed() {},               // (party, why, extra) - a party's view moved
    inviteGone() {},            // (invite, reason)   - an invite ended unanswered
    isOnline: () => true,       // (userId)           - presence
};

const parties = new Map();      // pid -> party
const byMember = new Map();     // mk -> pid
const byCode = new Map();       // code -> pid
const guests = new Map();       // sha256(token) -> {mk, name, at}
const invites = new Map();      // inviteId -> invite

function setHooks(h) { Object.assign(hooks, h || {}); }
function now() { return hooks.now(); }

function randomId(bytes = 12) { return nodeCrypto.randomBytes(bytes).toString('base64url'); }
function tokenHash(t) { return nodeCrypto.createHash('sha256').update(String(t)).digest('base64url'); }

function newCode() {
    for (let tries = 0; tries < 50; tries++) {
        const b = nodeCrypto.randomBytes(CODE_LEN);
        let s = '';
        for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
        if (!byCode.has(s)) return s;
    }
    fail(503, 'busy', 'Couldn’t make a party code. Try again.');
}

// What people type: any case, spaces or dashes. Codes never use I, O, 0
// or 1, so a look-alike typo can't land in somebody else's party.
function normCode(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[\s-]/g, '').slice(0, 12);
}

// ---- guests ----

function cleanName(name) {
    let s = String(name == null ? '' : name).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > 16) s = chars.slice(0, 16).join('').trim();
    return s || 'Guest';
}

// -> {actor, token}: a fresh guest identity for this tab
function newGuest(name) {
    if (guests.size >= MAX_GUESTS) sweepGuests(true);
    const token = randomId(24);
    const g = { mk: 'g:' + randomId(12), name: cleanName(name), at: now() };
    guests.set(tokenHash(token), g);
    return { token, actor: guestActor(g) };
}

function guestActor(g) {
    return { mk: g.mk, userId: 0, publicId: null, name: g.name, guest: true };
}

// -> actor or null
function guestByToken(token, name) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
    const g = guests.get(tokenHash(token));
    if (!g) return null;
    g.at = now();
    if (name != null && String(name).trim()) {
        const n = cleanName(name);
        if (n !== g.name) {
            g.name = n;
            const p = partyOf(g.mk);
            const m = p && memberOf(p, g.mk);
            if (m && m.name !== n) { m.name = n; hooks.changed(p, 'rename'); }
        }
    }
    return guestActor(g);
}

function sweepGuests(force = false) {
    const t = now();
    for (const [h, g] of guests) {
        if (byMember.has(g.mk)) continue;
        if (force || t - g.at > GUEST_TOKEN_IDLE_MS) guests.delete(h);
    }
}

// ---- lookups ----

function partyOf(mk) {
    const pid = byMember.get(mk);
    return pid ? parties.get(pid) || null : null;
}
function memberOf(p, mk) { return p ? p.members.find(m => m.mk === mk) || null : null; }
function mateOf(p, mk) { return p ? p.members.find(m => m.mk !== mk) || null : null; }
function byId(pid) { return parties.get(pid) || null; }
function userInParty(userId) { return partyOf('u:' + userId); }

function memberFrom(actor, t) {
    return { mk: actor.mk, userId: actor.userId | 0, publicId: actor.publicId || null, name: actor.name || 'Guest', guest: !!actor.guest, joinedAt: t, seenAt: t, playing: 0 };
}

function stateOf(m) {
    if (m.playing) return 'playing';
    if (!m.guest && m.userId && !hooks.isOnline(m.userId)) return 'away';
    return 'menu';
}

// The party as one member sees it.
function view(p, forMk) {
    if (!p) return null;
    return {
        id: p.id,
        code: p.code,
        full: p.members.length >= MAX_MEMBERS,
        leader: p.leader === forMk,
        members: p.members.map(m => ({
            name: m.name,
            userId: m.publicId,
            you: m.mk === forMk,
            leader: m.mk === p.leader,
            guest: !!m.guest,
            state: stateOf(m),
        })),
        // ago: how long since Play was pressed (the client follows only fresh ones)
        launch: p.launch ? { seq: p.launch.seq, at: p.launch.at, ago: Math.max(0, now() - p.launch.at), by: (memberOf(p, p.launch.by) || {}).name || '', byYou: p.launch.by === forMk } : null,
        pending: [...invites.values()].filter(iv => iv.pid === p.id && iv.exp > now()).map(iv => ({ id: iv.id, to: iv.toName, exp: iv.exp })),
        createdAt: p.createdAt,
    };
}

function invitesFor(userId) {
    const t = now();
    return [...invites.values()].filter(iv => iv.toUserId === userId && iv.exp > t)
        .map(iv => ({ id: iv.id, from: { userId: iv.fromPublicId, username: iv.fromName }, at: iv.at, exp: iv.exp }));
}

// ---- mutations ----

function makeParty(actor) {
    if (parties.size >= MAX_PARTIES) fail(503, 'busy', 'Too many parties right now. Try again soon.');
    const t = now();
    const p = { id: randomId(9), code: newCode(), leader: actor.mk, members: [memberFrom(actor, t)], createdAt: t, launch: null };
    parties.set(p.id, p);
    byCode.set(p.code, p.id);
    byMember.set(actor.mk, p.id);
    return p;
}

// Already in one: that one. -> party
function create(actor) {
    const cur = partyOf(actor.mk);
    if (cur) { touch(actor.mk); return cur; }
    const p = makeParty(actor);
    hooks.changed(p, 'create');
    return p;
}

// Leaves a party of one silently (you can't be "in" two). A two-person
// party must be left on purpose first.
function freeUp(actor) {
    const cur = partyOf(actor.mk);
    if (!cur) return;
    if (cur.members.length >= MAX_MEMBERS) fail(409, 'already_in_party', 'You’re already in a party. Leave it first.');
    removeMember(cur, actor.mk, 'left');
}

function addMember(p, actor, why) {
    p.members.push(memberFrom(actor, now()));
    byMember.set(actor.mk, p.id);
    // your pending invites to other people's parties are moot now
    for (const iv of [...invites.values()]) {
        if (actor.userId && iv.toUserId === actor.userId) endInvite(iv, 'joined');
    }
    if (p.members.length >= MAX_MEMBERS) {
        for (const iv of [...invites.values()]) if (iv.pid === p.id) endInvite(iv, 'full');
    }
    hooks.changed(p, why, { who: actor.name });
}

// hooks.blocked(userIdA, userIdB) -> true stops two accounts teaming up by code
function joinByCode(actor, code, opts = {}) {
    const c = normCode(code);
    if (!c || c.length !== CODE_LEN) fail(400, 'bad_code', 'Party codes are 5 letters.');
    const pid = byCode.get(c);
    const p = pid ? parties.get(pid) : null;
    if (!p) fail(404, 'no_party', 'No party with that code.');
    if (memberOf(p, actor.mk)) { touch(actor.mk); return p; }
    if (p.members.length >= MAX_MEMBERS) fail(409, 'party_full', 'That party’s already full.');
    if (opts.blocked && actor.userId && p.members.some(m => m.userId && opts.blocked(actor.userId, m.userId))) {
        fail(403, 'cant_join', 'You can’t join that party.');
    }
    freeUp(actor);
    addMember(p, actor, 'join');
    return p;
}

// An account invites a friend (the route checked friendship, blocks and
// presence). -> {party, invite, fresh}
function invite(actor, target) {
    if (!actor.userId) fail(401, 'unauthorized', 'Log in to invite friends.');
    if (!target || !target.userId) fail(404, 'user_not_found', 'Nobody’s called that.');
    if (target.userId === actor.userId) fail(400, 'self', 'That’s you lol');
    const theirs = userInParty(target.userId);
    let p = partyOf(actor.mk);
    if (theirs && p && theirs === p) fail(409, 'already_together', 'You’re already in a party together.');
    if (theirs && theirs.members.length >= MAX_MEMBERS) fail(409, 'in_party', target.name + ' is already in a party.');
    if (p && p.members.length >= MAX_MEMBERS) fail(409, 'party_full', 'Your party’s full. Two per duo.');
    if (!p) { p = makeParty(actor); hooks.changed(p, 'create'); }
    const t = now();
    let iv = [...invites.values()].find(x => x.pid === p.id && x.toUserId === target.userId);
    const fresh = !iv;
    if (!iv) {
        const already = [...invites.values()].filter(x => x.toUserId === target.userId);
        if (already.length >= MAX_INVITES_PER_TARGET) endInvite(already.sort((a, b) => a.at - b.at)[0], 'replaced');
        iv = { id: randomId(9), pid: p.id, fromMk: actor.mk, fromUserId: actor.userId, fromPublicId: actor.publicId, fromName: actor.name, toUserId: target.userId, toName: target.name, at: t, exp: t + INVITE_MS };
        invites.set(iv.id, iv);
    } else {
        iv.at = t;
        iv.exp = t + INVITE_MS;
    }
    touch(actor.mk);
    hooks.changed(p, 'invite');
    return { party: p, invite: iv, fresh };
}

function endInvite(iv, reason) {
    if (!invites.has(iv.id)) return;
    invites.delete(iv.id);
    hooks.inviteGone(iv, reason);
}

// -> {party|null, invite}
function respond(actor, inviteId, accept) {
    const iv = invites.get(String(inviteId || ''));
    if (!iv || !actor.userId || iv.toUserId !== actor.userId) fail(404, 'invite_gone', 'That invite’s gone.');
    if (iv.exp <= now()) { endInvite(iv, 'expired'); fail(410, 'invite_gone', 'That invite ran out. Ask for a new one.'); }
    invites.delete(iv.id);
    const p = parties.get(iv.pid);
    if (!accept) {
        if (p) hooks.changed(p, 'declined', { who: actor.name, toUserId: iv.fromUserId });
        return { party: null, invite: iv };
    }
    if (!p || !memberOf(p, iv.fromMk)) fail(410, 'invite_gone', 'They left that party.');
    if (memberOf(p, actor.mk)) return { party: p, invite: iv };
    if (p.members.length >= MAX_MEMBERS) fail(409, 'party_full', 'That party filled up.');
    freeUp(actor);
    addMember(p, actor, 'join');
    return { party: p, invite: iv };
}

// The inviter takes one back.
function cancelInvite(actor, inviteId) {
    const iv = invites.get(String(inviteId || ''));
    if (!iv || iv.fromMk !== actor.mk) return false;
    endInvite(iv, 'canceled');
    const p = parties.get(iv.pid);
    if (p) hooks.changed(p, 'invite');
    return true;
}

function removeMember(p, mk, why) {
    const i = p.members.findIndex(m => m.mk === mk);
    if (i < 0) return;
    const [gone] = p.members.splice(i, 1);
    byMember.delete(mk);
    for (const iv of [...invites.values()]) if (iv.pid === p.id && iv.fromMk === mk) endInvite(iv, 'left');
    if (!p.members.length) {
        parties.delete(p.id);
        byCode.delete(p.code);
        for (const iv of [...invites.values()]) if (iv.pid === p.id) endInvite(iv, 'left');
        hooks.changed(p, 'disband', { gone, empty: true });
        return;
    }
    if (p.leader === mk) p.leader = p.members[0].mk;
    p.launch = null;
    hooks.changed(p, why, { gone, who: gone.name });
}

function leave(actor) {
    const p = partyOf(actor.mk);
    if (!p) return null;
    removeMember(p, actor.mk, 'left');
    return p;
}

// "Play" pressed in a party: the mate's menu follows (launch.seq moves).
function launch(actor) {
    const p = partyOf(actor.mk);
    if (!p) fail(404, 'no_party', 'You’re not in a party.');
    p.launch = { seq: ((p.launch && p.launch.seq) | 0) + 1, at: now(), by: actor.mk };
    touch(actor.mk);
    hooks.changed(p, 'launch', { by: actor.name });
    return p;
}

function touch(mk) {
    const p = partyOf(mk);
    const m = p && memberOf(p, mk);
    if (m) m.seenAt = now();
}

// The duo game server: {t:'duoJoin'|'duoLeave', mk}
function onGameMessage(msg) {
    if (!msg || typeof msg.mk !== 'string') return;
    const p = partyOf(msg.mk);
    const m = p && memberOf(p, msg.mk);
    if (!m) return;
    const was = !!m.playing;
    if (msg.t === 'duoJoin') m.playing = now();
    else if (msg.t === 'duoLeave') { m.playing = 0; m.seenAt = now(); }
    else return;
    if (was !== !!m.playing) hooks.changed(p, msg.t === 'duoJoin' ? 'playing' : 'back');
}

function sweep() {
    const t = now();
    for (const iv of [...invites.values()]) if (iv.exp <= t) endInvite(iv, 'expired');
    for (const p of [...parties.values()]) {
        for (const m of p.members.slice()) {
            if (m.playing) continue;
            const idle = m.guest ? t - m.seenAt > GUEST_IDLE_MS
                : !hooks.isOnline(m.userId) && t - m.seenAt > ACCOUNT_IDLE_MS;
            if (idle) removeMember(p, m.mk, 'timeout');
        }
    }
    sweepGuests(false);
}

let timer = null;
function start() {
    if (timer) return;
    timer = setInterval(() => { try { sweep(); } catch (e) { console.error('[party] sweep failed: ' + ((e && e.stack) || e)); } }, 5000);
    if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

// Tests only.
function reset() { parties.clear(); byMember.clear(); byCode.clear(); guests.clear(); invites.clear(); }

module.exports = {
    PartyError, MAX_MEMBERS, INVITE_MS, GUEST_IDLE_MS, ACCOUNT_IDLE_MS, CODE_LEN,
    setHooks, newGuest, guestByToken, cleanName, normCode,
    partyOf, memberOf, mateOf, byId, userInParty, view, invitesFor,
    create, joinByCode, invite, respond, cancelInvite, leave, launch, touch, onGameMessage, sweep, start, stop, reset,
    _counts: () => ({ parties: parties.size, guests: guests.size, invites: invites.size, members: byMember.size }),
};
