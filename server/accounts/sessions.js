// Login sessions: a random 32-byte token in an HttpOnly cookie, stored as
// sha256(token). 60-day expiry that rolls forward at most once an hour.
// reauth_until marks a 10-minute window after the user proved who they are
// (password login, Discord login or Discord re-auth), during which
// sensitive account changes skip the password prompt.
//
// Separately, every login leaves a signed, year-long dw_dev cookie naming the
// account ("this browser has logged in as user N"). It grants nothing by
// itself; it only exempts its owner from the per-username login backoff, so
// strangers failing on purpose cannot lock the owner out.
'use strict';

const config = require('./config');
const cookies = require('./cookies');
const crypto = require('./crypto');
const db = require('./db');

const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 60 * DAY;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const REAUTH_MS = 10 * 60 * 1000;
const DEVICE_TTL_MS = 365 * DAY;
const DEVICE_PATH = '/api/auth';

function h() { return db.handle(); }

function cookieFor(token) {
    return cookies.serialize(config.cookies.session, token, { path: '/', maxAge: SESSION_TTL_MS / 1000 });
}

function clearCookie() {
    return cookies.clear(config.cookies.session, { path: '/' });
}

// create(userId, {method, ip, userAgent, reauth, now})
// -> {token, sessionId, cookie /* Set-Cookie header value */}
function create(userId, opts = {}) {
    const now = opts.now || Date.now();
    const token = crypto.randomToken(32);
    const ua = typeof opts.userAgent === 'string' ? opts.userAgent.slice(0, 200) : null;
    const r = h().run(
        `INSERT INTO sessions (token_hash, user_id, method, created_at, last_seen_at, expires_at, reauth_until, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.sha256(token), userId, opts.method || 'password', now, now, now + SESSION_TTL_MS,
        opts.reauth === false ? 0 : now + REAUTH_MS, opts.ip || null, ua
    );
    return { token, sessionId: r.lastInsertRowid, cookie: cookieFor(token) };
}

function deviceCookie(userId, now = Date.now()) {
    const value = crypto.sign('dev', { u: userId }, DEVICE_TTL_MS, now);
    return cookies.serialize(config.cookies.dev, value, { path: DEVICE_PATH, maxAge: DEVICE_TTL_MS / 1000 });
}

// dw_dev cookie value -> the user id it was issued to, or 0.
function deviceUserId(value, now = Date.now()) {
    const data = crypto.verifySigned('dev', value, now);
    return data && Number.isInteger(data.u) && data.u > 0 ? data.u : 0;
}

function tokenFromCookieHeader(cookieHeader) {
    const t = cookies.parse(cookieHeader)[config.cookies.session];
    return typeof t === 'string' && t.length >= 20 && t.length <= 128 ? t : null;
}

// -> {user, session} | null. Skips expired sessions and deleted users;
// banned users ARE returned (check user.banned_until).
function fromToken(token, now = Date.now()) {
    const d = h();
    if (!d || typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    const session = d.get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', crypto.sha256(token), now);
    if (!session) return null;
    const user = d.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', session.user_id);
    return user ? { user, session } : null;
}

// Synchronous, for the game thread's WebSocket upgrade.
function fromCookieHeader(cookieHeader, now = Date.now()) {
    const token = tokenFromCookieHeader(cookieHeader);
    return token ? fromToken(token, now) : null;
}

// Rolls the expiry forward, at most once an hour. Returns true when it did,
// so the HTTP layer re-sends the cookie with a fresh Max-Age.
function touch(session, now = Date.now()) {
    const d = h();
    if (!d || !session || now - session.last_seen_at < TOUCH_EVERY_MS) return false;
    d.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, now + SESSION_TTL_MS, session.id);
    d.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, session.user_id);
    session.last_seen_at = now;
    session.expires_at = now + SESSION_TTL_MS;
    return true;
}

function revoke(sessionId) {
    const d = h();
    return !!d && d.run('DELETE FROM sessions WHERE id = ?', sessionId).changes > 0;
}

function revokeByToken(token) {
    const d = h();
    return !!d && typeof token === 'string' && d.run('DELETE FROM sessions WHERE token_hash = ?', crypto.sha256(token)).changes > 0;
}

// Only if the session belongs to that user (the sessions list "Revoke" button).
function revokeForUser(userId, sessionId) {
    const d = h();
    return !!d && d.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', sessionId, userId).changes > 0;
}

// -> number revoked
function revokeAllForUser(userId, exceptSessionId = null) {
    const d = h();
    if (!d) return 0;
    return exceptSessionId == null
        ? d.run('DELETE FROM sessions WHERE user_id = ?', userId).changes
        : d.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, exceptSessionId).changes;
}

function markReauth(sessionId, now = Date.now()) {
    h().run('UPDATE sessions SET reauth_until = ? WHERE id = ?', now + REAUTH_MS, sessionId);
}

function isFresh(session, now = Date.now()) {
    return !!session && session.reauth_until > now;
}

function listForUser(userId, now = Date.now()) {
    const d = h();
    if (!d) return [];
    return d.all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', userId, now);
}

function sweepExpired(now = Date.now()) {
    const d = h();
    return d ? d.run('DELETE FROM sessions WHERE expires_at <= ?', now).changes : 0;
}

module.exports = {
    SESSION_TTL_MS,
    REAUTH_MS,
    DEVICE_TTL_MS,
    create,
    cookieFor,
    clearCookie,
    deviceCookie,
    deviceUserId,
    tokenFromCookieHeader,
    fromToken,
    fromCookieHeader,
    touch,
    revoke,
    revokeByToken,
    revokeForUser,
    revokeAllForUser,
    markReauth,
    isFresh,
    listForUser,
    sweepExpired,
};
