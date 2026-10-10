// Raid perks on the HUD: every 5,000 points on the raid board the server
// offers three perks (PK packet) and the pick lasts until the raid ends,
// deaths included. This file draws and handles:
//
//   cards   a compact row low in the middle, above your name and satchel,
//           clear of your tank, the stat bars, the kit box, the upgrade
//           tiles and the minimap. Shift+1/2/3 or a click (tap) picks. The
//           game keeps running underneath.
//   chip    left alone for a while (or while the shop, a vault, the map or
//           the death card owns the screen) the cards fold into a small
//           "Perk ready" chip beside the satchel. It never jumps back out on
//           its own: a click or a perk key opens it again.
//   strip   your build as little icons left of the satchel pills, with a
//           progress badge toward the next pick
//   fx      Blast Rounds, Chain Spark, Seismic Pulse, Lucky Strike
//
// The rules (layout, keys, packet parsing) are in raidPerksLogic.js.
import { global } from "./global.js";
import { config } from "./config.js";
import { gameSound } from "./sound.js";
import * as juice from "./juice.js";
import * as L from "./raidPerksLogic.js";

let A = null;
// app.js: HUD, hudPanel, hudTitle, hudTitleW, hudTextW, drawText, rr,
// haloSprite, queueTip, hudKey, newcomerStage
export function init(helpers) { A = helpers; }
// app.js: one card's full width (the row it keeps clear for)
export const CARD_W = L.CARD.w;

const TAU = Math.PI * 2;
const GOLD = "#f2b83c", GOLD_DK = "#a8750f", INK = "#120e15", TEAL = "#5ce0d8";
const calm = () => !!(global.reducedMotion && global.reducedMotion());
const glowOn = () => !config.graphical.noGlow && !global.lowFx;
const sfx = (fn, ...a) => { try { if (gameSound[fn]) gameSound[fn](...a); } catch (e) { /* */ } };
const NEW_KEY = "dwPerkNew_v1";

const S = {
    st: null,                 // the parsed PK packet
    key: "",                  // the offer on the table ("" = none)
    openedAt: -1e9,           // when the cards last opened
    folded: false,            // folded into the chip until asked for
    hover: -1,
    picked: -1, pickedAt: -1e9, out: null, outRects: null,   // the pick animation (the old cards)
    cardRects: [], headRect: null, laterRect: null, chipRect: null, iconRects: [], badgeRect: null,
    view: "",
    flashId: "", flashAt: -1e9, gotName: "",
    wasDead: false,
    over: "", overSince: 0, armed: "", lastShotAt: -1e9,
    seenNew: null,
    shownKey: "",             // the offer that has come out at least once
};
// QA: pick card i as a tap would
window.dwPerkPick = (i) => pick(i | 0);
// QA and app.js (touch hit areas): what's up and where, in HUD units
window.dwRaidPerks = () => ({ state: S.st, view: S.view, folded: S.folded, key: S.key, cards: S.cardRects, chip: S.chipRect, later: S.laterRect, strip: S.iconRects, badge: S.badgeRect, stripBox: S.stripBox, head: S.headRect });
export function state() { return S.st; }
export function build() { return (S.st && S.st.build) || []; }
export function offerUp() { return !!(S.st && S.st.offer && S.picked < 0); }

function newSeen() {
    if (S.seenNew == null) { try { S.seenNew = localStorage.getItem(NEW_KEY) === "1"; } catch (e) { S.seenNew = true; } }
    return S.seenNew;
}
function markNewSeen() {
    S.seenNew = true;
    try { localStorage.setItem(NEW_KEY, "1"); } catch (e) { /* */ }
}

// ── the server ─────────────────────────────────────────────────────────
export function onState(raw) {
    const st = L.parseState(raw);
    if (!st) return;
    const prev = S.st;
    S.st = st;
    const key = L.offerKey(st.offer);
    const now = performance.now();
    // a perk joined the build: it blinks in the strip
    if (prev) {
        for (const p of st.build) {
            const old = prev.build.find(q => q.id === p.id);
            if (!old || old.n < p.n) { S.flashId = p.id; S.flashAt = now; S.gotName = (p.name || p.id) + (p.n > 1 ? " " + ["", "I", "II", "III", "IV", "V"][p.n] : ""); }
        }
    }
    if (key !== S.key) {
        const hadOffer = !!S.key;
        S.key = key;
        if (key) {
            // a fresh offer opens the cards; the next one in a queue right
            // after a pick too (they're picking). One that comes back after a
            // death, or any on a touch screen, waits folded in the chip.
            const queuedNext = S.picked >= 0 || (hadOffer && now - S.pickedAt < 2000);
            S.folded = false;
            // the next one in a queue flies in once the pick has played out
            S.openedAt = queuedNext ? Math.max(now, S.pickedAt + 620) : now;
            if (!queuedNext) sfx("uiClick");
        }
    }
    if (!key) S.folded = false;
}

