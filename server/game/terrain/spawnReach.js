// Spawn reachability: can a body dropped at (x, y) get out?
//
// Voronoi cells are graph nodes; two cells are neighbours when they share an
// edge wide enough for a tank (precomputed once per terrain build). A cell is
//   open      mined out / canyon (pits, pads, plaza) and not about to regrow
//   closing   mined out but due to start regrowing within REGROW_SOON_MS
//   rock      alive rock no tougher than HARD_ROCK_EQ fresh plain rocks of
//             its biome (plain rock, softened pit rock, damaged ore): diggable
//   wall      emerald, a rock that is regrowing right now, fresh ore (copper
//             is 1.8x plain, shard 3x, emerald 6x), anything outside the zone
//
// A spot escapes when, from its (open) start cell, without crossing a wall:
//   (a) it reaches an open region (>= OPEN_REGION_CELLS connected open cells
//       in the zone) for at most EXIT_BUDGET plain rocks' worth of HP, or
//   (b) it can tunnel ESCAPE_HOPS cells out through diggable rock.
// Searches are capped at MAX_NODES. exitPath() returns the cells to break to
// get out (landing-pocket exit tunnel and storm rescue in dig_royale.js).
const { ORE, REGROW } = require('./terrainGrid.js');

const REACH = {
    MIN_EDGE_FRAC: 0.3,       // shared edge >= this share of a cell's width counts as a doorway
    OPEN_REGION_CELLS: 5,     // (a) an open patch this big (in the zone) is a way out
    EXIT_BUDGET: 2.0,         // (a) at most this many fresh plain rocks' HP between you and it
    ESCAPE_HOPS: 3,           // (b) or this many cells out through diggable rock
    HARD_ROCK_EQ: 1.05,       // a rock with more HP than this many fresh plain rocks is a wall
    REGROW_SOON_MS: 8000,     // a mined-out cell due to regrow within this is "closing", not open
    MAX_NODES: 600,           // search cap per query
};

// ── lattice helpers ─────────────────────────────────────────────────────────
const KEY = (i, j) => i * 100003 + j;
const adjCache = new WeakMap();   // grid.rocks Map -> Map(key -> [neighbour rocks])

function adjacency(grid) {
    const rocks = grid && grid.rocks;
    if (!rocks) return null;
    let adj = adjCache.get(rocks);
    if (adj) return adj;
    adj = new Map();
    const w = grid._cellWorld || 100;
    const minEdge2 = (w * REACH.MIN_EDGE_FRAC) ** 2;
    const tol = Math.max(0.5, w * 0.004);
    for (const r of rocks.values()) {
        if (!r.worldPoly) continue;
        const list = [];
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
            if (!di && !dj) continue;
            const o = rocks.get(KEY(r.vi + di, r.vj + dj));
            if (!o || !o.worldPoly) continue;
            const shared = [];
            for (const p of r.worldPoly) for (const q of o.worldPoly) {
                if (Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol) { shared.push(p); break; }
            }
            if (shared.length < 2) continue;
            let far = 0;
            for (let a = 0; a < shared.length; a++) for (let b = a + 1; b < shared.length; b++) {
                const d2 = (shared[a][0] - shared[b][0]) ** 2 + (shared[a][1] - shared[b][1]) ** 2;
                if (d2 > far) far = d2;
            }
            if (far >= minEdge2) list.push(o);
        }
        adj.set(r.k, list);
    }
    adjCache.set(rocks, adj);
    return adj;
}

// The lattice cell containing (wx, wy), alive or not (pointInRock's lookup).
function cellAt(grid, wx, wy) {
    if (!grid || !grid.rocks || !grid._hash2 || !grid._voroRockSz) return null;
    const halfW = grid.cols * grid.cellSize / 2, halfH = grid.rows * grid.cellSize / 2;
    const s = grid._voroRockSz * grid.cellSize;
    const px = (wx + halfW) / s, py = (wy + halfH) / s;
    const nx = Math.floor(px), ny = Math.floor(py);
    let best = Infinity, bi = 0, bj = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const [hx, hy] = grid._hash2(nx + di, ny + dj);
        const sx = nx + di + hx, sy = ny + dj + hy;
        const d = (px - sx) ** 2 + (py - sy) ** 2;
        if (d < best) { best = d; bi = nx + di; bj = ny + dj; }
    }
    return grid.rocks.get(KEY(bi, bj)) || null;
}

const cx = (r) => r.worldCx || r.wx;
const cy = (r) => r.worldCy || r.wy;

function plainHp(grid) {
    const base = (grid && grid.plainRockHealth) || 1;
    return base * ((global.royaleMods && global.royaleMods.rockHpMult) || 1);
}

