// Dash and abilities, client side.
//
//   'AB'  your dash charges and ability slot (abilities.js talkState)
//   'AF'  an effect somebody near you set off: kind, x, y, a, b, id
//   'AR'  radar contacts [[x, y, flags, id], ...] while your Radar Ping runs
//
// This file keeps that state, draws the effects in the world (dash streaks,
// the grapple line, shockwave rings, smoke, launch pads...), the radar
// marks, the two HUD chips (dash + ability) and their touch buttons, and
// plays the sounds. app.js hands over its HUD pieces with init().
//
// Nothing here allocates per frame: effects are plain objects made when the
// packet lands, drawing is arcs and lines.

import { global } from "./global.js";
import { config } from "./config.js";
import { gameSound } from "./sound.js";
import { sparks as jSparks } from "./juice.js";

// one colour per ability (the HUD icon tiles use the same, app.js KIT_CARD)
export const AB_COLOR = {
    grapple: "#4ec4e8", burrow: "#d0873a", shock: "#9a86ff", radar: "#3fcf7a",
    wall: "#8a93a6", smoke: "#8a80a0", rush: "#ff5a48", pad: "#f2b83c",
};
const DASH_COL = "#bfefff";

const S = global.abil = {
    on: false, ready: false,
    d: 2, dm: 2, drAt: 0, drm: 5000, dashAt: -1e9, gotAt: -1e9,
    eq: null, own: [], tw: null, cdAt: 0, cdm: 0, readyAt: -1e9,
    trialId: null, trialAt: 0, act: null, actAt: 0, swapAt: -1e9,
    radar: [], radarAt: 0,
};

let H = null;
export function init(helpers) { H = helpers; }
// Until someone has dashed once, the chip (and the touch button) pulses.
const SEEN_KEY = "dwDashSeen_v1";
let dashSeen = true;
try { dashSeen = localStorage.getItem(SEEN_KEY) === "1"; } catch (e) { /* storage blocked: no nag */ }
export function state() { return S; }

const fewer = () => !!(config.graphical && config.graphical.fewerEffects);
const calm = () => !!(global.reducedMotion && global.reducedMotion());

// ── packets ─────────────────────────────────────────────────────────────
export function onState(d) {
    if (!d) return;
    const t = performance.now();
    const prevOwn = S.own, prevTrial = S.trialId, prevTw = S.tw, prevEq = S.eq, prevD = S.d, prevCd = S.cdAt;
    S.on = true;
    S.d = d.d | 0; S.dm = (d.dm | 0) || 2;
    S.drAt = d.dr > 0 ? t + d.dr : 0; S.drm = d.drm || 5000;
    S.eq = d.eq || null; S.own = Array.isArray(d.own) ? d.own : []; S.tw = d.tw || null;
    S.cdAt = d.cd > 0 ? t + d.cd : 0; S.cdm = d.cdm || 0;
    S.trialId = d.tr ? d.tr.id : null; S.trialAt = d.tr ? t + d.tr.left : 0;
    S.act = d.act ? d.act.k : null; S.actAt = d.act ? t + d.act.left : 0;
    if (S.d > prevD && S.ready) S.gotAt = t;
    if (prevCd > t && !S.cdAt) S.readyAt = t;
    if (S.eq !== prevEq) S.swapAt = t;
    // phones: the first time an ability lands in the slot, its tooltip shows
    // over the button for a few seconds (after the unlock card has gone)
    if (global.mobile && S.eq && S.eq !== prevEq && !global.tutorialMode && !unlockSeen("tip:" + S.eq)) {
        global.touchTip = { name: "ability", auto: true, from: t + 2600, until: t + 7600 };
    }
    // a new ability (bought, a trial, an override's) gets the NEW ABILITY card
    // (app.js drawKitUnlock); the first state after joining is not news
    let fresh = null;
    if (S.trialId && S.trialId !== prevTrial) fresh = S.trialId;
    else if (S.tw && S.tw !== prevTw) fresh = S.tw;
    else for (const id of S.own) if (!prevOwn.includes(id)) { fresh = id; break; }
    // the raid's free ability gets its own slam after the landing instead
    if (d.fn && d.fr) {
        fresh = null;
        unlockSeen("ab:" + d.fr);
        freeSlam(d.fr);
    }
    if (fresh && S.ready && !global.tutorialMode) {
        // the big card the first time ever, a glide into the slot after that
        if (unlockSeen("ab:" + fresh)) { glide(fresh, d.msg || ""); d.msg = ""; }
        else {
            const q = global.kitUnlocks || (global.kitUnlocks = []);
            // spare: owned but not in the slot, so no "press Q" on its card
            if (!q.some(u => u.id === fresh)) q.push({ id: fresh, ab: true, trial: fresh === S.trialId, spare: fresh !== S.eq });
        }
    }
    S.ready = true;
    if (d.msg && global.createMessage) global.createMessage(d.msg, 2600);
}

// The NEW ITEM / NEW ABILITY card shows once per item, ever (this browser).
// -> true when `key` was shown before (and marks it shown otherwise).
const SEEN_UNLOCKS = "dwSeenUnlocks_v1";
let seenEver = null;
export function unlockSeen(key) {
    if (!seenEver) {
        seenEver = new Set();
        try { const a = JSON.parse(localStorage.getItem(SEEN_UNLOCKS) || "[]"); if (Array.isArray(a)) for (const k of a) seenEver.add(String(k)); } catch (e) { /* */ }
    }
    if (seenEver.has(key)) return true;
    seenEver.add(key);
    try { localStorage.setItem(SEEN_UNLOCKS, JSON.stringify([...seenEver])); } catch (e) { /* */ }
    return false;
}
// The small version: the icon flies from your tank into its slot (app.js
// drawKitGlides), with an optional line under it.
export function glide(id, text) {
    const q = global.kitGlides || (global.kitGlides = []);
    if (q.some(g => g.id === id && !g.start)) return;
    q.push({ id, text: text || "", start: 0 });
    if (q.length > 6) q.shift();
}
// "YOUR ABILITY: GRAPPLE", big in the middle; juice.js holds a slam until
// the sky drop has landed.
function freeSlam(id) {
    const J = window.dwJuice;
    if (!J || global.tutorialMode) return;
    const key = H ? H.keyLabel("KEY_ABILITY", "Q") : "Q";
    const sub = global.mobile ? "Free for this raid. Tap the ability button." : "Free for this raid. Press " + key + " to use it.";
    try { J.slam("YOUR ABILITY: " + shortName(id), sub, AB_COLOR[id] || "#f2b83c", 2600, 44); } catch (e) { /* */ }
}

// a new raid or a fresh join: the next state is a baseline, not news
export function reset() { S.ready = false; S.radar = []; fx.length = 0; pads.length = 0; }

const fx = [];
const pads = [];
export function onFx(m, punch) {
    const kind = String(m[0] || "");
    const f = { k: kind, x: +m[1] || 0, y: +m[2] || 0, a: +m[3] || 0, b: +m[4] || 0, id: m[5] | 0, born: performance.now() };
    const me = global.player || { renderx: 0, rendery: 0 };
    const near = Math.hypot(f.x - me.renderx, f.y - me.rendery);
    const mine = f.id && f.id === myId();
    const life = LIFE[kind];
    if (life) f.life = life(f);
    if (kind === "fling" || kind === "flinghit" || kind === "rocket" || kind === "rush") { f.trail = new Float32Array(TRAIL_N * 3); f.tn = 0; f.tAt = 0; }
    if (kind === "pad") { pads.push(f); if (pads.length > 12) pads.shift(); }
    else if (kind === "padgone") { for (let i = pads.length - 1; i >= 0; i--) if (pads[i].id === f.id) pads.splice(i, 1); return; }
    else if (kind === "surface") {
        // the channel is over: its dust stops, a burst marks where it came up
        for (const g of fx) if (g.k === "burrow" && g.id === f.id) g.b = Math.min(g.b, performance.now() - g.born + 250);
        addFx(f);
    }
    else if (kind === "shock") {
        // the orb in the air is done: the blast takes over where it went off
        for (const g of fx) if (g.k === "shockthrow" && g.id === f.id && !g.done) g.done = f.born;
        addFx(f);
    }
    else if (kind === "fling" || kind === "flinghit") {
        // a second blast on the same tank replaces its trail
        for (let i = fx.length - 1; i >= 0; i--) if ((fx[i].k === "fling" || fx[i].k === "flinghit") && fx[i].id === f.id) fx.splice(i, 1);
        addFx(f);
    }
    else addFx(f);
    // own dash already played its whoosh on the key press
    if (!(mine && kind === "dash")) sound(kind, f.x, f.y);
    if (near < 1800) juiceFor(f, mine, near);
    else return;
    if (punch && near < 700 && !calm() && !window.dwJuice) {
        if (kind === "shock") punch(mine ? 12 : 9, 240, true);
        else if (kind === "wall") punch(5, 160);
        else if (kind === "launch" && mine) punch(6, 180);
        else if (kind === "blink" && mine) punch(7, 160);
    }
}

// kit items whose use this file draws (app.js skips its plain pulse for them)
export const KIT_FX_IDS = new Set(["charge", "medkit", "anchor", "flash", "bulwark", "decoy", "barrage", "rocket", "flare"]);
const addFx = (f) => { fx.push(f); if (fx.length > 48) fx.shift(); };
// How long each effect lives (ms), where it isn't a fixed DUR
const SHOCK_SPEED = 1.0;          // the orb, units per ms (abilities.js SHOCK.throwSpeed)
const LIFE = {
    shockthrow: f => Math.max(90, f.b / SHOCK_SPEED) + 200,
    smokethrow: f => Math.max(120, f.b / SMOKE_SPEED) + 80,
    shock: () => 1100, fling: () => 750, flinghit: () => 750,
    rocket: f => f.b + 700,
    k_charge: () => 950, k_medkit: () => 1100, k_flash: () => 1000, k_bulwark: () => 950, k_barrage: () => 650,
    k_anchor: f => f.b + 400, k_decoy: f => f.b + 300,
};
const TRAIL_N = 14;               // positions kept for a trail (x, y, time)
const CHARGE_FLY = 160;           // the seismic charge in the air (ms)

