// Discord OAuth2 (authorization code flow, `identify` scope only).
//
// /auth/discord/start?mode=login|link|reauth sets a signed 10-minute
// dw_oauth cookie (state, mode, uid) scoped to /auth/discord and redirects to
// Discord. /auth/discord/callback checks it, swaps the code for a token,
// reads /users/@me, revokes the token without waiting (Discord tokens are
// never stored) and then:
//   login, known Discord id  -> new session, /?auth=ok
//   login, new Discord id    -> signed dw_pending cookie, /?auth=pick-username
//                               (POST /api/auth/discord/complete finishes it)
//   link                     -> /?link=ok, /?link=taken (another account has
//                               it) or /?link=already_linked (this account has
//                               a different one: unlink it first)
//   reauth                   -> session.reauth_until = now + 10 min, /?auth=reauth-ok
// Linking adds a way into the account, so it needs a fresh session (password
// login or POST /api/auth/reauth, or mode=reauth, in the last 10 minutes),
// checked at start and again at the callback; otherwise
// /?auth=error&reason=reauth_required.
// Each state value is accepted once, and the callback is rate limited per IP.
// Every outcome is a redirect; these routes never fall through to the
// static file server.
'use strict';

const config = require('../config');
const cookies = require('../cookies');
const crypto = require('../crypto');
const names = require('../names');
const ratelimit = require('../ratelimit');
const sessions = require('../sessions');
const users = require('../users');

const DISCORD_API = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const OAUTH_PATH = '/auth/discord';
// /api rather than /api/auth/discord: GET /api/me must see it too, to show
// "pick a username" with the Discord name and avatar.
const PENDING_PATH = '/api';
const MODES = new Set(['login', 'link', 'reauth']);

// Swappable for tests; the real thing is the global fetch.
let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetchForTests(fn) {
    fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

// state -> forget-at (ms). Inserted in time order with a fixed TTL, so the
// expired ones are always at the front. Kept for the whole state lifetime.
const usedStates = new Map();

// -> false if this state was already used.
function consumeState(state, now = Date.now()) {
    for (const [s, until] of usedStates) {
        if (until > now) break;
        usedStates.delete(s);
    }
    if (usedStates.has(state)) return false;
    usedStates.set(state, now + STATE_TTL_MS);
    return true;
}

function goHome(ctx, query) {
    ctx.redirect('/?' + query);
}

function fail(ctx, reason) {
    goHome(ctx, 'auth=error&reason=' + encodeURIComponent(reason));
}

function pendingCookie(profile, now = Date.now()) {
    const value = crypto.sign('pending', { d: profile.id, n: profile.name, a: profile.avatar }, PENDING_TTL_MS, now);
    return cookies.serialize(config.cookies.pending, value, { path: PENDING_PATH, maxAge: PENDING_TTL_MS / 1000 });
}

function clearPendingCookie() {
    return cookies.clear(config.cookies.pending, { path: PENDING_PATH });
}

// -> {id, name, avatar} | null
function readPending(ctx) {
    const data = crypto.verifySigned('pending', ctx.cookies[config.cookies.pending], ctx.now);
    if (!data || typeof data.d !== 'string' || !/^\d{5,25}$/.test(data.d)) return null;
    return { id: data.d, name: typeof data.n === 'string' ? data.n : '', avatar: typeof data.a === 'string' ? data.a : null };
}

function basicAuth() {
    return 'Basic ' + Buffer.from(`${config.discord.clientId}:${config.discord.clientSecret}`).toString('base64');
}

function formPost(url, form) {
    return fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: basicAuth() },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
}

// code -> {id, name, avatar} | null
async function fetchDiscordUser(code) {
    const tokenRes = await formPost(`${DISCORD_API}/oauth2/token`, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.discord.redirectUri,
    });
    if (!tokenRes.ok) {
        console.warn('[accounts] Discord token exchange failed: HTTP ' + tokenRes.status);
        return null;
    }
    const tok = await tokenRes.json().catch(() => null);
    if (!tok || typeof tok.access_token !== 'string') return null;
    try {
        const meRes = await fetchImpl(`${DISCORD_API}/users/@me`, {
            headers: { Authorization: 'Bearer ' + tok.access_token, Accept: 'application/json' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!meRes.ok) {
            console.warn('[accounts] Discord /users/@me failed: HTTP ' + meRes.status);
            return null;
        }
        const me = await meRes.json().catch(() => null);
        if (!me || !/^\d{5,25}$/.test(String(me.id))) return null;
        const name = names.sanitizeGuestName(me.global_name || me.username || '') || 'Discord user';
        const avatar = typeof me.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(me.avatar) ? me.avatar : null;
        return { id: String(me.id), name, avatar };
    } finally {
        // Fire and forget: we only needed the identity.
        Promise.resolve()
            .then(() => formPost(`${DISCORD_API}/oauth2/token/revoke`, { token: tok.access_token, token_type_hint: 'access_token' }))
            .catch(() => { /* Discord expires it anyway */ });
    }
}

function start(ctx) {
    if (!config.discordLogin) return fail(ctx, 'discord_disabled');
    if (!ratelimit.hit('discordStart', ctx.ipKey, ctx.now).ok) return fail(ctx, 'rate_limited');
    const mode = ctx.query.get('mode') || 'login';
    if (!MODES.has(mode)) return fail(ctx, 'bad_mode');
    let uid = 0;
    if (mode !== 'login') {
        const a = ctx.auth();
        if (!a || users.isBanned(a.user, ctx.now)) return fail(ctx, 'not_logged_in');
        if (mode === 'link') {
            if (a.user.discord_id) return goHome(ctx, 'link=already_linked');
            if (!sessions.isFresh(a.session, ctx.now)) return fail(ctx, 'reauth_required');
        }
        uid = a.user.id;
    }
    const state = crypto.randomToken(24);
    ctx.setCookie(cookies.serialize(config.cookies.oauth, crypto.sign('oauth', { s: state, m: mode, u: uid }, STATE_TTL_MS, ctx.now), {
        path: OAUTH_PATH,
        maxAge: STATE_TTL_MS / 1000,
    }));
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.discord.clientId,
        scope: 'identify',
        state,
        redirect_uri: config.discord.redirectUri,
        // Re-auth must show Discord's screen; plain login can skip it.
        prompt: mode === 'reauth' ? 'consent' : 'none',
    });
    ctx.redirect(AUTHORIZE_URL + '?' + params.toString());
}

