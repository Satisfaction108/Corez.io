// GET /api/invite: your invite link, how many friends counted and which
// rewards are unlocked (referrals.summary). Pending invites of yours are
// checked first, so the panel never shows a friend as waiting when they
// already qualify.
'use strict';

const referrals = require('../referrals');

function getInvite(ctx) {
    const a = ctx.requireAuth();
    ctx.limit('invite', 'u:' + a.user.id);
    try { referrals.evaluateFor(a.user.id, ctx.now); } catch (e) {
        console.error('[accounts] invite check failed: ' + ((e && e.stack) || e));
    }
    ctx.json(200, referrals.summary(a.user.id, Date.now()));
}

function register(router) {
    router.add('GET', '/api/invite', getInvite);
}

module.exports = { register };