// The screen-juice layer (juice.js, window.dwJuice: pooled sparks, rings,
// camera kicks, hit-stop). Bigger kicks when it's yours or right next to you.
function juiceFor(f, mine, near) {
    const J = window.dwJuice;
    if (!J) return;
    const close = mine || near < 600;
    const me = f.id && f.id === myId();
    try {
        switch (f.k) {
            case "shock": {
                const R = f.b || 430;
                J.ring(f.x, f.y, "#ffffff", 10, R * 0.55, 260, 16);
                J.ring(f.x, f.y, AB_COLOR.shock, 30, R, 560, 14);
                J.ring(f.x, f.y, "#5ce8ff", 20, R * 1.15, 760, 5);
                J.burst(f.x, f.y, 30, "#8a7f96", R * 0.95, 900, 1, 7);
                J.burst(f.x, f.y, 18, AB_COLOR.shock, R * 0.75, 650, 2, 6);
                J.burst(f.x, f.y, 16, "#e9e0ff", R * 0.9, 420, 0, 4);
                // everyone near feels it, harder the closer
                const k = Math.max(0, 1 - near / (R * 2.4));
                if (k > 0) J.shake(6 + 18 * k, 260 + 160 * k);
                if (k > 0.45) J.hitStop(mine ? 60 : 40);
                if (k > 0.6) J.flash(AB_COLOR.shock, 130, 0.12 + 0.08 * k);
                break;
            }
            case "shockthrow":
                J.burst(f.x + Math.cos(f.a) * 30, f.y + Math.sin(f.a) * 30, 6, AB_COLOR.shock, 70, 300, 0, 3);
                break;
            case "fling":
            case "flinghit":
                J.burst(f.x, f.y, 10, "#8a7f96", 120, 520, 1, 5);
                if (me) {
                    J.shake(12 + Math.min(10, f.b / 6), 360);
                    if (f.k === "flinghit") { J.glitch(0.75, 280); J.flash(AB_COLOR.shock, 110, 0.16); }
                }
                break;
            case "launch":
                J.burst(f.x, f.y, 14, AB_COLOR.pad, 170, 420, 0, 4);
                J.ring(f.x, f.y, AB_COLOR.pad, 20, 110, 320, 5);
                if (mine) J.shake(7, 200);
                break;
            case "pad":
                J.ring(f.x, f.y, AB_COLOR.pad, 10, 80, 360, 5);
                J.burst(f.x, f.y, 10, "#fff3d9", 90, 420, 3, 4);
                break;
            case "burrow":
                J.burst(f.x, f.y, 18, "#6f6480", 150, 650, 1, 6);
                J.ring(f.x, f.y, AB_COLOR.burrow, 70, 20, 380, 6);
                if (mine) J.rumble(450, 4);
                break;
            case "surface":
                J.burst(f.x, f.y, 26, "#8a7f96", 220, 750, 1, 7);
                J.burst(f.x, f.y, 10, "#ffd37a", 160, 500, 0, 4);
                J.ring(f.x, f.y, AB_COLOR.burrow, 20, 170, 420, 8);
                if (close) J.shake(mine ? 10 : 6, 240);
                break;
            case "hook": {
                const ax = f.x + Math.cos(f.a) * f.b, ay = f.y + Math.sin(f.a) * f.b;
                J.burst(ax, ay, 12, AB_COLOR.grapple, 80, 380, 3, 4);
                J.burst(ax, ay, 6, "#8a7f96", 60, 420, 1, 4);
                J.ring(ax, ay, AB_COLOR.grapple, 6, 46, 260, 4);
                if (mine) J.shake(5, 160);
                break;
            }
            case "hookmiss":
                J.burst(f.x + Math.cos(f.a) * 40, f.y + Math.sin(f.a) * 40, 5, AB_COLOR.grapple, 60, 260, 0, 3);
                break;
            case "smoke":
                J.burst(f.x, f.y, 6, "#8a80a0", 60, 300, 3, 3);
                break;
            case "unsmoke":
                J.burst(f.x, f.y, 8, "#4a4156", 90, 400, 1, 6);
                break;
            case "wall": {
                // chunks thrown up along the whole line of the wall
                const ux = -Math.sin(f.a), uy = Math.cos(f.a);
                for (let k = -2; k <= 2; k++) J.burst(f.x + ux * k * 110, f.y + uy * k * 110, 5, "#6f6480", 110, 600, 1, 6);
                J.ring(f.x, f.y, "#b9c3d1", 20, 160, 380, 5);
                if (close) J.shake(7, 200);
                break;
            }
            case "rush":
                J.burst(f.x, f.y, 18, AB_COLOR.rush, 150, 500, 0, 4);
                J.ring(f.x, f.y, AB_COLOR.rush, 20, 120, 320, 6);
                if (mine) { J.flash(AB_COLOR.rush, 120, 0.12); J.shake(5, 160); }
                break;
            case "radar":
                if (mine) { J.ring(f.x, f.y, AB_COLOR.radar, 30, 900, 900, 4); J.ring(f.x, f.y, "#c8ffd8", 20, 500, 600, 3); }
                break;
            case "blink": {
                const ex = f.x + Math.cos(f.a) * f.b, ey = f.y + Math.sin(f.a) * f.b;
                J.burst(f.x, f.y, 12, "#ff8ab0", 110, 450, 3, 4);
                J.burst(ex, ey, 16, "#ff8ab0", 130, 520, 3, 4);
                J.burst(ex, ey, 8, "#ffffff", 90, 360, 0, 3);
                J.ring(ex, ey, "#ff8ab0", 10, 110, 380, 6);
                if (mine) { J.shake(7, 160); J.lightLeak("255,138,176", 700); }
                break;
            }
            case "rocket":
                J.burst(f.x, f.y, 14, "#ffb347", 120, 420, 0, 4);
                J.ring(f.x, f.y, "#ff8a3a", 16, 100, 320, 6);
                if (mine) { J.shake(6, 220); J.flash("#ff8a3a", 100, 0.1); }
                break;
            // kit items (abilities.js kitFx)
            case "k_medkit":
                J.burst(f.x, f.y, 14, "#6ff5a8", 110, 800, 3, 4);
                J.ring(f.x, f.y, "#6ff5a8", 120, 30, 420, 6);
                if (mine) J.flash("#3fbf7a", 160, 0.1);
                break;
            case "k_anchor":
                J.ring(f.x, f.y, "#7fb1f2", 140, 40, 380, 8);
                J.burst(f.x, f.y, 12, "#bcd7ff", 110, 500, 3, 4);
                if (mine) J.shake(5, 180);
                break;
            case "k_flash":
                J.burst(f.x, f.y, 16, "#5ce0d8", 140, 700, 3, 4);
                J.ring(f.x, f.y, "#5ce0d8", 20, 140, 420, 6);
                if (mine) { J.flash("#5ce0d8", 140, 0.1); J.lightLeak("92,224,216", 800); }
                break;
            case "k_bulwark":
                for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; J.burst(f.x + Math.cos(a) * 190, f.y + Math.sin(a) * 190, 4, "#6f6480", 90, 650, 1, 6); }
                J.ring(f.x, f.y, "#b9c3d1", 110, 260, 520, 7);
                if (close) J.shake(mine ? 9 : 5, 260);
                break;
            case "k_decoy":
                J.burst(f.x, f.y, 14, "#ffd75e", 90, 700, 3, 4);
                J.ring(f.x, f.y, "#ffd75e", 14, 90, 360, 5);
                break;
            case "k_barrage":
                jSparks(f.x + Math.cos(f.a) * 30, f.y + Math.sin(f.a) * 30, 16, 240, 520, 1, "#6f6480", 0.9, f.a, 6);
                jSparks(f.x + Math.cos(f.a) * 30, f.y + Math.sin(f.a) * 30, 10, 200, 360, 0, "#ff8a6b", 0.7, f.a, 4);
                J.ring(f.x, f.y, "#ff8a6b", 20, 90, 280, 6);
                if (mine) { J.shake(10, 260); J.hitStop(30); }
                break;
            case "k_charge":
                if (mine) J.shake(3, 100);
                break;
        }
    } catch (e) { /* effects are best effort */ }
}

export function onRadar(list) {
    S.radar = Array.isArray(list) ? list : [];
    S.radarAt = performance.now();
}

let myIdFn = () => -1;
export function setSelf(fn) { myIdFn = fn; }
function myId() { try { return myIdFn(); } catch (e) { return -1; } }

// ── local prediction ────────────────────────────────────────────────────
// The key press plays at once; the server's AB state corrects the pips.
export function predictDash() {
    const t = performance.now();
    if (!S.on || S.d <= 0 || t - S.dashAt < 140) return false;
    S.d--;
    if (!S.drAt) S.drAt = t + S.drm;
    S.dashAt = t;
    S.dashes = (S.dashes | 0) + 1;     // tutorial.js counts them
    if (!dashSeen) { dashSeen = true; try { localStorage.setItem(SEEN_KEY, "1"); } catch (e) { /* */ } }
    sound("dash", global.player.renderx, global.player.rendery, true);
    return true;
}
export function cdLeft() { return Math.max(0, S.cdAt - performance.now()); }
export function canUse() { return S.on && !!S.eq && cdLeft() <= 0; }

// ── sounds ──────────────────────────────────────────────────────────────
// Soft and short, built from the sound engine's own pieces (brown air, sine
// tones), so they sit with the rest of the mix.
function sound(kind, x, y, self = false) {
    const g = gameSound;
    if (!g || !g.ctx || !g._mix) return;
    const m = g._mix("combat");
    if (!m) return;
    const sp = self ? { vol: 1, pan: 0 } : g._spatial(x, y);
    if (!sp) return;
    const v = sp.vol * m, pan = sp.pan;
    try {
        switch (kind) {
            case "dash":
            case "launch":
                if (!g._throttle("abDash", 60)) return;
                g._puff({ kind: "brown", cut: 1100, cutTo: 320, Q: 0.8, dur: kind === "launch" ? 0.3 : 0.2, peak: 0.16 * v, pan, attack: 0.012 });
                g._puff({ kind: "pink", cut: 2400, cutTo: 900, Q: 1.1, dur: 0.12, peak: 0.035 * v, pan, attack: 0.01 });
                if (kind === "launch") g._tone({ freq: 220, glideTo: 520, dur: 0.22, peak: 0.07 * v, pan, attack: 0.012 });
                break;
            case "hook":
            case "hookmiss":
                g._tone({ freq: 520, glideTo: 880, dur: 0.09, peak: 0.07 * v, pan, attack: 0.006 });
                g._puff({ kind: "pink", cut: 1800, cutTo: 1100, Q: 1, dur: 0.08, peak: 0.04 * v, pan });
                if (kind === "hook") g._tone({ freq: 330, glideTo: 180, dur: 0.12, peak: 0.08 * v, pan, delay: 0.08, attack: 0.008 });
                break;
            case "shock":
                g._impact({ pan, v, sub: 58, body: 140, bodyTo: 60, air: 520, weight: 0.5, dur: 0.24 });
                g._puff({ kind: "brown", cut: 700, cutTo: 200, Q: 0.6, dur: 0.38, peak: 0.12 * v, pan, attack: 0.01 });
                g._tone({ freq: 760, glideTo: 240, dur: 0.22, peak: 0.035 * v, pan, attack: 0.004 });
                break;
            case "smokethrow":
                g._puff({ kind: "pink", cut: 1400, cutTo: 800, Q: 0.9, dur: 0.12, peak: 0.04 * v, pan });
                break;
            case "shockthrow":
                g._tone({ freq: 330, glideTo: 620, dur: 0.16, peak: 0.05 * v, pan, attack: 0.008 });
                g._puff({ kind: "pink", cut: 1600, cutTo: 900, Q: 0.9, dur: 0.12, peak: 0.035 * v, pan });
                break;
            case "fling":
            case "flinghit":
                if (!g._throttle("abFling", 90)) return;
                g._puff({ kind: "pink", cut: 900, cutTo: 2400, Q: 0.8, dur: 0.32, peak: 0.07 * v, pan, attack: 0.02 });
                break;
            case "k_medkit":
                g._tone({ freq: 523, glideTo: 659, dur: 0.14, peak: 0.05 * v, pan, attack: 0.01 });
                g._tone({ freq: 784, dur: 0.2, peak: 0.04 * v, pan, delay: 0.11, attack: 0.012 });
                break;
            case "k_anchor":
                g._tone({ freq: 196, glideTo: 147, dur: 0.24, peak: 0.07 * v, pan, attack: 0.006 });
                g._tone({ freq: 587, dur: 0.18, peak: 0.03 * v, pan, delay: 0.06, attack: 0.01 });
                break;
            case "k_flash":
                g._tone({ freq: 880, glideTo: 1320, dur: 0.18, peak: 0.045 * v, pan, attack: 0.008 });
                g._puff({ kind: "pink", cut: 2600, cutTo: 1400, Q: 1, dur: 0.16, peak: 0.03 * v, pan });
                break;
            case "k_bulwark":
                g._puff({ kind: "brown", cut: 420, cutTo: 220, Q: 0.6, dur: 0.45, peak: 0.12 * v, pan, attack: 0.03 });
                break;
            case "k_decoy":
                g._tone({ freq: 988, dur: 0.1, peak: 0.035 * v, pan, attack: 0.006 });
                g._tone({ freq: 1319, dur: 0.12, peak: 0.03 * v, pan, delay: 0.07, attack: 0.006 });
                break;
            case "k_barrage":
                g._puff({ kind: "brown", cut: 800, cutTo: 260, Q: 0.6, dur: 0.3, peak: 0.12 * v, pan, attack: 0.008 });
                break;
            case "k_charge":
                g._tone({ freq: 400, glideTo: 700, dur: 0.1, peak: 0.04 * v, pan, attack: 0.006 });
                break;
            case "radar":
                g._tone({ freq: 880, dur: 0.16, peak: 0.06 * v, pan, attack: 0.01 });
                g._tone({ freq: 1320, dur: 0.22, peak: 0.04 * v, pan, delay: 0.14, attack: 0.012 });
                break;
            case "wall":
                g._impact({ pan, v, sub: 70, body: 160, bodyTo: 90, air: 420, weight: 0.32, dur: 0.16 });
                break;
            case "smoke":
            case "unsmoke":
                g._puff({ kind: "pink", cut: 900, cutTo: 500, Q: 0.6, dur: kind === "smoke" ? 0.45 : 0.18, peak: 0.08 * v, pan, attack: 0.03 });
                break;
            case "rush":
                g._tone({ freq: 294, glideTo: 440, dur: 0.18, peak: 0.07 * v, pan, attack: 0.01 });
                g._tone({ freq: 440, glideTo: 660, dur: 0.2, peak: 0.05 * v, pan, delay: 0.1, attack: 0.012 });
                break;
            case "pad":
                g._tone({ freq: 196, glideTo: 392, dur: 0.14, peak: 0.07 * v, pan, attack: 0.01 });
                break;
            case "burrow":
                g._puff({ kind: "brown", cut: 380, cutTo: 240, Q: 0.6, dur: 0.5, peak: 0.13 * v, pan, attack: 0.02 });
                g._tone({ freq: 110, glideTo: 80, dur: 0.4, peak: 0.06 * v, pan, attack: 0.02 });
                break;
            case "rocket":
                // ignition: a rising whoosh with a little roar under it
                g._puff({ kind: "brown", cut: 500, cutTo: 1800, Q: 0.7, dur: 0.5, peak: 0.14 * v, pan, attack: 0.03 });
                g._puff({ kind: "pink", cut: 1200, cutTo: 3200, Q: 0.9, dur: 0.32, peak: 0.05 * v, pan, attack: 0.02, delay: 0.04 });
                g._tone({ freq: 140, glideTo: 260, dur: 0.4, peak: 0.04 * v, pan, attack: 0.03 });
                break;
            case "rocketout":
                g._puff({ kind: "brown", cut: 900, cutTo: 300, Q: 0.6, dur: 0.28, peak: 0.07 * v, pan, attack: 0.01 });
                break;
            case "blink":
                g._tone({ freq: 1046, glideTo: 523, dur: 0.16, peak: 0.06 * v, pan, attack: 0.006 });
                g._puff({ kind: "pink", cut: 2600, cutTo: 1200, Q: 1, dur: 0.12, peak: 0.04 * v, pan });
                break;
        }
    } catch (e) { /* sound is best effort */ }
}

// ── world drawing ───────────────────────────────────────────────────────
function findEnt(id) {
    if (!id) return null;
    const list = global.entities;
    if (!list) return null;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
}
// screen position of an entity, or null when it isn't in view
function entScreen(e, px, py, ratio, out) {
    if (!e || !e.render) return null;
    out.x = ratio * e.render.x - px + global.screenWidth / 2;
    out.y = ratio * e.render.y - py + global.screenHeight / 2;
    out.r = (e.size || 24) * ratio;
    return out;
}
const tmpA = { x: 0, y: 0, r: 0 };
const ease = (u) => 1 - (1 - u) * (1 - u) * (1 - u);

const DUR = { dash: 380, launch: 520, hook: 1300, hookmiss: 520, shock: 900, radar: 1300, wall: 700, unsmoke: 500, blink: 600, surface: 700 };

