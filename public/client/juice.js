// Screen juice: camera kicks, hit-stop, slow-mo, glitch frames, slam text,
// flashes, light leaks, rings and a pooled spark field. raidHeat.js and
// skyDrop.js decide when; this file only knows how. Other modules (the
// ability effects) can use the same pieces:
//
//   shake(power, ms)             camera kick, capped; "No Screen Shake" turns it off
//   rumble(ms, power)            a low shake that keeps going for ms
//   hitStop(ms)                  hold the frame a beat (never while you're dead)
//   slowMo(ms, speed)            effects run slow for ms (the world doesn't)
//   glitch(power, ms, big)       a burst of shifted, tinted strips of the world
//                                (Normal: only big moments, short and soft)
//   flash(color, ms, alpha)      a full-screen colour flash
//   lightLeak(rgb, ms)           warm light blooming in from two corners
//   ring(x, y, col, r0, r1, ms, width)            world-space shock ring
//   burst(x, y, n, col, dist, ms, kind, size)     world-space sparks (kind:
//                                0 streak, 1 chunk, 2 shard, 3 glint, 4 confetti)
//   slam(text, sub, col, ms, size)                the big centre word
//
// How much gets drawn: the Effects setting (Low / Normal / Max) times a
// quality that follows the frame time, so a struggling machine sheds sparks
// and glitches on its own. Fewer Effects, low resolution (picked or
// automatic), software rendering and reduced motion skip the heavy pieces.
// Nothing here allocates per frame: slices, sparks, rings, flashes and slams
// are pooled.
import { global } from "./global.js";
import { config } from "./config.js";
import * as JM from "./juiceMath.js";

let A = null;
// app.js: hudTitle, hudTitleW, drawText, haloSprite, vignetteSprite
export function init(helpers) { A = helpers; }

const calm = () => !!(global.reducedMotion && global.reducedMotion());
const lite = () => !!config.graphical.fewerEffects;
const lowRes = () => !!(global.autoLowRes || global.userLowRes);
const softGpu = () => { const tr = window.terrainRenderer; return !!(tr && tr._rockQuality != null && tr._rockQuality < 1); };
// Light Sensitive (Graphics): no glitches, colour split, white-outs or
// strobing, flashes capped dim, shake kept gentle
export const lightSafe = () => !!config.graphical.lightSafe;
export const level = () => { const v = config.graphical.fxLevel; return v === 0 || v === 2 ? v : 1; };
// The automatic low-end trim (autoQuality.js) keeps the glitches, just
// rarer (see glitch() and postWorld); only the player's own Low or Fewer
// Effects turns them off.
const autoTrim = () => !!(global.autoQ && global.autoQ.active);
const userOff = () => (lite() && !global.autoQ?.fewerFx) || (level() === 0 && !global.autoQ?.fxLow);
export const glitchOn = () => !config.graphical.noGlitch && !calm() && !lightSafe() && !userOff() &&
    (autoTrim() ? Q > 0.25 : !lite() && !global.lowFx && !lowRes() && !softGpu() && level() > 0 && Q > 0.4);
const LOW_GLITCH_GAP = 1500;   // trimmed: one burst per this many ms at most
let lastBurstAt = -1e9;
// Effects: Max is the full look. Normal keeps fights readable: softer shake,
// fewer and smaller sparks, a glitch only on a big moment (a boss, the Core,
// a hard hit at low health), no ambient flicker, static or light leaks.
export const full = () => level() === 2;
const BIG_GAP = 4000;
let lastBigAt = -1e9;
export const shakeOn = () => !config.graphical.noShake;
export const glowOn = () => !config.graphical.noGlow && !global.lowFx;
// the expensive extras: light leaks, chromatic edges, dust motes
export const heavyOn = () => !lite() && !global.lowFx && !lowRes() && !softGpu() && level() > 0 && Q >= 0.5;
// particle multiplier right now
export function scale() { return JM.fxScale(level(), Q) * (lite() ? 0.35 : 1); }

