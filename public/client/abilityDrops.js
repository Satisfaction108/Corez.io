import { global } from "./global.js";
import { gameSound } from "./sound.js";

const R = 20;
const SPR_PX = 128;
const SPR_UNIT = 2.7;
const POP_IN_MS = 420;
const POP_MS = 460;
const BLINK_MS = 6000;
const FADE_MS = 300;
const GONE_HOLD_MS = 3000;

let H = null;
let colors = {};
const sprites = new Map();
const live = new Map();
const gone = new Map();
const pops = [];
let lastList = null;

export function init(helpers, abColors) { H = helpers; colors = abColors || {}; sprites.clear(); }

const calm = () => !!(global.reducedMotion && global.reducedMotion());

function mixHex(hex, to, k) {
    const a = parseInt(String(hex).slice(1), 16), b = parseInt(String(to).slice(1), 16);
    const ch = (v, s) => (v >> s) & 255;
    const m = (s) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * k);
    return "rgb(" + m(16) + "," + m(8) + "," + m(0) + ")";
}

function sprite(id) {
    let spr = sprites.get(id);
    if (spr) return spr;
    spr = document.createElement("canvas");
    spr.width = spr.height = SPR_PX;
    const c = spr.getContext("2d");
    const mid = SPR_PX / 2, r = SPR_PX / SPR_UNIT;
    const col = colors[id] || "#8a93a6";
    c.beginPath(); c.arc(mid, mid + r * 0.1, r, 0, Math.PI * 2);
    c.fillStyle = "rgba(0,0,0,0.3)"; c.fill();
    c.beginPath(); c.arc(mid, mid, r, 0, Math.PI * 2);
    c.fillStyle = "#17151d"; c.fill();
    const face = r * 0.78;
    c.beginPath(); c.arc(mid, mid, face, 0, Math.PI * 2);
    c.fillStyle = mixHex(col, "#ffffff", 0.18); c.fill();
    c.save();
    c.beginPath(); c.arc(mid, mid, face, 0, Math.PI * 2); c.clip();
    c.beginPath(); c.arc(mid, mid + face * 0.95, face * 1.25, 0, Math.PI * 2);
    c.fillStyle = mixHex(col, "#000000", 0.18); c.fill();
    c.beginPath(); c.ellipse(mid - face * 0.28, mid - face * 0.5, face * 0.42, face * 0.2, -0.5, 0, Math.PI * 2);
    c.fillStyle = "rgba(255,255,255,0.32)"; c.fill();
    c.restore();
    if (H && H.paintGlyph) {
        c.save();
        c.translate(mid, mid - face * 0.04);
        try { H.paintGlyph(c, id, face * 0.9); } catch (e) { }
        c.restore();
    }
    if (H && H.paintGlyph) sprites.set(id, spr);
    return spr;
}

function sync(now) {
    const list = global.royale && global.royale.abd;
    if (list === lastList) return;
    lastList = list;
    const seen = new Set();
    for (const d of Array.isArray(list) ? list : []) {
        const id = d.i | 0;
        if (!id || gone.has(id)) continue;
        seen.add(id);
        let e = live.get(id);
        if (!e) {
            e = { id, k: String(d.k || ""), x: +d.x || 0, y: +d.y || 0, seen: now, until: now + (+d.l || 0), fade: 0 };
            if ((+d.a || 0) > 3000) e.seen = now - POP_IN_MS;
            live.set(id, e);
        } else e.until = now + (+d.l || 0);
    }
    for (const e of live.values()) if (!seen.has(e.id) && !e.fade) e.fade = now;
    for (const [id, at] of gone) if (now - at > GONE_HOLD_MS) gone.delete(id);
}

export function onGet(x, y, by, id) {
    const now = performance.now();
    const e = live.get(id);
    live.delete(id);
    gone.set(id, now);
    const k = e ? e.k : "";
    pops.push({ k, x: e ? e.x : x, y: e ? e.y : y, by, at: now });
    if (pops.length > 8) pops.shift();
    try { if (by && by === myId() && gameSound.gemPickup) gameSound.gemPickup(4); } catch (e2) { }
}

let myIdFn = () => -1;
export function setSelf(fn) { myIdFn = fn; }
function myId() { try { return myIdFn(); } catch (e) { return -1; } }

function easeBack(u) {
    const s = 1.9;
    const v = u - 1;
    return 1 + v * v * ((s + 1) * v + s);
}

