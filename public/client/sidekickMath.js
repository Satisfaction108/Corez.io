// Sidekick motion: pure maths for the game (sidekicks.js), the menu previews
// and the tests. World units and seconds; no DOM, no allocation per step
// (each sidekick keeps one state object).
//
// A sidekick eases toward a spot near its owner with frame-rate independent
// exponential smoothing (k = 1 - e^(-rate * dt)), following the owner's
// drawn position, so it trails a little behind and never twitches with the
// owner's network jitter. Each design's `move` (shared/cosmetics.js
// kick.move) picks how that spot drifts and how the body bobs. Hard rules,
// checked every step:
//   - never on its owner: at least CLEAR from the owner's edge, body to body
//   - never further than LEASH from the owner's edge
//   - a huge jump (respawn, a long grapple, a launch pad: the owner moved
//     JUMP in one step, or got SNAP away) puts it straight on its spot and
//     it fades back in over FADE_IN.

export const R = 13.75;         // body radius at size 1 (the first cut's 11, plus a quarter)
export const GAP = 22;          // its spot sits this far out from the owner's edge
export const CLEAR = 8;         // never closer than this to the owner's edge...
export const SOFT = 12;         // ...and eased out of the way within this much more
export const LEASH = 120;       // never further than this from the owner's edge
export const SNAP = 360;        // further than this from the edge: back to its spot
export const JUMP = 420;        // the owner moved this far in one step: back to its spot
export const FADE_IN = 0.3;     // seconds to fade back in after that
export const FOLLOW = 6;        // how fast it closes on its spot (1/s)
export const TURN = 9;          // how fast the barrels swing round (1/s)...
export const TURN_MAX = 7;      // ...but never faster than this (radians a second)
export const SPIN = 1.4;        // radians a second, for the spinners
export const SHOT_MIN = 1.5;    // seconds between shots, at least
export const SHOT_SPAN = 1.5;   // ...plus up to this (so 1.5 to 3 s)
export const AIM_LEAD = 0.6;    // the barrels swing to a shot's direction this long before it fires
export const SHOT_LIFE = 0.42;  // a shot pops this fast
export const SHOT_SPEED = 240;  // world units a second
export const SHOWN_ALPHA = 0.9;

const TAU = Math.PI * 2;
function hash(n) {
    let a = (n | 0) ^ 0x9e3779b9;
    a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
    a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
    return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
}

// Each fills o.x, o.y (the spot, relative to the owner), o.hop (lift),
// o.tilt (radians) and o.sq (vertical squash, 1 = none). All smooth in t,
// so the spot never jumps. D: the spot's distance from the owner's centre.
export const MOVES = {
    orbit(t, p, D, o) { const a = p + t * 0.45; o.x = Math.cos(a) * D; o.y = Math.sin(a) * D; o.hop = Math.sin(t * 2.4 + p) * 1.2; },
    orbitBack(t, p, D, o) { const a = p - t * 0.45; o.x = Math.cos(a) * D; o.y = Math.sin(a) * D; o.hop = Math.sin(t * 2.4 + p) * 1.2; },
    sway(t, p, D, o) {
        const a = p + Math.sin(t * 0.55) * 1.25;
        o.x = Math.cos(a) * D; o.y = Math.sin(a) * D;
        o.hop = Math.sin(t * 2.2 + p) * 1.5; o.tilt = Math.sin(t * 1.1 + p) * 0.05;
    },
    hover(t, p, D, o) {
        const a = p + t * 0.3; o.x = Math.cos(a) * D; o.y = Math.sin(a) * D;
        o.hop = 2 + Math.sin(t * 2 + p) * 2.5; o.tilt = Math.sin(t * 1.3 + p) * 0.06;
    },
    bounce(t, p, D, o) {
        const a = p + t * 0.4; o.x = Math.cos(a) * D; o.y = Math.sin(a) * D;
        const s = Math.abs(Math.sin(t * 3.6 + p));
        o.hop = s * 7;
        o.sq = 0.9 + 0.1 * Math.min(1, s * 4);
    },
    spin(t, p, D, o) { MOVES.orbit(t, p, D, o); },
    zip(t, p, D, o) {
        const a = p + t * 1.1, rr = D * (1 + 0.12 * Math.sin(t * 0.7 + p));
        o.x = Math.cos(a) * rr; o.y = Math.sin(a) * rr;
    },
    guard(t, p, D, o) { const a = p + t * 0.25; o.x = Math.cos(a) * D; o.y = Math.sin(a) * D; o.hop = Math.sin(t * 1.6 + p) * 1; },
    // the menu stage: drifts about on its owner's lower right, clear of a
    // barrel aimed up and to the right
    show(t, p, D, o) {
        const a = 0.62 + Math.sin(t * 0.5 + p) * 0.35;
        o.x = Math.cos(a) * D; o.y = Math.sin(a) * D;
        o.hop = Math.sin(t * 2.2) * 1.5;
    },
};
// barrels that turn round on their own
const SPINS = { spin: 1 };

// One per sidekick. seed: anything steady for that owner (its entity id),
// so every client starts it at the same place in its loop. path: a move
// for the spot alone (the menu stage), else `move` does both.
export function makeState(seed, move, path) {
    move = MOVES[move] ? move : 'orbit';
    return {
        move, path: MOVES[path] ? path : move, ph: hash(seed) * TAU, seed: seed | 0,
        x: 0, y: 0, init: false, snaps: 0, ox: 0, oy: 0, alpha: 1,
        hop: 0, tilt: 0, sq: 1, face: 0, aim: 0, aimAt: -1e9, firing: false,
        nextShot: 0, shots: 0, popAt: -1e9, tx: 0, ty: 0,
    };
}

