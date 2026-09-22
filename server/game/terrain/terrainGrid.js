const CELL = { BASALT: 0, EMPTY: 1 };

const { basePolygonHealth } = require('../../lib/definitions/constants.js');

const ROCK_DAMAGE_BASE = 0.75 * 0.7 * 0.75 * 562.5 * basePolygonHealth;
const ROCK_TOUGHNESS = 1.3;
const ROCK_HEALTH = ROCK_TOUGHNESS * ROCK_DAMAGE_BASE;

const ORE = { NONE: 0, COPPER: 1, VEIN: 2, SHARD: 3, EMERALD: 4 };
const ORE_CHANCE = 0.22;   

const EMERALD_COUNT = 3;

const ORE_HP = { [ORE.NONE]: 1, [ORE.COPPER]: 1.8, [ORE.VEIN]: 2.2,
                 [ORE.SHARD]: 3, [ORE.EMERALD]: 6 };

const REGROW = {
    BASE_DELAY_MS:      23_000, 
    MIN_DELAY_MS:       10_000, 
    DEFICIT_MS_PER_GAP:    300, 
    GROW_MS:             8_000, 
    START_SCALE:          0.15, 
    HP_FLOOR:             0.25, 
    
    
    HEAL_IDLE_MS:       30_000, 
    HEAL_RATE:           0.008, 
    CRUSH_DPS_FRAC:       0.25, 
                                
                                
    CRUSH_DEPTH:          0.30, 
                                
                                
    PACING_MS:             500, 
    EMERALD_RESPAWN_MS: 60_000, 
    ORE_GEN_STRIDE:       7919, 
};

