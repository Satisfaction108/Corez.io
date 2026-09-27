// Duo raid glue: runs only on the duo server (Config.royale_duos, set from
// the server entry's properties in config.js). Owns the team book
// (duoTeams.js), reads party tickets from the 'DQ' packet, hands every
// spawning human their team id and colour, finds partners, and runs the one
// bot duo. dig_royale.js and sockets.js call in here; everything is a no-op
// when duos are off, so the solo server is untouched.
//
// Colour: partners share one team id, and the palette colour belongs to the
// team (global.royaleHeldTeamColors keeps it while the team exists, even when
// both are dead), so hull, minimap dot and HUD match. A Locker skin still
// paints its pattern over that shared colour: the colour says "team", the
// pattern says "who".
'use strict';

const { DuoTeams, teamStandings } = require('./duoTeams.js');

let _ticket = null;
function tickets() { return _ticket || (_ticket = require('../../accounts/partyTicket.js')); }

const on = () => !!Config.royale_duos;

const book = new DuoTeams({ newTeamId: () => freshTeamId() });

// A team id no living body uses (getRandomTeam can collide, rarely).
function freshTeamId() {
    for (let i = 0; i < 50; i++) {
        const id = global.getRandomTeam ? global.getRandomTeam() : -200 - Math.floor(Math.random() * 3000);
        if (book.has(id)) continue;
        let used = false;
        try { for (const e of entities.values()) if (e && e.team === id && (e.isPlayer || e.isBot)) { used = true; break; } } catch { /* */ }
        if (!used) return id;
    }
    return -3300 - Math.floor(Math.random() * 1000);
}

function held() {
    if (!global.royaleHeldTeamColors) global.royaleHeldTeamColors = new Map();
    return global.royaleHeldTeamColors;
}

function clients() {
    return (global.gameManager && global.gameManager.socketManager && global.gameManager.socketManager.clients) || [];
}

function toMain(msg) {
    try { require('../../accounts/bus.js').toMain(msg); } catch { /* accounts off */ }
}

// ---- identity ----

// The 'DQ' packet: [ticket string, fill 0/1]. A valid ticket makes this
// socket a party member; an account ticket only counts on that account's
// socket (a copied ticket can't seat someone else in the party).
function onHello(socket, ticket, fill) {
    if (!on() || !socket) return;
    socket.duoFill = fill !== 0 && fill !== false;
    let t = null;
    if (typeof ticket === 'string' && ticket) {
        try { t = tickets().verify(ticket); } catch { t = null; }
    }
    if (t && t.mk.startsWith('u:')) {
        const acct = socket.account && socket.account.id;
        if (!acct || 'u:' + acct !== t.mk) t = null;
    }
    if (t) {
        socket.duoKey = t.mk;
        socket.duoPid = t.pid;
        socket.duoMates = t.mates;
        socket.duoFill = t.fill && socket.duoFill;
    }
    socket.duoHello = true;
}

function keyOf(socket) {
    if (!socket) return null;
    if (socket.duoKey) return socket.duoKey;
    let k;
    if (socket.account && socket.account.id) k = 'u:' + socket.account.id;
    else if (socket.resumeToken) k = 't:' + socket.resumeToken;
    else k = 's:' + socket.id;
    socket.duoKey = k;
    return k;
}

function socketOfKey(mk, except) {
    if (!mk) return null;
    for (const c of clients()) if (c && c !== except && !c.terminated && c.duoKey === mk) return c;
    return null;
}

// ---- spawning ----

// The team id for a human about to spawn (sockets.js), creating or joining
// a team as the rules say. Tells both players when a pairing happens.
function teamForSpawn(socket, name) {
    const mk = keyOf(socket);
    const before = book.teamOf(mk);
    const hadMate = !!book.mateOf(mk);
    const r = book.join({ mk, pid: socket.duoPid || null, mates: socket.duoMates || null, fill: socket.duoFill !== false, name: name || '' });
    const team = r.team;
    if (team.color == null) team.color = pickColor(team.id);
    held().set(team.id, team.color);
    if (!global.royaleTeamColors) global.royaleTeamColors = new Map();
    global.royaleTeamColors.set(team.id, team.color);
    if (socket.duoPid && !socket._duoJoinSent) {
        socket._duoJoinSent = true;
        toMain({ t: 'duoJoin', mk, pid: socket.duoPid });
    }
    const mate = book.mateOf(mk);
    if (mate && (!before || before !== team || !hadMate)) {
        const ms = socketOfKey(mate.mk, socket);
        const filled = !socket.duoPid;
        say(socket, filled ? "You're teamed up with " + (mate.name || 'a random') + ". Stick together." : "You're in with " + (mate.name || 'your mate') + ".");
        if (ms) say(ms, (name || 'Someone') + (filled ? " joined you as your teammate." : " is here."));
    }
    return team.id;
}

function pickColor(teamId) {
    try { return global.assignTeamColor(teamId); } catch { return 10; }
}

function say(socket, text) {
    try {
        const body = socket.player && socket.player.body;
        if (body && !body.isDead?.()) body.sendMessage(text);
        else socket.talk('m', 5000, text);
    } catch { /* closing */ }
}

