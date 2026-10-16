// Builds the expanded tank tree (server/lib/definitions/tanks_expansion_data.js)
'use strict';

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const OUT = path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js');
const argv = process.argv.slice(2);
const REPORT = argv.includes('--report') ? argv[argv.indexOf('--report') + 1] : (process.env.TANKS_REPORT || path.join(require('os').tmpdir(), 'tanks500'));

process.env.ROYALE_TANKS = 'classic';   // today's tree (the expanded one is the default)
delete process.env.ROYALE_TANKS_T5_FREE;
{
    const log = console.log; console.log = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = log; }
}
const B = require('./tanks/budget.js');
const NAMES = require('./tanks/names.js');
const N = require('./tanks/neat.js');
const F = require(path.join(SERVER, 'lib', 'definitions', 'facilitators.js'));
const g = require(path.join(SERVER, 'lib', 'definitions', 'gunvals.js'));
const cs = F.combineStats;
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const clone = x => JSON.parse(JSON.stringify(x));
const r3 = x => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------- seeded rng
let seed = 20261006;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------------------------------------------------------------- old tree
const BRANCHES = ['twin', 'sniper', 'machineGun', 'flankGuard', 'director', 'pounder', 'trapper', 'smasher', 'splitter'];
const BRANCH_NAME = { twin: 'Twin', sniper: 'Sniper', machineGun: 'Machine Gun', flankGuard: 'Flank Guard', director: 'Director', pounder: 'Pounder', trapper: 'Trapper', smasher: 'Smasher', splitter: 'Splitter', basic: 'Basic' };
function walk(root, skip = new Set()) {
    const tier = { [root]: 1 }, parents = { [root]: [] }, q = [root];
    while (q.length) {
        const k = q.shift();
        for (let t = 1; t <= 4; t++) for (const u of arr(Class[k]['UPGRADES_TIER_' + t])) {
            if (typeof u !== 'string' || skip.has(u)) continue;
            if (!(u in tier)) { tier[u] = t + 1; parents[u] = []; q.push(u); }
            if (!parents[u].includes(k)) parents[u].push(k);
        }
    }
    return { tier, parents };
}
const OLD = walk('basic');
const oldKeys = Object.keys(OLD.tier);
// Desmos leaves the tree
const EXP = walk('basic', new Set(['desmos']));
const lost = oldKeys.filter(k => k !== 'desmos' && !(k in EXP.tier));
if (lost.length) throw Error('removing desmos orphans ' + lost.join(','));
const branchSets = {};
for (const b of BRANCHES) if (Class[b]) { const w = walk(b); branchSets[b] = new Set(Object.keys(w.tier)); }
const primaryBranch = k => k === 'basic' ? 'basic' : BRANCHES.find(b => branchSets[b] && branchSets[b].has(k));
const branchesOf = k => BRANCHES.filter(b => branchSets[b] && branchSets[b].has(k));

