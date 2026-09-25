// Slash commands: the definitions scripts/discord-register.js uploads, and
// the handlers routes/interactions.js calls.
//
// Admin commands live in DISCORD_ADMIN_GUILD_ID only, registered with
// default_member_permissions "0" (hidden from everyone but server admins),
// and on top of that the caller must be listed in ADMIN_DISCORD_IDS and the
// command must come from that guild. Every admin command, allowed or
// refused, is written to audit_log (actor 'admin:<discord id>'), and every
// admin reply is ephemeral.
//
// Player commands (/profile, /rank, /leaderboard) are global and public.
//
// All work is synchronous SQLite, so every command answers inline (type 4);
// nothing here needs a deferred response.
'use strict';

const config = require('../config');
const db = require('../db');
const bus = require('../bus');
const users = require('../users');
const sessions = require('../sessions');
const rankStore = require('../rankStore');
const achievements = require('../achievements');
const rest = require('./rest');
const R = require('../../../shared/ranks.js');

const T = { STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, NUMBER: 10 };
const EPHEMERAL = 64;
const DAY = 24 * 60 * 60 * 1000;
const PERMANENT = 9e15;          // bridge.js shows "until" only below 8e15
const RESET_TTL_MS = 30 * 60 * 1000;
const MAX_GRANT_MILLI = 100000 * 1000;
const COLOR = 0x3fb6a8;

const userOpt = (description = 'Username, DW- id, or @user') => ({ type: T.STRING, name: 'user', description, required: true, max_length: 64 });
const reasonOpt = (required = true) => ({ type: T.STRING, name: 'reason', description: 'Why (goes in the audit log)', required, max_length: 200 });

const ADMIN_COMMANDS = [
    { name: 'lookup', description: 'Find an account', options: [{ type: T.STRING, name: 'query', description: 'Username, DW- id, or @user', required: true, max_length: 64 }] },
    { name: 'resetpassword', description: 'Make a single-use 30-minute password reset link', options: [userOpt()] },
    {
        name: 'relink', description: 'Set the Discord account linked to a player', options: [
            userOpt(),
            { type: T.USER, name: 'discord', description: 'The Discord account to link', required: true },
            { type: T.BOOLEAN, name: 'force', description: 'Take it from another Corez account that has it', required: false },
        ],
    },
    {
        name: 'grantdust', description: 'Add gemdust (negative claws back, never below 0)', options: [
            userOpt(),
            { type: T.NUMBER, name: 'amount', description: 'Dust, e.g. 5 or -2.5', required: true, min_value: -100000, max_value: 100000 },
            reasonOpt(),
        ],
    },
    {
        name: 'ban', description: 'Ban a player (signs them out everywhere)', options: [
            userOpt(),
            { type: T.STRING, name: 'duration', description: 'How long', required: true, choices: [{ name: '7 days', value: '7d' }, { name: '30 days', value: '30d' }, { name: 'Permanent', value: 'perm' }] },
            reasonOpt(),
        ],
    },
    { name: 'unban', description: 'Lift a ban', options: [userOpt(), reasonOpt(false)] },
].map(c => ({ ...c, type: 1, default_member_permissions: '0', dm_permission: false }));

const PLAYER_COMMANDS = [
    { name: 'profile', description: "See a player's Corez profile", options: [{ type: T.STRING, name: 'username', description: 'Leave empty for your own (linked) account', required: false, max_length: 32 }] },
    { name: 'rank', description: "See a player's Corez rank", options: [{ type: T.STRING, name: 'username', description: 'Leave empty for your own (linked) account', required: false, max_length: 32 }] },
    { name: 'leaderboard', description: 'See the Corez top 10' },
].map(c => ({ ...c, type: 1 }));

const ADMIN_NAMES = new Set(ADMIN_COMMANDS.map(c => c.name));

// ---- helpers ----

