// Rank badges: hand-authored flat vector emblems in the game's own look
// (thick dark rims like the tanks and gems, two or three flat tones per
// material, light from the top left, one white glint, no gradients).
//
// Every badge is drawn on a 100-unit grid centred on (0, 0), y down, from
// explicit point lists and bezier paths (see GEO). A badge is a list of
// layers, back to front. It paints in two passes:
//
//   1. silhouette: every layer stroked with its ink at the outer rim width,
//      so the whole emblem gets one thick, even outline;
//   2. fills: each layer strokes a thinner inner line (so a piece reads
//      where it overlaps another), fills its mid tone, then its shading:
//      the right half in the shadow tone, a light band along its top-left
//      edge, or its own facets.
//
// Divisions I / II / III are diamond pips set into a ribbon across the
// bottom of the emblem. Three levels of detail: 'tiny' (<= 20 px: the
// silhouette, one glyph and big pixel-snapped pips), 'small' (<= 40 px:
// no fine detail) and 'full'. Sprites are cached per rank and device-pixel
// size, so a badge over a tank is one drawImage a frame. Used by the
// nameplates, the board, the death card, the ceremony and (as a data URL)
// the menu.

const R = () => (typeof window !== 'undefined' && window.DWRanks) || null;

// Wire codes (shared/ranks.js): 1..19 = division + 1, 20 = in placement.
export const CODE_PLACEMENT = 20;

/* ── materials ───────────────────────────────────────────────────────── */
// h light face, m mid, l shadow, d deep enamel, dd deeper (recess / ribbon
// tails), ink the rim. Copper and emerald are the gem pickups' own colours
// (GEM_SPRITE_PAL in app.js); gold and purple are the game's gold and
// pentagon purple.
const M = {
    copper:  { h: '#f3ae70', m: '#cf7634', l: '#a8551f', d: '#7a3a15', dd: '#57270c', ink: '#381806' },
    steel:   { h: '#f3f6fa', m: '#c2cbd8', l: '#929eb2', d: '#56627a', dd: '#3d4659', ink: '#222834' },
    gold:    { h: '#ffe8a3', m: '#ffc34f', l: '#e3962a', d: '#b0691b', dd: '#824b10', ink: '#462905' },
    teal:    { h: '#b4f2eb', m: '#55ccc2', l: '#2c9f97', d: '#186660', dd: '#104a46', ink: '#08302d' },
    blue:    { h: '#d4ebff', m: '#68b0ff', l: '#3b7fe2', d: '#2358b8', dd: '#193f8a', ink: '#0d2555' },
    emerald: { h: '#6ff5a8', m: '#1fbf6b', l: '#16984f', d: '#0f6d3a', dd: '#0b5029', ink: '#06341a' },
    purple:  { h: '#cdb9ff', m: '#9673e8', l: '#7152cf', d: '#4a2c9e', dd: '#351f78', ink: '#1d0f47' },
    grey:    { h: '#c8ccd5', m: '#8f95a1', l: '#6a707c', d: '#3c4049', dd: '#2d3037', ink: '#17191e' },
};

// Palette per tier for everything else that colours by rank: base / light /
// dark / ink follow the badge art; glyph is its emblem fill; text is the
// rank name on the game's dark panels.
export const TIER_COLORS = {
    bronze:    { base: M.copper.m,  light: M.copper.h,  dark: M.copper.l,  ink: M.copper.ink,  glyph: '#ffe2c2', text: '#eda766' },
    silver:    { base: M.steel.m,   light: M.steel.h,   dark: M.steel.l,   ink: M.steel.ink,   glyph: '#f4f7fb', text: '#d8dfea' },
    gold:      { base: M.gold.m,    light: M.gold.h,    dark: M.gold.l,    ink: M.gold.ink,    glyph: '#fff2c9', text: '#ffc665' },
    platinum:  { base: M.teal.m,    light: M.teal.h,    dark: M.teal.l,    ink: M.teal.ink,    glyph: '#e6fffc', text: '#6ee0d6' },
    diamond:   { base: M.blue.m,    light: M.blue.h,    dark: M.blue.l,    ink: M.blue.ink,    glyph: '#eef7ff', text: '#8cc4ff' },
    emerald:   { base: M.emerald.m, light: M.emerald.h, dark: M.emerald.l, ink: M.emerald.ink, glyph: '#e2ffee', text: '#4fe08f' },
    legend:    { base: M.purple.m,  light: M.purple.h,  dark: M.purple.l,  ink: M.purple.ink,  glyph: '#fff2c9', text: '#c3a6ff' },
    placement: { base: M.grey.m,    light: M.grey.h,    dark: M.grey.l,    ink: M.grey.ink,    glyph: '#e3e6ec', text: '#b9bec9' },
};

const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'emerald', 'legend'];
const ROMAN = ['', 'I', 'II', 'III'];

// Normalise anything the callers hold (division index, 'placement', null)
// into { key, tier, div, division }.
function resolve(division) {
    if (division === 'placement' || division == null) {
        return { key: 'p', tier: 'placement', div: 0, division: null };
    }
    const i = Math.max(0, Math.min(18, division | 0));
    const tier = TIERS[Math.min(6, Math.floor(i / 3))];
    return { key: String(i), tier, div: i === 18 ? 0 : (i % 3) + 1, division: i };
}

// Wire code -> division index | 'placement' | null (guest, bot, unknown).
export function codeToDivision(code) {
    code = code | 0;
    if (code === CODE_PLACEMENT) return 'placement';
    if (code >= 1 && code <= 19) return code - 1;
    return null;
}

export function tierOf(division) { return resolve(division).tier; }
export function colorsOf(division) { return TIER_COLORS[resolve(division).tier]; }
export function nameOf(division) {
    const d = resolve(division);
    if (d.tier === 'placement') return 'Placement';
    const r = R();
    if (r) return r.nameOf(d.division);
    return d.tier[0].toUpperCase() + d.tier.slice(1) + (d.div ? ' ' + ROMAN[d.div] : '');
}

