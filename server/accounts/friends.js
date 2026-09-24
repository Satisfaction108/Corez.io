// Friends, requests and blocks: the database side. routes/friends.js wraps
// these for HTTP and pushes the live events (routes/events.js).
//
// Rules:
// - requests go by username; a request to someone who blocked you is stored
//   silent=1 and looks exactly like a pending request from your side, but is
//   never shown to them;
// - requesting someone who already requested you accepts it;
// - 200 friends, 50 outgoing requests, 500 blocks per account;
// - a block removes the friendship and pending requests both ways; blocked
//   either way also hides gifts (store.js) and profiles (routes/profile.js).
//
// Every mutating call returns what happened plus the internal ids that need
// telling, so the route can notify without another query.
'use strict';

const db = require('./db');
const users = require('./users');
const { HttpError } = require('./http');
const R = require('../../shared/ranks.js');

const MAX_FRIENDS = 200;
const MAX_OUTGOING = 50;
const MAX_BLOCKS = 500;

function h() { return db.handle(); }
function fail(status, code, message, extra) { throw new HttpError(status, code, message, extra); }
function pair(a, b) { return a < b ? [a, b] : [b, a]; }

// {division, name, tier}; division null while unranked / in placement.
function rankLite(row) {
    if (!row || row.ranked_at == null) return { division: null, name: R.nameOf(null), tier: null };
    const div = R.divisionOf(row.rp | 0);
    return { division: div, name: R.nameOf(div), tier: R.tierOf(div) };
}

function areFriends(a, b) {
    const [lo, hi] = pair(a, b);
    return !!h().get('SELECT 1 AS x FROM friendships WHERE user_lo = ? AND user_hi = ?', lo, hi);
}

function hasBlocked(blocker, blocked) {
    return !!h().get('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?', blocker, blocked);
}

function blockedEitherWay(a, b) {
    return !!h().get('SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', a, b, b, a);
}

function friendCount(id) {
    return h().get('SELECT count(*) AS n FROM friendships WHERE user_lo = ? OR user_hi = ?', id, id).n | 0;
}

function outgoingCount(id) {
    return h().get('SELECT count(*) AS n FROM friend_requests WHERE from_id = ?', id).n | 0;
}

// Internal ids of every friend (presence fan-out, rank-up toasts).
function friendIds(id) {
    return h().all(`SELECT CASE WHEN user_lo = ? THEN user_hi ELSE user_lo END AS id FROM friendships
                    WHERE user_lo = ? OR user_hi = ?`, id, id, id).map(r => r.id);
}

// Internal ids this account has blocked, plus those who blocked it (the
// game hides chat between the two either way).
function blockSet(id) {
    const rows = h().all('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?', id, id);
    return new Set(rows.map(r => r.id));
}

// {friends:[{id, row, since}], incoming:[{row, at}], outgoing:[{row, at}], blocked:[{row, at}]}
// (rows are full users rows; the route shapes them)
function lists(id) {
    const d = h();
    const friends = d.all(`SELECT u.*, f.created_at AS _since FROM friendships f
                           JOIN users u ON u.id = CASE WHEN f.user_lo = ? THEN f.user_hi ELSE f.user_lo END
                           WHERE (f.user_lo = ? OR f.user_hi = ?) AND u.deleted_at IS NULL
                           ORDER BY u.username_lc`, id, id, id);
    const incoming = d.all(`SELECT u.*, r.created_at AS _at FROM friend_requests r JOIN users u ON u.id = r.from_id
                            WHERE r.to_id = ? AND r.silent = 0 AND u.deleted_at IS NULL ORDER BY r.created_at DESC`, id);
    const outgoing = d.all(`SELECT u.*, r.created_at AS _at FROM friend_requests r JOIN users u ON u.id = r.to_id
                            WHERE r.from_id = ? AND u.deleted_at IS NULL ORDER BY r.created_at DESC`, id);
    const blocked = d.all(`SELECT u.*, b.created_at AS _at FROM blocks b JOIN users u ON u.id = b.blocked_id
                           WHERE b.blocker_id = ? AND u.deleted_at IS NULL ORDER BY b.created_at DESC`, id);
    return { friends, incoming, outgoing, blocked };
}

function targetOrFail(me, row) {
    if (!row) fail(404, 'user_not_found', 'No player with that name.');
    if (row.id === me) fail(400, 'self', 'That is you.');
    return row;
}

function makeFriends(a, b, now) {
    const d = h();
    const [lo, hi] = pair(a, b);
    d.run('INSERT OR IGNORE INTO friendships (user_lo, user_hi, created_at) VALUES (?, ?, ?)', lo, hi, now);
    d.run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', a, b, b, a);
}

function checkFriendRoom(me, other) {
    if (friendCount(me) >= MAX_FRIENDS) fail(409, 'friend_limit', `You can have up to ${MAX_FRIENDS} friends.`);
    if (friendCount(other) >= MAX_FRIENDS) fail(409, 'their_friend_limit', 'Their friends list is full.');
}

