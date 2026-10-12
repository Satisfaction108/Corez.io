const CFG = {
    on: true,
    extrapMs: 100,
    tauMs: 70,
    snapDist: 420,
    cutDist: 300,
    jitterGain: 0.6,
    maxDelay: 0,
    histMax: 12,
    rate: 0.12,
    ownDelayTicks: 0,
};

const S = {
    tick: 1000 / 30,
    lastStamp: 0,
    buckets: [],
    offMin: null,
    jit: 0,
    delay: 0,
    ownDelay: 0,
    R: null,
    Rown: null,
    lastNow: 0,
    frameNow: 0,
    snapshots: 0,
};

const stats = { extrap: 0, hold: 0, eased: 0, snapped: 0, cuts: 0, clockSnaps: 0, frames: 0, late: 0 };

function killed() {
    try { return typeof localStorage !== "undefined" && localStorage.getItem("dwNetSmooth") === "0"; } catch (e) { return false; }
}
let killAt = -1e9, killOff = false;
function active(now) {
    if (now - killAt > 1000) { killAt = now; killOff = killed(); }
    return CFG.on && !killOff;
}

function onSnapshot(stamp, now) {
    if (!isFinite(stamp) || !isFinite(now)) return;
    if (S.lastStamp) {
        const gap = stamp - S.lastStamp;
        if (gap > 5 && gap < 120) S.tick += (Math.min(gap, S.tick * 1.6) - S.tick) * 0.02;
    }
    S.lastStamp = stamp;
    S.snapshots++;
    const off = now - stamp;
    const b = Math.floor(now / 500);
    const bk = S.buckets;
    if (!bk.length || bk[bk.length - 1].b !== b) {
        bk.push({ b, v: off });
        while (bk.length && bk[0].b < b - 7) bk.shift();
    } else if (off < bk[bk.length - 1].v) bk[bk.length - 1].v = off;
    let m = Infinity;
    for (let i = 0; i < bk.length; i++) if (bk[i].v < m) m = bk[i].v;
    if (S.offMin === null || m < S.offMin || Math.abs(m - S.offMin) > 0.5) S.offMin = m;
    const late = Math.min(Math.max(0, off - S.offMin), S.tick * 4);
    if (late > S.tick) stats.late++;
    S.jit += (late - S.jit) * (late > S.jit ? 0.25 : 0.015);
    S.delay = Math.min(CFG.maxDelay, S.jit * CFG.jitterGain);
    S.ownDelay = Math.min(S.delay, S.tick * CFG.ownDelayTicks);
}

function stepClock(cur, target, dt) {
    if (cur === null || !isFinite(cur) || Math.abs(target - cur) > 400) { stats.clockSnaps++; return target; }
    cur += dt;
    const err = target - cur;
    const lim = dt * CFG.rate;
    cur += Math.max(-lim, Math.min(lim, err * 0.1));
    return cur;
}

function frame(now) {
    S.frameNow = now;
    if (S.offMin === null) return;
    const dt = S.lastNow ? Math.min(250, Math.max(0, now - S.lastNow)) : 0;
    S.lastNow = now;
    S.R = stepClock(S.R, now - S.offMin - S.delay, dt);
    S.Rown = stepClock(S.Rown, now - S.offMin - S.ownDelay, dt);
    stats.frames++;
}

function track() {
    return { h: [], ex: 0, ey: 0, px: NaN, py: NaN, pvx: 0, pvy: 0, pt: 0, cut: true, x: 0, y: 0, f: 0 };
}

function push(tr, stamp, x, y, f) {
    if (!tr || !isFinite(x) || !isFinite(y)) return;
    const h = tr.h;
    const last = h.length ? h[h.length - 1] : null;
    if (last && stamp <= last[0]) {
        last[1] = x; last[2] = y; last[3] = f;
        return;
    }
    if (last && Math.hypot(x - last[1], y - last[2]) > CFG.cutDist * Math.max(1, (stamp - last[0]) / S.tick / 3)) {
        h.length = 0;
        tr.cut = true;
        stats.cuts++;
    }
    if (h.length >= CFG.histMax) {
        const r = h.shift();
        r[0] = stamp; r[1] = x; r[2] = y; r[3] = f;
        h.push(r);
    } else h.push([stamp, x, y, f]);
}

function angLerp(a, b, t) {
    let d = b - a;
    d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return a + d * t;
}

