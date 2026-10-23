import { global } from "./global.js";
import { gameSound } from "./sound.js";
import * as L from "./teamWarLogic.js";
import { shows as nxShows } from "./newcomerLogic.js";
import { toast as menuToast, h, clear, icon, humanError } from "./account/ui.js";
import * as social from "./account/social.js";
import * as acctState from "./account/state.js";
import * as api from "./account/api.js";
import { presenceText, presenceState, byPresence } from "./account/people.js";

const TAU = Math.PI * 2;
const TEAL = "#5ce0d8";
const HUNT_RED = "#ff3b4e";
const NEUTRAL = "#e8d9a8";
const OUTPOST_GREY = "#9aa0aa";
const GAIN_MS = 1400;

let A = null;
export function init(helpers) { A = helpers; }

const S = {
    split: 0.5, meter: 0, frameAt: 0,
    padUp: false, dismissed: false, wasNear: false, leftAt: -1e9, titanAskAt: -1e9,
    panel: null, buttons: [], cancelRect: null, hover: -1,
    intro: { state: "", at: 0, rect: null, aliveAt: 0 },
    seenIntro: null, lastSend: -1e9,
    gainPrev: null, gains: [],
};
const M = { huntSrc: undefined, huntNx: -1, hunted: new Set(), crownSrc: undefined, crowned: new Set() };

export function on() {
    const r = global.royale;
    return !!(r && r.tw && r.at > 0);
}
function tw() { return global.royale.tw; }
function twy() { return global.royale.twy || null; }
export function myTeam() { const y = global.royale && global.royale.twy; return y ? y.t | 0 : 0; }
function sinceRY() { return performance.now() - (global.royale.at || performance.now()); }
export function teamHex(n) {
    if (A && A.teamHex) { const h = A.teamHex(n); if (h) return h; }
    return n === L.BLUE ? "#00b2e1" : "#f14e54";
}
function myHex() { return teamHex(myTeam() || L.BLUE); }

export function onRY(r) {
    if (!r.tw) {
        S.padUp = false; S.dismissed = false; S.wasNear = false; S.gainPrev = null;
        return;
    }
    const me = r.twy ? r.twy.t | 0 : 0;
    if (!me) { S.gainPrev = null; return; }
    const mi = me === L.RED ? 1 : 0;
    const frac = Math.max(0, Math.min(1, +(r.tw.w && r.tw.w[mi]) || 0));
    const need = +(r.tw.wn && r.tw.wn[mi]) || 0;
    const prev = S.gainPrev && S.gainPrev.team === me ? S.gainPrev : null;
    const gain = L.meterGain(prev, frac, need);
    S.gainPrev = { frac, need, team: me };
    if (gain > 0) addGain(gain);
}

function addGain(n) {
    const now = performance.now();
    const last = S.gains[S.gains.length - 1];
    if (last && now - last.at < 450) { last.n += n; last.at = now; return; }
    S.gains.push({ n, at: now });
    if (S.gains.length > 3) S.gains.shift();
}

function nxNow() { return global.nxStage == null ? 3 : global.nxStage; }
export function huntedIds() {
    const r = global.royale;
    const src = r ? r.hunt : null;
    const stage = nxNow();
    if (src === M.huntSrc && stage === M.huntNx) return M.hunted;
    M.huntSrc = src; M.huntNx = stage;
    M.hunted = new Set();
    if (src && nxShows("hunted", stage)) for (const h of src) if (h && !huntHidden(h)) M.hunted.add(h.e);
    return M.hunted;
}
export function crownIds() {
    const r = global.royale;
    const src = r ? r.crowns : null;
    if (src === M.crownSrc) return M.crowned;
    M.crownSrc = src;
    M.crowned = new Set();
    if (src && src.on && Array.isArray(src.list)) for (const row of src.list) if (row) M.crowned.add(row.e);
    return M.crowned;
}
export function markTaken(id) { return id != null && (huntedIds().has(id) || crownIds().has(id)); }
function personMarked(id) {
    if (markTaken(id)) return true;
    const r = global.royale;
    const rv = r.you && r.you.revenge;
    if (rv && rv.alive && !rv.tough && rv.e === id) return true;
    if (r.bounty && r.bounty.e === id) return true;
    if (r.lping && r.lping.id === id) return true;
    for (const p of r.pings || []) if (p && p.id === id) return true;
    return false;
}

function personTeam(id) {
    const me = myTeam();
    if (!me || id == null) return 0;
    if (A && A.selfId && id === A.selfId()) return me;
    const y = twy();
    if (y) {
        for (const m of y.mates || []) if (m && m[0] === id) return me;
        for (const f of y.foes || []) if (f && f[0] === id) return L.otherTeam(me);
    }
    for (const row of global.royale.board || []) if (row && row.id === id) return row.t | 0;
    for (const h of global.royale.hunt || []) if (h && h.e === id) return L.teamNoOfId(h.tm);
    return 0;
}
export function personHex(id, tm) {
    if (!on()) return null;
    const n = L.teamNoOfId(tm) || personTeam(id);
    return n === L.BLUE || n === L.RED ? teamHex(n) : null;
}
export function shopHex(s, fallback) {
    if (!s || !on()) return fallback;
    const n = L.teamNoOfId(s.team);
    return n ? teamHex(n) : OUTPOST_GREY;
}
export function shopMapLabel(s) {
    if (!s || !on()) return "";
    return L.teamNoOfId(s.team) ? "Team Shop" : "Shop";
}
function titanCd() { const y = twy(); return y ? L.secsLeft(y.tcd, sinceRY()) : 0; }
function myFrac() {
    const t = tw(), mi = myTeam() === L.RED ? 1 : 0;
    return Math.max(0, Math.min(1, +(t.w && t.w[mi]) || 0));
}
function readyNow() {
    const y = twy();
    return !!myTeam() && L.titanReady(myFrac(), !!(y && y.tOut), titanCd());
}

function send(n) {
    try { global.socket.talk("tw", n); } catch (e) { return; }
    S.lastSend = performance.now();
    if (n === L.CALL_TITAN_MIDDLE || n === L.CALL_TITAN_FLANK) S.titanAskAt = S.lastSend;
    try { gameSound.uiClick(); } catch (e) { void e; }
}

function myPad() {
    const t = tw();
    return t ? L.padFor(t.pads, myTeam()) : null;
}
function nearMyPad() {
    const p = myPad();
    if (!p || !global.player) return false;
    return L.onPad(p, global.player.renderx, global.player.rendery, 4);
}
function channel() {
    const y = twy();
    return y && y.ch && y.ch.k === "titan" ? y.ch : null;
}
function channelFrac(ch) {
    if (!ch) return 0;
    return Math.max(0, Math.min(1, (+ch.p || 0) + sinceRY() / L.CHANNEL_MS));
}

