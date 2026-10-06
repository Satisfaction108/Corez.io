// Sidekick looks: little arras tanks from the catalog (shared/cosmetics.js
// item.kick), all wearing the same smiley, plus their body skins (item.look)
// and their own name styles. Flat colours and one outline weight, like the
// game's tanks. Three layers, so the face stays upright while the barrels
// turn:
//   drawUnder(c, kick, r)                 barrels, a Smasher's spikes (turns)
//   drawBody(c, kick, look, r, col)       body, its skin and the face (upright)
//   drawOver(c, kick, r)                  an Auto turret on the rim (turns)
// All centred on (0, 0) at body radius r. The game bakes each layer into a
// sprite once and turns the barrel sprites with one drawImage a frame
// (sidekicks.js); the menu draws them straight onto its preview canvases.
// bakeName() bakes a name tag; drawShot() is the only per-frame path drawing.

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

/* ── colours ────────────────────────────────────────────────────────── */
// the HUD ink: the face, the outlines' dark end, name tag strokes
export const INK = '#120e15';
// arras barrel grey
export const BARREL = '#a7a7af';
// outline width, in body radii (the game's tank outline at a sidekick's size)
export const LINE = 0.19;

function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const n = m ? parseInt(m[1], 16) : 0x9aa0a8;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const h2 = (v) => { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); };
export function mix(a, b, t) {
    const x = rgb(a), y = rgb(b);
    return '#' + h2(x[0] + (y[0] - x[0]) * t) + h2(x[1] + (y[1] - x[1]) * t) + h2(x[2] + (y[2] - x[2]) * t);
}
// the outline of anything filled with `col`: a dark shade of it
export const edgeOf = (col) => mix(col, INK, 0.62);

// The body colour actually drawn: the Locker colour, else the design's.
// A skin never changes it (owner rule, Oct 6 2026); `look` is ignored here.
export function bodyColor(kick, look, col) {
    return col || kick.col;
}

/* ── barrels ────────────────────────────────────────────────────────── */
// A trapezoid from x0 to x1 along +x, w0 wide at x0 and w1 at x1, centred on y.
function trap4(c, x0, x1, w0, w1, y) {
    c.beginPath();
    c.moveTo(x0, y - w0 / 2); c.lineTo(x1, y - w1 / 2); c.lineTo(x1, y + w1 / 2); c.lineTo(x0, y + w0 / 2);
    c.closePath();
}
function paint(c, fill, lw) {
    c.fillStyle = fill; c.fill();
    c.lineWidth = lw; c.strokeStyle = edgeOf(fill); c.stroke();
}
// one barrel: [degrees, length, width, aspect, side offset, kind]
function gun(c, g, r, lw) {
    const L = g[1] * r, w = g[2] * r, a = g[3] == null ? 1 : g[3], y = (g[4] || 0) * r, kind = g[5] || '';
    c.save();
    c.rotate(g[0] * D2R);
    if (kind === 'trap') {
        // a straight barrel, then the trap lip flaring out at the end
        const lip = 0.34 * r;
        trap4(c, 0, L - lip, w, w, y); paint(c, BARREL, lw);
        trap4(c, L - lip, L, w, w * 1.7, y); paint(c, BARREL, lw);
    } else if (kind === 'launch') {
        // a tube with a wide launcher mouth flaring out of its front
        trap4(c, 0, L * 0.72, w * 0.78, w * 0.78, y); paint(c, BARREL, lw);
        trap4(c, L * 0.52, L, w * 0.82, w * 1.28, y); paint(c, BARREL, lw);
    } else {
        trap4(c, 0, L, w, w * a, y); paint(c, BARREL, lw);
    }
    c.restore();
}
// a Smasher's spiky collar: a six point star a bit bigger than the body
const SPIKE = '#77757f';
function spikes(c, r, lw) {
    c.beginPath();
    for (let i = 0; i < 12; i++) {
        const a = i * TAU / 12, rr = (i % 2 ? 0.98 : 1.42) * r;
        if (i) c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else c.moveTo(rr, 0);
    }
    c.closePath();
    paint(c, SPIKE, lw);
}

// The turning layer under the body.
export function drawUnder(c, kick, r) {
    const lw = Math.max(1, LINE * r);
    c.lineJoin = 'round'; c.lineCap = 'round';
    if (kick.body === 'smasher') spikes(c, r, lw);
    for (const g of kick.guns) gun(c, g, r, lw);
}

