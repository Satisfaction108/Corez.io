// First raids director: a player's first raids are fair, and the first one
// shows them something new every minute or so instead of plain old arras.
//
// Stage (`nx`), worked out at the player's first spawn in a raid and fixed
// for the rest of it, from all the time they have played (account
// user_stats.play_ms or guest guests.play_ms, plus this session):
//   0  first raid    under  8 minutes played
//   1  second        under 25
//   2  third         under 60
//   3  veteran       anything more
//
// What a stage changes (TUNE below has the numbers; index 0 is stage 0):
//   bosses      stage 0: boss guns never pick them, a boss shot that reaches
//               them fades without hurting, a boss hull only pushes
//               (bossGuard.intoPlayer, the boss check in controllers validate)
//   bots        the soft window of every life is 3 min (stage 1: 2.5); for
//               the first 5 minutes of the raid (stage 1: 2) no X-Hunter,
//               Penta or Octo class bot goes after them unless they shoot it
//               (scarySpared, read in controllers sense / canInitiateFight /
//               validate)
//   storm       0.4x damage (stage 1: 0.7x) through body.nxStormMult, and in
//               the first raid a loud callout each time they wander out
//   first death stage 0: the first death with gems on board drops half the
//               satchel; the other half comes back with them on the respawn
//               (gems.dropGemsOnDeath asks keepOnDeath)
//   respawn     stage 0: the first respawn gets a "back in" callout; the 3 s
//               wait and the 5 s spawn shield are the same as everyone's
//   ability     stage 0: the raid's free ability is never the Shockwave
// Other players can still fight them all they like.
//
// The moments (stage 0 only), timed from their first spawn in the raid, each
// one held back while they are fighting, hiding (burrowed, in smoke, on a
// pad, in the storm, idle) or dead, then tried again RETRY_MS later, and at
// least MIN_GAP_MS apart:
//   ~0:30  ore        a rich vein (a shard and a few azurite rocks, soft) a
//                     few hundred units away
//   ~1:30  crate      the next supply drop, called down near them
//                     (supplyDrops.requestNear: it replaces the next timed
//                     one); bots leave it to them for a while
//   ~2:30  trial      a free 2 minute Grapple Hook or Launch Pad trial, with
//                     the client's FREE TRIAL card
//   ~3:30  chest      a copper chest (with a kit item) only they can crack
//                     for the first 40 s; bots leave it alone
//   ~4:30  objective  "bank N gems in 60 s" (N 150-300, from what they
//                     carry); +250 banked gems and a kit item if they do
// After WINDOW_MS anything not yet fired is dropped.
//
// What the client gets (RY raid snapshot, `you`, only while this is on):
//   you.nx        0 | 1 | 2 | 3
//   you.nxEvent   null, or the current moment:
//                 { id, kind, state, x, y, until, left, title, sub, t, done,
//                   failed, ab?, goal?, prog?, reward?, r? }
//                   id      grows by one with every new moment (spot a new one)
//                   kind    'ore' | 'crate' | 'trial' | 'chest' | 'objective'
//                   state   'live', then 'done' or 'failed' for RESULT_MS
//                           (done / failed: the same as 1 / 0 flags)
//                   x, y    world spot to point at (null for 'trial'; the
//                           nearest vault for 'objective')
//                   until   server clock (ms) when it ends; left = ms to go
//                           when the packet was built (use this one)
//                   title, sub   short lines for a banner (t = title)
//                   ab      'trial': the ability id
//                   reward  gems it pays ('crate', 'chest', 'objective'; r too)
//                   goal, prog   'objective': gems to bank, banked so far
//   you.nxKept    gems a first death kept back, until the respawn hands them
//                 back (0 or missing otherwise)
// The death packet (sockets.js records) has the kept gems at m[18 + killers].
// The moments themselves send no KC: the client draws them from nxEvent.
// Two KC callouts do go out: kind 'nxstorm' (out in the storm, at most every
// STORM_WARN_MS) and kind 'nx' "Back in the raid" on the first respawn.
// DBG nx <ore|crate|trial|chest|objective> fires one now, DBG nx stage <0-3>
// pins this player's stage (ROYALE_DEBUG).
//
// ROYALE_NEWCOMER_DIRECTOR=0 turns all of it off (no nx, no stage effects).
'use strict';

