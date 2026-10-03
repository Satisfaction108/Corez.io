const storm = require('../../terrain/storm.js');
const vault = require('../../terrain/vault.js');
const outposts = require('../../terrain/outposts.js');
const gems = require('../../terrain/gems.js');
const shop = require('../../terrain/shop.js');
const chests = require('../../terrain/chests.js');
const padGeom = require('../../terrain/padGeom.js');
const bosses = require('../../terrain/bosses.js');
const botRoster = require('../../terrain/botRoster.js');
const blooms = require('../../terrain/blooms.js');
const raidEvents = require('../../terrain/raidEvents.js');
const raidMods = require('../../terrain/raidMods.js');
const spawnReach = require('../../terrain/spawnReach.js');
const growth = require('../../terrain/growth.js');
const contracts = require('../../terrain/contracts.js');   // one short job per player at a time
const pacing = require('../../terrain/pacing.js');         // a notable beat every 60-90 s
const botDiff = require('../../../miscFiles/botDifficulty.js');
// entity.js reads the growth perks through this (refreshBodyAttributes, fov)
global.royaleGrowth = growth;
// ranked lives + gemdust (accounts); every call below is guarded
const rankHooks = require('../../../accounts/game/rankHooks.js');
const dustHooks = require('../../../accounts/game/dustHooks.js');
const progressHooks = require('../../../accounts/game/progressHooks.js');   // daily quests + achievements
// duos (only does anything on the duo server: Config.royale_duos)
const duo = require('../../duo/duoRaid.js');
const activity = require('../../network/activity.js');
// the persistent bank (checkout, checkpoints, release) and save codes
const bank = require('../../terrain/bank.js');
const saveCodes = require('../../terrain/saveCodes.js');
const hunted = require('../../terrain/hunted.js');         // big carriers are marked on every map
const coreFinale = require('../../terrain/coreFinale.js'); // the last storm's objective
const rattler = require('../../terrain/rattler.js');       // a new player's first chase
const dropIn = require('../../terrain/dropIn.js');         // meteor landings, first spawn near a vault
const supplyDrops = require('../../terrain/supplyDrops.js'); // crates out of the sky every minute or so
const raidOpening = require('../../terrain/raidOpening.js'); // early ore and the 1:30 meteor rush

// A raid is RAID_CYCLES storm cycles (7 min each, twists included), 21 min,
// and ends as the last storm shuts (storm.js closes the final circle).
const RAID_CYCLES = 3;
const RAID_MS = RAID_CYCLES * storm.CYCLE_MS;
storm.setCycles(RAID_CYCLES);
// Raid size including humans: a solo player gets 5 bots, and each real
// player who joins takes a bot's place. The duo server holds one more, so a
// party of two still meets 5 bots (two of them a bot duo).
// ROYALE_FILL_CAP (ROYALE_DEBUG only): a bigger raid for load tests
// a solo raid tops up to 5 fighters (you and 4 bots); duos to 6 (a pair and 4)
const FILL_CAP = process.env.ROYALE_DEBUG && +process.env.ROYALE_FILL_CAP > 0 ? +process.env.ROYALE_FILL_CAP : 5;
const DUO_FILL_CAP = 6;
function fillCap() { return Config.royale_duos ? DUO_FILL_CAP : FILL_CAP; }
const OCCUPY_MS = 10_000;
const LOCKOUT_MS = 10_000;
const KILL_VERBS = ["killed", "slaughtered", "demolished", "wrecked", "ended", "cooked"];
// Every death waits this long before the next drop, measured here from the
// death itself; the death card needs it to show (sockets.js spawn loop).
const RESPAWN_MS = 3000;
const WEAK_DRILL_MS = 30_000;
const STARTER_GEMS = 75;
const SPAWN_GRACE_MS = 5000;   // spawn shield holds this long even if you move

// ── First minutes ─────────────────────────────────────────────────────────
// Every knob for the late-joiner / new-player experience: where a fresh
// spawn lands, how long bots leave it alone, how crowded the closing circle
// may get, and the "you joined late" note.
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
    SPAWN_REACH: process.env.SPAWN_REACH !== '0',   // SPAWN_REACH=0 turns the rule off (A/B)
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
    BOT_GRACE_BOT_MS: 12_000,     // a fresh bot, from other bots
    // Who is new: botDifficulty.newness, from total play time (account or
    // guest play_ms + this session) and lives started. Fully new = botNewbie.
    // Soft window (controllers.js botSoft): for the start of every life, and
    // every life of a new player, bots never start a fight with you, skip you
    // unless you come within SOFT_CLOSE_R or shoot them, and aim worse. The
    // window runs BOT_SOFT_MS for a new player, BOT_SOFT_SHORT_MS for anyone
    // else, in between while newness fades.
    BOT_SOFT_MS: 120_000,
    BOT_SOFT_SHORT_MS: 25_000,
    SOFT_CLOSE_R: 320,
    SOFT_HIT_MS: 4000,            // a bot you hit fights back for this long
    NEW_TARGET_PENALTY: 600,      // bots rank a soft player as if this much farther away
    NEW_MAX_HUNTERS: 1,           // bots that may aim at / chase one soft player at once
    MAX_HUNTERS: 2,               // ...and anyone else
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
    LATE_RAID_SEC: 180,
    LATE_STORM_SEC: 100,          // storm cycle seconds left (end of the squeeze + the hold)
    LATE_NOTE_MS: 7000,
};
try { storm.setLockMs(FIRST_MINUTES.STORM_LOCK_MS); } catch { /* */ }
const KILL_SCORE = 200;
// Streaks: STREAK_MARK_AT kills marks you on every minimap. Each kill past that pays
// more, and whoever ends you collects a shutdown bounty.
const STREAK_MARK_AT = 4;
const STREAK_BONUS_PER = 50;
const SHUTDOWN_PER_STREAK = 100;
// Growth: killing a grown tank pays this per 1x of size it had gained,
// from GIANT_BOUNTY_AT up (a 2.3x tank is worth 325 on top of the kill)
const GIANT_BOUNTY_AT = 1.5;
const GIANT_BOUNTY_PER = 250;

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
// The winner (both partners in duos) stays up, frozen and untouchable, for the
// victory lap everyone else watches; they go down this long before the next raid.
const WINNER_DOWN_LEAD_MS = 1500;
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
    // called several times per 16 ms tick; one list per tick is enough
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
        s = { key, since: now(), name: body.name || "Unnamed", kills: 0, banked: 0, holds: 0, carried: 0, alive: true, id: body.id, isBot: !!body.isBot, lastSeen: now(), revengeOn: null, revengeBonus: 0, extra: 0, streak: 0, bestStreak: 0, bossKills: 0, chests: 0 };
        raidStats.set(key, s);
        if (body.socket) dropStaleRowsOf(s, body.socket);
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
    // a restored satchel only ever shrinks (banked, spent, dropped)
    if ((s.restoredCarry | 0) > s.carried) s.restoredCarry = s.carried;
    return s;
}

// One board row per person. Rows are keyed by socket, so a rejoin from the
// menu or a new tab starts a new row; drop that person's disconnected rows
// (the rejoin is a fresh start).
function whoOf(socket) {
    if (socket.account && socket.account.id) return "a:" + socket.account.id;
    if (socket.guestId) return "g:" + socket.guestId;
    return null;
}
function dropStaleRowsOf(s, socket) {
    const who = whoOf(socket);
    s.who = who;
    if (!who) return;
    let live = null;
    try { live = new Set(connectedClients().map(c => "s:" + c.id)); } catch { return; }
    for (const [k, row] of raidStats) {
        if (row === s || row.who !== who || live.has(k)) continue;
        raidStats.delete(k);
    }
}

function killScore() { return Math.round(KILL_SCORE * raidMods.num('killScoreMult', 1)); }

function scoreOf(s) {
    // PTS = banked + kills + 50% carried + revenge/streak/boss/quest bonuses.
    return (s.banked | 0) + (s.kills | 0) * killScore() + Math.floor((s.carried | 0) / 2) + (s.revengeBonus | 0) + (s.extra | 0);
}

// What a restored save put on the board (saveCodes.js): its raid points,
// the part of its satchel banked since, and half of what is still carried.
// Shown on the board, never paid: placement (boardOrder, the next-raid head
// start) and rank leave it out.
function restoredOf(s) {
    return (s.restoredPts | 0) + (s.restoredBanked | 0) + Math.floor(Math.min(s.carried | 0, s.restoredCarry | 0) / 2);
}
function earnedOf(s) {
    return Math.max(0, scoreOf(s) - restoredOf(s));
}

function gemsOf(body) {
    const carried = (body.carriedGems || 0) | 0;
    const banked = body.socket ? ((body.socket.gemBanked || 0) | 0) : ((body.botBanked || 0) | 0);
    return carried + banked;
}

// The board order: score, then banked, then kills (stable, insertion order).
const boardCmp = (a, b) => (b.score - a.score) || (b.gems - a.gems) || (b.kills - a.kills);

