// The expanded tank tree: on by default for Dig Royale
'use strict';
if ((process.env.ROYALE_TANKS || 'expanded') === 'classic' || Config.arms_race || Config.tutorial) return;

const D = require('../tanks_expansion_data.js');
const INVENTED = Config.invented_tanks === true;
const TANKS = INVENTED ? D.tanks : [];
const BALANCE = INVENTED ? D.balance : {};
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const copy = x => JSON.parse(JSON.stringify(x));
const resolve = t => typeof t === 'string' ? Class[t] : Array.isArray(t) ? resolve(t[0]) : (t && typeof t === 'object' ? t : null);
function get(def, k, n = 0) {
    if (!def || n > 30) return undefined;
    if (def[k] !== undefined) return def[k];
    const ps = arr(def.PARENT);
    for (let i = ps.length - 1; i >= 0; i--) { const v = get(resolve(ps[i]), k, n + 1); if (v !== undefined) return v; }
    return undefined;
}
function body(def, n = 0) {
    if (!def || n > 30) return {};
    const out = {};
    for (const p of arr(def.PARENT)) Object.assign(out, body(resolve(p), n + 1));
    return Object.assign(out, def.BODY || {});
}

// 1. the new tanks
for (const t of TANKS) Class[t.key] = copy(t.def);

const gunAngle = g => { const p = g && g.POSITION; if (!p) return 0; const a = Array.isArray(p) ? p[5] : p.ANGLE; return ((((+a || 0) % 360) + 540) % 360) - 180; };
const rearGun = g => Math.abs(gunAngle(g)) >= 120;
const isBird = def => arr(get(def, 'GUNS')).some(g => g.PROPERTIES && g.PROPERTIES.ALT_FIRE);
const hasZoom = def => arr(get(def, 'CONTROLLERS')).some(c => (Array.isArray(c) ? c[0] : c) === 'zoom');
for (const t of [...TANKS].sort((a, b) => a.tier - b.tier)) {
    const def = Class[t.key];
    if (!def || !Array.isArray(def.GUNS)) continue;
    if (!t.parents.some(p => isBird(Class[p]))) continue;
    const zoomFrom = t.parents.map(p => Class[p]).find(hasZoom);
    if (zoomFrom) { def.CONTROLLERS = copy(arr(get(zoomFrom, 'CONTROLLERS'))); continue; }
    const firing = def.GUNS.filter(g => g.PROPERTIES && g.PROPERTIES.SHOOT_SETTINGS);
    const rear = firing.filter(rearGun);
    const front = firing.filter(g => !rearGun(g) && !g.PROPERTIES.AUTOFIRE && !['drone', 'necro', 'swarm'].includes(g.PROPERTIES.STAT_CALCULATOR));
    if (rear.length < 2 || !front.length) continue;
    for (const g of front) g.PROPERTIES.ALT_FIRE = true;
}

const SHOT_FLOOR = { bullet: 4, drone: 6, trap: 5 };
function shotKind(pr) {
    const calc = pr.STAT_CALCULATOR || '', type = JSON.stringify(pr.TYPE || '');
    if (calc === 'swarm' || /swarm|minion/i.test(type)) return null;
    if (calc === 'drone' || calc === 'necro' || /drone/i.test(type)) return 'drone';
    if (calc === 'trap' || calc === 'block' || /trap|block/i.test(type)) return 'trap';
    return 'bullet';
}
function floorShots(keys) {
for (const key of keys) {
    const def = Class[key];
    for (const g of arr(def && def.GUNS)) {
        const pr = g && g.PROPERTIES, ss = pr && pr.SHOOT_SETTINGS, pos = g && g.POSITION;
        if (!ss || !pos || !(ss.size >= 0.05)) continue;
        const width = Array.isArray(pos) ? pos[1] : pos.WIDTH;
        const floor = SHOT_FLOOR[shotKind(pr)];
        if (!floor || !(width > 0) || width * ss.size >= floor) continue;
        pr.SHOOT_SETTINGS = { ...ss, size: floor / width };
    }
}
}
floorShots(TANKS.map(t => t.key));

const DRONE_RATE_CAP = 4 / 45;
function capDrones(keys) {
for (const key of keys) {
    const def = Class[key];
    const spawners = arr(def && def.GUNS).filter(g => {
        const pr = g && g.PROPERTIES, ss = pr && pr.SHOOT_SETTINGS;
        return ss && ss.reload > 0 && shotKind(pr) === 'drone' && (pr.STAT_CALCULATOR === 'drone' || pr.STAT_CALCULATOR === 'necro');
    });
    const rate = spawners.reduce((sum, g) => sum + 1 / g.PROPERTIES.SHOOT_SETTINGS.reload, 0);
    if (!(rate > DRONE_RATE_CAP)) continue;
    const slow = rate / DRONE_RATE_CAP;
    for (const g of spawners) g.PROPERTIES.SHOOT_SETTINGS = { ...g.PROPERTIES.SHOOT_SETTINGS, reload: g.PROPERTIES.SHOOT_SETTINGS.reload * slow };
}
}
capDrones(TANKS.map(t => t.key));

