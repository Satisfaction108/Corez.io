// Guest tracking for the admin commands: one row per browser that played
// without an account (guestId: 32 hex chars from the client's localStorage).
// Everything here is best effort; a failed write never touches the game.
'use strict';

const db = require('./db');

const ID_RE = /^[a-f0-9]{32}$/;
const valid = id => typeof id === 'string' && ID_RE.test(id);

function run(fn) {
    const d = db.handle();
    if (!d) return;
    try { fn(d); } catch (e) { console.error('[accounts] guest tracking: ' + ((e && e.message) || e)); }
}

// Where the browser first came from: a bare site name, optionally marked as
// shown inside that site's iframe. Anything else is dropped.
const SOURCE_RE = /^(embed:)?[a-z0-9][a-z0-9._-]{0,47}$/;
const cleanSource = s => (typeof s === 'string' && SOURCE_RE.test(s) ? s : null);

// A guest socket connected (one visit per connection). The source is only
// kept from the first time it is known (first touch).
function seen(guestId, now = Date.now(), source = null) {
    if (!valid(guestId)) return;
    const src = cleanSource(source);
    run(d => d.run(`INSERT INTO guests (guest_id, first_seen, last_seen, visits, source) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(guest_id) DO UPDATE SET last_seen = excluded.last_seen, visits = visits + 1,
        source = COALESCE(guests.source, excluded.source)`, guestId, now, now, src));
}

function named(guestId, name, now = Date.now()) {
    if (!valid(guestId)) return;
    const n = String(name || '').slice(0, 32) || null;
    run(d => d.run('UPDATE guests SET name = COALESCE(?, name), last_seen = ? WHERE guest_id = ?', n, now, guestId));
}

// One finished life: {score, kills, botKills, ms}
function life(guestId, r, now = Date.now()) {
    if (!valid(guestId) || !r) return;
    const score = Math.max(0, Math.floor(+r.score || 0));
    run(d => d.run(`UPDATE guests SET games = games + 1, kills = kills + ?, bot_kills = bot_kills + ?,
        best_score = max(best_score, ?), total_score = total_score + ?, play_ms = play_ms + ?, last_seen = ?
        WHERE guest_id = ?`, Math.max(0, r.kills | 0), Math.max(0, r.botKills | 0), score, score,
        Math.max(0, Math.floor(+r.ms || 0)), now, guestId));
}

// This browser is now playing logged in: the first account it shows up with.
function converted(guestId, userId, now = Date.now()) {
    if (!valid(guestId) || !userId) return;
    run(d => d.run('UPDATE guests SET converted_user_id = ?, converted_at = ? WHERE guest_id = ? AND converted_user_id IS NULL',
        userId, now, guestId));
}

module.exports = { valid, cleanSource, seen, named, life, converted };
