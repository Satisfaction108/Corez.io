import { global } from "./global.js";
import { gui } from "./socketinit.js";
import { gameSound } from "./sound.js";

// First-raid coach: a light do-it guide for new players in real raids.
//
//   tutorial offer the tutorial              (skipped once it's been played)
//   points   spend a skill point            (stat bars, bottom left)
//   upgrade  evolve                         (upgrade tiles, top left; waits while none are offered)
//   tour     a quick look at the main HUD   (spotlight, auto-advances)
//   mine     carry 500 gems                 (nearby ore rocks outlined)
//   bank     finish a deposit               (arrow to the nearest vault)
//   shop     buy something                  (arrow to the nearest shop pad)
//
// Progress lives in localStorage, so a death, reload, resume or new raid
// carries on from the current step. Anything done early (a deposit during the
// mining step) counts. Dying on the bank step with the gems gone sends you back
// to mining. The tutorial server never runs this.
//
// app.js calls hook() every frame after the GUI, drawWorld() from the camera
// pass and drawIndicators() at the very end of the frame. window.dwHud (app.js)
// gives the HUD rects and the edge marker.

const KEY = "dwCoach_v1";
const ORDER = ["tutorial", "points", "upgrade", "tour", "mine", "bank", "shop"];
// the numbered steps; the tutorial offer is an intro card
const STEPS = ORDER.filter(id => id !== "tutorial");
const TUT_DONE_KEY = "digRoyaleTutorialDone_v1";   // tutorial.js / home.js
const TUT_AFTER_KEY = "dwCoachTutorial";            // sessionStorage: open the tutorial once the menu loads
const TUT_PROMPT_MS = 25000;  // an ignored offer turns into "Maybe later"
const MINE_GOAL = 500;
const TOUR_MS = 4500;
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

const TOUR = [
    { hud: "clock", name: "Raid clock", text: "Time left in the raid, and when the storm moves next.", side: "right" },
    { hud: "standings", name: "Standings", text: "The top players this raid. Bank gems and win fights to climb.", side: "left" },
    { hud: "feed", name: "Kill feed", text: "Kills, bosses and ore blooms show up here.", side: "down" },
    { hud: "minimap", name: "Minimap", text: "Vaults, shops and the storm.", key: ["KEY_TOGGLE_MAP", "M", "for the big map"], side: "left" },
    { hud: "wallet", name: "Carried / Banked", text: "Carried gems drop when you die. Banked gems are safe.", side: "right" },
    { hud: "kit", name: "Kit", text: "Items you buy at shops land here.", side: "right" },
    { hud: "quest", name: "Quest", text: "Finish it for bonus gems.", side: "right" },
];

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
function blank() { return { v: 1, status: "", done: {}, tour: 0, at: Date.now() }; }
function load() {
    try {
        const r = JSON.parse(localStorage.getItem(KEY) || "null");
        if (r && r.v === 1 && typeof r.done === "object" && r.done) return r;
    } catch (e) { }
    return blank();
}
let rec = load();
function save() { try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) { } }

// ── runtime state ──────────────────────────────────────────────────────
const st = {
    step: null,          // current step id, "final", or null
    flash: null,         // { until } after a step completes
    finalAt: 0,
    tourAt: 0,
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
};

// ── game reads ─────────────────────────────────────────────────────────
function inRaid() {
    return !!(global.gameStart && !global.tutorialMode && global.digRoyaleMode &&
        global.royale && global.royale.at > 0 && !global.disconnected);
}
function playing() {
    const r = global.royale;
    return inRaid() && !global.died && !global.royaleSpectating && !(r && r.ending);
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
    for (const it of (global.shop && global.shop.catalog) || []) if (it && it.price > 0) min = Math.min(min, it.price);
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
    if (pl) veteran = !!pl.done || (pl.lives | 0) >= 3;
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
        doneAt: v.doneAt, msgAt: sh.msgAt, banked: g.banked | 0,
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
    if (cur.sum > p.sum) markDone("points");
    if (cur.type !== p.type && p.ups > 0) markDone("upgrade");
    // "Don't upgrade" empties the menu without a new type: they know where it is
    else if (cur.type === p.type && p.ups > 0 && cur.ups === 0) markDone("upgrade");
    if (cur.doneAt !== p.doneAt && cur.doneAt > 0) markDone("bank");
    // a purchase is the only thing that spends banked gems on a shop pad
    if (cur.msgAt !== p.msgAt && sh.msgOk && sh.onPad && t - st.bankDropAt < 2500) markDone("shop");
    if (((global.gems && global.gems.carried) | 0) >= mineGoal()) markDone("mine");
}

