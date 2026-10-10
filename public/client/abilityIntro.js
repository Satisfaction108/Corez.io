// The one-time ability tour: once per browser, right after the first landing
// in a raid, three spotlight cards walk through the dash chip, the ability
// chip (with this raid's free ability) and the shop. Next / Got it, Esc or a
// click away skips it, and using the thing moves it on. Phones point at the
// thumb buttons instead. The rules live in abilityIntroLogic.js.
//
// app.js calls draw(c, k) last in the HUD pass (k: GUI units per CSS px on
// touch, null on desktop).

import { global } from "./global.js";
import { config } from "./config.js";
import * as abilityFx from "./abilityFx.js";
import { slamUp } from "./juice.js";
import * as L from "./abilityIntroLogic.js";
import { holding as coachHolding } from "./coach.js";

let store = null;
try { store = window.localStorage; } catch (e) { store = null; }
let done = store ? L.introDone(store) : true;

const T = { on: false, step: 0, stepAt: 0, landedAt: 0, sawFall: false, firstSeen: 0, dashAt: 0, abAt: 0, perCss: 1,
    next: { x: 0, y: 0, w: 0, h: 0 }, skip: { x: 0, y: 0, w: 0, h: 0 }, spot: { x: 0, y: 0, r: 0 } };
export function state() { return T; }

function finish() {
    T.on = false;
    done = true;
    if (store) L.markDone(store);
    global.abilityIntroOn = false;
}
function go(step) {
    if (step < 0) { finish(); return; }
    T.step = step;
    T.stepAt = performance.now();
    const ab = global.abil || {};
    T.dashAt = ab.dashAt || 0;
    T.abAt = global.abilityUsedAt || 0;
}

const touch = () => !!global.mobile;
function keyName(id, def) { const H = abilityFx.hud(); return H && H.keyLabel ? H.keyLabel(id, def) : def; }
function abilityName() {
    const ab = global.abil || {};
    const it = ((global.shop && global.shop.catalog) || []).find(i => i.id === ab.eq);
    return { name: it ? it.name : "an ability", aimed: !!(it && it.place) };
}
function stepText(id) {
    if (id === "dash") return touch()
        ? ["Dash", "Tap to dash. You have 2 charges, and each one comes back in 5 seconds."]
        : ["Dash", "Press " + keyName("KEY_DASH", "Alt") + " to dash. You have 2 charges, and each one comes back in 5 seconds."];
    if (id === "ability") {
        const a = abilityName();
        const how = touch() ? (a.aimed ? "Drag off the button to aim, then lift your finger to use it." : "Tap to use it.")
            : a.aimed ? "Press " + keyName("KEY_ABILITY", "Q") + " to aim, then left click to use it." : "Press " + keyName("KEY_ABILITY", "Q") + " to use it.";
        return ["Your ability", how + " You have " + a.name + " for this raid."];
    }
    return ["The shop", "The shop sells more abilities."];
}

// where each step points (GUI units): a circle round the thing
function spotFor(id, k) {
    const sp = T.spot;
    if (id === "dash" || id === "ability") {
        if (touch()) {
            const Lt = window.dwTouch && window.dwTouch.L;
            const b = Lt && Lt[id];
            if (!b || !k) return false;
            sp.x = b.x * k; sp.y = b.y * k; sp.r = (b.r || 30) * k + 14;
            return true;
        }
        const ch = abilityFx.chips[id];
        if (!ch || performance.now() - ch.at > 500) return false;
        sp.x = ch.x + ch.w / 2; sp.y = ch.y + ch.h / 2; sp.r = ch.w * 0.75 + 8;
        return true;
    }
    // the shop: an arrow off the tank toward the nearest one
    const me = global.player, list = global.shops || [];
    if (!me || !list.length) return false;
    let best = null, bd = Infinity;
    for (const s of list) { const d = Math.hypot(s.x - me.renderx, s.y - me.rendery); if (d < bd) { bd = d; best = s; } }
    if (!best) return false;
    const a = Math.atan2(best.y - me.rendery, best.x - me.renderx);
    sp.x = global.screenWidth / 2 + Math.cos(a) * 130; sp.y = global.screenHeight / 2 + Math.sin(a) * 130;
    sp.r = 46; sp.ang = a; sp.dist = bd;
    return true;
}