export const hasOver = (kick) => !!kick.turret;
// The turning layer over the body: an Auto turret riding the rim, its
// barrel pointing out. Kept clear of the face.
export function drawOver(c, kick, r) {
    const t = kick.turret;
    if (!t) return;
    const lw = Math.max(1, LINE * r);
    const a = (t.at || 0) * D2R, tr = (t.r || 0.4) * r, d = r * 0.92;
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.save();
    c.rotate(a);
    c.translate(d, 0);
    trap4(c, 0, tr * 2.1, tr * 0.95, tr * 0.95, 0); paint(c, BARREL, lw);
    c.beginPath(); c.arc(0, 0, tr, 0, TAU); paint(c, BARREL, lw);
    c.restore();
}

/* ── the body ───────────────────────────────────────────────────────── */
function bodyPath(c, shape, r) {
    c.beginPath();
    if (shape === 'pumpkin') {
        for (let i = 0; i <= 60; i++) {
            const a = i * TAU / 60, rr = r * (0.93 + 0.07 * Math.abs(Math.cos(a * 3)));
            const x = Math.cos(a) * rr * 1.08, y = Math.sin(a) * rr * 0.97 + 0.03 * r;
            i ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        c.closePath();
    } else {
        c.arc(0, 0, r, 0, TAU);
    }
}
function seeded(n) {
    let a = n | 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// the smiley's patch of the body, kept clear of busy skin patterns
const onFace = (x, y, r) => (x / (0.62 * r)) ** 2 + ((y - 0.02 * r) / (0.5 * r)) ** 2 < 1;
function sparkle(c, x, y, s) {
    c.beginPath();
    c.moveTo(x, y - s); c.quadraticCurveTo(x, y, x + s, y); c.quadraticCurveTo(x, y, x, y + s);
    c.quadraticCurveTo(x, y, x - s, y); c.quadraticCurveTo(x, y, x, y - s);
    c.closePath();
}
// A skin's paint, clipped to the body. Flat shades of the body colour, so
// it works with any Locker colour; the face goes on top untouched.
function skinFill(c, fill, body, r, shape) {
    switch (fill) {
        case 'stripes': {
            c.fillStyle = mix(body, '#ffffff', 0.38);
            const w = 0.26 * r, gap = 0.62 * r;
            for (let x = -2.2 * r; x < 2.2 * r; x += gap) {
                c.beginPath();
                c.moveTo(x, -1.3 * r); c.lineTo(x + w, -1.3 * r); c.lineTo(x + w + 1.3 * r, 1.3 * r); c.lineTo(x + 1.3 * r, 1.3 * r);
                c.closePath(); c.fill();
            }
            break;
        }
        case 'dots': {
            c.fillStyle = mix(body, '#ffffff', 0.78);
            const s = 0.52 * r;
            let row = 0;
            for (let y = -1.2 * r; y < 1.3 * r; y += s * 0.87, row++) {
                for (let x = -1.3 * r + (row % 2 ? s / 2 : 0); x < 1.3 * r; x += s) {
                    if (onFace(x, y, r)) continue;
                    c.beginPath(); c.arc(x, y, 0.12 * r, 0, TAU); c.fill();
                }
            }
            break;
        }
        case 'twoTone':
            c.fillStyle = mix(body, INK, 0.32);
            c.fillRect(-1.3 * r, 0.44 * r, 2.6 * r, r);
            c.fillStyle = mix(body, '#ffffff', 0.3);
            c.fillRect(-1.3 * r, 0.36 * r, 2.6 * r, 0.08 * r);
            break;
        case 'checker': {
            c.fillStyle = mix(body, '#ffffff', 0.34);
            const s = 0.5 * r;
            for (let i = -3; i < 3; i++) for (let j = -3; j < 3; j++) if ((i + j) & 1) c.fillRect(i * s, j * s, s, s);
            break;
        }
        case 'camo': {
            const rnd = seeded(41);
            const shades = [mix(body, INK, 0.3), mix(body, '#ffffff', 0.28), mix(body, INK, 0.5)];
            for (let i = 0, n = 0; i < 40 && n < 10; i++) {
                const a = rnd() * TAU, d = (0.55 + rnd() * 0.5) * r, ex = (0.2 + rnd() * 0.16) * r, ey = (0.12 + rnd() * 0.08) * r, rot = rnd() * Math.PI;
                const x = Math.cos(a) * d, y = Math.sin(a) * d;
                if (onFace(x, y, r * 1.35)) continue;
                c.fillStyle = shades[n++ % 3];
                c.beginPath(); c.ellipse(x, y, ex, ey, rot, 0, TAU); c.fill();
            }
            break;
        }
        case 'frost': {
            // a frosted rim and an icy cap, pale tints of its own colour
            const pale = mix(body, '#ffffff', 0.62), ice = mix(body, '#ffffff', 0.8);
            c.lineWidth = 0.38 * r; c.strokeStyle = pale;
            bodyPath(c, shape, r); c.stroke();
            c.beginPath();
            c.moveTo(-1.1 * r, -0.55 * r);
            c.quadraticCurveTo(-0.75 * r, -0.4 * r, -0.55 * r, -0.62 * r);
            c.quadraticCurveTo(-0.35 * r, -0.44 * r, -0.12 * r, -0.66 * r);
            c.quadraticCurveTo(0.12 * r, -0.46 * r, 0.36 * r, -0.64 * r);
            c.quadraticCurveTo(0.6 * r, -0.44 * r, 0.8 * r, -0.6 * r);
            c.quadraticCurveTo(0.95 * r, -0.5 * r, 1.1 * r, -0.55 * r);
            c.lineTo(1.1 * r, -1.2 * r); c.lineTo(-1.1 * r, -1.2 * r);
            c.closePath();
            c.fillStyle = ice; c.fill();
            c.lineWidth = Math.max(1, LINE * r * 0.55); c.strokeStyle = edgeOf(body); c.stroke();
            break;
        }
        case 'gold': {
            // a gilded rim: a light band inside the outline, studs on it, a shine
            const rim = mix(body, '#ffffff', 0.5), stud = mix(body, '#ffffff', 0.82), ink = edgeOf(body);
            c.lineWidth = 0.6 * r; c.strokeStyle = rim;
            bodyPath(c, shape, r); c.stroke();
            c.lineWidth = Math.max(1, LINE * r * 0.5); c.strokeStyle = ink;
            c.beginPath(); c.arc(0, 0, 0.7 * r, 0, TAU); c.stroke();
            for (let i = 0; i < 8; i++) {
                const a = (i + 0.5) * TAU / 8;
                c.beginPath(); c.arc(Math.cos(a) * 0.8 * r, Math.sin(a) * 0.8 * r, 0.075 * r, 0, TAU);
                c.fillStyle = stud; c.fill(); c.lineWidth = Math.max(1, LINE * r * 0.4); c.strokeStyle = ink; c.stroke();
            }
            c.fillStyle = mix(body, '#ffffff', 0.55);
            c.beginPath(); c.ellipse(-0.42 * r, -0.5 * r, 0.2 * r, 0.07 * r, -0.7, 0, TAU); c.fill();
            break;
        }
        case 'galaxy': {
            // a little planet: shade on one side, an orbit ring below the
            // smile, stars twinkling over the top, all in its own colour
            c.fillStyle = mix(body, INK, 0.36);
            c.beginPath(); c.arc(0, 0, 1.3 * r, 0, TAU); c.arc(-0.36 * r, -0.36 * r, 1.08 * r, 0, TAU, true); c.fill('evenodd');
            const ring = mix(body, '#ffffff', 0.55), ink = edgeOf(body);
            c.beginPath(); c.ellipse(0, 0.8 * r, 1.25 * r, 0.2 * r, -0.12, 0, TAU);
            c.lineWidth = 0.2 * r; c.strokeStyle = ink; c.stroke();
            c.lineWidth = 0.1 * r; c.strokeStyle = ring; c.stroke();
            c.fillStyle = mix(body, '#ffffff', 0.85); c.strokeStyle = ink; c.lineWidth = Math.max(1, LINE * r * 0.4);
            for (const [x, y, k] of [[-0.6, -0.62, 0.17], [0.58, -0.66, 0.13], [0.8, -0.1, 0.09], [-0.86, -0.08, 0.08]]) {
                sparkle(c, x * r, y * r, k * r); c.stroke(); c.fill();
            }
            break;
        }
    }
}
function pumpkinBits(c, r, lw, body) {
    // the ribs (the stem goes on after the outline)
    c.strokeStyle = mix(body, INK, 0.25); c.lineWidth = Math.max(1, lw * 0.7);
    for (const k of [-0.55, 0.55]) {
        c.beginPath(); c.moveTo(k * r * 0.5, -0.92 * r); c.quadraticCurveTo(k * r * 1.15, 0.03 * r, k * r * 0.5, 0.98 * r); c.stroke();
    }
}
function stem(c, r, lw) {
    c.beginPath();
    c.moveTo(-0.13 * r, -0.86 * r); c.lineTo(-0.1 * r, -1.22 * r); c.quadraticCurveTo(0.12 * r, -1.36 * r, 0.24 * r, -1.2 * r);
    c.lineTo(0.13 * r, -1.1 * r); c.lineTo(0.13 * r, -0.86 * r); c.closePath();
    paint(c, '#5f9e45', lw);
}

// The smiley: dot eyes and a curved smile in the HUD ink, the outline's
// weight. Every sidekick, every skin, always the same.
export function drawFace(c, r) {
    const lw = Math.max(1, LINE * r);
    c.fillStyle = INK;
    for (const s of [-1, 1]) { c.beginPath(); c.arc(s * 0.3 * r, -0.14 * r, Math.max(1, 0.105 * r), 0, TAU); c.fill(); }
    c.beginPath(); c.arc(0, 0.02 * r, 0.3 * r, 0.2 * Math.PI, 0.8 * Math.PI);
    c.lineWidth = lw; c.lineCap = 'round'; c.strokeStyle = INK; c.stroke();
}

// The upright layer. look: a sidekick skin's look or null; col: the Locker
// colour or null.
export function drawBody(c, kick, look, r, col) {
    const body = bodyColor(kick, look, col);
    const lw = Math.max(1, LINE * r);
    const fill = look && look.fill;
    c.lineJoin = 'round'; c.lineCap = 'round';
    bodyPath(c, kick.body, r);
    c.fillStyle = body; c.fill();
    if (fill || kick.body === 'pumpkin') {
        c.save();
        bodyPath(c, kick.body, r);
        c.clip();
        if (fill) skinFill(c, fill, body, r, kick.body);
        if (kick.body === 'pumpkin') pumpkinBits(c, r, lw, body);
        c.restore();
    }
    bodyPath(c, kick.body, r);
    c.lineWidth = lw; c.strokeStyle = edgeOf(body); c.stroke();
    if (kick.body === 'pumpkin') stem(c, r, lw);
    drawFace(c, r);
}

// All three layers at once (menu previews): barrels turned to `face` radians.
export function drawSidekick(c, kick, look, r, col, face) {
    c.save(); c.rotate(face || 0); drawUnder(c, kick, r); c.restore();
    drawBody(c, kick, look, r, col);
    if (kick.turret) { c.save(); c.rotate(face || 0); drawOver(c, kick, r); c.restore(); }
}

// How far each layer reaches from the centre, in body radii (sprite sizes).
export function underReach(kick) {
    let m = kick.body === 'smasher' ? 1.42 : 1;
    for (const g of kick.guns) {
        const a = g[3] == null ? 1 : g[3];
        const w = g[2] * Math.max(1, a, g[5] === 'trap' ? 1.7 : g[5] === 'launch' ? 1.28 : 1) / 2;
        m = Math.max(m, Math.hypot(g[1], Math.abs(g[4] || 0) + w));
    }
    return m + LINE;
}
export function bodyReach(kick) { return (kick.body === 'pumpkin' ? 1.4 : 1.1) + LINE * 0.85; }
export function overReach(kick) {
    const t = kick.turret;
    return t ? 0.92 + (t.r || 0.4) * 2.1 + LINE : 0;
}
// the muzzle of barrel g, for shots: [x, y] in body radii at facing 0
export function muzzle(g) {
    const a = g[0] * D2R, L = g[1], y = g[4] || 0;
    return [Math.cos(a) * L - Math.sin(a) * y, Math.sin(a) * L + Math.cos(a) * y];
}

/* ── shots ──────────────────────────────────────────────────────────── */
// A harmless shot in the sidekick's colour. kind: bullet | trap | drone |
// ring (a Smasher's pop). k = 0..1 through its life; it swells a little as
// it pops at the end. Paths only, nothing allocated.
export function drawShot(c, kind, x, y, s, ang, col, k) {
    const lw = Math.max(1, s * 0.3);
    const pop = k > 0.7 ? 1 + (k - 0.7) * 1.4 : 1;
    c.lineJoin = 'round';
    if (kind === 'ring') {
        c.beginPath(); c.arc(x, y, s * (1 + k * 2.2), 0, TAU);
        c.lineWidth = lw * 1.2; c.strokeStyle = col; c.stroke();
        return;
    }
    c.beginPath();
    if (kind === 'trap' || kind === 'drone') {
        const sz = s * 1.35 * pop, a0 = kind === 'trap' ? ang + k * 4 : ang;
        for (let i = 0; i < 3; i++) {
            const a = a0 + i * TAU / 3;
            if (i) c.lineTo(x + Math.cos(a) * sz, y + Math.sin(a) * sz); else c.moveTo(x + Math.cos(a) * sz, y + Math.sin(a) * sz);
        }
        c.closePath();
    } else {
        c.arc(x, y, s * pop, 0, TAU);
    }
    c.fillStyle = col; c.fill();
    c.lineWidth = lw; c.strokeStyle = edgeOf(col); c.stroke();
}

/* ── name tags ──────────────────────────────────────────────────────── */
// Sidekick name styles (cat 'sdName', style.kind): their own looks, not the
// players'. Everything here is baked once into a canvas (bakeName), so the
// game and the menu only ever blit a finished tag.
const FONT = (px) => 'bold ' + px + 'px Rubik, Ubuntu, sans-serif';
// room around the letters for strokes and sparkles, in font px
function padOf(st) {
    const k = st && st.kind;
    return k === 'sticker' || k === 'bubbly' ? 0.5 : k === 'sparkle' ? 0.62 : k === 'pixel' ? 0.3 : 0.3;
}
function strokeFill(c, text, x, y, strokes, fill) {
    for (const [w, col] of strokes) { c.lineWidth = w; c.strokeStyle = col; c.strokeText(text, x, y); }
    c.fillStyle = fill; c.fillText(text, x, y);
}
// Draw `text` with its left edge at x and its middle at y. w: its width.
function drawNameAt(c, text, x, y, px, st, plain, w) {
    c.font = FONT(px);
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineCap = 'round';
    const kind = st && st.kind;
    if (kind === 'sticker') {
        // a die-cut sticker: ink edge, a fat white border, a soft drop
        c.globalAlpha = 0.35;
        strokeFill(c, text, x, y + px * 0.1, [[px * 0.62, st.rim || INK]], st.rim || INK);
        c.globalAlpha = 1;
        strokeFill(c, text, x, y, [[px * 0.62, st.rim || INK], [px * 0.44, st.edge || '#ffffff'], [px * 0.12, mix(st.fill, INK, 0.45)]], st.fill);
    } else if (kind === 'bubbly') {
        // puffy: a thick round outline in a soft colour around white letters
        strokeFill(c, text, x, y, [[px * 0.66, st.rim], [px * 0.48, st.puff], [px * 0.16, mix(st.puff, '#ffffff', 0.4)]], st.fill);
    } else if (kind === 'candy') {
        const g = c.createLinearGradient(x, 0, x + w, 0);
        st.stops.forEach((s, i) => g.addColorStop(i / Math.max(1, st.stops.length - 1), s));
        strokeFill(c, text, x, y, [[px * 0.3, st.rim]], g);
    } else if (kind === 'sparkle') {
        const g = c.createLinearGradient(0, y - px * 0.5, 0, y + px * 0.5);
        g.addColorStop(0, st.stops[0]); g.addColorStop(1, st.stops[1] || st.stops[0]);
        // the soft glow: the player name styles' passes (account/cosmetics.js
        // HALO_PASSES), a bright core hugging the ink, two soft steps out
        const glow = st.star || st.stops[1];
        for (const [k, a, hiCol] of [[2.3, 0.18, 0], [1.95, 0.42, 0], [1.6, 1, 1]]) {
            c.globalAlpha = a; c.lineWidth = px * 0.3 * k; c.strokeStyle = hiCol ? mix(glow, '#ffffff', 0.45) : glow;
            c.strokeText(text, x, y);
        }
        c.globalAlpha = 1;
        strokeFill(c, text, x, y, [[px * 0.3, st.rim]], g);
        c.fillStyle = st.star; c.strokeStyle = st.rim; c.lineWidth = Math.max(1, px * 0.07);
        // three little stars: before the name, and two after it
        for (const [sx, sy, s] of [[-0.28, -0.42, 0.26], [0.26, -0.5, 0.22], [0.18, 0.44, 0.15]]) {
            sparkle(c, sx < 0 ? x + sx * px : x + w + sx * px, y + sy * px, s * px);
            c.stroke(); c.fill();
        }
    } else if (kind === 'pixel') {
        pixelText(c, text, x, y, px, st);
    } else {
        strokeFill(c, text, x, y, [[Math.max(2, px * 0.26), INK]], plain || '#f2f2f2');
    }
}
// Chunky pixels: a little 5x7 font, each pixel a k x k block, with a one
// pixel rim all round. Letters it doesn't have (accents, other alphabets)
// fall back to the plain font in the same colours.
const PIX = {
    A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
    E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
    I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
    M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
    Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
    U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
    Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
    0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14],
    4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
    8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
    "'": [4, 4, 8, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], '_': [0, 0, 0, 0, 0, 0, 31], '!': [4, 4, 4, 4, 4, 0, 4], '-': [0, 0, 0, 31, 0, 0, 0],
    ' ': [0, 0, 0, 0, 0, 0, 0],
};
const pixK = (px) => Math.max(2, Math.round(px / 8));
function pixGlyphs(text) {
    const g = Array.from(String(text).toUpperCase());
    return g.every((ch) => PIX[ch]) ? g : null;
}
// the tag's width in px, or 0 when the font can't spell it
function pixWidth(text, px) {
    const g = pixGlyphs(text);
    return g ? (g.reduce((a, ch) => a + (ch === ' ' ? 3 : 6), 0) + 1) * pixK(px) : 0;
}
function pixelText(c, text, x, y, px, st) {
    const g = pixGlyphs(text);
    if (!g) { strokeFill(c, text, x, y, [[px * 0.3, st.rim]], st.fill); return; }
    const k = pixK(px), x0 = Math.round(x + k), y0 = Math.round(y - 3.5 * k);
    const cells = [];
    let cx = 0;
    for (const ch of g) {
        const rows = PIX[ch];
        for (let j = 0; j < 7; j++) for (let i = 0; i < 5; i++) if (rows[j] & (16 >> i)) cells.push(cx + i, j);
        cx += ch === ' ' ? 3 : 6;
    }
    c.fillStyle = st.rim;
    for (let n = 0; n < cells.length; n += 2) c.fillRect(x0 + (cells[n] - 1) * k, y0 + (cells[n + 1] - 1) * k, 3 * k, 3 * k);
    c.fillStyle = st.fill;
    for (let n = 0; n < cells.length; n += 2) c.fillRect(x0 + cells[n] * k, y0 + cells[n + 1] * k, k, k);
    // a lighter top row on each letter, like an old screen
    c.fillStyle = mix(st.fill, '#ffffff', 0.45);
    for (let n = 0; n < cells.length; n += 2) if (cells[n + 1] === 0) c.fillRect(x0 + cells[n] * k, y0, k, Math.max(1, k / 2));
}

// A finished name tag on its own canvas, `scale` device px per css px.
// -> {cv, w, h} with w, h in css px; draw it at (centre x - w / 2, y - h / 2).
export function bakeName(text, px, style, plain, scale) {
    const st = style && style.style ? style.style : style;
    const k = scale || 1;
    const m = document.createElement('canvas').getContext('2d');
    m.font = FONT(px);
    const tw = (st && st.kind === 'pixel' && pixWidth(text, px)) || Math.ceil(m.measureText(text).width);
    const pad = Math.ceil(px * padOf(st)) + 2;
    const w = tw + pad * 2, h = Math.ceil(px * (st && st.kind === 'sparkle' ? 2.1 : 1.8));
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(w * k); cv.height = Math.ceil(h * k);
    const c = cv.getContext('2d');
    c.scale(k, k);
    drawNameAt(c, text, pad, h / 2, px, st, plain, tw);
    return { cv, w, h, px };
}
