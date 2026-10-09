// The /tanks page: every tank as one tree (data from scripts/build-tanks.js)
const $ = (id) => document.getElementById(id);
const cv = $("c"), ctx = cv.getContext("2d");
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

let D = null, T = [], pal = {}, sel = -1, need = true;
const view = { x: 0, y: 0, z: 0.2 };
const atlas = { s: null, l: null, lWant: false };
const NAME_PX = 12;
const nameW = new Map();

// theme: saved choice, else the system's
function setTheme(t) {
    document.documentElement.dataset.theme = t;
    $("theme").textContent = t === "dark" ? "Light" : "Dark";
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["bg", "card", "ink", "soft", "line", "lip", "well", "gold", "tile", "tileLip", "wire"]) pal[k] = cs.getPropertyValue("--" + k).trim();
    need = true;
}
setTheme(store.get("dwTanksTheme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("theme").onclick = () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; store.set("dwTanksTheme", t); setTheme(t); };

function img(src) { return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }

// ---- view ------------------------------------------------------------------
function size() {
    const r = cv.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    need = true;
}
function cssW() { return cv.width / Math.min(3, window.devicePixelRatio || 1); }
function cssH() { return cv.height / Math.min(3, window.devicePixelRatio || 1); }
function clampZ(z) { const lo = Math.min(0.08, fitZ() * 0.8); return Math.max(lo, Math.min(4, z)); }
function fitZ() { return D ? Math.min(cssW() / D.w, cssH() / D.h) : 1; }
function fit() { const z = fitZ() * 0.97; view.z = z; view.x = -(cssW() / z - D.w) / 2; view.y = -(cssH() / z - D.h) / 2; need = true; }
function zoomAt(f, sx, sy) {
    const z = clampZ(view.z * f);
    const wx = view.x + sx / view.z, wy = view.y + sy / view.z;
    view.z = z; view.x = wx - sx / z; view.y = wy - sy / z;
    need = true;
}
function flyTo(i, z) {
    const t = T[i];
    view.z = clampZ(z || Math.max(view.z, 1.1));
    view.x = t.x + D.tile / 2 - cssW() / 2 / view.z;
    view.y = t.y + D.tile / 2 - cssH() * (cssW() <= 640 ? 0.25 : 0.5) / view.z;      // phones: above the card
    need = true;
}

// ---- drawing ---------------------------------------------------------------
function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }
function related(i) {
    if (i < 0) return null;
    return new Set([i, ...T[i].parents, ...T[i].kids]);
}
function draw() {
    need = false;
    const dpr = cv.width / cssW(), z = view.z, S = D.tile;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -view.x * z * dpr, -view.y * z * dpr);
    const vx0 = view.x - S, vy0 = view.y - S, vx1 = view.x + cssW() / z + S, vy1 = view.y + cssH() / z + S;
    const vis = (x, y, w, h) => x + w > vx0 && x < vx1 && y + h > vy0 && y < vy1;

    // a card per line
    for (const b of D.blocks) {
        if (!vis(b.x - 40, b.y - 10, b.w + 56, b.h + 26)) continue;
        rr(ctx, b.x - 40, b.y - 8, b.w + 42, b.h + 24, 16);
        ctx.fillStyle = pal.card; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = pal.line; ctx.stroke();
        const br = D.branches[b.b];
        ctx.fillStyle = br.color;
        ctx.beginPath(); ctx.arc(b.x + 2, b.y + 12, 6, 0, Math.PI * 2); ctx.fill();
        ctx.font = '22px "Lilita One", Rubik, sans-serif'; ctx.textBaseline = "middle"; ctx.textAlign = "left";
        ctx.fillStyle = pal.ink; ctx.fillText(br.name, b.x + 14, b.y + 13);
        const w = ctx.measureText(br.name).width;
        ctx.font = "500 13px Rubik, system-ui, sans-serif"; ctx.fillStyle = pal.soft;
        ctx.fillText(b.n + " tanks", b.x + 22 + w, b.y + 14);
        // the tier of each row, down the card's left edge
        ctx.font = '15px "Lilita One", Rubik, sans-serif'; ctx.textAlign = "center";
        for (const [tr, y] of b.t || []) {
            rr(ctx, b.x - 35, y + S / 2 - 11, 28, 22, 7);
            ctx.fillStyle = tr === 5 ? pal.gold : pal.well; ctx.fill();
            ctx.fillStyle = tr === 5 ? pal.bg : pal.ink; ctx.fillText("T" + tr, b.x - 21, y + S / 2 + 1);
        }
    }

    // the tree: every tank to the parent it is laid out under
    const rel = related(sel);
    ctx.lineWidth = Math.max(2, 1.7 / z);
    ctx.strokeStyle = pal.wire;
    ctx.beginPath();
    const trunk = T[0].x + S / 2;
    for (const t of T) {
        if (t.prim < 0) continue;
        const p = T[t.prim], cx = t.x + S / 2, px = p.x + S / 2;
        if (!vis(Math.min(cx, px, trunk) - 4, Math.min(t.y, p.y), Math.abs(cx - px) + 8 + (t.prim === 0 ? Math.abs(px - trunk) : 0), Math.abs(t.y - p.y) + S)) continue;
        if (t.prim === 0) {
            const my = t.y - 58;
            ctx.moveTo(trunk, p.y + S); ctx.lineTo(trunk, my); ctx.lineTo(cx, my); ctx.lineTo(cx, t.y);
        } else if (Math.abs(cx - px) < 1) {
            ctx.moveTo(px, p.y + S); ctx.lineTo(cx, t.y);
        } else {
            const my = p.y + S + (t.y - p.y - S) / 2;
            ctx.moveTo(px, p.y + S); ctx.lineTo(px, my); ctx.lineTo(cx, my); ctx.lineTo(cx, t.y);
        }
    }
    ctx.stroke();
    // the picked tank: every parent and upgrade, straight gold lines
    if (sel >= 0) {
        const s = T[sel];
        ctx.save();
        ctx.lineWidth = Math.max(2.5, 2.4 / z);
        ctx.strokeStyle = pal.gold;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        for (const o of [...s.parents, ...s.kids]) {
            const t = T[o], up = s.parents.includes(o);
            const ax = s.x + S / 2, ay = up ? s.y : s.y + S, bx = t.x + S / 2, by = up ? t.y + S : t.y;
            ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        }
        ctx.stroke();
        ctx.restore();
    }

    // the tiles: the game's upgrade plates (coloured face over a darker lip, a keyline)
    const px = dpr * z * S, big = atlas.l && px > D.atlas.s.cell * 0.8;
    if (!atlas.l && !atlas.lWant && px > D.atlas.s.cell * 0.6) loadLarge();
    const A = big ? atlas.l : atlas.s, cell = big ? D.atlas.l.cell : D.atlas.s.cell, cols = D.atlas.cols;
    const labels = z * S >= 38, kl = S / 100, keyW = Math.max(1.5 * kl, 1 / (dpr * z));
    const pics = [];
    for (let i = 0; i < T.length; i++) {
        const t = T[i];
        if (!vis(t.x, t.y, S, S + 16)) continue;
        const r = t.real >= 0 ? t.real : i, on = r === sel, near = rel && rel.has(r);
        const [face, lip] = (D.tiles && D.tiles[t.col % D.tiles.length]) || [pal.tile, pal.tileLip];
        const lipH = Math.max(3, 4 * kl);
        rr(ctx, t.x, t.y, S, S, 9);
        ctx.fillStyle = lip; ctx.fill();
        rr(ctx, t.x, t.y, S, S - lipH, 9);
        ctx.fillStyle = face; ctx.fill();
        rr(ctx, t.x + 3 * kl, t.y + 3 * kl, S - 6 * kl, Math.max(2, 5 * kl), 2.5 * kl);
        ctx.fillStyle = "rgba(255,255,255,0.13)"; ctx.fill();
        rr(ctx, t.x, t.y, S, S, 9);
        ctx.lineWidth = keyW; ctx.strokeStyle = "rgba(10,8,13,0.92)"; ctx.stroke();
        if (t.tier === 5) { rr(ctx, t.x + 1.5, t.y + 1.5, S - 3, S - 3, 8); ctx.lineWidth = 2; ctx.strokeStyle = pal.gold; ctx.stroke(); }
        if (on || near) { rr(ctx, t.x - 3, t.y - 3, S + 6, S + 6, 11); ctx.lineWidth = on ? 4 : 2.5; ctx.strokeStyle = pal.gold; ctx.stroke(); }
        if (A && t.cell >= 0) pics.push(t);
        else { ctx.beginPath(); ctx.arc(t.x + S / 2, t.y + S / 2 - 1, S * 0.24, 0, Math.PI * 2); ctx.fillStyle = "#3f8cff"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#2c3a55"; ctx.stroke(); }
        if (labels) {
            ctx.font = "700 " + NAME_PX + "px Rubik, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
            let w = nameW.get(t.name); if (w == null) { w = ctx.measureText(t.name).width; nameW.set(t.name, w); }
            const room = 60, k = w > room ? room / w : 1;
            ctx.save(); ctx.translate(t.x + S / 2, t.y + S + 3); if (k < 1) ctx.scale(k, 1);
            ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = pal.bg; ctx.strokeText(t.name, 0, 0);
            ctx.fillStyle = on ? pal.gold : pal.ink; ctx.fillText(t.name, 0, 0);
            ctx.restore();
        }
    }
    // the pictures on whole device pixels, so they stay crisp at any zoom
    if (pics.length) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        const k = dpr * z, side = Math.round((S - 2) * k);
        for (const t of pics) {
            const dx = Math.round((t.x + 1 - view.x) * k), dy = Math.round((t.y - 1.5 - view.y) * k);
            ctx.drawImage(A, (t.cell % cols) * cell, Math.floor(t.cell / cols) * cell, cell, cell, dx, dy, side, side);
        }
        ctx.restore();
    }
}
function loop() { if (need && D) draw(); requestAnimationFrame(loop); }
async function loadLarge() { atlas.lWant = true; atlas.l = await img(D.atlas.l.src); need = true; }

