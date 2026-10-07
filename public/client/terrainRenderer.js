// Rock lattice size is Math.min(cols, 120) / 50 EVERYWHERE (here, the GLSL
// uniform below, and server terrainGrid.js). The clamp keeps rocks the same
// world size on wide maps (the tutorial's multi-plot room). Keep all mirrors
// identical.
import { config } from "./config.js";
import { global } from "./global.js";
import { gameSound } from "./sound.js";

const CELL_BASALT = 0;
const CELL_EMPTY  = 1;

// mirrors server terrainGrid.js REGROW.GROW_MS / START_SCALE
const GROW_MS      = 16000;  
const GROW_SCALE0  = 0.15;   
const GROW_ORE_MS  = 1200;   
const GROW_GEN_STRIDE = 7919;
const growEase = (p) => p * p * (3 - 2 * p);
// A rise runs at g.rate from g.at, where it was g.e0 ms in (server
// terrainGrid.riseElapsed); the server re-anchors it (r:3) when a tank near
// the rock slows it down.
const riseElapsed = (g, nowMs) => g.e0 + (nowMs - g.at) * g.rate;
const riseRate = (s) => (Number.isFinite(s) && s > 0 ? Math.min(64, s) : 1);

const FW_COLORS = ['164,14,14', '230,80,0', '230,119,0', '47,127,51', '23,78,166', '123,31,163'];
const FW_CSS = FW_COLORS.map(c => 'rgb(' + c + ')');
// a rock break's burst (see _spawnShatter)
const SHATTER_CHIPS = 70, SHATTER_SPARKS_MAX = 56, SHATTER_MAX = 40;
// Rock biomes (shared/rockBiomes.js). The tones of every lattice cell live in
// one RGBA texture the shader reads at the rock's seed: BIO_N x BIO_N cells
// (lattice -8..119, like the seed texture), BIO_T texels across per cell
// (ink, dark, face, light, rim, gem; the rim texel's alpha is its strength,
// the ink texel's the seam glow, the gem texel's how much vein it holds).
const BIO_N = 128;
const BIO_T = 6;
const BIO_B = 21;   // bytes per cell in the tone tables (DWBiomes.TONE_BYTES)
const BIO_RIM = 4, BIO_GEM = 5;   // the rim and gem texels
const BASE_TILE_SUBCELLS = 8;
// Full-resolution rock (a real GPU): shaded at the screen's own pixels and
// drawn 1:1, so seams and facets stay sharp on a retina screen too. The image
// is a set of HD_T square tiles on a grid fixed to the world, each its own
// ImageBitmap shaded with a 1 pixel apron (so a tile drawn scaled samples its
// neighbour's pixels at its edge). Tiles are shaded a few a frame, inside
// HD_BUDGET_MS, and drawn from the frame after (a bitmap drawn the frame it
// was shaded waits on the GPU); only a tile the view needs right now is
// shaded on the spot.
const HD_T = 512, HD_TA = HD_T + 2;
const HD_BUDGET_MS = 2, HD_MAX_BG = 2;
// more missing tiles than this on screen at once (a teleport, a dive): a
// half-density layer instead, sharpened in the background
const HD_URGENT_MAX = 8;
// shade ahead this far past the view (image pixels), drop past twice that
const HD_AHEAD = 128;
// How close the zoom must be to the one a layer was shaded for to draw it
// 1:1: at 2e-4 the far edge of a 4K screen is off by under half a pixel.
const HD_SNAP = 2e-4;
// the ore gem's feathered halo: stroke widths (per rockSz), outermost last
const ORE_HALO = [0.011, 0.026, 0.041, 0.056, 0.07, 0.085];
const hdKey = (i, j) => (i + 4096) * 8192 + (j + 4096);

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

    static ORE_FX_CSS = Object.fromEntries(Object.entries(TerrainRenderer.ORE_FX || {}).map(([k, v]) => [k, v.map(c => 'rgb(' + c + ')')]));

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

    // Rock look (cartoon boulders, see the voronoi shader). The shader and
    // the no-WebGL fallback share these tones; keep them in step.
    static ROCK_INK  = 'rgb(16,13,22)';
    // the three facet tones (shadowed / main / lit), see the shader
    static ROCK_DARK  = 'rgb(29,26,38)';
    static ROCK_FACE  = 'rgb(43,39,55)';
    static ROCK_LIGHT = 'rgb(61,55,77)';
    static ROCK_CHIP = ['rgb(16,13,22)', 'rgb(29,26,38)', 'rgb(43,39,55)'];
    // silhouette stroke (tile units per rockSz): drawn under the rock and
    // dropped a hair, so the outline is only faintly heavier on the bottom
    static SIL_W    = 0.12;
    static SIL_DROP = 0.012;

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
        this._blankFrames = 0;
        // Lattice polygons, keyed by rock key. Depends only on the map, so it
        // survives every silhouette rebuild - see _buildVoronoiBoundary.
        this._voroLattice = null;
        // rock biome colours (null = the classic rock everywhere), the cells
        // whose look changed since the cached rock image was shaded, and
        // whether the GPU copy of the tones is behind
        this._bio        = null;
        this._bioPatch   = new Set();
        this._bioUpload  = false;
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

    init(cells, cols, rows, rockState, oreState, oreSalt, biomeSeed = 0) {
        // The lattice polygons come only from the cell grid (and cost ~250 ms
        // to make), so a resync of the same grid keeps them. Everything built
        // from rock state (silhouette, texture, caches) is made again.
        const old = this._cells;
        let sameGrid = !!old && this._voroLattice && this._cols === cols && this._rows === rows && old.length === cells.length;
        for (let i = 0; sameGrid && i < cells.length; i++) if (old[i] !== cells[i]) sameGrid = false;
        this._cols  = cols;
        this._rows  = rows;
        this._cells = new Uint8Array(cells);
        this._lineRocks = null;
        if (!sameGrid) {
            this._voroLattice = null;
            this._cellPolys.clear();
        }
        this._silClip = null;
        this._debugVoronoiSegs = null;
        this._blankFrames = 0;
        this._rockMiss = 0;
        this._silStale = 0;
        this.inits = (this.inits | 0) + 1;
        this._glChecks = 0;            // check the shader's output again
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
        this._dropRockImage();
        const nowInit = performance.now();
        if (rockState) for (const ev of rockState) {
            this._rockHealth.set(ev.k, ev.h);
            if (ev.d) this._rockDead.add(ev.k);
            if (ev.gen) this._gen.set(ev.k, ev.gen);
            // joined mid-rise: resume the growth animation where the server is
            if (ev.r !== undefined) {
                if (ev.r < GROW_MS) {
                    this._growing.set(ev.k, { at: nowInit, e0: ev.r, rate: riseRate(ev.s),
                                              tier: ev.o | 0,
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
        this._orePk = null;
        this._oreSalt = oreSalt | 0;
        if (oreState) for (const [k, tier] of oreState) {
            if (!this._rockDead.has(k)) this._ore.set(k, tier);
        }

        for (const [k, g] of this._growing) {
            if (g.tier) this._ore.set(k, g.tier);
        }
        this._setBiomes(biomeSeed | 0, cols, rows);
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

    // A last-stage rock's tremble. On the full-resolution path it moves by
    // whole device pixels and keeps its size, so it stays a sharp copy of
    // the tiles (scaled 1.05 it was resampled: the soft look of a cracked
    // rock); the old image path keeps the slight swell.
    _shakeXform(ctx, cell, nowMs) {
        const [ox, oy] = this._trembleOf(cell.k, nowMs);
        if (this._shakeHd) {
            ctx.translate(Math.round(ox * this._devPxX) / this._devPxX, Math.round(oy * this._devPxY) / this._devPxY);
            return;
        }
        ctx.translate(cell.cx + ox, cell.cy + oy);
        ctx.scale(1.05, 1.05);
        ctx.translate(-cell.cx, -cell.cy);
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

    // Shake only for rocks breaking within 800 units of the player; shaking
    // for anything on screen reads as the view randomly shifting. No hit-stop
    // here: mining breaks rocks several times a second and each freeze read
    // as lag.
    _shakeNearCell(cell, amount, duration, delay = 0) {
        const w = this._world;
        if (!cell || !w) return;
        const wx = cell.cx * w.s - w.hw, wy = cell.cy * w.s - w.hh;
        const dx = wx - global.player.renderx, dy = wy - global.player.rendery;
        if (dx * dx + dy * dy > 800 * 800) return;
        this._shake(amount, duration, delay);
    }

    applyRockEvents(events) {
        if (!this.ready || !events) return;
        const now = performance.now();
        let rebuilt = false;
        if (events.length) this._damageDirty = true;
        for (const ev of events) {
            // ── THE LIVING WALL ──
            // A rising cell stays in _rockDead while it grows, so everything
            // that treats it as a hole (silhouette, damage batch, ore markings,
            // both maps) still does; the growth is drawn as a layer on top and
            // rejoins the rock when it lands.
            if (ev.r === 1) {
                // regrow implies the server considers this cell DEAD; mark it
                // dead here too in case a destroy event was missed
                if (!this._rockDead.has(ev.k)) {
                    this._rockDead.add(ev.k);
                    this.mapDirty = true;
                    rebuilt = true;
                }
                // ev.e: the server's rise is already this far along (ms)
                const riseE = Number.isFinite(ev.e) ? Math.max(-GROW_MS, Math.min(GROW_MS, ev.e)) : 0;
                this._beginGrowth(ev.k, ev.o | 0, ev.gen | 0, now, ev.ax, ev.ay, riseE, riseRate(ev.s));
                continue;
            }
            // the rise changed pace (a tank came near it or left): pick it up
            // from where the server says it is
            if (ev.r === 3) {
                const g = this._growing.get(ev.k);
                if (g) {
                    g.e0 = Number.isFinite(ev.e) ? Math.max(-GROW_MS, Math.min(GROW_MS, ev.e)) : riseElapsed(g, now);
                    g.at = now;
                    g.rate = riseRate(ev.s);
                }
                continue;
            }
            if (ev.r === 2) { this._finishGrowth(ev.k, now); continue; }
            if (ev.e === 1) { this._revealOre(ev.k, 4, now); continue; }
            // bloom / raid twist: an alive rock changes ore tier in place
            if (ev.bl === 1) {
                if (ev.ore) this._revealOre(ev.k, ev.ore | 0, now);
                else { this._ore.delete(ev.k); this._veinCache.delete(ev.k); this._sproutArt.delete(ev.k); this._oreSprout.delete(ev.k); this._oreLook(ev.k); }
                if (typeof ev.h === "number") this._rockHealth.set(ev.k, ev.h);
                this._damageDirty = true;
                continue;
            }
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
                    this._oreLook(ev.k);
                    if (onscreen) this._shakeNearCell(cell, tier ? 5 : 4, 240, delay);
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
                    if (cell) this._shakeNearCell(cell, 2, 140);
                }
                if (ev.x !== undefined) {
                    if (this._world) {
                        const w = this._world;
                        gameSound.rockHit(ev.x * w.s - w.hw, ev.y * w.s - w.hh,
                                          this._stageOf(ev.h), !!ev.g, this._ore.get(ev.k) || 0);
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
                                         // chips in the hit rock's tones
                                         chips: this._bio ? this._bioChips(ev.k) : null,
                                         seed: (ev.k + Math.round(ev.x * 97) + (ev.g ? (now | 0) : 0)) & 0xffff });
                    if (this._impacts.length > 16) this._impacts.shift();
                }
            }
        }
        if (rebuilt) {
            // Deferred: one silhouette rebuild per burst, from draw(). The
            // shatter effect covers the gap.
            this._debugVoronoiSegs = null;
            this._landed.clear();
            const nowR = performance.now();
            this._silRebuildAt = this._silRebuildAt ? Math.min(this._silRebuildAt, nowR + 40) : nowR + 40;
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

    // ── Extra cells: things that are not rocks but must crack and break
    // exactly like one (ore chests). They live in tile space under negative
    // keys so they never collide with lattice keys, and the net / crack /
    // bite caches work on them unchanged.
    _cellFor(k) {
        return this._cellPolys.get(k) || (this._extraCells ? this._extraCells.get(k) : undefined);
    }
    registerCell(k, cell) {
        if (!this._extraCells) this._extraCells = new Map();
        if (this._extraCells.has(k)) this.dropCell(k);
        this._extraCells.set(k, cell);
    }
    dropCell(k) {
        if (this._extraCells) this._extraCells.delete(k);
        for (let st = 0; st <= 6; st++) { this._crackCache.delete(k + ':' + st); if (this._pockCache) this._pockCache.delete(k + ':' + st); }
        if (this._fracCache) this._fracCache.delete(k);
        if (this._biteCache) this._biteCache.delete(k);
        this._hitFlash.delete(k); this._crackSnap.delete(k);
    }
    worldToTile(wx, wy) {
        const w = this._world;
        if (!w) return null;
        return { x: (wx + w.hw) / w.s, y: (wy + w.hh) / w.s, s: w.s };
    }
    // A rock-style break at a world point: the same chips, sparks, flash,
    // dust and shake a rock cell gets, sized to a radius in world units.
    shatterAt(wx, wy, rUnits, tier = 0, delay = 0, k = 0) {
        const t = this.worldToTile(wx, wy);
        if (!t || !this.ready) return false;
        const rt = rUnits / t.s;
        const poly = [];
        for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; poly.push([t.x + Math.cos(a) * rt, t.y + Math.sin(a) * rt]); }
        const path = new Path2D();
        poly.forEach((pt, i) => i ? path.lineTo(pt[0], pt[1]) : path.moveTo(pt[0], pt[1]));
        path.closePath();
        const cell = { k: k | 0, cx: t.x, cy: t.y, poly, path };
        const now = performance.now();
        this._spawnShatter(cell, now + delay, tier | 0);
        this._shakeNearCell(cell, tier ? 5 : 4, 240, delay);
        return true;
    }
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

    // e0: ms into the rise it already is (negative: starts later); rate: its pace
    _beginGrowth(k, tier, gen, now, ax, ay, e0 = 0, rate = 1) {
        const cell = this._cellPolys.get(k);
        if (!(Number.isFinite(ax) && Number.isFinite(ay))) {
            ax = cell ? cell.cx : 0; ay = cell ? cell.cy : 0;
        }
        this._growing.set(k, { at: now, e0, rate, tier, gen, ax, ay, mapped: false });
        now -= e0;
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
        this._oreLook(k);
        this._damageDirty = true;

        if (cell && this._onScreen(cell.cx, cell.cy) && this._pebbles.length < 70) {
            const kk = k & 0xffff, chips = this._bio ? this._bioChips(k) : null;
            for (let i = 0; i < 7; i++) {
                const a = this._h(i, kk, 170) * Math.PI * 2;
                const rr = (0.2 + this._h(i, kk, 171) * 0.4) * (Math.min(this._cols, 120) / 50.0);
                this._pebbles.push({
                    x: ax + Math.cos(a) * rr,
                    y: ay + Math.sin(a) * rr,
                    // inward: the ground is being drawn INTO the rising rock
                    dx: -Math.cos(a) * 0.5, dy: -Math.sin(a) * 0.5,
                    born: now, seed: (kk + i * 53) & 0xffff,
                    chips,
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
            this._oreLook(k);
        }
        const cell = this._cellPolys.get(k);
        if (cell && this._onScreen(cell.cx, cell.cy)) {
            this._growFx.push({ k, born: now });
            if (this._growFx.length > 24) this._growFx.shift();
            this._shakeNearCell(cell, 3, 160);

            const kk = k & 0xffff, chips = this._bio ? this._bioChips(k) : null;
            for (let i = 0; i < 12 && this._pebbles.length < 80; i++) {
                const a = (i / 12) * Math.PI * 2 + this._h(i, kk, 172);
                this._pebbles.push({
                    x: cell.cx + Math.cos(a) * 0.4, y: cell.cy + Math.sin(a) * 0.4,
                    dx: Math.cos(a), dy: Math.sin(a),
                    born: now, seed: (kk + i * 91) & 0xffff,
                    chips,
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
        this._oreLook(k);
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
        if (onscreen) this._shakeNearCell(cell, 4, 220, delay);
    }

    _revealOre(k, tier, now) {
        this._ore.set(k, tier);
        this._oreLook(k);
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

    // A rock breaks: a hard flash in its outline, a double dust ring, a
    // spray of chips in its own colours and coloured streaks (the ore's when
    // it held ore). Full strength again (70 chips, 24-56 streaks, as before
    // the Sep 15 trim); the records are pooled and drawn in a few batched
    // paths, so a burst allocates nothing per frame.
    _spawnShatter(cell, now, tier = 0) {
        const { cx, cy } = cell;
        const kk = cell.k & 0xffff;
        const jc = (i, s) => this._h(i, kk, s);
        const pool = this._fxPool || (this._fxPool = []);
        let fx = null;
        if (this._fx.length >= SHATTER_MAX) fx = this._fx.shift();
        else fx = pool.pop() || { parts: new Float32Array(SHATTER_CHIPS * 8), sparks: new Float32Array(SHATTER_SPARKS_MAX * 3) };
        // chips: angle, speed, size, shade, spin, squash, offset x, y
        const P = fx.parts;
        for (let e = 0; e < SHATTER_CHIPS; e++) {
            const o = e * 8;
            P[o]     = jc(e, 28) * Math.PI * 2;
            P[o + 1] = 0.7 + jc(e, 29) * 3.6;
            P[o + 2] = 0.018 + jc(e, 30) * 0.04;
            P[o + 3] = Math.floor(jc(e, 31) * 3);
            P[o + 4] = (jc(e, 32) - 0.5) * 14;
            P[o + 5] = 0.5 + jc(e, 33) * 0.5;
            P[o + 6] = (jc(e, 34) - 0.5) * 1.1;
            P[o + 7] = (jc(e, 35) - 0.5) * 1.1;
        }
        const palette = TerrainRenderer.ORE_FX_CSS[tier] || FW_CSS;
        const nSparks = tier ? (tier === 4 ? 56 : tier === 3 ? 44 : 32) : 24;
        const S = fx.sparks;
        for (let e = 0; e < nSparks; e++) {
            S[e * 3]     = jc(e, 36) * Math.PI * 2;
            S[e * 3 + 1] = 1.2 + jc(e, 37) * 3.4;
            S[e * 3 + 2] = Math.floor(jc(e, 38) * palette.length);
        }
        fx.nSparks = nSparks;
        fx.colors = palette;
        fx.cx = cx; fx.cy = cy; fx.path = cell.path;
        fx.born = now ?? performance.now();
        // chips in this rock's biome tones (null: the classic ones)
        fx.chips = this._bio ? this._bioChips(cell.k) : null;
        this._fx.push(fx);
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

    // Sub-Voronoi crack skeleton: a fine Voronoi diagram of up to 40
    // deterministic seeds inside the cell, cached per rock key.
    _getRockNet(k) {
        let net = this._fracCache.get(k);
        if (net !== undefined) return net;
        const cell = this._cellFor(k);
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
        const cell = this._cellFor(k);
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
        const cell = this._cellFor(k);
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
            // the big crystal sits at the rock's roomiest spot (the point
            // farthest from its edge: a coarse grid, then a finer one round
            // the best) and is never wider than that room allows, so it
            // stays inside the rock with a margin. Mirrored in
            // server/game/terrain/terrainGrid.js depositLayout.
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

    // The gem outlines of every live ore rock in and round the view, as one
    // path. Made again only when ore or rocks
    // change or the view leaves the box they were made for.
    _orePockets(tlx, tly, tlw, tlh) {
        let P = this._orePk;
        if (P && P.ver === (this._oreVer | 0) && P.dead === this._rockDead.size && P.size === this._ore.size &&
            tlx >= P.x0 && tly >= P.y0 && tlx + tlw <= P.x1 && tly + tlh <= P.y1) return P;
        const mx = tlw * 0.5, my = tlh * 0.5;
        P = this._orePk = { ver: this._oreVer | 0, dead: this._rockDead.size, size: this._ore.size,
                            x0: tlx - mx, y0: tly - my, x1: tlx + tlw + mx, y1: tly + tlh + my,
                            body: new Path2D(), n: 0 };
        this._ore.forEach((tier, k) => {
            if (this._rockDead.has(k)) return;
            const cell = this._cellPolys.get(k);
            if (!cell || cell.cx < P.x0 - 3 || cell.cx > P.x1 + 3 || cell.cy < P.y0 - 3 || cell.cy > P.y1 + 3) return;
            const art = this._getVeinArt(k, tier);
            if (!art) return;
            P.body.addPath(art.body);
            P.n++;
        });
        return P;
    }
    _getVeinArt(k, tier) {
        let art = this._veinCache.get(k);
        if (art !== undefined) return art;
        const cell = this._cellPolys.get(k);
        if (!cell) { this._veinCache.set(k, null); return null; }
        const { poly, cx, cy } = cell;
        const kk = k & 0xffff;
        const rockSz = Math.min(this._cols, 120) / 50.0;
        // Same salt-mixed hash closure the server builds in _buildDeposits.
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

        // Lattice polygons depend only on (cols, rows, hash), never on which
        // rocks are alive, so they are built once per map (clipping ~10k cells
        // against 24 neighbours is expensive). A rebuild only re-reads
        // _rockDead. init() clears the cache.
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
                    // The neighbour across each edge never changes either, so
                    // it is resolved once; a rebuild then does a per-edge
                    // "is my neighbour alive" test instead of a 24-site search.
                    const nb = new Array(poly.length);
                    for (let e = 0; e < poly.length; e++) {
                        const [vax, vay] = poly[e], [vbx, vby] = poly[(e+1)%poly.length];
                        const emx = (vax+vbx)/2, emy = (vay+vby)/2;
                        const edx = vbx-vax, edy = vby-vay;
                        const elen = Math.hypot(edx, edy);
                        if (elen < 1e-6) { nb[e] = key; continue; }   // degenerate edge: never a boundary
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
                        nb[e] = nVi * 100003 + nVj;
                    }
                    lattice.set(key, {
                        poly, sx, sy, nb,
                        cell: { k: key, poly: tilePoly, cx: pcx, cy: pcy, path: tilePath },
                    });
                }
            }
        }

        if (this._cellPolys.size !== lattice.size)
            for (const [key, L] of lattice) this._cellPolys.set(key, L.cell);

        // The silhouette: every edge between a live cell and a dead (or
        // missing) one, chained into loops. This runs on every rock change
        // (throttled), so it works on numbers only: the vertex keys come
        // precomputed with the lattice, the chains go into reused typed
        // arrays, and nothing but the Path2D is allocated (the string keys
        // and per-edge arrays it used to make were a GC hitch on busy maps).
        const dead = this._rockDead;
        const SNAP = 1000, KX = 1e6;
        const B = this._silBuf || (this._silBuf = { n: 0, cap: 0, xy: null, ka: null, kb: null, used: null, head: new Map(), link: null, end: null });
        const ensure = (need) => {
            if (B.cap >= need) return;
            let cap = Math.max(1024, B.cap * 2); while (cap < need) cap *= 2;
            const xy = new Float64Array(cap * 4), ka = new Float64Array(cap), kb = new Float64Array(cap);
            if (B.xy) { xy.set(B.xy); ka.set(B.ka); kb.set(B.kb); }
            B.xy = xy; B.ka = ka; B.kb = kb; B.used = new Uint8Array(cap);
            B.link = new Int32Array(cap * 2); B.end = new Int32Array(cap * 2);
            B.cap = cap;
        };
        let n = 0;
        for (const [key, L] of lattice) {
            if (dead.has(key)) continue;
            const poly = L.poly, nb = L.nb;
            if (!L.vk) {
                // per vertex: tile coords and the snapped key (once per map)
                L.vk = new Float64Array(poly.length);
                L.vt = new Float64Array(poly.length * 2);
                for (let e = 0; e < poly.length; e++) {
                    const x = poly[e][0] * rockSz, y = poly[e][1] * rockSz;
                    L.vt[e * 2] = x; L.vt[e * 2 + 1] = y;
                    L.vk[e] = Math.round(x * SNAP) * KX + Math.round(y * SNAP);
                }
            }
            for (let e = 0; e < poly.length; e++) {
                const nk = nb[e];
                if (nk === key) continue;
                if (!dead.has(nk) && lattice.has(nk)) continue;      // solid on both sides
                const f = (e + 1) % poly.length;
                ensure(n + 1);
                B.xy[n * 4] = L.vt[e * 2]; B.xy[n * 4 + 1] = L.vt[e * 2 + 1];
                B.xy[n * 4 + 2] = L.vt[f * 2]; B.xy[n * 4 + 3] = L.vt[f * 2 + 1];
                B.ka[n] = L.vk[e]; B.kb[n] = L.vk[f];
                n++;
            }
        }
        // vertex -> its edge ends, as linked lists in typed arrays (end k:
        // edge k >> 1, the far vertex is a when k is odd, else b)
        const head = B.head; head.clear();
        for (let i = 0; i < n; i++) {
            B.used[i] = 0;
            for (let side = 0; side < 2; side++) {
                const k = side ? B.kb[i] : B.ka[i], slot = i * 2 + side;
                const h = head.get(k);
                B.link[slot] = h === undefined ? -1 : h;
                head.set(k, slot);
            }
        }
        // the far end of an edge end, and the next unused edge at a vertex
        const nextAt = (k) => {
            for (let s = head.get(k); s !== undefined && s >= 0; s = B.link[s]) if (!B.used[s >> 1]) return s;
            return -1;
        };
        const path = new Path2D();
        const back = this._silBack || (this._silBack = []);
        for (let i = 0; i < n; i++) {
            if (B.used[i]) continue;
            B.used[i] = 1;
            const k0 = B.ka[i];
            // walk forward from b, collecting points straight into the path
            // after the backward part (walked first, kept in `back`)
            back.length = 0;
            let cur = k0;
            for (;;) {
                const s = nextAt(cur);
                if (s < 0) break;
                const ei = s >> 1, fromA = !(s & 1);
                B.used[ei] = 1;
                // from vertex `cur` along the edge to its other end
                const ox = fromA ? B.xy[ei * 4 + 2] : B.xy[ei * 4], oy = fromA ? B.xy[ei * 4 + 3] : B.xy[ei * 4 + 1];
                back.push(ox, oy);
                cur = fromA ? B.kb[ei] : B.ka[ei];
            }
            const pts = back.length / 2 + 2;
            let forward = 0;
            // the backward chain, farthest first, then a, b and onwards
            const startIdx = back.length;
            if (startIdx) path.moveTo(back[startIdx - 2], back[startIdx - 1]);
            for (let q = startIdx - 4; q >= 0; q -= 2) path.lineTo(back[q], back[q + 1]);
            if (startIdx) path.lineTo(B.xy[i * 4], B.xy[i * 4 + 1]); else path.moveTo(B.xy[i * 4], B.xy[i * 4 + 1]);
            path.lineTo(B.xy[i * 4 + 2], B.xy[i * 4 + 3]);
            cur = B.kb[i];
            for (;;) {
                if (cur === k0) break;
                const s = nextAt(cur);
                if (s < 0) break;
                const ei = s >> 1, fromA = !(s & 1);
                B.used[ei] = 1;
                const ox = fromA ? B.xy[ei * 4 + 2] : B.xy[ei * 4], oy = fromA ? B.xy[ei * 4 + 3] : B.xy[ei * 4 + 1];
                cur = fromA ? B.kb[ei] : B.ka[ei];
                if (cur === k0) break;
                path.lineTo(ox, oy);
                forward++;
            }
            if (pts + forward >= 3) path.closePath();
        }
        this._silEdges = n;
        this._silDeadN = dead.size;
        return path;
    }

    // The rock shader's context. Any failure here (no WebGL, a context lost
    // on the way in, a shader that won't link) leaves this._gl null and the
    // rocks draw as flat facets; it must never stop init() from finishing,
    // or the whole rock layer stays empty for the session.
    _buildNoiseTile() {
        this._noiseTileBuilding = true;
        try { this._buildNoiseTileGl(); }
        catch (e) { this._dropGl('shader setup failed: ' + (e && e.message)); }
        this._noiseTile = true;
        this._noiseTileBuilding = false;
    }

    // ── Rock biomes ──
    // Every lattice cell's four tones, worked out once per map from the
    // shared biome function (same seed and lattice as the server, so nothing
    // per rock is sent). The shader reads them at each rock's seed, so the
    // colour lives in the cached rock image and costs nothing per frame.
    _setBiomes(seed, cols, rows) {
        const B = typeof window !== 'undefined' ? window.DWBiomes : null;
        this._bioPatch.clear();
        if (!seed || !B) { this._bio = null; this._bioUpload = true; return; }
        let bio = this._bio;
        if (!bio || bio.seed !== seed || bio.cols !== cols || bio.rows !== rows) {
            // only the lattice the map has (plus a cell round it): texels
            // past it are never read, a shader sample there is off the map
            const rs = Math.min(cols, 120) / 50;
            const i1 = Math.min(BIO_N - 1, Math.ceil(cols / rs) + 9), j1 = Math.min(BIO_N - 1, Math.ceil(rows / rs) + 9);
            bio = { seed, cols, rows, i0: 7, j0: 7, i1, j1,
                    base: new Uint8Array(BIO_N * BIO_N * BIO_B),  // plain rock tones per cell
                    dom:  new Int8Array(BIO_N * BIO_N).fill(-1),  // its main biome
                    tex:  new Uint8Array(BIO_N * BIO_T * BIO_N * 4),  // what the shader reads
                    css:  new Map() };
            const w = new Array(B.N);
            for (let j = bio.j0; j <= j1; j++) {
                for (let i = bio.i0; i <= i1; i++) {
                    const c = j * BIO_N + i;
                    B.rockTones(i - 8, j - 8, cols, rows, seed, bio.base, c * BIO_B, 0);
                    B.rockWeights(i - 8, j - 8, cols, rows, seed, w);
                    bio.dom[c] = B.dominant(w);
                }
            }
            this._bio = bio;
        }
        bio.css.clear();
        for (let j = bio.j0; j <= bio.j1; j++) {
            for (let i = bio.i0; i <= bio.i1; i++) this._bioPaint(i, j, this._ore.get((i - 8) * 100003 + (j - 8)) | 0);
        }
        this._bioUpload = true;
    }
    // Write one cell's tones into the shader texture (its deeper ore look,
    // veins in the ore's colour, when it holds ore: ore is its tier). True
    // when anything changed.
    _bioPaint(i, j, ore) {
        const bio = this._bio, tex = bio.tex;
        let src = bio.base, b = (j * BIO_N + i) * BIO_B;
        if (ore) {
            // the ore rock's matrix tone for this ore (rockBiomes deepen)
            const B = window.DWBiomes, sc = this._bioScratch || (this._bioScratch = new Uint8Array(BIO_B));
            B.deepen(bio.base, b, sc, 0, ore);
            B.oreGem(sc, 0, ore);
            src = sc; b = 0;
        }
        const o = (j * BIO_N * BIO_T + i * BIO_T) * 4;
        let changed = false;
        for (let q = 0; q < BIO_T; q++) {
            for (let ch = 0; ch < 3; ch++) {
                const v = src[b + q * 3 + ch], at = o + q * 4 + ch;
                if (tex[at] !== v) { tex[at] = v; changed = true; }
            }
            // alpha: the rim texel's is the rim strength, the ink texel's
            // the seam glow, the gem texel's the veins, the rest 255
            const a = q === BIO_RIM ? src[b + BIO_T * 3] : q === 0 ? src[b + BIO_T * 3 + 1] : q === BIO_GEM ? src[b + BIO_T * 3 + 2] : 255;
            if (tex[o + q * 4 + 3] !== a) { tex[o + q * 4 + 3] = a; changed = true; }
        }
        return changed;
    }
    // A rock got or lost its ore: repaint its cell, and the cached image
    // next frame (just that rock, see _patchBio).
    _oreLook(k) {
        this._oreVer = (this._oreVer | 0) + 1;
        const bio = this._bio;
        if (!bio) return;
        const vi = Math.floor(k / 100003), vj = k - vi * 100003;
        const i = vi + 8, j = vj + 8;
        if (i < 0 || j < 0 || i >= BIO_N || j >= BIO_N) return;
        if (!this._bioPaint(i, j, this._ore.get(k) | 0)) return;
        bio.css.delete(k);
        this._bioUpload = true;
        this._bioPatch.add(k);
    }
    // This rock's tones as css [ink, dark, face, light, rim, gem], cached
    // per rock; c.rimA is the rim's strength (0-1), c.glowA the seam
    // glow's, c.veinA the veins'.
    _bioCss(k) {
        const bio = this._bio;
        if (!bio) return null;
        let c = bio.css.get(k);
        if (c) return c;
        const vi = Math.floor(k / 100003), vj = k - vi * 100003;
        const i = Math.max(0, Math.min(BIO_N - 1, vi + 8)), j = Math.max(0, Math.min(BIO_N - 1, vj + 8));
        const o = (j * BIO_N * BIO_T + i * BIO_T) * 4, t = bio.tex;
        c = [];
        for (let q = 0; q < BIO_T; q++) c.push('rgb(' + t[o + q * 4] + ',' + t[o + q * 4 + 1] + ',' + t[o + q * 4 + 2] + ')');
        c.rimA = t[o + BIO_RIM * 4 + 3] / 255;
        c.glowA = t[o + 3] / 255;
        c.veinA = t[o + BIO_GEM * 4 + 3] / 255;
        bio.css.set(k, c);
        return c;
    }
    // A rock's crack colours: { base (css), deep, hot, hair ('r,g,b') }. An
    // ore rock's crack shows its ore's colours; a plain one cracks in its own
    // biome's tones, deeper (dark teal in the crystal, red-black in the
    // magma, deep brown in the sandstone) with a hairline of its lit tone
    // along it. The classic rock keeps the classic crack.
    _crackPal(k) {
        const tier = this._ore.get(k) | 0;
        const classic = TerrainRenderer.CRACK_PAL[tier] || TerrainRenderer.CRACK_PAL[0];
        if (tier || !this._bio) return classic;
        const c = this._bioCss(k);
        if (!c) return classic;
        if (!c.crack) {
            const bio = this._bio, vi = Math.floor(k / 100003), vj = k - vi * 100003;
            const i = Math.max(0, Math.min(BIO_N - 1, vi + 8)), j = Math.max(0, Math.min(BIO_N - 1, vj + 8));
            const o = (j * BIO_N * BIO_T + i * BIO_T) * 4, t = bio.tex;
            const tone = (q, k2) => Math.round(t[o + q * 4] * k2) + ',' + Math.round(t[o + q * 4 + 1] * k2) + ',' + Math.round(t[o + q * 4 + 2] * k2);
            c.crack = { base: 'rgba(' + tone(0, 0.62) + ',0.85)', deep: tone(1, 0.72), hot: tone(0, 0.42), hair: tone(3, 1.1) };
        }
        return c.crack;
    }
    // The ink a worn or bitten rock darkens toward: its own seam colour, or
    // the classic ink without biomes.
    _inkOf(k) {
        const c = this._bio ? this._bioCss(k) : null;
        return c ? c[0] : TerrainRenderer.ROCK_INK;
    }
    // Chips for a rock (a shatter, a hit, a regrow), or null for the classic
    // ones: its seam ink, its lit face and its bright edge colour, so some
    // read against the floor and some against the rock round it.
    _bioChips(k) {
        const c = this._bioCss(k);
        return c ? (c.chips || (c.chips = [c[0], c[3], c[4]])) : null;
    }
    // The main biome index of a rock (shared/rockBiomes.js BIOMES), -1 when
    // the map has none. The minimap colours by it.
    biomeOf(k) {
        const bio = this._bio;
        if (!bio) return -1;
        const vi = Math.floor(k / 100003), vj = k - vi * 100003;
        const i = vi + 8, j = vj + 8;
        if (i < 0 || j < 0 || i >= BIO_N || j >= BIO_N) return -1;
        return bio.dom[j * BIO_N + i];
    }
    // Point the shader at the tones (uploading them when they changed).
    // Called before every shading pass; with no biomes it only sets u_bioOn 0.
    _bioUniforms(gl) {
        if (!this._glBioOnU) return;
        const bio = this._bio;
        if (!bio) { gl.uniform1f(this._glBioOnU, 0); return; }
        if (this._bioUpload) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this._glBioTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, BIO_N * BIO_T, BIO_N, 0, gl.RGBA, gl.UNSIGNED_BYTE, bio.tex);
            gl.activeTexture(gl.TEXTURE0);
            this._bioUpload = false;
        }
        gl.uniform1f(this._glBioOnU, 1);
    }
    // Re-shade just the rocks whose look changed (ore came or went) inside
    // the cached image: a scissored shader pass per rock and a copy of that
    // patch, or the flat facets again without WebGL. Only on a frame where a
    // rock changed, and a handful of rocks at most. A GPU build's image is a
    // bitmap, which can't be drawn into: the first patch after a build copies
    // it to a canvas once (measured as cheap to draw every frame as the
    // bitmap), later ones only touch their own rocks.
    _patchBio(c) {
        const keys = this._bioPatch;
        if (c && c.hd) { this._hdMarkStale(keys); return; }
        const img = c && c.img;
        const isCanvas = !!img && typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement;
        const isBitmap = !!img && typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap;
        if (!keys.size || !(isCanvas || isBitmap)) { keys.clear(); return; }
        const rockSz = Math.min(this._cols, 120) / 50.0, pad = 0.2 * rockSz;
        // each changed rock's box in an image's pixels
        const rectsIn = (c) => {
            const d = c.density, dY = d * c.ratioY, pw = c.img.width, ph = c.img.height;
            const rects = [];
            keys.forEach((k) => {
                const cell = this._cellPolys.get(k);
                if (!cell) return;
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (const p of cell.poly) {
                    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
                    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
                }
                const px0 = Math.max(0, Math.floor((x0 - pad - c.x) * d)), px1 = Math.min(pw, Math.ceil((x1 + pad - c.x) * d));
                const py0 = Math.max(0, Math.floor((y0 - pad - c.y) * dY)), py1 = Math.min(ph, Math.ceil((y1 + pad - c.y) * dY));
                if (px1 > px0 && py1 > py0) rects.push([px0, py0, px1 - px0, py1 - py0]);
            });
            return rects;
        };
        const d = c.density, dY = d * c.ratioY, pw = img.width, ph = img.height;
        const rects = rectsIn(c);
        keys.clear();
        if (!rects.length) return;
        let out = img;
        if (isBitmap) {
            out = this._bioCanvas || (this._bioCanvas = document.createElement('canvas'));
            if (out.width !== pw || out.height !== ph) { out.width = pw; out.height = ph; }
            const g0 = out.getContext('2d');
            g0.globalCompositeOperation = 'copy';
            g0.drawImage(img, 0, 0);
            g0.globalCompositeOperation = 'source-over';
            c.img = out;
            img.close();
        }
        const g = out.getContext('2d');
        if (this._gl && !this._gl.isContextLost()) {
            try {
                const gl = this._gl, glc = this._glCanvas;
                if (glc.width !== pw || glc.height !== ph) { glc.width = pw; glc.height = ph; }
                gl.viewport(0, 0, pw, ph);
                gl.uniform2f(this._glOriginU, -c.x * d, -c.y * dY);
                gl.uniform2f(this._glCellSzU, d, dY);
                gl.uniform1f(this._glShU, ph);
                gl.uniform1f(this._glRockSzU, rockSz);
                this._bioUniforms(gl);
                gl.enable(gl.SCISSOR_TEST);
                for (const [x, y, w, h] of rects) {
                    gl.scissor(x, ph - y - h, w, h);
                    gl.drawArrays(gl.TRIANGLES, 0, 6);
                }
                gl.disable(gl.SCISSOR_TEST);
                for (const [x, y, w, h] of rects) g.drawImage(glc, x, y, w, h, x, y, w, h);
            } catch (e) {
                this._dropGl(e && e.message);
            }
            return;
        }
        g.save();
        g.setTransform(d, 0, 0, dY, -c.x * d, -c.y * dY);
        for (const [x, y, w, h] of rects) {
            const tx = c.x + x / d, ty = c.y + y / dY, tw = w / d, th = h / dY;
            g.save();
            g.beginPath();
            g.rect(tx, ty, tw, th);
            g.clip();
            // from the same base as a full build, so seams aren't inked twice
            g.fillStyle = TerrainRenderer.ROCK_FACE;
            g.fillRect(tx, ty, tw, th);
            this._drawFlatCells(g, tx, ty, tw, th);
            g.restore();
        }
        g.restore();
    }
    // No WebGL: flat facets from the same lattice polygons, so rocks still
    // match the collision geometry. g is already in tile coordinates.
    _drawFlatCells(g, x, y, w, h) {
        const TR = TerrainRenderer;
        const rockSz = Math.min(this._cols, 120) / 50.0;
        // same facets as the shader: per cell a lit and a shadowed
        // wedge (141deg each) meeting at the seed, main tone between
        const WA = Math.acos(1 / 3), R = 3 * rockSz;
        const wedge = (ox, oy, a0) => {
            g.beginPath();
            g.moveTo(ox, oy);
            for (const da of [-WA, 0, WA]) g.lineTo(ox + Math.cos(a0 + da) * R, oy + Math.sin(a0 + da) * R);
            g.closePath();
            g.fill();
        };
        g.strokeStyle = TR.ROCK_INK;
        g.lineWidth = 0.056 * rockSz;
        g.lineJoin = 'round';
        for (const cell of this._cellPolys.values()) {
            if (cell.cx < x - 3 || cell.cx > x + w + 3 || cell.cy < y - 3 || cell.cy > y + h + 3) continue;
            const bc = this._bio ? this._bioCss(cell.k) : null;
            g.save();
            g.clip(cell.path);
            g.fillStyle = bc ? bc[2] : TR.ROCK_FACE;
            g.fill(cell.path);
            const vi = Math.floor(cell.k / 100003), vj = cell.k - vi * 100003;
            const [hx, hy] = this._vh2(vi, vj);
            const ox = (vi + hx) * rockSz, oy = (vj + hy) * rockSz;
            const la = (hx - 0.5) * 0.8;
            const up = Math.atan2(-Math.cos(la), Math.sin(la));   // ldir
            g.fillStyle = bc ? bc[3] : TR.ROCK_LIGHT; wedge(ox, oy, up + Math.PI);
            g.fillStyle = bc ? bc[1] : TR.ROCK_DARK;  wedge(ox, oy, up);
            g.restore();
            if (bc) g.strokeStyle = bc[0];
            g.stroke(cell.path);
        }
    }

    // Back to the flat facets (and a fresh texture) when the GPU side fails.
    _dropGl(why) {
        if (this._gl && !this._glWarned) { this._glWarned = true; console.warn('Rock shader off:', why); }
        this._gl = null;
        this._glCanvas = null;
        this._rockQuality = null;
        this._dropRockImage();
        this._glChecks = 0;
    }
    // Forget the cached rock image (and any sharper one being shaded),
    // giving its memory back now.
    _dropRockImage() {
        const c = this._rockCache;
        if (c && c.img && !c.hd && typeof c.img.close === 'function') c.img.close();
        this._rockCache = null;
        this._dropHd();
    }
    _dropHd() {
        this._hdDropLayer(this._hdLayer);
        this._hdDropLayer(this._hdNext);
        this._hdLayer = this._hdNext = null;
        this._hdUni = null;
        if (this._rockCache && this._rockCache.hd) this._rockCache = null;
    }

    _buildNoiseTileGl() {
        let canvas, gl;
        // One full-screen quad, no geometry edges and no depth: multisampling
        // and a depth buffer only cost memory here (the defaults gave the
        // GPU process ~300 MB extra at 1080p for a 19 MB image).
        const lean = { antialias: false, depth: false, stencil: false, alpha: true };
        if (typeof OffscreenCanvas !== 'undefined') {
            try {
                canvas = new OffscreenCanvas(1, 1);
                gl = canvas.getContext('webgl', lean);
            } catch(e) { gl = null; }
        }
        if (!gl) {
            canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const keep = { ...lean, preserveDrawingBuffer: true, premultipliedAlpha: false };
            gl = canvas.getContext('webgl', keep) || canvas.getContext('experimental-webgl', keep);
        }
        if (!gl || gl.isContextLost()) { this._gl = null; return; }

        const VS = `attribute vec2 a_pos;
	                void main(){gl_Position=vec4(a_pos,0.,1.);}`;

        const FS = `precision highp float;
            uniform vec2  u_origin;
            uniform vec2  u_cellSz;
            uniform float u_sh;
            uniform float u_rockSz;
            uniform sampler2D u_seeds;
            // rock biomes: each lattice cell's ink/dark/face/light/rim/gem,
            // 6 texels across per cell (u_bioOn 0 = the classic tones below)
            uniform float u_bioOn;
            uniform sampler2D u_bio;

            // Surface grain only (never geometry): a cheap value noise in
            // world space, so it lands the same in every cached tile and
            // costs nothing per frame. Float quirks here only move a speck.
            float hs(vec2 q){
                vec3 p3=fract(vec3(q.xyx)*.1031);
                p3+=dot(p3,p3.yzx+33.33);
                return fract((p3.x+p3.y)*p3.z);
            }
            float vn(vec2 q){
                vec2 i=floor(q), u=fract(q);
                u=u*u*(3.-2.*u);
                return mix(mix(hs(i),hs(i+vec2(1.,0.)),u.x),
                           mix(hs(i+vec2(0.,1.)),hs(i+vec2(1.,1.)),u.x),u.y);
            }

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

                // Faceted boulder, style only (cell shapes untouched): the
                // original rock's three flat facets meeting at the seed, lit
                // from a per-cell direction, on the calm palette, with one
                // clean ink line. bd = plain edge distance (ink line).
                float bd=8.;
                for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
                    vec2 g=mg+vec2(float(i),float(j));
                    vec2 r=g+hash2(n+g)-f;
                    if(dot(mr-r,mr-r)>1e-4)
                        bd=min(bd,dot(.5*(mr+r),normalize(r-mr)));
                }
                float nl=length(mr);
                vec2 lh=hash2(n+mg);
                float la=(lh.x-.5)*.8;
                vec2 ldir=vec2(sin(la),-cos(la));
                // signed facet coordinate scaled to distance so the facet
                // seams anti-alias over one texel like the ink does
                float lt=dot(mr,ldir);
                vec3 inkC  =vec3(16.,13.,22.)/255.;
                vec3 darkC =vec3(29.,26.,38.)/255.;
                vec3 faceC =vec3(43.,39.,55.)/255.;
                vec3 lightC=vec3(61.,55.,77.)/255.;
                vec4 rimC=vec4(0.);
                vec4 gemC=vec4(0.);
                float glowA=0.;
                if(u_bioOn>.5){
                    // this rock's own tones, read at its seed cell: one
                    // colour per rock, the blend between biomes is baked in
                    vec2 bc=n+mg+vec2(8.);
                    float bx=bc.x*6.+.5, by=(bc.y+.5)/128.;
                    vec4 inkT=texture2D(u_bio,vec2(bx/768.,by));
                    inkC  =inkT.rgb;
                    glowA =inkT.a;
                    darkC =texture2D(u_bio,vec2((bx+1.)/768.,by)).rgb;
                    faceC =texture2D(u_bio,vec2((bx+2.)/768.,by)).rgb;
                    lightC=texture2D(u_bio,vec2((bx+3.)/768.,by)).rgb;
                    rimC  =texture2D(u_bio,vec2((bx+4.)/768.,by));
                    gemC  =texture2D(u_bio,vec2((bx+5.)/768.,by));
                }
                const float INK=.028;
                float aa=.6/(u_cellSz.x*u_rockSz);
                vec3 col=darkC;
                col=mix(col,faceC, smoothstep(-aa,aa,lt+nl/3.));
                col=mix(col,lightC,smoothstep(-aa,aa,lt-nl/3.));
                // e: how far inside the seam's ink line, lit: 1 on the side
                // of the rock the light catches
                float e=bd-INK;
                float lit=smoothstep(-.2,.2,lt);
                // Stone, not plastic (the pre-biome rock's weight, on the
                // biome colours): a mottled surface with a fine grain, each
                // rock its own (offset by its seed, so it breaks at seams)
                vec2 gq=(n+mg+f)+lh*31.;
                float mot=vn(gq*6.)*.62+vn(gq*12.7+5.3)*.38;
                float grn=vn(gq*41.)*.6+vn(gq*83.+2.1)*.4;
                col*=.91+.15*mot+(grn-.5)*.11;
                // a chiselled bevel just inside the seam: the edge facing
                // the light catches it (in the biome's rim tone), the far
                // edge drops into shade
                float bev=1.-smoothstep(0.,.07,e);
                col=mix(col,max(col,rimC.rgb*.85),bev*lit*(.25+.5*rimC.a));
                col*=1.+bev*(.14*lit-.24*(1.-lit));
                // and the faces round off into the seams, darker edges
                float ao=1.-smoothstep(0.,.17,e);
                col*=1.-.22*ao*ao*(1.-.45*lit);
                col=mix(col,inkC,1.-smoothstep(INK-aa,INK+aa,bd));
                gl_FragColor=vec4(col,1.);
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
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this._gl = null; return; }
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

        // biome tones on unit 1: a 1x1 stand-in until a map with biomes
        // comes, never read while u_bioOn is 0
        const bioTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, bioTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_bio'), 1);
        this._glBioTex  = bioTex;
        this._glBioOnU  = gl.getUniformLocation(prog, 'u_bioOn');
        gl.uniform1f(this._glBioOnU, 0);
        this._bioUpload = true;   // a new context has none of it yet

        this._glCanvas  = canvas;
        this._gl        = gl;
        this._glChecks  = 0;
        this._glOriginU = gl.getUniformLocation(prog, 'u_origin');
        this._glCellSzU = gl.getUniformLocation(prog, 'u_cellSz');
        this._glShU     = gl.getUniformLocation(prog, 'u_sh');
        this._glRockSzU = gl.getUniformLocation(prog, 'u_rockSz');
        // A GPU reset, or the browser's cap on live contexts, can take it
        // away mid-raid: flat facets until it is back, then the shader again.
        if (canvas.addEventListener) {
            canvas.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                if (this._gl === gl) this._dropGl('context lost');
            });
            canvas.addEventListener('webglcontextrestored', () => {
                if (!this._gl) this._buildNoiseTile();
            });
        }
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

    // The rock texture depends only on world position (the shader has no time
    // input), so it is rendered once into an image a bit larger than the
    // screen and reused while panning. Per-frame shading is far too slow on
    // software WebGL (~220ms at 1080p). Returns the image and the cell-space
    // rect it covers.
    _rockTexture(view, cellW, cellH, S = 1) {
        const q0 = this._rockQuality ?? (this._rockQuality = this._detectRockQuality());
        const simple = config.graphical.simpleTerrain;
        // A real GPU shades at the screen's own pixels: S of them per unit the
        // caller draws in (the HUD scale; ~2 on a retina screen). Software
        // WebGL, no WebGL and "Simple Terrain" (half the shading) keep the
        // cheaper density they always had, and so does "Fewer Effects": a 1:1
        // image on a retina screen reads 4x the texels every frame, so the
        // slow-machine ladder (fewerFx, then simpleTerrain) takes it back.
        const hd = !!this._gl && q0 >= 1 && !simple && typeof this._glCanvas.transferToImageBitmap === 'function';
        const want = cellW * q0 * (simple ? 0.5 : 1) * (hd && !config.graphical.fewerEffects ? S : 1);
        // The sky drop dives from ~0.4x to 1x in a second or so, and every
        // zoom step re-shaded the whole (7x bigger) view. While it dives the
        // image may be up to 2.5x coarser than asked, so one build carries
        // the dive; landing at 1x is back inside the normal range.
        const diving = global.dropZoom !== undefined && global.dropZoom !== 1 && window.dwDropOpt !== false;
        if (!hd && (this._hdLayer || this._hdNext)) this._dropHd();
        // how many frames the zoom has held still
        const st = this._hdWant || (this._hdWant = { want: 0, n: 0 });
        if (Math.abs(want - st.want) > want * 1e-5) { st.want = want; st.n = 0; } else st.n++;
        if (hd) {
            if (this._gl.isContextLost()) this._dropGl('context lost');
            else {
                try {
                    // last frame's ore changes: those tiles go stale
                    if (this._bioPatch.size) this._hdMarkStale(this._bioPatch);
                    return this._rockCache = this._hdUpdate(view, want, cellH / cellW, st.n >= 8 && !diving, diving);
                } catch (e) {
                    this._dropGl(e && e.message);
                }
            }
            return this._rockTexture(view, cellW, cellH, S);   // the GPU side failed: flat facets
        }
        const c = this._rockCache;
        // compared on the density asked for, not the one built: a big screen
        // or a wide view caps the texture below `want`, and comparing that
        // would re-shade it every frame
        const same = c && c.cols === this._cols && !c.hd &&
            (diving ? c.want > want * 0.4 && c.want < want * 3 : c.want > want * 0.8 && c.want < want * 1.25);
        if (same && view.tlx >= c.x && view.tly >= c.y &&
            view.tlx + view.tlw <= c.x + c.w && view.tly + view.tlh <= c.y + c.h) {
            // Close to an edge: slide the image along now, while the strip to
            // shade is still thin, instead of re-shading all of it later.
            const e = c.m * 0.5;
            if (!c.pw || (view.tlx - c.x > e && view.tly - c.y > e &&
                c.x + c.w - view.tlx - view.tlw > e && c.y + c.h - view.tly - view.tlh > e)) return c;
            return this._slideRockTexture(c, view) || c;
        }
        if (same && c.pw) {
            const slid = this._slideRockTexture(c, view);
            if (slid) return slid;
        }

        // margin so ordinary panning stays inside the cache for a while
        const m = Math.max(view.tlw, view.tlh) * 0.2;
        const x = view.tlx - m, y = view.tly - m, w = view.tlw + m * 2, h = view.tlh + m * 2;
        const ratioY = cellH / cellW;
        // the dive's wide view is ~7x the area, under haze and moving fast:
        // half the density there is a quarter of the shading (a full-size
        // build was 0.5-1.5 s on a busy GPU); landing makes the sharp one
        let density = diving ? want * 0.5 : want;
        const maxDim = 4096;
        if (w * density > maxDim) density = maxDim / w;
        if (h * density * ratioY > maxDim) density = maxDim / (h * ratioY);
        const pw = Math.max(1, Math.ceil(w * density)), ph = Math.max(1, Math.ceil(h * density * ratioY));
        if (!isFinite(pw) || !isFinite(ph) || pw > maxDim + 1 || ph > maxDim + 1) return c || null;
        let img = null;
        // a full shade has every rock's current look, nothing left to patch
        this._bioPatch.clear();

        if (this._gl && this._gl.isContextLost()) this._dropGl('context lost');
        if (this._gl) {
            try {
                const gl = this._gl, glc = this._glCanvas;
                if (glc.width !== pw || glc.height !== ph) { glc.width = pw; glc.height = ph; }
                gl.viewport(0, 0, pw, ph);
                gl.uniform2f(this._glOriginU, -x * density, -y * density * ratioY);
                gl.uniform2f(this._glCellSzU, density, density * ratioY);
                gl.uniform1f(this._glShU, ph);
                gl.uniform1f(this._glRockSzU, Math.min(this._cols, 120) / 50.0);
                this._bioUniforms(gl);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                // the shader writes opaque rock everywhere: a see-through
                // pixel in the first few builds (of a context, or since the
                // last map sync) means it drew nothing. Not every build:
                // readPixels waits on the GPU.
                if ((this._glChecks | 0) < 3) {
                    this._glChecks = (this._glChecks | 0) + 1;
                    const px = this._glProbe || (this._glProbe = new Uint8Array(4));
                    gl.readPixels(pw >> 1, ph >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    if (px[3] === 0) throw new Error('blank shader output');
                }
                if (typeof glc.transferToImageBitmap === 'function') img = glc.transferToImageBitmap();
                else {
                    const out = (c && c.canvas) || document.createElement('canvas');
                    out.width = pw; out.height = ph;
                    out.getContext('2d').drawImage(glc, 0, 0);
                    img = out;
                }
            } catch (e) {
                this._dropGl(e && e.message);
                img = null;
            }
        }
        if (!img) {
            // No WebGL: flat facets from the same lattice polygons, so rocks
            // still match the collision geometry.
            const out = (c && c.canvas) || document.createElement('canvas');
            out.width = pw; out.height = ph;
            const g = out.getContext('2d');
            g.fillStyle = TerrainRenderer.ROCK_FACE;
            g.fillRect(0, 0, pw, ph);
            g.setTransform(density, 0, 0, density * ratioY, -x * density, -y * density * ratioY);
            this._drawFlatCells(g, x, y, w, h);
            img = out;
        }
        const prev = this._rockCache;
        if (prev && prev.img && prev.img !== img && typeof prev.img.close === 'function') prev.img.close();
        this._rockCache = { img, canvas: img instanceof HTMLCanvasElement ? img : null,
                            x, y, w: pw / density, h: ph / (density * ratioY), density, want, cols: this._cols,
                            // pw is only set where sliding pays: software GL, where
                            // shading is slow (a GPU re-shades the lot in no time)
                            m, ratioY, pw: this._gl && this._rockQuality < 1 ? pw : 0, ph };
        return this._rockCache;
    }

    // ── Full-resolution rock (a real GPU): tiles, see HD_T ──
    // A layer: one density's tiles. this._hdLayer is drawn; this._hdNext is
    // a sharper one being shaded in the background, which takes over once
    // every tile the view needs is in.
    _hdNewLayer(d, ratioY, want, full) {
        return { hd: true, img: true, tiles: new Map(), d, dY: d * ratioY, ratioY, want, full, cols: this._cols,
                 i0: 0, j0: 0, i1: -1, j1: -1 };
    }
    _hdDropLayer(L) {
        if (!L) return;
        L.tiles.forEach((t) => { t.bm.close(); if (t.nb) t.nb.close(); });
        L.tiles.clear();
    }
    // Shade tile (i, j) of layer L into a new bitmap.
    _hdShadeTile(L, i, j) {
        const gl = this._gl, glc = this._glCanvas;
        if (glc.width !== HD_TA || glc.height !== HD_TA) { glc.width = HD_TA; glc.height = HD_TA; }
        if (this._hdUni !== L) {
            gl.uniform2f(this._glCellSzU, L.d, L.dY);
            gl.uniform1f(this._glShU, HD_TA);
            gl.uniform1f(this._glRockSzU, Math.min(this._cols, 120) / 50.0);
            this._hdUni = L;
        }
        this._bioUniforms(gl);
        gl.viewport(0, 0, HD_TA, HD_TA);
        // pixel (0, 0) of the tile is world pixel (i * HD_T - 1, j * HD_T - 1)
        gl.uniform2f(this._glOriginU, 1 - i * HD_T, 1 - j * HD_T);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        // the shader writes opaque rock everywhere: a see-through pixel in
        // the first few tiles of a context means it drew nothing
        if ((this._glChecks | 0) < 3) {
            this._glChecks = (this._glChecks | 0) + 1;
            const pr = this._glProbe || (this._glProbe = new Uint8Array(4));
            gl.readPixels(HD_TA >> 1, HD_TA >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pr);
            if (pr[3] === 0) throw new Error('blank shader output');
        }
        this._hdShaded = (this._hdShaded | 0) + 1;
        return glc.transferToImageBitmap();
    }
    // The tile range of layer L the view needs (grown by pad image pixels).
    _hdRange(L, view, pad, out) {
        out[0] = Math.floor((view.tlx * L.d - pad) / HD_T);
        out[1] = Math.floor((view.tly * L.dY - pad) / HD_T);
        out[2] = Math.floor(((view.tlx + view.tlw) * L.d + pad) / HD_T);
        out[3] = Math.floor(((view.tly + view.tlh) * L.dY + pad) / HD_T);
        return out;
    }
    // Background work for this frame: shade missing or stale tiles of L in
    // range r, nearest the view's middle first, until the budget is spent.
    // Returns false when it ran out before finishing.
    _hdFill(L, r, t0, frame) {
        const ci = (r[0] + r[2]) / 2, cj = (r[1] + r[3]) / 2;
        for (;;) {
            if (this._hdBg >= HD_MAX_BG || performance.now() - t0 > HD_BUDGET_MS) return false;
            let bi = 0, bj = 0, best = Infinity;
            for (let j = r[1]; j <= r[3]; j++) {
                for (let i = r[0]; i <= r[2]; i++) {
                    const t = L.tiles.get(hdKey(i, j));
                    if (t && !t.dirty) continue;
                    const dd = (i - ci) * (i - ci) + (j - cj) * (j - cj);
                    if (dd < best) { best = dd; bi = i; bj = j; }
                }
            }
            if (best === Infinity) return true;
            const ta = performance.now();
            const bm = this._hdShadeTile(L, bi, bj);
            this._hdBg++;
            // the GPU is behind (the call blocked): leave it be for a few
            // frames rather than pile more on
            if (performance.now() - ta > 4) { this._hdCool = frame + 4; this._hdBg = HD_MAX_BG; }
            const t = L.tiles.get(hdKey(bi, bj));
            // in from next frame; a stale tile keeps its old look till then
            if (t) { if (t.nb) t.nb.close(); t.nb = bm; t.nbAt = frame + 1; t.dirty = false; }
            else L.tiles.set(hdKey(bi, bj), { bm, at: frame + 1, nb: null, nbAt: 0, dirty: false });
        }
    }
    // Drop tiles of L outside range r.
    _hdEvict(L, r) {
        L.tiles.forEach((t, k) => {
            const i = Math.floor(k / 8192) - 4096, j = k % 8192 - 4096;
            if (i < r[0] || i > r[2] || j < r[1] || j > r[3]) { t.bm.close(); if (t.nb) t.nb.close(); L.tiles.delete(k); }
        });
    }
    // Every tile of L in range r drawable this frame?
    _hdReady(L, r, frame) {
        for (let j = r[1]; j <= r[3]; j++) {
            for (let i = r[0]; i <= r[2]; i++) {
                const t = L.tiles.get(hdKey(i, j));
                if (!t || t.at > frame) return false;
            }
        }
        return true;
    }
    // The frame's work. Returns the layer to draw.
    _hdUpdate(view, want, ratioY, stable, diving) {
        const frame = this._hdFrame = (this._hdFrame | 0) + 1;
        const r = this._hdR || (this._hdR = [0, 0, 0, 0]);
        let L = this._hdLayer;
        // a layer far denser than needed (the view widened a lot: a dive)
        // would need too many tiles: start a coarse one. A denser layer that still has every tile on screen stays up while
        // the right one is shaded behind it (a lower resolution step, Fewer
        // Effects, a zoom out): dropping it first showed a half-density
        // stand-in, the whole screen going grainy for a moment.
        if (L && L.d > want * 1.5 && L.cols === this._cols && L.ratioY === ratioY && !diving) {
            this._hdRange(L, view, 0, r);
            let have = 0, n = 0;
            for (let j = r[1]; j <= r[3]; j++) for (let i = r[0]; i <= r[2]; i++) { n++; if (L.tiles.has(hdKey(i, j))) have++; }
            L.keep = n - have <= HD_URGENT_MAX && n <= 96;
        } else if (L) L.keep = false;
        if (L && (L.cols !== this._cols || L.ratioY !== ratioY || (L.d > want * 1.5 && !L.keep))) { this._hdDropLayer(L); L = null; }
        if (!L) L = this._hdLayer = this._hdNewLayer(stable ? want : want * 0.5, ratioY, want, stable);
        // stale tiles' new looks come in, now they are ready
        L.tiles.forEach((t) => { if (t.nb && t.nbAt <= frame) { t.bm.close(); t.bm = t.nb; t.nb = null; } });
        // every tile on screen must be there: shade the missing ones now, or
        // if there are many, switch to a coarse layer (a quarter the tiles)
        this._hdRange(L, view, 0, r);
        let missing = 0;
        for (let j = r[1]; j <= r[3]; j++) for (let i = r[0]; i <= r[2]; i++) if (!L.tiles.has(hdKey(i, j))) missing++;
        if (missing > HD_URGENT_MAX && L.full && !L.keep) {
            this._hdDropLayer(L);
            this._hdDropLayer(this._hdNext); this._hdNext = null;
            L = this._hdLayer = this._hdNewLayer(want * 0.5, ratioY, want, false);
            this._hdRange(L, view, 0, r);
        }
        for (let j = r[1]; j <= r[3]; j++) {
            for (let i = r[0]; i <= r[2]; i++) {
                const t = L.tiles.get(hdKey(i, j));
                if (!t) L.tiles.set(hdKey(i, j), { bm: this._hdShadeTile(L, i, j), at: frame, nb: null, nbAt: 0, dirty: false });
                else if (t.at > frame) t.at = frame;   // needed now: draw it (waits on the GPU, rarely)
            }
        }
        L.i0 = r[0]; L.j0 = r[1]; L.i1 = r[2]; L.j1 = r[3];
        // A sharper layer, once the zoom holds still on one this layer
        // wasn't shaded for (or this is a coarse one). Dropped if the zoom
        // moves again before it is done.
        const sharp = L.full && Math.abs(L.want / want - 1) < HD_SNAP;
        let N = this._hdNext;
        // (a kept denser layer: the replacement starts at once, zoom moving or not)
        if (N && L.keep && !stable && Math.abs(N.want / want - 1) < 0.25) { /* keep filling it */ }
        else if (N && (sharp || !stable || Math.abs(N.want / want - 1) >= HD_SNAP || N.ratioY !== ratioY || N.cols !== this._cols)) { this._hdDropLayer(N); N = this._hdNext = null; }
        if (!N && !sharp && (stable || L.keep)) N = this._hdNext = this._hdNewLayer(want, ratioY, want, true);
        // background shading, inside the frame's budget
        const t0 = performance.now();
        this._hdBg = frame < (this._hdCool | 0) ? HD_MAX_BG : 0;
        if (N) {
            this._hdRange(N, view, 0, r);
            const done = this._hdFill(N, r, t0, frame);
            if (done && this._hdReady(N, r, frame)) {
                // it takes over
                this._hdDropLayer(L);
                L = this._hdLayer = N;
                this._hdNext = null;
                L.i0 = r[0]; L.j0 = r[1]; L.i1 = r[2]; L.j1 = r[3];
                this._hdSwaps = (this._hdSwaps | 0) + 1;
            } else {
                this._hdRange(N, view, HD_AHEAD * 2, r);
                this._hdEvict(N, r);
            }
        }
        // then the tiles just past the view, and stale ones (an ore change)
        this._hdRange(L, view, HD_AHEAD, r);
        this._hdFill(L, r, t0, frame);
        this._hdRange(L, view, HD_AHEAD * 2, r);
        this._hdEvict(L, r);
        return L;
    }
    // Rocks whose look changed (ore came or went): their tiles go stale and
    // are shaded again in the background, a few a frame.
    _hdMarkStale(keys) {
        const rockSz = Math.min(this._cols, 120) / 50.0, pad = 0.2 * rockSz;
        for (const L of [this._hdLayer, this._hdNext]) {
            if (!L) continue;
            keys.forEach((k) => {
                const cell = this._cellPolys.get(k);
                if (!cell) return;
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (const p of cell.poly) {
                    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
                    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
                }
                const i0 = Math.floor(((x0 - pad) * L.d - 1) / HD_T), i1 = Math.floor(((x1 + pad) * L.d + 1) / HD_T);
                const j0 = Math.floor(((y0 - pad) * L.dY - 1) / HD_T), j1 = Math.floor(((y1 + pad) * L.dY + 1) / HD_T);
                for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                    const t = L.tiles.get(hdKey(i, j));
                    if (t) t.dirty = true;
                }
            });
        }
        keys.clear();
    }
    // Draw layer L's tiles that touch tile-space box [x0, x1] x [y0, y1] (the
    // view by default). The context is in tile units: origin (ox, oy),
    // cellW x cellH per tile, S device pixels per unit. Tile edges land on
    // whole device pixels, so tiles meet without a seam, and at 1:1 every
    // tile is a straight copy.
    _hdDraw(ctx, L, ox, oy, cellW, cellH, S, x0, y0, x1, y1) {
        const kx = S * cellW / L.d, ky = S * cellH / L.dY;      // device px per image px
        const bx = S * ox, by = S * oy;                        // device position of world pixel 0
        let i0 = L.i0, j0 = L.j0, i1 = L.i1, j1 = L.j1;
        if (x0 !== undefined) {
            i0 = Math.max(i0, Math.floor(x0 * L.d / HD_T)); i1 = Math.min(i1, Math.floor(x1 * L.d / HD_T));
            j0 = Math.max(j0, Math.floor(y0 * L.dY / HD_T)); j1 = Math.min(j1, Math.floor(y1 * L.dY / HD_T));
        }
        const one = Math.abs(kx - 1) < HD_SNAP && Math.abs(ky - 1) < HD_SNAP;
        const rbx = Math.round(bx), rby = Math.round(by);
        const frame = this._hdFrame | 0;
        for (let j = j0; j <= j1; j++) {
            const Y0 = one ? rby + j * HD_T : Math.round(by + j * HD_T * ky), Y1 = one ? Y0 + HD_T : Math.round(by + (j + 1) * HD_T * ky);
            if (Y1 <= Y0) continue;
            for (let i = i0; i <= i1; i++) {
                const t = L.tiles.get(hdKey(i, j));
                if (!t || t.at > frame) continue;
                const X0 = one ? rbx + i * HD_T : Math.round(bx + i * HD_T * kx), X1 = one ? X0 + HD_T : Math.round(bx + (i + 1) * HD_T * kx);
                if (X1 <= X0) continue;
                ctx.drawImage(t.bm, 1, 1, HD_T, HD_T, (X0 / S - ox) / cellW, (Y0 / S - oy) / cellH, (X1 - X0) / S / cellW, (Y1 - Y0) / S / cellH);
            }
        }
    }
    // Image pixels [ix0, iy0, w, h] of layer L as one small flat canvas
    // (for a rock drawn scaled: a trembling or rising one).
    _hdCompose(L, ix0, iy0, w, h) {
        const tmp = this._hdTmp || (this._hdTmp = document.createElement('canvas'));
        if (tmp.width < w || tmp.height < h) { tmp.width = Math.max(tmp.width, w); tmp.height = Math.max(tmp.height, h); }
        const g = tmp.getContext('2d');
        const frame = this._hdFrame | 0;
        for (let j = Math.floor(iy0 / HD_T); j * HD_T < iy0 + h; j++) {
            for (let i = Math.floor(ix0 / HD_T); i * HD_T < ix0 + w; i++) {
                const t = L.tiles.get(hdKey(i, j));
                if (!t || t.at > frame) continue;
                const sx = Math.max(ix0, i * HD_T), sy = Math.max(iy0, j * HD_T);
                const ex = Math.min(ix0 + w, (i + 1) * HD_T), ey = Math.min(iy0 + h, (j + 1) * HD_T);
                g.drawImage(t.bm, sx - i * HD_T + 1, sy - j * HD_T + 1, ex - sx, ey - sy, sx - ix0, sy - iy0, ex - sx, ey - sy);
            }
        }
        return tmp;
    }
    // A rock's box of the layer, drawn into the (scaled) context in tile units.
    _hdDrawCell(ctx, L, cell) {
        const pad = 0.4 * Math.min(this._cols, 120) / 50.0;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of cell.poly) {
            if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        }
        const ix0 = Math.floor((x0 - pad) * L.d), iy0 = Math.floor((y0 - pad) * L.dY);
        const w = Math.ceil((x1 + pad) * L.d) - ix0, h = Math.ceil((y1 + pad) * L.dY) - iy0;
        if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return;
        const tmp = this._hdCompose(L, ix0, iy0, w, h);
        ctx.drawImage(tmp, 0, 0, w, h, ix0 / L.d, iy0 / L.dY, w / L.d, h / L.dY);
    }

    // Software GL only. Re-centre the cached rock image on the view by whole
    // pixels: the part still in range is copied across and the shader only
    // runs over the uncovered edge strips. Same pixels as a full render at
    // that origin.
    _slideRockTexture(c, view) {
        const gl = this._gl, glc = this._glCanvas;
        if (!gl || !c.img) return null;
        const d = c.density, dY = d * c.ratioY, pw = c.pw, ph = c.ph;
        const dx = Math.round((view.tlx + view.tlw / 2 - c.w / 2 - c.x) * d);
        const dy = Math.round((view.tly + view.tlh / 2 - c.h / 2 - c.y) * dY);
        if (!dx && !dy) return null;
        if (Math.abs(dx) >= pw || Math.abs(dy) >= ph) return null;
        const x = c.x + dx / d, y = c.y + dy / dY;
        if (view.tlx < x || view.tly < y || view.tlx + view.tlw > x + c.w || view.tly + view.tlh > y + c.h) return null;

        const pair = this._rockSlide || (this._rockSlide = [document.createElement('canvas'), document.createElement('canvas')]);
        const out = c.img === pair[0] ? pair[1] : pair[0];
        if (out.width !== pw || out.height !== ph) { out.width = pw; out.height = ph; }
        const g = out.getContext('2d');
        g.clearRect(0, 0, pw, ph);
        g.drawImage(c.img, -dx, -dy);

        // the uncovered columns, then the uncovered rows between them
        const strips = [];
        if (dx > 0) strips.push([pw - dx, 0, dx, ph]);
        else if (dx < 0) strips.push([0, 0, -dx, ph]);
        const x0 = dx < 0 ? -dx : 0, x1 = dx > 0 ? pw - dx : pw;
        if (x1 > x0) {
            if (dy > 0) strips.push([x0, ph - dy, x1 - x0, dy]);
            else if (dy < 0) strips.push([x0, 0, x1 - x0, -dy]);
        }
        if (glc.width !== pw || glc.height !== ph) { glc.width = pw; glc.height = ph; }
        gl.uniform2f(this._glOriginU, -x * d, -y * dY);
        gl.uniform2f(this._glCellSzU, d, dY);
        gl.uniform1f(this._glShU, ph);
        gl.uniform1f(this._glRockSzU, Math.min(this._cols, 120) / 50.0);
        this._bioUniforms(gl);
        for (const [sx, sy, sw, sh] of strips) {
            gl.viewport(sx, ph - sy - sh, sw, sh);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        // read back just the strips (GL rows run bottom up); a transfer
        // would copy out the whole buffer on the CPU
        for (const [sx, sy, sw, sh] of strips) {
            const px = new Uint8Array(sw * sh * 4);
            gl.readPixels(sx, ph - sy - sh, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const img = g.createImageData(sw, sh), row = sw * 4;
            for (let r = 0; r < sh; r++) img.data.set(px.subarray((sh - 1 - r) * row, (sh - r) * row), r * row);
            g.putImageData(img, sx, sy);
        }

        if (c.img !== out && typeof c.img.close === 'function') c.img.close();
        this._rockCache = { img: out, canvas: null, x, y, w: c.w, h: c.h, density: d, want: c.want, cols: c.cols,
                            m: c.m, ratioY: c.ratioY, pw, ph };
        return this._rockCache;
    }

    // Full resolution on a real GPU. Software WebGL shades on the CPU, so it
    // gets a third of the pixels per axis: the silhouette edges are vector
    // clips drawn at full resolution anyway, only the facet texture softens.
    _detectRockQuality() {
        const gl = this._gl;
        if (!gl) return 0.5;
        try {
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
            if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) return 0.35;
        } catch (e) { }
        return 1;
    }

    // A throw half way through the rock pass (a lost WebGL context, a
    // detached image) used to skip its ctx.restore() calls, so the background
    // layer stayed translated and scaled for every later frame: floor and
    // rock drew somewhere off screen while vaults and the storm, on the other
    // layers, looked fine ("spawned in the abyss"). Unwind and rebuild.
    draw(ctx, px, py, ratio, gameWidth, gameHeight, screenW, screenH) {
        try {
            this._drawScene(ctx, px, py, ratio, gameWidth, gameHeight, screenW, screenH);
        } catch (e) {
            // restore() past the bottom of the stack does nothing
            for (let i = 0; i < 8; i++) ctx.restore();
            this.recover('draw failed: ' + (e && e.message));
        }
    }

    // Safety net: grid data but no rock to show. Drop every cache the rock
    // pass builds from (texture, silhouette, the shader if it is the
    // problem) so the next frames make them again.
    recover(why) {
        const t = performance.now();
        if (t - (this._recoverAt || 0) < 1000) return;
        this._recoverAt = t;
        this.recovered = (this.recovered | 0) + 1;
        if (!this._recoverWarned) { this._recoverWarned = true; console.warn('Rock layer rebuilt:', why); }
        if (this._gl && (this._gl.isContextLost() || this.recovered > 2)) this._dropGl(why);
        this._dropRockImage();
        this._damageDirty = true;
        this._damageBatch = null;
        this._silRebuildAt = 1;
        this._blankFrames = 0;
    }

    // Safety net for the rock layer as a whole: the live rocks near the
    // camera (the grid the minimap draws) must sit inside the wall the main
    // view draws. Twice wrong in a row means the wall is stale or empty, so
    // everything is built again from the grid. Cheap: a dozen hit tests every
    // 1.5 s. Returns true when it threw the frame's caches away.
    _checkRock(view) {
        const t = performance.now();
        if (t - (this._rockCheckAt || 0) < 1500) return false;
        this._rockCheckAt = t;
        // the dead set moved on and no rebuild is queued: queue one
        if (!this._silRebuildAt && this._silDeadN !== this._rockDead.size) {
            if (++this._silStale >= 2) { this._silStale = 0; this._silRebuildAt = 1; }
        } else this._silStale = 0;
        const counts = this.rockCounts(view, 12);
        this.lastCheck = counts;
        if (counts.alive >= 3 && counts.drawn < counts.alive / 2) {
            if (++this._rockMiss >= 2) {
                this._rockMiss = 0;
                this.rebuild('rock count mismatch ' + counts.drawn + '/' + counts.alive);
                return true;
            }
        } else this._rockMiss = 0;
        return false;
    }

    // Live rocks in view by the grid, and how many of them the drawn wall
    // covers. Exposed for the safety net above and for tests.
    rockCounts(view, cap = 12) {
        const out = { alive: 0, drawn: 0 };
        if (!view || !this._cellPolys.size) return out;
        const probe = this._probeCtx ||
            (this._probeCtx = document.createElement('canvas').getContext('2d'));
        const sil = this._silClip;
        for (const cell of this._cellPolys.values()) {
            if (cell.cx < view.tlx || cell.cx > view.tlx + view.tlw ||
                cell.cy < view.tly || cell.cy > view.tly + view.tlh) continue;
            if (this._rockDead.has(cell.k)) continue;
            out.alive++;
            if (sil && probe.isPointInPath(sil, cell.cx, cell.cy, 'evenodd')) out.drawn++;
            if (out.alive >= cap) break;
        }
        return out;
    }

    // Harder than recover(): the polygons go too, rebuilt from the grid
    // data already here (no packet needed).
    rebuild(why) {
        this._voroLattice = null;
        this._cellPolys.clear();
        this._silClip = null;
        this._recoverAt = 0;
        this.recover(why);
        try { this._silClip = this._buildVoronoiBoundary(); } catch (e) { /* next frame tries again */ }
        this._silRebuildAt = 0;
        this.mapDirty = true;
    }

    _drawScene(ctx, px, py, ratio, gameWidth, gameHeight, screenW, screenH) {
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
        // A zoom/resize/spectate frame can briefly give NaN or 0. Skip it:
        // sizing a texture from that throws, and a throw after ctx.save()
        // below would leave the canvas transformed for every later frame.
        if (!(cellW > 0 && cellH > 0 && isFinite(cellW) && isFinite(cellH) &&
              isFinite(originX) && isFinite(originY) && screenW > 0 && screenH > 0)) return;

        ctx.save();
        ctx.translate(originX, originY);
        ctx.scale(cellW, cellH);

        const s   = 0.4;
        const cx  = this._cols / 2, cy = this._rows / 2;
        const d   = 1.8;
        const sq3 = Math.sqrt(3);

        this._buildLineRocks();

        if (this.useVoronoi && this._silClip) {
            const tlx = -originX / cellW;
            const tly = -originY / cellH;
            const tlw =  screenW  / cellW;
            const tlh =  screenH  / cellH;
            this._view = { tlx, tly, tlw, tlh };
            const nowMs = performance.now();
            // device pixels per unit drawn in: the game keeps its world
            // context scaled to the HUD size (2 or so on a retina screen)
            let S = ctx.canvas && ctx.canvas.width > 0 ? ctx.canvas.width / screenW : 1;
            if (!(S > 0.2 && S < 8)) S = 1;
            const tex = this._rockTexture(this._view, cellW, cellH, S);
            // device pixels per tile unit, for the last-stage tremble
            this._devPxX = S * cellW; this._devPxY = S * cellH; this._shakeHd = !!(tex && tex.hd);
            // a rock whose ore came or went since: re-shade just that rock
            if (this._bioPatch.size) this._patchBio(tex);
            if (!tex || !tex.img) {
                // a frame or two can't be sized; a run of them is a broken cache
                if (++this._blankFrames > 20) this.recover('no rock texture');
                ctx.restore();
                return;
            }
            this._blankFrames = 0;
            if (this._checkRock(this._view)) { ctx.restore(); return; }

            if (this._damageDirty || !this._damageBatch) {
                this._damageDirty = false;
                // Damaged rocks stay opaque (they darken in the damage overlay
                // below). Only the trembling last stage is cut out of the wall,
                // since it is drawn nudged on its own.
                // Most rock events only nudge health, so the cut-out set is
                // usually unchanged: keep the old path rather than copying the
                // whole silhouette again.
                const shaking = [];
                for (const k of this._rockHealth.keys()) {
                    if (this._rockDead.has(k)) continue;
                    if (this._stageOf(this._rockHealth.get(k)) < 5) continue;
                    const cell = this._cellPolys.get(k);
                    if (cell) shaking.push(cell);
                }
                const old = this._damageBatch;
                const same = old && old.sil === this._silClip && old.shaking.length === shaking.length &&
                    shaking.every((cell, i) => old.shaking[i] === cell);
                if (!same) {
                    const batch = { holes: null, shaking, sil: this._silClip };
                    for (const cell of shaking) {
                        if (!batch.holes) batch.holes = new Path2D(this._silClip);
                        batch.holes.addPath(cell.path);
                    }
                    this._damageBatch = batch;
                }
            }
            const dmgBatch = this._damageBatch;

            const rockSz = Math.min(this._cols, 120) / 50.0;
            // The wall's outline, stroked UNDER the rock and nudged down: the
            // rock covers its inner half, leaving one ink line slightly heavier
            // on the bottom (a drop shadow in a single stroke per frame).
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.lineJoin    = 'round';
            ctx.lineCap     = 'round';
            ctx.lineWidth   = TerrainRenderer.SIL_W * rockSz;
            ctx.strokeStyle = TerrainRenderer.ROCK_INK;
            ctx.translate(0, TerrainRenderer.SIL_DROP * rockSz);
            ctx.stroke(this._silClip);
            ctx.restore();

            // "Simple Terrain": last-stage rocks stay put, so nothing is cut out
            const simple = config.graphical.simpleTerrain;
            const lite = config.graphical.fewerEffects;
            ctx.save();
            ctx.clip(simple ? this._silClip : dmgBatch.holes || this._silClip, 'evenodd');
            ctx.globalAlpha = 1;
            // An image shaded 1:1 for this zoom goes down on whole device
            // pixels: a copy, no resampling. Anywhere between two pixels the
            // filter averages neighbours, which is what made seams look soft.
            let bx = tex.x, by = tex.y;
            if (tex.hd) this._hdDraw(ctx, tex, originX, originY, cellW, cellH, S);
            else {
                if (Math.abs(S * cellW / tex.density - 1) < 1e-6 && Math.abs(S * cellH / (tex.density * tex.ratioY) - 1) < 1e-6) {
                    bx = (Math.round(S * (originX + tex.x * cellW)) / S - originX) / cellW;
                    by = (Math.round(S * (originY + tex.y * cellH)) / S - originY) / cellH;
                }
                ctx.drawImage(tex.img, bx, by, tex.w, tex.h);
            }
            ctx.restore();

            for (const cell of simple ? [] : dmgBatch.shaking) {
                if (cell.cx < tlx - 3 || cell.cx > tlx + tlw + 3 ||
                    cell.cy < tly - 3 || cell.cy > tly + tlh + 3) continue;
                ctx.save();
                ctx.globalAlpha = 1;
                ctx.clip(cell.path);
                this._shakeXform(ctx, cell, nowMs);
                if (tex.hd) this._hdDraw(ctx, tex, originX, originY, cellW, cellH, S,
                    cell.cx - 1.5 * rockSz, cell.cy - 1.5 * rockSz, cell.cx + 1.5 * rockSz, cell.cy + 1.5 * rockSz);
                else ctx.drawImage(tex.img, bx, by, tex.w, tex.h);

                ctx.lineJoin    = 'round';
                ctx.strokeStyle = TerrainRenderer.ROCK_INK;
                ctx.lineWidth   = 0.07 * rockSz;
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
                // same outline as the wall: dropped ink stroke under the rock
                const inkUnder = (sc) => {
                    ctx.save();
                    ctx.lineWidth = TerrainRenderer.SIL_W * rockSz;
                    ctx.translate(0, TerrainRenderer.SIL_DROP * rockSz * sc);
                    ctx.strokeStyle = TerrainRenderer.ROCK_INK;
                    ctx.stroke();
                    ctx.restore();
                };
                const drawRockPoly = (landedCell) => {
                    inkUnder(1);
                    ctx.save();
                    ctx.clip();
                    // the tiles under it, on whole pixels like the wall
                    if (tex.hd) this._hdDraw(ctx, tex, originX, originY, cellW, cellH, S,
                        landedCell.cx - 1.5 * rockSz, landedCell.cy - 1.5 * rockSz, landedCell.cx + 1.5 * rockSz, landedCell.cy + 1.5 * rockSz);
                    else ctx.drawImage(tex.img, bx, by, tex.w, tex.h);
                    ctx.restore();
                };

                for (const k of this._landed) {
                    const cell = this._cellPolys.get(k);
                    if (!cell) continue;
                    if (cell.cx < tlx - 4 || cell.cx > tlx + tlw + 4 ||
                        cell.cy < tly - 4 || cell.cy > tly + tlh + 4) continue;
                    tracePoly(cell.poly);
                    drawRockPoly(cell);
                }
                for (const [k, g] of this._growing) {
                    const cell = this._cellPolys.get(k);
                    if (!cell) continue;
                    const riseE = riseElapsed(g, nowMs);
                    const p = Math.min(1, Math.max(0, riseE / GROW_MS));
                    // self-heal: drop a growing record whose completion never arrived
                    if (riseE > GROW_MS + 4000 * g.rate) {
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
                    // scaled outline in reused point pairs (only read below,
                    // within this rock): a bloom grows dozens at once
                    const sPts = this._spolyPts || (this._spolyPts = []);
                    const spoly = this._spolyView || (this._spolyView = []);
                    spoly.length = cell.poly.length;
                    for (let pi = 0; pi < cell.poly.length; pi++) {
                        const pt = cell.poly[pi], q = sPts[pi] || (sPts[pi] = [0, 0]);
                        q[0] = ax2 + (pt[0] - g.ax) * sc;
                        q[1] = ay2 + (pt[1] - g.ay) * sc;
                        spoly[pi] = q;
                    }
                    tracePoly(spoly);

                    // the ink drop grows in with the rock so a sprouting
                    // pebble doesn't sit on a slab of shadow
                    inkUnder(sc);
                    ctx.save();
                    ctx.clip();
                    ctx.translate(ax2, ay2);
                    ctx.scale(sc, sc);
                    ctx.translate(-g.ax, -g.ay);
                    if (tex.hd) this._hdDrawCell(ctx, tex, cell);
                else ctx.drawImage(tex.img, bx, by, tex.w, tex.h);
                    ctx.restore();

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
                            const cpal = this._crackPal(k);
                            ctx.strokeStyle = cpal.base || 'rgba(16,13,22,0.8)';
                            ctx.lineWidth = w * 2.1;
                            ctx.stroke(cpath);
                            ctx.strokeStyle = cpal._hot04 || (cpal._hot04 = `rgba(${cpal.hot},0.4)`);
                            ctx.lineWidth = w * 0.5;
                            ctx.stroke(cpath);
                            ctx.restore();
                        }
                    }

                    if (p < 1 && !lite && this._pebbles.length < 80) {
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
                                    chips: this._bio ? this._bioChips(k) : null,
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

            // ── Damage overlay per rock: darkening + pockmarks, bite notches
            if (this._rockHealth.size) {
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.lineCap  = 'round';
                // forEach, not for..of: most of these are dead or off screen,
                // and an iterator step per rock per frame adds up
                this._rockHealth.forEach((frac, k) => {
                    if (this._rockDead.has(k)) return;
                    const cell = this._cellPolys.get(k);
                    if (!cell) return;
                    if (cell.cx < tlx - 3 || cell.cx > tlx + tlw + 3 ||
                        cell.cy < tly - 3 || cell.cy > tly + tlh + 3) return;
                    const stage = this._stageOf(frac);
                    const bites = this._getBitePath(k);
                    const path  = stage >= 1 ? this._getCrackPath(k, stage) : null;
                    if (!bites && !path) return;
                    ctx.save();
                    ctx.clip(cell.path);

                    // worn rock darkens toward its own seam ink (not black,
                    // so a beaten-up sandstone rock is still sandstone)
                    const ink = this._inkOf(k);
                    if (stage >= 1) {
                        ctx.fillStyle = ink;
                        ctx.globalAlpha = 0.04 * stage + 0.12 * Math.pow(stage / 5, 2);
                        ctx.fill(cell.path);
                        ctx.globalAlpha = 1;
                    }

                    if (stage >= 5 && !simple) this._shakeXform(ctx, cell, nowMs);

                    if (bites) {
                        ctx.fillStyle = ink;
                        ctx.fill(bites);
                    }
                    if (path) {
                        const ht    = this._hitFlash.get(k);
                        const hitB  = ht !== undefined && nowMs - ht < 150 ? 1 - (nowMs - ht) / 150 : 0;
                        // a new crack flashes white-hot and over-wide, then settles
                        const st    = this._crackSnap.get(k);
                        const snap  = st !== undefined && nowMs - st < 220
                            ? Math.pow(1 - (nowMs - st) / 220, 2) : 0;
                        const boost = Math.max(hitB, snap);
                        const w = 0.035 * rockSz * (0.28 + 0.075 * stage) * (1 + snap);

                        const cpal = this._crackPal(k);
                        // A clean fracture: a dark split with a darker core
                        // and a thin lit lip just under it. Mitred, square
                        // ended: round-capped stacked strokes read as soft
                        // blurry tubes.
                        ctx.lineJoin = 'miter';
                        ctx.lineCap = 'butt';
                        ctx.miterLimit = 3;
                        ctx.strokeStyle = cpal.base || 'rgba(16,13,22,0.85)';
                        ctx.lineWidth   = w * 1.25;
                        ctx.stroke(path);
                        // simple: just the dark line, not the lit layers on it
                        if (simple) { ctx.restore(); return; }
                        // (the resting colours are cached on the palette: a string per
                        // damaged rock per frame otherwise)
                        ctx.strokeStyle = boost ? `rgba(${cpal.hot},${Math.min(1, 0.75 + boost * 0.25)})`
                            : cpal._hotRest || (cpal._hotRest = `rgba(${cpal.hot},${Math.min(1, 0.75 + boost * 0.25)})`);
                        ctx.lineWidth   = w * 0.5;
                        ctx.stroke(path);
                        ctx.save();
                        ctx.translate(0, w * 0.85);
                        const hairRest = cpal._hairRest || (cpal._hairRest = []);
                        ctx.strokeStyle = boost ? `rgba(${cpal.hair},${Math.max(0.22 + 0.03 * stage, boost * 0.8)})`
                            : hairRest[stage] || (hairRest[stage] = `rgba(${cpal.hair},${Math.max(0.22 + 0.03 * stage, boost * 0.8)})`);
                        ctx.lineWidth   = w * 0.32;
                        ctx.stroke(path);
                        ctx.restore();
                    }
                    ctx.restore();

                    if (stage >= 5 && !simple && !lite && this._pebbles.length < 80) {
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
                                    chips: this._bio ? this._bioChips(k) : null,
                                });
                            }
                        }
                    }
                });
                ctx.restore();
            }

            // ── Ore markings: one crystal per deposit, drawn on the rock
            if (this._ore.size) {
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.lineCap  = 'round';
                // First every stone's dark halo, all ore rocks near the view
                // in one path however many there are.
                const pk = this._orePockets(tlx, tly, tlw, tlh);
                if (pk.n) {
                    // A feathered dark halo, black at the gem's edge fading
                    // out into whatever rock is under it: six faint strokes
                    // of the one combined path, widest first, each a little
                    // narrower (they stack, so the dark builds toward the
                    // edge; the gem's body covers their inner halves). Six
                    // strokes a frame for every gem on screen, no filters.
                    ctx.strokeStyle = 'rgb(8,6,12)';
                    ctx.globalAlpha = 0.3;
                    for (let i = ORE_HALO.length - 1; i >= 0; i--) {
                        ctx.lineWidth = ORE_HALO[i] * rockSz;
                        ctx.stroke(pk.body);
                    }
                    ctx.globalAlpha = 1;
                }
                this._ore.forEach((tier, k) => {
                    if (this._rockDead.has(k)) return;
                    const cell = this._cellPolys.get(k);
                    if (!cell) return;
                    if (cell.cx < tlx - 3 || cell.cx > tlx + tlw + 3 ||
                        cell.cy < tly - 3 || cell.cy > tly + tlh + 3) return;
                    const art = this._getVeinArt(k, tier);
                    if (!art) return;
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

                    // the core crystal's aura bleeds a little past its cell,
                    // kept faint and slow
                    if ((tier === 3 || tier === 4) && art.big && !config.graphical.noGlow) {
                        // emeralds pulse faster, wider and brighter
                        const em = tier === 4;
                        const pulse = 0.5 + 0.5 * Math.sin(nowMs / (em ? 1100 : 1400) + (k % 31));
                        const gr = rockSz * (em ? 0.68 + 0.14 * pulse : 0.55 + 0.10 * pulse);
                        const rgb = em ? '111,245,168' : '217,138,240';
                        // the aura swells in with the crystal, not before it
                        const a0 = (em ? 0.14 + 0.10 * pulse : 0.10 + 0.07 * pulse)
                                 * (sprout === null ? 1 : sprout * sprout);
                        // one unit gradient per colour, scaled into place, with
                        // the pulse on globalAlpha: a new gradient per crystal
                        // per frame is garbage the browser has to collect
                        const auras = this._auraGrads || (this._auraGrads = {});
                        let g = auras[rgb];
                        if (!g) {
                            g = auras[rgb] = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
                            g.addColorStop(0, `rgba(${rgb},1)`);
                            g.addColorStop(1, `rgba(${rgb},0)`);
                        }
                        ctx.save();
                        ctx.translate(art.big[0], art.big[1]);
                        ctx.scale(gr, gr);
                        ctx.globalAlpha *= a0;
                        ctx.fillStyle = g;
                        ctx.beginPath();
                        ctx.arc(0, 0, 1, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.restore();
                    }

                    ctx.save();
                    ctx.clip(cell.path);
                    if (stage >= 5 && !simple) this._shakeXform(ctx, cell, nowMs);
                    ctx.globalAlpha = 1 - 0.275 * Math.pow(stage / 5, 2);
                    const baseA = ctx.globalAlpha;

                    if (sprout !== null) {
                        // ── the seam pushing through, one stone at a time
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
                    for (let gi = 0; gi < (simple ? 0 : art.glintPts.length); gi++) {
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
                });
                ctx.restore();
            }

            if (this._impacts.length || this._pebbles.length) {
                const CHIPC = TerrainRenderer.ROCK_CHIP;
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
                        ctx.globalAlpha = (1 - ts) * (im.small ? 0.45 : 0.9);
                        ctx.fillStyle = 'rgb(255,235,180)';
                        ctx.beginPath();
                        ctx.arc(im.x, im.y, 0.13 * rockSz * isc * (1 - ts * 0.6), 0, Math.PI * 2);
                        ctx.fill();
                        ctx.globalAlpha = 1;
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
                    // rock chips flying out fast off the rock
                    const fly = Math.min(1, tc / 0.3);
                    const fe  = 1 - Math.pow(1 - fly, 3);
                    const al  = tc < 0.5 ? 0.9 : 0.9 * (1 - (tc - 0.5) / 0.5);
                    ctx.globalAlpha = al;
                    for (let s = 0; s < (lite ? (im.small ? 2 : 6) : im.small ? 5 : 12); s++) {
                        const ang = baseAng + (this._h(s, im.seed, 55) - 0.5) * 1.5;
                        const sp  = (0.2 + this._h(s, im.seed, 56) * 0.75) * rockSz * isc;
                        const sz  = (0.016 + this._h(s, im.seed, 57) * 0.028) * rockSz * (im.small ? 0.8 : 1);
                        ctx.save();
                        ctx.translate(im.x + Math.cos(ang) * fe * sp,
                                      im.y + Math.sin(ang) * fe * sp);
                        ctx.rotate(ang + fe * (this._h(s, im.seed, 58) - 0.5) * 8);
                        ctx.fillStyle = (im.chips || CHIPC)[s % 3];
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
                    ctx.fillStyle = (pb.chips || CHIPC)[pb.seed % 3];
                    ctx.fillRect(pb.x + pb.dx * fe * range - sz,
                                 pb.y + pb.dy * fe * range - sz, sz * 2, sz * 2);
                }
                ctx.globalAlpha = 1;
                ctx.restore();
            }

            // ── Shatter: brief flash + dust ring, streaks, then rock chips.
            // One path per streak colour and per chip shade, alpha for the
            // fades, so a burst costs a handful of draw calls a frame.
            if (this._fx.length) {
                const CHIPS = TerrainRenderer.ROCK_CHIP;
                const pool = this._fxPool || (this._fxPool = []);
                ctx.save();
                for (let i = this._fx.length - 1; i >= 0; i--) {
                    const fx = this._fx[i];
                    const t  = (nowMs - fx.born) / 620;
                    if (t < 0) continue;   // hit-stop: burst starts after the freeze
                    if (t >= 1) { pool.push(fx); this._fx.splice(i, 1); continue; }
                    const eo   = 1 - Math.pow(1 - t, 4);
                    const fade = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
                    // hard white flash filling the rock's silhouette
                    if (t < 0.12) {
                        ctx.globalAlpha = (1 - t / 0.12) * 0.9;
                        ctx.fillStyle = 'rgb(240,232,250)';
                        ctx.fill(fx.path);
                    }
                    // fast double dust ring
                    ctx.strokeStyle = 'rgb(110,100,125)';
                    for (let rgi = 0; rgi < 2; rgi++) {
                        const rt = rgi === 0 ? t : (t - 0.07) / 0.93;
                        if (rt <= 0 || rt >= 1) continue;
                        const rq = 1 - Math.pow(1 - rt, 4);          // easeOutQuart
                        ctx.globalAlpha = Math.pow(1 - rt, 1.5) * 0.6;
                        ctx.beginPath();
                        ctx.arc(fx.cx, fx.cy, (0.25 + (rgi ? 1.9 : 3.0) * rq) * rockSz, 0, Math.PI * 2);
                        ctx.lineWidth   = 0.12 * rockSz * (1 - rt) + 0.01;
                        ctx.stroke();
                    }
                    // colored firework streaks flying out with the debris
                    const pal = fx.colors, S = fx.sparks, nS = lite ? fx.nSparks >> 1 : fx.nSparks;
                    ctx.lineCap = 'round';
                    ctx.lineWidth = 0.028 * rockSz * (1 - t * 0.5);
                    ctx.globalAlpha = fade * 0.9;
                    for (let ci = 0; ci < pal.length; ci++) {
                        let any = false;
                        for (let e = 0; e < nS; e++) {
                            if (S[e * 3 + 2] !== ci) continue;
                            if (!any) { any = true; ctx.beginPath(); }
                            const r2 = eo * S[e * 3 + 1] * rockSz, r1 = r2 * 0.6;
                            const ca = Math.cos(S[e * 3]), sa = Math.sin(S[e * 3]);
                            ctx.moveTo(fx.cx + ca * r1, fx.cy + sa * r1);
                            ctx.lineTo(fx.cx + ca * r2, fx.cy + sa * r2);
                        }
                        if (any) { ctx.strokeStyle = pal[ci]; ctx.stroke(); }
                    }
                    // rock chips: little turned oblongs, one path per shade
                    ctx.globalAlpha = fade;
                    const P = fx.parts, chips = fx.chips || CHIPS;
                    const step = lite ? 2 : 1, shrink = 1 - t * 0.6;
                    for (let sh = 0; sh < 3; sh++) {
                        ctx.beginPath();
                        for (let e = 0; e < SHATTER_CHIPS; e += step) {
                            const o = e * 8;
                            if (P[o + 3] !== sh) continue;
                            const ang = P[o], dist = eo * P[o + 1] * rockSz;
                            const px = fx.cx + P[o + 6] + Math.cos(ang) * dist;
                            const py = fx.cy + P[o + 7] + Math.sin(ang) * dist;
                            const hw = P[o + 2] * rockSz * shrink, hh = hw * P[o + 5];
                            const r = ang + P[o + 4] * eo, c = Math.cos(r), sn = Math.sin(r);
                            const ax = c * hw, ay = sn * hw, bx = -sn * hh, by = c * hh;
                            ctx.moveTo(px - ax - bx, py - ay - by);
                            ctx.lineTo(px + ax - bx, py + ay - by);
                            ctx.lineTo(px + ax + bx, py + ay + by);
                            ctx.lineTo(px - ax + bx, py - ay + by);
                            ctx.closePath();
                        }
                        ctx.fillStyle = chips[sh];
                        ctx.fill();
                    }
                    ctx.globalAlpha = 1;
                }
                ctx.restore();
            }
        } else {
            // the voronoi wall with no silhouette built: build it again
            if (this.useVoronoi && ++this._blankFrames > 20) this.recover('no silhouette');
            // (only this fallback uses these: built here, not every frame)
            const hex = [
                [ d,       0        ],
                [ d / 2,  -d*sq3/2  ],
                [-d / 2,  -d*sq3/2  ],
                [-d,       0        ],
                [-d / 2,   d*sq3/2  ],
                [ d / 2,   d*sq3/2  ],
            ];
            const pick = [3, 1, 2, 0, 5, 4];
            const centerG = [
                [[-2.20,-1.65],[-1.05,-2.35],[ 0.15,-2.50],[ 1.35,-2.20],[ 2.35,-1.45]],
                [[-3.05,-0.45],[-1.35,-1.00],[ 0.20,-0.85],[ 1.55,-0.70],[ 3.05,-0.20]],
                [[-3.05, 0.95],[-1.20, 0.55],[ 0.30, 0.70],[ 1.65, 0.55],[ 2.70, 1.05]],
                [[-1.95, 1.70],[-0.70, 2.35],[ 0.45, 2.45],[ 1.45, 2.05],[ 2.25, 1.35]],
            ];
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
