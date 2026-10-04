import { global } from "./global.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";

// First-raid coach: a light do-it guide for new players in real raids.
//
//   tutorial offer the tutorial              (skipped once it's been played)
//   move     drive and shoot                 (a short warm-up)
//   mine     carry 250 gems                  (nearby ore rocks outlined)
//   bank     finish a deposit                (arrow to the nearest vault, the minimap)
//   upgrade  a new tank or a stat point      (waits while neither is on offer)
//   ability  use your ability or a kit item  (buy one at a shop first; a
//            first bank often hands out a free ability trial)
//
// Progress lives in localStorage, so a death, reload, resume or new raid
// carries on from the current step. Anything done early (a deposit during the
// mining step) counts. Dying on the bank step with the gems gone sends you back
// to mining. The tutorial server never runs this.
//
// One card at a time: the guide steps aside while a big card holds the middle
// of the screen (app.js global.hudCardUp: NEW ABILITY, event callouts, the
// spawn shield line, kit placement, raid results), a director moment's banner
// (newcomer.js global.nxBannerUp), the shop panel or the map.
//
// First raids (newcomer.js, the server's stage): the goal line under the clock
// follows this guide's step, stage 0 skips the shop/ability step until a
// later raid (or a director moment hands out an ability), and once the server
// sends a stage it decides who gets the guide (stages 0-1).
//
// Contracts (the server's one-job-at-a-time card) wait while the guide runs:
// the CO packet tells the server whether it's on, and the first contract
// rolls once the guide is done or skipped.
//
// app.js calls hook() every frame after the GUI, drawWorld() from the camera
// pass and drawIndicators() at the very end of the frame. window.dwHud (app.js)
// gives the HUD rects and the edge marker.

const KEY = "dwCoach_v1";
const ORDER = ["tutorial", "move", "mine", "bank", "upgrade", "ability"];
// the numbered steps; the tutorial offer is an intro card
const STEPS = ORDER.filter(id => id !== "tutorial");
const TUT_DONE_KEY = "digRoyaleTutorialDone_v1";   // tutorial.js / home.js
const TUT_AFTER_KEY = "dwCoachTutorial";            // sessionStorage: open the tutorial once the menu loads
const TUT_PROMPT_MS = 25000;  // an ignored offer turns into "Maybe later"
const MINE_GOAL = 250;
const MOVE_GOAL = 250;         // world units driven on the warm-up step
const FLASH_MS = 1300;
const FINAL_MS = 9000;
const SETTLE_MS = 1200;       // after a spawn the tank's type and stats are still arriving
const VAULT_MIN = 15;
const GOLD = "#f2b83c";
const SHOP_COL = "#5ce0d8";
const INK = "#0c0a0e";
const ORE_RGB = { 1: "237,167,102", 2: "127,177,242", 3: "217,138,240", 4: "111,245,168" };
// The HUD's check badge: a green keycap (face over its darker lip, ink
// keyline) with a chunky ink-rimmed tick.
const CHECK = '<svg viewBox="0 0 20 20" aria-hidden="true">' +
    '<rect x=".75" y=".75" width="18.5" height="18.5" rx="5" fill="#2c8f37"/>' +
    '<rect x=".75" y=".75" width="18.5" height="16" rx="5" fill="#4fcf5c"/>' +
    '<rect x=".75" y=".75" width="18.5" height="18.5" rx="5" fill="none" stroke="#120e15" stroke-width="1.5"/>' +
    '<path d="M5.4 9.6l3.1 3.1 6-6.4" fill="none" stroke="#120e15" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M5.4 9.6l3.1 3.1 6-6.4" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';


const now = () => performance.now();
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const SW = () => global.screenWidth;
const SH = () => global.screenHeight;

// ── keybind labels (same store as the settings panel) ──────────────────
let keyCache = null;
function keyName(id, dflt) {
    if (!keyCache) {
        keyCache = {};
        try {
            const raw = localStorage.getItem("keybinds");
            if (raw && raw.startsWith("{")) keyCache = JSON.parse(raw) || {};
        } catch (e) { }
    }
    const k = keyCache[id];
    return (k && k[0]) || dflt;
}

// ── persisted progress ─────────────────────────────────────────────────
// status: "" undecided, "on", "done", "skipped", "veteran"
function blank() { return { v: 1, status: "", done: {}, at: Date.now() }; }
function load() {
    try {
        const r = JSON.parse(localStorage.getItem(KEY) || "null");
        if (r && r.v === 1 && typeof r.done === "object" && r.done) {
            // the old guide (points, tour, shop): past its first step, the
            // warm-up is old news; its shop step became the ability step
            if (r.done.points || r.done.upgrade || r.done.tour || r.done.mine) r.done.move = 1;
            if (r.done.shop) r.done.ability = 1;
            return r;
        }
    } catch (e) { }
    return blank();
}
let rec = load();
function save() { try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) { } }

// ── runtime state ──────────────────────────────────────────────────────
const st = {
    step: null,          // current step id, "final", or null
    begun: false,        // shown at least once this page load (lateInRaid holds the start)
    flash: null,         // { until } after a step completes
    finalAt: 0,
    moved: 0,            // world units driven on the move step
    fired: false,
    lastPos: null,
    confirm: false,
    acctWait: 0,
    visible: false,
    alive: false,
    aliveAt: 0,
    prev: null,          // last alive frame's snapshot, for edge detection
    bankDropAt: -1e9,
    rocks: [],           // ore rocks outlined right now (cell keys)
    rocksAt: 0,
    oreFar: null,        // nearest ore rock when none is on screen: { x, y, d, tier }
    ratio: 1,
    target: null,        // bank/shop pad this frame: { x, y, d, dx, dy, on }
    carried: 0,          // gems carried on the last alive frame
    death: null,         // { step, carried } until the respawn settles
    dropped: false,      // died with gems on the mine/bank step: say so on the mine step
    tutAt: 0,
    baseTop: 0,
    wroteTop: -1,
    top: -1,
    scale: "",
    size: { w: 0, h: 0 },
    sizeKey: "",
    sizeAt: 0,
    coSock: null,        // the socket the server last heard CO on, and what it said
    coOn: null,
};

