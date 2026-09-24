// Nightly encrypted database backups (main thread).
//
// When: every day at BACKUP_HOUR_UTC (default 3), and 5 minutes after boot
// if the last backup is more than 26 hours old. Off unless
// BACKUP_ENCRYPTION_KEY is a valid 32-byte key.
//
// Steps:
//   1. VACUUM INTO a temp file (a consistent online copy, WAL safe)
//   2. PRAGMA integrity_check on the copy (read-only); anything but "ok" aborts
//   3. gzip
//   4. AES-256-GCM, file format  "DWB1" | iv (12) | tag (16) | ciphertext
//      with "DWB1" as the additional authenticated data
//   5. data/backups/digwars-YYYYMMDD-HHMMSSZ.dwb (0600), then rotation keeps
//      the newest per day for 14 days, per ISO week for 8 weeks and per
//      month for 6 months (only files named like ours are ever touched;
//      pre-migration copies are left alone)
//   6. upload to DISCORD_BACKUP_CHANNEL_ID when the bot token is set, split
//      into 9 MB parts (name.dwb.part1of3, ...) so each fits a message
// meta keys: backup_last_at, backup_last_file, backup_last_bytes,
// backup_last_sha256, backup_last_upload_at.
//
// scripts/restore-backup.js reverses it (decrypt, gunzip, integrity check).
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const nodeCrypto = require('crypto');
const { promisify } = require('util');

const config = require('./config');
const db = require('./db');

const MAGIC = Buffer.from('DWB1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN + TAG_LEN;
const PART_BYTES = 9 * 1024 * 1024;
const NAME_RE = /^digwars-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z\.dwb$/;
const KEEP = { daily: 14, weekly: 8, monthly: 6 };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const STALE_MS = 26 * HOUR;
const BOOT_DELAY_MS = 5 * 60 * 1000;
const CHECK_MS = 60 * 1000;

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ---- pure: format ----

function encrypt(plain, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('backup key must be 32 bytes');
    const iv = nodeCrypto.randomBytes(IV_LEN);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(MAGIC);
    const data = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), data]);
}

// Throws on a wrong key, a truncated file or any tampering.
function decrypt(buf, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('backup key must be 32 bytes');
    if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('not a Dig Wars backup (missing DWB1 header)');
    }
    const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = buf.subarray(MAGIC.length + IV_LEN, HEADER_LEN);
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(MAGIC);
    d.setAuthTag(tag);
    try {
        return Buffer.concat([d.update(buf.subarray(HEADER_LEN)), d.final()]);
    } catch (e) {
        throw new Error('backup failed authentication: wrong BACKUP_ENCRYPTION_KEY, or the file is damaged');
    }
}

async function pack(dbBytes, key) { return encrypt(await gzip(dbBytes, { level: 9 }), key); }
async function unpack(fileBytes, key) { return gunzip(decrypt(fileBytes, key)); }

function splitParts(buf, size = PART_BYTES) {
    const out = [];
    for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(buf.length, i + size)));
    return out.length ? out : [buf];
}

// Read-only integrity check of a database file. -> 'ok' or the problems
function integrityCheck(file) {
    let raw = null;
    try {
        try {
            const { DatabaseSync } = require('node:sqlite');
            raw = new DatabaseSync(file, { readOnly: true });
        } catch (e) {
            const Better = require('better-sqlite3');
            raw = new Better(file, { readonly: true, fileMustExist: true });
        }
        const rows = raw.prepare('PRAGMA integrity_check').all();
        return rows.map(r => Object.values(r)[0]).join('; ') || 'no result';
    } finally {
        try { if (raw) raw.close(); } catch (e) { /* */ }
    }
}

// ---- pure: names and rotation ----

function fileName(ms) {
    const iso = new Date(ms).toISOString();   // 2026-09-24T03:00:00.000Z
    return `digwars-${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z.dwb`;
}

function timeOf(name) {
    const m = NAME_RE.exec(name);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// Grandfather-father-son. -> names to delete
function planRotation(names, keep = KEEP) {
    const list = names.map(n => ({ n, t: timeOf(n) })).filter(x => x.t != null).sort((a, b) => b.t - a.t);
    const keepSet = new Set();
    const pick = (keyOf, count) => {
        const seen = new Set();
        for (const x of list) {
            const k = keyOf(x.t);
            if (seen.has(k)) continue;
            if (seen.size >= count) break;
            seen.add(k);
            keepSet.add(x.n);
        }
    };
    pick(t => Math.floor(t / DAY), keep.daily);
    pick(t => Math.floor((Math.floor(t / DAY) + 3) / 7), keep.weekly);   // ISO weeks start Monday
    pick(t => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }, keep.monthly);
    return list.filter(x => !keepSet.has(x.n)).map(x => x.n);
}

function rotate(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const del = planRotation(names);
    for (const n of del) {
        try { fs.unlinkSync(path.join(dir, n)); } catch (e) { console.error('[backup] could not remove ' + n + ': ' + e.message); }
    }
    return del;
}

// ---- meta ----

