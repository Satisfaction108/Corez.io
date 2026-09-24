// Cosmetics drawing: tank skins (paintHull) and name styles (nameFill),
// from the shared catalog (shared/cosmetics.js -> window.DWCosmetics).
// No DOM: app.js calls this every frame, and the menu previews reuse it.
//
// Skins: a pattern tile per skin + team colour + power-of-two size bucket
// (32..256 device px), cached in a small LRU. The tile covers the hull's
// box in hull space, so it turns with the tank; paintHull clips it to the
// hull path (the same maths as drawBody in app.js), lays the emissive layer
// on top, then the blink overlays at the body's own mix strength, then
// re-strokes the rim for non-circles. At most one tile is built per frame;
// until then the hull reuses another size of the same tile, or stays plain.
//
// Name styles: nameFill returns a fill for drawText: a colour, or a linear
// gradient across the text box (drawText's own maths), scrolled over time
// for epic / legendary styles, with a glint sweep on legendaries. These
// canvas gradients are the only gradients in the account UI.
import { config } from '../config.js';

const CAT = () => (typeof window !== 'undefined' && window.DWCosmetics) || null;

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
const css = (v) => 'rgb(' + (v[0] | 0) + ',' + (v[1] | 0) + ',' + (v[2] | 0) + ')';
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

