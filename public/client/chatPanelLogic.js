// The raid chat panel's model (drawn under the standings by app.js
// drawChatPanel). No DOM, no canvas: the history, which lines show and how
// faded, wrapping, and a readable name colour. socketinit.js pushes every
// 'CH' line (everyone in the raid) and every duo 'TC' line (team) here.

export const CHAT_HISTORY = 40;      // lines kept
export const CHAT_SHOW = 7;          // lines shown (desktop)
export const CHAT_SHOW_TOUCH = 2;
export const CHAT_FADE_MS = 25000;   // a line stays up this long...
export const CHAT_FADE_OUT_MS = 2500;   // ...then fades out over this
export const NAME_MAX = 16;          // characters of a name before the "…"
export const MSG_LINES = 3;          // wrapped lines per message at most
export const CHAT_MAX_LEN = 56;      // what the server lets a player say

export function createLog(cap = CHAT_HISTORY) {
    return { list: [], cap, seq: 0, rev: 0 };
}

// The one log the game uses (a module singleton, so socketinit and app.js
// share it without app.js top-level state).
export const chatLog = createLog();

// m: { id, sid (sender body id), name, color (raw, resolved at draw), text, team, mine }
// -> the stored line, or null for a duplicate / an empty one
export function pushMessage(log, m, now) {
    const text = String((m && m.text) || "").trim();
    if (!text) return null;
    const id = m.id != null ? m.id : -(++log.seq);
    if (m.id != null) for (let i = log.list.length - 1; i >= 0 && i >= log.list.length - 20; i--) if (log.list[i].id === id) return null;
    const line = {
        id, sid: m.sid | 0, name: String(m.name || "Unnamed"), color: m.color || "",
        text, team: !!m.team, mine: !!m.mine, at: now,
    };
    log.list.push(line);
    while (log.list.length > log.cap) log.list.shift();
    log.rev++;
    return line;
}

export function clearLog(log) {
    log.list.length = 0;
    log.rev++;
}

// How opaque a line is: 1 for CHAT_FADE_MS, then out over CHAT_FADE_OUT_MS
export function lineAlpha(age, open) {
    if (open) return 1;
    if (age < CHAT_FADE_MS) return 1;
    return Math.max(0, 1 - (age - CHAT_FADE_MS) / CHAT_FADE_OUT_MS);
}

// The lines to draw, oldest first (newest at the bottom): the last `max`.
// Closed, only the ones still up; open (typing), the recent history in full.
export function visibleLines(log, now, open, max = CHAT_SHOW, out = []) {
    out.length = 0;
    const L = log.list;
    for (let i = L.length - 1; i >= 0 && out.length < max; i--) {
        const a = lineAlpha(now - L[i].at, open);
        if (a <= 0) break;   // older lines are older still
        out.push({ line: L[i], a });
    }
    out.reverse();
    return out;
}

export function shortName(name, max = NAME_MAX) {
    const s = String(name || "Unnamed").trim() || "Unnamed";
    const ch = Array.from(s);
    return ch.length > max ? ch.slice(0, max - 1).join("") + "…" : s;
}

// Wrap `text` to lines of maxW; the first line starts `indent` in (after the
// name). A word wider than a line breaks by characters. More than maxLines:
// the last line ends in "…". measure(str) -> width.
export function wrapMessage(text, indent, maxW, measure, maxLines = MSG_LINES) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    const room = () => (lines.length ? maxW : maxW - indent);
    const push = () => { lines.push(cur); cur = ""; };
    for (let w of words) {
        const t = cur ? cur + " " + w : w;
        if (measure(t) <= room()) { cur = t; continue; }
        if (cur) push();
        // beside the name there's no room for it: the text starts on the next line
        else if (!lines.length && (measure(w) <= maxW || measure(Array.from(w)[0]) > room())) push();
        // too long for a whole line on its own: break it by characters
        while (measure(w) > room()) {
            const ch = Array.from(w);
            let n = 1;
            while (n < ch.length && measure(ch.slice(0, n + 1).join("")) <= room()) n++;
            cur = ch.slice(0, n).join("");
            push();
            w = ch.slice(n).join("");
        }
        cur = w;
    }
    if (cur || !lines.length) lines.push(cur);
    if (lines.length > maxLines) {
        lines.length = maxLines;
        let last = lines[maxLines - 1];
        const r = maxLines === 1 ? maxW - indent : maxW;
        while (last && measure(last + "…") > r) last = Array.from(last).slice(0, -1).join("");
        lines[maxLines - 1] = last.replace(/\s+$/, "") + "…";
    }
    return lines;
}

// ── colour ─────────────────────────────────────────────────────────────
export function parseHex(c) {
    if (typeof c !== "string") return null;
    let m = /^#([0-9a-f]{3})$/i.exec(c.trim());
    if (m) return [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16));
    m = /^#([0-9a-f]{6})$/i.exec(c.trim());
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    return null;
}
function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
export function luminance(rgb) { return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]); }
const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");

// A name colour that reads on the dark panel: the body colour, mixed toward
// white just enough when it is too dark. Not a colour at all: the fallback.
export const MIN_LUM = 0.2;
export function readableColor(c, fallback = "#e9e0cc") {
    const rgb = parseHex(c);
    if (!rgb) return fallback;
    let out = rgb;
    if (luminance(rgb) < MIN_LUM) {
        let lo = 0, hi = 1;
        for (let i = 0; i < 12; i++) {
            const t = (lo + hi) / 2;
            const mix = rgb.map(v => v + (255 - v) * t);
            if (luminance(mix) < MIN_LUM) lo = t; else hi = t;
        }
        out = rgb.map(v => v + (255 - v) * hi);
    }
    return "#" + out.map(hex2).join("");
}
