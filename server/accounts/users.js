// Account rows: lookups, creation, renames, credentials, Discord links,
// soft deletion, the public User shape and the audit log.
//
// All reads are synchronous and return raw rows (plain objects) or null, so
// the game thread can call byId / isRegisteredName inline.
'use strict';

const db = require('./db');
const crypto = require('./crypto');
const names = require('./names');

const DAY = 24 * 60 * 60 * 1000;
const RENAME_COOLDOWN_MS = 14 * DAY;
const NAME_HOLD_MS = 30 * DAY;
const RESET_TTL_MS = 30 * 60 * 1000;
const PLACEMENT_LIVES = 3;

function h() { return db.handle(); }

function isUniqueError(e, column) {
    return !!e && /UNIQUE constraint failed/i.test(e.message || '') && (!column || (e.message || '').includes(column));
}

function byId(id, opts = {}) {
    const d = h();
    id = Number(id);
    if (!d || !Number.isInteger(id) || id <= 0) return null;
    return opts.includeDeleted
        ? d.get('SELECT * FROM users WHERE id = ?', id)
        : d.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', id);
}

function byUsername(name) {
    const d = h();
    const lc = String(name == null ? '' : name).trim().toLowerCase();
    if (!d || !lc || lc.length > 16) return null;
    return d.get('SELECT * FROM users WHERE username_lc = ? AND deleted_at IS NULL', lc);
}

// Accepts "DW-7K3Q9X2M", "dw-7k3q9x2m", "7K3Q-9X2M" and Crockford look-alikes.
function byPublicId(publicId) {
    const d = h();
    if (!d) return null;
    const m = /^(?:DW-?)?(.+)$/i.exec(String(publicId == null ? '' : publicId).trim());
    const code = m ? crypto.crockfordNormalize(m[1]) : '';
    if (code.length !== 8 || !crypto.isCrockford(code)) return null;
    return d.get('SELECT * FROM users WHERE public_id = ? AND deleted_at IS NULL', 'DW-' + code);
}

function byDiscordId(discordId) {
    const d = h();
    if (!d || !discordId) return null;
    return d.get('SELECT * FROM users WHERE discord_id = ? AND deleted_at IS NULL', String(discordId));
}

function activeHold(lc, now = Date.now()) {
    const d = h();
    return d ? d.get('SELECT * FROM username_holds WHERE username_lc = ? AND expires_at > ?', lc, now) : null;
}

// Can `forUserId` (null = a new account) take this name? Assumes the name
// already passed names.validateUsername.
// -> {available:true} | {available:false, reason:'taken'|'held'}
function availability(name, forUserId = null, now = Date.now()) {
    const d = h();
    if (!d) return { available: false, reason: 'unavailable' };
    const lc = String(name).toLowerCase();
    const owner = d.get('SELECT id FROM users WHERE username_lc = ?', lc);
    if (owner && owner.id !== forUserId) return { available: false, reason: 'taken' };
    const hold = activeHold(lc, now);
    if (hold && hold.user_id !== forUserId) return { available: false, reason: 'held' };
    return { available: true };
}

// For the guest "~" prefix: a live username, or one still on hold after a
// rename or deletion. Case-insensitive, and look-alikes count: the name is
// folded first (Cyrillic/Greek/fullwidth letters, accents), and usernames
// are ASCII, so their folded form is just their lowercase.
function isRegisteredName(name) {
    const d = h();
    if (!d) return false;
    const lc = names.foldConfusables(String(name == null ? '' : name).trim());
    if (!/^[a-z0-9_]{3,16}$/.test(lc)) return false;
    return !!d.get(
        'SELECT 1 AS x FROM users WHERE username_lc = ? UNION ALL SELECT 1 FROM username_holds WHERE username_lc = ? AND expires_at > ? LIMIT 1',
        lc, lc, Date.now()
    );
}

function holdName(lc, userId, reason, now) {
    h().run(
        `INSERT INTO username_holds (username_lc, user_id, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(username_lc) DO UPDATE SET user_id = excluded.user_id, reason = excluded.reason,
             created_at = excluded.created_at, expires_at = excluded.expires_at`,
        lc, userId, reason, now, now + NAME_HOLD_MS
    );
}

