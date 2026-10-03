// Sidekicks in a raid: the server only sends who has one (SK packets, see
// server/game/terrain/sidekicks.js); everything else happens here. Each
// sidekick is moved by sidekickMath.js beside its owner's tank and drawn
// from baked sprites: the barrels (turned smoothly with one rotated
// drawImage a frame, no angle steps), the body with its face (a plain
// blit), an Auto turret if it has one (rotated like the barrels), then its
// name tag. On a software canvas a rotated bitmap is the slow path, so
// there the barrels are drawn as paths under the same rotation instead
// (20 sidekicks: ~4 ms as paths vs ~10 ms blitted, the old 24 baked angles
// were ~4 ms; on a GPU canvas the blit is the cheaper one). Sprites and tags are baked at the size they show on screen (2 px
// steps), at most one bake a frame, and nothing is allocated per frame.
// Its shots are a small fixed pool of pops that touch nothing.
//
// app.js calls:
//   note(instance, x, y, alpha, fade, size, falling)   for every tank it draws
//   draw(c, ratio, px, py)                              once, after the tanks
// (px, py: the camera, so the owner's drawn spot can be turned back into
// world units.) A sidekick is only drawn when note() saw its owner drawn
// this very frame (sidekickMath.shown), so it can never show where its owner
// doesn't: smoke, burrow, invisibility, the sky drop and death all hide it
// with the owner, and the server's hidden flag covers what the client can't
// see. Fewer Effects / Low effects / the auto low-end trim drop the shots.
import { config } from './config.js';
import { global } from './global.js';
import * as art from './sidekickArt.js';
import * as M from './sidekickMath.js';
import * as raidFinale from './raidFinale.js';

const CAT = () => (typeof window !== 'undefined' && window.DWCosmetics) || null;
const STEP = 2;               // sprite and tag sizes are baked in 2 px steps
const LABEL_WORLD = 10;       // tag font size in world units
const MAX_SPRITES = 32;
const SPRITE_PX_BUDGET = 3e6; // baked pixels across every sidekick sprite (~12 MB)
const MAX_SHOTS = 64;
const SHOT_GAP_MS = 40;       // across every sidekick on screen

const table = new Map();      // owner entity id -> entry
const sprites = new Map();    // nid:skin:colour:radius -> sprite | null
let frame = 0, baked = false, spritePx = 0;

export function count() { return table.size; }
export function has(id) { return table.has(id); }
export function reset() {
    table.clear();
    for (let i = 0; i < MAX_SHOTS; i++) shots.born[i] = -1e9;
}

/* ── the table (SK packets) ─────────────────────────────────────────── */
function add(row) {
    const C = CAT();
    if (!C || !Array.isArray(row)) return;
    const id = row[0] | 0;
    const kick = C.byNid(row[1] | 0);
    if (!kick || kick.cat !== 'sidekick') return;
    const skin = C.byNid(row[2] | 0), style = C.byNid(row[3] | 0);
    const col = typeof row[4] === 'string' && C.isSidekickColor(row[4]) ? row[4] : null;
    const look = skin && skin.cat === 'sdSkin' ? skin.look : null;
    table.set(id, {
        id, kick, look, skinNid: look ? skin.nid : 0,
        style: style && style.cat === 'sdName' ? style : null, col, body: art.bodyColor(kick.kick, look, col),
        name: String(row[5] || kick.name).slice(0, 24), hidden: !!row[6],
        size: kick.kick.size || 1,
        st: M.makeState(id, kick.kick.move), label: null, spr: null, lastT: 0,
        frame: -1, ok: false, ox: 0, oy: 0, wx: 0, wy: 0, oR: 20, of: 0, sx: 0, sy: 0,
    });
}
export function onPacket(d) {
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d.f)) { table.clear(); for (const r of d.f) add(r); }
    if (Array.isArray(d.a)) for (const r of d.a) add(r);
    if (Array.isArray(d.d)) for (const id of d.d) table.delete(id | 0);
    if (Array.isArray(d.h)) for (const f of d.h) { const e = table.get(f[0] | 0); if (e) e.hidden = !!f[1]; }
}

