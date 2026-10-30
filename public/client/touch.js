// Touch controls for phones and tablets.
//
// Left half: a floating move stick. It appears where the thumb lands, reads
// analog (full 360 degrees, speed from how far you push) and slides after the
// thumb if it runs past the rim. Right half: an aim stick that fires while it
// is held, with a light pull toward the nearest target in a small cone. A quick
// tap on the right half fires at the spot you tapped.
//
// Thumb buttons along the right edge: the three kit slots and the sidearm,
// with Dash and the ability slot next to the corner (abilityFx.js draws them).
// Kit items that land on a spot (Seismic Charge, Rock Barrage) arm on a tap
// and the next touch places them: drag to aim, lift to throw.
// Anything else on screen that takes a click (stat bars, upgrade tiles, the
// shop and vault panels, the map, the death card) gets the touch as a mouse
// click, through the same handlers the desktop uses, so every panel works
// without a touch copy of its logic.
//
// All geometry here is CSS pixels (clientX/Y), so the sticks keep the same
// physical size whatever the UI Scale says. app.js draws them (drawTouchHud).

import { global } from "./global.js";
import { util } from "./util.js";
import { gameSound } from "./sound.js";
import { gui } from "./socketinit.js";
import * as abilityFx from "./abilityFx.js";

import { STICK, stickVector, moveBits, packMove, unpackMove, assistAim, touchPrimary, inputModeWatch } from "./touchInput.js";
export { STICK, stickVector, moveBits, packMove, unpackMove, assistAim, touchPrimary, inputModeWatch };

const ABDRAG_PX = 120;       // a drag this long off the ability button = full range
const LONG_MS = 400;         // a press held this long on a thumb button shows its tooltip

// ── settings ────────────────────────────────────────────────────────────
const PREF_KEY = "dwTouch_v1";
const prefs = (() => {
    const d = { assist: true, haptics: true, armAuto: true };
    try { Object.assign(d, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); } catch (e) { }
    return d;
})();
export function touchPref(k, v) {
    if (v === undefined) return prefs[k];
    prefs[k] = v;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { }
    return v;
}

// Short buzzes for hits, kills and banking. Android only in practice (iOS
// Safari has no vibrate); rate limited so a shotgun doesn't buzz forever.
let lastBuzz = 0;
export function haptic(kind) {
    if (!prefs.haptics || !global.mobile || !navigator.vibrate) return;
    const now = performance.now();
    const pat = kind === "kill" ? [18, 40, 28] : kind === "bank" ? [12, 30, 12, 30, 20] : kind === "hurt" ? 22 : kind === "buy" ? 14 : 8;
    const gap = kind === "hit" ? 90 : 160;
    if (now - lastBuzz < gap) return;
    lastBuzz = now;
    try { navigator.vibrate(pat); } catch (e) { }
}

// the game's own hit, kill and deposit sounds are the cue
for (const [m, kind] of [["combatHit", "hit"], ["combatHurt", "hurt"], ["combatKill", "kill"], ["depositDone", "bank"]]) {
    const f = gameSound[m];
    if (typeof f === "function") gameSound[m] = function (...a) { haptic(kind); return f.apply(this, a); };
}

// Kit items thrown at a spot, and how far (world units, server/game/terrain/shop.js)
export const AIMED_KIT = {
    charge: { max: 500, blast: 150 },
    barrage: { max: 950, line: true },
};

// ── fullscreen and landscape ────────────────────────────────────────────
// Browsers only allow these from a tap, so Play asks (app.js startGame) and
// a tap in game asks again if something took it away (the app switcher, a
// call). Not when the player turned it off with the in-game button, and never
// in an installed app, which is full screen already. iPhone Safari has no
// fullscreen API for pages: home.js tells those players about Add to Home Screen.
export function isStandalone() {
    try {
        return !!(navigator.standalone || (window.matchMedia && (matchMedia("(display-mode: fullscreen)").matches || matchMedia("(display-mode: standalone)").matches)));
    } catch (e) { return false; }
}
function isPhone() { return Math.min(screen.width || 9999, screen.height || 9999) < 600; }
function lockLandscape() {
    // Android Chrome: only while fullscreen (or installed). Phones only; a
    // tablet is fine either way.
    try {
        const o = screen.orientation;
        if (!o || !o.lock || !isPhone()) return;
        const p = o.lock("landscape");
        if (p && p.catch) p.catch(() => { });
    } catch (e) { }
}
let fsAskedAt = 0;
export function mobileFullscreen() {
    if (!global.mobile) return;
    if (isStandalone()) { lockLandscape(); return; }
    const fs = window.dwFullscreen;
    if (!fs || !fs.supported()) return;
    if (fs.isOn()) { lockLandscape(); return; }
    fsAskedAt = performance.now();
    try {
        const el = document.documentElement;
        const go = el.requestFullscreen || el.webkitRequestFullscreen;
        const p = go && go.call(el, { navigationUI: "hide" });
        if (p && p.then) p.then(lockLandscape, () => { });
        else setTimeout(lockLandscape, 300);
    } catch (e) { }
}
function refullscreen() {
    const fs = window.dwFullscreen;
    if (!global.mobile || window.dwFsUserOff || isStandalone() || !fs || !fs.supported() || fs.isOn()) return;
    if (performance.now() - fsAskedAt < 4000) return;
    mobileFullscreen();
}

// ── safe area (notch, home bar) in CSS px ───────────────────────────────
let safe = { l: 0, r: 0, t: 0, b: 0 }, safeAt = 0;
function safeArea() {
    const now = performance.now();
    if (now - safeAt < 1000) return safe;
    safeAt = now;
    let probe = document.getElementById("dwSafeProbe");
    if (!probe) {
        probe = document.createElement("div");
        probe.id = "dwSafeProbe";
        probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
            "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
        document.body.appendChild(probe);
    }
    const cs = getComputedStyle(probe);
    safe = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    return safe;
}

