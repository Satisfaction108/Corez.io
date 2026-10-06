// Blind playtest round 3 fixes: node scripts/test/round4.test.js
//
//   tough     TOO STRONG is never your own tank (you can be the bounty), and
//             a grown / runaway / streaking tank you're level with or ahead
//             of on the board is not "way ahead of you"
//   tags      the overhead tag sits right on its tank's name; the +N gem
//             pops rise from above your own tag and crown
//   perks     a deliberate click on a perk card picks it at once; only a
//             press in the middle of click-firing has to rest first
//   card      the death card: slams wait (or go), plates wait, world labels
//             dim under it
//   respawn   one word on the button ("Respawn"), and Enter / Space work
//             whenever it does, wherever the focus went
//   board     a row with points stays on the board for the whole raid
//   base      a base bank that keeps you out says why
//   spawn     a respawn keeps its room from tanks that outclass you and from
//             the Core, inside the safe zone
//   kills     your own kill jumps the slam queue and says who you knocked out
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
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `round4-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-round4-test-'));
fs.mkdirSync(ROOT, { recursive: true });
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ACCOUNTS_ENABLED', 'ROYALE_FAIR_PLAY', 'ROYALE_FAIR_BOTS']) delete process.env[k];

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
const fair = T('fairPlay.js');
const storm = T('storm.js');
storm.start();
royale.tick();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let seq = 0;
function mkSocket() {
    const s = { id: 'r4' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    global.gameManager.socketManager.clients.push(s);
    return s;
}
function body(sock, x = 0, y = 0) {
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (++seq);
    t.name = 'Player' + seq;
    t.alwaysActive = true;
    t.messages = [];
    t.sendMessage = (m) => t.messages.push(m);
    const player = { socket: sock, body: t, target: { x: 120, y: 0 }, command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, autofire: false, autospin: false, override: false } };
    sock.player = player;
    t.socket = sock;
    global.gameManager.socketManager.players.push(player);
    royale.onHumanJoin(t);
    t.x = x; t.y = y;
    return t;
}
function bot(x, y) {
    const b = new Entity({ x, y });
    b.define('basic');
    b.isBot = true;
    b.team = -500 - (++seq);
    b.name = 'Bot' + seq;
    b.alwaysActive = true;
    b.controllers = [];
    global.gameManager.gameHandler.bots.push(b);
    return b;
}

// ── 1/2: TOO STRONG ─────────────────────────────────────────────────────
test('tough: TOO STRONG is never your own tank, only far ahead of a protected player, and the client draws it', () => {
    const me = { id: 1 };
    assert.equal(fair.tooStrong(true, me, 100, 9000, 9, me), false, 'never your own tank (you can be the bounty)');
    assert.equal(fair.tooStrong(true, { id: 2, growthMult: 2 }, 100, 9000, 0, me), true, 'far ahead and grown');
    assert.equal(fair.tooStrong(true, { id: 2, growthMult: 2 }, 5000, 5200, 0, me), false, 'level with you on the board');
    assert.equal(fair.tooStrong(false, { id: 2, growthMult: 2 }, 100, 9000, 0, me), false, 'veterans see the plain tag');
    const dr = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.match(dr, /fairPlay\.tooStrong\(true, e, myScore/, 'the server flags revenge / bounty');
    assert.match(dr, /\btooStrong:\s*\(body, e\)/, 'and the contracts hook skips such targets');
    const app = src('app.js');
    assert.match(app, /if \(r\.you && r\.you\.bt && id !== gui\.playerid\) return TOUGH_BADGE;/);
    assert.match(app, /rv\.tough \? TOUGH_BADGE : REVENGE_BADGE/);
});

test('tags: the pointer sits on the name; gem pops start above your own tag', () => {
    const app = src('app.js');
    assert.match(app, /const streakGap = \(fs\) => Math\.max\(2, fs \* 0\.12\);/);
    assert.match(app, /selfOver\.top = overheadTop\(instance, y \+ global\.screenHeight \/ 2, ratio, instance\.size\);/);
    assert.match(app, /const stackTop = selfOver\.at === overheadFrame \? selfOver\.top : cy;/);
    assert.match(app, /const rise {2}= base \+ 42 \*/);
});

// ── 4: perk card clicks ─────────────────────────────────────────────────
test('perks: a click on a card picks it; a press amid click-firing rests first', async () => {
    const L = await import(pathToFileURL(path.join(CLIENT, 'raidPerksLogic.js')).href);
    const now = 100000;
    // the playtest: cursor moved onto the card and clicked straight away (no rest)
    assert.equal(L.clickPicks({ k: 'c1', over: '', overSince: now, now, lastShotAt: -1e9 }), true, 'a fresh click');
    assert.equal(L.clickPicks({ k: 'c0', over: 'c0', overSince: now - 5, now, lastShotAt: now - 5000 }), true, 'last shot long ago');
    // click-firing at something, a press that lands on a card while sweeping
    assert.equal(L.clickPicks({ k: 'c2', over: 'c2', overSince: now - 50, now, lastShotAt: now - 200 }), false, 'mid-fire, just arrived');
    assert.equal(L.clickPicks({ k: 'c2', over: 'c2', overSince: now - 400, now, lastShotAt: now - 200 }), true, 'mid-fire, rested on it');
    assert.equal(L.clickPicks({ k: 'c2', over: 'c1', overSince: now - 400, now, lastShotAt: now - 200 }), false, 'rested on another card');
    assert.equal(L.clickPicks({ k: '', over: '', overSince: 0, now, lastShotAt: -1e9 }), false, 'nothing under the press');
    // the glue: a press off the cards counts as a shot; mouseDown asks in HUD units
    const rp = src('raidPerks.js');
    assert.match(rp, /if \(!k\) \{ S\.lastShotAt = now; return false; \}/);
    assert.match(rp, /if \(!L\.clickPicks\(pressIn\)\) \{ S\.lastShotAt = now; return false; \}/);
    const cv = src('canvas.js');
    assert.match(cv, /raidPerks\.click\(mpos\.x \/ guiScale\(\), mpos\.y \/ guiScale\(\)\)/);
    // hover and press use the same units (global.mouse / cr == mpos / guiScale)
    const app = src('app.js');
    assert.match(app, /mouse: global\.mobile \? null : \{ x: global\.mouse\.x \/ cr, y: global\.mouse\.y \/ cr \}/);
});

// ── 5: the death card owns the screen ───────────────────────────────────
test('card: slams wait or go, plates wait, labels dim', () => {
    const j = src('juice.js');
    assert.match(j, /export function setCardHold\(fn\)/);
    assert.match(j, /if \(cardHold\(\)\) \{/);
    assert.match(j, /if \(s && s\.on && s\.born === HELD\) s\.born = Math\.max\(now, hold\);/);
    assert.match(j, /if \(\(!s \|\| !s\.on\) && slamQ\.length\) \{ nextSlam\(now\); s = slamCur; \}/, 'the queue moves on after the card');
    const app = src('app.js');
    assert.match(app, /cardHold: \(\) => deathCardUp\(\)/);
    assert.match(app, /global\.introCardUp \|\| global\.introWait \|\| card;/, 'plates wait for the card (round 8: and from the join until it has played)');
    assert.match(app, /const lblK = deathCardUp\(\) \? 0\.45 : 1;/);
    assert.match(app, /if \(deathCardUp\(\)\) return 0\.25;/, 'pad labels dim');
});

// ── 6: respawn button and Enter ─────────────────────────────────────────
test('respawn: one word, and Enter works whenever the button does', () => {
    const app = src('app.js');
    const fnAt = app.indexOf('function playAgainState()');
    const body = app.slice(fnAt, app.indexOf('\n    }\n', fnAt));
    assert.ok(!/"Play again/.test(body), 'never says Play again in a raid');
    assert.match(body, /label: "Respawn in " \+ Math\.ceil\(waitMs \/ 1000\) \+ "\.\.\."/);
    assert.match(body, /return \{ ready: true, label: "Respawn" \};/);
    const cv = src('canvas.js');
    // Enter in a raid no longer waits on the old respawnTimeout (cannotRespawn)
    assert.match(cv, /if \(kc === global\.KEY_ENTER && global\.died && !global\.tutorialMode && !global\.disconnected && !duoChat\(\) && !global\.showChat\) \{\s+if \(!event\.repeat\) \{ global\.rbWantBuild = false; this\.respawn\(\); \}/);
    // and reaches the game when a DOM element has the focus
    assert.match(cv, /window\.addEventListener\("keydown", \(event\) => \{[\s\S]{0,1400}if \(event\.target === this\.cv \|\| !global\.gameStart/);
    // respawn() keeps the raid's own wait
    // (round 6: asking during the wait queues the drop instead of nothing)
    assert.match(cv, /const waiting = global\.died && global\.raidRespawnAt > 0 && performance\.now\(\) < global\.raidRespawnAt;\n\s+if \(locked \|\| waiting\) \{[^}]*global\.respawnQueued = true;\n\s+return;/);
});

// ── 7: the board keeps everyone with points ─────────────────────────────
test('board: a row with points is never swept mid-raid', () => {
    assert.equal(royale._keepRow({ key: 'b:1', banked: 16000, kills: 0, carried: 0 }), true);
    assert.equal(royale._keepRow({ key: 'b:2', banked: 0, kills: 0, carried: 0 }), false);
    const dr = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.match(dr, /> 5 \* 60 \* 1000 && !keepRow\(s\)\) raidStats\.delete\(k\);/);
});

// ── 8: base banks say why ───────────────────────────────────────────────
test('base: a base bank that keeps you out says why', () => {
    assert.match(royale._baseDenyText(true, 'tinyerode', 0), /This is tinyerode's Team Bank\. Break its banner/);
    assert.match(royale._baseDenyText(true, '', 0), /Nobody owns this Team Bank\. Break its banner to claim it/);
    assert.equal(royale._baseDenyText(false, '', 7), 'Your Team Bank opens again in 7s.');
    // live: an unowned base, a player on its rim
    const sock = mkSocket();
    const me = body(sock, 0, 0);
    const site = { id: 9901, x: 0, y: 0, r: 95, ownerId: 0, name: 'West Team Bank' };
    me.x = 0; me.y = 0;
    me.messages.length = 0;
    assert.equal(royale.baseWall(me, site), true, 'kept out');
    assert.ok(me.messages.some(m => /Nobody owns this Team Bank/.test(m)), 'and told why');
    const n = me.messages.length;
    royale.baseWall(me, site);
    assert.equal(me.messages.length, n, 'not every tick');
});

// ── 9: respawn room ─────────────────────────────────────────────────────
test('spawn: big tanks and the Core count, and the pick keeps its room', () => {
    // who counts as big
    assert.equal(fair.bigThreat(5000, 1, 7000, 1), true, '7k next to your 5k');
    assert.equal(fair.bigThreat(9000, 1, 3500, 1), false, 'well behind you');
    assert.equal(fair.bigThreat(0, 1, 1000, 1.6), true, 'grown past you');
    assert.equal(fair.bigThreat(0, 1.6, 1000, 1.6), false, 'grown no more than you');
    assert.deepEqual(fair.spawnKeep(true), fair.spawnKeep(false), 'the same room for everyone');
    // live, a crowded small map: three big bots on the east side, small
    // fry spread round the rest. The roomiest spot by plain distance is out
    // east past the big ones; the respawn has to keep its room from them
    const sock = mkSocket();
    const me = body(sock, 0, 0);
    const bigs = [bot(900, 0), bot(1100, 250), bot(1100, -250)];
    for (const b of bigs) b.growthMult = 1.9;
    const small = [bot(-900, 0), bot(-450, 800), bot(-450, -800), bot(250, 950), bot(250, -950)];
    for (const b of small) b.growthMult = 1;
    const keep = fair.spawnKeep(false).r;
    const dg = royale._spawnDanger(me, [...bigs, ...small, me], Date.now());
    assert.ok(dg && dg.set.size === 3, 'the three big ones count, the small fry do not');
    assert.equal(dg.near(1000, 100), true);
    // (round 5: the room is about a screen, fairPlay SPAWN_SAFE_R)
    assert.equal(dg.near(900 - keep - 100, 0), false);
    global.gameManager.terrainGrid = { circleRadius: 2400 };
    // (combatants() keeps its list for 16 ms: let the new bots in)
    const until = Date.now() + 25; while (Date.now() < until) { /* wait */ }
    let n = 0;
    try {
        for (let i = 0; i < 25; i++) {
            const h = royale._safeSpawnSpot(me, false, 0);
            const d = Math.min(...bigs.map(b => Math.hypot(h.x - b.x, h.y - b.y)));
            assert.ok(d >= keep, 'spot ' + i + ' at ' + Math.round(h.x) + ',' + Math.round(h.y) + ' is ' + Math.round(d) + ' from a big tank');
            n++;
        }
    } finally {
        global.gameManager.terrainGrid = null;
        for (const b of [...bigs, ...small]) { try { b.destroy(); } catch { /* */ } }
    }
    assert.equal(n, 25);
});

// ── 10: your kill ───────────────────────────────────────────────────────
test('kills: your own kill jumps the queue and names who you knocked out', async () => {
    const JM = await import(pathToFileURL(path.join(CLIENT, 'juiceMath.js')).href);
    const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    assert.equal(JM.killSub('ELIMINATED: jaxon', 1250, fmt), 'You knocked out jaxon  ·  +1,250 pts');
    assert.equal(JM.killSub('ELIMINATED: kai  (480 gems dropped)', 0, fmt), 'You knocked out kai');
    assert.equal(JM.killSub('', 0, fmt), 'You knocked them out');
    const rh = src('raidHeat.js');
    // (round 6: ELIMINATED, DOUBLE KO... chained under one slam key)
    assert.match(rh, /let line = JM\.killSub\(text, pts, fmt\);/);
    assert.match(rh, /juice\.slamFirst\(head, line, col, /);
    assert.match(src('juice.js'), /export function slamFirst\(text, sub, col, dur, size, key\)/);
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
