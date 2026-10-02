// The sky drop: every spawn falls out of the sky. The server pins the tank
// to its landing spot for the fall (dropIn.js) and sends FX 'dropin' with
// how long it lasts; this draws it.
//
//   on the ground   a landing marker closing in, and the tank's shadow: big
//                   and faint while it is high, small and dark as it comes
//                   down (that, not scaling the tank, is what reads as falling)
//   in the air      the tank itself, drawn up and to the left of its spot by
//                   its height (app.js asks fallOf(id) in the entity pass),
//                   a fiery re-entry trail, heat shimmer and sparks off it
//   your camera     rides with your falling tank (camOffset: app.js moves the
//                   view by it), so you come down with it and land centred on
//                   the spot; it starts high up (about 0.4x, never so far out
//                   the view runs off the map) and dives in, with a punch past
//                   normal at the hit (camZoom scales the world ratio); haze
//                   and clouds rush past up high, wind streaks speed up near
//                   the ground. Your keys are
//                   held (inputHeld) and the server freezes the tank until the hit
//   someone else's  a warning on the ground (pulsing ring, falling chevrons),
//                   a long fiery streak, a sonic boom ring on the way down, the
//                   impact, a shake scaled by distance and a crater. Many at
//                   once (bot waves) or far away: only the light version
//   the hit         shock rings, rock chunks and dust, a shake, a glitch and
//                   a white flash for your own, and a crater mark that fades
//
// A first drop of the raid takes about 1.5 s, a respawn about 0.9 s. The
// camera zoom is skipped on software rendering, low resolution and reduced
// motion; Fewer Effects and the quality scale thin out the sparks.
import { global } from "./global.js";
import { config } from "./config.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";
import * as juice from "./juice.js";
import * as JM from "./juiceMath.js";

let A = null;
export function init(helpers) { A = helpers; juice.setSlamHold(landAt); }

const TAU = Math.PI * 2;
const GOLD = "#f2b83c";
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const lite = () => !!config.graphical.fewerEffects;
const softGpu = () => { const tr = window.terrainRenderer; return !!(tr && tr._rockQuality != null && tr._rockQuality < 1); };
const zoomOn = () => !softGpu() && !global.autoLowRes && !global.userLowRes;
// Light Sensitive and reduced motion: a much smaller pull-up, no shake
const gentle = () => calm() || !!config.graphical.lightSafe;
// it comes in from up and to the left
const DIR_X = 0.75, DIR_Y = 0.66, DIR_L = Math.hypot(DIR_X, DIR_Y);
const TANK_R = 30;

const drops = [];
for (let i = 0; i < 12; i++) drops.push({ on: false, born: 0, x: 0, y: 0, id: -1, r: 135, ms: 900, hit: false, H: 520, sparkAt: 0, vis: false, crate: false, rock: false, size: 40, far: false, boom: false });
// recent big impacts by someone else: past BIG_CAP in BIG_MS, the light version
const BIG_CAP = 3, BIG_MS = 700, FAR = 1700;
const bigAt = [];
function bigSlot(now) {
    while (bigAt.length && now - bigAt[0] > BIG_MS) bigAt.shift();
    if (bigAt.length >= BIG_CAP) return false;
    bigAt.push(now);
    return true;
}
let dropI = 0;
const craters = [];
for (let i = 0; i < 6; i++) craters.push({ born: -1e9, x: 0, y: 0, r: 120, rot: 0, cracks: JM.crackPaths(101 + i * 17, 9, 4, 1) });
let craterI = 0;

// vis: only a picture (a resume after a reload): the keys stay live
// kind 'crate' (a supply crate) or 'meteor': no entity, this draws it itself;
// size: the crate's hull radius, so the marker closes on its exact footprint
export function start(x, y, id, r, ms, vis, kind, size) {
    const d = drops[dropI]; dropI = (dropI + 1) % drops.length;
    // a newer drop for the same tank replaces the old one
    for (const o of drops) if (o.on && o.id === id) o.on = false;
    d.on = true; d.born = performance.now(); d.x = x; d.y = y; d.id = id | 0;
    d.r = r > 0 ? r : 135;
    d.ms = ms > 0 ? Math.max(400, Math.min(2500, ms)) : (d.r > 200 ? 1500 : 900);
    d.H = d.ms > 1200 ? 560 : 380;
    d.hit = false; d.sparkAt = 0; d.vis = !!vis; d.crate = kind === 'crate' || kind === true; d.rock = kind === 'meteor';
    d.size = size > 0 ? size : 40;
    d.boom = false;
    d.far = Math.hypot(x - global.player.renderx, y - global.player.rendery) > FAR;
    if (d.crate) d.H = 700;
    if (d.rock) d.H = 520;
}
function active(d, now) { return d.on && now - d.born < d.ms + 1400; }
function find(id) {
    for (const d of drops) if (d.on && d.id === id) return d;
    return null;
}

