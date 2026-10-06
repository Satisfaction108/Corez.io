// Round 9 build buttons, the words and when they show (pure

// the death card's second button: "Respawn as Minigun", "same tank and stats"
export function respawnAs(you) {
    if (!you || !(you.lt || you.ls)) return null;
    return { label: "Respawn as " + (you.lt || "Basic"), sub: you.lt ? "same tank and stats" : "same stats" };
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
export const TEAM_BANK_TIP = "Team Banks go to whoever does the most damage to their banner. Vaults are open to everyone.";
