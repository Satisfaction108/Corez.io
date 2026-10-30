'use strict';

const { hash } = require('./mapGen.js');

const KEY = (i, j) => i * 100003 + j;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const RIM_JITTER = 100;

const DEFAULTS = {
    open_target: 0.26,
    center_plaza: 460,
    vault_plaza: 520,
    shop_plaza: 360,
    bank_plaza: 440,
    plaza_reach: 1.5,
    plaza_pull: 0.4,
    corridor_width: 560,
    corridor_wander: 0.1,
    extra_links: 0,
    center_links: 2,
    parallel_link_deg: 35,
    cave_cells: 8,
    cave_weight: 1,
    rings: 10,
    rim_start: 0.86,
    rim_pull: 0.5,
    rim_wall: 400,
    nest_keep: 0.55,
    pillars_per_vault: 0,
    pillar_radius: 200,
    pillar_ring: 0.5,
    min_island_cells: 4,
    min_pocket_cells: 12,
    ore_share: 0.32,
    seed_offset: 0,
};

function settings(cfg) {
    if (!cfg) return null;
    return Object.assign({}, DEFAULTS, cfg === true ? {} : cfg);
}

function valueNoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
    const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function caveField(vi, vj, period, seed) {
    const p = Math.max(1, period);
    const low = valueNoise(vi / p + 17.3, vj / p + 5.1, seed);
    const high = valueNoise(vi * 2 / p + 3.7, vj * 2 / p + 11.9, seed + 1);
    return (low + high * 0.5) / 1.5;
}

function linkPairs(pois, extra, parallelDeg = 35, hubLinks = 0) {
    const n = pois.length;
    const dist = (a, b) => Math.hypot(pois[a].x - pois[b].x, pois[a].y - pois[b].y);
    const angle = (a, b) => Math.atan2(pois[b].y - pois[a].y, pois[b].x - pois[a].x);
    const keyOf = (a, b) => Math.min(a, b) * 1000 + Math.max(a, b);
    const seen = new Set();
    const links = [];
    const spokes = Array.from({ length: n }, () => []);
    const minGap = parallelDeg * Math.PI / 180;
    const clashesAt = (p, ang) => spokes[p].some(s => {
        const d = Math.abs(Math.atan2(Math.sin(ang - s), Math.cos(ang - s)));
        return d < minGap;
    });
    const add = (a, b) => {
        seen.add(keyOf(a, b));
        links.push([a, b]);
        spokes[a].push(angle(a, b));
        spokes[b].push(angle(b, a));
    };
    if (n < 2) return links;
    const hub = hubLinks > 0 && n > 2 ? Math.min(hubLinks | 0, n - 1) : 0;
    const first = hub ? 1 : 0;
    const inTree = new Array(n).fill(false);
    const best = new Array(n).fill(Infinity), from = new Array(n).fill(-1);
    best[first] = 0;
    for (let step = first; step < n; step++) {
        let u = -1;
        for (let i = first; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
        inTree[u] = true;
        if (from[u] >= 0) add(from[u], u);
        for (let v = first; v < n; v++) {
            if (inTree[v]) continue;
            const d = dist(u, v);
            if (d < best[v]) { best[v] = d; from[v] = u; }
        }
    }
    if (hub) {
        const order = [];
        for (let b = 1; b < n; b++) order.push(b);
        order.sort((p, q) => dist(0, p) - dist(0, q));
        for (const b of order) {
            if (spokes[0].length >= hub) break;
            if (clashesAt(0, angle(0, b))) continue;
            add(0, b);
        }
    }
    const spare = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (!seen.has(keyOf(a, b))) spare.push([a, b, dist(a, b)]);
    spare.sort((p, q) => p[2] - q[2]);
    const base = links.length;
    for (const [a, b] of spare) {
        if (links.length - base >= extra) break;
        if (hub && (a === 0 || b === 0)) continue;
        if (clashesAt(a, angle(a, b)) || clashesAt(b, angle(b, a))) continue;
        add(a, b);
    }
    return links;
}

function corridorPath(a, b, wander, seed, steps = 24) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const side = hash(Math.round(a.x + b.x), Math.round(a.y + b.y), seed) < 0.5 ? -1 : 1;
    const bend = wander * len * side;
    const wiggle = hash(Math.round(a.x), Math.round(b.y), seed + 9) * Math.PI * 2;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const off = bend * Math.sin(Math.PI * t) + bend * 0.25 * Math.sin(Math.PI * 3 * t + wiggle) * Math.sin(Math.PI * t);
        pts.push([a.x + dx * t + nx * off, a.y + dy * t + ny * off]);
    }
    return pts;
}

