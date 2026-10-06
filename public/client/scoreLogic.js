// Raid points, the words

export const RULE = "Points = banked gems + kills & bonuses + crowns";
export const RULE_SHORT = "PTS = BANKED + KILLS + CROWNS";
export const RULE_BODY = "Most points at the bell wins. Banked gems are safe: dying never takes them. " +
    "Carried gems count once you bank them. Kills, streaks, bosses and quests add bonus points. " +
    "A crown pays points every second, but whoever kills you takes it and up to 30% of your kill and crown points.";

const num = (n) => String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const fmt = num;

// Two different numbers, two different names (playtest 4 read "Banked 1,697" on
export const BANK = "Bank";
export const BANKED_RAID = "Banked this raid";
export const BANK_TIP = "Bank: gems you can spend at shops";
export const BANK_TIP_BODY = "Spending lowers your Bank but never your points. " +
    "Your points count everything you banked this raid (Banked this raid on the death card and results).";

// The one points number the death card shows (header and the "Points: X" line
export function cardPoints(you) {
    const y = you || {};
    if (typeof y.score === "number" && isFinite(y.score)) return Math.max(0, Math.round(y.score));
    return parts(y).total;
}

// > { b, k, c, total, earned, stolen } from RY you (old servers without `pts`
export function parts(you) {
    const y = you || {};
    const p = y.pts;
    if (p && typeof p === "object") {
        const b = p.b | 0, k = p.k | 0, c = p.c | 0;
        const stolen = Math.max(0, p.s | 0, -c);
        return { b, k, c, total: b + k + c, earned: Math.max(0, c + stolen), stolen };
    }
    const total = y.score | 0, b = Math.min(total, y.banked | 0);
    return { b, k: total - b, c: 0, total, earned: 0, stolen: 0 };
}

// The death card's points line and its reason
export function deathLine(you, carried, savingsLost = 0) {
    const y = you || {};
    const dl = y.dl || {};
    const lostPts = Math.max(0, dl.p | 0);
    const sav = Math.max(0, savingsLost | 0);
    // after the loss, the same number as the card's POINTS header
    const head = "Points: " + num(cardPoints(y));
    let lost;
    if (lostPts > 0) lost = "lost " + num(lostPts) + ": " + (dl.by ? dl.by + " took your crown" : "your crown was taken");
    else if (sav > 0) lost = dl.cr ? "points lost: 0, your crown fell" : "points lost: 0";
    else if (dl.cr) lost = "lost 0: your crown fell, banked gems are safe";
    else lost = "lost 0: banked gems are safe";
    const c = Math.max(0, (carried != null ? carried : dl.c) | 0);
    const sub = c > 0 ? "You dropped " + num(c) + " carried gems. They were not points yet: bank sooner." : "";
    return { head, lost, sub, hurt: lostPts > 0, savings: savingsLine(sav) };
}
export function savingsLine(n) {
    n = Math.max(0, n | 0);
    return n > 0 ? "Your older savings (from earlier raids) paid " + num(n) + " gems for this death. Your points and this raid's banking are untouched" : "";
}

// The three parts as death card / results tiles: [label, value, icon]
export function tiles(you) {
    const pt = parts(you);
    return [
        ["BANKED THIS RAID", num(pt.b), "gem"],
        ["KILLS & BONUSES", num(pt.k), "combat"],
        [pt.stolen > 0 ? "CROWNS · " + num(pt.stolen) + " STOLEN" : "CROWNS", num(pt.earned), "crown"],
    ];
}

// Carrying a lot: a warning before the risk (note stack)
export const CARRY_WARN = 600;      // with danger around
export const CARRY_LOUD = 2000;     // always
export function carryNote(o) {
    const s = o || {};
    const n = Math.max(0, s.carried | 0);
    // a crown in the final minute can't bank: nothing to tell them to do
    if (s.died || s.noBank || n < CARRY_WARN) return null;
    const danger = (s.near | 0) > 0 || !!s.storm || (s.hp != null && s.hp < 0.6);
    if (!danger && n < CARRY_LOUD) return null;
    return { text: "Carrying " + num(n) + ": bank it", sub: danger ? "Dying drops it, it's not points yet" : "Not points until banked", hot: danger };
}

// The crown card while you wear one
export function crownCard(crown) {
    if (!crown) return null;
    const pps = Math.max(1, crown.pps | 0);
    const lose = Math.max(0, crown.lose | 0);
    return {
        title: "YOU HAVE A CROWN",
        // final minute: crowns bank like anyone, but the vault pushes them off right
        line1: "+" + pps + " pts/sec. " + (crown.sd ? "Bank fast, the vault won't hide you." : "Others will hunt you."),
        line2: lose > 0 ? "If killed: -" + num(lose) + " pts. Banked gems stay safe." : "If killed: you lose the crown. Banked gems stay safe.",
    };
}

