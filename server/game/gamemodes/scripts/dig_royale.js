const storm = require('../../terrain/storm.js');
const vault = require('../../terrain/vault.js');
const outposts = require('../../terrain/outposts.js');
const gems = require('../../terrain/gems.js');

const RAID_MS = 2 * 60 * 60 * 1000;
const FILL_CAP = 10;
const OCCUPY_MS = 10_000;
const LOCKOUT_MS = 10_000;
const KILL_VERBS = ["killed", "slaughtered", "demolished", "wrecked", "ended", "cooked"];
const RESPAWN_MIN_MS = 15000;
const RESPAWN_MAX_MS = 15000;
const WEAK_DRILL_MS = 30_000;
const STARTER_GEMS = 75;
const KILL_SCORE = 200;

let raidId = 0;
let raidStartAt = 0;
let raidEndsAt = 0;
let raidStats = new Map();
let killFeed = [];
let occupy = new Map();
let lockout = new Map();
let raidResults = null;
let raidResultsAt = 0;
let poisCarved = false;
let lastFillAt = 0;
let lastVaultPinchAt = 0;
// Spawn-pit reservations so simultaneous joins never share a hole.
let pitReservations = new Map();

function now() { return Date.now(); }

function humans() {
    return (global.gameManager.socketManager?.players || [])
        .map(p => p && p.body)
        .filter(b => b && b.isPlayer && !b.isDead?.() && !b.isGhost);
}