// ── game reads ─────────────────────────────────────────────────────────
function inRaid() {
    return !!(global.gameStart && !global.tutorialMode && global.digRoyaleMode &&
        global.royale && global.royale.at > 0 && !global.disconnected);
}
// alive and actually spawned: not queued for a spawn, spectating, or behind
// the join plate
function playing() {
    const r = global.royale;
    const join = document.getElementById("dwJoin");
    return inRaid() && !global.died && !global.royaleSpectating && !global.royaleDied && !global.raidQueued &&
        !(r && r.ending) && !(join && join.classList.contains("open")) &&
        // the raid's last seconds belong to the countdown
        !(r && (r.raidLeft | 0) > 0 && (r.raidLeft | 0) <= 12);
}
// The storm is nearly shut or the raid nearly over: a first spawn now waits
// for the next storm before the guide starts.
function lateInRaid() {
    const r = global.royale || {}, s = r.storm;
    if (r.lock || r.ending) return true;
    if (s && s.a && (s.hold || (s.left | 0) < 30)) return true;
    return (r.left | 0) > 0 && (r.left | 0) < 90;
}
function skillSum() {
    let n = 0;
    for (const s of gui.skills || []) n += (s && s.amount) | 0;
    return n;
}
function tankName() {
    try { return global.mockups[parseInt(String(gui.type).split("-")[0], 10)].name || ""; }
    catch (e) { return ""; }
}
function mineGoal() {
    const cap = (global.gems && global.gems.cap) | 0;
    return cap > 0 ? Math.min(MINE_GOAL, cap) : MINE_GOAL;
}
function me() { return { x: global.player.renderx, y: global.player.rendery }; }
// How far outside the safe circle a point is (0 inside, or with no storm).
function stormOut(x, y) {
    const s = global.royale && global.royale.storm;
    if (!s || !s.a || !(s.r > 0)) return 0;
    return Math.max(0, Math.hypot(x - (s.cx || 0), y - (s.cy || 0)) - s.r);
}
// Nearest pad, but one in the storm only if nothing is safe.
function nearest(list) {
    const p = me();
    let best = null, bs = Infinity, bd = 0;
    for (const v of list || []) {
        if (!v || !isFinite(v.x) || !isFinite(v.y)) continue;
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        const score = d + (stormOut(v.x, v.y) > 0 ? 1e6 : 0);
        if (score < bs) { bs = score; bd = d; best = v; }
    }
    return best ? { x: best.x, y: best.y, r: best.r || 95, d: bd } : null;
}
function cheapestPrice() {
    let min = Infinity;
    for (const it of (global.shop && global.shop.catalog) || []) if (it && it.cat === "kit" && it.price > 0) min = Math.min(min, it.price);
    return isFinite(min) ? min : 0;
}
function terr() {
    const t = window.terrainRenderer;
    return (t && t.ready && t._world && t._cellPolys) ? t : null;
}
function fmtDist(d) { return d >= 1000 ? (d / 1000).toFixed(1) + "k" : String(Math.round(d)); }
function fmtNum(n) { return Math.round(n || 0).toLocaleString("en-US"); }

// ── who gets the coach ─────────────────────────────────────────────────
// Accounts: under 3 counted placement lives. Guests: no finished raid on this
// browser yet (digwarsRaidPB is only written once a raid ends with you in it).
// Anyone already mid-guide keeps going until it's done or skipped.
function decide(t) {
    if (rec.status) return;
    const signedIn = document.documentElement.getAttribute("data-acct") === "user";
    const acct = global.acct;
    if (signedIn && !acct) {
        if (!st.acctWait) st.acctWait = t;
        if (t - st.acctWait < 3000) return;
    }
    let veteran = false;
    const pl = acct && acct.rank && acct.rank.placement;
    // the server's first-raids stage (newcomer.js), once it sends one: the
    // first two raids get the guide, the third doesn't; a veteran (3) is
    // decided the old way, so nothing changes for them
    const nxEarly = global.nxKnown && (global.nxStage | 0) < 3;
    if (nxEarly) veteran = (global.nxStage | 0) >= 2;
    else if (pl) veteran = !!pl.done || (pl.lives | 0) >= 3;
    else {
        let pb = 0;
        try { pb = parseInt(localStorage.getItem("digwarsRaidPB") || "0", 10) || 0; } catch (e) { }
        veteran = pb > 0;
    }
    rec.status = veteran ? "veteran" : "on";
    save();
}

// ── events ─────────────────────────────────────────────────────────────
function snap() {
    const v = global.vault || {}, sh = global.shop || {}, g = global.gems || {};
    return {
        type: gui.type, ups: (gui.upgrades || []).length, sum: skillSum(), points: gui.points | 0,
        doneAt: v.doneAt, msgAt: sh.msgAt, banked: g.banked | 0, kitAt: global.kitUsedAt || 0, abAt: global.abilityUsedAt || 0,
    };
}
function markDone(id) {
    if (rec.done[id]) return;
    rec.done[id] = 1;
    save();
    if (st.step === id) {
        st.flash = { until: now() + FLASH_MS };
        sfxDone();
    }
}
function observe(t) {
    const cur = snap();
    const p = st.prev;
    st.prev = cur;
    if (!p || t - st.aliveAt < SETTLE_MS) return;
    const sh = global.shop || {};
    if (cur.banked < p.banked) st.bankDropAt = t;
    if (cur.sum > p.sum) markDone("upgrade");
    if (cur.type !== p.type && p.ups > 0) markDone("upgrade");
    // "Don't upgrade" empties the menu without a new type: they know where it is
    else if (cur.type === p.type && p.ups > 0 && cur.ups === 0) markDone("upgrade");
    if (cur.doneAt !== p.doneAt && cur.doneAt > 0) markDone("bank");
    if (cur.kitAt !== p.kitAt && cur.kitAt > 0) markDone("ability");
    if (cur.abAt !== p.abAt && cur.abAt > 0) markDone("ability");
    if (((global.gems && global.gems.carried) | 0) >= mineGoal()) markDone("mine");
    // the warm-up: some driving and a shot
    const q = me(), lp = st.lastPos;
    if (lp) { const d = Math.hypot(q.x - lp.x, q.y - lp.y); if (d < 80) st.moved += d; }
    st.lastPos = q;
    const sock = global.canvas && global.canvas.socket;
    if (sock && sock.cmd && sock.cmd.firing && sock.cmd.firing()) st.fired = true;
    if (st.moved >= MOVE_GOAL && st.fired) markDone("move");
}

