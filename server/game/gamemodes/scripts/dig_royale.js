const storm = require('../../terrain/storm.js');
const vault = require('../../terrain/vault.js');
const outposts = require('../../terrain/outposts.js');
const gems = require('../../terrain/gems.js');

const LOBBY_MS = 100_000;
const LOADOUT_MS = 30_000;
const OVER_MS = 9_000;
const FILL_CAP = 20;
const OCCUPY_MS = 10_000;
const LOCKOUT_MS = 10_000;

let phase = 'idle';
let phaseAt = 0;
let winner = null;
let placements = new Map();
let killFeed = [];
let occupy = new Map(); // outpostId -> { ownerId, enteredAt }
let lockout = new Map(); // `${outpostId}:${bodyId}` -> until
let matchId = 0;
let matchStartAt = 0;

function now() { return Date.now(); }

function humans() {
    return (global.gameManager.socketManager?.players || [])
        .map(p => p && p.body)
        .filter(b => b && b.isPlayer && !b.isDead?.() && !b.isGhost);
}

function humanSockets() {
    return global.gameManager.socketManager?.clients || [];
}

function combatants() {
    const bots = (global.gameManager.gameHandler?.bots || [])
        .filter(b => b && !b.isDead() && !b.isGhost);
    return humans().concat(bots);
}

function lobbyPos() {
    const tg = global.gameManager.terrainGrid;
    return tg?.lobbyPos || { x: 0, y: 0, r: 280 };
}

function pits() {
    return global.gameManager.terrainGrid?.spawnPits || [{ x: 0, y: 0 }];
}

function canSpawn() {
    return phase === 'idle' || phase === 'lobby';
}

function isLobbyPhase() {
    return phase === 'idle' || phase === 'lobby';
}

function setFrozen(body, frozen) {
    if (!body) return;
    body.royaleFrozen = !!frozen;
    if (frozen) {
        body.control.fire = false;
        body.control.main = false;
        body.control.alt = false;
        body.control.goal = { x: body.x, y: body.y };
        body.velocity.x = 0; body.velocity.y = 0;
        body.accel.x = 0; body.accel.y = 0;
    }
}

// Lobby = Fortnite playground: free movement + free shooting/mining for fun,
// but invulnerable + passive so nobody can hurt or kill anyone. Gems are
// suppressed separately in spawnOreBurst (royaleLobby check), and vaults/
// outposts are gated by isLobbyPhase so there is nothing to bank at.
function setLobby(body, on) {
    if (!body) return;
    body.royaleLobby = !!on;
    body.passive = !!on;
    // Invuln blocks guns (gun.live). Lobby uses passive so you can fire
    // and mine, but nobody can hurt anybody.
    body.invuln = false;
    if (on) {
        body.godmode = false;
        setFrozen(body, false);
    }
}

function gemsOf(body) {
    const carried = (body.carriedGems || 0) | 0;
    const banked = body.socket ? ((body.socket.gemBanked || 0) | 0) : ((body.botBanked || 0) | 0);
    return carried + banked;
}

// Standings for the F-toggle minimap board. Alive first, then dead by
// placement. Client sorts by gems or kills.
function boardSnapshot() {
    const out = [];
    const seen = new Set();
    for (const body of combatants()) {
        if (!body || seen.has(body.id)) continue;
        seen.add(body.id);
        out.push({
            id: body.id,
            name: body.name || "Unnamed",
            kills: (body.killCount && body.killCount.solo | 0) || 0,
            gems: gemsOf(body),
            alive: true,
            place: 0,
        });
    }
    for (const [id, place] of placements) {
        if (seen.has(id)) {
            const row = out.find(r => r.id === id);
            if (row) { row.place = place; }
            continue;
        }
        // recently dead: keep them on the board with their placement
        out.push({ id, name: "Eliminated", kills: 0, gems: 0, alive: false, place });
    }
    // attach names for dead where we still know them via feed
    for (const row of out) {
        if (row.name === "Eliminated") {
            const f = killFeed.find(k => k.place === row.place);
            if (f && f.name) row.name = f.name;
        }
    }
    return out.slice(0, 24);
}

