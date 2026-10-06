// "Share" on the raid-end result: a 1200x630 card of the raid (place, your
// numbers, the top 3, the mode, corez.io) over a frame of the game view,
// then the system share sheet on phones, the clipboard everywhere else, with
// a download as the fallback and a "Copy text" for the one-liner.
//
// raidFinale.js owns the button's life (show / hide / where) and hands over
// what the card says when it is clicked. Nothing here runs per frame except
// place(), which only touches the DOM when the spot moves.
import { global } from "./global.js";

const CW = 1200, CH = 630;
const INK = "#120e15";
const C = {
    ink: INK, solid: "rgba(43,37,51,0.94)", raised: "#352e3f", well: "rgba(14,11,18,0.6)",
    head: "#fff3d9", text2: "#a597b0", gold: "#f2b83c", goldDk: "#a8750f",
    silver: "#e6e1ee", silverDk: "#8d8799", copper: "#e07b2e", copperDk: "#9e4a14",
    emerald: "#3fcf7a", play: "#4fcf5c", playDk: "#2c8f37", streak: "#ffb347",
};
const TITLE = '"Lilita One", Rubik, Ubuntu, sans-serif';
const LABEL = 'Rubik, Ubuntu, sans-serif';

let logo = null;
function loadLogo() {
    if (logo) return;
    logo = new Image();
    logo.src = "/img/logo.png";
}

// ── the button and its note ──────────────────────────────────────────────
let btn = null, note = null, shown = false, lastX = -1, lastY = -1, getInfo = null, busy = false, noteTimer = 0;
function keepGameFocus() {
    try {
        const cv = document.getElementById("gameCanvas");
        if (cv && global.gameStart) cv.focus({ preventScroll: true });
    } catch (e) { /* */ }
}
// clicks here never reach the game underneath
function swallow(el) {
    for (const t of ["pointerdown", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu", "wheel"]) {
        el.addEventListener(t, (e) => { e.stopPropagation(); if (t === "mousedown") e.preventDefault(); }, { passive: t !== "mousedown" && t !== "contextmenu" });
    }
}
function build() {
    if (btn) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "dwShareBtn";
    btn.className = "dw-btn primary";
    btn.textContent = "Share raid";
    btn.tabIndex = -1;
    swallow(btn);
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        keepGameFocus();
        if (busy || !getInfo) return;
        run(getInfo());
    });
    note = document.createElement("div");
    note.id = "dwShareNote";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    note.innerHTML = '<div class="dws-msg"></div><div class="dws-btns">' +
        '<button type="button" class="dw-btn sm dws-save" tabindex="-1"><svg class="dw-ic" aria-hidden="true"><use href="#i-download"/></svg>Save image</button>' +
        '<button type="button" class="dw-btn sm dws-text" tabindex="-1"><svg class="dw-ic" aria-hidden="true"><use href="#i-copy"/></svg>Copy text</button></div>';
    swallow(note);
    document.body.appendChild(btn);
    document.body.appendChild(note);
}

// raidFinale: show the button with its bottom-right corner at (x, y), in
// GUI units, with `info` giving the card's contents when clicked
export function place(x, y, info) {
    build();
    getInfo = info;
    loadLogo();
    const k = window.innerWidth / Math.max(1, global.screenWidth);
    // whole pixels, and a move under 3 px is ignored, so the button never
    // creeps while the panel under it settles
    const px = Math.round(x * k), py = Math.round(y * k);
    if (!shown || Math.abs(px - lastX) > 2 || Math.abs(py - lastY) > 2) {
        lastX = px; lastY = py;
        // anchored by its bottom-right corner through left/top, so the
        // transform is free for the press (a transform anchor jumped the
        // button a whole width when :active replaced it)
        const w = btn.offsetWidth, h = btn.offsetHeight;
        btn.style.left = (px - w) + "px";
        btn.style.top = (py - h) + "px";
        note.style.left = px + "px";
        note.style.top = (py - h - 8) + "px";
    }
    if (!shown) { shown = true; btn.classList.add("open"); }
}
export function hide() {
    if (!shown) return;
    shown = false;
    getInfo = null;
    btn.classList.remove("open");
    closeNote();
}
function closeNote() {
    if (!note) return;
    clearTimeout(noteTimer);
    note.classList.remove("open");
}
function showNote(msg, blob, text, canSave) {
    const m = note.querySelector(".dws-msg");
    m.textContent = msg;
    const save = note.querySelector(".dws-save"), copy = note.querySelector(".dws-text");
    save.hidden = !canSave;
    save.onclick = (e) => { e.stopPropagation(); keepGameFocus(); download(blob); m.textContent = "Saved"; };
    copy.onclick = (e) => {
        e.stopPropagation();
        keepGameFocus();
        copyText(text).then(ok => { m.textContent = ok ? "Text copied" : text; });
    };
    note.classList.add("open");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(closeNote, 7000);
}