// Every stat in board order, bots included: the raid placement bonus reads
// places from this. Points a restored save brought are not in it (earnedOf).
// -> [{s, score, gems, kills}]
function boardOrder() {
    const list = [...raidStats.values()]
        .map(s => ({ s, score: earnedOf(s), gems: Math.max(0, (s.banked | 0) - (s.restoredBanked | 0)), kills: s.kills | 0 }))
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
    // the fallen; a plain top-32-by-score cut would drop fresh spawns (score 0)
    // below dead high scorers and empty the Alive tab.
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

// Streakers at STREAK_MARK_AT+ kills are broadcast to every minimap.
function pingsSnapshot(bodyByKey) {
    const out = [];
    for (const [k, s] of raidStats) {
        if (!s.alive || (s.streak | 0) < STREAK_MARK_AT) continue;
        const b = bodyByKey.get(k);
        if (!b || b.isDead?.()) continue;
        const at = require('../../terrain/abilities.js').shownAt(b);     // smoke: where it went in
        out.push({ id: b.id, x: Math.round(at.x), y: Math.round(at.y), name: s.name || "Someone", streak: s.streak | 0 });
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
function callout(body, kind, text, pts, sub, dur) {
    try {
        if (!body || !body.socket) return;
        if (sub || dur) body.socket.talk('KC', String(kind), String(text), (pts | 0), String(sub || ""), dur | 0);
        else body.socket.talk('KC', String(kind), String(text), (pts | 0));
    } catch { /* */ }
}

// extra fields ride along (the Core's telegraph: how long, which attack)
function fxAt(x, y, kind, ...extra) {
    for (const client of connectedClients()) {
        try { client.talk('FX', Math.round(x), Math.round(y), String(kind), ...extra); } catch { /* */ }
    }
}

// A tank burst for everyone watching nearby; the victim draws its own.
const TANK_FX_RANGE = 2200;
function tankDeathFx(body) {
    if (!body || body.deathCause === "despawn") return;
    for (const client of connectedClients()) {
        if (client === body.socket) continue;
        const cam = client.camera;
        if (!cam || Math.abs(cam.x - body.x) > TANK_FX_RANGE || Math.abs(cam.y - body.y) > TANK_FX_RANGE) continue;
        try { client.talk('FX', Math.round(body.x), Math.round(body.y), "tankdead", body.id | 0); } catch { /* */ }
    }
}

function compass(x, y) {
    const a = Math.atan2(y, x);
    const dirs = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
    const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return Math.hypot(x, y) < 500 ? "the centre" : "the " + dirs[i];
}

// ── contracts / pacing hooks ─────────────────────────────────────────────
// A contract reward goes straight into the bank; the board counts it too
// (and with it growth).
function payGems(body, gemsN) {
    if (!body || !body.socket || !(gemsN > 0)) return;
    try {
        const cur = (body.socket.gemBanked || 0) | 0;
        gems.setBanked(body, cur + gemsN);
        const s = ensureStat(body);
        if (s) s.banked = (s.banked || 0) + gemsN;
        gems.talkGems(body, 0);
    } catch { /* */ }
}
function streakOfBody(body) {
    const k = statKeyFor(body);
    const s = k ? raidStats.get(k) : null;
    return s ? (s.streak | 0) : 0;
}
function scoreOfBody(body) {
    const k = statKeyFor(body);
    const s = k ? raidStats.get(k) : null;
    return s ? scoreOf(s) : 0;
}
contracts.attach({
    pay: (body, n) => payGems(body, n),
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
    isNew: (body) => !!body.botNewbie,
    streakOf: streakOfBody,
    keyOf: statKeyFor,
    bounty: () => pacing.current(),
    inRaid: () => !raidEnding,
});
pacing.attach({
    humans, fighters: () => combatants(), scoreOf: scoreOfBody, keyOf: statKeyFor,
    pay: (body, n) => payGems(body, n),
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
    announce: (text, feed) => { if (feed) pushFeed(feed); setToastAndSay(text, 6000); },
    fxAt: (x, y, kind) => fxAt(x, y, kind),
    live: () => !raidEnding && !!raidId,
    idle: (sock) => activity.inputIdleMs(sock) > contracts.IDLE_MS,
});
hunted.attach({
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
    feed: (entry) => pushFeed(entry),
});
function addPts(body, n) {
    const s = body ? ensureStat(body) : null;
    if (s && n > 0) s.extra = (s.extra | 0) + n;
}
function announceAll(kind, text, sub, dur, except) {
    for (const client of connectedClients()) {
        if (except && client.player && client.player.body === except) continue;
        try { client.talk('KC', String(kind), String(text), 0, String(sub || ""), dur | 0); } catch { /* */ }
    }
}
coreFinale.attach({
    humans, fighters: () => combatants(),
    announce: announceAll,
    feed: (entry) => pushFeed(entry),
    fxAt: (x, y, kind, ...extra) => fxAt(x, y, kind, ...extra),
    toast: (text, ms) => setToastAndSay(text, ms),
    payGems: (body, n) => payGems(body, n),
    // banked like a vault deposit (score, stats, quests, dust)
    bank: (body, n) => vault.creditBank(body, n),
    addPts,
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
});
rattler.attach({
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
    fxAt: (x, y, kind) => fxAt(x, y, kind),
    newness: (body) => body && body.socket ? newnessOf(body.socket, body) : 0,
    idleMs: (sock) => activity.inputIdleMs(sock),
});
supplyDrops.attach({
    humans, fighters: () => combatants(), clients: connectedClients,
    idle: (sock) => activity.inputIdleMs(sock) > contracts.IDLE_MS,
    live: () => !raidEnding && !!raidId,
    raidAge: (t) => t - raidStartAt,
    announce: (text, feed) => { if (feed) pushFeed(feed); setToastAndSay(text, 6000); },
    compass,
});
raidOpening.attach({
    humans, fighters: () => combatants(), compass,
    onEvent: (ev) => onEvent(ev),
    raidAge: (t) => t - raidStartAt,
    live: () => !raidEnding && !!raidId,
});
dropIn.attach({
    clients: connectedClients,
    live: () => !raidEnding,
    carve: (tg, x, y, r, zone) => carveSpawnPocket(tg, x, y, r, zone),
});

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
    const nextMs = raidEnding ? Math.max(0, Math.round(raidResultsAt + RAID_END_BEAT_MS + RAID_END_WAIT_MS - t)) : 0;
    const nextIn = Math.ceil(nextMs / 1000);
    const bossSnap = bosses.snapshot();
    const chestSnap = chests.snapshot();
    const bloomSnap = blooms.snapshot();
    const eventSnap = raidEvents.snapshot();
    const modSnap = raidMods.snapshot();
    const bountySnap = pacing.snapshot(t);
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
        boss: bossSnap, event: eventSnap, mod: modSnap, bounty: bountySnap, pings, hunt: hunted.snapshot(), core: coreFinale.snapshot(t), supply: supplyDrops.snapshot(t), results: raidResults, ending, nextIn, nextMs, ...extra,
    });
    for (const client of connectedClients()) {
        const key = client.id ? "s:" + client.id : null;
        const mine = key ? raidStats.get(key) : null;
        const myRow = mine ? board.find(r => r.id === mine.id) : null;
        const body = client.player && client.player.body;
        const bodyLive = body && !body.isDead?.();
        // whoever killed you last, marked for you (minimap, overhead, death screen)
        const revenge = contracts.revengeFor(client, bodyByKey, t);
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
                obj: bodyLive ? contracts.snapshotFor(client, body, t) : null,
                // dead: what you'll be doing when you drop back in
                next: bodyLive ? undefined : (client.contractNext || undefined),
                drill: shop.stateOf(client).drill | 0,
                scan,
                overdrive: bodyLive && body.overdriveUntil > t ? Math.ceil((body.overdriveUntil - t) / 1000) : 0,
                anchor: bodyLive && body.stormAnchorUntil > t ? Math.ceil((body.stormAnchorUntil - t) / 1000) : 0,
                // storm ramp while you're out in it: damage multiplier, 0 when safe
                sm: bodyLive && body._inStorm ? Math.round(storm.exposureOf(body, t).mult * 100) / 100 : 0,
                // raid over: the head start your placement bought for the next one
                nextGems: raidResults ? (client.raidBonus | 0) : undefined,
                // hunted: your mark and how many enemies are close
                hunt: bodyLive ? hunted.forClient(body) : undefined,
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

// Every placement lands inside the map, hull and all: past the edge there
// is no rock, only the storm (a big tank once landed out there).
function moveTo(body, x, y) {
    if (!body) return;
    body.x = x; body.y = y;
    body.velocity.x = 0; body.velocity.y = 0;
    body.accel.x = 0; body.accel.y = 0;
    const tg = global.gameManager.terrainGrid;
    const r = body.realSize || 60;
    keepOnMap(body);
    if (tg && tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(body, r, Math.max(48, r * 0.35));
    keepOnMap(body);
}
// slack: a resume may stay on the rim's open ground, just past the disk
function keepOnMap(body, slack = 0) {
    const tg = global.gameManager.terrainGrid;
    if (body && tg && tg.clampToPlay) tg.clampToPlay(body, tg.edgeMargin(body.realSize || 60), slack);
}
const RIM_SLACK = 140;

function openGroundNear(tg, x, y) {
    if (!tg || !tg.pointInRock) return { x, y };
    if (!tg.pointInRock(x, y)) return { x, y };
    // (off the map is "open" too: never there)
    const inside = (px, py) => !tg.inPlayArea || tg.inPlayArea(px, py, 60);
    for (let ring = 1; ring <= 8; ring++) {
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + ring * 0.3;
            const nx = x + Math.cos(a) * 60 * ring, ny = y + Math.sin(a) * 60 * ring;
            if (!tg.pointInRock(nx, ny) && inside(nx, ny)) return { x: nx, y: ny };
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
// Candidates are the drop pits plus open ground sampled inside the safe zone
// (the pits sit on a ring outside the plaza, so a closed storm excludes them
// all); the spot farthest from every threat (fights and bosses count as
// closer) wins.
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
    // threats above, and in a small circle their reservations would cover
    // every gap.
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
        const plain = (tg.plainRockHealth || 1) * ((global.royaleMods && global.royaleMods.rockHpMult) || 1);
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
// storm circle: the spots the reachability rule must never pick.
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
    const t = now(), plain = tg.plainRockHealth;
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

function giveStarterKit(body, isRespawn, noStarter = false) {
    if (!body) return;
    try { gems.initSatchel(body); } catch { /* */ }
    const bonus = body.socket ? ((body.socket.raidBonus || 0) | 0) : 0;
    if (body.socket) body.socket.raidBonus = 0;
    const starter = raidMods.num('starterGems', STARTER_GEMS);
    const grant = (isRespawn || noStarter ? 0 : starter) + bonus;
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
                        rock.maxHealth = tg.plainRockHealth * (ORE_HP[ORE.COPPER] || 1);
                        try { rock.deposits = tg._buildDeposits(rock); } catch { rock.deposits = null; }
                    }
                    rock.maxHealth = Math.max(10, rock.maxHealth * 0.35);
                    rock.health = Math.min(rock.health, rock.maxHealth);
                    // the clients hear about it: a copper rock they drew as plain
                    // rock looked like the landing had missed it
                    tg.rockEvents.push({ k: rock.k, h: rock.health / rock.maxHealth, d: 0, ore: rock.ore | 0, bl: 1 });
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
    // Second Wind: moving doesn't drop the shield for a while longer
    let windMs = 0;
    try { windMs = shop.spawnMoveShieldMs(body); } catch { /* */ }
    body.spawnMoveShieldUntil = windMs ? now() + windMs : 0;
    body.passive = false;
    body.royaleAlive = true;
    body.royaleBornAt = now();     // a kill inside 15 s of this pays nothing (ranked)
    body.deathCause = "";
    // bot grace (controllers.js sense / canInitiateFight / auto turrets):
    // bots leave a fresh spawn alone until this, or until it damages a bot
    // (game/index.js clears it); new players get longer and softer focus
    if (body.socket) {
        const n = newnessOf(body.socket, body);
        const fresh = n >= 1;
        body.botNewbie = fresh;
        body.botNewness = n;
        body.botGraceUntil = now() + (fresh ? FIRST_MINUTES.BOT_GRACE_NEW_MS : FIRST_MINUTES.BOT_GRACE_MS);
        body.botSoftMs = botDiff.lerp(FIRST_MINUTES.BOT_SOFT_SHORT_MS, FIRST_MINUTES.BOT_SOFT_MS, n);
        body.botSoftUntil = now() + body.botSoftMs;
        stampBotDifficulty(body);
    } else if (body.isBot) {
        // bots leave a fresh bot alone for a moment too, or a respawn walks
        // into the fight that killed it and never gets to grow
        body.botGraceUntil = now() + FIRST_MINUTES.BOT_GRACE_BOT_MS;
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
// Before this session: lives (guest games or account lives) and play time
// (play_ms in guests / user_stats), read once per socket. Unknown identity
// -> 0, asked again next time.
function careerRecord(socket) {
    if (!socket) return { lives: 0, ms: 0 };
    if (socket._careerLives !== undefined) return { lives: socket._careerLives, ms: socket._careerPlayMs || 0 };
    let row = null, known = false;
    try {
        const d = require('../../../accounts/db').handle();
        if (d) {
            if (socket.account && socket.account.id) {
                known = true;
                row = d.get('SELECT lives, play_ms AS ms FROM user_stats WHERE user_id = ?', socket.account.id);
            } else if (socket.guestId) {
                known = true;
                row = d.get('SELECT games AS lives, play_ms AS ms FROM guests WHERE guest_id = ?', socket.guestId);
            }
        }
    } catch { known = false; }
    if (!known) return { lives: 0, ms: 0 };
    socket._careerLives = row ? (row.lives | 0) : 0;
    socket._careerPlayMs = row ? Math.max(0, +row.ms || 0) : 0;
    return { lives: socket._careerLives, ms: socket._careerPlayMs };
}
function careerLives(socket) { return careerRecord(socket).lives; }
// Total time played: career, this session's finished lives, and the life
// `body` is in right now.
function playedMs(socket, body) {
    let ms = careerRecord(socket).ms + (socket._royalePlayMs || 0);
    if (body && body.royaleBornAt && body.royaleAlive !== false && !body.isDead?.()) ms += Math.max(0, now() - body.royaleBornAt);
    return ms;
}
// 1 brand new .. 0 not new (botDifficulty.newness). Lives started counts
// the one `body` is on, whether or not the spawn path has booked it yet.
function newnessOf(socket, body) {
    if (!socket) return 0;
    const lives = careerLives(socket) + (socket._royaleLives | 0) + (body && body._lifeCounted ? 0 : 1);
    return botDiff.newness(playedMs(socket, body), lives);
}
function isNewPlayer(socket, body) {
    return !!socket && newnessOf(socket, body) >= 1;
}
// How hard bots play against this player (miscFiles/botDifficulty.js has
// the whole mapping): new players 0, signed-in players by rank, guests and
// placement by this raid's score and kills or their time played, fading in
// from 0 as newness wears off. Stamped on the body at spawn and then about
// once a second; the rank comes from body.rankCode, which the accounts
// bridge already set at spawn, so nothing here touches the DB after the
// first read.
function stampBotDifficulty(body) {
    const socket = body && body.socket;
    if (!socket) return;
    const n = newnessOf(socket, body);
    body.botNewness = n;
    body.botNewbie = n >= 1;
    if (socket._botDiffPin != null) { body.botDifficulty = socket._botDiffPin; return; }
    const key = statKeyFor(body);
    const s = key ? raidStats.get(key) : null;
    const d = botDiff.forPlayer({
        newness: n,
        rankCode: body.rankCode | 0,
        score: s ? scoreOf(s) : 0,
        kills: s ? s.kills | 0 : 0,
        sessionBest: socket._botDiffBest || 0,
        playMs: playedMs(socket, body),
    });
    body.botDifficulty = d;
    if (!n && !(body.rankCode | 0) && d > (socket._botDiffBest || 0)) socket._botDiffBest = d;
}

// Humans taking part: alive, or dead and on their way back. Counting only
// live bodies would let a bot take a dead player's slot.
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
    // the last storm never trims the raid leader: the winner gets the victory lap
    let leaderKey = null;
    try { if (storm.isFinal()) { const top = boardOrder()[0]; leaderKey = top ? top.s.key : null; } } catch { /* */ }
    let best = null, bestScore = -Infinity, far = null, farD = -1;
    for (const b of bots) {
        if (t - Math.max(b._lastDamageAt || 0, b.hitAt || 0) < 5000) continue;   // mid-fight
        if (leaderKey && statKeyFor(b) === leaderKey) continue;
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

// `back`: a botRoster entry, the same bot coming back (same name, team and
// colour, tank, ability, board row); none for a brand new one.
function spawnRaidBot(back = null) {
    const handler = global.gameManager.gameHandler;
    if (!handler) return;
    // duos: two of the bots are a team (they spawn together and cover each other)
    const plan = Config.royale_duos && !back ? duo.botSpawnPlan(enemyBots()) : null;
    const hole = (plan && plan.near && spotNearMate(null, plan.near)) || safeSpawnSpot(null, true);
    // a team id nobody had this raid (stale board rows keep theirs). Solo too:
    // a plain random id can match a live body's and make the two a team
    const team = back && back.team != null ? back.team : plan ? plan.team : duo.freshTeamId();
    const life = back ? { familyId: back.familyId, nameKey: back.nameKey, respawnsRemaining: 0, tank: back.tank, ability: back.ability } : null;
    handler.spawnBots({ x: hole.x + (Math.random() - 0.5) * 40, y: hole.y + (Math.random() - 0.5) * 40 }, team, back ? back.name : null, life);
    const bot = handler.bots[handler.bots.length - 1];
    if (!bot) return;
    bot.team = team;
    if (back) {
        if (back.color != null) { bot.color.base = back.color; bot.leaderboardColor = back.color; bot.minimapColor = back.color; }
        if (back.skill != null) bot.botSkill = back.skill;
        if (back.temperament) bot.botTemperament = back.temperament;
        if (back.style) bot.botStyle = back.style;
    }
    if (plan) duo.linkBotDuo(bot, enemyBots());
    bot.botRespawnsRemaining = 0;
    bot.royaleAlive = true;
    bot.royaleBornAt = now();
    bot.botGraceUntil = now() + FIRST_MINUTES.BOT_GRACE_BOT_MS;
    bot.weakDrillUntil = 0;
    try { gems.initSatchel(bot); } catch { /* */ }
    try { bot.refreshBodyAttributes(); } catch { /* */ }
    try { grantTwist(bot); } catch { /* */ }
    ensureStat(bot);
    // bots fall out of the sky too
    guard('bot drop', () => dropIn.landBot(bot));
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
    // bots follow the players' rule: nobody (re)spawns in the storm's lock
    if (!canSpawn()) return;
    const cap = botCapNow(), alive = enemyBots().length;
    botRoster.trimTo(cap - alive);
    if (alive >= cap) return;
    // a death never refills on the spot
    if (!botRoster.mayFill(t)) return;
    lastFillAt = t;
    // the same bot back after its respawn delay; a new one only for a slot
    // nobody is waiting on
    const pick = botRoster.next(t);
    if (pick.entry) spawnRaidBot(pick.entry);
    else if (pick.fresh) spawnRaidBot();
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
    try { grantTwist(bot); } catch { /* */ }
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
    hunted.onBanked(body);
    // a first bank with no ability yet hands one out on trial
    guard('ability trial', () => require('../../terrain/abilities.js').onBanked(body, amount));
    const s = ensureStat(body);
    if (!s) return;
    s.banked = (s.banked || 0) + amount;
    // gems from a restored satchel bank like any others, but for the board
    // only: rank and placement leave them out (saveCodes.js)
    const r = Math.min(amount, s.restoredCarry || 0);
    if (r > 0) {
        s.restoredCarry -= r;
        s.restoredBanked = (s.restoredBanked || 0) + r;
        s.rankDiscount = (s.rankDiscount || 0) + r;
        if (s.lifeOpen) s.lifeBanked0 = (s.lifeBanked0 || 0) + r;
    }
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

// accounts/deaths.js: what killed a human, and how long that life lasted
function logDeath(body, cause, killer) {
    const socket = body.socket;
    require('../../../accounts/deaths.js').record({
        userId: socket.account && socket.account.id,
        guestId: socket.guestId,
        serverId: Config.royale_duos ? 'duo' : 'royale',
        cause,
        killerName: killer ? killer.name || killer.label : null,
        killerTank: killer ? killer.label : null,
        lifeMs: body.royaleBornAt ? now() - body.royaleBornAt : 0,
        lifeNo: socket._royaleLives | 0,
        newbie: !!body.botNewbie,
    });
}

function onCombatantDead(body) {
    if (!Config.dig_royale || !body) return;
    if (body.royaleAlive === false) return;
    body.royaleAlive = false;
    // a raid bot keeps its identity for a respawn (terrain/botRoster.js)
    if (body.isBot) body._botKeepName = botRoster.onBotGone(body, now(), body.deathCause);
    if (body.socket && body.royaleBornAt) body.socket._royalePlayMs = (body.socket._royalePlayMs || 0) + Math.max(0, now() - body.royaleBornAt);
    tankDeathFx(body);
    const key = statKeyFor(body);
    const s = key ? (raidStats.get(key) || ensureStat(body)) : null;
    const carriedAtDeath = body.socket && body.socket.gemDeathCarried !== undefined
        ? (body.socket.gemDeathCarried | 0) : (s ? (s.carried | 0) : 0);
    const victimStreak = s ? (s.streak | 0) : 0;
    const victimGrowth = growth.enabled() ? (body.growthMult || 1) : 1;
    let giantPts = 0;
    if (s) { s.alive = false; s.carried = 0; s.streak = 0; s.restoredCarry = 0; }
    // a density trim (despawnBot) is as quiet as the raid-end mass death
    const raidEndDeath = body.deathCause === "raidend" || body.deathCause === "despawn";
    const envKill = raidEndDeath || body.deathCause === "storm" || body.deathCause === "rock" || body.deathCause === "base" || body.deathCause === "core";
    const coreKill = body.deathCause === "core";
    // hunted: the mark comes off now; a killer below still cashes it
    const huntLevel = body.huntedLevel | 0;
    hunted.onDeath(body);
    let huntBounty = null;
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
        // your revenge target: a bonus and the REVENGE banner
        if (killerBody.socket && contracts.onKill(killerBody, body)) avenged = true;
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
            if (victimGrowth >= GIANT_BOUNTY_AT) {
                giantPts = Math.round(GIANT_BOUNTY_PER * (victimGrowth - 1) / 25) * 25;
                ks.extra = (ks.extra | 0) + giantPts;
                pts += giantPts;
            }
            const mark = shop.killBonus(killerBody);
            if (mark) { ks.extra = (ks.extra | 0) + mark; pts += mark; }
            huntBounty = hunted.onKill(killerBody, body, carriedAtDeath, huntLevel);
            if (huntBounty) {
                ks.extra = (ks.extra | 0) + huntBounty.pts;
                pts += huntBounty.pts;
                payGems(killerBody, huntBounty.gems);
            }
            if (avenged) {
                ks.revengeBonus = (ks.revengeBonus | 0) + contracts.REVENGE_PTS;
                pts += contracts.REVENGE_PTS;
                payGems(killerBody, contracts.REVENGE_GEMS);
            }
            // ranked kill filters (bot half, same victim, spawn kill) + kill dust
            try { rankHooks.onKillCredited(killerBody, ks, body, s, pts); } catch (e) { guardLog('rank kill', e); }
        }
        // the bounty (pacing.js) pays whoever takes the target down
        guard('bounty kill', () => pacing.onKill(killerBody, body));
        if (killerBody.socket) {
            let line = avenged ? "REVENGE" : huntBounty ? "BOUNTY CASHED" : shutdown ? "SHUTDOWN" : giantPts ? "GIANT DOWN" : "ELIMINATED";
            line += ": " + (body.name || "Unnamed");
            if (carriedAtDeath >= 300) line += "  (" + carriedAtDeath + " gems dropped)";
            callout(killerBody, avenged ? "revenge" : huntBounty ? "huntkill" : shutdown ? "shutdown" : "kill", line, pts,
                avenged ? "+" + contracts.REVENGE_GEMS + " gems" : huntBounty && huntBounty.gems ? "+" + huntBounty.gems + " bounty gems banked" : "");
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
        core: coreKill ? 1 : 0,
        revenge: avenged ? 1 : 0,
        boss: bossKill ? 1 : 0,
        loot: carriedAtDeath >= 300 ? carriedAtDeath : 0,
        streak: streakNow >= STREAK_MARK_AT ? streakNow : 0,
        shutdown: shutdown ? victimStreak : 0,
        pts,
        place: 0,
    });
    if (huntBounty && !raidEndDeath) pushFeed({ bounty: 1, by: killerBody ? (killerBody.name || "Unnamed") : "", name: body.name || "Unnamed", g: huntBounty.gems, l: huntBounty.level });
    // duos: your partner hears about it
    if (Config.royale_duos && body.socket && !raidEndDeath) {
        try {
            const mb = duo.mateBody(body);
            if (mb && mb.socket) mb.sendMessage((body.name || "Your teammate") + " is down. Hold on till they're back.");
        } catch { /* */ }
    }
    // contracts: the victim's job ends, and whoever took them down is marked
    // for them (revenge) when they come back
    if (body.socket && !raidEndDeath) guard('contracts death', () => contracts.onDeath(body, bossKill || envKill ? null : killerAny));
    if (body.socket) {
        // settle the ranked life now; its RK follows the death packet (a
        // raid-end death was settled at endRaid, so this skips it)
        try { rankHooks.onDeath(body, s); } catch (e) { guardLog('rank death', e); }
        if (!raidEndDeath) {
            try { logDeath(body, stormKill ? 'storm' : bossKill ? 'boss' : killerAny ? (killerAny.isBot ? 'bot' : killerAny.isPlayer ? 'player' : 'other') : 'other', killerAny); } catch (e) { guardLog('death log', e); }
        }
        const dl = shop.onDeath(body);
        body.socket.raidDeathStreak = victimStreak;
        body.socket.raidDeathDrillLost = dl && dl.drillLost ? 1 : 0;
        // a raid-end death respawns with everyone when the next raid starts
        const wait = raidEndDeath ? Math.max(0, raidResultsAt + RAID_END_BEAT_MS + RAID_END_WAIT_MS - now()) : RESPAWN_MS;
        body.socket.royaleRespawnAt = now() + Math.max(RESPAWN_MS, wait);
        body.socket.royaleNeedClick = false;
        body.socket.status.readyToSpawn = true;
        // the death card is only up for the wait: send its revenge mark and
        // next contract on the next tick instead of up to 500 ms later (not
        // during the raid-end mass death, which has its own broadcasts)
        if (!raidEndDeath) tick._broadcastAt = 0;
    }
}

// ── bosses / chests / blooms / events callbacks ───────────────────────────
function onBossSpawned(o, kind, id) {
    pacing.note('boss');
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
    pacing.note('bossdead');
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
        guard('contracts chest', () => contracts.onChestOpened(body, chest));
        try { progressHooks.onChest(body); } catch (e) { guardLog('progress chest', e); }
        const text = (chest.supplyDrop ? "Supply drop cracked open" : chest.chestRare ? "Epic chest cracked open" : "Copper chest cracked open") + (itemMsg ? ". " + itemMsg : "");
        callout(body, "chest", text, chest.chestGems | 0);
    }
    if (chest.chestRare) pushFeed({ chest: 1, name: body.name || "Unnamed", rare: 1 });
    fxAt(chest.x, chest.y, chest.chestRare ? "chestrare" : "chest");
}

function onBloom(b) {
    pacing.note('bloom');
    pushFeed({ bloom: 1, name: compass(b.x, b.y) });
    setToastAndSay("Ore bloom in " + compass(b.x, b.y) + ". Rich veins for 100 seconds.", 6000);
    fxAt(b.x, b.y, "bloom");
}

function onEvent(ev) {
    pacing.note(ev.kind);
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
    guard('contracts shop', () => contracts.onShopBuy(body, item));
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
    // a reload: `keepSpot` puts the tank back where it was (something to
    // protect, see saveResume); a `fresh` one drops in somewhere new like a
    // spawn, without a new life, starter gems or a reset idle clock
    const resumeSnap = (body.socket && body.socket._resume) || null;
    const keepSpot = !!(resumeSnap && resumeSnap.alive);
    const freshDrop = !!(resumeSnap && resumeSnap.fresh);
    // the first spawn on this socket brings the persistent bank in (a resume
    // brought its own in the snapshot)
    let bankIn = 0;
    if (body.socket && !body.socket._bankOut) guard('bank checkout', () => { bankIn = bank.checkOut(body.socket); });
    // size first: every placement below pushes the hull out of rock by it
    guard('growth spawn', () => growth.onSpawn(body, growthScore(body)));
    // duos: next to your partner if they're alive and not in a fight; that
    // beats the base (which is shared anyway) and a random safe spot
    let mateSpawn = false;
    if (Config.royale_duos) duo.watchHits(body);
    if (Config.royale_duos && !keepSpot) {
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
        // a new player who has not banked yet lands near a vault (dropIn.js)
        let near = null;
        if (body.socket && !keepSpot && isNewPlayer(body.socket, body) && !hunted.bankedThisRaid(body)) {
            try { near = dropIn.vaultSpot(body, combatants()); } catch (e) { guardLog('first vault spot', e); }
        }
        // everyone else: near the action if there's a good spot (dropIn.js)
        if (!near && body.socket && !keepSpot && !isNewPlayer(body.socket, body)) {
            try { near = dropIn.actionSpot(body, combatants()); } catch (e) { guardLog('action spot', e); }
        }
        const hole = near || safeSpawnSpot(body);
        moveTo(body, hole.x + (Math.random() - 0.5) * 30, hole.y + (Math.random() - 0.5) * 30);
    }
    // never leave a fresh body inside rock: the terrain loop would crush or
    // relocate it a moment later (a second teleport on spawn)
    try {
        const tgJ = global.gameManager.terrainGrid;
        if (tgJ && tgJ.pointInRock && tgJ.pointInRock(body.x, body.y)) {
            const o = openGroundNear(tgJ, body.x, body.y);
            moveTo(body, o.x, o.y);
        }
    } catch { /* */ }
    // a grown respawn needs more room than a spawn pocket gives
    guard('growth room', () => growRoom(body, true));
    keepOnMap(body);
    freshRaidBody(body);
    // a resumed player already had their starter kit: no second one
    const resuming = keepSpot;
    if (!resuming) giveStarterKit(body, isRespawn, freshDrop);
    // the meteor landing: rock smashed around you, gems on your first drop
    // (a fresh reload drop gets the big fall and crater, but no ore seeded)
    if (!resuming) guard('drop in', () => freshDrop ? dropIn.land(body, 0, now(), { big: true })
        : dropIn.land(body, dropIn.spillFor(!isRespawn, !!body.socket && isNewPlayer(body.socket, body))));
    if (!resumeSnap && body.socket) activity.resetClock(body.socket, now());
    try { shop.applyPassives(body); } catch { /* */ }
    // full dash charges every life, and the HUD hears about the ability slot
    guard('abilities spawn', () => require('../../terrain/abilities.js').onSpawn(body));
    const joinStat = ensureStat(body);
    // a ranked life opens here; a resume keeps the one already open
    try { rankHooks.lifeStart(body, joinStat); } catch (e) { guardLog('rank life', e); }
    if (body.socket) {
        body.socket.royaleEliminated = false;
        body.socket.royalePlace = 0;
        body.socket.royaleNeedClick = false;
        body.socket.lastRaidDeathAt = 0;
        body.socket.freeCam = false;
        // the first contract rolls in a moment, with the "Drop in!" cue
        guard('contracts spawn', () => contracts.onSpawn(body));
        if (resuming) body.socket._dropCue = false;
        if (isRespawn && (body.growthMult || 1) >= 1.1) {
            const capped = growthScore(body) * growth.RESPAWN_SHARE > growth.CAP_SCORE + 1;
            try { body.sendMessage("You're back at " + fmtGrow(Math.round(body.growthMult * 10) / 10) + " size" + (capped ? ", the most a respawn gives." : ", from a quarter of your score.")); } catch { /* */ }
        }
        if (bankIn > 0) {
            try { body.sendMessage("You brought " + bankIn.toLocaleString('en-US') + " banked gems. Spend them at a shop. Only gems you bank this raid count for score."); } catch { /* */ }
        }
        if (!isRespawn && !resumeSnap) {
            try { chests.ensureNearSpawn(body); } catch { /* */ }
            const mod = raidMods.get();
            try {
                body.sendMessage("You're shielded for " + Math.round(SPAWN_GRACE_MS / 1000) + " seconds, and after that until you move or shoot.");
                if (!mod) body.sendMessage("No override this raid, for once.");
            } catch { /* */ }
        }
        try { shop.talkState(body.socket); } catch { /* */ }
        // this life counts toward "new player" from the next spawn on
        if (!resumeSnap) body.socket._royaleLives = (body.socket._royaleLives | 0) + 1;
        body._lifeCounted = true;
        try { lateJoinNote(body); } catch { /* */ }
        // the resume itself waits for sockets.initalizePlayer to finish the
        // level-45 fill, or those level-up points would land on top of the
        // restored build (applyPendingResume)
    }
}

// ── reconnect / resume ────────────────────────────────────────────────────
// After a dropped connection (proxy reload, wifi blip, refresh, a laptop lid
// the heartbeat in sockets.js caught) the tank leaves the world at once, and
// if the client reconnects with the same per-tab token within RESUME_MS the
// new socket inherits the old one's bank, shop, score and tank. Carried gems
// only come back if nothing hit you for RESUME_SAFE_MS, so pulling the plug
// is not a way out of a losing fight. An idle kick never saves one.
// ROYALE_RESUME_MS shortens the window for local tests (ROYALE_DEBUG only).
const RESUME_MS = (process.env.ROYALE_DEBUG && parseInt(process.env.ROYALE_RESUME_MS, 10) > 0)
    ? parseInt(process.env.ROYALE_RESUME_MS, 10) : 45_000;
const RESUME_SAFE_MS = 8000;
// A reload only keeps the tank where it was when there's something to
// protect: this many gems carried on top of the starter gems everyone drops
// in with, a fight in the last RESUME_COMBAT_MS (hurt
// or hurting), or a hunted mark. Otherwise it's a fresh drop somewhere new
// (same build, bank, shop and raid), which also stops the "always the same
// spot" reload.
const RESUME_KEEP_GEMS = 50;
const RESUME_COMBAT_MS = 10_000;
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
// A snapshot leaving the store unclaimed takes its bank back to the
// persistent store (the lease is in snap.sock).
function releaseSnapBank(snap) {
    if (snap && snap.sock && snap.sock._bankLease) guard('bank release', () => bank.release(snap.sock));
}
function dropResume(k, v) {
    resumeStore.delete(k);
    for (const x of resumeStore.values()) if (x === v) return;
    releaseSnapBank(v);
    releaseSnapColor(v);
}
// While a resume waits, nobody else is handed its colour (solo; the duo
// book holds team colours on its own).
function holdSnapColor(snap) {
    if (Config.royale_duos || !snap || snap.team == null || snap.color == null || !global.royaleHeldTeamColors) return;
    global.royaleHeldTeamColors.set(snap.team, snap.color);
    snap._colorHeld = true;
}
function releaseSnapColor(snap) {
    if (!snap || !snap._colorHeld || !global.royaleHeldTeamColors) return;
    snap._colorHeld = false;
    if (global.royaleHeldTeamColors.get(snap.team) === snap.color) global.royaleHeldTeamColors.delete(snap.team);
}
function tickResumeExpiry(t) {
    for (const [k, v] of resumeStore) {
        // (a base it held goes the usual way: outposts.tick sees baseReserved
        // turn false and frees it, or hands it to a duo partner)
        if (t - v.at > RESUME_MS || v.raidId !== raidId) dropResume(k, v);
    }
}
function heldBanks() {
    const out = [];
    for (const v of resumeStore.values()) if (v && v.sock && v.sock._bankLease && !out.includes(v.sock)) out.push(v.sock);
    return out;
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
        // the claimed snapshot's lease stays with it (see below)
        if (again.sock && again.sock._bankLease === socket._bankLease) socket._bankLease = null;
        return again;
    }
    for (const [k, v] of resumeStore) if (t - v.at > RESUME_MS) dropResume(k, v);
    // a dead player has no body but still has a bank, a shop and a score
    const alive = !!body && !body.isDead?.() && body.royaleAlive !== false && !body.royaleLobby;
    const hitAgo = body ? Math.min(t - (body._lastDamageAt || 0), Date.now() - (body.hitAt || 0)) : 0;
    const snap = {
        at: t, raidId, statKey: body ? statKeyFor(body) : "s:" + socket.id, alive,
        keys, accountId: (socket.account && socket.account.id) || null,
        // the same team id and colour come back with the tank (resumeTeam)
        team: body ? body.team : null, color: body && body.color ? body.color.base : null,
        sock: {
            gemBanked: socket.gemBanked || 0, shop: socket.shop || null, revenge: socket.revenge || null,
            // the bank's lease rides along: a reconnect keeps the same gems
            // and never checks out a second time (bank.js)
            _bankOut: !!socket._bankOut, _bankLease: socket._bankLease || null, _bankOwner: socket._bankOwner || null,
            bankKept: socket.bankKept | 0, _bankSavedAt: socket._bankSavedAt || 0,
            raidBonus: socket.raidBonus || 0, raidPB: socket.raidPB || 0, _milestoneIdx: socket._milestoneIdx || 0,
            gemDeposited: socket.gemDeposited || 0,
            // duos: who you are to the team book (a reconnect keeps the team)
            duoKey: socket.duoKey || null, duoPid: socket.duoPid || null, duoMates: socket.duoMates || null,
            duoFill: socket.duoFill !== false, _duoJoinSent: !!socket._duoJoinSent,
            raidDeathStreak: socket.raidDeathStreak || 0, royaleRespawnAt: socket.royaleRespawnAt || 0,
            lastRaidDeathAt: socket.lastRaidDeathAt || 0,
            _royaleLives: socket._royaleLives || 0, _lateNoteKey: socket._lateNoteKey || "",
            // the idle clock: a reconnect is not input
            lastInputAt: socket.lastInputAt || 0, _idleFrom: socket._idleFrom || 0, _chatAt: socket._chatAt || 0,
            _aimX: socket._aimX, _aimY: socket._aimY, _inBits: socket._inBits,
            // time played so far, the life cut short by the drop included
            _royalePlayMs: (socket._royalePlayMs || 0) + (alive && body.royaleBornAt ? Math.max(0, t - body.royaleBornAt) : 0),
        },
        carried: 0,
    };
    if (alive) {
        const lastFight = Math.max(body._lastDamageAt || 0, body.hitAt || 0, body._dealtAt || 0);
        const keepGems = raidMods.num('starterGems', STARTER_GEMS) + RESUME_KEEP_GEMS;
        const keep = (body.carriedGems | 0) >= keepGems || t - lastFight < RESUME_COMBAT_MS || (body.huntedLevel | 0) > 0;
        if (!keep) { snap.alive = false; snap.fresh = true; }
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
        snap.moveShieldLeft = Math.max(0, (body.spawnMoveShieldUntil || 0) - t);
        // ...and so is the bot grace: a reload never starts a fresh one
        snap.botGraceLeft = Math.max(0, (body.botGraceUntil || 0) - t);
        snap.botSoftLeft = Math.max(0, (body.botSoftUntil || 0) - t);
        snap.botNewbie = !!body.botNewbie;
        snap.growEff = body._growEff || 0;
        if (hitAgo > RESUME_SAFE_MS || snap.fresh) {
            snap.carried = (body.carriedGems | 0);
            body.carriedGems = 0;     // kept for the resume, so it must not also drop
            // its gemdust goes with it
            try { snap.dustCarried = dustHooks.stash(body); } catch { /* */ }
        }
    }
    for (const k of keys) resumeStore.set(k, snap);
    holdSnapColor(snap);
    // the snapshot holds the lease now; the old socket must never release it
    socket._bankLease = null;
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
        releaseSnapBank(snap);
        releaseSnapColor(snap);
        return false;
    }
    // this socket may have checked a bank out already (a tab that opened
    // and then claimed): the snapshot's lease wins, this one goes back
    if (socket._bankLease && socket._bankLease !== (snap.sock && snap.sock._bankLease)) bank.release(socket);
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
// The spawn path (sockets.js) asks this before handing out a fresh team id:
// a claimed resume gets its old team and colour back, unless somebody alive
// holds that team now (then it's a fresh one like any spawn). Solo only; the
// duo team book keeps a team's id and colour on its own.
function resumeTeam(socket) {
    const snap = socket && socket._resume;
    if (!snap || snap.raidId !== raidId || snap.team == null || Config.royale_duos) return null;
    // the hold has done its job: from here the colour is this team's again
    releaseSnapColor(snap);
    for (const e of entities.values()) {
        if (e && (e.isPlayer || e.isBot) && !e.isDead?.() && e.team === snap.team) return null;
    }
    let color = snap.color;
    if (color != null) {
        // nobody else picked the colour up in the meantime
        for (const e of entities.values()) {
            if (!e || !(e.isPlayer || e.isBot) || e.isDead?.() || e.team === snap.team) continue;
            if (global.royaleTeamColors && global.royaleTeamColors.get(e.team) === color) { color = null; break; }
        }
    }
    if (color != null && global.royaleTeamColors) global.royaleTeamColors.set(snap.team, color);
    if (process.env.RESUME_DEBUG) console.log('[RESUME] team', snap.team, 'colour', snap.color, '->', color);
    return { team: snap.team, color: color != null ? color : global.assignTeamColor(snap.team) };
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
        if ((snap.alive || snap.fresh) && snap.defs && snap.defs.length) {
            // define() appends to the upgrade menu and the fresh body is
            // already the spawn class: clear it, or the resumed tank is offered
            // the spawn class's tree again (entity.upgrade() does the same)
            body.upgrades = [];
            body.define(snap.defs.length === 1 ? snap.defs[0] : snap.defs);
            if (snap.skillRaw) { body.skill.set(snap.skillRaw); body.skill.points = snap.points | 0; }
            body._modSkillGiven = snap.modSkill || body._modSkillGiven;
            body.refreshBodyAttributes();
            if (body.syncSkillsToGuns) body.syncSkillsToGuns();
            // a reload is not a respawn: the size comes back as it was
            if (snap.growEff > 0) guard('growth resume', () => growth.onSpawn(body, growthScore(body), snap.growEff));
        }
        if (snap.alive && snap.defs && snap.defs.length) {
            // back where you were, but not back into the storm (you keep the
            // fresh spawn then)
            let inStorm = false;
            try { inStorm = storm.inStorm(snap.x, snap.y); } catch { /* */ }
            if (!inStorm) guard('resume spot', () => placeResumed(body, snap.x, snap.y));
            else if (snap.growEff > 0) guard('growth room', () => growRoom(body, true));
            body.health.amount = body.health.max * Math.max(0.25, Math.min(1, snap.hp || 1));
            // freshRaidBody shielded this body like a new spawn; a resume
            // keeps the old life's shield state (and what was left of its grace)
            body.invuln = !!snap.shielded;
            body.spawnGraceUntil = snap.shielded ? now() + Math.min(SPAWN_GRACE_MS, snap.graceLeft | 0) : 0;
            body.spawnMoveShieldUntil = snap.shielded && (snap.moveShieldLeft | 0) > 0 ? now() + (snap.moveShieldLeft | 0) : 0;
            body.botGraceUntil = (snap.botGraceLeft | 0) > 0 ? now() + (snap.botGraceLeft | 0) : 0;
            body.botSoftUntil = now() + (snap.botSoftLeft | 0);
            body.botNewbie = !!snap.botNewbie;
            body.carriedGems = snap.carried | 0;
            try { dustHooks.restore(body, snap.dustCarried | 0); } catch { /* */ }
            try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
        }
        if (snap.fresh) {
            // dropped somewhere new: the few gems it carried come along
            body.carriedGems = Math.max(body.carriedGems | 0, snap.carried | 0);
            try { dustHooks.restore(body, snap.dustCarried | 0); } catch { /* */ }
            try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
        }
        if (snap.alive || snap.fresh) {
            const st = shop.stateOf(socket);
            if (st && st.arm) { try { shop.attachSidearm(body, st.arm); } catch { /* */ } }
        }
        body.bankedGems = socket.gemBanked || 0;
        try { shop.applyPassives(body); shop.talkState(socket); gems.talkGems(body, 0); } catch { /* */ }
        ensureStat(body);
        try { body.sendMessage(snap.fresh ? "Reconnected. You dropped back in somewhere new." : "Reconnected. Your raid picked up where you left off."); } catch { /* */ }
        // drop back in from the sky: drawn only, nothing held, smashed or reset
        if (snap.alive) guard('resume drop', () => dropIn.visual(body));
        if (process.env.RESUME_DEBUG) console.log('[RESUME] applied: banked', socket.gemBanked | 0, 'carried', body.carriedGems | 0, 'drill', (shop.stateOf(socket) || {}).drill, 'class', (body.defs || []).join('/'), 'raw', body.skill.raw.join(','), 'pts', body.skill.points, 'pos', Math.round(body.x) + ',' + Math.round(body.y), 'was', Math.round(snap.x) + ',' + Math.round(snap.y));
    } catch (e) { console.error('[RAID] resume failed', e && e.message); }
}

// Put a resumed tank back on its old spot. The rock may have grown back
// into the gap while it was away; pushing a big hull out of that throws it
// across the map, so the spot is opened up like a spawn pocket instead
// (held, nothing paid out). Only an emerald in the way moves it, to the
// nearest spot the whole hull fits.
function placeResumed(body, x, y) {
    const tg = global.gameManager.terrainGrid;
    const r = body.realSize || 30;
    if (tg && tg.clampToPlay) { const p = { x, y }; tg.clampToPlay(p, tg.edgeMargin(r), RIM_SLACK); x = p.x; y = p.y; }
    // 0.9: a hull resting against a wall keeps that wall
    let hits = tg ? hullRocks(tg, x, y, r * 0.9) : null;
    if (hits && hits.some(rk => rk.ore === 4)) {
        const spot = hullSpotNear(tg, x, y, r);
        if (spot) { x = spot.x; y = spot.y; hits = hullRocks(tg, x, y, r * 0.9); }
        else hits = hits.filter(rk => rk.ore !== 4);
    }
    body.x = x; body.y = y;
    body.velocity.x = 0; body.velocity.y = 0;
    body.accel.x = 0; body.accel.y = 0;
    if (!tg) return;
    if (hits && hits.length) {
        breakAndHold(tg, hits, FIRST_MINUTES.SPAWN_POCKET_HOLD_MS);
        try { spawnReach.invalidate(); } catch { /* */ }
    }
    // canyon walls never break: those, and whatever is left, nudge it out
    if (tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(body, r, Math.max(48, r * 0.35));
    keepOnMap(body, RIM_SLACK);
}
// Every rock (live or rising) a hull of radius r at (x, y) overlaps.
function hullRocks(tg, x, y, r) {
    const out = [];
    if (tg.rocksHitByCircle) tg.rocksHitByCircle(x, y, r, out);
    if (tg.growingRocksHitByCircle) tg.growingRocksHitByCircle(x, y, r, now(), out);
    return out;
}
// The nearest spot where a hull of radius r touches no emerald or canyon
// rock (anything else there gets broken). -> { x, y } or null
function hullSpotNear(tg, x, y, r) {
    const step = Math.max(40, Math.min(r * 0.5, 90));
    for (let ring = 1; ring <= 24; ring++) {
        const n = Math.min(48, 8 + ring * 3);
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + ring * 0.35;
            const nx = x + Math.cos(a) * step * ring, ny = y + Math.sin(a) * step * ring;
            if (tg.inPlayArea && !tg.inPlayArea(nx, ny, tg.edgeMargin(r))) continue;
            const hits = hullRocks(tg, nx, ny, r * 0.9);
            if (!hits.some(rk => rk.ore === 4 || rk.canyon)) return { x: nx, y: ny };
        }
    }
    return null;
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
    if (!socket) return;
    socket.lastRaidDeathAt = now();
    // nothing drops you back in any more (the card waits for Play again), so
    // the idle kick watches the death card too, with the full window from here
    activity.resetClock(socket, now());
}

function disconnectCleanup(socket, body) {
    if (!Config.dig_royale) return;
    let snap = null;
    const leaving = !!(socket && socket.leftOnPurpose);
    if (leaving) {
        // menu / Home / another tab took over: nothing to come back to
        try { for (const k of resumeKeysFor(socket)) { const v = resumeStore.get(k); if (v) dropResume(k, v); } } catch { /* */ }
    } else {
        try { snap = saveResume(socket, body); } catch (e) { console.error('[RAID] resume save failed', e && e.message); }
    }
    // no snapshot holding the bank: it goes back to the persistent store now
    if (socket && socket._bankLease) guard('bank release', () => bank.release(socket));
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

// ── idle players ──────────────────────────────────────────────────────────
// No real input (network/activity.js: keys, buttons, a real aim move; chat
// counts here too) for activity.IDLE_KICK_MS and the tank is removed and the
// player sent to the menu. The life ends with no rank gain, the raid pays
// them no placement or streak, and nothing is kept for a resume. Before
// that, after activity.IDLE_PROTECT_MS without input, the spawn shield drops
// (and bots stop sparing them, controllers.js). The dead count too: someone
// left on the death card (or spectating) with no input for the same time
// goes to the menu the same way (tickDeadIdle).
const IDLE_KICK_TEXT = "Removed for being inactive for 5 minutes";
function tickIdle(t) {
    if (Config.tutorial) return;
    for (const socket of connectedClients()) {
        if (socket._idleKicked) continue;
        const body = socket.player && socket.player.body;
        if (!body || body.socket !== socket || !body.isPlayer || body.isDead?.() || body.royaleAlive === false) {
            tickDeadIdle(socket, t);
            continue;
        }
        // held still by the raid (the end-of-raid freeze): not their idling
        if (body.royaleFrozen || body.royaleLobby) { activity.resetClock(socket, t); continue; }
        if (activity.idleMs(socket, t) >= activity.IDLE_KICK_MS) { idleKick(socket, body); continue; }
        if (body.invuln && !body.godmode && t >= (body.spawnGraceUntil || 0) &&
            activity.inputIdleMs(socket, t) > activity.IDLE_PROTECT_MS) {
            body.invuln = false;
            try { body.sendMessage("You've been idle for a minute, so your shield is off."); } catch { /* */ }
        }
    }
}

// Dead and not yet asking to play again. The clock starts at the death
// (markHumanDeath); a mouse move, a key, a spectate click or a chat line
// resets it. Time the raid would not let them back in anyway (final storm,
// raid end) or already queued for a spawn does not count.
function tickDeadIdle(socket, t) {
    const st = socket.status;
    if (!st || !st.hasSpawned || !st.deceased) return;
    if (socket._spawnLoop || !canSpawn()) { activity.resetClock(socket, t); return; }
    if (activity.idleMs(socket, t) >= activity.IDLE_KICK_MS) idleKick(socket, socket.player && socket.player.body);
}

function idleKick(socket, body) {
    socket._idleKicked = true;
    // no resume for this one, whatever the client does next
    socket.leftOnPurpose = true;
    console.log('[RAID] ' + ((body && body.name) || 'A player') + ' was removed for being idle.');
    const s = body ? raidStats.get(statKeyFor(body)) : null;
    try { rankHooks.onIdleKick(socket, s); } catch (e) { guardLog('rank idle', e); }
    try { socket.talk('IK', IDLE_KICK_TEXT); } catch { /* closing */ }
    socket._drCleaned = true;
    try { disconnectCleanup(socket, body); } catch (e) { guardLog('idle cleanup', e); }
    // The tank goes now, the way sockets.close removes a dropped one (the
    // satchel falls, no death event, so nobody is credited a kill).
    if (body && !body.isDead?.()) {
        try { if ((body.carriedGems | 0) > 0) gems.dropGemsOnDeath(body, []); } catch (e) { guardLog('idle drop', e); }
        try { body.invuln = false; body.kill(); body.destroy(); } catch (e) { guardLog('idle remove', e); }
    }
    if (socket.player) socket.player.body = null;
    // a close frame after IK (code 4001 tells the client even if IK is lost);
    // a peer that never answers it is cut off
    try { socket.close(4001, 'idle'); } catch { /* */ }
    setTimeout(() => { try { socket.terminate(); } catch { /* */ } }, 2000).unref?.();
}

// After a save (saveCodes.finish): the tank leaves like a normal leave. The
// life settles as a disconnect, the bank goes home, no resume is kept and
// nothing drops (carried was zeroed: it's in the code).
function saveLeave(socket, body) {
    socket.leftOnPurpose = true;
    socket._drCleaned = true;
    try { disconnectCleanup(socket, body); } catch (e) { guardLog('save cleanup', e); }
    if (body && !body.isDead?.()) {
        try { body.invuln = false; body.kill(); body.destroy(); } catch (e) { guardLog('save remove', e); }
    }
    if (socket.player) socket.player.body = null;
    try { socket.close(4003, 'saved'); } catch { /* */ }
    setTimeout(() => { try { socket.terminate(); } catch { /* */ } }, 2000).unref?.();
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
                const b = site.banner;
                if (b && !b.isDead() && b.health.amount < b.health.max * 0.5) site._contestedUntil = t + 8000;
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
            toast("A vault's about to go under the storm. Bank while you still can.", 5000);
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
        try { tg.startRegrow(rock, t + (queued % 20) * 50, 0, { fast: true }); } catch { /* */ }
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
            rock.maxHealth = tg.plainRockHealth * (ORE_HP[ore] || 1) * nextHp;
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
    // frees last raid's team ids (both servers hand them out, see freshTeamId)
    try { duo.newRaid(); } catch (e) { guardLog('new raid team ids', e); }
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
    // the final circle closes on the Core's site (coreFinale.js)
    guard('core plan', () => coreFinale.newRaid());
    raidEndsAt = storm.endAt();
    if (!isFinite(raidEndsAt)) raidEndsAt = raidStartAt + RAID_MS;
    try { twistCycleSeen = storm.snapshot(now()).c | 0; } catch { /* */ }
    try { applyModsToWorld(prevMod, mod); } catch (e) { console.error('[RAID] mod apply failed', e && e.message); }
    try { bosses.resetRaid(); } catch { /* */ }
    try { botRoster.resetRaid(); } catch { /* */ }
    guard('hunted reset', () => hunted.reset());
    guard('rattler reset', () => rattler.reset());
    guard('drop in reset', () => dropIn.reset());
    guard('supply reset', () => supplyDrops.reset());
    guard('opening', () => raidOpening.newRaid());
    try { blooms.reset(); } catch { /* */ }
    try { raidEvents.reset(); } catch { /* */ }
    try { chests.clearAll(); } catch { /* */ }
    try { contracts.reset(); } catch { /* */ }
    try { pacing.reset(); pacing.note('raid'); } catch { /* */ }
    for (const client of connectedClients()) {
        // everyone went down at the raid end: the first spawn of the new raid
        // is a fresh start (starter gems, full drill), not a death respawn
        client.lastRaidDeathAt = 0;
    }
    if (!first) {
        // the map again for everyone before the regrow streams out, so no
        // client starts a raid on stale rock (see sockets.resyncTerrain)
        guard('terrain resync', () => global.gameManager.socketManager?.resyncTerrain?.());
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
            if (!body.socket) { try { revokeBotTwist(body); } catch { /* */ } }
            giveStarterKit(body, false);
            if (body.socket) guard('drop in', () => dropIn.land(body, dropIn.spillFor(true, isNewPlayer(body.socket, body))));
            else guard('bot drop', () => dropIn.landBot(body));
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
    broadcast({ toast: (first ? "Raid's live. Grab gems and bank them before the storm gets you." : "New raid. The wall is growing back.") + twist });
    toast((first ? "The raid is on." : "New raid.") + twist, 7000);
}

// Everyone goes down at once at the raid end; nothing drops, it is not a kill.
function downForRaidEnd(body) {
    try {
        body.carriedGems = 0;
        dustHooks.zero(body);          // unbanked dust ends with the raid
        try { gems.updateSatchel(body); } catch { /* */ }
        body.royaleFrozen = false;
        body.invuln = false;
        body.godmode = false;
        body.padSafe = false;
        body.passive = false;
        body.spawnGraceUntil = 0;
        body.spawnMoveShieldUntil = 0;
        body.deathCause = "raidend";
        body.dontSendDeathMessage = true;
        body.health.amount = -1;
    } catch { /* */ }
}

// Shots in flight when the raid ends: frozen where they are for the beat,
// then cleared so the victory lap has a clean stage.
function eachShot(fn) {
    try {
        for (const e of entities.values()) {
            if (!e || e.type === "tank" || e.isDead?.() || !e.master || e.master === e) continue;
            if (e.isRoyaleBoss || e.isGemPickup || e.isChest) continue;
            if (!(e.type === "bullet" || e.type === "swarm" || e.type === "drone" || e.type === "trap" || e.type === "minion" || e.type === "satellite")) continue;
            fn(e);
        }
    } catch { /* */ }
}
function freezeShots() {
    eachShot(e => {
        e.velocity.x = 0; e.velocity.y = 0;
        e.accel.x = 0; e.accel.y = 0;
        e.damage = 0;
    });
}

let raidWinners = [];
function endRaid() {
    raidEndsAt = Infinity;
    const board = boardSnapshot();
    // duos: the results are team rows ("Alex & Sam", combined score) and
    // both partners get their team's placement bonus
    const top = Config.royale_duos
        ? teamRows(board).slice(0, 10).map(t => ({ id: t.ids[0], ids: t.ids, name: t.names.join(" & "), names: t.names, score: t.score, kills: t.kills, gems: t.gems, place: t.place, bot: t.bot, alive: t.alive }))
        : board.slice(0, 10);
    // the next raid's head start goes by earned points (boardOrder), so a
    // restored save's points never buy one
    const bonuses = [500, 350, 250, 180, 140, 110, 90, 70, 50, 40];
    const byStat = new Map();
    for (const client of connectedClients()) {
        const s = client.id ? raidStats.get("s:" + client.id) : null;
        if (s) byStat.set(s, client);
    }
    const earnedOrder = boardOrder();
    const paidPlace = new Set();
    earnedOrder.forEach((e, i) => {
        const place = e.place || i + 1;
        if (place > bonuses.length) return;
        const client = byStat.get(e.s);
        if (!client || paidPlace.has(client)) return;
        paidPlace.add(client);
        client.raidBonus = (client.raidBonus | 0) + bonuses[place - 1];
    });
    for (const client of connectedClients()) {
        const key = client.id ? "s:" + client.id : null;
        const s = key ? raidStats.get(key) : null;
        if (s) {
            const sc = scoreOf(s);
            if (sc > (client.raidPB | 0)) client.raidPB = sc;
        }
    }
    // the winners still standing get the victory lap; a winner who is down
    // right now is still the winner, the camera just has nobody to fly to
    const winIds = new Set(top[0] ? (top[0].ids || [top[0].id]) : []);
    raidWinners = combatants().filter(b => winIds.has(b.id));
    const rows = Config.royale_duos ? new Set(board.map(r => r.tm != null ? "t" + r.tm : "r" + r.id)).size : board.length;
    raidResults = { raidId, top, at: now(), win: raidWinners.map(b => b.id), rows, duos: Config.royale_duos ? 1 : 0 };
    raidResultsAt = now();
    // ranked: every open life settles now (the carried half counts), then the
    // placement bonus; all before the mass death below
    try { rankHooks.onRaidEnd(); } catch (e) { guardLog('rank raid end', e); }
    try {
        const names = top.slice(0, 3).map((r, i) => "#" + (i + 1) + " " + r.name).join(", ");
        global.gameManager.socketManager.broadcast("Raid over. Top: " + (names || "no scores") + ". New raid starting.");
    } catch { /* */ }
    // time stops: every tank and every shot holds where it is. godmode, not
    // invuln: invuln makes a tank blink on every screen
    for (const body of combatants()) {
        try { setFrozen(body, true); body.invuln = false; body.godmode = true; } catch { /* */ }
    }
    freezeShots();
    broadcast({ toast: "Raid over. The next raid starts in " + Math.round((RAID_END_BEAT_MS + RAID_END_WAIT_MS) / 1000) + " seconds." });
    raidEnding = true;
    const winner = top[0] ? top[0].name || "Unnamed" : "";
    for (const client of connectedClients()) {
        try { client.talk('KC', 'raidend', 'RAID OVER', 0, winner ? ("#1 " + winner) : "Nobody scored"); } catch { /* */ }
    }
    setTimeout(() => {
        // everyone but the winners goes down; the dead spectate a winner
        const keep = new Set(raidWinners);
        for (const body of combatants()) {
            if (keep.has(body) && !body.isDead?.()) continue;
            downForRaidEnd(body);
        }
        eachShot(e => { try { e.kill(); } catch { /* */ } });
    }, RAID_END_BEAT_MS);
    setTimeout(() => {
        for (const body of raidWinners) if (body && !body.isDead?.()) downForRaidEnd(body);
        raidWinners = [];
    }, RAID_END_BEAT_MS + RAID_END_WAIT_MS - WINNER_DOWN_LEAD_MS);
    setTimeout(() => {
        try {
            // the bank carries into the next raid (bank.js), trimmed to the
            // cap; players without one start the raid at 0 like before
            for (const client of connectedClients()) {
                let cut = 0;
                try { cut = bank.newRaid(client); } catch (e) { guardLog('bank new raid', e); client.gemBanked = 0; }
                if (cut > 0) { try { client.talk('m', 8000, "Your bank carries up to " + bank.cap().toLocaleString('en-US') + " gems into a new raid. The other " + cut.toLocaleString('en-US') + " are gone."); } catch { /* */ } }
                client._milestoneIdx = 0;
                client.gemDeposited = 0;
            }
            for (const body of combatants()) {
                body.carriedGems = 0;
                dustHooks.zero(body);
                body.botBanked = 0;
                body.bankedGems = body.socket ? (body.socket.gemBanked || 0) : 0;
                try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
            }
            // the shop is a per-raid ladder: everyone climbs again
            try { shop.resetAll(); } catch { /* */ }
        } catch { /* */ }
        raidEnding = false;
        startRaid(false);
    }, RAID_END_BEAT_MS + RAID_END_WAIT_MS);
}

// a human was in the raid for at least its last 30 s
function humansPlayed(endAt) {
    for (const st of raidStats.values()) {
        if (!st.isBot && (st.since || 0) <= endAt - 30000) return true;
    }
    return false;
}

// The raid ran out with no one to watch it end: the same reset endRaid does
// after its results, without the results.
function restartQuietly() {
    raidEndsAt = Infinity;
    try {
        for (const client of connectedClients()) {
            try { bank.newRaid(client); } catch (e) { guardLog('bank new raid', e); client.gemBanked = 0; }
            client._milestoneIdx = 0;
            client.gemDeposited = 0;
        }
        for (const body of combatants()) {
            body.carriedGems = 0;
            dustHooks.zero(body);
            body.botBanked = 0;
            body.bankedGems = body.socket ? (body.socket.gemBanked || 0) : 0;
            try { gems.updateSatchel(body); gems.talkGems(body, 0); } catch { /* */ }
        }
        try { shop.resetAll(); } catch { /* */ }
    } catch { /* */ }
    console.log('[RAID] Raid ' + raidId + ' ran out with no players, starting a new one.');
    startRaid(false);
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
    // a new storm cycle: the storm moves and a new twist lands
    pacing.note('storm');
    applyNewTwist();
}
function applyNewTwist(forceId) {
    // revoke what the previous twist handed out
    for (const client of connectedClients()) {
        try {
            const st = shop.stateOf(client);
            const body = client.player && client.player.body;
            if (!st) continue;
            if (st._twistArm) {
                if (body) shop.detachSidearm(body);
                st.arm = null; st.armUntil = 0; st._twistArm = null;
                // hand back the sidearm the twist borrowed the slot from
                const paid = st._paidArm;
                st._paidArm = null;
                if (paid && (!paid.until || paid.until > Date.now())) {
                    st.arm = paid.id; st.armUntil = paid.until || 0;
                    if (body && !body.isDead?.()) shop.attachSidearm(body, paid.id);
                }
            }
            if (st._twistGear) { for (const gid of st._twistGear) if (st.gear[gid] === true) delete st.gear[gid]; st._twistGear = null; }
            require('../../terrain/abilities.js').revokeTwist(client);
            if (body && !body.isDead?.()) shop.applyPassives(body);
            shop.talkState(client);
        } catch { /* */ }
    }
    for (const b of liveBots()) { try { revokeBotTwist(b); } catch { /* */ } }
    const mod = raidMods.roll(forceId);
    for (const b of combatants()) { try { b.refreshBodyAttributes(); } catch { /* */ } }
    for (const client of connectedClients()) {
        const body = client.player && client.player.body;
        if (!body || body.isDead?.()) continue;
        // satchel size (Deep Pockets) was worked out above under the old
        // twist: redo it now and tell the client the new cap
        try { shop.applyPassives(body); gems.talkGems(body, 0); } catch { /* */ }
        try { grantTwist(body); } catch { /* */ }
    }
    for (const b of liveBots()) { try { grantTwist(b); } catch { /* */ } }
    if ((mod.extraSkill | 0) > 0) {
        for (const b of combatants()) {
            if (b.socket || b._modSkillGiven) continue;
            b._modSkillGiven = true;
            try { b.skill.points += mod.extraSkill | 0; } catch { /* */ }
        }
    }
    setToastAndSay("New override: " + mod.name + ". " + (mod.desc || ""), 7000);
}
// What the override hands out, on every spawn (giveStarterKit) and to
// everyone alive when an override starts mid-raid. Always to this body, not
// socket.player.body: during a spawn that is still the last life's.
function grantTwist(body) {
    const mod = raidMods.get() || {};
    if (!body || body.isDead?.()) return;
    if (!body.socket) { if (body.isBot) grantBotTwist(body, mod); return; }
    const st = shop.stateOf(body.socket);
    let changed = false;
    // a sidearm the player paid for is put aside for the raid and given
    // back when the twist ends (buy() clears _twistArm and _paidArm)
    if (mod.freeArm && st.arm === mod.freeArm) {
        // already has it (bought it, or this twist gave it): just mount it on this life
        shop.attachSidearm(body, mod.freeArm);
    } else if (mod.freeArm) {
        if (st.arm && !st._twistArm) st._paidArm = { id: st.arm, until: st.armUntil || 0 };
        shop.grantArm(body.socket, mod.freeArm, true, body);
        st._twistArm = mod.freeArm;
        changed = true;
    }
    if (mod.freeGear) {
        for (const gid of mod.freeGear) st.gear[gid] = true;
        st._twistGear = mod.freeGear.slice();
        shop.applyPassives(body);
        changed = true;
    }
    if (mod.freeAbility) require('../../terrain/abilities.js').grantTwist(body, mod.freeAbility);
    // topped up to the count each life, quietly when it is already there
    if (mod.kitStart) {
        for (const [kid, n] of Object.entries(mod.kitStart)) {
            const have = (st.kit && st.kit[kid]) | 0;
            if (have < n) shop.grantKit(body.socket, kid, n - have);
        }
    }
    if (changed) shop.talkState(body.socket);
    // granted here as well as in freshRaidBody, so a twist that starts
    // mid-raid takes effect at once
    if ((mod.extraSkill | 0) > 0 && !body._modSkillGiven) {
        body._modSkillGiven = true;
        try { body.skill.points += mod.extraSkill | 0; } catch { /* */ }
    }
}

// Bots have no shop state: the twist's sidearm and gear ride on the body
// (shop.armOf / shop.hasGear read them) and the sidearm fires with the
// bot's main trigger (gun.js).
function grantBotTwist(bot, mod) {
    if (mod.freeArm && !bot._twistArm) {
        bot._twistArm = mod.freeArm;
        shop.attachSidearm(bot, mod.freeArm);
    }
    if (mod.freeGear) {
        bot._twistGear = mod.freeGear.slice();
        shop.applyPassives(bot);
    }
    if (mod.freeAbility) require('../../terrain/abilities.js').grantTwist(bot, mod.freeAbility);
}
function revokeBotTwist(bot) {
    require('../../terrain/abilities.js').revokeTwist(bot);
    if (bot._twistArm) { bot._twistArm = null; shop.detachSidearm(bot); }
    if (bot._twistGear) { bot._twistGear = null; shop.applyPassives(bot); }
}

// ── growth ───────────────────────────────────────────────────────────────
// The board score, plus growth-only boosts (an admin's /dust, addGrowth).
// The kept bank never feeds it: the board counts banking, not the balance.
function growthScore(body) {
    const key = statKeyFor(body);
    const s = key ? raidStats.get(key) : null;
    return s ? scoreOf(s) + (s.growBonus | 0) : 0;
}
// Grow a body as if it had earned n more points, without touching its board
// score or placement (Discord /dust). -> the new growth score, or null
function addGrowth(body, n) {
    if (!body || !(n > 0)) return null;
    const s = ensureStat(body);
    if (!s) return null;
    s.growBonus = (s.growBonus | 0) + Math.floor(n);
    return growthScore(body);
}
function fmtGrow(g) { return String(+g.toFixed(2)) + "x"; }
// A hull that grows cracks the rock it grows into (never an emerald), and
// ore it breaks pays out like a dig. `hold` (a spawn): the landing spot is
// cleared of every rock the hull overlaps and held open like a spawn pocket.
const roomHits = [];
function growRoom(body, hold) {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocksHitByCircle || !body || body.isDead?.() || !(body.growthMult > 1)) return 0;
    const R = (body.realSize || 0) * (hold ? 1.05 : 0.94);
    tg.rocksHitByCircle(body.x, body.y, R, roomHits);
    // a landing spot also clears rock that is still rising, or it closes over the hull
    if (hold && tg.growingRocksHitByCircle) tg.growingRocksHitByCircle(body.x, body.y, R, now(), roomHits);
    const list = roomHits.slice();
    roomHits.length = 0;
    let n = 0;
    for (const rock of list) {
        if (!(rock.alive || (hold && rock.growing)) || rock.canyon || rock.ore === 4) continue;
        const ore = rock.ore;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if (!tg.damageRock(rock, rock.health + 1, rx, ry, false, hold ? null : body)) continue;
        n++;
        if (hold) rock.noRegrowUntil = Math.max(rock.noRegrowUntil || 0, now() + FIRST_MINUTES.SPAWN_POCKET_HOLD_MS);
        else if (ore) { try { gems.spawnOreBurst(rock, body); } catch { /* */ } }
    }
    if (n) { try { spawnReach.invalidate(); } catch { /* */ } }
    return n;
}
function onGrown(body, stage, idx) {
    if (!body.socket) return;
    const sub = stage >= growth.RESPAWN_CAP && stage < 2.3 ? "A respawn brings you back at a quarter of your score's size, " + fmtGrow(growth.RESPAWN_CAP) + " at most."
        : "Harder hits, more health, a wider view, a little slower.";
    try { body.socket.talk('KC', "grown", "You grew to " + fmtGrow(stage), 0, sub); } catch { /* */ }
}

function tick() {
    if (!Config.dig_royale) return;
    const t = now();
    if (!raidId) startRaid(true);
    twistCycleWatch(t);
    if (t >= raidEndsAt && !raidResults) {
        // Nobody human played this one (an empty server, or someone who
        // joined in the last few seconds): no RAID OVER for "Nobody", just
        // a fresh raid. Same if the end is long overdue (the loop slept).
        if (!humansPlayed(raidEndsAt) || t - raidEndsAt > 5000) restartQuietly();
        else endRaid();
        return;
    }
    if (raidResults && t - raidResultsAt > RAID_END_BEAT_MS + RAID_END_WAIT_MS) raidResults = null;
    // coalesced DU packets and the 5 s dust flush (accounts)
    guard('accounts', () => rankHooks.tick(t));
    guard('bank', () => bank.tick(t, connectedClients(), heldBanks()));
    if (t - (tick._resumeAt || 0) >= 2000) { tick._resumeAt = t; guard('resume expiry', () => tickResumeExpiry(t)); }
    if (Config.royale_duos) guard('duos', () => { duo.tick(t); tickTeamBots(t); });
    // everyone is down between raids: no storm, bosses, chests or bots, just
    // keep the HUD fed (results panel, countdown)
    if (raidEnding) {
        // drones and traps would drift on their own: keep the freeze on
        if (t - raidResultsAt < RAID_END_BEAT_MS) freezeShots();
        if (t - (tick._broadcastAt || 0) >= 500) { tick._broadcastAt = t; guard('broadcast', () => broadcast()); }
        return;
    }
    // Every stage is isolated: one bad stage must never take the raid
    // broadcast (and with it the whole HUD) down with it.
    if (t - (tick._idleAt || 0) >= 1000) { tick._idleAt = t; guard('idle', () => tickIdle(t)); }
    guard('storm', () => { storm.ensureActive(); storm.tickDamage(t); });
    guard('spawn rescue', () => tickSpawnRescue(t));
    guard('outposts', () => tickOutpostRules(t));
    guard('vaults', () => tickVaultPinch(t));
    guard('bots', () => fillBots());
    guard('saves', () => saveCodes.tick(t, connectedClients()));
    const fighters = combatants();
    guard('growth', () => growth.tick(t, fighters, growthScore, onGrown, growRoom));
    try { bosses.tick(t, fighters.length); } catch (e) { /* */ }
    try { blooms.tick(t); } catch (e) { /* */ }
    try { raidEvents.tick(t); } catch (e) { /* */ }
    try { chests.schedule(); } catch (e) { /* */ }
    guard('contracts', () => contracts.tick(t));
    guard('pacing', () => pacing.tick(t));
    guard('hunted', () => hunted.tick(t, fighters));
    guard('core', () => coreFinale.tick(t, fighters));
    guard('rattler', () => rattler.tick(t, fighters));
    guard('drop in', () => dropIn.tick(t));
    guard('supply', () => supplyDrops.tick(t));
    guard('opening', () => raidOpening.tick(t));
    for (const body of fighters) {
        const key = statKeyFor(body);
        const s = key ? raidStats.get(key) : null;
        if (s) { s.alive = true; s.lastSeen = t; }
    }
    if (t - (tick._botDiffAt || 0) >= 1000) {
        tick._botDiffAt = t;
        for (const body of fighters) if (body.socket) guard('bot difficulty', () => stampBotDifficulty(body));
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
// TICK_TRACE=1: the slowest raid stages, logged every 10 s (local profiling)
const STAGE_TRACE = !!process.env.TICK_TRACE;
const stageMax = new Map();
let stageLogAt = 0;
function guard(label, fn) {
    if (!STAGE_TRACE) { try { fn(); } catch (e) { guardLog(label, e); } return; }
    const t0 = performance.now();
    try { fn(); } catch (e) { guardLog(label, e); }
    const d = performance.now() - t0;
    if (d > (stageMax.get(label) || 0)) stageMax.set(label, d);
    if (Date.now() - stageLogAt > 10000) {
        stageLogAt = Date.now();
        const top = [...stageMax.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ' ' + v.toFixed(0)).join(', ');
        console.log('[STAGE-TRACE] max ms: ' + top);
        stageMax.clear();
    }
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
// Discord /dust (accounts/game/adminGems.js): growth to go with the gems
global.royaleAddGrowth = addGrowth;

// Save & leave: what the save codes may read and do in the raid.
saveCodes.attach({
    stat: ensureStat,
    statKey: statKeyFor,
    scoreOf,
    raidId: () => raidId,
    ending: () => raidEnding || !!raidResults,
    growthScore,
    growRoom: (body) => growRoom(body, true),
    leave: saveLeave,
    dropRow: (key) => {
        const s = raidStats.get(key);
        if (!s || s.lifeOpen) return false;
        try { if (connectedClients().some(c => c && "s:" + c.id === key)) return false; } catch { return false; }
        raidStats.delete(key);
        return true;
    },
});
// a clean shutdown puts every bank back at once
try {
    require('../../../accounts/index.js').onShutdown(() => bank.releaseAll(connectedClients(), heldBanks()));
} catch (e) { /* accounts not loaded */ }

// entity.contemplationOfMortality calls this when a real player takes damage
// (ranked damage points; rank-only, not on the board)
global.royaleOnPlayerDamage = (victim, dealt, inflictors) => {
    if (!Config.dig_royale || raidEnding) return;
    // hurting someone counts as a fight for the reload rule (saveResume)
    const tNow = Date.now();
    for (const src of inflictors || []) {
        let root = src, hops = 0;
        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
        if (root && root !== victim && (root.isPlayer || root.isBot)) root._dealtAt = tNow;
    }
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
    lobbyPos, tick, onBanked, onCapture, FILL_CAP, stormLocked, boardSnapshot, scoreOf, baseWall, claimResume, applyPendingResume, resumeTeam, baseReserved,
    addGrowth, growthScore, earnedOf, boardOrder,
    // bot roster (scripts/test/botRoster.test.js)
    _fillBots: () => fillBots(), _spawnRaidBot: back => spawnRaidBot(back), _statKeyFor: b => statKeyFor(b),
    // terrain pass: a buried grown hull clears its own room (held, no payout)
    breakOutGrown: (body) => growRoom(body, true),
    onBossSpawned, onBossDead, onChestOpened, onBloom, onEvent, onShopBuy, fxAt, callout,
    FIRST_MINUTES, isNewPlayer, RESPAWN_MS, freshRaidBody, SPAWN_GRACE_MS, RAID_CYCLES, RAID_MS, RESUME_MS,
    // ROYALE_DEBUG only (sockets.js DBG): force a twist, end the raid now
    debugTwist: (id) => applyNewTwist(id), debugEndRaid: () => { raidEndsAt = now(); },
    // DBG core [hp 0..1]: surface the Core now, or set its health
    debugCore: (hp, by) => hp != null && hp !== '' ? coreFinale.debugHp(hp, by) : (coreFinale.debugSpawn() ? coreFinale._state() : null),
    // tests: one pass of the idle watch at time t; a twist's hand-outs
    _tickIdle: (t) => tickIdle(t), _grantTwist: (b) => grantTwist(b),
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
    // DBG botdiff <0..100 | off>: pin this socket's bot difficulty (percent)
    debugBotDiff: (socket, v) => {
        if (!socket) return null;
        socket._botDiffPin = v === 'off' || v == null || v === '' ? null : Math.max(0, Math.min(100, +v || 0)) / 100;
        const b = socket.player && socket.player.body;
        if (b) stampBotDifficulty(b);
        return b ? b.botDifficulty : socket._botDiffPin;
    },
    // DBG score <n>: set this body's raid score (growth testing)
    debugSetScore: (body, n) => {
        const st = body ? ensureStat(body) : null;
        if (!st) return null;
        st.extra = (st.extra | 0) + Math.max(0, n | 0) - scoreOf(st);
        return scoreOf(st);
    },
    // DBG bank: the persistent bank and the restore bookkeeping on the stat
    debugBank: (socket) => {
        const b = socket && socket.player && socket.player.body;
        const st = raidStats.get("s:" + (socket && socket.id));
        return {
            banked: (socket.gemBanked || 0) | 0, kept: bank.kept(socket), lease: !!socket._bankLease, owner: socket._bankOwner || null,
            saving: socket._saving ? Math.max(0, socket._saving.at + saveCodes.HOLD_MS - now()) : 0,
            stat: st ? { banked: st.banked | 0, score: scoreOf(st), earned: earnedOf(st), restoredPts: st.restoredPts | 0, restoredCarry: st.restoredCarry | 0,
                restoredBanked: st.restoredBanked | 0, rankDiscount: Math.round(st.rankDiscount || 0), growBonus: st.growBonus | 0, extra: st.extra | 0 } : null,
            growth: b ? { score: growthScore(b), eff: Math.round(b._growEff || 0), g: +(b.growthMult || 1).toFixed(3), target: +(b._growTarget || 1).toFixed(3) } : null,
            raidId,
        };
    },
    // DBG streak <n>: a kill streak without the kills (the overhead badge)
    debugSetStreak: (body, n) => {
        const st = body ? ensureStat(body) : null;
        if (!st) return null;
        st.alive = true;
        st.streak = Math.max(0, Math.min(99, n | 0));
        st.bestStreak = Math.max(st.bestStreak | 0, st.streak);
        return st.streak;
    },
    debugGrowth: (body) => body ? { g: +(body.growthMult || 1).toFixed(3), target: +(body._growTarget || 1).toFixed(3), eff: body._growEff | 0,
        score: growthScore(body), size: +body.size.toFixed(2), realSize: +body.realSize.toFixed(2), fov: Math.round(body.fov),
        speed: +body.topSpeed.toFixed(3), hp: Math.round(body.health.max), dmg: +body.damage.toFixed(3), shotDmg: +growth.damageMult(body.growthMult || 1).toFixed(3), botDiff: body.botDifficulty, x: Math.round(body.x), y: Math.round(body.y),
        overlap: (() => { const tg = global.gameManager.terrainGrid, out = []; if (tg && tg.rocksHitByCircle) tg.rocksHitByCircle(body.x, body.y, body.realSize * 0.9, out); return out.length; })(),
        label: body.label, caps: body.skill.caps.slice(), raw: body.skill.raw.slice(), ups: (body.upgrades || []).map(u => [].concat(u.class || []).map(c => (c && c.LABEL) || String(c)).join('/')) } : null,
    // the storm jumps into the raid's last cycle too, so the final circle closes on cue
    debugRaidLeft: (sec) => {
        if (raidEnding || raidResults !== null) return;
        const end = storm.debugFinal(Math.max(1, sec | 0));
        raidEndsAt = isFinite(end) ? end : now() + Math.max(1, sec | 0) * 1000;
        try { twistCycleSeen = storm.snapshot(now()).c | 0; } catch { /* */ }
    },
};