/* ── name styles ────────────────────────────────────────────────────── */
// Is this style animated (so previews keep redrawing)?
export function isAnimatedStyle(it) {
    const s = it && it.style;
    return !!s && (s.kind === 'scroll' || s.kind === 'prism' || !!s.glint);
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

const GLINT_SWEEP = 0.75;   // seconds a glint takes to cross the name
function glintAt(s, t) {
    if (!s.glint) return null;
    const every = Math.max(1, +s.glintEvery || 2.5);
    const p = (t % every) / GLINT_SWEEP;
    if (p >= 1) return null;
    return { c: -0.25 + 1.5 * p, b: 0.16 };
}
function baseColorAt(s, u, phase) {
    const st = s.stops;
    if (s.kind === 'prism') {
        const h = ((u - phase) % 1 + 1) % 1;
        return hsl(h, s.saturation == null ? 0.85 : s.saturation, s.lightness == null ? 0.68 : s.lightness);
    }
    let v = u;
    if (s.kind === 'scroll') v = ((u - phase) % 1 + 1) % 1;
    const n = st.length;
    if (n === 1) return rgb(st[0]);
    const f = Math.max(0, Math.min(1, v)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    return mixRgb(rgb(st[i]), rgb(st[i + 1]), f - i);
}

// fill for drawText over [left, left + width] (context units).
// opts: { time (s), still (freeze: low FX) }
export function nameFill(context, it, fallback, left, width, opts) {
    const s = it && it.style;
    if (!s || s.custom || !s.stops || !s.stops.length) return fallback;
    if (!(width > 1) || s.stops.length === 1) return s.stops[0];
    const still = !!(opts && opts.still);
    const t = still ? 0 : (opts && opts.time != null ? opts.time : performance.now() / 1000);
    const phase = s.kind === 'scroll' || s.kind === 'prism' ? t * (+s.speed || 0.3) : 0;
    const pos = [0, 1];
    if (s.kind === 'prism') {
        for (let i = 1; i < 12; i++) pos.push(i / 12);
    } else if (s.kind === 'scroll') {
        const n = s.stops.length - 1;
        for (let j = 0; j < n; j++) pos.push(((j / n + phase) % 1 + 1) % 1);
    } else {
        const n = s.stops.length - 1;
        for (let j = 1; j < n; j++) pos.push(j / n);
    }
    const g = still ? null : glintAt(s, t);
    if (g) for (const k of [-1, -0.5, 0, 0.5, 1]) { const p = g.c + k * g.b; if (p > 0 && p < 1) pos.push(p); }
    pos.sort((a, b) => a - b);
    const grad = context.createLinearGradient(left, 0, left + width, 0);
    let last = -1;
    for (const p of pos) {
        if (p - last < 1e-4) continue;
        last = p;
        let c = baseColorAt(s, p, phase);
        if (g) {
            const w = Math.max(0, 1 - Math.abs(p - g.c) / g.b);
            if (w > 0) c = mixRgb(c, [255, 255, 255], 0.85 * w * w * (3 - 2 * w));
        }
        grad.addColorStop(p, css(c));
    }
    return grad;
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
    if (opts.stroke) {
        c.lineJoin = 'round';
        c.lineCap = 'round';
        c.lineWidth = (px + 1) / config.graphical.fontStrokeRatio;
        c.strokeStyle = opts.strokeColor || '#131313';
        c.strokeText(name + glyph, left, y);
    }
    c.fillStyle = px < 8 ? solidOf(it, fallback) : nameFill(c, it, fallback, left, wName, opts);
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
    if (!p) {
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
        for (const [px, py] of sides) c.lineTo(x + r * (px * dx - py * dy), y + r * (py * dx + px * dy));
    } else {
        if (sides) angle += sides % 2 ? 0 : Math.PI / sides;
        if (!sides) {
            c.arc(x, y, r, 0, 2 * Math.PI);
        } else if (sides < 0) {
            sides = -sides;
            angle += (sides % 1) * Math.PI * 2;
            sides = Math.floor(sides);
            const dip = 1 - 6 / (sides * sides);
            c.moveTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
            for (let i = 0; i < sides; i++) {
                const ht = ((i + 0.5) / sides) * 2 * Math.PI + angle, th = ((i + 1) / sides) * 2 * Math.PI + angle;
                const cx = x + r * dip * Math.cos(ht), cy = y + r * dip * Math.sin(ht);
                const px = x + r * Math.cos(th), py = y + r * Math.sin(th);
                if (config.graphical.curvyTraps) c.quadraticCurveTo(cx, cy, px, py);
                else { c.lineTo(cx, cy); c.lineTo(px, py); }
            }
        } else {
            angle += (sides % 1) * Math.PI * 2;
            sides = Math.floor(sides);
            for (let i = 0; i < sides; i++) {
                const th = (i / sides) * 2 * Math.PI + angle;
                c.lineTo(x + r * Math.cos(th), y + r * Math.sin(th));
            }
        }
    }
    c.closePath();
    if (mode === 'clip') c.clip();
    else c.stroke();
}

/* ── skins: pattern tiles ───────────────────────────────────────────── */
const E = 1.25;             // the tile spans [-E, E] hull radii
const LRU_MAX = 48;
const tiles = new Map();    // key -> { cv, glow }
let lastGen = -1e9;

function lruGet(key) {
    const t = tiles.get(key);
    if (t) { tiles.delete(key); tiles.set(key, t); }
    return t;
}
function lruSet(key, t) {
    tiles.set(key, t);
    while (tiles.size > LRU_MAX) tiles.delete(tiles.keys().next().value);
}
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

// Colours a pattern paints with: shades of the team colour + the accent.
function paletteFor(it, teamHex) {
    const s = it.skin, cat = CAT();
    const A = (cat && cat.accentFor) ? cat.accentFor(it, teamHex) : s.accent;
    return {
        T: teamHex,
        Td: mix(teamHex, '#000000', 0.38),
        Tdd: mix(teamHex, '#000000', 0.6),
        Tl: mix(teamHex, '#ffffff', 0.35),
        A,
        A2: s.accent2 || mix(A, teamHex, 0.45),
        Ad: mix(A, '#000000', 0.45),
        Al: mix(A, '#ffffff', 0.5),
    };
}

function line(c, pts, w, col) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.lineWidth = w;
    c.strokeStyle = col;
    c.stroke();
}
function dot(c, x, y, r, col) {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = col;
    c.fill();
}
function blob(c, rnd, x, y, r, col) {
    const n = 11, pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, rr = r * (0.7 + 0.45 * rnd());
        pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
    }
    c.beginPath();
    // smooth closed curve through midpoints
    for (let i = 0; i <= n; i++) {
        const p = pts[i % n], q = pts[(i + 1) % n];
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        if (i === 0) c.moveTo(mx, my); else c.quadraticCurveTo(p[0], p[1], mx, my);
    }
    c.closePath();
    c.fillStyle = col;
    c.fill();
}
// A wandering crack / vein: a polyline from (x, y) heading `a`.
function walk(rnd, x, y, a, steps, len, wiggle) {
    const pts = [[x, y]];
    for (let i = 0; i < steps; i++) {
        a += (rnd() - 0.5) * wiggle;
        x += Math.cos(a) * len; y += Math.sin(a) * len;
        pts.push([x, y]);
    }
    return pts;
}

