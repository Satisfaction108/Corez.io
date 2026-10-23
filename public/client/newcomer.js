// The first raids, client side: a HUD that grows with the player, the
// director's moments, one goal line and the first-time intros. The rules are
// in newcomerLogic.js (tested in scripts/test/newcomerHud.test.js).
//
//   stage      royale.you.nx from the server: 0 first raid, 1 second, 2 third,
//              3 veteran. Missing = 3, so a veteran sees exactly today's HUD.
//              window.dwForceNx(n) forces one for QA (dwForceNx(null) clears).
//   pieces     app.js asks shows(piece) before drawing the standings, feed,
//              contracts, boss/Core cards, kit, shop panel and the rest.
//
// app.js: init(helpers), tick() at the top of the GUI pass, hudNotes(push)
// inside the note stack, worldMarks() with the edge markers, deathInfo() for
// the death card. coach.js reads global.nxStage / nxKnown / nxBannerUp.
import { global } from "./global.js";
import { gameSound } from "./sound.js";
import * as juice from "./juice.js";
import * as L from "./newcomerLogic.js";
import { baseDeathTip } from "./teamWar.js";

let A = null;
export function init(helpers) { A = helpers; }

const FORCE_KEY = "dwForceNx";
const GOLD = "#f2b83c", INK = "#120e15";
const TAU = Math.PI * 2;

const S = {
    nx: null,            // last nx the server sent (sticky: a packet without `you` keeps it)
    forced: null,
    stage: L.VETERAN,
    known: false,
    cur: null,           // the director moment on now
    lastKey: "",
    tickSec: -1,
    qaEv: null,          // dwNxMoment(): a moment put up by hand
    qaAt: 0,
};
try { const f = sessionStorage.getItem(FORCE_KEY); if (f != null && f !== "") S.forced = +f; } catch (e) { /* */ }

const now = () => performance.now();

// ── stage ──────────────────────────────────────────────────────────────
export function stage() { return S.stage; }
export function known() { return S.known; }
export function shows(piece, opts) { return L.shows(piece, S.stage, opts); }
export function toastAllowed(text) { return L.toastAllowed(text, S.stage); }
export function calloutAllowed(kind) { return L.calloutAllowed(kind, S.stage); }
export function plateWanted(kind, text) { return L.plateWanted(kind, text); }
export function feedAllowed(f, myName) { return L.feedAllowed(f, S.stage, myName); }
function refreshStage() {
    const r = global.royale;
    const you = r && r.you;
    if (you && you.nx != null && isFinite(+you.nx)) S.nx = +you.nx;
    S.stage = L.effectiveStage(S.nx, S.forced);
    S.known = S.forced != null || S.nx != null;
    global.nxStage = S.stage;
    global.nxKnown = S.known;
}
refreshStage();

function inRaid() {
    const r = global.royale;
    return !!(global.gameStart && !global.tutorialMode && global.digRoyaleMode && r && r.at > 0 && !global.disconnected);
}
function me() { return { x: global.player.renderx, y: global.player.rendery }; }
// a coordinate, or NaN when it's missing (the server sends null for a trial)
const num = v => v == null || v === "" ? NaN : +v;
function near(x, y, d) { const p = me(); return Math.hypot(x - p.x, y - p.y) < d; }
// the boss / Core is right there: its card shows on any stage
export function bossNear() {
    const b = global.royale && global.royale.boss;
    return !!(b && isFinite(b.x) && near(b.x, b.y, 1500));
}
export function coreNear() {
    const c = global.royale && global.royale.core;
    return !!(c && isFinite(c.x) && near(c.x, c.y, 1500));
}
export function ownsAbility() { return !!(global.abil && global.abil.on && global.abil.eq); }
export function ownsKit() { return !!((global.shop && global.shop.state && global.shop.state.kitOrder) || []).filter(Boolean).length; }

export function shopOpen() { return true; }

// ── per frame (top of the GUI pass) ────────────────────────────────────
export function tick() {
    refreshStage();
    if (!inRaid() || S.stage >= L.VETERAN) {
        global.nxBannerUp = false;
        if (S.cur) S.cur = null;
        return;
    }
    global.nxBannerUp = false;
    director(now());
}