/* ── path authoring ──────────────────────────────────────────────────── */
// Segments: ['M', x, y] ['L', x, y] ['Q', cx, cy, x, y] ['C', ax, ay, bx, by, x, y]
const f1 = (n) => +n.toFixed(2);
function toD(segs, close = true) {
    let d = '';
    for (const s of segs) d += s[0] + s.slice(1).map(f1).join(' ') + ' ';
    return close ? d + 'Z' : d;
}
// A left-right symmetric outline from its right half, authored top centre
// (x = 0) to bottom centre (x = 0). The left half is the right half run
// backwards and mirrored, so the two sides can never drift apart.
function symSegs(half) {
    const out = half.slice();
    const end = (s) => [s[s.length - 2], s[s.length - 1]];
    for (let i = half.length - 1; i >= 1; i--) {
        const s = half[i];
        const [px, py] = end(half[i - 1]);
        if (s[0] === 'L') out.push(['L', -px, py]);
        else if (s[0] === 'Q') out.push(['Q', -s[1], s[2], -px, py]);
        else if (s[0] === 'C') out.push(['C', -s[3], s[4], -s[1], s[2], -px, py]);
    }
    return out;
}
const P = (d) => new Path2D(d);
const sym = (half) => P(toD(symSegs(half)));
const poly = (pts) => P('M' + pts.map((p) => f1(p[0]) + ' ' + f1(p[1])).join(' L') + ' Z');
function circle(x, y, r) { const p = new Path2D(); p.arc(x, y, r, 0, Math.PI * 2); return p; }
function rrect(x, y, w, h, r) { const p = new Path2D(); p.roundRect(x, y, w, h, r); return p; }
// Path transformed by translate / rotate (deg) / scale (sx, sy), in that order.
function T(p, x = 0, y = 0, rot = 0, sx = 1, sy = sx) {
    const q = new Path2D();
    q.addPath(p, new DOMMatrix().translateSelf(x, y).rotateSelf(rot).scaleSelf(sx, sy));
    return q;
}
function union(...ps) { const q = new Path2D(); for (const p of ps) q.addPath(p); return q; }
const mirror = (p) => T(p, 0, 0, 0, -1, 1);
const both = (p) => union(p, mirror(p));
// Half-planes for the flat shading.
const RIGHT_OF = (x) => poly([[x, -80], [80, -80], [80, 80], [x, 80]]);
const BELOW = (y) => poly([[-80, y], [80, y], [80, 80], [-80, 80]]);

