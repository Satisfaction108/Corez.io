// The end screen's progress rows (raidFinale.js "Your raid" plate, round 9): rank

const rankByRaid = { id: 0, rp: 0, n: 0 };

// RK (delta) / RKP (bonusRP) as they land, summed per raid
export function addRank(raidId, delta) {
    raidId |= 0;
    if (raidId !== rankByRaid.id) { rankByRaid.id = raidId; rankByRaid.rp = 0; rankByRaid.n = 0; }
    rankByRaid.rp += delta | 0;
    rankByRaid.n++;
}
export function rankThisRaid(raidId) { return (raidId | 0) === rankByRaid.id ? rankByRaid.rp : 0; }
export function rankSeen(raidId) { return (raidId | 0) === rankByRaid.id && rankByRaid.n > 0; }

const num = (n) => Math.round(n).toLocaleString("en-US");
function dur(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60);
    return m > 0 ? m + "m " + String(s % 60).padStart(2, "0") + "s" : s + "s";
}
const read = (st, k) => { try { return +st.getItem(k) || 0; } catch (e) { return 0; } };
const write = (st, k, v) => { try { st.setItem(k, String(v)); } catch (e) { /* private mode */ } };

// a death (socketinit 'F'): the longest life ever, kept on this device
export function noteLife(secs, store) {
    if (!store || !(secs > 0)) return;
    if (secs > read(store, "dwBestLife")) write(store, "dwBestLife", Math.round(secs));
}
// the raid's end: best raid by points, once per raid id
export function noteRaid(raidId, score, store) {
    if (!store) return { best: 0, isBest: false, prev: 0 };
    const prev = read(store, "dwBestRaid");
    const isBest = (score | 0) > prev && (score | 0) > 0;
    if (isBest && read(store, "dwBestRaidId") !== (raidId | 0)) { write(store, "dwBestRaid", score | 0); write(store, "dwBestRaidId", raidId | 0); }
    return { best: Math.max(prev, score | 0), isBest, prev };
}

// o: { guest, rank: AC rank snapshot, rp: rank points this raid, rpSeen, dust
export function rows(o) {
    const out = [];
    const r = o.rank;
    if (o.guest || !r) {
        out.push({ k: "RANK", t: "Sign up to get ranked and keep your gemdust", col: "lilac" });
    } else if (r.division == null) {
        const pl = r.placement || {};
        const left = Math.max(0, (pl.of | 0) - (pl.lives | 0));
        out.push({ k: "RANK", t: left > 0 ? "Placement: " + left + " more " + (left === 1 ? "life" : "lives") + " to get your rank" : "Placement is done, so your rank shows up next life", col: "gold" });
    } else if (!o.rankCard) {
        const d = o.rp | 0;
        const head = o.rpSeen ? (d >= 0 ? "+" : "-") + num(Math.abs(d)) + " RP this raid" : (r.name || "Ranked");
        const toNext = Math.max(0, (r.size | 0) - (r.into | 0));
        const tail = (r.size | 0) > 0 ? (toNext > 0 ? num(toNext) + " RP to the next rank" : "next rank on your next win") : "";
        out.push({ k: "RANK", t: head + (tail ? ", " + tail : ""), col: d < 0 ? "text" : "gold" });
    }
    if (o.nu && o.nu.p > 0) {
        const have = Math.max(0, +o.dust || 0);
        const need = Math.max(0, o.nu.p - have);
        const fmt = (v) => +(+v).toFixed(v < 10 ? 1 : 0);
        out.push({ k: "NEXT UNLOCK", t: need > 0 ? fmt(need) + " gemdust to " + o.nu.n + " (" + fmt(have) + " / " + fmt(o.nu.p) + ")" : o.nu.n + " is ready in the lobby shop", col: need > 0 ? "play" : "gold" });
    } else if (o.guest) {
        out.push({ k: "NEXT UNLOCK", t: "Sign up to spend gemdust on skins", col: "text" });
    }
    const life = Math.max(o.bestLife || 0, o.lifeNow || 0);
    const raid = Math.max(o.bestRaid | 0, 0);
    const bits = [];
    if (raid > 0) bits.push((o.isBest ? "New best raid: " : "Best raid: ") + num(raid) + " pts");
    if (life > 0) bits.push("Longest life: " + dur(life));
    if (bits.length) out.push({ k: "BESTS", t: bits.join("  ·  "), col: o.isBest ? "gold" : "text" });
    return out.slice(0, 3);
}
