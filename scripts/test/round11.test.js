// Round 11 (Oct 6 2026, blind playtest 66/100): node scripts/test/round11.test.js
//
//   storm      the first storm is gentler for everyone (stage 0.35, ramp 1.5x slower)
//   opening    raid-opening grace: most bots don't start fights with humans in the
//              first 3 minutes, the same for every human; fighting back still works
//   minetip    one-time Mining Power tip (coachLogic.mineTip)
//   coach      the ability nag keeps its time on screen across reloads, wall-clock retire
//   numbers    the board's "banked" is this raid's and never above the points
//   kills      300 a kill, a small early-streak bonus, stage multiplier kept
//   small      respawn label fits, no "LOCKED", 27 s results gap, no "+N starting gems" when off
'use strict';
for (const k of ['ROYALE_STORM_STAGE1', 'ROYALE_STORM_STAGE2', 'ROYALE_STORM_RAMP1', 'ROYALE_OPEN_GRACE_S', 'ROYALE_OPEN_SHARE',
    'ROYALE_KILL_SCORE', 'ROYALE_STREAK_PTS', 'ROYALE_END_WAIT_MS', 'ROYALE_PLACE_BONUS']) delete process.env[k];

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');
const ssrc = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');
const csrc = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');

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
global.gameManager.gameHandler = new gameHandler(global.gameManager);
const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
const controllers = require(path.join(SERVER, 'miscFiles', 'controllers.js'));

const TICK = 1000 / 30;
let clock = 9_000_000;
const realNow = Date.now;
Date.now = () => clock;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let fakeId = 2e7;
const fakes = [];
function body(x, y, extra) {
    const b = Object.assign({
        id: fakeId++, isPlayer: true, x, y,
        health: { amount: 100, max: 100 }, shield: { amount: 0, max: 0 },
        isDead() { return this.health.amount <= 0; },
    }, extra || {});
    entities.set(b.id, b);
    fakes.push(b);
    return b;
}
function freshStorm() {
    global.royaleMods = {};
    for (const f of fakes.splice(0)) entities.delete(f.id);
    clock += 60 * 60 * 1000;
    storm.setCycles(4);
    storm.setLockMs(20_000);
    storm.start();
}
function run(ms, onTick) {
    const end = clock + ms;
    while (clock < end) {
        clock += TICK;
        storm.tickDamage(clock);
        if (onTick && onTick() === false) break;
    }
}
const OUT = 5200;

test('storm: stage 1 at 0.35, its ramp 1.5x slower, stage 2 still 0.8', () => {
    assert.equal(storm.STAGE_MULT[0], 0.35);
    assert.equal(storm.STAGE_MULT[1], 0.8);
    assert.equal(storm.RAMP_SLOW_FIRST, 1.5);
    freshStorm();
    assert.equal(storm.snapshot(clock).c, 0);
    const b = body(OUT, 0, { health: { amount: 1e9, max: 100 } });
    run(18_000);
    // 18 s out in storm 1 counts as 12 s of ramp
    assert.ok(Math.abs(storm.exposureOf(b).sec - 12) < 0.2, 'ramp seconds ' + storm.exposureOf(b).sec);
    entities.delete(b.id);
    const v = body(OUT, 800);
    const t0 = clock;
    run(180_000, () => v.health.amount > 0);
    const ttd = (clock - t0) / 1000;
    assert.ok(ttd > 50, 'a full-health tank lasts over 50 s out in the first storm (was 30-45), got ' + ttd.toFixed(1));
    // the same for a bot: one rule for everyone
    const p = body(OUT, 0, { health: { amount: 1e9, max: 100 } });
    const q = body(OUT, 10, { isPlayer: false, isBot: true, health: { amount: 1e9, max: 100 } });
    run(10_000);
    assert.ok(Math.abs((1e9 - p.health.amount) - (1e9 - q.health.amount)) < 1e-6, 'bot and human take the same');
});

test('storm: later storms keep their full ramp', () => {
    freshStorm();
    while (storm.snapshot(clock).c < 1) run(5000);
    run(2000);
    const b = body(OUT, 0, { health: { amount: 1e9, max: 100 } });
    run(9000);
    assert.ok(Math.abs(storm.exposureOf(b).sec - 9) < 0.3, 'storm 2 ramp is real time: ' + storm.exposureOf(b).sec);
});

