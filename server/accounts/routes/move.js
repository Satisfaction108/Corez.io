// Moving to a new domain without losing anyone's browser data.
//
// A page load on a MOVE_FROM_HOST domain gets a tiny "moving" page instead of
// the game. Its script POSTs that browser's localStorage to /api/auth/move,
// which keeps it in memory under a random one-time code along with the login
// cookies the request carried (dw_dev and dw_pending ride along too, since
// both paths cover /api/auth). The page then goes to the same path on
// PUBLIC_ORIGIN with #move=<code>. index.html there claims the code
// (/api/auth/move/claim), which re-issues the cookies on the new host and
// hands the storage back once; the client keeps any key it already has.
//
// Everything else on the old host (API, websockets, assets, Discord) is left
// alone, so tabs, embeds and installed apps that are still on it keep working.
'use strict';

const nodeCrypto = require('crypto');
const config = require('../config');
const cookies = require('../cookies');
const crypto = require('../crypto');
const sessions = require('../sessions');
const { HttpError, BASE_HEADERS } = require('../http');

const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_CHARS = 512 * 1024;          // keys + values of one browser's storage
const MAX_KEYS = 2000;
const MAX_ENTRIES = 2000;
const MAX_TOTAL_CHARS = 32 * 1024 * 1024;
const BODY_LIMIT = 640 * 1024;         // MAX_CHARS plus JSON escaping
const PENDING_TTL_S = 15 * 60;         // dw_pending's own lifetime (discordOAuth.js)
const MOVED_KEY = 'dwMoved';

// code -> {until, ua, storage, chars, sid, dev, pending}. Inserted in time
// order with one TTL, so the expired ones are always at the front.
const pending = new Map();
let totalChars = 0;

function sweep(now) {
    for (const [code, e] of pending) {
        if (e.until > now) break;
        drop(code, e);
    }
}

function drop(code, e) {
    pending.delete(code);
    totalChars -= e.chars;
}

function uaHash(ua) {
    return crypto.sha256(String(ua || '')).slice(0, 16);
}

// -> code, or null when the store is full
function put(entry, now = Date.now()) {
    sweep(now);
    if (pending.size >= MAX_ENTRIES || totalChars + entry.chars > MAX_TOTAL_CHARS) return null;
    const code = crypto.randomToken(24);
    pending.set(code, { ...entry, until: now + CODE_TTL_MS });
    totalChars += entry.chars;
    return code;
}

// -> the entry once, then never again
function take(code, now = Date.now()) {
    sweep(now);
    if (typeof code !== 'string') return null;
    const e = pending.get(code);
    if (!e) return null;
    drop(code, e);
    return e;
}

// {key: string} from the body -> {storage, chars}; null for a bad shape,
// false when it is over the size cap. Non-string values are skipped.
function cleanStorage(raw) {
    if (raw == null) return { storage: Object.create(null), chars: 0 };
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const storage = Object.create(null);
    let keys = 0, chars = 0;
    for (const k of Object.keys(raw)) {
        const v = raw[k];
        if (typeof v !== 'string' || !k || k.length > 512 || k === MOVED_KEY) continue;
        chars += k.length + v.length;
        if (++keys > MAX_KEYS || chars > MAX_CHARS) return false;
        storage[k] = v;
    }
    return { storage, chars };
}

function cookieValue(ctx, name, max = 2048) {
    const v = ctx.cookies[name];
    return typeof v === 'string' && v && v.length <= max ? v : null;
}

function originOf(ctx) {
    return String(ctx.header('origin') || '').trim().toLowerCase().replace(/\/+$/, '');
}

// POST /api/auth/move {storage} on the old host -> {code}
function start(ctx) {
    if (!config.isMoveHost(ctx.header('host')) || !config.moveOrigins.has(originOf(ctx))) {
        throw new HttpError(403, 'bad_origin', 'Something went wrong. Refresh and try again.');
    }
    ctx.limit('moveStart', 'ip:' + ctx.ipKey);
    const clean = cleanStorage(ctx.body.storage);
    if (clean === null) throw new HttpError(400, 'bad_request', 'Something went wrong. Refresh and try again.');
    if (clean === false) throw new HttpError(413, 'payload_too_large', 'Something went wrong. Refresh and try again.');
    const code = put({
        ua: uaHash(ctx.header('user-agent')),
        storage: clean.storage,
        chars: clean.chars,
        sid: sessions.tokenFromCookieHeader(ctx.req.headers.cookie),
        dev: cookieValue(ctx, config.cookies.dev),
        pending: cookieValue(ctx, config.cookies.pending),
    }, ctx.now);
    if (!code) throw new HttpError(503, 'busy', "The server's busy. Try again in a moment!", { retryAfter: 5 }, { 'Retry-After': '5' });
    ctx.json(200, { code });
}

