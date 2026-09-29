// Duo raid glue: runs only on the duo server (Config.royale_duos, set from
// the server entry's properties in config.js). Owns the team book
// (duoTeams.js), reads party tickets from the 'DQ' packet, hands every
// spawning human their team id and colour, finds partners, and runs the one
// bot duo. dig_royale.js and sockets.js call in here; everything is a no-op
// when duos are off, except the team id pool (freshTeamId, newRaid), which the
// solo server uses too.
//
// Colour: partners share one team id, and the palette colour belongs to the
// team (global.royaleHeldTeamColors keeps it while the team exists, even when
// both are dead). A Locker skin paints its pattern over that shared colour.
//
// Fill queue: a lone player with fill on and no team waits (holdSpawn, from
// the spawn loop in sockets.js) until match() pairs them with another lone
// filler; after FILL_WAIT_MS they get a bot teammate instead (team.bot, the
// body spawned by dig_royale.spawnTeamBot next to them). The waiting screen
// is driven by the 'DW' packet: [phase, waited ms, name]
//   phase 'find' | 'bot' (BOT_NOTICE_MS, then spawn) | 'paired' | 'solo' | 'done'.
'use strict';

const { DuoTeams, teamStandings } = require('./duoTeams.js');

// Tunables. DUO_FILL_WAIT_MS shortens the wait for local tests.
const FILL_WAIT_MS = parseInt(process.env.DUO_FILL_WAIT_MS, 10) > 0 ? parseInt(process.env.DUO_FILL_WAIT_MS, 10) : 45000;
const BOT_NOTICE_MS = 1500;      // "matching you with a bot" shows this long before the drop
const TEAM_BOT_RESPAWN_MS = 15000;
const MAX_TEAM_BOTS = 4;         // bot teammates on the server at once (a 5th waiter goes solo)

let _ticket = null;
function tickets() { return _ticket || (_ticket = require('../../accounts/partyTicket.js')); }

const on = () => !!Config.royale_duos;

const book = new DuoTeams({ newTeamId: () => freshTeamId(), fillWaitMs: FILL_WAIT_MS });

// Every team id handed out this raid. Board rows outlive their bodies, so an
// id is never reused within a raid (it would merge a new body into a dead
// team's standings row). Cleared at a new raid (newRaid).
const usedIds = new Set();

// A team id nobody has had this raid, no living body uses, and the book
// doesn't hold. Every combatant on either royale server gets its team from
// here (on solo the book is always empty, so each body is a team of one).
function freshTeamId() {
    for (let i = 0; i < 200; i++) {
        const id = global.getRandomTeam ? global.getRandomTeam() : -200 - Math.floor(Math.random() * 3000);
        if (usedIds.has(id) || book.has(id)) continue;
        let used = false;
        try { for (const e of entities.values()) if (e && e.team === id && (e.isPlayer || e.isBot)) { used = true; break; } } catch { /* */ }
        if (used) continue;
        usedIds.add(id);
        return id;
    }
    let id = -3300;
    while (usedIds.has(id) || book.has(id)) id--;
    usedIds.add(id);
    return id;
}

// A new raid: ids of the old raid's rows may come back, except the ones
// still in use (book teams persist across raids).
function newRaid() {
    usedIds.clear();
    for (const id of book.teams.keys()) usedIds.add(id);
    try { for (const e of entities.values()) if (e && (e.isPlayer || e.isBot) && e.team != null) usedIds.add(e.team); } catch { /* */ }
    for (const team of book.teams.values()) if (team.bot) { team.bot.respawnAt = 0; }
}

