// Citron's spawner keeps its four minions: node scripts/test/citronSpawner.test.js
//
// A destroyed minion used to sit in the gun's child list until the next
// destroy pass, and a minion left far behind kept its slot forever, so the
// spawner could stay at two minions. The gun now prunes dead children and
// recalls children beyond RECALL_RANGE before it checks how many it may spawn.
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

process.env.ROYALE_TANKS = 'expanded';
const log = console.log;
console.log = () => {};
try {
    require(path.join(SERVER, 'loaders', 'loader.js'));
    new definitionCombiner({
        groups: path.join(SERVER, 'lib', 'definitions', 'groups'),
        addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons'),
    }).loadDefinitions();
} finally { console.log = log; }

Config.dig_royale = true;
const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
global.gameManager = {
    room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;
const loop = (n = 1) => { for (let i = 0; i < n; i++) handler.gameloop(); };
const key = Object.keys(Class).find(k => Class[k] && Class[k].LABEL === 'Citron');
assert.ok(key, 'Citron is defined');

const tank = new Entity({ x: 0, y: 0 });
tank.define(key);
tank.isPlayer = true;
tank.team = -1;
tank.alwaysActive = true;
tank.invuln = false;
tank.socket = { talk() {}, status: {}, camera: { x: 0, y: 0 } };
tank.sendMessage = () => {};
const gun = [...tank.guns.values()].find(g => g.countsOwnKids);
assert.ok(gun, 'the spawner gun');
assert.equal(gun.recallRange, 900, 'Citron recalls stranded minions');

// let the autofiring spawner fill its four slots
for (let i = 0; i < 320 && gun.children.length < 4; i++) loop(1);
assert.equal(gun.children.filter(c => c && !c.isDead()).length, 4, 'four minions');

// kill one: the next reload cycle must replace it
gun.children[0].kill();
loop(320);
assert.equal(gun.children.filter(c => c && !c.isDead()).length, 4, 'dead minion replaced');

// two far behind the tank: recalled and replaced near the hull
for (const c of gun.children.slice(0, 2)) { c.x = 6000; c.y = 0; }
loop(400);
const live = gun.children.filter(c => c && !c.isDead());
assert.equal(live.length, 4, 'stranded minions replaced');
const near = live.filter(c => Math.hypot(c.x - tank.x, c.y - tank.y) <= gun.recallRange).length;
assert.equal(near, 4, 'all four are back with the tank');

for (const e of [...entities.values()]) { try { e.kill(); } catch { /* */ } }
loop(3);
console.log('all passed');
process.exit(0);
