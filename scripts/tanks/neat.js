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
        for (let j = 0; j < TB.length && hit < 0; j++) { const [bx, by] = tCenter(TB[j]); if (!tu[j] && Math.hypot(ax - bx, ay - by) <= 3 && within(t.S, TB[j].S, 1.4) && within(tW(t), tW(TB[j]), 1.25)) hit = j; }
        if (hit < 0) return false;
        tu[hit] = true;
    }
    return true;
}
module.exports = { symmetry, radialOrder, overlap, turrets, stubby, layoutSig, sameLayout, hullR, kind, armed, tCenter, na };