// A step that can't be done right now is skipped over and comes back later.
function waiting(id) {
    if (id === "tutorial" && tutorialPlayed()) { markDone("tutorial"); return false; }
    // a first raid (stage 0) has no shops yet: the ability step waits for the
    // next raid, unless a director moment already handed one out
    if (id === "ability" && global.nxKnown && (global.nxStage | 0) === 0 && !ownsKit()) return true;
    if (id === "upgrade" && !(gui.upgrades || []).length && !canStat()) {
        const n = tankName();
        if ((n && n !== "Basic") || skillSum() > 0) { markDone("upgrade"); return false; }
        return true;
    }
    return false;
}
function canStat() {
    return (gui.points | 0) > 0 && (gui.skills || []).some(s => s && s.softcap > 0 && s.amount < s.cap);
}
function ownsAbility() { return !!(global.abil && global.abil.on && global.abil.eq); }
function ownsKit() { return ownsAbility() || !!((global.shop && global.shop.state && global.shop.state.kitOrder) || []).filter(Boolean).length; }
function pickStep() {
    for (const id of ORDER) {
        if (rec.done[id]) continue;
        if (waiting(id)) continue;
        return id;
    }
    return ORDER.every(id => rec.done[id]) ? "final" : null;
}

// ── the tutorial offer ─────────────────────────────────────────────────
function tutorialPlayed() {
    try { return localStorage.getItem(TUT_DONE_KEY) === "1"; } catch (e) { return false; }
}
function tutorialLater() {
    rec.done.tutorial = 1;
    save();
    st.step = null;
}
// A raid socket can't switch servers, so leave for the menu (like the
// tutorial's own send-off) and press its Tutorial button from there.
function tutorialPlay() {
    tutorialLater();
    try { sessionStorage.setItem(TUT_AFTER_KEY, "1"); } catch (e) { }
    // app.js asks "leave site?" while a game is live
    try { window.onbeforeunload = null; } catch (e) { }
    try { global.canvas.socket.close(); } catch (e) { }
    global.gameStart = false;
    ui.show(false);
    setTimeout(() => {
        try { location.replace(location.pathname); } catch (e) { try { location.reload(); } catch (e2) { } }
    }, 150);
}
(function tutorialAfterReload() {
    let want = false;
    try { want = sessionStorage.getItem(TUT_AFTER_KEY) === "1"; sessionStorage.removeItem(TUT_AFTER_KEY); } catch (e) { }
    if (!want) return;
    let n = 0;
    (function tick() {
        const g = window.global, b = document.getElementById("tutorialButton");
        const blocked = window.dwAccount && window.dwAccount.blocksEnter && window.dwAccount.blocksEnter();
        // home.js wires the button on DOMContentLoaded
        if (g && g.startGame && b && b.onclick && !b.disabled && !g.gameStart && !g.gameLoading && !blocked) { b.click(); return; }
        if (++n < 150) setTimeout(tick, 100);
    })();
})();

// ── HUD rects (app.js) ─────────────────────────────────────────────────
function hudRect(kind) {
    try { return window.dwHud ? window.dwHud.rect(kind) : null; } catch (e) { return null; }
}

// ── sound (the game's own synth, quiet) ────────────────────────────────
function canSound() { try { return !!(gameSound && gameSound._ready && gameSound._ready()); } catch (e) { return false; } }
function sfxDone() {
    if (!canSound()) return;
    try {
        gameSound._tone({ freq: 523.25, type: "triangle", dur: 0.1, peak: 0.07, attack: 0.008 });
        gameSound._tone({ freq: 783.99, type: "triangle", dur: 0.16, peak: 0.06, delay: 0.08, attack: 0.01 });
    } catch (e) { }
}
function sfxTick() {
    if (!canSound()) return;
    try { gameSound._tone({ freq: 392, type: "sine", dur: 0.06, peak: 0.03, attack: 0.01 }); } catch (e) { }
}

// ── the panel (DOM) ────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const kbd = (id, dflt) => "<kbd>" + esc(keyName(id, dflt)) + "</kbd>";
const mapOpens = () => global.mobile ? "Tap the minimap to open it." : kbd("KEY_TOGGLE_MAP", "M") + " opens it.";

