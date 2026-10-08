// The "Keep my stuff" card on a guest's raid results (raidFinale.js): a
// small DOM card, never a popup. Its button takes the player to the menu,
// where the one-tap account sheet opens (dwAccount.openSignup defers it
// until the game is gone); "Not now" keeps it away for a day. The rules
// for when it shows live in keepNudgeLogic.js.
import { global } from "./global.js";
import * as KL from "./keepNudgeLogic.js";

let el = null, shown = false, offer = null, px = -1, py = -1, lastRaid = 0;
const store = () => { try { return window.localStorage; } catch (e) { return null; } };

// A raid just ended: decide (once per raid) whether this one asks.
// o: { raidId, place, isWin, score, prevBest }
export function noteRaidEnd(o) {
    // the same raid's end again: keep what was decided
    if ((o.raidId | 0) > 0 && (o.raidId | 0) === lastRaid) return offer;
    lastRaid = o.raidId | 0;
    offer = null;
    hide();
    try {
        const a = window.dwAccount;
        const guest = !global.acct && !(a && a.me && a.me()) && !global.tutorialMode && !window.dwEmbed;
        offer = KL.decide(Object.assign({ guest, now: Date.now() }, o), store());
    } catch (e) { offer = null; }
    return offer;
}
export const wanted = () => !!offer;
// the next raid dropped in: the card is gone for good
export function drop() { offer = null; hide(); }
// QA (headless): what the card would say, or force one up
window.dwKeepNudge = (headline) => { if (headline) offer = { headline: String(headline), why: "qa" }; return { offer, shown }; };

function build() {
    if (el) return;
    el = document.createElement("div");
    el.id = "dwKeepNudge";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Keep your progress");
    el.innerHTML = '<div class="kn-h"></div><div class="kn-p">No password needed.</div>' +
        '<div class="kn-row"><button type="button" class="kn-go">Keep my stuff</button><button type="button" class="kn-no">Not now</button></div>';
    // the canvas under it must not see these clicks
    for (const t of ["pointerdown", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu", "wheel"]) {
        el.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    }
    el.querySelector(".kn-go").addEventListener("click", go);
    el.querySelector(".kn-no").addEventListener("click", () => {
        KL.dismiss(store(), Date.now());
        offer = null;
        hide();
    });
    document.body.appendChild(el);
}

let onGo = () => {};
export function setOnGo(fn) { onGo = typeof fn === "function" ? fn : () => {}; }

function sync() {
    build();
    const t = offer ? offer.headline : "";
    const hd = el.querySelector(".kn-h");
    if (hd.textContent !== t) { hd.textContent = t; dims = null; }
}
let dims = null;

function go() {
    const headline = offer ? offer.headline : "";
    offer = null;
    hide();
    // the results put away (raidFinale), then back to the menu, where the
    // sheet opens (the death card's sign-up does the same)
    try { onGo(); } catch (e) { /* */ }
    try { global.exit && global.exit(); } catch (e) { /* */ }
    const open = (a) => a && a.openSignup && a.openSignup({ headline });
    if (window.dwAccount) open(window.dwAccount);
    else if (window.DWFunnel && window.DWFunnel.withAccountUi) window.DWFunnel.withAccountUi(open);
}

// Show it (or move it) with its top-left at x, y in CSS pixels.
export function place(x, y) {
    if (!offer) return hide();
    sync();
    const nx = Math.round(x), ny = Math.round(y);
    if (Math.abs(nx - px) > 2 || Math.abs(ny - py) > 2) {
        px = nx; py = ny;
        el.style.left = nx + "px";
        el.style.top = ny + "px";
    }
    if (!shown) { shown = true; el.classList.add("open"); }
}
// its size in CSS pixels (0 before it is built)
export function size() {
    sync();
    // measured once per headline (and again after a resize), not every frame
    if (!dims || dims.iw !== window.innerWidth) dims = { w: el.offsetWidth, h: el.offsetHeight, iw: window.innerWidth };
    return dims;
}

export function hide() {
    if (!el || !shown) return;
    shown = false;
    px = py = -1;
    el.classList.remove("open");
}
