import { global } from "./global.js";
import { netSmooth } from "./netSmooth.js";

const SEQ_MOD = 1 << 24;

const CFG = {
    tauSmall: 60,
    tauBig: 45,
    bigErr: 64,
    cutDist: 400,
    failErr: 32,
    failMs: 500,
    ringMax: 150,
    catchUp: 2,
};

const P = {
    srv: null,
    sending: false,
    anchored: false,
    forced: false,
    failed: false,
    seq: 0,
    ring: [],
    nextAt: 0,
    pendingDash: false,
    accel: 0,
    top: 0,
    r: 0,
    damp: 0,
    ox: 0,
    oy: 0,
    rox: 0,
    roy: 0,
    release: false,
    lastOut: null,
    lastFrame: 0,
    lx: NaN,
    ly: NaN,
    badSince: 0,
    depth: 1,
    lastAckAt: 0,
    segs: null,
    segKey: null,
    segTick: 0,
    bounds: null,
    out: { x: 0, y: 0 },
    why: "",
};

const stats = {
    ticks: 0, snapshots: 0, corrections: 0, corrSum: 0, corrMax: 0, errN: 0, errSum: 0, errMax: 0,
    big: 0, cuts: 0, starved: 0, fallbacks: 0, forced: 0, resyncs: 0, starts: 0, stops: 0, noAck: 0, reanchors: 0, dashes: 0, lastErr: 0,
};

let killAt = -1e9, killOff = false;
function killed(now) {
    if (now - killAt > 1000) {
        killAt = now;
        try { killOff = typeof localStorage !== "undefined" && localStorage.getItem("dwPredict") === "0"; } catch (e) { killOff = false; }
    }
    return killOff;
}

function baseTick() {
    const t = netSmooth.S && netSmooth.S.tick;
    return t > 25 && t < 45 ? t : 1000 / 30;
}
function tickMs() {
    const dil = Math.max(-0.05, Math.min(0.05, 0.03 * (P.depth - 1)));
    return baseTick() * (1 + dil);
}

function seqDiff(a, b) {
    let d = (a - b) % SEQ_MOD;
    if (d < 0) d += SEQ_MOD;
    if (d > SEQ_MOD / 2) d -= SEQ_MOD;
    return d;
}

function unpackMove(n) {
    if (typeof n !== "number" || !(n > 0) || n > 65535 || n !== Math.floor(n)) return null;
    const qx = n >> 8, qy = n & 255;
    if (!qx || !qy) return null;
    let x = (qx - 1) / 127 - 1, y = (qy - 1) / 127 - 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    if (len < 0.05) return null;
    return { x, y };
}

function terrain() {
    const tr = typeof window !== "undefined" ? window.terrainRenderer : null;
    if (!tr || !tr.ready || !tr._voroLattice || !tr._world || !tr._cols || !(tr._world.s > 0)) return null;
    return tr;
}

