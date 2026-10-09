// The first seconds of a raid, the rules

// Round 8: the card stays up about 65% longer (owner: it went before it could be
// The pointers come one at a time after the card (tilesNudge, then statsNudge),
// and the guide card after the last one: never more than two new things up.
export const NEW_PLAN = Object.freeze({
    intro: 5600, messages: 2600, tiles: 5700, stats: 6700, ability: 7500, coach: 9500, nudge: 1850,
    tilesNudge: 5700, statsNudge: 7550,
});
// Someone who has played before: the raid card, shorter, and nothing held but the
export const VET_PLAN = Object.freeze({
    intro: 3800, messages: 0, tiles: 0, stats: 0, ability: 3800, coach: 0, nudge: 0,
});
// A new raid on the same page (the last one ended, the next started): the tank
// The card lands alone (the toasts wait 2.6 s), then the tank pointer, then
// the points pointer, then the guide card.
export const NEW_RAID_PLAN = Object.freeze({
    intro: 6000, messages: 2600, tiles: 1, stats: 1, ability: 6000, coach: 12000, nudge: 3000,
    tilesNudge: 6000, statsNudge: 9000,
});
// Dead (or on the death card) when the last raid ended and its podium never got
export const RECAP_MS = 4800;
export const FADE_IN = 260;
export const FADE_OUT = 480;
// A hit while things are still held lets everything in at once
export const PIECES = ["messages", "tiles", "stats", "ability", "coach"];

// o: { newcomer, tutorial, newRaid }
export function planFor(o) {
    const s = o || {};
    if (s.tutorial) return null;
    if (s.newRaid && s.recap) {
        const p = { ...NEW_RAID_PLAN, newcomer: !!s.newcomer, newRaid: true, recap: RECAP_MS, ...(s.newcomer ? {} : { nudge: 0 }) };
        for (const k of ["intro", "messages", "tiles", "stats", "ability", "coach", "tilesNudge", "statsNudge"]) if (p[k] > 0) p[k] += RECAP_MS;
        return p;
    }
    // Oct 8: the "pick your tank" / "click a bar" pointers are for the first
    // raids only; a veteran's new raid starts with a clean HUD
    if (s.newRaid) return { ...NEW_RAID_PLAN, newcomer: !!s.newcomer, newRaid: true, ...(s.newcomer ? {} : { nudge: 0 }) };
    return { ...(s.newcomer ? NEW_PLAN : VET_PLAN), newcomer: !!s.newcomer };
}
// A spawn on a page that already had its first plan: a new raid gets the short
export function isNewRaid(lastRaid, raidNow, lastStart, startNow) {
    if ((lastRaid | 0) > 0 && (raidNow | 0) > 0 && (raidNow | 0) !== (lastRaid | 0)) return true;
    // round 12: raid ids repeat across raid workers (an overflow move between
    // raids kept the id, and FRESH START never came): a raid clock that
    // started RAID_START_JUMP_MS later than the last one is a new raid too
    return (+lastStart || 0) > 0 && (+startNow || 0) > 0 && startNow - lastStart > RAID_START_JUMP_MS;
}
export const RAID_START_JUMP_MS = 30000;
// when this raid's clock started (wall ms), from RY raidMs and raidLeft (s); 0 if unknown
export function raidStartOf(r, wall) {
    if (!r || !((r.raidMs | 0) > 0) || !((r.raidLeft | 0) > 0)) return 0;
    return (+wall || 0) - ((r.raidMs | 0) - (r.raidLeft | 0) * 1000);
}
// The nudge beside a piece that just came in
export function nudgeText(plan, piece) {
    if (plan && plan.newRaid) return piece === "tiles" ? "New raid: pick your tank" : "Fresh points: click a bar";
    return piece === "tiles" ? "New tanks, pick one any time" : "Points to spend, click a bar";
}

// May this piece show? plan null (no intro this life) or released: yes
export function shows(plan, age, piece, released) {
    if (!plan || released) return true;
    const at = plan[piece];
    if (!(at > 0)) return true;
    return age >= at;
}

// How long until the piece may show (0 = now), for the slam hold
export function waitFor(plan, age, piece, released) {
    if (shows(plan, age, piece, released)) return 0;
    return Math.max(0, plan[piece] - age);
}

// The raid card's opacity: fades in on landing, out at the end
export function introAlpha(plan, age, relFor = -1) {
    if (!plan || age < 0) return 0;
    const end = plan.intro;
    if (age >= end) return 0;
    const a = Math.max(0, Math.min(1, age / FADE_IN, (end - age) / FADE_OUT));
    return relFor >= 0 ? a * Math.max(0, 1 - relFor / 250) : a;
}

// Which card shows at `age` with a recap in the plan, and its own fade: -> {
export function cardPhase(plan, age, relFor = -1) {
    const all = introAlpha(plan, age, relFor);
    if (!plan || !(plan.recap > 0) || all <= 0) return { recap: false, a: all };
    const R = plan.recap;
    if (age < R) return { recap: true, a: Math.min(all, Math.max(0, (R - age) / FADE_OUT)) };
    return { recap: false, a: Math.min(all, Math.max(0, (age - R) / FADE_IN)) };
}

