// Live cosmetic previews for the menu (Item Shop, Locker, name box, chip).
// Tanks are drawn by the game's own drawEntity (window.dwDrawEntity) with
// a static set of preview mockups swapped into global.mockups only for the
// length of each draw (the menu has none until a game is joined). Animated
// items share one rAF ticker that runs only while a preview is on screen
// and the menu is showing.
import { global } from '../global.js';
import { util } from '../util.js';
import { gameDraw } from '../gameDraw.js';
import { color as themes } from '../color.js';
import * as cos from './cosmetics.js';
import { reducedMotion } from './ui.js';
import * as skArt from '../sidekickArt.js';
import * as skMath from '../sidekickMath.js';

export const FLOOR = '#1e1d1b';
// The 11 team colours of the swatch row, as game colour strings.
export const TEAM_COLORS = [
    ['Blue', 10], ['Green', 11], ['Red', 12], ['Purple', 15], ['Violet', 14], ['Yellow', 25],
    ['Orange', 26], ['Brown', 27], ['Cyan', 28], ['Lemon', 3], ['Grey', 17],
].map(([name, n]) => ({ name, col: n + ' 0 1 0 false' }));
export const TANKS = [
    ['basic', 'Basic'], ['twin', 'Twin'], ['sniper', 'Sniper'], ['machineGun', 'Machine Gun'],
    ['flankGuard', 'Flank Guard'], ['pounder', 'Pounder'], ['director', 'Director'], ['smasher', 'Smasher'],
];

let PM = null, pmLoad = null;
export function ready() {
    if (!pmLoad) {
        // versioned and revalidated: a bad copy cached once (the server used
        // to answer this with the home page) can't stick around
        pmLoad = fetch(new URL('./preview-mockups.json?v=2', import.meta.url), { cache: 'no-cache' })
            .then((r) => r.json())
            .then((j) => { PM = j; return true; })
            .catch((e) => { console.warn('[previews] no mockups', e); return false; });
    }
    return pmLoad;
}

// Hex of a game colour string in the dark theme (what the swatch shows).
export function teamHex(col) {
    return withTheme(() => gameDraw.modifyColor(col));
}
function withTheme(fn) {
    const had = gameDraw.color;
    if (!had) gameDraw.color = themes.dark;
    try { return fn(); } finally { if (!had) { gameDraw.color = had; gameDraw.colorCache = {}; } }
}

// Draw a tank centred at (x, y) with body radius r, facing `rot`.
export function drawTank(c, x, y, r, opts) {
    const draw = window.dwDrawEntity;
    if (!PM || !draw) return false;
    const col = opts.color || TEAM_COLORS[0].col;
    const idx = PM.names[opts.tank] || PM.names.basic;
    const saved = global.mockups;
    global.mockups = PM.mockups;
    try {
        withTheme(() => {
            const pic = util.getEntityImageFromMockup(String(idx), col);
            pic.realSize = pic.size;
            pic.skin = opts.skin | 0;
            pic.skinForce = true;
            draw(col, x, y, pic, 1, 1, r / pic.size, 1, opts.rot == null ? -Math.PI / 4 : opts.rot, true, c);
        });
    } catch (e) {
        console.warn('[previews] draw failed', e);
    } finally {
        global.mockups = saved;
    }
    return true;
}

/* ── canvases ───────────────────────────────────────────────────────── */
// A canvas at css size w x h with a device-pixel backing store.
export function canvas(w, h, cls) {
    const cv = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    if (cls) cv.className = cls;
    cv.setAttribute('aria-hidden', 'true');
    cv._dpr = dpr;
    return cv;
}
function begin(cv) {
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(cv._dpr, 0, 0, cv._dpr, 0, 0);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    return c;
}

