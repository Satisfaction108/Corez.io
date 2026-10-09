// The daily rewards track and push opt-in, for accounts and guests alike.
//
// POST /api/daily          {guestId?}  -> retention.status() + push:{on, key, subscribed}
//                                         (also notes the visit)
// POST /api/daily/claim    {guestId?}  -> {claimed, balanceMilli, status}
// POST /api/push/subscribe {subscription:{endpoint, keys:{p256dh, auth}}, guestId?, daily?, events?}
//                                      -> {ok:true}
// POST /api/push/unsubscribe {endpoint} -> {ok:true}   (always, no oracle)
//
// Logged in wins; otherwise the browser's guest id (32 hex, the same one the
// socket sends in 'GI'). POST even for reads, so the guest id never sits in
// a URL or an access log. An account made in the last day that sends the
// guest id of the browser it was made on takes over that guest's track
// retention.adoptGuest), items and gemdust owed included
//
// Limits: 'daily' per IP for status + claim, 'dailyClaim' per owner,
// 'dailyNew' per IP for brand new guest tracks (so a script making up guest
// ids can't farm day 1), 'push' per IP for subscribe / unsubscribe.
'use strict';

const retention = require('../retention');
const push = require('../push');
const webpush = require('../webpush');
const guests = require('../guests');
const users = require('../users');
const { HttpError } = require('../http');

function ownerOf(ctx) {
    const a = ctx.auth();
    if (a) {
        if (users.isBanned(a.user, ctx.now)) throw new HttpError(403, 'banned', 'This account is banned.');
        return { kind: 'a', id: a.user.id, user: a.user };
    }
    const g = ctx.body && ctx.body.guestId;
    if (guests.valid(g)) return { kind: 'g', id: g };
    throw new HttpError(400, 'no_owner', 'Something went wrong. Please refresh and try again.');
}

// a new account sending its browser's guest id: bring the guest track over
function maybeAdopt(ctx, owner) {
    if (owner.kind !== 'a') return null;
    const g = ctx.body && ctx.body.guestId;
    if (!guests.valid(g)) return null;
    if (!(owner.user.created_at >= ctx.now - retention.NEW_ACCOUNT_MS)) return null;
    const r = retention.adoptGuest(owner.id, g, ctx.now);
    return r.moved ? r : null;
}

function pushInfo(owner) {
    const on = push.enabled();
    return { on, key: on ? webpush.publicKey() : '', subscribed: on ? push.countFor(owner) > 0 : false };
}

function postStatus(ctx) {
    ctx.limit('daily', ctx.ipKey);
    const owner = ownerOf(ctx);
    const adopted = maybeAdopt(ctx, owner);
    const st = retention.status(owner, ctx.now, { touch: true });
    ctx.json(200, { ...st, adoptedNow: adopted ? { items: adopted.items, dustMilli: adopted.dustMilli | 0 } : null, push: pushInfo(owner) });
}

function postClaim(ctx) {
    ctx.limit('daily', ctx.ipKey);
    const owner = ownerOf(ctx);
    ctx.limit('dailyClaim', retention.ownerKey(owner));
    maybeAdopt(ctx, owner);
    const r = retention.claim(owner, ctx.now, {
        ip: ctx.ip,
        // only brand new guest tracks count toward the per-IP cap
        onNewTrack: owner.kind === 'g' ? () => ctx.limit('dailyNew', ctx.ipKey) : null,
    });
    ctx.json(200, { ...r, push: pushInfo(owner) });
}

function postSubscribe(ctx) {
    ctx.limit('push', ctx.ipKey);
    if (!push.enabled()) throw new HttpError(503, 'push_off', 'Pings are turned off right now.');
    const owner = ownerOf(ctx);
    const b = ctx.body || {};
    const r = push.subscribe(owner, b.subscription, { daily: b.daily !== false, events: b.events !== false }, ctx.now);
    if (!r.ok) throw new HttpError(400, r.code, "This browser doesn't support pings.");
    ctx.json(200, { ok: true });
}

function postUnsubscribe(ctx) {
    ctx.limit('push', ctx.ipKey);
    const ep = ctx.body && typeof ctx.body.endpoint === 'string' ? ctx.body.endpoint : '';
    if (ep) push.unsubscribe(ep);
    ctx.json(200, { ok: true });
}

function register(router) {
    router.add('POST', '/api/daily', postStatus);
    router.add('POST', '/api/daily/claim', postClaim);
    router.add('POST', '/api/push/subscribe', postSubscribe);
    router.add('POST', '/api/push/unsubscribe', postUnsubscribe);
}

module.exports = { register };