// 2. balance: every damage number of a new tank times s
let made = 0;
const armed = def => arr(get(def, 'GUNS')).some(g => g.PROPERTIES && g.PROPERTIES.SHOOT_SETTINGS) || arr(get(def, 'TURRETS')).some(t => armed(resolve(t.TYPE)));
function scaledType(type, s, depth) {
    const def = resolve(type);
    if (!def || depth > 3 || !armed(def)) return type;
    const key = 'xp_scaled' + (made++);
    Class[key] = { PARENT: Array.isArray(type) ? type[0] : type, GUNS: arr(get(def, 'GUNS')).map(g => scaleGun(g, s, depth + 1)), TURRETS: arr(get(def, 'TURRETS')).map(t => scaleTurret(t, s, depth + 1)) };
    return Array.isArray(type) ? [key, ...type.slice(1)] : key;
}
function scaleGun(g, s, depth) {
    const pr = g.PROPERTIES; if (!pr || !pr.SHOOT_SETTINGS) return g;
    const out = { ...g, PROPERTIES: { ...pr, SHOOT_SETTINGS: { ...pr.SHOOT_SETTINGS, damage: pr.SHOOT_SETTINGS.damage * s } } };
    if (pr.TYPE != null) out.PROPERTIES.TYPE = scaledType(pr.TYPE, s, depth);
    return out;
}
function scaleTurret(t, s, depth) { return { ...t, TYPE: scaledType(t.TYPE, s, depth) }; }
const snap = {};
for (const key in BALANCE) {
    const def = Class[key]; if (!def) continue;
    snap[key] = { guns: arr(get(def, 'GUNS')), turrets: arr(get(def, 'TURRETS')), body: body(def), smasher: !!get(def, 'IS_SMASHER') };
}
for (const key in snap) {
    // [4]: the turrets' own factor when it differs (a drone tank's autos ride on top: gen-tanks.js)
    const [s, hp, , , ts] = BALANCE[key], o = snap[key], def = Class[key];
    def.GUNS = o.guns.map(g => scaleGun(g, s, 0));
    def.TURRETS = o.turrets.map(t => scaleTurret(t, ts ?? s, 0));
    const b = { ...o.body };
    if (o.smasher) b.DAMAGE = (b.DAMAGE ?? 1) * s;
    if (hp !== 1) b.HEALTH = (b.HEALTH ?? 1) * hp;
    def.BODY = b;
}
// 2b. hand tuning for generated tanks whose budget number played wrong.
// Applied after the balance pass, so these are the final numbers.
// Citron: one spawner with four minions had twice the Auto-Spawner's reload,
// slower minions and thin health, so it could not keep up.
const TUNE = {
    Citron: { reload: 72, health: 2.4, damage: 2.6, speed: 3.8, maxSpeed: 1.4, minionDamage: 1.7, recallRange: 900 },
};
for (const key in Class) {
    const def = Class[key];
    const tune = def && TUNE[def.LABEL];
    if (!tune) continue;
    for (const g of arr(def.GUNS)) {
        const pr = g && g.PROPERTIES;
        if (!pr || !pr.SHOOT_SETTINGS || !(pr.SHOOT_SETTINGS.reload > 0)) continue;
        for (const k of ['reload', 'health', 'damage', 'speed', 'maxSpeed']) {
            if (tune[k] != null) pr.SHOOT_SETTINGS[k] = tune[k];
        }
        if (tune.recallRange != null) pr.RECALL_RANGE = tune.recallRange;
        // the spawned minions' own bullets hit harder too (their class is a
        // scaled copy made just for this tank, so nobody else changes)
        const minion = Array.isArray(pr.TYPE) ? Class[pr.TYPE[0]] : Class[pr.TYPE];
        if (tune.minionDamage && minion && minion.GUNS) {
            for (const mg of minion.GUNS) {
                const ms = mg && mg.PROPERTIES && mg.PROPERTIES.SHOOT_SETTINGS;
                if (ms) ms.damage *= tune.minionDamage;
            }
        }
    }
}

