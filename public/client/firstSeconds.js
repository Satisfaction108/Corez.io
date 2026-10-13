// The first seconds of a raid (rules in firstSecondsLogic.js)
import { global } from "./global.js";
import { gui } from "./socketinit.js";
import * as juice from "./juice.js";
import * as skyDrop from "./skyDrop.js";
import * as coach from "./coach.js";
import * as raidFinale from "./raidFinale.js";
import { parts as scoreParts } from "./scoreLogic.js";
import * as L from "./firstSecondsLogic.js";
import * as aoHud from "./alwaysOn.js";

let A = null;
const S = {
    plan: null,        // this page's first life, until it plays out
    used: false,       // a plan was made on this page (only the first life gets one)
    alive: false,
    waitAt: 0,         // first frame of a game with no plan yet (slams wait)
    land: 0,           // performance.now() of the landing (0 until known)
    spawnAt: 0,
    relAt: 0,          // let go early (a hit) at
    age: -1,
    lines: null, linesAt: 0,
    raid: 0,           // the raid the last spawn was in (a new one gets a short card)
    lastRes: null,     // the last raid's results as RY had them, with your numbers
    recap: null,       // ...shown before FRESH START when its podium was missed
};
// RY results of a finished raid, with your place and points at the bell
function noteResults() {
    const r = global.royale;
    const res = r && r.results;
    if (!res || !(res.raidId > 0) || !Array.isArray(res.top)) return;
    // only while RY still describes the raid that ended
    if ((r.raidId | 0) > 0 && (r.raidId | 0) !== (res.raidId | 0)) return;
    if (S.lastRes && S.lastRes.raidId === res.raidId && S.lastRes._src === res && S.lastRes._you === r.you) return;
    const you = r.you || {};
    const pt = scoreParts(you);
    const w = res.champ || res.top[0] || null;
    S.lastRes = {
        raidId: res.raidId | 0, _src: res, _you: r.you,
        place: r.duos ? ((r.duo && r.duo.place) | 0) : ((you.place || r.place) | 0), rows: res.rows | 0,
        score: pt.total, b: pt.b, k: pt.k, c: pt.c,
        winner: w ? String(w.name || "Unnamed") : "", wScore: w ? w.score | 0 : 0,
        top: res.top.slice(0, 3).map(t => ({ name: t.name, score: t.score | 0 })),
    };
}
const ORE = ["#eda766", "#7fb1f2", "#d98af0", "#6ff5a8"];

function now() { return performance.now(); }
function inRaid() {
    return !!(global.gameStart && !global.tutorialMode && global.digRoyaleMode &&
        global.royale && global.royale.at > 0 && !global.disconnected);
}
function alive() {
    return inRaid() && !global.died && !global.royaleSpectating && !global.royaleDied && !global.raidQueued;
}
// new: the guide is on (or not decided yet), or the server says first raids
function isNew() {
    let on = false;
    try { on = coach.holding(); } catch (e) { /* */ }
    if (global.nxKnown) on = on || (global.nxStage | 0) <= 1;
    return on;
}
function released() { return S.relAt > 0; }
function raidNow() { const r = global.royale; return r ? (r.raidId | 0) || (r.matchId | 0) : 0; }
function myGuns() {
    try { return global.mockups[parseInt(String(gui.type).split("-")[0], 10)].guns.length | 0; }
    catch (e) { return 1; }
}

export function init(helpers) {
    A = helpers;
    juice.setIntroHold(slamHoldUntil);
    // canvas.js: Esc while the card is up lets it (and everything held) go
    global.introSkip = skip;
}
// let the card go now, as a hit does -> true when there was one to let go
export function skip() {
    if (!S.plan || released() || S.age < 0) return false;
    S.relAt = now();
    return true;
}

