// Bot abilities: node scripts/test/botAbilities.test.js
//
//   kit        every raid bot spawns with dash plus one secondary ability
//              from its tank's pool, mixed across the lobby; bosses get none
//   use        smoke when hurt and running, shockwave on two close enemies
//              or a pinned one, adrenaline when committing, grapple and
//              launch pad to run down a carrier or to escape, barricade at a
//              chaser, radar when there is nobody to hunt, burrow through
//              rock to get away; nothing while on cooldown
//   newcomers  nothing offensive against a newcomer (escapes still fine),
//              no shockwave with a newcomer in range
//   rate       60 s of a simulated fight against full lock-on: every
//              secondary fires at least twice and the bot dashes 6+ times;
//              against a newcomer, nothing
//   off        ROYALE_BOT_ABILITIES=0: no secondary, nothing fired
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
        // hours played: not in a first raid (newcomerDirector.js)
        t.socket = { talk() {}, status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, _careerPlayMs: 120 * 60_000 };
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


const ab = require(path.join(SERVER, 'game', 'terrain', 'abilities.js'));
const fired = [];
const realUse = ab.use;
ab.use = (body, x, y, id) => { fired.push({ id, x, y, body }); return true; };
const realRandom = Math.random;

function botWith(id, x = 0, y = 0) {
    handler.spawnBots({ x, y }, -4000 - (Math.random() * 1000 | 0));
    const b = handler.bots[handler.bots.length - 1];
    b.botWakeAt = 0; b.invuln = false; b.botGraceUntil = 0;
    if (id) { ab.giveBot(b, id); b.botAbility = id; }
    const ctl = new (ioTypes.digWarsGoals)(b);
    return { b, ctl };
}
// one decision, the dice always rolling our way
function decide(ctl, setup) {
    fired.length = 0;
    ctl.abAt = 0;
    Math.random = () => 0;
    try { setup && setup(); ctl.useAbilities(Date.now()); } finally { Math.random = realRandom; }
    return fired[0] || null;
}
function situation(ctl, enemy, kind, extra = {}) {
    ctl.view.enemy = enemy;
    ctl.view.enemyDistance = enemy ? Math.hypot(enemy.x - ctl.body.x, enemy.y - ctl.body.y) : Infinity;
    ctl.goal = Object.assign({ kind, target: kind === 'fight' ? enemy : undefined }, extra);
    ctl.goalStartedAt = Date.now() - 2000;
}
const hurt = (b, f) => { b.health.amount = b.health.max * f; };

test('kit: dash plus one secondary from the pool, mixed', () => {
    const ids = new Set();
    for (let i = 0; i < 12; i++) {
        handler.spawnBots({ x: i * 300, y: 9000 }, -5000 - i);
        const b = handler.bots[handler.bots.length - 1];
        const kit = tactics.KITS[tactics.kitOf(b)];
        assert.ok(b.botAbility && kit.includes(b.botAbility), String(b.defs[0]) + ' got ' + b.botAbility);
        assert.ok(ab.stateFor(b).own.includes(b.botAbility), 'owned through the API');
        assert.ok(ab.canDash(b), 'dash ready');
        ids.add(b.botAbility);
    }
    assert.ok(ids.size >= 4, 'a mix: ' + [...ids].join(','));
    assert.equal(tactics.equipBot({ isRoyaleBoss: true, defs: ['basic'] }), null, 'no boss');
    clearAll();
});