// ---------------------------------------------------------------- budget constants
const flatOld = {}; for (const k of oldKeys) flatOld[k] = B.flatten(k);
const CAL = require('./tanks/calibration.json');
B.setConstants(CAL.constants);
const median = a => { a = [...a].sort((x, y) => x - y); return a[a.length >> 1]; };
const TARGET = {}, SREF = {};
TARGET[1] = B.power(flatOld.basic).P; SREF[1] = B.power(flatOld.basic).S;
for (const t of [2, 3, 4]) {
    const ks = oldKeys.filter(k => OLD.tier[k] === t && !flatOld[k].smasher);
    TARGET[t] = median(ks.map(k => B.power(flatOld[k]).P));
    SREF[t] = median(ks.map(k => B.power(flatOld[k]).S));
}
TARGET[5] = TARGET[4] * 1.15; SREF[5] = SREF[4];
// ram: the stock Smasher lands exactly on the tier 3 target
{ const f = flatOld.smasher, p0 = (B.setRamK(0), B.power(f)); B.setRamK((TARGET[3] / p0.S - p0.guns) / (f.body.DAMAGE || 1)); }
const CONSTANTS = { ...B.C, ram: B.ram({ smasher: true, body: { DAMAGE: 1 } }) };
// the shells today's tanks wear on their own (helix fins, triplex spines): allowed as they are
const DECOS = new Set(); for (const k of oldKeys) for (const x of flatOld[k].guns) if (!x.typed) DECOS.add(N.decoSig(x));
// every barrel fires something real: a known projectile, drones with somewhere to count them
const deadOf = f => N.deadGuns(f, { decos: DECOS, valid: x => typeof x.type === 'string' && !!Class[x.type] && (!B.isStock(x.type) || x.max > 0 || f.maxChildren > 0) });
// published names and keys: a design that did not change keeps both (scripts/tanks/legacy.json)
const crypto = require('crypto');
const rawHash = w => crypto.createHash('sha1').update(JSON.stringify([w.parent, w.guns, w.turrets, w.shape || 0, w.maxChildren || 0])).digest('hex').slice(0, 12);
// size, offset, first angle. A ring sits near the rim (0.6 of the radius) with compact turrets so
// the centre of the body (where a skin's emblem sits) stays visible; a single auto is centred, small.
const MOUNT = { 1: [8, 0, 0], 2: [7, 6.2, 90], 3: [6.5, 6.2, 180], 4: [6, 6.3, 45], 5: [5.5, 6.5, 0], 6: [5, 6.6, 0] };
const MOUNT_OLD = { 1: [10, 0], 2: [8, 5], 3: [7, 5.5], 4: [6.5, 6], 5: [6, 6.5], 6: [5.5, 6.8] };   // the first published rings
// the barrel look pass (scripts/tanks/neat.js grammar): a barrel's shape tells you what it throws.
// Bullet spray guns get the Machine Gun flare, swarm launchers the Cruiser's; WIDTH (projectile
// size, so balance) never changes. A design that differs only in its look keeps its key and name.
const tName = t => typeof t === 'string' ? t : Array.isArray(t) ? tName(t[0]) : null;
function lookBase(w) {
    if (!w || !w.guns) return w;
    const R = N.hullR(w.shape), guns = w.guns;
    const out = guns.map(gn => {
        const P = gn.POSITION, tn = gn.PROPERTIES && gn.PROPERTIES.SHOOT_SETTINGS ? tName(gn.PROPERTIES.TYPE) : null;
        if (tn === 'bullet') {
            const pair = guns.some(o => o !== gn && o.PROPERTIES && o.PROPERTIES.SHOOT_SETTINGS && Math.abs(N.na(o.POSITION.ANGLE - P.ANGLE)) < 1 && Math.abs(o.POSITION.Y + P.Y) < 0.3);
            const Q = N.sprayLook(P, R, pair); return Q === P ? gn : { ...gn, POSITION: Q };
        }
        if (tn === 'swarm' && P.ASPECT < 1) {   // Cruiser: LENGTH 9 from X 5 (reach 14)
            const reach = P.X + P.LENGTH, X = r3(5 * reach / 14);
            return Math.abs(X - P.X) < 1e-6 ? gn : { ...gn, POSITION: { ...P, X, LENGTH: r3(reach - X) } };
        }
        return gn;
    });
    // body rings from the first published layout move to the rim (MOUNT)
    let tur = w.turrets;
    if (tur && tur.length) for (const m in MOUNT_OLD) {
        const [S0, o0] = MOUNT_OLD[m], hit = tur.filter(t => t.POSITION.LAYER === 1 && Math.abs(t.POSITION.SIZE - S0) < 1e-6 && Math.abs(Math.hypot(t.POSITION.X, t.POSITION.Y) - o0) < 1e-3);
        if (hit.length !== +m) continue;
        tur = tur.map(t => { if (!hit.includes(t)) return t; const P = t.POSITION, k = o0 ? MOUNT[m][1] / o0 : 0; return { ...t, POSITION: { ...P, SIZE: MOUNT[m][0], X: r3(P.X * k), Y: r3(P.Y * k) } }; });
    }
    if (out.every((gn, i) => gn === guns[i]) && tur === w.turrets) return w;
    return { ...w, guns: out, turrets: tur };
}
const look = w => (!w || !w.guns) ? w : turnLook(lookBase(w));
// Oct 7 2026 (owner): the layout turns to face the fight; a turn is a look too (key and name kept)
//  - a drone tank whose spawners sit only nose and tail (Sultan: Big Cheese doubled) reads as a
//    Gatepost: it turns 90 degrees, spawners on the sides like Overseer's, the rest turning with them
//  - a tank on a spinning body (Auto-3, Mega-3, Architect) that gets fixed barrels faces the cursor
//    (defOf), so its ring turns until a barrel sits on the nose
const ssOf = gn => gn.PROPERTIES && gn.PROPERTIES.SHOOT_SETTINGS && gn.PROPERTIES.TYPE != null;
const spins = k => !!(k && Class[k]) && /spin/i.test(JSON.stringify(B.get(Class[k], 'FACING_TYPE')) || '');
// the published tank a generated line starts from (a generated parent is not in Class yet while
// the legacy names are hashed: the published tree's own parent links answer then)
const LEGPARENT = {}, BUILT = {};    // BUILT: byKey once the tree is being built
const rootOf = k => { for (let n = 0; n < 12 && /^xp_/.test(k || ''); n++) k = (BUILT.byKey && BUILT.byKey[k] && BUILT.byKey[k].w && BUILT.byKey[k].w.parent) || LEGPARENT[k]; return k; };
const aimable = w => w.guns.some(gn => ssOf(gn) && !gn.PROPERTIES.AUTOFIRE);
function turnBy(w, rot) {
    if (!rot) return w;
    return { ...w, guns: w.guns.map(gn => ({ ...gn, POSITION: { ...gn.POSITION, ANGLE: r3(N.na(gn.POSITION.ANGLE + rot)) } })),
        turrets: (w.turrets || []).map(t => ({ ...t, POSITION: { ...t.POSITION, ANGLE: r3(N.na(t.POSITION.ANGLE + rot)) } })) };
}
function turnLook(w) {
    const typedG = w.guns.filter(ssOf);
    if (!typedG.length) return w;
    const angs = new Set(typedG.map(gn => Math.round(Math.abs(N.na(gn.POSITION.ANGLE)))));
    if (typedG.every(gn => B.isStock(tName(gn.PROPERTIES.TYPE))) && angs.size === 2 && angs.has(0) && angs.has(180)) return turnBy(w, 90);
    if (spins(rootOf(w.parent)) && aimable(w)) {
        const fixed = typedG.filter(gn => !gn.PROPERTIES.AUTOFIRE).map(gn => N.na(gn.POSITION.ANGLE));
        if (!fixed.some(a => Math.abs(a) <= 20)) { const a = fixed.reduce((m, x) => Math.abs(x) < Math.abs(m) - 1e-6 || (Math.abs(Math.abs(x) - Math.abs(m)) < 1e-6 && x > m) ? x : m); return turnBy(w, -a); }
    }
    return w;
}
const designHash = w => rawHash(look(w));
const LEG = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(__dirname, 'tanks', 'legacy.json.gz'))));
for (const t of LEG.tanks) LEGPARENT[t.key] = t.w.parent;
const LEGACY = {}, RAW = {}; for (const t of LEG.tanks) { const h = designHash(t.w); LEGACY[h] = [t.key, t.label]; RAW[h] = rawHash(t.w); }
const sanityHash = w => { const h = designHash(w); return RAW[h] || rawHash(w); };
const legacyKeys = new Set(Object.values(LEGACY).map(v => v[0]));
// duel sanity (scripts/tanks/sanity.js check): a damage factor per design, inside its band
const SANITY = fs.existsSync(path.join(__dirname, 'tanks', 'duelSanity.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'tanks', 'duelSanity.json'), 'utf8')) : { k: {}, drop: [] };
// aimed damage floor (scripts/tanks/dpsFloor.js): a damage factor per design, keyed by its def
const DPSF = fs.existsSync(path.join(__dirname, 'tanks', 'dpsFloor.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'tanks', 'dpsFloor.json'), 'utf8')).f : {};

// the factor that puts a tank on a power target: hp clamps toughness into its tier band
const TOL = 0.25;
function balanceOf(f, tier, target = TARGET[tier]) {
    const p = B.power(f);
    let hp = 1; const sr = p.S / SREF[tier];
    if (sr > 1.22) hp = 1.22 / sr; else if (sr < 0.82) hp = 0.82 / sr;
    const s = target / (p.O * p.S * hp);
    return { O: p.O, S: p.S, P: p.P, T: target, hp: r3(hp) === 1 ? 1 : +hp.toFixed(4), s: +s.toFixed(4) };
}
// Owner decision: today's 126 tanks keep their stats exactly
const STEP = { 2: 1.06, 3: 1.08, 4: 1.10, 5: 1.12 };

// ---------------------------------------------------------------- working form
const GK = ['LENGTH', 'WIDTH', 'ASPECT', 'X', 'Y', 'ANGLE', 'DELAY'], GD = [18, 8, 1, 0, 0, 0, 0];
const TK = ['SIZE', 'X', 'Y', 'ANGLE', 'ARC', 'LAYER'], TD = [10, 0, 0, 0, 360, 0];
function hasFn(x, seen = new Set()) { if (typeof x === 'function') return true; if (!x || typeof x !== 'object' || seen.has(x)) return false; seen.add(x); for (const k in x) if (hasFn(x[k], seen)) return true; return false; }
function normGun(gn) {
    const P = gn.POSITION, o = {};
    GK.forEach((k, i) => { o[k] = (Array.isArray(P) ? P[i] : P && P[k]) ?? GD[i]; });
    const out = { POSITION: o };
    if (gn.PROPERTIES) out.PROPERTIES = clone(gn.PROPERTIES);
    return out;
}
function normTur(t) { const P = t.POSITION, o = {}; TK.forEach((k, i) => { o[k] = (Array.isArray(P) ? P[i] : P && P[k]) ?? TD[i]; }); return { POSITION: o, TYPE: clone(t.TYPE) }; }
function W(key) {
    const d = Class[key];
    if (hasFn(B.get(d, 'GUNS')) || hasFn(B.get(d, 'TURRETS'))) return null;
    return { parent: key, guns: arr(B.get(d, 'GUNS')).map(normGun), turrets: arr(B.get(d, 'TURRETS')).map(normTur), shape: B.get(d, 'SHAPE') ?? 0,
        maxChildren: B.get(d, 'MAX_CHILDREN') || 0, smasher: !!B.get(d, 'IS_SMASHER') };
}
const cloneW = w => ({ ...w, guns: clone(w.guns), turrets: clone(w.turrets) });
const na = a => { a = ((a % 360) + 360) % 360; return a > 180 ? a - 360 : a; };
const typed = gn => !!(gn.PROPERTIES && gn.PROPERTIES.TYPE && gn.PROPERTIES.SHOOT_SETTINGS);
const kindOf = gn => { if (!typed(gn)) return 'deco'; const t = B.typeName(gn.PROPERTIES.TYPE) || ''; return B.isStock(t) ? 'drone' : /trap|pillbox|box|boomerang|block/i.test(t) ? 'trap' : /swarm|bee|hive/i.test(t) ? 'swarm' : 'bullet'; };
const isHat = t => { const d = B.resolve(t.TYPE); return !d || !arr(B.get(d, 'GUNS')).some(x => x.PROPERTIES && x.PROPERTIES.SHOOT_SETTINGS); };
// guns that share an angle and Y offset belong together (trap base + cap, stacks)
function units(guns) {
    const m = new Map();
    for (const gn of guns) { const k = Math.round(na(gn.POSITION.ANGLE) * 2) + ':' + Math.round(gn.POSITION.Y * 2); if (!m.has(k)) m.set(k, []); m.get(k).push(gn); }
    return [...m.values()].map(gs => ({ a: na(gs[0].POSITION.ANGLE), y: gs[0].POSITION.Y, guns: gs, typed: gs.some(typed), kind: (gs.find(typed) && kindOf(gs.find(typed))) || 'deco' }));
}
const core = w => units(w.guns).filter(u => Math.abs(u.a) <= 20 && u.typed);   // 20: a fork (Tusker 16) counts as the nose
const front = w => w.guns.filter(gn => Math.abs(na(gn.POSITION.ANGLE)) <= 45);
// a turret sits at its X/Y offset turned by its ANGLE (turretEntity.js)
const tAt = P => { const d = Math.atan2(P.Y, P.X) + P.ANGLE * Math.PI / 180, o = Math.hypot(P.X, P.Y); return [o * Math.cos(d), o * Math.sin(d), na(d * 180 / Math.PI), o]; };
const free = (w, a, tol) => !w.guns.some(gn => Math.abs(na(gn.POSITION.ANGLE - a)) < tol) && !w.turrets.some(t => { const q = tAt(t.POSITION); return !isHat(t) && q[3] > 4 && Math.abs(na(q[2] - a)) < tol; });
const dirs = w => new Set(w.guns.filter(typed).map(gn => Math.round(((na(gn.POSITION.ANGLE) + 360) % 360) / 30) % 12)).size;
const hullR = shape => { const n = Math.abs(shape || 0); return 10 * (n >= 3 ? Math.sqrt((2 * Math.PI / n) / Math.sin(2 * Math.PI / n)) : 1); };
// copy guns rotated by `rot`, lengths scaled by `k` (tip kept out of the hull)
function moved(guns, rot, k = 1, dDelay = 0, mirror = false) {
    return guns.map(gn => {
        const c = clone(gn), P = c.POSITION;
        if (mirror) { P.Y = -P.Y; P.ANGLE = -P.ANGLE; }
        let kk = k; const tip = P.X + P.LENGTH; if (tip * kk < 13) kk = Math.min(1, 13 / Math.max(1, tip));
        P.LENGTH = r3(P.LENGTH * kk); P.X = r3(P.X * kk); P.ANGLE = r3(na(P.ANGLE + rot)); P.DELAY = r3(((P.DELAY || 0) + dDelay) % 1);
        return c;
    });
}
// ---------------------------------------------------------------- gun builders
const pos = (L, Wd, o = {}) => ({ LENGTH: L, WIDTH: Wd, ASPECT: o.asp ?? 1, X: o.x ?? 0, Y: o.y ?? 0, ANGLE: o.a ?? 0, DELAY: o.d ?? 0 });
const gun = (L, Wd, o, stats, type = 'bullet', extra = {}) => ({ POSITION: pos(L, Wd, o), PROPERTIES: { SHOOT_SETTINGS: cs(stats), TYPE: type, ...extra } });
const deco = (L, Wd, o) => ({ POSITION: pos(L, Wd, o) });
const trapGun = (L, Wd, o = {}, stats = []) => [deco(L, Wd, o), { POSITION: pos(3.5, Wd, { ...o, asp: 1.7, x: (o.x || 0) + L }), PROPERTIES: { SHOOT_SETTINGS: cs([g.trap, ...stats]), TYPE: 'trap', STAT_CALCULATOR: 'trap' } }];
const spawner = (o = {}, stats = [], max = 3) => ({ POSITION: pos(6, 11, { asp: 1.2, x: 8, ...o }), PROPERTIES: { SHOOT_SETTINGS: cs([g.drone, g.overseer, ...stats]), TYPE: 'drone', AUTOFIRE: true, SYNCS_SKILLS: true, STAT_CALCULATOR: 'drone', WAIT_TO_CYCLE: true, MAX_CHILDREN: max } });
const thrusters = () => [gun(16, 8, { a: 153, d: 0.1 }, [g.basic, g.flankGuard, g.triAngle, g.thruster]), gun(16, 8, { a: -153, d: 0.1 }, [g.basic, g.flankGuard, g.triAngle, g.thruster]), gun(18, 8, { a: 180, d: 0.6 }, [g.basic, g.flankGuard, g.triAngle, g.thruster])];
// the standard auto turret (grey base, short barrel), always sitting on the body
const autoT = (size, x, a, arc = 360) => ({ POSITION: { SIZE: size, X: x, Y: 0, ANGLE: a, ARC: arc, LAYER: 1 }, TYPE: ['autoTurret', { CONTROLLERS: ['nearestDifferentMaster'], INDEPENDENT: true, COLOR: 'grey' }] });
const mountRing = (n, type = null) => { const [S, o, a0] = MOUNT[n]; return Array.from({ length: n }, (_, k) => { const t = normTur(autoT(S, o, na(a0 + 360 * k / n))); if (type) t.TYPE[0] = type; return t; }); };
const hat = (name, size, a = 0) => ({ POSITION: { SIZE: size, X: 0, Y: 0, ANGLE: a, ARC: 360, LAYER: 0 }, TYPE: [name, { COLOR: 'black' }] });


// ---------------------------------------------------------------- definitions
function defOf(w, label) {
    const par = Class[w.parent] || Class.genericTank;
    const d = { PARENT: w.parent, LABEL: label, DANGER: (B.get(par, 'DANGER') || 6) + 1, SHAPE: w.shape || 0, GUNS: w.guns, TURRETS: w.turrets, PROPS: [] };
    if (w.maxChildren) d.MAX_CHILDREN = w.maxChildren;
    if (w.statNames) d.STAT_NAMES = w.statNames;
    if (w.invisible) d.INVISIBLE = w.invisible;
    // a spinning body (Auto-3, Mega-3, Architect) with barrels you fire faces the cursor (turnLook)
    if (aimable(w) && /spin/i.test(JSON.stringify(B.get(par, 'FACING_TYPE')) || '')) d.FACING_TYPE = 'toTarget';
    return d;
}
const flatW = w => B.flatten(defOf(w, 'probe'));

// ---------------------------------------------------------------- filters
const rad = Math.PI / 180;
function inBarrel(px, py, x) {
    const c = Math.cos(x.a * rad), s = Math.sin(x.a * rad), u = px * c + py * s - x.X, v = -px * s + py * c - x.Y;
    if (u < 0 || u > x.L) return false;
    const hw = x.W / 2, hb = x.asp > 0 ? hw : -hw * x.asp, hm = x.asp > 0 ? hw * x.asp : hw;
    return Math.abs(v) <= hb + (hm - hb) * u / x.L;
}
function barrelPts(x, R) {
    const c = Math.cos(x.a * rad), s = Math.sin(x.a * rad), out = [];
    const hw = x.W / 2, hb = x.asp > 0 ? hw : -hw * x.asp, hm = x.asp > 0 ? hw * x.asp : hw;
    for (const fu of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fv of [-0.7, -0.35, 0, 0.35, 0.7]) {
        const u = x.L * fu, v = fv * (hb + (hm - hb) * fu), gx = x.X + u, gy = x.Y + v, px = gx * c - gy * s, py = gx * s + gy * c;
        if (Math.hypot(px, py) > R) out.push([px, py]);
    }
    return out;
}
const tCenter = t => { const d = Math.atan2(t.Y, t.X) + t.a * rad, o = Math.hypot(t.X, t.Y); return [o * Math.cos(d), o * Math.sin(d), o]; };
const armed = t => t.def && (t.def.guns.some(x => x.typed) || t.def.turrets.some(armed));
function ugly(f, base = null) {
    const all = uglySet(f, base);
    return all.size ? [...all][0] : null;
}
function uglySet(f, base = null) {
    const out = new Set(), add = r => { out.add(r); };
    const tg = f.guns.filter(x => x.typed), live = f.turrets.filter(t => !t.prop && armed(t));
    if (!tg.length && !live.length && !f.smasher) add('blank');
    if (tg.length > Math.max(12, base ? base.tg : 0) || f.guns.length > Math.max(20, base ? base.guns : 0)) add('count');
    if (live.length > Math.max(6, base ? base.live : 0)) add('turrets');
    let stock = 0; for (const x of tg) if (B.isStock(x.type)) stock += x.max || 0;
    if (Math.max(stock, f.maxChildren) > Math.max(12, base ? base.stock : 0)) add('drones');
    const R = hullR(f.shape);
    for (const x of f.guns) if (Math.hypot(x.X + x.L, x.Y) > 32) add('reach');
    const angs = tg.map(x => ((x.a % 360) + 360) % 360).sort((a, b) => a - b);
    for (let i = 0; i + 3 < angs.length; i++) if (angs[i + 3] - angs[i] < 10 && new Set(angs.slice(i, i + 4).map(Math.round)).size > 1) add('crowded');
    for (const x of tg) if (Math.hypot(x.X + x.L, x.Y) < R * 1.1) add('hidden');
    // overlaps and turret placement: neatFail (scripts/tanks/neat.js)
    return out;
}
// what a parent already has does not count against its children
function stats(f) {
    const tg = f.guns.filter(x => x.typed); let stock = 0; for (const x of tg) if (B.isStock(x.type)) stock += x.max || 0;
    return { tg: tg.length, guns: f.guns.length, live: f.turrets.filter(t => !t.prop && armed(t)).length, stock: Math.max(stock, f.maxChildren) };
}
// layout fingerprint: kind, angle (15 deg), length/3, width/2, offset/4
const kindShort = t => B.isStock(t) ? 'd' : /trap|pillbox|box|boomerang|block/i.test(t || '') ? 't' : /swarm|bee|hive/i.test(t || '') ? 's' : 'b';
function fingerprint(f) {
    const toks = [];
    for (const x of f.guns) toks.push([x.typed ? kindShort(x.type) : 'x', Math.round((((x.a % 360) + 360) % 360) / 15) % 24, Math.round(x.L / 3), Math.round(x.W / 2), Math.round(x.Y / 4)].join(':'));
    for (const t of f.turrets) { const [cx, cy, o] = tCenter(t); toks.push(['T', Math.round(t.S / 2), Math.round(((Math.atan2(cy, cx) / rad + 360) % 360) / 30) % 12, Math.round(o / 3), armed(t) ? 'g' + t.def.guns.length + 'w' + Math.round(Math.max(0, ...t.def.guns.map(x => x.W)) / 3) : 'h' + t.def.shape].join(':')); }
    toks.push('#' + (f.shape || 0));
    const n = {}; return toks.map(t => t + '~' + (n[t] = (n[t] || 0) + 1));
}
const jacc = (a, b) => { const S = new Set(b); let n = 0; for (const x of a) if (S.has(x)) n++; return n / (a.length + b.length - n); };
const contains = (big, small) => { const S = new Set(big); return small.filter(x => S.has(x)).length / small.length; };

// ---------------------------------------------------------------- rules
const coreGuns = w => core(w).flatMap(u => u.guns);
const realTurrets = w => w.turrets.filter(t => !isHat(t));
const RULES = {
    ring2: w => ringOf(w, 2), ring3: w => ringOf(w, 3), ring4: w => ringOf(w, 4),
    rear: w => { const c = coreGuns(w); if (!free(w, 180, 50)) return null; return { ...w, guns: [...w.guns, ...(c.length ? moved(c, 180, 0.85, 0.5) : [normGun(gun(16, 8, { a: 180, d: 0.5 }, [g.basic, g.flankGuard]))])] }; },
    // a plain barrel on an empty nose (turret and drone tanks)
    nose: w => free(w, 0, 35) ? { ...w, guns: [...w.guns, normGun(gun(18, 8, {}, [g.basic, g.flankGuard]))] } : null,
    sides90: w => sidesOf(w, 90), sides120: w => sidesOf(w, 120), sides150: w => sidesOf(w, 150),
    fan: w => {
        const us = units(w.guns).filter(u => Math.abs(u.a) <= 45);
        if (!us.length || us.some(u => Math.abs(u.a) > 2)) return null;
        const th = pick([25, 30, 40]); if (!free(w, th, 15) || !free(w, -th, 15)) return null;
        const c = us.filter(u => u.typed).flatMap(u => u.guns);
        return { ...w, guns: [...moved(c, th, 0.88, 0.5), ...moved(c, -th, 0.88, 0.5, true), ...w.guns] };
    },
    stack: w => {
        const c = core(w).filter(u => u.guns.length === 1 && u.kind === 'bullet');
        if (!c.length || c.length > 2 || core(w).length !== c.length) return null;
        const guns = [];
        for (const gn of w.guns) {
            guns.push(gn);
            if (c.some(u => u.guns[0] === gn)) { const s = clone(gn), P = s.POSITION; P.LENGTH = r3(P.LENGTH * 0.78); P.WIDTH = r3(P.WIDTH * 1.3); P.DELAY = r3(((P.DELAY || 0) + 0.5) % 1); guns.push(s); }
        }
        return { ...w, guns };
    },
    guard: w => free(w, 180, 40) ? { ...w, guns: [...w.guns, ...trapGun(13, 8, { a: 180 })] } : null,
    bird: w => free(w, 180, 35) && free(w, 153, 22) && free(w, -153, 22) ? { ...w, guns: [...w.guns, ...thrusters()] } : null,
    rearGunner: w => free(w, 180, 40) ? { ...w, guns: F.makeGunner({ GUNS: w.guns, LABEL: '' }, -1, { rear: true }).GUNS.map(normGun) } : null,
    auto: w => realTurrets(w).length ? null : { ...w, turrets: [...w.turrets, ...mountRing(1)] },
    radial2: w => radialOf(w, 2), radial3: w => radialOf(w, 3), radial4: w => radialOf(w, 4),
    over: w => {
        if (!free(w, 125, 30) || !free(w, -125, 30)) return null;
        return { ...w, guns: F.makeOver({ GUNS: w.guns, LABEL: '' }, -1, { maxDrones: 3 }).GUNS.map(normGun) };
    },
    trapSwap: w => swapOf(w, 'trap'), droneSwap: w => swapOf(w, 'drone'),
    thin: w => {
        const us = units(w.guns).filter(u => u.typed).sort((a, b) => ((a.a + 360) % 360) - ((b.a + 360) % 360));
        if (us.length < 6 || realTurrets(w).length) return null;
        const keep = us.filter((u, i) => i % 2 === 0), gone = us.filter((u, i) => i % 2 === 1).slice(0, 4);
        const keepGuns = new Set(keep.flatMap(u => u.guns)), decoKeep = w.guns.filter(gn => !typed(gn) && keep.some(u => Math.abs(na(gn.POSITION.ANGLE - u.a)) < 1));
        const n = gone.length; if (!MOUNT[n] || n < 2) return null;
        return { ...w, guns: w.guns.filter(gn => keepGuns.has(gn) || decoKeep.includes(gn)), turrets: [...w.turrets, ...mountRing(n)] };
    },
    cross: (w, ctx) => {
        const p = ctx.partner; if (!p) return null;
        const pw = W(p); if (!pw) return null;
        const back = pw.guns.filter(gn => Math.abs(na(gn.POSITION.ANGLE)) > 60);
        if (!back.some(typed) || w.guns.some(gn => Math.abs(na(gn.POSITION.ANGLE)) > 60)) return null;
        const tur = realTurrets(w).length ? w.turrets : [...w.turrets, ...realTurrets(pw)];
        return { ...w, guns: [...front(w), ...back], turrets: tur, maxChildren: Math.max(w.maxChildren || 0, pw.maxChildren || 0), partner: p };
    },
    // every other mirror pair of barrels turns heavy (wider, a little shorter)
    alt: w => {
        const us = units(w.guns).filter(u => u.typed && u.kind === 'bullet');
        if (us.length < 2 || new Set(us.flatMap(u => u.guns.filter(typed).map(gn => Math.round(gn.POSITION.WIDTH * 2)))).size > 1) return null;
        const cls = [...new Set(us.map(u => Math.round(Math.abs(u.a)) + ':' + Math.round(Math.abs(u.y) * 2)))].sort((a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b));
        if (cls.length < 2) return null;
        const heavyCls = new Set(cls.filter((c, i) => i % 2 === 1));
        const heavy = new Set(us.filter(u => heavyCls.has(Math.round(Math.abs(u.a)) + ':' + Math.round(Math.abs(u.y) * 2))).flatMap(u => u.guns));
        return { ...w, guns: w.guns.map(gn => { if (!heavy.has(gn)) return gn; const c = clone(gn); c.POSITION.WIDTH = r3(c.POSITION.WIDTH * 1.55); c.POSITION.LENGTH = r3(c.POSITION.LENGTH * 0.9); return c; }) };
    },
    // long barrels with sniper ballistics (faster, steadier, slower to reload)
    longshot: w => {
        const bs = w.guns.filter(gn => typed(gn) && kindOf(gn) === 'bullet');
        if (!bs.length || bs.some(gn => gn.POSITION.LENGTH > 23)) return null;
        return { ...w, guns: w.guns.map(gn => { if (!bs.includes(gn)) return gn; const c = clone(gn); c.POSITION.LENGTH = r3(c.POSITION.LENGTH * 1.3); c.PROPERTIES.SHOOT_SETTINGS = cs([c.PROPERTIES.SHOOT_SETTINGS, g.sniper]); return c; }) };
    },
    // every bullet barrel turns heavy (pounder shells)
    heavy: w => {
        const bs = w.guns.filter(gn => typed(gn) && kindOf(gn) === 'bullet');
        if (!bs.length || bs.some(gn => gn.POSITION.WIDTH > 10)) return null;
        return { ...w, guns: w.guns.map(gn => { if (!bs.includes(gn)) return gn; const c = clone(gn); c.POSITION.WIDTH = r3(c.POSITION.WIDTH * 1.5); c.POSITION.LENGTH = r3(c.POSITION.LENGTH * 1.05); c.PROPERTIES.SHOOT_SETTINGS = cs([c.PROPERTIES.SHOOT_SETTINGS, g.pounder]); return c; }) };
    },
    // each single bullet barrel splits into a side-by-side pair (Twin's)
    twinify: w => {
        const us = units(w.guns).filter(u => u.typed && u.kind === 'bullet' && Math.abs(u.y) < 0.5 && u.guns.length === 1);
        if (!us.length || us.length > 4) return null;
        const drop = new Set(us.flatMap(u => u.guns)), add = [];
        for (const u of us) { const gn = u.guns[0], Wd = gn.POSITION.WIDTH * 0.8, off = Wd * 0.68;
            for (const [y, d] of [[off, 0], [-off, 0.5]]) { const c = clone(gn); c.POSITION.WIDTH = r3(Wd); c.POSITION.Y = r3(y); c.POSITION.DELAY = r3(((c.POSITION.DELAY || 0) + d) % 1); c.PROPERTIES.SHOOT_SETTINGS = cs([c.PROPERTIES.SHOOT_SETTINGS, g.twin]); add.push(c); } }
        return { ...w, guns: [...w.guns.filter(gn => !drop.has(gn)), ...add] };
    },
    // the side barrels or spawners (60 to 120 degrees) become trap launchers
    sideTraps: w => {
        const us = units(w.guns).filter(u => u.typed && (u.kind === 'bullet' || u.kind === 'drone') && Math.abs(u.a) >= 60 && Math.abs(u.a) <= 120);
        if (!us.length || us.length > 4) return null;
        const drop = new Set(us.flatMap(u => u.guns));
        const add = us.flatMap(u => trapGun(13, Math.min(9, Math.max(7, u.guns[0].POSITION.WIDTH * 0.8)), { a: u.a, y: u.y }));
        return { ...w, guns: [...w.guns.filter(gn => !drop.has(gn)), ...add.map(normGun)] };
    },
    // trap launchers turn into plain barrels (a fortress turned gunship)
    trapToGun: w => {
        const us = units(w.guns).filter(u => u.typed && u.kind === 'trap');
        if (us.length < 2 || us.length > 8) return null;
        const drop = new Set(us.flatMap(u => u.guns)), add = us.map(u => normGun(gun(18, 8, { a: u.a, y: u.y }, [g.basic, g.flankGuard])));
        return { ...w, guns: [...w.guns.filter(gn => !drop.has(gn)), ...add] };
    },
    // rim turrets move onto the body, and fixed barrels
    remount: w => remountOf(w, 'at'), remountGaps: w => remountOf(w, 'gaps'), remountTraps: w => remountOf(w, 'traps'), remountOne: w => remountOf(w, 'one'),
    // a pair of swarm launchers on the nose (Cruiser's)
    swarmPair: w => {
        if (w.guns.some(gn => Math.abs(na(gn.POSITION.ANGLE)) < 25)) return null;
        const sw = y => gun(7, 7.5, { asp: 0.6, x: 7, y }, [g.swarm], 'swarm', { STAT_CALCULATOR: 'swarm' });
        return { ...w, guns: [...w.guns, normGun(sw(4)), normGun(sw(-4))] };
    },
    // every launcher of the main kind (drones, traps, swarms) turns heavy: wider, a little longer
    heavyAll: w => {
        const us = units(w.guns).filter(u => u.typed && u.kind !== 'bullet');
        if (!us.length || us.some(u => u.guns.some(gn => gn.POSITION.WIDTH > 12))) return null;
        const hv = new Set(us.flatMap(u => u.guns));
        return { ...w, guns: w.guns.map(gn => { if (!hv.has(gn)) return gn; const c = clone(gn), P = c.POSITION; P.WIDTH = r3(P.WIDTH * 1.5); P.LENGTH = r3(P.LENGTH * 1.05); P.X = r3(P.X * 1.05);
            if (typed(c)) c.PROPERTIES.SHOOT_SETTINGS = cs([c.PROPERTIES.SHOOT_SETTINGS, g.pounder]); return c; }) };
    },
    // each centred trap launcher or spawner splits into a side-by-side pair
    pairUp: w => {
        const us = units(w.guns).filter(u => u.typed && (u.kind === 'trap' || u.kind === 'drone') && Math.abs(u.y) < 0.5);
        if (!us.length || us.length > 4) return null;
        const drop = new Set(us.flatMap(u => u.guns)), add = [];
        for (const u of us) {
            const Wd = Math.max(...u.guns.map(gn => gn.POSITION.WIDTH)), off = Wd * 0.75 * 0.62;
            for (const [y, d] of [[off, 0], [-off, 0.5]]) for (const gn of u.guns) {
                const c = clone(gn), P = c.POSITION; P.WIDTH = r3(P.WIDTH * 0.75); P.Y = r3(y); P.DELAY = r3(((P.DELAY || 0) + d) % 1);
                if (typed(c)) { c.PROPERTIES.SHOOT_SETTINGS = cs([c.PROPERTIES.SHOOT_SETTINGS, g.twin]); if (c.PROPERTIES.MAX_CHILDREN) c.PROPERTIES.MAX_CHILDREN = Math.max(1, Math.ceil(c.PROPERTIES.MAX_CHILDREN * 0.6)); }
                add.push(c);
            }
        }
        return { ...w, guns: [...w.guns.filter(gn => !drop.has(gn)), ...add] };
    },
    // trap launchers grow long (faster, farther traps)
    longTraps: w => {
        const us = units(w.guns).filter(u => u.typed && u.kind === 'trap');
        if (!us.length || us.some(u => u.guns.some(gn => gn.POSITION.LENGTH + gn.POSITION.X > 20))) return null;
        const lg = new Set(us.flatMap(u => u.guns));
        return { ...w, guns: w.guns.map(gn => { if (!lg.has(gn)) return gn; const c = clone(gn), P = c.POSITION; if (typed(c)) { P.X = r3(P.X * 1.4); c.PROPERTIES.SHOOT_SETTINGS = cs([c.PROPERTIES.SHOOT_SETTINGS, g.sniper]); } else P.LENGTH = r3(P.LENGTH * 1.4); return c; }) };
    },
    // a front barrel gets a shorter pair at its sides (Triplet's)
    triplet: w => {
        const us = units(w.guns).filter(u => u.typed && u.kind === 'bullet' && Math.abs(u.a) <= 2 && Math.abs(u.y) < 0.5 && u.guns.length === 1);
        if (us.length !== 1 || w.guns.some(gn => Math.abs(na(gn.POSITION.ANGLE)) <= 2 && Math.abs(gn.POSITION.Y) > 1)) return null;
        const gn = us[0].guns[0], Wd = gn.POSITION.WIDTH, add = [];
        for (const [y, d] of [[Wd * 0.62, 0.5], [-Wd * 0.62, 0.5]]) { const c = clone(gn), P = c.POSITION; P.LENGTH = r3(P.LENGTH * 0.84); P.WIDTH = r3(Wd * 0.85); P.Y = r3(y); P.DELAY = r3(((P.DELAY || 0) + d) % 1); c.PROPERTIES.SHOOT_SETTINGS = cs([c.PROPERTIES.SHOOT_SETTINGS, g.tripleShot]); add.push(c); }
        const main = clone(gn); main.PROPERTIES.SHOOT_SETTINGS = cs([main.PROPERTIES.SHOOT_SETTINGS, g.tripleShot]);
        return { ...w, guns: [...add, ...w.guns.map(x => x === gn ? main : x)] };
    },
    // smashers: a new spiked shell from the existing families
    hat: w => ({ ...w, turrets: [...realTurrets(w), hat('hexagonHat_spin', pick([21.5, 23, 25]))] }),
    hat2: w => ({ ...w, turrets: [...realTurrets(w), ...F.weaponArray(hat('triangleHat_spin', pick([16, 18])), pick([3, 5, 6])).map(normTur)] }),
    hatDouble: w => ({ ...w, turrets: [...realTurrets(w), hat('hexagonHat_spin', 21.5), hat('hexagonHat_spinFaster', 21.5, 90)] }),
    hatMix: w => ({ ...w, turrets: [...realTurrets(w), ...F.weaponArray(hat('triangleHat_spin', 17), 3).map(normTur), hat('hexagonHat_spin', 19)] }),
};
function ringOf(w, n) {
    if (w.guns.some(gn => Math.abs(na(gn.POSITION.ANGLE)) > 45) || !w.guns.some(typed)) return null;
    return { ...w, guns: F.weaponArray(w.guns, n, { delayIncrement: n === 2 ? 0.5 : 0 }).map(normGun) };
}
function sidesOf(w, th) {
    const c = coreGuns(w); if (!c.length || !free(w, th, 25) || !free(w, -th, 25)) return null;
    return { ...w, guns: [...w.guns, ...moved(c, th, 0.85, 0.25), ...moved(c, -th, 0.85, 0.75, true)] };
}
function remountOf(w, how) {
    const rim = realTurrets(w).filter(t => Math.hypot(t.POSITION.X, t.POSITION.Y) + t.POSITION.SIZE / 2 > 10.6);
    if (rim.length < 2 || !MOUNT[rim.length] || rim.length !== realTurrets(w).length) return null;
    const n = rim.length, angs = rim.map(t => tAt(t.POSITION)[2] + (how === 'gaps' ? 180 / n : 0));
    if (w.guns.some(gn => angs.some(a => Math.abs(na(gn.POSITION.ANGLE - a)) < 20))) return null;
    const add = how === 'traps' ? angs.flatMap(a => trapGun(13, 8, { a })) : angs.map(a => gun(n > 3 ? 15.5 : 17, n > 3 ? 7 : 8, { a }, [g.basic, g.flankGuard, ...(n > 3 ? [g.flankGuard] : [])]));
    // the ring keeps its own guns (Mega-3's big ones, Architect's trap layers)
    const type = arr(rim[0].TYPE)[0];
    // 'one': a single big turret in the middle instead of the ring
    const ring = how === 'one' ? [(t => { t.TYPE[0] = 'megaAutoTurret'; t.POSITION.SIZE = 12; return t; })(mountRing(1)[0])] : mountRing(n, type);
    return { ...w, turrets: [...w.turrets.filter(t => !rim.includes(t)), ...ring], guns: [...w.guns, ...add.map(normGun)] };
}
// a ring of auto turrets on the body (never on top of other turrets)
function radialOf(w, n) {
    if (realTurrets(w).length) return null;
    return { ...w, turrets: [...w.turrets, ...mountRing(n)] };
}
function swapOf(w, kind) {
    const us = units(w.guns).filter(u => u.typed && u.kind === 'bullet' && Math.abs(u.a) > 60);
    if (!us.length) return null;
    const drop = new Set(us.flatMap(u => u.guns));
    const add = us.flatMap(u => {
        const L = Math.max(...u.guns.map(gn => gn.POSITION.LENGTH + gn.POSITION.X)), o = { a: u.a, y: u.y };
        return kind === 'trap' ? trapGun(Math.max(12, L * 0.75), Math.min(9, u.guns[0].POSITION.WIDTH), o) : [spawner({ a: u.a, y: u.y }, [], 3)];
    });
    if (kind === 'drone' && us.length > 4) return null;
    return { ...w, guns: [...w.guns.filter(gn => !drop.has(gn)), ...add.map(normGun)] };
}
// ---------------------------------------------------------------- hand-made tanks
const mirrorPair = (gn) => F.weaponMirror(gn, { delayIncrement: 0.5 }).map(normGun);
const fork = ({ L = 22, Wd = 6, y = 2, a = 14, stats = [g.basic, g.twin], block = [11, 11.5], rot = 0, d = 0, k = 1 } = {}) => moved([
    ...mirrorPair(gun(L, Wd, { y, a, d }, stats)), deco(block[0], block[1])], rot, k);
const trident = ({ L = 22, side = 19, Wd = 5.5, a = 20, stats = [g.basic, g.twin], block = [11, 12], rot = 0, k = 1, d = 0 } = {}) => moved([
    gun(side, Wd, { y: 2.5, a, d: d + 1 / 3 }, stats), gun(side, Wd, { y: -2.5, a: -a, d: d + 2 / 3 }, stats), gun(L, Wd, { d }, stats), deco(block[0], block[1])], rot, k);
const SPL = {
    splitter: { label: 'Splitter', tier: 2, parents: ['basic'], w: { parent: 'genericTank', guns: fork() } },
    trident: { label: 'Trident', tier: 3, parents: ['splitter'], w: { parent: 'genericTank', guns: trident() } },
    wishbone: { label: 'Wishbone', tier: 3, parents: ['splitter', 'flankGuard'], w: { parent: 'genericTank', guns: [...fork(), ...fork({ L: 18, rot: 180, d: 0.25 })] } },
    pitchfork: { label: 'Pitchfork', tier: 3, parents: ['splitter', 'sniper'], w: { parent: 'genericTank', guns: fork({ L: 26, Wd: 5.5, y: 2.2, a: 9, stats: [g.basic, g.sniper, g.twin], block: [13, 10.5] }) } },
    tusker: { label: 'Tusker', tier: 3, parents: ['splitter', 'pounder'], w: { parent: 'genericTank', guns: fork({ L: 20, Wd: 8.5, y: 3, a: 16, stats: [g.basic, g.pounder, g.twin], block: [11, 14] }) } },
    hydra: { label: 'Trefoil', tier: 4, parents: ['wishbone'], w: { parent: 'genericTank', guns: [0, 120, 240].flatMap((r, i) => fork({ L: 20, rot: r, d: i / 3 })) } },
    candelabra: { label: 'Candelabra', tier: 4, parents: ['trident'], w: { parent: 'genericTank', guns: [
        gun(16, 5.5, { y: 3, a: 34, d: 0.2 }, [g.basic, g.twin, g.tripleShot]), gun(16, 5.5, { y: -3, a: -34, d: 0.8 }, [g.basic, g.twin, g.tripleShot]),
        gun(18.5, 5.5, { y: 2.5, a: 17, d: 0.4 }, [g.basic, g.twin, g.tripleShot]), gun(18.5, 5.5, { y: -2.5, a: -17, d: 0.6 }, [g.basic, g.twin, g.tripleShot]),
        gun(21, 5.5, {}, [g.basic, g.twin, g.tripleShot]), deco(13, 14)] } },
    harpoon: { label: 'Harpoon', tier: 4, parents: ['pitchfork', 'trident'], w: { parent: 'genericTank', guns: trident({ L: 27, side: 23.5, Wd: 5, a: 12, stats: [g.basic, g.sniper, g.twin], block: [15, 12] }) } },
    banyan: { label: 'Banyan', tier: 4, parents: ['wishbone'], w: { parent: 'genericTank', guns: [0, 90, 180, 270].flatMap((r, i) => fork({ L: 20, rot: r, d: i / 4 })) } },
    mammoth: { label: 'Mammoth', tier: 4, parents: ['tusker', 'wishbone'], w: { parent: 'genericTank', guns: [...fork({ L: 20, Wd: 8.5, y: 3, a: 16, stats: [g.basic, g.pounder, g.twin], block: [11, 14] }), ...thrusters()] } },
    sequoia: { label: 'Sequoia', tier: 5, parents: ['hydra'], w: { parent: 'genericTank', guns: [0, 120, 240].flatMap((r, i) => trident({ L: 20, side: 17.5, rot: r, d: i / 3 })) } },
    kraken: { label: 'Nautilus', tier: 5, parents: ['candelabra'], w: { parent: 'genericTank', guns: [...SPLc(), ...fork({ L: 18, rot: 180, d: 0.5 })] } },
};
function SPLc() { return [gun(16, 5.5, { y: 3, a: 34, d: 0.2 }, [g.basic, g.twin, g.tripleShot]), gun(16, 5.5, { y: -3, a: -34, d: 0.8 }, [g.basic, g.twin, g.tripleShot]),
    gun(18.5, 5.5, { y: 2.5, a: 17, d: 0.4 }, [g.basic, g.twin, g.tripleShot]), gun(18.5, 5.5, { y: -2.5, a: -17, d: 0.6 }, [g.basic, g.twin, g.tripleShot]),
    gun(21, 5.5, {}, [g.basic, g.twin, g.tripleShot]), deco(13, 14)]; }
const TS = [g.basic, g.twin];
const HAND = {
    swallow: { label: 'Swallow', tier: 3, branch: 'twin', parents: ['twin', 'flankGuard'], w: { parent: 'twin', guns: [
        ...F.weaponMirror(gun(20, 8, { y: 5.5 }, [g.basic, g.twin, g.flankGuard]), { delayIncrement: 0.5 }).map(normGun),
        gun(16, 8, { a: 150, d: 0.1 }, [g.basic, g.flankGuard, g.triAngle, g.thruster]), gun(16, 8, { a: -150, d: 0.6 }, [g.basic, g.flankGuard, g.triAngle, g.thruster])] } },
    lookout: { label: 'Lookout', tier: 3, branch: 'sniper', parents: ['sniper', 'flankGuard'], w: { parent: 'sniper', guns: [gun(24, 8.5, {}, [g.basic, g.sniper]), gun(16, 8, { a: 180, d: 0.5 }, [g.basic, g.flankGuard])] } },
    spyglass: { label: 'Spyglass', tier: 3, branch: 'sniper', parents: ['sniper', 'twin'], w: { parent: 'sniper', guns: F.weaponMirror(gun(24, 7, { y: 4.5 }, [g.basic, g.sniper, g.twin]), { delayIncrement: 0.5 }).map(normGun) } },
    spritzer: { label: 'Spritzer', tier: 3, branch: 'machineGun', parents: ['machineGun'], w: { parent: 'machineGun', guns: [
        gun(14.5, 8.5, { asp: 1.35, a: 38, d: 0.5 }, [g.basic, g.machineGun, g.tripleShot]), gun(14.5, 8.5, { asp: 1.35, a: -38, d: 0.5 }, [g.basic, g.machineGun, g.tripleShot]), gun(15.5, 10, { asp: 1.4 }, [g.basic, g.machineGun, g.tripleShot])] } },
    hailstorm: { label: 'Hailstorm', tier: 3, branch: 'machineGun', parents: ['machineGun', 'twin'], w: { parent: 'machineGun', guns: F.weaponMirror(gun(13, 8, { asp: 1.3, y: 5 }, [g.basic, g.machineGun, g.twin]), { delayIncrement: 0.5 }).map(normGun) } },
    shepherd: { label: 'Shepherd', tier: 3, branch: 'director', parents: ['director'], w: { parent: 'director', guns: F.weaponArray(spawner({}, [], 2), 3).map(normGun) } },
    warden: { label: 'Gatekeeper', tier: 3, branch: 'director', parents: ['director', 'trapper'], w: { parent: 'director', guns: [spawner({}, [g.overseer], 5), ...trapGun(13, 8, { a: 180 })].map(normGun) } },
    mauler: { label: 'Mauler', tier: 3, branch: 'pounder', parents: ['pounder', 'twin'], w: { parent: 'pounder', guns: F.weaponMirror(gun(19, 10, { y: 6 }, [g.basic, g.pounder, g.twin]), { delayIncrement: 0.5 }).map(normGun) } },
    palisade: { label: 'Palisade', tier: 3, branch: 'trapper', parents: ['trapper', 'twin'], w: { parent: 'trapper', guns: [...trapGun(15, 7, { y: 5.5 }), ...trapGun(15, 7, { y: -5.5, d: 0.5 })] } },
    stockade: { label: 'Gatepost', tier: 3, branch: 'trapper', parents: ['trapper', 'flankGuard'], w: { parent: 'trapper', guns: [...trapGun(16, 7.5), ...trapGun(13, 7.5, { a: 180, d: 0.5 })] } },
    bumper: { label: 'Bumper', tier: 3, branch: 'smasher', parents: ['basic'], w: { parent: 'smasher', guns: [], turrets: F.weaponArray(hat('triangleHat_spin', 18), 3) } },
};
for (const k in SPL) HAND[k] = { ...SPL[k], branch: 'splitter' };

// ---------------------------------------------------------------- pipeline
const PLAN = {  // new tanks per branch and tier
    // tier 4 only: tier 5 follows from the rule below (every tier 4 tank gets 3)
    twin: [16], sniper: [16], machineGun: [16], director: [16], flankGuard: [14],
    pounder: [14], trapper: [12], smasher: [6], splitter: [12],
};
const MIN_KIDS = 3;  // every tier 3 tank has 3+ tier 4 children
// layout rules per branch
const T4RULES = {
    twin: ['alt', 'ring2', 'ring3', 'rear', 'sides90', 'sides120', 'fan', 'stack', 'guard', 'bird', 'rearGunner', 'cross', 'longshot', 'heavy', 'sideTraps', 'remount', 'remountGaps', 'remountTraps', 'remountOne'],
    sniper: ['alt', 'ring2', 'rear', 'sides120', 'sides150', 'stack', 'guard', 'bird', 'cross', 'heavy', 'twinify', 'remount', 'remountGaps', 'remountTraps', 'remountOne'],
    machineGun: ['alt', 'ring2', 'ring3', 'rear', 'sides90', 'fan', 'stack', 'guard', 'bird', 'rearGunner', 'cross', 'heavy', 'twinify', 'longshot'],
    flankGuard: ['alt', 'thin', 'ring3', 'ring4', 'sides90', 'stack', 'guard', 'bird', 'trapSwap', 'cross', 'thin', 'twinify', 'heavy', 'longshot', 'sideTraps', 'trapToGun', 'remount', 'remountGaps', 'remountTraps', 'remountOne'],
    director: ['swarmPair', 'bird', 'alt', 'over', 'droneSwap', 'guard', 'cross', 'ring2', 'ring3', 'sideTraps', 'remount', 'remountGaps', 'remountTraps', 'remountOne', 'nose', 'heavyAll', 'pairUp'],
    pounder: ['alt', 'ring2', 'rear', 'sides90', 'sides120', 'stack', 'fan', 'guard', 'bird', 'trapSwap', 'cross', 'twinify', 'longshot', 'sideTraps'],
    trapper: ['swarmPair', 'ring2', 'ring3', 'ring4', 'rear', 'sides90', 'fan', 'over', 'cross', 'trapToGun', 'sideTraps', 'remount', 'remountGaps', 'remountTraps', 'remountOne', 'heavyAll', 'pairUp', 'longTraps'],
    smasher: ['hat2', 'hatDouble', 'hatMix', 'bird'],      // no 'guard': a ram hull carries no weapon barrels (neat.js facing)
    splitter: ['alt', 'ring2', 'ring3', 'rear', 'sides90', 'sides120', 'fan', 'stack', 'guard', 'bird', 'cross', 'heavy', 'longshot'],
};
const T5EXTRA = { flankGuard: ['thin', 'nose'], director: ['thin'], twin: ['thin', 'trapSwap', 'nose'], machineGun: ['thin', 'nose', 'remount', 'remountGaps', 'remountTraps', 'remountOne'], trapper: ['thin', 'trapSwap', 'nose'], pounder: ['thin', 'nose', 'remount', 'remountGaps', 'remountTraps', 'remountOne'], sniper: ['nose'], splitter: ['nose'], smasher: [] };
// launchers made heavier or doubled, a Triplet front: for every line (a rule that does not fit returns nothing)
for (const b in T5EXTRA) if (b !== 'smasher') T5EXTRA[b].push('heavyAll', 'pairUp', 'triplet', 'longTraps');
const MOUNTS = { smasher: ['auto', 'radial2', 'radial3'], director: ['auto', 'radial2', 'radial3'], _: ['auto', 'radial2', 'radial3', 'radial4'] };
const CROSS_KINDS = { director: ['drone', 'bullet', 'trap', 'swarm'], trapper: ['trap', 'bullet', 'drone'], smasher: [], _: ['bullet', 'trap'] };
const CAP = { 4: 12, 5: 5 };

// neatness of a layout (scripts/tanks/neat.js), cached per tank
const neatOf = t => t.neat || (t.neat = { sym: N.symmetry(t.f), ov: N.overlap(t.f).worst, tu: N.turrets(t.f), sb: N.stubby(t.f) });
// a design is neat when it is mirror-symmetric or evenly radial
const OVERLAP_MAX = 0.45;             // Penta Shot's fan is the most today's tanks allow (0.435)
function neatFail(f, pf) {
    const n = { sym: N.symmetry(f), ov: N.overlap(f).worst, tu: N.turrets(f), sb: N.stubby(f) };
    const pn = pf ? neatOf(pf) : { ov: 0, tu: { off: 0, pile: 0, cover: 0 }, sb: Infinity };
    if (!n.sym) return 'asym';
    if (n.ov > Math.max(OVERLAP_MAX, pn.ov + 0.02)) return 'overlap';
    if (n.tu.off > 0.6 || n.tu.pile || n.tu.cover) return 'turretFit';
    if (n.sb < Math.min(0.45, pn.sb)) return 'stubby';
    return null;
}
// armed turrets stripped: what the barrels (and a smasher's shell) look like
const bare = f => ({ ...f, turrets: f.turrets.filter(t => !N.armed(t)) });
// only turrets added on top of the same barrels (and shell)
const lazyOver = (f, pf) => N.sameLayout(bare(f), bare(pf)) && f.turrets.filter(N.armed).length > pf.turrets.filter(N.armed).length;
const handDropped = [];
let tryNow = false, lastDup = null, nextKey = 0;
// a design that equals one of its siblings plus a bolt-on (either way round)
const childrenOf = (p, tier) => tanks.filter(t => t.tier === tier && t.parents.includes(p));
const siblingClash = (f, p, tier, self = null) => childrenOf(p, tier).some(o => o !== self && o.f !== f && N.boltOn(f, o.f));
// may `t` (already built) also sit under parent `p`?
const fitsUnder = (t, p) => N.lineOK(t.f, byKey[p].f) && !siblingClash(t.f, p, t.tier, t) && !lazyOver(t.f, byKey[p].f);
// rules that turn one weapon kind into another: only on a parent that already mixes kinds
const CONVERT = new Set(['sideTraps', 'trapToGun', 'trapSwap', 'droneSwap', 'remountTraps']);            // GEN_TRY=<parent>:<rule> prints why that child fails
// the Necromancer line (square bodies): Underseer and everything under it
const SQUARE = new Set(['underseer', 'necromancer', 'maleficitor']);
const bySig = new Map();              // layoutSig -> flattened tanks already accepted
const sigAdd = f => { const k = N.layoutSig(f); if (!bySig.has(k)) bySig.set(k, []); bySig.get(k).push(f); };
const dupOf = f => (bySig.get(N.layoutSig(f)) || []).find(o => N.sameLayout(f, o));
const tanks = [];                 // every tank of the expanded tree, old and new
const byKey = {}; BUILT.byKey = byKey;
const fps = [];                   // fingerprints of everything accepted so far
const childCount = {};
const addChild = (p, t) => { childCount[p + ':' + t] = (childCount[p + ':' + t] || 0) + 1; };
const kids = (p, t) => childCount[p + ':' + t] || 0;
for (const k of Object.keys(EXP.tier)) {
    const f = flatOld[k];
    const t = { key: k, label: f.label, tier: EXP.tier[k], branch: primaryBranch(k), parents: EXP.parents[k], isNew: false, f, fp: fingerprint(f) };
    tanks.push(t); byKey[k] = t; fps.push(t.fp); f.key = k; sigAdd(f);
    for (const p of t.parents) addChild(p, t.tier);
}
const rejects = {};
let rejTag = '';
let lastRej = null;
const rej = r => { lastRej = r; rejects[r] = (rejects[r] || 0) + 1; const k = rejTag + ' ' + r; rejects[k] = (rejects[k] || 0) + 1; return null; };
function evaluate(w, tier, branch, parents, rule, label = null, hand = false, key = null) {
    if (!w) return rej('rule');
    const wPrev = lookBase(w);     // before the Oct 7 turns (dpsFloor.json keys measured designs by it)
    w = look(w);
    const f = flatW(w);
    const pt = byKey[parents[0]] || null, pf = pt ? pt.f : null;
    // round bodies only
    if (f.shape && !(f.shape === 4 && SQUARE.has(parents[0]))) { if (hand) throw Error(label + ' body shape ' + f.shape); return rej('shape'); }
    // no dead barrels, ever
    if (deadOf(f).length) { if (hand) throw Error(label + ' has a barrel that fires nothing'); return rej('dead'); }
    // every barrel reads as what it throws (scripts/tanks/neat.js grammar)
    { const gm = N.grammar(f); if (gm.length) { if (hand) throw Error(label + ' barrel look: ' + gm[0]); return rej('look'); } }
    // every barrel points where the tank fights: no weapons on a ram hull, no thrusters without a gun to push (neat.js facing)
    { const fc = N.facing(f); if (fc.length) { if (hand) throw Error(label + ' facing: ' + fc[0].why); return rej('facing'); } }
    if (!hand) {
        // drone lines stay drone lines, trap lines stay trap lines
        if (parents.some(p => byKey[p] && !N.lineOK(f, byKey[p].f))) return rej('line');
        // one weapon kind turned into another (sides to traps, traps to guns): only on a mixed parent
        if (pf && N.converted(f, pf) && !N.hybrid(pf)) return rej('convert');
        if ((SANITY.drop || []).includes(sanityHash(w))) return rej('duel');
        const had = pf ? uglySet(pf) : new Set();
        const u = [...uglySet(f, pf ? stats(pf) : null)].find(r => !had.has(r)); if (u) return rej(u);
        const nf = neatFail(f, pt); if (nf) return rej(nf);
        // an upgrade that only bolts turrets onto its parent's barrels
        if (pf && lazyOver(f, pf)) return rej('lazy');
        // nor a sibling plus a bolt-on (turrets, an extra barrel)
        if (parents.some(p => siblingClash(f, p, tier))) return rej('sibling');
    }
    { const d = dupOf(f); lastDup = d; if (d && tryNow) console.warn('DUP of', d.key, byKey[d.key] && byKey[d.key].parents.join('/'), byKey[d.key] && byKey[d.key].hand); if (d) { if (hand) { const dl = (byKey[d.key] && byKey[d.key].label) || d.label; console.warn('signature', label, 'dropped: same layout as', dl); handDropped.push(label + ' (= ' + dl + ')'); } return rej('duplicate'); } }
    const fp = fingerprint(f);
    if (!hand) { let worst = 0; for (const o of fps) { const j = jacc(fp, o); if (j > worst) worst = j; if (worst > 0.8) return rej('nearDuplicate'); } }
    const bal = balanceOf(f, tier);
    // the layout may cost at most 3x (or save 3x) of what its parent costs
    const ps = !hand && pt ? balanceOf(pf, tier - 1).s : 1;
    if (!hand && (bal.s / ps < 0.3 || bal.s / ps > 3)) return rej("budget");
    if (!hand && parents.some(p => kids(p, tier) >= CAP[tier])) return rej('cap');
    if (!key) { const lg = LEGACY[designHash(w)]; key = lg && !byKey[lg[0]] ? lg[0] : null; }
    if (!key) { do key = 'xp_g' + (nextKey++); while (legacyKeys.has(key)); }
    const t = { key, label, tier, branch, parents, rule, isNew: true, w, wPrev, f, fp, hand };
    tanks.push(t); fps.push(fp); f.key = key; sigAdd(f); for (const p of parents) addChild(p, tier);
    if (f.shape === 4) SQUARE.add(key);
    byKey[key] = t; Class[key] = defOf(w, label || key);   // so later children can build on it
    return t;
}
// hand-made: parents name HAND ids or existing keys
const keyOf = id => HAND[id] ? 'xp_' + id : id;
for (const id in HAND) {
    const h = HAND[id], w = { turrets: [], shape: 0, ...h.w, guns: h.w.guns.map(normGun), turrets: (h.w.turrets || []).map(normTur) };
    const t = evaluate(w, h.tier, h.branch, h.parents.filter(p => !HAND[p] || byKey[keyOf(p)]).map(keyOf), 'signature', h.label, true, keyOf(id));
    if (!t) continue;
    const u = ugly(t.f) || neatFail(t.f, null); if (u) console.warn('signature', h.label, 'flagged', u, JSON.stringify(N.overlap(t.f)));
}
// ---- the published tree first: each design that still passes keeps its place, key and name
const legacyDropped = {}, refaced = [];
// the barrels neat.js facing flags, with the housings that only served them; null when none
function unface(w) {
    const bad = new Set(N.facing(flatW(look(w))).map(x => x.i));
    if (!bad.size) return null;
    const gone = w.guns.filter((gn, i) => bad.has(i)), keep = w.guns.filter((gn, i) => !bad.has(i));
    const same = (a, b) => Math.abs(na(a.POSITION.ANGLE - b.POSITION.ANGLE)) < 1 && Math.abs(a.POSITION.Y - b.POSITION.Y) < 0.5;
    const guns = keep.filter(gn => typed(gn) || !gone.some(x => same(x, gn)) || keep.some(o => o !== gn && typed(o) && same(o, gn)));
    return { ...w, guns };
}
for (const lt of LEG.tanks) {
    if (byKey[lt.key] || HAND[lt.key.slice(3)]) continue;            // signatures are made above
    if (!byKey[lt.w.parent]) { legacyDropped[lt.label] = 'parent gone'; continue; }
    rejTag = 'legacy';
    // a published design with a barrel facing the wrong way (neat.js facing) loses that barrel
    // and keeps its key and name: the tank players picked stays the same tank
    const lw = clone(lt.w), fixed = unface(lw);
    const t = evaluate(fixed || lw, lt.tier, lt.branch, [lt.w.parent], 'legacy', null, false, lt.key);
    if (!t) { legacyDropped[lt.label] = (fixed ? 'refaced ' : '') + lastRej; if (fixed) refaced.push(lt.label + ' (dropped: ' + lastRej + ')'); continue; }
    if (fixed) { t.keepLabel = lt.label; refaced.push(lt.label); }
    for (const p of lt.parents.slice(1)) if (byKey[p] && byKey[p].tier === lt.tier - 1 && t.parents.length < 3 && kids(p, lt.tier) < CAP[lt.tier] && fitsUnder(t, p)) { t.parents.push(p); addChild(p, lt.tier); }
}
const inBranch = (t, b) => t.branch === b || (!t.isNew && branchesOf(t.key).includes(b));
function pool(tier, b) { return tanks.filter(t => t.tier === tier && inBranch(t, b)).map(t => t.key); }
function partnerFor(tier, b) {
    const okKinds = CROSS_KINDS[b] || CROSS_KINDS._;
    const cands = tanks.filter(t => t.tier === tier && t.key && t.f.guns.some(x => x.typed && Math.abs(na(x.a)) > 60) &&
        t.f.guns.filter(x => x.typed && Math.abs(na(x.a)) > 60).every(x => okKinds.includes(kindOf({ PROPERTIES: { TYPE: x.type, SHOOT_SETTINGS: 1 } }))));
    return cands.length ? pick(cands).key : null;
}
function child(parentKey, tier, b, rules, share = false) {
    rejTag = b + tier; if (process.env.GEN_DEBUG) rejTag = parentKey;
    const base = W(parentKey); if (!base) return rej('fn');
    const rule = pick(rules); const ctx = {};
    if (CONVERT.has(rule) && !N.hybrid(byKey[parentKey].f) && !(rule === 'remountTraps' && N.mainKind(byKey[parentKey].f) === 't')) return rej('convert');
    if (rule === 'cross') { ctx.partner = partnerFor(tier - 1, b); if (!ctx.partner || ctx.partner === parentKey) return rej('rule'); }
    let w;
    try { w = RULES[rule](cloneW(base), ctx); } catch (e) { if (process.env.GEN_THROW) console.warn(rule, e.message); return rej('throw'); }
    if (!w) return rej('rule');
    let name = rule;
    if (rnd() < (b === 'smasher' ? 0.5 : 0.3)) { const m = pick(MOUNTS[b] || MOUNTS._); if (m !== rule) { const w2 = RULES[m](cloneW(w), ctx); if (w2) { w = w2; name += '+' + m; } } }
    w.parent = parentKey;
    tryNow = process.env.GEN_TRY === parentKey + ':' + rule;
    if (tryNow) { const f = flatW(w); console.warn('TRY', name, JSON.stringify(N.turrets(f)), N.symmetry(f), JSON.stringify(N.overlap(f)), N.stubby(f), balanceOf(f, tier).s, balanceOf(byKey[parentKey].f, tier - 1).s); }
    const parents = [parentKey]; if (w.partner && byKey[w.partner] && byKey[w.partner].tier === tier - 1) parents.push(w.partner);
    delete w.partner;
    lastDup = null;
    const t = evaluate(w, tier, b, parents, name);
    // the second parent (a cross) must also see a real change
    if (t && t.parents.length > 1 && (lazyOver(t.f, byKey[t.parents[1]].f) || siblingClash(t.f, t.parents[1], tier, t))) { childCount[t.parents[1] + ':' + tier]--; t.parents.splice(1, 1); }
    // the design already exists one parent over: share it (a second parent)
    if (!t && share && lastDup && byKey[lastDup.key]) {
        const o = byKey[lastDup.key];
        if (o.isNew && !o.hand && o.rule !== 'legacy' && o.tier === tier && !o.parents.includes(parentKey) && o.parents.length < 3 && fitsUnder(o, parentKey)) { o.parents.push(parentKey); addChild(parentKey, tier); return o; }
    }
    return t;
}
// emptier parents are likelier, so children spread over the whole tier
function weighted(ps, tier) { const wt = ps.map(p => 1 / (1 + kids(p, tier))), tot = wt.reduce((a, b) => a + b, 0); let r = rnd() * tot; for (let i = 0; i < ps.length; i++) { r -= wt[i]; if (r <= 0) return ps[i]; } return ps[ps.length - 1]; }
// tier 4: random over the branch's tier 3 tanks, emptiest parent first
for (const b of BRANCHES) {
    let have = tanks.filter(t => t.isNew && t.tier === 4 && t.branch === b).length;
    for (let i = 0; have < PLAN[b][0] && i < 4000; i++) {
        const ps = pool(3, b).filter(p => kids(p, 4) < CAP[4]);
        if (!ps.length) break;
        const p = weighted(ps, 4);
        if (child(p, 4, b, T4RULES[b])) have++;
    }
    if (have < PLAN[b][0]) console.warn('tier 4', b, 'only', have);
}
// a tank one tier down that a design builds on
function adopt(p, tier, min) {
    const P = byKey[p]; let best = null;
    for (const t of tanks) {
        // a published design keeps its parents (and so its balance target)
        if (!t.isNew || t.hand || t.rule === 'legacy' || t.tier !== tier || t.parents.includes(p) || t.parents.length >= 3) continue;
        if (!t.branch || (P.isNew ? P.branch !== t.branch : !branchesOf(p).includes(t.branch) && t.branch !== P.branch)) continue;
        const c = contains(t.fp, P.fp); if (c >= min && (!best || c > best.c) && fitsUnder(t, p)) best = { t, c };
    }
    if (!best) return false;
    best.t.parents.push(p); addChild(p, tier); return true;
}
const branchRules = (k, tier) => { const bs = byKey[k].isNew ? [byKey[k].branch] : branchesOf(k); return { bs, rules: bs.flatMap(b => [...T4RULES[b], ...(tier === 5 ? T5EXTRA[b] || [] : [])]) }; };
function fill(tier) {
    const short = [];
    const ps = tanks.filter(t => t.tier === tier - 1 && t.key !== 'basic').map(t => t.key);
    for (const p of ps) {
        const { bs, rules } = branchRules(p, tier);
        while (kids(p, tier) < MIN_KIDS && adopt(p, tier, 0.85)) { /* shared child */ }
        for (let i = 0; i < 400 && kids(p, tier) < MIN_KIDS; i++) child(p, tier, bs[i % bs.length], rules, true);
        while (kids(p, tier) < MIN_KIDS && adopt(p, tier, 0.6)) { /* closest relative */ }
        if (kids(p, tier) < MIN_KIDS) short.push(byKey[p].label || p);
    }
    return short;
}
// a new tier 4 design that cannot carry 3 neat tier 5 upgrades leaves the tree
function prune() {
    let gone = 0;
    for (const t of [...tanks]) {
        if (!t.isNew || t.hand || t.tier !== 4 || kids(t.key, 5) >= MIN_KIDS) continue;
        const drop = new Set([t.key, ...tanks.filter(c => c.tier === 5 && c.w && c.w.parent === t.key).map(c => c.key)]);
        for (const k of drop) { const x = byKey[k]; for (const p of x.parents) childCount[p + ':' + x.tier]--; delete byKey[k]; delete Class[k]; }
        for (const c of tanks) if (!drop.has(c.key) && c.parents.some(p => drop.has(p))) { c.parents = c.parents.filter(p => !drop.has(p)); }
        for (let i = tanks.length - 1; i >= 0; i--) if (drop.has(tanks[i].key)) tanks.splice(i, 1);
        for (const [k, L] of bySig) bySig.set(k, L.filter(f => !drop.has(f.key)));
        gone += drop.size;
    }
    return gone;
}
const shortT4 = fill(4);
let shortT5 = fill(5);
let shortT4b = shortT4;
for (let round = 0; round < 4 && shortT5.length; round++) { if (!prune()) break; shortT4b = fill(4); shortT5 = fill(5); }
fps.length = 0; for (const t of tanks) fps.push(t.fp);
// a design that carries another tank's whole layout is listed under that tank too
for (const t of tanks) {
    if (!t.isNew || t.hand || t.rule === 'legacy' || t.tier < 4) continue;
    for (const o of tanks) {
        if (t.parents.length >= 3) break;
        if (o.tier !== t.tier - 1 || t.parents.includes(o.key) || kids(o.key, t.tier) >= CAP[t.tier]) continue;
        if (contains(t.fp, o.fp) >= 0.9 && fitsUnder(t, o.key)) { t.parents.push(o.key); addChild(o.key, t.tier); }
    }
}

// ---- names ----
const taken = new Set();
(function scan(dir) {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) scan(p);
        else if (f.endsWith('.js') && f !== path.basename(OUT)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/LABEL\s*:\s*["'`]([^"'`]+)["'`]/g)) taken.add(m[1].toLowerCase());
    }
})(path.join(SERVER, 'lib', 'definitions'));
for (const k in Class) if (Class[k] && typeof Class[k].LABEL === 'string' && !k.startsWith('xp_')) taken.add(Class[k].LABEL.toLowerCase());
for (const t of tanks) if (t.hand) { if (taken.has(t.label.toLowerCase()) && !byKey[t.key].isNew) throw Error('clash ' + t.label); }
const handLabels = tanks.filter(t => t.hand).map(t => t.label.toLowerCase());
for (const l of handLabels) if (taken.has(l)) throw Error('signature name already used: ' + l);
// names already published stay with their designs; a redesigned or new tank gets a name never used before
const legacyLabel = {}; for (const [h, [k, l]] of Object.entries(LEGACY)) legacyLabel[k] = [h, l];
const used = new Set([...taken, ...handLabels, ...NAMES.retired.map(n => n.toLowerCase()), ...Object.values(LEGACY).map(v => v[1].toLowerCase())]);
let renamed = 0, kept = 0;
for (const t of tanks) {
    if (!t.isNew || t.label) continue;
    const lg = legacyLabel[t.key];
    if (t.keepLabel) { t.label = t.keepLabel; kept++; }
    else if (lg && lg[0] === designHash(t.w)) { t.label = lg[1]; kept++; }
}
const nameIdx = {};
function nextName(poolName) {
    const list = poolName === 'retired' ? [] : NAMES[poolName] || [];
    for (let i = nameIdx[poolName] || 0; i < list.length; i++) {
        const n = list[i]; nameIdx[poolName] = i + 1;
        if (n.length <= 14 && !used.has(n.toLowerCase())) { used.add(n.toLowerCase()); return n; }
    }
    return null;
}
function tagOf(t) {
    if (t.branch === 'smasher') return 'smasher';
    if (t.branch === 'director') return 'drone';
    const k = t.f.guns.filter(x => x.typed).map(x => kindShort(x.type)), tr = k.filter(x => x === 't').length, dr = k.filter(x => x === 'd').length;
    if (t.branch === 'trapper' || (tr && tr * 2 >= k.length)) return 'trap';
    if (t.branch === 'director' || dr) return 'drone';
    if (t.branch !== 'splitter' && t.f.turrets.filter(x => !x.prop && armed(x)).length >= 3) return 'turret';
    return t.branch;
}
for (const t of tanks) {
    if (!t.isNew || t.label) continue;
    const tag = tagOf(t);
    t.label = nextName(tag) || nextName(t.branch) || nextName('spare') || nextName('spare2');
    if (!t.label && process.env.GEN_NONAME) t.label = 'Zz' + (renamed + 1);
    if (!t.label) throw Error('out of names for ' + tag);
    renamed++;
    t.nameTag = tag;
}
// Oct 7 2026 (owner: "Glacis upgrades from Architect and shoots triangles"): a launcher throws
// what its line throws. Under parents that lay only square blocks (Builder, Architect), a new
// triangle trap launcher becomes a block launcher (Builder's cap, its setTrap stats). Done after
// naming, so the published key and name stay; a parent with triangle traps keeps its children's.
const TRI = t => /^trap$/i.test(t || ''), BLOCK = t => /setTrap|unsetTrap|block|pillbox|assemblent|shotTrapBox/i.test(t || '');
const trapKinds = (f, depth = 0) => !f || depth > 3 ? [] : [...f.guns.filter(x => x.typed).map(x => x.type), ...f.turrets.filter(t => !t.prop).flatMap(t => trapKinds(t.def, depth + 1))];
const toBlocks = [];
for (const t of [...tanks].sort((a, b) => a.tier - b.tier)) {
    if (!t.isNew || !t.w.guns.some(gn => ssOf(gn) && TRI(tName(gn.PROPERTIES.TYPE)))) continue;
    const pk = t.parents.flatMap(p => byKey[p] ? trapKinds(byKey[p].f) : []);
    if (!pk.some(BLOCK) || pk.some(TRI)) continue;
    t.wLook = t.w;
    t.w = { ...t.w, guns: t.w.guns.map(gn => {
        if (!ssOf(gn) || !TRI(tName(gn.PROPERTIES.TYPE))) return gn;
        const pr = gn.PROPERTIES;
        return { POSITION: { ...gn.POSITION, LENGTH: 2, ASPECT: 1.1 }, PROPERTIES: { ...pr, SHOOT_SETTINGS: cs([pr.SHOOT_SETTINGS, g.setTrap]), TYPE: 'setTrap', STAT_CALCULATOR: 'block' } };
    }) };
    t.f = flatW(t.w); t.f.key = t.key;
    toBlocks.push(t.label);
}
// Marksman / Fork / Deadeye razor fins: keep side razors visible when a heavy barrel widens over them,
// and carry razor fins onto shared Fork / Deadeye children (Crosshair, Needle).
for (const t of tanks) {
    if (!t.isNew || !t.w || !t.w.guns) continue;
    const bs = t.w.guns.filter(ssOf);
    let changed = false;
    let guns = t.w.guns.map(gn => {
        if (ssOf(gn)) return gn;
        const P = gn.POSITION;
        const b = bs.find(x => Math.abs(N.na(x.POSITION.ANGLE - P.ANGLE)) < 1 && Math.abs(x.POSITION.Y - P.Y) < 0.5);
        if (!b) return gn;
        if (Math.abs(P.ASPECT - 2.2) < 0.05 && b.POSITION.WIDTH * 1.375 > P.WIDTH * P.ASPECT + 0.1) {
            changed = true;
            return { ...gn, POSITION: { ...P, WIDTH: r3(b.POSITION.WIDTH * 5 / 8) } };
        }
        if (Math.abs(P.ASPECT + 2.2) < 0.05 && P.WIDTH < b.POSITION.WIDTH) {
            changed = true;
            return { ...gn, POSITION: { ...P, WIDTH: b.POSITION.WIDTH } };
        }
        return gn;
    });
    if (!guns.some(gn => !ssOf(gn) && Math.abs(gn.POSITION.ASPECT - 2.2) < 0.05) && (t.parents.includes('fork') || t.parents.includes('deadeye'))) {
        const xs = t.parents.includes('fork') ? [15, 10, 5, 0] : [7, 2];
        const refL = t.parents.includes('fork') ? 29 : 24;
        const fins = [];
        for (const b of bs) {
            const bp = b.POSITION, kL = Math.min(1, bp.LENGTH / refL), wFin = r3(bp.WIDTH * 5 / 8);
            for (const x0 of xs) {
                fins.push({ POSITION: { LENGTH: r3(13 * kL), WIDTH: wFin, ASPECT: 2.2, X: r3(x0 * kL), Y: bp.Y, ANGLE: bp.ANGLE, DELAY: bp.DELAY || 0 } });
            }
        }
        if (fins.length) { guns = [...fins, ...guns]; changed = true; }
    }
    if (changed) {
        t.wLook = t.wLook || t.w;
        t.wPrev = t.wPrev || t.w;
        t.w = { ...t.w, guns };
        t.f = flatW(t.w); t.f.key = t.key;
    }
}
// invisibility runs in the family: anything under Stalker, Manager or Landmine
const invOf = k => { const t = byKey[k]; if (t && t.isNew) return t.w.invisible || null; const v = B.get(Class[k], 'INVISIBLE'); return Array.isArray(v) && (v[0] || v[1]) ? v : null; };
for (const tr of [4, 5]) for (const t of tanks) if (t.isNew && t.tier === tr) { const v = t.parents.map(invOf).find(Boolean); if (v) t.w.invisible = clone(v); else delete t.w.invisible; }
for (const t of tanks) if (t.isNew) Class[t.key] = defOf(t.w, t.label);

// ---------------------------------------------------------------- balance + output tier
const rows = [];
const balance = {};
// today's tanks duel about a third stronger than the budget says next to a generated design
// (calibration.json oldParentPremium): a child of one aims at that strength
const OLDP = CAL.oldParentPremium ? CAL.oldParentPremium.value : 1;
// (measured on tier 4 and 5; a hand-made tier 2 or 3 tank duels today's at par without it)
const powerOf = (k, tier) => { const t = byKey[k]; return t.isNew ? t.bal.T : B.power(t.f).P * (tier >= 4 ? OLDP : 1); };
const effK = {};
const steered = [], ceiled = [], dpsfMoved = {};
const droneTurrets = f => f.guns.some(x => x.typed && B.isStock(x.type)) && f.turrets.some(x => !x.prop && armed(x));
function steerFloor(t, s) {
    if (!droneTurrets(t.f)) return 1;
    const own = B.gunOffense(t.f) * s;
    const ps = t.parents.map(p => { const o = byKey[p]; return o.isNew ? B.gunOffense(o.f) * o.bal.s : B.gunOffense(o.f) * (t.tier >= 4 ? OLDP : 1); });
    const want = ps.reduce((a, b) => a + b, 0) / ps.length * STEP[t.tier];
    return own > 0 ? want / own : 1;
}
for (const t of [...tanks].sort((a, b) => a.tier - b.tier)) {
    if (!t.isNew) { const p = B.power(t.f); t.bal = { O: p.O, S: p.S, P: p.P, T: p.P, hp: 1, s: 1 }; continue; }
    const ps = t.parents.map(p => powerOf(p, t.tier));
    const T = +(ps.reduce((a, b) => a + b, 0) / ps.length * STEP[t.tier]).toFixed(4);
    const bal = balanceOf(t.f, t.tier, T);
    if (!isFinite(bal.s)) { console.warn('no offence:', t.key); continue; }
    // the duel pass nudges the damage factor (sanity.js check, kept inside its band)
    // relative to its primary parent: a parent's factor carries down to its children
    // (the duel and damage-floor files key a design as it was measured: before the block launchers and the turns)
    const pk = t.parents[0], k0 = (SANITY.k[sanityHash(t.wLook || t.w)] || 1) * (effK[pk] || 1);
    effK[t.key] = +k0.toFixed(4);
    // the aimed damage floor is the tank's own: not carried down (each child is measured and floored itself)
    // (with the duel factor, at most 2.5x: tanksExpansion.test.js 'out of reason')
    // (a turned or re-capped design keeps the factor it was measured with until the next fit)
    const hNow = rawHash(t.w), hPrev = rawHash(t.wPrev || t.w);
    if (DPSF[hNow] == null && DPSF[hPrev] != null) dpsfMoved[hNow] = DPSF[hPrev];
    const df = DPSF[hNow] ?? DPSF[hPrev] ?? 1;
    // a floor (df > 1) raises before the steer floor below, a ceiling (df < 1) lowers the result
    const up = Math.max(1, df), down = Math.min(1, df);
    let k = +Math.min(2.5, k0 * up).toFixed(4);
    // Oct 7 2026 (owner: Sultan's drones "barely do any damage"): on a drone tank the auto turrets
    // ride on top. The budget prices autos like barrels, so a drone child that gains them (Sultan:
    // Big Cheese's drone doubled, plus 2 autos) paid with its drones, each at half Big Cheese's
    // damage. What you steer (its drones and barrels, turrets left out) carries the tier step over
    // its parents' steered weapons, as the whole tank's target does, the duel verdict (k0) still on
    // top. Only the guns take that factor (balance[0]); the turrets keep the budget's (balance[4]).
    const s0 = bal.s, sf = steerFloor(t, s0), G = B.gunOffense(t.f), Tu = B.turretOffense(t.f);
    let sg = +(s0 * k).toFixed(4), ts = sg;
    if (sf > 1 && k0 * sf > k) {
        const S1 = bal.S * bal.hp;
        let g2 = Math.min(s0 * k0 * sf, (2.5 * T / S1 - Tu * ts) / G);   // the whole tank at most 2.5x its target
        g2 = +g2.toFixed(4);
        if (g2 > ts) { steered.push(t.label + ' drones x' + (g2 / ts).toFixed(2)); sg = g2; }
    }
    // the aimed ceiling (dpsFloor.js CEIL) scales guns and turrets alike, never under 0.2x of the target overall
    if (down < 1) { const S1 = bal.S * bal.hp, P = (G * sg + Tu * ts) * S1, lo = 0.2 * T / P, d = Math.max(down, Math.min(1, lo)); sg = +(sg * d).toFixed(4); ts = +(ts * d).toFixed(4); ceiled.push(t.label + ' x' + d.toFixed(2)); }
    // the whole factor over the target (balance[3]): k itself unless the steer floor or the ceiling moved it
    const moved = ts !== sg || down < 1, kk = moved ? +((G * sg + Tu * ts) * bal.S * bal.hp / T).toFixed(4) : k;
    bal.s = sg; if (ts !== sg) bal.ts = ts;
    t.bal = bal; t.duelK = kk;
    balance[t.key] = ts !== sg ? [sg, bal.hp, T, kk, ts] : kk !== 1 ? [sg, bal.hp, T, kk] : [sg, bal.hp, T];
}
const ORDER = ['basic', ...BRANCHES];
tanks.sort((a, b) => ORDER.indexOf(a.branch) - ORDER.indexOf(b.branch) || a.tier - b.tier || (a.isNew - b.isNew) || (a.label < b.label ? -1 : 1));
tanks.forEach((t, i) => { t.id = i + 1; });
const labelOf = k => (byKey[k] && byKey[k].label) || (Class[k] && Class[k].LABEL) || k;
const csv = ['id,key,label,branch,tier,new,parents,O,S,power,target,damage_factor,health_factor,power_after'];
for (const t of tanks) {
    const b = t.bal || { O: 0, S: 0, P: 0, T: 0, s: 1, hp: 1 };
    csv.push([t.id, t.key, '"' + t.label + '"', BRANCH_NAME[t.branch], t.tier, t.isNew ? 1 : 0, '"' + t.parents.map(labelOf).join(' / ') + '"',
        b.O.toFixed(4), b.S.toFixed(2), b.P.toFixed(2), (b.T ?? b.P).toFixed(2), b.s, b.hp, (b.O * b.s * b.S * b.hp).toFixed(2)].join(','));
}
// flattened tanks for the contact sheets (drawn standalone, no server)
const slim = f => ({ shape: typeof f.shape === 'number' ? f.shape : 0, color: f.color, guns: f.guns.map(x => [r3(x.L), r3(x.W), r3(x.asp), r3(x.X), r3(x.Y), r3(x.a), x.typed ? 1 : 0, x.col || 0]),
    turrets: f.turrets.map(t => ({ S: t.S, X: t.X, Y: t.Y, a: t.a, layer: t.layer, color: t.color || 0, def: slim(t.def) })) });
const sheets = tanks.map(t => ({ id: t.id, key: t.key, label: t.label, tier: t.tier, branch: t.branch, isNew: t.isNew, rule: t.rule || '', parents: t.parents.map(labelOf),
    s: t.bal ? t.bal.s : 1, hp: t.bal ? t.bal.hp : 1, f: slim(t.f) }));
const CHECK = argv.includes('--check');
if (!CHECK) fs.mkdirSync(REPORT, { recursive: true });
if (!CHECK) fs.writeFileSync(path.join(REPORT, 'balance.csv'), csv.join('\n') + '\n');
if (!CHECK) fs.writeFileSync(path.join(REPORT, 'sheets.json'), JSON.stringify({ branchName: BRANCH_NAME, order: ORDER, tanks: sheets }));

const newTanks = tanks.filter(t => t.isNew).sort((a, b) => a.tier - b.tier || a.id - b.id);
const data = {
    generator: 'scripts/gen-tanks.js', constants: CONSTANTS, targets: TARGET, sref: SREF, root: 'xp_splitter', removed: ['desmos'],
    base: { hash: B.treeHash() },
    tolerance: { steps: STEP, oldPremium: OLDP, tough: [0.82, 1.22], calibration: { duels: CAL.duels, beta: CAL.beta, accuracy: CAL.accuracy } },
    tanks: newTanks.map(t => ({ key: t.key, label: t.label, tier: t.tier, branch: t.branch, parents: t.parents, def: defOf(t.w, t.label) })),
    balance,
};
const lines = ['// GENERATED by scripts/gen-tanks.js: do not edit by hand, run `node scripts/gen-tanks.js`.',
    '// The expanded tank tree (on by default; ROYALE_TANKS=classic turns it off), installed by entityAddons/tanksExpansion.js.', "'use strict';", 'module.exports = {'];
for (const k of ['generator', 'constants', 'targets', 'sref', 'root', 'removed', 'base', 'tolerance']) lines.push('    ' + JSON.stringify(k) + ': ' + JSON.stringify(data[k]) + ',');
lines.push('    "tanks": [');
for (const t of data.tanks) lines.push('        ' + JSON.stringify(t) + ',');
lines.push('    ],', '    "balance": {');
for (const k of Object.keys(balance).sort()) lines.push('        ' + JSON.stringify(k) + ': ' + JSON.stringify(balance[k]) + ',');
lines.push('    },', '};', '');
if (CHECK) {
    const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === lines.join('\n');
    console.log(same ? 'tanks_expansion_data.js is up to date' : 'tanks_expansion_data.js is stale: run node scripts/gen-tanks.js');
    process.exit(same ? 0 : 1);
}
fs.writeFileSync(OUT, lines.join('\n'));

// ---------------------------------------------------------------- summary
const count = {};
for (const t of tanks) { const k = BRANCH_NAME[t.branch] + ' T' + t.tier; count[k] = count[k] || [0, 0]; count[k][t.isNew ? 1 : 0]++; }
console.log('constants', JSON.stringify(CONSTANTS));
console.log('targets', Object.entries(TARGET).map(([t, v]) => 'T' + t + ' ' + v.toFixed(1)).join('  '));
console.log('tanks', tanks.length, 'old', tanks.filter(t => !t.isNew).length, 'new', newTanks.length);
console.log(Object.entries(count).map(([k, v]) => k + ': ' + v[0] + ' old + ' + v[1] + ' new').join('\n'));
const rj = {}; for (const [k, v] of Object.entries(rejects)) if (!k.includes(' ')) rj[k] = v;
console.log('rejected', JSON.stringify(rj));
const legacyGone = Object.values(LEGACY).filter(([k]) => !byKey[k] || byKey[k].label !== LEGACY[designHash(byKey[k].w || {})]?.[1]).length;
console.log('names: kept', kept, 'new', renamed, '; published designs gone or changed', legacyGone, '; duel-adjusted', tanks.filter(t => t.duelK && t.duelK !== 1).length);
console.log('old tanks: all', tanks.filter(t => !t.isNew).length, 'untouched (no balance entry)');
for (const tr of [2, 3, 4, 5]) {
    const nw = tanks.filter(t => t.isNew && t.tier === tr && t.bal), od = tanks.filter(t => !t.isNew && t.tier === tr);
    if (!nw.length) continue;
    const sv = nw.map(t => t.bal.s);
    console.log('T' + tr + ' new ' + nw.length + ': median power ' + median(nw.map(t => t.bal.T)).toFixed(1) + (od.length ? ' (old median ' + median(od.map(t => t.bal.P)).toFixed(1) + ')' : '') +
        ', damage factor ' + Math.min(...sv).toFixed(2) + '-' + Math.max(...sv).toFixed(2) + ', health factor != 1: ' + nw.filter(t => t.bal.hp !== 1).length);
}
if (shortT4b.length || shortT5.length) console.warn('FEWER THAN ' + MIN_KIDS + ' CHILDREN:', [...shortT4b, ...shortT5].join(', '));
{ const why = {}; for (const r of Object.values(legacyDropped)) why[r] = (why[r] || 0) + 1; console.log('published designs dropped', Object.keys(legacyDropped).length, JSON.stringify(why)); }
if (process.env.GEN_LEGACY) console.log(Object.entries(legacyDropped).map(([l, r]) => l + ':' + r).join(' '));
if (toBlocks.length) console.log('trap launchers to blocks (a line of block layers)', toBlocks.length + ':', toBlocks.join(', '));
if (ceiled.length) console.log('lowered by the aimed ceiling', ceiled.length + ':', ceiled.join(', '));
// --migrate-dpsf: copy each turned design's factor to its new key in dpsFloor.json (so a fit's `had` is right)
if (argv.includes('--migrate-dpsf') && Object.keys(dpsfMoved).length) {
    const F0 = path.join(__dirname, 'tanks', 'dpsFloor.json'), J = JSON.parse(fs.readFileSync(F0, 'utf8'));
    Object.assign(J.f, dpsfMoved); J.f = Object.fromEntries(Object.entries(J.f).sort());
    fs.writeFileSync(F0, JSON.stringify(J).replace(/,"f":/, ',\n"f":') + '\n');
    console.log('dpsFloor.json: moved', Object.keys(dpsfMoved).length, 'factors to turned designs');
}
if (steered.length) console.log('drone tanks whose drones carry the step over their autos', steered.length + ':', steered.join(', '));
if (refaced.length) console.log('refaced (a barrel facing the wrong way removed, key and name kept)', refaced.length + ':', refaced.join(', '));
if (handDropped.length) console.log('signatures dropped as duplicates:', handDropped.join(', '));
if (process.env.GEN_DEBUG) for (const k of process.env.GEN_DEBUG.split(',')) console.log(k, Object.entries(rejects).filter(([r]) => r.startsWith(k + ' ')).map(([r, n]) => r.slice(k.length + 1) + ':' + n).join(' '));
console.log('wrote', path.relative(REPO, OUT), (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB;', REPORT);