const _s = { x: 0, y: 0, f: 0, vx: 0, vy: 0 };
function sample(tr, R) {
    const h = tr.h, n = h.length;
    const out = _s;
    if (!n) return null;
    const last = h[n - 1];
    if (n === 1 || R >= last[0]) {
        let vx = 0, vy = 0;
        if (n > 1) {
            const p = h[n - 2], dt = last[0] - p[0];
            if (dt > 0 && dt < 260) { vx = (last[1] - p[1]) / dt; vy = (last[2] - p[2]) / dt; }
        }
        const over = n > 1 ? Math.max(0, R - last[0]) : 0;
        const ahead = Math.min(over, CFG.extrapMs);
        if (over > CFG.extrapMs) stats.hold++; else if (over > 0) stats.extrap++;
        out.x = last[1] + vx * ahead;
        out.y = last[2] + vy * ahead;
        out.vx = over >= CFG.extrapMs ? 0 : vx;
        out.vy = over >= CFG.extrapMs ? 0 : vy;
        out.f = last[3];
        return out;
    }
    if (R <= h[0][0]) {
        out.x = h[0][1]; out.y = h[0][2]; out.f = h[0][3]; out.vx = 0; out.vy = 0;
        return out;
    }
    let i = n - 2;
    while (i > 0 && h[i][0] > R) i--;
    const a = h[i], b = h[i + 1], span = b[0] - a[0];
    const t = span > 0 ? (R - a[0]) / span : 1;
    out.x = a[1] + (b[1] - a[1]) * t;
    out.y = a[2] + (b[2] - a[2]) * t;
    out.f = angLerp(a[3], b[3], t);
    out.vx = span > 0 ? (b[1] - a[1]) / span : 0;
    out.vy = span > 0 ? (b[2] - a[2]) / span : 0;
    return out;
}

function resolve(tr, R, now) {
    const s = sample(tr, R);
    if (!s) return null;
    const dt = tr.pt ? Math.min(250, Math.max(0, now - tr.pt)) : 0;
    if (!tr.cut && isFinite(tr.px) && dt > 0) {
        const cx = tr.px + tr.pvx * dt, cy = tr.py + tr.pvy * dt;
        const dx = s.x - cx, dy = s.y - cy;
        const d = Math.hypot(dx, dy);
        if (d > CFG.snapDist) { tr.ex = 0; tr.ey = 0; stats.snapped++; }
        else if (d > 1.5) { tr.ex -= dx; tr.ey -= dy; stats.eased++; }
    } else if (tr.cut) { tr.ex = 0; tr.ey = 0; }
    tr.cut = false;
    if (dt > 0) {
        const k = Math.exp(-dt / (CFG.tauMs + Math.min(130, Math.hypot(tr.ex, tr.ey) * 0.6)));
        tr.ex *= k; tr.ey *= k;
        if (Math.abs(tr.ex) < 0.01) tr.ex = 0;
        if (Math.abs(tr.ey) < 0.01) tr.ey = 0;
    }
    tr.px = s.x; tr.py = s.y; tr.pvx = s.vx; tr.pvy = s.vy; tr.pt = now;
    tr.x = s.x + tr.ex; tr.y = s.y + tr.ey; tr.f = s.f;
    return tr;
}

function entity(tr, now) {
    if (!tr || S.R === null) return null;
    return resolve(tr, S.R, now);
}

const cam = track();
function camPush(stamp, x, y) { push(cam, stamp, x, y, 0); }
function camCut(x, y) {
    cam.h.length = 0;
    cam.h.push([S.lastStamp || 0, x, y, 0]);
    cam.cut = true;
}
function camera(now) {
    if (S.Rown === null || !cam.h.length) return null;
    return resolve(cam, S.Rown, now);
}

function camNow() {
    return cam.h.length && isFinite(cam.px) ? cam : null;
}

function reset() {
    S.buckets.length = 0;
    S.offMin = null;
    S.jit = 0;
    S.R = null;
    S.Rown = null;
    S.lastStamp = 0;
    S.lastNow = 0;
    cam.h.length = 0;
    cam.cut = true;
}

function snapshotStats() {
    return Object.assign({ delay: +S.delay.toFixed(1), ownDelay: +S.ownDelay.toFixed(1), jit: +S.jit.toFixed(1), tick: +S.tick.toFixed(2), snapshots: S.snapshots }, stats);
}

const netSmooth = { CFG, S, stats: snapshotStats, onSnapshot, frame, track, push, entity, camPush, camCut, camera, camNow, reset, active, sample };
if (typeof window !== "undefined") window.dwNetSmooth = netSmooth;
export { netSmooth };
