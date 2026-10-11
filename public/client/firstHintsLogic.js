export const KEY = "dwSeenHints_v2";
export const SHOW_MS = 7000;
export const GAP_MS = 1200;
export const SETTLE_MS = 2500;

export const HINTS = {
    shard: {
        title: "Core Shard",
        body: "That spiky purple crystal is a Core shard. Shoot the rock it's in to break it, and you'll get a big gem worth far more than copper.",
    },
    vault: {
        title: "Vault",
        body: "This is a vault. Drive onto it to bank the gems you're carrying, so you keep them even if you die.",
    },
    shop: {
        title: "Shop",
        body: "This is a shop. Drive onto it to spend your banked gems on abilities, drills and gear.",
    },
    core: {
        title: "The Core",
        body: "That spiky thing is the Core. Everyone who hits it gets a share of its gems, but it fights back, so keep moving!",
    },
};

export function parseSeen(raw) {
    const out = new Set();
    if (!raw) return out;
    try {
        const v = JSON.parse(raw);
        const list = Array.isArray(v) ? v : (v && typeof v === "object" ? Object.keys(v).filter(k => v[k]) : []);
        for (const id of list) if (HINTS[id]) out.add(id);
    } catch (e) { }
    return out;
}

export function serializeSeen(seen) {
    return JSON.stringify([...seen].filter(id => HINTS[id]).sort());
}

export function createState(seen) {
    return { seen: seen instanceof Set ? seen : new Set(seen || []), queue: [], cur: null, shownMs: 0, lastT: 0, endAt: -1e9 };
}

export function notice(s, id) {
    if (!HINTS[id] || s.seen.has(id) || s.cur === id || s.queue.includes(id)) return false;
    s.queue.push(id);
    return true;
}

export function dismiss(s, id, t) {
    if (!s.cur || (id && s.cur !== id)) return false;
    s.cur = null;
    s.shownMs = 0;
    s.endAt = t;
    return true;
}

export function step(s, t, ctx = {}) {
    const dt = s.lastT ? Math.max(0, Math.min(250, t - s.lastT)) : 0;
    s.lastT = t;
    const visible = ctx.visible || new Set();
    const reached = ctx.reached || new Set();
    let shown = null;
    if (s.cur) {
        if (reached.has(s.cur)) { dismiss(s, s.cur, t); return { show: null, why: "reached" }; }
        if (ctx.blocked) return { show: null, held: s.cur };
        s.shownMs += dt;
        if (s.shownMs >= SHOW_MS) { dismiss(s, s.cur, t); return { show: null, why: "timeout" }; }
        return { show: s.cur };
    }
    if (ctx.blocked || t - s.endAt < GAP_MS) return { show: null };
    for (let i = 0; i < s.queue.length; i++) {
        const id = s.queue[i];
        if (s.seen.has(id)) { s.queue.splice(i--, 1); continue; }
        if (!visible.has(id) || reached.has(id)) continue;
        s.queue.splice(i, 1);
        s.cur = id;
        s.shownMs = 0;
        s.seen.add(id);
        shown = id;
        break;
    }
    return { show: s.cur, started: shown };
}

function overlaps(a, b, pad) {
    return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

export function place(W, H, w, h, avoid = [], pad = 8) {
    const cx = W / 2, cy = H / 2;
    const lefts = [cx + Math.max(90, W * 0.08), cx + Math.max(70, W * 0.05), cx + Math.max(130, W * 0.14)];
    const tops = [cy + 10, cy + 50, cy - 40, cy + 90, cy - 90, cy + 140, cy - 140];
    for (const top of tops) {
        for (const left of lefts) {
            const r = { x: Math.round(Math.min(left, W - w - 12)), y: Math.round(Math.max(8, Math.min(top, H - h - 12))), w, h };
            if (r.x < cx + 40) continue;
            if (!avoid.some(a => a && overlaps(r, a, pad))) return r;
        }
    }
    return null;
}
