// Raid points, one definition: node scripts/test/scoring.test.js
//
//   formula    POINTS = banked gems + kills & bonuses + crowns. Carried gems
//              are not points (dying drops them); growth still counts half
//              the satchel so a miner grows while carrying
//   safe       no death takes banked points: a plain death costs 0 points, a
//              crowned banker's crown goes but the bank stays, a steal only
//              takes from kills & bonuses + crowns, at most STEAL_CAP
//   playtest   round 3 replayed: a 9,455 banker who wears a crown it never
//              noticed and dies four times keeps every banked point and
//              stays in contention
//   everywhere the board row, RY you.score, you.pts (b+k+c), the death card
//              line (you.dl) and the raid results all read the same number;
//              the save code's points are the board points
//   client     scoreLogic words: the rule, the death card line, the carry
//              warning, the crown card; the recap before FRESH START when
//              the podium was missed; the wiring in app/crowns/finale/firstSeconds
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-scoring-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ROYALE_CROWNS', 'ROYALE_PERKS', 'DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ACCOUNTS_ALLOW_DEBUG']) delete process.env[k];
process.env.NODE_ENV = 'test';

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
    vaultSites: [{ x: 0, y: -3000, r: 95 }],
    shopSites: [{ id: 0, name: 'Shop', x: 3000, y: 0, r: 95 }],
    outpostSites: [], spawnPits: [],
};
vault.getVaults(); shop.getShops();
global.gameManager.terrainGrid = null;
storm.start();
royale.tick();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let seq = 0;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'sc' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    global.gameManager.socketManager.clients.push(s);
    return s;
}
function human(x = 0, y = 0, name, sockIn) {
    const sock = sockIn || mkSocket();
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (++seq);
    t.name = name || 'Hu' + seq;
    t.alwaysActive = true;
    t.msgs = [];
    t.sendMessage = (m) => t.msgs.push(m);
    const player = { socket: sock, body: t, target: { x: 120, y: 0 }, command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, autofire: false, autospin: false, override: false } };
    sock.player = player;
    t.socket = sock;
    level45(t);
    const pl = global.gameManager.socketManager.players;
    const old = pl.findIndex(p => p.socket === sock);
    if (old >= 0) pl.splice(old, 1);
    pl.push(player);
    royale.onHumanJoin(t);
    t.x = x; t.y = y; t.velocity.x = 0; t.velocity.y = 0;
    activity.noteCommand(sock, 100 + seq, 0, 0);
    return t;
}
let clock = Date.now();
Date.now = () => clock;
const tick = (ms = 300) => { clock += ms; royale.tick(); };
const stat = (b) => royale._statOf(b);
const scoreOf = (b) => royale.scoreOf(stat(b));
const kcs = (b, kind) => b.socket.packets.filter(p => p[0] === 'KC' && (!kind || p[1] === kind));
function lastRY(sock) {
    for (let i = sock.packets.length - 1; i >= 0; i--) if (sock.packets[i][0] === 'RY') return JSON.parse(sock.packets[i][1]);
    return null;
}
function ry(sock) { tick(600); return lastRY(sock); }
function die(victim, killer, cause) {
    victim.finalKillers = killer ? [killer] : [];
    if (cause) victim.deathCause = cause;
    if (victim.socket) victim.socket.gemDeathCarried = victim.carriedGems | 0;
    royale.onCombatantDead(victim);
    try { victim.kill(); } catch { /* */ }
    victim.health.amount = -1;
}
function freshRaid() {
    for (const p of global.gameManager.socketManager.players) if (p.body) { try { p.body.kill(); } catch { /* */ } p.body.health.amount = -1; }
    for (const b of handler.bots) { try { b.kill(); } catch { /* */ } b.health.amount = -1; }
    global.gameManager.socketManager.players.length = 0;
    global.gameManager.socketManager.clients.length = 0;
    handler.bots.length = 0;
    royale.debugEndRaid();
    tick(6000);
}
// a stat with exactly these parts
function setParts(b, { banked = 0, extra = 0 } = {}) {
    const s = stat(b);
    s.banked = banked; s.extra = extra; s.kills = 0; s.botKills = 0; s.revengeBonus = 0; s.crownPts = 0; s.crownSwing = 0;
}