// The last raid's results, as the recap card says them
export function recapLines(o) {
    const s = o || {};
    const fmt = n => (n < 0 ? "-" : "") + String(Math.abs(Math.round(+n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const place = s.place | 0, rows = s.rows | 0;
    const title = place === 1 ? "YOU WON" : place > 0 ? "#" + place + (rows > 1 ? " OF " + rows : "") : "RAID OVER";
    const win = s.winner ? (place === 1 ? "Most points: " + fmt(s.wScore) + "." : s.winner + " won with " + fmt(s.wScore) + " pts.") : "";
    const goal = (win + " You finished with " + fmt(s.score) + " pts.").trim();
    const controls = "Your points: banked " + fmt(s.b) + " + kills & bonuses " + fmt(s.k) + ((s.c | 0) < 0 ? " - crowns " + fmt(-(s.c | 0)) : " + crowns " + fmt(s.c));
    const top = Array.isArray(s.top) ? s.top.slice(0, 3).map((r, i) => (i + 1) + ". " + String(r.name || "Unnamed").slice(0, 14) + " " + fmt(r.score)) : [];
    return { eyebrow: "LAST RAID RESULTS", title, goal, controls, status: top.join("  ·  ") };
}

// When a piece's nudge starts (its own slot, or with the piece)
export function nudgeAt(plan, piece) {
    if (!plan) return 0;
    const own = plan[piece + "Nudge"];
    return own > 0 ? own : plan[piece];
}
// When the whole plan has played out (the card, the holds, the nudges)
export function planEnd(plan) {
    if (!plan) return 0;
    let end = Math.max(plan.intro, plan.coach, plan.ability, plan.messages | 0, plan.tiles, plan.stats);
    if (plan.nudge > 0) {
        for (const pc of ["tiles", "stats"]) {
            const at = nudgeAt(plan, pc);
            if (at > 0) end = Math.max(end, at + plan.nudge);
        }
    }
    return end;
}
// How many of the staged pieces are new on screen at `age` (the card, a
// pointer, the guide card): the calm-start rule keeps this at 2 or less
export function busyAt(plan, age) {
    if (!plan || age < 0) return 0;
    let n = introAlpha(plan, age) > 0 ? 1 : 0;
    for (const pc of ["tiles", "stats"]) if (nudgeAlpha(plan, age, pc, false) > 0) n++;
    if (plan.coach > 0 && age >= plan.coach) n++;
    return n;
}

// A short nudge beside a piece that just came in: 0..1 while it shows
export function nudgeAlpha(plan, age, piece, released) {
    if (!plan || released || !(plan.nudge > 0)) return 0;
    const at = nudgeAt(plan, piece);
    if (!(at > 0)) return 0;
    const k = age - at;
    if (k < 0 || k > plan.nudge) return 0;
    return Math.max(0, Math.min(1, k / 200, (plan.nudge - k) / 400));
}

function clock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// The card's lines
export function introLines(o) {
    const s = o || {};
    if (s.newRaid) {
        const pts = s.points | 0;
        const bits = [];
        if ((s.tanks | 0) > 1) bits.push((s.tanks | 0) + " tanks in this raid");
        if ((s.leftMs | 0) > 0) bits.push(clock(s.leftMs) + " left");
        if (s.twist) bits.push("Twist: " + s.twist);
        // the last raid, in one line, so its result is never lost in the turnover
        const L0 = s.last;
        const lastTxt = L0 && (L0.place | 0) > 0
            ? "LAST RAID: #" + (L0.place | 0) + ((L0.rows | 0) > 1 ? " OF " + (L0.rows | 0) : "") + " WITH " + String(Math.max(0, L0.score | 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " PTS"
            : "";
        return {
            eyebrow: lastTxt || "NEW RAID", title: "FRESH START",
            goal: "Everyone starts over as Basic. Pick your tank" + (pts > 0 ? " and spend your " + (pts === 1 ? "1 point." : pts + " points.") : "."),
            controls: (s.gunless ? "Ram" : "Shoot") + " colored rocks for gems and bank them at a vault.",
            status: bits.join("  ·  "),
        };
    }
    const goal = s.gunless
        ? "Ram colored rocks for gems and bank them at a vault. Most points at the end wins."
        : "Shoot colored rocks for gems and bank them at a vault. Most points at the end wins.";
    const controls = s.mobile
        ? "Left thumb moves  ·  Right thumb aims and fires"
        : (s.keys || "WASD") + " to move  ·  Mouse to aim  ·  Click to shoot";
    const bits = [];
    const n = s.tanks | 0;
    if (n > 1) bits.push(n + " tanks in this raid");
    if ((s.leftMs | 0) > 0) bits.push(clock(s.leftMs) + " left");
    if (s.twist) bits.push("Twist: " + s.twist);
    return { eyebrow: "raid started", title: "Mine, Bank, Win", goal, controls, status: bits.join("  ·  ") };
}

// Tank tiles: a hull with no guns of its own (Smasher, Spike, ...) digs by
export function minesBy(gunCount) {
    return (gunCount | 0) > 0 ? "gun" : "ram";
}

// The shop with nothing to spend: how to get there, not a wall of locks
export function shopHint(o) {
    const s = o || {};
    const banked = Math.max(0, s.banked | 0), carried = Math.max(0, s.carried | 0);
    const cheapest = Math.max(0, s.cheapest | 0), min = (s.vaultMin | 0) || 15;
    const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (cheapest > 0 && banked >= cheapest) return null;
    if (banked === 0 && carried >= min)
        return { title: "Bank first", text: "Bank your " + fmt(carried) + " gems at a vault first. Vaults are the gold rings on the map." };
    if (banked === 0)
        return { title: "Shops only take banked gems", text: "Get some gems, bank them at a vault, then come back." };
    if (cheapest > 0)
        return { title: "Almost", text: "Bank " + fmt(cheapest - banked) + " more gems for the cheapest thing here." + (carried >= min ? " You have " + fmt(carried) + " on you." : "") };
    return null;
}
