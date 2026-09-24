// Account settings: /api/account/*. Every route needs a live session.
'use strict';

const crypto = require('../crypto');
const db = require('../db');
const names = require('../names');
const sessions = require('../sessions');
const users = require('../users');
const bus = require('../bus');
const { HttpError, str } = require('../http');

const PW_MAX = 1024;

// Charged before the (slow) check and handed back when the password is
// right, so parallel wrong guesses count while they are still hashing.
async function checkPassword(ctx, user, password) {
    const charge = ctx.charge(['passwordFail', user.id]);
    let ok;
    try {
        ok = await crypto.verifyPassword(password, user.password_hash);
    } catch (e) {
        charge.refund();
        throw e;
    }
    if (ok) charge.refund();
    return ok;
}

// The gate for sensitive changes: the current password, or a fresh
// re-auth (password or Discord login / Discord re-auth in the last 10 min).
// Password accounts get 401 bad_password; Discord-only ones 403
// reauth_required, which sends the client through /auth/discord/start?mode=reauth.
async function requireCredential(ctx, a, currentPassword) {
    const pw = str(currentPassword, PW_MAX);
    if (pw && a.user.password_hash) {
        if (await checkPassword(ctx, a.user, pw)) return;
        throw new HttpError(401, 'bad_password', 'Wrong password. Try again!');
    }
    if (sessions.isFresh(a.session, ctx.now)) return;
    if (a.user.password_hash) throw new HttpError(401, 'bad_password', 'Enter your current password.');
    throw new HttpError(403, 'reauth_required', 'Quick Discord check first, please!');
}

function cooldown(availableAt, now) {
    const retryAfter = Math.max(1, Math.ceil((availableAt - now) / 1000));
    return new HttpError(429, 'cooldown', 'You can change your name again later.', { availableAt, retryAfter }, { 'Retry-After': String(retryAfter) });
}

function begin(ctx) {
    const a = ctx.requireAuth();
    ctx.limit('accountWrite', a.user.id);
    return a;
}

async function changeUsername(ctx) {
    const a = begin(ctx);
    const username = str(ctx.body.username, 64).trim();
    const v = names.validateUsername(username);
    if (!v.ok) throw new HttpError(400, 'invalid_username', v.message, { reason: v.reason });
    if (username === a.user.username) return ctx.json(200, { user: users.toPublic(a.user, ctx.now) });
    const next = users.nextRenameAt(a.user);
    if (next > ctx.now) throw cooldown(next, ctx.now);
    await requireCredential(ctx, a, ctx.body.currentPassword);
    const r = users.rename(a.user.id, username, { now: Date.now(), ip: ctx.ip });
    if (!r.ok) {
        if (r.code === 'cooldown') throw cooldown(r.availableAt, Date.now());
        if (r.code === 'username_taken') {
            throw new HttpError(409, 'username_taken', r.reason === 'held'
                ? 'Someone used that name recently. Try another!'
                : "That name's taken. Try another!", { reason: r.reason });
        }
        throw new HttpError(404, 'not_found', "Couldn't find that account.");
    }
    ctx.json(200, { user: users.toPublic(r.user) });
}

async function changePassword(ctx) {
    const a = begin(ctx);
    const newPassword = str(ctx.body.newPassword, PW_MAX);
    const pv = names.validatePassword(newPassword, a.user.username);
    if (!pv.ok) throw new HttpError(400, 'weak_password', pv.message, { reason: pv.reason });
    const hadPassword = !!a.user.password_hash;
    if (hadPassword) {
        const current = str(ctx.body.currentPassword, PW_MAX);
        if (current) {
            if (!(await checkPassword(ctx, a.user, current))) throw new HttpError(401, 'bad_password', 'Wrong password. Try again!');
        } else if (!sessions.isFresh(a.session, ctx.now)) {
            throw new HttpError(401, 'bad_password', 'Enter your current password.');
        }
    } else if (!sessions.isFresh(a.session, ctx.now)) {
        // A first password on a Discord-only account also needs a fresh
        // Discord login: otherwise anything riding the session (a stolen
        // cookie, XSS) could set one, unlink Discord and own the account.
        throw new HttpError(403, 'reauth_required', 'Quick Discord check first, please!');
    }
    const hash = await crypto.hashPassword(newPassword);
    db.handle().tx(() => {
        users.setPassword(a.user.id, hash);
        sessions.revokeAllForUser(a.user.id, a.session.id);
        users.audit(a.user.id, hadPassword ? 'password_change' : 'password_set', null, { ip: ctx.ip });
    });
    ctx.noContent();
}

async function regenerateRecovery(ctx) {
    const a = begin(ctx);
    await requireCredential(ctx, a, ctx.body.currentPassword);
    const code = crypto.newRecoveryCode();
    const hash = await crypto.hashPassword(crypto.normalizeRecoveryCode(code));
    db.handle().tx(() => {
        users.setRecovery(a.user.id, hash);
        users.audit(a.user.id, 'recovery_regenerated', null, { ip: ctx.ip });
    });
    ctx.json(200, { recoveryCode: code });
}

async function unlinkDiscord(ctx) {
    const a = begin(ctx);
    if (!a.user.discord_id) return ctx.noContent();
    if (!a.user.password_hash) throw new HttpError(409, 'no_password', "Add a password before unlinking Discord, or you won't be able to log in.");
    const current = str(ctx.body.currentPassword, PW_MAX);
    if (!current || !(await checkPassword(ctx, a.user, current))) throw new HttpError(401, 'bad_password', 'Wrong password. Try again!');
    users.unlinkDiscord(a.user.id, { ip: ctx.ip });
    ctx.noContent();
}

async function deleteAccount(ctx) {
    const a = begin(ctx);
    if (ctx.body.confirm !== 'DELETE') throw new HttpError(400, 'confirm_required', 'Type DELETE to confirm.');
    await requireCredential(ctx, a, ctx.body.currentPassword);
    users.softDelete(a.user.id, { now: Date.now(), ip: ctx.ip });
    bus.toGame({ t: 'kick', userId: a.user.id, reason: 'This account was deleted. Thanks for playing!' });
    ctx.setCookie(sessions.clearCookie());
    ctx.noContent();
}

function listSessions(ctx) {
    const a = ctx.requireAuth();
    ctx.json(200, {
        sessions: sessions.listForUser(a.user.id, ctx.now).map(s => ({
            id: s.id,
            current: s.id === a.session.id,
            method: s.method,
            createdAt: s.created_at,
            lastSeenAt: s.last_seen_at,
            expiresAt: s.expires_at,
            ip: s.ip || null,
            userAgent: s.user_agent || null,
        })),
    });
}

function revokeSession(ctx) {
    const a = begin(ctx);
    const id = Number(ctx.body.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_request', 'Something went wrong. Refresh and try again.');
    if (!sessions.revokeForUser(a.user.id, id)) throw new HttpError(404, 'not_found', 'That device is already logged out.');
    if (id === a.session.id) ctx.setCookie(sessions.clearCookie());
    ctx.noContent();
}

function register(router) {
    router.add('POST', '/api/account/username', changeUsername);
    router.add('POST', '/api/account/password', changePassword);
    router.add('POST', '/api/account/recovery-code', regenerateRecovery);
    router.add('POST', '/api/account/discord/unlink', unlinkDiscord);
    router.add('POST', '/api/account/delete', deleteAccount);
    router.add('GET', '/api/account/sessions', listSessions);
    router.add('POST', '/api/account/sessions/revoke', revokeSession);
}

module.exports = { register, requireCredential, checkPassword };
