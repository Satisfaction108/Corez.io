// Raid perks, the rules: parsing the PK packet, which keys pick a card,
// where the cards, the "Perk ready" chip and the build strip go, and when an
// ignored offer folds away. Pure functions, no DOM or game state, so
// scripts/test/raidPerks.test.js runs them in node. raidPerks.js is the glue
// and the drawing.

// ── the PK packet ──────────────────────────────────────────────────────
// { o: offer cards, q: queued behind it, b: build [{id, n, max}], g: picks
// earned, next: the score of the next one, step, v } -> a clean state.
export function parseState(raw) {
    let d = raw;
    if (typeof raw === "string") { try { d = JSON.parse(raw); } catch (e) { d = null; } }
    if (!d || typeof d !== "object") return null;
    const offer = (Array.isArray(d.o) ? d.o : []).filter(r => r && r.id != null).slice(0, 3).map(r => ({
        id: String(r.id), name: String(r.name || r.id), desc: String(r.desc || ""), icon: String(r.icon || r.id),
        n: Math.max(0, r.n | 0), max: Math.max(0, r.max | 0), kind: String(r.kind || ""),
    }));
    const build = (Array.isArray(d.b) ? d.b : []).filter(r => r && r.id != null && (r.n | 0) > 0)
        .map(r => ({ id: String(r.id), n: r.n | 0, max: Math.max(0, r.max | 0), name: String(r.name || r.id), desc: String(r.desc || "") }));
    return {
        offer: offer.length ? offer : null,
        queued: Math.max(0, d.q | 0),
        build,
        granted: Math.max(0, d.g | 0),
        next: Math.max(0, +d.next || 0),
        step: Math.max(1, +d.step || 5000),
        v: d.v | 0,
    };
}
// a stable key for "is this the same offer as before"
export function offerKey(offer) { return offer ? offer.map(p => p.id + ":" + p.n).join(",") : ""; }
export function totalPicks(build) { let n = 0; for (const p of build || []) n += p.n | 0; return n; }

