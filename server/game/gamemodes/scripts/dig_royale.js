const storm = require('../../terrain/storm.js');
const vault = require('../../terrain/vault.js');
const spawnShield = require('../../terrain/spawnShield.js');
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
const quietVein = require('../../terrain/quietVein.js');   // a rich vein near a player in a dead stretch
const pacing = require('../../terrain/pacing.js');         // a notable beat every 60-90 s
const botDiff = require('../../../miscFiles/botDifficulty.js');
// entity.js reads the growth perks through this (refreshBodyAttributes, fov)
global.royaleGrowth = growth;
// ranked lives + gemdust (accounts); every call below is guarded
const rankHooks = require('../../../accounts/game/rankHooks.js');
const dustHooks = require('../../../accounts/game/dustHooks.js');
const progressHooks = require('../../../accounts/game/progressHooks.js');   // daily quests
const achHooks = require('../../../accounts/game/achHooks.js');             // achievements (accounts and guests)
achHooks.init({ isFinal: () => { const sn = storm.snapshot(); return !!(sn && sn.fin); }, inStorm: (x, y) => storm.inStorm(x, y) });
// duos (only does anything on the duo server: Config.royale_duos)
const duo = require('../../duo/duoRaid.js');
const activity = require('../../network/activity.js');
// the persistent bank (checkout, checkpoints, release) and save codes
const bank = require('../../terrain/bank.js');
const saveCodes = require('../../terrain/saveCodes.js');
const hunted = require('../../terrain/hunted.js');         // big carriers are marked on every map
const coreFinale = require('../../terrain/coreFinale.js'); // the last storm's objective
const sidekicks = require('../../terrain/sidekicks.js');   // Locker sidekicks: a table, drawn by the clients
const dropIn = require('../../terrain/dropIn.js');         // meteor landings, first spawn near a vault
const supplyDrops = require('../../terrain/supplyDrops.js'); // crates out of the sky every minute or so
const abilityDrops = require('../../terrain/abilityDrops.js');
const raidOpening = require('../../terrain/raidOpening.js'); // early ore and the 1:30 meteor rush
const newcomer = require('../../terrain/newcomerDirector.js'); // first raids: fair, and something new every minute
const fairPlay = require('../../terrain/fairPlay.js');     // vaults, small fish, kept builds, struggling players
const tier5 = require('../../terrain/tier5.js');              // Tier 5 opens at 2x growth, per life
const botTanks = require('../../../miscFiles/botTanks.js');
const respawnBuild = require('../../terrain/respawnBuild.js');   // Respawn as / Last tank / Same stats buttons
const autoStats = require('../../terrain/autoStats.js');   // unspent stat points placed after 20 s
const raidPerks = require('../../terrain/raidPerks.js');   // a perk pick every 5,000 points, kept until the raid ends
const crowns = require('../../terrain/crowns.js');         // crowns: the last storm's top 3 wear points-earning, stealable crowns
const soloColor = require('../../terrain/soloColor.js');
const alwaysOn = require('../../terrain/alwaysOn.js');
const AO = () => alwaysOn.on();

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
// ROYALE_PLACE_BONUS=1: the top 10 start the next raid with extra gems again
const PLACE_BONUS = process.env.ROYALE_PLACE_BONUS === '1';
const QUICK_DEATH_MS = 30_000;  // round 9: a life shorter than this...
const QUICK_SHIELD_MS = process.env.ROYALE_QUICK_SHIELD === '0' ? 0 : 8000;  // ...earns this shield next spawn
function quickDeath(sock) {
    const d = sock && sock.lastRaidDeathAt, l = sock && sock._r9LifeAt;
    return !!(d && l && d > l && d - l < QUICK_DEATH_MS);
}
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
    // Walled in later in a life: a human out in the storm whose way back in costs at
    WALLED_MIN_COST: 1.5,
    WALLED_EVERY_MS: 45_000,
    WALLED_AFTER_MS: 1500,
    SPAWN_FIGHT_MS: 4000,         // a tank hit this recently is in a fight
    SPAWN_FIGHT_MULT: 0.55,       // a fight counts as this much closer (distance x mult)
    SPAWN_BOSS_MULT: 0.5,         // a boss counts as this much closer (distance x mult)
    SPAWN_BOT_HUMAN_MULT: 0.6,    // a bot dropping in keeps extra room from humans
    // Bot grace: bots neither target nor shoot a fresh spawn for this long,
    // unless that player damages a bot first (on top of the spawn shield).
    // Bot behaviour only: nothing about the player changes
    BOT_GRACE_MS: 15_000,
    BOT_GRACE_NEW_MS: 30_000,     // new players
    BOT_GRACE_BOT_MS: 12_000,     // a fresh bot, from other bots
    // Who is new: botDifficulty.newness, from total play time (account or
    // guest play_ms + this session) and lives started. Fully new = botNewbie.
    // Soft window (controllers.js botSoft): for the start of every life, and
    // every life of a new player, bots never start a fight with you, skip you
    // unless you come within SOFT_CLOSE_R or shoot them, and aim worse. The
    // window runs BOT_SOFT_MS for a new player, BOT_SOFT_SHORT_MS for anyone
    // else, in between while newness fades
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
    // short: a death in it waits at most this long
    STORM_LOCK_MS: +process.env.ROYALE_STORM_LOCK_MS > 0 ? +process.env.ROYALE_STORM_LOCK_MS : 12_000,
    // Late-join note: a callout on spawn when the raid or the storm cycle is nearly done
    LATE_RAID_SEC: 180,
    LATE_STORM_SEC: 100,          // storm cycle seconds left (end of the squeeze + the hold)
    LATE_NOTE_MS: 7000,
};
try { storm.setLockMs(FIRST_MINUTES.STORM_LOCK_MS); } catch { /* */ }
// the Crown Contest keeps the last storm open: everyone can drop back in
try { storm.setNoFinalLock(() => crowns.enabled()); } catch { /* */ }
// Round 11 (Oct 6 2026): a kill is worth 300 (was 200) so skill decides
// more raids than one lucky carry; ROYALE_KILL_SCORE sets it. The storm-stage
// multiplier still applies on top.
const KILL_SCORE = Math.max(0, +process.env.ROYALE_KILL_SCORE || 300);
// and a streak pays a little before the mark: kill 2 of a streak +40, kill 3
// +80, kill 4 +120 (ROYALE_STREAK_PTS, 0 = off); past the mark STREAK_BONUS_PER
const STREAK_EARLY_PTS = (v => v == null || v === '' || !isFinite(+v) ? 40 : Math.max(0, +v))(process.env.ROYALE_STREAK_PTS);
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
respawnBuild.setRaidOf(() => raidId);
tier5.setRaidOf(() => raidId);
let raidStartAt = 0;
let raidEndsAt = 0;
let raidStats = new Map();
let killFeed = [];
let occupy = new Map();
const mapScale = require('../../terrain/mapScale.js');
// safe spawn on a big map: a clear-enough spot at most this many times the
// wanted room from the nearest threat is preferred (see safeSpawnSpot)
const ROOMY_MAX = 2;
const PIT_RESERVE_MS = 20_000;
const PIT_RESERVE_R = 260;
let lockout = new Map();
let raidResults = null;
// Between "raid over" and the next raid: everyone is down, nobody spawns.
let raidEnding = false;
const RAID_END_BEAT_MS = 1600;     // the "RAID OVER" moment before everyone goes down
// then everyone waits this long, together
// round 11: 27 s (was 21): the intro (freeze, title, reveal, podium) took ~8 s
// of it, so the results were up ~10-13 s; now they get 18 s+ before the drop
const RAID_END_WAIT_MS = Math.max(5000, +process.env.ROYALE_END_WAIT_MS || 27_000);
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
        .filter(b => b && b.isPlayer && !b.isDead?.() && !b.isGhost && !b.adminSpec);
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
// why canSpawn() says no, in the HUD's words
function spawnWhy() {
    if (raidEnding) return "The raid is over. The next one starts in a moment.";
    let fin = false;
    try { fin = storm.isFinal(); } catch { /* */ }
    if (fin) return "The raid is ending, so there are no more respawns. You can watch the finish.";
    let left = 0;
    try { left = storm.lockLeftSec(); } catch { /* */ }
    return "The storm is resetting. You'll drop back in when it opens" + (left > 0 ? " (" + left + "s)." : ".");
}
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

function colorIndexOf(body) {
    const bc = body.leaderboardColor != null ? body.leaderboardColor : body.color && body.color.base;
    if (typeof bc === 'number') return bc;
    return /^\d+$/.test(String(bc)) ? +bc : null;
}

function ensureStat(body) {
    const key = statKeyFor(body);
    if (!key) return null;
    let s = raidStats.get(key);
    if (!s && body.socket && AO()) s = aoAdopt(body, key);
    if (!s) {
        s = { key, since: now(), name: body.name || "Unnamed", kills: 0, banked: 0, holds: 0, carried: 0, alive: true, id: body.id, isBot: !!body.isBot, lastSeen: now(), revengeOn: null, revengeBonus: 0, extra: 0, streak: 0, bestStreak: 0, bossKills: 0, chests: 0 };
        raidStats.set(key, s);
        if (body.socket) dropStaleRowsOf(s, body.socket);
    }
    if (AO() && s.who && body.socket) {
        const cu = alwaysOn.champUntil(s.who);
        if (cu > (body.socket._champUntil || 0)) { body.socket._champUntil = cu; body.champUntil = Math.max(body.champUntil || 0, cu); }
    }
    s.name = body.name || s.name;
    s.id = body.id;
    s.team = body.team;
    // duos: the standings key (only real duo teams have one; see duoRaid.teamKeyOf)
    if (Config.royale_duos) s.teamKey = duo.teamKeyOf(body);
    // nameplate cosmetics for the board rows (bridge.applyIdentity)
    s.ns = body.nameStyleNid | 0;
    s.nc = body.customNameColor || null;
    const ci = colorIndexOf(body);
    if (ci != null) s.c = ci;
    // Core Champion crown by the name (accounts: 24 h, guests: this session)
    s.champUntil = Math.max(body.champUntil || 0, (body.socket && body.socket._champUntil) || 0);
    s.alive = true;
    s.lastSeen = now();
    try { s.carried = Math.max(0, (body.carriedGems || 0) | 0); } catch { /* */ }
    // a restored satchel only ever shrinks (banked, spent, dropped)
    if ((s.restoredCarry | 0) > s.carried) s.restoredCarry = s.carried;
    return s;
}

// The idle-row sweep (tick) leaves a row alone while it holds points or a crown
function keepRow(s) {
    if (!s) return false;
    if (scoreOf(s) > 0) return true;
    try { if (crowns.crownKeys().has(s.key)) return true; } catch { /* */ }
    return false;
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
    if (AO()) {
        for (const [k, row] of raidStats) if (row !== s && row.who === who && live.has(k)) s.aoDup = true;
        return;
    }
    for (const [k, row] of raidStats) {
        if (row === s || row.who !== who || live.has(k)) continue;
        raidStats.delete(k);
    }
}

