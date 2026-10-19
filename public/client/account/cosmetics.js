// Cosmetics drawing: tank skins (paintHull) and name styles (nameFill,
// nameFx), from the shared catalog (window.DWCosmetics). No DOM: app.js
// calls this every frame, so the hot paths allocate nothing.
// Skins: a flat design tile per skin + team colour + size bucket (32..4096
// device px, following the hull on screen
// hull path (same maths as drawBody in app.js). At most one tile is built
// per ~frame; until then the hull reuses another size of the same tile, or
// stays plain.
// Name styles: a small baked colour tile per style, laid over the text box
// as a CanvasPattern whose transform is moved (a reused DOMMatrix), so
// static and scrolling names alike cost no gradient a frame. The outline
// colour (rim) and the glow come from nameFx; strokeHalo draws the glow.
import { config } from '../config.js';

const CAT = () => (typeof window !== 'undefined' && window.DWCosmetics) || null;
const TAU = Math.PI * 2;
const fewerFx = () => !!(config.graphical && config.graphical.fewerEffects);
const glowOff = () => !!(config.graphical && config.graphical.noGlow);

export function byNid(nid) {
    const c = CAT();
    return c && nid ? c.byNid(nid | 0) : null;
}
export function byId(id) {
    const c = CAT();
    return c && id ? c.byId(id) : null;
}
export function nameStyleOf(nid) {
    const it = byNid(nid);
    return it && it.cat === 'nameStyle' && it.style ? it : null;
}
export function skinOf(nid) {
    const it = byNid(nid);
    return it && it.cat === 'skin' && it.skin ? it : null;
}
export const CUSTOM_ID = 'ns_custom';

/* ── colour helpers ─────────────────────────────────────────────────── */
const rgbCache = new Map();
function rgb(hex) {
    let v = rgbCache.get(hex);
    if (v) return v;
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const n = m ? parseInt(m[1], 16) : 0x808080;
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    if (rgbCache.size > 256) rgbCache.clear();
    rgbCache.set(hex, v);
    return v;
}
const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16);
function toHex(r, g, b) {
    return '#' + hex2(Math.max(0, Math.min(255, Math.round(r)))) + hex2(Math.max(0, Math.min(255, Math.round(g)))) + hex2(Math.max(0, Math.min(255, Math.round(b))));
}
export function mix(a, b, t) {
    const x = rgb(a), y = rgb(b);
    return toHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}
function mixRgb(x, y, t) {
    return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
}
function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h * 12) % 12; return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
    return [f(0), f(8), f(4)];
}
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function plainCanvas(w, h) {
    if (typeof document !== 'undefined') {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        return cv;
    }
    return new OffscreenCanvas(w, h);
}

/* ── name styles ────────────────────────────────────────────────────── */
// Is this style animated (so previews keep redrawing)?
export function isAnimatedStyle(it) {
    const s = it && it.style;
    return !!s && (s.kind === 'scroll' || s.kind === 'prism' || !!s.glint || !!s.pulse);
}
// The one colour a style shows when it is too small for a gradient.
export function solidOf(it, fallback) {
    const s = it && it.style;
    if (!s || s.custom || !s.stops || !s.stops.length) return fallback;
    return s.stops[Math.floor(s.stops.length / 2)];
}
// The suffix glyph as drawText colour codes ("§#hex§ ♛"), or the name as is.
export function withGlyph(name, it) {
    const s = it && it.style;
    return s && s.glyph ? name + '§' + (s.glyphColor || '#ffffff') + '§ ' + s.glyph : name;
}

// The fill tile: NT_W x NT_H px. x runs along the name (u, in name widths),
// y down the text box (v, 0 = top of the letters, 1 = bottom), with some
// margin both ways so ascenders and the stroke never sample past an edge.
const NT_W = 128, NT_H = 32;
const BOX = 0.42;               // text box half height, in font sizes
const V0 = -0.3, VSPAN = 1.6;   // the tile's v range
const nameTiles = new Map();    // nid -> { pat, u0, span, speed } | false
const NM = typeof DOMMatrix === 'function' ? new DOMMatrix() : null;

function scrolls(s) { return s.kind === 'scroll' || s.kind === 'prism'; }
function stopAt(st, f) {
    const n = st.length;
    if (n === 1) return rgb(st[0]);
    const x = Math.max(0, Math.min(1, f)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    return mixRgb(rgb(st[i]), rgb(st[i + 1]), x - i);
}
function colorAt(s, u, v) {
    const st = s.stops;
    if (s.kind === 'prism') return hsl(((u % 1) + 1) % 1, s.saturation == null ? 0.85 : s.saturation, s.lightness == null ? 0.7 : s.lightness);
    if (s.kind === 'scroll') return stopAt(st, ((u % 1) + 1) % 1);
    if (s.kind === 'linear') return stopAt(st, u);
    if (s.kind === 'vertical') return stopAt(st, v);
    if (s.kind === 'split') {
        const k = Math.max(0, Math.min(1, (v - 0.5) / 0.04 + 0.5));
        return mixRgb(rgb(st[0]), rgb(st[1] || st[0]), k);
    }
    return rgb(st[0]);
}
function buildNameTile(s) {
    const anim = scrolls(s);
    const u0 = anim ? 0 : -0.2, span = anim ? 1 : 1.4;
    const cv = plainCanvas(NT_W, NT_H);
    const c = cv.getContext('2d');
    const img = c.createImageData(NT_W, NT_H), d = img.data;
    const shade = +s.shade || 0;
    for (let y = 0; y < NT_H; y++) {
        const v = V0 + ((y + 0.5) / NT_H) * VSPAN;
        const vc = Math.max(0, Math.min(1, v));
        for (let x = 0; x < NT_W; x++) {
            const u = u0 + ((x + 0.5) / NT_W) * span;
            let col = colorAt(s, u, v);
            // soft bevel: a touch lighter on top, darker below
            if (shade) col = vc < 0.5 ? mixRgb(col, [255, 255, 255], shade * (0.5 - vc) * 2) : mixRgb(col, [0, 0, 0], shade * (vc - 0.5) * 1.6);
            if (s.glint && anim) {
                const w = Math.max(0, 1 - Math.abs(u - 0.5 * span) / 0.16);
                if (w > 0) col = mixRgb(col, [255, 255, 255], 0.75 * w * w * (3 - 2 * w));
            }
            const i = (y * NT_W + x) * 4;
            d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
        }
    }
    c.putImageData(img, 0, 0);
    const pat = c.createPattern(cv, 'repeat');
    return pat && pat.setTransform ? { pat, u0, span, speed: anim ? (+s.speed || 0.3) : 0 } : false;
}
function nameTile(it) {
    let t = nameTiles.get(it.nid);
    if (t === undefined) {
        try { t = buildNameTile(it.style); } catch (e) { t = false; }
        nameTiles.set(it.nid, t);
    }
    return t;
}

// fill for drawText over [left, left + width] (context units).
// opts: { time (s), still (freeze: low FX), mid (text centre y), fs (font px) }
export function nameFill(context, it, fallback, left, width, opts) {
    const s = it && it.style;
    if (!s || s.custom || !s.stops || !s.stops.length) return fallback;
    if (!(width > 1) || (s.stops.length === 1 && s.kind !== 'prism')) return s.stops[0];
    const tile = NM ? nameTile(it) : false;
    if (!tile) return solidOf(it, fallback);
    const fs = opts && opts.fs > 0 ? opts.fs : width / 4;
    const mid = opts && opts.mid != null ? opts.mid : 0;
    const boxH = 2 * BOX * fs;
    let ex = left + tile.u0 * width;
    if (tile.speed && !(opts && opts.still) && !fewerFx()) {
        const t = opts && opts.time != null ? opts.time : performance.now() / 1000;
        ex += ((t * tile.speed) % tile.span) * width;
    }
    NM.a = (width * tile.span) / NT_W; NM.b = 0; NM.c = 0;
    NM.d = (boxH * VSPAN) / NT_H;
    NM.e = ex;
    NM.f = mid - BOX * fs + V0 * boxH;
    tile.pat.setTransform(NM);
    return tile.pat;
}

// Outline and glow for a style: { rim, halo, haloHi, haloA }. One shared
// object, read it before the next call. The glow goes with No Glow; a pulse
// freezes with Fewer Effects.
const FX = { rim: null, halo: null, haloHi: null, haloA: 1 };
const haloHiOf = new Map();     // halo hex -> its bright core (computed once)
export function nameFx(it, opts) {
    const s = it && it.style;
    FX.rim = (s && s.rim) || null;
    FX.halo = s && s.halo && !glowOff() ? s.halo : null;
    FX.haloA = 1;
    if (FX.halo) {
        let h = haloHiOf.get(FX.halo);
        if (!h) { h = mix(FX.halo, '#ffffff', 0.45); haloHiOf.set(FX.halo, h); }
        FX.haloHi = h;
        if (s.pulse && !(opts && opts.still) && !fewerFx()) {
            const t = opts && opts.time != null ? opts.time : performance.now() / 1000;
            FX.haloA = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * s.pulse * TAU));
        }
    }
    return FX;
}
// The glow under a name's dark outline, drawn before it: [width, alpha,
// bright] over the outline's width. Oct 6 2026 redo (the old single tinted
// ring read as a smeary second outline): a crisp game-style glow, a bright
// core hugging the outline (bright: the halo lifted toward white) fading
// out in two soft steps, ~2-3 device px all told at plate sizes. No blur
// filters: plain strokes, so it bakes into the name sprite and costs the
// same drawn direct (scrolling and pulsing styles).
export const HALO_PASSES = [[2.3, 0.18, 0], [1.95, 0.42, 0], [1.6, 1, 1]];
// Draws those passes: c's lineWidth must be the outline's width.
export function strokeHalo(c, text, x, y, fx) {
    const lw = c.lineWidth, ga = c.globalAlpha;
    for (let i = 0; i < HALO_PASSES.length; i++) {
        const p = HALO_PASSES[i];
        c.strokeStyle = p[2] ? fx.haloHi : fx.halo;
        c.globalAlpha = ga * fx.haloA * p[1];
        c.lineWidth = lw * p[0];
        c.strokeText(text, x, y);
    }
    c.lineWidth = lw;
    c.globalAlpha = ga;
}