// ── the formula ─────────────────────────────────────────────────────────
test('formula: points = banked + kills & bonuses + crowns; carried gems are not points', () => {
    freshRaid();
    const a = human(0, 0), b = human(400, 0);
    setParts(a, { banked: 1000, extra: 300 });
    stat(a).crownPts = 50; stat(a).crownSwing = -20;
    a.carriedGems = 3000;
    tick(50);                       // the stat reads the satchel
    assert.equal(stat(a).carried, 3000);
    assert.deepEqual(royale.scoreParts(stat(a)), { bank: 1000, kills: 300, crown: 30 });
    assert.equal(scoreOf(a), 1330, 'the satchel adds nothing');
    const r = ry(a.socket);
    assert.equal(r.you.score, 1330);
    assert.equal(r.youScore, 1330);
    assert.deepEqual(r.you.pts, { b: 1000, k: 300, c: 30 });
    const row = r.board.find(x => x.id === a.id);
    assert.equal(row.score, 1330, 'the board row is the same number');
    // growth still counts half the satchel (a miner grows while carrying)
    assert.equal(royale.debugGrowth(a).score, 1330 + 1500);
    // a kill: 200 to the killer, nothing off the victim
    const b0 = scoreOf(b), a0 = scoreOf(a);
    die(a, b);
    assert.ok(scoreOf(b) - b0 >= 200, 'the kill (and any bounty) to the killer: ' + (scoreOf(b) - b0));
    assert.equal(scoreOf(a), a0, 'a plain death costs no points');
    const d = ry(a.socket).you.dl;
    assert.deepEqual(d, { p: 0, c: 3000 }, 'the death card: 0 points lost, 3,000 carried dropped');
});

// ── round 3, replayed ───────────────────────────────────────────────────
test('playtest: a 9,455 banker with a crown dies four times and keeps every banked point', () => {
    freshRaid();
    let ender = human(0, 0, 'ender');
    const killers = ['kai', 'tiny', 'eli', 'haul'].map((n, i) => human(300 + i * 200, 0, n));
    setParts(ender, { banked: 9455, extra: 320 });
    killers.forEach((k, i) => setParts(k, { banked: 500 * i, extra: 200 }));
    royale.debugRaidLeft(300);
    tick();
    assert.ok(crowns._state().on, 'the contest is on');
    let lostTotal = 0;
    for (let i = 0; i < 4; i++) {
        // the crown is on ender (the top scorer) every time, the way it was
        if (!crowns.holderOf(ender)) {
            const st = crowns._state();
            const h = st.holders.find(x => x.body !== ender && !killers.slice(i).includes(x.body)) || st.holders[0];
            h.body.crowned = false; st.holders = st.holders.filter(x => x !== h);
            st.holders.push({ body: ender, key: royale._statOf(ender).key, since: clock, at: clock, acc: 0, paid: 0, id: ender.id });
            ender.crowned = true;
        }
        ender.carriedGems = 3074;
        const r0 = ry(ender.socket);
        assert.ok(r0.you.crown, 'RY: you wear a crown');
        const s0 = scoreOf(ender);
        die(ender, killers[i]);
        const lost = s0 - scoreOf(ender);
        lostTotal += lost;
        assert.ok(lost <= Math.max(0, s0 - 9455) * crowns.STEAL_FRAC + 10, 'a steal only reaches the unbanked part: lost ' + lost);
        assert.ok(scoreOf(ender) >= 9455, 'banked points never go: ' + scoreOf(ender));
        const dl = ry(ender.socket).you.dl;
        assert.equal(dl.p, lost, 'the card says what it cost');
        assert.equal(dl.c, 3074, 'and what dropped');
        // back in for the next round: a new tank on the same socket (same row)
        const sock = ender.socket;
        sock.status.deceased = true;
        ender = human(0, 0, 'ender', sock);
        assert.equal(stat(ender).banked, 9455, 'the same board row');
    }
    assert.ok(lostTotal < 500, 'four crowned deaths cost ' + lostTotal + ' (was ~6,500 in round 3)');
    const board = royale.boardSnapshot();
    assert.equal(board[0].id, ender.id, 'the banker is still #1');
});