// Once a frame, before anything asks shows()
export function tick() {
    const t = now();
    const on = alive();
    const rid = raidNow();
    try { noteResults(); } catch (e) { /* */ }
    // a new raid on this page: back to Basic with fresh points (also when the raid
    const start = L.raidStartOf(global.royale, Date.now());
    // (the raid-clock check only at a spawn: a storm end that moves mid-life never counts)
    const newRaid = on && S.used && L.isNewRaid(S.raid, rid, S.alive ? 0 : S.raidStart, start);
    if (on && (!S.alive || newRaid)) {
        S.spawnAt = t;
        S.land = 0;
        S.falling = false;
        if (!S.used) {
            S.used = true;
            S.relAt = 0;
            S.plan = L.planFor({ newcomer: isNew(), tutorial: global.tutorialMode });
        } else if (newRaid && !global.tutorialMode) {
            S.relAt = 0;
            S.lines = null;
            // the last raid ended while you were down and its podium never got on screen: its
            const lr = S.lastRes;
            const missed = !!lr && lr.raidId === (S.raid | 0) && !raidFinale.sawResults(lr.raidId);
            S.recap = missed ? lr : null;
            S.plan = L.planFor({ newRaid: true, recap: missed, newcomer: isNew() });
        } else S.plan = null;
    }
    if (on && rid) S.raid = rid;
    if (on && start > 0) S.raidStart = start;
    S.alive = on;
    if (!on) {
        // died or left with things still held: let them all in
        if (S.plan && !released()) S.relAt = t;
        S.age = -1;
        publish();
        return;
    }
    if (S.plan) {
        // the landing: skyDrop knows it while the drop is in the air
        if (!S.land) {
            const la = skyDrop.landAt();
            if (la > t) S.falling = true;
            else if (S.falling || t - S.spawnAt > 450) S.land = t;
            // still deciding who's new while falling (the account can be late)
            if (!S.land && !S.plan.newRaid) S.plan = L.planFor({ newcomer: isNew() });
        }
        const p = S.plan;
        S.age = S.land ? t - S.land : -1;
        if (!released() && S.land && (global.hurtAt || 0) > S.land) S.relAt = t;
        // played out: forget it
        if (S.age > L.planEnd(p) + 500) S.plan = null;
    }
    publish();
}
function publish() {
    global.introHold = !shows("coach");
    // app.js platesWait: the centre plates ("Drop in!") wait for the card
    global.introCardUp = !!S.plan && S.age >= 0 && L.introAlpha(S.plan, S.age, released() ? now() - S.relAt : -1) > 0.01;
    // round 8: the plates (the raid's OVERRIDE popup, "Drop in!") wait from the join
    global.introWait = inRaid() && !global.tutorialMode &&
        ((!S.used && !global.died) || (!!S.plan && !released() && (S.age < 0 || S.age < S.plan.intro)));
}

// May app.js draw this piece now?
export function shows(piece) {
    if (!S.plan) return true;
    // touch keeps its chips (they are small and on the edge)
    if (global.mobile && (piece === "tiles" || piece === "stats")) return true;
    return L.shows(S.plan, S.age < 0 ? -1 : S.age, piece, released());
}
// juice.js: a slam waits for this (the free ability's slam goes after the card)
export function slamHoldUntil() {
    const t = now();
    // the raid's free ability arrives with the spawn, often before the first alive
    if (!S.used) {
        if (global.tutorialMode) return 0;
        if (!S.waitAt) S.waitAt = t;
        return t - S.waitAt < 10000 ? t + 400 : 0;
    }
    if (!S.plan || released()) return 0;
    if (!S.land) return t + 400;
    const w = L.waitFor(S.plan, S.age, "ability", false);
    return w > 0 ? t + w : 0;
}

