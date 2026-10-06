// Sidekick motion: pure maths for the game (sidekicks.js), the menu previews
// and the tests. World units and seconds; no DOM, no allocation per step
// (each sidekick keeps one state object).
//
// A sidekick is a little companion with a mind of its own, not a copy of
// its owner. It never looks where its owner aims: it watches the nearest
// enemy, a gem or chest nearby, glances up at its owner now and then, and
// otherwise looks about with little pauses. On the move it trots along
// behind and to one side; when its owner stops it potters about in a lazy
// loop (each design's `move`, shared/cosmetics.js kick.move, gives the loop
// and the bob its flavour) and every so often wanders off to sniff at
// something, then hurries back. It hops about when its owner banks, scores
// a kill or picks something up (cheer()).
//
// Moving it: the spot it wants is kept relative to its owner as an angle
// and a distance, eased toward its goal (so swapping sides goes round the
// tank, not through it), and the body eases toward that spot in world
// units with frame-rate independent exponential smoothing
// (k = 1 - e^(-rate * dt)) plus the owner's own velocity fed forward, so
// it trails without falling behind and never twitches with network jitter.
// The barrels are a small spring (a hint of overshoot, then settle).
// Everything is seeded by the owner's id, so no two sidekicks are in step.
//
// It grows a little with its owner: ownerScale() is about sqrt(owner size
// / a fresh tank), 1 to 1.8, and the gaps and the leash grow with it.
// Hard rules, checked every step:
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
export const BASE_TANK = 24;    // a fresh tank's size (Basic, level 45)
export const GROW_MAX = 1.8;    // a sidekick grows at most this much with its owner
export const FOLLOW = 7;        // how fast the body closes on its spot (1/s)
export const SPOT = 4.5;        // how fast the spot swings round to where it wants to be (1/s)
export const SPOT_SPEED = 190;  // ...but never faster than this (units a second)
export const HURRY = 1.9;       // coming back from a wander: this much quicker
export const TURN_MAX = 8.5;    // radians a second, the barrels at most
export const SPIN = 1.4;        // radians a second, for the spinners
export const ENEMY_RANGE = 700; // it keeps an eye on an enemy this close to it
export const CHEER = 0.95;      // seconds of excitement
export const SHOT_MIN = 1.5;    // seconds between shots, at least
export const SHOT_SPAN = 1.5;   // ...plus up to this (so 1.5 to 3 s)
export const AIM_LEAD = 0.6;    // the barrels swing to a shot's direction this long before it fires
export const SHOT_LIFE = 0.42;  // a shot pops this fast
export const SHOT_SPEED = 240;  // world units a second
export const SHOWN_ALPHA = 0.9;
// mining (server/game/terrain/sidekickDig.js FIRE_MS / SPEED): a shot a second at
export const DIG_GAP = 1.0;
export const DIG_SPEED = 600;
export const DIG_LIFE_MAX = 0.9;
export function digLife(dist) { return Math.max(0.12, Math.min(DIG_LIFE_MAX, dist / DIG_SPEED)); }
// a barrel at angle a from (x, y) points within ~35 degrees of the rock
export function facesRock(a, x, y, rx, ry) {
    const d = Math.atan2(ry - y, rx - x) - a;
    return Math.cos(d) > 0.82;
}

const TAU = Math.PI * 2;
const VEL = 6;                  // how fast its idea of the owner's velocity settles (1/s)
const MOVE_ON = 30, MOVE_FULL = 110;   // owner speeds (units a second): trotting from, fully
const SIDE = 0.78;              // trailing this far round from straight behind (radians)
const AIM_W = 11, AIM_Z = 0.62; // barrel spring: natural frequency (rad/s) and damping
const AIM_H = 1 / 120;          // its substep, so it behaves the same at any frame rate
const STRIDE = 8.5;             // trotting bob (radians a second)
const GOAL = 6;                 // how fast it changes its mind about where to be (1/s)