// the entity pass: where the falling tank is drawn, as an offset from its spot
const fallOut = { dx: 0, dy: 0, s: 1, h: 0 };
export function fallOf(id) {
    const d = find(id);
    if (!d) return null;
    const age = performance.now() - d.born;
    if (age >= d.ms) return null;
    const h = JM.fallHeight(age / d.ms);
    fallOut.h = h;
    fallOut.dx = -DIR_X * h * d.H;
    fallOut.dy = -DIR_Y * h * d.H;
    fallOut.s = 1 + 0.12 * h;
    return fallOut;
}
// app.js renderFrame: the world ratio is multiplied by this. ratio: the
// normal world ratio, to keep the far-out view inside the room
export function camZoom(ratio) {
    if (!zoomOn() || global.died) return 1;
    const d = find(gui.playerid);
    if (!d) return 1;
    const age = performance.now() - d.born;
    if (age > d.ms + 400) return 1;
    // a respawn starts lower than the first drop; gentle settings lower still
    const from = gentle() ? 0.82 : d.ms > 1500 ? JM.DROP_ZOOM_FROM : 0.5;
    let z = JM.dropZoom(age / d.ms, Math.max(0, age - d.ms), from);
    if (gentle()) z = Math.min(z, 1);
    if (z < 1 && ratio > 0) {
        // a little past the room is fine, the haze's edge covers that
        const half = (global.gameWidth || 0) / 2 + 450;
        const f = age < d.ms ? fallOf(gui.playerid) : null;
        const ex = JM.edgeZoom(global.screenWidth / 2, ratio, half, d.x + (f ? f.dx : 0));
        const ey = JM.edgeZoom(global.screenHeight / 2, ratio, half, d.y + (f ? f.dy : 0));
        z = Math.max(z, Math.min(1, Math.max(ex, ey)));
    }
    return z;
}
// how high up your own drop still is (0 on the ground), for the haze
function altitude(now) {
    const d = find(gui.playerid);
    if (!d || global.died || d.vis) return 0;
    const age = now - d.born;
    return age < d.ms ? JM.fallHeight(age / d.ms) : 0;
}
export function falling() {
    const d = find(gui.playerid);
    return !!d && performance.now() - d.born < d.ms;
}
// the camera rides the falling tank: world offset from the landing spot
const camOut = { dx: 0, dy: 0 };
export function camOffset() {
    if (global.died) return null;
    const f = fallOf(gui.playerid);
    if (!f) return null;
    camOut.dx = f.dx; camOut.dy = f.dy;
    return camOut;
}
// no keys, clicks or sticks reach the server until the hit
export function inputHeld() {
    const d = find(gui.playerid);
    return !!d && !d.vis && !global.died && performance.now() - d.born < d.ms;
}
// when your own landing happens (0 when you're not falling)
export function landAt() {
    const d = find(gui.playerid);
    if (!d || global.died) return 0;
    const at = d.born + d.ms;
    return at > performance.now() ? at : 0;
}