const AO_NUM = ['banked', 'kills', 'botKills', 'killPts', 'extra', 'evPts', 'revengeBonus', 'crownPts', 'crownSwing', 'crownLost', 'holds', 'bossKills', 'chests', 'aoPlayMs', 'evWins'];
function aoApply(s, data, add) {
    if (!s || !data) return;
    for (const f of AO_NUM) {
        const v = +data[f];
        if (!Number.isFinite(v) || !v) continue;
        if (f === 'killPts' && s.killPts == null && !add) { s.killPts = v; continue; }
        s[f] = (add || s[f] != null ? (+s[f] || 0) : 0) + v;
    }
    if (data.killPts != null && s.killPts == null) s.killPts = +data.killPts || 0;
    s.bestStreak = Math.max(s.bestStreak | 0, data.bestStreak | 0);
    if (data.perks && typeof data.perks === 'object' && (!s.perks || !(s.perks.granted > 0))) s.perks = data.perks;
}
function aoData(s) {
    const d = {};
    for (const f of AO_NUM) if (s[f]) d[f] = Math.round(+s[f] || 0);
    if (s.killPts != null) d.killPts = s.killPts | 0;
    if (s.bestStreak) d.bestStreak = s.bestStreak | 0;
    if (s.perks && s.perks.granted > 0) d.perks = s.perks;
    return d;
}
function aoAbsorb(s, data) {
    let before = 0;
    try { before = rankHooks.basisOf(s); } catch { }
    aoApply(s, data, true);
    if (s.lifeOpen) { try { s.lifeBase = (s.lifeBase || 0) + (rankHooks.basisOf(s) - before); } catch { } }
}
function aoAdopt(body, key) {
    const who = whoOf(body.socket);
    if (!who) return null;
    const asGuest = body.socket.account && body.socket.account.id && body.socket.guestId ? "g:" + body.socket.guestId : null;
    let live = null;
    try { live = new Set(connectedClients().map(c => "s:" + c.id)); } catch { live = new Set(); }
    for (const pass of [who, asGuest]) {
        if (!pass) continue;
        for (const [k, row] of raidStats) {
            if (row.who !== pass || k === key) continue;
            if (live.has(k)) return null;
            raidStats.delete(k);
            row.key = key;
            row.alive = true;
            row.isBot = false;
            row.aoDup = false;
            if (pass !== who) { row.who = who; row.name = body.name || row.name; }
            raidStats.set(key, row);
            return row;
        }
    }
    const saved = alwaysOn.loadOne(who) || (asGuest ? alwaysOn.loadOne(asGuest) : null);
    const s = { key, since: now(), name: body.name || "Unnamed", kills: 0, banked: 0, holds: 0, carried: 0, alive: true, id: body.id, isBot: false, lastSeen: now(), revengeOn: null, revengeBonus: 0, extra: 0, streak: 0, bestStreak: 0, bossKills: 0, chests: 0, who };
    if (saved && saved.data) { aoApply(s, saved.data, false); s.aoPlayMs = Math.max(s.aoPlayMs || 0, saved.playMs || 0); }
    raidStats.set(key, s);
    return s;
}
function aoLoadRows(rows) {
    for (const r of rows || []) {
        if (!r || !r.who) continue;
        let taken = false;
        for (const row of raidStats.values()) if (row.who === r.who) { taken = true; break; }
        if (taken) continue;
        const key = "d:" + r.who;
        const s = { key, since: now(), name: r.name || "Unnamed", kills: 0, banked: 0, holds: 0, carried: 0, alive: false, id: 0, isBot: false, lastSeen: now(), revengeOn: null, revengeBonus: 0, extra: 0, streak: 0, bestStreak: 0, bossKills: 0, chests: 0, who: r.who };
        aoApply(s, r.data || {}, false);
        s.aoPlayMs = Math.max(s.aoPlayMs || 0, r.playMs || 0);
        raidStats.set(key, s);
    }
}
function aoLink() {
    const byKey = new Map();
    for (const c of connectedClients()) if (c && c.id) byKey.set("s:" + c.id, c);
    for (const s of [...raidStats.values()]) {
        if (s.isBot || s.who || !s.key.startsWith("s:")) continue;
        const c = byKey.get(s.key);
        const who = c ? whoOf(c) : null;
        if (!who) continue;
        let other = null;
        for (const [k, row] of raidStats) if (row !== s && row.who === who) { other = [k, row]; break; }
        if (other && byKey.has(other[0])) { s.who = who; s.aoDup = true; continue; }
        if (other) { raidStats.delete(other[0]); aoAbsorb(s, aoData(other[1])); s.aoPlayMs = (s.aoPlayMs || 0); }
        else { const saved = alwaysOn.loadOne(who); if (saved && saved.data) aoAbsorb(s, saved.data); }
        s.who = who;
    }
}
function aoSaveRows(all) {
    try { aoLink(); } catch (e) { guardLog('ao link', e); }
    const out = [];
    for (const s of raidStats.values()) {
        if (s.isBot || !s.who || s.aoDup) continue;
        const sc = scoreOf(s);
        const sig = sc + ':' + (s.aoPlayMs | 0) + ':' + (s.name || '') + ':' + ((s.perks && s.perks.v) | 0);
        if (!all && s._aoSig === sig) continue;
        s._aoSig = sig;
        out.push({ who: s.who, name: s.name || "Unnamed", score: Math.max(0, sc), playMs: s.aoPlayMs | 0, data: aoData(s) });
    }
    return out;
}
function aoHumanRows() {
    const out = [];
    for (const s of raidStats.values()) if (!s.isBot && s.who && !s.aoDup) out.push({ who: s.who, name: s.name || "Unnamed", score: Math.max(0, scoreOf(s)) });
    return out;
}
const AO_BOTS = (() => { const n = parseInt(process.env.ROYALE_AO_BOTS, 10); return Number.isFinite(n) && n >= 0 ? n : 10; })();
function aoBotCap(hs) {
    const env = parseInt(process.env.ROYALE_AO_TANKS, 10);
    if (env > 0) return Math.max(0, env - hs);
    return AO_BOTS;
}
function famOfKey(key) {
    const fam = String(key || "").slice(2);
    return /^\d+$/.test(fam) ? +fam : fam;
}
function aoBotIdentity(id, name) {
    return {
        nameKey: id.nameKey || null, name: String(name || id.name || "A bot").slice(0, 32), team: id.team, color: id.color,
        tank: id.tank || null, ability: id.ability || null, skill: id.skill, temperament: id.temperament, style: id.style,
        joinedAt: id.joinedAt || 0,
    };
}
function aoSaveBots(all) {
    const live = new Map();
    for (const b of enemyBots()) live.set(b.botFamilyId ?? b.id, b);
    const rows = [];
    for (const s of raidStats.values()) {
        if (!s.isBot || !s.key.startsWith("b:ao:")) continue;
        const fam = famOfKey(s.key);
        if (!botRoster.inRoster(fam)) continue;
        const body = live.get(fam);
        const id = body ? botRoster.entryOf(body, now()) : botRoster.identity(fam);
        if (!id) continue;
        const data = { id: aoBotIdentity(id, s.name), stats: aoData(s) };
        const sig = JSON.stringify(data);
        if (!all && s._aoSig === sig) continue;
        s._aoSig = sig;
        rows.push({ fam, name: s.name || id.name, data });
    }
    return { rows, gone: [] };
}
function aoLoadBots(rows) {
    const entries = [];
    for (const r of rows || []) {
        const id = r && r.data && r.data.id;
        if (!id || typeof r.fam !== "string" || !r.fam.startsWith("ao:")) continue;
        const key = "b:" + r.fam;
        if (!raidStats.has(key)) {
            const s = { key, since: now(), name: r.name || id.name || "A bot", kills: 0, banked: 0, holds: 0, carried: 0, alive: false, id: 0, isBot: true, lastSeen: now(), revengeOn: null, revengeBonus: 0, extra: 0, streak: 0, bestStreak: 0, bossKills: 0, chests: 0 };
            aoApply(s, r.data.stats || {}, false);
            raidStats.set(key, s);
        }
        entries.push(Object.assign(aoBotIdentity(id, r.name), { familyId: r.fam, minnow: false }));
    }
    botRoster.seed(entries, now());
}
function aoAddEvPts(key, n, why, place, evName) {
    const s = raidStats.get(key);
    if (!s || !(n > 0)) return;
    s.evPts = (s.evPts | 0) + Math.round(n);
    s.evWins = (s.evWins | 0) + (/ 1st$/.test(String(why)) ? 1 : 0);
    const c = key.startsWith("s:") ? connectedClients().find(x => "s:" + x.id === key) : null;
    if (!c) return;
    const label = String(why || "").slice(0, 40);
    try { c.talk('KC', 'ptspop', label, Math.round(n)); } catch { }
    const sub = place > 0 && place <= 3 ? "Top 3, so a crown is yours too!" : "Thanks for joining in!";
    try { c.talk('KC', 'aoaward', "+" + Math.round(n).toLocaleString('en-US') + " points: " + label, 0, sub, 3400); } catch { }
}
function aoBodyOfKey(key) {
    if (!key) return null;
    if (key.startsWith("s:")) {
        const c = connectedClients().find(x => "s:" + x.id === key);
        const b = c && c.player && c.player.body;
        return b && !b.isDead?.() && !b.isGhost ? b : null;
    }
    for (const b of liveBots()) if (statKeyFor(b) === key) return b;
    return null;
}
function aoKeyPresent(key) {
    if (!key) return false;
    if (key.startsWith("s:")) return connectedClients().some(x => "s:" + x.id === key);
    if (key.startsWith("b:")) {
        for (const b of liveBots()) if (statKeyFor(b) === key) return true;
        const fam = key.slice(2);
        return botRoster.present(/^\d+$/.test(fam) ? +fam : fam);
    }
    return false;
}
let aoRosterAt = 0;
function aoRosterTick(t) {
    if (t - aoRosterAt < 4000) return;
    aoRosterAt = t;
    const hs = humans();
    const seen = (b) => hs.some(h => Math.hypot(h.x - b.x, h.y - b.y) < 1500);
    const ok = (b) => !b.crowned && !b.vaultDeposit && t - Math.max(b._lastDamageAt || 0, b.hitAt || 0) > 8000 && !seen(b);
    const b = botRoster.pickLeaver(enemyBots(), t, ok);
    if (b) {
        botRoster.logOff(b, t);
        b._aoLogoff = true;
        despawnBot(b);
    }
    for (const fam of botRoster.takeRetired()) raidStats.delete("b:" + fam);
}
function aoEventEnd(ev, awards) {
    const byKey = new Map();
    for (const c of connectedClients()) if (c && c.id) byKey.set("s:" + c.id, c);
    for (const a of awards) {
        const c = byKey.get(a.key);
        if (!c) continue;
        const b = c.player && c.player.body;
        guard('ao ach', () => achHooks.onRaidEnd(c, { place: a.place, alive: !!(b && !b.isDead?.()) && ev.kind === 'storm', crown: false, played: true }));
        if (a.place <= 3) guard('ao quest', () => progressHooks.bump(c, 'top10', 1));
    }
}
let aoCurveAt = 0;
function aoDailyReset(champs, oldDay, newDay) {
    const t = now();
    guard('ao crowns', () => crowns.clearAll());
    guard('ao roster swap', () => botRoster.retireAll(t));
    for (const [k, s] of [...raidStats]) {
        if (s.isBot || k.startsWith("d:")) { raidStats.delete(k); continue; }
        let before = 0;
        try { before = rankHooks.basisOf(s); } catch { }
        for (const f of AO_NUM) if (f !== 'aoPlayMs') s[f] = 0;
        s.killPts = 0;
        s.aoPlayMs = 0;
        s.streak = 0; s.bestStreak = 0;
        s.restoredPts = 0; s.restoredBanked = 0;
        s.perks = null;
        s.lastDeath = undefined;
        s._aoSig = '';
        if (s.lifeOpen) { try { s.lifeBase = (s.lifeBase || 0) - (before - rankHooks.basisOf(s)); } catch { } }
    }
    for (const body of combatants()) guard('perks clear', () => raidPerks.clearBody(body));
    guard('ao curve', () => rankHooks.newCurve && rankHooks.newCurve());
    aoCurveAt = t;
    for (const c of connectedClients()) {
        const who = whoOf(c);
        const cu = who ? alwaysOn.champUntil(who) : 0;
        if (cu > 0) {
            c._champUntil = cu;
            const b = c.player && c.player.body;
            if (b) b.champUntil = cu;
        }
        c.raidPB = 0;
    }
    const names = (champs || []).slice(0, 3).map((c, i) => (i + 1) + ". " + (c.name || "Unnamed")).join(", ");
    announceAll('aoday', "A NEW DAY", names ? "Yesterday's champions: " + names + "." : "The daily leaderboard is fresh. Go and top it!", 5200);
    setToastAndSay(names ? "A new day has started. Yesterday's champions are " + names + ". Congratulations!" : "A new day has started, and the daily leaderboard is fresh.", 8000);
    try { global.gameManager.socketManager.broadcast(names ? "A new day has started! Yesterday's champions: " + names + "." : "A new day has started!"); } catch { }
}
function killScore() { return Math.round(KILL_SCORE * raidMods.num('killScoreMult', 1)); }
// Round 10: kills are worth more as the raid goes on, the same steps as gems
// (x1 / x1.5 / x2 by storm stage, storm.gemStageMult), so the late raid still
// moves the board for everyone. ROYALE_STAGE_KILLS=0 turns it off.
const STAGE_KILLS = process.env.ROYALE_STAGE_KILLS !== '0';
function killStageMult() {
    if (!STAGE_KILLS) return 1;
    try { const m = storm.gemStageMult(); return m > 0 ? m : 1; } catch { return 1; }
}
// a bot is worth a share of a human kill (crowns.js), so farming bots
// can't win a raid
function botKillScore() {
    let k = 1;
    try { k = crowns.botKillShare(); } catch { /* */ }
    return Math.round(killScore() * k);
}

// Raid points, one definition everywhere (board, HUD, death card, results)
function scoreParts(s) {
    let kp;
    if (s.killPts != null) kp = s.killPts | 0;
    else {
        const bk = Math.min(s.kills | 0, s.botKills | 0);
        kp = ((s.kills | 0) - bk) * killScore() + bk * botKillScore();
    }
    const kills = kp + (s.revengeBonus | 0) + (s.extra | 0) + (s.evPts | 0);
    // crown is the net: s.crownLost, what steals took, is already out of it
    return { bank: bankPtsOf(s), kills, crown: (s.crownSwing | 0) + (s.crownPts | 0) };
}
// Round 12 (playtest: a big miner coasted to 2-2.4x with 3 kills): banked
// gems count 1:1 up to BANK_SOFT points per raid, then BANK_SOFT_RATE per gem.
// Same rule for every player and bot. The gems themselves are never lost or
// cut (the Bank, the shops and the savings keep every one); only how much
// they weigh in this raid's points changes, so kills and crowns matter more
// against a single big carry. A restored save's banked gems are left as they
// were (earnedOf takes them back out). ROYALE_BANK_SOFT=0 turns it off.
const BANK_SOFT = (() => { const v = parseFloat(process.env.ROYALE_BANK_SOFT); return Number.isFinite(v) && v >= 0 ? v : 5000; })();
const BANK_SOFT_RATE = (() => { const v = parseFloat(process.env.ROYALE_BANK_SOFT_RATE); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5; })();
function bankWeight(g) {
    g = Math.max(0, g | 0);
    if (!(BANK_SOFT > 0) || g <= BANK_SOFT) return g;
    return Math.round(BANK_SOFT + (g - BANK_SOFT) * BANK_SOFT_RATE);
}
function bankPtsOf(s) {
    const b = Math.max(0, s.banked | 0), rb = Math.max(0, Math.min(b, s.restoredBanked | 0));
    return rb + bankWeight(b - rb);
}
function scoreOf(s) {
    const p = scoreParts(s);
    const raw = p.bank + p.kills + p.crown;
    return s && s.isBot ? botDimScore(raw) : raw;
}
// Round 9: a bot's points past BOT_DIM_AT come in on a log curve (diminishing
const BOT_DIM = process.env.ROYALE_BOT_DIM !== '0';
const BOT_DIM_AT = +process.env.ROYALE_BOT_DIM_SCORE || 2500;
function botDimScore(raw) {
    if (!BOT_DIM || !(raw > BOT_DIM_AT)) return raw;
    return Math.round(BOT_DIM_AT + BOT_DIM_AT * Math.log(1 + (raw - BOT_DIM_AT) / BOT_DIM_AT));
}
// Round 11: the board's "banked" next to points is this raid's banked gems
// as points, so it is never bigger than the points beside it (a bot's points
// past BOT_DIM_AT are on a log curve, which once showed "14,834 banked" under
// 7,077 points on the podium).
function bankShownOf(s) {
    // round 12: the banked part of the points (bankPtsOf), never more
    const b = bankPtsOf(s);
    if (!s || !s.isBot) return Math.min(b, Math.max(0, scoreOf(s)));
    const p = scoreParts(s), raw = p.bank + p.kills + p.crown;
    if (!(raw > 0)) return 0;
    return Math.max(0, Math.min(b, Math.round(b * scoreOf(s) / raw)));
}
// the part a crown steal can take: everything but the banked gems
function atRiskOf(s) { return Math.max(0, scoreOf(s) - bankPtsOf(s)); }
// what crowns did for this row: holding points plus steals (minus what was stolen)
function crownNetOf(s) { return (s.crownPts | 0) + (s.crownSwing | 0); }
// growth keeps counting half of the satchel, as it always did, so a miner still
function progressOf(s) { return scoreOf(s) + Math.floor((s.carried | 0) / 2); }

