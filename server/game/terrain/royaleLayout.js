const { ORE } = require('./terrainGrid.js');

const OUTPOSTS = [
    { name: "North Outpost",     color: "#e03e41", ang: -Math.PI / 2,       dist: 0.70 },
    { name: "Northeast Outpost", color: "#8abc3f", ang: -Math.PI / 2 + 1.05, dist: 0.68 },
    { name: "East Outpost",      color: "#8d6adf", ang: 0,                  dist: 0.70 },
    { name: "South Outpost",     color: "#efc74b", ang: Math.PI / 2,        dist: 0.70 },
    { name: "Southwest Outpost", color: "#3d7cf0", ang: Math.PI / 2 + 0.95, dist: 0.68 },
    { name: "West Outpost",      color: "#ec7b0f", ang: Math.PI,            dist: 0.70 },
];

const VAULTS = [
    { name: "Center Vault", x: 0, y: 0, lobby: true },
    { name: "Ridge Vault",  x: -0.38, y: -0.32 },
    { name: "Basin Vault",  x: 0.36, y: 0.40 },
];

const SPAWN_PITS = 24;
const VAULT_R = 150;
const OUTPOST_R = 135;
const LOBBY_R = 320;

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

function carveDisk(grid, wx, wy, r, canyonKeys) {
    const r2 = r * r;
    for (const rock of grid.rocks.values()) {
        if (!rock.alive) continue;
        const dx = (rock.worldCx || rock.wx) - wx;
        const dy = (rock.worldCy || rock.wy) - wy;
        if (dx * dx + dy * dy <= r2) killRock(rock, canyonKeys);
    }
}

function apply(grid, { canyonKeys, outpostCells, chamberCells }) {
    const room = global.gameManager && global.gameManager.room;
    const half = Math.min(room?.width || 5460, room?.height || 5460) / 2;
    const circleR = half * 0.96;
    grid.circleRadius = circleR;
    grid.lobbyPos = { x: 0, y: 0, r: LOBBY_R };

    const r2 = (circleR + 80) * (circleR + 80);
    for (const rock of grid.rocks.values()) {
        const x = rock.worldCx || rock.wx, y = rock.worldCy || rock.wy;
        if (x * x + y * y > r2) killRock(rock, canyonKeys);
    }

    grid.vaultSites = VAULTS.map((v, i) => {
        const x = v.x * circleR, y = v.y * circleR;
        carveDisk(grid, x, y, v.lobby ? LOBBY_R : VAULT_R, canyonKeys);
        return { id: i, name: v.name, x, y, r: 95, team: 0, rainbow: true };
    });
    carveDisk(grid, 0, 0, LOBBY_R, canyonKeys);

    chamberCells.length = 0;
    outpostCells.length = 0;
    for (const spec of OUTPOSTS) {
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

    const blocked = [];
    for (const v of grid.vaultSites) blocked.push({ x: v.x, y: v.y, r: 380 });
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
        if (d < LOBBY_R + 80 || d > circleR - 160) continue;
        let ok = true;
        for (const b of blocked) {
            const dx = x - b.x, dy = y - b.y;
            if (dx * dx + dy * dy < b.r * b.r) { ok = false; break; }
        }
        if (ok) candidates.push(rock);
    }

    const pits = [];
    const minSep = 420;
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
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            grid.spawnPits.push({
                x: Math.cos(a) * circleR * 0.45,
                y: Math.sin(a) * circleR * 0.45,
            });
        }
    }
}

module.exports = { apply, OUTPOSTS, ORE };
