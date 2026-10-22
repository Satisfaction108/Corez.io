const CELL = { BASALT: 0, EMPTY: 1 };

const { basePolygonHealth } = require('../../lib/definitions/constants.js');

const ROCK_DAMAGE_BASE = 0.75 * 0.7 * 0.75 * 562.5 * basePolygonHealth;
const ROCK_TOUGHNESS = 1.15;
const ROCK_HEALTH = ROCK_TOUGHNESS * ROCK_DAMAGE_BASE;

const ORE = { NONE: 0, COPPER: 1, VEIN: 2, SHARD: 3, EMERALD: 4 };
const ORE_CHANCE = 0.22;   

const EMERALD_COUNT = 3;

const ORE_HP = { [ORE.NONE]: 1, [ORE.COPPER]: 1.5, [ORE.VEIN]: 1.85,
                 [ORE.SHARD]: 2.1, [ORE.EMERALD]: 4.2 };
// The most of an ore rock's health one hit from a tank can take, however
// stacked its mining is (an emerald always takes at least 7 hits).
const ORE_HIT_CAP = { [ORE.COPPER]: 0.5, [ORE.VEIN]: 0.5, [ORE.SHARD]: 0.34, [ORE.EMERALD]: 0.15 };
// Any one tank (its bullets and drones included) breaks at most this many rocks a second.
const ROCK_BREAKS_PER_SEC = 6;

// Mirrored on the client: terrainRenderer.js GROW_MS / GROW_SCALE0.
const GROW_TIMELINE_MS = 16_000;
const RISE_MS = 5_000;
const REGROW = {
    BASE_DELAY_MS:      42_000,
    MIN_DELAY_MS:       22_000,
    DEFICIT_MS_PER_GAP:    250,
    GROW_MS:  GROW_TIMELINE_MS,
    RISE_MS,
    RISE_RATE: GROW_TIMELINE_MS / RISE_MS,
    START_SCALE:          0.15, 
    HP_FLOOR:             0.25, 

    HEAL_IDLE_MS:       30_000, 
    HEAL_RATE:           0.008, 
    CRUSH_DPS_FRAC:       0.25, 

    CRUSH_DEPTH:          0.30, 

    PACING_MS:             500, 
    // ore bloom rocks: a short wait, then they rise from BLOOM_START of the way up
    BLOOM_DELAY_MS:      5_000, // (was 2.5 s)
    BLOOM_START:          0.45,
    // a tank this close to a rising rock (from the cell's centre, plus the
    // tank's own size) slows the rise to NEAR_RATE, so the wall gives you
    // time to get out instead of closing over you. NEAR_OFF_R: the
    // hysteresis before it speeds back up.
    NEAR_R:                260,
    NEAR_OFF_R:            300,
    NEAR_RATE:          1 / 2.4,
    START_CLEAR:            40,
    // a grown tank (growth.js) slows it more: the rate divides by 1 + GROWN_SLOW
    // per 1x it has gained (in 0.25x steps), so a 3x hull isn't closed in
    GROWN_SLOW:              1,
    NEAR_BUCKET:           512,
    FAST_RATE: GROW_TIMELINE_MS / RISE_MS,
    EMERALD_RESPAWN_MS: 60_000, 
    EMERALD_PENDING_MAX:    48,
    EMERALD_PLANTS_PER_PASS: 4,
    EMERALD_GAP:             6,
    REGROW_SLICE:          800,
    REGROW_SLICE_TICK_MS:   33,
    EVENT_MERGE_LOOKBACK:   64,
    ORPHAN_DELAY_MS:    60_000,
    ORE_GEN_STRIDE:       7919, 
};

function easeGrowth(p) { return p * p * (3 - 2 * p); }

// How tough a rock is on top of its ore's own health: its biome's toughness
// times its ore's (shared/rockBiomes.js toughness). 1 off the raid map (no
// biome). Its gems pay the same factor (gems.js), unless it was softened
// for a spawn (rock.soft), which keeps the old flat pay.
const Biomes = require('../../../shared/rockBiomes.js');
function rockTough(rock, ore = rock && rock.ore) {
    if (!rock || !(rock.biome >= 0)) return 1;
    return Biomes.toughness(rock.bHard || 1, ore | 0);
}
function rockPay(rock) {
    return rock && rock.soft ? 1 : rockTough(rock);
}

class TerrainGrid {
    constructor(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        this.cells = new Uint8Array(cols * rows).fill(CELL.BASALT);
        this.cellSize = 1;

        this._contourSegs   = null; 
        this._contourMap    = null; 
        this._contourBucket = 1;
        this._contourTick   = 0;   
        this._boundary      = null; 

        this._voronoiMap    = null;
        this._voronoiBucket = 1;
        this._voronoiTick   = 0;

        this.rocks      = new Map();
        this.rockEvents = [];

        this._growing    = [];      
        this._spineMid   = 0;       
        this._pendingEmeralds  = [];
        this._emeraldRespawns  = 0; 
        this._lastRegrowTick   = 0;
        this._regrowDelay = [REGROW.BASE_DELAY_MS, REGROW.BASE_DELAY_MS]; 

        this.oreSalt = 1 + ((Math.random() * 0x7ffffffe) | 0);   

        this.baseRockHealth = ROCK_DAMAGE_BASE;
        this.plainRockHealth = ROCK_HEALTH;
    }

    get(col, row) {
        if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return CELL.EMPTY;
        return this.cells[row * this.cols + col];
    }

    set(col, row, type) {
        if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return;
        this.cells[row * this.cols + col] = type;
    }

    isSolid(col, row) { return this.get(col, row) === CELL.BASALT; }

    serialize() { return Array.from(this.cells); }

    worldToCell(worldX, worldY) {
        const halfW = this.cols * this.cellSize / 2;
        const halfH = this.rows * this.cellSize / 2;
        return {
            col: Math.floor((worldX + halfW) / this.cellSize),
            row: Math.floor((worldY + halfH) / this.cellSize),
        };
    }

    getCellWorldBounds(col, row) {
        const halfW = this.cols * this.cellSize / 2;
        const halfH = this.rows * this.cellSize / 2;
        const cs    = this.cellSize;
        const minX  = col * cs - halfW;
        const minY  = row * cs - halfH;
        return { minX, maxX: minX + cs, minY, maxY: minY + cs,
                 cx: minX + cs / 2, cy: minY + cs / 2 };
    }