// ── sharing ──────────────────────────────────────────────────────────────
// The PNG is made synchronously, so the click still counts as the user's
// gesture by the time the share sheet or the clipboard asks.
function pngBlob(cv) {
    const url = cv.toDataURL("image/png");
    const bin = atob(url.slice(url.indexOf(",") + 1));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: "image/png" });
}
function fileName() {
    const d = new Date();
    return "corez-raid-" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") +
        "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + ".png";
}
function download(blob) {
    try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName();
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return true;
    } catch (e) { return false; }
}
async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}
export function shareLine(info) {
    // the Crown Contest
    if (info.champ) return "I'm the Core Champion on Corez.io! Most points in the raid. https://corez.io";
    if (info.crownCol && (info.place === 2 || info.place === 3)) return "I held a crown to the end on Corez.io! #" + info.place + (info.rows > 1 ? " of " + info.rows : "") + ". https://corez.io";
    if (info.place === 1) return (info.duos ? "We won a Duos raid on Corez.io!" : "I won a raid on Corez.io!") + " https://corez.io";
    if (info.place > 0) return "I placed #" + info.place + (info.rows > 1 ? " of " + info.rows : "") + " in a " + (info.duos ? "Duos " : "") + "raid on Corez.io! https://corez.io";
    return "I just played a raid on Corez.io! https://corez.io";
}
const touchFirst = () => !!(global.mobile || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches));
async function run(info) {
    busy = true;
    try {
        let blob;
        try { blob = pngBlob(makeCard(info)); } catch (e) { showNote("Couldn't make the image", null, shareLine(info), false); return; }
        const text = shareLine(info);
        window.dwShareLast = blob;      // QA hook: the last card made
        if (touchFirst() && navigator.share && navigator.canShare) {
            let file = null;
            try { file = new File([blob], fileName(), { type: "image/png" }); } catch (e) { /* */ }
            if (file && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], text, title: "Corez.io" });
                    showNote("Shared!", blob, text, true);
                    return;
                } catch (e) {
                    if (e && e.name === "AbortError") return;
                }
            }
        }
        if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
            try {
                await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
                showNote("Copied! Paste it anywhere", blob, text, true);
                return;
            } catch (e) { /* no clipboard permission: save it instead */ }
        }
        showNote(download(blob) ? "Saved" : "Couldn't save the image", blob, text, false);
    } finally {
        busy = false;
    }
}

// ── the card ─────────────────────────────────────────────────────────────
function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}
function plate(c, x, y, w, h, r, fill) {
    rr(c, x, y + 5, w, h, r);
    c.fillStyle = "rgba(0,0,0,0.35)";
    c.fill();
    rr(c, x, y, w, h, r);
    c.fillStyle = fill;
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = INK;
    c.stroke();
}
// chunky title: ink rim, a darker copy dropped under it, the fill on top
function title(c, text, x, y, size, fill, dark, align = "left") {
    c.font = size + "px " + TITLE;
    c.textAlign = align;
    c.textBaseline = "middle";
    c.lineJoin = "round";
    const drop = size * 0.075;
    c.lineWidth = Math.max(4, size * 0.2);
    c.strokeStyle = INK;
    c.strokeText(text, x, y + drop);
    c.strokeText(text, x, y);
    c.fillStyle = dark;
    c.fillText(text, x, y + drop);
    c.fillStyle = fill;
    c.fillText(text, x, y);
}
// a lighter title (no drop), for names and numbers
function word(c, text, x, y, size, fill, align = "left") {
    c.font = size + "px " + TITLE;
    c.textAlign = align;
    c.textBaseline = "middle";
    c.lineJoin = "round";
    c.lineWidth = Math.max(3, size * 0.16);
    c.strokeStyle = INK;
    c.strokeText(text, x, y + size * 0.05);
    c.fillStyle = fill;
    c.fillText(text, x, y + size * 0.05);
}
function label(c, text, x, y, size, fill, align = "left") {
    c.font = "700 " + size + "px " + LABEL;
    c.textAlign = align;
    c.textBaseline = "middle";
    c.fillStyle = fill;
    c.fillText(text, x, y);
}
function fit(c, text, font, size, maxW, min) {
    c.font = size + "px " + font;
    const w = c.measureText(text).width;
    return w <= maxW ? size : Math.max(min, Math.floor(size * maxW / w));
}
function clip(text, max) { text = String(text || "Unnamed"); return text.length > max ? text.slice(0, max - 1) + "…" : text; }
const fmt = (n) => {
    n = Math.round(n || 0);
    return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n.toLocaleString("en-US");
};
const RANK = [null, [C.gold, C.goldDk], [C.silver, C.silverDk], [C.copper, C.copperDk]];

