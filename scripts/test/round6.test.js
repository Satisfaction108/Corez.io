// Blind playtest round 5 fixes: node scripts/test/round6.test.js
//
//   kills       every kill is a moment: ELIMINATED, then DOUBLE KO, TRIPLE
//               KO... chained in place under one slam key, a bigger word
//               for shutdown / revenge / bounty / giant, a kill pop over
//               your own tank ("KO  kai", "+60 pts"); the toast names the
//               player, never their tank class
//   crowns      the risk a crown is told is the steal worked out the same
//               way (stealOf, live on the crown card); the death card's
//               lost line is the steal; the crowns tile is never negative
//               (earned, with the steal in its label)
//   points      kills are booked at their price (Bounty Week can't re-price
//               old kills while you're dead); every points change has a
//               labelled pop (server KC 'ptspop' + client ptsOnScore)
//   respawn     Enter / click during the storm lock or the death wait
//               queues the drop; it fires the moment it's allowed
//   deposit     "Banking 418 / 718: stay on the pad"; cut short, what
//               banked and what you still carry
//   death card  the first raids' card has the Points line too
//   results     the next raid waits 21 s (was 15), the finale's END_MS
//               follows
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');
const ssrc = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');
const imp = (f) => import(pathToFileURL(path.join(CLIENT, f)).href);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-round6-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ROYALE_CROWNS', 'ROYALE_PERKS', 'ROYALE_END_WAIT_MS', 'DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'ACCOUNTS_ALLOW_DEBUG']) delete process.env[k];
// round 11's early streak bonus would add to the second kill below (round11.test.js covers it)
process.env.ROYALE_STREAK_PTS = '0';
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
const raidMods = T('raidMods.js');
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
const test = (name, fn) => tests.push({ name, fn });

