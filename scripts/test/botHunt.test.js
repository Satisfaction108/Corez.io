// Lock-on bots: node scripts/test/botHunt.test.js
//
//   tanks      raid bots spawn straight into a tier 3 tank from the pool,
//              never Twin, Hexa Tank or anything below tier 3, at most two
//              of a kind; ROYALE_BOT_T3 off goes back to the old walk
//   carriers   against locked-on players a bot goes for the fat satchel
//              over the nearer empty one, and for the raid's hunted mark;
//              a newcomer carrying the same is not singled out
//   hunters    a third bot may join on a rich veteran, never on a newcomer
//   lead       intercept math: the shot and the tank meet
//   aim        a locked-on bot lands far more shots on a strafing tank than
//              it does on a newcomer
//   dodge      a shot on course for the bot is read and sidestepped away
//              from its line; one going past is ignored
//   cover      hurt, it hides behind rock from a locked-on player (no
//              shooting while hidden) and peeks out to fire; never against
//              a newcomer
//   comeback   it remembers who ran it off and goes back once healed; a
//              fleeing carrier (or the hunted mark) is chased longer
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

test('tanks: raid bots spawn as tier 3 tanks from the pool', () => {
    // the expanded tree (default) pools every Tier 4 of the tree
    const pool = T.pool(handler.botTankExclusions());
    assert.ok(pool.length >= 10, 'a real pool: ' + pool.length);
    for (const o of pool) {
        assert.equal(o.path.length, 3, o.name);
        assert.ok(!T.BANNED.has(o.name.toLowerCase()), o.name);
        // the last step really is a tier 3 upgrade of the tier 2 before it
        assert.ok(Class[o.path[1]].UPGRADES_TIER_3.includes(o.name), o.name);
    }
    const seen = new Map();
    for (let i = 0; i < 24; i++) {
        handler.spawnBots({ x: (i % 6) * 400, y: (nextY += 50) }, -900 - i);
        const b = handler.bots[handler.bots.length - 1];
        const cls = String(b.defs[0]);
        assert.ok(pool.some(o => o.name === cls), 'in the pool: ' + cls);
        assert.ok(!/^(twin|hexaTank|basic)$/.test(cls), cls);
        assert.ok(b.skill.level >= 45);
        assert.equal(b.leftoverUpgrades, 0, 'nothing left to climb');
        seen.set(cls, (seen.get(cls) || 0) + 1);
    }
    for (const [cls, n] of seen) assert.ok(n <= 2, cls + ' x' + n);
    // the checklist still has the last word (Booster is ticked there)
    assert.ok(!pool.some(o => o.name === 'booster'));
    clearAll();
    // switched off: the old random walk, which can stop anywhere
    T.setEnabled(false);
    try {
        handler.spawnBots({ x: 0, y: (nextY += 500) }, -999);
        const b = handler.bots[handler.bots.length - 1];
        assert.equal(String(b.defs[0]), 'basic', 'starts as a Basic again');
    } finally { T.setEnabled(true); }
    clearAll();
});

test('carriers: the satchel and the hunted mark draw a locked-on bot', () => {
    const G = ioTypes.digWarsGoals;
    const b = tank(0, (nextY += 3000), true);
    const ctl = new G(b);
    const near = vet(tank(b.x + 300, b.y, false));
    const rich = vet(tank(b.x - 700, b.y, false));
    near.carriedGems = 0; rich.carriedGems = 3000;
    loop(2); waitScan();
    const pick = () => { ctl.senseAt = 0; ctl._lastEnemy = null; ctl.sense(Date.now()); return ctl.view.enemy; };
    assert.equal(pick(), rich, 'the fat satchel, though further');
    // the hunted mark on its own does it too
    rich.carriedGems = 0; rich.huntedLevel = 2;
    assert.equal(pick(), rich, 'the hunted mark');
    rich.huntedLevel = 0;
    assert.equal(pick(), near, 'nothing to choose: the nearer one');
    // a newcomer with the same satchel is not singled out
    rich.carriedGems = 3000; rich.botNewbie = true; rich.botDifficulty = 0;
    assert.equal(pick(), near, 'not the newcomer');
    rich.botNewbie = false; rich.botDifficulty = 1;
    // hunting off: back to the old small pull
    tactics.setHunt(false);
    try { assert.equal(pick(), near); } finally { tactics.setHunt(true); }
    clearAll();
});