async function callback(ctx) {
    // The state cookie is single use whatever happens next.
    ctx.setCookie(cookies.clear(config.cookies.oauth, { path: OAUTH_PATH }));
    try {
        if (!config.discordLogin) return fail(ctx, 'discord_disabled');
        if (!ratelimit.hit('discordCallback', ctx.ipKey, ctx.now).ok) return fail(ctx, 'rate_limited');
        const st = crypto.verifySigned('oauth', ctx.cookies[config.cookies.oauth], ctx.now);
        if (!st || typeof st.s !== 'string' || !MODES.has(st.m)) return fail(ctx, 'state');
        const err = ctx.query.get('error');
        if (err) return fail(ctx, err === 'access_denied' ? 'access_denied' : 'discord_error');
        const state = ctx.query.get('state') || '';
        const code = ctx.query.get('code') || '';
        if (!state || !crypto.safeEqual(state, st.s)) return fail(ctx, 'state');
        if (!code || code.length > 512) return fail(ctx, 'state');
        // The cookie is cleared above, but a copy of it could be replayed.
        if (!consumeState(st.s)) return fail(ctx, 'state');

        // link / reauth: must still be the account that started the flow
        // (checked before spending the code, and again after it).
        let token = null;
        if (st.m !== 'login') {
            const a = ctx.auth();
            if (!a || a.user.id !== st.u || users.isBanned(a.user, ctx.now)) return fail(ctx, 'session');
            if (st.m === 'link' && !sessions.isFresh(a.session, ctx.now)) return fail(ctx, 'reauth_required');
            token = a.token;
        }

        const profile = await fetchDiscordUser(code);
        if (!profile) return fail(ctx, 'exchange');
        const now = Date.now();

        if (st.m === 'login') {
            const user = users.byDiscordId(profile.id);
            if (!user) {
                ctx.setCookie(pendingCookie(profile, now));
                return goHome(ctx, 'auth=pick-username');
            }
            if (users.isBanned(user, now)) return fail(ctx, 'banned');
            users.updateDiscordProfile(user.id, profile.name, profile.avatar);
            ctx.startSession(user, 'discord');
            // dw_pending is scoped to /api, so it is not in this request's
            // cookies; clear it blindly in case an earlier attempt left one.
            ctx.setCookie(clearPendingCookie());
            users.touchSeen(user.id, now);
            return goHome(ctx, 'auth=ok');
        }

        // The exchange can take seconds: read the session again.
        const a = sessions.fromToken(token, now);
        if (!a || a.user.id !== st.u || users.isBanned(a.user, now)) return fail(ctx, 'session');
        if (st.m === 'link') {
            if (!sessions.isFresh(a.session, now)) return fail(ctx, 'reauth_required');
            const r = users.linkDiscord(a.user.id, profile, { ip: ctx.ip });
            return goHome(ctx, r.ok ? 'link=ok' : r.code === 'already_linked' ? 'link=already_linked' : 'link=taken');
        }
        if (a.user.discord_id !== profile.id) return fail(ctx, 'reauth_mismatch');
        sessions.markReauth(a.session.id, now);
        users.updateDiscordProfile(a.user.id, profile.name, profile.avatar);
        return goHome(ctx, 'auth=reauth-ok');
    } catch (e) {
        console.warn('[accounts] Discord callback failed: ' + ((e && e.message) || e));
        return fail(ctx, e && e.name === 'TimeoutError' ? 'timeout' : 'server');
    }
}

function register(router) {
    router.add('GET', '/auth/discord/start', start, { navigation: true });
    router.add('GET', '/auth/discord/callback', callback, { navigation: true });
}

module.exports = { register, readPending, pendingCookie, clearPendingCookie, setFetchForTests, PENDING_TTL_MS };