test('use: each ability under its own conditions', () => {
    // smoke: hurt and running
    let { b, ctl } = botWith('smoke');
    const vet1 = vet(tank(b.x + 400, b.y, false));
    loop(1); waitScan();
    assert.equal(decide(ctl, () => { situation(ctl, vet1, 'fight'); }), null, 'healthy and fighting: keep it');
    let f = decide(ctl, () => { hurt(b, 0.3); situation(ctl, vet1, 'survive', { point: { x: b.x - 900, y: b.y } }); });
    assert.equal(f && f.id, 'smoke');
    assert.ok(ctl.holdFireUntil > Date.now(), 'holds fire so the smoke lasts');
    clearAll();

    // shockwave: two close enemies, or one pinned
    ({ b, ctl } = botWith('shock'));
    const a1 = vet(tank(b.x + 200, b.y, false)), a2 = vet(tank(b.x - 200, b.y + 60, false));
    loop(1); waitScan();
    f = decide(ctl, () => situation(ctl, a1, 'mine'));
    assert.equal(f && f.id, 'shock', 'two close');
    clearAll();

    // adrenaline: committing to a fight with a strong player
    ({ b, ctl } = botWith('rush'));
    const v2 = vet(tank(b.x + 300, b.y, false));
    loop(1); waitScan();
    f = decide(ctl, () => situation(ctl, v2, 'fight'));
    assert.equal(f && f.id, 'rush');
    assert.equal(decide(ctl, () => { hurt(b, 0.4); situation(ctl, v2, 'fight'); }), null, 'not when hurt');
    clearAll();

    // grapple: a carrier getting away
    ({ b, ctl } = botWith('grapple'));
    const c = vet(tank(b.x + 520, b.y, false));
    c.carriedGems = 1500;
    loop(1); waitScan();
    f = decide(ctl, () => situation(ctl, c, 'fight'));
    assert.equal(f && f.id, 'grapple');
    assert.ok(Math.abs(f.x - c.x) < 1, 'hooked at them');
    clearAll();

    // launch pad: escape, dropped at our feet aimed at safety
    ({ b, ctl } = botWith('pad'));
    const v3 = vet(tank(b.x + 300, b.y, false));
    loop(1); waitScan();
    f = decide(ctl, () => { hurt(b, 0.3); situation(ctl, v3, 'survive', { point: { x: b.x - 1000, y: b.y } }); });
    assert.equal(f && f.id, 'pad');
    assert.ok(f.x < b.x && Math.hypot(f.x - b.x, f.y - b.y) <= 120, 'just ahead, toward safety');
    assert.ok(ctl.burrowGoUntil > Date.now() && ctl.burrowTo.x < f.x, 'drives over it');
    clearAll();

    // barricade: between us and the chaser
    ({ b, ctl } = botWith('wall'));
    const v4 = vet(tank(b.x + 450, b.y, false));
    loop(1); waitScan();
    f = decide(ctl, () => { hurt(b, 0.3); situation(ctl, v4, 'survive', { point: { x: b.x - 1000, y: b.y } }); });
    assert.equal(f && f.id, 'wall');
    assert.ok(f.x > b.x + 100 && f.x < v4.x - 100, 'raised between us: ' + Math.round(f.x - b.x));
    clearAll();

    // radar: nobody around to hunt
    ({ b, ctl } = botWith('radar'));
    f = decide(ctl, () => situation(ctl, null, 'explore', { point: { x: 0, y: 0, until: Date.now() + 9000 } }));
    assert.equal(f && f.id, 'radar');
    // and a radar ping widens what the bot can see
    b.radarUntil = Date.now() + 5000;
    const far = vet(tank(b.x + 2200, b.y, false));
    loop(1); waitScan();
    ctl.senseAt = 0; ctl.sense(Date.now());
    assert.equal(ctl.view.enemy, far, 'seen at 2200 on radar');
    clearAll();

    // cooldown: nothing
    ({ b, ctl } = botWith('rush'));
    const v5 = vet(tank(b.x + 300, b.y, false));
    loop(1); waitScan();
    ab.stateFor(b).cd.rush = Date.now() + 9000;
    assert.equal(decide(ctl, () => situation(ctl, v5, 'fight')), null, 'on cooldown');
    clearAll();
});

test('newcomers: nothing offensive, escapes still allowed', () => {
    let { b, ctl } = botWith('rush');
    const n1 = vet(tank(b.x + 300, b.y, false), 0); n1.botNewbie = true;
    loop(1); waitScan();
    assert.equal(decide(ctl, () => situation(ctl, n1, 'fight')), null, 'no adrenaline on a newcomer');
    clearAll();

    ({ b, ctl } = botWith('grapple'));
    const n2 = vet(tank(b.x + 520, b.y, false), 0); n2.botNewbie = true; n2.carriedGems = 3000;
    loop(1); waitScan();
    assert.equal(decide(ctl, () => situation(ctl, n2, 'fight')), null, 'no hook after a newcomer');
    // running from one is fine
    const f = decide(ctl, () => { hurt(b, 0.3); n2.x = b.x + 300; situation(ctl, n2, 'survive', { point: { x: b.x - 900, y: b.y } }); });
    assert.equal(f && f.id, 'grapple', 'escape hook');
    clearAll();

    // a shockwave never goes off with a newcomer in range
    ({ b, ctl } = botWith('shock'));
    const v1 = vet(tank(b.x + 200, b.y, false)), v2 = vet(tank(b.x - 200, b.y, false));
    const n3 = vet(tank(b.x, b.y + 220, false), 0); n3.botNewbie = true;
    loop(1); waitScan();
    assert.equal(decide(ctl, () => situation(ctl, v1, 'fight')), null);
    clearAll();
});

