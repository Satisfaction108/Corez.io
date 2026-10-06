// Rock dust that flies into your tank (round 9, mining feel)
import { global } from "./global.js";
import { config } from "./config.js";

const CAP = 120;            // specks alive at once
const POP_CAP = 6;
const px0 = new Float32Array(CAP), py0 = new Float32Array(CAP);
const ox = new Float32Array(CAP), oy = new Float32Array(CAP);
const born = new Float64Array(CAP), life = new Float32Array(CAP), sz = new Float32Array(CAP);
const col = new Uint8Array(CAP);
let head = 0, live = 0;
// 0 plain rock, then the ore tiers (copper .. diamond)
export const COLS = ["#c8b79c", "#e0864a", "#dfe4ec", "#f2c94c", "#3fcf7a", "#ff5a6a", "#8fe8ff"];
const pops = [];
for (let i = 0; i < POP_CAP; i++) pops.push({ on: false, x: 0, y: 0, at: 0, text: "" });
const popText = new Map();
let popHead = 0;
const FONT = "bold 15px Rubik, sans-serif";

const easeOut = (k) => 1 - (1 - k) * (1 - k);
function count(ore) {
    const n = ore > 0 ? 7 : 5;
    return config.graphical.fewerEffects || global.lowFx ? Math.ceil(n / 2) : n;
}
// one rock hit: x, y in world units
export function burst(x, y, ore, n) {
    ore = Math.max(0, Math.min(COLS.length - 1, ore | 0));
    const now = performance.now();
    const k = count(ore);
    for (let i = 0; i < k; i++) {
        const j = head;
        head = (head + 1) % CAP;
        const a = Math.random() * Math.PI * 2, d = 18 + Math.random() * 34;
        px0[j] = x; py0[j] = y;
        ox[j] = Math.cos(a) * d; oy[j] = Math.sin(a) * d;
        born[j] = now + i * 18;
        life[j] = 520 + Math.random() * 220;
        sz[j] = (ore > 0 ? 3.2 : 2.6) + Math.random() * 1.8;
        col[j] = ore;
    }
    live = Math.min(CAP, live + k);
    if ((n | 0) > 0) {
        let t = popText.get(n | 0);
        if (!t) { t = "+" + (n | 0) + ((n | 0) === 1 ? " gem" : " gems"); if (popText.size < 64) popText.set(n | 0, t); }
        const p = pops[popHead];
        popHead = (popHead + 1) % POP_CAP;
        p.on = true; p.x = x; p.y = y; p.at = now; p.text = t;
    }
}
export function alive() { return live; }

// c: the world-layer context
export function draw(c, px, py, ratio) {
    if (!live && !popsOn()) return;
    const now = performance.now();
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    const me = global.player;
    const tx = me ? me.renderx : 0, ty = me ? me.rendery : 0;
    let n = 0;
    c.save();
    for (let j = 0; j < CAP; j++) {
        const L = life[j];
        if (!(L > 0)) continue;
        const age = now - born[j];
        if (age < 0) { n++; continue; }
        if (age > L) { life[j] = 0; continue; }
        n++;
        const k = age / L;
        const out = easeOut(Math.min(1, k / 0.32));
        const pk = Math.max(0, (k - 0.18) / 0.82), pull = pk * pk;
        let wx = px0[j] + ox[j] * out, wy = py0[j] + oy[j] * out;
        wx += (tx - wx) * pull; wy += (ty - wy) * pull;
        const sx = ratio * wx - px + cx, sy = ratio * wy - py + cy;
        if (sx < -20 || sy < -20 || sx > global.screenWidth + 20 || sy > global.screenHeight + 20) continue;
        const s = sz[j] * ratio * (1 - 0.75 * pull);
        c.globalAlpha = k > 0.9 ? (1 - k) * 10 : 1;
        c.fillStyle = COLS[col[j]];
        c.fillRect(sx - s, sy - s, s * 2, s * 2);
    }
    live = n;
    // "+N gems" rises off the hit and fades
    c.font = FONT;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineJoin = "round";
    for (let i = 0; i < POP_CAP; i++) {
        const p = pops[i];
        if (!p.on) continue;
        const age = now - p.at;
        if (age > 900) { p.on = false; continue; }
        const k = age / 900;
        const sx = ratio * p.x - px + cx, sy = ratio * p.y - py + cy - 18 - 34 * easeOut(k);
        c.globalAlpha = k > 0.6 ? (1 - k) / 0.4 : 1;
        c.lineWidth = 4;
        c.strokeStyle = "#120e15";
        c.strokeText(p.text, sx, sy);
        c.fillStyle = "#4fe08a";
        c.fillText(p.text, sx, sy);
    }
    c.restore();
}
function popsOn() { for (let i = 0; i < POP_CAP; i++) if (pops[i].on) return true; return false; }
// QA / standalone renders
window.dwMineDust = { burst, alive };
