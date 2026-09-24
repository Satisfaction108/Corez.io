// The RANKED UP moment: a full-screen overlay on its own canvas (#rankFx).
//
//   dim  ->  the old badge drops in and cracks three times  ->  it shatters
//   (shards + chips + a flash)  ->  the new badge slams in (rings, sparkles,
//   a small shake)  ->  "RANKED UP!" and the new rank's name  ->  glint, fade
//
// A whole new tier runs longer, with more shards, a third ring, a slow ray
// burst and falling flakes, and says "NEW TIER!". Finishing placement is the
// same beat from the "?" badge and says "RANK REVEALED". Flat colours only.
//
// The death panel starts it when its bar fills past the division; anything
// that never got started stays pending and plays in the menu. Click, Space,
// Enter or Esc skip to the fade after 350 ms. prefers-reduced-motion: no
// shake and half the particles.
import { badgeCanvas, TIER_COLORS, tierOf, nameOf } from './rankBadges.js';
import { gameSound } from '../sound.js';

const TIMES = {
    up:   { dur: 3500, crack: [560, 800, 1000], shatter: 1150, slam: 1400, impact: 1580, title: 1660, glint: 2150, out: 3000 },
    tier: { dur: 4600, crack: [560, 800, 1000], shatter: 1150, slam: 1450, impact: 1640, title: 1720, glint: 2400, out: 4000 },
};
const SKIP_AFTER = 350;
const DIM = '#07080c';
const TITLE_GOLD = '#ffc665';
const TITLE_INK = '#1b1510';

const queue = [];
let cur = null;             // { ev, prep, t0, fired, done[] }
let gate = () => true;
let canvas = null, cctx = null, raf = 0;

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOutBack = (k) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const reducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};

// ev: { kind: 'up' | 'tier' | 'reveal', from: division | 'placement', to: division, legendNo }
function normalize(ev) {
    const kind = ev.kind === 'tier' || ev.kind === 'reveal' ? ev.kind : 'up';
    return { kind, from: kind === 'reveal' ? 'placement' : ev.from, to: ev.to | 0, legendNo: ev.legendNo | 0, seed: ev.seed || ((Math.random() * 1e9) | 0) };
}

/* ── public API ──────────────────────────────────────────────────────── */
export function setGate(fn) { gate = typeof fn === 'function' ? fn : () => true; }
export const isPlaying = () => !!cur;
export const pending = () => queue.length > 0;

// Remember a rank-up that should be shown. Returns the event; start() it
// when the moment is right, or it plays in the menu later.
export function enqueue(ev) {
    const e = normalize(ev);
    queue.push(e);
    return e;
}

// Play ev now (or once the gate opens). onDone runs when it has faded out.
export function start(ev, onDone) {
    const i = queue.indexOf(ev);
    if (i >= 0) queue.splice(i, 1);
    else if (!ev || ev.kind == null) ev = normalize(ev || {});
    if (cur) {
        // one at a time: play right after the current one
        queue.unshift(ev);
        ev._asap = true;
        ev._onDone = onDone || null;
        return;
    }
    begin(ev, onDone);
}

// Menu: play whatever the game never got to show, one after another.
export function playPending() {
    if (cur || !queue.length) return false;
    const ev = queue.shift();
    begin(ev, () => { if (queue.length) setTimeout(playPending, 250); });
    return true;
}

export function clearPending() { queue.length = 0; }

// Drop the one on screen without its callback (tests / teardown).
export function stop() {
    if (!cur) return;
    cur = null;
    cancelAnimationFrame(raf);
    raf = 0;
    if (canvas) canvas.style.display = 'none';
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
}

