// Fair play: the rules that keep a raid winnable for someone still finding their
'use strict';

const flag = (k) => process.env[k] !== '0';
const SW = {
    all: flag('ROYALE_FAIR_PLAY'),
    vault: flag('ROYALE_FAIR_VAULT'),
    minnow: flag('ROYALE_SMALL_FISH'),
    // a respawn keeping its tank and build: off unless ROYALE_KEEP_BUILD=1
    build: process.env.ROYALE_KEEP_BUILD === '1',
    struggle: flag('ROYALE_FAIR_STRUGGLE'),
    storm: flag('ROYALE_FAIR_STORM'),
    bots: flag('ROYALE_FAIR_BOTS'),
    first: flag('ROYALE_FAIR_FIRST_KILL'),
    bossSpawn: flag('ROYALE_FAIR_BOSS_SPAWN'),
    spawnSafe: flag('ROYALE_SPAWN_SAFE'),
    fodder: flag('ROYALE_FAIR_FODDER'),
    bankCover: flag('ROYALE_BANK_COVER'),
    // round 9: a protected player is fought once they've dealt 25% of a bot's max
    hit25: flag('ROYALE_FAIR_HIT25'),
    // round 10: every tank that killed you lately, not just a repeat killer
    pack: flag('ROYALE_FAIR_PACK'),
};
// never on the tutorial server: its lessons script the bots)
function on(k) {
    if (typeof Config !== 'undefined' && Config.tutorial) return false;
    return SW.all && (k ? SW[k] : true);
}
function setSwitch(k, v) { if (k in SW) SW[k] = !!v; }

// a share from the environment, clamped to [0, max]
function share(k, def, max) {
    const v = process.env[k];
    if (v == null || v === '') return def;
    const n = +v;
    return isFinite(n) ? Math.max(0, Math.min(max, n)) : def;
}
// a number from the environment (anything not a number: the default)
function num(k, def) {
    const v = process.env[k];
    if (v == null || v === '') return def;
    const n = +v;
    return isFinite(n) && n >= 0 ? n : def;
}
const TUNE = {
    // earned out: any one ends protection for the session (see the top)
    OUT_KILLS: num('ROYALE_FAIR_OUT_KILLS', 3),
    OUT_STREAK: num('ROYALE_FAIR_OUT_STREAK', 3),
    OUT_POINTS: num('ROYALE_FAIR_OUT_POINTS', 2500),
    OUT_HALF_ROWS: num('ROYALE_FAIR_OUT_HALF_ROWS', 4),
    OUT_HALF_PTS: num('ROYALE_FAIR_OUT_HALF_PTS', 600),
    OUT_BANKS: num('ROYALE_FAIR_OUT_BANKS', 3),
    OUT_PLAY_MS: num('ROYALE_FAIR_OUT_PLAY_MIN', 12) * 60_000,
    VAULT_ZONE: 420,          // past the drawn pad rim: "on the way in"
    VAULT_MIN_CARRY: 15,      // the vault's minimum deposit
    VAULT_AFTER_MS: 6000,     // bots still hold off this long after a deposit
    LINGER_R: 520,            // from a vault's centre
    LINGER_MS: 8000,
    LEAVE_D: 900,             // a lingering bot is sent at least this far off
    HIT_BACK_MS: 4000,        // a bot that was shot by them fights back this long
    PROVOKE_SHARE: share('ROYALE_FAIR_PROVOKE', 0.25, 1),  // ...or, with hit25, once they've dealt this share of its max health
    BIG_GROWTH: 1.45,
    PROTECT_STRUGGLE: 2,
    STRUGGLE_BANK: 300,       // banked gems that count as one good thing
    STRUGGLE_CAPS: [0.5, 0.4, 0.3, 0.2],   // difficulty cap at struggle 1, 2, 3, 4+
    MINNOW_MAX: 2,
    MINNOW_SKILL: [0.06, 0.2],
    MINNOW_STAT_SHARE: 0.6,
    MINNOW_GROWTH_CAP: 1.25,
    MINNOW_MAX_SCORE: 1500,   // a returning bot with more on the board stays a regular
    EDGE_MARGIN: 260,
    EDGE_AHEAD_S: 25,
    // seconds of storm-free time a human's landing spot should have (everyone)
    SPAWN_ETA_S: 60,
    HOME_ETA_S: 40,             // a base respawn (it's theirs, so a little less)
    RUNAWAY_MIN: 2500,
    RUNAWAY_RATIO: 1.8,
    RUNAWAY_GAP: 1500,
    RUNAWAY_PULL: 450,          // other bots rank a runaway as this much closer
    RUNAWAY_GANG_THREAT: 1.7,   // ...and take it on at up to this x their usual threat cap
    RUNAWAY_AIM: 0.6,           // its aim skill at a protected player (x)
    FARM_KILLS: 2,              // the same for every player
    FARM_MS: 180_000,
    FARM_COUNT_MS: 480_000,     // kills this far apart still add up
    FARM_SPAWN_R: 2100,         // a respawn keeps this far from a tank that farmed you
    FARM_SPAWN_MULT: 0.4,       // ...and it counts as this much closer when ranking spots
    // round 10 pack rule (everyone): any bot that killed you in the last PACK_MS
    // leaves you be for PACK_GRACE_MS of your next life (unless you shoot it),
    // and the respawn keeps clear of all of them
    PACK_MS: 180_000,
    PACK_GRACE_MS: 60_000,
    // first kill (the bait)
    FIRST_AFTER_MS: 40_000,     // into a life (a new player's bot grace is 30 s)
    FIRST_RETRY_MS: 30_000,     // after a bait died to someone else or gave up
    FIRST_GIVEUP_MS: 100_000,   // a bait that never got into it is swapped
    FIRST_FIGHT_R: 1500,        // takes them on from this close; walks over from further
    FIRST_PICK_R: 3200,         // picks a bot from this close
    FIRST_PICK_SCORE: 1500,     // never a bot with more than this on the board
    // ...and how it plays them (aim and trigger only, never damage)
    FIRST_AIM_SKILL: 0.5,       // its aim skill at the host (x)
    FIRST_AIM_ERR: 1.6,         // and its aim error (x)
    FIRST_PAUSE_MS: [380, 700], // trigger released this long between bursts
    FIRST_BURST: 0.45,          // bursts this long (x)
    FIRST_RANGE: 300,           // its standoff (no pressing in)
    FIRST_LEAVE_R: 1400,        // others leave the host alone while the bait is this close
    // bosses at spawns
    BOSS_SPAWN_R: 1400,
    MINION_SPAWN_R: 700,
    BOSS_SPAWN_MULT: 0.35,      // a boss counts as this much closer when ranking spots
    MOVE_ON_MS: 20_000,
    MOVE_ON_LOOT_MS: 3500,
    MINNOW_DUEL_R: 900,
    MINNOW_DUEL_RETREAT: 0.1,
    DUEL_MS: 4000,              // other bots stay out of a duel this long
    TOO_STRONG_STREAK: 4,
    TOO_STRONG_SCORE_X: 3,      // board score this many times theirs...
    TOO_STRONG_SCORE_MIN: 2000, // ...and at least this
    TOO_STRONG_AHEAD: 1.25,     // grown / runaway / streak only counts this far ahead of you on the board
    SPAWN_BIG_SCORE_MIN: 3000,  // a respawn keeps away from tanks with this many points...
    SPAWN_BIG_SCORE_X: 0.8,     // ...and at least this share of yours (or grown past you)
    SPAWN_BIG_GROWTH_X: 1.2,
    SPAWN_BIG_R: 900,           // from a big tank or the Core (ROYALE_SPAWN_SAFE=0: round 4's numbers)
    SPAWN_BIG_MULT: 0.7,        // a big tank counts as this much closer when ranking spots
    // round 5: a late respawn kept landing next to the tank that killed it
    SPAWN_SAFE_R: 1700,
    SPAWN_BIG_2X: 2,            // a tank with this many times your points...
    SPAWN_BIG_2X_MIN: 1500,     // ...and at least this many counts as big too
    KILLERS_KEPT: 2,            // the last this many tanks that killed you, all raid
    VAULT_OCC_R: 560,           // an enemy this close to a vault's centre holds it...
    VAULT_OCC_SPAWN_R: 1500,    // ...and a respawn keeps this far from that vault
    // when nowhere clears everything (a small late circle), the spot that breaks the
    SPAWN_W_BIG: 1, SPAWN_W_VAULT: 1.2, SPAWN_W_CORE: 1.5, SPAWN_W_BOSS: 2, SPAWN_W_KILLER: 2.5, SPAWN_W_FARM: 3,
    SPAWN_W_BAND: 0.12,         // spots this close to the least-bad one are all fine
    // a bot that served as someone's first-kill fish stays a small fish all raid
    FODDER_PTS: 0.3,            // share of kill / bonus / boss points it books
    // round 7: 4 of 10 deaths were next to a vault
    BANK_COVER_MS: 5000,        // after a deposit ends (done or cut)
    BANK_COVER_MULT: 1 - share('ROYALE_BANK_COVER_CUT', 0.15, 0.5),  // shots into anyone banking: 0.85x
    BANK_MIN_CARRY: 15,         // on the way in: worth banking
    BANK_BULLY_X: 2,            // a bot with this many times your points...
    BANK_BULLY_MIN: 400,        // ...and at least this many leaves you to bank
};