function impact(d) {
    const self = d.id === gui.playerid;
    // a first drop of the raid (the long fall) gets the full show
    const big = !d.crate && !d.rock && d.ms >= 1800;
    const x = d.x, y = d.y;
    if (d.rock) {
        // a meteor going off: fire, chunks, a shove of air
        juice.ring(x, y, "#ffd76e", 20, 240, 420, 14);
        juice.ring(x, y, "#ff8a3a", 20, 180, 700, 10);
        juice.sparks(x, y, 20, 260, 700, 0, "#ffb347");
        juice.sparks(x, y, 14, 200, 800, 1, "#2b2433", TAU, 0, 8);
        const dist = Math.hypot(x - global.player.renderx, y - global.player.rendery);
        if (dist < 1100) juice.shake(24 * (1 - dist / 1100) + 6, 300);
        return;
    }
    if (d.vis && !d.crate) {
        // a resume after a reload: only a picture, nothing broke, so no
        // crater and no flying rock
        juice.ring(x, y, "#ffffff", 30, 220, 480, 14);
        juice.ring(x, y, "#6b5844", 30, 260, 1000, 20);
        if (self) juice.shake(30, 320);
        return;
    }
    const now = performance.now();
    const dist = Math.hypot(x - global.player.renderx, y - global.player.rendery);
    if (!self && !d.crate && (d.far || dist > FAR || !bigSlot(now))) {
        // far off, or a wave of bots landing at once: the light version
        juice.ring(x, y, "#ffffff", 30, 260, 520, 16);
        juice.ring(x, y, "#6b5844", 30, 300, 1100, 22);
        const c = craters[craterI]; craterI = (craterI + 1) % craters.length;
        c.born = now; c.x = x; c.y = y; c.r = Math.max(110, d.r * 0.85); c.rot = (d.id % 7) * 0.9;
        return;
    }
    juice.ring(x, y, "#ffffff", 30, big ? 460 : 300, 560, 22);
    juice.ring(x, y, GOLD, 20, big ? 340 : 220, 800, 14);
    // the dust wave rolling out
    juice.ring(x, y, "#6b5844", 40, big ? 560 : 360, 1500, 34);
    juice.ring(x, y, "#5a4a3a", 30, big ? 420 : 260, 1100, 24);
    juice.sparks(x, y, big ? 56 : 36, big ? 480 : 300, 950, 1, "#2b2433", TAU, 0, big ? 11 : 9);
    juice.sparks(x, y, big ? 30 : 18, big ? 360 : 240, 700, 0, "#ffb347");
    juice.sparks(x, y, big ? 20 : 12, big ? 300 : 200, 1300, 1, "#6b5844", TAU, 0, 14);
    juice.sparks(x, y, 22, big ? 480 : 300, 600, 0, "#ffe9b0");
    if (big) {
        juice.sparks(x, y, 10, 260, 900, 2, "#7fb1f2", TAU, 0, 6);
        juice.sparks(x, y, 10, 260, 900, 3, GOLD, TAU, 0, 6);
    }
    const c = craters[craterI]; craterI = (craterI + 1) % craters.length;
    // the mark is as wide as the smash the server did (d.r)
    c.born = performance.now(); c.x = x; c.y = y; c.r = Math.max(110, d.r * 0.85); c.rot = (d.id % 7) * 0.9;
    if (self) {
        // the keys you held through the fall count again from here
        if (!d.vis) { try { const cmd = global.socket && global.socket.cmd; if (cmd && cmd.reactNow) cmd.reactNow(); } catch (e) { /* */ } }
        if (!gentle()) juice.shake(big ? 90 : 70, big ? 700 : 560, big ? 60 : 48);
        juice.hitStop(50);
        thud(big);
        juice.glitch(0.85, 340);
        juice.flash("#ffffff", 180, big ? 0.38 : 0.28);
        if (big) juice.lightLeak("255,170,90", 1100);
        try { if (gameSound.oreBreak) gameSound.oreBreak(global.player.renderx, global.player.rendery, 3); } catch (e) { /* */ }
    } else if (dist < 1300) {
        // a short kick, weaker the further off it lands
        if (!gentle()) juice.shake(6 + 26 * (1 - dist / 1300), 320);
        try { if (gameSound.oreBreak) gameSound.oreBreak(x, y, 2); } catch (e) { /* */ }
    }
}

