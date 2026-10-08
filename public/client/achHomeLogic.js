// Achievements finished in a raid, replayed on the home screen (the rules;
// account/achHome.js draws them). Pure: the caller hands in a Storage
// (localStorage), so scripts/test/achHome.test.js runs it in node.
//
// achievementCard.js notes every unlock from the ACH packet here; when the
// player is back on the menu, take() hands them over once and remembers
// their ids, so a card never plays twice.

export const PENDING_KEY = "dwAchHome_v1";      // waiting for the home screen
export const SEEN_KEY = "dwAchHomeSeen_v1";     // ids already played
export const PENDING_MAX = 24;
export const SEEN_MAX = 300;
export const SHOW_MAX = 5;                      // more than this: the rest fold into one "+N more" card
export const CARD_MS = 1900;                    // one card, start to finish
export const CARD_FAST_MS = 1500;               // ...when three or more are queued
export const GUEST_LAST_MS = 3600;              // a guest's last card waits on its button a little

function readList(st, k) {
    try {
        const v = JSON.parse(st.getItem(k) || "[]");
        return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
}
function writeList(st, k, v) {
    try { st.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ }
}
const clean = (s, n) => String(s == null ? "" : s).slice(0, n);

// One unlock (the ACH packet's object). Ignored once played or already waiting.
export function note(st, d) {
    if (!st || !d || !d.id || d.summary) return false;
    const id = clean(d.id, 48);
    if (readList(st, SEEN_KEY).indexOf(id) >= 0) return false;
    const list = readList(st, PENDING_KEY);
    if (list.some((x) => x && x.id === id)) return false;
    list.push({
        id, name: clean(d.name || d.id, 48), icon: clean(d.icon, 24), color: clean(d.color, 16),
        rewardMilli: Math.max(0, Math.floor(+d.rewardMilli || 0)), item: d.item ? 1 : 0, guest: d.guest ? 1 : 0,
    });
    writeList(st, PENDING_KEY, list.slice(-PENDING_MAX));
    return true;
}

export const waiting = (st) => (st ? readList(st, PENDING_KEY).length : 0);

// Everything waiting, handed over once: it is marked played right away (a
// moment cut short by Play does not come back). -> [cards]
export function take(st) {
    if (!st) return [];
    const list = readList(st, PENDING_KEY).filter((x) => x && x.id);
    if (!list.length) return [];
    const seen = readList(st, SEEN_KEY);
    const out = [];
    for (const d of list) {
        if (seen.indexOf(d.id) >= 0 || out.some((x) => x.id === d.id)) continue;
        out.push(d);
        seen.push(d.id);
    }
    writeList(st, SEEN_KEY, seen.slice(-SEEN_MAX));
    writeList(st, PENDING_KEY, []);
    return out;
}

// The cards to play: up to SHOW_MAX as they are, the rest folded into one
// "+N more" card carrying their dust. -> [{...card} | {more: n, rewardMilli}]
export function plan(cards) {
    const list = Array.isArray(cards) ? cards : [];
    if (list.length <= SHOW_MAX) return list.slice();
    const head = list.slice(0, SHOW_MAX - 1), rest = list.slice(SHOW_MAX - 1);
    return head.concat([{ more: rest.length, rewardMilli: rest.reduce((s, d) => s + (d.rewardMilli | 0), 0) }]);
}

export const totalMilli = (cards) => (Array.isArray(cards) ? cards : []).reduce((s, d) => s + (d.rewardMilli | 0), 0);
export const cardMs = (count) => (count >= 3 ? CARD_FAST_MS : CARD_MS);

export function fmtDust(milli) {
    const v = (+milli || 0) / 1000;
    return Number.isInteger(v) ? String(v) : String(+v.toFixed(2));
}

// The card's words. guest: nothing is paid until sign-up.
// -> {label, title, reward, foot}
export function words(d, guest) {
    if (!d) return null;
    const dust = (d.rewardMilli | 0) > 0 ? "+" + fmtDust(d.rewardMilli) + " gemdust" : "";
    if (d.more) {
        return { label: "And more", title: "+" + d.more + " more achievements", reward: dust, foot: guest ? "Sign up to keep it" : "" };
    }
    return {
        label: "Achievement completed",
        title: String(d.name || d.id),
        reward: dust || (d.item ? "New name style" : ""),
        foot: guest && (dust || d.item) ? "Sign up to keep it" : "",
    };
}

// The counter as particles land: from `from` to `to`, `landed` of `n` in.
export function tick(from, to, landed, n) {
    if (!(n > 0)) return to;
    const k = Math.max(0, Math.min(1, landed / n));
    return from + (to - from) * k;
}