const now = () => Date.now();
function activity() { return require('../network/activity.js'); }
function vaults() {
    try { return require('./vault.js').getVaults() || []; } catch { return []; }
}
const OCT = () => { try { return require('./padGeom.js').OCT.scale || 1.4; } catch { return 1.4; } };

// ── struggle ────────────────────────────────────────────────────────────
// A per-socket tally for the session: deaths, kills and gems banked
function tally(socket, raid) {
    if (!socket) return null;
    let t = socket._fp;
    if (!t) t = socket._fp = { raid, deaths: 0, kills: 0, banked: 0, raidKills: 0, allKills: 0, banks: 0 };
    if (raid != null && t.raid !== raid) {
        t.raid = raid;
        t.deaths = Math.floor(t.deaths / 2);
        t.kills = Math.floor(t.kills / 2);
        t.banked = 0;
        t.raidKills = 0;
        t.banks = 0;
    }
    return t;
}
function noteDeath(socket, raid) { const t = tally(socket, raid); if (t) t.deaths++; }
function noteKill(socket, raid) {
    const t = tally(socket, raid);
    if (!t) return;
    t.kills++;
    t.raidKills = (t.raidKills | 0) + 1;
    t.allKills = (t.allKills | 0) + 1;
    // the first one releases their bait
    const b = socket.player && socket.player.body;
    if (b) b._fpFirst = false;
    socket._fpFirst = false;
}
function noteBank(socket, raid, amount) {
    const t = tally(socket, raid);
    if (!t) return;
    t.banked += Math.max(0, +amount || 0);
    if ((+amount || 0) > 0) t.banks = (t.banks | 0) + 1;
}
// Deaths past the first that nothing paid for: a kill is worth two, every
function struggle(t) {
    if (!t) return 0;
    return Math.max(0, (t.deaths | 0) - 1 - 2 * (t.kills | 0) - Math.floor((+t.banked || 0) / TUNE.STRUGGLE_BANK));
}
function struggleOf(socket, raid) {
    if (!on('struggle') || !socket) return 0;
    return struggle(tally(socket, raid));
}
// the most a struggling (unranked) player's bot difficulty may be
function struggleCap(s) {
    if (!(s >= 1)) return 1;
    const c = TUNE.STRUGGLE_CAPS;
    return c[Math.min(c.length - 1, (s | 0) - 1)];
}

// ── earned out ──────────────────────────────────────────────────────────
// p: { raidKills, streak, points, rank (1 = top), rows, banks, playMs } -> why
function earnedOut(p) {
    if (!p) return '';
    const T = TUNE;
    if ((p.raidKills | 0) >= T.OUT_KILLS) return 'kills';
    if ((p.streak | 0) >= T.OUT_STREAK) return 'streak';
    const pts = +p.points || 0;
    if (pts >= T.OUT_POINTS) return 'points';
    const rows = p.rows | 0, rank = p.rank | 0;
    if (rows >= T.OUT_HALF_ROWS && rank > 0 && pts >= T.OUT_HALF_PTS && rank <= Math.ceil(rows / 2)) return 'board';
    if ((p.banks | 0) >= T.OUT_BANKS) return 'banks';
    if ((+p.playMs || 0) >= T.OUT_PLAY_MS) return 'time';
    return '';
}
// dig_royale, every second (and at spawn): latch the session once any of it holds
function checkOut(socket, p) {
    if (!socket) return '';
    if (socket._fpOut) return socket._fpOut;
    const why = earnedOut(p);
    if (why) socket._fpOut = why;
    return why;
}
function isOut(socket) { return !!(socket && socket._fpOut); }

