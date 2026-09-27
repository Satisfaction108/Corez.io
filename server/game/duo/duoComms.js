// Duo talk: team chat and quick pings, duo server only (Config.royale_duos).
//
// Normal chat is a bubble over the tank, seen by whoever has it on screen.
// Partners need more than that: one of you is dead, or you are across the
// map. Both packets here go to your partner's socket and nowhere else,
// whatever the distance, and they work while you are dead or spectating
// (no body needed).
//
//   'TC' [text]                  -> partner and you get 'TC' [name, text, bodyId, mine 0/1]
//   'PG' [x, y]                  -> partner and you get 'PG' [x, y, kind, name, bodyId, mine 0/1]
//
// The server names the ping from what is under it: an enemy tank ('enemy'),
// a base pad ('base'), loose gems or an ore rock ('gems'), else 'here'.
// Rate limits: pings 1 per second, chat 3 per 10 s plus 600 ms between
// messages; anything faster is dropped (chat says why once).
'use strict';

const PING_GAP_MS = 1000;
const CHAT_GAP_MS = 600;
const CHAT_BURST = 3;
const CHAT_WINDOW_MS = 10000;
const CHAT_MAX = 56;
const KINDS = ['here', 'enemy', 'gems', 'base'];

// Hooks (tests swap these): who the partner socket is, the clock, and the
// world lookups a ping reads.
const hooks = {
    on: () => !!(global.Config && global.Config.royale_duos),
    mateSocket: (socket) => require('./duoRaid.js').mateSocket(socket),
    now: () => Date.now(),
    room: () => (global.gameManager && global.gameManager.room) || null,
    kindAt: (x, y, socket) => kindAt(x, y, socket),
};

function bodyOf(socket) {
    const b = socket && socket.player && socket.player.body;
    return b && !(b.isDead && b.isDead()) ? b : null;
}

// A name for the sender even while dead: the live body, else the last name
// this socket spawned with.
function nameOf(socket) {
    const b = socket && socket.player && socket.player.body;
    let n = (b && b.name) || (socket && (socket._duoName || (socket.player && socket.player.name))) || '';
    if (b && b.name) socket._duoName = b.name;
    if (!n) {
        // never spawned under a name yet: the one the team book has
        try {
            const t = require('./duoRaid.js').book.teamOf(socket && socket.duoKey);
            const me = t && t.members.get(socket.duoKey);
            if (me && me.name) n = me.name;
        } catch { /* */ }
    }
    return String(n || 'Teammate').slice(0, 24);
}

// Blocked either way: neither sees the other's chat (same rule as bubbles).
function blocked(a, b) {
    const ida = a && a.account && a.account.id, idb = b && b.account && b.account.id;
    if (!ida || !idb) return false;
    const ba = a.account.blocked, bb = b.account.blocked;
    return !!((ba && ba.has && ba.has(idb)) || (bb && bb.has && bb.has(ida)));
}

function tidy(text) {
    // one line, no control characters, trimmed
    return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// -> true when sent (tests read the return value)
function teamChat(socket, text) {
    if (!hooks.on() || !socket || typeof text !== 'string') return false;
    const t = tidy(text);
    if (!t) return false;
    const now = hooks.now();
    const st = socket._duoChat || (socket._duoChat = { last: 0, times: [], warned: 0 });
    st.times = st.times.filter(at => now - at < CHAT_WINDOW_MS);
    if (now - st.last < CHAT_GAP_MS || st.times.length >= CHAT_BURST) {
        if (now - st.warned > 3000) { st.warned = now; try { socket.talk('m', 2000, 'Slow down a sec'); } catch { /* */ } }
        return false;
    }
    if (Array.from(t).length > CHAT_MAX) {
        try { socket.talk('m', 2000, 'Too long!'); } catch { /* */ }
        return false;
    }
    st.last = now;
    st.times.push(now);
    const b = bodyOf(socket);
    const name = nameOf(socket), id = b ? b.id : 0;
    const mate = hooks.mateSocket(socket);
    if (mate && !blocked(socket, mate)) { try { mate.talk('TC', name, t, id, 0); } catch { /* */ } }
    try { socket.talk('TC', name, t, id, 1); } catch { /* */ }
    return !!mate;
}

function ping(socket, x, y) {
    if (!hooks.on() || !socket) return false;
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return false;
    const now = hooks.now();
    if (socket._duoPingAt && now - socket._duoPingAt < PING_GAP_MS) return false;
    socket._duoPingAt = now;
    const room = hooks.room();
    if (room && room.width && room.height) {
        x = Math.max(-room.width / 2, Math.min(room.width / 2, x));
        y = Math.max(-room.height / 2, Math.min(room.height / 2, y));
    }
    x = Math.round(x); y = Math.round(y);
    let kind = 'here';
    try { kind = hooks.kindAt(x, y, socket) || 'here'; } catch { kind = 'here'; }
    if (!KINDS.includes(kind)) kind = 'here';
    const b = bodyOf(socket);
    const name = nameOf(socket), id = b ? b.id : 0;
    const mate = hooks.mateSocket(socket);
    if (mate && !blocked(socket, mate)) { try { mate.talk('PG', x, y, kind, name, id, 0); } catch { /* */ } }
    try { socket.talk('PG', x, y, kind, name, id, 1); } catch { /* */ }
    // (a bot teammate has no socket: it ignores pings)
    return !!mate;
}

// What is under the ping. Enemy tanks first (a tank on a base is the news),
// then base pads, then gems (loose or an ore rock).
function kindAt(x, y, socket) {
    const me = socket && socket.player && socket.player.body;
    let myTeam = me && !(me.isDead && me.isDead()) ? me.team : null;
    if (myTeam == null) {
        // dead or spectating: the team id the book holds for you
        try { const t = require('./duoRaid.js').book.teamOf(socket && socket.duoKey); if (t) myTeam = t.id; } catch { /* */ }
    }
    let enemy = false, gems = false;
    try {
        for (const e of entities.values()) {
            if (!e || (e.isDead && e.isDead())) continue;
            const dx = e.x - x, dy = e.y - y;
            if (Math.abs(dx) > 260 || Math.abs(dy) > 260) continue;
            const d2 = dx * dx + dy * dy;
            if ((e.isPlayer || e.isBot) && e.team !== myTeam && !e.isGhost) {
                const r = (e.size || 20) + 70;
                if (d2 < r * r) { enemy = true; break; }
            } else if (e.isGemPickup && d2 < 90 * 90) gems = true;
        }
    } catch { /* */ }
    if (enemy) return 'enemy';
    try {
        for (const o of require('../terrain/outposts.js').getOutposts()) {
            const r = (o.r || 150) * 1.2;
            if ((o.x - x) ** 2 + (o.y - y) ** 2 < r * r) return 'base';
        }
    } catch { /* */ }
    if (gems) return 'gems';
    try {
        const tg = global.gameManager && global.gameManager.terrainGrid;
        if (tg && tg.nearestRockWhere && tg.nearestRockWhere(x, y, 70, rk => rk.ore > 0)) return 'gems';
    } catch { /* */ }
    return 'here';
}

module.exports = { teamChat, ping, kindAt, hooks, PING_GAP_MS, CHAT_GAP_MS, CHAT_BURST, CHAT_WINDOW_MS, CHAT_MAX };
