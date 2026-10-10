import { global } from "./global.js";
import * as L from "./tankTreeLogic.js";

const { TILE, CELL, NAME_H } = L;
const LEVELS = [24, 48, 96, 144];
const CAP = [100000, 100000, 500, 200];
const BUILD_BUDGET = [60, 40, 14, 6];

let D = null;
let isOpen = false;
let g = null, gKey = "", gMocks = null;
let whole = false;
let expanded = new Map();
let opn = null, vis = null, box = null;
let cur = -1, curKey = "", pathSet = new Set(), subSet = new Set();
let dirty = true;
let ver = 0;
let W = 1280, H = 720;
const view = { x: 0, y: 0, z: 1 };
const goal = { x: 0, y: 0, z: 1, on: false };
let fit = 1;
let sel = -1, hover = -1, hoverDirty = true;
const mouse = { x: -1e4, y: -1e4, sx: 0, sy: 0, down: false, moved: false, owned: false, lx: 0, ly: 0 };
const keys = { l: false, r: false, u: false, d: false, fast: false };
let lastT = 0;
let built = [0, 0, 0, 0];
let sprColor = null;
let tip = null;
const btn = new Float32Array(16);
let btnHover = -1;
const touches = new Map();
let pinch = null;
let frameMs = new Float32Array(240), frameAt = 0, frameN = 0;

export function init(deps) { D = deps; }

export function opened() { return isOpen; }

export function open() {
    isOpen = true;
    whole = false;
    expanded = new Map();
    dirty = true;
    sel = -1; hover = -1; tip = null;
    mouse.down = false; mouse.owned = false;
    keys.l = keys.r = keys.u = keys.d = keys.fast = false;
    touches.clear(); pinch = null;
    curKey = "";
    lastT = 0;
}

export function close() {
    isOpen = false;
    mouse.down = false; mouse.owned = false;
    touches.clear(); pinch = null;
    tip = null;
    if (g) for (const t of g.tanks.values()) if (t.spr) { for (let j = 0; j < t.spr.length; j++) if (t.spr[j] && t.spr[j].lvl >= 2) t.spr[j] = null; }
    built[2] = built[3] = 0;
}

function rootKeys() {
    const m = D.mockups(), type = D.tankType();
    if (!m || type == null) return null;
    const names = [];
    for (const part of String(type).split("-")) {
        const mk = m[parseInt(part, 10)];
        if (mk && mk.rerootUpgradeTree) for (const r of String(mk.rerootUpgradeTree).split("\\/")) if (r && names.indexOf(r) === -1) names.push(r);
    }
    const keys = [];
    for (const n of names) {
        const mk = m.find(x => x && x.className === n);
        if (!mk) return null;
        keys.push(String(mk.index));
    }
    if (!keys.length) {
        const basic = m.find(x => x && x.className === "basic");
        if (basic) keys.push(String(basic.index));
    }
    return keys.length ? keys : null;
}

function ensureGraph() {
    const m = D.mockups();
    const rk = rootKeys();
    if (!rk) return false;
    const key = rk.join(",");
    if (g && key === gKey && m === gMocks) return true;
    g = L.buildGraph(m, rk);
    gKey = key; gMocks = m;
    for (const n of g.inst) {
        const c = D.tileColors(n.tank.key, n.ci);
        n.face = c[0]; n.lip = c[1];
    }
    built = [0, 0, 0, 0];
    expanded = new Map();
    curKey = "";
    dirty = true;
    return true;
}

function relayout(recentre) {
    const type = String(D.tankType());
    if (type !== curKey) { curKey = type; cur = L.findInst(g, type); recentre = true; if (!whole) expanded = new Map(); }
    pathSet = new Set(cur >= 0 ? L.pathOf(g, cur) : []);
    subSet = new Set();
    if (cur >= 0) { const q = [cur]; while (q.length) { const i = q.pop(); subSet.add(i); for (const k of g.inst[i].kids) q.push(k); } }
    opn = whole ? L.allOpen(g) : L.focusOpen(g, cur, expanded);
    vis = L.visibleOf(g, opn);
    box = L.layout(g, opn, vis, { whole, hi: pathSet });
    ver++;
    dirty = false;
    hoverDirty = true;
    fit = fitNow();
    if (recentre) frame(true);
}

