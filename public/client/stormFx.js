// The raid storm, drawn: a dark sky over everything outside the safe circle
// with clouds blowing through it, rain, now and then a small lightning bolt,
// and a bright, crisp edge so it's always obvious where safety starts. Also
// the "get out" warning (banner, arrow, screen-edge vignette) while you're in
// it, and the storm on the minimap and the big map.
//
// Everything costly is baked once: two cloud tiles (drawn as repeating
// patterns), the lightning glow and the vignettes. A frame is a clip, a few
// fills and a handful of strokes, with no allocations.
//
// app.js calls drawWorld (floor layer, under the tanks), drawHud (gui layer)
// and drawMap, and hands over its text helpers through init.
import { global } from "./global.js";
import { config } from "./config.js";
import { gameSound } from "./sound.js";

let A = null;
export function init(helpers) { A = helpers; }

const TAU = Math.PI * 2;
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const lite = () => !!config.graphical.fewerEffects;
const glowOn = () => !config.graphical.noGlow && !global.lowFx;
// software WebGL (the terrain renderer found no GPU): the 2D canvas is almost
// always software too, and every full-screen fill there costs ~2 ms
const softGpu = () => { const tr = window.terrainRenderer; return !!(tr && tr._rockQuality != null && tr._rockQuality < 1); };

// wind: the clouds and the rain lean this way (world units per second)
const WIND_ANG = -0.42;
const WIND_X = Math.cos(WIND_ANG), WIND_Y = Math.sin(WIND_ANG);

// small stable hash, 0..1
function hash(i, k) {
    const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return v - Math.floor(v);
}