const activity = require('../network/activity.js');

let ON = process.env.ROYALE_NEWCOMER_DIRECTOR !== '0';
function setEnabled(v) { ON = !!v; }
function isEnabled() { return ON; }

const MIN = 60_000;
const TUNE = {
    STAGE_MIN: [3, 7, 12],               // minutes played: under each, stage 0, 1, 2 (checked again mid-raid)
    BOSS_SAFE_MIN: 8,                    // bosses leave you alone this long (until you pick the fight)
    RECHECK_MS: 15_000,                  // how often the stage is looked at again during a raid
    SOFT_MS: [180_000, 150_000],         // bot soft window per life
    STORM_MULT: [0.4, 0.7],
    SCARY_MS: [5 * MIN, 2 * MIN],        // from the first spawn in the raid
    SCARY_HIT_MS: 4000,                  // a scary bot they shot fights back this long
    KEEP_SHARE: 0.5,                     // of the satchel, on the first death
    KEEP_MIN: 20,                        // a death carrying less doesn't use it up
    MOMENTS: [['ore', 30_000], ['crate', 90_000], ['trial', 150_000], ['chest', 210_000], ['objective', 270_000]],
    WINDOW_MS: 7 * MIN,
    RETRY_MS: 5000,
    MIN_GAP_MS: 50_000,
    MAX_TRIES: 8,                        // a moment that can't be placed this often is dropped
    FIGHT_MS: 6000,
    SETTLE_MS: 4000,                     // a fresh landing gets this long first
    IDLE_MS: 30_000,
    RESULT_MS: 3500,
    ORE_RING: [220, 520],
    ORE_CLUSTER_R: 240,
    ORE_SOFT: 0.6,                       // of a fresh rock's health
    ORE_MS: 60_000,
    CRATE_NEAR: 1300,                    // a drop already this close counts
    CRATE_RESERVE_MS: 20_000,
    CRATE_MS: 45_000,                    // after it lands
    TRIAL_POOL: ['grapple', 'pad'],
    TRIAL_FALLBACK: ['rush', 'smoke'],
    CHEST_RING: [300, 520],
    CHEST_GEMS: 250,
    CHEST_RESERVE_MS: 40_000,
    CHEST_MS: 70_000,
    JOB_MS: 60_000,
    JOB_GOAL: [150, 300],
    JOB_REWARD: 250,
    STORM_WARN_MS: 20_000,
};
// the classes new players kept dying to (prod, first raids)
const SCARY = new Set(['X-Hunter', 'Penta Shot', 'Spreadshot', 'Octo Tank', 'Cyclone']);

// dig_royale.js: careerMs(socket), raidId(), live(), clients(), pay(body, n),
// callout(body, kind, text, pts, sub, dur), compass(x, y)
let hooks = {};
function attach(h) { hooks = h || {}; }

function now() { return Date.now(); }
const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());
function tg() { return global.gameManager && global.gameManager.terrainGrid; }
function storm() { return require('./storm.js'); }
function active() { return ON && !!Config.dig_royale && !Config.tutorial; }

function stageFor(ms) {
    const m = Math.max(0, +ms || 0) / MIN;
    for (let i = 0; i < TUNE.STAGE_MIN.length; i++) if (m < TUNE.STAGE_MIN[i]) return i;
    return TUNE.STAGE_MIN.length;
}