// A step that can't be done right now is skipped over and comes back later.
function waiting(id) {
    if (id === "tutorial" && tutorialPlayed()) { markDone("tutorial"); return false; }
    if (id === "points" && !(gui.points > 0)) {
        if (skillSum() > 0) { markDone("points"); return false; }
        return true;
    }
    if (id === "upgrade" && !(gui.upgrades || []).length) {
        const n = tankName();
        if (n && n !== "Basic") { markDone("upgrade"); return false; }
        return true;
    }
    return false;
}
function pickStep() {
    // a tour in progress is short; finish it first
    if (st.step === "tour" && !rec.done.tour) return "tour";
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

// ── tour ───────────────────────────────────────────────────────────────
function tourItem() {
    while (rec.tour < TOUR.length) {
        const it = TOUR[rec.tour];
        if (hudRect(it.hud)) return it;
        rec.tour++;
    }
    return null;
}
function tourNext() {
    rec.tour++;
    st.tourAt = now();
    if (rec.tour >= TOUR.length || !tourItem()) { rec.tour = TOUR.length; markDone("tour"); }
    save();
    sfxTick();
}
function tourSkip() {
    rec.tour = TOUR.length;
    markDone("tour");
}
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
            '<button class="dwc-btn dwc-alt" type="button"></button>' +
            '<button class="dwc-link dwc-skiptour" type="button">Skip tour</button></div>' +
            '<div class="dwc-confirm"><span>Skip the guide?</span>' +
            '<button class="dwc-btn dwc-danger dwc-yes" type="button">Skip it</button>' +
            '<button class="dwc-link dwc-no" type="button">Keep going</button></div>';
        document.body.appendChild(root);
        this.root = root;
        const q = s => root.querySelector(s);
        this.el = {
            eyebrow: q(".dwc-eyebrow"), pips: q(".dwc-pips"), title: q(".dwc-title"), text: q(".dwc-text"),
            bar: q(".dwc-bar"), fill: q(".dwc-bar i"), barTxt: q(".dwc-bar span"),
            row: q(".dwc-row"), next: q(".dwc-next"), alt: q(".dwc-alt"), skipTour: q(".dwc-skiptour"),
            confirm: q(".dwc-confirm"), quit: q(".dwc-quit"),
        };
        // clicks stay on the panel, keys go back to the game
        for (const ev of ["mousedown", "mouseup", "click", "contextmenu", "touchstart", "wheel", "pointerdown"]) {
            root.addEventListener(ev, e => e.stopPropagation(), ev === "touchstart" || ev === "wheel" ? { passive: true } : undefined);
        }
        const on = (b, fn) => b.addEventListener("click", e => { e.preventDefault(); fn(); focusGame(); });
        on(this.el.next, () => {
            if (st.step === "tutorial") tutorialPlay();
            else if (st.step === "tour") tourNext();
            else if (st.step === "final") closeFinal();
        });
        on(this.el.alt, () => { if (st.step === "tutorial") tutorialLater(); });
        on(this.el.skipTour, tourSkip);
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
        if (!on) { global.coachRect = null; restoreTop(); spot.show(null); }
    },
    // content: { eyebrow, pips, title, text, bar:{frac,label,timer}|null, next, alt, skipTour, done }
    render(o) {
        const k = [o.eyebrow, o.pips, o.title, o.text, !!o.bar, o.next || "", o.alt || "", !!o.skipTour, !!o.done, st.confirm].join("|");
        const e = this.el;
        if (k !== this.key) {
            this.key = k;
            e.eyebrow.textContent = o.eyebrow || "";
            e.pips.innerHTML = o.pips || "";
            e.title.innerHTML = (o.done ? '<i class="dwc-check">' + CHECK + "</i>" : "") + esc(o.title || "");
            e.text.innerHTML = o.text || "";
            e.bar.style.display = o.bar ? "" : "none";
            e.row.style.display = (o.next || o.alt || o.skipTour) && !st.confirm ? "" : "none";
            e.next.style.display = o.next ? "" : "none";
            e.next.textContent = o.next || "";
            e.alt.style.display = o.alt ? "" : "none";
            e.alt.textContent = o.alt || "";
            e.skipTour.style.display = o.skipTour ? "" : "none";
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
            e.bar.classList.toggle("timer", !!o.bar.timer);
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

// Sits under the raid clock cluster (app.js publishes where it ends, in CSS
// px) and pushes the DOM toast stack down by its own height.
function place(t) {
    const root = ui.root;
    if (!root) return;
    const k = window.innerWidth / Math.max(1, SW());
    // never below 0.8: this is text to read mid-fight, not a HUD number
    const scale = clamp(k, 0.8, 2.2).toFixed(3);
    if (scale !== st.scale) { st.scale = scale; root.style.setProperty("--dwc-s", scale); st.sizeKey = ""; }
    if (global.hudTopPx !== st.wroteTop) st.baseTop = global.hudTopPx | 0;
    const top = Math.max(48, st.baseTop + 6);
    if (top !== st.top) { st.top = top; root.style.top = top + "px"; }
    // measuring forces a layout, so only when the content changed
    if (st.sizeKey !== ui.key || t - st.sizeAt > 1000) {
        st.sizeKey = ui.key;
        st.sizeAt = t;
        st.size = { w: root.offsetWidth, h: root.offsetHeight };
    }
    const { w, h } = st.size;
    st.wroteTop = st.baseTop + h + 12;
    global.hudTopPx = st.wroteTop;
    global.coachRect = { x: SW() / 2 - w / 2 / k - 6, y: top / k - 6, w: w / k + 12, h: h / k + 12 };
}
function restoreTop() {
    if (global.hudTopPx === st.wroteTop) global.hudTopPx = st.baseTop;
    st.wroteTop = -1;
}

// One keycap per step (a check badge once done); during the tour, one per stop.
function pips() {
    let s = "";
    if (st.step === "tour") {
        for (let i = 0; i < TOUR.length; i++) {
            s += i < rec.tour ? '<i class="pip sm done">' + CHECK + "</i>" : '<i class="pip sm' + (i === rec.tour ? " cur" : "") + '"></i>';
        }
        return s;
    }
    STEPS.forEach((id, i) => {
        s += rec.done[id] ? '<i class="pip done">' + CHECK + "</i>" : '<i class="pip' + (id === st.step ? " cur" : "") + '">' + (i + 1) + "</i>";
    });
    return s;
}
function content(t) {
    const base = { eyebrow: "First raid", pips: pips() };
    if (st.flash) return { ...base, title: "Nice.", text: "On to the next one.", done: true };
    const g = global.gems || {};
    switch (st.step) {
        case "tutorial":
            return { ...base, title: "New here?", text: "The tutorial shows you the basics in about 10 minutes.",
                next: "Play the tutorial", alt: "Maybe later" };
        case "points":
            return { ...base, title: "Spend a skill point",
                text: global.mobile ? "Tap a stat to put a point in it." : "Click a stat bar, or press its number key." };
        case "upgrade":
            return { ...base, title: "Upgrade your tank", text: "Pick a new tank from the tiles, top left." };
        case "tour": {
            const it = tourItem();
            if (!it) return null;
            const frac = clamp((t - st.tourAt) / TOUR_MS, 0, 1);
            let text = esc(it.text);
            if (it.key) text += " " + kbd(it.key[0], it.key[1]) + " " + esc(it.key[2]) + ".";
            return { ...base, eyebrow: "HUD tour", title: it.name, text,
                bar: { frac, label: "", timer: true }, next: "Next", skipTour: true };
        }
        case "mine": {
            const goal = mineGoal(), c = (g.carried | 0);
            let text = st.rocks.length ? "Shoot the circled rocks, then drive over the gems."
                : st.oreFar ? "Look for colored rocks. Follow the <b>ORE</b> arrow."
                : "Look for colored rocks. They're full of gems.";
            if (st.dropped) text = "You dropped your gems. Mine some more, then bank them." +
                (!st.rocks.length && st.oreFar ? " Follow the <b>ORE</b> arrow." : "");
            return { ...base, title: "Shoot rocks to mine gems", text,
                bar: { frac: c / goal, label: "Gems  " + fmtNum(Math.min(c, goal)) + " / " + fmtNum(goal) } };
        }
        case "bank": {
            const v = global.vault || {};
            const tg = st.target;
            let text = "Follow the <b>VAULT</b> arrow on the edge of your screen.";
            if (v.onPad && v.total > 0) text = "Depositing. Stay on the pad.";
            else if (v.onPad && (g.carried | 0) >= VAULT_MIN) text = "Hit <b>Deposit</b> to bank what you carry.";
            else if ((g.carried | 0) < VAULT_MIN) text = "Mine a few more gems first. You need " + VAULT_MIN + " to bank.";
            else if (!tg) text = "Find a vault on the map. " + kbd("KEY_TOGGLE_MAP", "M") + " opens it.";
            else if (tg.on) text = "Drive onto the vault. Banked gems are safe, carried ones drop when you die.";
            return { ...base, title: "Bank your gems at a vault", text };
        }
        case "shop": {
            const sh = global.shop || {};
            const tg = st.target;
            const price = cheapestPrice();
            const banked = g.banked | 0;
            let text = "Follow the <b>SHOP</b> arrow on the edge of your screen.";
            if (price && banked < price) text = "The cheapest item costs " + fmtNum(price) + " banked gems. Bank a bit more first.";
            else if (sh.onPad) text = "Pick an item, then hit <b>Buy</b>. You pay with banked gems.";
            else if (!tg) text = "Find a shop on the map. " + kbd("KEY_TOGGLE_MAP", "M") + " opens it.";
            else if (tg.on) text = "Drive onto the shop pad.";
            return { ...base, title: "Buy something at a shop", text };
        }
        case "final":
            return { ...base, title: "You're set",
                text: "Bank before the storm closes in, and watch out for other players.", next: "Let's go", done: true };
    }
    return null;
}

// ── tour spotlight (DOM, so the chat and menu buttons dim too) ─────────
// A box over the target whose huge shadow is the dim; the panel sits above it.
const spot = {
    el: null, tag: null, on: false, key: "", tagKey: "",
    build() {
        const el = document.createElement("div");
        el.id = "dwcSpot";
        el.innerHTML = '<span class="dwc-spot-tag"></span>';
        document.body.appendChild(el);
        this.el = el;
        this.tag = el.firstChild;
    },
    // b in GUI units, or null to hide
    show(b, name, side) {
        if (!b) {
            if (this.on) { this.on = false; this.el.classList.remove("on"); }
            return;
        }
        if (!this.el) this.build();
        const k = window.innerWidth / Math.max(1, SW());
        const x = Math.round(b.x * k), y = Math.round(b.y * k), w = Math.round(b.w * k), h = Math.round(b.h * k);
        const key = x + "," + y + "," + w + "," + h + "," + st.scale + "," + side;
        if (key !== this.key) {
            this.key = key;
            const s = this.el.style;
            s.left = x + "px"; s.top = y + "px"; s.width = w + "px"; s.height = h + "px";
            s.setProperty("--dwc-s", st.scale || "1");
            // tall panels (standings): point at the top, where their title is
            this.tag.style.top = side === "down" ? "" : Math.round(Math.min(h, 60 * k) / 2) + "px";
        }
        const tk = name + "|" + side;
        if (tk !== this.tagKey) {
            this.tagKey = tk;
            this.tag.textContent = name;
            this.tag.className = "dwc-spot-tag " + (side === "left" ? "l" : side === "down" ? "d" : "r");
        }
        if (!this.on) { this.on = true; this.el.classList.add("on"); }
    },
};

// ── per frame ──────────────────────────────────────────────────────────
function clearMarks() {
    st.rocks = []; st.rocksAt = 0; st.oreFar = null; st.target = null;
}
export function hook() {
    const t = now();
    if (rec.status !== "on" && !(st.step === "final" && t - st.finalAt < FINAL_MS)) {
        if (!rec.status && playing()) decide(t);
        if (rec.status !== "on") { ui.show(false); return; }
    }
    if (!playing()) {
        if (st.alive && global.died) st.death = { step: st.step, carried: st.carried };
        st.alive = false;
        st.prev = null;
        clearMarks();
        ui.show(false);
        return;
    }
    if (!st.alive) { st.alive = true; st.aliveAt = t; st.tourAt = t; st.tutAt = t; clearMarks(); }
    observe(t);
    // a fresh spawn is still receiving its tank, and the spawn messages go first
    if (t - st.aliveAt < SETTLE_MS) { st.tourAt = t; st.tutAt = t; ui.show(false); return; }
    st.carried = (global.gems && global.gems.carried) | 0;
    if (st.death) afterDeath(st.death);
    if (st.flash && t > st.flash.until) st.flash = null;
    if (st.step === "final") {
        if (t - st.finalAt > FINAL_MS) { closeFinal(); return; }
    } else if (!st.flash) {
        const next = pickStep();
        if (next !== st.step) {
            st.step = next;
            st.tourAt = t;
            st.tutAt = t;
            clearMarks();
            if (next !== "mine") st.dropped = false;
            if (next === "final") {
                st.finalAt = t;
                rec.status = "done";
                save();
                sfxDone();
            }
        }
    }
    // the shop panel fills the middle of the screen; wait until they close it
    const sh = global.shop || {};
    if (sh.onPad && !sh.dismissed && st.step !== "shop") {
        st.tourAt = t;
        st.tutAt = t;
        if (st.step === "final") st.finalAt = t;
        ui.show(false);
        return;
    }
    if (st.step === "tour" && !st.flash && !st.confirm && t - st.tourAt > TOUR_MS) tourNext();
    if (st.step === "tutorial" && !st.flash && !st.confirm && t - st.tutAt > TUT_PROMPT_MS) tutorialLater();
    const o = st.step && !global.showBigMap ? content(t) : null;
    if (!o) { ui.show(false); return; }
    ui.show(true);
    ui.render(o);
    place(t);
    const it = st.step === "tour" && !st.flash ? tourItem() : null;
    spot.show(it ? pad(hudRect(it.hud), 7) : null, it && it.name, it && it.side);
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
    const inView = q => Math.abs(q.x - p.x) < hw * 0.92 && Math.abs(q.y - p.y) < hh * 0.92;
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
    if (st.step !== "bank" && st.step !== "shop") return;
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

// ── HUD layer: highlights, tour spotlight, edge arrow ──────────────────
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
    if (st.step === "points") {
        const b = pad(clickRect("stat", 11) || hudRect("stats"), 6);
        if (b) { outline(c, b, t); tag(c, b, global.mobile ? "Tap a stat" : "Click a bar", "right", t); }
    } else if (st.step === "upgrade") {
        const b = pad(clickRect("upgrade", (gui.upgrades || []).length) || hudRect("upgrades"), 8);
        if (b) { outline(c, b, t); tag(c, b, "Pick a tank", "right", t); }
    } else if (st.oreFar && !st.rocks.length && (st.step === "mine" || st.step === "bank") && window.dwHud) {
        const p = me(), f = st.oreFar;
        const e = window.dwHud.edgePoint((f.x - p.x) * st.ratio, (f.y - p.y) * st.ratio);
        window.dwHud.edgeMarker(c, e, "rgb(" + (ORE_RGB[f.tier] || ORE_RGB[1]) + ")", "gem", "ORE", fmtDist(f.d), []);
    } else if ((st.step === "bank" || st.step === "shop") && st.target && !st.target.on && window.dwHud) {
        const e = window.dwHud.edgePoint(st.target.dx, st.target.dy);
        const bank = st.step === "bank";
        window.dwHud.edgeMarker(c, e, bank ? GOLD : SHOP_COL, bank ? "gem" : "shop", bank ? "VAULT" : "SHOP", fmtDist(st.target.d), []);
    }
}

// QA and support hooks: read state, jump to a step, start over.
window.dwCoach = {
    state: () => ({
        rec: JSON.parse(JSON.stringify(rec)), step: st.step, visible: st.visible, tour: rec.tour,
        rocks: st.rocks.slice(), oreFar: st.oreFar, dropped: st.dropped, spot: spot.on,
    }),
    reset() { rec = blank(); save(); st.step = null; st.flash = null; st.prev = null; st.dropped = false; clearMarks(); },
    jump(id, tourStop = 0) {
        const i = ORDER.indexOf(id);
        if (i < 0) return false;
        rec.status = "on";
        rec.done = {};
        for (let j = 0; j < i; j++) rec.done[ORDER[j]] = 1;
        if (id === "tour") rec.tour = tourStop | 0;
        save();
        st.step = null; st.flash = null; st.dropped = false;
        clearMarks();
        return true;
    },
};
