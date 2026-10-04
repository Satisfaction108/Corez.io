// The first raids, the rules: which HUD pieces each stage shows, the goal
// line, the director's banners and the death tips. Pure functions, no DOM or
// game state, so scripts/test/newcomerHud.test.js can run them in node.
// newcomer.js is the glue.
//
// Stage (the server's `royale.you.nx`): 0 first raid, 1 second, 2 third,
// 3 veteran. A missing or odd value is a veteran, so nothing changes until
// the server sends it.

export const VETERAN = 3;

export function effectiveStage(serverNx, forced) {
    const pick = forced != null && forced !== "" ? forced : serverNx;
    const n = Number(pick);
    if (pick == null || pick === "" || !isFinite(n)) return VETERAN;
    return Math.max(0, Math.min(VETERAN, Math.floor(n)));
}

// ── HUD pieces ─────────────────────────────────────────────────────────
// The first stage each one shows at. Anything not listed shows at every
// stage. Some pieces have a smaller form before that (see shows()).
export const MIN_STAGE = {
    // the basics, always: health, satchel/bank, raid clock and storm, minimap, coach
    clock: 0, health: 0, wallet: 0, storm: 0, minimap: 0, coach: 0,
    // the second raid: the rest of the "old" HUD and the shop side
    standings: 1, feed: 1, shop: 1, ability: 1, kit: 1, abilityTour: 1,
    raidEvents: 1, outposts: 1, raidNight: 1, cosmetics: 1, placeMsgs: 1,
    // the third raid: the big systems
    boss: 2, contracts: 2, bounties: 2, hunted: 2, core: 2, twist: 2,
    streaks: 2, revenge: 2,
};
// pieces that only exist in the early stages
export const MAX_STAGE = { goalLine: 0, directorMoments: 2 };

// opts.near: the boss / Core is right there (they show anyway)
// opts.owned: the player already holds the thing (an ability or kit item from
// a director moment), so its slot shows
export function shows(piece, nx, opts) {
    const o = opts || {};
    if (nx >= VETERAN) return MAX_STAGE[piece] == null;
    if (MAX_STAGE[piece] != null) return nx <= MAX_STAGE[piece];
    const min = MIN_STAGE[piece];
    if (min == null || nx >= min) return true;
    if ((piece === "boss" || piece === "core") && o.near) return true;
    if ((piece === "ability" || piece === "kit") && o.owned) return true;
    return false;
}
// Every piece and what a stage does with it, for QA and the test.
export function stageTable(nx) {
    const out = {};
    for (const k of Object.keys(MIN_STAGE).concat(Object.keys(MAX_STAGE))) out[k] = shows(k, nx);
    return out;
}

// ── the notes and plates that wait for later stages ────────────────────
// server toasts under the clock: critical ones (storm, vault, the lock)
// always; the big systems from stage 2; the rest from stage 1
const CRIT = /storm|vault|clos|respawn/i;
const BIG = /\bboss|surfaced|\bcore\b|bounty|contract|override|twist|hunted|top target|warden|colossus|wraith|drillhead|streak/i;
export function toastAllowed(text, nx) {
    if (nx >= VETERAN || !text) return true;
    if (CRIT.test(text)) return true;
    if (nx >= 2) return true;
    if (BIG.test(text)) return false;
    return nx >= 1;
}
// centre plates (KC kinds); unknown kinds show
const CALLOUT_STAGE = {
    override: 2, bounty: 2, contract: 2, quest: 2, boss: 2, streak: 2, revenge: 2,
    shutdown: 2, huntkill: 2, late: 1, corebreak: 2,
};
export function calloutAllowed(kind, nx) {
    if (nx >= VETERAN) return true;
    const min = CALLOUT_STAGE[kind];
    return min == null || nx >= min;
}
// the kill feed before stage 1: only lines with your name in them
export function feedAllowed(f, nx, myName) {
    if (nx >= MIN_STAGE.feed) return true;
    if (!f || !myName) return false;
    return f.name === myName || f.by === myName;
}

// ── the goal line under the clock (stage 0) ────────────────────────────
export const GOALS = {
    dig: "Dig gems → Bank them at the vault",
    upgrade: "Upgrade your tank",
    ability: "Try your new ability",
    storm: "Stay out of the storm",
};
// s: { coachStep, bankedRaid, canUpgrade }. The coach's step wins while it
// runs, so the card and the line always say the same thing.
export function goalFor(s) {
    const o = s || {};
    const step = o.coachStep || "";
    let id;
    if (step === "move" || step === "mine" || step === "bank") id = "dig";
    else if (step === "upgrade") id = "upgrade";
    else if (step === "ability") id = "ability";
    else if (!((o.bankedRaid | 0) > 0)) id = "dig";
    else if (o.canUpgrade) id = "upgrade";
    else id = "storm";
    return { id, text: GOALS[id], arrow: id === "dig" ? "vault" : "" };
}