// ── per player, per raid ────────────────────────────────────────────────
// Keyed by account / guest id, so a reload in the same raid keeps its stage,
// its moments and a kept half. newRaid() empties it.
const ledger = new Map();
let seq = 0;
let epoch = 0;                         // bumped by newRaid(): older states are stale
function keyOf(socket) {
    if (socket.account && socket.account.id) return 'a:' + socket.account.id;
    if (socket.guestId) return 'g:' + socket.guestId;
    return socket.id != null ? 's:' + socket.id : null;
}
function raidNow() { return hooks.raidId ? hooks.raidId() : 0; }
function stateOf(socket, t = now()) {
    if (!socket) return null;
    const rid = raidNow();
    if (socket._nx && socket._nx.raid === rid && socket._nx.epoch === epoch) return socket._nx;
    const key = keyOf(socket);
    let st = key ? ledger.get(key) : null;
    if (!st || st.raid !== rid || st.epoch !== epoch) {
        let ms = 0;
        try { ms = hooks.careerMs ? hooks.careerMs(socket) : 0; } catch { ms = 0; }
        const stage = socket._nxPin != null ? socket._nxPin : stageFor(ms);
        st = {
            raid: rid, epoch, stage, director: stage === 0, careerMs: ms, checkedAt: t, since: t, next: 0, dueAt: t + TUNE.MOMENTS[0][1], tries: 0, lastAt: 0,
            event: null, deathUsed: false, kept: 0, respawned: false, stormWarnAt: 0,
        };
        if (key) ledger.set(key, st);
    }
    socket._nx = st;
    return st;
}
function socketPin(socket) { return socket && socket._nxPin != null ? socket._nxPin : null; }
// Time played so far, this life included: the stage moves up mid-raid
// instead of waiting for the next raid (never down).
function recheck(body, st, t) {
    if (t - (st.checkedAt || 0) < TUNE.RECHECK_MS) return;
    st.checkedAt = t;
    let ms = 0;
    try { ms = hooks.careerMs ? hooks.careerMs(body.socket) : 0; } catch { ms = 0; }
    if (alive(body) && body.royaleBornAt) ms += Math.max(0, t - body.royaleBornAt);
    st.careerMs = Math.max(st.careerMs || 0, ms);
    const pin = socketPin(body.socket);
    const s = pin != null ? pin : stageFor(st.careerMs);
    if (s > st.stage) {
        st.stage = s;
        body.nxStage = s;
        body.nxStormMult = TUNE.STORM_MULT[s] || 0;
        body.nxScaryUntil = TUNE.SCARY_MS[s] ? st.since + TUNE.SCARY_MS[s] : 0;
    }
    if (body.nxBossSafe && (st.careerMs >= TUNE.BOSS_SAFE_MIN * MIN || pin === 3)) body.nxBossSafe = false;
}
function stageOf(body) {
    return body && body.nxStage != null ? body.nxStage : 3;
}

// freshRaidBody (every life, after its own bot grace and soft window): the
// stage and what it changes, stamped on the body
function applyBody(body, t = now()) {
    if (!body || !body.socket) return;
    if (!active()) {
        body.nxStage = undefined; body.nxStormMult = 0; body.nxBossSafe = false; body.nxScaryUntil = 0;
        return;
    }
    const st = stateOf(body.socket, t);
    const s = st.stage;
    body.nxStage = s;
    const soft = TUNE.SOFT_MS[s];
    if (soft) {
        body.botSoftMs = Math.max(body.botSoftMs || 0, soft);
        body.botSoftUntil = Math.max(body.botSoftUntil || 0, t + soft);
    }
    body.nxStormMult = TUNE.STORM_MULT[s] || 0;
    body.nxBossSafe = (st.careerMs || 0) < TUNE.BOSS_SAFE_MIN * MIN && socketPin(body.socket) !== 3;
    body.nxScaryUntil = TUNE.SCARY_MS[s] ? st.since + TUNE.SCARY_MS[s] : 0;
}

// controllers.js: a scary bot leaves this player alone (not while they're
// idle, and not once they've shot it)
function scarySpared(bot, target, t = now()) {
    if (!bot || !target || !target.isPlayer || !((target.nxScaryUntil || 0) > t)) return false;
    if (!SCARY.has(bot.label)) return false;
    if (bot._lastDamageSource === target && t - (bot._lastDamageAt || 0) < TUNE.SCARY_HIT_MS) return false;
    return !activity.unprotected(target, t);
}