// Gem Magnet (shop gear): gems inside its pull streak in toward you, and a
// faint field turns round the tank. The radius mirrors gems.js tickGem
// (realSize * 2.6 + 110) * magnetMult.
const MAGNET_MULT = 1.9;
function magnetOn() {
    const st = global.shop && global.shop.state;
    const v = st && st.gearUntil && st.gearUntil.magnet;
    return v === true || (+v || 0) > Date.now();
}
function drawMagnet(c, px, py, ratio, now) {
    if (!H || !H.gemClass || global.died || !magnetOn()) return;
    const me = findEnt(myId());
    if (!me || !me.render) return;
    const R = ((me.size || 24) * 2.6 + 110) * MAGNET_MULT;
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    const mx = ratio * me.render.x - px + cx, my = ratio * me.render.y - py + cy;
    c.save();
    // the field
    c.globalAlpha = 0.16;
    c.strokeStyle = "#ffd76e"; c.lineWidth = Math.max(1, 2 * ratio);
    c.setLineDash(BLAST_DASH);
    c.lineDashOffset = calm() ? 0 : now / 40;
    c.beginPath(); c.arc(mx, my, R * ratio, 0, Math.PI * 2); c.stroke();
    c.setLineDash(NO_DASH);
    // streaks behind every gem on its way in
    c.lineCap = "round";
    const list = global.entities;
    let n = 0;
    for (let i = 0; i < list.length && n < 60; i++) {
        const e = list[i];
        if (!e.render || !H.gemClass(e)) continue;
        const dx = e.render.x - me.render.x, dy = e.render.y - me.render.y, d = Math.hypot(dx, dy);
        if (d > R || d < (me.size || 24) * 1.2) continue;
        n++;
        const k = 1 - d / R, ux = dx / d, uy = dy / d;
        const gx = ratio * e.render.x - px + cx, gy = ratio * e.render.y - py + cy;
        const len = (16 + 70 * k) * ratio;
        c.globalAlpha = 0.25 + 0.5 * k;
        c.strokeStyle = (i & 1) ? "#fff3c0" : "#ffd76e";
        c.lineWidth = Math.max(1, (1.5 + 2.5 * k) * ratio);
        c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + ux * len, gy + uy * len); c.stroke();
    }
    c.restore();
}

// Floor layer (under the tanks): launch pads, the magnet's pull.
export function drawFloor(c, px, py, ratio) {
    const now = performance.now();
    try { drawMagnet(c, px, py, ratio, now); } catch (e) { /* */ }
    if (!pads.length) return;
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    for (let i = pads.length - 1; i >= 0; i--) {
        const p = pads[i];
        const age = now - p.born;
        if (age > p.b) { pads.splice(i, 1); continue; }
        const sx = ratio * p.x - px + cx, sy = ratio * p.y - py + cy;
        const R = 62 * ratio;
        if (sx < -R * 2 || sy < -R * 2 || sx > global.screenWidth + R * 2 || sy > global.screenHeight + R * 2) continue;
        const pop = Math.min(1, age / 180);
        const fade = Math.min(1, (p.b - age) / 600);
        const blink = p.b - age < 2000 && (now % 400) < 200 ? 0.55 : 1;
        c.save();
        c.globalAlpha = fade * blink;
        c.translate(sx, sy);
        c.rotate(p.a);
        c.scale(pop, pop);
        // the plate: dark ring, gold face, ink keyline
        c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2);
        c.fillStyle = "rgba(18,14,21,0.75)"; c.fill();
        c.beginPath(); c.arc(0, 0, R * 0.82, 0, Math.PI * 2);
        c.fillStyle = "rgba(242,184,60,0.28)"; c.fill();
        c.lineWidth = Math.max(1.5, 3 * ratio); c.strokeStyle = AB_COLOR.pad; c.stroke();
        // three chevrons racing toward the launch direction
        const run = calm() ? 0 : (now / 260) % 1;
        c.lineWidth = Math.max(2, 5 * ratio); c.lineCap = "round"; c.lineJoin = "round";
        for (let k = 0; k < 3; k++) {
            const u = (k / 3 + run) % 1;
            const ox = (-0.5 + u) * R * 1.1;
            c.globalAlpha = fade * blink * (0.35 + 0.65 * Math.sin(Math.PI * u));
            c.beginPath();
            c.moveTo(ox - R * 0.18, -R * 0.32); c.lineTo(ox + R * 0.16, 0); c.lineTo(ox - R * 0.18, R * 0.32);
            c.strokeStyle = "#fff3d9"; c.stroke();
        }
        c.restore();
    }
}