function buildSegs(tr) {
    const L = tr._voroLattice;
    if (P.segKey === L && P.segs) return P.segs;
    const cols = tr._cols, rows = tr._rows;
    const cellSize = tr._world.s;
    const rockSz = Math.min(cols, 120) / 50.0;
    const halfW = cols * cellSize / 2, halfH = rows * cellSize / 2;
    const BUCKET = cellSize * 4;
    const vmap = new Map();
    let viLo = Infinity, viHi = -Infinity, vjLo = Infinity, vjHi = -Infinity;
    for (const [key, c] of L) {
        const vi = Math.round((key - (((key % 100003) + 100003) % 100003)) / 100003), vj = ((key % 100003) + 100003) % 100003;
        if (vi < viLo) viLo = vi; if (vi > viHi) viHi = vi;
        if (vj < vjLo) vjLo = vj; if (vj > vjHi) vjHi = vj;
        const poly = c.poly, sx = c.sx, sy = c.sy;
        const wsx = sx * rockSz * cellSize - halfW, wsy = sy * rockSz * cellSize - halfH;
        for (let e = 0; e < poly.length; e++) {
            const [vax, vay] = poly[e], [vbx, vby] = poly[(e + 1) % poly.length];
            const wax = vax * rockSz * cellSize - halfW, way = vay * rockSz * cellSize - halfH;
            const wbx = vbx * rockSz * cellSize - halfW, wby = vby * rockSz * cellSize - halfH;
            const edx = wbx - wax, edy = wby - way, len = Math.hypot(edx, edy);
            if (len < 1e-6) continue;
            const ux = edx / len, uy = edy / len;
            let nx = -uy, ny = ux;
            const mx = (wax + wbx) * 0.5, my = (way + wby) * 0.5;
            if ((wsx - mx) * nx + (wsy - my) * ny > 0) { nx = -nx; ny = -ny; }
            const seg = { ax: wax, ay: way, edx: ux, edy: uy, nx, ny, len, t: 0, k: key };
            const x0 = Math.min(wax, wbx), x1 = Math.max(wax, wbx);
            const y0 = Math.min(way, wby), y1 = Math.max(way, wby);
            const c0 = Math.floor(x0 / BUCKET), c1 = Math.floor(x1 / BUCKET);
            const r0 = Math.floor(y0 / BUCKET), r1 = Math.floor(y1 / BUCKET);
            for (let bc = c0; bc <= c1; bc++) for (let br = r0; br <= r1; br++) {
                const k2 = bc * 997 + br;
                let arr = vmap.get(k2);
                if (!arr) { arr = []; vmap.set(k2, arr); }
                arr.push(seg);
            }
        }
    }
    P.segs = { vmap, BUCKET, rockSz, cellSize, halfW, halfH };
    P.bounds = { viLo, viHi, vjLo, vjHi };
    P.segKey = L;
    return P.segs;
}

function pushFromRocks(tr, pos, r, maxMove) {
    const S = buildSegs(tr);
    const dead = tr._rockDead;
    const BUCKET = S.BUCKET, smap = S.vmap;
    const startX = pos.x, startY = pos.y;
    const tick = ++P.segTick;
    for (let pass = 0; pass < 3; pass++) {
        const cx = pos.x, cy = pos.y;
        const c0 = Math.floor((cx - r) / BUCKET), c1 = Math.floor((cx + r) / BUCKET);
        const r0 = Math.floor((cy - r) / BUCKET), r1 = Math.floor((cy + r) / BUCKET);
        let moved = false;
        for (let bc = c0; bc <= c1; bc++) {
            for (let br = r0; br <= r1; br++) {
                const arr = smap.get(bc * 997 + br);
                if (!arr) continue;
                for (const seg of arr) {
                    if (seg.t === tick) continue;
                    seg.t = tick;
                    if (dead.has(seg.k)) continue;
                    const dax = pos.x - seg.ax, day = pos.y - seg.ay;
                    const t = Math.max(0, Math.min(seg.len, dax * seg.edx + day * seg.edy));
                    const ncx = seg.ax + t * seg.edx, ncy = seg.ay + t * seg.edy;
                    const dx = pos.x - ncx, dy = pos.y - ncy;
                    const dist2 = dx * dx + dy * dy;
                    if (dist2 >= r * r) continue;
                    const dist = Math.sqrt(dist2);
                    let pnx, pny;
                    if (dist < 1e-6) { pnx = seg.nx; pny = seg.ny; }
                    else {
                        pnx = dx / dist; pny = dy / dist;
                        if (pnx * seg.nx + pny * seg.ny < 0) { pnx = -pnx; pny = -pny; }
                    }
                    pos.x += pnx * (r - dist); pos.y += pny * (r - dist);
                    moved = true;
                }
            }
        }
        if (!moved) break;
        const mx = pos.x - startX, my = pos.y - startY, md = Math.hypot(mx, my);
        if (md > maxMove) {
            pos.x = startX + mx / md * maxMove;
            pos.y = startY + my / md * maxMove;
            break;
        }
    }
    return { dx: pos.x - startX, dy: pos.y - startY };
}