function reply(content, opts = {}) {
    const data = { content: String(content || '').slice(0, 1990), allowed_mentions: rest.NO_MENTIONS };
    if (opts.embeds) data.embeds = opts.embeds;
    if (opts.ephemeral) data.flags = EPHEMERAL;
    return { type: 4, data };
}

function callerOf(i) {
    const u = (i.member && i.member.user) || i.user || {};
    return { id: String(u.id || ''), name: String(u.global_name || u.username || '') };
}

function opt(i, name) {
    const o = ((i.data && i.data.options) || []).find(x => x && x.name === name);
    return o ? o.value : undefined;
}

// Username | DW-id | <@id> | raw Discord id -> live user row | null
function resolveUser(query) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return null;
    const m = /^<@!?(\d{5,25})>$/.exec(q) || /^(\d{15,25})$/.exec(q);
    if (m) return users.byDiscordId(m[1]);
    if (/^dw-?/i.test(q)) return users.byPublicId(q);
    return users.byUsername(q.replace(/^@/, ''));
}

const md = s => rest.escapeMd(s);
const ts = (ms, style = 'f') => ms ? `<t:${Math.floor(ms / 1000)}:${style}>` : 'never';
const dustText = milli => ((milli | 0) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });

function rankLine(row) {
    const s = rankStore.snapshot(row);
    if (s.division == null) return `Placement (${s.placement.lives} of ${s.placement.of} games played)`;
    const legend = s.division === R.LEGEND && s.legendNo ? ` #${s.legendNo}` : '';
    const into = s.division === R.LEGEND ? '' : ` · ${Math.floor(s.pct * 100)}% to next`;
    return `${s.name}${legend} (${(s.rp | 0).toLocaleString('en-US')} RP${into})`;
}

function audit(caller, userId, action, detail) {
    try { users.audit(userId || null, action, detail, { actor: 'admin:' + caller.id }); } catch (e) {
        console.error('[discord] audit failed: ' + ((e && e.stack) || e));
    }
}

// ---- admin ----

function lookup(i, caller) {
    const q = String(opt(i, 'query') || '');
    let row = resolveUser(q);
    if (!row && /^dw-?/i.test(q.trim())) {
        // deleted accounts are still here for 30 days (admin restore)
        const code = q.trim().replace(/^dw-?/i, '').toUpperCase();
        row = db.handle().get('SELECT * FROM users WHERE public_id = ?', 'DW-' + code);
    }
    audit(caller, row && row.id, 'admin_lookup', { query: q.slice(0, 64), found: !!row });
    if (!row) return reply('No account matches that.', { ephemeral: true });
    const d = db.handle();
    const live = d.get('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?', row.id, Date.now()).n | 0;
    const lines = [
        `**${md(row.username)}** · \`${row.public_id}\` · internal #${row.id}`,
        `Created ${ts(row.created_at)} · last seen ${ts(row.last_seen_at, 'R')}`,
        `Discord: ${row.discord_id ? `<@${row.discord_id}> (${md(row.discord_name || '?')}, \`${row.discord_id}\`)` : 'not linked'}`,
        `Password: ${row.password_hash ? 'yes' : 'no'} · recovery code: ${row.recovery_hash ? 'yes' : 'no'} · live sessions: ${live}`,
        `Rank: ${rankLine(row)} · dust ${dustText(row.dust_milli)}`,
    ];
    if (row.banned_until && row.banned_until > Date.now()) {
        lines.push(`**Banned** ${row.banned_until >= 8e15 ? 'permanently' : 'until ' + ts(row.banned_until)}${row.ban_reason ? ': ' + md(row.ban_reason) : ''}`);
    }
    if (row.deleted_at) lines.push(`**Deleted** ${ts(row.deleted_at)} (purged 30 days later)`);
    return reply(lines.join('\n'), { ephemeral: true });
}

function resetPassword(i, caller) {
    const row = resolveUser(opt(i, 'user'));
    if (!row) { audit(caller, null, 'admin_reset_link', { query: String(opt(i, 'user') || '').slice(0, 64), found: false }); return reply('No account matches that.', { ephemeral: true }); }
    const d = db.handle();
    // one live link per account: older unused ones stop working
    d.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', row.id);
    const token = users.createResetToken(row.id, 'admin:' + caller.id, RESET_TTL_MS);
    audit(caller, row.id, 'admin_reset_link', { username: row.username });
    const origin = config.publicOrigin;
    return reply([
        `Reset link for **${md(row.username)}** (single use, expires ${ts(Date.now() + RESET_TTL_MS, 'R')}):`,
        `${origin}/#reset=${token}`,
        `If the game page does not show the reset form, this one always works: ${origin}/auth/reset#${token}`,
        'Send it to the player privately. Using it signs out all their other sessions.',
    ].join('\n'), { ephemeral: true });
}