function broadcast(extra = {}) {
    const t = now();
    const left = phase === 'lobby' ? Math.max(0, LOBBY_MS - (t - phaseAt))
        : phase === 'loadout' ? Math.max(0, LOADOUT_MS - (t - phaseAt))
        : phase === 'over' ? Math.max(0, OVER_MS - (t - phaseAt))
        : 0;
    const st = storm.snapshot(t);
    const alive = phase === 'live' || phase === 'loadout' ? combatants().length : 0;
    const board = boardSnapshot();
    for (const client of humanSockets()) {
        const youPlace = (client && client.royalePlace) || 0;
        const payload = JSON.stringify({
            phase,
            left: Math.ceil(left / 1000),
            alive,
            fill: FILL_CAP,
            humans: humans().length,
            winner: winner ? { name: winner.name || "Unnamed", id: winner.id } : null,
            storm: st,
            toast: extra.toast || "",
            feed: killFeed.slice(-6),
            board,
            youPlace,
            matchId,
            occupyMs: OCCUPY_MS,
            lockoutMs: LOCKOUT_MS,
            ...extra,
        });
        client.talk('RY', payload);
    }
}

function go(next) {
    phase = next;
    phaseAt = now();
    broadcast({ toast: next === 'lobby' ? 'Drop in - break rocks, warm up, no gems yet'
        : next === 'loadout' ? 'Upgrade your build and tanks'
        : next === 'live' ? 'Last one standing wins'
        : next === 'over' ? ((winner && winner.name) || 'Someone') + ' wins'
        : '' });
}

function moveTo(body, x, y) {
    if (!body) return;
    body.x = x; body.y = y;
    body.velocity.x = 0; body.velocity.y = 0;
    body.accel.x = 0; body.accel.y = 0;
    const tg = global.gameManager.terrainGrid;
    if (tg && tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(body, body.realSize || 60);
}

// Pick N holes maximally separated: greedy farthest-point subset from a
// random seed, so neighbours never drop side by side.
function pickSeparatedHoles(holes, n) {
    if (!holes.length) return [];
    if (n >= holes.length) {
        const shuffled = holes.slice();
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) | 0;
            const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
        }
        return shuffled;
    }
    const picked = [holes[(Math.random() * holes.length) | 0]];
    while (picked.length < n) {
        let best = null, bestMin = -1;
        for (const h of holes) {
            if (picked.includes(h)) continue;
            let m = Infinity;
            for (const p of picked) {
                const dx = h.x - p.x, dy = h.y - p.y;
                const d = dx * dx + dy * dy;
                if (d < m) m = d;
            }
            if (m > bestMin) { bestMin = m; best = h; }
        }
        if (!best) break;
        picked.push(best);
    }
    return picked;
}

// Fresh loadout for every combatant: back to Basic, skills wiped, then a full
// level grant so the 30s freeze is actually spent upgrading.
function resetRoyaleBody(body) {
    if (!body || body.isDead?.()) return;
    try {
        body.define(Config.spawn_class || 'basic');
    } catch { /* keep current class if define fails */ }
    try {
        if (body.skill) {
            body.skill.reset();
            const target = Config.level_cap_cheat || 45;
            let guard = 0;
            while (body.skill.level < target && guard++ < 500) {
                body.skill.score += body.skill.levelScore;
                body.skill.maintain();
            }
            body.skill.points = (body.skill.points || 0);
            body.refreshBodyAttributes();
        }
    } catch { /* best effort */ }
    try {
        body.killCount.solo = 0;
        body.killCount.assists = 0;
    } catch { /* keep */ }
    body.carriedGems = 0;
    if (body.socket) { body.socket.gemBanked = 0; body.bankedGems = 0; }
    else { body.botBanked = 0; body.bankedGems = 0; }
    try { gems.initSatchel(body); } catch { /* */ }
    try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
    body.health.amount = body.health.max;
    if (body.shield) body.shield.amount = body.shield.max;
}