// request(me, username) -> {status:'pending'|'accepted', user:row, notify:{type, to}|null}
function request(me, username, now = Date.now()) {
    const d = h();
    return d.tx(() => {
        const to = targetOrFail(me, users.byUsername(username));
        if (areFriends(me, to.id)) fail(409, 'already_friends', 'You are already friends.');
        if (hasBlocked(me, to.id)) fail(409, 'you_blocked', 'Unblock them first.');
        const theyBlocked = hasBlocked(to.id, me);
        const theirs = !theyBlocked && d.get('SELECT silent FROM friend_requests WHERE from_id = ? AND to_id = ?', to.id, me);
        if (theirs && !theirs.silent) {
            checkFriendRoom(me, to.id);
            makeFriends(me, to.id, now);
            return { status: 'accepted', user: to, since: now, notify: { type: 'friendAccepted', to: to.id } };
        }
        if (d.get('SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ?', me, to.id)) {
            return { status: 'pending', user: to, notify: null };
        }
        if (outgoingCount(me) >= MAX_OUTGOING) fail(409, 'outgoing_limit', `You can have up to ${MAX_OUTGOING} pending requests.`);
        if (!theyBlocked && friendCount(me) >= MAX_FRIENDS) fail(409, 'friend_limit', `You can have up to ${MAX_FRIENDS} friends.`);
        d.run('INSERT INTO friend_requests (from_id, to_id, created_at, silent) VALUES (?, ?, ?, ?)', me, to.id, now, theyBlocked ? 1 : 0);
        return { status: 'pending', user: to, at: now, notify: theyBlocked ? null : { type: 'friendRequest', to: to.id } };
    });
}

// respond(me, fromRow, accept) -> {status:'accepted'|'declined', user, since?}
function respond(me, from, accept, now = Date.now()) {
    const d = h();
    return d.tx(() => {
        if (!from || from.id === me) fail(404, 'no_request', 'That request is gone.');
        const r = d.get('SELECT silent FROM friend_requests WHERE from_id = ? AND to_id = ?', from.id, me);
        if (!r || r.silent) fail(404, 'no_request', 'That request is gone.');
        if (!accept) {
            d.run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', from.id, me);
            return { status: 'declined', user: from };
        }
        checkFriendRoom(me, from.id);
        makeFriends(me, from.id, now);
        return { status: 'accepted', user: from, since: now };
    });
}

// cancel(me, toRow) -> {user, silent}
function cancel(me, to) {
    if (!to) fail(404, 'no_request', 'No such request.');
    const r = h().get('SELECT silent FROM friend_requests WHERE from_id = ? AND to_id = ?', me, to.id);
    if (!r) fail(404, 'no_request', 'No such request.');
    h().run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', me, to.id);
    return { user: to, silent: !!r.silent };
}

function remove(me, other) {
    if (!other) fail(404, 'not_friends', 'You are not friends.');
    const [lo, hi] = pair(me, other.id);
    if (!h().run('DELETE FROM friendships WHERE user_lo = ? AND user_hi = ?', lo, hi).changes) fail(404, 'not_friends', 'You are not friends.');
    return { user: other };
}

// block(me, row) -> {user, wasFriend, hadIncoming, hadOutgoing, at}
function block(me, target, now = Date.now()) {
    const d = h();
    return d.tx(() => {
        targetOrFail(me, target);
        const existing = d.get('SELECT created_at FROM blocks WHERE blocker_id = ? AND blocked_id = ?', me, target.id);
        if (!existing) {
            const n = d.get('SELECT count(*) AS n FROM blocks WHERE blocker_id = ?', me).n | 0;
            if (n >= MAX_BLOCKS) fail(409, 'block_limit', `You can block up to ${MAX_BLOCKS} players.`);
            d.run('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', me, target.id, now);
        }
        const [lo, hi] = pair(me, target.id);
        const wasFriend = d.run('DELETE FROM friendships WHERE user_lo = ? AND user_hi = ?', lo, hi).changes > 0;
        const out = d.run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', me, target.id).changes > 0;
        const inc = d.run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', target.id, me).changes > 0;
        return { user: target, wasFriend, hadOutgoing: out, hadIncoming: inc, at: existing ? existing.created_at : now };
    });
}

function unblock(me, target) {
    if (!target || !h().run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', me, target.id).changes) {
        fail(404, 'not_blocked', 'That player is not blocked.');
    }
    return { user: target };
}

module.exports = {
    MAX_FRIENDS, MAX_OUTGOING, MAX_BLOCKS,
    rankLite, areFriends, hasBlocked, blockedEitherWay, friendCount, outgoingCount, friendIds, blockSet, lists,
    request, respond, cancel, remove, block, unblock,
};
