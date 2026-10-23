// Trap on trap collisions: node scripts/test/trapCollide.test.js
//
// Runs the real game loop on an empty map. Big set traps (Builder,
// Constructor, ...) are heavy, and the trap push is scaled by 1 / mass, so
// they used to sit inside each other and pile up at the aim point. These
// cases check that every kind of trap bumps other traps instead.
//
//   sameTeam    two Constructor blocks dropped on top of each other
//   mixed       a Constructor block and a Trapper trap, the light one moves more
//   enemy       enemy Constructor blocks still grind each other down
//   enemyThrown an enemy Trapper trap into a Constructor block
//   stream      each set-trap tank firing a stream at one point
//   thrown      Trapper traps still push apart the way they did
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

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function loop(n = 1) { for (let i = 0; i < n; i++) handler.gameloop(); }

let caseY = -2600;
const spawned = [];
function tank(cls, team, x = -1500) {
    const t = new Entity({ x, y: caseY });
    t.define(cls);
    t.team = team;
    t.isPlayer = true;
    t.alwaysActive = true;
    t.socket = { talk() {} };
    t.sendMessage = () => {};
    spawned.push(t);
    return t;
}
function nextCase() {
    for (const e of entities.values()) if (e.type === 'trap') e.kill();
    for (const t of spawned) t.kill();
    spawned.length = 0;
    loop(2);
    caseY += 500;
}

// fire every trap gun on a tank (and its turrets) once, return the traps
function volley(t) {
    const before = new Set(entities.keys());
    for (const body of [t, ...t.turrets.values()]) {
        for (const gun of body.guns.values()) if (gun.bulletType) gun.shoot();
    }
    return [...entities.values()].filter(e => !before.has(e.id) && e.type === 'trap');
}

// one trap, parked at (x, caseY) with its flight to the aim point finished
function parked(t, x) {
    const trap = volley(t)[0];
    assert.ok(trap, 'the gun made a trap');
    for (const io of trap.controllers) if (io.myGoal) io.countdown = 0;
    trap.x = x; trap.y = caseY;
    trap.velocity.x = trap.velocity.y = 0;
    return trap;
}

const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const overlap = (a, b) => Math.max(0, 1 - gap(a, b) / (a.size + b.size));

test('sameTeam', () => {
    const t = tank('construct', -1);
    const a = parked(t, 0), b = parked(t, 3);
    assert.equal(a.label, 'Constructor Set Trap');
    assert.ok(overlap(a, b) > 0.8);
    loop(30);
    assert.ok(!a.isDead() && !b.isDead(), 'friendly traps do not hurt each other');
    assert.ok(overlap(a, b) < 0.05, 'pushed apart, overlap ' + overlap(a, b).toFixed(2));
});

test('mixed', () => {
    const c = tank('construct', -1), p = tank('trapper', -1, 1500);
    const block = parked(c, 0), trap = parked(p, 3);
    assert.equal(trap.label, 'Trapper Thrown Trap');
    loop(30);
    assert.ok(overlap(block, trap) < 0.05, 'pushed apart, overlap ' + overlap(block, trap).toFixed(2));
    assert.ok(Math.abs(trap.x - 3) > Math.abs(block.x), 'the lighter trap gives way');
});

test('enemy', () => {
    const a = parked(tank('construct', -1), 0);
    const b = parked(tank('construct', -2, 1500), 3);
    const hp = [a.health.amount, b.health.amount];
    loop(3);
    const hurt = (t, i) => t.isDead() || t.health.amount < hp[i];
    assert.ok(hurt(a, 0) && hurt(b, 1), 'enemy traps still damage each other');
    if (!a.isDead() && !b.isDead()) assert.ok(overlap(a, b) < 0.8, 'and are not left stacked');
});

