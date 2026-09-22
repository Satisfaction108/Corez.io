// TUTORIAL PLOTS
//
// The engine runs one shared room per server process, so "every learner gets
// their own world" is bought a different way: the room is carved into a grid of
// ARENAS, each one a miniature of the real dig-wars map, separated by a gutter
// wide enough that no learner can ever see into a neighbour's arena.
//
// ── what an arena looks like ──────────────────────────────────────────────
// PLOT_TILES x PLOT_TILES tiles, a small Dig Royale practice ground:
//
//     col  0      : the vault pad, on the learner's side
//     cols 1-2    : open ground - spawn, practice bots, the shop pad, the drill
//     cols 3-8    : the rock wall, split by a corridor at y = 0 with the
//                   practice base pad where the corridor crosses the middle
//     cols 9-11   : open ground on the far side (no team bases: Dig Royale
//                   has no teams)
//
// ── why rocks are shaped by KILLING them ──────────────────────────────────
// The cell grid does NOT decide where rock exists. buildContour() reads the
// cells only to derive the voronoi lattice bounds (viLo/viHi/vjLo/vjHi) and
// then fills that whole rectangle with rocks - every lattice cell in range
// becomes a real collider whether the cells under it are solid or not. The
// previous version of this file carved elliptical patches into the cells and
// assumed that removed the rock; it did not. It left the entire room full of
// invisible colliders.
//
// So: carveTerrain() fills the cells SOLID (giving lattice bounds that cover
// the room), and sculpt() then kills every rock that should not exist. Dead
// rocks ride the 'TG' snapshot as `{k, h:0, d:1}`, and the client's renderer
// drops exactly those keys - so client and server agree without either of them
// re-deriving the layout. The voronoi geometry itself is never touched, which
// is what keeps the four mirrored implementations in sync.
//
// Cells must NOT be modified after buildContour(): the client recomputes the
// lattice bounds from the transmitted cell array, so changing them post-hoc
// would shift every rock key by a different amount on each side.

const { CELL, ORE, ORE_HP } = require('./terrainGrid.js');

const TILE = 420;          // world units per room tile (Config.map_tile_width)
const SUBCELLS = 8;        // terrain cells per tile, matches mapGen.SUBCELLS

// The arena a learner actually plays in, and the dead space around it.
//
// The gutter is sized from what can reach the screen, not from taste. Entities
// are culled by sockets.eyes() at roughly camera.fov (~2000) across and
// fov*0.5625 (~1125) down - but TERRAIN is never culled, so a neighbour's rock
// wall appears the moment it falls inside the viewport, which is about the same
// distance and grows with the FOV stat.
//
// The nearest thing in a neighbouring arena is that wall: 3 tiles (1260) in
// from the left/right edge and 2 tiles (840) down from the top, less roughly
// 100 units of polygon overhang. A 3-tile gutter (1260) puts it ~2400 away
// horizontally and ~2000 vertically, so a learner pinned against their own
// fence sees nothing but empty ground on every side.
const PLOT_TILES   = 12;
const GUTTER_TILES = 3;
const PITCH_TILES  = PLOT_TILES + GUTTER_TILES;   // arena-to-arena spacing

// A SQUARE grid on purpose: it makes the room a whole number of pitches on
// both axes, so the in-game full map can lock to exactly one arena with a
// single zoom factor (room / arena) - see app.js. A non-square grid needs a
// different zoom per axis and bleeds the neighbouring arenas into view.
const PLOT_COLS = 2;       // 2 x 2 = 4 concurrent learners
const PLOT_ROWS = 2;

const PLOT_SIZE    = PLOT_TILES * TILE;    // 5040 - one arena across
const PITCH_SIZE   = PITCH_TILES * TILE;   // 5880 - arena + gutter
const ROOM_TILES_X = PLOT_COLS * PITCH_TILES;
const ROOM_TILES_Y = PLOT_ROWS * PITCH_TILES;

// ─── arena layout ─────────────────────────────────────────────────────────
// Everything below is in FRACTIONS of PLOT_SIZE, measured from the arena
// centre, so retuning PLOT_TILES moves the furniture with it.

// Centre of arena tile column/row `i`, as a fraction of PLOT_SIZE.
const AT = (i) => (i + 0.5) / PLOT_TILES - 0.5;
// Edge of arena tile column/row `i` (its low side).
const AE = (i) => i / PLOT_TILES - 0.5;

const BASE_COL_BLUE = 0;                 // friendly base column
const BASE_COL_RED  = PLOT_TILES - 1;    // lethal enemy base column

