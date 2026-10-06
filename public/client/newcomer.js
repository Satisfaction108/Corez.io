// The first raids, client side: a HUD that grows with the player, the
// director's moments, one goal line and the first-time intros. The rules are
// in newcomerLogic.js (tested in scripts/test/newcomerHud.test.js).
//
//   stage      royale.you.nx from the server: 0 first raid, 1 second, 2 third,
//              3 veteran. Missing = 3, so a veteran sees exactly today's HUD.
//              window.dwForceNx(n) forces one for QA (dwForceNx(null) clears).
//   pieces     app.js asks shows(piece) before drawing the standings, feed,
//              contracts, boss/Core cards, kit, shop panel and the rest.
//   goal line  stage 0: one line in the note stack under the clock, in step
//              with the coach (dig and bank, upgrade, the storm).
//   intros     stages 1-2: a one-line NEW note the first time a shop, an
//              ability, the kit, a boss, a contract, a bounty or the Core shows.
//              The raid perks line shows from stage 0, with the first offer.
//   director   royale.you.nxEvent {kind, x, y, until | left, t, sub, done, r,
//              id}: an arrival banner in the slam lane (one at a time), an
//              arrow to the spot, a countdown note for a timed one, and a
//              payoff when it's done. Unknown kinds: their text, or just the
//              arrow.
//
// app.js: init(helpers), tick() at the top of the GUI pass, hudNotes(push)
// inside the note stack, worldMarks() with the edge markers, deathInfo() for
// the death card. coach.js reads global.nxStage / nxKnown / nxBannerUp.
import { global } from "./global.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";
import * as juice from "./juice.js";
import * as coach from "./coach.js";
import * as L from "./newcomerLogic.js";
import * as raidPerks from "./raidPerks.js";

let A = null;
export function init(helpers) { A = helpers; }

const FORCE_KEY = "dwForceNx";
const SEEN_KEY = "dwNxSeen_v1";
const INTRO_MS = 7000;
const VAULT_MIN = 15;
const GOLD = "#f2b83c", EMERALD = "#3fcf7a", TEAL = "#5ce0d8", INK = "#120e15";
const TAU = Math.PI * 2;

const S = {
    nx: null,            // last nx the server sent (sticky: a packet without `you` keeps it)
    forced: null,
    stage: L.VETERAN,
    known: false,
    seen: null,
    intro: null,         // { id, text, until }
    introQ: [],
    introAt: 0,
    cur: null,           // the director moment on now
    slam: null,          // its banner (a juice slam), while queued or up
    slamTitle: "",
    lastKey: "",
    upNote: null,        // { text, until } after a timed one runs out
    tickSec: -1,
    qaEv: null,          // dwNxMoment(): a moment put up by hand
    qaAt: 0,
    goal: null,
    vaultAng: NaN,
    vaultAt: 0,
};
try { const f = sessionStorage.getItem(FORCE_KEY); if (f != null && f !== "") S.forced = +f; } catch (e) { /* */ }

const now = () => performance.now();
function seen() {
    if (!S.seen) {
        try { S.seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch (e) { S.seen = {}; }
    }
    return S.seen;
}
function markSeen(id) {
    seen()[id] = 1;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(S.seen)); } catch (e) { /* */ }
}

// ── stage ──────────────────────────────────────────────────────────────
export function stage() { return S.stage; }
export function known() { return S.known; }
export function shows(piece, opts) { return L.shows(piece, S.stage, opts); }
export function toastAllowed(text) { return L.toastAllowed(text, S.stage); }
export function calloutAllowed(kind) { return L.calloutAllowed(kind, S.stage); }
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

// The shop panel on stage 0 waits for the coach's ability step (or for the
// guide to be over).
export function shopOpen() {
    if (S.stage !== 0) return true;
    if (!coach.active()) return true;
    return coach.stepId() === "ability";
}

// ── per frame (top of the GUI pass) ────────────────────────────────────
export function tick() {
    refreshStage();
    if (!inRaid() || S.stage >= L.VETERAN) {
        global.nxBannerUp = false;
        if (S.cur) S.cur = null;
        return;
    }
    const t = now();
    director(t);
    intros(t);
    global.nxBannerUp = bannerUp();
}

