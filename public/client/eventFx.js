import { global } from "./global.js";
import { config } from "./config.js";
import { gameSound } from "./sound.js";
import * as juice from "./juice.js";
import * as JM from "./juiceMath.js";

const TAU = Math.PI * 2;
const CORE = "#5ce8ff", CORE_HOT = "#ff5ad8", DARK = "#2b2433", INK = "#0c0a0e", SPARK = "#fff4c2";
const LAND_MS = 560, EXIT_TAIL_MS = 700, CRATER_MS = 7000, BLAST_HIDE_MS = 2600, HIT_MS = 190;
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const lite = () => !!(config.graphical && config.graphical.fewerEffects);
const glow = () => !(config.graphical && config.graphical.noGlow);
const distMe = (x, y) => Math.hypot(x - global.player.renderx, y - global.player.rendery);
function mk(n, f) { const a = []; for (let i = 0; i < n; i++) a.push(f()); return a; }
function oldest(list) {
    let o = list[0];
    for (let i = 1; i < list.length; i++) if (list[i].born < o.born) o = list[i];
    return o;
}
function backOut(k) {
    const c = 1.9, u = k - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
}
function sfx(fn, ...a) { try { if (gameSound[fn]) gameSound[fn](...a); } catch (e) { } }

const CRACKS = [JM.crackPaths(211, 9, 5, 1), JM.crackPaths(457, 8, 5, 1), JM.crackPaths(733, 10, 4, 1), JM.crackPaths(919, 9, 5, 1)];
let crackI = 0;
const warns = mk(4, () => ({ born: -1e9, x: 0, y: 0, ms: 1800, size: 80, col: "#c9a8ff", core: false, cracks: CRACKS[0], dustAt: 0, rot: 0 }));
const lands = mk(4, () => ({ born: -1e9, id: -1, x: 0, y: 0, size: 80, col: "#c9a8ff", cracks: CRACKS[0], rot: 0 }));
const exits = mk(4, () => ({ born: -1e9, id: -1, x: 0, y: 0, ms: 1500, size: 80, col: "#c9a8ff", dustAt: 0, done: false, cracks: CRACKS[0], rot: 0 }));
const blasts = mk(2, () => ({ born: -1e9, x: 0, y: 0, r: 100, R: 620, rot: 0 }));
const hits = mk(10, () => ({ born: -1e9, x: 0, y: 0, ang: 0, col: "#ffffff", r: 12 }));
let hitI = 0;
const coreHit = { id: -1, at: -1e9, hp: 1 };
const bossHit = { id: -1, at: -1e9 };

export function onFX(kind, x, y, a, b, c, d) {
    const now = performance.now();
    switch (kind) {
        case "bossrise": warn(x, y, +a || 1800, +b || 80, typeof c === "string" ? c : "#c9a8ff", false, now); return true;
        case "corerise": warn(x, y, +a || 1800, 110, CORE, true, now); return true;
        case "bossland": land(x, y, a | 0, +b || 80, typeof c === "string" ? c : "#c9a8ff", now); return true;
        case "bossexit": exit(x, y, a | 0, +b || 1500, +c || 80, typeof d === "string" ? d : "#c9a8ff", now); return true;
        case "coreblast": blast(x, y, +a || 100, +b || 620, now); return true;
    }
    return false;
}

function warn(x, y, ms, size, col, core, now) {
    const o = oldest(warns);
    o.born = now; o.x = x; o.y = y; o.ms = Math.max(400, Math.min(4000, ms)); o.size = size; o.col = col; o.core = core;
    o.cracks = CRACKS[crackI++ % CRACKS.length]; o.dustAt = 0; o.rot = Math.random() * TAU;
    const d = distMe(x, y);
    if (!calm()) {
        juice.rumble(o.ms + 400, d < 1400 ? 7 : d < 2600 ? 3 : 1);
        if (d < 1300) juice.shake(14, 320);
    }
    if (d < 2600) sfx("stormWarn");
    juice.ring(x, y, col, size * 3.6, size * 1.1, o.ms * 0.6, 6);
}