const O = { x: 0, y: 0, hop: 0, tilt: 0, sq: 1 };
const P = { x: 0, y: 0, hop: 0, tilt: 0, sq: 1 };

// Advance one frame. (ox, oy): where the owner is drawn, in world units; oR
// its radius, ownerF its facing, size the sidekick's size multiplier, t
// seconds (any steady clock), dt seconds since the last step.
export function step(st, ox, oy, oR, ownerF, size, t, dt) {
    dt = Math.max(0, Math.min(0.1, dt));
    const r = R * (size || 1);
    const D = oR + GAP + r;
    O.x = 0; O.y = 0; O.hop = 0; O.tilt = 0; O.sq = 1;
    MOVES[st.move](t, st.ph, D, O);
    let sx = O.x, sy = O.y;
    if (st.path !== st.move) { P.x = 0; P.y = 0; MOVES[st.path](t, st.ph, D, P); sx = P.x; sy = P.y; }
    const tx = ox + sx, ty = oy + sy;
    st.tx = tx; st.ty = ty;
    const jumped = st.init && Math.hypot(ox - st.ox, oy - st.oy) > JUMP;
    const far = st.init && Math.hypot(st.x - ox, st.y - oy) > oR + SNAP;
    if (!st.init || jumped || far) {
        // first sight, or the owner went somewhere fast: on its spot, fading in
        if (st.init) st.snaps++;
        st.x = tx; st.y = ty;
        st.alpha = 0;
        st.face = ownerF;
        st.init = true;
    } else {
        const k = 1 - Math.exp(-FOLLOW * dt);
        st.x += (tx - st.x) * k;
        st.y += (ty - st.y) * k;
    }
    keepClear(st, ox, oy, oR, r, tx, ty, dt);
    st.ox = ox; st.oy = oy;
    st.alpha = Math.min(1, st.alpha + dt / FADE_IN);
    st.hop = O.hop; st.tilt = O.tilt; st.sq = O.sq;
    aimStep(st, ownerF, dt);
    return st;
}

// Where the barrels point: at a shot about to go, round and round for the
// spinners, else `want` (its owner's aim). Eased like the follow.
export function aimStep(st, want, dt) {
    if (st.firing) want = st.aim;
    if (SPINS[st.move] && !st.firing) {
        st.face += SPIN * dt;
    } else {
        const da = ((want - st.face) % TAU + TAU * 1.5) % TAU - Math.PI;
        const turn = da * (1 - Math.exp(-TURN * dt)), cap = TURN_MAX * dt;
        st.face += turn > cap ? cap : turn < -cap ? -cap : turn;
    }
    if (st.face > 1e4 || st.face < -1e4) st.face %= TAU;
}

// Outside the owner's body (plus CLEAR), inside the leash. Inside the SOFT
// band it is eased outward first, so an owner driving at it nudges it along
// instead of shoving it; the hard floor under that is a slide along the
// circle, never a jump (the correction is only as big as the overlap).
const PUSH = 16;
function keepClear(st, ox, oy, oR, r, tx, ty, dt) {
    const lo = oR + r + CLEAR, hi = oR + LEASH;
    let dx = st.x - ox, dy = st.y - oy;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) {
        // dead centre: out toward its spot
        dx = tx - ox; dy = ty - oy; d = Math.hypot(dx, dy);
        if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
    }
    let nd = d;
    if (d < lo + SOFT) nd = Math.max(lo, d + (lo + SOFT - d) * (1 - Math.exp(-PUSH * dt)));
    else if (d > hi) nd = hi;
    if (nd !== d) { st.x = ox + dx / d * nd; st.y = oy + dy / d * nd; }
}

// Time for a shot? A steady, easy rhythm: every SHOT_MIN..SHOT_MIN+SHOT_SPAN
// seconds, in a random direction. AIM_LEAD before it goes the barrels start
// swinging there (step() turns them); when it goes this returns the angle
// the barrels point now (so it leaves a muzzle), else NaN. A spinner just
// fires wherever it has got to. rnd: a 0..1 random source.
export function shotDue(st, t, rnd) {
    if (!st.nextShot) st.nextShot = t + SHOT_MIN * 0.5 + rnd() * SHOT_SPAN;
    if (!SPINS[st.move] && !st.firing && t >= st.nextShot - AIM_LEAD) {
        st.firing = true;
        st.aim = rnd() * TAU - Math.PI;
        st.aimAt = t;
    }
    if (t < st.nextShot) return NaN;
    st.nextShot = t + SHOT_MIN + rnd() * SHOT_SPAN;
    st.firing = false;
    st.shots++;
    st.popAt = t;
    return st.face;
}

// The little squash the body does as it fires (1 = none).
export function popScale(st, t) {
    const k = (t - st.popAt) / 0.16;
    return k >= 0 && k < 1 ? 1 - 0.07 * Math.sin(k * Math.PI) : 1;
}

// The one rule for drawing a sidekick at all: its owner is being drawn
// right now at full strength (not fading out, not falling out of the sky,
// not faded by smoke, burrow or invisibility), the server hasn't flagged
// the owner hidden, and the raid isn't ending.
export function shown(hiddenFlag, ownerAlpha, ownerFade, falling, raidEnd) {
    return !hiddenFlag && ownerAlpha >= SHOWN_ALPHA && ownerFade >= 1 && !falling && !raidEnd;
}