// The game view behind the card: the terrain and entity layers, cropped to
// 1200x630 around the winner (or the middle), a bit closer than the screen.
// raidFinale takes it once, just after the crown lands, so the card shows the
// winner even if the share comes later; a share before that takes it live.
let viewCv = null, viewWin = null, viewOk = false;
export function snapView(fok, fx, fy, fr) {
    const bg = document.getElementById("gameCanvas-background");
    const fg = document.getElementById("gameCanvas-gameplay");
    if (!viewCv) { viewCv = document.createElement("canvas"); viewCv.width = CW; viewCv.height = CH; }
    const c = viewCv.getContext("2d");
    c.fillStyle = "#1e1924";
    c.fillRect(0, 0, CW, CH);
    viewOk = true;
    viewWin = null;
    if (!bg || !bg.width || !bg.height) return;
    const dW = bg.width, dH = bg.height;
    const toDev = dW / Math.max(1, global.screenWidth);
    const sw = Math.min(dW, dH * CW / CH) * 0.86, sh = sw * CH / CW;
    // the winner sits right of centre, clear of the text on the left
    const cx = fok ? fx * toDev : dW / 2, cy = fok ? fy * toDev : dH / 2;
    const sx = Math.max(0, Math.min(dW - sw, cx - sw * 0.68)), sy = Math.max(0, Math.min(dH - sh, cy - sh * 0.52));
    try {
        c.drawImage(bg, sx, sy, sw, sh, 0, 0, CW, CH);
        if (fg && fg.width === dW) c.drawImage(fg, sx, sy, sw, sh, 0, 0, CW, CH);
    } catch (e) { /* */ }
    if (!fok) return;
    const k = CW / sw;
    viewWin = { x: (cx - sx) * k, y: (cy - sy) * k, r: Math.max(14, fr * toDev * k) };
}
export function clearView() { viewOk = false; viewWin = null; }

