const { ORE, ORE_HP, rockTough } = require('./terrainGrid.js');
const Biomes = require('../../../shared/rockBiomes.js');

// Six bases on one ring: the four cardinals plus the NE/SW diagonals. The two
// side vaults sit on the NW/SE diagonals, so every 45 degrees holds a landmark.
const BASE_DIST = 0.70;
const OUTPOSTS = [
    { name: "North Team Bank",     color: "#e03e41", ang: -Math.PI / 2,     dist: BASE_DIST, shop: true },
    { name: "Northeast Team Bank", color: "#8abc3f", ang: -Math.PI / 4,     dist: BASE_DIST },
    { name: "East Team Bank",      color: "#8d6adf", ang: 0,                dist: BASE_DIST, shop: true },
    { name: "South Team Bank",     color: "#efc74b", ang: Math.PI / 2,      dist: BASE_DIST, shop: true },
    { name: "Southwest Team Bank", color: "#3d7cf0", ang: 3 * Math.PI / 4,  dist: BASE_DIST },
    { name: "West Team Bank",      color: "#ec7b0f", ang: Math.PI,          dist: BASE_DIST, shop: true },
];

const SIDE_VAULT_DIST = 0.52;
const VAULTS = [
    { name: "Gem Nest",      x: 0, y: 0, lobby: true },
    { name: "Ridge Vault",   x: Math.cos(-3 * Math.PI / 4) * SIDE_VAULT_DIST, y: Math.sin(-3 * Math.PI / 4) * SIDE_VAULT_DIST },
    { name: "Basin Vault",   x: Math.cos(Math.PI / 4) * SIDE_VAULT_DIST,      y: Math.sin(Math.PI / 4) * SIDE_VAULT_DIST },
];

// One shop per cardinal base, halfway out on the same ray.
const SHOP_DIST = 0.38;
const SHOPS = OUTPOSTS.filter(o => o.shop).map((o, i) => ({
    id: i,
    name: o.name.replace(" Team Bank", " Shop"),
    ang: o.ang,
    dist: SHOP_DIST,
    color: o.color,
}));

// drop pits on the 16-tile map; bigger maps get more at the same spacing
// (mapScale.area), so a spawn is never farther from a ready-made gap
const SPAWN_PITS_REF = 48;
const mapScale = require('./mapScale.js');
const TeamLayout = require('./teamLayout.js');
const OpenLayout = require('./openLayout.js');
const VAULT_R = 115;
const OUTPOST_R = 135;
const SHOP_R = 110;
const CENTER_CLEAR_R = 145;
const NEST_R_FRAC = 0.16; // Center rich ore zone (~670 world units radius)

function nearestRock(grid, wx, wy) {
    let best = null, bestD = Infinity;
    for (const rock of grid.rocks.values()) {
        if (!rock.alive || !rock.worldPoly) continue;
        const dx = (rock.worldCx || rock.wx) - wx;
        const dy = (rock.worldCy || rock.wy) - wy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = rock; }
    }
    return best;
}

function killRock(rock, canyonKeys) {
    if (!rock) return;
    canyonKeys.add(rock.k);
    rock.alive = false;
    rock.health = 0;
    rock.diedAt = 0;
    rock.canyon = true;
    rock.ore = ORE.NONE;
    rock.deposits = null;
}

function broadcastKills(grid, beforeAlive) {
    if (!grid.rockEvents) return;
    for (const rock of grid.rocks.values()) {
        if (beforeAlive.has(rock.k) && !rock.alive) {
            grid.rockEvents.push({ k: rock.k, h: 0, d: 1 });
        }
    }
}

function carveMatchPois(grid) {
    if (!grid) return;
    const canyonKeys = grid._canyonKeys || new Set();
    const before = new Set();
    for (const rock of grid.rocks.values()) if (rock.alive) before.add(rock.k);
    for (const v of (grid.vaultSites || [])) {
        const r = (v.x === 0 && v.y === 0) ? 0 : VAULT_R;
        if (r > 0) carveDisk(grid, v.x, v.y, r, canyonKeys);
    }
    const list = grid.outpostSites || [];
    for (const o of list) carveDisk(grid, o.x, o.y, OUTPOST_R, canyonKeys);
    for (const s of (grid.shopSites || [])) carveDisk(grid, s.x, s.y, SHOP_R, canyonKeys);
    grid._canyonKeys = canyonKeys;
    broadcastKills(grid, before);
}