function land(x, y, id, size, col, now) {
    const o = oldest(lands);
    o.born = now; o.id = id; o.x = x; o.y = y; o.size = size; o.col = col;
    o.cracks = CRACKS[crackI++ % CRACKS.length]; o.rot = Math.random() * TAU;
    const d = distMe(x, y);
    juice.ring(x, y, "#ffffff", size * 0.6, size * 4.4, 720, 18);
    juice.ring(x, y, col, size * 0.4, size * 3.3, 1050, 12);
    juice.sparks(x, y, 34, size * 3.2, 1000, 1, DARK, TAU, 0, 9);
    juice.sparks(x, y, 22, size * 2.6, 900, 2, col, TAU, 0, 7);
    juice.sparks(x, y, 18, size * 2.0, 700, 0, "#ffe9b0", TAU, 0, 5);
    if (d < 1900 && !calm()) {
        juice.shake(d < 900 ? 46 : 24, 520);
        if (d < 900) juice.hitStop(55, 70);
        juice.flash("#ffffff", 170, d < 900 ? 0.28 : 0.12);
        juice.glitch(0.5, 260);
    }
    if (d < 3200) { sfx("rockBreak", x, y); sfx("oreBreak", x, y, 4); }
}

function exit(x, y, id, ms, size, col, now) {
    const o = oldest(exits);
    o.born = now; o.id = id; o.x = x; o.y = y; o.ms = Math.max(400, Math.min(4000, ms)); o.size = size; o.col = col;
    o.dustAt = 0; o.done = false; o.cracks = CRACKS[crackI++ % CRACKS.length]; o.rot = Math.random() * TAU;
    const d = distMe(x, y);
    juice.ring(x, y, col, size * 0.8, size * 2.6, 700, 10);
    juice.sparks(x, y, 18, size * 1.6, 800, 1, DARK, TAU, 0, 8);
    if (!calm()) juice.rumble(o.ms, d < 1400 ? 6 : 2);
    if (d < 2600) sfx("rockBreak", x, y);
}

function blast(x, y, r, R, now) {
    const o = oldest(blasts);
    o.born = now; o.x = x; o.y = y; o.r = r; o.R = R; o.rot = Math.random() * TAU;
    const d = distMe(x, y);
    juice.ring(x, y, "#ffffff", r * 0.5, R * 2.3, 1300, 26);
    juice.ring(x, y, CORE, r * 0.4, R * 1.7, 1600, 16);
    juice.ring(x, y, CORE_HOT, r * 0.3, R * 1.2, 1800, 10);
    juice.sparks(x, y, 70, R * 1.5, 1600, 2, CORE, TAU, 0, 11);
    juice.sparks(x, y, 40, R * 1.2, 1500, 2, "#ff8ae3", TAU, 0, 9);
    juice.sparks(x, y, 50, R * 1.1, 1300, 1, DARK, TAU, 0, 11);
    juice.sparks(x, y, 30, R * 1.8, 1100, 0, "#ffffff", TAU, 0, 6);
    if (d < 2800 && !calm()) {
        juice.slowMo(600, 0.35);
        juice.hitStop(90, 110);
        juice.shake(d < 1400 ? 80 : 40, 1200, 50);
        juice.rumble(1500, 8);
        juice.glitch(1, 600);
        juice.flash("#ffffff", 600, d < 1400 ? 0.75 : 0.35);
        juice.lightLeak("150,240,255", 1800);
    }
    sfx("rankShatter");
    if (d < 3200) { sfx("rockBreak", x, y); sfx("oreBreak", x, y, 4); }
}

const sOut = { dx: 0, dy: 0, s: 1, h: 0 };
export function scaleOf(id) {
    if (id == null || id < 0) return null;
    const now = performance.now();
    for (let i = 0; i < lands.length; i++) {
        const o = lands[i];
        if (o.id !== id) continue;
        const age = now - o.born;
        if (age < 0 || age >= LAND_MS) continue;
        const k = age / LAND_MS;
        sOut.s = 0.42 + 0.58 * backOut(k);
        sOut.dx = 0;
        sOut.dy = 0;
        sOut.h = 1 - k;
        return sOut;
    }
    for (let i = 0; i < exits.length; i++) {
        const o = exits[i];
        if (o.id !== id) continue;
        const age = now - o.born;
        if (age < 0 || age >= o.ms + EXIT_TAIL_MS) continue;
        const k = Math.min(1, age / o.ms);
        sOut.s = Math.max(0.04, 1 - 0.96 * k * k);
        const j = calm() ? 0 : 5 * (0.3 + k);
        sOut.dx = Math.sin(age / 21) * j;
        sOut.dy = Math.cos(age / 27) * j * 0.6;
        sOut.h = k;
        return sOut;
    }
    return null;
}

