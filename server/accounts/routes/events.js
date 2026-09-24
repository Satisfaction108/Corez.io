// GET /api/events: the menu's Server-Sent Events stream (accounts only).
//
// On open: "retry: 5000", then a `hello` event carrying the same body as
// GET /api/friends plus {now}. A ": ping" comment every 25 s; at most 5
// streams per account (the oldest is closed) and 5000 overall.
//
// Events (event: <type>, data: JSON):
//   hello            {now, friends, incoming, outgoing, blocked}
//   presence         {updates:[{userId, state, alive, score, place, lastSeen}]}   coalesced per recipient, 2 s
//   friendRequest    {userId, username, at, rank}
//   friendRequestCanceled {userId}
//   friendAccepted   {userId, username, since, rank, presence}
//   friendRemoved    {userId}
//   friendRankUp     {userId, username, division, name, tier, tierUp}
//   gift             {purchaseId, itemId, preset, from:{userId, username}}
//   storeReset       {day, resetsAt}                    at 00:00 UTC (daily quests reset too)
//   ach              {id, name, desc, at}               an achievement unlocked in a raid
//   dust             {balanceMilli, deltaMilli, kind}    an admin changed the balance
//   sessionRevoked   {}                                 then the stream closes
//
// Other modules call push(userId, type, data) (internal user id).
'use strict';

const bus = require('../bus');
const db = require('../db');
const users = require('../users');
const friends = require('../friends');
const presence = require('../presence');
const { BASE_HEADERS, HttpError } = require('../http');
const R = require('../../../shared/ranks.js');

const PING_MS = 25 * 1000;
const COALESCE_MS = 2000;
const MAX_PER_USER = 5;
const MAX_TOTAL = 5000;
const DAY = 24 * 60 * 60 * 1000;

const byUser = new Map();      // userId -> Set(stream)
let total = 0;
const pendingPresence = new Map();   // recipientId -> Map(publicId -> presence update)
const timers = { ping: null, flush: null, reset: null };
const unsubs = [];

function write(stream, chunk) {
    if (stream.closed) return false;
    try {
        stream.res.write(chunk);
        return true;
    } catch (e) {
        close(stream);
        return false;
    }
}

function frame(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;
}

function push(userId, type, data) {
    const set = byUser.get(userId);
    if (!set || !set.size) return 0;
    const chunk = frame(type, data);
    let n = 0;
    for (const s of Array.from(set)) if (write(s, chunk)) n++;
    return n;
}

function hasStream(userId) {
    const set = byUser.get(userId);
    return !!set && set.size > 0;
}

function close(stream) {
    if (stream.closed) return;
    stream.closed = true;
    const set = byUser.get(stream.userId);
    if (set) {
        set.delete(stream);
        if (!set.size) byUser.delete(stream.userId);
    }
    total = Math.max(0, total - 1);
    try { stream.res.end(); } catch (e) { /* gone */ }
    presence.streamClosed(stream.userId);
}

// ---- shaping (shared with routes/friends.js) ----

function presenceOf(row) {
    return presence.get(row.id, row.last_seen_at);
}

function friendView(row) {
    return { userId: row.public_id, username: row.username, since: row._since, rank: friends.rankLite(row), presence: presenceOf(row) };
}

function personView(row) {
    return { userId: row.public_id, username: row.username, at: row._at, rank: friends.rankLite(row) };
}

function listsView(userId) {
    const l = friends.lists(userId);
    return {
        friends: l.friends.map(friendView),
        incoming: l.incoming.map(personView),
        outgoing: l.outgoing.map(personView),
        blocked: l.blocked.map(r => ({ userId: r.public_id, username: r.username, at: r._at })),
    };
}

// ---- presence fan-out: queued per recipient, flushed every 2 s ----

function onPresence(userId, p) {
    if (!db.handle()) return;
    const ids = friends.friendIds(userId).filter(hasStream);
    if (!ids.length) return;
    const row = users.byId(userId);
    if (!row) return;
    const update = { userId: row.public_id, ...p };
    for (const id of ids) {
        let m = pendingPresence.get(id);
        if (!m) pendingPresence.set(id, m = new Map());
        m.set(row.public_id, update);
    }
}

function flushPresence() {
    if (!pendingPresence.size) return;
    const all = Array.from(pendingPresence);
    pendingPresence.clear();
    for (const [id, m] of all) push(id, 'presence', { updates: Array.from(m.values()) });
}

// ---- rank-ups from the game: a toast for every friend with the menu open ----

