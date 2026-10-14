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
function band(c, pts, w, fill, edge) { bands(c, [[pts, w]], fill, edge); }
function star(c, n, r0, r1, rot) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) pts.push(pol(i & 1 ? r0 : r1, rot + (i * Math.PI) / n));
    poly(c, pts);
}
function blob(c, rnd, x, y, r) {
    const n = 8, pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU, rr = r * (0.88 + 0.2 * rnd());
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
    for (let x = -1.4; x <= 1.41; x += 0.1) c.lineTo(x, yc - h + amp * Math.sin(fr * x + ph));
    for (let x = 1.4; x >= -1.41; x -= 0.1) c.lineTo(x, yc + h + amp * Math.sin(fr * x + ph + 0.5));
    c.closePath();
}
const BOLT = [[0.1, -1], [-0.35, 0.1], [-0.02, 0.1], [-0.15, 1], [0.35, -0.15], [0.02, -0.15], [0.25, -1]];
function bolt(c, k, rot) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    poly(c, BOLT.map(([x, y]) => [(x * cs - y * sn) * k, (x * sn + y * cs) * k]));
}
function spiralArm(k, arms, turn) {
    const pts = [];
    for (let i = 0; i <= 36; i++) {
        const f = i / 36, a = (k / arms) * TAU + f * turn, r = 0.15 + f * 1.25;
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
function crackSeams() {
    const out = [];
    for (const a of [0.3, 1.55, 2.75, 3.95, 5.1]) out.push([pol(0.2, a), pol(0.52, a + 0.28), pol(0.88, a - 0.1), pol(1.5, a + 0.14)]);
    return out;
}
function cloud(c) {
    c.beginPath();
    c.moveTo(-1.4, -1.4); c.lineTo(-1.4, -0.34);
    for (let i = 0; i < 4; i++) {
        const x0 = -1.4 + i * 0.7;
        c.quadraticCurveTo(x0 + 0.35, 0.02 + (i & 1 ? -0.08 : 0.06), x0 + 0.7, -0.34);
    }
    c.lineTo(1.4, -1.4);
    c.closePath();
}
function eyePath(c, w, h) {
    c.beginPath();
    c.moveTo(-w, 0);
    c.quadraticCurveTo(0, -h * 2, w, 0);
    c.quadraticCurveTo(0, h * 2, -w, 0);
    c.closePath();
}
function tigerStripes(c, w) {
    c.beginPath();
    for (let k = -2; k <= 2; k++) {
        for (const sg of [-1, 1]) {
            const x = k * 0.56 + (sg > 0 ? 0.28 : 0), len = (k + sg) & 1 ? 0.8 : 1.05;
            const y0 = sg * 1.35, tip = sg * (1.35 - len), bend = 0.14;
            c.moveTo(x - w, y0);
            c.quadraticCurveTo(x - w * 0.8 + bend, (y0 + tip) / 2, x + bend * 1.5, tip);
            c.quadraticCurveTo(x + w * 0.6 + bend, (y0 + tip) / 2, x + w, y0);
            c.closePath();
        }
    }
}
const STRATA = [-0.62, 0, 0.62];
function strataBand(c, i) { wave(c, STRATA[i], 0.14, 0.09, 2.4, i * 1.7); }
const AURORA = [-0.52, 0, 0.52];
function auroraBand(c, i) { wave(c, AURORA[i], 0.13, 0.13, 2.2, i * 1.3); }
function sunRays(c) {
    const n = 8, w = (TAU / n) * 0.42;
    c.beginPath();
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU; c.moveTo(0, 0); c.arc(0, 0, 2, a - w / 2, a + w / 2); c.closePath(); }
}
function vaultSpokes(c) {
    c.beginPath();
    for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU - Math.PI / 2, cs = Math.cos(a), sn = Math.sin(a); c.moveTo(-0.09 * sn, 0.09 * cs); c.lineTo(0.68 * cs - 0.09 * sn, 0.68 * sn + 0.09 * cs); c.lineTo(0.68 * cs + 0.09 * sn, 0.68 * sn - 0.09 * cs); c.lineTo(0.09 * sn, -0.09 * cs); c.closePath(); }
}
function blade(c, k, s) {
    const a = (k / 3) * TAU;
    poly(c, [pol(0.16, a - 0.44 * s), pol(0.74, a - 0.22 * s), pol(1.3, a), pol(0.74, a + 0.22 * s), pol(0.16, a + 0.44 * s)]);
}
function prismWedge(c, i) {
    const n = 12, a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
    c.beginPath(); c.arc(0, 0, 0.9, a0, a1); c.arc(0, 0, 0.5, a1, a0, true); c.closePath();
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

const PAINT = {
    stripes(c, P, s) {
        c.rotate(((s.angle == null ? 45 : s.angle) * Math.PI) / 180);
        c.beginPath(); c.rect(-3, -0.36, 6, 0.72); paint(c, P.a.f, null);
        c.save(); c.clip();
        c.beginPath();
        for (let x = -3; x < 3; x += 0.6) { c.moveTo(x, -0.4); c.lineTo(x + 0.28, -0.4); c.lineTo(x + 0.02, 0.4); c.lineTo(x - 0.26, 0.4); c.closePath(); }
        paint(c, P.b.f, null);
        c.restore();
        c.beginPath(); c.rect(-3, -0.36, 6, 0.72); paint(c, null, P.a.k);
    },
    racer(c, P) {
        c.beginPath(); c.rect(-3, -0.44, 6, 0.24); c.rect(-3, 0.2, 6, 0.24);
        fl(c, P.a);
    },
    halves(c, P) {
        c.lineJoin = 'miter';
        band(c, [[-1.5, 0.14], [-0.6, -0.16], [0.3, 0.14], [1.2, -0.16], [1.6, 0]], 0.24, P.a.f, P.a.k);
        c.lineJoin = 'round';
        for (const [x, y] of [[-0.6, -0.16], [0.3, 0.14]]) { disc(c, x, y, 0.12); fl(c, P.b); }
    },
    rings(c, P) {
        annulus(c, 0.56, 0.8); fl(c, P.a);
        annulus(c, 0.24, 0.4); fl(c, P.b);
        disc(c, 0, 0, 0.12); fl(c, P.a);
    },
    dots(c, P) {
        const spots = [[0, 0, 0.18]];
        for (let i = 0; i < 6; i++) { const p = pol(0.58, (i / 6) * TAU + 0.3); spots.push([p[0], p[1], 0.15]); }
        for (let i = 0; i < 9; i++) { const p = pol(1.08, (i / 9) * TAU); spots.push([p[0], p[1], 0.17]); }
        c.beginPath();
        for (const [x, y, r] of spots) { c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU); }
        fl(c, P.a);
    },
    checker(c, P) {
        const cs = 0.32;
        c.beginPath();
        for (let j = -1; j < 1; j++) for (let i = -8; i < 8; i++) if ((i + j) & 1) c.rect(i * cs, j * cs, cs, cs);
        paint(c, P.a.f, null);
        c.beginPath();
        for (let j = -1; j < 1; j++) for (let i = -8; i < 8; i++) if (!((i + j) & 1)) c.rect(i * cs, j * cs, cs, cs);
        paint(c, P.b.f, null);
        c.beginPath(); c.rect(-3, -cs, 6, 2 * cs); paint(c, null, P.b.k);
    },
    core(c, P) {
        disc(c, 0, 0, 0.44); fl(c, P.a);
        disc(c, 0, 0, 0.2); fd(c, P.a);
    },
    sash(c, P, s) {
        c.rotate(((s.angle == null ? -35 : s.angle) * Math.PI) / 180);
        c.beginPath(); c.rect(-3, -0.22, 6, 0.44); fl(c, P.a);
        disc(c, 0, 0, 0.28); fl(c, P.b);
        star(c, 5, 0.09, 0.2, -Math.PI / 2); fd(c, P.b, OW * 0.7);
    },
    rim(c, P) {
        annulus(c, 0.54, 0.82); fl(c, P.a);
        studs(c, P.b, 6, 0.68, 0.1, Math.PI / 6);
    },
    trim(c, P) {
        for (let i = 0; i < 4; i++) {
            c.save(); c.rotate((i / 4) * TAU + Math.PI / 4);
            c.beginPath(); c.rect(0.62, -0.13, 0.36, 0.26); fd(c, P.a);
            c.restore();
        }
        annulus(c, 0.72, 0.88); fl(c, P.a);
        disc(c, 0, 0, 0.3); fl(c, P.a);
        disc(c, 0, 0, 0.12); fd(c, P.a);
    },
    camo(c, P, s, rnd) {
        const B = [[-0.5, -0.45, 0.38, 0], [0.52, -0.55, 0.32, 1], [0.15, 0.3, 0.38, 0], [-0.72, 0.52, 0.3, 1], [0.95, 0.38, 0.3, 1], [-0.05, -1.12, 0.3, 0]];
        for (const [x, y, r, k] of B) { blob(c, rnd, x, y, r); fl(c, k ? P.b : P.a); }
    },
    strata(c, P) {
        for (let i = 0; i < 3; i++) { strataBand(c, i); fl(c, i === 1 ? P.b : P.a); }
    },
    hex(c, P) {
        const R = 0.44, w = Math.sqrt(3) * R;
        for (let row = -3; row <= 3; row++) {
            for (let col = -3; col <= 3; col++) {
                const x = col * w + (row & 1 ? w / 2 : 0), y = row * 1.5 * R;
                if (x * x + y * y > 2.4) continue;
                hexagon(c, x, y, R * 0.84, Math.PI / 6);
                const on = (row === 0 && col === 0) || (((row + col * 2) % 3) + 3) % 3 === 0;
                paint(c, on ? P.a.f : null, P.a.k, OW * 0.8);
            }
        }
    },
    chevrons(c, P) {
        c.lineJoin = 'miter';
        for (const x0 of [-0.3, 0.32]) band(c, [[x0 - 0.38, -1.3], [x0 + 0.24, 0], [x0 - 0.38, 1.3]], 0.24, P.a.f, P.a.k);
        c.lineJoin = 'round';
    },
    sunburst(c, P) {
        sunRays(c); fl(c, P.a, OW * 0.8);
        disc(c, 0, 0, 0.32); fl(c, P.b);
    },
    quarters(c, P) {
        c.rotate(Math.PI / 4);
        c.beginPath();
        c.moveTo(0, 0); c.arc(0, 0, 0.72, 0, Math.PI / 2); c.closePath();
        c.moveTo(0, 0); c.arc(0, 0, 0.72, Math.PI, Math.PI * 1.5); c.closePath();
        fl(c, P.a);
        disc(c, 0, 0, 0.72); paint(c, null, P.a.k);
        disc(c, 0, 0, 0.15); fl(c, P.a);
    },
    pinwheel(c, P) {
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * TAU;
            c.beginPath();
            c.moveTo(0, 0); c.lineTo(Math.cos(a) * 1.5, Math.sin(a) * 1.5); c.arc(0, 0, 1.5, a, a + 0.55);
            const q = pol(0.6, a + 0.75); c.quadraticCurveTo(q[0], q[1], 0, 0); c.closePath();
            fl(c, i & 1 ? P.b : P.a);
        }
        disc(c, 0, 0, 0.18); fl(c, P.c);
    },
    tiger(c, P) {
        tigerStripes(c, 0.22); fl(c, P.a);
        tigerStripes(c, 0.08); paint(c, P.b.f, null);
    },
    circuit(c, P) {
        const traces = [];
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * TAU + Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a), q = (u, v) => [u * cs - v * sn, u * sn + v * cs];
            traces.push([[q(0.3, 0), q(0.56, 0), q(0.72, 0.2)], 0.12]);
        }
        bands(c, traces, P.a.f, P.a.k);
        for (const [pts] of traces) { disc(c, pts[2][0], pts[2][1], 0.13); fl(c, P.b); }
        c.beginPath(); c.rect(-0.34, -0.34, 0.68, 0.68); fl(c, P.c);
        c.beginPath(); c.rect(-0.15, -0.15, 0.3, 0.3); fl(c, P.b);
    },
    facets(c, P) {
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * TAU + Math.PI / 4;
            poly(c, [pol(0.68, a), pol(0.84, a + 0.2), pol(1.02, a), pol(0.84, a - 0.2)]);
            fl(c, P.a, OW * 0.8);
        }
        const n = 8, R = 0.58, r = 0.28, rot = Math.PI / 8;
        poly(c, ring(n, R, rot)); fl(c, P.a);
        poly(c, ring(n, r, rot)); paint(c, P.a.l, null);
        facetLines(c, n, r, R, rot, P.a.k);
        poly(c, ring(n, r, rot)); paint(c, null, P.a.k, OW * 0.7);
    },
    vein(c, P, s, rnd) {
        const V = [[[-1.3, 0.5], [-0.6, 0.2], [-0.1, 0.42], [0.5, -0.1], [1.3, -0.3]], [[-0.6, 0.2], [-0.5, -0.5], [-0.8, -1.1]], [[0.5, -0.1], [0.7, 0.6], [0.5, 1.2]]];
        bands(c, V.map(p => [p, 0.15]), P.a.f, P.a.k);
        for (const [x, y, r] of [[-0.6, 0.2, 0.18], [0.5, -0.1, 0.21], [-0.1, 0.42, 0.15]]) { blob(c, rnd, x, y, r); fl(c, P.a); }
    },
    gem(c, P) {
        annulus(c, 0.74, 0.88); fl(c, P.a);
        const R = 0.54, r = 0.26, rot = Math.PI / 6;
        hexagon(c, 0, 0, R, rot); fl(c, P.a);
        hexagon(c, 0, 0, r, rot); paint(c, P.a.l, null);
        facetLines(c, 6, r, R, rot, P.a.k);
        hexagon(c, 0, 0, r, rot); paint(c, null, P.a.k, OW * 0.7);
    },
    geode(c, P) {
        annulus(c, 0.66, 0.88); fl(c, P.b);
        for (let i = 0; i < 10; i++) {
            const a = (i / 10) * TAU;
            poly(c, [pol(0.71, a - 0.25), pol(0.36, a), pol(0.71, a + 0.25)]);
            fl(c, P.a, OW * 0.8);
        }
    },
    gear(c, P) {
        const n = 10;
        for (let i = 0; i < n; i++) { c.save(); c.rotate((i / n) * TAU); c.beginPath(); c.rect(0.7, -0.12, 0.27, 0.24); fl(c, P.a); c.restore(); }
        annulus(c, 0.58, 0.8); fl(c, P.a);
        for (const [x, y, k, a] of [[0, -0.12, 0.36, 0], [-0.22, 0.17, 0.26, -0.5], [0.22, 0.17, 0.26, 0.5]]) { diamond(c, x, y, k, a); fl(c, P.b, OW * 0.8); }
    },
    bolt(c, P) {
        disc(c, 0, 0, 0.62); fl(c, P.b);
        bolt(c, 0.74, 0.25); fl(c, P.a);
    },
    spiral(c, P, s) {
        const arms = s.arms || 2, list = [];
        for (let k = 0; k < arms; k++) list.push([spiralArm(k, arms, 3.2), 0.18]);
        bands(c, list, P.a.f, P.a.k);
        disc(c, 0, 0, 0.28); fl(c, P.b);
        disc(c, 0, 0, 0.11); fl(c, P.a);
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
        c.beginPath();
        for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU + Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a); c.moveTo(0.24 * cs + 0.1 * sn, 0.24 * sn - 0.1 * cs); c.lineTo(1.05 * cs + 0.1 * sn, 1.05 * sn - 0.1 * cs); c.lineTo(1.05 * cs - 0.1 * sn, 1.05 * sn + 0.1 * cs); c.lineTo(0.24 * cs - 0.1 * sn, 0.24 * sn + 0.1 * cs); c.closePath(); }
        fl(c, P.a, OW * 0.8);
        annulus(c, 0.52, 0.72); fl(c, P.a);
        disc(c, 0, 0, 0.14); fl(c, P.b);
    },
    vault(c, P) {
        annulus(c, 0.68, 0.88); fl(c, P.a);
        studs(c, P.b, 4, 0.78, 0.09, Math.PI / 4);
        vaultSpokes(c); fl(c, P.a, OW * 0.8);
        disc(c, 0, 0, 0.25); fl(c, P.b);
        disc(c, 0, 0, 0.1); fd(c, P.b);
    },
    cracks(c, P) {
        const seams = crackSeams();
        for (const p of seams) line(c, p, 0.13 + 2 * OW, P.a.k);
        for (const p of seams) line(c, p, 0.13, P.a.f);
        disc(c, 0, 0, 0.28); fl(c, P.a);
        disc(c, 0, 0, 0.13); fl(c, P.b);
    },
    frost(c, P) {
        const arms = [];
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * TAU, cs = Math.cos(a), sn = Math.sin(a), q = (u, v) => [u * cs - v * sn, u * sn + v * cs];
            arms.push([[q(0.2, 0), q(0.9, 0)], 0.12], [[q(0.5, 0), q(0.7, 0.2)], 0.09], [[q(0.5, 0), q(0.7, -0.2)], 0.09]);
        }
        bands(c, arms, P.a.f, P.a.k);
        hexagon(c, 0, 0, 0.28, 0); fl(c, P.b);
    },
    drill(c, P) {
        const n = 6;
        for (let i = 0; i < n; i += 2) {
            const a = (i / n) * TAU;
            c.beginPath();
            c.moveTo(0, 0);
            const p1 = pol(1.5, a), cp = pol(0.9, a + 0.55), p2 = pol(1.5, a + TAU / n * 0.6);
            c.quadraticCurveTo(cp[0] * 0.6, cp[1] * 0.6, p1[0], p1[1]);
            c.lineTo(p2[0], p2[1]);
            c.quadraticCurveTo(cp[0] * 0.75, cp[1] * 0.75, 0, 0);
            c.closePath();
            fl(c, P.a);
        }
        disc(c, 0, 0, 0.26); fl(c, P.b);
        disc(c, 0, 0, 0.1); fd(c, P.b);
    },
    shards(c, P) {
        for (let k = 0; k < 3; k++) {
            blade(c, k, 1); fl(c, P.a);
            blade(c, k, 0.3); paint(c, P.b.f, null);
        }
        disc(c, 0, 0, 0.22); fl(c, P.b);
    },
    storm(c, P) {
        cloud(c); fl(c, P.a);
        c.save(); c.translate(0.04, 0.32); bolt(c, 0.44, 0.2); fl(c, P.b); c.restore();
    },
    gilded(c, P) {
        annulus(c, 0.68, 0.86); fl(c, P.a);
        studs(c, P.b, 6, 0.77, 0.08, 0);
        star(c, 5, 0.26, 0.56, -Math.PI / 2); fl(c, P.a);
    },
    heart(c, P) {
        annulus(c, 0.7, 0.88); fl(c, P.b);
        studs(c, P.a, 6, 0.79, 0.08, Math.PI / 6);
        c.save(); c.rotate(Math.PI / 2); heartPath(c, 1.08); fl(c, P.a);
        heartPath(c, 0.5); fd(c, P.a, OW * 0.7); c.restore();
    },
    aurora(c, P) {
        const cols = [P.a, P.b, P.c];
        for (let i = 0; i < 3; i++) { auroraBand(c, i); fl(c, cols[i]); }
    },
    prism(c, P) {
        const cols = [P.a, P.b, P.c];
        for (let i = 0; i < 12; i += 2) { prismWedge(c, i); fl(c, cols[(i / 2) % 3], OW * 0.8); }
        hexagon(c, 0, 0, 0.27, 0); fl(c, WHITE_SW);
    },
    nova(c, P) {
        annulus(c, 0.8, 0.92); fl(c, P.b);
        star(c, 8, 0.28, 0.64, 0); fl(c, P.a);
        disc(c, 0, 0, 0.17); fl(c, P.b);
    },
    void(c, P) {
        annulus(c, 0.8, 0.94); fl(c, P.a);
        c.save(); c.rotate(Math.PI / 2);
        eyePath(c, 0.7, 0.31); fl(c, P.c);
        disc(c, 0, 0, 0.3); fl(c, P.b);
        disc(c, 0, 0, 0.13); paint(c, P.a.f, null);
        c.restore();
    },
    pumpkin(c, P) {
        c.save(); c.rotate(Math.PI / 2);
        const face = (pts) => { poly(c, pts); paint(c, P.a.f, P.b.f, OW * 1.1); };
        face([[-0.5, -0.1], [-0.28, -0.5], [-0.08, -0.1]]);
        face([[0.08, -0.1], [0.28, -0.5], [0.5, -0.1]]);
        face([[-0.6, 0.1], [-0.4, 0.24], [-0.24, 0.12], [-0.08, 0.28], [0.08, 0.12], [0.24, 0.28], [0.4, 0.12], [0.6, 0.1], [0.42, 0.5], [0, 0.62], [-0.42, 0.5]]);
        c.restore();
    },
};
const LIT = {
    cracks(g, P) {
        for (const p of crackSeams()) line(g, p, 0.07, P.b.l);
        disc(g, 0, 0, 0.13); paint(g, P.b.l, null);
    },
    shards(g, P) {
        for (let k = 0; k < 3; k++) { blade(g, k, 1); paint(g, P.a.l, P.a.k); }
    },
    storm(g, P) {
        g.translate(0.04, 0.32); bolt(g, 0.44, 0.2); paint(g, P.b.l, P.b.k);
    },
    molten(g, P, s) {
        const arms = s.arms || 3;
        for (let k = 0; k < arms; k++) line(g, spiralArm(k, arms, 3.0), 0.07, P.b.l);
        disc(g, 0, 0, 0.32); paint(g, P.b.l, P.b.k);
    },
    aurora(g, P, s, alt) {
        const cols = alt ? [P.b, P.c, P.a] : [P.a, P.b, P.c];
        for (let i = 0; i < 3; i++) { auroraBand(g, i); paint(g, alt ? cols[i].f : cols[i].l, cols[i].k); }
    },
    nova(g, P) {
        star(g, 8, 0.28, 0.64, 0); paint(g, P.a.l, P.a.k);
    },
    void(g, P) {
        g.rotate(Math.PI / 2);
        disc(g, 0, 0, 0.3); paint(g, P.b.l, P.b.k);
        disc(g, 0, 0, 0.13); paint(g, P.a.f, null);
    },
    gilded(g, P) {
        star(g, 5, 0.26, 0.56, -Math.PI / 2); paint(g, P.a.l, P.a.k);
    },
    heart(g, P) {
        g.rotate(Math.PI / 2); heartPath(g, 1.08); paint(g, P.a.l, P.a.k);
        heartPath(g, 0.5); paint(g, P.a.f, P.a.k, OW * 0.7);
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
    // spin turns the pattern; spiral turns it the other way, glow and all
    if (em && t && (em.kind === 'spin' || em.kind === 'spiral')) c.rotate((em.kind === 'spiral' ? -1 : 1) * t * (em.speed || 0.1) * TAU);
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

const BARREL_KIND = { stripes: 'hazard', racer: 'stripe', checker: 'checker', rim: 'collar', trim: 'collar', vault: 'collar', gilded: 'collar', drill: 'drill', molten: 'tip', cracks: 'tip' };
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
    const A = st.a, B = st.b;
    const edge = lw * 0.5;
    c.lineWidth = edge;
    c.lineJoin = 'round';
    if (st.kind === 'collar' || st.kind === 'tip') {
        const d0 = front - L * (st.kind === 'tip' ? 0.16 : 0.2), k = st.kind === 'tip' ? 1.14 : 1.3;
        const w0 = (h1 + (d0 - back) * slope) * k, w1 = h0 * k;
        local4(c, x, y, cs, sn, d0, -w0, front, -w1, front, w1, d0, w0);
        c.fillStyle = A.f; c.fill();
        c.strokeStyle = A.k; c.stroke();
    } else if (st.kind === 'hazard' || st.kind === 'checker') {
        const d0 = front - L * 0.3, d1 = front - L * 0.05;
        const w0 = h1 + (d0 - back) * slope, w1 = h1 + (d1 - back) * slope;
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
                const u = d0 + t * i, v = (i & 1) ? -1 : 1, wm = h1 + (u + t / 2 - back) * slope;
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
    } else if (st.kind === 'drill') {
        const d0 = front - L * 0.18;
        const w0 = h1 + (d0 - back) * slope;
        local4(c, x, y, cs, sn, d0, -w0, front, -h0, front, h0, d0, w0);
        c.fillStyle = A.f; c.fill();
        c.strokeStyle = A.k; c.stroke();
        c.beginPath();
        for (let i = 0; i < 2; i++) {
            const u = front - L * (0.32 + i * 0.16), w = h1 + (u - back) * slope;
            c.moveTo(x + u * cs + w * sn, y + u * sn - w * cs);
            c.lineTo(x + (u + L * 0.1) * cs - w * sn, y + (u + L * 0.1) * sn + w * cs);
        }
        c.lineWidth = edge; c.strokeStyle = A.k; c.stroke();
    }
}

// For tests / dev tools.
export function cacheSize() { return tileCount; }
