// Sidekicks in a raid: the server only sends who has one (SK packets, see
// server/game/terrain/sidekicks.js); everything else happens here. Each
// sidekick is moved by sidekickMath.js beside its owner's tank and drawn
// from baked sprites: the barrels (turned smoothly with one rotated
// drawImage a frame, no angle steps), the body with its face, an Auto
// turret if it has one (rotated like the barrels), then its name tag. On a
// software canvas a rotated bitmap is the slow path, so there the barrels
// are drawn as paths under the same rotation instead (20 sidekicks: ~4 ms
// as paths vs ~10 ms blitted, the old 24 baked angles were ~4 ms; on a GPU
// canvas the blit is the cheaper one). Sprites are baked on a ladder of
// radii about 7% apart and drawn scaled down from the rung above (so they
// never stretch up and go soft), tags in 2 px steps, at most one bake a
// frame, and nothing is allocated per frame. Everything is drawn at its
// exact sub-pixel spot: rounding to whole pixels made it shuffle against
// its owner while the camera moved. Its shots are a small fixed pool of
// pops that touch nothing.
//
// It runs on the frame's own clock (the rAF time app.js draws the tanks
// with), not performance.now() read halfway through the frame: that wobbled
// dt by the frame's own work and shook the sidekick against its owner.
// What it can see (enemies, gems, chests on screen) is looked up a few times
// a second, but whatever it looks at is followed where it is drawn, every
// frame.
//
// app.js calls:
//   note(instance, x, y, alpha, fade, size, falling)   for every tank it draws
//   draw(c, ratio, px, py, tick, me)                    once, after the tanks
// (px, py: the camera, so the owner's drawn spot can be turned back into
// world units; tick: the frame time; me: your own tank's id.) socketinit.js
// calls cheer(id) / cheerNear(x, y) when something good happens. A sidekick
// is only drawn when note() saw its owner drawn
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
const STEP = 2;               // tags are baked in 2 px steps
const LABEL_WORLD = 10;       // tag font size in world units (a fresh owner's)
const MAX_SPRITES = 32;
const SENSE_EVERY = 0.2;      // seconds between looks round for enemies and gems
const ENEMY_NEAR = 750;       // world units from the owner
const THING_NEAR = 420;
// sprite radii, about 7% apart
const RUNGS = [];
for (let r = 6; r <= 96; r = Math.max(r + 1, Math.round(r * 1.07))) RUNGS.push(r);
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
    tanks.length = 0; things.length = 0;
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
        st: M.makeState(id, kick.kick.move), label: null, spr: null, lastT: 0, lastReal: 0,
        frame: -1, ok: false, ox: 0, oy: 0, wx: 0, wy: 0, oR: 20, sx: 0, sy: 0,
        enemy: null, thing: null, sense: { ex: NaN, ey: NaN, gx: NaN, gy: NaN, gr: 0 },
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
    e.ok = M.shown(e.hidden, alpha, fade, falling, raidFinale.active());
}

// The frame clock: steady seconds from app.js's frame time. A stall or a
// clock switch (a hidden tab steps frames off Date.now) counts as 0.1 s.
let clockT = 0, lastTick = NaN, senseAt = -1e9;
function advance(tick) {
    const ms = tick - lastTick;
    lastTick = tick;
    if (ms > 0) clockT += Math.min(ms, 100) / 1000;
    return clockT;
}

/* ── what they can see ──────────────────────────────────────────────── */
const tanks = [], things = [];
let meId = -1;
function mateOf() { const r = global.royale; return r && r.duos && r.duo && r.duo.mate ? r.duo.mate.id : -1; }
// Tanks, gems and chests the entity pass just drew on screen (it tags gems
// _gemCls and chests _chest as it draws them). A few times a second.
function scan() {
    tanks.length = 0; things.length = 0;
    const list = global.entities;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
        const q = list[i];
        if (!q || !q._onScreen || !q.render) continue;
        if (q._gemCls || q._chest) { if (things.length < 48) things.push(q); }
        else if (q.nameplate && !(q.alpha < 0.5) && tanks.length < 32) tanks.push(q);
    }
}
const ally = (e, q, mate) => q.id === e.id || (e.id === meId && q.id === mate) || (e.id === mate && q.id === meId);
function pick(e, mate) {
    let best = ENEMY_NEAR * ENEMY_NEAR * e.st.sc * e.st.sc, en = null;
    for (let i = 0; i < tanks.length; i++) {
        const q = tanks[i];
        if (ally(e, q, mate)) continue;
        const d = (q.render.x - e.wx) ** 2 + (q.render.y - e.wy) ** 2;
        if (d < best) { best = d; en = q; }
    }
    e.enemy = en;
    best = THING_NEAR * THING_NEAR * e.st.sc * e.st.sc; en = null;
    for (let i = 0; i < things.length; i++) {
        const q = things[i];
        const d = (q.render.x - e.wx) ** 2 + (q.render.y - e.wy) ** 2;
        if (d < best) { best = d; en = q; }
    }
    e.thing = en;
}
// Where those are drawn this frame, in world units (the same sum the owner
// goes through, so it looks right at them, not where the network had them).
function senseOf(e, ratio, px, py, hw, hh, cam) {
    const S = e.sense, en = e.enemy, th = e.thing;
    if (en && en._onScreen) {
        S.ex = cam ? (en._sx - hw + px) / ratio : en.render.x;
        S.ey = cam ? (en._sy - hh + py) / ratio : en.render.y;
    } else { S.ex = NaN; S.ey = NaN; }
    if (th && th._onScreen) {
        S.gx = cam ? (th._sx - hw + px) / ratio : th.render.x;
        S.gy = cam ? (th._sy - hh + py) / ratio : th.render.y;
        S.gr = th.size || 10;
    } else { S.gx = NaN; S.gy = NaN; }
    return S;
}

