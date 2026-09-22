const { ORE, ORE_HP } = require('./terrainGrid.js');

// Six bases on one ring: the four cardinals plus the NE/SW diagonals. The
// two side vaults sit on the other diagonals (NW/SE) so every 45 degrees
// holds a landmark and the ring reads balanced from any seat.
const BASE_DIST = 0.70;
const OUTPOSTS = [
    { name: "North Base Bank",     color: "#e03e41", ang: -Math.PI / 2,     dist: BASE_DIST, shop: true },
    { name: "Northeast Base Bank", color: "#8abc3f", ang: -Math.PI / 4,     dist: BASE_DIST },
    { name: "East Base Bank",      color: "#8d6adf", ang: 0,                dist: BASE_DIST, shop: true },
    { name: "South Base Bank",     color: "#efc74b", ang: Math.PI / 2,      dist: BASE_DIST, shop: true },
    { name: "Southwest Base Bank", color: "#3d7cf0", ang: 3 * Math.PI / 4,  dist: BASE_DIST },
    { name: "West Base Bank",      color: "#ec7b0f", ang: Math.PI,          dist: BASE_DIST, shop: true },
];

const SIDE_VAULT_DIST = 0.52;
const VAULTS = [
    { name: "Center Vault", x: 0, y: 0, lobby: true },
    { name: "Ridge Vault",  x: Math.cos(-3 * Math.PI / 4) * SIDE_VAULT_DIST, y: Math.sin(-3 * Math.PI / 4) * SIDE_VAULT_DIST },
    { name: "Basin Vault",  x: Math.cos(Math.PI / 4) * SIDE_VAULT_DIST,      y: Math.sin(Math.PI / 4) * SIDE_VAULT_DIST },
];

// One shop per cardinal base, halfway out on the same ray.
const SHOP_DIST = 0.38;
const SHOPS = OUTPOSTS.filter(o => o.shop).map((o, i) => ({
    id: i,
    name: o.name.replace(" Base Bank", " Shop"),
    ang: o.ang,
    dist: SHOP_DIST,
    color: o.color,
}));

const SPAWN_PITS = 48;
const VAULT_R = 115;
const OUTPOST_R = 135;
const SHOP_R = 110;
const CENTER_CLEAR_R = 150;

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

// Deterministic 0..1 roll so ore splits evenly across the disk.
function hash01(x, y, s) {
    let h = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 1284865837) ^
             Math.imul((s | 0) + 1, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1540483477);
    h ^= h >>> 15;
    return (h >>> 0) / 0x100000000;
}

// Radial ore for the BR disk. depth = dist/circleR (0 center → 1 rim).
// The rim is storm-risk first, so it pays best; the middle stays honest.
// Rolls are deterministic per rock + oreSalt so every client/server agrees
// and the tiers split evenly instead of clustering.
function radialOre(rock, circleR, salt) {
    const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
    const d = Math.min(1, Math.hypot(x, y) / Math.max(1, circleR));
    const r1 = hash01(rock.vi, rock.vj, salt + 101);
    if (r1 >= 0.24) return ORE.NONE; // ~24% of rocks hold ore, spread evenly
    if (global.royaleMods && global.royaleMods.ore === 'copper') return ORE.COPPER;
    const t = hash01(rock.vi, rock.vj, salt + 102);
    if (d <= 0.35) return t < 0.70 ? ORE.COPPER : ORE.NONE;                    // plaza ring: copper only
    if (d <= 0.65) return t < 0.35 ? ORE.VEIN : t < 0.85 ? ORE.COPPER : ORE.NONE; // mid: bread + butter
    return t < 0.10 ? ORE.SHARD : t < 0.50 ? ORE.VEIN : t < 0.90 ? ORE.COPPER : ORE.NONE; // rim: shards live here
}

