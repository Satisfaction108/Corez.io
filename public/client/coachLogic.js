// The first-raid guide's progress rules (pure, no DOM; coach.js holds the UI).
//
// Playtest 9 (Oct 2026): the "Use your ability" step sat on screen for all of
// raid 1 and all of raid 2. Its only exit was a use on this page, so a player
// who never pressed Q (or used a kit item) was nagged forever. Now:
//   - any ability or kit use ends it for good, in the guide's record AND in a
//     key of its own (ABILITY_KEY), so nothing that rewrites or resets the
//     guide's record can bring it back;
//   - it retires itself after ABILITY_NAG_MS on screen, or when a new raid
//     starts after it was already shown in an earlier one.
// There is no server-side prefs table for the guide (accounts keep none), so
// localStorage is the record.

export const KEY = "dwCoach_v1";
export const ABILITY_KEY = "dwAbilityUsed_v1";
export const ORDER = ["tutorial", "move", "mine", "bank", "upgrade", "ability"];
export const ABILITY_NAG_MS = 60000;

export function blank(now) { return { v: 1, status: "", done: {}, at: now || 0 }; }

function get(store, k) { try { return store ? store.getItem(k) : null; } catch (e) { return null; } }
function set(store, k, v) { try { if (store) store.setItem(k, v); } catch (e) { /* private mode */ } }

export function load(store, now) {
    let r = null;
    try { r = JSON.parse(get(store, KEY) || "null"); } catch (e) { r = null; }
    if (!(r && r.v === 1 && typeof r.done === "object" && r.done)) r = blank(now);
    // the old guide (points, tour, shop): past its first step, the warm-up
    // is old news; its shop step became the ability step
    if (r.done.points || r.done.upgrade || r.done.tour || r.done.mine) r.done.move = 1;
    if (r.done.shop) r.done.ability = 1;
    if (get(store, ABILITY_KEY) === "1") r.done.ability = 1;
    return r;
}
export function save(store, rec) {
    set(store, KEY, JSON.stringify(rec));
    if (rec && rec.done && rec.done.ability) set(store, ABILITY_KEY, "1");
}

// an ability or kit item was used: the step is done for good
export function abilityUsed(rec, store) {
    set(store, ABILITY_KEY, "1");
    if (rec.done.ability) return false;
    rec.done.ability = 1;
    save(store, rec);
    return true;
}

// The ability step was on screen for dt ms during raid `raid`.
// -> true when that retires it (shown long enough, or shown in an earlier raid).
// Round 11: the time on screen and the raid it was first shown in are saved
// as they change (a reload or a new raid page used to start the nag over),
// and it also retires ABILITY_WALL_MS after it was first shown (raid ids
// repeat across raid workers, so "a new raid" alone can miss).
export const ABILITY_WALL_MS = 8 * 60 * 1000;
export function abilityShown(rec, store, dt, raid, wall) {
    if (rec.done.ability) return false;
    const ab = rec.ab || (rec.ab = { ms: 0, raid: 0 });
    const r = raid | 0;
    const w = +wall || 0;
    let retire = false, dirty = false;
    if (r > 0 && ab.raid > 0 && r !== ab.raid) retire = true;
    if (r > 0 && !ab.raid) { ab.raid = r; dirty = true; }
    if (w > 0 && !(ab.at > 0)) { ab.at = w; dirty = true; }
    if (w > 0 && ab.at > 0 && w - ab.at >= ABILITY_WALL_MS) retire = true;
    const before = Math.floor(ab.ms / 5000);
    ab.ms += Math.max(0, Math.min(1000, dt || 0));
    if (Math.floor(ab.ms / 5000) !== before) dirty = true;
    if (ab.ms >= ABILITY_NAG_MS) retire = true;
    if (retire) { rec.done.ability = 1; rec.ab.retired = 1; save(store, rec); return true; }
    if (dirty) save(store, rec);
    return false;
}

// the next step to show: the first one not done and not waiting
export function nextStep(rec, waiting) {
    for (const id of ORDER) {
        if (rec.done[id]) continue;
        if (waiting && waiting(id)) continue;
        return id;
    }
    return ORDER.every(id => rec.done[id]) ? "final" : null;
}

// Round 11: the Mining Power tip. Round 12 (it never showed for the tester):
// the old rule marked it seen for good the moment Mining Power had any
// points, without showing it, and autoStats (unspent points spent after 20 s)
// or the tutorial ("press - twice") put points there first; its 9 s on screen
// also ran out under higher notes. Now it is marked seen only once shown, it
// also shows when you have unspent points while mining (the reason Mining
// Power was low), never in the tutorial, and it sits at the top of the stack.
// st: { dig, show, mp0 } (ms of digging so far, when the tip went up, Mining Power then)
// o: { t, dt, alive, dig, mp, pts (unspent stat points), tut }
export const MINE_TIP_KEY = "dwMinePowerTip_v2";
export const MINE_TIP_DIG_MS = 10000;
export const MINE_TIP_SHOW_MS = 9000;
export function mineTipText(touch, key, pts) {
    const n = pts | 0;
    if (n > 0) return touch ? "You have " + n + " stat points: put some in Mining Power to dig faster."
        : "You have " + n + " stat points: Mining Power [" + (key || "-") + "] digs faster.";
    return touch ? "Mining Power makes you dig faster. Add points in the stats panel."
        : "Mining Power makes you dig faster (stat [" + (key || "-") + "]).";
}
// worth telling: no Mining Power yet, or points waiting to be spent
export function mineTipWanted(o) { return !!o && ((o.mp | 0) <= 0 || (o.pts | 0) > 0); }
// -> "show" while it's up, "" otherwise. dt: ms since the last call.
export function mineTip(st, store, o) {
    if (st.show > 0) {
        // up for its time, or until a point goes into Mining Power
        if (o.t - st.show < MINE_TIP_SHOW_MS && !((o.mp | 0) > (st.mp0 | 0))) return "show";
        st.show = -1;
        return "";
    }
    if (st.show < 0 || get(store, MINE_TIP_KEY) === "1") { st.show = -1; return ""; }
    if (o.tut || !o.alive || !mineTipWanted(o)) return "";
    if (o.dig) st.dig = (st.dig || 0) + Math.max(0, Math.min(1000, o.dt || 0));
    if ((st.dig || 0) < MINE_TIP_DIG_MS) return "";
    st.show = o.t;
    st.mp0 = o.mp | 0;
    set(store, MINE_TIP_KEY, "1");
    return "show";
}

// Round 12: the "New here? Play the tutorial" offer only in the first
// TUT_OFFER_MS of a player's first raid (it once came up at 11 min, after the
// first-raid steps were done). rec.t0: when the guide first saw you playing.
export const TUT_OFFER_MS = 60000;
export function tutorialOfferOpen(rec, wall) {
    if (!rec || !rec.done) return false;
    if (rec.done.tutorial) return false;
    for (const id of ORDER) if (id !== "tutorial" && rec.done[id]) return false;
    if (!(rec.t0 > 0)) return true;
    return (+wall || 0) - rec.t0 < TUT_OFFER_MS;
}
