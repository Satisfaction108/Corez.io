// FX math for juice.js and raidHeat.js, kept free of the DOM and the game
// state so it can be tested on its own (scripts/test/raidHeat.test.js).

// ── screen shake ───────────────────────────────────────────────────────
// power is loose (a hit's percent, a blast's size); the shake eases toward
// SHAKE_MAX and never past it, so stacked events can't throw the camera.
export const SHAKE_MAX = 34;
export function shakeFor(power) {
    if (!(power > 0)) return 0;
    return SHAKE_MAX * (1 - Math.exp(-power / 40));
}

// ── glitch slices ──────────────────────────────────────────────────────
// A glitch frame is a few horizontal strips of the finished frame, shifted
// sideways and tinted. Planned from a seed, into a preallocated list.
export const GLITCH_DX_MAX = 48;      // px per 1000 px of width, at full strength
export function hash01(a, b) {
    let h = (Math.imul((a | 0) + 0x9e37, 374761393) ^ Math.imul((b | 0) + 0x7f4a, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1540483477);
    h ^= h >>> 15;
    return (h >>> 0) / 0x100000000;
}
export function makeSlices(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ x: 0, w: 0, y: 0, h: 0, dx: 0, tint: 0 });
    return out;
}
// Fills `out` and returns how many slices to draw (0 = none).
export function planGlitch(seed, strength, w, h, out) {
    if (!(strength > 0.02) || !(w > 0) || !(h > 0)) return 0;
    const s = Math.min(1, strength);
    const n = Math.min(out.length, 2 + Math.round(s * (out.length - 2)));
    for (let i = 0; i < n; i++) {
        const sl = out[i];
        const hh = Math.max(2, Math.round((0.004 + 0.034 * hash01(seed, i * 3 + 1) * (0.4 + 0.6 * s)) * h));
        sl.h = Math.min(hh, h);
        sl.y = Math.min(h - sl.h, Math.floor(hash01(seed, i * 3) * h));
        // a block, not the whole row: most of a glitch is a torn chunk
        sl.w = Math.max(8, Math.round((0.25 + 0.75 * hash01(seed, i * 5 + 4)) * w));
        sl.x = Math.min(w - sl.w, Math.floor(hash01(seed, i * 5 + 3) * w));
        const dir = hash01(seed, i * 3 + 2) < 0.5 ? -1 : 1;
        sl.dx = dir * (0.3 + 0.7 * hash01(seed, i * 7 + 6)) * GLITCH_DX_MAX * s * w / 1000;
        sl.tint = i % 3;
    }
    return n;
}

// ── particle pool ──────────────────────────────────────────────────────
// Fixed size, oldest overwritten: nothing is allocated after makePool.
export function makePool(n) {
    const items = [];
    for (let i = 0; i < n; i++) items.push({ born: -1e9, life: 0, x: 0, y: 0, vx: 0, vy: 0, size: 0, kind: 0, spin: 0, col: "#ffffff" });
    return { items, next: 0 };
}
export function emit(pool, x, y, ang, speed, life, kind, now, size = 4) {
    const p = pool.items[pool.next];
    pool.next = (pool.next + 1) % pool.items.length;
    p.born = now; p.life = life;
    p.x = x; p.y = y;
    p.vx = Math.cos(ang) * speed; p.vy = Math.sin(ang) * speed;
    p.kind = kind; p.size = size;
    p.spin = hash01(now | 0, pool.next) * 2 - 1;
    return p;
}
export function liveCount(pool, now) {
    let n = 0;
    for (const p of pool.items) if (now - p.born < p.life) n++;
    return n;
}

// ── fight or flight ────────────────────────────────────────────────────
// How scary one enemy is: closer is worse, pointing its gun at you is worse.
// aimErr is the angle (radians) between its facing and the line to you.
export function threatOf(dist, aimErr, range) {
    if (!(dist < range)) return 0;
    const near = 1 - Math.max(0, dist) / range;
    const err = Math.abs(aimErr);
    const aim = err < 0.35 ? 1 : err < 0.9 ? 0.55 : 0.25;
    return Math.min(1, near * (0.35 + 0.65 * aim) * 1.25);
}
// The heartbeat load (sound.js satchelTension) while you're hunted.
export function huntTension(level, threat) {
    if (!level) return 0;
    return Math.min(1, 0.5 + 0.08 * level + 0.42 * Math.max(0, Math.min(1, threat)));
}

// ── sky drop ───────────────────────────────────────────────────────────
// k 0..1 through the fall -> height 1..0. It picks up speed as it comes
// down, which is what makes it read as falling.
export function fallHeight(k) {
    const u = Math.max(0, Math.min(1, k));
    return 1 - u * u;
}
// The camera on your own drop: from high up (`from`, a big chunk of the map
// in view) a beat of hanging there, then a dive that speeds up all the way
// down, through normal zoom just before the hit to a short punch-in past it,
// then settling (afterMs after the hit).
export const DROP_ZOOM_FROM = 0.38;
export const DROP_DIVE = 0.07;
export function dropZoom(k, afterMs = 0, from = DROP_ZOOM_FROM) {
    if (k < 1) {
        const u = Math.max(0, Math.min(1, k / 0.92));
        if (k > 0.92) return 1 + DROP_DIVE * (k - 0.92) / 0.08;
        return from + (1 - from) * Math.pow(u, 2.2);
    }
    const t = Math.max(0, Math.min(1, afterMs / 320));
    return 1 + DROP_DIVE * (1 - t) * (1 - t);
}
// The widest zoom that keeps the view inside the room: half the screen (in
// the base world ratio) may not reach past the room's half width (plus a
// little) from where the camera is.
export function edgeZoom(screenHalf, ratio, half, at) {
    if (!(ratio > 0) || !(half > 0)) return 0;
    return screenHalf / (ratio * Math.max(150, half - Math.abs(at)));
}