// gems.dropGemsOnDeath: how much of `carried` stays with the player
function keepOnDeath(body, carried) {
    if (!active() || !body || !body.socket || body.nxStage !== 0) return 0;
    if (body.deathCause === 'raidend' || body.deathCause === 'despawn') return 0;
    const st = stateOf(body.socket);
    if (st.deathUsed || !(carried >= TUNE.KEEP_MIN)) return 0;
    st.deathUsed = true;
    const kept = Math.floor(carried * TUNE.KEEP_SHARE);
    st.kept += kept;
    try {
        body.socket.talk('m', 9000, "First raid bonus: you only dropped half. " + kept.toLocaleString('en-US') +
            " gems are safe and come back with you when you drop in again.");
    } catch { /* */ }
    return kept;
}

// onHumanJoin, after the starter kit: the kept half, and a word on the first respawn
function onSpawn(body, isRespawn, t = now()) {
    if (!active() || !body || !body.socket || body.nxStage !== 0) return;
    const st = stateOf(body.socket, t);
    const kept = st.kept | 0;
    if (kept > 0) {
        st.kept = 0;
        try {
            const gems = require('./gems.js');
            body.carriedGems = (body.carriedGems | 0) + kept;
            gems.updateSatchel(body);
            gems.talkGems(body, kept);
        } catch { /* */ }
    }
    if (isRespawn && !st.respawned) {
        st.respawned = true;
        const sub = kept > 0
            ? "You kept " + kept.toLocaleString('en-US') + " gems. Bank them at a vault and they're safe for good."
            : "Your bank is safe. Mine some ore, bank it, and you're back in it.";
        say(body, 'nx', "Back in the raid", sub, 4500);
    }
}

function say(body, kind, text, sub, dur) {
    try { if (hooks.callout) hooks.callout(body, kind, text, 0, sub, dur); } catch { /* */ }
}

// ── the moments ─────────────────────────────────────────────────────────
// Why a moment waits: null when it can go now.
function busyWhy(body, t) {
    if (!alive(body) || body.royaleFrozen || body.royaleLobby) return 'dead';
    if (t - (body.royaleBornAt || 0) < TUNE.SETTLE_MS) return 'landing';
    const lastFight = Math.max(body.hitAt || 0, body._lastDamageAt || 0, body._dealtAt || 0);
    if (t - lastFight < TUNE.FIGHT_MS) return 'fighting';
    for (const b of (global.gameManager.gameHandler?.bots || [])) {
        if (!alive(b) || b.team === body.team) continue;
        if ((b._botEnemyId === body.id || b._fightingPlayerId === body.id) && (b.x - body.x) ** 2 + (b.y - body.y) ** 2 < 900 * 900) return 'fighting';
    }
    if (body.burrowUntil > t || body.smokeHidden || body.smokeUntil > t) return 'hiding';
    if (body.padSafe || body.shopOnPad || body.vaultOnPad || body.onVaultPad || body.vaultDeposit) return 'pad';
    if (body._inStorm) return 'storm';
    if (body.socket && activity.inputIdleMs(body.socket, t) > TUNE.IDLE_MS) return 'idle';
    return null;
}

function inZone(x, y, t) {
    try { return !storm().inStorm(x, y, t); } catch { return true; }
}
function allPads() {
    const out = [];
    try { for (const v of require('./vault.js').getVaults()) out.push(v); } catch { /* */ }
    try { for (const o of require('./outposts.js').getOutposts()) out.push(o); } catch { /* */ }
    try { for (const s of require('./shop.js').getShops()) out.push(s); } catch { /* */ }
    return out.filter(Boolean);
}

function newEvent(kind, t, ms, extra) {
    return Object.assign({ id: ++seq, kind, state: 'live', x: null, y: null, at: t, until: t + ms, title: '', sub: '' }, extra);
}

