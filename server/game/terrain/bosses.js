// Raid bosses: rare, loud, solo-killable. One surfaces every couple of storm
// cycles, roams the safe zone, and erupts gems plus a rare cache when it dies.
const gems = require('./gems.js');
const guard = require('./bossGuard.js');
const padGeom = require('./padGeom.js');

const KINDS = {
    // every boss digs (digRate = share of a rock's health per bite) so none
    // gets stuck in the wall when the storm moves
    warden:    { cls: 'royaleVaultWarden',    name: 'Vault Warden',    gems: 2500, score: 600, color: '#8d6adf', digs: true, digRate: 0.18, blurb: 'Armored. Traps. Sixteen barrels.' },
    drillhead: { cls: 'royaleMagmaDrillhead', name: 'Magma Drillhead', gems: 1800, score: 450, color: '#ff6c3a', digs: true, digRate: 0.3, contact: false, blurb: 'Fast. Digs through the wall. Hits like a truck.' },
    colossus:  { cls: 'royaleGeodeColossus',  name: 'Geode Colossus',  gems: 3200, score: 750, color: '#62caa7', digs: true, digRate: 0.18, blurb: 'The wall itself. Thirteen turrets.' },
    wraith:    { cls: 'royaleShardWraith',    name: 'Shard Wraith',    gems: 2200, score: 550, color: '#d153cc', digs: true, digRate: 0.18, blurb: 'Summons shards. Snipes from range.' },
};
const ORDER = ['warden', 'drillhead', 'colossus', 'wraith'];
// Softening on top of the definitions. The worst single hit from any gun
// takes about a third of a fresh level-45 Basic (220 health + 65 shield);
// a decent player can take one down alone with real effort, a group
// comfortably.
//   healthMult  scales max health (the shield is left alone)
//   shotMult    scales every bullet, trap and drone the boss or its turrets fire
//   bodyMult    scales hull contact damage
//   regenEvery  the boss regenerates on one regen tick in this many
//   shotKind    per boss on top of shotMult: the Colossus fires stock auto
//               turrets that hit well under the others' guns; the Wraith's
//               snipers and shards were taking players out from off screen;
//               the Drillhead's destroyer barrels hit far too hard
const TUNING = {
    healthMult: 0.6,   // was 0.85: fights dragged on
    shotMult: 0.58,    // was 0.55: a bit more bite (a hit still stays under a third of a fresh Basic)
    bodyMult: 0.88,    // was 0.8
    regenEvery: 2,
    shotKind: { colossus: 1.3, wraith: 0.6, drillhead: 0.45 },
};
function tune(o, kind = o.bossKind) {
    o.bonusHealthMult = TUNING.healthMult;
    o.bossShotMult = TUNING.shotMult * (TUNING.shotKind[kind] || 1);
    o.bossBodyMult = TUNING.bodyMult;
    o.regenEvery = TUNING.regenEvery;
}
const DEBUG = !!process.env.ROYALE_DEBUG;
const BASE_INTERVAL_MS = DEBUG ? 45 * 1000 : 14 * 60 * 1000;
const FIRST_DELAY_MS = DEBUG ? 12 * 1000 : 5 * 60 * 1000;
// ROYALE_BOSS_RATE scales how often bosses come (1 = the old pace of about
// one a raid). At 2.5 the first one surfaces 3 min in and the next ~5.6
// min after the last one dies or burrows: three in a typical 21 min raid.
// Warden's Watch (raidMods bossRateMult) multiplies on top.
const RATE = (() => {
    const v = parseFloat(process.env.ROYALE_BOSS_RATE);
    return Number.isFinite(v) && v > 0 ? v : 2.5;
})();
// the first boss comes sooner too, but never before the 3 minute mark (a
// new player gets a couple of minutes to find their feet)
const FIRST_MIN_MS = DEBUG ? 0 : 3 * 60 * 1000;
// a boss nobody kills burrows after this (shorter at a quick pace so an
// ignored one does not hold up the next)
const LIFETIME_MS = (RATE > 1 ? 6 : 8) * 60 * 1000;