// ── who is protected ────────────────────────────────────────────────────
// p: { stage (newcomerDirector nx, 3 = veteran), newness, struggle, out }
function protects(p) {
    if (!p) return false;
    if (p.out) return false;
    if (p.stage === 0 || p.stage === 1) return true;
    if ((+p.newness || 0) > 0) return true;
    return (p.struggle | 0) >= TUNE.PROTECT_STRUGGLE;
}
function stamp(body, p) {
    if (!body) return false;
    if (p && !p.out && isOut(body.socket)) p = Object.assign({}, p, { out: true });
    body._fpProtect = on() && protects(p);
    body._fpStruggle = p ? p.struggle | 0 : 0;
    body._fpFirst = firstKillDue(body.socket, body._fpProtect, p && p.raid);
    // kept on the socket too, for while they're dead (small fish still spawn)
    if (body.socket) { body.socket._fpProtect = body._fpProtect; body.socket._fpFirst = body._fpFirst; }
    return body._fpProtect;
}

// No kill yet this raid, and protected (or a guest who has none this session at
function firstKillDue(socket, prot, raid) {
    if (!on('first') || !socket || isOut(socket)) return false;
    const t = tally(socket, raid);
    if (!t || (t.raidKills | 0) > 0) return false;
    if (prot) return true;
    const guest = !(socket.account && socket.account.id);
    return guest && !(t.allKills | 0);
}
function isProtected(body, t = now()) {
    if (!on() || !body || !body.isPlayer || !body._fpProtect) return false;
    try { if (activity().unprotected(body, t)) return false; } catch { /* */ }
    return true;
}

// ── vaults ──────────────────────────────────────────────────────────────
function zoneR(v) { return (v.r || 95) * OCT() + TUNE.VAULT_ZONE; }
function vaultNear(x, y, list = vaults(), pad = 0) {
    for (const v of list) {
        const R = zoneR(v) + pad;
        const dx = x - v.x, dy = y - v.y;
        if (dx * dx + dy * dy < R * R) return v;
    }
    return null;
}
// A protected player on the way in to bank (or just done): bots leave them be
function vaultGuarded(body, t = now(), list) {
    if (!on('vault') || !isProtected(body, t)) return false;
    const banking = !!body.vaultDeposit || (body.carriedGems | 0) >= TUNE.VAULT_MIN_CARRY ||
        t - (body._fpBankedAt || 0) < TUNE.VAULT_AFTER_MS;
    if (!banking) return false;
    return !!vaultNear(body.x, body.y, list);
}
// ── bank cover ─────────────────────────────────────────────────────────
// vault.js tick, every tick for each tank (human or bot): depositPad (the vault a
function bankStamp(body, depositPad, t = now(), list) {
    if (!body) return 0;
    if (!on('bankCover') || !(body.isPlayer || body.isBot)) { body._fpBank = 0; body._bankCover = 0; return 0; }
    if (depositPad) { body._bankCoverAt = t; body._bankCoverPad = depositPad; }
    let state = 0, cover = 0;
    const pad = body._bankCoverPad;
    if (pad && t - (body._bankCoverAt || 0) < TUNE.BANK_COVER_MS) {
        const R = zoneR(pad);
        if ((body.x - pad.x) ** 2 + (body.y - pad.y) ** 2 < R * R) {
            state = 2;
            cover = TUNE.BANK_COVER_MULT;   // the same for everyone
        }
    }
    if (!state && (body.carriedGems | 0) >= TUNE.BANK_MIN_CARRY && vaultNear(body.x, body.y, list || vaults())) state = 1;
    body._fpBank = state;
    body._bankCover = cover;
    return cover;
}
// subFunctions shotMult: the factor on a shot into `hit` (1: none)
function bankCoverMult(hit) {
    const m = hit && hit._bankCover;
    return m > 0 && m < 1 ? m : 1;
}
// A bot that has no business with someone banking: one that killed them this
function bankBully(bot, target, t = now()) {
    if (!on('bankCover') || !bot || !bot.isBot || !target || !target.isPlayer || !(target._fpBank > 0)) return false;
    if (!isProtected(target, t)) return false;
    // on the way in, shooting it first still starts the fight
    if (target._fpBank === 1 && hitBy(bot, target, t)) return false;
    const L = target.socket && target.socket._fpKillers;
    const k = L && L.keys.length ? killerKey(bot) : null;
    if (k && L.keys.includes(k)) return true;
    const m = target.socket && target.socket._fpKilledBy;
    if (m && m.size) { const e = m.get(killerKey(bot)); if (e && e.n > 0) return true; }
    const bs = +bot._fpPts || 0, ts = +target._fpPts || 0;
    return bs >= TUNE.BANK_BULLY_MIN && bs >= Math.max(1, ts) * TUNE.BANK_BULLY_X;
}
function hitBy(bot, target, t) {
    // round 9: and only once they've dealt PROVOKE_SHARE of its health
    if (SW.hit25 && !provoked(bot, target)) return false;
    return bot._lastDamageSource === target && t - (bot._lastDamageAt || 0) < TUNE.HIT_BACK_MS;
}
// round 9: has `target` dealt PROVOKE_SHARE of `bot`'s max health this life?
function dealtTo(bot, target) {
    const m = bot && target && bot._dmgBy;
    return m ? (m.get(target.id) || 0) : 0;
}
function provoked(bot, target) {
    if (!bot || !target) return false;
    const max = (bot.health && bot.health.max) || 1;
    return dealtTo(bot, target) >= max * TUNE.PROVOKE_SHARE;
}
function isBig(bot) { return !!bot && !bot.botMinnow && (bot.growthMult || 1) >= TUNE.BIG_GROWTH; }
// controllers.js (sense, canInitiateFight, fight validity, auto turrets): should
function guarded(target) { return !!target && !!(target._fpProtect || target._fpBaitBot || (target.socket && target.socket._fpBeat)); }
function spared(bot, target, t = now()) {
    if (!on() || !bot || !bot.isBot || !target || !target.isPlayer) return false;
    // a protected player banking: their killers and the big tanks wait
    if (target._fpBank && bankBully(bot, target, t)) return true;
    if (!target._fpProtect && !target._fpBaitBot && !(target.socket && target.socket._fpBeat)) return false;
    if (hitBy(bot, target, t)) return false;
    // a bot they beat (as a protected player, or as their first-kill fish) never
    if (!bot._fpBait && !isOut(target.socket) && beatBy(bot, target)) return true;
    // their bait is with them: it's theirs, nobody bails it out
    if (target._fpBaitBot && baitBusy(target, bot)) return true;
    if (!target._fpProtect) return false;
    if (vaultGuarded(target, t)) return true;
    if (!isProtected(target, t)) return false;
    if (isBig(bot)) return true;
    if (!on('bots')) return false;
    // a bot running away with the raid, or one that keeps killing them
    if (bot._fpRunaway || farmed(bot, target, t)) return true;
    // they're trading shots with a small fish: nobody else joins in
    return !bot.botMinnow && (target._fpDuelUntil || 0) > t;
}
// May a bot bank at `v` now? Not while a protected player is on the way in
function vaultFreeFor(bot, v, players, t = now()) {
    if (!on('vault') || !v) return true;
    const R = zoneR(v);
    for (const p of players || []) {
        if (!p || p === bot || !p._fpProtect || (p.isDead && p.isDead())) continue;
        if ((p.x - v.x) ** 2 + (p.y - v.y) ** 2 < R * R && vaultGuarded(p, t, [v])) return false;
    }
    return true;
}
// A point outside every vault's linger ring (pushed straight out from the vault
function outsideVaults(pt, list = vaults()) {
    if (!on('vault') || !pt) return pt;
    let x = pt.x, y = pt.y;
    for (let pass = 0; pass < 2; pass++) {
        for (const v of list) {
            const dx = x - v.x, dy = y - v.y, d = Math.hypot(dx, dy);
            if (d >= TUNE.LINGER_R) continue;
            const ux = d > 1 ? dx / d : 1, uy = d > 1 ? dy / d : 0;
            x = v.x + ux * (TUNE.LINGER_R + 40);
            y = v.y + uy * (TUNE.LINGER_R + 40);
        }
    }
    return x === pt.x && y === pt.y ? pt : Object.assign({}, pt, { x, y });
}
// Lingering: a bot inside a linger ring that isn't banking
function inRing(x, y, list = vaults()) {
    if (!on('vault')) return false;
    for (const v of list) if ((x - v.x) ** 2 + (y - v.y) ** 2 < TUNE.LINGER_R * TUNE.LINGER_R) return true;
    return false;
}
// Once sent off, the same point comes back until the bot is clear of the ring (or
function lingerCheck(bot, banking, t = now(), list = vaults()) {
    if (!on('vault') || !bot) return null;
    const lv = bot._fpLeave;
    if (lv) {
        if (!banking && t < lv.until && Math.hypot(bot.x - lv.vx, bot.y - lv.vy) < TUNE.LINGER_R + 120) return lv;
        bot._fpLeave = null;
    }
    const v = banking ? null : list.find(q => (bot.x - q.x) ** 2 + (bot.y - q.y) ** 2 < TUNE.LINGER_R * TUNE.LINGER_R);
    if (!v) { bot._fpLingerSince = 0; return null; }
    if (!bot._fpLingerSince || bot._fpLingerVault !== v) { bot._fpLingerSince = t; bot._fpLingerVault = v; return null; }
    if (t - bot._fpLingerSince < TUNE.LINGER_MS) return null;
    bot._fpLingerSince = 0;
    const dx = bot.x - v.x, dy = bot.y - v.y, d = Math.hypot(dx, dy) || 1;
    const a = Math.atan2(dy / d, dx / d) + (Math.random() - 0.5) * 1.2;
    bot._fpLeave = { x: v.x + Math.cos(a) * TUNE.LEAVE_D, y: v.y + Math.sin(a) * TUNE.LEAVE_D, until: t + 9000, vx: v.x, vy: v.y };
    return bot._fpLeave;
}