// ~0:30: a few rocks near them turn rich (one shard, the rest azurite) and soft
function fireOre(body, t) {
    const grid = tg();
    if (!grid || !grid.rocks) return null;
    const { ORE, ORE_HP } = require('./terrainGrid.js');
    const padGeom = require('./padGeom.js');
    const pads = allPads();
    const cand = [];
    for (const r of grid.rocks.values()) {
        if (!r || !r.alive || r.growing || r.canyon || !r.worldPoly || (r.ore | 0) > ORE.COPPER || r.chestLock) continue;
        const x = r.worldCx || r.wx, y = r.worldCy || r.wy;
        const d = Math.hypot(x - body.x, y - body.y);
        if (d < TUNE.ORE_RING[0] || d > TUNE.ORE_RING[1]) continue;
        if (!inZone(x, y, t)) continue;
        if (pads.some(p => padGeom.insidePad(p, x, y, 120))) continue;
        cand.push({ r, x, y, d });
    }
    if (!cand.length) return null;
    cand.sort((a, b) => a.d - b.d);
    const seed = cand[(Math.random() * Math.min(cand.length, 6)) | 0];
    const cluster = cand
        .map(c => ({ c, dd: Math.hypot(c.x - seed.x, c.y - seed.y) }))
        .filter(o => o.dd <= TUNE.ORE_CLUSTER_R)
        .sort((a, b) => a.dd - b.dd)
        .slice(0, 4)
        .map(o => o.c);
    const copperOnly = !!(global.royaleMods && global.royaleMods.ore === 'copper');
    const ores = copperOnly ? [ORE.COPPER, ORE.COPPER, ORE.COPPER, ORE.COPPER] : [ORE.SHARD, ORE.VEIN, ORE.VEIN, ORE.VEIN];
    const rocks = [];
    let sx = 0, sy = 0;
    cluster.forEach((c, i) => {
        const rock = c.r, ore = ores[i];
        rock.ore = ore;
        try { rock.deposits = grid._buildDeposits(rock); } catch { rock.deposits = null; }
        rock.maxHealth = Math.max(10, grid.plainRockHealth * (ORE_HP[ore] || 1) * TUNE.ORE_SOFT);
        rock.soft = true;   // the old flat gem pay, whatever the biome
        rock.health = rock.maxHealth;
        // it stays put until they get to it
        rock.noRegrowUntil = Math.max(rock.noRegrowUntil || 0, t + TUNE.ORE_MS);
        if (grid.rockEvents) grid.rockEvents.push({ k: rock.k, h: 1, d: 0, ore, bl: 1 });
        rocks.push(rock);
        sx += c.x; sy += c.y;
    });
    const x = Math.round(sx / cluster.length), y = Math.round(sy / cluster.length);
    try { body.socket.talk('FX', x, y, 'bloom'); } catch { /* */ }
    return newEvent('ore', t, TUNE.ORE_MS, { x, y, title: "Rich vein nearby", sub: "Shoot the glowing rocks and gems burst out.", rocks });
}

// ~1:30: the next supply drop, near them
function fireCrate(body, t) {
    const supply = require('./supplyDrops.js');
    if (!supply.enabled()) return null;
    const cur = supply.current(t);
    const near = (p) => p && Math.hypot(p.x - body.x, p.y - body.y) <= TUNE.CRATE_NEAR;
    let plan = null;
    if (cur && near(cur)) plan = cur;              // one is already coming their way
    else if (cur && cur.state === 'soon') return null;   // one is falling elsewhere: wait for it
    else plan = supply.requestNear(body, t, TUNE.CRATE_RESERVE_MS);
    if (!plan) return null;
    const landAt = plan.at || t;
    const down = cur && cur.state === 'down' && plan === cur;
    return newEvent('crate', t, Math.max(0, landAt - t) + TUNE.CRATE_MS, {
        x: Math.round(plan.x), y: Math.round(plan.y), landAt, reward: supply.CRATE_GEMS,
        title: down ? "Supply crate next to you" : "Supply drop coming to you",
        sub: "Break it open for gems, a kit item and a new ability.", ent: down ? plan.entity : null,
    });
}

