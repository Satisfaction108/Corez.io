// Dig Wars accounts: entry point.
//
// server.js calls, on the main thread:
//   accounts.initMain()          once at boot: open + migrate the DB, start sweepers
//   accounts.handleHttp(req,res) first thing in the HTTP handler; true = handled
//                                (also serves the shared rules, GET /shared/*.js)
//   accounts.shutdown()          on SIGINT/SIGTERM; runs onShutdown(fn) hooks
//                                first (the game settles open lives there)
// A game running in a worker thread calls accounts.initWorker() for its own
// read/write connection (no migrations, 250 ms busy timeout).
//
// If there is no SQLite driver, no SESSION_SECRET in production, or
// ACCOUNTS_ENABLED=false, accounts stay off: /api/config says accounts:false,
// /api/me says nobody is logged in, other account routes answer 503
// accounts_unavailable, and the game carries on guest-only.
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const db = require('./db');
const crypto = require('./crypto');
const names = require('./names');
const users = require('./users');
const sessions = require('./sessions');
const ratelimit = require('./ratelimit');
const bus = require('./bus');
const http = require('./http');
const rankStore = require('./rankStore');
const ranked = require('./ranked');
const dust = require('./dust');
const store = require('./store');
const friends = require('./friends');
const presence = require('./presence');
const events = require('./routes/events');
const quests = require('./quests');
const achievements = require('./achievements');
const backup = require('./backup');
const announce = require('./discord/announce');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const HARD_DELETE_AFTER_MS = 30 * DAY;

const router = http.createRouter();
require('./routes/auth').register(router);
require('./routes/discordOAuth').register(router);
require('./routes/account').register(router);
require('./routes/store').register(router);
require('./routes/friends').register(router);
require('./routes/profile').register(router);
require('./routes/progress').register(router);
require('./routes/interactions').register(router);
require('./routes/resetPage').register(router);
events.register(router);

const state = { initialized: false, enabled: false, role: null, timers: [] };
const shutdownHooks = new Set();

function enabled() {
    return state.enabled && !!db.handle();
}

// Expired sessions, holds and reset tokens; accounts 30 days past soft
// deletion (cascades to their rows everywhere else).
function sweep(now = Date.now()) {
    const d = db.handle();
    if (!d || state.role !== 'main') return null;
    try {
        const r = d.tx(() => ({
            sessions: d.run('DELETE FROM sessions WHERE expires_at <= ?', now).changes,
            holds: d.run('DELETE FROM username_holds WHERE expires_at <= ?', now).changes,
            resets: d.run('DELETE FROM password_resets WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)', now, now - DAY).changes,
            users: d.run('DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= ?', now - HARD_DELETE_AFTER_MS).changes,
        }));
        d.exec('PRAGMA optimize');
        return r;
    } catch (e) {
        console.error('[accounts] sweep failed: ' + ((e && e.stack) || e));
        return null;
    }
}

function every(ms, fn) {
    const t = setInterval(fn, ms);
    if (t.unref) t.unref();
    state.timers.push(t);
}

function after(ms, fn) {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    state.timers.push(t);
}

// -> true if accounts are on. Safe to call more than once.
function initMain() {
    if (state.initialized) return enabled();
    state.initialized = true;
    config.load();
    if (!config.accountsFlag) {
        console.log('[accounts] disabled (ACCOUNTS_ENABLED=false); running guest-only');
        return false;
    }
    if (config.secretWarning) (config.secretOk ? console.warn : console.error)('[accounts] ' + config.secretWarning);
    if (!config.secretOk) return false;
    try {
        if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    } catch (e) {
        console.error('[accounts] cannot create DATA_DIR ' + config.dataDir + ': ' + e.message);
        return false;
    }
    const handle = db.open({ path: config.dbPath, migrate: true, busyTimeout: 5000, backupDir: config.backupDir });
    if (!handle) {
        console.error('[accounts] database unavailable; running guest-only');
        return false;
    }
    db.setCurrent(handle);
    state.enabled = true;
    state.role = 'main';
    // Nothing is playing yet, so an open life is one a crash left behind.
    try {
        const n = rankStore.closeOrphans();
        if (n) console.log(`[accounts] closed ${n} ranked li${n === 1 ? 'fe' : 'ves'} left open by a crash (delta 0)`);
    } catch (e) {
        console.error('[accounts] closing orphaned lives failed: ' + ((e && e.stack) || e));
    }
    ratelimit.start();
    presence.start();
    events.start();
    announce.start();
    backup.start();
    every(HOUR, () => sweep());
    after(5000, () => sweep());
    const bot = config.discordBot;
    console.log(`[accounts] ready: ${handle.driver}, ${config.dbPath} (schema v${handle.userVersion()}), ` +
        `origin ${config.publicOrigin}, Discord login ${config.discordLogin ? 'on' : 'off'}, ` +
        `bot interactions ${bot.interactions ? 'on' : 'off'} (admins ${bot.adminIds.size}${bot.adminGuildId ? '' : ', no admin guild'}), ` +
        `announcements ${announce.enabled() ? 'on' : 'off'}`);
    return true;
}

