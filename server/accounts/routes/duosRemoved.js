'use strict';

const TEXT = 'Duos has been removed. Press Play to join a solo game.';

const POSTS = [
    '/api/party/create',
    '/api/party/join',
    '/api/party/invite',
    '/api/party/invite/cancel',
    '/api/party/respond',
    '/api/party/leave',
    '/api/party/launch',
    '/api/party/ticket',
];

function charge(ctx) {
    ctx.charge(['party', 'ip:' + ctx.ipKey]);
}

function getParty(ctx) {
    charge(ctx);
    ctx.json(200, { party: null, invites: [], you: null, removed: true, message: TEXT });
}

function leave(ctx) {
    charge(ctx);
    ctx.json(200, { party: null, removed: true, message: TEXT });
}

function gone(ctx) {
    charge(ctx);
    ctx.fail(410, 'duos_removed', TEXT);
}

function register(router) {
    const on = { alwaysOn: true };
    router.add('GET', '/api/party', getParty, on);
    for (const p of POSTS) router.add('POST', p, p === '/api/party/leave' ? leave : gone, on);
}

module.exports = { register, TEXT, POSTS };