const ui = {
    root: null, el: {}, key: "", barW: -1, barTxt: "",
    build() {
        if (this.root) return;
        try {
            if (!document.getElementById("dwCoachCss")) {
                const l = document.createElement("link");
                l.id = "dwCoachCss";
                l.rel = "stylesheet";
                l.href = new URL("../coach.css", import.meta.url).href;
                document.head.appendChild(l);
            }
        } catch (e) { }
        const root = document.createElement("div");
        root.id = "dwCoach";
        root.innerHTML =
            '<div class="dwc-top"><span class="dwc-eyebrow"></span><span class="dwc-pips"></span>' +
            '<button class="dwc-link dwc-quit" type="button">Skip guide</button></div>' +
            '<div class="dwc-title"></div>' +
            '<div class="dwc-text"></div>' +
            '<div class="dwc-bar"><i></i><span></span></div>' +
            '<div class="dwc-row"><button class="dwc-btn dwc-next" type="button">Next</button>' +
            '<button class="dwc-btn dwc-alt" type="button"></button></div>' +
            '<div class="dwc-confirm"><span>Skip the guide?</span>' +
            '<button class="dwc-btn dwc-danger dwc-yes" type="button">Skip it</button>' +
            '<button class="dwc-link dwc-no" type="button">Keep going</button></div>';
        document.body.appendChild(root);
        this.root = root;
        const q = s => root.querySelector(s);
        this.el = {
            eyebrow: q(".dwc-eyebrow"), pips: q(".dwc-pips"), title: q(".dwc-title"), text: q(".dwc-text"),
            bar: q(".dwc-bar"), fill: q(".dwc-bar i"), barTxt: q(".dwc-bar span"),
            row: q(".dwc-row"), next: q(".dwc-next"), alt: q(".dwc-alt"),
            confirm: q(".dwc-confirm"), quit: q(".dwc-quit"),
        };
        // clicks stay on the panel, keys go back to the game
        for (const ev of ["mousedown", "mouseup", "click", "contextmenu", "touchstart", "wheel", "pointerdown"]) {
            root.addEventListener(ev, e => e.stopPropagation(), ev === "touchstart" || ev === "wheel" ? { passive: true } : undefined);
        }
        const on = (b, fn) => b.addEventListener("click", e => { e.preventDefault(); fn(); focusGame(); });
        on(this.el.next, () => {
            if (st.step === "tutorial") tutorialPlay();
            else if (st.step === "final") closeFinal();
        });
        on(this.el.alt, () => { if (st.step === "tutorial") tutorialLater(); });
        on(this.el.quit, () => { st.confirm = true; });
        on(q(".dwc-no"), () => { st.confirm = false; });
        on(q(".dwc-yes"), () => {
            st.confirm = false;
            rec.status = "skipped";
            save();
        });
    },
    show(on) {
        if (!this.root) { if (!on) return; this.build(); }
        if (on === st.visible) return;
        st.visible = on;
        this.root.classList.toggle("on", on);
        if (!on) { global.coachRect = null; global.coachPointing = ""; restoreTop(); }
    },
    // content: { eyebrow, pips, title, text, bar:{frac,label}|null, next, alt, done }
    render(o) {
        const k = [o.eyebrow, o.pips, o.title, o.text, !!o.bar, o.next || "", o.alt || "", !!o.done, st.confirm].join("|");
        const e = this.el;
        if (k !== this.key) {
            this.key = k;
            e.eyebrow.textContent = o.eyebrow || "";
            e.pips.innerHTML = o.pips || "";
            e.title.innerHTML = (o.done ? '<i class="dwc-check">' + CHECK + "</i>" : "") + esc(o.title || "");
            e.text.innerHTML = o.text || "";
            e.bar.style.display = o.bar ? "" : "none";
            e.row.style.display = (o.next || o.alt) && !st.confirm ? "" : "none";
            e.next.style.display = o.next ? "" : "none";
            e.next.textContent = o.next || "";
            e.alt.style.display = o.alt ? "" : "none";
            e.alt.textContent = o.alt || "";
            e.confirm.style.display = st.confirm ? "" : "none";
            e.quit.style.visibility = st.confirm || st.step === "final" ? "hidden" : "";
            this.root.classList.toggle("done", !!o.done);
            this.barW = -1; this.barTxt = "";
            e.barTxt.textContent = "";
        }
        if (o.bar) {
            const w = Math.round(clamp(o.bar.frac, 0, 1) * 1000) / 10;
            if (w !== this.barW) { this.barW = w; e.fill.style.width = w + "%"; }
            if (o.bar.label !== this.barTxt) { this.barTxt = o.bar.label; e.barTxt.textContent = o.bar.label || ""; }
        }
    },
};
function focusGame() {
    try {
        const b = document.activeElement;
        if (b && b.blur) b.blur();
        const cv = document.getElementById("gameCanvas");
        if (cv && global.gameStart) cv.focus();
    } catch (e) { }
}
function closeFinal() {
    st.step = null;
    ui.show(false);
}

// Where the card goes. Desktop and upright phones: under the raid clock
// cluster (app.js publishes where it ends, in CSS px), pushing the DOM toast
// stack down by its own height. A sideways phone has no room there (it would
// sit on the tank), so the card goes low in the middle: above the carried /
// banked row, between the two thumbs, clear of the chips on the left and the
// kit buttons on the right. Only its buttons take touches there.
function lowTouch() {
    return global.mobile && window.innerHeight < 560 && window.innerWidth > window.innerHeight;
}
function place(t) {
    const root = ui.root;
    if (!root) return;
    const k = window.innerWidth / Math.max(1, SW());
    const low = lowTouch();
    // touch: one readable size; desktop follows the UI Scale, never below 0.8
    const scale = (global.mobile ? clamp(window.innerWidth / 844, 0.8, 1.15) * 0.82 : clamp(k, 0.8, 2.2)).toFixed(3);
    if (scale !== st.scale) { st.scale = scale; root.style.setProperty("--dwc-s", scale); st.sizeKey = ""; }
    root.classList.toggle("touch", !!global.mobile);
    root.classList.toggle("low", low);
    if (global.hudTopPx !== st.wroteTop) st.baseTop = global.hudTopPx | 0;
    // measuring forces a layout, so only when the content changed
    if (st.sizeKey !== ui.key || t - st.sizeAt > 1000) {
        st.sizeKey = ui.key;
        st.sizeAt = t;
        st.size = { w: root.offsetWidth, h: root.offsetHeight };
    }
    const { w, h } = st.size;
    if (low) {
        const top = Math.round(window.innerHeight - h - 60);
        if (top !== st.top) { st.top = top; root.style.top = top + "px"; }
        restoreTop();
        global.coachRect = { x: SW() / 2 - w / 2 / k - 6, y: top / k - 6, w: w / k + 12, h: h / k + 12 };
        return;
    }
    const top = Math.max(48, st.baseTop + 6);
    if (top !== st.top) { st.top = top; root.style.top = top + "px"; }
    st.wroteTop = st.baseTop + h + 12;
    global.hudTopPx = st.wroteTop;
    global.coachRect = { x: SW() / 2 - w / 2 / k - 6, y: top / k - 6, w: w / k + 12, h: h / k + 12 };
}
function restoreTop() {
    if (global.hudTopPx === st.wroteTop) global.hudTopPx = st.baseTop;
    st.wroteTop = -1;
}