// ── drawing (HUD layer, HUD units) ─────────────────────────────────────
function aoNextShort() {
    if (!aoHud.on()) return "";
    const p = aoHud.panelText();
    if (!p) return "";
    return p.live ? p.label + " is on now" : p.label + " " + p.value;
}
function lines(t) {
    if (S.lines && t - S.linesAt < 500) return S.lines;
    const r = global.royale || {};
    S.linesAt = t;
    const keys = A ? ["KEY_UP", "KEY_LEFT", "KEY_DOWN", "KEY_RIGHT"].map((k, i) => A.keyLabel(k, "WASD"[i])).join("") : "WASD";
    S.lines = L.introLines({
        mobile: !!global.mobile, keys,
        tanks: r.alive | 0, leftMs: (r.raidLeft | 0) * 1000,
        twist: r.mod && r.mod.name ? String(r.mod.name) : "",
        gunless: myGuns() === 0,
        newRaid: !global.aoWorld && !!(S.plan && S.plan.newRaid), points: gui.points | 0,
        ao: !!global.aoWorld, next: aoNextShort(),
        last: S.plan && S.plan.newRaid && S.lastRes && S.lastRes.raidId !== raidNow() ? S.lastRes : null,
    });
    return S.lines;
}
export function draw(c, lanes) {
    if (!A || !S.plan || S.age < 0 || global.showBigMap) return;
    const t = now();
    const relFor = released() ? t - S.relAt : -1;
    const ph = L.cardPhase(S.plan, S.age, relFor);
    if (ph.a > 0.01) drawCard(c, lanes, ph.a, t, ph.recap && S.recap ? L.recapLines(S.recap) : null);
    if (!global.mobile) drawNudges(c, t);
}
function drawCard(c, lanes, a, t, recap) {
    const H = A.HUD, W0 = global.screenWidth, H0 = global.screenHeight;
    const ln = recap || lines(t);
    const touch = !!global.mobile;
    const k = touch ? Math.min(1, W0 / 760) : 1;
    // Oct 8: compact, docked in the top lane right under the clock (it was a
    // 40-unit title card reaching down over the play area)
    const titleSz = 26 * k, goalSz = 13 * k, ctlSz = 11.5 * k;
    const w = Math.min(W0 - 40, Math.max(A.textW(ln.goal, goalSz) + 48, A.textW(ln.controls, ctlSz) + 48, ln.status ? A.textW(ln.status, ctlSz) + 48 : 0, A.titleW(ln.title, titleSz) + 130 * k));
    const h = (ln.status ? 118 : 98) * k;
    const top = lanes && lanes.top ? lanes.top + 6 : H0 * 0.12;
    const rise = (1 - Math.min(1, S.age / 300)) * 8;
    const x = Math.round(W0 / 2 - w / 2), y = Math.round(top + rise);
    const cx = W0 / 2;
    A.panel(c, x, y, w, h, { fill: H.solid, r: H.rBig, alpha: a });
    A.title(ln.eyebrow, cx, y + 15 * k, 10.5 * k, H.lilac, "center", a);
    A.title(ln.title, cx, y + 38 * k, titleSz, H.gold, "center", a);
    // two gems either side of the title, the four ore colours
    const tw = A.titleW(ln.title, titleSz) / 2;
    c.save();
    c.globalAlpha = a;
    for (let i = 0; i < 4; i++) {
        const side = i < 2 ? -1 : 1, j = i % 2;
        const gx = cx + side * (tw + 18 * k + j * 20 * k), gy = y + 38 * k + Math.sin(t / 260 + i) * 2;
        A.gemPath(c, gx, gy, (j ? 6 : 8) * k);
        c.fillStyle = ORE[i]; c.fill();
        c.lineWidth = 2; c.strokeStyle = H.ink; c.stroke();
    }
    c.restore();
    A.text(ln.goal, cx, y + 64 * k, goalSz, H.head, "center", a);
    A.text(ln.controls, cx, y + 83 * k, ctlSz, H.text2, "center", a);
    if (ln.status) A.text(ln.status, cx, y + 102 * k, ctlSz, H.gold, "center", a);
    // it can go early (desktop: Esc
    if (!touch && !released()) A.text("Esc to close", x + w - 12, y + 14, 9, H.text2, "right", a * 0.7);
}
function drawNudges(c, t) {
    for (const piece of ["tiles", "stats"]) {
        const a = L.nudgeAlpha(S.plan, S.age, piece, released());
        if (a < 0.02) continue;
        const r = piece === "tiles" ? A.rect("upgrades") : A.statRect();
        if (!r) continue;
        const text = L.nudgeText(S.plan, piece);
        const size = 15, ph = 30, pw = A.titleW(text, size) + 30;
        const bob = Math.sin(t / 220) * 3;
        const x = r.x + r.w + 18 + bob;
        const y = piece === "tiles" ? r.y + 6 : r.y + 4;
        c.save();
        c.globalAlpha = a;
        // the notch pointing back at the piece
        c.beginPath();
        c.moveTo(x - 10, y + ph / 2); c.lineTo(x + 3, y + ph / 2 - 8); c.lineTo(x + 3, y + ph / 2 + 8);
        c.closePath();
        c.fillStyle = A.HUD.gold; c.fill();
        c.lineWidth = 2; c.strokeStyle = A.HUD.ink; c.stroke();
        c.restore();
        A.panel(c, x, y, pw, ph, { r: ph / 2, fill: A.HUD.panel, lip: 2.5, bevel: false, alpha: a });
        A.title(text, x + pw / 2, y + ph / 2, size, A.HUD.gold, "center", a);
    }
}

// QA: window.dwFirstSec() -> state
window.dwFirstSec = (cmd) => {
    // QA: the missed-results recap on the next new-raid card
    if (cmd === "recap") { S.recap = S.lastRes; S.plan = L.planFor({ newRaid: true, recap: true }); S.land = now(); S.relAt = 0; return S.recap; }
    if (cmd === "replay") { S.used = false; S.plan = null; S.alive = false; return true; }
    if (cmd === "new" || cmd === "vet") { S.plan = L.planFor({ newcomer: cmd === "new" }); S.land = now(); S.relAt = 0; return true; }
    return { plan: S.plan, age: Math.round(S.age), released: released(), hold: global.introHold,
        shows: Object.fromEntries(L.PIECES.map(p => [p, shows(p)])), recap: S.recap ? S.recap.raidId : 0, lastRes: S.lastRes ? S.lastRes.raidId : 0 };
};