// When a mined-out cell starts regrowing (Infinity: not on its own).
function regrowDueAt(grid, rock, now) {
    if (rock.alive || rock.growing) return now;
    if (rock.canyon || !rock.diedAt || !rock.worldPoly) return Infinity;
    if (rock.chestLock || rock._chestHolds > 0) return Infinity;
    try { if (grid._inNoRegrowZone && grid._inNoRegrowZone(rock, now)) return Infinity; } catch { /* */ }
    try { if (grid._hasLivingNeighbour && !grid._hasLivingNeighbour(rock)) return Infinity; } catch { /* */ }
    let delay = REGROW.BASE_DELAY_MS;
    try {
        const side = grid._sideOf ? grid._sideOf(rock) : -1;
        const d = grid._regrowDelay || [delay, delay];
        delay = side === -1 ? Math.min(d[0], d[1]) : d[side];
        const bl = grid._bloomNow;
        if (bl && ((rock.wx - bl.x) ** 2 + (rock.wy - bl.y) ** 2) <= bl.r * bl.r) delay = REGROW.BLOOM_DELAY_MS;
    } catch { /* */ }
    return Math.max(rock.diedAt + delay, rock.noRegrowUntil || 0);
}

// zone: { x, y, r } (cells whose centre is outside are walls), or null
function inZone(zone, r) {
    if (!zone) return true;
    return (cx(r) - zone.x) ** 2 + (cy(r) - zone.y) ** 2 <= zone.r * zone.r;
}

// 'open' | 'closing' | 'rock' | 'wall', plus the HP cost (in fresh plain rocks)
// opts.assumeOpen: Set of keys to treat as open (a pocket about to be dug)
// opts.rescue: ore of any HP and regrowing rock are diggable (never emerald)
function classify(grid, rock, ctx) {
    if (!rock || !rock.worldPoly) return { kind: 'wall', cost: Infinity };
    if (!inZone(ctx.zone, rock)) return { kind: 'wall', cost: Infinity };
    if (ctx.assumeOpen && ctx.assumeOpen.has(rock.k)) return { kind: 'open', cost: 0 };
    if (rock.ore === ORE.EMERALD && (rock.alive || rock.growing)) return { kind: 'wall', cost: Infinity };
    if (rock.growing) {
        if (ctx.rescue) return { kind: 'rock', cost: Math.max(0.05, (rock.health || 0) / ctx.plain) };
        return { kind: 'wall', cost: Infinity };
    }
    if (rock.alive) {
        const eq = Math.max(0.05, (rock.health || 0) / ctx.plain);
        // wall or not is against a fresh plain rock of the same biome (bHard,
        // see royaleLayout.js), so obsidian's plain rock is still diggable;
        // the cost stays in real HP
        if (!ctx.rescue && eq / (rock.bHard || 1) > REACH.HARD_ROCK_EQ) return { kind: 'wall', cost: Infinity };
        return { kind: 'rock', cost: eq };
    }
    if (regrowDueAt(grid, rock, ctx.now) - ctx.now < REACH.REGROW_SOON_MS) return { kind: 'closing', cost: 0.25 };
    return { kind: 'open', cost: 0 };
}

// Open-region labels for one zone, memoised for the tick (terrain changes
// between ticks, not inside one): Map(key -> region size).
let regionMemo = { at: -1, zkey: '', rocks: null, size: null };
function regionSizes(grid, ctx) {
    const zkey = ctx.zone ? Math.round(ctx.zone.x) + ':' + Math.round(ctx.zone.y) + ':' + Math.round(ctx.zone.r) : '*';
    const tick = Math.floor(ctx.now / 33);
    const assume = ctx.assumeOpen && ctx.assumeOpen.size ? [...ctx.assumeOpen].join(',') : '';
    if (regionMemo.at === tick && regionMemo.zkey === zkey + assume && regionMemo.rocks === grid.rocks && regionMemo.rescue === !!ctx.rescue) return regionMemo.size;
    const adj = adjacency(grid);
    const size = new Map();
    const seen = new Set();
    for (const r of grid.rocks.values()) {
        if (seen.has(r.k) || classify(grid, r, ctx).kind !== 'open') continue;
        const comp = [r]; seen.add(r.k);
        for (let i = 0; i < comp.length; i++) {
            for (const n of adj.get(comp[i].k) || []) {
                if (seen.has(n.k) || classify(grid, n, ctx).kind !== 'open') continue;
                seen.add(n.k); comp.push(n);
            }
        }
        for (const c of comp) size.set(c.k, comp.length);
    }
    regionMemo = { at: tick, zkey: zkey + assume, rocks: grid.rocks, size, rescue: !!ctx.rescue };
    return size;
}

function invalidate() { regionMemo = { at: -1, zkey: '', rocks: null, size: null }; }

