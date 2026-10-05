// POST /api/funnel: one step of a page visit, from client/funnel.js.
//
// Body: {v, e, t, g?, d, s?, f?, a?}
//   v  the visit id (32 hex, made by the page)     e  load | home | ready |
//   t  ms (what it means depends on e, see funnel.js)   play | control | min1 | leave
//   g  the guest id                d  'desktop' | 'mobile'
//   s  the site this browser first came from (a site name)
//   f  1 on this browser's first visit             a  1 when the game started itself
// -> 204, also for anything it ignores (the page never retries a stat).
//
// Guests and accounts alike (the account comes from the session cookie,
// never the body). 60 a minute per IP; a visit sends about 6.
'use strict';

const funnel = require('../funnel');

function postFunnel(ctx) {
    ctx.charge(['funnel', 'ip:' + ctx.ipKey]);
    const ev = funnel.clean(ctx.body);
    if (ev) {
        const a = ctx.auth();
        funnel.record(ev, a ? a.user.id : null, ctx.now);
    }
    ctx.noContent();
}

function register(router) {
    router.add('POST', '/api/funnel', postFunnel);
}

module.exports = { register };
