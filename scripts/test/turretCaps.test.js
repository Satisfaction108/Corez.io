// Auto turrets share their tank's skill and must not reset its stat caps
'use strict';
const assert = require('node:assert/strict');
const path = require('path');
const SERVER = path.join(__dirname, '..', '..', 'server');
const log = console.log; console.log = () => {};
process.env.ROYALE_TANKS = 'expanded';
require(path.join(SERVER, 'loaders', 'loader.js'));
Config.dig_royale = true;
new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
global.gameManager = { room: { width: 6000, height: 6000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true }, views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null, socketManager: { players: [], clients: [], broadcast() {} } };
global.gameManager.gameHandler = new gameHandler(global.gameManager);
console.log = log;
const ORDER = ['RELOAD', 'PENETRATION', 'BULLET_HEALTH', 'BULLET_DAMAGE', 'BULLET_SPEED', 'SHIELD_CAPACITY', 'BODY_DAMAGE', 'MAX_HEALTH', 'SHIELD_REGENERATION', 'MOVEMENT_SPEED', 'MINING_POWER'];
let n = 0;
for (const k of Object.keys(Class)) {
    const c = Class[k];
    if (!c || !c.SKILL_CAP || Array.isArray(c.SKILL_CAP) || !c.TURRETS) continue;
    const e = new Entity({ x: 0, y: 0 });
    e.define(k);
    assert.deepEqual(e.skill.caps, ORDER.map(x => c.SKILL_CAP[x] !== undefined ? c.SKILL_CAP[x] : 9), (c.LABEL || k) + ' keeps its caps');
    n++;
}
assert.ok(n >= 10, 'checked ' + n + ' turret tanks');
console.log('ok   turret tanks keep their stat caps (' + n + ')\nall 1 passed');
process.exit(0);