// A styled name on a plain canvas (menu previews, the name box and chip):
// drawText's look (bold Rubik, dark rim) when opts.stroke, else flat.
// Returns the width drawn. opts: { align, stroke, time, still, font }
export function drawStyledName(c, name, x, y, px, it, fallback, opts) {
    opts = opts || {};
    const font = opts.font || 'Rubik, Ubuntu';
    c.save();
    c.font = 'bold ' + px + 'px ' + font;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    const s = it && it.style;
    const glyph = s && s.glyph ? ' ' + s.glyph : '';
    const wName = c.measureText(name).width;
    const wGlyph = glyph ? c.measureText(glyph).width : 0;
    const full = wName + wGlyph;
    const a = opts.align === 'center' ? 0.5 : opts.align === 'right' ? 1 : 0;
    const left = x - full * a;
    const fx = nameFx(it, opts);
    if (opts.stroke) {
        c.lineJoin = 'round';
        c.lineCap = 'round';
        const lw = (px + 1) / config.graphical.fontStrokeRatio;
        c.lineWidth = lw;
        if (fx.halo) strokeHalo(c, name + glyph, left, y, fx);
        c.strokeStyle = fx.rim || opts.strokeColor || '#131313';
        c.strokeText(name + glyph, left, y);
    }
    c.fillStyle = px < 8 ? solidOf(it, fallback) : nameFill(c, it, fallback, left, wName, { time: opts.time, still: opts.still, mid: y, fs: px });
    c.fillText(name, left, y);
    if (glyph) {
        c.fillStyle = s.glyphColor || '#ffffff';
        c.fillText(glyph, left + wName, y);
    }
    c.restore();
    return full;
}

/* ── skins: hull path (mirrors drawBody) ────────────────────────────── */
const path2d = new Map();
function customPath(str) {
    let p = path2d.get(str);
    if (p === undefined) {
        try { p = new Path2D(str); } catch (e) { p = null; }
        if (path2d.size > 64) path2d.clear();
        path2d.set(str, p);
    }
    return p;
}
// Can this hull take a skin at all?
export function skinnable(shape) {
    if (typeof shape === 'string') return !(shape.startsWith('image=') || shape.startsWith('3d=') || shape.startsWith('4d=')) && !!customPath(shape);
    return typeof shape === 'number' || Array.isArray(shape);
}
// Builds the hull path. For a Path2D shape it clips / strokes itself
// (mode 'clip' | 'stroke'), since that path lives in a scaled space.
function hullPath(c, x, y, r, sides, angle, mode) {
    if (typeof sides === 'string') {
        const p = customPath(sides);
        if (!p) return;
        c.translate(x, y);
        c.scale(r, r);
        c.rotate(angle);
        if (mode === 'clip') c.clip(p);
        else { c.lineWidth /= r; c.stroke(p); }
        return;
    }
    c.beginPath();
    if (Array.isArray(sides)) {
        const dx = Math.cos(angle), dy = Math.sin(angle);
        for (let i = 0; i < sides.length; i++) {
            const px = sides[i][0], py = sides[i][1];
            c.lineTo(x + r * (px * dx - py * dy), y + r * (py * dx + px * dy));
        }
    } else {
        if (sides) angle += sides % 2 ? 0 : Math.PI / sides;
        if (!sides) {
            c.arc(x, y, r, 0, TAU);
        } else if (sides < 0) {
            sides = -sides;
            angle += (sides % 1) * TAU;
            sides = Math.floor(sides);
            const dip = 1 - 6 / (sides * sides);
            c.moveTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
            for (let i = 0; i < sides; i++) {
                const ht = ((i + 0.5) / sides) * TAU + angle, th = ((i + 1) / sides) * TAU + angle;
                const cx = x + r * dip * Math.cos(ht), cy = y + r * dip * Math.sin(ht);
                const px = x + r * Math.cos(th), py = y + r * Math.sin(th);
                if (config.graphical.curvyTraps) c.quadraticCurveTo(cx, cy, px, py);
                else { c.lineTo(cx, cy); c.lineTo(px, py); }
            }
        } else {
            angle += (sides % 1) * TAU;
            sides = Math.floor(sides);
            for (let i = 0; i < sides; i++) {
                const th = (i / sides) * TAU + angle;
                c.lineTo(x + r * Math.cos(th), y + r * Math.sin(th));
            }
        }
    }
    c.closePath();
    if (mode === 'clip') c.clip();
    else c.stroke();
}

/* ── skins: drawing kit (hull space, radius 1 = the hull edge) ──────── */
const E = 1.25;
const OW = 0.1;

