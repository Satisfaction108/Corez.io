// The Crown Contest, the pure bits (no DOM, no canvas): what the tracker,
// the notes and the raid end say. crowns.js draws them; the tests read
// these straight (scripts/test/crownContest.test.js).
//
// RY crowns: { on, sd, done, fz, list: [{ e, n, s, b, f, x, y }] }
//   e entity id, n name, s board points, b bot, f the spot is a FUZZ cell
//   (until sudden death), x/y where.

export const SUDDEN_S = 60;

// the list, best first, or [] when no contest is on
export function rows(c) {
    return c && c.on && Array.isArray(c.list) ? c.list : [];
}
export function mine(c, myId) {
    return rows(c).find(r => r.e === myId) || null;
}

// the nearest crown that isn't yours: {row, d} or null
export function nearest(c, myId, x, y) {
    let best = null, bd = Infinity;
    for (const r of rows(c)) {
        if (r.e === myId) continue;
        const d = Math.hypot(r.x - x, r.y - y);
        if (d < bd) { bd = d; best = r; }
    }
    return best ? { row: best, d: bd } : null;
}

// "640 m" style, rough while the map only knows the area (fuzzy)
export function distText(d, fuzzy, fmtDist) {
    const t = fmtDist ? fmtDist(d) : Math.round(d) + "";
    return fuzzy ? "~" + t : t;
}

// One line for the note stack (a first raid, a phone, or the slim HUD):
// what you should do right now. -> { text, sub, hot }
export function note(c, myId, x, y, fmtDist, stage = 3) {
    const list = rows(c);
    if (!list.length) return null;
    const me = mine(c, myId);
    if (me) {
        if (stage === 0) return { text: "You have a crown", sub: "Don't die!", hot: true };
        return { text: c.sd ? "CROWN · CAN'T BANK" : "YOU HOLD A CROWN", sub: c.sd ? "Survive!" : "Keep it to the bell", hot: true };
    }
    const n = nearest(c, myId, x, y);
    if (!n) return null;
    const dist = distText(n.d, !!n.row.f, fmtDist);
    if (stage === 0) return { text: "Kill a crown to win", sub: dist, hot: false };
    return { text: "NEAREST CROWN " + dist, sub: "", hot: !!c.sd };
}

// the tracker card: the three crowns and a footer. -> { rows, footer }
export function tracker(c, myId, x, y, fmtDist) {
    const list = rows(c).slice(0, 3);
    const me = mine(c, myId);
    let footer = "";
    if (me) footer = c.sd ? "Can't bank. Survive!" : "Keep it to the bell";
    else {
        const n = nearest(c, myId, x, y);
        footer = n ? "Nearest crown " + distText(n.d, !!n.row.f, fmtDist) : "";
    }
    return { rows: list.map((r, i) => ({ k: i + 1, name: r.n || "Someone", score: r.s | 0, bot: !!r.b, me: r.e === myId, id: r.e })), footer };
}

// The raid end's words. place: yours (crown holders are 1-3), win: yours.
// -> { title, sub, col } col: gold | silver | bronze | plain
export function finale(res, place, win, winner, rows) {
    const crowned = !!(res && res.crowns);
    const champ = winner || "Nobody";
    if (!crowned) return null;
    if (win) return { title: "CORE CHAMPION", sub: rows > 1 ? "You took the crown home. #1 of " + rows : "You took the crown home", col: "gold" };
    if (place === 2) return { title: "SILVER CROWN", sub: champ + " is the Core Champion", col: "silver" };
    if (place === 3) return { title: "BRONZE CROWN", sub: champ + " is the Core Champion", col: "bronze" };
    return { title: champ.toUpperCase(), sub: "is the Core Champion", col: "plain", champLine: true };
}

// a feed row from the server (crowns.js) -> { by, name, to, pts, verb } | null
export function feed(f) {
    if (!f || !f.crown) return null;
    if (f.start) return { verb: "start" };
    if (f.sd) return { verb: "sd" };
    if (f.took) return { verb: "took", by: f.by || "Someone", name: f.name || "someone", pts: f.pts | 0 };
    if (f.smash) return { verb: "smash", by: f.by || "Someone", name: f.name || "someone", to: f.to || "", pts: f.pts | 0 };
    if (f.fell) return { verb: "fell", name: f.name || "Someone", to: f.to || "" };
    return null;
}