// ── first-time intros (stages 1 and 2) ─────────────────────────────────
// {key} is the ability key, {kit} the kit keys
export const INTROS = {
    shop: { stage: 1, text: "Shops sell abilities and gear. You pay with banked gems." },
    ability: { stage: 1, text: "Abilities recharge. Press {key} to use yours.", touch: "Abilities recharge. Tap the ability button to use yours." },
    kit: { stage: 1, text: "Kit items work once each. Use them with {kit}.", touch: "Kit items work once each. Tap them on the right." },
    boss: { stage: 2, text: "Bosses hit hard and pay big. Team up or keep clear." },
    contract: { stage: 2, text: "Contracts are quick jobs, top left. Each one pays gems." },
    bounty: { stage: 2, text: "A bounty is out. Take that player down for extra gems." },
    core: { stage: 2, text: "The Core rose in the middle. Everyone who hits it gets paid." },
    hunted: { stage: 2, text: "Carrying a lot makes you hunted. Bank to shake them off." },
    twist: { stage: 2, text: "Every raid has a twist. It's on the card, top left." },
};
// The intro to show the first time a piece appears, or "" (veterans, a
// stage that hides the piece, or seen before).
export function introText(id, nx, seen, keys) {
    const it = INTROS[id];
    if (!it || nx >= VETERAN || nx < it.stage) return "";
    if (seen && seen[id]) return "";
    const k = keys || {};
    const raw = k.touch && it.touch ? it.touch : it.text;
    return raw.replace("{key}", k.ability || "Q").replace("{kit}", k.kit || "Z, comma and N");
}

