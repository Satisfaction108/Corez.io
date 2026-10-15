// The end of a raid, start to finish: the last ten seconds on the clock, the
// freeze, the camera flying to the winner, the crown, the podium and the
// reward tally, then the wait for the next raid.
//
// app.js draws it (draw, drawCountdown) with its HUD helpers (init) and tells
// it where the winners are on screen (seen). socketinit feeds it the KC
// raidend, raid-end deaths, streak notes and the next spawn.
import { global } from "./global.js";
import { config } from "./config.js";
import { gameSound } from "./sound.js";
import * as raidShare from "./raidShare.js";
import * as juice from "./juice.js";
import * as CL from "./crownsLogic.js";
import * as crownArt from "./crownArt.js";
import * as SL from "./scoreLogic.js";
import * as RP from "./raidProgressLogic.js";
import * as keepNudge from "./keepNudge.js";

let A = null;
export function init(helpers) { A = helpers; }

// ms after the KC raidend. The server takes everyone but the winners down at
// 1.6 s and starts the next raid at 28.6 s (round 11; was 22.6 s)
// off the reveal, which waits for the camera to reach the winner.
const FREEZE_OUT = 1700;
const TITLE_OUT = 1900;
const REVEAL_MIN = 2300;
const REVEAL_MAX = 3600;
const PODIUM_AT = 1500;     // after the reveal
const REWARDS_AT = 2300;
const TALLY_AT = 2900;
const TALLY_MS = 2200;
const NEXT_AT = 5200;
const END_MS = 31000;       // past the server's next raid (28.6 s): the drop stops it first

const S = {
    on: false, at: 0, sub: "", reveal: 0,
    winIds: new Set(), seen: new Map(),
    top: [], rows: 0, duos: false, winner: "", mate: "", place: 0, isWin: false,
    me: { score: 0, kills: 0, banked: 0, next: 0, k: 0, c: 0 },
    // the raid whose podium you actually saw (firstSeconds shows a recap before FRESH
    raidId: 0, seenRaid: 0,
    respawnAsked: false, filtered: false, lastTick: 0, podSnd: 0, tallyEnd: false,
    gemAcc: 0, paperAcc: 0, nextSpan: 0, crownHit: false, crownAt: 0, holdArmed: false, snapped: false, streak: null, fx: 0, fy: 0, fr: 0, fok: false,
    cb: null, dc: null, cw: null,
    // "Keep results up" (the next-raid plate's button): the next raid's drop doesn't
    keep: false,
};
// The results kept after the drop: drawn over the game until a click, Esc or
const DOCK_MS = 45000;
const D = { on: false, at: 0 };
// hit boxes (screen units), filled where they're drawn
const keepBox = { x: 0, y: 0, w: 0, h: 0, on: false };

const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
const easeOut = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const easeBack = (k) => { const s = 1.7; k -= 1; return 1 + k * k * ((s + 1) * k + s); };
function easeBounce(k) {
    if (k < 1 / 2.75) return 7.5625 * k * k;
    if (k < 2 / 2.75) { k -= 1.5 / 2.75; return 7.5625 * k * k + 0.75; }
    if (k < 2.5 / 2.75) { k -= 2.25 / 2.75; return 7.5625 * k * k + 0.9375; }
    k -= 2.625 / 2.75; return 7.5625 * k * k + 0.984375;
}
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const lite = () => !!config.graphical.fewerEffects;
const glowOn = () => !config.graphical.noGlow && !global.lowFx;
const shakeOn = () => !config.graphical.noShake;

export const active = () => S.on;
// the kept results over the game (not the finale: the HUD and the raid run)
export const docked = () => D.on;
// the HUD steps aside once the freeze is over
export const hidesHud = () => S.on && performance.now() - S.at > FREEZE_OUT;
// a rank-up ceremony waits for the tally
export const holdsCeremony = () => S.on && (!S.reveal || performance.now() - S.reveal < TALLY_AT + TALLY_MS + 600);
export const watchIds = () => S.on ? S.winIds : null;
// did this raid's podium get on screen long enough to read?
export const sawResults = (raidId) => (raidId | 0) > 0 && (raidId | 0) === S.seenRaid;
// QA hook (headless runs): what the finale thinks is going on
window.dwFinale = () => ({ on: S.on, t: S.on ? Math.round(performance.now() - S.at) : -1, reveal: S.reveal ? Math.round(performance.now() - S.reveal) : 0,
    fok: S.fok, seen: S.seen.size, place: S.place, win: S.isWin, parts: P.n });

const you0 = (r) => (r && r.you) || {};
// ── in from the network ───────────────────────────────────────────────────
export function start(sub) {
    const r = global.royale || {};
    const res = r.results || null;
    const now = performance.now();
    S.on = true;
    S.at = now;
    S.sub = sub || "";
    S.reveal = 0;
    S.respawnAsked = false;
    S.lastTick = 0;
    S.podSnd = 0;
    S.tallyEnd = false;
    S.gemAcc = S.paperAcc = 0;
    S.nextSpan = 0;
    S.fok = false;
    S.keep = false;
    D.on = false;
    S.progAt = 0;
    S.prog = null;
    try { S.best = RP.noteRaid((res && res.raidId) | 0 || (r.raidId | 0), (you0(r).score) | 0, window.localStorage); } catch (e) { S.best = { best: 0, isBest: false }; }
    keepBox.on = false;
    S.seen.clear();
    S.winIds.clear();
    if (res && res.win) for (const id of res.win) S.winIds.add(id);
    S.top = res && res.top ? res.top.slice(0, 3) : [];
    S.rows = res ? res.rows | 0 : 0;
    S.duos = !!(res ? res.duos : r.duos);
    const you = r.you || {};
    S.place = S.duos ? ((r.duo && r.duo.place) | 0) : ((you.place || r.place) | 0);
    S.isWin = S.place === 1;
    S.me.score = (you.score != null ? you.score : r.youScore) | 0;
    S.me.kills = you.kills | 0;
    // the cells add up the way the standings do: banked + kills & crowns
    const pt = SL.parts(you);
    S.me.banked = pt.b;
    S.me.bankG = pt.g | 0;
    S.me.bankSoft = pt.soft | 0;
    S.me.k = pt.k; S.me.c = pt.c;
    S.raidId = (res && res.raidId) | 0 || (r.raidId | 0);
    S.me.next = you.nextGems | 0;
    const w = S.top[0];
    S.winner = res && res.champ ? (res.champ.name || "Unnamed") : w ? (w.name || "Unnamed") : "";
    // a crown raid: CORE CHAMPION for #1 by points, and every title says the winner's
    S.cw = null;
    const wScore = res && res.champ ? res.champ.score | 0 : w ? w.score | 0 : 0;
    try { S.cw = CL.finale(res, S.place, S.isWin, S.winner, S.rows, wScore); } catch (e) { S.cw = null; }
    S.mate = S.duos && r.duo && r.duo.mate ? String(r.duo.mate.name || "your teammate") : "";
    // a guest's "Keep my stuff" card (a win, top 3, a new best or their 2nd raid)
    try { keepNudge.noteRaidEnd({ raidId: S.raidId, place: S.place, isWin: S.isWin, score: S.me.score, prevBest: S.best ? S.best.prev : 0 }); } catch (e) { /* */ }
    if (!S.streak || now - S.streak.at > 20000) S.streak = null;
    P.n = 0;
    S.crownHit = false;
    S.crownAt = 0;
    S.snapped = false;
    // the hit-stop starts after the first finale frame, so the frame it
    // holds is the flash and RAID OVER, not the last second of the raid
    S.holdArmed = shakeOn() && !calm();
    if (S.holdArmed) kick(now, 0.05, 1.6, 1200);
    // the champion's own moment: time all but stops, then crawls back
    if (S.cw && S.isWin && !calm()) { try { juice.slowMo(1500, 0.22); } catch (e) { /* */ } }
    raidShare.clearView();
    countRaid();
    fetchComeBack();
    S.dc = discordWanted();
    try { gameSound.rankShatter(); } catch (e) { /* */ }
    setFreezeFilter(!lite());
    // already dead (respawning, spectating a killer): watch the winner too
    if (global.died) watchWinner(true);
}

// A raid-end death while the finale runs: no knockout, no death card. The
// dead watch a winner; a winner going down just waits for the next raid.
export function onDeath(cause, selfId) {
    if (!S.on || cause !== "raidend") return false;
    watchWinner(!S.winIds.has(selfId));
    return true;
}

export function noteStreak(d) {
    if (!d || (d.kind !== "win" && d.kind !== "play")) return;
    S.streak = { kind: d.kind, n: d.streak | 0, at: performance.now() };
}