/* ── geometry (built once, lazily: Path2D only exists in browsers) ───── */
let GEO = null;
function geo() {
    if (GEO) return GEO;
    const G = {};

    // The ribbon across the bottom that carries the division pips; its
    // tails fold behind the ends of the band. 'small' is chunkier with
    // bigger pips, so the division still reads at 24 px.
    const ribbon = (hw, top, bot, sag, tail, pw, ph, gap) => ({
        band: P(toD([['M', -hw, top], ['Q', 0, top + sag * 2, hw, top], ['L', hw, bot], ['Q', 0, bot + sag * 2, -hw, bot]])),
        tails: both(P(toD([['M', hw - 6, top + 3.5], ['L', hw + tail, top + 3], ['L', hw + tail - 4.6, (top + bot) / 2 + 4],
            ['L', hw + tail + 0.6, bot + 4], ['L', hw - 6, bot + 4]]))),
        fold: both(poly([[hw, bot], [hw - 6, bot + 0.4], [hw, bot + 4]])),
        pipY: (x) => (top + bot) / 2 + sag * (1 - (x / hw) * (x / hw)),
        pw, ph, gap,
    });
    G.ribbon = {
        full: ribbon(27, 26.5, 41, 1.8, 12, 5.6, 6.9, 14.2),
        small: ribbon(29.5, 23.5, 44, 1.6, 9, 7.6, 8.8, 17.2),
    };

    // ── Bronze: a scalloped copper seal ──
    {
        const cx = 0, cy = -6, n = 14, rv = 33.2, rc = 38.8;
        const segs = [];
        for (let i = 0; i <= n; i++) {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
            const x = cx + Math.cos(a) * rv, y = cy + Math.sin(a) * rv;
            if (i === 0) { segs.push(['M', x, y]); continue; }
            const am = a - Math.PI / n;
            segs.push(['Q', cx + Math.cos(am) * rc, cy + Math.sin(am) * rc, x, y]);
        }
        G.bronze = { seal: P(toD(segs)), field: circle(cx, cy, 24.5), cy, bottom: 30 };
    }

    // one pickaxe, authored upright: head across the top, handle down
    G.pick = {
        head: P(toD([['M', -24, 4], ['C', -18, -6.5, -8.5, -11.5, 0, -11.5], ['C', 8.5, -11.5, 18, -6.5, 24, 4],
            ['C', 16, -1.5, 8, -3.2, 0, -3.2], ['C', -8, -3.2, -16, -1.5, -24, 4]])),
        collar: rrect(-5.6, -13.6, 11.2, 12.2, 2.4),
        handle: rrect(-3.7, -4, 7.4, 38, 3.7),
        long: rrect(-3.7, -4, 7.4, 45, 3.7),
    };

    // ── Silver: a steel heater shield ──
    G.silver = {
        shield: sym([['M', 0, -42.5], ['Q', 18, -43, 34.5, -36.5], ['L', 34.5, -12], ['C', 34.5, 10, 21.5, 30, 0, 44.5]]),
        field: sym([['M', 0, -34], ['Q', 14, -34.4, 27, -29.4], ['L', 27, -11], ['C', 27, 6.5, 17, 22.5, 0, 34.5]]),
        bottom: 44.5,
    };

    // ── Gold: a crested shield, wings and a crown ──
    G.gold = {
        shield: sym([['M', 0, -33], ['C', 9, -33, 18, -30, 30, -36], ['L', 30, -8], ['C', 30, 13.5, 17.5, 30.5, 0, 43.5]]),
        field: sym([['M', 0, -25], ['C', 7, -25, 13.5, -23, 22.5, -27.5], ['L', 22.5, -8], ['C', 22.5, 7, 13.5, 20.5, 0, 31.5]]),
        // right wing, three feathers, top one longest; the left wing is the
        // mirror image
        f1: P(toD([['M', 17, -29], ['C', 27, -38.5, 39.5, -44, 49.5, -42], ['C', 47.5, -33.5, 40, -26.5, 22, -18]])),
        f2: P(toD([['M', 19, -20], ['C', 30, -27, 41.5, -29, 49, -25.5], ['C', 46, -17.5, 36.5, -10.5, 21, -9]])),
        f3: P(toD([['M', 20, -10.5], ['C', 30, -12.5, 39, -10.5, 45.5, -5], ['C', 40, 2, 30, 4, 21, 0.5]])),
        star: poly([...Array(10).keys()].map((k) => {
            const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? 5.9 : 13.4;
            return [Math.cos(a) * r, -1 + Math.sin(a) * r];
        })),
        bottom: 43.5,
    };

    // a crown in the game's own shape (drawCrown in app.js): three spikes
    // with ball tips over a band. Base centre at (0, 0), 30 wide.
    G.crown = {
        body: sym([['M', 0, -18.5], ['L', 6, -8.2], ['L', 15, -15], ['L', 12.8, -4.4], ['L', 0, -4.4]]),
        band: rrect(-14.2, -5.4, 28.4, 6.2, 1.6),
        balls: union(circle(0, -19, 3.3), circle(15, -15.2, 2.9), circle(-15, -15.2, 2.9)),
        jewel: poly([[0, -5.1], [2.7, -2.2], [0, 0.7], [-2.7, -2.2]]),
    };

    // ── Platinum: a hex plate with four drill teeth ──
    {
        const y0 = -5;
        const hex = (r) => poly([0, 1, 2, 3, 4, 5].map((k) => {
            const a = -Math.PI / 2 + (k * Math.PI) / 3;
            return [Math.cos(a) * r, y0 + Math.sin(a) * r];
        }));
        const tooth = (ang, r1) => {
            const a = (ang * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
            const px = -sa, py = ca, r0 = 28, w = 6.6;
            return poly([[ca * r0 + px * w, y0 + sa * r0 + py * w], [ca * r1, y0 + sa * r1], [ca * r0 - px * w, y0 + sa * r0 - py * w]]);
        };
        G.plat = {
            hex: hex(37.5), field: hex(27.5),
            teeth: union(tooth(-30, 50), tooth(-150, 50), tooth(30, 47), tooth(150, 47)),
            // rivets in the frame's upper corners
            rivets: union(...[-150, -90, -30, 30, 150].map((ang) => {
                const a = (ang * Math.PI) / 180;
                return circle(Math.cos(a) * 32.6, y0 + Math.sin(a) * 32.6, 2.3);
            })),
            // the drill bit, point down: shank, collar, fluted cone
            shank: rrect(-5, -26.5, 10, 10, 1.6),
            collar: rrect(-10, -18, 20, 6.4, 2),
            cone: sym([['M', 0, -12.5], ['L', 12, -12.5], ['L', 0, 19]]),
            flutes: union(
                poly([[-12, -7.2], [12, -12.2], [12, -7.6], [-10.2, -2.6]]),
                poly([[-8.4, 2.6], [9.4, -1.6], [7.6, 3.3], [-6.5, 6.8]]),
                poly([[-4.6, 12], [5.2, 9.6], [3.6, 13.7], [-2.7, 15.2]])),
            bottom: 32.5,
        };
    }

    // ── Diamond: a brilliant-cut gem with steel blades ──
    {
        const T0 = [-15.5, -31], T1 = [15.5, -31];
        const g = [[-37.5, -14], [-12.5, -14], [12.5, -14], [37.5, -14]];
        const C = [0, 44];
        G.dia = {
            gem: poly([T0, T1, g[3], C, g[0]]),
            faces: [
                [poly([T0, g[1], g[0]]), 'm'], [poly([T0, T1, g[2], g[1]]), 'h'], [poly([T1, g[3], g[2]]), 'l'],
                [poly([g[0], g[1], C]), 'h'], [poly([g[1], g[2], C]), 'm'], [poly([g[2], g[3], C]), 'l'],
            ],
            table: poly([T0, T1, g[2], g[1]]),
            lines: P(toD([['M', g[0][0] + 1, g[0][1]], ['L', g[3][0] - 1, g[3][1]], ['M', T0[0], T0[1]], ['L', g[1][0], g[1][1]], ['L', C[0], C[1]],
                ['M', T1[0], T1[1]], ['L', g[2][0], g[2][1]], ['L', C[0], C[1]]], false)),
            // right-hand blades, each split along its spine; the left pair
            // is the mirror image
            bladeUp: poly([[21, -27.5], [50.5, -41.5], [33.5, -12.5]]),
            bladeUpLo: poly([[27.2, -20], [50.5, -41.5], [33.5, -12.5]]),
            bladeLo: poly([[27, -11], [47.5, 13.5], [22.5, 5]]),
            bladeLoLo: poly([[24.8, -3], [47.5, 13.5], [22.5, 5]]),
            // a crest blade standing up behind the table
            crest: poly([[-8, -27], [0, -48.5], [8, -27]]),
            crestLo: poly([[0, -27], [0, -48.5], [8, -27]]),
            bottom: 44,
        };
    }

    // ── Emerald: the game's own gem cut, a laurel and a small crown ──
    {
        const K = 33, Y = -6;
        const cut = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
        const at = (k, dx, dy) => cut.map(([x, y]) => [dx + x * k, dy + y * k]);
        // stem of the right branch (a quadratic), leaves along it
        const S0 = [7, 36], S1 = [44, 31], S2 = [38.5, -18];
        const q = (t) => [(1 - t) * (1 - t) * S0[0] + 2 * (1 - t) * t * S1[0] + t * t * S2[0], (1 - t) * (1 - t) * S0[1] + 2 * (1 - t) * t * S1[1] + t * t * S2[1]];
        const qd = (t) => [2 * (1 - t) * (S1[0] - S0[0]) + 2 * t * (S2[0] - S1[0]), 2 * (1 - t) * (S1[1] - S0[1]) + 2 * t * (S2[1] - S1[1])];
        const leafShape = P(toD([['M', 0, 0], ['C', 5, -3.5, 6.5, -10, 0, -17], ['C', -6.5, -10, -5, -3.5, 0, 0]]));
        const out = [], inn = [];
        // [t along the stem, side (+1 outward, -1 inward, 0 the tip), size]
        for (const [t, side, k] of [[0.17, 1, 0.8], [0.3, -1, 0.82], [0.43, 1, 0.92], [0.56, -1, 0.9], [0.69, 1, 1], [0.81, -1, 0.92], [0.93, 1, 0.98], [1, 0, 1.02]]) {
            const [x, y] = q(t), [dx, dy] = qd(t);
            const ang = (Math.atan2(dy, dx) * 180) / Math.PI + 90 + side * 42;
            (side >= 0 ? out : inn).push(T(leafShape, x, y, ang, k));
        }
        G.em = {
            gem: poly(at(K, 0, Y)),
            facet: poly(at(K * 0.525, 0, Y - 0.12 * K)),
            sparkle: T(poly(cut), -0.148 * K, Y - 0.377 * K, 12, 0.2 * K),
            stem: P(toD([['M', S0[0], S0[1]], ['Q', S1[0], S1[1], S2[0], S2[1]]], false)),
            leavesOut: union(...out), leavesIn: union(...inn),
            K, Y, bottom: Y + 0.95 * K,
        };
    }

    // ── Legend: a faceted eight-point star, gold rays, a crown in a ring ──
    {
        const cy = -3;
        const tip = (k) => {   // k = 0..7 points, 0 = north
            const a = -Math.PI / 2 + (k * Math.PI) / 4, r = k % 2 ? 33.5 : 47;
            return [Math.cos(a) * r, cy + Math.sin(a) * r];
        };
        const val = (k) => {   // the valley after point k
            const a = -Math.PI / 2 + ((k + 0.5) * Math.PI) / 4, r = 18.5;
            return [Math.cos(a) * r, cy + Math.sin(a) * r];
        };
        const pts = [];
        for (let k = 0; k < 8; k++) pts.push(tip(k), val(k));
        // each point is two flat facets; the one facing the top-left light
        // is the lit one
        const lit = [], shade = [];
        const C = [0, cy];
        for (let k = 0; k < 8; k++) {
            const t = tip(k);
            for (const v of [val((k + 7) % 8), val(k)]) {
                const f = [C, v, t];
                const mx = (v[0] + t[0]) / 2 - C[0], my = (v[1] + t[1]) / 2 - C[1];
                const rx = t[0] - C[0], ry = t[1] - C[1], rl = Math.hypot(rx, ry);
                // side of the ridge the facet is on, dotted with the light
                const d = (mx * ry - my * rx) / rl;
                const nx = ry / rl * Math.sign(d), ny = -rx / rl * Math.sign(d);
                ((nx * -1 + ny * -1) > 0 ? lit : shade).push(poly(f));
            }
        }
        const rays = [];
        for (let k = 0; k < 8; k++) {
            const a = -Math.PI / 2 + Math.PI / 8 + (k * Math.PI) / 4;
            const ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca, w = 4.2;
            rays.push(poly([[ca * 18 + px * w, cy + sa * 18 + py * w], [ca * 44, cy + sa * 44], [ca * 18 - px * w, cy + sa * 18 - py * w]]));
        }
        G.leg = {
            star: poly(pts), lit: union(...lit), shade: union(...shade),
            rays: union(...rays),
            ring: circle(0, cy, 20.5),
            field: circle(0, cy, 15),
            cy,
        };
    }

    // ── Placement: a grey medal with a question mark ──
    G.pl = {
        disc: circle(0, -2, 35),
        field: circle(0, -2, 26.5),
        ring: circle(0, -2, 30.8),
        hook: P(toD([['M', -8.6, -14], ['C', -8.6, -23.5, 9, -24.5, 9, -14.2], ['C', 9, -7.6, 0.4, -7.4, 0.4, 0.4]], false)),
        dot: circle(0.4, 9.6, 4.6),
    };

    GEO = G;
    return G;
}

/* ── the renderer ────────────────────────────────────────────────────── */
// A layer: { p: Path2D, f: fill, ink, lo + loR (shadow region, default the
// right half of x > cx), hi + hiR (an extra flat region), rim (light along
// the top-left edge), shd (shadow along the bottom-right edge), dark (a
// recess: shadow along the inner top-left edge), line (stroke width, for
// stems), edge (inner rim, default on), sil (in the silhouette, default
// on), iw (inner rim scale), after(c, K) }
function L(p, mat, o) { return Object.assign({ p, f: mat.m, ink: mat.ink }, o || {}); }

// the shape minus itself moved by (dx, dy): an edge band on the far side
function crescent(p, dx, dy) {
    const q = new Path2D();
    q.addPath(p);
    q.addPath(p, new DOMMatrix([1, 0, 0, 1, dx, dy]));
    return q;
}

function paintLayers(c, layers, K) {
    c.lineJoin = 'round';
    c.lineCap = 'round';
    // 1. one outline for the whole emblem
    for (const l of layers) {
        if (l.sil === false) continue;
        c.strokeStyle = l.ink;
        if (l.line) {
            c.lineWidth = l.line + K.O * 2;
            c.stroke(l.p);
        } else {
            c.lineWidth = K.O * 2;
            c.stroke(l.p);
            c.fillStyle = l.ink;
            c.fill(l.p);
        }
    }
    // 2. fills, back to front
    for (const l of layers) {
        if (l.line) {
            if (l.edge !== false && K.I > 0) { c.strokeStyle = l.ink; c.lineWidth = l.line + K.I * 2; c.stroke(l.p); }
            c.strokeStyle = l.f;
            c.lineWidth = l.line;
            c.stroke(l.p);
            continue;
        }
        if (l.edge !== false && K.I > 0) {
            c.strokeStyle = l.ink;
            c.lineWidth = K.I * 2 * (l.iw || 1);
            c.stroke(l.p);
        }
        c.fillStyle = l.f;
        c.fill(l.p);
        if (l.lo || l.hi || l.rim || l.dark || l.shd) {
            c.save();
            c.clip(l.p);
            if (l.lo) { c.fillStyle = l.lo; c.fill(l.loR || RIGHT_OF(l.cx || 0)); }
            if (l.hi) { c.fillStyle = l.hi; c.fill(l.hiR); }
            if (l.shd && K.detail) { const d = l.shdD || 2.6; c.fillStyle = l.shd; c.fill(crescent(l.p, -d, -d), 'evenodd'); }
            if (l.rim && K.detail) { const d = l.rimD || 3.2; c.fillStyle = l.rim; c.fill(crescent(l.p, d, d), 'evenodd'); }
            if (l.dark && K.detail) { const d = l.darkD || 3; c.fillStyle = l.dark; c.fill(crescent(l.p, d * 0.8, d), 'evenodd'); }
            c.restore();
        }
        if (l.after) l.after(c, K);
    }
}

// The one white glint: a short capsule tilted along the top-left light,
// with a dot after it at full size.
function glint(c, x, y, s, K) {
    c.save();
    c.translate(x, y);
    c.rotate(-0.72);
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.roundRect(-s, -s * 0.36, s * 2, s * 0.72, s * 0.36);
    c.fill();
    if (K.full) {
        c.beginPath();
        c.arc(s * 1.75, 0, s * 0.3, 0, Math.PI * 2);
        c.fill();
    }
    c.restore();
}

/* ── pieces shared between tiers ─────────────────────────────────────── */
// A pickaxe whose point `pivot` (local y) lands on (x, y); rot in degrees,
// hk narrows the head (crossed pairs need room between the heads).
function pickLayers(K, mat, glyph, x, y, rot, k, pivot, long, hk = 1) {
    const g = geo().pick;
    const tf = (p) => T(T(p, 0, -pivot), x, y, rot, k);
    const out = [L(tf(long ? g.long : g.handle), mat, { f: mat.m, lo: mat.l, cx: x, iw: 0.8 })];
    if (!K.small) out.push(L(tf(g.collar), mat, { f: mat.l, lo: mat.d, cx: x, iw: 0.8 }));
    out.push(L(tf(T(g.head, 0, 0, 0, hk, 1)), mat, { f: glyph.h, shd: glyph.m, shdD: 2.2, lo: K.small ? glyph.m : null, loR: RIGHT_OF(x + 4), iw: 0.8 }));
    return out;
}

function crownLayers(K, x, y, k, jewel) {
    const g = geo().crown, au = M.gold;
    const tf = (p) => T(p, x, y, 0, k);
    const out = [
        L(tf(g.body), au, { f: au.m, lo: au.l, cx: x }),
        L(tf(g.balls), au, { f: au.h, lo: au.m, cx: x, edge: false }),
        L(tf(g.band), au, { f: au.l, lo: au.d, cx: x, iw: 0.85 }),
    ];
    if (jewel && K.full) out.push(L(tf(g.jewel), jewel, { f: jewel.h, lo: jewel.m, cx: x, iw: 0.6, sil: false }));
    return out;
}

// The division ribbon: tails, band, n diamond pips.
function ribbonLayers(K, n, mat, pip) {
    const g = K.full ? geo().ribbon.full : geo().ribbon.small;
    const out = [
        L(g.tails, mat, { f: mat.dd }),
        L(g.fold, mat, { f: mat.ink, edge: false, sil: false }),
        L(g.band, mat, { f: mat.d, rim: mat.l, rimD: 2.2 }),
    ];
    for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * g.gap, y = g.pipY(x);
        const d = poly([[x, y - g.ph], [x + g.pw, y], [x, y + g.ph], [x - g.pw, y]]);
        out.push(L(d, mat, { f: pip.h, lo: pip.m, loR: poly([[x, y], [x + g.pw + 2, y], [x, y + g.ph + 2]]), iw: 0.75, sil: false }));
    }
    return out;
}

