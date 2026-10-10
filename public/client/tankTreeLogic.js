export const TILE = 64;
export const CELL = 96;
export const NAME_H = 20;
export const ROW = 136;
export const STACK = 92;
export const BAND_GAP = 150;
export const MAX_INST = 6000;
export const T5_TIER = 5;

function nameOf(m) {
    if (!m) return "?";
    const n = m.upgradeName != null && m.upgradeName !== "" ? m.upgradeName : m.name;
    return String(n || "?");
}

function mockOf(mockups, key) {
    return mockups ? mockups[parseInt(String(key).split("-")[0], 10)] : null;
}

export function buildGraph(mockups, rootKeys) {
    const tanks = new Map();
    const tankOf = (key) => {
        let t = tanks.get(key);
        if (!t) {
            const m = mockOf(mockups, key);
            t = { key, name: nameOf(m), kids: [], kidTiers: [], parents: [], known: !!m, spr: null, tier: 0 };
            tanks.set(key, t);
            if (m && Array.isArray(m.upgrades)) {
                for (const u of m.upgrades) {
                    if (!u || u.index == null) continue;
                    const k = String(u.index);
                    if (t.kids.indexOf(k) !== -1) continue;
                    t.kids.push(k);
                    t.kidTiers.push(+u.tier || 0);
                }
            }
        }
        return t;
    };
    const roots = [];
    for (const r of rootKeys || []) {
        const k = String(r);
        if (roots.indexOf(k) === -1) roots.push(k);
    }
    const q = roots.slice();
    const seen = new Set(q);
    while (q.length) {
        const t = tankOf(q.shift());
        for (const k of t.kids) {
            if (!seen.has(k)) { seen.add(k); q.push(k); }
            tankOf(k);
        }
    }
    const inst = [];
    const add = (key, parent, tier, ci, depth) => {
        const i = inst.length;
        inst.push({ i, tank: tanks.get(key), parent, kids: [], tier, ci, depth, x: 0, y: 0, stacked: false, face: "", lip: "" });
        return i;
    };
    const walk = (i, chain) => {
        const n = inst[i], t = n.tank;
        if (t.tier === 0 || n.tier < t.tier) t.tier = n.tier;
        for (let j = 0; j < t.kids.length; j++) {
            if (inst.length >= MAX_INST) return;
            const k = t.kids[j];
            const tier = t.kidTiers[j] + 1;
            if (chain.has(k) || tier <= n.tier) continue;
            const c = add(k, i, tier, j, n.depth + 1);
            n.kids.push(c);
            chain.add(k);
            walk(c, chain);
            chain.delete(k);
        }
    };
    for (let r = 0; r < roots.length; r++) {
        const i = add(roots[r], -1, 1, r, 0);
        walk(i, new Set([roots[r]]));
    }
    for (const n of inst) if (n.parent >= 0) { const pk = inst[n.parent].tank.key; if (n.tank.parents.indexOf(pk) === -1) n.tank.parents.push(pk); }
    for (const t of tanks.values()) {
        const real = [];
        for (let j = 0; j < t.kids.length; j++) if (t.tier > 0 && t.kidTiers[j] + 1 > t.tier) real.push(t.kids[j]);
        t.up = real;
    }
    let maxTier = 1;
    for (const n of inst) if (n.tier > maxTier) maxTier = n.tier;
    return { tanks, inst, roots: inst.filter(n => n.parent === -1).map(n => n.i), maxTier };
}

export function findInst(g, key) {
    if (!g || key == null) return -1;
    const k = String(key), head = k.split("-")[0];
    let loose = -1;
    for (const n of g.inst) {
        if (n.tank.key === k) return n.i;
        if (loose === -1 && n.tank.key.split("-")[0] === head) loose = n.i;
    }
    return loose;
}

export function pathOf(g, i) {
    const p = [];
    while (i >= 0) { p.push(i); i = g.inst[i].parent; }
    return p.reverse();
}

export function subtreeLeafs(g, i, open) {
    const n = g.inst[i];
    if (!open[i] || !n.kids.length) return 1;
    let s = 0;
    for (const k of n.kids) s += subtreeLeafs(g, k, open);
    return s;
}

