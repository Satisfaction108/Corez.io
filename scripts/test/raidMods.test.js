// Raid override hand-outs: node scripts/test/raidMods.test.js
//
//   arm       Annihilator Arsenal (freeArm "flak") mounts the sidearm on the
//             first spawn, on every respawn and on everyone alive when it
//             starts mid-raid; SHP tells the kit box; the next override takes
//             it back; a bought sidearm is set aside and given back after
//   gear      Magnet Storm (freeGear magnet) on spawn and respawn, revoked
//   kit       Demolition Day (kitStart charge 3) tops the kit up each life
//   bots      bots get the free sidearm and gear too, and it fires with their
//             main trigger
//
// The spawn helper mirrors sockets.spawn: the join hooks (onHumanJoin) run
// before socket.player points at the new player, so socket.player.body is
// still last life's (dead) body or nothing. That is what hid the arsenal bug.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
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

const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const raidMods = require(path.join(SERVER, 'game', 'terrain', 'raidMods.js'));
const shop = require(path.join(SERVER, 'game', 'terrain', 'shop.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let seq = 0, nextY = -9000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'mods' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    s.close = () => {};
    s.terminate = () => {};
    global.gameManager.socketManager.clients.push(s);
    return s;
}
// one spawn, the way sockets.spawn runs it
function spawn(socket) {
    const t = new Entity({ x: 0, y: (nextY += 1500) });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (nextY & 0xff);
    t.name = 'Mods' + seq;
    t.alwaysActive = true;
    t.sendMessage = () => {};
    const player = {
        socket, body: t, target: { x: 120, y: 0 },
        command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, sidearm: 0, autofire: false, autospin: false, override: false, autoalt: false, spinlock: false },
    };
    t.socket = socket;
    t.become(player);
    level45(t);
    if (!socket.player) socket.player = { body: null };   // the first join: an empty player
    royale.onHumanJoin(t);                                 // socket.player is still the old one here
    socket.player = player;
    return t;
}
function die(socket, body) {
    body.deathCause = 'storm';
    royale.onCombatantDead(body);
    royale.markHumanDeath(socket);
    body.kill();
    loop(2);
    // sockets.js purges it after the death packet
    if (socket.player.body === body) socket.player.body = null;
}
function lastShp(socket) {
    const p = [...socket.packets].reverse().find(x => x[0] === 'SHP');
    return p ? JSON.parse(p[1]) : null;
}
function bot() {
    const b = new Entity({ x: 0, y: (nextY += 1500) });
    b.define('basic');
    b.isBot = true;
    b.team = -500 - (nextY & 0xff);
    b.name = 'Bot';
    b.alwaysActive = true;
    b.botSkill = 0.5;
    level45(b);
    b.controllers = [];
    handler.bots.push(b);
    return b;
}
const sidearmIds = (body) => [...body.guns.values()].filter(g => g.isSidearm).length;
// shells from this body's sidearm over ~10 s of game loop (a 7 s reload), with press() run each tick
function sidearmShots(body, press) {
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
        press();
        loop();
        for (const e of entities.values()) if (e && e.fromSidearm && e.master === body) seen.add(e.id);
    }
    return seen.size;
}

// ===================================================================

test('arm: Annihilator Arsenal mounts the sidearm on the first spawn and every respawn', () => {
    raidMods.roll('arsenal');
    const sock = mkSocket();
    const a = spawn(sock);
    assert.equal(sock.shop.arm, 'flak', 'shop state');
    assert.equal(a.sidearmId, 'flak', 'mounted on the new body');
    assert.equal(sidearmIds(a), 1);
    assert.equal(lastShp(sock).arm, 'flak', 'the kit box hears about it');
    assert.equal(lastShp(sock).armUntil, 0, 'no burn-out');
    // the sidearm key (X, command bit 128 -> command.sidearm) fires it
    a.invuln = false;                  // the spawn shield holds fire
    a.spawnGraceUntil = 0;
    a._dropHoldUntil = 0;              // landed: the sky drop holds input for its fall
    assert.equal(sidearmShots(a, () => {}), 0, 'quiet until the key');
    assert.ok(sidearmShots(a, () => { sock.player.command.sidearm = 1; }) >= 1, 'X fires the Annihilator');
    sock.player.command.sidearm = 0;
    die(sock, a);
    const b = spawn(sock);
    assert.ok(sock.lastRaidDeathAt === 0 && b !== a);
    assert.equal(b.sidearmId, 'flak', 'respawn: mounted again');
    assert.equal(lastShp(sock).arm, 'flak');
    // a class change rebuilds the gun list; the define hook puts it back
    b.define('basic');
    return new Promise(res => setImmediate(() => {
        assert.equal(b.sidearmId, 'flak', 'back after a define');
        die(sock, b);
        res();
    }));
});

test('arm: an override that starts mid-raid arms everyone alive, the next one takes it back', () => {
    raidMods.roll('giants');
    const sock = mkSocket();
    const a = spawn(sock);
    assert.equal(a.sidearmId || null, null);
    royale.debugTwist('arsenal');
    assert.equal(a.sidearmId, 'flak', 'armed mid-raid');
    assert.equal(lastShp(sock).arm, 'flak');
    royale.debugTwist('copper_rush');
    assert.equal(a.sidearmId || null, null, 'taken back');
    assert.equal(sock.shop.arm, null);
    assert.equal(lastShp(sock).arm, null, 'the kit box empties');
    die(sock, a);
    const b = spawn(sock);
    assert.equal(b.sidearmId || null, null, 'and not back on the next life');
    die(sock, b);
});