export function makeCard(info) {
    const cv = document.createElement("canvas");
    cv.width = CW; cv.height = CH;
    const c = cv.getContext("2d");
    if (!viewOk) snapView(info.fok, info.fx, info.fy, info.fr);
    c.drawImage(viewCv, 0, 0);
    const win = viewWin;
    // darken toward the text side, and a little everywhere
    const g = c.createLinearGradient(0, 0, CW, 0);
    g.addColorStop(0, "rgba(14,11,18,0.92)");
    g.addColorStop(0.44, "rgba(14,11,18,0.72)");
    g.addColorStop(0.7, "rgba(14,11,18,0.18)");
    g.addColorStop(1, "rgba(14,11,18,0.35)");
    c.fillStyle = g;
    c.fillRect(0, 0, CW, CH);
    // the crown over the winner, as it landed in the game
    if (win && info.crown) {
        const cs = info.crown, gw = Math.max(80, Math.min(170, win.r * 1.6)), sc = gw / cs.w;
        c.save();
        c.translate(win.x, win.y - win.r - 18);
        c.scale(sc, sc);
        c.drawImage(cs.cv, -cs.ax, -cs.ay);
        c.restore();
    }

    const L = 58;
    // the place
    const place = info.place | 0;
    let big, fill, dark;
    if (info.champ) { big = "CORE CHAMPION"; fill = C.gold; dark = C.goldDk; }
    else if (info.crownCol && (place === 2 || place === 3)) { big = place === 2 ? "SILVER CROWN" : "BRONZE CROWN"; [fill, dark] = RANK[place]; }
    else if (place === 1) { big = "VICTORY"; fill = C.gold; dark = C.goldDk; }
    else if (place > 0) { big = "#" + place; [fill, dark] = RANK[place] || [C.head, "#9a8d78"]; }
    else { big = "RAID OVER"; fill = C.head; dark = "#9a8d78"; }
    const bs = fit(c, big, TITLE, place > 1 && big.length < 4 ? 150 : 124, 560, 40);
    title(c, big, L - 4, 118, bs, fill, dark);
    const sub = info.champ ? "Most points" + (info.rows > 1 ? ". #1 of " + info.rows : "")
        : info.crownCol && (place === 2 || place === 3) ? "Held a crown to the bell. #" + place + (info.rows > 1 ? " of " + info.rows : "")
        : place === 1 ? (info.duos ? "Won a Duos raid" : "Won the raid") + (info.rows > 1 ? " out of " + info.rows : "")
        : place > 0 ? "Placed #" + place + (info.rows > 1 ? " of " + info.rows : "") + " in a " + (info.duos ? "Duos" : "Solo") + " raid"
        : "A " + (info.duos ? "Duos" : "Solo") + " raid";
    word(c, sub, L, 200, fit(c, sub, TITLE, 32, 540, 18), C.head);
    // the name
    const name = clip(info.name, 22);
    word(c, name, L, 256, fit(c, name, TITLE, 46, 540, 22), C.gold);

    // the numbers
    const cells = [["POINTS", fmt(info.score), C.gold], ["KILLS", fmt(info.kills), C.head], ["BANKED", fmt(info.banked), C.emerald]];
    const cw = 170, ch = 104, cy = 304;
    for (let i = 0; i < 3; i++) {
        const x = L + i * (cw + 12);
        plate(c, x, cy, cw, ch, 14, C.solid);
        label(c, cells[i][0], x + cw / 2, cy + 26, 15, C.text2, "center");
        word(c, cells[i][1], x + cw / 2, cy + 66, fit(c, cells[i][1], TITLE, 42, cw - 20, 18), cells[i][2], "center");
    }

    // the top 3
    const tx = L, ty = 436, tw = 534, rowH = 44;
    const rows = info.top || [];
    const n = Math.max(1, Math.min(3, rows.length));
    plate(c, tx, ty, tw, 34 + n * rowH, 14, C.solid);
    word(c, info.duos ? "Top teams" : "Top 3", tx + 18, ty + 22, 22, C.gold);
    label(c, info.duos ? "Duos" : "Solo", tx + tw - 18, ty + 22, 15, C.text2, "right");
    for (let i = 0; i < n; i++) {
        const row = rows[i], y = ty + 34 + i * rowH + rowH / 2 - 2;
        const [col, dk] = RANK[i + 1];
        title(c, String(i + 1), tx + 34, y, 30, col, dk, "center");
        if (!row) { label(c, "Nobody", tx + 64, y, 17, C.text2); continue; }
        const mine = place === i + 1;
        const nm = clip(row.name, info.duos ? 30 : 22);
        word(c, nm, tx + 64, y, fit(c, nm, TITLE, 24, 300, 14), mine ? C.gold : C.head);
        word(c, fmt(row.score), tx + tw - 18, y, 24, C.head, "right");
    }

    // corez.io, bottom right, where the eye ends up
    const url = "corez.io";
    c.font = "40px " + TITLE;
    const uw = c.measureText(url).width;
    const hasLogo = !!(logo && logo.complete && logo.naturalWidth);
    const pw = uw + (hasLogo ? 96 : 44), ph = 70, px = CW - pw - 34, py = CH - ph - 30;
    plate(c, px, py, pw, ph, ph / 2, C.play);
    rr(c, px + 3, py + ph - 13, pw - 6, 10, 5);
    c.fillStyle = C.playDk;
    c.fill();
    if (hasLogo) {
        c.save();
        c.translate(px + 44, py + ph / 2 - 2);
        c.rotate(-0.14);
        c.drawImage(logo, -30, -30, 60, 60);
        c.restore();
    }
    word(c, url, px + (hasLogo ? 80 : 22), py + ph / 2 - 4, 40, "#ffffff");
    // the mode, top right
    const mode = info.duos ? "DUOS" : "SOLO";
    c.font = "24px " + TITLE;
    const mw = c.measureText(mode).width + 36;
    plate(c, CW - mw - 34, 30, mw, 44, 22, C.raised);
    word(c, mode, CW - mw / 2 - 34, 52, 24, C.head, "center");
    // the frame: an ink border with a thin warm line inside it
    c.lineWidth = 12;
    c.strokeStyle = INK;
    rr(c, 6, 6, CW - 12, CH - 12, 22);
    c.stroke();
    c.lineWidth = 2;
    c.strokeStyle = "rgba(242,184,60,0.55)";
    rr(c, 14, 14, CW - 28, CH - 28, 16);
    c.stroke();
    return cv;
}