function connectedClients() {
    return (global.gameManager.socketManager?.clients || []).filter(c => c && !c.terminated);
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

function stormLocked() {
    try { return storm.locked(now()); } catch { return false; }
}
function canSpawn() { return !stormLocked(); }
function requestPlay() { return true; }
function isLobbyPhase() { return false; }
function phase() { return 'live'; }

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

function killMinions(body) {
    if (!body) return;
    try {
        for (const e of [...entities.values()]) {
            if (!e || e === body || e.type === "tank") continue;
            const mine = e.master === body || e.source === body || e.parent === body;
            if (!mine) continue;
            e.invuln = false;
            e.passive = false;
            e.royaleLobby = false;
            try { e.kill(); } catch { /* */ }
        }
    } catch { /* */ }
}

function setLobby(body, on) {
    if (!body) return;
    body.royaleLobby = false;
    if (on) {
        body.passive = false;
        body.invuln = false;
    }
}

function statKeyFor(body) {
    if (!body) return null;
    if (body.socket && body.socket.id) return "s:" + body.socket.id;
    if (body.botFamilyId !== undefined) return "b:" + body.botFamilyId;
    return "b:" + body.id;
}

function ensureStat(body) {
    const key = statKeyFor(body);
    if (!key) return null;
    let s = raidStats.get(key);
    if (!s) {
        s = { key, name: body.name || "Unnamed", kills: 0, banked: 0, holds: 0, carried: 0, alive: true, id: body.id, isBot: !!body.isBot, lastSeen: now(), revengeOn: null, revengeBonus: 0 };
        raidStats.set(key, s);
    }
    s.name = body.name || s.name;
    s.id = body.id;
    s.alive = true;
    s.lastSeen = now();
    // Live carried refresh so PTS tracks the satchel: death zeroes it,
    // respawn rebuilds it. Score reads this, never a stale copy.
    try { s.carried = Math.max(0, (body.carriedGems || 0) | 0); } catch { /* */ }
    return s;
}

function scoreOf(s) {
    // PTS = banked + 200 per kill + 50% of carried + revenge bonuses. No holds.
    return (s.banked | 0) + (s.kills | 0) * KILL_SCORE + Math.floor((s.carried | 0) / 2) + (s.revengeBonus | 0);
}

function gemsOf(body) {
    const carried = (body.carriedGems || 0) | 0;
    const banked = body.socket ? ((body.socket.gemBanked || 0) | 0) : ((body.botBanked || 0) | 0);
    return carried + banked;
}

function boardSnapshot() {
    for (const body of combatants()) ensureStat(body);
    const rows = [...raidStats.values()].map(s => ({
        id: s.id,
        name: s.name || "Unnamed",
        kills: s.kills | 0,
        gems: s.banked | 0,
        holds: s.holds | 0,
        carried: s.carried | 0,
        score: scoreOf(s),
        alive: !!s.alive,
        place: 0,
    }));
    rows.sort((a, b) => (b.score - a.score) || (b.gems - a.gems) || (b.kills - a.kills));
    rows.forEach((r, i) => { r.place = i + 1; });
    // Pure points order, living and dead mixed. The Alive tab filters.
    return rows.slice(0, Math.max(32, rows.filter(r => r.alive).length));
}

function objectivesSnapshot(t) {
    const out = [];
    const list = outposts.getOutposts();
    for (const site of list) {
        if (site._contestedUntil && site._contestedUntil > t) {
            out.push({ kind: "contest", id: site.id, name: site.name, c: site.color || null, x: Math.round(site.x), y: Math.round(site.y), until: site._contestedUntil });
        }
    }
    return out;
}

function broadcast(extra = {}) {
    const t = now();
    const st = storm.snapshot(t);
    const alive = combatants().length;
    const board = boardSnapshot();
    const raidLeft = Math.max(0, Math.ceil((raidEndsAt - t) / 1000));
    const objectives = objectivesSnapshot(t);
    const lock = stormLocked() ? 1 : 0;
    let lockLeft = 0;
    try { lockLeft = storm.lockLeftSec(t); } catch { /* */ }
    // Key -> living body, built once per broadcast for revenge resolves.
    const bodyByKey = new Map();
    try {
        for (const b of combatants()) {
            if (!b || b.isDead?.()) continue;
            const k = statKeyFor(b);
            if (k && !bodyByKey.has(k)) bodyByKey.set(k, b);
        }
    } catch { /* revenge markers skip this tick */ }
    for (const client of connectedClients()) {
        const key = client.id ? "s:" + client.id : null;
        const mine = key ? raidStats.get(key) : null;
        const myRow = mine ? board.find(r => r.id === mine.id) : null;
        // Revenge target, resolved live per broadcast: position + alive so
        // the client's minimap and screen markers track the real tank. Dead
        // targets hide; respawn brings the marker straight back.
        let revenge = null;
        try {
            const rk = mine && mine.revengeOn;
            if (rk) {
                const ts = raidStats.get(rk);
                const tb = bodyByKey.get(rk) || null;
                if (ts) {
                    revenge = {
                        name: ts.name || "Someone",
                        x: tb ? Math.round(tb.x) : 0,
                        y: tb ? Math.round(tb.y) : 0,
                        id: tb ? tb.id : (ts.id || 0),
                        alive: !!tb,
                    };
                } else if (mine) mine.revengeOn = null;
            }
        } catch { revenge = null; }
        const payload = JSON.stringify({
            phase: 'live',
            left: raidLeft,
            alive,
            fill: FILL_CAP,
            humans: humans().length,
            winner: null,
            storm: st,
            toast: extra.toast || "",
            feed: killFeed.slice(-6),
            board,
            youPlace: myRow ? (myRow.place | 0) : 0,
            youScore: mine ? scoreOf(mine) : 0,
            youPB: (client.raidPB || 0) | 0,
            you: mine ? {
                score: scoreOf(mine),
                place: myRow ? (myRow.place | 0) : 0,
                banked: mine.banked | 0,
                kills: mine.kills | 0,
                holds: mine.holds | 0,
                revenge,
                carried: (() => {
                    try {
                        const b = client.player && client.player.body;
                        if (b && !b.isDead?.()) return Math.max(0, (b.carriedGems || 0) | 0);
                    } catch { /* */ }
                    return mine.carried | 0;
                })(),
            } : null,
            lock,
            lockLeft,
            matchId: raidId,
            raidId,
            raidLeft,
            raidMs: RAID_MS,
            occupyMs: OCCUPY_MS,
            lockoutMs: LOCKOUT_MS,
            objectives,
            bloom: null,
            chest: null,
            results: raidResults,
            ...extra,
        });
        client.talk('RY', payload);
    }
}

function moveTo(body, x, y) {
    if (!body) return;
    body.x = x; body.y = y;
    body.velocity.x = 0; body.velocity.y = 0;
    body.accel.x = 0; body.accel.y = 0;
    const tg = global.gameManager.terrainGrid;
    if (tg && tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(body, body.realSize || 60);
}

function openGroundNear(tg, x, y) {
    if (!tg || !tg.pointInRock) return { x, y };
    if (!tg.pointInRock(x, y)) return { x, y };
    for (let ring = 1; ring <= 8; ring++) {
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + ring * 0.3;
            const nx = x + Math.cos(a) * 60 * ring, ny = y + Math.sin(a) * 60 * ring;
            if (!tg.pointInRock(nx, ny)) return { x: nx, y: ny };
        }
    }
    return { x, y };
}

function safeSpawnSpot() {
    const t = now();
    const st = storm.snapshot(t);
    const holes = pits();
    const bodies = combatants();
    const margin = 260;
    const safeR = Math.max(80, (st.r || 0) - margin);
    for (const [k, until] of pitReservations) {
        if (until <= t) pitReservations.delete(k);
    }
    const pitKey = (h) => Math.round(h.x) + ":" + Math.round(h.y);
    let cands = holes.filter(h => Math.hypot(h.x - st.cx, h.y - st.cy) < safeR);
    if (!cands.length) {
        const tg = global.gameManager.terrainGrid;
        return openGroundNear(tg, st.cx || 0, st.cy || 0);
    }
    const free = cands.filter(h => (pitReservations.get(pitKey(h)) || 0) <= t);
    if (free.length) cands = free;
    const nearestBody = (h) => {
        let m = Infinity;
        for (const b of bodies) {
            const dx = h.x - b.x, dy = h.y - b.y;
            const d = dx * dx + dy * dy;
            if (d < m) m = d;
        }
        return Math.sqrt(m);
    };
    // Hard separation first: 2 rock-widths from any living combatant, then
    // 1 rock-width, then anything safe. Only a dead storm forces sharing.
    const TWO_ROCKS = 230, ONE_ROCK = 120;
    let pool = cands.filter(h => nearestBody(h) >= TWO_ROCKS);
    if (!pool.length) pool = cands.filter(h => nearestBody(h) >= ONE_ROCK);
    if (!pool.length) pool = cands;
    const scored = pool.map(h => ({ h, m: nearestBody(h) })).sort((a, b) => b.m - a.m);
    const top = scored.slice(0, Math.max(1, Math.min(6, scored.length)));
    const pick = top[(Math.random() * top.length) | 0].h;
    pitReservations.set(pitKey(pick), t + 6000);
    return { x: pick.x, y: pick.y };
}

function giveStarterKit(body, isRespawn) {
    if (!body) return;
    try { gems.initSatchel(body); } catch { /* */ }
    const bonus = body.socket ? ((body.socket.raidBonus || 0) | 0) : 0;
    if (body.socket) body.socket.raidBonus = 0;
    // Respawn is broke: satchel dropped on death, no free dust back.
    // First join of the raid keeps the 75 starter, top-10 bonus still pays.
    const grant = (isRespawn ? 0 : STARTER_GEMS) + bonus;
    body.carriedGems = Math.max(body.carriedGems | 0, grant);
    try { gems.updateSatchel(body); gems.talkGems(body, grant); } catch { /* */ }
    if (isRespawn) body.weakDrillUntil = now() + WEAK_DRILL_MS;
    else body.weakDrillUntil = 0;
    try {
        // Rock in your face, guaranteed: the 3 nearest rocks get soft (first
        // one pays copper), so the opening drill always cracks fast no matter
        // which pit you land in. Shared rocks - late neighbours benefit too.
        const tg = global.gameManager.terrainGrid;
        if (tg && tg.rocks) {
            const near = [];
            for (const rock of tg.rocks.values()) {
                if (!rock || !rock.alive) continue;
                const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
                const dx = rx - body.x, dy = ry - body.y;
                const d2 = dx * dx + dy * dy;
                if (d2 <= 560 * 560) near.push({ rock, d2 });
            }
            near.sort((a, b) => a.d2 - b.d2);
            const { ORE, ORE_HP } = require('../../terrain/terrainGrid.js');
            near.slice(0, 3).forEach(({ rock }, i) => {
                try {
                    if (i === 0 && !rock.ore) {
                        rock.ore = ORE.COPPER;
                        rock.maxHealth = (tg.baseRockHealth * 1.3) * (ORE_HP[ORE.COPPER] || 1);
                        try { rock.deposits = tg._buildDeposits(rock); } catch { rock.deposits = null; }
                    }
                    rock.maxHealth = Math.max(10, rock.maxHealth * 0.35);
                    rock.health = Math.min(rock.health, rock.maxHealth);
                } catch { /* that rock stays hard */ }
            });
        }
    } catch { /* */ }
}

function freshRaidBody(body) {
    if (!body || body.isDead?.()) return;
    killMinions(body);
    setLobby(body, false);
    setFrozen(body, false);
    body.invuln = true;
    body.passive = false;
    body.royaleAlive = true;
    body.deathCause = "";
    try { body.health.amount = body.health.max; } catch { /* */ }
    try { if (body.shield) body.shield.amount = body.shield.max; } catch { /* */ }
}

function spawnRaidBot() {
    const handler = global.gameManager.gameHandler;
    if (!handler) return;
    const hole = safeSpawnSpot();
    const team = getRandomTeam();
    handler.spawnBots({ x: hole.x + (Math.random() - 0.5) * 40, y: hole.y + (Math.random() - 0.5) * 40 }, team);
    const bot = handler.bots[handler.bots.length - 1];
    if (!bot) return;
    bot.team = team;
    bot.botRespawnsRemaining = 0;
    bot.royaleAlive = true;
    bot.weakDrillUntil = 0;
    try { gems.initSatchel(bot); } catch { /* */ }
    ensureStat(bot);
}

function fillBots() {
    const t = now();
    if (t - lastFillAt < 400) return;
    if (stormLocked()) return;
    if (combatants().length >= FILL_CAP) return;
    lastFillAt = t;
    spawnRaidBot();
}

function onBanked(body, amount) {
    if (!body || !(amount > 0)) return;
    const s = ensureStat(body);
    // Float accumulate; every read truncates. Rounding per-chunk used to
    // overcount outpost banking (~4%) because chunks are rarely multiples of 5.
    if (s) s.banked = (s.banked || 0) + amount;
}

function onCapture(body, site) {
    if (!body || !site) return;
    const s = ensureStat(body);
    if (s) s.holds = (s.holds | 0) + 1;
}

function killerOf(body) {
    for (const k of (body && body.finalKillers) || []) {
        if (!k || k === body) continue;
        let root = k, hops = 0;
        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
        if (!root || root === body) continue;
        if ((root.isPlayer || root.isBot) && !root.isDead?.()) return root;
    }
    return null;
}

function onCombatantDead(body) {
    if (!Config.dig_royale || !body) return;
    if (body.royaleAlive === false) return;
    body.royaleAlive = false;
    const key = statKeyFor(body);
    if (key) {
        const s = raidStats.get(key) || ensureStat(body);
        if (s) { s.alive = false; s.carried = 0; }
    }
    // Credit comes from the authoritative killer list, so human-vs-human
    // kills count (the old _lastDamageSource was only set for bot victims).
    // Storm, rock crushes and base shots are environmental: no credit, no
    // killer cam to a stale attacker across the map.
    const envKill = body.deathCause === "storm" || body.deathCause === "rock" || body.deathCause === "base";
    const stormKill = body.deathCause === "storm";
    const rockKill = body.deathCause === "rock";
    const killerBody = envKill ? null : killerOf(body);
    const killerKey = killerBody ? statKeyFor(killerBody) : null;
    // Revenge: killing the tank that killed you pays double (kill 200 +
    // bonus 200). The mark lives on the victim pointing at their killer, so
    // the bonus fires when the KILLER's mark points at the body dying now.
    // The avenge consumes the killer's mark; the victim gets a fresh mark on
    // their new killer (env deaths clear it). Target-alive gating happens at
    // broadcast: dead targets hide until they respawn.
    let avenged = false;
    if (killerBody && killerKey && killerKey !== key) {
        const ks = ensureStat(killerBody);
        if (ks) {
            ks.kills = (ks.kills | 0) + 1;
            if (ks.revengeOn && ks.revengeOn === key) {
                avenged = true;
                ks.revengeBonus = (ks.revengeBonus | 0) + KILL_SCORE;
                ks.revengeOn = null;
            }
        }
    }
    if (s) s.revengeOn = (killerBody && killerKey && killerKey !== key) ? killerKey : null;
    killFeed.push({
        name: body.name || "Unnamed",
        by: envKill ? "" : (killerBody ? (killerBody.name || "Unnamed") : ""),
        verb: avenged ? "avenged" : stormKill ? "lost" : rockKill ? "crushed" : KILL_VERBS[(Math.random() * KILL_VERBS.length) | 0],
        storm: stormKill ? 1 : 0,
        rock: rockKill ? 1 : 0,
        revenge: avenged ? 1 : 0,
        place: 0,
        at: now(),
    });
    if (killFeed.length > 24) killFeed.splice(0, killFeed.length - 24);
    if (body.socket) {
        body.socket.royaleRespawnAt = now() + RESPAWN_MIN_MS + Math.random() * (RESPAWN_MAX_MS - RESPAWN_MIN_MS);
        body.socket.royaleNeedClick = false;
        body.socket.status.readyToSpawn = true;
    }
}

function ownedSiteFor(body) {
    if (!body) return null;
    try {
        const key = outposts.ownerKeyFor ? outposts.ownerKeyFor(body) : null;
        if (!key) return null;
        const list = outposts.getOutposts();
        return list.find(s => s.ownerKey === key && s.banner && !s.banner.isDead?.()) || null;
    } catch { return null; }
}

// Shove a body out of a pad circle with velocity, not a snap. Only if they
// fight the push for 2s straight do they get placed outside (anti-camp
// fallback). Returns true once the body is outside.
// Pad boundaries are edge-to-edge, not center-to-center: a tank whose hull
// touches the pad is ON the pad. Exclusion parking puts the hull edge
// exactly on the pad edge - perfect circle collision, no mush, no nose-inside.
function padEdge(site, body, margin = 0) {
    return site.r + (body.realSize || 60) + margin;
}

function pushOut(body, cx, cy, r, speed, t, tag) {
    const dx = body.x - cx, dy = body.y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= r) {
        if (body._padPush && body._padPush.tag === tag) body._padPush = null;
        return true;
    }
    const n = d < 1e-3 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
    if (!body._padPush || body._padPush.tag !== tag) {
        body._padPush = { tag, until: t + 2000 };
    }
    body.velocity.x = Math.cos(n) * speed;
    body.velocity.y = Math.sin(n) * speed;
    if (t > body._padPush.until) {
        body.x = cx + Math.cos(n) * (r + 8);
        body.y = cy + Math.sin(n) * (r + 8);
        try {
            const tg = global.gameManager.terrainGrid;
            if (tg && tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(body, body.realSize || 60);
        } catch { /* */ }
        body.velocity.x = Math.cos(n) * speed;
        body.velocity.y = Math.sin(n) * speed;
        body._padPush = null;
        return true;
    }
    return false;
}

function onHumanJoin(body) {
    if (!Config.dig_royale || !body) return;
    try {
        if (outposts.rebindOwner) {
            const key = outposts.ownerKeyFor ? outposts.ownerKeyFor(body) : null;
            if (key) outposts.rebindOwner(key, body);
        }
    } catch { /* */ }
    const isRespawn = !!(body.socket && body.socket.lastRaidDeathAt);
    const home = ownedSiteFor(body);
    let homeSpawn = false;
    if (home) {
        let inStorm = false;
        try { inStorm = storm.inStorm(home.x, home.y); } catch { /* */ }
        if (!inStorm) {
            homeSpawn = true;
            occupy.delete(home.id);
            moveTo(body, home.x + (Math.random() - 0.5) * 30, home.y + (Math.random() - 0.5) * 30);
            try { body.sendMessage("Back on your base. 10 seconds, then move along."); } catch { /* */ }
        }
    }
    if (!homeSpawn) {
        const hole = safeSpawnSpot();
        moveTo(body, hole.x + (Math.random() - 0.5) * 30, hole.y + (Math.random() - 0.5) * 30);
    }
    freshRaidBody(body);
    giveStarterKit(body, isRespawn);
    ensureStat(body);
    if (body.socket) {
        body.socket.royaleEliminated = false;
        body.socket.royalePlace = 0;
        body.socket.royaleNeedClick = false;
        body.socket.lastRaidDeathAt = 0;
    }
}

function markHumanDeath(socket) {
    if (socket) socket.lastRaidDeathAt = now();
}

// A socket is gone: mark the stat dead (no feed entry), drop any deposit,
// and release owned bases so they do not brick for everyone else.
function disconnectCleanup(socket, body) {
    if (!Config.dig_royale) return;
    try {
        if (body && body.royaleAlive !== false) {
            body.royaleAlive = false;
            const key = statKeyFor(body);
            const s = key ? raidStats.get(key) : null;
            if (s) { s.alive = false; s.carried = 0; }
        }
        if (body) {
            try { require('../../terrain/vault.js').cancelDeposit(body, false); } catch { /* */ }
            body.vaultDeposit = null;
            body._vaultSite = null;
            body._vaultPush = null;
            body._vaultPadSince = 0;
            body._padPush = null;
            body._padReentryUntil = 0;
            body._padReentryPad = null;
            body.outpostDeposit = null;
        }
        if (socket && socket.id && outposts.releaseOwner) {
            outposts.releaseOwner("s:" + socket.id);
        }
    } catch { /* */ }
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
            const bodyR = body.realSize || 60;
            const inside = d < site.r;
            // Edge overlap: hull touching the pad counts as on it. Every
            // exclusion below uses this, so nobody can nose inside.
            const touching = d < site.r + bodyR;
            // 5s no re-entry after any kick: hard deny, not a soft push.
            // While blocked the body is parked hull-to-edge every tick so
            // it cannot be overpowered, and the occupy timer is wiped so no
            // stale entry causes an instant re-kick later.
            if (touching && body._padReentryUntil && t < body._padReentryUntil &&
                (!body._padReentryPad || body._padReentryPad === site)) {
                if (body.outpostDeposit) {
                    body.outpostDeposit = null;
                    try { body.socket && body.socket.talk('VP', 0, 0); } catch { /* */ }
                }
                occupy.delete(site.id);
                const n = (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
                const park = padEdge(site, body, 3);
                body.x = site.x + Math.cos(n) * park;
                body.y = site.y + Math.sin(n) * park;
                body.velocity.x = 0; body.velocity.y = 0;
                body._padPush = null;
                continue;
            }
            if (ownerId && body.id !== ownerId && touching) {
                pushOut(body, site.x, site.y, padEdge(site, body, 6), 9, t, "bounce:" + site.id);
                site._contestedUntil = t + 8000;
                continue;
            }
            if (body._padPush && body._padPush.tag === "bounce:" + site.id && !touching) {
                body._padPush = null;
            }
            if (ownerId === body.id && lockedUntil > t && d < site.r + bodyR + 4) {
                pushOut(body, site.x, site.y, padEdge(site, body, 6), 9, t, "lock:" + site.id);
                continue;
            }
            if (ownerId === body.id && inside) {
                let rec = occupy.get(site.id);
                if (!rec || rec.ownerId !== body.id || ((rec.leftAt || 0) && t - rec.leftAt > 5000)) {
                    rec = { ownerId: body.id, enteredAt: t, leftAt: 0 };
                    occupy.set(site.id, rec);
                } else if (rec.leftAt) {
                    rec.leftAt = 0;
                }
                const left = OCCUPY_MS - (t - rec.enteredAt);
                site.occupyLeft = Math.max(0, Math.ceil(left / 1000));
                if (body.socket) body.socket.talk('RYO', site.id, Math.max(0, Math.ceil(left / 1000)), 0);
                if (left <= 0) {
                    const out = pushOut(body, site.x, site.y, padEdge(site, body, 6), 12, t, "camp:" + site.id);
                    if (out) {
                        occupy.delete(site.id);
                        lockout.set(key, t + LOCKOUT_MS);
                        body._padReentryUntil = t + 5000;
                        body._padReentryPad = site;
                        if (body.socket) body.socket.talk('RYO', site.id, 0, Math.ceil(LOCKOUT_MS / 1000));
                        try { body.sendMessage("You cannot camp your base. It stays yours. (5s no re-entry)"); } catch { /* */ }
                    }
                }
            } else if (ownerId === body.id && !inside) {
                // Stepping out pauses, not resets: back within 5s resumes the
                // camp timer, so dipping out at 9s can't dodge the kick.
                const rec = occupy.get(site.id);
                if (rec && rec.ownerId === body.id) {
                    if (!rec.leftAt) rec.leftAt = t;
                    else if (t - rec.leftAt > 5000) occupy.delete(site.id);
                }
                if (lockedUntil > t && body.socket)
                    body.socket.talk('RYO', site.id, 0, Math.ceil((lockedUntil - t) / 1000));
            }
        }
    }
}

