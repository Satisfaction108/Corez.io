// The Crown Contest, the client half (server: game/terrain/crowns.js).
// When the last storm starts the top 3 get crowns, and only a crown can win.
//
//   crowns     a flat gold crown over every crowned tank (overhead stack),
//              a crown on the minimap and the big map (a gold area until
//              sudden death, the real spot after), an edge arrow to the
//              nearest one
//   tracker    the three crown holders and their points where the standings
//              sit, with your distance to the nearest crown (app.js
//              drawRoyaleStandings). A first raid, a phone, or no standings
//              panel: one line in the note stack instead
//   moments    the contest banner, YOU HOLD A CROWN, CROWN STOLEN / LOST,
//              SUDDEN DEATH (a red edge pulse), the 10 second call
//   champion   a small crown by the name of anyone who won a raid in the
//              last 24 h (board rows `ch`)
//
// app.js passes its HUD helpers through init; the socket handlers call
// onRY / onKC / onFX. Pure bits live in crownsLogic.js.
import { global } from "./global.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";
import * as juice from "./juice.js";
import * as CL from "./crownsLogic.js";
import { drawCrown, drawCrownIcon, ASPECT } from "./crownArt.js";

let A = null;
export function init(helpers) { A = helpers; }

const TAU = Math.PI * 2;
const GOLD = "#f2b83c";
const RED = "#ff3b4e";
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const nx = () => global.nxStage == null ? 3 : global.nxStage;
const stage0 = () => !!global.nxKnown && nx() === 0;

const S = { src: null, c: null, byId: new Map(), champSrc: null, champ: new Set(), sdAt: -1e9, startAt: -1e9, stolenAt: -1e9, raidId: 0 };

// ── packets ────────────────────────────────────────────────────────────
export function onRY(r) {
    if (r.crowns !== S.src) {
        S.src = r.crowns;
        S.c = r.crowns || null;
        S.byId.clear();
        for (const row of CL.rows(S.c)) S.byId.set(row.e, row);
    }
    if (r.board !== S.champSrc) {
        S.champSrc = r.board;
        S.champ.clear();
        if (r.board) for (const row of r.board) if (row.ch) S.champ.add(row.id);
    }
    if ((r.raidId | 0) !== S.raidId) { S.raidId = r.raidId | 0; S.sdAt = -1e9; S.startAt = -1e9; }
}

export const active = () => !!(S.c && S.c.on && !S.c.done);
export const sudden = () => active() && !!S.c.sd;
export const crownOf = (id) => active() ? S.byId.get(id) || null : null;
export const isChamp = (id) => S.champ.has(id);
export const list = () => CL.rows(S.c);

function sfx(kind) {
    try {
        if (kind === "crown") { gameSound.rankUp(true); }
        else if (kind === "steal") { gameSound.combatKill(); gameSound.rankUp(true); }
        else if (kind === "lost") { gameSound.rankShatter(); }
        else if (kind === "sd") { gameSound.stormWarn(); gameSound.rankShatter(); }
        else if (kind === "tick") { gameSound.rankCrack(3); }
    } catch (e) { /* */ }
}

