const storm = require('../../terrain/storm.js');
const vault = require('../../terrain/vault.js');
const outposts = require('../../terrain/outposts.js');
const gems = require('../../terrain/gems.js');
const shop = require('../../terrain/shop.js');
const chests = require('../../terrain/chests.js');
const padGeom = require('../../terrain/padGeom.js');
const bosses = require('../../terrain/bosses.js');
const blooms = require('../../terrain/blooms.js');
const raidEvents = require('../../terrain/raidEvents.js');
const raidMods = require('../../terrain/raidMods.js');

const RAID_MS = 2 * 60 * 60 * 1000;
// Raid size including humans: a solo player gets 5 bots, and each real
// player who joins takes a bot's place.
const FILL_CAP = 6;
const OCCUPY_MS = 10_000;
const LOCKOUT_MS = 10_000;
const KILL_VERBS = ["killed", "slaughtered", "demolished", "wrecked", "ended", "cooked"];
const RESPAWN_MIN_MS = 15000;
const WEAK_DRILL_MS = 30_000;
const STARTER_GEMS = 75;
const SPAWN_GRACE_MS = 4000;   // spawn shield holds this long even if you move
const KILL_SCORE = 200;
// Streaks: three kills marks you on every minimap. Each kill past that pays
// more, and whoever ends you collects a shutdown bounty.
const STREAK_MARK_AT = 4;
const STREAK_BONUS_PER = 50;
const SHUTDOWN_PER_STREAK = 100;

// First-minutes quest chain: one line, a number, a reward. Shown one at a time.
const QUESTS = [
    { id: "bank",  goal: 100,  text: "Bank 100 dust",             reward: 50 },
    { id: "chest", goal: 1,    text: "Break open a chest",        reward: 100 },
    { id: "kill",  goal: 1,    text: "Kill another miner",        reward: 200 },
    { id: "shop",  goal: 1,    text: "Buy anything at a shop",    reward: 150 },
    { id: "bank2", goal: 1000, text: "Bank 1,000 dust",           reward: 300 },
];

let raidId = 0;
let raidStartAt = 0;
let raidEndsAt = 0;
let raidStats = new Map();
let killFeed = [];
let occupy = new Map();
const PIT_RESERVE_MS = 20_000;
const PIT_RESERVE_R = 260;
let lockout = new Map();
let raidResults = null;
// Between "raid over" and the next raid: everyone is down, nobody spawns.
let raidEnding = false;
const RAID_END_BEAT_MS = 1600;     // the "RAID OVER" moment before everyone goes down
const RAID_END_WAIT_MS = 15_000;   // then everyone waits this long, together
let raidResultsAt = 0;
let poisCarved = false;
let lastFillAt = 0;
let lastVaultPinchAt = 0;
let pitReservations = new Map();
let toastText = "";
let toastUntil = 0;
let lastMods = null;

function now() { return Date.now(); }

function humans() {
    return (global.gameManager.socketManager?.players || [])
        .map(p => p && p.body)
        .filter(b => b && b.isPlayer && !b.isDead?.() && !b.isGhost);
}

function connectedClients() {
    return (global.gameManager.socketManager?.clients || []).filter(c => c && !c.terminated);
}

let _combAt = 0, _comb = null;
function combatants() {
    // asked for several times per 16 ms tick; one list per tick is plenty
    const t = Date.now();
    if (_comb && t - _combAt < 16) return _comb;
    _combAt = t;
    const bots = (global.gameManager.gameHandler?.bots || [])
        .filter(b => b && !b.isDead() && !b.isGhost);
    _comb = humans().concat(bots);
    return _comb;
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
function canSpawn() { return !stormLocked() && !raidEnding; }
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
        s = { key, name: body.name || "Unnamed", kills: 0, banked: 0, holds: 0, carried: 0, alive: true, id: body.id, isBot: !!body.isBot, lastSeen: now(), revengeOn: null, revengeBonus: 0, extra: 0, streak: 0, bestStreak: 0, bossKills: 0, chests: 0 };
        raidStats.set(key, s);
    }
    s.name = body.name || s.name;
    s.id = body.id;
    s.alive = true;
    s.lastSeen = now();
    try { s.carried = Math.max(0, (body.carriedGems || 0) | 0); } catch { /* */ }
    return s;
}

function killScore() { return Math.round(KILL_SCORE * raidMods.num('killScoreMult', 1)); }

function scoreOf(s) {
    // PTS = banked + kills + 50% carried + revenge/streak/boss/quest bonuses.
    return (s.banked | 0) + (s.kills | 0) * killScore() + Math.floor((s.carried | 0) / 2) + (s.revengeBonus | 0) + (s.extra | 0);
}

function gemsOf(body) {
    const carried = (body.carriedGems || 0) | 0;
    const banked = body.socket ? ((body.socket.gemBanked || 0) | 0) : ((body.botBanked || 0) | 0);
    return carried + banked;
}

function boardSnapshot() {
    // "alive" is read straight off the bodies in the game this instant, spawn
    // shield or not, instead of the lastSeen flag; "here" also covers a human
    // who is connected but dead (respawning), so the Alive tab can list them.
    const liveKeys = new Set();
    for (const body of combatants()) {
        ensureStat(body);
        const k = statKeyFor(body);
        if (k) liveKeys.add(k);
    }
    const hereKeys = new Set(liveKeys);
    try { for (const c of connectedClients()) if (c && c.id) hereKeys.add("s:" + c.id); } catch { /* */ }
    const rows = [...raidStats.values()].map(s => ({
        id: s.id,
        name: s.name || "Unnamed",
        kills: s.kills | 0,
        gems: s.banked | 0,
        holds: s.holds | 0,
        carried: s.carried | 0,
        score: scoreOf(s),
        alive: liveKeys.has(s.key),
        here: hereKeys.has(s.key) ? 1 : 0,
        streak: s.streak | 0,
        boss: s.bossKills | 0,
        bot: s.isBot ? 1 : 0,
        place: 0,
    }));
    rows.sort((a, b) => (b.score - a.score) || (b.gems - a.gems) || (b.kills - a.kills));
    rows.forEach((r, i) => { r.place = i + 1; });
    // Everyone in the game right now always makes the board, then the best of
    // the fallen. The old top-32-by-score cut dropped fresh spawns (score 0)
    // below a pile of dead high scorers, which is why the Alive tab showed
    // one or two names.
    const present = rows.filter(r => r.here);
    const rest = rows.filter(r => !r.here).slice(0, Math.max(10, 32 - present.length));
    return present.concat(rest).sort((a, b) => a.place - b.place);
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

// Streakers at 3+ kills are broadcast to every minimap: power has a cost.
function pingsSnapshot(bodyByKey) {
    const out = [];
    for (const [k, s] of raidStats) {
        if (!s.alive || (s.streak | 0) < STREAK_MARK_AT) continue;
        const b = bodyByKey.get(k);
        if (!b || b.isDead?.()) continue;
        out.push({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), name: s.name || "Someone", streak: s.streak | 0 });
    }
    return out;
}