function tickVaultPinch(t) {
    if (t - lastVaultPinchAt < 15000) return;
    const st = storm.snapshot(t);
    if (!st.a) return;
    const list = vault.getVaults();
    for (const v of list) {
        const d = Math.hypot(v.x - st.cx, v.y - st.cy);
        const margin = st.r - d;
        if (margin > 0 && margin < st.max * 0.18) {
            lastVaultPinchAt = t;
            broadcast({ toast: "Storm is about to pinch a vault. Bank now or move." });
            return;
        }
    }
}

function wipeWall() {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return;
    const t = now();
    let queued = 0;
    for (const rock of tg.rocks.values()) {
        if (rock.alive || rock.growing) continue;
        if (!rock.diedAt) continue;
        if (rock.canyon) continue;
        try { tg.startRegrow(rock, t + (queued % 20) * 50); } catch { /* */ }
        queued++;
        if (queued > 900) break;
    }
}

function startRaid(first) {
    if (first && raidId) return;
    raidId++;
    raidStartAt = now();
    raidEndsAt = raidStartAt + RAID_MS;
    raidStats = new Map();
    killFeed = [];
    occupy.clear();
    lockout.clear();
    raidResults = null;
    if (!poisCarved) {
        try { require('../../terrain/royaleLayout.js').carveMatchPois(global.gameManager.terrainGrid); } catch { /* */ }
        poisCarved = true;
    }
    storm.start();
    if (!first) {
        wipeWall();
        try {
            for (const e of [...entities.values()]) {
                if (e && e.isGemPickup && !e.isDead?.()) e.kill();
            }
        } catch { /* */ }
        try { outposts.resetRoyale && outposts.resetRoyale(); } catch { /* */ }
        occupy.clear();
        lockout.clear();
        // Live bodies keep no raid state across the wall: deposits, pad
        // pushes, and contest fields all end at the reset.
        try {
            const vaultMod = require('../../terrain/vault.js');
            for (const body of combatants()) {
                if (body.vaultDeposit && vaultMod.cancelDeposit) vaultMod.cancelDeposit(body, false);
                else { body.vaultDeposit = null; }
                body._vaultSite = null;
                body._vaultPush = null;
                body._vaultPadSince = 0;
                body._padPush = null;
                body.outpostDeposit = null;
            }
            for (const site of outposts.getOutposts()) {
                site._contestedUntil = 0;
                site._lastHitter = null;
                site.occupyLeft = 0;
            }
        } catch { /* */ }
        for (const body of combatants()) {
            const hole = safeSpawnSpot();
            moveTo(body, hole.x, hole.y);
            freshRaidBody(body);
            giveStarterKit(body, false);
            ensureStat(body);
        }
        for (const client of connectedClients()) {
            if (client.player && client.player.body && !client.player.body.isDead?.()) continue;
            client.royaleNeedClick = false;
            client.status.readyToSpawn = true;
        }
    }
    broadcast({ toast: first ? "Raid live. Mine, bank, fight. Storm is the clock." : "New raid. Wall regrowing. Go." });
}

