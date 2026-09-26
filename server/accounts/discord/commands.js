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
            { type: T.BOOLEAN, name: 'force', description: 'Take it from another Corez.io account that has it', required: false },
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
    {
        name: 'users', description: 'List every account', options: [
            {
                type: T.STRING, name: 'sort', description: 'Order (default: newest)', required: false, choices: [
                    { name: 'Newest', value: 'new' }, { name: 'Last seen', value: 'seen' },
                    { name: 'Rank points', value: 'rp' }, { name: 'Gemdust', value: 'dust' },
                ],
            },
            { type: T.INTEGER, name: 'page', description: 'Page (20 per page)', required: false, min_value: 1, max_value: 10000 },
        ],
    },
    {
        name: 'history', description: "A player's records", options: [
            userOpt(),
            {
                type: T.STRING, name: 'what', description: 'Which records (default: gemdust)', required: false, choices: [
                    { name: 'Gemdust changes', value: 'dust' }, { name: 'Purchases and gifts', value: 'buys' },
                    { name: 'Games (ranked lives)', value: 'games' }, { name: 'Raid finishes', value: 'raids' },
                    { name: 'Items owned', value: 'items' }, { name: 'Audit log', value: 'audit' },
                ],
            },
        ],
    },
    { name: 'stats', description: 'Totals: accounts, activity, gemdust, purchases' },
].map(c => ({ ...c, type: 1, default_member_permissions: '0', dm_permission: false }));

