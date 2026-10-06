// Duo parties over HTTP (rules in ../party.js):
//   GET  /api/party                 {party, invites, you}
//   POST /api/party/create          {name?}            -> {party, guestToken?}
//   POST /api/party/join            {code, name?}      -> {party, guestToken?}
//   POST /api/party/invite          {userId}           -> {party, invite}      accounts only
//                                                         (or {party, merged:true} when they had invited you)
//   POST /api/party/invite/cancel   {id}               -> {party}
//   POST /api/party/respond         {id, accept}       -> {party}             accounts only
//   POST /api/party/leave           {}                 -> {party:null}
//   POST /api/party/launch          {fill?}            -> {party, ticket}     Play pressed: the mate follows
//   POST /api/party/ticket          {fill?}            -> {party, ticket}
//
// Guests are welcome: without a session the caller is a guest, identified by
// the X-Party-Guest token that create/join hand out (a random bearer token,
// kept per tab in sessionStorage). The routes stay up with accounts off
// (guest-only then) and are rate limited per IP either way.
//
// Live updates go to account members through /api/events:
//   party            {party, why, who}        your party changed (party null: you're out)
//   partyInvite      {id, from:{userId, username}, at, exp}
//   partyInviteGone  {id, reason}             expired / canceled / the party filled
// Guests poll GET /api/party instead (the menu does every 3 s in a party).
'use strict';

const party = require('../party');
const partyTicket = require('../partyTicket');
const { HttpError, str, bannedError } = require('../http');

let accounts = null;
function acc() { return accounts || (accounts = require('../index')); }

function events() { return require('./events'); }

const GUEST_HEADER = 'x-party-guest';

function asHttp(e) {
    if (e instanceof party.PartyError) return new HttpError(e.status, e.code, e.message);
    return e;
}

function wrap(fn) {
    return async (ctx) => {
        ctx.charge(['party', 'ip:' + ctx.ipKey]);
        try { await fn(ctx); } catch (e) { throw asHttp(e); }
    };
}

// The caller as a party actor. create: mint a guest identity if there is none.
// -> {actor, token?} | {actor:null}
function actorOf(ctx, create = false) {
    const a = ctx.accountsOn ? ctx.auth() : null;
    if (a) {
        if (acc().users.isBanned(a.user, Date.now())) throw bannedError(a.user);
        return { actor: { mk: 'u:' + a.user.id, userId: a.user.id, publicId: a.user.public_id, name: a.user.username, guest: false } };
    }
    const name = ctx.body && ctx.body.name != null ? str(ctx.body.name, 48) : null;
    const g = party.guestByToken(ctx.header(GUEST_HEADER), name);
    if (g) return { actor: g };
    if (!create) return { actor: null };
    const made = party.newGuest(name);
    return { actor: made.actor, token: made.token };
}

function need(ctx, create = false) {
    const r = actorOf(ctx, create);
    if (!r.actor) throw new HttpError(404, 'no_party', 'You’re not in a party.');
    return r;
}

function reply(ctx, r, extra) {
    const p = party.partyOf(r.actor.mk);
    const out = { party: party.view(p, r.actor.mk), ...(extra || {}) };
    if (r.token) out.guestToken = r.token;
    ctx.json(200, out);
}

function getParty(ctx) {
    const r = actorOf(ctx, false);
    if (!r.actor) return ctx.json(200, { party: null, invites: [], you: null });
    party.touch(r.actor.mk);
    const p = party.partyOf(r.actor.mk);
    ctx.json(200, {
        party: party.view(p, r.actor.mk),
        invites: r.actor.userId ? party.invitesFor(r.actor.userId) : [],
        you: { name: r.actor.name, guest: !!r.actor.guest },
    });
}

function postCreate(ctx) {
    const r = need(ctx, true);
    ctx.charge(['partyAct', r.actor.userId ? 'u:' + r.actor.userId : 'ip:' + ctx.ipKey]);
    party.create(r.actor);
    reply(ctx, r);
}

function blockedEitherWay(a, b) {
    try { return acc().friends.blockedEitherWay(a, b); } catch (e) { return false; }
}

function postJoin(ctx) {
    const r = need(ctx, true);
    ctx.charge(['partyAct', r.actor.userId ? 'u:' + r.actor.userId : 'ip:' + ctx.ipKey]);
    // wrong codes cost more than right ones: guessing a live code is the attack
    ctx.checkLimit('partyCode', ctx.ipKey);
    try {
        party.joinByCode(r.actor, str(ctx.body.code, 16), { blocked: blockedEitherWay });
    } catch (e) {
        if (e instanceof party.PartyError && (e.code === 'no_party' || e.code === 'bad_code')) ctx.limit('partyCode', ctx.ipKey);
        throw e;
    }
    reply(ctx, r);
}