function carveDisk(grid, wx, wy, r, canyonKeys) {
    const killR = r + 70;
    const r2 = killR * killR;
    for (const rock of grid.rocks.values()) {
        if (!rock.alive) continue;
        const dx = (rock.worldCx || rock.wx) - wx;
        const dy = (rock.worldCy || rock.wy) - wy;
        if (dx * dx + dy * dy <= r2) {
            killRock(rock, canyonKeys);
            continue;
        }
        if (!rock.worldPoly) continue;
        for (const p of rock.worldPoly) {
            const px = p[0] - wx, py = p[1] - wy;
            if (px * px + py * py <= r * r) {
                killRock(rock, canyonKeys);
                break;
            }
        }
    }
}

function touchesOpen(grid, rock) {
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = grid.rocks.get((rock.vi + di) * 100003 + (rock.vj + dj));
        if (n && !n.alive) return true;
    }
    return false;
}

const teamsOn = () => typeof Config !== 'undefined' && !!Config.royale_teams && !Config.tutorial;

function openLayoutPois(grid, circleR, o) {
    const pois = [];
    if (teamsOn()) {
        for (const v of grid.vaultSites || []) {
            const centre = v.x === 0 && v.y === 0;
            pois.push({ kind: 'vault', x: v.x, y: v.y, r: centre ? o.center_plaza : o.vault_plaza, pad: centre ? CENTER_CLEAR_R + 110 : VAULT_R + 145 });
        }
        for (const s of grid.shopSites || []) pois.push({ kind: 'shop', x: s.x, y: s.y, r: o.shop_plaza });
        for (const t of TeamLayout.TEAMS) {
            const st = TeamLayout.sitesFor(t);
            pois.push({ kind: 'bank', x: st.mouth.x, y: st.mouth.y, r: o.bank_plaza });
            pois.push({ kind: 'bank', x: st.pad.x, y: st.pad.y, r: o.shop_plaza });
        }
        return pois;
    }
    for (const v of grid.vaultSites || []) {
        const centre = v.x === 0 && v.y === 0;
        pois.push({ kind: 'vault', x: v.x, y: v.y, r: centre ? o.center_plaza : o.vault_plaza, pad: centre ? CENTER_CLEAR_R + 110 : VAULT_R + 145 });
    }
    for (const s of grid.shopSites || []) pois.push({ kind: 'shop', x: s.x, y: s.y, r: o.shop_plaza });
    for (const spec of OUTPOSTS) {
        pois.push({
            kind: 'bank',
            x: Math.cos(spec.ang) * spec.dist * circleR,
            y: Math.sin(spec.ang) * spec.dist * circleR,
            r: o.bank_plaza,
        });
    }
    return pois;
}

function carveOpenLayout(grid, circleR, canyonKeys, cfg) {
    const o = OpenLayout.settings(cfg);
    if (!o) return null;
    const res = OpenLayout.plan(grid, circleR, openLayoutPois(grid, circleR, o), o);
    if (!res) return null;
    for (const rock of res.carve) killRock(rock, canyonKeys);
    if (o.ore_share > 0) grid.oreShare = o.ore_share;
    grid.openLayout = { cells: res.cells, open: res.open, forced: res.forced, pillars: res.pillars, links: res.links };
    return res;
}

function rockAt(grid, buckets, x, y, maxD) {
    const B = 140;
    const bx = Math.floor(x / B), by = Math.floor(y / B);
    let best = null, bd = maxD * maxD;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const list = buckets.get((bx + i) + ',' + (by + j));
        if (!list) continue;
        for (const r of list) {
            const dx = (r.worldCx || r.wx) - x, dy = (r.worldCy || r.wy) - y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = r; }
        }
    }
    return best;
}

