// Bot roster and smoke: node scripts/test/botRoster.test.js
//
//   delay      a dead bot never refills on the spot: the raid holds new bots
//              for a few seconds, and the dead one waits 4.5-7 s (players 3)
//   same bot   it comes back as itself: name, team colour, tank, ability,
//              board row (banked gems and score); a new name only for a slot
//              nobody waits on; the raid end and the next raid start fresh
//   lock       nothing spawns in the storm's spawn lock
//   smoke      a bot already on you keeps shooting into the smoke, sprayed
//              wide around a guess; a new bot only spots you point blank;
//              other invisibility still hides you
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
Config.dig_royale = true;
const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
global.gameManager = {
    room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [{ check: () => true, add() {}, remove() {} }], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;
function loop(n = 1) { for (let i = 0; i < n; i++) handler.gameloop(); }
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const { ioTypes } = require(path.join(SERVER, 'miscFiles', 'controllers.js'));
const D = require(path.join(SERVER, 'miscFiles', 'botDifficulty.js'));
const T = require(path.join(SERVER, 'miscFiles', 'botTanks.js'));
const tactics = require(path.join(SERVER, 'miscFiles', 'botTactics.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const clearAll = () => { for (const e of [...entities.values()]) { try { e.kill(); } catch { /* */ } } loop(3); };

let nextY = -9000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function tank(x, y, isBot, cls = 'basic') {
    const t = new Entity({ x, y });
    t.define(cls);
    if (isBot) { t.isBot = true; t.botSkill = 0.5; t.controllers = []; t.team = -500 - (nextY & 0xff); t.reverseTank = 1; }
    else {
        t.isPlayer = true; t.team = -1 - (Math.random() * 1e6 | 0); t.reverseTank = 1;
        t.socket = { talk() {}, status: {}, camera: { x: 0, y: 0 }, _careerLives: 100 };
        t.sendMessage = () => {};
    }
    t.alwaysActive = true;
    level45(t);
    return t;
}
function vet(p, d = 1) {
    royale.freshRaidBody(p);
    p.invuln = false; p.botGraceUntil = 0; p.botNewbie = false; p.botSoftUntil = 0;
    p.botDifficulty = d;
    return p;
}
const waitScan = () => { for (const t = Date.now(); Date.now() - t < 130;); };


const roster = require(path.join(SERVER, 'game', 'terrain', 'botRoster.js'));

test('delay and queue', () => {
    roster.resetRaid();
    const t = 1e12;
    const bot = { botFamilyId: 77, botNameKey: 'k77', name: 'gravel', team: -42, color: { base: 5 }, defs: ['ranger'], botAbility: 'smoke' };
    assert.equal(roster.mayFill(t), true);
    assert.equal(roster.onBotGone(bot, t, 'bullet'), true, 'kept for a respawn');
    assert.equal(roster.mayFill(t + 100), false, 'no instant refill');
    let n = roster.next(t + 1000);
    assert.equal(n.entry, null); assert.equal(n.fresh, false, 'someone is waiting: no new bot either');
    n = roster.next(t + roster.DELAY_MS + roster.DELAY_JITTER_MS);
    assert.equal(n.entry && n.entry.name, 'gravel');
    assert.equal(n.entry.tank, 'ranger'); assert.equal(n.entry.ability, 'smoke'); assert.equal(n.entry.familyId, 77);
    assert.ok(n.entry.readyAt - t >= 3000, 'longer than a player');
    assert.equal(roster.next(t + 1e6).fresh, true, 'empty: a new bot may come');
    // the raid end kills everyone: nobody queued
    assert.equal(roster.onBotGone(bot, t, 'raidend'), false);
    // the circle closed: only as many wait as there is room for
    roster.onBotGone({ botFamilyId: 1, defs: ['x'] }, t); roster.onBotGone({ botFamilyId: 2, defs: ['x'] }, t);
    roster.trimTo(1);
    assert.equal(roster.size(), 1);
    roster.resetRaid();
    assert.equal(roster.size(), 0);
    roster.setEnabled(false);
    try { assert.equal(roster.onBotGone(bot, t), false); assert.equal(roster.mayFill(t + 100), false, 'still no instant refill'); }
    finally { roster.setEnabled(true); roster.resetRaid(); }
});

test('same bot: name, tank, ability, colour and board row', () => {
    roster.resetRaid();
    royale._spawnRaidBot();
    const a = handler.bots[handler.bots.length - 1];
    a.botAbility = a.botAbility || 'rush';
    const key = royale._statKeyFor(a);
    const id = { name: a.name, tank: String(a.defs[0]), ab: a.botAbility, color: a.color.base, team: a.team, skill: a.botSkill };
    a.invuln = false;
    a.kill(); loop(2);
    assert.equal(roster.size(), 1, 'waiting to come back');
    const back = roster.next(Date.now() + 60_000).entry;
    royale._spawnRaidBot(back);
    const b = handler.bots[handler.bots.length - 1];
    assert.notEqual(b, a);
    assert.equal(b.name, id.name);
    assert.equal(String(b.defs[0]), id.tank);
    assert.equal(b.botAbility, id.ab);
    assert.equal(b.color.base, id.color);
    assert.equal(b.team, id.team);
    assert.equal(b.botSkill, id.skill);
    assert.equal(royale._statKeyFor(b), key, 'same board row');
    clearAll(); roster.resetRaid();
});

test('lock: no bot spawns in the storm lock, no instant refill', () => {
    const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
    const real = storm.locked;
    const sm = global.gameManager.socketManager;
    sm.clients = [{ terminated: false }];
    roster.resetRaid();
    try {
        storm.locked = () => true;
        const before = handler.bots.length;
        royale._fillBots();
        assert.equal(handler.bots.length, before, 'locked: nothing');
        assert.equal(royale.canSpawn(), false);
        storm.locked = () => false;
        for (let i = 0; i < 3; i++) { royale._fillBots(); waitScan(); waitScan(); waitScan(); waitScan(); }
        assert.ok(handler.bots.length > before, 'open again: the raid fills');
        // a death: no refill straight away
        const n = handler.bots.length;
        const dead = handler.bots[n - 1];
        dead.invuln = false; dead.kill(); loop(2);
        royale._fillBots();
        assert.equal(handler.bots.length, n - 1, 'no instant replacement');
    } finally { storm.locked = real; sm.clients = []; clearAll(); roster.resetRaid(); }
});

function smoke(p) { p.alpha = 0; p.smokeHidden = true; }

test('smoke: blind fire from a bot already on you, no new spotting', () => {
    const G = ioTypes.digWarsGoals;
    const b = tank(0, 0, true, 'triplet');
    const ctl = new G(b);
    const p = vet(tank(400, 0, false));
    loop(1); waitScan();
    ctl.senseAt = 0; ctl.sense(Date.now());
    assert.equal(ctl.view.enemy, p);
    smoke(p);
    ctl.senseAt = 0; ctl.sense(Date.now() + 200);
    assert.equal(ctl.view.enemy, p, 'still on them inside the smoke');
    ctl._enemySeenAt = 0; ctl.reactionMs = 0; ctl.goal = { kind: 'fight', target: p };
    let fired = 0, spread = 0;
    const now0 = Date.now() + 300;
    for (let i = 0; i < 60; i++) {
        const w = ctl.weapon(now0 + i * 120);
        if (w.fire) fired++;
        spread += Math.abs(Math.atan2(w.target.y, w.target.x) - Math.atan2(p.y - b.y, p.x - b.x));
    }
    assert.ok(fired > 20, 'keeps firing: ' + fired);
    assert.ok(spread / 60 > 0.05, 'wide: ' + (spread / 60).toFixed(3));
    // a fresh bot further off does not pick them out of the smoke...
    const c = tank(0, 300, true);
    const ctl2 = new G(c);
    loop(1); waitScan();
    ctl2.senseAt = 0; ctl2.sense(Date.now() + 400);
    assert.notEqual(ctl2.view.enemy, p, 'not spotted at 500');
    // ...unless right on top of them
    c.x = p.x - 120; c.y = p.y; loop(1); waitScan();
    ctl2.senseAt = 0; ctl2._lastEnemy = null; ctl2.sense(Date.now() + 600);
    assert.equal(ctl2.view.enemy, p, 'spotted point blank');
    // invisible some other way (not smoke): gone
    p.smokeHidden = false;
    ctl.senseAt = 0; ctl.sense(Date.now() + 800);
    assert.notEqual(ctl.view.enemy, p);
    clearAll();
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