test('save code: its points are the board points (no satchel half to strip)', () => {
    const src = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'saveCodes.js'), 'utf8');
    assert.ok(/pts: Math\.max\(0, score\),/.test(src));
    const dr = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.ok(/function restoredOf\(s\) \{\s*return \(s\.restoredPts \| 0\) \+ \(s\.restoredBanked \| 0\);/.test(dr));
    // ranked keeps its own basis (no crowns, carried half only at the bell)
    const rh = fs.readFileSync(path.join(SERVER, 'accounts', 'game', 'rankHooks.js'), 'utf8');
    assert.ok(/function basisOf\(s\) \{\s*return Math\.floor\(\+s\.banked \|\| 0\) \+ \(s\.killPts \| 0\)/.test(rh));
});

// ── the client ──────────────────────────────────────────────────────────
test('client: the words (rule, death card, carry warning, crown card)', async () => {
    const L = await import(pathToFileURL(path.join(CLIENT, 'scoreLogic.js')).href);
    assert.equal(L.RULE, 'Points = banked gems + kills & bonuses + crowns');
    assert.ok(/Banked gems are safe/.test(L.RULE_BODY) && /up to 30%/.test(L.RULE_BODY));
    // (earned / stolen: the crowns tile, round 6)
    assert.deepEqual(L.parts({ score: 6942, pts: { b: 6000, k: 900, c: 42 } }), { b: 6000, k: 900, c: 42, total: 6942, earned: 42, stolen: 0 });
    assert.deepEqual(L.parts({ score: 500, banked: 400 }), { b: 400, k: 100, c: 0, total: 500, earned: 0, stolen: 0 }, 'an old server');
    // the death card's line
    let d = L.deathLine({ pts: { b: 6000, k: 900, c: 42 }, dl: { p: 1500, by: 'kai', cr: 1, c: 3074 } }, 3074);
    assert.equal(d.head + ' (' + d.lost + ')', 'Points: 6,942 (lost 1,500: kai took your crown)');
    assert.equal(d.sub, 'You dropped 3,074 carried gems. They were not points yet: bank sooner.');
    assert.equal(d.hurt, true);
    d = L.deathLine({ pts: { b: 9455, k: 0, c: 0 }, dl: { p: 0, c: 0 } }, 0);
    assert.equal(d.head + ' (' + d.lost + ')', 'Points: 9,455 (lost 0: banked gems are safe)');
    assert.equal(d.sub, '');
    // never a negative crowns tile (playtest 5: "CROWNS -79"): what crowns
    // earned, the steal in the label (an old server's negative net too)
    assert.deepEqual(L.tiles({ pts: { b: 9455, k: 320, c: -20 } }).map(t => t[0] + ' ' + t[1]), ['BANKED THIS RAID 9,455', 'KILLS & BONUSES 320', 'CROWNS · 20 STOLEN 0']);
    // carrying: quiet when small or safe, loud when big or in danger
    assert.equal(L.carryNote({ carried: 400, near: 2 }), null);
    assert.equal(L.carryNote({ carried: 900 }), null, 'no danger, not huge');
    assert.deepEqual(L.carryNote({ carried: 3074, near: 1 }), { text: 'Carrying 3,074: bank it', sub: "Dying drops it, it's not points yet", hot: true });
    assert.deepEqual(L.carryNote({ carried: 2500 }), { text: 'Carrying 2,500: bank it', sub: 'Not points until banked', hot: false });
    assert.equal(L.carryNote({ carried: 3000, near: 1, noBank: true }), null, "a final-minute crown can't bank");
    assert.equal(L.carryNote({ carried: 3000, died: true }), null);
    // the crown card
    assert.deepEqual(L.crownCard({ pps: 5, lose: 1500 }), { title: 'YOU HAVE A CROWN', line1: '+5 pts/sec. Others will hunt you.', line2: 'If killed: -1,500 pts. Banked gems stay safe.' });
    // round 5: crowns bank in the final minute, the vault just won't hide them
    assert.equal(L.crownCard({ pps: 10, lose: 0, sd: 1 }).line1, "+10 pts/sec. Bank fast, the vault won't hide you.");
    assert.equal(L.crownCard(null), null);
});