const pol = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];
function poly(c, pts) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
}
function ring(n, r, rot) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(pol(r, (rot || 0) + (i / n) * TAU));
    return pts;
}
function paint(c, fill, edge, w) {
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (edge) { c.lineWidth = w || OW; c.strokeStyle = edge; c.stroke(); }
}
function disc(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); }
function annulus(c, r0, r1) {
    c.beginPath();
    c.arc(0, 0, r1, 0, TAU);
    c.moveTo(r0, 0);
    c.arc(0, 0, r0, 0, TAU, true);
}
function line(c, pts, w, col) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.lineWidth = w;
    c.strokeStyle = col;
    c.stroke();
}
function bands(c, list, fill, edge) {
    for (const [pts, w] of list) line(c, pts, w + 2 * OW, edge);
    for (const [pts, w] of list) line(c, pts, w, fill);
}
function star(c, n, r0, r1, rot) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) pts.push(pol(i & 1 ? r0 : r1, rot + (i * Math.PI) / n));
    poly(c, pts);
}
function blob(c, rnd, x, y, r) {
    const n = 8, pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU, rr = r * (0.9 + 0.16 * rnd());
        pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
    }
    c.beginPath();
    for (let i = 0; i <= n; i++) {
        const p = pts[i % n], q = pts[(i + 1) % n];
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        if (i === 0) c.moveTo(mx, my); else c.quadraticCurveTo(p[0], p[1], mx, my);
    }
    c.closePath();
}
function wave(c, yc, h, amp, fr, ph) {
    c.beginPath();
    for (let x = -1.4; x <= 1.41; x += 0.05) c.lineTo(x, yc - h + amp * Math.cos(fr * x + ph));
    for (let x = 1.4; x >= -1.41; x -= 0.05) c.lineTo(x, yc + h + amp * Math.cos(fr * x + ph));
    c.closePath();
}
const BOLT = [[0.1, -1], [-0.35, 0.1], [-0.02, 0.1], [-0.15, 1], [0.35, -0.15], [0.02, -0.15], [0.25, -1]];
function bolt(c, k, rot) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    poly(c, BOLT.map(([x, y]) => [(x * cs - y * sn) * k, (x * sn + y * cs) * k]));
}
function spiralArm(k, arms, turn, r0) {
    const pts = [], start = r0 == null ? 0.15 : r0;
    for (let i = 0; i <= 36; i++) {
        const f = i / 36, a = (k / arms) * TAU + f * turn, r = start + f * (1.4 - start);
        pts.push(pol(r, a));
    }
    return pts;
}
function swatch(hex) {
    return { f: hex, d: mix(hex, '#000000', 0.18), l: mix(hex, '#ffffff', 0.45), k: mix(hex, '#000000', 0.34) };
}
const WHITE_SW = swatch('#f2f2f2');
function paletteFor(it, teamHex) {
    const C = CAT();
    const cs = C && C.skinColors ? C.skinColors(it, teamHex) : [];
    const a = swatch(cs[0] || '#f2f2f2');
    const b = cs[1] ? swatch(cs[1]) : swatch(a.d);
    const c = cs[2] ? swatch(cs[2]) : b;
    return { T: teamHex, a, b, c, spark: (cs.length > 1 ? b : a).l };
}
const fl = (c, X, w) => paint(c, X.f, X.k, w);
const fd = (c, X, w) => paint(c, X.d, X.k, w);
const lit = (c, X, w) => paint(c, X.l, X.k, w);
function studs(c, X, n, rr, sz, rot) {
    for (let i = 0; i < n; i++) {
        const p = pol(rr, (rot || 0) + (i / n) * TAU);
        disc(c, p[0], p[1], sz);
        fl(c, X, OW * 0.8);
    }
}
function hexagon(c, x, y, r, rot) {
    poly(c, ring(6, r, rot).map(([px, py]) => [x + px, y + py]));
}
function heartPath(c, k) {
    c.beginPath();
    c.moveTo(0, 0.32 * k);
    c.bezierCurveTo(-0.62 * k, -0.08 * k, -0.42 * k, -0.62 * k, 0, -0.3 * k);
    c.bezierCurveTo(0.42 * k, -0.62 * k, 0.62 * k, -0.08 * k, 0, 0.32 * k);
    c.closePath();
}
function diamond(c, x, y, k, a) {
    const cs = Math.cos(a), sn = Math.sin(a), q = (px, py) => [x + px * cs - py * sn, y + px * sn + py * cs];
    poly(c, [q(0, -k), q(k * 0.55, 0), q(0, k * 0.75), q(-k * 0.55, 0)]);
}
function facetLines(c, n, r, R, rot, col) {
    c.beginPath();
    for (let i = 0; i < n; i++) { const p = pol(r, rot + (i / n) * TAU), q = pol(R, rot + (i / n) * TAU); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); }
    c.lineWidth = OW * 0.7; c.strokeStyle = col; c.stroke();
}
function spun(c, n, rot, fn) {
    for (let i = 0; i < n; i++) { c.save(); c.rotate((rot || 0) + (i / n) * TAU); fn(i); c.restore(); }
}
function stripeSet(c, h) {
    c.beginPath();
    for (let k = -6; k <= 6; k++) {
        const x = k * 0.56;
        c.moveTo(x - 0.13 + 0.25, -h - 0.1); c.lineTo(x + 0.13 + 0.25, -h - 0.1);
        c.lineTo(x + 0.13 - 0.25, h + 0.1); c.lineTo(x - 0.13 - 0.25, h + 0.1); c.closePath();
    }
}
function sector(c, r0, r1, a0, a1) {
    c.beginPath();
    c.arc(0, 0, r1, a0, a1);
    if (r0 > 0) c.arc(0, 0, r0, a1, a0, true); else c.lineTo(0, 0);
    c.closePath();
}
function crackPts(a) {
    return [pol(0.24, a), pol(0.46, a + 0.2), pol(0.66, a - 0.1), pol(0.86, a + 0.12), pol(1.3, a - 0.04)];
}
function veinArms(a) {
    const fork = pol(0.5, a);
    return [[pol(0.16, a), fork], [fork, pol(0.78, a - 0.3), pol(1.3, a - 0.42)], [fork, pol(0.78, a + 0.3), pol(1.3, a + 0.42)]];
}
const VEINS = [0, 1, 2].map(i => veinArms((i / 3) * TAU + Math.PI / 3));
function chip(c, k) {
    c.beginPath();
    c.roundRect ? c.roundRect(-k, -k, 2 * k, 2 * k, k * 0.22) : c.rect(-k, -k, 2 * k, 2 * k);
}
function circuitTraces() {
    const out = [];
    for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU, cs = Math.cos(a), sn = Math.sin(a), q = (u, v) => [u * cs - v * sn, u * sn + v * cs];
        for (const s of [-1, 1]) out.push([q(0.28, s * 0.14), q(0.5, s * 0.14), q(0.66, s * 0.32)]);
    }
    return out;
}
const TRACES = circuitTraces();
function fluteEdge(base, f, lead) {
    return pol(0.14 + f * 1.2, base + (lead ? 0 : 0.95) + f * 1.25);
}
function flute(c, base) {
    c.beginPath();
    for (let i = 0; i <= 24; i++) { const p = fluteEdge(base, i / 24, true); if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); }
    for (let i = 24; i >= 0; i--) { const p = fluteEdge(base, i / 24, false); c.lineTo(p[0], p[1]); }
    c.closePath();
}
function wisp(c, base) {
    const n = 28, left = [], right = [];
    for (let i = 0; i <= n; i++) {
        const f = i / n, a = base + f * 2.3, r = 0.16 + f * 0.95;
        const w = 0.3 * Math.pow(1 - f, 0.6) + 0.02;
        const p = pol(r, a), d = pol(1, a + Math.PI / 2 - 0.5);
        left.push([p[0] + d[0] * w, p[1] + d[1] * w]);
        right.push([p[0] - d[0] * w, p[1] - d[1] * w]);
    }
    poly(c, left.concat(right.reverse()));
}
function wispSpine(base) {
    const pts = [];
    for (let i = 0; i <= 20; i++) { const f = i / 20 * 0.8; pts.push(pol(0.16 + f * 0.95, base + f * 2.3)); }
    return pts;
}
function cloudPath(c) {
    c.beginPath();
    for (let i = 0; i < 10; i++) {
        const p = pol(0.64, (i / 10) * TAU + (i & 1 ? 0.04 : 0)), r = i & 1 ? 0.17 : 0.21;
        c.moveTo(p[0] + r, p[1]);
        c.arc(p[0], p[1], r, 0, TAU);
    }
    c.moveTo(0.74, 0);
    c.arc(0, 0, 0.74, 0, TAU);
    c.moveTo(0.54, 0);
    c.arc(0, 0, 0.54, 0, TAU, true);
}
function cloudRing(c, X) {
    cloudPath(c); c.lineWidth = OW * 2; c.strokeStyle = X.k; c.stroke();
    cloudPath(c); c.fillStyle = X.f; c.fill();
}
function wavyRing(c, r0, r1, n, amp, ph) {
    c.beginPath();
    for (let i = 0; i <= 96; i++) { const a = (i / 96) * TAU, r = r1 + amp * Math.sin(n * a + ph); c.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    c.closePath();
    if (r0 > 0) {
        for (let i = 0; i <= 96; i++) { const a = -(i / 96) * TAU, r = r0 + amp * Math.sin(n * a + ph); if (i) c.lineTo(Math.cos(a) * r, Math.sin(a) * r); else c.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
        c.closePath();
    }
}
const AURORA = [[0.66, 0.9], [0.4, 0.56], [0, 0.3]];
function prismCells(c, i, outer) {
    const a0 = (i / 6) * TAU - Math.PI / 6, a1 = ((i + 1) / 6) * TAU - Math.PI / 6;
    if (outer) poly(c, [pol(0.6, a0), pol(0.94, a0), pol(0.94, a1), pol(0.6, a1)]);
    else poly(c, [pol(0.24, a0), pol(0.6, a0), pol(0.6, a1), pol(0.24, a1)]);
}
function toothRing(c, n, r0, r1, rot) {
    c.beginPath();
    for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * TAU, w = TAU / n * 0.36, tip = i & 1 ? r0 + 0.08 : r0;
        const p = pol(r1, a - w), q = pol(tip, a), s = pol(r1, a + w);
        c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.lineTo(s[0], s[1]); c.closePath();
    }
}
function tigerStripes(c) {
    c.beginPath();
    for (const sg of [-1, 1]) {
        for (let k = -2; k <= 2; k++) {
            const x = k * 0.42 + (sg > 0 ? 0.21 : 0), tip = sg * ((k & 1) ? 0.36 : 0.16), base = sg * 1.15, w = 0.16, bend = 0.12;
            c.moveTo(x - w, base);
            c.quadraticCurveTo(x - w * 0.6 + bend, (base + tip) / 2, x + bend * 1.4, tip);
            c.quadraticCurveTo(x + w * 0.9 + bend, (base + tip) / 2, x + w, base);
            c.closePath();
        }
    }
}
function pinBlade(c, a) {
    const p = pol(0.96, a), q = pol(0.96, a + 1.05), k = pol(0.42, a + 1.25);
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(p[0], p[1]);
    c.arc(0, 0, 0.96, a, a + 1.05);
    c.quadraticCurveTo(k[0], k[1], 0, 0);
    c.closePath();
}
function chevron(c, x) {
    poly(c, [[x - 0.4, -0.62], [x - 0.12, -0.62], [x + 0.2, 0], [x - 0.12, 0.62], [x - 0.4, 0.62], [x - 0.08, 0]]);
}
function camoBlobs(c, P, seed, big) {
    spun(c, 3, 0, () => {
        const rnd = mulberry32(seed);
        if (big) { blob(c, rnd, 0.56, 0, 0.34); fl(c, P.a); }
        else { c.rotate(Math.PI / 3); blob(c, rnd, 0.68, 0, 0.24); fl(c, P.b); }
    });
}

const PAINT = {
    stripes(c, P, s) {
        c.rotate(((s.angle == null ? 90 : s.angle) * Math.PI) / 180);
        const h = 0.42;
        c.beginPath(); c.rect(-3, -h, 6, 2 * h); paint(c, P.a.f, null);
        c.save(); c.clip(); stripeSet(c, h); paint(c, P.b.f, null); c.restore();
        c.beginPath(); c.rect(-3, -h, 6, 2 * h); paint(c, null, P.b.f, OW * 1.2);
    },
    rim(c, P, s) {
        annulus(c, 0.5, 0.86); fl(c, P.a);
        studs(c, P.b, s.rivets || 8, 0.68, 0.075, Math.PI / (s.rivets || 8));
        disc(c, 0, 0, 0.27); fl(c, P.a);
        c.beginPath(); c.rect(-0.17, -0.045, 0.34, 0.09); paint(c, P.a.k, null);
    },
    racer(c, P) {
        c.beginPath(); c.rect(-3, -0.44, 6, 0.24); c.rect(-3, 0.2, 6, 0.24); fl(c, P.a);
        c.beginPath(); c.rect(-3, -0.07, 6, 0.14); fl(c, P.b, OW * 0.8);
    },
    halves(c, P) {
        c.beginPath(); c.rect(-3, -0.34, 6, 0.34); paint(c, P.a.f, null);
        c.beginPath(); c.rect(-3, 0, 6, 0.34); paint(c, P.b.f, null);
        c.beginPath(); c.rect(-3, -0.34, 6, 0.68); paint(c, null, P.b.k);
        c.beginPath(); c.arc(0, 0, 0.3, Math.PI, TAU); c.closePath(); paint(c, P.b.f, null);
        c.beginPath(); c.arc(0, 0, 0.3, 0, Math.PI); c.closePath(); paint(c, P.a.f, null);
        disc(c, 0, 0, 0.3); paint(c, null, P.b.k);
    },
    rings(c, P) {
        annulus(c, 0.6, 0.86); fl(c, P.a);
        annulus(c, 0.3, 0.48); fl(c, P.b);
        disc(c, 0, 0, 0.16); fl(c, P.a);
    },
    dots(c, P) {
        c.beginPath();
        c.moveTo(0.2, 0); c.arc(0, 0, 0.2, 0, TAU);
        for (let i = 0; i < 6; i++) { const p = pol(0.6, (i / 6) * TAU); c.moveTo(p[0] + 0.16, p[1]); c.arc(p[0], p[1], 0.16, 0, TAU); }
        fl(c, P.a);
    },
    checker(c, P) {
        const cs = 0.3;
        c.beginPath();
        for (let j = -1; j < 1; j++) for (let i = -8; i < 8; i++) if ((i + j) & 1) c.rect(i * cs, j * cs, cs, cs);
        paint(c, P.a.f, null);
        c.beginPath();
        for (let j = -1; j < 1; j++) for (let i = -8; i < 8; i++) if (!((i + j) & 1)) c.rect(i * cs, j * cs, cs, cs);
        paint(c, P.b.f, null);
        c.beginPath(); c.rect(-3, -cs, 6, 2 * cs); paint(c, null, P.b.k);
    },
    core(c, P) {
        disc(c, 0, 0, 0.2); fl(c, P.a);
        for (let i = 0; i < 4; i++) { const p = pol(0.6, (i / 4) * TAU + Math.PI / 4); disc(c, p[0], p[1], 0.17); fl(c, P.a); }
    },
    sash(c, P, s) {
        c.rotate(((s.angle == null ? -35 : s.angle) * Math.PI) / 180);
        c.beginPath(); c.rect(-3, -0.24, 6, 0.48); fl(c, P.a);
        c.beginPath(); c.rect(-3, -0.03, 6, 0.06); paint(c, P.b.f, null);
        disc(c, 0, 0, 0.32); fl(c, P.b);
        star(c, 5, 0.1, 0.22, -Math.PI / 2); fd(c, P.b, OW * 0.7);
    },
    pumpkin(c, P) {
        c.save(); c.rotate(Math.PI / 2);
        const face = (pts) => { poly(c, pts); paint(c, P.b.f, P.a.f, OW * 1.2); };
        face([[-0.52, -0.08], [-0.3, -0.48], [-0.08, -0.08]]);
        face([[0.08, -0.08], [0.3, -0.48], [0.52, -0.08]]);
        face([[-0.6, 0.12], [-0.42, 0.26], [-0.26, 0.14], [-0.1, 0.3], [0.1, 0.3], [0.26, 0.14], [0.42, 0.26], [0.6, 0.12], [0.42, 0.5], [0, 0.62], [-0.42, 0.5]]);
        c.restore();
    },
    camo(c, P, s) {
        camoBlobs(c, P, s.seed | 0, true);
        camoBlobs(c, P, (s.seed | 0) + 9, false);
        disc(c, 0, 0, 0.18); fl(c, P.b);
    },
    strata(c, P) {
        const Y = [-0.56, 0, 0.56];
        for (let i = 0; i < 3; i++) { wave(c, Y[i], 0.15, 0.07, 3, 0); fl(c, i === 1 ? P.b : P.a); }
    },
    hex(c, P) {
        const R = 0.29, d = R * Math.sqrt(3) * 1.04;
        for (let i = 0; i < 6; i++) { const p = pol(d, (i / 6) * TAU + Math.PI / 6); hexagon(c, p[0], p[1], R * 0.92, Math.PI / 6); fl(c, P.a, OW * 0.8); }
        hexagon(c, 0, 0, R * 0.92, Math.PI / 6); fl(c, P.b, OW * 0.8);
        hexagon(c, 0, 0, R * 0.42, Math.PI / 6); paint(c, P.b.l, null);
    },
    chevrons(c, P) {
        c.lineJoin = 'miter';
        chevron(c, -0.26); fl(c, P.a);
        chevron(c, 0.16); fl(c, P.b);
        chevron(c, 0.58); fl(c, P.a);
        c.lineJoin = 'round';
    },
    trim(c, P, s) {
        spun(c, 4, Math.PI / 4, () => { c.beginPath(); c.rect(0.6, -0.14, 0.4, 0.28); fd(c, P.a); });
        annulus(c, 0.68, 0.88); fl(c, P.a);
        studs(c, P.a, s.rivets || 6, 0.78, 0.05, 0);
        disc(c, 0, 0, 0.3); fl(c, P.a);
        disc(c, 0, 0, 0.13); fd(c, P.a);
    },
    sunburst(c, P) {
        star(c, 10, 0.4, 1.02, 0); fl(c, P.a);
        disc(c, 0, 0, 0.36); fl(c, P.b);
        disc(c, 0, 0, 0.16); fl(c, P.a);
    },
    quarters(c, P) {
        c.rotate(Math.PI / 4);
        sector(c, 0, 0.66, 0, Math.PI / 2); fl(c, P.a);
        sector(c, 0, 0.66, Math.PI, Math.PI * 1.5); fl(c, P.a);
        annulus(c, 0.66, 0.84); fl(c, P.a);
        disc(c, 0, 0, 0.14); fl(c, P.a);
    },
    pinwheel(c, P) {
        for (let i = 0; i < 4; i++) { pinBlade(c, (i / 4) * TAU); fl(c, i & 1 ? P.b : P.a); }
        disc(c, 0, 0, 0.2); fl(c, P.c);
        disc(c, 0, 0, 0.07); fd(c, P.c, OW * 0.6);
    },
    tiger(c, P) {
        tigerStripes(c); paint(c, P.b.f, P.a.f, OW * 0.9);
    },
    circuit(c, P) {
        bands(c, TRACES.map(p => [p, 0.09]), P.a.f, P.a.k);
        for (const p of TRACES) { disc(c, p[2][0], p[2][1], 0.1); fl(c, P.b, OW * 0.8); }
        chip(c, 0.3); fl(c, P.c);
        chip(c, 0.13); fl(c, P.b, OW * 0.7);
    },
    facets(c, P) {
        for (let i = 0; i < 8; i++) { diamond(c, ...pol(0.82, (i / 8) * TAU), 0.13, (i / 8) * TAU + Math.PI / 2); fl(c, P.a, OW * 0.7); }
        const n = 8, R = 0.62, r = 0.3, rot = Math.PI / 8;
        poly(c, ring(n, R, rot)); fl(c, P.a);
        poly(c, ring(n, r, rot)); paint(c, P.a.l, null);
        facetLines(c, n, r, R, rot, P.a.k);
        poly(c, ring(n, r, rot)); paint(c, null, P.a.k, OW * 0.7);
    },
    vein(c, P) {
        for (const arm of VEINS) bands(c, arm.map(p => [p, 0.14]), P.a.f, P.a.k);
        for (const arm of VEINS) for (const p of arm) line(c, p, 0.045, P.a.l);
        for (const arm of VEINS) { disc(c, arm[0][1][0], arm[0][1][1], 0.13); fl(c, P.a); }
        disc(c, 0, 0, 0.24); fl(c, P.a);
        disc(c, 0, 0, 0.1); paint(c, P.a.l, null);
    },
    gem(c, P) {
        annulus(c, 0.72, 0.9); fl(c, P.a);
        studs(c, WHITE_SW, 6, 0.81, 0.045, 0);
        const R = 0.56, r = 0.26, rot = Math.PI / 6;
        hexagon(c, 0, 0, R, rot); fl(c, P.a);
        hexagon(c, 0, 0, r, rot); paint(c, P.a.l, null);
        facetLines(c, 6, r, R, rot, P.a.k);
        hexagon(c, 0, 0, r, rot); paint(c, null, P.a.k, OW * 0.7);
    },
    geode(c, P) {
        annulus(c, 0.68, 0.92); fl(c, P.b);
        toothRing(c, 12, 0.36, 0.7, 0); fl(c, P.a, OW * 0.8);
        diamond(c, 0, 0, 0.22, 0); fl(c, P.a, OW * 0.8);
    },
    bolt(c, P) {
        annulus(c, 0.62, 0.9); fl(c, P.b);
        bolt(c, 0.84, 0.3); fl(c, P.a);
    },
    spiral(c, P, s) {
        const arms = s.arms || 2, w = arms > 3 ? 0.15 : 0.2, list = [];
        for (let k = 0; k < arms; k++) list.push([spiralArm(k, arms, 3.4, 0.24), w]);
        bands(c, list, P.a.f, P.a.k);
        for (const [pts] of list) line(c, pts, w * 0.32, P.b.f);
        annulus(c, 0.14, 0.3); fl(c, P.b);
    },
    molten(c, P, s) {
        const arms = s.arms || 3, list = [];
        for (let k = 0; k < arms; k++) list.push([spiralArm(k, arms, 3.0), 0.22]);
        bands(c, list, P.a.f, P.a.k);
        for (const [pts] of list) line(c, pts, 0.07, P.b.f);
        disc(c, 0, 0, 0.32); fl(c, P.b);
        disc(c, 0, 0, 0.13); fl(c, P.a);
    },
    crosshair(c, P) {
        spun(c, 4, 0, () => { c.beginPath(); c.rect(0.24, -0.09, 0.82, 0.18); fl(c, P.a, OW * 0.8); });
        annulus(c, 0.5, 0.7); fl(c, P.a);
        spun(c, 4, Math.PI / 4, () => { disc(c, 0.6, 0, 0.06); paint(c, P.b.f, null); });
        disc(c, 0, 0, 0.15); fl(c, P.b);
    },
    vault(c, P) {
        annulus(c, 0.68, 0.88); fl(c, P.a);
        studs(c, P.b, 8, 0.78, 0.055, Math.PI / 8);
        spun(c, 3, -Math.PI / 2, () => { c.beginPath(); c.rect(0, -0.09, 0.68, 0.18); fl(c, P.a, OW * 0.8); disc(c, 0.62, 0, 0.11); fl(c, P.b, OW * 0.8); });
        disc(c, 0, 0, 0.26); fl(c, P.b);
        disc(c, 0, 0, 0.1); fd(c, P.b);
    },
    cracks(c, P) {
        const seams = [];
        for (let i = 0; i < 6; i++) seams.push(crackPts((i / 6) * TAU));
        for (const p of seams) line(c, p, 0.14 + 2 * OW, P.a.k);
        for (const p of seams) line(c, p, 0.14, P.a.f);
        for (const p of seams) line(c, p, 0.05, P.b.f);
        disc(c, 0, 0, 0.3); fl(c, P.a);
        disc(c, 0, 0, 0.14); fl(c, P.b);
    },
    frost(c, P) {
        const arms = [];
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * TAU, cs = Math.cos(a), sn = Math.sin(a), q = (u, v) => [u * cs - v * sn, u * sn + v * cs];
            arms.push([[q(0.2, 0), q(0.9, 0)], 0.13], [[q(0.44, 0), q(0.62, 0.2)], 0.1], [[q(0.44, 0), q(0.62, -0.2)], 0.1], [[q(0.66, 0), q(0.8, 0.14)], 0.08], [[q(0.66, 0), q(0.8, -0.14)], 0.08]);
        }
        bands(c, arms, P.a.f, P.a.k);
        hexagon(c, 0, 0, 0.28, 0); fl(c, P.b);
        hexagon(c, 0, 0, 0.12, 0); paint(c, P.a.f, null);
    },
    drill(c, P) {
        for (let i = 0; i < 3; i++) { flute(c, (i / 3) * TAU); fl(c, P.a); }
        annulus(c, 0.8, 0.96); fl(c, P.a);
        studs(c, P.b, 6, 0.88, 0.045, 0.3);
        for (let i = 0; i < 3; i++) { const pts = []; for (let j = 0; j <= 20; j++) pts.push(fluteEdge((i / 3) * TAU + 0.12, j / 20, true)); line(c, pts, 0.06, P.a.l); }
        hexagon(c, 0, 0, 0.27, 0); fl(c, P.b);
        hexagon(c, 0, 0, 0.11, 0); fd(c, P.b, OW * 0.7);
    },
    druse(c, P) {
        annulus(c, 0.64, 0.94); fl(c, P.a);
        toothRing(c, 14, 0.3, 0.66, 0); fl(c, P.b, OW * 0.8);
        studs(c, P.a, 7, 0.79, 0.05, 0.2);
        hexagon(c, 0, 0, 0.14, 0); fl(c, P.b, OW * 0.8);
    },
    shards(c, P) {
        for (let k = 0; k < 3; k++) { wisp(c, (k / 3) * TAU); fl(c, P.a); }
        for (let k = 0; k < 3; k++) line(c, wispSpine((k / 3) * TAU), 0.06, P.b.f);
        disc(c, 0, 0, 0.24); fl(c, P.b);
        disc(c, 0, 0, 0.1); paint(c, P.a.f, null);
    },
    storm(c, P) {
        cloudRing(c, P.a);
        bolt(c, 0.56, 0.3); fl(c, P.b);
    },
    gilded(c, P) {
        annulus(c, 0.68, 0.88); fl(c, P.a);
        studs(c, P.b, 8, 0.78, 0.06, 0);
        star(c, 5, 0.26, 0.58, -Math.PI / 2); fl(c, P.a);
        disc(c, 0, 0, 0.12); fl(c, P.b, OW * 0.7);
    },
    heart(c, P) {
        annulus(c, 0.7, 0.9); fl(c, P.b);
        studs(c, P.a, 8, 0.8, 0.055, Math.PI / 8);
        c.save(); c.rotate(Math.PI / 2); heartPath(c, 1.08); fl(c, P.a);
        heartPath(c, 0.5); fd(c, P.a, OW * 0.7); c.restore();
    },
    aurora(c, P) {
        const cols = [P.a, P.b, P.c];
        for (let i = 0; i < 3; i++) { wavyRing(c, AURORA[i][0], AURORA[i][1], 6, 0.035, i * 0.9); fl(c, cols[i]); }
    },
    prism(c, P) {
        const cols = [P.a, P.b, P.c];
        for (let i = 0; i < 6; i++) { prismCells(c, i, true); fl(c, cols[(i + 1) % 3], OW * 0.8); }
        for (let i = 0; i < 6; i++) { prismCells(c, i, false); fl(c, cols[i % 3], OW * 0.8); }
        hexagon(c, 0, 0, 0.24, Math.PI / 6); fl(c, WHITE_SW, OW * 0.8);
    },
    nova(c, P) {
        star(c, 8, 0.5, 0.98, Math.PI / 8); fl(c, P.b);
        star(c, 8, 0.3, 0.7, 0); fl(c, P.a);
        disc(c, 0, 0, 0.18); fl(c, WHITE_SW, OW * 0.8);
    },
    void(c, P) {
        const list = [];
        for (let k = 0; k < 4; k++) list.push([spiralArm(k, 4, 2.6, 0.44), 0.13]);
        bands(c, list, P.b.f, P.b.k);
        for (const [pts] of list) line(c, pts, 0.045, P.c.f);
        disc(c, 0, 0, 0.46); fl(c, P.c);
        disc(c, 0, 0, 0.34); fl(c, P.a);
    },
};
const LIT = {
    circuit(g, P) {
        for (const p of TRACES) line(g, p, 0.05, P.a.l);
        for (const p of TRACES) { disc(g, p[2][0], p[2][1], 0.1); lit(g, P.b, OW * 0.8); }
        chip(g, 0.13); lit(g, P.b, OW * 0.7);
    },
    vein(g, P) {
        for (const arm of VEINS) for (const p of arm) line(g, p, 0.07, P.a.l);
        for (const arm of VEINS) { disc(g, arm[0][1][0], arm[0][1][1], 0.13); lit(g, P.a); }
        disc(g, 0, 0, 0.24); lit(g, P.a);
    },
    bolt(g, P) {
        bolt(g, 0.84, 0.3); lit(g, P.a);
    },
    cracks(g, P) {
        for (let i = 0; i < 6; i++) line(g, crackPts((i / 6) * TAU), 0.08, P.b.l);
        disc(g, 0, 0, 0.14); paint(g, P.b.l, null);
    },
    shards(g, P) {
        for (let k = 0; k < 3; k++) { wisp(g, (k / 3) * TAU); lit(g, P.a); }
        disc(g, 0, 0, 0.24); lit(g, P.b);
    },
    storm(g, P) {
        bolt(g, 0.56, 0.3); lit(g, P.b);
    },
    gilded(g, P) {
        star(g, 5, 0.26, 0.58, -Math.PI / 2); lit(g, P.a);
    },
    heart(g, P) {
        g.rotate(Math.PI / 2); heartPath(g, 1.08); lit(g, P.a);
        heartPath(g, 0.5); paint(g, P.a.f, P.a.k, OW * 0.7);
    },
    molten(g, P, s) {
        const arms = s.arms || 3;
        for (let k = 0; k < arms; k++) line(g, spiralArm(k, arms, 3.0), 0.07, P.b.l);
        disc(g, 0, 0, 0.32); lit(g, P.b);
    },
    aurora(g, P, s, alt) {
        const cols = alt ? [P.b, P.c, P.a] : [P.a, P.b, P.c];
        for (let i = 0; i < 3; i++) { wavyRing(g, AURORA[i][0], AURORA[i][1], 6, 0.035, i * 0.9); paint(g, alt ? cols[i].f : cols[i].l, cols[i].k); }
    },
    prism(g, P) {
        const cols = [P.a, P.b, P.c];
        for (let i = 0; i < 6; i++) { prismCells(g, i, false); lit(g, cols[i % 3], OW * 0.8); }
        hexagon(g, 0, 0, 0.24, Math.PI / 6); paint(g, '#ffffff', WHITE_SW.k, OW * 0.8);
    },
    nova(g, P) {
        star(g, 8, 0.28, 0.66, 0); lit(g, P.a);
        disc(g, 0, 0, 0.17); paint(g, '#ffffff', WHITE_SW.k, OW * 0.8);
    },
    void(g, P) {
        for (let k = 0; k < 4; k++) line(g, spiralArm(k, 4, 2.6, 0.44), 0.07, P.b.l);
        annulus(g, 0.34, 0.46); lit(g, P.c);
    },
};

