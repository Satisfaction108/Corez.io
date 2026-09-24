// Dig Wars accounts: entry point.
//
// server.js calls, on the main thread:
//   accounts.initMain()          once at boot: open + migrate the DB, start sweepers
//   accounts.handleHttp(req,res) first thing in the HTTP handler; true = handled
//   accounts.shutdown()          on SIGINT/SIGTERM
// A game running in a worker thread calls accounts.initWorker() for its own
// read/write connection (no migrations, 250 ms busy timeout).
//
// If there is no SQLite driver, no SESSION_SECRET in production, or
// ACCOUNTS_ENABLED=false, accounts stay off: /api/config says accounts:false,
// /api/me says nobody is logged in, other account routes answer 503
// accounts_unavailable, and the game carries on guest-only.
'use strict';

const fs = require('fs');

const config = require('./config');
const db = require('./db');
const crypto = require('./crypto');
const names = require('./names');
const users = require('./users');
const sessions = require('./sessions');
const ratelimit = require('./ratelimit');
const bus = require('./bus');
const http = require('./http');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const HARD_DELETE_AFTER_MS = 30 * DAY;

const router = http.createRouter();
require('./routes/auth').register(router);
require('./routes/discordOAuth').register(router);
require('./routes/account').register(router);

const state = { initialized: false, enabled: false, role: null, timers: [] };

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
    ratelimit.start();
    every(HOUR, () => sweep());
    after(5000, () => sweep());
    console.log(`[accounts] ready: ${handle.driver}, ${config.dbPath} (schema v${handle.userVersion()}), ` +
        `origin ${config.publicOrigin}, Discord login ${config.discordLogin ? 'on' : 'off'}`);
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
    return true;
}

function shutdown() {
    for (const t of state.timers) clearTimeout(t);
    state.timers = [];
    ratelimit.stop();
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
        if (!methods) throw new http.HttpError(404, 'not_found', 'No such endpoint.');
        route = methods[ctx.method];
        if (!route) {
            throw new http.HttpError(405, 'method_not_allowed', 'Method not allowed.', null, { Allow: Object.keys(methods).join(', ') });
        }
        const isApi = pathname.startsWith('/api/');
        if (isApi && ctx.method !== 'GET') http.csrfGuard(ctx);
        if (!ctx.accountsOn && !route.opts.alwaysOn) {
            if (route.opts.navigation) return ctx.redirect('/?auth=error&reason=accounts_unavailable');
            throw new http.HttpError(503, 'accounts_unavailable', 'Accounts are unavailable right now. You can still play as a guest.');
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
            return ctx.fail(500, 'server_error', 'Something went wrong. Try again.');
        }
        try { res.end(); } catch (_) { /* already gone */ }
    }
}

// Synchronously claims the request (returns true) if the path is ours, then
// answers it asynchronously. Never throws.
function handleHttp(req, res) {
    const url = String(req.url || '/');
    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q);
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
};
