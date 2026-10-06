// World labels (chest and crate names, Vault, Shop, outposts) that would
// print over each other get nudged apart: app.js worldLabel queues them while
// the world draws, flushWorldLabels lays them out here and draws them.
//
// Greedy, by priority then distance from the screen centre: each label keeps
// its spot when it is free, else it is nudged just past the label in its way,
// up or down, again past the next one, up to maxNudge times each way, and
// the nearer free spot wins (up on a tie). A spot under a HUD rect is only
// taken when nothing clear of the HUD was found (labelAlpha fades it there).
// A label with no spot clear of other labels stays put, marked `blocked`
// (drawn faint).
//
// No allocations: `items` and `placed` are the caller's reused arrays, each
// item { x, y, w, h, pri, d } (x, y the centre) gets `dy` and `blocked`.
export const MAX_NUDGE = 3;
export const NUDGE_GAP = 2;

function byPriDist(a, b) { return (a.pri - b.pri) || (a.d - b.d); }
function overlaps(x, y, w, h, r) { return x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y; }
// the placed label overlapping the box at centre y (or null)
function blocker(placed, n, x, y, w, h) {
    const top = y - h / 2;
    for (let i = 0; i < n; i++) {
        const p = placed[i];
        const px = p.x - p.w / 2, py = p.y + p.dy - p.h / 2;
        if (x < px + p.w && x + w > px && top < py + p.h && top + h > py) return p;
    }
    return null;
}
function hitsRects(rects, x, y, w, h) {
    if (!rects) return false;
    for (let i = 0; i < rects.length; i++) if (overlaps(x, y, w, h, rects[i])) return true;
    return false;
}
// following the chain of labels in the way, up (dir -1) or down (+1): the
// centre y of the first free spot, or NaN
function chase(placed, n, it, x, dir, maxNudge) {
    let y = it.y;
    for (let k = 0; k <= maxNudge; k++) {
        const p = blocker(placed, n, x, y, it.w, it.h);
        if (!p) return y;
        if (k === maxNudge) break;
        const py = p.y + p.dy;
        y = dir < 0 ? py - p.h / 2 - NUDGE_GAP - it.h / 2 : py + p.h / 2 + NUDGE_GAP + it.h / 2;
    }
    return NaN;
}

export function layoutLabels(items, rects, placed, maxNudge = MAX_NUDGE) {
    items.sort(byPriDist);
    let n = 0;
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const x = it.x - it.w / 2;
        const up = chase(placed, n, it, x, -1, maxNudge), down = chase(placed, n, it, x, 1, maxNudge);
        const okUp = up === up, okDown = down === down;
        const freeUp = okUp && !hitsRects(rects, x, up - it.h / 2, it.w, it.h);
        const freeDown = okDown && !hitsRects(rects, x, down - it.h / 2, it.w, it.h);
        const dUp = okUp ? it.y - up : Infinity, dDown = okDown ? down - it.y : Infinity;
        let y;
        if (freeUp && (!freeDown || dUp <= dDown)) y = up;
        else if (freeDown) y = down;
        else if (okUp && dUp <= dDown) y = up;
        else if (okDown) y = down;
        it.blocked = !okUp && !okDown;
        it.dy = it.blocked ? 0 : y - it.y;
        placed[n++] = it;
    }
    placed.length = n;
    return n;
}
