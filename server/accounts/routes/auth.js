// Session and sign-in routes: /api/config, /api/me and /api/auth/*.
'use strict';

const config = require('../config');
const crypto = require('../crypto');
const db = require('../db');
const names = require('../names');
const ratelimit = require('../ratelimit');
const sessions = require('../sessions');
const users = require('../users');
const bus = require('../bus');
const discordOAuth = require('./discordOAuth');
const { checkPassword } = require('./account');
const { HttpError, bannedError, str } = require('../http');

const PW_MAX = 1024;   // longer than any valid password; validatePassword reports too_long

function invalidUsername(v) {
    return new HttpError(400, 'invalid_username', v.message, { reason: v.reason });
}

function weakPassword(v) {
    return new HttpError(400, 'weak_password', v.message, { reason: v.reason });
}

function usernameTaken(reason) {
    return new HttpError(409, 'username_taken', reason === 'held'
        ? 'Someone used that name recently. Try another!'
        : "That name's taken. Try another!", { reason: reason || 'taken' });
}

async function newRecovery() {
    const code = crypto.newRecoveryCode();
    return { code, hash: await crypto.hashPassword(crypto.normalizeRecoveryCode(code)) };
}

function kick(userId, reason) {
    bus.toGame({ t: 'kick', userId, reason });
}

function getConfig(ctx) {
    ctx.json(200, {
        accounts: ctx.accountsOn,
        discordLogin: ctx.accountsOn && config.discordLogin,
        publicOrigin: config.publicOrigin,
    });
}

function getMe(ctx) {
    if (!ctx.accountsOn) return ctx.json(200, { user: null, pendingDiscord: null });
    const a = ctx.auth();
    const user = a && !users.isBanned(a.user, ctx.now) ? users.toPublic(a.user, ctx.now) : null;
    const pending = discordOAuth.readPending(ctx);
    ctx.json(200, {
        user,
        pendingDiscord: pending ? { name: pending.name, avatarUrl: users.discordAvatarUrl(pending.id, pending.avatar) } : null,
    });
}

// Runs `work` (the slow hashing + insert) with one 'signup' already charged
// to this IP, so parallel requests cannot all pass the cap while the first
// ones are still hashing. The charge is handed back unless an account came
// of it. work() -> users.create result.
async function withSignupCharge(ctx, work) {
    const charge = ctx.charge(['signup', ctx.ipKey]);
    let r;
    try {
        r = await work();
    } catch (e) {
        charge.refund();
        throw e;
    }
    if (!r.ok) charge.refund();
    return r;
}

async function signup(ctx) {
    ctx.limit('signupTry', ctx.ipKey);
    ctx.checkLimit('signup', ctx.ipKey);
    const username = str(ctx.body.username, 64).trim();
    const password = str(ctx.body.password, PW_MAX);
    const v = names.validateUsername(username);
    if (!v.ok) throw invalidUsername(v);
    const pv = names.validatePassword(password, username);
    if (!pv.ok) throw weakPassword(pv);
    const av = users.availability(username, null, ctx.now);
    if (!av.available) throw usernameTaken(av.reason);

    let recovery = null;
    const r = await withSignupCharge(ctx, async () => {
        const [passwordHash, rec] = await Promise.all([crypto.hashPassword(password), newRecovery()]);
        recovery = rec;
        return users.create({ username, passwordHash, recoveryHash: recovery.hash, now: Date.now() });
    });
    if (!r.ok) throw usernameTaken(r.reason);
    users.audit(r.user.id, 'signup', { method: 'password' }, { ip: ctx.ip });
    ctx.startSession(r.user, 'signup');
    ctx.json(201, { user: users.toPublic(r.user), recoveryCode: recovery.code });
}