function pointInRock(tr, wx, wy) {
    const S = buildSegs(tr), B = P.bounds;
    const s = S.rockSz * S.cellSize;
    const px = (wx + S.halfW) / s, py = (wy + S.halfH) / s;
    const nx = Math.floor(px), ny = Math.floor(py);
    let best = Infinity, bi = 0, bj = 0;
    for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
            const [hx, hy] = tr._vh2(nx + di, ny + dj);
            const sx = nx + di + hx, sy = ny + dj + hy;
            const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
            if (d < best) { best = d; bi = nx + di; bj = ny + dj; }
        }
    }
    if (bi < B.viLo || bi > B.viHi || bj < B.vjLo || bj > B.vjHi) return false;
    return !tr._rockDead.has(bi * 100003 + bj);
}

function driveRates(rise, stop, turn, carry) {
    const t = 1000 / 30, r = ms => Math.pow(0.1, t / Math.max(t, ms));
    return { rise: r(rise), stop: r(stop), turn: r(turn), carry: carry > 0 ? carry : 0 };
}

function driveInto(s, gx, gy, power, a) {
    const R = P.srv.drive;
    const keep = 1 / (1 + s.damp / P.srv.rs);
    const top = gx !== 0 || gy !== 0 ? Math.max(0, power) * a / (1 - keep) : 0;
    const d = s.drv || { x: 0, y: 0, ax: 0, ay: 0, ex: 0, ey: 0 };
    let ox = d.x, oy = d.y, nx, ny, cx = 0, cy = 0;
    if (top > 0) {
        const len = Math.sqrt(gx * gx + gy * gy), ux = gx / len, uy = gy / len;
        let p = ox * ux + oy * uy;
        const sx = ox - p * ux, sy = oy - p * uy;
        const wx = sx * R.turn, wy = sy * R.turn;
        if (s.dj >= 0) p = Math.max(p, Math.min(top, s.vx * ux + s.vy * uy));
        const r = p > top ? keep : p < 0 ? R.stop : R.rise;
        p += (top - p) * (1 - r);
        if (p >= 0 && p < top) {
            const bx = (s.vx - d.ax) / keep, by = (s.vy - d.ay) / keep;
            const bp = bx * ux + by * uy, qx = bx - bp * ux, qy = by - bp * uy;
            p = Math.min(top, p + Math.min(Math.sqrt(sx * sx + sy * sy), Math.sqrt(qx * qx + qy * qy)) * (1 - R.turn) * R.carry);
        }
        nx = p * ux + wx;
        ny = p * uy + wy;
    } else {
        const e2 = d.ex * d.ex + d.ey * d.ey;
        if (e2 > 1e-9) {
            const share = Math.max(0, Math.min(1, ((s.vx - d.ax) * d.ex + (s.vy - d.ay) * d.ey) / e2));
            if (share < 1) {
                cx = (1 - share) * d.ax;
                cy = (1 - share) * d.ay;
                ox *= share;
                oy *= share;
            }
        } else if (ox * ox + oy * oy > 0) {
            ox = 0;
            oy = 0;
        }
        nx = ox * R.stop;
        ny = oy * R.stop;
        if (nx * nx + ny * ny < 1e-4) { nx = 0; ny = 0; }
    }
    const ax = nx - keep * (ox + cx), ay = ny - keep * (oy + cy);
    s.ax += ax;
    s.ay += ay;
    s.drv = { x: nx, y: ny, ax, ay, ex: keep * (ox + cx), ey: keep * (oy + cy) };
}