test('client: the recap before FRESH START, and the last raid on the card', async () => {
    const F = await import(pathToFileURL(path.join(CLIENT, 'firstSecondsLogic.js')).href);
    const p = F.planFor({ newRaid: true, recap: true });
    assert.equal(p.recap, F.RECAP_MS);
    assert.equal(p.intro, F.NEW_RAID_PLAN.intro + F.RECAP_MS, 'FRESH START follows the recap');
    assert.equal(p.ability, F.NEW_RAID_PLAN.ability + F.RECAP_MS);
    assert.equal(F.planFor({ newRaid: true }).recap, undefined, 'no recap when the podium was seen');
    assert.deepEqual(F.cardPhase(p, 1000), { recap: true, a: 1 });
    assert.equal(F.cardPhase(p, F.RECAP_MS + 2000).recap, false);
    assert.ok(F.cardPhase(p, F.RECAP_MS + 2000).a > 0.99);
    const lines = F.recapLines({ place: 6, rows: 6, score: 3480, b: 3000, k: 400, c: 80, winner: 'kai', wScore: 12040, top: [{ name: 'kai', score: 12040 }, { name: 'eli', score: 8000 }, { name: 'jaxon', score: 7900 }] });
    assert.deepEqual(lines, {
        eyebrow: 'LAST RAID RESULTS', title: '#6 OF 6', goal: 'kai won with 12,040 pts. You finished with 3,480 pts.',
        controls: 'Your points: banked 3,000 + kills & bonuses 400 + crowns 80',
        status: '1. kai 12,040  ·  2. eli 8,000  ·  3. jaxon 7,900',
    });
    assert.equal(F.recapLines({ place: 1, rows: 6, score: 9000, winner: 'Me', wScore: 9000 }).title, 'YOU WON');
    const fresh = F.introLines({ newRaid: true, points: 50, last: { place: 6, rows: 6, score: 3480 } });
    assert.equal(fresh.eyebrow, 'LAST RAID: #6 OF 6 WITH 3,480 PTS');
    assert.equal(fresh.title, 'FRESH START');
    assert.equal(F.introLines({ newRaid: true }).eyebrow, 'NEW RAID');
});

test('client: wired everywhere', () => {
    const read = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');
    const app = read('app.js'), cr = read('crowns.js'), fin = read('raidFinale.js'), fs1 = read('firstSeconds.js');
    // the death card: the parts, then "Points: X (lost Y: why)"
    assert.ok(/const pt = scoreText\.tiles\(you\)/.test(app));
    assert.ok(/scoreText\.deathLine\(you, global\.finalCarried \| 0\)/.test(app));
    assert.ok(/dln\.head \+ " \(" \+ dln\.lost \+ "\)"/.test(app));
    assert.ok(!/CARRIED \(50% PTS\)/.test(app) && !/50% carried/.test(app), 'the half-points satchel is gone from the HUD');
    assert.ok(/drawText\("POINTS", scoreR/.test(app), 'the card calls it points, like the standings');
    // the rule on hover (standings, the clock plate's points) and in the F tab
    assert.ok(/queueTip\(scoreText\.RULE, scoreText\.RULE_BODY/.test(app));
    assert.ok((app.match(/pointsRuleTip\(/g) || []).length >= 4, 'standings, crown tracker, clock plate + the helper');
    assert.ok(/drawText\(scoreText\.RULE \+ "\. Banked gems are safe\."/.test(app));
    // the carry warning in the note stack
    assert.ok(/scoreText\.carryNote\(\{/.test(app) && /"carry", cn\.text/.test(app));
    // the crown: a moment however it arrives, then a card while you hold it
    assert.ok(/const mc = r\.you && r\.you\.crown && !global\.died/.test(cr));
    assert.ok(/const told = now - S\.slamAt <= 2500/.test(cr) && /if \(!told\)/.test(cr), 'a local slam only when the server one did not land');
    assert.ok(/const CARD = \{ pri: 0, key: "crowncard"/.test(cr) && /SL\.crownCard\(S\.mine\)/.test(cr));
    // the results: the cells add up, and a missed podium is recapped
    // round 5: "Banked this raid" everywhere it means points (the HUD's Bank is the spendable one)
    assert.ok(/const CELL_LABEL = \["POINTS", "BANKED THIS RAID", "KILLS \+ CROWNS"\]/.test(fin));
    assert.ok(/export const sawResults/.test(fin) && /S\.seenRaid = S\.raidId/.test(fin));
    assert.ok(/!raidFinale\.sawResults\(lr\.raidId\)/.test(fs1) && /L\.planFor\(\{ newRaid: true, recap: missed \}\)/.test(fs1));
    // the build keeps the new module on the light profile
    const build = fs.readFileSync(path.join(REPO, 'scripts', 'build-client.js'), 'utf8');
    assert.ok(/"client\/scoreLogic\.js"/.test(build));
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
