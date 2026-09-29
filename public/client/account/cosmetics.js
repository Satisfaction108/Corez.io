// Cosmetics drawing: tank skins (paintHull) and name styles (nameFill,
// nameFx), from the shared catalog (window.DWCosmetics). No DOM: app.js
// calls this every frame, so the hot paths allocate nothing.
// Skins: a flat pattern tile per skin + team colour + size bucket (32..256
// device px), in hull space, clipped to the hull path (same maths as
// drawBody in app.js). At most one tile is built per ~frame; until then the
// hull reuses another size of the same tile, or stays plain.
// Name styles: a small baked colour tile per style, laid over the text box
// as a CanvasPattern whose transform is moved (a reused DOMMatrix), so
// static and scrolling names alike cost no gradient a frame. The outline
// colour (rim) and the soft halo come from nameFx.
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

// Outline and halo for a style: { rim, halo, haloA }. One shared object,
// read it before the next call. The halo goes with No Glow; a pulse
// freezes with Fewer Effects.
const FX = { rim: null, halo: null, haloA: 0 };
export function nameFx(it, opts) {
    const s = it && it.style;
    FX.rim = (s && s.rim) || null;
    FX.halo = s && s.halo && !glowOff() ? s.halo : null;
    FX.haloA = 0.32;
    if (FX.halo && s.pulse && !(opts && opts.still) && !fewerFx()) {
        const t = opts && opts.time != null ? opts.time : performance.now() / 1000;
        FX.haloA = 0.18 + 0.26 * (0.5 + 0.5 * Math.sin(t * s.pulse * TAU));
    }
    return FX;
}
// The halo under a name's outline: two wider, see-through strokes (width
// and alpha multipliers over the outline's), a cheap stand-in for a blur.
export const HALO_PASSES = [[2.8, 0.5], [1.8, 1]];

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
        if (fx.halo) {
            const ga = c.globalAlpha;
            c.strokeStyle = fx.halo;
            for (const [w, a] of HALO_PASSES) {
                c.globalAlpha = ga * fx.haloA * a;
                c.lineWidth = lw * w;
                c.strokeText(name + glyph, left, y);
            }
            c.globalAlpha = ga;
        }
        c.lineWidth = lw;
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
function octagon(c, hw, hh, cut) {
    poly(c, [[-hw + cut, -hh], [hw - cut, -hh], [hw, -hh + cut], [hw, hh - cut], [hw - cut, hh], [-hw + cut, hh], [-hw, hh - cut], [-hw, -hh + cut]]);
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
const edgeOf = (col) => mix(col, '#000000', 0.32);

// Colours a pattern paints with: shades of the team colour + the accents.
function paletteFor(it, teamHex) {
    const s = it.skin, cat = CAT();
    const A = cat && cat.accentFor ? cat.accentFor(it, teamHex) : s.accent;
    const A2 = (cat && cat.accent2For && cat.accent2For(it, teamHex)) || s.accent2 || mix(A, teamHex, 0.45);
    return {
        T: teamHex, Td: mix(teamHex, '#000000', 0.28), Tdd: mix(teamHex, '#000000', 0.5), Tl: mix(teamHex, '#ffffff', 0.3),
        A, Ad: edgeOf(A), Al: mix(A, '#ffffff', 0.45),
        A2, A2d: edgeOf(A2), A2l: mix(A2, '#ffffff', 0.45),
    };
}

// Each painter draws the flat pattern in hull space; GLOW painters draw the
// matching emissive layer (additive, dropped with No Glow).
const PAINT = {
    stripes(c, P, s) {
        const w = s.scale || 0.3;
        c.rotate(((s.angle == null ? 45 : s.angle) * Math.PI) / 180);
        c.beginPath();
        for (let x = -2.6 + w / 2; x < 2.6; x += 2 * w) c.rect(x, -3, w, 6);
        paint(c, P.A, P.Ad);
    },
    racer(c, P) {
        c.beginPath();
        c.rect(-3, -0.36, 6, 0.22);
        c.rect(-3, 0.14, 6, 0.22);
        paint(c, P.A, P.Ad);
    },
    halves(c, P) {
        c.beginPath();
        c.rect(-3, 0, 6, 3);
        paint(c, P.A, P.Ad, OW * 1.3);
    },
    quarters(c, P) {
        c.rotate(Math.PI / 4);
        c.beginPath();
        c.rect(0, 0, 3, 3);
        c.rect(-3, -3, 3, 3);
        paint(c, P.A, P.Ad);
    },
    checker(c, P, s) {
        const cs = s.scale || 0.5;
        c.rotate(Math.PI / 4);
        c.beginPath();
        for (let j = -6; j < 6; j++) for (let i = -6; i < 6; i++) if ((i + j) & 1) c.rect(i * cs, j * cs, cs, cs);
        paint(c, P.A, P.Ad, OW * 0.8);
    },
    rings(c, P) {
        annulus(c, 0.56, 0.8);
        paint(c, P.A, P.Ad);
        disc(c, 0, 0, 0.3);
        paint(c, P.A, P.Ad);
    },
    rim(c, P, s) {
        annulus(c, 0.68, 1.4);
        paint(c, P.A, P.Ad);
        const n = s.rivets | 0;
        for (let i = 0; i < n; i++) {
            const p = pol(0.84, (i + 0.5) * (TAU / n));
            disc(c, p[0], p[1], 0.075);
            paint(c, P.A2, P.Ad, OW * 0.7);
        }
        if (s.core) { disc(c, 0, 0, 0.24); paint(c, P.A, P.Ad); }
    },
    core(c, P) {
        disc(c, 0, 0, 0.42);
        paint(c, P.A, P.Ad);
    },
    dots(c, P, s) {
        const sp = s.scale || 0.56, r = sp * 0.27;
        c.beginPath();
        for (let j = -4; j <= 4; j++) {
            const y = j * sp * 0.866;
            for (let i = -4; i <= 4; i++) {
                const x = i * sp + (j & 1 ? sp / 2 : 0);
                c.moveTo(x + r, y);
                c.arc(x, y, r, 0, TAU);
            }
        }
        paint(c, P.A, P.Ad, OW * 0.8);
    },
    chevrons(c, P) {
        c.lineJoin = 'miter';
        for (let k = -1; k <= 1; k++) {
            const x0 = k * 0.52 + 0.08;
            band(c, [[x0 - 0.34, -1.3], [x0 + 0.22, 0], [x0 - 0.34, 1.3]], 0.19, P.A, P.Ad);
        }
        c.lineJoin = 'round';
    },
    sash(c, P, s) {
        c.rotate(((s.angle == null ? -35 : s.angle) * Math.PI) / 180);
        c.beginPath();
        c.rect(-3, -0.22, 6, 0.44);
        paint(c, P.A, P.Ad);
    },
    sunburst(c, P) {
        const n = 12;
        c.beginPath();
        for (let i = 0; i < n; i += 2) {
            c.moveTo(0, 0);
            c.arc(0, 0, 2, (i / n) * TAU, ((i + 1) / n) * TAU);
            c.closePath();
        }
        paint(c, P.A, P.Ad, OW * 0.8);
        disc(c, 0, 0, 0.22);
        paint(c, P.A, P.Ad);
    },
    pinwheel(c, P) {
        c.beginPath();
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * TAU;
            c.moveTo(0, 0);
            c.lineTo(Math.cos(a) * 1.5, Math.sin(a) * 1.5);
            c.arc(0, 0, 1.5, a, a + 0.72);
            const q = pol(0.62, a + 0.95);
            c.quadraticCurveTo(q[0], q[1], 0, 0);
            c.closePath();
        }
        paint(c, P.A, P.Ad);
        disc(c, 0, 0, 0.16);
        paint(c, P.A, P.Ad);
    },
    tiger(c, P) {
        // tapered stripes reaching in from both flanks, staggered
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
        paint(c, P.A, P.Ad, OW * 0.6);
    },
    camo(c, P, s, rnd) {
        const B = [[-0.55, -0.5, 0.42, 0], [0.45, -0.62, 0.36, 1], [0.12, 0.2, 0.44, 0], [-0.78, 0.42, 0.34, 1],
            [0.86, 0.34, 0.34, 1], [-0.1, -1.08, 0.3, 0], [0.3, 0.98, 0.32, 1], [-1.08, -0.18, 0.26, 0]];
        for (const [x, y, r, k] of B) {
            blob(c, rnd, x, y, r);
            const col = k ? P.A2 : P.A;
            paint(c, col, edgeOf(col), OW * 0.8);
        }
    },
    strata(c, P) {
        const bands = [[-0.62, P.A], [-0.04, P.A2], [0.56, P.A]];
        for (let i = 0; i < bands.length; i++) {
            wave(c, bands[i][0], 0.17, 0.09, 2.4, i * 1.7);
            paint(c, bands[i][1], edgeOf(bands[i][1]), OW * 0.8);
        }
    },
    hex(c, P, s) {
        const R = s.scale || 0.36, w = Math.sqrt(3) * R;
        c.beginPath();
        for (let row = -5; row <= 5; row++) {
            for (let col = -5; col <= 5; col++) {
                const cx = col * w + (row & 1 ? w / 2 : 0), cy = row * 1.5 * R;
                if (Math.abs(cx) > E + R || Math.abs(cy) > E + R) continue;
                for (let i = 0; i <= 6; i++) {
                    const a = Math.PI / 6 + (i * Math.PI) / 3;
                    if (i) c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
                    else c.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
                }
            }
        }
        c.lineWidth = 0.1;
        c.strokeStyle = P.A;
        c.stroke();
        c.beginPath();
        for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; c.lineTo(Math.cos(a) * R, Math.sin(a) * R); }
        c.closePath();
        paint(c, P.A, null);
    },
    circuit(c, P) {
        // two mirrored traces per quarter, turned four times
        const T1 = [[0.3, 0.12], [0.6, 0.12], [0.9, 0.42], [1.4, 0.42]];
        const T2 = [[0.12, 0.3], [0.12, 0.62], [0.42, 0.92]];
        const rotp = (p, k) => { const a = (k * Math.PI) / 2, cs = Math.cos(a), sn = Math.sin(a); return [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs]; };
        for (let k = 0; k < 4; k++) {
            band(c, T1.map((p) => rotp(p, k)), 0.09, P.A, P.Ad);
            band(c, T2.map((p) => rotp(p, k)), 0.09, P.A, P.Ad);
        }
        for (let k = 0; k < 4; k++) {
            for (const p of [[0.9, 0.42], [0.42, 0.92]]) {
                const q = rotp(p, k);
                disc(c, q[0], q[1], 0.1);
                paint(c, P.A, P.Ad, OW * 0.8);
            }
        }
        c.beginPath();
        c.rect(-0.3, -0.3, 0.6, 0.6);
        paint(c, P.Ad, P.A, OW);
        disc(c, 0, 0, 0.1);
        paint(c, P.A, null);
    },
    facets(c, P) {
        // a cut crystal seen from above: an octagon table, then a ring of
        // triangles out to the rim in three tones
        const n = 8, ri = 0.42, ro = 1.45;
        const tones = [P.A, mix(P.A, P.T, 0.5), P.T];
        const inner = (i) => pol(ri, ((i + 0.5) / n) * TAU), outer = (i) => pol(ro, (i / n) * TAU);
        for (let i = 0; i < n; i++) {
            poly(c, [inner(i - 1), outer(i), inner(i)]);
            paint(c, tones[i & 1 ? 0 : 1], P.Ad, OW * 0.6);
            poly(c, [outer(i), inner(i), outer(i + 1)]);
            paint(c, tones[i & 1 ? 2 : 1], P.Ad, OW * 0.6);
        }
        const tab = [];
        for (let i = 0; i < n; i++) tab.push(inner(i));
        poly(c, tab);
        paint(c, P.Al, P.Ad, OW * 0.6);
    },
    vein(c, P) {
        const lode = [[-1.4, -0.62], [-0.62, -0.22], [-0.24, -0.48], [0.35, 0.05], [0.78, -0.16], [1.4, 0.3]];
        const branch = [[0.35, 0.05], [0.18, 0.56], [0.56, 0.95]];
        band(c, lode, 0.15, P.A, P.Ad);
        band(c, branch, 0.12, P.A, P.Ad);
        for (const [x, y, r] of [[-0.62, -0.22, 0.12], [0.35, 0.05, 0.14], [0.78, -0.16, 0.1], [0.18, 0.56, 0.1]]) {
            disc(c, x, y, r);
            paint(c, P.A, P.Ad, OW * 0.8);
            disc(c, x - r * 0.3, y - r * 0.3, r * 0.32);
            paint(c, P.Al, null);
        }
    },
    gem(c, P) {
        annulus(c, 0.6, 0.76);
        paint(c, P.A2, P.A2d);
        const n = 8, ro = 0.6, rt = 0.3;
        const o = [], tb = [];
        for (let i = 0; i < n; i++) { o.push(pol(ro, ((i + 0.5) / n) * TAU)); tb.push(pol(rt, ((i + 0.5) / n) * TAU)); }
        poly(c, o);
        paint(c, P.A, P.Ad);
        for (let i = 0; i < n; i++) {
            poly(c, [tb[i], o[i], o[(i + 1) % n], tb[(i + 1) % n]]);
            paint(c, i & 1 ? mix(P.A, '#ffffff', 0.18) : mix(P.A, '#000000', 0.1), P.Ad, OW * 0.5);
        }
        poly(c, tb);
        paint(c, mix(P.A, '#ffffff', 0.4), P.Ad, OW * 0.5);
        poly(c, [[-0.22, -0.34], [-0.06, -0.4], [-0.3, -0.12], [-0.4, -0.08]]);
        paint(c, 'rgba(255,255,255,0.85)', null);
    },
    geode(c, P) {
        annulus(c, 0.78, 1.4);
        paint(c, P.A2, edgeOf(P.A2));
        const n = 14;
        for (let i = 0; i < n; i++) {
            const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU, tip = i & 1 ? 0.5 : 0.6;
            poly(c, [pol(0.8, a0), pol(tip, (a0 + a1) / 2), pol(0.8, a1)]);
            paint(c, i & 1 ? P.A : P.Al, P.Ad, OW * 0.6);
        }
    },
    bolt(c, P) {
        c.lineJoin = 'miter';
        bolt(c, 1.1, 0.25);
        paint(c, P.A, P.Ad);
        c.lineJoin = 'round';
    },
    crosshair(c, P) {
        annulus(c, 0.5, 0.64);
        paint(c, P.A, P.Ad);
        c.beginPath();
        for (let i = 0; i < 4; i++) {
            c.save();
            c.rotate((i * Math.PI) / 2);
            c.rect(0.74, -0.07, 0.8, 0.14);
            c.rect(0.18, -0.06, 0.24, 0.12);
            c.restore();
        }
        paint(c, P.A, P.Ad);
        disc(c, 0, 0, 0.08);
        paint(c, P.A, P.Ad);
    },
    vault(c, P) {
        annulus(c, 0.7, 1.4);
        paint(c, P.A, P.Ad);
        for (let i = 0; i < 6; i++) {
            const p = pol(0.85, (i / 6) * TAU);
            disc(c, p[0], p[1], 0.075);
            paint(c, P.Al, P.Ad, OW * 0.7);
        }
        for (let i = 0; i < 3; i++) {
            const a = (i / 3) * TAU - Math.PI / 2;
            band(c, [pol(0.2, a), pol(0.56, a)], 0.1, P.A, P.Ad);
        }
        disc(c, 0, 0, 0.26);
        paint(c, P.A, P.Ad);
        for (let i = 0; i < 3; i++) {
            const p = pol(0.58, (i / 3) * TAU - Math.PI / 2);
            disc(c, p[0], p[1], 0.09);
            paint(c, P.A2, P.A2d, OW * 0.7);
        }
    },
    cracks(c, P) {
        // a charred crust split by five clean seams of heat
        c.fillStyle = mix(P.T, '#000000', 0.2);
        c.fillRect(-E, -E, 2 * E, 2 * E);
        const seams = crackSeams();
        for (const p of seams) line(c, p, 0.3, P.Tdd);
        for (const p of seams) line(c, p, 0.17, P.A);
        for (const p of seams) line(c, p, 0.06, P.A2);
        disc(c, 0, 0, 0.25); paint(c, P.Tdd, null);
        disc(c, 0, 0, 0.19); paint(c, P.A, null);
        disc(c, 0, 0, 0.09); paint(c, P.A2, null);
    },
    frost(c, P) {
        for (let k = 0; k < 6; k++) {
            const a = (k / 6) * TAU + Math.PI / 6;
            band(c, [[0, 0], pol(0.98, a)], 0.13, P.A, P.Ad);
            const b = pol(0.55, a);
            for (const sg of [-1, 1]) {
                const e = pol(0.3, a + sg * 0.9);
                band(c, [b, [b[0] + e[0], b[1] + e[1]]], 0.1, P.A, P.Ad);
            }
        }
        // redraw the arms over the branch outlines so the joints are clean
        for (let k = 0; k < 6; k++) line(c, [[0, 0], pol(0.98, (k / 6) * TAU + Math.PI / 6)], 0.13, P.A);
        const hx = [];
        for (let i = 0; i < 6; i++) hx.push(pol(0.22, (i / 6) * TAU));
        poly(c, hx);
        paint(c, P.A, P.Ad);
    },
    drill(c, P) {
        for (let k = 0; k < 4; k++) {
            const a = (k / 4) * TAU, pts = [];
            for (let i = 0; i <= 8; i++) { const f = i / 8; pts.push(pol(0.2 + f * 1.25, a + f * 1.1)); }
            for (let i = 8; i >= 0; i--) { const f = i / 8; pts.push(pol(0.2 + f * 1.25, a + 0.6 + f * 1.1)); }
            poly(c, pts);
            paint(c, P.A, P.Ad);
        }
        disc(c, 0, 0, 0.26);
        paint(c, P.A2, P.Ad);
        disc(c, 0, 0, 0.1);
        paint(c, P.A, null);
    },
    shards(c, P) {
        for (let k = 0; k < 3; k++) {
            const a = (k / 3) * TAU;
            const pts = [pol(0.12, a - 0.5), pol(0.72, a - 0.24), pol(1.35, a), pol(0.72, a + 0.24), pol(0.12, a + 0.5)];
            poly(c, pts);
            paint(c, P.A, null);
            poly(c, [pol(0.12, a), pol(1.35, a), pol(0.72, a + 0.24), pol(0.12, a + 0.5)]);
            paint(c, P.Al, null);
            poly(c, pts);
            paint(c, null, P.Ad);
        }
        disc(c, 0, 0, 0.16);
        paint(c, P.Al, P.Ad);
    },
    storm(c, P) {
        // a ring of cloud: outline first, then the fill over its inner half
        const puffs = [];
        for (let i = 0; i < 10; i++) puffs.push(pol(0.98, (i / 10) * TAU));
        c.beginPath();
        for (const p of puffs) { c.moveTo(p[0] + 0.27, p[1]); c.arc(p[0], p[1], 0.27, 0, TAU); }
        c.lineWidth = OW * 2; c.strokeStyle = P.Ad; c.stroke();
        c.fillStyle = P.A; c.fill();
        annulus(c, 0.98, 1.4);
        paint(c, P.A, null);
        c.lineJoin = 'miter';
        bolt(c, 0.62, 0.25);
        paint(c, P.A2, P.A2d);
        c.lineJoin = 'round';
    },
    gilded(c, P) {
        annulus(c, 0.74, 1.4);
        paint(c, P.A, P.Ad);
        star(c, 5, 0.22, 0.54, 0);
        paint(c, P.A, P.Ad);
    },
    heart(c, P) {
        // an emerald, step cut, in a gold bezel
        annulus(c, 0.64, 0.8);
        paint(c, P.A2, P.A2d);
        octagon(c, 0.52, 0.4, 0.15);
        paint(c, P.A, P.Ad);
        octagon(c, 0.36, 0.26, 0.1);
        paint(c, mix(P.A, '#ffffff', 0.22), P.Ad, OW * 0.5);
        octagon(c, 0.2, 0.12, 0.05);
        paint(c, mix(P.A, '#ffffff', 0.45), P.Ad, OW * 0.5);
        poly(c, [[-0.3, -0.33], [-0.12, -0.33], [-0.32, -0.12], [-0.42, -0.14]]);
        paint(c, 'rgba(255,255,255,0.8)', null);
    },
    spiral(c, P, s) {
        const arms = s.arms || 3, w = arms > 2 ? 0.16 : 0.22;
        for (let k = 0; k < arms; k++) band(c, spiralArm(k, 0, arms, 3.2), w, P.A, P.Ad);
        disc(c, 0, 0, 0.26);
        paint(c, P.A2, P.Ad);
    },
    aurora(c, P) {
        const cols = [P.A, mix(P.A, P.A2, 0.5), P.A2];
        for (let i = 0; i < 3; i++) {
            wave(c, -0.52 + i * 0.52, 0.12, 0.13, 2.2, i * 1.3);
            paint(c, cols[i], edgeOf(cols[i]), OW * 0.7);
        }
    },
    prism(c, P) {
        const n = 12;
        for (let i = 0; i < n; i++) {
            const col = toHex(...hsl(i / n, 0.78, 0.64));
            c.beginPath();
            c.arc(0, 0, 1.4, (i / n) * TAU, ((i + 1) / n) * TAU);
            c.arc(0, 0, 0.56, ((i + 1) / n) * TAU, (i / n) * TAU, true);
            c.closePath();
            paint(c, col, edgeOf(col), OW * 0.6);
        }
        disc(c, 0, 0, 0.56);
        paint(c, null, P.Tdd, OW);
    },
    nova(c, P) {
        star(c, 8, 0.46, 1.02, 0);
        paint(c, P.A, P.Ad);
        disc(c, 0, 0, 0.28);
        paint(c, P.A2, P.Ad);
    },
    void(c, P) {
        annulus(c, 0.6, 0.8);
        paint(c, P.A, P.Ad);
        disc(c, 0, 0, 0.6);
        paint(c, P.A2, null);
        disc(c, 0, 0, 0.6);
        paint(c, null, P.Ad);
    },
};