function toast(text, ms = 4500) {
    toastText = text || "";
    toastUntil = now() + ms;
}

function setToastAndSay(text, ms) {
    toast(text, ms);
    try { global.gameManager.socketManager.broadcast(text); } catch { /* */ }
}

function pushFeed(entry) {
    entry.at = now();
    killFeed.push(entry);
    if (killFeed.length > 24) killFeed.splice(0, killFeed.length - 24);
}

// Kill callout: the big centre-screen line for the person who earned it.
function callout(body, kind, text, pts) {
    try {
        if (body && body.socket) body.socket.talk('KC', String(kind), String(text), (pts | 0));
    } catch { /* */ }
}

function fxAt(x, y, kind) {
    for (const client of connectedClients()) {
        try { client.talk('FX', Math.round(x), Math.round(y), String(kind)); } catch { /* */ }
    }
}

function compass(x, y) {
    const a = Math.atan2(y, x);
    const dirs = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
    const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return Math.hypot(x, y) < 500 ? "the centre" : "the " + dirs[i];
}

// ── quests ───────────────────────────────────────────────────────────────
function questOf(client) {
    if (!client) return null;
    if (!client.raidQuest) client.raidQuest = { idx: 0, prog: 0, doneAt: 0 };
    return client.raidQuest;
}

function questSnapshot(client, s) {
    const q = questOf(client);
    if (!q || q.idx >= QUESTS.length) return null;
    const def = QUESTS[q.idx];
    let prog = q.prog;
    if (def.id === "bank" || def.id === "bank2") prog = s ? (s.banked | 0) : 0;
    return { id: def.id, text: def.text, goal: def.goal, prog: Math.min(def.goal, prog | 0), reward: def.reward, idx: q.idx, total: QUESTS.length };
}

function questProgress(body, id, amount = 1) {
    const client = body && body.socket;
    if (!client) return;
    const q = questOf(client);
    if (q.idx >= QUESTS.length) return;
    const def = QUESTS[q.idx];
    const s = ensureStat(body);
    let prog;
    if (def.id === "bank" || def.id === "bank2") prog = s ? (s.banked | 0) : 0;
    else { if (def.id !== id) return; q.prog += amount; prog = q.prog; }
    if (prog < def.goal) return;
    // reward straight into the bank; the board counts it too
    try {
        const cur = (client.gemBanked || 0) | 0;
        gems.setBanked(body, cur + def.reward);
        if (s) s.banked = (s.banked || 0) + def.reward;
        gems.talkGems(body, 0);
    } catch { /* */ }
    callout(body, "quest", "Quest done: " + def.text, def.reward);
    q.idx++;
    q.prog = 0;
    q.doneAt = now();
    // bank quests can already be satisfied by the same deposit
    if (q.idx < QUESTS.length) {
        const nd = QUESTS[q.idx];
        if ((nd.id === "bank" || nd.id === "bank2") && s && (s.banked | 0) >= nd.goal) questProgress(body, nd.id, 0);
    }
}

// ── broadcast ─────────────────────────────────────────────────────────────
function oreRocksForScan() {
    const tg = global.gameManager.terrainGrid;
    const out = [];
    if (!tg || !tg.rocks) return out;
    for (const rock of tg.rocks.values()) {
        if (!rock || !rock.alive || (rock.ore | 0) < 3) continue;
        out.push({ x: Math.round(rock.worldCx || rock.wx), y: Math.round(rock.worldCy || rock.wy), o: rock.ore | 0 });
    }
    return out;
}