// The rock wall, in arena tile coordinates. Inset from the top and bottom so
// the gutter maths above holds on the vertical axis too.
const ROCK_COL0 = 3, ROCK_COL1 = 8;
const ROCK_ROW0 = 2, ROCK_ROW1 = 9;

// The corridor cut through the wall at y = 0, linking the two open fields via
// the chambers and the outpost. Half-height as a fraction of PLOT_SIZE; 0.055
// is 277 units, comfortably wider than a tank and wider than a chamber ring's
// clearance requirement (CHAMBER_RADIUS 160 + 26 margin).
const CORRIDOR_HALF = 0.055;

const LAYOUT = {
    // Just outside the friendly base, facing the wall.
    spawn:       { x: -0.40,          y:  0.00 },
    // Vaults sit at the centre of their own base column, exactly as vault.js
    // places them in the real game.
    vaultBlue:   { x: AT(BASE_COL_BLUE), y: 0.00 },
    vaultRed:    { x: AT(BASE_COL_RED),  y: 0.00 },
    // "base" is the LETHAL one - the lesson points here and the guard below
    // keeps everyone out of it.
    base:        { x: AT(BASE_COL_RED),  y: 0.00 },
    homeBase:    { x: AT(BASE_COL_BLUE), y: 0.00 },
    // One outpost, dead centre, where the corridor crosses the arena's spine.
    outpost:     { x:  0.00,          y:  0.00 },
    // One chamber per team, buried in the wall either side of the outpost.
    chamberBlue: { x: -0.17,          y:  0.00 },
    chamberRed:  { x:  0.17,          y:  0.00 },
    // Where the mining lesson points: the near face of the wall.
    rocks:       { x: -0.22,          y:  0.00 },
    // Practice targets sit in the open field between base and wall. The view
    // cull is tighter vertically than horizontally, so a target parked far
    // down the arena never reaches the learner's client at all - it simply
    // never appears, and the lesson waits forever on a bot that is "there".
    dummy:       { x: -0.33,          y: -0.10 },
    fighter:     { x: -0.33,          y:  0.10 },
    // Dig Royale chapter. The shop pad sits down the open field so the
    // learner drives to it; the chest and the training boss land beside the
    // learner wherever they are, these are only the fallback anchors.
    shop:        { x: -0.33,          y:  0.20 },
    chest:       { x: -0.36,          y: -0.20 },
    boss:        { x: -0.31,          y:  0.00 },
};

const plotCount = () => PLOT_COLS * PLOT_ROWS;

// Where an arena starts inside its pitch cell, in whole tiles. It has to be an
// integer: base columns are painted as room TILES, so an arena that started
// half a tile in would put its base on a fractional index. An odd gutter is
// therefore split unevenly (1 tile before, 2 after) - which changes only the
// margin at the room border, never the 3-tile gap BETWEEN two arenas.
const PLOT_INSET_TILES = Math.floor((PITCH_TILES - PLOT_TILES) / 2);

// Arena tile origin (top-left arena tile) in ROOM tile coordinates. Used by
// room_tutorial.js to paint the base columns.
function plotTileOrigin(index) {
    const gx = index % PLOT_COLS;
    const gy = Math.floor(index / PLOT_COLS) % PLOT_ROWS;
    return {
        x: gx * PITCH_TILES + PLOT_INSET_TILES,
        y: gy * PITCH_TILES + PLOT_INSET_TILES,
    };
}

// Plot index -> arena centre in world coordinates. Derived from the very same
// tile origin the base columns are painted at, so world geometry and room
// tiles can never drift apart.
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
    return { x: c.x + l.x * PLOT_SIZE, y: c.y + l.y * PLOT_SIZE };
}

// The arena's playable rectangle in world coordinates.
function plotRect(index) {
    const c = plotCenter(index);
    return {
        x0: c.x - PLOT_SIZE / 2, x1: c.x + PLOT_SIZE / 2,
        y0: c.y - PLOT_SIZE / 2, y1: c.y + PLOT_SIZE / 2,
    };
}

// Which arena a world position falls in (-1 when in a gutter or outside).
// Note this is NOT a pure pitch-cell lookup: a point in the gutter belongs to
// nobody, which is what makes it safe to use for "kill everything that is not
// inside somebody's arena".
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
// See the header for why the cells cannot be carved instead.
function carveTerrain(grid) {
    for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) grid.set(c, r, CELL.BASALT);
    }
}