// the next raid dropped us in
export function stop() {
    if (!S.on) return;
    S.on = false;
    P.n = 0;
    K.n = 0;
    keepBox.on = false;
    setFreezeFilter(false);
    // never over a running raid
    keepNudge.drop();
    // asked to keep them: the podium and your raid stay up over the game a drop that
    const now = performance.now();
    if (S.keep || !S.reveal || now - S.reveal < PODIUM_AT + 4000) { D.on = true; D.at = now; return; }
    raidShare.hide();
    hideDiscord();
}
// leaving for the menu from the results ("Keep my stuff"): nothing of
// them stays up over the menu
function leaveResults() {
    S.on = false;
    D.on = false;
    P.n = 0;
    K.n = 0;
    keepBox.on = false;
    setFreezeFilter(false);
    raidShare.hide();
    hideDiscord();
}
keepNudge.setOnGo(leaveResults);
function undock() {
    if (!D.on) return;
    D.on = false;
    raidShare.hide();
    hideDiscord();
}
// canvas.js mouseDown (screen units): the Keep button, or a click that puts the
export function click(x, y) {
    if (D.on) { undock(); return true; }
    if (S.on && keepBox.on && x >= keepBox.x && x <= keepBox.x + keepBox.w && y >= keepBox.y && y <= keepBox.y + keepBox.h) {
        S.keep = !S.keep;
        try { gameSound.uiClick && gameSound.uiClick(); } catch (e) { /* */ }
        return true;
    }
    return false;
}
// canvas.js keyDown: Esc puts the kept results away
export function key(kc) {
    if (D.on && kc === 27) { undock(); return true; }
    return false;
}
// QA (headless): keep on/off, docked or not
window.dwKeepResults = (on) => { if (on != null) S.keep = !!on; return { keep: S.keep, docked: D.on, box: keepBox.on }; };

function watchWinner(follow) {
    global.royaleDied = false;
    global.royaleSpectating = false;
    global.royaleKillerCamUntil = 0;
    global.raidRespawnAt = 0;
    if (follow) { try { global.canvas.socket.talk('RS', 2); } catch (e) { /* */ } }
}

// Time stops: the world layers go grey for the beat (a CSS filter, so it costs
// no canvas work), then the colour comes back as the camera flies.
let layers = null;
function setFreezeFilter(on) {
    if (on === S.filtered) return;
    S.filtered = on;
    try {
        if (!layers) layers = ["gameCanvas-background", "gameCanvas-gameplay"].map(id => document.getElementById(id)).filter(Boolean);
        const gl = global.glCanvas;
        for (const el of gl ? layers.concat(gl) : layers) {
            el.style.transition = on ? "filter 220ms ease-out" : "filter 700ms ease-in";
            el.style.filter = on ? "saturate(0.18) brightness(0.9)" : "";
        }
    } catch (e) { /* */ }
}

// app.js drawEntities: a winner's screen position as a share of the screen
export function seen(id, fx, fy, fr) {
    let s = S.seen.get(id);
    if (!s) { s = { x: 0, y: 0, r: 0, at: 0 }; S.seen.set(id, s); }
    s.x = fx; s.y = fy; s.r = fr; s.at = performance.now();
}

// ── the shake ─────────────────────────────────────────────────────────────
// A hard hit at the freeze and a smaller thud when the crown lands. It moves
// the whole game layer with a CSS transform (the compositor does it, no canvas
// work), so it keeps going through the hit-stop, when no frames are drawn.
// No Screen Shake or reduced motion: no shake at all. Both are over well
// before the podium comes up.
const K = { n: 0, at: new Float64Array(2), amp: new Float32Array(2), rot: new Float32Array(2), ms: new Float32Array(2) };
let wrapEl = null, shaking = false;
// amp is a share of the smaller screen side, rot is degrees
function kick(now, amp, rot, ms) {
    if (!shakeOn() || calm()) return;
    const i = K.n < 2 ? K.n++ : 0;
    K.at[i] = now; K.amp[i] = amp; K.rot[i] = rot; K.ms[i] = ms;
}
// app.js renderFrame, every frame (hit-stop included)
export function shakeFrame(now) {
    if (!K.n && !shaking) return;
    if (!wrapEl) wrapEl = document.getElementById("gameAreaWrapper");
    if (!wrapEl) return;
    let dx = 0, dy = 0, dr = 0, peak = 0;
    const on = shakeOn() && !calm();
    for (let i = 0; i < K.n; i++) {
        const t = now - K.at[i];
        if (!on || t > K.ms[i]) {
            // done: the last one takes its slot
            const j = --K.n;
            K.at[i] = K.at[j]; K.amp[i] = K.amp[j]; K.rot[i] = K.rot[j]; K.ms[i] = K.ms[j];
            i--;
            continue;
        }
        if (t < 0) continue;
        // a snap in over 35 ms, then a fast fall that eases to nothing
        const u = t / K.ms[i];
        const env = (t < 35 ? t / 35 : 1) * Math.exp(-3.6 * u) * (1 - u);
        const a = K.amp[i] * env;
        // the first beat slams down, then it rattles every way
        const slam = t < 90 ? 1 - t / 90 : 0;
        dx += a * (Math.sin(t * 0.071 + 1.3) * 0.62 + Math.sin(t * 0.163 + 0.2) * 0.38) * (1 - slam * 0.7);
        dy += a * (Math.cos(t * 0.089 + 0.5) * 0.58 + Math.sin(t * 0.141 + 2.1) * 0.42) * (1 - slam) + a * slam;
        dr += K.rot[i] * env * Math.sin(t * 0.053 + 0.9);
        if (a > peak) peak = a;
    }
    if (!K.n) {
        if (shaking) { shaking = false; wrapEl.style.transform = ""; }
        return;
    }
    shaking = true;
    // a little zoom with it, so the moved layer never shows its edges
    const side = Math.max(1, Math.min(window.innerWidth, window.innerHeight));
    const sc = 1 + 3.2 * peak + 0.004;
    wrapEl.style.transform = "translate(" + (dx * side).toFixed(1) + "px," + (dy * side).toFixed(1) + "px) rotate(" + dr.toFixed(2) + "deg) scale(" + sc.toFixed(3) + ")";
}
// QA hook: live kicks and the transform they set
window.dwFinaleShake = () => { const tr = wrapEl ? wrapEl.style.transform : ""; return { n: K.n, tr }; };

// ── baked art ─────────────────────────────────────────────────────────────
let crownSpr = null, spotSpr = null, raySpr = null;
// the flat ink-rimmed crown (crownArt.js), baked big enough for the drop
function crownSprite() {
    if (!crownSpr) crownSpr = crownArt.crownSprite("gold", 192);
    return crownSpr;
}
// dark everywhere except a soft round hole in the middle
function spotSprite() {
    if (spotSpr) return spotSpr;
    const N = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = N;
    const c = cv.getContext("2d");
    const g = c.createRadialGradient(N / 2, N / 2, N * 0.2, N / 2, N / 2, N / 2);
    g.addColorStop(0, "rgba(8,6,12,0)");
    g.addColorStop(0.55, "rgba(8,6,12,0.55)");
    g.addColorStop(1, "rgba(8,6,12,1)");
    c.fillStyle = "rgba(8,6,12,1)";
    c.fillRect(0, 0, N, N);
    c.globalCompositeOperation = "destination-out";
    const hole = c.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    hole.addColorStop(0, "rgba(0,0,0,1)");
    hole.addColorStop(0.45, "rgba(0,0,0,1)");
    hole.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = hole;
    c.fillRect(0, 0, N, N);
    spotSpr = cv;
    return cv;
}
// soft gold rays with the middle cut out, so they never sit on the tank
function raySprite() {
    if (raySpr) return raySpr;
    const N = 512, R = N / 2, RAYS = 14;
    const cv = document.createElement("canvas");
    cv.width = cv.height = N;
    const c = cv.getContext("2d");
    const g = c.createRadialGradient(R, R, R * 0.3, R, R, R);
    g.addColorStop(0, "rgba(255,220,120,0.9)");
    g.addColorStop(0.5, "rgba(255,205,95,0.4)");
    g.addColorStop(1, "rgba(255,200,90,0)");
    c.beginPath();
    const step = Math.PI * 2 / RAYS;
    for (let i = 0; i < RAYS; i++) {
        const a = i * step, inner = step * 0.09, outer = step * 0.24;
        c.moveTo(R + Math.cos(a - inner) * R * 0.3, R + Math.sin(a - inner) * R * 0.3);
        c.lineTo(R + Math.cos(a - outer) * R, R + Math.sin(a - outer) * R);
        c.lineTo(R + Math.cos(a + outer) * R, R + Math.sin(a + outer) * R);
        c.lineTo(R + Math.cos(a + inner) * R * 0.3, R + Math.sin(a + inner) * R * 0.3);
        c.closePath();
    }
    c.fillStyle = g;
    c.fill();
    raySpr = cv;
    return cv;
}