// Viewport size, CSS px, cached: innerWidth/innerHeight can force a layout,
// and the HUD asks for them several times a frame.
let viewW = 0, viewH = 0;
function readView() { viewW = window.innerWidth; viewH = window.innerHeight; }
window.addEventListener("resize", readView);
window.addEventListener("orientationchange", () => setTimeout(readView, 100));

// the friends panel (account/ingameChat.js) takes the keyboard too
function friendChatOpen() {
    const el = document.getElementById("dwIgc");
    return !!(el && !el.hidden);
}

// ── the controller ──────────────────────────────────────────────────────
class TouchControls {
    constructor() {
        this.cv = null;
        this.move = null;       // { id, ox, oy, x, y, v }
        this.aim = null;        // { id, ox, oy, x, y, t0, maxR, firing }
        this.mouse = null;      // touch id that is being a mouse
        this.btn = new Map();   // touch id -> button id
        this.zones = {};        // tap zones app.js registers each frame (CSS rects)
        this.aimAng = 0;
        this.aimDist = 360;     // world units
        this.lastAim = { x: 1, y: 0 };
        this.moveVec = { x: 0, y: 0, mag: 0, ang: 0 };
        this.movePacked = 0;
        this.tapFireUntil = 0;
        this.armOn = false;
        this.pinch = null;
        this.cands = [];
        this.candsAt = 0;
        this.enabled = false;
        this.place = null;      // an armed aimed kit item: { slot, id, max, tid, x, y }
    }

    // Listens on every device: a touch screen laptop playing with the mouse
    // switches over the moment a finger lands on the game (canvas.js).
    attach(canvas) {
        this.cv = canvas;
        this.setActive(!!global.mobile);
        const el = canvas.cv;
        const opt = { passive: false };
        el.addEventListener("touchstart", (e) => this.onStart(e), opt);
        el.addEventListener("touchmove", (e) => this.onMove(e), opt);
        el.addEventListener("touchend", (e) => this.onEnd(e), opt);
        el.addEventListener("touchcancel", (e) => this.onEnd(e), opt);
        // a phone call, the app switcher or a rotation: let go of everything
        window.addEventListener("blur", () => this.releaseAll());
        // turning the phone moves every button under the thumbs
        window.addEventListener("orientationchange", () => this.releaseAll());
        if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener("change", () => this.releaseAll());
        document.addEventListener("visibilitychange", () => { if (document.hidden) this.releaseAll(); });
    }

    // Touch play on or off (app.js setTouchMode). Off: the sticks let go and
    // the DOM row hides (domTick); aim assist only ever runs while on.
    setActive(on) {
        this.enabled = !!on;
        this.releaseAll();
        this.place = null;
        this.movePacked = 0;
        if (on) this.buildDom();
        else if (this.dom) this.domTick();
    }

    viewW() { if (!viewW) readView(); return viewW; }
    viewH() { if (!viewH) readView(); return viewH; }

    // Where the kit and sidearm buttons sit, CSS px, from the screen size.
    layout() {
        const W = this.viewW(), H = this.viewH(), s = safeArea();
        const short = Math.min(W, H);
        // bigger on tablets, never under 44 px
        const u = Math.max(44, Math.min(64, short * 0.135));
        const right = W - s.r - 14, bottom = H - Math.max(s.b, 6) - 14;
        const out = {};
        // sidearm: the big round one in the corner
        const armR = u * 0.62;
        out.arm = { x: right - armR, y: bottom - armR, r: armR, round: true };
        // kit: three cards up the right edge above it. With no sidearm they
        // take its place.
        const st = (global.shop && global.shop.state) || {};
        const armGap = st.arm ? armR * 2 + 14 : 0;
        for (let i = 0; i < 3; i++) {
            const sz = u * 0.98;
            out["kit" + i] = { x: right - armR, y: bottom - armGap - sz / 2 - i * (sz + 10), w: sz, h: sz };
        }
        // dash in the corner left of the sidearm, the ability above it
        const abR = u * 0.6;
        out.dash = { x: right - armR * 2 - 18 - abR, y: bottom - abR, r: abR, round: true };
        out.ability = { x: out.dash.x - abR * 0.35, y: out.dash.y - abR * 2 - 20, r: abR, round: true };
        // the player can swap the two (long-press one, drag it onto the other)
        if (abilityFx.chipOrderNow()[0] === "ability") { const d = out.dash; out.dash = out.ability; out.ability = d; }
        out.unit = u;
        out.safe = s;
        this.L = out;
        return out;
    }

    hitButton(x, y) {
        const L = this.L || this.layout();
        const ids = ["arm", "kit0", "kit1", "kit2", "dash", "ability"];
        for (const id of ids) {
            const b = L[id];
            if (!b || !this.buttonShown(id)) continue;
            // a little slop around each button, thumbs are not precise
            if (b.round) { if (Math.hypot(x - b.x, y - b.y) <= b.r + 8) return id; }
            else if (Math.abs(x - b.x) <= b.w / 2 + 6 && Math.abs(y - b.y) <= b.h / 2 + 6) return id;
        }
        for (const id in this.zones) {
            const z = this.zones[id];
            if (z && x >= z.x - 4 && x <= z.x + z.w + 4 && y >= z.y - 4 && y <= z.y + z.h + 4) return id;
        }
        return null;
    }

    buttonShown(id) {
        if (!this.playing()) return false;
        const st = (global.shop && global.shop.state) || {};
        if (id === "arm") return !!st.arm;
        if (id === "dash" || id === "ability") {
            if (!(global.abil && global.abil.on) || !global.gems || !(global.gems.cap > 0)) return false;
            return !!((global.royale && global.royale.at > 0) || global.tutorialMode);
        }
        if (id.startsWith("kit")) {
            if (!global.gems || !(global.gems.cap > 0)) return false;
            // the tutorial brings the kit in with its own lesson
            if (global.tutorialMode) return !!((st.kitOrder || []).length || window.dwTutUi === "kit" || /kit/.test(window.dwTutAllow || ""));
            return !!(global.royale && global.royale.at > 0);
        }
        return true;
    }