const PLAYER_COMMANDS = [
    { name: 'profile', description: "See a player's Corez.io profile", options: [{ type: T.STRING, name: 'username', description: 'Leave empty for your own (linked) account', required: false, max_length: 32 }] },
    { name: 'rank', description: "See a player's Corez.io rank", options: [{ type: T.STRING, name: 'username', description: 'Leave empty for your own (linked) account', required: false, max_length: 32 }] },
    { name: 'leaderboard', description: 'See the Corez.io top 10' },
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

// ---- admin: browsing the data ----

const PAGE = 20;
const cosmeticName = id => { try { const it = require('../../../shared/cosmetics.js').byId(id); return it ? it.name : id; } catch (e) { return id; } };
const shortDiv = row => { const s = rankStore.snapshot(row); return s.division == null ? 'Placement' : s.name; };
const presenceOf = id => { try { return require('../presence').get(id).state; } catch (e) { return 'offline'; } };
const STATE_ICON = { raid: '🟢 raid', menu: '🟡 menu', offline: '' };

function listUsers(i, caller) {
    const sort = String(opt(i, 'sort') || 'new');
    const order = { new: 'created_at DESC', seen: 'COALESCE(last_seen_at, 0) DESC', rp: 'rp DESC', dust: 'dust_milli DESC' }[sort] || 'created_at DESC';
    const d = db.handle();
    const total = d.get('SELECT count(*) AS n FROM users WHERE deleted_at IS NULL').n | 0;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const page = Math.min(pages, Math.max(1, (opt(i, 'page') | 0) || 1));
    const rows = d.all(`SELECT * FROM users WHERE deleted_at IS NULL ORDER BY ${order}, id LIMIT ? OFFSET ?`, PAGE, (page - 1) * PAGE);
    audit(caller, null, 'admin_list_users', { sort, page });
    if (!rows.length) return reply('No accounts yet.', { ephemeral: true });
    const lines = rows.map((r, k) => {
        const st = STATE_ICON[presenceOf(r.id)];
        const ban = r.banned_until && r.banned_until > Date.now() ? ' · **banned**' : '';
        return `${(page - 1) * PAGE + k + 1}. **${md(r.username)}** \`${r.public_id}\`${r.discord_id ? ' · <@' + r.discord_id + '>' : ''}` +
            ` · ${shortDiv(r)} · ${dustText(r.dust_milli)} dust · seen ${ts(r.last_seen_at, 'R')}${st ? ' · ' + st : ''}${ban}`;
    });
    return reply('', {
        ephemeral: true, embeds: [{
            title: `Accounts (${total.toLocaleString('en-US')})`, color: COLOR,
            description: lines.join('\n').slice(0, 4000),
            footer: { text: `Page ${page} of ${pages} · sorted by ${{ new: 'newest', seen: 'last seen', rp: 'rank points', dust: 'gemdust' }[sort] || 'newest'} · guests are not stored` },
        }],
    });
}

function history(i, caller) {
    const row = resolveUser(opt(i, 'user'));
    const what = String(opt(i, 'what') || 'dust');
    audit(caller, row && row.id, 'admin_history', { query: String(opt(i, 'user') || '').slice(0, 64), what, found: !!row });
    if (!row) return reply('No account matches that.', { ephemeral: true });
    const d = db.handle();
    const signed = m => (m > 0 ? '+' : m < 0 ? '−' : '') + dustText(Math.abs(m));
    let title, lines, extra = '';
    if (what === 'buys') {
        title = 'Purchases and gifts';
        const rs = d.all(`SELECT p.*, b.username AS buyer, r.username AS recipient FROM purchases p
            JOIN users b ON b.id = p.user_id LEFT JOIN users r ON r.id = p.recipient_id
            WHERE p.user_id = ? OR p.recipient_id = ? ORDER BY p.created_at DESC LIMIT 25`, row.id, row.id);
        lines = rs.map(p => {
            const who = p.is_gift ? (p.user_id === row.id ? ` → gift to **${md(p.recipient || 'deleted')}**` : ` ← gift from **${md(p.buyer)}**`) : '';
            return `${ts(p.created_at, 'd')} **${md(cosmeticName(p.item_id))}** · ${dustText(p.price_milli)} dust${who}${p.refunded_at ? ' · refunded ' + ts(p.refunded_at, 'd') : ''}`;
        });
    } else if (what === 'games') {
        title = 'Games (ranked lives)';
        const rs = d.all('SELECT * FROM rank_lives WHERE user_id = ? ORDER BY started_at DESC LIMIT 20', row.id);
        lines = rs.map(l => `${ts(l.started_at, 'd')} ${l.ended_at ? l.end_reason || 'ended' : '**playing**'} · ${(l.basis | 0).toLocaleString('en-US')} pts · ${l.kills | 0} KOs (${l.bot_kills | 0} bots)` +
            ` · RP ${l.rp_before}${l.rp_after == null ? '' : ' → ' + l.rp_after}${l.placement ? ' · placement' : ''}${l.dust_milli ? ' · ' + dustText(l.dust_milli) + ' dust' : ''}`);
    } else if (what === 'raids') {
        title = 'Raid finishes';
        const rs = d.all('SELECT * FROM raid_results WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', row.id);
        lines = rs.map(r => `${ts(r.created_at, 'd')} **#${r.place}** of ${r.board_rows} · ${(r.score | 0).toLocaleString('en-US')} pts · ${Math.round(r.raid_ms / 60000)} min` +
            `${r.rp_bonus ? ' · +' + r.rp_bonus + ' RP' : ''}${r.dust_milli ? ' · +' + dustText(r.dust_milli) + ' dust' : ''}`);
    } else if (what === 'items') {
        title = 'Items owned';
        const rs = d.all('SELECT * FROM owned_items WHERE user_id = ? ORDER BY acquired_at DESC', row.id);
        lines = rs.map(o => `**${md(cosmeticName(o.item_id))}** · ${o.source} · ${ts(o.acquired_at, 'd')}`);
        extra = `Wearing: ${row.equip_name_style ? cosmeticName(row.equip_name_style) : 'no name style'}, ${row.equip_skin ? cosmeticName(row.equip_skin) : 'no skin'}${row.custom_color ? ' · colour ' + row.custom_color : ''}`;
    } else if (what === 'audit') {
        title = 'Audit log';
        const rs = d.all('SELECT at, actor, action, detail FROM audit_log WHERE user_id = ? ORDER BY at DESC LIMIT 20', row.id);
        lines = rs.map(a => {
            let det = '';
            try { const o = JSON.parse(a.detail || 'null'); if (o && typeof o === 'object') det = Object.entries(o).filter(([k]) => !/hash|token|ip|secret/i.test(k)).slice(0, 4).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', '); } catch (e) { /* */ }
            return `${ts(a.at, 'd')} \`${a.action}\`${a.actor !== 'self' ? ' by ' + (/^admin:\d+$/.test(a.actor) ? '<@' + a.actor.slice(6) + '>' : md(a.actor)) : ''}${det ? ' · ' + md(det).slice(0, 120) : ''}`;
        });
    } else {
        title = 'Gemdust changes';
        const rs = d.all('SELECT * FROM dust_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 25', row.id);
        lines = rs.map(l => `${ts(l.created_at, 'd')} **${signed(l.delta_milli)}** ${l.kind} → ${dustText(l.balance_milli)}`);
        const sum = d.get(`SELECT COALESCE(SUM(CASE WHEN delta_milli > 0 THEN delta_milli END), 0) AS earned,
            COALESCE(-SUM(CASE WHEN delta_milli < 0 THEN delta_milli END), 0) AS spent, count(*) AS n FROM dust_ledger WHERE user_id = ?`, row.id);
        extra = `Balance ${dustText(row.dust_milli)} · earned ${dustText(sum.earned)} · spent ${dustText(sum.spent)} · ${sum.n} changes`;
    }
    return reply('', {
        ephemeral: true, embeds: [{
            title: `${md(row.username)} · ${title}`, color: COLOR,
            description: ((extra ? extra + '\n\n' : '') + (lines.length ? lines.join('\n') : 'Nothing yet.')).slice(0, 4000),
            footer: { text: row.public_id + (lines.length >= 20 ? ' · newest first, latest entries only' : '') },
        }],
    });
}

