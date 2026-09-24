// Tiny HTTP layer for the account routes: a method+path table, a request
// context with JSON/redirect helpers, body parsing, CSRF, auth and rate
// limiting. Every response carries Cache-Control: no-store and nosniff.
'use strict';

const config = require('./config');
const cookies = require('./cookies');
const ratelimit = require('./ratelimit');
const sessions = require('./sessions');
const users = require('./users');

const BODY_LIMIT = 16 * 1024;
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

class HttpError extends Error {
    constructor(status, code, message, extra, headers) {
        super(message || code);
        this.status = status;
        this.code = code;
        this.extra = extra || null;
        this.headers = headers || null;
    }
}

function rateLimited(retryAfter, code = 'rate_limited', message = 'Too many attempts. Try again later.') {
    return new HttpError(429, code, message, { retryAfter }, { 'Retry-After': String(retryAfter) });
}

function busyError() {
    return new HttpError(503, 'busy', 'The server is busy. Try again in a moment.', { retryAfter: 2 }, { 'Retry-After': '2' });
}

// server/lib/clientIp.js trusts X-Forwarded-For only from TRUSTED_PROXIES.
// Until it can be loaded, fall back to the socket peer.
let clientIpImpl = null;
let isTrustedProxyImpl = null;
let clientIpRetryAt = 0;
let proxyWarned = false;

// In production, X-Forwarded-For from an untrusted peer almost always means
// TRUSTED_PROXIES is not set for the real reverse proxy: every player then
// has the proxy's address and shares its rate limits. Said once, loudly.
function warnUntrustedProxy(req) {
    if (proxyWarned || !config.isProd || !isTrustedProxyImpl || !req.headers || !req.headers['x-forwarded-for']) return;
    const raw = (req.socket && req.socket.remoteAddress) || '';
    if (!raw || isTrustedProxyImpl(raw)) return;
    const peer = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    proxyWarned = true;
    console.error(`[accounts] SECURITY: a request with X-Forwarded-For came from ${peer}, which is not in TRUSTED_PROXIES` +
        ` (now "${process.env.TRUSTED_PROXIES || '127.0.0.1,::1'}"). The header is ignored, so every player behind that` +
        ' proxy gets the proxy\'s address and they all share one set of login rate limits: one person can lock' +
        ' everybody out. Set TRUSTED_PROXIES to your reverse proxy\'s exact address (on Hack Club Nest Caddy connects' +
        ' from 10.60.1.2: TRUSTED_PROXIES=10.60.1.2, never the whole /16). If that is not your proxy, someone is' +
        ' connecting directly and forging the header; do not trust it. (Logged once.)');
}

function clientIp(req) {
    if (!clientIpImpl && Date.now() >= clientIpRetryAt) {
        try {
            const mod = require('../lib/clientIp');
            clientIpImpl = typeof mod === 'function' ? mod : mod.clientIp;
            isTrustedProxyImpl = typeof mod.isTrustedProxy === 'function' ? mod.isTrustedProxy : null;
        } catch (e) {
            clientIpRetryAt = Date.now() + 30 * 1000;
        }
    }
    try { warnUntrustedProxy(req); } catch (e) { /* diagnostics only */ }
    if (clientIpImpl) {
        try {
            const ip = clientIpImpl(req);
            if (ip) return String(ip);
        } catch (e) { /* fall through */ }
    }
    const raw = (req.socket && req.socket.remoteAddress) || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

// Resolves to the parsed JSON object ({} for an empty body).
function readJson(req, limit = BODY_LIMIT) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (declared > limit) {
            reject(new HttpError(413, 'payload_too_large', 'Request body too large.', null, { Connection: 'close' }));
            return;
        }
        const chunks = [];
        let size = 0, done = false;
        req.on('data', chunk => {
            if (done) return;
            size += chunk.length;
            if (size > limit) {
                done = true;
                reject(new HttpError(413, 'payload_too_large', 'Request body too large.', null, { Connection: 'close' }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (done) return;
            done = true;
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text) return resolve({});
            let body;
            try {
                body = JSON.parse(text);
            } catch (e) {
                return reject(new HttpError(400, 'bad_json', 'Request body is not valid JSON.'));
            }
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return reject(new HttpError(400, 'bad_json', 'Request body must be a JSON object.'));
            }
            resolve(body);
        });
        req.on('error', e => {
            if (done) return;
            done = true;
            reject(new HttpError(400, 'bad_request', 'Request body could not be read.'));
        });
    });
}

class Ctx {
    constructor(req, res, pathname, query) {
        this.req = req;
        this.res = res;
        this.path = pathname;
        this.query = query;
        this.method = req.method === 'HEAD' ? 'GET' : String(req.method || 'GET').toUpperCase();
        this.now = Date.now();
        this.ip = clientIp(req);
        // What rate limits key on: IPv6 grouped by /64 (ratelimit.ipKey).
        this.ipKey = ratelimit.ipKey(this.ip);
        this.cookies = cookies.parse(req.headers.cookie);
        this.body = {};
        this.outCookies = [];
        this.accountsOn = false;
        this._auth = undefined;
    }

    header(name) {
        const v = this.req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
    }

    setCookie(value) {
        this.outCookies.push(value);
    }

    get responded() {
        return this.res.headersSent || this.res.writableEnded;
    }