function tickPad() {
    const y = twy();
    const near = !global.died && nearMyPad();
    const waiting = performance.now() - S.titanAskAt < 1500;
    const now = performance.now();
    if (S.wasNear && !near) {
        S.leftAt = now;
        if (channel() || waiting) { send(L.CALL_CANCEL); S.titanAskAt = -1e9; }
    }
    const serverSays = !!(y && y.pad) && now - S.leftAt > 900;
    if (!near && !serverSays) S.dismissed = false;
    S.wasNear = near;
    S.padUp = !global.died && !global.showBigMap && !S.dismissed && (near || serverSays);
}
export function padPanelUp() { return on() && S.padUp && !!S.panel; }

export function key(e) {
    if (!on() || !S.padUp || global.died) return false;
    if (e.keyCode === 27) {
        if (e.repeat) return true;
        if (channel() || performance.now() - S.titanAskAt < 1500) { send(L.CALL_CANCEL); S.titanAskAt = -1e9; }
        else { S.dismissed = true; try { gameSound.uiClick(); } catch (err) { void err; } }
        return true;
    }
    const n = L.padKeyIndex(e, !!global.showChat);
    if (n < 0) return false;
    if (e.preventDefault) e.preventDefault();
    const b = S.buttons.find(o => o.n === n);
    if (b && b.enabled && !channel()) send(n);
    return true;
}