/* ── the ticker ─────────────────────────────────────────────────────── */
// Sidekick stages draw every frame (60 fps), everything else at ~30.
// A canvas scrolled out of view or under a closed pane is skipped; with
// nothing left on screen the loop stops, and the next mount, menu change
// or canvas scrolling back into view starts it again.
const live = new Set();
let raf = 0, lastTick = 0;
const onScreen = (L) => L.vis && L.cv.isConnected && L.cv.offsetParent !== null;
const seen = typeof IntersectionObserver === 'function' ? new IntersectionObserver((list) => {
    for (const en of list) { const L = en.target._dwLive; if (L) L.vis = en.isIntersecting; }
    kick();
}) : null;
function tick(now) {
    raf = 0;
    if (document.hidden || document.body.classList.contains('in-game')) return;
    let any = false;
    const due = now - lastTick >= 32;
    if (due) lastTick = now;
    for (const L of live) {
        if (!L.cv.isConnected) {
            if (L.seen || now - L.born > 3000) { live.delete(L); if (seen) seen.unobserve(L.cv); } else any = true;
            continue;
        }
        L.seen = true;
        if (!onScreen(L)) continue;
        any = true;
        if (due || L.smooth) { try { L.draw(now / 1000); } catch (e) { live.delete(L); console.warn(e); } }
    }
    if (any) raf = requestAnimationFrame(tick);
}
export function kick() { if (!raf && live.size) raf = requestAnimationFrame(tick); }
document.addEventListener('visibilitychange', kick);
new MutationObserver(kick).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// Draw now, and again every frame while `animated` (and motion is allowed);
// smooth: every frame rather than every other.
function mount(cv, draw, animated, smooth) {
    const run = (t) => draw(begin(cv), t);
    ready().then(() => run(0));
    if (animated && !reducedMotion()) {
        const L = { cv, draw: run, seen: false, born: performance.now(), smooth: !!smooth, vis: true };
        live.add(L);
        if (seen) { cv._dwLive = L; seen.observe(cv); }
        kick();
        cv._dwStop = () => { live.delete(L); if (seen) seen.unobserve(cv); };
    }
    return cv;
}

const itemOf = (x) => (x && x.nid ? x : (typeof x === 'string' ? cos.byId(x) : x)) || null;
function animatedItem(it) {
    if (!it) return false;
    if (it.cat === 'skin') return !!(it.skin && it.skin.emissive);
    return cos.isAnimatedStyle(it);
}

// Tank preview with a skin. opts: { w, h, skin (item|id|nid), color, tank, rot, size }
export function tankPreview(opts) {
    const w = opts.w, h = opts.h;
    const cv = canvas(w, h, opts.cls || 'dw-prev');
    const it = typeof opts.skin === 'number' ? cos.skinOf(opts.skin) : itemOf(opts.skin);
    const r = opts.size || Math.min(w, h) * 0.26;
    return mount(cv, (c, t) => {
        drawTank(c, w / 2 - r * 0.25, h / 2 + r * 0.08, r, { tank: opts.tank, color: opts.color, skin: it ? it.nid : 0, rot: opts.rot });
    }, animatedItem(it));
}

// Nameplate preview: a styled name over a small tank.
// opts: { w, h, name, style (item|id), custom (hex), color, tank, skin, px }
export function namePreview(opts) {
    const w = opts.w, h = opts.h;
    const cv = canvas(w, h, opts.cls || 'dw-prev');
    const st = itemOf(opts.style);
    const sk = typeof opts.skin === 'number' ? cos.skinOf(opts.skin) : itemOf(opts.skin);
    const px = opts.px || Math.round(Math.min(26, h * 0.17));
    const r = opts.r || Math.min(h * 0.2, w * 0.14);
    return mount(cv, (c, t) => {
        const ty = h * 0.66;
        drawTank(c, w / 2 - r * 0.25, ty, r, { tank: opts.tank, color: opts.color, skin: sk ? sk.nid : 0, rot: opts.rot });
        const fallback = opts.custom || '#f2f2f2';
        cos.drawStyledName(c, opts.name || 'Player', w / 2, ty - r * 2.15, px, st, fallback, { align: 'center', stroke: true, time: t });
    }, animatedItem(st) || animatedItem(sk));
}