// For a game worker thread: its own connection to the same file. The main
// thread must have migrated it already.
function initWorker(opts = {}) {
    if (state.initialized) return enabled();
    state.initialized = true;
    config.load();
    if (!config.accountsFlag || !config.secretOk) return false;
    // Never create the file from here: an empty unmigrated DB would look valid.
    if (!fs.existsSync(config.dbPath)) {
        console.warn('[accounts] worker: no database at ' + config.dbPath + ' yet; accounts off in this thread');
        return false;
    }
    const handle = db.open({ path: config.dbPath, migrate: false, busyTimeout: opts.busyTimeout != null ? opts.busyTimeout : 250 });
    if (!handle) return false;
    if (handle.userVersion() < require('./migrations').latestVersion()) {
        console.warn('[accounts] worker: database schema is behind this build; accounts off in this thread');
        handle.close();
        return false;
    }
    db.setCurrent(handle);
    state.enabled = true;
    state.role = 'worker';
    // the main thread's SIGINT/SIGTERM: settle and close here too
    if (!state.workerShutdownSub) {
        state.workerShutdownSub = bus.onGame(msg => {
            if (msg && msg.t === 'shutdown' && state.role === 'worker') shutdown();
        });
    }
    return true;
}

// fn() runs at shutdown while the database is still open (this thread only).
function onShutdown(fn) {
    if (typeof fn === 'function') shutdownHooks.add(fn);
    return () => shutdownHooks.delete(fn);
}

function shutdown() {
    if (enabled()) {
        for (const fn of Array.from(shutdownHooks)) {
            try { fn(); } catch (e) { console.error('[accounts] shutdown hook failed: ' + ((e && e.stack) || e)); }
        }
    }
    for (const t of state.timers) clearTimeout(t);
    state.timers = [];
    ratelimit.stop();
    if (state.role === 'main') {
        try { events.stop(); } catch (e) { /* closing anyway */ }
        presence.stop();
        announce.stop();
        backup.stop();
    }
    const d = db.handle();
    db.setCurrent(null);
    state.enabled = false;
    state.initialized = false;
    state.role = null;
    if (d) {
        try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* closing anyway */ }
        try { d.close(); } catch (e) {
            console.error('[accounts] close failed: ' + ((e && e.stack) || e));
        }
    }
}

// Paths this module answers (always as JSON or a redirect). The two legacy
// /api routes stay in server.js.
const LEGACY_API = new Set(['/api/getAddonAuthors', '/api/sendPlayer']);
function owns(pathname) {
    if (LEGACY_API.has(pathname)) return false;
    return pathname === '/api' || pathname.startsWith('/api/')
        || pathname === '/auth' || pathname.startsWith('/auth/')
        || pathname === '/discord' || pathname.startsWith('/discord/');
}

