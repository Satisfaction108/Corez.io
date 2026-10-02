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


// ── touch play or mouse and keys ────────────────────────────────────────
// A user agent string can say "Android" on a PC (a UA switcher, devtools,
// some embeds) and a laptop can have a touch screen, so neither decides on
// its own. env: { ua, maxTouchPoints, coarse, fine } where coarse is
// "(pointer: coarse)" (the primary pointer is a finger) and fine is
// "(any-pointer: fine)" (some mouse, trackpad or pen); either may be null
// when matchMedia is missing.
const TOUCH_UA = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i;
export function touchPrimary(env) {
    const ua = env.ua || "";
    const points = env.maxTouchPoints | 0;
    // iPadOS says it is a Mac; its touch points give it away
    const touchUa = TOUCH_UA.test(ua) || (/Macintosh/.test(ua) && points > 1);
    if (!(points > 0) && !touchUa) return false;
    // the primary pointer is the real answer: a finger on phones and tablets,
    // the mouse or trackpad on a touch screen laptop
    if (env.coarse != null) return !!env.coarse;
    return touchUa;
}

// Flips between the two while playing: a real touch on the game turns touch
// play on, a mouse that actually moves (or clicks) turns it off, and so do
// game keys when there is a pointer to aim with (an iPad with only a
// keyboard keeps its aim stick). Returns true (touch), false (mouse and
// keys) or null (stay as you are).
export const MODE = {
    TRAVEL: 24,         // CSS px a mouse has to move in one go
    GAP_MS: 400,        // a pause this long starts the count again
    AFTER_TOUCH_MS: 800 // mouse events this soon after a touch are the browser's copies
};
// env: the touchPrimary object, or a function returning it (a trackpad can
// be plugged in or out while you play)
export function inputModeWatch(env) {
    let touchAt = -1e9, travel = 0, lx = null, ly = null, lt = 0;
    return {
        touch(t) {
            touchAt = t; travel = 0; lx = null;
            return true;
        },
        mouseMove(x, y, t, mobile) {
            if (!mobile || t - touchAt < MODE.AFTER_TOUCH_MS) { lx = x; ly = y; lt = t; travel = 0; return null; }
            // a device with a fine pointer: any real move is the mouse, at
            // once (slow frames coalesce moves and space them past GAP_MS,
            // so a travel count could never add up and the aim stayed stuck)
            const e = typeof env === "function" ? env() : env;
            if (e && e.fine && lx !== null && (x !== lx || y !== ly)) { lx = x; ly = y; lt = t; travel = 0; return false; }
            if (lx === null || t - lt > MODE.GAP_MS) travel = 0;
            else travel += Math.hypot(x - lx, y - ly);
            lx = x; ly = y; lt = t;
            if (travel < MODE.TRAVEL) return null;
            travel = 0;
            return false;
        },
        mouseDown(t, mobile) {
            if (!mobile || t - touchAt < MODE.AFTER_TOUCH_MS) return null;
            return false;
        },
        key(t, mobile) {
            const e = typeof env === "function" ? env() : env;
            if (!mobile || !(e && e.fine)) return null;
            return false;
        },
    };
}