/* ── skins: tiles ───────────────────────────────────────────────────── */
// Tile sizes follow the hull's device pixels: octaves up to 256, half
// octaves past that, up to a hull filling a 4K screen. Tiles past 256 px
// are big (a 4096 one is 64 MB), so they share a pixel budget and the least
// recently drawn go first; one still on screen is never dropped for another.
const SIZES = [32, 64, 128, 256, 362, 512, 724, 1024, 1448, 2048, 2896, 4096];
const SMALL = 3;            // SIZES[SMALL] is the last small tile
const STILL_MAX = 2048;     // Fewer Effects / low fx: no 4K tiles
const GLOW_MAX = 2048;      // the glow layer is soft light, half res at 4K is fine
const BIG_BUDGET = 32e6;    // px across all big tiles, ~128 MB
const BIG_GAP = 200;        // ms between big builds, so growing never stacks hitches
const MAX_TILES = 96;
const tiles = new Map();    // team hex -> Map(nid -> [tile per size bucket])
let tileCount = 0, lastGen = -1e9, lastBig = -1e9, bigPx = 0;
const big = [];             // [sizes, bucket] of each big tile

function mkCanvas(n) {
    let cv;
    if (typeof OffscreenCanvas === 'function') cv = new OffscreenCanvas(n, n);
    else { cv = document.createElement('canvas'); cv.width = cv.height = n; }
    const c = cv.getContext('2d');
    c.setTransform(n / (2 * E), 0, 0, n / (2 * E), n / 2, n / 2);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    return [cv, c];
}

