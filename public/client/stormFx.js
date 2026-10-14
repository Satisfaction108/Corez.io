import { global } from "./global.js";
import { config } from "./config.js";
import { gameSound } from "./sound.js";

let A = null;
export function init(helpers) { A = helpers; }

const TAU = Math.PI * 2;
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const lite = () => !!config.graphical.fewerEffects;
const glowOn = () => !config.graphical.noGlow && !global.lowFx;
const softGpu = () => { const tr = window.terrainRenderer; return !!(tr && tr._rockQuality != null && tr._rockQuality < 1); };

const WIND_X = Math.cos(-0.42);

function hash(i, k) {
    const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return v - Math.floor(v);
}

const TINT = "#9b66f2";
const TINT_A = 0.15, TINT_IN_A = 0.24;
const EDGE_INK = "#5a2fb0", EDGE_COL = "#a77af6";
const RAIN_COL = "#6d45cc";

const OV_W = 192;
const ov = { cv: null, edge: null, w: 0, h: 0, t: -1, e: -1 };
function overlay(sw, sh, tintA, edgeA) {
    const h = Math.max(2, Math.round(OV_W * sh / Math.max(1, sw)));
    if (!ov.cv) { ov.cv = document.createElement("canvas"); ov.edge = document.createElement("canvas"); }
    if (ov.w !== OV_W || ov.h !== h) {
        ov.cv.width = ov.edge.width = OV_W; ov.cv.height = ov.edge.height = h;
        ov.w = OV_W; ov.h = h; ov.t = ov.e = -1;
        const g = ov.edge.getContext("2d");
        const r = Math.hypot(OV_W, h) / 2;
        const gd = g.createRadialGradient(OV_W / 2, h / 2, r * 0.42, OV_W / 2, h / 2, r);
        gd.addColorStop(0, "rgba(154, 98, 240, 0)");
        gd.addColorStop(0.55, "rgba(154, 98, 240, 0.3)");
        gd.addColorStop(1, "rgba(122, 70, 224, 0.85)");
        g.fillStyle = gd;
        g.fillRect(0, 0, OV_W, h);
    }
    const t = Math.round(tintA * 96), e = Math.round(edgeA * 96);
    if (t !== ov.t || e !== ov.e) {
        ov.t = t; ov.e = e;
        const g = ov.cv.getContext("2d");
        g.clearRect(0, 0, OV_W, h);
        if (t > 0) { g.globalAlpha = t / 96; g.fillStyle = TINT; g.fillRect(0, 0, OV_W, h); }
        if (e > 0) { g.globalAlpha = e / 96; g.drawImage(ov.edge, 0, 0); }
        g.globalAlpha = 1;
    }
    return ov.cv;
}

const POUR_N = 150;
const pourX = new Float32Array(POUR_N), pourY = new Float32Array(POUR_N), pourL = new Float32Array(POUR_N), pourV = new Float32Array(POUR_N);
for (let i = 0; i < POUR_N; i++) {
    pourX[i] = hash(i, 191); pourY[i] = hash(i, 192);
    pourL[i] = 22 + 26 * hash(i, 193); pourV[i] = 0.75 + 0.5 * hash(i, 194);
}
function drawPour(c, sw, sh, a, now) {
    const n = lite() || global.lowFx ? POUR_N >> 1 : POUR_N;
    const t = now / 1000;
    const W = sw + 80, H = sh + 80;
    const vx = WIND_X * 0.55 + 0.25, vy = 1;
    c.beginPath();
    for (let i = 0; i < n; i++) {
        const sp = 1150 * pourV[i];
        const x = (pourX[i] * W + t * sp * vx) % W - 40;
        const y = (pourY[i] * H + t * sp * vy) % H - 40;
        const l = pourL[i];
        c.moveTo(x, y);
        c.lineTo(x - vx * l, y - vy * l);
    }
    c.globalAlpha = a;
    c.strokeStyle = RAIN_COL;
    c.lineWidth = 1.6;
    c.lineCap = "butt";
    c.stroke();
    c.globalAlpha = 1;
}

let visA0 = 0, visA1 = TAU;
function visibleArc(cx, cy, rr, sw, sh) {
    const scx = sw / 2, scy = sh / 2;
    const d = Math.hypot(scx - cx, scy - cy), hd = Math.hypot(sw, sh) / 2 + 40;
    if (d <= hd * 1.05) { visA0 = 0; visA1 = TAU; return; }
    const ac = Math.atan2(scy - cy, scx - cx), span = Math.asin(Math.min(1, hd / d)) + 0.02;
    visA0 = ac - span; visA1 = ac + span;
}