// ---- the info card ---------------------------------------------------------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function spriteOn(e, t, px) {
    if (t.cell < 0) return;
    const cols = D.atlas.cols, rows = Math.ceil((Math.max(...T.map(x => x.cell)) + 1) / cols);
    e.style.backgroundImage = "url(" + D.atlas.s.src + ")";
    e.style.backgroundSize = cols * px + "px " + rows * px + "px";
    e.style.backgroundPosition = -(t.cell % cols) * px + "px " + -Math.floor(t.cell / cols) * px + "px";
}
function chips(list) {
    const box = el("div", "chips");
    for (const i of list) {
        const b = el("button", "chip"); b.type = "button";
        const ic = el("i"); spriteOn(ic, T[i], 28); b.append(ic, T[i].name);
        b.onclick = () => pick(i, true);
        box.append(b);
    }
    return box;
}
function info() {
    const box = $("info");
    box.textContent = "";
    if (sel < 0) { box.classList.remove("open"); return; }
    const t = T[sel];
    const x = el("button", "x", "X"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.onclick = () => pick(-1);
    const pic = el("canvas", "pic"); const dpr = Math.min(3, window.devicePixelRatio || 1);
    pic.width = pic.height = Math.round(112 * dpr);
    const draw = () => {
        const A = atlas.l || atlas.s, c = pic.getContext("2d"), cell = atlas.l ? D.atlas.l.cell : D.atlas.s.cell, cols = D.atlas.cols;
        c.clearRect(0, 0, pic.width, pic.height);
        if (A && t.cell >= 0) c.drawImage(A, (t.cell % cols) * cell, Math.floor(t.cell / cols) * cell, cell, cell, 0, 0, pic.width, pic.height);
    };
    draw();
    if (!atlas.l) { (atlas.lWant ? img(D.atlas.l.src) : loadLarge()).then(draw); }
    const br = t.branch >= 0 ? D.branches[t.branch].name : "";
    box.append(x, pic, el("h2", "", t.name), el("div", "sub", "Tier " + t.tier + (br ? " · " + br + " line" : "")));
    if (t.tier === 5) box.append(el("div", "t5", "Tier 5 unlocks when you grow to 2x size. You lose it when you die."));
    box.append(el("h3", "", "Upgrades from"), t.parents.length ? chips(t.parents) : el("div", "none", "Everyone starts here."));
    box.append(el("h3", "", "Upgrades into"), t.kids.length ? chips(t.kids) : el("div", "none", "Nothing comes after this one. It's the end of the line!"));
    box.classList.add("open");
}
function pick(i, fly) {
    sel = i;
    need = true;
    info();
    try { history.replaceState(null, "", i >= 0 ? "#" + encodeURIComponent(T[i].name) : location.pathname); } catch (e) { /* file:// */ }
    if (fly && i >= 0) flyTo(i);
}

// ---- input -----------------------------------------------------------------
const ptrs = new Map();
let drag = null, pinch = null;
function hit(sx, sy) {
    const wx = view.x + sx / view.z, wy = view.y + sy / view.z, S = D.tile;
    for (let i = 0; i < T.length; i++) { const t = T[i]; if (wx >= t.x && wx <= t.x + S && wy >= t.y && wy <= t.y + S + (view.z * S >= 38 ? 14 : 0)) return t.real >= 0 ? t.real : i; }
    return -1;
}
function local(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, local(e));
    if (ptrs.size === 1) { const [x, y] = local(e); drag = { x, y, vx: view.x, vy: view.y, moved: 0 }; cv.classList.add("drag"); }
    else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: view.z, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }; drag = null; }
});
cv.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, local(e));
    if (pinch && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        zoomAt(pinch.z * d / Math.max(1, pinch.d) / view.z, mx, my);
        view.x -= (mx - pinch.mx) / view.z; view.y -= (my - pinch.my) / view.z;
        pinch.mx = mx; pinch.my = my;
    } else if (drag) {
        const [x, y] = local(e);
        drag.moved = Math.max(drag.moved, Math.hypot(x - drag.x, y - drag.y));
        view.x = drag.vx - (x - drag.x) / view.z; view.y = drag.vy - (y - drag.y) / view.z;
        need = true;
    }
});
function up(e) {
    if (!ptrs.has(e.pointerId)) return;
    if (drag && drag.moved < 6 && ptrs.size === 1) { const [x, y] = local(e); pick(hit(x, y)); }
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) { drag = null; cv.classList.remove("drag"); }
}
cv.addEventListener("pointerup", up);
cv.addEventListener("pointercancel", up);
cv.addEventListener("wheel", (e) => { e.preventDefault(); const [x, y] = local(e); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), x, y); }, { passive: false });
$("zin").onclick = () => zoomAt(1.4, cssW() / 2, cssH() / 2);
$("zout").onclick = () => zoomAt(1 / 1.4, cssW() / 2, cssH() / 2);
$("fit").onclick = fit;
window.addEventListener("resize", () => { size(); });
// in the game the Play button just closes the tree
try { const pl = document.querySelector("a.play"); if (pl && window.parent !== window) pl.addEventListener("click", (e) => { e.preventDefault(); window.parent.postMessage({ dwTanks: "close" }, location.origin); }); } catch (e) { /* */ }
window.addEventListener("keydown", (e) => {
    // in the game (T opens this in a frame): Esc or T closes it; the search box keeps its keys
    const inGame = window.parent !== window, typing = document.activeElement && document.activeElement.tagName === "INPUT";
    if (inGame && !typing && (e.key === "Escape" || e.key === "t" || e.key === "T")) { try { window.parent.postMessage({ dwTanks: "close" }, location.origin); } catch (err) { /* */ } return; }
    if (e.key === "Escape") pick(-1);
});