// Each painter draws in hull space ([-E, E]); `g` is the glow layer's
// context (only for skins with an emissive that uses a layer).
const PAINT = {
    stripes(c, P, s) {
        const w = s.scale || 0.35;
        c.save();
        c.rotate(((s.angle == null ? 45 : s.angle) * Math.PI) / 180);
        for (let x = -2 * E; x < 2 * E; x += 2 * w) {
            c.fillStyle = P.A;
            c.fillRect(x, -2 * E, w, 4 * E);
            c.fillStyle = P.Ad;
            c.fillRect(x + w - 0.035, -2 * E, 0.035, 4 * E);
        }
        c.restore();
    },
    rivets(c, P, s) {
        const g = (s.scale || 0.3) * 2.4;
        // bolted plates: every other plate a shade darker, a dark groove with
        // a light lip between them, a row of rivets along each seam
        for (let k = -3; k <= 3; k++) {
            const v = k * g + g / 2;
            if (k & 1) { c.fillStyle = P.Td; c.globalAlpha = 0.45; c.fillRect(-E, v, 2 * E, g); c.globalAlpha = 1; }
            line(c, [[-E, v], [E, v]], 0.075, P.Tdd);
            line(c, [[-E, v + 0.055], [E, v + 0.055]], 0.03, P.Tl);
        }
        for (let k = -3; k <= 3; k++) {
            const y = k * g + g / 2;
            for (let j = -4; j <= 4; j++) {
                const x = j * g * 0.5 + ((k & 1) ? g * 0.25 : 0);
                for (const yy of [y - 0.14, y + 0.17]) {
                    dot(c, x + 0.012, yy + 0.02, 0.085, P.Tdd);
                    dot(c, x, yy, 0.072, P.A);
                    dot(c, x - 0.022, yy - 0.025, 0.026, P.Al);
                }
            }
        }
    },
    camo(c, P, s, rnd) {
        const r = s.scale || 0.45;
        const cols = [P.A2, P.A, P.Td];
        for (let k = 0; k < cols.length; k++) {
            for (let i = 0; i < 7; i++) blob(c, rnd, (rnd() * 2 - 1) * E, (rnd() * 2 - 1) * E, r * (0.55 + 0.6 * rnd()), cols[k]);
        }
    },
    strata(c, P, s, rnd) {
        const step = s.scale || 0.22;
        const cols = [P.A, null, P.A2, P.Td, null, P.A, P.Tl, null];
        let prev = null;
        let k = 0;
        for (let y = -E - step; y <= E + step; y += step * (0.7 + 0.6 * rnd())) {
            const amp = 0.05 + 0.05 * rnd(), fr = 2 + 3 * rnd(), ph = rnd() * 6.28;
            const pts = [];
            for (let x = -E; x <= E + 0.01; x += 0.1) pts.push([x, y + amp * Math.sin(fr * x + ph)]);
            if (prev) {
                const col = cols[k++ % cols.length];
                if (col) {
                    c.beginPath();
                    c.moveTo(prev[0][0], prev[0][1]);
                    for (const p of prev) c.lineTo(p[0], p[1]);
                    for (let i = pts.length - 1; i >= 0; i--) c.lineTo(pts[i][0], pts[i][1]);
                    c.closePath();
                    c.fillStyle = col;
                    c.fill();
                }
                line(c, pts, 0.03, P.Tdd);
            }
            prev = pts;
        }
    },
    hex(c, P, s, rnd) {
        const R = s.scale || 0.28, w = Math.sqrt(3) * R;
        for (let row = -6; row <= 6; row++) {
            for (let col = -6; col <= 6; col++) {
                const cx = col * w + (row & 1 ? w / 2 : 0), cy = row * 1.5 * R;
                if (Math.abs(cx) > E + R || Math.abs(cy) > E + R) continue;
                c.beginPath();
                for (let i = 0; i < 6; i++) {
                    const a = Math.PI / 6 + (i * Math.PI) / 3;
                    c.lineTo(cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9);
                }
                c.closePath();
                const q = rnd();
                if (q < 0.22) { c.fillStyle = P.Tl; c.fill(); }
                else if (q < 0.34) { c.fillStyle = P.Td; c.fill(); }
                c.lineWidth = 0.05;
                c.strokeStyle = P.A;
                c.stroke();
            }
        }
    },
    circuit(c, P, s, rnd) {
        const st = s.scale || 0.2;
        const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
        const traces = [];
        for (let i = 0; i < 16; i++) {
            let x = Math.round((rnd() * 2 - 1) * E / st) * st, y = Math.round((rnd() * 2 - 1) * E / st) * st;
            let d = dirs[(rnd() * 4) | 0];
            const pts = [[x, y]];
            const n = 2 + ((rnd() * 4) | 0);
            for (let j = 0; j < n; j++) {
                const len = (1 + ((rnd() * 3) | 0)) * st;
                x += d[0] * len; y += d[1] * len;
                pts.push([x, y]);
                d = rnd() < 0.5 ? d : dirs[(rnd() * 8) | 0];
            }
            traces.push(pts);
        }
        for (const t of traces) line(c, t, 0.085, P.Tdd);
        for (const t of traces) line(c, t, 0.042, P.A);
        for (const t of traces) {
            for (const p of [t[0], t[t.length - 1]]) { dot(c, p[0], p[1], 0.075, P.Tdd); dot(c, p[0], p[1], 0.05, P.A); dot(c, p[0], p[1], 0.022, P.Tdd); }
        }
        // a chip in the middle
        c.fillStyle = P.Tdd;
        c.fillRect(-0.24, -0.24, 0.48, 0.48);
        c.lineWidth = 0.04; c.strokeStyle = P.A;
        c.strokeRect(-0.24, -0.24, 0.48, 0.48);
        for (let i = -1; i <= 1; i++) for (const sg of [-1, 1]) {
            line(c, [[i * 0.14, sg * 0.24], [i * 0.14, sg * 0.34]], 0.035, P.A);
            line(c, [[sg * 0.24, i * 0.14], [sg * 0.34, i * 0.14]], 0.035, P.A);
        }
    },
    facets(c, P, s, rnd) {
        const st = s.scale || 0.4, n = Math.ceil(E / st) + 1;
        const pt = [];
        for (let j = -n; j <= n; j++) {
            pt[j + n] = [];
            for (let i = -n; i <= n; i++) pt[j + n][i + n] = [i * st + (rnd() - 0.5) * st * 0.7, j * st + (rnd() - 0.5) * st * 0.7];
        }
        const tri = (a, b, d) => {
            c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineTo(d[0], d[1]); c.closePath();
            const q = rnd();
            c.fillStyle = q < 0.3 ? P.Tl : q < 0.55 ? mix(P.T, P.A, 0.45) : q < 0.75 ? P.Td : P.Al;
            c.fill();
            c.lineWidth = 0.028; c.strokeStyle = P.A; c.stroke();
        };
        for (let j = 0; j < 2 * n; j++) for (let i = 0; i < 2 * n; i++) {
            const a = pt[j][i], b = pt[j][i + 1], d = pt[j + 1][i], e = pt[j + 1][i + 1];
            if ((i + j) & 1) { tri(a, b, e); tri(a, e, d); } else { tri(a, b, d); tri(b, e, d); }
        }
    },
    vein(c, P, s, rnd) {
        const veins = [];
        const grow = (x, y, a, w, depth) => {
            const pts = walk(rnd, x, y, a, 5 + ((rnd() * 4) | 0), 0.14 + 0.05 * rnd(), 1.1);
            veins.push([pts, w]);
            if (depth < 2) for (let k = 1; k < pts.length - 1; k++) if (rnd() < 0.35) grow(pts[k][0], pts[k][1], a + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.6), w * 0.6, depth + 1);
        };
        for (let i = 0; i < 4; i++) { const a = rnd() * 6.28; grow(-Math.cos(a) * 1.2, -Math.sin(a) * 1.2, a + (rnd() - 0.5) * 0.8, 0.1, 0); }
        for (const [p, w] of veins) line(c, p, w + 0.05, P.Tdd);
        for (const [p, w] of veins) line(c, p, w, P.A);
        for (const [p, w] of veins) line(c, p, w * 0.35, P.Al);
        for (let i = 0; i < 7; i++) {
            const v = veins[(rnd() * veins.length) | 0][0], q = v[(rnd() * v.length) | 0];
            dot(c, q[0], q[1], 0.07, P.Tdd); dot(c, q[0], q[1], 0.052, P.A); dot(c, q[0] - 0.015, q[1] - 0.018, 0.018, '#ffffff');
        }
    },
    cracks(c, P, s, rnd, g, gcol) {
        const cracks = [];
        const grow = (x, y, a, w, depth) => {
            const pts = walk(rnd, x, y, a, 4 + ((rnd() * 4) | 0), 0.16, 1.4);
            cracks.push([pts, w]);
            if (depth < 2) for (let k = 1; k < pts.length; k++) if (rnd() < 0.4) grow(pts[k][0], pts[k][1], a + (rnd() < 0.5 ? -1 : 1) * (0.7 + rnd() * 0.7), w * 0.65, depth + 1);
        };
        for (let i = 0; i < 5; i++) { const a = (i / 5) * 6.28 + rnd() * 0.6; grow(Math.cos(a) * 0.12, Math.sin(a) * 0.12, a, 0.075, 0); }
        // a charred skin with the heat showing through
        for (const [p, w] of cracks) line(c, p, w + 0.08, P.Tdd);
        for (const [p, w] of cracks) line(c, p, w, P.A);
        for (const [p, w] of cracks) line(c, p, w * 0.35, P.A2);
        if (g) {
            for (const [p, w] of cracks) line(g, p, w + 0.2, mix(gcol, '#000000', 0.55));
            for (const [p, w] of cracks) line(g, p, w + 0.07, gcol);
        }
    },
    frost(c, P, s, rnd) {
        // pale haze, then six-armed frost crystals
        for (let i = 0; i < 6; i++) blob(c, rnd, (rnd() * 2 - 1) * E, (rnd() * 2 - 1) * E, 0.3 + 0.25 * rnd(), mix(P.T, '#ffffff', 0.25));
        const flakes = 7;
        for (let i = 0; i < flakes; i++) {
            const x = (rnd() * 2 - 1) * 1.05, y = (rnd() * 2 - 1) * 1.05, L = (s.scale || 0.3) * (1 + 0.8 * rnd()), a0 = rnd() * 1.05;
            for (let k = 0; k < 6; k++) {
                const a = a0 + (k * Math.PI) / 3, ca = Math.cos(a), sa = Math.sin(a);
                line(c, [[x, y], [x + ca * L, y + sa * L]], 0.1, P.Td);
                line(c, [[x, y], [x + ca * L, y + sa * L]], 0.055, P.A);
                for (const f of [0.45, 0.72]) {
                    const bx = x + ca * L * f, by = y + sa * L * f, bl = L * 0.3 * (1 - f * 0.5);
                    for (const sg of [-1, 1]) {
                        const b = a + sg * 0.9;
                        line(c, [[bx, by], [bx + Math.cos(b) * bl, by + Math.sin(b) * bl]], 0.04, P.A);
                    }
                }
            }
            dot(c, x, y, 0.045, P.Al);
        }
    },
    heart(c, P, s, rnd, g, gcol) {
        // gold setting ring with studs, the pentagon emerald in the middle
        const rays = 10;
        for (let i = 0; i < rays; i++) {
            const a = (i / rays) * Math.PI * 2;
            line(c, [[Math.cos(a) * 0.62, Math.sin(a) * 0.62], [Math.cos(a) * 1.3, Math.sin(a) * 1.3]], 0.06, mix(P.A, P.T, 0.35));
        }
        c.beginPath(); c.arc(0, 0, 0.6, 0, Math.PI * 2); c.lineWidth = 0.13; c.strokeStyle = P.Tdd; c.stroke();
        c.beginPath(); c.arc(0, 0, 0.6, 0, Math.PI * 2); c.lineWidth = 0.075; c.strokeStyle = P.A2; c.stroke();
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
            dot(c, Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.06, P.Tdd);
            dot(c, Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.042, mix(P.A2, '#ffffff', 0.35));
        }
        const k = 0.44, gem = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]].map(([x, y]) => [x * k, y * k + 0.04]);
        const poly = (pts, col) => { c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); c.fillStyle = col; c.fill(); };
        c.beginPath(); gem.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
        c.lineWidth = 0.1; c.strokeStyle = mix(P.A, '#000000', 0.55); c.stroke();
        poly(gem, P.A);
        poly([gem[0], gem[1], gem[2], gem[3]], mix(P.A, '#ffffff', 0.35));
        poly([gem[3], gem[4], [0, gem[0][1]]], mix(P.A, '#000000', 0.25));
        poly([[gem[1][0] + 0.06, gem[1][1] + 0.06], [gem[1][0] + 0.2, gem[1][1] + 0.06], [gem[0][0] + 0.2, gem[0][1] - 0.02]], 'rgba(255,255,255,0.8)');
        if (g) {
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * Math.PI * 2;
                g.beginPath(); g.moveTo(0, 0);
                g.arc(0, 0, 1.3, a - 0.16, a + 0.16);
                g.closePath(); g.fillStyle = mix(gcol, '#000000', 0.45); g.fill();
                g.beginPath(); g.moveTo(0, 0);
                g.arc(0, 0, 1.3, a - 0.06, a + 0.06);
                g.closePath(); g.fillStyle = gcol; g.fill();
            }
            dot(g, 0, 0, 0.34, mix(gcol, '#000000', 0.3));
        }
    },
    spiral(c, P, s, rnd, g, gcol) {
        const arms = 3, arm = (k, off) => {
            const pts = [];
            for (let i = 0; i <= 40; i++) {
                const f = i / 40, a = off + (k / arms) * Math.PI * 2 + f * 3.4, r = 0.12 + f * 1.15;
                pts.push([Math.cos(a) * r, Math.sin(a) * r]);
            }
            return pts;
        };
        for (let k = 0; k < arms; k++) line(c, arm(k, 0), 0.2, P.Tdd);
        for (let k = 0; k < arms; k++) line(c, arm(k, 0), 0.13, P.A);
        for (let k = 0; k < arms; k++) line(c, arm(k, 0), 0.05, P.A2);
        dot(c, 0, 0, 0.26, P.Tdd);
        dot(c, 0, 0, 0.21, P.A);
        dot(c, 0, 0, 0.12, P.A2);
        if (g) {
            for (let k = 0; k < arms; k++) line(g, arm(k, 0), 0.3, mix(gcol, '#000000', 0.55));
            for (let k = 0; k < arms; k++) line(g, arm(k, 0), 0.1, gcol);
            dot(g, 0, 0, 0.24, gcol);
        }
    },
};

