// Tank power budget and a flattener that resolves a definition
// Needs the real definitions loaded (global Class).
'use strict';

const GK = ['LENGTH', 'WIDTH', 'ASPECT', 'X', 'Y', 'ANGLE', 'DELAY'], GD = [18, 8, 1, 0, 0, 0, 0];
const TK = ['SIZE', 'X', 'Y', 'ANGLE', 'ARC', 'LAYER'], TD = [10, 0, 0, 0, 360, 0];
const pos = (P, K, D) => { const o = {}; K.forEach((k, i) => { const v = Array.isArray(P) ? P[i] : P && P[k]; o[k] = v ?? D[i]; }); return o; };
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];

function resolve(t) {
    if (t == null) return null;
    if (typeof t === 'string') return Class[t] || null;
    if (Array.isArray(t)) return resolve(t[0]);
    return typeof t === 'object' ? t : null;
}
// the type's own option objects ([type, {COLOR: ...}])
const typeOpts = t => Array.isArray(t) ? Object.assign({}, ...t.slice(1).filter(o => o && typeof o === 'object' && !Array.isArray(o))) : {};
function typeName(t) {
    // a rebalanced copy (entityAddons/tanksExpansion.js) keeps its original's kind
    if (typeof t === 'string') return /^xp_scaled/.test(t) && Class[t] ? typeName(Class[t].PARENT) : t;
    if (Array.isArray(t)) return typeName(t[0]);
    if (t && typeof t === 'object') return typeName(t.PARENT) || t.LABEL || 'obj';
    return null;
}
// own value first, then the parents (later PARENT entries override earlier ones)
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
function colorOf(c) { if (c && typeof c === 'object') return colorOf(c.BASE); return c; }

// a projectile that fires its own projectiles (hive, missile, splitter)
function projectile(t, depth) {
    const def = resolve(t); if (!def) return null;
    const gs = arr(get(def, 'GUNS'));
    if (!gs.some(g => g.PROPERTIES && g.PROPERTIES.TYPE && g.PROPERTIES.SHOOT_SETTINGS)) return null;
    const f = flatten(t, depth + 1);
    return f && { f, life: (body(def).RANGE ?? 90) / 30 };
}
function flatten(t, depth = 0) {
    const def = resolve(t); if (!def) return null;
    const opts = typeOpts(t);
    const guns = arr(get(def, 'GUNS')).map(gn => {
        const p = pos(gn.POSITION, GK, GD), pr = gn.PROPERTIES || {};
        const typed = !!(pr.TYPE && pr.SHOOT_SETTINGS);
        return { L: p.LENGTH, W: p.WIDTH, asp: p.ASPECT, X: p.X, Y: p.Y, a: p.ANGLE, d: p.DELAY, typed,
            type: typed ? typeName(pr.TYPE) : null, ss: typed ? pr.SHOOT_SETTINGS : null, proj: typed && depth < 3 ? projectile(pr.TYPE, depth) : null, max: pr.MAX_CHILDREN || 0, sod: !!pr.SHOOT_ON_DEATH,
            col: colorOf(pr.COLOR), noRecoil: false };
    });
    const tur = (list, prop) => arr(list).map(tr => {
        const p = pos(tr.POSITION, TK, TD), o = typeOpts(tr.TYPE);
        const f = depth < 3 ? flatten(tr.TYPE, depth + 1) : null;
        return f && { S: p.SIZE, X: p.X, Y: p.Y, a: p.ANGLE, layer: p.LAYER, prop, color: colorOf(o.COLOR ?? f.color), def: f };
    }).filter(Boolean);
    return {
        label: opts.LABEL ?? get(def, 'LABEL'), shape: get(def, 'SHAPE') ?? 0, color: colorOf(opts.COLOR ?? get(def, 'COLOR')),
        smasher: !!get(def, 'IS_SMASHER'), maxChildren: get(def, 'MAX_CHILDREN') || 0, noRecoil: !!get(def, 'HAS_NO_RECOIL'),
        body: body(def), guns, turrets: [...tur(get(def, 'TURRETS'), false), ...tur(get(def, 'PROPS'), true)],
    };
}