// ── points pops ──────────────────────────────────────────────────────────
// Every change of your points says why, alive or dead (playtest 5: 2,840 -> 3,200
export const PTS_POP_MS = 3200;
export const PTS_LABEL_MS = 2500;
export const PTS_MAX = 3;
export const PTS_MERGE_MS = 1400;

export function ptsPops() { return { last: null, raid: undefined, labels: [], pops: [] }; }

// "+60 pts · KO kai", "-320 pts · kai took your crown", "+15 pts"
export function ptsPopText(n, text) {
    const s = (n < 0 ? "-" : "+") + num(Math.abs(n)) + " pts";
    return text ? s + " · " + text : s;
}

function ptsPush(st, n, text, now) {
    const t = text || "";
    const top = st.pops.length ? st.pops[st.pops.length - 1] : null;
    if (top && top.text === t && now - top.at < PTS_MERGE_MS && (top.n > 0) === (n > 0)) {
        top.n += n; top.at = now; top.str = ptsPopText(top.n, t); top.w = null;
        return top;
    }
    const p = { n, text: t, at: now, str: ptsPopText(n, t), w: null };
    st.pops.push(p);
    while (st.pops.length > PTS_MAX) st.pops.shift();
    return p;
}

// a labelled award (before its RY, usually
export function ptsLabel(st, n, text, now) {
    n = Math.round(+n || 0);
    if (!st || !n) return;
    const t = String(text || "").slice(0, 40);
    for (let i = st.pops.length - 1; i >= 0; i--) {
        const p = st.pops[i];
        if (!p.text && p.n === n && now - p.at < 1000) { p.text = t; p.str = ptsPopText(n, t); p.w = null; return; }
    }
    st.labels.push({ n, text: t, at: now });
    if (st.labels.length > 8) st.labels.shift();
}

// you: RY you, raid: its raid id (a new raid starts from 0 quietly)
export function ptsOnScore(st, you, now, raid) {
    if (!st || !you) return null;
    const pt = parts(you);
    const total = typeof you.score === "number" && isFinite(you.score) ? Math.round(you.score) : pt.total;
    if (raid !== undefined && raid !== st.raid) { st.raid = raid; st.last = null; st.labels.length = 0; st.pops.length = 0; }
    const prev = st.last;
    st.last = { total, b: pt.b, c: pt.c };
    if (!prev) return null;
    let d = total - prev.total;
    if (!d) return null;
    let w = 0;
    for (let i = 0; i < st.labels.length; i++) if (now - st.labels[i].at < PTS_LABEL_MS) st.labels[w++] = st.labels[i];
    st.labels.length = w;
    let out = null;
    // labelled awards first, oldest first, each only if it fits the change
    for (let i = 0; i < st.labels.length && d !== 0;) {
        const l = st.labels[i];
        if ((l.n > 0 && d > 0 && l.n <= d) || (l.n < 0 && d < 0 && l.n >= d)) {
            out = ptsPush(st, l.n, l.text, now);
            d -= l.n;
            st.labels.splice(i, 1);
        } else i++;
    }
    if (d > 0) {
        const db = Math.max(0, Math.min(d, pt.b - prev.b));
        if (db > 0) { out = ptsPush(st, db, "banked", now); d -= db; }
    }
    // a crown on you earns every second: the crown card says so
    if (d > 0 && you.crown) {
        const dc = Math.max(0, Math.min(d, pt.c - prev.c));
        d -= dc;
    }
    if (d !== 0) out = ptsPush(st, d, "", now);
    return out;
}

// the pops still up at `now`, oldest first (drops the finished ones)
export function ptsLive(st, now) {
    if (!st) return [];
    let w = 0;
    for (let i = 0; i < st.pops.length; i++) if (now - st.pops[i].at < PTS_POP_MS) st.pops[w++] = st.pops[i];
    st.pops.length = w;
    return st.pops;
}

// ── the vault deposit ────────────────────────────────────────────────────
// Playtest 5: carried 718 onto the vault, banked 418, died next to it, and
export const DEP_CUT_MS = 5000;
export function depositNote(v, carried, now) {
    if (!v) return null;
    const total = v.total | 0, rem = v.remaining | 0;
    if (total > 0 && rem > 0) return { text: "Banking " + num(total - rem) + " / " + num(total) + ": stay on the pad", hot: false };
    if (v.cutAt > 0 && now - v.cutAt < DEP_CUT_MS && (v.cutTotal | 0) > 0) {
        const left = Math.max(0, carried | 0);
        return {
            text: "Deposit stopped: banked " + num(v.cutBanked | 0) + " of " + num(v.cutTotal | 0) +
                (left > 0 ? ". Still carrying " + num(left) + ", get back on the pad" : ""),
            hot: true,
        };
    }
    return null;
}
