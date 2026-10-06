// Bank pops, the pure part (no DOM, no canvas): every rise of your Bank gets a

export const POP_MS = 2800;
export const LABEL_MS = 1500;   // a label waits this long for its bank rise
export const MAX_POPS = 3;

const num = (n) => String(Math.round(Math.abs(+n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function create() {
    return { last: -1, labels: [], pops: [] };
}

// the pop's one line: "+300 banked · survived the bounty", "+120 banked", "-300
export function popText(n, text) {
    if (n < 0) return "-" + num(n) + " spent" + (text && text !== "spent" ? " · " + text : "");
    return "+" + num(n) + " banked" + (text ? " · " + text : "");
}

function push(st, n, text, now) {
    const str = popText(n, text);
    // the same payout twice in a row (round 7: one milestone, two pops) is one pop
    for (let i = st.pops.length - 1; i >= 0; i--) {
        const q = st.pops[i];
        if (q.str === str && text && now - q.at < POP_MS) { q.at = now; return q; }
    }
    const p = { n, text: text || "", at: now, str };
    st.pops.push(p);
    while (st.pops.length > MAX_POPS) st.pops.shift();
    return p;
}

// A labelled payout
export function label(st, n, text, now) {
    n = n | 0;
    if (!st || n <= 0) return;
    const t = String(text || "").slice(0, 48);
    // a repeat of a label already waiting is the same payout
    for (const l of st.labels) if (l.n === n && l.text === t && now - l.at < LABEL_MS) return;
    for (let i = st.pops.length - 1; i >= 0; i--) {
        const p = st.pops[i];
        if (!p.text && p.n === n && now - p.at < 1000) { p.text = t; p.str = popText(n, t); return; }
    }
    st.labels.push({ n, text: t, at: now });
    if (st.labels.length > 8) st.labels.shift();
}

// A payout the bank already holds (it rose with a deposit): up now
export function note(st, n, text, now) {
    n = n | 0;
    if (!st || n <= 0) return null;
    return push(st, n, String(text || "").slice(0, 48), now);
}

// banked: the bank in this GEM packet
export function onBanked(st, banked, now, o) {
    if (!st) return null;
    banked = banked | 0;
    const prev = st.last;
    st.last = banked;
    if (prev < 0) return null;
    let d = banked - prev;
    if (d === 0) return null;
    // stale labels go (in place: GEM packets come with every gem)
    let w = 0;
    for (let i = 0; i < st.labels.length; i++) if (now - st.labels[i].at < LABEL_MS) st.labels[w++] = st.labels[i];
    st.labels.length = w;
    if (d < 0) return o && o.spent ? push(st, d, "", now) : null;
    let out = null;
    // labelled payouts first, oldest first, each only if it fits the rise
    for (let i = 0; i < st.labels.length && d > 0;) {
        const l = st.labels[i];
        if (l.n <= d) {
            out = push(st, l.n, l.text, now);
            d -= l.n;
            st.labels.splice(i, 1);
        } else i++;
    }
    if (d > 0 && !(o && o.deposit)) out = push(st, d, "", now);
    return out;
}

// the pops still up at `now`, oldest first (drops the finished ones)
export function live(st, now) {
    if (!st) return [];
    let w = 0;
    for (let i = 0; i < st.pops.length; i++) if (now - st.pops[i].at < POP_MS) st.pops[w++] = st.pops[i];
    st.pops.length = w;
    return st.pops;
}
