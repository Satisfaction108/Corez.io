// Upgrade grid paging and the Tier 5 HUD state

const PAGE_DESKTOP = 6;
export const PAGE_TOUCH = 8;
export const COLS_DESKTOP = 3;
export const COLS_TOUCH = 4;

export function pageSize(mobile) { return mobile ? PAGE_TOUCH : PAGE_DESKTOP; }

// the page that shows, clamped: { pages, page, start, end }
export function pageOf(n, size, page) {
    n = Math.max(0, n | 0); size = Math.max(1, size | 0);
    const pages = Math.max(1, Math.ceil(n / size));
    const p = Math.min(pages - 1, Math.max(0, page | 0));
    return { pages, page: p, start: p * size, end: Math.min(n, (p + 1) * size) };
}

// a turn of the page (wheel, arrow, swipe): stops at the first and last page
export function turn(page, pages, dir) {
    pages = Math.max(1, pages | 0);
    return Math.min(pages - 1, Math.max(0, (page | 0) + (dir > 0 ? 1 : dir < 0 ? -1 : 0)));
}

// which gui.upgrades index a choose key (0-based) picks, or -1
export function keyPick(k, n, size, page) {
    const pg = pageOf(n, size, page);
    const i = pg.start + (k | 0);
    return k >= 0 && k < size && i < pg.end ? i : -1;
}

// a new set of options starts on page 0: the key is the list of indexes
export function optionsKey(upgrades) {
    let s = "";
    for (const u of upgrades || []) s += (u && u[2] && u[2].index != null ? u[2].index : "") + ",";
    return s;
}

// Tier 5 from the you-packet ring Tier 4 and not yet earned
export function t5State(you) {
    const t = you && Array.isArray(you.t5) ? you.t5 : null;
    if (!t) return null;
    const tier = t[0] | 0, unlocked = !!t[1], g = (+t[2] || 100) / 100, at = (+t[3] || 200) / 100;
    const progress = Math.max(0, Math.min(1, (g - 1) / Math.max(0.01, at - 1)));
    return { tier, unlocked, growth: g, at, progress, ring: tier === 4 && !unlocked, gold: tier === 4 && unlocked };
}

// "2x", "1.5x"
function fmtX(x) { return (Math.round(x * 100) / 100).toString() + "x"; }
export function ringTitle(st) { return st ? "Grow to " + fmtX(st.at) + " this life to unlock Tier 5" : ""; }
export function ringSub(st) { return st ? "You're " + fmtX(Math.floor(st.growth * 10) / 10) + " now. Score grows you." : ""; }

// ── tile layout (same numbers as app.js drawUpgradeTile) ──
const TILE = { lip: 4, band: 0.25, tank: 0.6, tankAreaFill: 0.86 };

// the tank preview in tile units: { cx, cy, size }
export function tankBox(len, height) {
    const k = len / 100, faceH = height - TILE.lip * k, band = faceH * TILE.band, area = faceH - band;
    const size = Math.min(TILE.tank * len, TILE.tankAreaFill * area);
    return { cx: len / 2, cy: area / 2 + k, size };
}

