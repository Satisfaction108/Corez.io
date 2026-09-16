const { TerrainGrid, CELL } = require('./terrainGrid.js');

const SUBCELLS = 8;

function hash(x, y, seed) {
    let h = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 1284865837) ^ Math.imul((seed | 0) + 1, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1540483477);
    h ^= h >>> 15;
    return (h >>> 0) / 0x100000000;
}

function generate(cfg) {
    const tileCols    = cfg.cols      ?? 15;
    const tileRows    = cfg.rows      ?? 15;
    const tileWidth   = cfg.tileWidth ?? 420;
    const cols        = tileCols * SUBCELLS;
    const rows        = tileRows * SUBCELLS;
    const seed        = cfg.seed ?? 7;

    const grid = new TerrainGrid(cols, rows);

    const lo = Math.max(2, SUBCELLS - 3);

    if (cfg.circle) {
        const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
        const rad = Math.min(cols, rows) / 2 - 0.15;
        const rad2 = rad * rad;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const dx = c - cx, dy = r - cy;
                if (dx * dx + dy * dy > rad2) grid.set(c, r, CELL.EMPTY);
            }
        }
    } else if (!cfg.fullLattice) {
    // Straight left/right carved boundaries: the solid body is a clean
    // rectangle. The natural-looking rocky border comes from the Voronoi
    // cells that overlap the rect edge (client render + server colliders).
    const leftEdge  = lo + 2;
    const rightEdge = (cols - 1) - (lo + 2);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < leftEdge; c++)         grid.set(c, r, CELL.EMPTY);
        for (let c = rightEdge + 1; c < cols; c++) grid.set(c, r, CELL.EMPTY);
    }
    }
    // fullLattice (Dig Royale): every cell stays solid. Side-empty strips are
    // 2TDM base lanes; on a circle they show up as missing rock on east/west.
    // Top/bottom are NOT carved: no bases there, so rock fills full height and
    // covers all empty space. The jagged top/bottom silhouette is added on the
    // client in _smoothClipLoop (jagged outward, not by removing cells).

grid.cellSize        = tileWidth / SUBCELLS;
    grid.subCellsPerTile = SUBCELLS;
    grid.tileCols        = tileCols;
    grid.tileRows        = tileRows;
    grid.leftSafeCol     = 0;
    grid.rightSafeCol    = tileCols - 1;
    return grid;
}

module.exports = { generate, hash, SUBCELLS };
