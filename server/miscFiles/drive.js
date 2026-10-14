"use strict";

const TICK_MS = 1000 / 30;

const CFG = {
    on: process.env.DRIVE !== "0",
    riseMs: 420,
    stopMs: 360,
    turnMs: 260,
    turnCarry: 0.6,
};

const R = { rise: 0, stop: 0, turn: 0 };

function retainFor(ms) {
    return Math.pow(0.1, TICK_MS / Math.max(TICK_MS, ms));
}

function tune(over) {
    if (over) Object.assign(CFG, over);
    R.rise = retainFor(CFG.riseMs);
    R.stop = retainFor(CFG.stopMs);
    R.turn = retainFor(CFG.turnMs);
    return R;
}
tune();

function frictionKeep(body, roomSpeed) {
    const k = body.damp / (roomSpeed || 1);
    return k > 0 && isFinite(k) ? 1 / (1 + k) : 0;
}

function applies(body, a) {
    return CFG.on && body.type === "tank" && body.bond == null && body.topSpeed > 0 && a > 0 && body.damp > 0;
}

function motor(body, gx, gy, gactive, a, roomSpeed) {
    const keep = frictionKeep(body, roomSpeed);
    const power = gactive ? Math.max(0, body.control.power == null ? 1 : body.control.power) : 0;
    const top = power * a / (1 - keep);
    let d = body._drive;
    if (!d || !isFinite(d.x) || !isFinite(d.y)) d = body._drive = { x: 0, y: 0, ax: 0, ay: 0, ex: 0, ey: 0 };
    const v = body.velocity;
    let ox = d.x, oy = d.y, nx, ny, cx = 0, cy = 0;
    if (top > 0) {
        const len = Math.sqrt(gx * gx + gy * gy);
        const ux = gx / len, uy = gy / len;
        let p = ox * ux + oy * uy;
        const sx = ox - p * ux, sy = oy - p * uy;
        const wx = sx * R.turn, wy = sy * R.turn;
        if (body._abMove) p = Math.max(p, Math.min(top, v.x * ux + v.y * uy));
        const r = p > top ? keep : p < 0 ? R.stop : R.rise;
        p += (top - p) * (1 - r);
        if (p >= 0 && p < top) {
            const bx = (v.x - d.ax) / keep, by = (v.y - d.ay) / keep;
            const bp = bx * ux + by * uy, qx = bx - bp * ux, qy = by - bp * uy;
            const side = Math.min(Math.sqrt(sx * sx + sy * sy), Math.sqrt(qx * qx + qy * qy));
            p = Math.min(top, p + side * (1 - R.turn) * CFG.turnCarry);
        }
        nx = p * ux + wx;
        ny = p * uy + wy;
    } else {
        const e2 = d.ex * d.ex + d.ey * d.ey;
        if (e2 > 1e-9) {
            const share = Math.max(0, Math.min(1, ((v.x - d.ax) * d.ex + (v.y - d.ay) * d.ey) / e2));
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
    body.accel.x += ax;
    body.accel.y += ay;
    d.x = nx;
    d.y = ny;
    d.ax = ax;
    d.ay = ay;
    d.ex = keep * (ox + cx);
    d.ey = keep * (oy + cy);
}

function coastLead(body, ux, uy, roomSpeed) {
    const d = body && body._drive;
    if (!d || !CFG.on) return 0;
    const closing = d.x * ux + d.y * uy;
    if (!(closing > 0)) return 0;
    const keep = frictionKeep(body, roomSpeed);
    const extra = R.stop / (1 - R.stop) - (keep > 0 && keep < 1 ? keep / (1 - keep) : 0);
    return extra > 0 ? closing * extra / (roomSpeed || 1) : 0;
}

module.exports = { CFG, R, TICK_MS, tune, retainFor, applies, motor, coastLead, frictionKeep };