function fitNow() { return L.fitZoom(box, W - 150, H - headH() - 60); }

function headH() { return D.mobile() ? 54 : 58; }

function frame(snap) {
    let z, x, y;
    if (whole) {
        z = Math.max(0.2, W * 0.94 / Math.max(1, box.maxX - box.minX));
        x = box.minX - 110 / z + W / 2 / z;
        y = box.minY - 24 / z + (H / 2 - headH()) / z;
    } else {
        const usable = H - headH();
        z = Math.min(1.25, fit);
        x = (box.minX + box.maxX) / 2 - 50 / z; y = (box.minY + box.maxY) / 2;
        if (z < 0.5 && cur >= 0) {
            z = 0.75;
            const n = g.inst[cur];
            x = n.x + TILE / 2;
            if ((box.maxY - box.minY) * z <= usable - 70) y = (box.minY + box.maxY) / 2;
            else y = n.y + TILE + usable * 0.2 / z;
        }
        y -= (headH() - 30) / 2 / z;
    }
    z = L.clampZoom(z, fit);
    if (snap) { view.x = x; view.y = y; view.z = z; goal.on = false; }
    else { goal.x = x; goal.y = y; goal.z = z; goal.on = true; }
}

function centreOn(i, z) {
    const n = g.inst[i];
    goal.x = n.x + TILE / 2; goal.y = n.y + (TILE + NAME_H) / 2 - headH() / 2 / (z || view.z);
    goal.z = L.clampZoom(z || view.z, fit);
    goal.on = true;
}

function toggle(i) {
    if (i < 0 || !g.inst[i].kids.length || whole) return;
    expanded.set(i, !opn[i]);
    const keep = { x: g.inst[i].x, y: g.inst[i].y };
    relayout(false);
    const n = g.inst[i];
    view.x += n.x - keep.x; view.y += n.y - keep.y;
    goal.on = false;
}

function setWhole(on) {
    if (whole === on) return;
    whole = on;
    relayout(true);
    goal.on = false;
}

function toUi(cx, cy, out) {
    const iw = window.innerWidth || W, ih = window.innerHeight || H;
    out.x = cx * W / iw; out.y = cy * H / ih;
    return out;
}
const tmp = { x: 0, y: 0 };

function buttonAt(x, y) {
    for (let b = 0; b < 4; b++) {
        const o = b * 4;
        if (btn[o + 2] > 0 && x >= btn[o] && x <= btn[o] + btn[o + 2] && y >= btn[o + 1] && y <= btn[o + 1] + btn[o + 3]) return b;
    }
    return -1;
}

function press(b) {
    D.click();
    if (b === 0) global.tankTree("exit");
    else if (b === 1) setWhole(!whole);
    else if (b === 2) { if (cur >= 0 && g) { sel = cur; centreOn(cur, Math.max(view.z, 0.8)); } }
}

function nodeAt(x, y) {
    if (!g || !vis) return -1;
    const wx = view.x + (x - W / 2) / view.z, wy = view.y + (y - H / 2) / view.z;
    return L.hitNode(g, vis, wx, wy);
}

function tapAt(x, y) {
    const b = buttonAt(x, y);
    if (b >= 0) { press(b); return; }
    if (!g || dirty || y < headH()) return;
    const i = nodeAt(x, y);
    if (i < 0) { sel = -1; return; }
    if (sel === i && g.inst[i].kids.length && !whole) { toggle(i); return; }
    sel = i;
    centreOn(i);
}

export function down(cx, cy) {
    if (!isOpen) return false;
    toUi(cx, cy, tmp);
    mouse.down = true; mouse.owned = true; mouse.moved = false;
    mouse.sx = mouse.lx = tmp.x; mouse.sy = mouse.ly = tmp.y;
    mouse.x = tmp.x; mouse.y = tmp.y;
    goal.on = false;
    return true;
}