function apply(grid, { canyonKeys, outpostCells, chamberCells }) {
    const room = global.gameManager && global.gameManager.room;
    const half = Math.min(room?.width || 5460, room?.height || 5460) / 2;
    const circleR = half * 0.998;
    grid.circleRadius = circleR;
    grid.lobbyPos = { x: 0, y: 0, r: CENTER_CLEAR_R };

    // Do not crop rocks to the storm circle. The lattice fills the square
    // like 2TDM; the jagged Voronoi faces ARE the border. Storm is a
    // separate overlay.
    // Circle map, raw border: kill whole rocks outside a noisy ring so the
    // island reads as a circle but no rock is ever sliced to a perfect arc.
    // Center + poly test keeps rocks that touch the disk; per-rock hash
    // jitters the keep radius +-90 so the edge stays jagged like 2TDM.
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

    // Sites exist for later. Lobby is plaza-only: do not punch vault or
    // outpost holes until scatter, or the circle is missing rocks on the sides.
    grid.vaultSites = VAULTS.map((v, i) => {
        const x = v.x * circleR, y = v.y * circleR;
        return { id: i, name: v.name, x, y, r: 95, team: 0, rainbow: true };
    });
    grid.shopSites = SHOPS.map(s => ({
        id: s.id,
        name: s.name,
        x: Math.cos(s.ang) * s.dist * circleR,
        y: Math.sin(s.ang) * s.dist * circleR,
        r: 95,
        color: s.color,
    }));
    carveDisk(grid, 0, 0, CENTER_CLEAR_R, canyonKeys);

    chamberCells.length = 0;
    outpostCells.length = 0;
    for (const spec of OUTPOSTS) {
        const x = Math.cos(spec.ang) * spec.dist * circleR;
        const y = Math.sin(spec.ang) * spec.dist * circleR;
        const rock = nearestRock(grid, x, y) || { k: 0, worldCx: x, worldCy: y };
        outpostCells.push({
            key: rock.k,
            name: spec.name,
            color: spec.color,
            x, y,
        });
    }

    // Re-roll ore radially so gems work across the WHOLE disk and split
    // evenly. buildVoronoi assigned horizontal 2TDM depth tiers before this
    // ran, which is meaningless on a circle.
    const salt = grid.oreSalt || 7;
    for (const rock of grid.rocks.values()) {
        if (!rock.alive || canyonKeys.has(rock.k)) continue;
        const ore = radialOre(rock, circleR, salt);
        rock.ore = ore;
        if (ore) {
            rock.maxHealth = (grid.baseRockHealth * 1.3) * (ORE_HP[ore] || 1);
            rock.health = rock.maxHealth;
            try { rock.deposits = grid._buildDeposits(rock); }
            catch { rock.deposits = null; }
        } else {
            rock.deposits = null;
        }
    }

    // Emeralds: exactly 3, spread 120° apart at mid-rim so no quadrant
    // starves. Deepest deterministic candidates per sector win.
    try {
        const sectors = [[-Math.PI, -Math.PI / 3], [-Math.PI / 3, Math.PI / 3], [Math.PI / 3, Math.PI]];
        const alive = [...grid.rocks.values()].filter(r =>
            r.alive && !canyonKeys.has(r.k) && r.ore !== ORE.EMERALD);
        for (const [a0, a1] of sectors) {
            let best = null, bestScore = Infinity;
            for (const rock of alive) {
                const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
                const d = Math.hypot(x, y) / circleR;
                if (d < 0.45 || d > 0.9) continue;
                let a = Math.atan2(y, x);
                // normalize test angle into sector check
                const inSector = a >= a0 && a <= a1;
                if (!inSector) continue;
                const score = hash01(rock.vi, rock.vj, salt + 777);
                if (score < bestScore) { bestScore = score; best = rock; }
            }
            if (best) {
                best.ore = ORE.EMERALD;
                best.maxHealth = (grid.baseRockHealth * 1.3) * (ORE_HP[ORE.EMERALD] || 6);
                best.health = best.maxHealth;
                try { best.deposits = grid._buildDeposits(best); } catch { best.deposits = null; }
            }
        }
    } catch { /* emeralds stay as rolled */ }

    const blocked = [];
    for (const v of grid.vaultSites) blocked.push({ x: v.x, y: v.y, r: 380 });
    for (const s of grid.shopSites) blocked.push({ x: s.x, y: s.y, r: 340 });
    for (const o of OUTPOSTS) {
        blocked.push({
            x: Math.cos(o.ang) * o.dist * circleR,
            y: Math.sin(o.ang) * o.dist * circleR,
            r: 320,
        });
    }

    const candidates = [];
    for (const rock of grid.rocks.values()) {
        if (!rock.alive || canyonKeys.has(rock.k)) continue;
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
    // Farthest-point sampling so drop holes are not clustered.
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

    // Rock-in-your-face: every spawn pit and the lobby plaza ring get soft
    // neighbors. Same ore, quarter health - the first crack always comes
    // fast. Emeralds are never softened. h stays 1 so no crack visuals.
    try {
        const step = grid.cellSize || 200;
        const zones = [{ x: 0, y: 0, r: CENTER_CLEAR_R + step * 1.4 }];
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
            rock.maxHealth = Math.max(10, rock.maxHealth * 0.3);
            rock.health = rock.maxHealth;
        }
    } catch { /* spawns stay normal strength */ }
}

module.exports = { apply, carveMatchPois, OUTPOSTS, SHOPS, ORE, radialOre, hash01, carveDisk, killRock };