// tiny binary heap on .d
function heapPush(h, n) {
    h.push(n);
    let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (h[p].d <= h[i].d) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
}
function heapPop(h) {
    const top = h[0], last = h.pop();
    if (h.length) {
        h[0] = last;
        let i = 0;
        for (;;) {
            const l = i * 2 + 1, r = l + 1;
            let m = i;
            if (l < h.length && h[l].d < h[m].d) m = l;
            if (r < h.length && h[r].d < h[m].d) m = r;
            if (m === i) break;
            [h[m], h[i]] = [h[i], h[m]]; i = m;
        }
    }
    return top;
}

// Dijkstra over break cost from `start`. goal(rock, info) -> true stops.
function search(grid, start, ctx, goal, maxCost) {
    const adj = adjacency(grid);
    const best = new Map([[start.k, 0]]);
    const prev = new Map();
    const hops = new Map([[start.k, 0]]);
    const heap = [{ d: 0, r: start }];
    let popped = 0;
    while (heap.length && popped < REACH.MAX_NODES) {
        const { d, r } = heapPop(heap);
        if (d > (best.get(r.k) ?? Infinity)) continue;
        popped++;
        if (goal(r, { cost: d, hops: hops.get(r.k) })) {
            const path = [];
            for (let k = r.k; k !== undefined && k !== start.k; k = prev.get(k)) path.push(grid.rocks.get(k));
            return { found: true, cost: d, hops: hops.get(r.k), end: r, path: path.reverse(), popped };
        }
        for (const n of adj.get(r.k) || []) {
            const c = classify(grid, n, ctx);
            if (c.kind === 'wall') continue;
            const nd = d + c.cost;
            if (nd > maxCost || nd >= (best.get(n.k) ?? Infinity)) continue;
            best.set(n.k, nd); prev.set(n.k, r.k); hops.set(n.k, hops.get(r.k) + 1);
            heapPush(heap, { d: nd, r: n });
        }
    }
    return { found: false, popped };
}

function makeCtx(grid, opts) {
    return {
        now: opts.now || Date.now(),
        zone: opts.zone || null,
        plain: plainHp(grid),
        assumeOpen: opts.assumeOpen || null,
        rescue: !!opts.rescue,
    };
}

// Does (x, y) escape? { ok, via: 'region'|'dig'|null, cost, reason, cell }
function check(grid, x, y, opts = {}) {
    if (!grid || !grid.rocks || !grid._voroRockSz) return { ok: true, via: 'nogrid' };
    const ctx = makeCtx(grid, opts);
    const start = cellAt(grid, x, y);
    if (!start) return { ok: !opts.zone || Math.hypot(x - opts.zone.x, y - opts.zone.y) <= opts.zone.r, via: 'offgrid' };
    const k0 = classify(grid, start, ctx).kind;
    if (k0 !== 'open') return { ok: false, reason: 'start-' + k0, cell: start };
    const sizes = regionSizes(grid, ctx);
    const need = opts.regionCells || REACH.OPEN_REGION_CELLS;
    const region = search(grid, start, ctx, (r) => (sizes.get(r.k) || 0) >= need && classify(grid, r, ctx).kind === 'open', REACH.EXIT_BUDGET);
    if (region.found) return { ok: true, via: 'region', cost: region.cost, cell: start, regionSize: sizes.get(region.end.k) };
    const hopsNeed = opts.escapeHops || REACH.ESCAPE_HOPS;
    const dig = search(grid, start, ctx, (r, info) => info.hops >= hopsNeed, Infinity);
    if (dig.found) return { ok: true, via: 'dig', cost: dig.cost, cell: start };
    return { ok: false, reason: 'enclosed', cell: start, pocket: sizes.get(start.k) || 1 };
}

// Cells to break from (x, y) to an open region (or, with opts.toZone, to any
// cell well inside opts.toZone): [] when already there, null when no route
// within maxCells. Walls are never crossed (emerald never is, even in rescue).
function exitPath(grid, x, y, opts = {}) {
    if (!grid || !grid.rocks || !grid._voroRockSz) return null;
    const ctx = makeCtx(grid, opts);
    const start = cellAt(grid, x, y);
    if (!start) return null;
    const need = opts.regionCells || REACH.OPEN_REGION_CELLS;
    const sizes = opts.toZone ? null : regionSizes(grid, ctx);
    const maxCells = opts.maxCells || 8;
    const goal = opts.toZone
        ? (r) => inZone(opts.toZone, r)
        : (r) => (sizes.get(r.k) || 0) >= need && classify(grid, r, ctx).kind === 'open';
    const res = search(grid, start, ctx, (r, info) => info.hops <= maxCells && goal(r), opts.maxCost || Infinity);
    if (!res.found || res.hops > maxCells) return null;
    return res.path.filter(r => r.alive || r.growing || !r.canyon);
}

module.exports = { REACH, check, exitPath, cellAt, adjacency, classify, regrowDueAt, invalidate };
