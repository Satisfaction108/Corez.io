// TUTORIAL PLOTS
//
// The engine runs one shared room per server process, so "every learner gets
// their own world" is bought a different way: the room is carved into a grid of
// ARENAS, separated by a gutter wide enough that no learner can ever see into a
// neighbour's arena.
//
// ── what an arena looks like ──────────────────────────────────────────────
// A small copy of the Dig Royale map: a round island of solid rock with the
// same landmarks the real raid has, in the same visual language.
//
//                         (solid rock, richest ore
//                          and the emeralds up here)
//
//        ( spawn  )=========[ VAULT ]=========[ BASE ]
//        (clearing)             ||
//                               ||
//                            < SHOP >
//
//   - the rainbow vault sits in the middle, exactly like the Center Vault;
//   - the learner starts in a dug-out clearing on the west side, big enough
//     for the practice fights, chests and the training boss;
//   - three tunnels, the kind other miners leave behind, link the clearing,
//     the vault, the practice base (east) and the shop (south);
//   - everything else is rock, with ore graded like the real map: copper near
//     the middle, azurite further out, shards near the rim.
//
// ── why rocks are shaped by KILLING them ──────────────────────────────────
// The cell grid does NOT decide where rock exists. buildContour() reads the
// cells only to derive the voronoi lattice bounds and then fills that whole
// rectangle with rocks - every lattice cell in range becomes a real collider
// whether the cells under it are solid or not.
//
// So: carveTerrain() fills the cells SOLID (giving lattice bounds that cover
// the room), and sculpt() then kills every rock that should not exist. Dead
// rocks ride the 'TG' snapshot as `{k, h:0, d:1}`, and the client's renderer
// drops exactly those keys - so client and server agree without either of them
// re-deriving the layout. The voronoi geometry itself is never touched, which
// is what keeps the four mirrored implementations in sync.
//
// Cells must NOT be modified after buildContour(): the client recomputes the
// lattice bounds from the transmitted cell array.

const { CELL, ORE, ORE_HP } = require('./terrainGrid.js');

const TILE = 420;          // world units per room tile (Config.map_tile_width)

// The arena and the dead space around it.
//
// Terrain is never view-culled, so a neighbour's rock shows up the moment it
// falls inside the viewport (about 2000 across at the default FOV). The island
// is 1900 in radius inside a 2520 half-arena, and learners are fenced to the
// island, so two islands' rims are 2 * 620 + a 3-tile gutter = ~2500 apart:
// nothing but void on every side of your own island.
const PLOT_TILES   = 12;
const GUTTER_TILES = 3;
const PITCH_TILES  = PLOT_TILES + GUTTER_TILES;   // arena-to-arena spacing

// A SQUARE grid on purpose: the in-game full map can lock to exactly one arena
// with a single zoom factor (room / arena) - see app.js.
const PLOT_COLS = 2;       // 2 x 2 = 4 concurrent learners
const PLOT_ROWS = 2;

const PLOT_SIZE    = PLOT_TILES * TILE;    // 5040 - one arena across
const PITCH_SIZE   = PITCH_TILES * TILE;   // 5880 - arena + gutter
const ROOM_TILES_X = PLOT_COLS * PITCH_TILES;
const ROOM_TILES_Y = PLOT_ROWS * PITCH_TILES;

// ─── island layout ────────────────────────────────────────────────────────
// World units from the arena centre.

const ISLAND_R = 1900;
// Soft fence, a little past the rim: the rim rock is the real wall, the fence
// only stops someone who has mined through it from driving into the void.
const FENCE_R = ISLAND_R + 90;

const CLEARING = { x: -960, y: 0, r: 500 };
const VAULT_AT = { x: 0, y: 0 };
const BASE_AT  = { x: 1180, y: 0 };
const SHOP_AT  = { x: 0, y: 820 };

