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

// A guest socket connected (one visit per connection).
function seen(guestId, now = Date.now()) {
    if (!valid(guestId)) return;
    run(d => d.run(`INSERT INTO guests (guest_id, first_seen, last_seen, visits) VALUES (?, ?, ?, 1)
        ON CONFLICT(guest_id) DO UPDATE SET last_seen = excluded.last_seen, visits = visits + 1`, guestId, now, now));
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

module.exports = { valid, seen, named, life, converted };