// ── baked pieces ───────────────────────────────────────────────────────
const TILE = 512;
const SKY = "rgba(30, 20, 66, 0.56)";
let cloudFar = null, cloudNear = null;
// Flat cloud shapes: each cloud is a union of circles filled once (no
// darker overlaps), a shadow tone under a body tone under a highlight. The
// tile wraps, so every circle is also drawn on the far side of any edge it
// crosses.
function bakeClouds(seed, count, rMin, rMax, tones, sky) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = TILE;
    const g = cv.getContext("2d");
    // the far layer carries the sky tint too ("over" is associative, so
    // this looks the same as a flat fill under the clouds and saves a fill)
    if (sky) { g.fillStyle = sky; g.fillRect(0, 0, TILE, TILE); }
    if ("filter" in g) g.filter = "blur(3px)";
    const clouds = [];
    for (let i = 0; i < count; i++) {
        const x = hash(seed + i, 1) * TILE, y = hash(seed + i, 2) * TILE;
        const n = 3 + Math.floor(hash(seed + i, 3) * 4);
        const base = rMin + (rMax - rMin) * hash(seed + i, 4);
        const puffs = [];
        for (let j = 0; j < n; j++) {
            const t = n > 1 ? j / (n - 1) - 0.5 : 0;
            puffs.push({
                x: x + t * base * 2.4 + (hash(seed + i, 10 + j) - 0.5) * base * 0.5,
                y: y + (hash(seed + i, 20 + j) - 0.5) * base * 0.7,
                r: base * (0.55 + 0.5 * hash(seed + i, 30 + j)) * (1 - Math.abs(t) * 0.6),
            });
        }
        clouds.push(puffs);
    }
    for (const tone of tones) {
        g.fillStyle = tone.col;
        for (const puffs of clouds) {
            g.beginPath();
            for (const p of puffs) {
                const r = p.r * tone.scale;
                for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
                    const x = p.x + tone.dx + ox * TILE, y = p.y + tone.dy + oy * TILE;
                    if (x + r < 0 || x - r > TILE || y + r < 0 || y - r > TILE) continue;
                    g.moveTo(x + r, y);
                    g.arc(x, y, r, 0, TAU);
                }
            }
            g.fill("nonzero");
        }
    }
    return cv;
}
function ensureClouds() {
    if (cloudFar) return;
    cloudFar = bakeClouds(11, 9, 38, 72, [
        { col: "rgba(8, 5, 22, 0.42)", scale: 1, dx: 10, dy: 14 },
        { col: "rgba(78, 66, 150, 0.30)", scale: 1, dx: 0, dy: 0 },
        { col: "rgba(150, 138, 225, 0.16)", scale: 0.62, dx: -6, dy: -8 },
    ], SKY);
    cloudNear = bakeClouds(57, 7, 22, 44, [
        { col: "rgba(10, 6, 26, 0.30)", scale: 1, dx: 7, dy: 10 },
        { col: "rgba(120, 110, 205, 0.22)", scale: 1, dx: 0, dy: 0 },
    ]);
}
// A scaled pattern fill is the slow path on a software canvas (about 4x an
// unscaled one), so each layer is re-baked at its on-screen size and drawn
// 1:1. Sizes snap to 6% steps, so a zoom change re-bakes rarely (one
// drawImage) and the clouds end up at most 3% off their world size.
const layerCv = [null, null], layerPat = [null, null], layerSize = [0, 0], layerCtx = [null, null];
function layerPattern(c, L, wantPx) {
    const k = Math.round(Math.log(Math.max(32, Math.min(2048, wantPx))) / Math.log(1.06));
    const size = Math.round(Math.pow(1.06, k));
    if (layerSize[L] !== size || !layerPat[L] || layerCtx[L] !== c) {
        const cv = layerCv[L] || (layerCv[L] = document.createElement("canvas"));
        if (layerSize[L] !== size) {
            cv.width = cv.height = size;
            const g = cv.getContext("2d");
            g.clearRect(0, 0, size, size);
            g.drawImage(L ? cloudNear : cloudFar, 0, 0, size, size);
            layerSize[L] = size;
        }
        layerPat[L] = c.createPattern(cv, "repeat");
        layerCtx[L] = c;
    }
    return layerPat[L];
}
let flashSpr = null;
function ensureFlash() {
    if (flashSpr) return flashSpr;
    const S = 128;
    flashSpr = document.createElement("canvas");
    flashSpr.width = flashSpr.height = S;
    const g = flashSpr.getContext("2d");
    const gd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gd.addColorStop(0, "rgba(235, 228, 255, 0.9)");
    gd.addColorStop(0.35, "rgba(170, 150, 255, 0.35)");
    gd.addColorStop(1, "rgba(120, 90, 255, 0)");
    g.fillStyle = gd;
    g.fillRect(0, 0, S, S);
    return flashSpr;
}
// In the storm the screen gets a purple wash and the pulsing edge. Drawn as
// two full-screen layers that was two passes over every pixel of the HUD
// canvas, every frame. Both are smooth, so they're composed into one tiny
// canvas (only when their strengths move) and stretched over the screen in
// a single pass. Same blend, same look.
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
        gd.addColorStop(0, "rgba(96, 60, 210, 0)");
        gd.addColorStop(0.55, "rgba(96, 60, 210, 0.35)");
        gd.addColorStop(1, "rgba(70, 30, 170, 1)");
        g.fillStyle = gd;
        g.fillRect(0, 0, OV_W, h);
    }
    const t = Math.round(tintA * 96), e = Math.round(edgeA * 96);
    if (t !== ov.t || e !== ov.e) {
        ov.t = t; ov.e = e;
        const g = ov.cv.getContext("2d");
        g.clearRect(0, 0, OV_W, h);
        if (t > 0) { g.globalAlpha = t / 96; g.fillStyle = "#4a2a9c"; g.fillRect(0, 0, OV_W, h); }
        if (e > 0) { g.globalAlpha = e / 96; g.drawImage(ov.edge, 0, 0); }
        g.globalAlpha = 1;
    }
    return ov.cv;
}

// ── moving parts (preallocated) ────────────────────────────────────────
const RAIN_N = 70;
const rainX = new Float32Array(RAIN_N), rainY = new Float32Array(RAIN_N), rainL = new Float32Array(RAIN_N), rainV = new Float32Array(RAIN_N);
for (let i = 0; i < RAIN_N; i++) {
    rainX[i] = hash(i, 91); rainY[i] = hash(i, 92);
    rainL[i] = 10 + 14 * hash(i, 93); rainV[i] = 0.8 + 0.4 * hash(i, 94);
}
// the downpour you're standing in (drawn over the whole screen while you're
// in the storm): more, longer and brighter drops than the world rain
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
    c.strokeStyle = "#cfd4ff";
    c.lineWidth = 1.6;
    c.lineCap = "butt";        // round caps on 150 drops only added geometry
    c.stroke();
    c.globalAlpha = 1;
}