// Deterministic 0..1 roll for a rock, so ore placement is stable across
// restarts and identical for every arena.
function oreRoll(vi, vj, salt) {
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
// { index, lx, ly } with lx/ly as fractions of PLOT_SIZE from the centre.
function localiseRock(rock) {
    const index = plotAt(rock.worldCx, rock.worldCy);
    if (index < 0) return null;
    const c = plotCenter(index);
    return {
        index,
        lx: (rock.worldCx - c.x) / PLOT_SIZE,
        ly: (rock.worldCy - c.y) / PLOT_SIZE,
    };
}

// Is this arena-local point inside the standing rock wall?
function inWall(lx, ly) {
    if (lx < AE(ROCK_COL0) || lx > AE(ROCK_COL1 + 1)) return false;
    if (ly < AE(ROCK_ROW0) || ly > AE(ROCK_ROW1 + 1)) return false;
    if (Math.abs(ly) <= CORRIDOR_HALF) return false;          // the corridor
    // Breathing room around the three structures, in case the corridor is ever
    // narrowed below what a chamber ring needs.
    for (const key of ['outpost']) {
        const p = LAYOUT[key];
        const r = 190 / PLOT_SIZE;
        const dx = lx - p.x, dy = ly - p.y;
        if (dx * dx + dy * dy <= r * r) return false;
    }
    return true;
}

// Shape the rock, then seed the ore. Runs AFTER buildContour(), which is what
// creates the rocks in the first place.
//
// buildContour also runs the live game's room-wide passes (two canyon lanes,
// three emerald cells, a pocket per core-chamber site). All of that is aimed at
// a 15x15 arena with one wall down the middle and is meaningless here, so this
// pass simply overrules it: every rock is re-decided from scratch, and the ones
// those passes killed are revived if they fall inside a wall.
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
        if (!loc || !inWall(loc.lx, loc.ly)) { killRock(rock); continue; }
        rock.ore = ORE.NONE;
        reviveRock(rock, unitHealth);
    }

    seedOres(grid, unitHealth);
}