export function drawWorld(c, px, py, ratio) {
    const now = performance.now();
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    const sw = global.screenWidth, sh = global.screenHeight;
    for (let i = fx.length - 1; i >= 0; i--) {
        const f = fx[i];
        const age = now - f.born;
        const life = f.life || DUR[f.k] || (f.b > 0 ? f.b + 400 : 600);
        if (age > life) { fx.splice(i, 1); continue; }
        const t = age / life;
        const sx = ratio * f.x - px + cx, sy = ratio * f.y - py + cy;
        const e = findEnt(f.id);
        const es = e ? entScreen(e, px, py, ratio, tmpA) : null;
        c.save();
        switch (f.k) {
            case "dash":
            case "launch": {
                // afterimages from where it started to where the tank is now
                const col = f.k === "launch" ? AB_COLOR.pad : DASH_COL;
                const ex = es ? es.x : sx + Math.cos(f.a) * f.b * ratio * Math.min(1, t * 2);
                const ey = es ? es.y : sy + Math.sin(f.a) * f.b * ratio * Math.min(1, t * 2);
                const rr = es ? es.r : 24 * ratio;
                const n = fewer() ? 2 : 4;
                c.lineCap = "round";
                c.globalAlpha = (1 - t) * 0.5;
                c.strokeStyle = col;
                c.lineWidth = rr * 1.4 * (1 - t * 0.6);
                c.beginPath(); c.moveTo(sx, sy); c.lineTo(ex, ey); c.stroke();
                for (let k = 1; k <= n; k++) {
                    const u = k / (n + 1);
                    c.globalAlpha = (1 - t) * 0.5 * u;
                    c.lineWidth = Math.max(1, 2.5 * ratio);
                    c.beginPath(); c.arc(sx + (ex - sx) * u, sy + (ey - sy) * u, rr * (0.8 + 0.2 * u), 0, Math.PI * 2); c.stroke();
                }
                // speed lines off the back of the hull
                if (!fewer() && t < 0.7) {
                    const ca = Math.cos(f.a), sa = Math.sin(f.a), nx = -sa, ny = ca;
                    c.globalAlpha = (1 - t / 0.7) * 0.85;
                    c.strokeStyle = "#ffffff";
                    c.lineWidth = Math.max(1, 2 * ratio);
                    for (let k = -2; k <= 2; k++) {
                        const off = k * rr * 0.45, back = rr * (1.2 + Math.abs(k) * 0.25);
                        const bx = ex - ca * back + nx * off, by = ey - sa * back + ny * off;
                        c.beginPath(); c.moveTo(bx, by); c.lineTo(bx - ca * rr * (1.3 - Math.abs(k) * 0.2), by - sa * rr * (1.3 - Math.abs(k) * 0.2)); c.stroke();
                    }
                }
                break;
            }
            case "hook":
            case "hookmiss": {
                // the line shoots out, holds while you're reeled in, then snaps back
                const ox = es ? es.x : sx, oy = es ? es.y : sy;
                const out = Math.min(1, age / 110);
                const reel = f.k === "hookmiss" ? Math.max(0, (age - 140) / 260) : 0;
                const len = f.b * ratio * out * (1 - reel);
                // the anchor stays where it bit; a miss comes back to the tank
                const ax = f.k === "hook" ? sx + Math.cos(f.a) * f.b * ratio * out : ox + Math.cos(f.a) * len;
                const ay = f.k === "hook" ? sy + Math.sin(f.a) * f.b * ratio * out : oy + Math.sin(f.a) * len;
                const reached = f.k === "hook" && es && Math.hypot(ax - ox, ay - oy) < es.r * 1.6 && age > 200;
                if (reached && !f.done) f.done = age;
                const fade = f.done ? Math.max(0, 1 - (age - f.done) / 160) : t > 0.85 ? (1 - t) / 0.15 : 1;
                if (fade <= 0) { fx.splice(i, 1); break; }
                c.globalAlpha = fade;
                c.lineCap = "round";
                c.strokeStyle = "#120e15"; c.lineWidth = Math.max(2, 5 * ratio);
                c.beginPath(); c.moveTo(ox, oy); c.lineTo(ax, ay); c.stroke();
                c.strokeStyle = AB_COLOR.grapple; c.lineWidth = Math.max(1, 2.4 * ratio);
                c.beginPath(); c.moveTo(ox, oy); c.lineTo(ax, ay); c.stroke();
                // the claw
                c.translate(ax, ay); c.rotate(f.a);
                c.fillStyle = "#e9f7ff"; c.strokeStyle = "#120e15"; c.lineWidth = Math.max(1, 1.6 * ratio);
                const k = 9 * ratio;
                c.beginPath(); c.moveTo(k, 0); c.lineTo(-k * 0.6, -k * 0.75); c.lineTo(-k * 0.2, 0); c.lineTo(-k * 0.6, k * 0.75); c.closePath();
                c.fill(); c.stroke();
                break;
            }
            case "burrow": {
                // underground: a ring of drill sparks round the hull and a
                // trail of dust behind it, so everyone can follow the tunnel
                const left = f.b - age;
                if (left < 0) { fx.splice(i, 1); break; }
                const fade = Math.min(1, left / 250);
                if (es) {
                    const tr = f.trail || (f.trail = []);
                    if (!f.lastAt || now - f.lastAt > 90) {
                        f.lastAt = now;
                        tr.push(e.render.x, e.render.y, now);
                        if (tr.length > 60) tr.splice(0, 3);
                    }
                }
                const tr = f.trail;
                if (tr) {
                    for (let q = 0; q < tr.length; q += 3) {
                        const u = (now - tr[q + 2]) / 1800;
                        if (u >= 1) continue;
                        const tx = ratio * tr[q] - px + cx, ty = ratio * tr[q + 1] - py + cy;
                        c.globalAlpha = fade * (1 - u) * 0.55;
                        c.fillStyle = (q / 3) & 1 ? "#6f6480" : "#8a7f96";
                        c.beginPath(); c.arc(tx, ty, (14 + 22 * u) * ratio, 0, Math.PI * 2); c.fill();
                    }
                }
                if (!es) break;
                const n = fewer() ? 4 : 9;
                c.globalAlpha = fade;
                c.strokeStyle = AB_COLOR.burrow; c.lineWidth = Math.max(2, 5 * ratio);
                c.setLineDash ? c.setLineDash([es.r * 0.5, es.r * 0.35]) : 0;
                c.lineDashOffset = -now / 12;
                c.beginPath(); c.arc(es.x, es.y, es.r * 1.18, 0, Math.PI * 2); c.stroke();
                c.setLineDash && c.setLineDash(NO_DASH);
                for (let k = 0; k < n; k++) {
                    const a = (k / n) * Math.PI * 2 + now / 90;
                    const u = ((now / 160 + k * 0.37) % 1);
                    const d = es.r * (1.1 + u * 0.9);
                    c.globalAlpha = fade * (1 - u);
                    c.fillStyle = k & 1 ? "#ffd37a" : "#6f6480";
                    c.fillRect(es.x + Math.cos(a) * d - 2 * ratio, es.y + Math.sin(a) * d - 2 * ratio, 4 * ratio, 4 * ratio);
                }
                break;
            }
            case "surface": {
                c.globalAlpha = (1 - t) * 0.7;
                c.strokeStyle = AB_COLOR.burrow; c.lineWidth = Math.max(2, 6 * (1 - t) * ratio);
                c.beginPath(); c.arc(sx, sy, (30 + 90 * ease(t)) * ratio, 0, Math.PI * 2); c.stroke();
                for (let k = 0; k < 8; k++) {
                    const a = k / 8 * Math.PI * 2 + 0.3, d = (30 + 110 * ease(t)) * ratio;
                    c.fillStyle = k & 1 ? "#6f6480" : "#3a3346";
                    c.fillRect(sx + Math.cos(a) * d - 4 * ratio, sy + Math.sin(a) * d - 4 * ratio, 8 * ratio, 8 * ratio);
                }
                break;
            }
            case "shockthrow": {
                // the orb lobbed toward the aim spot, gone the moment it blows
                const dur = Math.max(90, f.b / SHOCK_SPEED);
                if (f.done && f.done - f.born < age) { fx.splice(i, 1); break; }
                if (age > dur + 80) break;
                const u = Math.min(1, age / dur);
                const ca = Math.cos(f.a), sa = Math.sin(f.a), L = f.b * ratio;
                const lift = Math.min(110, f.b * 0.22) * ratio;
                // where it will go off, faint, so anyone can see it coming
                c.globalAlpha = 0.22 * (1 - u * 0.4);
                c.strokeStyle = AB_COLOR.shock; c.lineWidth = Math.max(1, 2 * ratio);
                c.setLineDash(BLAST_DASH);
                c.beginPath(); c.arc(sx + ca * L, sy + sa * L, 430 * ratio, 0, Math.PI * 2); c.stroke();
                c.setLineDash(NO_DASH);
                const gx = sx + ca * L * u, gy = sy + sa * L * u, h = Math.sin(Math.PI * u) * lift;
                // its shadow on the ground, then a short trail
                c.globalAlpha = 0.3;
                c.fillStyle = "#0b0810";
                c.beginPath(); c.ellipse(gx, gy, 11 * ratio, 6 * ratio, 0, 0, Math.PI * 2); c.fill();
                for (let k = 5; k >= 1; k--) {
                    const uu = Math.max(0, u - k * 0.05);
                    c.globalAlpha = 0.4 * (1 - k / 6);
                    c.fillStyle = k & 1 ? AB_COLOR.shock : "#c9bfff";
                    c.beginPath(); c.arc(sx + ca * L * uu, sy + sa * L * uu - Math.sin(Math.PI * uu) * lift, (8 - k) * ratio, 0, Math.PI * 2); c.fill();
                }
                const ox = gx, oy = gy - h;
                const pulse = calm() ? 1 : 1 + 0.15 * Math.sin(now / 40);
                const gr = 34 * ratio * pulse;
                c.globalAlpha = 0.9;
                c.drawImage(glowSprite("shock", "154,134,255"), ox - gr, oy - gr, gr * 2, gr * 2);
                c.globalAlpha = 1;
                c.fillStyle = "#ffffff";
                c.beginPath(); c.arc(ox, oy, 7 * ratio, 0, Math.PI * 2); c.fill();
                c.lineWidth = Math.max(1.5, 3 * ratio); c.strokeStyle = AB_COLOR.shock;
                c.beginPath(); c.arc(ox, oy, 10 * ratio, 0, Math.PI * 2); c.stroke();
                // a little crackle round it
                if (!fewer()) {
                    c.strokeStyle = "#e9f7ff"; c.lineWidth = Math.max(1, 1.4 * ratio);
                    for (let k = 0; k < 3; k++) {
                        const a = now / 70 + k * 2.1;
                        c.beginPath();
                        c.moveTo(ox + Math.cos(a) * 9 * ratio, oy + Math.sin(a) * 9 * ratio);
                        c.lineTo(ox + Math.cos(a + 0.4) * 15 * ratio, oy + Math.sin(a + 0.4) * 15 * ratio);
                        c.lineTo(ox + Math.cos(a + 0.2) * 20 * ratio, oy + Math.sin(a + 0.2) * 20 * ratio);
                        c.stroke();
                    }
                }
                break;
            }
            case "shock": {
                const R = (f.b || 430) * ratio;
                // the flash at the centre
                if (t < 0.2) {
                    const fr = R * (0.25 + 0.4 * ease(t / 0.2));
                    c.globalAlpha = 1 - t / 0.2;
                    c.drawImage(glowSprite("white", "255,255,255"), sx - fr, sy - fr, fr * 2, fr * 2);
                }
                // the air itself, pushed out
                if (t < 0.45) {
                    const u = t / 0.45;
                    const fr = R * (0.2 + 0.85 * ease(u));
                    c.globalAlpha = (1 - u) * 0.55;
                    c.drawImage(glowSprite("shock", "154,134,255"), sx - fr, sy - fr, fr * 2, fr * 2);
                }
                for (let k = 0; k < 3; k++) {
                    const u = Math.max(0, (t - k * 0.1) / (1 - k * 0.1));
                    if (u <= 0 || u >= 1) continue;
                    c.globalAlpha = (1 - u) * (k === 0 ? 0.95 : k === 1 ? 0.6 : 0.45);
                    c.strokeStyle = k === 1 ? "#ffffff" : k === 2 ? "#5ce8ff" : AB_COLOR.shock;
                    c.lineWidth = Math.max(1.5, (18 - k * 6) * (1 - u) * ratio);
                    c.beginPath(); c.arc(sx, sy, R * (0.12 + (k === 2 ? 1 : 0.88) * ease(u)), 0, Math.PI * 2); c.stroke();
                }
                // lightning out to the rim
                if (t < 0.4 && !fewer()) {
                    if (!f.arcs) f.arcs = shockArcs(f.x, f.y);
                    const u = t / 0.4, reach = R * (0.3 + 0.7 * ease(u));
                    c.globalAlpha = (1 - u) * 0.9;
                    c.strokeStyle = "#e9f7ff"; c.lineWidth = Math.max(1, 2.4 * ratio * (1 - u * 0.5));
                    c.lineJoin = "round";
                    for (let k = 0; k < ARC_N; k++) {
                        const a = f.arcs[k * (ARC_P + 1)];
                        const ca = Math.cos(a), sa = Math.sin(a);
                        c.beginPath();
                        c.moveTo(sx + ca * R * 0.08, sy + sa * R * 0.08);
                        for (let q = 1; q <= ARC_P; q++) {
                            const d = reach * q / ARC_P, j = f.arcs[k * (ARC_P + 1) + q] * R * 0.07;
                            c.lineTo(sx + ca * d - sa * j, sy + sa * d + ca * j);
                        }
                        c.stroke();
                    }
                }
                // dust rolling out along the edge
                const dn = fewer() ? 8 : 16, dust = smokeSprite("n");
                for (let k = 0; k < dn; k++) {
                    const a = k / dn * Math.PI * 2 + (f.x & 3);
                    const d = R * (0.55 + 0.42 * ease(Math.min(1, t * 1.4)));
                    const r = (34 + (k % 3) * 14) * ratio * (0.6 + 0.6 * t);
                    c.globalAlpha = 0.45 * (1 - t);
                    c.drawImage(dust, sx + Math.cos(a) * d - r, sy + Math.sin(a) * d - r, r * 2, r * 2);
                }
                // rock shards blown out across the blast
                const n = fewer() ? 10 : 26;
                for (let k = 0; k < n; k++) {
                    const a = k * 2.399 + (f.x & 7);
                    const sp = 0.45 + ((k * 37) % 11) / 20;
                    const d = R * sp * ease(Math.min(1, t * 1.3));
                    const sz = (8 + (k % 4) * 5) * ratio * (1 - t * 0.7);
                    c.globalAlpha = Math.max(0, 1 - t * 1.15);
                    c.save();
                    c.translate(sx + Math.cos(a) * d, sy + Math.sin(a) * d);
                    c.rotate(a + t * 6 * (k & 1 ? 1 : -1));
                    c.fillStyle = k % 3 ? "#3a3346" : "#8a7f96";
                    c.fillRect(-sz, -sz * 0.6, sz * 2, sz * 1.2);
                    c.restore();
                }
                break;
            }
            case "fling":
            case "flinghit": {
                // launched: a smeared trail in the blast's colour behind the hull
                if (!es) break;
                if (now - f.tAt > 28) { f.tAt = now; trailPush(f, e.render.x, e.render.y, now); }
                const fade = 1 - t;
                const T = f.trail, n0 = Math.max(0, f.tn - TRAIL_N);
                c.lineCap = "round"; c.lineJoin = "round";
                if (f.tn > 1) {
                    c.globalAlpha = fade * 0.3;
                    c.strokeStyle = AB_COLOR.shock;
                    c.lineWidth = es.r * 1.5;
                    c.beginPath();
                    for (let j = n0; j < f.tn; j++) {
                        const q = (j % TRAIL_N) * 3, tx = ratio * T[q] - px + cx, ty = ratio * T[q + 1] - py + cy;
                        if (j === n0) c.moveTo(tx, ty); else c.lineTo(tx, ty);
                    }
                    c.lineTo(es.x, es.y);
                    c.stroke();
                    for (let j = n0; j < f.tn; j += 2) {
                        const q = (j % TRAIL_N) * 3, u = (j - n0 + 1) / (f.tn - n0 + 1);
                        c.globalAlpha = fade * 0.45 * u;
                        c.lineWidth = Math.max(1, 2.5 * ratio);
                        c.strokeStyle = "#ffffff";
                        c.beginPath(); c.arc(ratio * T[q] - px + cx, ratio * T[q + 1] - py + cy, es.r * (0.75 + 0.25 * u), 0, Math.PI * 2); c.stroke();
                    }
                }
                // speed lines off the back
                if (!fewer() && t < 0.75) {
                    const ca = Math.cos(f.a), sa = Math.sin(f.a), nx = -sa, ny = ca;
                    c.globalAlpha = (1 - t / 0.75) * 0.85;
                    c.strokeStyle = "#ffffff";
                    c.lineWidth = Math.max(1, 2.2 * ratio);
                    for (let k = -2; k <= 2; k++) {
                        const off = k * es.r * 0.45, back = es.r * (1.25 + Math.abs(k) * 0.25), ln = es.r * (1.6 - Math.abs(k) * 0.25);
                        const bx = es.x - ca * back + nx * off, by = es.y - sa * back + ny * off;
                        c.beginPath(); c.moveTo(bx, by); c.lineTo(bx - ca * ln, by - sa * ln); c.stroke();
                    }
                }
                // hit: static crackling round the hull
                if (f.k === "flinghit" && t < 0.45 && !fewer()) {
                    c.globalAlpha = (1 - t / 0.45) * 0.9;
                    c.strokeStyle = "#5ce8ff"; c.lineWidth = Math.max(1, 2 * ratio);
                    c.beginPath();
                    for (let k = 0; k <= 12; k++) {
                        const a = k / 12 * Math.PI * 2, rr = es.r * (1.15 + ((k * 7 + (now / 40 | 0)) % 5) * 0.06);
                        if (k) c.lineTo(es.x + Math.cos(a) * rr, es.y + Math.sin(a) * rr); else c.moveTo(es.x + Math.cos(a) * rr, es.y + Math.sin(a) * rr);
                    }
                    c.stroke();
                }
                if (f.id === myId() && !calm()) speedLines(c, Math.cos(f.a), Math.sin(f.a), fade, now, "#e9e0ff");
                break;
            }
            case "radar": {
                // a sweep turning round the tank, then a sonar ring out across the screen
                if (es && !fewer()) {
                    const sr = 300 * ratio, a0 = -Math.PI / 2 + ease(t) * Math.PI * 3;
                    for (let k = 0; k < 4; k++) {
                        c.globalAlpha = (1 - t) * (0.22 - k * 0.05);
                        c.fillStyle = AB_COLOR.radar;
                        c.beginPath(); c.moveTo(es.x, es.y); c.arc(es.x, es.y, sr, a0 - (k + 1) * 0.22, a0 - k * 0.22); c.closePath(); c.fill();
                    }
                    c.globalAlpha = (1 - t) * 0.8;
                    c.strokeStyle = "#c8ffd8"; c.lineWidth = Math.max(1, 2 * ratio);
                    c.beginPath(); c.moveTo(es.x, es.y); c.lineTo(es.x + Math.cos(a0) * sr, es.y + Math.sin(a0) * sr); c.stroke();
                }
                const R = f.b * ratio * ease(t);
                c.globalAlpha = (1 - t) * 0.6;
                c.strokeStyle = AB_COLOR.radar;
                c.lineWidth = Math.max(1.5, 4 * (1 - t) * ratio);
                c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.stroke();
                c.globalAlpha = (1 - t) * 0.3;
                c.beginPath(); c.arc(sx, sy, R * 0.7, 0, Math.PI * 2); c.stroke();
                break;
            }
            case "wall": {
                // dust thrown up all along the wall as the rock rises (the
                // wall runs across the aim line through the spot)
                const n = fewer() ? 5 : 11;
                const ux = -Math.sin(f.a), uy = Math.cos(f.a);
                c.globalAlpha = (1 - t) * 0.6;
                c.strokeStyle = "#b9c3d1"; c.lineCap = "round";
                c.lineWidth = Math.max(1.5, 8 * (1 - t) * ratio);
                c.beginPath(); c.moveTo(sx - ux * 240 * ratio, sy - uy * 240 * ratio); c.lineTo(sx + ux * 240 * ratio, sy + uy * 240 * ratio); c.stroke();
                const dust = smokeSprite("n");
                for (let k = 0; k < n; k++) {
                    const along = (k / (n - 1) - 0.5) * 480 * ratio;
                    const r = (18 + 30 * ease(t)) * ratio;
                    c.globalAlpha = (1 - t) * 0.55;
                    c.drawImage(dust, sx + ux * along - r, sy + uy * along - r - 14 * ratio * t, r * 2, r * 2);
                }
                break;
            }
            case "smokethrow": {
                // the canister lobbed to where the cloud will pop, puffing as it goes
                const dur = Math.max(120, f.b / SMOKE_SPEED);
                if (age > dur + 60) { fx.splice(i, 1); break; }
                const u = Math.min(1, age / dur);
                const ca = Math.cos(f.a), sa = Math.sin(f.a), L = f.b * ratio;
                const lift = Math.min(90, 30 + f.b * 0.18) * ratio;
                const cr = 10 * ratio;
                const puff = smokeSprite("l");
                for (let k = 5; k >= 1; k--) {
                    const uu = Math.max(0, u - k * 0.06);
                    const pr = cr * (0.9 + 0.35 * k);
                    c.globalAlpha = 0.4 * (1 - k / 6);
                    c.drawImage(puff, sx + ca * L * uu - pr, sy + sa * L * uu - Math.sin(Math.PI * uu) * lift - pr, pr * 2, pr * 2);
                }
                const gx = sx + ca * L * u, gy = sy + sa * L * u;
                c.globalAlpha = 0.28;
                c.fillStyle = "#0b0810";
                c.beginPath(); c.ellipse(gx, gy, cr, cr * 0.55, 0, 0, Math.PI * 2); c.fill();
                c.globalAlpha = 1;
                c.save();
                c.translate(gx, gy - Math.sin(Math.PI * u) * lift); c.rotate(u * 8);
                H.roundRectPath(c, -cr * 0.7, -cr, cr * 1.4, cr * 2, cr * 0.4);
                c.fillStyle = "#4a4156"; c.fill();
                c.lineWidth = Math.max(1.5, 2.2 * ratio); c.strokeStyle = "#120e15"; c.stroke();
                c.fillStyle = smokeFriend(f) ? SMOKE_TINT.friend : SMOKE_TINT.foe;
                c.fillRect(-cr * 0.7, -cr * 0.25, cr * 1.4, cr * 0.5);
                c.restore();
                break;
            }
            case "smoke": {
                // soft puffs spread evenly over a round footprint, each one
                // drifting and billowing on its own, the whole cloud turning
                // slowly; the side's tint is only a faint rim
                const R = (f.a > 0 ? f.a : 300) * ratio;
                const total = f.b + 900;
                if (age > total) { fx.splice(i, 1); break; }
                if (!f.puffs) f.puffs = smokePuffs(f.x, f.y, fewer() ? 14 : 26);
                const P = f.puffs, n = P.length / PUFF_W;
                const grow = ease(Math.min(1, age / 550));
                const out = age < f.b ? 0 : Math.min(1, (age - f.b) / 900);
                const fade = 1 - out;
                const still = calm();
                // the pop
                if (age < 420) {
                    const u = age / 420;
                    c.globalAlpha = (1 - u) * 0.7;
                    c.strokeStyle = "#e9e0f4"; c.lineWidth = Math.max(2, 6 * (1 - u) * ratio);
                    c.beginPath(); c.arc(sx, sy, R * (0.15 + 0.7 * ease(u)), 0, Math.PI * 2); c.stroke();
                }
                const spin = still ? 0 : age / 16000;
                const dark = smokeSprite("n"), light = smokeSprite("l");
                // thick enough that nothing shows through from outside; from
                // inside it thins so you can still see your own tank
                const me = global.player;
                const wr = (f.a > 0 ? f.a : 300);
                const inside = me && !global.died && Math.hypot(me.renderx - f.x, me.rendery - f.y) < wr;
                const thick = inside ? 0.55 : 1;
                c.globalAlpha = 0.92 * fade * grow * thick;
                c.fillStyle = "#3f394b";
                c.beginPath(); c.arc(sx, sy, R * 0.82 * grow, 0, Math.PI * 2); c.fill();
                for (let k = 0; k < n; k++) {
                    const q = k * PUFF_W;
                    const d0 = P[q], a0 = P[q + 1], sz = P[q + 2], ph = P[q + 3], lit = P[q + 4], delay = P[q + 5];
                    const app = Math.min(1, Math.max(0, (age - delay) / 380));
                    if (app <= 0) continue;
                    const a = a0 + spin;
                    const amp = still ? 0 : R * 0.045;
                    const dx = Math.cos(age / 1700 + ph) * amp, dy = Math.sin(age / 2100 + ph * 1.3) * amp;
                    const d = d0 * R * (0.35 + 0.65 * grow) * (1 + out * 0.12);
                    const r = sz * R * (0.45 + 0.55 * ease(app)) * (1 + (still ? 0 : 0.07 * Math.sin(age / 900 + ph * 2))) * (1 + out * 0.2);
                    c.globalAlpha = (lit ? 0.85 : 0.97) * fade * app * thick;
                    c.drawImage(lit ? light : dark, sx + Math.cos(a) * d + dx - r, sy + Math.sin(a) * d + dy - r, r * 2, r * 2);
                }
                c.globalAlpha = 0.22 * fade * grow;
                c.strokeStyle = smokeFriend(f) ? SMOKE_TINT.friend : SMOKE_TINT.foe;
                c.lineWidth = Math.max(2, 5 * ratio);
                c.beginPath(); c.arc(sx, sy, R * grow * 0.98, 0, Math.PI * 2); c.stroke();
                break;
            }
            case "unsmoke": {
                c.globalAlpha = (1 - t) * 0.4;
                c.fillStyle = "#4a4156";
                c.beginPath(); c.arc(sx, sy, (30 + 50 * ease(t)) * ratio, 0, Math.PI * 2); c.fill();
                break;
            }
            case "rush": {
                // a hot ring flickering round the hull for the whole burst
                if (!es) break;
                const left = f.b - age;
                if (left < 0) { fx.splice(i, 1); break; }
                const fl = calm() ? 0.8 : 0.6 + 0.4 * Math.sin(now / 45);
                c.globalAlpha = Math.min(1, left / 250) * fl;
                c.strokeStyle = AB_COLOR.rush; c.lineWidth = Math.max(3, 6 * ratio);
                c.beginPath(); c.arc(es.x, es.y, es.r * 1.3, 0, Math.PI * 2); c.stroke();
                c.globalAlpha *= 0.5;
                c.strokeStyle = "#ffd37a"; c.lineWidth = Math.max(1.5, 3 * ratio);
                c.beginPath(); c.arc(es.x, es.y, es.r * (1.45 + 0.1 * Math.sin(now / 70)), 0, Math.PI * 2); c.stroke();
                // embers shed while it moves
                if (now - f.tAt > 80 && !fewer()) {
                    const lx = f.tn ? f.trail[((f.tn - 1) % TRAIL_N) * 3] : e.render.x, ly = f.tn ? f.trail[((f.tn - 1) % TRAIL_N) * 3 + 1] : e.render.y;
                    const mx = e.render.x - lx, my = e.render.y - ly;
                    f.tAt = now; trailPush(f, e.render.x, e.render.y, now);
                    if (mx * mx + my * my > 4) jSparks(e.render.x, e.render.y, 2, 70, 380, 0, k2(f) ? "#ff5a48" : "#ffd37a", 0.8, Math.atan2(-my, -mx), 3);
                }
                break;
            }
            case "rocket": {
                // a jet out of the back (against the way it's going), a heat
                // trail, sparks, and speed lines for the one wearing them
                const left = f.b - age;
                if (left < 0) {
                    if (!f.out) {
                        f.out = 1;
                        sound("rocketout", f.lx == null ? f.x : f.lwx, f.lx == null ? f.y : f.lwy);
                        if (e) jSparks(e.render.x, e.render.y, 6, 60, 600, 1, "#4a4156", Math.PI * 2, 0, 6);
                    }
                    if (es) {
                        const u = -left / 700;
                        c.globalAlpha = 0.4 * (1 - u);
                        const r = es.r * (0.8 + u);
                        c.drawImage(smokeSprite("n"), es.x - (f.ux || 0) * es.r * 1.3 - r, es.y - (f.uy || 0) * es.r * 1.3 - r, r * 2, r * 2);
                    }
                    break;
                }
                if (!es) break;
                const fade = Math.min(1, left / 300, age / 120);
                // heading from the last trail point, smoothed so the jet doesn't flicker
                if (now - f.tAt > 35) { f.tAt = now; trailPush(f, e.render.x, e.render.y, now); }
                const q0 = f.tn > 2 ? ((f.tn - 3) % TRAIL_N) * 3 : -1;
                if (q0 >= 0) {
                    const dx = e.render.x - f.trail[q0], dy = e.render.y - f.trail[q0 + 1], dl = Math.hypot(dx, dy);
                    if (dl > 3) { f.ux = (f.ux || 0) * 0.7 + dx / dl * 0.3; f.uy = (f.uy || 0) * 0.7 + dy / dl * 0.3; }
                    f.moving = dl > 3;
                }
                if (f.ux == null) { const fa = e.render.f != null ? e.render.f : 0; f.ux = Math.cos(fa); f.uy = Math.sin(fa); }
                const ul = Math.hypot(f.ux, f.uy) || 1, ux = f.ux / ul, uy = f.uy / ul, nx = -uy, ny = ux;
                f.lwx = e.render.x; f.lwy = e.render.y; f.lx = 1;
                // heat trail
                const T = f.trail, n0 = Math.max(0, f.tn - TRAIL_N);
                if (f.tn > 1) {
                    c.lineCap = "round"; c.lineJoin = "round";
                    for (let pass = 0; pass < 2; pass++) {
                        c.globalAlpha = fade * (pass ? 0.4 : 0.18);
                        c.strokeStyle = pass ? "#ffd37a" : "#ff5a48";
                        c.lineWidth = es.r * (pass ? 0.35 : 1.0);
                        c.beginPath();
                        for (let j = n0; j < f.tn; j++) {
                            const q = (j % TRAIL_N) * 3;
                            if (now - T[q + 2] > 520) continue;
                            const tx = ratio * T[q] - px + cx, ty = ratio * T[q + 1] - py + cy;
                            if (j === n0) c.moveTo(tx, ty); else c.lineTo(tx, ty);
                        }
                        c.lineTo(es.x - ux * es.r, es.y - uy * es.r);
                        c.stroke();
                    }
                }
                // the jet: three layers, flickering
                const bx = es.x - ux * es.r * 0.92, by = es.y - uy * es.r * 0.92;
                const flick = calm() ? 1 : 1 + 0.18 * Math.sin(now / 31) + 0.12 * Math.sin(now / 17);
                const L = es.r * (f.moving === false ? 1.3 : 2.3) * flick;
                const gr = es.r * 2;
                c.globalAlpha = fade * 0.75;
                c.drawImage(glowSprite("rocket", "255,150,60"), bx - gr, by - gr, gr * 2, gr * 2);
                const layers = JET;
                for (let k = 0; k < layers.length; k += 3) {
                    const w = es.r * layers[k], len = L * layers[k + 1];
                    c.globalAlpha = fade * (k ? 0.95 : 0.85);
                    c.fillStyle = JET_COL[k / 3];
                    c.beginPath();
                    c.moveTo(bx + nx * w, by + ny * w);
                    c.quadraticCurveTo(bx - ux * len * 0.45 + nx * w * 0.9, by - uy * len * 0.45 + ny * w * 0.9, bx - ux * len, by - uy * len);
                    c.quadraticCurveTo(bx - ux * len * 0.45 - nx * w * 0.9, by - uy * len * 0.45 - ny * w * 0.9, bx - nx * w, by - ny * w);
                    c.closePath();
                    c.fill();
                }
                // sparks out of the nozzle
                if (now - (f.spAt || 0) > 45 && !fewer()) {
                    f.spAt = now;
                    const wx = e.render.x - ux * (e.size || 24) * 1.1, wy = e.render.y - uy * (e.size || 24) * 1.1;
                    jSparks(wx, wy, 2, 110, 320, 0, (now & 64) ? "#ffd37a" : "#fff3a0", 0.7, Math.atan2(-uy, -ux), 3);
                }
                if (f.id === myId() && !calm() && f.moving !== false) speedLines(c, ux, uy, fade * 0.85, now, "#ffe9c8");
                break;
            }
            // ── kit items ──
            case "k_charge": {
                const ca = Math.cos(f.a), sa = Math.sin(f.a), L = f.b * ratio;
                const tx = sx + ca * L, ty = sy + sa * L;
                if (age < CHARGE_FLY) {
                    const u = age / CHARGE_FLY, h = Math.sin(Math.PI * u) * 40 * ratio;
                    const gx = sx + ca * L * u, gy = sy + sa * L * u - h;
                    c.globalAlpha = 1;
                    c.save();
                    c.translate(gx, gy); c.rotate(u * 9);
                    H.roundRectPath(c, -8 * ratio, -5 * ratio, 16 * ratio, 10 * ratio, 3 * ratio);
                    c.fillStyle = "#e07c2f"; c.fill();
                    c.lineWidth = Math.max(1, 1.8 * ratio); c.strokeStyle = "#120e15"; c.stroke();
                    c.restore();
                    c.fillStyle = "#fff3a0";
                    c.beginPath(); c.arc(gx, gy - 7 * ratio, 2.5 * ratio * (1 + 0.5 * Math.sin(now / 20)), 0, Math.PI * 2); c.fill();
                    break;
                }
                if (!f.boom) {
                    f.boom = 1;
                    const J = window.dwJuice;
                    const wx = f.x + ca * f.b, wy = f.y + sa * f.b;
                    if (J) {
                        try {
                            J.burst(wx, wy, 22, "#6f6480", 190, 800, 1, 7);
                            J.burst(wx, wy, 14, "#ffd37a", 170, 450, 0, 4);
                            J.ring(wx, wy, "#ffe0a8", 20, 170, 420, 9);
                            const me = global.player, d = me ? Math.hypot(wx - me.renderx, wy - me.rendery) : 9999;
                            if (d < 700) J.shake(5 + 9 * (1 - d / 700), 240);
                        } catch (er) { /* */ }
                    }
                }
                const u = (age - CHARGE_FLY) / (f.life - CHARGE_FLY);
                if (u < 0.35) {
                    const fr = (40 + 180 * ease(u / 0.35)) * ratio;
                    c.globalAlpha = 1 - u / 0.35;
                    c.drawImage(glowSprite("charge", "255,190,110"), tx - fr, ty - fr, fr * 2, fr * 2);
                }
                const dust = smokeSprite("n");
                for (let k = 0; k < 9; k++) {
                    const a = k / 9 * Math.PI * 2 + 0.4, d = (40 + 110 * ease(u)) * ratio, r = (22 + 20 * u) * ratio;
                    c.globalAlpha = 0.5 * (1 - u);
                    c.drawImage(dust, tx + Math.cos(a) * d - r, ty + Math.sin(a) * d - r, r * 2, r * 2);
                }
                break;
            }
            case "k_medkit": {
                const x = es ? es.x : sx, y = es ? es.y : sy, r = es ? es.r : 24 * ratio;
                // green pulling in onto the hull, crosses floating up
                c.globalAlpha = (1 - t) * 0.5;
                const gr = r * 3;
                c.drawImage(glowSprite("heal", "111,245,168"), x - gr, y - gr, gr * 2, gr * 2);
                c.globalAlpha = (1 - t) * 0.8;
                c.strokeStyle = "#6ff5a8"; c.lineWidth = Math.max(1.5, 5 * (1 - t) * ratio);
                c.beginPath(); c.arc(x, y, r * (2.8 - 1.7 * ease(t)), 0, Math.PI * 2); c.stroke();
                const n = fewer() ? 3 : 6;
                for (let k = 0; k < n; k++) {
                    const a = k / n * Math.PI * 2 + 0.5;
                    const lt = Math.max(0, Math.min(1, (t - k * 0.06) / 0.7));
                    if (lt <= 0 || lt >= 1) continue;
                    const cx2 = x + Math.cos(a) * r * 1.2, cy2 = y + Math.sin(a) * r * 0.7 - (20 + 70 * lt) * ratio;
                    const s3 = 7 * ratio * (1 - lt * 0.3), w3 = 3 * ratio;
                    c.globalAlpha = 1 - lt;
                    c.fillStyle = "#120e15";
                    c.fillRect(cx2 - w3 / 2 - 1.5, cy2 - s3 - 1.5, w3 + 3, s3 * 2 + 3);
                    c.fillRect(cx2 - s3 - 1.5, cy2 - w3 / 2 - 1.5, s3 * 2 + 3, w3 + 3);
                    c.fillStyle = "#6ff5a8";
                    c.fillRect(cx2 - w3 / 2, cy2 - s3, w3, s3 * 2);
                    c.fillRect(cx2 - s3, cy2 - w3 / 2, s3 * 2, w3);
                }
                break;
            }
            case "k_anchor": {
                // a hex shield round the hull for as long as the storm can't touch you
                if (!es) break;
                const left = f.b - age;
                if (left < -300) { fx.splice(i, 1); break; }
                const fade = left < 0 ? 1 + left / 300 : Math.min(1, age / 150);
                const blink = left > 0 && left < 2500 && (now % 360) < 180 ? 0.45 : 1;
                const slam = age < 350 ? 1 + 1.4 * (1 - ease(age / 350)) : 1;
                const R = es.r * 1.8 * slam, rot = calm() ? 0 : now / 2400;
                c.globalAlpha = fade * blink * 0.16;
                c.fillStyle = "#7fb1f2";
                hexPath(c, es.x, es.y, R, rot); c.fill();
                c.globalAlpha = fade * blink * 0.9;
                c.strokeStyle = "#7fb1f2"; c.lineWidth = Math.max(2, 4.5 * ratio);
                hexPath(c, es.x, es.y, R, rot); c.stroke();
                c.globalAlpha = fade * blink * 0.55;
                c.strokeStyle = "#e3eeff"; c.lineWidth = Math.max(1, 1.6 * ratio);
                hexPath(c, es.x, es.y, R * 0.86, -rot * 1.5); c.stroke();
                break;
            }
            case "k_flash": {
                // a beam straight up, gems riding it out of sight
                const x = es ? es.x : sx, y = es ? es.y : sy;
                const H2 = 300 * ratio, w = 30 * ratio * (1 - t * 0.6);
                c.globalAlpha = (1 - t) * 0.35;
                c.fillStyle = "#5ce0d8";
                c.fillRect(x - w, y - H2, w * 2, H2);
                c.globalAlpha = (1 - t) * 0.75;
                c.fillStyle = "#e9fffd";
                c.fillRect(x - w * 0.25, y - H2, w * 0.5, H2);
                const n = fewer() ? 4 : 9;
                for (let k = 0; k < n; k++) {
                    const lt = Math.max(0, Math.min(1, (t - k * 0.05) / 0.7));
                    if (lt <= 0 || lt >= 1) continue;
                    const gx = x + Math.sin(lt * 8 + k) * w * 0.9, gy = y - lt * H2;
                    const gs = 6 * ratio * (1 - lt * 0.5);
                    c.globalAlpha = 1 - lt;
                    c.fillStyle = k & 1 ? "#5ce0d8" : "#ffffff";
                    c.beginPath(); c.moveTo(gx, gy - gs * 1.4); c.lineTo(gx + gs, gy); c.lineTo(gx, gy + gs * 1.4); c.lineTo(gx - gs, gy); c.closePath(); c.fill();
                }
                break;
            }
            case "k_bulwark": {
                // the ring of rock coming back up: dust all the way round
                const x = es ? es.x : sx, y = es ? es.y : sy;
                const n = fewer() ? 8 : 16, dust = smokeSprite("n");
                for (let k = 0; k < n; k++) {
                    const a = k / n * Math.PI * 2;
                    const d = (150 + 40 * (k & 1)) * ratio, r = (24 + 26 * ease(t)) * ratio;
                    c.globalAlpha = 0.55 * (1 - t);
                    c.drawImage(dust, x + Math.cos(a) * d - r, y + Math.sin(a) * d - r - 18 * ratio * t, r * 2, r * 2);
                }
                c.globalAlpha = (1 - t) * 0.6;
                c.strokeStyle = "#b9c3d1"; c.lineWidth = Math.max(1.5, 6 * (1 - t) * ratio);
                c.beginPath(); c.arc(x, y, (110 + 80 * ease(t)) * ratio, 0, Math.PI * 2); c.stroke();
                break;
            }
            case "k_decoy": {
                // only you see this: a few gold glints round your satchel
                if (!es) break;
                const left = f.b - age;
                if (left < 0) { fx.splice(i, 1); break; }
                const fade = Math.min(1, left / 300, age / 200);
                for (let k = 0; k < 4; k++) {
                    const a = now / 700 + k * Math.PI / 2;
                    const tw = calm() ? 0.7 : 0.5 + 0.5 * Math.sin(now / 160 + k * 1.7);
                    const gx = es.x + Math.cos(a) * es.r * 1.35, gy = es.y + Math.sin(a) * es.r * 1.35, gs = 5 * ratio * (0.6 + 0.6 * tw);
                    c.globalAlpha = fade * (0.35 + 0.5 * tw);
                    c.fillStyle = "#ffd75e";
                    c.beginPath(); c.moveTo(gx, gy - gs * 1.6); c.lineTo(gx + gs * 0.45, gy); c.lineTo(gx, gy + gs * 1.6); c.lineTo(gx - gs * 0.45, gy); c.closePath(); c.fill();
                }
                break;
            }
            case "k_barrage": {
                // the muzzle blast where the chunks leave
                const x = es ? es.x : sx, y = es ? es.y : sy;
                c.globalAlpha = (1 - t) * 0.45;
                c.fillStyle = "#ff8a6b";
                c.beginPath(); c.moveTo(x, y); c.arc(x, y, (60 + 90 * ease(t)) * ratio, f.a - 0.4, f.a + 0.4); c.closePath(); c.fill();
                break;
            }
            case "blink": {
                // a flash where you were, a streak of sparks, a flash where you are
                const ex = sx + Math.cos(f.a) * f.b * ratio, ey = sy + Math.sin(f.a) * f.b * ratio;
                c.globalAlpha = (1 - t) * 0.8;
                c.strokeStyle = "#ff8ab0"; c.lineWidth = Math.max(1.5, 3 * (1 - t) * ratio);
                c.beginPath(); c.arc(sx, sy, (20 + 60 * ease(t)) * ratio, 0, Math.PI * 2); c.stroke();
                c.beginPath(); c.arc(ex, ey, (20 + 50 * ease(t)) * ratio, 0, Math.PI * 2); c.stroke();
                const n = fewer() ? 4 : 10;
                c.fillStyle = "#ffffff";
                for (let k = 0; k < n; k++) {
                    const u = k / n;
                    c.globalAlpha = (1 - t) * (0.4 + 0.6 * u);
                    const r = (2 + 3 * (1 - t)) * ratio;
                    c.fillRect(sx + (ex - sx) * u - r, sy + (ey - sy) * u - r, r * 2, r * 2);
                }
                break;
            }
        }
        c.restore();
    }
    drawRadar(c, px, py, ratio, now, sw, sh, cx, cy);
    drawFog(c, ratio, now);
    drawPlacement(c, px, py, ratio, now);
}