let flashSpr = null;
function ensureFlash() {
    if (flashSpr) return flashSpr;
    const S = 128;
    flashSpr = document.createElement("canvas");
    flashSpr.width = flashSpr.height = S;
    const g = flashSpr.getContext("2d");
    const gd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gd.addColorStop(0, "rgba(245, 238, 255, 0.95)");
    gd.addColorStop(0.35, "rgba(180, 150, 255, 0.4)");
    gd.addColorStop(1, "rgba(130, 90, 255, 0)");
    g.fillStyle = gd;
    g.fillRect(0, 0, S, S);
    return flashSpr;
}

const BOLT_MAX = 26;
const bolt = { on: false, at: 0, life: 260, pts: new Float32Array(BOLT_MAX * 2), n: 0, br: 0, brN: 0, mx: 0, my: 0, size: 0 };
let nextBoltAt = 0, forceBolt = false;
let rimRot = 0;

function makeBolt(wx, wy, lenW, now) {
    const ang = Math.random() * TAU;
    const dx = Math.cos(ang), dy = Math.sin(ang), nx = -dy, ny = dx;
    const segs = 9;
    let k = 0;
    const P = bolt.pts;
    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const j = i === 0 || i === segs ? 0 : (Math.random() - 0.5) * lenW * 0.22;
        P[k++] = wx + dx * lenW * (t - 0.5) + nx * j;
        P[k++] = wy + dy * lenW * (t - 0.5) + ny * j;
    }
    bolt.n = segs + 1;
    bolt.br = 0; bolt.brN = 0;
    if (!lite()) {
        const from = 3 + Math.floor(Math.random() * 4);
        const bx = P[from * 2], by = P[from * 2 + 1];
        const side = Math.random() < 0.5 ? -1 : 1;
        const bdx = dx * 0.6 + nx * side * 0.8, bdy = dy * 0.6 + ny * side * 0.8;
        bolt.br = bolt.n;
        const bs = 4;
        for (let i = 0; i <= bs; i++) {
            const t = i / bs;
            const j = i === 0 ? 0 : (Math.random() - 0.5) * lenW * 0.12;
            P[k++] = bx + bdx * lenW * 0.38 * t + nx * j;
            P[k++] = by + bdy * lenW * 0.38 * t + ny * j;
        }
        bolt.brN = bs + 1;
    }
    bolt.mx = wx; bolt.my = wy; bolt.size = lenW;
    bolt.at = now; bolt.on = true;
}
function boltEnv(age) {
    if (age < 0 || age > bolt.life) return 0;
    if (age < 50) return 1;
    if (age < 90) return 0.35;
    if (age < 140) return 0.9;
    return 0.9 * (1 - (age - 140) / (bolt.life - 140));
}
function boltPath(c, ox, oy, ratio, from, n) {
    const P = bolt.pts;
    for (let i = 0; i < n; i++) {
        const x = ox + P[(from + i) * 2] * ratio, y = oy + P[(from + i) * 2 + 1] * ratio;
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
}
function drawBolt(c, ox, oy, ratio, e, k) {
    const sx = ox + bolt.mx * ratio, sy = oy + bolt.my * ratio;
    if (glowOn()) {
        const R = bolt.size * ratio * 1.8;
        c.globalAlpha = 0.5 * e * k;
        c.drawImage(ensureFlash(), sx - R, sy - R, R * 2, R * 2);
    }
    c.globalAlpha = e * k;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.beginPath();
    boltPath(c, ox, oy, ratio, 0, bolt.n);
    if (bolt.brN) boltPath(c, ox, oy, ratio, bolt.br, bolt.brN);
    c.strokeStyle = EDGE_INK;
    c.lineWidth = Math.max(5, 8 * ratio);
    c.stroke();
    c.strokeStyle = "#fbf8ff";
    c.lineWidth = Math.max(2, 3 * ratio);
    c.stroke();
    c.globalAlpha = 1;
}
function stepBolt(c, cx, cy, rr, ox, oy, ratio, sw, sh, now) {
    if (!bolt.on && (forceBolt || now >= nextBoltAt)) {
        if (nextBoltAt || forceBolt) {
            for (let tries = 0; tries < 12; tries++) {
                const sx = sw * (0.08 + 0.84 * Math.random()), sy = sh * (0.08 + 0.84 * Math.random());
                const dx = sx - cx, dy = sy - cy;
                if (dx * dx + dy * dy < (rr + 90) * (rr + 90)) continue;
                if (Math.abs(sx - sw / 2) < 110 && Math.abs(sy - sh / 2) < 110) continue;
                makeBolt((sx - ox) / ratio, (sy - oy) / ratio, forceBolt ? 220 : 140 + 120 * Math.random(), now);
                break;
            }
        }
        forceBolt = false;
        nextBoltAt = now + (lite() ? 5500 + 4500 * Math.random() : 2200 + 3000 * Math.random());
    }
    if (!bolt.on) return;
    const e = boltEnv(now - bolt.at);
    if (e <= 0 && now - bolt.at > bolt.life) bolt.on = false;
    else if (e > 0) drawBolt(c, ox, oy, ratio, e, weatherK);
}

let weatherK = 0, lastT = 0;
export function drawWorld(c, cx, cy, rr, ox, oy, ratio, sw, sh) {
    const now = performance.now();
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
    lastT = now;
    const still = calm();
    const wantK = warn.inside ? 1 : 0;
    weatherK = still ? wantK : weatherK + (wantK - weatherK) * Math.min(1, dt * 7);
    if (Math.abs(weatherK - wantK) < 0.01) weatherK = wantK;
    const fx = Math.max(Math.abs(cx), Math.abs(sw - cx)), fy = Math.max(Math.abs(cy), Math.abs(sh - cy));
    if (fx * fx + fy * fy < rr * rr) { bolt.on = false; return; }
    c.save();
    c.beginPath();
    c.rect(-40, -40, sw + 80, sh + 80);
    c.arc(cx, cy, Math.max(0, rr), 0, TAU, true);
    c.globalAlpha = TINT_A + (TINT_IN_A - TINT_A) * weatherK;
    c.fillStyle = TINT;
    c.fill("evenodd");
    if (weatherK > 0 && !still) {
        c.globalAlpha = 1;
        c.clip("evenodd");
        stepBolt(c, cx, cy, rr, ox, oy, ratio, sw, sh, now);
    } else bolt.on = false;
    c.restore();
    drawEdge(c, cx, cy, rr, ratio, sw, sh, still ? 0 : dt);
}

const RIM_K = 512;
function drawEdge(c, cx, cy, rr, ratio, sw, sh, dt) {
    if (rr < 1) return;
    visibleArc(cx, cy, rr, sw, sh);
    const full = visA1 - visA0 >= TAU - 1e-6;
    const rw = rr / Math.max(1e-6, ratio);
    c.save();
    c.strokeStyle = "rgba(160, 112, 250, 0.16)";
    c.lineWidth = Math.max(16, 64 * ratio);
    c.beginPath();
    c.arc(cx, cy, rr + c.lineWidth / 2, visA0, visA1);
    c.stroke();
    if (glowOn()) {
        c.strokeStyle = "rgba(150, 105, 255, 0.24)";
        c.lineWidth = Math.max(10, 36 * ratio);
        c.beginPath();
        c.arc(cx, cy, rr + c.lineWidth / 2, visA0, visA1);
        c.stroke();
        c.strokeStyle = "rgba(190, 150, 255, 0.4)";
        c.lineWidth = Math.max(4, 12 * ratio);
        c.beginPath();
        c.arc(cx, cy, rr + c.lineWidth / 2, visA0, visA1);
        c.stroke();
    }
    rimRot = (rimRot + dt * 16 / Math.max(60, rw)) % TAU;
    const dA = TAU / RIM_K;
    let step = 1;
    while (step < 64 && rw * dA * step < 70) step *= 2;
    if (lite()) step *= 2;
    const i0 = Math.floor((visA0 - rimRot) / dA / step) * step;
    const i1 = full ? i0 + RIM_K : Math.ceil((visA1 - rimRot) / dA / step) * step;
    const wob = lastT / 1000;
    c.lineCap = "round";
    for (let b = 0; b < 3; b++) {
        c.beginPath();
        let any = false;
        for (let i = i0; i <= i1; i += step) {
            const id = ((i % RIM_K) + RIM_K) % RIM_K;
            if ((hash(id, 7) * 3 | 0) !== b) continue;
            const a = i * dA + rimRot;
            const lenW = 40 + 90 * hash(id, 8);
            const off = (6 + 40 * hash(id, 9) + (calm() ? 0 : 4 * Math.sin(wob * (0.8 + hash(id, 10)) + id))) * ratio;
            const r = rr + off;
            const da = lenW * ratio / r;
            c.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
            c.arc(cx, cy, r, a, a + da);
            any = true;
        }
        if (!any) continue;
        c.strokeStyle = b === 0 ? "rgba(118, 70, 220, 0.5)" : b === 1 ? "rgba(160, 112, 250, 0.62)" : "rgba(236, 226, 255, 0.85)";
        c.lineWidth = Math.max(1.4, (b === 2 ? 2.8 : 4.2) * ratio);
        c.stroke();
    }
    const w = Math.max(3, 6 * ratio);
    c.lineCap = "butt";
    c.beginPath();
    c.arc(cx, cy, rr, visA0, visA1);
    c.strokeStyle = EDGE_INK;
    c.lineWidth = w + Math.max(3, 4 * ratio);
    c.stroke();
    c.strokeStyle = EDGE_COL;
    c.lineWidth = w;
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, rr - w * 0.15, visA0, visA1);
    c.strokeStyle = "#efe6ff";
    c.lineWidth = Math.max(1.2, 1.8 * ratio);
    c.stroke();
    c.restore();
}

