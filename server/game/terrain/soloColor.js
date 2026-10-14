// A solo player's tank colour through one raid's lives
'use strict';

// Round 9: the memory is keyed by the person (account id, else guest id), not the
const byWho = new Map();     // who -> { raid, c }
let raidNow = 0;
function whoOf(socket) {
    if (!socket) return null;
    if (socket.account && socket.account.id) return 'a:' + socket.account.id;
    if (socket.guestId) return 'g:' + socket.guestId;
    return null;
}

function palette() {
    const p = global.ROYALE_PALETTE;
    return Array.isArray(p) && p.length ? p : [10];
}

function hashOf(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

function firstTry(n, socket) {
    const who = whoOf(socket);
    if (who && raidNow) return hashOf(who + '|' + raidNow) % n;
    return Math.floor(Math.random() * n);
}

function norm(c) {
    if (typeof c === 'number') return c;
    if (typeof c === 'string' && /^\d+$/.test(c)) return +c;
    return c == null ? null : c;
}

function scan(team) {
    const live = new Map();
    const teams = new Set();
    let mate = null;
    const all = global.entities ? global.entities.values() : [];
    for (const e of all) {
        if (!e || !(e.isPlayer || e.isBot)) continue;
        if (typeof e.isDead === 'function' && e.isDead()) continue;
        teams.add(e.team);
        const c = norm(e.leaderboardColor);
        if (c == null) continue;
        if (e.team === team) { if (mate == null) mate = c; continue; }
        live.set(c, (live.get(c) || 0) + 1);
    }
    return { live, teams, mate };
}

function reserved(team, socket) {
    const out = new Map();
    const held = global.royaleHeldTeamColors;
    if (held) for (const [t, c] of held) if (t !== team) out.set(c, (out.get(c) || 0) + 1);
    const sm = global.gameManager && global.gameManager.socketManager;
    const clients = (sm && sm.clients) || [];
    if (!raidNow) return out;
    for (const s of clients) {
        if (!s || s === socket || s.terminated) continue;
        const rc = s._raidColor;
        if (!rc || rc.raid !== raidNow || rc.c == null) continue;
        const b = s.player && s.player.body;
        if (b && b.team === team) continue;
        if (b && !(typeof b.isDead === 'function' && b.isDead()) && norm(b.leaderboardColor) === rc.c) continue;
        out.set(rc.c, (out.get(rc.c) || 0) + 1);
    }
    return out;
}

function isFree(c, team, socket) {
    if (c == null) return false;
    const { live } = scan(team);
    if (live.has(c)) return false;
    return !reserved(team, socket).has(c);
}

function assign(team, socket) {
    const tc = global.royaleTeamColors || (global.royaleTeamColors = new Map());
    const held = global.royaleHeldTeamColors;
    if (held && held.has(team)) { tc.set(team, held.get(team)); return held.get(team); }
    const { live, teams, mate } = scan(team);
    if (mate != null) { tc.set(team, mate); return mate; }
    for (const t of [...tc.keys()]) if (t !== team && !teams.has(t) && !(held && held.has(t))) tc.delete(t);
    const res = reserved(team, socket);
    const pal = palette();
    const start = firstTry(pal.length, socket);
    let pick;
    for (let i = 0; i < pal.length && pick === undefined; i++) {
        const c = pal[(start + i) % pal.length];
        if (!live.has(c) && !res.has(c)) pick = c;
    }
    if (pick === undefined) {
        const load = c => (live.get(c) || 0) + (res.get(c) || 0);
        pick = pal.slice(start).concat(pal.slice(0, start)).sort((a, b) => load(a) - load(b))[0];
    }
    tc.set(team, pick);
    return pick;
}

function keep(team, want, socket) {
    if (want != null && isFree(want, team, socket)) {
        if (!global.royaleTeamColors) global.royaleTeamColors = new Map();
        global.royaleTeamColors.set(team, want);
        return want;
    }
    return global.assignTeamColor(team, socket);
}

// socket: carries _raidColor {raid, c}; team: this life's id
function colorFor(socket, team, raidId, kept) {
    if (raidId) raidNow = Math.max(raidNow, raidId);
    const who = whoOf(socket);
    const rc = (who && byWho.get(who)) || (socket && socket._raidColor);
    let want = null;
    if (kept && kept.color != null) want = kept.color;
    else if (raidId && rc && rc.raid === raidId && rc.c != null) want = rc.c;
    const c = keep(team, want, socket);
    if (raidId && socket) socket._raidColor = { raid: raidId, c };
    if (raidId && who) {
        if (byWho.size > 2000) for (const [k, v] of byWho) if (v.raid !== raidId) byWho.delete(k);
        byWho.set(who, { raid: raidId, c });
    }
    return c;
}

module.exports = { colorFor, whoOf, assign, keep, isFree, _byWho: byWho };