function metaGet(key) {
    const d = db.handle();
    const r = d ? d.get('SELECT value FROM meta WHERE key = ?', key) : null;
    return r ? r.value : null;
}
function metaSet(key, value) {
    const d = db.handle();
    if (d) d.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value == null ? null : String(value));
}
function lastBackupAt() { return Number(metaGet('backup_last_at')) || 0; }

// ---- the run ----

const state = { running: null, timers: [], lastError: null };

function human(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function upload(file, bytes, when, sha) {
    const bot = config.discordBot;
    if (!bot.botToken || !bot.backupChannelId) return false;
    const rest = require('./discord/rest');
    const name = path.basename(file);
    const parts = splitParts(bytes);
    for (let k = 0; k < parts.length; k++) {
        const partName = parts.length > 1 ? `${name}.part${k + 1}of${parts.length}` : name;
        const text = `Dig Wars backup ${new Date(when).toISOString().replace('.000', '')} · ${human(bytes.length)} · sha256 \`${sha.slice(0, 16)}\`` +
            (parts.length > 1 ? ` · part ${k + 1}/${parts.length}` : '');
        await rest.sendFile(bot.backupChannelId, text, partName, parts[k]);
    }
    return true;
}

// -> {file, bytes, sha256, uploaded, rotated} ; throws on failure.
// opts: {now, upload:false to skip Discord, dir}
async function runBackup(opts = {}) {
    if (state.running) return state.running;
    state.running = (async () => {
        const d = db.handle();
        if (!d) throw new Error('database unavailable');
        const key = opts.key || config.backupKey;
        if (!key) throw new Error('BACKUP_ENCRYPTION_KEY is not set');
        const now = opts.now || Date.now();
        const dir = opts.dir || config.backupDir;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = path.join(dir, `.tmp-backup-${process.pid}-${now}.db`);
        const out = path.join(dir, fileName(now));
        try {
            try { fs.unlinkSync(tmp); } catch (e) { /* not there */ }
            d.backupTo(tmp);
            const check = integrityCheck(tmp);
            if (check !== 'ok') throw new Error('integrity_check on the copy failed: ' + check.slice(0, 300));
            const packed = await pack(await fs.promises.readFile(tmp), key);
            const partial = out + '.partial';
            await fs.promises.writeFile(partial, packed, { mode: 0o600 });
            await fs.promises.rename(partial, out);
            const sha = nodeCrypto.createHash('sha256').update(packed).digest('hex');
            metaSet('backup_last_at', now);
            metaSet('backup_last_file', path.basename(out));
            metaSet('backup_last_bytes', packed.length);
            metaSet('backup_last_sha256', sha);
            const rotated = rotate(dir);
            try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* busy: next time */ }
            let uploaded = false;
            if (opts.upload !== false) {
                try {
                    uploaded = await upload(out, packed, now, sha);
                    if (uploaded) metaSet('backup_last_upload_at', Date.now());
                } catch (e) {
                    console.error('[backup] upload to Discord failed (the local copy is kept): ' + ((e && e.message) || e));
                }
            }
            console.log(`[backup] wrote ${path.basename(out)} (${human(packed.length)})${uploaded ? ', uploaded to Discord' : ''}${rotated.length ? `, rotated out ${rotated.length}` : ''}`);
            state.lastError = null;
            return { file: out, bytes: packed.length, sha256: sha, uploaded, rotated };
        } finally {
            try { fs.unlinkSync(tmp); } catch (e) { /* gone */ }
        }
    })();
    try {
        return await state.running;
    } catch (e) {
        state.lastError = (e && e.message) || String(e);
        throw e;
    } finally {
        state.running = null;
    }
}

function safeRun(why) {
    runBackup().catch(e => console.error(`[backup] ${why} backup failed: ` + ((e && e.stack) || e)));
}

// Hourly slot check + the boot catch-up. -> true if scheduled
function start() {
    if (config.backupKeyError) console.error('[backup] ' + config.backupKeyError);
    if (!config.backupKey || state.timers.length) return false;
    const hour = config.backupHourUtc;
    const tick = () => {
        const now = Date.now();
        if (new Date(now).getUTCHours() !== hour) return;
        if (Math.floor(lastBackupAt() / DAY) === Math.floor(now / DAY)) return;   // already have today's
        safeRun('nightly');
    };
    const iv = setInterval(tick, CHECK_MS);
    const boot = setTimeout(() => {
        if (Date.now() - lastBackupAt() > STALE_MS) safeRun('catch-up');
    }, BOOT_DELAY_MS);
    for (const t of [iv, boot]) { if (t.unref) t.unref(); state.timers.push(t); }
    console.log(`[backup] nightly encrypted backups at ${String(hour).padStart(2, '0')}:00 UTC to ${config.backupDir}` +
        (config.discordBot.botToken && config.discordBot.backupChannelId ? ' and the Discord backup channel' : ' (no Discord upload: bot token or channel unset)'));
    return true;
}

function stop() {
    for (const t of state.timers) { clearInterval(t); clearTimeout(t); }
    state.timers = [];
}

module.exports = {
    MAGIC, HEADER_LEN, PART_BYTES, KEEP,
    encrypt, decrypt, pack, unpack, splitParts, integrityCheck, fileName, timeOf, planRotation, rotate,
    runBackup, lastBackupAt, start, stop, state,
};