// ── director moments ───────────────────────────────────────────────────
function bannerUp() {
    const s = S.slam;
    if (!s) return false;
    if (s.on && s.text === S.slamTitle) return true;
    S.slam = null;
    return false;
}
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
        // the server says how it ended; without a state, gone early while
        // you were on it (or right after using the trial) counts as done
        const told = end || L.endState(cur.ev);
        const left = cur.leftWas;
        const done = !global.died && (told ? told === "done" :
            left > 400 && (cur.wasNear || (cur.kind === "ability" && cur.used)));
        if (done && !cur.paid) payoff(cur, left);
        // (the server says "out of time" itself when it sends a state)
        else if (cur.kind === "timed" && !told) S.upNote = { text: "Time's up. Another one soon.", until: t + 3200 };
        S.cur = null;
        if (end) { S.lastKey = key; return; }
    }
    if (!live) return;
    if (!S.cur) {
        if (key === S.lastKey) return;
        // already over by the time we saw it: nothing to announce
        if (L.endState(live)) { S.lastKey = key; return; }
        // a big card holds the middle (the unlock card, the sky drop): the
        // banner waits for it
        if (global.died || global._nxCardWas) return;
        S.lastKey = key;
        const q0 = me();
        const dist = isFinite(num(live.x)) && isFinite(num(live.y)) && q0 ? Math.hypot(num(live.x) - q0.x, num(live.y) - q0.y) : NaN;
        const b = L.bannerFor(live, { ability: abilityName(live), key: keyLabel("KEY_ABILITY", "Q"), touch: !!global.mobile, dist });
        S.cur = { key, ev: live, rAt, kind: b.kind, b, at: t, wasNear: false, used: false, leftWas: L.leftMs(live, rAt, t, Date.now()),
            abAt: global.abilityUsedAt || 0, kitAt: global.kitUsedAt || 0 };
        if (b.title) {
            S.slamTitle = b.title;
            S.slam = juice.slam(b.title, b.sub, b.col, 3400, 46);
            try { if (gameSound.dustBank) gameSound.dustBank(); } catch (e) { /* */ }
            if (isFinite(num(live.x)) && isFinite(num(live.y)) && b.kind !== "ability") juice.ring(num(live.x), num(live.y), b.col, 30, 260, 900, 8);
        }
        return;
    }
    // still on: follow its numbers, note when you get there or use it
    const c = S.cur;
    c.ev = live; c.rAt = rAt;
    c.leftWas = L.leftMs(live, rAt, t, Date.now());
    if (isFinite(num(live.x)) && isFinite(num(live.y)) && near(num(live.x), num(live.y), 520)) c.wasNear = true;
    if ((global.abilityUsedAt || 0) !== c.abAt || (global.kitUsedAt || 0) !== c.kitAt) c.used = true;
    // the trial's payoff is the first go with it, not its end
    if (c.kind === "ability" && c.used && !c.paid) { c.paid = true; payoff(c, 0); }
    if (c.kind === "timed") {
        const left = L.leftMs(live, rAt, t, Date.now());
        const sec = Math.ceil(left / 1000);
        if (sec !== S.tickSec && sec > 0 && sec <= 5) { try { if (gameSound.uiClick) gameSound.uiClick(); } catch (e) { /* */ } }
        S.tickSec = sec;
    }
}
function payoff(cur, left) {
    const p = L.payoffFor(cur.ev, left);
    // a banner too: the coach waits for it
    S.slamTitle = p.title;
    S.slam = juice.slam(p.title, p.sub, EMERALD, 2200, 50);
    const q = me();
    juice.ring(q.x, q.y, GOLD, 30, 300, 700, 10);
    juice.ring(q.x, q.y, "#ffffff", 20, 200, 450, 14);
    juice.sparks(q.x, q.y, 34, 300, 1300, 4, null, TAU, 0, 6);
    juice.lightLeak("242,184,60", 1100);
    juice.shake(16, 260);
    try { if (gameSound.bankCelebrate) gameSound.bankCelebrate(); } catch (e) { /* */ }
}

