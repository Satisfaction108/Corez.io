// Touch controls for phones and tablets.
//
// Left half: a floating move stick. It appears where the thumb lands, reads
// analog (full 360 degrees, speed from how far you push) and slides after the
// thumb if it runs past the rim. Right half: an aim stick that fires while it
// is held, with a light pull toward the nearest target in a small cone. A quick
// tap on the right half fires at the spot you tapped.
//
// Thumb buttons along the right edge: the three kit slots and the sidearm.
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

import { STICK, stickVector, moveBits, packMove, unpackMove, assistAim } from "./touchInput.js";
export { STICK, stickVector, moveBits, packMove, unpackMove, assistAim };

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
    }

    attach(canvas) {
        this.cv = canvas;
        this.enabled = true;
        this.buildDom();
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
        out.unit = u;
        out.safe = s;
        this.L = out;
        return out;
    }

    hitButton(x, y) {
        const L = this.L || this.layout();
        const ids = ["arm", "kit0", "kit1", "kit2"];
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
        if (!global.gameStart && !global.disconnected) return;
        // chatting: a tap outside the box closes it (and sends), it never
        // starts a stick or presses a button
        if (global.showChat) { if (this.cv) this.cv.closeChat(); this.swallow = true; return; }
        // the friends panel likewise: a tap on the game closes it
        if (friendChatOpen()) { const x = document.querySelector("#dwIgc .igc-x"); if (x) x.click(); this.swallow = true; return; }
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
            const leftSide = x < this.viewW() * 0.5;
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
        if (this.swallow) return;
        for (const t of e.changedTouches) {
            const id = t.identifier;
            if (this.pinch && (id === this.pinch.a || id === this.pinch.b)) { this.movePinch(e.touches); continue; }
            if (this.mouse === id) { this.asMouse("move", t); continue; }
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
            if (b && b.startsWith("kit") && global.kitDrag) this.lastDrag = { x: t.clientX, y: t.clientY };
        }
    }

    onEnd(e) {
        e.preventDefault();
        // the finger that closed the chat is done once it lifts
        if (this.swallow) { if (!e.touches || !e.touches.length) this.swallow = false; return; }
        for (const t of e.changedTouches) {
            const id = t.identifier;
            if (this.pinch && (id === this.pinch.a || id === this.pinch.b)) this.pinch = null;
            if (this.mouse === id) { this.mouse = null; this.asMouse("up", t); continue; }
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
    }

    releaseAll() {
        this.move = null; this.aim = null; this.pinch = null;
        if (this.mouse !== null) { this.mouse = null; if (this.cv) { global.clickables.clicked = false; global.bigMap && (global.bigMap.dragging = false); } }
        for (const [, b] of this.btn) if (b === "arm") this.armHeld = false;
        this.btn.clear();
        global.kitDrag = null;
        this.updateMove();
    }

    // ── buttons ──
    pressButton(id, name, t) {
        this.btn.set(id, name);
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
        if (name === "arm") {
            // tap toggles "fire the sidearm with the main gun"; holding fires it now
            this.armHeld = true;
            this.armDownAt = performance.now();
            return;
        }
        const z = this.zones[name];
        if (z && z.tap) { gameSound.uiClick(); z.tap(); }
    }

    releaseButton(id, t) {
        const name = this.btn.get(id);
        this.btn.delete(id);
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
                this.aimKitTarget();
                this.cv.useKitSlot(slot);
                haptic("tap");
            }
            return;
        }
        if (name === "arm") {
            this.armHeld = false;
            if (performance.now() - (this.armDownAt || 0) < 300) {
                this.armOn = !this.armOn;
                touchPref("armAuto", this.armOn);
                const cb = document.getElementById("touchArm");
                if (cb) cb.checked = this.armOn;
                global.createMessage(this.armOn ? "Sidearm fires with your gun." : "Sidearm off. Hold the button to fire it.", 2200);
                gameSound.uiClick();
            }
        }
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
        if (!this.playing() || global.showBigMap || global.showChat || friendChatOpen()) {
            if (this.move || this.aim) { this.move = null; this.aim = null; this.updateMove(); }
            sock.cmd.set(4, false);
            if (!this.armHeld || global.showChat) sock.cmd.set(7, false);
            return;
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
        '<p>Raids play in landscape, so you can see what is coming.</p><button type="button">Keep playing upright</button></div>';
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
        ["touchAssist", "Aim Assist", "assist", "Aim bends a little toward the nearest tank, chest or ore rock"],
        ["touchHaptics", "Vibration", "haptics", "A short buzz on hits, kills and banking (Android)"],
        ["touchArm", "Sidearm With Gun", "armAuto", "The sidearm fires whenever your main gun does"],
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
    const playing = this.playing();
    setShow(this.chatBtn, playing);
    setShow(this.autoBtn, playing);
    // duos only, while you play (the death card and spectate bar need the space)
    setShow(this.pingBtn, !!(global.royale && global.royale.duos) && playing);
    // the server forgets auto-fire with the tank
    if (!playing && global.died) this.autoFire = false;
    setClass(this.autoBtn, "on", !!this.autoFire);
    const vr = this.cv && this.cv.videoRecorder;
    const recOn = !!(vr && vr.state === "recording");
    // keep the stop button while recording, even on the death card
    setShow(this.recBtn, playing || recOn);
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
    const want = !!(global.gameStart && portrait && !this.portraitOk);
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
        try { await navigator.share({ files: [file], title: "Corez.io", text: "A clip from my raid on corez.io" }); close(); }
        catch (e) { /* cancelled: the card stays for Save */ }
    };
    clearTimeout(this.clipTimer);
    this.clipTimer = setTimeout(close, 30000);
};

export const touch = new TouchControls();
touch.armOn = touchPref("armAuto") !== false;
window.dwTouch = touch;
