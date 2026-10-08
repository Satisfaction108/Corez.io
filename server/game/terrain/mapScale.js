// How big this raid map is next to the one the game was tuned on: the 16 x 16
// tile disk (radius ~3352, Sep-Oct 2026). Counts that should keep their
// density (spawn pits, chests, emeralds) scale with area(); distances that
// should stay put (the storm's hold and final circles) divide by lin().
// Both are 1 on that map and on anything smaller (the tutorial, tests that
// build a 13 x 13 grid), so those behave exactly as before.
'use strict';

const REF_R = 16 * 420 / 2 * 0.998;   // royaleLayout circleR on the 16-tile map

// only the raid disk counts: no disk (the tutorial's plots, 2TDM) = scale 1
function radius() {
    const tg = global.gameManager && global.gameManager.terrainGrid;
    if (tg && tg.circleRadius > 0 && !(typeof Config !== 'undefined' && Config.tutorial)) return tg.circleRadius;
    return REF_R;
}
// linear size against the reference map, never below 1
function lin(r = radius()) { return Math.max(1, (+r || REF_R) / REF_R); }
function area(r = radius()) { const k = lin(r); return k * k; }

module.exports = { REF_R, radius, lin, area };
