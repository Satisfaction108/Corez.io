// Raid points, the words

export const RULE = "Points = banked gems + kills & bonuses + crowns";
export const RULE_SHORT = "PTS = BANKED + KILLS + CROWNS";
export const RULE_BODY = "Whoever has the most points when the raid ends wins. Dying halves your points (you keep your perks), and you respawn with 60% of your banked gems. " +
    "Carried gems only count once you bank them. Past 5,000 in a raid, each banked gem counts half a point (you keep every gem). " +
    "Kills, streaks, bosses and quests give bonus points. " +
    "A crown gives points every second, but whoever kills you takes it and up to 30% of your kill and crown points.";

export const RULE_BODY_AO = "Your points add up all day and reset at 00:00 UTC. The top 3 on the daily board win gemdust and a crown by their name for the next day. " +
    "Dying halves your points (you keep your perks), and you respawn with 60% of your banked gems. Carried gems only count once you bank them. Past 5,000 in a day, each banked gem counts half a point (you keep every gem). " +
    "Kills, streaks, bosses, quests and events give bonus points. " +
    "The top 3 of each event get a crown that gives points every second, but whoever kills you takes it and up to 30% of your kill and crown points.";
export function ruleBody(ao) { return ao ? RULE_BODY_AO : RULE_BODY; }

const num = (n) => String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const fmt = num;

// Two different numbers, two different names (playtest 4 read "Banked 1,697" on
// Round 12: the HUD pill said "Bank: 16,547" next to "Banked this raid 11,060"
// on the card and read as a mismatch; it is the spendable wallet, so it says so.
export const BANK = "Spendable";
export const BANKED_RAID = "Banked this raid";

// The two bottom bars. Points is your share of the leader's score; Carried is
// how full the satchel is. Both are 0..1, and no bar is full just because it
// has a number in it when the leaderboard has no data yet.
export function pointsFrac(points, topScore) {
    const p = Math.max(0, +points || 0), top = Math.max(0, +topScore || 0);
    if (p <= 0) return 0;
    if (top <= 0) return 1;
    return Math.min(1, p / top);
}
export function carriedFrac(carried, cap) {
    const c = Math.max(0, +carried || 0), n = Math.max(0, +cap || 0);
    if (c <= 0 || n <= 0) return 0;
    return Math.min(1, c / n);
}
export const BANK_TIP = "Spendable: gems you can spend at shops";
export const BANK_TIP_BODY = "This includes gems from earlier raids and bounties. Spending lowers it, but never your points. " +
    "Points only count what you banked this raid.";
export const BANK_TIP_BODY_AO = "This includes gems from earlier days and bounties. Spending lowers it, but never your points. " +
    "Points only count what you banked today.";
export function bankTipBody(ao) { return ao ? BANK_TIP_BODY_AO : BANK_TIP_BODY; }

// The one points number the death card shows (header and the "Points: X" line)
export function cardPoints(you) {
    const y = you || {};
    if (typeof y.score === "number" && isFinite(y.score)) return Math.max(0, Math.round(y.score));
    return parts(y).total;
}

// The death card's headline: what you had when you died, before the halving
// (the board keeps the halved score). Older packets have no `died`.
export function diedPoints(you) {
    const y = you || {};
    const d = y.dl && y.dl.died;
    if (typeof d === "number" && isFinite(d)) return Math.max(0, Math.round(d));
    return cardPoints(y);
}

// > { b, k, c, total, earned, stolen } from RY you (old servers without `pts`
export function parts(you) {
    const y = you || {};
    const p = y.pts;
    if (p && typeof p === "object") {
        const b = p.b | 0, k = p.k | 0, c = p.c | 0;
        const stolen = Math.max(0, p.s | 0, -c);
        // g: the banked gems when past the soft line (b is the points they make)
        const out = { b, k, c, total: b + k + c, earned: Math.max(0, c + stolen), stolen };
        if ((p.g | 0) > b) { out.g = p.g | 0; out.soft = p.t | 0; }
        return out;
    }
    const total = y.score | 0, b = Math.min(total, y.banked | 0);
    return { b, k: total - b, c: 0, total, earned: 0, stolen: 0 };
}