function endRaid() {
    // Synchronous guard: an event-loop stall must not double-pay top 10.
    raidEndsAt = Infinity;
    const board = boardSnapshot();
    const top = board.slice(0, 10);
    const bonuses = [500, 350, 250, 180, 140, 110, 90, 70, 50, 40];
    for (let i = 0; i < top.length; i++) {
        const row = top[i];
        for (const client of connectedClients()) {
            const key = client.id ? "s:" + client.id : null;
            const s = key ? raidStats.get(key) : null;
            if (s && s.id === row.id) {
                client.raidBonus = (client.raidBonus | 0) + bonuses[i];
                const sc = scoreOf(s);
                if (sc > (client.raidPB | 0)) client.raidPB = sc;
            }
        }
    }
    for (const client of connectedClients()) {
        const key = client.id ? "s:" + client.id : null;
        const s = key ? raidStats.get(key) : null;
        if (s) {
            const sc = scoreOf(s);
            if (sc > (client.raidPB | 0)) client.raidPB = sc;
        }
    }
    raidResults = { raidId, top, at: now() };
    raidResultsAt = now();
    try {
        const names = top.slice(0, 3).map((r, i) => "#" + (i + 1) + " " + r.name).join(", ");
        global.gameManager.socketManager.broadcast("Raid over. Top: " + (names || "no scores") + ". New raid starting.");
    } catch { /* */ }
    broadcast({ toast: "Raid over. Paying top 10. New raid starting." });
    setTimeout(() => {
        try {
            for (const client of connectedClients()) {
                if (client.socket) { /* noop */ }
                if (client.gemBanked) client.gemBanked = 0;
                client._milestoneIdx = 0;
            }
            for (const body of combatants()) {
                body.carriedGems = 0;
                body.botBanked = 0;
                body.bankedGems = 0;
                if (body.socket) body.socket.gemBanked = 0;
                try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
            }
        } catch { /* */ }
        startRaid(false);
    }, 8000);
}