export function blastHides(x, y) {
    const now = performance.now();
    for (let i = 0; i < blasts.length; i++) {
        const o = blasts[i];
        const age = now - o.born;
        if (age >= 0 && age < BLAST_HIDE_MS && Math.abs(o.x - x) < 260 && Math.abs(o.y - y) < 260) return true;
    }
    return false;
}

export function coreHitInfo(id) { return coreHit.id === id ? coreHit : null; }
export function bossHitAt(id) { return bossHit.id === id ? bossHit.at : -1e9; }

export function onBigHit(id, dmg, bx, by, kind, hpMilli) {
    const list = global.entities;
    let e = null;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) { e = list[i]; break; }
    if (!e) return;
    const now = performance.now();
    const core = (kind | 0) === 2;
    const R = (e.size || 60) * (core ? 0.95 : 0.9);
    const ex = e.render && isFinite(e.render.x) ? e.render.x : e.x, ey = e.render && isFinite(e.render.y) ? e.render.y : e.y;
    const ang = Math.atan2(by - ey, bx - ex);
    const ix = ex + Math.cos(ang) * R, iy = ey + Math.sin(ang) * R;
    const hp = hpMilli >= 0 ? Math.max(0, Math.min(1, hpMilli / 1000)) : 1;
    const bc = (global.royale && global.royale.boss && global.royale.boss.c) || "#c9a8ff";
    const col = core ? (hp < 0.5 ? "#ff8ae3" : "#9ff6ff") : bc;
    const n = lite() ? 0.6 : 1;
    juice.sparks(ix, iy, Math.round((core ? 6 : 5) * n), 160, 380, 0, SPARK, 1.5, ang, 4);
    juice.sparks(ix, iy, Math.round((core ? 3 : 2) * n) || 1, 120, 620, core ? 2 : 1, core ? col : DARK, 1.2, ang, core ? 5 : 6);
    const h = hits[hitI]; hitI = (hitI + 1) % hits.length;
    h.born = now; h.x = ix; h.y = iy; h.ang = ang; h.col = col; h.r = Math.min(46, 14 + Math.sqrt(Math.max(1, dmg)) * 1.4);
    if (core) { coreHit.id = id; coreHit.at = now; coreHit.hp = hp; }
    else { bossHit.id = id; bossHit.at = now; }
    pushNumber(id, ix, iy, dmg, core ? "#bff8ff" : "#ffd6a0", now);
    if (core) sfx("rockHit", ix, iy, 3);
    else sfx("combatHit", dmg >= 150 ? 1 : 0);
}

function pushNumber(id, x, y, dmg, col, now) {
    if (!(dmg >= 1) || !config.game || config.game.damageNumbers === false) return;
    const list = global.damageNumbers;
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i];
        if (d.bigId !== id) continue;
        if (now - d.comboAt > 460) break;
        d.amount += dmg; d.comboAt = now; d.punch = now; d.x = x; d.y = y;
        return;
    }
    list.push({ id: 0, bigId: id, x, y, amount: dmg, tier: 0, self: false, born: now, comboAt: now, combo: 1, punch: 0,
        jitter: Math.random() * 2 - 1, word: "", kind: "rock", ore: 0, holdMs: 420, fadeMs: 640, col });
    if (list.length > 10) list.splice(0, list.length - 10);
}

function sx(x, px, ratio) { return ratio * x - px + global.screenWidth / 2; }
function sy(y, py, ratio) { return ratio * y - py + global.screenHeight / 2; }
function offScreen(x, y, r) { return x < -r || y < -r || x > global.screenWidth + r || y > global.screenHeight + r; }

function crackDraw(c, cx, cy, reach, cracks, rot, w, col, alpha) {
    if (alpha <= 0.01 || reach < 2) return;
    const ca = Math.cos(rot), sa = Math.sin(rot);
    c.globalAlpha = alpha;
    c.strokeStyle = col;
    c.lineWidth = w;
    c.beginPath();
    for (let i = 0; i < cracks.length; i++) {
        const p = cracks[i];
        for (let k = 0; k + 1 < p.length; k += 2) {
            const ux = p[k] * ca - p[k + 1] * sa, uy = p[k] * sa + p[k + 1] * ca;
            if (k) c.lineTo(cx + ux * reach, cy + uy * reach); else c.moveTo(cx + ux * reach, cy + uy * reach);
        }
    }
    c.stroke();
}

