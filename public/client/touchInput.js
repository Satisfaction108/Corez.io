// Touch stick math, kept free of the DOM and the game state so it can be
// tested on its own (scripts/test/touchInput.test.js). touch.js uses it.

export const STICK = {
    R: 54,          // ring radius, CSS px
    DEAD: 0.16,     // no movement inside this fraction of the radius
    FULL: 0.82,     // full speed from here out
    FLOOR: 0.28,    // slowest crawl once past the dead zone
    FOLLOW: 1.3,    // past this the ring slides after the thumb
};

// Stick offset -> { x, y } scaled 0..1 with a dead zone and a soft curve:
// gentle just past the dead zone, full speed well before the rim.
export function stickVector(dx, dy, R = STICK.R) {
    const d = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    if (!(d > 0) || !(R > 0)) return { x: 0, y: 0, mag: 0, ang: 0 };
    const r = d / R;
    if (r <= STICK.DEAD) return { x: 0, y: 0, mag: 0, ang };
    const t = Math.min(1, (r - STICK.DEAD) / (STICK.FULL - STICK.DEAD));
    const mag = STICK.FLOOR + (1 - STICK.FLOOR) * t * t * (3 - 2 * t);
    return { x: Math.cos(ang) * mag, y: Math.sin(ang) * mag, mag, ang };
}

// The four movement bits (up 1, down 2, left 4, right 8) for a stick vector,
// eight ways, 45 degree sectors. The server still gets these: the idle kick,
// the spawn shield and old servers read them.
export function moveBits(v) {
    if (!v || !(v.mag > 0)) return 0;
    const ux = Math.cos(v.ang), uy = Math.sin(v.ang), k = 0.38268343;   // sin 22.5
    return (uy < -k ? 1 : 0) | (uy > k ? 2 : 0) | (ux < -k ? 4 : 0) | (ux > k ? 8 : 0);
}

// Analog move packed into one int for the command packet: 0 is "none",
// otherwise each axis is 1..255 with 128 as zero. Mirrored by the server
// (server/lib/touchMove.js).
export function packMove(v) {
    if (!v || !(v.mag > 0)) return 0;
    const q = (a) => 1 + Math.max(0, Math.min(254, Math.round((Math.max(-1, Math.min(1, a)) + 1) * 127)));
    return q(v.x) * 256 + q(v.y);
}
export function unpackMove(n) {
    if (!(n > 0) || n > 65535) return null;
    const qx = n >> 8, qy = n & 255;
    if (!qx || !qy) return null;
    let x = (qx - 1) / 127 - 1, y = (qy - 1) / 127 - 1;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    return { x, y };
}

// Aim assist: the candidate ({ ang, dist, pri }) closest to the aim line
// inside `cone` radians wins; the aim bends part of the way toward it.
// pri < 1 makes a candidate count as further off the line (rocks lose to tanks).
export function assistAim(ang, cands, cone = 0.21, pull = 0.6) {
    let best = null, bestScore = Infinity;
    for (const c of cands) {
        const diff = Math.atan2(Math.sin(c.ang - ang), Math.cos(c.ang - ang));
        if (Math.abs(diff) > cone) continue;
        const score = Math.abs(diff) / (c.pri || 1) + c.dist / 40000;
        if (score < bestScore) { bestScore = score; best = { diff, dist: c.dist }; }
    }
    if (!best) return { ang, dist: 0 };
    // full pull right on the line, easing out toward the edge of the cone
    const k = pull * (1 - Math.abs(best.diff) / cone * 0.5);
    return { ang: ang + best.diff * k, dist: best.dist };
}