function hash(n) {
    let a = (n | 0) ^ 0x9e3779b9;
    a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
    a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
    return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
}
// its own little random streams (mulberry32), seeded by the owner: one
// each for looking about, glancing, wandering and swapping sides, so a
// frame rate that makes two of them fall due together can't swap their
// draws and send it off somewhere else
function rnd(st, k) {
    let a = st[k] = (st[k] + 0x6d2b79f5) | 0;
    a = Math.imul(a ^ (a >>> 15), 1 | a);
    a = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}
const wrap = (a) => ((a % TAU) + TAU * 1.5) % TAU - Math.PI;
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
// Exponential smoothing toward a goal that went from g0 to g1 over the
// frame, as if it slid there evenly: the exact answer for any dt, so a
// moving goal comes out the same at 30 fps as at 144.
function glide(x, g0, g1, rate, dt) {
    if (!(dt > 0)) return x;
    const lag = (g1 - g0) / (rate * dt);
    return g1 - lag + (x - g0 + lag) * Math.exp(-rate * dt);
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// How much a sidekick grows with its owner (owner radius in world units).
export function ownerScale(oR) {
    return clamp(Math.sqrt((oR || BASE_TANK) / BASE_TANK), 1, GROW_MAX);
}

// Each fills o.x, o.y (the spot, relative to the owner), o.hop (lift),
// o.tilt (radians) and o.sq (vertical squash, 1 = none). All smooth in t,
// so the spot never jumps. D: the spot's distance from the owner's centre.
// In a raid these are the idle loop (turned to start wherever it is) and
// the bob; on the menu stage `show` is the whole path.
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
// barrels that turn round on their own (until there's an enemy to watch)
const SPINS = { spin: 1 };
// how each design trots along: weave (radians either side), its speed, and
// how far its bob goes when it's on the move
const GAIT = {
    zip: [0.34, 2.6, 1.6], bounce: [0.16, 1.4, 4], hover: [0.2, 0.9, 1.2],
    sway: [0.28, 1.1, 2.4], guard: [0.1, 0.9, 1.8],
};
const GAIT0 = [0.18, 1.3, 2.4];

// One per sidekick. seed: anything steady for that owner (its entity id),
// so every client starts it at the same place in its loop and two owners'
// sidekicks are never in step. path: a move for the spot alone (the menu
// stage), else `move` does both.
export function makeState(seed, move, path) {
    move = MOVES[move] ? move : 'orbit';
    path = MOVES[path] ? path : move;
    const h = (k) => hash((seed | 0) * 31 + k);
    return {
        move, path, stage: path === 'show', ph: h(0) * TAU, seed: seed | 0,
        rsL: (h(1) * 4294967296) | 0, rsG: (h(5) * 4294967296) | 0, rsE: (h(6) * 4294967296) | 0, rsS: (h(7) * 4294967296) | 0,
        // its own pace: a touch quicker or lazier than the next one
        pace: 0.82 + h(2) * 0.36, stride: STRIDE * (0.85 + h(3) * 0.3), side: h(4) < 0.5 ? -1 : 1,
        x: 0, y: 0, init: false, snaps: 0, ox: 0, oy: 0, alpha: 1, sc: 1,
        hop: 0, tilt: 0, sq: 1, face: 0, w: 0, aim: 0, aimJit: 0, aimAt: -1e9, firing: false, dig: false,
        nextShot: 0, shots: 0, popAt: -1e9, tx: 0, ty: 0,
        vx: 0, vy: 0, hd: 0, mw: 0, hu: 1, idle: true, ga: 0, gd: 0, pgA: 0, pgD: 0, ptx: 0, pty: 0, pa: 0, pd: 0, loopOff: 0, nextSwap: 0,
        ex: 0, exEnd: 0, exA: 0, exD: 0, exThing: false, nextEx: 0,
        look: 0, lookA: 0, lookUntil: 0, lookThing: false, glanceUntil: -1e9, nextGlance: 0,
        cheerAt: -1e9, cheerK: 0, hasEnemy: false, enemyA: 0, want: 0,
    };
}

// Something good just happened to its owner (banked, a kill, a pickup):
// k 0..1, how excited.
export function cheer(st, t, k) {
    const live = t - st.cheerAt < CHEER;
    st.cheerK = live ? Math.max(st.cheerK, k || 1) : (k || 1);
    if (!live) st.cheerAt = t;
}

const O = { x: 0, y: 0, hop: 0, tilt: 0, sq: 1 };
const valid = (v) => typeof v === 'number' && v === v;

// The idle loop's angle and distance at time t, before it's turned to start
// where the sidekick is. Fills O (the bob as well).
function loopAt(st, t, D) {
    O.x = 0; O.y = 0; O.hop = 0; O.tilt = 0; O.sq = 1;
    MOVES[st.path](t * (st.stage ? 1 : st.pace), st.ph, D, O);
}

// Advance one frame. (ox, oy): where the owner is drawn this frame, in
// world units (its interpolated spot, never the raw network one); oR its
// radius; size the design's size multiplier; t seconds (any steady clock),
// dt seconds since the last step. sense (optional): what it can see,
// { ex, ey } the nearest enemy, { gx, gy, gr } a gem or chest and its
// radius, NaN for none.
export function step(st, ox, oy, oR, size, t, dt, sense) {
    dt = clamp(dt || 0, 0, 0.1);
    const sc = st.sc = st.stage ? 1 : ownerScale(oR);
    const r = R * (size || 1) * sc;
    const D = oR + GAP * sc + r;
    const lo = oR + r + CLEAR * sc, hi = oR + LEASH * sc;
    if (st.init && (Math.hypot(ox - st.ox, oy - st.oy) > JUMP || Math.hypot(st.x - ox, st.y - oy) > oR + SNAP)) {
        // the owner went somewhere fast: back on its spot, fading in
        st.snaps++;
        st.init = false;
    }
    const fresh = !st.init;
    const ex = sense ? sense.ex : NaN, ey = sense ? sense.ey : NaN;
    const gx = sense ? sense.gx : NaN, gy = sense ? sense.gy : NaN;
    const thing = valid(gx) && valid(gy);

    // how the owner is moving: from where it is drawn, frame to frame
    if (fresh) { st.vx = 0; st.vy = 0; st.mw = 0; st.idle = true; }
    else if (dt > 0) {
        const k = ease(VEL, dt);
        st.vx += ((ox - st.ox) / dt - st.vx) * k;
        st.vy += ((oy - st.oy) / dt - st.vy) * k;
    }
    const speed = Math.hypot(st.vx, st.vy);
    if (speed > 8) st.hd = Math.atan2(st.vy, st.vx);
    const mwWant = st.stage ? 0 : clamp((speed - MOVE_ON) / (MOVE_FULL - MOVE_ON), 0, 1);
    st.mw += (mwWant - st.mw) * ease(mwWant > st.mw ? 4 : 1.5, dt);
    const mw = st.mw * st.mw * (3 - 2 * st.mw);

    // the idle loop, turned so it carries on from wherever the sidekick is
    const Di = st.stage ? D : D * (1.1 + 0.1 * Math.sin(t * 0.37 * st.pace + st.ph));
    loopAt(st, t, Di);
    const loopA0 = Math.atan2(O.y, O.x), loopD = Math.hypot(O.x, O.y);
    const hop0 = O.hop, tilt0 = O.tilt, sq0 = O.sq;
    if (fresh) {
        st.loopOff = 0;
        st.nextEx = t + 2 + rnd(st, 'rsE') * 4;
        st.nextGlance = t + 1.5 + rnd(st, 'rsG') * 4;
        st.nextSwap = t + 6 + rnd(st, 'rsS') * 8;
        st.ex = 0;
    }
    const nowIdle = st.mw < 0.5;
    if (nowIdle && !st.idle) {
        // just stopped: the loop picks up from here
        st.loopOff = wrap(st.pa - loopA0);
        st.nextEx = t + 1.5 + rnd(st, 'rsE') * 3;
    }
    st.idle = nowIdle;
    let goalA = loopA0 + st.loopOff, goalD = loopD;
    let hurry = 1;

    // wandering off to sniff at something, then hurrying back
    const wander = !st.stage && st.mw < 0.2 && !valid(ex);
    if (!wander && st.ex) { st.ex = 0; st.loopOff = wrap(st.pa - loopA0); st.nextEx = t + 3 + rnd(st, 'rsE') * 4; }
    if (wander) {
        if (!st.ex && t >= st.nextEx) {
            st.ex = 1; st.exEnd = t + 2.4; st.exThing = false;
            const tr = thing ? (sense.gr || 10) : 0;
            const td = thing ? Math.hypot(gx - ox, gy - oy) - tr - r - 4 : 0;
            if (thing && td > lo + 6 && td < hi - 4) {
                // a gem or a chest close by: right up to it
                st.exA = Math.atan2(gy - oy, gx - ox); st.exD = td; st.exThing = true;
            } else {
                // nothing much: a nose about somewhere nearby
                st.exA = st.pa + (rnd(st, 'rsE') - 0.5) * 2.4;
                st.exD = Math.min(hi - 4, D * 1.45 + rnd(st, 'rsE') * Math.max(0, hi - 4 - D * 1.45));
            }
        }
        if (st.ex === 1) {
            if (t >= st.exEnd || (Math.abs(wrap(st.exA - st.pa)) < 0.08 && Math.abs(st.exD - st.pd) < 6)) { st.ex = 2; st.exEnd = t + 0.7 + rnd(st, 'rsE') * 1.1; }
        } else if (st.ex === 2 && t >= st.exEnd) {
            // back to its owner, quick
            st.ex = 3; st.exEnd = t + 1.6;
            st.loopOff = wrap(st.pa - loopA0);
        } else if (st.ex === 3 && (t >= st.exEnd || Math.abs(st.pd - Di) < 10)) {
            st.ex = 0; st.nextEx = t + 4 + rnd(st, 'rsE') * 6;
        }
        if (st.ex === 1 || st.ex === 2) {
            goalA = st.exA + (st.ex === 2 ? Math.sin(t * 5.2 + st.ph) * 0.06 : 0);
            goalD = st.exD;
        }
        if (st.ex === 3) hurry = HURRY;
    }
    // eased in and out, so it sets off and slows down rather than lurching
    st.hu += (hurry - st.hu) * ease(5, dt);
    hurry = st.hu;

    // on the move: behind and to one side, weaving a little
    if (mw > 0) {
        const g = GAIT[st.move] || GAIT0;
        const ra = Math.atan2(st.y - oy, st.x - ox);
        const phi = wrap(ra - st.hd - Math.PI);
        // well round the other side (its owner turned back on it): that's its side now
        if (st.mw > 0.3 && Math.abs(phi) > 1 && Math.sign(phi) !== st.side) st.side = Math.sign(phi);
        if (st.mw > 0.8 && t >= st.nextSwap) { st.side = -st.side; st.nextSwap = t + 7 + rnd(st, 'rsS') * 9; }
        if (st.mw < 0.3) st.nextSwap = Math.max(st.nextSwap, t + 3);
        const trailA = st.hd + Math.PI + st.side * (SIDE + Math.sin(t * g[1] * st.pace + st.ph) * g[0]);
        const trailD = D * (1.04 + 0.05 * Math.sin(t * 1.7 + st.ph));
        goalA += wrap(trailA - goalA) * mw;
        goalD += (trailD - goalD) * mw;
    }
    goalD = clamp(goalD, lo + 2, hi - 2);

    const rate = FOLLOW * hurry * st.pace;
    if (fresh) {
        st.pa = st.ga = st.pgA = goalA; st.pd = st.gd = st.pgD = goalD;
        st.x = st.ptx = ox + Math.cos(goalA) * goalD; st.y = st.pty = oy + Math.sin(goalA) * goalD;
        st.alpha = 0;
        st.face = goalA; st.w = 0;
        st.lookA = goalA; st.lookUntil = t + 0.5;
        st.init = true;
    } else {
        // where it wants to be is eased first (a change of mind, like
        // swapping sides, never yanks it), then the spot swings round its
        // owner toward that (never through it), not too fast
        const rg = GOAL * hurry, ga0 = st.ga, gd0 = st.gd;
        const a0 = wrap(st.pgA - ga0);
        st.ga = wrap(ga0 + glide(0, a0, a0 + wrap(goalA - st.pgA), rg, dt));
        st.gd = glide(gd0, st.pgD, goalD, rg, dt);
        st.pgA = goalA; st.pgD = goalD;
        const rs = SPOT * hurry * st.pace, vmax = SPOT_SPEED * sc * hurry * dt, amax = vmax / Math.max(1, st.pd);
        const b0 = wrap(ga0 - st.pa);
        st.pa = wrap(st.pa + clamp(glide(0, b0, b0 + wrap(st.ga - ga0), rs, dt), -amax, amax));
        st.pd += clamp(glide(st.pd, gd0, st.gd, rs, dt) - st.pd, -vmax, vmax);
        // the body follows it in the world, the owner's velocity fed forward
        // so it keeps up at a run instead of lagging further and further back
        const sx = ox + Math.cos(st.pa) * st.pd + st.vx / rate, sy = oy + Math.sin(st.pa) * st.pd + st.vy / rate;
        st.x = glide(st.x, st.ptx, sx, rate, dt);
        st.y = glide(st.y, st.pty, sy, rate, dt);
        st.ptx = sx; st.pty = sy;
    }
    st.tx = ox + Math.cos(st.pa) * st.pd; st.ty = oy + Math.sin(st.pa) * st.pd;
    keepClear(st, ox, oy, lo, hi, sc, dt);
    st.ox = ox; st.oy = oy;
    st.alpha = Math.min(1, st.alpha + dt / FADE_IN);

    // the bob: its design's, a trot on the move, a happy bounce when cheering
    const g = GAIT[st.move] || GAIT0;
    const trot = Math.sin(t * st.stride + st.ph);
    st.hop = hop0 + mw * Math.abs(trot) * g[2];
    st.tilt = tilt0 + mw * trot * 0.05;
    st.sq = sq0;
    const cu = (t - st.cheerAt) / CHEER;
    const cheering = cu >= 0 && cu < 1;
    if (cheering) {
        const f = (1 - cu) * st.cheerK;
        st.hop += Math.abs(Math.sin(cu * Math.PI * 3)) * 9 * f;
        st.tilt += Math.sin(cu * Math.PI * 7) * 0.2 * f;
    }

    // what it looks at
    st.hasEnemy = valid(ex) && Math.hypot(ex - st.x, ey - st.y) < ENEMY_RANGE * sc;
    if (st.hasEnemy) st.enemyA = Math.atan2(ey - st.y, ex - st.x);
    const toOwner = Math.atan2(oy - st.y, ox - st.x);
    if (st.mw < 0.3 && t >= st.nextGlance) { st.glanceUntil = t + 0.8 + rnd(st, 'rsG') * 0.7; st.nextGlance = t + 5 + rnd(st, 'rsG') * 7; }
    if (t >= st.lookUntil) {
        // a new thing to look at, then a little pause on it
        st.lookThing = thing && rnd(st, 'rsL') < 0.45;
        const base = st.mw > 0.4 ? st.hd : st.face;
        st.lookA = base + (rnd(st, 'rsL') - 0.5) * (st.mw > 0.4 ? 1.5 : 2.8);
        st.lookUntil = t + 0.8 + rnd(st, 'rsL') * 2.2;
    }
    let want, spin = false;
    if (st.firing) { if (st.hasEnemy) st.aim = st.enemyA + st.aimJit; want = st.aim; st.look = 1; }
    else if (st.hasEnemy) { want = st.enemyA; st.look = 2; }
    else if (cheering || t < st.glanceUntil) { want = toOwner; st.look = 3; }
    else if ((st.ex === 1 || st.ex === 2) && st.exThing && thing) { want = Math.atan2(gy - st.y, gx - st.x); st.look = 4; }
    else if (SPINS[st.move]) { want = st.face; spin = true; st.look = 6; }
    else if (st.lookThing && thing) { want = Math.atan2(gy - st.y, gx - st.x); st.look = 4; }
    else { want = st.lookA; st.look = 5; }
    st.want = want;
    if (fresh) st.face = want;
    aimStep(st, want, dt, spin);
    return st;
}

// The barrels: a small spring toward `want` (a touch of overshoot, then
// settle), never faster than TURN_MAX; `spin` winds them round at SPIN
// instead. Substepped, so 30, 60 and 144 fps turn the same.
const AIM_K = AIM_W * AIM_W, AIM_C = 2 * AIM_Z * AIM_W;
export function aimStep(st, want, dt, spin) {
    let left = clamp(dt || 0, 0, 0.1);
    while (left > 1e-9) {
        const h = left < AIM_H ? left : AIM_H;
        left -= h;
        if (spin) st.w += (SPIN - st.w) * ease(4, h);
        else st.w += (AIM_K * wrap(want - st.face) - AIM_C * st.w) * h;
        st.w = clamp(st.w, -TURN_MAX, TURN_MAX);
        st.face += st.w * h;
    }
    if (st.face > 1e4 || st.face < -1e4) st.face %= TAU;
}

// Outside the owner's body (plus CLEAR), inside the leash. Inside the SOFT
// band it is eased outward first, so an owner driving at it nudges it along
// instead of shoving it, and near the end of the leash it is eased back in;
// the hard limits under that are a slide along the circle, never a jump
// (the correction is only as big as the overlap).
const PUSH = 16, PULL = 10;
function keepClear(st, ox, oy, lo, hi, sc, dt) {
    let dx = st.x - ox, dy = st.y - oy;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) {
        // dead centre: out toward its spot
        dx = st.tx - ox; dy = st.ty - oy; d = Math.hypot(dx, dy);
        if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
    }
    const soft = SOFT * sc, out = hi - soft;
    let nd = d;
    if (d < lo + soft) nd = Math.max(lo, d + (lo + soft - d) * ease(PUSH, dt));
    else if (d > out) nd = Math.min(hi, d - (d - out) * ease(PULL, dt));
    if (nd !== d) { st.x = ox + dx / d * nd; st.y = oy + dy / d * nd; }
}

