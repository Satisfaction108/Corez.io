// Cosmetics drawing: tank skins (paintHull) and name styles (nameFill,
// nameFx), from the shared catalog (window.DWCosmetics). No DOM: app.js
// calls this every frame, so the hot paths allocate nothing.
// Skins: a flat design tile per skin + team colour + size bucket (32..4096
// device px, following the hull on screen; skins never recolour, every
// design is drawn in shades of the team colour), in hull space, clipped to the
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
const E = 1.25;         // the tile spans [-E, E] hull radii
const OW = 0.075;       // outline width of pattern shapes

const pol = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];
function poly(c, pts) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
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
// a thick line with a darker outline, like the game's barrels
function band(c, pts, w, fill, edge) {
    line(c, pts, w + 2 * OW * 0.8, edge);
    line(c, pts, w, fill);
}
function star(c, n, r0, r1, rot) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) pts.push(pol(i & 1 ? r0 : r1, rot + (i * Math.PI) / n));
    poly(c, pts);
}
// A smooth closed blob through n points around (x, y).
function blob(c, rnd, x, y, r) {
    const n = 9, pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU, rr = r * (0.86 + 0.24 * rnd());
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
// A wavy band between two sine edges, across the whole tile.
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
function spiralArm(k, n, arms, turn) {
    const pts = [];
    for (let i = 0; i <= 36; i++) {
        const f = i / 36, a = (k / arms) * TAU + f * turn, r = 0.15 + f * 1.25;
        pts.push(pol(r, a));
    }
    return pts;
}
// Skins never recolour (owner rule, Oct 6 2026): every design is the hull's
// own team colour with decorations laid over it in shades of that colour
// (D darker, DD darker still, L lighter, LL pale) and outlined in K, a dark
// ink of it, the game's flat style. G / G2 are the glow tints (emissive).
const SKIN_INK = '#120e15';
function paletteFor(teamHex) {
    const T = teamHex;
    return {
        T, D: mix(T, SKIN_INK, 0.24), DD: mix(T, SKIN_INK, 0.44), L: mix(T, '#ffffff', 0.34), LL: mix(T, '#ffffff', 0.62),
        K: mix(T, SKIN_INK, 0.66), G: mix(T, '#ffffff', 0.55), G2: mix(T, '#ffffff', 0.85),
    };
}
// raised (lighter) and inset (darker) parts, each with the ink edge
const up = (c, P, w) => paint(c, P.L, P.K, w);
const hi = (c, P, w) => paint(c, P.LL, P.K, w);
const dn = (c, P, w) => paint(c, P.D, P.K, w);
function studs(c, P, n, rr, sz, rot, fill) {
    for (let i = 0; i < n; i++) {
        const p = pol(rr, (rot || 0) + (i / n) * TAU);
        disc(c, p[0], p[1], sz);
        paint(c, fill || P.LL, P.K, OW * 0.8);
    }
}
function hexagon(c, x, y, r, rot) {
    const pts = [];
    for (let i = 0; i < 6; i++) { const a = (rot || 0) + (i / 6) * TAU; pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); }
    poly(c, pts);
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
    const ang = [0.3, 1.55, 2.75, 3.95, 5.1];
    for (const a of ang) out.push([pol(0.2, a), pol(0.5, a + 0.28), pol(0.86, a - 0.1), pol(1.5, a + 0.14)]);
    return out;
}
function cloud(c) {
    c.beginPath();
    c.moveTo(-1.4, -1.4); c.lineTo(-1.4, -0.12);
    for (let i = 0; i < 6; i++) {
        const x0 = -1.4 + i * 0.47;
        c.quadraticCurveTo(x0 + 0.235, 0.22 + (i & 1 ? -0.06 : 0.04), x0 + 0.47, -0.12);
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

// Each painter draws its design in hull space (radius 1 = the hull edge);
// GLOW painters draw the matching emissive layer (additive, No Glow drops it).
const PAINT = {
    // a strip of hazard tape across the hull
    stripes(c, P, s) {
        c.rotate(((s.angle == null ? 45 : s.angle) * Math.PI) / 180);
        c.beginPath(); c.rect(-3, -0.34, 6, 0.68); paint(c, P.DD, null);
        c.save(); c.clip();
        c.beginPath();
        for (let x = -3; x < 3; x += 0.44) { c.moveTo(x, -0.4); c.lineTo(x + 0.22, -0.4); c.lineTo(x + 0.02, 0.4); c.lineTo(x - 0.2, 0.4); c.closePath(); }
        paint(c, P.L, null);
        c.restore();
        c.beginPath(); c.rect(-3, -0.34, 6, 0.68); paint(c, null, P.K);
    },
    // two racing stripes nose to tail
    racer(c, P) {
        c.beginPath(); c.rect(-3, -0.38, 6, 0.21); c.rect(-3, 0.17, 6, 0.21);
        hi(c, P);
    },
    // a darker half with a riveted seam
    halves(c, P) {
        c.beginPath(); c.rect(-3, 0, 6, 3); dn(c, P, OW * 1.2);
        for (const x of [-0.62, 0, 0.62]) { disc(c, x, 0, 0.08); hi(c, P, OW * 0.8); }
    },
    // a donut ring round a dot
    rings(c, P) {
        annulus(c, 0.5, 0.76); up(c, P);
        disc(c, 0, 0, 0.24); up(c, P);
    },
    dots(c, P, s) {
        const sp = s.scale || 0.56, r = sp * 0.22;
        c.beginPath();
        for (let j = -4; j <= 4; j++) {
            const y = j * sp * 0.866;
            for (let i = -4; i <= 4; i++) { const x = i * sp + (j & 1 ? sp / 2 : 0); c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU); }
        }
        hi(c, P, OW * 0.8);
    },
    checker(c, P, s) {
        const cs = s.scale || 0.5;
        c.rotate(Math.PI / 4);
        c.beginPath();
        for (let j = -6; j < 6; j++) for (let i = -6; i < 6; i++) if ((i + j) & 1) c.rect(i * cs, j * cs, cs, cs);
        dn(c, P, OW * 0.7);
    },
    // a lit button in the middle
    core(c, P) {
        disc(c, 0, 0, 0.44); up(c, P);
        disc(c, 0, 0, 0.17); dn(c, P);
        disc(c, -0.13, -0.15, 0.07); paint(c, P.LL, null);
    },
    sash(c, P, s) {
        c.rotate(((s.angle == null ? -35 : s.angle) * Math.PI) / 180);
        c.beginPath(); c.rect(-3, -0.22, 6, 0.44); up(c, P);
        c.beginPath(); c.rect(-3, -0.05, 6, 0.1); paint(c, P.D, null);
        disc(c, 0, 0, 0.2); hi(c, P);
    },
    // a riveted rim
    rim(c, P, s) {
        annulus(c, 0.52, 0.78); dn(c, P);
        studs(c, P, s.rivets || 8, 0.65, 0.07, Math.PI / (s.rivets || 8));
    },
    // a trimmed rim with clamps and a boss
    trim(c, P, s) {
        annulus(c, 0.7, 0.92); up(c, P);
        const n = s.rivets || 6;
        for (let i = 0; i < n; i++) {
            c.save(); c.rotate((i / n) * TAU);
            c.beginPath(); c.rect(0.62, -0.1, 0.4, 0.2); dn(c, P, OW * 0.8);
            c.restore();
        }
        disc(c, 0, 0, 0.28); up(c, P);
        disc(c, 0, 0, 0.11); dn(c, P);
    },
    camo(c, P, s, rnd) {
        const B = [[-0.55, -0.5, 0.4, 0], [0.45, -0.62, 0.34, 1], [0.12, 0.2, 0.42, 0], [-0.78, 0.42, 0.32, 1],
            [0.86, 0.34, 0.32, 1], [-0.1, -1.08, 0.28, 0], [0.3, 0.98, 0.3, 1], [-1.08, -0.18, 0.24, 0]];
        for (const [x, y, r, k] of B) { blob(c, rnd, x, y, r); paint(c, k ? P.DD : P.D, P.K, OW * 0.7); }
    },
    strata(c, P) {
        const bands = [[-0.62, P.D], [-0.04, P.L], [0.56, P.D]];
        for (let i = 0; i < bands.length; i++) { wave(c, bands[i][0], 0.16, 0.09, 2.4, i * 1.7); paint(c, bands[i][1], P.K, OW * 0.8); }
    },
    // armour plates: a hex grid, a few plates darker, the middle one raised
    hex(c, P, s) {
        const R = s.scale || 0.36, w = Math.sqrt(3) * R;
        for (let row = -4; row <= 4; row++) {
            for (let col = -4; col <= 4; col++) {
                const x = col * w + (row & 1 ? w / 2 : 0), y = row * 1.5 * R;
                if (x * x + y * y > 2.2) continue;
                hexagon(c, x, y, R * 0.9, Math.PI / 6);
                const mid = row === 0 && col === 0;
                paint(c, mid ? P.L : ((row + col * 2) % 3 === 0 ? P.D : null), P.K, OW * (mid ? 1 : 0.7));
            }
        }
    },
    chevrons(c, P) {
        c.lineJoin = 'miter';
        for (let k = -1; k <= 1; k++) { const x0 = k * 0.52 + 0.08; band(c, [[x0 - 0.34, -1.3], [x0 + 0.22, 0], [x0 - 0.34, 1.3]], 0.19, P.L, P.K); }
        c.lineJoin = 'round';
    },
    sunburst(c, P) {
        const n = 16;
        c.beginPath();
        for (let i = 0; i < n; i += 2) { c.moveTo(0, 0); c.arc(0, 0, 2, (i / n) * TAU, ((i + 1) / n) * TAU); c.closePath(); }
        dn(c, P, OW * 0.6);
        disc(c, 0, 0, 0.3); up(c, P);
    },
    quarters(c, P) {
        c.rotate(Math.PI / 4);
        c.beginPath(); c.rect(0, 0, 3, 3); c.rect(-3, -3, 3, 3);
        dn(c, P);
        disc(c, 0, 0, 0.16); hi(c, P);
    },
    pinwheel(c, P) {
        c.beginPath();
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * TAU;
            c.moveTo(0, 0); c.lineTo(Math.cos(a) * 1.5, Math.sin(a) * 1.5); c.arc(0, 0, 1.5, a, a + 0.72);
            const q = pol(0.62, a + 0.95); c.quadraticCurveTo(q[0], q[1], 0, 0); c.closePath();
        }
        up(c, P);
        disc(c, 0, 0, 0.16); dn(c, P);
    },
    tiger(c, P) {
        c.beginPath();
        for (let k = -3; k <= 3; k++) {
            for (const sg of [-1, 1]) {
                const x = k * 0.4 + (sg > 0 ? 0.2 : 0), len = (k + sg) & 1 ? 1.0 : 1.22;
                const y0 = sg * 1.35, tip = sg * (1.35 - len), bend = 0.12;
                c.moveTo(x - 0.15, y0);
                c.quadraticCurveTo(x - 0.12 + bend, (y0 + tip) / 2, x + bend * 1.5, tip);
                c.quadraticCurveTo(x + 0.1 + bend, (y0 + tip) / 2, x + 0.15, y0);
                c.closePath();
            }
        }
        paint(c, P.DD, P.K, OW * 0.6);
    },
    // a chip with traces running out to pads
    circuit(c, P) {
        for (let i = 0; i < 4; i++) {
            c.save(); c.rotate((i / 4) * TAU + Math.PI / 4);
            for (const sg of [-1, 1]) {
                const pts = [[0.3, sg * 0.1], [0.55, sg * 0.1], [0.72, sg * 0.28]];
                line(c, pts, 0.13, P.K); line(c, pts, 0.055, P.LL);
                disc(c, 0.72, sg * 0.28, 0.075); hi(c, P, OW * 0.7);
            }
            c.restore();
        }
        c.beginPath(); c.rect(-0.34, -0.34, 0.68, 0.68); dn(c, P);
        c.beginPath(); c.rect(-0.18, -0.18, 0.36, 0.36); up(c, P);
    },
    // a cut crystal in the middle, small facets round it
    facets(c, P) {
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * TAU + Math.PI / 4, p = pol(0.8, a);
            poly(c, [pol(0.66, a), [p[0] + Math.cos(a + 1.57) * 0.12, p[1] + Math.sin(a + 1.57) * 0.12], pol(0.94, a), [p[0] - Math.cos(a + 1.57) * 0.12, p[1] - Math.sin(a + 1.57) * 0.12]]);
            dn(c, P, OW * 0.7);
        }
        const n = 8, R = 0.56;
        for (let i = 0; i < n; i++) {
            poly(c, [[0, 0], pol(R, (i / n) * TAU), pol(R, ((i + 1) / n) * TAU)]);
            paint(c, i & 1 ? P.L : P.LL, P.K, OW * 0.6);
        }
        poly(c, Array.from({ length: n }, (_, i) => pol(R, (i / n) * TAU)));
        paint(c, null, P.K);
    },
    // pale veins branching across, with nuggets where they meet
    vein(c, P) {
        const V = [[[-1.3, 0.5], [-0.6, 0.2], [-0.1, 0.42], [0.5, -0.1], [1.3, -0.3]], [[-0.6, 0.2], [-0.5, -0.5], [-0.8, -1.1]], [[0.5, -0.1], [0.7, 0.6], [0.5, 1.2]]];
        for (const p of V) band(c, p, 0.1, P.LL, P.K);
        for (const [x, y] of [[-0.6, 0.2], [0.5, -0.1], [-0.1, 0.42]]) { disc(c, x, y, 0.12); hi(c, P); }
    },
    // a brilliant-cut gem crest
    gem(c, P) {
        annulus(c, 0.68, 0.84); dn(c, P);
        const R = 0.58, r = 0.3, rot = Math.PI / 6;
        for (let i = 0; i < 6; i++) {
            const a0 = rot + (i / 6) * TAU, a1 = rot + ((i + 1) / 6) * TAU;
            poly(c, [pol(r, a0), pol(R, a0), pol(R, a1), pol(r, a1)]);
            paint(c, i & 1 ? P.L : P.D, P.K, OW * 0.6);
        }
        hexagon(c, 0, 0, r, rot); hi(c, P);
    },
    // a toothy crystal ring round the bare hull (a geode cut open)
    geode(c, P) {
        disc(c, 0, 0, 0.9); dn(c, P);
        star(c, 14, 0.46, 0.8, 0); hi(c, P, OW * 0.7);
        disc(c, 0, 0, 0.42); paint(c, P.T, P.K);
    },
    // a gear rim with a crystal cluster
    gear(c, P) {
        const n = 14;
        for (let i = 0; i < n; i++) { c.save(); c.rotate((i / n) * TAU); c.beginPath(); c.rect(0.7, -0.1, 0.32, 0.2); up(c, P, OW * 0.8); c.restore(); }
        annulus(c, 0.56, 0.8); up(c, P);
        for (const [x, y, k, a] of [[0, -0.1, 0.34, 0], [-0.2, 0.16, 0.24, -0.5], [0.22, 0.16, 0.24, 0.5]]) {
            const cs = Math.cos(a), sn = Math.sin(a), q = (px, py) => [x + px * cs - py * sn, y + px * sn + py * cs];
            poly(c, [q(0, -k), q(k * 0.5, 0), q(0, k * 0.7), q(-k * 0.5, 0)]); hi(c, P, OW * 0.7);
        }
    },
    bolt(c, P) {
        disc(c, 0, 0, 0.7); dn(c, P);
        bolt(c, 0.78, 0.25); hi(c, P);
    },
    spiral(c, P, s) {
        const arms = s.arms || 2;
        for (let k = 0; k < arms; k++) band(c, spiralArm(k, 0, arms, 3.2), 0.15, P.L, P.K);
        disc(c, 0, 0, 0.26); dn(c, P);
        disc(c, 0, 0, 0.1); hi(c, P);
    },
    // three thick arms winding into a glowing core
    molten(c, P, s) {
        const arms = s.arms || 3;
        for (let k = 0; k < arms; k++) band(c, spiralArm(k, 0, arms, 3.0), 0.2, P.D, P.K);
        for (let k = 0; k < arms; k++) line(c, spiralArm(k, 0, arms, 3.0), 0.06, P.L);
        disc(c, 0, 0, 0.3); hi(c, P);
        disc(c, 0, 0, 0.12); up(c, P);
    },
    // crossed bars through a ring
    crosshair(c, P) {
        annulus(c, 0.54, 0.7); up(c, P);
        c.beginPath();
        for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU + Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a); c.moveTo(0.26 * cs + 0.08 * sn, 0.26 * sn - 0.08 * cs); c.lineTo(1 * cs + 0.08 * sn, 1 * sn - 0.08 * cs); c.lineTo(1 * cs - 0.08 * sn, 1 * sn + 0.08 * cs); c.lineTo(0.26 * cs - 0.08 * sn, 0.26 * sn + 0.08 * cs); c.closePath(); }
        hi(c, P, OW * 0.8);
        disc(c, 0, 0, 0.13); dn(c, P);
    },
    // a vault door: bolted rim, three spokes, a hub
    vault(c, P) {
        annulus(c, 0.62, 0.92); dn(c, P);
        studs(c, P, 8, 0.77, 0.07, 0);
        c.beginPath();
        for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU - Math.PI / 2, cs = Math.cos(a), sn = Math.sin(a); c.moveTo(-0.07 * sn, 0.07 * cs); c.lineTo(0.62 * cs - 0.07 * sn, 0.62 * sn + 0.07 * cs); c.lineTo(0.62 * cs + 0.07 * sn, 0.62 * sn - 0.07 * cs); c.lineTo(0.07 * sn, -0.07 * cs); c.closePath(); }
        up(c, P, OW * 0.8);
        disc(c, 0, 0, 0.22); up(c, P);
        disc(c, 0, 0, 0.09); dn(c, P);
    },
    cracks(c, P) {
        const seams = crackSeams();
        for (const p of seams) line(c, p, 0.24, P.K);
        for (const p of seams) line(c, p, 0.12, P.DD);
        disc(c, 0, 0, 0.26); paint(c, P.DD, P.K);
    },
    // a six-armed snowflake
    frost(c, P) {
        for (let i = 0; i < 6; i++) {
            c.save(); c.rotate((i / 6) * TAU);
            band(c, [[0.2, 0], [0.92, 0]], 0.1, P.LL, P.K);
            band(c, [[0.5, 0], [0.7, 0.18]], 0.07, P.LL, P.K);
            band(c, [[0.5, 0], [0.7, -0.18]], 0.07, P.LL, P.K);
            c.restore();
        }
        hexagon(c, 0, 0, 0.26, 0); up(c, P);
    },
    // drill flutes winding in
    drill(c, P) {
        const n = 6;
        for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU;
            c.beginPath();
            c.moveTo(0, 0);
            const p1 = pol(1.5, a), cp = pol(0.9, a + 0.55), p2 = pol(1.5, a + TAU / n * 0.55);
            c.quadraticCurveTo(cp[0] * 0.6, cp[1] * 0.6, p1[0], p1[1]);
            c.lineTo(p2[0], p2[1]);
            c.quadraticCurveTo(cp[0] * 0.75, cp[1] * 0.75, 0, 0);
            c.closePath();
            paint(c, i & 1 ? P.L : P.D, P.K, OW * 0.8);
        }
        disc(c, 0, 0, 0.24); paint(c, P.DD, P.K);
        disc(c, 0, 0, 0.09); hi(c, P);
    },
    // three blades
    shards(c, P) {
        for (let k = 0; k < 3; k++) {
            const a = (k / 3) * TAU;
            poly(c, [pol(0.12, a - 0.5), pol(0.72, a - 0.24), pol(1.35, a), pol(0.72, a + 0.24), pol(0.12, a + 0.5)]);
            up(c, P);
            poly(c, [pol(0.3, a), pol(0.72, a - 0.1), pol(1.1, a), pol(0.72, a + 0.1)]);
            paint(c, P.LL, null);
        }
        disc(c, 0, 0, 0.2); dn(c, P);
    },
    // a storm cloud with a bolt under it
    storm(c, P) {
        cloud(c); dn(c, P);
        c.save(); c.translate(0.04, 0.48); bolt(c, 0.45, 0.2); hi(c, P); c.restore();
    },
    // a star crest in a studded ring
    gilded(c, P) {
        annulus(c, 0.66, 0.84); up(c, P);
        studs(c, P, 10, 0.75, 0.05, 0, P.D);
        star(c, 5, 0.24, 0.54, -Math.PI / 2); hi(c, P);
    },
    // a heart crest in a ring of studs
    heart(c, P) {
        annulus(c, 0.68, 0.86); dn(c, P);
        studs(c, P, 8, 0.77, 0.07, Math.PI / 8);
        c.save(); c.rotate(Math.PI / 2); heartPath(c, 1.05); hi(c, P);
        heartPath(c, 0.5); paint(c, P.L, null); c.restore();
    },
    aurora(c, P) {
        const bands = [P.L, P.LL, P.L];
        for (let i = 0; i < 3; i++) { wave(c, -0.52 + i * 0.52, 0.12, 0.13, 2.2, i * 1.3); paint(c, bands[i], P.K, OW * 0.8); }
    },
    // a faceted ring of light and dark wedges
    prism(c, P) {
        const n = 12, cols = [P.L, P.D, P.LL];
        for (let i = 0; i < n; i++) {
            const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
            c.beginPath(); c.arc(0, 0, 0.92, a0, a1); c.arc(0, 0, 0.5, a1, a0, true); c.closePath();
            paint(c, cols[i % 3], P.K, OW * 0.7);
        }
        hexagon(c, 0, 0, 0.26, 0); up(c, P);
    },
    // an eight-point star in a ring
    nova(c, P) {
        annulus(c, 0.74, 0.9); up(c, P);
        star(c, 8, 0.3, 0.68, 0); hi(c, P);
        disc(c, 0, 0, 0.16); up(c, P);
    },
    // an eye that watches back
    void(c, P) {
        annulus(c, 0.78, 0.94); dn(c, P);
        c.save(); c.rotate(Math.PI / 2);
        eyePath(c, 0.7, 0.3); hi(c, P);
        disc(c, 0, 0, 0.27); paint(c, P.DD, P.K);
        disc(c, 0, 0, 0.11); paint(c, P.K, null);
        disc(c, -0.09, -0.09, 0.055); paint(c, P.LL, null);
        c.restore();
    },
};