// one bolt at a time, points in world units
const BOLT_MAX = 26;
const bolt = { on: false, at: 0, life: 260, pts: new Float32Array(BOLT_MAX * 2), n: 0, br: 0, brN: 0, mx: 0, my: 0, size: 0 };
let nextBoltAt = 0, forceBolt = false;
let rimRot = 0, lastT = 0;

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
        // a short fork off the middle
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
// brightness over the bolt's short life: a flicker (two peaks), then gone
function boltEnv(age) {
    if (age < 0 || age > bolt.life) return 0;
    if (age < 50) return 1;
    if (age < 90) return 0.35;
    if (age < 140) return 0.9;
    return 0.9 * (1 - (age - 140) / (bolt.life - 140));
}

// Visible part of the rim: [a0, a1] in radians, or a full turn when the
// circle's centre is close to the screen.
let visA0 = 0, visA1 = TAU;
function visibleArc(cx, cy, rr, sw, sh) {
    const scx = sw / 2, scy = sh / 2;
    const d = Math.hypot(scx - cx, scy - cy), hd = Math.hypot(sw, sh) / 2 + 40;
    if (d <= hd * 1.05) { visA0 = 0; visA1 = TAU; return; }
    const ac = Math.atan2(scy - cy, scx - cx), span = Math.asin(Math.min(1, hd / d)) + 0.02;
    visA0 = ac - span; visA1 = ac + span;
}

// ── world layer ───────────────────────────────────────────────────────
// (cx, cy, rr): the safe circle on screen; (ox, oy): world (0, 0) on screen.
export function drawWorld(c, cx, cy, rr, ox, oy, ratio, sw, sh) {
    const now = performance.now();
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
    lastT = now;
    // nothing to draw when the whole screen is inside the circle
    const fx = Math.max(Math.abs(cx), Math.abs(sw - cx)), fy = Math.max(Math.abs(cy), Math.abs(sh - cy));
    if (fx * fx + fy * fy < rr * rr) { bolt.on = false; return; }
    const still = calm();
    const t = still ? 0 : now / 1000;
    ensureClouds();

    c.save();
    c.beginPath();
    c.rect(-40, -40, sw + 80, sh + 80);
    c.arc(cx, cy, rr, 0, TAU, true);
    c.clip("evenodd");
    // the sky and its clouds: two layers, the near one a little faster and
    // with a little parallax, both blowing with the wind. Anchored to the
    // world so they don't swim when the camera moves.
    // When the storm fills most of the screen (you're out in it, or the
    // final circle is small) every layer is a full-screen fill, so the near
    // layer goes; it was the difference between smooth and choppy there.
    const heavy = warn.inside || rr < Math.hypot(sw, sh) * 0.35;
    const layers = heavy || lite() || global.lowFx || config.graphical.simpleTerrain || softGpu() ? 1 : 2;
    for (let L = 0; L < layers; L++) {
        const worldTile = L ? 900 : 1500;      // world units per tile
        const par = L ? 1.12 : 1;
        const speed = L ? 34 : 20;
        const pat = layerPattern(c, L, worldTile * ratio * par);
        const tilePx = layerSize[L];
        let px = ((sw / 2 - (sw / 2 - ox) * par) + WIND_X * speed * t * ratio) % tilePx;
        let py = ((sh / 2 - (sh / 2 - oy) * par) + WIND_Y * speed * t * ratio) % tilePx;
        if (px > 0) px -= tilePx;
        if (py > 0) py -= tilePx;
        // whole pixels: a fractional offset is a resampled (slow) fill too
        px = Math.round(px); py = Math.round(py);
        c.translate(px, py);
        c.fillStyle = pat;
        c.fillRect(-40 - px, -40 - py, sw + 80, sh + 80);
        c.translate(-px, -py);
    }
    // rain streaks, leaning with the wind (out in the storm drawHud's
    // downpour covers the whole screen, so this one sits out)
    if (!still && !warn.inside) {
        const n = lite() ? RAIN_N >> 1 : RAIN_N;
        const W = sw + 60, H = sh + 60;
        const vx = WIND_X * 0.55 + 0.25, vy = 1;
        c.beginPath();
        for (let i = 0; i < n; i++) {
            const sp = 780 * rainV[i];
            let x = (rainX[i] * W + t * sp * vx) % W - 30;
            let y = (rainY[i] * H + t * sp * vy) % H - 30;
            const l = rainL[i];
            c.moveTo(x, y);
            c.lineTo(x - vx * l, y - vy * l);
        }
        c.strokeStyle = "rgba(196, 204, 255, 0.22)";
        c.lineWidth = 1.3;
        c.lineCap = "round";
        c.stroke();
    }
    // lightning: small bolts in the storm, never more than one every ~2 s
    if (!still) {
        if (!bolt.on && (forceBolt || now >= nextBoltAt)) {
            if (nextBoltAt && !forceBolt) {
                // pick a spot on screen well out in the storm
                for (let tries = 0; tries < 8; tries++) {
                    const sx = sw * (0.08 + 0.84 * Math.random()), sy = sh * (0.08 + 0.84 * Math.random());
                    const dx = sx - cx, dy = sy - cy;
                    const m = rr + 90;
                    if (dx * dx + dy * dy < m * m) continue;
                    // not on top of your own tank
                    if (Math.abs(sx - sw / 2) < 110 && Math.abs(sy - sh / 2) < 110) continue;
                    makeBolt((sx - ox) / ratio, (sy - oy) / ratio, (140 + 120 * Math.random()), now);
                    break;
                }
            } else if (forceBolt) {
                let sx = sw * 0.5, sy = sh * 0.5;
                for (let tries = 0; tries < 40; tries++) {
                    sx = sw * (0.1 + 0.8 * Math.random()); sy = sh * (0.1 + 0.8 * Math.random());
                    const dx = sx - cx, dy = sy - cy;
                    if (dx * dx + dy * dy > (rr + 90) * (rr + 90) && (Math.abs(sx - sw / 2) > 110 || Math.abs(sy - sh / 2) > 110)) break;
                }
                makeBolt((sx - ox) / ratio, (sy - oy) / ratio, 220, now);
            }
            forceBolt = false;
            nextBoltAt = now + (lite() ? 5500 + 4500 * Math.random() : 2200 + 3000 * Math.random());
        }
        if (bolt.on) {
            const e = boltEnv(now - bolt.at);
            if (e <= 0 && now - bolt.at > bolt.life) bolt.on = false;
            else if (e > 0) drawBolt(c, ox, oy, ratio, e);
        }
    } else bolt.on = false;
    c.restore();

    drawRim(c, cx, cy, rr, ratio, sw, sh, still ? 0 : dt);
}

