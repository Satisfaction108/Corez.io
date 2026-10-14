import { global } from "./global.js";
import { util } from "./util.js";
import * as L from "./firstHintsLogic.js";
import { active as coachActive } from "./coach.js";

const now = () => performance.now();
const SCAN_MS = 250;
const CARD_W = 260;
const CARD_W_TOUCH = 230;

function loadSeen() {
    try { return L.parseSeen(localStorage.getItem(L.KEY)); } catch (e) { return new Set(); }
}
function saveSeen(seen) {
    try { localStorage.setItem(L.KEY, L.serializeSeen(seen)); } catch (e) { }
}

const st = L.createState(loadSeen());
let scanAt = 0, aliveAt = 0, wasPlaying = false, lastH = 96, goneAt = 0;
let visible = new Set(), reached = new Set();
const pinned = new Set();
let el = null, titleEl = null, bodyEl = null, barEl = null, shownId = null;
let placeAt = 0, placed = null, styleKey = "", barShown = -1;

const STYLE = "#dwHint{position:fixed;z-index:42;box-sizing:border-box;padding:8px 30px 10px 12px;border-radius:6px;" +
    "background:rgba(0,0,0,.3);color:#fff;pointer-events:none;opacity:0;transform:translateX(10px);" +
    "transition:opacity .22s ease,transform .22s ease;font-family:Ubuntu,sans-serif;}" +
    "#dwHint.on{opacity:1;transform:none;}" +
    "#dwHint .dwh-title{font:400 17px/1.1 'Lilita One',Ubuntu,sans-serif;letter-spacing:.01em;margin:0 0 4px;" +
    "-webkit-text-stroke:3px #333;paint-order:stroke fill;}" +
    "#dwHint .dwh-body{font-weight:700;font-size:13px;line-height:1.35;" +
    "-webkit-text-stroke:2.5px #333;paint-order:stroke fill;}" +
    "#dwHint .dwh-x{position:absolute;top:5px;right:5px;width:22px;height:22px;padding:0;border:0;border-radius:4px;" +
    "background:rgba(255,255,255,.12);cursor:pointer;pointer-events:auto;display:flex;align-items:center;justify-content:center;}" +
    "#dwHint .dwh-x:hover{background:rgba(255,255,255,.24);}" +
    "#dwHint .dwh-bar{position:absolute;left:0;right:0;bottom:0;height:3px;border-radius:0 0 6px 6px;overflow:hidden;}" +
    "#dwHint .dwh-bar i{display:block;height:100%;background:rgba(255,255,255,.55);transform-origin:left center;}" +
    "body.mobile #dwHint .dwh-title{font-size:15px;}body.mobile #dwHint .dwh-body{font-size:12px;}" +
    "html[data-theme=light] #dwHint{background:rgba(255,255,255,.92);color:#222;border:1px solid rgba(0,0,0,.16);}" +
    "html[data-theme=light] #dwHint .dwh-title,html[data-theme=light] #dwHint .dwh-body{-webkit-text-stroke:0;}" +
    "html[data-theme=light] #dwHint .dwh-x{background:rgba(0,0,0,.08);}html[data-theme=light] #dwHint .dwh-x path{stroke:#333;}" +
    "html[data-theme=light] #dwHint .dwh-bar i{background:rgba(0,0,0,.3);}";

const X_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';

function build() {
    if (el && el.isConnected) return el;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
    el = document.createElement("div");
    el.id = "dwHint";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    const x = document.createElement("button");
    x.type = "button";
    x.className = "dwh-x";
    x.setAttribute("aria-label", "Close");
    x.innerHTML = X_SVG;
    for (const t of ["mousedown", "mouseup", "click", "touchstart", "touchend", "pointerdown"]) {
        x.addEventListener(t, (e) => {
            e.stopPropagation();
            if (t === "click" || t === "touchend") {
                if (t === "touchend") e.preventDefault();
                close("x");
            }
        }, t === "touchstart" ? { passive: true } : undefined);
    }
    titleEl = document.createElement("div");
    titleEl.className = "dwh-title";
    bodyEl = document.createElement("div");
    bodyEl.className = "dwh-body";
    barEl = document.createElement("div");
    barEl.className = "dwh-bar";
    barEl.appendChild(document.createElement("i"));
    el.append(x, titleEl, bodyEl, barEl);
    document.body.appendChild(el);
    return el;
}

function close(why) {
    if (st.cur) pinned.delete(st.cur);
    L.dismiss(st, st.cur, now());
    render(null, null);
    try {
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#dwHint")) document.activeElement.blur();
        const cv = document.getElementById("gameCanvas");
        if (cv && why === "x") cv.focus({ preventScroll: true });
    } catch (e) { }
}

function playing() {
    const r = global.royale;
    let guide = false;
    try { guide = coachActive(); } catch (e) { guide = false; }
    return !!(global.gameStart && r && r.at > 0 && !global.tutorialMode && !global.died && !global.disconnected &&
        !global.royaleSpectating && !global.royaleDied && !r.ending && !guide);
}