// search: names that contain what you typed
let hits = [], hi = 0;
function showHits() {
    const ul = $("hits"); ul.textContent = "";
    ul.hidden = !hits.length;
    hits.forEach((i, n) => {
        const li = el("li", n === hi ? "on" : ""); const ic = el("i"); spriteOn(ic, T[i], 28);
        li.append(ic, T[i].name + "  ", el("span", "count", "Tier " + T[i].tier));
        li.onmousedown = (e) => { e.preventDefault(); choose(i); };
        ul.append(li);
    });
}
function choose(i) { $("q").value = T[i].name; hits = []; showHits(); pick(i, true); $("q").blur(); }
$("q").addEventListener("input", () => {
    const q = $("q").value.trim().toLowerCase();
    hits = q ? T.map((t, i) => [t.real >= 0 ? -1 : t.name.toLowerCase().indexOf(q), i]).filter(h => h[0] >= 0).sort((a, b) => a[0] - b[0] || T[a[1]].tier - T[b[1]].tier).slice(0, 8).map(h => h[1]) : [];
    hi = 0; showHits();
});
$("q").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { hi = Math.min(hits.length - 1, hi + 1); showHits(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { hi = Math.max(0, hi - 1); showHits(); e.preventDefault(); }
    else if (e.key === "Enter" && hits.length) choose(hits[hi]);
    else if (e.key === "Escape") { hits = []; showHits(); }
});
$("q").addEventListener("blur", () => setTimeout(() => { hits = []; showHits(); }, 120));

// ---- start -----------------------------------------------------------------
(async () => {
    D = await (await fetch("/tanks/tanks.json", { cache: "no-cache" })).json();
    T = D.tanks.map(([name, tier, branch, parents, kids, cell, x, y, prim, real, col]) => ({ name, tier, branch, parents, kids, cell, x, y, prim, real: real == null ? -1 : real, col: col || 0 }));
    $("count").textContent = D.count + " tanks, 5 tiers";
    size();
    fit();
    const h = decodeURIComponent(location.hash.slice(1));
    const at = h ? T.findIndex(t => t.name === h) : -1;
    if (at >= 0) pick(at, true);
    requestAnimationFrame(loop);
    atlas.s = await img(D.atlas.s.src);
    need = true;
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { nameW.clear(); need = true; });
    window.dwTanks = { view, pick, fit, flyTo, find: (n) => T.findIndex(t => t.name === n), ready: () => !!atlas.s, large: () => !!atlas.l, setTheme, draw: () => draw() };
})();
