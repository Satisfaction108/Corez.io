// Raid Night staging (Discord /raidreset): node scripts/test/raidReset.test.js
//
//   reset      the raid resets now: no storm, no bots, everyone safe; what is
//              banked while waiting is handed back
//   countdown  when the wait ends the raid starts and everyone is normal again
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `raidreset-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-raidreset-test-'));
fs.mkdirSync(ROOT, { recursive: true });
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ACCOUNTS_ENABLED']) delete process.env[k];

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

const T = p => require(path.join(SERVER, 'game', 'terrain', p));
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const contracts = T('contracts.js');
const pacing = T('pacing.js');
const chests = T('chests.js');
const bosses = T('bosses.js');
const storm = T('storm.js');
const vault = T('vault.js');
const shop = T('shop.js');
const milestones = T('milestones.js');
const activity = require(path.join(SERVER, 'game', 'network', 'activity.js'));

// Two vaults and a shop, cached by their modules; the game loop itself runs
// with no terrain grid.
global.gameManager.terrainGrid = {
    vaultSites: [{ x: 0, y: -3000, r: 95 }, { x: 0, y: 6000, r: 95 }],
    shopSites: [{ id: 0, name: 'Shop', x: 3000, y: 0, r: 95 }],
    outpostSites: [], spawnPits: [],
};
vault.getVaults(); shop.getShops();
global.gameManager.terrainGrid = null;
storm.start();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let seq = 0, nextY = -8000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'ct' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    return s;
}
function spawnTank(x, y) {
    const sock = mkSocket();
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (++seq);
    t.name = 'Tester' + seq;
    t.alwaysActive = true;
    t.sendMessage = () => {};
    const player = { socket: sock, body: t, target: { x: 120, y: 0 }, command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, autofire: false, autospin: false, override: false } };
    sock.player = player;
    t.socket = sock;
    level45(t);
    global.gameManager.socketManager.clients.push(sock);
    global.gameManager.socketManager.players.push(player);
    royale.onHumanJoin(t);
    // put it back where the case wants it (the spawn picker moved it)
    t.x = x; t.y = y; t.velocity.x = 0; t.velocity.y = 0;
    activity.noteCommand(sock, 100 + seq, 0, 0);
    return t;
}
function bot(x, y) {
    const b = new Entity({ x, y });
    b.define('basic');
    b.isBot = true;
    b.team = -500 - (++seq);
    b.name = 'Bot' + seq;
    b.alwaysActive = true;
    level45(b);
    b.controllers = [];
    global.gameManager.gameHandler.bots.push(b);
    return b;
}

test('reset: everyone goes down to start fresh, bots sit it out, no storm, the board empties', () => {
    const p = spawnTank(0, 0);
    const b = bot(400, 0);
    p.socket.gemBanked = 2000;
    p.carriedGems = 500;
    royale.beginStaging(60_000);
    assert.equal(royale.staging(), true);
    assert.ok(p.health.amount <= 0, 'down for the reset');
    assert.equal(p.deathCause, 'raidend', 'the raid-end way: no drop, no kill');
    assert.equal(p.carriedGems, 0);
    loop(2);
    royale.tick();
    assert.ok(b.isDead(), 'bots gone');
    const snap = storm.snapshot(Date.now());
    assert.ok(!snap.a, 'no storm');
    // a fresh body in the lobby (what the respawn gives) is safe
    const q = spawnTank(0, 0);
    { const rn = Date.now, t1 = rn() + 50; try { Date.now = () => t1; royale.tick(); } finally { Date.now = rn; } }
    assert.equal(q.godmode, true, 'safe in the lobby');
    assert.equal(q.royaleLobby, true, 'abilities off');
    // the raid board empties once the reset deaths are through
    const realNow = Date.now, t0 = realNow();
    try { Date.now = () => t0 + 1500; royale.tick(); } finally { Date.now = realNow; }
    { const rows = royale.boardSnapshot(); assert.ok(rows.every(r => !r.kills && !r.gems && r.score < 100), 'everyone back to a fresh start (just starter gems): ' + JSON.stringify(rows.map(r => [r.name, r.score]))); }
    q.socket.gemBanked = 9000;     // banked while waiting
    // the start: down again, then the raid begins
    try {
        Date.now = () => t0 + 61_000; royale.tick();
        assert.ok(q.health.amount <= 0, 'down again for the start');
        Date.now = () => t0 + 62_500; royale.tick();
    } finally { Date.now = realNow; }
    assert.equal(royale.staging(), false, 'started');
    assert.ok(q.socket.gemBanked <= 2000, 'no head start from the wait: ' + q.socket.gemBanked);
});

test('countdown: zero minutes starts right away (after the reset deaths)', () => {
    spawnTank(0, 0);
    const t0 = Date.now();
    royale.beginStaging(0);
    const realNow = Date.now;
    try {
        Date.now = () => t0 + 100; royale.tick();
        Date.now = () => t0 + 1500; royale.tick();
    } finally { Date.now = realNow; }
    assert.equal(royale.staging(), false);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
