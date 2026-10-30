'use strict';

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const OUT = path.join(SERVER, 'lib', 'definitions', 'power_budget_data.js');
const REPORT = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;

for (const k of ['ROYALE_TANKS', 'ROYALE_TANKS_T5_FREE', 'ROYALE_ARMS_RACE']) delete process.env[k];
{
    const quiet = console.log, info = console.info, warn = console.warn;
    console.log = console.info = console.warn = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        Config.dig_royale = true;
        Config.power_budget = false;
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = quiet; console.info = info; console.warn = warn; }
}

const B = require('./tanks/budget.js');
const X = require(path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js'));
B.setConstants(require('./tanks/calibration.json').constants);
B.setRamK(X.constants.ram);
const C = B.C;
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const r4 = x => Math.round(x * 10000) / 10000;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

const TIER_NERF = { 1: 0.85, 2: 0.88, 3: 0.93, 4: 0.97, 5: 1 };
const FIGHT_BAND = [0.88, 1.12];
const TOUGH_BAND = [0.88, 1.12];
const RAM_TOUGH_BAND = [0.88, 1.0];
const ROCK_BAND = [0.85, 1.15];
const FIGHT_CLAMP = [0.25, 2.5];
const ROCK_CLAMP = [0.3, 6];
const SNEAKY_CREDIT = 1.15;
const REFILL_S = 6;
const REFILL_CAP = 1.25;
const RUNTIME_VS_TANKS = { trap: 0.7, minion: 0.72 * 0.82, drone: 0.82, swarm: 1.1 };

const BASIC_POWER = 0.75, BASIC_RELOAD = 10.5, SLOW_CAP = 4;
const ROCK_KIND = { trap: 0.8, drone: 0.8 * 0.45, swarm: 0.8, minion: 0.45 };
const STOCK_ROCK_HITS = 1.2;
const MINION_ROCK_SHARE = 0.5;

function typeKind(t) {
    t = t || '';
    if (/minion/i.test(t)) return 'minion';
    if (/drone|chip/i.test(t)) return 'drone';
    if (/trap|pillbox|box|boomerang|block|assemblent/i.test(t)) return 'trap';
    if (/swarm|bee|hive/i.test(t)) return 'swarm';
    return 'bullet';
}
const isHeal = t => /heal/i.test(t || '');
const reachOf = s => Math.min(1.35, Math.max(0.75, Math.pow(Math.max(1e-6, s.speed * s.range) / 3.6, C.reachExp)));
const perHit = s => s.damage * Math.pow(Math.max(0.01, s.health), C.hExp) * Math.pow(Math.max(0.01, s.pen), C.pExp);

function offense(f, aimW) {
    let O = 0, heal = false;
    const shared = f.guns.filter(gn => gn.typed && !gn.max && B.isStock(gn.type)).length;
    for (const gn of f.guns) {
        if (!gn.typed) continue;
        if (isHeal(gn.type)) { heal = true; continue; }
        const s = gn.ss, kind = typeKind(gn.type), vs = RUNTIME_VS_TANKS[kind] || 1, k = B.kappa(gn.type), reach = reachOf(s);
        let sub = 0;
        if (gn.proj) for (const pg of gn.proj.f.guns) if (pg.typed && !B.isStock(pg.type)) {
            const ps = pg.ss;
            sub += (pg.sod ? 1 : gn.proj.life * s.range * (30 / ps.reload)) * perHit(ps) * B.kappa(pg.type);
        }
        const one = perHit(s) + sub;
        const stock = gn.max || (shared && B.isStock(gn.type) ? f.maxChildren / shared : 0);
        if (stock) {
            const refill = Math.min(REFILL_CAP, Math.sqrt((30 / s.reload) * REFILL_S / stock));
            O += stock * one * k * C.stock * reach * refill * vs;
        } else O += Math.pow(30 / s.reload, C.rateExp) * one * k * (aimW ?? B.wAngle(gn.a)) * reach * vs;
    }
    for (const t of f.turrets) if (t.def) { const r = offense(t.def, 1); O += C.turret * r.O; heal = heal || r.heal; }
    return { O, heal };
}

function digPower(s) {
    if (!s || !(s.reload > 0)) return 1;
    return (s.damage * s.health) / BASIC_POWER * Math.min(SLOW_CAP, Math.max(1, s.reload / BASIC_RELOAD));
}
function rockRate(f, turretShare = 1) {
    let R = 0;
    const shared = f.guns.filter(gn => gn.typed && !gn.max && B.isStock(gn.type)).length;
    for (const gn of f.guns) {
        if (!gn.typed || isHeal(gn.type)) continue;
        const s = gn.ss, kind = typeKind(gn.type);
        const stock = gn.max || (shared && B.isStock(gn.type) ? f.maxChildren / shared : 0);
        if (kind === 'minion' && gn.proj) {
            let m = 0;
            for (const pg of gn.proj.f.guns) if (pg.typed) m += (30 / pg.ss.reload) * digPower(pg.ss) * ROCK_KIND.minion;
            R += (stock || 1) * m * MINION_ROCK_SHARE;
        } else if (stock) {
            R += stock * STOCK_ROCK_HITS * digPower(s) * (ROCK_KIND[kind] || 0.36);
        } else {
            R += (30 / s.reload) * digPower(s) * (ROCK_KIND[kind] || 1);
        }
    }
    for (const t of f.turrets) if (t.def && !t.prop) R += 0.6 * turretShare * rockRate(t.def, 1);
    return R;
}

const keyOf = new Map();
for (const k in Class) if (!keyOf.has(Class[k])) keyOf.set(Class[k], k);
const tier = new Map([['basic', 1]]), q = ['basic'];
while (q.length) {
    const k = q.shift(), d = Class[k];
    for (let t = 1; t <= 4; t++) for (let e of (d && d['UPGRADES_TIER_' + t]) || []) {
        if (Array.isArray(e)) { if (e.length !== 1) continue; e = e[0]; }
        const ck = typeof e === 'string' ? e : keyOf.get(e);
        if (!ck || !Class[ck] || tier.has(ck)) continue;
        tier.set(ck, t + 1); q.push(ck);
    }
}

const rows = [];
for (const [key, t] of tier) {
    const def = Class[key];
    let f;
    try { f = B.flatten(key); } catch (e) { f = null; }
    if (!f) { rows.push({ key, t, skip: 'unmeasurable' }); continue; }
    const off = offense(f);
    const ram = f.smasher ? B.ram(f) : 0;
    const S = B.survival(f);
    const sneaky = arr(B.get(def, 'INVISIBLE')).some(v => v > 0) ? SNEAKY_CREDIT : 1;
    rows.push({ key, label: f.label || key, t, O: off.O + ram, guns: off.O, ram, S, heal: off.heal, smasher: !!f.smasher, sneaky, rock: rockRate(f) });
}

const live = rows.filter(r => !r.skip);
const band = (v, target, [lo, hi]) => v > target * hi ? target * hi / v : v < target * lo ? target * lo / v : 1;
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

const sMed = {};
for (let t = 1; t <= 5; t++) sMed[t] = median(live.filter(r => r.t === t && !r.smasher).map(r => r.S)) || median(live.filter(r => r.t === t).map(r => r.S));
for (const r of live) {
    r.hp = band(r.S, sMed[r.t], r.smasher ? RAM_TOUGH_BAND : TOUGH_BAND);
    r.S2 = r.S * r.hp;
    r.P = r.O * r.S2 * r.sneaky;
}

const pMed = {}, target = {};
for (let t = 1; t <= 5; t++) pMed[t] = median(live.filter(r => r.t === t && !r.heal && r.O > 0).map(r => r.P));
const top = pMed[5];
for (let t = 1; t <= 5; t++) target[t] = Math.min(pMed[t] || top, top) * TIER_NERF[t];
for (const r of live) {
    if (r.heal || !(r.O > 0)) { r.s = 1; continue; }
    r.s = clamp(band(r.P, target[r.t], FIGHT_BAND), FIGHT_CLAMP);
}

const rMed = {};
for (let t = 1; t <= 5; t++) rMed[t] = median(live.filter(r => r.t === t && r.rock > 0).map(r => r.rock));
for (const r of live) {
    if (!(r.rock > 0)) { r.rockMult = 1; continue; }
    r.rockMult = clamp(band(r.rock, rMed[r.t], ROCK_BAND), ROCK_CLAMP);
}

const fight = {}, hp = {}, rock = {};
for (const r of live) {
    if (Math.abs(r.s - 1) > 1e-4) fight[r.key] = r4(r.s);
    if (Math.abs(r.hp - 1) > 1e-4) hp[r.key] = r4(r.hp);
    if (Math.abs(r.rockMult - 1) > 1e-4) rock[r.key] = r4(r.rockMult);
}
const data = { generator: 'scripts/gen-power-budget.js', tierNerf: TIER_NERF, fightBand: FIGHT_BAND, toughBand: TOUGH_BAND, rockBand: ROCK_BAND, fight, hp, rock };
fs.writeFileSync(OUT, "'use strict';\nmodule.exports = " + JSON.stringify(data, null, 0).replace(/,"/g, ',\n"') + ';\n');

const stat = (list, k) => { const v = list.map(r => r[k]).sort((a, b) => a - b); return v.length ? `min ${r4(v[0])} med ${r4(v[v.length >> 1])} max ${r4(v[v.length - 1])}` : '-'; };
console.log(`tanks ${rows.length}, measured ${live.length}, skipped ${rows.length - live.length}, healers left alone ${live.filter(r => r.heal).length}, sneaky ${live.filter(r => r.sneaky > 1).length}, smashers ${live.filter(r => r.smasher).length}`);
console.log(`fight scale ${stat(live, 's')}, changed ${Object.keys(fight).length}`);
console.log(`toughness ${stat(live, 'hp')}, changed ${Object.keys(hp).length}`);
console.log(`rock ${stat(live, 'rockMult')}, changed ${Object.keys(rock).length}`);
const show = keys => keys.map(k => { const r = live.find(x => x.key === k || x.label === k); return r ? `${r.label}(T${r.t}) fight x${r4(r.s)} hp x${r4(r.hp)} rock x${r4(r.rockMult)}` : k + ' ?'; }).join('\n  ');
console.log('samples:\n  ' + show(['basic', 'director', 'overseer', 'overlord', 'octoTank', 'cyclone', 'factory', 'spawner', 'smasher', 'landmine', 'spike', 'annihilator', 'predator', 'Papaya', 'Mechanic', 'stalker', 'manager']));
if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(live.map(r => ({ key: r.key, label: r.label, t: r.t, s: r4(r.s), hp: r4(r.hp), rock: r4(r.rockMult), P: r4(r.P), S: r4(r.S), smasher: r.smasher, heal: r.heal, sneaky: r.sneaky })), null, 1));
console.log('wrote', path.relative(REPO, OUT));