// The death card's points line and its reason
// kept: the part of the satchel that comes back with you (m[18 + killers])
export function deathLine(you, carried, savingsLost = 0, kept = 0) {
    const y = you || {};
    const dl = y.dl || {};
    const crownPts = Math.max(0, dl.p | 0), half = Math.max(0, dl.h | 0);
    const lostPts = crownPts + half;
    const sav = Math.max(0, savingsLost | 0);
    // after the loss, the same number as the card's POINTS header
    const head = "Points: " + num(cardPoints(y));
    let lost;
    if (crownPts > 0) lost = "lost " + num(lostPts) + ": " + (dl.by ? dl.by + " took your crown" : "your crown was taken") + (half ? ", then half the rest" : "");
    else if (half > 0) lost = "lost " + num(half) + ": dying halves your points" + (dl.cr ? ", your crown fell" : "");
    else if (sav > 0) lost = dl.cr ? "points lost: 0, your crown fell" : "points lost: 0";
    else if (dl.cr) lost = "lost 0: your crown fell";
    else lost = "lost 0";
    const c = Math.max(0, (carried != null ? carried : dl.c) | 0);
    const k = Math.max(0, kept | 0);
    const sub = k > 0
        ? "You kept " + num(k) + " carried gems and dropped " + num(c) + ". Bank sooner to keep them all."
        : c > 0 ? "You dropped " + num(c) + " carried gems. Bank sooner next time." : "";
    return { head, lost, sub, hurt: lostPts > 0, savings: savingsLine(sav) };
}
export function savingsLine(n) {
    n = Math.max(0, n | 0);
    return n > 0 ? "Dying cost " + num(n) + " banked gems. You keep 60% for your next life." : "";
}

// The three parts as death card / results tiles: [label, value, icon]
export function tiles(you) {
    const pt = parts(you);
    return [
        // past the soft line the tile says how many gems made those points
        pt.g > pt.b ? bankTile(pt) : ["BANKED THIS RAID", num(pt.b), "gem"],
        ["KILLS & BONUSES", num(pt.k), "combat"],
        [pt.stolen > 0 ? "CROWNS · " + num(pt.stolen) + " STOLEN" : "CROWNS", num(pt.earned), "crown"],
    ];
}

// Oct 6 2026 playtest: "BANKED 5,545 GEMS" over 5,273 read as a mismatch. Past
// the soft line the tile is the POINTS (labelled so) and a line says where they
// came from. One set of words for the death card, the results and the podium.
export const BANK_PTS_LABEL = "BANKED PTS";
export function bankTile(pt) { return [BANK_PTS_LABEL, num(pt.b), "gem"]; }
// short form under a number: "from 5,545 gems (past 5,000 counts half)"
export function bankFrom(pt) {
    return pt && pt.g > pt.b ? "from " + num(pt.g) + " gems (past " + num(pt.soft || 5000) + " counts half)" : "";
}
// the full sentence (death card text block)
export function bankSoftLine(pt) {
    return pt && pt.g > pt.b ? "Banked: " + num(pt.g) + " gems = " + num(pt.b) + " pts (past " + num(pt.soft || 5000) + ", each gem counts half)" : "";
}
// the podium's line for a top-3 row: gems are gems
export function podiumBanked(gems) { return num(Math.max(0, gems | 0)) + " gems banked this raid"; }

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
    return { text: "Carrying " + num(n) + ": bank it", sub: danger ? "If you die, you'll drop most of it" : "It only counts as points once you bank it", hot: danger };
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
        line2: lose > 0 ? "If killed: -" + num(lose) + " pts, then half the rest." : "If killed: you lose the crown and half your points.",
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
                (left > 0 ? ". You still have " + num(left) + " on you, so get back on the pad" : ""),
            hot: true,
        };
    }
    return null;
}