// true = handled here (no plate in the callout queue)
export function onKC(m) {
    const kind = m[0], text = String(m[1] || ""), sub = typeof m[3] === "string" ? m[3] : "";
    const now = performance.now();
    switch (kind) {
        case "crowns":
            S.startAt = now;
            if (stage0()) juice.slam("CROWNS ARE OUT", "Kill a crown holder to take it. Hold one at the end to win.", GOLD, 4600, 50);
            else juice.slam(text, sub, GOLD, 4400, 62);
            juice.flash("#fff1c2", 220, 0.25);
            juice.rumble(900, 6);
            juice.lightLeak("242,184,60", 2000);
            sfx("crown");
            return true;
        case "crowned":
            juice.slam(text, sub, GOLD, 3600, 64);
            juice.shake(28, 420);
            juice.lightLeak("242,184,60", 1600);
            juice.flash("#fff1c2", 160, 0.2);
            sfx("crown");
            return true;
        case "crowntake": {
            S.stolenAt = now;
            juice.slam(text, sub, GOLD, 3400, 70);
            juice.hitStop(80, 90);
            juice.slowMo(520, 0.3);
            juice.shake(44, 520);
            juice.flash("#fff1c2", 200, 0.35);
            juice.lightLeak("242,184,60", 1800);
            const me = meEntity();
            if (me) {
                juice.sparks(me.x, me.y, 46, 520, 1300, 3, GOLD, TAU, 0, 8);
                juice.ring(me.x, me.y, GOLD, 30, 420, 700, 14);
            }
            sfx("steal");
            return true;
        }
        case "crownlost":
            juice.slam(text, sub, RED, 3200, 64);
            juice.glitch(0.9, 520, true);
            juice.shake(38, 480);
            juice.flash("#ff2030", 160, 0.25);
            sfx("lost");
            return true;
        case "suddendeath":
            S.sdAt = now;
            juice.slam(text, sub, RED, 3800, 76);
            juice.glitch(1, 700, true);
            juice.rumble(1600, 8);
            juice.shake(36, 600);
            juice.flash("#ff2030", 260, 0.3);
            sfx("sd");
            return true;
        case "crown10":
            juice.slam(text, sub, "#ffffff", 2400, 80);
            juice.shake(30, 380);
            juice.flash("#ffffff", 140, 0.2);
            sfx("tick");
            return true;
    }
    return false;
}

// true = handled here
export function onFX(kind, x, y) {
    if (kind === "crownon") {
        juice.ring(x, y, GOLD, 20, 260, 700, 10);
        juice.sparks(x, y, 20, 300, 900, 3, GOLD, TAU, 0, 6);
        return true;
    }
    if (kind === "crownsteal") {
        juice.ring(x, y, "#ffffff", 30, 520, 600, 16);
        juice.ring(x, y, GOLD, 30, 380, 900, 12);
        juice.sparks(x, y, 50, 600, 1400, 3, GOLD, TAU, 0, 8);
        return true;
    }
    return false;
}

function meEntity() {
    const list = global.entities || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === gui.playerid) return list[i];
    return null;
}

// ── the crown itself (crownArt.js: flat, ink rimmed, baked per size) ──
export { crownSprite, drawCrown, drawCrownIcon } from "./crownArt.js";

// ── over the tank (app.js overhead stack) ──────────────────────────────
// how much room the crown takes above `top` (for chat bubbles above it)
export function overheadH(id, isize, ratio) {
    if (!crownOf(id)) return 0;
    return crownW(isize, ratio) * ASPECT + 8;
}
// a little wider than the tank, readable when zoomed out
const crownW = (isize, ratio) => Math.max(46, Math.min(92, isize * ratio * 1.5));
// x, y screen centre of the tank, top: the top of its name / badge stack
export function drawOverhead(c, x, y, top, isize, ratio, alpha, id) {
    const row = crownOf(id);
    if (!row || alpha < 0.03) return;
    const now = performance.now();
    const w = crownW(isize, ratio);
    const bob = calm() ? 0 : Math.sin(now / 420 + id) * w * 0.05;
    c.save();
    c.translate(x, top - 6 + bob);
    if (!calm()) c.rotate(Math.sin(now / 900 + id) * 0.05);
    drawCrown(c, 0, 0, w, alpha);
    c.restore();
}

