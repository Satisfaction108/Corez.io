// Per-player bot difficulty: node scripts/test/botDifficulty.test.js
//
//   mapping    new player 0, ranks climb Bronze I 0.2 .. Legend 0.95,
//              guests climb with raid score and kills, or with time played,
//              up to 0.85, placement stops at 0.5, a strong guest's next
//              raid starts part way up
//   newness    full for the first 5 minutes played and 5 lives, gone by 12
//              minutes or the 9th life, whichever comes first; difficulty
//              fades in from 0 over it
//   of         mercy caps it, bots and bosses as targets are neutral
//   ceiling    lock-on off: at 1 every knob is still softer than the bots
//              before 07e28b1
//   lockon     lock-on on (the default): ranked players and anyone past 15
//              minutes face 1, newcomers still 0; at 1 every knob is at
//              least as sharp as the bots before 07e28b1, and below 0.5
//              nothing changed
//   middle     at 0.5 the knobs sit on the 07e28b1 tuning
//   shots      a bot's shot into a player follows that player's difficulty;
//              a boss's shot is the same into everyone
//   bots       one bot plays a newcomer and a veteran differently: soft
//              window length, hunter cap, reaction time, fight range
//   stamp      the raid stamps rank or raid score; newness comes from play
//              time and lives, so a guest who never dies stops being new
//              and a long session climbs even with a modest score; the soft
//              window at the start of a life is long only while new
//   bosses     boss guns and turrets still target a new player once their
//              grace is over
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const D = require(path.join(SERVER, 'miscFiles', 'botDifficulty.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
// the pre lock-on mapping and ceiling (ROYALE_BOTS_LOCKON=0)
function legacy(name, fn) {
    tests.push({ name: name + ' (lock-on off)', fn: () => {
        D.setLockOn(false);
        try { fn(); } finally { D.setLockOn(true); }
    } });
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const SKILLS = [0.08, 0.2, 0.4, 0.6, 0.8, 0.95];

legacy('mapping', () => {
    assert.equal(D.forPlayer({ newbie: true, rankCode: 19, score: 50000, kills: 20 }), 0);
    assert.ok(near(D.forPlayer({ rankCode: 1 }), 0.2));
    assert.ok(near(D.forPlayer({ rankCode: 7 }), 0.45), 'Gold I');
    assert.ok(near(D.forPlayer({ rankCode: 13 }), 0.7), 'Diamond I');
    assert.ok(near(D.forPlayer({ rankCode: 19 }), 0.95), 'Legend');
    // above Legend I (codes skip 20, placement): the top, never past it
    const R = require('../../shared/ranks.js');
    for (let div = 19; div <= R.TOP; div++) assert.ok(near(D.forPlayer({ rankCode: R.rankCode(div, false) }), 0.95), R.nameOf(div));
    assert.ok(near(D.forPlayer({ rankCode: R.CODE_MAX, score: 1e6, kills: 100 }), 0.95));
    let prev = 0;
    for (let code = 1; code <= 19; code++) {
        const d = D.forPlayer({ rankCode: code });
        assert.ok(d > prev, 'rises at ' + code);
        prev = d;
    }
    // a strong raid nudges a ranked player up a little, never past Legend
    const bronze = D.forPlayer({ rankCode: 1, score: 20000, kills: 10 });
    assert.ok(bronze > 0.2 && bronze <= 0.28 + 1e-9);
    assert.ok(D.forPlayer({ rankCode: 19, score: 1e6, kills: 100 }) <= 0.95);
    // guests: score and kills
    assert.ok(near(D.forPlayer({ rankCode: 0 }), 0.15));
    const g = (score, kills) => D.forPlayer({ rankCode: 0, score, kills });
    assert.ok(g(2000, 0) > g(0, 0) && g(5000, 0) > g(2000, 0) && g(5000, 3) > g(5000, 0));
    assert.ok(g(5000, 3) > 0.45 && g(5000, 3) < 0.6, 'a good raid lands mid ' + g(5000, 3));
    assert.ok(g(1e6, 1000) <= 0.85);
    // placement: the guest curve, capped
    assert.ok(D.forPlayer({ rankCode: 20, score: 1e6, kills: 100 }) <= 0.5);
    // a new raid: 60% of the session's best above the floor
    const next = D.forPlayer({ rankCode: 0, score: 0, kills: 0, sessionBest: 0.75 });
    assert.ok(near(next, 0.15 + 0.6 * 0.6));
    // time played: a guest who has been on for half an hour faces mid
    // difficulty even with a modest raid
    const min = m => m * 60_000;
    const t = (m, score = 0, kills = 0) => D.forPlayer({ rankCode: 0, score, kills, playMs: min(m) });
    assert.ok(near(t(0), 0.15));
    assert.ok(t(10) > 0.33 && t(10) < 0.4, '10 min ' + t(10));
    assert.ok(t(30) > 0.5 && t(30) < 0.58, '30 min ' + t(30));
    assert.ok(t(30, 2000, 1) >= t(30) && t(30, 2000, 1) < 0.6, '30 min, modest raid ' + t(30, 2000, 1));
    assert.ok(t(600) <= 0.6 + 1e-9, 'time alone tops out at 0.6');
    assert.ok(t(5, 20000, 10) > 0.8, 'a great raid still beats the clock');
    assert.ok(D.forPlayer({ rankCode: 20, playMs: min(600) }) <= 0.5, 'placement cap');
    // ranked players keep their tier: time played does not move it
    assert.ok(near(D.forPlayer({ rankCode: 1, playMs: min(600) }), 0.2));
});

legacy('newness', () => {
    const min = m => m * 60_000;
    assert.equal(D.newness(0, 1), 1);
    assert.equal(D.newness(min(4.9), 5), 1, 'five minutes and five lives: still fully new');
    // the clock: fades from 5 to 12 minutes, whatever the lives say
    assert.ok(D.newness(min(8.5), 1) > 0.4 && D.newness(min(8.5), 1) < 0.6);
    assert.equal(D.newness(min(12), 1), 0, 'a player who never dies is not new past 12 minutes');
    assert.equal(D.newness(min(30), 2), 0);
    // lives: fades from the 6th to the 9th, whatever the clock says
    assert.equal(D.newness(min(1), 6), 0.75);
    assert.equal(D.newness(min(1), 9), 0);
    assert.equal(D.newness(min(1), 50), 0);
    // whichever comes first
    assert.equal(D.newness(min(8.5), 7), Math.min(D.newness(min(8.5), 1), D.newness(0, 7)));
    // difficulty fades in with it
    const at = n => D.forPlayer({ rankCode: 0, newness: n, playMs: min(10), score: 5000, kills: 3 });
    assert.equal(at(1), 0);
    assert.ok(at(0.5) > 0 && at(0.5) < at(0));
    assert.ok(near(at(0.5), at(0) / 2));
    assert.ok(near(D.forPlayer({ rankCode: 13, newness: 0.25 }), 0.7 * 0.75), 'a fading ranked player');
    assert.equal(D.forPlayer({ newbie: true, rankCode: 13 }), 0);
});

test('of', () => {
    const now = Date.now();
    assert.equal(D.of(null), D.NEUTRAL);
    assert.equal(D.of({ isBot: true }), D.NEUTRAL);
    assert.equal(D.of({ isRoyaleBoss: true }), D.NEUTRAL);
    assert.equal(D.of({ isPlayer: true }), D.NEUTRAL, 'no stamp yet: neutral');
    assert.equal(D.of({ isPlayer: true, botDifficulty: 0.9 }), 0.9);
    assert.equal(D.of({ isPlayer: true, botDifficulty: 0.9, botNewbie: true }), 0);
    assert.equal(D.of({ isPlayer: true, botDifficulty: 0.9, socket: { botMercyUntil: now + 5000 } }, now), 0.15);
});

// the bots before 07e28b1 (git show 07e28b1^:server/miscFiles/controllers.js)
const PRE = {
    aimError: s => (1 - s) * 0.07,
    aimStiff: s => 0.16 + s * 0.22,
    leadShare: s => 0.5 + s * 0.5,
    reactionMs: (s, r) => 160 + (1 - s) * 380 + r * 160,
    pauseMs: (s, r) => 200 + r * 450 * (1.4 - s),
    burstMs: r => 1300 + r * 2400,
};
// 07e28b1 itself
const CUR = {
    aimError: s => 0.03 + (1 - s) * 0.1,
    aimStiff: s => 0.12 + s * 0.2,
    leadShare: s => 0.35 + s * 0.5,
    reactionMs: (s, r) => 300 + (1 - s) * 450 + r * 250,
    pauseMs: (s, r) => 300 + r * 600 * (1.4 - s),
    burstMs: r => 1000 + r * 2000,
};

legacy('ceiling', () => {
    for (const s of SKILLS) {
        for (const r of [0, 0.5, 1]) {
            assert.ok(D.aimError(s, 1) > PRE.aimError(s), 'aim error at ' + s);
            assert.ok(D.aimStiff(s, 1) < PRE.aimStiff(s), 'turn at ' + s);
            assert.ok(D.leadShare(s, 1) < PRE.leadShare(s), 'lead at ' + s);
            assert.ok(D.reactionMs(s, 1, r) > PRE.reactionMs(s, r), 'reaction at ' + s);
            assert.ok(D.pauseMs(s, 1, r) > PRE.pauseMs(s, r), 'pause at ' + s);
            assert.ok(D.burstMs(1, r) < PRE.burstMs(r), 'burst');
        }
    }
    assert.ok(D.shotMult(1) < 1);
    assert.ok(D.maxHunters(1) <= 2);
    assert.ok(D.company(1) < 4);
    assert.equal(D.company(0), 1);
    assert.ok(D.initThreat(1) <= 1.2);
    assert.ok(D.initRange(1) <= 1400);
    // and every knob moves one way from 0 to 1
    for (let d = 0.1; d <= 1.001; d += 0.1) {
        assert.ok(D.aimError(0.4, d) < D.aimError(0.4, d - 0.1));
        assert.ok(D.aimStiff(0.4, d) > D.aimStiff(0.4, d - 0.1));
        assert.ok(D.reactionMs(0.4, d, 0.5) < D.reactionMs(0.4, d - 0.1, 0.5));
        assert.ok(D.shotMult(d) > D.shotMult(d - 0.1));
        assert.ok(D.softShare(d) < D.softShare(d - 0.1));
    }
});

test('lockon: mapping', () => {
    assert.equal(D.isLockOn(), true, 'on by default');
    const min = m => m * 60_000;
    // newcomers keep the easy bots
    assert.equal(D.forPlayer({ newbie: true, rankCode: 19 }), 0);
    assert.equal(D.forPlayer({ rankCode: 0, newness: 1, playMs: min(3), score: 50000, kills: 20 }), 0);
    // ranked: full lock-on straight away (fading in only while still new)
    for (const code of [1, 7, 13, 19]) assert.equal(D.forPlayer({ rankCode: code }), 1, 'rank ' + code);
    assert.ok(near(D.forPlayer({ rankCode: 1, newness: 0.5 }), 0.5));
    // guests: on the clock, 0.55 at 5 minutes to 1 at 15
    const g = m => D.forPlayer({ rankCode: 0, playMs: min(m), newness: D.newness(min(m), 1) });
    assert.equal(g(4), 0);
    assert.ok(g(8.5) > 0.25 && g(8.5) < 0.45, '8.5 min ' + g(8.5));
    assert.ok(g(12) > 0.8, '12 min ' + g(12));
    assert.equal(g(15), 1);
    assert.equal(g(120), 1);
    // an experienced guest (career time) is locked on from the first second
    assert.equal(D.forPlayer({ rankCode: 0, playMs: min(40) }), 1);
    // a strong raid gets there early
    assert.ok(D.forPlayer({ rankCode: 0, playMs: min(5), score: 10000, kills: 5 }) >= 0.99);
    // placement: the guest clock, no cap
    assert.equal(D.forPlayer({ rankCode: 20, playMs: min(30) }), 1);
    // a good session carries over to the next raid
    assert.ok(D.forPlayer({ rankCode: 0, playMs: min(5), sessionBest: 1 }) >= 0.9);
    // mercy and idling still win over all of it
    const now = Date.now();
    assert.equal(D.of({ isPlayer: true, botDifficulty: 1, socket: { botMercyUntil: now + 5000 } }, now), 0.15);
});

test('lockon: knobs', () => {
    for (const s of SKILLS) {
        for (const r of [0, 0.5, 1]) {
            assert.ok(D.aimError(s, 1) < PRE.aimError(s) + 0.012, 'aim error at ' + s);
            assert.ok(D.aimError(s, 1) < 0.015, 'near zero error at ' + s);
            assert.ok(D.aimStiff(s, 1) > PRE.aimStiff(s), 'turn at ' + s);
            assert.ok(D.leadShare(s, 1) >= 1, 'full lead at ' + s);
            assert.ok(D.reactionMs(s, 1, r) <= 190 && D.reactionMs(s, 1, r) >= 60, 'reaction at ' + s + ' ' + D.reactionMs(s, 1, r));
            assert.ok(D.pauseMs(s, 1, r) < PRE.pauseMs(s, r), 'pause at ' + s);
            assert.ok(D.burstMs(1, r) > PRE.burstMs(r), 'burst');
        }
    }
    assert.equal(D.shotMult(1), 1);
    assert.ok(D.initRange(1) > 1400 && D.initThreat(1) > 1.2);
    // still one way from 0 to 1, and below 0.5 the lock-on changes nothing
    for (let d = 0.1; d <= 1.001; d += 0.1) {
        assert.ok(D.aimError(0.4, d) < D.aimError(0.4, d - 0.1));
        assert.ok(D.aimStiff(0.4, d) > D.aimStiff(0.4, d - 0.1));
        assert.ok(D.reactionMs(0.4, d, 0.5) < D.reactionMs(0.4, d - 0.1, 0.5));
        assert.ok(D.shotMult(d) > D.shotMult(d - 0.1));
        assert.ok(D.softShare(d) < D.softShare(d - 0.1));
    }
    const knobs = d => [D.aimError(0.4, d), D.aimStiff(0.4, d), D.leadShare(0.4, d), D.reactionMs(0.4, d, 0.3),
        D.pauseMs(0.4, d, 0.3), D.burstMs(d, 0.3), D.shotMult(d), D.initRange(d), D.softShare(d), D.turretNoise(d)];
    for (const d of [0, 0.15, 0.3, 0.5]) {
        const on = knobs(d);
        D.setLockOn(false);
        const off = knobs(d);
        D.setLockOn(true);
        on.forEach((v, i) => assert.ok(near(v, off[i]), 'knob ' + i + ' at ' + d));
    }
    // hunters: a third bot only on a rich (or marked) veteran
    assert.equal(D.maxHunters(0.1, 5000, 2), 1, 'never a pack on a newcomer');
    assert.equal(D.maxHunters(0.6, 5000, 2), 2);
    assert.equal(D.maxHunters(1, 0, 0), 2);
    assert.equal(D.maxHunters(1, 2000, 0), 3);
    assert.equal(D.maxHunters(0.9, 0, 2), 3);
    assert.equal(D.tactics(0.3), 0);
    assert.equal(D.tactics(1), 1);
});

test('lockon: shots', () => {
    const { shotMult } = require(path.join(SERVER, 'game', 'entities', 'subFunctions.js'));
    const bot = { isBot: true, botShotMult: 0.8 };
    bot.master = bot;
    const newbie = { isPlayer: true, botNewbie: true };
    const vet = { isPlayer: true, botDifficulty: 1 };
    for (const p of [newbie, vet]) p.master = p;
    assert.ok(near(shotMult({ master: bot }, newbie), D.shotMult(0)), 'a newcomer still takes the soft shots');
    assert.equal(shotMult({ master: bot }, vet), 1, 'a veteran takes full damage');
});

test('middle', () => {
    const close = (a, b, what) => assert.ok(Math.abs(a - b) / b < 0.15, what + ' ' + a.toFixed(3) + ' vs ' + b.toFixed(3));
    for (const s of [0.2, 0.4, 0.6, 0.8]) {
        close(D.aimError(s, 0.5), CUR.aimError(s), 'aim error');
        close(D.aimStiff(s, 0.5), CUR.aimStiff(s), 'turn');
        close(D.leadShare(s, 0.5), CUR.leadShare(s), 'lead');
        close(D.reactionMs(s, 0.5, 0.5), CUR.reactionMs(s, 0.5), 'reaction');
        close(D.pauseMs(s, 0.5, 0.5), CUR.pauseMs(s, 0.5), 'pause');
    }
    close(D.burstMs(0.5, 0.5), CUR.burstMs(0.5), 'burst');
    close(D.shotMult(0.5), 0.8, 'shot damage');
    assert.equal(D.maxHunters(0.5), 2);
    assert.equal(D.company(0.5), 2, 'the 07e28b1 director kept two near everyone');
    assert.equal(D.maxHunters(0.1), 1);
});

legacy('shots', () => {
    const { shotMult } = require(path.join(SERVER, 'game', 'entities', 'subFunctions.js'));
    const bot = { isBot: true, botShotMult: 0.8 };
    bot.master = bot;
    const shot = { master: bot };
    const newbie = { isPlayer: true, botNewbie: true };
    const vet = { isPlayer: true, botDifficulty: 1 };
    const mid = { isPlayer: true, botDifficulty: 0.5 };
    for (const p of [newbie, vet, mid]) p.master = p;
    assert.ok(near(shotMult(shot, newbie), D.shotMult(0)));
    assert.ok(near(shotMult(shot, vet), D.shotMult(1)));
    assert.ok(shotMult(shot, newbie) < shotMult(shot, mid) && shotMult(shot, mid) < shotMult(shot, vet));
    assert.ok(shotMult(shot, vet) < 1);
    // hitting the player's bullet counts as hitting the player
    assert.ok(near(shotMult(shot, { master: vet }), D.shotMult(1)));
    // bot on bot, and no target: the flat bot share
    const other = { isBot: true };
    other.master = other;
    assert.equal(shotMult(shot, other), 0.8);
    assert.equal(shotMult(shot), 0.8);
    // a player's shot is untouched by any of it
    const pShot = { master: vet };
    assert.equal(shotMult(pShot, bot), 1);
    // a boss is a shared threat: its shots hit a newcomer, a player under
    // mercy and a veteran the same (its own tuning only)
    const boss = { isRoyaleBoss: true, bossShotMult: 0.55 };
    boss.master = boss;
    const turret = { master: boss };
    const mercy = { isPlayer: true, botDifficulty: 0.9, socket: { botMercyUntil: Date.now() + 60_000 } };
    mercy.master = mercy;
    for (const p of [newbie, vet, mid, mercy, other]) {
        assert.equal(shotMult({ master: boss }, p), 0.55);
        assert.equal(shotMult({ master: turret }, p), 0.55, 'turret bullet');
    }
    assert.equal(shotMult({ master: boss }), 0.55);
});

// ---- the bot brain against two players ---------------------------------
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
function loop(n = 1) { for (let i = 0; i < n; i++) handler.gameloop(); }
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
// These cover the newness machinery underneath. The first raids director on
// top of it (a 3 minute soft window, bosses that never pick a first-raid
// player) has its own test: newcomerDirector.test.js.
require(path.join(SERVER, 'game', 'terrain', 'newcomerDirector.js')).setEnabled(false);
const { ioTypes } = require(path.join(SERVER, 'miscFiles', 'controllers.js'));
const FM = royale.FIRST_MINUTES;

let nextY = -9000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function tank(x, y, isBot) {
    const t = new Entity({ x, y });
    t.define('basic');
    if (isBot) { t.isBot = true; t.botSkill = 0.5; t.controllers = []; t.team = -500 - (nextY & 0xff); }
    else {
        t.isPlayer = true; t.team = -1 - (nextY & 0xff); t.reverseTank = 1;
        t.socket = { talk() {}, status: {}, camera: { x: 0, y: 0 }, _careerLives: 100 };
        t.sendMessage = () => {};
    }
    t.alwaysActive = true;
    level45(t);
    return t;
}
const waitScan = () => { for (const t = Date.now(); Date.now() - t < 130;); };

test('bots: soft window, hunter cap, reaction and fight range follow the target', () => {
    const G = ioTypes.digWarsGoals;
    const b = tank(0, (nextY += 1500), true);
    const ctl = new G(b);
    const p = tank(b.x + 700, b.y, false);
    royale.freshRaidBody(p);
    p.invuln = false;
    p.botGraceUntil = 0;
    p.botNewbie = false;
    loop(2);
    const now = Date.now();
    // 60 s into a long (new player) window: soft for a low-difficulty
    // player, over for a high one
    p.botSoftMs = FM.BOT_SOFT_MS;
    p.botSoftUntil = now + FM.BOT_SOFT_MS - 60_000;
    p.botDifficulty = 0.2;
    ctl.senseAt = 0; ctl.sense(now);
    assert.equal(ctl.view.enemy, null, 'still soft at 0.2');
    p.botDifficulty = 1;
    ctl.senseAt = 0; ctl.sense(now + 10);
    assert.equal(ctl.view.enemy, p, 'soft window over at 1');
    // reaction time: slower against the low one
    const react = d => {
        p.botDifficulty = d;
        let sum = 0;
        for (let i = 0; i < 40; i++) {
            ctl._lastEnemy = null; ctl.senseAt = 0; ctl.sense(now + 20 + i);
            sum += ctl.reactionMs;
        }
        return sum / 40;
    };
    p.botSoftUntil = 0;
    assert.ok(react(0.15) > react(1) + 150, 'reacts slower to a weaker player');
    // fight range: from 1000 a veteran gets a fight started on them, a
    // low-difficulty player does not
    p.x = b.x + 1000; loop(1);
    p.botDifficulty = 1;
    ctl._enemySeenAt = 0; ctl.senseAt = 0; ctl.sense(now + 200);
    assert.equal(ctl.view.enemy, p);
    assert.equal(ctl.candidate(now + 5000).kind, 'fight');
    p.botDifficulty = 0.15;
    ctl.senseAt = 0; ctl.sense(now + 300);
    const c = ctl.candidate(now + 5000);
    assert.ok(!(c.kind === 'fight' && c.target === p), 'no fight started from 1000 on a weak player');
    // hunter cap: one other bot on a low player is enough, a high one takes two
    p.x = b.x + 600; loop(1);
    const other = tank(b.x - 300, b.y + 200, true);
    other._botEnemyId = p.id;
    loop(1); waitScan();
    p.botDifficulty = 0.2;
    ctl.senseAt = 0; ctl.sense(Date.now() + 1000);
    assert.equal(ctl.view.enemy === p, false, 'one hunter on a low player');
    p.botDifficulty = 0.8;
    ctl.senseAt = 0; ctl.sense(Date.now() + 1200);
    assert.equal(ctl.view.enemy, p, 'two on a high one');
    for (const o of [b, p, other]) o.kill();
    loop(2);
});

legacy('bots: the raid stamps each player from rank or raid score', () => {
    const p = tank(0, (nextY += 1500), false);
    royale.freshRaidBody(p);
    assert.ok(near(p.botDifficulty, D.forPlayer({ rankCode: 0 }), 1e-4), 'a guest starts at the floor');
    p.rankCode = 13;
    royale.freshRaidBody(p);
    assert.ok(near(p.botDifficulty, 0.7), 'Diamond I');
    p.socket._careerLives = 0; p.socket._royaleLives = 0;
    royale.freshRaidBody(p);
    assert.equal(p.botNewbie, true);
    assert.equal(p.botDifficulty, 0);
    assert.equal(p.botSoftMs, FM.BOT_SOFT_MS, 'a new player gets the long soft window');
    // DBG botdiff pins it
    p.socket._careerLives = 100; p.botNewbie = false;
    p.socket.player = { body: p };
    assert.equal(royale.debugBotDiff(p.socket, 90), 0.9);
    assert.equal(royale.debugBotDiff(p.socket, 'off'), 0.7);
    p.kill();
    loop(2);
});

legacy('stamp: newness runs on play time and lives, the soft window follows it', () => {
    const min = m => m * 60_000;
    const p = tank(0, (nextY += 1500), false);
    const sock = p.socket;
    p.socket.player = { body: p };
    // a guest with two lives in their past and none of the clock: new
    sock._careerLives = 2; sock._careerPlayMs = min(1); sock._royaleLives = 0; sock._royalePlayMs = 0;
    royale.freshRaidBody(p);
    assert.equal(p.botNewbie, true);
    assert.equal(p.botSoftMs, FM.BOT_SOFT_MS);
    // the same guest has now played 30 minutes this session without dying
    // much (the complaint): not new, and at least mid difficulty
    sock._royaleLives = 1; p._lifeCounted = true;
    p.royaleBornAt = Date.now() - min(29);
    royale.debugBotDiff(sock, 'off');
    assert.equal(p.botNewbie, false, 'not new after 30 minutes');
    assert.equal(p.botNewness, 0);
    assert.ok(p.botDifficulty >= 0.5, 'difficulty ' + p.botDifficulty);
    assert.ok(Math.abs(p.botDifficulty - D.fromTime(min(30))) < 0.02);
    // their next life: the short soft window
    p.deathCause = 'storm';
    royale.onCombatantDead(p);
    assert.ok(sock._royalePlayMs >= min(29) - 1000, 'the life was booked: ' + sock._royalePlayMs);
    const q = tank(0, (nextY += 1500), false);
    q.socket = sock; sock.player = { body: q };
    royale.freshRaidBody(q);
    assert.equal(q.botNewbie, false);
    assert.equal(q.botSoftMs, FM.BOT_SOFT_SHORT_MS);
    assert.ok(q.botSoftMs <= 30_000);
    // halfway through the fade (about 8.5 minutes in all): between the two
    sock._royalePlayMs = min(7.5);
    royale.freshRaidBody(q);
    assert.ok(q.botNewness > 0.4 && q.botNewness < 0.6, 'newness ' + q.botNewness);
    assert.ok(q.botSoftMs > FM.BOT_SOFT_SHORT_MS && q.botSoftMs < FM.BOT_SOFT_MS);
    assert.ok(q.botDifficulty > 0 && q.botDifficulty < D.fromTime(min(8.5)));
    // account play time counts the same way
    sock._careerPlayMs = min(40); sock._royalePlayMs = 0;
    royale.freshRaidBody(q);
    assert.equal(q.botNewbie, false);
    // and lives alone end it for someone who dies a lot early
    sock._careerPlayMs = 0; sock._careerLives = 0; sock._royaleLives = 9;
    royale.freshRaidBody(q);
    assert.equal(q.botNewbie, false);
    assert.equal(q.botNewness, 0);
    q.kill(); p.kill();
    loop(2);
});

test('bosses: boss guns target a new player once the grace is over', () => {
    const boss = new Entity({ x: 0, y: (nextY += 1500) });
    boss.define('royaleVaultWarden');
    boss.isRoyaleBoss = true; boss.team = TEAM_ENEMIES; boss.alwaysActive = true;
    boss.controllers = boss.controllers.filter(c => c.constructor && c.constructor.name === 'io_nearestDifferentMaster');
    const p = tank(-260, boss.y, false);
    p.socket._careerLives = 0; p.socket._royaleLives = 0; p.socket._careerPlayMs = 0;
    royale.freshRaidBody(p);
    assert.equal(p.botNewbie, true);
    p.invuln = false;
    const ctl = boss.controllers[0];
    const aimsAt = () => { ctl.targetLock = undefined; ctl.tick = 99; ctl.think({}); return ctl.targetLock === p; };
    loop(1);
    assert.equal(aimsAt(), false, 'grace holds');
    p.botGraceUntil = 0;
    loop(1);
    assert.equal(aimsAt(), true, 'a new player is a boss target like anyone');
    p.socket.botMercyUntil = Date.now() + 60_000;
    assert.equal(aimsAt(), true, 'mercy is about bots, not bosses');
    boss.kill(); p.kill();
    loop(2);
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
