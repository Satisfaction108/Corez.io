'use strict';

const levels = require('../levels');
const guests = require('../guests');
const users = require('../users');
const { HttpError } = require('../http');

function postLevels(ctx) {
    ctx.limit('levels', ctx.ipKey);
    const a = ctx.auth();
    const g = ctx.body && ctx.body.guestId;
    let owner, adoptedNow = null;
    if (a) {
        if (users.isBanned(a.user, ctx.now)) throw new HttpError(403, 'banned', 'This account is banned.');
        owner = { kind: 'a', id: a.user.id };
        if (guests.valid(g)) {
            const r = levels.adoptGuest(a.user.id, g, ctx.now);
            if (r.moved) adoptedNow = { level: r.level, from: r.from, xp: r.guestXp, left: r.left, ups: r.ups, dustMilli: r.dustMilli };
        }
    } else if (guests.valid(g)) owner = { kind: 'g', id: g };
    else throw new HttpError(400, 'no_owner', 'Something went wrong. Please refresh and try again.');
    ctx.json(200, { ...levels.status(owner, ctx.now), adoptedNow });
}

function register(router) {
    router.add('POST', '/api/levels', postLevels);
}

module.exports = { register };