// ── confetti and gems ─────────────────────────────────────────────────────
// A fixed pool in typed arrays: nothing is allocated while it runs.
const MAXP = 240;
const P = {
    n: 0,
    x: new Float32Array(MAXP), y: new Float32Array(MAXP),
    vx: new Float32Array(MAXP), vy: new Float32Array(MAXP),
    rot: new Float32Array(MAXP), vr: new Float32Array(MAXP),
    fl: new Float32Array(MAXP), vf: new Float32Array(MAXP),
    sz: new Float32Array(MAXP), age: new Float32Array(MAXP), life: new Float32Array(MAXP),
    kind: new Uint8Array(MAXP), col: new Uint8Array(MAXP),
};
const PAPER = ["#f2b83c", "#e07b2e", "#3fcf7a", "#b98bff", "#4ec4e8", "#fff3d9", "#e0473b"];
const GEMS = ["gemPickupCopper", "gemPickupVein", "gemPickupShard", "gemPickupEmerald"];
function emit(x, y, vx, vy, kind, size, life) {
    if (P.n >= MAXP) return;
    const i = P.n++;
    const still = calm();
    P.x[i] = x; P.y[i] = y; P.vx[i] = vx; P.vy[i] = vy;
    P.rot[i] = Math.random() * Math.PI * 2;
    P.vr[i] = still ? 0 : (Math.random() - 0.5) * (kind ? 5 : 12);
    P.fl[i] = Math.random() * Math.PI * 2;
    P.vf[i] = still ? 0 : 5 + Math.random() * 9;
    P.sz[i] = size; P.age[i] = 0; P.life[i] = life;
    P.kind[i] = kind;
    P.col[i] = kind ? (Math.random() * GEMS.length) | 0 : (Math.random() * PAPER.length) | 0;
}
function amount(n) { return Math.round(n * (calm() ? 0.3 : lite() ? 0.35 : 1)); }
function burstAt(x, y, W, H) {
    const still = calm();
    const sp = still ? 0.45 : 1;
    for (let i = amount(70); i > 0; i--) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
        const v = (650 + Math.random() * 750) * sp;
        emit(x, y, Math.cos(a) * v, Math.sin(a) * v, 0, 9 + Math.random() * 7, 5);
    }
    // two cannons from the bottom corners
    for (const side of [0, 1]) {
        for (let i = amount(34); i > 0; i--) {
            const a = side ? -Math.PI * 0.68 + (Math.random() - 0.5) * 0.35 : -Math.PI * 0.32 + (Math.random() - 0.5) * 0.35;
            const v = (1250 + Math.random() * 650) * sp;
            emit(side ? W + 10 : -10, H + 10, Math.cos(a) * v, Math.sin(a) * v, 0, 9 + Math.random() * 7, 5);
        }
    }
}
function stepParticles(dt, W, H) {
    const still = calm();
    const g = still ? 520 : 1250;
    for (let i = 0; i < P.n; i++) {
        P.age[i] += dt;
        if (P.kind[i]) {
            P.vy[i] += g * 0.45 * dt;
            P.vx[i] *= 1 - 0.6 * dt;
        } else {
            P.vy[i] += g * dt;
            // paper: heavy drag, a terminal fall speed and a sideways flutter
            const d = 1 - 2.6 * dt;
            P.vx[i] *= d; P.vy[i] *= d;
            if (P.vy[i] > 260) P.vy[i] = 260;
            if (!still) P.vx[i] += Math.sin(P.fl[i] * 0.7) * 160 * dt;
        }
        P.x[i] += P.vx[i] * dt;
        P.y[i] += P.vy[i] * dt;
        P.rot[i] += P.vr[i] * dt;
        P.fl[i] += P.vf[i] * dt;
        if (P.age[i] > P.life[i] || P.y[i] > H + 60 || P.x[i] < -80 || P.x[i] > W + 80) {
            const j = --P.n;
            if (i !== j) {
                P.x[i] = P.x[j]; P.y[i] = P.y[j]; P.vx[i] = P.vx[j]; P.vy[i] = P.vy[j];
                P.rot[i] = P.rot[j]; P.vr[i] = P.vr[j]; P.fl[i] = P.fl[j]; P.vf[i] = P.vf[j];
                P.sz[i] = P.sz[j]; P.age[i] = P.age[j]; P.life[i] = P.life[j];
                P.kind[i] = P.kind[j]; P.col[i] = P.col[j];
            }
            i--;
        }
    }
}
function drawParticles(c) {
    if (!P.n) return;
    c.save();
    c.lineWidth = 1.8;
    c.strokeStyle = "#120e15";
    for (let i = 0; i < P.n; i++) {
        const fade = P.life[i] - P.age[i] < 0.6 ? (P.life[i] - P.age[i]) / 0.6 : 1;
        c.globalAlpha = fade;
        c.save();
        c.translate(P.x[i], P.y[i]);
        c.rotate(P.rot[i]);
        const s = P.sz[i];
        if (P.kind[i]) {
            const spr = A.gemSprite(GEMS[P.col[i]]);
            const h = spr.half * s * 1.1;
            c.drawImage(spr.canvas, -h, -h, h * 2, h * 2);
        } else {
            const fl = Math.cos(P.fl[i]);
            c.scale(1, fl < 0 ? Math.min(-0.15, fl) : Math.max(0.15, fl));
            c.fillStyle = PAPER[P.col[i]];
            c.fillRect(-s * 0.5, -s * 0.28, s, s * 0.56);
            c.strokeRect(-s * 0.5, -s * 0.28, s, s * 0.56);
        }
        c.restore();
    }
    c.restore();
}

// ── text ──────────────────────────────────────────────────────────────────
const fonts = new Map();
function titleFont(size) {
    const k = Math.round(size);
    let f = fonts.get(k);
    if (!f) { f = "700 " + k + "px " + A.HUD.font; if (fonts.size > 64) fonts.clear(); fonts.set(k, f); }
    return f;
}
// A chunky title: ink rim, a darker copy dropped under it, the fill on top.
function bigTitle(c, text, x, y, size, fill, dark, alpha, scale = 1) {
    if (alpha <= 0.01) return;
    c.save();
    c.globalAlpha *= alpha;
    c.translate(x, y);
    if (scale !== 1) c.scale(scale, scale);
    c.font = titleFont(size);
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineJoin = "round";
    c.lineWidth = Math.max(4, size * 0.16);
    c.strokeStyle = A.HUD.line;
    c.strokeText(text, 0, 0);
    c.fillStyle = fill;
    c.fillText(text, 0, 0);
    c.restore();
}
// red and cyan ghosts of a title pulled apart sideways, added over it
function splitTitle(c, text, x, y, size, scale, k) {
    const d = size * 0.13 * Math.sqrt(k);
    if (d < 0.5) return;
    c.save();
    c.translate(x, y);
    if (scale !== 1) c.scale(scale, scale);
    c.font = titleFont(size);
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.globalCompositeOperation = "lighter";
    c.globalAlpha = 0.55 * k;
    c.fillStyle = "#ff2e4a";
    c.fillText(text, -d, d * 0.25);
    c.fillStyle = "#2ee6ff";
    c.fillText(text, d, -d * 0.25);
    c.restore();
}
// "<name> won the raid" with the name in gold
function nameLine(c, name, rest, x, y, size, alpha) {
    const HUD = A.HUD;
    const wn = A.hudTitleW(name, size), wr = A.hudTitleW(rest, size);
    const x0 = x - (wn + wr) / 2;
    A.hudTitle(name, x0, y, size, HUD.gold, "left", alpha, c);
    A.hudTitle(rest, x0 + wn, y, size, HUD.head, "left", alpha, c);
}
function fitSize(text, size, maxW, min = 10) {
    const w = A.hudTitleW(text, size);
    return w <= maxW ? size : Math.max(min, Math.floor(size * maxW / w));
}
// The podium's small lines are drawText, so they're measured in its font
// (hudTitleW is the title face and runs narrow for them, which let "10,163
// gems banked this raid" spill past its column). Cached: measureText makes
// garbage, and these redraw every frame.
const fitCache = new Map();
function fitLine(text, size, maxW, min = 8) {
    const key = text + "|" + size + "|" + maxW;
    let v = fitCache.get(key);
    if (v == null) {
        const w = A.measureText ? A.measureText(text, size) : A.hudTitleW(text, size) * 1.15;
        v = w <= maxW ? size : Math.max(min, Math.floor(size * maxW / w * 10) / 10);
        if (fitCache.size > 200) fitCache.clear();
        fitCache.set(key, v);
    }
    return v;
}
// "10,163 gems banked this raid" when it fits the column at full size,
// else "10,163 gems banked", else "10,163 banked" (shrunk if it must be)
function bankedFit(gems, prefix, size, maxW) {
    const n = A.fmtNum(Math.max(0, gems | 0));
    const opts = [SL.podiumBanked(gems), n + " gems banked", n + " banked"];
    for (const o of opts) { const t = prefix + o; if (fitLine(t, size, maxW) >= size) return [t, size]; }
    const t = prefix + opts[2];
    return [t, fitLine(t, size, maxW)];
}
function shortName(n, max) { n = String(n || "Unnamed"); return n.length > max ? n.slice(0, max - 1) + "…" : n; }

// ── the frame ─────────────────────────────────────────────────────────────
// The winner on screen, in GUI units: the fresh sighting nearest the middle.
function focus(now, W, H) {
    let best = null, bd = Infinity;
    for (const s of S.seen.values()) {
        if (now - s.at > 300) continue;
        const dx = s.x - 0.5, dy = s.y - 0.5, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = s; }
    }
    S.fok = !!best;
    if (!best) return false;
    S.fx = best.x * W; S.fy = best.y * H; S.fr = Math.max(14, best.r * W);
    return true;
}