// 60 s of a running fight at the half-second decision beat, on a fake
// clock with the API's real cooldowns: how often each ability and dash goes
function fightLoop(id, newbie) {
    const { b, ctl } = botWith(id);
    const e = vet(tank(b.x + 300, b.y, false), newbie ? 0 : 1);
    if (newbie) e.botNewbie = true;
    e.carriedGems = 900;
    loop(1); waitScan();
    const cdUntil = {};
    let now = Date.now(), uses = 0, dashes = 0, seed = 12345;
    const realReady = tactics.abReady, realDash = tactics.abDash;
    tactics.abReady = (body, which) => !(cdUntil[which] > now);
    tactics.abDash = () => { dashes++; return true; };
    ab.use = (body, x, y, which) => { uses++; cdUntil[which] = now + ab.AB_BY_ID.get(which).cd; return true; };
    Math.random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    try {
        for (let i = 0; i < 120; i++) {
            now += 500;
            // the fight breathes: in and out of range, health up and down,
            // under fire half the time
            e.x = b.x + 250 + 300 * (0.5 + 0.5 * Math.sin(i / 6));
            b.health.amount = b.health.max * (0.55 + 0.4 * Math.cos(i / 9));
            b._lastDamageAt = i % 4 < 2 ? now : 0;
            situation(ctl, e, 'fight');
            ctl.abAt = 0;
            ctl.useAbilities(now);
        }
    } finally {
        Math.random = realRandom; tactics.abReady = realReady; tactics.abDash = realDash;
        ab.use = (body, x, y, which) => { fired.push({ id: which, x, y, body }); return true; };
    }
    clearAll();
    return { uses, dashes };
}

test('rate: against full lock-on, every ability at least once per ~30-40 s of fighting', () => {
    const rates = {};
    for (const id of ['smoke', 'shock', 'grapple', 'pad', 'wall', 'rush', 'radar', 'burrow']) {
        const r = fightLoop(id, false);
        rates[id] = r.uses;
        // 60 s of fighting: two uses or more is one per 30 s or better
        // (burrow cools down for 45 s, so once is its best)
        assert.ok(r.uses >= (id === 'burrow' ? 1 : 2), id + ' used ' + r.uses + ' times in 60 s');
        assert.ok(r.dashes >= 6, id + ' bot dashed ' + r.dashes + ' times in 60 s');
    }
    log('     uses per 60 s of fighting: ' + JSON.stringify(rates));
});

test('rate: nothing offensive against a newcomer, not even dashes', () => {
    for (const id of ['shock', 'grapple', 'pad', 'rush', 'radar', 'burrow']) {
        const r = fightLoop(id, true);
        assert.equal(r.uses, 0, id + ' fired on a newcomer');
        assert.equal(r.dashes, 0, id + ' bot dash-chased a newcomer');
    }
});

test('off: no secondary, nothing fired, no dash', () => {
    tactics.setAbilities(false);
    try {
        handler.spawnBots({ x: 0, y: 12000 }, -6001);
        const b = handler.bots[handler.bots.length - 1];
        assert.equal(b.botAbility, undefined);
        ab.giveBot(b, 'rush'); b.botAbility = 'rush';
        const ctl = new (ioTypes.digWarsGoals)(b);
        const v = vet(tank(b.x + 300, b.y, false));
        loop(1); waitScan();
        assert.equal(decide(ctl, () => situation(ctl, v, 'fight')), null);
        assert.equal(tactics.abDash(b, 1, 0), false);
    } finally { tactics.setAbilities(true); }
    clearAll();
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
ab.use = realUse;
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