export function focusOpen(g, cur, expanded, budget = 24) {
    const N = g.inst.length;
    const open = new Uint8Array(N);
    if (cur < 0 || cur >= N) {
        for (const r of g.roots) open[r] = 1;
    } else {
        for (const p of pathOf(g, cur)) open[p] = 1;
        let frontier = [cur];
        let shown = g.inst[cur].kids.length;
        for (let level = 0; level < 6; level++) {
            const next = [];
            let add = 0;
            for (const f of frontier) for (const k of g.inst[f].kids) if (g.inst[k].kids.length) { next.push(k); add += g.inst[k].kids.length - 1; }
            if (!next.length || shown + add > budget) break;
            for (const k of next) open[k] = 1;
            shown += add;
            frontier = next;
        }
    }
    if (expanded) for (const [i, v] of expanded) if (i >= 0 && i < N) open[i] = v ? 1 : 0;
    if (cur >= 0 && cur < N) for (const p of pathOf(g, cur)) if (p !== cur) open[p] = 1;
    return open;
}

export function allOpen(g) {
    const open = new Uint8Array(g.inst.length);
    open.fill(1);
    return open;
}

export function visibleOf(g, open) {
    const N = g.inst.length;
    const vis = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
        const p = g.inst[i].parent;
        vis[i] = p === -1 ? 1 : (vis[p] && open[p] ? 1 : 0);
    }
    return vis;
}

export function layout(g, open, vis, bands) {
    const N = g.inst.length;
    const segs = [], hiSegs = [], rows = [], bandBoxes = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const cx = (i) => g.inst[i].x + TILE / 2;
    const bottom = (i) => g.inst[i].y + TILE + NAME_H;
    const visKids = (i) => { const out = []; if (!open[i]) return out; for (const k of g.inst[i].kids) if (vis[k]) out.push(k); return out; };
    const trueLeaf = (k) => !g.inst[k].kids.length;

    let sx = 0, top = 0, topTier = 1, bandMaxY = 0;
    const rowY = (tier) => top + (tier - topTier) * ROW;
    const place = (i) => {
        const n = g.inst[i];
        n.y = rowY(n.tier);
        n.stacked = false;
        const kids = visKids(i);
        if (!kids.length) { n.x = sx; sx += CELL; return; }
        const leaves = [], branch = [];
        for (const k of kids) (trueLeaf(k) ? leaves : branch).push(k);
        const stack = leaves.length >= 2;
        let first = Infinity, last = -Infinity;
        const list = stack ? branch : kids;
        for (const k of list) { place(k); first = Math.min(first, g.inst[k].x); last = Math.max(last, g.inst[k].x); }
        if (stack) {
            let t0 = Infinity;
            for (const k of leaves) t0 = Math.min(t0, g.inst[k].tier);
            const y0 = rowY(t0);
            for (let j = 0; j < leaves.length; j++) {
                const kn = g.inst[leaves[j]];
                kn.x = sx; kn.y = y0 + j * STACK; kn.stacked = true;
            }
            first = Math.min(first, sx); last = Math.max(last, sx);
            sx += CELL;
        }
        n.x = (first + last) / 2;
    };
    const edges = (i, hiSet) => {
        const n = g.inst[i];
        const kids = visKids(i);
        if (!kids.length) return;
        const px = cx(i), pb = bottom(i);
        const barY = pb + (ROW - TILE - NAME_H) * 0.42;
        let lo = px, hi = px, stackX = null, stackBot = 0;
        let hiKid = -1;
        for (const k of kids) {
            const kn = g.inst[k];
            if (hiSet && hiSet.has(k)) hiKid = k;
            if (kn.stacked) {
                const lx = kn.x + TILE / 2;
                stackX = lx;
                stackBot = Math.max(stackBot, kn.y + TILE / 2);
                lo = Math.min(lo, lx); hi = Math.max(hi, lx);
            } else {
                const kx = cx(k);
                lo = Math.min(lo, kx); hi = Math.max(hi, kx);
                segs.push(kx, barY, kx, kn.y);
            }
        }
        segs.push(px, pb, px, barY);
        if (hi > lo) segs.push(lo, barY, hi, barY);
        if (stackX != null) segs.push(stackX, barY, stackX, stackBot);
        if (hiKid >= 0) {
            const kn = g.inst[hiKid], kx = cx(hiKid);
            hiSegs.push(px, pb, px, barY);
            if (kx !== px) hiSegs.push(px, barY, kx, barY);
            hiSegs.push(kx, barY, kx, kn.stacked ? kn.y + TILE / 2 : kn.y);
        }
        for (const k of kids) edges(k, hiSet);
    };
    const bound = (i) => {
        const n = g.inst[i];
        if (!vis[i]) return;
        minX = Math.min(minX, n.x - (CELL - TILE) / 2); maxX = Math.max(maxX, n.x + TILE + (CELL - TILE) / 2);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y + TILE + NAME_H);
        bandMaxY = Math.max(bandMaxY, n.y + TILE + NAME_H);
        if (open[i]) for (const k of n.kids) bound(k);
    };
    const rowsFor = (t0, t1, y0) => { for (let t = t0; t <= t1; t++) rows.push(y0 + (t - t0) * ROW, t); };
    const maxTierBelow = (i) => { let m = g.inst[i].tier; if (open[i]) for (const k of g.inst[i].kids) if (vis[k]) m = Math.max(m, maxTierBelow(k)); return m; };

    const hiSet = bands && bands.hi ? bands.hi : null;
    if (bands && bands.whole) {
        let y = 0;
        for (const r of g.roots) {
            const rn = g.inst[r];
            rn.x = 0; rn.y = y; rn.stacked = false;
            minX = Math.min(minX, -(CELL - TILE) / 2); maxX = Math.max(maxX, TILE + (CELL - TILE) / 2);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y + TILE + NAME_H);
            rows.push(y, rn.tier);
            let by = y + ROW;
            const kids = visKids(r);
            const trunkX = TILE / 2;
            let trunkEnd = y + TILE + NAME_H;
            for (const k of kids) {
                const kn = g.inst[k];
                top = by; topTier = kn.tier; sx = CELL * 1.5; bandMaxY = by;
                place(k);
                bound(k);
                edges(k, hiSet);
                rowsFor(kn.tier, maxTierBelow(k), by);
                const midY = kn.y + TILE / 2;
                segs.push(trunkX, midY, kn.x, midY);
                if (hiSet && hiSet.has(k)) hiSegs.push(trunkX, y + TILE + NAME_H, trunkX, midY, trunkX, midY, kn.x, midY);
                trunkEnd = midY;
                bandBoxes.push(kn.tier, by, bandMaxY);
                by = bandMaxY + BAND_GAP;
            }
            if (kids.length) segs.push(trunkX, y + TILE + NAME_H, trunkX, trunkEnd);
            y = by;
        }
    } else {
        sx = 0; top = 0; topTier = 1;
        let mt = 1;
        for (const r of g.roots) { place(r); bound(r); edges(r, hiSet); mt = Math.max(mt, maxTierBelow(r)); }
        rowsFor(1, mt, 0);
    }
    for (let i = 0; i < N; i++) if (!vis[i]) { g.inst[i].x = -1e9; g.inst[i].y = -1e9; }
    if (!(maxX > minX)) { minX = 0; maxX = TILE; minY = 0; maxY = TILE; }
    return { segs: Float32Array.from(segs), hiSegs: Float32Array.from(hiSegs), rows: Float32Array.from(rows), minX, minY, maxX, maxY };
}