// ── bots running away with it ───────────────────────────────────────────
// score: the bot's raid board score
function isRunaway(score, humanTop, protectedIn) {
    if (!on('bots') || !protectedIn) return false;
    const s = +score || 0;
    return s >= TUNE.RUNAWAY_MIN && s >= Math.max(0, +humanTop || 0) * TUNE.RUNAWAY_RATIO + TUNE.RUNAWAY_GAP;
}
// dig_royale, about once a second: stamp bot._fpRunaway and hold a runaway's
function stampRunaway(bot, runaway) {
    if (!bot) return false;
    const was = !!bot._fpRunaway;
    bot._fpRunaway = !!runaway;
    if (runaway && !was) {
        bot._fpCapSaved = bot.growthCap || 0;
        const g = Math.max(1, bot.growthMult || 1);
        bot.growthCap = bot.growthCap > 0 ? Math.min(bot.growthCap, g) : g;
    } else if (!runaway && was) {
        bot.growthCap = bot._fpCapSaved || 0;
        bot._fpCapSaved = 0;
        if (bot._fpFodder) applyFodder(bot);
    }
    return bot._fpRunaway;
}
// another bot: how much closer a runaway target ranks, and how much more threat a
function gangPull(bot, target) {
    return on('bots') && target && target._fpRunaway && target.isBot && !bot._fpRunaway ? TUNE.RUNAWAY_PULL : 0;
}
function gangThreat(bot, target) {
    return on('bots') && target && target._fpRunaway && target.isBot && !bot._fpRunaway ? TUNE.RUNAWAY_GANG_THREAT : 1;
}
// its aim at a protected player (aim only
function aimMult(bot, target, t = now()) {
    if (!on('bots') || !bot || !bot._fpRunaway || !target || !target._fpProtect) return 1;
    return isProtected(target, t) ? TUNE.RUNAWAY_AIM : 1;
}