async function dispatch(req, res, pathname, query) {
    const ctx = new http.Ctx(req, res, pathname, query);
    ctx.accountsOn = enabled();
    let route = null;
    try {
        const methods = router.lookup(pathname);
        if (!methods) throw new http.HttpError(404, 'not_found', 'Nothing here.');
        route = methods[ctx.method];
        if (!route) {
            throw new http.HttpError(405, 'method_not_allowed', 'Something went wrong. Refresh and try again.', null, { Allow: Object.keys(methods).join(', ') });
        }
        const isApi = pathname.startsWith('/api/');
        if (isApi && ctx.method !== 'GET') http.csrfGuard(ctx);
        if (!ctx.accountsOn && !route.opts.alwaysOn) {
            if (route.opts.navigation) return ctx.redirect('/?auth=error&reason=accounts_unavailable');
            throw new http.HttpError(503, 'accounts_unavailable', 'Accounts are down right now. You can still play as a guest!');
        }
        // /api/config and /api/me always answer 200 (the menu boots from them).
        // Always per IP, so rotating sessions (or made-up cookies) cannot
        // multiply the budget, and per validated session on top.
        if (isApi && ctx.accountsOn && !route.opts.alwaysOn) {
            const a = ctx.auth();
            ctx.charge(['api', 'ip:' + ctx.ipKey], a ? ['api', 's:' + a.session.id] : null);
        }
        if (isApi && ctx.method !== 'GET') ctx.body = await http.readJson(req);
        await route.handler(ctx);
        if (!ctx.responded) throw new Error('route did not respond');
    } catch (err) {
        // The scrypt gate is full: 503 busy, try again shortly.
        const e = err instanceof crypto.BusyError ? http.busyError() : err;
        if (e instanceof http.HttpError) {
            if (route && route.opts.navigation) return ctx.redirect('/?auth=error&reason=' + encodeURIComponent(e.code));
            return ctx.fail(e.status, e.code, e.message, e.extra, e.headers);
        }
        console.error(`[accounts] ${req.method} ${pathname} failed: ` + ((e && e.stack) || e));
        if (!ctx.responded) {
            if (route && route.opts.navigation) return ctx.redirect('/?auth=error&reason=server');
            return ctx.fail(500, 'server_error', 'Oops, something went wrong. Try again!');
        }
        try { res.end(); } catch (_) { /* already gone */ }
    }
}

// The shared rules modules the client loads (<script src="/shared/...">).
// A fixed list, read-only, from <repo>/shared; anything else under /shared/
// is a 404. Guests need them too, so they are served with accounts off.
const SHARED_DIR = path.join(__dirname, '..', '..', 'shared');
const SHARED_FILES = new Set(['ranks.js', 'cosmetics.js']);
const sharedCache = new Map();   // name -> {mtimeMs, size, body, etag}

function serveShared(req, res, pathname) {
    const name = pathname.slice('/shared/'.length);
    const method = String(req.method || 'GET').toUpperCase();
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method not allowed');
    }
    let file = null;
    if (SHARED_FILES.has(name)) {
        try {
            const full = path.join(SHARED_DIR, name);
            const st = fs.statSync(full);
            file = sharedCache.get(name);
            if (!file || file.mtimeMs !== st.mtimeMs || file.size !== st.size) {
                const body = fs.readFileSync(full);
                file = { mtimeMs: st.mtimeMs, size: st.size, body, etag: '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"' };
                sharedCache.set(name, file);
            }
        } catch (e) { file = null; }
    }
    if (!file) {
        res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
    }
    if (req.headers && req.headers['if-none-match'] === file.etag) {
        res.writeHead(304, { ...headers, ETag: file.etag });
        return res.end();
    }
    res.writeHead(200, { ...headers, ETag: file.etag, 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': file.body.length });
    res.end(method === 'HEAD' ? undefined : file.body);
}

// Synchronously claims the request (returns true) if the path is ours, then
// answers it asynchronously. Never throws.
function handleHttp(req, res) {
    const url = String(req.url || '/');
    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q);
    if (pathname.startsWith('/shared/')) {
        try { serveShared(req, res, pathname); } catch (e) {
            console.error('[accounts] /shared failed: ' + ((e && e.stack) || e));
            try { if (!res.headersSent) res.writeHead(500); res.end(); } catch (_) { /* gone */ }
        }
        return true;
    }
    if (!owns(pathname)) return false;
    const query = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
    dispatch(req, res, pathname, query).catch(e => {
        console.error('[accounts] ' + ((e && e.stack) || e));
        try {
            if (!res.headersSent) res.writeHead(500, { ...http.BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
            res.end('{"error":{"code":"server_error","message":"Something went wrong."}}');
        } catch (_) { /* already gone */ }
    });
    return true;
}

module.exports = {
    initMain,
    initWorker,
    handleHttp,
    shutdown,
    onShutdown,
    enabled,
    sweep,
    owns,
    config,
    db,
    users,
    sessions,
    names,
    crypto,
    bus,
    ratelimit,
    rankStore,
    ranked,
    dust,
    store,
    friends,
    presence,
    events,
    quests,
    achievements,
    backup,
    announce,
};
