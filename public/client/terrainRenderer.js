// NOTE: rock lattice size is Math.min(cols, 120) / 50 EVERYWHERE (here, the
// GLSL uniform below, and server terrainGrid.js). The clamp keeps rocks the
// same world size on maps wider than the live 15-tile one (the tutorial's
// multi-plot room); an unclamped copy magnifies every rock. Keep all mirrors
// identical.
import { config } from "./config.js";
import { global } from "./global.js";
import { gameSound } from "./sound.js";

const CELL_BASALT = 0;
const CELL_EMPTY  = 1;

const GROW_MS      = 8000;   
const GROW_SCALE0  = 0.15;   
const GROW_ORE_MS  = 1200;   
const GROW_GEN_STRIDE = 7919;
const growEase = (p) => p * p * (3 - 2 * p);

const FW_COLORS = ['164,14,14', '230,80,0', '230,119,0', '47,127,51', '23,78,166', '123,31,163'];
const BASE_TILE_SUBCELLS = 8;

const GEM_CUT = [
    [-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95],
];

class TerrainRenderer {
    
    static ORE_FX = {
        1: ['201,111,46', '237,167,102', '160,80,30'],
        2: ['59,124,224', '127,177,242', '35,90,180'],
        3: ['177,62,207', '217,138,240', '130,40,160'],
        4: ['31,191,107', '111,245,168', '18,128,72'],
    };
    
    
    static ORE_PAL = {
        1: { dark: 'rgba(90,44,14,0.9)',  mid: 'rgba(201,111,46,0.95)',
             light: 'rgba(237,167,102,0.95)', core: 'rgba(255,233,209,0.9)' },
        2: { dark: 'rgba(14,44,90,0.9)',  mid: 'rgba(59,124,224,0.95)',
             light: 'rgba(127,177,242,0.95)', core: 'rgba(226,240,255,0.9)' },
        3: { dark: 'rgba(61,14,74,0.9)',  mid: 'rgba(177,62,207,0.95)',
             light: 'rgba(217,138,240,0.95)', core: 'rgba(251,230,255,0.9)' },
        4: { dark: 'rgba(8,66,38,0.92)',  mid: 'rgba(31,191,107,0.95)',
             light: 'rgba(111,245,168,0.95)', core: 'rgba(232,255,242,0.95)' },
    };
    
    
    
    static CRACK_PAL = {
        0: { deep: '150,35,0',   hot: '255,110,20', hair: '255,225,140' },
        1: { deep: '140,62,15',  hot: '235,140,60', hair: '255,218,175' },
        2: { deep: '20,70,160',  hot: '80,150,255', hair: '190,222,255' },
        3: { deep: '110,25,140', hot: '200,95,240', hair: '242,205,255' },
        4: { deep: '12,110,60',  hot: '60,225,135', hair: '205,255,228' },
    };

    constructor() {
        this.ready       = false;
        this._cols       = 0;
        this._rows       = 0;
        this._cells      = null;
        this._loops      = null;
        this._loopOuter  = null;
        this._facets     = null;
        this._minerals   = null;
        this._crackPath  = null;
        this._noiseTile        = null;
        this._noiseTileBuilding = false;
        this._gl               = null;
        this._glCanvas         = null;
        this._glOriginU        = null;
        this._glCellSzU        = null;
        this._glShU            = null;
        this._glRockSzU        = null;
        this._bbox             = null;
        this._silFull         = null;
        this._silOuter        = null;
        this._silClip         = null;
        this._loopsSimplified = null;
        this._lineRocks       = null;
        this.useVoronoi  = true;
        
        this.debugCollision      = false;
        this._debugVoronoiSegs   = null;
        
        this._rockHealth = new Map();   
        this._rockDead   = new Set();   
        this._cellPolys  = new Map();   
        this._crackCache = new Map();   
        this._fx         = [];          
        this._impacts    = [];          
        this._hitFlash   = new Map();   
        this._crackSnap  = new Map();   
        this._fracCache  = new Map();   
        this._bites      = new Map();   
        this._biteCache  = new Map();   
        this._pockCache  = new Map();   
        this._damageDirty = true;       
        this._damageBatch = null;       
        this._pebbles    = [];          
        this._lastTrickle = new Map();  
        this._view       = null;        
        
        this._ore        = new Map();   
        this._veinCache  = new Map();   
        this._oreSalt    = 0;           
        
        this._growing    = new Map();   
        this._landed     = new Set();   
                                        
        this._gen        = new Map();   
        this._oreSprout  = new Map();   
        this._sproutArt  = new Map();   
        this._growFx     = [];          
        this._growDust   = new Map();
        this._silRebuildAt = 0;
        // Lattice polygons, keyed by rock key. Depends only on the map, so it
        // survives every silhouette rebuild - see _buildVoronoiBoundary.
        this._voroLattice = null;
    }

