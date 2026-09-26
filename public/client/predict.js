// Client-side prediction for the local tank's own movement.
//
// The server is authoritative and sends our position ~30 times a second, but
// by the time a snapshot arrives it is a full round trip old: at 190 ms ping a
// key press used to take ~200+ ms to move the tank on screen. This module runs
// the server's own movement integration locally, every server tick, from the
// keys held right now, so the tank answers the next frame. Snapshots then
// reconcile it: each one is compared with where we predicted the server would
// be when it produced that snapshot (a short history of predicted states), the
// difference is folded back into the prediction, and the visible position eases
// over it instead of jumping. A big difference (teleport, respawn, resume) snaps.
//
// Mirrors (keep in step with the server):
//   - motion 'motor' in server/loaders/global.js runMove: engine = acceleration
//     toward (right-left, down-up), damp = accel / topSpeed
//   - Entity.physics / Entity.friction in server/game/entities/entity.js, in the
//     order gameloop runs them (physics, then life/selfie, then friction)
//   - the rock push (TerrainGrid.pushCircleFromVoronoi) plus the inward-velocity
//     cut that server/game/index.js applies after it
// Everything else (other tanks, pads, recoil, knockback, room edge) is left to
// the reconciliation.
//
// Kill switch: localStorage dwNoPredict = "1" (also the "Movement prediction"
// checkbox under Settings > Network).
import { global } from "./global.js";
import { config } from "./config.js";

const TAU_MS = 70;          // visual ease for corrections (~95% gone in 200 ms)
const SNAP_DIST = 300;      // world units: past this it is a teleport, not an error
const HIST_MS = 2500;       // predicted-state history kept for reconciliation
const OFF_WINDOW_MS = 4000; // window for the arrival-offset floor

const P = {
    on: false,
    x: 0, y: 0, vx: 0, vy: 0,   // state after the last simulated tick (post friction, post push)
    t: 0,                       // local time (performance.now) of the last simulated tick
    hist: [],                   // { t, x, y, vx, vy }: position/velocity right after physics (the server's photo point)
    visX: 0, visY: 0,           // display offset that eases corrections out
    lastFrame: 0,
    accel: 0, topSpeed: 0, r: 0,
    offs: [],                   // [arrivalLocal, arrivalLocal - serverStamp]
    lagC: 33,                   // ms from "input sampled here" to "server photo reflects it", minus one-way uplink
    bodyId: -1,
};

const stats = {
    snapshots: 0, corrections: 0, snaps: 0, sumErr: 0, maxErr: 0, lastErr: 0,
    resets: 0, lastTc: 0, rtt: 0, frames: 0, frameMs: 0,
};

let killCache = { at: 0, off: false };
function killed() {
    const now = performance.now();
    if (now - killCache.at > 500) {
        killCache.at = now;
        try { killCache.off = localStorage.getItem("dwNoPredict") === "1"; } catch (e) { killCache.off = false; }
    }
    return killCache.off;
}

function tickMs() { return 1000 / 30 / (config.roomSpeed || 1); }

function rttLow() {
    const l = global.metrics && global.metrics.latency;
    if (!l || !l.length) return 0;
    let m = Infinity;
    for (const v of l) if (v > 0 && v < m) m = v;
    return isFinite(m) ? m : 0;
}

function canPredict() {
    if (killed()) return false;
    if (!global.gameStart || global.died || global.disconnected) return false;
    if (global.royaleSpectating || global._specGlide) return false;
    if (global.player && global.player.isScoping) return false;
    if (!(P.accel > 0) || !(P.topSpeed > 0)) return false;
    if (!global.socket || !global.socket.cmd || !global.socket.cmd.getMotion) return false;
    return true;
}

function engine() {
    const m = global.socket.cmd.getMotion();
    const gx = +m.x || 0, gy = +m.y || 0;
    if (!gx && !gy) return [0, 0];
    const a = P.accel / (config.roomSpeed || 1);
    const len = Math.sqrt(gx * gx + gy * gy);
    return [a * gx / len, a * gy / len];
}

function dampFactor() {
    // motor: maxSpeed 0, damp = a / topSpeed, friction divides by (1 + damp / roomSpeed)
    const rs = config.roomSpeed || 1;
    const a = P.accel / rs;
    return 1 / (1 + (a / P.topSpeed) / rs);
}