// ── the clock ──────────────────────────────────────────────────────────
// Effects keep their own clock so slow-mo can stretch them. frameStart
// runs once a frame (raidHeat.drawFloor, the first world pass).
let Q = 1, lastFrameAt = 0, clockNow = 0, clockReal = 0;
let slowUntil = 0, slowSpeed = 1;
let rumbleUntil = 0, rumblePow = 0;
export function frameStart(now) {
    // not on the sky drop's dive: its wide frames would thin the landing's effects
    if (lastFrameAt && (global.dropZoom === undefined || global.dropZoom === 1)) Q = JM.nextQuality(Q, now - lastFrameAt);
    lastFrameAt = now;
    const dt = clockReal ? Math.min(100, now - clockReal) : 0;
    clockReal = now;
    clockNow += now < slowUntil ? dt * slowSpeed : dt;
    if (now < rumbleUntil) shake(rumblePow * (0.6 + 0.4 * Math.random()), 120);
}
export function clock() { return clockNow; }
export function quality() { return Q; }
export function slowMo(ms, speed = 0.35) {
    if (calm()) return;
    slowUntil = Math.max(slowUntil, performance.now() + ms);
    slowSpeed = speed;
}

// ── camera ─────────────────────────────────────────────────────────────
// max: a few big moments (the sky drop landing) may go past the usual cap
export function shake(power, ms = 300, max = JM.SHAKE_MAX) {
    if (!shakeOn()) return;
    let amt = JM.shakeFor(power) * (max / JM.SHAKE_MAX) * (calm() ? 0.25 : 1) * (full() ? 1 : 0.6);
    if (lightSafe()) amt = Math.min(6, amt * 0.3);
    if (!(amt > 0.5)) return;
    const set = config.graphical.shakeProperties.CameraShake;
    const now = Date.now();
    if (set.shakeStartTime !== -1 && now - set.shakeStartTime < set.shakeDuration) {
        set.shakeAmount = Math.min(Math.max(JM.SHAKE_MAX, max), Math.max(set.shakeAmount, amt));
        set.shakeDuration = Math.max(set.shakeDuration, ms);
        return;
    }
    set.shakeStartTime = now;
    set.shakeDuration = ms;
    set.shakeAmount = amt;
    set.keepShake = false;
}
export function rumble(ms, power = 6) {
    if (!shakeOn() || calm()) return;
    rumbleUntil = Math.max(rumbleUntil, performance.now() + ms);
    rumblePow = Math.max(rumblePow * (performance.now() < rumbleUntil ? 1 : 0), power);
}
export function hitStop(ms = 40, max = 60) {
    if (!shakeOn() || calm() || lightSafe() || global.died) return;
    global.hitStop = Math.max(global.hitStop || 0, Date.now() + Math.min(max, ms));
}

// ── glitch ─────────────────────────────────────────────────────────────
const slices = JM.makeSlices(9);
let burstPow = 0, burstFrom = 0, burstUntil = 0;
let ambientK = 0, ambientNext = 0, ambientUntil = 0;
let seed = 1;
export function glitch(power, ms = 220, big = false) {
    if (!glitchOn()) return;
    const now = performance.now();
    if (!full()) {
        if (!big || now - lastBigAt < BIG_GAP) return;
        lastBigAt = now;
        power *= 0.6;
        ms *= 0.5;
    }
    if (now < burstUntil && burstPow > power) { burstUntil = Math.max(burstUntil, now + ms * 0.5); return; }
    if (autoTrim() && now - lastBurstAt < LOW_GLITCH_GAP) return;
    lastBurstAt = now;
    burstPow = Math.min(1, power);
    burstFrom = now;
    burstUntil = now + ms;
}
// call every frame with this frame's level (0..1); a short flicker fires at
// random, more often the higher it is
export function ambient(k) { ambientK = Math.max(ambientK, Math.min(1, k || 0)); }

const TINTS = ["rgba(255,40,96,0.2)", "rgba(40,240,255,0.18)", "rgba(255,255,255,0.1)"];
let staticK = 0;
export function staticNoise(k) { staticK = Math.max(staticK, Math.min(1, k || 0)); }