function inRect(r, x, y) { return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
export function hit(x, y) {
    if (!on()) return false;
    if (S.intro.state === "up" && inRect(S.intro.rect, x, y)) return true;
    return S.padUp && inRect(S.panel, x, y);
}
export function click(x, y) {
    if (!on() || global.died) return false;
    if (S.intro.state === "up" && inRect(S.intro.rect, x, y)) { closeIntro(); return true; }
    if (!S.padUp || !inRect(S.panel, x, y)) return false;
    if (S.cancelRect && inRect(S.cancelRect, x, y)) { send(L.CALL_CANCEL); S.titanAskAt = -1e9; return true; }
    if (channel()) return true;
    for (const b of S.buttons) if (b.enabled && inRect(b.rect, x, y)) { send(b.n); return true; }
    return true;
}

export function drawTopBar(c, cx, y, maxW) {
    if (!A || !on()) return y;
    const t = tw(), me = myTeam();
    const now = performance.now();
    const dt = S.frameAt ? now - S.frameAt : 16.7;
    S.frameAt = now;
    const HUD = A.HUD;
    const blue = (t.s && t.s[0]) | 0, red = (t.s && t.s[1]) | 0;
    S.split = L.easeTo(S.split, L.splitFrac(t.s), dt, 0.08);
    const mi = me === L.RED ? 1 : 0;
    const frac = Math.max(0, Math.min(1, +(t.w && t.w[mi]) || 0));
    S.meter = L.easeTo(S.meter, frac, dt, 0.1);
    const y2 = twy() || {};
    const out = !!y2.tOut;
    const W = Math.round(Math.max(240, Math.min(380, maxW - 8, global.screenWidth - 24)));
    const tcd = titanCd();
    const ready = !!me && L.titanReady(frac, out, tcd);
    const rowH = 40, meterH = me ? 36 : 0, H = rowH + meterH;
    const x = Math.round(cx - W / 2);
    A.hudPanel(c, x, y, W, H);
    if (ready) {
        c.save();
        A.rr(c, x + 1, y + 1, W - 2, H - 2, 8);
        c.globalAlpha = 0.55 + 0.4 * Math.sin(now / 180);
        c.strokeStyle = HUD.gold; c.lineWidth = 2.5; c.stroke();
        c.restore();
    }
    const blueCol = teamHex(L.BLUE), redCol = teamHex(L.RED);
    if (me) {
        c.save();
        A.rr(c, me === L.BLUE ? x + 3 : x + W / 2, y + 3, W / 2 - 3, rowH - 4, 5);
        c.globalAlpha = 0.14;
        c.fillStyle = me === L.BLUE ? blueCol : redCol;
        c.fill();
        c.restore();
    }
    const ty = y + 12;
    const bs = me === L.BLUE ? 15 : 13.5, rs = me === L.RED ? 15 : 13.5;
    label("Blue " + A.fmtNum(blue), x + 12, ty, bs, blueCol, "left");
    label(A.fmtNum(red) + " Red", x + W - 12, ty, rs, redCol, "right");
    const bx = x + 12, bw = W - 24, bh = 10, by = y + 24;
    c.save();
    A.rr(c, bx, by, bw, bh, bh / 2);
    c.fillStyle = HUD.track; c.fill();
    c.lineWidth = 1.5; c.strokeStyle = HUD.frame; c.stroke();
    const inset = 2, ih = bh - inset * 2, iw = bw - inset * 2;
    const split = Math.max(0, Math.min(1, S.split));
    const sx = bx + inset + iw * split;
    c.save();
    A.rr(c, bx + inset, by + inset, iw, ih, ih / 2);
    c.clip();
    c.fillStyle = blueCol; c.fillRect(bx + inset, by + inset, sx - bx - inset, ih);
    c.fillStyle = redCol; c.fillRect(sx, by + inset, bx + inset + iw - sx, ih);
    c.restore();
    c.fillStyle = "#ffffff";
    c.strokeStyle = HUD.ink; c.lineWidth = 1.5;
    c.beginPath(); c.rect(sx - 1.5, by - 1, 3, bh + 2); c.fill(); c.stroke();
    c.restore();
    if (me) {
        const my = y + rowH + 6;
        const col = me === L.BLUE ? blueCol : redCol;
        const ls = 12.5, head = "War Meter";
        const lw = A.hudTitleW(head, ls);
        A.hudTitle(head, x + 12, my, ls, HUD.head, "left");
        const iconR = 7.5, ix = x + W - 12 - iconR;
        const pct = L.meterPct(frac) + "%";
        const pw = A.hudTextW("100%", 11);
        const mx0 = x + 12 + lw + 10, mx1 = ix - iconR - 12 - pw;
        if (mx1 - mx0 > 30) A.hudBar(c, mx0, my - 4, mx1 - mx0, 8, S.meter, ready ? HUD.gold : col);
        A.drawText(pct, ix - iconR - 8, my, 11, ready ? HUD.gold : HUD.text2, "right", true);
        const pulse = ready ? 1 + 0.16 * Math.sin(now / 160) : 1;
        if (ready) {
            c.save();
            c.globalAlpha = 0.35 + 0.25 * Math.sin(now / 160);
            c.strokeStyle = HUD.gold; c.lineWidth = 2;
            c.beginPath(); c.arc(ix, my, iconR * 1.6 * pulse, 0, TAU); c.stroke();
            c.restore();
        }
        titanGlyph(c, ix, my, iconR * pulse, out || tcd > 0 ? HUD.text2 : ready ? HUD.gold : col, HUD.ink);
        const hint = L.meterHint(frac, out, tcd);
        const hy = y + rowH + 22;
        if (hint.hot) A.hudTitle(hint.text, x + W / 2, hy, 13, HUD.gold, "center", 0.8 + 0.2 * Math.sin(now / 180), c);
        else A.drawText(hint.text, x + W / 2, hy, 10.5, HUD.text2, "center", true);
        if (mx1 - mx0 > 30) drawGains(c, Math.min(mx1 - 14, mx0 + (mx1 - mx0) * Math.max(0.04, Math.min(1, S.meter))), my, col, now);
    }
    let pillX = x + W + 8;
    const radar = me ? L.secsLeft(t.rd && t.rd[mi], sinceRY()) : 0;
    if (radar > 0) {
        const txt = "Radar Sweep " + radar + "s";
        const pw = A.hudTitleW(txt, 12) + 16, ph = 22, py = y + rowH / 2 - ph / 2;
        if (pillX + pw > global.screenWidth - 6) pillX = x - 8 - pw;
        A.hudPanel(c, pillX, py, pw, ph, { r: 4 });
        A.hudTitle(txt, pillX + pw / 2, py + ph / 2, 12, TEAL, "center");
    }
    return y + H + HUD.lip + 8;
}

function label(text, x, y, size, col, align) {
    if (A.hudLabel) A.hudLabel(text, x, y, size, col, align);
    else A.hudTitle(text, x, y, size, col, align);
}

function drawGains(c, gx, gy, col, now) {
    for (let i = S.gains.length - 1; i >= 0; i--) {
        const g = S.gains[i];
        const age = now - g.at;
        if (age > GAIN_MS) { S.gains.splice(i, 1); continue; }
        const k = age / GAIN_MS;
        const a = Math.min(1, age / 120) * (k > 0.6 ? (1 - k) / 0.4 : 1);
        const pop = age < 200 ? 1 + 0.25 * Math.sin(Math.PI * age / 200) : 1;
        A.drawText("+" + A.fmtNum(g.n), gx, gy - 2 - 6 * Math.min(1, age / 500), 11.5 * pop, col, "center", true, a);
    }
}

export function skullIcon(c, x, y, r, col, ink) {
    c.save();
    c.translate(x, y);
    c.lineJoin = "round";
    c.beginPath();
    c.arc(0, -r * 0.12, r, Math.PI * 0.78, Math.PI * 2.22);
    c.lineTo(r * 0.5, r * 0.62);
    c.lineTo(r * 0.5, r * 0.98);
    c.lineTo(-r * 0.5, r * 0.98);
    c.lineTo(-r * 0.5, r * 0.62);
    c.closePath();
    c.lineWidth = Math.max(1.4, r * 0.3); c.strokeStyle = ink || "#000"; c.stroke();
    c.fillStyle = col; c.fill();
    c.fillStyle = ink || "#000";
    c.beginPath();
    c.arc(-r * 0.38, -r * 0.1, r * 0.26, 0, TAU);
    c.arc(r * 0.38, -r * 0.1, r * 0.26, 0, TAU);
    c.fill();
    c.beginPath();
    c.moveTo(0, r * 0.22); c.lineTo(-r * 0.14, r * 0.5); c.lineTo(r * 0.14, r * 0.5); c.closePath();
    c.fill();
    c.restore();
}

export function targetIcon(c, x, y, r, col, ink) {
    c.save();
    c.lineCap = "round";
    const ring = (w, s) => { c.lineWidth = w; c.strokeStyle = s; c.beginPath(); c.arc(x, y, r * 0.72, 0, TAU); c.stroke(); };
    const ticks = (w, s) => {
        c.lineWidth = w; c.strokeStyle = s;
        c.beginPath();
        for (let k = 0; k < 4; k++) {
            const a = k * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
            c.moveTo(x + ca * r * 0.45, y + sa * r * 0.45); c.lineTo(x + ca * r * 1.05, y + sa * r * 1.05);
        }
        c.stroke();
    };
    const lw = Math.max(1.2, r * 0.2);
    ring(lw + 2, ink || "#000"); ticks(lw + 2, ink || "#000");
    ring(lw, col); ticks(lw, col);
    c.beginPath(); c.arc(x, y, Math.max(1.2, r * 0.18), 0, TAU);
    c.fillStyle = col; c.fill();
    c.restore();
}

export function titanGlyph(c, x, y, r, col, ink) {
    c.save();
    c.lineJoin = "round";
    c.beginPath();
    for (let i = 0; i < 8; i++) {
        const a = i * TAU / 8 + Math.PI / 8;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath();
    c.fillStyle = col; c.fill();
    c.lineWidth = Math.max(1.5, r * 0.24); c.strokeStyle = ink; c.stroke();
    c.beginPath();
    c.moveTo(x - r * 0.42, y + r * 0.2);
    c.lineTo(x - r * 0.42, y - r * 0.28);
    c.lineTo(x - r * 0.18, y - r * 0.08);
    c.lineTo(x, y - r * 0.42);
    c.lineTo(x + r * 0.18, y - r * 0.08);
    c.lineTo(x + r * 0.42, y - r * 0.28);
    c.lineTo(x + r * 0.42, y + r * 0.2);
    c.closePath();
    c.fillStyle = "#ffffff"; c.fill();
    c.restore();
}

export function titanCards() {
    if (!on() || global.died) return [];
    const list = (tw().ti || []).filter(t => t && (t.t === L.BLUE || t.t === L.RED));
    const me = myTeam();
    if (list.length > 1) list.sort((a, b) => (a.t === me ? -1 : 0) - (b.t === me ? -1 : 0));
    return list.slice(0, 2);
}

export function drawTitanCard(c, x, y, W, H, t) {
    if (!A || !t) return;
    const HUD = A.HUD;
    const col = teamHex(t.t);
    A.hudPanel(c, x, y, W, H);
    titanGlyph(c, x + 16, y + 13, 7.5, col, HUD.ink);
    const name = String(t.n || (L.teamName(t.t) + " Titan"));
    const state = L.titanState(t.st) + "  ·  " + (t.lane === "flank" ? "Flank" : "Middle");
    const sw = A.hudTitleW(state, 11);
    let ns = 14; while (ns > 10 && A.hudTitleW(name, ns) > W - 40 - sw) ns -= 0.5;
    label(name, x + 28, y + 13, ns, col, "left");
    label(state, x + W - 10, y + 13, 11, t.st === "siege" ? HUD.gold : HUD.text2, "right");
    const hp = Math.max(0, Math.min(1, +t.hp || 0));
    A.hudBar(c, x + 10, y + 22, W - 20, 8, hp, hp > 0.2 ? col : HUD.danger);
    const mine = t.t === myTeam();
    A.drawText(Math.round(hp * 100) + "%" + (mine ? "  ·  Yours" : ""), x + 12, y + H - 8, 9.5, HUD.text2, "left", true);
    const dist = Math.hypot((t.x || 0) - global.player.renderx, (t.y || 0) - global.player.rendery);
    if (isFinite(dist) && dist < 1e6) A.drawText(A.fmtDist(dist) + " away", x + W - 12, y + H - 8, 9.5, HUD.text2, "right", true);
}

export function drawFloor(c, px, py, ratio) {
    if (!A || !on()) return;
    const t = tw();
    const pads = t.pads || [];
    if (!pads.length) return;
    const now = performance.now();
    const sw = global.screenWidth, sh = global.screenHeight;
    const me = myTeam();
    const ch = channel();
    const full = readyNow();
    const HUD = A.HUD;
    for (const p of pads) {
        const sx = ratio * p.x - px + sw / 2, sy = ratio * p.y - py + sh / 2;
        const R = (p.r || 95) * ratio;
        if (sx < -R * 2 || sx > sw + R * 2 || sy < -R * 2 || sy > sh + R * 2) continue;
        const col = teamHex(p.t);
        const mine = p.t === me;
        c.save();
        c.translate(sx, sy);
        c.beginPath(); c.arc(0, 0, R, 0, TAU);
        c.fillStyle = A.padTint(col); c.fill();
        c.lineWidth = Math.max(1.5, R * 0.05); c.strokeStyle = A.padLine(col); c.stroke();
        const spin = now / 4000;
        c.lineWidth = Math.max(2, R * 0.075);
        c.strokeStyle = col;
        c.lineCap = "round";
        for (let i = 0; i < 4; i++) {
            const a = spin + i * TAU / 4;
            c.beginPath(); c.arc(0, 0, R * 0.84, a + 0.18, a + TAU / 4 - 0.18); c.stroke();
        }
        c.lineCap = "butt";
        c.beginPath();
        for (let i = 0; i < 4; i++) {
            const a = i * TAU / 4 - Math.PI / 2;
            c.moveTo(Math.cos(a) * R * 0.6, Math.sin(a) * R * 0.6);
            c.lineTo(Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72);
        }
        c.stroke();
        titanGlyph(c, 0, 0, R * 0.34, col, HUD.ink);
        if (mine && full && !ch) {
            c.globalAlpha = 0.45 + 0.35 * Math.sin(now / 200);
            c.strokeStyle = HUD.gold; c.lineWidth = Math.max(2, R * 0.05);
            c.beginPath(); c.arc(0, 0, R * 1.08, 0, TAU); c.stroke();
            c.globalAlpha = 1;
        }
        if (mine && ch) {
            const f = channelFrac(ch);
            const bw = Math.max(4, R * 0.09), br = R * 1.1, lw = Math.max(1.5, R * 0.03);
            c.beginPath(); c.arc(0, 0, br, 0, TAU);
            c.lineWidth = bw + lw * 2; c.strokeStyle = HUD.ink; c.stroke();
            c.lineWidth = bw; c.strokeStyle = HUD.wellSolid; c.stroke();
            if (f > 0.001) {
                c.beginPath(); c.arc(0, 0, br, -Math.PI / 2, -Math.PI / 2 + f * TAU);
                c.lineCap = "round"; c.strokeStyle = HUD.gold; c.stroke(); c.lineCap = "butt";
            }
        }
        c.restore();
        const standing = mine && S.padUp;
        if (!standing) {
            const ls = Math.max(13, R * 0.28);
            const text = mine ? "War Pad: call your Titan here" : L.teamName(p.t) + " War Pad";
            A.worldLabel(c, text, sx, sy - R * 1.3, ls, mine && full && !ch ? HUD.gold : HUD.head);
        }
    }
}

export function drawPadPanel(c) {
    S.panel = null; S.buttons = []; S.cancelRect = null;
    if (!A || !on()) { S.padUp = false; return; }
    tickPad();
    if (!S.padUp) return;
    const HUD = A.HUD;
    const y0 = twy() || {};
    const me = myTeam() || L.BLUE;
    const col = teamHex(me);
    const sw = global.screenWidth, sh = global.screenHeight;
    const mobile = !!global.mobile;
    const W = Math.round(Math.min(380, sw - 24));
    const gap = 8, bh = 46, headH = 30;
    const ch = channel();
    const H = headH + (ch ? 70 : bh * 2 + gap) + 12;
    const x = Math.round((sw - W) / 2);
    const y = Math.round(sh - (mobile ? 330 : 350));
    S.panel = { x, y, w: W, h: H };
    A.hudPanel(c, x, y, W, H, { fill: HUD.card, r: 10 });
    c.save();
    A.rr(c, x + 1.5, y + 1.5, W - 3, H - 3, 9);
    c.strokeStyle = col; c.lineWidth = 2.5; c.stroke();
    c.restore();
    titanGlyph(c, x + 20, y + headH / 2 + 2, 8, col, HUD.ink);
    A.hudTitle("War Pad", x + 34, y + headH / 2 + 2, 17, HUD.head, "left");
    const t = tw();
    const mi = me === L.RED ? 1 : 0;
    const frac = Math.max(0, Math.min(1, +(t.w && t.w[mi]) || 0));
    const tcd = titanCd();
    A.drawText(L.meterLine(frac, !!y0.tOut, tcd), x + W - 14, y + headH / 2 + 2, 11.5, L.titanReady(frac, !!y0.tOut, tcd) ? HUD.gold : HUD.text2, "right", true);
    const by = y + headH + 4;
    const mouse = A.mouseGui ? A.mouseGui() : null;
    if (ch) {
        const f = channelFrac(ch);
        A.hudTitle("Calling the Titan...", x + W / 2, by + 12, 16, HUD.gold, "center");
        A.hudBar(c, x + 16, by + 26, W - 32, 10, f, HUD.gold);
        const cw = 92, chh = 24, cxb = x + W - 16 - cw, cyb = by + 42;
        A.drawText(L.laneLine(ch.l) + (mobile ? "" : ". Esc cancels."), x + 16, cyb + chh / 2, 11.5, HUD.text2, "left", true);
        S.cancelRect = { x: cxb, y: cyb, w: cw, h: chh };
        const hov = mouse && inRect(S.cancelRect, mouse.x, mouse.y);
        drawButton(c, S.cancelRect, "Cancel", "", true, hov, HUD.face, HUD.head, null);
    } else {
        const list = L.callButtons(y0, sinceRY());
        const bw = (W - 16 * 2 - gap) / 2;
        S.hover = -1;
        list.forEach((b, i) => {
            const rx = x + 16 + (i % 2) * (bw + gap), ry = by + Math.floor(i / 2) * (bh + gap);
            b.rect = { x: rx, y: ry, w: bw, h: bh };
            const hov = !!(mouse && b.enabled && inRect(b.rect, mouse.x, mouse.y));
            if (hov) S.hover = i;
            const titan = b.n >= L.CALL_TITAN_MIDDLE;
            drawButton(c, b.rect, b.label, b.sub, b.enabled, hov, b.enabled ? (titan ? col : HUD.face) : HUD.face, b.enabled && titan ? "#ffffff" : HUD.head, mobile ? null : "Shift+" + b.n);
            S.buttons.push(b);
        });
    }
    if (mobile && A.touchRect) A.touchRect(S.panel);
}

function drawButton(c, r, label, sub, enabled, hover, fill, ink, keyCap) {
    const HUD = A.HUD;
    c.save();
    c.globalAlpha *= enabled ? 1 : 0.55;
    A.rr(c, r.x, r.y, r.w, r.h, 6);
    c.fillStyle = fill; c.fill();
    if (hover) { c.fillStyle = "rgba(255,255,255,0.16)"; c.fill(); }
    c.lineWidth = 2.5; c.strokeStyle = HUD.frame; c.stroke();
    c.restore();
    const a = enabled ? 1 : 0.7;
    const kw = keyCap ? A.hudTitleW(keyCap, 9) + 10 : 0;
    const room = r.w - 16 - (kw ? kw + 6 : 0);
    let ls = 14; while (ls > 9 && A.hudTitleW(label, ls) > room) ls -= 0.5;
    const ly = sub ? r.y + r.h * 0.36 : r.y + r.h / 2;
    A.hudTitle(label, r.x + 8, ly, ls, ink, "left", a, c);
    if (sub) {
        let ss = 10.5; while (ss > 8 && A.hudTextW(sub, ss) > r.w - 16) ss -= 0.5;
        A.drawText(sub, r.x + 8, r.y + r.h * 0.72, ss, ink === "#ffffff" ? "#ffffff" : HUD.text2, "left", true, a);
    }
    if (keyCap && A.hudKey) A.hudKey(c, r.x + r.w - 6 - kw, r.y + 5, keyCap, 15, a);
}

export function avoidRect() { return S.padUp && S.panel ? S.panel : null; }

export function drawMapUnder(c, T, inside) {
    if (!on()) return;
    for (const b of tw().bases || []) {
        if (!b) continue;
        const x0 = T.X(b.x0), x1 = T.X(b.x1), y0 = T.Y(b.y0), y1 = T.Y(b.y1);
        const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
        if (!inside(x + w / 2, y + h / 2) && !inside(x, y) && !inside(x + w, y + h)) continue;
        const col = teamHex(b.t);
        const r = Math.min(w, h) * 0.18;
        c.save();
        if (A && A.rr) A.rr(c, x, y, w, h, r);
        else { c.beginPath(); c.rect(x, y, w, h); }
        c.globalAlpha = 0.2;
        c.fillStyle = col; c.fill();
        c.globalAlpha = 0.85;
        c.lineWidth = 1.5; c.lineJoin = "round"; c.strokeStyle = col; c.stroke();
        c.restore();
    }
}

export function drawMap(c, T, inside, dotR, pulse, mapLabel, trackPos) {
    if (!on()) return;
    const t = tw(), y = twy() || {};
    const me = myTeam(), foe = L.otherTeam(me);
    const selfId = A && A.selfId ? A.selfId() : -1;
    const now = performance.now();
    const gold = A ? A.HUD.gold : "#f2b83c";
    const ready = readyNow();
    for (const p of t.pads || []) {
        const mx = T.X(p.x), my = T.Y(p.y);
        if (!inside(mx, my)) continue;
        const col = teamHex(p.t);
        const mine = p.t === me;
        c.save();
        if (mine && ready) {
            for (let i = 0; i < 2; i++) {
                const k = ((now / 1300) + i / 2) % 1;
                c.globalAlpha = 1 - k;
                c.lineWidth = 2.4; c.strokeStyle = gold;
                c.beginPath(); c.arc(mx, my, dotR * (2 + 5 * k), 0, TAU); c.stroke();
            }
            c.globalAlpha = 1;
        }
        c.beginPath(); c.arc(mx, my, dotR * 1.7, 0, TAU);
        c.lineWidth = 2; c.strokeStyle = "#000"; c.stroke();
        c.lineWidth = 1.3; c.strokeStyle = mine && ready ? gold : col; c.stroke();
        c.restore();
        titanGlyph(c, mx, my, dotR * 0.95, mine && ready ? gold : col, "#000");
        mapLabel("War Pad", mx, my + dotR * 1.9, false, mine && ready ? gold : col, true);
    }
    for (const tl of t.tails || []) {
        const mx = T.X(tl.x), my = T.Y(tl.y);
        if (!inside(mx, my)) continue;
        const own = tl.t === L.BLUE || tl.t === L.RED ? teamHex(tl.t) : OUTPOST_GREY;
        const rr = dotR * 1.35;
        c.save();
        c.beginPath(); c.arc(mx, my, rr, 0, TAU);
        c.fillStyle = own; c.strokeStyle = "#000"; c.lineWidth = 1.6;
        c.fill(); c.stroke();
        c.beginPath();
        c.moveTo(mx - rr * 0.45, my + rr * 0.45); c.lineTo(mx - rr * 0.45, my - rr * 0.55);
        c.lineTo(mx + rr * 0.5, my - rr * 0.3); c.lineTo(mx - rr * 0.45, my - rr * 0.05);
        c.lineWidth = Math.max(1, rr * 0.22); c.strokeStyle = "#ffffff"; c.lineJoin = "round"; c.stroke();
        c.restore();
        const p = Math.max(0, Math.min(1, +tl.p || 0));
        if (p > 0.01 && (tl.c === L.BLUE || tl.c === L.RED)) {
            const cr = dotR * 2.4;
            c.save();
            c.lineWidth = Math.max(2, dotR * 0.7);
            c.strokeStyle = "rgba(0,0,0,0.6)";
            c.beginPath(); c.arc(mx, my, cr, 0, TAU); c.stroke();
            c.strokeStyle = teamHex(tl.c);
            c.beginPath(); c.arc(mx, my, cr, -Math.PI / 2, -Math.PI / 2 + p * TAU); c.stroke();
            c.restore();
        }
        mapLabel(String(tl.n || "Outpost"), mx, my + dotR * 2.6, false, own, true);
    }
    const mateCol = teamHex(me || L.BLUE), foeCol = teamHex(foe || L.RED);
    for (const m of y.mates || []) {
        if (!m || m[0] === selfId || personMarked(m[0])) continue;
        const p = trackPos("twm" + m[0], m[1], m[2], 0.8);
        const mx = T.X(p.x), my = T.Y(p.y);
        if (!inside(mx, my)) continue;
        const rr = dotR * (m[3] ? 0.72 : 1);
        c.beginPath(); c.arc(mx, my, rr, 0, TAU);
        c.fillStyle = mateCol; c.strokeStyle = "#000"; c.lineWidth = m[3] ? 1.2 : 1.6;
        c.fill(); c.stroke();
        if (!m[3]) {
            c.beginPath(); c.arc(mx, my, rr * 0.38, 0, TAU);
            c.fillStyle = "rgba(255,255,255,0.85)"; c.fill();
        }
    }
    for (const f of y.foes || []) {
        if (!f || personMarked(f[0])) continue;
        const p = trackPos("twf" + f[0], f[1], f[2], 0.8);
        const mx = T.X(p.x), my = T.Y(p.y);
        if (!inside(mx, my)) continue;
        c.beginPath(); c.arc(mx, my, dotR * 0.9, 0, TAU);
        c.fillStyle = foeCol; c.strokeStyle = "#000"; c.lineWidth = 1.5;
        c.fill(); c.stroke();
    }
    for (const ti of t.ti || []) {
        if (!ti) continue;
        const p = trackPos("twt" + ti.e, ti.x, ti.y, 0.5);
        const mx = T.X(p.x), my = T.Y(p.y);
        if (!inside(mx, my)) continue;
        const col = teamHex(ti.t);
        const beat = 0.5 + 0.5 * Math.sin(now / 260);
        c.save();
        c.globalAlpha = 0.5 + 0.4 * beat;
        c.beginPath(); c.arc(mx, my, dotR * (3.8 + 1.2 * beat), 0, TAU);
        c.lineWidth = 4.4; c.strokeStyle = "rgba(0,0,0,0.55)"; c.stroke();
        c.lineWidth = 2.6; c.strokeStyle = col; c.stroke();
        c.restore();
        titanGlyph(c, mx, my, dotR * 2.8, col, "#000");
        mapLabel(String(ti.n || (L.teamName(ti.t) + " Titan")), mx, my - dotR * 4.6, true, col, true);
    }
}

export function worldMarks(marks, toScreen, onScreen, me, trackPos) {
    if (!on()) return;
    const mine = myTeam();
    for (const ti of tw().ti || []) {
        if (!ti || (ti.t !== L.BLUE && ti.t !== L.RED)) continue;
        const p = trackPos("twt" + ti.e, ti.x, ti.y, 0.5);
        const s = toScreen(p.x, p.y);
        if (onScreen(s, -80)) continue;
        const ours = ti.t === mine;
        marks.push({ pri: ours ? 0.45 : 0.35, s, col: teamHex(ti.t), glyph: "titan", name: ours ? "Your Titan" : L.teamName(ti.t) + " Titan", d: Math.hypot(p.x - me.x, p.y - me.y) });
    }
    if (!readyNow() || global.died) return;
    const pad = myPad();
    if (!pad || nearMyPad()) return;
    const s = toScreen(pad.x, pad.y);
    const d = Math.hypot(pad.x - me.x, pad.y - me.y);
    const gold = A ? A.HUD.gold : "#f2b83c";
    if (!onScreen(s, -40)) marks.push({ pri: -5, s, col: gold, glyph: "titan", name: "Your War Pad", d });
    if (d > 260 && A && A.padArrow) A.padArrow(Math.atan2(pad.y - me.y, pad.x - me.x));
}

export function skipArrasMates() { return on() && !!twy(); }

export function vaultTeam(v) {
    if (!v || !on()) return v ? v.team : 0;
    if (v.kind === "tail") {
        const tl = L.tailAt(tw().tails, v.x, v.y);
        if (tl) return L.teamIdOfNo(tl.t | 0);
    }
    return v.team | 0;
}
export function vaultMapCol(v, blue, red) {
    const tm = vaultTeam(v);
    return tm === -1 ? blue : tm === -2 ? red : v && v.kind === "tail" ? OUTPOST_GREY : NEUTRAL;
}
export function outpostWorld(v) {
    if (!v || !on() || v.kind !== "tail") return null;
    const n = L.teamNoOfId(vaultTeam(v));
    return { col: n ? teamHex(n) : OUTPOST_GREY, neutral: !n, label: "Outpost bank" };
}

export function teamRowHex(row) {
    const t = row && row.t | 0;
    return t === L.BLUE || t === L.RED ? teamHex(t) : null;
}
export function isTop(tops, row) { return L.isTeamTop(tops, row); }
export function boardTops() { return on() ? L.teamTops(global.royale.board) : null; }
export function huntMark(c, x, y, r, col) {
    skullIcon(c, x, y, r * 1.1, col || HUNT_RED, "#1a1a1a");
}

export function huntHidden(h) {
    if (!h || !on()) return false;
    const me = myTeam();
    return !!me && L.teamNoOfId(h.tm) === me;
}

export function baseDeathText(fallback) { return on() ? L.BASE_DEATH : fallback; }
export function baseDeathTip(fallback) { return on() ? L.BASE_DEATH_TIP : fallback; }

export function calloutCol(kind) {
    if (!on()) return null;
    const me = myTeam(), foe = L.otherTeam(me);
    switch (kind) {
        case "warfull": case "titan": case "tailtake": return teamHex(me);
        case "titanfoe": case "radarfoe": case "taillost": return teamHex(foe);
        case "radar": return TEAL;
        case "supply": return "#6ff5a8";
        case "teamday": case "teambattle": case "titansiege": case "titandown": return A ? A.HUD.gold : "#f2b83c";
        default: return null;
    }
}

function introSeen() {
    if (S.seenIntro === null) { try { S.seenIntro = localStorage.getItem(L.INTRO_KEY) === "1"; } catch (e) { S.seenIntro = false; } }
    return S.seenIntro;
}
function closeIntro() {
    S.intro.state = "done";
    S.intro.rect = null;
    try { gameSound.uiClick(); } catch (e) { void e; }
}
const INTRO_MS = 10000;
export function drawIntro(c, top) {
    const I = S.intro;
    I.rect = null;
    if (!A || !on() || I.state === "done") return;
    const me = myTeam();
    const playing = !!global.gameStart && !global.died && !global.disconnected && !global.royaleSpectating;
    const now = performance.now();
    if (!playing || !me) { I.aliveAt = 0; if (I.state === "up") I.state = "wait"; return; }
    if (!I.state) { if (introSeen()) { I.state = "done"; return; } I.state = "wait"; }
    if (!I.aliveAt) I.aliveAt = now;
    if (I.state === "wait") {
        if (now - I.aliveAt < 1500 || global.introCardUp || global.introWait || global.hudCardUp || global._nxCardWas || global.showBigMap || global.showTree) return;
        I.state = "up"; I.at = now;
        S.seenIntro = true;
        try { localStorage.setItem(L.INTRO_KEY, "1"); } catch (e) { void e; }
    }
    const age = now - I.at;
    if (age > INTRO_MS) { I.state = "done"; return; }
    global.hudCardUp = global.hudCardUp || "teamIntro";
    const HUD = A.HUD;
    const lines = L.introLines(me);
    const col = teamHex(me);
    const W = Math.round(Math.min(420, global.screenWidth - 32));
    const body = A.wrap(lines.body, 12.5, W - 32);
    const H = 44 + body.length * 17 + 10;
    const x = Math.round((global.screenWidth - W) / 2);
    const fade = Math.min(1, age / 250, (INTRO_MS - age) / 400);
    const y = Math.round(Math.max(top + 6, global.screenHeight * 0.2)) + (1 - Math.min(1, age / 250)) * -8;
    I.rect = { x, y, w: W, h: H };
    c.save();
    c.globalAlpha *= Math.max(0, fade);
    A.hudPanel(c, x, y, W, H, { fill: HUD.card, r: 10 });
    A.rr(c, x + 1.5, y + 1.5, W - 3, H - 3, 9);
    c.strokeStyle = col; c.lineWidth = 2.5; c.stroke();
    titanGlyph(c, x + 24, y + 24, 9, col, HUD.ink);
    A.hudTitle(lines.title, x + 40, y + 24, 18, col, "left", fade, c);
    for (let i = 0; i < body.length; i++) A.drawText(body[i], x + 16, y + 50 + i * 17, 12.5, HUD.text, "left", true, fade);
    const left = Math.max(0, 1 - age / INTRO_MS);
    c.fillStyle = col;
    c.globalAlpha *= 0.6;
    c.fillRect(x + 10, y + H - 4, (W - 20) * left, 2);
    c.restore();
    if (global.mobile && A.touchRect) A.touchRect(I.rect, "teamIntro");
}

const INVITE_COPIED = "Invite link copied. Send it to a friend to play on your team.";
const INVITE_OFF = "Team invites aren't available right now. Try again in a moment.";
const INVITE_KEEP_MS = 5 * 60000;
const INVITE_WAIT_MS = 5000;
const SENT_KEEP_MS = 60000;
const FRIENDS_SHOWN = 30;
const INV = { btn: null, pop: null, list: null, friendsBtn: null, friendsOpen: false, unsub: null, askAt: -1e9, url: "", code: "", urlAt: -1e9, waiters: [], sending: new Set(), sent: new Map() };
const TOP_ROW_IDS = ["ingameSettingsBtn", "touchChatBtn", "touchRecBtn", "touchAutoBtn", "touchPingBtn", "ingameFullscreenBtn"];

export function inviteWanted() { return !!(global.royale && global.royale.tw); }

function refocusGame() {
    const cv = document.getElementById("gameCanvas");
    if (cv && global.gameStart && !global.mobile) cv.focus();
}

export function inviteButton() {
    if (INV.btn || typeof document === "undefined") return INV.btn;
    const b = document.createElement("button");
    b.id = "ingameInviteBtn";
    b.type = "button";
    b.className = "dw-igbtn";
    b.title = "Invite a friend to your team";
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.innerHTML = '<svg class="dw-ic"><use href="#i-invite"/></svg>';
    b.onclick = () => {
        b.blur();
        if (INV.pop) closeInvitePop();
        else openInvitePop();
        refocusGame();
    };
    document.body.appendChild(b);
    INV.btn = b;
    return b;
}

export function placeInviteButton(show) {
    const b = INV.btn;
    if (!b) return;
    if (!inviteWanted()) { INV.url = ""; INV.code = ""; }
    const want = show && inviteWanted() ? "flex" : "none";
    if (b.style.display !== want) b.style.display = want;
    if (want === "none") { closeInvitePop(); return; }
    let right = 0;
    for (const id of TOP_ROW_IDS) {
        const el = document.getElementById(id);
        if (!el || el === b || getComputedStyle(el).display === "none") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0) right = Math.max(right, rect.right);
    }
    const left = (right ? right + 8 : 10) + "px";
    if (b.style.left !== left) b.style.left = left;
    if (INV.pop) placeInvitePop();
}

function openInvitePop() {
    if (INV.pop || !INV.btn) return;
    const pop = h("div", { id: "dwInvitePop", class: "ip-pop", role: "menu", "aria-label": "Invite to your team" });
    for (const t of ["mousedown", "mouseup", "click", "contextmenu", "touchstart", "wheel"]) {
        pop.addEventListener(t, (e) => e.stopPropagation(), t === "touchstart" || t === "wheel" ? { passive: true } : undefined);
    }
    const copyBtn = h("button", { type: "button", class: "ip-item", role: "menuitem", onclick: () => { closeInvitePop(); askInvite(); refocusGame(); } },
        icon("copy"), h("span", { text: "Copy invite link" }));
    const friendsBtn = h("button", { type: "button", class: "ip-item", role: "menuitem", "aria-expanded": "false", onclick: toggleInviteFriends },
        icon("friends"), h("span", { text: "Invite a friend" }));
    const list = h("div", { class: "ip-list", hidden: true });
    pop.append(copyBtn, friendsBtn, list);
    document.body.appendChild(pop);
    INV.pop = pop;
    INV.list = list;
    INV.friendsBtn = friendsBtn;
    INV.friendsOpen = false;
    INV.btn.classList.add("open");
    INV.btn.setAttribute("aria-expanded", "true");
    INV.unsub = social.on(renderInviteFriends);
    document.addEventListener("pointerdown", onInvitePopOutside, true);
    window.addEventListener("keydown", onInvitePopKey, true);
    window.addEventListener("resize", placeInvitePop);
    placeInvitePop();
    if (!freshInviteUrl()) requestInviteCode();
    try { gameSound.uiClick(); } catch (e) { void e; }
}

function closeInvitePop() {
    if (!INV.pop) return;
    INV.pop.remove();
    INV.pop = null;
    INV.list = null;
    INV.friendsBtn = null;
    INV.friendsOpen = false;
    if (INV.unsub) { INV.unsub(); INV.unsub = null; }
    document.removeEventListener("pointerdown", onInvitePopOutside, true);
    window.removeEventListener("keydown", onInvitePopKey, true);
    window.removeEventListener("resize", placeInvitePop);
    if (INV.btn) {
        INV.btn.classList.remove("open");
        INV.btn.setAttribute("aria-expanded", "false");
    }
}

function onInvitePopOutside(e) {
    const t = e.target;
    if (INV.pop && INV.pop.contains(t)) return;
    if (INV.btn && INV.btn.contains(t)) return;
    closeInvitePop();
}

function onInvitePopKey(e) {
    if (e.key !== "Escape" && e.keyCode !== 27) return;
    e.preventDefault();
    e.stopPropagation();
    closeInvitePop();
    refocusGame();
}

function placeInvitePop() {
    const pop = INV.pop, b = INV.btn;
    if (!pop || !b) return;
    const r = b.getBoundingClientRect();
    const w = pop.offsetWidth || 240;
    const left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8)));
    pop.style.left = left + "px";
    pop.style.top = Math.round(r.bottom + 8) + "px";
    pop.style.maxHeight = Math.max(120, Math.round(window.innerHeight - r.bottom - 24)) + "px";
}