// floor layer, under the tanks: craters, markers, shadows, the trails
export function drawGround(c, px, py, ratio) {
    const now = performance.now();
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    let opened = false;
    for (const k of craters) {
        const age = now - k.born;
        if (age < 0 || age > 6000) continue;
        const sx = ratio * k.x - px + cx, sy = ratio * k.y - py + cy, R = k.r * ratio;
        if (sx < -R || sy < -R || sx > global.screenWidth + R || sy > global.screenHeight + R) continue;
        if (!opened) { c.save(); c.lineCap = "round"; opened = true; }
        const a = age < 4500 ? 1 : 1 - (age - 4500) / 1500;
        c.globalAlpha = 0.32 * a;
        c.fillStyle = "#0c0a0e";
        c.beginPath(); c.arc(sx, sy, R * 0.55, 0, TAU); c.fill();
        c.globalAlpha = 0.5 * a;
        c.strokeStyle = "#0c0a0e"; c.lineWidth = Math.max(1.5, 3 * ratio);
        const ca = Math.cos(k.rot), sa = Math.sin(k.rot);
        for (const p of k.cracks) {
            c.beginPath();
            for (let i = 0; i < p.length; i += 2) {
                const ux = p[i] * ca - p[i + 1] * sa, uy = p[i] * sa + p[i + 1] * ca;
                if (i) c.lineTo(sx + ux * R, sy + uy * R); else c.moveTo(sx + ux * R * 0.4, sy + uy * R * 0.4);
            }
            c.stroke();
        }
        c.globalAlpha = 0.25 * a;
        c.strokeStyle = "#8a7258"; c.lineWidth = Math.max(1, 4 * ratio);
        c.beginPath(); c.arc(sx, sy, R * 0.58, 0, TAU); c.stroke();
    }
    for (const d of drops) {
        if (!active(d, now)) { if (d.on && now - d.born > d.ms + 1400) d.on = false; continue; }
        const age = now - d.born;
        if (age >= d.ms) {
            if (!d.hit) { d.hit = true; impact(d); }
            continue;
        }
        if (!opened) { c.save(); c.lineCap = "round"; opened = true; }
        const k = age / d.ms, h = JM.fallHeight(k);
        const self = d.id === gui.playerid;
        const gx = ratio * d.x - px + cx, gy = ratio * d.y - py + cy;
        const col = self || d.crate ? GOLD : "#ffd9a0";
        // the sound barrier, two thirds of the way down: a ring where it is in the air
        if (!d.boom && k > 0.62 && !d.rock) {
            d.boom = true;
            if (!d.far) juice.ring(d.x - DIR_X * h * d.H, d.y - DIR_Y * h * d.H, "#ffffff", 16, d.crate ? 300 : 240, 460, 8);
        }
        // the landing marker: a ring closing in with four ticks, turning (a
        // crate's closes on its own footprint)
        const mr = (d.crate ? d.size * (1 + 2.2 * h) : 55 + 120 * h) * ratio;
        const spin = calm() ? 0 : now / 400;
        c.globalAlpha = 0.45 + 0.45 * k;
        c.strokeStyle = "#120e15"; c.lineWidth = Math.max(3, 7 * ratio);
        c.beginPath(); c.arc(gx, gy, mr, 0, TAU); c.stroke();
        c.strokeStyle = col; c.lineWidth = Math.max(1.5, 3.2 * ratio);
        c.beginPath(); c.arc(gx, gy, mr, 0, TAU); c.stroke();
        for (let i = 0; i < 4; i++) {
            const a = spin + i * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
            c.beginPath(); c.moveTo(gx + ca * (mr - 14 * ratio), gy + sa * (mr - 14 * ratio)); c.lineTo(gx + ca * (mr + 14 * ratio), gy + sa * (mr + 14 * ratio)); c.stroke();
        }
        // someone else coming down: chevrons pointing at the spot, beating
        if (!self && !d.crate) {
            const beat = calm() ? 0.5 : 0.5 + 0.5 * Math.sin(now / 90);
            c.globalAlpha = 0.5 + 0.4 * beat;
            c.lineWidth = Math.max(2, 4 * ratio);
            for (let i = 0; i < 2; i++) {
                const yy = gy - mr - (18 + 16 * i + 10 * (1 - beat)) * ratio, w = (14 - 3 * i) * ratio;
                c.strokeStyle = i ? "#ffd9a0" : "#ff8a3a";
                c.beginPath(); c.moveTo(gx - w, yy - w * 0.8); c.lineTo(gx, yy); c.lineTo(gx + w, yy - w * 0.8); c.stroke();
            }
        }
        // the shadow: big and soft high up, small and dark close
        const sr = d.crate ? d.size * ratio * (0.85 + 1.6 * h) : TANK_R * ratio * (0.75 + 2.4 * h);
        c.fillStyle = "#000000";
        c.globalAlpha = 0.08 + 0.18 * (1 - h);
        c.beginPath(); c.arc(gx, gy, sr * 1.35, 0, TAU); c.fill();
        c.globalAlpha = 0.1 + 0.42 * (1 - h);
        c.beginPath(); c.arc(gx, gy, sr, 0, TAU); c.fill();
        // the re-entry trail behind the tank, longer as it speeds up
        const tx = gx - DIR_X * h * d.H * ratio, ty = gy - DIR_Y * h * d.H * ratio;
        // someone else's is a long streak across the sky, seen from far
        const L = (self ? 180 + 320 * k : 320 + 720 * k) * ratio / DIR_L;
        const ex = tx - DIR_X * L, ey = ty - DIR_Y * L;
        const w = TANK_R * ratio * (1.3 + 0.3 * h);
        c.globalAlpha = 0.22;
        c.strokeStyle = "#ff3c1e"; c.lineWidth = w * 2.2;
        c.beginPath(); c.moveTo(ex, ey); c.lineTo(tx, ty); c.stroke();
        c.globalAlpha = 0.45;
        c.strokeStyle = "#ff8a3a"; c.lineWidth = w * 1.4;
        c.beginPath(); c.moveTo(tx - DIR_X * L * 0.75, ty - DIR_Y * L * 0.75); c.lineTo(tx, ty); c.stroke();
        c.globalAlpha = 0.75;
        c.strokeStyle = "#ffd76e"; c.lineWidth = w * 0.8;
        c.beginPath(); c.moveTo(tx - DIR_X * L * 0.45, ty - DIR_Y * L * 0.45); c.lineTo(tx, ty); c.stroke();
        c.globalAlpha = 0.95;
        c.strokeStyle = "#ffffff"; c.lineWidth = w * 0.35;
        c.beginPath(); c.moveTo(tx - DIR_X * L * 0.2, ty - DIR_Y * L * 0.2); c.lineTo(tx, ty); c.stroke();
        if (A && A.haloSprite && juice.glowOn()) {
            const hr = w * (2.4 + 0.4 * Math.sin(now / 60));
            c.globalAlpha = 0.8;
            c.drawImage(A.haloSprite("dropFire", "255,150,60", [[0, 0.95], [0.4, 0.45], [1, 0]]), tx - hr, ty - hr, hr * 2, hr * 2);
        }
        // sparks shed off the trail (world units)
        if (!lite() && !d.far && now - d.sparkAt > 25) {
            d.sparkAt = now;
            const wx = d.x - DIR_X * h * d.H, wy = d.y - DIR_Y * h * d.H;
            juice.sparks(wx, wy, 3, 140, 420, 0, k > 0.5 ? "#ffd76e" : "#ff8a3a", 1.2, Math.atan2(-DIR_Y, -DIR_X), 4);
            if (k > 0.5) juice.sparks(wx, wy, 1, 90, 520, 1, "#3a2a1e", 1.4, Math.atan2(-DIR_Y, -DIR_X), 5);
        }
    }
    if (opened) c.restore();
}