function crackSeams() {
    const out = [];
    const ang = [0.3, 1.55, 2.75, 3.95, 5.1];
    for (const a of ang) out.push([[0, 0], pol(0.5, a + 0.28), pol(0.86, a - 0.1), pol(1.5, a + 0.14)]);
    return out;
}

const GLOW = {
    cracks(g, P, s, col) {
        const seams = crackSeams();
        for (const p of seams) line(g, p, 0.34, mix(col, '#000000', 0.55));
        for (const p of seams) line(g, p, 0.16, col);
        disc(g, 0, 0, 0.28); paint(g, col, null);
    },
    shards(g, P, s, col) {
        for (let k = 0; k < 3; k++) {
            const a = (k / 3) * TAU;
            poly(g, [pol(0.12, a - 0.5), pol(0.72, a - 0.24), pol(1.35, a), pol(0.72, a + 0.24), pol(0.12, a + 0.5)]);
            paint(g, mix(col, '#000000', 0.35), null);
        }
    },
    storm(g, P, s, col) {
        bolt(g, 0.66, 0.25);
        paint(g, col, null);
    },
    spiral(g, P, s, col) {
        const arms = s.arms || 3;
        for (let k = 0; k < arms; k++) line(g, spiralArm(k, 0, arms, 3.2), 0.1, col);
        disc(g, 0, 0, 0.22); paint(g, col, null);
    },
    aurora(g, P, s, col) {
        for (let i = 0; i < 3; i++) {
            wave(g, -0.52 + i * 0.52, 0.12, 0.13, 2.2, i * 1.3);
            paint(g, mix(col, '#000000', 0.3), null);
        }
    },
    nova(g, P, s, col) {
        annulus(g, 0.78, 1.4);
        paint(g, col, null);
        star(g, 8, 0.4, 0.9, 0);
        paint(g, mix(col, '#000000', 0.5), null);
    },
    void(g, P, s, col) {
        annulus(g, 0.56, 0.92);
        paint(g, col, null);
    },
};

