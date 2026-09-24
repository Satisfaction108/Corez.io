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
        pmLoad = fetch(new URL('./preview-mockups.json', import.meta.url), { cache: 'force-cache' })
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
const live = new Set();
let raf = 0, lastTick = 0;
const onScreen = (cv) => cv.isConnected && cv.offsetParent !== null;
function tick(now) {
    raf = 0;
    if (document.hidden || document.body.classList.contains('in-game')) return;
    let any = false;
    const due = now - lastTick >= 32;   // ~30 fps is plenty for a preview
    if (due) lastTick = now;
    for (const L of live) {
        if (!L.cv.isConnected) { if (L.seen || now - L.born > 3000) live.delete(L); else any = true; continue; }
        L.seen = true;
        // nothing on screen: the loop stops, and the next mount / menu
        // change starts it again
        if (!onScreen(L.cv)) continue;
        any = true;
        if (due) { try { L.draw(now / 1000); } catch (e) { live.delete(L); console.warn(e); } }
    }
    if (any) raf = requestAnimationFrame(tick);
}
export function kick() { if (!raf && live.size) raf = requestAnimationFrame(tick); }
document.addEventListener('visibilitychange', kick);
new MutationObserver(kick).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// Draw now, and again every frame while `animated` (and motion is allowed).
function mount(cv, draw, animated) {
    const run = (t) => draw(begin(cv), t);
    ready().then(() => run(0));
    if (animated && !reducedMotion()) {
        const L = { cv, draw: run, seen: false, born: performance.now() };
        live.add(L);
        kick();
        cv._dwStop = () => live.delete(L);
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
    const px = opts.px || 14;
    const font = opts.font || 'Ubuntu, Rubik, sans-serif';
    const m = document.createElement('canvas').getContext('2d');
    m.font = 'bold ' + px + 'px ' + font;
    const glyph = st && st.style && st.style.glyph ? ' ' + st.style.glyph : '';
    const pad = opts.stroke ? Math.ceil(px * 0.3) : 2;
    const tw = Math.ceil(m.measureText(name + glyph).width) + pad * 2;
    const w = opts.maxW ? Math.min(opts.maxW, tw) : tw;
    const h = opts.h || Math.ceil(px * 1.45);
    const cv = canvas(w, h, opts.cls || 'dw-name-cv');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', name);
    cv.removeAttribute('aria-hidden');
    return mount(cv, (c, t) => {
        cos.drawStyledName(c, name, pad, h / 2 + px * 0.04, px, st, opts.custom || opts.fallback || '#f2f2f2', { stroke: !!opts.stroke, time: t, font });
    }, animatedItem(st));
}

// Stop any live canvases under `root` (a pane being cleared).
export function stopUnder(root) {
    if (!root) return;
    root.querySelectorAll('canvas').forEach((cv) => { if (cv._dwStop) cv._dwStop(); });
}