function stats(i, caller) {
    const d = db.handle(), now = Date.now();
    const one = (sql, ...a) => d.get(sql, ...a) || {};
    const acc = one(`SELECT count(*) AS n, COALESCE(SUM(discord_id IS NOT NULL), 0) AS discord, COALESCE(SUM(password_hash IS NOT NULL), 0) AS pw,
        COALESCE(SUM(created_at > ?), 0) AS new1, COALESCE(SUM(created_at > ?), 0) AS new7,
        COALESCE(SUM(last_seen_at > ?), 0) AS act1, COALESCE(SUM(last_seen_at > ?), 0) AS act7,
        COALESCE(SUM(dust_milli), 0) AS dust, COALESCE(SUM(banned_until > ?), 0) AS banned
        FROM users WHERE deleted_at IS NULL`, now - DAY, now - 7 * DAY, now - DAY, now - 7 * DAY, now);
    const buys = one('SELECT count(*) AS n, COALESCE(SUM(price_milli), 0) AS dust, COALESCE(SUM(is_gift), 0) AS gifts, COALESCE(SUM(refunded_at IS NOT NULL), 0) AS refunds FROM purchases');
    const earned = one("SELECT COALESCE(SUM(delta_milli), 0) AS m FROM dust_ledger WHERE delta_milli > 0 AND kind <> 'refund'");
    const lives = one('SELECT count(*) AS n, COALESCE(SUM(started_at > ?), 0) AS day FROM rank_lives', now - DAY);
    let online = { raid: 0, menu: 0 };
    try {
        const p = require('../presence');
        for (const r of d.all('SELECT id FROM users WHERE deleted_at IS NULL AND last_seen_at > ?', now - DAY)) {
            const st = p.get(r.id).state; if (online[st] != null) online[st]++;
        }
    } catch (e) { /* */ }
    const n = v => (v | 0).toLocaleString('en-US');
    audit(caller, null, 'admin_stats', {});
    return reply('', {
        ephemeral: true, embeds: [{
            title: 'Corez.io stats', color: COLOR, fields: [
                { name: 'Accounts', value: `${n(acc.n)} (${n(acc.discord)} Discord, ${n(acc.pw)} password)`, inline: false },
                { name: 'New', value: `${n(acc.new1)} today · ${n(acc.new7)} this week`, inline: true },
                { name: 'Active', value: `${n(acc.act1)} today · ${n(acc.act7)} this week`, inline: true },
                { name: 'Online now', value: `${n(online.raid)} in a raid · ${n(online.menu)} in the menu`, inline: false },
                { name: 'Gemdust', value: `${dustText(acc.dust)} held · ${dustText(earned.m)} ever earned`, inline: false },
                { name: 'Purchases', value: `${n(buys.n)} (${n(buys.gifts)} gifts, ${n(buys.refunds)} refunded) · ${dustText(buys.dust)} dust spent`, inline: false },
                { name: 'Games', value: `${n(lives.n)} total · ${n(lives.day)} today`, inline: true },
                { name: 'Banned', value: n(acc.banned), inline: true },
            ],
            footer: { text: 'Accounts only; guests are not stored' },
        }],
    });
}

const ADMIN_HANDLERS = { lookup, resetpassword: resetPassword, relink, grantdust: grantDust, ban, unban, users: listUsers, history, stats };

// ---- players ----

function targetFor(i, caller) {
    const name = opt(i, 'username');
    if (name != null && String(name).trim()) {
        const row = resolveUser(name);
        return row ? { row } : { error: "Couldn't find that player." };
    }
    const row = users.byDiscordId(caller.id);
    return row ? { row } : { error: `Your Discord isn't linked to a Corez.io account. Log in with Discord at ${config.publicOrigin} or pass a username.` };
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
    return reply('', { embeds: [{ title: 'Corez.io top 10', color: COLOR, description: lines.join('\n'), footer: { text: 'Full Top 100 at ' + config.publicOrigin } }] });
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
    if (!db.handle()) return reply('Corez.io accounts are down right now. Try again later.', { ephemeral: true });
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