// Something good happened to this owner (banked, a kill, a pickup): its
// sidekick has a little bounce about. k 0..1.
export function cheer(id, k) {
    const e = table.get(id | 0);
    if (e && e.st.init) M.cheer(e.st, clockT, k);
}
// ...or right next to it (a chest broke, a tank went down): every sidekick
// whose owner is within `range` world units.
export function cheerNear(x, y, k, range) {
    const r2 = (range || 420) ** 2;
    for (const e of table.values()) if (e.st.init && (e.wx - x) ** 2 + (e.wy - y) ** 2 < r2) M.cheer(e.st, clockT, k);
}

function rung(rpx) {
    for (let i = 0; i < RUNGS.length; i++) if (RUNGS[i] >= rpx) return RUNGS[i];
    return RUNGS[RUNGS.length - 1];
}

export function draw(c, ratio, px, py, tick, me) {
    const now = performance.now();
    const t = advance(tick === tick && tick != null ? tick : now);
    if (me != null) meId = me;
    const low = lowFx();
    baked = false;
    // the sky drop's wide view: tanks are specks, so are these
    const wide = global.dropZoom < 0.75;
    const cam = px === px && py === py && px != null && py != null;
    const hw = global.screenWidth / 2, hh = global.screenHeight / 2;
    const soft = softCanvas();
    const look = t - senseAt >= SENSE_EVERY;
    if (look) { senseAt = t; scan(); }
    const mate = look ? mateOf() : -1;
    for (const e of table.values()) {
        if (e.frame !== frame || !e.ok || wide) continue;
        // the owner where it was drawn, in world units: its interpolated
        // spot (renderx / rendery for your own tank), whatever the camera did
        if (cam) { e.wx = (e.ox - hw + px) / ratio; e.wy = (e.oy - hh + py) / ratio; }
        // back from hiding (or first sight): on its spot, fading in
        if (now - e.lastReal > 400) e.st.init = false;
        e.lastReal = now;
        const dt = e.st.init ? t - e.lastT : 0;
        e.lastT = t;
        if (look) pick(e, mate);
        const s = M.step(e.st, e.wx, e.wy, e.oR, e.size, t, dt, senseOf(e, ratio, px, py, hw, hh, cam));
        const sx = e.ox + (s.x - e.wx) * ratio, sy = e.oy + (s.y - e.wy) * ratio;
        const lift = s.hop * ratio, y = sy - lift;
        const rpx = M.R * e.size * s.sc * ratio;
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
        if (!s.tilt && s.sq === 1 && pop === 1) {
            c.drawImage(spr.body, sx - w / 2, y - w / 2, w, w);
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
        drawLabel(c, e, ratio, fade, s.sc);
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
// The sprites for this on-screen radius: baked at the rung just above it
// and drawn a little smaller. One bake a frame at most; until its turn
// comes the sidekick borrows the size it had before (scaled).
function sprite(e, rpx) {
    const r = rung(rpx);
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
// The tag grows a little with its sidekick (the square root of it).
function drawLabel(c, e, ratio, fade, sc) {
    const px = LABEL_WORLD * Math.sqrt(sc || 1) * ratio;
    if (px < 5) return;
    const L = label(e, Math.max(6, Math.min(40, Math.round(px / STEP) * STEP)));
    if (!L) return;
    const k = px / L.px;
    const top = e.sy - (M.R * e.size * (sc || 1) * 1.25 + 3) * ratio - L.h * k;
    if (fade < 1) c.globalAlpha = fade;
    c.drawImage(L.cv, e.sx - L.w * k / 2, top, L.w * k, L.h * k);
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
    const st = e.st, r = M.R * e.size * st.sc, guns = e.kick.kick.guns;
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
    return [...table.values()].map((e) => ({ id: e.id, kick: e.kick.id, name: e.name, hidden: e.hidden, ok: e.ok, x: Math.round(e.st.x), y: Math.round(e.st.y), shots: e.st.shots, snaps: e.st.snaps, sc: +e.st.sc.toFixed(2), face: +e.st.face.toFixed(3), look: e.st.look, enemy: e.enemy ? e.enemy.id : null }));
}