// After the world is drawn (before the HUD): shift strips of the world
// layers sideways onto the top canvas and tint them. ctxs = app.js ctx[].
export function postWorld(ctxs) {
    const now = performance.now();
    const amb = ambientK; ambientK = 0;
    const stat = staticK; staticK = 0;
    if (!glitchOn()) return;
    let pow = 0;
    if (now < burstUntil) {
        const k = 1 - (now - burstFrom) / Math.max(1, burstUntil - burstFrom);
        pow = burstPow * (0.35 + 0.65 * k);
    }
    if (amb > 0.02 && Q >= 0.5 && full()) {
        if (now > ambientNext) {
            ambientUntil = now + 60 + Math.random() * 90;
            ambientNext = now + (420 + Math.random() * (2600 * (1 - amb) + 500)) / (level() === 2 ? 1.6 : 1) * (autoTrim() ? 3 : 1);
        }
        if (now < ambientUntil) pow = Math.max(pow, 0.25 + 0.5 * amb);
    }
    const top = ctxs[2];
    const cv = top.canvas, W = cv.width, H = cv.height;
    if (!(W > 0 && H > 0)) return;
    if (stat > 0.02 && full()) drawStatic(top, W, H, stat, now);
    if (pow < 0.03) return;
    seed = (seed + 1) | 0;
    const n = JM.planGlitch(seed * 7919 + ((now / 50) | 0), pow, W, H, slices);
    if (!n) return;
    const c0 = ctxs[0].canvas, c1 = ctxs[1].canvas;
    top.save();
    top.setTransform(1, 0, 0, 1, 0, 0);
    top.globalAlpha = 1;
    for (let i = 0; i < n; i++) {
        const s = slices[i];
        const sw = Math.min(s.w, c0.width - s.x), sh = Math.min(s.h, c0.height - s.y);
        if (sh > 0 && sw > 0) {
            // the torn block, moved sideways, then a colour cast on it
            top.globalCompositeOperation = "source-over";
            top.drawImage(c0, s.x, s.y, sw, sh, s.x + s.dx, s.y, sw, sh);
            if (c1.width >= s.x + sw) top.drawImage(c1, s.x, s.y, sw, sh, s.x + s.dx, s.y, sw, sh);
            top.globalCompositeOperation = "lighter";
            top.fillStyle = TINTS[s.tint];
            top.fillRect(s.x + s.dx, s.y, sw, sh);
        }
    }
    // chromatic fringe on the tanks: the entity layer twice more, nudged
    // left and right, added on top
    if (pow > 0.35 && c1.width > 0) {
        const off = Math.max(2, Math.round(pow * 5 * W / 1920));
        top.globalCompositeOperation = "lighter";
        top.globalAlpha = 0.16 * pow;
        top.drawImage(c1, off, 0);
        top.drawImage(c1, -off, 0);
    }
    top.restore();
}

function drawStatic(c, W, H, k, now) {
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    const n = Math.round((6 + 18 * k) * Math.min(1, scale()));
    const t = (now / 40) | 0;
    for (let i = 0; i < n; i++) {
        const y = JM.hash01(t, i) * H;
        const w = (0.15 + 0.85 * JM.hash01(t + 3, i)) * W;
        const x = JM.hash01(t + 7, i) * (W - w);
        c.globalAlpha = (0.04 + 0.12 * k) * JM.hash01(t + 11, i);
        c.fillStyle = i % 3 === 0 ? "#9ff6ff" : i % 3 === 1 ? "#ff9ad0" : "#ffffff";
        c.fillRect(x, y, w, 1 + (JM.hash01(t + 13, i) * 2.5 * k | 0));
    }
    c.restore();
}