function toggleInviteFriends() {
    if (!INV.pop) return;
    INV.friendsOpen = !INV.friendsOpen;
    INV.friendsBtn.classList.toggle("on", INV.friendsOpen);
    INV.friendsBtn.setAttribute("aria-expanded", INV.friendsOpen ? "true" : "false");
    INV.list.hidden = !INV.friendsOpen;
    if (INV.friendsOpen && signedIn() && !social.get().loaded) social.load().then(renderInviteFriends, () => renderInviteFriends());
    renderInviteFriends();
    placeInvitePop();
}

function signedIn() {
    return !!acctState.get("user") && acctState.get("mode") === "user" && !acctState.get("offline");
}

function inviteNote(text) {
    return h("div", { class: "ip-note", text });
}

function renderInviteFriends() {
    const list = INV.list;
    if (!list || !INV.friendsOpen) return;
    clear(list);
    if (!signedIn()) { list.append(inviteNote("Sign in to invite friends.")); return; }
    const d = social.get();
    if (!d.loaded) { list.append(inviteNote("Loading your friends...")); return; }
    const online = d.friends.filter((f) => presenceState(f.presence) !== "offline").sort(byPresence);
    if (!online.length) { list.append(inviteNote("None of your friends are online right now.")); return; }
    const now = Date.now();
    for (const [id, until] of INV.sent) if (until < now) INV.sent.delete(id);
    for (const f of online.slice(0, FRIENDS_SHOWN)) {
        const sending = INV.sending.has(f.userId), sent = INV.sent.has(f.userId);
        const act = h("button", {
            type: "button", class: "ip-send" + (sent ? " sent" : ""), disabled: sending || sent,
            text: sending ? "Sending..." : sent ? "Sent" : "Invite",
            onclick: () => inviteFriend(f),
        });
        list.append(h("div", { class: "ip-row" },
            h("div", { class: "ip-who" },
                h("span", { class: "ip-name", text: f.username }),
                h("span", { class: "ip-st", text: presenceText(f.presence, f.rank) })),
            act));
    }
}