function onRankUp(msg) {
    if (!db.handle()) return;
    const row = users.byId(msg.userId);
    if (!row) return;
    const div = msg.division == null ? R.divisionOf(row.rp | 0) : msg.division | 0;
    const data = { userId: row.public_id, username: row.username, division: div, name: R.nameOf(div), tier: R.tierOf(div), tierUp: !!msg.tierUp };
    for (const id of friends.friendIds(row.id)) push(id, 'friendRankUp', data);
}

// ---- achievements unlocked in the game: the owner's open menus ----

function onAch(msg) {
    const def = require('../achievements').BY_ID.get(msg.id);
    if (!def || !msg.userId) return;
    push(msg.userId, 'ach', { id: def.id, name: def.name, desc: def.desc, at: Date.now() });
}

// ---- sessions: a revoked / expired session ends its stream ----

function sessionAlive(stream, now) {
    try {
        return !!db.handle().get('SELECT 1 AS x FROM sessions WHERE id = ? AND expires_at > ?', stream.sessionId, now);
    } catch (e) { return true; }
}

function checkSessions(userId, now = Date.now()) {
    const set = byUser.get(userId);
    if (!set) return;
    for (const s of Array.from(set)) {
        if (!sessionAlive(s, now)) {
            write(s, frame('sessionRevoked', {}));
            close(s);
        }
    }
}

function ping() {
    const now = Date.now();
    for (const set of Array.from(byUser.values())) {
        for (const s of Array.from(set)) {
            if (!sessionAlive(s, now)) {
                write(s, frame('sessionRevoked', {}));
                close(s);
            } else write(s, ': ping\n\n');
        }
    }
}

// ---- 00:00 UTC ----

function scheduleReset() {
    if (timers.reset) clearTimeout(timers.reset);
    const now = Date.now();
    const next = (Math.floor(now / DAY) + 1) * DAY;
    timers.reset = setTimeout(() => {
        const day = Math.floor(Date.now() / DAY + 1e-9);
        const chunk = frame('storeReset', { day, resetsAt: (day + 1) * DAY });
        for (const set of byUser.values()) for (const s of Array.from(set)) write(s, chunk);
        scheduleReset();
    }, next - now + 250);
    if (timers.reset.unref) timers.reset.unref();
}

// ---- the route ----

function getEvents(ctx) {
    const a = ctx.requireAuth();
    if (total >= MAX_TOTAL) throw new HttpError(503, 'busy', "The server's packed right now. Try again soon!", { retryAfter: 30 }, { 'Retry-After': '30' });
    const userId = a.user.id;
    const set = byUser.get(userId) || new Set();
    while (set.size >= MAX_PER_USER) close(set.values().next().value);
    const res = ctx.res;
    const h = { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
    if (ctx.outCookies.length) h['Set-Cookie'] = ctx.outCookies;
    res.writeHead(200, h);
    if (ctx.req.method === 'HEAD') return res.end();
    if (res.socket) {
        try { res.socket.setKeepAlive(true, PING_MS); res.socket.setNoDelay(true); res.socket.setTimeout(0); } catch (e) { /* */ }
    }
    const stream = { userId, sessionId: a.session.id, res, closed: false };
    byUser.set(userId, set);
    set.add(stream);
    total++;
    const done = () => close(stream);
    res.on('close', done);
    res.on('error', done);
    write(stream, 'retry: 5000\n\n');
    presence.streamOpened(userId);
    write(stream, frame('hello', { now: Date.now(), ...listsView(userId) }));
}

function start() {
    if (!timers.ping) {
        timers.ping = setInterval(ping, PING_MS);
        timers.flush = setInterval(flushPresence, COALESCE_MS);
        for (const t of [timers.ping, timers.flush]) if (t.unref) t.unref();
    }
    scheduleReset();
    if (!unsubs.length) {
        unsubs.push(presence.onChange(onPresence));
        unsubs.push(bus.onMain((serverId, msg) => {
            if (!msg) return;
            if (msg.t === 'rankUp') onRankUp(msg);
            else if (msg.t === 'ach') onAch(msg);
        }));
        // logouts / recovery / deletion kick the game sockets; the streams follow
        unsubs.push(bus.onGame(msg => { if (msg && msg.t === 'kick') checkSessions(msg.userId); }));
    }
}

function stop() {
    for (const [, set] of Array.from(byUser)) for (const s of Array.from(set)) close(s);
    for (const k of Object.keys(timers)) { if (timers[k]) clearInterval(timers[k]); timers[k] = null; }
    while (unsubs.length) unsubs.pop()();
    pendingPresence.clear();
}

function register(router) {
    router.add('GET', '/api/events', getEvents);
}

module.exports = {
    register, start, stop, push, hasStream, checkSessions, flushPresence, listsView, friendView, personView, presenceOf, onRankUp,
    streamCount: userId => (byUser.get(userId) || new Set()).size,
};