function engineInto(s, e) {
    const rs = P.srv.rs;
    const a = P.accel / rs;
    if (P.top) s.damp = a / P.top;
    const mv = (e.bits & 15) ? unpackMove(e.an) : null;
    let gx, gy, power = 1;
    if (mv) {
        gx = (s.x + mv.x * 100) - s.x;
        gy = (s.y + mv.y * 100) - s.y;
        power = Math.min(1, Math.hypot(mv.x, mv.y));
    } else {
        const c = e.bits;
        gx = (s.x + ((c >> 3) & 1) - ((c >> 2) & 1)) - s.x;
        gy = (s.y + ((c >> 1) & 1) - (c & 1)) - s.y;
    }
    if (P.srv.drive && P.top > 0 && a > 0 && s.damp > 0) {
        driveInto(s, gx, gy, power, a);
        return;
    }
    if (gx !== 0 || gy !== 0) {
        const len = Math.sqrt(gx * gx + gy * gy);
        s.ax += (a * gx / len) * power;
        s.ay += (a * gy / len) * power;
    }
}

function physics(s) {
    const rs = P.srv.rs;
    s.vx += s.ax;
    s.vy += s.ay;
    s.ax = 0;
    s.ay = 0;
    s.x += 1 * s.vx / rs;
    s.y += 1 * s.vy / rs;
}

const _pos = { x: 0, y: 0 };
function post(s, tr) {
    const rs = P.srv.rs, r = P.r;
    const motion = Math.sqrt(Math.pow(s.vx, 2) + Math.pow(s.vy, 2));
    if (motion > 0 && s.damp) {
        const k = s.damp / rs, drag = motion / (k + 1), fin = 0 + drag;
        s.vx = fin * s.vx / motion;
        s.vy = fin * s.vy / motion;
    }
    const W = P.srv.bw, H = P.srv.bh, f = P.srv.bf;
    if (W > 0 && H > 0 && f) {
        s.ax -= Math.min(s.x - r + W / 2 + 50, 0) * f / rs;
        s.ax -= Math.max(s.x + r - W / 2 - 50, 0) * f / rs;
        s.ay -= Math.min(s.y - r + H / 2 + 50, 0) * f / rs;
        s.ay -= Math.max(s.y + r - H / 2 - 50, 0) * f / rs;
    }
    if (tr) {
        _pos.x = s.x; _pos.y = s.y;
        const p = pushFromRocks(tr, _pos, r, Math.max(48, r * 0.35));
        s.x = _pos.x; s.y = _pos.y;
        if (p.dx !== 0 || p.dy !== 0) {
            const pLen = Math.hypot(p.dx, p.dy);
            const nx = p.dx / pLen, ny = p.dy / pLen;
            const vDot = s.vx * nx + s.vy * ny;
            if (vDot < 0) {
                s.vx -= vDot * nx;
                s.vy -= vDot * ny;
            }
        }
    }
    if (s.dj >= 0) {
        if (s.dj >= s.dEnd) { s.vx *= 0.45; s.vy *= 0.45; s.dj = -1; }
        else if (tr && pointInRock(tr, s.x + s.dsx * 1.2, s.y + s.dsy * 1.2)) { s.vx *= 0.25; s.vy *= 0.25; s.dj = -1; }
        else { s.vx = s.dsx; s.vy = s.dsy; s.ax = 0; s.ay = 0; s.dj++; }
    }
}

function startDash(s, e, tr) {
    const D = P.srv;
    if (!(D.dmult > 0)) return;
    let dx = 0, dy = 0;
    const mv = (e.bits & 15) ? unpackMove(e.an) : null;
    if (mv && (mv.x || mv.y)) { dx = mv.x; dy = mv.y; }
    else { const c = e.bits; dx = ((c >> 3) & 1) - ((c >> 2) & 1); dy = ((c >> 1) & 1) - (c & 1); }
    if (!dx && !dy) {
        if (e.tx || e.ty) { dx = e.tx; dy = e.ty; }
        else { dx = Math.cos(e.f || 0); dy = Math.sin(e.f || 0); }
    }
    const d = Math.hypot(dx, dy) || 1;
    const sp = Math.max(D.dmin, P.top || 0) * D.dmult;
    if (s.dj >= 0) { s.vx *= 0; s.vy *= 0; }
    s.dsx = dx / d * sp;
    s.dsy = dy / d * sp;
    s.dEnd = Math.floor((D.dms - 2) / baseTick()) + 1;
    s.dj = 0;
    if (!(tr && pointInRock(tr, s.x + s.dsx * 1.2, s.y + s.dsy * 1.2))) {
        s.vx = s.dsx; s.vy = s.dsy;
        s.ax = 0; s.ay = 0;
    }
}

