// SQLite access for accounts.
//
// Uses the built-in node:sqlite (Node >= 22.13 without a flag), falls back to
// better-sqlite3 if that happens to be installed, and otherwise returns null
// so accounts switch off and the game keeps running guest-only.
//
// Only positional "?" parameters are used anywhere, because the two drivers
// disagree about named-parameter prefixes. Rows always come back as plain
// objects (node:sqlite hands out null-prototype ones).
'use strict';

const fs = require('fs');
const path = require('path');

let driverCache;
function loadDriver() {
    if (driverCache !== undefined) return driverCache;
    driverCache = null;
    try {
        const { DatabaseSync } = require('node:sqlite');
        if (typeof DatabaseSync === 'function') {
            driverCache = { name: 'node:sqlite', openRaw: file => new DatabaseSync(file) };
            return driverCache;
        }
    } catch (e) { /* not available on this Node */ }
    try {
        const Better = require('better-sqlite3');
        driverCache = { name: 'better-sqlite3', openRaw: file => new Better(file) };
    } catch (e) { /* not installed */ }
    return driverCache;
}

// node:sqlite and better-sqlite3 both reject booleans and undefined.
function bindable(params) {
    for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (p === undefined) params[i] = null;
        else if (p === true) params[i] = 1;
        else if (p === false) params[i] = 0;
    }
    return params;
}

function plain(row) {
    return row ? { ...row } : null;
}

class Db {
    constructor(raw, driver, file) {
        this.raw = raw;
        this.driver = driver;
        this.file = file;
        this.stmts = new Map();
        this.depth = 0;
        this.closed = false;
    }

    prepare(sql) {
        let stmt = this.stmts.get(sql);
        if (!stmt) {
            stmt = this.raw.prepare(sql);
            this.stmts.set(sql, stmt);
        }
        return stmt;
    }

    exec(sql) {
        this.raw.exec(sql);
    }

    get(sql, ...params) {
        return plain(this.prepare(sql).get(...bindable(params)));
    }

    all(sql, ...params) {
        return this.prepare(sql).all(...bindable(params)).map(plain);
    }

    run(sql, ...params) {
        const r = this.prepare(sql).run(...bindable(params));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    }

    // Runs fn inside BEGIN IMMEDIATE (so the write lock is taken up front and
    // busy_timeout applies), or a SAVEPOINT when already inside a tx. fn must
    // be synchronous: an await inside would commit half a transaction.
    tx(fn) {
        const outer = this.depth === 0;
        const sp = 'sp' + this.depth;
        this.raw.exec(outer ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + sp);
        this.depth++;
        try {
            const result = fn(this);
            if (result && typeof result.then === 'function') throw new Error('db.tx callback must be synchronous');
            this.raw.exec(outer ? 'COMMIT' : 'RELEASE ' + sp);
            return result;
        } catch (e) {
            try {
                if (outer) this.raw.exec('ROLLBACK');
                else this.raw.exec('ROLLBACK TO ' + sp + '; RELEASE ' + sp);
            } catch (_) { /* the original error matters more */ }
            throw e;
        } finally {
            this.depth--;
        }
    }

    userVersion() {
        return Number(this.get('PRAGMA user_version').user_version) || 0;
    }

    // Consistent online copy (works under WAL, other connections may write).
    backupTo(file) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.run('VACUUM INTO ?', file);
        try { fs.chmodSync(file, 0o600); } catch (e) { /* best effort */ }
        return file;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.stmts.clear();
        try { this.raw.exec('PRAGMA optimize'); } catch (e) { /* closing anyway */ }
        this.raw.close();
    }
}

// open({path, migrate, busyTimeout, backupDir}) -> Db | null
// The main thread opens with migrate:true (busy_timeout 5000); a game worker
// thread opens its own connection with migrate:false (busy_timeout 250).
function open(opts = {}) {
    const driver = loadDriver();
    if (!driver) {
        console.warn('[accounts] no SQLite driver (need Node >= 22.13 for node:sqlite, or better-sqlite3); accounts disabled');
        return null;
    }
    if (!opts.path) {
        console.error('[accounts] db.open needs a path');
        return null;
    }
    const file = path.resolve(opts.path);
    const migrate = opts.migrate !== false;
    const busyTimeout = opts.busyTimeout != null ? opts.busyTimeout : (migrate ? 5000 : 250);
    let db = null;
    try {
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        db = new Db(driver.openRaw(file), driver.name, file);
        try { fs.chmodSync(file, 0o600); } catch (e) { /* e.g. read-only fs */ }
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, busyTimeout | 0)}`);
        db.get('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA temp_store = MEMORY');
        if (migrate) {
            require('./migrations').apply(db, { backupDir: opts.backupDir || path.join(path.dirname(file), 'backups') });
        }
        return db;
    } catch (e) {
        console.error('[accounts] could not open database ' + file + ': ' + ((e && e.stack) || e));
        try { if (db) db.close(); } catch (_) { /* ignore */ }
        return null;
    }
}

// The connection the account modules use in this thread (set by initMain /
// initWorker). Null means accounts are unavailable here.
let current = null;
function setCurrent(db) { current = db || null; }
function handle() { return current; }

module.exports = { open, setCurrent, handle, driverName: () => (loadDriver() || {}).name || null };