// ── edge marker: the nearest crown out of sight (app.js world marks) ────
export function worldMarks(marks, toScreen, onScreen, me, trackPos) {
    if (!active() || !me) return;
    const myId = gui.playerid;
    let best = null;
    for (const row of CL.rows(S.c)) {
        if (row.e === myId) continue;
        const p = trackPos("crown" + row.e, row.x, row.y, row.f ? 0.25 : 0.7);
        const s = toScreen(p.x, p.y);
        if (onScreen(s, -20)) continue;
        const d = Math.hypot(p.x - me.x, p.y - me.y);
        if (!best || d < best.d) best = { pri: 0.4, s, col: GOLD, glyph: "crown", name: "CROWN " + String(row.n || "").slice(0, 10).toUpperCase(), d };
    }
    if (best) marks.push(best);
}

// ── minimap / big map ──────────────────────────────────────────────────
export function drawMap(c, T, inside, dotR, pulse) {
    if (!active()) return;
    const now = performance.now();
    const myId = gui.playerid;
    const fz = S.c.fz || 450;
    for (const row of CL.rows(S.c)) {
        const mx = T.X(row.x), my = T.Y(row.y);
        if (!inside(mx, my)) continue;
        c.save();
        if (row.f && row.e !== myId) {
            // until sudden death the map only knows the area
            const rr = Math.max(dotR * 3, Math.abs(T.X(row.x + fz * 0.7) - mx));
            c.globalAlpha = 0.16 + 0.06 * Math.sin(now / 300);
            c.fillStyle = GOLD;
            c.beginPath(); c.arc(mx, my, rr, 0, TAU); c.fill();
            c.globalAlpha = 0.7;
            c.strokeStyle = GOLD; c.lineWidth = 1.5;
            c.setLineDash([4, 4]);
            c.beginPath(); c.arc(mx, my, rr, 0, TAU); c.stroke();
            c.setLineDash([]);
            c.globalAlpha = 0.85;
        } else {
            c.globalAlpha = 0.9;
            c.strokeStyle = S.c.sd ? RED : GOLD; c.lineWidth = 2;
            c.beginPath(); c.arc(mx, my, dotR * 3.6 * pulse, 0, TAU); c.stroke();
            c.globalAlpha = 1;
        }
        drawCrownIcon(c, mx, my, Math.max(9, dotR * 3.4));
        c.restore();
    }
}

// ── the tracker (app.js puts it where the standings go) ────────────────
// -> bottom y. myHex: your colour, fmt/fmtDist from the app.
export function drawTracker(c, x, y0, W) {
    if (!A || !active()) return y0;
    const HUD = A.HUD;
    const me = global.player;
    const t = CL.tracker(S.c, gui.playerid, me.renderx, me.rendery, A.fmtDist);
    const rowH = 21;
    const H = 32 + Math.max(1, t.rows.length) * rowH + (t.footer ? 20 : 6);
    const now = performance.now();
    A.hudPanel(c, x, y0, W, H);
    // a gold edge so it reads as the contest, red in sudden death
    c.save();
    c.globalAlpha = 0.9;
    c.strokeStyle = S.c.sd ? RED : GOLD;
    c.lineWidth = 2;
    A.roundRectPath(c, x + 1, y0 + 1, W - 2, H - 2, HUD.r);
    c.stroke();
    c.restore();
    c.fillStyle = "rgba(18,14,21,0.55)";
    c.fillRect(x + 10, y0 + 27, W - 20, 2);
    drawCrownIcon(c, x + 22, y0 + 15, 13);
    A.hudTitle("Crowns", x + 36, y0 + 15, 14, HUD.head, "left");
    if (S.c.sd) {
        const a = calm() ? 1 : 0.65 + 0.35 * Math.sin(now / 140);
        A.hudTitle("SUDDEN DEATH", x + W - 12, y0 + 15, 11, RED, "right", a);
    } else A.hudTitle("PTS", x + W - 12, y0 + 15, 11, HUD.text2, "right");
    let ry = y0 + 32;
    const myHex = A.myHex ? A.myHex() : GOLD;
    for (const row of t.rows) {
        const mid = ry + rowH / 2 - 1;
        drawCrownIcon(c, x + 22, mid, 12, row.k === 1 ? "gold" : row.k === 2 ? "silver" : "bronze");
        const sc = A.fmtNum(row.score);
        const sw = A.hudTextW(sc, 12);
        let name = row.name;
        let ns = 12; while (ns > 8 && A.measureText(name, ns) > W - 50 - sw - 18) ns -= 0.5;
        A.drawText(name, x + 38, mid, ns, row.me ? myHex : HUD.text, "left", true);
        A.drawText(sc, x + W - 12, mid, 12, row.me ? myHex : HUD.gold, "right", true);
        ry += rowH;
    }
    if (!t.rows.length) { A.drawText("Nobody holds one", x + 38, ry + rowH / 2 - 1, 11, HUD.text2, "left", true); ry += rowH; }
    if (t.footer) A.drawText(t.footer, x + W - 12, ry + 8, 10.5, CL.mine(S.c, gui.playerid) ? GOLD : HUD.text2, "right", true);
    return y0 + H;
}