    circleOverlapsCells(cx, cy, radius) {
        const halfW = this.cols * this.cellSize / 2;
        const halfH = this.rows * this.cellSize / 2;
        const cs    = this.cellSize;
        const c0 = Math.floor((cx - radius + halfW) / cs);
        const c1 = Math.floor((cx + radius + halfW) / cs);
        const r0 = Math.floor((cy - radius + halfH) / cs);
        const r1 = Math.floor((cy + radius + halfH) / cs);
        const hits = [];
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                if (!this.isSolid(c, r)) continue;
                const cellMinX = c * cs - halfW;
                const cellMinY = r * cs - halfH;
                const nearX = Math.max(cellMinX, Math.min(cx, cellMinX + cs));
                const nearY = Math.max(cellMinY, Math.min(cy, cellMinY + cs));
                const dx = cx - nearX, dy = cy - nearY;
                if (dx * dx + dy * dy <= radius * radius) hits.push({ col: c, row: r });
            }
        }
        return hits;
    }

    raycastCells(ox, oy, dirX, dirY, maxDist) {
        if (maxDist <= 0) return [];
        const len = Math.hypot(dirX, dirY);
        if (len === 0) return [];
        const ndx = dirX / len, ndy = dirY / len;
        const halfW = this.cols * this.cellSize / 2;
        const halfH = this.rows * this.cellSize / 2;
        const cs    = this.cellSize;
        let col = Math.floor((ox + halfW) / cs);
        let row = Math.floor((oy + halfH) / cs);
        const stepCol = ndx > 0 ? 1 : ndx < 0 ? -1 : 0;
        const stepRow = ndy > 0 ? 1 : ndy < 0 ? -1 : 0;
        const cellLeft = col * cs - halfW, cellTop = row * cs - halfH;
        let tMaxX = stepCol === 0 ? Infinity : stepCol > 0 ? (cellLeft + cs - ox) / ndx : (cellLeft - ox) / ndx;
        let tMaxY = stepRow === 0 ? Infinity : stepRow > 0 ? (cellTop  + cs - oy) / ndy : (cellTop  - oy) / ndy;
        const tDeltaX = stepCol === 0 ? Infinity : cs / Math.abs(ndx);
        const tDeltaY = stepRow === 0 ? Infinity : cs / Math.abs(ndy);
        const hits = []; let t = 0;
        while (t <= maxDist) {
            if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) break;
            if (this.isSolid(col, row)) hits.push({ col, row, t });
            if (tMaxX < tMaxY) { if (tMaxX > maxDist) break; t = tMaxX; col += stepCol; tMaxX += tDeltaX; }
            else               { if (tMaxY > maxDist) break; t = tMaxY; row += stepRow; tMaxY += tDeltaY; }
        }
        return hits;
    }

    buildContour() {
        const { cols, rows, cellSize } = this;
        const halfW = cols * cellSize / 2, halfH = rows * cellSize / 2;
        const solid = (c, r) =>
            c >= 0 && c < cols && r >= 0 && r < rows && this.cells[r * cols + c] === 0;

        const edges = [], startMap = new Map();
        const addE = (ax, ay, bx, by) => {
            const i = edges.length / 4;
            edges.push(ax, ay, bx, by);
            const k = `${ax},${ay}`;
            let arr = startMap.get(k); if (!arr) { arr = []; startMap.set(k, arr); }
            arr.push(i);
        };
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!solid(c, r)) continue;
                if (!solid(c,   r-1)) addE(c,   r,   c+1, r  );
                if (!solid(c+1, r  )) addE(c+1, r,   c+1, r+1);
                if (!solid(c,   r+1)) addE(c+1, r+1, c,   r+1);
                if (!solid(c-1, r  )) addE(c,   r+1, c,   r  );
            }
        }
        const numEdges = edges.length / 4;
        const used = new Uint8Array(numEdges);
        const rawLoops = [];
        for (let i = 0; i < numEdges; i++) {
            if (used[i]) continue;
            const pts = [];
            let cur = i;
            while (cur !== -1 && !used[cur]) {
                used[cur] = 1;
                pts.push([edges[cur*4], edges[cur*4+1]]);
                const ex = edges[cur*4+2], ey = edges[cur*4+3];
                const cand = startMap.get(`${ex},${ey}`);
                let nxt = -1;
                if (cand) for (const j of cand) { if (!used[j]) { nxt = j; break; } }
                cur = nxt;
            }
            if (pts.length >= 3) rawLoops.push(pts);
        }

        const simplified = rawLoops.map(loop => {
            const n = loop.length, out = [];
            for (let i = 0; i < n; i++) {
                const p = loop[(i-1+n)%n], q = loop[i], s = loop[(i+1)%n];
                const d1x = q[0]-p[0], d1y = q[1]-p[1];
                const d2x = s[0]-q[0], d2y = s[1]-q[1];
                if (d1x*d2y - d1y*d2x !== 0 || d1x*d2x + d1y*d2y <= 0) out.push(q);
            }
            return out.length >= 3 ? out : loop;
        });

        const Hh = (x, y, s) => {
            let v = (Math.imul(x+1, 374761393) ^ Math.imul(y+1, 1284865837) ^
                     Math.imul((s|0)+1, 668265263)) | 0;
            v = Math.imul(v ^ (v >>> 13), 1540483477);
            v ^= v >>> 15;
            return (v >>> 0) / 0x100000000;
        };
        const jagOut = (x, seed) => {
            const blk = Math.floor(x / 5);
            return 1 + Math.round(Hh(blk, seed, 60) * 2 + Hh(blk, seed + 7, 60) * 1);
        };
        const smoothClipLoop = (loop) => {
            const n = loop.length;
            let pts = [];
            for (let i = 0; i < n; i++) {
                const A = loop[i], B = loop[(i+1)%n];
                const dx = B[0]-A[0], dy = B[1]-A[1];
                const steps = Math.max(1, Math.round(Math.hypot(dx, dy)));
                for (let k = 0; k < steps; k++)
                    pts.push([A[0]+dx*(k/steps), A[1]+dy*(k/steps)]);
            }
            const m = pts.length;
            if (m < 4) return loop;

            const pin = pts.map(p => p[0] <= 0 || p[0] >= cols || p[1] <= 0 || p[1] >= rows);

            for (let pass = 0; pass < 6; pass++) {
                const np = pts.slice();
                for (let i = 0; i < m; i++) {
                    if (pin[i]) continue;
                    const a = pts[(i-1+m)%m], b = pts[i], c = pts[(i+1)%m];
                    np[i] = [a[0]*0.25+b[0]*0.5+c[0]*0.25, a[1]*0.25+b[1]*0.5+c[1]*0.25];
                }
                pts = np;
            }

            const out = [];
            for (let i = 0; i < m; i += 3) {
                let x = pts[i][0], y = pts[i][1];
                if (x > 0.5 && x < cols - 0.5) {
                    if      (y <= 0.5)        y = -jagOut(Math.round(x), 0);
                    else if (y >= rows - 0.5) y =  rows + jagOut(Math.round(x), 1);
                }
                out.push([x, y]);
            }
            return out.length >= 3 ? out : loop;
        };

        const segs = [];
        for (const loop of simplified.map(smoothClipLoop)) {
            const n = loop.length;
            for (let i = 0; i < n; i++) {
                const a = loop[i], b = loop[(i+1)%n];
                const ax = a[0]*cellSize - halfW, ay = a[1]*cellSize - halfH;
                const bx = b[0]*cellSize - halfW, by = b[1]*cellSize - halfH;
                const dx = bx-ax, dy = by-ay, len = Math.hypot(dx, dy);
                if (len < 1e-6) continue;
                segs.push({
                    ax, ay, bx, by,
                    edx: dx/len, edy: dy/len,
                    nx: dy/len, ny: -dx/len,
                    len, _tick: 0,
                });
            }
        }

        const BUCKET = cellSize * 4;
        const smap = new Map();
        for (const seg of segs) {
            const x0 = Math.min(seg.ax, seg.bx), x1 = Math.max(seg.ax, seg.bx);
            const y0 = Math.min(seg.ay, seg.by), y1 = Math.max(seg.ay, seg.by);
            const c0 = Math.floor(x0/BUCKET), c1 = Math.floor(x1/BUCKET);
            const r0 = Math.floor(y0/BUCKET), r1 = Math.floor(y1/BUCKET);
            for (let bc = c0; bc <= c1; bc++) {
                for (let br = r0; br <= r1; br++) {
                    const k = bc * 997 + br;
                    let arr = smap.get(k); if (!arr) { arr = []; smap.set(k, arr); }
                    arr.push(seg);
                }
            }
        }

        const boundary = new Uint8Array(cols * rows);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!solid(c, r)) continue;
                if (!solid(c-1,r) || !solid(c+1,r) || !solid(c,r-1) || !solid(c,r+1))
                    boundary[r*cols+c] = 1;
            }
        }

        this._contourSegs   = segs;
        this._contourMap    = smap;
        this._contourBucket = BUCKET;
        this._boundary      = boundary;

        this.buildVoronoiColliders();
    }

    _hash2(i, j) {
        const f32 = Math.fround;
        let px = f32(f32(i) * f32(5.3983));
        px = f32(px - Math.floor(px));
        let py = f32(f32(j) * f32(5.4427));
        py = f32(py - Math.floor(py));
        const d = f32(f32(py * f32(f32(px) + f32(21.5351))) + f32(f32(px) * f32(f32(py) + f32(14.3137))));
        px = f32(px + d); py = f32(py + d);
        const pxy = f32(px * py);
        let rx = f32(pxy * f32(95.4307)); rx = f32(rx - Math.floor(rx));
        let ry = f32(pxy * f32(97.597));  ry = f32(ry - Math.floor(ry));
        rx = f32(f32(0.5) + f32(f32(rx - f32(0.5)) * f32(0.55)));
        ry = f32(f32(0.5) + f32(f32(ry - f32(0.5)) * f32(0.55)));
        return [Math.round(rx * 255) / 255, Math.round(ry * 255) / 255];
    }

    _oreRoll(vi, vj, s) {
        let h = (Math.imul(vi + 1, 374761393) ^ Math.imul(vj + 1, 1284865837) ^
                 Math.imul((s | 0) + 1, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1540483477);
        h ^= h >>> 15;
        return (h >>> 0) / 0x100000000;
    }

    // Ore tier for a lattice cell. depth is 0 at the wall's outer faces and 1
    // at its spine.
    _oreTierFor(vi, vj, viLo, viHi, saltExtra = 0) {
        if (this._oreRoll(vi, vj, this.oreSalt + 11 + saltExtra) >= ORE_CHANCE) return ORE.NONE;
        const halfSpan = Math.max(1, (viHi - viLo) / 2);
        const depth = Math.min(vi - viLo, viHi - vi) / halfSpan; 
        const t = this._oreRoll(vi, vj, this.oreSalt + 12 + saltExtra);

        if (depth <= 0.40) return t < 0.75 ? ORE.COPPER : ORE.NONE;
        if (depth <= 0.75) return t < 0.35 ? ORE.VEIN : t < 0.8375 ? ORE.COPPER : ORE.NONE;
        return t < 0.08 ? ORE.SHARD : t < 0.45 ? ORE.VEIN : t < 0.8625 ? ORE.COPPER : ORE.NONE;
    }

    static depositLayout(tier, poly, cx, cy, rockSz, h) {
        const want  = tier === 4 ? 1
                    : tier === 3 ? 1
                    : tier === 2 ? 2 + (h(0, 220) < 0.5 ? 0 : 1)
                    :              3 + (h(0, 220) < 0.5 ? 0 : 1);
        const baseR = (tier === 4 ? 0.14 : tier === 3 ? 0.15 : tier === 2 ? 0.16 : 0.13) * rockSz;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of poly) {
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
        }
        const inPoly = (x, y) => {
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const xi = poly[i][0], yi = poly[i][1];
                const xj = poly[j][0], yj = poly[j][1];
                if ((yi > y) !== (yj > y) &&
                    x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
            }
            return inside;
        };
        const distToBorder = (x, y) => {
            let best = Infinity;
            for (let i = 0; i < poly.length; i++) {
                const a = poly[i], b = poly[(i + 1) % poly.length];
                const dx = b[0] - a[0], dy = b[1] - a[1];
                const L2 = dx * dx + dy * dy || 1e-12;
                const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
                const ddx = x - (a[0] + t * dx), ddy = y - (a[1] + t * dy);
                const d = ddx * ddx + ddy * ddy;
                if (d < best) best = d;
            }
            return Math.sqrt(best);
        };

        const out = [];

        if (tier === 3 || tier === 4) {
            // the big crystal sits at the rock's roomiest spot (the point
            // farthest from its edge: a coarse grid, then a finer one round
            // the best) and is never wider than that room allows, so it
            // stays inside the rock with a margin. Mirrored in
            // public/client/terrainRenderer.js _depositLayout.
            let bx = cx, by = cy, bd = inPoly(cx, cy) ? distToBorder(cx, cy) : -1;
            let sx = (maxX - minX) / 8, sy = (maxY - minY) / 8, ox = minX, oy = minY;
            for (let pass = 0; pass < 2; pass++) {
                for (let gy = 0; gy <= 8; gy++) {
                    for (let gx = 0; gx <= 8; gx++) {
                        const x = ox + gx * sx, y = oy + gy * sy;
                        if (!inPoly(x, y)) continue;
                        const d = distToBorder(x, y);
                        if (d > bd) { bd = d; bx = x; by = y; }
                    }
                }
                ox = bx - sx; oy = by - sy; sx /= 4; sy /= 4;
            }
            const r0 = (tier === 4 ? 0.34 : 0.30) * rockSz;
            out.push({ x: bx, y: by, r: bd > 0 ? Math.min(r0, bd * 0.78) : r0,
                       rot: (h(1, 221) - 0.5) * 0.7, big: true });
        }
        for (let t = 0; t < 40 && out.length < want; t++) {
            const x = minX + h(t, 222) * (maxX - minX);
            const y = minY + h(t, 223) * (maxY - minY);
            if (!inPoly(x, y)) continue;
            if (distToBorder(x, y) < baseR * 1.5) continue;
            let ok = true;
            for (const d of out) {
                const dx = x - d.x, dy = y - d.y;
                const need = (d.r + baseR) * 1.7;
                if (dx * dx + dy * dy < need * need) { ok = false; break; }
            }
            if (!ok) continue;
            out.push({ x, y, r: baseR * (0.85 + h(t, 224) * 0.3),
                       rot: (h(t, 225) - 0.5) * 0.9, big: false });
        }
        return out;
    }

    static _dh(x, y, s) {
        let h = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 1284865837) ^
                 Math.imul((s | 0) + 1, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1540483477);
        h ^= h >>> 15;
        return (h >>> 0) / 0x100000000;
    }

    // ─── Per-Voronoi-cell collision builder ───────────────────────────────────

    buildVoronoiColliders() {
        const { cols, rows, cellSize } = this;
        const halfW  = cols * cellSize / 2, halfH = rows * cellSize / 2;
        // Rock size is cols/50 lattice cells, clamped at 120 cols (15 tiles) so
        // rocks are the same world size on wider maps (the tutorial room).
        // Mirrored in public/client/terrainRenderer.js: all four voronoi
        // implementations must stay identical.
        const rockSz = Math.min(cols, 120) / 50.0;
        const hash2 = (i, j) => this._hash2(i, j);

        const clip = (poly, mx, my, ndx, ndy) => {
            const out = [], n = poly.length;
            for (let i = 0; i < n; i++) {
                const [ax, ay] = poly[i], [bx, by] = poly[(i+1) % n];
                const da = (ax-mx)*ndx + (ay-my)*ndy;
                const db = (bx-mx)*ndx + (by-my)*ndy;
                if (da <= 0) out.push([ax, ay]);
                if ((da < 0) !== (db < 0)) {
                    const t = da / (da - db);
                    out.push([ax + t*(bx-ax), ay + t*(by-ay)]);
                }
            }
            return out;
        };

        let maxLeft = 0, minRight = cols - 1, minLeft = cols, maxRight = 0;
        for (let r = 0; r < rows; r++) {
            let le = 0; while (le < cols && !this.isSolid(le, r)) le++;
            let re = cols - 1; while (re >= 0 && !this.isSolid(re, r)) re--;
            if (le < cols) { if (le > maxLeft) maxLeft = le; if (le < minLeft) minLeft = le; }
            if (re >= 0)   { if (re < minRight) minRight = re; if (re > maxRight) maxRight = re; }
        }
        const vxMin = maxLeft / rockSz;
        const vxMax = (minRight + 1) / rockSz;

        const viLo = Math.round(vxMin), viHi = Math.round(vxMax) - 1;
        const vjLo = 0,                 vjHi = Math.round(rows / rockSz) - 1;

        // for point-in-rock queries (pointInRock / circleHitsRock)
        this._voroRockSz = rockSz;
        this._voroViLo = viLo; this._voroViHi = viHi;
        this._voroVjLo = vjLo; this._voroVjHi = vjHi;
        // lattice column of the wall's spine, between the two sides' frontiers
        this._spineMid = (viLo + viHi) / 2;
        this._cellWorld = rockSz * cellSize;   // world units across one lattice cell
        this._growing.length = 0;
        this._pendingEmeralds.length = 0;

        const BUCKET = this._contourBucket;
        const vmap   = new Map();
        this.rocks      = new Map();
        this.rockEvents = [];

        const canyonKeys = new Set();
        const outpostCells = [];   
        const chamberCells = [];   
        if (!Config.dig_royale) {
            const spanV = Math.max(1, vjHi - vjLo);
            const spanH = Math.max(1, viHi - viLo);
            const viMid = Math.round((viLo + viHi) / 2);
            const laneNames = ["Upper Canyon Outpost", "Lower Canyon Outpost"];
            let laneIdx = 0;
            for (const lane of [0.27, 0.73]) {          // upper + lower route
                const base  = vjLo + spanV * lane;
                const amp   = Math.max(1.5, spanV * 0.07);
                const phase = lane * Math.PI * 2;
                for (let vi = viLo; vi <= viHi; vi++) {
                    const t = (vi - viLo) / spanH;
                    // gentle S-bends: ~2 winds across the wall
                    const vjMid = base + Math.sin(t * Math.PI * 2.3 + phase) * amp;
                    for (let w = 0; w < 2; w++) {        
                        const vj = Math.max(vjLo, Math.min(vjHi, Math.round(vjMid) + w));
                        canyonKeys.add(vi * 100003 + vj);
                    }

                    if (vi === viMid) {
                        const vj = Math.max(vjLo, Math.min(vjHi, Math.round(vjMid)));
                        outpostCells.push({ key: vi * 100003 + vj, name: laneNames[laneIdx] });
                    }
                }
                laneIdx++;
            }

            const cvj = Math.round((vjLo + vjHi) / 2);
            outpostCells.push({ key: viMid * 100003 + cvj, name: "Deep Core Outpost" });
            // each outpost site gets a carved 3x3-cell pocket
            for (const s of outpostCells) {
                const svi = Math.floor(s.key / 100003), svj = s.key % 100003;
                for (let di = -1; di <= 1; di++)
                    for (let dj = -1; dj <= 1; dj++) {
                        const vi2 = Math.max(viLo, Math.min(viHi, svi + di));
                        const vj2 = Math.max(vjLo, Math.min(vjHi, svj + dj));
                        canyonKeys.add(vi2 * 100003 + vj2);
                    }
            }
            // core chamber sites: one per team, 3 cells in from each face on
            // the centre row
            for (const side of [0, 1]) {
                const vi = side === 0 ? viLo + 3 : viHi - 3;
                chamberCells.push({
                    key: vi * 100003 + cvj,
                    team: side === 0 ? TEAM_BLUE : TEAM_RED,
                    name: side === 0 ? "Blue Core Chamber" : "Red Core Chamber",
                });
            }
            // chamber cells are not pre-carved here; see CORE CHAMBER POCKETS
        }
        this._canyonKeys = canyonKeys;
        // canyon cells plus everything within 2 lattice cells
        const canyonNear = new Set();
        for (const k of canyonKeys) {
            const vi = Math.floor(k / 100003), vj = k % 100003;
            for (let di = -2; di <= 2; di++)
                for (let dj = -2; dj <= 2; dj++)
                    canyonNear.add((vi + di) * 100003 + (vj + dj));
        }
        this._canyonNearKeys = canyonNear;

        // Emeralds: exactly EMERALD_COUNT cells, deep in the wall (depth >= 0.7),
        // away from canyons and at least 6 cells apart.
        const emeraldKeys = new Set();
        {
            const halfSpan = Math.max(1, (viHi - viLo) / 2);
            const cands = [];
            for (let vj = vjLo; vj <= vjHi; vj++) {
                for (let vi = viLo; vi <= viHi; vi++) {
                    if (canyonNear.has(vi * 100003 + vj)) continue;
                    const depth = Math.min(vi - viLo, viHi - vi) / halfSpan;
                    if (depth < 0.7) continue;
                    cands.push({ vi, vj, s: this._oreRoll(vi, vj, this.oreSalt + 13) });
                }
            }
            cands.sort((a, b) => a.s - b.s);
            const picked = [];
            for (const c of cands) {
                if (picked.length >= EMERALD_COUNT) break;
                let ok = true;
                for (const p of picked) {
                    const di = c.vi - p.vi, dj = c.vj - p.vj;
                    if (di * di + dj * dj < 36) { ok = false; break; } 
                }
                if (!ok) continue;
                picked.push(c);
                emeraldKeys.add(c.vi * 100003 + c.vj);
            }
        }

        for (let vj = vjLo; vj <= vjHi; vj++) {
            for (let vi = viLo; vi <= viHi; vi++) {
                const [hx, hy] = hash2(vi, vj);
                const sx = vi+hx, sy = vj+hy;

                const ore = emeraldKeys.has(vi * 100003 + vj)
                    ? ORE.EMERALD
                    : this._oreTierFor(vi, vj, viLo, viHi);
                const hp  = ROCK_HEALTH * ORE_HP[ore];
                const rock = {
                    k: vi * 100003 + vj, vi, vj,
                    health: hp, maxHealth: hp,
                    alive: true,
                    ore,
                    deposits: null,
                    wx: sx * rockSz * cellSize - halfW,
                    wy: sy * rockSz * cellSize - halfH,

                    gen: 0,          
                    growing: false,
                    growE0: 0, growAt: 0, growRate: 1, growFast: false,
                    growDamage: 0,   
                    diedAt: 0,       
                    worldPoly: null, 
                    worldCx: 0, worldCy: 0, maxPolyRadius: 0,

                    growAx: 0, growAy: 0,
                    _cp: null, _cpAt: 0,  
                    tilePoly: null, tileCx: 0, tileCy: 0, 
                };
                this.rocks.set(rock.k, rock);

                let poly = [[sx-3,sy-3],[sx+3,sy-3],[sx+3,sy+3],[sx-3,sy+3]];
                for (let dj = -2; dj <= 2 && poly.length >= 3; dj++) {
                    for (let di = -2; di <= 2 && poly.length >= 3; di++) {
                        if (di === 0 && dj === 0) continue;
                        const [nhx, nhy] = hash2(vi+di, vj+dj);
                        const tx = vi+di+nhx, ty = vj+dj+nhy;
                        poly = clip(poly, (sx+tx)/2, (sy+ty)/2, tx-sx, ty-sy);
                    }
                }
                if (poly.length < 3) continue;
                let area = 0;
                for (let ai = 0; ai < poly.length; ai++) {
                    const [ax, ay] = poly[ai], [bx, by] = poly[(ai+1)%poly.length];
                    area += ax*by - bx*ay;
                }
                if (Math.abs(area) / 2 < 0.05) continue;

                // cell geometry, cached in tile and world coords
                {
                    let pcx = 0, pcy = 0;
                    for (const p of poly) { pcx += p[0]; pcy += p[1]; }
                    pcx = pcx / poly.length * rockSz;
                    pcy = pcy / poly.length * rockSz;
                    rock.tilePoly = poly.map(p => [p[0] * rockSz, p[1] * rockSz]);
                    rock.tileCx = pcx;
                    rock.tileCy = pcy;
                    rock.worldPoly = rock.tilePoly.map(p => [p[0] * cellSize - halfW,
                                                             p[1] * cellSize - halfH]);
                    rock.worldCx = pcx * cellSize - halfW;
                    rock.worldCy = pcy * cellSize - halfH;
                    let far = 0;
                    for (const p of rock.worldPoly) {
                        const d = Math.hypot(p[0] - rock.worldCx, p[1] - rock.worldCy);
                        if (d > far) far = d;
                    }
                    rock.maxPolyRadius = far;
                }

                if (ore) rock.deposits = this._buildDeposits(rock);

                const wsx = sx*rockSz*cellSize-halfW, wsy = sy*rockSz*cellSize-halfH;

                for (let e = 0; e < poly.length; e++) {
                    const [vax, vay] = poly[e], [vbx, vby] = poly[(e+1)%poly.length];

                    const wax = vax*rockSz*cellSize-halfW, way = vay*rockSz*cellSize-halfH;
                    const wbx = vbx*rockSz*cellSize-halfW, wby = vby*rockSz*cellSize-halfH;
                    const edx = wbx-wax, edy = wby-way, len = Math.hypot(edx, edy);
                    if (len < 1e-6) continue;

                    const ux = edx/len, uy = edy/len;
                    let nx = -uy, ny = ux;
                    const mx = (wax+wbx)*0.5, my = (way+wby)*0.5;
                    if ((wsx-mx)*nx + (wsy-my)*ny > 0) { nx = -nx; ny = -ny; }

                    const seg = { ax:wax, ay:way, bx:wbx, by:wby,
                                   edx:ux, edy:uy, nx, ny, len, _tick:0, rock };
                    const x0=Math.min(wax,wbx), x1=Math.max(wax,wbx);
                    const y0=Math.min(way,wby), y1=Math.max(way,wby);
                    const c0=Math.floor(x0/BUCKET), c1=Math.floor(x1/BUCKET);
                    const r0=Math.floor(y0/BUCKET), r1=Math.floor(y1/BUCKET);
                    for (let bc=c0; bc<=c1; bc++) for (let br=r0; br<=r1; br++) {
                        const key = bc * 997 + br;
                        let arr=vmap.get(key); if(!arr){arr=[];vmap.set(key,arr);}
                        arr.push(seg);
                    }
                }
            }
        }

        for (const k of canyonKeys) {
            const rock = this.rocks.get(k);
            if (!rock) continue;
            rock.alive    = false;
            rock.health   = 0;
            rock.diedAt   = 0;      
            rock.canyon   = true;
            rock.ore      = ORE.NONE;   
            rock.deposits = null;
        }

        // CORE CHAMBER POCKETS: the ring's vertices reach CHAMBER_RADIUS (160),
        // so carve exactly the rocks whose polygons would touch each ring plus a
        // small margin. The pocket hugs the 15-gon with an even gap of floor.
        {
            const pocketR = 160 + 26;
            const centers = [];
            for (const s of chamberCells) {
                const rock = this.rocks.get(s.key);
                if (!rock) continue;
                // polygon centroid, falling back to the lattice centre
                centers.push([rock.worldCx || rock.wx, rock.worldCy || rock.wy]);
            }
            if (centers.length) {
                const segDist = (px, py, ax, ay, bx, by) => {
                    const abx = bx - ax, aby = by - ay;
                    const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
                    const dx = px - (ax + t * abx), dy = py - (ay + t * aby);
                    return Math.sqrt(dx * dx + dy * dy);
                };
                for (const rock of this.rocks.values()) {
                    if (!rock.alive || !rock.worldPoly || rock.canyon) continue;
                    const poly = rock.worldPoly;
                    for (let ci = 0; ci < centers.length; ci++) {
                        const cx = centers[ci][0], cy = centers[ci][1];
                        let inside = false, minD = Infinity;
                        for (let e = 0; e < poly.length; e++) {
                            const [ax, ay] = poly[e], [bx, by] = poly[(e + 1) % poly.length];
                            if (((ay > cy) !== (by > cy)) &&
                                (cx < (bx - ax) * (cy - ay) / ((by - ay) || 1e-9) + ax)) inside = !inside;
                            const d = segDist(cx, cy, ax, ay, bx, by);
                            if (d < minD) minD = d;
                        }
                        if (inside || minD <= pocketR) {
                            rock.alive    = false;
                            rock.health   = 0;
                            rock.diedAt   = 0;
                            rock.canyon   = true;
                            rock.ore      = ORE.NONE;
                            rock.deposits = null;
                            break;
                        }
                    }
                }
            }
        }

        if (Config.dig_royale) {
            require('./royaleLayout.js').apply(this, { canyonKeys, outpostCells, chamberCells });
            this._canyonKeys = canyonKeys;
        }

        this.outpostSites = [];
        for (let i = 0; i < outpostCells.length; i++) {
            const cell = outpostCells[i];
            const rock = this.rocks.get(cell.key);
            this.outpostSites.push({
                id: this.outpostSites.length,
                name: cell.name,
                x: cell.x ?? rock?.worldCx ?? 0,
                y: cell.y ?? rock?.worldCy ?? 0,
                color: cell.color || null,
            });
        }

        this.coreChamberSites = [];
        for (let i = 0; i < chamberCells.length; i++) {
            const rock = this.rocks.get(chamberCells[i].key);
            if (!rock || !rock.worldPoly) continue;
            this.coreChamberSites.push({
                id: this.coreChamberSites.length,
                name: chamberCells[i].name,
                team: chamberCells[i].team,
                x: rock.worldCx,
                y: rock.worldCy,
            });
        }

        this._voronoiMap    = vmap;
        this._voronoiBucket = BUCKET;
    }

    _buildDeposits(rock) {
        const cellSize = this.cellSize;
        const halfW = this.cols * cellSize / 2, halfH = this.rows * cellSize / 2;
        const rockSz = this._voroRockSz;
        const kk = rock.k & 0xffff;
        const gsalt = rock.gen * REGROW.ORE_GEN_STRIDE;
        const h = (i, s) => TerrainGrid._dh(i, kk, (s + this.oreSalt + gsalt) | 0);
        return TerrainGrid.depositLayout(
            rock.ore, rock.tilePoly, rock.tileCx, rock.tileCy, rockSz, h
        ).map(d => ({
            wx: d.x * cellSize - halfW,
            wy: d.y * cellSize - halfH,
            wr: d.r * cellSize,
            big: d.big,
        }));
    }

    _sideOf(rock) {
        return rock.vi < this._spineMid ? 0 : rock.vi > this._spineMid ? 1 : -1;
    }

    // How far into the rise (ms at full pace) a growing rock is. The rise
    // runs at rock.growRate from rock.growAt, where it was rock.growE0 in;
    // a rate change re-anchors all three so the shape never jumps.
    riseElapsed(rock, now) {
        return (rock.growE0 || 0) + (now - (rock.growAt || 0)) * (rock.growRate || 1);
    }

    growthProgress(rock, now) {
        if (!rock.growing) return 1;
        return Math.max(0, Math.min(1, this.riseElapsed(rock, now) / REGROW.GROW_MS));
    }

    _setRiseRate(rock, now, rate) {
        if (rock.growRate === rate) return false;
        rock.growE0 = this.riseElapsed(rock, now);
        rock.growAt = now;
        rock.growRate = rate;
        rock._cp = null;
        // clients re-anchor their drawn rise the same way
        this.rockEvents.push({ k: rock.k, r: 3, e: Math.round(Math.max(-REGROW.GROW_MS, Math.min(REGROW.GROW_MS, rock.growE0))), s: Math.round(rate * 1e4) / 1e4 });
        return true;
    }

    // Every tank near a rising rock slows it (REGROW.NEAR_*). Tanks go into
    // a coarse bucket grid once, then each rising rock looks at the few
    // buckets around it: O(tanks + rising rocks), twice a second.
    _slowNearTanks(now) {
        const list = this._growing;
        let any = false;
        for (const rock of list) if (!rock.growFast) { any = true; break; }
        if (!any) return;
        const B = REGROW.NEAR_BUCKET;
        const grid = new Map();
        let maxSize = 0;
        const add = (e) => {
            if (!e || e.isGhost || (e.isDead && e.isDead())) return;
            if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) return;
            const key = Math.floor(e.x / B) * 65536 + Math.floor(e.y / B);
            const cell = grid.get(key);
            if (cell) cell.push(e); else grid.set(key, [e]);
            if ((e.size || 0) > maxSize) maxSize = e.size || 0;
        };
        const tanks = this.tankSource ? this.tankSource() : TerrainGrid._defaultTanks();
        for (const e of tanks) add(e);
        for (const rock of list) {
            if (rock.growFast) continue;
            const slow = rock.growRate !== REGROW.RISE_RATE;
            const R = (slow ? REGROW.NEAR_OFF_R : REGROW.NEAR_R);
            const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
            const reach = R + maxSize;
            const bx0 = Math.floor((x - reach) / B), bx1 = Math.floor((x + reach) / B);
            const by0 = Math.floor((y - reach) / B), by1 = Math.floor((y + reach) / B);
            let near = false, g = 1;
            for (let bx = bx0; bx <= bx1; bx++) {
                for (let by = by0; by <= by1; by++) {
                    const cell = grid.get(bx * 65536 + by);
                    if (!cell) continue;
                    for (const e of cell) {
                        const rr = R + (e.size || 0);
                        if ((e.x - x) ** 2 + (e.y - y) ** 2 <= rr * rr) { near = true; if ((e.growthMult || 1) > g) g = e.growthMult; }
                    }
                }
            }
            const gq = Math.round(g * 4) / 4;
            this._setRiseRate(rock, now, near ? REGROW.RISE_RATE * REGROW.NEAR_RATE / (1 + REGROW.GROWN_SLOW * Math.max(0, gq - 1)) : REGROW.RISE_RATE);
        }
    }

    static _arenaBodies() {
        const out = [];
        try { const b = require('./bosses.js').current(); if (b) out.push(b); } catch { }
        try { const c = require('./coreFinale.js').current(); if (c) out.push(c); } catch { }
        return out;
    }

    // Players and bots (never shots, gems or props).
    static _defaultTanks() {
        const out = [];
        const gm = global.gameManager;
        if (!gm) return out;
        for (const p of (gm.socketManager && gm.socketManager.players) || []) if (p && p.body) out.push(p.body);
        for (const b of (gm.gameHandler && gm.gameHandler.bots) || []) if (b) out.push(b);
        return out;
    }

    // How much of the cell the risen stone covers right now (START_SCALE to 1).
    growthScale(rock, now) {
        return REGROW.START_SCALE +
               (1 - REGROW.START_SCALE) * easeGrowth(this.growthProgress(rock, now));
    }

    _scaledPolyFor(rock, now) {
        if (!rock.growing || !rock.worldPoly) return null;
        if (rock._cp && Math.abs((rock._cpAt || 0) - now) < 8) return rock._cp;
        const s = this.growthScale(rock, now);
        const ax = rock.growAx, ay = rock.growAy;
        rock._cpAt = now;
        rock._cp = rock.worldPoly.map(p => [ax + (p[0] - ax) * s, ay + (p[1] - ay) * s]);
        return rock._cp;
    }

    growingRocks() { return this._growing; }

    static _polyFace(poly, x, y) {
        const inside = TerrainGrid._pointInPoly(poly, x, y);
        let best = Infinity, px = x, py = y;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const ex = b[0] - a[0], ey = b[1] - a[1];
            const L2 = ex * ex + ey * ey || 1e-12;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / L2));
            const cx2 = a[0] + ex * t, cy2 = a[1] + ey * t;
            const ddx = x - cx2, ddy = y - cy2;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < best) { best = d2; px = cx2; py = cy2; }
        }
        return { dist: Math.sqrt(best), inside, px, py };
    }

    // ── Convex-polygon helpers, all in the rock's UNSCALED frame ──────────
    // Scaling is uniform about the centroid, so a query point is divided back
    // into full-size space instead of rebuilding polygons each tick.
    static _pointInPoly(poly, x, y) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i][0], yi = poly[i][1];
            const xj = poly[j][0], yj = poly[j][1];
            if ((yi > y) !== (yj > y) &&
                x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    static _distToPoly(poly, x, y) {
        let best = Infinity;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L2 = dx * dx + dy * dy || 1e-12;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
            const ddx = x - (a[0] + t * dx), ddy = y - (a[1] + t * dy);
            const d = ddx * ddx + ddy * ddy;
            if (d < best) best = d;
        }
        return Math.sqrt(best);
    }

    // Distance from the centroid to the outline along a direction (cells are
    // convex, so the ray exits exactly once).
    static _rayExit(poly, cx, cy, dx, dy) {
        let best = Infinity;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const ex = b[0] - a[0], ey = b[1] - a[1];
            const den = dx * ey - dy * ex;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((a[0] - cx) * ey - (a[1] - cy) * ex) / den;
            const u = ((a[0] - cx) * dy - (a[1] - cy) * dx) / den;
            if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
        }
        return best === Infinity ? 0 : best;
    }

    _growingPenetration(rock, x, y, r, now) {
        // far away is the common case (every shot against every rising
        // rock): reject on the full-size reach before scaling anything
        const dx = x - rock.worldCx, dy = y - rock.worldCy;
        const reach = rock.maxPolyRadius + r;
        if (dx * dx + dy * dy > reach * reach) return 0;
        const sp = this._scaledPolyFor(rock, now);
        if (!sp || sp.length < 3) return 0;
        const f = TerrainGrid._polyFace(sp, x, y);
        return f.inside ? f.dist + r : Math.max(0, r - f.dist);
    }

    _circleHitsGrowing(rock, x, y, r, now) {
        return this._growingPenetration(rock, x, y, r, now) > 0;
    }

    growingRockHitByCircle(x, y, r, now = Date.now()) {
        for (const rock of this._growing) {
            if (this._circleHitsGrowing(rock, x, y, r, now)) return rock;
        }
        return null;
    }

    // Appends every regrowing rock the circle touches to `out`.
    growingRocksHitByCircle(x, y, r, now, out) {
        for (const rock of this._growing) {
            if (!out.includes(rock) && this._circleHitsGrowing(rock, x, y, r, now)) out.push(rock);
        }
        return out;
    }

    pushCircleFromGrowing(pos, r, now = Date.now(), maxMove = Infinity) {
        if (!this._growing.length) return { dx: 0, dy: 0, entombed: false, buried: false };
        const startX = pos.x, startY = pos.y;

        let touched = false, buried = false;

        let carry = Math.max(2, r * 0.15);
        for (let pass = 0; pass < 3; pass++) {
            let sx = 0, sy = 0, contact = false;
            for (const rock of this._growing) {
                const ddx = pos.x - rock.worldCx, ddy = pos.y - rock.worldCy;
                const reach = rock.maxPolyRadius + r;
                if (ddx * ddx + ddy * ddy > reach * reach) continue;
                const sp = this._scaledPolyFor(rock, now);
                if (!sp || sp.length < 3) continue;
                const f = TerrainGrid._polyFace(sp, pos.x, pos.y);
                if (!f.inside && f.dist >= r) continue;
                let ux, uy, need;
                if (f.inside) {
                    buried = true;   

                    let dxA = pos.x - rock.growAx, dyA = pos.y - rock.growAy;
                    let t = Math.hypot(dxA, dyA);
                    if (t < 1e-6) {
                        dxA = rock.worldCx - rock.growAx;
                        dyA = rock.worldCy - rock.growAy;
                        t = Math.hypot(dxA, dyA) || 1;
                        ux = dxA / t; uy = dyA / t; t = 0;
                    } else { ux = dxA / t; uy = dyA / t; }
                    const exit = TerrainGrid._rayExit(sp, rock.growAx, rock.growAy, ux, uy);
                    need = Math.min(exit + r - t, carry);
                    if (need <= 0) continue;
                    carry -= need;
                } else {
                    if (f.dist <= 1e-6) continue;
                    ux = (pos.x - f.px) / f.dist;
                    uy = (pos.y - f.py) / f.dist;
                    need = r - f.dist;
                }
                sx += ux * need;
                sy += uy * need;
                contact = true;
            }
            if (!contact) break;
            touched = true;
            pos.x += sx;
            pos.y += sy;

            this.pushCircleFromVoronoi(pos, r, maxMove);
            const md = Math.hypot(pos.x - startX, pos.y - startY);
            if (md > maxMove) {
                pos.x = startX + (pos.x - startX) / md * maxMove;
                pos.y = startY + (pos.y - startY) / md * maxMove;
                break;
            }

            if (Math.abs(sx) < 1e-3 && Math.abs(sy) < 1e-3) break;
        }

        if (!touched) return { dx: 0, dy: 0, entombed: false, buried: false };

        let entombed = false;
        for (const rock of this._growing) {
            if (this._growingPenetration(rock, pos.x, pos.y, r, now) > r * REGROW.CRUSH_DEPTH) {
                entombed = true;
                break;
            }
        }
        return { dx: pos.x - startX, dy: pos.y - startY, entombed, buried };
    }

    // elapsed: start this far into the rise (ms), e.g. bloom rocks at 45%.
    // opts.fast: Bulwark / raid wipe, the old quick rise and no slowdown.
    startRegrow(rock, now, elapsed = 0, opts = null) {
        if (rock.canyon) return false;
        if (!rock.worldPoly || rock.alive || rock.growing) return false;
        // a loot chest holds its pocket and exit path (chests.js holdRock);
        // nothing may grow rock there
        if (rock.chestLock || rock._chestHolds > 0) return false;
        rock.gen++;
        rock.growing    = true;
        rock.growFast   = !!(opts && opts.fast);
        rock.growRate   = rock.growFast ? ((opts && opts.rate) || REGROW.FAST_RATE) : REGROW.RISE_RATE;
        rock.growAt     = now;
        rock.growE0     = elapsed > 0 ? elapsed : 0;
        rock.growDamage = 0;
        rock.diedAt     = 0;
        rock.alive      = false;
        if (Config.dig_royale && this.circleRadius) {
            try {
                const rl = require('./royaleLayout.js');
                rock.ore = rl.radialOre(rock, this.circleRadius, (this.oreSalt || 7) + rock.gen * 131);
            } catch { rock.ore = this._oreTierFor(rock.vi, rock.vj, this._voroViLo, this._voroViHi, rock.gen * REGROW.ORE_GEN_STRIDE); }
        } else {
            rock.ore = this._oreTierFor(rock.vi, rock.vj, this._voroViLo, this._voroViHi, rock.gen * REGROW.ORE_GEN_STRIDE);
        }
        // a bloom rock regrows as ore every time while the bloom lasts
        if (Config.dig_royale && this._bloomNow) {
            const bl = this._bloomNow;
            if (((rock.wx - bl.x) ** 2 + (rock.wy - bl.y) ** 2) <= bl.r * bl.r) {
                const copperOnly = global.royaleMods && global.royaleMods.ore === 'copper';
                rock.ore = copperOnly ? ORE.COPPER : (Math.random() < 0.28 ? ORE.SHARD : ORE.VEIN);
                rock.bloomed = true;
            }
        }
        // biome x ore toughness (royaleLayout.js), 1 off the raid map; a
        // regrown rock is never a softened spawn rock
        rock.soft       = false;
        rock.maxHealth  = ROCK_HEALTH * ORE_HP[rock.ore] * ((global.royaleMods && global.royaleMods.rockHpMult) || 1) * rockTough(rock);
        rock.health     = rock.maxHealth * REGROW.HP_FLOOR;
        rock.deposits   = rock.ore ? this._buildDeposits(rock) : null;

        let nx = 0, ny = 0, found = 0, fx = 0, fy = 0;
        for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nb = this.rocks.get((rock.vi + di) * 100003 + (rock.vj + dj));
            if (nb && nb.alive && nb.worldPoly) {
                const ddx = nb.worldCx - rock.worldCx, ddy = nb.worldCy - rock.worldCy;
                if (!found) { fx = ddx; fy = ddy; }
                nx += ddx; ny += ddy;
                found++;
            }
        }

        if (found && Math.hypot(nx, ny) < 1e-6) { nx = fx; ny = fy; }
        if (found && Math.hypot(nx, ny) > 1e-6) {
            const dl = Math.hypot(nx, ny);
            const exit = TerrainGrid._rayExit(rock.worldPoly, rock.worldCx, rock.worldCy, nx / dl, ny / dl);
            rock.growAx = rock.worldCx + (nx / dl) * exit;
            rock.growAy = rock.worldCy + (ny / dl) * exit;
        } else {
            rock.growAx = rock.worldPoly[0][0];
            rock.growAy = rock.worldPoly[0][1];
        }
        rock._cp = null; rock._cpAt = 0;

        this._growing.push(rock);

        const halfW = this.cols * this.cellSize / 2;
        const halfH = this.rows * this.cellSize / 2;
        // e: ms into the rise the collision shape already is (a bloom starts at
        // 45%; staggered starts are negative), so the client's drawn rise
        // matches the server's shape.
        // s: the rise pace (1 = full, less near a tank, 2 for a Bulwark)
        const riseE = Math.max(-REGROW.GROW_MS, Math.min(REGROW.GROW_MS, Math.round(this.riseElapsed(rock, Date.now()))));
        this.rockEvents.push({
            k: rock.k, r: 1, o: rock.ore, gen: rock.gen, e: riseE, s: rock.growRate,
            ax: Math.round((rock.growAx + halfW) / this.cellSize * 100) / 100,
            ay: Math.round((rock.growAy + halfH) / this.cellSize * 100) / 100,
        });
        return true;
    }

    _unlistGrowing(rock) {
        const i = this._growing.indexOf(rock);
        if (i !== -1) this._growing.splice(i, 1);
    }

    completeRegrow(rock) {
        rock.growing    = false;
        rock.alive      = true;
        // keep the damage it took while rising
        rock.health     = Math.max(1, rock.maxHealth - (rock.growDamage || 0));
        rock.growDamage = 0;
        rock._cp = null;
        this._unlistGrowing(rock);
        this.rockEvents.push({ k: rock.k, r: 2 });
        if (rock.health < rock.maxHealth) this.rockEvents.push({ k: rock.k, h: rock.health / rock.maxHealth, hl: 1 });
    }

    // Support Strut: nothing inside the circle may start regrowing until
    // `until`, including rocks that die there after the strut went down.
    addNoRegrowZone(x, y, r, until) {
        const now = Date.now();
        this._noRegrowZones = (this._noRegrowZones || []).filter(z => z.until > now);
        const zone = { x, y, r2: r * r, until };
        this._noRegrowZones.push(zone);
        return zone;       // callers may shorten `until` later (chests do)
    }
    _inNoRegrowZone(rock, now) {
        const zones = this._noRegrowZones;
        if (!zones || !zones.length) return false;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        for (const z of zones) {
            if (z.until > now && (rx - z.x) ** 2 + (ry - z.y) ** 2 <= z.r2) return true;
        }
        return false;
    }

    regrowTick(now) {
        if (!this._voronoiMap) return;
        if (Config.dig_royale) { try { this._bloomNow = require('./blooms.js').current(); } catch { this._bloomNow = null; } }
        const gap = this._rgWall ? now - this._rgWall : 0;
        this._rgWall = now;
        const budget = gap > 80 ? Math.ceil(REGROW.REGROW_SLICE * gap / REGROW.REGROW_SLICE_TICK_MS) : REGROW.REGROW_SLICE;
        if (this._rg) { this._regrowSlice(now, budget); return; }
        if (now - this._lastRegrowTick < REGROW.PACING_MS) return;
        this._lastRegrowTick = now;

        this._slowNearTanks(now);
        for (let i = this._growing.length - 1; i >= 0; i--) {
            const rock = this._growing[i];
            if (this.riseElapsed(rock, now) >= REGROW.GROW_MS) { this.completeRegrow(rock); continue; }

            const target = rock.maxHealth *
                Math.max(REGROW.HP_FLOOR, easeGrowth(this.growthProgress(rock, now)));
            rock.health = Math.max(1, target - rock.growDamage);
        }

        const keys = [];
        for (const k of this.rocks.keys()) keys.push(k);
        this._rg = { keys, i: 0, gap0: 0, gap1: 0, pass: 0, tankIndex: null, orphans: this._orphanRegrowOn() };
        this._regrowSlice(now, budget);
    }

    _regrowSlice(now, budget) {
        while (this._rg && budget > 0) {
            const rg = this._rg;
            const end = Math.min(rg.keys.length, rg.i + budget);
            const start = rg.i;
            for (; rg.i < end; rg.i++) {
                const rock = this.rocks.get(rg.keys[rg.i]);
                if (!rock) continue;
                if (rg.pass === 0) {
                    if (rock.alive) {
                        if (rock.health < rock.maxHealth &&
                            now - (rock.lastHitAt || 0) >= REGROW.HEAL_IDLE_MS) {
                            rock.health = Math.min(rock.maxHealth,
                                rock.health + rock.maxHealth * REGROW.HEAL_RATE * (REGROW.PACING_MS / 1000));
                            const h = rock.health / rock.maxHealth;
                            const bucket = h >= 1 ? 999 : (h * 24) | 0;
                            if (bucket !== rock._healBucket) {
                                rock._healBucket = bucket;
                                this.rockEvents.push({ k: rock.k, h, hl: 1 });
                            }
                        }
                        continue;
                    }
                    if (rock.growing || !rock.diedAt) continue;
                    const side = this._sideOf(rock);
                    if (side === 0) rg.gap0++; else if (side === 1) rg.gap1++;
                    continue;
                }
                if (rock.alive || rock.growing || !rock.diedAt || !rock.worldPoly) continue;
                const side = this._sideOf(rock);
                const delay = side === -1
                    ? Math.min(this._regrowDelay[0], this._regrowDelay[1])
                    : this._regrowDelay[side];
                let bloomRock = false;
                if (Config.dig_royale) {
                    const bl = this._bloomNow || null;
                    if (bl && ((rock.wx - bl.x) ** 2 + (rock.wy - bl.y) ** 2) <= bl.r * bl.r) bloomRock = true;
                }
                if (now - rock.diedAt < (bloomRock ? REGROW.BLOOM_DELAY_MS : delay)) continue;
                if (rock.noRegrowUntil && now < rock.noRegrowUntil) continue;
                if (this._inNoRegrowZone(rock, now)) continue;
                if (!bloomRock && !this._hasLivingNeighbour(rock)) {
                    if (!rg.orphans || now - rock.diedAt < REGROW.ORPHAN_DELAY_MS || this._hasGrowingNeighbour(rock)) continue;
                }
                if (!rg.tankIndex) rg.tankIndex = this._tankIndex();
                if (this._tankOnCell(rg.tankIndex, rock)) continue;
                this.startRegrow(rock, now, bloomRock ? REGROW.GROW_MS * REGROW.BLOOM_START : 0);
            }
            budget -= rg.i - start;
            if (rg.i < rg.keys.length) return;
            if (rg.pass === 0) {
                const delayFor = (mine, theirs) => Math.max(REGROW.MIN_DELAY_MS,
                    Math.min(REGROW.BASE_DELAY_MS,
                        REGROW.BASE_DELAY_MS - REGROW.DEFICIT_MS_PER_GAP * Math.max(0, mine - theirs)));
                this._regrowDelay[0] = delayFor(rg.gap0, rg.gap1);
                this._regrowDelay[1] = delayFor(rg.gap1, rg.gap0);
                rg.pass = 1;
                rg.i = 0;
                continue;
            }
            this._rg = null;
            if (this._pendingEmeralds.length && now - (this._emeraldTickAt || 0) > 2000) {
                this._emeraldTickAt = now;
                this._tickEmeraldRespawns(now);
            }
        }
    }

    _tankIndex() {
        const B = REGROW.NEAR_BUCKET;
        const buckets = new Map();
        let maxSize = 0;
        const tanks = (this.tankSource ? this.tankSource() : TerrainGrid._defaultTanks()) || [];
        const bigs = Config.dig_royale ? TerrainGrid._arenaBodies() : [];
        for (const e of bigs.length ? tanks.concat(bigs) : tanks) {
            if (!e || e.isGhost || (e.isDead && e.isDead())) continue;
            if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
            const key = Math.floor(e.x / B) * 65536 + Math.floor(e.y / B);
            const list = buckets.get(key);
            if (list) list.push(e); else buckets.set(key, [e]);
            if ((e.size || 0) > maxSize) maxSize = e.size || 0;
        }
        return { B, buckets, maxSize };
    }

    _tankOnCell(index, rock) {
        if (!index || !index.buckets.size) return false;
        const { B, buckets, maxSize } = index;
        const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
        const base = (rock.maxPolyRadius || this._cellWorld || 100) + REGROW.START_CLEAR;
        const reach = base + maxSize;
        const bx0 = Math.floor((x - reach) / B), bx1 = Math.floor((x + reach) / B);
        const by0 = Math.floor((y - reach) / B), by1 = Math.floor((y + reach) / B);
        for (let bx = bx0; bx <= bx1; bx++) {
            for (let by = by0; by <= by1; by++) {
                const list = buckets.get(bx * 65536 + by);
                if (!list) continue;
                for (const e of list) {
                    const rr = base + (e.size || 0);
                    if ((e.x - x) ** 2 + (e.y - y) ** 2 <= rr * rr) return true;
                }
            }
        }
        return false;
    }

    _orphanRegrowOn() {
        if (!Config.dig_royale || Config.tutorial) return false;
        try { return !!require('./alwaysOn.js').on(); } catch { return false; }
    }

    _hasGrowingNeighbour(rock) {
        const { vi, vj } = rock;
        for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const r = this.rocks.get((vi + di) * 100003 + (vj + dj));
            if (r && r.growing) return true;
        }
        return false;
    }

    _hasLivingNeighbour(rock) {
        const { vi, vj } = rock;
        const n = (i, j) => {
            const r = this.rocks.get(i * 100003 + j);
            return !!(r && r.alive && !r.growing);
        };
        return n(vi - 1, vj) || n(vi + 1, vj) || n(vi, vj - 1) || n(vi, vj + 1);
    }

    _tickEmeraldRespawns(now) {
        const pending = this._pendingEmeralds;
        let due = false;
        for (const p of pending) if (p.at <= now) { due = true; break; }
        if (!due) return;
        const blocked = this._emeraldBlocked();
        let planted = 0;
        for (let i = pending.length - 1; i >= 0 && planted < REGROW.EMERALD_PLANTS_PER_PASS; i--) {
            if (pending[i].at > now) continue;
            if (!this._plantEmerald(blocked)) break;
            pending.splice(i, 1);
            planted++;
        }
    }

    _blockAroundEmerald(blocked, vi, vj) {
        const g = REGROW.EMERALD_GAP, g2 = g * g;
        for (let di = 1 - g; di < g; di++) {
            for (let dj = 1 - g; dj < g; dj++) {
                if (di * di + dj * dj < g2) blocked.add((vi + di) * 100003 + (vj + dj));
            }
        }
    }

    _emeraldBlocked() {
        const blocked = new Set();
        for (const rock of this.rocks.values()) {
            if (rock.ore === ORE.EMERALD && (rock.alive || rock.growing)) this._blockAroundEmerald(blocked, rock.vi, rock.vj);
        }
        return blocked;
    }

    _plantEmerald(blocked = this._emeraldBlocked()) {
        const viLo = this._voroViLo, viHi = this._voroViHi;
        const halfSpan = Math.max(1, (viHi - viLo) / 2);
        const salt = this.oreSalt + 13 + (++this._emeraldRespawns) * 104729;
        let best = null, bestScore = Infinity;
        for (const rock of this.rocks.values()) {
            if (!rock.alive || rock.growing || rock.ore !== ORE.NONE) continue;
            if (this._canyonNearKeys && this._canyonNearKeys.has(rock.k)) continue;
            const depth = Math.min(rock.vi - viLo, viHi - rock.vi) / halfSpan;
            if (depth < 0.7) continue;
            if (blocked.has(rock.vi * 100003 + rock.vj)) continue;
            const score = this._oreRoll(rock.vi, rock.vj, salt);
            if (score < bestScore) { bestScore = score; best = rock; }
        }
        if (!best) { this._emeraldRespawns--; return false; }
        this._blockAroundEmerald(blocked, best.vi, best.vj);
        const oldMax = best.maxHealth || 1;
        const frac = Math.min(1, best.health / oldMax);
        best.ore       = ORE.EMERALD;
        best.maxHealth = ROCK_HEALTH * ORE_HP[ORE.EMERALD] * rockTough(best, ORE.EMERALD);
        best.health    = frac * best.maxHealth;
        best.deposits  = this._buildDeposits(best);
        this.rockEvents.push({ k: best.k, e: 1 });
        return true;
    }

    // ─── Point / circle vs rock queries ───────────────────────────────────────
    // A point is inside a rock iff its nearest Voronoi seed (same float32 hash
    // as the client) belongs to a live rock. Returns the rock or false.
    pointInRock(wx, wy) {
        if (!this._voronoiMap) return false;
        const halfW = this.cols * this.cellSize / 2;
        const halfH = this.rows * this.cellSize / 2;
        const s  = this._voroRockSz * this.cellSize; 
        const px = (wx + halfW) / s, py = (wy + halfH) / s;
        const nx = Math.floor(px), ny = Math.floor(py);
        let best = Infinity, bi = 0, bj = 0;
        for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
                const [hx, hy] = this._hash2(nx + di, ny + dj);
                const sx = nx + di + hx, sy = ny + dj + hy;
                const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
                if (d < best) { best = d; bi = nx + di; bj = ny + dj; }
            }
        }
        if (bi < this._voroViLo || bi > this._voroViHi ||
            bj < this._voroVjLo || bj > this._voroVjHi) return false;
        const rock = this.rocks.get(bi * 100003 + bj);
        return rock && rock.alive ? rock : false;
    }

    rockHitByCircle(x, y, r) {
        const inside = this.pointInRock(x, y);
        if (inside) return inside;
        if (!this._voronoiMap) return null;
        const BUCKET = this._voronoiBucket, smap = this._voronoiMap;
        const c0 = Math.floor((x - r) / BUCKET), c1 = Math.floor((x + r) / BUCKET);
        const r0 = Math.floor((y - r) / BUCKET), r1 = Math.floor((y + r) / BUCKET);
        const rr = r * r;
        let best = rr, hit = null;
        for (let bc = c0; bc <= c1; bc++) {
            for (let br = r0; br <= r1; br++) {
                const arr = smap.get(bc * 997 + br);
                if (!arr) continue;
                for (const seg of arr) {
                    if (seg.rock && !seg.rock.alive) continue;
                    const dax = x - seg.ax, day = y - seg.ay;
                    const t   = Math.max(0, Math.min(seg.len, dax * seg.edx + day * seg.edy));
                    const dx  = x - (seg.ax + t * seg.edx);
                    const dy  = y - (seg.ay + t * seg.edy);
                    const d2  = dx * dx + dy * dy;
                    if (d2 < best) { best = d2; hit = seg.rock; }
                }
            }
        }
        return hit;
    }

    // Every live rock the circle touches, not just the nearest. Fills `out`
    // (cleared first) so the per-bullet path allocates nothing.
    rocksHitByCircle(x, y, r, out) {
        out.length = 0;
        const inside = this.pointInRock(x, y);
        if (inside) out.push(inside);
        if (!this._voronoiMap) return out;
        const BUCKET = this._voronoiBucket, smap = this._voronoiMap;
        const c0 = Math.floor((x - r) / BUCKET), c1 = Math.floor((x + r) / BUCKET);
        const r0 = Math.floor((y - r) / BUCKET), r1 = Math.floor((y + r) / BUCKET);
        const rr = r * r;
        for (let bc = c0; bc <= c1; bc++) {
            for (let br = r0; br <= r1; br++) {
                const arr = smap.get(bc * 997 + br);
                if (!arr) continue;
                for (const seg of arr) {
                    const rock = seg.rock;
                    if (!rock || !rock.alive || out.includes(rock)) continue;
                    const dax = x - seg.ax, day = y - seg.ay;
                    const t   = Math.max(0, Math.min(seg.len, dax * seg.edx + day * seg.edy));
                    const dx  = x - (seg.ax + t * seg.edx);
                    const dy  = y - (seg.ay + t * seg.edy);
                    if (dx * dx + dy * dy < rr) out.push(rock);
                }
            }
        }
        return out;
    }

    circleHitsRock(x, y, r) { return !!this.rockHitByCircle(x, y, r); }

    nearestRock(wx, wy, maxR = 450) {
        return this.nearestRockWhere(wx, wy, maxR, null);
    }

    // Same lattice walk as nearestRock with an optional predicate, so callers
    // can ask for "nearest ore rock" without scanning every rock on the map.
    nearestRockWhere(wx, wy, maxR = 450, predicate = null) {
        if (!this._voronoiMap) return null;
        const halfW = this.cols * this.cellSize / 2;
        const halfH = this.rows * this.cellSize / 2;
        const s  = this._voroRockSz * this.cellSize; 
        const ni = Math.floor((wx + halfW) / s);
        const nj = Math.floor((wy + halfH) / s);
        const reach = Math.ceil(maxR / s) + 1;
        let best = maxR * maxR, hit = null;
        for (let dj = -reach; dj <= reach; dj++) {
            for (let di = -reach; di <= reach; di++) {
                const vi = ni + di, vj = nj + dj;
                if (vi < this._voroViLo || vi > this._voroViHi ||
                    vj < this._voroVjLo || vj > this._voroVjHi) continue;
                const rock = this.rocks.get(vi * 100003 + vj);
                if (!rock || !rock.alive) continue;
                if (predicate && !predicate(rock)) continue;
                const dx = rock.wx - wx, dy = rock.wy - wy;
                const d2 = dx * dx + dy * dy;
                if (d2 < best) { best = d2; hit = rock; }
            }
        }
        return hit;
    }

    // Apply damage and queue a network delta. Returns true if it destroyed the rock.
    damageRock(rock, dmg, wx, wy, grind, owner, uncapped) {
        if (!rock || (!rock.alive && !rock.growing) || !(dmg > 0)) return false;
        if (owner && !grind && ORE_HIT_CAP[rock.ore] && rock.maxHealth > 0) dmg = Math.min(dmg, rock.maxHealth * ORE_HIT_CAP[rock.ore]);

        let breaker = owner;
        for (let i = 0; breaker && breaker.master && breaker.master !== breaker && i < 8; i++) breaker = breaker.master;
        const breaks = breaker && !uncapped && rock.health - dmg <= 0 ? (breaker._rockBreaks || (breaker._rockBreaks = [])) : null;
        if (breaks) {
            const t = Date.now();
            while (breaks.length && t - breaks[0] >= 1000) breaks.shift();
            if (breaks.length >= ROCK_BREAKS_PER_SEC) dmg = Math.max(0, rock.health - 1);
            else breaks.push(t);
            if (!(dmg > 0)) return false;
        }

        const wasGrowing = rock.growing;
        if (wasGrowing) rock.growDamage += dmg;
        rock.lastHitAt = Date.now();   
        rock.health -= dmg;
        const destroyed = rock.health <= 0;
        if (destroyed) {
            rock.health = 0;
            rock.alive = false;

            if (wasGrowing) { rock.growing = false; rock._cp = null; this._unlistGrowing(rock); }
            rock.growDamage = 0;
            rock.diedAt = Date.now();

            if (!wasGrowing && rock.ore === ORE.EMERALD && this._pendingEmeralds.length < REGROW.EMERALD_PENDING_MAX)
                this._pendingEmeralds.push({ at: rock.diedAt + ((global.royaleMods && global.royaleMods.emeraldRespawnMs) || REGROW.EMERALD_RESPAWN_MS) });
            // achievements (accounts/game/achHooks.js): a player broke it
            if (!wasGrowing && owner && owner.socket && global.royaleAch) global.royaleAch.onRock(owner, rock);
        }
        const ev = { k: rock.k, h: rock.health / rock.maxHealth, d: destroyed ? 1 : 0 };
        // g: hull scraping, clients draw soft grind sparks
        if (grind && !destroyed) ev.g = 1;

        if (destroyed && rock.ore && !wasGrowing) ev.o = rock.ore;

        if (destroyed && wasGrowing) ev.p = 1;
        if (wx !== undefined) {
            const halfW = this.cols * this.cellSize / 2;
            const halfH = this.rows * this.cellSize / 2;
            ev.x = Math.round((wx + halfW) / this.cellSize * 100) / 100;
            ev.y = Math.round((wy + halfH) / this.cellSize * 100) / 100;
        }
        if (!grind && owner && owner.socket && rock.maxHealth > 0) {
            ev.n = Math.max(1, Math.round(100 * dmg / rock.maxHealth));
            ev.u = owner.id;
        }
        if (!destroyed && this.rockEvents.length) {
            const stop = Math.max(0, this.rockEvents.length - REGROW.EVENT_MERGE_LOOKBACK);
            for (let i = this.rockEvents.length - 1; i >= stop; i--) {
                const prev = this.rockEvents[i];
                if (prev.k !== rock.k) continue;
                if (prev.d || prev.r || prev.e || prev.bl) break;
                prev.h = ev.h;
                if (ev.x !== undefined) { prev.x = ev.x; prev.y = ev.y; }
                if (ev.n && prev.u === ev.u) prev.n = (prev.n || 0) + ev.n;
                else if (ev.n && !prev.u) { prev.n = ev.n; prev.u = ev.u; }
                return false;
            }
        }
        this.rockEvents.push(ev);
        return destroyed;
    }

    rockStateSnapshot() {
        const out = [];
        const now = Date.now();
        for (const rock of this.rocks.values()) {
            if (rock.growing) {
                const halfW = this.cols * this.cellSize / 2;
                const halfH = this.rows * this.cellSize / 2;
                out.push({ k: rock.k, h: rock.health / rock.maxHealth, d: 1,
                           r: Math.max(0, Math.round(this.riseElapsed(rock, now))), s: rock.growRate || 1,
                           o: rock.ore, gen: rock.gen,
                           ax: Math.round((rock.growAx + halfW) / this.cellSize * 100) / 100,
                           ay: Math.round((rock.growAy + halfH) / this.cellSize * 100) / 100 });
            } else if (!rock.alive) {
                out.push({ k: rock.k, h: 0, d: 1 });
            } else if (rock.health < rock.maxHealth || rock.gen > 0) {
                // gen is sent even at full health: the client keys regrown
                // rock visuals off it
                out.push({ k: rock.k, h: rock.health / rock.maxHealth, d: 0, gen: rock.gen });
            }
        }
        return out;
    }

    // Living ore cells as [key, tier] pairs, sent with the TG snapshot.
    oreSnapshot() {
        const out = [];
        for (const rock of this.rocks.values()) {
            if (rock.alive && rock.ore) out.push([rock.k, rock.ore]);
        }
        return out;
    }

    // maxMove caps how far one call may shift the circle. Every edge inside the
    // circle pushes on its own, so a big hull sunk into solid rock (dozens of
    // cell edges, both sides of each) adds up to a throw across the map; the
    // per-tick tank pass caps it so the hull slides out over a few ticks.
    pushCircleFromVoronoi(pos, r, maxMove = Infinity) {
        if (!this._voronoiMap) return { dx: 0, dy: 0 };
        const BUCKET = this._voronoiBucket;
        const smap   = this._voronoiMap;
        const startX = pos.x, startY = pos.y;
        const tick   = ++this._voronoiTick;

        for (let pass = 0; pass < 3; pass++) {
            const cx = pos.x, cy = pos.y;
            const c0 = Math.floor((cx-r)/BUCKET), c1 = Math.floor((cx+r)/BUCKET);
            const r0 = Math.floor((cy-r)/BUCKET), r1 = Math.floor((cy+r)/BUCKET);
            let moved = false;

            for (let bc = c0; bc <= c1; bc++) {
                for (let br = r0; br <= r1; br++) {
                    const arr = smap.get(bc * 997 + br);
                    if (!arr) continue;
                    for (const seg of arr) {
                        if (seg._tick === tick) continue;
                        seg._tick = tick;
                        if (seg.rock && !seg.rock.alive) continue;
                        const dax = pos.x-seg.ax, day = pos.y-seg.ay;
                        const t   = Math.max(0, Math.min(seg.len, dax*seg.edx+day*seg.edy));
                        const ncx = seg.ax+t*seg.edx, ncy = seg.ay+t*seg.edy;
                        const dx  = pos.x-ncx, dy = pos.y-ncy;
                        const dist2 = dx*dx + dy*dy;
                        if (dist2 >= r*r) continue;
                        const dist = Math.sqrt(dist2);
                        let pnx, pny;
                        if (dist < 1e-6) { pnx = seg.nx; pny = seg.ny; }
                        else {
                            pnx = dx/dist; pny = dy/dist;
                            if (pnx*seg.nx+pny*seg.ny < 0) { pnx=-pnx; pny=-pny; }
                        }
                        pos.x += pnx*(r-dist); pos.y += pny*(r-dist);
                        moved = true;
                    }
                }
            }
            if (!moved) break;
            const mx = pos.x - startX, my = pos.y - startY, md = Math.hypot(mx, my);
            if (md > maxMove) {
                pos.x = startX + mx / md * maxMove;
                pos.y = startY + my / md * maxMove;
                break;
            }
        }
        return { dx: pos.x-startX, dy: pos.y-startY };
    }

    // One tick of rock contact for a tank (game loop terrain pass): push it
    // out of live and rising rock, and spit it out to open ground if its
    // centre ended up inside a rock. -> { dx, dy, entombed } (dx/dy: the
    // edge push, for the slide and grind). breakOut(body), if given, may
    // clear the rock around a buried hull (a grown tank cracks it); true when
    // it did, and the hull stays where it is.
    settleTank(body, r, now, growingNow, breakOut = null) {
        // a normal tank never needs more than this in a tick; a grown hull
        // sunk deep in rock slides out instead of being thrown
        const maxPush = Math.max(48, r * 0.35);
        const p = this.pushCircleFromVoronoi(body, r, maxPush);
        let dx = p.dx, dy = p.dy, entombed = false;
        if (growingNow) {
            const g = this.pushCircleFromGrowing(body, r, now, maxPush);
            entombed = g.entombed;
            if (g.dx !== 0 || g.dy !== 0) { dx += g.dx; dy += g.dy; }
            if (g.buried) {
                body.velocity.x = 0; body.velocity.y = 0;
                body.accel.x = 0;    body.accel.y = 0;
            }
        }
        // (a push that hit its cap means the hull is sunk deep, centre in or not)
        const deep = Math.hypot(p.dx, p.dy) >= maxPush - 1e-6;
        if ((entombed || deep || this.pointInRock(body.x, body.y)) && breakOut && breakOut(body)) {
            entombed = false;
            for (const rock of this._growing) {
                if (this._growingPenetration(rock, body.x, body.y, r, now) > r * REGROW.CRUSH_DEPTH) { entombed = true; break; }
            }
        }
        if (this.pointInRock(body.x, body.y)) {
            entombed = true;
            // Center is inside a live rock, past the reach of the edge push above (a
            // regrow landing on a tank, a spawn overlap, a missed edge). The pass
            // crushes it, and it goes out to the nearest open ground.
            const o = this.openSpotNear(body.x, body.y, r);
            if (o) {
                body.x = o.x;
                body.y = o.y;
                this.pushCircleFromVoronoi(body, r, maxPush);
            }
            body.velocity.x = 0; body.velocity.y = 0;
            body.accel.x = 0;    body.accel.y = 0;
        }
        return { dx, dy, entombed };
    }

    // Nearest spot to (x, y) whose centre is out of live rock, searched in
    // rings `step` apart out to `reach`. Small steps: the old 2r step put a
    // big hull's first ring a whole diameter away. Past the map edge there is
    // no rock at all, so spots out there never count. -> { x, y } or null
    openSpotNear(x, y, r, reach = Math.max(384, r * 16)) {
        if (!this.pointInRock(x, y)) return { x, y };
        const step = Math.max(40, Math.min(r, 90));
        const rings = Math.min(60, Math.ceil(reach / step));
        const edge = this.edgeMargin(r);
        for (let ring = 1; ring <= rings; ring++) {
            const n = Math.min(48, 12 + ring * 2);
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2 + ring * 0.35;
                const nx = x + Math.cos(a) * step * ring, ny = y + Math.sin(a) * step * ring;
                if (!this.pointInRock(nx, ny) && this.inPlayArea(nx, ny, edge)) return { x: nx, y: ny };
            }
        }
        return null;
    }

    // The playable map: the raid's disk when there is one (royaleLayout cuts
    // the rock off outside it, leaving open nothing), else the whole grid.
    // margin: how far inside its edge.
    inPlayArea(x, y, margin = 0) {
        if (!(isFinite(x) && isFinite(y))) return false;
        if (this.circleRadius > 0) return x * x + y * y <= Math.max(0, this.circleRadius - margin) ** 2;
        const hw = this.cols * this.cellSize / 2 - margin, hh = this.rows * this.cellSize / 2 - margin;
        return Math.abs(x) <= Math.max(0, hw) && Math.abs(y) <= Math.max(0, hh);
    }
    // How far in from the edge a hull of radius r sits (never more than
    // half the map, however big it is).
    edgeMargin(r) {
        const half = this.circleRadius > 0 ? this.circleRadius : Math.min(this.cols, this.rows) * this.cellSize / 2;
        return Math.min(Math.max(0, r || 0) + 40, half * 0.5);
    }
    // Pulls pos back inside the play area, `margin` in from the edge (a bad
    // number goes to the middle). slack: how far past that it may already be
    // and stay put, never past the edge itself (a resume on the rim).
    // -> true if it had to move
    clampToPlay(pos, margin = 0, slack = 0) {
        if (!(isFinite(pos.x) && isFinite(pos.y))) { pos.x = 0; pos.y = 0; return true; }
        if (this.inPlayArea(pos.x, pos.y, Math.max(0, margin - slack))) return false;
        if (this.circleRadius > 0) {
            const R = Math.max(0, this.circleRadius - margin), d = Math.hypot(pos.x, pos.y);
            pos.x *= R / d; pos.y *= R / d;
            return true;
        }
        const hw = Math.max(0, this.cols * this.cellSize / 2 - margin), hh = Math.max(0, this.rows * this.cellSize / 2 - margin);
        pos.x = Math.max(-hw, Math.min(hw, pos.x));
        pos.y = Math.max(-hh, Math.min(hh, pos.y));
        return true;
    }

    pushCircleFromContour(pos, r) {
        if (!this._contourMap) return { dx: 0, dy: 0 };
        const BUCKET = this._contourBucket;
        const smap   = this._contourMap;
        const startX = pos.x, startY = pos.y;
        const tick   = ++this._contourTick;

        for (let pass = 0; pass < 3; pass++) {
            const cx = pos.x, cy = pos.y;
            const c0 = Math.floor((cx - r) / BUCKET), c1 = Math.floor((cx + r) / BUCKET);
            const r0 = Math.floor((cy - r) / BUCKET), r1 = Math.floor((cy + r) / BUCKET);
            let moved = false;

            for (let bc = c0; bc <= c1; bc++) {
                for (let br = r0; br <= r1; br++) {
                    const arr = smap.get(bc * 997 + br);
                    if (!arr) continue;
                    for (const seg of arr) {
                        if (seg._tick === tick) continue;
                        seg._tick = tick;

                        const dax = pos.x - seg.ax, day = pos.y - seg.ay;
                        const t   = Math.max(0, Math.min(seg.len,
                                        dax * seg.edx + day * seg.edy));
                        const ncx = seg.ax + t * seg.edx;
                        const ncy = seg.ay + t * seg.edy;
                        const dx  = pos.x - ncx, dy = pos.y - ncy;
                        const dist2 = dx*dx + dy*dy;
                        if (dist2 >= r*r) continue;
                        const dist = Math.sqrt(dist2);

                        let pnx, pny;
                        if (dist < 1e-6) {
                            pnx = seg.nx; pny = seg.ny;
                        } else {
                            pnx = dx / dist; pny = dy / dist;
                            if (pnx * seg.nx + pny * seg.ny < 0) { pnx = -pnx; pny = -pny; }
                        }
                        const ov = r - dist;
                        pos.x += pnx * ov;
                        pos.y += pny * ov;
                        moved = true;
                    }
                }
            }
            if (!moved) break;
        }
        return { dx: pos.x - startX, dy: pos.y - startY };
    }
}

module.exports = { TerrainGrid, CELL, ORE, ORE_HP, REGROW, easeGrowth, rockTough, rockPay };
