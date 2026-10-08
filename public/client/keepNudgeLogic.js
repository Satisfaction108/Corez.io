// When a guest's raid ends, should the results offer "Keep my stuff" (the
// one-tap account sheet), and with which headline? Pure: the caller hands
// in what the raid did and a Storage (localStorage), so it tests in node.
//
// Asks on a raid win, a top-3 finish, a new personal best (not the first
// raid ever, when everything is a best) and once on the 2nd finished raid.
// Never twice for one raid, and not again for a day after "Not now".

export const DISMISS_KEY = "dwKeepNudgeNo";      // ms of the last "Not now"
export const RAIDS_KEY = "dwKeepNudgeRaids";     // raids finished as a guest
export const LAST_KEY = "dwKeepNudgeRaid";       // the last raid id counted
export const SECOND_KEY = "dwKeepNudge2";        // the 2nd-raid ask happened
export const QUIET_MS = 24 * 60 * 60 * 1000;

const read = (st, k) => { try { return +st.getItem(k) || 0; } catch (e) { return 0; } };
const write = (st, k, v) => { try { st.setItem(k, String(v)); } catch (e) { /* private mode */ } };
const num = (n) => Math.round(n).toLocaleString("en-US");

// o: { guest, raidId, place, isWin, score, prevBest, now }
// -> { headline, why: 'win'|'top3'|'best'|'second' } | null
export function decide(o, st) {
    if (!o || !o.guest || !st) return null;
    const raidId = o.raidId | 0;
    // once per raid: a raid already counted was already decided
    if (raidId > 0 && read(st, LAST_KEY) === raidId) return null;
    if (raidId > 0) write(st, LAST_KEY, raidId);
    const raids = read(st, RAIDS_KEY) + 1;
    write(st, RAIDS_KEY, raids);
    const now = +o.now || Date.now();
    const no = read(st, DISMISS_KEY);
    if (no > 0 && now - no < QUIET_MS) return null;
    const place = o.place | 0, score = o.score | 0, prev = o.prevBest | 0;
    let out = null;
    if (o.isWin || place === 1) out = { headline: "You won! Keep your stats?", why: "win" };
    else if (place >= 2 && place <= 3) out = { headline: "Top 3! Keep your stats?", why: "top3" };
    else if (prev > 0 && score > prev) out = { headline: "New best: " + num(score) + ". Keep it?", why: "best" };
    else if (raids === 2 && !read(st, SECOND_KEY)) out = { headline: "Keep your progress?", why: "second" };
    if (out && raids >= 2) write(st, SECOND_KEY, 1);
    return out;
}

// "Not now": quiet for a day
export function dismiss(st, now) {
    if (st) write(st, DISMISS_KEY, +now || Date.now());
}