// one line in the note stack: a first raid, a phone, a hidden standings
// panel. push(note) like raidHeat.hudNotes.
const NOTE = { pri: 1, key: "crown", text: "", sub: "", col: GOLD, pulse: 0, badge: true };
export function hudNotes(push, compact) {
    if (!active() || global.died) return;
    const me = global.player;
    const mineRow = CL.mine(S.c, gui.playerid);
    // the tracker already says it all on a big screen, unless you hold one
    if (!compact && !mineRow) return;
    const n = CL.note(S.c, gui.playerid, me.renderx, me.rendery, A ? A.fmtDist : null, stage0() ? 0 : 3);
    if (!n) return;
    NOTE.text = n.text; NOTE.sub = n.sub;
    NOTE.col = n.hot && S.c.sd ? RED : GOLD;
    NOTE.pulse = calm() ? 1 : 0.75 + 0.25 * Math.sin(performance.now() / (S.c.sd ? 120 : 260));
    push(NOTE);
}

// ── screen: the sudden death edge pulse ────────────────────────────────
export function drawScreen(c) {
    if (!A || !A.vignetteSprite || !juice.glowOn()) return;
    const age = performance.now() - S.sdAt;
    if (age < 0 || age > 2400) return;
    const w = global.screenWidth, h = global.screenHeight;
    const k = (1 - age / 2400) * (calm() ? 0.5 : 0.75 + 0.25 * Math.sin(age / 90));
    c.save();
    c.globalAlpha = 0.45 * k;
    c.drawImage(A.vignetteSprite(w, h, 0.55, "255,30,50"), 0, 0, w, h);
    c.restore();
}

// ── feed (app.js feedLine) ─────────────────────────────────────────────
export function feedLine(f, who, tag) {
    const x = CL.feed(f);
    if (!x) return null;
    const crown = tag("crown", GOLD);
    switch (x.verb) {
        case "start": return { text: tag("The Crown Contest", GOLD) + " is on", badge: null };
        case "sd": return { text: tag("SUDDEN DEATH", RED) + ": crowns can't bank", badge: null };
        case "took": return { text: tag(String(x.by).slice(0, 13), GOLD) + " took " + who(x.name, "someone") + "'s " + crown + "!", badge: x.pts ? { t: "+" + (A ? A.fmtNum(x.pts) : x.pts), col: GOLD } : null };
        case "smash": return { text: who(x.by, "Someone") + " smashed " + who(x.name, "someone") + "'s " + crown, badge: x.to ? { t: String(x.to).slice(0, 10), col: GOLD } : null };
        case "fell": return { text: who(x.name, "Someone") + "'s " + crown + (x.to ? " fell to " + who(x.to, "someone") : " is gone"), badge: null };
    }
    return null;
}

// QA (headless runs)
window.dwCrowns = () => ({ on: active(), sd: sudden(), list: CL.rows(S.c), champ: [...S.champ] });