const GLOW_LAYER = { pulse: true, spinGlow: true, spiral: true };

function buildTile(it, teamHex, px) {
    const s = it.skin;
    const [cv, c] = mkCanvas(px);
    const P = paletteFor(it, teamHex);
    const em = s.emissive;
    let gcv = null, g = null;
    if (em && GLOW_LAYER[em.kind]) [gcv, g] = mkCanvas(Math.min(px, 128));
    const painter = PAINT[s.pattern];
    if (painter) {
        try { painter(c, P, s, mulberry32(s.seed | 0), g, em && em.color); }
        catch (e) { console.error('[cosmetics] skin paint failed', s.pattern, e); }
    }
    return { cv, glow: gcv, P };
}

// A tile ready for this skin / colour / size, or null. `force` builds it
// now (menu previews); otherwise at most one build per ~frame.
function tileFor(it, teamHex, px, force) {
    const key = it.nid + '|' + teamHex + '|' + px;
    let t = lruGet(key);
    if (t) return t;
    const now = performance.now();
    if (force || now - lastGen > 10) {
        lastGen = now;
        t = buildTile(it, teamHex, px);
        lruSet(key, t);
        return t;
    }
    // another size of the same tile, scaled, until this one gets its turn
    for (let b = 32; b <= 256; b *= 2) {
        const o = tiles.get(it.nid + '|' + teamHex + '|' + b);
        if (o) return o;
    }
    return null;
}