// ~2:30: a free 2 minute trial of a showy ability (never the Shockwave)
function fireTrial(body, t) {
    const abilities = require('./abilities.js');
    if (!abilities.ON) return null;
    const st = abilities.stateOf(body.socket);
    if (!st || (st.trial && st.trial.until > t)) return null;
    const eq = abilities.equippedOf(st, t);
    const free = (ids) => ids.filter(id => abilities.AB_BY_ID.has(id) && !st.own.includes(id) && id !== eq);
    const pool = free(TUNE.TRIAL_POOL).length ? free(TUNE.TRIAL_POOL) : free(TUNE.TRIAL_FALLBACK);
    if (!pool.length) return 'skip';
    const id = pool[(Math.random() * pool.length) | 0];
    const def = abilities.AB_BY_ID.get(id);
    st.trial = { id, until: t + abilities.TRIAL_MS };
    st.trialUsed = true;
    // the client's FREE TRIAL card is the intro (abilityFx: a new trial id)
    abilities.talkState(body.socket, "Free trial: " + def.name + " for 2 minutes. Buy it at a shop to keep it.");
    return newEvent('trial', t, abilities.TRIAL_MS, { ab: id, title: "Free trial: " + def.name, sub: "Yours for 2 minutes. Give it a go." });
}

// ~3:30: a chest close by that only they can crack for a while
function fireChest(body, t) {
    const chests = require('./chests.js');
    const grid = tg();
    for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = TUNE.CHEST_RING[0] + Math.random() * (TUNE.CHEST_RING[1] - TUNE.CHEST_RING[0]);
        const spot = chests.spotNear(body.x + Math.cos(a) * d, body.y + Math.sin(a) * d);
        if (!spot) continue;
        const dd = Math.hypot(spot.x - body.x, spot.y - body.y);
        if (dd < 180 || dd > TUNE.CHEST_RING[1] + 250) continue;
        if (!inZone(spot.x, spot.y, t)) continue;
        if (grid && grid.pointInRock && grid.pointInRock(spot.x, spot.y)) continue;
        let item = null;
        try { item = require('./shop.js').randomKitId() || null; } catch { item = null; }
        const o = chests.spawnChest(spot.x, spot.y, false, { gems: TUNE.CHEST_GEMS, item, extra: true });
        if (!o) continue;
        o.nxOwnerId = body.id;
        o.nxOwnerUntil = t + TUNE.CHEST_RESERVE_MS;
        o._botClaim = { id: body.id, until: t + TUNE.CHEST_RESERVE_MS };
        return newEvent('chest', t, TUNE.CHEST_MS, {
            x: Math.round(o.x), y: Math.round(o.y), ent: o, reward: TUNE.CHEST_GEMS,
            title: "A chest just for you", sub: "Nobody else can crack it for " + Math.round(TUNE.CHEST_RESERVE_MS / 1000) + " seconds. Go!",
        });
    }
    return null;
}

// ~4:30: bank a set amount in a minute for a bonus
function fireObjective(body, t) {
    const carried = body.carriedGems | 0;
    const goal = Math.max(TUNE.JOB_GOAL[0], Math.min(TUNE.JOB_GOAL[1], Math.round((carried + 100) / 50) * 50));
    // hold back the next contract so two jobs never run at once
    const sock = body.socket;
    if (sock) sock.contractNextAt = Math.max(sock.contractNextAt || 0, t + TUNE.JOB_MS + 2000);
    return newEvent('objective', t, TUNE.JOB_MS, {
        goal, prog: 0, reward: TUNE.JOB_REWARD,
        title: "Bank " + goal + " gems in 60 seconds", sub: "Pull it off for +" + TUNE.JOB_REWARD + " gems and a kit item.",
    });
}

const FIRE = { ore: fireOre, crate: fireCrate, trial: fireTrial, chest: fireChest, objective: fireObjective };

// where the nearest vault is, for the objective's arrow
function nearestVault(body) {
    let best = null, bd = Infinity;
    try {
        for (const v of require('./vault.js').getVaults()) {
            const d = (v.x - body.x) ** 2 + (v.y - body.y) ** 2;
            if (d < bd) { bd = d; best = v; }
        }
    } catch { /* */ }
    return best;
}

// a chest (or crate) broken open with this player among the ones hitting it
function openedBy(chest, body) {
    if (!chest._opened || chest._cleared || chest._retired) return false;
    return !!(chest.hitters && chest.hitters.has(body.id));
}

function endEvent(st, t, state) {
    const ev = st.event;
    if (!ev) return;
    if (state === 'gone') { st.event = null; return; }
    ev.state = state;
    ev.until = t + TUNE.RESULT_MS;
}