// One keycap per step, a check badge once done.
function pips() {
    let s = "";
    STEPS.forEach((id, i) => {
        s += rec.done[id] ? '<i class="pip done">' + CHECK + "</i>" : '<i class="pip' + (id === st.step ? " cur" : "") + '">' + (i + 1) + "</i>";
    });
    return s;
}
function kitKeys() {
    return kbd("KEY_KIT_1", "Z") + " " + kbd("KEY_KIT_2", ",") + " " + kbd("KEY_KIT_3", "N");
}
function content(t) {
    const base = { eyebrow: "First raid", pips: pips() };
    if (st.flash) return { ...base, title: "Nice.", text: "On to the next one.", done: true };
    const g = global.gems || {};
    const touch = !!global.mobile;
    switch (st.step) {
        case "tutorial":
            return { ...base, title: "New here?", text: "The tutorial shows you the basics in about 10 minutes.",
                next: "Play the tutorial", alt: "Maybe later" };
        case "move":
            return { ...base, title: "Drive and shoot",
                text: touch ? "Left thumb drives. Right thumb aims and fires." : "Drive with " + kbd("KEY_UP", "W") + kbd("KEY_LEFT", "A") + kbd("KEY_DOWN", "S") + kbd("KEY_RIGHT", "D") + ", aim with the mouse and click to shoot.",
                bar: { frac: (Math.min(1, st.moved / MOVE_GOAL) + (st.fired ? 1 : 0)) / 2,
                    label: (st.moved >= MOVE_GOAL ? "Drove" : "Drive") + "  \u00b7  " + (st.fired ? "Fired" : "Fire") } };
        case "mine": {
            const goal = mineGoal(), c = (g.carried | 0);
            let text = st.rocks.length ? "Shoot the circled rocks, then drive over the gems."
                : st.oreFar ? "Look for colored rocks. Follow the <b>ORE</b> arrow."
                : "Look for colored rocks. They're full of gems.";
            if (st.dropped) text = "You dropped your gems. Mine some more, then bank them." +
                (!st.rocks.length && st.oreFar ? " Follow the <b>ORE</b> arrow." : "");
            return { ...base, title: "Shoot rocks. Grab the gems.", text,
                bar: { frac: c / goal, label: "Gems  " + fmtNum(Math.min(c, goal)) + " / " + fmtNum(goal) } };
        }
        case "bank": {
            const v = global.vault || {};
            const tg = st.target;
            let text = "Follow the <b>VAULT</b> arrow. Die carrying and you drop it all.";
            if (v.onPad && v.total > 0) text = "Depositing. Stay on the pad.";
            else if (v.onPad && (g.carried | 0) >= VAULT_MIN) text = (touch ? "Tap" : "Hit") + " <b>Deposit</b> to bank what you carry.";
            else if ((g.carried | 0) < VAULT_MIN) text = "Mine a few more gems first. You need " + VAULT_MIN + " to bank.";
            else if (!tg) text = "Vaults are the gold rings on your minimap. " + mapOpens();
            else if (tg.on) text = "Drive onto the vault. Banked gems are safe when you die.";
            return { ...base, title: "Bank it before you lose it", text };
        }
        case "upgrade": {
            const tiles = (gui.upgrades || []).length > 0, stat = canStat();
            let text;
            if (touch) text = tiles && stat ? "Tap <b>New tank!</b> or <b>Stats</b> on the left." : tiles ? "Tap <b>New tank!</b> on the left and pick one." : "Tap <b>Stats</b> on the left, then a <b>+</b>.";
            else text = tiles && stat ? "Pick a tank from the tiles, top left, or click a stat bar." : tiles ? "Pick a new tank from the tiles, top left." : "Click a stat bar, or press its number key.";
            return { ...base, title: "Upgrade your tank", text };
        }
        case "ability": {
            const sh = global.shop || {};
            const tg = st.target;
            if (ownsAbility()) {
                const it = (sh.catalog || []).find(i => i.id === global.abil.eq);
                const name = it ? "<b>" + it.name + "</b>" : "ability";
                const aimed = !!(it && it.place);
                return { ...base, title: "Use your ability",
                    text: touch
                        ? (aimed ? "Drag off the ability button by your right thumb to aim your " + name + ", lift to place it." : "Tap the ability button by your right thumb to fire your " + name + ".")
                        : aimed ? "Press " + kbd("KEY_ABILITY", "Q") + " to aim your " + name + ", then left click to place it." : "Press " + kbd("KEY_ABILITY", "Q") + " to fire your " + name + ". It aims at your mouse." };
            }
            if (ownsKit()) {
                return { ...base, title: "Use an ability",
                    text: touch ? "Tap a kit button on the right. Some then ask where to land." : "Press " + kitKeys() + " to use your kit items." };
            }
            const price = cheapestPrice();
            const banked = g.banked | 0;
            let text = "Follow the <b>SHOP</b> arrow on the edge of your screen.";
            if (sh.onPad) text = "Pick an item, then " + (touch ? "tap" : "hit") + " <b>Buy</b>. You pay with banked gems.";
            else if (price && banked < price) text = "Abilities start at " + fmtNum(price) + " banked gems. Bank a bit more first.";
            else if (!tg) text = "Find a shop on the minimap. " + mapOpens();
            else if (tg.on) text = "Drive onto the shop pad.";
            return { ...base, title: "Get an ability at a shop", text };
        }
        case "final":
            return { ...base, title: "You're set",
                // contracts only show from the third raid (newcomer.js)
                text: global.nxKnown && (global.nxStage | 0) < 2 ? "You've got the basics. Keep digging and banking." : "Contracts show up top left now. Each one pays gems.",
                next: "Let's go", done: true };
    }
    return null;
}