    playing() {
        return !!(global.gameStart && !global.died && !global.disconnected);
    }

    // Everything that should get the touch as a mouse click instead of a stick.
    mouseMode() {
        return !this.playing() || global.showBigMap || global.showTree || !!global.dailyTankAd.renderUI ||
            !!(this.isFinale && this.isFinale());
    }

    anyClickable(cx, cy) {
        const m = { x: cx * global.ratio, y: cy * global.ratio };
        const c = global.clickables;
        for (const k in c) {
            const r = c[k];
            if (!r || typeof r !== "object" || k === "hover") continue;
            if (k === "optionsMenu") {
                for (const k2 in r) if (r[k2] && r[k2].check && r[k2].check(m) !== -1) return true;
                continue;
            }
            if (!r.check) continue;
            const v = r.check(m);
            if (v === true || (typeof v === "number" && v !== -1)) return true;
        }
        for (const id in this.uiRects || {}) {
            const z = this.uiRects[id];
            if (z && cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h) return true;
        }
        return false;
    }

    asMouse(type, t) {
        const cv = this.cv;
        const ev = { button: 0, clientX: t.clientX, clientY: t.clientY, preventDefault() { } };
        cv.mouseMove(ev);
        if (type === "down") cv.mouseDown(ev);
        else if (type === "up") {
            cv.mouseUp(ev);
            // a touch has no hover: park the pointer off screen so nothing stays lit
            global.mouse.x = -9999; global.mouse.y = -9999;
        }
    }

    onStart(e) {
        e.preventDefault();
        if (this.onTouchSeen) this.onTouchSeen();
        if (!this.enabled) return;
        if (!global.gameStart && !global.disconnected) return;
        // chatting: a tap outside the box closes it (and sends), it never
        // starts a stick or presses a button
        if (global.showChat) { if (this.cv) this.cv.closeChat(); this.swallow = true; return; }
        // the friends panel likewise: a tap on the game closes it
        if (friendChatOpen()) { const x = document.querySelector("#dwIgc .igc-x"); if (x) x.click(); this.swallow = true; return; }
        if (global.showTree && global.treeUi) { this.releaseAll(); global.treeUi.touch("start", e); return; }
        const now = performance.now();
        for (const t of e.changedTouches) {
            const x = t.clientX, y = t.clientY, id = t.identifier;
            // full map: one finger drags, two pinch
            if (global.showBigMap) {
                const z = this.zones.mapClose, m = this.uiRects && this.uiRects.map;
                const inRect = r => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
                // Close, or a tap anywhere off the panel
                if (this.mouse === null && (inRect(z) || (m && !inRect(m)))) { gameSound.uiClick(); global.canvas.toggleBigMap(); continue; }
                if (this.mouse === null) { this.mouse = id; this.asMouse("down", t); }
                else if (!this.pinch) this.startPinch(e.touches);
                continue;
            }
            if (this.mouseMode()) {
                if (this.mouse === null) { this.mouse = id; this.asMouse("down", t); }
                continue;
            }
            const b = this.hitButton(x, y);
            if (b) { this.pressButton(id, b, t); continue; }
            if (this.anyClickable(x, y)) {
                if (this.mouse === null) { this.mouse = id; this.asMouse("down", t); }
                continue;
            }
            // a tap off the tank picker closes it (and still moves or aims)
            if (global.touchTilesOpen && this.closeTiles) this.closeTiles();
            const leftSide = x < this.viewW() * 0.5;
            // placing a kit item: the move stick keeps the lower left, any
            // other touch is the placement
            if (this.place) {
                const stickZone = x < this.viewW() * 0.4 && y > this.viewH() * 0.3;
                if (stickZone && !this.move) {
                    this.move = { id, ox: x, oy: y, x, y, t0: now };
                    this.updateMove();
                } else if (this.place.tid == null) {
                    this.place.tid = id; this.place.x = x; this.place.y = y;
                }
                continue;
            }
            if (leftSide && !this.move) {
                this.move = { id, ox: x, oy: y, x, y, t0: now };
                this.updateMove();
            } else if (!leftSide && !this.aim) {
                this.aim = { id, ox: x, oy: y, x, y, t0: now, maxR: 0, firing: false };
            } else if (leftSide && !this.aim) {
                // second finger on the left while moving: treat it as aim
                this.aim = { id, ox: x, oy: y, x, y, t0: now, maxR: 0, firing: false };
            }
        }
    }

    onMove(e) {
        e.preventDefault();
        if (this.swallow || !this.enabled) return;
        if (global.showTree && global.treeUi) { global.treeUi.touch("move", e); return; }
        for (const t of e.changedTouches) {
            const id = t.identifier;
            if (this.pinch && (id === this.pinch.a || id === this.pinch.b)) { this.movePinch(e.touches); continue; }
            if (this.mouse === id) { this.asMouse("move", t); continue; }
            if (this.place && this.place.tid === id) { this.place.x = t.clientX; this.place.y = t.clientY; continue; }
            if (this.move && this.move.id === id) {
                const m = this.move;
                m.x = t.clientX; m.y = t.clientY;
                // past the rim the ring slides after the thumb
                const dx = m.x - m.ox, dy = m.y - m.oy, d = Math.hypot(dx, dy), lim = STICK.R * STICK.FOLLOW;
                if (d > lim) { m.ox = m.x - dx / d * lim; m.oy = m.y - dy / d * lim; }
                this.updateMove();
                continue;
            }
            if (this.aim && this.aim.id === id) {
                const a = this.aim;
                a.x = t.clientX; a.y = t.clientY;
                const dx = a.x - a.ox, dy = a.y - a.oy, d = Math.hypot(dx, dy), lim = STICK.R * STICK.FOLLOW;
                if (d > lim) { a.ox = a.x - dx / d * lim; a.oy = a.y - dy / d * lim; }
                a.maxR = Math.max(a.maxR, Math.min(d, lim) / STICK.R);
                continue;
            }
            const b = this.btn.get(id);
            if (b) this.noteMove(id, t.clientX, t.clientY);
            if (b && b.startsWith("kit") && global.kitDrag) this.lastDrag = { x: t.clientX, y: t.clientY };
            if (b === "ability" && this.abDrag && global.abilAim) this.dragAim(t.clientX, t.clientY);
        }
    }

