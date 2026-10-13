// The Crown Contest, the pure bits (no DOM, no canvas): what the tracker,
// the notes and the raid end say. crowns.js draws them; the tests read
// these straight (scripts/test/crownContest.test.js).
//
// RY crowns: { on, sd, done, fz, pps, bell, steal, list: [{ e, n, s, p, b, f, x

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

const num = (n) => (n | 0).toLocaleString("en-US");
export const pps = (c) => (c && c.pps) | 0 || 5;

// "640 m" style, rough while the map only knows the area (fuzzy)
export function distText(d, fuzzy, fmtDist) {
    const t = fmtDist ? fmtDist(d) : Math.round(d) + "m";
    return fuzzy ? "~" + t : t;
}

// One line for the note stack (a first raid, a phone, or the slim HUD):
// what you should do right now. -> { text, sub, hot }
export function note(c, myId, x, y, fmtDist, stage = 3) {
    const list = rows(c);
    if (!list.length) return null;
    const me = mine(c, myId);
    if (me) {
        const sub = (me.p | 0) > 0 ? "+" + num(me.p) + " so far" : "";
        if (stage === 0) return { text: "Your crown: +" + pps(c) + " pts/sec", sub: "Don't die!", hot: true };
        return { text: "CROWN +" + pps(c) + " PTS/SEC" + (c.sd ? " · NO HIDING" : ""), sub, hot: true };
    }
    const n = nearest(c, myId, x, y);
    if (!n) return null;
    const dist = distText(n.d, !!n.row.f, fmtDist);
    if (stage === 0) return { text: "Kill a crown holder to steal points", sub: dist, hot: false };
    return { text: "NEAREST CROWN " + dist, sub: "", hot: !!c.sd };
}

// The tracker card: the points race with the crowns marked, since the most points
export function tracker(c, myId, x, y, fmtDist, board) {
    const list = rows(c);
    const me = mine(c, myId);
    const crownRank = new Map(list.slice(0, 3).map((r, i) => [r.e, i + 1]));
    let out;
    if (Array.isArray(board) && board.length) {
        const pick = [], seen = new Set();
        const add = (r) => { if (r && !seen.has(r.id)) { seen.add(r.id); pick.push(r); } };
        board.slice(0, 3).forEach(add);
        for (const r of board) if (crownRank.has(r.id)) add(r);
        add(board.find(r => r.id === myId && !r.bot));
        out = pick.sort((a, b) => (a.place | 0) - (b.place | 0)).slice(0, 7).map(r => ({
            k: r.place | 0, name: r.name || "Someone", score: r.score | 0, crown: crownRank.get(r.id) || 0, bot: !!r.bot, me: r.id === myId, id: r.id,
        }));
    } else {
        out = list.slice(0, 3).map((r, i) => ({ k: 0, name: r.n || "Someone", score: r.s | 0, crown: i + 1, bot: !!r.b, me: r.e === myId, id: r.e }));
    }
    let footer = "", footer2 = "";
    if (me) footer = "Your crown: +" + pps(c) + " pts/sec" + (c.sd ? ", the vault won't hide you" : "");
    else {
        // plain words (round 7: "Steal one: nearest crown ~2.1k" read as -2.1k)
        const n = nearest(c, myId, x, y);
        if (n) {
            footer = "Nearest crown: " + (n.row.f ? "about " : "") + (fmtDist ? fmtDist(n.d) : Math.round(n.d) + "m") + " away";
            footer2 = "Kill the holder to steal it";
        }
    }
    return { rows: out, footer, footer2 };
}

// The raid end's words
export function finale(res, place, win, winner, rows, score) {
    const crowned = !!(res && res.crowns);
    const champ = winner || "Nobody";
    if (!crowned) return null;
    const pts = score == null && res && res.champ ? res.champ.score : score;
    const withPts = (pts | 0) > 0 ? " with " + num(pts) + " pts" : "";
    if (win) return { title: "CORE CHAMPION", sub: "Most points" + ((pts | 0) > 0 ? " (" + num(pts) + ")" : "") + (rows > 1 ? ", #1 of " + rows : ""), col: "gold" };
    const rest = " won" + withPts;
    if (place === 2) return { title: "#2", sub: champ + rest, rest, col: "silver" };
    if (place === 3) return { title: "#3", sub: champ + rest, rest, col: "bronze" };
    return { title: champ.toUpperCase(), sub: "is the Core Champion" + withPts, col: "plain", champLine: true };
}

// the podium's crown line for a top row: "+1,240 from crowns" or ""
export function crownLine(row) {
    const n = row ? row.cb | 0 : 0;
    return n > 0 ? "+" + num(n) + " from crowns" : "";
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

// How the crown on you got there (RY you.crown how / from), as a slam and as the
export function howLine(crown) {
    const c = crown || {};
    const from = String(c.from || "").slice(0, 16);
    switch (c.how) {
        case "top3": return { title: "YOU GOT A CROWN", sub: "You're top 3 on points.", card: "CROWN: YOU'RE TOP 3" };
        case "steal": return { title: "CROWN STOLEN", sub: "You took " + (from || "their") + (from ? "'s" : "") + " crown.", card: "CROWN: TAKEN" + (from ? " FROM " + from.toUpperCase() : "") };
        case "fell": return { title: "A CROWN FELL TO YOU", sub: "Its holder" + (from ? " " + from : "") + " died.", card: "CROWN: IT FELL TO YOU" };
        case "event": return { title: "YOU GOT A CROWN", sub: "You placed top 3 in " + (from || "the event") + ".", card: "CROWN: YOU WON IT" };
        case "left": return { title: "A CROWN FELL TO YOU", sub: "Its holder" + (from ? " " + from : "") + " left the raid.", card: "CROWN: IT FELL TO YOU" };
        default: return { title: "YOU GOT A CROWN", sub: "A crown was free, and you were next in line.", card: "CROWN: IT WAS FREE" };
    }
}