/* ── setup per play ──────────────────────────────────────────────────── */
function prepare(ev, W, H, dpr) {
    const T = TIMES[ev.kind === 'tier' ? 'tier' : 'up'];
    const S = Math.round(clamp(Math.min(W, H) * 0.3, 130, 300));
    const dev = Math.round(S * dpr);
    const rm = reducedMotion();
    const r = rng(ev.seed);
    const big = ev.kind === 'tier';
    const toTier = tierOf(ev.to), col = TIER_COLORS[toTier], fromCol = TIER_COLORS[tierOf(ev.from)];
    const olds = [0, 1, 2, 3].map((k) => badgeCanvas(ev.from, dev, { crack: k }));
    // no #N plate here: the name line under it counts the number in
    const neu = badgeCanvas(ev.to, dev);
    const glint = document.createElement('canvas');
    glint.width = neu.width; glint.height = neu.height;
    const half = neu.width / dpr / 2;   // css half-size of a sprite

    const n = (k) => Math.max(1, Math.round(rm ? k / 2 : k));
    // shards: wedges of the old badge from the crack centre
    const shards = [];
    const N = n(big ? 24 : 14);
    const angs = [];
    for (let i = 0; i < N; i++) angs.push((i + 0.25 + r() * 0.5) / N * Math.PI * 2);
    for (let i = 0; i < N; i++) {
        const a0 = angs[i], a1 = angs[(i + 1) % N] + (i === N - 1 ? Math.PI * 2 : 0), am = (a0 + a1) / 2;
        const R0 = half * 1.3;
        const poly = [[0, 0], [Math.cos(a0) * R0, Math.sin(a0) * R0],
            [Math.cos(am) * R0 * (0.75 + r() * 0.3), Math.sin(am) * R0 * (0.75 + r() * 0.3)],
            [Math.cos(a1) * R0, Math.sin(a1) * R0]];
        const sp = S * (1.1 + r() * 1.3) / 1000;
        shards.push({ poly, vx: Math.cos(am) * sp, vy: Math.sin(am) * sp - S * 0.4 / 1000, vr: (r() - 0.5) * 0.012 });
    }
    const chipCols = [fromCol.base, fromCol.light, fromCol.dark, fromCol.ink];
    const chips = [];
    for (let i = 0, M = n(big ? 36 : 26); i < M; i++) {
        const a = r() * Math.PI * 2, sp = S * (1.4 + r() * 2.4) / 1000;
        chips.push({ x: Math.cos(a) * S * 0.1, y: Math.sin(a) * S * 0.1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - S * 0.6 / 1000,
            s: S * (0.018 + r() * 0.03), rot: r() * 6, vr: (r() - 0.5) * 0.03, col: chipCols[i % 4], life: 650 + r() * 450 });
    }
    const sparkCols = ['#ffffff', col.light, TITLE_GOLD];
    const sparks = [];
    for (let i = 0, M = n(big ? 30 : 22); i < M; i++) {
        const a = r() * Math.PI * 2;
        sparks.push({ a, d: S * (0.55 + r() * 0.8), delay: r() * 240, life: 520 + r() * 380, s: S * (0.028 + r() * 0.034), col: sparkCols[i % 3] });
    }
    const flakes = [];
    if (big) {
        const fc = [col.base, col.light, TITLE_GOLD, '#ffffff'];
        for (let i = 0, M = n(46); i < M; i++) {
            flakes.push({ x: r() * W, y: -20 - r() * H * 0.5, vy: (0.05 + r() * 0.07) * H / 1000, sway: 10 + r() * 24, ph: r() * 6,
                s: 4 + r() * 6, spin: 0.004 + r() * 0.008, col: fc[i % 4] });
        }
    }
    return { T, S, dpr, rm, big, col, olds, neu, glint, half, shards, chips, sparks, flakes, W, H };
}

/* ── drawing ─────────────────────────────────────────────────────────── */
function spriteAt(c, spr, x, y, scale, dpr) {
    const w = spr.width / dpr * scale;
    c.drawImage(spr, x - w / 2, y - w / 2, w, w);
}

function sparkle(c, x, y, s, col) {
    c.beginPath();
    c.moveTo(x, y - s);
    c.quadraticCurveTo(x, y, x + s, y);
    c.quadraticCurveTo(x, y, x, y + s);
    c.quadraticCurveTo(x, y, x - s, y);
    c.quadraticCurveTo(x, y, x, y - s);
    c.closePath();
    c.fillStyle = col;
    c.fill();
}

function outlinedText(c, txt, x, y, size, fill) {
    c.font = 'bold ' + Math.round(size) + 'px Rubik, Ubuntu, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(4, size * 0.16);
    c.strokeStyle = TITLE_INK;
    c.strokeText(txt, x, y);
    c.fillStyle = fill;
    c.fillText(txt, x, y);
}

function rankLabel(ev, t, T) {
    if (tierOf(ev.to) === 'legend') {
        const n = ev.legendNo | 0;
        if (!n) return 'LEGEND';
        const k = easeOut(clamp((t - T.title - 150) / 900));
        return 'LEGEND #' + Math.max(n, Math.round(n + 40 * (1 - k)));
    }
    return nameOf(ev.to).toUpperCase();
}