function easeGrowth(p) { return p * p * (3 - 2 * p); }

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

    // Ore tier for a lattice cell. depth is 0 at the carved wall faces and 1
    
    
    
    
    
    
    
    
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
            out.push({ x: cx, y: cy, r: (tier === 4 ? 0.34 : 0.30) * rockSz,
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
        // Rock size is lattice-derived: cols/50 lattice cells per rock. That
        // made rocks GROW with map width - the tutorial's wide multi-plot room
        // magnified every rock ~2.4x. Clamp at the live map's width (15 tiles
        // = 120 cols) so rocks are the same world size on every map. Mirrored
        // in public/client/terrainRenderer.js - the four voronoi
        // implementations must stay identical (see AGENTS notes).
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

        // Saved for point-in-rock queries (pointInRock / circleHitsRock)
        this._voroRockSz = rockSz;
        this._voroViLo = viLo; this._voroViHi = viHi;
        this._voroVjLo = vjLo; this._voroVjHi = vjHi;
        // the wall's spine: everything left of it is one side's frontier,
        
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
            // every site gets its own small carved pocket (a mini-canyon:
            
            for (const s of outpostCells) {
                const svi = Math.floor(s.key / 100003), svj = s.key % 100003;
                for (let di = -1; di <= 1; di++)
                    for (let dj = -1; dj <= 1; dj++) {
                        const vi2 = Math.max(viLo, Math.min(viHi, svi + di));
                        const vj2 = Math.max(vjLo, Math.min(vjHi, svj + dj));
                        canyonKeys.add(vi2 * 100003 + vj2);
                    }
            }
            // CORE CHAMBER SITES: one per team, horizontally aligned with the
            
            
            
            
            
            
            
            for (const side of [0, 1]) {
                const vi = side === 0 ? viLo + 3 : viHi - 3;
                chamberCells.push({
                    key: vi * 100003 + cvj,
                    team: side === 0 ? TEAM_BLUE : TEAM_RED,
                    name: side === 0 ? "Blue Core Chamber" : "Red Core Chamber",
                });
            }
            // NOTE: chamber cells are NOT pre-carved here - each ring's pocket is
            // cut right before the canyon pass below, carving only the rocks that
            // would actually touch the ring (see CORE CHAMBER POCKETS).
        }
        this._canyonKeys = canyonKeys;
        // buffer zone: canyon cells plus everything within 2 lattice cells -
        
        const canyonNear = new Set();
        for (const k of canyonKeys) {
            const vi = Math.floor(k / 100003), vj = k % 100003;
            for (let di = -2; di <= 2; di++)
                for (let dj = -2; dj <= 2; dj++)
                    canyonNear.add((vi + di) * 100003 + (vj + dj));
        }
        this._canyonNearKeys = canyonNear;

        // EMERALDS - exactly EMERALD_COUNT cells per arena, hand-placed in
        
        
        
        
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
                    growStart: 0,
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

                // Cell geometry, cached in both spaces: tile coords for the
                
                
                
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

        // CORE CHAMBER POCKETS: the ring's vertices reach CHAMBER_RADIUS (160)
        // and the walls are thin, so instead of the old pre-carved 5x5 square we
        // carve exactly the rocks whose polygons would touch each ring plus a
        // small margin. The pocket hugs the 15-gon, leaving a tight, even gap of
        // fresh floor instead of a big empty slab - and the ring never spawns
        // stuck inside a boulder.
        {
            const pocketR = 160 + 26;
            const centers = [];
            for (const s of chamberCells) {
                const rock = this.rocks.get(s.key);
                if (!rock) continue;
                // the site rock's polygon centroid is the tightest anchor; the
                // lattice center (wx/wy) is always present as a fallback
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

    
    growthProgress(rock, now) {
        if (!rock.growing) return 1;
        return Math.max(0, Math.min(1, (now - rock.growStart) / REGROW.GROW_MS));
    }

    // How much of the cell the risen stone covers right now (START_SCALE→1).
    
    
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
    // Uniform scaling about the centroid means a query point can simply be
    // divided back into full-size space - no per-tick polygon rebuilds.
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

    // Distance from the centroid to the outline along a direction. Voronoi
    // cells are convex and the centroid is inside, so the ray exits exactly
    // once - this is the rock's "radius" in that direction.
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
        const sp = this._scaledPolyFor(rock, now);
        if (!sp || sp.length < 3) return 0;
        const dx = x - rock.worldCx, dy = y - rock.worldCy;
        const reach = rock.maxPolyRadius + r;
        if (dx * dx + dy * dy > reach * reach) return 0;
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

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    pushCircleFromGrowing(pos, r, now = Date.now()) {
        if (!this._growing.length) return { dx: 0, dy: 0, entombed: false, buried: false };
        const startX = pos.x, startY = pos.y;

        let touched = false, buried = false;
        
        
        
        
        let carry = Math.max(2, r * 0.15);
        for (let pass = 0; pass < 3; pass++) {
            
            
            
            
            
            
            let sx = 0, sy = 0, contact = false;
            for (const rock of this._growing) {
                const sp = this._scaledPolyFor(rock, now);
                if (!sp || sp.length < 3) continue;
                const ddx = pos.x - rock.worldCx, ddy = pos.y - rock.worldCy;
                const reach = rock.maxPolyRadius + r;
                if (ddx * ddx + ddy * ddy > reach * reach) continue;
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
            
            
            
            this.pushCircleFromVoronoi(pos, r);
            
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

    
    startRegrow(rock, now) {
        if (rock.canyon) return;
        if (!rock.worldPoly || rock.alive || rock.growing) return;
        rock.gen++;
        rock.growing    = true;
        rock.growStart  = now;
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
        rock.maxHealth  = ROCK_HEALTH * ORE_HP[rock.ore] * ((global.royaleMods && global.royaleMods.rockHpMult) || 1);
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
        this.rockEvents.push({
            k: rock.k, r: 1, o: rock.ore, gen: rock.gen,
            ax: Math.round((rock.growAx + halfW) / this.cellSize * 100) / 100,
            ay: Math.round((rock.growAy + halfH) / this.cellSize * 100) / 100,
        });
    }

    _unlistGrowing(rock) {
        const i = this._growing.indexOf(rock);
        if (i !== -1) this._growing.splice(i, 1);
    }

    
    completeRegrow(rock) {
        rock.growing    = false;
        rock.alive      = true;
        // Keep the damage it took while rising. Resetting to full here meant
        // a rock you were shooting as it finished growing jumped back to 100%
        // and looked like an ordinary rock that refused to break.
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
        this._noRegrowZones.push({ x, y, r2: r * r, until });
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
        if (now - this._lastRegrowTick < REGROW.PACING_MS) return;
        this._lastRegrowTick = now;

        
        for (let i = this._growing.length - 1; i >= 0; i--) {
            const rock = this._growing[i];
            if (now - rock.growStart >= REGROW.GROW_MS) { this.completeRegrow(rock); continue; }
            
            
            
            const target = rock.maxHealth *
                Math.max(REGROW.HP_FLOOR, easeGrowth(this.growthProgress(rock, now)));
            rock.health = Math.max(1, target - rock.growDamage);
        }

        
        
        
        
        let gap0 = 0, gap1 = 0;
        for (const rock of this.rocks.values()) {
            if (rock.alive) {
                if (rock.health < rock.maxHealth &&
                    now - (rock.lastHitAt || 0) >= REGROW.HEAL_IDLE_MS) {
                    rock.health = Math.min(rock.maxHealth,
                        rock.health + rock.maxHealth * REGROW.HEAL_RATE * (REGROW.PACING_MS / 1000));
                    // broadcast sparingly: only when the healed fraction has
                    
                    
                    const h = rock.health / rock.maxHealth;
                    const bucket = h >= 1 ? 999 : (h * 24) | 0;
                    if (bucket !== rock._healBucket) {
                        rock._healBucket = bucket;
                        // hl flag: clients update quietly (no hit flash)
                        this.rockEvents.push({ k: rock.k, h, hl: 1 });
                    }
                }
                continue;
            }
            if (rock.growing || !rock.diedAt) continue;
            const side = this._sideOf(rock);
            if (side === 0) gap0++; else if (side === 1) gap1++;
        }
        const delayFor = (mine, theirs) => Math.max(REGROW.MIN_DELAY_MS,
            Math.min(REGROW.BASE_DELAY_MS,
                REGROW.BASE_DELAY_MS - REGROW.DEFICIT_MS_PER_GAP * Math.max(0, mine - theirs)));
        this._regrowDelay[0] = delayFor(gap0, gap1);
        this._regrowDelay[1] = delayFor(gap1, gap0);

        
        
        for (const rock of this.rocks.values()) {
            if (rock.alive || rock.growing || !rock.diedAt || !rock.worldPoly) continue;
            const side = this._sideOf(rock);
            const delay = side === -1
                ? Math.min(this._regrowDelay[0], this._regrowDelay[1])
                : this._regrowDelay[side];
            // inside a live ore bloom the wall heals in seconds, so the
            // patch keeps paying until the bloom ends
            let bloomRock = false;
            if (Config.dig_royale) {
                const bl = this._bloomNow || null;
                if (bl && ((rock.wx - bl.x) ** 2 + (rock.wy - bl.y) ** 2) <= bl.r * bl.r) bloomRock = true;
            }
            if (now - rock.diedAt < (bloomRock ? 2500 : delay)) continue;
            if (rock.noRegrowUntil && now < rock.noRegrowUntil) continue;
            if (this._inNoRegrowZone(rock, now)) continue;
            if (!bloomRock && !this._hasLivingNeighbour(rock)) continue;
            this.startRegrow(rock, now);
            if (bloomRock) rock.growStart = now - REGROW.GROW_MS * 0.45;   // rises in about 4 seconds
        }

        
        // the replant scans every rock twice; twice a second is more than enough
        if (this._pendingEmeralds.length && now - (this._emeraldTickAt || 0) > 2000) {
            this._emeraldTickAt = now;
            this._tickEmeraldRespawns(now);
        }
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
        for (let i = this._pendingEmeralds.length - 1; i >= 0; i--) {
            if (this._pendingEmeralds[i].at > now) continue;
            if (this._plantEmerald()) this._pendingEmeralds.splice(i, 1);
            
        }
    }

    
    
    _plantEmerald() {
        const viLo = this._voroViLo, viHi = this._voroViHi;
        const halfSpan = Math.max(1, (viHi - viLo) / 2);
        const current = [];
        for (const rock of this.rocks.values()) {
            if (rock.ore === ORE.EMERALD && (rock.alive || rock.growing)) current.push(rock);
        }
        const salt = this.oreSalt + 13 + (++this._emeraldRespawns) * 104729;
        let best = null, bestScore = Infinity;
        for (const rock of this.rocks.values()) {
            if (!rock.alive || rock.growing || rock.ore !== ORE.NONE) continue;
            if (this._canyonNearKeys && this._canyonNearKeys.has(rock.k)) continue;
            const depth = Math.min(rock.vi - viLo, viHi - rock.vi) / halfSpan;
            if (depth < 0.7) continue;
            let ok = true;
            for (const c of current) {
                const di = rock.vi - c.vi, dj = rock.vj - c.vj;
                if (di * di + dj * dj < 36) { ok = false; break; } 
            }
            if (!ok) continue;
            const score = this._oreRoll(rock.vi, rock.vj, salt);
            if (score < bestScore) { bestScore = score; best = rock; }
        }
        if (!best) { this._emeraldRespawns--; return false; }
        const oldMax = best.maxHealth || 1;
        const frac = Math.min(1, best.health / oldMax);
        best.ore       = ORE.EMERALD;
        best.maxHealth = ROCK_HEALTH * ORE_HP[ORE.EMERALD];
        best.health    = frac * best.maxHealth;
        best.deposits  = this._buildDeposits(best);
        this.rockEvents.push({ k: best.k, e: 1 });
        return true;
    }

    // ─── Point / circle vs rock queries ───────────────────────────────────────
    // A point is inside a rock iff its nearest Voronoi seed (same float32 hash
    
    
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

    // Apply damage; queues a network delta. Rocks never heal, die once.
    
    
    damageRock(rock, dmg, wx, wy, grind, owner) {
        if (!rock || (!rock.alive && !rock.growing) || !(dmg > 0)) return false;
        
        
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
            
            
            if (!wasGrowing && rock.ore === ORE.EMERALD)
                this._pendingEmeralds.push({ at: rock.diedAt + ((global.royaleMods && global.royaleMods.emeraldRespawnMs) || REGROW.EMERALD_RESPAWN_MS) });
        }
        const ev = { k: rock.k, h: rock.health / rock.maxHealth, d: destroyed ? 1 : 0 };
        // grind flag: hull scraping - clients draw soft grind sparks
        
        if (grind && !destroyed) ev.g = 1;
        
        
        
        if (destroyed && rock.ore && !wasGrowing) ev.o = rock.ore;
        
        
        if (destroyed && wasGrowing) ev.p = 1;
        if (wx !== undefined) {
            const halfW = this.cols * this.cellSize / 2;
            const halfH = this.rows * this.cellSize / 2;
            ev.x = Math.round((wx + halfW) / this.cellSize * 100) / 100;
            ev.y = Math.round((wy + halfH) / this.cellSize * 100) / 100;
        }
        // Chip numbers (0-100 of this cell) go only to the shooter. Grind
        // scrapes skip them - they would spam.
        if (!grind && owner && rock.maxHealth > 0) {
            ev.n = Math.max(1, Math.round(100 * dmg / rock.maxHealth));
            ev.u = owner.id;
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
                           r: Math.max(0, now - rock.growStart),
                           o: rock.ore, gen: rock.gen,
                           ax: Math.round((rock.growAx + halfW) / this.cellSize * 100) / 100,
                           ay: Math.round((rock.growAy + halfH) / this.cellSize * 100) / 100 });
            } else if (!rock.alive) {
                out.push({ k: rock.k, h: 0, d: 1 });
            } else if (rock.health < rock.maxHealth || rock.gen > 0) {
                // gen rides along even at full health: the client needs it to
                
                out.push({ k: rock.k, h: rock.health / rock.maxHealth, d: 0, gen: rock.gen });
            }
        }
        return out;
    }

    // Living ore cells as [key, tier] pairs - rides the TG snapshot so every
    
    oreSnapshot() {
        const out = [];
        for (const rock of this.rocks.values()) {
            if (rock.alive && rock.ore) out.push([rock.k, rock.ore]);
        }
        return out;
    }

    
    
    
    pushCircleFromVoronoi(pos, r) {
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
        }
        return { dx: pos.x-startX, dy: pos.y-startY };
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

module.exports = { TerrainGrid, CELL, ORE, ORE_HP, REGROW, easeGrowth };