async function inviteFriend(f) {
    if (!f || !f.userId || INV.sending.has(f.userId)) return;
    INV.sending.add(f.userId);
    renderInviteFriends();
    const url = await inviteUrl();
    const code = url ? INV.code : "";
    let r = null;
    if (code) r = await api.teamInvite(f.userId, code);
    INV.sending.delete(f.userId);
    if (!code) global.createMessage(INVITE_OFF, 4000);
    else if (r && r.ok) {
        INV.sent.set(f.userId, Date.now() + SENT_KEEP_MS);
        global.createMessage("Invite sent to " + f.username + ".", 4000);
    } else global.createMessage(humanError(r), 5000);
    renderInviteFriends();
}

function freshInviteUrl() {
    return INV.url && performance.now() - INV.urlAt < INVITE_KEEP_MS ? INV.url : "";
}

function requestInviteCode() {
    const now = performance.now();
    if (now - INV.askAt < 1500) return true;
    INV.askAt = now;
    try { global.socket.talk("TI"); } catch (e) { INV.askAt = -1e9; return false; }
    return true;
}

function inviteUrl() {
    const kept = freshInviteUrl();
    if (kept) { requestInviteCode(); return Promise.resolve(kept); }
    return new Promise((resolve) => {
        INV.waiters.push(resolve);
        setTimeout(() => {
            const i = INV.waiters.indexOf(resolve);
            if (i >= 0) { INV.waiters.splice(i, 1); resolve(""); }
        }, INVITE_WAIT_MS);
        if (!requestInviteCode()) flushInviteWaiters("");
    });
}