// ── kills: farming and moving on ───────────────────────────────────────
function victimKey(v) {
    if (!v) return null;
    if (v.socket) return 's:' + (v.socket.id != null ? v.socket.id : v.id);
    return v.id != null ? 'e:' + v.id : null;
}
// game/index.js 'kill' (a bot killed a player): count it, and if it was at a
function killerKey(k) {
    if (!k) return null;
    if (k.isBot) return 'f:' + (k.botFamilyId != null ? k.botFamilyId : k.id);
    if (k.socket) return 's:' + (k.socket.id != null ? k.socket.id : k.id);
    return null;
}
function bump(m, k, t) {
    const span = TUNE.FARM_COUNT_MS;
    const e = m.get(k);
    if (e && t - e.at < span) { e.n++; e.at = t; } else m.set(k, { n: 1, at: t });
    if (m.size > 24) for (const [kk, ee] of m) if (t - ee.at > span) m.delete(kk);
}
// the victim's side (dig_royale onCombatantDead, any killer tank): kept on the
function noteKilledBy(socket, killer, t = now(), raid = null) {
    if (!on() || !socket || !killer) return;
    const k = killerKey(killer);
    if (!k) return;
    if (on('spawnSafe')) {
        let L = socket._fpKillers;
        if (!L || L.raid !== raid) L = socket._fpKillers = { raid, keys: [] };
        const i = L.keys.indexOf(k);
        if (i >= 0) L.keys.splice(i, 1);
        L.keys.push(k);
        while (L.keys.length > TUNE.KILLERS_KEPT) L.keys.shift();
    }
    if (!on('bots')) return;
    bump(socket._fpKilledBy || (socket._fpKilledBy = new Map()), k, t);
}
// The live tanks among the last KILLERS_KEPT that killed this player this raid
function lastKillersOf(self, bodies, raid = null) {
    const out = [];
    const L = on('spawnSafe') && self && self.socket && self.socket._fpKillers;
    if (!L || !L.keys.length || (raid != null && L.raid !== raid)) return out;
    for (const b of bodies || []) {
        if (!b || b === self || (b.isDead && b.isDead()) || !(b.isBot || b.isPlayer)) continue;
        if (L.keys.includes(killerKey(b))) out.push(b);
    }
    return out;
}
function noteBotKill(bot, victim, t = now(), list = vaults()) {
    if (!on('bots') || !bot || !bot.isBot || !victim || !victim.isPlayer) return;
    const k = victimKey(victim);
    if (k) bump(bot._fpKills || (bot._fpKills = new Map()), k, t);
    if (!on('vault')) return;
    const v = list.find(q => (bot.x - q.x) ** 2 + (bot.y - q.y) ** 2 < TUNE.LINGER_R * TUNE.LINGER_R ||
        (victim.x - q.x) ** 2 + (victim.y - q.y) ** 2 < TUNE.LINGER_R * TUNE.LINGER_R);
    if (!v) return;
    const dx = bot.x - v.x, dy = bot.y - v.y, d = Math.hypot(dx, dy);
    const a = (d > 1 ? Math.atan2(dy, dx) : Math.random() * Math.PI * 2) + (Math.random() - 0.5) * 1.2;
    bot._fpMoveOn = { vault: v, vx: v.x, vy: v.y, x: v.x + Math.cos(a) * TUNE.LEAVE_D, y: v.y + Math.sin(a) * TUNE.LEAVE_D,
        lootUntil: t + TUNE.MOVE_ON_LOOT_MS, until: t + TUNE.MOVE_ON_MS };
}
// Has this bot killed `target` enough lately to leave them be? (either side's
function farmEntry(bot, target) {
    const a = bot._fpKills ? bot._fpKills.get(victimKey(target)) : null;
    const m = target.socket && target.socket._fpKilledBy;
    const b = m ? m.get(killerKey(bot)) : null;
    if (!a) return b || null;
    if (!b) return a;
    return a.n >= b.n ? a : b;
}
// the same limit for every player)
function farmedRaw(bot, target, t) {
    const e = farmEntry(bot, target);
    if (!e) return false;
    if (e.n >= TUNE.FARM_KILLS && t - e.at < TUNE.FARM_MS) return true;
    return packFresh(bot, target, e, t);
}
// the pack rule: a bot that killed `target` lately, early in their next life
function packFresh(bot, target, e, t) {
    if (!on('pack') || !bot || !bot.isBot || !e || !(e.n > 0) || t - e.at >= TUNE.PACK_MS) return false;
    const born = +target.royaleBornAt || 0;
    return born > 0 && born >= e.at && t - born < TUNE.PACK_GRACE_MS;
}
function farmed(bot, target, t = now()) {
    if (!on('bots') || !bot || !target || !target.isPlayer) return false;
    if (!bot._fpKills && !(target.socket && target.socket._fpKilledBy)) return false;
    if (hitBy(bot, target, t)) return false;
    return farmedRaw(bot, target, t);
}
// The live tanks that farmed this player lately (for their respawn spot)
function farmersOf(self, bodies, t = now()) {
    const out = [];
    if (!on('bots') || !self || !self.socket || !self.socket._fpKilledBy) return out;
    for (const b of bodies || []) {
        if (!b || b === self || (b.isDead && b.isDead()) || !(b.isBot || b.isPlayer)) continue;
        const e = self.socket._fpKilledBy.get(killerKey(b));
        if (!e) continue;
        // a repeat killer, or (pack rule) anyone who killed you in the last PACK_MS
        if ((e.n >= TUNE.FARM_KILLS && t - e.at < TUNE.FARM_MS) || (on('pack') && e.n > 0 && t - e.at < TUNE.PACK_MS)) out.push(b);
    }
    return out;
}
// The point to walk off to after a kill at a vault (once the loot window is over
function moveOnPoint(bot, t = now()) {
    const m = bot && bot._fpMoveOn;
    if (!m) return null;
    if (t >= m.until) { bot._fpMoveOn = null; return null; }
    if (t < m.lootUntil) return null;
    if (Math.hypot(bot.x - m.vx, bot.y - m.vy) > TUNE.LINGER_R + 120) return null;
    return m;
}
// ownVault: the vault this bot should bank somewhere other than right now
function avoidVault(bot, v, t = now()) {
    const m = bot && bot._fpMoveOn;
    return !!(m && t < m.until && m.vault === v);
}

// ── small fish duels ────────────────────────────────────────────────────
// A small fish close to a protected player: stand and trade
function minnowDuel(bot, target, t = now()) {
    if (bot && bot._fpBait && target && baitHost(bot, t) === target) return true;
    if (!on('bots') || !on('minnow') || !bot || !bot.botMinnow || !target || !target.isPlayer || !target._fpProtect) return false;
    if (Math.hypot(target.x - bot.x, target.y - bot.y) > TUNE.MINNOW_DUEL_R) return false;
    return isProtected(target, t);
}
// the bot is in it with them: others hold off for DUEL_MS
function noteDuel(target, t = now()) { if (target) target._fpDuelUntil = t + TUNE.DUEL_MS; }