// ── the safe-zone job ─────────────────────────────────────────────────
// While "Get inside the safe zone" runs, the whole safe circle is the
// target: a warm glow just inside the edge and gold dashes marching round
// it on top of the storm's own line. Only the visible arc is stroked, and
// nothing at all when the edge is off screen.
const SAFE_DASH = [0, 0];
export function drawSafeZone(c, cx, cy, rr, ratio, sw, sh) {
    if (rr < 4) return;
    const glowW = Math.max(18, 70 * ratio);
    // off screen: every screen corner well inside, or the circle nowhere near
    const fx = Math.max(Math.abs(cx), Math.abs(sw - cx)), fy = Math.max(Math.abs(cy), Math.abs(sh - cy));
    const ir = rr - glowW - 20;
    if (ir > 0 && fx * fx + fy * fy < ir * ir) return;
    const nx = Math.max(0, Math.min(sw, cx)) - cx, ny = Math.max(0, Math.min(sh, cy)) - cy;
    if (nx * nx + ny * ny > (rr + 20) * (rr + 20)) return;
    const now = performance.now();
    const still = calm();
    const pulse = still ? 1 : 0.8 + 0.2 * Math.sin(now / 300);
    visibleArc(cx, cy, rr, sw, sh);
    c.save();
    c.lineCap = "butt";
    // a warm band on the safe side (the wide soft part only with glow on)
    c.strokeStyle = "#ffd76e";
    if (glowOn()) {
        c.globalAlpha = 0.15 * pulse;
        c.lineWidth = glowW;
        c.beginPath(); c.arc(cx, cy, Math.max(1, rr - glowW / 2), visA0, visA1); c.stroke();
    }
    c.globalAlpha = 0.34 * pulse;
    c.lineWidth = glowW * 0.35;
    c.beginPath(); c.arc(cx, cy, Math.max(1, rr - glowW * 0.175), visA0, visA1); c.stroke();
    // ink under, then the marching gold dashes
    c.globalAlpha = 0.9;
    c.strokeStyle = "#120e15";
    c.lineWidth = Math.max(5, 9 * ratio);
    c.beginPath(); c.arc(cx, cy, rr, visA0, visA1); c.stroke();
    const dashPx = Math.max(12, 46 * ratio);
    SAFE_DASH[0] = dashPx; SAFE_DASH[1] = dashPx * 0.7;
    c.setLineDash(SAFE_DASH);
    c.lineDashOffset = still ? 0 : -(now / 1000) * 60 * Math.max(0.5, ratio);
    c.lineCap = "round";
    c.globalAlpha = 1;
    c.strokeStyle = "#ffd76e";
    c.lineWidth = Math.max(2.5, 4.5 * ratio);
    c.beginPath(); c.arc(cx, cy, rr, visA0, visA1); c.stroke();
    c.setLineDash(NO_DASH);
    c.restore();
}