function flushInviteWaiters(url) {
    const waiting = INV.waiters.splice(0);
    for (const fn of waiting) { try { fn(url); } catch (e) { void e; } }
}

function askInvite() {
    const kept = freshInviteUrl();
    if (kept) { deliverInvite(kept); requestInviteCode(); return; }
    inviteUrl().then((url) => {
        if (url) deliverInvite(url);
        else global.createMessage(INVITE_OFF, 4000);
    });
}

export function onInviteCode(code) {
    INV.askAt = -1e9;
    code = String(code || "").trim();
    if (!code) {
        INV.url = "";
        INV.code = "";
        flushInviteWaiters("");
        return;
    }
    INV.code = code;
    INV.url = location.origin + "/?team=" + encodeURIComponent(code);
    INV.urlAt = performance.now();
    flushInviteWaiters(INV.url);
}

function deliverInvite(url) {
    if (global.mobile && navigator.share) {
        let shared;
        try { shared = navigator.share({ title: "Corez", text: "Come play on my team in Corez!", url }); } catch (e) { shared = Promise.reject(e); }
        Promise.resolve(shared).then(
            () => global.createMessage("Invite link shared. Your friend will join your team.", 4000),
            (e) => { if (!e || e.name !== "AbortError") copyInvite(url); }
        );
        return;
    }
    copyInvite(url);
}

