import { global } from "./global.js";

const KIND_INFO = {
    storm: "A storm circle closes in over one part of the map, and the storm outside it hurts. You score every second you're inside, faster as it shrinks. A kill inside is worth 150 points, and everyone still inside at the end gets 300.",
    core: "The Core comes up and shoots back. Everyone who hurts it gets a share of 1,500 points, and the last hit gets 400 more.",
    boss: "A boss shows up. Everyone who hurts it gets a share of 1,200 points, and the last hit gets 400 more.",
    rush: "One area turns rich for a few minutes. Mine the glowing rock there, then bank it: every 2 gems you bank from the rush give you 1 point. If you die first, they stop counting.",
    hill: "One vault becomes the hill. Stand in the ring around it, not on the pad, to earn 10 points a second. If another tank is in the ring too, nobody scores.",
    meteor: "Meteors land in one area and leave ore behind. Every gem you pick up there is worth 1 point.",
};
const KIND_COL = {
    storm: "#b98bff",
    core: "#ff7ad9",
    rush: "#f2b83c",
    hill: "#4ec4e8",
    boss: "#ff8a5c",
    meteor: "#ffb347",
};
const KIND_HINT = {
    storm: "Get inside the circle and stay alive",
    core: "Break the Core for a share of its gems",
    rush: "Mine the rich rock and bank what you find",
    hill: "Hold the ground around the vault",
    boss: "Hurt the boss and land the last hit",
    meteor: "Grab the ore the meteors leave behind",
};
const RESULT_MS = 9000;

const S = {
    ao: null,
    at: 0,
    nextAt: 0,
    endAt: 0,
    resetAt: 0,
    card: null,
    seenRes: 0,
    annKey: "",
    annAt: 0,
};