// One frame at t ms. Pure: no sounds, no state beyond `prep`.
export function drawFrame(c, ev, prep, t) {
    const { T, S, dpr, rm, big, col, W, H } = prep;
    const cx = W / 2, cy = H * 0.47;
    const fade = t > T.out ? 1 - easeInOut(clamp((t - T.out) / (T.dur - T.out))) : 1;
    c.save();
    c.clearRect(0, 0, W, H);

    c.globalAlpha = 0.78 * easeOut(clamp(t / 300)) * fade;
    c.fillStyle = DIM;
    c.fillRect(0, 0, W, H);
    c.globalAlpha = 1;

    // shake: a nudge per crack, a real one on impact
    let sx = 0, sy = 0;
    if (!rm) {
        for (const ct of T.crack) {
            const d = t - ct;
            if (d >= 0 && d < 140) { const a = S * 0.012 * (1 - d / 140); sx += Math.sin(d * 0.9) * a; sy += Math.cos(d * 1.3) * a; }
        }
        const d = t - T.impact;
        if (d >= 0 && d < 340) { const a = S * (big ? 0.05 : 0.036) * (1 - d / 340); sx += Math.sin(d * 0.55) * a; sy += Math.cos(d * 0.8) * a; }
    }
    c.translate(sx, sy);

    // tier-ups and reveals get a slow flat ray burst behind the new badge
    if ((big || ev.kind === 'reveal') && t >= T.impact) {
        const k = clamp((t - T.impact) / 400);
        c.save();
        c.translate(cx, cy);
        c.rotate(t * 0.00012);
        c.globalAlpha = (big ? 0.13 : 0.1) * k * fade;
        c.fillStyle = col.light;
        const R0 = S * (1.15 + 0.35 * k), n = 16;
        for (let i = 0; i < n; i++) {
            const a0 = (i / n) * Math.PI * 2, a1 = a0 + (Math.PI / n) * 0.55;
            c.beginPath();
            c.moveTo(0, 0);
            c.lineTo(Math.cos(a0) * R0, Math.sin(a0) * R0);
            c.lineTo(Math.cos(a1) * R0, Math.sin(a1) * R0);
            c.closePath();
            c.fill();
        }
        c.restore();
    }

    // the old badge: drops in, cracks, swells, gone
    if (t < T.shatter) {
        const e = clamp((t - 120) / 380);
        let sc = 0.55 + 0.45 * easeOutBack(e);
        if (t > T.shatter - 90) sc *= 1 + 0.07 * ((t - (T.shatter - 90)) / 90);
        const stage = t >= T.crack[2] ? 3 : t >= T.crack[1] ? 2 : t >= T.crack[0] ? 1 : 0;
        c.globalAlpha = clamp((t - 120) / 180);
        spriteAt(c, prep.olds[stage], cx, cy, sc, dpr);
        c.globalAlpha = 1;
    }

    // shatter: shards of the old badge, chips, a flash
    if (t >= T.shatter) {
        const d = t - T.shatter;
        if (d < 1100) {
            const g = S * 0.0000042;
            const spr = prep.olds[3];
            const w = spr.width / dpr;
            for (const s of prep.shards) {
                const a = 1 - clamp((d - 520) / 480);
                if (a <= 0) continue;
                c.save();
                c.globalAlpha = a;
                c.translate(cx + s.vx * d, cy + s.vy * d + 0.5 * g * d * d);
                c.rotate(s.vr * d);
                c.beginPath();
                s.poly.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
                c.closePath();
                c.clip();
                c.drawImage(spr, -w / 2, -w / 2, w, w);
                c.restore();
            }
            for (const p of prep.chips) {
                if (d > p.life) continue;
                c.save();
                c.globalAlpha = 1 - clamp((d - p.life * 0.6) / (p.life * 0.4));
                c.translate(cx + p.x + p.vx * d, cy + p.y + p.vy * d + 0.5 * g * 1.3 * d * d);
                c.rotate(p.rot + p.vr * d);
                c.fillStyle = p.col;
                c.fillRect(-p.s / 2, -p.s / 2, p.s, p.s);
                c.restore();
            }
        }
        if (d < 220) {
            // the pop: a quick camera flash and a white burst where it broke
            const k = d / 220;
            c.globalAlpha = 0.12 * (1 - k);
            c.fillStyle = '#ffffff';
            c.fillRect(-20, -20, W + 40, H + 40);
            c.globalAlpha = 1;
            sparkle(c, cx, cy, S * (0.15 + 0.55 * Math.sin(Math.PI * Math.min(1, k * 1.15))), '#ffffff');
            c.globalAlpha = 1;
        }
    }

    // the new badge slams in
    if (t >= T.slam) {
        const p = clamp((t - T.slam) / (T.impact - T.slam));
        let sc = 2.3 - 1.3 * p * p;
        if (t >= T.impact) {
            const d = t - T.impact, k = clamp(d / 320);
            sc = 1 - 0.2 * Math.sin(Math.PI * k) * (1 - k);
        }
        const bob = t > T.impact + 400 ? Math.sin((t - T.impact) / 520) * S * 0.012 : 0;
        c.globalAlpha = Math.min(1, p * 2.5) * fade;
        spriteAt(c, prep.neu, cx, cy + bob, sc, dpr);
        // glint: a flat white band sweeping across, clipped to the badge
        const gd = t - T.glint;
        if (gd >= 0 && gd < 560) {
            const g = prep.glint, gc = g.getContext('2d');
            gc.setTransform(1, 0, 0, 1, 0, 0);
            gc.clearRect(0, 0, g.width, g.height);
            gc.globalCompositeOperation = 'source-over';
            gc.drawImage(prep.neu, 0, 0);
            gc.globalCompositeOperation = 'source-atop';
            gc.fillStyle = 'rgba(255,255,255,0.55)';
            const x = -g.width * 0.4 + (gd / 560) * g.width * 1.8;
            gc.beginPath();
            gc.moveTo(x, 0); gc.lineTo(x + g.width * 0.14, 0);
            gc.lineTo(x - g.width * 0.18, g.height); gc.lineTo(x - g.width * 0.32, g.height);
            gc.closePath();
            gc.fill();
            gc.globalCompositeOperation = 'destination-in';
            gc.drawImage(prep.neu, 0, 0);
            gc.globalCompositeOperation = 'source-over';
            spriteAt(c, g, cx, cy + bob, sc, dpr);
        }
        c.globalAlpha = 1;
    }

    // impact rings
    if (t >= T.impact) {
        const rings = big ? 3 : 2;
        for (let i = 0; i < rings; i++) {
            const d = t - T.impact - i * 95;
            if (d < 0 || d > 680) continue;
            const k = d / 680;
            c.globalAlpha = (1 - k) * 0.9;
            c.lineWidth = S * 0.055 * (1 - k) + 1.5;
            c.strokeStyle = i === 0 ? '#ffffff' : i === 1 ? col.light : TITLE_GOLD;
            c.beginPath();
            c.arc(cx, cy, S * (0.42 + 0.95 * easeOut(k)), 0, Math.PI * 2);
            c.stroke();
        }
        for (const s of prep.sparks) {
            const d = t - T.impact - s.delay;
            if (d < 0 || d > s.life) continue;
            const k = d / s.life;
            const dist = s.d * easeOut(Math.min(1, k * 1.4));
            const size = s.s * Math.sin(Math.PI * k);
            c.globalAlpha = fade;
            sparkle(c, cx + Math.cos(s.a) * dist, cy + Math.sin(s.a) * dist, size, s.col);
        }
        c.globalAlpha = 1;
    }

    // falling flakes (new tier)
    if (big && t >= T.impact) {
        const d = t - T.impact;
        c.globalAlpha = fade;
        for (const f of prep.flakes) {
            const y = f.y + f.vy * d;
            if (y > H + 20) continue;
            const x = f.x + Math.sin(f.ph + d * 0.002) * f.sway;
            c.save();
            c.translate(x, y);
            c.scale(Math.cos(f.ph + d * f.spin), 1);
            c.fillStyle = f.col;
            c.fillRect(-f.s / 2, -f.s * 0.7, f.s, f.s * 1.4);
            c.restore();
        }
        c.globalAlpha = 1;
    }

    // words
    if (t >= T.title) {
        const k = clamp((t - T.title) / 240);
        const title = ev.kind === 'reveal' ? 'RANK REVEALED' : big ? 'NEW TIER!' : 'RANKED UP!';
        const size = clamp(S * (big ? 0.24 : 0.21), 26, 64);
        c.save();
        c.globalAlpha = clamp(k * 1.6) * fade;
        c.translate(cx, cy - S * 0.8);
        c.scale(1.3 - 0.3 * easeOutBack(k), 1.3 - 0.3 * easeOutBack(k));
        outlinedText(c, title, 0, 0, size, TITLE_GOLD);
        c.restore();
    }
    if (t >= T.title + 160) {
        const k = clamp((t - T.title - 160) / 260);
        const size = clamp(S * 0.15, 18, 42);
        c.globalAlpha = k * fade;
        outlinedText(c, rankLabel(ev, t, T), cx, cy + S * 0.72 + (1 - easeOut(k)) * 10, size, col.text);
        c.globalAlpha = 1;
    }
    if (t >= 1800) {
        c.globalAlpha = 0.55 * easeOut(clamp((t - 1800) / 400)) * fade;
        c.font = 'bold 13px Rubik, Ubuntu, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = '#c9c1ad';
        c.fillText('Click to continue', cx, Math.min(H - 28, cy + S * 1.25));
        c.globalAlpha = 1;
    }
    c.restore();
}