// ── placing an ability ──────────────────────────────────────────────────
// While the key (or the touch button) is held for a placed ability, a ghost
// of the pad or wall follows the aim, held to the range, red where it won't
// go. global.abilAim = { id, range, wx, wy } (wx/wy: a touch drag's spot,
// else the cursor).
export function placeRange(id) {
    const it = id && (global.shop.catalog || []).find(i => i.id === id);
    return it && it.place > 0 ? it.place : 0;
}
export function startAim(id) {
    const range = placeRange(id);
    if (!range) return false;
    global.abilAim = { id, range, at: performance.now(), wx: null, wy: null };
    return true;
}
export function cancelAim() { global.abilAim = null; clearWallPlan(); }
// The world spot it will land on (held to the range).
export function aimSpot(ratio) {
    const a = global.abilAim;
    const me = global.player;
    if (!a || !me) return null;
    let wx = a.wx, wy = a.wy;
    if (wx == null) { wx = me.renderx + global.target.x / ratio; wy = me.rendery + global.target.y / ratio; }
    let dx = wx - me.renderx, dy = wy - me.rendery;
    const d = Math.hypot(dx, dy);
    if (d > a.range) { dx *= a.range / d; dy *= a.range / d; }
    return { x: me.renderx + dx, y: me.rendery + dy, ang: d > 1 ? Math.atan2(dy, dx) : 0, d: Math.min(d, a.range) };
}
// Rock under a world point, by the nearest lattice cell (the cells are
// voronoi, so the nearest centre is the cell the point sits in).
function cellAt(wx, wy) {
    const tr = window.terrainRenderer;
    if (!tr || !tr.ready || !tr.worldToTile || !tr._cellPolys) return null;
    const p = tr.worldToTile(wx, wy);
    if (!p) return null;
    let best = Infinity, hit = null;
    for (const cell of tr._cellPolys.values()) {
        const d = (cell.cx - p.x) ** 2 + (cell.cy - p.y) ** 2;
        if (d < best) { best = d; hit = cell; }
    }
    return hit ? { cell: hit, alive: !tr._rockDead.has(hit.k), s: p.s } : null;
}
function aimValid(id, spot) {
    if (id === "pad") {
        for (let k = 0; k < 5; k++) {
            const a = k / 5 * Math.PI * 2;
            const q = cellAt(spot.x + (k ? Math.cos(a) * 40 : 0), spot.y + (k ? Math.sin(a) * 40 : 0));
            if (q && q.alive) return false;
        }
        return true;
    }
    if (id === "wall") {
        // somewhere along it there must be dug-out ground to raise
        const ux = -Math.sin(spot.ang), uy = Math.cos(spot.ang);
        let open = 0;
        for (let k = -2; k <= 2; k++) { const q = cellAt(spot.x + ux * k * 100, spot.y + uy * k * 100); if (q && !q.alive) open++; }
        return open >= 1;
    }
    return true;
}
let aimCache = { x: NaN, y: NaN, ok: true };
function drawPlacement(c, px, py, ratio, now) {
    const a = global.abilAim;
    if (!a || global.died) return;
    const spot = aimSpot(ratio);
    if (!spot) return;
    const cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    if (Math.abs(spot.x - aimCache.x) > 8 || Math.abs(spot.y - aimCache.y) > 8 || aimCache.id !== a.id) {
        aimCache = { x: spot.x, y: spot.y, id: a.id, ok: aimValid(a.id, spot) };
    }
    // the Barricade: the exact cells the server would raise there (AW)
    const plan = a.id === "wall" ? wallPlanFor(spot, now) : null;
    const ok = plan ? plan.g.length > 0 : aimCache.ok;
    const col = ok ? (AB_COLOR[a.id] || "#f2b83c") : "#ff5a48";
    const mx = ratio * global.player.renderx - px + cx, my = ratio * global.player.rendery - py + cy;
    const sx = ratio * spot.x - px + cx, sy = ratio * spot.y - py + cy;
    c.save();
    // the range ring round the tank
    c.globalAlpha = 0.5;
    c.setLineDash([10 * ratio, 8 * ratio]);
    c.lineWidth = Math.max(1.5, 2.5 * ratio); c.strokeStyle = "#fff3d9";
    c.beginPath(); c.arc(mx, my, a.range * ratio, 0, Math.PI * 2); c.stroke();
    c.setLineDash(NO_DASH);
    c.globalAlpha = 0.35;
    c.beginPath(); c.moveTo(mx, my); c.lineTo(sx, sy); c.stroke();
    const pulse = calm() ? 0.5 : 0.5 + 0.5 * Math.sin(now / 160);
    if (plan) drawWallCells(c, px, py, ratio, plan, pulse);
    c.translate(sx, sy); c.rotate(spot.ang);
    if (a.id === "pad") {
        const R = 62 * ratio;
        c.globalAlpha = 0.28 + 0.12 * pulse;
        c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fillStyle = col; c.fill();
        c.globalAlpha = 0.9;
        c.lineWidth = Math.max(2, 3 * ratio); c.strokeStyle = col; c.stroke();
        c.lineCap = "round"; c.lineJoin = "round"; c.lineWidth = Math.max(2, 5 * ratio); c.strokeStyle = "#fff3d9";
        for (let k = -1; k <= 1; k++) {
            c.beginPath();
            c.moveTo(k * R * 0.35 - R * 0.14, -R * 0.3); c.lineTo(k * R * 0.35 + R * 0.14, 0); c.lineTo(k * R * 0.35 - R * 0.14, R * 0.3);
            c.stroke();
        }
    } else if (a.id === "shock") {
        // the blast it will make: shattered in the middle, launched out to the rim
        const R = 430 * ratio;
        c.globalAlpha = 0.12 + 0.08 * pulse;
        c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fillStyle = col; c.fill();
        c.globalAlpha = 0.85;
        c.setLineDash(BLAST_DASH);
        c.lineDashOffset = calm() ? 0 : -now / 50;
        c.lineWidth = Math.max(2, 3 * ratio); c.strokeStyle = col; c.stroke();
        c.setLineDash(NO_DASH);
        c.globalAlpha = 0.4;
        c.lineWidth = Math.max(1, 2 * ratio);
        c.beginPath(); c.arc(0, 0, 280 * ratio, 0, Math.PI * 2); c.stroke();
        c.globalAlpha = 0.95;
        c.fillStyle = "#ffffff";
        c.beginPath(); c.arc(0, 0, 8 * ratio, 0, Math.PI * 2); c.fill();
        c.lineWidth = Math.max(1.5, 3 * ratio); c.strokeStyle = col;
        c.beginPath(); c.arc(0, 0, (11 + 3 * pulse) * ratio, 0, Math.PI * 2); c.stroke();
    } else if (a.id === "wall" && !(plan && plan.g.length)) {
        // waiting on the server's plan, or nothing to raise there (red): the band
        const L = 240 * ratio, T = 95 * ratio;
        c.globalAlpha = 0.5;
        c.setLineDash(BLAST_DASH);
        H.roundRectPath(c, -T, -L, T * 2, L * 2, T * 0.5);
        c.lineWidth = Math.max(1.5, 2 * ratio); c.strokeStyle = col; c.stroke();
        c.setLineDash(NO_DASH);
    } else if (a.id === "smoke") {
        // the cloud it will make
        const R = 300 * ratio;
        c.globalAlpha = 0.16 + 0.06 * pulse;
        c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fillStyle = "#8a80a0"; c.fill();
        c.globalAlpha = 0.85;
        c.setLineDash(BLAST_DASH);
        c.lineDashOffset = calm() ? 0 : -now / 60;
        c.lineWidth = Math.max(2, 3 * ratio); c.strokeStyle = "#d8d3e0"; c.stroke();
        c.setLineDash(NO_DASH);
        c.globalAlpha = 0.95;
        H.roundRectPath(c, -7 * ratio, -10 * ratio, 14 * ratio, 20 * ratio, 4 * ratio);
        c.fillStyle = "#4a4156"; c.fill();
        c.lineWidth = Math.max(1, 2 * ratio); c.strokeStyle = "#120e15"; c.stroke();
    }
    c.restore();
}
const NO_DASH = [];
const BLAST_DASH = [12, 10];