    onEnd(e) {
        e.preventDefault();
        if (!this.enabled) return;
        // the finger that closed the chat is done once it lifts
        if (this.swallow) { if (!e.touches || !e.touches.length) this.swallow = false; return; }
        if (global.showTree && global.treeUi) { global.treeUi.touch("end", e); return; }
        for (const t of e.changedTouches) {
            const id = t.identifier;
            if (this.pinch && (id === this.pinch.a || id === this.pinch.b)) this.pinch = null;
            if (this.mouse === id) { this.mouse = null; this.asMouse("up", t); continue; }
            if (this.place && this.place.tid === id) { this.place.x = t.clientX; this.place.y = t.clientY; this.deploy(); continue; }
            if (this.move && this.move.id === id) { this.move = null; this.updateMove(); continue; }
            if (this.aim && this.aim.id === id) {
                const a = this.aim;
                this.aim = null;
                // a quick tap that never left the dead zone: shoot where it landed
                if (!a.firing && performance.now() - a.t0 < 260 && a.maxR < STICK.DEAD * 1.5) this.tapFire(a.ox, a.oy);
                continue;
            }
            if (this.btn.has(id)) { this.releaseButton(id, t); continue; }
        }
        if (!e.touches || !e.touches.length) {
            // nothing on the glass: make sure nothing is stuck down
            if (this.move || this.aim || this.mouse !== null || this.btn.size) this.releaseAll();
        }
        // a tap is a user gesture: get fullscreen back if it went away
        if (this.playing()) refullscreen();
    }

    releaseAll() {
        this.move = null; this.aim = null; this.pinch = null;
        if (this.abDrag) { this.abDrag = null; abilityFx.cancelAim(); }
        if (this.place) this.place.tid = null;
        if (this.mouse !== null) { this.mouse = null; if (this.cv) { global.clickables.clicked = false; global.bigMap && (global.bigMap.dragging = false); } }
        for (const [, b] of this.btn) if (b === "arm") this.armHeld = false;
        this.btn.clear();
        if (this.held) this.held.clear();
        global.touchTip = null;
        global.touchDrag = null;
        global.kitDrag = null;
        this.updateMove();
    }

    // ── buttons ──
    // A long press (LONG_MS without moving) on a thumb button shows what it
    // does instead of using it: dash and the ability go off on release, so a
    // held finger can still change its mind.
    pressButton(id, name, t) {
        this.btn.set(id, name);
        if (name === "dash" || name === "ability" || name === "arm" || name.startsWith("kit")) {
            (this.held || (this.held = new Map())).set(id, { name, x: t.clientX, y: t.clientY, at: performance.now(), tip: false, moved: false });
        }
        if (name.startsWith("kit")) {
            const slot = +name.slice(3);
            const ko = (global.shop.state && global.shop.state.kitOrder) || [];
            if (!ko[slot]) { global.createMessage("Kit slot " + (slot + 1) + " is empty. Buy items at a shop.", 2200); return; }
            // same press/drag/release path as the desktop kit box: tap uses it,
            // dragging it well away throws it out
            global.kitDrag = { slot, x: t.clientX * global.ratio, y: t.clientY * global.ratio, touch: true };
            this.lastDrag = { x: t.clientX, y: t.clientY };
            return;
        }
        if (name === "dash") return;
        if (name === "ability") {
            // a placed one (pad, wall): drag off the button to aim, lift to put
            // it down; a quick tap puts it where you last aimed
            const ab = global.abil || {};
            const onPad = (global.shop && global.shop.onPad) || (global.vault && global.vault.onPad);
            const down = ab.act === "burrow" && ab.actAt > performance.now();
            if (!onPad && !down && ab.eq && abilityFx.cdLeft() <= 0 && abilityFx.startAim(ab.eq)) {
                this.abDrag = { x0: t.clientX, y0: t.clientY, len: 0 };
                haptic("tap");
                return;
            }
            // the rest go off on release (releaseButton)
            return;
        }
        if (name === "arm") {
            // tap toggles "fire the sidearm with the main gun"; a long press explains it
            this.armDownAt = performance.now();
            return;
        }
        const z = this.zones[name];
        if (z && z.tap) { gameSound.uiClick(); z.tap(); }
    }