export function move(cx, cy) {
    if (!isOpen) return false;
    toUi(cx, cy, tmp);
    mouse.x = tmp.x; mouse.y = tmp.y;
    hoverDirty = true;
    if (mouse.down) {
        if (Math.abs(tmp.x - mouse.sx) + Math.abs(tmp.y - mouse.sy) > 6) mouse.moved = true;
        if (mouse.moved) {
            view.x -= (tmp.x - mouse.lx) / view.z;
            view.y -= (tmp.y - mouse.ly) / view.z;
        }
        mouse.lx = tmp.x; mouse.ly = tmp.y;
    }
    return true;
}

export function up(cx, cy) {
    if (!mouse.owned) return false;
    mouse.owned = false;
    const was = mouse.down;
    mouse.down = false;
    if (!isOpen) return true;
    toUi(cx, cy, tmp);
    if (was && !mouse.moved) tapAt(tmp.x, tmp.y);
    return true;
}

export function wheel(e) {
    if (!isOpen) return false;
    toUi(e.clientX, e.clientY, tmp);
    let dy = +e.deltaY || 0;
    if (e.deltaMode === 1) dy *= 16;
    if (e.ctrlKey) dy *= 3;
    dy = Math.max(-240, Math.min(240, dy));
    L.zoomAbout(view, Math.exp(-dy * 0.0022), tmp.x, tmp.y, W, H, fit);
    goal.on = false;
    hoverDirty = true;
    return true;
}

export function key(e, isDown) {
    if (!isOpen) return false;
    const c = e.keyCode;
    const arrow = c === 37 ? "l" : c === 39 ? "r" : c === 38 ? "u" : c === 40 ? "d" : null;
    if (arrow) { keys[arrow] = isDown; if (isDown) goal.on = false; return true; }
    if (c === 16) { keys.fast = isDown; return false; }
    if (!isDown) return c === 9 || c === 27 || c === 69 || c === 13 || c === 32 || c === 67 || c === 36;
    if (c === 27) { global.tankTree("exit"); return true; }
    if (c === 9) { if (!e.repeat) setWhole(!whole); return true; }
    if (c === 69 || c === 13 || c === 32) {
        if (e.repeat) return true;
        const i = sel >= 0 ? sel : hover >= 0 ? hover : cur;
        if (i >= 0 && g && !dirty) { if (whole) centreOn(i); else toggle(i); sel = i; }
        return true;
    }
    if (c === 67 || c === 36) { if (!e.repeat) press(2); return true; }
    if (c === 187 || c === 61 || c === 107) { L.zoomAbout(view, 1.25, W / 2, H / 2, W, H, fit); goal.on = false; return true; }
    if (c === 189 || c === 173 || c === 109) { L.zoomAbout(view, 0.8, W / 2, H / 2, W, H, fit); goal.on = false; return true; }
    return false;
}