function eligible(now) {
    const ab = global.abil || {};
    const sky = abilityFx.hud() && abilityFx.hud().landAt ? abilityFx.hud().landAt() : 0;
    if (sky) { T.sawFall = true; T.landedAt = sky; }
    if (!T.landedAt && !T.firstSeen && ab.eq) T.firstSeen = now;
    const landedAgo = T.landedAt ? now - T.landedAt : T.firstSeen ? now - T.firstSeen : 0;
    const sh = global.shop || {};
    const busy = !!(global.showBigMap || global.showChat || global.showTree || sh.onPad || (global.vault && global.vault.onPad) || global.abilAim);
    let slam = false;
    try { slam = slamUp(); } catch (e) { slam = false; }
    return L.canStart({
        done, tutorial: !!global.tutorialMode, playing: !!(global.gameStart && !global.died && !global.disconnected && global.royale && global.royale.at > 0),
        abilOn: !!ab.on, eq: ab.eq, falling: !!sky, landedAgo, slam, coach: coachHolding(),
        card: !!global.hudCardUp || !!(global.kitUnlocks && global.kitUnlocks.length) || !!(global.kitGlides && global.kitGlides.length), busy,
    });
}

// Lines that fit maxW as drawText will draw them (same font, the font size
// boost and its rim included), so nothing reaches the card's edge.
function wrap(c, text, size, maxW) {
    const H = abilityFx.hud();
    const width = H && H.hudTextW ? (t) => H.hudTextW(t, size) : (t) => { c.font = "700 " + (size + (config.graphical.fontSizeBoost || 0)) + "px Ubuntu, sans-serif"; return c.measureText(t).width; };
    const out = [];
    let line = "";
    for (const w of text.split(" ")) {
        const t = line ? line + " " + w : w;
        if (line && width(t) > maxW) { out.push(line); line = w; } else line = t;
    }
    if (line) out.push(line);
    return out;
}
let wrapKey = "", wrapLines = [];

export function draw(c, k) {
    if (done) return;
    const now = performance.now();
    T.perCss = k || (global.ratio / ((global.canvas && global.canvas.height / global.screenHeight / global.ratio) || 1));
    if (!T.on) {
        if (!eligible(now)) return;
        T.on = true;
        global.abilityIntroOn = true;
        go(0);
    }
    // gone mid-tour (death, a panel): pick it up again later
    if (global.died || !global.gameStart) { T.on = false; global.abilityIntroOn = false; return; }
    const id = L.STEPS[T.step];
    // using it moves it on
    const ab = global.abil || {};
    if (id === "dash" && (ab.dashAt || 0) > T.dashAt) { go(L.advance(T.step, "dash")); return; }
    if (id === "ability" && ((global.abilityUsedAt || 0) > T.abAt || global.abilAim)) { go(L.advance(T.step, "ability")); return; }
    if (id === "shop" && global.shop && global.shop.onPad) { go(L.advance(T.step, "shop")); return; }
    if (!spotFor(id, k)) { if (id === "shop") finish(); return; }
    // nobody's acting on it: move along rather than hold the screen
    if (now - T.stepAt > L.STEP_MAX_MS) { const nx = T.step + 1; if (nx >= L.STEPS.length) finish(); else go(nx); return; }
    global.hudCardUp = "intro";
    const H = abilityFx.hud();
    if (!H) return;
    const sp = T.spot, W = global.screenWidth, Hh = global.screenHeight;
    const fadeIn = Math.min(1, (now - T.stepAt) / 220);
    const calm = !!(global.reducedMotion && global.reducedMotion());
    c.save();
    // dim everything but the spot (light: the game keeps going under it)
    c.globalAlpha = 0.3 * fadeIn;
    c.fillStyle = "#08060c";
    c.beginPath();
    c.rect(0, 0, W, Hh);
    c.arc(sp.x, sp.y, sp.r, 0, Math.PI * 2, true);
    c.fill("evenodd");
    // a ring breathing round it
    const pulse = calm ? 0.5 : 0.5 + 0.5 * Math.sin(now / 220);
    c.globalAlpha = fadeIn;
    c.lineWidth = 3; c.strokeStyle = H.HUD.gold || "#f2b83c";
    c.beginPath(); c.arc(sp.x, sp.y, sp.r + 3 + pulse * 5, 0, Math.PI * 2); c.stroke();
    if (id === "shop") {
        // the arrow toward the shop
        c.save();
        c.translate(sp.x, sp.y); c.rotate(sp.ang);
        c.fillStyle = H.HUD.gold || "#f2b83c"; c.strokeStyle = "#120e15"; c.lineWidth = 2.5; c.lineJoin = "round";
        c.beginPath(); c.moveTo(26, 0); c.lineTo(-14, -18); c.lineTo(-6, 0); c.lineTo(-14, 18); c.closePath();
        c.fill(); c.stroke();
        c.restore();
    }
    // the card: above the spot if it fits, else below; never off screen
    const [title, body] = stepText(id);
    const cw = Math.min(W - 20, 330), pad = 18;
    const boost = config.graphical.fontSizeBoost || 0;
    const key = id + "|" + body + "|" + cw + "|" + boost;
    if (key !== wrapKey) { wrapKey = key; wrapLines = wrap(c, body, 12, cw - pad * 2 - 6); }
    const lh = 17 + boost;
    const ch = 44 + boost + wrapLines.length * lh + 46;
    let cx = Math.max(10, Math.min(W - cw - 10, sp.x - cw / 2));
    let cy = sp.y - sp.r - 22 - ch;
    if (cy < 10) cy = Math.min(Hh - ch - 10, sp.y + sp.r + 22);
    cy += (1 - fadeIn) * 8;
    H.hudPanel(c, cx, cy, cw, ch, { r: 12, alpha: fadeIn });
    H.hudTitle((T.step + 1) + "/" + L.STEPS.length, cx + cw - pad, cy + 20, 11, H.HUD.text2, "right", fadeIn, c);
    H.hudTitle(title, cx + pad, cy + 20, 16, H.HUD.head, "left", fadeIn, c);
    let ly = cy + 44 + boost;
    for (const l of wrapLines) { H.drawText(l, cx + pad, ly, 12, H.HUD.text, "left", true, fadeIn); ly += lh; }
    // Next / Got it, and Skip
    const last = T.step === L.STEPS.length - 1;
    const bw = 96, bh = 28, by = cy + ch - bh / 2 - 12;
    const nx = cx + cw - pad - bw / 2, skx = cx + pad + 36;
    if (H.hudButton) {
        H.hudButton(c, nx, by - bh / 2, bw, bh, last ? "Got it" : "Next", { fill: H.HUD.play, lipCol: H.HUD.playDk, textCol: "#fff", size: 14, alpha: fadeIn });
        if (!last) H.hudButton(c, skx, by - bh / 2, 72, bh, "Skip", { size: 13, alpha: fadeIn, textCol: H.HUD.text });
    }
    T.next.x = nx - bw / 2; T.next.y = by - bh / 2; T.next.w = bw; T.next.h = bh;
    if (!last) { T.skip.x = skx - 36; T.skip.y = by - bh / 2; T.skip.w = 72; T.skip.h = bh; } else T.skip.w = 0;
    // the line from the card to the spot
    c.globalAlpha = 0.8 * fadeIn;
    c.strokeStyle = H.HUD.gold || "#f2b83c"; c.lineWidth = 2; c.setLineDash([6, 6]);
    const ay = cy > sp.y ? cy : cy + ch;
    c.beginPath(); c.moveTo(Math.max(cx + 20, Math.min(cx + cw - 20, sp.x)), ay); c.lineTo(sp.x, sp.y + (cy > sp.y ? sp.r + 6 : -sp.r - 6)); c.stroke();
    c.setLineDash([]);
    c.restore();
}