export function draw() {
    if (!S.on && D.on && A) { drawDock(); return; }
    if (!S.on || !A) return;
    const now = performance.now();
    const t = now - S.at;
    if (t > END_MS) { stop(); return; }
    const c = A.ctx();
    const W = global.screenWidth, H = global.screenHeight;
    const HUD = A.HUD;
    const dt = S.lastTick ? Math.min(0.05, (now - S.lastTick) / 1000) : 0;
    S.lastTick = now;
    const still = calm();
    focus(now, W, H);
    if (t > FREEZE_OUT) setFreezeFilter(false);
    // the dead queue for the next raid once the camera has landed
    if (global.died && !S.respawnAsked && t > 3200 && !global._specGlide && !global.respawnPending) {
        S.respawnAsked = true;
        // the only respawn the finale lets through (canvas.respawn refuses clicks and
        global.finaleRespawn = true;
        try { global.canvas.respawn(); } catch (e) { /* */ }
        global.finaleRespawn = false;
    }
    // the podium and your numbers were up long enough to read
    if (S.reveal && now - S.reveal > PODIUM_AT + 2000 && S.raidId && !document.hidden) S.seenRaid = S.raidId;
    if (!S.reveal && t > REVEAL_MIN) {
        const near = S.fok && Math.abs(S.fx - W / 2) < W * 0.2 && Math.abs(S.fy - H / 2) < H * 0.22;
        if (near || t > REVEAL_MAX) reveal(now, W, H);
    }
    c.save();

    // ── the freeze: a cold wash, the flash, two shockwaves, RAID OVER ────
    if (t < TITLE_OUT + 300) {
        const k = Math.min(1, t / 200) * (t > FREEZE_OUT - 300 ? clamp((FREEZE_OUT + 200 - t) / 500) : 1);
        c.globalAlpha = 0.34 * k;
        c.fillStyle = A.HUD && A.HUD.theme === "light" ? "#ffffff" : "#1a1526";
        c.fillRect(0, 0, W, H);
        if (t < 160) {
            c.globalAlpha = (still ? 0.3 : 0.6) * (1 - t / 160);
            c.fillStyle = "#fff6dc";
            c.fillRect(0, 0, W, H);
        }
        if (!still) {
            const u = Math.min(W, H);
            for (let i = 0; i < (lite() ? 1 : 2); i++) {
                const kk = (t - i * 240) / 1300;
                if (kk < 0 || kk > 1) continue;
                c.globalAlpha = (1 - kk) * 0.75;
                c.lineWidth = u * 0.028 * (1 - kk) + 2;
                c.strokeStyle = i ? "#ffffff" : "#ffd76e";
                c.beginPath(); c.arc(W / 2, H / 2, u * 0.08 + kk * Math.max(W, H) * 0.75, 0, Math.PI * 2); c.stroke();
            }
        }
        c.globalAlpha = 1;
        const pop = still ? 1 : t < 240 ? 1.4 - 0.4 * easeOut(t / 240) : 1;
        const out = t > TITLE_OUT - 400 ? clamp((TITLE_OUT - t) / 400) : 1;
        const lift = t > TITLE_OUT - 400 ? (1 - out) * 60 : 0;
        const size = Math.min(150, W * 0.1);
        // it lands at full strength on the frame the hit-stop holds, and the
        // hit splits its colour for a moment
        bigTitle(c, "RAID OVER", W / 2, H * 0.42 - lift, size, HUD.gold, HUD.goldDk, (still ? Math.min(1, t / 120) : 1) * out, pop);
        if (!still && shakeOn() && t < 600) splitTitle(c, "RAID OVER", W / 2, H * 0.42 - lift, size, pop, 1 - t / 600);
        if (S.sub) A.hudTitle(S.sub, W / 2, H * 0.42 + size * 0.72 - lift, 30, HUD.head, "center", Math.min(1, t / 300) * out, c);
    }

    // ── the flight: the screen dims while the camera travels ─────────────
    if (t > FREEZE_OUT - 200) {
        const k = clamp((t - FREEZE_OUT + 200) / 700);
        const spot = S.reveal ? easeOut(clamp((now - S.reveal) / 500)) : 0;
        drawSpotlight(c, W, H, 0.5 * k + 0.2 * spot, spot);
    }

    if (S.reveal) {
        const rt = now - S.reveal;
        drawWinnerFx(c, rt, now);
        if (S.crownAt && !still && now - S.crownAt < 140) {
            c.globalAlpha = 0.16 * (1 - (now - S.crownAt) / 140);
            c.fillStyle = "#fff6dc";
            c.fillRect(0, 0, W, H);
            c.globalAlpha = 1;
        }
        if (dt > 0) {
            // a gem shower for the first seconds, then a light paper trickle
            if (!lite() && rt < 2600) {
                S.gemAcc += dt * (still ? 3 : 11);
                while (S.gemAcc >= 1) { S.gemAcc -= 1; emit(Math.random() * W, -30, (Math.random() - 0.5) * 80, 120 + Math.random() * 200, 1, 12 + Math.random() * 8, 6); }
            }
            if (rt < 9000) {
                S.paperAcc += dt * (still ? 2 : lite() ? 3 : 9);
                while (S.paperAcc >= 1) { S.paperAcc -= 1; emit(Math.random() * W, -20, (Math.random() - 0.5) * 60, 60 + Math.random() * 80, 0, 9 + Math.random() * 6, 9); }
            }
            stepParticles(dt, W, H);
        }
        drawParticles(c);
        drawTitles(c, rt, W, H);
        drawPanels(c, rt, now, W, H);
        drawNext(c, rt, now, W, H);
    }
    c.restore();
    if (S.holdArmed) {
        S.holdArmed = false;
        global.hitStop = Math.max(global.hitStop || 0, Date.now() + (S.cw && S.isWin ? 520 : 240));
    }
    // the share card's backdrop: the world once the crown is on
    if (S.reveal && !S.snapped && now - S.reveal > 700) {
        S.snapped = true;
        raidShare.snapView(S.fok, S.fx, S.fy, S.fr);
    }
}

function reveal(now, W, H) {
    S.reveal = now;
    const x = S.fok ? S.fx : W / 2, y = S.fok ? S.fy - S.fr : H / 2;
    burstAt(x, y, W, H);
    try {
        if (S.cw && S.isWin && gameSound.champion) gameSound.champion();
        else if (S.isWin) gameSound.rankUp(true);
        else if (S.cw && S.place <= 3) gameSound.rankUp(false);
        else gameSound.bankCelebrate();
    } catch (e) { /* */ }
    // the champion: a second, bigger burst of paper
    if (S.cw && S.isWin) burstAt(W / 2, H * 0.2, W, H);
}

function drawSpotlight(c, W, H, alpha, spot) {
    if (alpha <= 0.01) return;
    c.save();
    c.globalAlpha = alpha;
    // no winner on screen (a winner who was down at the bell): an even dim
    if (!S.fok || spot <= 0) {
        c.fillStyle = "rgba(8,6,12,1)";
        c.fillRect(0, 0, W, H);
        c.restore();
        return;
    }
    let cx = S.fx, cy = S.fy, R = Math.max(210, S.fr * 3.4);
    // duos: one hole wide enough for both partners when they stand close
    if (S.seen.size > 1) {
        const now = performance.now();
        for (const s of S.seen.values()) {
            if (now - s.at > 300) continue;
            const sx = s.x * W, sy = s.y * H;
            const d = Math.hypot(sx - S.fx, sy - S.fy);
            if (d < 1 || d > 700) continue;
            cx = (S.fx + sx) / 2; cy = (S.fy + sy) / 2;
            R = Math.max(R, d / 2 + S.fr * 3);
        }
    }
    R *= 1.25 - 0.25 * spot;
    const x0 = cx - R, y0 = cy - R, x1 = cx + R, y1 = cy + R;
    c.drawImage(spotSprite(), x0, y0, R * 2, R * 2);
    c.fillStyle = "rgba(8,6,12,1)";
    if (y0 > 0) c.fillRect(0, 0, W, y0);
    if (y1 < H) c.fillRect(0, y1, W, H - y1);
    const top = Math.max(0, y0), bot = Math.min(H, y1);
    if (bot > top) {
        if (x0 > 0) c.fillRect(0, top, x0, bot - top);
        if (x1 < W) c.fillRect(x1, top, W - x1, bot - top);
    }
    c.restore();
}

// rays behind each winner, and a crown dropping onto them
function drawWinnerFx(c, rt, now) {
    if (!S.fok) return;
    const W = global.screenWidth, H = global.screenHeight;
    const still = calm();
    const cs = crownSprite();
    for (const s of S.seen.values()) {
        if (now - s.at > 300) continue;
        const x = s.x * W, y = s.y * H, r = Math.max(14, s.r * W);
        if (glowOn() && !lite()) {
            const R = Math.max(230, r * 4.2) * (0.6 + 0.4 * easeOut(clamp(rt / 700)));
            c.save();
            c.globalAlpha = 0.7 * clamp(rt / 500);
            c.translate(x, y);
            if (!still) c.rotate(now / 7000);
            c.drawImage(raySprite(), -R, -R, R * 2, R * 2);
            c.restore();
        }
        const g = Math.max(66, Math.min(160, r * 1.5));
        const sc = g / cs.w;
        // above the name plate, which sits right over the tank (your own
        // tank has none)
        const land = y - r - (s === S.seen.get(A.selfId()) ? 4 : Math.max(44, r * 0.5));
        const k = clamp(rt / 650);
        // the first touch of the bounce: a thud
        if (!S.crownHit && k >= 1 / 2.75) {
            S.crownHit = true;
            S.crownAt = now;
            kick(now, 0.016, 0.5, 480);
        }
        const dropY = still ? 0 : -(1 - easeBounce(k)) * (land + g);
        const bob = still ? 0 : Math.sin(now / 430) * g * 0.04;
        c.save();
        c.globalAlpha = still ? clamp(rt / 400) : Math.min(1, rt / 90);
        c.translate(x, land + dropY + bob);
        c.rotate(still ? 0 : Math.sin(now / 900) * 0.05);
        c.scale(sc, sc);
        c.drawImage(cs.cv, -cs.ax, -cs.ay);
        c.restore();
    }
}