let boss = null;
let kindId = null;
let spawnedAt = 0;
let expiresAt = 0;
let nextAt = 0;
let lastKind = null;
// One boss per storm cycle, surfacing early in it and burrowing when the
// cycle ends. The last storm belongs to the Core: no bosses there.
// (Warden's Watch lets a second one come in a cycle if the first dies early.)
const CYCLE_SPAWN_DELAY_MS = 25 * 1000;   // after the cycle starts (spawns settle first)
const CYCLE_MIN_LEFT_MS = 90 * 1000;      // not worth surfacing with less than this left
// a raid's first cycle: not before FIRST_MIN_MS (round 7: a Drillhead was up 25 s
const FIRST_CYCLE_DELAY_MS = process.env.ROYALE_BOSS_EARLY === '1' ? CYCLE_SPAWN_DELAY_MS : Math.max(CYCLE_SPAWN_DELAY_MS, FIRST_MIN_MS);
let bossCycle = -1, cycleBosses = 0;
let hitters = new Map();
const RISE_MS = 1800;
const EXIT_MS = 1500;
let pending = null;
let exitAt = 0;
function fx(x, y, kind, ...extra) {
    try { royale().fxAt(x, y, kind, ...extra); } catch (e) { }
}
function sizeOf(id) {
    const k = KINDS[id];
    try { const c = Class[k.cls]; return Math.round((c && c.SIZE) || 60); } catch (e) { return 60; }
}

function storm() { return require('./storm.js'); }
function mods() { return require('./raidMods.js'); }
function royale() { return require('../gamemodes/scripts/dig_royale.js'); }

function jitter(ms) { return ms * (0.8 + Math.random() * 0.4); }

function scheduleNext(fromNow) {
    const rate = Math.max(0.25, mods().num('bossRateMult', 1));
    nextAt = Date.now() + jitter((fromNow != null ? fromNow : BASE_INTERVAL_MS / RATE) / rate);
}
// the first boss of a raid: sooner with the rate, never earlier than the floor
function firstDelay() {
    return Math.max(FIRST_MIN_MS, FIRST_DELAY_MS / Math.min(2, RATE));
}

// its drones, shards and traps go with it (a new raid's fresh spawns landed among
function killBrood(o) {
    if (!o) return;
    try {
        for (const e of [...entities.values()]) {
            if (!e || e === o || e.type === 'tank' || !(e.master === o || e.source === o || e.parent === o)) continue;
            try { e.kill(); } catch { /* */ }
        }
    } catch { /* */ }
}
function resetRaid() {
    pending = null; exitAt = 0;
    if (boss && !boss.isDead?.()) { boss.bossBurrowed = true; try { boss.kill(); } catch (e) { boss.bossBurrowed = true; } }
    if (boss) killBrood(boss);
    boss = null; kindId = null; hitters.clear();
    bossCycle = -1; cycleBosses = 0;
    scheduleNext(firstDelay());
}

function pickKind() {
    const pool = ORDER.filter(k => k !== lastKind);
    return pool[(Math.random() * pool.length) | 0];
}

function pickSpot() {
    const tg = global.gameManager.terrainGrid;
    const st = storm().snapshot();
    const tanks = [];
    for (const e of entities.values()) if (e && (e.isPlayer || e.isBot) && !e.isDead?.()) tanks.push(e);
    // a tank that only just landed (first drop of a raid, or a respawn) gets more
    const now = Date.now();
    const fresh = (t) => t.royaleBornAt && now - t.royaleBornAt < 45_000;
    let freshR = 1300;
    const farFromTanks = (x, y, d) => tanks.every(t => { const r = fresh(t) ? Math.max(d, freshR) : d; return (t.x - x) ** 2 + (t.y - y) ** 2 >= r * r; });
    const inCircle = (tg && tg.spawnPits || []).filter(p => Math.hypot(p.x - st.cx, p.y - st.cy) < (st.r || 1000) * 0.8);
    // never surface next to a vault (round 10)
    const offVault = inCircle.filter(p => !nearVault(p.x, p.y));
    const cands = offVault.length ? offVault : inCircle;
    cands.sort(() => Math.random() - 0.5);
    for (const d of [900, 650, 420]) {
        for (const p of cands) if (farFromTanks(p.x, p.y, d)) return { x: p.x, y: p.y };
    }
    freshR = 0;
    for (const p of cands) if (farFromTanks(p.x, p.y, 420)) return { x: p.x, y: p.y };
    return { x: st.cx || 0, y: st.cy || 0 };
}