// FX: Blast Rounds, Chain Spark, Seismic Pulse, Lucky Strike. m is the
// packet: x, y, kind, then the kind's own fields. -> true when handled.
const ARCS = 10, arcs = [];
for (let i = 0; i < ARCS; i++) arcs.push({ born: -1e9, pts: new Float32Array(18), n: 0 });
let arcI = 0;
const POPS = 6, pops = [];
for (let i = 0; i < POPS; i++) pops.push({ born: -1e9, x: 0, y: 0 });
let popI = 0;
const nearYou = (x, y, d) => global.player && Math.hypot(x - global.player.renderx, y - global.player.rendery) < d;
function addArc(x1, y1, x2, y2) {
    const a = arcs[arcI]; arcI = (arcI + 1) % ARCS;
    a.born = performance.now();
    const n = 8, dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    for (let i = 0; i <= n; i++) {
        const t = i / n, j = i === 0 || i === n ? 0 : (Math.random() - 0.5) * Math.min(60, len * 0.22);
        a.pts[i * 2] = x1 + dx * t + nx * j;
        a.pts[i * 2 + 1] = y1 + dy * t + ny * j;
    }
    a.n = n + 1;
}
export function onFX(m) {
    if (!m) return false;
    const x = +m[0] || 0, y = +m[1] || 0, kind = m[2];
    switch (kind) {
        case "pkblast": {
            const r = Math.max(30, Math.min(600, +m[3] || 120));
            juice.ring(x, y, "#ffb347", r * 0.25, r, 340, 7);
            juice.sparks(x, y, 9, r * 1.2, 440, 0, "#ffb347", TAU, Math.random() * TAU, 4);
            juice.sparks(x, y, 5, r, 560, 1, "#3a2a24", TAU, Math.random() * TAU, 5);
            if (nearYou(x, y, 500)) juice.shake(5, 160);
            return true;
        }
        case "pkchain": {
            for (let i = 3; i + 1 < m.length && i < 3 + 12; i += 2) {
                const tx = +m[i], ty = +m[i + 1];
                if (!isFinite(tx) || !isFinite(ty)) continue;
                addArc(x, y, tx, ty);
                juice.sparks(tx, ty, 4, 120, 320, 3, "#bfe9ff", TAU, Math.random() * TAU, 4);
            }
            return true;
        }
        case "pkquake": {
            const r = Math.max(60, Math.min(900, +m[3] || 260));
            juice.ring(x, y, "#d9904a", 30, r, 520, 10);
            juice.ring(x, y, "#fff3d9", 20, r * 0.75, 380, 4);
            juice.sparks(x, y, 8, r, 600, 1, "#4a3a2e", TAU, Math.random() * TAU, 6);
            if (nearYou(x, y, 120)) juice.shake(7, 220);
            return true;
        }
        case "pkcrit": {
            const p = pops[popI]; popI = (popI + 1) % POPS;
            p.born = performance.now(); p.x = x; p.y = y;
            juice.sparks(x, y, 7, 160, 400, 3, "#ffd76e", TAU, Math.random() * TAU, 5);
            return true;
        }
    }
    return false;
}
// app.js drawGameplay, world layer: the sparks' arcs and the CRIT pops
export function drawWorld(c, px, py, ratio) {
    if (!A) return;
    const now = performance.now(), cx = global.screenWidth / 2, cy = global.screenHeight / 2;
    let any = false;
    for (const a of arcs) {
        const age = now - a.born;
        if (age < 0 || age > 260 || a.n < 2) continue;
        if (!any) { c.save(); c.lineCap = "round"; c.lineJoin = "round"; any = true; }
        // flickers: on, off, on, fading
        const k = age / 260, fl = age < 60 || (age > 90 && age < 200) ? 1 : 0.35;
        c.beginPath();
        for (let i = 0; i < a.n; i++) {
            const sx = ratio * a.pts[i * 2] - px + cx, sy = ratio * a.pts[i * 2 + 1] - py + cy;
            i ? c.lineTo(sx, sy) : c.moveTo(sx, sy);
        }
        if (glowOn()) { c.globalAlpha = (1 - k) * 0.45 * fl; c.strokeStyle = "#5cc8ff"; c.lineWidth = Math.max(3, 9 * ratio); c.stroke(); }
        c.globalAlpha = (1 - k * 0.6) * fl; c.strokeStyle = "#f2fbff"; c.lineWidth = Math.max(1.5, 3 * ratio); c.stroke();
    }
    if (any) c.restore();
    for (const p of pops) {
        const age = now - p.born;
        if (age < 0 || age > 650) continue;
        const k = age / 650, sx = ratio * p.x - px + cx, sy = ratio * p.y - py + cy - 30 * k * ratio - 16 * ratio;
        const s = (age < 90 ? 1 + 0.5 * (1 - age / 90) : 1) * 15;
        A.hudTitle("CRIT", sx, sy, s, "#ffd76e", "center", k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4, c);
    }
}

// ── input ──────────────────────────────────────────────────────────────
// pick card i: tell the server, play the pick, let the cards fall away
export function pick(i) {
    const st = S.st, o = st && st.offer;
    if (!o || S.picked >= 0 || !(i >= 0 && i < o.length) || S.view !== "cards") return false;
    // the cards are still flying in: a stray key mash doesn't count
    if (performance.now() - S.openedAt < 220) return false;
    S.picked = i;
    S.pickedAt = performance.now();
    S.out = o.slice();
    S.outRects = S.cardRects.map(r => Object.assign({}, r));
    try { if (global.socket) global.socket.talk("PKP", o[i].id); } catch (e) { /* */ }
    sfx("buildUpgrade");
    try { juice.flash("#fff3d9", 110, 0.08); } catch (e) { /* */ }
    markNewSeen();
    return true;
}
function unfold() {
    S.folded = false;
    S.shownKey = S.key;      // asked for: a hit no longer holds it back
    S.openedAt = performance.now();
    sfx("uiClick");
}
function fold() {
    S.folded = true;
    markNewSeen();
    sfx("uiClick");
}
// canvas.js (royaleKeyDown): Shift+1/2/3. Folded, the key opens the cards
// rather than picking one you can't see. -> true when the key was ours.
export function key(e) {
    if (!offerUp() || global.died) return false;
    const i = L.perkKeyIndex(e, S.st.offer.length, !!global.showChat);
    if (i < 0) return false;
    if (e.preventDefault) e.preventDefault();
    if (S.view !== "cards") { unfold(); return true; }
    pick(i);
    return true;
}
// What's under a point: "c0".."c2" (a card), "later", "chip", or "".
function hitKey(x, y) {
    if (S.view === "cards") {
        if (S.laterRect && L.rectAt([S.laterRect], x, y) >= 0) return "later";
        const i = L.rectAt(S.cardRects, x, y);
        if (i >= 0 && S.picked < 0) return "c" + i;
    }
    if (S.chipRect && offerUp() && L.rectAt([S.chipRect], x, y) >= 0) return "chip";
    return "";
}
function act(k) {
    if (k === "later") fold();
    else if (k === "chip") unfold();
    else if (k[0] === "c") pick(+k.slice(1));
}
// The cards sit over the world below your tank, where you might be
// shooting at someone. So on a mouse a press only counts once the cursor
// has rested on the card a moment (DWELL_MS): a shot that just sweeps
// across one still fires. On touch the cards only come out when asked for,
// and a tap has to start and end on the same card (a thumb landing there
// to steer drags off it).
// the rule: raidPerksLogic.js clickPicks)
// canvas.js mouseDown (touch taps arrive the same way), in HUD units.
// -> true when the press was ours (it never fires the gun then).
const pressIn = { k: "", over: "", overSince: 0, now: 0, lastShotAt: -1e9 };
export function click(x, y) {
    if (global.died) return false;
    const now = performance.now();
    const k = hitKey(x, y);
    if (!k) { S.lastShotAt = now; return false; }
    if (global.mobile) { S.armed = k; return true; }
    pressIn.k = k; pressIn.over = S.over; pressIn.overSince = S.overSince; pressIn.now = now; pressIn.lastShotAt = S.lastShotAt;
    if (!L.clickPicks(pressIn)) { S.lastShotAt = now; return false; }
    act(k);
    return true;
}
// canvas.js mouseUp: the end of a tap that started on one of ours
export function release(x, y) {
    const a = S.armed;
    S.armed = "";
    if (!a || global.died) return false;
    if (hitKey(x, y) === a) act(a);
    return true;
}
// over any perk button (the aim mode lets go there)
export function hit(x, y) {
    if (global.died) return false;
    if (S.view === "cards" && (L.rectAt(S.cardRects, x, y) >= 0 || (S.laterRect && L.rectAt([S.laterRect], x, y) >= 0))) return true;
    return !!(S.chipRect && offerUp() && L.rectAt([S.chipRect], x, y) >= 0);
}
// the card row's box this frame (hudAvoidRects), or null
export function avoidRect() {
    if (S.view === "cards" && S.cardRects.length) {
        const r0 = S.cardRects[0], r1 = S.cardRects[S.cardRects.length - 1];
        const top = S.headRect ? S.headRect.y : r0.y;
        return { x: r0.x, y: top, w: r1.x + r1.w - r0.x, h: r0.y + r0.h - top };
    }
    return null;
}