// The line under a big title: never into it
export function subY(y, size, subSize, k = 0.68) {
    return y + Math.max(size * k, size * 0.62 + subSize * 0.55 + 8);
}
function drawTitles(c, rt, W, H) {
    const HUD = A.HUD;
    const k = clamp((rt - 180) / 420);
    if (k <= 0) return;
    const still = calm();
    const pop = still ? 1 : 0.55 + 0.45 * easeBack(k);
    const a = Math.min(1, k * 2);
    const y = Math.max(96, H * 0.15);
    const winTxt = S.winner || "Nobody";
    if (S.cw) { drawCrownTitles(c, rt, W, H, y, a, pop); return; }
    if (S.isWin) {
        const size = Math.min(150, W * 0.105);
        bigTitle(c, "VICTORY", W / 2, y, size, HUD.gold, HUD.goldDk, a, pop);
        const sub = S.duos ? (S.mate ? "You and " + shortName(S.mate, 20) + " won it together" : "Your team won the raid")
            : S.rows > 1 ? "You won the raid, #1 of " + S.rows : "You won the raid";
        const s2 = fitSize(sub, 30, W - 60);
        A.hudTitle(sub, W / 2, subY(y, size, s2, 0.68), s2, HUD.head, "center", clamp((rt - 450) / 400), c);
        return;
    }
    const place = S.place;
    const title = place === 2 || place === 3 ? "#" + place : place > 0 ? "YOU PLACED #" + place : "RAID OVER";
    const size = place === 2 || place === 3 ? Math.min(160, W * 0.11) : Math.min(104, W * 0.075);
    const fill = place === 2 ? "#e6e1ee" : place === 3 ? HUD.copper : HUD.head;
    const dark = place === 2 ? "#8d8799" : place === 3 ? HUD.copperDk : "#9a8d78";
    bigTitle(c, title, W / 2, y, fitSize(title, size, W - 60, 40), fill, dark, a, pop);
    const lead = place === 2 ? "So close. " : place === 3 ? "On the podium. " : "";
    const size2 = fitSize(lead + winTxt + " won the raid", 30, W - 60, 14);
    const a2 = clamp((rt - 450) / 400);
    if (lead) {
        const wl = A.hudTitleW(lead, size2), wn = A.hudTitleW(winTxt, size2), wr = A.hudTitleW(" won the raid", size2);
        const x0 = W / 2 - (wl + wn + wr) / 2, yy = subY(y, size, size2, 0.62);
        A.hudTitle(lead, x0, yy, size2, HUD.head, "left", a2, c);
        A.hudTitle(winTxt, x0 + wl, yy, size2, HUD.gold, "left", a2, c);
        A.hudTitle(" won the raid", x0 + wl + wn, yy, size2, HUD.head, "left", a2, c);
    } else nameLine(c, winTxt, " won the raid", W / 2, subY(y, size, size2, 0.66), size2, a2);
}

// A crown raid's words (crownsLogic.finale): CORE CHAMPION for the winner (#1 by
const CW_COL = { gold: ["#f2b83c", "#a8750f"], silver: ["#e6e1ee", "#8d8799"], bronze: ["#e07b2e", "#9e4a14"] };
function drawCrownTitles(c, rt, W, H, y, a, pop) {
    const HUD = A.HUD, cw = S.cw;
    const a2 = clamp((rt - 450) / 400);
    if (cw.champLine) {
        // someone else won: their name, big and gold
        const size = fitSize(cw.title, Math.min(120, W * 0.085), W - 80, 36);
        bigTitle(c, cw.title, W / 2, y, size, HUD.gold, HUD.goldDk, a, pop);
        const tail = S.place > 0 ? "  ·  You placed #" + S.place : "";
        const sub = cw.sub + tail;
        const s2 = fitSize(sub, 30, W - 60, 14);
        A.hudTitle(sub, W / 2, subY(y, size, s2, 0.68), s2, HUD.head, "center", a2, c);
        return;
    }
    const [fill, dark] = CW_COL[cw.col] || CW_COL.gold;
    const size = fitSize(cw.title, cw.col === "gold" ? Math.min(150, W * 0.1) : Math.min(124, W * 0.085), W - 60, 40);
    bigTitle(c, cw.title, W / 2, y, size, fill, dark, a, pop);
    if (S.isWin) {
        let sub = S.duos && S.mate ? "You and " + shortName(S.mate, 20) + " took the crown home" : cw.sub;
        if (S.streak && S.streak.kind === "win" && S.streak.n > 1) sub += "  ·  " + S.streak.n + " wins in a row";
        else {
            const cs = global.royale && global.royale.you && global.royale.you.cs | 0;
            if (cs > 1) sub += "  ·  " + cs + " wins in a row";
        }
        const s2 = fitSize(sub, 30, W - 60, 14);
        A.hudTitle(sub, W / 2, subY(y, size, s2, 0.68), s2, HUD.head, "center", a2, c);
        return;
    }
    // 2nd / 3rd: the champion's name in gold inside the line
    const nm = S.winner || "Nobody", rest = cw.rest || " is the Core Champion";
    const s2 = fitSize(nm + rest, 30, W - 60, 14);
    const wn = A.hudTitleW(nm, s2), wr = A.hudTitleW(rest, s2);
    const x0 = W / 2 - (wn + wr) / 2, yy = subY(y, size, s2, 0.64);
    A.hudTitle(nm, x0, yy, s2, HUD.gold, "left", a2, c);
    A.hudTitle(rest, x0 + wn, yy, s2, HUD.head, "left", a2, c);
}

// Side plates on a wide screen, leaving the winner in the middle clear;
// stacked at the bottom otherwise.
const PW = 440, PH = 330, GAP = 16;
const lay = { side: true, s: 1, lx: 0, ly: 0, rx: 0, ry: 0 };
function layout(W, H) {
    lay.side = W >= 1400 && H >= 640;
    if (lay.side) {
        lay.s = 1;
        lay.lx = Math.max(A.HUD.edge, W / 2 - 300 - PW);
        lay.rx = Math.min(W - A.HUD.edge - PW, W / 2 + 300);
        lay.ly = lay.ry = Math.max(H * 0.15 + 110, H * 0.5 - PH / 2 + 30);
    } else {
        const ph = Math.max(PH, rewardsH());
        const s = Math.min(1, (W - 2 * A.HUD.edge) / (PW * 2 + GAP), (H * 0.5) / ph);
        lay.s = s;
        const x0 = W / 2 - (PW * 2 + GAP) * s / 2;
        lay.lx = x0; lay.rx = x0 + (PW + GAP) * s;
        lay.ly = lay.ry = H - 92 - ph * s;
    }
}

function drawPanels(c, rt, now, W, H) {
    layout(W, H);
    const still = calm();
    const kp = clamp((rt - PODIUM_AT) / 450), kr = clamp((rt - REWARDS_AT) / 450);
    if (kp > 0) {
        c.save();
        c.translate(lay.lx - (still ? 0 : (1 - easeOut(kp)) * 120), lay.ly);
        c.scale(lay.s, lay.s);
        c.globalAlpha = easeOut(kp);
        drawPodium(c, rt - PODIUM_AT);
        c.restore();
    }
    if (kr > 0) {
        c.save();
        c.translate(lay.rx + (still ? 0 : (1 - easeOut(kr)) * 120), lay.ry);
        c.scale(lay.s, lay.s);
        c.globalAlpha = easeOut(kr);
        drawRewards(c, rt - REWARDS_AT, now);
        c.restore();
    }
    // Share sits on the top right corner of the raid card, once it is in
    // (a short screen has no room above the card: the bottom right corner,
    // beside the next-raid bar)
    if (rt > REWARDS_AT + 350) {
        if (lay.side) raidShare.place(lay.rx + PW * lay.s, lay.ry - 10, shareInfo);
        else raidShare.place(W - A.HUD.edge * 0.8, H - A.HUD.edge * 0.6, shareInfo);
    }
    if (S.dc && rt > PODIUM_AT + 900) placeDiscord(W, H);
    if (S.on && rt > REWARDS_AT + 700 && keepNudge.wanted()) placeKeep(W, H);
}
// The guest's "Keep my stuff" card: under your raid's plate when the plates
// sit side by side, else centred just above the two plates.
function placeKeep(W, H) {
    const k = window.innerWidth / Math.max(1, global.screenWidth);
    const sz = keepNudge.size();
    const ew = sz.w / k, eh = sz.h / k;
    let x, y;
    if (lay.side) {
        x = lay.rx + (PW * lay.s - ew) / 2;
        y = lay.ry + rewardsH() * lay.s + 18;
        if (y + eh > H - 12) y = lay.ry - eh - 16;
    } else {
        x = W / 2 - ew / 2;
        y = lay.ly - eh - 14;
    }
    keepNudge.place(x * k, Math.max(8, y) * k);
}
function shareInfo() {
    return {
        place: S.place, rows: S.rows, duos: S.duos, name: global.playerName || "Unnamed",
        score: S.me.score, kills: S.me.kills, banked: S.me.banked, top: S.top,
        fok: S.fok, fx: S.fx, fy: S.fy, fr: S.fr, crown: crownSprite(),
        champ: !!(S.cw && S.isWin), crownCol: S.cw && S.isWin ? S.cw.col : "", champName: S.cw ? S.winner : "",
    };
}