function stepEntry(s, e, tr) {
    if (e.dash) startDash(s, e, tr);
    physics(s);
    e.drvIn = s.drv ? Object.assign({}, s.drv) : null;
    engineInto(s, e);
    e.px = s.x; e.py = s.y;
    e.dj = s.dj; e.dsx = s.dsx; e.dsy = s.dsy; e.dEnd = s.dEnd;
    post(s, tr);
    e.x = s.x; e.y = s.y; e.vx = s.vx; e.vy = s.vy; e.ax = s.ax; e.ay = s.ay;
    e.sim = true;
}

function rawPredicted(now) {
    const ring = P.ring;
    if (!ring.length) return null;
    let i = ring.length - 1;
    while (i > 0 && ring[i].t > now && ring[i - 1].sim) i--;
    const L = ring[i];
    if (!L.sim) return null;
    const rs = P.srv.rs;
    const nx = L.x + 1 * (L.vx + L.ax) / rs, ny = L.y + 1 * (L.vy + L.ay) / rs;
    const a = Math.max(0, Math.min(1, (now - L.t) / tickMs()));
    P.out.x = L.px + (nx - L.px) * a;
    P.out.y = L.py + (ny - L.py) * a;
    return P.out;
}

function raw(now) {
    if (P.sending && P.anchored && !P.forced) {
        const p = rawPredicted(now);
        if (p) return { x: p.x, y: p.y };
    }
    if (isFinite(P.lx) && isFinite(P.ly)) return { x: P.lx, y: P.ly };
    return null;
}

function canRun(now) {
    if (!P.srv || P.failed || killed(now)) return false;
    if (!global.gameStart || global.died || global.disconnected || global.royaleSpectating || global._specGlide) return false;
    const sock = global.socket;
    if (!sock || !sock.open || !sock.cmd || !sock.cmd.fields) return false;
    if (typeof document !== "undefined" && document.hidden) return false;
    if (!(P.accel > 0) || !(P.top > 0) || !(P.r > 0)) return false;
    if (global.player && global.player.isScoping) return false;
    const tr = typeof window !== "undefined" ? window.terrainRenderer : null;
    if (tr && !terrain()) return false;
    return true;
}

function start(now) {
    P.sending = true;
    P.anchored = false;
    P.forced = false;
    P.ring.length = 0;
    P.nextAt = now;
    P.badSince = 0;
    P.release = false;
    P.rox = P.roy = 0;
    stats.starts++;
}

function stop(why) {
    if (!P.sending) return;
    P.sending = false;
    P.why = why || "";
    if (P.anchored && P.lastOut && why !== "spawn" && why !== "death") {
        P.release = true;
        P.relFrom = { x: P.lastOut.x, y: P.lastOut.y };
    }
    P.anchored = false;
    P.forced = false;
    P.ring.length = 0;
    P.ox = P.oy = 0;
    P.pendingDash = false;
    stats.stops++;
    try { const s = global.socket; if (s && s.open && s.cmd && s.cmd.talk) s.cmd.talk(); } catch (e) { }
}

function doTick(t, tr) {
    const sock = global.socket;
    const f = sock.cmd.fields();
    P.seq = (P.seq + 1) % SEQ_MOD;
    const dash = P.pendingDash;
    P.pendingDash = false;
    const e = { seq: P.seq, t, bits: f[3], an: f[4] | 0, tx: f[0], ty: f[1], f: Math.atan2(f[1], f[0]), dash, sim: false,
        px: 0, py: 0, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, dj: -1, dsx: 0, dsy: 0, dEnd: 0 };
    sock.talk("C", f[0], f[1], f[2], f[3], f[4] | 0, P.seq * 2 + (dash ? 1 : 0));
    if (dash) stats.dashes++;
    const ring = P.ring;
    if (P.anchored && P.cur && ring.length) stepEntry(P.cur, e, tr);
    ring.push(e);
    if (ring.length > CFG.ringMax) ring.splice(0, ring.length - CFG.ringMax);
    stats.ticks++;
}