const LIT_KINDS = { pulse: 1, spinGlow: 1, spiral: 1, flash: 1, shift: 1, shimmer: 1 };
function buildTile(it, teamHex, px) {
    const s = it.skin;
    const [cv, c] = mkCanvas(px);
    const P = paletteFor(it, teamHex);
    const em = s.emissive;
    let glow = null, glow2 = null;
    try {
        const painter = PAINT[s.pattern];
        if (painter) { c.save(); painter(c, P, s, mulberry32(s.seed | 0)); c.restore(); }
        const lp = LIT[s.pattern];
        if (em && LIT_KINDS[em.kind] && lp) {
            const gpx = Math.min(px, GLOW_MAX);
            const g1 = mkCanvas(gpx);
            lp(g1[1], P, s, false);
            glow = g1[0];
            if (em.kind === 'shift') {
                const g2 = mkCanvas(gpx);
                lp(g2[1], P, s, true);
                glow2 = g2[0];
            }
        }
    } catch (e) { console.error('[cosmetics] skin paint failed', s.pattern, e); }
    // the twinkle's sparkles: a pale shade of the pattern's colour
    return { cv, glow, glow2, spark: P.spark, area: areaOf(it, px), used: 0 };
}

// The tile size for a hull `dev` device px in radius.
export function tilePx(dev, still) {
    const need = dev * 2 * E, top = still ? STILL_MAX : SIZES[SIZES.length - 1];
    for (let i = 0; i < SIZES.length; i++) if (SIZES[i] >= need || SIZES[i] >= top) return SIZES[i];
    return top;
}
const bucketOf = (px) => { const i = SIZES.indexOf(px); return i < 0 ? SIZES.length - 1 : i; };

