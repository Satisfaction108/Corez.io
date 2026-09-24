// Friends: GET /api/friends and POST /api/friends/{request,respond,cancel,
// remove,block,unblock}. Accounts only. userId in bodies and responses is
// the public DW- id. The rules live in ../friends.js; live updates go out
// through ./events.js, and block changes reach the game over the bus
// ({t:'blocksChanged', userId}) so in-game chat filtering follows at once.
'use strict';

const friends = require('../friends');
const users = require('../users');
const bus = require('../bus');
const events = require('./events');
const { str } = require('../http');

function byPublic(v) {
    return users.byPublicId(str(v, 32));
}

function getFriends(ctx) {
    const a = ctx.requireAuth();
    ctx.json(200, events.listsView(a.user.id));
}

function blocksChanged(...ids) {
    for (const id of ids) {
        try { bus.toGame({ t: 'blocksChanged', userId: id }); } catch (e) { /* game gone */ }
    }
}

// {status:'pending'|'accepted', user:{userId, username, rank}, friend?:FriendView}
function postRequest(ctx) {
    const a = ctx.requireAuth();
    ctx.limit('friendRequest', a.user.id);
    const me = a.user;
    const r = friends.request(me.id, str(ctx.body.username, 32), Date.now());
    const u = r.user;
    if (r.notify && r.notify.type === 'friendRequest') {
        events.push(u.id, 'friendRequest', { userId: me.public_id, username: me.username, at: r.at, rank: friends.rankLite(me) });
    } else if (r.notify && r.notify.type === 'friendAccepted') {
        events.push(u.id, 'friendAccepted', events.friendView({ ...me, _since: r.since }));
    }
    const out = { status: r.status, user: { userId: u.public_id, username: u.username, rank: friends.rankLite(u) } };
    if (r.status === 'accepted') out.friend = events.friendView({ ...u, _since: r.since });
    ctx.json(200, out);
}

// {userId, accept} -> {status:'accepted'|'declined', friend?}
function postRespond(ctx) {
    const a = ctx.requireAuth();
    const me = a.user;
    const r = friends.respond(me.id, byPublic(ctx.body.userId), ctx.body.accept === true, Date.now());
    const out = { status: r.status };
    if (r.status === 'accepted') {
        out.friend = events.friendView({ ...r.user, _since: r.since });
        events.push(r.user.id, 'friendAccepted', events.friendView({ ...me, _since: r.since }));
    }
    ctx.json(200, out);
}

function postCancel(ctx) {
    const a = ctx.requireAuth();
    const r = friends.cancel(a.user.id, byPublic(ctx.body.userId));
    if (!r.silent) events.push(r.user.id, 'friendRequestCanceled', { userId: a.user.public_id });
    ctx.json(200, { ok: true });
}

function postRemove(ctx) {
    const a = ctx.requireAuth();
    const r = friends.remove(a.user.id, byPublic(ctx.body.userId));
    events.push(r.user.id, 'friendRemoved', { userId: a.user.public_id });
    ctx.json(200, { ok: true });
}

// {userId} or {username} -> {blocked:{userId, username, at}}
function postBlock(ctx) {
    const a = ctx.requireAuth();
    ctx.limit('social', a.user.id);
    const b = ctx.body;
    const target = b.userId != null && b.userId !== '' ? byPublic(b.userId) : users.byUsername(str(b.username, 32));
    const r = friends.block(a.user.id, target, Date.now());
    if (r.wasFriend) events.push(r.user.id, 'friendRemoved', { userId: a.user.public_id });
    if (r.hadOutgoing) events.push(r.user.id, 'friendRequestCanceled', { userId: a.user.public_id });
    blocksChanged(a.user.id, r.user.id);
    ctx.json(200, { blocked: { userId: r.user.public_id, username: r.user.username, at: r.at } });
}

function postUnblock(ctx) {
    const a = ctx.requireAuth();
    ctx.limit('social', a.user.id);
    const r = friends.unblock(a.user.id, byPublic(ctx.body.userId));
    blocksChanged(a.user.id, r.user.id);
    ctx.json(200, { ok: true });
}

function register(router) {
    router.add('GET', '/api/friends', getFriends);
    router.add('POST', '/api/friends/request', postRequest);
    router.add('POST', '/api/friends/respond', postRespond);
    router.add('POST', '/api/friends/cancel', postCancel);
    router.add('POST', '/api/friends/remove', postRemove);
    router.add('POST', '/api/friends/block', postBlock);
    router.add('POST', '/api/friends/unblock', postUnblock);
}

module.exports = { register };