// ── slam text ──────────────────────────────────────────────────────────
// One big word at a time in the middle of the screen, never two on top of
// each other: a new one waits its turn (the one up gets cut short so the
// queue keeps moving), and one of the same kind (the first word: ELIMINATED,
// BANKED, YOU'RE...) replaces the one up or waiting, so a kill combo counts up
// in place. A roll counts its number up (BANKED +1,240).
const SLAM_WAIT = 3;            // at most this many waiting; the oldest goes
const SLAM_MIN_MS = 900;        // a slam is up at least this long before a newer one cuts it
const SLAM_CUT_MS = 380;        // ...and fades over this
const slamPool = [];
for (let i = 0; i < SLAM_WAIT + 2; i++) slamPool.push({ on: false, key: "", text: "", sub: "", col: "#fff", born: 0, dur: 0, size: 54, roll: false, from: 0, to: 0, pre: "", shown: -1 });
let slamCur = null;
const slamQ = [];
// skyDrop.landAt: while you fall in, a slam waits for the landing
let holdUntil = () => 0;
export function setSlamHold(fn) { holdUntil = fn || (() => 0); }
const slamKey = (text) => { const t = String(text || ""); const i = t.indexOf(" "); return i > 0 ? t.slice(0, i) : t; };
function slamFree() {
    for (const s of slamPool) if (!s.on) return s;
    // all busy: reuse the oldest waiting one
    const s = slamQ.shift();
    s.on = false;
    return s;
}
export function slam(text, sub, col, dur = 1800, size = 58) {
    const now = performance.now();
    const key = slamKey(text);
    let s = null;
    if (slamCur && slamCur.on && slamCur.key === key && now - slamCur.born < slamCur.dur) s = slamCur;
    else s = slamQ.find(q => q.key === key) || null;
    const fresh = !s;
    if (!s) s = slamFree();
    s.on = true; s.key = key; s.text = text; s.sub = sub || ""; s.col = col || "#ffffff";
    s.dur = dur; s.size = size; s.roll = false;
    if (s === slamCur) s.born = now;
    else {
        s.born = 0;
        if (fresh) { slamQ.push(s); while (slamQ.length > SLAM_WAIT) slamQ.shift().on = false; }
    }
    if (!slamCur || !slamCur.on) nextSlam(now);
    return s;
}
function nextSlam(now) {
    slamCur = slamQ.shift() || null;
    if (slamCur) slamCur.born = Math.max(now, holdUntil());
}
export function slamRoll(pre, from, to, sub, col, dur, size, fmt) {
    const s = slam(pre + fmt(from), sub, col, dur, size);
    s.roll = true; s.from = from; s.to = to; s.pre = pre; s.fmt = fmt; s.shown = from;
    return s;
}
export function slamUp() {
    const now = performance.now();
    return !!(slamCur && slamCur.on && now - slamCur.born < slamCur.dur) || slamQ.length > 0;
}
// screen space, gui layer. cx/cy: where the word sits, k: its scale (a
// short screen shrinks it to fit its lane)
export function drawSlams(c, cx, cy, k = 1) {
    if (!A) return;
    const now = performance.now();
    // falling in: whatever is up waits for the landing
    const hold = holdUntil();
    let s = slamCur;
    // (only a word that hasn't started yet waits; one already up plays out,
    // or it would hang over the death card until the next landing)
    if (s && s.on && hold > now && s.born < hold && s.born > now - 50) s.born = hold;
    if (s && s.on && slamQ.length) {
        // something is waiting: this one wraps up soon
        const age = now - s.born;
        if (age >= 0) s.dur = Math.min(s.dur, Math.max(age + SLAM_CUT_MS, SLAM_MIN_MS));
    }
    if (s && s.on && now - s.born > s.dur) { s.on = false; nextSlam(now); s = slamCur; }
    if (!s || !s.on) return;
    const age = now - s.born;
    if (age < 0) return;
    if (s.roll) {
        const v = JM.rollValue(s.from, s.to, age / 700);
        if (v !== s.shown) { s.shown = v; s.text = s.pre + s.fmt(v); }
    }
    const inT = Math.min(1, age / 140);
    const outT = age > s.dur - SLAM_CUT_MS ? Math.max(0, 1 - (age - (s.dur - SLAM_CUT_MS)) / SLAM_CUT_MS) : 1;
    // a hard punch in: big, then settles
    const pop = calm() ? 1 : inT < 1 ? 1.6 - 0.6 * (inT * inT * (3 - 2 * inT)) : 1 + 0.03 * Math.sin(age / 90) * (age < 600 ? 1 : 0);
    const a = inT * outT;
    const size = s.size * pop * k;
    const jitter = !calm() && full() && glitchOn() && age < 260 ? (JM.hash01(age | 0, 5) - 0.5) * 14 : 0;
    if (jitter) {
        // the RGB-split ghosts behind the word for the first beat
        A.hudTitle(s.text, cx - 4 + jitter, cy, size, "#ff2d6f", "center", a * 0.55, c);
        A.hudTitle(s.text, cx + 4 - jitter, cy, size, "#2df0ff", "center", a * 0.55, c);
    }
    A.hudTitle(s.text, cx + jitter * 0.3, cy, size, s.col, "center", a, c);
    if (s.sub) A.drawText(s.sub, cx, cy + (s.size * 0.62 + 14) * k, 15 * Math.max(0.8, k), "#f2eef8", "center", true, a, 5);
}
// how far below its centre line a slam reaches (its sub line included)
export const SLAM_DROP = 78;
// QA: what's up and what's waiting
export function slamState() { return { up: slamCur && slamCur.on ? slamCur.text : "", wait: slamQ.map(q => q.text) }; }