// one moment's upkeep: points it at the right spot, ends it when it's done
function upkeep(body, st, t) {
    const ev = st.event;
    if (!ev) return;
    if (ev.state !== 'live') { if (t >= ev.until) st.event = null; return; }
    const live = alive(body);
    switch (ev.kind) {
        case 'ore':
            if (ev.rocks.every(r => !r.alive)) return endEvent(st, t, 'done');
            break;
        case 'crate': {
            if (!ev.ent && t >= (ev.landAt || 0)) {
                try {
                    const cur = require('./supplyDrops.js').current(t);
                    if (cur && cur.state === 'down' && Math.hypot(cur.x - ev.x, cur.y - ev.y) < 80) ev.ent = cur.entity;
                } catch { /* */ }
                if (!ev.ent && t - ev.landAt > 2000) return endEvent(st, t, 'gone');
            }
            if (ev.ent && (ev.ent._opened || !alive(ev.ent))) return endEvent(st, t, openedBy(ev.ent, body) ? 'done' : 'gone');
            break;
        }
        case 'trial': {
            let on = false;
            try { const ab = require('./abilities.js').stateOf(body.socket); on = !!(ab && ab.trial && ab.trial.id === ev.ab && ab.trial.until > t); } catch { /* */ }
            if (!on) return endEvent(st, t, 'gone');
            break;
        }
        case 'chest':
            if (ev.ent && (ev.ent._opened || !alive(ev.ent))) return endEvent(st, t, openedBy(ev.ent, body) ? 'done' : 'gone');
            break;
        case 'objective': {
            if (ev.prog >= ev.goal) {
                endEvent(st, t, 'done');
                payObjective(body, ev);
                return;
            }
            if (!live || t >= ev.until) {
                endEvent(st, t, 'failed');
                try { if (body.socket) body.socket.talk('m', 5000, "Out of time on that one. Every gem you bank still counts."); } catch { /* */ }
                return;
            }
            const v = live ? nearestVault(body) : null;
            if (v) { ev.x = Math.round(v.x); ev.y = Math.round(v.y); }
            return;
        }
    }
    if (t >= ev.until) endEvent(st, t, 'gone');
}

function payObjective(body, ev) {
    let item = '';
    if (body.socket) {
        try {
            const shop = require('./shop.js');
            const id = shop.randomKitId();
            if (id && shop.grantKit(body.socket, id)) item = (shop.BY_ID.get(id) || {}).name || '';
        } catch { /* */ }
    }
    try { if (hooks.pay) hooks.pay(body, ev.reward); } catch { /* */ }
    // the client's payoff is the banner; this says what landed where
    try { body.socket.talk('m', 5000, "Job done: +" + ev.reward + " gems banked" + (item ? " and a " + item + " in your kit." : ".")); } catch { /* */ }
}

// dig_royale onBanked: the objective counts it
function onBanked(body, amount) {
    if (!active() || !body || !body.socket || !(amount > 0)) return;
    const st = body.socket._nx;
    const ev = st && st.epoch === epoch && st.event;
    if (!ev || ev.kind !== 'objective' || ev.state !== 'live') return;
    ev.prog = Math.min(ev.goal, (ev.prog || 0) + Math.floor(amount));
}

function fire(body, st, kind, t) {
    let ev = null;
    try { ev = FIRE[kind](body, t); } catch (e) { ev = null; }
    if (ev === 'skip') return 'skip';
    if (!ev) return null;
    st.event = ev;
    st.lastAt = t;
    return ev;
}