// ── how much to draw ───────────────────────────────────────────────────
// Effects quality follows the frame time: it drops fast when frames get
// slow and climbs back slowly. 0.25..1.
export function nextQuality(q, frameMs) {
    if (!(frameMs > 0) || frameMs > 250) return q;   // a stall or a hidden tab, not a slow machine
    if (frameMs > 26) q -= 0.04;
    else if (frameMs > 21) q -= 0.01;
    else if (frameMs < 18) q += 0.004;
    return Math.max(0.25, Math.min(1, q));
}
// level: 0 Low, 1 Normal, 2 Max (the Effects setting)
export const LEVEL_MULT = [0.4, 0.6, 1.6];   // Low / Normal / Max
export function fxScale(level, q) {
    return (LEVEL_MULT[level] != null ? LEVEL_MULT[level] : 1) * Math.max(0.25, Math.min(1, q));
}
// particle count for a burst of n at this scale, never below 1 if n > 0
export function countFor(n, scale) {
    if (!(n > 0)) return 0;
    return Math.max(1, Math.round(n * scale));
}

// ── cracks ─────────────────────────────────────────────────────────────
// n jagged lines out from the origin in unit space, segs steps each.
// Made once per use and kept: [[x0, y0, x1, y1, ...], ...]
export function crackPaths(seed, n, segs = 5, reach = 1) {
    const out = [];
    for (let i = 0; i < n; i++) {
        let a = (i / n) * Math.PI * 2 + (hash01(seed, i) - 0.5) * 0.6, r = 0;
        const pts = [0, 0];
        for (let k = 0; k < segs; k++) {
            a += (hash01(seed + k * 31, i * 7) - 0.5) * 0.8;
            r += reach / segs * (0.6 + 0.8 * hash01(seed + k, i * 13));
            pts.push(Math.cos(a) * Math.min(reach, r), Math.sin(a) * Math.min(reach, r));
        }
        out.push(pts);
    }
    return out;
}

// ── numbers ────────────────────────────────────────────────────────────
// a counter rolling up from `from` to `to`, k 0..1
export function rollValue(from, to, k) {
    const u = Math.max(0, Math.min(1, k));
    return Math.round(from + (to - from) * (1 - (1 - u) * (1 - u) * (1 - u)));
}
// kills inside the combo window stack: '' for one, then x2, x3...
export const COMBO_MS = 6000;
export function comboAfter(prevCount, prevAt, now) {
    return now - prevAt <= COMBO_MS ? prevCount + 1 : 1;
}
export function comboLabel(n) { return n >= 2 ? "x" + n : ""; }
// Your own kill's slam sub line, from the KC text ("ELIMINATED: kai (300 gems
export function killSub(text, pts, fmt) {
    const t = String(text || "");
    const i = t.indexOf(": ");
    let who = i >= 0 ? t.slice(i + 2) : "";
    const cut = who.indexOf("  (");
    if (cut >= 0) who = who.slice(0, cut);
    who = who.trim();
    const p = pts | 0;
    const head = who ? "You knocked out " + who : "You knocked them out";
    return p > 0 ? head + "  ·  +" + (fmt ? fmt(p) : String(p)) + " pts" : head;
}
// Every kill of yours gets its own moment (playtest 5: only the first kill's
export const KILL_SLAM_KEY = "KO";
export function multiKillWord(n) {
    n = n | 0;
    if (n <= 1) return "ELIMINATED";
    if (n === 2) return "DOUBLE KO";
    if (n === 3) return "TRIPLE KO";
    if (n === 4) return "QUAD KO";
    return "RAMPAGE x" + n;
}
// the bigger kills (KC kind, or the server's headline word): their own word
export function bigKillWord(kind, text) {
    if (kind === "shutdown") return "SHUTDOWN";
    if (kind === "revenge") return "REVENGE";
    if (kind === "huntkill") return "BOUNTY CASHED";
    if (/^GIANT DOWN/.test(String(text || ""))) return "GIANT DOWN";
    return "";
}
// the victim's name from the KC text ("ELIMINATED: kai (300 gems dropped)")
export function killWho(text) {
    const t = String(text || "");
    const i = t.indexOf(": ");
    let who = i >= 0 ? t.slice(i + 2) : "";
    const cut = who.indexOf("  (");
    if (cut >= 0) who = who.slice(0, cut);
    return who.trim();
}
// the kill pop over your own tank: { head: "KO kai", pts: "+350 pts" | "" }
export function killPop(text, pts, fmt) {
    const who = killWho(text);
    const p = pts | 0;
    return { head: who ? "KO  " + who : "KO", pts: p > 0 ? "+" + (fmt ? fmt(p) : String(p)) + " pts" : "" };
}