// ── sparks ─────────────────────────────────────────────────────────────
// kind 0 spark streak, 1 chunk, 2 crystal shard, 3 gem glint, 4 confetti
const pool = JM.makePool(240);
const SPARK_COL = ["#ffe9b0", "#2b2433", "#8ff2ff", "#ffd76e", "#ffffff"];
const CONFETTI = ["#f2b83c", "#3fcf7a", "#5ce8ff", "#ff5ad8", "#ff8a3a", "#fff3d9"];
export function sparks(x, y, n, speed, life, kind, col, spread = Math.PI * 2, ang0 = 0, size = 4) {
    n = JM.countFor(n, scale());
    if (!full()) { size *= 0.85; life *= 0.8; speed *= 0.85; }
    const now = clockNow;
    for (let i = 0; i < n; i++) {
        const a = ang0 + (spread >= Math.PI * 2 ? (i / n) * spread : (i / Math.max(1, n - 1) - 0.5) * spread) + (Math.random() - 0.5) * 0.5;
        const p = JM.emit(pool, x, y, a, speed * (0.45 + Math.random() * 0.75), life * (0.7 + Math.random() * 0.5), kind, now, size * (0.6 + Math.random() * 0.8));
        p.col = kind === 4 ? CONFETTI[i % CONFETTI.length] : (col || SPARK_COL[kind] || "#ffffff");
    }
}
// the hook name other modules use
export function burst(x, y, n, col, dist = 200, ms = 700, kind = 0, size = 4) { sparks(x, y, n, dist, ms, kind, col, Math.PI * 2, 0, size); }

// ── rings ──────────────────────────────────────────────────────────────
const rings = [];
for (let i = 0; i < 12; i++) rings.push({ born: -1e9, x: 0, y: 0, col: "#fff", r0: 20, r1: 200, dur: 500, w: 6 });
let ringI = 0;
export function ring(x, y, col, r0, r1, dur = 500, w = 6) {
    const o = rings[ringI]; ringI = (ringI + 1) % rings.length;
    o.born = clockNow; o.x = x; o.y = y; o.col = col; o.r0 = r0; o.r1 = r1; o.dur = dur; o.w = w;
}

// world layer: px, py, ratio as app.js drawGameplay has them
export function drawSparks(c, px, py, ratio) {
    const now = clockNow;
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    let any = false;
    for (const o of rings) {
        const age = now - o.born;
        if (age < 0 || age > o.dur) continue;
        if (!any) { c.save(); c.lineCap = "round"; any = true; }
        const k = age / o.dur, e = 1 - (1 - k) * (1 - k) * (1 - k);
        c.globalAlpha = (1 - k) * 0.85;
        c.strokeStyle = o.col; c.lineWidth = Math.max(1.5, o.w * (1 - k) * ratio);
        c.beginPath(); c.arc(ratio * o.x - px + cx, ratio * o.y - py + cy, (o.r0 + (o.r1 - o.r0) * e) * ratio, 0, Math.PI * 2); c.stroke();
    }
    for (const p of pool.items) {
        const age = now - p.born;
        if (age < 0 || age > p.life) continue;
        if (!any) { c.save(); c.lineCap = "round"; any = true; }
        const k = age / p.life, e = 1 - (1 - k) * (1 - k);
        // speed is how far it flies (world units), slowing down; confetti falls
        const wx = p.x + p.vx * e + (p.kind === 4 ? Math.sin(age / 90 + p.spin * 6) * 10 : 0);
        const wy = p.y + p.vy * e + (p.kind === 4 ? 160 * k * k : 0);
        const sx = ratio * wx - px + cx, sy = ratio * wy - py + cy;
        if (sx < -60 || sy < -60 || sx > global.screenWidth + 60 || sy > global.screenHeight + 60) continue;
        c.globalAlpha = p.kind === 4 ? Math.min(1, (1 - k) * 2) : 1 - k;
        if (p.kind === 0 || p.kind === 3) {
            const tl = (p.kind === 3 ? 4 : 9) * ratio * (1 - k);
            const m = Math.hypot(p.vx, p.vy) || 1;
            c.strokeStyle = p.col;
            c.lineWidth = Math.max(1, p.size * 0.5 * ratio * (1 - k));
            c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx - p.vx / m * tl, sy - p.vy / m * tl); c.stroke();
        } else {
            const s = p.size * ratio * (1 - k * 0.5);
            c.fillStyle = p.col;
            c.save();
            c.translate(sx, sy);
            c.rotate(p.spin * age / 120);
            if (p.kind === 2) { c.beginPath(); c.moveTo(0, -s * 1.6); c.lineTo(s * 0.6, 0); c.lineTo(0, s * 1.6); c.lineTo(-s * 0.6, 0); c.closePath(); c.fill(); }
            else if (p.kind === 4) c.fillRect(-s, -s * 0.45 * Math.abs(Math.cos(age / 70 + p.spin * 3)) - 0.5, s * 2, s * 0.9 * Math.abs(Math.cos(age / 70 + p.spin * 3)) + 1);
            else c.fillRect(-s, -s * 0.7, s * 2, s * 1.4);
            c.restore();
        }
    }
    if (any) c.restore();
}
export function _pool() { return pool; }