function symmetrize(grid, canyonKeys) {
    const B = 140;
    const buckets = new Map();
    for (const r of grid.rocks.values()) {
        const x = r.worldCx || r.wx, y = r.worldCy || r.wy;
        const k = Math.floor(x / B) + ',' + Math.floor(y / B);
        let list = buckets.get(k);
        if (!list) buckets.set(k, list = []);
        list.push(r);
    }
    const done = new Set();
    const rim = (grid.circleRadius || 4200) - 320;
    for (const a of grid.rocks.values()) {
        const x = a.worldCx || a.wx, y = a.worldCy || a.wy;
        if (!(y < 0 || (y === 0 && x < 0)) || done.has(a)) continue;
        if (x * x + y * y > rim * rim) continue;
        const b = rockAt(grid, buckets, -x, -y, 100);
        if (!b || b === a || done.has(b)) continue;
        done.add(a); done.add(b);
        if (a.alive && !b.alive) { killRock(a, canyonKeys); continue; }
        if (b.alive && !a.alive) { killRock(b, canyonKeys); continue; }
        if (!a.alive) continue;
        if (canyonKeys.has(a.k) || canyonKeys.has(b.k)) continue;
        b.ore = a.ore;
        b.maxHealth = grid.plainRockHealth * (ORE_HP[b.ore] || 1) * rockTough(b, b.ore);
        b.health = b.maxHealth;
        if (b.ore) { try { b.deposits = grid._buildDeposits(b); } catch { b.deposits = null; } }
        else b.deposits = null;
    }
}

function carveTeamZones(grid, canyonKeys) {
    const zones = TeamLayout.clearZones();
    for (const rock of grid.rocks.values()) {
        if (!rock.alive) continue;
        const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
        if (TeamLayout.inClearZone(x, y, zones)) { killRock(rock, canyonKeys); continue; }
        if (!rock.worldPoly) continue;
        for (const p of rock.worldPoly) {
            if (TeamLayout.inClearZone(p[0], p[1], zones)) { killRock(rock, canyonKeys); break; }
        }
    }
}

// Deterministic 0..1 roll so ore splits evenly across the disk.
function hash01(x, y, s) {
    let h = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 1284865837) ^
             Math.imul((s | 0) + 1, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1540483477);
    h ^= h >>> 15;
    return (h >>> 0) / 0x100000000;
}

// Radial ore for the BR disk. depth = dist/circleR (0 centre, 1 rim). The rim
// is riskiest (storm) so it pays best. Rolls are deterministic per rock +
// oreSalt. Only the server rolls; clients get the result in TG / TR.
// The rock's biome (bOre, bUp from setBiomes) leans on it a little: fewer
// rolls hit out in the sandstone, more in the magma and obsidian, and some
// copper near the centre comes up as vein.
const ORE_SHARE = 0.24;
function oreShareOf(grid) { return grid && grid.oreShare > 0 ? grid.oreShare : ORE_SHARE; }

function radialOre(rock, circleR, salt, share) {
    const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
    const d = Math.min(1, Math.hypot(x, y) / Math.max(1, circleR));
    if (global.royaleMods && global.royaleMods.ore === 'copper') return ORE.COPPER;
    const t = hash01(rock.vi, rock.vj, salt + 102);
    // Central Pentagon Nest (d <= NEST_R_FRAC): every rock in the center has ore —
    // mostly Core Shard (52%) and Emerald (24%), with Azurite Vein (16%) and Copper (8%).
    if (d <= NEST_R_FRAC) {
        return t < 0.24 ? ORE.EMERALD : t < 0.76 ? ORE.SHARD : t < 0.92 ? ORE.VEIN : ORE.COPPER;
    }
    const r1 = hash01(rock.vi, rock.vj, salt + 101);
    const odds = share > 0 ? share : oreShareOf(global.gameManager && global.gameManager.terrainGrid);
    if (r1 >= odds * (rock.bOre || 1)) return ORE.NONE;
    let ore;
    if (d <= 0.65) ore = t < 0.35 ? ORE.VEIN : t < 0.85 ? ORE.COPPER : ORE.NONE; // mid: vein + copper
    else ore = t < 0.12 ? ORE.SHARD : t < 0.52 ? ORE.VEIN : t < 0.90 ? ORE.COPPER : ORE.NONE; // rim: shards live here
    if (ore === ORE.COPPER && rock.bUp > 0 && hash01(rock.vi, rock.vj, salt + 103) < rock.bUp) ore = ORE.VEIN;
    return ore;
}