// ── first-time intros ──────────────────────────────────────────────────
function introTriggers() {
    const r = global.royale || {};
    const sh = global.shop || {};
    const out = [];
    if (sh.onPad || nearestShopNear()) out.push("shop");
    if (ownsAbility()) out.push("ability");
    if (ownsKit()) out.push("kit");
    if (r.boss && (S.stage >= 2 || bossNear())) out.push("boss");
    if (r.you && r.you.obj && r.you.obj.st === 0) out.push("contract");
    if (r.bounty) out.push("bounty");
    if (r.core && r.core.s === "up") out.push("core");
    if (r.you && r.you.hunt && (r.you.hunt.l | 0) > 0) out.push("hunted");
    if (r.mod && r.mod.name) out.push("twist");
    if (raidPerks.offerUp()) out.push("perks");
    return out;
}
function nearestShopNear() {
    for (const s of global.shops || []) if (s && isFinite(s.x) && near(s.x, s.y, 650)) return true;
    return false;
}
function intros(t) {
    if (S.intro && t > S.intro.until) S.intro = null;
    // the first raid only gets the perks line (INTROS says which stage each starts at)
    if (global.died) return;
    if (t - S.introAt < 250) return;
    S.introAt = t;
    // the one-time ability tour already covers the dash, ability and shop
    const tour = !!global.abilityIntroOn || abilityTourDone();
    const keys = { ability: keyLabel("KEY_ABILITY", "Q"), kit: L.kitKeysText([keyLabel("KEY_KIT_1", "Z"), keyLabel("KEY_KIT_2", ","), keyLabel("KEY_KIT_3", "N")]), touch: !!global.mobile };
    // the start of raid 2 and raid 3: one quiet line about what just opened up
    const unlock = "unlock" + S.stage;
    if (S.known && S.stage >= 1 && S.stage < L.VETERAN && !seen()[unlock] && !S.introQ.some(q => q.id === unlock) && !(S.intro && S.intro.id === unlock)) {
        const text = S.stage === 1 ? "Shops, abilities and kits are open to you now."
            : "Bosses, contracts, bounties and the Core are in play now.";
        S.introQ.unshift({ id: unlock, text });
    }
    for (const id of introTriggers()) {
        if (tour && (id === "ability" || id === "shop")) continue;
        if (S.introQ.some(q => q.id === id) || (S.intro && S.intro.id === id)) continue;
        const text = L.introText(id, S.stage, seen(), keys);
        if (text) S.introQ.push({ id, text });
    }
    if (!S.intro && S.introQ.length && !bannerUp()) {
        const q = S.introQ.shift();
        markSeen(q.id);
        S.intro = { id: q.id, text: q.text, until: t + INTRO_MS, at: t };
        try { if (gameSound.uiClick) gameSound.uiClick(); } catch (e) { /* */ }
    }
}
function abilityTourDone() {
    try { return localStorage.getItem("dwAbilityIntro_v1") === "1"; } catch (e) { return false; }
}