function broadcast(extra = {}) {
    const t = now();
    const st = storm.snapshot(t);
    const fighters = combatants();
    const alive = fighters.length;
    const board = boardSnapshot();
    const raidLeft = Math.max(0, Math.ceil((raidEndsAt - t) / 1000));
    // last 90s: chests may land inside the storm too, so they stop piling
    // up in the shrinking centre
    global.royaleFinal90 = raidLeft > 0 && raidLeft <= 90;
    const objectives = objectivesSnapshot(t);
    const lock = stormLocked() ? 1 : 0;
    let lockLeft = 0;
    try { lockLeft = storm.lockLeftSec(t); } catch { /* */ }
    const bodyByKey = new Map();
    try {
        for (const b of fighters) {
            if (!b || b.isDead?.()) continue;
            const k = statKeyFor(b);
            if (k && !bodyByKey.has(k)) bodyByKey.set(k, b);
        }
    } catch { /* */ }
    const pings = pingsSnapshot(bodyByKey);
    const bossSnap = bosses.snapshot();
    const chestSnap = chests.snapshot();
    const bloomSnap = blooms.snapshot();
    const eventSnap = raidEvents.snapshot();
    const modSnap = raidMods.snapshot();
    const humanCount = humans().length;
    const liveToast = extra.toast || (t < toastUntil ? toastText : "");
    let scanRocks = null;
    const sharedStr = JSON.stringify({
        phase: 'live', left: raidLeft, alive, fill: FILL_CAP, humans: humanCount, winner: null, storm: st, toast: liveToast,
        feed: killFeed.slice(-8), board, lock, lockLeft, matchId: raidId, raidId, raidLeft, raidMs: RAID_MS,
        occupyMs: OCCUPY_MS, lockoutMs: LOCKOUT_MS, objectives, bloom: bloomSnap, chest: null, chests: chestSnap,
        boss: bossSnap, event: eventSnap, mod: modSnap, pings, results: raidResults, ...extra,
    });
    for (const client of connectedClients()) {
        const key = client.id ? "s:" + client.id : null;
        const mine = key ? raidStats.get(key) : null;
        const myRow = mine ? board.find(r => r.id === mine.id) : null;
        const revenge = null;   // revenge marking retired (Sep 2026)
        const body = client.player && client.player.body;
        const bodyLive = body && !body.isDead?.();
        let scan = null;
        if (bodyLive && shop.hasGear(body, "scanner")) {
            if (!scanRocks) scanRocks = oreRocksForScan();
            scan = scanRocks.filter(r => (r.x - body.x) ** 2 + (r.y - body.y) ** 2 <= 1500 * 1500).slice(0, 24);
        }
        const you = mine ? {
                score: scoreOf(mine),
                place: myRow ? (myRow.place | 0) : 0,
                banked: mine.banked | 0,
                kills: mine.kills | 0,
                holds: mine.holds | 0,
                streak: mine.streak | 0,
                bossKills: mine.bossKills | 0,
                revenge,
                carried: bodyLive ? Math.max(0, (body.carriedGems || 0) | 0) : (mine.carried | 0),
                quest: questSnapshot(client, mine),
                drill: shop.stateOf(client).drill | 0,
                scan,
                overdrive: bodyLive && body.overdriveUntil > t ? Math.ceil((body.overdriveUntil - t) / 1000) : 0,
                anchor: bodyLive && body.stormAnchorUntil > t ? Math.ceil((body.stormAnchorUntil - t) / 1000) : 0,
            } : null;
        // shared part stringified once per broadcast; only the per-client tail differs
        const payload = sharedStr.slice(0, -1) + ',"youPlace":' + (myRow ? (myRow.place | 0) : 0) +
            ',"youScore":' + (mine ? scoreOf(mine) : 0) + ',"youPB":' + ((client.raidPB || 0) | 0) +
            ',"you":' + JSON.stringify(you) + '}';
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
    const margin = 420;   // well inside the storm edge: a fresh spawn never lands in it
    const safeR = Math.max(80, (st.r || 0) - margin);
    for (const [k, until] of pitReservations) {
        if (until <= t) pitReservations.delete(k);
    }
    const tgS = global.gameManager.terrainGrid;
    // a pit the wall has grown back over is rock now, not a spawn point
    const open = (h) => !(tgS && tgS.pointInRock && tgS.pointInRock(h.x, h.y));
    let cands = holes.filter(h => Math.hypot(h.x - st.cx, h.y - st.cy) < safeR && open(h));
    if (!cands.length) {
        return openGroundNear(tgS, st.cx || 0, st.cy || 0);
    }
    // A reservation is a hard no for PIT_RESERVE_MS, by radius: nobody drops
    // into a gap somebody landed in moments ago, even if they already left.
    const live = [];
    for (const [k, r] of pitReservations) { if (r.until > t) live.push(r); else pitReservations.delete(k); }
    const reservedBy = (h) => live.find(r => (h.x - r.x) ** 2 + (h.y - r.y) ** 2 < PIT_RESERVE_R * PIT_RESERVE_R);
    const free = cands.filter(h => !reservedBy(h));
    if (free.length) cands = free;
    else cands = [cands.slice().sort((a, b) => reservedBy(a).until - reservedBy(b).until)[0]];
    const boss = bosses.current();
    const nearestBody = (h) => {
        let m = Infinity;
        for (const b of bodies) {
            const dx = h.x - b.x, dy = h.y - b.y;
            const d = dx * dx + dy * dy;
            if (d < m) m = d;
        }
        for (const r of live) {
            const d = (h.x - r.x) ** 2 + (h.y - r.y) ** 2;
            if (d < m) m = d;
        }
        if (boss) {
            const d = (h.x - boss.x) ** 2 + (h.y - boss.y) ** 2;
            if (d < m) m = d;
        }
        return Math.sqrt(m);
    };
    const scored = cands.map(h => ({ h, m: nearestBody(h) })).sort((a, b) => b.m - a.m);
    // the farthest gap wins; only near-ties (within 5%) are shuffled
    const best = scored[0].m;
    const top = scored.filter(s => s.m >= best * 0.95);
    const pick = top[(Math.random() * top.length) | 0].h;
    pitReservations.set(Math.round(pick.x) + ":" + Math.round(pick.y), { x: pick.x, y: pick.y, until: t + PIT_RESERVE_MS });
    return { x: pick.x, y: pick.y };
}

function giveStarterKit(body, isRespawn) {
    if (!body) return;
    try { gems.initSatchel(body); } catch { /* */ }
    const bonus = body.socket ? ((body.socket.raidBonus || 0) | 0) : 0;
    if (body.socket) body.socket.raidBonus = 0;
    const starter = raidMods.num('starterGems', STARTER_GEMS);
    const grant = (isRespawn ? 0 : starter) + bonus;
    body.carriedGems = Math.max(body.carriedGems | 0, grant);
    try { gems.updateSatchel(body); gems.talkGems(body, grant); } catch { /* */ }
    // twist grants: what everyone starts this cycle with
    try { grantTwist(body); } catch { /* */ }
    if (isRespawn && !shop.keepsDrillOnRespawn(body)) body.weakDrillUntil = now() + WEAK_DRILL_MS;
    else body.weakDrillUntil = 0;
    try {
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

// New raid, clean build: every point back in hand, so a twist's bonus points
// never leak across raids and the whole lobby rebuilds on equal footing.
function respecForNewRaid(body) {
    if (!body || body.isDead?.() || !body.skill) return;
    try {
        let total = 0;
        for (let lv = 1; lv <= (Config.level_cap_cheat || 45); lv++) total += Config.defineLevelSkillPoints(lv) | 0;
        body.skill.set(Array(11).fill(0));
        body.skill.points = total;
        body._modSkillGiven = false;
        if (body.isBot && global.gameManager.gameHandler) {
            try { global.gameManager.gameHandler.configureBotStats(body); } catch { /* */ }
        }
        body.refreshBodyAttributes();
        body.syncSkillsToGuns();
    } catch { /* */ }
}

function freshRaidBody(body) {
    if (!body || body.isDead?.()) return;
    killMinions(body);
    setLobby(body, false);
    setFrozen(body, false);
    body.invuln = true;
    body.spawnGraceUntil = now() + SPAWN_GRACE_MS;
    body.passive = false;
    body.royaleAlive = true;
    body.deathCause = "";
    const extra = raidMods.num('extraSkill', 0);
    if (extra > 0 && !body._modSkillGiven) {
        body._modSkillGiven = true;
        try { body.skill.points += extra; } catch { /* */ }
    }
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
    try { bot.refreshBodyAttributes(); } catch { /* */ }
    ensureStat(bot);
}

let idleSince = 0;
function fillBots() {
    const t = now();
    // an empty server does not need a populated raid
    if (!connectedClients().length) {
        if (!idleSince) idleSince = t;
        else if (t - idleSince > 45_000) {
            const bots = (global.gameManager.gameHandler?.bots || []).slice();
            for (const b of bots) { try { b.invuln = false; b.kill(); } catch { /* */ } }
            idleSince = t;
        }
        return;
    }
    idleSince = 0;
    if (t - lastFillAt < 400) return;
    if (stormLocked() || raidEnding) return;
    if (combatants().length >= FILL_CAP) return;
    lastFillAt = t;
    spawnRaidBot();
}

function onBanked(body, amount) {
    if (!body || !(amount > 0)) return;
    const s = ensureStat(body);
    if (s) s.banked = (s.banked || 0) + amount;
    if (body.socket) questProgress(body, "bank", 0);
}

function onCapture(body, site) {
    if (!body || !site) return;
    const s = ensureStat(body);
    if (s) s.holds = (s.holds | 0) + 1;
}

// Living killer for credit; `any` also returns a killer who died in the same
// trade so the feed can still name them.
function killerOf(body, any = false) {
    for (const k of (body && body.finalKillers) || []) {
        if (!k || k === body) continue;
        let root = k, hops = 0;
        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
        if (!root || root === body) continue;
        // bosses count as killers too, so turret kills read as the boss and not "Someone"
        if ((root.isPlayer || root.isBot || root.isRoyaleBoss) && (any || !root.isDead?.())) return root;
    }
    return null;
}

function onCombatantDead(body) {
    if (!Config.dig_royale || !body) return;
    if (body.royaleAlive === false) return;
    body.royaleAlive = false;
    const key = statKeyFor(body);
    const s = key ? (raidStats.get(key) || ensureStat(body)) : null;
    const carriedAtDeath = body.socket && body.socket.gemDeathCarried !== undefined
        ? (body.socket.gemDeathCarried | 0) : (s ? (s.carried | 0) : 0);
    const victimStreak = s ? (s.streak | 0) : 0;
    if (s) { s.alive = false; s.carried = 0; s.streak = 0; }
    const raidEndDeath = body.deathCause === "raidend";
    const envKill = raidEndDeath || body.deathCause === "storm" || body.deathCause === "rock" || body.deathCause === "base";
    const stormKill = body.deathCause === "storm";
    const rockKill = body.deathCause === "rock";
    const killerBody = envKill ? null : killerOf(body);
    const killerAny = envKill ? null : (killerBody || killerOf(body, true));
    const bossKill = !!(killerAny && killerAny.isRoyaleBoss);
    const killerKey = killerBody && !bossKill ? statKeyFor(killerBody) : null;
    let avenged = false;
    let shutdown = 0;
    let streakNow = 0;
    let pts = 0;
    if (killerBody && killerKey && killerKey !== key) {
        const ks = ensureStat(killerBody);
        if (ks) {
            ks.kills = (ks.kills | 0) + 1;
            pts += killScore();
            // streak: escalating bonus past the mark, shutdown bounty for ending one
            ks.streak = (ks.streak | 0) + 1;
            streakNow = ks.streak;
            if (ks.streak > ks.bestStreak) ks.bestStreak = ks.streak;
            if (ks.streak > STREAK_MARK_AT) {
                const sb = STREAK_BONUS_PER * (ks.streak - STREAK_MARK_AT);
                ks.extra = (ks.extra | 0) + sb;
                pts += sb;
            }
            if (victimStreak >= STREAK_MARK_AT) {
                shutdown = SHUTDOWN_PER_STREAK * victimStreak;
                ks.extra = (ks.extra | 0) + shutdown;
                pts += shutdown;
            }
            const mark = shop.killBonus(killerBody);
            if (mark) { ks.extra = (ks.extra | 0) + mark; pts += mark; }
        }
        if (killerBody.socket) {
            questProgress(killerBody, "kill", 1);
            let line = avenged ? "REVENGE" : shutdown ? "SHUTDOWN" : "ELIMINATED";
            line += ": " + (body.name || "Unnamed");
            if (carriedAtDeath >= 300) line += "  (" + carriedAtDeath + " gems dropped)";
            callout(killerBody, avenged ? "revenge" : shutdown ? "shutdown" : "kill", line, pts);
            if (streakNow === STREAK_MARK_AT) {
                try { killerBody.socket.talk('KC', "streak", streakNow + " kill streak. You're marked on everyone's map", 0); } catch { /* */ }
            }
        }
    }
    if (!raidEndDeath) pushFeed({
        name: body.name || "Unnamed",
        by: envKill ? "" : (killerAny ? (killerAny.name || "Unnamed") : ""),
        verb: avenged ? "avenged" : stormKill ? "lost" : rockKill ? "crushed" : bossKill ? "was devoured by" : KILL_VERBS[(Math.random() * KILL_VERBS.length) | 0],
        storm: stormKill ? 1 : 0,
        rock: rockKill ? 1 : 0,
        revenge: avenged ? 1 : 0,
        boss: bossKill ? 1 : 0,
        loot: carriedAtDeath >= 300 ? carriedAtDeath : 0,
        streak: streakNow >= STREAK_MARK_AT ? streakNow : 0,
        shutdown: shutdown ? victimStreak : 0,
        pts,
        place: 0,
    });
    if (body.socket) {
        const dl = shop.onDeath(body);
        body.socket.raidDeathStreak = victimStreak;
        body.socket.raidDeathDrillLost = dl && dl.drillLost ? 1 : 0;
        body.socket.royaleRespawnAt = now() + (raidEndDeath ? RAID_END_WAIT_MS : shop.respawnMs(body));
        body.socket.royaleNeedClick = false;
        body.socket.status.readyToSpawn = true;
    }
}

// ── bosses / chests / blooms / events callbacks ───────────────────────────
function onBossSpawned(o, kind, id) {
    pushFeed({ boss: 1, spawn: 1, name: kind.name, c: kind.color, x: Math.round(o.x), y: Math.round(o.y) });
    setToastAndSay(kind.name + " has surfaced in " + compass(o.x, o.y) + ". " + kind.gems + " gems to whoever ends it.", 6000);
    fxAt(o.x, o.y, "boss");
}

function onBossDead(o, kind, killer, burrowed) {
    if (burrowed) {
        pushFeed({ boss: 1, gone: 1, name: kind.name, c: kind.color });
        setToastAndSay("The " + kind.name + " burrowed back into the wall.", 4000);
        return;
    }
    let by = "";
    if (killer) {
        const ks = ensureStat(killer);
        if (ks) {
            ks.bossKills = (ks.bossKills | 0) + 1;
            ks.extra = (ks.extra | 0) + kind.score;
        }
        by = killer.name || "Unnamed";
        callout(killer, "boss", "BOSS DOWN: " + kind.name, kind.score);
    }
    // everyone else gets the banner too (no points on theirs)
    for (const client of connectedClients()) {
        if (killer && client.player && client.player.body === killer) continue;
        try { client.talk('KC', 'boss', "BOSS DOWN: " + kind.name + (by ? "  ·  " + by : ""), 0); } catch { /* */ }
    }
    pushFeed({ boss: 1, slain: 1, name: kind.name, by, c: kind.color, pts: kind.score });
    setToastAndSay((by || "The wall") + " killed the " + kind.name + ". Gems everywhere. Go get them.", 6000);
    fxAt(o.x, o.y, "bossdead");
}

function onChestOpened(body, chest, itemMsg) {
    if (!body) return;
    const s = ensureStat(body);
    if (s) s.chests = (s.chests | 0) + 1;
    if (body.socket) {
        questProgress(body, "chest", 1);
        const text = (chest.chestRare ? "Epic chest cracked open" : "Copper chest cracked open") + (itemMsg ? ". " + itemMsg : "");
        callout(body, "chest", text, chest.chestGems | 0);
    }
    if (chest.chestRare) pushFeed({ chest: 1, name: body.name || "Unnamed", rare: 1 });
    fxAt(chest.x, chest.y, chest.chestRare ? "chestrare" : "chest");
}

function onBloom(b) {
    pushFeed({ bloom: 1, name: compass(b.x, b.y) });
    setToastAndSay("Ore bloom in " + compass(b.x, b.y) + ". Rich veins for 100 seconds.", 6000);
    fxAt(b.x, b.y, "bloom");
}

function onEvent(ev) {
    if (ev.kind === 'meteor') {
        pushFeed({ event: 1, kind: 'meteor', name: ev.where });
        setToastAndSay("Meteor shower incoming over " + ev.where + ". Ore falls with it.", 6000);
    } else {
        pushFeed({ event: 1, kind: 'rain', name: ev.where });
        setToastAndSay("Gem rain over the safe zone. Twenty-five seconds.", 6000);
    }
}

function onShopBuy(body, item) {
    if (body && body.socket) questProgress(body, "shop", 1);
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

function padEdge(site, body, margin = 0) {
    return site.r + (body.realSize || 60) + margin;
}

// Firm hull-to-rim exclusion (padGeom.keepOut). Returns true once clear.
function pushOut(body, site, margin, tag, hard = false) {
    const clear = padGeom.keepOut(body, site, margin, tag, hard);
    if (clear) { if (body._padPush && body._padPush.tag === tag) body._padPush = null; }
    else if (!body._padPush || body._padPush.tag !== tag) body._padPush = { tag };
    return clear;
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
            try { body.sendMessage("You're back at your base. You can stay 10 seconds."); } catch { /* */ }
        }
    }
    if (!homeSpawn) {
        const hole = safeSpawnSpot();
        moveTo(body, hole.x + (Math.random() - 0.5) * 30, hole.y + (Math.random() - 0.5) * 30);
    }
    // never leave a fresh body inside rock: the terrain loop would crush or
    // relocate it a moment later, which read as a second teleport on spawn
    try {
        const tgJ = global.gameManager.terrainGrid;
        if (tgJ && tgJ.pointInRock && tgJ.pointInRock(body.x, body.y)) {
            const o = openGroundNear(tgJ, body.x, body.y);
            moveTo(body, o.x, o.y);
        }
    } catch { /* */ }
    freshRaidBody(body);
    // a resumed player already had their starter kit: no second one
    const resuming = !!(body.socket && body.socket._resume);
    if (!resuming) giveStarterKit(body, isRespawn);
    try { shop.applyPassives(body); } catch { /* */ }
    ensureStat(body);
    if (body.socket) {
        body.socket.royaleEliminated = false;
        body.socket.royalePlace = 0;
        body.socket.royaleNeedClick = false;
        body.socket.lastRaidDeathAt = 0;
        body.socket.freeCam = false;
        questOf(body.socket);
        if (!isRespawn && !resuming) {
            try { chests.ensureNearSpawn(body); } catch { /* */ }
            const mod = raidMods.get();
            try {
                body.sendMessage("You're shielded for 4 seconds, and after that until you move or shoot.");
                body.sendMessage("This raid's override is " + (mod ? mod.name + ": " + mod.desc : "nothing, for once."));
            } catch { /* */ }
        }
        try { shop.talkState(body.socket); } catch { /* */ }
        const rs = body.socket._resume;
        if (rs) { body.socket._resume = null; applyResume(body, rs); }
    }
}

// ── reconnect / resume ────────────────────────────────────────────────────
// A dropped connection (proxy reload, wifi blip, a refresh) used to cost the
// whole raid: bank, shop, score and tank all lived on the old socket. The
// client now reconnects on its own and sends the same per-tab token, and for
// two minutes the new socket inherits everything the old one had. Carried
// gems only come back if nothing had hit you for 8 s, so pulling the plug is
// not a way out of a losing fight.
const RESUME_MS = 120_000;
const RESUME_SAFE_MS = 8000;
const resumeStore = new Map();
function saveResume(socket, body) {
    const token = socket && socket.resumeToken;
    if (!token) return;
    const t = now();
    for (const [k, v] of resumeStore) if (t - v.at > RESUME_MS) resumeStore.delete(k);
    // a dead player has no body but still has a bank, a shop and a score
    const alive = !!body && !body.isDead?.() && body.royaleAlive !== false && !body.royaleLobby;
    const hitAgo = body ? Math.min(t - (body._lastDamageAt || 0), Date.now() - (body.hitAt || 0)) : 0;
    const snap = {
        at: t, raidId, statKey: body ? statKeyFor(body) : "s:" + socket.id, alive,
        sock: {
            gemBanked: socket.gemBanked || 0, shop: socket.shop || null, raidQuest: socket.raidQuest || null,
            raidBonus: socket.raidBonus || 0, raidPB: socket.raidPB || 0, _milestoneIdx: socket._milestoneIdx || 0,
            raidDeathStreak: socket.raidDeathStreak || 0, royaleRespawnAt: socket.royaleRespawnAt || 0,
            lastRaidDeathAt: socket.lastRaidDeathAt || 0,
        },
        carried: 0,
    };
    if (alive) {
        snap.x = body.x; snap.y = body.y;
        snap.defs = (body.defs || []).slice();
        snap.skillRaw = body.skill ? body.skill.raw.slice() : null;
        snap.points = body.skill ? body.skill.points : 0;
        snap.modSkill = !!body._modSkillGiven;
        snap.hp = body.health && body.health.max ? body.health.amount / body.health.max : 1;
        if (hitAgo > RESUME_SAFE_MS) {
            snap.carried = (body.carriedGems | 0);
            body.carriedGems = 0;     // kept for the resume, so it must not also drop
        }
    }
    resumeStore.set(token, snap);
    if (process.env.RESUME_DEBUG) console.log('[RESUME] saved', token.slice(0, 6), 'alive', snap.alive, 'banked', snap.sock.gemBanked, 'carried', snap.carried, 'raid', raidId);
}
// Called when a new socket presents its token (before it spawns).
function claimResume(socket, token) {
    if (!Config.dig_royale || !socket || !token) return false;
    const snap = resumeStore.get(token);
    if (process.env.RESUME_DEBUG) console.log('[RESUME] claim', token.slice(0, 6), 'found', !!snap, snap ? ('age ' + (now() - snap.at) + ' raid ' + snap.raidId + '/' + raidId) : '');
    if (!snap) return false;
    resumeStore.delete(token);
    if (now() - snap.at > RESUME_MS || snap.raidId !== raidId) return false;
    Object.assign(socket, snap.sock);
    const newKey = "s:" + socket.id;
    const old = snap.statKey ? raidStats.get(snap.statKey) : null;
    if (old && snap.statKey !== newKey) { raidStats.delete(snap.statKey); old.key = newKey; raidStats.set(newKey, old); }
    socket._resume = snap;
    return true;
}
function applyResume(body, snap) {
    const socket = body.socket;
    try {
        if (snap.alive && snap.defs && snap.defs.length) {
            body.define(snap.defs.length === 1 ? snap.defs[0] : snap.defs);
            if (snap.skillRaw) { body.skill.set(snap.skillRaw); body.skill.points = snap.points | 0; }
            body._modSkillGiven = snap.modSkill || body._modSkillGiven;
            body.refreshBodyAttributes();
            if (body.syncSkillsToGuns) body.syncSkillsToGuns();
            // back where you were, unless that spot is now rock or storm
            let safe = true;
            try { if (storm.inStorm(snap.x, snap.y)) safe = false; } catch { /* */ }
            try { const tg = global.gameManager.terrainGrid; if (tg && tg.pointInRock && tg.pointInRock(snap.x, snap.y)) safe = false; } catch { /* */ }
            if (safe) moveTo(body, snap.x, snap.y);
            body.health.amount = body.health.max * Math.max(0.25, Math.min(1, snap.hp || 1));
            body.carriedGems = snap.carried | 0;
            try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
            const st = shop.stateOf(socket);
            if (st && st.arm) { try { shop.attachSidearm(body, st.arm); } catch { /* */ } }
        }
        body.bankedGems = socket.gemBanked || 0;
        try { shop.applyPassives(body); shop.talkState(socket); gems.talkGems(body, 0); } catch { /* */ }
        ensureStat(body);
        try { body.sendMessage("Reconnected. Your raid picked up where you left off."); } catch { /* */ }
    } catch (e) { console.error('[RAID] resume failed', e && e.message); }
}

function markHumanDeath(socket) {
    if (socket) socket.lastRaidDeathAt = now();
}

function disconnectCleanup(socket, body) {
    if (!Config.dig_royale) return;
    try { saveResume(socket, body); } catch (e) { console.error('[RAID] resume save failed', e && e.message); }
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
            body._baseExpel = null;
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
    const parkOutside = (site, body, n) => {
        padGeom.keepOut(body, site, 3, "park:" + site.id, true);
        body._padPush = null;
    };
    for (const site of list) {
        site.occupyLeft = 0;
        if (!site.kind) site.kind = 'outpost';
        const ownerId = site.ownerId;
        for (const body of bodies) {
            const dx = body.x - site.x, dy = body.y - site.y;
            const d = Math.hypot(dx, dy);
            const key = site.id + ':' + body.id;
            const lockedUntil = lockout.get(key) || 0;
            const bodyR = body.realSize || 60;
            const inside = padGeom.insidePad(site, body.x, body.y, 0);
            const touching = padGeom.insidePad(site, body.x, body.y, bodyR);
            if (body._baseExpel === site) {
                // being shoved off: keep shoving until the hull is clear, then
                // the lockout starts and the rim becomes a wall
                if (pushOut(body, site, 6, "camp:" + site.id, 'expel')) {
                    body._baseExpel = null;
                    occupy.delete(site.id);
                    lockout.set(key, t + LOCKOUT_MS);
                    body._padReentryUntil = t + 5000;
                    body._padReentryPad = site;
                    if (body.socket) body.socket.talk('RYO', site.id, 0, Math.ceil(LOCKOUT_MS / 1000));
                }
                continue;
            }
            if (touching && body._padReentryUntil && t < body._padReentryUntil &&
                (!body._padReentryPad || body._padReentryPad === site)) {
                if (body.outpostDeposit) {
                    body.outpostDeposit = null;
                    try { body.socket && body.socket.talk('VP', 0, 0); } catch { /* */ }
                }
                occupy.delete(site.id);
                const n = (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
                parkOutside(site, body, n);
                continue;
            }
            if (ownerId && body.id !== ownerId && touching) {
                if (body.outpostDeposit) {
                    body.outpostDeposit = null;
                    try { body.socket && body.socket.talk('VP', 0, 0); } catch { /* */ }
                }
                const n = (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
                parkOutside(site, body, n);
                site._contestedUntil = t + 8000;
                continue;
            }
            if (body._padPush && body._padPush.tag === "bounce:" + site.id && !touching) {
                body._padPush = null;
            }
            if (ownerId === body.id && lockedUntil > t && touching) {
                const n = (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
                parkOutside(site, body, n);
                if (body.socket) body.socket.talk('RYO', site.id, 0, Math.ceil((lockedUntil - t) / 1000));
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
                    body._baseExpel = site;
                    pushOut(body, site, 6, "camp:" + site.id, 'expel');
                    site.occupyLeft = 0;
                    try { body.sendMessage("Time's up. Off the base, and no coming back for " + Math.round(LOCKOUT_MS / 1000) + " seconds."); } catch { /* */ }
                }
            } else if (ownerId === body.id && !inside) {
                const rec = occupy.get(site.id);
                if (rec && rec.ownerId === body.id) {
                    if (!rec.leftAt) {
                        rec.leftAt = t;
                        if (body.socket) {
                            try { body.socket.talk('RYO', site.id, 0, 0); } catch { /* */ }
                        }
                    }
                    else if (t - rec.leftAt > 5000) occupy.delete(site.id);
                }
                if (lockedUntil > t && body.socket)
                    body.socket.talk('RYO', site.id, 0, Math.ceil((lockedUntil - t) / 1000));
            }
        }
    }
}

// Hull vs a base pad, called from the physics collide pass (index.js) so the
// wall moves in step with the tank; tickOutpostRules is the backstop. The
// owner walks on. Anyone else, and an owner who is locked out or being shoved
// off, stops at the rim. Returns true when it acted.
function baseWall(body, site) {
    if (!body || !site || body.isGhost || body.isDead?.()) return false;
    const t = Date.now();
    if (body._baseExpel === site) {
        pushOut(body, site, 6, "camp:" + site.id, 'expel');
        return true;
    }
    const key = site.id + ':' + body.id;
    const denied = site.ownerId !== body.id ||
        (lockout.get(key) || 0) > t ||
        (body._padReentryUntil && t < body._padReentryUntil &&
         (!body._padReentryPad || body._padReentryPad === site));
    if (!denied) return false;
    padGeom.keepOut(body, site, 3, "park:" + site.id, true);
    return true;
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
            toast("A vault is about to get stuck in the storm! Make sure to bank your gems.", 5000);
            return;
        }
    }
}

function wipeWall() {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return;
    const t = now();
    let queued = 0;
    tg._noRegrowZones = [];          // struts from the last raid are gone too
    for (const rock of tg.rocks.values()) {
        if (rock.alive || rock.growing) continue;
        if (!rock.diedAt) continue;
        if (rock.canyon) continue;
        rock.noRegrowUntil = 0;
        try { tg.startRegrow(rock, t + (queued % 20) * 50); } catch { /* */ }
        queued++;
        if (queued > 900) break;
    }
}

// Raid twists that touch the world itself: rock toughness, copper rush,
// extra emeralds, and tank sizes/speeds.
function applyModsToWorld(prev, next) {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return;
    const { ORE, ORE_HP } = require('../../terrain/terrainGrid.js');
    const prevHp = (prev && prev.rockHpMult) || 1, nextHp = (next && next.rockHpMult) || 1;
    if (prevHp !== nextHp) {
        for (const rock of tg.rocks.values()) {
            if (!rock || (!rock.alive && !rock.growing)) continue;
            const frac = rock.maxHealth > 0 ? Math.min(1, rock.health / rock.maxHealth) : 1;
            rock.maxHealth = rock.maxHealth * nextHp / prevHp;
            rock.health = Math.max(1, rock.maxHealth * frac);
        }
    }
    const copperNow = !!(next && next.ore === 'copper');
    const copperBefore = !!(prev && prev.ore === 'copper');
    if (copperNow !== copperBefore) {
        const rl = require('../../terrain/royaleLayout.js');
        for (const rock of tg.rocks.values()) {
            if (!rock || !rock.alive || rock.canyon || rock.ore === ORE.EMERALD) continue;
            let ore = rock.ore;
            if (copperNow) { if (!ore) continue; ore = ORE.COPPER; }
            else { try { ore = rl.radialOre(rock, tg.circleRadius, (tg.oreSalt || 7) + rock.gen * 131); } catch { continue; } }
            if (ore === rock.ore) continue;
            const frac = rock.maxHealth > 0 ? Math.min(1, rock.health / rock.maxHealth) : 1;
            rock.ore = ore;
            rock.maxHealth = (tg.baseRockHealth * 1.3) * (ORE_HP[ore] || 1) * nextHp;
            rock.health = Math.max(1, rock.maxHealth * frac);
            try { rock.deposits = ore ? tg._buildDeposits(rock) : null; } catch { rock.deposits = null; }
            tg.rockEvents.push({ k: rock.k, h: rock.health / rock.maxHealth, d: 0, ore, bl: 1 });
        }
    }
    const extraEm = (next && next.extraEmeralds) | 0;
    for (let i = 0; i < extraEm; i++) { try { tg._plantEmerald(); } catch { /* */ } }
    for (const body of combatants()) { try { body.refreshBodyAttributes(); } catch { /* */ } }
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
    const prevMod = lastMods;
    const mod = raidMods.roll();
    lastMods = mod;
    storm.start();
    try { twistCycleSeen = storm.snapshot(now()).c | 0; } catch { /* */ }
    try { applyModsToWorld(prevMod, mod); } catch (e) { console.error('[RAID] mod apply failed', e && e.message); }
    try { bosses.resetRaid(); } catch { /* */ }
    try { blooms.reset(); } catch { /* */ }
    try { raidEvents.reset(); } catch { /* */ }
    try { chests.clearAll(); } catch { /* */ }
    for (const client of connectedClients()) {
        client.raidQuest = { idx: 0, prog: 0, doneAt: 0 };
    }
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
                body._modSkillGiven = false;
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
            respecForNewRaid(body);
            freshRaidBody(body);
            giveStarterKit(body, false);
            try { shop.applyPassives(body); } catch { /* */ }
            ensureStat(body);
        }
        for (const client of connectedClients()) {
            if (client.player && client.player.body && !client.player.body.isDead?.()) continue;
            client.royaleNeedClick = false;
            client.status.readyToSpawn = true;
        }
    }
    const twist = mod ? (" Twist: " + mod.name + ".") : "";
    broadcast({ toast: (first ? "The raid is on. Mine, bank, fight. The storm is your clock." : "New raid. The wall is growing back.") + twist });
    toast((first ? "The raid is on." : "New raid.") + twist, 7000);
}