// The px a tile of this size will take, glow layers included.
function areaOf(it, px) {
    const em = it.skin.emissive, gpx = Math.min(px, GLOW_MAX);
    if (!em || !LIT_KINDS[em.kind] || !LIT[it.skin.pattern]) return px * px;
    return px * px + gpx * gpx * (em.kind === 'shift' ? 2 : 1);
}

// Room for `area` more big px, dropping tiles not drawn for a second.
// False when everything left is still in use.
function makeRoom(area, now) {
    while (bigPx + area > BIG_BUDGET && big.length) {
        let k = 0;
        for (let i = 1; i < big.length; i++) if (big[i][0][big[i][1]].used < big[k][0][big[k][1]].used) k = i;
        const [sizes, b] = big[k];
        if (now - sizes[b].used < 1000) return false;
        bigPx -= sizes[b].area;
        sizes[b] = null;
        big.splice(k, 1);
        tileCount--;
    }
    return bigPx + area <= BIG_BUDGET;
}

// A tile ready for this skin / colour / size, or null. `force` builds it
// now (menu previews); otherwise at most one build per ~frame.
function tileFor(it, teamHex, px, force) {
    if (tileCount > MAX_TILES) { tiles.clear(); tileCount = 0; big.length = 0; bigPx = 0; }
    let byTeam = tiles.get(teamHex);
    if (!byTeam) { byTeam = new Map(); tiles.set(teamHex, byTeam); }
    let sizes = byTeam.get(it.nid);
    if (!sizes) { sizes = new Array(SIZES.length).fill(null); byTeam.set(it.nid, sizes); }
    const b = bucketOf(px);
    const now = performance.now();
    if (sizes[b]) { sizes[b].used = now; return sizes[b]; }
    if (force || (now - lastGen > 10 && (b <= SMALL || now - lastBig > BIG_GAP))) {
        // no room for this size while the others are on screen: the
        // biggest that fits instead, unless a smaller one is already there
        for (let k = b; k >= 0; k--) {
            if (k < b && sizes[k]) break;
            const p = SIZES[k], isBig = k > SMALL;
            if (isBig && !makeRoom(areaOf(it, p), now)) continue;
            lastGen = now;
            const tile = buildTile(it, teamHex, p);
            tile.used = now;
            sizes[k] = tile;
            tileCount++;
            if (isBig) { lastBig = now; bigPx += tile.area; big.push([sizes, k]); }
            return tile;
        }
    }
    // the nearest size of the same tile, scaled, until this one gets its turn
    for (let i = b - 1; i >= 0; i--) if (sizes[i]) { sizes[i].used = now; return sizes[i]; }
    for (let i = b + 1; i < SIZES.length; i++) if (sizes[i]) { sizes[i].used = now; return sizes[i]; }
    return null;
}