// ── input: Next, Skip, Esc, a click away ──
const inRect = (r, x, y) => r.w > 0 && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
let swallowUp = false;
function press(clientX, clientY, e) {
    if (!T.on) return false;
    const x = clientX * T.perCss, y = clientY * T.perCss;
    if (inRect(T.next, x, y)) { go(T.step + 1 >= L.STEPS.length ? -1 : T.step + 1); }
    else if (inRect(T.skip, x, y)) finish();
    else if (touch() && Math.hypot(x - T.spot.x, y - T.spot.y) < T.spot.r) return false;   // the spot itself: let the tap through
    else finish();
    e.preventDefault(); e.stopImmediatePropagation();
    return true;
}
window.addEventListener("mousedown", (e) => { if (press(e.clientX, e.clientY, e)) swallowUp = true; }, true);
window.addEventListener("mouseup", (e) => { if (swallowUp) { swallowUp = false; e.stopImmediatePropagation(); } }, true);
window.addEventListener("touchstart", (e) => { const t = e.changedTouches && e.changedTouches[0]; if (t) press(t.clientX, t.clientY, e); }, { capture: true, passive: false });
window.addEventListener("keydown", (e) => {
    if (!T.on) return;
    if (e.keyCode === 27) { finish(); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.keyCode === 13) { go(T.step + 1 >= L.STEPS.length ? -1 : T.step + 1); e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

// QA: window.dwAbilityIntro("reset") runs it again in the next raid
window.dwAbilityIntro = (cmd) => {
    if (cmd === "reset") { try { store && store.removeItem(L.INTRO_KEY); } catch (e) { /* */ } done = false; T.landedAt = 0; T.firstSeen = 0; }
    return { on: T.on, step: T.step, done };
};