test('arm: a bought sidearm is set aside for the override and given back after it', () => {
    raidMods.roll('copper_rush');
    const sock = mkSocket();
    const a = spawn(sock);
    shop.stateOf(sock).arm = 'lance';
    shop.applyPassives(a);
    royale.debugTwist('arsenal');
    assert.equal(a.sidearmId, 'flak', 'everyone gets the Annihilator');
    assert.equal(lastShp(sock).arm, 'flak');
    die(sock, a);
    const b = spawn(sock);
    assert.equal(b.sidearmId, 'flak', 'and keeps it on respawn');
    royale.debugTwist('giants');
    assert.equal(b.sidearmId, 'lance', 'the bought one comes back when the override ends');
    assert.equal(shop.stateOf(sock).arm, 'lance');
    die(sock, b);
});

test('arm: someone who bought the Annihilator keeps it after the override', () => {
    raidMods.roll('copper_rush');
    const sock = mkSocket();
    const a = spawn(sock);
    shop.stateOf(sock).arm = 'flak';
    shop.applyPassives(a);
    royale.debugTwist('arsenal');
    assert.equal(a.sidearmId, 'flak');
    royale.debugTwist('giants');
    assert.equal(a.sidearmId, 'flak', 'theirs, not the twist\'s');
    die(sock, a);
});

test('pockets: Deep Pockets starting mid-raid raises the satchel to 6,000 at once', () => {
    raidMods.roll('copper_rush');
    const sock = mkSocket();
    const a = spawn(sock);
    assert.equal(a.gemCap, 4000);
    royale.debugTwist('deep_pockets');
    assert.equal(a.gemCap, 6000, 'live body');
    const gem = sock.packets.filter(m => m[0] === 'GEM').pop();
    assert.ok(gem && gem[2] === 6000, 'client told the new cap');
    royale.debugTwist('giants');
    assert.equal(a.gemCap, 4000, 'back to normal after');
    die(sock, a);
});

test('gear: Magnet Storm hands out the magnet on spawn and respawn, and takes it back', () => {
    raidMods.roll('magnet_storm');
    const sock = mkSocket();
    const a = spawn(sock);
    assert.equal(shop.hasGear(a, 'magnet'), true);
    assert.ok(lastShp(sock).gear.includes('magnet'), 'SHP lists it');
    die(sock, a);
    const b = spawn(sock);
    assert.equal(shop.hasGear(b, 'magnet'), true, 'respawn');
    royale.debugTwist('giants');
    assert.equal(shop.hasGear(b, 'magnet'), false, 'revoked with the override');
    assert.ok(!lastShp(sock).gear.includes('magnet'));
    die(sock, b);
});

test('kit: Demolition Day tops the kit up to three charges each life, quietly when full', () => {
    raidMods.roll('demolition');
    const sock = mkSocket();
    const a = spawn(sock);
    assert.equal(sock.shop.kit.charge, 3);
    assert.ok(lastShp(sock).kitOrder.includes('charge'));
    sock.shop.kit.charge = 1;          // two thrown
    die(sock, a);
    const b = spawn(sock);
    assert.equal(sock.shop.kit.charge, 3, 'topped up on the respawn');
    const n0 = sock.packets.length;
    die(sock, b);
    const c = spawn(sock);
    const msgs = sock.packets.slice(n0).filter(p => p[0] === 'SHP').map(p => JSON.parse(p[1]).msg);
    assert.ok(!msgs.some(m => /stack full|kit is full/i.test(m)), 'no "full" nag on a full kit: ' + msgs.join(' | '));
    die(sock, c);
});

test('bots: the free sidearm and gear ride on the body, fire with the main trigger, and go with the override', () => {
    raidMods.roll('arsenal');
    const b = bot();
    royale._grantTwist(b);
    assert.equal(b.sidearmId, 'flak');
    assert.equal(sidearmIds(b), 1);
    // a stand-in brain that only aims and holds the main trigger
    b.controllers = [{ think: () => ({ target: { x: 200, y: 0 }, fire: true, main: true }) }];
    assert.ok(sidearmShots(b, () => {}) >= 1, 'a bot fires it with its main trigger');
    b.controllers = [];
    const gunSrc = fs.readFileSync(path.join(SERVER, 'game', 'entities', 'gun.js'), 'utf8');
    assert.match(gunSrc, /this\.isSidearm \? \(this\.body\.isBot \? this\.body\.control\.fire : this\.body\.sidearmFire\)/);
    royale.debugTwist('magnet_storm');
    assert.equal(b.sidearmId || null, null, 'arsenal over: detached');
    assert.equal(shop.hasGear(b, 'magnet'), true, 'bots get the magnet too');
    royale.debugTwist('giants');
    assert.equal(shop.hasGear(b, 'magnet'), false);
    // new raid bots get it at spawn (spawnRaidBot / spawnTeamBot)
    const src = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.equal((src.match(/try \{ grantTwist\(bot\); \} catch/g) || []).length, 2);
    b.kill();
    loop(2);
});

// ===================================================================

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