function scatter() {
    matchId++;
    matchStartAt = now();
    placements = new Map();
    killFeed = [];
    occupy.clear();
    lockout.clear();
    // clear leftover loot from the last match / lobby so nobody drops onto gems
    try {
        for (const e of [...entities.values()]) {
            if (e && e.isGemPickup && !e.isDead?.()) e.kill();
        }
    } catch { /* */ }
    const list = combatants();
    const holes = pits().slice();
    const handler = global.gameManager.gameHandler;
    const need = Math.max(0, FILL_CAP - list.length);
    // bot fill spawns at separated holes too
    const fillHoles = pickSeparatedHoles(holes, Math.min(holes.length, list.length + need));
    for (let i = 0; i < need; i++) {
        const hole = fillHoles[(list.length + i) % fillHoles.length] || { x: 0, y: 0 };
        const team = getRandomTeam();
        handler.spawnBots({ x: hole.x, y: hole.y }, team);
        const bot = handler.bots[handler.bots.length - 1];
        if (bot) {
            bot.team = team;
            bot.botRespawnsRemaining = 0;
            bot.botWakeAt = now();
            bot.botNextUpgradeAt = now();
            // bots use the freeze to pick class + stats fast
            bot.leftoverUpgrades = Math.max(bot.leftoverUpgrades || 0, 4);
            gems.initSatchel(bot);
        }
    }
    const all = combatants();
    try { require('../../terrain/royaleLayout.js').carveMatchPois(global.gameManager.terrainGrid); } catch { /* */ }
    const spots = pickSeparatedHoles(holes, all.length);
    all.forEach((body, i) => {
        const hole = spots[i % spots.length] || { x: 0, y: 0 };
        resetRoyaleBody(body);
        moveTo(body, hole.x + (Math.random() - 0.5) * 30, hole.y + (Math.random() - 0.5) * 30);
        setLobby(body, false);
        setFrozen(body, true);
        body.invuln = true;
        body.passive = true;
        body.royaleAlive = true;
        body.partySize = 1;
        if (!body.team || body.team === TEAM_BLUE || body.team === TEAM_RED)
            body.team = getRandomTeam();
        body.health.amount = body.health.max;
        gems.initSatchel(body);
        if (body.socket) {
            body.socket.royaleEliminated = false;
            // bots upgrade on their own; humans get max-level points to spend
            if (body.skill) {
                try {
                    const target = Config.level_cap_cheat || 45;
                    let guard = 0;
                    while (body.skill.level < target && guard++ < 500) {
                        body.skill.score += body.skill.levelScore;
                        body.skill.maintain();
                    }
                    body.refreshBodyAttributes();
                } catch { /* */ }
            }
        } else {
            // bot loadout: force quick upgrade path during the freeze
            body.botWakeAt = now();
            body.botNextUpgradeAt = now();
            body.leftoverUpgrades = Math.max(body.leftoverUpgrades || 0, 4);
        }
    });
}

function startLive() {
    for (const body of combatants()) {
        setFrozen(body, false);
        setLobby(body, false);
        body.invuln = false;
        body.passive = false;
        body.royaleAlive = true;
    }
    storm.start();
}

function place(body) {
    if (!body || placements.has(body.id)) return;
    const remaining = combatants().filter(b => b !== body).length;
    placements.set(body.id, remaining + 1);
    const killer = body._lastDamageSource;
    killFeed.push({
        name: body.name || "Unnamed",
        by: killer && (killer.isPlayer || killer.isBot) ? (killer.name || "Unnamed") : (body.deathCause === "storm" ? "Storm" : ""),
        place: remaining + 1,
        at: now(),
    });
    if (body.socket) {
        body.socket.royaleEliminated = true;
        body.socket.royalePlace = remaining + 1;
        body.socket.talk('RYP', remaining + 1);
    }
}

function onCombatantDead(body) {
    if (!Config.dig_royale || !body) return;
    if (phase !== 'live' && phase !== 'loadout') return;
    if (body.royaleAlive === false) return;
    body.royaleAlive = false;
    place(body);
}

function checkWinner() {
    if (phase !== 'live') return;
    const live = combatants();
    if (live.length > 1) return;
    winner = live[0] || null;
    if (winner) placements.set(winner.id, 1);
    storm.stop();
    for (const body of combatants()) setFrozen(body, true);
    go('over');
}

function resetMatch() {
    storm.stop();
    occupy.clear();
    lockout.clear();
    winner = null;
    const handler = global.gameManager.gameHandler;
    for (const bot of (handler.bots || []).slice()) {
        if (bot && !bot.isDead()) bot.kill();
    }
    handler.bots.length = 0;
    // clear match loot so the next lobby starts clean
    try {
        for (const e of [...entities.values()]) {
            if (e && e.isGemPickup && !e.isDead?.()) e.kill();
        }
    } catch { /* */ }
    outposts.resetRoyale && outposts.resetRoyale();
    const plaza = lobbyPos();
    for (const body of humans()) {
        moveTo(body, plaza.x + (Math.random() - 0.5) * 220, plaza.y + (Math.random() - 0.5) * 220);
        resetRoyaleBody(body);
        setLobby(body, true);
        body.royaleAlive = false;
        if (body.socket) body.socket.royaleEliminated = false;
        if (body.socket) body.socket.royalePlace = 0;
        body.health.amount = body.health.max;
    }
    if (humans().length) go('lobby');
    else go('idle');
}

function onHumanJoin(body) {
    if (!Config.dig_royale || !body) return;
    const plaza = lobbyPos();
    if (phase === 'idle' || phase === 'lobby') {
        moveTo(body, plaza.x + (Math.random() - 0.5) * 220, plaza.y + (Math.random() - 0.5) * 220);
        setLobby(body, true);
        if (phase === 'idle') go('lobby');
    }
}