function onClose(socket) {
    if (!on() || !socket || !socket.duoKey) return;
    book.away(socket.duoKey);
    // another tab of the same member still here: they're not gone
    if (socketOfKey(socket.duoKey, socket)) { book.back(socket.duoKey); return; }
    if (socket._duoJoinSent) toMain({ t: 'duoLeave', mk: socket.duoKey });
    const mate = book.mateOf(socket.duoKey);
    const ms = mate && socketOfKey(mate.mk, socket);
    const who = (socket.player && socket.player.body && socket.player.body.name) || (book.teamOf(socket.duoKey) && book.teamOf(socket.duoKey).members.get(socket.duoKey) || {}).name || 'Your teammate';
    if (ms) say(ms, who + " dropped out. Their spot stays open for 2 minutes.");
}

// Periodic (dig_royale tick): expired away slots free up; empty teams let
// their colour go.
let sweepAt = 0;
function tick(t) {
    if (!on() || t - sweepAt < 2000) return;
    sweepAt = t;
    book.sweep();
    for (const id of [...held().keys()]) if (!book.has(id) && !livingOnTeam(id)) held().delete(id);
}

function livingOnTeam(team) {
    try { for (const e of entities.values()) if (e && e.team === team && (e.isPlayer || e.isBot) && !e.isDead?.()) return true; } catch { /* */ }
    return false;
}

// ---- partners ----

function mateSocket(socket) {
    if (!on() || !socket || !socket.duoKey) return null;
    const m = book.mateOf(socket.duoKey);
    return m ? socketOfKey(m.mk, socket) : null;
}

// The partner's living body (humans through the book, bots through duoMate).
function mateBody(body) {
    if (!on() || !body) return null;
    if (body.isBot) {
        const m = body.duoMate;
        return m && !m.isDead?.() && m.team === body.team ? m : null;
    }
    const ms = mateSocket(body.socket);
    const mb = ms && ms.player && ms.player.body;
    return mb && !mb.isDead?.() && mb.team === body.team ? mb : null;
}

function mateOfSocketBody(socket) {
    const ms = mateSocket(socket);
    const mb = ms && ms.player && ms.player.body;
    return mb && !mb.isDead?.() ? mb : null;
}

// Per-client HUD data (the RY 'duo' field).
// -> {mate:{id, name, alive, hp, x, y, back, away}|null, alone, fill, waiting}
function hudFor(socket, t) {
    if (!on() || !socket) return null;
    const mk = socket.duoKey;
    const team = mk ? book.teamOf(mk) : null;
    const mate = mk ? book.mateOf(mk) : null;
    if (!mate) {
        return { mate: null, alone: 1, fill: socket.duoFill !== false && !!team && book.fillable(team, t) ? 1 : 0, party: socket.duoPid ? 1 : 0 };
    }
    const ms = socketOfKey(mate.mk, socket);
    const mb = ms && ms.player && ms.player.body;
    const alive = !!(mb && !mb.isDead?.() && mb.royaleAlive !== false);
    const out = {
        name: (mb && mb.name) || mate.name || 'Teammate',
        alive: alive ? 1 : 0,
        away: ms ? 0 : 1,
    };
    if (alive) {
        out.id = mb.id;
        out.hp = mb.health && mb.health.max ? Math.max(0, Math.min(1, mb.health.amount / mb.health.max)) : 1;
        out.sh = mb.shield && mb.shield.max ? Math.max(0, Math.min(1, mb.shield.amount / mb.shield.max)) : 0;
        out.x = Math.round(mb.x); out.y = Math.round(mb.y);
        out.fight = Math.max(mb._lastDamageAt || 0, mb.hitAt || 0) > t - 4000 ? 1 : 0;
    } else if (ms && ms.royaleRespawnAt > t) {
        out.back = Math.ceil((ms.royaleRespawnAt - t) / 1000);
    }
    return { mate: out, alone: 0, fill: 0, party: socket.duoPid ? 1 : 0 };
}

// ---- bots: one bot duo per raid ----

// Which team a freshly spawning bot should take: the living half of the bot
// duo (the new bot joins it and spawns at its side), or a new bot duo when
// there is none. -> {team, near: body|null, duo: bool}
function botSpawnPlan(bots) {
    if (!on()) return null;
    const duoBots = bots.filter(b => b && b.isDuoBot && !b.isDead?.());
    if (duoBots.length === 1) return { team: duoBots[0].team, near: duoBots[0], duo: true };
    if (duoBots.length === 0) return { team: freshTeamId(), near: null, duo: true };
    return null;
}

function linkBotDuo(bot, bots) {
    bot.isDuoBot = true;
    for (const b of bots) {
        if (b === bot || !b || !b.isDuoBot || b.isDead?.() || b.team !== bot.team) continue;
        b.duoMate = bot;
        bot.duoMate = b;
    }
}

// ---- standings ----

function standings(rows) { return teamStandings(rows); }

module.exports = {
    on, book, onHello, keyOf, teamForSpawn, onClose, tick, mateSocket, mateBody, mateOfSocketBody, hudFor,
    botSpawnPlan, linkBotDuo, standings, socketOfKey, freshTeamId,
};
