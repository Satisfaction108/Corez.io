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
const spawnReach = require('../../terrain/spawnReach.js');
// ranked lives + gemdust (accounts); every call below is guarded
const rankHooks = require('../../../accounts/game/rankHooks.js');
const dustHooks = require('../../../accounts/game/dustHooks.js');
const progressHooks = require('../../../accounts/game/progressHooks.js');   // daily quests + achievements
// duos (only does anything on the duo server: Config.royale_duos)
const duo = require('../../duo/duoRaid.js');

const RAID_MS = 2 * 60 * 60 * 1000;
// Raid size including humans: a solo player gets 5 bots, and each real
// player who joins takes a bot's place. The duo server holds one more, so a
// party of two still meets 5 bots (two of them a bot duo).
const FILL_CAP = 6;
const DUO_FILL_CAP = 7;
function fillCap() { return Config.royale_duos ? DUO_FILL_CAP : FILL_CAP; }
const OCCUPY_MS = 10_000;
const LOCKOUT_MS = 10_000;
const KILL_VERBS = ["killed", "slaughtered", "demolished", "wrecked", "ended", "cooked"];
const RESPAWN_MIN_MS = 15000;
const WEAK_DRILL_MS = 30_000;
const STARTER_GEMS = 75;
const SPAWN_GRACE_MS = 4000;   // spawn shield holds this long even if you move

// ── First minutes ─────────────────────────────────────────────────────────
// Every knob for the late-joiner / new-player experience: where a fresh
// spawn lands, how long bots leave it alone, how crowded the closing circle
// may get, and the "you joined late" note. (Tester churn, Sep 2026: joined in
// the final circle, spawned into five bots, died over and over, quit.)
const FIRST_MINUTES = {
    // Safe spawn: candidates are the drop pits plus random open ground inside
    // the safe zone; the one farthest from every threat wins.
    SPAWN_CLEAR: 1500,            // wanted room to the nearest bot/player at full storm
    SPAWN_CLEAR_STORM_FRAC: 0.8,  // ...capped at this share of the storm radius
    SPAWN_EDGE_MARGIN: 420,       // stay this far inside the storm edge
    SPAWN_EDGE_MARGIN_FRAC: 0.3,  // ...but at most this share of the radius (small final circle)
    SPAWN_STORM_AHEAD_S: 25,      // ...measured against where the edge will be this many seconds from now
    SPAWN_MAP_MARGIN: 220,        // and this far inside the map circle
    SPAWN_SAMPLES: 60,            // random points sampled in the zone each pick (plus pits and mined-out cells)
    SPAWN_CARVE_GAIN: 100,        // dig a pocket in solid rock only if that buys this much more room
    SPAWN_CARVE_R: 75,            // landing pocket radius
    SPAWN_PAD_CLEAR: 140,         // never on (or hugging) a vault / shop / base pad
    // Reachability (terrain/spawnReach.js has the rule and its own knobs):
    // a spawn must be able to get out, not land in a pocket ringed by ore,
    // emerald or regrowing rock, or in a mined-out cell about to close.
    SPAWN_REACH: process.env.SPAWN_REACH !== '0',   // SPAWN_REACH=0: old behaviour (for A/B)
    SPAWN_STORM_AHEAD_DIG_S: 60,  // a spot that is only escapable by digging must be inside where the edge will be this far ahead
    SPAWN_POCKET_HOLD_MS: 30_000, // a dug landing pocket and its exit tunnel do not regrow for this long
    SPAWN_CELL_HOLD_MS: 12_000,   // a mined-out cell picked as the spawn does not regrow for this long
    SPAWN_TUNNEL_MAX: 8,          // a landing pocket's exit tunnel is at most this many cells (else try another spot)
    // Storm rescue: a body in its first RESCUE_WINDOW_MS that the storm reaches
    // while boxed in (the way into the zone costs at least RESCUE_MIN_COST
    // fresh plain rocks) gets that tunnel cracked open, once per life. Never
    // through an emerald. Storm damage still applies; they have to walk.
    RESCUE_WINDOW_MS: 20_000,
    RESCUE_MIN_COST: 0.5,
    RESCUE_MAX_CELLS: 10,
    RESCUE_RETRY_MS: 2000,
    SPAWN_FIGHT_MS: 4000,         // a tank hit this recently is in a fight
    SPAWN_FIGHT_MULT: 0.55,       // a fight counts as this much closer (distance x mult)
    SPAWN_BOSS_MULT: 0.5,         // a boss counts as this much closer (distance x mult)
    SPAWN_BOT_HUMAN_MULT: 0.6,    // a bot dropping in keeps extra room from humans
    // Bot grace: bots neither target nor shoot a fresh spawn for this long,
    // unless that player damages a bot first (on top of the spawn shield).
    BOT_GRACE_MS: 15_000,
    BOT_GRACE_NEW_MS: 30_000,     // new players
    NEW_PLAYER_LIVES: 5,          // career lives (guest games / account lives) + this session's, under this = new
    NEW_TARGET_PENALTY: 350,      // bots rank a new player as if this much farther away
    NEW_MAX_HUNTERS: 1,           // bots that may aim at / chase one new player at once
    NEW_RESPAWN_MS: 8000,         // a new player's respawn wait (everyone else: shop.respawnMs, 15 s)
    // Closing-circle density: fighters allowed = (storm radius / DENSITY_R)^2,
    // bots fill what the humans leave. No refills past it, extras trimmed.
    DENSITY_R: 380,
    DENSITY_MIN_BOTS: 1,          // with a human in the raid, never fewer bots than this
    DENSITY_TRIM_MS: 2500,        // at most one extra bot removed this often
    DENSITY_TRIM_AWAY: 900,       // removed bots are this far from every human (off screen) or in the storm
    DENSITY_FORCE_MS: 15_000,     // extras that never get far enough: after this, the farthest idle one...
    DENSITY_FORCE_AWAY: 600,      // ...that is at least this far away goes
    // Storm spawn lock (storm.js): nobody (re)spawns in the last N ms of a cycle
    STORM_LOCK_MS: 20_000,
    // Late-join note: a callout on spawn when the raid or the storm cycle is nearly done
    LATE_RAID_SEC: 600,
    LATE_STORM_SEC: 100,          // storm cycle seconds left (end of the squeeze + the hold)
    LATE_NOTE_MS: 7000,
};
try { storm.setLockMs(FIRST_MINUTES.STORM_LOCK_MS); } catch { /* */ }
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
    s.team = body.team;
    // duos: the standings key (only real duo teams have one; see duoRaid.teamKeyOf)
    if (Config.royale_duos) s.teamKey = duo.teamKeyOf(body);
    // nameplate cosmetics for the board rows (bridge.applyIdentity)
    s.ns = body.nameStyleNid | 0;
    s.nc = body.customNameColor || null;
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

// The board order: score, then banked, then kills (stable, insertion order).
const boardCmp = (a, b) => (b.score - a.score) || (b.gems - a.gems) || (b.kills - a.kills);

// Every stat in board order, bots included: the raid placement bonus reads
// places from this. -> [{s, score, gems, kills}]
function boardOrder() {
    const list = [...raidStats.values()]
        .map(s => ({ s, score: scoreOf(s), gems: s.banked | 0, kills: s.kills | 0 }))
        .sort(boardCmp);
    if (!Config.royale_duos) return list;
    // Duos: a team places on its combined score and both partners take that
    // place (the raid placement bonus reads e.place / e.rows).
    const teams = new Map();
    for (const e of list) {
        const k = e.s.teamKey ? e.s.teamKey : 'k' + e.s.key;
        let t = teams.get(k);
        if (!t) teams.set(k, t = { score: 0, gems: 0, kills: 0, list: [] });
        t.score += e.score; t.gems += e.gems; t.kills += e.kills;
        t.list.push(e);
    }
    const order = [...teams.values()].sort(boardCmp);
    const out = [];
    order.forEach((t, i) => { for (const e of t.list) out.push(Object.assign(e, { place: i + 1, rows: order.length, teamScore: t.score })); });
    return out;
}

