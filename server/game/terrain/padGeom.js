// Pad geometry shared by vault, shop and outpost pads: the shape the client
// draws is the shape that collides, and leaving a pad is a firm shove, not a
// bounce. Vault/bank pads are flat-top octagons (1.15x the pad radius), shop
// pads hexagons (1.16x), outposts plain circles.
// 1.40 = the octagon the client draws (v.r * 1.15 * 1.22); the hitbox must be
// the shape players see or tanks sink into the pad edge before the push.
const OCT = { sides: 8, scale: 1.40 };
const HEX = { sides: 6, scale: 1.16 };
const CIRCLE = { sides: 0, scale: 1 };
const PAD_IMPULSE = 6;        // one outward kick (units/tick) when a hold starts
const PAD_FORCE = 1.2;        // radial accel per tick while inside, scaled by depth
const PAD_FORCE_MIN = 0.25;
const PAD_CLAMP_FRAC = 0.55;  // deeper than this fraction of the hull snaps out
const PAD_EXPEL = 7;          // outward speed (units/tick) while being shoved off from inside

function shapeOf(pad) {
    // base banks are drawn as the same octagon as vaults, so their rules
    // use it too; only shops are hexagons
    const s = pad.kind === 'shop' ? HEX : OCT;
    return { sides: s.sides, R: (pad.r || 95) * s.scale };
}

// Regular n-gon (even n) with a face centred on +x, circumradius R.
function insideNgon(dx, dy, R, sides) {
    if (!sides) return dx * dx + dy * dy < R * R;
    const a = R * Math.cos(Math.PI / sides);
    for (let k = 0; k < sides / 2; k++) {
        const ang = k * 2 * Math.PI / sides;
        const d = dx * Math.cos(ang) + dy * Math.sin(ang);
        if (d > a || d < -a) return false;
    }
    return true;
}

function insidePad(pad, x, y, margin = 0) {
    const { sides, R } = shapeOf(pad);
    return insideNgon(x - pad.x, y - pad.y, R + margin, sides);
}

// Nearest way out: face normal and penetration depth, or null when clear.
function projectOut(pad, body, margin = 0) {
    const { sides, R } = shapeOf(pad);
    const dx = body.x - pad.x, dy = body.y - pad.y;
    if (!sides) {
        const r = R + margin, d = Math.hypot(dx, dy);
        if (d >= r) return null;
        const n = d < 1e-3 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
        return { nx: Math.cos(n), ny: Math.sin(n), depth: r - d };
    }
    const a = (R + margin) * Math.cos(Math.PI / sides);
    let bestK = 0, bestD = -Infinity, sign = 1;
    for (let k = 0; k < sides / 2; k++) {
        const ang = k * 2 * Math.PI / sides;
        const d = dx * Math.cos(ang) + dy * Math.sin(ang);
        const ad = Math.abs(d);
        if (ad > bestD) { bestD = ad; bestK = k; sign = d >= 0 ? 1 : -1; }
    }
    if (bestD >= a) return null;
    if (dx === 0 && dy === 0) { bestK = (Math.random() * (sides / 2)) | 0; sign = Math.random() < 0.5 ? -1 : 1; }
    const ang = bestK * 2 * Math.PI / sides;
    return { nx: sign * Math.cos(ang), ny: sign * Math.sin(ang), depth: a - bestD };
}

// Keep a body's hull out of a pad. Returns true once it is clear.
//   1. one impulse when the hold starts (keyed so re-entry gets a fresh kick)
//   2. a soft outward force every tick while overlapping
//   3. a position clamp only when the hull is deep inside
// `hard`: the rim is a wall (re-entry denials). The body is placed back on
// the rim every tick and its inward velocity is removed, so it stops at the
// border instead of sinking in and being lurched out.
function keepOut(body, pad, margin, key, hard = false) {
    const rs = body.realSize || 60;
    const p = projectOut(pad, body, rs + margin);
    if (!p) {
        if (body._padHold && body._padHold.key === key) body._padHold = null;
        return true;
    }
    const { nx, ny, depth } = p;
    if (hard === 'expel') {
        // shoved off from inside (time's up, pad taken): hold an outward
        // speed and drop any inward push. No position writes at all, so the
        // tank rolls off the pad instead of teleporting to the rim.
        const vOut = body.velocity.x * nx + body.velocity.y * ny;
        if (vOut < PAD_EXPEL) {
            body.velocity.x += (PAD_EXPEL - vOut) * nx;
            body.velocity.y += (PAD_EXPEL - vOut) * ny;
        }
        const aIn = body.accel.x * nx + body.accel.y * ny;
        if (aIn < 0) { body.accel.x -= aIn * nx; body.accel.y -= aIn * ny; }
        body._padHold = null;
        return false;
    }
    // a fresh kick gets one soft impulse so the tank visibly slides off;
    // after that the rim is a wall
    const nowK = Date.now();
    if (!body._padHold || body._padHold.key !== key) body._padHold = { key, at: nowK, kicked: false };
    if (hard || nowK - body._padHold.at > 600) {
        body.x += nx * depth;
        body.y += ny * depth;
        const vIn = body.velocity.x * nx + body.velocity.y * ny;
        if (vIn < 0) { body.velocity.x -= vIn * nx; body.velocity.y -= vIn * ny; }
        const aIn = body.accel.x * nx + body.accel.y * ny;
        if (aIn < 0) { body.accel.x -= aIn * nx; body.accel.y -= aIn * ny; }
        try {
            const tg = global.gameManager.terrainGrid;
            if (tg && tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(body, rs);
        } catch { /* */ }
        return false;
    }
    if (!body._padHold.kicked) {
        body._padHold.kicked = true;
        const vOut = body.velocity.x * nx + body.velocity.y * ny;
        if (vOut < PAD_IMPULSE) {
            body.velocity.x += (PAD_IMPULSE - vOut) * nx;
            body.velocity.y += (PAD_IMPULSE - vOut) * ny;
        }
    }
    const f = PAD_FORCE_MIN + PAD_FORCE * Math.min(1, depth / rs);
    body.accel.x += nx * f;
    body.accel.y += ny * f;
    if (depth > rs * PAD_CLAMP_FRAC) {
        const move = depth - rs * PAD_CLAMP_FRAC * 0.5;
        body.x += nx * move;
        body.y += ny * move;
        const vIn = body.velocity.x * nx + body.velocity.y * ny;
        if (vIn < 0) { body.velocity.x -= vIn * nx; body.velocity.y -= vIn * ny; }
        try {
            const tg = global.gameManager.terrainGrid;
            if (tg && tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(body, rs);
        } catch { /* */ }
    }
    return false;
}

module.exports = { OCT, HEX, shapeOf, insideNgon, insidePad, projectOut, keepOut, PAD_IMPULSE };