/* ── per frame ──────────────────────────────────────────────────────── */
const lowFx = () => !!(config.graphical.fewerEffects || config.graphical.fxLevel === 0 || global.lowFx);
// software rendering (the terrain renderer found no GPU), as stormFx.js
const softCanvas = () => { const tr = typeof window !== 'undefined' && window.terrainRenderer; return !!(tr && tr._rockQuality != null && tr._rockQuality < 1); };

// The entity pass drew this tank at screen (x, y): remember it for draw().
export function note(inst, x, y, alpha, fade, size, falling) {
    const e = table.get(inst.id);
    if (!e) return;
    e.frame = frame;
    e.ox = x; e.oy = y;
    e.wx = inst.render.x; e.wy = inst.render.y;
    e.oR = size || inst.size || 20;
    e.of = inst.render.f || 0;
    e.ok = M.shown(e.hidden, alpha, fade, falling, raidFinale.active());
}

export function draw(c, ratio, px, py) {
    const now = performance.now(), t = now / 1000;
    const low = lowFx();
    baked = false;
    // the sky drop's wide view: tanks are specks, so are these
    const wide = global.dropZoom < 0.75;
    const cam = px === px && py === py && px != null && py != null;
    const hw = global.screenWidth / 2, hh = global.screenHeight / 2;
    const soft = softCanvas();
    for (const e of table.values()) {
        if (e.frame !== frame || !e.ok || wide) continue;
        // the owner where it was drawn, in world units: its interpolated
        // spot (renderx / rendery for your own tank), whatever the camera did
        if (cam) { e.wx = (e.ox - hw + px) / ratio; e.wy = (e.oy - hh + py) / ratio; }
        // back from hiding (or first sight): on its spot, fading in
        if (t - e.lastT > 0.4) e.st.init = false;
        const dt = e.lastT ? t - e.lastT : 0;
        e.lastT = t;
        const s = M.step(e.st, e.wx, e.wy, e.oR, e.of, e.size, t, dt);
        const sx = e.ox + (s.x - e.wx) * ratio, sy = e.oy + (s.y - e.wy) * ratio;
        const lift = s.hop * ratio, y = sy - lift;
        const rpx = M.R * e.size * ratio;
        const spr = sprite(e, rpx);
        if (!spr) continue;
        const k = rpx / spr.r;
        const fade = s.alpha < 1 ? s.alpha * s.alpha * (3 - 2 * s.alpha) : 1;
        if (fade <= 0.01) continue;
        if (lift > 1.5) {
            c.globalAlpha = 0.16 * fade;
            c.fillStyle = '#000000';
            c.beginPath(); c.ellipse(sx, sy + rpx * 0.9, rpx * 0.85, rpx * 0.3, 0, 0, Math.PI * 2); c.fill();
        }
        c.globalAlpha = fade;
        if (soft) paths(c, art.drawUnder, e.kick.kick, rpx, sx, y, s.face);
        else turned(c, spr.under, spr.un, sx, y, s.face, k);
        const pop = M.popScale(s, t);
        const w = spr.bn * k;
        if (!s.tilt && s.sq === 1 && pop === 1 && Math.abs(k - 1) < 0.02) {
            c.drawImage(spr.body, Math.round(sx - spr.bn / 2), Math.round(y - spr.bn / 2));
        } else {
            c.save();
            c.translate(sx, y);
            if (s.tilt) c.rotate(s.tilt);
            if (s.sq !== 1 || pop !== 1) c.scale((1 + (1 - s.sq) * 0.6) * (2 - pop), s.sq * pop);
            c.drawImage(spr.body, -w / 2, -w / 2, w, w);
            c.restore();
        }
        if (spr.over) {
            if (soft) paths(c, art.drawOver, e.kick.kick, rpx, sx, y, s.face);
            else turned(c, spr.over, spr.on, sx, y, s.face, k);
        }
        c.globalAlpha = 1;
        e.sx = sx; e.sy = y;
        drawLabel(c, e, ratio, fade);
        if (!low && now - lastShotAt >= SHOT_GAP_MS) {
            const a = M.shotDue(s, t, Math.random);
            if (a === a) { lastShotAt = now; fire(e, a, t); }
        } else if (low) s.firing = false;
    }
    drawShots(c, ratio, t, low);
    frame++;
}