// ── maps ──────────────────────────────────────────────────────────────
const DASH = [5, 4], NO_DASH = [];
// hl: the safe-zone job is running, so the circle is picked out in gold
export function drawMap(c, cx, cy, rr, x, y, w, h, toR, hl, toX, toY) {
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.arc(cx, cy, rr, 0, TAU, true);
    c.globalAlpha = 0.28;
    c.fillStyle = TINT;
    c.fill("evenodd");
    c.globalAlpha = 1;
    c.beginPath();
    c.arc(cx, cy, rr, 0, TAU);
    c.strokeStyle = EDGE_INK;
    c.lineWidth = 3;
    c.stroke();
    c.strokeStyle = EDGE_COL;
    c.lineWidth = 1.5;
    c.stroke();
    // where it's closing to
    // its own centre: the zone slides as it closes)
    const tcx = toX == null ? cx : toX, tcy = toY == null ? cy : toY;
    if (toR > 1 && toR < rr - 2) {
        c.beginPath();
        c.arc(tcx, tcy, toR, 0, TAU);
        c.setLineDash(DASH);
        c.strokeStyle = "rgba(70, 36, 140, 0.75)";
        c.lineWidth = 1.2;
        c.stroke();
        c.setLineDash(NO_DASH);
    }
    if (hl) {
        c.beginPath();
        c.arc(cx, cy, rr, 0, TAU);
        c.strokeStyle = "#ffd76e";
        c.lineWidth = 2.2;
        c.globalAlpha = calm() ? 1 : 0.7 + 0.3 * Math.sin(performance.now() / 300);
        c.stroke();
        c.globalAlpha = 1;
    }
    c.restore();
}