const LAYOUT = {
    // The middle of the dug-out clearing.
    spawn:    { x: CLEARING.x, y: CLEARING.y },
    clearing: { x: CLEARING.x, y: CLEARING.y },
    // The rainbow vault, dead centre like the real Center Vault.
    vault:    VAULT_AT,
    // The practice base (an outpost pad the learner captures).
    outpost:  BASE_AT,
    // The shop pad, down the south tunnel.
    shop:     SHOP_AT,
    // Where the mining lesson looks first: the clearing's north face, where
    // the teaching row of ores is placed.
    rocks:    { x: CLEARING.x, y: CLEARING.y - CLEARING.r },
    // Fallback anchors for things that normally land beside the learner.
    dummy:    { x: CLEARING.x + 280, y: CLEARING.y - 140 },
    fighter:  { x: CLEARING.x + 280, y: CLEARING.y + 140 },
    chest:    { x: CLEARING.x - 200, y: CLEARING.y - 260 },
    boss:     { x: CLEARING.x + 150, y: CLEARING.y },
};

// Holes in the rock. Discs carve the pads and the clearing, capsules carve the
// tunnels between them. Every hole also kills rocks whose centre is within
// r + 70 and any whose corner is within r, so a tunnel of r 60 comes out
// roughly 300 units wide. Pad radii match
// royaleLayout's pad carving.
const HOLES = [
    { kind: 'disc', x: CLEARING.x, y: CLEARING.y, r: CLEARING.r },
    { kind: 'disc', x: VAULT_AT.x, y: VAULT_AT.y, r: 150 },
    { kind: 'disc', x: BASE_AT.x,  y: BASE_AT.y,  r: 170 },
    { kind: 'disc', x: SHOP_AT.x,  y: SHOP_AT.y,  r: 120 },
    { kind: 'tube', x0: CLEARING.x, y0: 0, x1: VAULT_AT.x, y1: 0, r: 60 },
    { kind: 'tube', x0: VAULT_AT.x, y0: 0, x1: BASE_AT.x,  y1: 0, r: 60 },
    { kind: 'tube', x0: 0, y0: VAULT_AT.y, x1: 0, y1: SHOP_AT.y, r: 60 },
];
// A few spawn pits, the small holes players drop into on the real map.
for (const [deg, dist] of [[-62, 1150], [-118, 1250], [-25, 1500], [35, 1250], [140, 1350], [-160, 1500]]) {
    const a = deg * Math.PI / 180;
    HOLES.push({ kind: 'disc', x: Math.cos(a) * dist, y: Math.sin(a) * dist, r: 55 });
}

const plotCount = () => PLOT_COLS * PLOT_ROWS;

// Where an arena starts inside its pitch cell, in whole tiles.
const PLOT_INSET_TILES = Math.floor((PITCH_TILES - PLOT_TILES) / 2);

// Arena tile origin (top-left arena tile) in ROOM tile coordinates.
function plotTileOrigin(index) {
    const gx = index % PLOT_COLS;
    const gy = Math.floor(index / PLOT_COLS) % PLOT_ROWS;
    return {
        x: gx * PITCH_TILES + PLOT_INSET_TILES,
        y: gy * PITCH_TILES + PLOT_INSET_TILES,
    };
}

// Plot index -> arena centre in world coordinates.
function plotCenter(index) {
    const o = plotTileOrigin(index);
    const roomW = ROOM_TILES_X * TILE;
    const roomH = ROOM_TILES_Y * TILE;
    return {
        x: -roomW / 2 + (o.x + PLOT_TILES / 2) * TILE,
        y: -roomH / 2 + (o.y + PLOT_TILES / 2) * TILE,
    };
}

// A named point inside an arena, in world coordinates.
function plotPoint(index, key) {
    const c = plotCenter(index);
    const l = LAYOUT[key];
    if (!l) throw new Error(`tutorialPlots: unknown layout point "${key}"`);
    return { x: c.x + l.x, y: c.y + l.y };
}