function pinchState() {
    const it = touches.values();
    const a = it.next().value, b = it.next().value;
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

export function touch(type, e) {
    if (!isOpen) { touches.clear(); pinch = null; return false; }
    for (const t of e.changedTouches) {
        toUi(t.clientX, t.clientY, tmp);
        if (type === "start") {
            touches.set(t.identifier, { x: tmp.x, y: tmp.y, sx: tmp.x, sy: tmp.y, moved: false });
            goal.on = false;
            if (touches.size === 2) { const p = pinchState(); pinch = { d: p.d, mx: p.mx, my: p.my }; for (const v of touches.values()) v.moved = true; }
        } else if (type === "move") {
            const o = touches.get(t.identifier);
            if (!o) continue;
            if (!pinch) {
                if (Math.abs(tmp.x - o.sx) + Math.abs(tmp.y - o.sy) > 10) o.moved = true;
                if (o.moved) { view.x -= (tmp.x - o.x) / view.z; view.y -= (tmp.y - o.y) / view.z; }
            }
            o.x = tmp.x; o.y = tmp.y;
        } else {
            const o = touches.get(t.identifier);
            touches.delete(t.identifier);
            if (o && !o.moved && !pinch && touches.size === 0) tapAt(tmp.x, tmp.y);
            if (touches.size < 2) pinch = null;
            if (touches.size === 1) for (const v of touches.values()) { v.moved = true; }
        }
    }
    if (pinch && type === "move" && touches.size >= 2) {
        const p = pinchState();
        L.zoomAbout(view, p.d / pinch.d, p.mx, p.my, W, H, fit);
        view.x -= (p.mx - pinch.mx) / view.z; view.y -= (p.my - pinch.my) / view.z;
        pinch.d = p.d; pinch.mx = p.mx; pinch.my = p.my;
    }
    return true;
}

function nameSize(name, max, base) {
    let s = base;
    while (s > 6 && D.hudTitleW(name, s) > max) s -= 0.5;
    return s;
}

function buildSprite(n, lvl) {
    const t = n.tank;
    const px = LEVELS[lvl], u = px / TILE;
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(CELL * u);
    cv.height = Math.ceil((TILE + NAME_H) * u);
    const c = cv.getContext("2d");
    c.scale(u, u);
    const ox = (CELL - TILE) / 2;
    D.rr(c, ox + 1.5, 1.5, TILE - 3, TILE - 3, 5);
    c.fillStyle = n.face;
    c.fill();
    c.save();
    c.clip();
    c.fillStyle = "rgba(0,0,0,0.16)";
    c.fillRect(ox, TILE * 0.6, TILE, TILE * 0.4);
    c.restore();
    c.lineWidth = 3;
    c.strokeStyle = n.lip;
    D.rr(c, ox + 1.5, 1.5, TILE - 3, TILE - 3, 5);
    c.stroke();
    if (t.known) { try { D.paintTank(c, t.key, ox + 5, 5, TILE - 10, TILE - 10); } catch (e) { } }
    if (n.tier >= L.T5_TIER) {
        D.rr(c, ox + TILE - 23, 4, 19, 12, 4);
        c.fillStyle = "rgba(0,0,0,0.78)";
        c.fill();
        c.lineWidth = 1.2;
        c.strokeStyle = D.HUD.gold;
        c.stroke();
        D.hudTitle(D.t5Label(), ox + TILE - 13.5, 10.2, 7.5, D.HUD.gold, "center", 1, c);
    }
    if (lvl > 0) D.hudTitle(t.name, CELL / 2, TILE + NAME_H / 2 + 1, nameSize(t.name, CELL - 4, 11.5), "#ffffff", "center", 1, c);
    return { cv, lvl };
}

function spriteFor(n, want, budget) {
    const t = n.tank;
    if (!t.spr) t.spr = new Array(LEVELS.length * 16).fill(null);
    const slot = (n.ci & 15);
    const s = t.spr[want * 16 + slot];
    if (s) return s;
    if (budget[want] > 0 && built[want] < CAP[want]) {
        budget[want]--;
        built[want]++;
        const b = buildSprite(n, want);
        t.spr[want * 16 + slot] = b;
        return b;
    }
    for (let l = want - 1; l >= 0; l--) if (t.spr[l * 16 + slot]) return t.spr[l * 16 + slot];
    for (let l = want + 1; l < LEVELS.length; l++) if (t.spr[l * 16 + slot]) return t.spr[l * 16 + slot];
    return null;
}

function evict(lvl) {
    if (!g) return;
    for (const t of g.tanks.values()) if (t.spr) for (let j = lvl * 16; j < lvl * 16 + 16; j++) t.spr[j] = null;
    built[lvl] = 0;
}

function clearSprites() {
    if (g) for (const t of g.tanks.values()) t.spr = null;
    built = [0, 0, 0, 0];
}

const budget = [0, 0, 0, 0];

function strokeSegs(c, s, col, lw) {
    if (!s.length) return;
    const z = view.z, ox = W / 2 - view.x * z, oy = H / 2 - view.y * z;
    c.beginPath();
    for (let i = 0; i < s.length; i += 4) {
        const x1 = s[i] * z + ox, y1 = s[i + 1] * z + oy, x2 = s[i + 2] * z + ox, y2 = s[i + 3] * z + oy;
        if ((x1 < -10 && x2 < -10) || (x1 > W + 10 && x2 > W + 10) || (y1 < -10 && y2 < -10) || (y1 > H + 10 && y2 > H + 10)) continue;
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
    }
    c.strokeStyle = col;
    c.lineWidth = lw;
    c.stroke();
}

function buildTip(i) {
    const n = g.inst[i], t = n.tank;
    const from = [], to = [];
    for (const p of t.parents) { const pt = g.tanks.get(p); if (pt) from.push(pt.name); }
    for (const k of t.up || []) { const kt = g.tanks.get(k); if (kt) to.push(kt.name); }
    const lines = [];
    lines.push("Tier " + n.tier + (n.tier >= L.T5_TIER ? ", needs " + D.t5Label() + " growth this life" : ""));
    lines.push(from.length ? "From: " + L.listNames(from, 4) : "Every tank starts here");
    lines.push(to.length ? "Upgrades to: " + L.listNames(to, 5) : "No more upgrades after this one");
    if (i === cur) lines.push("This is your tank");
    else if (!whole && n.kids.length && !opn[i]) lines.push(D.mobile() ? "Tap again to show its upgrades" : "Click again or press E to show its upgrades");
    let w = D.hudTitleW(t.name, 16);
    for (const l of lines) w = Math.max(w, D.hudTitleW(l, 12));
    return { i, v: ver, name: t.name, lines, w: w + 24, h: 34 + lines.length * 17 };
}

function drawTile(c, n, i, sx, sy, s, dim, wantLvl, lod) {
    const k = s / TILE;
    if (lod) {
        c.fillStyle = n.face;
        c.fillRect(sx, sy, s, s);
        return;
    }
    const spr = spriteFor(n, wantLvl, budget);
    if (dim) c.globalAlpha = 0.42;
    if (spr) c.drawImage(spr.cv, sx - (CELL - TILE) / 2 * k, sy, CELL * k, (TILE + NAME_H) * k);
    else { c.fillStyle = n.face; c.fillRect(sx + 1.5 * k, sy + 1.5 * k, s - 3 * k, s - 3 * k); }
    if (dim) c.globalAlpha = 1;
}

export function draw(c, w, h) {
    if (!isOpen) return;
    const t0 = performance.now();
    const dt = lastT ? Math.min(0.05, (t0 - lastT) / 1000) : 0;
    if (lastT) { frameMs[frameAt] = t0 - lastT; frameAt = (frameAt + 1) % frameMs.length; frameN = Math.min(frameN + 1, frameMs.length); }
    lastT = t0;
    const k = (window.innerWidth || w) / w;
    const cw = w * k, ch = h * k;
    if (cw !== W || ch !== H) { W = cw; H = ch; if (box) fit = fitNow(); }
    c.save();
    c.scale(1 / k, 1 / k);
    c.globalAlpha = 1;
    c.fillStyle = "rgba(10,10,12,0.84)";
    c.fillRect(0, 0, W, H);
    const ready = D.ready() && ensureGraph();
    if (ready) {
        const col = D.playerColor();
        if (col !== sprColor) { sprColor = col; clearSprites(); }
        if (dirty || String(D.tankType()) !== curKey) relayout(false);
        step(dt);
        drawTree(c);
    } else {
        D.hudPanel(c, W / 2 - 150, H / 2 - 30, 300, 60, { fill: D.HUD.solid });
        D.hudTitle("Loading the tank tree...", W / 2, H / 2, 17, "#ffffff", "center", 1, c);
    }
    drawHeader(c, ready);
    if (ready && tip) drawTip(c);
    c.restore();
}

function step(dt) {
    const sp = (keys.fast ? 1800 : 760) * dt / view.z;
    if (keys.l) view.x -= sp;
    if (keys.r) view.x += sp;
    if (keys.u) view.y -= sp;
    if (keys.d) view.y += sp;
    if (keys.l || keys.r || keys.u || keys.d) hoverDirty = true;
    if (goal.on) {
        const a = 1 - Math.pow(0.0009, dt);
        const zl = Math.log(view.z) + (Math.log(goal.z) - Math.log(view.z)) * a;
        view.z = Math.exp(zl);
        view.x += (goal.x - view.x) * a;
        view.y += (goal.y - view.y) * a;
        hoverDirty = true;
        if (Math.abs(goal.z - view.z) < 0.002 && Math.abs(goal.x - view.x) * view.z < 0.5 && Math.abs(goal.y - view.y) * view.z < 0.5) { view.x = goal.x; view.y = goal.y; view.z = goal.z; goal.on = false; }
    }
    L.clampView(view, box, W, H);
    if (hoverDirty) {
        hoverDirty = false;
        btnHover = buttonAt(mouse.x, mouse.y);
        const hv = mouse.down || btnHover >= 0 || mouse.y < headH() ? -1 : nodeAt(mouse.x, mouse.y);
        if (hv !== hover) { hover = hv; tip = hv >= 0 ? buildTip(hv) : null; }
    }
    const want = hover >= 0 ? hover : D.mobile() ? sel : -1;
    if (want < 0) tip = null;
    else if (!tip || tip.i !== want || tip.v !== ver) tip = buildTip(want);
}

function drawTree(c) {
    const z = view.z, ox = W / 2 - view.x * z, oy = H / 2 - view.y * z;
    const s = TILE * z;
    const dev = s * D.devScale();
    const lod = dev < 9;
    let lvl = 0;
    while (lvl < LEVELS.length - 1 && LEVELS[lvl] < dev * 0.92) lvl++;
    if (built[lvl] >= CAP[lvl]) evict(lvl);
    for (let j = 0; j < 4; j++) budget[j] = BUILD_BUDGET[j];

    const lw = Math.max(1, Math.min(4, 3 * z));
    strokeSegs(c, box.segs, "rgba(235,235,235,0.55)", lw);
    strokeSegs(c, box.hiSegs, D.HUD.gold, lw * 1.6);

    c.imageSmoothingEnabled = true;
    const N = g.inst.length;
    const cullX0 = -CELL * z, cullY0 = -(TILE + NAME_H) * z;
    for (let i = 0; i < N; i++) {
        if (!vis[i]) continue;
        const n = g.inst[i];
        const sx = n.x * z + ox, sy = n.y * z + oy;
        if (sx < cullX0 || sx > W + 4 || sy < cullY0 || sy > H + 4) continue;
        const dim = !whole && !pathSet.has(i) && !subSet.has(i);
        drawTile(c, n, i, sx, sy, s, dim, lvl, lod);
        if (!lod && s > 26 && !whole && !opn[i] && n.kids.length) {
            const hk = n.kids.length;
            const cw = Math.max(16, 22 * z), ch = Math.max(11, 14 * z);
            const bx = sx + s - cw * 0.7, by = sy + s - ch * 0.7;
            D.rr(c, bx, by, cw, ch, ch / 2);
            c.fillStyle = dim ? "rgba(30,30,30,0.85)" : "rgba(0,0,0,0.85)";
            c.fill();
            D.hudTitle(plusLabel(hk), bx + cw / 2, by + ch / 2, Math.max(8, 9.5 * z), "#ffffff", "center", dim ? 0.7 : 1, c);
        }
    }
    const ring = (i, col, lwR) => {
        if (i < 0 || !vis[i]) return;
        const n = g.inst[i];
        const sx = n.x * z + ox, sy = n.y * z + oy;
        if (sx < cullX0 || sx > W + 4 || sy < cullY0 || sy > H + 4) return;
        D.rr(c, sx - 3, sy - 3, s + 6, s + 6, Math.max(3, 7 * z));
        c.lineWidth = lwR;
        c.strokeStyle = col;
        c.stroke();
    };
    ring(cur, D.HUD.gold, Math.max(2, 3.5 * z));
    if (sel >= 0 && sel !== cur) ring(sel, "#ffffff", Math.max(1.5, 2.5 * z));
    if (hover >= 0 && hover !== sel && hover !== cur) ring(hover, "rgba(255,255,255,0.7)", Math.max(1.5, 2 * z));
    if (cur >= 0 && vis[cur] && s > 30) {
        const n = g.inst[cur];
        const sx = n.x * z + ox + s / 2, sy = n.y * z + oy - Math.max(9, 10 * z);
        if (sx > -60 && sx < W + 60 && sy > -20 && sy < H) D.hudTitle("You", sx, sy, Math.max(10, 12 * z), D.HUD.gold, "center", 1, c);
    }
    drawTierLabels(c, oy, z);
}

const plusCache = [];
function plusLabel(n) {
    let s = plusCache[n];
    if (!s) s = plusCache[n] = "+" + n;
    return s;
}
const tierCache = [];
function tierLabel(t) {
    let s = tierCache[t];
    if (!s) s = tierCache[t] = t >= L.T5_TIER ? "Tier " + t + " (" + D.t5Label() + ")" : "Tier " + t;
    return s;
}

function drawTierLabels(c, oy, z) {
    const r = box.rows;
    const fs = D.mobile() ? 12 : 13;
    const top = headH() + 4;
    for (let i = 0; i < r.length; i += 2) {
        const y = r[i] * z + oy + TILE * z / 2;
        if (y < top || y > H - 6) continue;
        const t = r[i + 1];
        const label = tierLabel(t);
        const w = D.hudTitleW(label, fs) + 16;
        D.hudPanel(c, 8, y - 11, w, 22, { r: 4, alpha: 0.9 });
        D.hudTitle(label, 16, y, fs, t >= L.T5_TIER ? D.HUD.gold : "#ffffff", "left", 1, c);
    }
}

function drawButton(c, b, x, y, w, h, label, fill, size) {
    const o = b * 4;
    btn[o] = x; btn[o + 1] = y; btn[o + 2] = w; btn[o + 3] = h;
    D.hudPanel(c, x, y, w, h, { fill: btnHover === b ? lighten(fill) : fill, stroke: "rgba(0,0,0,0.6)", r: 5 });
    D.hudTitle(label, x + w / 2, y + h / 2, size, "#ffffff", "center", 1, c);
}
const lightCache = new Map();
function lighten(col) {
    let v = lightCache.get(col);
    if (!v) { v = D.mix(col, "#ffffff", 0.18); lightCache.set(col, v); }
    return v;
}

function drawHeader(c, ready) {
    const mob = D.mobile();
    const hh = headH();
    D.hudPanel(c, 0, 0, W, hh, { fill: "rgba(0,0,0,0.5)", r: 0 });
    const bh = mob ? 40 : 34, by = (mob ? (hh - bh) / 2 : 10);
    const closeW = bh + (mob ? 6 : 0);
    const bx = W - 12 - closeW;
    drawButton(c, 0, bx, by, closeW, bh, "X", D.HUD.danger, mob ? 20 : 17);
    if (ready) {
        const l1 = whole ? "Your path" : "Whole tree";
        const w1 = D.hudTitleW(l1, 15) + 26;
        drawButton(c, 1, bx - 10 - w1, by, w1, bh, l1, "#3f7fd8", 15);
        const l2 = "Find me";
        const w2 = D.hudTitleW(l2, 15) + 26;
        drawButton(c, 2, bx - 20 - w1 - w2, by, w2, bh, l2, "#4a9a4f", 15);
    } else { btn[6] = 0; btn[10] = 0; }
    D.hudTitle("Tank Tree", W / 2, W >= 900 ? (mob ? 17 : 19) : hh / 2, mob ? 19 : 22, "#ffffff", "center", 1, c);
    const sub = !ready ? "" : whole ? "Every tank in the game. Zoom in to read the names." : "Your path is gold. Faded tanks are the other choices.";
    if (sub && W >= 900) D.hudTitle(sub, W / 2, mob ? 38 : 42, mob ? 11 : 13, "#d8d8d8", "center", 1, c);
    if (ready) {
        const hint = mob ? HINT_TOUCH : HINT;
        const fs = mob ? 11 : 12;
        const w = Math.min(W - 16, D.hudTitleW(hint, fs) + 24);
        D.hudPanel(c, W / 2 - w / 2, H - 30, w, 24, { fill: "rgba(0,0,0,0.6)", r: 5 });
        D.hudTitle(hint, W / 2, H - 18, fs, "#e0e0e0", "center", 1, c);
    }
}
const HINT = "Drag or use the arrow keys to move. Scroll to zoom. Click a tank to centre it, E shows its upgrades. Tab: whole tree. Esc or T closes.";
const HINT_TOUCH = "Drag to move, pinch to zoom. Tap a tank twice to show its upgrades.";

function drawTip(c) {
    const i = tip.i;
    if (i < 0 || !vis[i]) return;
    const n = g.inst[i];
    const z = view.z, ox = W / 2 - view.x * z, oy = H / 2 - view.y * z;
    const s = TILE * z;
    let x = n.x * z + ox + s / 2 - tip.w / 2, y = n.y * z + oy + (TILE + NAME_H) * z + 8;
    if (y + tip.h > H - 36) y = n.y * z + oy - tip.h - 10;
    x = Math.max(8, Math.min(W - tip.w - 8, x));
    y = Math.max(headH() + 6, Math.min(H - tip.h - 36, y));
    D.hudPanel(c, x, y, tip.w, tip.h, { fill: "#202022", stroke: "rgba(0,0,0,0.8)" });
    D.hudTitle(tip.name, x + 12, y + 17, 16, n.tier >= L.T5_TIER ? D.HUD.gold : "#ffffff", "left", 1, c);
    for (let j = 0; j < tip.lines.length; j++) D.hudTitle(tip.lines[j], x + 12, y + 38 + j * 17, 12, j === 0 ? "#ffffff" : "#d0d0d0", "left", 1, c);
}

export function stats() {
    let sum = 0, max = 0;
    for (let i = 0; i < frameN; i++) { sum += frameMs[i]; max = Math.max(max, frameMs[i]); }
    return {
        open: isOpen, whole, nodes: g ? g.inst.length : 0, tanks: g ? g.tanks.size : 0,
        visible: vis ? vis.reduce((a, b) => a + b, 0) : 0, cur, curName: cur >= 0 && g ? g.inst[cur].tank.name : "",
        view: { x: view.x, y: view.y, z: view.z }, fit, built: built.slice(), frames: frameN, avgMs: frameN ? sum / frameN : 0, maxMs: max,
    };
}

export function resetStats() { frameN = 0; frameAt = 0; }

export function qa(cmd, a, b) {
    if (!g) return null;
    if (cmd === "zoom") { L.zoomAbout(view, a, W / 2, H / 2, W, H, fit); goal.on = false; }
    else if (cmd === "whole") setWhole(!!a);
    else if (cmd === "find") { const i = g.inst.findIndex(n => n.tank.name === a); if (i >= 0) { sel = i; centreOn(i, b || view.z); } return i; }
    else if (cmd === "expand") { const i = g.inst.findIndex(n => n.tank.name === a && vis[n.i]); if (i >= 0) toggle(i); return i; }
    else if (cmd === "hover") { mouse.x = a; mouse.y = b; hoverDirty = true; }
    else if (cmd === "pos") {
        const i = g.inst.findIndex(n => n.tank.name === a && vis[n.i]);
        if (i < 0) return null;
        const n = g.inst[i], z = view.z;
        const ux = (n.x + TILE / 2 - view.x) * z + W / 2, uy = (n.y + TILE / 2 - view.y) * z + H / 2;
        const iw = window.innerWidth || W, ih = window.innerHeight || H;
        return { x: ux * iw / W, y: uy * ih / H, i };
    }
    else if (cmd === "btn") { const o = a * 4; const iw = window.innerWidth || W, ih = window.innerHeight || H; return { x: (btn[o] + btn[o + 2] / 2) * iw / W, y: (btn[o + 1] + btn[o + 3] / 2) * ih / H }; }
    return stats();
}