// ── first kill: the bait ───────────────────────────────────────────────
// bot._fpBait = { sock, since, engagedAt }; the host body (whatever life they're
const aliveBody = (b) => !!b && !(b.isDead && b.isDead()) && !b.isGhost;
function hostBody(sock) { const b = sock && sock.player && sock.player.body; return b && b.isPlayer && aliveBody(b) ? b : null; }
// the host this bot is bait for, if they're alive and it's still on
function baitHost(bot, t = now()) {
    const bt = bot && bot._fpBait;
    if (!bt || !on('first')) return null;
    const h = hostBody(bt.sock);
    if (!h || h._fpBaitBot !== bot) return null;
    try { if (activity().unprotected(h, t)) return null; } catch { /* */ }
    return h;
}
function isBaitPair(bot, target, t) { return !!(bot && bot._fpBait && target && baitHost(bot, t) === target); }
// another bot near `host` while their bait is close to them
function baitBusy(host, other) {
    const bait = host._fpBaitBot;
    if (!bait || bait === other || !aliveBody(bait) || !bait._fpBait || hostBody(bait._fpBait.sock) !== host) return false;
    return (bait.x - host.x) ** 2 + (bait.y - host.y) ** 2 < TUNE.FIRST_LEAVE_R * TUNE.FIRST_LEAVE_R;
}
// other bots never pick a bait on duty (they'd steal the kill)
function baitOnDuty(bot, t = now()) { return !!(bot && bot._fpBait && baitHost(bot, t)); }
function assignBait(bot, host, t = now()) {
    if (!bot || !host || !host.socket) return false;
    if (bot._fpBait) releaseBait(bot);
    if (host._fpBaitBot && host._fpBaitBot !== bot) releaseBait(host._fpBaitBot);
    bot._fpBait = { sock: host.socket, since: t, engagedAt: 0 };
    bot.botMinnow = true;
    markFodder(bot, host);
    host._fpBaitBot = bot;
    host.socket._fpBaitBot = bot;
    return true;
}
function releaseBait(bot, retryAt = 0) {
    if (!bot || !bot._fpBait) return;
    const sock = bot._fpBait.sock;
    bot._fpBait = null;
    if (sock) {
        if (sock._fpBaitBot === bot) sock._fpBaitBot = null;
        const h = sock.player && sock.player.body;
        if (h && h._fpBaitBot === bot) h._fpBaitBot = null;
        if (retryAt) sock._fpBaitNext = retryAt;
    }
}
// dig_royale, about once a second
function tickFirstKill(humans, bots, t = now(), scoreOf = () => 0) {
    if (!on('first')) {
        for (const b of bots || []) if (b && b._fpBait) releaseBait(b);
        return;
    }
    // the baits out there: still wanted, still alive, still going
    const taken = new Set();
    for (const b of bots || []) {
        if (!b || !b._fpBait) continue;
        const sock = b._fpBait.sock;
        const connected = sock && sock.player && !sock.terminated;
        if (!connected || !sock._fpFirst) { releaseBait(b); continue; }
        const h = hostBody(sock);
        if (h) {
            if (h._fpBaitBot !== b) h._fpBaitBot = b;
            const d = Math.hypot(h.x - b.x, h.y - b.y);
            if (d < 900 && !b._fpBait.engagedAt) b._fpBait.engagedAt = t;
            if (!b._fpBait.engagedAt && t - b._fpBait.since > TUNE.FIRST_GIVEUP_MS) { releaseBait(b, t + TUNE.FIRST_RETRY_MS); continue; }
        }
        taken.add(sock);
    }
    // a bait that died (to anyone): another one later
    for (const h of humans || []) {
        const sock = h && h.socket;
        if (!sock) continue;
        const bb = sock._fpBaitBot;
        if (bb && (!aliveBody(bb) || !bb._fpBait)) {
            sock._fpBaitBot = null;
            if (h._fpBaitBot === bb) h._fpBaitBot = null;
            if (!(t < (sock._fpBaitNext || 0))) sock._fpBaitNext = t + TUNE.FIRST_RETRY_MS;
        }
    }
    for (const h of humans || []) {
        const sock = h && h.socket;
        if (!sock || !aliveBody(h) || !h._fpFirst || taken.has(sock) || sock._fpBaitBot) continue;
        if (t < (sock._fpBaitNext || 0)) continue;
        if (!h.royaleBornAt || t - h.royaleBornAt < TUNE.FIRST_AFTER_MS) continue;
        try { if (activity().unprotected(h, t)) continue; } catch { /* */ }
        let best = null, bestScore = Infinity;
        for (const b of bots || []) {
            if (!aliveBody(b) || !b.isBot || b._fpBait || b.isTeamBot || b._fpRunaway || isBig(b)) continue;
            if (!b.botArmed || (h.team != null && b.team === h.team)) continue;
            if ((+scoreOf(b) || 0) > TUNE.FIRST_PICK_SCORE) continue;
            const d = Math.hypot(b.x - h.x, b.y - h.y);
            if (d > TUNE.FIRST_PICK_R) continue;
            // a bot that already farmed them is the last thing they need
            if (farmEntry(b, h) && farmEntry(b, h).n > 0) continue;
            const sc = d - (b.botMinnow ? 1200 : 0);
            if (sc < bestScore) { bestScore = sc; best = b; }
        }
        if (best) { assignBait(best, h, t); taken.add(sock); }
    }
}

// ── bosses at spawns ───────────────────────────────────────────────────
// [{ x, y, r }]: the live raid boss and everything it put out (drones, shards
function bossZones(boss, list) {
    const out = [];
    if (!on('bossSpawn') || !boss || (boss.isDead && boss.isDead())) return out;
    out.push({ x: boss.x, y: boss.y, r: TUNE.BOSS_SPAWN_R + (boss.realSize || boss.size || 0) });
    let n = 0;
    for (const e of list || []) {
        if (!e || e === boss || e.type === 'bullet' || e.type === 'tank' || (e.isDead && e.isDead())) continue;
        if (e.master !== boss && e.source !== boss && e.parent !== boss) continue;
        out.push({ x: e.x, y: e.y, r: TUNE.MINION_SPAWN_R });
        if (++n >= 40) break;
    }
    return out;
}
function inZones(zones, x, y) {
    for (const z of zones || []) if ((x - z.x) ** 2 + (y - z.y) ** 2 < z.r * z.r) return true;
    return false;
}

