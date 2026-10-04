// Hit feedback timing: the flash curve, the body punch, the sparks off the
// hit side and the little camera nudge on a big hit you land. app.js draws
// the flash and punch from the numbers here; socketinit.js tells us how hard
// a hit was (the DMG packet) and where it came from.
//
// No imports on purpose, so node tests can load it. socketinit.js hands
// over config, global and juice through init().
//
// Timeline of one hit (ms after the server's hitAt stamp):
//   0-24     hot: the body goes near white (or hot red on your own tank)
//   24-74    the hot colour melts into the usual red tint
//   to 220   the red fades out, squared falloff
//   0-130    the body punches up to 1.1x and springs back with a tiny undershoot
//   0-110    on a big hit you landed, the camera leans 1-2 px toward the target

export const FLASH_MS = 220;
export const FLASH_STRENGTH = 0.72;
export const HOT_MS = 24;          // two frames at 60 fps (0 and 16 ms)
export const HOT_FADE_MS = 50;
export const HOT_COLOR = "#FFFFFF";
export const PUNCH_MS = 130;
export const NUDGE_MS = 110;
export const NUDGE_MIN = 18;       // % of max health, the Critical line
const DEFAULT_POW = 0.3;           // a hit we didn't get a number for (someone else's fight)
const POW_MATCH_MS = 220;          // a DMG this close to the flash stamp belongs to it

let C = null, G = null, J = null;
export function init(deps) { C = deps.config; G = deps.global; J = deps.juice; }

// ---- settings -----------------------------------------------------------
const on = () => !C || C.game.hitFlash !== false;
const calm = () => !!(G && G.reducedMotion && G.reducedMotion());
// fewer effects, the Low effects level, or the auto low-end trim
const lite = () => !!(C && (C.graphical.fewerEffects || C.graphical.fxLevel === 0)) || !!(G && G.lowFx);
const lightSafe = () => !!(C && C.graphical.lightSafe);

// ---- pure curves (tested in scripts/test/raidHeat.test.js) --------------
// how hard a hit was, 0-1, from the DMG amount (% of the target's max health)
export function powFor(amount) {
    if (!(amount > 0)) return DEFAULT_POW;
    return Math.max(0.12, Math.min(1, amount / 25));
}
// the punch size: chip hits barely move, a fat hit is about 1.1x
export function punchAmp(pow, mine) {
    return 0.016 + 0.07 * pow + (mine ? 0.014 * pow : 0);
}
// 1 at the hit, springing back through a small undershoot to 0
export function punchShape(age) {
    if (!(age >= 0) || age >= PUNCH_MS) return 0;
    const k = age / PUNCH_MS, f = 1 - k;
    return f * f * Math.cos(k * Math.PI * 1.1);
}
// flash: how much of the tint to mix in (blend) and how much of that tint is
// still the hot colour (hot). Written into out so the draw loop allocates nothing.
export function flashAt(age, peak, out) {
    out.blend = 0; out.hot = 0;
    if (!(age >= 0) || age >= FLASH_MS) return out;
    const ht = age / FLASH_MS;
    const base = (1 - ht) * (1 - ht) * FLASH_STRENGTH;
    const hot = age < HOT_MS ? 1 : Math.max(0, 1 - (age - HOT_MS) / HOT_FADE_MS);
    out.hot = hot;
    out.blend = Math.max(base, hot * peak);
    return out;
}
export function nudgeShape(age) {
    if (!(age >= 0) || age >= NUDGE_MS) return 0;
    const k = age / NUDGE_MS;
    return (1 - k) * (1 - k);
}

// ---- per body -----------------------------------------------------------
// what app.js reads for one body this frame
const look = { blend: 0, hot: 0, tintHot: false, scale: 1 };
export function bodyLook(render, own, now) {
    look.blend = 0; look.hot = 0; look.tintHot = false; look.scale = 1;
    if (!on() || !render.hitAt) return look;
    const age = now - render.hitAt;
    if (age >= FLASH_MS || age < 0) return look;
    const known = render.hitPowAt && Math.abs(render.hitPowAt - render.hitAt) < POW_MATCH_MS;
    const pow = known ? render.hitPow : DEFAULT_POW;
    const mine = known && render.hitMine && !own;
    // your own tank flashes hot red, never white: getting hit shouldn't feel like a reward
    const peak = own ? 0.82 : mine ? 0.95 : 0.85;
    flashAt(age, lightSafe() ? 0 : peak, look);
    look.tintHot = !own && !lightSafe();
    if (!calm() && age < PUNCH_MS) {
        let amp = punchAmp(pow, mine);
        if (own) amp *= 0.5;
        if (lite()) amp *= 0.5;
        look.scale = 1 + amp * punchShape(age);
    }
    return look;
}

// ---- events from socketinit.js -----------------------------------------
const SPARK_RED = "#ff4a4a", SPARK_WHITE = "#fff6ea";
let nudgeAt = -1e9, nudgeX = 0, nudgeY = 0;
// A DMG line: we dealt it (taken false) or took it. me is our own body (or null).
export function onDamage(target, amount, taken, me, now) {
    const r = target && target.render;
    if (!r || !on()) return;
    const pow = powFor(amount);
    // a combo inside one flash keeps the biggest hit
    r.hitPow = r.hitPowAt && now - r.hitPowAt < POW_MATCH_MS ? Math.max(r.hitPow, pow) : pow;
    r.hitPowAt = now;
    r.hitMine = !taken;
    if (taken || !me || !J || lite()) return;
    // sparks fly back off the face you hit
    const dx = me.x - target.x, dy = me.y - target.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, ang = Math.atan2(uy, ux);
    const rim = (target.size || 20) * 0.95;
    const hx = target.x + ux * rim, hy = target.y + uy * rim;
    // one red and one white (two each on Max), a hard hit throws one more
    // red. Spread 0 with our own random lean, because juice puts a cone of
    // one spark off to one edge and it always looked lopsided.
    J.sparks(hx, hy, 1, 55 + 50 * pow, 200, 0, SPARK_RED, 0, ang + (Math.random() - 0.5) * 1.3, 2.6);
    J.sparks(hx, hy, 1, 70 + 60 * pow, 170, 0, SPARK_WHITE, 0, ang + (Math.random() - 0.5) * 0.9, 2.2);
    if (pow > 0.6) J.sparks(hx, hy, 1, 60 + 50 * pow, 190, 0, SPARK_RED, 0, ang + (Math.random() - 0.5) * 1.6, 2.4);
    if (amount >= NUDGE_MIN && !calm() && !(C && C.graphical.noShake)) {
        // lean toward what you hit, 1 px on a Critical, 2 px on a huge one
        const px = 1 + Math.min(1, (amount - NUDGE_MIN) / 30);
        nudgeAt = now; nudgeX = -ux * px; nudgeY = -uy * px;
    }
}
// screen px to add to the camera this frame
const nudge = { x: 0, y: 0 };
export function camNudge(now) {
    const s = nudgeShape(now - nudgeAt);
    nudge.x = nudgeX * s; nudge.y = nudgeY * s;
    return nudge;
}