// ---- rock collision: the client copy of pushCircleFromVoronoi ------------
// Segments are rebuilt from the renderer's lattice polygons with the exact
// server math (world = lattice * rockSz * cellSize - half), cached per cell.
let segCache = new Map(), segLattice = null, segTick = 0;
function cellSegs(tr, L, key, rockSz, w) {
    let segs = segCache.get(key);
    if (segs) return segs;
    segs = [];
    const poly = L.poly;
    const wsx = L.sx * rockSz * w.s - w.hw, wsy = L.sy * rockSz * w.s - w.hh;
    for (let e = 0; e < poly.length; e++) {
        const [vax, vay] = poly[e], [vbx, vby] = poly[(e + 1) % poly.length];
        const wax = vax * rockSz * w.s - w.hw, way = vay * rockSz * w.s - w.hh;
        const wbx = vbx * rockSz * w.s - w.hw, wby = vby * rockSz * w.s - w.hh;
        const edx = wbx - wax, edy = wby - way, len = Math.hypot(edx, edy);
        if (len < 1e-6) continue;
        const ux = edx / len, uy = edy / len;
        let nx = -uy, ny = ux;
        const mx = (wax + wbx) * 0.5, my = (way + wby) * 0.5;
        if ((wsx - mx) * nx + (wsy - my) * ny > 0) { nx = -nx; ny = -ny; }
        segs.push({ ax: wax, ay: way, edx: ux, edy: uy, nx, ny, len, _t: 0 });
    }
    segCache.set(key, segs);
    return segs;
}
function pushFromRocks(pos, r) {
    const tr = window.terrainRenderer;
    if (!tr || !tr.ready || !tr._voroLattice || !tr._world || !tr._cols || !(r > 0)) return false;
    if (segLattice !== tr._voroLattice) { segLattice = tr._voroLattice; segCache = new Map(); }
    const lattice = tr._voroLattice, dead = tr._rockDead, w = tr._world;
    const rockSz = Math.min(tr._cols, 120) / 50.0;
    const cellW = rockSz * w.s;
    if (!(cellW > 0)) return false;
    const tick = ++segTick;
    const R = Math.ceil(r / cellW) + 2;
    let movedAny = false;
    for (let pass = 0; pass < 3; pass++) {
        const ci = Math.floor((pos.x + w.hw) / cellW), cj = Math.floor((pos.y + w.hh) / cellW);
        let moved = false;
        for (let vi = ci - R; vi <= ci + R; vi++) {
            for (let vj = cj - R; vj <= cj + R; vj++) {
                const key = vi * 100003 + vj;
                if (dead.has(key)) continue;
                const L = lattice.get(key);
                if (!L) continue;
                const segs = cellSegs(tr, L, key, rockSz, w);
                for (const seg of segs) {
                    if (seg._t === tick) continue;
                    seg._t = tick;
                    const dax = pos.x - seg.ax, day = pos.y - seg.ay;
                    const t = Math.max(0, Math.min(seg.len, dax * seg.edx + day * seg.edy));
                    const dx = pos.x - (seg.ax + t * seg.edx), dy = pos.y - (seg.ay + t * seg.edy);
                    const d2 = dx * dx + dy * dy;
                    if (d2 >= r * r) continue;
                    const dist = Math.sqrt(d2);
                    let pnx, pny;
                    if (dist < 1e-6) { pnx = seg.nx; pny = seg.ny; }
                    else {
                        pnx = dx / dist; pny = dy / dist;
                        if (pnx * seg.nx + pny * seg.ny < 0) { pnx = -pnx; pny = -pny; }
                    }
                    pos.x += pnx * (r - dist); pos.y += pny * (r - dist);
                    moved = movedAny = true;
                }
            }
        }
        if (!moved) break;
    }
    return movedAny;
}

// ---- simulation -----------------------------------------------------------
const _pos = { x: 0, y: 0 };
function step(t) {
    const rs = config.roomSpeed || 1;
    const [ex, ey] = engine();
    // physics: velocity += accel (the engine), position += velocity
    P.vx += ex; P.vy += ey;
    P.x += P.vx / rs; P.y += P.vy / rs;
    // the server's photo is taken here (life -> takeSelfie), before friction and the rock push
    P.hist.push({ t, x: P.x, y: P.y, vx: P.vx, vy: P.vy });
    // friction
    const d = dampFactor();
    P.vx *= d; P.vy *= d;
    // rock push, then drop the velocity going into the wall
    _pos.x = P.x; _pos.y = P.y;
    if (pushFromRocks(_pos, P.r)) {
        const dx = _pos.x - P.x, dy = _pos.y - P.y, len = Math.hypot(dx, dy);
        P.x = _pos.x; P.y = _pos.y;
        if (len > 0) {
            const nx = dx / len, ny = dy / len, vd = P.vx * nx + P.vy * ny;
            if (vd < 0) { P.vx -= vd * nx; P.vy -= vd * ny; }
        }
    }
}