// ── per frame ──────────────────────────────────────────────────────────
function clearMarks() {
    st.rocks = []; st.rocksAt = 0; st.oreFar = null; st.target = null;
}
// Tell the server whether the guide owns the screen (undecided counts as on,
// so no contract flashes up while we wait for the account). Once per socket
// and change.
function syncServer() {
    if (!inRaid()) return;
    const sock = global.canvas && global.canvas.socket;
    if (!sock || !sock.talk) return;
    const on = rec.status === "on" || rec.status === "";
    if (sock === st.coSock && on === st.coOn) return;
    try { sock.talk("CO", on ? 1 : 0); st.coSock = sock; st.coOn = on; } catch (e) { }
}
// Something else holds the screen: the card waits (and its timers with it).
function stepAside() {
    const sh = global.shop || {};
    if (global.showBigMap || global.hudCardUp) return true;
    // a director moment's banner (newcomer.js) has the middle
    if (global.nxBannerUp) return true;
    // the kill / growth callouts (a couple of seconds, just above the tank)
    // meet the card only where it sits under the clock
    if (global.hudCalloutUp && !lowTouch()) return true;
    // the storm banner (stormFx.js) takes the top middle
    if (now() - (global.stormBannerAt || -1e9) < 250) return true;
    // the shop panel fills the middle; only the ability step talks over it
    if (sh.onPad && !sh.dismissed && st.step !== "ability") return true;
    // the tank picker and the stat panel cover the middle of a phone
    if (global.mobile && (global.touchTilesOpen || global.touchPanelRight > 0) && lowTouch()) return true;
    return false;
}
// a first raid is in progress (raidHeat.js keeps the HUD calm until the first bank)
export function active() { return rec.status === "on"; }
// the step on now ("move", "mine", "bank", "upgrade", "ability", "final" or
// ""), for newcomer.js's goal line
export function stepId() { return rec.status === "on" || st.step === "final" ? (st.step || "") : ""; }
// still teaching, or hasn't decided yet whether it will (the ability tour waits)
export function holding() { return !rec.status || rec.status === "on"; }

export function hook() {
    const t = now();
    syncServer();
    if (rec.status !== "on" && !(st.step === "final" && t - st.finalAt < FINAL_MS)) {
        if (!rec.status && playing()) decide(t);
        if (rec.status !== "on") { ui.show(false); return; }
    }
    if (!playing()) {
        if (st.alive && global.died) st.death = { step: st.step, carried: st.carried };
        st.alive = false;
        st.prev = null;
        st.lastPos = null;
        clearMarks();
        ui.show(false);
        return;
    }
    if (!st.alive) { st.alive = true; st.aliveAt = t; st.tutAt = t; clearMarks(); }
    observe(t);
    // a fresh spawn is still receiving its tank, and the spawn messages go first
    if (t - st.aliveAt < SETTLE_MS) { st.tutAt = t; ui.show(false); return; }
    if (!st.begun) {
        if (lateInRaid()) { st.tutAt = t; ui.show(false); return; }
        st.begun = true;
    }
    st.carried = (global.gems && global.gems.carried) | 0;
    if (st.death) afterDeath(st.death);
    if (st.flash && t > st.flash.until) st.flash = null;
    if (st.step === "final") {
        if (t - st.finalAt > FINAL_MS) { closeFinal(); return; }
    } else if (!st.flash) {
        const next = pickStep();
        if (next !== st.step) {
            st.step = next;
            st.tutAt = t;
            clearMarks();
            if (next !== "mine") st.dropped = false;
            if (next === "move") { st.moved = 0; st.fired = false; }
            if (next === "final") {
                st.finalAt = t;
                rec.status = "done";
                save();
                sfxDone();
            }
        }
    }
    if (stepAside()) {
        st.tutAt = t;
        if (st.step === "final") st.finalAt = t;
        if (st.flash) st.flash.until = t + FLASH_MS;
        ui.show(false);
        return;
    }
    if (st.step === "tutorial" && !st.flash && !st.confirm && t - st.tutAt > TUT_PROMPT_MS) tutorialLater();
    const o = st.step ? content(t) : null;
    if (!o) { ui.show(false); return; }
    ui.show(true);
    ui.render(o);
    place(t);
    // app.js: the touch chips' first-time pointers stay quiet while this card
    // points elsewhere, and on the upgrade step they are its pointer
    global.coachPointing = st.flash ? "flash" : (st.step || "");
}
// Once a respawn settles: gems lost on the bank step send you back to mining.
function afterDeath(d) {
    st.death = null;
    const lost = d.carried > 0 && st.carried < d.carried;
    if (d.step === "bank" && !rec.done.bank && st.carried < VAULT_MIN) {
        if (rec.done.mine) { delete rec.done.mine; save(); }
        st.dropped = lost;
    } else if (d.step === "mine" && lost) st.dropped = true;
}