// ── the HUD ────────────────────────────────────────────────────────────
// o: { wallet (the satchel pills' rect), bottom, minTop, left, right,
//      blocked, score, mouse: {x, y}, touchK }
export function drawHud(c, o) {
    S.cardRects.length = 0; S.iconRects.length = 0;
    S.headRect = null; S.laterRect = null; S.chipRect = null; S.badgeRect = null; S.stripBox = null;
    S.view = "";
    if (!A || !S.st || !o) return;
    const now = performance.now();
    if (global.died) { S.wasDead = true; S.hover = -1; return; }
    if (S.wasDead) {
        // back from the dead: an offer that waited opens again
        S.wasDead = false;
        if (S.key) { S.folded = false; S.openedAt = now; }
    }
    const st = S.st;
    // the pick animation runs on the old cards; done, they're gone
    if (S.picked >= 0 && now - S.pickedAt > 620) { S.picked = -1; S.out = null; S.outRects = null; }
    const view = S.picked >= 0 ? "cards" : L.viewFor({ folded: S.folded, openedAt: S.openedAt, hover: S.hover >= 0, shown: S.shownKey === S.key },
        { now, key: S.key, blocked: !!o.blocked, hurtAt: global.hurtAt || -1e9, dealtAt: global.dealtAt || -1e9, hold: !!o.stage });
    // first time out (after a fight held it back): fly in from now
    if (view === "cards" && S.key && S.shownKey !== S.key) { S.shownKey = S.key; S.openedAt = now; }
    S.view = view;
    drawStrip(c, o, st, view, now);
    // the cards' row keeps above the build strip, however tall it got
    if (S.stripBox && S.stripBox.y - 10 < o.bottom) { cardOpt.bottom = S.stripBox.y - 10; o = Object.assign(cardO, o, cardOpt); }
    if (view === "cards") drawCards(c, o, st, now);
    else S.hover = -1;
    // how long the cursor has rested on what it's over (see DWELL_MS)
    const k = o.mouse ? hitKey(o.mouse.x, o.mouse.y) : "";
    if (k !== S.over) { S.over = k; S.overSince = now; }
}

const cardOpt = { bottom: 0 }, cardO = {};
// QA: where the strip went
export function stripBox() { return S.stripBox; }
// ── the build strip ────────────────────────────────────────────────────
const PERK_COL = {
    twin: "#f2b83c", blast: "#ff6a3d", magnet: "#ff4a5a", drill: "#e9c46a", chain: "#8fd3ff", drones: "#b98bff",
    satchel: "#d39a5a", regen: "#3fcf7a", speed: "#4ec4e8", pierce: "#ff9f43", crit: "#ffd76e",
    hide: "#a9b4c8", rich: "#3fe0b0", reload: "#ff5ad8", quake: "#d9904a", vamp: "#e0473b",
};
function perkCol(p) { return PERK_COL[(p && (p.icon || p.id)) || ""] || "#e9e0cc"; }
const ROMAN = ["", "I", "II", "III", "IV", "V"];
const perkLabel = (p) => (p.name || p.id) + " " + (ROMAN[p.n | 0] || "I");

