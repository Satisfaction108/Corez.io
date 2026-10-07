// Neatness checks for tank layouts (scripts/gen-tanks.js and its test)
'use strict';
const rad = Math.PI / 180;
const na = a => { a = ((a % 360) + 360) % 360; return a > 180 ? a - 360 : a; };
const hullR = shape => { const n = Math.abs(shape || 0); return 10 * (n >= 3 ? Math.sqrt((2 * Math.PI / n) / Math.sin(2 * Math.PI / n)) : 1); };
const isStock = t => /drone|minion|chip|summon/i.test(t || '');
const kind = x => !x.typed ? 'x' : isStock(x.type) ? 'd' : /trap|pillbox|box|boomerang|block|assemblent/i.test(x.type || '') ? 't' : /swarm|bee|hive/i.test(x.type || '') ? 's' : 'b';
const tCenter = t => { const d = Math.atan2(t.Y, t.X) + t.a * rad, o = Math.hypot(t.X, t.Y); return [o * Math.cos(d), o * Math.sin(d), o]; };
const armed = t => !!(t.def && (t.def.guns.some(x => x.typed) || t.def.turrets.some(armed)));
const tSig = t => (armed(t) ? 'g' : 'h') + (t.def ? t.def.guns.length + ':' + (t.def.shape || 0) : '');

