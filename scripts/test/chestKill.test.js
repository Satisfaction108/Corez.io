// Chest kills by a tank's helpers: node scripts/test/chestKill.test.js
//
// Runs the real game loop (entities, collide, death checks) on an empty map
// with one player tank and one chest per case, and checks that whatever the
// tank breaks the chest with, the chest dies through its death check: one
// dead event, the burst FX, the full gem payout, and the kit item (the kill
// credit) for the owner.
//
//   minions    Factory minions grinding the chest with their hulls, several
//              at once (a Shift-held swarm); this used to leave it dead
//              mid-tick and the next collider destroyed it with no loot
//   minionShot a Factory minion's bullet
//   drone      an Overseer drone's body
//   trap       a Trapper trap
//   turret     an auto turret's bullet
//   sidearm    a shop sidearm's bullet
//   ram        the tank's own hull, with its bullets landing the same tick
//   copper     a copper chest to minions
//   storm      a chest out in the storm, still being shot past the storm
//              grace: it stays and pays out in full (it used to be retired
//              under fire, so it vanished with nothing coming out)
//   stormIdle  an untouched chest in the storm is still retired quietly
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

// the loader and definition combiner log every file they touch
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

const chests = require(path.join(SERVER, 'game', 'terrain', 'chests.js'));
const shop = require(path.join(SERVER, 'game', 'terrain', 'shop.js'));
const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function loop(n = 1) { for (let i = 0; i < n; i++) handler.gameloop(); }

let caseY = -2400;
function setup(tankClass, rare = true) {
    const y = caseY += 600;
    const talk = [];
    const tank = new Entity({ x: -300, y });
    tank.define(tankClass);
    tank.isPlayer = true;
    tank.team = -1;
    tank.name = 'Tester';
    tank.socket = { talk: (...a) => talk.push(a) };
    tank.sendMessage = () => {};
    // no camera in a test: stand in for the owner's view keeping it simulated
    const chest = chests.spawnChest(0, y, rare, { item: 'charge' });
    chest.alwaysActive = true;
    let deaths = 0;
    chest.on('dead', () => deaths++);
    const gemsBefore = new Set();
    for (const e of entities.values()) if (e.isGemPickup) gemsBefore.add(e.id);
    loop();
    return {
        tank, chest, talk,
        deaths: () => deaths,
        payout() {
            let v = 0;
            for (const e of entities.values()) if (e.isGemPickup && !gemsBefore.has(e.id)) v += e.gemValue;
            return v;
        },
    };
}

// fire one of a body's guns and return what came out
function fireGun(body, pick = () => true) {
    const gun = [...body.guns.values()].find(g => g.bulletType && pick(g));
    assert.ok(gun, 'a gun to fire');
    const before = new Set(entities.keys());
    gun.fire(0, 0);
    const out = [...entities.values()].filter(e => !before.has(e.id));
    assert.ok(out.length, 'the gun made something');
    return out[0];
}

// put a projectile just off the chest's rim, flying into it
function aimAt(o, chest, from = Math.PI) {
    const d = (chest.realSize || 40) + (o.realSize || 10) + 6;
    o.x = chest.x + Math.cos(from) * d;
    o.y = chest.y + Math.sin(from) * d;
    const sp = Math.max(4, o.velocity.length || 0);
    o.velocity.x = -Math.cos(from) * sp;
    o.velocity.y = -Math.sin(from) * sp;
}

function finish(c, rare = true) {
    for (let i = 0; i < 20 && !c.chest.isDead(); i++) loop();
    loop(2);
    assert.ok(c.chest.isDead(), 'the chest broke');
    assert.equal(c.deaths(), 1, 'it died through its death check, once');
    assert.ok(!entities.has(c.chest.id), 'and was removed');
    const fx = c.talk.filter(a => a[0] === 'FX');
    assert.equal(fx.length, 1);
    assert.equal(fx[0][3], rare ? 'chestrare' : 'chest');
    assert.equal(c.payout(), rare ? 500 : 250, 'the full gem payout sprayed out');
    // the kit item only goes to the credited killer
    const kc = c.talk.find(a => a[0] === 'KC' && a[1] === 'chest');
    assert.ok(kc && /Seismic Charge/.test(kc[2]), 'the owner got the kit item: ' + JSON.stringify(kc));
    assert.equal(shop.stateOf(c.tank.socket).kit.charge, 1);
}