    // The drag off the ability button maps onto the world: ABDRAG_PX of drag
    // is the full placement range, in the drag's direction.
    dragAim(cx, cy) {
        const d = this.abDrag, a = global.abilAim;
        const dx = cx - d.x0, dy = cy - d.y0, len = Math.hypot(dx, dy);
        d.len = Math.max(d.len, len);
        if (len < 6) { a.wx = null; a.wy = null; return; }
        const reach = Math.min(1, len / ABDRAG_PX) * a.range;
        a.wx = global.player.renderx + dx / len * reach;
        a.wy = global.player.rendery + dy / len * reach;
    }
    // a dragged thumb button dropped on another: kit slots trade places on
    // the server, dash and ability just trade places on screen
    swapButtons(from, to) {
        if (from.startsWith("kit") && to.startsWith("kit")) {
            if (this.cv) this.cv.swapKitSlots(+from.slice(3), +to.slice(3));
        } else if ((from === "dash" && to === "ability") || (from === "ability" && to === "dash")) {
            abilityFx.swapChips(from, to);
            this.L = null;
            gameSound.uiClick();
        } else return;
        haptic("tap");
    }
    // per frame: a finger held still on a button long enough turns into its tooltip
    checkLongPress(now) {
        if (!this.held || !this.held.size) return;
        for (const [id, h] of this.held) {
            if (h.tip || h.moved || now - h.at < LONG_MS) continue;
            h.tip = true;
            h.tx = h.cx != null ? h.cx : h.x; h.ty = h.cy != null ? h.cy : h.y;
            global.touchTip = { name: h.name, at: now };
            if (h.name === "ability" && this.abDrag) { this.abDrag = null; abilityFx.cancelAim(); }
            if (h.name.startsWith("kit")) global.kitDrag = null;
            haptic("tap");
        }
    }
    noteMove(id, x, y) {
        const h = this.held && this.held.get(id);
        if (!h) return;
        h.cx = x; h.cy = y;
        if (!h.moved && !h.tip && Math.hypot(x - h.x, y - h.y) > 14) h.moved = true;
        // after the long press: moving on drags the button to rearrange it
        if (h.tip && !h.drag && Math.hypot(x - h.tx, y - h.ty) > 12) {
            h.drag = true;
            global.touchTip = null;
        }
        if (h.drag) global.touchDrag = { name: h.name, x, y };
    }
    releaseButton(id, t) {
        const name = this.btn.get(id);
        this.btn.delete(id);
        const h = this.held && this.held.get(id);
        if (h) this.held.delete(id);
        if (h && h.tip) {
            // it was a look, not a use; or a drag onto another button: swap
            if (global.touchTip && global.touchTip.name === h.name) global.touchTip = null;
            if (h.drag) {
                global.touchDrag = null;
                const to = t ? this.hitButton(t.clientX, t.clientY) : null;
                if (to && to !== h.name) this.swapButtons(h.name, to);
            }
            return;
        }
        if (name === "dash") { if (this.cv) this.cv.useDash(); haptic("tap"); return; }
        if (name === "ability" && !this.abDrag) {
            // it goes where you aim; with no aim yet, a little ahead of the tank
            this.aimKitTarget();
            if (this.cv) this.cv.useAbility();
            haptic("tap");
            return;
        }
        if (name === "ability" && this.abDrag) {
            const d = this.abDrag;
            if (global.abilAim && t) this.dragAim(t.clientX, t.clientY);
            this.abDrag = null;
            if (!global.abilAim) return;
            const a = global.abilAim;
            if (d.len < 14 || a.wx == null) { abilityFx.cancelAim(); this.aimKitTarget(); if (this.cv) this.cv.useAbility(); return; }
            const spot = abilityFx.aimSpot(util.getRatio());
            abilityFx.cancelAim();
            if (spot && this.cv) this.cv.useAbilityAt(spot.x, spot.y);
            haptic("tap");
            return;
        }
        if (name && name.startsWith("kit")) {
            const d = global.kitDrag;
            global.kitDrag = null;
            if (!d) return;
            const slot = d.slot;
            const L = this.L || {};
            const b = L["kit" + slot];
            const far = b ? Math.hypot(t.clientX - b.x, t.clientY - b.y) > b.w * 1.8 : false;
            if (far && this.playing()) {
                this.cv.socket.talk('kd', slot);
                global.kitDropped = (global.kitDropped | 0) + 1;
                gameSound.uiClick();
            } else if (!far) {
                const id = ((global.shop.state && global.shop.state.kitOrder) || [])[slot];
                if (AIMED_KIT[id]) { this.togglePlace(slot, id); return; }
                this.aimKitTarget();
                this.cv.useKitSlot(slot);
                haptic("tap");
            }
            return;
        }
        if (name === "arm") {
            this.armHeld = false;
            if (performance.now() - (this.armDownAt || 0) < LONG_MS) {
                this.armOn = !this.armOn;
                touchPref("armAuto", this.armOn);
                const cb = document.getElementById("touchArm");
                if (cb) cb.checked = this.armOn;
                global.createMessage(this.armOn ? "Your sidearm now fires with your gun." : "Your sidearm is off. Tap it again to turn it back on.", 2200);
                gameSound.uiClick();
            }
        }
    }

    // ── aimed kit items: tap the button, then touch where it should land ──
    togglePlace(slot, id) {
        if (this.place && this.place.slot === slot) { this.cancelPlace(); return; }
        this.place = { slot, id, max: AIMED_KIT[id].max, tid: null, x: 0, y: 0, at: performance.now() };
        // the aim stick hands over to the placement
        this.aim = null;
        gameSound.uiClick();
        haptic("tap");
    }
    cancelPlace() {
        if (!this.place) return;
        this.place = null;
        gameSound.uiClick();
    }
    // World units per CSS px (the tank sits at the middle of the view)
    worldPerCss() { return global.ratio / (util.getRatio() || 1); }
    // Where the placement lands, CSS px from the view centre, clamped to range.
    // { dx, dy, fx, fy, out } (fx/fy is the finger, out is past the range)
    placeSpot() {
        const p = this.place;
        if (!p || p.tid == null) return null;
        const fx = p.x - this.viewW() / 2, fy = p.y - this.viewH() / 2;
        const d = Math.hypot(fx, fy), maxCss = p.max / this.worldPerCss();
        const out = d > maxCss;
        const k = out ? maxCss / d : 1;
        return { dx: fx * k, dy: fy * k, fx, fy, out, maxCss };
    }
    deploy() {
        const p = this.place, s = this.placeSpot();
        if (!p || !s) return;
        this.place = null;
        // too close to the tank to have a direction: treat it as a slip
        if (Math.hypot(s.dx, s.dy) < 6) { this.place = p; p.tid = null; return; }
        global.target.x = s.dx * global.ratio;
        global.target.y = s.dy * global.ratio;
        const d = Math.hypot(s.dx, s.dy);
        this.lastAim = { x: s.dx / d, y: s.dy / d };
        this.cv.useKitSlot(p.slot);
        haptic("tap");
    }