function relink(i, caller) {
    const row = resolveUser(opt(i, 'user'));
    const discordId = String(opt(i, 'discord') || '');
    const force = opt(i, 'force') === true;
    if (!row) return reply('No account matches that.', { ephemeral: true });
    if (!/^\d{5,25}$/.test(discordId)) return reply('Pick a Discord user.', { ephemeral: true });
    const du = (i.data.resolved && i.data.resolved.users && i.data.resolved.users[discordId]) || {};
    const dname = String(du.global_name || du.username || '') || null;
    const d = db.handle();
    const res = d.tx(() => {
        const other = users.byDiscordId(discordId);
        if (other && other.id === row.id) return { same: true };
        if (other && !force) return { taken: other };
        if (other) d.run('UPDATE users SET discord_id = NULL, discord_name = NULL, discord_avatar = NULL WHERE id = ?', other.id);
        d.run('UPDATE users SET discord_id = ?, discord_name = ?, discord_avatar = ? WHERE id = ?',
            discordId, dname, du.avatar ? String(du.avatar) : null, row.id);
        audit(caller, row.id, 'admin_relink', { username: row.username, from: row.discord_id || null, to: discordId, takenFrom: other ? other.public_id : null });
        if (other) audit(caller, other.id, 'admin_relink_removed', { username: other.username, discordId, movedTo: row.public_id });
        return { ok: true, other };
    });
    if (res.same) return reply(`That Discord account is already linked to **${md(row.username)}**.`, { ephemeral: true });
    if (res.taken) {
        audit(caller, row.id, 'admin_relink', { username: row.username, to: discordId, refused: 'taken', by: res.taken.public_id });
        return reply(`That Discord account is linked to **${md(res.taken.username)}** (\`${res.taken.public_id}\`). Run it again with force:true to move it.`, { ephemeral: true });
    }
    return reply(`Linked <@${discordId}> to **${md(row.username)}**${res.other ? ` (removed from **${md(res.other.username)}**)` : ''}${row.discord_id && row.discord_id !== discordId ? `; replaced \`${row.discord_id}\`` : ''}.`, { ephemeral: true });
}

function grantDust(i, caller) {
    const row = resolveUser(opt(i, 'user'));
    const amount = Number(opt(i, 'amount'));
    const reason = String(opt(i, 'reason') || '').trim().slice(0, 200);
    if (!row) return reply('No account matches that.', { ephemeral: true });
    const want = Math.round(amount * 1000);
    if (!Number.isFinite(amount) || !want || Math.abs(want) > MAX_GRANT_MILLI) return reply('Amount must be a non-zero number, up to 100,000 dust.', { ephemeral: true });
    if (!reason) return reply('Please add a reason.', { ephemeral: true });
    const d = db.handle();
    const now = Date.now();
    const res = d.tx(() => {
        const u = d.get('SELECT dust_milli FROM users WHERE id = ? AND deleted_at IS NULL', row.id);
        if (!u) return null;
        const before = u.dust_milli | 0;
        const after = Math.max(0, before + want);
        const delta = after - before;
        if (delta) {
            d.run('UPDATE users SET dust_milli = ? WHERE id = ?', after, row.id);
            d.run('INSERT INTO dust_ledger (user_id, delta_milli, balance_milli, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                row.id, delta, after, 'admin', ('admin:' + caller.id + ':' + reason).slice(0, 240), now);
        }
        audit(caller, row.id, 'admin_grant_dust', { username: row.username, requestedMilli: want, deltaMilli: delta, balanceMilli: after, reason });
        return { before, after, delta };
    });
    if (!res) return reply('No account matches that.', { ephemeral: true });
    if (res.delta) {
        try { bus.toGame({ t: 'dustChanged', userId: row.id }); } catch (e) { /* game gone */ }
        try { require('../routes/events').push(row.id, 'dust', { balanceMilli: res.after, deltaMilli: res.delta, kind: 'admin' }); } catch (e) { /* */ }
    }
    const verb = res.delta >= 0 ? 'Added' : 'Removed';
    const floored = res.delta !== want ? ' (floored at 0)' : '';
    return reply(`${verb} ${dustText(Math.abs(res.delta))} dust ${res.delta >= 0 ? 'to' : 'from'} **${md(row.username)}**${floored}. Balance ${dustText(res.before)} → ${dustText(res.after)}.`, { ephemeral: true });
}

function ban(i, caller) {
    const row = resolveUser(opt(i, 'user'));
    const duration = String(opt(i, 'duration') || '');
    const reason = String(opt(i, 'reason') || '').trim().slice(0, 200);
    if (!row) return reply('No account matches that.', { ephemeral: true });
    const ms = { '7d': 7 * DAY, '30d': 30 * DAY, perm: 0 }[duration];
    if (ms === undefined) return reply('Duration must be 7d, 30d or perm.', { ephemeral: true });
    if (!reason) return reply('Please add a reason.', { ephemeral: true });
    const now = Date.now();
    const until = ms ? now + ms : PERMANENT;
    const d = db.handle();
    const revoked = d.tx(() => {
        d.run('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?', until, reason, row.id);
        const n = sessions.revokeAllForUser(row.id);
        audit(caller, row.id, 'admin_ban', { username: row.username, duration, until, reason, sessionsRevoked: n });
        return n;
    });
    const text = 'This account is banned' + (ms ? ' until ' + new Date(until).toUTCString() : '') + ': ' + reason;
    try { bus.toGame({ t: 'kick', userId: row.id, reason: text }); } catch (e) { /* game gone */ }
    try { require('../routes/profile').clearCache(); } catch (e) { /* */ }
    return reply(`Banned **${md(row.username)}** ${ms ? 'until ' + ts(until) : 'permanently'}. Signed out ${revoked} session${revoked === 1 ? '' : 's'} and kicked them from the game.`, { ephemeral: true });
}

function unban(i, caller) {
    const row = resolveUser(opt(i, 'user'));
    const reason = String(opt(i, 'reason') || '').trim().slice(0, 200);
    if (!row) return reply('No account matches that.', { ephemeral: true });
    const was = row.banned_until && row.banned_until > Date.now();
    db.handle().run('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?', row.id);
    audit(caller, row.id, 'admin_unban', { username: row.username, wasBanned: !!was, previousUntil: row.banned_until || null, reason: reason || null });
    try { require('../routes/profile').clearCache(); } catch (e) { /* */ }
    return reply(was ? `Unbanned **${md(row.username)}**.` : `**${md(row.username)}** wasn't banned (cleared anyway).`, { ephemeral: true });
}

