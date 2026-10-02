// When the one-time ability tour may run, and what moves it on. No DOM, so
// the tests can load it (scripts/test/abilities.test.js).
export const INTRO_KEY = "dwAbilityIntro_v1";
export const TAB_KEY = "dwAbilityTabSeen_v1";
export const STEPS = ["dash", "ability", "shop"];
// after the landing: the starter-ability slam runs first
export const START_DELAY = 3000;
// a step nobody acts on moves on by itself after this, so the tour never
// holds the screen (and the first-raid coach behind it) for long
export const STEP_MAX_MS = 9000;
// the shop tab's NEW badge goes once the tab has been up this long
export const TAB_SEEN_MS = 2500;

export function introDone(store) {
    try { return store.getItem(INTRO_KEY) === "1"; } catch (e) { return true; }
}
export function markDone(store) {
    try { store.setItem(INTRO_KEY, "1"); } catch (e) { /* storage blocked: it just runs again */ }
}
export function tabSeen(store) {
    try { return store.getItem(TAB_KEY) === "1"; } catch (e) { return true; }
}
export function markTabSeen(store) {
    try { store.setItem(TAB_KEY, "1"); } catch (e) { /* */ }
}

// s: { done, tutorial, playing, abilOn, eq, falling, landedAgo, slam, card, busy, coach }
// busy: a panel, the big map, chat or a pad is in the way
// coach: the first-raid coach is still teaching (it has its own ability step)
export function canStart(s) {
    return !s.done && !s.tutorial && !s.coach && !!s.playing && !!s.abilOn && !!s.eq && !s.falling &&
        s.landedAgo >= START_DELAY && !s.slam && !s.card && !s.busy;
}
// The step after `step` when the player just did `used` (dash / ability /
// shop), or the same step. -1 = the tour is over.
export function advance(step, used) {
    const id = STEPS[step];
    if (!id || used !== id) return step;
    return step + 1 >= STEPS.length ? -1 : step + 1;
}
