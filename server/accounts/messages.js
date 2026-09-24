// Direct messages between friends: the database side (routes/friends.js
// wraps these for HTTP and pushes the live events).
//
// Rules:
// - only friends can message, and never with a block either way; anything
//   else is 403 not_friends, so a block can't be told apart from an unfriend;
// - bodies go through names.sanitizeMessage and must be 1-300 code points;
// - each pair keeps its last 200 messages (older ones go on insert);
// - unfriending keeps the rows but hides them (every read checks friendship);
//   deleting an account removes them (users.softDelete + ON DELETE CASCADE).
'use strict';

const db = require('./db');
const friends = require('./friends');
const { sanitizeMessage } = require('./names');
const { HttpError } = require('./http');

const MAX_LEN = 300;
const KEEP_PER_PAIR = 200;
const PAGE_MAX = 50;
const PREVIEW_LEN = 80;

function h() { return db.handle(); }
function fail(status, code, message) { throw new HttpError(status, code, message); }
const PAIR = 'min(from_id, to_id) = ? AND max(from_id, to_id) = ?';
function pair(a, b) { return a < b ? [a, b] : [b, a]; }

function canMessage(a, b) {
    return !!a && !!b && a !== b && friends.areFriends(a, b) && !friends.blockedEitherWay(a, b);
}
function mustMessage(me, other) {
    if (!other || !canMessage(me, other.id)) fail(403, 'not_friends', 'You can only chat with friends.');
}

// -> the cleaned body, or throws 400 empty / too_long
function clean(body) {
    const s = sanitizeMessage(typeof body === 'string' ? body.slice(0, MAX_LEN * 4) : '');
    if (!s) fail(400, 'empty', 'Type something first!');
    if (Array.from(s).length > MAX_LEN) fail(400, 'too_long', `Messages can be ${MAX_LEN} characters max.`);
    return s;
}

// send(me, otherRow, body) -> the stored row
function send(me, other, body, now = Date.now()) {
    const d = h();
    const text = clean(body);
    return d.tx(() => {
        mustMessage(me, other);
        const id = Number(d.run('INSERT INTO friend_messages (from_id, to_id, body, at) VALUES (?, ?, ?, ?)', me, other.id, text, now).lastInsertRowid);
        const [lo, hi] = pair(me, other.id);
        const edge = d.get(`SELECT id FROM friend_messages WHERE ${PAIR} ORDER BY id DESC LIMIT 1 OFFSET ?`, lo, hi, KEEP_PER_PAIR);
        if (edge) d.run(`DELETE FROM friend_messages WHERE ${PAIR} AND id <= ?`, lo, hi, edge.id);
        return { id, from_id: me, to_id: other.id, body: text, at: now, read_at: null };
    });
}

// page(me, otherRow, before, limit) -> {rows (oldest first), hasMore}
function page(me, other, before, limit = PAGE_MAX) {
    mustMessage(me, other);
    const n = Math.max(1, Math.min(PAGE_MAX, limit | 0 || PAGE_MAX));
    const [lo, hi] = pair(me, other.id);
    const b = Number(before) > 0 ? Math.floor(Number(before)) : Number.MAX_SAFE_INTEGER;
    const rows = h().all(`SELECT id, from_id, to_id, body, at, read_at FROM friend_messages
                          WHERE ${PAIR} AND id < ? ORDER BY id DESC LIMIT ?`, lo, hi, b, n + 1);
    const hasMore = rows.length > n;
    return { rows: rows.slice(0, n).reverse(), hasMore };
}

// markRead(me, otherRow, upTo) -> {upTo: highest id now read, or 0 if nothing changed}
function markRead(me, other, upTo, now = Date.now()) {
    mustMessage(me, other);
    const lim = Number(upTo) > 0 ? Math.floor(Number(upTo)) : Number.MAX_SAFE_INTEGER;
    const d = h();
    return d.tx(() => {
        const top = d.get('SELECT max(id) AS id FROM friend_messages WHERE to_id = ? AND from_id = ? AND read_at IS NULL AND id <= ?', me, other.id, lim);
        if (!top || !top.id) return { upTo: 0 };
        d.run('UPDATE friend_messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL AND id <= ?', now, me, other.id, top.id);
        return { upTo: Number(top.id) };
    });
}

// Map(friendId -> unread count)
function unreadCounts(me) {
    const rows = h().all('SELECT from_id AS id, count(*) AS n FROM friend_messages WHERE to_id = ? AND read_at IS NULL GROUP BY from_id', me);
    return new Map(rows.map(r => [r.id, r.n | 0]));
}

// Map(otherId -> newest row of that conversation)
function lastMessages(me) {
    const rows = h().all(`SELECT m.id, m.from_id, m.to_id, m.body, m.at FROM friend_messages m
                          JOIN (SELECT max(id) AS id FROM friend_messages WHERE from_id = ? OR to_id = ?
                                GROUP BY min(from_id, to_id), max(from_id, to_id)) x ON x.id = m.id`, me, me);
    return new Map(rows.map(r => [r.from_id === me ? r.to_id : r.from_id, r]));
}

// A row as the viewer `me` sees it.
function view(me, row) {
    return { id: Number(row.id), from: row.from_id === me ? 'me' : 'them', body: row.body, at: row.at, read: row.read_at != null };
}
function preview(me, row) {
    const chars = Array.from(row.body);
    return { body: chars.length > PREVIEW_LEN ? chars.slice(0, PREVIEW_LEN - 1).join('') + '…' : row.body, at: row.at, from: row.from_id === me ? 'me' : 'them' };
}

module.exports = { MAX_LEN, KEEP_PER_PAIR, PAGE_MAX, canMessage, clean, send, page, markRead, unreadCounts, lastMessages, view, preview };
