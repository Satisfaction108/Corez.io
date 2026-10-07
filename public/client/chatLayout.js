// Chat bubbles over tanks (app.js drawChatMessages / flushChat): word wrap

const BUBBLE_GAP = 4;

function overlaps(x, y, w, h, r) { return x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y; }

// Your own bubble first (pri 0), then lowest first
function lowerFirst(a, b) { return ((a.pri || 0) - (b.pri || 0)) || (b.y - a.y) || (a.id - b.id); }

// in-place insertion sort: a handful of bubbles, no allocation
function sortItems(items, n) {
    for (let i = 1; i < n; i++) {
        const it = items[i];
        let j = i - 1;
        while (j >= 0 && lowerFirst(items[j], it) > 0) { items[j + 1] = items[j]; j--; }
        items[j + 1] = it;
    }
}

// rects: HUD boxes in the same units as the items
export function layoutChat(items, n, rects, o) {
    const gap = o && o.gap != null ? o.gap : BUBBLE_GAP;
    const top = o && o.top != null ? o.top : 0;
    sortItems(items, n);
    for (let i = 0; i < n; i++) {
        const it = items[i];
        const maxShift = o && o.maxShift != null ? o.maxShift : it.h * 1.5;
        const maxSide = o && o.maxSide != null ? o.maxSide : it.w * 0.6;
        const x0 = it.x - it.w / 2;
        let x = x0;
        let y = it.y - it.h;    // top edge
        it.hide = false;
        // step past whatever is in the way until nothing is
        for (let round = 0; round < 12; round++) {
            let moved = false;
            for (let j = 0; j < i; j++) {
                const p = items[j];
                if (p.hide) continue;
                const pl = p.x + p.dx - p.w / 2, py = p.y + p.dy - p.h;
                if (x < pl + p.w + gap && x + it.w + gap > pl && y < py + p.h + gap && y + it.h + gap > py) {
                    const up = y + it.h + gap - py;
                    const right = pl + p.w + gap - x, left = x + it.w + gap - pl;
                    const canR = Math.abs(x + right - x0) <= maxSide, canL = Math.abs(x - left - x0) <= maxSide;
                    const side = canR && (!canL || right <= left) ? right : canL ? -left : 0;
                    if (side && Math.abs(side) < up) x += side;
                    else y -= up;
                    moved = true;
                }
            }
            if (rects) for (let k = 0; k < rects.length; k++) {
                const r = rects[k];
                if (overlaps(x, y, it.w, it.h, r)) { y = r.y - gap - it.h; moved = true; }
            }
            if (!moved) break;
        }
        it.dy = y - (it.y - it.h);
        it.dx = x - x0;
        if (-it.dy > maxShift || y < top) { it.hide = true; it.dy = 0; it.dx = 0; }
    }
}

// Word wrap `text` to `maxW` (measure(str) -> width), at most maxLines lines
export function wrapText(text, maxW, measure, maxLines, out) {
    out = out || [];
    out.length = 0;
    const words = String(text || "").replace(/\s+/g, " ").trim().split(" ");
    let line = "";
    const push = (s) => { out.push(s); return out.length >= maxLines; };
    let cut = false;
    outer:
    for (let wi = 0; wi < words.length; wi++) {
        let w = words[wi];
        if (!w) continue;
        const tryLine = line ? line + " " + w : w;
        if (measure(tryLine) <= maxW) { line = tryLine; continue; }
        if (line) { if (push(line)) { cut = true; break; } line = ""; }
        // a word wider than a line: break it by characters
        while (measure(w) > maxW) {
            let k = w.length - 1;
            while (k > 1 && measure(w.slice(0, k)) > maxW) k--;
            if (push(w.slice(0, k))) { cut = true; break outer; }
            w = w.slice(k);
        }
        line = w;
    }
    if (!cut && line) out.push(line);
    else if (cut) {
        // more text than lines: end the last line in an ellipsis that fits
        let last = out[out.length - 1];
        while (last.length > 1 && measure(last + "…") > maxW) last = last.slice(0, -1);
        out[out.length - 1] = last.replace(/\s+$/, "") + "…";
    }
    return out;
}
