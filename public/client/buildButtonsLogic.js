// Round 9 build buttons, the words and when they show (pure

// the death card's second button: "Respawn as Minigun", "same tank and stats"
// diedAs: the tank this life ended as (client side, socketinit.js). The server
// saves that same tank at the death, but the RY that says so can land a moment
// after the card opens (playtest 9: "Respawn as Vulture" for a Minigun), so an
// upgraded died-as tank names the button.
export function respawnAs(you, diedAs) {
    if (!you || !(you.lt || you.ls)) return null;
    // ltg: a Tier 5 build comes back as its Tier 4 parent until this life is 2x
    if (you.ltg && you.lt) return { label: "Respawn as " + you.lt, sub: "Grow to " + (you.ltg > 100 ? you.ltg / 100 : 2) + "x this life to unlock Tier 5" };
    const name = you.lt && diedAs && diedAs !== "Basic" ? diedAs : you.lt;
    return { label: "Respawn as " + (name || "Basic"), sub: you.lt ? "same tank and stats" : "same stats" };
}
// Oct 6 2026: no "Respawn as" for an upgraded died-as tank (no saved build,
// e.g. a new raid): say why instead of a silent Basic drop. Waits a moment so
// the RY that carries lt can land first.
export function respawnAsWhy(you, diedAs, openMs) {
    if (respawnAs(you, diedAs)) return "";
    if (!diedAs || diedAs === "Basic" || !(openMs >= 1500)) return "";
    return "Your " + diedAs + " build didn't save, so you start as Basic.";
}
// by "Don't upgrade": only while you're below the last tank
export function lastTank(you, tutorial = false) {
    if (tutorial || !you || !you.lt || !you.ltu) return "";
    return "Last tank: " + you.lt;
}
// by the points counter, only while points are unspent: index 0 = Same stats
export function statButtons(you, points, died = false, tutorial = false) {
    if (tutorial || died || !((points | 0) > 0)) return [];
    const out = [];
    if (you && you.ls) out.push({ label: "Same stats", mode: "stats", i: 0 });
    out.push({ label: "Random", mode: "random", i: 1 });
    return out;
}
// the "rb" packet's legal modes (the server checks again)
export const MODES = ["build", "tank", "stats", "random"];

// "1 point", "2 points"
export function plural(n, one, many) {
    n = n | 0;
    return n + " " + (n === 1 ? one : (many || one + "s"));
}

// First-time-only tips (Team Bank, kit, contract): true the first time a key is
const seenTips = new Set();
export function firstTime(key, store) {
    if (seenTips.has(key)) return false;
    seenTips.add(key);
    try {
        if (typeof store === "function") store = store();
        if (store && store.getItem("dwTip_" + key)) return false;
        if (store) store.setItem("dwTip_" + key, "1");
    } catch (e) { /* private mode: once per session */ }
    return true;
}
// round 12: shown on the first approach (app.js drawOutpostLabels), not only on the pad
export const TEAM_BANK_TIP = "Team Bank: break its banner to own it, then bank here safely.";
export const TEAM_BANK_NEAR = 700;   // world units from your tank
