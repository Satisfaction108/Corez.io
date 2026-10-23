'use strict';

const friends = require('../friends');
const users = require('../users');
const presence = require('../presence');
const events = require('./events');
const { str, HttpError } = require('../http');

const CODE_RE = /^[A-Za-z0-9]{6}$/;
const INVITE_LIFE_MS = 10 * 60 * 1000;

function postInvite(ctx) {
    const a = ctx.requireAuth();
    const me = a.user;
    ctx.limit('teamInvite', me.id);
    const code = str(ctx.body.code, 16);
    if (!code || !CODE_RE.test(code)) throw new HttpError(400, 'bad_code', 'That invite has run out. Please try again.');
    const target = users.byPublicId(str(ctx.body.userId, 32));
    if (!target || target.deleted_at) throw new HttpError(404, 'user_not_found', 'We couldn’t find that player.');
    if (target.id === me.id) throw new HttpError(400, 'self', 'You can’t invite yourself.');
    if (friends.blockedEitherWay(me.id, target.id) || users.isBanned(target)) throw new HttpError(403, 'cant_invite', 'You can’t invite them.');
    if (!friends.areFriends(me.id, target.id)) throw new HttpError(403, 'not_friends', 'You can only invite your friends.');
    if (!presence.isOnline(target.id)) throw new HttpError(409, 'offline', target.username + ' isn’t online right now.');
    ctx.limit('teamInvitePair', me.id + ':' + target.id);
    const expiresAt = Date.now() + INVITE_LIFE_MS;
    const sent = events.push(target.id, 'teamInvite', {
        from: me.public_id,
        fromName: me.username,
        link: '/?team=' + code,
        expiresAt,
    });
    if (!sent) throw new HttpError(409, 'offline', target.username + ' can’t get invites right now. Try sending them the link instead.');
    ctx.json(200, { ok: true, to: target.username, expiresAt });
}

function register(router) {
    router.add('POST', '/api/team/invite', postInvite);
}

module.exports = { register };