function spawn(forceKind, at = null) {
    if (boss && !boss.isDead?.()) return boss;
    const id = forceKind && KINDS[forceKind] ? forceKind : pickKind();
    const kind = KINDS[id];
    const spot = at && isFinite(at.x) && isFinite(at.y) ? { x: at.x, y: at.y } : pickSpot();
    let o;
    try {
        o = new Entity(spot);
        o.define(kind.cls);
    } catch (e) {
        console.error('[BOSS] spawn failed', e && e.message);
        scheduleNext(60_000);
        return null;
    }
    o.team = TEAM_ENEMIES;
    o.name = kind.name;
    o.isRoyaleBoss = true;
    o.bossKind = id;
    o.bossDigs = kind.digs !== false;
    o.bossDigRate = kind.digRate || 0.18;
    o.bossContact = !!kind.contact;
    o.alwaysActive = true;
    o.settings.leaderboardable = false;
    tune(o);
    o.refreshBodyAttributes();
    try { global.gameManager.terrainGrid.pushCircleFromVoronoi(o, o.realSize || 60); } catch { /* */ }
    boss = o; kindId = id; lastKind = id; hitters.clear();
    spawnedAt = Date.now();
    expiresAt = spawnedAt + (at && at.ms > 0 ? at.ms : LIFETIME_MS);
    if (at && at.home) o.bossHome = { x: spot.x, y: spot.y, r: at.home };
    o.on('damage', ({ damageInflictor = [] } = {}) => {
        // this tick's damage, split evenly between the tanks behind it (the
        // boss-reward assist share reads dmg)
        const roots = new Set();
        for (const src of damageInflictor) {
            let root = src, hops = 0;
            while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
            if (root && (root.isPlayer || root.isBot)) roots.add(root);
        }
        const per = roots.size ? Math.max(0, +o.damageReceived || 0) / roots.size : 0;
        for (const root of roots) {
            // shooting the boss ends a fresh spawn's bot grace (dig_royale FIRST_MINUTES)
            if (root.isPlayer && root.botGraceUntil) root.botGraceUntil = 0;
            const h = hitters.get(root.id);
            hitters.set(root.id, { body: root, at: Date.now(), dmg: (h ? h.dmg : 0) + per });
        }
        try { require('./bigHit.js').note(o, damageInflictor, Math.max(0, +o.damageReceived || 0), Date.now(), 'boss'); } catch (e) { }
    });
    o.on('dead', () => onDead(o));
    // round 9: its bullets (hull and turret guns) are tracked so the ones that reach
    shots.length = 0;
    for (const src of [o, ...(Array.isArray(o.turrets) ? o.turrets : [])]) {
        try { src.on('fire', ({ child } = {}) => { if (child && shots.length < 400) shots.push(child); }); } catch { /* */ }
    }
    if (at && at.land) {
        const r = (o.realSize || o.size || 60);
        try { require('./eventSpot.js').clearRock(o.x, o.y, r + 70); } catch (e) { }
        try { require('./eventSpot.js').shove(o.x, o.y, r + 260, royale().fightersNow ? royale().fightersNow() : [], 11); } catch (e) { }
    }
    fx(o.x, o.y, 'bossland', o.id | 0, Math.round(o.realSize || o.size || 60), kind.color || '#c9a8ff');
    try {
        royale().onBossSpawned(o, kind, id);
    } catch (e) { console.error('[BOSS] onBossSpawned', e && e.stack); }
    return o;
}