function drawStrip(c, o, st, view, now) {
    if (!o.wallet) return;
    const H = A.HUD;
    const n = st.build.length;
    const waiting = !!st.offer && S.picked < 0;
    // the chip: a gold pill while an offer waits folded
    const chipTxt = "Perk ready";
    const chipOn = waiting && view === "chip";
    const chipW = chipOn ? Math.round(A.hudTitleW(chipTxt, 13) + 22 + (global.mobile ? 0 : A.hudTitleW("Shift+1", 9.5) + 14)) : 0;
    // the progress badge shows once there's something to show (not on a
    // first raid's bare HUD until it's halfway to the first pick)
    const score = +o.score || 0;
    const showBadge = n > 0 || waiting || (o.stage == null || o.stage >= 1) || score >= st.step / 2;
    if (!n && !chipOn && !showBadge) return;
    // each perk says its name and level ("Power Drill II")
    const minX = o.stripLeft != null ? o.stripLeft : o.left != null ? o.left : 240, chip0 = chipOn ? chipW : L.STRIP.s;
    const w0 = o.wallet;
    if (S.stripFor !== st || S.stripMinX !== minX || S.stripChip !== chip0 || S.stripWx !== w0.x || S.stripWy !== w0.y) {
        S.stripFor = st; S.stripMinX = minX; S.stripChip = chip0; S.stripWx = w0.x; S.stripWy = w0.y;
        const s0 = L.STRIP.s;
        const full = st.build.map(p => Math.round(s0 + 4 + A.hudTitleW(perkLabel(p), 12) + 10));
        const lvl = st.build.map(p => Math.round(s0 + 2 + A.hudTitleW(ROMAN[p.n | 0] || "I", 12) + 8));
        S.strip = L.stripPlan(w0, full, lvl, chip0, minX, 38);
        S.stripTip = null;
    }
    const lay = S.strip;
    S.stripBox = lay ? lay.box : null;
    if (!lay) return;
    const mode = lay.mode;
    // icons
    for (let i = 0; i < n; i++) {
        const p = st.build[i], r = lay.icons[i];
        if (!r) continue;
        S.iconRects.push(r);
        const fl = p.id === S.flashId && now - S.flashAt < 1100 ? 1 - (now - S.flashAt) / 1100 : 0;
        const lift = fl * 6;
        A.hudPanel(c, r.x, r.y - lift, r.w, r.h, { r: 7, lip: 2, fill: fl > 0.6 ? "#fff3d9" : "rgba(0,0,0,0.54)" });
        drawPerkIcon(c, p, r.x + r.h / 2, r.y - lift + r.h / 2, r.h * 0.34);
        // the name in the perk's colour, then its level in gold
        const lv = ROMAN[p.n | 0] || "I", tx = r.x + r.h + 2, ty = r.y - lift + r.h / 2 + 0.5;
        const ink = fl > 0.6 ? "#3a2c1a" : null;
        if (mode === 2) {
            A.hudTitle(p.name || p.id, tx, ty, 12, ink || "#fff3d9", "left");
            A.hudTitle(lv, tx + A.hudTitleW((p.name || p.id) + " ", 12), ty, 12, ink || GOLD, "left");
        } else A.hudTitle(lv, tx, ty, 12, ink || GOLD, "left");
        if (o.mouse && L.rectAt([r], o.mouse.x, o.mouse.y) >= 0 && A.queueTip) {
            A.queueTip(perkLabel(p), (p.desc || "") + " You have level " + (p.n | 0 || 1) + (p.max ? " of " + p.max : "") + ", and it lasts the whole raid.", r.x + r.w / 2, r.y);
        }
    }
    // the ones left out, behind a "+N" chip (hover lists them)
    if (lay.more) {
        const m = lay.more;
        S.iconRects.push(m);
        A.hudPanel(c, m.x, m.y, m.w, m.h, { r: 7, lip: 2, fill: "rgba(0,0,0,0.6)" });
        A.hudTitle("+" + m.n, m.x + m.w / 2, m.y + m.h / 2 + 0.5, 12, GOLD, "center");
        if (o.mouse && L.rectAt([m], o.mouse.x, o.mouse.y) >= 0 && A.queueTip) {
            if (!S.stripTip) S.stripTip = lay.hidden.map(i => perkLabel(st.build[i])).join(", ") + ".";
            A.queueTip(m.n + " more perk" + (m.n > 1 ? "s" : ""), S.stripTip, m.x + m.w / 2, m.y);
        }
    }
    // a fresh pick says its name above the strip for a moment
    if (S.gotName && now - S.flashAt < 1600 && lay.box) {
        const k = (now - S.flashAt) / 1600, a = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
        const r = lay.icons[Math.max(0, st.build.findIndex(p => p.id === S.flashId))] || lay.icons[lay.icons.length - 1] || lay.box;
        // above the top row, so it never sits on a chip
        const top = lay.box.y;
        A.hudTitle("+ " + S.gotName, r.x + r.w / 2, top - 16 - 10 * k, 13, GOLD, "center", a);
    }
    const b = lay.badge;
    if (chipOn) {
        S.chipRect = b;
        const pulse = calm() ? 0.5 : 0.5 + 0.5 * Math.sin(now / 260);
        if (glowOn() && A.haloSprite) {
            c.save(); c.globalAlpha = 0.35 + 0.35 * pulse;
            c.drawImage(A.haloSprite("pkchip", "242,184,60", [[0, 0.55], [0.6, 0.15], [1, 0]]), b.x - 16, b.y - 16, b.w + 32, b.h + 32);
            c.restore();
        }
        const hov = o.mouse && L.rectAt([b], o.mouse.x, o.mouse.y) >= 0;
        A.hudPanel(c, b.x, b.y, b.w, b.h, { r: b.h / 2, lip: 2.5, fill: hov ? "#c58d1c" : GOLD_DK, stroke: H.line });
        // a little star, then the words, then the key
        star(c, b.x + 13, b.y + b.h / 2, 6, 2.6, "#fff3d9");
        A.hudTitle(chipTxt, b.x + 23, b.y + b.h / 2 + 0.5, 13, "#fff3d9", "left");
        if (!global.mobile) {
            const kx = b.x + 23 + A.hudTitleW(chipTxt, 13) + 7;
            A.hudKey(c, kx, b.y + 5, "Shift+1", b.h - 10);
        }
        const q = st.queued | 0;
        if (q > 0) {
            // how many more are waiting behind this one
            const qx = b.x + 3, qy = b.y + 1;
            c.beginPath(); c.arc(qx, qy, 8, 0, TAU); c.fillStyle = "#e0473b"; c.fill(); c.lineWidth = 1.5; c.strokeStyle = H.line; c.stroke();
            A.hudTitle(String(q + 1), qx, qy + 0.5, 10, "#fff3d9", "center");
        }
        if (hov && A.queueTip) A.queueTip("Pick a perk", (global.mobile ? "Tap to see your 3 choices." : "Click or press Shift+1 to see your 3 choices."), b.x + b.w / 2, b.y);
    } else if (showBadge) {
        S.badgeRect = b;
        // a ring filling toward the next pick, your pick count inside
        const frac = waiting ? 1 : L.progress(score, st.next, st.step);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2, R = b.w / 2;
        c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = "rgba(0,0,0,0.57)"; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = H.line; c.stroke();
        if (frac > 0.01) {
            c.beginPath(); c.arc(cx, cy, R - 3.5, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
            c.lineWidth = 3.5; c.lineCap = "round"; c.strokeStyle = GOLD; c.stroke(); c.lineCap = "butt";
        }
        const tot = L.totalPicks(st.build);
        if (tot > 0) A.hudTitle(String(tot), cx, cy + 0.5, 11, "#fff3d9", "center");
        else star(c, cx, cy, 5.5, 2.4, "rgba(255,243,217,0.55)");
        if (o.mouse && L.rectAt([b], o.mouse.x, o.mouse.y) >= 0 && A.queueTip) {
            A.queueTip("Raid perks", "You get a perk every 5,000 points. Next one at " + L.fmtNum(st.next) + ", you have " + L.fmtNum(score) + ".", cx, b.y);
        }
    }
}
function star(c, x, y, r, ri, col) {
    c.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? ri : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    c.closePath();
    c.fillStyle = col; c.fill(); c.lineWidth = 1.2; c.strokeStyle = A.HUD.line; c.stroke();
}

// ── the cards ──────────────────────────────────────────────────────────
function drawCards(c, o, st, now) {
    const H = A.HUD, W = global.screenWidth;
    const offer = S.picked >= 0 ? S.out : st.offer;
    if (!offer || !offer.length) return;
    const lay = L.cardLayout(W, offer.length, { bottom: o.bottom, minTop: o.minTop, left: o.left, right: o.right, mobile: !!global.mobile });
    const rects = S.picked >= 0 && S.outRects ? S.outRects : lay.rects;
    for (const r of rects) S.cardRects.push(r);
    const compact = rects.length && rects[0].h < L.CARD.h;
    const age = now - S.openedAt, still = calm();
    // hover from the mouse (HUD units)
    let hov = -1;
    if (o.mouse && S.picked < 0) hov = L.rectAt(rects, o.mouse.x, o.mouse.y);
    if (hov !== S.hover && hov >= 0) sfx("uiClick");
    S.hover = hov;
    // the header: what this is and how to pick
    const ha = Math.min(1, age / 200) * (S.picked >= 0 ? Math.max(0, 1 - (now - S.pickedAt) / 300) : 1);
    if (lay.head && ha > 0.01) drawHeader(c, lay.head, st, ha, now);
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i], p = offer[i];
        const t = still ? 1 : Math.max(0, Math.min(1, (age - i * 60) / 320));
        if (t <= 0) continue;
        // easeOutBack: a little overshoot as it lands
        const k = 1.70158, e = 1 + (k + 1) * Math.pow(t - 1, 3) + k * Math.pow(t - 1, 2);
        let dy = (1 - e) * 90, a = Math.min(1, t * 2), sc = 1;
        if (S.picked >= 0) {
            const pt = Math.min(1, (now - S.pickedAt) / 600);
            if (i === S.picked) { sc = 1 + 0.1 * Math.sin(Math.min(1, pt * 2) * Math.PI); a = pt < 0.6 ? 1 : 1 - (pt - 0.6) / 0.4; dy -= pt * 24; }
            else { dy += pt * pt * 160; a *= 1 - pt; }
        } else if (i === hov) { dy -= 6; sc = 1.02; }
        if (a <= 0.01) continue;
        drawCard(c, r, p, i, dy, sc, a, i === hov || i === S.picked, compact, now);
    }
    // hover: the whole description and what this pick changes (round 8: "even with
    if (hov >= 0 && A.queueTip && S.picked < 0) {
        const p = offer[hov], r = rects[hov];
        if (S.tipFor !== p) { S.tipFor = p; S.tip = L.hoverText(p); }
        if (S.tip) A.queueTip(S.tip.title, S.tip.body, r.x + r.w / 2, r.y - 6);
    }
}
// Round 8, tidier: "Perk ready · pick any time [Shift] + [1][2][3] or click (+1
function drawHeader(c, hr, st, a, now) {
    const H = A.HUD;
    const cx = hr.x + hr.w / 2, cy = hr.y + hr.h / 2;
    // veterans see it's new the first time (newcomers get the intro note)
    const isNew = !newSeen() && (A.newcomerStage ? A.newcomerStage() >= 3 : true);
    const q = st.queued | 0;
    const title = L.HEAD_TITLE, note = L.HEAD_NOTE;
    const G = 10, kh = 16;
    const more = q > 0 ? "+" + q + " more" : "";
    const tagW = isNew ? A.hudTitleW("NEW FEATURE", 9.5) + 14 : 0;
    const tw = A.hudTitleW(title, 16), nw = A.hudTextW(note, 11.5);
    const mw = more ? A.hudTitleW(more, 11) + 16 : 0;
    // keys: [Shift] + [1] [2] [3] or click (touch: "tap one")
    const kw = (t) => Math.max(kh, A.hudTitleW(t, kh * 0.62) + kh * 0.55);
    const plusW = A.hudTextW("+", 11), orW = A.hudTextW("or click", 11.5), tapW = A.hudTextW("Tap one", 11.5);
    const keysW = global.mobile ? tapW : kw("Shift") + 4 + plusW + 4 + kw("1") * 3 + 6 + 8 + orW;
    const base = 12 + (tagW ? tagW + 8 : 0) + tw + G + nw + (mw ? G + mw : 0) + 12;
    const keys = base + G + keysW <= hr.w;
    const w = Math.min(hr.w, base + (keys ? G + keysW : 0));
    const x = Math.round(cx - w / 2), h = hr.h;
    const y = Math.round(cy - h / 2);
    S.headRect = { x, y, w, h };
    A.hudPanel(c, x, y, w, h, { r: h / 2, lip: 2, alpha: a, fill: "rgba(0,0,0,0.6)" });
    let tx = x + 12;
    c.save(); c.globalAlpha *= a;
    if (isNew) {
        A.rr(c, tx, y + 4, tagW, h - 8, (h - 8) / 2); c.fillStyle = TEAL; c.fill();
        A.drawText("NEW FEATURE", tx + tagW / 2, cy + 0.5, 9.5, INK, "center", true, a, false);
        tx += tagW + 8;
    }
    c.restore();
    A.hudTitle(title, tx, cy + 0.5, 16, GOLD, "left", a);
    tx += tw + G;
    A.drawText(note, tx, cy + 0.5, 11.5, H.text2, "left", true, a);
    tx += nw + G;
    if (keys) {
        if (global.mobile) { A.drawText("Tap one", tx, cy + 0.5, 11.5, H.text, "left", true, a); tx += tapW; }
        else {
            const ky = Math.round(cy - kh / 2);
            tx += A.hudKey(c, tx, ky, "Shift", kh, a) + 4;
            A.drawText("+", tx, cy + 0.5, 11, H.text2, "left", true, a); tx += plusW + 4;
            for (const k of ["1", "2", "3"]) tx += A.hudKey(c, tx, ky, k, kh, a) + 2;
            tx += 6;
            A.drawText("or click", tx, cy + 0.5, 11.5, H.text2, "left", true, a); tx += orW;
        }
        tx += G;
    }
    if (more) {
        c.save(); c.globalAlpha *= a;
        A.rr(c, tx, y + 4, mw, h - 8, (h - 8) / 2); c.fillStyle = "rgba(242,184,60,0.18)"; c.fill();
        c.restore();
        A.hudTitle(more, tx + mw / 2, cy + 0.5, 11, GOLD, "center", a);
    }
}
// up to `max` lines (the last one trimmed with an ellipsis), cached per card
function wrapLines(text, size, maxW, max) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
        const t = cur ? cur + " " + w : w;
        if (!cur || A.hudTextW(t, size) <= maxW) { cur = t; continue; }
        lines.push(cur); cur = w;
    }
    if (cur) lines.push(cur);
    if (lines.length > max) {
        let last = lines.slice(max - 1).join(" ");
        while (last.length > 1 && A.hudTextW(last + "…", size) > maxW) last = last.slice(0, -1);
        lines.length = max - 1; lines.push(last + "…");
    }
    return lines;
}
const wrapCache = new Map();
// the name without the level the server glued on, cached per offer
const nameCache = new Map();
function cardName(p) {
    let n = nameCache.get(p.name);
    if (n === undefined) { n = L.baseName(p.name || p.id); if (nameCache.size > 60) nameCache.clear(); nameCache.set(p.name, n); }
    return n;
}
// Round 8 card: a colour cap, the icon in a disc with the level this pick gives
function drawCard(c, r, p, i, dy, sc, a, lit, compact, now) {
    const H = A.HUD;
    const col = perkCol(p);
    c.save();
    c.globalAlpha *= a;
    c.translate(r.x + r.w / 2, r.y + r.h / 2 + dy);
    c.scale(sc, sc);
    const x = -r.w / 2, y = -r.h / 2, w = r.w, h = r.h;
    if (lit && glowOn() && A.haloSprite) {
        const g = A.haloSprite("pkcard", "242,184,60", [[0, 0.45], [0.6, 0.12], [1, 0]]);
        c.drawImage(g, x - 30, y - 30, w + 60, h + 60);
    }
    A.hudPanel(c, x, y, w, h, { r: 12, fill: "rgba(0,0,0,0.55)", lip: 3 });
    // the colour cap along the top
    c.save();
    A.rr(c, x, y, w, h, 12); c.clip();
    c.fillStyle = col;
    c.fillRect(x, y, w, 5);
    c.fillStyle = "rgba(255,255,255,0.04)";
    c.fillRect(x, y + 5, w, compact ? 38 : 52);
    c.restore();
    if (lit) { A.rr(c, x, y, w, h, 12); c.lineWidth = 2.5; c.strokeStyle = GOLD; c.stroke(); }
    // the icon in a disc
    const bob = lit && !calm() ? Math.sin(now / 160) * 1.2 : 0;
    const ir = compact ? 15 : 19;
    const ix = x + 12 + ir, iy = y + (compact ? 9 + ir : 12 + ir) + bob;
    c.beginPath(); c.arc(ix, iy, ir, 0, TAU);
    c.fillStyle = H.wellSolid; c.fill();
    c.lineWidth = 2.2; c.strokeStyle = col; c.stroke();
    drawPerkIcon(c, p, ix, iy, ir * 0.6);
    // the level badge on the disc's lower right: what this pick makes it
    const lv = L.roman(L.nextLevel(p));
    const bh = compact ? 15 : 17, bw = Math.max(bh, A.hudTitleW(lv, bh * 0.68) + 9);
    const bx = ix + ir * 0.55, by = iy + ir * 0.5;
    A.hudPanel(c, bx - bw / 2, by - bh / 2, bw, bh, { r: bh / 2, lip: 1.5, fill: (p.n | 0) > 0 ? GOLD : TEAL, stroke: H.line });
    A.hudTitle(lv, bx, by + 0.5, bh * 0.68, INK, "center");
    // the key to press, top right (touch: nothing, the card is the button)
    let kx = x + w - 8;
    if (!global.mobile) {
        const kt = String(i + 1);
        const kh = 20;
        const kw = Math.max(kh, A.hudTitleW(kt, 12) + 11);
        kx = x + w - kw - 9;
        const ky = y + 11;
        A.hudPanel(c, kx, ky, kw, kh, { r: 5, lip: 2, fill: lit ? GOLD : H.face });
        A.hudTitle(kt, kx + kw / 2, ky + kh / 2 - 0.5, 12, lit ? "#2a1a05" : H.head, "center");
    }
    // the name (never glued to its level) and pips for the levels
    const name = cardName(p);
    const nx = ix + ir + 12, room = kx - nx - 6;
    let ns = compact ? 16 : 18;
    while (ns > 12 && A.hudTitleW(name, ns) > room) ns -= 0.5;
    const max = +p.max || 0, have = +p.n || 0;
    const nameY = compact ? y + 22 : y + (max > 1 ? 26 : 33);
    A.hudTitle(name, nx, nameY, ns, H.head, "left");
    if (max > 1 && !compact) {
        const py = y + 45;
        for (let k = 0; k < Math.min(max, 6); k++) {
            const px = nx + 4 + k * 12;
            c.beginPath(); c.arc(px, py, 3.8, 0, TAU);
            c.fillStyle = k < have ? col : k === have ? "#fff3d9" : "rgba(255,255,255,0.12)"; c.fill();
            c.lineWidth = 1.1; c.strokeStyle = H.line; c.stroke();
        }
        A.drawText(have > 0 ? "level " + lv + " of " + L.roman(max) : "new", nx + 4 + Math.min(max, 6) * 12 + 4, py + 0.5, 10.5, H.text2, "left", true, 1);
    }
    // what it does: the whole line, wrapped (cached per card) (compact: no pip row
    const lines = 3;
    const tx = x + 13, tw = w - 26;
    const key = p.id + "|" + p.desc + "|" + Math.round(tw) + "|" + lines;
    let ls = wrapCache.get(key);
    if (!ls) { ls = wrapLines(p.desc, L.DESC_SIZE, tw, lines); if (wrapCache.size > 60) wrapCache.clear(); wrapCache.set(key, ls); }
    const ty0 = compact ? y + 48 : y + 70;
    for (let k = 0; k < ls.length; k++) A.drawText(ls[k], tx, ty0 + k * L.DESC_LH, L.DESC_SIZE, H.text, "left", true, 1);
    c.restore();
}