function histAt(tc) {
    const h = P.hist;
    if (!h.length) return null;
    if (tc <= h[0].t) return h[0];
    const last = h[h.length - 1];
    if (tc >= last.t) {
        // the snapshot is newer than our newest tick: carry the last state
        // forward instead of clamping (clamping would count that step twice)
        const f = Math.min(1.5, (tc - last.t) / tickMs());
        const d = dampFactor();
        return { t: tc, x: last.x + last.vx * d * f, y: last.y + last.vy * d * f, vx: last.vx, vy: last.vy };
    }
    let i = h.length - 1;
    while (i > 0 && h[i - 1].t > tc) i--;
    const a = h[i - 1], b = h[i], f = (tc - a.t) / (b.t - a.t || 1);
    return { t: tc, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
             vx: a.vx + (b.vx - a.vx) * f, vy: a.vy + (b.vy - a.vy) * f };
}

function reset(why) {
    if (P.on) stats.resets++;
    P.on = false;
    P.hist.length = 0;
    P.visX = P.visY = 0;
    global.player.predOn = false;
    P.why = why || "";
}

function init(x, y, vx, vy, now) {
    P.on = true;
    P.x = x; P.y = y;
    const d = dampFactor();
    P.vx = (+vx || 0) * d; P.vy = (+vy || 0) * d;
    P.t = now;
    P.hist.length = 0;
    P.hist.push({ t: now, x, y, vx: +vx || 0, vy: +vy || 0 });
    P.visX = P.visY = 0;
    P.lastFrame = now;
}

// Called for every fresh 'u' snapshot, after the gui/entities are decoded.
function onSnapshot(serverTime, sx, sy, svx, svy, accel, topSpeed, bodyId, realSize) {
    const now = performance.now();
    P.accel = +accel || 0;
    P.topSpeed = +topSpeed || 0;
    if (realSize > 0) P.r = realSize;
    // arrival-offset floor: server stamp -> local arrival with the least delay
    const off = now - serverTime;
    P.offs.push([now, off]);
    while (P.offs.length && now - P.offs[0][0] > OFF_WINDOW_MS) P.offs.shift();
    if (!canPredict() || !(bodyId >= 0)) { if (P.on) reset("inactive"); return; }
    if (!isFinite(sx) || !isFinite(sy)) return;
    if (!P.on || bodyId !== P.bodyId || now - P.t > 600) {
        P.bodyId = bodyId;
        init(sx, sy, svx, svy, now);
        return;
    }
    stats.snapshots++;
    let offMin = Infinity;
    for (const o of P.offs) if (o[1] < offMin) offMin = o[1];
    const rtt = rttLow();
    stats.rtt = rtt;
    // Local time at which the input now reflected in this snapshot was sampled:
    // snapshot's (least-delayed) arrival, minus the round trip, minus the
    // server's own input-to-photo delay.
    const tc = serverTime + offMin - rtt - P.lagC;
    stats.lastTc = now - tc;
    const h = histAt(tc);
    if (!h) return;
    const ex = sx - h.x, ey = sy - h.y;
    const evx = (+svx || 0) - h.vx, evy = (+svy || 0) - h.vy;
    const err = Math.hypot(ex, ey);
    stats.lastErr = err;
    stats.sumErr += err;
    if (P.debugLog) P.debugLog.push([now, serverTime, sx, sy, h.x, h.y, +svx || 0, h.vx, P.x, P.lagC, rtt, offMin]);
    if (err > stats.maxErr) stats.maxErr = err;

    // Slowly learn the input-to-photo delay: when the prediction is off
    // while moving, check whether a slightly earlier/later match fits better.
    if (err > 1 && err < SNAP_DIST && Math.hypot(h.vx, h.vy) > 0.5) {
        const hm = histAt(tc - 6), hp = histAt(tc + 6);
        const em = Math.hypot(sx - hm.x, sy - hm.y), ep = Math.hypot(sx - hp.x, sy - hp.y);
        if (em < err && em < ep) P.lagC = Math.min(160, P.lagC + 0.5);
        else if (ep < err && ep < em) P.lagC = Math.max(-40, P.lagC - 0.5);
    }

    if (err < 0.02 && Math.hypot(evx, evy) < 0.005) return;
    stats.corrections++;
    // Fold the error in at time tc and carry it forward through the linear
    // motion model: a velocity error keeps adding position (decaying by the
    // friction factor each tick) up to now.
    const d = dampFactor(), T = tickMs();
    const geo = (m) => (d < 1 ? d * (1 - Math.pow(d, m)) / (1 - d) : m);
    let lastDx = ex, lastDy = ey, lastDvx = evx, lastDvy = evy;
    for (const e of P.hist) {
        if (e.t <= tc) { e.x += ex; e.y += ey; e.vx += evx; e.vy += evy; continue; }
        const m = (e.t - tc) / T, g = geo(m), dm = Math.pow(d, m);
        lastDx = ex + evx * g; lastDy = ey + evy * g;
        lastDvx = evx * dm; lastDvy = evy * dm;
        e.x += lastDx; e.y += lastDy; e.vx += lastDvx; e.vy += lastDvy;
    }
    P.x += lastDx; P.y += lastDy;
    P.vx += lastDvx * d; P.vy += lastDvy * d;
    if (err > SNAP_DIST) {
        stats.snaps++;
        P.visX = P.visY = 0;
    } else {
        P.visX -= lastDx; P.visY -= lastDy;
    }
}