test('opening: most bots leave humans be for 3 minutes, fight back allowed, same for all', () => {
    const cfg = global.Config;
    const was = { dr: cfg.dig_royale, tut: cfg.tutorial, start: global.royaleRaidStartAt };
    cfg.dig_royale = true; cfg.tutorial = false;
    try {
        assert.equal(controllers.OPEN_GRACE_MS, 180_000);
        global.royaleRaidStartAt = clock - 30_000;
        assert.ok(controllers.raidOpening(clock));
        const humans = [], bots = [];
        for (let i = 0; i < 40; i++) humans.push({ id: 5000 + i * 7, isPlayer: true, x: 2000, y: 0 });
        for (let i = 0; i < 40; i++) bots.push({ id: 9000 + i * 3, isBot: true, x: 0, y: 0 });
        const shareFor = (h) => bots.filter(b => !controllers.openSpared(b, h, clock)).length / bots.length;
        const shares = humans.map(shareFor);
        const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
        assert.ok(mean > 0.15 && mean < 0.45, 'about 30% of bots may start a fight from range: ' + mean.toFixed(2));
        // up close, anyone may
        const h0 = humans[0];
        const near = { ...h0, x: 200, y: 0 };
        assert.ok(bots.every(b => !controllers.openSpared(b, near, clock)), 'close range is fair game');
        // shot by them: fight back
        const spared = bots.find(b => controllers.openSpared(b, h0, clock));
        spared._lastDamageSource = h0; spared._lastDamageAt = clock - 500;
        assert.equal(controllers.openSpared(spared, h0, clock), false, 'fights back');
        // bots among themselves are never spared
        assert.equal(controllers.openSpared(bots[1], bots[2], clock), false);
        // after the opening, nobody is
        global.royaleRaidStartAt = clock - 181_000;
        assert.equal(controllers.raidOpening(clock), false);
        assert.ok(bots.every(b => b === spared || !controllers.openSpared(b, h0, clock)));
        // the canInitiateFight / sense / reaction hooks are wired
        const src = ssrc('miscFiles/controllers.js');
        assert.ok(src.includes('if (openSpared(body, root, now)) continue;'));
        assert.ok(src.includes('if (openSpared(this.body, target, now)) return false;'));
        assert.ok(src.includes('this.reactionMs *= OPEN_REACT'));
        // the human's stats are untouched: it is bot behaviour only
        assert.ok(!/openSpared[\s\S]{0,400}(damageReceived|health\.max\s*\*=)/.test(src));
    } finally {
        cfg.dig_royale = was.dr; cfg.tutorial = was.tut; global.royaleRaidStartAt = was.start;
    }
});

test('numbers, kills, small fixes: server source', () => {
    const dr = ssrc('game/gamemodes/scripts/dig_royale.js');
    assert.match(dr, /const KILL_SCORE = Math\.max\(0, \+process\.env\.ROYALE_KILL_SCORE \|\| 300\);/);
    assert.match(dr, /STREAK_EARLY_PTS \* \(ks\.streak - 1\)/);
    // the stage multiplier stays on the kill
    assert.match(dr, /const kp0 = Math\.round\(\(victimBot \? botKillScore\(\) : killScore\(\)\) \* killStageMult\(\)\);/);
    assert.match(dr, /gems: bankShownOf\(s\),/);
    assert.match(dr, /nextGems: raidResults && PLACE_BONUS \?/);
    assert.match(dr, /ROYALE_END_WAIT_MS \|\| 27_000\)/);
    assert.match(dr, /dig: bodyLive && t - Math\.max\(body\._rockHitAt \|\| 0, body\._grindDigAt \|\| 0\) < 1200 \? 1 : undefined,/);
    // bankShownOf: a bot's dimmed points never show a bigger "banked"
    const fn = dr.slice(dr.indexOf('function bankShownOf'), dr.indexOf('// the part a crown steal can take'));
    const scoreParts = (s) => ({ bank: s.banked | 0, kills: s.k | 0, crown: 0 });
    const botDim = (raw) => raw > 2500 ? Math.round(2500 + 2500 * Math.log(1 + (raw - 2500) / 2500)) : raw;
    const scoreOf = (s) => { const p = scoreParts(s); const raw = p.bank + p.kills + p.crown; return s.isBot ? botDim(raw) : raw; };
    // (round 12: the banked part is bankPtsOf, plain gems below the soft line)
    const bankShownOf = new Function('scoreParts', 'scoreOf', 'bankPtsOf', fn + '\nreturn bankShownOf;')(scoreParts, scoreOf, (s) => s.banked | 0);
    const bot = { isBot: true, banked: 14834, k: 600 };
    assert.ok(bankShownOf(bot) <= scoreOf(bot), bankShownOf(bot) + ' <= ' + scoreOf(bot));
    const human = { banked: 3000, k: 900 };
    assert.equal(bankShownOf(human), 3000);
});