const RANK_COL = [null, ["#f2b83c", "#a8750f"], ["#e6e1ee", "#8d8799"], ["#e07b2e", "#9e4a14"]];
const SLOTS = [2, 1, 3];
const BLOCK_H = [0, 172, 138, 110];
function drawPodium(c, pt) {
    const HUD = A.HUD;
    A.hudPanel(c, 0, 0, PW, PH, { fill: HUD.solid, r: HUD.rBig, lip: 5 });
    A.hudTitle(S.duos ? "Top teams" : "Top 3", 20, 30, 22, HUD.gold, "left", 1, c);
    A.drawText("Top 10 all get paid", PW - 20, 30, 12, HUD.text2, "right", true);
    const colW = 124, gap = 12, x0 = (PW - colW * 3 - gap * 2) / 2, baseY = PH - 20;
    const still = calm();
    for (let si = 0; si < 3; si++) {
        const rank = SLOTS[si];
        const row = S.top[rank - 1];
        const bx = x0 + si * (colW + gap);
        // 3rd rises first, the winner last
        const delay = rank === 3 ? 0 : rank === 2 ? 170 : 340;
        const k = clamp((pt - 250 - delay) / 480);
        if (k > 0 && S.podSnd < 4 - rank) {
            S.podSnd = 4 - rank;
            try { if (rank === 1) gameSound.depositDone(); else gameSound.gemPickup(3 - rank); } catch (e) { /* */ }
        }
        const rise = still ? (k > 0 ? 1 : 0) : easeBack(k);
        const h = BLOCK_H[rank] * Math.max(0, rise);
        const top = baseY - h;
        const [col, dk] = RANK_COL[rank];
        if (h > 2) {
            A.hudPanel(c, bx, top, colW, h, { fill: HUD.raised, r: HUD.r });
            c.save();
            c.beginPath();
            c.rect(bx, top, colW, 5);
            c.fillStyle = col;
            c.fill();
            c.restore();
        }
        if (k <= 0.35) continue;
        const a = clamp((k - 0.35) / 0.4);
        bigTitle(c, String(rank), bx + colW / 2, top + 36, 38, col, dk, a);
        if (!row) {
            A.drawText("Nobody", bx + colW / 2, top + 72, 12, HUD.text2, "center", true, a);
            continue;
        }
        A.hudTitle(A.fmtNum(row.score | 0), bx + colW / 2, top + 68, 20, HUD.head, "center", a, c);
        // what the points are made of
        const cl = CL.crownLine(row);
        const kl = (row.kills | 0) + ((row.kills | 0) === 1 ? " kill" : " kills");
        const lineW = colW - 12;
        if (cl) {
            const [kb, ks] = bankedFit(row.gems, kl + " · ", 11, lineW);
            A.drawText(kb, bx + colW / 2, top + 89, ks, HUD.text2, "center", true, a);
            A.drawText(cl, bx + colW / 2, top + 103, fitLine(cl, 11, lineW), HUD.gold, "center", true, a);
        } else {
            A.drawText(kl, bx + colW / 2, top + 89, fitLine(kl, 11, lineW), HUD.text2, "center", true, a);
            const [bl, bs] = bankedFit(row.gems, "", 11, lineW);
            A.drawText(bl, bx + colW / 2, top + 103, bs, HUD.text2, "center", true, a);
        }
        // the name over the block; yours in gold. Duo names ("Kongming &
        // ZyroX") are long: they shrink to the column plus a little overhang.
        const name = shortName(row.name, S.duos ? 26 : 18);
        const mine = S.place === rank;
        const ns = fitSize(name, 17, colW + 4, 9);
        A.hudTitle(name, bx + colW / 2, top - 15, ns, mine ? HUD.gold : HUD.head, "center", a, c);
        if (rank === 1) {
            const cs = crownSprite();
            const g = 40, sc = g / cs.w;
            c.save();
            c.globalAlpha *= a;
            c.translate(bx + colW / 2, top - 30);
            c.scale(sc, sc);
            c.drawImage(cs.cv, -cs.ax, -cs.ay);
            c.restore();
        }
    }
}

// POINTS = BANKED + KILLS & CROWNS (scoreLogic.js), so the cells add up
const CELL_LABEL = ["POINTS", "BANKED THIS RAID", "KILLS + CROWNS"];
// rebuilt only when what they say changes
const chipCache = { key: "", n: 0, text: ["", ""], col: ["", ""] };
function rewardChips() {
    const st = S.streak;
    const key = S.me.next + "|" + (st ? st.kind + st.n : "") + "|" + S.place;
    if (key === chipCache.key) return chipCache;
    chipCache.key = key;
    chipCache.n = 0;
    const add = (t, col) => { chipCache.text[chipCache.n] = t; chipCache.col[chipCache.n] = col; chipCache.n++; };
    if (S.me.next > 0) add("Next raid: +" + A.fmtNum(S.me.next) + " starting gems", A.HUD.copper);
    if (st && st.n > 0) add(st.kind === "win" ? "Win streak x" + st.n : "Play streak day " + st.n, "#ffb347");
    // no starting-gem head start any more (nextGems is 0): no promise of one
    if (!chipCache.n) add(S.place === 1 ? "Champion" : S.place > 0 && S.place <= 3 ? "Top 3" : "Good raid", A.HUD.text2);
    return chipCache;
}
const RANK_H = 106, CB_H = 58;
// the rewards plate's height: the rank panel when there is one, and the
// come-back row once /api/daily has answered
function progRows() {
    const now = performance.now();
    if (S.prog && now - (S.progAt || 0) < 500) return S.prog;
    S.progAt = now;
    try {
        const acct = global.acct || null;
        const id = S.raidId | 0;
        let bestLife = 0;
        try { bestLife = +window.localStorage.getItem("dwBestLife") || 0; } catch (e) { /* */ }
        const lifeNow = !global.died && global.spawnedAt > 0 ? (now - global.spawnedAt) / 1000 : 0;
        S.prog = RP.rows({
            guest: !acct, rank: acct && acct.rank, rankCard: !!(A && A.rankHasContent()), rp: RP.rankThisRaid(id), rpSeen: RP.rankSeen(id),
            dust: acct ? +acct.dust || 0 : 0, nu: acct && acct.nu, bestLife, lifeNow,
            bestRaid: S.best ? S.best.best : 0, isBest: !!(S.best && S.best.isBest),
        });
    } catch (e) { S.prog = []; }
    return S.prog;
}
const PROG_ROW = 22;
const progH = () => { const n = progRows().length; return n ? 12 + n * PROG_ROW + 8 : 0; };
function rewardsH() {
    const hasRank = !!(A && A.rankHasContent());
    const pg = progH();
    if (!S.cb) return (hasRank ? PH : PH - RANK_H - 14) + pg;
    // the score cells, the chips, the rank panel, then the row and a margin
    return 52 + 66 + 12 + 34 + pg + (hasRank ? 14 + RANK_H : 0) + 14 + CB_H + 16;
}
const rowLabels = new Map();
function rowLabel(t) {
    let v = rowLabels.get(t);
    if (v === undefined) {
        v = String(t || "");
        if (v === v.toUpperCase()) v = v.charAt(0) + v.slice(1).toLowerCase();
        if (rowLabels.size > 64) rowLabels.clear();
        rowLabels.set(t, v);
    }
    return v;
}
function drawRewards(c, pt, now) {
    const HUD = A.HUD;
    const rankH = RANK_H;
    const hasRank = A.rankHasContent();
    const ph = rewardsH();
    A.hudPanel(c, 0, 0, PW, ph, { fill: HUD.solid, r: HUD.rBig, lip: 5 });
    A.hudTitle("Your raid", 20, 30, 22, HUD.gold, "left", 1, c);
    if (S.place > 0) A.hudTitle("#" + S.place + (S.rows > 1 ? " of " + S.rows : ""), PW - 20, 30, 22, S.place <= 3 ? RANK_COL[S.place][0] : HUD.head, "right", 1, c);
    // the counters tally up together
    const tk = clamp((pt - (TALLY_AT - REWARDS_AT)) / TALLY_MS);
    const e = easeOut(tk);
    if (tk > 0 && tk < 1 && now - (S._popAt || 0) > 90) { S._popAt = now; try { gameSound.dustPop(); } catch (er) { /* */ } }
    if (tk >= 1 && !S.tallyEnd) { S.tallyEnd = true; try { gameSound.dustBank(); } catch (er) { /* */ } }
    const cw = (PW - 40 - 16) / 3, wy = 52, wh = 66;
    for (let i = 0; i < 3; i++) {
        const x = 20 + i * (cw + 8);
        const full = i === 0 ? S.me.score : i === 1 ? S.me.banked : S.me.k + S.me.c;
        A.hudWell(c, x, wy, cw, wh, 10, i === 0 ? "rgba(242,184,60,0.12)" : HUD.well, HUD.ink, 2);
        // round 12: past the soft line the banked cell is the points the gems made
        const soft = i === 1 && S.me.bankG > S.me.banked;
        const lab = soft ? SL.BANK_PTS_LABEL : CELL_LABEL[i];
        A.drawText(rowLabel(lab), x + cw / 2, wy + 16, fitSize(rowLabel(lab), 12, cw - 12, 8), HUD.text2, "center", true);
        const size = fitSize(A.fmtNum(full), 26, cw - 14, 14);
        // playtest 9: counting up from 0 read as "no data yet" (0 / 0 / 0 for
        // two seconds), so the real numbers show at once; the tally is a pop
        const pk = tk > 0 && tk < 1 ? 1 + 0.08 * Math.sin(Math.PI * e) : 1;
        A.hudTitle((full < 0 ? "-" : "") + A.fmtNum(Math.abs(Math.round(full))), x + cw / 2, wy + 44, size * pk, i === 0 ? HUD.gold : i === 1 ? HUD.emerald : HUD.head, "center", 1, c);
    }
    // the next raid's head start and the streak
    const cy = wy + wh + 12, ch = 34;
    const chips = rewardChips();
    const chipK = clamp((pt - 900) / 400);
    const chipW = (PW - 40 - 8 * (chips.n - 1)) / chips.n;
    for (let i = 0; i < chips.n; i++) {
        const x = 20 + i * (chipW + 8);
        c.save();
        c.globalAlpha *= chipK;
        A.hudWell(c, x, cy, chipW, ch, ch / 2, HUD.well, HUD.ink, 2);
        c.restore();
        const txt = chips.text[i];
        A.drawText(txt, x + chipW / 2, cy + ch / 2, fitSize(txt, 13, chipW - 20, 9), chips.col[i], "center", true, chipK);
    }
    // progress: rank points, the next lobby unlock, your bests
    const pr = progRows(), pg = progH();
    if (pr.length) {
        const py = cy + ch + 12, pk = clamp((pt - 1000) / 400);
        c.save();
        c.globalAlpha *= pk;
        A.hudWell(c, 20, py, PW - 40, pg - 8, 10, HUD.well, HUD.ink, 2);
        c.restore();
        for (let i = 0; i < pr.length; i++) {
            const ry = py + 6 + PROG_ROW * i + PROG_ROW / 2;
            const col = pr[i].col === "gold" ? HUD.gold : pr[i].col === "play" ? HUD.play : pr[i].col === "lilac" ? (HUD.lilac || "#c9b6ff") : HUD.head;
            A.drawText(rowLabel(pr[i].k), 34, ry, 11, HUD.text2, "left", true, pk);
            A.drawText(pr[i].t, 118, ry, fitSize(pr[i].t, 12.5, PW - 40 - 112, 8.5), col, "left", true, pk);
        }
    }
    const cy2 = cy + pg;
    if (hasRank) A.rankDraw(c, 20, cy2 + ch + 14, PW - 40, rankH, clamp((pt - 600) / 400));
    if (S.cb) {
        const y = (hasRank ? cy2 + ch + 14 + rankH : cy2 + ch) + 14;
        c.save();
        c.globalAlpha *= clamp((performance.now() - S.cb.at) / 350) * clamp((pt - 1200) / 400);
        drawComeBack(c, 20, y, PW - 40, CB_H, now);
        c.restore();
    }
}