export function drawFloor(c, px, py, ratio) {
    const now = performance.now();
    sync(now);
    if (!live.size) return;
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    const still = calm();
    const size = R * SPR_UNIT * ratio;
    for (const e of live.values()) {
        const fadeK = e.fade ? 1 - (now - e.fade) / FADE_MS : 1;
        const left = e.until - now;
        if (fadeK <= 0 || left < -FADE_MS) { live.delete(e.id); continue; }
        const sx = ratio * e.x - px + cx, sy = ratio * e.y - py + cy;
        if (sx < -size || sy < -size || sx > global.screenWidth + size || sy > global.screenHeight + size) continue;
        const age = now - e.seen;
        const grow = age >= POP_IN_MS ? 1 : Math.max(0, easeBack(age / POP_IN_MS));
        const ph = e.id * 1.7;
        const bob = still ? 0 : (Math.sin(now / 430 + ph) * 0.5 + 0.5) * 5;
        const pulse = still ? 1 : 1 + 0.05 * Math.sin(now / 290 + ph);
        const endK = left < 0 ? Math.max(0, 1 + left / FADE_MS) : 1;
        const blink = left < BLINK_MS && left > 0 && (now % 500) < 170 ? 0.4 : 1;
        const alpha = Math.min(fadeK, endK) * blink;
        if (alpha <= 0.01) continue;
        const col = colors[e.k] || "#8a93a6";
        c.save();
        c.globalAlpha = alpha * 0.32 * grow;
        c.fillStyle = "#000000";
        c.beginPath();
        c.ellipse(sx, sy + R * 0.82 * ratio, R * ratio * (0.95 - bob * 0.04), R * ratio * 0.32, 0, 0, Math.PI * 2);
        c.fill();
        if (!still && grow >= 1) {
            const u = ((now + e.id * 377) % 1700) / 1700;
            c.globalAlpha = alpha * (1 - u) * 0.6;
            c.strokeStyle = col;
            c.lineWidth = Math.max(1, 2.5 * ratio * (1 - u));
            c.beginPath();
            c.arc(sx, sy - bob * ratio, R * ratio * (1.05 + 0.9 * u), 0, Math.PI * 2);
            c.stroke();
        }
        c.globalAlpha = alpha;
        const s = size * grow * pulse;
        c.drawImage(sprite(e.k), sx - s / 2, sy - bob * ratio - s / 2, s, s);
        c.restore();
    }
}

function entAt(id) {
    const list = global.entities;
    if (!id || !list) return null;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
}

export function drawPops(c, px, py, ratio) {
    if (!pops.length) return;
    const now = performance.now();
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    for (let i = pops.length - 1; i >= 0; i--) {
        const p = pops[i];
        const u = (now - p.at) / POP_MS;
        if (u >= 1) { pops.splice(i, 1); continue; }
        let wx = p.x, wy = p.y;
        const ent = entAt(p.by);
        if (ent && ent.render) { const k = Math.min(1, u * 1.6); wx += (ent.render.x - p.x) * k; wy += (ent.render.y - p.y) * k; }
        const sx = ratio * wx - px + cx, sy = ratio * wy - py + cy;
        const ox = ratio * p.x - px + cx, oy = ratio * p.y - py + cy;
        const col = colors[p.k] || "#ffffff";
        c.save();
        c.globalAlpha = (1 - u) * 0.85;
        c.strokeStyle = col;
        c.lineWidth = Math.max(1.5, 4 * ratio * (1 - u));
        c.beginPath(); c.arc(ox, oy, R * ratio * (1 + 1.8 * u), 0, Math.PI * 2); c.stroke();
        c.strokeStyle = "#ffffff";
        c.lineWidth = Math.max(1, 2.5 * ratio * (1 - u));
        c.lineCap = "round";
        for (let k = 0; k < 6; k++) {
            const a = k / 6 * Math.PI * 2 + 0.3;
            const r0 = R * ratio * (1.1 + 1.2 * u), r1 = r0 + R * ratio * 0.5 * (1 - u);
            c.beginPath();
            c.moveTo(ox + Math.cos(a) * r0, oy + Math.sin(a) * r0);
            c.lineTo(ox + Math.cos(a) * r1, oy + Math.sin(a) * r1);
            c.stroke();
        }
        if (p.k) {
            const s = R * SPR_UNIT * ratio * (1 + 0.35 * Math.sin(Math.PI * Math.min(1, u * 1.4))) * (1 - u * 0.6);
            c.globalAlpha = 1 - u;
            c.drawImage(sprite(p.k), sx - s / 2, sy - s / 2, s, s);
        }
        c.restore();
    }
}

export function touchText(msg) {
    if (!msg || !/\b(on Q|so Q is back)\b/.test(msg)) return msg;
    if (global.mobile) return String(msg).replace(/\bon Q\b/g, "on your ability button").replace(/\bso Q is back\b/g, "so your ability button is back");
    let key = "Q";
    try { key = (H && H.keyLabel && H.keyLabel("KEY_ABILITY", "Q")) || "Q"; } catch (e) { key = "Q"; }
    return key === "Q" ? msg : String(msg).replace(/\bon Q\b/g, "on " + key).replace(/\bso Q is back\b/g, "so " + key + " is back");
}

export function reset() { live.clear(); gone.clear(); pops.length = 0; lastList = null; }

export const _test = { live, pops, sprite, sync };