test('hunters: a third bot only on a rich veteran', () => {
    const G = ioTypes.digWarsGoals;
    const b = tank(0, (nextY += 3000), true);
    const ctl = new G(b);
    const p = vet(tank(b.x + 500, b.y, false));
    const o1 = tank(b.x - 300, b.y + 200, true), o2 = tank(b.x - 300, b.y - 200, true);
    o1._botEnemyId = p.id; o2._botEnemyId = p.id;
    loop(1); waitScan();
    const on = () => { ctl.senseAt = 0; ctl._lastEnemy = null; ctl.sense(Date.now()); return ctl.view.enemy === p; };
    p.carriedGems = 0;
    assert.equal(on(), false, 'two already on an empty veteran');
    p.carriedGems = 2500;
    assert.equal(on(), true, 'a rich one takes a third');
    p.botDifficulty = 0.2;
    assert.equal(on(), false, 'never a pack on a weak player');
    clearAll();
});

test('lead: the intercept point is where shot and tank meet', () => {
    for (const [px, py, vx, vy, s, m] of [[400, 0, 0, 5, 9, 30], [600, 200, -3, 4, 6, 25], [300, -300, 4, 4, 10, 0]]) {
        const t = tactics.intercept(px, py, vx, vy, s, m);
        assert.ok(t > 0);
        const ex = px + vx * t, ey = py + vy * t;
        assert.ok(Math.abs(Math.hypot(ex, ey) - (s * t + m)) < 1e-6);
    }
    assert.equal(tactics.intercept(400, 0, 20, 0, 5, 0), -1, 'running away faster than the shot');
});

// one bot, one player running side to side 300 out (a turn every 2-4 s),
// fake 30 Hz clock; shots that land
function hitsOn(difficulty, cls = 'streamliner') {
    const G = ioTypes.digWarsGoals;
    const y0 = 0;
    const b = tank(0, y0, true, cls);
    b.botSkill = 0.4;
    const ctl = new G(b);
    const p = vet(tank(300, y0, false), difficulty);
    p.health.set(1e7); p.health.amount = 1e7;
    let hits = 0;
    p.on('damage', () => hits++);
    let fake = 1e9, dir = 1, flipAt = 0;
    b.controllers = [{ think: () => ({ target: ctl.leadAim(p, fake), fire: true, goal: { x: b.x, y: b.y }, main: false, alt: false }) }];
    p.controllers = [{ think: () => ({ goal: { x: p.x, y: p.y + dir * 100 }, target: { x: -1, y: 0 }, main: true }) }];
    for (let i = 0; i < 30 * 12; i++) {
        fake += 1000 / 30;
        if (fake > flipAt) { dir = -dir; flipAt = fake + 2200 + ((i * 7919) % 1500); }
        b.x = 0; b.y = y0; b.velocity.x = b.velocity.y = 0;
        p.x = 300;
        if (Math.abs(p.y - y0) > 300) { p.y = y0 + Math.sign(p.y - y0) * 300; dir = -Math.sign(p.y - y0); }
        p.invuln = false;
        loop(1);
    }
    clearAll();
    return hits;
}

test('aim: lock-on lands its shots on a strafing tank', () => {
    const soft = hitsOn(0.1), hard = hitsOn(1);
    assert.ok(hard > soft * 2 && hard > 15, 'locked on ' + hard + ' vs newcomer ' + soft);
});

test('dodge: a shot on course is read, one going past is not', () => {
    const bot = { x: 0, y: 0, size: 20, realSize: 20, team: -5, velocity: { x: 0, y: 0 } };
    const shooter = { team: -6 };
    shooter.master = shooter;
    const shot = (x, y, vx, vy) => ({ type: 'bullet', x, y, size: 6, velocity: { x: vx, y: vy }, master: shooter, isDead: () => false });
    const head = shot(-200, 6, 12, 0);
    const grid = tactics.bucketShots([head]);
    const th = tactics.threat(bot, grid);
    assert.ok(th, 'incoming');
    // it passes a little below the centre: step up (away from it)
    assert.ok(th.ay < -0.9, 'sidestep away from the line ' + JSON.stringify(th));
    assert.equal(tactics.threat(bot, tactics.bucketShots([shot(-200, 120, 12, 0)])), null, 'wide of us');
    assert.equal(tactics.threat(bot, tactics.bucketShots([shot(200, 0, 12, 0)])), null, 'going away');
    const own = shot(-200, 0, 12, 0); own.master = { team: -5 }; own.master.master = own.master;
    assert.equal(tactics.threat(bot, tactics.bucketShots([own])), null, 'our own side');
});