// create({username, passwordHash?, recoveryHash, discord?:{id,name,avatar}, now})
// -> {ok:true, user} | {ok:false, code:'username_taken', reason} | {ok:false, code:'discord_taken'}
function create(opts) {
    const d = h();
    if (!d) throw new Error('accounts database unavailable');
    const now = opts.now || Date.now();
    const discord = opts.discord || null;
    return d.tx(() => {
        const av = availability(opts.username, null, now);
        if (!av.available) return { ok: false, code: 'username_taken', reason: av.reason };
        if (discord && byDiscordId(discord.id)) return { ok: false, code: 'discord_taken' };
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                const r = d.run(
                    `INSERT INTO users (public_id, username, username_lc, password_hash, recovery_hash,
                         discord_id, discord_name, discord_avatar, created_at, last_seen_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    crypto.newPublicId(), opts.username, opts.username.toLowerCase(),
                    opts.passwordHash || null, opts.recoveryHash || null,
                    discord ? String(discord.id) : null, discord ? discord.name || null : null, discord ? discord.avatar || null : null,
                    now, now
                );
                d.run('INSERT INTO user_stats (user_id, updated_at) VALUES (?, ?)', r.lastInsertRowid, now);
                return { ok: true, user: byId(r.lastInsertRowid) };
            } catch (e) {
                if (isUniqueError(e, 'users.public_id')) continue;   // 1 in 2^40 per existing account
                if (isUniqueError(e, 'users.username_lc')) return { ok: false, code: 'username_taken', reason: 'taken' };
                if (isUniqueError(e, 'users.discord_id')) return { ok: false, code: 'discord_taken' };
                throw e;
            }
        }
        throw new Error('could not allocate a unique public id');
    });
}

// Epoch ms when the next rename is allowed (0 = any time).
function nextRenameAt(user) {
    return user && user.username_changed_at ? user.username_changed_at + RENAME_COOLDOWN_MS : 0;
}

// The old name is held for 30 days; only this user can take it back.
// -> {ok:true, user, previous} | {ok:false, code:'cooldown', availableAt} | {ok:false, code:'username_taken', reason}
function rename(userId, newName, opts = {}) {
    const d = h();
    const now = opts.now || Date.now();
    return d.tx(() => {
        const u = byId(userId);
        if (!u) return { ok: false, code: 'not_found' };
        if (u.username === newName) return { ok: true, user: u, previous: u.username, unchanged: true };
        const next = nextRenameAt(u);
        if (next > now) return { ok: false, code: 'cooldown', availableAt: next };
        const newLc = newName.toLowerCase();
        const av = availability(newName, u.id, now);
        if (!av.available) return { ok: false, code: 'username_taken', reason: av.reason };
        d.run('UPDATE users SET username = ?, username_lc = ?, username_changed_at = ? WHERE id = ?', newName, newLc, now, u.id);
        d.run('DELETE FROM username_holds WHERE username_lc = ?', newLc);
        if (u.username_lc !== newLc) holdName(u.username_lc, u.id, 'rename', now);
        audit(u.id, 'username_change', { from: u.username, to: newName }, opts);
        return { ok: true, user: byId(u.id), previous: u.username };
    });
}

function setPassword(userId, passwordHash) {
    return h().run('UPDATE users SET password_hash = ? WHERE id = ? AND deleted_at IS NULL', passwordHash, userId).changes > 0;
}

// With expectRecoveryHash the update only lands if the stored hash is still
// that value, so one recovery code can only ever be redeemed once.
function setRecovery(userId, recoveryHash, expectRecoveryHash) {
    const d = h();
    if (expectRecoveryHash === undefined) {
        return d.run('UPDATE users SET recovery_hash = ? WHERE id = ? AND deleted_at IS NULL', recoveryHash, userId).changes > 0;
    }
    return d.run('UPDATE users SET recovery_hash = ? WHERE id = ? AND deleted_at IS NULL AND recovery_hash IS ?',
        recoveryHash, userId, expectRecoveryHash).changes > 0;
}

// A different Discord already on the account is never replaced: the owner
// unlinks it first, which takes the password.
// -> {ok:true, previous:discordId|null} | {ok:false, code:'discord_taken'|'already_linked'|'not_found'}
function linkDiscord(userId, discord, opts = {}) {
    const d = h();
    return d.tx(() => {
        const u = byId(userId);
        if (!u) return { ok: false, code: 'not_found' };
        if (u.discord_id && u.discord_id !== String(discord.id)) return { ok: false, code: 'already_linked' };
        const other = byDiscordId(discord.id);
        if (other && other.id !== u.id) return { ok: false, code: 'discord_taken' };
        d.run('UPDATE users SET discord_id = ?, discord_name = ?, discord_avatar = ? WHERE id = ?',
            String(discord.id), discord.name || null, discord.avatar || null, u.id);
        if (u.discord_id !== String(discord.id)) {
            audit(u.id, 'discord_link', { discordId: String(discord.id), previous: u.discord_id || null }, opts);
        }
        return { ok: true, previous: u.discord_id || null };
    });
}

function unlinkDiscord(userId, opts = {}) {
    const d = h();
    return d.tx(() => {
        const u = byId(userId);
        if (!u || !u.discord_id) return false;
        d.run('UPDATE users SET discord_id = NULL, discord_name = NULL, discord_avatar = NULL WHERE id = ?', u.id);
        audit(u.id, 'discord_unlink', { discordId: u.discord_id }, opts);
        return true;
    });
}

function updateDiscordProfile(userId, name, avatar) {
    h().run('UPDATE users SET discord_name = ?, discord_avatar = ? WHERE id = ?', name || null, avatar || null, userId);
}

function touchSeen(userId, now = Date.now()) {
    const d = h();
    if (d) d.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, userId);
}

// Soft delete: the row stays 30 days (admin restore), then the sweep removes
// it. The name is held so nobody can impersonate the account meanwhile, the
// Discord account is freed, and sessions and social links go now.
function softDelete(userId, opts = {}) {
    const d = h();
    const now = opts.now || Date.now();
    return d.tx(() => {
        const u = byId(userId);
        if (!u) return false;
        holdName(u.username_lc, u.id, 'delete', now);
        d.run(`UPDATE users SET deleted_at = ?, username_lc = '#del:' || id,
                   discord_id = NULL, discord_name = NULL, discord_avatar = NULL WHERE id = ?`, now, u.id);
        d.run('DELETE FROM sessions WHERE user_id = ?', u.id);
        d.run('DELETE FROM password_resets WHERE user_id = ?', u.id);
        d.run('DELETE FROM friendships WHERE user_lo = ? OR user_hi = ?', u.id, u.id);
        d.run('DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?', u.id, u.id);
        d.run('DELETE FROM blocks WHERE blocker_id = ?', u.id);
        audit(u.id, 'account_delete', { username: u.username, discordId: u.discord_id || null }, opts);
        return true;
    });
}

// Single-use admin reset link token (Phase 5 hands these out from Discord).
function createResetToken(userId, createdBy = 'system', ttlMs = RESET_TTL_MS, now = Date.now()) {
    const token = crypto.randomToken(32);
    h().run('INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        crypto.sha256(token), userId, createdBy, now, now + ttlMs);
    return token;
}

// The live user a still-valid reset token belongs to, without using it up.
function peekResetToken(token, now = Date.now()) {
    const d = h();
    if (!d || typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    const r = d.get('SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', crypto.sha256(token), now);
    return r ? byId(r.user_id) : null;
}

// Marks it used; false if it was used or expired in the meantime.
function consumeResetToken(token, now = Date.now()) {
    return h().run('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
        now, crypto.sha256(token), now).changes > 0;
}

// opts: {ip, actor:'self'|'system'|'admin:<id>'}
function audit(userId, action, detail, opts = {}) {
    const d = h();
    if (!d) return;
    d.run('INSERT INTO audit_log (at, user_id, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
        opts.now || Date.now(), userId || null, opts.actor || 'self', action,
        detail == null ? null : JSON.stringify(detail), opts.ip || null);
}

function discordAvatarUrl(discordId, avatar) {
    if (!discordId || !avatar || !/^\d{5,25}$/.test(String(discordId)) || !/^(a_)?[0-9a-f]{32}$/.test(String(avatar))) return null;
    return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=64`;
}

// The User object every account endpoint returns. Rank, dust and equipped
// are Phase 1 placeholders read from their real columns (all defaults for
// now); the shape is final.
function toPublic(row, now = Date.now()) {
    if (!row) return null;
    const next = nextRenameAt(row);
    return {
        userId: row.public_id,
        username: row.username,
        hasPassword: !!row.password_hash,
        discord: row.discord_id ? {
            id: row.discord_id,
            name: row.discord_name || null,
            avatarUrl: discordAvatarUrl(row.discord_id, row.discord_avatar),
        } : null,
        createdAt: row.created_at,
        usernameChangeAt: next > now ? next : 0,
        rank: {
            division: null,
            name: 'Unranked',
            placement: { done: false, lives: Math.min(PLACEMENT_LIVES, row.placement_lives | 0), of: PLACEMENT_LIVES },
        },
        dust: (Number(row.dust_milli) || 0) / 1000,
        refundTokens: row.refund_tokens == null ? 3 : row.refund_tokens,
        equipped: {
            nameStyle: row.equip_name_style || null,
            skin: row.equip_skin || null,
            customColor: row.custom_color || null,
        },
    };
}

function isBanned(row, now = Date.now()) {
    return !!row && row.banned_until != null && row.banned_until > now;
}

module.exports = {
    RENAME_COOLDOWN_MS,
    NAME_HOLD_MS,
    byId,
    byUsername,
    byPublicId,
    byDiscordId,
    availability,
    isRegisteredName,
    create,
    nextRenameAt,
    rename,
    setPassword,
    setRecovery,
    linkDiscord,
    unlinkDiscord,
    updateDiscordProfile,
    touchSeen,
    softDelete,
    createResetToken,
    peekResetToken,
    consumeResetToken,
    audit,
    discordAvatarUrl,
    toPublic,
    isBanned,
};