// Called once per rendered frame. Returns the predicted world position of the
// local tank (and sets global.player.predX/predY/predOn), or null when the
// server-driven camera should be used.
const _rpos = { x: 0, y: 0 }, _out = { x: 0, y: 0 };
function frame(now) {
    if (!P.on) { global.player.predOn = false; return null; }
    if (!canPredict()) { reset("inactive"); return null; }
    const t0 = performance.now();
    const T = tickMs();
    if (now - P.t > 600) { reset("stall"); return null; }
    while (now - P.t >= T) { P.t += T; step(P.t); }
    // trim history
    const h = P.hist;
    while (h.length > 2 && P.t - h[0].t > HIST_MS) h.shift();
    // sub-tick: where the next physics step will put us, with the keys held now
    const rs = config.roomSpeed || 1;
    const [ex, ey] = engine();
    const alpha = Math.max(0, Math.min(1, (now - P.t) / T));
    _rpos.x = P.x + alpha * (P.vx + ex) / rs;
    _rpos.y = P.y + alpha * (P.vy + ey) / rs;
    pushFromRocks(_rpos, P.r);
    const dt = Math.max(0, Math.min(250, now - (P.lastFrame || now)));
    P.lastFrame = now;
    const k = Math.exp(-dt / TAU_MS);
    P.visX *= k; P.visY *= k;
    if (Math.abs(P.visX) < 0.01) P.visX = 0;
    if (Math.abs(P.visY) < 0.01) P.visY = 0;
    const x = _rpos.x + P.visX, y = _rpos.y + P.visY;
    global.player.predOn = true;
    global.player.predX = x;
    global.player.predY = y;
    stats.frames++;
    stats.frameMs += performance.now() - t0;
    _out.x = x; _out.y = y;
    return _out;
}

// "Movement prediction" toggle next to the other network option.
function injectSetting() {
    try {
        if (document.getElementById("optMovePredict")) return;
        const anchor = document.getElementById("optPredictive");
        const box = anchor && anchor.closest(".sp-checks");
        if (!box) return;
        const label = document.createElement("label");
        label.className = "container";
        label.innerHTML = '<input id="optMovePredict" tabindex="-1" class="checkbox" type="checkbox"><span class="checkmark"></span>Movement Prediction';
        box.appendChild(label);
        const input = label.querySelector("input");
        input.checked = !killed();
        input.addEventListener("change", () => {
            try { localStorage.setItem("dwNoPredict", input.checked ? "0" : "1"); } catch (e) { /* */ }
            killCache.at = 0;
        });
    } catch (e) { /* */ }
}
if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectSetting);
    else injectSetting();
}

const predictor = { onSnapshot, frame, reset, state: P, stats, pushFromRocks };
if (typeof window !== "undefined") window.dwPredict = predictor;
export { predictor };