const sparkleSpots = new Map();    // nid -> [x, y, phase] x 5, hull units
function spotsOf(it) {
    let sp = sparkleSpots.get(it.nid);
    if (!sp) {
        const rnd = mulberry32((it.skin.seed | 0) + 77);
        sp = [];
        for (let i = 0; i < 5; i++) { const a = rnd() * TAU, d = 0.25 + rnd() * 0.6; sp.push(Math.cos(a) * d, Math.sin(a) * d, rnd()); }
        sparkleSpots.set(it.nid, sp);
    }
    return sp;
}
function sparkles(c, it, r, t, alpha, col) {
    const em = it.skin.emissive, sp = spotsOf(it);
    c.fillStyle = col;
    for (let i = 0; i < sp.length; i += 3) {
        const ph = sp[i + 2];
        const v = Math.sin((t * (em.speed || 1) + ph) * TAU);
        const k = v > 0 ? v * v * v : 0;
        if (k < 0.04) continue;
        const x = sp[i] * r, y = sp[i + 1] * r, L = r * (0.1 + 0.08 * k), w = L * 0.24;
        c.globalAlpha = alpha * k;
        c.beginPath();
        c.moveTo(x - L, y); c.lineTo(x - w, y - w); c.lineTo(x, y - L); c.lineTo(x + w, y - w);
        c.lineTo(x + L, y); c.lineTo(x + w, y + w); c.lineTo(x, y + L); c.lineTo(x - w, y + w);
        c.closePath();
        c.fill();
    }
}

// Paint a skin over a hull drawBody just drew.
// o: { statusColor, blend, flash, flashColor, hitBlend, hitColor,
//      borderless, fill, lowFx, force, time }
export function paintHull(c, x, y, r, shape, rot, nid, baseHex, o) {
    const it = skinOf(nid);
    if (!it || !o || o.fill === false || !skinnable(shape)) return;
    const T = c.getTransform();
    const dev = r * (Math.hypot(T.a, T.b) || 1);
    if (dev < 5) return;
    const team = typeof baseHex === 'string' && /^#[0-9a-f]{6}$/i.test(baseHex) ? baseHex : '#808080';
    const still = !!o.lowFx || fewerFx();
    const tile = tileFor(it, team, tilePx(dev, still), o.force);
    if (!tile) return;
    const s = it.skin, em = s.emissive;
    const t = still ? 0 : (o.time != null ? o.time : performance.now() / 1000);
    const a0 = c.globalAlpha;
    const R = r * E;
    c.save();
    hullPath(c, x, y, r, shape, rot, 'clip');
    c.setTransform(T);
    c.translate(x, y);
    c.rotate(rot);
    c.globalAlpha = a0 * (s.opacity == null ? 1 : s.opacity);
    if (em && t) {
        let turn = em.spin || 0;
        if (em.kind === 'spin') turn += em.speed || 0.1;
        else if (em.kind === 'spiral') turn -= em.speed || 0.1;
        if (turn) c.rotate(t * turn * TAU);
    }
    c.drawImage(tile.cv, -R, -R, 2 * R, 2 * R);
    if (em) {
        const sp = em.speed || 1;
        if (em.kind === 'twinkle') {
            sparkles(c, it, r, still ? 0.2 : t, a0 * 0.9, tile.spark);
        } else if (tile.glow && !glowOff()) {
            // the lit layer fades in and out over the design, flat
            let a = 0;
            if (!still) {
                if (em.kind === 'pulse') a = 0.15 + 0.7 * (0.5 + 0.5 * Math.sin(t * sp * TAU));
                else if (em.kind === 'flash') {
                    const ph = (t * sp) % 1;
                    a = Math.max(0, 1 - Math.abs(ph - 0.03) / 0.03) + 0.7 * Math.max(0, 1 - Math.abs(ph - 0.12) / 0.035);
                } else if (em.kind === 'shimmer') {
                    const every = Math.max(1, em.every || 3), p = (t % every) / 0.9;
                    a = p < 1 ? Math.sin(p * Math.PI) * 0.8 : 0;
                } else if (em.kind === 'spinGlow') {
                    c.rotate(t * sp * TAU);
                    a = 0.5 + 0.2 * Math.sin(t * sp * Math.PI * 4);
                } else if (em.kind === 'spiral') a = 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * sp * Math.PI * 4));
            }
            if (em.kind === 'shift' && tile.glow2) {
                const w = still ? 0 : 0.5 + 0.5 * Math.sin(t * sp * TAU);
                c.globalAlpha = a0 * Math.min(1, w);
                if (w > 0.01) c.drawImage(tile.glow2, -R, -R, 2 * R, 2 * R);
            } else if (a > 0.01) {
                c.globalAlpha = a0 * Math.min(1, a);
                c.drawImage(tile.glow, -R, -R, 2 * R, 2 * R);
            }
        }
    }
    // the blinks the plain body got from mixColors, at the same strength
    c.setTransform(T);
    const fk = o.flash ? 0.3 : o.blend;
    if (fk > 0) {
        c.globalAlpha = a0 * Math.min(1, fk);
        c.fillStyle = o.flash ? o.flashColor : o.statusColor;
        c.fillRect(x - R, y - R, 2 * R, 2 * R);
    }
    if (o.hitBlend > 0) {
        c.globalAlpha = a0 * Math.min(1, o.hitBlend);
        c.fillStyle = o.hitColor;
        c.fillRect(x - R, y - R, 2 * R, 2 * R);
    }
    c.restore();
    // the pattern covered the inner half of a centred rim: draw it again
    if (shape !== 0 && !o.borderless) {
        c.save();
        hullPath(c, x, y, r, shape, rot, 'stroke');
        c.restore();
    }
}