// ── world layer: rocks to shoot, the pad to head for ───────────────────
function w2s(wx, wy, px, py, ratio) { return { x: -px + SW() / 2 + ratio * wx, y: -py + SH() / 2 + ratio * wy }; }
function inkStroke(c, width, col) {
    c.lineJoin = "round"; c.lineCap = "round";
    c.lineWidth = width + 3; c.strokeStyle = INK; c.stroke();
    c.lineWidth = width; c.strokeStyle = col; c.stroke();
}
// Up to three of the nearest ore rocks on screen (never plain rock). Sticky,
// so the marks don't hop around while the player drives. With none on screen,
// oreFar is the nearest one anywhere, for the edge arrow.
function pickRocks(ratio) {
    const tr = terr();
    st.oreFar = null;
    if (!tr) return [];
    const w = tr._world, p = me();
    const hw = SW() / 2 / ratio, hh = SH() / 2 / ratio;
    const alive = k => tr._ore.has(k) && tr._cellPolys.has(k) && !tr._rockDead.has(k);
    const posOf = k => { const c = tr._cellPolys.get(k); return { x: c.cx * w.s - w.hw, y: c.cy * w.s - w.hh }; };
    // on screen, and not hidden behind the card itself
    const cr = global.coachRect;
    const underCard = q => {
        if (!cr) return false;
        const sx = SW() / 2 + (q.x - p.x) * ratio, sy = SH() / 2 + (q.y - p.y) * ratio;
        return sx > cr.x - 20 && sx < cr.x + cr.w + 20 && sy > cr.y - 20 && sy < cr.y + cr.h + 20;
    };
    const inView = q => Math.abs(q.x - p.x) < hw * 0.92 && Math.abs(q.y - p.y) < hh * 0.92 && !underCard(q);
    const keep = st.rocks.filter(k => {
        if (!alive(k)) return false;
        const q = posOf(k);
        return inView(q) && stormOut(q.x, q.y) === 0;
    });
    if (keep.length >= 3) return keep;
    const cand = [];
    let far = null;
    for (const [k, tier] of tr._ore) {
        if (keep.includes(k) || !alive(k)) continue;
        const cell = tr._cellPolys.get(k);
        if (!cell || !cell.poly) continue;
        const q = posOf(k);
        if (stormOut(q.x, q.y) > 0) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (inView(q)) cand.push({ k, d });
        else if (!far || d < far.d) far = { x: q.x, y: q.y, d, tier };
    }
    cand.sort((a, b) => a.d - b.d);
    for (const c of cand) { if (keep.length >= 3) break; keep.push(c.k); }
    if (!keep.length) st.oreFar = far;
    return keep;
}
function drawRocks(c, px, py, ratio, t) {
    const tr = terr();
    if (!tr) return;
    if (t - st.rocksAt > 450) { st.rocks = pickRocks(ratio); st.rocksAt = t; }
    const w = tr._world;
    const pulse = 0.5 + 0.5 * Math.sin(t / 320);
    c.save();
    for (const k of st.rocks) {
        const cell = tr._cellPolys.get(k);
        if (!cell || !cell.poly || cell.poly.length < 3 || tr._rockDead.has(k)) continue;
        const rgb = ORE_RGB[tr._ore.get(k)];
        if (!rgb) continue;
        c.beginPath();
        for (let i = 0; i < cell.poly.length; i++) {
            const q = w2s(cell.poly[i][0] * w.s - w.hw, cell.poly[i][1] * w.s - w.hh, px, py, ratio);
            if (i === 0) c.moveTo(q.x, q.y); else c.lineTo(q.x, q.y);
        }
        c.closePath();
        c.fillStyle = `rgba(${rgb},${0.05 + 0.07 * pulse})`;
        c.fill();
        c.setLineDash([10, 7]);
        c.lineDashOffset = -t / 35;
        inkStroke(c, 2.5, `rgba(${rgb},${0.75 + 0.25 * pulse})`);
        c.setLineDash([]);
    }
    c.restore();
}
function drawPadRing(c, sp, R, col, t) {
    c.save();
    c.beginPath();
    c.arc(sp.x, sp.y, R + 3 * Math.sin(t / 320), 0, Math.PI * 2);
    c.setLineDash([16, 12]);
    c.lineDashOffset = -t / 26;
    inkStroke(c, 4, col);
    c.setLineDash([]);
    // a bobbing arrow above it
    const bob = Math.sin(t / 240) * 6;
    c.translate(sp.x, sp.y - R - 22 + bob);
    c.beginPath();
    c.moveTo(0, 13); c.lineTo(13, -3); c.lineTo(5, -3); c.lineTo(5, -15);
    c.lineTo(-5, -15); c.lineTo(-5, -3); c.lineTo(-13, -3);
    c.closePath();
    c.lineJoin = "round";
    c.lineWidth = 6; c.strokeStyle = INK; c.stroke();
    c.fillStyle = col; c.fill();
    c.restore();
}
// Chevrons marching from your tank toward the pad.
function drawTrail(c, sp, col, t) {
    const ox = SW() / 2, oy = SH() / 2;
    const dx = sp.x - ox, dy = sp.y - oy, dist = Math.hypot(dx, dy);
    if (dist < 190) return;
    const ang = Math.atan2(dy, dx);
    const n = 3, span = Math.min(dist - 150, 300);
    c.save();
    for (let i = 0; i < n; i++) {
        const k = ((t / 1300) + i / n) % 1;
        c.save();
        c.globalAlpha = Math.sin(k * Math.PI) * 0.9;
        c.translate(ox + Math.cos(ang) * (80 + k * span), oy + Math.sin(ang) * (80 + k * span));
        c.rotate(ang);
        c.beginPath(); c.moveTo(-11, -15); c.lineTo(9, 0); c.lineTo(-11, 15);
        inkStroke(c, 5.5, col);
        c.restore();
    }
    c.restore();
}
export function drawWorld(px, py, ratio) {
    st.target = null;
    if (!st.visible || st.flash || !playing()) return;
    const c = window.dwCtx && window.dwCtx[1];
    if (!c) return;
    const t = now();
    st.ratio = ratio;
    // nothing to bank yet: point at ore instead of the vault
    const broke = st.step === "bank" && ((global.gems && global.gems.carried) | 0) < VAULT_MIN;
    if (st.step === "mine" || broke) { drawRocks(c, px, py, ratio, t); return; }
    if (st.rocks.length || st.oreFar) { st.rocks = []; st.oreFar = null; }
    const shopStep = st.step === "ability" && !ownsKit();
    if (st.step !== "bank" && !shopStep) return;
    const site = st.step === "bank" ? nearest(global.vaults) : nearest(global.shops);
    if (!site) return;
    const onPad = st.step === "bank" ? global.vault && global.vault.onPad : global.shop && global.shop.onPad;
    const sp = w2s(site.x, site.y, px, py, ratio);
    const R = Math.max(40, site.r * ratio * (st.step === "bank" ? 1.45 : 1.35));
    const on = sp.x > -R * 0.5 && sp.x < SW() + R * 0.5 && sp.y > -R * 0.5 && sp.y < SH() + R * 0.5;
    st.target = { x: site.x, y: site.y, d: site.d, dx: sp.x - SW() / 2, dy: sp.y - SH() / 2, on };
    const col = st.step === "bank" ? GOLD : SHOP_COL;
    if (onPad) return;
    drawTrail(c, sp, col, t);
    if (on) drawPadRing(c, sp, R, col, t);
}