// ---- budget ---- The plan's constants, with hExp/pExp the exponents on bullet health
const C = { hExp: 0.5, pExp: 0.5, trap: 0.75, swarm: 0.85, drone: 0.4, minion: 0.5, stock: 0.35, side: 0.15, turret: 0.8, rateExp: 1, reachExp: 0.2 };
const setConstants = o => Object.assign(C, o);
const isStock = t => /drone|minion|chip|summon/i.test(t || '');
function kappa(t) {
    t = t || '';
    if (/drone|chip/i.test(t)) return C.drone;
    if (/minion/i.test(t)) return C.minion;
    if (/trap|pillbox|box|boomerang|block|assemblent/i.test(t)) return C.trap;
    if (/swarm|bee|hive/i.test(t)) return C.swarm;
    return 1;
}
// nose 1, 45 degrees about 0.58, side or rear C.side
function wAngle(a) { const d = Math.abs((((a % 360) + 540) % 360) - 180); const c = Math.max(0, Math.cos((180 - d) * Math.PI / 180)); return C.side + (1 - C.side) * c * c; }
const reachOf = s => Math.min(1.35, Math.max(0.75, Math.pow(Math.max(1e-6, s.speed * s.range) / 3.6, C.reachExp)));
function gunOffense(f, aimW) {
    let O = 0;
    const shared = f.guns.filter(gn => gn.typed && !gn.max && isStock(gn.type)).length;
    for (const gn of f.guns) {
        if (!gn.typed) continue;
        const s = gn.ss, per = s.damage * Math.pow(Math.max(0.01, s.health), C.hExp) * Math.pow(Math.max(0.01, s.pen), C.pExp), k = kappa(gn.type), reach = reachOf(s);
        const stock = gn.max || (shared && isStock(gn.type) ? f.maxChildren / shared : 0);
        // children of a projectile (bees from a hive, a missile's guns)
        let sub = 0;
        if (gn.proj) for (const pg of gn.proj.f.guns) if (pg.typed && !isStock(pg.type)) {
            const ps = pg.ss; sub += (pg.sod ? 1 : gn.proj.life * s.range * (30 / ps.reload)) * ps.damage * Math.pow(Math.max(0.01, ps.health), C.hExp) * Math.pow(Math.max(0.01, ps.pen), C.pExp) * kappa(pg.type);
        }
        const one = per + sub;
        if (stock) O += stock * one * k * C.stock * reach;           // drones: a standing stock, not a rate
        else O += Math.pow(30 / s.reload, C.rateExp) * one * k * (aimW ?? wAngle(gn.a)) * reach;
    }
    return O;
}
function turretOffense(f) { let O = 0; for (const t of f.turrets) if (t.def) O += C.turret * (gunOffense(t.def, 1) + turretOffense(t.def)); return O; }
// rear guns push the tank: their recoil per second counts as mobility
function thrust(f) {
    if (f.noRecoil) return 0;
    let t = 0;
    for (const gn of f.guns) { if (!gn.typed || gn.max || isStock(gn.type)) continue; const s = gn.ss; t -= Math.cos(gn.a * Math.PI / 180) * (s.recoil || 1) * 30 / s.reload; }
    return Math.max(0, t);
}
function survival(f) { const b = f.body; return (b.HEALTH ?? 1) * Math.sqrt(b.SHIELD ?? 1) * Math.pow((b.SPEED ?? 1) * (1 + 0.08 * thrust(f)), 0.3); }
// smasher ram: body damage, calibrated so the stock Smasher sits on the tier 3 target
let RAM_K = 1;
const setRamK = k => { RAM_K = k; };
const ram = f => f.smasher ? RAM_K * (f.body.DAMAGE ?? 1) : 0;
function power(f) { const Og = gunOffense(f) + turretOffense(f), R = ram(f), O = Og + R, S = survival(f); return { O, S, P: O * S, guns: Og, ram: R }; }

module.exports = { C, setConstants, kappa, flatten, power, survival, gunOffense, turretOffense, ram, setRamK, resolve, get, body, typeName, isStock, wAngle };

// A hash of today's reachable tree (upgrade lists, labels, gun damage, body)
function treeHash() {
    const seen = new Set(['basic']), q = ['basic'], parts = [];
    while (q.length) {
        const k = q.shift(), d = Class[k];
        const ups = []; for (let t = 0; t <= 5; t++) ups.push(JSON.stringify(d['UPGRADES_TIER_' + t] || null));
        const f = flatten(k);
        parts.push(k + '|' + f.label + '|' + ups.join(';') + '|' + f.guns.map(x => x.typed ? x.ss.damage.toFixed(6) + '/' + x.ss.reload.toFixed(4) : 'x').join(',') + '|' + JSON.stringify(f.body));
        for (let t = 1; t <= 5; t++) for (const u of arr(d['UPGRADES_TIER_' + t])) if (typeof u === 'string' && !seen.has(u)) { seen.add(u); q.push(u); }
    }
    return require('crypto').createHash('sha1').update(parts.join('\n')).digest('hex');
}
module.exports.treeHash = treeHash;