// top layer: the heat bow in front of the tank, and the speed lines on
// your own drop (screen space)
export function drawAir(c, px, py, ratio) {
    const now = performance.now();
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    let opened = false;
    for (const d of drops) {
        if (!d.on) continue;
        const age = now - d.born;
        if (age >= d.ms || age < 0) continue;
        if (!opened) { c.save(); c.lineCap = "round"; opened = true; }
        const k = age / d.ms, h = JM.fallHeight(k);
        const tx = ratio * (d.x - DIR_X * h * d.H) - px + cx, ty = ratio * (d.y - DIR_Y * h * d.H) - py + cy;
        const R = TANK_R * ratio * 1.35;
        const front = Math.atan2(DIR_Y, DIR_X);
        if (d.crate) drawCrate(c, tx, ty, d.size * ratio * 0.78 * (1 + 0.12 * h), now);
        else if (d.rock) drawMeteor(c, tx, ty, TANK_R * ratio * 0.9, now, d.id);
        // heat shimmer: wobbling arcs on the leading side
        for (let i = 0; i < 3; i++) {
            const wob = calm() ? 0 : Math.sin(now / 45 + i * 2.1) * 0.12;
            c.globalAlpha = 0.5 - i * 0.13;
            c.strokeStyle = i === 0 ? "#ffffff" : "#ffd9a0";
            c.lineWidth = Math.max(1.5, (4 - i) * ratio);
            c.beginPath(); c.arc(tx, ty, R * (1 + i * 0.18), front - 1.1 + wob, front + 1.1 + wob); c.stroke();
        }
        if (d.id === gui.playerid && k > 0.2 && !calm()) {
            // wind streaks rushing out from the middle, more and faster near the ground
            const u = (k - 0.2) / 0.8;
            const W = global.screenWidth, Hh = global.screenHeight, D = Math.hypot(W, Hh) / 2;
            c.strokeStyle = "#ffffff";
            c.lineWidth = 2;
            const n = 8 + Math.round(16 * u);
            for (let i = 0; i < n; i++) {
                const a = JM.hash01(i, 3) * TAU;
                const ph = ((now / (420 - 260 * u) + JM.hash01(i, 9)) % 1);
                const r0 = D * (0.35 + 0.6 * ph), r1 = r0 + D * (0.12 + 0.2 * u);
                c.globalAlpha = 0.28 * u * (1 - ph);
                c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.stroke();
            }
        }
    }
    if (opened) c.restore();
    drawHaze(c, now);
}