// ── director moments ───────────────────────────────────────────────────
function keyLabel(id, d) { try { return A && A.keyLabel ? A.keyLabel(id, d) : d; } catch (e) { return d; } }
function abilityName(ev) {
    const cat = (global.shop && global.shop.catalog) || [];
    const id = ev.item || ev.id_item || ev.ab || (global.abil && (global.abil.trialId || global.abil.eq));
    const it = id ? cat.find(i => i.id === id) : null;
    return it ? it.name : (typeof ev.name === "string" ? ev.name : "");
}
function director(t) {
    const r = global.royale;
    const ev = S.qaEv || (r && r.you && r.you.nxEvent) || null;
    const live = ev && typeof ev === "object" && L.shows("directorMoments", S.stage) ? ev : null;
    const rAt = S.qaEv ? S.qaAt : r.at;
    const key = live ? L.eventKey(live) : "";
    const cur = S.cur;
    const end = live && key === (cur && cur.key) ? L.endState(live) : "";
    if (cur && (key !== cur.key || end)) {
        const told = end || L.endState(cur.ev);
        const left = cur.leftWas;
        const done = !global.died && (told ? told === "done" :
            left > 400 && (cur.wasNear || (cur.kind === "ability" && cur.used)));
        if (done && !cur.paid) payoff();
        S.cur = null;
        if (end) { S.lastKey = key; return; }
    }
    if (!live) return;
    if (!S.cur) {
        if (key === S.lastKey) return;
        if (L.endState(live)) { S.lastKey = key; return; }
        if (global.died || global._nxCardWas) return;
        S.lastKey = key;
        const q0 = me();
        const dist = isFinite(num(live.x)) && isFinite(num(live.y)) && q0 ? Math.hypot(num(live.x) - q0.x, num(live.y) - q0.y) : NaN;
        const b = L.bannerFor(live, { ability: abilityName(live), key: keyLabel("KEY_ABILITY", "Q"), touch: !!global.mobile, dist });
        S.cur = { key, ev: live, rAt, kind: b.kind, b, at: t, wasNear: false, used: false, leftWas: L.leftMs(live, rAt, t, Date.now()),
            abAt: global.abilityUsedAt || 0, kitAt: global.kitUsedAt || 0 };
        try { if (gameSound.dustBank) gameSound.dustBank(); } catch (e) { void e; }
        if (isFinite(num(live.x)) && isFinite(num(live.y)) && b.kind !== "ability") juice.ring(num(live.x), num(live.y), b.col, 30, 260, 900, 8);
        return;
    }
    const c = S.cur;
    c.ev = live; c.rAt = rAt;
    c.leftWas = L.leftMs(live, rAt, t, Date.now());
    if (isFinite(num(live.x)) && isFinite(num(live.y)) && near(num(live.x), num(live.y), 520)) c.wasNear = true;
    if ((global.abilityUsedAt || 0) !== c.abAt || (global.kitUsedAt || 0) !== c.kitAt) c.used = true;
    if (c.kind === "ability" && c.used && !c.paid) { c.paid = true; payoff(); }
    if (c.kind === "timed") {
        const left = L.leftMs(live, rAt, t, Date.now());
        const sec = Math.ceil(left / 1000);
        if (sec !== S.tickSec && sec > 0 && sec <= 5) { try { if (gameSound.uiClick) gameSound.uiClick(); } catch (e) { /* */ } }
        S.tickSec = sec;
    }
}
function payoff() {
    const q = me();
    juice.ring(q.x, q.y, GOLD, 30, 300, 700, 10);
    juice.ring(q.x, q.y, "#ffffff", 20, 200, 450, 14);
    juice.sparks(q.x, q.y, 34, 300, 1300, 4, null, TAU, 0, 6);
    juice.lightLeak("242,184,60", 1100);
    juice.shake(16, 260);
    try { if (gameSound.bankCelebrate) gameSound.bankCelebrate(); } catch (e) { /* */ }
}

// ── the note stack (app.js drawHudNotes) ───────────────────────────────
export function hudNotes(push, mk) {
    if (!inRaid() || global.died || S.stage >= L.VETERAN) return;
    const t = now();
    const c = S.cur;
    if (c && c.kind === "timed") {
        const left = L.leftMs(c.ev, c.rAt, t, Date.now());
        if (isFinite(left)) {
            const prog = L.progressText(c.ev);
            const n = mk(0, "nxtimer", c.b.title + (prog ? "  ·  " + prog : ""), c.b.col);
            n.sub = L.clock(left);
            n.pulse = left < 5500 ? 1 - (t / 1000) % 1 : 0;
            n.draw = drawTimer;
            push(n);
        }
    }
}
const wCache = new Map();
function textW(text, size) {
    const k = size + "|" + text;
    let w = wCache.get(k);
    if (w === undefined) {
        w = A.hudTextW(text, size);
        if (wCache.size > 80) wCache.clear();
        wCache.set(k, w);
    }
    return w;
}
function titleW(text, size) {
    const k = "T" + size + "|" + text;
    let w = wCache.get(k);
    if (w === undefined) {
        w = A.hudTitleW(text, size);
        if (wCache.size > 80) wCache.clear();
        wCache.set(k, w);
    }
    return w;
}
function fitSize(text, size, room) {
    let s = size;
    while (s > 9.5 && textW(text, s) > room) s -= 0.5;
    return s;
}
function drawTimer(c, n, cx, y, maxW) {
    const H = A.NOTE_H;
    const cw = titleW(n.sub, 13) + 16;
    const fs = fitSize(n.text, 12.5, maxW - cw - 28);
    const tw = textW(n.text, fs);
    const w = cw + tw + 30, x = Math.round(cx - w / 2);
    const a = n.pulse ? 0.75 + 0.25 * n.pulse : 1;
    A.hudPanel(c, x, y, w, H, { r: H / 2, alpha: a });
    c.save();
    c.globalAlpha = a;
    rr(c, x + 4, y + 4, cw, H - 8, (H - 8) / 2);
    c.fillStyle = n.pulse ? "#ff6b5e" : n.col; c.fill();
    c.restore();
    A.drawText(n.sub, x + 4 + cw / 2, y + H / 2 + 0.5, 13, INK, "center", true, a, false);
    A.drawText(n.text, x + cw + 12 + tw / 2, y + H / 2, fs, "#ffffff", "center", true, a);
    return y + H + A.NOTE_GAP;
}
function rr(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
}