export function drawFloor(c, px, py, ratio) {
    const now = performance.now();
    let saved = false;
    for (let i = 0; i < warns.length; i++) {
        const o = warns[i];
        const age = now - o.born;
        if (age < 0 || age > o.ms + 250) continue;
        const k = Math.min(1, age / o.ms);
        tickWarn(o, age, k, now);
        const x = sx(o.x, px, ratio), y = sy(o.y, py, ratio);
        const S = o.size * ratio;
        if (offScreen(x, y, S * 4)) continue;
        if (!saved) { c.save(); c.lineCap = "round"; c.lineJoin = "round"; saved = true; }
        const beat = calm() ? 0.5 : 0.5 + 0.5 * Math.sin(age / (110 - 60 * k));
        c.globalAlpha = 0.07 + 0.16 * k + 0.05 * beat;
        c.fillStyle = o.col;
        c.beginPath(); c.arc(x, y, S * (1.2 + 1.0 * k), 0, TAU); c.fill();
        const reach = S * 3.1 * (1 - (1 - k) * (1 - k));
        crackDraw(c, x, y, reach, o.cracks, o.rot, Math.max(2, 7 * ratio), INK, 0.7);
        crackDraw(c, x, y, reach, o.cracks, o.rot, Math.max(1, 2.4 * ratio), o.col, 0.55 + 0.4 * beat);
        const Rr = S * (3.6 - 2.4 * k);
        c.globalAlpha = 0.45 + 0.45 * beat;
        c.strokeStyle = o.col;
        c.lineWidth = Math.max(2, (3 + 3 * k) * ratio);
        c.beginPath(); c.arc(x, y, Rr, 0, TAU); c.stroke();
        c.globalAlpha = 0.85;
        c.strokeStyle = "#ffffff";
        c.lineWidth = Math.max(1.5, 2.5 * ratio);
        c.beginPath(); c.arc(x, y, S * 1.05, -age / 300, -age / 300 + TAU * (0.15 + 0.85 * k)); c.stroke();
    }
    for (let i = 0; i < lands.length; i++) {
        const o = lands[i];
        const age = now - o.born;
        if (age < 0 || age > CRATER_MS) continue;
        const x = sx(o.x, px, ratio), y = sy(o.y, py, ratio);
        const S = o.size * ratio;
        if (offScreen(x, y, S * 3.5)) continue;
        if (!saved) { c.save(); c.lineCap = "round"; c.lineJoin = "round"; saved = true; }
        const fade = age < CRATER_MS - 1500 ? 1 : (CRATER_MS - age) / 1500;
        const grow = Math.min(1, age / 260);
        c.globalAlpha = 0.32 * fade;
        c.fillStyle = INK;
        c.beginPath(); c.arc(x, y, S * (1.1 + 0.4 * grow), 0, TAU); c.fill();
        crackDraw(c, x, y, S * 2.8 * grow, o.cracks, o.rot, Math.max(2, 6 * ratio), INK, 0.6 * fade);
        crackDraw(c, x, y, S * 2.8 * grow, o.cracks, o.rot, Math.max(1, 2 * ratio), o.col, (age < 900 ? 0.9 : 0.35) * fade);
    }
    for (let i = 0; i < exits.length; i++) {
        const o = exits[i];
        const age = now - o.born;
        if (age < 0 || age > o.ms + EXIT_TAIL_MS + 2500) continue;
        tickExit(o, age, now);
        const x = sx(o.x, px, ratio), y = sy(o.y, py, ratio);
        const S = o.size * ratio;
        if (offScreen(x, y, S * 3)) continue;
        if (!saved) { c.save(); c.lineCap = "round"; c.lineJoin = "round"; saved = true; }
        const k = Math.min(1, age / o.ms);
        const close = age > o.ms ? Math.min(1, (age - o.ms) / (EXIT_TAIL_MS + 2500)) : 0;
        const hole = S * (0.5 + 0.9 * Math.sqrt(k)) * (1 - 0.85 * close);
        c.globalAlpha = 0.75 * (1 - close);
        c.fillStyle = INK;
        c.beginPath(); c.arc(x, y, hole, 0, TAU); c.fill();
        c.globalAlpha = 0.5 * (1 - close);
        c.strokeStyle = o.col;
        c.lineWidth = Math.max(1.5, 3 * ratio);
        c.beginPath(); c.arc(x, y, hole * 1.08, 0, TAU); c.stroke();
        crackDraw(c, x, y, S * (1.2 + 1.4 * k), o.cracks, o.rot, Math.max(2, 5 * ratio), INK, 0.6 * (1 - close));
    }
    for (let i = 0; i < blasts.length; i++) {
        const o = blasts[i];
        const age = now - o.born;
        if (age < 0 || age > 9000) continue;
        const x = sx(o.x, px, ratio), y = sy(o.y, py, ratio);
        const R = o.R * ratio;
        if (offScreen(x, y, R * 1.2)) continue;
        if (!saved) { c.save(); c.lineCap = "round"; c.lineJoin = "round"; saved = true; }
        const fade = age < 6500 ? 1 : (9000 - age) / 2500;
        const grow = Math.min(1, age / 420);
        c.globalAlpha = 0.38 * fade;
        c.fillStyle = INK;
        c.beginPath(); c.arc(x, y, o.r * ratio * (1.3 + 0.9 * grow), 0, TAU); c.fill();
        crackDraw(c, x, y, R * 0.95 * grow, CRACKS[0], o.rot, Math.max(2, 7 * ratio), INK, 0.65 * fade);
        crackDraw(c, x, y, R * 0.95 * grow, CRACKS[0], o.rot, Math.max(1, 2.4 * ratio), CORE, (age < 1500 ? 0.9 : 0.4) * fade);
        crackDraw(c, x, y, R * 0.6 * grow, CRACKS[2], o.rot + 0.4, Math.max(1, 1.6 * ratio), CORE_HOT, 0.5 * fade);
    }
    if (saved) c.restore();
}