// ── screen: flashes, light leaks, the ambient layer ─────────────────────
const flashes = [];
for (let i = 0; i < 3; i++) flashes.push({ born: -1e9, dur: 0, col: "#fff", a: 0.5 });
let flashI = 0;
export function flash(col = "#ffffff", ms = 160, alpha = 0.5) {
    if (calm()) alpha *= 0.4;
    if (!full()) alpha *= 0.6;
    // light sensitive: a dim, slow wash instead of a flash
    if (lightSafe()) { alpha = Math.min(0.08, alpha * 0.2); ms = Math.max(ms, 400); }
    const f = flashes[flashI]; flashI = (flashI + 1) % flashes.length;
    f.born = performance.now(); f.dur = ms; f.col = col; f.a = alpha;
}
let leakAt = -1e9, leakMs = 0, leakRgb = "255,190,120";
export function lightLeak(rgb = "255,190,120", ms = 1200) {
    leakAt = performance.now(); leakMs = ms; leakRgb = rgb;
}
// dust motes: screen space, drifting, with a little parallax off the camera
const MOTES = 28;
const motes = [];
for (let i = 0; i < MOTES; i++) motes.push({ x: JM.hash01(i, 1), y: JM.hash01(i, 2), z: 0.3 + 0.7 * JM.hash01(i, 3), r: 0.8 + 1.8 * JM.hash01(i, 4), ph: JM.hash01(i, 5) * 6.28 });
export function drawScreenFx(c) {
    const now = performance.now();
    const w = global.screenWidth, h = global.screenHeight;
    if (A && heavyOn() && !global.died) {
        // a soft dark edge so the middle of the screen pops
        if (glowOn() && A.vignetteSprite) {
            c.save();
            c.globalAlpha = full() ? 0.16 : 0.09;
            c.drawImage(A.vignetteSprite(w, h, 0.7, "6,4,10"), 0, 0, w, h);
            c.restore();
        }
        if (!calm() && full()) {
            const camX = global.player ? global.player.renderx || 0 : 0, camY = global.player ? global.player.rendery || 0 : 0;
            c.save();
            c.fillStyle = "#fff3d9";
            for (let i = 0; i < MOTES; i++) {
                const m = motes[i];
                let x = (m.x * w - camX * 0.12 * m.z + now * 0.006 * m.z) % w;
                let y = (m.y * h - camY * 0.12 * m.z + Math.sin(now / 2400 + m.ph) * 18) % h;
                if (x < 0) x += w;
                if (y < 0) y += h;
                c.globalAlpha = 0.05 + 0.1 * m.z * (0.6 + 0.4 * Math.sin(now / 900 + m.ph));
                c.beginPath(); c.arc(x, y, m.r * m.z * 1.4, 0, Math.PI * 2); c.fill();
            }
            c.restore();
        }
    }
    const la = now - leakAt;
    if (la < leakMs && A && A.haloSprite && heavyOn() && glowOn() && !lightSafe() && full()) {
        const k = la / leakMs, a = (k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8) * 0.55;
        const R = Math.max(w, h) * 0.75;
        const spr = A.haloSprite("leak|" + leakRgb, leakRgb, [[0, 0.9], [0.4, 0.35], [1, 0]]);
        c.save();
        c.globalCompositeOperation = "lighter";
        c.globalAlpha = a;
        c.drawImage(spr, -R * 0.55, -R * 0.55, R * 1.1, R * 1.1);
        c.drawImage(spr, w - R * 0.45, h - R * 0.5, R * 0.9, R * 0.9);
        c.restore();
    }
    for (const f of flashes) {
        const age = now - f.born;
        if (age < 0 || age > f.dur) continue;
        c.save();
        c.globalAlpha = f.a * (1 - age / f.dur);
        c.fillStyle = f.col;
        c.fillRect(0, 0, w, h);
        c.restore();
    }
}

// for other modules that don't import this file
window.dwJuice = { shake, rumble, hitStop, slowMo, glitch, flash, lightLeak, ring, burst, slam, scale, quality };
