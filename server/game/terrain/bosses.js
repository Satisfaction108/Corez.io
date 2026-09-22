// Raid bosses: rare, loud, solo-killable. One surfaces every couple of storm
// cycles, roams the safe zone, and erupts gems plus a rare cache when it dies.
const gems = require('./gems.js');

const KINDS = {
    // every boss digs (digRate = share of a rock's health chewed per bite) so
    // none of them ever sits stuck in the wall when the storm moves
    warden:    { cls: 'royaleVaultWarden',    name: 'Vault Warden',    gems: 2500, score: 600, color: '#8d6adf', digs: true, digRate: 0.18, blurb: 'Armored. Traps. Sixteen barrels.' },
    drillhead: { cls: 'royaleMagmaDrillhead', name: 'Magma Drillhead', gems: 1800, score: 450, color: '#ff6c3a', digs: true, digRate: 0.3, contact: false, blurb: 'Fast. Digs through the wall. Hits like a truck.' },
    colossus:  { cls: 'royaleGeodeColossus',  name: 'Geode Colossus',  gems: 3200, score: 750, color: '#62caa7', digs: true, digRate: 0.18, blurb: 'The wall itself. Thirteen turrets.' },
    wraith:    { cls: 'royaleShardWraith',    name: 'Shard Wraith',    gems: 2200, score: 550, color: '#d153cc', digs: true, digRate: 0.18, blurb: 'Summons shards. Snipes from range.' },
};
const ORDER = ['warden', 'drillhead', 'colossus', 'wraith'];
const DEBUG = !!process.env.ROYALE_DEBUG;
const BASE_INTERVAL_MS = DEBUG ? 45 * 1000 : 14 * 60 * 1000;
const FIRST_DELAY_MS = DEBUG ? 12 * 1000 : 5 * 60 * 1000;
const LIFETIME_MS = 8 * 60 * 1000;

let boss = null;
let kindId = null;
let spawnedAt = 0;
let expiresAt = 0;
let nextAt = 0;
let lastKind = null;
let hitters = new Map();

function storm() { return require('./storm.js'); }
function mods() { return require('./raidMods.js'); }
function royale() { return require('../gamemodes/scripts/dig_royale.js'); }

function jitter(ms) { return ms * (0.8 + Math.random() * 0.4); }

function scheduleNext(fromNow) {
    const rate = Math.max(0.25, mods().num('bossRateMult', 1));
    nextAt = Date.now() + jitter((fromNow != null ? fromNow : BASE_INTERVAL_MS) / rate);
}

function resetRaid() {
    if (boss && !boss.isDead?.()) { boss.bossBurrowed = true; try { boss.kill(); } catch { /* */ } }
    boss = null; kindId = null; hitters.clear();
    scheduleNext(FIRST_DELAY_MS);
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
    const farFromTanks = (x, y, d) => tanks.every(t => (t.x - x) ** 2 + (t.y - y) ** 2 >= d * d);
    const cands = (tg && tg.spawnPits || []).filter(p => Math.hypot(p.x - st.cx, p.y - st.cy) < (st.r || 1000) * 0.8);
    cands.sort(() => Math.random() - 0.5);
    for (const d of [900, 650, 420]) {
        for (const p of cands) if (farFromTanks(p.x, p.y, d)) return { x: p.x, y: p.y };
    }
    return { x: st.cx || 0, y: st.cy || 0 };
}

function spawn(forceKind) {
    if (boss && !boss.isDead?.()) return boss;
    const id = forceKind && KINDS[forceKind] ? forceKind : pickKind();
    const kind = KINDS[id];
    const spot = pickSpot();
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
    o.refreshBodyAttributes();
    try { global.gameManager.terrainGrid.pushCircleFromVoronoi(o, o.realSize || 60); } catch { /* */ }
    boss = o; kindId = id; lastKind = id; hitters.clear();
    spawnedAt = Date.now();
    expiresAt = spawnedAt + LIFETIME_MS;
    o.on('damage', ({ damageInflictor = [] } = {}) => {
        for (const src of damageInflictor) {
            let root = src, hops = 0;
            while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
            if (root && (root.isPlayer || root.isBot)) hitters.set(root.id, { body: root, at: Date.now() });
        }
    });
    o.on('dead', () => onDead(o));
    try {
        royale().onBossSpawned(o, kind, id);
    } catch (e) { console.error('[BOSS] onBossSpawned', e && e.stack); }
    return o;
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
        if (gem) gem.gemNoMagnetUntil = now + 1400 + i * 45;
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
    try { royale().onBossDead(o, kind, killer, burrowed); } catch (e) { console.error('[BOSS] onBossDead', e && e.stack); }
    scheduleNext();
}

function tick(t, combatantCount) {
    if (!nextAt) scheduleNext(FIRST_DELAY_MS);
    if (boss) {
        // health hit zero but the entity's 'dead' event has not fired yet:
        // settle it here, or the event handler would see a stale boss and
        // skip the eruption, the chest and the kill effect
        if (boss.isDead?.()) { onDead(boss); return; }
        if (t > expiresAt) {
            boss.bossBurrowed = true;
            try { boss.kill(); } catch { /* */ }
            return;
        }
        // stormed bosses stay dangerous: no storm chip on them
        boss._inStorm = false;
        boss.invuln = false;
        return;
    }
    if (t >= nextAt && (combatantCount || 0) >= 2 && !storm().locked(t)) spawn();
}

function snapshot() {
    if (!boss || boss.isDead?.()) return null;
    const kind = KINDS[kindId] || {};
    const hp = boss.health && boss.health.max ? Math.max(0, Math.min(1, boss.health.amount / boss.health.max)) : 1;
    const sh = boss.shield && boss.shield.max ? Math.max(0, Math.min(1, boss.shield.amount / boss.shield.max)) : 0;
    return {
        id: boss.id, kind: kindId, name: kind.name || 'Boss', c: kind.color || '#ffffff',
        x: Math.round(boss.x), y: Math.round(boss.y), hp: Math.round(hp * 1000) / 1000, sh: Math.round(sh * 1000) / 1000,
        gems: kind.gems, until: expiresAt,
    };
}

function current() { return boss && !boss.isDead?.() ? boss : null; }
function nextIn() { return Math.max(0, nextAt - Date.now()); }

module.exports = { KINDS, spawn, tick, snapshot, current, resetRaid, nextIn, scheduleNext, erupt };