// ---- symmetry
function parts(f) {
    const P = [];
    for (const x of f.guns) P.push({ g: 1, L: x.L, W: x.W, asp: x.asp, X: x.X, Y: x.Y, a: na(x.a), k: kind(x) });
    for (const t of f.turrets) { const [cx, cy] = tCenter(t); P.push({ g: 0, S: t.S, cx, cy, k: tSig(t), hat: !armed(t) }); }
    return P;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function sameGun(p, q) {
    return p.k === q.k && near(p.L, q.L, Math.max(0.6, 0.04 * p.L)) && near(p.W, q.W, Math.max(0.5, 0.04 * p.W)) && near(p.asp, q.asp, 0.06) &&
        near(p.X, q.X, 0.6) && near(p.Y, q.Y, 0.6) && Math.abs(na(p.a - q.a)) <= 2;
}
const sameTur = (p, q) => p.k === q.k && near(p.S, q.S, 0.6) && Math.hypot(p.cx - q.cx, p.cy - q.cy) <= 0.9;
function mapsOnto(P, tf) {
    const used = new Array(P.length).fill(false);
    for (let i = 0; i < P.length; i++) {
        const m = tf(P[i]); let hit = -1;
        for (let j = 0; j < P.length && hit < 0; j++) if (!used[j] && P[j].g === P[i].g && (P[i].g ? sameGun(m, P[j]) : sameTur(m, P[j]))) hit = j;
        if (hit < 0) return false;
        used[hit] = true;
    }
    return true;
}
const mirror = p => p.g ? { ...p, Y: -p.Y, a: na(-p.a) } : { ...p, cy: -p.cy };
const rotate = th => p => { if (p.g) return { ...p, a: na(p.a + th) }; const c = Math.cos(th * rad), s = Math.sin(th * rad); return { ...p, cx: p.cx * c - p.cy * s, cy: p.cx * s + p.cy * c }; };
function radialOrder(f, P = parts(f)) {
    for (let n = 12; n >= 2; n--) if (mapsOnto(P, rotate(360 / n))) return n;
    return 1;
}
function symmetry(f) {
    const P = parts(f);
    if (mapsOnto(P, mirror)) return 'mirror';
    const n = radialOrder(f, P);
    return n >= 3 ? 'radial' + n : null;
}

// ---- barrel geometry
function shapeOf(x) { const hw = x.W / 2; return { hb: x.asp > 0 ? hw : -hw * x.asp, hm: x.asp > 0 ? hw * x.asp : hw }; }
function inBarrel(px, py, x) {
    const c = Math.cos(x.a * rad), s = Math.sin(x.a * rad), u = px * c + py * s - x.X, v = -px * s + py * c - x.Y;
    if (u < 0 || u > x.L) return false;
    const { hb, hm } = shapeOf(x);
    return Math.abs(v) <= hb + (hm - hb) * u / x.L;
}
// sample points over the visible part of a barrel (outside the body)
function visible(x, R) {
    const c = Math.cos(x.a * rad), s = Math.sin(x.a * rad), out = [], { hb, hm } = shapeOf(x);
    for (let i = 0; i < 16; i++) for (let j = 0; j < 7; j++) {
        const fu = (i + 0.5) / 16, fv = (j - 3) / 3.5, u = x.L * fu, v = fv * (hb + (hm - hb) * fu), gx = x.X + u, gy = x.Y + v;
        const px = gx * c - gy * s, py = gx * s + gy * c;
        if (Math.hypot(px, py) > R + 0.3) out.push([px, py]);
    }
    return out;
}
function overlap(f) {
    const R = hullR(f.shape), G = f.guns, vis = G.map(x => visible(x, R));
    let worst = 0, pair = null;
    for (let i = 0; i < G.length; i++) {
        if (vis[i].length < 6) continue;
        for (let j = i + 1; j < G.length; j++) {          // j is drawn over i
            const A = G[i], Bg = G[j];
            if (Math.abs(na(A.a - Bg.a)) < 1) continue;           // parallel: a stack or a cap
            // a housing drawn over both (a breech block) hides where they meet
            const lid = G.filter((x, k) => !x.typed && k > i && k > j);
            const fr = vis[i].filter(p => inBarrel(p[0], p[1], Bg) && !lid.some(x => inBarrel(p[0], p[1], x))).length / vis[i].length;
            if (fr > worst) { worst = fr; pair = [i, j]; }
        }
    }
    return { worst: +worst.toFixed(3), pair };
}
function turrets(f, tol = 0.6) {
    const R = hullR(f.shape), live = f.turrets.filter(t => !t.prop && armed(t)), out = { off: 0, pile: 0, cover: 0 };
    for (const t of live) {
        const [cx, cy, o] = tCenter(t), r = t.S / 2;
        out.off = Math.max(out.off, o + r - R);
        if (o > 2) for (const x of f.guns) { const pts = visible(x, R); if (pts.some(p => Math.hypot(p[0] - cx, p[1] - cy) < r)) out.cover++; }
    }
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = tCenter(live[i]), b = tCenter(live[j]);
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < (live[i].S + live[j].S) / 2 - 0.2) out.pile++;
    }
    out.off = +Math.max(0, out.off).toFixed(2);
    out.ok = out.off <= tol && !out.pile && !out.cover;
    return out;
}
function stubby(f) {
    const R = hullR(f.shape);
    let worst = Infinity;
    for (const x of f.guns) if (x.typed && kind(x) === 'b') worst = Math.min(worst, (Math.hypot(x.X + x.L, x.Y) - R) / x.W);
    return worst;
}
// coarse bucket: kinds and counts of barrels and turrets, and the body
function layoutSig(f) {
    const n = {}; for (const x of f.guns) if (x.typed) n[kind(x)] = (n[kind(x)] || 0) + 1;
    const live = f.turrets.filter(armed).length, hats = f.turrets.filter(t => !armed(t)).map(t => (t.def ? t.def.shape : 0) + '/' + Math.round(t.S / 3)).sort().join(',');
    return Object.keys(n).sort().map(k => k + n[k]).join('') + '|T' + live + '|H' + hats + '|#' + (f.shape || 0);
}
// what a turret throws (a trap turret is not a gun turret)
const tKind = t => { const g = ((t.def && t.def.guns) || []).filter(x => x.typed); return g.length ? kind(g[0]) : 'x'; };
const tW = t => Math.max(1, ...((t.def && t.def.guns) || []).filter(x => x.typed).map(x => x.W));
const aspC = a => a > 1.15 ? 'c' : a < 0.85 ? 'n' : 'f';
const within = (a, b, r) => Math.max(a, b) <= r * Math.max(1e-6, Math.min(a, b));
// same barrel layout: every barrel matched by kind, direction (6 deg), side of its axis
function sameLayout(fa, fb) {
    if (layoutSig(fa) !== layoutSig(fb)) return false;
    const A = fa.guns.filter(x => x.typed), Bg = fb.guns.filter(x => x.typed), used = new Array(Bg.length).fill(false);
    for (const x of A) {
        let hit = -1;
        for (let j = 0; j < Bg.length && hit < 0; j++) {
            const y = Bg[j];
            if (used[j] || kind(x) !== kind(y) || Math.abs(na(x.a - y.a)) > 6 || aspC(x.asp) !== aspC(y.asp)) continue;
            if (Math.abs(x.Y - y.Y) > Math.max(2, 0.35 * Math.max(x.W, y.W)) || Math.sign(Math.round(x.Y)) !== Math.sign(Math.round(y.Y))) continue;
            if (!within(x.X + x.L, y.X + y.L, 1.15) || !within(x.W, y.W, 1.45)) continue;
            hit = j;
        }
        if (hit < 0) return false;
        used[hit] = true;
    }
    const TA = fa.turrets.filter(armed), TB = fb.turrets.filter(armed), tu = new Array(TB.length).fill(false);
    for (const t of TA) {
        const [ax, ay] = tCenter(t); let hit = -1;
        for (let j = 0; j < TB.length && hit < 0; j++) { const [bx, by] = tCenter(TB[j]); if (!tu[j] && Math.hypot(ax - bx, ay - by) <= 3 && within(t.S, TB[j].S, 1.4) && within(tW(t), tW(TB[j]), 1.25) && tKind(t) === tKind(TB[j])) hit = j; }
        if (hit < 0) return false;
        tu[hit] = true;
    }
    return true;
}
// every barrel, armed turret and shell of `small` is also on `big` (big may add more)
function covers(big, small) {
    const A = small.guns.filter(x => x.typed), Bg = big.guns.filter(x => x.typed), used = new Array(Bg.length).fill(false);
    for (const x of A) {
        let hit = -1;
        for (let j = 0; j < Bg.length && hit < 0; j++) {
            const y = Bg[j];
            if (used[j] || kind(x) !== kind(y) || Math.abs(na(x.a - y.a)) > 6 || aspC(x.asp) !== aspC(y.asp)) continue;
            if (Math.abs(x.Y - y.Y) > Math.max(2, 0.35 * Math.max(x.W, y.W)) || Math.sign(Math.round(x.Y)) !== Math.sign(Math.round(y.Y))) continue;
            if (!within(x.X + x.L, y.X + y.L, 1.15) || !within(x.W, y.W, 1.45)) continue;
            hit = j;
        }
        if (hit < 0) return false;
        used[hit] = true;
    }
    const TB = big.turrets, tu = new Array(TB.length).fill(false);
    for (const t of small.turrets) {
        const [ax, ay] = tCenter(t), ar = armed(t); let hit = -1;
        for (let j = 0; j < TB.length && hit < 0; j++) {
            const u = TB[j]; if (tu[j] || armed(u) !== ar) continue;
            const [bx, by] = tCenter(u);
            if (Math.hypot(ax - bx, ay - by) > 3 || !within(t.S, u.S, ar ? 1.4 : 1.2)) continue;
            if (ar ? !within(tW(t), tW(u), 1.25) || tKind(t) !== tKind(u) : (t.def && t.def.shape) !== (u.def && u.def.shape)) continue;
            hit = j;
        }
        if (hit < 0) return false;
        tu[hit] = true;
    }
    return (small.shape || 0) === (big.shape || 0);
}
const parts2 = f => f.guns.filter(x => x.typed).length + f.turrets.length;
// one design is the other plus a bolt-on (more barrels, turrets or a shell on the same layout)
const boltOn = (a, b) => (parts2(a) > parts2(b) && covers(a, b)) || (parts2(b) > parts2(a) && covers(b, a));
// what a tank throws: typed barrels by kind, armed turrets by what their barrels throw
function kinds(f) {
    const n = { d: 0, t: 0, b: 0, s: 0 };
    for (const x of f.guns) if (x.typed) n[kind(x)]++;
    for (const t of f.turrets) if (armed(t)) { const m = kinds(t.def); const k = ['d', 't', 's', 'b'].find(q => m[q] && m[q] >= Math.max(m.d, m.t, m.b, m.s)) || 'b'; n[k]++; }
    return n;
}
// the main weapon: the kind with the most barrels (drones, traps or guns), 'mix' on a tie
function mainKind(f) {
    const n = kinds(f), c = { d: n.d, t: n.t, b: n.b + n.s }, top = Math.max(c.d, c.t, c.b);
    if (!top) return null;
    const ks = Object.keys(c).filter(k => c[k] === top);
    return ks.length > 1 ? 'mix' : ks[0];
}
const hybrid = f => { const n = kinds(f); return [n.d, n.t, n.b + n.s].filter(Boolean).length >= 2; };
// line identity: a drone tank's children stay drone tanks (drones at least level with
// anything else), a trap tank's stay trap tanks; mixed and gun parents are free
function lineOK(child, parent) {
    const pm = mainKind(parent);
    if (pm !== 'd' && pm !== 't') return true;
    const n = kinds(child), c = { d: n.d, t: n.t, b: n.b + n.s };
    return c[pm] > 0 && c[pm] >= Math.max(c.d, c.t, c.b);
}
// a barrel of the parent's turned into another kind on the child (same direction, other weapon)
function converted(child, parent) {
    const C = child.guns.filter(x => x.typed);
    return parent.guns.some(x => x.typed && !C.some(y => kind(y) === kind(x) && Math.abs(na(x.a - y.a)) <= 10) && C.some(y => kind(y) !== kind(x) && Math.abs(na(x.a - y.a)) <= 10));
}
// barrels that fire nothing: a gun without a real TYPE, or a bare shell with no barrel of its own
// beside it (unless today's tanks wear that exact piece: helix fins, triplex spines)
const decoSig = x => [x.L, x.W, x.asp, x.X, x.Y, x.a].map(v => Math.round(v * 10)).join('/');
function deadGuns(f, { valid = () => true, decos = null } = {}) {
    const out = [];
    f.guns.forEach((x, i) => {
        if (x.typed) { if (!x.type || /^none$/i.test(x.type) || !valid(x)) out.push(i); return; }
        const paired = f.guns.some(y => y.typed && Math.abs(na(x.a - y.a)) <= 20 && Math.abs(x.Y - y.Y) <= Math.max(x.W, y.W) / 2 + 2);
        if (!paired && !(decos && decos.has(decoSig(x)))) out.push(i);
    });
    return out;
}