function view() {
    let ratio = 1;
    try { ratio = util.getRatio(); } catch (e) { }
    if (!isFinite(ratio) || ratio <= 0) ratio = 1;
    return { x: global.player.renderx, y: global.player.rendery, hw: global.screenWidth / 2 / ratio * 0.88, hh: global.screenHeight / 2 / ratio * 0.88 };
}

function inView(v, x, y, r = 0) {
    return isFinite(x) && isFinite(y) && Math.abs(x - v.x) < v.hw + r * 0.5 && Math.abs(y - v.y) < v.hh + r * 0.5;
}

function scan() {
    const v = view();
    visible = new Set();
    reached = new Set();
    if (!isFinite(v.x) || !isFinite(v.y)) return;
    if (global.vault && global.vault.onPad) reached.add("vault");
    if (global.shop && global.shop.onPad) reached.add("shop");
    const want = id => !st.seen.has(id) || st.cur === id;
    if (want("vault")) for (const p of global.vaults || []) if (p && inView(v, p.x, p.y, p.r || 95)) { visible.add("vault"); break; }
    if (want("shop")) for (const p of global.shops || []) if (p && inView(v, p.x, p.y, p.r || 95)) { visible.add("shop"); break; }
    for (const id of pinned) visible.add(id);
    for (const id of visible) L.notice(st, id);
}

function blocked() {
    return !!(global.hudCardUp || global.showBigMap || global.showTree || global.showChat && global.mobile ||
        global.touchTilesOpen || global.touchStatsOpen || global.introCardUp ||
        (global.shop && global.shop.onPad) || (global.vault && global.vault.onPad));
}

function avoidCss(avoidFn) {
    const out = [];
    let rs = [];
    try { rs = avoidFn ? avoidFn() || [] : []; } catch (e) { rs = []; }
    const k = global.ratio || 1;
    for (const r of rs) if (r && isFinite(r.x) && isFinite(r.w)) out.push({ x: r.x / k, y: r.y / k, w: r.w / k, h: r.h / k });
    return out;
}

function render(id, rect) {
    if (!id || !rect) {
        if (el && shownId !== null) el.classList.remove("on");
        shownId = null;
        styleKey = "";
        global.hintRect = null;
        return;
    }
    build();
    if (shownId !== id) {
        const h = L.HINTS[id];
        titleEl.textContent = h.title;
        bodyEl.textContent = h.body;
        shownId = id;
        styleKey = "";
    }
    const key = rect.x + "," + rect.y + "," + rect.w;
    if (key !== styleKey) {
        styleKey = key;
        el.style.width = rect.w + "px";
        el.style.left = rect.x + "px";
        el.style.top = rect.y + "px";
        el.classList.add("on");
        lastH = el.offsetHeight || lastH;
    }
    const left = Math.round(Math.max(0, 1 - st.shownMs / L.SHOW_MS) * 200) / 200;
    const bar = barEl.firstChild;
    if (bar && left !== barShown) { barShown = left; bar.style.transform = "scaleX(" + left + ")"; }
    const k = global.ratio || 1;
    global.hintRect = { x: rect.x * k, y: rect.y * k, w: rect.w * k, h: rect.h * k };
}

export function hook(avoidFn) {
    const t = now();
    if (!playing()) {
        wasPlaying = false;
        if (st.cur) L.dismiss(st, st.cur, t);
        render(null, null);
        return;
    }
    if (!wasPlaying) { wasPlaying = true; aliveAt = t; }
    if (t - aliveAt < L.SETTLE_MS) { render(null, null); return; }
    if (t - scanAt >= SCAN_MS) {
        scanAt = t;
        scan();
        if (st.cur && !pinned.has(st.cur) && !visible.has(st.cur) && !reached.has(st.cur)) {
            if (!goneAt) goneAt = t;
            else if (t - goneAt > 1500) { goneAt = 0; close("gone"); }
        } else goneAt = 0;
    }
    if (!st.cur && !st.queue.length) { render(null, null); return; }
    if (t - placeAt >= SCAN_MS) {
        placeAt = t;
        global.hintRect = null;
        const W = innerWidth, H = innerHeight;
        const w = Math.min(global.mobile ? CARD_W_TOUCH : CARD_W, W - 24);
        placed = L.place(W, H, w, lastH, avoidCss(avoidFn));
    }
    const res = L.step(st, t, { visible, reached, blocked: blocked() || !placed });
    if (res.started) { pinned.delete(res.started); saveSeen(st.seen); }
    if (!res.show) { render(null, null); return; }
    render(res.show, placed);
}

if (typeof window !== "undefined") {
    window.dwHints = {
        state: () => ({ seen: [...st.seen], queue: st.queue.slice(), cur: st.cur, shownMs: Math.round(st.shownMs), visible: [...visible], reached: [...reached], rect: el && st.cur ? el.getBoundingClientRect().toJSON() : null }),
        reset: () => { st.seen.clear(); st.queue.length = 0; st.cur = null; st.shownMs = 0; st.endAt = -1e9; saveSeen(st.seen); return true; },
        force: (id) => { if (!L.HINTS[id]) return false; if (st.cur === id) return true; st.seen.delete(id); st.endAt = -1e9; pinned.add(id); scanAt = 0; return L.notice(st, id); },
        close: () => { close("x"); return true; },
    };
}