// A styled name alone (name box, chip, tiles). The canvas is sized to the
// text. opts: { px, font, stroke, custom, h, maxW }
export function nameCanvas(name, style, opts) {
    opts = opts || {};
    const st = itemOf(style);
    const font = opts.font || 'Ubuntu, Rubik, sans-serif';
    const m = document.createElement('canvas').getContext('2d');
    const glyph = st && st.style && st.style.glyph ? ' ' + st.style.glyph : '';
    const padFor = (size) => opts.stroke ? Math.ceil(size * (st && st.style && st.style.halo ? 0.38 : 0.3)) : 2;
    const widthAt = (size) => { m.font = 'bold ' + size + 'px ' + font; return Math.ceil(m.measureText(name + glyph).width) + padFor(size) * 2; };
    const want = opts.px || 14;
    let px = want, tw = widthAt(px);
    while (opts.maxW && tw > opts.maxW && px > 8) { px -= 1; tw = widthAt(px); }
    const pad = padFor(px);
    const w = opts.maxW ? Math.min(opts.maxW, tw) : tw;
    const h = opts.h || Math.ceil(want * 1.45);
    const cv = canvas(w, h, opts.cls || 'dw-name-cv');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', name);
    cv.removeAttribute('aria-hidden');
    return mount(cv, (c, t) => {
        cos.drawStyledName(c, name, pad, h / 2 + px * 0.04, px, st, opts.custom || opts.fallback || '#f2f2f2', { stroke: !!opts.stroke, time: t, font });
    }, animatedItem(st));
}

/* ── sidekicks ──────────────────────────────────────────────────────── */
const kickOf = (x) => { const it = itemOf(x); return it && it.cat === 'sidekick' ? it : cos.byId('sd_buddy'); };
const lookOf = (x) => { const it = itemOf(x); return it && it.cat === 'sdSkin' ? it.look : null; };
// the name tag's plain colour, as in the game (sidekicks.js)
function plainName(kick, look, col) { return skArt.mix(skArt.bodyColor(kick.kick, look, col), '#ffffff', 0.45); }

// Name tags come baked (sidekickArt.bakeName); the recent ones are kept.
const tags = new Map();
function tagFor(name, px, style, plain) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const key = name + '|' + px + '|' + (style ? style.id : '') + '|' + plain + '|' + dpr;
    let t = tags.get(key);
    if (!t) {
        t = skArt.bakeName(name, px, style, plain, dpr);
        tags.set(key, t);
        if (tags.size > 48) tags.delete(tags.keys().next().value);
    }
    return t;
}
function drawTag(c, t, x, y) { c.drawImage(t.cv, x - t.w / 2, y - t.h / 2, t.w, t.h); }

