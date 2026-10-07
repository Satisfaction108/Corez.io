// The in-raid achievement card: a small plate that slides in on the right
// (app.js side-note lane, under the kill feed, clear of the crown tracker
// above it and the perk cards low in the middle), one at a time, queued.
// Rules (what shows when, the words) are achievementsLogic.js; this file is
// the queue glue and the drawing. socketinit's 'ACH' -> window.dwAch ->
// receive(); app.js drawSideNote -> pump() + draw().
//
// Newcomer stage 0 holds everything but First Steps (localStorage
// dwAchHeld_v1); they come out once the stage moves on.
import * as L from "./achievementsLogic.js";
import { glyphPath } from "./account/achievements.js";
import { global } from "./global.js";

const HELD_KEY = "dwAchHeld_v1";
let A = null;              // helpers from app.js
const queue = [];          // waiting to be shown
let held = null;           // waiting for the stage

export function init(helpers) { A = helpers; }

function ls(get, v) {
    try {
        if (get) return JSON.parse(localStorage.getItem(HELD_KEY) || "[]");
        localStorage.setItem(HELD_KEY, JSON.stringify(v));
    } catch (e) { /* private mode */ }
    return [];
}
function heldList() {
    if (!held) { held = ls(true); if (!Array.isArray(held)) held = []; }
    return held;
}

// An unlock from the server (ACH packet).
export function receive(d) {
    if (!d || !d.id) return;
    // the home rail button's "new" dot (account/achievementsPanel.js)
    try {
        const k = "dwAchNew_v1", n = JSON.parse(localStorage.getItem(k) || "[]");
        if (Array.isArray(n) && n.indexOf(d.id) < 0) { n.push(d.id); localStorage.setItem(k, JSON.stringify(n.slice(-60))); }
    } catch (e) { /* private mode */ }
    const v = L.admit(d, global.nxStage);
    if (v === "drop") return;
    if (v === "hold") {
        const h = heldList();
        if (!h.some((x) => x.id === d.id)) { h.push(d); if (h.length > L.HELD_MAX) h.shift(); ls(false, h); }
        return;
    }
    L.enqueue(queue, d);
}

// Every frame from drawSideNote: held ones that may show now, then the
// next card into the side-note lane when no achievement card is up.
export function pump(sideNotes) {
    if (held === null || held.length) {
        const r = L.release(heldList(), global.nxStage);
        if (r.show.length || r.summary) {
            for (const d of r.show) L.enqueue(queue, d);
            if (r.summary) L.enqueue(queue, { summary: r.summary });
            held = r.rest;
            ls(false, held);
        }
    }
    if (!queue.length || !global.sideNote) return;
    for (const n of sideNotes) if (n.kind === "ach") return;
    const d = queue.shift();
    global.sideNote({ kind: "ach", id: d.id || "", title: d.name || "Achievement", ach: d, dur: L.durationFor(queue.length) });
}
export function waiting() { return queue.length; }

const itemName = (id) => {
    try { const it = id && window.DWCosmetics && window.DWCosmetics.byId(id); return it ? it.name : ""; } catch (e) { return ""; }
};

// the largest size (down to 75%) at which `text` fits `room`
function fitSize(text, size, room, measure) {
    const w = measure(text, size);
    return w <= room ? size : Math.max(size * 0.75, size * room / w);
}