    // kit items land where you aim; with no aim yet, a little ahead of the tank
    aimKitTarget() {
        const r = util.getRatio();
        if (!this.aim && !(Math.abs(global.target.x) + Math.abs(global.target.y) > 1)) {
            global.target.x = this.lastAim.x * 260 * r;
            global.target.y = this.lastAim.y * 260 * r;
        }
    }

    // ── map pinch ──
    startPinch(touches) {
        if (!touches || touches.length < 2) return;
        const a = touches[0], b = touches[1];
        this.pinch = { a: a.identifier, b: b.identifier, d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, z0: global.bigMap.zoom || 1 };
        global.bigMap.dragging = false;
    }
    movePinch(touches) {
        const p = this.pinch;
        if (!p || !touches) return;
        let a = null, b = null;
        for (const t of touches) { if (t.identifier === p.a) a = t; else if (t.identifier === p.b) b = t; }
        if (!a || !b) return;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        global.bigMap.zoom = Math.max(1, Math.min(4, p.z0 * d / p.d0));
    }

    tapFire(cx, cy) {
        // screen spot -> offset from the tank (it sits at the centre)
        const dx = (cx - this.viewW() / 2) * global.ratio;
        const dy = (cy - this.viewH() / 2) * global.ratio;
        if (Math.hypot(dx, dy) < 4) return;
        global.target.x = dx; global.target.y = dy;
        const d = Math.hypot(dx, dy);
        this.lastAim = { x: dx / d, y: dy / d };
        this.tapFireUntil = performance.now() + 200;
    }

    updateMove() {
        if (!this.enabled) { this.moveVec = { x: 0, y: 0, mag: 0, ang: 0 }; if (this.movePacked) { this.movePacked = 0; global.touchMovePacked = 0; } return; }
        const m = this.move;
        const v = m ? stickVector(m.x - m.ox, m.y - m.oy) : { x: 0, y: 0, mag: 0, ang: 0 };
        this.moveVec = v;
        const sock = this.cv && this.cv.socket;
        if (!sock) return;
        const bits = moveBits(v);
        for (let i = 0; i < 4; i++) sock.cmd.set(i, !!(bits & (1 << i)));
        const packed = packMove(v);
        if (packed !== this.movePacked) {
            this.movePacked = packed;
            global.touchMovePacked = packed;
            sock.cmd.reactNow();
        }
    }

    // Aim assist candidates: tanks, bosses and chests on screen (not your
    // own colour, so a duo partner is left alone), and ore rocks nearby.
    refreshCands(now) {
        if (now - this.candsAt < 120) return this.cands;
        this.candsAt = now;
        const out = [];
        const me = global.player;
        const mx = me.renderx, my = me.rendery;
        let myColor = null;
        for (const e of global.entities) if (e.id === gui.playerid) { myColor = e.color; break; }
        for (const e of global.entities) {
            if (!e._onScreen || e.id === gui.playerid || !e.render) continue;
            const named = typeof e.name === "string" && e.name.length > 0;
            const boss = e._isBoss === true, chest = !!e._chest;
            if (!named && !boss && !chest) continue;
            if (named && myColor != null && e.color === myColor) continue;
            if (e.render.status && e.render.status.getFade && e.render.status.getFade() < 1) continue;
            const dx = e.render.x - mx, dy = e.render.y - my, dist = Math.hypot(dx, dy);
            if (dist < 1 || dist > 1500) continue;
            out.push({ ang: Math.atan2(dy, dx), dist, pri: chest ? 0.8 : 1 });
        }
        const tr = window.terrainRenderer;
        if (tr && tr._ore && tr._cellPolys && tr._world) {
            const w = tr._world;
            let n = 0;
            for (const [k] of tr._ore) {
                if (tr._rockDead && tr._rockDead.has(k)) continue;
                const c = tr._cellPolys.get(k);
                if (!c) continue;
                const x = c.cx * w.s - w.hw, y = c.cy * w.s - w.hh;
                const dx = x - mx, dy = y - my;
                if (Math.abs(dx) > 700 || Math.abs(dy) > 500) continue;
                out.push({ ang: Math.atan2(dy, dx), dist: Math.hypot(dx, dy), pri: 0.55 });
                if (++n > 40) break;
            }
        }
        this.cands = out;
        return out;
    }

