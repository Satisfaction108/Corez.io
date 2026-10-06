// Round 12 (Oct 2026 blind playtest, 72/100 "too easy now"): node scripts/test/round12.test.js
//
//   hunt       after the opening grace, a #1 leading #2 by 1.5x+ (human or bot)
//              is a priority target for bots near them, more with a bigger lead,
//              and their spot is pinged on every minimap every 30 s
//   gentle     ROYALE_BOTS_GENTLE no longer stacks on the opening grace
//   bank       banked gems count 1:1 up to 5,000 points per raid, then half;
//              the gems are never cut, the text says so
//   minetip    the Mining Power tip is only marked seen once shown, also shows
//              with unspent points, never in the tutorial
//   tutorial   the "New here?" offer only in the first minute of a first raid
//   small      Team Bank line on approach, "Spendable" pill, pad timers in the
//              note stack, markers off the minimap, FRESH START on a reused raid id
'use strict';
for (const k of ['ROYALE_LEADER_HUNT', 'ROYALE_LEADER_HUNT_RATIO', 'ROYALE_OPEN_GRACE_S', 'ROYALE_BOTS_GENTLE', 'ROYALE_GENTLE_STACK',
    'ROYALE_BANK_SOFT', 'ROYALE_BANK_SOFT_RATE', 'ROYALE_DEBUG']) delete process.env[k];
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-round12-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
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
Config.dig_royale = true;
Config.tutorial = false;
const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
global.gameManager = {
    room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
global.gameManager.gameHandler = new gameHandler(global.gameManager);
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const pacing = require(path.join(SERVER, 'game', 'terrain', 'pacing.js'));
const controllers = require(path.join(SERVER, 'miscFiles', 'controllers.js'));
const botDiff = require(path.join(SERVER, 'miscFiles', 'botDifficulty.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const live = (o) => Object.assign({ isDead: () => false, health: { amount: 100, max: 100 } }, o);

test('hunt: a 1.5x leader after the opening grace, human or bot, and the minimap ping', () => {
    const t = 50_000_000;
    const was = global.royaleRaidStartAt;
    try {
        const human = live({ id: 71001, isPlayer: true, name: 'Lead', x: 100, y: 200, socket: {} });
        const L = (body, score, second) => ({ body, key: 'k' + body.id, score, lead: score - second });
        // in the opening grace: nothing
        global.royaleRaidStartAt = t - 60_000;
        assert.equal(pacing.huntFor(L(human, 6000, 2000), t), null, 'not in the first 3 minutes');
        global.royaleRaidStartAt = t - 200_000;
        assert.equal(pacing.huntFor(L(human, 2900, 2000), t), null, '1.45x is not a runaway');
        assert.equal(pacing.huntFor(L(human, 1400, 100), t), null, 'too few points to matter');
        const h = pacing.huntFor(L(human, 6000, 2500), t);
        assert.ok(h && h.id === human.id && Math.abs(h.ratio - 2.4) < 1e-9);
        // the same rule for a bot leader
        const bot = live({ id: 71002, isBot: true, name: 'Bot', x: 0, y: 0 });
        assert.ok(pacing.huntFor(L(bot, 6000, 2500), t), 'a bot leader is hunted the same');
        // the tick: global flag, a ping, a callout for a human leader, every 30 s
        const said = [];
        pacing.attach({ leader: () => L(human, 6000, 2500), callout: (b, k, text, p, sub) => said.push(text + ' ' + sub), live: () => true });
        pacing.reset(t);
        pacing.leaderTick(t);
        assert.equal(global.royaleLeaderHunt && global.royaleLeaderHunt.id, human.id);
        const snap = pacing.huntSnapshot(t + 1000);
        assert.ok(snap && snap.x === 100 && snap.y === 200 && snap.id === human.id, JSON.stringify(snap));
        assert.ok(said.some(s => /You're the target/.test(s) && /pinged to everyone/.test(s)), said.join(' | '));
        assert.equal(pacing.huntSnapshot(t + pacing.HUNT.showMs + 10), null, 'the ping shows a few seconds');
        human.x = 900;
        pacing.leaderTick(t + 10_000);
        assert.equal(pacing.huntSnapshot(t + 10_000), null, 'no new ping before 30 s');
        pacing.leaderTick(t + 31_000);
        assert.equal(pacing.huntSnapshot(t + 31_000).x, 900, 'a fresh ping every 30 s');
        assert.ok(!said.some(s => /—/.test(s)), 'no em dashes');
        pacing.reset(t);
        assert.equal(global.royaleLeaderHunt, null);
        assert.ok(ssrc('game/gamemodes/scripts/dig_royale.js').includes('lping: pacing.huntSnapshot(t) || undefined'));
    } finally { global.royaleRaidStartAt = was; global.royaleLeaderHunt = null; }
});

test('hunt: bots pull toward the leader, scaling with the lead, not in the opening', () => {
    const now = Date.now();
    const was = global.royaleRaidStartAt;
    try {
        const lead = { id: 72001, isPlayer: true };
        global.royaleLeaderHunt = { id: lead.id, ratio: 2 };
        global.royaleRaidStartAt = now - 60_000;
        assert.equal(controllers.leaderHunt(lead, now), null, 'opening grace wins');
        global.royaleRaidStartAt = now - 200_000;
        const h = controllers.leaderHunt(lead, now);
        assert.ok(h);
        assert.equal(controllers.leaderHunt({ id: 1 }, now), null, 'only the leader');
        assert.ok(controllers.leaderPull({ ratio: 1.5 }) < controllers.leaderPull({ ratio: 2 }));
        assert.ok(controllers.leaderPull({ ratio: 2 }) < controllers.leaderPull({ ratio: 2.4 }));
        assert.ok(controllers.leaderPull({ ratio: 50 }) <= 1100, 'capped');
        assert.equal(controllers.leaderCap({ ratio: 1.6 }), 2);
        assert.equal(controllers.leaderCap({ ratio: 2.4 }), 3);
        assert.ok(controllers.LEADER_R >= 2000, 'a wide radius');
        const src = ssrc('miscFiles/controllers.js');
        assert.ok(src.includes('- leaderPull(lh)'), 'target scoring');
        assert.ok(src.includes('if (lh) return leaderCap(lh);'), 'hunter cap');
        assert.ok(src.includes("return { kind: 'explore', point: { ...this.safePoint(e.x + Math.cos(a) * 500, e.y + Math.sin(a) * 500), until: now + 3500 }, hunt: 1 };"));
        // the leader's own stats and damage are never touched
        const fn = src.slice(src.indexOf('function leaderHunt('), src.indexOf('// A player in the soft window'));
        assert.ok(!/damageReceived|health\.max|\.damage\s*\*=/.test(fn));
        // spawn grace, bank holds and anti-farm still apply to the leader
        assert.ok(src.includes('if (inBotGrace(root, now)) continue;'));
        assert.ok(src.includes('if (root.isPlayer && fairPlay.farmed(body, root, now)) continue;'));
    } finally { global.royaleRaidStartAt = was; global.royaleLeaderHunt = null; }
});

test('gentle: not on top of the opening grace, back from minute 3', () => {
    const now = Date.now();
    const was = global.royaleRaidStartAt;
    try {
        const p = { isPlayer: true };
        global.royaleRaidStartAt = now - 30_000;
        assert.equal(botDiff.gentle(p, now), 0, 'the grace already holds bots back');
        global.royaleRaidStartAt = now - 200_000;
        assert.equal(botDiff.gentle(p, now), botDiff.GENTLE_DEFAULT);
        assert.equal(botDiff.gentle({ isBot: true }, now), 0);
    } finally { global.royaleRaidStartAt = was; }
});

test('bank: 1:1 up to 5,000 points, then half; gems never cut', () => {
    assert.equal(royale.BANK_SOFT, 5000);
    assert.equal(royale.BANK_SOFT_RATE, 0.5);
    assert.equal(royale.bankWeight(4000), 4000);
    assert.equal(royale.bankWeight(5000), 5000);
    assert.equal(royale.bankWeight(12000), 8500);
    assert.equal(royale.bankPtsOf({ banked: 16000, restoredBanked: 4000 }), 4000 + 8500, 'a restored save is left as it was');
    const s = { banked: 12000, kills: 1, killPts: 300 };
    const p = royale.scoreParts(s);
    assert.equal(p.bank, 8500);
    assert.equal(royale.scoreOf(s), 8800);
    assert.equal(s.banked, 12000, 'the gems are untouched');
    assert.ok(royale.bankShownOf(s) <= royale.scoreOf(s));
    // the same for a bot (then its own log dim on top)
    assert.equal(royale.scoreParts({ isBot: true, banked: 12000 }).bank, 8500);
    const dr = ssrc('game/gamemodes/scripts/dig_royale.js');
    assert.ok(dr.includes('function atRiskOf(s) { return Math.max(0, scoreOf(s) - bankPtsOf(s)); }'), 'crown steals never reach banked');
    assert.ok(/pts: \(mine\.banked \| 0\) > parts\.bank[\s\S]{0,160}g: mine\.banked \| 0/.test(dr), 'RY says how many gems made the points');
});

function memStore() {
    const m = new Map();
    return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), m };
}

(async () => {
    const CL = await import(pathToFileURL(path.join(CLIENT, 'coachLogic.js')).href);
    const SL = await import(pathToFileURL(path.join(CLIENT, 'scoreLogic.js')).href);
    const FL = await import(pathToFileURL(path.join(CLIENT, 'firstSecondsLogic.js')).href);
    const BL = await import(pathToFileURL(path.join(CLIENT, 'buildButtonsLogic.js')).href);

    test('minetip: shown once even after autoStats put points in, and with unspent points', () => {
        const dig = (st, s, o, n) => { let out = '', t = o.t; for (let i = 0; i < n; i++) { t += 250; out = CL.mineTip(st, s, { ...o, t, dt: 250 }); } return out; };
        // Mining Power already has points (autoStats or the tutorial): the key is NOT burned
        const s = memStore(), st = { dig: 0, show: 0 };
        assert.equal(dig(st, s, { t: 0, alive: true, dig: true, mp: 2, pts: 0 }, 80), '');
        assert.equal(s.getItem(CL.MINE_TIP_KEY), null, 'not marked seen without showing');
        // then unspent points while mining: it shows
        assert.equal(dig(st, s, { t: 30000, alive: true, dig: true, mp: 2, pts: 3 }, 41), 'show');
        assert.equal(s.getItem(CL.MINE_TIP_KEY), '1');
        // a point into Mining Power takes it down
        assert.equal(CL.mineTip(st, s, { t: 41000, dt: 250, alive: true, dig: true, mp: 3, pts: 2 }), '');
        // never again
        assert.equal(dig({ dig: 0, show: 0 }, s, { t: 50000, alive: true, dig: true, mp: 0, pts: 0 }, 80), '');
        // zero Mining Power still shows; the tutorial never
        const s2 = memStore();
        assert.equal(dig({ dig: 0, show: 0 }, s2, { t: 0, alive: true, dig: true, mp: 0, tut: true }, 80), '');
        assert.equal(s2.getItem(CL.MINE_TIP_KEY), null);
        assert.equal(dig({ dig: 0, show: 0 }, s2, { t: 0, alive: true, dig: true, mp: 0 }, 41), 'show');
        assert.ok(/3 stat points/.test(CL.mineTipText(false, '-', 3)));
        assert.ok(!/—/.test(CL.mineTipText(false, '-', 3) + CL.mineTipText(true, '', 2)));
        const coach = csrc('coach.js');
        assert.ok(coach.includes('push(mk(-1, "minetip"'), 'top of the note stack');
        assert.ok(coach.includes('tut: !!global.tutorialMode'));
    });

    test('tutorial offer: first minute of a first raid only', () => {
        const rec = CL.blank(0);
        assert.equal(CL.tutorialOfferOpen(rec, 1000), true, 'not seen playing yet');
        rec.t0 = 1000;
        assert.equal(CL.tutorialOfferOpen(rec, 50_000), true);
        assert.equal(CL.tutorialOfferOpen(rec, 1000 + 61_000), false, 'past the first minute');
        const rec2 = CL.blank(0); rec2.done.move = 1; rec2.done.mine = 1;
        assert.equal(CL.tutorialOfferOpen(rec2, 0), false, 'first-raid steps done: never');
        const coach = csrc('coach.js');
        assert.ok(coach.includes('!CL.tutorialOfferOpen(rec, Date.now())'));
        assert.ok(coach.includes('if (!(rec.t0 > 0)) { rec.t0 = Date.now(); save(); }'));
    });

    test('bank text: Spendable pill, tiles past the soft line, rule body says half', () => {
        assert.equal(SL.BANK, 'Spendable');
        assert.ok(/^Spendable: /.test(SL.BANK_TIP));
        assert.ok(/counts half a point/.test(SL.RULE_BODY) && /you keep every gem/.test(SL.RULE_BODY));
        const you = { pts: { b: 8500, k: 300, c: 0, g: 12000, t: 5000, r: 0.5 } };
        const t0 = SL.tiles(you)[0];
        assert.deepEqual(t0, ['BANKED PTS', '8,500', 'gem']);
        assert.equal(SL.bankFrom(SL.parts(you)), 'from 12,000 gems (past 5,000 counts half)');
        assert.equal(SL.parts(you).total, 8800);
        assert.equal(SL.bankSoftLine(SL.parts(you)), 'Banked: 12,000 gems = 8,500 pts (past 5,000, each gem counts half)');
        assert.deepEqual(SL.tiles({ pts: { b: 3000, k: 0, c: 0 } })[0], ['BANKED THIS RAID', '3,000', 'gem'], 'below it, as before');
        assert.ok(csrc('raidFinale.js').includes('const lab = soft ? SL.BANK_PTS_LABEL : CELL_LABEL[i];'));
        for (const x of [SL.RULE_BODY, SL.BANK_TIP_BODY, BL.TEAM_BANK_TIP]) assert.ok(!/—/.test(x), 'no em dashes');
    });

    test('small: Team Bank line, pad timers, minimap markers, stats in the tutorial, FRESH START', () => {
        assert.equal(BL.TEAM_BANK_TIP, 'Team Bank: break its banner to own it. Owners bank here safely; Vaults are open to everyone.');
        const app = csrc('app.js');
        assert.ok(app.includes('Math.hypot(sx - global.screenWidth / 2, sy - global.screenHeight / 2) < buildBtnLabels.TEAM_BANK_NEAR * ratio'));
        assert.ok(app.includes('push(hudNote(1, "padtime", "You can come back in " + r.lockout + "s", color.guiwhite))'));
        assert.ok(!app.includes('drawText("You can come back in " + r.lockout'), 'not under the name any more');
        assert.ok(app.includes('global.minimapHintRect = {') && app.includes('if (mh && !global.mobile) out.push(mh);'));
        assert.ok(app.includes('if (global.tutorialMode) statMenu.set(1);'));
        assert.ok(app.includes('const lp = r.lping;'), 'leader ping on the minimap');
        // TDZ: the new app.js state is declared before the function that reads it
        assert.ok(app.indexOf('let teamBankTold = false;') < app.indexOf('function drawOutpostLabels('));
        // a raid id reused across workers still counts as a new raid at a spawn
        assert.equal(FL.isNewRaid(5, 5, 1_000_000, 1_000_000 + 600_000), true);
        assert.equal(FL.isNewRaid(5, 5, 1_000_000, 1_000_000 + 5_000), false, 'clock jitter is not a new raid');
        assert.equal(FL.isNewRaid(5, 6), true);
        assert.equal(FL.raidStartOf({ raidMs: 900_000, raidLeft: 600 }, 2_000_000), 2_000_000 - 300_000);
        assert.ok(csrc('firstSeconds.js').includes('L.isNewRaid(S.raid, rid, S.alive ? 0 : S.raidStart, start)'));
        assert.ok(csrc('socketinit.js').includes('r.raidMs = d.raidMs | 0;'));
    });

    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); log('ok   ' + t.name); }
        catch (e) { failed++; log('FAIL ' + t.name + '\n     ' + ((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')); }
    }
    log(`\n${tests.length - failed}/${tests.length} passed`);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
    process.exit(failed ? 1 : 0);
})();