// ── tags ────────────────────────────────────────────────────────────────
// Should a REVENGE / BOUNTY / hunt tag on `target` be shown to a viewer as "too
function tooStrong(prot, target, viewerScore = 0, targetScore = 0, streak = 0, viewer = null) {
    if (!on('bots') || !prot || !target) return false;
    if (target.isRoyaleBoss) return false;
    // never your own tank (you can be the bounty or the hunted one)
    if (viewer && target === viewer) return false;
    // the tag says "way ahead of you": a tank you're level with or ahead of on the
    const vs = +viewerScore || 0, ts0 = +targetScore || 0;
    if (vs > 0 && ts0 > 0 && ts0 < vs * TUNE.TOO_STRONG_AHEAD) return false;
    if (target._fpRunaway || isBig(target)) return true;
    if ((streak | 0) >= TUNE.TOO_STRONG_STREAK) return true;
    const ts = +targetScore || 0;
    return ts >= TUNE.TOO_STRONG_SCORE_MIN && ts >= Math.max(1, +viewerScore || 0) * TUNE.TOO_STRONG_SCORE_X;
}

// ── minnows ─────────────────────────────────────────────────────────────
// How many small fish the raid should hold now
function minnowsWanted(protectedHumans, cap) {
    if (!on('minnow') || !(protectedHumans > 0)) return 0;
    return Math.max(1, Math.min(TUNE.MINNOW_MAX, Math.floor((cap | 0) / 2)));
}
function shouldBeMinnow(bots, protectedHumans, cap, boardScore = 0) {
    const want = minnowsWanted(protectedHumans, cap);
    if (!want || (+boardScore || 0) > TUNE.MINNOW_MAX_SCORE) return false;
    let have = 0;
    for (const b of bots || []) if (b && b.botMinnow && !(b.isDead && b.isDead())) have++;
    return have < want;
}
// Before the bot picks its tank (game/index.js spawnBots reads botMinnow)
function makeMinnow(bot, rand = Math.random) {
    if (!bot) return;
    bot.botMinnow = true;
    const [lo, hi] = TUNE.MINNOW_SKILL;
    bot.botSkill = lo + (hi - lo) * rand();
    bot.botTemperament = rand() < 0.5 ? 'aggressive' : 'balanced';
    bot.botStyle = 'normal';
    bot.growthCap = TUNE.MINNOW_GROWTH_CAP;
}
// configureBotStats: a minnow keeps the build's shape with fewer points (mining
function minnowRaw(raw) {
    const out = raw.slice();
    for (let i = 0; i < out.length; i++) {
        if (i === 10) continue;
        out[i] = Math.floor(out[i] * TUNE.MINNOW_STAT_SHARE);
    }
    return out;
}
// botTanks path [t1, t2, t3] -> what a minnow climbs
function minnowPath(path) { return Array.isArray(path) && path.length > 2 ? path.slice(0, 2) : path; }

// ── builds ──────────────────────────────────────────────────────────────
// What a death leaves for the respawn: the tank and where the points went
function saveBuild(socket, body, raid) {
    if (!on('build') || !socket || !body || !body.skill) return null;
    const defs = (body.defs || []).slice();
    const raw = body.skill.raw ? body.skill.raw.slice() : [];
    const spent = raw.reduce((a, b) => a + (b | 0), 0);
    const base = String(Config.spawn_class || 'basic');
    const upgraded = defs.length && !(defs.length === 1 && String(defs[0]) === base);
    if (!upgraded && !spent) { socket._fpBuild = null; return null; }
    socket._fpBuild = { raid, defs, raw, at: now() };
    return socket._fpBuild;
}
// Points to place: the saved spread, trimmed to what the new body holds and to
function fitRaw(saved, points, caps) {
    const raw = new Array(Math.max(saved.length, caps ? caps.length : 0)).fill(0);
    let left = Math.max(0, points | 0);
    for (let i = 0; i < saved.length && left > 0; i++) {
        const cap = caps && caps[i] != null ? caps[i] | 0 : Infinity;
        const n = Math.min(saved[i] | 0, cap, left);
        if (n > 0) { raw[i] = n; left -= n; }
    }
    return { raw, left };
}
// After the level fill (sockets.initalizePlayer): put the build back
function restoreBuild(socket, body, raid) {
    if (!on('build') || !socket || !body || !body.skill || Config.tutorial) return false;
    const b = socket._fpBuild;
    socket._fpBuild = null;
    if (!b || b.raid !== raid) return false;
    try {
        if (b.defs && b.defs.length) {
            // the fresh body is the spawn class: clear its menu first, or the spawn class's
            body.upgrades = [];
            body.define(b.defs.length === 1 ? b.defs[0] : b.defs);
        }
        const sk = body.skill;
        const already = (sk.raw || []).reduce((a, v) => a + (v | 0), 0);
        const pool = (sk.points | 0) + already;
        const fit = fitRaw(b.raw || [], pool, sk.caps);
        sk.set(fit.raw);
        sk.points = fit.left;
        body.refreshBodyAttributes();
        if (body.syncSkillsToGuns) body.syncSkillsToGuns();
        try { body.sendMessage("You're back in your " + (body.label || "tank") + " with your stat points where you left them."); } catch { /* */ }
        return true;
    } catch (e) {
        console.error('[FAIR] build restore failed', e && e.message);
        return false;
    }
}

// ── storm edge ──────────────────────────────────────────────────────────
// st: storm.snapshot()
function edgeSafe(x, y, st, margin = TUNE.EDGE_MARGIN, aheadS = TUNE.EDGE_AHEAD_S) {
    if (!st || !st.a) return true;
    const rNow = st.r || 0;
    const rAhead = Math.max(0, rNow - Math.max(0, rNow - (st.n || rNow)) * (aheadS * 4));
    const m = Math.min(margin, rAhead * 0.3);
    // where the sliding centre will be by then
    const k = aheadS * 4;   // nx/ny: the centre 250 ms on (storm.snapshot)
    const cx = (st.cx || 0) + (st.nx != null ? (st.nx - (st.cx || 0)) * k : 0);
    const cy = (st.cy || 0) + (st.ny != null ? (st.ny - (st.cy || 0)) * k : 0);
    return Math.hypot(x - cx, y - cy) < rAhead - m;
}