// 3. the tree: Splitter in Desmos's slot, every new tank under each parent
Class.basic.UPGRADES_TIER_1 = Class.basic.UPGRADES_TIER_1.map(k => D.removed.includes(k) ? (INVENTED ? D.root : null) : k).filter((k, i, a) => k && a.indexOf(k) === i);
const t5free = process.env.ROYALE_TANKS_T5_FREE === '1';
for (const t of TANKS) {
    if (t.key === D.root) continue;
    const slot = 'UPGRADES_TIER_' + (t.tier === 5 && t5free ? 3 : t.tier - 1);
    for (const p of t.parents) {
        const def = Class[p]; if (!def) continue;
        def[slot] = [...arr(def[slot])];
        if (!def[slot].includes(t.key)) def[slot].push(t.key);
    }
}
if (Config.armsrace_merge !== false) {
    require('./armsRace/tanks.js');
    const M = require('../armsrace_merge_data.js');
    const merged = Object.keys(M.balance).filter(k => Class[k]);
    const arSnap = {};
    for (const key of merged) {
        const def = Class[key];
        arSnap[key] = { guns: arr(get(def, 'GUNS')), turrets: arr(get(def, 'TURRETS')), body: body(def), smasher: !!get(def, 'IS_SMASHER') };
    }
    for (const key of merged) {
        const [s, hp] = M.balance[key], o = arSnap[key], def = Class[key];
        def.GUNS = o.guns.map(g => scaleGun(g, s, 0));
        def.TURRETS = o.turrets.map(t => scaleTurret(t, s, 0));
        const b = { ...o.body };
        if (o.smasher) b.DAMAGE = (b.DAMAGE ?? 1) * s;
        if (hp !== 1) b.HEALTH = (b.HEALTH ?? 1) * hp;
        def.BODY = b;
    }
    floorShots(merged);
    capDrones(merged);
    for (const [parent, child, slot] of M.links) {
        const def = Class[parent];
        if (!def || !Class[child]) continue;
        const key = 'UPGRADES_TIER_' + (slot === 4 && t5free ? 3 : slot);
        def[key] = [...arr(def[key])];
        if (!def[key].includes(child)) def[key].push(child);
    }
}
// 4. ram tanks (smasher lineage, or only thrusters / auto turrets) take the Smasher /
const CUT_BRANCHES = ['xp_splitter', 'xp_bumper'];
for (const key in Class) {
    const def = Class[key];
    if (!def || typeof def !== 'object') continue;
    for (let t = 1; t <= 4; t++) {
        const slot = 'UPGRADES_TIER_' + t;
        if (Array.isArray(def[slot]) && def[slot].some(u => CUT_BRANCHES.includes(u))) def[slot] = def[slot].filter(u => !CUT_BRANCHES.includes(u));
    }
}
require('../ramTanks.js').apply('basic');
if (Config.power_budget !== false) {
    let PB = null;
    try { PB = require('../power_budget_data.js'); } catch { PB = null; }
    if (PB) {
        const treeKeys = [];
        const seenPB = new Set(['basic']);
        const queuePB = ['basic'];
        while (queuePB.length) {
            const k = queuePB.shift();
            treeKeys.push(k);
            for (let t = 1; t <= 4; t++) for (const u of arr(Class[k] && Class[k]['UPGRADES_TIER_' + t])) {
                if (typeof u === 'string' && Class[u] && !seenPB.has(u)) { seenPB.add(u); queuePB.push(u); }
            }
        }
        const snapPB = {};
        for (const key of treeKeys) {
            const def = Class[key];
            snapPB[key] = { guns: arr(get(def, 'GUNS')), turrets: arr(get(def, 'TURRETS')), body: body(def), smasher: !!get(def, 'IS_SMASHER') };
        }
        for (const key of treeKeys) {
            const fs = PB.fight[key] ?? 1, hs = PB.hp[key] ?? 1;
            if (fs === 1 && hs === 1) continue;
            const o = snapPB[key], def = Class[key];
            def.GUNS = fs === 1 ? o.guns : o.guns.map(g => scaleGun(g, fs, 0));
            def.TURRETS = fs === 1 ? o.turrets : o.turrets.map(t => scaleTurret(t, fs, 0));
            const b = { ...o.body };
            if (o.smasher && fs !== 1) b.DAMAGE = (b.DAMAGE ?? 1) * fs;
            if (hs !== 1) b.HEALTH = (b.HEALTH ?? 1) * hs;
            def.BODY = b;
        }
        for (const key of treeKeys) {
            if (PB.fight[key] != null || PB.hp[key] != null) continue;
            const def = Class[key], o = snapPB[key];
            def.GUNS = o.guns;
            def.TURRETS = o.turrets;
            def.BODY = o.body;
        }
    }
}