// ── the note stack (app.js drawHudNotes) ───────────────────────────────
// mk(pri, key, text, col) is app.js hudNote; the custom ones carry .draw
function canUpgrade() {
    if ((gui.upgrades || []).length) return true;
    return (gui.points | 0) > 0 && (gui.skills || []).some(s => s && s.softcap > 0 && s.amount < s.cap);
}
export function goal() {
    const r = global.royale || {};
    const step = coach.active() ? coach.stepId() : "";
    return L.goalFor({ coachStep: step, bankedRaid: r.you ? r.you.banked | 0 : 0, canUpgrade: canUpgrade() });
}
export function hudNotes(push, mk) {
    if (!inRaid() || global.died || S.stage >= L.VETERAN) return;
    const t = now();
    const c = S.cur;
    if (c && c.kind === "timed") {
        const left = L.leftMs(c.ev, c.rAt, t, Date.now());
        if (isFinite(left)) {
            const prog = L.progressText(c.ev);
            const n = mk(0, "nxtimer", c.b.title + (prog ? "  \u00b7  " + prog : ""), c.b.col);
            n.sub = L.clock(left);
            n.pulse = left < 5500 ? 1 - (t / 1000) % 1 : 0;
            n.draw = drawTimer;
            push(n);
        }
    }
    if (S.upNote && t < S.upNote.until) push(mk(1, "nxup", S.upNote.text, "#d8dce6"));
    if (S.intro) {
        const n = mk(1, "nxintro", S.intro.text, "#f2eef8");
        n.draw = drawIntro;
        n.age = t - S.intro.at;
        push(n);
    }
    // a timed job up top says what to do; the goal line waits for it
    if (L.shows("goalLine", S.stage) && !(c && c.kind === "timed")) {
        const g = goal();
        S.goal = g;
        const n = mk(1.5, "nxgoal", g.text, "#f2eef8");
        n.draw = drawGoal;
        n.arrow = g.arrow;
        push(n);
    }
    const sh = global.shop;
    if (sh && sh.onPad && !sh.dismissed && !shopOpen()) push(mk(2, "nxshop", "The shop opens up soon. Dig and bank first.", "#d8dce6"));
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
// the goal: a gold chip with an arrow toward the nearest vault (or a target
// ring), then the line
function drawGoal(c, n, cx, y, maxW) {
    const H = A.NOTE_H + 4;
    const txt = n.text;
    const fs = fitSize(txt, 13.5, maxW - 56);
    const tw = textW(txt, fs);
    const w = tw + 52, x = Math.round(cx - w / 2);
    A.hudPanel(c, x, y, w, H, { r: H / 2, lw: 2.5, lip: 2.5, bevel: false });
    const gx = x + 17, gy = y + H / 2;
    c.save();
    c.beginPath(); c.arc(gx, gy, 9, 0, TAU);
    c.fillStyle = GOLD; c.fill();
    c.lineWidth = 2; c.strokeStyle = INK; c.stroke();
    const ang = n.arrow === "vault" ? vaultAngle() : NaN;
    if (isFinite(ang)) {
        c.translate(gx, gy); c.rotate(ang);
        c.beginPath(); c.moveTo(5.5, 0); c.lineTo(-3.5, -4.5); c.lineTo(-1.5, 0); c.lineTo(-3.5, 4.5); c.closePath();
        c.fillStyle = INK; c.fill();
    } else {
        c.beginPath(); c.arc(gx, gy, 3.2, 0, TAU);
        c.fillStyle = INK; c.fill();
    }
    c.restore();
    // the arrow in the text in gold
    const shown = txt.indexOf("→") > 0 ? txt.replace("→", "§" + GOLD + "§→§reset§") : txt;
    A.drawText(shown, x + 33 + tw / 2, y + H / 2, fs, "#f2eef8", "center", true);
    return y + H + A.NOTE_GAP;
}
function vaultAngle() {
    const t = now();
    if (t - S.vaultAt < 200) return S.vaultAng;
    S.vaultAt = t;
    const p = me(), s = global.royale && global.royale.storm;
    let best = null, bs = Infinity;
    for (const v of global.vaults || []) {
        if (!v || !isFinite(v.x) || !isFinite(v.y)) continue;
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        const out = s && s.a && s.r > 0 && Math.hypot(v.x - (s.cx || 0), v.y - (s.cy || 0)) > s.r ? 1e6 : 0;
        if (d + out < bs) { bs = d + out; best = v; }
    }
    S.vaultAng = best && bs > 160 ? Math.atan2(best.y - p.y, best.x - p.x) : NaN;
    return S.vaultAng;
}
// a timed challenge: the clock in a gold chip, then what to do
function drawTimer(c, n, cx, y, maxW) {
    const H = A.NOTE_H;
    const cw = titleW(n.sub, 13) + 16;
    const fs = fitSize(n.text, 12.5, maxW - cw - 28);
    const tw = textW(n.text, fs);
    const w = cw + tw + 30, x = Math.round(cx - w / 2);
    const a = n.pulse ? 0.75 + 0.25 * n.pulse : 1;
    A.hudPanel(c, x, y, w, H, { r: H / 2, lw: 2.5, lip: 2.5, bevel: false, alpha: a });
    c.save();
    c.globalAlpha = a;
    rr(c, x + 4, y + 4, cw, H - 8, (H - 8) / 2);
    c.fillStyle = n.pulse ? "#ff6b5e" : n.col; c.fill();
    c.restore();
    // dark on the chip, no outline (an outlined dark title blurs)
    A.drawText(n.sub, x + 4 + cw / 2, y + H / 2 + 0.5, 13, INK, "center", true, a, false);
    A.drawText(n.text, x + cw + 12 + tw / 2, y + H / 2, fs, "#f2eef8", "center", true, a);
    return y + H + A.NOTE_GAP;
}
// a first-time intro: a small NEW tag, then the line; slides in, fades out
function drawIntro(c, n, cx, y, maxW) {
    const H = A.NOTE_H;
    const TAG = "NEW FEATURE";
    const tagW = titleW(TAG, 10) + 14;
    const fs = fitSize(n.text, 12.5, maxW - tagW - 30);
    const tw = textW(n.text, fs);
    const w = tagW + tw + 30, x = Math.round(cx - w / 2);
    const inT = Math.min(1, (n.age || 0) / 220), outT = Math.min(1, (INTRO_MS - (n.age || 0)) / 500);
    const a = Math.max(0, inT * outT);
    A.hudPanel(c, x, y, w, H, { r: H / 2, lw: 2.5, lip: 2.5, bevel: false, alpha: a });
    c.save();
    c.globalAlpha = a;
    rr(c, x + 5, y + 5, tagW, H - 10, (H - 10) / 2);
    c.fillStyle = TEAL; c.fill();
    c.restore();
    A.drawText(TAG, x + 5 + tagW / 2, y + H / 2 + 0.5, 10, INK, "center", true, a, false);
    A.drawText(n.text, x + tagW + 14 + tw / 2, y + H / 2, fs, "#f2eef8", "center", true, a);
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
        tip: L.DEATH_TIPS[kind],
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
    goal: S.goal ? S.goal.text : "",
    moment: S.cur ? { kind: S.cur.kind, title: S.cur.b.title, near: S.cur.wasNear } : null,
    banner: bannerUp(), intro: S.intro ? S.intro.text : "", queued: S.introQ.map(q => q.id), seen: Object.keys(seen()),
});
// QA: put a director moment up without the server (stages 0-2), e.g.
// dwNxMoment({ kind: "timed", t: "Mine 5 rocks", left: 30000, x, y }); the
// same object with done: 1 plays the payoff; dwNxMoment(null) takes it down
window.dwNxMoment = (ev) => {
    S.qaEv = ev || null;
    S.qaAt = now();
    return S.qaEv ? L.eventKey(S.qaEv) : "";
};
