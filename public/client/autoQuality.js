// Automatic low-end trim (rules in autoQualityLogic.js). The player's own
// settings are never written: loadSettings() reads them from the Graphics
// panel, then applyTo() puts the automatic rungs on top. Touching one of
// these settings by hand hands it back to the player for good.
import { global } from "./global.js";
import { config } from "./config.js";
import { Ladder, startRung, RUNGS } from "./autoQualityLogic.js";

const IDS = { fxLow: "optFxLevel", fewerFx: "optFewerFx", simpleTerrain: "optSimpleTerrain", fps30: "opt30Fps" };
const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
};

// read by juice.js (glitches stay on, rarer, while the trim is what lowered things)
const state = global.autoQ = { active: false, rung: 0, fxLow: false, fewerFx: false, simpleTerrain: false, fps30: false };

let manual = new Set();
try { manual = new Set(JSON.parse(store.get("dwAutoManual") || "[]")); } catch (e) { }
let ladder = null, user = null, off = false, softSeen = false, lastAt = 0, toast = null, playing = false;

function env() {
    return {
        cores: navigator.hardwareConcurrency || 0,
        memory: navigator.deviceMemory || 0,
        mobile: !!global.mobile,
        dpr: window.devicePixelRatio || 1,
        softGl: softGpu(),
    };
}
function softGpu() { const tr = window.terrainRenderer; return !!(tr && tr._rockQuality != null && tr._rockQuality < 1); }

function ensure() {
    if (ladder) return ladder;
    // what worked last time, trusted one rung less (each session re-learns the rest)
    const kept = (parseInt(store.get("dwAutoQ"), 10) || 0) - 1;
    ladder = new Ladder(Math.max(startRung(env()), Math.min(kept, RUNGS.length)));
    return ladder;
}

export function init(opts = {}) {
    toast = opts.toast || null;
    ensure();
    // a real click on one of these settings makes it the player's
    document.addEventListener("change", (e) => {
        const id = e.target && e.target.id;
        if (!e.isTrusted || !id) return;
        for (const [rung, rid] of Object.entries(IDS)) {
            if (rid !== id || manual.has(rung)) continue;
            manual.add(rung);
            store.set("dwAutoManual", JSON.stringify([...manual]));
        }
    }, true);
}

// g = config.graphical just after loadSettings() read the player's choices
export function applyTo(g = config.graphical) {
    user = { fxLevel: g.fxLevel, fewerEffects: g.fewerEffects, simpleTerrain: g.simpleTerrain, fpsCap30: g.fpsCap30 };
    put(g);
}

function put(g = config.graphical) {
    const L = ensure();
    if (!user) return;
    const skip = [...manual];
    if (user.fxLevel === 0) skip.push("fxLow");
    if (user.fewerEffects) skip.push("fewerFx");
    if (user.simpleTerrain) skip.push("simpleTerrain");
    if (user.fpsCap30) skip.push("fps30");
    L.setSkip(skip);
    const on = (r) => !off && L.on(r);
    g.fxLevel = on("fxLow") ? 0 : user.fxLevel;
    g.fewerEffects = user.fewerEffects || on("fewerFx");
    g.simpleTerrain = user.simpleTerrain || on("simpleTerrain");
    g.fpsCap30 = user.fpsCap30 || on("fps30");
    for (const r of RUNGS) state[r] = on(r);
    state.rung = off ? 0 : L.rung;
    state.active = !off && L.active();
}

// once per drawn frame; work = ms the frame took to draw
export function frame(now, work) {
    const dt = lastAt ? now - lastAt : 0;
    lastAt = now;
    if (window.dwFrameLog) window.dwFrameLog.push(now, work);   // QA: drawn frames, not rAF ticks
    if (off || !user || !global.gameStart || document.hidden) { if (ladder) ladder.pause(now); playing = false; return; }
    // the sky drop's dive is a second or two of a wide view: not counted
    if (global.dropZoom !== undefined && global.dropZoom !== 1) { if (ladder) ladder.pause(now); return; }
    const L = ensure();
    // the first seconds of a life hitch anyway (drop-in, shader warm-up)
    if (!playing) { playing = true; L.changedAt = now; }
    // software WebGL is only known once the rock shader is up
    if (!softSeen && softGpu()) {
        softSeen = true;
        if (L.rung < 3) { L.rung = 3; changed(1); return; }
    }
    const step = L.frame(now, dt, work, !!config.graphical.fpsCap30);
    if (step) changed(step);
}

function changed(step) {
    put();
    store.set("dwAutoQ", String(ladder.rung));
    if (step > 0 && state.active && !store.get("dwAutoQTold")) {
        store.set("dwAutoQTold", "1");
        try { toast && toast("Effects were turned down to keep the game smooth. You can change this in Settings."); } catch (e) { }
    }
}

// the automatic resolution waits its turn: last rung reached, or frames so
// slow that only fewer pixels will do
export function resolutionTurn(emaMs) {
    return off || !ladder || ladder.exhausted() || emaMs > 60;
}

// QA: dwAutoQ() reports, dwAutoQ(n) jumps to rung n, dwAutoQ(false) turns
// the trim off for this page (true back on)
window.dwAutoQ = (v) => {
    const L = ensure();
    if (v === false || v === true) off = !v;
    else if (typeof v === "number") { L.rung = Math.max(0, Math.min(RUNGS.length, v | 0)); L.changedAt = performance.now(); }
    put();
    return { off, rung: L.rung, on: RUNGS.filter(r => state[r]), skip: [...L.skip], ema: +L.ema.toFixed(1), work: +L.work.toFixed(1), exhausted: L.exhausted() };
};
