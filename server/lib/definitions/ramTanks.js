// Ram tanks get the smasher stat set
'use strict';

const { smshskl, statnames } = require('./constants.js');

const THRUSTER_DEG = 100;
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const resolve = t => typeof t === 'string' ? Class[t] : Array.isArray(t) ? resolve(t[0]) : (t && typeof t === 'object' ? t : null);
function get(def, k, n = 0) {
    if (!def || n > 30) return undefined;
    if (def[k] !== undefined) return def[k];
    const ps = arr(def.PARENT);
    for (let i = ps.length - 1; i >= 0; i--) { const v = get(resolve(ps[i]), k, n + 1); if (v !== undefined) return v; }
    return undefined;
}
function angleOf(g) {
    const P = g && g.POSITION;
    const a = Array.isArray(P) ? P[5] : P && P.ANGLE;
    let d = ((+a || 0) % 360 + 360) % 360;
    return d > 180 ? 360 - d : d;          // 0 = the nose, 180 = straight back
}
function shoots(def, depth = 0) {
    if (!def || depth > 4) return false;
    return arr(get(def, 'GUNS')).some(g => g && g.PROPERTIES && g.PROPERTIES.SHOOT_SETTINGS) ||
        arr(get(def, 'TURRETS')).some(t => shoots(resolve(t && t.TYPE), depth + 1));
}

// -> { ram, kind: 'ram' | 'ramAuto' | '', smasher, autos, thrusters, front, drone, trap }
function classify(def) {
    const out = { ram: false, kind: '', smasher: false, autos: 0, thrusters: 0, front: 0, drone: 0, trap: 0 };
    if (!def) return out;
    out.smasher = !!get(def, 'IS_SMASHER');
    for (const g of arr(get(def, 'GUNS'))) {
        const pr = g && g.PROPERTIES;
        if (!pr || !pr.SHOOT_SETTINGS) continue;
        const pd = resolve(pr.TYPE), type = String((pd && get(pd, 'TYPE')) || 'bullet');
        if (type === 'drone' || type === 'minion' || pr.MAX_CHILDREN || pr.STAT_CALCULATOR === 'necro') out.drone++;
        else if (type === 'trap' || type === 'block') out.trap++;
        else if (angleOf(g) > THRUSTER_DEG) out.thrusters++;
        else out.front++;
    }
    for (const t of arr(get(def, 'TURRETS'))) if (shoots(resolve(t && t.TYPE))) out.autos++;
    out.ram = out.smasher || (!out.front && !out.drone && !out.trap && (out.thrusters > 0 || !out.autos));
    if (out.ram) out.kind = out.autos || out.front || out.drone || out.trap ? 'ramAuto' : 'ram';
    return out;
}

// the two stat sets, exactly as groups/generics.js genericSmasher and groups/tanks.js
const CAPS = {
    ram: { RELOAD: smshskl, PENETRATION: 0, BULLET_HEALTH: 0, BULLET_DAMAGE: 0, BULLET_SPEED: 0, SHIELD_CAPACITY: smshskl, BODY_DAMAGE: smshskl, MAX_HEALTH: smshskl, SHIELD_REGENERATION: smshskl, MOVEMENT_SPEED: smshskl, MINING_POWER: smshskl },
    ramAuto: { RELOAD: smshskl, PENETRATION: smshskl, BULLET_HEALTH: smshskl, BULLET_DAMAGE: smshskl, BULLET_SPEED: smshskl, SHIELD_CAPACITY: smshskl, BODY_DAMAGE: smshskl, MAX_HEALTH: smshskl, SHIELD_REGENERATION: smshskl, MOVEMENT_SPEED: smshskl, MINING_POWER: smshskl },
};

// every tank in the tree under root: give each ram tank its stat set
function apply(root = 'basic') {
    const done = new Map();
    const keyOf = new Map(); for (const k in Class) keyOf.set(Class[k], k);
    const seen = new Set([root]), q = [root];
    while (q.length) {
        const k = q.shift(), d = Class[k];
        if (!d) continue;
        for (let t = 1; t <= 4; t++) for (let e of arr(d['UPGRADES_TIER_' + t])) {
            if (Array.isArray(e)) { if (e.length !== 1) continue; e = e[0]; }
            const ck = typeof e === 'string' ? e : keyOf.get(e);
            if (ck && !seen.has(ck)) { seen.add(ck); q.push(ck); }
        }
    }
    // classify everything first, then set: a gun tank whose parent turns into a ram tank
    const before = new Map();
    for (const k of seen) {
        const d = Class[k];
        if (!d || k === root) continue;
        before.set(k, { c: classify(d), smasher: get(d, 'IS_SMASHER'), caps: get(d, 'SKILL_CAP'), names: get(d, 'STAT_NAMES') });
    }
    for (const [k, b] of before) {
        if (!b.c.ram) continue;
        const d = Class[k];
        d.IS_SMASHER = true;
        d.STAT_NAMES = statnames.smasher;
        d.SKILL_CAP = { ...CAPS[b.c.kind] };
        done.set(k, b.c.kind);
    }
    for (const [k, b] of before) {
        if (b.c.ram) continue;
        const d = Class[k];
        if (get(d, 'SKILL_CAP') !== b.caps) d.SKILL_CAP = b.caps;
        if (get(d, 'STAT_NAMES') !== b.names) d.STAT_NAMES = b.names;
        if (!!get(d, 'IS_SMASHER') !== !!b.smasher) d.IS_SMASHER = !!b.smasher;
    }
    return done;
}

module.exports = { classify, apply };