let seq = 0;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'r6' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
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
let clock = Date.now();
Date.now = () => clock;
const tick = (ms = 300) => { clock += ms; royale.tick(); };
const scoreOf = (b) => royale.scoreOf(royale._statOf(b));
const kcs = (b, kind) => b.socket.packets.filter(p => p[0] === 'KC' && (!kind || p[1] === kind));
function lastRY(sock) {
    for (let i = sock.packets.length - 1; i >= 0; i--) if (sock.packets[i][0] === 'RY') return JSON.parse(sock.packets[i][1]);
    return null;
}
function die(victim, killer) {
    victim.finalKillers = killer ? [killer] : [];
    if (victim.socket) victim.socket.gemDeathCarried = 0;
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

// ── 1. kills ─────────────────────────────────────────────────────────────
test('kills: ELIMINATED, DOUBLE KO, TRIPLE KO... and the big words', async () => {
    const J = await imp('juiceMath.js');
    assert.deepEqual([1, 2, 3, 4, 5, 7].map(J.multiKillWord), ['ELIMINATED', 'DOUBLE KO', 'TRIPLE KO', 'QUAD KO', 'RAMPAGE x5', 'RAMPAGE x7']);
    assert.equal(J.bigKillWord('shutdown', 'SHUTDOWN: kai'), 'SHUTDOWN');
    assert.equal(J.bigKillWord('revenge', 'REVENGE: kai'), 'REVENGE');
    assert.equal(J.bigKillWord('huntkill', 'HUNTED DOWN: kai'), 'HUNTED DOWN');
    assert.equal(J.bigKillWord('kill', 'GIANT DOWN: kai'), 'GIANT DOWN');
    assert.equal(J.bigKillWord('kill', 'ELIMINATED: kai'), '');
    assert.equal(J.killWho('ELIMINATED: mega_blaze  (420 gems dropped)'), 'mega_blaze');
    assert.deepEqual(J.killPop('ELIMINATED: mega_blaze  (420 gems dropped)', 60, (n) => String(n)), { head: 'KO  mega_blaze', pts: '+60 pts' });
    assert.deepEqual(J.killPop('ELIMINATED: kai', 0), { head: 'KO  kai', pts: '' });
});

test('kills: a chain replaces itself in place in the slam lane (one key), never queues up', async () => {
    const TD = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-round6-juice-'));
    for (const f of ['juice.js', 'juiceMath.js']) fs.copyFileSync(path.join(CLIENT, f), path.join(TD, f));
    fs.writeFileSync(path.join(TD, 'global.js'), 'export const global = {};\n');
    fs.writeFileSync(path.join(TD, 'config.js'), 'export const config = { graphical: {} };\n');
    fs.writeFileSync(path.join(TD, 'package.json'), '{"type":"module"}\n');
    globalThis.window = globalThis.window || {};
    let now = 1000;
    const realNow = performance.now.bind(performance);
    performance.now = () => now;
    try {
        const J = await import(pathToFileURL(path.join(TD, 'juice.js')).href);
        const M = await import(pathToFileURL(path.join(TD, 'juiceMath.js')).href);
        J.init({ hudTitle: () => {}, drawText: () => {} });
        const frame = () => J.drawSlams({}, 0, 0, 1);
        J.slam('STORM CLOSING', '', null, 2600);
        frame();
        J.slamFirst('ELIMINATED', 'You knocked out kai', '#fff', 2600, 64, M.KILL_SLAM_KEY);
        for (let t = 0; t < 500; t += 50) { now += 50; frame(); }
        assert.equal(J.slamState().up, 'ELIMINATED', 'your kill jumps the storm banner');
        J.slamFirst('DOUBLE KO', 'You knocked out mason', '#ffd76e', 2600, 72, M.KILL_SLAM_KEY);
        frame();
        assert.equal(J.slamState().up, 'DOUBLE KO', 'the chain counts up in place');
        assert.ok(!J.slamState().wait.includes('ELIMINATED') && !J.slamState().wait.includes('DOUBLE KO'), JSON.stringify(J.slamState()));
        J.slamFirst('TRIPLE KO', 'You knocked out ivy', '#ff7a6b', 2600, 72, M.KILL_SLAM_KEY);
        frame();
        assert.equal(J.slamState().up, 'TRIPLE KO');
        // and it stays up its full time when nothing else waits
        const t0 = now;
        while (J.slamState().up === 'TRIPLE KO' && now - t0 < 4000) { now += 50; frame(); }
        assert.ok(now - t0 >= 2500, 'up ' + (now - t0) + ' ms');
    } finally {
        performance.now = realNow;
        fs.rmSync(TD, { recursive: true, force: true });
    }
});

test('kills: raidHeat slams all four kill kinds, pops them over your tank, plays the sound', () => {
    const rh = src('raidHeat.js');
    assert.match(rh, /case "kill": case "shutdown": case "revenge": case "huntkill": \{/);
    assert.match(rh, /juice\.slamFirst\(head, line, col, big \? 3000 : 2600, big \? 78 : S\.combo >= 2 \? 72 : 64, JM\.KILL_SLAM_KEY\)/);
    assert.match(rh, /addKillPop\(text, pts, !!big \|\| S\.combo >= 2, now\);\n\s+killSound\(\);/);
    assert.match(rh, /drawKillPops\(c, ratio, now\);/);
    // a fixed pool, strings made once per kill
    assert.match(rh, /const killPops = mk\(3, /);
    const j = src('juice.js');
    assert.match(j, /export function slam\(text, sub, col, dur = 1800, size = 58, key0\) \{\n\s+const now = performance\.now\(\);\n\s+const key = key0 \|\| slamKey\(text\);/);
    // the toast names the player, never their class
    const ent = ssrc('game/entities/entity.js');
    assert.match(ent, /if \(royaleTank\) instance\.sendMessage\("You knocked out " \+ \(this\.master\.name \|\| "an unnamed tank"\)/);
});

// ── 2. crowns ────────────────────────────────────────────────────────────
test('crowns: the risk on the crown card is the steal, the death card says the same number', () => {
    freshRaid();
    const a = human(0, 0), b = human(300, 0), c = human(600, 0), d = human(900, 0);
    const e = bot(1200, 0);
    for (const x of [a, b, c, d, e]) x.carriedGems = 0;
    royale.boardSnapshot();
    royale.debugSetScore(a, 900); royale.debugSetScore(b, 1000); royale.debugSetScore(c, 3000); royale.debugSetScore(d, 2000); royale.debugSetScore(e, 4000);
    tick();
    royale.debugRaidLeft(300);
    tick();
    assert.equal(!!b.crowned, false);
    assert.equal(!!d.crowned, true, 'd is top 3');
    // the slam's risk says "now" and that it grows
    const got = kcs(d, 'crowned').pop();
    assert.match(got[4], /If they get you now, you lose [\d,]+ pts, and that grows as you earn\. Your banked gems are safe\./);
    // 90 s of crown points later the steal has grown: the card keeps up
    for (let i = 0; i < 300; i++) tick(300);
    tick(600);
    const r = lastRY(d.socket);
    const lose = r.you.crown.lose;
    assert.equal(lose, crowns.stealOf(d), 'the card is stealOf, live');
    const first = +String(got[4]).match(/lose ([\d,]+) pts/)[1].replace(/,/g, '');
    assert.ok(lose > first, 'grew from ' + first + ' to ' + lose);
    // no time passes: the death takes exactly what the card said
    const d0 = scoreOf(d);
    die(d, a);
    const st = royale._statOf(d);
    assert.equal(st.lastDeath.p, lose, 'the lost line is the steal');
    assert.equal(d0 - scoreOf(d), lose);
    assert.equal(st.crownLost, lose);
    // the RY parts: c is the net, s what was stolen; tiles never negative
    tick(600);
    const r2 = lastRY(d.socket);
    assert.equal(r2.you.pts.s, lose);
    assert.equal(r2.you.score, r2.you.pts.b + r2.you.pts.k + r2.you.pts.c);
    // the victim's points pop: the steal, with who
    const pp = kcs(d, 'ptspop').pop();
    assert.equal(pp[3], -lose);
    assert.equal(pp[2], a.name + ' took your crown');
    // the thief's: the steal, with whose
    assert.ok(kcs(a, 'ptspop').some(p => p[3] === lose && p[2] === "took " + d.name + "'s crown"));
});

test('crowns: the tile shows crowns earned, the steal in its label, never a negative number', async () => {
    const SL = await imp('scoreLogic.js');
    // playtest 5: net -79 (241 earned, 320 stolen)
    const you = { score: 3121, pts: { b: 2355, k: 845, c: -79, s: 320 }, dl: { p: 320, by: 'gemme41', cr: 1 } };
    const t = SL.tiles(you);
    assert.deepEqual(t[2], ['CROWNS · 320 STOLEN', '241', 'crown']);
    assert.equal(SL.parts(you).total, 3121, 'the parts still add up');
    assert.equal(SL.deathLine(you, 585).lost, 'lost 320: gemme41 took your crown');
    assert.deepEqual(SL.tiles({ pts: { b: 10, k: 0, c: 50 } })[2], ['CROWNS', '50', 'crown']);
    for (const c of [-79, -1, 0, 5]) assert.ok(!/^-/.test(SL.tiles({ pts: { b: 0, k: 0, c, s: 0 } })[2][1]));
});

// ── 3. points ────────────────────────────────────────────────────────────
test('points: kills are booked at their price; Bounty Week never re-prices them; each kill is labelled', () => {
    freshRaid();
    const a = human(0, 0), b = human(400, 0), c = human(800, 0);
    tick();
    const s0 = scoreOf(a);
    die(b, a);
    const one = scoreOf(a) - s0;
    assert.ok(one > 0);
    const pp = kcs(a, 'ptspop').pop();
    assert.equal(pp[2], 'KO ' + b.name);
    assert.equal(pp[3], one, 'the label carries the kill points');
    raidMods.roll('bounty_week');
    try {
        assert.equal(raidMods.num('killScoreMult', 1), 2);
        tick();
        assert.equal(scoreOf(a) - s0, one, 'the old kill keeps its price (it used to double while you were dead)');
        die(c, a);
        assert.equal(scoreOf(a) - s0, one + 2 * one, 'a new kill is worth double');
    } finally {
        raidMods.roll(raidMods.MODS.find(m => m.id !== 'bounty_week' && m.killScoreMult == null).id);
    }
    const dr = ssrc('game/gamemodes/scripts/dig_royale.js');
    assert.match(dr, /if \(s\.killPts != null\) kp = s\.killPts \| 0;/);
    // the other award paths say why too
    for (const re of [/notePts\(killer, kind\.score, kind\.name \+ " down"\)/, /"helped down " \+ kind\.name/, /chest\.chestRare \? "epic chest" : "chest"/, /"shop buy"/, /notePts\(body, n, "crown at the bell"\)/]) assert.match(dr, re);
    assert.match(ssrc('game/terrain/crowns.js'), /award\(h\.body, BELL_BONUS, 'bell'\)/);
});

test('points pops: labels first, banked, crown holding quiet, never a silent jump', async () => {
    const SL = await imp('scoreLogic.js');
    const st = SL.ptsPops();
    const you = (b, k, c, crown) => ({ score: b + k + c, pts: { b, k, c }, crown: crown ? { pps: 5 } : undefined });
    assert.equal(SL.ptsOnScore(st, you(100, 0, 0), 0, 7), null, 'the first RY only records');
    SL.ptsLabel(st, 60, 'KO kai', 10);
    assert.equal(SL.ptsOnScore(st, you(100, 60, 0), 20, 7).str, '+60 pts · KO kai');
    // a deposit's steps add up in one pop
    SL.ptsOnScore(st, you(250, 60, 0), 500, 7);
    assert.equal(SL.ptsOnScore(st, you(400, 60, 0), 1000, 7).str, '+300 pts · banked');
    // holding a crown: quiet (the crown card says +5/s)
    assert.equal(SL.ptsOnScore(st, you(400, 60, 5, true), 1500, 7), null);
    // an unlabelled rise still pops
    assert.equal(SL.ptsOnScore(st, you(400, 420, 5), 5000, 7).str, '+360 pts');
    // a steal, labelled, negative
    SL.ptsLabel(st, -320, 'gemme41 took your crown', 5100);
    assert.equal(SL.ptsOnScore(st, you(400, 420, -315), 5200, 7).str, '-320 pts · gemme41 took your crown');
    // a late label names the plain pop already up
    SL.ptsOnScore(st, you(400, 520, -315), 6000, 7);
    SL.ptsLabel(st, 100, 'epic chest', 6100);
    assert.equal(st.pops[st.pops.length - 1].str, '+100 pts · epic chest');
    // a new raid starts from 0 without a "-N" pop
    assert.equal(SL.ptsOnScore(st, you(0, 0, 0), 7000, 8), null);
    assert.equal(st.pops.length, 0);
    assert.equal(SL.ptsLive(st, 7000).length, 0);
    // wired: the KC label, the RY change, drawn by the points and over the death card
    const si = src('socketinit.js');
    assert.match(si, /if \(m\[0\] === "ptspop"\) \{\n\s+try \{ scoreText\.ptsLabel\(/);
    assert.match(si, /scoreText\.ptsOnScore\(global\.ptsPops \|\| \(global\.ptsPops = scoreText\.ptsPops\(\)\), r\.you, performance\.now\(\), /);
    const app = src('app.js');
    assert.match(app, /if \(placeTxt && !global\.died\) drawPtsPops\(px \+ PW \+ 10, py \+ rowH \+ footH \/ 2, "left", 1\);/);
    assert.equal((app.match(/drawPtsPops\(px \+ W - 16, Math\.max\(14, py - 16\), "right", -1\);/g) || []).length, 2, 'both death cards');
});

// ── 4. respawn ───────────────────────────────────────────────────────────
test('respawn: Enter or a click during the storm lock queues the drop, it fires when allowed', () => {
    const cv = src('canvas.js');
    assert.match(cv, /if \(locked \|\| waiting\) \{\n\s+if \(global\.died && !global\.respawnPending && !global\.tutorialMode\) global\.respawnQueued = true;\n\s+return;\n\s+\}/);
    const app = src('app.js');
    assert.match(app, /if \(global\.died\) \{\n\s+flushQueuedRespawn\(\);\n\s+gameDrawDead\(\);/, 'every frame while dead');
    assert.match(app, /function flushQueuedRespawn\(\) \{/, 'a hoisted function, no TDZ');
    // (round 7: shorter, so it fits the button)
    assert.match(app, /"Storm resetting: you drop in \("/);
    assert.match(app, /const off = !st\.ready && !\(st\.queue && !st\.queued\)( && !st\.ended)?;/, 'the waiting button still takes the click');
    assert.match(src('socketinit.js'), /global\.respawnPending = false;\n\s+global\.respawnQueued = false;/, 'the drop clears it');
    assert.match(src('global.js'), /respawnQueued: false,/);
});

// ── 5. deposit ───────────────────────────────────────────────────────────
test('deposit: progress while it runs; cut short, what banked and what is still carried', async () => {
    const SL = await imp('scoreLogic.js');
    assert.deepEqual(SL.depositNote({ total: 718, remaining: 300 }, 300, 0), { text: 'Banking 418 / 718: stay on the pad', hot: false });
    const cut = { total: 0, remaining: 0, cutAt: 1000, cutBanked: 418, cutTotal: 718 };
    assert.deepEqual(SL.depositNote(cut, 300, 2000), { text: 'Deposit stopped: banked 418 of 718. You still have 300 on you, so get back on the pad', hot: true });
    assert.equal(SL.depositNote(cut, 300, 1000 + SL.DEP_CUT_MS + 1), null);
    assert.equal(SL.depositNote({ total: 0, remaining: 0 }, 0, 0), null);
    const si = src('socketinit.js');
    assert.match(si, /if \(wasActive && v\.remaining > 0 && !\(m\[0\] \| 0\) && !\(m\[1\] \| 0\)\) \{/);
    assert.match(src('app.js'), /push\(hudNote\(0, "deposit", dn\.text, dn\.hot \? "#ff9a5c" : HUD\.gold\)\)/);
});

// ── 6. death card ────────────────────────────────────────────────────────
test('death card: the first raids card has the Points line too', () => {
    const app = src('app.js');
    const a = app.indexOf('const gameDrawDeadNewcomer = (A) => {'), b = app.indexOf('const gameDrawDeadRoyale = () => {');
    const nc = app.slice(a, b);
    assert.match(nc, /const dln = scoreText\.deathLine\(you, global\.finalCarried \| 0, 0, global\.finalNxKept \| 0\);/);
    assert.match(nc, /fitLine\(dln\.head \+ " \(" \+ dln\.lost \+ "\)", 14, 9\.5, iw\)/);
});

// ── 7. results ───────────────────────────────────────────────────────────
test('results: the next raid waits 27 s (round 11), the finale stays up past it', () => {
    const dr = ssrc('game/gamemodes/scripts/dig_royale.js');
    assert.match(dr, /const RAID_END_WAIT_MS = Math\.max\(5000, \+process\.env\.ROYALE_END_WAIT_MS \|\| 27_000\);/);
    const end = +src('raidFinale.js').match(/const END_MS = (\d+);/)[1];
    assert.ok(end > 1600 + 27000, 'END_MS ' + end);
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