// ── the warning ───────────────────────────────────────────────────────
const warn = { inside: false, since: 0, level: 0, warnAt: 0, distTxt: "", distN: -1, textA: 1 };
// sm: the server's damage multiplier for you (0 when you're safe);
// dist: how far you are from the safe zone; dirAng: the way to it.
// A chevron on the screen's edge pointing the way to safety, so the way out reads
function edgeArrow(c, sw, sh, ang, col, a, label) {
    const m = 44, hw = sw / 2 - m, hh = sh / 2 - m;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const k = Math.min(Math.abs(ux) > 1e-6 ? hw / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? hh / Math.abs(uy) : Infinity);
    const x = sw / 2 + ux * k, y = sh / 2 + uy * k;
    c.save();
    c.globalAlpha = a;
    c.translate(x, y);
    c.save();
    c.rotate(ang);
    c.scale(2.2, 2.2);
    c.fillStyle = col;
    c.strokeStyle = "#120e15";
    c.lineWidth = 1.4;
    c.lineJoin = "round";
    c.beginPath(); c.moveTo(10, 0); c.lineTo(-6, -9); c.lineTo(-2, 0); c.lineTo(-6, 9); c.closePath();
    c.fill(); c.stroke();
    c.restore();
    c.restore();
    // the label sits on the screen side of the chevron
    if (label) A.drawText(label, x - ux * 36, y - uy * 30, 12, col, "center", true, a);
}

// Inside, but the edge is coming: a calm amber line and the way in
function drawNear(c, sw, sh, st) {
    const still = calm();
    const now = performance.now();
    const col = st.near <= 5 ? "#ffb070" : "#ffd76e";
    const head = "Storm reaches you in " + st.near + "s";
    const tail = "  ·  Head for the middle";
    const by = st.rowY || 60;
    const hw = A.hudTitleW(head, 14), dw = A.hudTextW ? A.hudTextW(tail, 12) : tail.length * 6.5;
    const W = hw + dw + 30, H = 26, x = sw / 2 - W / 2;
    c.save();
    A.hudPanel(c, x, by, W, H, { r: H / 2, bevel: false, stroke: col });
    A.hudTitle(head, x + 15, by + H / 2, 14, col, "left", 1);
    A.drawText(tail, x + 15 + hw, by + H / 2, 12, "#efe6d0", "left", true, 1);
    c.restore();
    const pulse = still ? 1 : 0.75 + 0.25 * Math.sin(now / 220);
    edgeArrow(c, sw, sh, st.dirAng, col, pulse, "Safe");
}