function rise(forceKind, at, t = Date.now()) {
    if ((boss && !boss.isDead?.()) || pending) return null;
    const id = forceKind && KINDS[forceKind] ? forceKind : pickKind();
    if (!at || !isFinite(at.x) || !isFinite(at.y)) return null;
    const ms = at.riseMs > 0 ? at.riseMs : RISE_MS;
    pending = { id, at: Object.assign({}, at, { land: true }), due: t + ms, startAt: t, x: at.x, y: at.y };
    lastKind = id;
    fx(at.x, at.y, 'bossrise', ms, sizeOf(id), KINDS[id].color || '#c9a8ff');
    return pending;
}
function pendingRise() { return pending; }
function land(t = Date.now()) {
    const p = pending;
    pending = null;
    if (!p) return null;
    const ms = p.at.ms > 0 ? Math.max(1000, p.at.ms - (t - p.startAt)) : 0;
    return spawn(p.id, Object.assign({}, p.at, ms ? { ms } : {}));
}

function exit(ms = EXIT_MS, t = Date.now()) {
    if (!boss || boss.isDead?.() || boss.bossExiting) return false;
    const o = boss;
    o.bossExiting = true;
    o.invuln = true;
    o.pinX = o.x; o.pinY = o.y;
    exitAt = t + ms;
    killBrood(o);
    for (const b of shots) { try { if (b && !b.isDead?.()) b.kill(); } catch (e) { } }
    shots.length = 0;
    fx(o.x, o.y, 'bossexit', o.id | 0, ms, Math.round(o.realSize || o.size || 60), (KINDS[kindId] || {}).color || '#c9a8ff');
    return true;
}
function tickExit(t) {
    const o = boss;
    if (!o || !o.bossExiting) return false;
    o.invuln = true;
    if (o.pinX !== undefined) { o.x = o.pinX; o.y = o.pinY; }
    if (o.velocity) { o.velocity.x = 0; o.velocity.y = 0; }
    if (o.accel) { o.accel.x = 0; o.accel.y = 0; }
    for (const b of shots) { try { if (b && !b.isDead?.()) b.kill(); } catch (e) { } }
    shots.length = 0;
    if (t >= exitAt) {
        exitAt = 0;
        o.bossBurrowed = true;
        o.invuln = false;
        try { o.kill(); } catch (e) { }
    }
    return true;
}

function rootKiller(dead) {
    for (const k of (dead && dead.finalKillers) || []) {
        let root = k, hops = 0;
        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
        if (root && (root.isPlayer || root.isBot) && !root.isDead?.()) return root;
    }
    let best = null, bestAt = 0;
    for (const h of hitters.values()) {
        if (h.body && !h.body.isDead?.() && h.at > bestAt) { best = h.body; bestAt = h.at; }
    }
    return best;
}

function erupt(x, y, total) {
    const raidMods = mods();
    // real ore only, exact total: shards first, then azurite, then copper
    const pieces = gems.splitValue(total, { share: { 3: 0.45, 2: 0.35, 1: 0.2 }, shardValue: 150, maxPieces: 48 });
    const now = Date.now();
    pieces.forEach((p, i) => {
        const ang = (i / pieces.length) * Math.PI * 2 + Math.random() * 0.4;
        const sp = 3.2 + Math.random() * 3;
        const gem = gems.spawnGem(x, y, Math.round(p.v * raidMods.gemValueMult(p.ore)), p.cls,
            p.ore === 3 ? 26 : p.size, Math.cos(ang) * sp, Math.sin(ang) * sp, p.ore);
        if (gem) { gem.gemNoMagnetUntil = now + 1400 + i * 45; gem.gemLong = true; }
    });
}