// Draw one card, right edge at `right`, top at y. -> its height
export function draw(c, n, right, y, age, dur) {
    if (!A) return 0;
    const d = n.ach;
    const HUD = A.HUD;
    if (!n.txt) n.txt = L.cardText(d, itemName(d.item));
    const t = n.txt;
    const mobile = !!global.mobile;
    const titleSz = mobile ? 14 : 16, descSz = mobile ? 10 : 11, labelSz = 9.5;
    const titleStr = t.title + (t.tier ? " " + t.tier : "");
    const textW = Math.max(A.hudTitleW(titleStr, titleSz), A.hudTextW(t.desc, descSz), t.reward ? A.hudTextW(t.reward, descSz) + 6 : 0, A.hudTextW(t.label.toUpperCase(), labelSz));
    const maxW = Math.min(360, global.screenWidth * (mobile ? 0.46 : 0.3));
    const W = Math.round(Math.min(maxW, Math.max(220, textW + 76)));
    const H = t.reward ? 74 : 58;
    // in: a quick slide with a little overshoot; out: fade
    const kIn = Math.min(1, age / 260);
    const ease = 1 - Math.pow(1 - kIn, 3) * (1 - 1.6 * kIn * (1 - kIn));
    const a = Math.max(0, Math.min(1, age / 140, (dur - age) / 320));
    // centred in the lane under the raid clock (n.centreX), or right-aligned
    const x = n.centreX != null ? Math.round(n.centreX - W / 2) : right - W + Math.round((1 - ease) * (W * 0.6));
    if (!n.sounded) {
        n.sounded = true;
        try { if (window.gameSound && window.gameSound.achievement) window.gameSound.achievement(!!d.secret || !!d.summary); } catch (e) { /* */ }
    }
    A.hudPanel(c, x, y, W, H, { alpha: a });
    c.save();
    c.globalAlpha *= a;
    // the medal's colour along the left edge
    const col = d.summary ? HUD.gold : (d.color || HUD.gold);
    A.rr(c, x + 1.5, y + 1.5, W - 3, H - 3, HUD.r);
    c.lineWidth = 2;
    c.strokeStyle = col;
    c.globalAlpha *= 0.85;
    c.stroke();
    c.globalAlpha /= 0.85;
    // a light sweep across the plate as it lands
    if (age > 120 && age < 820) {
        const k = (age - 120) / 700;
        const sx = x - 60 + (W + 120) * k;
        c.save();
        A.rr(c, x, y, W, H, HUD.r);
        c.clip();
        const g = c.createLinearGradient(sx - 40, 0, sx + 40, 0);
        g.addColorStop(0, "rgba(255,255,255,0)");
        g.addColorStop(0.5, "rgba(255,255,255,0.16)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = g;
        c.fillRect(x, y, W, H);
        c.restore();
    }
    // the medal: pops in, colour with the glyph in ink
    const mr = 19, mx = x + 12 + mr, my = y + (t.reward ? 30 : H / 2);
    const pop = age < 360 ? 1 + 0.28 * Math.sin(Math.min(1, age / 360) * Math.PI) : 1;
    c.save();
    c.translate(mx, my);
    c.scale(pop, pop);
    c.beginPath(); c.arc(0, 2.5, mr, 0, Math.PI * 2); c.fillStyle = HUD.drop; c.fill();
    c.beginPath(); c.arc(0, 0, mr, 0, Math.PI * 2);
    c.fillStyle = col; c.fill();
    c.lineWidth = 2; c.strokeStyle = HUD.ink; c.stroke();
    // a soft lit top on the medal
    c.beginPath(); c.arc(0, 0, mr - 3, Math.PI * 1.1, Math.PI * 1.9);
    c.strokeStyle = "rgba(255,255,255,0.35)"; c.lineWidth = 2; c.stroke();
    const gp = glyphPath(d.summary ? "star" : (d.icon || "star"));
    if (gp) {
        c.save();
        c.translate(-13, -13); c.scale(26 / 24, 26 / 24);
        c.lineCap = "round"; c.lineJoin = "round";
        c.strokeStyle = HUD.ink; c.lineWidth = 2.5;
        c.stroke(gp);
        c.restore();
    }
    c.restore();
    // tier numeral on a little tab under the medal
    if (t.tier) {
        const tw = A.hudTextW(t.tier, 9) + 9;
        A.rr(c, mx - tw / 2, my + mr - 6, tw, 13, 4);
        c.fillStyle = HUD.ink; c.fill();
        A.drawText(t.tier, mx, my + mr + 0.5, 9, HUD.gold, "center", true);
    }
    // words (shrunk to fit, never past the plate)
    const tx = x + 12 + mr * 2 + 12;
    const room = W - (tx - x) - 10;
    A.drawText(t.label.toUpperCase(), tx, y + 13, labelSz, d.secret ? "#ff8fcf" : HUD.gold, "left", true);
    A.hudTitle(titleStr, tx, y + 30, fitSize(titleStr, titleSz, room, A.hudTitleW), HUD.head, "left");
    A.drawText(t.desc, tx, y + 46, fitSize(t.desc, descSz, room, A.hudTextW), HUD.text, "left", true);
    if (t.reward) {
        const rw = A.hudTextW(t.reward, descSz) + 12;
        const ry = y + 55;
        A.rr(c, tx - 2, ry, Math.min(rw, W - (tx - x) - 8), 15, 5);
        c.fillStyle = t.rewardKind === "guest" ? "rgba(242,184,60,0.16)" : "rgba(63,207,122,0.16)";
        c.fill();
        A.drawText(t.reward, tx + 4, ry + 7.5, descSz - 0.5, t.rewardKind === "guest" ? HUD.gold : HUD.emerald, "left", true);
    }
    c.restore();
    return H;
}

// QA: window.dwAchQ() shows the queue and the held list
window.dwAchQ = () => ({ queue: queue.slice(), held: heldList().slice(), stage: global.nxStage });