// The arena's square in world coordinates (the island sits inside it).
function plotRect(index) {
    const c = plotCenter(index);
    return {
        x0: c.x - PLOT_SIZE / 2, x1: c.x + PLOT_SIZE / 2,
        y0: c.y - PLOT_SIZE / 2, y1: c.y + PLOT_SIZE / 2,
    };
}

// The fence a learner is held inside: a circle just past the island rim.
function plotFence(index) {
    const c = plotCenter(index);
    return { cx: c.x, cy: c.y, r: FENCE_R };
}

// Which arena a world position falls in (-1 when in a gutter or outside).
function plotAt(x, y) {
    const roomW = ROOM_TILES_X * TILE;
    const roomH = ROOM_TILES_Y * TILE;
    const gx = Math.floor((x + roomW / 2) / PITCH_SIZE);
    const gy = Math.floor((y + roomH / 2) / PITCH_SIZE);
    if (gx < 0 || gx >= PLOT_COLS || gy < 0 || gy >= PLOT_ROWS) return -1;
    const index = gy * PLOT_COLS + gx;
    const r = plotRect(index);
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return -1;   // gutter
    return index;
}

// ─── terrain ──────────────────────────────────────────────────────────────

// Fill every cell solid. This is what gives buildContour() lattice bounds that
// span the whole room; the actual shape of the rock is decided by sculpt().
function carveTerrain(grid) {
    for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) grid.set(c, r, CELL.BASALT);
    }
}

