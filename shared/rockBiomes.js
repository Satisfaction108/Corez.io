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

    // Five tones per rock. The first four have the classic shader's roles:
    // seam ink, the shadowed facet, the main face, the lit facet. rim is a
    // thin band just inside the seam, rimA how strongly it shows (0 = none),
    // and it leans to the lit side. It gives each biome its own edge: cool
    // pale edges in the crystal, lavender ones on the obsidian, a hot dark
    // red seam in the magma. No glints, no sparkle, nothing animated.
    // glow: light that seems to come out of the seam itself, the same on
    // both sides of it, in the rim colour: warm out of the magma's cracks,
    // cool off the crystal's edges, softer elsewhere (0 = none).
    // gem and vein: the treasure in the rock. Thin veins and flecks of the
    // biome's gem colour through each face (gold in the sandstone, emerald
    // in the moss, cyan in the crystal, embers in the magma, violet in the
    // obsidian) and a soft light from the rock's heart; vein is how much
    // (0 = none). Ore rocks carry more of it, though their own ore markings
    // stay the loudest thing on them. All of it is baked into the cached
    // rock image like everything else here: nothing moves, nothing sparkles.
    //
    // Brightness: faces sit at luminance ~90-120 (0-255; the classic rock is
    // 41, the floor ~30) with HSV saturation ~0.45-0.6, so a biome reads at a
    // Basic tank's zoom, while tanks (luminance ~120-140, saturation ~0.75,
    // dark outlines), bullets and gems stay brighter and louder. Ink stays
    // dark but tinted, so seams are never plain black.
    //
    // vary: how one rock differs from the next inside a biome. Every rock
    // gets its own brightness (+-VARY_LUM) and a nudge along this colour
    // direction (per unit, scaled by the tone), both from its lattice cell.
    // map: the rock fill on the minimap and the big map. ui: the colour of
    // the biome's name in the HUD note.
    //
    // hard: how tough the biome's rock is (health multiplier, and its gems
    // pay the same factor, see toughness below). ore: multiplier on the
    // chance a rock holds ore at all. up: share of copper rolls that come up
    // as vein.
    const BIOMES = [
        {   id: 'sandstone', name: 'Sandstone Flats',
            // warm tan, the lit facet goes golden
            ink: [64, 42, 26], dark: [122, 88, 54], face: [158, 118, 74], light: [196, 156, 96],
            rim: [214, 176, 112], rimA: 0.22, glow: 0.2, vary: [9, 4, -7],
            gem: [255, 206, 92], vein: 0.5,
            map: '#7a5f3e', ui: '#e8bf84',
            hard: 0.80, ore: 0.97, up: 0 },
        {   id: 'clay', name: 'Red Clay Badlands',
            ink: [66, 30, 22], dark: [124, 66, 48], face: [162, 92, 66], light: [198, 124, 88],
            rim: [214, 146, 108], rimA: 0.18, glow: 0.15, vary: [8, -3, -5],
            gem: [255, 152, 92], vein: 0.42,
            map: '#8a5838', ui: '#f0a476',
            hard: 0.85, ore: 0.98, up: 0 },
        {   id: 'moss', name: 'Mossy Hollows',
            ink: [28, 46, 28], dark: [62, 94, 56], face: [86, 128, 74], light: [120, 162, 90],
            rim: [150, 186, 108], rimA: 0.18, glow: 0.2, vary: [7, 5, -6],
            gem: [92, 232, 148], vein: 0.48,
            map: '#4c6c42', ui: '#9ae0a4',
            hard: 1.00, ore: 1.06, up: 0 },
        {   id: 'crystal', name: 'Crystal Caves',
            // cool teal-blue, pale icy edges
            ink: [16, 34, 52], dark: [40, 76, 108], face: [72, 124, 158], light: [124, 186, 218],
            rim: [150, 214, 240], rimA: 0.32, glow: 0.3, vary: [-6, 4, 9],
            gem: [104, 220, 246], vein: 0.38,
            map: '#416c86', ui: '#86d8ee',
            hard: 1.05, ore: 1.00, up: 0 },
        {   id: 'magma', name: 'Magma Veins',
            // dark red basalt, a hot red seam just inside the ink
            ink: [92, 18, 12], dark: [96, 36, 34], face: [142, 56, 48], light: [180, 84, 60],
            rim: [236, 100, 44], rimA: 0.36, glow: 0.85, vary: [10, 2, -4],
            gem: [255, 132, 48], vein: 0.6,
            map: '#7a2c28', ui: '#f6836a',
            hard: 1.30, ore: 1.06, up: 0.08 },
        {   id: 'obsidian', name: 'Obsidian Deep',
            // deep violet, lavender edges
            ink: [32, 20, 54], dark: [64, 48, 106], face: [94, 72, 144], light: [128, 104, 186],
            rim: [172, 144, 232], rimA: 0.34, glow: 0.3, vary: [8, -3, 7],
            gem: [198, 132, 255], vein: 0.45,
            map: '#584284', ui: '#c2a6f6',
            hard: 1.50, ore: 1.10, up: 0.12 },
    ];
    // Brightness dial. The owner, Oct 4: "about 3.7" on a 1 to 5 scale where 1
    // is the first, muted biome pass and 5 the full bright one above. Every
    // tone (and the map tint) sits BRIGHT of the way from muted to bright,
    // the rim shows BRIGHT as strongly. Turn it to taste: 0 muted, 1 bright.
    const BRIGHT = 1;
    const MUTED = {
        sandstone: { ink: [30, 25, 20], dark: [63, 52, 42], face: [84, 70, 56], light: [109, 91, 73], map: '#473d32' },
        clay: { ink: [31, 22, 18], dark: [64, 46, 38], face: [86, 62, 50], light: [112, 81, 65], map: '#4e3b31' },
        moss: { ink: [19, 25, 20], dark: [39, 52, 41], face: [52, 70, 55], light: [68, 91, 72], map: '#334235' },
        crystal: { ink: [17, 24, 28], dark: [34, 50, 58], face: [46, 66, 78], light: [60, 86, 101], map: '#30414b' },
        magma: { ink: [50, 18, 14], dark: [51, 32, 32], face: [68, 42, 42], light: [88, 55, 55], map: '#553838' },
        obsidian: { ink: [17, 13, 23], dark: [34, 28, 48], face: [46, 37, 64], light: [60, 48, 83], map: '#45395c' },
    };
    const hexMix = (a, b, t) => '#' + [1, 3, 5].map(i => {
        const x = parseInt(a.slice(i, i + 2), 16), y = parseInt(b.slice(i, i + 2), 16);
        return Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    }).join('');
    for (const b of BIOMES) {
        const m = MUTED[b.id];
        if (!m) continue;
        for (const k of ['ink', 'dark', 'face', 'light']) b[k] = b[k].map((v, i) => Math.round(m[k][i] + (v - m[k][i]) * BRIGHT));
        b.rimA = Math.round(b.rimA * BRIGHT * 1000) / 1000;
        b.glow = Math.round(b.glow * BRIGHT * 1000) / 1000;
        b.vein = Math.round(b.vein * BRIGHT * 1000) / 1000;
        b.map = hexMix(m.map, b.map, BRIGHT);
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
    // per-rock brightness spread, +-
    const VARY_LUM = 0.06;
    const N = BIOMES.length;
    const IDX = {};
    BIOMES.forEach((b, i) => { IDX[b.id] = i; });

    // Journey bands on the warped radius (0 centre, 1 the rock edge).
    const EDGE_OBSIDIAN = 0.20;   // obsidian | magma
    const EDGE_MAGMA = 0.41;      // magma | crystal
    const EDGE_CRYSTAL = 0.65;    // crystal | sandstone
    // half the width of a seam blend; one rock is about 0.038 of the radius
    // on the raid map, so this blends over about three rocks
    const BLEND = 0.065;
    // How the rings bend. LOBE: a stretch by direction (+-, a share of the
    // radius), so even the small inner rings come out lumpy, with about
    // LOBE_FREQ * 6 lobes round the map. WARP: a slow wobble in radius
    // units on top, so no two seams run parallel.
    const LOBE = 0.22, LOBE_FREQ = 1.25;
    const WARP = 0.06, WARP_FREQ = 2.3;

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
        // in the sandstone. Their own slow noise picks where.
        const m = fbm(nx * 3.4 - 11.2, ny * 3.4 + 4.6, s + 20);
        const c = fbm(nx * 3.1 + 8.4, ny * 3.1 + 13.9, s + 40);
        let moss = smooth(0.55, 0.67, m) * smooth(0.52, 0.62, d) * (1 - smooth(0.86, 0.95, d));
        let clay = smooth(0.55, 0.67, c) * smooth(0.72, 0.82, d);
        const pk = moss + clay;
        if (pk > 1) { moss /= pk; clay /= pk; }
        const rest = Math.max(0, 1 - moss - clay);
        out[IDX.obsidian] = (1 - tA) * rest;
        out[IDX.magma] = (tA - tB) * rest;
        out[IDX.crystal] = (tB - tC) * rest;
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
            let r = 0, g = 0, b = 0;
            for (let i = 0; i < N; i++) {
                const wi = w[i];
                if (!wi) continue;
                const c = BIOMES[i][TONES[t]];
                r += wi * c[0]; g += wi * c[1]; b += wi * c[2];
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
        weightsAt, latticeUnit, cellAt, rockWeights, rockBiome, biomeAt, rockStats, tonesFor, rockTones, deepen, oreGem, toughness, dominant,
        hash, fbm,
    };
});