async function login(ctx) {
    const username = str(ctx.body.username, 64).trim();
    const lc = username.toLowerCase();
    const password = str(ctx.body.password, PW_MAX);
    const pairKey = ctx.ipKey + '|' + lc;
    const user = users.byUsername(lc);
    // A browser this account has logged in from before skips the
    // per-username backoff, so strangers cannot lock the owner out on
    // purpose. The per-IP limits apply to everybody.
    const knownDevice = !!user && ctx.isKnownDevice(user.id);
    // Checked and charged before the password is: a locked-out pair fails
    // even when right, and parallel guesses count while still hashing.
    const charge = ctx.charge(['loginFail', pairKey], ['loginIpFail', ctx.ipKey], knownDevice ? null : ['loginUser', lc]);
    const locks = !ratelimit.check('loginFail', pairKey).ok;   // this attempt filled the window

    let ok;
    try {
        ok = user && user.password_hash
            ? await crypto.verifyPassword(password, user.password_hash)
            : await crypto.dummyVerify(password);
    } catch (e) {
        charge.refund();   // never checked (server busy): not an attempt
        throw e;
    }
    if (!ok) {
        // One audit row when a lockout starts, not one per failed attempt.
        if (user && locks) users.audit(user.id, 'login_locked', { window: '15m' }, { ip: ctx.ip, actor: 'system' });
        throw new HttpError(401, 'bad_credentials', 'Wrong username or password. Try again!');
    }
    charge.refund();
    ratelimit.clear('loginFail', pairKey);
    ratelimit.clear('loginUser', lc);
    if (users.isBanned(user, Date.now())) throw bannedError(user);
    ctx.startSession(user, 'password');
    users.touchSeen(user.id);
    ctx.json(200, { user: users.toPublic(users.byId(user.id)) });
}

function logout(ctx) {
    const token = ctx.cookies[config.cookies.session];
    if (token && ctx.accountsOn) sessions.revokeByToken(token);
    ctx.setCookie(sessions.clearCookie());
    ctx.noContent();
}

function logoutAll(ctx) {
    const a = ctx.auth();
    if (a) {
        const n = sessions.revokeAllForUser(a.user.id);
        users.audit(a.user.id, 'logout_all', { sessions: n }, { ip: ctx.ip });
        kick(a.user.id, 'You logged out.');
    }
    ctx.setCookie(sessions.clearCookie());
    ctx.noContent();
}

// Opens the 10-minute re-auth window (needed to link Discord) with the
// current password. Discord-only accounts re-auth through
// /auth/discord/start?mode=reauth instead.
async function reauth(ctx) {
    const a = ctx.requireAuth();
    if (!a.user.password_hash) throw new HttpError(403, 'reauth_required', 'Quick Discord check first, please!');
    const pw = str(ctx.body.currentPassword, PW_MAX);
    if (!pw) throw new HttpError(401, 'bad_password', 'Enter your current password.');
    if (!(await checkPassword(ctx, a.user, pw))) throw new HttpError(401, 'bad_password', 'Wrong password. Try again!');
    sessions.markReauth(a.session.id);
    ctx.noContent();
}

function usernameAvailable(ctx) {
    ctx.limit('nameCheck', ctx.ipKey);
    const name = String(ctx.query.get('name') || '').trim().slice(0, 64);
    const v = names.validateUsername(name);
    if (!v.ok) return ctx.json(200, { available: false, reason: v.reason });
    const a = ctx.auth();
    const av = users.availability(name, a ? a.user.id : null, ctx.now);
    ctx.json(200, av.available ? { available: true } : { available: false, reason: av.reason });
}

// The response's user.discord shows whatever Discord is linked, so an owner
// taking an account back can see (and unlink) one somebody else added.
async function recover(ctx) {
    const username = str(ctx.body.username, 64).trim();
    const lc = username.toLowerCase();
    const code = crypto.normalizeRecoveryCode(str(ctx.body.recoveryCode, 64));
    const newPassword = str(ctx.body.newPassword, PW_MAX);
    const user = users.byUsername(lc);
    // Charged up front like login; the per-username cap is skipped on a
    // browser this account has logged in from before.
    const knownDevice = !!user && ctx.isKnownDevice(user.id);
    const charge = ctx.charge(['recoverFail', ctx.ipKey], knownDevice ? null : ['recoverUser', lc]);

    let ok;
    try {
        const pv = names.validatePassword(newPassword, user ? user.username : username);
        if (!pv.ok) throw weakPassword(pv);
        ok = user && user.recovery_hash && code
            ? await crypto.verifyPassword(code, user.recovery_hash)
            : await crypto.dummyVerify(code || '');
    } catch (e) {
        charge.refund();
        throw e;
    }
    if (!ok) throw new HttpError(401, 'bad_recovery', "That username and recovery code don't match.");
    charge.refund();
    if (users.isBanned(user, Date.now())) throw bannedError(user);

    const [passwordHash, recovery] = await Promise.all([crypto.hashPassword(newPassword), newRecovery()]);
    const d = db.handle();
    const applied = d.tx(() => {
        // Only if the code we checked is still the stored one: two racing
        // requests with the same code cannot both win.
        if (!users.setRecovery(user.id, recovery.hash, user.recovery_hash)) return false;
        users.setPassword(user.id, passwordHash);
        sessions.revokeAllForUser(user.id);
        users.audit(user.id, 'recovery_used', null, { ip: ctx.ip });
        return true;
    });
    if (!applied) throw new HttpError(401, 'bad_recovery', "That username and recovery code don't match.");
    ratelimit.clear('recoverUser', lc);
    kick(user.id, 'Your account was recovered on another device. Log in again!');
    ctx.startSession(user, 'recovery');
    ctx.json(200, { user: users.toPublic(users.byId(user.id)), recoveryCode: recovery.code });
}