    _h(x, y, s) {
        let h = (Math.imul(x+1, 374761393) ^ Math.imul(y+1, 1284865837) ^ Math.imul((s|0)+1, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1540483477);
        h ^= h >>> 15;
        return (h >>> 0) / 0x100000000;
    }

    _sn(x, y, s) {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = x - xi, yf = y - yi;
        const ux = xf * xf * (3 - 2 * xf);
        const uy = yf * yf * (3 - 2 * yf);
        const a  = this._h(xi,   yi,   s);
        const b  = this._h(xi+1, yi,   s);
        const c  = this._h(xi,   yi+1, s);
        const dd = this._h(xi+1, yi+1, s);
        return a*(1-ux)*(1-uy) + b*ux*(1-uy) + c*(1-ux)*uy + dd*ux*uy;
    }

    _fbm(x, y, octaves, seed) {
        let v = 0, amp = 0.5, freq = 1;
        for (let i = 0; i < octaves; i++) {
            v    += (this._sn(x * freq, y * freq, seed + i) - 0.5) * amp;
            amp  *= 0.5;
            freq *= 2.17;
        }
        return v + 0.5;
    }

    _solid(c, r) {
        if (c < 0 || c >= this._cols || r < 0 || r >= this._rows) return false;
        return this._cells[r * this._cols + c] === CELL_BASALT;
    }

    init(cells, cols, rows, rockState, oreState, oreSalt) {
        this._cols  = cols;
        this._rows  = rows;
        this._cells = new Uint8Array(cells);
        this._lineRocks = null;
        this._voroLattice = null;       // new map: rebuild the polygons once
        this._debugVoronoiSegs = null;
        // Reset rock state, then apply the server snapshot (late join / rejoin)
        this._rockHealth.clear();
        this._rockDead.clear();
        this._crackCache.clear();
        this._fx.length = 0;
        this._impacts.length = 0;
        this._hitFlash.clear();
        this._crackSnap.clear();
        this._fracCache.clear();
        this._bites.clear();
        this._biteCache.clear();
        this._pockCache.clear();
        this._pebbles.length = 0;
        this._lastTrickle.clear();
        this._damageDirty = true;
        this._damageBatch = null;
        this._growing.clear();
        this._landed.clear();
        this._gen.clear();
        this._oreSprout.clear();
        this._sproutArt.clear();
        this._growDust.clear();
        this._growFx.length = 0;
        this._silRebuildAt = 0;
        const nowInit = performance.now();
        if (rockState) for (const ev of rockState) {
            this._rockHealth.set(ev.k, ev.h);
            if (ev.d) this._rockDead.add(ev.k);
            if (ev.gen) this._gen.set(ev.k, ev.gen);
            // mid-rise when we joined: pick the animation up where the rest
            
            if (ev.r !== undefined) {
                if (ev.r < GROW_MS) {
                    
                    
                    
                    this._growing.set(ev.k, { start: nowInit - ev.r, tier: ev.o | 0,
                                              gen: ev.gen | 0, ax: ev.ax, ay: ev.ay,
                                              mapped: false });
                } else {
                    this._rockDead.delete(ev.k);   
                }
            }
        }
        this.mapDirty = true; 
        
        
        
        this._ore.clear();
        this._veinCache.clear();
        this._oreSalt = oreSalt | 0;
        if (oreState) for (const [k, tier] of oreState) {
            if (!this._rockDead.has(k)) this._ore.set(k, tier);
        }
        
        
        for (const [k, g] of this._growing) {
            if (g.tier) this._ore.set(k, g.tier);
        }
        if (!this._noiseTile && !this._noiseTileBuilding) this._buildNoiseTile();
        this._buildContours();
        this._buildFacets();
        this.ready = true;
    }

    
    _stageOf(frac) {
        return frac > 5/6 ? 0 : frac > 4/6 ? 1 : frac > 3/6 ? 2 :
               frac > 2/6 ? 3 : frac > 1/6 ? 4 : 5;
    }

    _onScreen(x, y, pad = 2) {
        const v = this._view;
        return !!v && x > v.tlx - pad && x < v.tlx + v.tlw + pad &&
                      y > v.tly - pad && y < v.tly + v.tlh + pad;
    }

    
    
    _trembleOf(k, nowMs) {
        const rockSz = Math.min(this._cols, 120) / 50.0;
        return [Math.sin(nowMs / 17 + (k % 13)) * 0.02 * rockSz,
                Math.cos(nowMs / 23 + (k % 7))  * 0.02 * rockSz];
    }

    _shake(amount, duration, delay = 0) {
        const sh = config.graphical.shakeProperties.CameraShake;
        // don't let a small hit-shake cut short a bigger one in progress
        if (sh.shakeStartTime !== -1 && sh.shakeAmount > amount &&
            Date.now() - sh.shakeStartTime < sh.shakeDuration) return;
        sh.shakeStartTime = Date.now() + delay;
        sh.shakeDuration  = duration;
        sh.shakeAmount    = amount;
    }

    applyRockEvents(events) {
        if (!this.ready || !events) return;
        const now = performance.now();
        let rebuilt = false;
        if (events.length) this._damageDirty = true;
        for (const ev of events) {
            // ── THE LIVING WALL ──
            // A rising cell stays in _rockDead the whole time it grows: every
            // system that treats a hole as a hole (silhouette, damage batch,
            // ore markings, both maps) keeps doing exactly that, and the
            // growth is drawn as its own layer on top. It only rejoins the
            // rock when it lands.
            if (ev.r === 1) {
                // regrow implies the server considers this cell DEAD; if the
                // client somehow still thinks it's whole (missed destroy),
                
                
                if (!this._rockDead.has(ev.k)) {
                    this._rockDead.add(ev.k);
                    this.mapDirty = true;
                    rebuilt = true;
                }
                this._beginGrowth(ev.k, ev.o | 0, ev.gen | 0, now, ev.ax, ev.ay);
                continue;
            }
            if (ev.r === 2) { this._finishGrowth(ev.k, now); continue; }
            if (ev.e === 1) { this._revealOre(ev.k, 4, now); continue; }
            if (ev.d && this._growing.has(ev.k)) {
                this._collapseGrowth(ev.k, now);
                rebuilt = true;   
                continue;
            }
            const prev = this._rockHealth.get(ev.k);
            const oldStage = prev === undefined ? 0 : this._stageOf(prev);
            this._rockHealth.set(ev.k, ev.h);
            
            
            if (ev.hl) continue;
            this._emitRockNumber(ev);
            if (ev.d && !this._rockDead.has(ev.k)) {
                const cell = this._cellPolys.get(ev.k);
                this._rockDead.add(ev.k);
                this.mapDirty = true; 
                
                
                const tier = ev.o ?? this._ore.get(ev.k) ?? 0;
                this._ore.delete(ev.k);
                if (cell) {
                    
                    
                    const onscreen = this._onScreen(cell.cx, cell.cy);
                    const delay = onscreen ? 55 : 0;
                    this._spawnShatter(cell, now + delay, tier);
                    if (onscreen) {
                        global.hitStop = Date.now() + delay;
                        this._shake(tier ? 5 : 4, 240, delay);
                    }
                    if (this._world) {
                        const w = this._world;
                        const wx = cell.cx * w.s - w.hw, wy = cell.cy * w.s - w.hh;
                        if (tier && config.game.gemSounds) gameSound.oreBreak(wx, wy, tier);
                        else      gameSound.rockBreak(wx, wy);
                    }
                }
                rebuilt = true;
            } else if (!ev.d) {
                
                
                this._hitFlash.set(ev.k, now);
                const stagedUp = this._stageOf(ev.h) > oldStage;
                if (stagedUp) {
                    this._crackSnap.set(ev.k, now);
                    
                    
                    const cell = this._cellPolys.get(ev.k);
                    if (cell && this._onScreen(cell.cx, cell.cy))
                        this._shake(2, 140);
                }
                if (ev.x !== undefined) {
                    
                    
                    if (this._world) {
                        const w = this._world;
                        gameSound.rockHit(ev.x * w.s - w.hw, ev.y * w.s - w.hh,
                                          this._stageOf(ev.h), !!ev.g);
                    }
                    
                    
                    
                    
                    const cell = this._cellPolys.get(ev.k);
                    let dx = 1, dy = 0;
                    if (cell) {
                        dx = ev.x - cell.cx; dy = ev.y - cell.cy;
                        const dl = Math.hypot(dx, dy) || 1;
                        dx /= dl; dy /= dl;
                    }
                    this._impacts.push({ x: ev.x, y: ev.y, dx, dy, born: now,
                                         small: !!ev.g,
                                         seed: (ev.k + Math.round(ev.x * 97) + (ev.g ? (now | 0) : 0)) & 0xffff });
                    if (this._impacts.length > 16) this._impacts.shift();
                    
                    
                }
            }
        }
        if (rebuilt) {
            this._silClip = this._buildVoronoiBoundary();
            this._debugVoronoiSegs = null;
            this._landed.clear();   
            this._silRebuildAt = 0;
        }
    }

    _emitRockNumber(ev) {
        if (!ev.n || ev.g || ev.x === undefined || !this._world) return;
        if (!this._onScreen(ev.x, ev.y)) return;
        const w = this._world;
        const ore = (ev.o ?? this._ore.get(ev.k) ?? 0) | 0;
        if (typeof global.pushRockDamage === "function")
            global.pushRockDamage(ev.x * w.s - w.hw, ev.y * w.s - w.hh, ev.n | 0, ev.u, ore);
    }

    // Same 4-tick mark rocks use, in the same cell space so outposts and
    // chambers match size and fade exactly.
    addHitMarker(wx, wy) {
        if (!this.ready || !this._world) return;
        const w = this._world;
        const x = (wx + w.hw) / w.s;
        const y = (wy + w.hh) / w.s;
        const now = performance.now();
        this._impacts.push({
            x, y, dx: 1, dy: 0, born: now,
            small: false,
            ticksOnly: true,
            seed: (Math.round(x * 97 + y * 13) + (now | 0)) & 0xffff,
        });
        if (this._impacts.length > 16) this._impacts.shift();
    }

    _beginGrowth(k, tier, gen, now, ax, ay) {
        
        
        
        const cell = this._cellPolys.get(k);
        if (!(Number.isFinite(ax) && Number.isFinite(ay))) {
            ax = cell ? cell.cx : 0; ay = cell ? cell.cy : 0;
        }
        this._growing.set(k, { start: now, tier, gen, ax, ay, mapped: false });
        this._landed.delete(k);
        this._gen.set(k, gen);
        this._rockHealth.set(k, 0.25);   
        for (let st = 0; st <= 5; st++) {   
            this._crackCache.delete(`${k}:${st}`);
            this._pockCache.delete(`${k}:${st}`);
        }
        this._fracCache.delete(k);
        this._bites.delete(k);
        this._biteCache.delete(k);
        this._hitFlash.delete(k);
        this._crackSnap.delete(k);
        this._lastTrickle.delete(k);
        this._veinCache.delete(k);
        this._sproutArt.delete(k);
        this._oreSprout.delete(k);
        if (tier) this._ore.set(k, tier); else this._ore.delete(k);
        this._damageDirty = true;
        
        
        if (cell && this._onScreen(cell.cx, cell.cy) && this._pebbles.length < 70) {
            const kk = k & 0xffff;
            for (let i = 0; i < 7; i++) {
                const a = this._h(i, kk, 170) * Math.PI * 2;
                const rr = (0.2 + this._h(i, kk, 171) * 0.4) * (Math.min(this._cols, 120) / 50.0);
                this._pebbles.push({
                    x: ax + Math.cos(a) * rr,
                    y: ay + Math.sin(a) * rr,
                    // inward: the ground is being drawn INTO the rising rock
                    dx: -Math.cos(a) * 0.5, dy: -Math.sin(a) * 0.5,
                    born: now, seed: (kk + i * 53) & 0xffff,
                });
            }
        }
    }

    
    
    _finishGrowth(k, now) {
        const g = this._growing.get(k);
        this._growing.delete(k);
        this._growDust.delete(k);
        this._rockDead.delete(k);
        this._rockHealth.set(k, 1);
        this._damageDirty = true;
        this.mapDirty = true;               
        
        
        
        this._landed.add(k);
        
        this._silRebuildAt = this._silRebuildAt
            ? Math.min(this._silRebuildAt, now + 120) : now + 120;
        
        
        const tier = g ? g.tier : (this._ore.get(k) || 0);
        if (tier) {
            this._ore.set(k, tier);
            this._oreSprout.set(k, now);
        }
        const cell = this._cellPolys.get(k);
        if (cell && this._onScreen(cell.cx, cell.cy)) {
            
            this._growFx.push({ k, born: now });
            if (this._growFx.length > 24) this._growFx.shift();
            this._shake(3, 160);
            
            const kk = k & 0xffff;
            for (let i = 0; i < 12 && this._pebbles.length < 80; i++) {
                const a = (i / 12) * Math.PI * 2 + this._h(i, kk, 172);
                this._pebbles.push({
                    x: cell.cx + Math.cos(a) * 0.4, y: cell.cy + Math.sin(a) * 0.4,
                    dx: Math.cos(a), dy: Math.sin(a),
                    born: now, seed: (kk + i * 91) & 0xffff,
                });
            }
        }
    }

    // Shot down before it finished: a husk crumbling, not a rock shattering.
    
    _collapseGrowth(k, now) {
        const g = this._growing.get(k);
        this._growing.delete(k);
        this._growDust.delete(k);
        this._oreSprout.delete(k);
        this._sproutArt.delete(k);
        this._ore.delete(k);
        this._veinCache.delete(k);
        this._rockHealth.set(k, 0);
        
        
        
        this._rockDead.add(k);
        this._landed.delete(k);
        this.mapDirty = true;
        this._damageDirty = true;
        const cell = this._cellPolys.get(k);
        if (!cell) return;
        
        
        
        const onscreen = this._onScreen(cell.cx, cell.cy);
        const delay = onscreen ? 55 : 0;
        this._spawnShatter(cell, now + delay, 0);
        if (onscreen) {
            global.hitStop = Date.now() + delay;
            this._shake(4, 220, delay);
        }
    }

    
    _revealOre(k, tier, now) {
        this._ore.set(k, tier);
        this._veinCache.delete(k);
        this._sproutArt.delete(k);
        this._oreSprout.set(k, now);   
    }

    
    
    
    _getSproutParts(k, tier) {
        let parts = this._sproutArt.get(k);
        if (parts !== undefined) return parts;
        const cell = this._cellPolys.get(k);
        if (!cell) { this._sproutArt.set(k, null); return null; }
        const kk = k & 0xffff;
        const rockSz = Math.min(this._cols, 120) / 50.0;
        const gsalt = (this._gen.get(k) || 0) * GROW_GEN_STRIDE;
        const h = (i, s) => this._h(i, kk, (s + this._oreSalt + gsalt) | 0);
        const deposits = this._depositLayout(tier, cell.poly, cell.cx, cell.cy, rockSz, h);
        if (!deposits.length) { this._sproutArt.set(k, null); return null; }
        const put = (path, r, rot, scale, ox, oy) => {
            const c = Math.cos(rot), s = Math.sin(rot);
            GEM_CUT.forEach((p, i) => {
                const px = p[0] * r * scale + ox, py = p[1] * r * scale + oy;
                const wx = px * c - py * s, wy = px * s + py * c;
                if (i === 0) path.moveTo(wx, wy); else path.lineTo(wx, wy);
            });
            path.closePath();
        };
        parts = deposits.map(d => {
            const body = new Path2D(), facet = new Path2D(), core = new Path2D();
            put(body,  d.r, d.rot, 1,    0,            0);
            put(facet, d.r, d.rot, 0.52, 0,            -d.r * 0.12);
            put(core,  d.r, d.rot, 0.20, -d.r * 0.22,  -d.r * 0.30);
            return { x: d.x, y: d.y, r: d.r, body, facet, core, big: d.big };
        });
        this._sproutArt.set(k, parts);
        return parts;
    }

    _spawnShatter(cell, now, tier = 0) {
        const { cx, cy } = cell;
        const kk = cell.k & 0xffff;
        const jc = (i, s) => this._h(i, kk, s);
        // ~50 black rock chips bursting outward - small rotated squares,
        
        const parts = [];
        for (let e = 0; e < 70; e++) {
            parts.push({
                ang:  jc(e, 28) * Math.PI * 2,
                sp:   0.7 + jc(e, 29) * 3.6,
                size: 0.018 + jc(e, 30) * 0.04,
                shade: Math.floor(jc(e, 31) * 3),
                spin: (jc(e, 32) - 0.5) * 14,
                sq:   0.5 + jc(e, 33) * 0.5,
                
                ox:   (jc(e, 34) - 0.5) * 1.1,
                oy:   (jc(e, 35) - 0.5) * 1.1,
            });
        }
        
        
        const palette = TerrainRenderer.ORE_FX[tier] || FW_COLORS;
        const nSparks = tier ? (tier === 4 ? 56 : tier === 3 ? 44 : 32) : 24;
        const sparks = [];
        for (let e = 0; e < nSparks; e++) {
            sparks.push({
                ang: jc(e, 36) * Math.PI * 2,
                sp:  1.2 + jc(e, 37) * 3.4,
                ci:  Math.floor(jc(e, 38) * palette.length),
            });
        }
        this._fx.push({ parts, sparks, colors: palette, cx, cy, path: cell.path,
                        born: now ?? performance.now() });
        if (this._fx.length > 40) this._fx.shift(); 
    }

    
    
    
    
    
    
    
    _vh2(i, j) {
        const f = Math.fround;
        let px = f(f(i) * f(5.3983));
        px = f(px - Math.floor(px));
        let py = f(f(j) * f(5.4427));
        py = f(py - Math.floor(py));
        const d = f(f(py * f(f(px) + f(21.5351))) + f(f(px) * f(f(py) + f(14.3137))));
        px = f(px + d); py = f(py + d);
        const pxy = f(px * py);
        let rx = f(pxy * f(95.4307)); rx = f(rx - Math.floor(rx));
        let ry = f(pxy * f(97.597));  ry = f(ry - Math.floor(ry));
        rx = f(f(0.5) + f(f(rx - f(0.5)) * f(0.55)));
        ry = f(f(0.5) + f(f(ry - f(0.5)) * f(0.55)));
        
        return [Math.round(rx * 255) / 255, Math.round(ry * 255) / 255];
    }

    _buildVoronoiDebugSegs() {
        if (this._debugVoronoiSegs) return this._debugVoronoiSegs;
        const cols = this._cols, rows = this._rows;
        const rockSz = Math.min(cols, 120) / 50.0;
        const h2  = (i, j) => this._vh2(i, j);
        const sol = (c, r) => this._solid(c, r);

        const clip = (poly, mx, my, ndx, ndy) => {
            const out = [], n = poly.length;
            for (let i = 0; i < n; i++) {
                const [ax, ay] = poly[i], [bx, by] = poly[(i+1)%n];
                const da = (ax-mx)*ndx + (ay-my)*ndy;
                const db = (bx-mx)*ndx + (by-my)*ndy;
                if (da <= 0) out.push([ax, ay]);
                if ((da < 0) !== (db < 0)) {
                    const t = da/(da-db);
                    out.push([ax+t*(bx-ax), ay+t*(by-ay)]);
                }
            }
            return out;
        };

        let maxLeft = 0, minRight = cols - 1, minLeft = cols, maxRight = 0;
        for (let r = 0; r < rows; r++) {
            let le = 0; while (le < cols && !sol(le, r)) le++;
            let re = cols - 1; while (re >= 0 && !sol(re, r)) re--;
            if (le < cols) { if (le > maxLeft) maxLeft = le; if (le < minLeft) minLeft = le; }
            if (re >= 0)   { if (re < minRight) minRight = re; if (re > maxRight) maxRight = re; }
        }
        const vxMin = maxLeft / rockSz;
        const vxMax = (minRight + 1) / rockSz;

        
        const viLo = Math.round(vxMin), viHi = Math.round(vxMax) - 1;
        const vjLo = 0,                 vjHi = Math.round(rows / rockSz) - 1;

        const segs = [];
        for (let vj = vjLo; vj <= vjHi; vj++) {
            for (let vi = viLo; vi <= viHi; vi++) {
                if (this._rockDead.has(vi * 100003 + vj)) continue;
                const [hx, hy] = h2(vi, vj);
                const sx = vi+hx, sy = vj+hy;

                let poly = [[sx-3,sy-3],[sx+3,sy-3],[sx+3,sy+3],[sx-3,sy+3]];
                for (let dj = -2; dj <= 2 && poly.length >= 3; dj++) {
                    for (let di = -2; di <= 2 && poly.length >= 3; di++) {
                        if (di === 0 && dj === 0) continue;
                        const [nhx, nhy] = h2(vi+di, vj+dj);
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

                for (let e = 0; e < poly.length; e++) {
                    const [vax, vay] = poly[e], [vbx, vby] = poly[(e+1)%poly.length];
                    segs.push([vax*rockSz, vay*rockSz, vbx*rockSz, vby*rockSz]);
                }
            }
        }
        this._debugVoronoiSegs = segs;
        return segs;
    }

    // Sub-Voronoi crack skeleton: a fine Voronoi diagram (~40 deterministic
    
    
    
    
    
    _getRockNet(k) {
        let net = this._fracCache.get(k);
        if (net !== undefined) return net;
        const cell = this._cellPolys.get(k);
        if (!cell) return null;
        const { poly } = cell;
        const kk = k & 0xffff;

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

        
        const seeds = [];
        for (let t = 0; t < 400 && seeds.length < 40; t++) {
            const x = minX + this._h(t, kk, 130) * (maxX - minX);
            const y = minY + this._h(t, kk, 131) * (maxY - minY);
            if (!inPoly(x, y)) continue;
            let ok = true;
            for (const s of seeds) {
                const dx = x - s[0], dy = y - s[1];
                if (dx * dx + dy * dy < 0.04) { ok = false; break; }
            }
            if (ok) seeds.push([x, y]);
        }
        if (seeds.length < 6) { this._fracCache.set(k, null); return null; }

        const clip = (pl, mx, my, ndx, ndy) => {
            const out = [], m = pl.length;
            for (let i = 0; i < m; i++) {
                const [ax, ay] = pl[i], [bx, by] = pl[(i + 1) % m];
                const da = (ax - mx) * ndx + (ay - my) * ndy;
                const db = (bx - mx) * ndx + (by - my) * ndy;
                if (da <= 0) out.push([ax, ay]);
                if ((da < 0) !== (db < 0)) {
                    const t = da / (da - db);
                    out.push([ax + t * (bx - ax), ay + t * (by - ay)]);
                }
            }
            return out;
        };

        // Build the deduped interior edge graph
        const vkey = (x, y) => Math.round(x * 200) + ':' + Math.round(y * 200);
        const adj = new Map();      
        const borderV = [];         
        const borderSeen = new Set();
        const edgeSeen = new Set();
        const addAdj = (ax, ay, bx, by) => {
            const kq = vkey(ax, ay);
            let a = adj.get(kq);
            if (!a) { a = []; adj.set(kq, a); }
            a.push([bx, by]);
        };
        for (let i = 0; i < seeds.length; i++) {
            let sub = poly.map(p => [p[0], p[1]]);
            for (let j = 0; j < seeds.length && sub.length >= 3; j++) {
                if (i === j) continue;
                sub = clip(sub, (seeds[i][0] + seeds[j][0]) / 2,
                                (seeds[i][1] + seeds[j][1]) / 2,
                                seeds[j][0] - seeds[i][0], seeds[j][1] - seeds[i][1]);
            }
            if (sub.length < 3) continue;
            for (let e = 0; e < sub.length; e++) {
                const A = sub[e], B = sub[(e + 1) % sub.length];
                const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
                
                if (distToBorder(mx, my) < 0.02) continue;
                const ek = Math.round(mx * 500) + ':' + Math.round(my * 500);
                if (edgeSeen.has(ek)) continue;
                edgeSeen.add(ek);
                addAdj(A[0], A[1], B[0], B[1]);
                addAdj(B[0], B[1], A[0], A[1]);
                for (const P of [A, B]) {
                    if (distToBorder(P[0], P[1]) < 0.03) {
                        const bk = vkey(P[0], P[1]);
                        if (!borderSeen.has(bk)) {
                            borderSeen.add(bk);
                            borderV.push([P[0], P[1]]);
                        }
                    }
                }
            }
        }
        net = borderV.length ? { adj, borderV, vkey } : null;
        this._fracCache.set(k, net);
        return net;
    }

    
    
    
    
    
    
    _getCrackPath(k, stage) {
        const ck = k + ':' + stage;
        let cached = this._crackCache.get(ck);
        if (cached !== undefined) return cached;
        const cell = this._cellPolys.get(k);
        const net = this._getRockNet(k);
        if (!cell || !net) { this._crackCache.set(ck, null); return null; }
        const { cx, cy } = cell;
        const kk = k & 0xffff;
        const off = this._h(0, kk, 99);
        const inset = 0.036 * (Math.min(this._cols, 120) / 50.0);  // half the border stroke
        const path = new Path2D();
        const used = new Set();
        const ekey = (a, b) => {
            const k1 = net.vkey(a[0], a[1]), k2 = net.vkey(b[0], b[1]);
            return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        };
        const angDiff = (a, b) => {
            let d = a - b;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            return d;
        };

        for (let c = 0; c < stage; c++) {
            let ri = 0;
            const rnd = () => this._h(ri++, kk, 210 + c * 13);
            
            const ta = (off + c / 5) * Math.PI * 2;
            const tx = Math.cos(ta), ty = Math.sin(ta);
            let best = -Infinity, sv = null;
            for (const v of net.borderV) {
                const dx = v[0] - cx, dy = v[1] - cy;
                const dl = Math.hypot(dx, dy) || 1;
                const d = (dx * tx + dy * ty) / dl;
                if (d > best) { best = d; sv = v; }
            }
            if (!sv) continue;
            
            const sdx = cx - sv[0], sdy = cy - sv[1];
            const sdl = Math.hypot(sdx, sdy) || 1;
            path.moveTo(sv[0] + sdx / sdl * inset, sv[1] + sdy / sdl * inset);
            
            let cur = sv;
            let prevAng = Math.atan2(cy - sv[1], cx - sv[0]);
            const len = 3 + Math.floor(rnd() * 3);
            for (let s = 0; s < len; s++) {
                const cands = net.adj.get(net.vkey(cur[0], cur[1]));
                if (!cands) break;
                let bestScore = -Infinity, nxt = null;
                for (const q of cands) {
                    if (used.has(ekey(cur, q))) continue;
                    const ang = Math.atan2(q[1] - cur[1], q[0] - cur[0]);
                    const score = -Math.abs(angDiff(ang, prevAng)) + rnd() * 0.6;
                    if (score > bestScore) { bestScore = score; nxt = q; }
                }
                if (!nxt) break;
                used.add(ekey(cur, nxt));
                path.lineTo(nxt[0], nxt[1]);
                
                if (s === 1 && rnd() > 0.4) {
                    const bc = net.adj.get(net.vkey(nxt[0], nxt[1]));
                    if (bc) for (const q2 of bc) {
                        const ek2 = ekey(nxt, q2);
                        if (used.has(ek2)) continue;
                        used.add(ek2);
                        path.lineTo(q2[0], q2[1]);
                        path.moveTo(nxt[0], nxt[1]);
                        break;
                    }
                }
                prevAng = Math.atan2(nxt[1] - cur[1], nxt[0] - cur[0]);
                cur = nxt;
            }
        }

        this._crackCache.set(ck, path);
        return path;
    }

    
    
    
    _getPockPath(k, stage) {
        const pk = k + ':' + stage;
        let p = this._pockCache.get(pk);
        if (p !== undefined) return p;
        const cell = this._cellPolys.get(k);
        if (!cell) { this._pockCache.set(pk, null); return null; }
        const { poly } = cell;
        const kk = k & 0xffff;
        const rockSz = Math.min(this._cols, 120) / 50.0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const q of poly) {
            if (q[0] < minX) minX = q[0];
            if (q[0] > maxX) maxX = q[0];
            if (q[1] < minY) minY = q[1];
            if (q[1] > maxY) maxY = q[1];
        }
        p = new Path2D();
        const count = (stage - 2) * 5;   // 5 / 10 / 15 speckles
        for (let i = 0; i < count; i++) {
            const x = minX + this._h(i, kk, 160) * (maxX - minX);
            const y = minY + this._h(i, kk, 161) * (maxY - minY);
            const r = (0.012 + this._h(i, kk, 162) * 0.028) * rockSz;
            p.moveTo(x + r, y);
            p.arc(x, y, r, 0, Math.PI * 2);
        }
        this._pockCache.set(pk, p);
        return p;
    }

    
    
    _getBitePath(k) {
        const bites = this._bites.get(k);
        if (!bites || !bites.length) return null;
        let p = this._biteCache.get(k);
        if (p) return p;
        p = new Path2D();
        const rockSz = Math.min(this._cols, 120) / 50.0;
        for (const b of bites) {
            const m = 3 + (b.seed & 1);
            const base = (0.05 + this._h(0, b.seed, 140) * 0.05) * rockSz;
            const rot = this._h(1, b.seed, 141) * Math.PI * 2;
            for (let i = 0; i < m; i++) {
                const ang = rot + i / m * Math.PI * 2;
                const rr = base * (0.6 + this._h(i + 2, b.seed, 142) * 0.8);
                const px = b.x + Math.cos(ang) * rr, py = b.y + Math.sin(ang) * rr;
                if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
            }
            p.closePath();
        }
        this._biteCache.set(k, p);
        return p;
    }

    
    
    
    
    
    
    
    _depositLayout(tier, poly, cx, cy, rockSz, h) {
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

    
    
    
    
    
    _getVeinArt(k, tier) {
        let art = this._veinCache.get(k);
        if (art !== undefined) return art;
        const cell = this._cellPolys.get(k);
        if (!cell) { this._veinCache.set(k, null); return null; }
        const { poly, cx, cy } = cell;
        const kk = k & 0xffff;
        const rockSz = Math.min(this._cols, 120) / 50.0;
        // Same salt-mixed closure the server builds in _buildDeposits. The
        
        
        
        
        const gsalt = (this._gen.get(k) || 0) * GROW_GEN_STRIDE;
        const h = (i, s) => this._h(i, kk, (s + this._oreSalt + gsalt) | 0);

        const deposits = this._depositLayout(tier, poly, cx, cy, rockSz, h);
        if (!deposits.length) { this._veinCache.set(k, null); return null; }

        const body = new Path2D(), facet = new Path2D(), core = new Path2D();
        const glintPts = [];
        let big = null;
        const put = (path, x, y, r, rot, scale, ox, oy) => {
            const c = Math.cos(rot), s = Math.sin(rot);
            GEM_CUT.forEach((p, i) => {
                const px = p[0] * r * scale + ox, py = p[1] * r * scale + oy;
                const wx = x + px * c - py * s;
                const wy = y + px * s + py * c;
                if (i === 0) path.moveTo(wx, wy); else path.lineTo(wx, wy);
            });
            path.closePath();
        };
        for (const d of deposits) {
            put(body,  d.x, d.y, d.r, d.rot, 1,    0,           0);
            put(facet, d.x, d.y, d.r, d.rot, 0.52, 0,           -d.r * 0.12);
            put(core,  d.x, d.y, d.r, d.rot, 0.20, -d.r * 0.22, -d.r * 0.30);
            
            const gc = Math.cos(d.rot), gs = Math.sin(d.rot);
            glintPts.push([d.x + (-0.35 * d.r) * gc - (-0.6 * d.r) * gs,
                           d.y + (-0.35 * d.r) * gs + (-0.6 * d.r) * gc]);
            if (d.big) big = [d.x, d.y];
        }

        art = { tier, body, facet, core, glintPts, big };
        this._veinCache.set(k, art);
        return art;
    }

    _buildVoronoiBoundary() {
        const cols = this._cols, rows = this._rows;
        const rockSz = Math.min(cols, 120) / 50.0;
        const h2 = (i, j) => this._vh2(i, j);
        const sol = (c, r) => this._solid(c, r);

        const clip = (poly, mx, my, ndx, ndy) => {
            const out = [], n = poly.length;
            for (let i = 0; i < n; i++) {
                const [ax, ay] = poly[i], [bx, by] = poly[(i+1)%n];
                const da = (ax-mx)*ndx + (ay-my)*ndy;
                const db = (bx-mx)*ndx + (by-my)*ndy;
                if (da <= 0) out.push([ax, ay]);
                if ((da < 0) !== (db < 0)) {
                    const t = da/(da-db);
                    out.push([ax+t*(bx-ax), ay+t*(by-ay)]);
                }
            }
            return out;
        };

        let maxLeft = 0, minRight = cols - 1, minLeft = cols, maxRight = 0;
        for (let r = 0; r < rows; r++) {
            let le = 0; while (le < cols && !sol(le, r)) le++;
            let re = cols - 1; while (re >= 0 && !sol(re, r)) re--;
            if (le < cols) { if (le > maxLeft) maxLeft = le; if (le < minLeft) minLeft = le; }
            if (re >= 0)   { if (re < minRight) minRight = re; if (re > maxRight) maxRight = re; }
        }
        const vxMin = maxLeft / rockSz;
        const vxMax = (minRight + 1) / rockSz;

        
        const viLo = Math.round(vxMin), viHi = Math.round(vxMax) - 1;
        const vjLo = 0,                 vjHi = Math.round(rows / rockSz) - 1;

        const incCache = new Map();
        const polyCache = new Map();

        // The lattice polygons depend only on (cols, rows, hash) - never on
        // which rocks are alive - so they are identical on every rebuild. This
        // function reruns on a 120ms throttle every time a rock dies, and
        // re-clipping ~10k cells against 24 neighbours each was the single most
        // expensive thing that happened while mining. Build them once per map
        // and keep them; a rebuild then only re-reads _rockDead.
        // init() clears the cache along with everything else.
        let lattice = this._voroLattice;
        if (!lattice) {
            lattice = this._voroLattice = new Map();
            for (let vj = vjLo; vj <= vjHi; vj++) {
                for (let vi = viLo; vi <= viHi; vi++) {
                    const key = vi * 100003 + vj;
                    const [hx, hy] = h2(vi, vj);
                    const sx = vi+hx, sy = vj+hy;

                    let poly = [[sx-3,sy-3],[sx+3,sy-3],[sx+3,sy+3],[sx-3,sy+3]];
                    for (let dj = -2; dj <= 2 && poly.length >= 3; dj++) {
                        for (let di = -2; di <= 2 && poly.length >= 3; di++) {
                            if (di === 0 && dj === 0) continue;
                            const [nhx, nhy] = h2(vi+di, vj+dj);
                            const tx = vi+di+nhx, ty = vj+dj+nhy;
                            poly = clip(poly, (sx+tx)/2, (sy+ty)/2, tx-sx, ty-sy);
                        }
                    }
                    if (poly.length < 3) continue;
                    let area2 = 0;
                    for (let ai = 0; ai < poly.length; ai++) {
                        const [ax, ay] = poly[ai], [bx, by] = poly[(ai+1)%poly.length];
                        area2 += ax*by - bx*ay;
                    }
                    if (Math.abs(area2) / 2 < 0.05) continue;

                    // Tile-coord polygon cached for cracks + shatter effects
                    let pcx = 0, pcy = 0;
                    for (const p of poly) { pcx += p[0]; pcy += p[1]; }
                    pcx = pcx / poly.length * rockSz; pcy = pcy / poly.length * rockSz;
                    const tilePoly = poly.map(p => [p[0] * rockSz, p[1] * rockSz]);
                    const tilePath = new Path2D();
                    tilePath.moveTo(tilePoly[0][0], tilePoly[0][1]);
                    for (let pi = 1; pi < tilePoly.length; pi++)
                        tilePath.lineTo(tilePoly[pi][0], tilePoly[pi][1]);
                    tilePath.closePath();
                    lattice.set(key, {
                        poly, sx, sy,
                        cell: { k: key, poly: tilePoly, cx: pcx, cy: pcy, path: tilePath },
                    });
                }
            }
        }

        for (const [key, L] of lattice) {
            this._cellPolys.set(key, L.cell);
            if (this._rockDead.has(key)) { incCache.set(key, false); continue; }
            incCache.set(key, true);
            polyCache.set(key, L);
        }

        const isInc = (vi, vj) => incCache.get(vi * 100003 + vj) || false;

        const boundaryEdges = [];

        for (let vj = vjLo; vj <= vjHi; vj++) {
            for (let vi = viLo; vi <= viHi; vi++) {
                const key = vi * 100003 + vj;
                if (!incCache.get(key)) continue;
                const { poly, sx, sy } = polyCache.get(key);

                for (let e = 0; e < poly.length; e++) {
                    const [vax, vay] = poly[e], [vbx, vby] = poly[(e+1)%poly.length];
                    const emx = (vax+vbx)/2, emy = (vay+vby)/2;
                    const edx = vbx-vax, edy = vby-vay;
                    const elen = Math.hypot(edx, edy);
                    if (elen < 1e-6) continue;

                    let nnx = -edy/elen, nny = edx/elen;
                    if ((sx-emx)*nnx + (sy-emy)*nny > 0) { nnx = -nnx; nny = -nny; }

                    const px = emx + nnx * 0.01, py = emy + nny * 0.01;

                    let minDist = Infinity, nVi = vi, nVj = vj;
                    for (let dj = -2; dj <= 2; dj++) {
                        for (let di = -2; di <= 2; di++) {
                            if (di === 0 && dj === 0) continue;
                            const [nhx, nhy] = h2(vi+di, vj+dj);
                            const nx = vi+di+nhx, ny = vj+dj+nhy;
                            const d = (px-nx)*(px-nx) + (py-ny)*(py-ny);
                            if (d < minDist) { minDist = d; nVi = vi+di; nVj = vj+dj; }
                        }
                    }

                    if (!isInc(nVi, nVj)) {
                        boundaryEdges.push([vax*rockSz, vay*rockSz, vbx*rockSz, vby*rockSz]);
                    }
                }
            }
        }

        const SNAP = 1000;
        const snapKey = (x, y) => Math.round(x*SNAP) + ',' + Math.round(y*SNAP);

        const adj = new Map();
        for (let i = 0; i < boundaryEdges.length; i++) {
            const [ax, ay, bx, by] = boundaryEdges[i];
            const ka = snapKey(ax, ay), kb = snapKey(bx, by);
            if (!adj.has(ka)) adj.set(ka, []);
            if (!adj.has(kb)) adj.set(kb, []);
            adj.get(ka).push({ idx: i, x: bx, y: by });
            adj.get(kb).push({ idx: i, x: ax, y: ay });
        }

        const used = new Uint8Array(boundaryEdges.length);
        const loops = [];

        for (let i = 0; i < boundaryEdges.length; i++) {
            if (used[i]) continue;
            used[i] = 1;
            const [ax, ay, bx, by] = boundaryEdges[i];
            const chain = [[ax, ay], [bx, by]];

            let curKey = snapKey(bx, by);
            while (true) {
                const cands = adj.get(curKey);
                if (!cands) break;
                let next = null;
                for (const c of cands) { if (!used[c.idx]) { next = c; break; } }
                if (!next) break;
                used[next.idx] = 1;
                if (snapKey(next.x, next.y) === snapKey(chain[0][0], chain[0][1])) break;
                chain.push([next.x, next.y]);
                curKey = snapKey(next.x, next.y);
            }

            curKey = snapKey(ax, ay);
            while (true) {
                const cands = adj.get(curKey);
                if (!cands) break;
                let next = null;
                for (const c of cands) { if (!used[c.idx]) { next = c; break; } }
                if (!next) break;
                used[next.idx] = 1;
                chain.unshift([next.x, next.y]);
                curKey = snapKey(next.x, next.y);
            }

            if (chain.length >= 3) loops.push(chain);
        }

        const path = new Path2D();
        for (const loop of loops) {
            if (loop.length < 3) continue;
            path.moveTo(loop[0][0], loop[0][1]);
            for (let i = 1; i < loop.length; i++)
                path.lineTo(loop[i][0], loop[i][1]);
            path.closePath();
        }
        return path;
    }

    _buildNoiseTile() {
        this._noiseTileBuilding = true;

        let canvas, gl;
        if (typeof OffscreenCanvas !== 'undefined') {
            try {
                canvas = new OffscreenCanvas(1, 1);
                gl = canvas.getContext('webgl');
            } catch(e) { gl = null; }
        }
        if (!gl) {
            canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false })
              || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
        }
        if (!gl) { this._noiseTileBuilding = false; return; }

        const VS = `attribute vec2 a_pos;
	                void main(){gl_Position=vec4(a_pos,0.,1.);}`;

        const FS = `precision highp float;
            uniform vec2  u_origin;
            uniform vec2  u_cellSz;
            uniform float u_sh;
            uniform float u_rockSz;
            uniform sampler2D u_seeds;

            // Seed jitter baked on the CPU (same code as collision/polygons)
            // and read back here - no GPU float math, no chance of desync.
            vec2 hash2(vec2 p){
                return texture2D(u_seeds,(p+vec2(8.5))/128.0).rg;
            }

            void main(){
                vec2 sc=vec2(gl_FragCoord.x, u_sh-gl_FragCoord.y);
                vec2 p=((sc-u_origin)/u_cellSz)/u_rockSz;
                vec2 n=floor(p), f=fract(p);

                float md=8.; vec2 mr=vec2(0.), mg=vec2(0.);
                for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
                    vec2 g=vec2(float(i),float(j));
                    vec2 r=g+hash2(n+g)-f;
                    float d=dot(r,r);
                    if(d<md){md=d;mr=r;mg=g;}
                }

                float bd=8.;
                for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
                    vec2 g=mg+vec2(float(i),float(j));
                    vec2 r=g+hash2(n+g)-f;
                    if(dot(mr-r,mr-r)>1e-4)
                        bd=min(bd,dot(.5*(mr+r),normalize(r-mr)));
                }

                float nl=length(mr);
                vec2 lh=hash2(n+mg);
                float la=(lh.x-.5)*.9;
                vec2 ldir=vec2(sin(la),-cos(la));
                float lit=nl>1e-3?dot(mr/nl,ldir):0.;
                float t=clamp(lit*.5+.5,0.,1.);
                vec3 shadowC=vec3(20.,18.,25.)/255.;
                vec3 mainC  =vec3(38.,34.,48.)/255.;
                vec3 tintC  =vec3(58.,52.,68.)/255.;
                vec3 cellC=t<0.33?shadowC:(t<0.67?mainC:tintC);
                vec3 borderC=vec3(5.,4.,7.)/255.;
                float isEdge=bd<0.036?1.:0.;
                gl_FragColor=vec4(mix(cellC,borderC,isEdge),1.);
            }`;

        const mkSh = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                console.error('Voronoi shader:', gl.getShaderInfoLog(s));
            return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, mkSh(gl.VERTEX_SHADER,   VS));
        gl.attachShader(prog, mkSh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        gl.useProgram(prog);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]),
            gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        
        
        
        const seedTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, seedTex);
        const sd = new Uint8Array(128 * 128 * 4);
        for (let j = 0; j < 128; j++) {
            for (let i = 0; i < 128; i++) {
                const [rx, ry] = this._vh2(i - 8, j - 8);
                const o = (j * 128 + i) * 4;
                sd[o]     = Math.round(rx * 255);
                sd[o + 1] = Math.round(ry * 255);
                sd[o + 3] = 255;
            }
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 128, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, sd);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_seeds'), 0);

        this._glCanvas  = canvas;
        this._gl        = gl;
        this._glOriginU = gl.getUniformLocation(prog, 'u_origin');
        this._glCellSzU = gl.getUniformLocation(prog, 'u_cellSz');
        this._glShU     = gl.getUniformLocation(prog, 'u_sh');
        this._glRockSzU = gl.getUniformLocation(prog, 'u_rockSz');

        this._noiseTile = true;
        this._noiseTileBuilding = false;
    }

    updateCell(col, row, newType) {
        if (!this.ready) return;
        if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) return;
        this._cells[row * this._cols + col] = newType;
        this._buildContours();
        this._buildFacets();
    }

    _buildContours() {
        const cols = this._cols, rows = this._rows;
        const edges = [];
        const startMap = new Map();
        const addE = (ax, ay, bx, by) => {
            const i = edges.length;
            edges.push([ax, ay, bx, by]);
            const k = ax + ',' + ay;
            let a = startMap.get(k);
            if (!a) { a = []; startMap.set(k, a); }
            a.push(i);
        };

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!this._solid(c, r)) continue;
                if (!this._solid(c,   r-1)) addE(c,   r,   c+1, r);
                if (!this._solid(c+1, r))   addE(c+1, r,   c+1, r+1);
                if (!this._solid(c,   r+1)) addE(c+1, r+1, c,   r+1);
                if (!this._solid(c-1, r))   addE(c,   r+1, c,   r);
            }
        }

        const used = new Array(edges.length).fill(false);
        const rawLoops = [];
        for (let i = 0; i < edges.length; i++) {
            if (used[i]) continue;
            const loop = [];
            let cur = i;
            while (cur !== -1 && !used[cur]) {
                used[cur] = true;
                const e = edges[cur];
                loop.push([e[0], e[1]]);
                const cand = startMap.get(e[2] + ',' + e[3]);
                let nx = -1;
                if (cand) for (const j of cand) { if (!used[j]) { nx = j; break; } }
                cur = nx;
            }
            if (loop.length >= 3) rawLoops.push(loop);
        }

        const simplified = rawLoops.map(loop => {
            const n = loop.length, out = [];
            for (let i = 0; i < n; i++) {
                const p = loop[(i - 1 + n) % n], q = loop[i], s = loop[(i + 1) % n];
                const d1x = q[0]-p[0], d1y = q[1]-p[1];
                const d2x = s[0]-q[0], d2y = s[1]-q[1];
                if (d1x * d2y - d1y * d2x !== 0 || d1x*d2x + d1y*d2y <= 0) out.push(q);
            }
            return out.length >= 3 ? out : loop;
        });

        const areaOf = (loop) => {
            let s = 0;
            for (let i = 0; i < loop.length; i++) {
                const a = loop[i], b = loop[(i + 1) % loop.length];
                s += a[0] * b[1] - b[0] * a[1];
            }
            return s / 2;
        };
        const areas = simplified.map(areaOf);
        let outerSign = 1, maxAbs = -1;
        for (const a of areas) { if (Math.abs(a) > maxAbs) { maxAbs = Math.abs(a); outerSign = Math.sign(a) || 1; } }

        this._loopsSimplified = simplified;
        this._loops     = simplified.map(loop => this._jag(loop));
        this._loopOuter = areas.map(a => (Math.sign(a) || 1) === outerSign);
    }

    _jag(loop) {
        const cols = this._cols, rows = this._rows, n = loop.length;
        const isBorder = (x, y) => x <= 0 || x >= cols;

        let pts = [];
        for (let i = 0; i < n; i++) {
            const A = loop[i], B = loop[(i + 1) % n];
            const dx = B[0] - A[0], dy = B[1] - A[1];
            const steps = Math.max(1, Math.round(Math.hypot(dx, dy)));
            for (let k = 0; k < steps; k++) {
                const t = k / steps;
                pts.push([A[0] + dx * t, A[1] + dy * t]);
            }
        }
        let m = pts.length;
        if (m < 4) return loop;
        const bflag = pts.map(p => isBorder(p[0], p[1]));

        for (let pass = 0; pass < 5; pass++) {
            const np = pts.slice();
            for (let i = 0; i < m; i++) {
                if (bflag[i]) continue;
                const a = pts[(i - 1 + m) % m], b = pts[i], c = pts[(i + 1) % m];
                np[i] = [a[0]*0.25 + b[0]*0.5 + c[0]*0.25,
                         a[1]*0.25 + b[1]*0.5 + c[1]*0.25];
            }
            pts = np;
        }

        const FACET = 4;
        const AMP   = 1.15;
        const Q     = 0.5;
        const out = [];
        for (let i = 0; i < m; i += FACET) {
            const b = pts[i];

            if (bflag[i]) { out.push([b[0], b[1]]); continue; }
            const a = pts[(i - 1 + m) % m], c = pts[(i + 1) % m];
            const tx = c[0] - a[0], ty = c[1] - a[1];
            const tl = Math.hypot(tx, ty) || 1;
            const nx = ty / tl, ny = -tx / tl;
            const raw = (this._sn(b[0]*0.22, b[1]*0.22, 70) - 0.5) * 2 * AMP;
            const o   = Math.round(raw / Q) * Q;
            out.push([b[0] + nx * o, b[1] + ny * o]);
        }
        return out.length >= 3 ? out : loop;
    }

    _smoothClipLoop(loop) {
        const cols = this._cols, rows = this._rows;
        const onEdge = (x, y) => x <= 0 || x >= cols || y <= 0 || y >= rows;
        const n = loop.length;
        let pts = [];
        for (let i = 0; i < n; i++) {
            const A = loop[i], B = loop[(i + 1) % n];
            const dx = B[0] - A[0], dy = B[1] - A[1];
            const steps = Math.max(1, Math.round(Math.hypot(dx, dy)));
            for (let k = 0; k < steps; k++)
                pts.push([A[0] + dx * k / steps, A[1] + dy * k / steps]);
        }
        const pin = pts.map(p => onEdge(p[0], p[1]));
        for (let pass = 0; pass < 6; pass++) {
            const m = pts.length, np = pts.slice();
            for (let i = 0; i < m; i++) {
                if (pin[i]) continue;
                const a = pts[(i - 1 + m) % m], b = pts[i], c = pts[(i + 1) % m];
                np[i] = [a[0] * 0.25 + b[0] * 0.5 + c[0] * 0.25,
                          a[1] * 0.25 + b[1] * 0.5 + c[1] * 0.25];
            }
            pts = np;
        }
        const jagOut = (x, edgeSeed) => {
            const blk = Math.floor(x / 5);
            return 1 + Math.round(this._h(blk, edgeSeed, 60) * 2 + this._h(blk, edgeSeed + 7, 60) * 1);
        };
        const out = [];
        for (let i = 0; i < pts.length; i += 3) {
            let x = pts[i][0], y = pts[i][1];
            if (x > 0.5 && x < cols - 0.5) {
                if (y <= 0.5)             y = -jagOut(x, 0);
                else if (y >= rows - 0.5) y = rows + jagOut(x, 1);
            }
            out.push([x, y]);
        }
        return out.length >= 3 ? out : pts;
    }

    _buildFacets() {

        const sf = new Path2D(), so = new Path2D();
        for (let li = 0; li < this._loops.length; li++) {
            const loop = this._loops[li];
            if (loop.length < 3) continue;
            const trace = (p) => {
                p.moveTo(loop[0][0], loop[0][1]);
                for (let q = 1; q < loop.length; q++) p.lineTo(loop[q][0], loop[q][1]);
                p.closePath();
            };
            trace(sf);
            if (this._loopOuter[li]) trace(so);
        }
        this._silFull = sf;
        this._silOuter = so;

        this._silClip = this._buildVoronoiBoundary();

        let minc = this._cols, maxc = 0, minr = this._rows, maxr = 0, any = false;
        for (let r = 0; r < this._rows; r++)
            for (let c = 0; c < this._cols; c++)
                if (this._solid(c, r)) {
                    any = true;
                    if (c < minc) minc = c; if (c > maxc) maxc = c;
                    if (r < minr) minr = r; if (r > maxr) maxr = r;
                }
        this._facets = [];
        this._bbox = { minc, maxc, minr, maxr };
        if (!any) return;

        const P = 3.6;
        const gx0 = minc - P, gy0 = minr - P;
        const nx = Math.ceil((maxc - minc) / P) + 3;
        const ny = Math.ceil((maxr - minr) / P) + 3;
        const j = (i, k, s) => this._h(i, k, s) - 0.5;
        const cx = (i, k) => gx0 + i * P + j(i, k, 90) * P * 0.7;
        const cy = (i, k) => gy0 + k * P + j(i, k, 91) * P * 0.7;
        const mid = (ax, ay, bx, by, off) => {
            const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
            return [(ax + bx) / 2 - dy / l * off, (ay + by) / 2 + dx / l * off];
        };
        const gray = (x) => { x = Math.max(5, Math.min(82, Math.round(x))); return `rgb(${x},${x},${x})`; };

        for (let k = 0; k < ny; k++) {
            for (let i = 0; i < nx; i++) {
                const ccx = gx0 + (i + 0.5) * P, ccy = gy0 + (k + 0.5) * P;
                const ax = cx(i, k),     ay = cy(i, k);
                const bx = cx(i + 1, k), by = cy(i + 1, k);
                const dcx = cx(i + 1, k + 1), dcy = cy(i + 1, k + 1);
                const ex = cx(i, k + 1), ey = cy(i, k + 1);
                const top = mid(ax, ay, bx, by,   j(i, k, 92) * P * 0.32);
                const rgt = mid(bx, by, dcx, dcy, j(i + 1, k, 93) * P * 0.32);
                const bot = mid(ex, ey, dcx, dcy, j(i, k + 1, 92) * P * 0.32);
                const lft = mid(ax, ay, ex, ey,   j(i, k, 93) * P * 0.32);
                const poly = [[ax, ay], top, [bx, by], rgt, [dcx, dcy], bot, [ex, ey], lft];

                const path = new Path2D();
                path.moveTo(poly[0][0], poly[0][1]);
                for (let p = 1; p < poly.length; p++) path.lineTo(poly[p][0], poly[p][1]);
                path.closePath();

                const broad = (this._sn(ccx * 0.05, ccy * 0.05, 97) - 0.5) * 16;
                const fine  = (this._sn(ccx * 0.17, ccy * 0.17, 95) - 0.5) * 6;
                let v = 40 + broad + fine;
                const hv = this._h(i, k, 96);
                if (hv < 0.10) v -= 8; else if (hv < 0.18) v += 7;
                this._facets.push({ path, fill: gray(v) });
            }
        }
    }

    _drawSingleRock(ctx, cx, cy, scale = 0.4) {

        const Lx = -0.55, Ly = -0.78, Ll = Math.hypot(Lx, Ly), lx = Lx / Ll, ly = Ly / Ll;

        const G = [
            [[-2.20,-1.65],[-1.05,-2.35],[ 0.15,-2.50],[ 1.35,-2.20],[ 2.35,-1.45]],
            [[-3.05,-0.45],[-1.35,-1.00],[ 0.20,-0.85],[ 1.55,-0.70],[ 3.05,-0.20]],
            [[-3.05, 0.95],[-1.20, 0.55],[ 0.30, 0.70],[ 1.65, 0.55],[ 2.70, 1.05]],
            [[-1.95, 1.70],[-0.70, 2.35],[ 0.45, 2.45],[ 1.45, 2.05],[ 2.25, 1.35]],
        ];
        const T = (p) => [cx + p[0] * scale, cy + p[1] * scale];

        const stone = (sv) => {
            sv = sv < 0.05 ? 0.05 : sv > 0.95 ? 0.95 : sv;
            const r = Math.round(24 + sv * 122);
            const g = Math.round(22 + sv * 108);
            const b = Math.round(30 + sv * 98);
            return `rgb(${r},${g},${b})`;
        };

        const tracePoly = (pts) => {
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
            ctx.closePath();
        };

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap  = 'round';

        const ring = [
            G[0][0], G[0][1], G[0][2], G[0][3], G[0][4],
            G[1][4], G[2][4], G[3][4],
            G[3][3], G[3][2], G[3][1], G[3][0],
            G[2][0], G[1][0],
        ].map(T);

        const shY = cy + 2.55 * scale, shRx = 3.0 * scale, shRy = 0.7 * scale;
        const sg = ctx.createRadialGradient(cx, shY, 0, cx, shY, shRx);
        sg.addColorStop(0, 'rgba(0,0,0,0.40)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save();
        ctx.translate(cx, shY);
        ctx.scale(1, shRy / shRx);
        ctx.beginPath();
        ctx.arc(0, 0, shRx, 0, Math.PI * 2);
        ctx.fillStyle = sg;
        ctx.fill();
        ctx.restore();

        tracePoly(ring);
        ctx.fillStyle = stone(0.36);
        ctx.fill();

        const facets = [];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 4; c++) {
                const quad = [G[r][c], G[r][c + 1], G[r + 1][c + 1], G[r + 1][c]];

                let mx = 0, my = 0;
                for (const q of quad) { mx += q[0]; my += q[1]; }
                mx /= 4; my /= 4;
                const d = Math.hypot(mx, my) || 1e-4;
                const ndotl = (mx / d) * lx + (my / d) * ly;
                const dome  = Math.min(1, d / 2.6);
                let sv = 0.36 + ndotl * 0.32 * dome;
                sv -= (my / 2.4) * 0.10;
                sv += (this._h(r, c, 5) - 0.5) * 0.05;
                facets.push({ pts: quad.map(T), fill: stone(sv) });
            }
        }
        for (const f of facets) {
            tracePoly(f.pts);
            ctx.fillStyle = f.fill;
            ctx.fill();
        }

        ctx.strokeStyle = 'rgba(0,0,0,0.32)';
        ctx.lineWidth   = 0.05 * scale;
        for (const f of facets) {
            tracePoly(f.pts);
            ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(150,148,162,0.55)';
        ctx.lineWidth   = 0.10 * scale;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];

            const mxr = (a[0] + b[0]) / 2 - cx, myr = (a[1] + b[1]) / 2 - cy;
            const dr = Math.hypot(mxr, myr) || 1e-4;
            if ((mxr / dr) * lx + (myr / dr) * ly > 0.15) {
                ctx.beginPath();
                ctx.moveTo(a[0], a[1]);
                ctx.lineTo(b[0], b[1]);
                ctx.stroke();
            }
        }

        ctx.strokeStyle = '#000000';
        ctx.lineWidth   = 0.22 * scale;
        ctx.lineJoin    = 'round';
        tracePoly(ring);
        ctx.stroke();

        ctx.restore();
    }

    _drawSecondRock(ctx, cx, cy, scale = 0.4) {
        const Lx = -0.55, Ly = -0.78, Ll = Math.hypot(Lx, Ly), lx = Lx / Ll, ly = Ly / Ll;

        const G = [

            [[-3.70,-1.45],[-2.00,-2.45],[-0.30,-2.70],[ 1.20,-2.40],[ 2.40,-1.60]],
            [[-3.00,-0.20],[-1.45,-1.05],[ 0.10,-0.90],[ 1.50,-0.80],[ 3.10,-0.40]],
            [[-3.35, 1.05],[-1.30, 0.50],[ 0.25, 0.65],[ 1.55, 0.45],[ 2.80, 0.85]],
            [[-3.80, 1.35],[-2.10, 2.20],[ 0.30, 2.50],[ 1.40, 2.10],[ 2.30, 1.50]],
        ];
        const T = (p) => [cx + p[0] * scale, cy + p[1] * scale];

        const stone = (sv) => {
            sv = sv < 0.05 ? 0.05 : sv > 0.95 ? 0.95 : sv;
            const r = Math.round(24 + sv * 122);
            const g = Math.round(22 + sv * 108);
            const b = Math.round(30 + sv * 98);
            return `rgb(${r},${g},${b})`;
        };
        const tracePoly = (pts) => {
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
            ctx.closePath();
        };

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap  = 'round';

        const ring = [
            G[0][0], G[0][1], G[0][2], G[0][3], G[0][4],
            G[1][4], G[2][4], G[3][4],
            G[3][3], G[3][2], G[3][1], G[3][0],
            G[2][0], G[1][0],
        ].map(T);

        const shY = cy + 2.55 * scale, shRx = 3.0 * scale, shRy = 0.7 * scale;
        const sg = ctx.createRadialGradient(cx, shY, 0, cx, shY, shRx);
        sg.addColorStop(0, 'rgba(0,0,0,0.40)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save();
        ctx.translate(cx, shY);
        ctx.scale(1, shRy / shRx);
        ctx.beginPath();
        ctx.arc(0, 0, shRx, 0, Math.PI * 2);
        ctx.fillStyle = sg;
        ctx.fill();
        ctx.restore();

        tracePoly(ring);
        ctx.fillStyle = stone(0.36);
        ctx.fill();

        const facets = [];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 4; c++) {
                const quad = [G[r][c], G[r][c + 1], G[r + 1][c + 1], G[r + 1][c]];
                let mx = 0, my = 0;
                for (const q of quad) { mx += q[0]; my += q[1]; }
                mx /= 4; my /= 4;
                const d = Math.hypot(mx, my) || 1e-4;
                const ndotl = (mx / d) * lx + (my / d) * ly;
                const dome  = Math.min(1, d / 2.6);
                let sv = 0.36 + ndotl * 0.32 * dome;
                sv -= (my / 2.4) * 0.10;
                sv += (this._h(r, c, 7) - 0.5) * 0.05;
                facets.push({ pts: quad.map(T), fill: stone(sv) });
            }
        }
        for (const f of facets) {
            tracePoly(f.pts);
            ctx.fillStyle = f.fill;
            ctx.fill();
        }

        ctx.strokeStyle = 'rgba(0,0,0,0.32)';
        ctx.lineWidth   = 0.05 * scale;
        for (const f of facets) { tracePoly(f.pts); ctx.stroke(); }

        ctx.strokeStyle = 'rgba(150,148,162,0.55)';
        ctx.lineWidth   = 0.10 * scale;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            const mxr = (a[0] + b[0]) / 2 - cx, myr = (a[1] + b[1]) / 2 - cy;
            const dr = Math.hypot(mxr, myr) || 1e-4;
            if ((mxr / dr) * lx + (myr / dr) * ly > 0.15) {
                ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
            }
        }

        ctx.strokeStyle = '#000000';
        ctx.lineWidth   = 0.22 * scale;
        ctx.lineJoin    = 'round';
        tracePoly(ring);
        ctx.stroke();

        ctx.restore();
    }

    _drawRockFromGrid(ctx, cx, cy, scale, G, grainSeed) {
        const Lx = -0.55, Ly = -0.78, Ll = Math.hypot(Lx, Ly), lx = Lx / Ll, ly = Ly / Ll;
        const T = (p) => [cx + p[0] * scale, cy + p[1] * scale];
        const stone = (sv) => {
            sv = sv < 0.05 ? 0.05 : sv > 0.95 ? 0.95 : sv;
            return `rgb(${Math.round(24+sv*122)},${Math.round(22+sv*108)},${Math.round(30+sv*98)})`;
        };
        const tracePoly = (pts) => {
            ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
            ctx.closePath();
        };
        ctx.save();
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        const ring = [
            G[0][0], G[0][1], G[0][2], G[0][3], G[0][4],
            G[1][4], G[2][4], G[3][4],
            G[3][3], G[3][2], G[3][1], G[3][0],
            G[2][0], G[1][0],
        ].map(T);
        const shY = cy + 2.55 * scale, shRx = 3.0 * scale, shRy = 0.7 * scale;
        const sg = ctx.createRadialGradient(cx, shY, 0, cx, shY, shRx);
        sg.addColorStop(0, 'rgba(0,0,0,0.40)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save(); ctx.translate(cx, shY); ctx.scale(1, shRy / shRx);
        ctx.beginPath(); ctx.arc(0, 0, shRx, 0, Math.PI * 2); ctx.fillStyle = sg; ctx.fill();
        ctx.restore();
        tracePoly(ring); ctx.fillStyle = stone(0.36); ctx.fill();
        const facets = [];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
            const quad = [G[r][c], G[r][c+1], G[r+1][c+1], G[r+1][c]];
            let mx = 0, my = 0; for (const q of quad) { mx += q[0]; my += q[1]; } mx /= 4; my /= 4;
            const d = Math.hypot(mx, my) || 1e-4;
            let sv = 0.36 + ((mx/d)*lx+(my/d)*ly) * 0.32 * Math.min(1, d/2.6)
                         - (my/2.4)*0.10 + (this._h(r, c, grainSeed)-0.5)*0.05;
            facets.push({ pts: quad.map(T), fill: stone(sv) });
        }
        for (const f of facets) { tracePoly(f.pts); ctx.fillStyle = f.fill; ctx.fill(); }
        ctx.strokeStyle = 'rgba(0,0,0,0.32)'; ctx.lineWidth = 0.05 * scale;
        for (const f of facets) { tracePoly(f.pts); ctx.stroke(); }
        ctx.strokeStyle = 'rgba(150,148,162,0.55)'; ctx.lineWidth = 0.10 * scale;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i+1) % ring.length];
            const mxr = (a[0]+b[0])/2-cx, myr = (a[1]+b[1])/2-cy, dr = Math.hypot(mxr,myr)||1e-4;
            if ((mxr/dr)*lx+(myr/dr)*ly > 0.15) { ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke(); }
        }
        ctx.strokeStyle = '#000000'; ctx.lineWidth = 0.22 * scale; ctx.lineJoin = 'round';
        tracePoly(ring); ctx.stroke();
        ctx.restore();
    }

    _rockOutlinePath(ctx, rcx, rcy, scale, G) {
        const R = G.length, C = G[0].length;
        ctx.moveTo(rcx + G[0][0][0] * scale, rcy + G[0][0][1] * scale);
        for (let c = 1; c < C; c++)
            ctx.lineTo(rcx + G[0][c][0] * scale, rcy + G[0][c][1] * scale);
        for (let r = 1; r < R; r++)
            ctx.lineTo(rcx + G[r][C-1][0] * scale, rcy + G[r][C-1][1] * scale);
        for (let c = C-2; c >= 0; c--)
            ctx.lineTo(rcx + G[R-1][c][0] * scale, rcy + G[R-1][c][1] * scale);
        for (let r = R-2; r > 0; r--)
            ctx.lineTo(rcx + G[r][0][0] * scale, rcy + G[r][0][1] * scale);
        ctx.closePath();
    }

    _buildLineRocks() {
        if (this._lineRocks) return;
        this._lineRocks = [

            { seed:  3, G: [
                [[-2.35,-1.35],[-1.10,-2.05],[ 0.10,-2.20],[ 1.45,-1.95],[ 2.50,-1.30]],
                [[-3.30,-0.30],[-1.45,-0.85],[ 0.20,-0.75],[ 1.65,-0.60],[ 3.30,-0.15]],
                [[-3.25, 0.80],[-1.30, 0.45],[ 0.30, 0.60],[ 1.70, 0.45],[ 2.95, 0.90]],
                [[-2.05, 1.55],[-0.75, 2.15],[ 0.40, 2.30],[ 1.50, 1.90],[ 2.30, 1.25]],
            ]},

            { seed:  7, G: [
                [[-1.90,-1.80],[-0.85,-2.70],[ 0.10,-2.95],[ 1.20,-2.60],[ 2.05,-1.75]],
                [[-2.70,-0.50],[-1.20,-1.15],[ 0.20,-0.95],[ 1.45,-0.80],[ 2.80,-0.25]],
                [[-2.65, 0.95],[-1.10, 0.60],[ 0.25, 0.75],[ 1.55, 0.60],[ 2.55, 1.10]],
                [[-1.75, 1.95],[-0.60, 2.60],[ 0.40, 2.75],[ 1.35, 2.30],[ 2.05, 1.60]],
            ]},

            { seed: 11, G: [
                [[-2.65,-1.55],[-1.45,-2.40],[-0.05,-2.55],[ 1.15,-2.20],[ 2.25,-1.45]],
                [[-3.50,-0.40],[-1.70,-1.00],[ 0.10,-0.80],[ 1.45,-0.65],[ 2.95,-0.25]],
                [[-3.45, 1.00],[-1.55, 0.55],[ 0.20, 0.70],[ 1.55, 0.55],[ 2.65, 1.00]],
                [[-2.45, 1.80],[-1.10, 2.40],[ 0.30, 2.50],[ 1.35, 2.00],[ 2.20, 1.30]],
            ]},

            { seed: 15, G: [
                [[-2.05,-1.45],[-0.90,-2.30],[ 0.25,-2.50],[ 1.50,-2.30],[ 2.60,-1.55]],
                [[-2.85,-0.40],[-1.25,-0.90],[ 0.25,-0.80],[ 1.65,-0.65],[ 3.40,-0.20]],
                [[-2.80, 0.90],[-1.15, 0.55],[ 0.35, 0.70],[ 1.70, 0.55],[ 3.30, 1.00]],
                [[-1.80, 1.60],[-0.55, 2.25],[ 0.55, 2.55],[ 1.65, 2.25],[ 2.70, 1.50]],
            ]},

            { seed: 19, G: [
                [[-2.15,-1.45],[-1.00,-2.20],[ 0.45,-2.55],[ 1.55,-2.35],[ 2.40,-1.55]],
                [[-3.05,-0.45],[-1.35,-0.95],[ 0.25,-0.85],[ 1.60,-0.70],[ 3.10,-0.20]],
                [[-3.00, 0.95],[-1.20, 0.55],[ 0.30, 0.70],[ 1.65, 0.55],[ 2.75, 1.05]],
                [[-1.90, 1.65],[-0.65, 2.30],[ 0.50, 2.45],[ 1.50, 2.10],[ 2.30, 1.40]],
            ]},

            { seed: 23, G: [
                [[-1.80,-1.55],[-0.90,-2.35],[ 0.15,-2.50],[ 1.30,-2.25],[ 2.15,-1.45]],
                [[-2.90,-0.45],[-1.30,-0.95],[ 0.20,-0.85],[ 1.55,-0.70],[ 3.05,-0.20]],
                [[-3.30, 0.95],[-1.50, 0.60],[ 0.30, 0.75],[ 1.70, 0.55],[ 3.20, 1.10]],
                [[-2.55, 1.85],[-1.05, 2.45],[ 0.50, 2.60],[ 1.60, 2.20],[ 2.55, 1.50]],
            ]},

            { seed: 27, G: [
                [[-1.95,-1.50],[-0.90,-2.20],[ 0.10,-2.35],[ 1.25,-2.10],[ 2.15,-1.40]],
                [[-2.75,-0.40],[-1.25,-0.90],[ 0.15,-0.80],[ 1.45,-0.65],[ 2.80,-0.20]],
                [[-2.75, 0.85],[-1.15, 0.50],[ 0.25, 0.65],[ 1.55, 0.50],[ 2.55, 0.95]],
                [[-1.70, 1.65],[-0.60, 2.25],[ 0.40, 2.40],[ 1.35, 2.00],[ 2.10, 1.30]],
            ]},

            { seed: 31, G: [
                [[-2.30,-1.30],[-1.00,-2.45],[ 0.15,-2.65],[ 1.35,-2.40],[ 2.30,-1.30]],
                [[-3.10,-0.40],[-1.40,-1.05],[ 0.20,-0.90],[ 1.55,-0.70],[ 3.10,-0.20]],
                [[-3.05, 0.90],[-1.20, 0.50],[ 0.30, 0.65],[ 1.65, 0.50],[ 2.70, 0.95]],
                [[-2.10, 1.60],[-0.80, 2.20],[ 0.45, 2.30],[ 1.40, 1.90],[ 2.20, 1.25]],
            ]},

            { seed: 37, G: [
                [[-2.10,-1.55],[-0.90,-2.35],[ 0.30,-2.55],[ 1.55,-2.30],[ 2.55,-1.50]],
                [[-3.00,-0.45],[-1.30,-0.95],[ 0.30,-0.85],[ 1.65,-0.70],[ 3.30,-0.20]],
                [[-2.95, 0.95],[-1.20, 0.55],[ 0.35, 0.70],[ 1.70, 0.55],[ 3.20, 1.05]],
                [[-1.90, 1.65],[-0.65, 2.30],[ 0.55, 2.50],[ 1.55, 2.10],[ 2.45, 1.40]],
            ]},
        ];
    }

    draw(ctx, px, py, ratio, gameWidth, gameHeight, screenW, screenH) {
        if (!this.ready) return;

        
        
        
        
        if (this._silRebuildAt && performance.now() >= this._silRebuildAt) {
            this._silRebuildAt = 0;
            this._silClip = this._buildVoronoiBoundary();
            this._debugVoronoiSegs = null;
            this._landed.clear();   
            
            
            
            
            
            
            this._damageDirty = true;
        }

        
        
        this._world = { s: gameWidth / this._cols,
                        hw: gameWidth / 2, hh: gameHeight / 2 };

        const originX = screenW / 2 - px - ratio * gameWidth  / 2;
        const originY = screenH / 2 - py - ratio * gameHeight / 2;
        const cellW   = ratio * gameWidth  / this._cols;
        const cellH   = ratio * gameHeight / this._rows;

        ctx.save();
        ctx.translate(originX, originY);
        ctx.scale(cellW, cellH);

        const s   = 0.4;
        const cx  = this._cols / 2, cy = this._rows / 2;
        const d   = 1.8;
        const sq3 = Math.sqrt(3);

        const hex = [
            [ d,       0        ],
            [ d / 2,  -d*sq3/2  ],
            [-d / 2,  -d*sq3/2  ],
            [-d,       0        ],
            [-d / 2,   d*sq3/2  ],
            [ d / 2,   d*sq3/2  ],
        ];
        const pick = [3, 1, 2, 0, 5, 4];

        this._buildLineRocks();

        const centerG = [
            [[-2.20,-1.65],[-1.05,-2.35],[ 0.15,-2.50],[ 1.35,-2.20],[ 2.35,-1.45]],
            [[-3.05,-0.45],[-1.35,-1.00],[ 0.20,-0.85],[ 1.55,-0.70],[ 3.05,-0.20]],
            [[-3.05, 0.95],[-1.20, 0.55],[ 0.30, 0.70],[ 1.65, 0.55],[ 2.70, 1.05]],
            [[-1.95, 1.70],[-0.70, 2.35],[ 0.45, 2.45],[ 1.45, 2.05],[ 2.25, 1.35]],
        ];

        if (this.useVoronoi && this._gl && this._silClip) {
            const gl = this._gl;

            if (this._glCanvas.width !== screenW || this._glCanvas.height !== screenH) {
                this._glCanvas.width  = screenW;
                this._glCanvas.height = screenH;
                gl.viewport(0, 0, screenW, screenH);
            }

            gl.uniform2f(this._glOriginU, originX, originY);
            gl.uniform2f(this._glCellSzU, cellW,   cellH);
            gl.uniform1f(this._glShU,     screenH);
            gl.uniform1f(this._glRockSzU, Math.min(this._cols, 120) / 50.0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            
            
            
            const tlx = -originX / cellW;
            const tly = -originY / cellH;
            const tlw =  screenW  / cellW;
            const tlh =  screenH  / cellH;
            this._view = { tlx, tly, tlw, tlh };
            const nowMs = performance.now();

            
            
            
            
            
            
            
            
            
            
            if (this._damageDirty || !this._damageBatch) {
                this._damageDirty = false;
                const batch = { holes: null, groups: [], shaking: [] };
                const byStage = new Map();
                for (const [k, frac] of this._rockHealth) {
                    if (this._rockDead.has(k)) continue;
                    const stage = this._stageOf(frac);
                    if (stage < 1) continue;
                    const cell = this._cellPolys.get(k);
                    if (!cell) continue;
                    if (!batch.holes) batch.holes = new Path2D(this._silClip);
                    batch.holes.addPath(cell.path);
                    if (stage >= 5) batch.shaking.push(cell);
                    else {
                        let g = byStage.get(stage);
                        if (!g) { g = new Path2D(); byStage.set(stage, g); }
                        g.addPath(cell.path);
                    }
                }
                for (const [stage, path] of byStage)
                    batch.groups.push({ path, alpha: 1 - 0.55 * Math.pow(stage / 5, 2) });
                this._damageBatch = batch;
            }
            const dmgBatch = this._damageBatch;

            ctx.save();
            ctx.clip(dmgBatch.holes || this._silClip, 'evenodd');
            ctx.globalAlpha = 1;
            let rockImg, rockImgIsBitmap = false;
            // ImageBitmap snapshot is only needed when we blit the same rock
            // texture more than once (damage stages, shakes, regrowth).
            // Undamaged views can draw the GL canvas directly and skip the
            // per-frame GPU readback.
            const needManyBlits = (dmgBatch.groups && dmgBatch.groups.length) ||
                (dmgBatch.shaking && dmgBatch.shaking.length) ||
                this._growing.size || this._landed.size;
            if (needManyBlits && typeof this._glCanvas.transferToImageBitmap === 'function') {
                rockImg = this._glCanvas.transferToImageBitmap();
                rockImgIsBitmap = true;
            } else {
                rockImg = this._glCanvas;
            }
            ctx.drawImage(rockImg, tlx, tly, tlw, tlh);
            ctx.restore();

            const rockSz = Math.min(this._cols, 120) / 50.0;
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.lineJoin    = 'round';
            ctx.lineCap     = 'round';
            ctx.strokeStyle = 'rgb(5,4,7)';
            ctx.lineWidth   = 0.072 * rockSz;
            ctx.stroke(this._silClip);
            ctx.restore();

            
            
            
            
            for (const g of dmgBatch.groups) {
                ctx.save();
                ctx.globalAlpha = g.alpha;
                ctx.clip(g.path);
                ctx.drawImage(rockImg, tlx, tly, tlw, tlh);
                ctx.restore();
            }
            for (const cell of dmgBatch.shaking) {
                if (cell.cx < tlx - 3 || cell.cx > tlx + tlw + 3 ||
                    cell.cy < tly - 3 || cell.cy > tly + tlh + 3) continue;
                ctx.save();
                ctx.globalAlpha = 0.45;
                ctx.clip(cell.path);
                const [ox, oy] = this._trembleOf(cell.k, nowMs);
                ctx.translate(cell.cx + ox, cell.cy + oy);
                ctx.scale(1.05, 1.05);
                ctx.translate(-cell.cx, -cell.cy);
                ctx.drawImage(rockImg, tlx, tly, tlw, tlh);
                
                
                ctx.lineJoin    = 'round';
                ctx.strokeStyle = 'rgb(5,4,7)';
                ctx.lineWidth   = 0.11 * rockSz;
                ctx.stroke(cell.path);
                ctx.restore();
            }
            
            
            
            
            
            
            
            
            
            
            
            if (this._growing.size || this._landed.size) {
                const many = this._growing.size > 12;   
                ctx.save();
                ctx.lineJoin = 'round';
                const tracePoly = (poly) => {
                    ctx.beginPath();
                    for (let i = 0; i < poly.length; i++)
                        i ? ctx.lineTo(poly[i][0], poly[i][1]) : ctx.moveTo(poly[i][0], poly[i][1]);
                    ctx.closePath();
                };
                const drawRockPoly = () => {   
                    ctx.save();
                    ctx.clip();
                    ctx.drawImage(rockImg, tlx, tly, tlw, tlh);
                    ctx.restore();
                    ctx.strokeStyle = 'rgb(5,4,7)';
                    ctx.lineWidth = 0.072 * rockSz;
                    ctx.stroke();
                };
                
                for (const k of this._landed) {
                    const cell = this._cellPolys.get(k);
                    if (!cell) continue;
                    if (cell.cx < tlx - 4 || cell.cx > tlx + tlw + 4 ||
                        cell.cy < tly - 4 || cell.cy > tly + tlh + 4) continue;
                    tracePoly(cell.poly);
                    drawRockPoly();
                }
                for (const [k, g] of this._growing) {
                    const cell = this._cellPolys.get(k);
                    if (!cell) continue;
                    const p = Math.min(1, Math.max(0, (nowMs - g.start) / GROW_MS));
                    // self-heal: a growing record with no completion long past
                    
                    
                    
                    if (nowMs - g.start > GROW_MS + 4000) {
                        this._growing.delete(k);
                        this._growDust.delete(k);
                        this._damageDirty = true;
                        if (g.mapped) this.mapDirty = true;
                        continue;
                    }
                    
                    
                    if (p >= 0.5 && !g.mapped) { g.mapped = true; this.mapDirty = true; }
                    if (cell.cx < tlx - 4 || cell.cx > tlx + tlw + 4 ||
                        cell.cy < tly - 4 || cell.cy > tly + tlh + 4) continue;
                    
                    if (!(Number.isFinite(g.ax) && Number.isFinite(g.ay))) {
                        g.ax = cell.cx; g.ay = cell.cy;
                    }
                    
                    const sc = GROW_SCALE0 + (1 - GROW_SCALE0) * growEase(p);
                    
                    
                    const [tox, toy] = this._trembleOf(k, nowMs);
                    const shx = tox * 0.7 * (1 - p * 0.6), shy = toy * 0.7 * (1 - p * 0.6);
                    const ax2 = g.ax + shx, ay2 = g.ay + shy;
                    const spoly = cell.poly.map(pt => [ax2 + (pt[0] - g.ax) * sc,
                                                       ay2 + (pt[1] - g.ay) * sc]);
                    tracePoly(spoly);
                    
                    
                    
                    
                    
                    
                    
                    ctx.save();
                    ctx.clip();
                    ctx.translate(ax2, ay2);
                    ctx.scale(sc, sc);
                    ctx.translate(-g.ax, -g.ay);
                    ctx.drawImage(rockImg, tlx, tly, tlw, tlh);
                    ctx.restore();
                    ctx.strokeStyle = 'rgb(5,4,7)';
                    ctx.lineWidth = 0.072 * rockSz;
                    ctx.stroke();

                    
                    
                    
                    
                    
                    const frac = this._rockHealth.get(k);
                    
                    const expect = Math.max(0.25, growEase(p));
                    const intact = frac === undefined ? 1
                        : Math.max(0, Math.min(1, frac / expect));
                    const stage = this._stageOf(intact);
                    if (stage >= 1) {
                        const cpath = this._getCrackPath(k, stage);
                        if (cpath) {
                            ctx.save();
                            tracePoly(spoly);
                            ctx.clip();
                            ctx.translate(ax2, ay2);
                            ctx.scale(sc, sc);
                            ctx.translate(-g.ax, -g.ay);
                            ctx.lineCap = 'round';
                            const w = 0.035 * rockSz * (0.28 + 0.075 * stage) / sc;
                            ctx.strokeStyle = 'rgba(5,4,7,0.8)';
                            ctx.lineWidth = w * 2.1;
                            ctx.stroke(cpath);
                            const cpal = TerrainRenderer.CRACK_PAL[this._ore.get(k) ?? 0]
                                      || TerrainRenderer.CRACK_PAL[0];
                            ctx.strokeStyle = `rgba(${cpal.hot},0.4)`;
                            ctx.lineWidth = w * 0.5;
                            ctx.stroke(cpath);
                            ctx.restore();
                        }
                    }

                    
                    
                    if (p < 1 && this._pebbles.length < 80) {
                        const lt = this._growDust.get(k) || 0;
                        if (nowMs - lt > (many ? 260 : 130)) {
                            this._growDust.set(k, nowMs);
                            const kk = k & 0xffff;
                            const seq = Math.floor(nowMs / 130) & 0xff;
                            for (let i = 0; i < (many ? 1 : 2); i++) {
                                const ei = Math.floor(this._h(seq * 2 + i, kk, 174) * spoly.length);
                                const A = spoly[ei % spoly.length];
                                const B = spoly[(ei + 1) % spoly.length];
                                const tt = this._h(seq * 2 + i, kk, 175);
                                const ex = A[0] + (B[0] - A[0]) * tt;
                                const ey = A[1] + (B[1] - A[1]) * tt;
                                const dl = Math.hypot(ex - g.ax, ey - g.ay) || 1;
                                this._pebbles.push({
                                    x: ex, y: ey,
                                    dx: (ex - g.ax) / dl * 0.8, dy: (ey - g.ay) / dl * 0.8,
                                    born: nowMs, seed: (kk + seq * 17 + i * 71) & 0xffff,
                                });
                            }
                        }
                    }
                }
                ctx.restore();
            }

            // ══ Landing: a warm gold rim traces the new face for a beat.
            
            if (this._growFx.length) {
                ctx.save();
                ctx.lineJoin = 'round';
                for (let i = this._growFx.length - 1; i >= 0; i--) {
                    const fx = this._growFx[i];
                    const t = (nowMs - fx.born) / 250;
                    if (t >= 1) { this._growFx.splice(i, 1); continue; }
                    const cell = this._cellPolys.get(fx.k);
                    if (!cell) { this._growFx.splice(i, 1); continue; }
                    const a = Math.pow(1 - t, 1.5);
                    ctx.strokeStyle = `rgba(255,214,150,${0.7 * a})`;
                    ctx.lineWidth = 0.16 * rockSz * (0.4 + 0.6 * a);
                    ctx.stroke(cell.path);
                }
                ctx.restore();
            }

            if (rockImgIsBitmap) rockImg.close();

            // ── Damage overlay per rock: darkening + pockmarks, bite notches
            
            if (this._rockHealth.size) {
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.lineCap  = 'round';
                for (const [k, frac] of this._rockHealth) {
                    if (this._rockDead.has(k)) continue;
                    const cell = this._cellPolys.get(k);
                    if (!cell) continue;
                    if (cell.cx < tlx - 3 || cell.cx > tlx + tlw + 3 ||
                        cell.cy < tly - 3 || cell.cy > tly + tlh + 3) continue;
                    const stage = this._stageOf(frac);
                    const bites = this._getBitePath(k);
                    const path  = stage >= 1 ? this._getCrackPath(k, stage) : null;
                    if (!bites && !path) continue;
                    ctx.save();
                    ctx.clip(cell.path);
                    
                    
                    
                    if (stage >= 1) {
                        ctx.fillStyle = `rgba(5,4,7,${0.06 * stage})`;
                        ctx.fill(cell.path);
                    }
                    
                    
                    
                    if (stage >= 5) {
                        const [ox, oy] = this._trembleOf(k, nowMs);
                        ctx.translate(cell.cx + ox, cell.cy + oy);
                        ctx.scale(1.05, 1.05);
                        ctx.translate(-cell.cx, -cell.cy);
                    }
                    
                    
                    
                    
                    
                    if (bites) {
                        ctx.fillStyle = 'rgb(5,4,7)';
                        ctx.fill(bites);
                    }
                    if (path) {
                        const ht    = this._hitFlash.get(k);
                        const hitB  = ht !== undefined && nowMs - ht < 150 ? 1 - (nowMs - ht) / 150 : 0;
                        // a new crack slams in white-hot and over-wide, then
                        
                        const st    = this._crackSnap.get(k);
                        const snap  = st !== undefined && nowMs - st < 220
                            ? Math.pow(1 - (nowMs - st) / 220, 2) : 0;
                        const boost = Math.max(hitB, snap);
                        // discreet: damage whispers, the ore does the
                        
                        const a = 0.30 + 0.035 * stage;
                        const w = 0.035 * rockSz * (0.28 + 0.075 * stage) * (1 + snap);
                        
                        
                        
                        const cpal = TerrainRenderer.CRACK_PAL[this._ore.get(k) ?? 0]
                                  || TerrainRenderer.CRACK_PAL[0];
                        
                        ctx.strokeStyle = 'rgba(5,4,7,0.8)';
                        ctx.lineWidth   = w * 2.1;
                        ctx.stroke(path);
                        
                        ctx.strokeStyle = `rgba(${cpal.deep},${a})`;
                        ctx.lineWidth   = w * 1.2;
                        ctx.stroke(path);
                        
                        ctx.strokeStyle = `rgba(${cpal.hot},${Math.min(1, a * 0.9 + boost * 0.45)})`;
                        ctx.lineWidth   = w * 0.5;
                        ctx.stroke(path);
                        
                        ctx.strokeStyle = `rgba(${cpal.hair},${Math.max(0.08 + 0.025 * stage, boost * 0.6)})`;
                        ctx.lineWidth   = w * 0.2;
                        ctx.stroke(path);
                    }
                    ctx.restore();
                    
                    if (stage >= 5 && this._pebbles.length < 80) {
                        const lt = this._lastTrickle.get(k) || 0;
                        if (nowMs - lt > 120) {
                            this._lastTrickle.set(k, nowMs);
                            const kk = k & 0xffff;
                            const seq = Math.floor(nowMs / 120) & 0xff;
                            for (let pi = 0; pi < 2; pi++) {
                                const ei = Math.floor(this._h(seq * 2 + pi, kk, 150) * cell.poly.length);
                                const A = cell.poly[ei], B = cell.poly[(ei + 1) % cell.poly.length];
                                const tt = this._h(seq * 2 + pi, kk, 151);
                                const px = A[0] + (B[0] - A[0]) * tt;
                                const py = A[1] + (B[1] - A[1]) * tt;
                                const dl = Math.hypot(px - cell.cx, py - cell.cy) || 1;
                                this._pebbles.push({
                                    x: px, y: py,
                                    dx: (px - cell.cx) / dl, dy: (py - cell.cy) / dl,
                                    born: nowMs, seed: (kk + seq * 31 + pi * 47) & 0xffff,
                                });
                            }
                        }
                    }
                }
                ctx.restore();
            }

            // ── Ore markings: one crystal per deposit, drawn on the rock
            
            
            
            
            
            if (this._ore.size) {
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.lineCap  = 'round';
                for (const [k, tier] of this._ore) {
                    if (this._rockDead.has(k)) continue;
                    const cell = this._cellPolys.get(k);
                    if (!cell) continue;
                    if (cell.cx < tlx - 3 || cell.cx > tlx + tlw + 3 ||
                        cell.cy < tly - 3 || cell.cy > tly + tlh + 3) continue;
                    const art = this._getVeinArt(k, tier);
                    if (!art) continue;
                    const pal   = TerrainRenderer.ORE_PAL[tier];
                    const frac  = this._rockHealth.get(k);
                    const stage = frac === undefined ? 0 : this._stageOf(frac);
                    
                    
                    
                    let sprout = null;
                    const spAt = this._oreSprout.get(k);
                    if (spAt !== undefined) {
                        const st = (nowMs - spAt) / GROW_ORE_MS;
                        if (st >= 1) { this._oreSprout.delete(k); this._sproutArt.delete(k); }
                        else sprout = Math.max(0, st);
                    }

                    // the core crystal's aura bleeds a little past its cell -
                    // treasure glowing through the mountain, kept quiet and
                    // slow so it marks the spot without screaming
                    if ((tier === 3 || tier === 4) && art.big) {
                        // emeralds breathe faster, wider and brighter - the
                        // rarest thing in the wall should be felt before
                        // it's seen
                        const em = tier === 4;
                        const pulse = 0.5 + 0.5 * Math.sin(nowMs / (em ? 1100 : 1400) + (k % 31));
                        const gr = rockSz * (em ? 0.68 + 0.14 * pulse : 0.55 + 0.10 * pulse);
                        const rgb = em ? '111,245,168' : '217,138,240';
                        // the aura swells in with the crystal, not before it
                        const a0 = (em ? 0.14 + 0.10 * pulse : 0.10 + 0.07 * pulse)
                                 * (sprout === null ? 1 : sprout * sprout);
                        const g = ctx.createRadialGradient(art.big[0], art.big[1], 0,
                                                           art.big[0], art.big[1], gr);
                        g.addColorStop(0, `rgba(${rgb},${a0})`);
                        g.addColorStop(1, `rgba(${rgb},0)`);
                        ctx.fillStyle = g;
                        ctx.beginPath();
                        ctx.arc(art.big[0], art.big[1], gr, 0, Math.PI * 2);
                        ctx.fill();
                    }

                    ctx.save();
                    ctx.clip(cell.path);
                    if (stage >= 5) {
                        const [ox, oy] = this._trembleOf(k, nowMs);
                        ctx.translate(cell.cx + ox, cell.cy + oy);
                        ctx.scale(1.05, 1.05);
                        ctx.translate(-cell.cx, -cell.cy);
                    }
                    ctx.globalAlpha = 1 - 0.275 * Math.pow(stage / 5, 2);
                    const baseA = ctx.globalAlpha;

                    if (sprout !== null) {
                        // ── the seam pushing through: one stone at a time,
                        
                        const parts = this._getSproutParts(k, tier);
                        if (parts) {
                            for (let di = 0; di < parts.length; di++) {
                                const dt = (sprout - di * 0.125) / 0.25; // 150ms apart, 300ms each
                                if (dt <= 0) continue;
                                const d = parts[di];
                                const e = dt >= 1 ? 1 : 1 - Math.pow(1 - dt, 3);
                                const os = dt >= 1 ? 1 : e * (1 + 0.25 * (1 - dt));
                                ctx.save();
                                ctx.translate(d.x, d.y);
                                ctx.scale(os, os);
                                ctx.fillStyle = pal.mid;
                                ctx.fill(d.body);
                                ctx.strokeStyle = pal.dark;
                                ctx.lineWidth = 0.022 * rockSz / os;
                                ctx.stroke(d.body);
                                ctx.fillStyle = pal.light;
                                ctx.fill(d.facet);
                                ctx.fillStyle = pal.core;
                                ctx.fill(d.core);
                                ctx.restore();
                                // the tick of light as it breaks the surface
                                if (dt < 0.4) {
                                    const fa = 1 - dt / 0.4;
                                    ctx.save();
                                    ctx.globalAlpha = baseA * fa;
                                    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
                                    ctx.lineWidth = 0.03 * rockSz * fa;
                                    ctx.beginPath();
                                    ctx.arc(d.x, d.y, d.r * (1.1 + 1.4 * (1 - fa)), 0, Math.PI * 2);
                                    ctx.stroke();
                                    ctx.restore();
                                }
                            }
                        }
                    } else {
                    // the layered cut: dark rim, mid body, light table, core
                    ctx.fillStyle = pal.mid;
                    ctx.fill(art.body);
                    ctx.strokeStyle = pal.dark;
                    ctx.lineWidth = 0.022 * rockSz;
                    ctx.stroke(art.body);
                    ctx.fillStyle = pal.light;
                    ctx.fill(art.facet);
                    ctx.fillStyle = pal.core;
                    ctx.fill(art.core);

                    
                    
                    
                    const kk = k & 0xffff;
                    const baseAlpha = ctx.globalAlpha;
                    for (let gi = 0; gi < art.glintPts.length; gi++) {
                        
                        const period = (tier === 4 ? 4500 : 9000) + this._h(gi, kk, 240) * (tier === 4 ? 3000 : 6000);
                        const phase  = this._h(gi, kk, 241) * period;
                        const tt = ((nowMs + phase) % period) / 520;
                        if (tt >= 1) continue;
                        const gp = art.glintPts[gi];
                        const ga = Math.sin(tt * Math.PI);
                        const gr2 = 0.05 * rockSz * ga;
                        const spin = tt * 0.9;
                        ctx.globalAlpha = baseAlpha * ga;
                        ctx.fillStyle = 'rgba(255,255,255,0.95)';
                        ctx.beginPath();
                        ctx.arc(gp[0], gp[1], gr2 * 0.45, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
                        ctx.lineWidth = gr2 * 0.32;
                        ctx.beginPath();
                        for (let a = 0; a < 4; a++) {
                            const ang = spin + a * Math.PI / 2;
                            const arm = gr2 * (a % 2 ? 1.6 : 2.6);
                            ctx.moveTo(gp[0], gp[1]);
                            ctx.lineTo(gp[0] + Math.cos(ang) * arm,
                                       gp[1] + Math.sin(ang) * arm);
                        }
                        ctx.stroke();
                        ctx.globalAlpha = baseAlpha;
                    }
                    }   
                    ctx.restore();
                }
                ctx.restore();
            }

            
            
            
            if (this._impacts.length || this._pebbles.length) {
                const CHIPC = ['rgb(5,4,7)', 'rgb(14,12,19)', 'rgb(26,23,33)'];
                ctx.save();
                for (let i = this._impacts.length - 1; i >= 0; i--) {
                    const im = this._impacts[i];
                    const dt = nowMs - im.born;
                    if (im.ticksOnly && dt >= 400) { this._impacts.splice(i, 1); continue; }
                    const tc = dt / 1800;
                    if (tc >= 1) { this._impacts.splice(i, 1); continue; }
                    const baseAng = Math.atan2(im.dy ?? 0, im.dx ?? 1);
                    // grind scrapes render at half scale with fewer chips
                    const isc = im.small ? 0.45 : 1;
                    
                    const ts = dt / 280;
                    if (!im.ticksOnly && ts < 1) {
                        ctx.fillStyle = `rgba(255,235,180,${(1 - ts) * (im.small ? 0.45 : 0.9)})`;
                        ctx.beginPath();
                        ctx.arc(im.x, im.y, 0.13 * rockSz * isc * (1 - ts * 0.6), 0, Math.PI * 2);
                        ctx.fill();
                    }
                    // rock hits are one-shot, no combo. skip grind scrapes.
                    if (!im.small) {
                        const tickT = dt / 400;
                        if (tickT < 1) {
                            const ha = (1 - tickT) * (1 - tickT) * 0.85;
                            const spread = (0.16 + 0.28 * tickT) * rockSz;
                            ctx.save();
                            ctx.globalAlpha = ha;
                            ctx.strokeStyle = "rgba(255,244,210,0.95)";
                            ctx.lineWidth = Math.max(0.035, 0.042 * rockSz);
                            ctx.lineCap = "round";
                            for (let k = 0; k < 4; k++) {
                                const ang = Math.PI / 4 + k * Math.PI / 2;
                                const ca = Math.cos(ang), sa = Math.sin(ang);
                                ctx.beginPath();
                                ctx.moveTo(im.x + ca * spread * 0.42, im.y + sa * spread * 0.42);
                                ctx.lineTo(im.x + ca * spread, im.y + sa * spread);
                                ctx.stroke();
                            }
                            ctx.restore();
                        }
                    }
                    if (im.ticksOnly) {
                        ctx.globalAlpha = 1;
                        continue;
                    }
                    // a good spray of rock chips: fly out fast off the rock
                    
                    const fly = Math.min(1, tc / 0.3);
                    const fe  = 1 - Math.pow(1 - fly, 3);
                    const al  = tc < 0.5 ? 0.9 : 0.9 * (1 - (tc - 0.5) / 0.5);
                    ctx.globalAlpha = al;
                    for (let s = 0; s < (im.small ? 5 : 12); s++) {
                        const ang = baseAng + (this._h(s, im.seed, 55) - 0.5) * 1.5;
                        const sp  = (0.2 + this._h(s, im.seed, 56) * 0.75) * rockSz * isc;
                        const sz  = (0.016 + this._h(s, im.seed, 57) * 0.028) * rockSz * (im.small ? 0.8 : 1);
                        ctx.save();
                        ctx.translate(im.x + Math.cos(ang) * fe * sp,
                                      im.y + Math.sin(ang) * fe * sp);
                        ctx.rotate(ang + fe * (this._h(s, im.seed, 58) - 0.5) * 8);
                        ctx.fillStyle = CHIPC[s % 3];
                        ctx.fillRect(-sz, -sz * 0.7, sz * 2, sz * 1.4);
                        ctx.restore();
                    }
                    ctx.globalAlpha = 1;
                }
                
                for (let i = this._pebbles.length - 1; i >= 0; i--) {
                    const pb = this._pebbles[i];
                    const tp = (nowMs - pb.born) / 1100;
                    if (tp >= 1) { this._pebbles.splice(i, 1); continue; }
                    const fe = 1 - Math.pow(1 - Math.min(1, tp / 0.35), 3);
                    const range = (0.35 + this._h(1, pb.seed, 61) * 0.45) * rockSz;
                    const sz = (0.018 + this._h(0, pb.seed, 60) * 0.022) * rockSz;
                    ctx.globalAlpha = tp < 0.4 ? 0.85 : 0.85 * (1 - (tp - 0.4) / 0.6);
                    ctx.fillStyle = CHIPC[pb.seed % 3];
                    ctx.fillRect(pb.x + pb.dx * fe * range - sz,
                                 pb.y + pb.dy * fe * range - sz, sz * 2, sz * 2);
                }
                ctx.globalAlpha = 1;
                ctx.restore();
            }

            // ── Shatter: brief flash + dust ring, then ~50 black rock chips
            
            if (this._fx.length) {
                const CHIPS = ['rgb(5,4,7)', 'rgb(14,12,19)', 'rgb(26,23,33)'];
                ctx.save();
                for (let i = this._fx.length - 1; i >= 0; i--) {
                    const fx = this._fx[i];
                    const t  = (nowMs - fx.born) / 620;
                    if (t < 0) continue;   // hit-stop: burst starts after the freeze
                    if (t >= 1) { this._fx.splice(i, 1); continue; }
                    const eo   = 1 - Math.pow(1 - t, 4);            
                    const fade = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
                    // hard white flash filling the rock's silhouette
                    if (t < 0.12) {
                        ctx.fillStyle = `rgba(240,232,250,${(1 - t / 0.12) * 0.9})`;
                        ctx.fill(fx.path);
                    }
                    // fast double dust ring
                    for (let rgi = 0; rgi < 2; rgi++) {
                        const rt = rgi === 0 ? t : (t - 0.07) / 0.93;
                        if (rt <= 0 || rt >= 1) continue;
                        const rq = 1 - Math.pow(1 - rt, 4);          // easeOutQuart
                        ctx.beginPath();
                        ctx.arc(fx.cx, fx.cy, (0.25 + (rgi ? 1.9 : 3.0) * rq) * rockSz, 0, Math.PI * 2);
                        ctx.strokeStyle = `rgba(110,100,125,${Math.pow(1 - rt, 1.5) * 0.6})`;
                        ctx.lineWidth   = 0.12 * rockSz * (1 - rt) + 0.01;
                        ctx.stroke();
                    }
                    // colored firework streaks flying out with the debris
                    if (fx.sparks) {
                        ctx.lineCap = 'round';
                        const pal = fx.colors || FW_COLORS;
                        for (const s of fx.sparks) {
                            const r2 = eo * s.sp * rockSz, r1 = r2 * 0.6;
                            const ca = Math.cos(s.ang), sa = Math.sin(s.ang);
                            ctx.strokeStyle = `rgba(${pal[s.ci]},${fade * 0.9})`;
                            ctx.lineWidth   = 0.028 * rockSz * (1 - t * 0.5);
                            ctx.beginPath();
                            ctx.moveTo(fx.cx + ca * r1, fx.cy + sa * r1);
                            ctx.lineTo(fx.cx + ca * r2, fx.cy + sa * r2);
                            ctx.stroke();
                        }
                    }
                    // black rock chips
                    ctx.globalAlpha = fade;
                    for (const p of fx.parts) {
                        const dist = eo * p.sp * rockSz;
                        const px = fx.cx + p.ox + Math.cos(p.ang) * dist;
                        const py = fx.cy + p.oy + Math.sin(p.ang) * dist;
                        const s  = p.size * rockSz * (1 - t * 0.6);
                        ctx.save();
                        ctx.translate(px, py);
                        ctx.rotate(p.ang + p.spin * eo);
                        ctx.fillStyle = CHIPS[p.shade];
                        ctx.fillRect(-s, -s * p.sq, s * 2, s * 2 * p.sq);
                        ctx.restore();
                    }
                    ctx.globalAlpha = 1;
                }
                ctx.restore();
            }
        } else {
            const order = [1, 2, 3, 0, 4, 5];
            const drawList = order.map(i => {
                const rock = this._lineRocks[pick[i]];
                return { rcx: cx + hex[i][0], rcy: cy + hex[i][1], G: rock.G, seed: rock.seed };
            });
            drawList.push({ rcx: cx, rcy: cy, G: centerG, isCenter: true });

            for (let idx = 0; idx < drawList.length; idx++) {
                const item = drawList[idx];
                ctx.save();
                for (let t = idx + 1; t < drawList.length; t++) {
                    const top = drawList[t];
                    ctx.beginPath();
                    ctx.rect(-1000, -1000, 2000, 2000);
                    this._rockOutlinePath(ctx, top.rcx, top.rcy, s, top.G);
                    ctx.clip('evenodd');
                }
                if (item.isCenter) {
                    this._drawSingleRock(ctx, item.rcx, item.rcy, s);
                } else {
                    this._drawRockFromGrid(ctx, item.rcx, item.rcy, s, item.G, item.seed);
                }
                ctx.restore();
            }
        }

        // ── Collision debug overlay ─────────────────────────────────────────
        // Toggle from the browser console:  terrainRenderer.debugCollision = true
        if (this.debugCollision) {
            const segs = this._buildVoronoiDebugSegs();
            ctx.save();
            ctx.strokeStyle = 'yellow';
            ctx.lineWidth   = 0.12 * (Math.min(this._cols, 120) / 50.0);
            ctx.lineCap     = 'butt';
            ctx.beginPath();
            for (const [ax, ay, bx, by] of segs) {
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
            }
            ctx.stroke();
            if (this._silClip) {
                ctx.strokeStyle = 'cyan';
                ctx.lineWidth   = 0.08 * (Math.min(this._cols, 120) / 50.0);
                ctx.stroke(this._silClip);
            }
            ctx.restore();
        }

        ctx.restore();
    }
}

window.terrainRenderer = new TerrainRenderer();