// Harness: draw ev at t onto any 2D context of W x H css px.
const prepCache = new WeakMap();
export function renderAt(c, W, H, evIn, t, dpr = 1) {
    const ev = evIn.kind ? evIn : normalize(evIn);
    let prep = prepCache.get(evIn);
    if (!prep || prep.W !== W || prep.H !== H) { prep = prepare(ev, W, H, dpr); prepCache.set(evIn, prep); }
    drawFrame(c, ev, prep, t);
}
export const timings = TIMES;

/* ── live playback ───────────────────────────────────────────────────── */
function ensureCanvas() {
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'rankFx';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:450;display:none;cursor:pointer;';
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); skip(); });
    document.body.appendChild(canvas);
    cctx = canvas.getContext('2d');
    return canvas;
}
function size() {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    return { W, H, dpr };
}

function onKey(e) {
    if (!cur) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter' || k === 'Escape' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'keydown') skip();
    }
}

function skip() {
    if (!cur || cur.t0 == null) return;
    const t = performance.now() - cur.t0;
    if (t < SKIP_AFTER) return;
    const T = cur.prep.T;
    if (t >= T.out) return;
    // sounds for beats we jump over would pile up; the landing one is kept
    for (const k of ['c0', 'c1', 'c2', 'shatter']) cur.fired.add(k);
    if (!cur.fired.has('impact')) { cur.fired.add('impact'); cue('impact'); }
    cur.t0 = performance.now() - T.out;
}

