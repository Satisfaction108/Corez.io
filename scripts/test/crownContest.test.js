// The Crown Contest: node scripts/test/crownContest.test.js
//
//   start      the last storm hands crowns to the top 3 (bots too); the
//              board stays in points order (crowns never reorder it)
//   hold       a crown pays PPS a second (double in the final minute) and
//              BELL_BONUS at the bell, board only
//   steal      killing a crowned tank takes its crown and 30% of its kill and
//              crown points, at most STEAL_CAP; banked gems are never taken
//              (board only: the rank basis never sees the swing)
//   pass       a storm death hands the crown to the best uncrowned tank; a
//              bot that kills a crown takes it; a killer who already wears
//              one gets the points and the crown moves on
//   spawns     no respawn lock in the last storm (cycle ends still lock)
//   sudden     the last 60 s: crowns pay double, the Core truce is over,
//              crowns show at their real spot; a crown still banks (round 5)
//              but the vault won't hide it
//   winner     the most points wins, crown or not; the crown bonus is on
//              the results rows (cb); the endRaid results shape; a crowns
//              failure can't stop the raid ending
//   bots       a bot kill pays 30% of a human kill (streak bonus too)
//   accounts   a Core Champion's raid win and win streak (late joiners
//              included), the 24 h champion crown, the Discord line
//   client     the tracker, the note and the raid end words
'use strict';
// round 12: this file pins the plain formula; round12.test.js covers the banked soft line
process.env.ROYALE_BANK_SOFT = '0';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `crowns-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-crowns-test-'));
fs.mkdirSync(ROOT, { recursive: true });
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ROYALE_CROWNS', 'ROYALE_PERKS', 'DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ACCOUNTS_ALLOW_DEBUG']) delete process.env[k];
process.env.NODE_ENV = 'test';
// the crown maths assume a flat 200-point kill and no leader bounty (round 10's storm-stage kill
// multiplier and the leader bounty are covered in round10.test.js)
process.env.ROYALE_STAGE_KILLS = '0';
// round 11 raised the kill to 300 and added an early streak bonus (round11.test.js)
process.env.ROYALE_KILL_SCORE = '200';
process.env.ROYALE_STREAK_PTS = '0';
process.env.ROYALE_LEADER_BOUNTY = '0';
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'crowns-test-secret-0123456789-abcdefghijklmnop';

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

const T = p => require(path.join(SERVER, 'game', 'terrain', p));
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const crowns = T('crowns.js');
const storm = T('storm.js');
const vault = T('vault.js');
const shop = T('shop.js');
const activity = require(path.join(SERVER, 'game', 'network', 'activity.js'));

global.gameManager.terrainGrid = {
    vaultSites: [{ x: 0, y: -3000, r: 95 }, { x: 0, y: 6000, r: 95 }],
    shopSites: [{ id: 0, name: 'Shop', x: 3000, y: 0, r: 95 }],
    outpostSites: [], spawnPits: [],
};
vault.getVaults(); shop.getShops();
global.gameManager.terrainGrid = null;
storm.start();
royale.tick();      // the first raid starts here, before anyone joins

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let seq = 0;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'cr' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    global.gameManager.socketManager.clients.push(s);
    return s;
}
function human(x = 0, y = 0) {
    const sock = mkSocket();
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (++seq);
    t.name = 'Hu' + seq;
    t.alwaysActive = true;
    t.msgs = [];
    t.sendMessage = (m) => t.msgs.push(m);
    const player = { socket: sock, body: t, target: { x: 120, y: 0 }, command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, autofire: false, autospin: false, override: false } };
    sock.player = player;
    t.socket = sock;
    level45(t);
    global.gameManager.socketManager.players.push(player);
    royale.onHumanJoin(t);
    t.x = x; t.y = y; t.velocity.x = 0; t.velocity.y = 0;
    activity.noteCommand(sock, 100 + seq, 0, 0);
    return t;
}
function bot(x = 0, y = 0) {
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
// one clock for the whole run: the raid, the storm and the crowns all read it
let clock = Date.now();
Date.now = () => clock;
const tick = (ms = 300) => { clock += ms; royale.tick(); };
// endRaid's own timers (the beat, the wait, the next raid): caught and run
// on our clock instead of 16 s of real time
function endRaidNow(fn) {
    const timers = [];
    const st = global.setTimeout;
    global.setTimeout = (f, ms) => { timers.push({ f, ms: ms | 0 }); return 0; };
    try { fn(); } finally { global.setTimeout = st; }
    return () => {
        const t0 = clock;
        for (const t of timers.sort((a, b) => a.ms - b.ms)) { clock = t0 + t.ms; t.f(); }
        tick(300);
    };
}
const setScore = (b, n) => royale.debugSetScore(b, n);
const scoreOf = (b) => royale.scoreOf(royale._statOf(b));
const kcs = (b, kind) => b.socket.packets.filter(p => p[0] === 'KC' && (!kind || p[1] === kind));
function lastRY(sock) {
    for (let i = sock.packets.length - 1; i >= 0; i--) if (sock.packets[i][0] === 'RY') return JSON.parse(sock.packets[i][1]);
    return null;
}
function ry(sock) { tick(600); return lastRY(sock); }
// a death the way the raid books it (dig_royale onCombatantDead)
function die(victim, killer, cause) {
    victim.finalKillers = killer ? [killer] : [];
    if (cause) victim.deathCause = cause;
    if (victim.socket) victim.socket.gemDeathCarried = 0;
    royale.onCombatantDead(victim);
    try { victim.kill(); } catch { /* */ }
    victim.health.amount = -1;
}
// a fresh raid with these tanks in it: everyone else gone
function freshRaid() {
    for (const p of global.gameManager.socketManager.players) if (p.body) { try { p.body.kill(); } catch { /* */ } p.body.health.amount = -1; }
    for (const b of handler.bots) { try { b.kill(); } catch { /* */ } b.health.amount = -1; }
    global.gameManager.socketManager.players.length = 0;
    global.gameManager.socketManager.clients.length = 0;
    handler.bots.length = 0;
    royale.debugEndRaid();
    tick(6000);         // long overdue: a quiet restart, no RAID OVER
    assert.equal(crowns._state().on, false, 'a new raid has no crowns');
}
// a raid with five tanks and a contest started
function contest() {
    freshRaid();
    // a twist that leaves points alone (Bounty Week doubles kills, Copper Rush gem values)
    require('../../server/game/terrain/raidMods.js').roll('rocket_fuel');
    const a = human(0, 0), b = human(300, 0), c = human(600, 0), d = human(900, 0);
    const e = bot(1200, 0);
    for (const x of [a, b, c, d, e]) x.carriedGems = 0;
    royale.boardSnapshot();
    setScore(a, 900); setScore(b, 5000); setScore(c, 3000); setScore(d, 2000); setScore(e, 4000);
    tick();
    assert.equal(crowns._state().on, false, 'no crowns before the last storm');
    royale.debugRaidLeft(300);
    tick();
    return { a, b, c, d, e };
}

// ── the contest ─────────────────────────────────────────────────────────
test('start: the top 3 get crowns at the last storm, bots too; the board stays by points', () => {
    const { a, b, c, d, e } = contest();
    assert.equal(crowns._state().on, true);
    assert.deepEqual([a, b, c, d, e].map(x => !!x.crowned), [false, true, true, false, true]);
    assert.ok(kcs(a, 'crowns').length === 1 && kcs(d, 'crowns').length === 1, 'the contest banner for everyone else');
    assert.ok(kcs(b, 'crowned').length === 1 && kcs(c, 'crowned').length === 1, 'YOU GOT A CROWN for the crowned');
    assert.equal(kcs(b, 'crowns').length, 0, 'not both');
    // every moment says what it is worth, in one line
    const out = kcs(a, 'crowns')[0];
    assert.equal(out[2], 'CROWNS ARE OUT');
    assert.ok(/Holding one earns points/.test(out[4]) && /steal it and 30% of their kill and crown points/.test(out[4]), out[4]);
    const got = kcs(b, 'crowned')[0];
    assert.ok(/YOU GOT A CROWN/.test(got[2]) && /\+5 pts\/sec while you hold it/.test(got[4]), got[4]);
    // and what a kill would cost them, right there
    // ("now": the steal grows as they earn, the crown card keeps it live)
    assert.ok(/Others will hunt you\. If they get you now, you lose 1,500 pts, more as you earn \(your crown card keeps count; banked gems are safe\)\./.test(got[4]), got[4]);
    const r = ry(a.socket);
    assert.equal(r.crowns.on, 1);
    assert.equal(r.crowns.pps, crowns.PPS);
    assert.equal(r.crowns.bell, crowns.BELL_BONUS);
    assert.deepEqual(r.crowns.list.map(x => x.e), [b.id, e.id, c.id], 'best first');
    assert.equal(r.crowns.list[0].f, 1, 'only the area until sudden death');
    assert.ok(Math.abs(r.crowns.list[0].x % crowns.FUZZ) === 0, 'snapped to the grid');
    // a big uncrowned score leads the board: points only
    setScore(d, 9000);
    const board = royale.boardSnapshot();
    assert.deepEqual(board.slice(0, 4).map(x => x.id), [d.id, b.id, e.id, c.id]);
    assert.ok(!board[0].cr && board[1].cr && board[2].cr && board[3].cr);
    assert.deepEqual(board.map(x => x.place), board.map((x, i) => i + 1));
    for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].score >= board[i].score, 'sorted by points');
    assert.equal(JSON.stringify(board).includes('"_k"'), false, 'the stat key never goes on the wire');
    const src = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.ok(!/crowns\.rank\(/.test(src) && typeof crowns.rank === 'undefined', 'no crown reordering anywhere');
});

test('hold: a crown pays points a second, double in the final minute, a bonus at the bell', () => {
    const { a, b, d } = contest();
    const b0 = scoreOf(b), a0 = scoreOf(a);
    for (let i = 0; i < 10; i++) tick(1000);
    assert.equal(scoreOf(b) - b0, 10 * crowns.PPS, 'PPS a second');
    assert.equal(scoreOf(a), a0, 'no crown, no pay');
    assert.equal(royale._statOf(b).crownPts, 10 * crowns.PPS);
    let r = lastRY(b.socket);
    assert.equal(r.crowns.list.find(x => x.e === b.id).p, 10 * crowns.PPS, 'RY: what this crown paid');
    const row = royale.boardSnapshot().find(x => x.id === b.id);
    assert.equal(row.cb, 10 * crowns.PPS, 'board rows carry the crown bonus');
    // the final minute: double
    royale.debugRaidLeft(50);
    tick(300);
    const b1 = scoreOf(b);
    for (let i = 0; i < 4; i++) tick(1000);
    assert.equal(scoreOf(b) - b1, 4 * crowns.PPS * crowns.SD_MULT);
    assert.equal(lastRY(b.socket).crowns.pps, crowns.PPS * crowns.SD_MULT);
    assert.ok(/pays double/.test(kcs(b, 'suddendeath').pop()[4]));
    // the bell: everyone still wearing one gets BELL_BONUS
    const b2 = scoreOf(b), d2 = scoreOf(d);
    for (const x of [a, b, d]) royale._statOf(x).since = Date.now() - 120000;
    const next = endRaidNow(() => { royale.debugEndRaid(); tick(50); });
    assert.ok(scoreOf(b) - b2 >= crowns.BELL_BONUS && scoreOf(b) - b2 < crowns.BELL_BONUS + 10, 'bell bonus ' + (scoreOf(b) - b2));
    assert.equal(scoreOf(d), d2);
    const top = royale._results().top;
    assert.ok(top.find(x => x.id === b.id).cb >= 10 * crowns.PPS + 4 * 10 + crowns.BELL_BONUS);
    next();
});

test('steal: a kill takes the crown and 30% of the kill and crown points, board only', () => {
    const { a, b } = contest();
    const rankBasis = (s) => (s.banked | 0) + (s.killPts | 0) + (s.revengeBonus | 0) + (s.extra | 0) - (s.rankDiscount || 0);
    const a0 = scoreOf(a), b0 = scoreOf(b);
    const sa = royale._statOf(a), sb = royale._statOf(b);
    const ra0 = rankBasis(sa), rb0 = rankBasis(sb), rd0 = sa.rankDiscount || 0;
    die(b, a);
    assert.equal(a.crowned, true, 'the killer has it');
    assert.equal(!!b.crowned, false);
    const stolen = Math.floor(b0 * crowns.STEAL_FRAC / 10) * 10;
    assert.equal(stolen, 1500);
    assert.equal(scoreOf(b), b0 - stolen);
    assert.equal(scoreOf(a), a0 + 200 + stolen, 'kill + steal');
    assert.equal(rankBasis(sa) - ra0, 200 - ((sa.rankDiscount || 0) - rd0), 'ranked counts the kill, never the steal');
    assert.equal(rankBasis(sb), rb0);
    assert.equal(sa.crownSwing, stolen);
    assert.equal(sb.crownSwing, -stolen);
    const hooks = fs.readFileSync(path.join(SERVER, 'accounts', 'game', 'rankHooks.js'), 'utf8');
    assert.ok(!/crownSwing/.test(hooks), 'rankHooks never reads the swing');
    const take = kcs(a, 'crowntake').pop(), lost = kcs(b, 'crownlost').pop();
    assert.ok(take && /CROWN STOLEN/.test(take[2]) && take[3] === stolen, 'the slam for the thief');
    assert.equal(take[4], "You took " + b.name + "'s crown: +1,500 pts, +5/sec while you hold it.");
    assert.ok(lost && /CROWN LOST/.test(lost[2]) && new RegExp(a.name).test(lost[4]), 'and for the victim');
    assert.equal(lost[4], a.name + " took your crown and 1,500 of your kill and crown points. Your banked gems are safe.");
    const feed = ry(a.socket).feed;
    assert.ok(feed.some(f => f.crown && f.took && f.by === a.name && f.name === b.name && f.pts === stolen), "X took Y's crown");
    assert.ok(!feed.some(f => f.name === b.name && f.verb), 'no second kill line for it');
});

test('steal: banked gems are safe points, and one steal takes at most STEAL_CAP', () => {
    const { a, b, c } = contest();
    assert.equal(crowns.STEAL_CAP, 1500);
    // b is a pure banker: 9,455 banked, no kills, wearing a crown it never asked for
    const sb = royale._statOf(b);
    sb.extra = 0; sb.kills = 0; sb.botKills = 0; sb.crownPts = 0; sb.crownSwing = 0;
    sb.banked = 9455;
    assert.equal(scoreOf(b), 9455);
    let r = ry(b.socket);
    assert.deepEqual(r.you.pts, { b: 9455, k: 0, c: r.you.pts.c }, 'the parts: banked, kills & bonuses, crowns');
    assert.equal(r.you.score, r.you.pts.b + r.you.pts.k + r.you.pts.c, 'the parts add up to the points');
    assert.ok(r.you.crown && r.you.crown.pps === crowns.PPS, 'RY: you wear a crown');
    assert.ok(r.you.crown.lose <= 10, 'a banker risks (almost) nothing: ' + r.you.crown.lose);
    const b0 = scoreOf(b);
    die(b, a);
    assert.equal(a.crowned, true, 'the crown still moves');
    assert.ok(b0 - scoreOf(b) <= 10, 'the banked 9,455 stay: lost ' + (b0 - scoreOf(b)));
    assert.equal(royale._statOf(b).banked, 9455);
    const lost = kcs(b, 'crownlost').pop();
    assert.ok(/Your banked gems are safe/.test(lost[4]), lost[4]);
    // the death card's line: what it cost and why
    r = ry(b.socket);
    assert.ok(r.you.dl && r.you.dl.cr === 1 && (r.you.dl.p | 0) <= 10, JSON.stringify(r.you.dl));
    // a big fighter: 30% would be 6,000, the cap holds it to 1,500
    setScore(c, 20000);
    const c0 = scoreOf(c), a0 = scoreOf(a);
    const sa = royale._statOf(a);
    sa.crownSwing = 0;
    die(c, a);      // a already wears one: a smash
    assert.equal(c0 - scoreOf(c), 1500, 'capped');
    assert.ok(scoreOf(a) - a0 >= 1500, 'the killer gets it');
    r = ry(c.socket);
    assert.equal(r.you.dl.p, 1500);
    assert.equal(r.you.dl.by, a.name);
});

test('pass: storm death, a bot thief, and a killer who already has one', () => {
    const { a, b, c, d, e } = contest();
    // the storm takes c: the crown falls to the best uncrowned (d 2000 > a 900)
    const d0 = scoreOf(d);
    c.deathCause = 'storm';
    die(c, null, 'storm');
    assert.equal(d.crowned, true);
    assert.equal(scoreOf(d), d0, 'a fall moves no points');
    assert.ok(kcs(d, 'crowned').length >= 1);
    assert.ok(/fell|FELL/.test(kcs(d, 'crowned').pop()[2]));
    // a bot kills d: the bot takes it, with the points
    const f = bot(1500, 0);
    royale.boardSnapshot();
    setScore(f, 100);
    die(d, f);
    assert.equal(f.crowned, true, 'a bot can hold a crown');
    assert.ok(scoreOf(f) > 100 + 500, 'and steals: ' + scoreOf(f));
    // b (crowned) kills e (crowned): b gets the points, the crown goes to a
    const b0 = scoreOf(b), e0 = scoreOf(e);
    die(e, b);
    assert.equal(b.crowned, true);
    assert.equal(a.crowned, true, 'one crown each: the next best gets it');
    assert.equal(scoreOf(b), b0 + Math.round(200 * crowns.BOT_KILL_SHARE) + Math.floor(e0 * 0.3 / 10) * 10);
    assert.equal(crowns._state().holders.length, 3);
    assert.ok(/SMASHED/.test(kcs(b, 'crowntake').pop()[2]));
    // a crowned human who just disconnects loses it
    const h = crowns._state().holders.find(x => x.body === a);
    a.isGhost = true;
    tick(300);
    assert.ok(!crowns._state().holders.includes(h), 'gone holders lose it');
    assert.equal(a.crowned, false);
    a.isGhost = false;
});

test('spawns: no lock in the last storm; cycle ends still lock', () => {
    contest();
    assert.equal(storm.isFinal(), true);
    royale.debugRaidLeft(20);       // well inside the old 30 s final lock
    tick(10);
    assert.equal(storm.locked(Date.now() + 1000), false);
    assert.equal(royale.canSpawn(), true);
    assert.equal(storm.snapshot().lock, 0);
    // the old rule is one switch away (ROYALE_CROWNS=0)
    storm.setNoFinalLock(() => false);
    assert.equal(storm.locked(Date.now() + 1000), true, 'without the contest the final lock is back');
    storm.setNoFinalLock(() => crowns.enabled());
    // a mid-raid storm still shuts for its last 20 s
    const src = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'storm.js'), 'utf8');
    assert.ok(/if \(noFinalLock && isFinal\(\)\)/.test(src), 'only the final cycle skips it');
});

test('sudden death: crowns bank but cannot hide, the truce ends, crowns are revealed', () => {
    const { a, b } = contest();
    global.royaleCoreTruce = true;
    royale.debugRaidLeft(50);
    tick();
    assert.equal(crowns.suddenOn(), true);
    assert.equal(global.royaleCrownSD, true);
    assert.ok(kcs(b, 'suddendeath').length && kcs(a, 'suddendeath').length, 'everyone hears it');
    assert.ok(/still bank/.test(kcs(b, 'suddendeath').pop()[4]) && /pushes a crown off/.test(kcs(b, 'suddendeath').pop()[4]));
    assert.equal(kcs(a, 'suddendeath').pop()[2], 'FINAL MINUTE');
    // on the vault a crown banks like anyone (round 5); the vault rule is
    // that it won't hide one (vault.js CROWN_IDLE_MS / CROWN_PAD_MS)
    assert.equal(crowns.bankBlocked(b), null);
    assert.equal(b.crownLocked, true);
    for (const t of [a, b]) { t.x = 0; t.y = -3000; t.vaultOnPad = true; t.carriedGems = 500; t._depositNoAt = 0; }
    assert.equal(vault.depositFor(b, 500), true, 'a crown banks in the final minute');
    assert.ok(b.vaultDeposit && b.vaultDeposit.total === 500);
    vault.cancelDeposit(b, false);
    assert.equal(vault.campLimitMs(b), vault.CROWN_IDLE_MS, 'pushed off right after');
    assert.equal(vault.depositFor(a, 500), true, 'no crown, no problem');
    vault.cancelDeposit(a, false);
    // the Core truce: coreFinale reads the flag
    const core = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'coreFinale.js'), 'utf8');
    assert.ok(/royaleCoreTruce = state === 'up' && !!core && alive\(core\) && !global\.royaleCrownSD/.test(core));
    const r = ry(a.socket);
    assert.equal(r.crowns.sd, 1);
    const row = r.crowns.list.find(x => x.e === b.id);
    assert.equal(row.f, 0);
    assert.equal(row.x, Math.round(b.x), 'the real spot now');
    // the 10 second call
    royale.debugRaidLeft(9);
    tick();
    assert.ok(kcs(a, 'crown10').length === 1 && /Take a crown/.test(kcs(a, 'crown10')[0][4]));
    assert.ok(/Hold on/.test(kcs(b, 'crown10')[0][4]) && /\+500 pts/.test(kcs(b, 'crown10')[0][4]));
});

test('winner: the most points wins, crown or not; results shape', () => {
    const { a, b, c, d, e } = contest();
    setScore(d, 20000);          // no crown, the most points: the win
    setScore(c, 6000);           // crowned, now ahead of b
    royale.debugRaidLeft(40);
    tick();
    // everyone played the raid: started 30 s+ ago
    for (const x of [a, b, c, d]) royale._statOf(x).since = Date.now() - 120000;
    const next = endRaidNow(() => { royale.debugEndRaid(); tick(50); });
    const res = royale._results();
    assert.ok(res, 'the raid ended');
    assert.equal(res.crowns, 1);
    assert.deepEqual(res.top.slice(0, 4).map(x => x.id), [d.id, c.id, b.id, e.id]);
    for (let i = 1; i < res.top.length; i++) assert.ok(res.top[i - 1].score >= res.top[i].score, 'points order');
    assert.deepEqual(res.champ, { id: d.id, name: d.name, score: 20000, bot: 0 });
    assert.ok(res.top[1].cb >= crowns.BELL_BONUS, 'the crowned get their bell bonus, shown as a line');
    assert.equal(res.top[0].cb, undefined);
    assert.deepEqual(Object.keys(res).sort(), ['at', 'champ', 'crowns', 'duos', 'raidId', 'rows', 'top', 'win'].sort());
    assert.deepEqual(res.win, [d.id], 'the victory lap is the champion\'s');
    const end = kcs(a, 'raidend').pop();
    assert.equal(end[4], d.name + ' is the Core Champion with 20,000 pts');
    assert.equal(royale._statOf(d).champWin, true);
    assert.ok(!royale._statOf(c).champWin);
    assert.ok(d.socket._champUntil > Date.now() + 23 * 3600 * 1000, '24 h champion crown (session)');
    assert.equal(d.socket._crownStreak, 1);
    assert.equal(c.socket._crownStreak | 0, 0);
    assert.equal(a.socket._crownStreak | 0, 0);
    // the champion's crown is on the board rows for everyone
    assert.equal(royale.boardSnapshot().find(x => x.id === d.id).ch, 1);
    // the crowns froze at the bell
    assert.equal(crowns._state().done, true);
    next();                              // the next raid
    assert.equal(crowns._state().on, false);
});

// ── duos: crowns on single tanks, their points are the team's ──────────────
// teams are faked through duoRaid.teamKeyOf (the party book is covered in
// party.test.js / duos e2e); everything else is the real raid
function duoContest() {
    const duo = require(path.join(SERVER, 'game', 'duo', 'duoRaid.js'));
    const keyOf0 = duo.teamKeyOf;
    Config.royale_duos = true;
    duo.teamKeyOf = (b) => (b && b._tk) || null;
    const restore = () => { duo.teamKeyOf = keyOf0; Config.royale_duos = false; };
    try {
        const r = contest();
        // team 1: a (900) + b (5000); team 2: c (3000) + d (2000); e: a lone bot (4000)
        r.a._tk = r.b._tk = 'T1';
        r.c._tk = r.d._tk = 'T2';
        royale.boardSnapshot();
        return Object.assign(r, { restore });
    } catch (err) { restore(); throw err; }
}
const teamOf = (r, tm) => (r.teams || []).find(t => t.tm === tm);

test('duos: the contest runs; crowns go to the top 3 tanks, their points and steals count for the team', () => {
    const { a, b, c, d, e, restore } = duoContest();
    try {
        assert.equal(crowns.enabled(), true, 'the Crown Contest is on in duos');
        assert.equal(crowns._state().on, true);
        assert.deepEqual([a, b, c, d, e].map(x => !!x.crowned), [false, true, true, false, true], 'single tanks, top 3 by their own points');
        assert.ok(/Holding one earns your team points/.test(kcs(a, 'crowns')[0][4]), kcs(a, 'crowns')[0][4]);
        assert.ok(/\+5 pts\/sec for your team while you hold it/.test(kcs(b, 'crowned')[0][4]), kcs(b, 'crowned')[0][4]);
        // holding: the holder's points, so the team's
        const t1a = teamOf(ry(a.socket), 'T1').score;
        for (let i = 0; i < 10; i++) tick(1000);
        let r = ry(a.socket);
        assert.equal(r.duos, 1);
        const T1 = teamOf(r, 'T1'), T2 = teamOf(r, 'T2');
        assert.ok(T1.score - t1a >= 10 * crowns.PPS && T1.score - t1a <= 12 * crowns.PPS, 'crown points in the team score: +' + (T1.score - t1a));
        assert.equal(T1.score, scoreOf(a) + scoreOf(b), 'team score = both partners');
        assert.ok(T1.cb >= 10 * crowns.PPS && T2.cb >= 10 * crowns.PPS, 'team rows carry the crown points');
        assert.equal(T1.cr, 1); assert.equal(T2.cr, 1);
        assert.equal(JSON.stringify(r.teams).includes('_ks'), false, 'stat keys never go on the wire');
        assert.ok(r.crowns && r.crowns.on === 1 && r.crowns.list.length === 3, 'the crowns ride RY in duos too');
        // a steal: d (team 2, uncrowned) knocks b's crown off: the crown and 1,500 move teams
        const s1 = teamOf(r, 'T1').score, s2 = teamOf(r, 'T2').score;
        die(b, d);
        assert.equal(d.crowned, true, 'the thief wears it');
        r = ry(a.socket);
        const n1 = teamOf(r, 'T1').score, n2 = teamOf(r, 'T2').score;
        assert.ok(s1 - n1 >= 1500 && s1 - n1 <= 1500 + 3 * crowns.PPS, 'team 1 lost the steal: ' + (s1 - n1));
        assert.ok(n2 - s2 >= 1500 + 200 && n2 - s2 <= 1700 + 6 * crowns.PPS, 'team 2 got the kill and the steal: ' + (n2 - s2));
        assert.equal(teamOf(r, 'T2').cr, 2, 'both partners crowned');
        assert.equal(teamOf(r, 'T1').cr || 0, 0);
    } finally { restore(); }
});

test('duos: the team with the most points wins; both partners are champions; podium rows show crown points', () => {
    const { a, b, c, d, e, restore } = duoContest();
    let next = null;
    try {
        // the best single tank (b, 8,000) is on the losing team: 8,000 + 100
        // against c + d's 6,000 + 3,000 (+ crowns), so team 2 wins
        setScore(a, 100); setScore(b, 8000); setScore(c, 6000); setScore(d, 3000); setScore(e, 500);
        royale.debugRaidLeft(40);
        tick();
        for (const x of [a, b, c, d]) royale._statOf(x).since = Date.now() - 120000;
        next = endRaidNow(() => { royale.debugEndRaid(); tick(50); });
        const res = royale._results();
        assert.equal(res.duos, 1);
        assert.equal(res.crowns, 1);
        const top = res.top[0];
        assert.deepEqual([...top.ids].sort(), [c.id, d.id].sort(), 'team 2 on top');
        assert.ok(top.score > res.top[1].score);
        assert.equal(top.score, scoreOf(c) + scoreOf(d));
        assert.ok(top.cb >= crowns.BELL_BONUS, 'the podium row shows the team crown points: ' + top.cb);
        assert.equal(JSON.stringify(res).includes('_ks'), false);
        assert.equal(res.champ.name, top.name);
        assert.ok(/ & /.test(res.champ.name), res.champ.name);
        assert.deepEqual([...res.win].sort(), [c.id, d.id].sort(), 'the victory lap is the team\'s');
        for (const x of [c, d]) {
            assert.equal(royale._statOf(x).champWin, true, x.name + ' champion');
            assert.ok(x.socket._champUntil > Date.now() + 23 * 3600 * 1000);
            assert.equal(x.socket._crownStreak, 1);
        }
        for (const x of [a, b]) assert.ok(!royale._statOf(x).champWin, x.name + ' not champion');
        // ranked reads the team placement (teamScore), so both partners take place 1
        const order = royale.boardOrder ? royale.boardOrder() : null;
        if (order) for (const x of [c, d]) assert.equal(order.find(o => o.s === royale._statOf(x)).place, 1);
        // crown achievements have no duo gate (crown_ko, crown_steal, crown_win)
        const ach = fs.readFileSync(path.join(SERVER, 'accounts', 'game', 'achHooks.js'), 'utf8');
        assert.ok(!/royale_duos/.test(ach));
        // the client's duo standings show the crowns
        const app = fs.readFileSync(path.join(CLIENT, 'app.js'), 'utf8');
        assert.match(app, /crowns\.drawTeamEdge\(c, x, y0, W, H\)/);
        assert.match(app, /Math\.min\(2, t\.cr \| 0\)/);
    } finally { restore(); }
    if (next) next();
});

test('stability: a crowns failure never blocks the raid end', () => {
    const { a, b } = contest();
    for (const x of [a, b]) royale._statOf(x).since = Date.now() - 120000;
    const fin = crowns.finish, snap = crowns.crownKeys;
    crowns.finish = () => { throw new Error('boom'); };
    const err = console.error, warn = console.warn;
    console.error = () => {}; console.warn = () => {};
    let next = null;
    try {
        next = endRaidNow(() => { royale.debugEndRaid(); tick(50); });
        assert.ok(royale._results(), 'still ended');
        assert.ok(royale._results().top.length >= 2);
    } finally { crowns.finish = fin; crowns.crownKeys = snap; console.error = err; console.warn = warn; }
    if (next) next();
});

test('bots: a bot kill pays 30% of a human kill, streak bonus too', () => {
    freshRaid();
    const k = human(0, 0), v = human(400, 0);
    const bots = [bot(800, 0), bot(900, 0), bot(1000, 0), bot(1100, 0), bot(1200, 0), bot(1300, 0)];
    royale.boardSnapshot();
    assert.equal(crowns.BOT_KILL_SHARE, 0.3);
    const s0 = scoreOf(k);
    die(bots[0], k);
    const bk = scoreOf(k) - s0;
    const s1 = scoreOf(k);
    die(v, k);
    const hk = scoreOf(k) - s1;
    assert.ok(hk >= 200 * 0.5, 'a human kill: ' + hk);
    assert.equal(bk, Math.round(hk * 0.3), 'a bot pays 30%: ' + bk + ' vs ' + hk);
    // kills 3..5: past the streak mark of 4 the bonus is shared too
    let s = scoreOf(k);
    die(bots[1], k); die(bots[2], k);
    assert.equal(scoreOf(k) - s, 2 * bk, 'kills 3 and 4');
    s = scoreOf(k);
    die(bots[3], k);
    assert.equal(scoreOf(k) - s, bk + 15, 'kill 5: a bot kill + 30% of the 50 streak bonus');
    // the ranked basis books what the board paid
    assert.equal(royale._statOf(k).killPts, bk * 4 + hk);
    // gem drops are untouched: the code that drops them is not in dig_royale
    const src = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.ok(/The gems it drops are untouched/.test(src));
});

// ── the client ──────────────────────────────────────────────────────────
test('client: tracker, note and the raid end words', async () => {
    const L = await import(pathToFileURL(path.join(CLIENT, 'crownsLogic.js')).href);
    const c = { on: 1, sd: 0, fz: 450, list: [{ e: 1, n: 'Ann', s: 5000, x: 900, y: 0, f: 1 }, { e: 2, n: 'Bot', s: 4000, b: 1, x: 0, y: 1800, f: 1 }, { e: 3, n: 'Cy', s: 3000, x: -450, y: 0, f: 1 }] };
    const fd = (d) => Math.round(d) + "";
    const t = L.tracker(c, 9, 0, 0, fd);
    assert.deepEqual(t.rows.map(r => [r.crown, r.name, r.score]), [[1, 'Ann', 5000], [2, 'Bot', 4000], [3, 'Cy', 3000]]);
    assert.equal(t.footer, 'Nearest crown: about 450 away');
    assert.equal(t.footer2, 'Kill the holder to steal it');
    assert.equal(L.tracker(c, 1, 0, 0, fd).footer, 'Your crown: +5 pts/sec');
    assert.equal(L.tracker(Object.assign({}, c, { sd: 1, pps: 10 }), 1, 0, 0, fd).footer, "Your crown: +10 pts/sec, the vault won't hide you");
    // with the board: the points race, crowns marked, you included
    const board = [
        { id: 7, name: 'Rich', score: 9000, place: 1 }, { id: 1, name: 'Ann', score: 5000, place: 2, cr: 1 },
        { id: 2, name: 'Bot', score: 4000, place: 3, cr: 1, bot: 1 }, { id: 8, name: 'Dee', score: 3500, place: 4 },
        { id: 3, name: 'Cy', score: 3000, place: 5, cr: 1 }, { id: 9, name: 'Me', score: 100, place: 9 },
    ];
    const tb = L.tracker(c, 9, 0, 0, fd, board);
    assert.deepEqual(tb.rows.map(r => [r.k, r.name, r.crown, r.me]), [[1, 'Rich', 0, false], [2, 'Ann', 1, false], [3, 'Bot', 2, false], [5, 'Cy', 3, false], [9, 'Me', 0, true]]);
    assert.deepEqual(L.note(c, 9, 0, 0, fd, 0), { text: 'Kill a crown holder to steal points', sub: '~450', hot: false }, 'a first raid: simple');
    assert.equal(L.note(c, 1, 0, 0, fd, 0).text, 'Your crown: +5 pts/sec');
    assert.deepEqual(L.note(Object.assign({}, c, { list: [Object.assign({}, c.list[0], { p: 1240 })] }), 1, 0, 0, fd), { text: 'CROWN +5 PTS/SEC', sub: '+1,240 so far', hot: true });
    assert.equal(L.note(null, 1, 0, 0, fd), null);
    const res = { crowns: 1, champ: { id: 7, name: 'Rich', score: 9675 } };
    assert.deepEqual(L.finale(res, 1, true, 'Me', 8), { title: 'CORE CHAMPION', sub: 'Most points (9,675), #1 of 8', col: 'gold' });
    assert.deepEqual(L.finale(res, 2, false, 'Rich', 8), { title: '#2', sub: 'Rich won with 9,675 pts', rest: ' won with 9,675 pts', col: 'silver' });
    assert.equal(L.finale(res, 3, false, 'Rich', 8).col, 'bronze');
    const other = L.finale(res, 7, false, 'Rich', 8);
    assert.equal(other.title, 'RICH');
    assert.equal(other.sub, 'is the Core Champion with 9,675 pts');
    assert.equal(L.finale({}, 1, true, 'Me', 8), null, 'a raid without crowns keeps VICTORY');
    assert.equal(L.crownLine({ cb: 1240 }), '+1,240 from crowns');
    assert.equal(L.crownLine({ cb: -300 }), '');
    assert.equal(L.crownLine({}), '');
    // the end screen shows the crown line and every title says the points
    const fin = fs.readFileSync(path.join(CLIENT, 'raidFinale.js'), 'utf8');
    assert.ok(/CL\.crownLine\(row\)/.test(fin) && /cw\.rest/.test(fin));
    assert.deepEqual(L.feed({ crown: 1, took: 1, by: 'X', name: 'Y', pts: 300 }), { verb: 'took', by: 'X', name: 'Y', pts: 300 });
    // wired up: the socket feeds it, the app draws it, the build keeps it hot
    const sock = fs.readFileSync(path.join(CLIENT, 'socketinit.js'), 'utf8');
    assert.ok(/crowns\.onRY\(r\)/.test(sock) && /crowns\.onKC\(m\)/.test(sock));
    const app = fs.readFileSync(path.join(CLIENT, 'app.js'), 'utf8');
    assert.ok(/crowns\.drawTracker/.test(app) && /crowns\.drawOverhead/.test(app) && /crowns\.drawMap/.test(app));
    assert.ok(!/Nobody respawns now\."\s*,\s*HUD\.lilac/.test(app.replace(/st\.fin \? "Last [^:]+:/, '')), 'the mid-raid lock line is retuned');
    const build = fs.readFileSync(path.join(REPO, 'scripts', 'build-client.js'), 'utf8');
    assert.ok(/"client\/crowns\.js"/.test(build) && /"client\/crownsLogic\.js"/.test(build));
});

test('flag: ROYALE_CROWNS=0 turns it all off', () => {
    const out = execFileSync(process.execPath, ['-e', `
        global.Config = { dig_royale: true };
        const c = require(${JSON.stringify(path.join(SERVER, 'game', 'terrain', 'crowns.js'))});
        console.log(JSON.stringify({ on: c.enabled(), share: c.botKillShare() }));
    `], { env: Object.assign({}, process.env, { ROYALE_CROWNS: '0' }) }).toString().trim();
    assert.deepEqual(JSON.parse(out), { on: false, share: 1 });
});

// ── accounts (last: the database opens here) ────────────────────────────
test('accounts: a Core Champion gets the win and the streak; nobody else in that raid does', () => {
    const accounts = require(path.join(SERVER, 'accounts'));
    const rankStore = require(path.join(SERVER, 'accounts', 'rankStore'));
    const streaks = require(path.join(SERVER, 'accounts', 'streaks'));
    const announce = require(path.join(SERVER, 'accounts', 'discord', 'announce'));
    const quiet = console.log;
    console.log = (...a) => { if (!String(a[0]).startsWith('[accounts]')) quiet(...a); };
    try { assert.equal(accounts.initMain(), true, 'initMain'); } finally { console.log = quiet; }
    const mk = (n) => { const r = accounts.users.create({ username: (n + '_' + (++seq)).slice(0, 16), recoveryHash: null }); assert.ok(r.ok, JSON.stringify(r)); return r.user; };
    const stat = (id) => accounts.db.handle().get('SELECT raid_wins, top3 FROM user_stats WHERE user_id = ?', id) || {};
    const champ = mk('champ'), rich = mk('rich');
    // a late joiner (2 min in the raid) who stole the crown still wins it
    const r1 = rankStore.applyRaidPlacement({ raidKey: 'c:1', userId: champ.id, place: 1, rows: 8, score: 4200, raidMs: 120000, played: false, active: true, contest: true, champ: true });
    assert.equal(r1.champ, true);
    assert.equal(stat(champ.id).raid_wins, 1);
    assert.equal(r1.streak && r1.streak.streak, 1, 'win streak 1');
    // anyone else in the same raid (placed 4th) does not
    rankStore.applyRaidPlacement({ raidKey: 'c:1', userId: rich.id, place: 4, rows: 8, score: 20000, raidMs: 15 * 60000, played: true, active: true, contest: true, champ: false });
    assert.equal(stat(rich.id).raid_wins | 0, 0);
    // a second win: streak 2; a played raid without one resets it
    const r2 = rankStore.applyRaidPlacement({ raidKey: 'c:2', userId: champ.id, place: 1, rows: 8, score: 3000, raidMs: 15 * 60000, played: true, active: true, contest: true, champ: true });
    assert.equal(r2.streak.streak, 2);
    assert.equal(stat(champ.id).raid_wins, 2);
    assert.equal(streaks.view(champ.id).win.current, 2);
    rankStore.applyRaidPlacement({ raidKey: 'c:3', userId: champ.id, place: 5, rows: 8, score: 900, raidMs: 15 * 60000, played: true, active: true, contest: true, champ: false });
    assert.equal(streaks.view(champ.id).win.current, 0, 'a non-win resets it');
    // the 24 h crown by the name
    assert.ok(rankStore.championUntil(champ.id) > Date.now() + 23 * 3600 * 1000);
    assert.equal(rankStore.championUntil(rich.id), 0);
    // old raids (no contest) keep the old rule
    const old = mk('old');
    rankStore.applyRaidPlacement({ raidKey: 'o:1', userId: old.id, place: 1, rows: 6, score: 900, raidMs: 6 * 60000, played: true });
    assert.equal(stat(old.id).raid_wins, 1);
    // Discord: the champion's line leads
    const txt = announce.raidTopText({ raidNo: 7, top: [{ userId: champ.id, place: 1, score: 4200 }], champ: { userId: champ.id, score: 4200 } });
    assert.ok(txt.startsWith('👑 **' + champ.username.replace(/_/g, '\\_') + '** won Raid #7 with 4,200 points!'), txt);
    // the profile carries it
    const profile = require(path.join(SERVER, 'accounts', 'routes', 'profile'));
    const p = profile.profileOf ? profile.profileOf(accounts.users.byId(champ.id), champ.id) : null;
    if (p) assert.ok(p.champUntil > Date.now() && p.winStreak === 0);
    accounts.shutdown();
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); log('ok   ' + t.name); }
        catch (e) { failed++; log('FAIL ' + t.name + '\n     ' + ((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')); }
    }
    log(`\n${tests.length - failed}/${tests.length} passed`);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
    process.exit(failed ? 1 : 0);
})();
