// The crown, drawn once per tint and size and reused: the Dig Wars leader
// crown (app.js drawCrown) with an ink rim. Three spikes with ball tips,
// soft corners, one flat gold, one lighter flat facet. No gradients, no glow.
// No imports, so crowns.js, raidFinale.js and raidShare.js can all use it.

const INK = "#120e15";
const TINTS = {
    gold: ["#f2b83c", "#ffd978"],
    silver: ["#d9d4e2", "#ffffff"],
    bronze: ["#e07b2e", "#ffb27a"],
};
// The shape in units where the Dig Wars crown is 1 wide (base centre at 0, 0)
const BODY = [[-0.38, 0], [-0.5, -0.631], [-0.165, -0.343], [0, -0.768], [0.165, -0.343], [0.5, -0.631], [0.38, 0]];
const TIPS = [[-0.5, -0.631], [0, -0.768], [0.5, -0.631]];
const FACET = [[-0.32, -0.07], [-0.42, -0.52], [-0.24, -0.36], [-0.24, -0.07]];
const ROUND = 0.152, TIP_R = 0.148;
// how wide and tall it really is (tips and corners included), in those units
const SPAN_W = 1 + 2 * TIP_R;              // 1.296
const TOP = 0.768 + TIP_R, BOT = ROUND / 2; // above and below the base line
export const ASPECT = (TOP + BOT) / SPAN_W; // height / width, about 0.77

const OS = 2;          // baked at twice the drawn size
const STEP = 1.15;     // one bake per 15 % of width
const cache = new Map();

// the rim scales with the crown like a tank's border, within reason
const rimFor = (w) => Math.max(1.25, Math.min(4.5, w * 0.06));

function lighter(hex) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (v) => Math.round(v + (255 - v) * 0.45);
    return "#" + ((1 << 24) | (mix((n >> 16) & 255) << 16) | (mix((n >> 8) & 255) << 8) | mix(n & 255)).toString(16).slice(1);
}

// -> { cv, w, ax, ay }: the crown is `w` sprite px wide, its base centre at
// (ax, ay). Draw with scale (wanted width / w).
export function crownSprite(tint = "gold", width = 60) {
    const b = Math.max(1, Math.round(Math.log(Math.max(4, width)) / Math.log(STEP)));
    const key = tint + b;
    let s = cache.get(key);
    if (s) return s;
    const [fill, hi] = TINTS[tint] || (typeof tint === "string" && /^#[0-9a-f]{6}$/i.test(tint) ? [tint, lighter(tint)] : TINTS.gold);
    const dw = Math.pow(STEP, b);          // drawn width this bake is for
    const rim = rimFor(dw) * OS;
    const W = dw * OS, u = W / SPAN_W;
    const pad = Math.ceil(rim + 2);
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(W + pad * 2);
    cv.height = Math.ceil((TOP + BOT) * u + pad * 2);
    const c = cv.getContext("2d");
    const ax = cv.width / 2, ay = pad + TOP * u;
    c.translate(ax, ay);
    c.lineJoin = "round"; c.lineCap = "round";
    const path = (pts) => {
        c.beginPath();
        pts.forEach(([x, y], i) => i ? c.lineTo(x * u, y * u) : c.moveTo(x * u, y * u));
        c.closePath();
    };
    const tips = (r) => { for (const [x, y] of TIPS) { c.beginPath(); c.arc(x * u, y * u, r, 0, Math.PI * 2); c.fill(); } };
    // ink rim: the same silhouette grown by the rim
    c.fillStyle = c.strokeStyle = INK;
    path(BODY); c.lineWidth = ROUND * u + rim * 2; c.stroke(); c.fill();
    tips(TIP_R * u + rim);
    // flat gold: a fat same-colour stroke first for the soft corners
    c.fillStyle = c.strokeStyle = fill;
    path(BODY); c.lineWidth = ROUND * u; c.stroke(); c.fill();
    tips(TIP_R * u);
    // one lighter flat facet down the left spike
    c.fillStyle = hi;
    path(FACET); c.fill();
    s = { cv, w: W, ax, ay };
    if (cache.size > 80) cache.clear();
    cache.set(key, s);
    return s;
}

// a crown `w` wide with its base centre on (x, y)
export function drawCrown(c, x, y, w, alpha = 1, tint = "gold") {
    if (!(w > 0) || alpha <= 0) return;
    const s = crownSprite(tint, w);
    const k = w / s.w;
    const a = c.globalAlpha;
    c.globalAlpha = a * alpha;
    c.drawImage(s.cv, x - s.ax * k, y - s.ay * k, s.cv.width * k, s.cv.height * k);
    c.globalAlpha = a;
}

// an icon `h` tall centred on (x, y)
export function drawCrownIcon(c, x, y, h, tint = "gold", alpha = 1) {
    const w = h / ASPECT;
    drawCrown(c, x, y + h / 2 - BOT * (w / SPAN_W), w, alpha, tint);
}