function pump(now) {
    if (!canRun(now)) { if (P.sending) stop("inactive"); return; }
    if (!P.sending) start(now);
    const T = tickMs();
    const tr = terrain();
    if (now - P.nextAt > T * CFG.catchUp) { P.nextAt = now; stats.resyncs++; }
    let n = 0;
    while (now >= P.nextAt && n < CFG.catchUp) {
        doTick(P.nextAt, tr);
        P.nextAt += T;
        n++;
    }
}

function onAdvert(m) {
    if (!m || m[0] !== 1) { P.srv = null; stop("off"); return; }
    P.srv = { rs: +m[1] || 1, bw: +m[2] || 0, bh: +m[3] || 0, bf: +m[4] || 0, dmult: +m[5] || 0, dmin: +m[6] || 0, dms: +m[7] || 0,
        drive: +m[8] > 0 ? driveRates(+m[8], +m[9], +m[10], +m[11]) : null };
}

function onSnapshot(word, x, y, vx, vy, accel, top, size) {
    if (accel > 0) P.accel = accel;
    if (top > 0) P.top = top;
    if (size > 0) P.r = size;
    if (!P.sending) return false;
    if (typeof word !== "number" || word < 64) { stats.noAck++; return false; }
    if (!isFinite(x) || !isFinite(y)) return true;
    stats.snapshots++;
    const now = performance.now();
    const ack = Math.floor(word / 64) - 1;
    const forced = (word & 2) !== 0, dashing = (word & 4) !== 0;
    const qd = (word >> 3) & 3, starved = (word & 32) !== 0;
    P.depth += (qd - P.depth) * 0.1;
    if (starved) { P.depth -= 0.3; stats.starved++; }
    if (P.depth < -1) P.depth = -1;
    const ring = P.ring;
    if (!ring.length) return true;
    const idx = seqDiff(ack, ring[0].seq);
    if (idx < 0 || idx >= ring.length) {
        stats.reanchors++;
        if (idx >= ring.length) { P.ring.length = 0; P.anchored = false; }
        return true;
    }
    const eN = ring[idx];
    const before = raw(now);
    const wasPred = P.anchored && !P.forced;
    let err = -1;
    if (P.anchored && eN.sim) err = Math.hypot(x - eN.px, y - eN.py);
    stats.lead = seqDiff(P.seq, ack);
    if (P.dbg) { P.dbg.push([now, ack, stats.lead, err, x, y, eN.sim ? eN.px : NaN, eN.sim ? eN.py : NaN, forced ? 1 : 0, dashing ? 1 : 0, eN.bits]); if (P.dbg.length > 4000) P.dbg.shift(); }
    const tr = terrain();
    if (forced || (dashing && !(eN.dj >= 0))) {
        if (!P.forced) stats.forced++;
        P.forced = true;
        P.anchored = true;
        P.cur = null;
        for (let k = idx; k < ring.length; k++) ring[k].sim = false;
        err = -1;
    } else {
        P.forced = false;
        const s = { x, y, vx: +vx || 0, vy: +vy || 0, ax: 0, ay: 0, damp: P.damp,
            dj: dashing ? eN.dj : -1, dsx: eN.dsx, dsy: eN.dsy, dEnd: eN.dEnd, drv: eN.drvIn ? Object.assign({}, eN.drvIn) : null };
        engineInto(s, eN);
        eN.px = x; eN.py = y; eN.dj = s.dj;
        post(s, tr);
        eN.x = s.x; eN.y = s.y; eN.vx = s.vx; eN.vy = s.vy; eN.ax = s.ax; eN.ay = s.ay; eN.sim = true;
        for (let k = idx + 1; k < ring.length; k++) stepEntry(s, ring[k], tr);
        P.damp = s.damp;
        P.cur = s;
        P.anchored = true;
    }
    if (idx > 0) ring.splice(0, idx);
    P.lastAckAt = now;
    const after = raw(now);
    if (before && after) {
        const dx = before.x - after.x, dy = before.y - after.y, d = Math.hypot(dx, dy);
        if (d > CFG.cutDist) { P.ox = 0; P.oy = 0; stats.cuts++; }
        else {
            P.ox += dx; P.oy += dy;
            if (d > 0.5 && wasPred && !P.forced) {
                stats.corrections++;
                stats.corrSum += d;
                if (d > stats.corrMax) stats.corrMax = d;
                if (d > CFG.bigErr) stats.big++;
            }
        }
    }
    if (err >= 0) {
        stats.errN++;
        stats.errSum += err;
        stats.lastErr = err;
        if (err > stats.errMax) stats.errMax = err;
        if (err > CFG.failErr && err < CFG.cutDist) {
            if (!P.badSince) P.badSince = now;
            else if (now - P.badSince > CFG.failMs) fail("error " + err.toFixed(1));
        } else P.badSince = 0;
    }
    return true;
}