/* ── tiers ───────────────────────────────────────────────────────────── */
// Each returns { layers, main (the body the cracks run in), glint, bottom
// (lowest point of the emblem, for the tiny pips) }.
const BUILD = {
    bronze(K) {
        const G = geo().bronze, cu = M.copper;
        const layers = [
            L(G.seal, cu, { lo: cu.l, rim: cu.h, rimD: 3.4 }),
            L(G.field, cu, { f: cu.d, lo: cu.dd, dark: cu.dd, darkD: 3.6 }),
        ];
        if (K.tiny) layers.push(L(T(geo().pick.head, 0, G.cy + 1, 45, 1.05), cu, { f: '#ffd9b0', lo: cu.h, cx: 3 }));
        else layers.push(...pickLayers(K, cu, { h: '#ffe1bf', m: '#f0a86a' }, 0, G.cy, 45, 0.86, 10));
        return { layers, main: G.seal, glint: [-16.5, -27.5, 4.6], bottom: G.bottom };
    },
    silver(K) {
        const G = geo().silver, st = M.steel;
        const layers = [L(G.shield, st, { lo: st.l, rim: st.h, rimD: 3.4 }), L(G.field, st, { f: st.d, lo: st.dd, dark: st.dd })];
        if (!K.full) {
            // too small for two pickaxes: a bold X of handles with flat heads
            const bar = rrect(-4.4, -18, 8.8, 36, 4.4), cap = rrect(-11, -21, 22, 7, 3.5);
            for (const r of [45, -45]) layers.push(L(union(T(bar, 0, -5, r), T(cap, 0, -5, r)), st, { f: st.h, lo: st.m, cx: 0 }));
        } else {
            const glyph = { h: '#ffffff', m: '#c9d2df' };
            layers.push(...pickLayers(K, st, glyph, 0, 3, -50, 0.7, 22, true, 0.74));
            layers.push(...pickLayers(K, st, glyph, 0, 3, 50, 0.7, 22, true, 0.74));
        }
        return { layers, main: G.shield, glint: [-19.5, -31, 4.6], bottom: G.bottom };
    },
    gold(K) {
        const G = geo().gold, au = M.gold;
        const layers = [];
        if (!K.tiny) {
            layers.push(L(both(G.f3), au, { f: au.m, shd: au.l }));
            layers.push(L(both(G.f2), au, { f: au.h, shd: au.m }));
            layers.push(L(both(G.f1), au, { f: au.h, shd: au.m }));
        }
        layers.push(L(G.shield, au, { lo: au.l, rim: au.h, rimD: 3.4 }));
        layers.push(L(G.field, au, { f: au.d, lo: au.dd, dark: au.dd }));
        layers.push(L(G.star, au, { f: '#fff3cc', lo: au.h }));
        layers.push(...crownLayers(K, 0, -29, K.tiny ? 1.12 : 0.98, M.blue));
        return { layers, main: G.shield, glint: [-16.5, -18, 4], bottom: G.bottom };
    },
    platinum(K) {
        const G = geo().plat, tl = M.teal, st = M.steel;
        const layers = [];
        if (!K.tiny) layers.push(L(G.teeth, st, { f: st.m, lo: st.l }));
        layers.push(L(G.hex, tl, { lo: tl.l, rim: tl.h, rimD: 3.4 }));
        if (K.full) layers.push(L(G.rivets, st, { f: st.h, lo: st.l, cx: 0, iw: 0.6, sil: false }));
        layers.push(L(G.field, tl, { f: tl.d, lo: tl.dd, dark: tl.dd }));
        const tf = (p) => T(p, 0, -4, 0, 0.95);
        if (K.tiny) {
            layers.push(L(tf(G.cone), tl, { f: '#e8fffc', lo: tl.h }));
        } else {
            layers.push(L(tf(G.shank), st, { f: st.m, lo: st.l, iw: 0.8 }));
            layers.push(L(tf(G.collar), st, { f: st.h, lo: st.m, iw: 0.8 }));
            layers.push(L(tf(G.cone), tl, { f: '#e8fffc', lo: tl.h, iw: 0.8,
                after(c) { c.save(); c.clip(tf(G.cone)); c.fillStyle = tl.m; c.fill(tf(G.flutes)); c.restore(); } }));
        }
        return { layers, main: G.hex, glint: [-18, -25, 4.4], bottom: G.bottom };
    },
    diamond(K) {
        const G = geo().dia, bl = M.blue, st = M.steel;
        const layers = [];
        if (!K.tiny) {
            layers.push(L(both(G.bladeLo), st, { f: st.h, hi: st.l, hiR: both(G.bladeLoLo) }));
            layers.push(L(both(G.bladeUp), st, { f: st.h, hi: st.l, hiR: both(G.bladeUpLo) }));
            layers.push(L(G.crest, st, { f: st.h, hi: st.l, hiR: G.crestLo }));
        }
        if (K.tiny) {
            layers.push(L(G.gem, bl, { f: bl.m, lo: bl.l, hi: bl.h, hiR: G.table }));
        } else {
            layers.push(L(G.gem, bl, { f: bl.m, after(c) {
                for (const [p, tone] of G.faces) { c.fillStyle = bl[tone]; c.fill(p); }
                c.strokeStyle = bl.d;
                c.lineWidth = Math.max(1.3, K.I * 0.7);
                c.stroke(G.lines);
            } }));
        }
        return { layers, main: G.gem, glint: [-10, -25.5, 3.6], bottom: G.bottom };
    },
    emerald(K) {
        const G = geo().em, em = M.emerald, au = M.gold;
        const layers = [];
        if (!K.tiny) {
            layers.push(L(both(G.stem), au, { f: au.l, line: 3.4 }));
            layers.push(L(both(G.leavesIn), au, { f: au.l, rim: au.m, rimD: 2, iw: 0.75 }));
            layers.push(L(both(G.leavesOut), au, { f: au.m, rim: au.h, rimD: 2, iw: 0.75 }));
        }
        layers.push(L(G.gem, em, { f: em.m, lo: em.l, after(c) {
            c.fillStyle = em.h; c.fill(G.facet);
            c.fillStyle = '#ffffff'; c.fill(G.sparkle);
        } }));
        layers.push(...crownLayers(K, 0, G.Y - 0.95 * G.K + 3, K.tiny ? 1.05 : 0.8, M.emerald));
        return { layers, main: G.gem, glint: null, bottom: G.bottom };
    },
    legend(K) {
        const G = geo().leg, pu = M.purple, au = M.gold;
        const layers = [];
        if (!K.tiny) layers.push(L(G.rays, au, { f: au.m, lo: au.l }));
        layers.push(L(G.star, pu, { f: pu.m, after(c) {
            c.fillStyle = pu.h; c.fill(G.lit);
            c.fillStyle = pu.l; c.fill(G.shade);
        } }));
        layers.push(L(G.ring, au, { lo: au.l, rim: au.h, rimD: 2.6 }));
        layers.push(L(G.field, pu, { f: pu.d, lo: pu.dd, dark: pu.dd }));
        if (K.full || K.px >= 30) layers.push(...crownLayers(K, 0, G.cy + 6.8, 0.66, null));
        return { layers, main: G.star, glint: [-10, -15.5, 3.2] };
    },
    placement(K) {
        const G = geo().pl, gr = M.grey;
        const q = { ink: gr.ink, f: '#eef0f4' };
        return {
            layers: [
                L(G.disc, gr, { lo: gr.l, rim: gr.h, rimD: 3.2 }),
                L(G.field, gr, { f: gr.d, lo: gr.dd, dark: gr.dd }),
                Object.assign(L(G.hook, gr, { line: K.tiny ? 9 : 7.6, sil: false }), q),
                Object.assign(L(G.dot, gr, { sil: false, lo: '#c9cdd6', cx: 0.4 }), q),
            ],
            main: G.disc, glint: [-17, -22, 4], ring: true,
        };
    },
};

