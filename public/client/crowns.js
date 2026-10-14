// The Crown Contest, the client half (server: game/terrain/crowns.js).
// When the last storm starts the top 3 get crowns
//
//   crowns     a flat gold crown over every crowned tank (overhead stack),
//              a crown on the minimap and the big map (a gold area until
//              sudden death, the real spot after), an edge arrow to the
//              nearest one
//   tracker    the three crown holders and their points where the standings
//              sit, with your distance to the nearest crown (app.js
//              drawRoyaleStandings). A first raid, a phone, or no standings
//              panel: one line in the note stack instead
// moments CROWNS ARE OUT, YOU GOT A CROWN, CROWN STOLEN / LOST, FINAL MINUTE (a
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
import * as SL from "./scoreLogic.js";
import { drawCrown, drawCrownIcon, ASPECT } from "./crownArt.js";

let A = null;
export function init(helpers) { A = helpers; }

const TAU = Math.PI * 2;
const GOLD = "#f2b83c";
const RED = "#ff3b4e";
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const nx = () => global.nxStage == null ? 3 : global.nxStage;
const stage0 = () => !!global.nxKnown && nx() === 0;

const S = { src: null, c: null, byId: new Map(), champSrc: null, champ: new Set(), sdAt: -1e9, startAt: -1e9, stolenAt: -1e9, raidId: 0,
    // you wearing a crown (RY you.crown): since when, and the last crowned slam
    mine: null, gotAt: -1e9, slamAt: -1e9, slam: null, popAt: -1e9, hadMine: false };