function fail(why) {
    P.failed = true;
    stats.fallbacks++;
    stop("fail: " + why);
}

function frame(now, lx, ly) {
    P.lx = lx; P.ly = ly;
    pump(Math.max(now, performance.now()));
    const dt = P.lastFrame ? Math.min(250, Math.max(0, now - P.lastFrame)) : 0;
    P.lastFrame = now;
    if (!P.sending) {
        if (!P.release || !isFinite(lx) || !isFinite(ly)) { P.release = false; return null; }
        if (P.relFrom) { P.rox = P.relFrom.x - lx; P.roy = P.relFrom.y - ly; P.relFrom = null; if (Math.hypot(P.rox, P.roy) > CFG.cutDist) { P.release = false; return null; } }
        const k = Math.exp(-dt / CFG.tauSmall);
        P.rox *= k; P.roy *= k;
        if (Math.abs(P.rox) < 0.05 && Math.abs(P.roy) < 0.05) { P.release = false; return null; }
        P.out.x = lx + P.rox; P.out.y = ly + P.roy;
        return P.out;
    }
    const d = Math.hypot(P.ox, P.oy);
    if (dt > 0 && d > 0) {
        const k = Math.exp(-dt / (d > CFG.bigErr ? CFG.tauBig : CFG.tauSmall));
        P.ox *= k; P.oy *= k;
        if (Math.abs(P.ox) < 0.01) P.ox = 0;
        if (Math.abs(P.oy) < 0.01) P.oy = 0;
    }
    const r = raw(now);
    if (!r) return null;
    P.out.x = r.x + P.ox;
    P.out.y = r.y + P.oy;
    P.lastOut = { x: P.out.x, y: P.out.y };
    return P.out;
}

function onSpawn() {
    stop("spawn");
    P.failed = false;
    P.release = false;
    P.badSince = 0;
}

function onDeath() {
    stop("death");
    P.release = false;
}

function dash() {
    if (!P.sending) return false;
    P.pendingDash = true;
    return true;
}

function sending() { return P.sending; }
function active() { return P.sending && P.anchored && !P.forced; }

function snapshotStats() {
    return Object.assign({ sending: P.sending, anchored: P.anchored, forced: P.forced, failed: P.failed, why: P.why, ring: P.ring.length,
        errAvg: stats.errN ? +(stats.errSum / stats.errN).toFixed(2) : 0, corrAvg: stats.corrections ? +(stats.corrSum / stats.corrections).toFixed(2) : 0 }, stats);
}

const predictor = { CFG, P, stats: snapshotStats, onAdvert, onSnapshot, frame, pump, onSpawn, onDeath, dash, sending, active, stop, pushFromRocks, pointInRock };
if (typeof window !== "undefined") window.dwPredict = predictor;
export { predictor };