// ---- barrel grammar: a barrel's shape tells you what it throws (arras/diep)
// bullets: straight (ASPECT 1); a spray gun wears the Machine Gun flare (ASPECT 1.4, mounted
// at the hull edge, sticking out about its own width); a taper (Helix, Stalker) or a
// Machine Gunner nozzle (ASPECT 4, width 4 or less) as today's tanks wear them.
// drones: the short Overseer barrel (ASPECT 1.1 to 1.35, a stub out of the hull).
// swarms: the Cruiser launcher (ASPECT below 1). traps: a short flared cap.
const MG_ASP = [1.4, 1.6], DRONE_ASP = [1.1, 1.35];
const r3 = x => Math.round(x * 1000) / 1000;
const isSpray = (asp, W) => asp > 1 && !(asp >= 3.5 && W <= 4);
const sprayReach = (Y, W, R) => Math.sqrt(Math.max(0, R * R - Y * Y)) + W;
const sprayBase = (Y, W, R) => Math.min(8, Math.max(0, Math.sqrt(Math.max(0, R * R - (Math.abs(Y) + W / 2) ** 2)) - 0.7));
// the look pass, on POSITION objects of bullet barrels (WIDTH never changes, so neither does balance)
function sprayLook(P, R, pairY = false) {
    if (!isSpray(P.ASPECT, P.WIDTH)) return P;
    const asp = Math.min(MG_ASP[1], Math.max(MG_ASP[0], P.ASPECT));
    let Y = P.Y;
    // a side-by-side pair keeps its two mouths apart
    if (pairY && Math.abs(Y) > 0.5 && Math.abs(Y) < P.WIDTH * asp / 2 + 0.3) Y = Math.sign(Y) * r3(P.WIDTH * asp / 2 + 0.3);
    const reach = Math.max(P.X + P.LENGTH, r3(sprayReach(Y, P.WIDTH, R))), X = Math.max(P.X, r3(sprayBase(Y, P.WIDTH, R)));
    return { ...P, ASPECT: asp, Y, X, LENGTH: r3(reach - X) };
}
// mismatches on a flattened tank (empty when every barrel reads right)
function grammar(f) {
    const R = hullR(f.shape), out = [];
    f.guns.forEach((x, i) => {
        if (!x.typed) return;
        const k = kind(x), out1 = Math.hypot(x.X + x.L, x.Y) - R, why = [];
        if (k === 'b' && /^bullet$|casing/i.test(x.type || '')) {
            if (isSpray(x.asp, x.W)) {
                if (x.asp < MG_ASP[0] - 1e-6 || x.asp > MG_ASP[1] + 1e-6) why.push('drone-style flare on a bullet gun');
                else if (out1 < 0.8 * x.W) why.push('stubby flared bullet barrel (reads as a spawner)');
            }
        } else if (k === 'd' && /drone|sunchip|chip/i.test(x.type || '')) {
            if (x.asp < DRONE_ASP[0] - 1e-6 || x.asp > DRONE_ASP[1] + 1e-6) why.push('drone gun not in the drone shape');
        } else if (k === 's' && /swarm/i.test(x.type || '')) {
            if (x.asp >= 1) why.push('swarm launcher flared outward');
        } else if (k === 't' && /trap/i.test(x.type || '')) {
            if (x.asp <= 1 || x.L > 6) why.push('trap launcher without a trap cap');
        }
        if (why.length) out.push(i + ':' + x.type + ' ' + why.join(', '));
    });
    return out;
}
// ---- facing: every barrel points where its tank fights (owner: "Mastodon with a trap on
// backwards doesn't make sense"). A ram hull (smasher) fights with its body, nose first: it
// carries no weapon barrels, only thrusters that push it into the fight (and auto turrets).
// Thrusters (Tri-Angle's recoil guns) push a forward gun at its target, so they need one: on a
// drone, trap or turret-only tank they are recoil vents dressed up as guns.
// -> [{ i, why }] for the barrels that break it (empty when the layout reads right)
const isThruster = x => x.typed && kind(x) === 'b' && Math.abs(na(x.a)) >= 120 && x.ss && x.ss.resist <= 0.75 && x.ss.recoil >= 1.5;
function facing(f) {
    const out = [], typed = f.guns.map((x, i) => [x, i]).filter(([x]) => x.typed);
    if (f.smasher) {
        for (const [x, i] of typed) if (!isThruster(x)) out.push({ i, why: 'ram hull with a ' + ({ t: 'trap launcher', d: 'drone spawner', s: 'swarm launcher', b: 'gun' })[kind(x)] + ' at ' + Math.round(na(x.a)) + ' deg' });
        return out;
    }
    const thr = typed.filter(([x]) => isThruster(x));
    const gunFront = typed.some(([x]) => !isThruster(x) && (kind(x) === 'b' || kind(x) === 's') && Math.abs(na(x.a)) <= 45);
    if (thr.length && !gunFront) for (const [x, i] of thr) out.push({ i, why: 'thruster with no forward gun to push' });
    return out;
}
module.exports = { symmetry, radialOrder, overlap, turrets, stubby, layoutSig, sameLayout, covers, boltOn, kinds, mainKind, hybrid, lineOK, converted, deadGuns, decoSig, hullR, kind, armed, tCenter, na, grammar, sprayLook, facing, isThruster, MG_ASP, DRONE_ASP };