    // Called every frame by app.js before the command goes out.
    frame(now) {
        const sock = this.cv && this.cv.socket;
        if (!sock || !this.enabled) return;
        this.checkLongPress(now);
        if (!this.playing() || global.showBigMap || global.showChat || friendChatOpen()) {
            if (this.move || this.aim) { this.move = null; this.aim = null; this.updateMove(); }
            if (!this.playing()) this.place = null;
            sock.cmd.set(4, false);
            if (this.repel) sock.cmd.set(6, false);
            if (!this.armHeld || global.showChat) sock.cmd.set(7, false);
            return;
        }
        if (this.place) {
            const ko = (global.shop.state && global.shop.state.kitOrder) || [];
            if (ko[this.place.slot] !== this.place.id || !this.buttonShown("kit0")) this.place = null;
        }
        let firing = false;
        const a = this.aim;
        if (a) {
            const v = stickVector(a.x - a.ox, a.y - a.oy);
            if (v.mag > 0) {
                a.firing = true;
                let ang = v.ang, dist = 220 + 380 * v.mag;
                if (prefs.assist) {
                    const res = assistAim(ang, this.refreshCands(now));
                    ang = res.ang;
                    if (res.dist) dist = Math.max(120, Math.min(900, res.dist));
                }
                // ease the aim a touch so a jittery thumb doesn't shake the barrel
                const d = Math.atan2(Math.sin(ang - this.aimAng), Math.cos(ang - this.aimAng));
                this.aimAng += d * (Math.abs(d) > 0.5 ? 1 : 0.55);
                this.aimDist = dist;
                const r = util.getRatio();
                global.target.x = Math.cos(this.aimAng) * dist * r;
                global.target.y = Math.sin(this.aimAng) * dist * r;
                this.lastAim = { x: Math.cos(this.aimAng), y: Math.sin(this.aimAng) };
                firing = true;
            } else if (a.firing) {
                // back in the dead zone after aiming: keep shooting the same way
                firing = true;
            }
        }
        if (now < this.tapFireUntil) firing = true;
        sock.cmd.set(4, firing);
        sock.cmd.set(6, !!this.repel);
        const st = (global.shop && global.shop.state) || {};
        const armWanted = !!st.arm && (this.armHeld || (this.armOn && firing));
        sock.cmd.set(7, armWanted);
        if (global.mobileStatus) global.mobileStatus.showCrosshair = !!a;
    }
}