// ── HUD layer: highlights, edge arrow ──────────────────
function clickRect(region, n) {
    const cl = global.clickables && global.clickables[region];
    if (!cl) return null;
    const cr = (global.canvas && global.canvas.height && SH() && global.ratio) ? global.canvas.height / SH() / global.ratio : 1;
    if (!cr || !isFinite(cr)) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < Math.min(n, cl.size()); i++) {
        const r = cl.rect(i);
        if (!r || !(r.w > 0) || !(r.h > 0)) continue;
        x0 = Math.min(x0, r.x / cr); y0 = Math.min(y0, r.y / cr);
        x1 = Math.max(x1, (r.x + r.w) / cr); y1 = Math.max(y1, (r.y + r.h) / cr);
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
function rrect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
}
function outline(c, b, t) {
    rrect(c, b.x, b.y, b.w, b.h, 10);
    c.save();
    c.setLineDash([12, 8]);
    c.lineDashOffset = -t / 30;
    inkStroke(c, 3, GOLD);
    c.restore();
}
// A label plate beside the box with a notch pointing at it.
function tag(c, b, text, side, t) {
    const H = window.dwHud;
    if (!H) return;
    const size = 17, ph = 30;
    const pw = H.titleW(text, size) + 28;
    const face = (H.colors && H.colors.panel) || "#2b2533";
    const bob = Math.sin(t / 240) * 3;
    let x, y, dir;
    if (side === "left") { x = b.x - pw - 16 - bob; y = b.y + Math.min(b.h, 60) / 2 - ph / 2; dir = "right"; }
    else if (side === "up") { x = b.x + b.w / 2 - pw / 2; y = b.y - ph - 16 - bob; dir = "down"; }
    else { x = b.x + b.w + 16 + bob; y = b.y + Math.min(b.h, 60) / 2 - ph / 2; dir = "left"; }
    x = clamp(x, 8, SW() - pw - 8);
    y = clamp(y, 8, SH() - ph - 8);
    // the notch, pointing at the box
    c.save();
    c.beginPath();
    if (dir === "left") { const ny = y + ph / 2; c.moveTo(x - 10, ny); c.lineTo(x + 3, ny - 8); c.lineTo(x + 3, ny + 8); }
    else if (dir === "right") { const nx = x + pw, ny = y + ph / 2; c.moveTo(nx + 10, ny); c.lineTo(nx - 3, ny - 8); c.lineTo(nx - 3, ny + 8); }
    else { const nx = x + pw / 2, ny = y + ph; c.moveTo(nx, ny + 10); c.lineTo(nx - 8, ny - 3); c.lineTo(nx + 8, ny - 3); }
    c.closePath();
    c.fillStyle = GOLD; c.fill();
    c.lineWidth = 2; c.strokeStyle = INK; c.stroke();
    c.restore();
    H.panel(c, x, y, pw, ph, { r: ph / 2, fill: face, lip: 2.5, bevel: false });
    H.title(text, x + pw / 2, y + ph / 2, size, GOLD, "center", 1, c);
}
function pad(b, m) { return b ? { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m } : null; }

export function drawIndicators() {
    if (!st.visible || st.flash || !playing() || global.showBigMap) return;
    const c = window.dwCtx && window.dwCtx[2];
    if (!c) return;
    const t = now();
    const touch = !!global.mobile;
    if (st.step === "upgrade") {
        if (touch) {
            // nothing here: the chips' own pointer (app.js) points for this step
        } else {
            const tiles = pad(clickRect("upgrade", (gui.upgrades || []).length) || hudRect("upgrades"), 8);
            if (tiles) { outline(c, tiles, t); tag(c, tiles, "Pick a tank", "right", t); }
            else { const b = pad(clickRect("stat", 11) || hudRect("stats"), 6); if (b) { outline(c, b, t); tag(c, b, "Click a bar", "right", t); } }
        }
    } else if (st.step === "ability" && ownsKit()) {
        const b = pad(hudRect("kit"), 6);
        if (b) { outline(c, b, t); tag(c, b, touch ? "Tap one" : "Your kit", touch ? "left" : "right", t); }
    } else if (st.step === "bank" && !st.target && (((global.gems && global.gems.carried) | 0) >= VAULT_MIN)) {
        // no vault known on screen: the minimap has them
        const b = pad(hudRect("minimap"), 4);
        if (b) { outline(c, b, t); tag(c, b, touch ? "Tap for the map" : "Vaults are here", "left", t); }
    } else if (st.oreFar && !st.rocks.length && (st.step === "mine" || st.step === "bank") && window.dwHud) {
        const p = me(), f = st.oreFar;
        const e = window.dwHud.edgePoint((f.x - p.x) * st.ratio, (f.y - p.y) * st.ratio);
        window.dwHud.edgeMarker(c, e, "rgb(" + (ORE_RGB[f.tier] || ORE_RGB[1]) + ")", "gem", "ORE", fmtDist(f.d), []);
    }
    if ((st.step === "bank" || (st.step === "ability" && !ownsKit())) && st.target && !st.target.on && window.dwHud) {
        const e = window.dwHud.edgePoint(st.target.dx, st.target.dy);
        const bank = st.step === "bank";
        window.dwHud.edgeMarker(c, e, bank ? GOLD : SHOP_COL, bank ? "gem" : "shop", bank ? "VAULT" : "SHOP", fmtDist(st.target.d), []);
    }
}

// QA and support hooks: read state, jump to a step, start over.
window.dwCoach = {
    state: () => ({
        rec: JSON.parse(JSON.stringify(rec)), step: st.step, visible: st.visible,
        rocks: st.rocks.slice(), oreFar: st.oreFar, dropped: st.dropped, moved: Math.round(st.moved), fired: st.fired,
    }),
    reset() { rec = blank(); save(); st.step = null; st.flash = null; st.prev = null; st.dropped = false; clearMarks(); },
    jump(id) {
        const i = ORDER.indexOf(id);
        if (i < 0) return false;
        rec.status = "on";
        rec.done = {};
        for (let j = 0; j < i; j++) rec.done[ORDER[j]] = 1;
        save();
        st.step = null; st.flash = null; st.dropped = false;
        clearMarks();
        return true;
    },
};