// ── director moments (stage 0) ─────────────────────────────────────────
const KIND_ALIAS = {
    ore: "ore", orepocket: "ore", ore_pocket: "ore", pocket: "ore", vein: "ore", richvein: "ore",
    crate: "crate", supply: "crate", supplycrate: "crate",
    ability: "ability", trial: "ability", abilitytrial: "ability", ability_trial: "ability",
    chest: "chest", treasure: "chest",
    timed: "timed", mini: "timed", objective: "timed", challenge: "timed", timer: "timed",
};
export function normKind(kind) {
    const k = String(kind || "").toLowerCase().replace(/[\s-]/g, "");
    return KIND_ALIAS[k] || KIND_ALIAS[k.replace(/_/g, "")] || "";
}
const KIND_COL = { ore: "#ffd76e", crate: "#6ff5a8", ability: "#5ce0d8", chest: "#f2b83c", timed: "#ff9a5a", "": "#f2eef8" };
const KIND_MARK = { ore: "VEIN", crate: "CRATE", chest: "CHEST", timed: "GO", "": "LOOK" };
// The arrival banner. ev: the server's moment; o: { ability: name, key, touch }.
// Unknown kinds: the event's own text if it has some, else no banner (the
// arrow still points at it).
export function bannerFor(ev, o) {
    const e = ev || {}, opt = o || {};
    const kind = normKind(e.kind);
    const t = typeof e.t === "string" && e.t ? e.t : typeof e.text === "string" ? e.text : "";
    const sub = typeof e.sub === "string" ? e.sub : "";
    let title = "", line = "";
    switch (kind) {
        case "ore": title = "Rich vein nearby"; line = "Follow the arrow and dig in."; break;
        case "crate": title = "Supply crate incoming!"; line = "It lands by the arrow. Crack it open."; break;
        case "chest": title = "Treasure chest nearby"; line = "Shoot it open for gems."; break;
        case "ability": {
            const name = opt.ability || e.name || "";
            title = name ? "Free ability: " + name : "Free ability!";
            // always how to use it, whatever the server's sub line says
            line = opt.touch ? "Tap the ability button to try it." : "Press " + (opt.key || "Q") + " to try it.";
            break;
        }
        case "timed": title = t || "Quick challenge!"; line = sub || "Beat the clock."; break;
        default: title = t; line = sub;
    }
    if (kind !== "timed" && kind && t) title = t;
    if (kind !== "timed" && kind !== "ability" && sub) line = sub;
    // a timed job at the vault (the server's "bank N gems") points at it
    const mark = kind === "ability" ? "" : kind === "timed" && e.goal > 0 ? "VAULT" : (KIND_MARK[kind] || KIND_MARK[""]);
    return { kind, title, sub: line, col: KIND_COL[kind] || KIND_COL[""], mark };
}
// The payoff when one is done. leftMs: what was left on a timed one.
export function payoffFor(ev, leftMs) {
    const e = ev || {};
    const kind = normKind(e.kind);
    const r = (e.r | 0) || (e.reward | 0) || (e.g | 0);
    const gems = r > 0 ? "+" + r + " gems" : "";
    switch (kind) {
        case "ore": return { title: "Vein cleared!", sub: gems || "Now bank it." };
        case "crate": return { title: "Crate cracked!", sub: gems || "Grab the loot." };
        case "chest": return { title: "Chest cracked!", sub: gems || "Grab the gems." };
        case "ability": return { title: "That's an ability!", sub: "Shops sell more of them." };
        case "timed": {
            const s = Math.max(0, Math.ceil((leftMs || 0) / 1000));
            return { title: "Challenge done!", sub: [gems, s > 0 ? s + "s to spare" : ""].filter(Boolean).join("  ·  ") };
        }
    }
    return { title: "Nice!", sub: gems };
}
// ms left on a moment. Takes `left` (ms when the RY packet arrived), or
// `until` as a Date.now() time, or `until` as ms from the packet.
export function leftMs(ev, rAt, now, dateNow) {
    if (!ev) return 0;
    if (ev.left != null && isFinite(+ev.left)) return Math.max(0, +ev.left - (now - (rAt || now)));
    const u = +ev.until;
    if (!isFinite(u) || u <= 0) return Infinity;
    if (u > 1e11) return Math.max(0, u - dateNow);
    return Math.max(0, u - (now - (rAt || now)));
}
// How a moment ended, from the server's state ('live', then 'done',
// 'failed' or 'gone' for a few seconds) or its done / failed flags:
// "done", "failed", "gone", or "" while it's still on. An event with no
// state at all is "" (the client works it out when it disappears).
export function endState(ev) {
    if (!ev) return "";
    if (ev.done || ev.state === "done") return "done";
    if (ev.failed || ev.state === "failed") return "failed";
    if (ev.state && ev.state !== "live") return "gone";
    return "";
}
// the timed job's progress, "120/200", when the server sends it
export function progressText(ev) {
    return ev && ev.goal > 0 ? Math.min(ev.prog | 0, ev.goal | 0) + "/" + (ev.goal | 0) : "";
}
export function eventKey(ev) {
    if (!ev) return "";
    if (ev.id != null) return "id:" + ev.id;
    return String(ev.kind) + "|" + Math.round(+ev.x || 0) + "|" + Math.round(+ev.y || 0) + "|" + (ev.until || "");
}
// "0:24"
export function clock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// ── the death card (stages 0 and 1) ────────────────────────────────────
const BOSS_NAMES = /warden|colossus|wraith|drillhead|\bboss\b/i;
// d: { cause, killers: [names], isBot(name), bossName }
export function deathKind(d) {
    const o = d || {};
    const c = String(o.cause || "");
    if (c === "storm" || c === "rock" || c === "base" || c === "core" || c === "raidend") return c;
    const ks = Array.isArray(o.killers) ? o.killers.filter(Boolean).map(String) : [];
    if (!ks.length) return "none";
    const k = ks[0];
    if ((o.bossName && k === o.bossName) || BOSS_NAMES.test(k)) return "boss";
    if (typeof o.isBot === "function" && o.isBot(k)) return "bot";
    return "player";
}
export const DEATH_TIPS = {
    bot: "A bot chased you. Bank gems before you get too heavy.",
    player: "Another player got you. Bank your gems before you pick a fight.",
    boss: "A boss got you. Bosses hit hard, so keep your distance for now.",
    storm: "The storm got you. Follow the arrow back to the circle.",
    rock: "The rock grew back around you. Keep moving through fresh tunnels.",
    base: "An enemy base shot you. Stay off bases that aren't yours.",
    core: "The Core's shockwave got you. Back off when it glows bright.",
    raidend: "The raid ended. A new one starts in a moment.",
    none: "You went down. Bank your gems often so you keep more.",
};
export function deathTip(d) { return DEATH_TIPS[deathKind(d)]; }
// What you kept. k: { banked, carried (dropped), kept (saved from the satchel) }
export function keptLine(k) {
    const o = k || {};
    const banked = Math.max(0, o.banked | 0), lost = Math.max(0, o.carried | 0), kept = Math.max(0, o.kept | 0);
    const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (kept > 0) {
        const frac = kept / (kept + lost);
        const head = Math.abs(frac - 0.5) < 0.08 ? "You kept half your satchel." : frac > 0.97 ? "You kept your whole satchel." : "You kept " + fmt(kept) + " gems from your satchel.";
        return head + (banked > 0 ? " Your bank is safe too." : "");
    }
    if (banked > 0) return "You kept your " + fmt(banked) + " banked gems." + (lost > 0 ? " Your satchel dropped." : "");
    if (lost > 0) return "Nothing was banked, so your gems dropped. Bank them next time.";
    return "Nothing lost. Jump back in.";
}
