// Item Shop and Locker: /api/store/* and /api/locker/*. Accounts only
// (guests get 401); the logic and its rules live in ../store.js.
'use strict';

const store = require('../store');
const users = require('../users');
const events = require('./events');
const { str } = require('../http');

// Purchases, gifts and refunds share one 10-a-minute budget per account.
function moneyGate(ctx) {
    const a = ctx.requireAuth();
    ctx.limit('purchase', a.user.id);
    return a;
}

function getStore(ctx) {
    const a = ctx.requireAuth();
    ctx.json(200, store.storeView(a.user, Date.now()));
}

function postPurchase(ctx) {
    const a = moneyGate(ctx);
    const b = ctx.body;
    ctx.json(200, store.purchase(a.user.id, {
        itemId: str(b.itemId, 64),
        day: b.day,
        idempotencyKey: str(b.idempotencyKey, 128),
        color: b.color == null ? null : str(b.color, 16),
    }, { now: Date.now(), ip: ctx.ip }));
}

function postGift(ctx) {
    const a = moneyGate(ctx);
    const b = ctx.body;
    const r = store.gift(a.user.id, {
        itemId: str(b.itemId, 64),
        day: b.day,
        toUserId: str(b.toUserId, 32),
        idempotencyKey: str(b.idempotencyKey, 128),
        preset: b.preset,
    }, { now: Date.now(), ip: ctx.ip });
    ctx.json(200, r);
    if (!r.replayed) {
        const to = users.byPublicId(r.to && r.to.userId);
        if (to) events.push(to.id, 'gift', { purchaseId: r.purchaseId, itemId: r.itemId, preset: r.preset, from: { userId: a.user.public_id, username: a.user.username } });
    }
}

function postRefund(ctx) {
    const a = moneyGate(ctx);
    ctx.json(200, store.refund(a.user.id, ctx.body.purchaseId, { now: Date.now(), ip: ctx.ip }));
}

function getHistory(ctx) {
    const a = ctx.requireAuth();
    ctx.json(200, store.history(a.user.id, Date.now()));
}

function getLocker(ctx) {
    const a = ctx.requireAuth();
    ctx.json(200, store.lockerView(a.user));
}

function postEquip(ctx) {
    const a = ctx.requireAuth();
    ctx.limit('equip', a.user.id);
    const b = ctx.body;
    const itemId = b.itemId == null ? null : str(b.itemId, 64);
    ctx.json(200, store.equip(a.user.id, str(b.slot, 16), itemId, b.color == null ? null : str(b.color, 16), { now: Date.now(), ip: ctx.ip }));
}

function register(router) {
    router.add('GET', '/api/store', getStore);
    router.add('POST', '/api/store/purchase', postPurchase);
    router.add('POST', '/api/store/gift', postGift);
    router.add('POST', '/api/store/refund', postRefund);
    router.add('GET', '/api/store/history', getHistory);
    router.add('GET', '/api/locker', getLocker);
    router.add('POST', '/api/locker/equip', postEquip);
}

module.exports = { register };