// ── storm at spawns ────────────────────────────────────────────────────
// How many storm-free seconds a human's landing spot should have (the same for
function spawnEtaWant(prot, home = false) {
    if (!on('storm')) return 0;
    return home ? TUNE.HOME_ETA_S : TUNE.SPAWN_ETA_S;
}

// ── respawn room from the big tanks ────────────────────────────────────
// A respawn keeps SPAWN_BIG_R (SPAWN_SAFE_R with safe spawn on) from every enemy
function bigThreat(viewerScore, viewerGrowth, targetScore, targetGrowth) {
    const vs = +viewerScore || 0, ts = +targetScore || 0;
    if (ts >= TUNE.SPAWN_BIG_SCORE_MIN && ts >= vs * TUNE.SPAWN_BIG_SCORE_X) return true;
    // round 5) twice your points counts whatever the board says
    if (on('spawnSafe') && ts >= TUNE.SPAWN_BIG_2X_MIN && ts >= vs * TUNE.SPAWN_BIG_2X) return true;
    return (+targetGrowth || 1) >= Math.max(TUNE.BIG_GROWTH, (+viewerGrowth || 1) * TUNE.SPAWN_BIG_GROWTH_X);
}
// > { r, mult } the keep-away radius and how much closer a big tank counts (the
function spawnKeep(prot) {
    return { r: on('spawnSafe') ? TUNE.SPAWN_SAFE_R : TUNE.SPAWN_BIG_R, mult: TUNE.SPAWN_BIG_MULT };
}
// cats: [{ x, y, r, w }]
function spawnDeficit(cats, x, y) {
    let sum = 0;
    for (const c of cats || []) {
        const dx = x - c.x, dy = y - c.y, d2 = dx * dx + dy * dy;
        if (d2 >= c.r * c.r) continue;
        sum += c.w * (1 - Math.sqrt(d2) / c.r);
    }
    return sum;
}
// The vaults an enemy of `self` is standing on or right by
function occupiedVaults(self, bodies, list = vaults()) {
    const out = [];
    if (!on('spawnSafe')) return out;
    const R2 = TUNE.VAULT_OCC_R * TUNE.VAULT_OCC_R;
    for (const v of list || []) {
        for (const b of bodies || []) {
            if (!b || b === self || (b.isDead && b.isDead()) || !(b.isBot || b.isPlayer) || b.isRoyaleBoss) continue;
            if (self && self.team != null && b.team === self.team) continue;
            if ((b.x - v.x) ** 2 + (b.y - v.y) ** 2 < R2) { out.push(v); break; }
        }
    }
    return out;
}

// ── first-kill fish, all raid ──────────────────────────────────────────
// Per bot family (outlives its respawns), cleared by newRaid(): fodder it was
const fams = new Map();
function famKey(bot) { return bot && bot.isBot ? 'f:' + (bot.botFamilyId != null ? bot.botFamilyId : bot.id) : null; }
function famRec(bot, make) {
    const k = famKey(bot);
    if (!k) return null;
    let r = fams.get(k);
    if (!r && make) fams.set(k, r = { fodder: false, beat: new Set() });
    return r || null;
}
function newRaid() { fams.clear(); }
function isFodder(bot) { if (!on('fodder')) return false; const r = famRec(bot, false); return !!(r && r.fodder); }
// a fodder bot: a small fish (never big, growth capped) for good
function applyFodder(bot) {
    if (!bot || !isFodder(bot)) return false;
    bot._fpFodder = true;
    bot.botMinnow = true;
    bot.growthCap = bot.growthCap > 0 ? Math.min(bot.growthCap, TUNE.MINNOW_GROWTH_CAP) : TUNE.MINNOW_GROWTH_CAP;
    return true;
}
function markFodder(bot, host) {
    if (!on('fodder') || !bot) return;
    const r = famRec(bot, true);
    if (!r) return;
    r.fodder = true;
    if (host) { const k = victimKey(host); if (k) r.beat.add(k); if (host.socket) host.socket._fpBeat = true; }
    applyFodder(bot);
}
// dig_royale onCombatantDead: `player` killed `bot`. A protected player, or the
function noteBeat(player, bot, t = now()) {
    if (!on('fodder') || !player || !player.isPlayer || !bot || !bot.isBot) return false;
    const host = bot._fpBait && bot._fpBait.sock && bot._fpBait.sock === player.socket;
    if (!host && !isProtected(player, t) && !isFodder(bot)) return false;
    const r = famRec(bot, true);
    const k = victimKey(player);
    if (!r || !k) return false;
    r.beat.add(k);
    if (player.socket) player.socket._fpBeat = true;
    return true;
}
function beatBy(bot, target) {
    if (!on('fodder') || !bot || !target) return false;
    const r = fams.size ? famRec(bot, false) : null;
    return !!(r && r.beat.size && r.beat.has(victimKey(target)));
}
// the share of kill / bonus / boss points a bot books
function fodderShare(bot) { return bot && bot._fpFodder && isFodder(bot) ? TUNE.FODDER_PTS : 1; }

module.exports = {
    TUNE, on, setSwitch, spawnEtaWant, bigThreat, spawnKeep, spawnDeficit, occupiedVaults, lastKillersOf,
    newRaid, isFodder, applyFodder, markFodder, noteBeat, beatBy, fodderShare,
    isRunaway, stampRunaway, gangPull, gangThreat, aimMult,
    victimKey, killerKey, noteBotKill, noteKilledBy, farmed, farmersOf, moveOnPoint,
    guarded, baitHost, isBaitPair, baitBusy, baitOnDuty, assignBait, releaseBait, tickFirstKill, firstKillDue,
    bossZones, inZones, avoidVault, minnowDuel, noteDuel, tooStrong,
    tally, noteDeath, noteKill, noteBank, struggle, struggleOf, struggleCap,
    protects, stamp, isProtected, earnedOut, checkOut, isOut,
    zoneR, vaultNear, inRing, vaultGuarded, bankStamp, bankCoverMult, bankBully, isBig, spared, vaultFreeFor, outsideVaults, lingerCheck,
    minnowsWanted, shouldBeMinnow, makeMinnow, minnowRaw, minnowPath,
    saveBuild, fitRaw, restoreBuild, edgeSafe, hitBy, provoked, dealtTo,
};
