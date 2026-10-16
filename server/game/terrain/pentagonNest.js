'use strict';

// ── Pentagon Nest (Center Rich Ore Zone) ───────────────────────────────────
// In Corez.io, the "Pentagon Nest" at the center of the map ((0, 0)) is a
// high-value rock field where all rocks around the central vault contain
// Core Shard or Emerald (plus Azurite Vein & Copper), configured in
// royaleLayout.js (`radialOre`). No literal pentagon entities are spawned.

const NEST_R = 950;

function setHooks() {}
function alive() { return []; }
function populateInitial() {}
function tick() {}
function clearAll() {}
function spawnNestPentagon() { return null; }

module.exports = {
    NEST_R,
    setHooks,
    alive,
    populateInitial,
    tick,
    clearAll,
    spawnNestPentagon,
};
