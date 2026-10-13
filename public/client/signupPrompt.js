import { global } from "./global.js";
import * as SL from "./signupPromptLogic.js";
import * as keepNudge from "./keepNudge.js";
import { DISMISS_KEY as KEEP_NO_KEY, QUIET_MS as KEEP_QUIET_MS } from "./keepNudgeLogic.js";

const store = () => { try { return window.localStorage; } catch (e) { return null; } };
const S = { diedAt: -1, want: false, life: 0, shown: false, el: null, h: 0, hFor: "", left: "", top: "", text: "", op: "", tf: "" };

function signedIn() {
    const a = window.dwAccount;
    return !!(global.acct || (a && a.me && a.me()));
}
function accountsDown() {
    const a = window.dwAccount;
    return !!(a && a.canSignUp && !a.canSignUp());
}
function keepNudgeQuiet() {
    const st = store();
    if (!st) return false;
    let at = 0;
    try { at = +st.getItem(KEEP_NO_KEY) || 0; } catch (e) { at = 0; }
    return at > 0 && Date.now() - at < KEEP_QUIET_MS;
}

function decideFor(diedAt) {
    S.diedAt = diedAt;
    S.life = SL.lifeMs({ serverSecs: global.finalLifeSecs, diedAt, spawnedAt: global.spawnedAt });
    const guest = !signedIn() && !global.tutorialMode && !window.dwEmbed;
    let blocked = false;
    try { blocked = keepNudge.wanted() || keepNudgeQuiet() || accountsDown(); } catch (e) { blocked = true; }
    S.want = SL.decide({ guest, blocked, lifeMs: S.life, now: Date.now() }, store());
}

function stop(e) { e.stopPropagation(); }
function refocus() {
    try {
        const cv = document.getElementById("gameCanvas");
        if (cv && global.gameStart) cv.focus();
    } catch (e) { }
}

function build() {
    if (S.el) return S.el;
    const el = document.createElement("div");
    el.id = "dwLongLife";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Make an account");
    el.innerHTML = '<div class="ll-txt"><div class="ll-h"></div><div class="ll-p"></div></div>' +
        '<div class="ll-row"><button type="button" class="ll-go">Keep my stuff</button><button type="button" class="ll-no">Not now</button></div>';
    el.querySelector(".ll-h").textContent = SL.TITLE;
    for (const t of ["pointerdown", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu", "wheel", "keydown"]) {
        el.addEventListener(t, stop, { passive: true });
    }
    for (const b of el.querySelectorAll("button")) b.addEventListener("pointerdown", (e) => { if (e.pointerType !== "touch") e.preventDefault(); });
    el.querySelector(".ll-go").addEventListener("click", go);
    el.querySelector(".ll-no").addEventListener("click", () => {
        SL.notNow(store());
        S.want = false;
        hide();
        refocus();
    });
    document.body.appendChild(el);
    S.el = el;
    return el;
}

function go() {
    S.want = false;
    hide();
    try { if (global.exit) global.exit(); } catch (e) { }
    const open = (a) => a && a.openSignup && a.openSignup({ headline: SL.HEADLINE });
    if (window.dwAccount) open(window.dwAccount);
    else if (window.DWFunnel && window.DWFunnel.withAccountUi) window.DWFunnel.withAccountUi(open);
}

function hide() {
    if (!S.shown) return;
    S.shown = false;
    if (S.el) S.el.classList.remove("open");
}

function setText(ms) {
    const t = SL.body(ms);
    if (t === S.text) return;
    S.text = t;
    S.el.querySelector(".ll-p").textContent = t;
    S.hFor = "";
}

function place() {
    const f = global.deathCardFrac;
    if (!f || !(f.w > 0)) return false;
    const iw = window.innerWidth, ih = window.innerHeight;
    const key = S.text + "|" + iw + "x" + ih;
    if (S.hFor !== key) { S.hFor = key; S.h = S.el.offsetHeight || 0; }
    const cardTop = f.y * ih;
    const top = Math.round(Math.max(8 + S.h, cardTop - 10));
    const left = Math.round((f.x + f.w / 2) * iw) + "px";
    const topPx = top + "px";
    if (S.left !== left) { S.left = left; S.el.style.left = left; }
    if (S.top !== topPx) { S.top = topPx; S.el.style.top = topPx; }
    const k = global.deathIntroNow != null ? Math.max(0, Math.min(1, +global.deathIntroNow)) : 1;
    const op = k >= 1 ? "1" : String(Math.round(k * 100) / 100);
    const y = global.deathIntroY | 0;
    const tf = y ? "translate(-50%, calc(-100% + " + y + "px))" : "translate(-50%, -100%)";
    if (S.op !== op) { S.op = op; S.el.style.opacity = op; S.el.style.pointerEvents = k < 0.4 ? "none" : ""; }
    if (S.tf !== tf) { S.tf = tf; S.el.style.transform = tf; }
    return true;
}

export function update(deadShow) {
    if (!deadShow) { hide(); return false; }
    const diedAt = global.royaleDiedAt || 0;
    if (diedAt !== S.diedAt) decideFor(diedAt);
    if (!S.want) { hide(); return false; }
    let stillGuest = true;
    try { stillGuest = !signedIn() && !keepNudge.wanted(); } catch (e) { stillGuest = false; }
    if (!stillGuest) { S.want = false; hide(); return false; }
    build();
    setText(S.life);
    if (!S.shown) {
        S.shown = true;
        S.el.classList.add("open");
        SL.markShown(store(), Date.now());
        S.hFor = "";
    }
    if (!place()) { hide(); return false; }
    return true;
}

window.dwLongLife = {
    backdate(ms) { global.spawnedAt = (global.spawnedAt || performance.now()) - (+ms || 0); return global.spawnedAt; },
    state: () => ({ want: S.want, shown: S.shown, life: S.life, text: S.text, top: S.top, left: S.left, h: S.h }),
};