const GLOW = {
    cracks(g, P, s, col) {
        for (const p of crackSeams()) line(g, p, 0.1, col);
        disc(g, 0, 0, 0.2); paint(g, col, null);
    },
    shards(g, P, s, col) {
        for (let k = 0; k < 3; k++) {
            const a = (k / 3) * TAU;
            poly(g, [pol(0.12, a - 0.5), pol(0.72, a - 0.24), pol(1.35, a), pol(0.72, a + 0.24), pol(0.12, a + 0.5)]);
            paint(g, mix(col, '#000000', 0.45), null);
        }
    },
    storm(g, P, s, col) {
        g.translate(0.04, 0.48); bolt(g, 0.45, 0.2); paint(g, col, null);
    },
    molten(g, P, s, col) {
        const arms = s.arms || 3;
        for (let k = 0; k < arms; k++) line(g, spiralArm(k, 0, arms, 3.0), 0.08, col);
        disc(g, 0, 0, 0.3); paint(g, col, null);
    },
    aurora(g, P, s, col) {
        for (let i = 0; i < 3; i++) { wave(g, -0.52 + i * 0.52, 0.1, 0.13, 2.2, i * 1.3); paint(g, mix(col, '#000000', 0.35), null); }
    },
    nova(g, P, s, col) {
        annulus(g, 0.76, 0.88); paint(g, col, null);
        star(g, 8, 0.3, 0.68, 0); paint(g, mix(col, '#000000', 0.5), null);
    },
    void(g, P, s, col) {
        annulus(g, 0.8, 0.92); paint(g, col, null);
        g.rotate(Math.PI / 2); eyePath(g, 0.7, 0.3); paint(g, mix(col, '#000000', 0.6), null);
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

const GLOW_KINDS = { pulse: 1, spinGlow: 1, spiral: 1, flash: 1, shift: 1 };
function buildTile(it, teamHex, px) {
    const s = it.skin;
    const [cv, c] = mkCanvas(px);
    const P = paletteFor(teamHex);
    const em = s.emissive;
    let glow = null, glow2 = null;
    try {
        const painter = PAINT[s.pattern];
        if (painter) { c.save(); painter(c, P, s, mulberry32(s.seed | 0)); c.restore(); }
        const gp = GLOW[s.pattern];
        if (em && GLOW_KINDS[em.kind] && gp) {
            const gpx = Math.min(px, GLOW_MAX);
            const g1 = mkCanvas(gpx);
            gp(g1[1], P, s, P.G);
            glow = g1[0];
            if (em.kind === 'shift') {
                const g2 = mkCanvas(gpx);
                gp(g2[1], P, s, P.G2);
                glow2 = g2[0];
            }
        }
    } catch (e) { console.error('[cosmetics] skin paint failed', s.pattern, e); }
    // the twinkle's sparkles: a pale tint of the team colour, picked once
    return { cv, glow, glow2, spark: P.G2, area: areaOf(it, px), used: 0 };
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
    if (!em || !GLOW_KINDS[em.kind] || !GLOW[it.skin.pattern]) return px * px;
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

// The light band a shimmer sweeps across the hull (built once).
let bandCv = null;
function shimmerBand() {
    if (!bandCv) {
        bandCv = plainCanvas(32, 1);
        const c = bandCv.getContext('2d');
        const g = c.createLinearGradient(0, 0, 32, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, 32, 1);
    }
    return bandCv;
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
            c.globalCompositeOperation = 'lighter';
            sparkles(c, it, r, still ? 0.2 : t, a0 * 0.9, tile.spark);
            c.globalCompositeOperation = 'source-over';
        } else if (em.kind === 'shimmer') {
            const every = Math.max(1, em.every || 3), p = (t % every) / 0.9;
            if (!still && p < 1) {
                c.rotate(-0.5);
                c.globalAlpha = a0 * 0.4;
                c.drawImage(shimmerBand(), -1.6 * R + 3.2 * R * p - 0.3 * R, -1.5 * R, 0.6 * R, 3 * R);
            }
        } else if (tile.glow && !glowOff()) {
            let a = 0.55;
            if (!still) {
                if (em.kind === 'pulse') a = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(t * sp * TAU));
                else if (em.kind === 'flash') {
                    const ph = (t * sp) % 1;
                    a = Math.max(0, 1 - Math.abs(ph - 0.03) / 0.03) + 0.7 * Math.max(0, 1 - Math.abs(ph - 0.12) / 0.035);
                } else if (em.kind === 'spinGlow') {
                    c.rotate(t * sp * TAU);
                    a = 0.5 + 0.2 * Math.sin(t * sp * Math.PI * 4);
                } else if (em.kind === 'spiral') a = 0.4 + 0.3 * Math.sin(t * sp * Math.PI * 4);
            } else if (em.kind === 'flash') a = 0.3;
            c.globalCompositeOperation = 'lighter';
            if (em.kind === 'shift' && tile.glow2) {
                const w = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * sp * TAU);
                c.globalAlpha = a0 * 0.5 * w;
                c.drawImage(tile.glow, -R, -R, 2 * R, 2 * R);
                c.globalAlpha = a0 * 0.5 * (1 - w);
                c.drawImage(tile.glow2, -R, -R, 2 * R, 2 * R);
            } else if (a > 0.01) {
                c.globalAlpha = a0 * Math.min(1, a);
                c.drawImage(tile.glow, -R, -R, 2 * R, 2 * R);
            }
            c.globalCompositeOperation = 'source-over';
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

// For tests / dev tools.
export function cacheSize() { return tileCount; }
