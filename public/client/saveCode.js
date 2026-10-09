// Save & leave (server: game/terrain/saveCodes.js).
//
// L (Settings > Keybinds, KEY_SAVE) or the Save & leave button in the
// settings panel (the gear, on phones too) asks the server to start a save.
// The tank has to stay still for 20 seconds while the ring at the top counts
// down; moving, shooting or getting hit stops it. When it finishes the
// server sends the code and takes the tank out, and the menu shows the code
// with a Copy button. Next time, "$restore CODE" in chat brings it back.
//
// window.dwSave: toggle(), onPacket(obj) (SVS), onSavedClose() (close 4003),
// state() for QA.

import { global } from "./global.js";
import { modal, h, copyText, toast, icon } from "./account/ui.js";

const RING_R = 17;
const RING_C = 2 * Math.PI * RING_R;

const st = { saving: false, until: 0, ms: 20000, done: null, exited: false, bar: null, row: null };

function keyText() {
    const el = document.querySelector('#controlSettings b[data-key="KEY_SAVE"]');
    return (el && el.textContent && el.textContent !== '·') ? el.textContent : "L";
}

function inRaid() {
    return !!(global.gameStart && !global.disconnected && !global.tutorialMode && global.royale && global.royale.at > 0);
}

function say(text, ms = 4000) {
    try { global.createMessage(text, ms); } catch (e) { /* */ }
}

function bar() {
    if (st.bar) return st.bar;
    const el = document.createElement("div");
    el.id = "dwSaveBar";
    el.setAttribute("role", "status");
    el.innerHTML =
        '<svg class="sv-ring" viewBox="0 0 40 40" aria-hidden="true">' +
        '<circle class="sv-ring-bg" cx="20" cy="20" r="' + RING_R + '"/>' +
        '<circle class="sv-ring-fg" cx="20" cy="20" r="' + RING_R + '" stroke-dasharray="' + RING_C.toFixed(2) + '"/>' +
        '<text class="sv-ring-n" x="20" y="25" text-anchor="middle">20</text></svg>' +
        '<div class="sv-txt"><b>Saving, please stay still</b><span class="sv-sub"></span></div>';
    document.body.appendChild(el);
    st.bar = el;
    return el;
}

function paint() {
    if (!st.saving) return;
    const el = bar();
    const left = Math.max(0, st.until - performance.now());
    const sec = Math.ceil(left / 1000);
    const frac = st.ms > 0 ? left / st.ms : 0;
    const fg = el.querySelector(".sv-ring-fg");
    fg.setAttribute("stroke-dashoffset", (RING_C * (1 - frac)).toFixed(2));
    const n = el.querySelector(".sv-ring-n");
    if (n.textContent !== String(sec)) n.textContent = String(sec);
    const b = el.querySelector(".sv-txt b");
    const want = "Saving, please stay still (" + sec + "s)";
    if (b.textContent !== want) b.textContent = want;
    const sub = el.querySelector(".sv-sub");
    const subTxt = global.mobile ? "Moving, shooting or getting hit cancels it." : "Moving, shooting or getting hit cancels it. Press " + keyText() + " to stop.";
    if (sub.textContent !== subTxt) sub.textContent = subTxt;
}

function showBar(on) {
    const el = bar();
    el.classList.toggle("show", !!on);
}

function toggle() {
    const sock = global.socket;
    if (!inRaid() || global.died || !sock || !sock.talk) {
        if (global.gameStart && !global.tutorialMode) say("You can only save while you're alive in a raid.");
        return false;
    }
    sock.talk("SV", st.saving ? 0 : 1);
    return true;
}

function onPacket(d) {
    if (!d || typeof d !== "object") return;
    if (d.st === "on") {
        st.saving = true;
        st.ms = Math.max(1000, +d.ms || 20000);
        st.until = performance.now() + Math.max(0, +d.left || 0);
        showBar(true);
        paint();
    } else if (d.st === "off") {
        st.saving = false;
        showBar(false);
        if (d.why) say(String(d.why), 4500);
    } else if (d.st === "done" && typeof d.code === "string") {
        st.saving = false;
        showBar(false);
        st.done = { code: d.code, exp: +d.exp || 0, mode: d.mode === "duo" ? "duo" : "solo" };
        savedExit();
    }
}