const ADMIN_HANDLERS = { lookup, resetpassword: resetPassword, relink, grantdust: grantDust, ban, unban };

// ---- players ----

function targetFor(i, caller) {
    const name = opt(i, 'username');
    if (name != null && String(name).trim()) {
        const row = resolveUser(name);
        return row ? { row } : { error: "Couldn't find that player." };
    }
    const row = users.byDiscordId(caller.id);
    return row ? { row } : { error: `Your Discord isn't linked to a Corez account. Log in with Discord at ${config.publicOrigin} or pass a username.` };
}

function profile(i, caller) {
    const t = targetFor(i, caller);
    if (t.error) return reply(t.error, { ephemeral: true });
    const row = t.row;
    const s = require('../routes/profile').statsOf(row.id);
    const got = achievements.unlockedSet(row.id).size;
    const snap = rankStore.snapshot(row);
    const n = v => (v | 0).toLocaleString('en-US');
    const embed = {
        title: md(row.username),
        color: COLOR,
        fields: [
            { name: 'Rank', value: rankLine(row), inline: false },
            { name: 'Peak', value: snap.peak.division == null ? '-' : snap.peak.name, inline: true },
            { name: 'Achievements', value: `${got}/${achievements.DEFS.length}`, inline: true },
            { name: 'Games', value: n(s.lives), inline: true },
            { name: 'Knockouts', value: n(s.kills), inline: true },
            { name: 'Raid wins', value: n(s.raidWins), inline: true },
            { name: 'Top 3s', value: n(s.top3), inline: true },
            { name: 'Gems banked', value: n(s.gemsBanked), inline: true },
            { name: 'Best game', value: n(s.bestLife) + ' pts', inline: true },
        ],
        footer: { text: row.public_id + ' · playing since ' + new Date(row.created_at).toISOString().slice(0, 10) },
    };
    return reply('', { embeds: [embed] });
}