function postInvite(ctx) {
    if (!ctx.accountsOn) throw new HttpError(503, 'accounts_unavailable', 'Invites need accounts, and they’re down rn. Share your party code instead!');
    const a = ctx.requireAuth();
    const A = acc();
    ctx.limit('partyInvite', a.user.id);
    const target = A.users.byPublicId(str(ctx.body.userId, 32));
    if (!target || target.deleted_at) throw new HttpError(404, 'user_not_found', 'Nobody’s called that.');
    if (target.id === a.user.id) throw new HttpError(400, 'self', 'That’s you lol');
    if (A.friends.blockedEitherWay(a.user.id, target.id)) throw new HttpError(403, 'cant_invite', 'You can’t invite them.');
    if (!A.friends.areFriends(a.user.id, target.id)) throw new HttpError(403, 'not_friends', 'You can only invite friends.');
    if (A.users.isBanned(target)) throw new HttpError(403, 'cant_invite', 'You can’t invite them.');
    const pr = A.presence.get(target.id, target.last_seen_at);
    if (pr.state === 'offline') throw new HttpError(409, 'offline', target.username + ' is offline.');
    // a friend in a raid gets the invite as an in-game card and joins after
    const actor = { mk: 'u:' + a.user.id, userId: a.user.id, publicId: a.user.public_id, name: a.user.username, guest: false };
    const res = party.invite(actor, { userId: target.id, name: target.username });
    // they had already invited you: you're in their party now (no second invite)
    if (res.merged) return reply(ctx, { actor }, { merged: true, with: target.username });
    events().push(target.id, 'partyInvite', { id: res.invite.id, from: { userId: a.user.public_id, username: a.user.username }, at: res.invite.at, exp: res.invite.exp });
    reply(ctx, { actor }, { invite: { id: res.invite.id, to: target.username, exp: res.invite.exp } });
}

function postInviteCancel(ctx) {
    const r = need(ctx, false);
    party.cancelInvite(r.actor, str(ctx.body.id, 32));
    reply(ctx, r);
}

function postRespond(ctx) {
    const a = ctx.requireAuth();
    const actor = { mk: 'u:' + a.user.id, userId: a.user.id, publicId: a.user.public_id, name: a.user.username, guest: false };
    party.respond(actor, str(ctx.body.id, 32), ctx.body.accept === true);
    reply(ctx, { actor });
}

function postLeave(ctx) {
    const r = actorOf(ctx, false);
    if (r.actor) {
        ctx.charge(['partyAct', r.actor.userId ? 'u:' + r.actor.userId : 'ip:' + ctx.ipKey]);
        party.leave(r.actor);
    }
    ctx.json(200, { party: null });
}

function ticketFor(actor, fill) {
    const p = party.partyOf(actor.mk);
    if (!p) return null;
    return partyTicket.sign({ pid: p.id, mk: actor.mk, mates: p.members.map(m => m.mk), n: actor.name, fill: fill !== false });
}

function postLaunch(ctx) {
    const r = need(ctx, false);
    party.launch(r.actor);
    reply(ctx, r, { ticket: ticketFor(r.actor, ctx.body.fill) });
}

function postTicket(ctx) {
    const r = need(ctx, false);
    party.touch(r.actor.mk);
    reply(ctx, r, { ticket: ticketFor(r.actor, ctx.body.fill) });
}

// ---- live fan-out ----

function onChanged(p, why, extra = {}) {
    const ev = events();
    for (const m of p.members) {
        if (!m.userId) continue;
        ev.push(m.userId, 'party', { party: party.view(p, m.mk), why, who: extra.who || '' });
    }
    // somebody who just left (or timed out) hears that they're out
    const gone = extra.gone;
    if (gone && gone.userId && why !== 'left') ev.push(gone.userId, 'party', { party: null, why, who: '' });
}

function onInviteGone(iv, reason) {
    const ev = events();
    ev.push(iv.toUserId, 'partyInviteGone', { id: iv.id, reason });
    const p = party.byId(iv.pid);
    const from = p && party.memberOf(p, iv.fromMk);
    if (from && from.userId && reason === 'expired') ev.push(from.userId, 'party', { party: party.view(p, from.mk), why: 'inviteExpired', who: iv.toName });
}

let started = false;
function start() {
    party.setHooks({
        now: () => Date.now(),
        changed: (p, why, extra) => { try { onChanged(p, why, extra); } catch (e) { console.error('[party] push failed: ' + ((e && e.stack) || e)); } },
        inviteGone: (iv, reason) => { try { onInviteGone(iv, reason); } catch (e) { /* stream gone */ } },
        isOnline: (userId) => { try { return acc().presence.isOnline(userId); } catch (e) { return true; } },
    });
    if (started) return;
    started = true;
    // the duo game server says who is in the raid right now
    acc().bus.onMain((serverId, msg) => {
        if (msg && (msg.t === 'duoJoin' || msg.t === 'duoLeave')) party.onGameMessage(msg);
    });
    party.start();
}

function register(router) {
    const on = { alwaysOn: true };
    router.add('GET', '/api/party', wrap(getParty), on);
    router.add('POST', '/api/party/create', wrap(postCreate), on);
    router.add('POST', '/api/party/join', wrap(postJoin), on);
    router.add('POST', '/api/party/invite', wrap(postInvite), on);
    router.add('POST', '/api/party/invite/cancel', wrap(postInviteCancel), on);
    router.add('POST', '/api/party/respond', wrap(postRespond), on);
    router.add('POST', '/api/party/leave', wrap(postLeave), on);
    router.add('POST', '/api/party/launch', wrap(postLaunch), on);
    router.add('POST', '/api/party/ticket', wrap(postTicket), on);
}

module.exports = { register, start, GUEST_HEADER };