// One sprite drawn turned by `a` about (x, y): a single drawImage under a
// rotation, so the barrels turn as smoothly as the frame rate allows.
function turned(c, cv, n, x, y, a, k) {
    const w = n * k;
    c.save();
    c.translate(x, y);
    c.rotate(a);
    c.drawImage(cv, -w / 2, -w / 2, w, w);
    c.restore();
}

// The same layer drawn fresh as paths, turned by `a` (software canvases).
function paths(c, fn, kick, r, x, y, a) {
    c.save();
    c.translate(x, y);
    c.rotate(a);
    fn(c, kick, r);
    c.restore();
}

/* ── sprites ────────────────────────────────────────────────────────── */
function bake(n, drawFn) {
    const cv = document.createElement('canvas');
    cv.width = n; cv.height = n;
    const x = cv.getContext('2d');
    x.translate(n / 2, n / 2);
    drawFn(x);
    spritePx += n * n;
    return cv;
}
function forget(key) {
    const s = sprites.get(key);
    sprites.delete(key);
    if (s) spritePx -= s.px;
}
// The sprites at this on-screen radius. One bake a frame at most; until its
// turn comes the sidekick borrows the size it had before (scaled).
function sprite(e, rpx) {
    const r = Math.max(6, Math.min(64, Math.round(rpx / STEP) * STEP));
    const key = e.kick.nid + ':' + e.skinNid + ':' + (e.col || '') + ':' + r;
    let s = sprites.get(key);
    if (s === undefined) {
        if (baked) return e.spr;
        baked = true;
        while (sprites.size && (sprites.size >= MAX_SPRITES || spritePx > SPRITE_PX_BUDGET)) forget(sprites.keys().next().value);
        try {
            const kick = e.kick.kick, before = spritePx;
            // +2: a pixel of room each side for the outline's antialiasing
            const un = Math.ceil(2 * art.underReach(kick) * r) + 2;
            const bn = Math.ceil(2 * art.bodyReach(kick) * r) + 2;
            const on = art.hasOver(kick) ? Math.ceil(2 * art.overReach(kick) * r) + 2 : 0;
            s = {
                r, un, bn, on,
                under: bake(un, (x) => art.drawUnder(x, kick, r)),
                body: bake(bn, (x) => art.drawBody(x, kick, e.look, r, e.col)),
                over: on ? bake(on, (x) => art.drawOver(x, kick, r)) : null,
            };
            s.px = spritePx - before;
        } catch (err) { s = null; }
        sprites.set(key, s);
    }
    if (s) e.spr = s;
    return s || e.spr;
}

// The name tag, baked at the size it shows (2 px steps): its name style,
// or plain in a light shade of its colour.
function label(e, px) {
    if (e.label && (e.label.px === px || baked)) return e.label;
    baked = true;
    try { e.label = art.bakeName(e.name, px, e.style, art.mix(e.body, '#ffffff', 0.45), 1); } catch (err) { /* keep the old one */ }
    return e.label;
}
function drawLabel(c, e, ratio, fade) {
    const px = LABEL_WORLD * ratio;
    if (px < 5) return;
    const L = label(e, Math.max(6, Math.min(40, Math.round(px / STEP) * STEP)));
    if (!L) return;
    const k = px / L.px;
    const top = e.sy - (M.R * e.size * 1.25 + 3) * ratio - L.h * k;
    if (fade < 1) c.globalAlpha = fade;
    if (Math.abs(k - 1) < 0.08) c.drawImage(L.cv, Math.round(e.sx - L.w / 2), Math.round(top));
    else c.drawImage(L.cv, e.sx - L.w * k / 2, top, L.w * k, L.h * k);
    c.globalAlpha = 1;
}