function rank(i, caller) {
    const t = targetFor(i, caller);
    if (t.error) return reply(t.error, { ephemeral: true });
    return reply(`**${md(t.row.username)}**: ${rankLine(t.row)}`);
}

function leaderboard() {
    const rows = require('../routes/profile').topRows(Date.now()).slice(0, 10);
    if (!rows.length) return reply("Nobody's ranked yet. Finish your 3 placement games to be first!");
    const lines = rows.map(r => `${r.place}. **${md(r.username)}** · ${r.name}${r.legendNo ? ' #' + r.legendNo : ''} · ${r.rp.toLocaleString('en-US')} RP`);
    return reply('', { embeds: [{ title: 'Corez top 10', color: COLOR, description: lines.join('\n'), footer: { text: 'Full Top 100 at ' + config.publicOrigin } }] });
}

const PLAYER_HANDLERS = { profile, rank, leaderboard };

// ---- entry ----

function isAdmin(i, caller) {
    const bot = config.discordBot;
    return !!caller.id && bot.adminIds.has(caller.id) && !!bot.adminGuildId && String(i.guild_id || '') === bot.adminGuildId;
}

// An APPLICATION_COMMAND interaction -> the interaction response.
function handle(i) {
    const name = String((i.data && i.data.name) || '');
    const caller = callerOf(i);
    if (!db.handle()) return reply('Corez accounts are down right now. Try again later.', { ephemeral: true });
    if (ADMIN_NAMES.has(name)) {
        if (!isAdmin(i, caller)) {
            try {
                users.audit(null, 'admin_denied', { command: name, guildId: i.guild_id || null, discordName: caller.name.slice(0, 64) },
                    { actor: 'discord:' + (caller.id || '?') });
            } catch (e) { /* audit only */ }
            return reply("Sorry, you're not allowed to use this command.", { ephemeral: true });
        }
        return ADMIN_HANDLERS[name](i, caller);
    }
    const fn = PLAYER_HANDLERS[name];
    if (!fn) return reply("I don't know that command.", { ephemeral: true });
    return fn(i, caller);
}

module.exports = { ADMIN_COMMANDS, PLAYER_COMMANDS, ADMIN_NAMES, handle, isAdmin, resolveUser, reply, EPHEMERAL };