// Duos: team rows for the HUD (and the raid results). -> [{tm, names, ids, score, kills, alive, bot, place}]
function teamRows(board) {
    return duo.standings(board).map(t => ({
        tm: t.tm, names: t.rows.map(r => r.name || "Unnamed"), ids: t.rows.map(r => r.id),
        score: t.score, kills: t.kills, gems: t.gems, alive: t.alive ? 1 : 0, here: t.here ? 1 : 0,
        bot: t.rows.every(r => r.bot) ? 1 : 0, place: t.place,
    }));
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
        rk: s.rankCode | 0,
        ns: s.ns | 0,
        nc: s.nc || undefined,
        tm: Config.royale_duos && s.teamKey ? s.teamKey : undefined,
        place: 0,
    }));
    rows.sort(boardCmp);
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
    // between raids (RAID OVER -> next raid): seconds until the next one, so
    // a player joining in that window gets a real countdown
    const ending = raidEnding ? 1 : 0;
    const nextIn = raidEnding ? Math.max(0, Math.ceil((raidResultsAt + RAID_END_BEAT_MS + RAID_END_WAIT_MS - t) / 1000)) : 0;
    const bossSnap = bosses.snapshot();
    const chestSnap = chests.snapshot();
    const bloomSnap = blooms.snapshot();
    const eventSnap = raidEvents.snapshot();
    const modSnap = raidMods.snapshot();
    const humanCount = humans().length;
    const liveToast = extra.toast || (t < toastUntil ? toastText : "");
    let scanRocks = null;
    const duos = !!Config.royale_duos;
    const teamsAll = duos ? teamRows(board) : null;
    const teamPlace = new Map();
    if (teamsAll) for (const tr of teamsAll) if (tr.tm != null) teamPlace.set(tr.tm, tr.place);
    const sharedStr = JSON.stringify({
        duos: duos ? 1 : 0, teams: teamsAll ? teamsAll.slice(0, 12) : undefined,
        phase: 'live', left: raidLeft, alive, fill: fillCap(), humans: humanCount, winner: null, storm: st, toast: liveToast,
        feed: killFeed.slice(-8), board, lock, lockLeft, matchId: raidId, raidId, raidLeft, raidMs: RAID_MS,
        occupyMs: OCCUPY_MS, lockoutMs: LOCKOUT_MS, objectives, bloom: bloomSnap, chest: null, chests: chestSnap,
        boss: bossSnap, event: eventSnap, mod: modSnap, pings, results: raidResults, ending, nextIn, ...extra,
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
        let duoTail = '';
        if (duos) {
            const d = duo.hudFor(client, t) || {};
            const myTm = mine && mine.teamKey ? mine.teamKey : (bodyLive ? duo.teamKeyOf(body) : null);
            d.tm = myTm != null ? myTm : null;
            d.place = myTm != null ? (teamPlace.get(myTm) | 0) : 0;
            d.score = 0;
            if (teamsAll && myTm != null) { const tr = teamsAll.find(x => x.tm === myTm); if (tr) d.score = tr.score | 0; }
            duoTail = ',"duo":' + JSON.stringify(d);
        }
        const payload = sharedStr.slice(0, -1) + ',"youPlace":' + (myRow ? (myRow.place | 0) : 0) +
            ',"youScore":' + (mine ? scoreOf(mine) : 0) + ',"youPB":' + ((client.raidPB || 0) | 0) +
            ',"you":' + JSON.stringify(you) + duoTail + '}';
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

// Smash every rock touching a circle of radius R at (x, y): a landing pocket.
// Refuses (and digs nothing) when an emerald is in the way.
function pocketRocks(tg, x, y, R) {
    if (!tg || !tg.rocks) return null;
    const hits = [];
    for (const rock of tg.rocks.values()) {
        if (!rock || !(rock.alive || rock.growing)) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        const d2 = (rx - x) ** 2 + (ry - y) ** 2;
        if (d2 > (R + 160) ** 2) continue;
        let touch = d2 <= R * R;
        if (!touch && rock.worldPoly) for (const p of rock.worldPoly) { if ((p[0] - x) ** 2 + (p[1] - y) ** 2 <= R * R) { touch = true; break; } }
        if (touch) hits.push(rock);
    }
    if (hits.some(rk => rk.ore === 4)) return null;
    return hits;
}

// Break (and hold open for holdMs) every rock in `list`; mined-out cells in
// it are only held. Emeralds are skipped, always.
function breakAndHold(tg, list, holdMs) {
    const until = now() + holdMs;
    for (const rock of list) {
        if (!rock || rock.canyon) continue;
        if (rock.ore === 4 && (rock.alive || rock.growing)) continue;
        if (rock.alive || rock.growing) {
            try { tg.damageRock(rock, rock.health + 1, rock.worldCx || rock.wx, rock.worldCy || rock.wy, false, null); } catch { /* */ }
        }
        if (!rock.alive && !rock.growing) rock.noRegrowUntil = Math.max(rock.noRegrowUntil || 0, until);
    }
}

// Where the storm edge will be `aheadS` seconds from now (st: storm.snapshot).
function stormRAhead(st, aheadS) {
    const rNow = st.r || 0;
    return Math.max(0, rNow - Math.max(0, rNow - (st.n || rNow)) * (aheadS * 4));
}

// With `zone` (spawn reachability on) the pocket also gets an exit tunnel of
// plain rock to the nearest open region (spawnReach.exitPath: never through
// an emerald, fresh ore or regrowing rock; routes around them), and pocket
// and tunnel are held open for SPAWN_POCKET_HOLD_MS. No tunnel within
// SPAWN_TUNNEL_MAX cells: nothing is dug and the spot is refused.
function carveSpawnPocket(tg, x, y, R, zone) {
    if (!tg || !tg.rocks || !tg.damageRock) return false;
    const hits = pocketRocks(tg, x, y, R);
    if (!hits) return false;
    let tunnel = [];
    if (zone) {
        const center = spawnReach.cellAt(tg, x, y);
        const assumeOpen = new Set(hits.map(r => r.k));
        if (center) assumeOpen.add(center.k);
        tunnel = spawnReach.exitPath(tg, x, y, { zone, assumeOpen, maxCells: FIRST_MINUTES.SPAWN_TUNNEL_MAX, now: now() });
        if (!tunnel) return false;
        tunnel = tunnel.filter(r => !assumeOpen.has(r.k));
    }
    if (zone) {
        breakAndHold(tg, hits.concat(tunnel), FIRST_MINUTES.SPAWN_POCKET_HOLD_MS);
        const c = spawnReach.cellAt(tg, x, y);
        if (c) breakAndHold(tg, [c], FIRST_MINUTES.SPAWN_POCKET_HOLD_MS);
        spawnReach.invalidate();
    } else {
        for (const rock of hits) {
            try { tg.damageRock(rock, rock.health + 1, rock.worldCx || rock.wx, rock.worldCy || rock.wy, false, null); } catch { /* */ }
        }
    }
    carveSpawnPocket.lastTunnel = tunnel.length;
    return !(tg.pointInRock && tg.pointInRock(x, y));
}

// Where a fresh body drops in. `self` is the body being placed (left out of
// the threat list); `forBot` keeps a dropping bot extra far from humans.
// The drop pits sit on a ring outside the plaza, so once the storm closed
// past them there used to be no candidate at all and EVERY spawn, bots
// included, landed on the storm centre: the final circle's pile-up point.
// Open ground inside the safe zone is sampled as well now, and the spot
// farthest from every threat (fights and bosses count as closer) wins.
function safeSpawnSpot(self, forBot) {
    const FM = FIRST_MINUTES;
    const t = now();
    const st = storm.snapshot(t);
    const holes = pits();
    const bodies = combatants().filter(b => b !== self);
    // plan for the circle a little ahead (st.n is the radius 250 ms from now),
    // so a fresh spawn is not in the storm half a minute later either
    const rNow = st.r || 0;
    const r = stormRAhead(st, FM.SPAWN_STORM_AHEAD_S);
    const margin = Math.min(FM.SPAWN_EDGE_MARGIN, r * FM.SPAWN_EDGE_MARGIN_FRAC);   // a fresh spawn never lands in the storm
    const safeR = Math.max(80, r - margin);
    const tgS = global.gameManager.terrainGrid;
    // Reachability: the way out may not leave the circle the storm will
    // have in SPAWN_STORM_AHEAD_S; a spot that only escapes by digging (not
    // joined to open ground) must also sit inside the edge of
    // SPAWN_STORM_AHEAD_DIG_S from now, with the same margin.
    const zone = { x: st.cx || 0, y: st.cy || 0, r };
    const digR = Math.max(80, stormRAhead(st, FM.SPAWN_STORM_AHEAD_DIG_S) - margin);
    const reachMemo = new Map();
    const reachOf = (h) => {
        const key = Math.round(h.x) + ':' + Math.round(h.y);
        let res = reachMemo.get(key);
        if (!res) {
            res = spawnReach.check(tgS, h.x, h.y, { zone, now: t });
            if (res.ok && res.via === 'dig' && Math.hypot(h.x - zone.x, h.y - zone.y) > digR) res = { ok: false, reason: 'dig-storm' };
            reachMemo.set(key, res);
        }
        return res;
    };
    const reachOk = (h) => !FM.SPAWN_REACH || reachOf(h).ok;
    const mapR = ((tgS && tgS.circleRadius) || 2700) - FM.SPAWN_MAP_MARGIN;
    // a pit the wall has grown back over is rock now, not a spawn point
    const open = (h) => !(tgS && tgS.pointInRock && tgS.pointInRock(h.x, h.y));
    const inSafe = (h) => Math.hypot(h.x - st.cx, h.y - st.cy) < safeR;
    let pads = [];
    try { pads = [...vault.getVaults(), ...outposts.getOutposts(), ...shop.getShops()].filter(Boolean); } catch { /* */ }
    const offPad = (h) => !pads.some(p => padGeom.insidePad(p, h.x, h.y, FM.SPAWN_PAD_CLEAR));
    let cands = holes.filter(h => inSafe(h) && open(h)).map(h => ({ x: h.x, y: h.y, pit: true }));
    // every mined-out cell (and canyon) inside the zone is open ground
    if (tgS && tgS.rocks) {
        for (const rk of tgS.rocks.values()) {
            if (!rk || rk.alive || rk.growing) continue;
            const h = { x: rk.worldCx || rk.wx, y: rk.worldCy || rk.wy, pit: false };
            if (inSafe(h) && Math.hypot(h.x, h.y) < mapR && open(h) && offPad(h)) cands.push(h);
        }
    }
    // random points: open ones are candidates as they are; ones in solid rock
    // are kept aside in case a pocket has to be dug (below)
    const rockCands = [];
    for (let i = 0; i < FM.SPAWN_SAMPLES; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * safeR;
        const h = { x: st.cx + Math.cos(a) * d, y: st.cy + Math.sin(a) * d, pit: false };
        if (!(Math.hypot(h.x, h.y) < mapR) || !offPad(h)) continue;
        if (open(h)) cands.push(h); else rockCands.push(h);
    }
    // nobody lands where they cannot get out (a pocket ringed by ore or
    // emerald, a mined-out cell about to close, a way out through the storm)
    const candsAll = cands.length;
    let noReach = false;
    if (FM.SPAWN_REACH && tgS) {
        const ok = cands.filter(reachOk);
        if (ok.length) cands = ok;
        else noReach = true;   // dig a pocket with an exit if at all possible (below)
    }
    const candsReach = noReach ? 0 : cands.length;
    // A reservation is a hard no for PIT_RESERVE_MS, by radius: nobody drops
    // into a gap somebody landed in moments ago, even if they already left.
    const live = [];
    // A human ignores spots bots reserved: the bots themselves are already
    // threats above, and in a small circle their reservations covered every
    // gap, pushing the human onto whatever scrap was left.
    for (const [k, r] of pitReservations) {
        if (r.until <= t) { pitReservations.delete(k); continue; }
        if (!forBot && r.bot) continue;
        live.push(r);
    }
    const reservedBy = (h) => live.find(r => (h.x - r.x) ** 2 + (h.y - r.y) ** 2 < PIT_RESERVE_R * PIT_RESERVE_R);
    const free = cands.filter(h => !reservedBy(h));
    if (free.length) cands = free;
    else if (cands.length) cands = [cands.slice().sort((a, b) => reservedBy(a).until - reservedBy(b).until)[0]];
    const boss = bosses.current();
    const fightCut = t - FM.SPAWN_FIGHT_MS;
    const threats = [];
    for (const b of bodies) {
        let mult = Math.max(b._lastDamageAt || 0, b.hitAt || 0) > fightCut ? FM.SPAWN_FIGHT_MULT : 1;
        if (forBot && b.socket) mult *= FM.SPAWN_BOT_HUMAN_MULT;
        threats.push({ x: b.x, y: b.y, mult });
    }
    for (const rv of live) threats.push({ x: rv.x, y: rv.y, mult: 1 });
    if (boss) threats.push({ x: boss.x, y: boss.y, mult: FM.SPAWN_BOSS_MULT });
    const clearOf = (h) => {
        let m = Infinity;
        for (const q of threats) {
            const d = Math.hypot(h.x - q.x, h.y - q.y) * q.mult;
            if (d < m) m = d;
        }
        return m;
    };
    const scored = cands.map(h => ({ h, m: clearOf(h) })).sort((a, b) => b.m - a.m);
    // Clear enough (1500 at full storm, less as it closes): a drop pit if one
    // qualifies (they are the map's own drop points), else open ground, a
    // random one of the three roomiest so drops spread out. Nothing clear
    // enough (the final circle): the farthest spot, near-ties shuffled.
    const want = Math.min(FM.SPAWN_CLEAR, r * FM.SPAWN_CLEAR_STORM_FRAC);
    let pick = null;
    if (scored.length) {
        let top = scored.filter(s => s.h.pit && s.m >= want).slice(0, 3);
        if (!top.length) top = scored.filter(s => s.m >= want).slice(0, 3);
        // (clearance can be negative next to a boss, so the tie band is |best|-based)
        if (!top.length) top = scored.filter(s => s.m >= scored[0].m - Math.abs(scored[0].m) * 0.05);
        if (!top.length) top = [scored[0]];
        pick = top[(Math.random() * top.length) | 0].h;
    }
    // A closing circle is mostly solid rock: when no open spot is clear
    // enough and a spot inside the rock is clearly roomier, dig a landing
    // pocket there (never through an emerald), like the drop pits.
    // (with reachability on, the pocket gets an exit tunnel and is held
    // open; when no open spot could be got out of at all, dig regardless
    // of the gain, and a pocket that finds no tunnel is not dug)
    const bestOpen = scored.length && !noReach ? scored[0].m : -Infinity;
    if (bestOpen < want && rockCands.length && tgS) {
        const rs = rockCands.filter(h => !reservedBy(h)).map(h => ({ h, m: clearOf(h) })).sort((a, b) => b.m - a.m);
        for (const cand of rs.slice(0, noReach ? 8 : 3)) {
            if (!(cand.m > bestOpen + FM.SPAWN_CARVE_GAIN)) break;
            if (carveSpawnPocket(tgS, cand.h.x, cand.h.y, FM.SPAWN_CARVE_R, FM.SPAWN_REACH ? zone : null)) { pick = cand.h; pick.carved = true; break; }
        }
    }
    if (!pick) {
        const o = openGroundNear(tgS, st.cx || 0, st.cy || 0);
        spawnAudit(o, forBot, 'fallback', FM.SPAWN_REACH ? reachOf(o) : null);
        return o;
    }
    // a mined-out cell picked as the spawn is held open a little while, so
    // it does not start regrowing around the body the moment it lands
    if (FM.SPAWN_REACH && tgS && !pick.pit && !pick.carved) {
        const c = spawnReach.cellAt(tgS, pick.x, pick.y);
        if (c && !c.canyon && !c.alive && !c.growing) c.noRegrowUntil = Math.max(c.noRegrowUntil || 0, t + FM.SPAWN_CELL_HOLD_MS);
    }
    if (process.env.SPAWN_DEBUG) console.log('[SPAWN]', forBot ? 'bot' : 'human', 'r', Math.round(rNow), '->', Math.round(r), 'safeR', Math.round(safeR), 'cands', cands.length, 'of', candsAll, 'reach', candsReach, 'rock', rockCands.length, 'pits', cands.filter(c => c.pit).length, 'threats', threats.length, 'want', Math.round(want), 'bestOpen', Math.round(bestOpen), 'pick', Math.round(clearOf(pick)), pick.carved ? 'CARVED tunnel ' + (carveSpawnPocket.lastTunnel | 0) : '', 'at', Math.round(pick.x), Math.round(pick.y), 'bots', bodies.filter(b => b.isBot).map(b => Math.round(Math.hypot(b.x - pick.x, b.y - pick.y))).join(','));
    spawnAudit(pick, forBot, pick.carved ? 'carved' : pick.pit ? 'pit' : 'open', null);
    pitReservations.set(Math.round(pick.x) + ":" + Math.round(pick.y), { x: pick.x, y: pick.y, until: t + PIT_RESERVE_MS, bot: !!forBot });
    return { x: pick.x, y: pick.y };
}

// Storm rescue (the safety net under the reachability rule): a body in its
// first RESCUE_WINDOW_MS that the storm has reached, and whose cheapest way
// back into the zone costs at least RESCUE_MIN_COST fresh plain rocks (ore
// and regrowing rock included, emerald never), gets that tunnel broken and
// held open. Once per life; storm damage is untouched, they still walk out.
const spawnRescue = { n: 0, cells: 0 };
function tickSpawnRescue(t) {
    const FM = FIRST_MINUTES;
    if (!FM.SPAWN_REACH) return;
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return;
    let st = null;
    for (const body of combatants()) {
        if (!body._inStorm || !body.royaleBornAt || t - body.royaleBornAt > FM.RESCUE_WINDOW_MS) continue;
        if (body._rescueLife === body.royaleBornAt) continue;
        if (t - (body._rescueTryAt || 0) < FM.RESCUE_RETRY_MS) continue;
        body._rescueTryAt = t;
        if (!st) st = storm.snapshot(t);
        const w = tg._cellWorld || 110;
        const toZone = { x: st.cx || 0, y: st.cy || 0, r: Math.max(w, (st.r || 0) - w * 1.5) };
        const path = spawnReach.exitPath(tg, body.x, body.y, { rescue: true, toZone, maxCells: FM.RESCUE_MAX_CELLS, now: t });
        if (!path) continue;   // nothing within reach (retried every RESCUE_RETRY_MS)
        body._rescueLife = body.royaleBornAt;
        const plain = (tg.baseRockHealth || 1) * 1.3 * ((global.royaleMods && global.royaleMods.rockHpMult) || 1);
        let cost = 0;
        for (const r of path) if (r.alive || r.growing) cost += (r.health || 0) / plain;
        if (cost < FM.RESCUE_MIN_COST) continue;   // not boxed in: a short dig or a walk
        breakAndHold(tg, path, FM.SPAWN_POCKET_HOLD_MS);
        spawnReach.invalidate();
        spawnRescue.n++; spawnRescue.cells += path.length;
        if (process.env.SPAWN_DEBUG) console.log('[SPAWN-RESCUE]', body.name, 'cells', path.length, 'cost', +cost.toFixed(2), 'at', Math.round(body.x), Math.round(body.y));
        try { if (body.sendMessage) body.sendMessage("The storm cracked the rock open: get back inside!"); } catch { /* */ }
    }
}

// ROYALE_DEBUG only: plant `k` gem-ringed pockets (a mined-out cell whose
// every neighbour is fresh shard/emerald, held open so it stays a pocket)
// and `k` mined-out cells in plain rock that are about to regrow, inside the
// storm circle. These are the spots the old spawn picker landed people in.
function debugPlantTraps(k) {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return 0;
    const { ORE, ORE_HP } = require('../../terrain/terrainGrid.js');
    const adj = spawnReach.adjacency(tg);
    const st = storm.snapshot(now());
    const cands = [...tg.rocks.values()].filter(r => r.alive && !r.growing && r.worldPoly && !r.canyon && r.ore !== ORE.EMERALD &&
        Math.hypot((r.worldCx - st.cx), (r.worldCy - st.cy)) < (st.r || 0) * 0.85 &&
        (adj.get(r.k) || []).every(n => n.alive && !n.canyon));
    let planted = 0;
    const t = now(), plain = tg.baseRockHealth * 1.3;
    for (let i = 0; i < k * 2 && cands.length; i++) {
        const r = cands.splice((Math.random() * cands.length) | 0, 1)[0];
        if (!r.alive || !(adj.get(r.k) || []).every(n => n.alive)) continue;
        const gem = i % 2 === 0;
        tg.damageRock(r, r.health + 1, r.worldCx, r.worldCy, false, null);
        if (gem) {
            r.noRegrowUntil = t + 120_000;
            for (const n of adj.get(r.k) || []) {
                n.ore = Math.random() < 0.25 ? ORE.EMERALD : ORE.SHARD;
                n.maxHealth = plain * ORE_HP[n.ore]; n.health = n.maxHealth;
                try { n.deposits = tg._buildDeposits(n); } catch { n.deposits = null; }
                tg.rockEvents.push({ k: n.k, e: 1 });
            }
        } else {
            r.diedAt = t - 20_000;   // regrows within a few seconds
        }
        planted++;
    }
    spawnReach.invalidate();
    return planted;
}

// Spawn audit (ROYALE_DEBUG DBG 'spawnaudit' reads it): every pick, checked
// against the reachability rule whether or not the rule is switched on.
const spawnLog = { n: 0, enclosed: 0, byKind: {}, byReason: {}, recent: [] };
function spawnAudit(spot, forBot, kind, res) {
    if (!process.env.ROYALE_DEBUG && !process.env.SPAWN_DEBUG) return;
    try {
        const tg = global.gameManager.terrainGrid;
        const st = storm.snapshot(now());
        const zone = { x: st.cx || 0, y: st.cy || 0, r: stormRAhead(st, FIRST_MINUTES.SPAWN_STORM_AHEAD_S) };
        spawnReach.invalidate();
        const r = res || spawnReach.check(tg, spot.x, spot.y, { zone, now: now() });
        spawnLog.n++;
        spawnLog.byKind[kind] = (spawnLog.byKind[kind] | 0) + 1;
        const tag = r.ok ? 'ok-' + r.via : r.reason;
        spawnLog.byReason[tag] = (spawnLog.byReason[tag] | 0) + 1;
        if (!r.ok) spawnLog.enclosed++;
        spawnLog.recent.push({ x: Math.round(spot.x), y: Math.round(spot.y), bot: !!forBot, kind, tag, sr: Math.round(st.r) });
        if (spawnLog.recent.length > 40) spawnLog.recent.shift();
        if (process.env.SPAWN_DEBUG) console.log('[SPAWN-REACH]', forBot ? 'bot' : 'human', kind, tag, 'cost', r.cost != null ? +r.cost.toFixed(2) : '-', 'at', Math.round(spot.x), Math.round(spot.y));
    } catch (e) { guardLog('spawn audit', e); }
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
    body.royaleBornAt = now();     // a kill inside 15 s of this pays nothing (ranked)
    body.deathCause = "";
    // bot grace (controllers.js sense / canInitiateFight / auto turrets):
    // bots leave a fresh spawn alone until this, or until it damages a bot
    // (game/index.js clears it); new players get longer and softer focus
    if (body.socket) {
        const fresh = isNewPlayer(body.socket);
        body.botNewbie = fresh;
        body.botGraceUntil = now() + (fresh ? FIRST_MINUTES.BOT_GRACE_NEW_MS : FIRST_MINUTES.BOT_GRACE_MS);
    }
    const extra = raidMods.num('extraSkill', 0);
    if (extra > 0 && !body._modSkillGiven) {
        body._modSkillGiven = true;
        try { body.skill.points += extra; } catch { /* */ }
    }
    try { body.health.amount = body.health.max; } catch { /* */ }
    try { if (body.shield) body.shield.amount = body.shield.max; } catch { /* */ }
}

// ── new players ───────────────────────────────────────────────────────────
// Lives played before this session: guest games (guests table) or account
// lives (user_stats), read once per socket. Unknown identity -> 0, asked again.
function careerLives(socket) {
    if (!socket) return 0;
    if (socket._careerLives !== undefined) return socket._careerLives;
    let n = null;
    try {
        const d = require('../../../accounts/db').handle();
        if (d) {
            if (socket.account && socket.account.id) {
                const row = d.get('SELECT lives FROM user_stats WHERE user_id = ?', socket.account.id);
                n = row ? (row.lives | 0) : 0;
            } else if (socket.guestId) {
                const row = d.get('SELECT games FROM guests WHERE guest_id = ?', socket.guestId);
                n = row ? (row.games | 0) : 0;
            }
        }
    } catch { n = null; }
    if (n === null) return 0;
    socket._careerLives = n;
    return n;
}
function isNewPlayer(socket) {
    if (!socket) return false;
    return careerLives(socket) + (socket._royaleLives | 0) < FIRST_MINUTES.NEW_PLAYER_LIVES;
}

// Humans taking part: alive, or dead and on their way back. Counting only
// live bodies let a bot take a dead player's slot, so every death grew the
// bot count by one for the rest of the cycle.
function humansInRaid() {
    let n = 0;
    for (const c of connectedClients()) {
        const b = c.player && c.player.body;
        if ((b && b.isPlayer && !b.isDead?.() && !b.isGhost) || (c._royaleLives | 0) > 0) n++;
    }
    return n;
}

// Bots the raid wants right now: fill up to FILL_CAP with the humans, but a
// closing storm only holds (r / DENSITY_R)^2 fighters in all.
function botCapNow() {
    const FM = FIRST_MINUTES;
    const hs = humansInRaid();
    // duos: a lone player (who may be filled later) still counts as a pair,
    // so 1 or 2 humans both meet 5 bots
    let cap = fillCap() - (Config.royale_duos ? Math.max(2, hs) : hs);
    try {
        const st = storm.snapshot(now());
        if (st && st.a) {
            // bot teammates are fighters too: they share the closing circle
            const total = Math.floor(((st.r || 0) / FM.DENSITY_R) ** 2) - teamBots().length;
            cap = Math.min(cap, Math.max(hs ? FM.DENSITY_MIN_BOTS : 0, total - hs));
        }
    } catch { /* */ }
    return Math.max(0, cap);
}

function liveBots() {
    return (global.gameManager.gameHandler?.bots || []).filter(b => b && !b.isDead() && !b.isGhost);
}
// Duos: bot teammates (one per human who got a bot partner) are counted on
// their own: they never take an enemy bot's slot and are never trimmed.
function enemyBots() { return liveBots().filter(b => !b.isTeamBot); }
function teamBots() { return liveBots().filter(b => b.isTeamBot); }

// A bot leaving quietly: nothing drops, no feed line, no credit.
function despawnBot(bot) {
    try {
        bot.carriedGems = 0;
        try { gems.updateSatchel(bot); } catch { /* */ }
        bot.invuln = false; bot.godmode = false; bot.passive = false;
        bot.deathCause = "despawn";
        bot.dontSendDeathMessage = true;
        bot.kill();
    } catch { /* */ }
}

// Too many bots for the circle: one leaves every DENSITY_TRIM_MS. Only one
// that is out of every fight and off every human's screen (or out in the
// storm); if none ever qualifies, after DENSITY_FORCE_MS the farthest idle
// one that is at least DENSITY_FORCE_AWAY away.
let lastTrimAt = 0, overCapSince = 0;
function trimBots(t) {
    const FM = FIRST_MINUTES;
    const bots = enemyBots();
    const cap = botCapNow();
    if (bots.length <= cap) { overCapSince = 0; return; }
    if (!overCapSince) overCapSince = t;
    if (t - lastTrimAt < FM.DENSITY_TRIM_MS) return;
    const hs = humans();
    let best = null, bestScore = -Infinity, far = null, farD = -1;
    for (const b of bots) {
        if (t - Math.max(b._lastDamageAt || 0, b.hitAt || 0) < 5000) continue;   // mid-fight
        if (b._fightingPlayerId) continue;
        let d = Infinity;
        for (const h of hs) { const dd = Math.hypot(h.x - b.x, h.y - b.y); if (dd < d) d = dd; }
        let lost = false;
        try { lost = storm.inStorm(b.x, b.y); } catch { /* */ }
        if (d >= FM.DENSITY_TRIM_AWAY || lost) {
            const score = (lost ? 1e6 : 0) + d;
            if (score > bestScore) { bestScore = score; best = b; }
        } else if (d > farD) { farD = d; far = b; }
    }
    if (!best && far && farD >= FM.DENSITY_FORCE_AWAY && t - overCapSince >= FM.DENSITY_FORCE_MS) best = far;
    if (!best) return;
    lastTrimAt = t;
    despawnBot(best);
}

// "You joined late": one callout per raid end / storm cycle per player.
function fmtClock(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}
function lateJoinNote(body) {
    const FM = FIRST_MINUTES;
    const sock = body && body.socket;
    if (!sock) return;
    const t = now();
    const raidLeft = Math.max(0, Math.ceil((raidEndsAt - t) / 1000));
    let st = null;
    try { st = storm.snapshot(t); } catch { /* */ }
    const cycleLeft = st && st.a ? (st.hold ? st.left : st.left + Math.round(storm.holdMs() / 1000)) : Infinity;
    let key, title, sub;
    if (raidLeft > 0 && raidLeft <= FM.LATE_RAID_SEC) {
        key = "raid:" + raidId;
        title = "Final minutes of this raid";
        sub = "A fresh raid starts in " + fmtClock(raidLeft + (RAID_END_BEAT_MS + RAID_END_WAIT_MS) / 1000) + ". Bank what you can!";
    } else if (cycleLeft <= FM.LATE_STORM_SEC) {
        key = "storm:" + raidId + ":" + (st.c | 0);
        title = "The storm's almost shut";
        sub = "It opens back up in " + fmtClock(cycleLeft) + ". Stay inside and bank what you can.";
    } else return;
    if (sock._lateNoteKey === key) return;
    sock._lateNoteKey = key;
    try { sock.talk('KC', 'late', title, 0, sub, FM.LATE_NOTE_MS); } catch { /* */ }
    try { body.sendMessage(title + ". " + sub); } catch { /* */ }
}

// Duos: a spot at a living partner's side, for a (re)spawn. Null when the
// partner is fighting, in the storm or has an enemy close (then the normal
// safe spawn applies). `loose`: skip those checks (a new raid placing
// partners together).
function spotNearMate(self, mate, loose = false) {
    if (!mate || mate.isDead?.() || mate.royaleAlive === false) return null;
    const t = now();
    const FM = FIRST_MINUTES;
    const foes = combatants().filter(b => b !== self && b !== mate && b.team !== mate.team);
    if (!loose) {
        if (Math.max(mate._lastDamageAt || 0, mate.hitAt || 0) > t - 5000) return null;
        try { if (storm.inStorm(mate.x, mate.y)) return null; } catch { /* */ }
        for (const f of foes) if (Math.hypot(f.x - mate.x, f.y - mate.y) < 900) return null;
    }
    let pads = [];
    try { pads = [...vault.getVaults(), ...outposts.getOutposts(), ...shop.getShops()].filter(Boolean); } catch { /* */ }
    const tg = global.gameManager.terrainGrid;
    const mapR = ((tg && tg.circleRadius) || 2700) - FM.SPAWN_MAP_MARGIN;
    const reachable = mateReachTest(tg);
    let best = null, bestM = -Infinity;
    for (let i = 0; i < 28; i++) {
        const a = Math.random() * Math.PI * 2, d = 170 + Math.random() * 260;
        const x = mate.x + Math.cos(a) * d, y = mate.y + Math.sin(a) * d;
        if (Math.hypot(x, y) > mapR) continue;
        if (tg && tg.pointInRock && tg.pointInRock(x, y)) continue;
        try { if (storm.inStorm(x, y)) continue; } catch { /* */ }
        if (pads.some(p => padGeom.insidePad(p, x, y, FM.SPAWN_PAD_CLEAR))) continue;
        if (!reachable(x, y)) continue;   // same rule as a safe spawn: never boxed in
        let m = Infinity;
        for (const f of foes) { const dd = Math.hypot(f.x - x, f.y - y); if (dd < m) m = dd; }
        if (m > bestM) { bestM = m; best = { x, y }; }
    }
    if (!best) {
        const o = openGroundNear(tg, mate.x + 200, mate.y);
        if (!(tg && tg.pointInRock && tg.pointInRock(o.x, o.y)) && reachable(o.x, o.y)) best = o;
    }
    if (best) spawnAudit(best, !self || !self.socket, 'mate', null);
    return best;
}

// The safe-spawn reachability rule as a point test (off: always true), for
// spawns beside a partner and a team bot catching up.
function mateReachTest(tg) {
    if (!FIRST_MINUTES.SPAWN_REACH || !tg) return () => true;
    const t = now();
    let st = null;
    try { st = storm.snapshot(t); } catch { return () => true; }
    const zone = { x: st.cx || 0, y: st.cy || 0, r: stormRAhead(st, FIRST_MINUTES.SPAWN_STORM_AHEAD_S) };
    const margin = Math.min(FIRST_MINUTES.SPAWN_EDGE_MARGIN, zone.r * FIRST_MINUTES.SPAWN_EDGE_MARGIN_FRAC);
    const digR = stormRAhead(st, FIRST_MINUTES.SPAWN_STORM_AHEAD_DIG_S) - margin;
    return (x, y) => {
        const res = spawnReach.check(tg, x, y, { zone, now: t });
        if (!res.ok) return false;
        return res.via !== 'dig' || Math.hypot(x - zone.x, y - zone.y) <= digR;
    };
}

function spawnRaidBot() {
    const handler = global.gameManager.gameHandler;
    if (!handler) return;
    // duos: two of the bots are a team (they spawn together and cover each other)
    const plan = Config.royale_duos ? duo.botSpawnPlan(enemyBots()) : null;
    const hole = (plan && plan.near && spotNearMate(null, plan.near)) || safeSpawnSpot(null, true);
    // duos: a team id nobody had this raid (stale board rows keep theirs)
    const team = plan ? plan.team : Config.royale_duos ? duo.freshTeamId() : getRandomTeam();
    handler.spawnBots({ x: hole.x + (Math.random() - 0.5) * 40, y: hole.y + (Math.random() - 0.5) * 40 }, team);
    const bot = handler.bots[handler.bots.length - 1];
    if (!bot) return;
    bot.team = team;
    if (plan) duo.linkBotDuo(bot, enemyBots());
    bot.botRespawnsRemaining = 0;
    bot.royaleAlive = true;
    bot.royaleBornAt = now();
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
    if (raidEnding) return;
    trimBots(t);
    if (t - lastFillAt < 400) return;
    if (stormLocked()) return;
    if (enemyBots().length >= botCapNow()) return;
    lastFillAt = t;
    spawnRaidBot();
}

const TEAM_BOT_CATCHUP_D = 1350;     // this far from its human (past the 1300 regroup leash)...
const TEAM_BOT_CATCHUP_MS = 6000;    // ...for this long (and out of a fight): skip ahead
const TEAM_BOT_CATCHUP_R = 850;      // to about this far from them (just off their screen)

// Open ground ~TEAM_BOT_CATCHUP_R from the human, on the bot's side.
function catchUpSpot(bot, human) {
    const tg = global.gameManager.terrainGrid;
    const mapR = ((tg && tg.circleRadius) || 2700) - FIRST_MINUTES.SPAWN_MAP_MARGIN;
    let pads = [];
    try { pads = [...vault.getVaults(), ...outposts.getOutposts(), ...shop.getShops()].filter(Boolean); } catch { /* */ }
    const base = Math.atan2(bot.y - human.y, bot.x - human.x);
    const reachable = mateReachTest(tg);
    for (let k = 0; k < 9; k++) {
        const a = base + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 0.35;
        for (const r of [TEAM_BOT_CATCHUP_R, TEAM_BOT_CATCHUP_R * 0.8]) {
            const x = human.x + Math.cos(a) * r, y = human.y + Math.sin(a) * r;
            if (Math.hypot(x, y) > mapR) continue;
            if (tg && tg.rockHitByCircle && tg.rockHitByCircle(x, y, (bot.realSize || 30) + 10)) continue;
            try { if (storm.inStorm(x, y)) continue; } catch { /* */ }
            if (pads.some(p => padGeom.insidePad(p, x, y, FIRST_MINUTES.SPAWN_PAD_CLEAR))) continue;
            if (!reachable(x, y)) continue;
            return { x, y };
        }
    }
    return null;
}
// Duos: a human's bot teammate. Same team (colour, no friendly fire), spawned
// at their side, same name and board row through every respawn.
function spawnTeamBot(team, near) {
    const handler = global.gameManager.gameHandler;
    if (!handler || !team || !team.bot || !near) return null;
    const tg = global.gameManager.terrainGrid;
    let spot = spotNearMate(null, near, true);
    if (!spot) spot = openGroundNear(tg, near.x + 160, near.y);
    const tb = team.bot;
    const lifecycle = tb.fam != null ? { familyId: tb.fam, respawnsRemaining: 0 } : null;
    handler.spawnBots({ x: spot.x, y: spot.y }, team.id, tb.name || null, lifecycle);
    const bot = handler.bots[handler.bots.length - 1];
    if (!bot) return null;
    bot.team = team.id;
    const c = team.color != null ? team.color : global.assignTeamColor(team.id);
    bot.color.base = c; bot.leaderboardColor = c; bot.minimapColor = c;
    // a steady partner: no showboating, not the timid or the reckless kind
    bot.botStyle = 'normal';
    bot.botTemperament = 'balanced';
    bot.botSkill = Math.max(bot.botSkill || 0, 0.6);
    duo.adoptTeamBot(team, bot, near);
    bot.botRespawnsRemaining = 0;
    bot.royaleAlive = true;
    bot.royaleBornAt = now();
    bot.weakDrillUntil = 0;
    try { gems.initSatchel(bot); } catch { /* */ }
    try { bot.refreshBodyAttributes(); } catch { /* */ }
    ensureStat(bot);
    try { near.sendMessage(bot.name + " dropped in beside you."); } catch { /* */ }
    return bot;
}

function tickTeamBots(t) {
    if (t - (tickTeamBots.at || 0) < 200) return;
    tickTeamBots.at = t;
    const bots = liveBots();
    const work = duo.teamBotWork(t, bots);
    for (const b of work.despawn) despawnBot(b);
    if (!canSpawn()) return;
    for (const w of work.spawn) spawnTeamBot(w.team, w.near);
    // a bot teammate stranded across the map (its human got back to base,
    // or the rock between them is a maze) catches up quietly: long enough
    // apart and out of any fight, it skips ahead to just off its human's
    // screen, on its own side, and walks the rest
    for (const b of bots) {
        if (!b.isTeamBot || b.isDead?.()) continue;
        const h = b.duoMate;
        const far = h && !h.isDead?.() && h.team === b.team && Math.hypot(h.x - b.x, h.y - b.y) > TEAM_BOT_CATCHUP_D;
        if (!far) { b._teamFarSince = 0; continue; }
        if (!b._teamFarSince) b._teamFarSince = t;
        const fighting = t - Math.max(b._lastDamageAt || 0, b.hitAt || 0) < 6000 || b._digWarsGoal === 'fight';
        if (fighting || t - b._teamFarSince < TEAM_BOT_CATCHUP_MS) continue;
        const spot = catchUpSpot(b, h) || spotNearMate(b, h, true);
        if (!spot) continue;
        b._teamFarSince = 0;
        moveTo(b, spot.x, spot.y);
    }
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
    if (body.socket) { try { progressHooks.onCapture(body); } catch (e) { guardLog('progress capture', e); } }
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
    // a density trim (despawnBot) is as quiet as the raid-end mass death
    const raidEndDeath = body.deathCause === "raidend" || body.deathCause === "despawn";
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
            // booked at today's price, so a later twist can't re-price it (ranked basis)
            ks.killPts = (ks.killPts | 0) + killScore();
            // streak: escalating bonus past the mark, shutdown bounty for ending one
            ks.streak = (ks.streak | 0) + 1;
            streakNow = ks.streak;
            if (ks.streak > ks.bestStreak) ks.bestStreak = ks.streak;
            if (killerBody.socket) { try { progressHooks.onStreak(killerBody, ks.streak); } catch (e) { guardLog('progress streak', e); } }
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
            // ranked kill filters (bot half, same victim, spawn kill) + kill dust
            try { rankHooks.onKillCredited(killerBody, ks, body, s, pts); } catch (e) { guardLog('rank kill', e); }
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
    // duos: your partner hears about it
    if (Config.royale_duos && body.socket && !raidEndDeath) {
        try {
            const mb = duo.mateBody(body);
            if (mb && mb.socket) mb.sendMessage((body.name || "Your teammate") + " is down. Keep them in the game!");
        } catch { /* */ }
    }
    if (body.socket) {
        // settle the ranked life now; its RK follows the death packet (a
        // raid-end death was settled at endRaid, so this skips it)
        try { rankHooks.onDeath(body, s); } catch (e) { guardLog('rank death', e); }
        const dl = shop.onDeath(body);
        body.socket.raidDeathStreak = victimStreak;
        body.socket.raidDeathDrillLost = dl && dl.drillLost ? 1 : 0;
        let wait = raidEndDeath ? RAID_END_WAIT_MS : shop.respawnMs(body);
        if (!raidEndDeath && body.botNewbie) wait = Math.min(wait, FIRST_MINUTES.NEW_RESPAWN_MS);
        body.socket.royaleRespawnAt = now() + wait;
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

// ── in-raid rewards (R.REWARDS in shared/ranks.js) ─────────────────────────
// Raid points on the board (they reach the rank basis like any other score)
// and a little gemdust for account holders. Humans only: bots have no rank.
const REWARDS = require('../../../../shared/ranks.js').REWARDS;
let shopRewardCount = new Map();    // account id (or stat key) -> paid purchases this raid
function grantReward(body, pts, dustMilli) {
    if (!body || !body.socket || body.isBot) return;
    const s = ensureStat(body);
    if (s && pts > 0) s.extra = (s.extra | 0) + (pts | 0);
    if (dustMilli > 0) { try { dustHooks.creditReward(body.socket, dustMilli); } catch (e) { guardLog('reward dust', e); } }
}

function onBossDead(o, kind, killer, burrowed, shares = []) {
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
        if (killer.socket) { try { progressHooks.onBoss(killer); } catch (e) { guardLog('progress boss', e); } }
        grantReward(killer, 0, REWARDS.boss.finalDustMilli);
    }
    // everyone else who did a real share of the work
    for (const h of shares) {
        if (!h.body || h.body === killer || !(h.share >= REWARDS.boss.assistShare)) continue;
        if (h.body.isDead?.()) continue;
        grantReward(h.body, REWARDS.boss.assistPts, REWARDS.boss.assistDustMilli);
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
    const cr = chest.chestRare ? REWARDS.chest.epic : REWARDS.chest.common;
    grantReward(body, cr.pts, cr.dustMilli);
    if (body.socket) {
        questProgress(body, "chest", 1);
        try { progressHooks.onChest(body); } catch (e) { guardLog('progress chest', e); }
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
    if (!body || !body.socket) return;
    questProgress(body, "shop", 1);
    // a few purchases per raid pay a little; the cap keeps it unfarmable
    const key = (body.socket.account && body.socket.account.id) ? 'a:' + body.socket.account.id : statKeyFor(body);
    const n = shopRewardCount.get(key) | 0;
    if (n >= REWARDS.shop.perRaidCap) return;
    shopRewardCount.set(key, n + 1);
    grantReward(body, REWARDS.shop.pts, REWARDS.shop.dustMilli);
}

function ownedSiteFor(body) {
    if (!body) return null;
    try {
        const key = outposts.ownerKeyFor ? outposts.ownerKeyFor(body) : null;
        if (!key) return null;
        const list = outposts.getOutposts();
        // duos: your partner's base is yours too
        return list.find(s => (s.ownerKey === key || outposts.isOwner(s, body)) && s.banner && !s.banner.isDead?.()) || null;
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
    // duos: next to your partner if they're alive and not in a fight; that
    // beats the base (which is shared anyway) and a random safe spot
    let mateSpawn = false;
    if (Config.royale_duos) duo.watchHits(body);
    if (Config.royale_duos && !(body.socket && body.socket._resume)) {
        const mate = duo.mateBody(body);
        // just teamed up from the fill queue: right beside them, fight or not
        const loose = !!(body.socket && body.socket._duoNearMate);
        if (body.socket) body.socket._duoNearMate = false;
        const spot = mate ? spotNearMate(body, mate, loose) : null;
        if (spot) {
            mateSpawn = true;
            moveTo(body, spot.x, spot.y);
            try { body.sendMessage("You dropped in next to " + (mate.name || "your teammate") + "."); } catch { /* */ }
        }
    }
    const home = mateSpawn ? null : ownedSiteFor(body);
    let homeSpawn = mateSpawn;
    if (home) {
        let inStorm = false;
        try { inStorm = storm.inStorm(home.x, home.y); } catch { /* */ }
        if (!inStorm) {
            homeSpawn = true;
            occupy.delete(occKey(home, body));
            moveTo(body, home.x + (Math.random() - 0.5) * 30, home.y + (Math.random() - 0.5) * 30);
            try { body.sendMessage("You're back at your base. You can stay 10 seconds."); } catch { /* */ }
        }
    }
    if (!homeSpawn && !mateSpawn) {
        const hole = safeSpawnSpot(body);
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
    const joinStat = ensureStat(body);
    // a ranked life opens here; a resume keeps the one already open
    try { rankHooks.lifeStart(body, joinStat); } catch (e) { guardLog('rank life', e); }
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
        // this life counts toward "new player" from the next spawn on
        if (!resuming) body.socket._royaleLives = (body.socket._royaleLives | 0) + 1;
        try { lateJoinNote(body); } catch { /* */ }
        // the resume itself waits for sockets.initalizePlayer to finish the
        // level-45 fill, or those level-up points would land on top of the
        // restored build (applyPendingResume)
    }
}

// ── reconnect / resume ────────────────────────────────────────────────────
// A dropped connection (proxy reload, wifi blip, a refresh) used to cost the
// whole raid: bank, shop, score and tank all lived on the old socket. The
// client now reconnects on its own and sends the same per-tab token, and for
// two minutes the new socket inherits everything the old one had. Carried
// gems only come back if nothing had hit you for 8 s, so pulling the plug is
// not a way out of a losing fight.
// ROYALE_RESUME_MS shortens the window for local tests (ROYALE_DEBUG only).
const RESUME_MS = (process.env.ROYALE_DEBUG && parseInt(process.env.ROYALE_RESUME_MS, 10) > 0)
    ? parseInt(process.env.ROYALE_RESUME_MS, 10) : 120_000;
const RESUME_SAFE_MS = 8000;
const resumeStore = new Map();
// Keyed by the tab's token only. A resume is for a real drop: the same tab
// reconnecting (or reloading) within the window. Another tab, going to the
// menu or closing the tab starts fresh - the token lives in sessionStorage,
// so it dies with the tab, and 'LV' (sent on purpose-exits) skips the save.
function resumeKeysFor(socket) {
    const keys = [];
    if (socket && socket.resumeToken) keys.push(socket.resumeToken);
    return keys;
}
function saveResume(socket, body) {
    const keys = resumeKeysFor(socket);
    if (!keys.length) return;
    const token = keys[0];
    const t = now();
    // dropped again between claiming a raid and spawning into it: keep the
    // claimed snapshot (tank, spot, satchel) rather than an empty one
    if (!body && socket._resume && socket._resume.raidId === raidId) {
        const again = Object.assign({}, socket._resume, { at: t, keys, accountId: (socket.account && socket.account.id) || null });
        for (const k of keys) resumeStore.set(k, again);
        return again;
    }
    for (const [k, v] of resumeStore) if (t - v.at > RESUME_MS) resumeStore.delete(k);
    // a dead player has no body but still has a bank, a shop and a score
    const alive = !!body && !body.isDead?.() && body.royaleAlive !== false && !body.royaleLobby;
    const hitAgo = body ? Math.min(t - (body._lastDamageAt || 0), Date.now() - (body.hitAt || 0)) : 0;
    const snap = {
        at: t, raidId, statKey: body ? statKeyFor(body) : "s:" + socket.id, alive,
        keys, accountId: (socket.account && socket.account.id) || null,
        sock: {
            gemBanked: socket.gemBanked || 0, shop: socket.shop || null, raidQuest: socket.raidQuest || null,
            raidBonus: socket.raidBonus || 0, raidPB: socket.raidPB || 0, _milestoneIdx: socket._milestoneIdx || 0,
            gemDeposited: socket.gemDeposited || 0,
            // duos: who you are to the team book (a reconnect keeps the team)
            duoKey: socket.duoKey || null, duoPid: socket.duoPid || null, duoMates: socket.duoMates || null,
            duoFill: socket.duoFill !== false, _duoJoinSent: !!socket._duoJoinSent,
            raidDeathStreak: socket.raidDeathStreak || 0, royaleRespawnAt: socket.royaleRespawnAt || 0,
            lastRaidDeathAt: socket.lastRaidDeathAt || 0,
            _royaleLives: socket._royaleLives || 0, _lateNoteKey: socket._lateNoteKey || "",
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
        // the spawn shield is part of the life: a player who had already
        // moved or shot must not get a fresh one by reloading
        snap.shielded = !!body.invuln;
        snap.graceLeft = Math.max(0, (body.spawnGraceUntil || 0) - t);
        // ...and so is the bot grace: a reload never starts a fresh one
        snap.botGraceLeft = Math.max(0, (body.botGraceUntil || 0) - t);
        snap.botNewbie = !!body.botNewbie;
        if (hitAgo > RESUME_SAFE_MS) {
            snap.carried = (body.carriedGems | 0);
            body.carriedGems = 0;     // kept for the resume, so it must not also drop
            // its gemdust goes with it
            try { snap.dustCarried = dustHooks.stash(body); } catch { /* */ }
        }
    }
    for (const k of keys) resumeStore.set(k, snap);
    if (process.env.RESUME_DEBUG) console.log('[RESUME] saved', token.slice(0, 6), 'alive', snap.alive, 'banked', snap.sock.gemBanked, 'carried', snap.carried, 'drill', snap.sock.shop && snap.sock.shop.drill, 'raw', (snap.skillRaw || []).join(','), 'pts', snap.points, 'raid', raidId);
    return snap;
}
// Called when a new socket presents its token (before it spawns).
function claimResume(socket, token) {
    if (!Config.dig_royale || !socket || !token) return false;
    const myId = (socket.account && socket.account.id) || null;
    // a guest's raid never becomes an account's, and never someone else's;
    // a token holding another identity's raid falls through to the account's
    let snap = resumeStore.get(token);
    if (snap && (snap.accountId || null) !== myId) snap = null;
    if (process.env.RESUME_DEBUG) console.log('[RESUME] claim', token.slice(0, 6), 'found', !!snap, snap ? ('age ' + (now() - snap.at) + ' raid ' + snap.raidId + '/' + raidId) : '');
    if (!snap) return false;
    for (const k of snap.keys || [token]) resumeStore.delete(k);
    if (now() - snap.at > RESUME_MS || snap.raidId !== raidId) {
        if (snap.baseKey) { try { outposts.releaseOwner(snap.baseKey); } catch { /* */ } }
        return false;
    }
    Object.assign(socket, snap.sock);
    // the base kept for this raid follows the player onto the new socket;
    // onHumanJoin rebinds it to the new body (ownerId, banner team, colour)
    if (snap.baseKey) { try { outposts.rekeyOwner(snap.baseKey, "s:" + socket.id); } catch { /* */ } }
    const newKey = "s:" + socket.id;
    const old = snap.statKey ? raidStats.get(snap.statKey) : null;
    if (old && snap.statKey !== newKey) { raidStats.delete(snap.statKey); old.key = newKey; raidStats.set(newKey, old); }
    socket._resume = snap;
    return true;
}
function applyPendingResume(socket) {
    const body = socket && socket.player && socket.player.body;
    const rs = socket && socket._resume;
    if (!rs || !body) return;
    socket._resume = null;
    applyResume(body, rs);
}
function applyResume(body, snap) {
    const socket = body.socket;
    try {
        if (snap.alive && snap.defs && snap.defs.length) {
            // define() appends to the upgrade menu, and the fresh body was
            // just defined as the spawn class: without this a resumed Twin
            // was offered Basic's whole tree again (and on mobile the stale
            // menu kept the stat bars hidden). entity.upgrade() does the same.
            body.upgrades = [];
            body.define(snap.defs.length === 1 ? snap.defs[0] : snap.defs);
            if (snap.skillRaw) { body.skill.set(snap.skillRaw); body.skill.points = snap.points | 0; }
            body._modSkillGiven = snap.modSkill || body._modSkillGiven;
            body.refreshBodyAttributes();
            if (body.syncSkillsToGuns) body.syncSkillsToGuns();
            // back where you were, unless that spot is now rock or storm
            // back where you were: out of the rock if you were pressed into
            // it, but not back into the storm (you keep the fresh spawn then)
            let inStorm = false;
            try { inStorm = storm.inStorm(snap.x, snap.y); } catch { /* */ }
            if (!inStorm) {
                let x = snap.x, y = snap.y;
                try {
                    const tg = global.gameManager.terrainGrid;
                    if (tg && tg.pointInRock && tg.pointInRock(x, y)) { const o = openGroundNear(tg, x, y); x = o.x; y = o.y; }
                } catch { /* */ }
                moveTo(body, x, y);
            }
            body.health.amount = body.health.max * Math.max(0.25, Math.min(1, snap.hp || 1));
            // freshRaidBody shielded this body like a new spawn; a resume
            // keeps the old life's shield state (and what was left of its grace)
            body.invuln = !!snap.shielded;
            body.spawnGraceUntil = snap.shielded ? now() + Math.min(SPAWN_GRACE_MS, snap.graceLeft | 0) : 0;
            body.botGraceUntil = (snap.botGraceLeft | 0) > 0 ? now() + (snap.botGraceLeft | 0) : 0;
            body.botNewbie = !!snap.botNewbie;
            body.carriedGems = snap.carried | 0;
            try { dustHooks.restore(body, snap.dustCarried | 0); } catch { /* */ }
            try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
            const st = shop.stateOf(socket);
            if (st && st.arm) { try { shop.attachSidearm(body, st.arm); } catch { /* */ } }
        }
        body.bankedGems = socket.gemBanked || 0;
        try { shop.applyPassives(body); shop.talkState(socket); gems.talkGems(body, 0); } catch { /* */ }
        ensureStat(body);
        try { body.sendMessage("Reconnected. Your raid picked up where you left off."); } catch { /* */ }
        if (process.env.RESUME_DEBUG) console.log('[RESUME] applied: banked', socket.gemBanked | 0, 'carried', body.carriedGems | 0, 'drill', (shop.stateOf(socket) || {}).drill, 'class', (body.defs || []).join('/'), 'raw', body.skill.raw.join(','), 'pts', body.skill.points, 'pos', Math.round(body.x) + ',' + Math.round(body.y), 'was', Math.round(snap.x) + ',' + Math.round(snap.y));
    } catch (e) { console.error('[RAID] resume failed', e && e.message); }
}

// A dropped owner's base is held under snap.baseKey for as long as the
// resume that carries it could still be claimed (outposts.tick asks).
let baseResvSeq = 0;
function baseReserved(key) {
    if (!key) return false;
    const t = now();
    for (const v of resumeStore.values()) {
        if (v.baseKey === key) return t - v.at <= RESUME_MS && v.raidId === raidId;
    }
    return false;
}

function markHumanDeath(socket) {
    if (socket) socket.lastRaidDeathAt = now();
}

function disconnectCleanup(socket, body) {
    if (!Config.dig_royale) return;
    let snap = null;
    const leaving = !!(socket && socket.leftOnPurpose);
    if (leaving) {
        // menu / Home / another tab took over: nothing to come back to
        try { for (const k of resumeKeysFor(socket)) resumeStore.delete(k); } catch { /* */ }
    } else {
        try { snap = saveResume(socket, body); } catch (e) { console.error('[RAID] resume save failed', e && e.message); }
    }
    // an open ranked life settles as a disconnect if nobody resumes it
    // (at once when they left on purpose)
    try {
        const ls = raidStats.get(body ? statKeyFor(body) : "s:" + (socket && socket.id));
        rankHooks.onDisconnect(socket, ls, leaving);
    } catch (e) { guardLog('rank disconnect', e); }
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
            // a raid saved for resume keeps its base (dead or alive, as a
            // connected owner's claim survives death); anything else frees it
            const key = "s:" + socket.id;
            if (snap && snap.raidId === raidId && outposts.rekeyOwner) {
                snap.baseKey = "r:" + (++baseResvSeq);
                outposts.rekeyOwner(key, snap.baseKey);
            } else if (!(Config.royale_duos && handBaseToMate(key, socket))) {
                outposts.releaseOwner(key);
            }
        }
    } catch { /* */ }
}

// Duos: a base whose owner is gone for good goes to their partner instead of
// back to neutral. -> true when a partner took it
function handBaseToMate(key, socket) {
    const ms = duo.mateSocket(socket);
    if (!ms || ms.terminated) return false;
    const to = "s:" + ms.id;
    if (!outposts.rekeyOwner(key, to)) return false;
    const mb = ms.player && ms.player.body;
    if (mb && !mb.isDead?.()) { try { outposts.rebindOwner(to, mb); } catch { /* */ } }
    try { if (mb) mb.sendMessage("The base is all yours now."); } catch { /* */ }
    return true;
}

// The base occupy clock: per site, or per site and tank on the duo server
// (both partners stand on the same base)
function occKey(site, body) { return Config.royale_duos && body ? site.id + ':' + body.id : site.id; }

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
            const own = !!ownerId && outposts.isOwner(site, body);
            if (body._baseExpel === site) {
                // being shoved off: keep shoving until the hull is clear, then
                // the lockout starts and the rim becomes a wall
                if (pushOut(body, site, 6, "camp:" + site.id, 'expel')) {
                    body._baseExpel = null;
                    occupy.delete(occKey(site, body));
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
                occupy.delete(occKey(site, body));
                const n = (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
                parkOutside(site, body, n);
                continue;
            }
            if (ownerId && !own && touching) {
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
            if (own && lockedUntil > t && touching) {
                const n = (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
                parkOutside(site, body, n);
                if (body.socket) body.socket.talk('RYO', site.id, 0, Math.ceil((lockedUntil - t) / 1000));
                continue;
            }
            if (own && inside) {
                let rec = occupy.get(occKey(site, body));
                if (!rec || rec.ownerId !== body.id || ((rec.leftAt || 0) && t - rec.leftAt > 5000)) {
                    rec = { ownerId: body.id, enteredAt: t, leftAt: 0 };
                    occupy.set(occKey(site, body), rec);
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
            } else if (own && !inside) {
                const rec = occupy.get(occKey(site, body));
                if (rec && rec.ownerId === body.id) {
                    if (!rec.leftAt) {
                        rec.leftAt = t;
                        if (body.socket) {
                            try { body.socket.talk('RYO', site.id, 0, 0); } catch { /* */ }
                        }
                    }
                    else if (t - rec.leftAt > 5000) occupy.delete(occKey(site, body));
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
    const denied = !outposts.isOwner(site, body) ||
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
    if (Config.royale_duos) { try { duo.newRaid(); } catch (e) { guardLog('duo new raid', e); } }
    try { rankHooks.onRaidStart(); } catch (e) { guardLog('rank raid start', e); }
    shopRewardCount = new Map();
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
        // everyone went down at the raid end: the first spawn of the new raid
        // is a fresh start (starter gems, full drill), not a death respawn
        client.lastRaidDeathAt = 0;
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
        const placed = new Set();
        for (const body of combatants()) {
            let hole = null;
            // duos: the second partner lands beside the first
            if (Config.royale_duos) {
                const mate = duo.mateBody(body);
                if (mate && placed.has(mate)) hole = spotNearMate(body, mate, true);
            }
            if (!hole) hole = safeSpawnSpot(body, !body.socket);
            placed.add(body);
            moveTo(body, hole.x, hole.y);
            respecForNewRaid(body);
            freshRaidBody(body);
            giveStarterKit(body, false);
            try { shop.applyPassives(body); } catch { /* */ }
            const rs = ensureStat(body);
            if (body.socket) { try { rankHooks.lifeStart(body, rs); } catch (e) { guardLog('rank life', e); } }
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
    // duos: the results are team rows ("Alex & Sam", combined score) and
    // both partners get their team's placement bonus
    const top = Config.royale_duos
        ? teamRows(board).slice(0, 10).map(t => ({ id: t.ids[0], ids: t.ids, name: t.names.join(" & "), score: t.score, kills: t.kills, gems: t.gems, place: t.place, bot: t.bot, alive: t.alive }))
        : board.slice(0, 10);
    const bonuses = [500, 350, 250, 180, 140, 110, 90, 70, 50, 40];
    for (let i = 0; i < top.length; i++) {
        const row = top[i];
        const ids = row.ids || [row.id];
        for (const client of connectedClients()) {
            const key = client.id ? "s:" + client.id : null;
            const s = key ? raidStats.get(key) : null;
            if (s && ids.includes(s.id)) {
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
    // ranked: every open life settles now (the carried half counts), then the
    // placement bonus; all before the mass death below
    try { rankHooks.onRaidEnd(); } catch (e) { guardLog('rank raid end', e); }
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
                dustHooks.zero(body);          // unbanked dust ends with the raid
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
                client.gemDeposited = 0;
            }
            for (const body of combatants()) {
                body.carriedGems = 0;
                dustHooks.zero(body);
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
    // never over a sidearm the player paid for (buy() clears _twistArm)
    if (mod.freeArm && (!st.arm || st._twistArm)) { shop.grantArm(body.socket, mod.freeArm, true); st._twistArm = mod.freeArm; }
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
    // coalesced DU packets and the 5 s dust flush (accounts)
    guard('accounts', () => rankHooks.tick(t));
    if (Config.royale_duos) guard('duos', () => { duo.tick(t); tickTeamBots(t); });
    // everyone is down between raids: no storm, bosses, chests or bots, just
    // keep the HUD fed (results panel, countdown)
    if (raidEnding) {
        if (t - (tick._broadcastAt || 0) >= 500) { tick._broadcastAt = t; guard('broadcast', () => broadcast()); }
        return;
    }
    // Every stage is isolated: one bad stage must never take the raid
    // broadcast (and with it the whole HUD) down with it.
    guard('storm', () => { storm.ensureActive(); storm.tickDamage(t); });
    guard('spawn rescue', () => tickSpawnRescue(t));
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
            // a stat with an open ranked life (a disconnect waiting out its
            // resume window) stays until that life settles
            if (!s.alive && !s.lifeOpen && t - (s.lastSeen || 0) > 5 * 60 * 1000) raidStats.delete(k);
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
    try { fn(); } catch (e) { guardLog(label, e); }
}
function guardLog(label, e) {
    const t = Date.now();
    if (t - (guardLogAt.get(label) || 0) > 10000) {
        guardLogAt.set(label, t);
        console.error('[RAID] ' + label + ' failed:', e && e.stack || e);
    }
}

// What the ranked hooks may read of the raid.
rankHooks.attach({
    stats: () => raidStats,
    clients: connectedClients,
    raidId: () => raidId,
    board: boardOrder,
    resumeMs: RESUME_MS,
    // the duo server books its lives apart (Config is set before any raid)
    get serverId() { return Config.royale_duos ? 'duo' : 'royale'; },
    live: () => !raidEnding,
});
// entity.contemplationOfMortality calls this when a real player takes damage
// (ranked damage points; rank-only, not on the board)
global.royaleOnPlayerDamage = (victim, dealt, inflictors) => {
    if (!Config.dig_royale || raidEnding) return;
    try { rankHooks.onPlayerDamaged(victim, dealt, inflictors); } catch (e) { guardLog('rank damage', e); }
};

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
    lobbyPos, tick, onBanked, onCapture, FILL_CAP, stormLocked, boardSnapshot, scoreOf, baseWall, claimResume, applyPendingResume, baseReserved,
    onBossSpawned, onBossDead, onChestOpened, onBloom, onEvent, onShopBuy, fxAt, callout, QUESTS,
    FIRST_MINUTES, isNewPlayer,
    // ROYALE_DEBUG only (sockets.js DBG): force a twist, end the raid now
    debugTwist: (id) => applyNewTwist(id), debugEndRaid: () => { raidEndsAt = now(); },
    // DBG spawnaudit [n] [trap|reset]: the spawn audit so far, after `n` extra
    // safeSpawnSpot picks (bot/human alternating); 'trap' first plants 40
    // gem-ringed pockets and 40 about-to-close mined cells in the zone
    debugSpawnAudit: (n, mode) => {
        if (mode === 'reset') { spawnLog.n = 0; spawnLog.enclosed = 0; spawnLog.byKind = {}; spawnLog.byReason = {}; spawnLog.recent = []; spawnRescue.n = 0; spawnRescue.cells = 0; }
        let traps = 0;
        if (mode === 'trap') traps = debugPlantTraps(40);
        const t0 = Date.now();
        for (let i = 0; i < Math.min(2000, n | 0); i++) safeSpawnSpot(null, i % 2 === 0);
        return { traps, ms: Date.now() - t0, reach: FIRST_MINUTES.SPAWN_REACH, n: spawnLog.n, enclosed: spawnLog.enclosed, byKind: spawnLog.byKind, byReason: spawnLog.byReason, rescues: spawnRescue, storm: Math.round(storm.snapshot(now()).r), recent: spawnLog.recent.slice(-5) };
    },
    debugRaidLeft: (sec) => { if (!raidEnding && raidResults === null) raidEndsAt = now() + Math.max(1, sec | 0) * 1000; },
};
