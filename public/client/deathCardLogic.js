// The raid death card's text block, under the stat tiles: the Points line, the

export const TEXT = {
    top: 12,
    pts: 14, ptsMin: 12, ptsLH: 19,
    gap: 9,           // between the groups
    ex: 12.5, exMin: 11.5, exLH: 17,
    perk: 12.5, perkMin: 11, perkLH: 17, icon: 16, iconGap: 3,
    bottom: 12,
    maxLines: 6,      // per group; past that the size steps down instead
};

export function wrap(text, size, maxW, measure) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
        const t = cur ? cur + " " + w : w;
        if (cur && measure(t, size) > maxW) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
}

// One line at `size`, or a bit smaller down to `min`, else wrapped at the size
export function fitOrWrap(text, size, min, maxW, measure, maxLines = TEXT.maxLines) {
    text = String(text || "");
    if (!text) return { size, lines: [] };
    for (let s = size; s >= min - 1e-9; s -= 0.5) if (measure(text, s) <= maxW) return { size: s, lines: [text] };
    let s = size;
    let lines = wrap(text, s, maxW, measure);
    while (s > 8 && (lines.length > maxLines || lines.some(l => measure(l, s) > maxW))) { s -= 0.5; lines = wrap(text, s, maxW, measure); }
    return { size: s, lines };
}

// o: { pts, ptsHurt, extras: [sentence], sub, perkLine, perkIcons (count), w
export function layoutText(o) {
    const T = TEXT, w = Math.max(60, o.w), m = o.measure;
    const rows = [];
    let y = T.top;
    const put = (kind, f, lh) => {
        for (const ln of f.lines) { rows.push({ kind, text: ln, size: f.size, y: y + lh / 2 }); y += lh; }
    };
    if (o.pts) put("pts", fitOrWrap(o.pts, T.pts, T.ptsMin, w, m), T.ptsLH);
    const ex = (o.extras || []).filter(Boolean);
    const exText = ex.length ? ex.map(s => /[.!?]$/.test(s) ? s : s + ".").join(" ") : (o.sub || "");
    if (exText) {
        y += T.gap;
        put(ex.length ? "ex" : "sub", fitOrWrap(exText, T.ex, T.exMin, w, m), T.exLH);
    }
    if (o.perkLine) {
        y += T.gap;
        const n = Math.max(0, Math.min(10, o.perkIcons | 0));
        const iconsW = n ? n * (T.icon + T.iconGap) + 5 : 0;
        let one = 0;
        for (let s = T.perk; s >= T.perkMin - 1e-9 && !one; s -= 0.5) if (m(o.perkLine, s) <= w - iconsW) one = s;
        if (one) {
            // icons and words on one row
            rows.push({ kind: "perk", text: o.perkLine, size: one, y: y + Math.max(T.perkLH, T.icon + 2) / 2, iconsW });
            y += Math.max(T.perkLH, T.icon + 2);
        } else {
            // a narrow card: the icons on their own row, the words under them
            if (n) { rows.push({ kind: "icons", text: "", size: 0, y: y + (T.icon + 2) / 2, iconsW }); y += T.icon + 6; }
            put("perk", fitOrWrap(o.perkLine, T.perk, T.perkMin, w, m), T.perkLH);
        }
    }
    return { h: Math.ceil(y + T.bottom), rows };
}

export const INTRO = {
    beat: 820,
    calmBeat: 360,
    fade: 320,
    slide: 26,
    slow: 520,
    slowSpeed: 0.38,
};

export function introBeat(calm) { return calm ? INTRO.calmBeat : INTRO.beat; }

export function introK(age, calm) {
    if (!(age === age)) return 1;
    const u = Math.max(0, age) / INTRO.fade;
    const e = u >= 1 ? 1 : 1 - (1 - u) * (1 - u) * (1 - u);
    return 0.4 + 0.6 * e;
}

export function introSlide(k, calm) { return calm ? 0 : (1 - k) * INTRO.slide; }

export function introWarp(age, calm) {
    if (calm || !(age > 0)) return age > 0 ? age : 0;
    const S = INTRO.slow, s = INTRO.slowSpeed;
    if (age >= S) return s * S + (1 - s) * S / 3 + (age - S);
    return s * age + (1 - s) * age * age * age / (3 * S * S);
}