// Ribbon material and pip colours per tier.
const RIBBON = {
    bronze: [M.copper, { h: '#ffd2a3', m: M.copper.h }],
    silver: [M.steel, { h: '#ffffff', m: M.steel.m }],
    gold: [M.gold, { h: '#fff3c9', m: M.gold.h }],
    platinum: [M.teal, { h: '#dbfffb', m: M.teal.h }],
    diamond: [M.blue, { h: '#eaf5ff', m: M.blue.h }],
    emerald: [M.emerald, { h: '#c9ffe0', m: M.emerald.h }],
};

/* ── cracks (the ceremony's breaking badge) ──────────────────────────── */
const CRACKS = [
    [[-2, -6], [-10, -15], [-7, -23], [-15, -32]],
    [[-2, -6], [9, 0], [14, 12], [24, 17]],
    [[-2, -6], [-6, 8], [2, 18], [-3, 30]],
    [[-2, -6], [12, -14], [24, -16], [30, -26]],
    [[-2, -6], [-18, 0], [-27, 10]],
];
function cracks(c, main, stage, ink) {
    const n = Math.min(CRACKS.length, [0, 1, 3, 5][Math.max(0, Math.min(3, stage | 0))]);
    if (!n) return;
    c.save();
    c.clip(main);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (let i = 0; i < n; i++) {
        const pts = CRACKS[i];
        c.beginPath();
        pts.forEach(([x, y], j) => (j ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.strokeStyle = '#ffffff';
        c.globalAlpha = 0.75;
        c.lineWidth = 6.5;
        c.stroke();
        c.globalAlpha = 1;
        c.strokeStyle = ink;
        c.lineWidth = 3.4;
        c.stroke();
    }
    c.restore();
}

function legendPlate(c, n, K) {
    const txt = '#' + n;
    c.font = 'bold 15px Rubik, Ubuntu, sans-serif';
    const tw = c.measureText(txt).width;
    const w = Math.max(30, tw + 14), h = 18, y = 31;
    const plate = rrect(-w / 2, y, w, h, 7);
    const inner = rrect(-w / 2 + 3, y + 3, w - 6, h - 6, 4.5);
    c.lineJoin = 'round';
    c.strokeStyle = M.gold.ink;
    c.lineWidth = K.O * 2;
    c.stroke(plate);
    c.fillStyle = M.gold.m;
    c.fill(plate);
    c.save(); c.clip(plate); c.fillStyle = M.gold.l; c.fill(RIGHT_OF(0)); c.restore();
    c.fillStyle = M.purple.dd;
    c.fill(inner);
    c.fillStyle = M.gold.h;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(txt, 0, y + h / 2 + 0.9);
}

/* ── the painter ─────────────────────────────────────────────────────── */
// Paint a badge centred on the current origin, px device pixels tall. opts:
//   legendNo  - Legend's #N plate (>= 40 px only)
//   crack     - 0..3 crack stages (ceremony)
//   lod       - force 'tiny' | 'small' | 'full'
export function paintBadge(c, division, px, opts) {
    opts = opts || {};
    const d = resolve(division);
    const lod = opts.lod || (px <= 20 ? 'tiny' : px <= 40 ? 'small' : 'full');
    const tiny = lod === 'tiny', full = lod === 'full';
    const K = {
        px, tiny, full, small: lod === 'small', detail: !tiny,
        // outer rim: ~4% of the badge, never under ~1.6 device px
        O: Math.max(4, 160 / Math.max(1, px)),
        // inner lines: never under ~0.9 device px; none when tiny
        I: tiny ? 0 : Math.max(2, 90 / Math.max(1, px)),
    };
    const art = BUILD[d.tier](K);
    let layers = art.layers;
    c.save();
    c.scale(px / 100, px / 100);
    // tiny: the emblem steps up and the pips get whole pixels under it
    const lift = tiny && d.div > 0;
    if (lift) { c.save(); c.translate(0, TINY_DY); c.scale(TINY_K, TINY_K); }
    if (!tiny && d.div > 0) layers = layers.concat(ribbonLayers(K, d.div, ...RIBBON[d.tier]));
    paintLayers(c, layers, K);
    if (art.ring && full) {
        // placement: a dashed track inside the rim
        c.save();
        c.setLineDash([7.4, 6.2]);
        c.lineDashOffset = 2;
        c.lineWidth = 3;
        c.strokeStyle = M.grey.h;
        c.globalAlpha *= 0.7;
        c.stroke(geo().pl.ring);
        c.restore();
    }
    if (art.glint && !tiny) glint(c, art.glint[0], art.glint[1], art.glint[2], K);
    if (opts.crack) cracks(c, art.main, opts.crack, TIER_COLORS[d.tier].ink);
    if (lift) {
        c.restore();
        pipsTiny(c, d.div, d.tier, px, (art.bottom + K.O * 0.5) * TINY_K + TINY_DY);
    }
    if (d.tier === 'legend' && opts.legendNo > 0 && px >= 40) legendPlate(c, opts.legendNo | 0, K);
    c.restore();
}
const TINY_K = 0.84, TINY_DY = -8;

// Tiny pips: one dark bar of n light squares on whole device pixels,
// tucked up under the emblem's lowest point (`bottom`, in units).
function pipsTiny(c, n, tier, px, bottom) {
    const [mat, pip] = RIBBON[tier];
    const u = 100 / px;    // units per device pixel
    const pw = px >= 18 ? 3 : 2, gap = 1;
    const w = n * pw + (n - 1) * gap + 2, hgt = pw + 2;
    const x0 = -Math.floor(w / 2);
    const y0 = Math.min(Math.floor(px / 2) - hgt + 2, Math.round(bottom / u) - 2);
    c.fillStyle = mat.ink;
    c.fillRect(x0 * u, y0 * u, w * u, hgt * u);
    c.fillStyle = pip.h;
    for (let i = 0; i < n; i++) c.fillRect((x0 + 1 + i * (pw + gap)) * u, (y0 + 1) * u, pw * u, pw * u);
}

/* ── high-quality small badges ──────────────────────────────────────── */
// Small badges used to switch to simplified art, which read as a different
// icon. Now every size is the real (full-detail) badge, painted large and
// shrunk in halving steps so it stays smooth instead of aliasing.
function paintShrunk(c, division, devPx, opts) {
    const MASTER = Math.max(160, devPx * 4);
    const pad = Math.ceil(MASTER * 0.06) + 2;
    let cv = document.createElement('canvas');
    cv.width = cv.height = MASTER + pad * 2;
    let g = cv.getContext('2d');
    g.translate(cv.width / 2, cv.height / 2);
    paintBadge(g, division, MASTER, Object.assign({}, opts, { lod: 'full' }));
    let size = cv.width;
    const target = Math.max(1, Math.round(cv.width * devPx / MASTER));
    while (size / 2 >= target * 1.5) {
        const half = Math.ceil(size / 2), nx = document.createElement('canvas');
        nx.width = nx.height = half;
        const h = nx.getContext('2d');
        h.imageSmoothingEnabled = true; h.imageSmoothingQuality = 'high';
        h.drawImage(cv, 0, 0, half, half);
        cv = nx; size = half;
    }
    c.save();
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(cv, -target / 2, -target / 2, target, target);
    c.restore();
}

/* ── sprite cache ────────────────────────────────────────────────────── */
const cache = new Map();
const CACHE_MAX = 160;
function sprite(division, devPx, opts) {
    const d = resolve(division);
    const plate = d.tier === 'legend' && opts && opts.legendNo > 0 && devPx >= 40 ? (opts.legendNo | 0) : 0;
    const key = d.key + '|' + devPx + '|' + plate;
    let s = cache.get(key);
    if (s) { cache.delete(key); cache.set(key, s); return s; }
    const pad = Math.ceil(devPx * 0.06) + 2;
    const cv = document.createElement('canvas');
    // even size, so the centre (and the tiny pips) sit on whole pixels
    cv.width = cv.height = devPx + pad * 2 + ((devPx + pad * 2) & 1);
    const c = cv.getContext('2d');
    c.translate(cv.width / 2, cv.height / 2);
    if (devPx >= 64) paintBadge(c, division, devPx, { legendNo: plate, lod: 'full' });
    else paintShrunk(c, division, devPx, { legendNo: plate });
    s = { cv, pad };
    cache.set(key, s);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return s;
}

// Draw a badge px tall centred on (x, y) in the context's current space.
// division: 0..18, 'placement', or null (draws nothing).
// opts: { legendNo, alpha }
export function drawBadge(c, x, y, px, division, opts) {
    if (division == null || !(px > 1)) return;
    opts = opts || {};
    let t = null;
    try { t = c.getTransform(); } catch (e) { t = null; }
    const sc = t ? Math.hypot(t.a, t.b) || 1 : 1;
    const want = px * sc;   // device pixels
    if (want < 4) return;
    // nameplates change size every frame while the camera zooms, so sprites
    // come in buckets (exact up to 24 px, then steps of 4 and 8) and are
    // scaled the last few percent
    const bucket = want <= 24 ? Math.round(want) : want <= 64 ? Math.round(want / 4) * 4 : Math.round(want / 8) * 8;
    const s = sprite(division, bucket, opts);
    const k = want / bucket;
    const dw = s.cv.width * k;
    c.save();
    if (opts.alpha != null) c.globalAlpha *= opts.alpha;
    if (t && Math.abs(t.b) < 1e-6 && Math.abs(t.c) < 1e-6) {
        // axis-aligned: blit at whole device pixels so small badges stay crisp
        const dx = Math.round(t.a * x + t.e - dw / 2);
        const dy = Math.round(t.d * y + t.f - dw / 2);
        c.setTransform(1, 0, 0, 1, 0, 0);
        if (k === 1) c.drawImage(s.cv, dx, dy);
        else c.drawImage(s.cv, dx, dy, dw, dw);
    } else {
        const w = dw / sc;
        c.drawImage(s.cv, x - w / 2, y - w / 2, w, w);
    }
    c.restore();
}

const urlCache = new Map();
// A PNG data URL for DOM use (the menu chip, profile). cssPx is the CSS size.
export function badgeDataUrl(division, cssPx, opts) {
    if (division == null) return '';
    const dpr = Math.min(3, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const devPx = Math.max(8, Math.round(cssPx * dpr));
    const key = resolve(division).key + '|' + devPx + '|' + ((opts && opts.legendNo) | 0);
    let u = urlCache.get(key);
    if (u) return u;
    const cv = document.createElement('canvas');
    cv.width = cv.height = devPx;
    const c = cv.getContext('2d');
    c.translate(devPx / 2, devPx / 2);
    // scale down slightly so the rim never touches the edge of the image
    c.scale(0.94, 0.94);
    if (devPx >= 64) paintBadge(c, division, devPx, Object.assign({}, opts, { lod: 'full' }));
    else paintShrunk(c, division, devPx, opts);
    u = cv.toDataURL('image/png');
    urlCache.set(key, u);
    if (urlCache.size > 64) urlCache.delete(urlCache.keys().next().value);
    return u;
}

// Render a badge onto its own canvas (the ceremony shatters this one).
export function badgeCanvas(division, devPx, opts) {
    const pad = Math.ceil(devPx * 0.06) + 2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = devPx + pad * 2;
    const c = cv.getContext('2d');
    c.translate(cv.width / 2, cv.height / 2);
    paintBadge(c, division, devPx, opts);
    return cv;
}

export const DIVISION_ROMAN = ROMAN;