// ── Barricade preview ───────────────────────────────────────────────────
// While it's aimed, the client asks the server ('ab', 3, x, y) which cells
// it would raise there and draws exactly those (AW), red where a tank or a
// chest is in the way. Same rule as the cast (abilities.js wallPlan).
let wallPlan = null, wallAskAt = 0, wallAskX = NaN, wallAskY = NaN;
export function onWallPlan(d) {
    if (!d || !Array.isArray(d.g)) return;
    wallPlan = { x: +d.x || 0, y: +d.y || 0, g: d.g, r: Array.isArray(d.r) ? d.r : [], at: performance.now() };
}
function wallPlanFor(spot, now) {
    const moved = Math.abs(spot.x - wallAskX) > 10 || Math.abs(spot.y - wallAskY) > 10;
    if ((moved && now - wallAskAt > 90) || now - wallAskAt > 400) {
        wallAskAt = now; wallAskX = spot.x; wallAskY = spot.y;
        try { if (global.socket && global.socket.talk) global.socket.talk('ab', 3, Math.round(spot.x), Math.round(spot.y)); } catch (e) { /* */ }
    }
    const p = wallPlan;
    if (!p || now - p.at > 900 || Math.hypot(p.x - spot.x, p.y - spot.y) > 40) return null;
    return p;
}
function drawWallCells(c, px, py, ratio, plan, pulse) {
    const tr = window.terrainRenderer, w = tr && tr._world;
    if (!w || !tr._cellPolys) return;
    const k = ratio * w.s;
    c.save();
    c.translate(global.screenWidth / 2 - px - ratio * w.hw, global.screenHeight / 2 - py - ratio * w.hh);
    c.scale(k, k);
    c.lineJoin = "round";
    for (let pass = 0; pass < 2; pass++) {
        const keys = pass ? plan.r : plan.g;
        const col = pass ? "#ff5a48" : AB_COLOR.wall;
        for (let i = 0; i < keys.length; i++) {
            const cell = tr._cellPolys.get(keys[i]);
            if (!cell || !cell.path) continue;
            c.globalAlpha = pass ? 0.22 : 0.3 + 0.15 * pulse;
            c.fillStyle = col; c.fill(cell.path);
            c.globalAlpha = 0.95;
            c.lineWidth = 3 / k; c.strokeStyle = pass ? col : "#e3e8f0"; c.stroke(cell.path);
        }
    }
    c.restore();
}
export function clearWallPlan() { wallPlan = null; wallAskX = NaN; }
// rocket jet layers: half-width and length (of the hull radius), colour
const JET = [0.6, 1.0, 0, 0.42, 0.78, 0, 0.22, 0.5, 0];
const JET_COL = ["#ff5a48", "#ffb347", "#fff3a0"];
const k2 = (f) => (f.tn & 1) === 1;
function trailPush(f, x, y, t) {
    const q = (f.tn % TRAIL_N) * 3;
    f.trail[q] = x; f.trail[q + 1] = y; f.trail[q + 2] = t;
    f.tn++;
}
function hexPath(c, x, y, r, rot) {
    c.beginPath();
    for (let k = 0; k < 6; k++) {
        const a = rot + k * Math.PI / 3;
        if (k) c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    c.closePath();
}
// Shockwave lightning: ARC_N bolts, each an angle then ARC_P sideways
// jitters, made once per blast from its spot so every client draws the same.
const ARC_N = 7, ARC_P = 6;
function shockArcs(x, y) {
    const a = new Float32Array(ARC_N * (ARC_P + 1));
    let h = ((x * 73856093) ^ (y * 19349663)) >>> 0 || 7;
    const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
    for (let k = 0; k < ARC_N; k++) {
        a[k * (ARC_P + 1)] = k / ARC_N * Math.PI * 2 + rnd() * 0.6;
        for (let q = 1; q <= ARC_P; q++) a[k * (ARC_P + 1) + q] = (rnd() - 0.5) * 2;
    }
    return a;
}
// Soft round glows, baked once per colour.
const glows = {};
function glowSprite(key, rgb) {
    if (glows[key]) return glows[key];
    const S = 96, cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, "rgba(" + rgb + ",0.95)");
    grad.addColorStop(0.35, "rgba(" + rgb + ",0.55)");
    grad.addColorStop(1, "rgba(" + rgb + ",0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    glows[key] = cv;
    return cv;
}
// Screen-space speed lines streaming past, for your own tank at speed.
// (ux, uy) is the way you're going; nothing near the middle, so the tank
// stays clear.
const SL_N = 18;
const SL_SEED = new Float32Array(SL_N * 3);
for (let i = 0; i < SL_SEED.length; i++) { const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453; SL_SEED[i] = v - Math.floor(v); }
function speedLines(c, ux, uy, k, now, col) {
    if (k <= 0.02) return;
    const W = global.screenWidth, Hh = global.screenHeight, cx = W / 2, cy = Hh / 2;
    const D = Math.hypot(W, Hh) * 0.55, nx = -uy, ny = ux;
    const n = fewer() ? 8 : SL_N;
    c.save();
    c.lineCap = "round";
    c.strokeStyle = col;
    for (let i = 0; i < n; i++) {
        const lat = (SL_SEED[i * 3] - 0.5) * 2 * D;
        if (Math.abs(lat) < 170) continue;
        const ph = (now / 320 * (0.8 + SL_SEED[i * 3 + 1] * 0.6) + SL_SEED[i * 3 + 2]) % 1;
        const along = (0.5 - ph) * 2 * D, len = 70 + 110 * SL_SEED[i * 3 + 1];
        const x = cx + nx * lat + ux * along, y = cy + ny * lat + uy * along;
        c.globalAlpha = k * 0.3 * Math.sin(Math.PI * ph);
        c.lineWidth = 1.5 + 2 * SL_SEED[i * 3 + 2];
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + ux * len, y + uy * len); c.stroke();
    }
    c.restore();
}