// POST /api/auth/move/claim {code} on the new host -> {storage, cookies}
function claim(ctx) {
    if (config.isMoveHost(ctx.header('host')) || config.moveOrigins.has(originOf(ctx))) {
        throw new HttpError(403, 'bad_origin', 'Something went wrong. Refresh and try again.');
    }
    ctx.limit('moveClaim', 'ip:' + ctx.ipKey);
    const code = typeof ctx.body.code === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(ctx.body.code) ? ctx.body.code : '';
    const e = code ? take(code, ctx.now) : null;
    // a different browser holding the link gets nothing (and the code is spent)
    if (!e || e.ua !== uaHash(ctx.header('user-agent'))) throw new HttpError(404, 'not_found', 'That link expired.');

    // Cookies this browser already has on the new host win.
    let set = 0;
    const have = cookieValue(ctx, config.cookies.session, 128);
    const haveOk = have && (!ctx.accountsOn || sessions.fromToken(have, ctx.now));
    if (e.sid && !haveOk && (!ctx.accountsOn || sessions.fromToken(e.sid, ctx.now))) {
        ctx.setCookie(sessions.cookieFor(e.sid));
        set++;
    }
    const devUser = e.dev ? sessions.deviceUserId(e.dev, ctx.now) : 0;
    if (devUser && !sessions.deviceUserId(ctx.cookies[config.cookies.dev], ctx.now)) {
        ctx.setCookie(sessions.deviceCookie(devUser, ctx.now));
        set++;
    }
    if (e.pending && !ctx.cookies[config.cookies.pending] && crypto.verifySigned('pending', e.pending, ctx.now)) {
        ctx.setCookie(cookies.serialize(config.cookies.pending, e.pending, { path: '/api', maxAge: PENDING_TTL_S }));
        set++;
    }
    ctx.json(200, { storage: e.storage, cookies: set });
}

// --- the moving page ---------------------------------------------------------

// Pages server.js answers with something other than index.html. index.html
// holds the claim, so these go through "/" and the claim sends them on.
const OTHER_PAGES = new Set(['/about', '/how-to-play', '/devlog', '/devlog/']);
const PAGE_DESTS = new Set(['document', 'iframe', 'frame']);

function isPageLoad(req, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (/^\/(api|auth|discord|shared)(\/|$)/i.test(pathname)) return false;
    // assets keep loading from here; only pages move
    if (/\.[a-z0-9]+$/i.test(pathname) && !/\.html?$/i.test(pathname)) return false;
    const dest = req.headers['sec-fetch-dest'];
    if (dest) return PAGE_DESTS.has(String(dest));
    return /\btext\/html\b/i.test(String(req.headers.accept || ''));
}

function isMenuPath(pathname) {
    if (OTHER_PAGES.has(pathname.toLowerCase())) return false;
    return !/\.html?$/i.test(pathname) || /^\/index\.html?$/i.test(pathname);
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const jsonInScript = v => JSON.stringify(v).replace(/</g, '\\u003c');

function page(nonce, opts) {
    const href = escapeHtml(opts.to + opts.url);
    const label = escapeHtml(opts.to.replace(/^https?:\/\//, ''));
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="canonical" href="${href}">
<title>Corez.io</title>
<noscript><meta http-equiv="refresh" content="0;url=${href}"></noscript>
<style nonce="${nonce}">
html,body{margin:0;height:100%;background:#0d0d14;color:#8d93a1;font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
body{display:grid;place-items:center}a{color:#c9cdd6}
</style></head><body><p>Corez.io moved to <a href="${href}">${label}</a></p>
<script nonce="${nonce}">
(function () {
    var to = ${jsonInScript(opts.to)}, menu = ${opts.menu ? 'true' : 'false'}, signedIn = ${opts.signedIn ? 'true' : 'false'};
    var done = false, ls = null, data = {}, n = 0;
    function go(code) {
        if (done) return;
        done = true;
        var path = location.pathname + location.search, hash = location.hash.replace(/^#/, '');
        if (code) {
            // index.html claims the code; other pages are reached from there
            if (!menu) { hash = 'move=' + code + '&movenext=' + encodeURIComponent(path + location.hash); path = '/'; }
            else hash = 'move=' + code + (hash ? '&' + hash : '');
        }
        location.replace(to + path + (hash ? '#' + hash : ''));
    }
    try {
        ls = window.localStorage;
        if (ls.getItem('dwMoved')) return go();
        for (var i = 0; i < ls.length; i++) {
            var k = ls.key(i);
            if (k == null || k === '__dwProbe') continue;
            data[k] = ls.getItem(k);
            n++;
        }
    } catch (e) { return go(); }
    if (!n && !signedIn) return go();
    // over the server's cap: leave the biggest values behind
    var keys = Object.keys(data).sort(function (a, b) { return data[b].length - data[a].length; });
    var size = 0;
    for (var j = 0; j < keys.length; j++) size += keys[j].length + data[keys[j]].length;
    for (j = 0; size > 500000 && j < keys.length; j++) { size -= keys[j].length + data[keys[j]].length; delete data[keys[j]]; }
    setTimeout(function () { go(); }, 2500);
    try {
        fetch('/api/auth/move', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storage: data })
        }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
            if (done) return;
            if (j && j.code) { try { ls.setItem('dwMoved', '1'); } catch (e) { /* */ } }
            go(j && j.code);
        }, function () { go(); });
    } catch (e) { go(); }
})();
</script></body></html>`;
}

// Called by server.js for every request before routing. true = answered.
function servePage(req, res) {
    if (!config.isMoveHost(req.headers.host)) return false;
    const url = String(req.url || '/');
    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q);
    if (!isPageLoad(req, pathname)) return false;
    const nonce = nodeCrypto.randomBytes(16).toString('base64');
    const body = page(nonce, {
        to: config.publicOrigin,
        url: url.startsWith('/') ? url : '/',
        menu: isMenuPath(pathname),
        signedIn: !!sessions.tokenFromCookieHeader(req.headers.cookie),
    });
    res.removeHeader('X-Frame-Options');
    res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors *`,
        'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
}

function register(router) {
    router.add('POST', '/api/auth/move', start, { alwaysOn: true, bodyLimit: BODY_LIMIT });
    router.add('POST', '/api/auth/move/claim', claim, { alwaysOn: true });
}

module.exports = {
    CODE_TTL_MS,
    MAX_CHARS,
    register,
    servePage,
    isPageLoad,
    isMenuPath,
    put,
    take,
    cleanStorage,
    pendingCount: () => pending.size,
};