function tick() {
    if (!Config.dig_royale) return;
    const t = now();
    const people = humans();

    if (phase === 'idle') {
        if (people.length) go('lobby');
        storm.stop();
        return;
    }
    if (!people.length && phase !== 'over') {
        for (const bot of (global.gameManager.gameHandler.bots || []).slice()) {
            if (bot && !bot.isDead()) bot.kill();
        }
        global.gameManager.gameHandler.bots.length = 0;
        storm.stop();
        go('idle');
        return;
    }

    if (phase === 'lobby') {
        for (const body of people) setLobby(body, true);
        if (t - phaseAt >= LOBBY_MS) {
            go('loadout');
            scatter();
        }
    } else if (phase === 'loadout') {
        for (const body of combatants()) setFrozen(body, true);
        if (t - phaseAt >= LOADOUT_MS) {
            startLive();
            go('live');
        }
    } else if (phase === 'live') {
        storm.tickDamage(t);
        tickOutpostRules(t);
        checkWinner();
    } else if (phase === 'over') {
        if (t - phaseAt >= OVER_MS) resetMatch();
    }

    if (t - (tick._broadcastAt || 0) >= 200) {
        tick._broadcastAt = t;
        broadcast();
    }
}

function tickOutpostRules(t) {
    const list = outposts.getOutposts();
    const bodies = combatants();
    for (const site of list) {
        site.occupyLeft = 0;
        const ownerId = site.ownerId;
        for (const body of bodies) {
            const dx = body.x - site.x, dy = body.y - site.y;
            const d = Math.hypot(dx, dy);
            const key = site.id + ':' + body.id;
            const lockedUntil = lockout.get(key) || 0;
            const inside = d < site.r;

            if (ownerId && body.id !== ownerId && inside) {
                const n = d < 1e-3 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
                body.x = site.x + Math.cos(n) * (site.r + 18);
                body.y = site.y + Math.sin(n) * (site.r + 18);
                body.velocity.x = Math.cos(n) * 8;
                body.velocity.y = Math.sin(n) * 8;
                continue;
            }
            if (ownerId === body.id && lockedUntil > t && d < site.r + 10) {
                const n = d < 1e-3 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
                body.x = site.x + Math.cos(n) * (site.r + 22);
                body.y = site.y + Math.sin(n) * (site.r + 22);
                continue;
            }
            if (ownerId === body.id && inside) {
                let rec = occupy.get(site.id);
                if (!rec || rec.ownerId !== body.id) {
                    rec = { ownerId: body.id, enteredAt: t };
                    occupy.set(site.id, rec);
                }
                const left = OCCUPY_MS - (t - rec.enteredAt);
                site.occupyLeft = Math.max(0, Math.ceil(left / 1000));
                if (body.socket) body.socket.talk('RYO', site.id, Math.max(0, Math.ceil(left / 1000)), 0);
                if (left <= 0) {
                    const n = d < 1e-3 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
                    body.x = site.x + Math.cos(n) * (site.r + 28);
                    body.y = site.y + Math.sin(n) * (site.r + 28);
                    body.velocity.x = Math.cos(n) * 11;
                    body.velocity.y = Math.sin(n) * 11;
                    occupy.delete(site.id);
                    lockout.set(key, t + LOCKOUT_MS);
                    if (body.socket) body.socket.talk('RYO', site.id, 0, Math.ceil(LOCKOUT_MS / 1000));
                }
            } else if (ownerId === body.id && !inside) {
                occupy.delete(site.id);
                if (lockedUntil > t && body.socket)
                    body.socket.talk('RYO', site.id, 0, Math.ceil((lockedUntil - t) / 1000));
            }
        }
    }
}

function stormFleePoint(body) {
    if (!storm.inStorm(body.x, body.y)) return null;
    const r = Math.max(40, storm.radius() - 80);
    const d = Math.hypot(body.x, body.y) || 1;
    return { x: (body.x / d) * r, y: (body.y / d) * r };
}

class DigRoyale {
    constructor(gameManager) { this.gameManager = gameManager; }
    start() { go('idle'); storm.stop(); }
    loop() { /* occupancy + clock run from the terrain tick */ }
    reset() { resetMatch(); }
    redefine(gm) { this.gameManager = gm; }
}

module.exports = {
    DigRoyale, canSpawn, onHumanJoin, onCombatantDead, phase: () => phase, isLobbyPhase, stormFleePoint,
    lobbyPos, tick, FILL_CAP,
};