export function drawHud(c, sw, sh, topY, st) {
    const now = performance.now();
    if (!st.inside) {
        warn.inside = false;
        warn.level += (0 - warn.level) * 0.15;
        if (st.near > 0) drawNear(c, sw, sh, st);
        return;
    }
    if (!warn.inside) {
        warn.inside = true;
        warn.since = now;
        if (now - warn.warnAt > 4000 && !st.immune) {
            warn.warnAt = now;
            try { gameSound.stormWarn(); } catch (e) { /* */ }
        }
    }
    const target = st.immune ? 0 : Math.max(0.08, Math.min(1, (st.sm || 0) / 1.6));
    warn.level += (target - warn.level) * 0.08;
    const L = warn.level;
    const still = calm();
    const age = now - warn.since;
    // pulse speeds up as the ramp climbs
    const pulse = still ? 1 : 0.72 + 0.28 * Math.sin(now / 1000 * (3 + 6 * L));
    // Being in the storm should look like it, Fortnite style: the whole
    // screen goes purple and it pours. This comes first; the pulsing edge
    // is only a hint on top. Fades in on entry.
    const inA = still ? 1 : Math.min(1, age / 400);
    const tintA = softGpu() ? 0 : (0.16 + 0.1 * L) * inA;
    // screen-edge storm vignette, kept soft under the rain
    const va = Math.min(1, (0.35 + 0.4 * L) * pulse) * (config.graphical.fxLevel === 2 ? 0.8 : 0.55);
    if (glowOn()) {
        // the wash and the edge in one pass (see overlay)
        c.drawImage(overlay(sw, sh, tintA, va), 0, 0, sw, sh);
    } else {
        if (tintA > 0) {
            c.globalAlpha = tintA;
            c.fillStyle = TINT;
            c.fillRect(0, 0, sw, sh);
        }
        const b = 8 + 14 * L;
        c.globalAlpha = va * 0.6;
        c.fillStyle = "#8a52e8";
        c.fillRect(0, 0, sw, b); c.fillRect(0, sh - b, sw, b);
        c.fillRect(0, b, b, sh - 2 * b); c.fillRect(sw - b, b, b, sh - 2 * b);
        c.globalAlpha = 1;
    }
    if (!still) drawPour(c, sw, sh, 0.42 * inA, now);
    // banner, popping in on entry (coach.js steps aside while it is up)
    global.stormBannerAt = now;
    // a frame or two "inside" at a landing (the camera catching up) never flashes the
    if (age < 120) return;
    const pop = still ? 1 : Math.min(1, (age - 120) / 220);
    // one compact line in the row app.js keeps for it under the raid clock
    // (away from your tank, its chat and the slams): what's happening and
    // how far the safe zone is
    const col = st.immune ? "#9fd0ff" : L > 0.7 ? "#ffb0c8" : "#efe6ff";
    const d = Math.max(0, Math.round(st.dist / 10) * 10);
    if (d !== warn.distN) { warn.distN = d; warn.distTxt = "Safe zone " + A.fmtDist(d) + " away"; }
    const head = st.immune ? "Storm Anchor " + st.immune + "s" : st.final ? "Final storm, get out!" : "You're in the storm, get out!";
    const by = st.rowY || Math.max(topY + 6, 60);
    const hw = A.hudTitleW(head, 15), dw = A.hudTextW ? A.hudTextW("  ·  " + warn.distTxt, 12) : warn.distTxt.length * 6.5;
    const W = hw + dw + 30, H = 26, x = sw / 2 - W / 2;
    c.save();
    c.globalAlpha = pop;
    A.hudPanel(c, x, by, W, H, { r: H / 2, bevel: false, stroke: col === "#efe6ff" ? undefined : col });
    A.hudTitle(head, x + 15, by + H / 2, 15, col, "left", pop);
    A.drawText("  ·  " + warn.distTxt, x + 15 + hw, by + H / 2, 12, "#d9cff0", "left", true, pop);
    c.restore();
    // the arrow toward safety, circling your tank
    const bob = still ? 0 : Math.sin(now / 160) * 5;
    const ar = 86 + bob;
    const ax = sw / 2 + Math.cos(st.dirAng) * ar, ay = sh / 2 + Math.sin(st.dirAng) * ar;
    c.save();
    c.translate(ax, ay);
    c.rotate(st.dirAng);
    c.scale(2.4, 2.4);
    c.globalAlpha = pop;
    c.fillStyle = col;
    c.strokeStyle = "#120e15";
    c.lineWidth = 1.4;
    c.lineJoin = "round";
    c.beginPath(); c.moveTo(10, 0); c.lineTo(-6, -8); c.lineTo(-3, 0); c.lineTo(-6, 8); c.closePath();
    c.fill(); c.stroke();
    c.restore();
    // and one on the screen's edge, which still reads mid-fight
    if (!st.immune) edgeArrow(c, sw, sh, st.dirAng, col, pop * (still ? 1 : 0.8 + 0.2 * Math.sin(now / 160)), "Safe zone");
}

// QA hooks (headless runs)
window.dwStormFx = () => ({ bolt: bolt.on, level: Math.round(warn.level * 100) / 100, inside: warn.inside, next: Math.round(nextBoltAt - performance.now()) });
window.dwStormBolt = () => { forceBolt = true; return true; };