function pillarSpots(pois, links, paths, o, seed) {
    const out = [];
    const n = o.pillars_per_vault | 0;
    if (n <= 0 || !(o.pillar_radius > 0)) return out;
    pois.forEach((p, i) => {
        if (p.kind !== 'vault') return;
        const ring = Math.max(p.r * o.pillar_ring, (p.pad || 0) + o.pillar_radius + 60);
        const exits = [];
        links.forEach(([a, b], li) => {
            if (a !== i && b !== i) return;
            const pts = a === i ? paths[li] : paths[li].slice().reverse();
            const far = pts.find(q => Math.hypot(q[0] - p.x, q[1] - p.y) >= ring) || pts[pts.length - 1];
            exits.push(Math.atan2(far[1] - p.y, far[0] - p.x));
        });
        const base = hash(i, 71, seed) * Math.PI * 2;
        let bestRot = base, bestGap = -1;
        for (let step = 0; step < 36; step++) {
            const rot = base + step * Math.PI * 2 / 36;
            let gap = Infinity;
            for (let k = 0; k < n; k++) {
                const ang = rot + k * Math.PI * 2 / n;
                for (const e of exits) gap = Math.min(gap, Math.abs(Math.atan2(Math.sin(ang - e), Math.cos(ang - e))));
            }
            if (gap > bestGap) { bestGap = gap; bestRot = rot; }
        }
        for (let k = 0; k < n; k++) {
            const ang = bestRot + k * Math.PI * 2 / n;
            out.push({ x: p.x + Math.cos(ang) * ring, y: p.y + Math.sin(ang) * ring, r: o.pillar_radius });
        }
    });
    return out;
}

function distToPath(x, y, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
        const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
        const abx = bx - ax, aby = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby || 1)));
        const d = Math.hypot(x - (ax + t * abx), y - (ay + t * aby));
        if (d < best) best = d;
    }
    return best;
}