// Time for a shot? A steady, easy rhythm: every SHOT_MIN..SHOT_MIN+SHOT_SPAN
// seconds, at the enemy it's watching if there is one, else anywhere.
// AIM_LEAD before it goes the barrels start swinging there (step() turns
// them); when it goes this returns the angle the barrels point now (so it
// leaves a muzzle), else NaN. A spinner with nothing to watch just fires
// wherever it has got to. rnd: a 0..1 random source.
export function shotDue(st, t, random) {
    if (!st.nextShot) st.nextShot = t + SHOT_MIN * 0.5 + random() * SHOT_SPAN;
    // mining: no waiting out a long idle gap
    if (st.dig && st.nextShot - t > DIG_GAP) st.nextShot = t + AIM_LEAD;
    if (!(SPINS[st.move] && !st.hasEnemy) && !st.firing && t >= st.nextShot - AIM_LEAD) {
        st.firing = true;
        st.aimJit = st.hasEnemy ? (random() - 0.5) * (st.dig ? 0.04 : 0.14) : 0;
        st.aim = st.hasEnemy ? st.enemyA + st.aimJit : random() * TAU - Math.PI;
        st.aimAt = t;
    }
    if (t < st.nextShot) return NaN;
    st.nextShot = t + (st.dig ? DIG_GAP : SHOT_MIN + random() * SHOT_SPAN);
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
