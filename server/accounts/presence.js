// Online presence, main thread only, all in memory.
//
//   raid     a game socket for the account is live (bridge.js bus messages)
//   menu     no game socket, but an /api/events stream is open
//   offline  neither; lastSeen is users.last_seen_at (bumped when the last
//            socket or stream goes away)
//
// Game -> main bus messages (bridge.js):
//   {t:'join',   userId, sid}                  a game socket for an account
//   {t:'leave',  userId, sid}                  that socket closed
//   {t:'status', players:[{userId, sid, alive, score, place, rank}]}
//        every 10 s, the whole server: authoritative, so a missed leave or a
//        dead worker heals (a server silent for 35 s is dropped).
//
// onChange(fn(userId, presence)) fires when the state flips, or when the raid
// score moved and the last score push for that user is 15 s old.
'use strict';

const bus = require('./bus');
const users = require('./users');

const STALE_SERVER_MS = 35 * 1000;
const SCORE_PUSH_MS = 15 * 1000;

const games = new Map();      // userId -> Map("server\0sid" -> {serverId, alive, score, place, rank, at})
const streams = new Map();    // userId -> open SSE stream count
const lastPush = new Map();   // userId -> {state, score, place, alive, at}
const serverSeen = new Map(); // serverId -> last message time
const seen = new Map();       // userId -> last time we saw them go (memory copy of last_seen_at)
const listeners = new Set();
let unsub = null;
let timer = null;

function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function raidEntry(userId) {
    const g = games.get(userId);
    if (!g || !g.size) return null;
    // the best-placed live socket (normally there is exactly one)
    let best = null;
    for (const e of g.values()) {
        if (!best || (e.alive && !best.alive) || (e.alive === best.alive && (e.score | 0) > (best.score | 0))) best = e;
    }
    return best;
}

// -> {state:'raid'|'menu'|'offline', score, place, alive, lastSeen}
// rowLastSeen: users.last_seen_at when the caller already has the row.
function get(userId, rowLastSeen) {
    const e = raidEntry(userId);
    if (e) return { state: 'raid', alive: !!e.alive, score: e.score == null ? null : e.score | 0, place: e.place == null ? null : e.place | 0, lastSeen: null };
    if ((streams.get(userId) | 0) > 0) return { state: 'menu', alive: false, score: null, place: null, lastSeen: null };
    const mem = seen.get(userId) || 0;
    let ls = rowLastSeen == null ? null : rowLastSeen;
    if (ls == null && !mem) {
        try { const r = users.byId(userId); ls = r ? r.last_seen_at : null; } catch (e) { ls = null; }
    }
    return { state: 'offline', alive: false, score: null, place: null, lastSeen: Math.max(ls || 0, mem) || null };
}

function isOnline(userId) {
    return !!raidEntry(userId) || (streams.get(userId) | 0) > 0;
}

function markSeen(userId, now) {
    seen.set(userId, now);
    if (seen.size > 20000) seen.clear();
    try { users.touchSeen(userId, now); } catch (e) { /* db closing */ }
}

function changed(userId, now = Date.now()) {
    const p = get(userId);
    const prev = lastPush.get(userId);
    if (prev && prev.state === p.state) {
        if (p.state !== 'raid') return;
        const moved = prev.score !== p.score || prev.place !== p.place || prev.alive !== p.alive;
        if (!moved || now - prev.at < SCORE_PUSH_MS) return;
    }
    if (!prev && p.state === 'offline') return;
    if (p.state === 'offline') lastPush.delete(userId);
    else lastPush.set(userId, { state: p.state, score: p.score, place: p.place, alive: p.alive, at: now });
    for (const fn of Array.from(listeners)) {
        try { fn(userId, p); } catch (e) { console.error('[accounts] presence listener failed: ' + ((e && e.stack) || e)); }
    }
}

function wentAway(userId, now) {
    if (!isOnline(userId)) markSeen(userId, now);
    changed(userId, now);
}

function join(serverId, userId, sid, now = Date.now()) {
    if (!userId) return;
    let g = games.get(userId);
    if (!g) games.set(userId, g = new Map());
    const key = serverId + '\0' + sid;
    if (!g.has(key)) g.set(key, { serverId, alive: false, score: null, place: null, rank: 0, at: now });
    changed(userId, now);
}

function leave(serverId, userId, sid, now = Date.now()) {
    const g = games.get(userId);
    if (!g) return;
    g.delete(serverId + '\0' + sid);
    if (!g.size) games.delete(userId);
    wentAway(userId, now);
}

// The whole server's account sockets right now.
function status(serverId, players, now = Date.now()) {
    const present = new Set();
    for (const p of Array.isArray(players) ? players : []) {
        if (!p || !p.userId) continue;
        const userId = p.userId | 0;
        const key = serverId + '\0' + p.sid;
        present.add(userId + '\0' + key);
        let g = games.get(userId);
        if (!g) games.set(userId, g = new Map());
        g.set(key, {
            serverId, alive: !!p.alive,
            score: p.score == null ? null : Math.max(0, p.score | 0),
            place: p.place == null ? null : Math.max(0, p.place | 0),
            rank: p.rank | 0, at: now,
        });
        changed(userId, now);
    }
    dropServer(serverId, now, present);
}

// Entries of serverId not in `keep` (userId\0key) go; keep=null drops all.
function dropServer(serverId, now, keep = null) {
    for (const [userId, g] of Array.from(games)) {
        let any = false;
        for (const [key, e] of Array.from(g)) {
            if (e.serverId !== serverId || (keep && keep.has(userId + '\0' + key))) continue;
            g.delete(key);
            any = true;
        }
        if (!g.size) games.delete(userId);
        if (any) wentAway(userId, now);
    }
}

function streamOpened(userId, now = Date.now()) {
    streams.set(userId, (streams.get(userId) | 0) + 1);
    changed(userId, now);
}

function streamClosed(userId, now = Date.now()) {
    const n = (streams.get(userId) | 0) - 1;
    if (n > 0) streams.set(userId, n);
    else streams.delete(userId);
    wentAway(userId, now);
}

function streamCount(userId) {
    return streams.get(userId) | 0;
}

function onBus(serverId, msg, now = Date.now()) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join' || msg.t === 'leave' || msg.t === 'status') serverSeen.set(serverId, now);
    if (msg.t === 'join') join(serverId, msg.userId | 0, String(msg.sid), now);
    else if (msg.t === 'leave') leave(serverId, msg.userId | 0, String(msg.sid), now);
    else if (msg.t === 'status') status(serverId, msg.players, now);
}

function sweepStale(now = Date.now()) {
    for (const [serverId, at] of Array.from(serverSeen)) {
        if (now - at < STALE_SERVER_MS) continue;
        serverSeen.delete(serverId);
        dropServer(serverId, now);
    }
}

function start() {
    if (!unsub) unsub = bus.onMain((serverId, msg) => onBus(serverId, msg));
    if (!timer) {
        timer = setInterval(() => sweepStale(), 10 * 1000);
        if (timer.unref) timer.unref();
    }
}

function stop() {
    if (unsub) unsub();
    unsub = null;
    if (timer) clearInterval(timer);
    timer = null;
}

// Tests only.
function reset() {
    games.clear(); streams.clear(); lastPush.clear(); serverSeen.clear(); seen.clear();
}

module.exports = {
    get, isOnline, onChange, onBus, join, leave, status, streamOpened, streamClosed, streamCount, sweepStale, start, stop, reset,
    STALE_SERVER_MS, SCORE_PUSH_MS,
};