test('numbers and small fixes: client source', () => {
    const rf = csrc('raidFinale.js');
    assert.ok(rf.includes('SL.podiumBanked(gems)'), 'podium says gems banked this raid (scoreLogic), shorter only when it must fit');
    assert.ok(!/fmtNum\(row\.gems \| 0\) \+ " banked"/.test(rf), 'no bare banked on the podium');
    assert.ok(+rf.match(/const END_MS = (\d+);/)[1] > 1600 + 27000);
    assert.ok(rf.includes('if (S.me.next > 0) add("Next raid: +"'), 'the chip only shows a real bonus');
    const app = csrc('app.js');
    assert.ok(app.includes('[aoHud.on() ? "BANKED TODAY" : "BANKED THIS RAID", String(global.royale.you.banked | 0), "gem"]'));
    assert.ok(app.includes('function fitBtnFont('));
    assert.ok(!app.includes('coach.mineTipNote('), 'no Mining Power tip in the note stack');
    // shortRespawn fits the storm-lock countdown
    const m = app.match(/function shortRespawn\(label\) \{[\s\S]*?\n    \}/);
    const shortRespawn = new Function(m[0] + '\nreturn shortRespawn;')();
    assert.equal(shortRespawn('Respawn in 3...'), 'Respawn 3');
    assert.equal(shortRespawn('Storm resetting (12s)'), 'Respawn 12s');
    assert.equal(shortRespawn('Storm resetting: you drop in (7s)'), 'Drop in 7s');
    assert.ok(!csrc('raidHeat.js').includes('"LOCKED"'), 'the lock-on label is plain words');
    assert.ok(!csrc('coach.js').includes('case "ability"'), 'the guide has no ability step');
});

function memStore() {
    const m = new Map();
    return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), m };
}

(async () => {
    const CL = await import(pathToFileURL(path.join(CLIENT, 'coachLogic.js')).href);
    test('minetip: once, after 10 s digging with 0 Mining Power', () => {
        const s = memStore(), st = { dig: 0, show: 0 };
        let t = 1000, out = '';
        for (let i = 0; i < 36; i++) { t += 250; out = CL.mineTip(st, s, { t, dt: 250, alive: true, dig: true, mp: 0 }); }
        assert.equal(out, '', 'not before 10 s of digging');
        for (let i = 0; i < 4; i++) { t += 250; out = CL.mineTip(st, s, { t, dt: 250, alive: true, dig: true, mp: 0 }); }
        assert.equal(out, 'show');
        assert.equal(s.getItem(CL.MINE_TIP_KEY), '1');
        t += CL.MINE_TIP_SHOW_MS + 10;
        assert.equal(CL.mineTip(st, s, { t, dt: 250, alive: true, dig: true, mp: 0 }), '', 'goes away');
        // a new page: never again
        const st2 = { dig: 0, show: 0 };
        for (let i = 0; i < 80; i++) { t += 250; out = CL.mineTip(st2, s, { t, dt: 250, alive: true, dig: true, mp: 0 }); }
        assert.equal(out, '');
        // a player who already put a point in never sees it
        const s3 = memStore(), st3 = { dig: 0, show: 0 };
        for (let i = 0; i < 80; i++) { t += 250; out = CL.mineTip(st3, s3, { t, dt: 250, alive: true, dig: true, mp: 2 }); }
        assert.equal(out, '');
        assert.ok(/Mining Power makes you dig faster/.test(CL.mineTipText(false, '-')));
        assert.ok(!/—/.test(CL.mineTipText(false, '-') + CL.mineTipText(true)), 'no em dashes');
    });
    test('coach: the ability nag survives a reload and retires on the wall clock', () => {
        const s = memStore();
        let rec = CL.load(s, 0);
        for (let ms = 0; ms < 30_000; ms += 100) CL.abilityShown(rec, s, 100, 5, 1_000_000 + ms);
        // reload: the time on screen is still there
        rec = CL.load(s, 0);
        assert.ok(rec.ab && rec.ab.ms >= 25_000, 'kept ' + (rec.ab && rec.ab.ms));
        assert.equal(rec.ab.raid, 5);
        let retired = false;
        for (let ms = 0; ms < CL.ABILITY_NAG_MS && !retired; ms += 100) retired = CL.abilityShown(rec, s, 100, 5, 1_100_000 + ms);
        assert.ok(retired, 'retires within the nag time across the reload');
        assert.ok(CL.ABILITY_NAG_MS <= 60_000);
        // same raid id (another raid worker) but much later: retires too
        const s2 = memStore();
        const r2 = CL.load(s2, 0);
        CL.abilityShown(r2, s2, 100, 3, 2_000_000);
        assert.equal(CL.abilityShown(r2, s2, 100, 3, 2_000_000 + CL.ABILITY_WALL_MS + 1), true);
        assert.equal(CL.nextStep(CL.load(s2, 0)) === 'ability', false);
    });

    let failed = 0;
    for (const t of tests) {
        try { t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
    }
    Date.now = realNow;
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