// "Different types of rock" is the lesson, so ore is placed deliberately
// rather than left to a room-wide depth roll (which, on a room this shape,
// would hand one arena all the emerald and another none).
//
// Two things happen per arena:
//   1. a teaching row - the four rocks nearest the near face of the wall are
//      forced to copper, vein, shard and emerald, so the mining lesson can
//      always show every tier no matter which rock the learner picks;
//   2. a scatter over the rest, richest toward the middle of the wall, so the
//      arena reads like the real map rather than a uniform slab.
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

    for (let i = 0; i < byPlot.length; i++) {
        const list = byPlot[i];
        if (!list.length) continue;

        // 2. scatter first, so the teaching row can overwrite it.
        for (const e of list) {
            // depth: 0 at the wall's faces, 1 at its spine.
            const halfSpan = (AE(ROCK_COL1 + 1) - AE(ROCK_COL0)) / 2;
            const depth = 1 - Math.abs(e.lx - (AE(ROCK_COL0) + halfSpan)) / halfSpan;
            const roll = oreRoll(e.rock.vi, e.rock.vj, grid.oreSalt + 101);
            let ore = ORE.NONE;
            if (roll < 0.06 * depth)      ore = ORE.SHARD;
            else if (roll < 0.20 * depth) ore = ORE.VEIN;
            else if (roll < 0.42)         ore = ORE.COPPER;
            setOre(e.rock, ore);
        }

        // A pair of emeralds deep in the wall, well away from the corridor so
        // they are something to dig toward rather than something to trip over.
        const deep = list
            .filter(e => Math.abs(e.ly) > CORRIDOR_HALF * 2.2)
            .map(e => ({ e, s: oreRoll(e.rock.vi, e.rock.vj, grid.oreSalt + 202) - Math.abs(e.lx) }))
            .sort((a, b) => b.s - a.s);
        for (let k = 0; k < 2 && k < deep.length; k++) setOre(deep[k].e.rock, ORE.EMERALD);

        // 1. the teaching row, nearest the face the learner arrives at.
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

// One outpost dead centre and one core chamber per team, per arena. Replaces
// the lane-based dig-wars sites entirely. Called after buildContour(), which is
// what populates rocks/sites in the first place.
function installSites(grid) {
    grid.outpostSites = [];
    grid.coreChamberSites = [];
    grid.shopSites = [];
    for (let i = 0; i < plotCount(); i++) {
        const sp = plotPoint(i, 'shop');
        grid.shopSites.push({
            id: grid.shopSites.length,
            name: 'Practice Shop',
            x: sp.x, y: sp.y, r: 95, color: '#5ce0d8',
        });
        const o = plotPoint(i, 'outpost');
        grid.outpostSites.push({
            id: grid.outpostSites.length,
            name: 'Practice Base',
            x: o.x, y: o.y,
        });
        // no core chambers: that was Dig Wars, and this ground teaches Dig Royale
    }
}

// One vault pad per arena, on the learner's side of the field. It is on the
// learner's team so vault.js (which is team-aware off the royale server)
// lets them bank on it.
function vaultSites() {
    const out = [];
    for (let i = 0; i < plotCount(); i++) {
        const b = plotPoint(i, 'vaultBlue');
        out.push({ x: b.x, y: b.y, r: 95, team: TEAM_BLUE });
    }
    return out;
}

// ─── keeping learners where they belong ───────────────────────────────────

// The base lesson has to teach that touching a base deletes you - without ever
// deleting anyone. Dying in a tutorial is confusing (the learner does not yet
// know what killed them) and it drops their satchel, which the banking lesson
// then depends on. So the base stays genuinely lethal, and we simply never let
// them reach it: the barrier below stops the tank at the edge on EVERY step,
// not just the one that mentions bases.
const BASE_KEEPOUT = 90;

// The enemy base column in world coordinates, plus the keep-out margin.
function baseRect(index) {
    const c = plotCenter(index);
    return {
        x0: c.x + AE(BASE_COL_RED) * PLOT_SIZE - BASE_KEEPOUT,
        y0: c.y - PLOT_SIZE / 2 - BASE_KEEPOUT,
        x1: c.x + PLOT_SIZE / 2 + BASE_KEEPOUT,
        y1: c.y + PLOT_SIZE / 2 + BASE_KEEPOUT,
    };
}

// Keep a body out of its arena's enemy base.
//
// Two layers, because a purely soft push can be barged through at speed and
// the penalty for getting through is instant death:
//   - an accelerating shove that starts BASE_SOFT units out, so the approach
//     feels like leaning on the room border rather than hitting an invisible
//     pane of glass;
//   - a hard stop right at the keep-out line, which nobody should ever reach.
const BASE_SOFT = 260;

function pushOutOfBase(body, index) {
    const r = baseRect(index);
    // Only the left face matters in practice - the base is a full-height
    // column down the arena's right edge - but the rect handles all four so a
    // body that somehow ends up inside still leaves by the shortest way.
    const softX0 = r.x0 - BASE_SOFT;
    if (body.x > softX0 && body.y > r.y0 && body.y < r.y1) {
        const depth = body.x - softX0;
        if (body.accel) body.accel.x -= depth * 0.06;
        if (body.velocity && body.velocity.x > 0) body.velocity.x *= 0.86;
    }
    if (body.x <= r.x0 || body.x >= r.x1 || body.y <= r.y0 || body.y >= r.y1) return false;

    const dLeft = body.x - r.x0, dRight = r.x1 - body.x;
    const dTop = body.y - r.y0, dBottom = r.y1 - body.y;
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    if (min === dLeft) body.x = r.x0;
    else if (min === dRight) body.x = r.x1;
    else if (min === dTop) body.y = r.y0;
    else body.y = r.y1;
    if (body.velocity) { body.velocity.x *= 0.1; body.velocity.y *= 0.1; }
    return true;
}

// Hold a body inside its own arena.
//
// Without this a learner can simply drive out of the top, bottom or left of
// their arena - the enemy base only blocks the right - and wander into the
// gutter or a neighbour's world, which is precisely what plot isolation is
// supposed to make impossible. The fence sits on the arena boundary, which the
// gutter maths above assumes.
const FENCE_MARGIN = 30;

function keepInPlot(body, index) {
    const r = plotRect(index);
    const m = FENCE_MARGIN;
    let hit = false;
    if (body.x < r.x0 + m) { body.x = r.x0 + m; hit = true; }
    else if (body.x > r.x1 - m) { body.x = r.x1 - m; hit = true; }
    if (body.y < r.y0 + m) { body.y = r.y0 + m; hit = true; }
    else if (body.y > r.y1 - m) { body.y = r.y1 - m; hit = true; }
    if (hit && body.velocity) { body.velocity.x *= 0.1; body.velocity.y *= 0.1; }
    return hit;
}

module.exports = {
    BASE_KEEPOUT, baseRect, pushOutOfBase, keepInPlot, plotRect,
    TILE, PLOT_TILES, GUTTER_TILES, PITCH_TILES, PLOT_COLS, PLOT_ROWS,
    PLOT_SIZE, PITCH_SIZE, ROOM_TILES_X, ROOM_TILES_Y,
    LAYOUT, BASE_COL_BLUE, BASE_COL_RED,
    plotCount, plotCenter, plotPoint, plotTileOrigin, plotAt,
    carveTerrain, sculpt, installSites, vaultSites, seedOres,
};