function onDead(o) {
    if (boss !== o) return;
    const kind = KINDS[kindId] || KINDS.warden;
    const burrowed = !!o.bossBurrowed;
    const killer = burrowed ? null : rootKiller(o);
    const x = o.x, y = o.y;
    boss = null;
    if (!burrowed) {
        erupt(x, y, kind.gems);
        try {
            const chests = require('./chests.js');
            chests.spawnChest(x, y, true, { gems: 200, item: require('./shop.js').randomKitId() });
        } catch { /* */ }
    }
    // damage shares, for the assist reward
    let total = 0;
    for (const h of hitters.values()) total += h.dmg || 0;
    const shares = burrowed || !(total > 0) ? [] : [...hitters.values()].map(h => ({ body: h.body, share: (h.dmg || 0) / total }));
    try { royale().onBossDead(o, kind, killer, burrowed, shares); } catch (e) { console.error('[BOSS] onBossDead', e && e.stack); }
    scheduleNext();
}

// Round 9: bosses stay off vault and shop pads (padGeom.keepOut, the soft push
const BOSS_PADS = process.env.ROYALE_BOSS_PADS !== '0';
const shots = [];
function safePads() {
    const out = [];
    try { for (const v of require('./vault.js').getVaults()) out.push(v); } catch { /* */ }
    try { for (const p of require('./shop.js').getShops()) out.push(p); } catch { /* */ }
    return out;
}
// Round 10: bosses don't hang around vaults either. Roam points, chase spots
// and spawn pits stay VAULT_CLEAR past a vault's rim (ROYALE_BOSS_VAULT_CLEAR,
// 0 = off; the Vault Warden too).
const VAULT_CLEAR = (() => { const v = parseFloat(process.env.ROYALE_BOSS_VAULT_CLEAR); return Number.isFinite(v) && v >= 0 ? v : 400; })();
function vaultRing(v) { return (v.r || 95) * (padGeom.OCT.scale || 1.4) + VAULT_CLEAR; }
// the vault whose no-loiter ring holds (x, y), or null
function nearVault(x, y, list) {
    if (!(VAULT_CLEAR > 0)) return null;
    let vs = list;
    if (!vs) { try { vs = require('./vault.js').getVaults() || []; } catch { vs = []; } }
    for (const v of vs) {
        const R = vaultRing(v);
        if ((x - v.x) ** 2 + (y - v.y) ** 2 < R * R) return v;
    }
    return null;
}
// (x, y) pushed straight out of any vault ring it is in
function clearOfVaults(pt, list) {
    let p = { x: pt.x, y: pt.y };
    for (let i = 0; i < 3; i++) {
        const v = nearVault(p.x, p.y, list);
        if (!v) break;
        let dx = p.x - v.x, dy = p.y - v.y, d = Math.hypot(dx, dy);
        if (d < 1) { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
        const R = vaultRing(v) + 40;
        p = { x: v.x + dx / d * R, y: v.y + dy / d * R };
    }
    return p;
}
function tickPads(o, pads = safePads()) {
    if (!BOSS_PADS || !o || !pads.length) return 0;
    for (const p of pads) {
        try { padGeom.keepOut(o, p, 8, 'boss:' + (p.id != null ? p.id : p.x + ',' + p.y)); } catch { /* */ }
    }
    let killed = 0;
    for (let i = shots.length - 1; i >= 0; i--) {
        const b = shots[i];
        if (!b || b.isGhost || (b.isDead && b.isDead()) || (b.health && b.health.amount <= 0)) { shots.splice(i, 1); continue; }
        for (const p of pads) {
            if (padGeom.insidePad(p, b.x, b.y, b.size || 0)) {
                try { b.velocity.x = 0; b.velocity.y = 0; b.accel.x = 0; b.accel.y = 0; b.kill(); } catch { /* */ }
                shots.splice(i, 1);
                killed++;
                break;
            }
        }
    }
    return killed;
}
function tick(t, combatantCount) {
    if (!nextAt) scheduleNext(firstDelay());
    if (pending && !boss) {
        if (t >= pending.due) land(t);
        return;
    }
    if (boss) {
        // Health hit zero before the 'dead' event fired: settle it here, or
        // the handler sees a stale boss and skips the eruption, chest and fx.
        if (boss.isDead?.()) { onDead(boss); return; }
        if (tickExit(t)) return;
        if (t > expiresAt) {
            if (!exit()) { boss.bossBurrowed = true; try { boss.kill(); } catch (e) { boss.bossBurrowed = true; } }
            return;
        }
        // stormed bosses stay dangerous: no storm chip on them
        boss._inStorm = false;
        boss.invuln = false;
        guard.regenGate(boss, TUNING.regenEvery);
        tickPads(boss);
        return;
    }
    const S = storm();
    const st = S.snapshot(t);
    if (!st.a || st.fin) { nextAt = Infinity; return; }
    const cyc = st.c | 0;
    if (cyc !== bossCycle) { bossCycle = cyc; cycleBosses = 0; }
    const cycleEnd = S.resetAt();
    const cycleStart = cycleEnd - S.shrinkMs() - S.holdMs();
    const allowed = mods().num('bossRateMult', 1) > 1 ? 2 : 1;
    if (cycleBosses >= allowed) { nextAt = Infinity; return; }
    nextAt = cycleBosses === 0 ? cycleStart + (cyc === 0 ? FIRST_CYCLE_DELAY_MS : CYCLE_SPAWN_DELAY_MS) : t;
    if (t < nextAt || cycleEnd - t < CYCLE_MIN_LEFT_MS) return;
    if ((combatantCount || 0) < 2 || S.locked(t)) return;
    const b = spawn();
    if (b) {
        cycleBosses++;
        // it goes back underground when this storm cycle ends
        expiresAt = cycleEnd;
    }
}

function snapshot() {
    if (!boss || boss.isDead?.() || boss.bossExiting) return null;
    const kind = KINDS[kindId] || {};
    const hp = boss.health && boss.health.max ? Math.max(0, Math.min(1, boss.health.amount / boss.health.max)) : 1;
    const sh = boss.shield && boss.shield.max ? Math.max(0, Math.min(1, boss.shield.amount / boss.shield.max)) : 0;
    return {
        id: boss.id, kind: kindId, name: kind.name || 'Boss', c: kind.color || '#ffffff',
        x: Math.round(boss.x), y: Math.round(boss.y), hp: Math.round(hp * 1000) / 1000, sh: Math.round(sh * 1000) / 1000,
        gems: kind.gems, until: expiresAt,
    };
}

function current() { return boss && !boss.isDead?.() && !boss.bossExiting ? boss : null; }
function hitterList() {
    let total = 0;
    for (const h of hitters.values()) total += Math.max(0, h.dmg || 0);
    return [...hitters.values()].map(h => ({ body: h.body, dmg: h.dmg || 0, share: total > 0 ? Math.max(0, h.dmg || 0) / total : 0, at: h.at }));
}
function burrow() {
    pending = null;
    if (!boss || boss.isDead?.()) return false;
    exitAt = 0;
    boss.bossBurrowed = true;
    try { boss.kill(); } catch { }
    return true;
}
function nextIn() { return Math.max(0, nextAt - Date.now()); }

// Damage this tank has done to the current boss (contracts).
function damageBy(body) {
    const h = body && hitters.get(body.id);
    return h ? (h.dmg || 0) : 0;
}

// DBG only: book damage for a tank (reward tests)
function debugHit(body, dmg) {
    if (!body) return;
    const h = hitters.get(body.id);
    hitters.set(body.id, { body, at: Date.now(), dmg: (h ? h.dmg : 0) + (+dmg || 0) });
}

module.exports = { RISE_MS, EXIT_MS, rise, land, exit, pendingRise, exiting: () => !!(boss && boss.bossExiting && !boss.isDead?.()), hitterList, burrow, VAULT_CLEAR, nearVault, clearOfVaults, tickPads, _shots: shots, FIRST_CYCLE_DELAY_MS, CYCLE_SPAWN_DELAY_MS, debugHit, damageBy, KINDS, TUNING, RATE, BASE_INTERVAL_MS, LIFETIME_MS, firstDelay, tune, spawn, tick, snapshot, current, resetRaid, nextIn, scheduleNext, erupt };