function num(n) { return Math.round(+n || 0).toLocaleString("en-US"); }
function clock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    return m + ":" + String(sec).padStart(2, "0");
}
function longClock(ms) {
    const mins = Math.max(0, Math.ceil(ms / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h <= 0) return m + "m";
    return h + "h " + m + "m";
}
function ordinal(n) {
    n |= 0;
    const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
    return n + s;
}

export function on() { return !!(global.royale && global.royale.ao && global.royale.ao.on); }
export function state() { return S; }

export function onRY(r) {
    const a = r.ao || null;
    const now = performance.now();
    S.ao = a;
    S.at = now;
    if (!a) return;
    if (a.nx) {
        const due = now + (+a.nx.in || 0);
        if (!(S.nextAt > 0) || Math.abs(due - S.nextAt) > 1500 || due < S.nextAt) S.nextAt = due;
        const key = a.nx.k + "|" + a.nx.w;
        if (a.nx.a && S.annKey !== key) { S.annKey = key; S.annAt = now; }
    } else S.nextAt = 0;
    if (a.ev) {
        const due = now + (+a.ev.left || 0);
        if (!(S.endAt > 0) || Math.abs(due - S.endAt) > 1500 || due < S.endAt) S.endAt = due;
    } else S.endAt = 0;
    const rd = now + (+a.rs || 0);
    if (!(S.resetAt > 0) || Math.abs(rd - S.resetAt) > 2000 || rd < S.resetAt) S.resetAt = rd;
    if (a.res && a.res.id && a.res.id !== S.seenRes) {
        S.seenRes = a.res.id;
        const mine = r.you && r.you.ao && r.you.ao.rr && r.you.ao.rr.id === a.res.id ? r.you.ao.rr : null;
        if ((+a.res.ago || 0) < 6000) S.card = { res: a.res, mine, at: now - (+a.res.ago || 0) };
    } else if (S.card && !S.card.mine && r.you && r.you.ao && r.you.ao.rr && r.you.ao.rr.id === S.card.res.id) {
        S.card.mine = r.you.ao.rr;
    }
}

export function nextLeft() { return S.nextAt > 0 ? Math.max(0, S.nextAt - performance.now()) : 0; }
export function eventLeft() { return S.endAt > 0 ? Math.max(0, S.endAt - performance.now()) : 0; }
export function resetLeft() { return S.resetAt > 0 ? Math.max(0, S.resetAt - performance.now()) : 0; }

export function panelText() {
    const a = S.ao;
    if (!a) return null;
    if (a.ev) return { label: a.ev.n, value: clock(eventLeft()) + " left", col: KIND_COL[a.ev.k] || "#ffffff", live: true };
    if (a.nx) return { label: "Next: " + a.nx.n, value: "in " + clock(nextLeft()), col: KIND_COL[a.nx.k] || "#ffffff", live: false };
    return { label: "Next event", value: "soon", col: "#ffffff", live: false };
}

export function drawPanel(c, cx, y, api) {
    const a = S.ao;
    const r = global.royale;
    if (!a) return y;
    const HUD = api.HUD;
    const pt = panelText();
    const you = (r && r.you) || {};
    const yao = you.ao || {};
    const placeTxt = r.place > 0 ? "#" + r.place + " today  ·  " + api.fmtNum(r.youScore | 0) + " pts" : r.youScore > 0 ? api.fmtNum(r.youScore | 0) + " pts today" : "";
    let footR = "";
    let footCol = HUD.lilac;
    if (a.ev) {
        if (yao.epl > 0) { footR = "You're " + ordinal(yao.epl) + ", " + num(yao.ep) + " pts"; footCol = HUD.gold; }
        else { footR = "In " + a.ev.w; footCol = HUD.text2; }
    } else if (a.nx) { footR = "In " + a.nx.w; footCol = HUD.text2; }
    const PW = 320, rowH = 38, footH = 24, PH = rowH + footH;
    const px = Math.round(cx - PW / 2), py = y;
    api.hudPanel(c, px, py, PW, PH);
    const ls = 15, vs = 21;
    let lw = api.hudTitleW(pt.label, ls), vw = api.hudTitleW(pt.value, vs);
    let k = 1;
    while (lw + vw + 8 > PW - 40 && k > 0.7) { k -= 0.05; lw = api.hudTitleW(pt.label, ls * k); vw = api.hudTitleW(pt.value, vs * k); }
    const x0 = cx - (lw + 8 + vw) / 2;
    if (pt.live) {
        c.save();
        c.beginPath();
        c.arc(px + 14, py + rowH / 2, 4.5, 0, Math.PI * 2);
        c.fillStyle = pt.col;
        c.globalAlpha = 0.55 + 0.45 * Math.sin(performance.now() / 220);
        c.fill();
        c.restore();
    }
    api.hudTitle(pt.label, x0, py + rowH / 2 + 1, ls * k, pt.live ? pt.col : HUD.text2, "left");
    const urgent = !a.ev && a.nx && nextLeft() <= 10_000;
    api.hudTitle(pt.value, x0 + lw + 8, py + rowH / 2, vs * k, urgent ? HUD.gold : HUD.head, "left");
    const kind = a.ev ? a.ev.k : a.nx ? a.nx.k : "";
    const info = KIND_INFO[kind];
    if (info && api.infoDot && api.hoverTip) {
        const dx = px + PW - 16, dy = py + rowH / 2;
        api.infoDot(dx, dy);
        const title = a.ev ? a.ev.n : a.nx.n;
        api.hoverTip(px, py, PW, rowH, title, info + " The top 3 get 500, 300 and 200 bonus points and a crown.");
    }
    const fy = py + rowH + footH / 2 - 3;
    if (placeTxt && footR) {
        api.drawText(placeTxt, px + 14, fy, 12, HUD.gold, "left", true);
        api.drawText(footR, px + PW - 14, fy, 12, footCol, "right", true);
    } else if (placeTxt || footR) api.drawText(placeTxt || footR, cx, fy, 12, placeTxt ? HUD.gold : footCol, "center", true);
    api.setClock({ x: px, y: py, w: PW, h: PH });
    if (placeTxt && !global.died && api.pops) api.pops(px + PW + 10, py + rowH + footH / 2);
    return py + PH + HUD.lip + 8;
}

export function hudNotes(push, hudNote, HUD) {
    const a = S.ao;
    if (!a) return;
    const r = global.royale || {};
    const yao = (r.you && r.you.ao) || {};
    if (a.ev) {
        const ev = a.ev;
        const col = KIND_COL[ev.k] || HUD.gold;
        if (ev.k === "hill" && ev.ct) push(hudNote(1, "aohill", "The hill is contested, so nobody scores until it's cleared", HUD.danger));
        else if (ev.k === "rush" && yao.eh > 0) push(hudNote(1, "aoheld", "Bank your " + num(yao.eh) + " rush gems to score them", HUD.gold));
        else if (yao.epl > 0) push(hudNote(2, "aome", "You're " + ordinal(yao.epl) + " in " + ev.n + " with " + num(yao.ep) + " points", col));
        else push(hudNote(2, "aohint", ev.n + " in " + ev.w + ": " + (KIND_HINT[ev.k] || "Join in"), col));
        return;
    }
    if (a.nx) {
        const left = nextLeft();
        if (a.nx.a) push(hudNote(1, "aosoon", a.nx.n + " starts in " + clock(left) + " in " + a.nx.w, KIND_COL[a.nx.k] || HUD.gold));
        else push(hudNote(2.5, "aonext", "Next event in " + clock(left) + ": " + a.nx.n + " in " + a.nx.w, HUD.text2));
    }
}

export function resultUp() {
    return !!(S.card && performance.now() - S.card.at < RESULT_MS);
}

export function drawResult(c, cx, y, api) {
    const card = S.card;
    if (!card) return y;
    const age = performance.now() - card.at;
    if (age >= RESULT_MS) { S.card = null; return y; }
    const HUD = api.HUD;
    const res = card.res;
    const A = Math.min(1, age / 250, (RESULT_MS - age) / 400);
    const W = Math.min(340, global.screenWidth - 40), H = 76;
    const x = Math.round(cx - W / 2);
    api.hudPanel(c, x, y, W, H, { alpha: A, fill: HUD.solid });
    const col = KIND_COL[res.k] || HUD.gold;
    api.hudTitle(res.n + " results", cx, y + 15, 15, col, "center", A);
    const top = res.top || [];
    let line = top.length ? top.map((t, i) => (i + 1) + ". " + t.n).join("   ") : "Nobody scored this time";
    let fs = 12.5;
    while (fs > 9.5 && api.hudTextW(line, fs) > W - 24) fs -= 0.5;
    api.drawText(line, cx, y + 38, fs, HUD.text, "center", true, A);
    const m = card.mine;
    let foot;
    if (m && m.pl > 0) foot = "You placed " + ordinal(m.pl) + ", +" + num(m.p) + " points" + (m.pl <= 3 ? ". You got a crown!" : "");
    else foot = "Join the next one to get on the board";
    api.drawText(foot, cx, y + 59, 12, m && m.pl > 0 && m.pl <= 3 ? HUD.gold : HUD.text2, "center", true, A);
    return y + H + 10;
}

function dashedRing(c, x, y, r, col, w, dash, alpha) {
    c.save();
    c.globalAlpha = alpha;
    c.strokeStyle = col;
    c.lineWidth = w;
    if (dash) c.setLineDash(dash);
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.restore();
}

export function drawWorld(c, ox, oy, ratio, api) {
    const a = S.ao;
    if (!a) return;
    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    if (a.ev) {
        const ev = a.ev;
        const col = KIND_COL[ev.k] || "#ffffff";
        const sx = ox + ev.x * ratio, sy = oy + ev.y * ratio;
        if (ev.k === "hill") {
            const rr = ev.r * ratio;
            c.save();
            c.globalAlpha = 0.12 + 0.06 * pulse;
            c.fillStyle = ev.ct ? "#e0473b" : col;
            c.beginPath();
            c.arc(sx, sy, rr, 0, Math.PI * 2);
            c.arc(sx, sy, (ev.pr || 130) * ratio, 0, Math.PI * 2, true);
            c.fill("evenodd");
            c.restore();
            dashedRing(c, sx, sy, rr, ev.ct ? "#e0473b" : col, Math.max(2, 4 * ratio), [18 * ratio, 12 * ratio], 0.85);
            api.label(ev.ct ? "The hill (contested)" : "The hill", sx, sy - rr - 18 * ratio, Math.max(12, 26 * ratio), ev.ct ? "#ff8a80" : col);
        } else if (ev.k === "rush" || ev.k === "meteor") {
            const rr = ev.r * ratio;
            c.save();
            c.globalAlpha = 0.06 + 0.04 * pulse;
            c.fillStyle = col;
            c.beginPath();
            c.arc(sx, sy, rr, 0, Math.PI * 2);
            c.fill();
            c.restore();
            dashedRing(c, sx, sy, rr, col, Math.max(2, 3.5 * ratio), [14 * ratio, 14 * ratio], 0.7);
            api.label(ev.n, sx, sy - rr - 18 * ratio, Math.max(12, 26 * ratio), col);
        } else if (ev.k === "storm" && ev.R) {
            dashedRing(c, sx, sy, ev.R * ratio, col, Math.max(1.5, 3 * ratio), [10 * ratio, 16 * ratio], 0.5);
        }
    }
    if (a.nx && a.nx.a && a.nx.x != null) {
        const n = a.nx;
        const col = KIND_COL[n.k] || "#ffffff";
        const sx = ox + n.x * ratio, sy = oy + n.y * ratio, rr = (n.r || 500) * ratio;
        dashedRing(c, sx, sy, rr, col, Math.max(2, 3.5 * ratio), [20 * ratio, 16 * ratio], 0.45 + 0.35 * pulse);
        api.label(n.n + " in " + clock(nextLeft()), sx, sy - rr - 18 * ratio, Math.max(12, 28 * ratio), col);
    }
}

export function mapMarks() {
    const a = S.ao;
    const out = [];
    if (!a) return out;
    if (a.ev && a.ev.k !== "storm") out.push({ x: a.ev.x, y: a.ev.y, r: a.ev.r, col: KIND_COL[a.ev.k] || "#ffffff", live: true, k: a.ev.k, n: a.ev.n });
    if (a.ev && a.ev.k === "storm" && a.ev.R) out.push({ x: a.ev.x, y: a.ev.y, r: a.ev.R, col: KIND_COL.storm, live: true, k: "storm", n: a.ev.n });
    if (a.nx && a.nx.a && a.nx.x != null) out.push({ x: a.nx.x, y: a.nx.y, r: a.nx.r || 500, col: KIND_COL[a.nx.k] || "#ffffff", live: false, k: a.nx.k, n: a.nx.n });
    return out;
}

export function drawMap(c, mapX, mapY, scale) {
    const marks = mapMarks();
    if (!marks.length) return;
    const now = performance.now();
    for (const mk of marks) {
        const x = mapX(mk.x), y = mapY(mk.y), r = Math.max(4, mk.r * scale);
        c.save();
        c.globalAlpha = mk.live ? 0.9 : 0.5 + 0.4 * Math.sin(now / 250);
        c.strokeStyle = mk.col;
        c.lineWidth = 2;
        if (!mk.live) c.setLineDash([4, 3]);
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = mk.col;
        c.globalAlpha *= 0.25;
        c.fill();
        c.globalAlpha = 1;
        c.beginPath();
        c.arc(x, y, 2.5, 0, Math.PI * 2);
        c.fillStyle = mk.col;
        c.fill();
        c.restore();
    }
}

export function stormView() {
    const r = global.royale;
    const s = r && r.aoStorm;
    return s && s.a ? s : null;
}

export function deathLine() {
    const a = S.ao;
    if (!a) return "";
    if (a.ev) return a.ev.n + " is on in " + a.ev.w + " for another " + clock(eventLeft()) + ".";
    if (a.nx) return "Next event in " + clock(nextLeft()) + ": " + a.nx.n + " in " + a.nx.w + ".";
    return "";
}

export function standingsTitle() { return "Today's leaderboard"; }

export function standingsFoot() {
    const r = global.royale || {};
    const a = S.ao;
    if (!a) return null;
    const place = r.place | 0;
    const left = resetLeft();
    const line1 = (place > 0 ? "You're " + ordinal(place) + " today" : "Score to get on the board") + "  ·  Resets in " + longClock(left);
    const ch = a.ch || [];
    const line2 = ch.length ? "Yesterday's champions: " + ch.map(x => x.n).join(", ") : "";
    return { line1, line2 };
}

export function onFX(kind) {
    return kind === "aosoon" || kind === "aostart";
}

export function feedLine(f, who, tag) {
    if (!f || !f.ao) return null;
    const name = String(f.n || "The event");
    const col = KIND_COL[f.k] || "#ffffff";
    const ev = tag(name, col);
    if (f.soon) return { text: ev + " starts soon" + (f.w ? " in " + f.w : ""), badge: null };
    if (f.go) return { text: ev + " has started" + (f.w ? " in " + f.w : ""), badge: null };
    if (f.coreblast) return { text: tag("The Core", KIND_COL.core) + " blew itself apart", badge: null };
    if (f.done) return { text: f.by ? who(f.by, "", 14) + " won " + ev : ev + " is over", badge: null };
    return { text: ev, badge: null };
}