function drawNext(c, rt, now, W, H) {
    const HUD = A.HUD;
    const k = clamp((rt - NEXT_AT) / 400);
    if (k <= 0) return;
    // one deadline (socketinit), and the bar drains from wherever it was
    // when the plate came up, so it only ever empties
    const left = global.raidNextLeft ? global.raidNextLeft(now) : 0;
    if (!S.nextSpan && left > 0) S.nextSpan = Math.max(1, left);
    // three columns on the plate's midline: the countdown, the message over
    // its bar, the Keep button (mouse only: a phone keeps the auto flow)
    const w = Math.min(470, W - 32), h = 64, pad = 16, gap = 18;
    const x = W / 2 - w / 2, y = H - h - 22, my = y + h / 2;
    c.save();
    c.globalAlpha *= k;
    A.hudPanel(c, x, y, w, h, { fill: HUD.solid, r: HUD.rBig, lip: 4 });
    // left: label over the number, the pair centred on the midline; the
    // column is as wide as its widest state so nothing shifts as it counts
    const lw = Math.ceil(Math.max(A.measureText("Next raid in", 12), A.hudTitleW("88s", 26)));
    A.drawText("Next raid in", x + pad, my - 11, 12, HUD.text2, "left", true);
    A.hudTitle(left > 0.5 ? Math.ceil(left) + "s" : "Now", x + pad, my + 8, 26, HUD.play, "left", 1, c);
    const btn = !global.mobile && w > 380, bw = btn ? 128 : 0, bh = 32;
    const mx = x + pad + lw + gap, mw = Math.max(40, x + w - pad - (btn ? bw + gap : 0) - mx);
    // middle: the message, a gap, the bar the width of the column
    const line = S.keep ? "The results will stay up after you drop in" : left > 0.5 ? "Everyone drops in together" : "Dropping you in…";
    // sized on drawText's own font so it never runs past the bar
    const lt = A.measureText(line, 14), ls = lt > mw ? Math.max(9, Math.floor(14 * mw / lt * 10) / 10) : 14;
    A.drawText(line, mx, my - 7, ls, HUD.head, "left", true);
    A.hudBar(c, mx, my + 7, mw, 6, S.nextSpan ? clamp(left / S.nextSpan) : 0, HUD.play);
    if (btn) {
        const bx = x + w - pad - bw, by = my - bh / 2;
        A.hudWell(c, bx, by, bw, bh, bh / 2, S.keep ? "rgba(242,184,60,0.28)" : HUD.well, S.keep ? HUD.gold : HUD.ink, 2);
        A.drawText(S.keep ? "Kept" : "Keep results up", bx + bw / 2, my, S.keep ? 13 : 11.5, S.keep ? HUD.gold : HUD.head, "center", true);
        keepBox.x = bx; keepBox.y = by; keepBox.w = bw; keepBox.h = bh; keepBox.on = k > 0.6;
    } else keepBox.on = false;
    c.restore();
}

// The kept results, over the live game: dimmed world, the podium and your raid
function drawDock() {
    const now = performance.now();
    if (now - D.at > DOCK_MS || global.died || S.on) { undock(); return; }
    const c = A.ctx();
    const W = global.screenWidth, H = global.screenHeight, HUD = A.HUD;
    const k = clamp((now - D.at) / 250) * clamp((D.at + DOCK_MS - now) / 600);
    c.save();
    c.globalAlpha = 0.5 * k;
    c.fillStyle = HUD && HUD.theme === "light" ? "#ffffff" : "#0d0b12";
    c.fillRect(0, 0, W, H);
    c.globalAlpha = k;
    // everything fully in: no slide, no tally
    drawPanels(c, 1e6, now, W, H);
    const line = "Click anywhere or press Esc to go back";
    if (!D.tw) D.tw = A.measureText(line, 14) + 40;
    const tw = Math.min(W - 40, D.tw), th = 36;
    A.hudPanel(c, W / 2 - tw / 2, H - th - 22, tw, th, { fill: HUD.solid, r: th / 2 });
    A.drawText(line, W / 2, H - 22 - th / 2, fitSize(line, 14, tw - 30, 10), HUD.head, "center", true);
    c.restore();
}