/* ── shots: a fixed pool, nothing allocated ─────────────────────────── */
const shots = {
    born: new Float64Array(MAX_SHOTS).fill(-1e9), x: new Float32Array(MAX_SHOTS), y: new Float32Array(MAX_SHOTS),
    vx: new Float32Array(MAX_SHOTS), vy: new Float32Array(MAX_SHOTS), a: new Float32Array(MAX_SHOTS),
    owner: new Int32Array(MAX_SHOTS), kind: new Array(MAX_SHOTS).fill('bullet'), col: new Array(MAX_SHOTS).fill('#ffffff'), size: new Float32Array(MAX_SHOTS),
};
let shotI = 0, lastShotAt = 0;
const KIND = { trap: 'trap', drone: 'drone' };
function shot(e, x, y, a, kind, size, t) {
    const i = shotI; shotI = (shotI + 1) % MAX_SHOTS;
    shots.born[i] = t; shots.owner[i] = e.id; shots.a[i] = a;
    shots.x[i] = x; shots.y[i] = y;
    const sp = kind === 'ring' ? 0 : M.SHOT_SPEED;
    shots.vx[i] = Math.cos(a) * sp; shots.vy[i] = Math.sin(a) * sp;
    shots.kind[i] = kind; shots.col[i] = e.body; shots.size[i] = size;
}
// a pop from every barrel (a Smasher just pops where it is)
function fire(e, face, t) {
    const r = M.R * e.size, guns = e.kick.kick.guns, st = e.st;
    if (!guns.length) { shot(e, st.x, st.y, face, 'ring', r * 0.9, t); return; }
    const ca = Math.cos(face), sa = Math.sin(face);
    for (let g = 0; g < guns.length && g < 8; g++) {
        const G = guns[g], m = art.muzzle(G);
        const mx = (m[0] * ca - m[1] * sa) * r, my = (m[0] * sa + m[1] * ca) * r;
        shot(e, st.x + mx, st.y + my, face + G[0] * Math.PI / 180, KIND[G[5]] || 'bullet', r * Math.max(0.2, Math.min(0.42, G[2] * 0.36)), t);
    }
}
function drawShots(c, ratio, t, low) {
    for (let i = 0; i < MAX_SHOTS; i++) {
        const age = t - shots.born[i];
        if (age < 0 || age >= M.SHOT_LIFE) continue;
        // drawn from its owner's spot this frame, and gone with the owner
        const e = table.get(shots.owner[i]);
        if (low || !e || e.frame !== frame || !e.ok) { shots.born[i] = -1e9; continue; }
        const k = age / M.SHOT_LIFE;
        // quick out of the barrel, easing off as it pops
        const d = age * (1 - 0.45 * k);
        const wx = shots.x[i] + shots.vx[i] * d, wy = shots.y[i] + shots.vy[i] * d;
        c.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
        art.drawShot(c, shots.kind[i], e.ox + (wx - e.wx) * ratio, e.oy + (wy - e.wy) * ratio, shots.size[i] * ratio, shots.a[i], shots.col[i], k);
    }
    c.globalAlpha = 1;
}

// QA: what the client thinks is out there
export function debug() {
    return [...table.values()].map((e) => ({ id: e.id, kick: e.kick.id, name: e.name, hidden: e.hidden, ok: e.ok, x: Math.round(e.st.x), y: Math.round(e.st.y), shots: e.st.shots, snaps: e.st.snaps }));
}