function cue(name, stage) {
    try {
        if (name === 'crack' && gameSound.rankCrack) gameSound.rankCrack(stage);
        else if (name === 'shatter' && gameSound.rankShatter) gameSound.rankShatter();
        else if (name === 'impact' && gameSound.rankUp) gameSound.rankUp(!!(cur && cur.prep.big));
    } catch (e) { /* sound is optional */ }
}

function begin(ev, onDone) {
    ensureCanvas();
    const { W, H, dpr } = size();
    cur = { ev, prep: prepare(ev, W, H, dpr), t0: null, fired: new Set(), onDone, gatedAt: performance.now() };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
}

function finish() {
    const done = cur && cur.onDone;
    cur = null;
    canvas.style.display = 'none';
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    if (done) { try { done(); } catch (e) { console.error(e); } }
    if (!cur && queue.length && queue[0]._asap) {
        const next = queue.shift();
        begin(next, next._onDone);
    }
}

function tick() {
    raf = 0;
    if (!cur) return;
    const now = performance.now();
    if (cur.t0 == null) {
        let open = true;
        try { open = !!gate(); } catch (e) { open = true; }
        // never hold a ceremony hostage for long
        if (!open && now - cur.gatedAt < 8000) { raf = requestAnimationFrame(tick); return; }
        cur.t0 = now;
        canvas.style.display = 'block';
    }
    const t = now - cur.t0;
    const T = cur.prep.T;
    T.crack.forEach((ct, i) => { if (t >= ct && !cur.fired.has('c' + i)) { cur.fired.add('c' + i); cue('crack', i + 1); } });
    if (t >= T.shatter && !cur.fired.has('shatter')) { cur.fired.add('shatter'); cue('shatter'); }
    if (t >= T.impact && !cur.fired.has('impact')) { cur.fired.add('impact'); cue('impact'); }
    if (canvas.width !== Math.round(window.innerWidth * cur.prep.dpr)) {
        const { W, H, dpr } = size();
        cur.prep = prepare(cur.ev, W, H, dpr);
    }
    cctx.setTransform(cur.prep.dpr, 0, 0, cur.prep.dpr, 0, 0);
    try { drawFrame(cctx, cur.ev, cur.prep, Math.min(t, T.dur)); } catch (e) { console.error(e); t >= 0 && finish(); return; }
    if (t >= T.dur) { cctx.setTransform(1, 0, 0, 1, 0, 0); cctx.clearRect(0, 0, canvas.width, canvas.height); finish(); return; }
    raf = requestAnimationFrame(tick);
}

// Harness / debugging: step a live ceremony to an exact time.
if (typeof window !== 'undefined') {
    window.dwRankCeremony = { enqueue, start, playPending, pending, isPlaying, renderAt, timings: TIMES };
}