function sparkles(c, it, r, t, alpha) {
    const s = it.skin, em = s.emissive, rnd = mulberry32((s.seed | 0) + 77);
    c.fillStyle = em.color || '#ffffff';
    for (let i = 0; i < 7; i++) {
        const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.85, ph = rnd();
        const v = Math.sin((t * (em.speed || 1) + ph) * Math.PI * 2);
        const k = v > 0 ? v * v * v : 0;
        if (k < 0.04) continue;
        const x = Math.cos(a) * d * r, y = Math.sin(a) * d * r, L = r * (0.1 + 0.08 * k), w = L * 0.22;
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
    const scale = Math.hypot(T.a, T.b) || 1;
    const dev = r * scale;
    if (dev < 5) return;
    const team = /^#[0-9a-f]{6}$/i.test(baseHex) ? baseHex.toLowerCase() : '#808080';
    let px = 32;
    while (px < dev * 2 * E && px < 256) px *= 2;
    if (o.lowFx && px > 128) px = 128;
    const tile = tileFor(it, team, px, o.force);
    if (!tile) return;
    const s = it.skin;
    const a0 = c.globalAlpha;
    const R = r * E;
    c.save();
    hullPath(c, x, y, r, shape, rot, 'clip');
    c.setTransform(T);
    c.translate(x, y);
    c.rotate(rot);
    c.globalAlpha = a0 * (s.opacity == null ? 0.75 : s.opacity);
    c.drawImage(tile.cv, -R, -R, 2 * R, 2 * R);
    const em = s.emissive;
    if (em) {
        const t = o.lowFx ? 0 : (o.time != null ? o.time : performance.now() / 1000);
        const sp = em.speed || 1;
        c.globalCompositeOperation = 'lighter';
        if (em.kind === 'twinkle') {
            sparkles(c, it, r, o.lowFx ? 0.2 : t, a0 * 0.9);
        } else if (tile.glow) {
            let a = 0.7;
            if (em.kind === 'pulse') a = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(t * sp * Math.PI * 2));
            if (em.kind === 'spinGlow' || em.kind === 'spiral') {
                c.rotate((em.kind === 'spiral' ? -1 : 1) * t * sp * Math.PI * 2);
                a = 0.5 + 0.2 * Math.sin(t * sp * Math.PI * 4);
            }
            c.globalAlpha = a0 * a;
            c.drawImage(tile.glow, -R, -R, 2 * R, 2 * R);
        }
        c.globalCompositeOperation = 'source-over';
    }
    // the blinks the plain body got from mixColors, at the same strength
    c.setTransform(T);
    const box = (col, k) => {
        if (!(k > 0)) return;
        c.globalAlpha = a0 * Math.min(1, k);
        c.fillStyle = col;
        c.fillRect(x - R, y - R, 2 * R, 2 * R);
    };
    if (o.flash) box(o.flashColor, 0.3);
    else box(o.statusColor, o.blend);
    box(o.hitColor, o.hitBlend);
    c.restore();
    // the pattern covered the inner half of a centred rim: draw it again
    if (shape !== 0 && !o.borderless) {
        c.save();
        hullPath(c, x, y, r, shape, rot, 'stroke');
        c.restore();
    }
}

// For tests / dev tools.
export function cacheSize() { return tiles.size; }
