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
// Round 7: a fresh offer waits while you're taking hits (it popped up mid-fight
export const CALM_MS = 3000;
export const MAX_WAIT_MS = 6000;
export function viewFor(st, o) {
    if (!o || !o.key) return "";
    if (o.blocked) return "";
    const waited = st && st.openedAt != null ? o.now - st.openedAt : 0;
    if (waited >= MAX_WAIT_MS) return "cards";
    // a fresh offer comes out only after CALM_MS with no hit taken or dealt,
    // and not while something else holds the middle (o.hold: a callout, a
    // slam, a new crown's card). Once out, it stays; Shift+1/2/3 always work.
    if (!(st && st.shown)) {
        const fight = Math.max(o.hurtAt != null ? o.hurtAt : -1e9, o.dealtAt != null ? o.dealtAt : -1e9);
        if (o.now - fight < CALM_MS) return "";
        if (o.hold) return "";
    }
    return "cards";
}
// the header's words: it is never urgent
export const HEAD_TITLE = "Perk ready";
export const HEAD_NOTE = "Pick one any time";

// ── where the cards go ─────────────────────────────────────────────────
// A row low in the middle: its lower edge sits on `bottom` (just above your
// name and the satchel pills), never higher than `minTop` (under your tank
// and its shield hint), and inside left..right (clear of the stat bars, the
// kit box, the upgrade tiles and the minimap). Short on room it goes
// compact (name and one line); narrow, the cards shrink. All in HUD units.
// Round 8 (owner: "tiny, the text is cut off"): bigger cards with room for the
export const CARD = { w: 300, h: 124, hc: 94, gap: 16, head: 34, minW: 184, fullW: 236 };
export const DESC_SIZE = 13, DESC_LH = 16;
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
    const compact = avail < CARD.h || w < CARD.fullW;
    const h = compact ? CARD.hc : CARD.h;
    const total = w * n + gap * (n - 1);
    const x0 = Math.round(W / 2 - total / 2);
    const y = Math.round(bottom - h);
    const rects = [];
    for (let i = 0; i < n; i++) rects.push({ x: x0 + i * (w + gap), y, w, h });
    const head = { x: x0, y: y - CARD.head + 2, w: total, h: CARD.head - 12 };
    return { rects, compact, head, box: { x: x0, y: head.y, w: total, h: bottom - head.y }, tight: avail < CARD.hc };
}
// A mouse press on a perk card (raidPerks.click): does it pick? The cards sit
export const DWELL_MS = 180;
export const FIRE_GAP_MS = 450;
export function clickPicks(o) {
    if (!o || !o.k) return false;
    if (!(o.now - (o.lastShotAt || -1e9) < FIRE_GAP_MS)) return true;
    return o.over === o.k && o.now - o.overSince >= DWELL_MS;
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

// ── a card's words ─────────────────────────────────────────────────────
// The server names a perk you already hold with the level this pick takes it to
export const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
export function roman(n) { return ROMAN[n | 0] || String(n | 0); }
export function baseName(name) { return String(name || "").replace(/\s+(?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/, ""); }
// the level this pick gives you (a perk held at n goes to n + 1)
export function nextLevel(p) { return Math.max(1, ((p && p.n) | 0) + 1); }
// hover: the whole description and what changes, never cut
export function lastsText(ao) { return ao ? "It lasts for the rest of the day." : "It lasts the whole raid."; }
export function hoverText(p, ao) {
    if (!p) return null;
    const name = baseName(p.name || p.id), lv = nextLevel(p), max = (p.max | 0);
    const have = (p.n | 0);
    const step = have > 0
        ? "You have level " + roman(have) + ". This takes it to " + roman(lv) + (max ? " of " + roman(max) : "") + "."
        : "This is a new perk at level I" + (max > 1 ? " of " + roman(max) + ". Pick it again to stack it." : ".");
    return { title: name + "  " + roman(lv), body: String(p.desc || "").trim() + " " + step + " " + lastsText(ao) };
}

// ── the build strip, beside the satchel ────────────────────────────────
// Little perk chips right-aligned to the satchel pills' left edge (the dash
// and ability chips sit on the right). The first slot is the progress
// badge, or the "Perk ready" chip while an offer waits folded. -> rects,
// left to right, plus the badge / chip rect.
export const STRIP = { s: 26, gap: 4, lead: 18 };
// widths (optional): each chip's own width, for chips that carry a label
export function stripLayout(anchor, n, chipW, minX, widths) {
    if (!anchor) return null;
    const s = STRIP.s, cy = anchor.y + anchor.h / 2, cw = chipW || s;
    const right = anchor.x - STRIP.lead;
    const wOf = (i) => (widths && widths[i] > s ? widths[i] : s);
    let need = cw;
    for (let i = 0; i < n; i++) need += wOf(i) + STRIP.gap;
    const fit = minX == null || right - need >= minX;
    // short on room: plain icons overlap like a fanned hand
    let squeeze = 0;
    if (!fit && n > 0) squeeze = Math.max(0, need - (right - minX)) / n;
    // x walks right to left: the build's last icon sits nearest the satchel
    const icons = [];
    let x = right;
    for (let i = n - 1; i >= 0; i--) {
        const w = wOf(i);
        icons[i] = { x: x - w, y: cy - s / 2, w, h: s };
        x -= Math.max(10, w + STRIP.gap - squeeze);
    }
    const badge = { x: x - cw, y: cy - s / 2, w: cw, h: s };
    return { icons, badge, fit, box: { x: badge.x, y: badge.y, w: right - badge.x, h: s } };
}

// Named chips wrap upward in rows (the newest perk nearest the satchel, the badge
export function stripRows(anchor, widths, chipW, minX, maxRows = 3) {
    if (!anchor) return null;
    const s = STRIP.s, g = STRIP.gap, cy = anchor.y + anchor.h / 2, cw = chipW || s;
    const right = anchor.x - STRIP.lead, lo = minX == null ? -Infinity : minX;
    const icons = [];
    let row = 0, x = right;
    for (let i = widths.length - 1; i >= 0; i--) {
        const w = Math.max(s, widths[i] | 0);
        // the bottom row keeps room for the badge at its left end
        if (x - w < lo + (row === 0 ? cw + g : 0)) {
            if (x === right) return { icons, badge: null, fit: false };    // one chip wider than the room
            row++; x = right;
            if (row >= maxRows) return { icons, badge: null, fit: false };
        }
        icons[i] = { x: x - w, y: cy - s / 2 - row * (s + 8), w, h: s };
        x -= w + g;
    }
    let bx = right;
    for (const r of icons) if (r && r.y === cy - s / 2) bx = Math.min(bx, r.x - g);
    const badge = { x: bx - cw, y: cy - s / 2, w: cw, h: s };
    return { icons, badge, fit: true, rows: row + 1 };
}

// The whole strip, tidy at any size (round 8: "might get overloaded"): mode 2
export const STRIP_ROWS = 2;
export function stripPlan(anchor, full, lvl, chipW, minX, moreW = 34) {
    if (!anchor) return null;
    const n = full.length;
    let lay = stripRows(anchor, full, chipW, minX, STRIP_ROWS);
    let mode = 2;
    if (!lay.fit) { mode = 1; lay = stripRows(anchor, lvl, chipW, minX, 1); }
    if (!lay.fit) lay = stripRows(anchor, lvl, chipW, minX, STRIP_ROWS);
    let more = null, hidden = [];
    if (!lay.fit) {
        mode = 0;
        // keep the newest k (nearest the satchel), the rest go behind "+N"
        for (let k = n - 1; k >= 0; k--) {
            const widths = lvl.slice(n - k);
            // the "+N" chip takes the far (left) end of the top row: lay out with it as the
            const w2 = [moreW].concat(widths);
            const t = stripRows(anchor, w2, chipW, minX, STRIP_ROWS);
            if (!t.fit) continue;
            const icons = new Array(n).fill(null);
            for (let i = 0; i < k; i++) icons[n - k + i] = t.icons[i + 1];
            const m = t.icons[0];
            more = { x: m.x, y: m.y, w: m.w, h: m.h, n: n - k };
            for (let i = 0; i < n - k; i++) hidden.push(i);
            lay = { icons, badge: t.badge, fit: true, rows: t.rows };
            break;
        }
        if (!lay.fit) return null;
    }
    // the box round everything (for the cards' row to keep above it)
    let x0 = lay.badge ? lay.badge.x : anchor.x, y0 = lay.badge ? lay.badge.y : anchor.y, x1 = anchor.x - STRIP.lead, y1 = y0 + STRIP.s;
    for (const r of lay.icons) if (r) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); }
    if (more) { x0 = Math.min(x0, more.x); y0 = Math.min(y0, more.y); }
    return { mode, icons: lay.icons, badge: lay.badge, more, hidden, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
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
export const DEATH_LINE_AO = "Your perks stay until the daily reset.";
export function deathLine(build, ao) { return totalPicks(build) > 0 ? (ao ? DEATH_LINE_AO : DEATH_LINE) : ""; }

// ── the first offer's intro ────────────────────────────────────────────
export const INTRO_TEXT = "You get a perk every 5,000 points. It lasts the whole raid.";
export const INTRO_TEXT_AO = "You get a perk every 5,000 points. It lasts for the rest of the day.";
