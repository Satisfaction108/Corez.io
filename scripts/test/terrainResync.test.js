// Raid restart terrain resync: node scripts/test/terrainResync.test.js
//
//   resync     a new raid sends the whole map (grid, rock state, ore, salt)
//              again to every client that already had it, including one
//              that joined during the countdown; a socket that never got a
//              map (still on the menu with no room) gets nothing
//   snapshot   the resent rock state is the server's: rocks killed last raid
//              are dead in it, and the client's grid is the same size
//   once       one packet per client per raid, built once for all of them
//
// Runs a real Dig Royale terrain build in this process (no game server).
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
delete process.env.ROYALE_DEBUG;
const ROOT = fs.mkdtempSync(path.join(process.env.DATA_DIR || os.tmpdir(), 'dw-resync-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

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
Config.tutorial = false;

const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
// the live raid map's size, from its config
const RT = require(path.join(SERVER, 'game', 'gamemodes', 'config', 'dig_royale.js')).dig_royale_terrain;
const { socketManager } = require(path.join(SERVER, 'game', 'network', 'sockets.js'));

// the real socket manager's terrain methods on a bare object (its
// constructor starts timers a test has no use for)
const sm = Object.create(socketManager.prototype);
sm.clients = [];
sm.players = [];
sm.broadcast = () => {};
global.gameManager = {
    room: { width: RT.room_width * 420, height: RT.room_height * 420, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: sm,
};
const grid = mapGen.generate({ cols: RT.room_width, rows: RT.room_height, tileWidth: 420, fullLattice: true });
grid.buildContour();
global.gameManager.terrainGrid = grid;
global.gameManager.gameHandler = new gameHandler(global.gameManager);

const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const raid = new royale.DigRoyale(global.gameManager);

let seq = 0;
function mkSocket() {
    const s = { id: 'rs' + (++seq), packets: [], status: {}, terminated: false };
    s.talk = (...a) => s.packets.push(a);
    return s;
}
const tgOf = (s) => s.packets.filter(p => p[0] === 'TG');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('a new raid resends the map to everyone who had it', () => {
    raid.start();
    const playing = mkSocket(), countdown = mkSocket(), menu = mkSocket(), gone = mkSocket();
    sm.clients.push(playing, countdown, menu, gone);
    // first spawn on a socket: the room and the map
    sm.sendTerrain(playing);
    sm.sendTerrain(gone);
    gone.terminated = true;
    assert.equal(tgOf(playing).length, 1);

    // last raid's digging
    const killed = [];
    for (const rock of grid.rocks.values()) {
        if (!rock.alive || rock.canyon) continue;
        grid.damageRock(rock, rock.health + 1e9, 0, 0);
        if (rock.alive) continue;
        killed.push(rock.k);
        if (killed.length >= 25) break;
    }
    assert.ok(killed.length >= 10, 'found rock to dig');

    // joined during the between-raids countdown: map sent then, and again at the start
    sm.sendTerrain(countdown);
    assert.equal(tgOf(countdown).length, 1);

    let built = 0;
    const real = sm.terrainPacket;
    sm.terrainPacket = function () { built++; return real.call(this); };
    raid.reset();
    sm.terrainPacket = real;

    assert.equal(tgOf(playing).length, 2, 'playing client resynced');
    assert.equal(tgOf(countdown).length, 2, 'countdown joiner resynced');
    assert.equal(tgOf(menu).length, 0, 'no room yet, no map');
    assert.equal(tgOf(gone).length, 1, 'closed socket skipped');
    assert.equal(built, 1, 'one packet for everybody');
    assert.deepEqual(tgOf(playing)[1], tgOf(countdown)[1], 'both get the same map');

    const tg = tgOf(playing)[1];
    assert.equal(tg[1], grid.cols);
    assert.equal(tg[2], grid.rows);
    const cells = JSON.parse(tg[3]);
    assert.equal(cells.length, grid.cols * grid.rows);
    assert.equal(tg[6], grid.oreSalt);
    const state = new Map(JSON.parse(tg[4]).map(e => [e.k, e]));
    for (const k of killed) assert.ok(state.get(k) && state.get(k).d, 'killed rock ' + k + ' is dead in the resync');
    assert.ok(Array.isArray(JSON.parse(tg[5])), 'ore snapshot');
});

test('a raid start with nobody connected sends nothing and does not throw', () => {
    sm.clients.length = 0;
    assert.equal(sm.resyncTerrain(), 0);
    raid.reset();
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log('ok   ' + t.name);
        } catch (e) {
            failed++;
            console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
        }
    }
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