// ── keys ───────────────────────────────────────────────────────────────
// The number keys 1-0 (and the numpad) upgrade stats, and Y U I H J K pick
// tank upgrades, so a perk card takes Shift + 1, 2 or 3. Plain digits keep
// upgrading stats even while an offer is up. Never while chatting, on a
// held key's repeat, or with Ctrl / Cmd / Alt down. -> card index or -1.
export function perkKeyIndex(e, n, typing) {
    if (!e || !(n > 0) || typing || e.repeat || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return -1;
    const code = String(e.code || "");
    let d = -1;
    const m = /^Digit([1-9])$/.exec(code);
    if (m) d = +m[1];
    else if (!code && e.keyCode >= 49 && e.keyCode <= 57) d = e.keyCode - 48;
    return d >= 1 && d <= Math.min(3, n) ? d - 1 : -1;
}
export const KEY_HINT = "Shift+1 2 3";

// ── when the cards show ────────────────────────────────────────────────
// An offer opens the cards. Left alone for IGNORE_MS they fold into the
// "Perk ready" chip and stay folded until the chip is clicked or a perk key
// is pressed. An offer that was waiting when you died comes back folded:
// nothing jumps in front of a fresh drop.
export const IGNORE_MS = 12000;
// st: { open, openedAt, key, folded }; o: { now, key, fresh (a new offer
// this life), blocked (something else owns the spot: shop, vault, map,
// death, tree) }. -> "cards" | "chip" | ""
// The owner wants no folding and no "Perk ready" chip: an offer shows as
// cards until it's picked (hidden only while the shop, a vault, the map or
// the death card owns the screen), and a queue comes one offer at a time.
export function viewFor(st, o) {
    if (!o || !o.key) return "";
    if (o.blocked) return "";
    return "cards";
}

// ── where the cards go ─────────────────────────────────────────────────
// A row low in the middle: its lower edge sits on `bottom` (just above your
// name and the satchel pills), never higher than `minTop` (under your tank
// and its shield hint), and inside left..right (clear of the stat bars, the
// kit box, the upgrade tiles and the minimap). Short on room it goes
// compact (name and one line); narrow, the cards shrink. All in HUD units.
export const CARD = { w: 228, h: 96, hc: 64, gap: 14, head: 34, minW: 128 };
export function cardLayout(W, n, o) {
    n = Math.max(0, Math.min(3, n | 0));
    if (!n) return { rects: [], compact: false, head: null, box: null, tight: false };
    const opt = o || {};
    const left = opt.left != null ? opt.left : 25, right = opt.right != null ? opt.right : W - 25;
    const bottom = opt.bottom, minTop = opt.minTop != null ? opt.minTop : 0;
    const gap = opt.mobile ? 10 : CARD.gap;
    // always centred on the screen: the room is what fits on both sides of
    // the middle (left and right are lopsided, the kit box vs the minimap),
    // and the cards shrink to it instead of sliding over
    const room = Math.max(0, 2 * Math.min(W / 2 - left, right - W / 2));
    const w = Math.round(Math.max(CARD.minW, Math.min(CARD.w, (room - gap * (n - 1)) / n)));
    const avail = bottom - minTop - CARD.head;
    const compact = avail < CARD.h || w < 170;
    const h = compact ? CARD.hc : CARD.h;
    const total = w * n + gap * (n - 1);
    const x0 = Math.round(W / 2 - total / 2);
    const y = Math.round(bottom - h);
    const rects = [];
    for (let i = 0; i < n; i++) rects.push({ x: x0 + i * (w + gap), y, w, h });
    const head = { x: x0, y: y - CARD.head + 2, w: total, h: CARD.head - 12 };
    return { rects, compact, head, box: { x: x0, y: head.y, w: total, h: bottom - head.y }, tight: avail < CARD.hc };
}
export function rectAt(rects, x, y) {
    for (let i = 0; i < (rects || []).length; i++) {
        const r = rects[i];
        if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
    }
    return -1;
}
export function overlaps(a, b) {
    return !!(a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
}
// The tank's own keep-out: the hull, the spawn shield hint and the mining
// line under it (app.js draws those down to about 165 below the middle).
export function tankFloor(H, tankR) {
    return H / 2 + Math.max(168, (tankR || 0) + 40);
}

// ── the build strip, beside the satchel ────────────────────────────────
// Little perk chips right-aligned to the satchel pills' left edge (the dash
// and ability chips sit on the right). The first slot is the progress
// badge, or the "Perk ready" chip while an offer waits folded. -> rects,
// left to right, plus the badge / chip rect.
export const STRIP = { s: 26, gap: 4, lead: 18 };
export function stripLayout(anchor, n, chipW, minX) {
    if (!anchor) return null;
    const s = STRIP.s, cy = anchor.y + anchor.h / 2, cw = chipW || s;
    const right = anchor.x - STRIP.lead;
    let step = s + STRIP.gap;
    // short on room: the icons overlap like a fanned hand
    if (minX != null && n > 0 && right - n * step - cw < minX) step = Math.max(10, (right - minX - cw) / n);
    // x walks right to left: the build's last icon sits nearest the satchel
    const icons = [];
    let x = right;
    for (let i = n - 1; i >= 0; i--) { icons[i] = { x: x - s, y: cy - s / 2, w: s, h: s }; x -= step; }
    const badge = { x: x - cw, y: cy - s / 2, w: cw, h: s };
    return { icons, badge, box: { x: badge.x, y: badge.y, w: right - badge.x, h: s } };
}

// "7,420 / 10,000" for the badge tooltip
export function fmtNum(n) { return String(Math.max(0, Math.floor(+n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
// how far along to the next pick, 0..1
export function progress(score, next, step) {
    const to = +next || 0, st = +step || 5000;
    if (!(to > 0)) return 0;
    return Math.max(0, Math.min(1, ((+score || 0) - (to - st)) / st));
}

// ── the death card ─────────────────────────────────────────────────────
export const DEATH_LINE = "Your perks stay until the raid ends.";
export function deathLine(build) { return totalPicks(build) > 0 ? DEATH_LINE : ""; }

// ── the first offer's intro ────────────────────────────────────────────
export const INTRO_TEXT = "Every 5,000 points you pick a perk. It lasts until the raid ends.";