    send(status, body, headers) {
        if (this.responded) return;
        const h = { ...BASE_HEADERS, ...(headers || {}) };
        if (this.outCookies.length) h['Set-Cookie'] = this.outCookies;
        if (body === undefined) {
            this.res.writeHead(status, h);
            this.res.end();
            return;
        }
        const payload = JSON.stringify(body);
        h['Content-Type'] = 'application/json; charset=utf-8';
        h['Content-Length'] = Buffer.byteLength(payload);
        this.res.writeHead(status, h);
        this.res.end(payload);
    }

    json(status, body) {
        this.send(status, body);
    }

    noContent() {
        this.send(204);
    }

    redirect(location) {
        this.send(302, undefined, { Location: location });
    }

    fail(status, code, message, extra, headers) {
        this.send(status, { error: { code, message: message || code, ...(extra || {}) } }, headers);
    }

    // {user, session, token} | null. Rolls the session expiry (and re-sends
    // the cookie) at most hourly; clears a cookie that no longer matches.
    auth() {
        if (this._auth !== undefined) return this._auth;
        this._auth = null;
        if (!this.accountsOn) return null;
        const token = this.cookies[config.cookies.session];
        if (!token) return null;
        const found = sessions.fromToken(token, this.now);
        if (!found) {
            this.setCookie(sessions.clearCookie());
            return null;
        }
        if (sessions.touch(found.session, this.now)) this.setCookie(sessions.cookieFor(token));
        this._auth = { user: found.user, session: found.session, token };
        return this._auth;
    }

    requireAuth() {
        const a = this.auth();
        if (!a) throw new HttpError(401, 'unauthorized', 'Log in first.');
        if (users.isBanned(a.user, this.now)) throw bannedError(a.user);
        return a;
    }

    // Starts a new session for this browser. The session in the cookie being
    // replaced (if any) is revoked rather than left orphaned. Also (re)issues
    // dw_dev, marking this browser as one the account logs in from.
    startSession(user, method) {
        const old = this.cookies[config.cookies.session];
        if (old) sessions.revokeByToken(old);
        // A half-finished Discord signup is moot once logged in.
        if (this.cookies[config.cookies.pending]) this.setCookie(cookies.clear(config.cookies.pending, { path: '/api' }));
        const s = sessions.create(user.id, { method, ip: this.ip, userAgent: this.header('user-agent'), reauth: true, now: Date.now() });
        this.setCookie(s.cookie);
        this.setCookie(sessions.deviceCookie(user.id));
        this._auth = undefined;
        this.cookies[config.cookies.session] = s.token;
        return s;
    }

    // True when this browser carries a valid dw_dev cookie for that account.
    isKnownDevice(userId) {
        return !!userId && sessions.deviceUserId(this.cookies[config.cookies.dev]) === userId;
    }

    // ratelimit.take: throws 429 if any [bucket, key] is full, otherwise
    // records one event in each and returns {refund()}.
    charge(...entries) {
        const r = ratelimit.take(entries, Date.now());
        if (!r.ok) throw rateLimited(r.retryAfter);
        return r;
    }

    // Throws 429 if the window is full; otherwise records one event.
    limit(bucket, key) {
        const r = ratelimit.hit(bucket, key, this.now);
        if (!r.ok) throw rateLimited(r.retryAfter);
    }

    // Throws 429 if the window is full; records nothing.
    checkLimit(bucket, key) {
        const r = ratelimit.check(bucket, key, this.now);
        if (!r.ok) throw rateLimited(r.retryAfter);
    }

    checkBackoff(bucket, key) {
        const r = ratelimit.backoffCheck(bucket, key, this.now);
        if (!r.ok) throw rateLimited(r.retryAfter);
    }
}

function bannedError(user) {
    return new HttpError(403, 'banned', 'This account is banned.', { until: user.banned_until, reason: user.ban_reason || null });
}

// Non-GET /api/*: an allowed Origin, Sec-Fetch-Site same-origin when sent,
// and a JSON body. A cross-site form or fetch fails at least one of these.
function csrfGuard(ctx) {
    const origin = ctx.header('origin');
    if (!origin || !config.isAllowedOrigin(origin)) throw new HttpError(403, 'bad_origin', 'Request origin not allowed.');
    const site = ctx.header('sec-fetch-site');
    if (site && site !== 'same-origin') throw new HttpError(403, 'bad_origin', 'Cross-site request refused.');
    const type = String(ctx.header('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Send the request body as application/json.');
}

// path -> {METHOD: {handler, opts}}
// opts.alwaysOn: still served while accounts are disabled.
// opts.navigation: a browser navigation; errors become redirects, not JSON.
function createRouter() {
    const table = new Map();
    return {
        add(method, path, handler, opts = {}) {
            let methods = table.get(path);
            if (!methods) table.set(path, methods = {});
            methods[method.toUpperCase()] = { handler, opts };
        },
        lookup(path) {
            return table.get(path) || null;
        },
    };
}

// Strings from a JSON body, never anything else.
function str(v, max = 256) {
    return typeof v === 'string' ? v.slice(0, max) : '';
}

module.exports = {
    BODY_LIMIT,
    BASE_HEADERS,
    HttpError,
    Ctx,
    clientIp,
    readJson,
    csrfGuard,
    createRouter,
    rateLimited,
    busyError,
    bannedError,
    str,
};