test('enemyThrown', () => {
    const block = parked(tank('construct', -1), 0);
    const trap = parked(tank('trapper', -2, 1500), 3);
    const hp = trap.health.amount;
    loop(3);
    assert.ok(trap.isDead() || trap.health.amount < hp, 'the enemy trap took damage');
});

for (const cls of ['construct', 'builder', 'autoBuilder', 'conqueror', 'architect', 'engineer']) {
    test('stream ' + cls, () => {
        const t = tank(cls, -1, 0);
        t.facing = 0;
        t.control.target.x = 250; t.control.target.y = 0;
        const traps = [];
        for (let i = 0; i < 150; i++) {
            t.x = 0; t.y = caseY; t.facing = 0;
            t.velocity.x = t.velocity.y = 0;
            t.control.target.x = 250; t.control.target.y = 0;
            if (i % 12 === 0) traps.push(...volley(t));
            loop();
        }
        loop(60);
        const live = traps.filter(e => !e.isDead());
        assert.ok(live.length >= 4, 'traps to compare: ' + live.length);
        let worst = 0;
        for (let i = 0; i < live.length; i++) {
            for (let j = i + 1; j < live.length; j++) worst = Math.max(worst, overlap(live[i], live[j]));
        }
        assert.ok(worst < 0.1, `${live[0].label}s left overlapping by ${worst.toFixed(2)}`);
    });
}

test('thrown', () => {
    const t = tank('trapper', -1);
    const a = parked(t, 0), b = parked(t, 3);
    loop(30);
    assert.ok(overlap(a, b) < 0.05, 'pushed apart, overlap ' + overlap(a, b).toFixed(2));
});

// Oct 22 2026 (owner: "trapper traps chunk ~1/3 of a tank's HP, nerf those
// traps"): every trap or block lands 30% softer on a tank, any shooter
// alike; bullets, and traps into rock / chests / bosses, unchanged
test('trapNerf', () => {
    const cb = require(path.join(SERVER, 'game', 'terrain', 'classBalance.js'));
    assert.equal(cb.TRAP_VS_TANKS, 0.70);
    const shooter = { label: 'Trapper' }, other = { label: 'Builder' };
    const trap = { type: 'trap', master: shooter }, block = { type: 'trap', master: other }, bullet = { type: 'bullet', master: shooter };
    const player = { isPlayer: true }, bot = { isBot: true };
    assert.equal(cb.intoTank(player, trap, 100), 70);
    assert.equal(cb.intoTank(bot, block, 100), 70);
    assert.equal(cb.intoTank(player, bullet, 100), 100);
    assert.equal(cb.intoTank({ isRoyaleBoss: true, isBot: true }, trap, 100), 100);
    assert.equal(cb.intoTank({}, trap, 100), 100, 'not a tank (rock, a chest)');
});

// Oct 8 2026 (owner: "nerf the factory/spawner branch"): minions and their shots land 40% softer on tanks
test('minionNerf', () => {
    const cb = require(path.join(SERVER, 'game', 'terrain', 'classBalance.js'));
    assert.equal(cb.MINION_VS_TANKS, 0.6);
    const owner = { label: 'Spawner' };
    const minion = { type: 'minion', master: owner };
    const shot = { type: 'bullet', master: minion };
    const player = { isPlayer: true };
    assert.equal(cb.intoTank(player, minion, 100), 60, 'a minion ramming');
    assert.equal(cb.intoTank(player, shot, 100), 60, "a minion's own bullet");
    assert.equal(cb.intoTank(player, { type: 'bullet', master: owner }, 100), 100, "the Spawner's own gun is unchanged");
    for (const label of ['Factory', 'Flotilla', 'Kumquat', 'Pomelo']) {
        const f = { label };
        assert.equal(cb.intoTank(player, { type: 'minion', master: f }, 100), 30, label + ' minions hit tanks for 30%');
    }
    assert.equal(cb.intoTank({ isRoyaleBoss: true, isBot: true }, minion, 100), 100, 'bosses take the same');
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
    nextCase();
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