const BARREL_KIND = {
    stripes: 'hazard', rim: 'collar', racer: 'stripe', halves: 'split', rings: 'bands', dots: 'dots', checker: 'checker', core: 'dots',
    sash: 'bands', pumpkin: 'tip', camo: 'bands', strata: 'bands', hex: 'collar', chevrons: 'chevron', trim: 'collar', sunburst: 'tip',
    quarters: 'split', pinwheel: 'bands', tiger: 'hazard', circuit: 'dots', facets: 'gem', vein: 'tip', gem: 'gem', geode: 'gem',
    bolt: 'tip', spiral: 'bands', molten: 'tip', crosshair: 'bands', vault: 'collar', cracks: 'tip', frost: 'collar', drill: 'drill',
    druse: 'gem', shards: 'tip', storm: 'tip', gilded: 'collar', heart: 'gem', aurora: 'bands', prism: 'gem', nova: 'tip', void: 'tip',
};
const barrelStyles = new Map();
export function barrelStyleOf(nid) {
    let st = barrelStyles.get(nid);
    if (st !== undefined) return st;
    if (!CAT()) return null;
    const it = skinOf(nid);
    const kind = it ? BARREL_KIND[it.skin.pattern] : null;
    if (kind) {
        const sw = CAT().SKIN_SWATCHES || {}, cs = it.skin.colors || [];
        const a = swatch((sw[cs[0]] || ['#f2f2f2'])[0]);
        st = { kind, a, b: cs[1] && sw[cs[1]] ? swatch(sw[cs[1]][0]) : swatch(a.d) };
    } else st = null;
    barrelStyles.set(nid, st);
    return st;
}
function local4(c, x, y, cs, sn, u1, v1, u2, v2, u3, v3, u4, v4) {
    c.beginPath();
    c.moveTo(x + u1 * cs - v1 * sn, y + u1 * sn + v1 * cs);
    c.lineTo(x + u2 * cs - v2 * sn, y + u2 * sn + v2 * cs);
    c.lineTo(x + u3 * cs - v3 * sn, y + u3 * sn + v3 * cs);
    c.lineTo(x + u4 * cs - v4 * sn, y + u4 * sn + v4 * cs);
    c.closePath();
}
export function paintBarrel(c, x, y, halfLen, halfWidth, aspect, angle, position, nid, lw) {
    const st = barrelStyleOf(nid);
    if (!st) return;
    const h0 = aspect > 0 ? halfWidth * aspect : halfWidth, h1 = aspect > 0 ? halfWidth : -halfWidth * aspect;
    const back = 0, front = halfLen * 2 - position, L = front - back;
    if (!(L > 0)) return;
    const cs = Math.cos(angle), sn = Math.sin(angle), slope = (h0 - h1) / L;
    const wAt = (u) => h1 + (u - back) * slope;
    const A = st.a, B = st.b;
    const edge = lw * 0.5;
    c.lineWidth = edge;
    c.lineJoin = 'round';
    const ring4 = (u0, u1, k, X) => {
        local4(c, x, y, cs, sn, u0, -wAt(u0) * k, u1, -wAt(u1) * k, u1, wAt(u1) * k, u0, wAt(u0) * k);
        c.fillStyle = X.f; c.fill();
        c.strokeStyle = X.k; c.stroke();
    };
    if (st.kind === 'collar' || st.kind === 'tip') {
        const d0 = front - L * (st.kind === 'tip' ? 0.16 : 0.2), k = st.kind === 'tip' ? 1.14 : 1.3;
        const w0 = wAt(d0) * k, w1 = h0 * k;
        local4(c, x, y, cs, sn, d0, -w0, front, -w1, front, w1, d0, w0);
        c.fillStyle = A.f; c.fill();
        c.strokeStyle = A.k; c.stroke();
    } else if (st.kind === 'bands') {
        ring4(front - L * 0.42, front - L * 0.3, 1, B);
        ring4(front - L * 0.2, front - L * 0.04, 1, A);
    } else if (st.kind === 'hazard' || st.kind === 'checker') {
        const d0 = front - L * 0.3, d1 = front - L * 0.05;
        const w0 = wAt(d0), w1 = wAt(d1);
        local4(c, x, y, cs, sn, d0, -w0, d1, -w1, d1, w1, d0, w0);
        c.fillStyle = A.f; c.fill();
        c.fillStyle = B.f;
        const t = (d1 - d0) / 5;
        if (st.kind === 'hazard') {
            for (let i = 0; i < 2; i++) {
                const u = d0 + t * (0.6 + i * 2);
                local4(c, x, y, cs, sn, u, -w0, u + t, -w0, u + t * 1.6, w0, u + t * 0.6, w0);
                c.fill();
            }
        } else {
            for (let i = 0; i < 5; i++) {
                const u = d0 + t * i, v = (i & 1) ? -1 : 1, wm = wAt(u + t / 2);
                local4(c, x, y, cs, sn, u, 0, u + t, 0, u + t, v * wm, u, v * wm);
                c.fill();
            }
        }
        local4(c, x, y, cs, sn, d0, -w0, d1, -w1, d1, w1, d0, w0);
        c.strokeStyle = A.k; c.stroke();
    } else if (st.kind === 'stripe') {
        const d0 = back + L * 0.3, d1 = front - L * 0.06, w = Math.min(h0, h1) * 0.34;
        local4(c, x, y, cs, sn, d0, -w, d1, -w, d1, w, d0, w);
        c.fillStyle = A.f; c.fill();
        c.lineWidth = edge * 0.7; c.strokeStyle = A.k; c.stroke();
        if (B.f !== A.d) {
            const v = w * 0.34;
            local4(c, x, y, cs, sn, d0, -v, d1, -v, d1, v, d0, v);
            c.fillStyle = B.f; c.fill();
        }
    } else if (st.kind === 'split') {
        const d0 = back + L * 0.34, d1 = front;
        local4(c, x, y, cs, sn, d0, 0, d1, 0, d1, -wAt(d1), d0, -wAt(d0));
        c.fillStyle = A.f; c.fill();
        local4(c, x, y, cs, sn, d0, 0, d1, 0, d1, wAt(d1), d0, wAt(d0));
        c.fillStyle = B.f; c.fill();
        local4(c, x, y, cs, sn, d0, -wAt(d0), d1, -wAt(d1), d1, wAt(d1), d0, wAt(d0));
        c.lineWidth = edge * 0.8; c.strokeStyle = B.k; c.stroke();
    } else if (st.kind === 'dots') {
        const r = Math.min(h0, h1) * 0.42;
        for (const f of [0.3, 0.66]) {
            const u = front - L * f + r * 0.2;
            c.beginPath(); c.arc(x + u * cs, y + u * sn, r, 0, TAU);
            c.fillStyle = A.f; c.fill();
            c.lineWidth = edge * 0.8; c.strokeStyle = A.k; c.stroke();
        }
    } else if (st.kind === 'chevron') {
        const u0 = front - L * 0.46, u1 = front - L * 0.12, t = L * 0.12;
        const at = (u, v) => [x + u * cs - v * sn, y + u * sn + v * cs];
        const pts = [at(u0, -wAt(u0)), at(u0 + t, -wAt(u0)), at(u1, 0), at(u0 + t, wAt(u0)), at(u0, wAt(u0)), at(u1 - t, 0)];
        c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
        c.closePath();
        c.fillStyle = A.f; c.fill();
        c.lineWidth = edge * 0.8; c.strokeStyle = A.k; c.stroke();
    } else if (st.kind === 'gem') {
        const d0 = front - L * 0.2;
        ring4(d0, front, 1.16, A);
        const um = (d0 + front) / 2, hl = (front - d0) * 0.32, hw = wAt(um) * 0.62;
        local4(c, x, y, cs, sn, um - hl, 0, um, -hw, um + hl, 0, um, hw);
        c.fillStyle = A.l; c.fill();
        c.lineWidth = edge * 0.6; c.strokeStyle = A.k; c.stroke();
    } else if (st.kind === 'drill') {
        const d0 = front - L * 0.18;
        const w0 = wAt(d0);
        local4(c, x, y, cs, sn, d0, -w0, front, -h0, front, h0, d0, w0);
        c.fillStyle = A.f; c.fill();
        c.strokeStyle = A.k; c.stroke();
        c.beginPath();
        for (let i = 0; i < 3; i++) {
            const u = front - L * (0.34 + i * 0.16), w = wAt(u);
            c.moveTo(x + u * cs + w * sn, y + u * sn - w * cs);
            c.lineTo(x + (u + L * 0.1) * cs - w * sn, y + (u + L * 0.1) * sn + w * cs);
        }
        c.lineWidth = edge; c.strokeStyle = A.k; c.stroke();
        local4(c, x, y, cs, sn, d0 - L * 0.04, -w0 * 0.3, d0, -w0 * 0.3, d0, w0 * 0.3, d0 - L * 0.04, w0 * 0.3);
        c.fillStyle = B.f; c.fill();
    }
}

// For tests / dev tools.
export function cacheSize() { return tileCount; }