function tick() {
    if (!Config.dig_royale) return;
    const t = now();
    if (!raidId) startRaid(true);
    if (t >= raidEndsAt && !raidResults) {
        endRaid();
        return;
    }
    if (raidResults && t - raidResultsAt > 8000) raidResults = null;
    storm.ensureActive();
    storm.tickDamage(t);
    tickOutpostRules(t);
    tickVaultPinch(t);
    fillBots();
    for (const body of combatants()) {
        const key = statKeyFor(body);
        const s = key ? raidStats.get(key) : null;
        if (s) { s.alive = true; s.lastSeen = t; }
    }
    for (const s of raidStats.values()) {
        if (t - s.lastSeen > 30000) s.alive = false;
    }
    // Sweep every 30s: drop long-dead rows (bot churn mints one per bot
    // life; the dead only stay dead if they disconnected) and expired
    // lockouts. The dead auto-respawn in 15s, so 5min dead means gone.
    if (t - (tick._sweepAt || 0) > 30000) {
        tick._sweepAt = t;
        for (const [k, s] of raidStats) {
            if (!s.alive && t - (s.lastSeen || 0) > 5 * 60 * 1000) raidStats.delete(k);
        }
        for (const [k, u] of lockout) {
            if (u <= t) lockout.delete(k);
        }
    }
    if (t - (tick._broadcastAt || 0) >= 500) {
        tick._broadcastAt = t;
        broadcast();
    }
}

function stormFleePoint(body) {
    if (!storm.inStorm(body.x, body.y)) return null;
    const r = Math.max(40, storm.radius() - 80);
    const d = Math.hypot(body.x - storm.snapshot().cx, body.y - storm.snapshot().cy) || 1;
    const st = storm.snapshot();
    const dx = (body.x - st.cx) / d, dy = (body.y - st.cy) / d;
    return { x: st.cx + dx * r, y: st.cy + dy * r };
}

class DigRoyale {
    constructor(gameManager) { this.gameManager = gameManager; }
    start() { startRaid(true); }
    loop() { /* clock runs from the terrain tick */ }
    reset() { startRaid(false); }
    redefine(gm) { this.gameManager = gm; }
}

module.exports = {
    DigRoyale, canSpawn, requestPlay, onHumanJoin, onCombatantDead, markHumanDeath, disconnectCleanup, phase, isLobbyPhase, stormFleePoint,
    lobbyPos, tick, onBanked, onCapture, FILL_CAP, stormLocked,
};