function boltPath(c, ox, oy, ratio, from, n) {
    const P = bolt.pts;
    for (let i = 0; i < n; i++) {
        const x = ox + P[(from + i) * 2] * ratio, y = oy + P[(from + i) * 2 + 1] * ratio;
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
}
function drawBolt(c, ox, oy, ratio, e) {
    const sx = ox + bolt.mx * ratio, sy = oy + bolt.my * ratio;
    if (glowOn()) {
        const R = bolt.size * ratio * 1.8;
        c.globalAlpha = 0.45 * e;
        c.drawImage(ensureFlash(), sx - R, sy - R, R * 2, R * 2);
    }
    c.globalAlpha = e;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.beginPath();
    boltPath(c, ox, oy, ratio, 0, bolt.n);
    if (bolt.brN) boltPath(c, ox, oy, ratio, bolt.br, bolt.brN);
    if (glowOn()) {
        c.strokeStyle = "rgba(160, 130, 255, 0.6)";
        c.lineWidth = Math.max(6, 10 * ratio);
        c.stroke();
    }
    c.strokeStyle = "#f4f0ff";
    c.lineWidth = Math.max(2, 3 * ratio);
    c.stroke();
    c.globalAlpha = 1;
}

// The edge: soft glow and blowing wisps on the storm side, then one crisp
// bright line exactly on the boundary.
const RIM_K = 512;
function drawRim(c, cx, cy, rr, ratio, sw, sh, dt) {
    if (rr < 1) return;
    visibleArc(cx, cy, rr, sw, sh);
    const full = visA1 - visA0 >= TAU - 1e-6;
    const rw = rr / Math.max(1e-6, ratio);    // radius in world units
    c.save();
    // the storm front: a darker band right behind the edge
    c.strokeStyle = "rgba(14, 8, 34, 0.32)";
    c.lineWidth = Math.max(16, 64 * ratio);
    c.beginPath();
    c.arc(cx, cy, rr + c.lineWidth / 2, visA0, visA1);
    c.stroke();
    if (glowOn()) {
        c.strokeStyle = "rgba(140, 105, 255, 0.2)";
        c.lineWidth = Math.max(10, 36 * ratio);
        c.beginPath();
        c.arc(cx, cy, rr + c.lineWidth / 2, visA0, visA1);
        c.stroke();
        c.strokeStyle = "rgba(185, 155, 255, 0.38)";
        c.lineWidth = Math.max(4, 10 * ratio);
        c.beginPath();
        c.arc(cx, cy, rr + c.lineWidth / 2, visA0, visA1);
        c.stroke();
    }
    // wisps: short arcs just outside the edge that drift around the circle
    // (about 16 world units a second). Fixed slots around the circle, thinned
    // by powers of two as it shrinks so the survivors never jump.
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
        c.strokeStyle = b === 0 ? "rgba(185, 160, 255, 0.4)" : b === 1 ? "rgba(200, 180, 255, 0.58)" : "rgba(226, 214, 255, 0.78)";
        c.lineWidth = Math.max(1.4, (b === 2 ? 2.8 : 4.2) * ratio);
        c.stroke();
    }
    // the line itself: dark underlay, bright core
    c.beginPath();
    c.arc(cx, cy, rr + 1, visA0, visA1);
    c.strokeStyle = "#140a26";
    c.lineWidth = Math.max(3, 5 * ratio);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, rr, visA0, visA1);
    c.strokeStyle = "#e4d8ff";
    c.lineWidth = Math.max(1.6, 2.4 * ratio);
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
export function drawMap(c, cx, cy, rr, x, y, w, h, toR, hl) {
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.arc(cx, cy, rr, 0, TAU, true);
    c.fillStyle = "rgba(46, 30, 104, 0.5)";
    c.fill("evenodd");
    // glow on the storm side, then the crisp edge
    c.beginPath();
    c.arc(cx, cy, rr + 2, 0, TAU);
    c.strokeStyle = "rgba(150, 120, 255, 0.45)";
    c.lineWidth = 3;
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, rr, 0, TAU);
    c.strokeStyle = "#e4d8ff";
    c.lineWidth = 1.6;
    c.stroke();
    // where it's closing to
    if (toR > 1 && toR < rr - 2) {
        c.beginPath();
        c.arc(cx, cy, toR, 0, TAU);
        c.setLineDash(DASH);
        c.strokeStyle = "rgba(255, 255, 255, 0.7)";
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
export function drawHud(c, sw, sh, topY, st) {
    const now = performance.now();
    if (!st.inside) {
        warn.inside = false;
        warn.level += (0 - warn.level) * 0.15;
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
            c.fillStyle = "#4a2a9c";
            c.fillRect(0, 0, sw, sh);
        }
        const b = 8 + 14 * L;
        c.globalAlpha = va * 0.6;
        c.fillStyle = "#5a34c8";
        c.fillRect(0, 0, sw, b); c.fillRect(0, sh - b, sw, b);
        c.fillRect(0, b, b, sh - 2 * b); c.fillRect(sw - b, b, b, sh - 2 * b);
        c.globalAlpha = 1;
    }
    if (!still) drawPour(c, sw, sh, 0.42 * inA, now);
    // banner, popping in on entry (coach.js steps aside while it is up)
    global.stormBannerAt = now;
    const pop = still ? 1 : Math.min(1, age / 220);
    // one compact line in the row app.js keeps for it under the raid clock
    // (away from your tank, its chat and the slams): what's happening and
    // how far the safe zone is
    const col = st.immune ? "#9fd0ff" : L > 0.7 ? "#ffb0c8" : "#efe6ff";
    const d = Math.max(0, Math.round(st.dist / 10) * 10);
    if (d !== warn.distN) { warn.distN = d; warn.distTxt = "safe zone " + A.fmtDist(d) + " away"; }
    const head = st.immune ? "Storm Anchor " + st.immune + "s" : st.final ? "Final storm. Get out!" : "In the storm. Get out!";
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
}

// QA hooks (headless runs)
window.dwStormFx = () => ({ bolt: bolt.on, level: Math.round(warn.level * 100) / 100, inside: warn.inside, next: Math.round(nextBoltAt - performance.now()) });
window.dwStormBolt = () => { forceBolt = true; return true; };