// Deterministic 0..1 roll for a rock, so the island is identical for every
// arena and across restarts.
function hash01(vi, vj, salt) {
    let h = (Math.imul(vi + 1, 374761393) ^ Math.imul(vj + 1, 1284865837) ^
             Math.imul((salt | 0) + 1, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1540483477);
    h ^= h >>> 15;
    return (h >>> 0) / 0x100000000;
}

function killRock(rock) {
    rock.alive    = false;
    rock.health   = 0;
    rock.diedAt   = 0;
    rock.canyon   = true;     // canyon rocks never regrow (see terrainGrid)
    rock.growing  = false;
    rock.ore      = ORE.NONE;
    rock.deposits = null;
}

function reviveRock(rock, unitHealth) {
    rock.alive    = true;
    rock.canyon   = false;
    rock.growing  = false;
    rock.diedAt   = 0;
    rock.gen      = 0;
    rock.maxHealth = unitHealth * ORE_HP[rock.ore];
    rock.health    = rock.maxHealth;
}

// Where a rock sits relative to its arena: null when it is in no arena, else
// { index, lx, ly } in world units from the arena centre.
function localiseRock(rock) {
    const index = plotAt(rock.worldCx, rock.worldCy);
    if (index < 0) return null;
    const c = plotCenter(index);
    return { index, lx: rock.worldCx - c.x, ly: rock.worldCy - c.y };
}

// Distance from (px, py) to the segment (x0,y0)-(x1,y1).
function segDist(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
    return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}
function holeDist(h, x, y) {
    return h.kind === 'disc' ? Math.hypot(x - h.x, y - h.y) : segDist(x, y, h.x0, h.y0, h.x1, h.y1);
}

// Does this rock belong on the island? Same rules as royaleLayout: a rock
// survives the rim if its centre is inside a jittered radius or any corner
// touches the circle, so the edge is ragged rock rather than a clean arc; a
// hole kills a rock whose centre is within r + 70 or any corner within r.
function keepRock(rock, loc) {
    const cx = loc.lx, cy = loc.ly;
    const jitter = hash01(rock.vi, rock.vj, 500) * 180 - 90;
    let inside = Math.hypot(cx, cy) <= ISLAND_R + jitter;
    const pts = [];
    if (rock.worldPoly) {
        const ox = rock.worldCx - cx, oy = rock.worldCy - cy;
        for (const p of rock.worldPoly) pts.push([p[0] - ox, p[1] - oy]);
    }
    if (!inside) inside = pts.some(p => Math.hypot(p[0], p[1]) <= ISLAND_R);
    if (!inside) return false;
    for (const h of HOLES) {
        if (holeDist(h, cx, cy) <= h.r + 70) return false;
        if (pts.some(p => holeDist(h, p[0], p[1]) <= h.r)) return false;
    }
    return true;
}

// Shape the rock, then seed the ore. Runs AFTER buildContour(), which is what
// creates the rocks in the first place. buildContour also runs the live game's
// room-wide passes (canyon lanes, emerald cells, chamber pockets), none of
// which mean anything here, so every rock is re-decided from scratch.
function sculpt(grid) {
    // ROCK_HEALTH is not exported, but every rock was built as
    // ROCK_HEALTH * ORE_HP[ore], so one live rock recovers the unit.
    let unitHealth = 0;
    for (const rock of grid.rocks.values()) {
        if (rock.maxHealth > 0) { unitHealth = rock.maxHealth / ORE_HP[rock.ore]; break; }
    }

    for (const rock of grid.rocks.values()) {
        if (!rock.worldPoly) { killRock(rock); continue; }
        const loc = localiseRock(rock);
        if (!loc || !keepRock(rock, loc)) { killRock(rock); continue; }
        rock.ore = ORE.NONE;
        reviveRock(rock, unitHealth);
    }

    seedOres(grid, unitHealth);
}

// Ore graded like the real map (royaleLayout.radialOre): about a quarter of
// rocks carry ore, copper in the middle, azurite further out, shards near the
// rim. On top of that, per arena:
//   - two emeralds deep in the north rock, something to dig toward;
//   - a teaching row: the four rocks nearest the clearing's north face are
//     copper, azurite, shard and emerald, so the mining lesson can always
//     show every tier no matter which rock the learner picks.
function seedOres(grid, unitHealth) {
    if (!unitHealth) {
        for (const rock of grid.rocks.values()) {
            if (rock.maxHealth > 0) { unitHealth = rock.maxHealth / ORE_HP[rock.ore]; break; }
        }
    }

    const byPlot = new Array(plotCount()).fill(null).map(() => []);
    for (const rock of grid.rocks.values()) {
        if (!rock.alive || !rock.worldPoly) continue;
        const loc = localiseRock(rock);
        if (!loc) continue;
        byPlot[loc.index].push({ rock, lx: loc.lx, ly: loc.ly });
    }

    const setOre = (rock, ore) => {
        rock.ore = ore;
        rock.maxHealth = unitHealth * ORE_HP[ore];
        rock.health = rock.maxHealth;
        rock.deposits = ore ? grid._buildDeposits(rock) : null;
    };

    const salt = grid.oreSalt | 0;
    for (let i = 0; i < byPlot.length; i++) {
        const list = byPlot[i];
        if (!list.length) continue;

        for (const e of list) {
            const d = Math.min(1, Math.hypot(e.lx, e.ly) / ISLAND_R);
            const r1 = hash01(e.rock.vi, e.rock.vj, salt + 101);
            const t = hash01(e.rock.vi, e.rock.vj, salt + 102);
            let ore = ORE.NONE;
            if (r1 < 0.26) {
                if (d <= 0.35) ore = t < 0.75 ? ORE.COPPER : ORE.NONE;
                else if (d <= 0.65) ore = t < 0.35 ? ORE.VEIN : t < 0.85 ? ORE.COPPER : ORE.NONE;
                else ore = t < 0.12 ? ORE.SHARD : t < 0.52 ? ORE.VEIN : t < 0.9 ? ORE.COPPER : ORE.NONE;
            }
            setOre(e.rock, ore);
        }

        const deep = list
            .filter(e => e.ly < -500 && Math.hypot(e.lx, e.ly) < ISLAND_R * 0.85)
            .map(e => ({ e, s: hash01(e.rock.vi, e.rock.vj, salt + 202) - Math.abs(e.lx) / ISLAND_R }))
            .sort((a, b) => b.s - a.s);
        let placed = 0;
        for (const { e } of deep) {
            if (placed >= 2) break;
            // keep the pair apart so they read as two finds, not one lump
            if (placed === 1 && Math.hypot(e.lx - deep[0].e.lx, e.ly - deep[0].e.ly) < 700) continue;
            setOre(e.rock, ORE.EMERALD);
            placed++;
        }

        const face = plotPoint(i, 'rocks');
        const near = list
            .map(e => ({
                e,
                d2: (e.rock.worldCx - face.x) ** 2 + (e.rock.worldCy - face.y) ** 2,
            }))
            .sort((a, b) => a.d2 - b.d2);
        const tiers = [ORE.COPPER, ORE.VEIN, ORE.SHARD, ORE.EMERALD];
        for (let k = 0; k < tiers.length && k < near.length; k++) {
            setOre(near[k].e.rock, tiers[k]);
        }
    }
}

// ─── structures ───────────────────────────────────────────────────────────

// One practice base and one shop per arena. Site ids equal the plot index, so
// tutorialSession can reset/unlock "this learner's base" by id.
function installSites(grid) {
    grid.outpostSites = [];
    grid.coreChamberSites = [];
    grid.shopSites = [];
    for (let i = 0; i < plotCount(); i++) {
        const sp = plotPoint(i, 'shop');
        grid.shopSites.push({
            id: i,
            name: 'Practice Shop',
            x: sp.x, y: sp.y, r: 95, color: '#5ce0d8',
        });
        const o = plotPoint(i, 'outpost');
        grid.outpostSites.push({
            id: i,
            name: 'Practice Base',
            x: o.x, y: o.y,
            color: '#ec7b0f',
        });
    }
}

// One rainbow vault per arena, dead centre. It keeps a team so vault.js (which
// is team-aware off the royale server) lets the learner bank on it; learners
// all play on TEAM_BLUE internally, whatever colour their tank is.
function vaultSites() {
    const out = [];
    for (let i = 0; i < plotCount(); i++) {
        const v = plotPoint(i, 'vault');
        out.push({ x: v.x, y: v.y, r: 95, team: TEAM_BLUE, rainbow: true });
    }
    return out;
}

// ─── keeping things where they belong ─────────────────────────────────────

// Hard backstop for scripted bots: snap anything outside the island fence back
// onto it. Learners get the soft push in entity.js instead (arenaBounds).
function keepInPlot(body, index) {
    const f = plotFence(index);
    const dx = body.x - f.cx, dy = body.y - f.cy;
    const d = Math.hypot(dx, dy);
    const lim = f.r - 60;
    if (d <= lim || d === 0) return false;
    body.x = f.cx + dx * (lim / d);
    body.y = f.cy + dy * (lim / d);
    if (body.velocity) { body.velocity.x *= 0.1; body.velocity.y *= 0.1; }
    return true;
}

// Is this point open ground on the island (for dropping a bot or chest)?
function onIsland(index, x, y, margin = 150) {
    const c = plotCenter(index);
    return Math.hypot(x - c.x, y - c.y) <= ISLAND_R - margin;
}

module.exports = {
    keepInPlot, plotRect, plotFence, onIsland,
    TILE, PLOT_TILES, GUTTER_TILES, PITCH_TILES, PLOT_COLS, PLOT_ROWS,
    PLOT_SIZE, PITCH_SIZE, ROOM_TILES_X, ROOM_TILES_Y, ISLAND_R, CLEARING,
    LAYOUT,
    plotCount, plotCenter, plotPoint, plotTileOrigin, plotAt,
    carveTerrain, sculpt, installSites, vaultSites, seedOres,
};