// ── the icons ──────────────────────────────────────────────────────────
// the perk's glyph in its colour, inked like the rest of the HUD
export function drawPerkIcon(c, p, x, y, r) {
    const col = perkCol(p);
    c.save();
    c.translate(x, y);
    c.lineJoin = "round"; c.lineCap = "round";
    const ink = A.HUD.line, lw = Math.max(1.2, r * 0.17);
    const fillInk = () => { c.fillStyle = col; c.fill(); c.lineWidth = lw; c.strokeStyle = ink; c.stroke(); };
    const strokeCol = (w) => { c.lineWidth = w + lw * 2; c.strokeStyle = ink; c.stroke(); c.lineWidth = w; c.strokeStyle = col; c.stroke(); };
    const k = String((p && (p.icon || p.id)) || "");
    if (GLYPH[k]) GLYPH[k](c, r, fillInk, strokeCol, col);
    else { c.beginPath(); c.arc(0, 0, r * 0.8, 0, TAU); fillInk(); }
    c.restore();
}
const GLYPH = {
    // two barrels side by side on a round hull
    twin(c, r, F) {
        for (const sx of [-0.42, 0.42]) { c.beginPath(); c.rect(r * sx - r * 0.2, -r * 1.0, r * 0.4, r * 1.1); F(); }
        c.beginPath(); c.arc(0, r * 0.35, r * 0.62, 0, TAU); F();
    },
    // a spiky starburst
    blast(c, r, F) {
        c.beginPath();
        for (let i = 0; i < 16; i++) { const a = i / 16 * TAU, rr = i % 2 ? r * 0.48 : r * 1.0; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        c.closePath(); F();
    },
    // a horseshoe magnet with white tips
    magnet(c, r, F, S) {
        c.beginPath(); c.arc(0, -r * 0.05, r * 0.62, Math.PI, 0, false); c.moveTo(-r * 0.62, -r * 0.05); c.lineTo(-r * 0.62, r * 0.7); c.moveTo(r * 0.62, -r * 0.05); c.lineTo(r * 0.62, r * 0.7);
        S(r * 0.42);
        c.fillStyle = "#f4f4f4";
        c.fillRect(-r * 0.83, r * 0.5, r * 0.42, r * 0.36); c.fillRect(r * 0.41, r * 0.5, r * 0.42, r * 0.36);
    },
    // a drill bit with its thread
    drill(c, r, F) {
        c.beginPath(); c.moveTo(-r * 0.55, -r * 0.75); c.lineTo(r * 0.55, -r * 0.75); c.lineTo(0, r * 1.05); c.closePath(); F();
        c.beginPath(); c.moveTo(-r * 0.4, -r * 0.3); c.lineTo(r * 0.38, -r * 0.08); c.moveTo(-r * 0.24, r * 0.15); c.lineTo(r * 0.22, r * 0.33);
        c.lineWidth = Math.max(1, r * 0.13); c.strokeStyle = A.HUD.line; c.stroke();
        c.beginPath(); c.rect(-r * 0.32, -r * 1.05, r * 0.64, r * 0.3); F();
    },
    // a lightning bolt
    chain(c, r, F) {
        c.beginPath();
        c.moveTo(r * 0.25, -r * 1.05); c.lineTo(-r * 0.55, r * 0.12); c.lineTo(-r * 0.02, r * 0.12); c.lineTo(-r * 0.3, r * 1.05); c.lineTo(r * 0.6, -r * 0.2); c.lineTo(r * 0.05, -r * 0.2); c.closePath();
        F();
    },
    // three drones in a V
    drones(c, r, F) {
        const tri = (x, y, s) => { c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s * 0.9, y + s * 0.7); c.lineTo(x - s * 0.9, y + s * 0.7); c.closePath(); F(); };
        tri(0, -r * 0.35, r * 0.55); tri(-r * 0.6, r * 0.35, r * 0.42); tri(r * 0.6, r * 0.35, r * 0.42);
    },
    // a satchel with its flap
    satchel(c, r, F) {
        c.beginPath(); c.arc(0, -r * 0.45, r * 0.38, Math.PI, 0); c.lineWidth = r * 0.16 + 2; c.strokeStyle = A.HUD.line; c.stroke();
        A.rr(c, -r * 0.85, -r * 0.45, r * 1.7, r * 1.35, r * 0.3); F();
        c.beginPath(); c.moveTo(-r * 0.85, -r * 0.1); c.lineTo(0, r * 0.35); c.lineTo(r * 0.85, -r * 0.1); c.lineWidth = Math.max(1, r * 0.13); c.strokeStyle = A.HUD.line; c.stroke();
    },
    // a fat plus
    regen(c, r, F) {
        const a = r * 0.34, b = r * 0.95;
        c.beginPath();
        c.moveTo(-a, -b); c.lineTo(a, -b); c.lineTo(a, -a); c.lineTo(b, -a); c.lineTo(b, a); c.lineTo(a, a); c.lineTo(a, b); c.lineTo(-a, b); c.lineTo(-a, a); c.lineTo(-b, a); c.lineTo(-b, -a); c.lineTo(-a, -a); c.closePath();
        F();
    },
    // double chevrons
    speed(c, r, F, S) {
        c.beginPath(); c.moveTo(-r * 0.85, -r * 0.7); c.lineTo(-r * 0.15, 0); c.lineTo(-r * 0.85, r * 0.7);
        c.moveTo(-r * 0.05, -r * 0.7); c.lineTo(r * 0.65, 0); c.lineTo(-r * 0.05, r * 0.7);
        S(r * 0.34);
    },
    // an arrow through a wall
    pierce(c, r, F, S) {
        c.fillStyle = "#6d6276"; c.fillRect(-r * 0.12, -r * 0.95, r * 0.24, r * 1.9);
        c.beginPath(); c.moveTo(-r * 1.0, 0); c.lineTo(r * 0.55, 0); S(r * 0.26);
        c.beginPath(); c.moveTo(r * 1.05, 0); c.lineTo(r * 0.4, -r * 0.45); c.lineTo(r * 0.4, r * 0.45); c.closePath(); F();
    },
    // a four-point glint in a crosshair
    crit(c, r, F, S) {
        c.beginPath(); c.arc(0, 0, r * 0.78, 0, TAU); S(r * 0.16);
        c.beginPath();
        for (let i = 0; i < 8; i++) { const a = i / 8 * TAU - Math.PI / 2, rr = i % 2 ? r * 0.2 : r * 0.62; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        c.closePath(); F();
    },
    // a shield
    hide(c, r, F) {
        c.beginPath();
        c.moveTo(0, -r); c.quadraticCurveTo(r * 0.55, -r * 0.7, r * 0.88, -r * 0.75); c.quadraticCurveTo(r * 0.95, r * 0.35, 0, r * 1.05);
        c.quadraticCurveTo(-r * 0.95, r * 0.35, -r * 0.88, -r * 0.75); c.quadraticCurveTo(-r * 0.55, -r * 0.7, 0, -r); c.closePath();
        F();
        c.fillStyle = "rgba(255,255,255,0.35)"; c.fillRect(-r * 0.1, -r * 0.7, r * 0.2, r * 1.3);
    },
    // the gem cut, with a facet
    rich(c, r, F) {
        c.beginPath(); c.moveTo(-r, -r * 0.3); c.lineTo(-r * 0.55, -r * 0.85); c.lineTo(r * 0.55, -r * 0.85); c.lineTo(r, -r * 0.3); c.lineTo(0, r * 0.95); c.closePath(); F();
        c.beginPath(); c.moveTo(-r, -r * 0.3); c.lineTo(r, -r * 0.3); c.moveTo(-r * 0.3, -r * 0.3); c.lineTo(0, r * 0.95); c.lineTo(r * 0.3, -r * 0.3);
        c.lineWidth = Math.max(1, r * 0.1); c.strokeStyle = "rgba(0,0,0,0.55)"; c.stroke();
    },
    // a circular arrow
    reload(c, r, F, S) {
        c.beginPath(); c.arc(0, 0, r * 0.68, -Math.PI * 0.35, Math.PI * 1.35); S(r * 0.3);
        const a = -Math.PI * 0.35, ex = Math.cos(a) * r * 0.68, ey = Math.sin(a) * r * 0.68;
        c.beginPath(); c.moveTo(ex + r * 0.42, ey - r * 0.05); c.lineTo(ex - r * 0.12, ey - r * 0.45); c.lineTo(ex - r * 0.1, ey + r * 0.35); c.closePath(); F();
    },
    // shock rings round a dot
    quake(c, r, F, S) {
        c.beginPath(); c.arc(0, 0, r * 0.9, -0.6, 0.6); c.moveTo(Math.cos(Math.PI - 0.6) * r * 0.9, Math.sin(Math.PI - 0.6) * r * 0.9); c.arc(0, 0, r * 0.9, Math.PI - 0.6, Math.PI + 0.6);
        S(r * 0.18);
        c.beginPath(); c.arc(0, 0, r * 0.55, -0.7, 0.7); c.moveTo(Math.cos(Math.PI - 0.7) * r * 0.55, Math.sin(Math.PI - 0.7) * r * 0.55); c.arc(0, 0, r * 0.55, Math.PI - 0.7, Math.PI + 0.7);
        S(r * 0.18);
        c.beginPath(); c.arc(0, 0, r * 0.24, 0, TAU); F();
    },
    // a drop
    vamp(c, r, F) {
        c.beginPath(); c.moveTo(0, -r); c.bezierCurveTo(r * 0.35, -r * 0.45, r * 0.8, -r * 0.05, r * 0.8, r * 0.3);
        c.arc(0, r * 0.3, r * 0.8, 0, Math.PI); c.bezierCurveTo(-r * 0.8, -r * 0.05, -r * 0.35, -r * 0.45, 0, -r); c.closePath();
        F();
        c.fillStyle = "rgba(255,255,255,0.45)"; c.beginPath(); c.arc(-r * 0.3, r * 0.3, r * 0.17, 0, TAU); c.fill();
    },
};

// ── the death card ─────────────────────────────────────────────────────
// app.js: "Your perks stay until the raid ends." with the build's icons
export function deathLine() { return L.deathLine(build()); }
export function drawDeathIcons(c, x, y, s, a) {
    const b = build();
    if (!A || !b.length) return 0;
    c.save(); c.globalAlpha *= a;
    let px = x;
    for (const p of b.slice(0, 10)) {
        A.hudPanel(c, px, y - s / 2, s, s, { r: 5, lip: 1.5, fill: "rgba(0,0,0,0.55)" });
        drawPerkIcon(c, p, px + s / 2, y, s * 0.34);
        px += s + 3;
    }
    c.restore();
    return px - x;
}