test('minions', () => {
    const c = setup('factory');
    const mins = [];
    for (let i = 0; i < 4; i++) {
        const m = fireGun(c.tank, g => g.countsOwnKids);
        const a = (i / 4) * Math.PI * 2;
        const d = c.chest.realSize + m.realSize - 2;
        m.x = c.chest.x + Math.cos(a) * d;
        m.y = c.chest.y + Math.sin(a) * d;
        mins.push(m);
    }
    assert.equal(mins[0].type, 'minion');
    // a sliver left, so one tick of grinding finishes it
    c.chest.health.amount = 0.5;
    finish(c);
});

test('minionShot', () => {
    const c = setup('factory');
    const m = fireGun(c.tank, g => g.countsOwnKids);
    // well away from the chest: only its bullet reaches
    m.x = c.chest.x - 700; m.y = c.chest.y;
    const shot = fireGun(m);
    assert.equal(shot.type, 'bullet');
    aimAt(shot, c.chest);
    c.chest.health.amount = 0.5;
    finish(c);
});

test('drone', () => {
    const c = setup('overseer');
    const drone = fireGun(c.tank);
    assert.equal(drone.type, 'drone');
    aimAt(drone, c.chest);
    c.chest.health.amount = 0.5;
    finish(c);
});

test('trap', () => {
    const c = setup('trapper');
    const trap = fireGun(c.tank);
    assert.equal(trap.type, 'trap');
    aimAt(trap, c.chest);
    c.chest.health.amount = 0.5;
    finish(c);
});

test('turret', () => {
    const c = setup('auto3');
    const turret = [...c.tank.turrets.values()].find(t => t.guns && t.guns.size);
    assert.ok(turret, 'an auto turret');
    const shot = fireGun(turret);
    assert.equal(shot.type, 'bullet');
    aimAt(shot, c.chest);
    c.chest.health.amount = 0.5;
    finish(c);
});

test('sidearm', () => {
    const c = setup('basic');
    assert.ok(shop.attachSidearm(c.tank, 'pod'));
    const shot = fireGun(c.tank, g => g.isSidearm);
    assert.ok(shot.fromSidearm);
    aimAt(shot, c.chest);
    c.chest.health.amount = 0.5;
    finish(c);
});

test('ram', () => {
    const c = setup('basic');
    c.tank.x = c.chest.x - (c.chest.realSize + c.tank.realSize - 2);
    c.tank.y = c.chest.y;
    const shots = [fireGun(c.tank), fireGun(c.tank)];
    shots.forEach((s, i) => aimAt(s, c.chest, Math.PI / 2 + i));
    c.chest.health.amount = 0.5;
    finish(c);
});

test('copper', () => {
    const c = setup('factory', false);
    for (let i = 0; i < 3; i++) {
        const m = fireGun(c.tank, g => g.countsOwnKids);
        const a = (i / 3) * Math.PI * 2;
        const d = c.chest.realSize + m.realSize - 2;
        m.x = c.chest.x + Math.cos(a) * d;
        m.y = c.chest.y + Math.sin(a) * d;
    }
    c.chest.health.amount = 0.5;
    finish(c, false);
});

// Seek the storm into its hold (the zone at a fifth of the map) and run the
// chest ticks on a clock we can move forward.
function withStorm(fn) {
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
        storm.start();
        storm.debugSeek(storm.shrinkMs() / 1000 + 1);
        fn(ms => { skew += ms; });
    } finally {
        Date.now = realNow;
        storm.stop();
    }
}
function shoot(c) {
    const s = fireGun(c.tank);
    aimAt(s, c.chest);
    for (let i = 0; i < 6; i++) loop();
}

test('storm', () => withStorm((advance) => {
    const c = setup('basic');
    assert.ok(storm.inStorm(c.chest.x, c.chest.y), 'the chest is out in the storm');
    shoot(c);
    assert.ok(c.chest.hitters.has(c.tank.id), 'the tank hurt the chest');
    chests.tick();
    // past the storm grace, still under fire
    advance(7000);
    shoot(c);
    chests.tick();
    assert.ok(!c.chest._opened && !c.chest.isDead(), 'a chest being broken in the storm stays put');
    advance(4000);
    chests.tick();
    assert.ok(!c.chest._opened, 'a few seconds between shots is still breaking it');
    c.chest.health.amount = 0.5;
    shoot(c);
    finish(c);
}));

test('stormIdle', () => withStorm((advance) => {
    const c = setup('basic');
    assert.ok(storm.inStorm(c.chest.x, c.chest.y));
    chests.tick();
    advance(7000);
    chests.tick();
    loop(2);
    assert.ok(c.chest.isDead(), 'an untouched chest in the storm is retired');
    assert.equal(c.payout(), 0, 'without a payout');
    assert.equal(c.talk.filter(a => a[0] === 'FX').length, 0, 'or a burst');
}));

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