// ── a tank's whole silhouette (body, guns, turrets), as miscFiles/mockups.js sizes it ──
// The preview's tilt, as arras draws it: the tank's front to the upper right.
export const PREVIEW_TILT = -Math.PI / 4;
const SIDES = 16;
function extentOf(m, byIndex, x, y, ang, s, b, depth) {
    if (!m || depth > 4) return;
    const sh = m.shape;
    const r = typeof sh === "number" && sh >= 3 && sh < SIDES ? s * ((+m.realSize || 1) / (+m.size || 1)) : s;
    const n = typeof sh === "number" && sh >= 3 && sh < SIDES ? Math.floor(sh) : SIDES;
    const off = typeof sh === "number" && n !== SIDES ? (sh % 1) * 2 * Math.PI : 0;
    for (let i = 0; i < n; i++) {
        const t = 2 * Math.PI / n * i + off + ang;
        const px = x + Math.cos(t) * r, py = y + Math.sin(t) * r;
        if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px; if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
    }
    for (const g of m.guns || []) {
        const asp = +g.aspect || 1, w = +g.width || 0, len = +g.length || 0;
        const wd = asp > 0 ? [w * asp / 2, w / 2] : [w / 2, -w * asp / 2];
        const a = (+g.angle || 0) + ang, c = Math.cos(a), sn = Math.sin(a);
        const o = +g.offset || 0, od = (+g.direction || 0) + a;
        const ox = x + o * Math.cos(od) * s, oy = y + o * Math.sin(od) * s;
        for (const [qx, qy] of [[0, wd[1]], [len, wd[0]], [len, -wd[0]], [0, -wd[1]]]) {
            const px = ox + (qx * c - qy * sn) * s, py = oy + (qx * sn + qy * c) * s;
            if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px; if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
        }
    }
    for (const t of m.turrets || []) {
        const f = +t.sizeFactor || 0;
        if (!f) continue;
        const a = ang + (+t.angle || 0), d = (+t.direction || 0) + a, o = (+t.offset || 0) * s;
        // a turret entry carries its own guns; its nested turrets by index
        const sub = (t.guns || t.turrets) ? t : byIndex ? byIndex(t.index) : null;
        extentOf(sub || { shape: 0 }, byIndex, x + o * Math.cos(d), y + o * Math.sin(d), a, s * f, b, depth + 1);
    }
}
// bbox in body radii around the tank's centre, turned by `angle`: { x0, y0, x1, y1 }
export function silhouette(m, angle = 0, byIndex = null) {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    extentOf(m, byIndex, 0, 0, angle, 1, b, 0);
    if (!(b.x1 > b.x0)) return { x0: -1, y0: -1, x1: 1, y1: 1 };
    return b;
}
// where the tank's barrels point (radians, 0 = its own front): the barrel tips summed;
// a balanced spread (Octo, flank rings) keeps its own front
export function frontAngle(m) {
    let sx = 0, sy = 0, sum = 0;
    for (const g of (m && m.guns) || []) {
        const a = +g.angle || 0, o = +g.offset || 0, d = (+g.direction || 0) + a, len = +g.length || 0;
        const tx = o * Math.cos(d) + len * Math.cos(a), ty = o * Math.sin(d) + len * Math.sin(a);
        sx += tx; sy += ty; sum += Math.hypot(tx, ty);
    }
    return sum > 0 && Math.hypot(sx, sy) > 0.35 * sum ? Math.atan2(sy, sx) : 0;
}
// A preview's framing: the whole silhouette in a w x h box with `margin` px all round.
// { angle, scale (px per body radius), x, y (the tank's centre from the box centre) }
export function previewFrame(m, w, h, margin = 0, byIndex = null, maxBody = Infinity) {
    const angle = PREVIEW_TILT - frontAngle(m);
    const b = silhouette(m, angle, byIndex);
    const scale = Math.max(0.1, Math.min((w - 2 * margin) / (b.x1 - b.x0), (h - 2 * margin) / (b.y1 - b.y0), maxBody));
    return { angle, scale, x: -scale * (b.x0 + b.x1) / 2, y: -scale * (b.y0 + b.y1) / 2 };
}
// the choose grid's tank framing in tile units: the face above the name band, a small margin
export function tileFrame(m, len, height, byIndex = null) {
    const k = len / 100, faceH = height - TILE.lip * k, area = faceH - faceH * TILE.band;
    const f = previewFrame(m, len, area, 10 * k, byIndex, 0.25 * len);   // the margin clears the outline and rim
    return { angle: f.angle, scale: f.scale, x: len / 2 + f.x, y: area / 2 + k + f.y };
}

// "RAMS ROCK": a small chip hanging under the name band
export function ramBadge(len, height, textW) {
    const k = len / 100;
    const size = Math.max(6, 8 * k);
    const w = (textW ? textW(size) : size * 5.6) + 8 * k, h = size + 4 * k;
    return { x: (len - w) / 2, y: height - h / 2, w, h, size };
}

// a mockup that digs by ramming: no guns of its own, or the smasher stat set
export function isRamMockup(m) {
    if (!m) return false;
    if (Array.isArray(m.guns) && m.guns.length === 0) return true;
    return !!(m.statnames && m.statnames.reload === "Engine Acceleration");
}

// ── the pager ──
// how many tanks sit on the page `dir` away (0 when there is none)
function sideCount(n, pg, size, dir) {
    if (!pg || pg.pages < 2) return 0;
    const p = pg.page + dir;
    if (p < 0 || p >= pg.pages) return 0;
    const o = pageOf(n, size, p);
    return o.end - o.start;
}
export function nextLabel(n, pg, size) { const m = sideCount(n, pg, size, 1); return m > 0 ? "+" + m + " more  >" : ""; }
export function prevLabel(n, pg, size) { const m = sideCount(n, pg, size, -1); return m > 0 ? "<  +" + m + " more" : ""; }

// The next-page button pulses until every page of these options was seen
export function pagerPulse(seen, pages) {
    if (!(pages > 1)) return false;
    for (let p = 0; p < pages; p++) if (!seen || !seen.has(p)) return true;
    return false;
}

// pager rects around centre cx, top y (UI units): [prev] dots [next]; a side with no label has no button
export function pagerLayout(cx, y, pages, prev, next, labelW, mobile = false) {
    const h = mobile ? 30 : 26, size = mobile ? 15 : 14;
    const dotGap = 13, dotsW = dotGap * pages, gap = 10;
    const bw = (t) => t ? Math.max(mobile ? 120 : 108, (labelW ? labelW(t, size) : t.length * size * 0.6) + 26) : 0;
    const pw = bw(prev), nw = bw(next);
    const total = pw + (pw ? gap : 0) + dotsW + (nw ? gap : 0) + nw;
    const x0 = cx - total / 2;
    const dx = x0 + pw + (pw ? gap : 0);
    return {
        h, size,
        prev: pw ? { x: x0, y, w: pw, h } : null,
        dots: { x: dx, y: y + h / 2, gap: dotGap, w: dotsW },
        next: nw ? { x: dx + dotsW + gap, y, w: nw, h } : null,
        w: total,
    };
}