// A sidekick's little show, the same rules as in a raid (sidekickMath.js):
// it bobs, swings its barrels, and pops a shot every couple of seconds.
// Positions in world units; k turns them into canvas px.
const SHOW_SHOTS = 10;
function newShow(kick, seed, path) {
    const pool = [];
    for (let i = 0; i < SHOW_SHOTS; i++) pool.push({ born: -1e9, x: 0, y: 0, vx: 0, vy: 0, a: 0, kind: 'bullet', s: 0 });
    return { st: skMath.makeState(seed, kick.kick.move, path), last: 0, pool, i: 0, o: { x: 0, y: 0, hop: 0, tilt: 0, sq: 1 } };
}
function showShoot(S, kick, r, t, live) {
    if (!live) return;
    const st = S.st;
    const face = skMath.shotDue(st, t, Math.random);
    if (face !== face) return;
    const guns = kick.kick.guns;
    const add = (x, y, a, kind, s) => {
        const p = S.pool[S.i]; S.i = (S.i + 1) % SHOW_SHOTS;
        const sp = kind === 'ring' ? 0 : skMath.SHOT_SPEED * 0.8;
        p.born = t; p.x = x; p.y = y; p.a = a; p.kind = kind; p.s = s; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
    };
    if (!guns.length) { add(st.x, st.y, face, 'ring', r * 0.9); return; }
    const ca = Math.cos(face), sa = Math.sin(face);
    for (let g = 0; g < guns.length && g < 8; g++) {
        const m = skArt.muzzle(guns[g]);
        add(st.x + (m[0] * ca - m[1] * sa) * r, st.y + (m[0] * sa + m[1] * ca) * r, face + guns[g][0] * Math.PI / 180,
            guns[g][5] === 'trap' ? 'trap' : guns[g][5] === 'drone' ? 'drone' : 'bullet', r * Math.max(0.2, Math.min(0.42, guns[g][2] * 0.36)));
    }
}
function showShots(c, S, t, cx, cy, k, col) {
    for (const p of S.pool) {
        const age = t - p.born;
        if (age < 0 || age >= skMath.SHOT_LIFE) continue;
        const q = age / skMath.SHOT_LIFE, d = age * (1 - 0.45 * q);
        c.globalAlpha = q < 0.7 ? 1 : 1 - (q - 0.7) / 0.3;
        skArt.drawShot(c, p.kind, cx + (p.x + p.vx * d) * k, cy + (p.y + p.vy * d) * k, p.s * k, p.a, col, q);
    }
    c.globalAlpha = 1;
}
// The sidekick itself at canvas (x, y), radius rp px, barrels at `face`.
function showKick(c, kick, look, col, x, y, rp, face, tilt, sq, pop) {
    c.save();
    c.translate(x, y);
    if (sq !== 1 || pop !== 1) c.scale((1 + (1 - sq) * 0.6) * (2 - pop), sq * pop);
    c.save(); c.rotate(face); skArt.drawUnder(c, kick.kick, rp); c.restore();
    c.save(); if (tilt) c.rotate(tilt); skArt.drawBody(c, kick.kick, look, rp, col); c.restore();
    if (kick.kick.turret) { c.rotate(face); skArt.drawOver(c, kick.kick, rp); }
    c.restore();
}
function floorShadow(c, x, y, rp, lift) {
    const k = Math.max(0.55, 1 - lift / (rp * 3));
    c.fillStyle = 'rgba(0,0,0,' + (0.28 * k).toFixed(3) + ')';
    c.beginPath(); c.ellipse(x, y + rp * 1.05, rp * 1.05 * k, rp * 0.3 * k, 0, 0, Math.PI * 2); c.fill();
}

// A sidekick on its own little stage (shop cards, Locker chips): it bobs,
// turns its barrels and pops the odd shot at 60 fps while it's on screen.
// opts: { w, h, kick, look (sdSkin item|id), col, r, name, style (sdName item|id), px, still }
export function sidekickPreview(opts) {
    const w = opts.w, h = opts.h;
    const cv = canvas(w, h, opts.cls || 'dw-prev');
    const kick = kickOf(opts.kick), look = lookOf(opts.look), st = itemOf(opts.style);
    const rp = opts.r || Math.min(w, h) * 0.2;
    const px = opts.px || Math.max(11, Math.round(rp * 0.6));
    const live = !opts.still && !reducedMotion();
    const col = opts.col || null, body = skArt.bodyColor(kick.kick, look, col);
    const S = newShow(kick, (Math.random() * 1e6) | 0);
    const k = rp / (skMath.R * (kick.kick.size || 1));
    return mount(cv, (c, t) => {
        const dt = S.last ? Math.min(0.1, t - S.last) : 0;
        S.last = t;
        const o = S.o;
        o.hop = 0; o.tilt = 0; o.sq = 1;
        if (live) skMath.MOVES[S.st.move](t, S.st.ph, 0, o);
        // an idle look about when it isn't aiming at anything
        if (live) { skMath.aimStep(S.st, -0.55 + Math.sin(t * 0.45 + S.st.ph) * 0.8, dt); showShoot(S, kick, skMath.R * (kick.kick.size || 1), t, live); }
        else S.st.face = -0.55;
        const lift = (o.hop + (live ? Math.sin(t * 2.3 + S.st.ph) * 1.2 : 0)) * k;
        const cx = w / 2, cy = h / 2 + (opts.name ? rp * 0.62 : rp * 0.05);
        floorShadow(c, cx, cy, rp, lift);
        showShots(c, S, t, cx, cy, k, body);
        showKick(c, kick, look, col, cx, cy - lift, rp, S.st.face, o.tilt, o.sq, live ? skMath.popScale(S.st, t) : 1);
        if (opts.name) drawTag(c, tagFor(opts.name, px, st, plainName(kick, look, col)), cx, cy - lift - rp * 1.35 - px * 0.55);
    }, live, true);
}

