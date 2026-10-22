// The expanded tank tree: on by default for Dig Royale
'use strict';
if ((process.env.ROYALE_TANKS || 'expanded') === 'classic' || Config.arms_race || Config.tutorial) return;

const D = require('../tanks_expansion_data.js');
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
for (const t of D.tanks) Class[t.key] = copy(t.def);

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
for (const key in D.balance) {
    const def = Class[key]; if (!def) continue;
    snap[key] = { guns: arr(get(def, 'GUNS')), turrets: arr(get(def, 'TURRETS')), body: body(def), smasher: !!get(def, 'IS_SMASHER') };
}
for (const key in snap) {
    // [4]: the turrets' own factor when it differs (a drone tank's autos ride on top: gen-tanks.js)
    const [s, hp, , , ts] = D.balance[key], o = snap[key], def = Class[key];
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
Class.basic.UPGRADES_TIER_1 = Class.basic.UPGRADES_TIER_1.map(k => D.removed.includes(k) ? D.root : k).filter((k, i, a) => a.indexOf(k) === i);
const t5free = process.env.ROYALE_TANKS_T5_FREE === '1';
for (const t of D.tanks) {
    if (t.key === D.root) continue;
    const slot = 'UPGRADES_TIER_' + (t.tier === 5 && t5free ? 3 : t.tier - 1);
    for (const p of t.parents) {
        const def = Class[p]; if (!def) continue;
        def[slot] = [...arr(def[slot])];
        if (!def[slot].includes(t.key)) def[slot].push(t.key);
    }
}
// 4. ram tanks (smasher lineage, or only thrusters / auto turrets) take the Smasher /
require('../ramTanks.js').apply('basic');