test('cover: a hurt bot ducks behind rock from a locked-on player and peeks', () => {
    const G = ioTypes.digWarsGoals;
    const b = tank(100, 40, true);
    const ctl = new G(b);
    const p = vet(tank(600, 0, false));
    const rock = { alive: true, wx: 220, wy: 0, maxPolyRadius: 60 };
    const saved = global.gameManager.terrainGrid;
    global.gameManager.terrainGrid = {
        rocksHitByCircle(x, y, r, out) { out.length = 0; if (Math.hypot(rock.wx - x, rock.wy - y) < r + 60) out.push(rock); return out; },
        rockHitByCircle(x, y, r) { return Math.hypot(rock.wx - x, rock.wy - y) < r + 55 ? rock : null; },
        pointInRock(x, y) { return Math.hypot(rock.wx - x, rock.wy - y) < 55 ? rock : false; },
    };
    try {
        const now = Date.now();
        const hide = ctl.coverPoint(p, now, 0.4, false);
        assert.ok(hide, 'found cover');
        // the rock sits between the spot and the shooter
        assert.ok(hide.x < rock.wx - 60 && Math.abs(hide.y) < 5, JSON.stringify(hide));
        assert.equal(ctl.cover.peek, false);
        // hiding: aim stays on them, no shooting
        ctl.view.enemy = p; ctl.view.enemyDistance = 500; ctl._enemySeenAt = 0; ctl.reactionMs = 0;
        ctl.goal = { kind: 'fight', target: p };
        assert.equal(ctl.weapon(now).fire, false);
        // the beat flips to a peek: out to one side, the line opens
        const peek = ctl.coverPoint(p, now + 2000, 0.4, false);
        assert.equal(ctl.cover.peek, true);
        assert.ok(Math.abs(peek.y) > 40, 'stepped out ' + JSON.stringify(peek));
        // healthy again: back to the open fight
        assert.equal(ctl.coverPoint(p, now + 2100, 0.9, false), null);
        // a newcomer never makes it hide (the bot plays the old way)
        ctl.cover = null; ctl.coverCheckAt = 0;
        p.botDifficulty = 0.1;
        ctl.goal = { kind: 'fight', target: p };
        const pt = ctl.combatPoint(p, now + 3000);
        assert.equal(ctl.cover, null, 'no cover against a newcomer');
        assert.ok(pt);
    } finally { global.gameManager.terrainGrid = saved; }
    clearAll();
});

test('comeback and chase: back for whoever ran it off, longer after a carrier', () => {
    const G = ioTypes.digWarsGoals;
    const b = tank(0, 0, true);
    const ctl = new G(b);
    const p = vet(tank(500, 0, false));
    loop(1); waitScan();
    const now = Date.now();
    ctl.senseAt = 0; ctl.sense(now);
    assert.equal(ctl.view.enemy, p);
    // ran off to heal
    ctl.goal = { kind: 'fight', target: p };
    ctl.goalStartedAt = now; ctl.holdUntil = now + 2000;
    b.health.amount = b.health.max * 0.2;
    ctl.decide(now + 10);
    assert.equal(ctl.goal.kind, 'survive');
    assert.equal(ctl.comeback && ctl.comeback.target, p);
    // healed: straight back at them
    b.health.amount = b.health.max;
    assert.equal(ctl.comebackTarget(now + 5000, 1), p);
    // chase: a carrier is run down for 25 s, an empty satchel let go at 12
    p.carriedGems = 1200;
    assert.equal(ctl.chasesCarrier(p, now), true);
    p.carriedGems = 0;
    assert.equal(ctl.chasesCarrier(p, now), false);
    p.huntedLevel = 1;
    assert.equal(ctl.chasesCarrier(p, now), true, 'the hunted mark counts');
    p.botDifficulty = 0.2;
    assert.equal(ctl.chasesCarrier(p, now), false, 'never a newcomer');
    clearAll();
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