// Your own drop, high up: a light haze over everything (it also hides how
// thin the map gets far out) and a few clouds rushing past and away as you
// come down. Screen space, a handful of sprites.
function drawHaze(c, now) {
    const h = altitude(now);
    if (h < 0.05 || !A) return;
    const W = global.screenWidth, Hh = global.screenHeight, D = Math.hypot(W, Hh) / 2;
    const hh = Math.pow(h, 1.5);
    c.save();
    c.globalAlpha = 0.3 * hh;
    c.fillStyle = "#c9d6e8";
    c.fillRect(0, 0, W, Hh);
    // the edge of the view in cloud: far out, that's where the map runs out
    if (A.vignetteSprite) {
        c.globalAlpha = 0.9 * hh;
        c.drawImage(A.vignetteSprite(W, Hh, 0.45, "214,224,238"), 0, 0, W, Hh);
    }
    if (A.haloSprite && !lite()) {
        const spr = A.haloSprite("dropCloud", "240,245,252", [[0, 0.75], [0.5, 0.35], [1, 0]]);
        // down past them: each cloud slides out from the middle and grows
        const fall = 1 - h;
        for (let i = 0; i < 7; i++) {
            const a = JM.hash01(i, 21) * TAU;
            const r = D * (0.12 + 0.35 * JM.hash01(i, 22) + (calm() ? 0 : 1.5 * fall * fall));
            const s = D * (0.35 + 0.25 * JM.hash01(i, 23)) * (1 + 1.4 * fall);
            c.globalAlpha = Math.min(1, 2 * h) * (0.6 + 0.3 * JM.hash01(i, 24));
            c.drawImage(spr, W / 2 + Math.cos(a) * r - s, Hh / 2 + Math.sin(a) * r * 0.75 - s, s * 2, s * 2);
        }
    }
    c.restore();
}

// the supply crate in the air: a banded box, tumbling a little
function drawCrate(c, x, y, s, now) {
    c.save();
    c.translate(x, y);
    c.rotate(calm() ? 0.3 : 0.3 + Math.sin(now / 160) * 0.25);
    c.lineJoin = "round";
    c.fillStyle = "#145c36"; c.strokeStyle = "#120e15"; c.lineWidth = Math.max(2, s * 0.14);
    c.fillRect(-s, -s, s * 2, s * 2); c.strokeRect(-s, -s, s * 2, s * 2);
    c.fillStyle = "#6ff5a8";
    c.fillRect(-s, -s * 0.18, s * 2, s * 0.36);
    c.fillRect(-s * 0.18, -s, s * 0.36, s * 2);
    c.strokeRect(-s * 0.18, -s * 0.18, s * 0.36, s * 0.36);
    c.restore();
}

// a meteor: a dark lump with a hot rim
function drawMeteor(c, x, y, s, now, id) {
    c.save();
    c.translate(x, y);
    c.rotate(now / 140 + id);
    c.beginPath();
    for (let i = 0; i < 7; i++) {
        const a = i / 7 * TAU, r = s * (0.75 + 0.25 * JM.hash01(id, i));
        if (i) c.lineTo(Math.cos(a) * r, Math.sin(a) * r); else c.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    c.closePath();
    c.fillStyle = "#2b2433"; c.fill();
    c.strokeStyle = "#ff8a3a"; c.lineWidth = Math.max(2, s * 0.22); c.stroke();
    c.restore();
}

// a heavy landing: a deep boom with a rumble running on after it
function thud(big) {
    const s = gameSound;
    try {
        if (!s || !s.ctx || !s._mix || !s._impact) return;
        const m = s._mix('combat');
        if (!m) return;
        s._impact({ sub: 38, body: 82, bodyTo: 34, air: 200, weight: (big ? 1 : 0.8) * m, dur: big ? 0.75 : 0.55 });
        s._tone({ freq: 46, glideTo: 28, type: 'sine', dur: big ? 1.3 : 0.9, peak: 0.22 * m, attack: 0.01 });
        s._puff({ kind: 'brown', cut: 160, cutTo: 70, Q: 0.6, dur: big ? 1.4 : 1, peak: 0.16 * m, attack: 0.03 });
    } catch (e) { /* */ }
}

// QA (headless runs)
window.dwDrop = () => drops.filter(d => d.on).map(d => ({ id: d.id, age: Math.round(performance.now() - d.born), ms: d.ms, r: d.r, self: d.id === gui.playerid }));