function tickWarn(o, age, k, now) {
    if (now - o.dustAt < 130 || age > o.ms) return;
    o.dustAt = now;
    const p = o.cracks[(Math.random() * o.cracks.length) | 0];
    const reach = o.size * 3.1 * (1 - (1 - k) * (1 - k));
    const ca = Math.cos(o.rot), sa = Math.sin(o.rot);
    const lx = p[p.length - 2], ly = p[p.length - 1];
    const tx = o.x + (lx * ca - ly * sa) * reach, ty = o.y + (lx * sa + ly * ca) * reach;
    juice.sparks(tx, ty, 2, 70, 600, 1, DARK, TAU, 0, 5);
    if (k > 0.5) juice.sparks(o.x, o.y, 2, o.size * 1.4, 500, 1, DARK, TAU, 0, 6);
    if (k > 0.35 && Math.random() < 0.35) sfx("rockHit", o.x, o.y, 2, true);
}

function tickExit(o, age, now) {
    if (age <= o.ms) {
        if (now - o.dustAt < 110) return;
        o.dustAt = now;
        const a = Math.random() * TAU;
        juice.sparks(o.x + Math.cos(a) * o.size, o.y + Math.sin(a) * o.size, 3, 120, 700, 1, DARK, 1.2, a, 7);
        if (Math.random() < 0.4) sfx("rockHit", o.x, o.y, 1, true);
        return;
    }
    if (o.done) return;
    o.done = true;
    juice.ring(o.x, o.y, "#ffffff", o.size * 0.3, o.size * 2.2, 520, 10);
    juice.ring(o.x, o.y, o.col, o.size * 0.2, o.size * 1.6, 800, 7);
    juice.sparks(o.x, o.y, 24, o.size * 1.8, 900, 1, DARK, TAU, 0, 8);
    juice.sparks(o.x, o.y, 12, o.size * 1.4, 800, 2, o.col, TAU, 0, 6);
    const d = distMe(o.x, o.y);
    if (d < 1500 && !calm()) juice.shake(18, 320);
    if (d < 2600) sfx("rockBreak", o.x, o.y);
}