// ── the arrow to a moment (app.js drawRoyaleWorldMarkers) ──────────────
// Off screen: an edge marker with the others. On screen: a ring and a
// bobbing arrow on the spot. A supply crate already has its own marker.
export function worldMarks(marks, toScreen, onScreen, p, c, ratio) {
    const cur = S.cur;
    if (!cur || !cur.b.mark || global.died) return;
    const ev = cur.ev;
    const x = num(ev.x), y = num(ev.y);
    if (!isFinite(x) || !isFinite(y)) return;
    const sup = global.royale && global.royale.supply;
    if (cur.kind === "crate" && sup && Math.hypot(sup.x - x, sup.y - y) < 400) return;
    const s = toScreen(x, y);
    const d = Math.hypot(x - p.x, y - p.y);
    if (!onScreen(s, -40)) { marks.push({ pri: -2, s, col: cur.b.col, glyph: cur.kind === "timed" ? "contract" : "gem", name: cur.b.mark, d }); return; }
    if (d < 140) return;
    const t = now();
    const R = Math.max(26, (+ev.r || 110) * ratio);
    c.save();
    c.lineCap = "round"; c.lineJoin = "round";
    c.setLineDash([14, 10]);
    c.lineDashOffset = -t / 28;
    c.beginPath(); c.arc(s.x, s.y, R + 3 * Math.sin(t / 320), 0, TAU);
    c.lineWidth = 7; c.strokeStyle = INK; c.stroke();
    c.lineWidth = 4; c.strokeStyle = cur.b.col; c.stroke();
    c.setLineDash([]);
    c.translate(s.x, s.y - R - 22 + Math.sin(t / 240) * 6);
    c.beginPath();
    c.moveTo(0, 13); c.lineTo(13, -3); c.lineTo(5, -3); c.lineTo(5, -15);
    c.lineTo(-5, -15); c.lineTo(-5, -3); c.lineTo(-13, -3);
    c.closePath();
    c.lineWidth = 6; c.strokeStyle = INK; c.stroke();
    c.fillStyle = cur.b.col; c.fill();
    c.restore();
}

// ── the death card (app.js, stages 0 and 1) ────────────────────────────
export function deathCardWanted() { return S.stage <= 1; }
export function deathInfo() {
    const r = global.royale || {};
    const you = r.you || {};
    const board = r.board || [];
    const boss = r.boss || global._lastBoss;
    const d = {
        cause: global.finalCause || "",
        killers: global.finalKillers || [],
        isBot: (name) => board.some(row => row && row.name === name && row.bot),
        bossName: boss && boss.name ? String(boss.name) : "",
    };
    const kind = L.deathKind(d);
    return {
        kind,
        tip: kind === "base" ? baseDeathTip(L.DEATH_TIPS[kind]) : L.DEATH_TIPS[kind],
        kept: L.keptLine({
            banked: you.banked != null ? you.banked : global.finalBanked,
            carried: global.finalCarried,
            // insurance, and the half of a first death's satchel the server
            // keeps back for the respawn (m[18 + killers])
            kept: (global.finalInsured | 0) + (global.finalNxKept | 0),
        }),
    };
}

// ── QA ─────────────────────────────────────────────────────────────────
window.dwForceNx = (n) => {
    S.forced = n == null || n === "" ? null : Math.max(0, Math.min(L.VETERAN, n | 0));
    try { if (S.forced == null) sessionStorage.removeItem(FORCE_KEY); else sessionStorage.setItem(FORCE_KEY, String(S.forced)); } catch (e) { /* */ }
    refreshStage();
    return S.stage;
};
window.dwNx = () => ({
    stage: S.stage, known: S.known, server: S.nx, forced: S.forced,
    shows: L.stageTable(S.stage),
    moment: S.cur ? { kind: S.cur.kind, title: S.cur.b.title, near: S.cur.wasNear } : null,
});
// QA: put a director moment up without the server (stages 0-2), e.g.
// dwNxMoment({ kind: "timed", t: "Mine 5 rocks", left: 30000, x, y }); the
// same object with done: 1 plays the payoff; dwNxMoment(null) takes it down
window.dwNxMoment = (ev) => {
    S.qaEv = ev || null;
    S.qaAt = now();
    return S.qaEv ? L.eventKey(S.qaEv) : "";
};