function tickPlayer(body, t) {
    const st = body.socket._nx;
    if (!st || st.raid !== raidNow() || st.epoch !== epoch) return;
    recheck(body, st, t);
    // the first-raid moments keep going for whoever started the raid new,
    // even after their stage moves up
    if (!st.director) return;
    upkeep(body, st, t);
    if (!alive(body)) return;
    // the storm: loud, every time they wander out
    if (body._inStorm && !(body.spawnGraceUntil > t) && t - st.stormWarnAt > TUNE.STORM_WARN_MS) {
        st.stormWarnAt = t;
        say(body, 'nxstorm', "Get out of the storm!", "It hurts while you're outside the circle. Head back in.", 3500);
        try { body.socket.talk('m', 5000, "You're in the storm. Get back inside the circle."); } catch { /* */ }
    }
    if (st.next >= TUNE.MOMENTS.length) return;
    if (t - st.since > TUNE.WINDOW_MS) { st.next = TUNE.MOMENTS.length; return; }
    if (t < st.dueAt) return;
    // one thing at a time: a moment still on (a running trial needs no
    // chasing) or still showing how it went holds the next one back
    const chasing = st.event && (st.event.state !== 'live' || st.event.kind !== 'trial');
    if (chasing || busyWhy(body, t)) { st.dueAt = t + TUNE.RETRY_MS; return; }
    const kind = TUNE.MOMENTS[st.next][0];
    const ev = fire(body, st, kind, t);
    if (!ev && ++st.tries < TUNE.MAX_TRIES) { st.dueAt = t + TUNE.RETRY_MS; return; }
    // fired, skipped or given up on: on to the next one, never sooner than
    // MIN_GAP_MS after the last one that fired
    st.next++;
    st.tries = 0;
    if (st.next < TUNE.MOMENTS.length) {
        st.dueAt = Math.max(st.since + TUNE.MOMENTS[st.next][1], st.lastAt ? st.lastAt + TUNE.MIN_GAP_MS : t);
    }
}

let lastTickAt = 0;
function tick(t = now()) {
    if (!active() || (hooks.live && !hooks.live())) return;
    if (t - lastTickAt < 250 && t >= lastTickAt) return;
    lastTickAt = t;
    for (const c of (hooks.clients ? hooks.clients() : [])) {
        const body = c && c.player && c.player.body;
        if (!body || !body.socket || !c._nx) continue;
        try { tickPlayer(body, t); } catch { /* one player's moment never stops the rest */ }
    }
}

// the RY `you` fields for one client
function youFields(client, t = now()) {
    if (!active() || !client) return null;
    const st = client._nx;
    if (!st || st.raid !== raidNow() || st.epoch !== epoch) return null;
    const out = { nx: st.stage };
    const ev = st.event;
    if (ev) {
        const e = {
            id: ev.id, kind: ev.kind, state: ev.state, x: ev.x, y: ev.y, until: ev.until, left: Math.max(0, ev.until - t),
            title: ev.title, sub: ev.sub,
            // short aliases newcomer.js reads (t title, done / failed flags, r reward)
            t: ev.title, done: ev.state === 'done' ? 1 : 0, failed: ev.state === 'failed' ? 1 : 0,
        };
        if (ev.ab) e.ab = ev.ab;
        if (ev.reward) e.reward = e.r = ev.reward;
        if (ev.kind === 'objective') { e.goal = ev.goal; e.prog = ev.prog | 0; }
        out.nxEvent = e;
    } else out.nxEvent = null;
    if (st.kept > 0) out.nxKept = st.kept;
    return out;
}

function newRaid() {
    ledger.clear();
    epoch++;
    lastTickAt = 0;
}

// ROYALE_DEBUG (DBG nx): fire a moment now, or pin a stage
function debugFire(body, kind, arg) {
    if (!body || !body.socket) return null;
    if (kind === 'stage') {
        body.socket._nxPin = arg === '' || arg == null ? null : Math.max(0, Math.min(3, arg | 0));
        body.socket._nx = null;
        const key = keyOf(body.socket);
        if (key) ledger.delete(key);
        applyBody(body);
        return body.nxStage;
    }
    if (!FIRE[kind]) return null;
    const st = stateOf(body.socket);
    const ev = fire(body, st, kind, now());
    return ev && ev !== 'skip' ? ev.kind : null;
}

module.exports = {
    TUNE, SCARY, attach, setEnabled, isEnabled, stageFor, stateOf, stageOf, applyBody, scarySpared, keepOnDeath,
    onSpawn, onBanked, tick, youFields, newRaid, busyWhy, debugFire,
    _fire: (body, kind, t) => fire(body, stateOf(body.socket, t), kind, t),
};