// The standings key of a combatant: set only for real duo teams (a pair, a
// human with a bot teammate, the bot duo), so solo players and solo bots on
// the duo server are rows of their own.
function teamKeyOf(body) {
    if (!on() || !body) return null;
    if (body.isBot) return body.duoTeamKey || null;
    const mk = body.socket && body.socket.duoKey;
    const team = mk ? book.teamOf(mk) : null;
    return team && team.key && team.id === body.team ? team.key : null;
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
    setupTeamColor(team);
    if (socket._duoWaitSince) {
        // off the waiting screen
        talkWait(socket, 'done', Date.now());
        socket._duoWaitSince = 0;
        socket._duoWaiting = false;
    }
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
    // waiting for a teammate: out of the queue (a reconnect queues afresh)
    if (book.isWaiting(socket.duoKey) && !socketOfKey(socket.duoKey, socket)) book.unwait(socket.duoKey);
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
let sweepAt = 0, matchAt = 0;
function tick(t) {
    if (!on()) return;
    if (t - matchAt >= 250) { matchAt = t; runMatch(t); tickWaiters(t); }
    if (t - sweepAt < 2000) return;
    sweepAt = t;
    book.sweep();
    for (const id of [...held().keys()]) if (!book.has(id) && !livingOnTeam(id)) held().delete(id);
}

// ---- the fill queue ----

function teamBotCount() {
    let n = 0;
    for (const team of book.teams.values()) if (team.bot) n++;
    return n;
}

function talkWait(socket, phase, t, name) {
    try { socket.talk('DW', phase, Math.max(0, t - (socket._duoWaitSince || t)) | 0, name || ''); } catch { /* closing */ }
}

function setupTeamColor(team) {
    if (team.color == null) team.color = pickColor(team.id);
    held().set(team.id, team.color);
    if (!global.royaleTeamColors) global.royaleTeamColors = new Map();
    global.royaleTeamColors.set(team.id, team.color);
}

// Pair / seat / bot-match whoever is waiting.
function runMatch(t) {
    if (!book.waiting.size) return;
    // a waiter whose socket is gone (closed without onClose) leaves the queue
    for (const mk of [...book.waiting.keys()]) if (!socketOfKey(mk)) book.unwait(mk);
    const events = book.match(() => teamBotCount() < MAX_TEAM_BOTS);
    for (const ev of events) {
        setupTeamColor(ev.team);
        if (ev.kind === 'pair' || ev.kind === 'join') {
            const mks = ev.kind === 'pair' ? ev.mks : [...ev.team.members.keys()];
            for (const mk of mks) {
                const s = socketOfKey(mk);
                if (!s) continue;
                const mate = book.mateOf(mk);
                const mateName = (mate && mate.name) || 'a teammate';
                if (book.teamOf(mk) && s._duoWaiting) {
                    s._duoWaiting = false;
                    s._duoGo = true;
                    s._duoNearMate = true;     // drop in right beside them
                    talkWait(s, 'paired', t, mateName);
                    say(s, "Teamed up with " + mateName + ". Stick together.");
                } else {
                    // already in the raid: someone takes the empty slot
                    const newcomer = mks.find(x => x !== mk);
                    const nm = newcomer && book.teamOf(mk) && book.teamOf(mk).members.get(newcomer);
                    say(s, ((nm && nm.name) || 'Someone') + " joined you as your teammate.");
                }
            }
        } else if (ev.kind === 'bot') {
            const s = socketOfKey(ev.mk);
            if (!s) continue;
            s._duoWaiting = false;
            s._duoBotAt = t + BOT_NOTICE_MS;
            talkWait(s, 'bot', t);
        }
    }
    // no room for another bot teammate: a timed-out waiter plays solo
    for (const w of [...book.waiting.values()]) {
        if (t - w.since < book.fillWaitMs) continue;
        const s = socketOfKey(w.mk);
        book.unwait(w.mk);
        if (!s) continue;
        s._duoWaiting = false;
        s.duoFill = false;
        s._duoGo = true;
        talkWait(s, 'solo', t);
        say(s, "No teammates around right now. You're playing solo this time.");
    }
}

// Keep the waiting screens' clocks honest; end the bot notice.
function tickWaiters(t) {
    for (const s of clients()) {
        if (!s || s.terminated) continue;
        if (s._duoBotAt && t >= s._duoBotAt) {
            s._duoBotAt = 0;
            s._duoGo = true;
            talkWait(s, 'done', t);
        } else if (s._duoWaiting && t - (s._duoWaitTalkAt || 0) >= 1000) {
            s._duoWaitTalkAt = t;
            talkWait(s, 'find', t);
        }
    }
}

// The spawn loop (sockets.js) asks this before dropping a human in: true
// means "not yet, they're waiting for a teammate". Parties, fill off, a
// player already on a team (respawn, reconnect, paired) and the solo server
// never wait.
function holdSpawn(socket, name) {
    if (!on() || !socket) return false;
    if (socket._duoCancelled) return true;          // pressed Cancel: leaving
    if (socket._duoBotAt) return true;              // the bot notice is up
    if (socket._duoGo || !socket.duoHello) return false;
    const mk = keyOf(socket);
    if (socket.duoPid || socket.duoFill === false || book.teamOf(mk)) {
        if (book.isWaiting(mk)) book.unwait(mk);
        socket._duoWaiting = false;
        return false;
    }
    const t = Date.now();
    if (!book.isWaiting(mk)) {
        book.wait(mk, name);
        socket._duoWaiting = true;
        socket._duoWaitSince = t;
        socket._duoWaitTalkAt = t;
        talkWait(socket, 'find', t);
        runMatch(t);
    }
    return !socket._duoGo;
}

// 'DX' from the waiting screen: 'cancel' (back to the menu) or 'solo'.
function onWaitAction(socket, what) {
    if (!on() || !socket || !socket._duoWaiting) return;
    const mk = keyOf(socket);
    book.unwait(mk);
    socket._duoWaiting = false;
    const t = Date.now();
    if (what === 'solo') {
        socket.duoFill = false;
        socket._duoGo = true;
        talkWait(socket, 'done', t);
    } else {
        socket._duoCancelled = true;
    }
}

// ---- bot teammates ----

// The human half of a bot team: {socket, body (alive) | null}
function teamHuman(team) {
    const m = [...team.members.values()][0];
    if (!m) return { socket: null, body: null, away: true };
    const s = socketOfKey(m.mk);
    const b = s && s.player && s.player.body;
    return { socket: s, body: b && !b.isDead?.() && b.team === team.id ? b : null, away: !s || !!m.away };
}

// Called by dig_royale each tick: keeps each bot teammate pointed at its
// human, notices deaths (the respawn clock), and says which ones need a body
// now and which bot bodies no longer have a team.
// -> {spawn: [{team, near}], despawn: [bot]}
function teamBotWork(t, bots) {
    const out = { spawn: [], despawn: [] };
    if (!on()) return out;
    for (const b of bots) {
        if (!b || !b.isTeamBot || b.isDead?.()) continue;
        const team = book.teamById(b.duoTeamId);
        if (!team || !team.bot || team.bot.body !== b) out.despawn.push(b);
    }
    for (const team of book.teams.values()) {
        const tb = team.bot;
        if (!tb) continue;
        const h = teamHuman(team);
        if (tb.body && (tb.body.isDead?.() || tb.body.health?.amount <= 0)) {
            // down: back after the normal respawn delay (a raid-end wipe waits
            // for nothing but the human)
            tb.respawnAt = tb.body.deathCause === 'raidend' || tb.body.deathCause === 'despawn' ? 0 : t + TEAM_BOT_RESPAWN_MS;
            tb.body = null;
        }
        if (tb.body) {
            tb.body.duoMate = h.body || null;
            tb.body.duoTeamKey = team.key;
            continue;
        }
        if (h.body && !h.away && t >= (tb.respawnAt || 0)) out.spawn.push({ team, near: h.body });
    }
    return out;
}

// dig_royale spawned the body for a team's bot.
function adoptTeamBot(team, bot, near) {
    const tb = team.bot;
    if (!tb) return;
    bot.isTeamBot = true;
    bot.duoTeamId = team.id;
    bot.duoTeamKey = team.key;
    bot.duoMate = near || null;
    if (!tb.name) tb.name = bot.name;
    if (tb.fam == null) tb.fam = bot.botFamilyId;
    tb.body = bot;
    tb.respawnAt = 0;
}

// Whoever shoots a duo human is remembered on the body, as bots already do,
// so a bot teammate knows whom to turn on.
function watchHits(body) {
    if (!on() || !body || body._duoHitWatch || typeof body.on !== 'function') return;
    body._duoHitWatch = true;
    body.on('damage', ({ damageInflictor = [] } = {}) => {
        let attacker = null;
        for (const source of damageInflictor) {
            let root = source, hops = 0;
            while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
            if (root && root.team !== body.team && (root.isBot || root.isPlayer)) { attacker = root; break; }
        }
        // own fields: _lastDamageAt on a human would read as "under fire" to
        // spotNearMate even for hits a shield or godmode ate
        if (attacker) { body._duoHitBy = attacker; body._duoHitAt = Date.now(); }
    });
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
    const tbb = teamBotBody(body.socket);
    if (tbb) return tbb.team === body.team ? tbb : null;
    const ms = mateSocket(body.socket);
    const mb = ms && ms.player && ms.player.body;
    return mb && !mb.isDead?.() && mb.team === body.team ? mb : null;
}

// A human's living bot teammate, if they have one.
function teamBotBody(socket) {
    const team = socket && socket.duoKey ? book.teamOf(socket.duoKey) : null;
    const b = team && team.bot && team.bot.body;
    return b && !b.isDead?.() ? b : null;
}

function mateOfSocketBody(socket) {
    if (!on()) return null;
    const tbb = teamBotBody(socket);
    if (tbb) return tbb;
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
    if (!mate && team && team.bot) {
        const tb = team.bot, mb = tb.body && !tb.body.isDead?.() ? tb.body : null;
        const out = { name: (mb && mb.name) || tb.name || 'Bot', bot: 1, alive: mb ? 1 : 0, away: 0 };
        if (mb) {
            out.id = mb.id;
            out.hp = mb.health && mb.health.max ? Math.max(0, Math.min(1, mb.health.amount / mb.health.max)) : 1;
            out.sh = mb.shield && mb.shield.max ? Math.max(0, Math.min(1, mb.shield.amount / mb.shield.max)) : 0;
            out.x = Math.round(mb.x); out.y = Math.round(mb.y);
            out.fight = Math.max(mb._lastDamageAt || 0, mb.hitAt || 0) > t - 4000 ? 1 : 0;
        } else if (tb.respawnAt > t) {
            out.back = Math.ceil((tb.respawnAt - t) / 1000);
        }
        return { mate: out, alone: 0, fill: 0, party: 0 };
    }
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
    const duoBots = bots.filter(b => b && b.isDuoBot && !b.isTeamBot && !b.isDead?.());
    if (duoBots.length === 1) return { team: duoBots[0].team, near: duoBots[0], duo: true };
    if (duoBots.length === 0) return { team: freshTeamId(), near: null, duo: true };
    return null;
}

// A bot joins the bot duo. Each pairing is a new formation (a new standings
// key for both), so a dead partner's row stays out of the new pair's row.
function linkBotDuo(bot, bots) {
    bot.isDuoBot = true;
    bot.duoTeamKey = book._newKey('b');
    for (const b of bots) {
        if (b === bot || !b || !b.isDuoBot || b.isDead?.() || b.team !== bot.team) continue;
        b.duoMate = bot;
        bot.duoMate = b;
        b.duoTeamKey = bot.duoTeamKey;
    }
}

// ---- standings ----

function standings(rows) { return teamStandings(rows); }

module.exports = {
    on, book, onHello, keyOf, teamForSpawn, onClose, tick, mateSocket, mateBody, mateOfSocketBody, hudFor,
    botSpawnPlan, linkBotDuo, standings, socketOfKey, freshTeamId, newRaid, teamKeyOf,
    holdSpawn, onWaitAction, teamBotWork, adoptTeamBot, watchHits, teamBotBody,
    FILL_WAIT_MS, BOT_NOTICE_MS, TEAM_BOT_RESPAWN_MS, MAX_TEAM_BOTS,
};