export function clampZoom(z, fit) {
    const lo = Math.min(0.35, fit * 0.85);
    return Math.max(lo, Math.min(3, z));
}

export function fitZoom(box, w, h) {
    const bw = Math.max(1, box.maxX - box.minX), bh = Math.max(1, box.maxY - box.minY);
    return Math.min(w / bw, h / bh);
}

export function zoomAbout(view, f, sx, sy, w, h, fit) {
    const z0 = view.z, z1 = clampZoom(z0 * f, fit);
    const wx = view.x + (sx - w / 2) / z0, wy = view.y + (sy - h / 2) / z0;
    view.z = z1;
    view.x = wx - (sx - w / 2) / z1;
    view.y = wy - (sy - h / 2) / z1;
    return view;
}

export function clampView(view, box, w, h) {
    const hw = w / 2 / view.z, hh = h / 2 / view.z;
    const x0 = box.minX - hw * 0.6, x1 = box.maxX + hw * 0.6, y0 = box.minY - hh * 0.6, y1 = box.maxY + hh * 0.6;
    view.x = x1 - x0 < hw * 2 ? (box.minX + box.maxX) / 2 : Math.max(x0 + hw, Math.min(x1 - hw, view.x));
    view.y = y1 - y0 < hh * 2 ? (box.minY + box.maxY) / 2 : Math.max(y0 + hh, Math.min(y1 - hh, view.y));
    return view;
}

export function hitNode(g, vis, wx, wy) {
    for (let i = g.inst.length - 1; i >= 0; i--) {
        if (!vis[i]) continue;
        const n = g.inst[i];
        if (wx >= n.x - 4 && wx <= n.x + TILE + 4 && wy >= n.y - 4 && wy <= n.y + TILE + NAME_H) return i;
    }
    return -1;
}

export function hiddenKids(g, open, i) {
    const n = g.inst[i];
    return open[i] ? 0 : n.kids.length;
}

export function listNames(names, max) {
    if (!names.length) return "";
    if (names.length <= max) return names.join(", ");
    return names.slice(0, max).join(", ") + " and " + (names.length - max) + " more";
}