function endRaid() {
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
    broadcast({ toast: "Raid over. Everyone goes down. The next raid starts in 15 seconds." });
    raidEnding = true;
    const winner = top[0] ? top[0].name || "Unnamed" : "";
    for (const client of connectedClients()) {
        try { client.talk('KC', 'raidend', 'RAID OVER', 0, winner ? ("#1 " + winner) : "Nobody scored"); } catch { /* */ }
    }
    setTimeout(() => {
        // everyone goes down at once; nothing drops, it is not a kill
        for (const body of combatants()) {
            try {
                body.carriedGems = 0;
                try { gems.updateSatchel(body); } catch { /* */ }
                body.invuln = false;
                body.godmode = false;
                body.padSafe = false;
                body.passive = false;
                body.spawnGraceUntil = 0;
                body.deathCause = "raidend";
                body.dontSendDeathMessage = true;
                body.health.amount = -1;
            } catch { /* */ }
        }
    }, RAID_END_BEAT_MS);
    setTimeout(() => {
        try {
            for (const client of connectedClients()) {
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
            // the shop is a per-raid ladder: everyone climbs again
            try { shop.resetAll(); } catch { /* */ }
        } catch { /* */ }
        raidEnding = false;
        startRaid(false);
    }, RAID_END_BEAT_MS + RAID_END_WAIT_MS);
}

// One storm cycle (shrink, hold, reset) is a "raid" to the players, so each
// cycle rolls a fresh override. Old twist grants are taken back, bodies are
// re-derived for the new multipliers, new grants go out, and everyone gets
// the banner.
let twistCycleSeen = -1;
function twistCycleWatch(t) {
    let cyc = 0;
    try { cyc = storm.snapshot(t).c | 0; } catch { return; }
    if (cyc === twistCycleSeen) return;
    const first = twistCycleSeen === -1;
    twistCycleSeen = cyc;
    if (first) return;
    applyNewTwist();
}
function applyNewTwist(forceId) {
    // revoke what the previous twist handed out
    for (const client of connectedClients()) {
        try {
            const st = shop.stateOf(client);
            const body = client.player && client.player.body;
            if (!st) continue;
            if (st._twistArm) { if (body) shop.detachSidearm(body); st.arm = null; st.armUntil = 0; st._twistArm = null; }
            if (st._twistGear) { for (const gid of st._twistGear) if (st.gear[gid] === true) delete st.gear[gid]; st._twistGear = null; }
            if (body && !body.isDead?.()) shop.applyPassives(body);
        } catch { /* */ }
    }
    const mod = raidMods.roll(forceId);
    for (const b of combatants()) { try { b.refreshBodyAttributes(); } catch { /* */ } }
    for (const client of connectedClients()) {
        const body = client.player && client.player.body;
        if (body && !body.isDead?.()) { try { grantTwist(body); } catch { /* */ } }
    }
    if ((mod.extraSkill | 0) > 0) {
        for (const b of combatants()) {
            if (b.socket || b._modSkillGiven) continue;
            b._modSkillGiven = true;
            try { b.skill.points += mod.extraSkill | 0; } catch { /* */ }
        }
    }
    setToastAndSay("New override: " + mod.name + ". " + (mod.desc || ""), 7000);
}
function grantTwist(body) {
    const mod = raidMods.get() || {};
    if (!body || !body.socket) return;
    const st = shop.stateOf(body.socket);
    if (mod.freeArm) { shop.grantArm(body.socket, mod.freeArm, true); st._twistArm = mod.freeArm; }
    if (mod.freeGear) { for (const gid of mod.freeGear) st.gear[gid] = true; st._twistGear = mod.freeGear.slice(); shop.applyPassives(body); }
    if (mod.kitStart) for (const [kid, n] of Object.entries(mod.kitStart)) shop.grantKit(body.socket, kid, n);
    // Overclocked used to be applied only in freshRaidBody, i.e. on the next
    // spawn: a twist that started mid-raid showed the popup and gave nothing.
    if ((mod.extraSkill | 0) > 0 && !body._modSkillGiven) {
        body._modSkillGiven = true;
        try { body.skill.points += mod.extraSkill | 0; } catch { /* */ }
    }
}

function tick() {
    if (!Config.dig_royale) return;
    const t = now();
    if (!raidId) startRaid(true);
    twistCycleWatch(t);
    if (t >= raidEndsAt && !raidResults) {
        endRaid();
        return;
    }
    if (raidResults && t - raidResultsAt > RAID_END_BEAT_MS + RAID_END_WAIT_MS) raidResults = null;
    // everyone is down between raids: no storm, bosses, chests or bots, just
    // keep the HUD fed (results panel, countdown)
    if (raidEnding) {
        if (t - (tick._broadcastAt || 0) >= 500) { tick._broadcastAt = t; guard('broadcast', () => broadcast()); }
        return;
    }
    // Every stage is isolated: one bad stage must never take the raid
    // broadcast (and with it the whole HUD) down with it.
    guard('storm', () => { storm.ensureActive(); storm.tickDamage(t); });
    guard('outposts', () => tickOutpostRules(t));
    guard('vaults', () => tickVaultPinch(t));
    guard('bots', () => fillBots());
    const fighters = combatants();
    try { bosses.tick(t, fighters.length); } catch (e) { /* */ }
    try { blooms.tick(t); } catch (e) { /* */ }
    try { raidEvents.tick(t); } catch (e) { /* */ }
    try { chests.schedule(); } catch (e) { /* */ }
    for (const body of fighters) {
        const key = statKeyFor(body);
        const s = key ? raidStats.get(key) : null;
        if (s) { s.alive = true; s.lastSeen = t; }
    }
    for (const s of raidStats.values()) {
        if (t - s.lastSeen > 30000) s.alive = false;
    }
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
        guard('broadcast', () => broadcast());
    }
}

// Run one raid stage; log a failure at most once every 10s per stage.
const guardLogAt = new Map();
function guard(label, fn) {
    try { fn(); } catch (e) {
        const t = Date.now();
        if (t - (guardLogAt.get(label) || 0) > 10000) {
            guardLogAt.set(label, t);
            console.error('[RAID] ' + label + ' failed:', e && e.stack || e);
        }
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
    lobbyPos, tick, onBanked, onCapture, FILL_CAP, stormLocked, boardSnapshot, scoreOf, baseWall, claimResume,
    onBossSpawned, onBossDead, onChestOpened, onBloom, onEvent, onShopBuy, fxAt, callout, QUESTS,
    // ROYALE_DEBUG only (sockets.js DBG): force a twist, end the raid now
    debugTwist: (id) => applyNewTwist(id), debugEndRaid: () => { raidEndsAt = now(); },
};