// ── packets ────────────────────────────────────────────────────────────
export function onRY(r) {
    if (r.crowns !== S.src) {
        S.src = r.crowns;
        S.c = r.crowns || null;
        S.byId.clear();
        for (const row of CL.rows(S.c)) S.byId.set(row.e, row);
        // the crown lands on your own tank: the pop over it (drawOverhead)
        const has = S.byId.has(gui.playerid);
        if (has && !S.hadMine) S.popAt = performance.now();
        S.hadMine = has;
    }
    if (r.board !== S.champSrc) {
        S.champSrc = r.board;
        S.champ.clear();
        if (r.board) for (const row of r.board) if (row.ch) S.champ.add(row.id);
    }
    if ((r.raidId | 0) !== S.raidId) { S.raidId = r.raidId | 0; S.sdAt = -1e9; S.startAt = -1e9; S.mine = null; }
    // a crown on you, however it got there: a big moment you can't miss
    const mc = r.you && r.you.crown && !global.died ? r.you.crown : null;
    if (mc && !S.mine) {
        const now = performance.now();
        S.gotAt = now;
        // the server's slam is on its way to the screen (queued, held for the landing) or
        const ours = S.slam && S.slam.key && S.slam.key.charAt(0) === "!";
        const told = now - S.slamAt <= 2500 || (ours && (S.slam.on || juice.slamSeen(S.slam)));
        if (!told) {
            const card = SL.crownCard(mc), how = CL.howLine(mc);
            gotCrownFx(how.title, how.sub + " " + card.line1 + " " + card.line2, 5000);
        }
    }
    // the risk is the server's live number (crowns.stealOf)
    if (mc && S.mine && mc.lose == null && S.mine.lose != null) mc.lose = S.mine.lose;
    S.mine = mc;
}
export const mineCrown = () => S.mine;
function gotCrownFx(text, sub, dur) {
    S.slamAt = performance.now();
    // must-see: jumps the queue and stays up its full keep time
    S.slam = juice.slamMust(text, sub, GOLD, dur || 4200, 64, 2800);
    juice.shake(28, 420);
    juice.lightLeak("242,184,60", 1600);
    juice.flash("#fff1c2", 160, 0.2);
    const me = meEntity();
    if (me) {
        juice.ring(me.x, me.y, GOLD, 24, 360, 900, 12);
        juice.sparks(me.x, me.y, 30, 380, 1100, 3, GOLD, TAU, 0, 7);
    }
    sfx("crown");
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
            if (stage0()) juice.slam("CROWNS ARE OUT", "Hold one for points, or kill a holder to steal theirs", GOLD, 4600, 50);
            else juice.slam(text, sub, GOLD, 4400, 62);
            juice.flash("#fff1c2", 220, 0.25);
            juice.rumble(900, 6);
            juice.lightLeak("242,184,60", 2000);
            sfx("crown");
            return true;
        case "crowned":
            gotCrownFx(text, sub, Math.max(4200, (m[4] | 0) || 0));
            S.gotAt = now;
            return true;
        case "crowntake": {
            S.stolenAt = now;
            S.slamAt = now;
            S.gotAt = now;
            S.slam = juice.slamMust(text, sub, GOLD, 3400, 70, 2600);
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
            // wearing one: the vault rule is a must-see, big and early
            if (S.mine) juice.slamMust(text, sub, RED, 4400, 76, 3200);
            else juice.slam(text, sub, RED, 3800, 76);
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
    // your own crown landing: it drops in big and settles, with a gold ring
    const pa = id === gui.playerid ? now - S.popAt : 1e9;
    const pk = pa >= 0 && pa < POP_MS ? CL_pop(pa / POP_MS) : 1;
    c.save();
    c.translate(x, top - 6 + bob - (pk - 1) * w * 0.35);
    if (!calm()) c.rotate(Math.sin(now / 900 + id) * 0.05);
    if (pk !== 1) {
        c.save();
        c.globalAlpha = alpha * Math.max(0, 1 - pa / POP_MS);
        c.strokeStyle = GOLD; c.lineWidth = 3;
        c.beginPath(); c.arc(0, w * 0.1, w * (0.4 + 0.9 * (pa / POP_MS)), 0, TAU); c.stroke();
        c.restore();
        c.scale(pk, pk);
    }
    drawCrown(c, 0, 0, w, alpha);
    c.restore();
}
// the landing pop: 2.4x, a small overshoot, then 1
const POP_MS = 1100;
function CL_pop(k) {
    if (calm()) return 1;
    if (k < 0.35) return 2.4 - 1.5 * (k / 0.35);          // 2.4 -> 0.9
    if (k < 0.6) return 0.9 + 0.18 * ((k - 0.35) / 0.25); // -> 1.08
    return 1.08 - 0.08 * ((k - 0.6) / 0.4);              // -> 1
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

// the font size that fits `text` in `room` (measured once per text and room)
const footSizes = new Map();
function footSize(text, room, max) {
    const k = text + "|" + Math.round(room);
    let fs = footSizes.get(k);
    if (fs == null) {
        fs = max;
        while (fs > 8 && A.measureText(text, fs) > room) fs -= 0.5;
        if (footSizes.size > 64) footSizes.clear();
        footSizes.set(k, fs);
    }
    return fs;
}
// ── the tracker (app.js puts it where the standings go) ────────────────
// -> bottom y. myHex: your colour, fmt/fmtDist from the app.
export function drawTracker(c, x, y0, W) {
    if (!A || !active()) return y0;
    const HUD = A.HUD;
    const me = global.player;
    const r = global.royale || {};
    const t = CL.tracker(S.c, gui.playerid, me.renderx, me.rendery, A.fmtDist, r.board);
    const rowH = 21;
    const H = 32 + Math.max(1, t.rows.length) * rowH + (t.footer ? 20 : 6) + (t.footer2 ? 14 : 0);
    const now = performance.now();
    A.hudPanel(c, x, y0, W, H);
    // a gold edge so it reads as crown time, red in the final minute
    c.save();
    c.globalAlpha = 0.9;
    c.strokeStyle = S.c.sd ? RED : GOLD;
    c.lineWidth = 2;
    A.roundRectPath(c, x + 1, y0 + 1, W - 2, H - 2, HUD.r);
    c.stroke();
    c.restore();
    c.fillStyle = "rgba(0,0,0,0.55)";
    c.fillRect(x + 10, y0 + 27, W - 20, 2);
    A.hudTitle("Standings", x + 12, y0 + 15, 14, HUD.head, "left");
    if (S.c.sd) {
        const a = calm() ? 1 : 0.65 + 0.35 * Math.sin(now / 140);
        A.hudTitle("CROWNS x2", x + W - 12, y0 + 15, 11, RED, "right", a);
    } else {
        const lbl = "+" + CL.pps(S.c) + "/SEC";
        A.hudTitle(lbl, x + W - 12, y0 + 15, 11, GOLD, "right");
        drawCrownIcon(c, x + W - 12 - A.hudTitleW(lbl, 11) - 10, y0 + 14, 12);
    }
    let ry = y0 + 32;
    const myHex = A.myHex ? A.myHex() : GOLD;
    for (const row of t.rows) {
        const mid = ry + rowH / 2 - 1;
        if (row.k) {
            const kc = row.k === 1 ? HUD.gold : row.k === 2 ? "#d8dce6" : row.k === 3 ? "#d98a4e" : HUD.text2;
            A.drawText("#" + row.k, x + 12, mid, 11, kc, "left", true);
        }
        if (row.crown) drawCrownIcon(c, x + 48, mid, 12, row.crown === 1 ? "gold" : row.crown === 2 ? "silver" : "bronze");
        const sc = A.fmtNum(row.score);
        const sw = A.hudTextW(sc, 12);
        const nx0 = x + 60;
        let ns = 12; while (ns > 8 && A.measureText(row.name, ns) > x + W - 12 - sw - 10 - nx0) ns -= 0.5;
        A.drawText(row.name, nx0, mid, ns, row.me ? myHex : HUD.text, "left", true);
        A.drawText(sc, x + W - 12, mid, 12, row.me ? myHex : row.crown ? HUD.gold : HUD.text, "right", true);
        ry += rowH;
    }
    if (!t.rows.length) { A.drawText("Nobody holds one", x + 38, ry + rowH / 2 - 1, 11, HUD.text2, "left", true); ry += rowH; }
    if (t.footer) {
        // shrink to the card, never past its edge (sizes cached per line)
        A.drawText(t.footer, x + W - 12, ry + 8, footSize(t.footer, W - 24, 10.5), CL.mine(S.c, gui.playerid) ? GOLD : HUD.text2, "right", true);
        if (t.footer2) A.drawText(t.footer2, x + W - 12, ry + 22, footSize(t.footer2, W - 24, 10), HUD.text2, "right", true);
    }
    return y0 + H;
}

// Duos: the team standings stay up during the contest (teams win on
// combined points); this gives them the crown look: the gold (final minute:
// red) edge and the crown rate in the header. -> true when it drew.
export function drawTeamEdge(c, x, y0, W, H) {
    if (!A || !active()) return false;
    const HUD = A.HUD;
    c.save();
    c.globalAlpha = 0.9;
    c.strokeStyle = S.c.sd ? RED : GOLD;
    c.lineWidth = 2;
    A.roundRectPath(c, x + 1, y0 + 1, W - 2, H - 2, HUD.r);
    c.stroke();
    c.restore();
    if (S.c.sd) A.hudTitle("CROWNS x2", x + W - 44, y0 + 15, 11, RED, "right", calm() ? 1 : 0.65 + 0.35 * Math.sin(performance.now() / 140));
    else {
        const lbl = "+" + CL.pps(S.c) + "/SEC";
        A.hudTitle(lbl, x + W - 44, y0 + 15, 11, GOLD, "right");
        drawCrownIcon(c, x + W - 44 - A.hudTitleW(lbl, 11) - 10, y0 + 14, 12);
    }
    return true;
}

// one line in the note stack: a first raid, a phone, a hidden standings
// panel. push(note) like raidHeat.hudNotes.
const NOTE = { pri: 1, key: "crown", text: "", sub: "", col: GOLD, pulse: 0, badge: true };
// You wear a crown: a gold card at the top of the note stack for as long as you
export function hudNotes(push, compact) {
    if (!active() || global.died) return;
    const me = global.player;
    const mineRow = CL.mine(S.c, gui.playerid);
    if (S.mine && A) {
        if (S.toldAt !== S.gotAt && typeof global.sideToast === "function") {
            S.toldAt = S.gotAt;
            const lose = Math.max(0, S.mine.lose | 0);
            global.sideToast(lose > 0 ? "You have a crown. If you're killed, you lose " + lose.toLocaleString("en-US") + " pts. Banked gems stay safe."
                : "You have a crown. If you're killed, you lose it, but banked gems stay safe.", "crown");
        }
        // coach.js: its card steps aside while a new crown's card has the top
        if (cardFresh()) global.crownCardAt = performance.now();
        return;
    }
    // the tracker already says it all on a big screen, unless you hold one
    if (!compact && !mineRow) return;
    const n = CL.note(S.c, gui.playerid, me.renderx, me.rendery, A ? A.fmtDist : null, stage0() ? 0 : 3);
    if (!n) return;
    NOTE.text = n.text; NOTE.sub = n.sub;
    NOTE.col = n.hot && S.c.sd ? RED : GOLD;
    NOTE.pulse = calm() ? 1 : 0.75 + 0.25 * Math.sin(performance.now() / (S.c.sd ? 120 : 260));
    push(NOTE);
}

const HOW_MS = 8000;
// a crown just landed: its card has the middle (raidPerks waits for it)
export function cardFresh() { return !!S.mine && performance.now() - S.gotAt < HOW_MS; }

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
        case "start": return { text: tag("Crowns are out!", GOLD) + " Hold one for points", badge: null };
        case "sd": return { text: tag("FINAL MINUTE", RED) + ": crowns pay double", badge: null };
        case "took": return { text: tag(String(x.by).slice(0, 13), GOLD) + " took " + who(x.name, "someone") + "'s " + crown + "!", badge: x.pts ? { t: "+" + (A ? A.fmtNum(x.pts) : x.pts), col: GOLD } : null };
        case "smash": return { text: who(x.by, "Someone") + " smashed " + who(x.name, "someone") + "'s " + crown, badge: x.to ? { t: String(x.to).slice(0, 10), col: GOLD } : null };
        case "fell": return { text: who(x.name, "Someone") + "'s " + crown + (x.to ? " fell to " + who(x.to, "someone") : " is gone"), badge: null };
    }
    return null;
}

// QA (headless runs)
window.dwCrowns = () => ({ on: active(), sd: sudden(), list: CL.rows(S.c), champ: [...S.champ], mine: S.mine, gotAt: S.gotAt, slamAt: S.slamAt });