// The server closes with 4003 right after the code. If the code packet
// somehow got lost there is nothing to show, only a note.
function onSavedClose() {
    if (st.exited) return;
    savedExit();
}

function savedExit() {
    if (st.exited) return;
    st.exited = true;
    global.noAutoReconnect = true;
    global.autoReconnect = null;
    try { global.exit(); } catch (e) { /* */ }
    global.message = "";
    const d = st.done;
    if (d) setTimeout(() => showCode(d), 250);
    else toast("Your tank was saved, but the code got lost. Sorry about that!", { kind: "error", duration: 9000 });
}

function fmtDay(ms) {
    try { return new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); } catch (e) { return ""; }
}

function showCode(d) {
    const line = "$restore " + d.code;
    const copyBtn = h("button", { type: "button", class: "dw-btn accent-fill" }, icon("copy"), h("span", { text: "Copy" }));
    copyBtn.onclick = async () => {
        const ok = await copyText(line);
        copyBtn.lastChild.textContent = ok ? "Copied" : "Didn't copy";
        setTimeout(() => { copyBtn.lastChild.textContent = "Copy"; }, 1800);
    };
    const mode = d.mode === "duo" ? "Duos" : "Solo";
    const body = h("div", { class: "sv-modal" },
        h("div", { class: "sv-code", tabindex: "0", text: d.code }),
        h("p", { class: "sv-how" }, "Type ", h("b", { text: "$restore " + d.code }), " in chat next time you play."),
        h("p", { class: "sv-note", text: "It works once, in a " + mode + " raid while you're alive, and it's good until " + fmtDay(d.exp) + ". Don't share it, because anyone who has it can use it." }),
        h("div", { class: "dw-modal-actions" },
            copyBtn,
            h("button", { type: "button", class: "dw-btn", "data-autofocus": "", text: "Done", onclick: () => m.close() })));
    const m = modal({ title: "Saved! See you later", message: "This code holds your tank, build, satchel, kit and raid points. Your bank is saved either way.", body, dismissable: false, cls: "sv-modal-card" });
}

// the settings panel's button (desktop and phones)
function wireRow() {
    const btn = document.getElementById("spSaveBtn");
    const row = document.getElementById("spSaveRow");
    if (!btn || !row || btn._wired) return;
    btn._wired = true;
    st.row = row;
    btn.addEventListener("click", () => {
        const panel = document.getElementById("homeSettingsPanel");
        const overlay = document.getElementById("homeSettingsOverlay");
        if (panel) panel.classList.remove("open");
        if (overlay) overlay.classList.remove("visible");
        btn.blur();
        const cv = document.getElementById("gameCanvas");
        if (cv && global.gameStart) cv.focus();
        toggle();
    });
}

setInterval(() => {
    wireRow();
    if (st.row) {
        const show = inRaid() && !global.died;
        if (st.row._shown !== show) { st.row._shown = show; st.row.style.display = show ? "" : "none"; }
        const lab = document.getElementById("spSaveKey");
        if (lab && !global.mobile) { const k = keyText(); if (lab.textContent !== k) lab.textContent = k; }
        const btnTxt = document.getElementById("spSaveBtnTxt");
        if (btnTxt) { const t = st.saving ? "Stop saving" : "Save & leave"; if (btnTxt.textContent !== t) btnTxt.textContent = t; }
    }
    if (st.saving) {
        // died, left, or the game went away without an 'off'
        if (!inRaid() || global.died) { st.saving = false; showBar(false); }
        else paint();
    }
}, 100);

// reset(): app.js startGame, so a new game after a save starts clean
const api = {
    toggle, onPacket, onSavedClose,
    reset() { st.saving = false; st.done = null; st.exited = false; if (st.bar) showBar(false); },
    state: () => ({ saving: st.saving, left: Math.max(0, st.until - performance.now()), done: st.done, exited: st.exited }),
};
// local servers only: show the code card or the countdown without a raid (QA)
if (/^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost|.+\.test)$/.test(location.hostname)) {
    api._showCode = (d) => showCode(Object.assign({ code: "ABCDE-FGHJK-MNPQR-STVWX-YZ012", exp: Date.now() + 7 * 864e5, mode: "solo" }, d || {}));
    api._showBar = (leftMs = 17000) => { st.ms = 20000; st.until = performance.now() + leftMs; st.saving = true; showBar(true); paint(); st.saving = false; };
}
window.dwSave = api;
export default api;