// A sidekick's name tag on its own (Locker chips), sized to the tag.
// opts: { px, kick, look, col, h, maxW }
export function sidekickName(name, style, opts) {
    opts = opts || {};
    const kick = kickOf(opts.kick), look = lookOf(opts.look);
    const t = tagFor(name, opts.px || 14, itemOf(style), plainName(kick, look, opts.col || null));
    const w = Math.ceil(opts.maxW ? Math.min(opts.maxW, t.w) : t.w), h = opts.h || Math.ceil(t.h);
    const cv = canvas(w, h, opts.cls || 'dw-name-cv');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', name);
    cv.removeAttribute('aria-hidden');
    return mount(cv, (c) => drawTag(c, t, w / 2, h / 2), false);
}

// The stage (Locker, shop item window): your tank with the sidekick going
// about its business on your right, moved by the game's own rules.
// opts: { w, h, tank, color (team colour), kick, look, col, name, style, r }
export function sidekickStage(opts) {
    const w = opts.w, h = opts.h;
    const cv = canvas(w, h, opts.cls || 'dw-prev');
    const kick = kickOf(opts.kick), look = lookOf(opts.look), st = itemOf(opts.style);
    const R = opts.r || Math.min(h * 0.17, w * 0.12);
    const OR = 30, k = R / OR;           // the tank is radius 30 in world units
    const live = !reducedMotion();
    const col = opts.col || null, body = skArt.bodyColor(kick.kick, look, col);
    const size = kick.kick.size || 1, rp = skMath.R * size * k;
    const px = Math.max(12, Math.round(R * 0.36));
    const S = newShow(kick, 7, 'show');
    const aim = -Math.PI / 4;
    return mount(cv, (c, t) => {
        const tx = w / 2 - R * 0.9, ty = h * 0.42;
        drawTank(c, tx, ty, R, { tank: opts.tank, color: opts.color, rot: aim });
        if (!opts.kick) return;
        const dt = S.last ? t - S.last : 0;
        S.last = t;
        skMath.step(S.st, 0, 0, OR, size, live ? t : 0, live ? dt : 0, null);
        if (!live) S.st.alpha = 1;
        showShoot(S, kick, skMath.R * size, t, live);
        const s = S.st;
        const sx = tx + s.x * k, sy = ty + s.y * k, lift = s.hop * k;
        c.globalAlpha = s.alpha;
        floorShadow(c, sx, sy, rp, lift);
        showShots(c, S, t, tx, ty, k, body);
        c.globalAlpha = s.alpha;
        showKick(c, kick, look, col, sx, sy - lift, rp, s.face, s.tilt, s.sq, skMath.popScale(s, t));
        drawTag(c, tagFor(opts.name || kick.name, px, st, plainName(kick, look, col)), sx, sy - lift - rp * 1.35 - px * 0.55);
        c.globalAlpha = 1;
    }, live, true);
}

// Stop any live canvases under `root` (a pane being cleared).
export function stopUnder(root) {
    if (!root) return;
    root.querySelectorAll('canvas').forEach((cv) => { if (cv._dwStop) cv._dwStop(); });
}