// Every rock's biome numbers, from shared/rockBiomes.js (the client colours
// the same rocks from the same function and seed, so nothing per rock is
// sent). Static per lattice cell: set once here, a regrown rock keeps them.
// bHard is the biome's toughness (times the ore's, see rockTough in
// terrainGrid.js), bOre the ore chance, bUp the copper -> vein share. seed 0
// (the tutorial) leaves every rock at 1 with no biome.
function setBiomes(grid, seed) {
    grid.biomeSeed = seed | 0;
    const st = {};
    for (const rock of grid.rocks.values()) {
        if (!grid.biomeSeed) { rock.bHard = 1; rock.bOre = 1; rock.bUp = 0; rock.biome = -1; continue; }
        Biomes.rockStats(rock.vi, rock.vj, grid.cols, grid.rows, grid.biomeSeed, st);
        rock.bHard = st.hard; rock.bOre = st.ore; rock.bUp = st.up; rock.biome = st.biome;
    }
}

function apply(grid, { canyonKeys, outpostCells, chamberCells }) {
    const room = global.gameManager && global.gameManager.room;
    const half = Math.min(room?.width || 5460, room?.height || 5460) / 2;
    const circleR = half * 0.998;
    grid.circleRadius = circleR;
    const SPAWN_PITS = Math.round(SPAWN_PITS_REF * mapScale.area(circleR));
    // the map seed picks the biome layout (same seed, same map every boot);
    // the tutorial's plots are not a raid map, so no biomes there
    const tutorial = typeof Config !== 'undefined' && Config.tutorial;
    setBiomes(grid, tutorial ? 0 : ((grid.mapSeed | 0) || 7));
    grid.lobbyPos = { x: 0, y: 0, r: CENTER_CLEAR_R };

    // Circle map with a raw border: rocks are never cropped to the circle.
    // Whole rocks outside a noisy ring are killed; a rock is kept if its
    // centre is within the keep radius (jittered +-90 per rock) or any vertex
    // touches the disk, so the edge stays jagged Voronoi faces.
    const salt2 = grid.oreSalt || 7;
    const circleR2 = circleR * circleR;
    for (const rock of grid.rocks.values()) {
        if (!rock.alive) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        const jitter = hash01(rock.vi, rock.vj, salt2 + 500) * 180 - 90;
        const keepR = circleR + jitter;
        const keepR2 = keepR * keepR;
        if (rx * rx + ry * ry <= keepR2) continue;
        let touches = false;
        if (rock.worldPoly) {
            for (const p of rock.worldPoly) {
                const px = p[0], py = p[1];
                if (px * px + py * py <= circleR2) { touches = true; break; }
            }
        }
        if (!touches) killRock(rock, canyonKeys);
    }

    // Sites are recorded now, and their holes are carved before open_layout
    // plans plazas/corridors and before spawnPits are sampled.
    const teams = teamsOn();
    grid.teamMode = teams;
    grid.vaultSites = teams ? TeamLayout.vaultSites() : VAULTS.map((v, i) => {
        const x = v.x * circleR, y = v.y * circleR;
        return { id: i, name: v.name, x, y, r: 95, team: 0, rainbow: true };
    });
    grid.shopSites = teams ? TeamLayout.shopSites() : SHOPS.map(s => ({
        id: s.id,
        name: s.name,
        x: Math.cos(s.ang) * s.dist * circleR,
        y: Math.sin(s.ang) * s.dist * circleR,
        r: 95,
        color: s.color,
    }));
    if (teams) carveTeamZones(grid, canyonKeys);
    carveDisk(grid, 0, 0, CENTER_CLEAR_R, canyonKeys);
    for (const v of grid.vaultSites) {
        if (v.x !== 0 || v.y !== 0) carveDisk(grid, v.x, v.y, VAULT_R, canyonKeys);
    }
    for (const s of grid.shopSites) carveDisk(grid, s.x, s.y, SHOP_R, canyonKeys);

    chamberCells.length = 0;
    outpostCells.length = 0;
    for (const spec of teams ? [] : OUTPOSTS) {
        const x = Math.cos(spec.ang) * spec.dist * circleR;
        const y = Math.sin(spec.ang) * spec.dist * circleR;
        carveDisk(grid, x, y, OUTPOST_R, canyonKeys);
        const rock = nearestRock(grid, x, y) || { k: 0, worldCx: x, worldCy: y };
        outpostCells.push({
            key: rock.k,
            name: spec.name,
            color: spec.color,
            x, y,
        });
    }

    const terrainCfg = typeof Config !== 'undefined' && Config.dig_royale_terrain;
    if (!tutorial && terrainCfg && terrainCfg.open_layout) carveOpenLayout(grid, circleR, canyonKeys, terrainCfg.open_layout);

    // Re-roll ore radially: buildVoronoi assigned 2TDM's horizontal depth
    // tiers, which mean nothing on a circle.
    const salt = grid.oreSalt || 7;
    for (const rock of grid.rocks.values()) {
        if (!rock.alive || canyonKeys.has(rock.k)) continue;
        const ore = radialOre(rock, circleR, salt, oreShareOf(grid));
        rock.ore = ore;
        // plain rock too: biome x ore toughness
        rock.maxHealth = grid.plainRockHealth * (ORE_HP[ore] || 1) * rockTough(rock, ore);
        rock.health = rock.maxHealth;
        if (ore) {
            try { rock.deposits = grid._buildDeposits(rock); }
            catch { rock.deposits = null; }
        } else {
            rock.deposits = null;
        }
    }

    // Emeralds: exactly 3 on the 16-tile map (4 on the 20-tile one: one per
    // mapScale.lin x 3, rounded), in equal sectors at mid-rim so no quadrant
    // starves. Deepest deterministic candidates per sector win.
    try {
        const nEm = Math.max(3, Math.round(3 * mapScale.lin(circleR)));
        const sectors = [];
        for (let i = 0; i < nEm; i++) sectors.push([-Math.PI + i * 2 * Math.PI / nEm, -Math.PI + (i + 1) * 2 * Math.PI / nEm]);
        const alive = [...grid.rocks.values()].filter(r =>
            r.alive && !canyonKeys.has(r.k) && r.ore !== ORE.EMERALD);
        for (const [a0, a1] of sectors) {
            let best = null, bestScore = Infinity;
            for (const rock of alive) {
                const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
                const d = Math.hypot(x, y) / circleR;
                if (d < 0.45 || d > 0.9) continue;
                let a = Math.atan2(y, x);
                // the middle 70% of the sector, so two neighbours' picks
                // never end up side by side on their shared edge
                const pad = (a1 - a0) * 0.15;
                const inSector = a >= a0 + pad && a <= a1 - pad;
                if (!inSector) continue;
                const score = hash01(rock.vi, rock.vj, salt + 777);
                if (score < bestScore) { bestScore = score; best = rock; }
            }
            if (best) {
                best.ore = ORE.EMERALD;
                best.maxHealth = grid.plainRockHealth * (ORE_HP[ORE.EMERALD] || 6) * rockTough(best, ORE.EMERALD);
                best.health = best.maxHealth;
                try { best.deposits = grid._buildDeposits(best); } catch { best.deposits = null; }
            }
        }
    } catch { /* emeralds stay as rolled */ }

    if (teams) { carveTeamZones(grid, canyonKeys); symmetrize(grid, canyonKeys); }

    const blocked = [];
    for (const v of grid.vaultSites) blocked.push({ x: v.x, y: v.y, r: 380 });
    for (const s of grid.shopSites) blocked.push({ x: s.x, y: s.y, r: 340 });
    if (teams) for (const t of TeamLayout.TEAMS) {
        const c = TeamLayout.baseCenter(t);
        blocked.push({ x: c.x, y: c.y, r: 1500 });
        const st = TeamLayout.sitesFor(t);
        blocked.push({ x: st.mouth.x, y: st.mouth.y, r: 900 });
    }
    for (const o of teams ? [] : OUTPOSTS) {
        blocked.push({
            x: Math.cos(o.ang) * o.dist * circleR,
            y: Math.sin(o.ang) * o.dist * circleR,
            r: 320,
        });
    }

    const candidates = [];
    const pitsInsideRock = !!grid.openLayout;
    for (const rock of grid.rocks.values()) {
        // a pit is a killed rock: never one of the emeralds placed above
        if (!rock.alive || canyonKeys.has(rock.k) || rock.ore === ORE.EMERALD) continue;
        if (pitsInsideRock && touchesOpen(grid, rock)) continue;
        const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
        const d = Math.hypot(x, y);
        if (d < CENTER_CLEAR_R + 80 || d > circleR - 160) continue;
        let ok = true;
        for (const b of blocked) {
            const dx = x - b.x, dy = y - b.y;
            if (dx * dx + dy * dy < b.r * b.r) { ok = false; break; }
        }
        if (ok) candidates.push(rock);
    }

    const pits = [];
    const minSep = 310;
    // farthest-point sampling so drop holes are not clustered
    if (candidates.length) {
        pits.push(candidates[(Math.random() * candidates.length) | 0]);
        while (pits.length < SPAWN_PITS && pits.length < candidates.length) {
            let best = null, bestMin = -1;
            for (const rock of candidates) {
                if (pits.includes(rock)) continue;
                const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
                let nearest = Infinity;
                for (const p of pits) {
                    const px = p.worldCx || p.wx, py = p.worldCy || p.wy;
                    const d = (x - px) * (x - px) + (y - py) * (y - py);
                    if (d < nearest) nearest = d;
                }
                if (nearest > bestMin) { bestMin = nearest; best = rock; }
            }
            if (!best || bestMin < minSep * minSep * 0.35) break;
            pits.push(best);
        }
    }
    for (const rock of pits) killRock(rock, canyonKeys);
    grid.spawnPits = pits.map(rock => ({
        x: rock.worldCx || rock.wx,
        y: rock.worldCy || rock.wy,
    }));
    if (!grid.spawnPits.length) {
        for (let i = 0; i < SPAWN_PITS; i++) {
            const a = (i / SPAWN_PITS) * Math.PI * 2;
            grid.spawnPits.push({
                x: Math.cos(a) * circleR * 0.48,
                y: Math.sin(a) * circleR * 0.48,
            });
        }
    }
    while (grid.spawnPits.length < SPAWN_PITS) {
        const i = grid.spawnPits.length;
        const a = (i + 0.5) * 2.399963;
        const r = circleR * (0.42 + 0.06 * (i % 3));
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        carveDisk(grid, x, y, 70, canyonKeys);
        grid.spawnPits.push({ x, y });
    }

    // Rocks around every spawn pit and the lobby plaza are softened: same ore,
    // 30% of a flat rock's health whatever the biome (obsidian round the
    // plaza is as soft as anywhere), the old flat gem pay, never emeralds.
    // h stays 1 so no crack visuals.
    try {
        const step = grid.cellSize || 200;
        const zones = [];
        for (const p of grid.spawnPits) zones.push({ x: p.x, y: p.y, r: step * 1.6 });
        for (const rock of grid.rocks.values()) {
            if (!rock.alive || rock.ore === ORE.EMERALD) continue;
            const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
            let soft = false;
            for (const z of zones) {
                const dx = rx - z.x, dy = ry - z.y;
                if (dx * dx + dy * dy <= z.r * z.r) { soft = true; break; }
            }
            if (!soft) continue;
            rock.maxHealth = Math.max(10, grid.plainRockHealth * (ORE_HP[rock.ore] || 1) * 0.3);
            rock.health = rock.maxHealth;
            rock.soft = true;
        }
    } catch { /* spawns stay normal strength */ }
}

module.exports = { apply, carveMatchPois, carveOpenLayout, openLayoutPois, OUTPOSTS, SHOPS, ORE, ORE_SHARE, oreShareOf, radialOre, setBiomes, hash01, carveDisk, killRock };