function copyInvite(url) {
    copyText(url).then((ok) => {
        if (ok) { global.createMessage(INVITE_COPIED, 4500); return; }
        menuToast("Your team invite link is ready.", { duration: 9000, actions: [{ label: "Copy link", onClick: () => copyNow(url) }] });
    });
}

function copyNow(url) {
    if (copyByHand(url)) { global.createMessage(INVITE_COPIED, 4500); return; }
    copyText(url).then((ok) => global.createMessage(ok ? INVITE_COPIED : "Your invite link: " + url, ok ? 4500 : 9000));
}

function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => copyByHand(text));
    }
    return Promise.resolve(copyByHand(text));
}

function copyByHand(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
    document.body.appendChild(ta);
    let ok = false;
    try {
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand("copy");
    } catch (e) { ok = false; }
    ta.remove();
    return !!ok;
}

if (typeof window !== "undefined") {
    window.dwTeamWar = {
        state: () => ({ on: on(), team: myTeam(), padUp: S.padUp, dismissed: S.dismissed, intro: S.intro.state, buttons: S.buttons.map(b => ({ n: b.n, label: b.label, sub: b.sub, enabled: b.enabled })) }),
        resetIntro: () => { try { localStorage.removeItem(L.INTRO_KEY); } catch (e) { void e; } S.seenIntro = false; S.intro.state = ""; return true; },
    };
}