// smoke: each puff is (distance out of the radius, angle, size of the
// radius, drift phase, lighter shade, delay before it shows), spread on a
// sunflower pattern so the cloud is evenly filled and round
const SMOKE_SPEED = 1.1;          // the canister, units per ms (abilities.js SMOKE.throwSpeed)
const PUFF_W = 6;
function smokePuffs(x, y, n) {
    const P = new Float32Array(n * PUFF_W);
    let h = ((x * 2654435761) ^ (y * 40503)) >>> 0 || 3;
    const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
    const turn = rnd() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
        const u = Math.sqrt((k + 0.5) / n);
        const q = k * PUFF_W;
        P[q] = u * 0.8 + (rnd() - 0.5) * 0.06;
        P[q + 1] = turn + k * 2.39996 + (rnd() - 0.5) * 0.3;
        P[q + 2] = (0.34 - 0.13 * u) * (0.85 + rnd() * 0.3);
        P[q + 3] = rnd() * Math.PI * 2;
        P[q + 4] = rnd() < 0.35 ? 1 : 0;
        P[q + 5] = u * 260 + rnd() * 60;
    }
    return P;
}
// whose smoke: yours or a teammate's reads blue, anyone else's red
function smokeFriend(f) {
    if (f.friend != null) return f.friend;
    const e = findEnt(f.id), me = findEnt(myId());
    f.friend = (!!f.id && f.id === myId()) || !!(e && me && e.color != null && e.color === me.color);
    return f.friend;
}
const SMOKE_TINT = { friend: "#6fb4ff", foe: "#ff6b5e" };
// Baked puffs: a soft grey one for the body of the cloud and, per side, a
// tinted one for the rim, both fading smoothly to nothing.
const smokeSprites = {};
function smokeSprite(kind) {
    if (smokeSprites[kind]) return smokeSprites[kind];
    const S = 128, cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    const rgb = kind === "f" ? "92,108,140" : kind === "e" ? "138,86,92" : kind === "l" ? "104,96,120" : "70,63,84";
    grad.addColorStop(0, "rgba(" + rgb + ",0.95)");
    grad.addColorStop(0.45, "rgba(" + rgb + ",0.8)");
    grad.addColorStop(0.75, "rgba(" + rgb + ",0.35)");
    grad.addColorStop(1, "rgba(" + rgb + ",0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    smokeSprites[kind] = cv;
    return cv;
}
// Inside a smoke cloud you see a light fog: you're hidden.
function drawFog(c, ratio, now) {
    const me = global.player;
    if (!me || global.died) return;
    let inside = 0;
    for (const f of fx) {
        if (f.k !== "smoke") continue;
        const age = now - f.born;
        if (age > f.b) continue;
        const R = (f.a > 0 ? f.a : 300) * ease(Math.min(1, age / 550));
        const d = Math.hypot(me.renderx - f.x, me.rendery - f.y);
        if (d < R) inside = Math.max(inside, Math.min(1, (R - d) / 60));
    }
    if (!inside) return;
    c.save();
    c.globalAlpha = 0.2 * inside;
    c.fillStyle = "#d8d3e0";
    c.fillRect(0, 0, global.screenWidth, global.screenHeight);
    c.restore();
}

// Radar contacts: a ring on each one in view, an arrow on the edge for the rest.
function drawRadar(c, px, py, ratio, now, sw, sh, cx, cy) {
    if (!S.radar.length || now - S.radarAt > 1500) return;
    const pulse = calm() ? 0.5 : 0.5 + 0.5 * Math.sin(now / 160);
    c.save();
    for (const r of S.radar) {
        const f = r[2] | 0;
        if (f & 16) continue;     // your teammate is on your HUD already
        const col = (f & 1) ? "#f2b83c" : (f & 4) ? "#c9a8ff" : AB_COLOR.radar;
        const x = ratio * r[0] - px + cx, y = ratio * r[1] - py + cy;
        const m = 36;
        if (x > m && y > m && x < sw - m && y < sh - m) {
            c.globalAlpha = 0.55 + 0.35 * pulse;
            c.strokeStyle = col; c.lineWidth = 2.5;
            c.beginPath(); c.arc(x, y, (f & 4 ? 70 : 34) * ratio + 6 * pulse, 0, Math.PI * 2); c.stroke();
            continue;
        }
        // edge arrow
        const dx = x - cx, dy = y - cy;
        const k = Math.min((sw / 2 - 30) / Math.max(1, Math.abs(dx)), (sh / 2 - 30) / Math.max(1, Math.abs(dy)));
        const ex = cx + dx * k, ey = cy + dy * k, a = Math.atan2(dy, dx);
        c.globalAlpha = 0.85;
        c.save();
        c.translate(ex, ey); c.rotate(a);
        c.fillStyle = col; c.strokeStyle = "#120e15"; c.lineWidth = 2; c.lineJoin = "round";
        const s = (f & 1) ? 1.25 : 1;
        c.beginPath(); c.moveTo(10 * s, 0); c.lineTo(-6 * s, -7 * s); c.lineTo(-3 * s, 0); c.lineTo(-6 * s, 7 * s); c.closePath();
        c.fill(); c.stroke();
        c.restore();
    }
    c.restore();
}

// Radar contacts on a map (app.js drawMapMarkers passes its transform).
export function drawMapRadar(c, T) {
    const now = performance.now();
    if (!S.radar.length || now - S.radarAt > 1500) return;
    c.save();
    for (const r of S.radar) {
        const f = r[2] | 0;
        if (f & 16) continue;
        c.fillStyle = (f & 1) ? "#f2b83c" : (f & 4) ? "#c9a8ff" : AB_COLOR.radar;
        c.strokeStyle = "#120e15"; c.lineWidth = 1.2;
        c.beginPath(); c.arc(T.X(r[0]), T.Y(r[1]), (f & 1) ? 3.6 : 2.8, 0, Math.PI * 2);
        c.fill(); c.stroke();
    }
    c.restore();
}

// ── HUD ─────────────────────────────────────────────────────────────────
const AB_SHORT = { grapple: "GRAPPLE", burrow: "BURROW", shock: "SHOCK", radar: "RADAR", wall: "WALL", smoke: "SMOKE", rush: "RUSH", pad: "PAD" };
export function shortName(id) { return AB_SHORT[id] || String(id || "").toUpperCase(); }

// A small label pill: dark plate, thin rim, medium-weight text, no outline
// on the letters (the thick outlined title face read as a blob this small).
const pillW = new Map();
function pill(c, cx, cy, text, size, col) {
    const font = "600 " + size + "px Rubik, Ubuntu, sans-serif";
    let w = pillW.get(font + text);
    if (w === undefined) {
        c.save(); c.font = font; w = c.measureText(text).width; c.restore();
        if (pillW.size > 80) pillW.clear();
        pillW.set(font + text, w);
    }
    const h = size + 7, pw = w + size * 1.1;
    c.save();
    H.roundRectPath(c, cx - pw / 2, cy - h / 2, pw, h, h / 2);
    c.fillStyle = "rgba(18,14,21,0.92)"; c.fill();
    c.lineWidth = 1.25; c.strokeStyle = col; c.stroke();
    c.font = font; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = col;
    c.fillText(text, cx, cy + 0.5);
    c.restore();
}
function fmtSec(ms) { return String(Math.max(1, Math.ceil(ms / 1000))); }
function fmtClock(ms) { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

// The dash glyph: three chevrons, the front one brightest.
function dashGlyph(c, x, y, s, alpha) {
    c.save();
    c.lineCap = "round"; c.lineJoin = "round";
    for (let k = 0; k < 3; k++) {
        const ox = x + (k - 1) * s * 0.42;
        c.globalAlpha = alpha * (0.4 + k * 0.3);
        c.beginPath();
        c.moveTo(ox - s * 0.2, y - s * 0.36); c.lineTo(ox + s * 0.16, y); c.lineTo(ox - s * 0.2, y + s * 0.36);
        c.lineWidth = s * 0.26; c.strokeStyle = "#120e15"; c.stroke();
        c.lineWidth = s * 0.15; c.strokeStyle = DASH_COL; c.stroke();
    }
    c.restore();
}

// Ring around a round button: done part bright, the rest a dark track.
function ring(c, x, y, r, frac, col, lw) {
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    c.lineWidth = lw; c.strokeStyle = "rgba(14,11,18,0.7)"; c.stroke();
    if (frac > 0.001) {
        c.beginPath(); c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
        c.strokeStyle = col; c.stroke();
    }
}
// a dark pie over the part of the cooldown still to run
function sweep(c, x, y, r, frac) {
    if (frac <= 0.001) return;
    c.beginPath(); c.moveTo(x, y);
    c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
    c.closePath();
    c.fillStyle = "rgba(14,11,18,0.62)"; c.fill();
}

function ownedCount() { return S.own.length + (S.tw && !S.own.includes(S.tw) ? 1 : 0); }

// Desktop: two chips right of the wallet row. `anchor` is the wallet's
// rect (GUI units); `mouse` the cursor in GUI units. -> the drawn rect.
export function drawHud(c, anchor, mouse) {
    if (!S.on || !H || !anchor) return null;
    const now = performance.now();
    const sz = 52, gap = 10;
    const x0 = anchor.x + anchor.w + 22;
    const y0 = anchor.y + anchor.h - sz + 2;
    const dashKey = H.keyLabel("KEY_DASH", "Shift"), abKey = H.keyLabel("KEY_ABILITY", "Q");
    // ── dash ──
    {
        const x = x0, y = y0, mx = x + sz / 2, my = y + sz / 2;
        const used = now - S.dashAt, got = now - S.gotAt;
        const press = used < 120 ? 2 : 0;
        H.hudPanel(c, x, y + press, sz, sz, { r: 12, fill: S.d > 0 ? "rgba(43,37,51,0.9)" : "rgba(30,25,36,0.9)" });
        if (got < 500) {
            c.save(); c.globalAlpha = 1 - got / 500;
            H.roundRectPath(c, x - 3, y - 3 + press, sz + 6, sz + 6, 14);
            c.lineWidth = 2.5; c.strokeStyle = DASH_COL; c.stroke(); c.restore();
        }
        dashGlyph(c, mx, my - 5 + press, 22, S.d > 0 ? 1 : 0.45);
        // charge pips; the one refilling shows how far along it is
        const pipW = 14, pipH = 5, pg = 4, pw = S.dm * pipW + (S.dm - 1) * pg;
        const frac = S.drAt ? 1 - Math.max(0, S.drAt - now) / S.drm : 1;
        for (let i = 0; i < S.dm; i++) {
            const px = mx - pw / 2 + i * (pipW + pg), py = y + sz - 12 + press;
            H.roundRectPath(c, px, py, pipW, pipH, 2.5);
            c.fillStyle = "rgba(14,11,18,0.75)"; c.fill();
            const fill = i < S.d ? 1 : i === S.d ? Math.max(0, Math.min(1, frac)) : 0;
            if (fill > 0) {
                H.roundRectPath(c, px, py, Math.max(pipH, pipW * fill), pipH, 2.5);
                c.fillStyle = fill >= 1 ? DASH_COL : "rgba(191,239,255,0.45)"; c.fill();
            }
        }
        H.hudKey(c, x - 6, y - 8 + press, dashKey, 16);
        if (!dashSeen && !global.tutorialMode) {
            const k = calm() ? 0.6 : 0.5 + 0.5 * Math.sin(now / 220);
            c.save(); c.globalAlpha = 0.5 + 0.5 * k;
            H.roundRectPath(c, x - 4 - 3 * k, y - 4 - 3 * k, sz + 8 + 6 * k, sz + 8 + 6 * k, 15);
            c.lineWidth = 2.5; c.strokeStyle = DASH_COL; c.stroke(); c.restore();
            H.hudTitle("Try it!", mx, y - 20, 12, DASH_COL, "center", 1, c);
        }
        if (mouse && mouse.x >= x && mouse.x <= x + sz && mouse.y >= y && mouse.y <= y + sz) {
            H.queueTip("Dash  ·  " + dashKey, "A quick burst the way you're moving. 2 charges, each one back in 5 seconds. Rock still stops you.", mx, y);
        }
    }
    // ── ability ──
    {
        const x = x0 + sz + gap, y = y0, mx = x + sz / 2, my = y + sz / 2;
        const id = S.eq;
        const cd = Math.max(0, S.cdAt - now), cdFrac = S.cdm ? cd / S.cdm : 0;
        const col = id ? (AB_COLOR[id] || "#f2b83c") : null;
        H.hudPanel(c, x, y, sz, sz, { r: 12, fill: id && !cd ? "rgba(43,37,51,0.9)" : "rgba(30,25,36,0.9)" });
        if (id) {
            H.markSlot(id, { x: mx, y: my - 4, w: sz, h: sz, sx: x, sy: y, at: now });
            if (global.kitUnlockHeld !== id) H.drawKitIcon(c, id, mx, my - 4, 30);
            c.save();
            H.roundRectPath(c, x + 2, y + 2, sz - 4, sz - 4, 10); c.clip();
            sweep(c, mx, my, sz, cdFrac);
            c.restore();
            if (cd > 0) H.hudTitle(fmtSec(cd), mx, my - 4, 16, "#fff3d9", "center", 1, c);
            const down = S.act === "burrow" && S.actAt > now;
            H.drawText(down ? "SURFACE" : shortName(id), mx, y + sz - 7, 7.5, down ? "#ffd37a" : cd ? H.HUD.text2 : "#ffffff", "center", true);
            // ready again: a flash in its colour
            const rd = now - S.readyAt;
            if (rd < 600) {
                c.save(); c.globalAlpha = 1 - rd / 600;
                H.roundRectPath(c, x - 3 - 6 * rd / 600, y - 3 - 6 * rd / 600, sz + 6 + 12 * rd / 600, sz + 6 + 12 * rd / 600, 14);
                c.lineWidth = 3; c.strokeStyle = col; c.stroke(); c.restore();
            }
            // something running (burrow, smoke...): a ring running down
            if (S.act && S.actAt > now) {
                c.save();
                H.roundRectPath(c, x - 2, y - 2, sz + 4, sz + 4, 13);
                c.lineWidth = 2.5; c.strokeStyle = col; c.globalAlpha = 0.6 + 0.4 * Math.sin(now / 90); c.stroke();
                c.restore();
            }
        } else {
            c.save(); c.globalAlpha = 0.45;
            H.roundRectPath(c, mx - 13, my - 17, 26, 26, 6);
            c.setLineDash([3, 3]); c.lineWidth = 1; c.strokeStyle = "#ffffff"; c.stroke(); c.setLineDash(NO_DASH);
            c.restore();
            H.drawText("NONE", mx, y + sz - 7, 7.5, H.HUD.text2, "center", true);
        }
        H.hudKey(c, x - 6, y - 8, abKey, 16, id ? 1 : 0.55);
        // a trial: its time left over the chip
        if (S.trialId && S.trialAt > now) {
            pill(c, mx, y - 20, "Trial " + fmtClock(S.trialAt - now), 10.5, "#f2c35a");
        }
        if (mouse && mouse.x >= x && mouse.x <= x + sz && mouse.y >= y && mouse.y <= y + sz) {
            const item = id ? (global.shop.catalog || []).find(i => i.id === id) : null;
            if (item) H.queueTip(item.name + "  ·  " + abKey, item.desc + (ownedCount() > 1 ? " Swap abilities with Equip in a shop." : ""), mx, y);
            else H.queueTip("Ability  ·  " + abKey, "Shops sell abilities: grapple hooks, shockwaves, smoke and more. Yours for the whole raid.", mx, y);
        }
    }
    return { x: x0 - 8, y: y0 - 28, w: sz * 2 + gap + 14, h: sz + 30 };
}

// Touch: what a thumb button does, over it, while it is long-pressed
// (touch.js global.touchTip) or the first time an ability lands in the slot.
function touchTipText(name) {
    const cat = (global.shop && global.shop.catalog) || [];
    const find = (id) => id ? cat.find(i => i.id === id) : null;
    const st = (global.shop && global.shop.state) || {};
    if (name === "dash") return ["Dash", "A quick burst the way you're moving. 2 charges, each one back in 5 seconds. Rock still stops you."];
    if (name === "ability") {
        const it = find(S.eq);
        if (!it) return ["Ability", "Shops sell abilities: grapple hooks, shockwaves, smoke and more. Yours for the whole raid."];
        return [it.name, it.desc + (it.place ? " Tap to use it where you aim, or drag off the button to aim it." : " Tap to use it.")];
    }
    if (name === "arm") {
        const it = find(st.arm);
        return it ? [it.name, it.desc + " Tap the button to fire it with your gun, or stop."] : null;
    }
    if (name.startsWith("kit")) {
        const it = find((st.kitOrder || [])[+name.slice(3)]);
        return it ? [it.name, it.desc + " Tap to use it, drag it away to drop it."] : null;
    }
    return null;
}
export function drawTouchTip(L, k) {
    const tt = global.touchTip;
    if (!tt || !H || !L) return;
    const now = performance.now();
    if (tt.until && now > tt.until) { global.touchTip = null; return; }
    // the first-time one waits out the sky drop and any unlock card
    const land = tt.auto && H.landAt ? H.landAt() : 0;
    if (land) { tt.from = land + 2600; tt.until = land + 7600; return; }
    if (tt.from && now < tt.from) return;
    if (tt.auto && global.kitUnlocks && global.kitUnlocks.length) return;
    const b = L[tt.name];
    const txt = b && touchTipText(tt.name);
    if (!txt) return;
    const top = b.y - (b.r || (b.h || 60) / 2) - 8;
    H.queueTip(txt[0], txt[1], b.x * k, top * k, true);
}

// Touch: the dash and ability buttons (touch.js lays them out, L in CSS
// px, k = GUI units per CSS px).
export function drawTouch(c, L, k, held) {
    if (!S.on || !H || !L || !L.dash) return;
    const now = performance.now();
    {
        const b = L.dash, x = b.x * k, y = b.y * k, r = b.r * k;
        const down = held("dash");
        c.save();
        c.beginPath(); c.arc(x, y + 3, r, 0, Math.PI * 2); c.fillStyle = "rgba(0,0,0,0.3)"; c.fill();
        c.beginPath(); c.arc(x, y + (down ? 2 : 0), r, 0, Math.PI * 2);
        c.fillStyle = S.d > 0 ? (down ? H.HUD.raised : "rgba(43,37,51,0.88)") : "rgba(30,25,36,0.8)"; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = H.HUD.line; c.stroke();
        const frac = S.d >= S.dm ? 1 : S.drAt ? 1 - Math.max(0, S.drAt - now) / S.drm : 0;
        ring(c, x, y, r + 4, S.d >= S.dm ? 1 : frac, S.d > 0 ? DASH_COL : "rgba(191,239,255,0.5)", 4);
        dashGlyph(c, x, y - r * 0.12 + (down ? 2 : 0), r * 0.85, S.d > 0 ? 1 : 0.45);
        for (let i = 0; i < S.dm; i++) {
            c.beginPath(); c.arc(x + (i - (S.dm - 1) / 2) * r * 0.42, y + r * 0.52, r * 0.11, 0, Math.PI * 2);
            c.fillStyle = i < S.d ? DASH_COL : "rgba(14,11,18,0.8)"; c.fill();
        }
        c.restore();
    }
    if (L.ability) {
        const b = L.ability, x = b.x * k, y = b.y * k, r = b.r * k;
        const id = S.eq, down = held("ability");
        const cd = Math.max(0, S.cdAt - now), cdFrac = S.cdm ? cd / S.cdm : 0;
        c.save();
        c.globalAlpha = id ? 1 : 0.5;
        c.beginPath(); c.arc(x, y + 3, r, 0, Math.PI * 2); c.fillStyle = "rgba(0,0,0,0.3)"; c.fill();
        c.beginPath(); c.arc(x, y + (down ? 2 : 0), r, 0, Math.PI * 2);
        c.fillStyle = down ? H.HUD.raised : "rgba(43,37,51,0.88)"; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = H.HUD.line; c.stroke();
        if (id) {
            H.markSlot(id, { x, y, w: r * 2, h: r * 2, sx: x - r, sy: y - r, at: now });
            if (global.kitUnlockHeld !== id) H.drawKitIcon(c, id, x, y + (down ? 2 : 0), r * 1.1);
            sweep(c, x, y, r, cdFrac);
            if (cd > 0) H.hudTitle(fmtSec(cd), x, y, Math.max(14, r * 0.5), "#fff3d9", "center", 1, c);
            ring(c, x, y, r + 4, 1 - cdFrac, AB_COLOR[id] || "#f2b83c", 4);
            if (S.trialId && S.trialAt > now) pill(c, x, y - r - 14, "Trial " + fmtClock(S.trialAt - now), 12, "#f2c35a");
        } else {
            H.hudTitle("+", x, y - 2, r * 0.9, H.HUD.text2, "center", 1, c);
        }
        c.restore();
    }
}
