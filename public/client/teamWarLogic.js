export const BLUE = 1, RED = 2;
export const INTRO_KEY = "dwTeamIntro_v1";
export const CALL_RADAR = 1, CALL_SUPPLY = 2, CALL_TITAN_MIDDLE = 3, CALL_TITAN_FLANK = 4, CALL_CANCEL = 0;
export const CHANNEL_MS = 3000;

export function teamName(n) { return n === BLUE ? "Blue" : n === RED ? "Red" : ""; }
export function otherTeam(n) { return n === BLUE ? RED : n === RED ? BLUE : 0; }
export function teamNoOfId(tm) {
    if (tm === -1 || tm === 1) return BLUE;
    if (tm === -2 || tm === 2) return RED;
    return 0;
}
export function teamIdOfNo(n) { return n === BLUE ? -1 : n === RED ? -2 : 0; }

export function splitFrac(s) {
    const b = Math.max(0, +(s && s[0]) || 0), r = Math.max(0, +(s && s[1]) || 0);
    return b + r > 0 ? b / (b + r) : 0.5;
}

export function easeTo(cur, target, dtMs, perFrame) {
    if (!isFinite(cur)) return target;
    const k = 1 - Math.pow(1 - perFrame, Math.max(0, Math.min(250, dtMs)) / 16.7);
    const v = cur + (target - cur) * k;
    return Math.abs(v - target) < 0.0005 ? target : v;
}

export function meterPct(frac) { return Math.floor(Math.max(0, Math.min(1, +frac || 0)) * 100); }

export function titanCdLine(secs) { return "Titan ready again in " + secs + " s"; }

export function meterLine(frac, titanOut, tcd) {
    if (titanOut) return "Titan out";
    if (tcd > 0) return titanCdLine(tcd);
    if (frac >= 0.999) return "Titan ready";
    return "War Meter " + meterPct(frac) + "%";
}

export function meterHint(frac, titanOut, tcd) {
    if (titanOut) return { text: "Your Titan is out, go help it", hot: false };
    if (tcd > 0) return { text: titanCdLine(tcd), hot: false };
    if (frac >= 0.999) return { text: "Titan ready! Go to your War Pad", hot: true };
    return { text: "Bank gems and win fights to fill it", hot: false };
}

export function titanReady(frac, titanOut, tcd) { return frac >= 0.999 && !titanOut && !(tcd > 0); }

export function meterGain(prev, frac, need) {
    if (!prev || !(need > 0) || prev.need !== need) return 0;
    const d = Math.round((frac - prev.frac) * need);
    return d > 0 ? d : 0;
}

export function secsLeft(secs, sinceMs) {
    const v = (+secs || 0) - Math.max(0, sinceMs || 0) / 1000;
    return v > 0 ? Math.ceil(v) : 0;
}

export function callButtons(twy, sinceMs) {
    const y = twy || {};
    const can = Array.isArray(y.can) ? y.can : [];
    const cd = secsLeft(y.cd, sinceMs);
    const tcd = secsLeft(y.tcd, sinceMs);
    const out = y.tOut ? 1 : 0;
    const small = (i, label, sub) => ({
        n: i + 1, label,
        enabled: !!can[i] && cd <= 0,
        sub: cd > 0 ? "Ready in " + cd + "s" : can[i] ? sub : i === 0 ? "Needs 25% of the meter" : "Needs 40% of the meter",
    });
    const titan = (n, label, sub) => ({
        n, label,
        enabled: !!can[2] && !out && tcd <= 0,
        sub: out ? "Your Titan is out" : tcd > 0 ? "Ready again in " + tcd + " s" : can[2] ? sub : "Needs a full meter",
    });
    return [
        small(0, "Radar Sweep 25%", "Shows every enemy"),
        small(1, "Supply Drop 40%", "An epic crate drop"),
        titan(CALL_TITAN_MIDDLE, "Titan: Middle", "Hold 3s on the pad"),
        titan(CALL_TITAN_FLANK, "Titan: Flank", "Hold 3s on the pad"),
    ];
}

export function laneLine(l) { return l === "flank" ? "Around the flank" : "Down the middle"; }
export function titanState(st) { return st === "siege" ? "Sieging" : st === "fight" ? "Fighting" : "Marching"; }

export function teamTops(board) {
    const tops = {};
    for (const row of board || []) {
        if (!row) continue;
        const t = row.t | 0;
        if (!t || tops[t]) continue;
        tops[t] = row;
    }
    return tops;
}

export function isTeamTop(tops, row) {
    if (!row || !tops) return false;
    const top = tops[row.t | 0];
    return !!top && (top === row || (top.id != null && top.id === row.id) || (top.place === row.place && top.name === row.name));
}

export function padFor(pads, team) {
    for (const p of pads || []) if (p && (p.t | 0) === team) return p;
    return null;
}

export function onPad(pad, x, y, slack) {
    if (!pad || !isFinite(x) || !isFinite(y)) return false;
    return Math.hypot(x - pad.x, y - pad.y) < (pad.r || 95) + (slack || 0);
}

export function tailAt(tails, x, y) {
    let best = null, bd = 120 * 120;
    for (const t of tails || []) {
        if (!t) continue;
        const d = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y);
        if (d < bd) { bd = d; best = t; }
    }
    return best;
}

export function introLines(team) {
    return {
        title: "You're on the " + (teamName(team) || "Blue") + " team.",
        body: "Bank gems at your team's vaults to raise the team score. Fill the War Meter, then call a Titan from your War Pad.",
    };
}

export function padKeyIndex(e, typing) {
    if (!e || typing || e.repeat || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return -1;
    const code = String(e.code || "");
    let d = -1;
    const m = /^Digit([1-9])$/.exec(code);
    if (m) d = +m[1];
    else if (!code && e.keyCode >= 49 && e.keyCode <= 57) d = e.keyCode - 48;
    return d >= 1 && d <= 4 ? d : -1;
}

export const BASE_DEATH = "You drove into the enemy base";
export const BASE_DEATH_TIP = "Enemy bases are deadly, so keep out of the other team's base.";
