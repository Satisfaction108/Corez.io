// Save codes: "Save & leave" in a raid, "$restore CODE" next time.
//
// create() stores the saved tank (the game side builds it, see
// game/terrain/saveCodes.js) and hands back a 25-character Crockford code
// (125 random bits, shown as five groups of five). Only its SHA-256 is kept.
// restore() takes a code once: it must be unused, under TTL_MS old and from
// the same mode (Solo or Duos), and the account or guest restoring it, and
// their IP, must not have restored anything in the last RESTORE_GAP_MS. The
// check and the use are one transaction, so two raid servers can't both
// restore the same code.
//
// Both write an audit_log row (save_create / save_restore), without an IP.
// The restorer's IP is kept only as a salted hash on the save row for the
// gap rule, and cleared after a day (sweep).
'use strict';

const nodeCrypto = require('crypto');
const db = require('./db');
const crypto = require('./crypto');

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESTORE_GAP_MS = 10 * 60 * 1000;
const CODE_LEN = 25;
const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = 30 * DAY;
const GUEST_RE = /^[a-f0-9]{32}$/;

function newCode() {
    const c = crypto.crockfordEncode(nodeCrypto.randomBytes(16)).slice(0, CODE_LEN);
    return c.match(/.{5}/g).join('-');
}

// Canonical form that gets hashed: 25 Crockford chars, or null.
function normalize(s) {
    const n = crypto.crockfordNormalize(s);
    return n.length === CODE_LEN && crypto.isCrockford(n) ? n : null;
}

function modeOk(m) { return m === 'solo' || m === 'duo'; }

// A per-database salt for the IP hash (meta 'restore_ip_salt').
let saltCache = null;
function ipTag(d, ip) {
    if (!ip) return null;
    if (!saltCache) {
        d.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('restore_ip_salt', ?)", nodeCrypto.randomBytes(16).toString('hex'));
        const r = d.get("SELECT value FROM meta WHERE key = 'restore_ip_salt'");
        saltCache = r && r.value ? r.value : null;
        if (!saltCache) return null;
    }
    return crypto.sha256(saltCache + '|' + String(ip)).slice(0, 32);
}

// No IP in these rows (guests are promised theirs is never kept with them);
// the restore gap rule has its own salted hash on the save row.
function audit(d, userId, action, detail, now) {
    try {
        d.run('INSERT INTO audit_log (at, user_id, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?, NULL)',
            now, userId || null, userId ? 'self' : 'guest', action, JSON.stringify(detail));
    } catch (e) { /* the audit row never blocks a save */ }
}

// {mode, userId, guestId, data, score, ip} -> {code, expiresAt} | null
function create(opts, now = Date.now()) {
    const d = db.handle();
    if (!d || !opts || !modeOk(opts.mode) || !opts.data) return null;
    const userId = opts.userId | 0 || null;
    const guestId = !userId && GUEST_RE.test(String(opts.guestId || '')) ? String(opts.guestId) : null;
    const json = JSON.stringify(opts.data);
    if (json.length > 16000) return null;
    const code = newCode();
    const expiresAt = now + TTL_MS;
    d.run('INSERT INTO saves (code_hash, mode, user_id, guest_id, data, score, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        crypto.sha256(normalize(code)), opts.mode, userId, guestId, json, Math.max(0, opts.score | 0), now, expiresAt);
    audit(d, userId, 'save_create', {
        mode: opts.mode, guest: guestId ? guestId.slice(0, 8) : undefined, score: opts.score | 0,
        carried: (opts.data && opts.data.carried) | 0, cls: opts.data && opts.data.label, expiresAt,
    }, now);
    return { code, expiresAt };
}

// {code, mode, userId, guestId, ip} -> {ok:true, data, savedBy:{userId, guestId}, id}
//   | {ok:false, reason:'format'|'unknown'|'used'|'expired'|'mode'|'wait', waitMs?}
// 'mode' and 'wait' leave the code as it was.
function restore(opts, now = Date.now()) {
    const d = db.handle();
    if (!d) return { ok: false, reason: 'off' };
    const norm = normalize(opts && opts.code);
    if (!norm) return { ok: false, reason: 'format' };
    const userId = opts.userId | 0 || null;
    const guestId = !userId && GUEST_RE.test(String(opts.guestId || '')) ? String(opts.guestId) : null;
    return d.tx(() => {
        const row = d.get('SELECT id, mode, user_id, guest_id, data, score, created_at, expires_at, used_at FROM saves WHERE code_hash = ?', crypto.sha256(norm));
        if (!row) return { ok: false, reason: 'unknown' };
        if (row.used_at != null) return { ok: false, reason: 'used' };
        if (row.expires_at <= now) return { ok: false, reason: 'expired' };
        if (row.mode !== opts.mode) return { ok: false, reason: 'mode', mode: row.mode };
        const tag = ipTag(d, opts.ip);
        const since = now - RESTORE_GAP_MS;
        const clauses = [], args = [];
        if (userId) { clauses.push('used_user_id = ?'); args.push(userId); }
        if (guestId) { clauses.push('used_guest_id = ?'); args.push(guestId); }
        if (tag) { clauses.push('used_ip = ?'); args.push(tag); }
        if (clauses.length) {
            const last = d.get(`SELECT max(used_at) AS at FROM saves WHERE used_at > ? AND (${clauses.join(' OR ')})`, since, ...args);
            if (last && last.at) return { ok: false, reason: 'wait', waitMs: Math.max(1000, last.at + RESTORE_GAP_MS - now) };
        }
        const ch = d.run('UPDATE saves SET used_at = ?, used_user_id = ?, used_guest_id = ?, used_ip = ? WHERE id = ? AND used_at IS NULL',
            now, userId, guestId, tag, row.id).changes;
        if (!ch) return { ok: false, reason: 'used' };
        let data = null;
        try { data = JSON.parse(row.data); } catch (e) { data = null; }
        audit(d, userId, 'save_restore', {
            save: row.id, mode: row.mode, guest: guestId ? guestId.slice(0, 8) : undefined,
            savedBy: row.user_id || (row.guest_id ? 'guest:' + row.guest_id.slice(0, 8) : null), score: row.score | 0,
            ageMs: now - row.created_at,
        }, now);
        return { ok: true, id: row.id, data, savedBy: { userId: row.user_id || null, guestId: row.guest_id || null } };
    });
}

// Main thread, hourly: codes a month past their end go, IP hashes after a day.
function sweep(now = Date.now()) {
    const d = db.handle();
    if (!d) return null;
    return {
        removed: d.run('DELETE FROM saves WHERE expires_at <= ?', now - KEEP_MS).changes,
        ips: d.run('UPDATE saves SET used_ip = NULL WHERE used_ip IS NOT NULL AND used_at <= ?', now - DAY).changes,
    };
}

module.exports = { TTL_MS, RESTORE_GAP_MS, CODE_LEN, newCode, normalize, create, restore, sweep };
