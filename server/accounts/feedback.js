// Player feedback from the menu (POST /api/feedback, routes/feedback.js).
//
// One row per message in `feedback` (schema v8). Accounts are stored by
// user id, guests by their browser's guest id; no IP address is kept. The
// optional context is a short whitelist of what the client can see (game
// version, browser, screen size, region, server), cleaned here so a
// hand-made request cannot stuff anything else into it.
//
// Each new message is also posted to the private Discord feedback channel
// (DISCORD_FEEDBACK_CHANNEL_ID, else DISCORD_BACKUP_CHANNEL_ID) when the bot
// token is set. That is best effort: a failure is logged at most every 10
// minutes, and a channel Discord says is missing or off limits (404 / 403)
// is left alone for an hour.
'use strict';

const config = require('./config');
const db = require('./db');
const rest = require('./discord/rest');

const MAX_TEXT = 1000;
const MIN_TEXT = 3;
const CATEGORIES = ['bug', 'idea', 'balance', 'other'];
const LABEL = { bug: 'Bug', idea: 'Idea', balance: 'Balance', other: 'Other' };
const COLOR = { bug: 0xe0473b, idea: 0xf5c542, balance: 0x4a9ee0, other: 0x9a93ad };
const LOG_GAP_MS = 10 * 60 * 1000;
const PARK_MS = 60 * 60 * 1000;

// Control characters out (tabs and newlines stay), CRLF to LF, at most two
// blank lines in a row, trimmed.
function cleanText(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

const oneLine = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

// Whatever the client sent -> a small object with only the keys we know.
function cleanContext(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    const put = (key, v) => { if (v) out[key] = v; };
    put('version', oneLine(raw.version, 40));
    put('browser', oneLine(raw.browser, 60));
    const screen = oneLine(raw.screen, 24);
    if (/^\d{2,5}x\d{2,5}(@\d(\.\d{1,2})?x)?$/.test(screen)) out.screen = screen;
    put('region', oneLine(raw.region, 24));
    put('server', oneLine(raw.server, 64));
    const embed = oneLine(raw.embed, 48);
    if (/^[a-z0-9][a-z0-9._-]{0,47}$/.test(embed)) out.embed = embed;
    if (raw.inGame === true) out.inGame = true;
    return out;
}

// {userId?, guestId?, category?, text, context?} -> the new row id.
function add(entry, now = Date.now()) {
    const d = db.handle();
    if (!d) throw new Error('accounts database is not open');
    const r = d.run('INSERT INTO feedback (at, user_id, guest_id, category, text, context) VALUES (?, ?, ?, ?, ?, ?)',
        now, entry.userId || null, entry.userId ? null : (entry.guestId || null),
        CATEGORIES.includes(entry.category) ? entry.category : null,
        entry.text, JSON.stringify(entry.context || {}));
    return Number(r.lastInsertRowid);
}

// Newest first, with the account's current username (null for guests and
// deleted accounts).
function latest(count = 10) {
    const d = db.handle();
    if (!d) return [];
    const n = Math.max(1, Math.min(50, count | 0 || 10));
    return d.all(`SELECT f.*, u.username AS username FROM feedback f
        LEFT JOIN users u ON u.id = f.user_id AND u.deleted_at IS NULL
        ORDER BY f.id DESC LIMIT ?`, n).map(row => {
        let context = {};
        try { context = JSON.parse(row.context) || {}; } catch (e) { context = {}; }
        return { ...row, context };
    });
}

function count() {
    const d = db.handle();
    return d ? d.get('SELECT count(*) AS n FROM feedback').n | 0 : 0;
}

// "ZyroX" | "guest a1b2c3" | "deleted account" | "someone"
function whoText(row, username) {
    if (username) return username;
    if (row.user_id) return 'account #' + row.user_id;
    if (row.guest_id) return 'guest ' + String(row.guest_id).slice(0, 6);
    return 'someone';
}

function contextText(c) {
    if (!c) return '';
    const bits = [];
    if (c.version) bits.push('v' + c.version);
    if (c.browser) bits.push(c.browser);
    if (c.screen) bits.push(c.screen);
    if (c.region) bits.push(c.region);
    if (c.server) bits.push(c.server);
    if (c.embed) bits.push('in ' + c.embed);
    if (c.inGame) bits.push('in game');
    return bits.join(' · ');
}

// Keeps line breaks, unlike rest.escapeMd.
const escapeBlock = s => String(s).split('\n').map(line => rest.escapeMd(line)).join('\n');

function discordMessage(row, username) {
    const cat = row.category || 'other';
    const fields = [{ name: 'From', value: rest.escapeMd(whoText(row, username)), inline: true }];
    const ctx = contextText(row.context);
    if (ctx) fields.push({ name: 'Context', value: rest.escapeMd(ctx).slice(0, 1000), inline: false });
    return {
        embeds: [{
            title: `Feedback: ${row.category ? LABEL[cat] : 'No category'}`,
            color: COLOR[cat],
            description: escapeBlock(row.text).slice(0, 4000),
            fields,
            footer: { text: `#${row.id} · /feedback lists the latest` },
            timestamp: new Date(row.at).toISOString(),
        }],
    };
}

let parkedUntil = 0;
let loggedAt = 0;

function forwardEnabled() {
    const bot = config.discordBot;
    return !!(bot && bot.botToken && bot.feedbackChannelId);
}

// Fire and forget; resolves to true when Discord took it.
async function forward(row, username, now = Date.now()) {
    if (!forwardEnabled() || now < parkedUntil) return false;
    try {
        await rest.sendMessage(config.discordBot.feedbackChannelId, discordMessage(row, username));
        return true;
    } catch (e) {
        if (e && (e.status === 404 || e.status === 403)) parkedUntil = Date.now() + PARK_MS;
        const t = Date.now();
        if (t - loggedAt > LOG_GAP_MS) {
            loggedAt = t;
            console.error('[discord] feedback post failed (check DISCORD_FEEDBACK_CHANNEL_ID / DISCORD_BACKUP_CHANNEL_ID): ' + ((e && e.message) || e));
        }
        return false;
    }
}

// Tests only.
function resetForward() { parkedUntil = 0; loggedAt = 0; }

module.exports = {
    MAX_TEXT, MIN_TEXT, CATEGORIES, LABEL,
    cleanText, cleanContext, add, latest, count, whoText, contextText, discordMessage, forward, forwardEnabled, resetForward,
};