function plan(grid, circleR, pois, cfg) {
    const o = settings(cfg);
    if (!o || !grid || !grid.rocks || !(circleR > 0)) return null;
    const seed = ((grid.mapSeed | 0) || 7) * 7919 + (o.seed_offset | 0);
    const cx = (r) => r.worldCx || r.wx;
    const cy = (r) => r.worldCy || r.wy;

    const cells = [];
    const byKey = new Map();
    for (const rock of grid.rocks.values()) {
        if (!rock.worldPoly) continue;
        const d = Math.hypot(cx(rock), cy(rock));
        if (d > circleR - RIM_JITTER) continue;
        const cell = { rock, d, open: !rock.alive, fixed: !rock.alive, forced: false, score: 0 };
        cells.push(cell);
        byKey.set(rock.k, cell);
    }
    if (!cells.length) return null;

    const halfW = o.corridor_width / 2;
    const links = linkPairs(pois, o.extra_links | 0, o.parallel_link_deg, o.center_links | 0);
    const paths = links.map(([a, b]) => corridorPath(pois[a], pois[b], o.corridor_wander, seed));
    const pillars = pillarSpots(pois, links, paths, o, seed);
    const pathBoxes = paths.map(pts => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        return [x0 - halfW, y0 - halfW, x1 + halfW, y1 + halfW];
    });
    const reach = Math.max(1.01, o.plaza_reach);
    for (const cell of cells) {
        if (cell.fixed) continue;
        const x = cx(cell.rock), y = cy(cell.rock);
        for (let i = 0; i < paths.length; i++) {
            const b = pathBoxes[i];
            if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
            if (distToPath(x, y, paths[i]) <= halfW) { cell.forced = true; break; }
        }
        if (!cell.forced) cell.pillar = pillars.some(q => Math.hypot(x - q.x, y - q.y) <= q.r);
        let bonus = 0;
        for (const p of pois) {
            const d = Math.hypot(x - p.x, y - p.y);
            if (d <= p.r) {
                if (!cell.pillar) cell.forced = true;
                bonus = 1;
                break;
            }
            bonus = Math.max(bonus, 1 - (d - p.r) / (p.r * (reach - 1)));
        }
        const cave = caveField(cell.rock.vi, cell.rock.vj, o.cave_cells, seed);
        cell.score = o.cave_weight * cave + o.plaza_pull * Math.max(0, bonus);
    }

    const neighbours = (cell) => {
        const out = [];
        for (const [di, dj] of SIDES) {
            const n = byKey.get(KEY(cell.rock.vi + di, cell.rock.vj + dj));
            if (n) out.push(n);
        }
        return out;
    };
    const groups = (isOpen) => {
        const seen = new Set();
        const list = [];
        for (const start of cells) {
            if (seen.has(start) || start.open !== isOpen) continue;
            const comp = [start];
            seen.add(start);
            for (let i = 0; i < comp.length; i++) {
                for (const n of neighbours(comp[i])) {
                    if (seen.has(n) || n.open !== isOpen) continue;
                    seen.add(n);
                    comp.push(n);
                }
            }
            list.push(comp);
        }
        return list;
    };
    const centreCell = cells.reduce((a, b) => (b.d < a.d ? b : a));
    const ringCount = Math.max(1, o.rings | 0);
    const ringOf = (cell) => Math.min(ringCount - 1, Math.floor(cell.d / circleR * ringCount));
    const rings = Array.from({ length: ringCount }, () => ({ cells: [], free: [], held: 0, weight: 1 }));
    for (const cell of cells) {
        const ring = rings[ringOf(cell)];
        ring.cells.push(cell);
        if (cell.fixed || cell.forced) ring.held++;
        else if (!cell.pillar && cell.d <= circleR - o.rim_wall) ring.free.push(cell);
    }
    for (let i = 0; i < ringCount; i++) {
        const mid = (i + 0.5) / ringCount;
        const rim = Math.max(0, Math.min(1, (mid - o.rim_start) / Math.max(0.01, 1 - o.rim_start)));
        const nestKeep = mid < 0.16 ? o.nest_keep : 1;
        rings[i].weight = Math.max(0, (1 - o.rim_pull * rim) * nestKeep);
        rings[i].free.sort((a, b) => b.score - a.score);
    }
    const goal = Math.round(cells.length * o.open_target);

    const carveLine = (from, to) => {
        const pts = [[cx(from.rock), cy(from.rock)], [cx(to.rock), cy(to.rock)]];
        for (const cell of cells) {
            if (cell.open || cell.pillar) continue;
            if (distToPath(cx(cell.rock), cy(cell.rock), pts) <= halfW) cell.open = true;
        }
    };
    const tidy = () => {
        for (let pass = 0; pass < 3; pass++) {
            let changed = false;
            for (const comp of groups(false)) {
                if (comp.length >= o.min_island_cells || comp.some(c => c.pillar)) continue;
                for (const c of comp) c.open = true;
                changed = true;
            }
            const open = groups(true);
            const main = open.find(comp => comp.includes(centreCell)) || open.reduce((a, b) => (b.length > a.length ? b : a), []);
            const mainList = main.slice();
            for (const comp of open) {
                if (comp === main) continue;
                const pinned = comp.some(c => c.fixed || c.forced);
                if (!pinned && comp.length < o.min_pocket_cells) {
                    for (const c of comp) c.open = false;
                    changed = true;
                    continue;
                }
                let bestA = null, bestB = null, bestD = Infinity;
                for (const a of comp) {
                    for (const b of mainList) {
                        const d = (cx(a.rock) - cx(b.rock)) ** 2 + (cy(a.rock) - cy(b.rock)) ** 2;
                        if (d < bestD) { bestD = d; bestA = a; bestB = b; }
                    }
                }
                if (bestA && bestB) { carveLine(bestA, bestB); changed = true; }
            }
            if (!changed) break;
        }
    };
    const fill = (level) => {
        for (const c of cells) c.open = c.fixed || c.forced;
        for (const ring of rings) {
            const want = Math.round(ring.cells.length * Math.min(1, level * ring.weight)) - ring.held;
            for (let i = 0; i < want && i < ring.free.length; i++) ring.free[i].open = true;
        }
        tidy();
        return cells.filter(c => c.open).length;
    };

    let lo = 0, hi = 1, level = o.open_target;
    for (let iter = 0; iter < 10; iter++) {
        const now = fill(level);
        const miss = goal - now;
        if (Math.abs(miss) <= Math.max(4, cells.length * 0.004)) break;
        if (miss > 0) lo = level; else hi = level;
        level = (lo + hi) / 2;
    }

    const carve = [];
    for (const c of cells) if (c.open && !c.fixed && c.rock.alive) carve.push(c.rock);
    return {
        carve,
        cells: cells.length,
        open: cells.filter(c => c.open).length,
        forced: cells.filter(c => c.forced).length,
        pillars: pillars.length,
        links: paths.length,
    };
}

module.exports = { DEFAULTS, settings, plan, linkPairs, corridorPath, pillarSpots, caveField };