export function drawWorld(c, px, py, ratio) {
    const now = performance.now();
    let saved = false;
    for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        const age = now - h.born;
        if (age < 0 || age > HIT_MS) continue;
        const x = sx(h.x, px, ratio), y = sy(h.y, py, ratio);
        if (offScreen(x, y, 60)) continue;
        if (!saved) { c.save(); c.lineCap = "round"; saved = true; }
        const k = age / HIT_MS;
        if (glow()) c.globalCompositeOperation = "lighter";
        c.globalAlpha = 0.7 * (1 - k);
        c.fillStyle = "#ffffff";
        c.beginPath(); c.arc(x, y, h.r * ratio * (0.35 + 0.4 * k), 0, TAU); c.fill();
        c.globalCompositeOperation = "source-over";
        c.globalAlpha = 0.8 * (1 - k);
        c.strokeStyle = h.col;
        c.lineWidth = Math.max(1, 3 * (1 - k) * ratio);
        c.beginPath(); c.arc(x, y, h.r * ratio * (0.5 + 0.9 * k), h.ang - 1.1, h.ang + 1.1); c.stroke();
    }
    for (let i = 0; i < blasts.length; i++) {
        const o = blasts[i];
        const age = now - o.born;
        if (age < 0 || age > 1500) continue;
        const x = sx(o.x, px, ratio), y = sy(o.y, py, ratio);
        const R = o.R * ratio, r = o.r * ratio;
        if (offScreen(x, y, R * 2)) continue;
        if (!saved) { c.save(); c.lineCap = "round"; saved = true; }
        if (age < 520) {
            const k = age / 520;
            if (glow()) c.globalCompositeOperation = "lighter";
            c.globalAlpha = (1 - k) * (1 - k);
            c.fillStyle = "#ffffff";
            c.beginPath(); c.arc(x, y, r * (1 + 2.6 * k), 0, TAU); c.fill();
            c.globalAlpha = 0.7 * (1 - k);
            c.fillStyle = CORE;
            c.beginPath(); c.arc(x, y, r * (1.6 + 3.4 * k), 0, TAU); c.fill();
            c.globalCompositeOperation = "source-over";
        }
        const k2 = Math.min(1, age / 950), e2 = 1 - (1 - k2) * (1 - k2) * (1 - k2);
        c.globalAlpha = (1 - k2) * 0.9;
        c.strokeStyle = "#ffffff";
        c.lineWidth = Math.max(2, 30 * (1 - k2) * ratio);
        c.beginPath(); c.arc(x, y, r + (R * 1.6 - r) * e2, 0, TAU); c.stroke();
        c.globalAlpha = (1 - k2) * 0.6;
        c.strokeStyle = CORE;
        c.lineWidth = Math.max(1.5, 12 * (1 - k2) * ratio);
        c.beginPath(); c.arc(x, y, (r + (R * 1.6 - r) * e2) * 0.9, 0, TAU); c.stroke();
        if (age < 1300 && glow()) {
            const fade = age < 200 ? age / 200 : 1 - (age - 200) / 1100;
            const L = Math.hypot(global.screenWidth, global.screenHeight) * 0.7;
            c.globalCompositeOperation = "lighter";
            c.fillStyle = "#bff8ff";
            for (let j = 0; j < 10; j++) {
                const a = o.rot + j * TAU / 10 + age / 1800, w = 0.05 + 0.03 * Math.sin(age / 200 + j);
                c.globalAlpha = 0.2 * fade;
                c.beginPath(); c.moveTo(x, y);
                c.lineTo(x + Math.cos(a - w) * L, y + Math.sin(a - w) * L);
                c.lineTo(x + Math.cos(a + w) * L, y + Math.sin(a + w) * L);
                c.closePath(); c.fill();
            }
            c.globalCompositeOperation = "source-over";
        }
    }
    if (saved) c.restore();
}

export function state() {
    const now = performance.now();
    const live = (l, ms) => l.filter(o => now - o.born >= 0 && now - o.born < (ms || o.ms || 0)).length;
    return { warns: live(warns, 0), lands: live(lands, LAND_MS), exits: live(exits, 0), blasts: live(blasts, 1500), hits: live(hits, HIT_MS), coreHit: { id: coreHit.id, hp: coreHit.hp, age: now - coreHit.at } };
}
if (typeof window !== "undefined") window.dwEventFx = state;