/* ── skins: tiles ───────────────────────────────────────────────────── */
const MAX_TILES = 96;
const tiles = new Map();    // team hex -> Map(nid -> [tile per size bucket])
let tileCount = 0, lastGen = -1e9;

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
    const P = paletteFor(it, teamHex);
    const em = s.emissive;
    let glow = null, glow2 = null;
    try {
        const painter = PAINT[s.pattern];
        if (painter) { c.save(); painter(c, P, s, mulberry32(s.seed | 0)); c.restore(); }
        const gp = GLOW[s.pattern];
        if (em && GLOW_KINDS[em.kind] && gp) {
            const gpx = Math.min(px, 128);
            const g1 = mkCanvas(gpx);
            gp(g1[1], P, s, em.color || '#ffffff');
            glow = g1[0];
            if (em.kind === 'shift' && em.color2) {
                const g2 = mkCanvas(gpx);
                gp(g2[1], P, s, em.color2);
                glow2 = g2[0];
            }
        }
    } catch (e) { console.error('[cosmetics] skin paint failed', s.pattern, e); }
    return { cv, glow, glow2 };
}

const bucketOf = (px) => (px <= 32 ? 0 : px <= 64 ? 1 : px <= 128 ? 2 : 3);
// A tile ready for this skin / colour / size, or null. `force` builds it
// now (menu previews); otherwise at most one build per ~frame.
function tileFor(it, teamHex, px, force) {
    if (tileCount > MAX_TILES) { tiles.clear(); tileCount = 0; }
    let byTeam = tiles.get(teamHex);
    if (!byTeam) { byTeam = new Map(); tiles.set(teamHex, byTeam); }
    let sizes = byTeam.get(it.nid);
    if (!sizes) { sizes = [null, null, null, null]; byTeam.set(it.nid, sizes); }
    const b = bucketOf(px);
    if (sizes[b]) return sizes[b];
    const now = performance.now();
    if (force || now - lastGen > 10) {
        lastGen = now;
        sizes[b] = buildTile(it, teamHex, px);
        tileCount++;
        return sizes[b];
    }
    // another size of the same tile, scaled, until this one gets its turn
    for (let i = 0; i < 4; i++) if (sizes[i]) return sizes[i];
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
function sparkles(c, it, r, t, alpha) {
    const em = it.skin.emissive, sp = spotsOf(it);
    c.fillStyle = em.color || '#ffffff';
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
    let px = 32;
    while (px < dev * 2 * E && px < 256) px *= 2;
    if (still && px > 128) px = 128;
    const tile = tileFor(it, team, px, o.force);
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
            sparkles(c, it, r, still ? 0.2 : t, a0 * 0.9);
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