// ── come back tomorrow ───────────────────────────────────────────────────
// A row at the bottom of "Your raid": tomorrow's daily reward and how long
// until it unlocks, the daily streak flame, or "ready" when it unlocked
// mid-raid. The numbers come from /api/daily (asked once as the raid ends,
// for guests too) and count down on the server's clock (shared/daily.js).
let cbSeq = 0;
function fetchComeBack() {
    S.cb = null;
    if (!window.DWDaily || global.tutorialMode) return;
    const seq = ++cbSeq;
    let gid = "";
    try { gid = localStorage.getItem("dwGuestId") || ""; } catch (e) { /* */ }
    fetch("/api/daily", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-DW": "1", "Accept": "application/json" },
        body: JSON.stringify(/^[a-f0-9]{32}$/.test(gid) ? { guestId: gid } : {}),
    }).then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (seq !== cbSeq || !S.on || !d || !d.on || !d.today) return;
        S.cb = { d, skew: (+d.now || Date.now()) - Date.now(), at: performance.now() };
    }).catch(() => { /* no row, that's all */ });
}
// raidFinale's own count of finished raids: the menu asks about pings only
// after the first one (client/account/retention.js)
function countRaid() {
    try { localStorage.setItem("dwRaidsEnded", String((+localStorage.getItem("dwRaidsEnded") || 0) + 1)); } catch (e) { /* */ }
}
// the daily track pays gemdust for the menu's shop (and two common items a week)
function rewardLine(r) {
    if (!r) return "";
    if (r.item) return r.item.name + (r.item.cat === "sidekick" ? " sidekick" : r.item.cat === "sdSkin" ? " skin" : "") + (r.signup ? " (sign up)" : "");
    if (r.dustMilli > 0) return +(r.dustMilli / 1000).toFixed(2) + " gemdust" + (r.signup ? " (sign up)" : "");
    return "";
}
const FLAME = "M12 21c-4 0-6.5-2.7-6.5-6.2 0-3.3 2.4-5 3.6-8.3.2-.6 1-.7 1.3-.1.9 1.6 1.2 3 1.1 4.6 1.2-.8 2-2.1 2.3-3.4.1-.5.8-.7 1.1-.2 1.5 2.2 2.6 4.6 2.6 7.4 0 3.5-2.5 6.2-5.5 6.2z";
let flamePath = null;
function drawFlame(c, x, y, s) {
    if (!flamePath) { try { flamePath = new Path2D(FLAME); } catch (e) { return; } }
    c.save();
    c.translate(x - s / 2, y - s / 2);
    c.scale(s / 24, s / 24);
    c.lineJoin = "round";
    c.lineWidth = 3.4;
    c.strokeStyle = A.HUD.ink;
    c.stroke(flamePath);
    c.fillStyle = "#ff9f43";
    c.fill(flamePath);
    c.restore();
}
const cbText = { key: "", label: "", main: "" };
function drawComeBack(c, x, y, w, h, now) {
    const HUD = A.HUD, cb = S.cb, d = cb.d, DY = window.DWDaily;
    const left = d.ready ? 0 : DY.leftMs(d.readyAt, Date.now(), cb.skew);
    const ready = left <= 0;
    const key = (ready ? 1 : 0) + "|" + d.day;
    if (key !== cbText.key) {
        cbText.key = key;
        const r = ready ? d.today : (d.tomorrow || d.today);
        cbText.label = ready ? "DAY " + d.day + " REWARD IS READY" : "COME BACK TOMORROW";
        cbText.main = ready ? rewardLine(r) + " is waiting for you on the menu" : rewardLine(r);
    }
    A.hudWell(c, x, y, w, h, 12, "rgba(242,184,60,0.1)", HUD.ink, 2);
    const flameW = d.streak >= 2 ? 44 : 0;
    const pill = ready ? "" : "in " + DY.countdown(left);
    const pillW = pill ? Math.max(84, A.hudTitleW(pill, 17) + 22) : 0;
    const textW = w - 28 - pillW - flameW - (pill ? 10 : 0);
    A.drawText(rowLabel(cbText.label), x + 14, y + 17, 12, ready ? HUD.gold : HUD.text2, "left", true);
    A.hudTitle(cbText.main, x + 14, y + 39, fitSize(cbText.main, 19, textW, 11), ready ? HUD.play : HUD.gold, "left", 1, c);
    let rx = x + w - 12;
    if (pill) {
        A.hudWell(c, rx - pillW, y + h / 2 - 15, pillW, 30, 15, HUD.ink, HUD.ink, 0);
        A.hudTitle(pill, rx - pillW / 2, y + h / 2, 17, HUD.head, "center", 1, c);
        rx -= pillW + 8;
    }
    if (flameW) {
        drawFlame(c, rx - 30, y + h / 2 - 1, 24);
        A.hudTitle(String(d.streak), rx - 16, y + h / 2 + 1, 18, "#ffb347", "left", 1, c);
    }
}

// "Join the Discord for Raid Night", under the podium: only with a Raid
// Night coming up, at most one raid a day, and never again once clicked.
let dcEl = null, dcShown = false, dcX = -1, dcY = -1;
const today = () => String(Math.floor(Date.now() / 864e5));
function discordWanted() {
    const E = window.DWEvents;
    if (!E || global.tutorialMode) return null;
    const c = E.current(E.now());
    if (!c || c.live || c.ms > E.MENU_LEAD_MS) return null;
    try {
        if (localStorage.getItem("dwDiscordCta") === "clicked" || localStorage.getItem("dwDiscordCta") === today()) return null;
        localStorage.setItem("dwDiscordCta", today());
    } catch (e) { return null; }
    return c;
}
function buildDiscord() {
    if (dcEl) return;
    const E = window.DWEvents;
    dcEl = document.createElement("a");
    dcEl.id = "dwFinaleDiscord";
    dcEl.href = E ? E.DISCORD : "https://discord.gg/bx5FK3CMwp";
    dcEl.target = "_blank";
    dcEl.rel = "noopener";
    dcEl.tabIndex = -1;
    dcEl.innerHTML = '<svg class="dw-ic" aria-hidden="true"><use href="#i-discord"/></svg><span><span class="dc-t"></span><small></small></span>';
    for (const t of ["pointerdown", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu", "wheel"]) {
        dcEl.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    }
    dcEl.addEventListener("click", () => {
        try { localStorage.setItem("dwDiscordCta", "clicked"); } catch (e) { /* */ }
        setTimeout(hideDiscord, 300);
    });
    document.body.appendChild(dcEl);
}
function placeDiscord(W, H) {
    buildDiscord();
    const E = window.DWEvents, c = S.dc;
    if (!dcShown) {
        dcEl.querySelector(".dc-t").textContent = "Join the Discord for " + c.ev.name;
        dcEl.querySelector("small").textContent = E.localWhen(c.ev, E.now()) + ", with prizes for the top spots";
    }
    const k = window.innerWidth / Math.max(1, global.screenWidth);
    const ew = dcEl.offsetWidth / k, eh = dcEl.offsetHeight / k;
    let x, y;
    if (lay.side) {
        x = lay.lx; y = lay.ly + PH * lay.s + 18;
        if (y + eh > H - 12) return hideDiscord();
    } else {
        // bottom left, if the next-raid bar leaves room for it
        const barW = Math.min(470, W - 40);
        x = A.HUD.edge; y = H - 22 - eh;
        if (x + ew > W / 2 - barW / 2 - 10) return hideDiscord();
    }
    const px = Math.round(x * k), py = Math.round(y * k);
    if (Math.abs(px - dcX) > 2 || Math.abs(py - dcY) > 2) {
        dcX = px; dcY = py;
        dcEl.style.left = px + "px";
        dcEl.style.top = py + "px";
    }
    if (!dcShown) { dcShown = true; dcEl.classList.add("open"); }
}
function hideDiscord() {
    if (!dcEl || !dcShown) return;
    dcShown = false;
    dcX = dcY = -1;
    dcEl.classList.remove("open");
}

// ── the last ten seconds ─────────────────────────────────────────────────
let lastCount = 0;
function raidLeftNow(now) {
    const r = global.royale;
    if (!r || !(r.at > 0) || r.ending || S.on) return -1;
    if (now - r.at > 3000) return -1;
    return (r.raidLeft | 0) - (now - r.at) / 1000;
}
// the 10, 9, 8... is on screen (app.js clears the death card for it)
export function countdownUp() {
    const left = raidLeftNow(performance.now());
    return left > 0 && left <= 10.2 && (global.royale.raidLeft | 0) > 0;
}
// how hard the heartbeat should go (the satchel beat reuses it)
export function tension() {
    const left = raidLeftNow(performance.now());
    if (!(left > 0 && left <= 15)) return 0;
    return 0.45 + 0.55 * (1 - left / 15);
}
export function drawCountdown(yTop) {
    if (!A) return;
    const now = performance.now();
    const left = raidLeftNow(now);
    if (!(left > 0 && left <= 10.2) || (global.royale.raidLeft | 0) <= 0) { lastCount = 0; global.countdownRect = null; return; }
    const n = Math.max(1, Math.ceil(left));
    const HUD = A.HUD;
    if (n !== lastCount) {
        lastCount = n;
        try { gameSound.rankCrack(n <= 3 ? 3 : n <= 5 ? 2 : 1); } catch (e) { /* */ }
    }
    const into = 1 - (left - (n - 1));      // 0 when the number lands, 1 as it ends
    const c = A.ctx();
    const W = global.screenWidth, H = global.screenHeight;
    const still = calm();
    const big = n <= 3;
    // the edges throb red on the last three
    if (big && glowOn() && !still) {
        c.save();
        c.globalAlpha = 0.45 * (1 - into);
        c.drawImage(A.vignetteSprite(W, H, 0.55, "200,40,30"), 0, 0, W, H);
        c.restore();
    }
    const pop = still ? 1 : into < 0.16 ? 1.45 - 0.45 * easeOut(into / 0.16) : 1;
    const fade = into > 0.85 ? (1 - into) / 0.15 : 1;
    const size = big ? 128 : 84;
    const y = Math.max(yTop + size * 0.6 + 24, H * 0.25);
    // app.js labelAlpha: world labels (the Vault's) step out from under it
    const cr = global.countdownRect || (global.countdownRect = { x: 0, y: 0, w: 0, h: 0 });
    cr.x = W / 2 - 150; cr.y = y - size * 0.72 - 14; cr.w = 300; cr.h = size * 1.35 + 14;
    A.hudTitle("RAID ENDS IN", W / 2, y - size * 0.72, 15, HUD.text2, "center", 1, c);
    bigTitle(c, String(n), W / 2, y, size, big ? "#ff6b5b" : HUD.head, big ? HUD.dangerDk : "#9a8d78", fade, pop);
}
