// Rock biomes for the raid map, shared by the server (require) and the
// client (<script> served at /shared/rockBiomes.js, exposes window.DWBiomes).
//
// A rock's biome comes only from its lattice cell, the grid size and the map
// seed, so both sides work it out on their own and nothing goes over the
// wire per rock. The client uses it for colour (rock shader, chips, both
// maps, the "Crystal Caves" note); the server for toughness, gem pay and
// ore flavour. Rock SHAPES never depend on it: the voronoi mirrors stay as
// they are.
//
// The map reads like a trip inward: warm sandstone at the rim with red clay
// pockets, mossy hollows around the outer/middle seam, cool crystal in the
// middle band, magma nearer the centre and violet obsidian round the very
// centre, where the last storm and the Core end up. The rings are bent by
// low-frequency noise and every seam blends over two or three rocks.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWBiomes = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const BIOMES = [
        {   id: 'sandstone', name: 'Sandstone Flats',
            fill: [252, 212, 98], vary: [3, 3, -3], gem: [255, 206, 92], rimA: 0,
            ui: '#e8bf84', hard: 0.80, ore: 0.97, up: 0 },
        {   id: 'clay', name: 'Red Clay Badlands',
            fill: [246, 158, 96], vary: [3, -2, -2], gem: [255, 152, 92], rimA: 0,
            ui: '#f0a476', hard: 0.85, ore: 0.98, up: 0 },
        {   id: 'moss', name: 'Mossy Hollows',
            fill: [140, 214, 106], vary: [2, 3, -3], gem: [92, 232, 148], rimA: 0,
            ui: '#9ae0a4', hard: 1.00, ore: 1.06, up: 0 },
        {   id: 'crystal', name: 'Crystal Caves',
            fill: [102, 198, 240], vary: [-3, 2, 3], gem: [104, 220, 246], rimA: 0,
            ui: '#86d8ee', hard: 1.05, ore: 1.00, up: 0 },
        {   id: 'magma', name: 'Magma Veins',
            fill: [250, 116, 110], vary: [3, 1, -2], gem: [255, 132, 48], rimA: 0,
            ui: '#f6836a', hard: 1.30, ore: 1.06, up: 0.08 },
        {   id: 'obsidian', name: 'Obsidian Deep',
            fill: [124, 134, 248], vary: [2, -2, 3], gem: [198, 132, 255], rimA: 0,
            ui: '#c2a6f6', hard: 1.50, ore: 1.10, up: 0.12 },
    ];
    const OUTLINE = 0.55, SHADE = 0.84, LIGHT = 0.2, RIM = 0.35, MAP = 0.92, DEEP = 0.76, DEEP_POP = 1.3;
    const scaleRgb = (c, k) => c.map(v => Math.round(v * k));
    const liftRgb = (c, k) => c.map(v => Math.round(v + (255 - v) * k));
    const hexRgb = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
    function deepTone(c) {
        const r = c[0] * DEEP, g = c[1] * DEEP, b = c[2] * DEEP;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const f = (v) => Math.max(0, Math.min(255, Math.round(L + (v - L) * DEEP_POP)));
        return [f(r), f(g), f(b)];
    }
    for (const b of BIOMES) {
        b.ink = scaleRgb(b.fill, OUTLINE);
        b.dark = scaleRgb(b.fill, SHADE);
        b.face = b.fill.slice();
        b.light = liftRgb(b.fill, LIGHT);
        b.rim = liftRgb(b.fill, RIM);
        b.glow = 0;
        b.vein = 0;
        b.map = hexRgb(scaleRgb(b.fill, MAP));
        b.mapDark = hexRgb(scaleRgb(deepTone(b.fill), MAP));
    }

    // Toughness = biome hard x ORE_TOUGH[ore], on top of the ore's own health
    // (terrainGrid.js ORE_HP: copper 1.8x plain, vein 2.2x, shard 3x,
    // emerald 6x). So against today:
    //   sandstone plain or copper 0.80x ... obsidian emerald 2.03x
    // A rock's gems pay the same toughness factor (gems.js spawnOreBurst),
    // so every rock gives the same gems per second of digging it always did,
    // and the ore/up tilt (moss and the centre hold a little more ore, some
    // copper near the centre comes up as vein) makes the centre a few
    // percent richer per second. scripts/test/rockBiomes.test.js holds it.
    // Index by ore tier: none, copper, vein (azurite), shard, emerald.
    const ORE_TOUGH = [1.00, 1.00, 1.10, 1.20, 1.35];
    function toughness(hard, ore) {
        return (hard || 1) * (ORE_TOUGH[ore | 0] || 1);
    }
    const VARY_LUM = 0.025;
    const N = BIOMES.length;
    const IDX = {};
    BIOMES.forEach((b, i) => { IDX[b.id] = i; });

    // Journey bands on the warped radius (0 centre, 1 the rock edge).
    const EDGE_OBSIDIAN = 0.20;   // obsidian | magma
    const EDGE_MAGMA = 0.41;      // magma | crystal
    const EDGE_CRYSTAL = 0.65;    // crystal | sandstone
    // half the width of a seam blend; one rock is about 0.030 of the radius
    // on the 20-tile raid map (0.038 on the old 16-tile one), so this blends
    // over about three to four rocks
    const BLEND = 0.065;
    // How the rings bend. LOBE: a stretch by direction (+-, a share of the
    // radius), so even the small inner rings come out lumpy, with about
    // LOBE_FREQ * 6 lobes round the map. WARP: a slow wobble in radius
    // units on top, so no two seams run parallel.
    // Oct 8 2026 (bigger map): a few more lobes and a little more wobble, so
    // the bigger rings break up into separate bays and headlands.
    const LOBE = 0.24, LOBE_FREQ = 1.5;
    const WARP = 0.07, WARP_FREQ = 2.6;
    // Pockets: patches of one biome inside another's band, each from its own
    // slow noise (frequency F, over the map's half size, so they grow with
    // the map). Oct 8 2026: the map went from 16 to 20 tiles and the owner
    // wanted bigger and more varied biome sections, so the moss and clay
    // pockets come up more often, and two new kinds break up the rings:
    // crystal geodes out in the sandstone flats and magma fissures cutting
    // into the crystal band. Same six biomes, same toughness table.
    const MOSS_F = 3.6, CLAY_F = 3.3, GEODE_F = 3.9, FISSURE_F = 3.6;

    function hash(x, y, s) {
        let h = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 1284865837) ^ Math.imul((s | 0) + 1, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1540483477);
        h ^= h >>> 15;
        return (h >>> 0) / 4294967296;
    }
    function smooth(a, b, x) {
        const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
        return t * t * (3 - 2 * t);
    }
    // value noise, 0..1
    function vnoise(x, y, s) {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = x - xi, yf = y - yi;
        const ux = xf * xf * (3 - 2 * xf), uy = yf * yf * (3 - 2 * yf);
        const a = hash(xi, yi, s), b = hash(xi + 1, yi, s);
        const c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
        return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
    }
    // two octaves, still 0..1 and still slow
    function fbm(x, y, s) {
        return vnoise(x, y, s) * 0.68 + vnoise(x * 2.07 + 17.3, y * 2.07 - 9.1, s + 1) * 0.32;
    }

    // Biome weights at (nx, ny), the position over the map's half size
    // (-1..1 both ways, the rock circle's edge at radius ~1). Writes N
    // weights that sum to 1 into out. This is the raw field; a rock's own
    // weights (rockWeights) are this softened over its neighbours.
    function weightsAt(nx, ny, seed, out) {
        out = out || new Array(N);
        const s = (seed | 0) * 7 + 3;
        const r = Math.sqrt(nx * nx + ny * ny);
        const ux = r > 1e-9 ? nx / r : 1, uy = r > 1e-9 ? ny / r : 0;
        const d = r * (1 + (fbm(ux * LOBE_FREQ + 5.3, uy * LOBE_FREQ + 2.9, s + 60) - 0.5) * 2 * LOBE) +
                  (fbm(nx * WARP_FREQ + 3.1, ny * WARP_FREQ - 7.7, s) - 0.5) * 2 * WARP;
        const tA = smooth(EDGE_OBSIDIAN - BLEND, EDGE_OBSIDIAN + BLEND, d);
        const tB = smooth(EDGE_MAGMA - BLEND, EDGE_MAGMA + BLEND, d);
        const tC = smooth(EDGE_CRYSTAL - BLEND, EDGE_CRYSTAL + BLEND, d);
        // pockets: moss where the middle band meets the outer one, clay out
        // in the sandstone, crystal geodes in the outer flats, magma fissures
        // pushing out into the crystal. Their own slow noise picks where.
        const m = fbm(nx * MOSS_F - 11.2, ny * MOSS_F + 4.6, s + 20);
        const c = fbm(nx * CLAY_F + 8.4, ny * CLAY_F + 13.9, s + 40);
        const g = fbm(nx * GEODE_F - 3.7, ny * GEODE_F - 15.1, s + 80);
        const f = fbm(nx * FISSURE_F + 21.4, ny * FISSURE_F + 6.2, s + 100);
        let moss = smooth(0.52, 0.64, m) * smooth(0.50, 0.60, d) * (1 - smooth(0.88, 0.97, d));
        let clay = smooth(0.52, 0.64, c) * smooth(0.70, 0.80, d);
        // a geode keeps clear of the clay and moss (a three-way seam reads grey)
        let geode = smooth(0.58, 0.68, g) * smooth(0.76, 0.86, d) * (1 - smooth(0.95, 1.04, d)) * (1 - clay) * (1 - moss);
        let fissure = smooth(0.57, 0.72, f) * smooth(0.37, 0.45, d) * (1 - smooth(0.54, 0.63, d)) * (1 - moss);
        const pk = moss + clay + geode + fissure;
        if (pk > 1) { moss /= pk; clay /= pk; geode /= pk; fissure /= pk; }
        const rest = Math.max(0, 1 - moss - clay - geode - fissure);
        out[IDX.obsidian] = (1 - tA) * rest;
        out[IDX.magma] = (tA - tB) * rest + fissure;
        out[IDX.crystal] = (tB - tC) * rest + geode;
        out[IDX.sandstone] = tC * rest;
        out[IDX.moss] = moss;
        out[IDX.clay] = clay;
        return out;
    }

    // A rock's spot: its lattice cell's centre over the map's half size.
    // Rock lattice size is Math.min(cols, 120) / 50 tiles, the same rule as
    // terrainGrid.js and terrainRenderer.js.
    function latticeUnit(vi, vj, cols, rows, out) {
        out = out || [0, 0];
        const rs = Math.min(cols, 120) / 50;
        out[0] = (vi + 0.5) * rs / cols * 2 - 1;
        out[1] = (vj + 0.5) * rs / rows * 2 - 1;
        return out;
    }
    // A rock's weights: the field at its cell and the 8 round it, 1-2-1 each
    // way. Noise can tip a pocket's edge from one rock to the next; this
    // spreads every seam over at least two or three rocks. Always summed in
    // the same order, so every caller gets the same bits.
    const KERNEL = [1, 2, 1];
    const _u = [0, 0];
    // each cell's raw field, kept for the map in use: a whole map asks for
    // every cell nine times
    let rawKey = '', rawMemo = new Map();
    function rawCell(vi, vj, cols, rows, seed) {
        const key = seed + ':' + cols + ':' + rows;
        if (key !== rawKey) { rawKey = key; rawMemo = new Map(); }
        const ck = vi * 100003 + vj;
        let w = rawMemo.get(ck);
        if (!w) {
            latticeUnit(vi, vj, cols, rows, _u);
            w = weightsAt(_u[0], _u[1], seed, new Array(N));
            rawMemo.set(ck, w);
        }
        return w;
    }
    function rockWeights(vi, vj, cols, rows, seed, out) {
        out = out || new Array(N);
        for (let i = 0; i < N; i++) out[i] = 0;
        for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
                const raw = rawCell(vi + di, vj + dj, cols, rows, seed);
                const k = KERNEL[di + 1] * KERNEL[dj + 1] / 16;
                for (let i = 0; i < N; i++) out[i] += raw[i] * k;
            }
        }
        return out;
    }
    function dominant(w) {
        let best = 0;
        for (let i = 1; i < N; i++) if (w[i] > w[best]) best = i;
        return best;
    }
    // The lattice cell under a point (nx, ny over the map's half size).
    function cellAt(nx, ny, cols, rows, out) {
        out = out || [0, 0];
        const rs = Math.min(cols, 120) / 50;
        out[0] = Math.floor((nx + 1) / 2 * cols / rs);
        out[1] = Math.floor((ny + 1) / 2 * rows / rs);
        return out;
    }
    const _w = new Array(N), _c = [0, 0];
    function rockBiome(vi, vj, cols, rows, seed) { return dominant(rockWeights(vi, vj, cols, rows, seed, _w)); }
    // The biome of the rock cell under a point, so the HUD names the colour
    // you're looking at.
    function biomeAt(nx, ny, cols, rows, seed) {
        cellAt(nx, ny, cols, rows, _c);
        return rockBiome(_c[0], _c[1], cols, rows, seed);
    }

    // Blended gameplay numbers for one rock: { hard, ore, up }.
    function rockStats(vi, vj, cols, rows, seed, out) {
        const w = rockWeights(vi, vj, cols, rows, seed, _w);
        out = out || {};
        let hard = 0, ore = 0, up = 0;
        for (let i = 0; i < N; i++) {
            hard += w[i] * BIOMES[i].hard;
            ore += w[i] * BIOMES[i].ore;
            up += w[i] * BIOMES[i].up;
        }
        out.hard = hard; out.ore = ore; out.up = up;
        out.biome = dominant(w);
        return out;
    }

    const TONES = ['ink', 'dark', 'face', 'light', 'rim', 'gem'];
    const NT = TONES.length;
    // how much of a rock's own variation each tone takes: the seam ink
    // barely moves, the lit facet and rim the most
    const VARY_K = [0.3, 0.6, 0.75, 0.85, 0.8, 0.3];
    const clamp8 = (v) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    // Blended tones for weights w: 21 bytes (ink, dark, face, light, rim,
    // gem rgb, then rim strength, seam glow and veins, 0-255) into out at
    // offset o. vl (-1..1) and vh
    // (-1..1): this rock's own brightness and colour nudge, 0 for the plain
    // biome colours. The weights are squared first: an even rgb mix of two
    // far-apart colours (sandstone and crystal) is a dull grey, so the seam
    // leans to whichever biome is ahead and only a rock or so is in between.
    const _sw = new Array(N);
    function tonesFor(w0, out, o, vl, vh) {
        o = o | 0; vl = vl || 0; vh = vh || 0;
        let sum = 0;
        for (let i = 0; i < N; i++) { _sw[i] = w0[i] * w0[i]; sum += _sw[i]; }
        for (let i = 0; i < N; i++) _sw[i] = sum > 0 ? _sw[i] / sum : 0;
        const w = _sw;
        let dr = 0, dg = 0, db = 0, ra = 0, ga = 0, va = 0;
        for (let i = 0; i < N; i++) {
            const wi = w[i];
            if (!wi) continue;
            const v = BIOMES[i].vary;
            dr += wi * v[0]; dg += wi * v[1]; db += wi * v[2];
            ra += wi * BIOMES[i].rimA;
            ga += wi * (BIOMES[i].glow || 0);
            va += wi * (BIOMES[i].vein || 0);
        }
        for (let t = 0; t < NT; t++) {
            let r = 0, g = 0, b = 0, chroma = 0;
            for (let i = 0; i < N; i++) {
                const wi = w[i];
                if (!wi) continue;
                const c = BIOMES[i][TONES[t]];
                r += wi * c[0]; g += wi * c[1]; b += wi * c[2];
                chroma += wi * (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]));
            }
            const mixed = Math.max(r, g, b) - Math.min(r, g, b);
            if (mixed > 0.5 && chroma > mixed) {
                const L = 0.2126 * r + 0.7152 * g + 0.0722 * b, s = Math.min(1.22, chroma / mixed);
                r = L + (r - L) * s; g = L + (g - L) * s; b = L + (b - L) * s;
            }
            const k = VARY_K[t], lum = 1 + vl * VARY_LUM * k;
            out[o + t * 3] = clamp8(r * lum + dr * vh * k);
            out[o + t * 3 + 1] = clamp8(g * lum + dg * vh * k);
            out[o + t * 3 + 2] = clamp8(b * lum + db * vh * k);
        }
        out[o + NT * 3] = clamp8(ra * 255);
        out[o + NT * 3 + 1] = clamp8(ga * 255);
        out[o + NT * 3 + 2] = clamp8(va * 255);
        return out;
    }
    const TONE_BYTES = NT * 3 + 3;
    // One rock's tones: its biome blend plus its own variation, seeded by
    // its lattice cell (and the map seed), so every client draws the same
    // rock the same way. ore: the rock's ore tier (0 none). An ore rock looks
    // just like the plain rocks round it; its gem's dark halo (drawn by the
    // client) is what makes the gem stand out.
    const ORE_DEEP = 1;
    // by ore tier: copper, vein (azurite), shard, emerald
    const ORE_GEM = [null, [214, 128, 62], [88, 150, 236], [190, 92, 220], [52, 206, 128]];
    const _rw = new Array(N);
    function rockTones(vi, vj, cols, rows, seed, out, o, ore) {
        o = o | 0;
        rockWeights(vi, vj, cols, rows, seed, _rw);
        const vl = hash(vi, vj, (seed | 0) * 5 + 901) * 2 - 1;
        const vh = hash(vi, vj, (seed | 0) * 5 + 902) * 2 - 1;
        tonesFor(_rw, out, o, vl, vh);
        if (ore) { deepen(out, o, out, o, ore); oreGem(out, o, ore); }
        return out;
    }
    // A plain rock's tones (src at so) as an ore rock's (into dst at o):
    // the same stone.
    function deepen(src, so, dst, o) {
        for (let q = 0; q < TONE_BYTES; q++) dst[o + q] = src[so + q];
        return dst;
    }
    // An ore rock's gem texel takes its ore's colour (tier 1-4).
    function oreGem(dst, o, tier) {
        const c = ORE_GEM[tier | 0];
        if (!c) return dst;
        const q = o + (NT - 1) * 3;
        dst[q] = c[0]; dst[q + 1] = c[1]; dst[q + 2] = c[2];
        return dst;
    }

    return {
        BIOMES, N, IDX, TONES, NT, TONE_BYTES, ORE_TOUGH, ORE_DEEP, ORE_GEM, VARY_LUM,
        EDGE_OBSIDIAN, EDGE_MAGMA, EDGE_CRYSTAL, BLEND,
        weightsAt, latticeUnit, cellAt, rockWeights, rockBiome, biomeAt, rockStats, tonesFor, rockTones, deepen, oreGem, toughness, dominant, deepTone,
        hash, fbm,
    };
});