async function reset(ctx) {
    ctx.limit('reset', ctx.ipKey);
    const token = str(ctx.body.token, 200).trim();
    const newPassword = str(ctx.body.newPassword, PW_MAX);
    const user = users.peekResetToken(token, ctx.now);
    if (!user) throw new HttpError(400, 'invalid_token', "This reset link expired or doesn't work. Ask for a new one!");
    const pv = names.validatePassword(newPassword, user.username);
    if (!pv.ok) throw weakPassword(pv);
    if (users.isBanned(user, ctx.now)) throw bannedError(user);
    const passwordHash = await crypto.hashPassword(newPassword);
    const applied = db.handle().tx(() => {
        if (!users.consumeResetToken(token, Date.now())) return false;
        users.setPassword(user.id, passwordHash);
        sessions.revokeAllForUser(user.id);
        users.audit(user.id, 'password_reset', null, { ip: ctx.ip });
        return true;
    });
    if (!applied) throw new HttpError(400, 'invalid_token', "This reset link expired or doesn't work. Ask for a new one!");
    kick(user.id, 'Your password was changed. Log in again!');
    ctx.startSession(user, 'reset');
    ctx.json(200, { user: users.toPublic(users.byId(user.id)) });
}

// Finishes a Discord signup: the signed dw_pending cookie proves which
// Discord account this is; the body picks the username (and optionally a
// password).
async function discordComplete(ctx) {
    ctx.limit('discordDone', ctx.ipKey);
    const pending = discordOAuth.readPending(ctx);
    if (!pending) throw new HttpError(401, 'pending_expired', 'Your Discord login timed out. Log in with Discord again.');
    ctx.checkLimit('signup', ctx.ipKey);
    const username = str(ctx.body.username, 64).trim();
    const password = str(ctx.body.password, PW_MAX);
    const v = names.validateUsername(username);
    if (!v.ok) throw invalidUsername(v);
    if (password) {
        const pv = names.validatePassword(password, username);
        if (!pv.ok) throw weakPassword(pv);
    }
    const av = users.availability(username, null, ctx.now);
    if (!av.available) throw usernameTaken(av.reason);
    if (users.byDiscordId(pending.id)) {
        ctx.setCookie(discordOAuth.clearPendingCookie());
        throw new HttpError(409, 'discord_taken', 'That Discord already has a Dig Wars account. Just log in with Discord!');
    }

    let recovery = null;
    const r = await withSignupCharge(ctx, async () => {
        const [passwordHash, rec] = await Promise.all([password ? crypto.hashPassword(password) : null, newRecovery()]);
        recovery = rec;
        return users.create({
            username, passwordHash, recoveryHash: recovery.hash, now: Date.now(),
            discord: { id: pending.id, name: pending.name, avatar: pending.avatar },
        });
    });
    if (!r.ok) {
        if (r.code === 'discord_taken') throw new HttpError(409, 'discord_taken', 'That Discord already has a Dig Wars account.');
        throw usernameTaken(r.reason);
    }
    users.audit(r.user.id, 'signup', { method: 'discord', discordId: pending.id }, { ip: ctx.ip });
    ctx.setCookie(discordOAuth.clearPendingCookie());
    ctx.startSession(r.user, 'discord');
    ctx.json(201, { user: users.toPublic(r.user), recoveryCode: recovery.code });
}

function register(router) {
    router.add('GET', '/api/config', getConfig, { alwaysOn: true });
    router.add('GET', '/api/me', getMe, { alwaysOn: true });
    router.add('POST', '/api/auth/signup', signup);
    router.add('POST', '/api/auth/login', login);
    router.add('POST', '/api/auth/logout', logout, { alwaysOn: true });
    router.add('POST', '/api/auth/logout-all', logoutAll);
    router.add('POST', '/api/auth/reauth', reauth);
    router.add('GET', '/api/auth/username-available', usernameAvailable);
    router.add('POST', '/api/auth/recover', recover);
    router.add('POST', '/api/auth/reset', reset);
    router.add('POST', '/api/auth/discord/complete', discordComplete);
}

module.exports = { register };