// ── DOM: the top-left row, the clip card and the rotate prompt ──────────
TouchControls.prototype.buildDom = function () {
    if (this.dom) return;
    this.dom = true;
    try {
        if (!document.getElementById("dwTouchCss")) {
            const l = document.createElement("link");
            l.id = "dwTouchCss"; l.rel = "stylesheet";
            l.href = new URL("../touch.css", import.meta.url).href;
            document.head.appendChild(l);
        }
    } catch (e) { }
    const refocus = () => { const cv = document.getElementById("gameCanvas"); if (cv && global.gameStart) cv.focus(); };
    // chat: opens the box over your tank (the keyboard comes up with it)
    const chat = document.createElement("button");
    chat.id = "touchChatBtn";
    chat.type = "button";
    chat.setAttribute("aria-label", "Chat");
    chat.innerHTML = '<svg class="dw-ic" aria-hidden="true"><use href="#i-chat"/></svg>';
    chat.onclick = () => { chat.blur(); if (this.cv && this.playing()) this.cv.spawnChatInput(); };
    document.body.appendChild(chat);
    // record: the in-game recorder (canvas.js record), Share / Save when it stops
    const rec = document.createElement("button");
    rec.id = "touchRecBtn";
    rec.type = "button";
    rec.setAttribute("aria-label", "Record a clip");
    rec.innerHTML = '<span class="rec-dot"></span><span class="rec-time">0:00</span>';
    rec.onclick = () => {
        rec.blur();
        if (!this.cv) return;
        if (!canRecord()) { global.createMessage("This browser can't record the game. Try Chrome, or Safari on iOS 15 or later.", 4000); return; }
        this.cv.record();
        refocus();
    };
    document.body.appendChild(rec);
    // auto-fire: shoot without a thumb on the aim stick (mining, mostly)
    const auto = document.createElement("button");
    auto.id = "touchAutoBtn";
    auto.type = "button";
    auto.textContent = "Auto";
    auto.setAttribute("aria-label", "Auto-fire");
    auto.onclick = () => {
        auto.blur();
        if (!this.cv || !this.playing()) return;
        this.autoFire = !this.autoFire;
        this.cv.socket.talk("t", 1, true);
        haptic("tap");
    };
    document.body.appendChild(auto);
    this.autoBtn = auto;
    const repel = document.createElement("button");
    repel.id = "touchRepelBtn";
    repel.type = "button";
    repel.textContent = "Repel";
    repel.setAttribute("aria-label", "Repel drones (right click)");
    repel.onclick = () => {
        repel.blur();
        if (!this.cv || !this.playing()) return;
        this.repel = !this.repel;
        haptic("tap");
    };
    document.body.appendChild(repel);
    this.repelBtn = repel;
    const over = document.createElement("button");
    over.id = "touchOverBtn";
    over.type = "button";
    over.textContent = "Override";
    over.setAttribute("aria-label", "Override auto turrets and drones");
    over.onclick = () => {
        over.blur();
        if (!this.cv || !this.playing()) return;
        this.override = !this.override;
        this.cv.socket.talk("t", 2, true);
        haptic("tap");
    };
    document.body.appendChild(over);
    this.overBtn = over;
    // duos: ping where you're aiming (or where you stand) for your partner
    const ping = document.createElement("button");
    ping.id = "touchPingBtn";
    ping.type = "button";
    ping.textContent = "Ping";
    ping.setAttribute("aria-label", "Ping for your teammate");
    ping.onclick = () => {
        ping.blur();
        if (!this.cv) return;
        this.aimKitTarget();
        this.cv.duoPing();
        haptic("tap");
    };
    document.body.appendChild(ping);
    this.pingBtn = ping;
    this.recBtn = rec;
    this.chatBtn = chat;
    // portrait: turn sideways (or keep going, it still works)
    const rot = document.createElement("div");
    rot.id = "touchRotate";
    rot.innerHTML = '<div class="rot-card"><div class="rot-phone"></div><h2>Turn your phone sideways</h2>' +
        '<p>You can see much more of the map that way.</p>' +
        '<p class="rot-lock">Not turning? Switch off rotation lock.</p>' +
        '<button type="button">Play upright anyway</button></div>';
    rot.querySelector("button").onclick = () => { this.portraitOk = true; rot.classList.remove("show"); };
    // the overlay swallows touches, but never leaves a stick held
    rot.addEventListener("touchstart", () => this.releaseAll(), { passive: true });
    document.body.appendChild(rot);
    this.rotEl = rot;
    this.buildSettings();
    setInterval(() => this.domTick(), 250);
};
// Settings > Graphics has a Mobile block (it held the old joystick switches):
// it becomes the touch controls' own switches.
TouchControls.prototype.buildSettings = function () {
    const box = document.querySelector("#homeSettingsPanel .sp-checks.mobile-only") || document.querySelector(".sp-checks.mobile-only");
    if (!box || box.dataset.touch) return;
    box.dataset.touch = "1";
    const label = box.previousElementSibling;
    if (label && label.classList.contains("sp-label")) {
        label.textContent = "Touch controls";
        // first thing in the pane on a touch screen
        const pane = box.parentElement;
        if (pane && pane.firstElementChild !== label) { pane.insertBefore(box, pane.firstElementChild); pane.insertBefore(label, box); }
    }
    const rows = [
        ["touchAssist", "Aim assist", "assist", "Your aim pulls a bit toward the nearest tank, chest or ore"],
        ["touchHaptics", "Vibration", "haptics", "A short buzz on hits, kills and banking (Android)"],
        ["touchArm", "Sidearm with gun", "armAuto", "Your sidearm shoots whenever your main gun does"],
    ];
    // the old switches stay in the page (settings code still reads them), hidden
    for (const el of box.children) el.style.display = "none";
    for (const [id, text, key, tip] of rows) {
        // iOS has no vibration API: no switch that does nothing
        if (key === "haptics" && !navigator.vibrate) continue;
        const l = document.createElement("label");
        l.className = "container";
        l.title = tip;
        l.innerHTML = '<input id="' + id + '" tabindex="-1" class="checkbox" type="checkbox"><span class="checkmark"></span>' + text;
        const input = l.firstChild;
        input.checked = prefs[key] !== false;
        input.addEventListener("change", () => {
            touchPref(key, input.checked);
            if (key === "armAuto") this.armOn = input.checked;
            if (key === "haptics" && input.checked) haptic("buy");
        });
        box.appendChild(l);
    }
};
function canRecord() {
    const cv = document.getElementById("gameCanvas");
    return !!(cv && cv.captureStream && window.MediaRecorder);
}
// DOM writes only when something changed (a write per tick restyles the page)
function setShow(el, on, disp = "flex") { const v = on ? disp : "none"; if (el._shown !== v) { el._shown = v; el.style.display = v; } }
function setClass(el, cls, on) { const k = "_c_" + cls; if (el[k] !== on) { el[k] = on; el.classList.toggle(cls, on); } }
TouchControls.prototype.domTick = function () {
    const playing = this.playing() && this.enabled;
    setShow(this.chatBtn, playing);
    setShow(this.autoBtn, playing);
    // duos only, while you play (the death card and spectate bar need the space)
    setShow(this.pingBtn, !!(global.royale && global.royale.duos) && playing);
    // the server forgets auto-fire with the tank
    if (!playing && global.died) { this.autoFire = false; this.repel = false; this.override = false; }
    setClass(this.autoBtn, "on", !!this.autoFire);
    setShow(this.repelBtn, playing);
    setShow(this.overBtn, playing);
    setClass(this.repelBtn, "on", !!this.repel);
    setClass(this.overBtn, "on", !!this.override);
    const vr = this.cv && this.cv.videoRecorder;
    const recOn = !!(vr && vr.state === "recording");
    // keep the stop button while recording, even on the death card
    setShow(this.recBtn, recOn);
    setClass(this.recBtn, "on", recOn);
    if (recOn) {
        const sec = Math.floor((performance.now() - (vr.startedAt || performance.now())) / 1000);
        const t = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
        const el = this.recBtn.lastChild;
        if (el.textContent !== t) el.textContent = t;
    }
    setClass(document.body, "duo-raid", !!(global.royale && global.royale.duos) && playing);
    // phones only (tablets are fine upright), and only in a raid
    const W = this.viewW(), H = this.viewH();
    const portrait = H > W * 1.15 && Math.min(W, H) < 600;
    const want = !!(this.enabled && global.gameStart && portrait && !this.portraitOk);
    setClass(this.rotEl, "show", want);
    if (want) this.releaseAll();
};
// The finished clip: Share (the phone's own sheet, with the file) or Save.
TouchControls.prototype.showClip = function (blob, name) {
    let card = document.getElementById("touchClip");
    if (!card) {
        card = document.createElement("div");
        card.id = "touchClip";
        document.body.appendChild(card);
    }
    if (this.clipUrl) URL.revokeObjectURL(this.clipUrl);
    const url = this.clipUrl = URL.createObjectURL(blob);
    const file = typeof File === "function" ? new File([blob], name, { type: blob.type }) : null;
    const shareable = !!(file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
    const mb = (blob.size / 1048576).toFixed(1);
    card.innerHTML = '<video muted playsinline loop autoplay></video>' +
        '<div class="clip-txt"><b>Clip saved</b>' + mb + ' MB</div>' +
        (shareable ? '<button type="button" class="clip-share">Share</button>' : '') +
        '<a class="clip-save" download="' + name + '" href="' + url + '">Save</a>' +
        '<button type="button" class="clip-x" aria-label="Close">\u2715</button>';
    const v = card.querySelector("video");
    v.src = url;
    card.classList.add("show");
    const close = () => { card.classList.remove("show"); try { v.pause(); } catch (e) { } };
    card.querySelector(".clip-x").onclick = close;
    const sh = card.querySelector(".clip-share");
    if (sh) sh.onclick = async () => {
        try { await navigator.share({ files: [file], title: "Corez.io", text: global.aoWorld ? "A clip from my game on corez.io" : "A clip from my raid on corez.io" }); close(); }
        catch (e) { /* cancelled: the card stays for Save */ }
    };
    clearTimeout(this.clipTimer);
    this.clipTimer = setTimeout(close, 30000);
};

export const touch = new TouchControls();
touch.armOn = touchPref("armAuto") !== false;
window.dwTouch = touch;
