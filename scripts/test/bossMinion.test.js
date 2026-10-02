// Factory minions against raid bosses: node scripts/test/bossMinion.test.js
//
// A minion's hull used to vanish into a boss: the plain hull trade killed it
// in one tick and, scaled by what it survived, dealt nothing, so minions
// looked like they passed through. Now a minion is put back on the boss's rim,
// grinds it (through bossGuard like any hit) and lasts about a second and a
// half of contact.
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

const log = console.log;
console.log = () => {};
try {
    require(path.join(SERVER, 'loaders', 'loader.js'));
    new definitionCombiner({
        groups: path.join(SERVER, 'lib', 'definitions', 'groups'),
        addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons'),
    }).loadDefinitions();
} finally { console.log = log; }

const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
global.gameManager = {
    room: { width: 6000, height: 6000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;
const loop = (n = 1) => { for (let i = 0; i < n; i++) handler.gameloop(); };

const tank = new Entity({ x: -700, y: 0 });
tank.define('factory');
tank.isPlayer = true; tank.team = -1; tank.name = 'Tester';
tank.socket = { talk() {} }; tank.sendMessage = () => {}; tank.alwaysActive = true;
const boss = new Entity({ x: 0, y: 0 });
boss.define('royaleVaultWarden');
boss.isRoyaleBoss = true; boss.alwaysActive = true;
boss.refreshBodyAttributes();
boss.health.set(20_000); boss.health.amount = 20_000;
if (boss.shield) { boss.shield.max = 0; boss.shield.amount = 0; }

const gun = [...tank.guns.values()].find(g => g.countsOwnKids);
assert.ok(gun, 'a factory gun');
gun.fire(0, 0);
const min = [...entities.values()].find(e => e.type === 'minion');
assert.ok(min, 'a minion');
min.alwaysActive = true;
min.controllers = [];
const gap = () => Math.hypot(min.x - boss.x, min.y - boss.y) - boss.realSize - min.realSize;

// pressed into the boss for a second
min.x = boss.x - boss.realSize - min.realSize + 6; min.y = boss.y;
const hp0 = boss.health.amount, mh0 = min.health.amount;
let worst = 0;
for (let i = 0; i < 30; i++) {
    min.velocity.x = 4; min.velocity.y = 0;
    loop();
    if (min.isDead()) break;
    worst = Math.min(worst, gap());
}
assert.ok(!min.isDead(), 'a minion survives a second against a boss');
assert.ok(worst > -12, 'kept on the rim, never through it: ' + worst.toFixed(1));
assert.ok(boss.health.amount < hp0, 'the boss took damage: ' + (hp0 - boss.health.amount).toFixed(1));
assert.ok(min.health.amount < mh0, 'and so did the minion');
// it does give out in the end
let n = 0;
for (; n < 300 && !min.isDead(); n++) { min.x = boss.x - boss.realSize - min.realSize + 4; min.y = boss.y; min.velocity.x = 4; loop(); }
assert.ok(min.isDead(), 'worn down within a few seconds of contact: ' + n + ' ticks');
console.log('all passed');
process.exit(0);