// What a restored save put on the board (saveCodes.js): its raid points and the
function restoredOf(s) {
    return (s.restoredPts | 0) + (s.restoredBanked | 0);
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
    let list = [...raidStats.values()]
        .map(s => ({ s, score: earnedOf(s), gems: Math.max(0, (s.banked | 0) - (s.restoredBanked | 0)), kills: s.kills | 0 }))
        .sort(boardCmp);
    // points only: crowns swing points, they never reorder the board
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
        c: (t.rows.find(r => r.c != null) || {}).c,
        // the Crown Contest: the team's net crown points and crowns worn now
        cb: t.cb || undefined, cr: t.cr || undefined,
        // the partners' stat keys ride along for endRaid, never on the wire
        _ks: t.rows.map(r => r._k).filter(Boolean),
    })).map(row => { const ks = row._ks; delete row._ks; Object.defineProperty(row, '_ks', { value: ks }); return row; });
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
    // the owner spectating doesn't show on the board
    const specKeys = new Set();
    try { for (const c of connectedClients()) if (c && c.id && c.player && c.player.body && c.player.body.adminSpec) specKeys.add("s:" + c.id); } catch { /* */ }
    const crownKeys = crowns.crownKeys();
    const champAt = now();
    const rows0 = [...raidStats.values()].filter(s => !specKeys.has(s.key)).map(s => { const row = ({
        id: s.id,
        name: s.name || "Unnamed",
        kills: s.kills | 0,
        gems: bankShownOf(s),
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
        c: s.c != null ? s.c : undefined,
        tm: Config.royale_duos && s.teamKey ? s.teamKey : undefined,
        // a crown right now (the Crown Contest), and a Core Champion of the last 24 h
        cr: crownKeys.has(s.key) ? 1 : undefined,
        ch: (s.champUntil || 0) > champAt ? 1 : undefined,
        // net points crowns brought (the raid end shows it as its own line)
        cb: crownNetOf(s) || undefined,
        place: 0,
    });
    // the stat key rides along for endRaid, never on the wire
    Object.defineProperty(row, '_k', { value: s.key });
    return row; });
    // points only: crowns never reorder the board
    const rows = rows0.sort(boardCmp);
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
// why: a short label for the client's bank pop ("+300 banked: survived the
const PAY_WHY = { bounty: "bounty claimed", bountySurvive: "survived the bounty", revenge: "revenge", hunt: "hunted down", leaderBounty: "leader bounty" };
function payLabel(why) {
    const w = String(why || "");
    return (PAY_WHY[w] || w).slice(0, 48);
}
function payGems(body, gemsN, why) {
    if (!body || !body.socket || !(gemsN > 0)) return;
    try {
        const cur = (body.socket.gemBanked || 0) | 0;
        gems.setBanked(body, cur + gemsN);
        const s = ensureStat(body);
        if (s) s.banked = (s.banked || 0) + gemsN;
        try { body.socket.talk('KC', 'bankpop', payLabel(why), gemsN | 0); } catch { /* */ }
        gems.talkGems(body, 0);
    } catch { /* */ }
}
// payGems for anyone: a bot's bank and board row get it the same way
function payAny(body, gemsN, why) {
    if (!body || !(gemsN > 0)) return;
    if (body.socket) return payGems(body, gemsN, why);
    if (!body.isBot) return;
    try {
        gems.setBanked(body, ((body.botBanked || 0) | 0) + gemsN);
        const s = ensureStat(body);
        if (s) s.banked = (s.banked || 0) + gemsN;
    } catch { /* */ }
}
// pacing.js leader bounty: the board's #1, their lead over #2, and their body
// (null while down)
function leaderInfo() {
    const order = boardOrder();
    if (!order.length) return null;
    const a = order[0];
    let b = null;
    for (let i = 1; i < order.length; i++) {
        const e = order[i];
        if (Config.royale_duos && a.s.teamKey && e.s.teamKey === a.s.teamKey) continue;
        b = e; break;
    }
    let body = null;
    for (const c of combatants()) if (statKeyFor(c) === a.s.key) { body = c; break; }
    return { body, key: a.s.key, score: a.score, lead: a.score - (b ? b.score : 0) };
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
    pay: (body, n, why) => payGems(body, n, why),
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
    isNew: (body) => !!body.botNewbie,
    // fairPlay: no "take them down" contract on a tank far beyond a protected player
    tooStrong: (body, e) => !!body && e !== body && fairPlay.isProtected(body) &&
        fairPlay.tooStrong(true, e, scoreOfBody(body), scoreOfBody(e), streakOfBody(e), body),
    streakOf: streakOfBody,
    keyOf: statKeyFor,
    bounty: () => pacing.current(),
    inRaid: () => !raidEnding,
});
pacing.attach({
    humans, fighters: () => combatants(), scoreOf: scoreOfBody, keyOf: statKeyFor,
    pay: (body, n, why) => payGems(body, n, why),
    payAny: (body, n, why) => payAny(body, n, why),
    leader: () => leaderInfo(),
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
function addPts(body, n, why = "broke the Core") {
    const s = body ? ensureStat(body) : null;
    if (s && n > 0) { s.extra = (s.extra | 0) + n; notePts(body, n, why); }
}
// Every change of your points says why (playtest 5: 2,840 -> 3,200 while dead
function notePts(body, n, why) {
    n = Math.round(+n || 0);
    if (!n || !body || !body.socket) return;
    try { body.socket.talk('KC', 'ptspop', String(why || "").slice(0, 40), n); } catch { /* */ }
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
    payGems: (body, n, why) => payGems(body, n, why),
    // banked like a vault deposit (score, stats, quests, dust)
    bank: (body, n) => vault.creditBank(body, n),
    addPts,
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
    // Core lucky drop: a random lobby cosmetic for the breaker (coreDrop.js)
    loot: (body) => require('../../terrain/coreDrop.js').onBreak(body, {
        callout: (b, kind, text, pts, sub, dur) => callout(b, kind, text, pts, sub, dur),
        feed: (entry) => pushFeed(entry),
    }),
});
crowns.attach({
    keyOf: statKeyFor,
    keyPresent: (key) => aoKeyPresent(key),
    scoreOf: scoreOfBody,
    // a steal takes from kills + crowns only: banked gems are safe points
    riskOf: (body) => { const k = statKeyFor(body); const st = k ? raidStats.get(k) : null; return st ? atRiskOf(st) : 0; },
    fighters: () => combatants(),
    isFinal: () => storm.isFinal(),
    leftMs: (t) => raidEndsAt - t,
    live: () => !raidEnding && !!raidId && !stagingUntil,
    clients: connectedClients,
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
    feed: (entry) => pushFeed(entry),
    fxAt: (x, y, kind, ...extra) => fxAt(x, y, kind, ...extra),
    // holding points: board only, like a steal (never in the rank basis)
    award: (body, n, why) => {
        const st = ensureStat(body);
        if (st) st.crownPts = (st.crownPts | 0) + (n | 0);
        if (st && why === 'bell') notePts(body, n, "crown at the bell");
    },
    // a steal: board points only (crownSwing is not in the rank basis)
    move: (from, to, n) => {
        const fk = statKeyFor(from), fs = fk ? raidStats.get(fk) : null;
        const ts = ensureStat(to);
        if (!fs || !ts || fs === ts) return;
        fs.crownSwing = (fs.crownSwing | 0) - n;
        ts.crownSwing = (ts.crownSwing | 0) + n;
        fs.crownLost = (fs.crownLost | 0) + n;
        notePts(to, n, "took " + String(from.name || "their").slice(0, 16) + "'s crown");
        notePts(from, -n, String(to.name || "Someone").slice(0, 16) + " took your crown");
    },
    shownAt: (b) => require('../../terrain/abilities.js').shownAt(b),
});
sidekicks.attach({ clients: connectedClients });
alwaysOn.attach({
    fighters: () => combatants(), humans, clients: connectedClients, keyOf: statKeyFor,
    bodyOfKey: (key) => aoBodyOfKey(key), keyPresent: (key) => aoKeyPresent(key),
    toast: (text, ms) => setToastAndSay(text, ms),
    feed: (entry) => pushFeed(entry),
    fxAt: (x, y, kind, ...extra) => fxAt(x, y, kind, ...extra),
    announceAll: (kind, text, sub, dur) => announceAll(kind, text, sub, dur),
    addEvPts: (key, n, why, place, evName) => aoAddEvPts(key, n, why, place, evName),
    onEventEnd: (ev, awards) => aoEventEnd(ev, awards),
    loadRows: (rows) => aoLoadRows(rows),
    saveRows: (all) => aoSaveRows(all),
    loadBots: (rows) => aoLoadBots(rows),
    saveBots: (all) => aoSaveBots(all),
    humanRows: () => aoHumanRows(),
    dailyReset: (champs, oldDay, newDay) => aoDailyReset(champs, oldDay, newDay),
});
try {
    require('../../../accounts/index.js').onShutdown(() => { if (AO()) alwaysOn.saveAll(Date.now(), true); });
} catch (e) { }
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
newcomer.attach({
    // time played before this raid's first spawn: the career and this session
    careerMs: (socket) => careerRecord(socket).ms + (socket._royalePlayMs || 0),
    raidId: () => raidId,
    live: () => !raidEnding && !!raidId,
    clients: connectedClients,
    pay: (body, n, why) => payGems(body, n, why),
    callout: (body, kind, text, pts, sub, dur) => callout(body, kind, text, pts, sub, dur),
    // banked this raid plus what they carry (the payday vein's test)
    earned: (body) => {
        const k = statKeyFor(body);
        const s = k ? raidStats.get(k) : null;
        return ((s && s.banked) | 0) + (body.carriedGems | 0);
    },
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
    const aoOn = AO();
    const raidLeft = aoOn ? 0 : Math.max(0, Math.ceil((raidEndsAt - t) / 1000));
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
    let crownSnap;
    try { crownSnap = crowns.snapshot(); } catch (e) { guardLog('crown snapshot', e); }
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
        boss: bossSnap, event: eventSnap, mod: modSnap, bounty: bountySnap, lping: pacing.huntSnapshot(t) || undefined, pings, hunt: hunted.snapshot(), core: coreFinale.snapshot(t), supply: supplyDrops.snapshot(t), abd: abilityDrops.snapshot(t), crowns: crownSnap, results: raidResults, ending, nextIn, nextMs,
        ao: aoOn ? alwaysOn.snapshot(t) : undefined, aoStorm: aoOn ? (alwaysOn.stormSnapshot(t) || undefined) : undefined, aom: process.env.ROYALE_ALWAYS_ON === '1' ? 1 : undefined, ...extra,
    });
    for (const client of connectedClients()) {
        const key = client.id ? "s:" + client.id : null;
        const mine = key ? raidStats.get(key) : null;
        const myRow = mine ? board.find(r => r.id === mine.id) : null;
        const body = client.player && client.player.body;
        const bodyLive = body && !body.isDead?.();
        // whoever killed you last, marked for you (minimap, overhead, death screen)
        const revenge = contracts.revengeFor(client, bodyByKey, t);
        // fairPlay: a protected player isn't pointed at tanks far beyond them
        let bountyTough = 0;
        if (client._fpProtect) {
            const myScore = mine ? scoreOf(mine) : 0;
            // never your own body: you can be the bounty yourself, and the client would then
            const tough = (e) => !!e && e !== body && fairPlay.tooStrong(true, e, myScore, scoreOfBody(e), streakOfBody(e), body || null);
            if (revenge && revenge.alive) { try { if (tough(entities.get(revenge.e))) revenge.tough = 1; } catch { /* */ } }
            const bt = pacing.current();
            if (bt && bt.body && tough(bt.body)) bountyTough = 1;
        }
        let scan = null;
        if (bodyLive && shop.hasGear(body, "scanner")) {
            if (!scanRocks) scanRocks = oreRocksForScan();
            scan = scanRocks.filter(r => (r.x - body.x) ** 2 + (r.y - body.y) ** 2 <= 1500 * 1500).slice(0, 24);
        }
        const parts = mine ? scoreParts(mine) : null;
        // your crown: what it pays, and what a killer would take
        let crownMe;
        if (bodyLive && body.crowned) {
            try {
                if (crowns.holderOf(body)) {
                    // how / from: why it's yours, so the client can still say so if it missed the slam
                    const hw = crowns.howOf(body) || {};
                    crownMe = { pps: crowns.rate(), lose: crowns.stealOf(body), bell: crowns.BELL_BONUS, sd: crowns.suddenOn() ? 1 : 0, how: hw.how || undefined, from: hw.from || undefined };
                }
            } catch { /* */ }
        }
        const you = mine ? {
                score: scoreOf(mine),
                // the one definition: points = banked (b) + kills & bonuses (k) + crowns (c) (s
                // g: banked gems when past the soft line (b is what they weigh), t / r: that line and its rate
                pts: (mine.banked | 0) > parts.bank
                    ? { b: parts.bank, k: parts.kills, c: parts.crown, s: (mine.crownLost | 0) || undefined, g: mine.banked | 0, t: BANK_SOFT, r: BANK_SOFT_RATE }
                    : { b: parts.bank, k: parts.kills, c: parts.crown, s: (mine.crownLost | 0) || undefined },
                // the last death this raid: points it cost (p), who (by), satchel dropped (c)
                dl: mine.lastDeath || undefined,
                crown: crownMe,
                place: myRow ? (myRow.place | 0) : 0,
                banked: mine.banked | 0,
                kills: mine.kills | 0,
                holds: mine.holds | 0,
                streak: mine.streak | 0,
                bossKills: mine.bossKills | 0,
                revenge,
                bt: bountyTough || undefined,
                carried: bodyLive ? Math.max(0, (body.carriedGems || 0) | 0) : (mine.carried | 0),
                obj: bodyLive ? contracts.snapshotFor(client, body, t) : null,
                // dead: what you'll be doing when you drop back in
                next: bodyLive ? undefined : (client.contractNext || undefined),
                drill: shop.stateOf(client).drill | 0,
                scan,
                overdrive: bodyLive && body.overdriveUntil > t ? Math.ceil((body.overdriveUntil - t) / 1000) : 0,
                anchor: bodyLive && body.stormAnchorUntil > t ? Math.ceil((body.stormAnchorUntil - t) / 1000) : 0,
                // storm ramp while you're out in it: damage multiplier, 0 when safe
                // your shots are landing on rock right now (the client's Mining Power tip)
                dig: bodyLive && t - Math.max(body._rockHitAt || 0, body._grindDigAt || 0) < 1200 ? 1 : undefined,
                sm: bodyLive && body._inStorm ? (aoOn ? alwaysOn.exposure(body, t) : Math.round(storm.exposureOf(body, t).mult * 100) / 100) : 0,
                ao: aoOn && mine ? alwaysOn.youFields(mine.key, t) : undefined,
                // raid over: the head start your placement bought for the next one
                nextGems: raidResults && PLACE_BONUS ? (client.raidBonus | 0) : undefined,
                // hunted: your mark and how many enemies are close
                hunt: bodyLive ? hunted.forClient(body) : undefined,
                // Core Champion wins in a row on this connection (accounts have the real one)
                cs: (client._crownStreak | 0) || undefined,
                // your max shield (the HUD's HP / shield bars
                shm: bodyLive && body.shield && body.shield.max > 0 ? Math.round(body.shield.max) : undefined,
            } : null;
        // first raids (newcomerDirector.js): nx, nxEvent, nxKept
        if (you) { try { const nx = newcomer.youFields(client, t); if (nx) Object.assign(you, nx); } catch (e) { guardLog('newcomer you', e); } }
        // build buttons: lt (last tank), ltu (tank button climbs), ls (spread saved)
        if (you) { try { const rb = respawnBuild.youFields(client, bodyLive ? body : null); if (rb) Object.assign(you, rb); } catch (e) { guardLog('rb you', e); } }
        // Tier 5: t5 = [tier, earned, growth x100, mark x100] once you're Tier 4
        if (you && bodyLive) { try { const f5 = tier5.youFields(body); if (f5) Object.assign(you, f5); } catch (e) { guardLog('t5 you', e); } }
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
// storm.snapshot with cx/cy moved to where the centre will be aheadS from now
function aheadSnap(t, aheadS) {
    if (AO()) { const ao = alwaysOn.stormSnapshot(t); if (ao) return ao; }
    const st = storm.snapshot(t);
    if (!st || !st.a || !storm.centerAt) return st;
    const c = storm.centerAt(t + aheadS * 1000);
    return Object.assign({}, st, { cx: c.x, cy: c.y });
}
function stormRAhead(st, aheadS) {
    const rNow = st.r || 0;
    return Math.max(0, rNow - Math.max(0, rNow - (st.n || rNow)) * (aheadS * 4));
}
const SPAWN_SAFE_SLACK = 60;
function spawnSafeAt(x, y, t = now()) {
    const FM = FIRST_MINUTES;
    const st = aheadSnap(t, FM.SPAWN_STORM_AHEAD_S);
    if (!st || !st.a) return true;
    const r = stormRAhead(st, FM.SPAWN_STORM_AHEAD_S);
    const margin = Math.min(FM.SPAWN_EDGE_MARGIN, r * FM.SPAWN_EDGE_MARGIN_FRAC);
    return Math.hypot(x - (st.cx || 0), y - (st.cy || 0)) < Math.max(80, r - margin) + SPAWN_SAFE_SLACK;
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
// etaWant (humans, fairPlay.spawnEtaWant): seconds the storm should take to reach
function safeSpawnSpot(self, forBot, etaWant = 0) {
    const FM = FIRST_MINUTES;
    const t = now();
    // the zone slides as it shrinks: judge spots by where its centre will be
    const st = aheadSnap(t, FM.SPAWN_STORM_AHEAD_S);
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
    // filtered before the reservations, so those never leave only spots next to a big
    const danger = forBot ? null : spawnDanger(self, bodies, t);
    // nobody lands in a raid boss's lap or among its drones, wherever else there's
    const bossZ = danger ? danger.zones : spawnBossZones();
    if (bossZ.length) {
        const off = cands.filter(h => !fairPlay.inZones(bossZ, h.x, h.y));
        if (off.length) cands = off;
        const rr = rockCands.filter(h => !fairPlay.inZones(bossZ, h.x, h.y));
        if (rr.length) { rockCands.length = 0; for (const h of rr) rockCands.push(h); }
    }
    // big tanks, your last killers, held vaults, the Core, a farmer (spawnDanger)
    let openDef = 0, rockBetter = false;
    if (danger) {
        const band = fairPlay.TUNE.SPAWN_W_BAND;
        const dOf = (h) => (h._def != null ? h._def : (h._def = danger.deficit(h.x, h.y)));
        const minDef = (list) => { let m = Infinity; for (const h of list) { const d = dOf(h); if (d < m) m = d; } return m; };
        if (cands.length) openDef = minDef(cands);
        // nothing clears it all: look harder (a clear sliver is easy to miss)
        if (cands.length && openDef > 0) {
            // inside the map: early on the safe zone is wider than it)
            const sR = Math.min(safeR, mapR + Math.hypot(st.cx || 0, st.cy || 0));
            for (let i = 0; i < FM.SPAWN_SAMPLES * 2; i++) {
                const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * sR;
                const h = { x: st.cx + Math.cos(a) * d, y: st.cy + Math.sin(a) * d, pit: false };
                if (!(Math.hypot(h.x, h.y) < mapR) || !offPad(h) || !open(h)) continue;
                if (dOf(h) >= openDef || !reachOk(h)) continue;
                cands.push(h);
            }
            openDef = minDef(cands);
        }
        if (cands.length) cands = cands.filter(h => dOf(h) <= openDef + (openDef > 0 ? band : 0));
        if (rockCands.length) {
            const rMin = minDef(rockCands);
            const rr = rockCands.filter(h => dOf(h) <= rMin + (rMin > 0 ? band : 0));
            rockCands.length = 0; for (const h of rr) rockCands.push(h);
            // a pocket dug in the rock clears more than any open spot: dig it
            rockBetter = !cands.length || (openDef > 0 && rMin < openDef - band);
        }
    }
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
    if (boss) threats.push({ x: boss.x, y: boss.y, mult: fairPlay.on('bossSpawn') ? Math.min(FM.SPAWN_BOSS_MULT, fairPlay.TUNE.BOSS_SPAWN_MULT) : FM.SPAWN_BOSS_MULT });
    // its drones and shards too (bossZones[0] is the boss itself)
    for (let i = 1; i < bossZ.length; i++) threats.push({ x: bossZ[i].x, y: bossZ[i].y, mult: 0.7 });
    // the Crown Contest: land away from the crowns and the middle, where
    // the fight is
    try {
        if (crowns.active()) {
            for (const b of bodies) if (b.crowned) threats.push({ x: b.x, y: b.y, mult: 0.6 });
            threats.push({ x: st.cx || 0, y: st.cy || 0, mult: 0.9 });
        }
    } catch { /* */ }
    // big enemy tanks and the Core fight (fairPlay.spawnKeep): a human's respawn
    if (danger) {
        for (let i = 0; i < bodies.length; i++) {
            if (danger.set.has(bodies[i])) threats[i].mult *= danger.keep.mult;
            if (danger.farm.has(bodies[i]) || danger.killers.has(bodies[i])) threats[i].mult *= fairPlay.TUNE.FARM_SPAWN_MULT;
        }
        if (danger.core) threats.push({ x: danger.core.x, y: danger.core.y, mult: danger.keep.mult });
    }
    const clearOf = (h) => {
        let m = Infinity;
        for (const q of threats) {
            const d = Math.hypot(h.x - q.x, h.y - q.y) * q.mult;
            if (d < m) m = d;
        }
        return m;
    };
    // a human lands where the storm is a while off (fairPlay): the roomiest spot is
    const etaOf = etaWant > 0 ? storm.etaFn(t, Math.ceil(etaWant)) : null;
    const deepOk = (h) => !etaOf || etaOf(h.x, h.y) >= etaWant;
    if (etaOf) { const deep = cands.filter(deepOk); if (deep.length) cands = deep; }
    const scored = cands.map(h => ({ h, m: clearOf(h) })).sort((a, b) => b.m - a.m);
    // Clear enough (1500 at full storm, less as it closes): a drop pit if one
    // qualifies (they are the map's own drop points), else open ground, a
    // random one of the three roomiest so drops spread out. Nothing clear
    // enough (the final circle): the farthest spot, near-ties shuffled.
    const want = Math.min(FM.SPAWN_CLEAR, r * FM.SPAWN_CLEAR_STORM_FRAC);
    let pick = null;
    if (scored.length) {
        // On a map bigger than the 16-tile one (terrain/mapScale.js) the
        // roomiest spot can be a long way from anyone, so clear enough means
        // up to ROOMY_MAX x want when such spots exist: room to settle in,
        // not a lonely corner of the disk.
        const roomy = mapScale.lin() > 1 ? want * ROOMY_MAX : Infinity;
        const near = scored.filter(s => s.m >= want && s.m <= roomy);
        let top = (near.some(s => s.h.pit) ? near : scored).filter(s => s.h.pit && s.m >= want).slice(0, 3);
        if (!top.length) top = (near.length ? near : scored).filter(s => s.m >= want).slice(0, 3);
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
    if ((bestOpen < want || rockBetter) && rockCands.length && tgS) {
        let rc = rockCands.filter(h => !reservedBy(h));
        if (etaOf) { const deep = rc.filter(deepOk); if (deep.length) rc = deep; }
        const rs = rc.map(h => ({ h, m: clearOf(h) })).sort((a, b) => b.m - a.m);
        for (const cand of rs.slice(0, noReach ? 8 : 3)) {
            if (!rockBetter && !(cand.m > bestOpen + FM.SPAWN_CARVE_GAIN)) break;
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
    if (process.env.SPAWN_DEBUG) console.log('[SPAWN]', forBot ? 'bot' : 'human', 'r', Math.round(rNow), '->', Math.round(r), 'safeR', Math.round(safeR), 'cands', cands.length, 'of', candsAll, 'reach', candsReach, 'rock', rockCands.length, 'pits', cands.filter(c => c.pit).length, 'threats', threats.length, 'want', Math.round(want), 'bestOpen', Math.round(bestOpen), 'pick', Math.round(clearOf(pick)), 'def', (pick._def != null ? pick._def : openDef).toFixed(2), rockBetter ? 'rockBetter' : '', pick.carved ? 'CARVED tunnel ' + (carveSpawnPocket.lastTunnel | 0) : '', 'at', Math.round(pick.x), Math.round(pick.y), 'bots', bodies.filter(b => b.isBot).map(b => Math.round(Math.hypot(b.x - pick.x, b.y - pick.y))).join(','));
    spawnAudit(pick, forBot, pick.carved ? 'carved' : pick.pit ? 'pit' : 'open', null);
    pitReservations.set(Math.round(pick.x) + ":" + Math.round(pick.y), { x: pick.x, y: pick.y, until: t + PIT_RESERVE_MS, bot: !!forBot });
    return { x: pick.x, y: pick.y };
}

// A human's respawn: the enemy tanks that outclass them and the Core while it's
function spawnDanger(self, bodies, t = now()) {
    if (!self || !self.socket) return null;
    let prot = false;
    try { prot = fairPlay.isProtected(self, t); } catch { /* */ }
    const keep = fairPlay.spawnKeep(prot);
    const myS = scoreOfBody(self), myG = self.growthMult || 1;
    const set = new Set();
    for (const b of bodies || []) {
        if (!b || b === self || !(b.isPlayer || b.isBot) || b.isRoyaleBoss || b.isDead?.()) continue;
        if (self.team != null && b.team === self.team) continue;
        if (fairPlay.bigThreat(myS, myG, scoreOfBody(b), b.growthMult || 1)) set.add(b);
    }
    let core = null;
    try { const cs = coreFinale.snapshot(t); if (cs && cs.s === 'up') core = cs; } catch { /* */ }
    // a tank that killed you twice lately: well clear of it (fairPlay farming)
    let farm = [];
    try { farm = fairPlay.farmersOf(self, bodies, t); } catch { /* */ }
    // the last two tanks that killed you, all raid (fairPlay safe spawn)
    let killers = [];
    try { killers = fairPlay.lastKillersOf(self, bodies, raidId); } catch { /* */ }
    // vaults an enemy is holding
    let occ = [];
    try { occ = fairPlay.occupiedVaults(self, bodies, vault.getVaults()); } catch { /* */ }
    // the raid boss and its drones / shards / traps (fairPlay.bossZones)
    const zones = spawnBossZones();
    if (AO()) { try { for (const z of alwaysOn.spawnZones()) zones.push(z); } catch { } }
    if (!set.size && !core && !farm.length && !killers.length && !occ.length && !zones.length) return null;
    // everything to keep clear of, with how readily each gives way when a small
    const T = fairPlay.TUNE;
    const cats = [];
    for (const b of set) cats.push({ x: b.x, y: b.y, r: keep.r, w: T.SPAWN_W_BIG });
    for (const v of occ) cats.push({ x: v.x, y: v.y, r: T.VAULT_OCC_SPAWN_R, w: T.SPAWN_W_VAULT });
    if (core) cats.push({ x: core.x, y: core.y, r: keep.r, w: T.SPAWN_W_CORE });
    for (const z of zones) cats.push({ x: z.x, y: z.y, r: z.r, w: T.SPAWN_W_BOSS });
    for (const b of killers) cats.push({ x: b.x, y: b.y, r: keep.r, w: T.SPAWN_W_KILLER });
    for (const b of farm) cats.push({ x: b.x, y: b.y, r: T.FARM_SPAWN_R, w: T.SPAWN_W_FARM });
    const deficit = (x, y) => fairPlay.spawnDeficit(cats, x, y);
    const near = (x, y) => deficit(x, y) > 0;
    // a base respawn: never into a boss's lap or next to a killer / farmer
    const homeCats = cats.filter(c => c.w >= T.SPAWN_W_BOSS);
    const homeBad = (x, y) => fairPlay.spawnDeficit(homeCats, x, y) > 0;
    return { keep, set, core, near, deficit, homeBad, prot, farm: new Set(farm), killers: new Set(killers), occ, zones };
}
// fairPlay.bossZones over the live boss's drones
function spawnBossZones() {
    let boss = null;
    try { boss = bosses.current(); } catch { /* */ }
    if (!boss) return [];
    try { return fairPlay.bossZones(boss, entities.values()); } catch { return []; }
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
        if (!body._inStorm || !body.royaleBornAt) { body._walledSince = 0; continue; }
        if (!body._walledSince) body._walledSince = t;
        // the spawn window (once per life), or walled in later (humans only)
        const fresh = t - body.royaleBornAt <= FM.RESCUE_WINDOW_MS && body._rescueLife !== body.royaleBornAt;
        let minCost = FM.RESCUE_MIN_COST;
        if (!fresh) {
            if (!body.socket || t - body._walledSince < FM.WALLED_AFTER_MS) continue;
            if (t - (body._walledAt || 0) < FM.WALLED_EVERY_MS) continue;
            minCost = FM.WALLED_MIN_COST;
        }
        if (t - (body._rescueTryAt || 0) < FM.RESCUE_RETRY_MS) continue;
        body._rescueTryAt = t;
        if (!st) st = storm.snapshot(t);
        const w = tg._cellWorld || 110;
        const toZone = { x: st.cx || 0, y: st.cy || 0, r: Math.max(w, (st.r || 0) - w * 1.5) };
        const path = spawnReach.exitPath(tg, body.x, body.y, { rescue: true, toZone, maxCells: FM.RESCUE_MAX_CELLS, now: t });
        if (!path) continue;   // nothing within reach (retried every RESCUE_RETRY_MS)
        if (fresh) body._rescueLife = body.royaleBornAt;
        const plain = (tg.plainRockHealth || 1) * ((global.royaleMods && global.royaleMods.rockHpMult) || 1);
        let cost = 0;
        for (const r of path) if (r.alive || r.growing) cost += (r.health || 0) / plain;
        if (cost < minCost) continue;   // not boxed in: a short dig or a walk
        if (!fresh) { body._walledAt = t; spawnRescue.walled = (spawnRescue.walled | 0) + 1; }
        breakAndHold(tg, path, FM.SPAWN_POCKET_HOLD_MS);
        spawnReach.invalidate();
        spawnRescue.n++; spawnRescue.cells += path.length;
        if (process.env.SPAWN_DEBUG) console.log('[SPAWN-RESCUE]', body.name, 'cells', path.length, 'cost', +cost.toFixed(2), 'at', Math.round(body.x), Math.round(body.y));
        try { if (body.sendMessage) body.sendMessage("The storm broke a path through the rock. Get back inside!"); } catch { /* */ }
    }
}

// ROYALE_DEBUG only: plant `k` gem-ringed pockets (a mined-out cell whose
// every neighbour is fresh shard/emerald, held open so it stays a pocket)
// and `k` mined-out cells in plain rock that are about to regrow, inside the
// storm circle: the spots the reachability rule must never pick.
function debugPlantTraps(k) {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return 0;
    const { ORE, ORE_HP, rockTough } = require('../../terrain/terrainGrid.js');
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
                n.maxHealth = plain * ORE_HP[n.ore] * rockTough(n); n.health = n.maxHealth;
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
        const sa = aheadSnap(now(), FIRST_MINUTES.SPAWN_STORM_AHEAD_S);
        const zone = { x: sa.cx || 0, y: sa.cy || 0, r: stormRAhead(st, FIRST_MINUTES.SPAWN_STORM_AHEAD_S) };
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
    // round 11: only while the placement bonus is on (a restored socket could still carry one)
    const bonus = body.socket && PLACE_BONUS ? ((body.socket.raidBonus || 0) | 0) : 0;
    if (body.socket) body.socket.raidBonus = 0;
    const starter = raidMods.num('starterGems', STARTER_GEMS);
    const grant = (isRespawn || noStarter ? 0 : starter) + bonus;
    // a fresh start (new raid, first drop) is exactly the starting satchel
    body.carriedGems = isRespawn || noStarter ? Math.max(body.carriedGems | 0, grant) : grant;
    try { gems.updateSatchel(body); gems.talkGems(body, grant); } catch { /* */ }
    // the share of the satchel kept through the last death (gems.carryKeepFor),
    // this raid only
    if (body.socket) {
        const keep = (body.socket._carryKeep | 0);
        const same = (body.socket._carryKeepRaid | 0) === raidId;
        body.socket._carryKeep = 0;
        if (isRespawn && same && keep > 0) {
            body.carriedGems = (body.carriedGems | 0) + keep;
            try { gems.updateSatchel(body); gems.talkGems(body, keep); } catch { /* */ }
        }
    }
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
                    // a third of a flat rock at most, whatever the biome's
                    // toughness, and the old flat gem pay
                    rock.maxHealth = Math.max(10, Math.min(rock.maxHealth, tg.plainRockHealth * (ORE_HP[rock.ore] || 1)) * 0.35);
                    rock.soft = true;
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
        // bought Stat Points were for the raid that just ended
        body._shopStatPts = 0;
        if (body.socket) autoStats.arm(body, now(), careerLives(body.socket) < autoStats.NEW_LIVES);
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
    // round 9: a quick death (last life under QUICK_DEATH_MS): 8 s shield that holds
    body.shieldEndAt = 0; body.shootEndsShield = false; body.shieldSoftEnd = false;
    spawnShield.arm(body, now());
    const sock = body.socket;
    if (sock && body.isPlayer) {
        if (QUICK_SHIELD_MS > 0 && quickDeath(sock) && vault.grantTimedShield(body, QUICK_SHIELD_MS, now())) body.shieldSoftEnd = true;
        sock._r9LifeAt = now();
    }
    body.passive = false;
    body.royaleAlive = true;
    body.royaleBornAt = now();     // a kill inside 15 s of this pays nothing (ranked)
    body.deathCause = "";
    // bot grace (controllers.js sense / canInitiateFight / auto turrets):
    // bots leave a fresh spawn alone until this, or until it damages a bot
    // game/index.js clears it)
    if (body.socket) {
        guard('fair out', () => checkFairOut(body));
        const n = newnessOf(body.socket, body);
        const fresh = n >= 1;
        body.botNewbie = fresh;
        body.botNewness = n;
        body.botGraceUntil = now() + (fresh ? FIRST_MINUTES.BOT_GRACE_NEW_MS : FIRST_MINUTES.BOT_GRACE_MS);
        body.botSoftMs = botDiff.lerp(FIRST_MINUTES.BOT_SOFT_SHORT_MS, FIRST_MINUTES.BOT_SOFT_MS, n);
        body.botSoftUntil = now() + body.botSoftMs;
        autoStats.arm(body, now(), !!body.socket && careerLives(body.socket) < autoStats.NEW_LIVES);
        stampBotDifficulty(body);
        // first raids (stage fixed per raid): a longer bot soft window, no scary bot
        guard('newcomer stage', () => newcomer.applyBody(body));
        if (fairPlay.isOut(body.socket)) endNewcomerWindows(body);
    } else if (body.isBot) {
        // bots leave a fresh bot alone for a moment too, or a respawn walks
        // into the fight that killed it and never gets to grow
        body.botGraceUntil = now() + FIRST_MINUTES.BOT_GRACE_BOT_MS;
        // a first-kill fish comes back a small fish (fairPlay fodder)
        guard('fair fodder', () => fairPlay.applyFodder(body));
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
                const g = socket.guestId ? d.get('SELECT games AS lives, play_ms AS ms FROM guests WHERE guest_id = ? AND (converted_user_id IS NULL OR converted_user_id = ?)', socket.guestId, socket.account.id) : null;
                if (g) row = { lives: Math.max(row ? row.lives | 0 : 0, g.lives | 0), ms: Math.max(row ? +row.ms || 0 : 0, +g.ms || 0) };
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
    // past protection (fairPlay earned out): not new either
    if (fairPlay.isOut(socket)) return 0;
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
// fairPlay earned out: kills / streak / points / board place / banks this raid
function checkFairOut(body) {
    const socket = body && body.socket;
    if (!socket) return '';
    if (socket._fpOut) { endNewcomerWindows(body); return socket._fpOut; }
    const key = statKeyFor(body);
    const s = key ? raidStats.get(key) : null;
    const pts = s ? scoreOf(s) : 0;
    let rank = 0, rows = 0;
    if (s) {
        rank = 1;
        for (const o of raidStats.values()) {
            rows++;
            if (o !== s && scoreOf(o) > pts) rank++;
        }
    }
    const t = socket._fp && socket._fp.raid === raidId ? socket._fp : null;
    const why = fairPlay.checkOut(socket, {
        raidKills: Math.max(s ? s.kills | 0 : 0, t ? t.raidKills | 0 : 0),
        streak: s ? s.streak | 0 : 0,
        points: pts, rank, rows,
        banks: t ? t.banks | 0 : 0,
        playMs: playedMs(socket, body),
    });
    if (why) endNewcomerWindows(body);
    return why;
}
// the newbie-length grace and soft window, the scary-class hold-off: cut back to
function endNewcomerWindows(body) {
    const FM = FIRST_MINUTES;
    if (!body) return;
    body.botNewbie = false;
    body.botNewness = 0;
    body.nxScaryUntil = 0;
    const born = body.royaleBornAt || now();
    if ((body.botGraceUntil || 0) > born + FM.BOT_GRACE_MS) body.botGraceUntil = born + FM.BOT_GRACE_MS;
    if ((body.botSoftMs || 0) > FM.BOT_SOFT_SHORT_MS) {
        body.botSoftMs = FM.BOT_SOFT_SHORT_MS;
        body.botSoftUntil = Math.min(body.botSoftUntil || 0, born + FM.BOT_SOFT_SHORT_MS);
    }
}
function stampBotDifficulty(body) {
    const socket = body && body.socket;
    if (!socket) return;
    const out = !!checkFairOut(body);
    const n = newnessOf(socket, body);
    body.botNewness = n;
    body.botNewbie = n >= 1;
    if (socket._botDiffPin != null) { body.botDifficulty = socket._botDiffPin; return; }
    const key = statKeyFor(body);
    const s = key ? raidStats.get(key) : null;
    // fairPlay: who bots go easy on near vaults, and a losing streak's cap (earned
    const struggle = out ? 0 : fairPlay.struggleOf(socket, raidId);
    fairPlay.stamp(body, { stage: body.nxStage != null ? body.nxStage : 3, newness: n, struggle, raid: raidId, out });
    const d = botDiff.forPlayer({
        newness: n,
        rankCode: body.rankCode | 0,
        score: s ? scoreOf(s) : 0,
        kills: s ? s.kills | 0 : 0,
        sessionBest: socket._botDiffBest || 0,
        playMs: playedMs(socket, body),
        struggle,
    });
    body.botDifficulty = d;
    if (!n && !(body.rankCode | 0) && d > (socket._botDiffBest || 0)) socket._botDiffBest = d;
}

// fairPlay: with a protected player in the raid, a bot far ahead of every human
function stampRunaways(fighters) {
    let humanTop = 0, prot = false;
    for (const s of raidStats.values()) if (!s.isBot) humanTop = Math.max(humanTop, scoreOf(s));
    for (const c of connectedClients()) if (c._fpProtect) { prot = true; break; }
    for (const b of fighters) {
        // board points on the body, for the bank cover's "far ahead of you"
        b._fpPts = scoreOfBody(b);
        if (!b.isBot || b.isTeamBot) continue;
        fairPlay.stampRunaway(b, fairPlay.isRunaway(b._fpPts, humanTop, prot));
    }
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
    // so 1 or 2 humans both meet 4 bots (two bot duos)
    if (AO()) return aoBotCap(hs);
    let cap = fillCap() - (Config.royale_duos ? Math.max(2, hs) : hs);
    try {
        const st = storm.snapshot(now());
        if (st && st.a) {
            // bot teammates are fighters too: they share the closing circle
            const total = Math.floor(((st.r || 0) / FM.DENSITY_R) ** 2) - teamBots().length;
            cap = Math.min(cap, Math.max(hs ? FM.DENSITY_MIN_BOTS : 0, total - hs));
        }
    } catch { /* */ }
    // duos: bots come in pairs, so an even number (no lone bot row on the team board)
    if (Config.royale_duos) cap -= ((cap % 2) + 2) % 2;
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
        // a crowned bot stays: someone has to come and take it
        if (b.crowned) continue;
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
    let contest = false;
    try { contest = crowns.active(); } catch { /* */ }
    if (contest && raidLeft > 0) {
        // the Crown Contest: late is fine, a crown is up for grabs
        key = "crowns:" + raidId;
        title = "Crowns are out";
        sub = "You earn points while you wear a crown. Knock one off someone to take it and some of their points.";
    } else if (raidLeft > 0 && raidLeft <= FM.LATE_RAID_SEC) {
        key = "raid:" + raidId;
        title = "Final minutes of this raid";
        sub = "A fresh raid starts in " + fmtClock(raidLeft + (RAID_END_BEAT_MS + RAID_END_WAIT_MS) / 1000) + ". Bank what you can!";
    } else if (cycleLeft <= FM.LATE_STORM_SEC) {
        key = "storm:" + raidId + ":" + (st.c | 0);
        title = "The storm is about to close";
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
        try { if (storm.inStorm(mate.x, mate.y) || !fairPlay.edgeSafe(mate.x, mate.y, storm.snapshot(), 120)) return null; } catch { /* */ }
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
        try { if (storm.inStorm(x, y) || !fairPlay.edgeSafe(x, y, storm.snapshot(), 120)) continue; } catch { /* */ }
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
    const sa = aheadSnap(now(), FIRST_MINUTES.SPAWN_STORM_AHEAD_S) || st;
    const zone = { x: sa.cx || 0, y: sa.cy || 0, r: stormRAhead(sa, FIRST_MINUTES.SPAWN_STORM_AHEAD_S) };
    const margin = Math.min(FIRST_MINUTES.SPAWN_EDGE_MARGIN, zone.r * FIRST_MINUTES.SPAWN_EDGE_MARGIN_FRAC);
    const digR = stormRAhead(sa, FIRST_MINUTES.SPAWN_STORM_AHEAD_DIG_S) - margin;
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
    // duos: bots play in pairs (they spawn together and cover each other). One
    // coming back rejoins its living partner; else it fills a lone bot or starts a pair
    let plan = null;
    if (Config.royale_duos) {
        if (back && back.team != null) {
            const mate = enemyBots().find(b => b && b.isDuoBot && !b.isTeamBot && !b.isDead?.() && b.team === back.team);
            if (mate) plan = { team: back.team, near: mate, duo: true };
        }
        if (!plan) plan = duo.botSpawnPlan(enemyBots());
    }
    const hole = (plan && plan.near && spotNearMate(null, plan.near)) || safeSpawnSpot(null, true);
    // a team id nobody had this raid (stale board rows keep theirs). Solo too:
    // a plain random id can match a live body's and make the two a team
    const team = plan ? plan.team : back && back.team != null ? back.team : duo.freshTeamId();
    let life = back ? { familyId: back.familyId, nameKey: back.nameKey, respawnsRemaining: 0, tank: back.tank, ability: back.ability } : null;
    let freshName = null;
    if (!back && AO()) {
        const nk = require('../../../lib/random.js').chooseBotName();
        life = { familyId: "ao:" + nk, nameKey: nk, respawnsRemaining: 0 };
        freshName = Config.bot_name_prefix + nk;
    }
    // small fish (fairPlay): while a protected player is in the raid, a couple of
    let minnow = false;
    guard('small fish', () => {
        let prot = 0;
        for (const c of connectedClients()) if (c._fpProtect || c._fpFirst) prot++;
        let backScore = 0;
        if (back) { for (const r of raidStats.values()) if (r.isBot && r.name === back.name) backScore = Math.max(backScore, scoreOf(r)); }
        minnow = fairPlay.shouldBeMinnow(enemyBots(), prot, fillCap() - 1, backScore);
    });
    if (minnow) life = Object.assign(life || { respawnsRemaining: 0 }, { minnow: true });
    handler.spawnBots({ x: hole.x + (Math.random() - 0.5) * 40, y: hole.y + (Math.random() - 0.5) * 40 }, team, back ? back.name : freshName, life);
    const bot = handler.bots[handler.bots.length - 1];
    if (!bot) return;
    bot.team = team;
    if (back) {
        if (back.color != null) { const bc = soloColor.keep(team, back.color); bot.color.base = bc; bot.leaderboardColor = bc; bot.minimapColor = bc; }
        // a small fish that comes back as a regular gets a regular's head)
        const own = !bot.botMinnow && !back.minnow;
        if (back.skill != null && own) bot.botSkill = back.skill;
        if (back.temperament && own) bot.botTemperament = back.temperament;
        if (back.style && own) bot.botStyle = back.style;
    }
    if (plan) duo.linkBotDuo(bot, enemyBots());
    bot.botRespawnsRemaining = 0;
    bot.royaleAlive = true;
    bot.royaleBornAt = now();
    bot.botGraceUntil = now() + FIRST_MINUTES.BOT_GRACE_BOT_MS;
    bot.weakDrillUntil = 0;
    try { gems.initSatchel(bot); } catch { /* */ }
    // the share of its satchel it kept through the death (gems.carryKeepFor)
    if (back && (back.carry | 0) > 0) {
        try { bot.carriedGems = (bot.carriedGems | 0) + (back.carry | 0); gems.updateSatchel(bot); } catch { /* */ }
    }
    try { bot.refreshBodyAttributes(); } catch { /* */ }
    try { grantTwist(bot); } catch { /* */ }
    // a respawned bot keeps its raid perks (same family, same board row)
    applyPerks(bot, ensureStat(bot));
    if (AO()) {
        guard('ao roster join', () => botRoster.noteJoin(bot, now(), back));
        guard('ao crown wait', () => crowns.onSpawn(bot, now()));
    }
    // bots fall out of the sky too
    guard('bot drop', () => dropIn.landBot(bot));
}

let idleSince = 0;
function fillBots() {
    const t = now();
    // a Raid Night started with bots off: none in this raid
    if (botsOffRaid && botsOffRaid === raidId) {
        for (const b of (global.gameManager.gameHandler?.bots || []).slice()) {
            if (!b || b.isDead?.()) continue;
            b.carriedGems = 0; b.dontSendDeathMessage = true; b.deathCause = "despawn";
            try { b.invuln = false; b.kill(); } catch { /* */ }
        }
        return;
    }
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
    if (AO()) aoRosterTick(t);
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
    else if (pick.fresh && (!AO() || alwaysOn.ready())) spawnRaidBot();
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
    if (body.socket) { body._fpBankedAt = now(); fairPlay.noteBank(body.socket, raidId, amount); }
    guard('newcomer bank', () => newcomer.onBanked(body, amount));
    if (body.socket) guard('ach bank', () => achHooks.onBank(body, amount));
    // a first bank with no ability yet hands one out on trial
    guard('ability trial', () => require('../../terrain/abilities.js').onBanked(body, amount));
    const s = ensureStat(body);
    if (!s) return;
    s.banked = (s.banked || 0) + amount;
    if (AO()) guard('ao bank', () => alwaysOn.onBanked(body, amount));
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
    if (body.sidekick) guard('sidekick drop', () => sidekicks.drop(body));
    // a raid bot keeps its identity for a respawn (terrain/botRoster.js)
    if (body.isBot) body._botKeepName = botRoster.onBotGone(body, now(), body._aoLogoff ? 'logoff' : body.deathCause);
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
    // a bot pays a share of every point a kill brings (crowns.js
    // BOT_KILL_SHARE): kill, streak, shutdown, giant, mark, bounty, revenge.
    // The gems it drops are untouched.
    const victimBot = !body.socket;
    let vk = 1;
    if (victimBot) { try { vk = crowns.botKillShare(); } catch { vk = 1; } }
    // a first-kill fish books a small share of what it earns, all raid (fairPlay
    if (killerBody && killerBody._fpFodder) vk *= fairPlay.fodderShare(killerBody);
    const share = (n) => vk === 1 ? n : Math.round(n * vk);
    let crownRes = null;
    if (killerBody && killerKey && killerKey !== key) {
        const ks = ensureStat(killerBody);
        // your revenge target: a bonus and the REVENGE banner
        if (killerBody.socket && contracts.onKill(killerBody, body)) avenged = true;
        if (killerBody.socket) fairPlay.noteKill(killerBody.socket, raidId);
        // a bot a protected player (or its fish's host) beat leaves them be all raid
        if (killerBody.socket && victimBot) guard('fair beat', () => fairPlay.noteBeat(killerBody, body));
        if (ks) {
            ks.kills = (ks.kills | 0) + 1;
            const kp0 = Math.round((victimBot ? botKillScore() : killScore()) * killStageMult());
            const kp = killerBody._fpFodder ? Math.round(kp0 * fairPlay.fodderShare(killerBody)) : kp0;
            if (victimBot) ks.botKills = (ks.botKills | 0) + 1;
            pts += kp;
            // booked at today's price, so a later twist can't re-price it (ranked basis)
            ks.killPts = (ks.killPts | 0) + kp;
            // streak: escalating bonus past the mark, shutdown bounty for ending one
            ks.streak = (ks.streak | 0) + 1;
            streakNow = ks.streak;
            if (ks.streak > ks.bestStreak) ks.bestStreak = ks.streak;
            if (killerBody.socket) { try { progressHooks.onStreak(killerBody, ks.streak); } catch (e) { guardLog('progress streak', e); } }
            if (STREAK_EARLY_PTS > 0 && ks.streak >= 2 && ks.streak <= STREAK_MARK_AT) {
                const eb = share(STREAK_EARLY_PTS * (ks.streak - 1));
                ks.extra = (ks.extra | 0) + eb;
                pts += eb;
            }
            if (ks.streak > STREAK_MARK_AT) {
                const sb = share(STREAK_BONUS_PER * (ks.streak - STREAK_MARK_AT));
                ks.extra = (ks.extra | 0) + sb;
                pts += sb;
            }
            if (victimStreak >= STREAK_MARK_AT) {
                shutdown = share(SHUTDOWN_PER_STREAK * victimStreak);
                ks.extra = (ks.extra | 0) + shutdown;
                pts += shutdown;
            }
            if (victimGrowth >= GIANT_BOUNTY_AT) {
                giantPts = share(Math.round(GIANT_BOUNTY_PER * (victimGrowth - 1) / 25) * 25);
                ks.extra = (ks.extra | 0) + giantPts;
                pts += giantPts;
            }
            const mark = share(shop.killBonus(killerBody) | 0);
            if (mark) { ks.extra = (ks.extra | 0) + mark; pts += mark; }
            huntBounty = hunted.onKill(killerBody, body, carriedAtDeath, huntLevel);
            if (huntBounty) {
                huntBounty.pts = share(huntBounty.pts | 0);
                ks.extra = (ks.extra | 0) + huntBounty.pts;
                pts += huntBounty.pts;
                payGems(killerBody, huntBounty.gems, 'hunt');
            }
            if (avenged) {
                const rp = share(contracts.REVENGE_PTS);
                ks.revengeBonus = (ks.revengeBonus | 0) + rp;
                pts += rp;
                payGems(killerBody, contracts.REVENGE_GEMS, 'revenge');
            }
            // ranked kill filters (bot half, same victim, spawn kill) + kill dust
            try { rankHooks.onKillCredited(killerBody, ks, body, s, pts); } catch (e) { guardLog('rank kill', e); }
        }
        // the bounty (pacing.js) pays whoever takes the target down
        guard('bounty kill', () => pacing.onKill(killerBody, body, vk));
        if (killerBody.socket) {
            let line = avenged ? "REVENGE" : huntBounty ? "HUNTED DOWN" : shutdown ? "SHUTDOWN" : giantPts ? "GIANT DOWN" : "ELIMINATED";
            line += ": " + (body.name || "Unnamed");
            if (carriedAtDeath >= 300) line += "  (" + carriedAtDeath + " gems dropped)";
            notePts(killerBody, pts, "KO " + String(body.name || "Unnamed").slice(0, 20));
            callout(killerBody, avenged ? "revenge" : huntBounty ? "huntkill" : shutdown ? "shutdown" : "kill", line, pts,
                avenged ? "+" + contracts.REVENGE_GEMS + " gems" : huntBounty && huntBounty.gems ? "+" + huntBounty.gems + " hunt gems banked" : "");
            if (streakNow === STREAK_MARK_AT) {
                try { killerBody.socket.talk('KC', "streak", streakNow + " kill streak! You're marked on everyone's map now.", 0); } catch { /* */ }
            }
        }
    }
    // the Crown Contest: a crowned tank's crown goes to its killer (and a
    // share of its points with it), or falls to the next best tank
    if (!raidEndDeath && body.crowned) {
        guard('crown death', () => { crownRes = crowns.onDeath(body, bossKill ? null : killerBody, now()); });
    }
    // the death card's "Points: X (lost Y: why)": the only points a death can cost is
    if (s && body.socket && !raidEndDeath) {
        const lostPts = crownRes && crownRes.stolen > 0 ? crownRes.stolen | 0 : 0;
        s.lastDeath = {
            p: lostPts,
            by: lostPts && crownRes.killer ? String(crownRes.killer.name || "Someone").slice(0, 24) : undefined,
            cr: crownRes ? 1 : undefined,
            c: carriedAtDeath | 0,
        };
    }
    // achievements: the killer's and the victim's (O(1), sockets only)
    if (body.socket || (killerBody && killerBody.socket)) {
        guard('ach death', () => achHooks.onDeath(body, {
            killer: killerBody && killerKey && killerKey !== key ? killerBody : null, victimBot, avenged, streak: streakNow,
            crown: crownRes && killerBody && crownRes.killer === killerBody ? crownRes : null,
            carried: carriedAtDeath, raidEnd: raidEndDeath, cause: body.deathCause || "",
        }));
    }
    // (a stolen crown already put "X took Y's crown!" in the feed)
    if (!raidEndDeath && !(crownRes && crownRes.how === 'steal')) pushFeed({
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
            if (mb && mb.socket) mb.sendMessage((body.name || "Your teammate") + " is down. Hold on until they're back.");
        } catch { /* */ }
    }
    // contracts: the victim's job ends, and whoever took them down is marked
    // for them (revenge) when they come back
    if (body.socket && !raidEndDeath) guard('contracts death', () => contracts.onDeath(body, bossKill || envKill ? null : killerAny));
    if (AO() && !raidEndDeath) guard('ao death', () => alwaysOn.onDeath(body, killerBody));
    if (body.socket) {
        // settle the ranked life now; its RK follows the death packet (a
        // raid-end death was settled at endRaid, so this skips it)
        try { rankHooks.onDeath(body, s); } catch (e) { guardLog('rank death', e); }
        if (!raidEndDeath) {
            try { logDeath(body, stormKill ? 'storm' : bossKill ? 'boss' : killerAny ? (killerAny.isBot ? 'bot' : killerAny.isPlayer ? 'player' : 'other') : 'other', killerAny); } catch (e) { guardLog('death log', e); }
        }
        if (!raidEndDeath) {
            fairPlay.noteDeath(body.socket, raidId);
            // who keeps killing them (fairPlay farming: their next spawn keeps away)
            if (killerAny && !bossKill && (killerAny.isBot || killerAny.isPlayer)) fairPlay.noteKilledBy(body.socket, killerAny, now(), raidId);
            // the respawn comes back in this tank with these points (fairPlay)
            guard('fair build', () => fairPlay.saveBuild(body.socket, body, raidId));
            // the build buttons (respawnBuild.js): what this life played
            guard('rb save', () => respawnBuild.save(body.socket, body, raidId));
            // dying in the storm's spawn lock: say how long, and where you'll land
            const lockLeft = storm.lockLeftSec ? storm.lockLeftSec() : 0;
            if (lockLeft > 0 && stormLocked()) {
                body.socket._fpLockWait = true;
                try { body.socket.talk('m', 6000, "The storm is resetting. You can drop back in " + lockLeft + " seconds, inside the new circle."); } catch { /* */ }
            }
        } else body.socket._fpBuild = null;
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
    setToastAndSay(kind.name + " has appeared in " + compass(o.x, o.y) + "! It drops " + kind.gems + " gems when it goes down.", 6000);
    fxAt(o.x, o.y, "boss");
}

// ── in-raid rewards (R.REWARDS in shared/ranks.js) ─────────────────────────
// Raid points on the board (they reach the rank basis like any other score)
// and a little gemdust for account holders. Humans only: bots have no rank.
const REWARDS = require('../../../../shared/ranks.js').REWARDS;
let shopRewardCount = new Map();    // account id (or stat key) -> paid purchases this raid
function grantReward(body, pts, dustMilli, why = "bonus") {
    if (!body || !body.socket || body.isBot) return;
    const s = ensureStat(body);
    if (s && pts > 0) { s.extra = (s.extra | 0) + (pts | 0); notePts(body, pts | 0, why); }
    if (dustMilli > 0) { try { dustHooks.creditReward(body.socket, dustMilli); } catch (e) { guardLog('reward dust', e); } }
}

function onBossDead(o, kind, killer, burrowed, shares = []) {
    if (AO()) guard('ao boss', () => alwaysOn.onBossDead(o, kind, killer, burrowed));
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
            ks.extra = (ks.extra | 0) + Math.round(kind.score * fairPlay.fodderShare(killer));
        }
        by = killer.name || "Unnamed";
        callout(killer, "boss", "BOSS DOWN: " + kind.name, kind.score);
        notePts(killer, kind.score, kind.name + " down");
        if (killer.socket) { try { progressHooks.onBoss(killer); } catch (e) { guardLog('progress boss', e); } }
        if (killer.socket) guard('ach boss', () => achHooks.onBoss(killer));
        grantReward(killer, 0, REWARDS.boss.finalDustMilli);
    }
    // everyone else who did a real share of the work
    for (const h of shares) {
        if (!h.body || h.body === killer || !(h.share >= REWARDS.boss.assistShare)) continue;
        if (h.body.isDead?.()) continue;
        grantReward(h.body, REWARDS.boss.assistPts, REWARDS.boss.assistDustMilli, "helped down " + kind.name);
    }
    // everyone else gets the banner too (no points on theirs)
    for (const client of connectedClients()) {
        if (killer && client.player && client.player.body === killer) continue;
        try { client.talk('KC', 'boss', "BOSS DOWN: " + kind.name + (by ? "  ·  " + by : ""), 0); } catch { /* */ }
    }
    pushFeed({ boss: 1, slain: 1, name: kind.name, by, c: kind.color, pts: kind.score });
    setToastAndSay((by || "The wall") + " killed the " + kind.name + ", and its gems are all over the ground. Go grab them!", 6000);
    fxAt(o.x, o.y, "bossdead");
}

function onChestOpened(body, chest, itemMsg) {
    if (!body) return;
    const s = ensureStat(body);
    if (s) s.chests = (s.chests | 0) + 1;
    const cr = chest.chestRare ? REWARDS.chest.epic : REWARDS.chest.common;
    grantReward(body, cr.pts, cr.dustMilli, chest.chestRare ? "epic chest" : "chest");
    if (body.socket) {
        guard('contracts chest', () => contracts.onChestOpened(body, chest));
        try { progressHooks.onChest(body); } catch (e) { guardLog('progress chest', e); }
        guard('ach chest', () => achHooks.onChest(body));
        const text = (chest.supplyDrop ? "Supply drop opened" : chest.chestRare ? "Epic chest opened" : "Copper chest opened") + (itemMsg ? ". " + itemMsg : "");
        callout(body, "chest", text, chest.chestGems | 0);
    }
    if (chest.chestRare) pushFeed({ chest: 1, name: body.name || "Unnamed", rare: 1 });
    fxAt(chest.x, chest.y, chest.chestRare ? "chestrare" : "chest");
}

function onBloom(b) {
    pacing.note('bloom');
    pushFeed({ bloom: 1, name: compass(b.x, b.y) });
    setToastAndSay("An ore bloom opened up in " + compass(b.x, b.y) + ". The veins there are extra rich for 100 seconds.", 6000);
    fxAt(b.x, b.y, "bloom");
}

function onEvent(ev) {
    pacing.note(ev.kind);
    if (ev.kind === 'meteor') {
        pushFeed({ event: 1, kind: 'meteor', name: ev.where });
        setToastAndSay("A meteor shower is coming down over " + ev.where + ", and it brings ore with it.", 6000);
    } else {
        pushFeed({ event: 1, kind: 'rain', name: ev.where });
        setToastAndSay("Gems are raining down over the safe zone for 25 seconds!", 6000);
    }
}

// ── raid perks (terrain/raidPerks.js) ─────────────────────────────────────
// Every 5,000 points on the board is a pick of three perks. The build sits on
// the board row (raidStats), so it outlives every death in the raid, follows
// a reconnect (claimResume re-keys the row) and is gone when the rows are:
// a new raid, or the /raidreset staging wipe. An offer still open when you
// die is still open when you drop back in, and milestones reached together
// queue up behind it. Bots take a random pick a few seconds later.
// ROYALE_PERKS=0 switches the whole thing off.
const PERKS_ON = process.env.ROYALE_PERKS !== '0';
const PERK_TICK_MS = 250;
const BOT_PICK_MIN_MS = 2500, BOT_PICK_MAX_MS = 7000;
function perkBuildOf(s) {
    if (!s) return null;
    if (!s.perks) s.perks = raidPerks.newBuild();
    return s.perks;
}
function applyPerks(body, s) {
    if (!body) return;
    const st = s || (statKeyFor(body) ? raidStats.get(statKeyFor(body)) : null);
    guard('perks apply', () => raidPerks.applyToBody(body, PERKS_ON && st ? perkBuildOf(st) : null));
}
// The PK packet: the offer (if any), how many wait behind it, the build and
// the next milestone. Sent whenever any of it changes.
function sendPerks(client, build) {
    if (!client || !client.talk) return;
    client._pkSentB = build || null;
    client._pkSentV = build ? build.v : -1;
    try { client.talk('PK', JSON.stringify(raidPerks.snapshot(build))); } catch { /* */ }
}
// PKP: the client picked `id`. Anything not on its current offer is refused
// and the real offer is sent again, so a stale card can't stick.
function pickPerk(socket, id) {
    if (!PERKS_ON || !socket || typeof id !== 'string' || raidEnding || staging()) return false;
    const s = socket.id ? raidStats.get("s:" + socket.id) : null;
    const b = s ? perkBuildOf(s) : null;
    if (!b) return false;
    if (!raidPerks.pick(b, id)) { sendPerks(socket, b); return false; }
    const body = socket.player && socket.player.body;
    if (body && !body.isDead?.()) applyPerks(body, s);
    sendPerks(socket, b);
    return true;
}
let perkTickAt = 0;
function tickPerks(t, frozen = false) {
    if (!PERKS_ON) return;
    const dt = Math.min(1000, t - (perkTickAt || t));
    perkTickAt = t;
    // milestones (not while the board is frozen: staging, raid over)
    if (!frozen) {
        for (const s of raidStats.values()) {
            const b = perkBuildOf(s);
            const got = raidPerks.syncScore(b, scoreOf(s));
            if (s.isBot) {
                if (got && !b.botPickAt) b.botPickAt = t + BOT_PICK_MIN_MS + Math.random() * (BOT_PICK_MAX_MS - BOT_PICK_MIN_MS);
                if (b.offer && b.botPickAt && t >= b.botPickAt) {
                    raidPerks.botPick(b);
                    b.botPickAt = b.offer ? t + BOT_PICK_MIN_MS : 0;
                }
            }
        }
    }
    // every body wears its row's build (a respawn, a resume, a new raid)
    for (const body of combatants()) {
        const key = statKeyFor(body);
        const s = key ? raidStats.get(key) : null;
        const b = PERKS_ON && s ? perkBuildOf(s) : null;
        if (body._pkBuild !== b || body._pkV !== (b ? b.v : -1)) applyPerks(body, s);
        if (!frozen) raidPerks.tickBody(body, t, dt);
    }
    // and every client hears about its own
    for (const client of connectedClients()) {
        const s = client.id ? raidStats.get("s:" + client.id) : null;
        const b = s ? s.perks || null : null;
        if (client._pkSentB !== b || client._pkSentV !== (b ? b.v : -1)) sendPerks(client, b);
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
    grantReward(body, REWARDS.shop.pts, REWARDS.shop.dustMilli, "shop buy");
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
    // achievements: tank upgrades and stat points on this body
    if (body.socket && !body._achWired && typeof body.on === 'function') {
        body._achWired = true;
        body.on('upgrade', (e) => guard('ach upgrade', () => achHooks.onUpgrade(body, e && e.tier, body.label)));
        // Tier 4: build its Tier 5 mockups ahead (terrain/tier5.js warm)
        body.on('upgrade', () => guard('t5 warm', () => tier5.warm(body)));
        body.on('skillUp', (stat) => guard('ach skill', () => achHooks.onSkillUp(body, stat)));
    }
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
    // fairPlay: how long the storm should take to reach a human's landing spot (the
    let spawnProt = false;
    if (body.socket) {
        try {
            spawnProt = fairPlay.on() && !fairPlay.isOut(body.socket) && fairPlay.protects({
                stage: body.socket._nx && body.socket._nx.raid === raidId ? body.socket._nx.stage : 3,
                newness: newnessOf(body.socket, body), struggle: fairPlay.struggleOf(body.socket, raidId) });
        } catch { /* */ }
    }
    if (home) {
        let inStorm = false;
        try {
            inStorm = storm.inStorm(home.x, home.y) || !fairPlay.edgeSafe(home.x, home.y, storm.snapshot()) || !spawnSafeAt(home.x, home.y);
            // nor into a boss's lap or next to a tank that farmed them: fairPlay)
            if (!inStorm && body.socket) { const dg = spawnDanger(body, combatants(), now()); if (dg && dg.homeBad(home.x, home.y)) inStorm = true; }
            const want = body.socket ? fairPlay.spawnEtaWant(spawnProt, true) : 0;
            if (!inStorm && want > 0 && storm.etaFn(now(), want)(home.x, home.y) < want) inStorm = true;
        } catch { /* */ }
        if (!inStorm) {
            homeSpawn = true;
            occupy.delete(occKey(home, body));
            moveTo(body, home.x + (Math.random() - 0.5) * 30, home.y + (Math.random() - 0.5) * 30);
            try { body.sendMessage("You're back at your base. You can stay here for 10 seconds."); } catch { /* */ }
        }
    }
    if (!homeSpawn && !mateSpawn) {
        // a new player who has not banked yet lands near a vault (dropIn.js)
        let near = null;
        // and someone still losing every life: fairPlay.isProtected)
        const fairNew = spawnProt;
        const etaWant = body.socket && !keepSpot ? fairPlay.spawnEtaWant(spawnProt) : 0;
        // both pickers skip anywhere the safe-spawn rules rule out: fairPlay)
        let dg0 = null;
        if (body.socket && !keepSpot) { try { dg0 = spawnDanger(body, combatants(), now()); } catch (e) { guardLog('spawn danger', e); } }
        const avoid = dg0 ? dg0.near : null;
        if (body.socket && !keepSpot && (isNewPlayer(body.socket, body) || fairNew) && !hunted.bankedThisRaid(body)) {
            try { near = dropIn.vaultSpot(body, combatants(), now(), etaWant, avoid); } catch (e) { guardLog('first vault spot', e); }
        }
        // everyone else: near the action if there's a good spot (dropIn.js)
        // (not in the Crown Contest: a respawn lands away from the crowns)
        let contest = false;
        try { contest = crowns.active(); } catch { /* */ }
        if (!near && body.socket && !keepSpot && !contest && !isNewPlayer(body.socket, body) && !fairNew) {
            try { near = dropIn.actionSpot(body, combatants(), now(), etaWant, avoid); } catch (e) { guardLog('action spot', e); }
        }
        // never right next to a tank that outclasses you, or the Core fight
        if (near && dg0 && dg0.near(near.x, near.y)) near = null;
        const hole = near || safeSpawnSpot(body, false, etaWant);
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
    guard('spawn storm check', () => {
        if (spawnSafeAt(body.x, body.y)) return;
        const h = safeSpawnSpot(body, !body.socket);
        if (!h || !spawnSafeAt(h.x, h.y)) return;
        moveTo(body, h.x, h.y);
        const tgK = global.gameManager.terrainGrid;
        if (tgK && tgK.pointInRock && tgK.pointInRock(body.x, body.y)) { const o = openGroundNear(tgK, body.x, body.y); moveTo(body, o.x, o.y); }
    });
    // a grown respawn needs more room than a spawn pocket gives
    guard('growth room', () => growRoom(body, true));
    keepOnMap(body);
    freshRaidBody(body);
    // a resumed player already had their starter kit: no second one
    const resuming = keepSpot;
    if (!resuming) giveStarterKit(body, isRespawn, freshDrop);
    // a first raid's kept half comes back, and the first respawn gets a word
    guard('newcomer spawn', () => newcomer.onSpawn(body, isRespawn && !resuming));
    // the meteor landing: rock smashed around you, gems on your first drop
    // (a fresh reload drop gets the big fall and crater, but no ore seeded)
    if (!resuming) guard('drop in', () => freshDrop ? dropIn.land(body, 0, now(), { big: true })
        : dropIn.land(body, dropIn.spillFor(!isRespawn, !!body.socket && isNewPlayer(body.socket, body))));
    if (!resumeSnap && body.socket) activity.resetClock(body.socket, now());
    try { shop.applyPassives(body); } catch { /* */ }
    // full dash charges every life, and the HUD hears about the ability slot
    guard('abilities spawn', () => require('../../terrain/abilities.js').onSpawn(body));
    const joinStat = ensureStat(body);
    // the raid's perks come back on every new body, and the HUD hears it again
    applyPerks(body, joinStat);
    if (body.socket) body.socket._pkSentV = -2;
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
            try { body.sendMessage("You came back at " + fmtGrow(Math.round(body.growthMult * 10) / 10) + " size" + (capped ? ", which is the most a respawn gives you." : ", based on a quarter of your score.")); } catch { /* */ }
        }
        if (bankIn > 0) {
            try { body.sendMessage("You brought " + bankIn.toLocaleString('en-US') + " gems to spend at shops."); } catch { /* */ }
        }
        if (!isRespawn && !resumeSnap) {
            try { chests.ensureNearSpawn(body); } catch { /* */ }
            const mod = raidMods.get();
            try {
                body.sendMessage("You're shielded for " + Math.round(SPAWN_GRACE_MS / 1000) + " seconds, and it stays up after that until you move or shoot.");
                if (!mod && !AO()) body.sendMessage("There's no override this raid.");
                if (AO()) body.sendMessage("Everything you score today counts on the daily leaderboard, and there's an event every few minutes.");
            } catch { /* */ }
        }
        try { shop.talkState(body.socket); } catch { /* */ }
        // this life counts toward "new player" from the next spawn on
        if (!resumeSnap) body.socket._royaleLives = (body.socket._royaleLives | 0) + 1;
        body._lifeCounted = true;
        if (!AO()) { try { lateJoinNote(body); } catch { } }
        // the resume itself waits for sockets.initalizePlayer to finish the
        // level-45 fill, or those level-up points would land on top of the
        // restored build (applyPendingResume)
    }
    if (AO()) guard('ao crown wait', () => crowns.onSpawn(body, now()));
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
            _fpOut: socket._fpOut || "",
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
        snap.shieldCapLeft = spawnShield.capLeft(body, t);
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
// sockets.initalizePlayer, after the level-45 fill, when no resume is pending: a
function applyRespawnBuild(socket) {
    const body = socket && socket.player && socket.player.body;
    if (!body || !Config.dig_royale || Config.tutorial) return false;
    return fairPlay.restoreBuild(socket, body, raidId);
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
            if (snap.skillRaw) {
                body.skill.set(snap.skillRaw); body.skill.points = snap.points | 0;
                // the snapshot already holds any bought Stat Points
                try { body._shopStatPts = (body.socket && body.socket.shop && body.socket.shop.statPts) | 0; } catch { /* */ }
            }
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
            try {
                inStorm = storm.inStorm(snap.x, snap.y);
                const st2 = aheadSnap(now(), 15);
                if (!inStorm && st2 && st2.a && st2.r > 0) inStorm = Math.hypot(snap.x - (st2.cx || 0), snap.y - (st2.cy || 0)) > stormRAhead(st2, 15) - 150;
            } catch (e) { inStorm = !!inStorm; }
            if (!inStorm) guard('resume spot', () => placeResumed(body, snap.x, snap.y));
            else if (snap.growEff > 0) guard('growth room', () => growRoom(body, true));
            body.health.amount = body.health.max * Math.max(0.25, Math.min(1, snap.hp || 1));
            // freshRaidBody shielded this body like a new spawn; a resume
            // keeps the old life's shield state (and what was left of its grace)
            body.invuln = !!snap.shielded;
            body.spawnGraceUntil = snap.shielded ? now() + Math.min(SPAWN_GRACE_MS, snap.graceLeft | 0) : 0;
            body.spawnMoveShieldUntil = snap.shielded && (snap.moveShieldLeft | 0) > 0 ? now() + (snap.moveShieldLeft | 0) : 0;
            if (snap.shielded && (snap.shieldCapLeft | 0) > 0) body.shieldCapAt = now() + (snap.shieldCapLeft | 0);
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
        applyPerks(body, ensureStat(body));
        try { body.sendMessage(snap.fresh ? "Reconnected. You dropped back in at a new spot." : AO() ? "Reconnected. You picked up where you left off." : "Reconnected. Your raid picked up where you left off."); } catch (e) { void e; }
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
                    try { body.sendMessage("Time's up, so you have to leave the base. You can't come back for " + Math.round(LOCKOUT_MS / 1000) + " seconds."); } catch { /* */ }
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
    const notOwner = !outposts.isOwner(site, body);
    const lockedUntil = Math.max(lockout.get(key) || 0,
        body._padReentryUntil && (!body._padReentryPad || body._padReentryPad === site) ? body._padReentryUntil : 0);
    const denied = notOwner || lockedUntil > t;
    if (!denied) return false;
    padGeom.keepOut(body, site, 3, "park:" + site.id, true);
    // say why (a player once sat on a base bank's rim for 15 s with no word)
    if (body.socket && t - (body._baseDenyAt || 0) > BASE_DENY_MSG_MS) {
        body._baseDenyAt = t;
        let owner = null;
        try { owner = site.ownerId ? entities.get(site.ownerId) : null; } catch { owner = null; }
        const text = baseDenyText(notOwner, site.ownerId ? (owner && owner.name) || "Someone" : "", Math.ceil((lockedUntil - t) / 1000));
        try { body.sendMessage(text); } catch { /* */ }
    }
    return true;
}
const BASE_DENY_MSG_MS = 4000;
// Why a base bank keeps you out
function baseDenyText(notOwner, ownerName, secs) {
    if (notOwner && ownerName) return "This is " + ownerName + "'s Team Bank. Break its banner to take it, or bank at a vault.";
    if (notOwner) return "Nobody owns this Team Bank. Break its banner to claim it, then bank here.";
    return "Your Team Bank opens again in " + Math.max(1, secs | 0) + "s.";
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
            toast("A vault is about to get stuck in the storm, bank while you can!", 5000);
            return;
        }
    }
}

function wipeWall() {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return;
    const t = now();
    let queued = 0;
    // the cap grows with the map (terrain/mapScale.js): 900 on the 16-tile one
    const cap = Math.round(900 * mapScale.area());
    tg._noRegrowZones = [];          // struts from the last raid are gone too
    for (const rock of tg.rocks.values()) {
        if (rock.alive || rock.growing) continue;
        if (!rock.diedAt) continue;
        if (rock.canyon) continue;
        rock.noRegrowUntil = 0;
        try { tg.startRegrow(rock, t + (queued % 20) * 50, 0, { fast: true }); } catch { /* */ }
        queued++;
        if (queued > cap) break;
    }
}

// Raid twists that touch the world itself: rock toughness, copper rush,
// extra emeralds, and tank sizes/speeds.
function applyModsToWorld(prev, next) {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return;
    const { ORE, ORE_HP, rockTough } = require('../../terrain/terrainGrid.js');
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
            rock.maxHealth = tg.plainRockHealth * (ORE_HP[ore] || 1) * nextHp * (rock.soft ? 1 : rockTough(rock, ore));
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
    global.royaleRaidSeq = raidId;
    raidStartAt = now();
    // bossGuard.freshSpared reads the raid's age
    global.royaleRaidStartAt = raidStartAt;
    try { achHooks.onRaidStart(raidId); } catch (e) { guardLog('ach raid start', e); }
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
    const ao = AO();
    const mod = ao ? raidMods.clear() : raidMods.roll();
    lastMods = mod;
    guard('ao mode', () => { crowns.setAlwaysOn(ao); blooms.setAuto(!ao); raidEvents.setAuto(!ao); botRoster.setAlwaysOn(ao, now()); });
    if (ao) storm.stop();
    else storm.start();
    // the final circle closes on the Core's site (coreFinale.js)
    guard('core plan', () => ao ? coreFinale.clear() : coreFinale.newRaid());
    raidEndsAt = ao ? Infinity : storm.endAt();
    if (!isFinite(raidEndsAt) && !ao) raidEndsAt = raidStartAt + RAID_MS;
    try { twistCycleSeen = storm.snapshot(now()).c | 0; } catch { /* */ }
    try { applyModsToWorld(prevMod, mod); } catch (e) { console.error('[RAID] mod apply failed', e && e.message); }
    try { bosses.resetRaid(); } catch { /* */ }
    try { botRoster.resetRaid(); } catch { /* */ }
    guard('hunted reset', () => hunted.reset());
    guard('crowns reset', () => crowns.newRaid());
    guard('sidekicks reset', () => sidekicks.reset());
    guard('drop in reset', () => dropIn.reset());
    guard('fair raid', () => fairPlay.newRaid());
    guard('supply reset', () => supplyDrops.reset());
    guard('ability drops reset', () => abilityDrops.reset());
    guard('opening', () => raidOpening.newRaid());
    try { blooms.reset(); } catch { /* */ }
    try { raidEvents.reset(); } catch { /* */ }
    try { chests.clearAll(); } catch { /* */ }
    try { contracts.reset(); } catch { /* */ }
    guard('newcomer reset', () => newcomer.newRaid());
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
                site._dmg = null; site._dmgTeam = null;
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
            // last raid's perks end with it
            guard('perks clear', () => raidPerks.clearBody(body));
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
    if (ao) {
        broadcast({ toast: "The world is open! Mine, bank and fight, and join the events that pop up every few minutes." });
        toast("Welcome! Your points today count toward the daily leaderboard.", 7000);
        return;
    }
    const twist = mod ? (" Twist: " + mod.name + ".") : "";
    broadcast({ toast: (first ? "The raid is live! Grab gems and bank them before the storm reaches you." : "A new raid has started, and the rock is growing back.") + twist });
    toast((first ? "The raid has started!" : "A new raid has started.") + twist, 7000);
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
    if (AO()) return;
    // crowns stop moving at the bell and pay out (before the board is read)
    let crownTop = [], crownRan = false;
    guard('crown finish', () => { crownRan = crowns.ran(); crownTop = crowns.finish() || []; });
    const board = boardSnapshot();
    // duos: the results are team rows ("Alex & Sam", combined score) and
    // both partners get their team's placement bonus
    const top = Config.royale_duos
        ? teamRows(board).slice(0, 10).map(t => Object.defineProperty({ id: t.ids[0], ids: t.ids, name: t.names.join(" & "), names: t.names, score: t.score, kills: t.kills, gems: t.gems, cb: t.cb, place: t.place, bot: t.bot, alive: t.alive }, '_ks', { value: t._ks }))
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
        // round 10: off by default, a raid win no longer buys a head start in the
        // next one (that was the "576 carried at the start of raid 2")
        if (PLACE_BONUS) client.raidBonus = (client.raidBonus | 0) + bonuses[place - 1];
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
    // the Core Champion: the top scorer
    // (rankHooks reads champWin), everyone gets a session win streak, and
    // the champion wears a crown by their name for 24 h (accounts: from
    // raid_results, guests: this socket)
    guard('crown champion', () => {
        if (!crownRan || !top[0] || !((top[0].score | 0) > 0)) return;
        raidResults.crowns = 1;
        const champRow = top[0];
        raidResults.champ = { id: champRow.id, name: champRow.name || "Unnamed", score: champRow.score | 0, bot: champRow.bot ? 1 : 0 };
        // duos: the winning team's partners are both champions
        const champStats = new Set((champRow._ks || [champRow._k]).map(k => k ? raidStats.get(k) : null).filter(Boolean));
        const t = now();
        for (const client of connectedClients()) {
            const st = client.id ? raidStats.get("s:" + client.id) : null;
            if (!st) continue;
            if (champStats.has(st)) {
                st.champWin = true;
                client._champUntil = t + crowns.CHAMP_MS;
                client._crownStreak = (client._crownStreak | 0) + 1;
                const b = client.player && client.player.body;
                if (b) b.champUntil = client._champUntil;
                st.champUntil = client._champUntil;
            } else if ((st.since || 0) <= t - 60_000 || (st.kills | 0) > 0 || (st.banked | 0) > 0) {
                // a raid really played without the win ends the streak
                client._crownStreak = 0;
            }
        }
    });
    // achievements: place, alive at the bell, a crown worn to the end
    guard('ach raid end', () => {
        const crownKeys = new Set(crownTop.map(c => c && c.key).filter(Boolean));
        const tEnd = now();
        earnedOrder.forEach((e, i) => {
            const client = byStat.get(e.s);
            if (!client) return;
            const played = (e.s.since || tEnd) <= tEnd - 120_000 || (e.s.kills | 0) > 0 || (e.s.banked | 0) > 0;
            achHooks.onRaidEnd(client, { place: e.place || i + 1, alive: !!e.s.alive, crown: crownKeys.has(e.s.key), played });
        });
    });
    // ranked: every open life settles now (the carried half counts), then the
    // placement bonus; all before the mass death below
    try { rankHooks.onRaidEnd(); } catch (e) { guardLog('rank raid end', e); }
    try {
        const names = top.slice(0, 3).map((r, i) => "#" + (i + 1) + " " + r.name).join(", ");
        const champ = raidResults.champ ? raidResults.champ.name + " is the Core Champion! " : "";
        global.gameManager.socketManager.broadcast(champ + "The raid is over! Top players: " + (names || "nobody scored") + ". A new raid is starting.");
    } catch { /* */ }
    // time stops: every tank and every shot holds where it is. godmode, not
    // invuln: invuln makes a tank blink on every screen
    for (const body of combatants()) {
        try { setFrozen(body, true); body.invuln = false; body.godmode = true; } catch { /* */ }
    }
    freezeShots();
    broadcast({ toast: "The raid is over. The next one starts in " + Math.round((RAID_END_BEAT_MS + RAID_END_WAIT_MS) / 1000) + " seconds." });
    raidEnding = true;
    const winner = top[0] ? top[0].name || "Unnamed" : "";
    for (const client of connectedClients()) {
        const sub = !winner ? "Nobody scored" : raidResults.champ ? winner + " is the Core Champion with " + (raidResults.champ.score | 0).toLocaleString('en-US') + " pts" : "#1 " + winner;
        try { client.talk('KC', 'raidend', 'RAID OVER', 0, sub); } catch { /* */ }
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
                if (cut > 0) { try { client.talk('m', 8000, "You can carry up to " + bank.cap().toLocaleString('en-US') + " banked gems into a new raid, so the other " + cut.toLocaleString('en-US') + " are gone."); } catch { /* */ } }
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
let debugEndForced = false;
function humansPlayed(endAt) {
    for (const st of raidStats.values()) {
        if (!st.isBot && (st.since || 0) <= endAt - 30000) return true;
    }
    return false;
}

// ── Raid Night staging (Discord /raidreset) ─────────────────────────────
// The raid resets on the spot and everyone waits for the start, safe: no
// storm, bosses, bots, events or abilities, nobody can be hurt, and whatever
// gets banked while waiting is handed back. Then the raid starts for
// everyone at once (a normal new raid, sky drop included).
let stagingUntil = 0, stagingSaid = -1;
let stageWipeAt = 0;            // the raid board empties once the reset deaths have gone through
let stageGoAt = 0;              // the start: everyone went down again, the raid begins at this
let stageBots = true;           // /raidreset bots:off: the staged raid runs humans only
let botsOffRaid = 0;            // the raidId that runs without bots
const STAGE_DOWN_MS = 1200;
let stageLobby = null;          // { x, y, r } the little circle everyone waits in
const STAGE_LOBBY_R = 430;
const STAGE_LOBBY_KEEP = 0.12;  // share of the rock inside that stays, a few bits of cover
function staging() { return stagingUntil > 0; }
// a small clearing in the middle of the map: nearly all rock inside goes
function carveStageLobby() {
    const lp = lobbyPos();
    const L = { x: +lp.x || 0, y: +lp.y || 0, r: STAGE_LOBBY_R };
    const g = global.gameManager.terrainGrid;
    if (g && g.rocks) {
        for (const rock of g.rocks.values()) {
            if (!rock || !rock.alive || rock.canyon) continue;
            const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
            if ((rx - L.x) ** 2 + (ry - L.y) ** 2 > L.r * L.r) continue;
            // a few stay, picked by position so every server picks the same
            const h = Math.abs(Math.sin(rx * 12.9898 + ry * 78.233) * 43758.5453) % 1;
            if (h < STAGE_LOBBY_KEEP) continue;
            try { g.damageRock(rock, rock.health + 1, rx, ry, false, null); } catch { /* */ }
            rock.noRegrowUntil = Math.max(rock.noRegrowUntil || 0, stagingUntil + 5000);
        }
    }
    stageLobby = L;
}
function intoStageLobby(body) {
    const L = stageLobby;
    if (!L) return;
    const dx = body.x - L.x, dy = body.y - L.y, d = Math.hypot(dx, dy);
    if (d > L.r + 250) {
        // just spawned somewhere else: drop in somewhere inside
        const a = Math.random() * Math.PI * 2, rr = L.r * 0.7 * Math.sqrt(Math.random());
        let x = L.x + Math.cos(a) * rr, y = L.y + Math.sin(a) * rr;
        const g = global.gameManager.terrainGrid;
        if (g && g.pointInRock && g.pointInRock(x, y)) { try { const o = openGroundNear(g, x, y); x = o.x; y = o.y; } catch { /* */ } }
        moveTo(body, x, y);
        body.velocity.x = 0; body.velocity.y = 0;
        return;
    }
    // the fence: a smooth wall. Only the outward part of the motion stops,
    // so a tank pressing on it just slides along, no bounce, no snap back.
    const R = L.r - 20;
    if (d <= R - 30 || !(d > 0)) return;
    const ux = dx / d, uy = dy / d;
    const vOut = body.velocity.x * ux + body.velocity.y * uy;
    if (vOut > 0) { body.velocity.x -= vOut * ux; body.velocity.y -= vOut * uy; }
    if (body.accel) {
        const aOut = body.accel.x * ux + body.accel.y * uy;
        if (aOut > 0) { body.accel.x -= aOut * ux; body.accel.y -= aOut * uy; }
    }
    if (d > R) { body.x = L.x + ux * R; body.y = L.y + uy * R; }
}
// Everyone goes down at once, the raid-end way: nothing drops, no kill, the
// ranked life settles as usual, and they come back fresh (score 0, base size).
function downEveryone(msg) {
    for (const b of humans()) {
        downForRaidEnd(b);
        try { if (b.socket) b.socket.talk('m', 6000, msg); } catch { /* */ }
    }
}
function holdForStaging(body) {
    if (body.health && body.health.amount <= 0) return;
    if (!body.socket) {
        // bots sit it out; fillBots brings them back when the raid starts
        body.carriedGems = 0;
        body.dontSendDeathMessage = true;
        body.deathCause = "despawn";
        try { body.kill(); } catch { /* */ }
        return;
    }
    body.godmode = true;
    body.royaleLobby = true;
    if (body.socket._stageBank == null) body.socket._stageBank = body.socket.gemBanked | 0;
    try { intoStageLobby(body); } catch (e) { guardLog('stage lobby move', e); }
}
function beginStaging(ms, opts = {}) {
    if (AO()) return 0;
    ms = Math.max(0, Math.min(30 * 60_000, +ms || 0));
    stageBots = opts.bots !== false;
    // a server that never started a raid would start one mid-wait otherwise
    if (!raidId) startRaid(true);
    raidEnding = false;
    raidResults = null;
    raidEndsAt = Infinity;
    try { storm.stop(); } catch { /* */ }
    guard('staging core', () => coreFinale.clear());
    guard('staging crowns', () => crowns.newRaid());
    guard('staging bosses', () => bosses.resetRaid());
    guard('staging chests', () => chests.clearAll());
    guard('staging supply', () => supplyDrops.reset());
    guard('staging ability drops', () => abilityDrops.reset());
    guard('staging events', () => raidEvents.reset());
    guard('staging blooms', () => blooms.reset());
    guard('staging contracts', () => contracts.reset());
    for (const c of connectedClients()) c._stageBank = c.gemBanked | 0;
    stagingUntil = now() + ms;
    stageGoAt = 0;
    guard('stage lobby', () => carveStageLobby());
    downEveryone(ms > 0 ? "The raid was reset, so everyone starts fresh. Wait in the lobby until it begins."
        : "The raid was reset, so everyone starts fresh.");
    stageWipeAt = now() + STAGE_DOWN_MS;
    _combAt = 0;   // a fresh list: a tank that joined this tick is caught too
    for (const b of combatants()) holdForStaging(b);
    stagingSaid = -1;
    console.log('[RAID] Staging: the raid starts in ' + Math.round(ms / 1000) + ' s.');
    return stagingUntil;
}
function tickStaging(t) {
    if (stageWipeAt && t >= stageWipeAt) { stageWipeAt = 0; raidStats = new Map(); }
    // the start never waits on anything else going wrong: everyone down once
    // more (whatever they did in the lobby is gone), then the raid begins
    if (stageGoAt) { if (t >= stageGoAt) endStaging(); return; }
    if (t >= stagingUntil) {
        downEveryone("The raid is starting! Everyone drops in fresh.");
        stageGoAt = t + STAGE_DOWN_MS;
        return;
    }
    for (const b of combatants()) { try { holdForStaging(b); } catch (e) { guardLog('staging hold', e); } }
    const left = Math.max(0, Math.ceil((stagingUntil - t) / 1000));
    // a line every minute, then every second of the last ten
    const say = left <= 10 ? left : Math.ceil(left / 60) * 60;
    if (say !== stagingSaid && (left <= 10 || left % 60 === 0 || stagingSaid < 0)) {
        stagingSaid = say;
        const txt = left <= 0 ? "" : left <= 10 ? "The raid starts in " + left + (left === 1 ? " second." : " seconds.")
            : "The raid starts in " + Math.ceil(left / 60) + " minute" + (Math.ceil(left / 60) === 1 ? "" : "s") + ". Nobody can get hurt until then.";
        if (txt) setToastAndSay(txt, 6000);
    }
    if (t >= stagingUntil) endStaging();
}
function endStaging() {
    stagingUntil = 0;
    stageGoAt = 0;
    stageWipeAt = 0;
    stageLobby = null;
    for (const c of connectedClients()) {
        if (c._stageBank != null) { c.gemBanked = c._stageBank; c._stageBank = null; }
    }
    for (const b of combatants()) {
        b.godmode = false;
        b.royaleLobby = false;
        b.carriedGems = 0;
    }
    setToastAndSay("The raid has started! Good luck.", 5000);
    restartQuietly(true);
    // humans only, for this raid (the next one fills with bots as usual)
    botsOffRaid = stageBots ? 0 : raidId;
}

// The raid ran out with no one to watch it end: the same reset endRaid does
// after its results, without the results.
function restartQuietly(fromStaging) {
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
    console.log('[RAID] Raid ' + raidId + (fromStaging ? ' staged, starting now.' : ' ran out with no players, starting a new one.'));
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
    return s ? progressOf(s) + (s.growBonus | 0) : 0;
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
// Tier 5 just opened for this life (terrain/tier5.js): a gold card for a player
function onTier5(body) {
    if (body.socket) {
        guard('t5 card', () => body.socket.talk('KC', 'tier5', 'Tier 5 unlocked!', 0, tier5.bodyTier(body) === 4 ? 'Pick a Tier 5 tank from your upgrades.' : 'You keep it for this life. In a new life you need to grow to 2x again.'));
        return;
    }
    if (body.isBot) guard('t5 bot', () => botTanks.tier5Up(body, global.gameManager && global.gameManager.gameHandler));
}

function onGrown(body, stage, idx) {
    if (!body.socket) return;
    guard('ach grow', () => achHooks.onGrow(body, stage));
    const sub = stage >= growth.RESPAWN_CAP && stage < 2.3 ? "When you respawn, you come back at a size based on a quarter of your score, up to " + fmtGrow(growth.RESPAWN_CAP) + "."
        : "You hit harder and have more health and a wider view, but you're a little slower.";
    try { body.socket.talk('KC', "grown", "You grew to " + fmtGrow(stage), 0, sub); } catch { /* */ }
}

function tick() {
    if (!Config.dig_royale) return;
    const t = now();
    if (!raidId) startRaid(true);
    if (stagingUntil) {
        guard('staging', () => tickStaging(t));
        // the wipe empties everyone's build: bodies and HUDs catch up here
        if (t - perkTickAt >= PERK_TICK_MS) guard('perks', () => tickPerks(t, true));
        if (stagingUntil && t - (tick._broadcastAt || 0) >= 500) { tick._broadcastAt = t; guard('broadcast', () => broadcast({ staging: Math.max(0, stagingUntil - t) })); }
        return;
    }
    const ao = AO();
    if (!ao) twistCycleWatch(t);
    if (!ao && t >= raidEndsAt && !raidResults) {
        // Nobody human played this one (an empty server, or someone who
        // joined in the last few seconds): no RAID OVER for "Nobody", just
        // a fresh raid. Same if the end is long overdue (the loop slept).
        const forced = debugEndForced;
        debugEndForced = false;
        if (!forced && (!humansPlayed(raidEndsAt) || t - raidEndsAt > 5000)) restartQuietly();
        else endRaid();
        return;
    }
    if (raidResults && t - raidResultsAt > RAID_END_BEAT_MS + RAID_END_WAIT_MS) raidResults = null;
    // coalesced DU packets and the 5 s dust flush (accounts)
    guard('accounts', () => rankHooks.tick(t));
    guard('bank', () => bank.tick(t, connectedClients(), heldBanks()));
    if (t - (tick._resumeAt || 0) >= 2000) { tick._resumeAt = t; guard('resume expiry', () => tickResumeExpiry(t)); }
    if (Config.royale_duos) guard('duos', () => { duo.tick(t); tickTeamBots(t); });
    // before the raid-end return: the freeze has to hide them too
    guard('sidekicks', () => sidekicks.tick(t, humans(), connectedClients()));
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
    if (!ao) guard('storm', () => { storm.ensureActive(); storm.tickDamage(t); });
    guard('spawn rescue', () => tickSpawnRescue(t));
    guard('outposts', () => tickOutpostRules(t));
    guard('vaults', () => tickVaultPinch(t));
    guard('bots', () => fillBots());
    guard('saves', () => saveCodes.tick(t, connectedClients()));
    const fighters = combatants();
    guard('growth', () => growth.tick(t, fighters, growthScore, onGrown, growRoom));
    guard('tier5', () => { for (const b of fighters) if (tier5.note(b)) onTier5(b); });
    try { bosses.tick(t, fighters.length); } catch (e) { /* */ }
    try { blooms.tick(t); } catch (e) { /* */ }
    try { raidEvents.tick(t); } catch (e) { /* */ }
    try { chests.schedule(); } catch (e) { /* */ }
    guard('contracts', () => contracts.tick(t));
    guard('pacing', () => pacing.tick(t));
    guard('hunted', () => hunted.tick(t, fighters));
    guard('core', () => coreFinale.tick(t, fighters));
    guard('crowns', () => crowns.tick(t));
    guard('achievements', () => achHooks.tick(t));
    guard('drop in', () => dropIn.tick(t));
    guard('supply', () => supplyDrops.tick(t));
    guard('opening', () => raidOpening.tick(t));
    guard('newcomer', () => newcomer.tick(t));
    if (ao) {
        guard('always on', () => alwaysOn.tick(t, fighters));
        if (!aoCurveAt) aoCurveAt = t;
        if (t - aoCurveAt >= RAID_MS) { aoCurveAt = t; guard('ao curve', () => rankHooks.newCurve && rankHooks.newCurve()); }
        if (t - (tick._aoPlayAt || 0) >= 1000) {
            const dt = tick._aoPlayAt ? Math.min(3000, t - tick._aoPlayAt) : 0;
            tick._aoPlayAt = t;
            for (const b of fighters) {
                if (!b.socket) continue;
                const k = statKeyFor(b), rs = k ? raidStats.get(k) : null;
                if (rs) rs.aoPlayMs = (rs.aoPlayMs || 0) + dt;
            }
        }
    }
    if (t - perkTickAt >= PERK_TICK_MS) guard('perks', () => tickPerks(t));
    for (const body of fighters) {
        const key = statKeyFor(body);
        const s = key ? raidStats.get(key) : null;
        if (s) { s.alive = true; s.lastSeen = t; }
    }
    if (t - (tick._botDiffAt || 0) >= 1000) {
        tick._botDiffAt = t;
        for (const body of fighters) if (body.socket) guard('bot difficulty', () => stampBotDifficulty(body));
        // 50 points still in hand 20 s into a life: a balanced build (autoStats.js)
        for (const body of fighters) if (body.socket && body._autoStatsAt) guard('auto stats', () => autoStats.tick(body, t));
        guard('fair runaway', () => stampRunaways(fighters));
        // a first kill for someone still without one (fairPlay bait)
        guard('fair first kill', () => fairPlay.tickFirstKill(fighters.filter(b => b.socket && b.isPlayer),
            fighters.filter(b => b.isBot && !b.isTeamBot), t, scoreOfBody));
        // a dead stretch for one player: a rich vein close by (quietVein.js)
        if (!stormLocked()) guard('quiet vein', () => quietVein.tick(fighters.filter(b => b.socket && b.isPlayer), scoreOfBody, raidId, t));
        // a death in the storm's spawn lock hears the moment it's over
        if (!stormLocked()) {
            for (const c of connectedClients()) {
                if (!c._fpLockWait) continue;
                c._fpLockWait = false;
                const b = c.player && c.player.body;
                if (!b || b.isDead?.()) { try { c.talk('m', 5000, "The new circle is open, so you can drop back in."); } catch { /* */ } }
            }
        }
    }
    for (const s of raidStats.values()) {
        if (t - s.lastSeen > 30000) s.alive = false;
    }
    if (t - (tick._sweepAt || 0) > 30000) {
        tick._sweepAt = t;
        for (const [k, s] of raidStats) {
            // a stat with an open ranked life (a disconnect waiting out its
            // resume window) stays until that life settles
            // and a row with points stays until the raid ends: a high scorer down for five
            if (!s.alive && !s.lifeOpen && t - (s.lastSeen || 0) > 5 * 60 * 1000 && !keepRow(s)) raidStats.delete(k);
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
    if (AO()) return alwaysOn.stormFlee(body);
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
    DigRoyale, canSpawn, spawnWhy, requestPlay, onHumanJoin, onCombatantDead, markHumanDeath, disconnectCleanup, phase, isLobbyPhase, stormFleePoint,
    lobbyPos, tick, beginStaging, staging, onBanked, onCapture, FILL_CAP, stormLocked, boardSnapshot, scoreOf, scoreParts, botDimScore, quickDeath, baseWall, claimResume, applyPendingResume, applyRespawnBuild, resumeTeam, baseReserved,
    addGrowth, growthScore, earnedOf, boardOrder,
    // round 10: late-raid kill points, the leader bounty, no cross-raid head start
    killStageMult, PLACE_BONUS, KILL_SCORE, STREAK_EARLY_PTS, bankShownOf, bankWeight, bankPtsOf, BANK_SOFT, BANK_SOFT_RATE, _leaderInfo: () => leaderInfo(), _payAny: (b, n, why) => payAny(b, n, why),
    // raid perks: PKP (sockets.js), and the tests
    pickPerk, _tickPerks: (t, frozen) => tickPerks(t, frozen), _perkBuild: (body) => { const k = statKeyFor(body); return k ? perkBuildOf(raidStats.get(k)) : null; },
    // bot roster (scripts/test/botRoster.test.js)
    _fillBots: () => fillBots(), _spawnRaidBot: back => spawnRaidBot(back), _statKeyFor: b => statKeyFor(b),
    // terrain pass: a buried grown hull clears its own room (held, no payout)
    breakOutGrown: (body) => growRoom(body, true),
    onBossSpawned, onBossDead, onChestOpened, onBloom, onEvent, onShopBuy, fxAt, callout, fightersNow: () => combatants(),
    _aoBodyOfKey: (k) => aoBodyOfKey(k), _aoKeyPresent: (k) => aoKeyPresent(k), _aoRosterTick: (t) => { aoRosterAt = 0; aoRosterTick(t); },
    // sockets.js: a solo player keeps one colour through the raid's lives
    raidIdNow: () => raidId,
    FIRST_MINUTES, isNewPlayer, RESPAWN_MS, freshRaidBody, SPAWN_GRACE_MS, RAID_CYCLES, RAID_MS, RESUME_MS,
    // ROYALE_DEBUG only (sockets.js DBG): force a twist, end the raid now
    debugTwist: (id) => { if (!AO()) applyNewTwist(id); }, debugEndRaid: () => { if (!AO()) { raidEndsAt = now(); debugEndForced = true; } },
    alwaysOn: AO, aoDebugDay: () => alwaysOn.doReset(now(), true),
    // tests: a body's board row, and the raid's results once it ends
    _statOf: (body) => { const k = statKeyFor(body); return k ? raidStats.get(k) || null : null; },
    _keepRow: (s) => keepRow(s), _baseDenyText: baseDenyText, _spawnDanger: (self, bodies, t) => spawnDanger(self, bodies, t),
    _results: () => raidResults,
    // DBG core [hp 0..1]: surface the Core now, or set its health
    debugCore: (hp, by) => hp != null && hp !== '' ? coreFinale.debugHp(hp, by) : (coreFinale.debugSpawn() ? coreFinale._state() : null),
    // tests: one pass of the idle watch at time t; a twist's hand-outs
    _tickIdle: (t) => tickIdle(t), _grantTwist: (b) => grantTwist(b),
    // tests (fairPlay): a spawn pick with a storm-time floor, the storm rescue pass
    _safeSpawnSpot: (self, forBot, eta) => safeSpawnSpot(self, forBot, eta), _spawnSafeAt: (x, y, t) => spawnSafeAt(x, y, t), _tickSpawnRescue: (t) => tickSpawnRescue(t),
    _raidId: () => raidId,
    _stampRunaways: (f) => stampRunaways(f),
    _stampBotDifficulty: (b) => stampBotDifficulty(b), _checkFairOut: (b) => checkFairOut(b),
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
            stat: st ? { banked: st.banked | 0, carried: st.carried | 0, score: scoreOf(st), earned: earnedOf(st), restoredPts: st.restoredPts | 0, restoredCarry: st.restoredCarry | 0,
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
        if (AO() || raidEnding || raidResults !== null) return;
        const end = storm.debugFinal(Math.max(1, sec | 0));
        raidEndsAt = isFinite(end) ? end : now() + Math.max(1, sec | 0) * 1000;
        try { twistCycleSeen = storm.snapshot(now()).c | 0; } catch { /* */ }
    },
};
