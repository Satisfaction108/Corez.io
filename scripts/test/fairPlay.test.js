// Fair play (server/game/terrain/fairPlay.js): node scripts/test/fairPlay.test.js
//
// The rule (owner, Oct 5 2026): "it's fine if the bots ignore them and bots
// hold fire, that's fair. I just said not to give them extra buffs." These
// tests assert both halves: bots go easy on a protected player (who they
// pick, chase, aim at, shoot), and a protected player's stats and the damage
// they take are exactly everyone's.
//
//   struggle   deaths nothing paid for (a kill is worth two, 300 banked one);
//              a new raid halves the deaths and kills; an unranked player's
//              bot difficulty is capped 0.5 .. 0.2 by it, a ranked one's not
//   protect    first two raids, still new, or struggle 2+: protected, and
//              stamped through the real spawn path
//   no buffs   a protected player's max health and bullet damage are
//              unchanged, bot and player shots land on them the same, and
//              no "boost" message
//   vaults     bots don't pick, chase or shoot a protected player heading in
//              to bank (unless shot first); banking bots go elsewhere or wait
//              outside the ring; bot shots that still land do full damage;
//              bots never retreat to a vault, a bot hanging round one is sent
//              off, bots don't brawl with each other inside a vault's ring
//   banking    a protected player banking: their killer and a 2x-points bot
//              hold off (a veteran banking is fair game)
//   earned out 3 kills, a streak of 3, 2,500 points, the top half of the
//              board, 3 deposits or 12 minutes played end protection for the
//              session, mid-life; a 30 minute guest is never protected
//   engage     a paced sim: real bots pick and shoot a 30 minute guest
//              within a few seconds, and leave a brand-new player be
//   bullies    a grown bot doesn't start on a protected player (shot first:
//              it fights back)
//   minnows    a protected player in the raid makes the next bots small fish
//              (tier 2 tank, fewer points, low skill, growth capped); the
//              director sends them, never a grown bot
//   builds     off by default; with ROYALE_KEEP_BUILD=1 a respawn in the same
//              raid comes back as the same tank with the same stat spread
//   storm      spawn lock is 12 s; a death in it is told the wait; the
//              respawn spot helpers keep off the storm edge; a human lands
//              where the storm takes SPAWN_ETA_S+ to arrive; the storm hurts
//              a protected player exactly as much (share of max health) and
//              ramps at the same pace; a walled-in human gets a tunnel
//   runaway    a bot far ahead of every human (with a protected player in
//              the raid) stops growing, other bots gang up on it, and it
//              doesn't start on a protected player (aims worse at one)
//   farming    no killing the same player again and again: twice for
//              anyone, the same window for everyone, tallied on the victim
//              too (outlives a bot's respawn), the next spawn keeps away,
//              the director skips it
//   first kill a player with no kill yet gets a small fish sent over; it
//              plays them like a beginner (aim, bursts, standoff, no
//              abilities), sees it through, other bots leave the host to it;
//              its damage, and the host's into it, are untouched
//   bosses     spawns keep off a live boss and its drones; a new raid
//              clears its brood
//   move on    a kill at a vault: loot, then leave and bank elsewhere
//   duels      a small fish trades shots with a protected player close by,
//              and other bots stay out of it
//   tags       REVENGE / BOUNTY on a tank far beyond a protected player is
//              flagged TOO STRONG (never their own tank)
//   beaten     a bot a protected player beat leaves them be all raid
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
    room: { width: 5460, height: 5460, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;
function loop(n = 1) { for (let i = 0; i < n; i++) handler.gameloop(); }

const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
const grid = mapGen.generate({ cols: 13, rows: 13, tileWidth: 420, fullLattice: true });
grid.buildVoronoiColliders();
global.gameManager.terrainGrid = grid;
try { require(path.join(SERVER, 'game', 'terrain', 'royaleLayout.js')).carveMatchPois(grid); } catch { /* */ }

const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const fair = require(path.join(SERVER, 'game', 'terrain', 'fairPlay.js'));
const D = require(path.join(SERVER, 'miscFiles', 'botDifficulty.js'));
const vault = require(path.join(SERVER, 'game', 'terrain', 'vault.js'));
const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
const growth = require(path.join(SERVER, 'game', 'terrain', 'growth.js'));
const gems = require(path.join(SERVER, 'game', 'terrain', 'gems.js'));
const { shotMult } = require(path.join(SERVER, 'game', 'entities', 'subFunctions.js'));
const { ioTypes } = require(path.join(SERVER, 'miscFiles', 'controllers.js'));
const T = fair.TUNE;
const MIN = 60_000;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let ids = 7000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function fakeSocket(minutes = 0, extra = {}) {
    const s = { id: ids++, packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 3, _careerPlayMs: minutes * MIN, ...extra };
    s.talk = (...a) => s.packets.push(a);
    return s;
}
function player(socket, x, y) {
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (ids++ & 0xff);
    t.name = 'Tester' + ids;
    t.alwaysActive = true;
    t.socket = socket;
    socket.player = { body: t };
    t.sendMessage = () => {};
    level45(t);
    return t;
}
function spawn(minutes, x, y, socket = fakeSocket(minutes)) {
    const p = player(socket, x, y);
    royale.freshRaidBody(p);
    return p;
}
function bot(cls, x, y) {
    const b = new Entity({ x, y });
    b.define(cls);
    b.isBot = true;
    b.team = -500 - (ids++ & 0xff);
    b.name = 'Bot' + ids;
    b.alwaysActive = true;
    b.botSkill = 0.5;
    level45(b);
    b.controllers = [];
    return b;
}
// past bot grace and the soft window: only fair play's rules are left
function bare(p) {
    p.invuln = false;
    p.botGraceUntil = 0;
    p.botSoftUntil = 0;
    p.botNewbie = false;
}
const waitScan = () => { for (const t = Date.now(); Date.now() - t < 130;); };
const msgs = (s) => s.packets.filter(a => a[0] === 'm').map(a => String(a[2]));

royale.tick();
const V = vault.getVaults()[0];
assert.ok(V, 'the map has vaults');

// ===================================================================

test('struggle: deaths nothing paid for; a new raid halves it', () => {
    const s = {};
    for (let i = 0; i < 4; i++) fair.noteDeath(s, 1);
    assert.equal(fair.struggleOf(s, 1), 3, 'four deaths, nothing else');
    fair.noteKill(s, 1);
    assert.equal(fair.struggleOf(s, 1), 1, 'a kill is worth two');
    fair.noteBank(s, 1, 300);
    assert.equal(fair.struggleOf(s, 1), 0, '300 banked is worth one');
    // 8 deaths, no kills, no bank: the blind playtest
    const p = {};
    for (let i = 0; i < 8; i++) fair.noteDeath(p, 1);
    assert.equal(fair.struggleOf(p, 1), 7);
    assert.equal(fair.struggleOf(p, 2), 3, 'next raid: half the deaths');
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(fair.struggleCap), [1, 0.5, 0.4, 0.3, 0.2, 0.2]);
});

test('difficulty: a losing guest is capped below lock-on, a ranked player is not', () => {
    const vet = { newness: 0, rankCode: 0, score: 0, kills: 0, playMs: 20 * MIN };
    const free = D.forPlayer(vet);
    assert.ok(free > 0.8, 'a 20 minute guest normally faces lock-on bots: ' + free);
    assert.equal(D.forPlayer({ ...vet, struggle: 1 }), 0.5);
    assert.equal(D.forPlayer({ ...vet, struggle: 7 }), 0.2);
    assert.equal(D.lockShare(D.forPlayer({ ...vet, struggle: 1 })), 0, 'no lock-on while losing');
    // a ranked player keeps the rank's bots
    const Ranks = require(path.join(REPO, 'shared', 'ranks.js'));
    const code = Ranks.rankCode ? Ranks.rankCode(3) : 21;
    const ranked = D.forPlayer({ ...vet, rankCode: code, struggle: 7 });
    assert.equal(ranked, D.forPlayer({ ...vet, rankCode: code }), 'ranked: struggle ignored');
    // switch off
    fair.setSwitch('struggle', false);
    try { assert.equal(fair.struggleOf({ _fp: { raid: 1, deaths: 9, kills: 0, banked: 0 } }, 1), 0); }
    finally { fair.setSwitch('struggle', true); }
});

test('protect: first two raids, still new, or struggling; stamped on spawn', () => {
    assert.equal(fair.protects({ stage: 0 }), true);
    assert.equal(fair.protects({ stage: 1 }), true);
    assert.equal(fair.protects({ stage: 3, newness: 0.2 }), true);
    assert.equal(fair.protects({ stage: 3, newness: 0, struggle: 1 }), false);
    assert.equal(fair.protects({ stage: 3, newness: 0, struggle: 2 }), true);
    assert.equal(fair.protects({ stage: 2, newness: 0, struggle: 0 }), false);
    const n = spawn(0, 0, -2000);
    assert.equal(n._fpProtect, true, 'a brand new player');
    const v = spawn(120, 0, -2000);
    assert.equal(v._fpProtect, false, 'a veteran');
    // the same veteran after dying over and over this raid
    // (8 minutes in all: still under the earned-out clock)
    const s = fakeSocket(8, { _royaleLives: 20 });
    const w = player(s, 0, -2000);
    royale.onBanked(w, 1);                  // opens the tally on the live raid
    Object.assign(s._fp, { deaths: 6, kills: 0, banked: 0 });
    royale.freshRaidBody(w);
    assert.equal(w._fpProtect, true, 'struggling: protected');
    assert.ok(w.botDifficulty <= 0.2 + 1e-9, 'and capped: ' + w.botDifficulty);
    s._fp.kills = 3;                        // they start winning
    royale.freshRaidBody(w);
    assert.equal(w._fpProtect, false);
    for (const o of [n, v, w]) o.kill();
    loop(2);
});

test('no buffs: a protected player has the same max health, deals and takes the same damage, and is told of no boost', () => {
    const src = require('fs').readFileSync(path.join(SERVER, 'game', 'terrain', 'fairPlay.js'), 'utf8');
    assert.ok(!/BUFF_HP|BUFF_DMG|fpHealthMult|ROYALE_NEWBIE_BUFF/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no buff code');
    for (const k of ['stampBuff', 'buffDamage', 'buffOn', 'shotMult', 'baitShotMult', 'baitTaken', 'stormEase']) assert.equal(fair[k], undefined, k);
    const sock = fakeSocket(0);
    const said = [];
    const n = spawn(0, 0, -2000, sock);
    n.sendMessage = (m) => said.push(String(m));
    const v = spawn(120, 0, -2100);
    stampProtect(n, true); stampProtect(v, false);
    assert.equal(fair.isProtected(n), true);
    assert.equal(fair.isProtected(v), false);
    // max health: the same body, the same pool
    n.refreshBodyAttributes(); v.refreshBodyAttributes();
    assert.ok(Math.abs(n.health.max - v.health.max) < 1e-6, n.health.max + ' vs ' + v.health.max);
    assert.ok(!n.fpHealthMult && !n._fpBuff, 'no buff stamps');
    // bullet damage dealt: the same into anyone
    const target = bot('basic', 0, -1800);
    assert.equal(shotMult({ master: n }, target), shotMult({ master: v }, target), 'their shots land the same');
    // damage taken: no factor at all, from bots or players
    assert.equal(shotMult({ master: target }, n), shotMult({ master: target }, v), 'bot shots land the same on a protected player');
    assert.equal(shotMult({ master: v }, n), shotMult({ master: v }, target), 'player shots land the same');
    assert.equal(D.shotMult(0), D.shotMult(1), 'bot fire into a new player is the same as into a veteran');
    stampProtect(n, true); stampProtect(n, true);
    assert.ok(!said.some(m => /boost|bonus health|bullet damage/i.test(m)), said.join(' | '));
    for (const o of [n, v, target]) o.kill();
    loop(2);
});

// a protected player and a veteran on a vault's approach, gems on board
function atVault(p, d = (V.r || 95) * 1.4 + 200) {
    p.x = V.x + d; p.y = V.y;
    gems.initSatchel(p);
    p.carriedGems = 200;
}
test('vaults: bots leave a protected player heading in to bank alone and hold fire; shots still land in full', () => {
    const G = ioTypes.digWarsGoals;
    const p = spawn(0, 0, 0), v = spawn(120, 0, 0);
    bare(p); bare(v);
    stampProtect(p, true); stampProtect(v, false);
    atVault(p);
    const b = bot('basic', p.x + 450, p.y);
    const c = new G(b);
    v.x = p.x + 6000;   // the veteran far off for now
    loop(2); waitScan();
    let now = Date.now();
    assert.equal(fair.isProtected(p, now), true);
    assert.equal(fair.vaultGuarded(p, now), true, 'on the way in with gems');
    assert.equal(fair.spared(b, p, now), true);
    c.senseAt = 0; c.sense(now);
    assert.notEqual(c.view.enemy, p, 'not picked');
    assert.equal(c.canInitiateFight(p, now), false, 'no fight started');
    assert.equal(new ioTypes.nearestDifferentMaster(b).validate(p, b, b, 1e12, 1e12), false, 'its guns hold fire');
    // a fight already on breaks off at the vault
    c.goal = { kind: 'fight', target: p }; c.goalStartedAt = now;
    assert.equal(c.stillValid(c.goal, now), false, 'the chase stops');
    // a veteran in the same spot is fair game
    stampProtect(p, false);
    assert.equal(fair.vaultGuarded(p, now), false);
    assert.equal(fair.spared(b, p, now), false, 'a veteran banking: no sparing rule');
    stampProtect(p, true);
    // no gems on board and nothing banked lately: no guard
    p.carriedGems = 0; p._fpBankedAt = 0;
    assert.equal(fair.vaultGuarded(p, now), false, 'nothing to bank');
    p.carriedGems = 200;
    // they shoot it first: it fights back
    b._lastDamageSource = p; b._lastDamageAt = now; b._dmgBy = new Map([[p.id, b.health.max * 0.25]]); // round 9: 25% dealt
    assert.equal(fair.spared(b, p, now), false, 'shot first: fights back');
    b._lastDamageSource = null; b._lastDamageAt = 0; b._dmgBy = null;
    // a bot shot that still lands does full damage (no protected factor)
    const shell = { master: b };
    const prot = shotMult(shell, p);
    p._fpProtect = false;
    const plain = shotMult(shell, p);
    p._fpProtect = true;
    assert.equal(prot, plain, 'same damage taken');
    // the switch
    fair.setSwitch('vault', false);
    try { assert.equal(fair.vaultGuarded(p, now), false, 'ROYALE_FAIR_VAULT=0'); } finally { fair.setSwitch('vault', true); }
    for (const o of [p, v, b]) o.kill();
    loop(2);
});

test('banking: a protected player banking is left be by the tank that killed them and by a bot with 2x their points; a veteran is not', () => {
    const p = spawn(120, 0, 0);
    bare(p); stampProtect(p, false);
    atVault(p);
    const killer = bot('basic', p.x + 500, p.y), big = bot('basic', p.x - 500, p.y), plain = bot('basic', p.x, p.y + 500);
    fair.noteKilledBy(p.socket, killer, Date.now(), 'R');
    big._fpPts = 4000; p._fpPts = 1000; plain._fpPts = 1200;
    p._fpBank = 1;                          // on the way in (vault.tick stamps it)
    const now = Date.now();
    // round 8: anyone else banking is fair game (the hold-off applied to every human)
    assert.equal(fair.bankBully(killer, p, now), false, 'a veteran banking: their killer may come');
    assert.equal(fair.bankBully(big, p, now), false, 'a veteran banking: so may a 2x tank');
    assert.equal(fair.spared(killer, p, now), false);
    assert.equal(fair.guarded(p), false, 'nothing guards a veteran banking');
    p._fpBank = 2;
    assert.equal(fair.bankBully(killer, p, now), false, 'covered too');
    p._fpBank = 1;
    stampProtect(p, true);
    assert.equal(fair.bankBully(killer, p, now), true, 'the tank that killed them waits');
    assert.equal(fair.bankBully(big, p, now), true, '2x their points waits');
    assert.equal(fair.bankBully(plain, p, now), false, 'an even bot may still fight');
    assert.equal(fair.spared(killer, p, now), true, 'read through spared (bots hold fire)');
    // on the way in, shooting it first starts the fight; covered, nothing does
    killer._lastDamageSource = p; killer._lastDamageAt = now; killer._dmgBy = new Map([[p.id, killer.health.max * 0.25]]); // round 9: 25% dealt
    assert.equal(fair.bankBully(killer, p, now), false, 'shot first on the way in');
    p._fpBank = 2;
    assert.equal(fair.bankBully(killer, p, now), true, 'covered: still waits');
    p._fpBank = 0;
    assert.equal(fair.bankBully(big, p, now), false, 'not banking: no hold-off');
    // bank cover itself is the same factor for everyone
    const v2 = spawn(0, 0, 0); stampProtect(v2, true);
    v2._bankCover = T.BANK_COVER_MULT; p._bankCover = T.BANK_COVER_MULT;
    assert.equal(fair.bankCoverMult(v2), fair.bankCoverMult(p));
    assert.ok(T.BANK_COVER_MULT >= 0.85 - 1e-9, 'mild: ' + T.BANK_COVER_MULT);
    for (const o of [p, v2, killer, big, plain]) o.kill();
    loop(2);
});

test('vaults: no healing laps round a vault, lingering bots move on, banking bots wait for a protected player', () => {
    const G = ioTypes.digWarsGoals;
    const b = bot('basic', V.x + 200, V.y + 100);
    const c = new G(b);
    // retreat with nobody around, and away from a shooter toward the vault
    c.view.enemy = null;
    let pt = c.retreatPoint();
    assert.ok(Math.hypot(pt.x - V.x, pt.y - V.y) >= T.LINGER_R, 'outside the ring');
    const shooter = bot('basic', V.x + 900, V.y);
    c.view.enemy = shooter;
    pt = c.retreatPoint();
    for (const q of vault.getVaults()) assert.ok(Math.hypot(pt.x - q.x, pt.y - q.y) >= T.LINGER_R - 1, 'never into a ring');
    // no bot-on-bot brawl inside a ring: a weak bot right there is left be
    const weak = bot('basic', V.x + 150, V.y + 200);
    weak.health.amount = weak.health.max * 0.2;
    c.threatCache.clear();
    assert.equal(fair.inRing(b.x, b.y), true);
    assert.equal(c.canInitiateFight(weak, Date.now()), false, 'not at the vault');
    weak.x = V.x + 2600; b.x = V.x + 2400; b.y = weak.y = V.y + 1200;
    c.threatCache.clear();
    if (!fair.inRing(b.x, b.y) && !fair.inRing(weak.x, weak.y)) assert.equal(c.canInitiateFight(weak, Date.now()), true, 'away from it, fair game');
    b.x = V.x + 200; b.y = V.y + 100;
    weak.kill();
    // lingering
    const t0 = Date.now();
    assert.equal(fair.lingerCheck(b, false, t0), null, 'clock starts');
    assert.equal(fair.lingerCheck(b, false, t0 + T.LINGER_MS - 10), null);
    const leave = fair.lingerCheck(b, false, t0 + T.LINGER_MS + 10);
    assert.ok(leave && Math.hypot(leave.x - V.x, leave.y - V.y) > T.LINGER_R + 200, 'sent off');
    assert.equal(fair.lingerCheck(b, false, t0 + T.LINGER_MS + 500), leave, 'the same errand until clear');
    b.x = leave.x; b.y = leave.y;
    assert.equal(fair.lingerCheck(b, false, t0 + T.LINGER_MS + 900), null, 'clear');
    assert.equal(fair.lingerCheck(b, true, t0), null, 'banking is not lingering');
    // a bot that wants to bank while a protected player heads in: another
    // vault, or wait outside the ring
    const p = spawn(0, 0, 0);
    bare(p); stampProtect(p, true); atVault(p);
    assert.equal(fair.vaultFreeFor(b, V, [p]), false, 'not this vault for now');
    stampProtect(p, false);
    assert.equal(fair.vaultFreeFor(b, V, [p]), true, 'a veteran banking holds nobody up');
    for (const o of [b, shooter, p]) o.kill();
    loop(2);
});

test('bullies: a grown bot does not start on a protected player, but fights back when shot', () => {
    const G = ioTypes.digWarsGoals;
    const st = storm.snapshot();
    const x = st.cx, y = st.cy + 3000;
    const p = spawn(0, x, y);
    bare(p); stampProtect(p, true);
    const big = bot('basic', x + 500, y);
    big.growthMult = 1.8;
    const cb = new G(big);
    loop(2); waitScan();
    big.growthMult = 1.8;
    let now = Date.now();
    assert.equal(fair.isBig(big), true);
    assert.equal(fair.isProtected(p, now), true);
    cb.senseAt = 0; cb.sense(now);
    assert.notEqual(cb.view.enemy, p, 'the grown bot leaves them be');
    assert.equal(cb.canInitiateFight(p, now), false);
    big._lastDamageSource = p; big._lastDamageAt = now; big._dmgBy = new Map([[p.id, big.health.max * 0.25]]); // round 9: 25% dealt
    assert.equal(fair.spared(big, p, now), false, 'shot by them: fights back');
    big._lastDamageSource = null; big._lastDamageAt = 0; big._dmgBy = null;
    // a veteran: fair game
    stampProtect(p, false);
    assert.equal(fair.spared(big, p, now), false);
    for (const o of [big, p]) o.kill();
    loop(2);
});

test('minnows: tier 2 tank, fewer points, low skill, growth capped; the director sends them', () => {
    assert.equal(fair.minnowsWanted(0, 4), 0);
    assert.equal(fair.minnowsWanted(1, 4), 2);
    assert.equal(fair.minnowsWanted(1, 1), 1);
    assert.equal(fair.shouldBeMinnow([{ botMinnow: true }, { botMinnow: true }], 1, 4), false, 'enough already');
    assert.equal(fair.shouldBeMinnow([{ botMinnow: true }], 1, 4), true);
    assert.equal(fair.shouldBeMinnow([], 1, 4, 5000), false, 'a big name on the board stays a regular');
    const before = handler.bots.length;
    handler.spawnBots({ x: 0, y: 2600 }, -901, null, null);
    handler.spawnBots({ x: 200, y: 2600 }, -902, null, { respawnsRemaining: 0, minnow: true });
    assert.equal(handler.bots.length, before + 2);
    const reg = handler.bots[before], m = handler.bots[before + 1];
    assert.equal(m.botMinnow, true);
    assert.ok(m.botSkill <= T.MINNOW_SKILL[1] + 1e-9);
    assert.ok(m.botStatTotal < reg.botStatTotal * 0.8, 'fewer points: ' + m.botStatTotal + ' vs ' + reg.botStatTotal);
    const tierOf = (b) => { const c = Class[b.defs[0]]; return c ? c : null; };
    assert.ok(tierOf(m), 'has a class');
    // a regular is a final tank: a minnow stops a step short of it
    const botTanks = require(path.join(SERVER, 'miscFiles', 'botTanks.js'));
    const finals = new Set(botTanks.pool().map(c => c.name));
    if (botTanks.isEnabled()) {
        assert.ok(finals.has(String(reg.defs[0])), 'regular: ' + reg.defs[0]);
        assert.ok(!finals.has(String(m.defs[0])), 'minnow: ' + m.defs[0]);
    }
    // growth: plain score, capped
    Config.royale_growth = true;
    growth.onSpawn(m, 40000);
    assert.ok(m.growthMult <= T.MINNOW_GROWTH_CAP + 1e-9, 'capped: ' + m.growthMult);
    growth.onSpawn(m, 0);
    growth.onSpawn(reg, 40000);
    assert.ok(reg.growthMult > 1.5);
    growth.onSpawn(reg, 0);
    // the director: a protected host gets the minnow, never a grown bot
    for (const b of handler.bots) if (b !== m && b !== reg) { b._botDirectorUntil = Date.now() + 1e6; }
    reg.growthMult = 2;
    const host = spawn(0, 0, -3000);
    bare(host);
    m.x = 4000; m.y = 0; reg.x = -1500; reg.y = -3000;
    handler.socketManagerPlayers = () => [host];
    m._botDirectorUntil = 0; reg._botDirectorUntil = 0; m._botDirectorPoint = null; reg._botDirectorPoint = null;
    handler.directorTick();
    assert.ok(m._botDirectorPoint, 'the minnow is sent over');
    assert.ok(!reg._botDirectorPoint, 'the grown bot is not');
    delete handler.socketManagerPlayers;
    for (const o of [m, reg, host]) o.kill();
    loop(2);
});

test('builds: off by default (a death resets to Basic); ROYALE_KEEP_BUILD=1 brings it back', () => {
    // the default: nothing saved, the respawn is a plain Basic
    assert.equal(fair.on('build'), process.env.ROYALE_KEEP_BUILD === '1', 'off unless ROYALE_KEEP_BUILD=1');
    if (!fair.on('build')) {
        const s0 = fakeSocket(30);
        const p0 = spawn(30, 0, -2400, s0);
        const i0 = p0.upgrades.findIndex(u => u && Array.isArray(u.class) && (u.class[0] === 'sniper' || u.class[0] === Class.sniper));
        p0.upgrade(i0);
        p0.deathCause = 'bot';
        royale.onCombatantDead(p0);
        assert.ok(!s0._fpBuild, 'nothing saved');
        const q0 = player(s0, 0, -2400);
        assert.equal(royale.applyRespawnBuild(s0), false);
        assert.equal(q0.label, 'Basic', 'back as a Basic');
        for (const o of [p0, q0]) { try { o.kill(); } catch { /* */ } }
        loop(2);
    }
});

test('builds (switched on): a respawn in the same raid keeps its tank and stat spread', () => {
    fair.setSwitch('build', true);
    try { keepBuildCase(); } finally { fair.setSwitch('build', process.env.ROYALE_KEEP_BUILD === '1'); }
});
function keepBuildCase() {
    const sock = fakeSocket(30);
    const p = spawn(30, 0, -2400, sock);
    // Basic -> Twin -> Triple Shot, points placed
    const up = (name) => { const i = p.upgrades.findIndex(u => u && Array.isArray(u.class) && (u.class[0] === name || u.class[0] === Class[name])); assert.ok(i >= 0, name); p.upgrade(i); };
    up('twin'); up('tripleShot');
    const label = p.label;
    const raw = [5, 4, 3, 7, 7, 0, 0, 2, 0, 3, 2];
    const total = p.skill.points + p.skill.raw.reduce((a, b) => a + b, 0);
    p.skill.set(raw); p.skill.points = total - raw.reduce((a, b) => a + b, 0);
    const rid = sock._fp ? sock._fp.raid : 0;
    fair.saveBuild(sock, p, 'R1');
    p.kill(); loop(2);
    const q = player(sock, 0, -2400);       // fresh body after the level-45 fill
    assert.equal(q.label, 'Basic');
    const qPool = q.skill.points + q.skill.raw.reduce((a, b) => a + b, 0);
    assert.equal(fair.restoreBuild(sock, q, 'R1'), true);
    assert.equal(q.label, label);
    assert.deepEqual(q.skill.raw.slice(0, raw.length), raw);
    assert.equal(q.skill.points, qPool - raw.reduce((a, b) => a + b, 0), 'the rest still to spend');
    void total;
    assert.equal(sock._fpBuild, null, 'used up');
    // a different raid, the tutorial, the switch off: a plain Basic
    fair.saveBuild(sock, q, 'R1');
    const r = player(sock, 0, -2400);
    assert.equal(fair.restoreBuild(sock, r, 'R2'), false);
    assert.equal(r.label, 'Basic');
    fair.saveBuild(sock, q, 'R1');
    Config.tutorial = true;
    try { assert.equal(fair.restoreBuild(sock, player(sock, 0, -2400), 'R1'), false); } finally { Config.tutorial = false; }
    fair.setSwitch('build', false);
    try { assert.equal(fair.saveBuild(sock, q, 'R1'), null); } finally { fair.setSwitch('build', true); }
    // nothing upgraded, nothing spent: nothing saved
    const plain = player(fakeSocket(30), 0, -2400);
    assert.equal(fair.saveBuild(plain.socket, plain, 'R1'), null);
    // fewer points on the new body: trimmed, never over the caps
    const fit = fair.fitRaw([9, 9, 9], 10, [7, 9, 9]);
    assert.deepEqual(fit, { raw: [7, 3, 0], left: 0 });
    // the death path saves it and the spawn path restores it
    const src = require('fs').readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.ok(/applyRespawnBuild\(socket\)/.test(src), 'sockets.initalizePlayer calls it');
    void rid;
    for (const o of [q, r, plain]) o.kill();
    loop(2);
}

test('builds (switched on): a raid death saves it through onCombatantDead', () => {
    fair.setSwitch('build', true);
    try { keepBuildDeath(); } finally { fair.setSwitch('build', process.env.ROYALE_KEEP_BUILD === '1'); }
});
function keepBuildDeath() {
    const sock = fakeSocket(30);
    const p = spawn(30, 0, -2600, sock);
    const i = p.upgrades.findIndex(u => u && Array.isArray(u.class) && (u.class[0] === 'sniper' || u.class[0] === Class.sniper));
    p.upgrade(i);
    p.deathCause = 'bot';
    royale.onCombatantDead(p);
    assert.ok(sock._fpBuild && sock._fpBuild.defs.length, 'saved');
    const q = player(sock, 0, -2600);
    assert.equal(royale.applyRespawnBuild(sock), true);
    assert.equal(q.label, 'Sniper');
    // a raid-end death keeps nothing
    const s2 = fakeSocket(30);
    const e = spawn(30, 0, -2600, s2);
    e.upgrade(i);
    e.deathCause = 'raidend';
    royale.onCombatantDead(e);
    assert.equal(s2._fpBuild, null);
    for (const o of [p, q, e]) { try { o.kill(); } catch { /* */ } }
    loop(2);
}

test('storm: a 12 s lock, the wait is told, spawn helpers keep off the edge', () => {
    assert.equal(royale.FIRST_MINUTES.STORM_LOCK_MS, 12_000);
    const st = { a: 1, cx: 0, cy: 0, r: 2000, n: 1999 };    // closing 4 u/s
    // 25 s ahead: 1900, minus the margin
    assert.equal(fair.edgeSafe(0, 1500, st), true);
    assert.equal(fair.edgeSafe(0, 1700, st), false, 'right at the edge');
    assert.equal(fair.edgeSafe(0, 2100, st), false, 'in the storm');
    assert.equal(fair.edgeSafe(0, 5000, { a: 0 }), true, 'no storm');
    // a death inside the lock is told how long
    const sock = fakeSocket(30);
    const p = spawn(30, 0, -2800, sock);
    const realLocked = storm.locked, realLeft = storm.lockLeftSec;
    storm.locked = () => true; storm.lockLeftSec = () => 9;
    try {
        p.deathCause = 'bot';
        royale.onCombatantDead(p);
    } finally { storm.locked = realLocked; storm.lockLeftSec = realLeft; }
    assert.ok(msgs(sock).some(m => /drop back in 9 seconds/.test(m)), msgs(sock).join(' | '));
    assert.equal(sock._fpLockWait, true);
    try { p.kill(); } catch { /* */ }
    loop(2);
});

// a spot the storm has swallowed, on the map
function stormSpot(extra = 250) {
    const st = storm.snapshot();
    for (let i = 0; i < 64; i++) {
        const a = i / 64 * Math.PI * 2;
        const x = st.cx + Math.cos(a) * (st.r + extra), y = st.cy + Math.sin(a) * (st.r + extra);
        if (Math.hypot(x, y) < (grid.circleRadius || 2700) - 150) return { x, y, a };
    }
    return null;
}

test('storm: a protected player is hurt exactly as much, and the ramp climbs at the same pace', () => {
    storm.ensureActive();
    storm.debugSeek(150);       // shrinking, well short of the map edge
    try {
        const sp = stormSpot();
        assert.ok(sp, 'a stormed spot on the map');
        const p = spawn(0, sp.x, sp.y), v = spawn(120, sp.x, sp.y);
        for (const b of [p, v]) { bare(b); b.spawnGraceUntil = 0; }
        stampProtect(p, true); stampProtect(v, false);
        assert.equal(fair.isProtected(p), true);
        assert.equal(fair.isProtected(v), false);
        assert.equal(fair.stormEase, undefined, 'no storm ease');
        // the HUD multiplier
        p._stormExpMs = v._stormExpMs = 20_000;
        assert.equal(storm.exposureOf(p).mult, storm.exposureOf(v).mult);
        // one damage pass: the same share of max health, the same ramp
        p._stormExpMs = v._stormExpMs = 10_000;
        const t = Date.now();
        for (const b of [p, v]) { b._stormSeenAt = t - 200; b._stormHurtAt = 0; b.health.amount = b.health.max; b.shield.amount = 0; }
        storm.tickDamage(t);
        const lp = (p.health.max - p.health.amount) / p.health.max, lv = (v.health.max - v.health.amount) / v.health.max;
        assert.ok(lv > 0, 'the veteran took storm damage');
        assert.ok(Math.abs(lp - lv) < lv * 0.02, 'same share: ' + lp + ' vs ' + lv);
        assert.ok(Math.abs(p._stormExpMs - v._stormExpMs) < 1, 'same ramp');
        p.kill(); v.kill(); loop(2);
    } finally { storm.debugSeek(0); }
});

test('storm: eta lookup, and a human spawn lands where the storm is a while off', () => {
    storm.ensureActive();
    storm.debugSeek(200);
    try {
        const st = storm.snapshot();
        const eta = storm.etaFn(Date.now(), 120);
        assert.equal(eta(st.cx + st.r + 50, st.cy), 0, 'already in it');
        assert.equal(eta(st.cx, st.cy), 120, 'the middle: past the horizon');
        const near = eta(st.cx + st.r - 60, st.cy), mid = eta(st.cx + st.r - 400, st.cy);
        // (a storm holding between stages can leave both past the horizon)
        assert.ok(near <= mid, near + ' <= ' + mid);
        if (mid < 120) assert.ok(near < mid, near + ' < ' + mid);
        assert.ok(near >= 0 && (near < 30 || near === 120), 'the edge closes on a spot just inside');
        // picks: every human spot with an eta floor clears it
        assert.equal(fair.spawnEtaWant(true), T.SPAWN_ETA_S, 'the same for everyone');
        assert.equal(fair.spawnEtaWant(false), T.SPAWN_ETA_S);
        assert.equal(fair.spawnEtaWant(true, true), T.HOME_ETA_S);
        assert.equal(fair.spawnEtaWant(false, true), T.HOME_ETA_S);
        let worstWith = Infinity, worstWithout = Infinity;
        for (let i = 0; i < 12; i++) {
            const a = royale._safeSpawnSpot(null, false, T.SPAWN_ETA_S);
            const b = royale._safeSpawnSpot(null, false, 0);
            const e2 = storm.etaFn(Date.now(), 300);
            worstWith = Math.min(worstWith, e2(a.x, a.y));
            worstWithout = Math.min(worstWithout, e2(b.x, b.y));
        }
        assert.ok(worstWith >= T.SPAWN_ETA_S, 'worst pick ' + worstWith + ' s (no floor: ' + worstWithout + ' s)');
        fair.setSwitch('storm', false);
        try { assert.equal(fair.spawnEtaWant(true), 0); } finally { fair.setSwitch('storm', true); }
    } finally { storm.debugSeek(0); }
});

test('storm: a human walled in out in the storm gets a tunnel (the same rule for everyone)', () => {
    storm.ensureActive();
    storm.debugSeek(200);
    try {
        const st = storm.snapshot();
        // a solid-rock spot just outside the circle
        let spot = null;
        for (let i = 0; i < 128 && !spot; i++) {
            const a = i / 128 * Math.PI * 2;
            for (const ex of [120, 200, 280]) {
                const x = st.cx + Math.cos(a) * (st.r + ex), y = st.cy + Math.sin(a) * (st.r + ex);
                if (Math.hypot(x, y) > (grid.circleRadius || 2700) - 300) continue;
                const toward = { x: st.cx + Math.cos(a) * (st.r - 100), y: st.cy + Math.sin(a) * (st.r - 100) };
                if (grid.pointInRock(x, y) && grid.pointInRock((x + toward.x) / 2, (y + toward.y) / 2)) { spot = { x, y }; break; }
            }
        }
        if (!spot) { log('     (no walled-in spot on this map, skipped)'); return; }
        const FMw = royale.FIRST_MINUTES;
        assert.equal(FMw.WALLED_PROTECT_MIN_COST, undefined, 'no protected variant');
        assert.equal(FMw.WALLED_PROTECT_EVERY_MS, undefined);
        // (this map's walls are thin: test the mechanism at a low cost bar)
        const minCost0 = FMw.WALLED_MIN_COST;
        FMw.WALLED_MIN_COST = 0.5;
        try { walledCase(spot, st); } finally { FMw.WALLED_MIN_COST = minCost0; }
    } finally { storm.debugSeek(0); }
});
function walledCase(spot, st) {
    {
        const p = spawn(120, spot.x, spot.y);
        bare(p); stampProtect(p, false);
        p.x = spot.x; p.y = spot.y;
        const players = global.gameManager.socketManager.players;
        players.push(p.socket.player);
        for (const t = Date.now(); Date.now() - t < 20;);    // combatants() is cached per tick
        const t0 = Date.now();
        p.royaleBornAt = t0 - 120_000;       // long past the spawn window
        p._inStorm = true; p._walledSince = 0; p._walledAt = 0; p._rescueTryAt = 0;
        royale._tickSpawnRescue(t0);           // starts the clock
        assert.ok(!p._walledAt, 'not straight away');
        p._rescueTryAt = 0;
        royale._tickSpawnRescue(t0 + royale.FIRST_MINUTES.WALLED_AFTER_MS + 10);
        if (!(p._walledAt > 0)) {
            const sr = require(path.join(SERVER, 'game', 'terrain', 'spawnReach.js'));
            const w = grid._cellWorld || 110;
            const path2 = sr.exitPath(grid, p.x, p.y, { rescue: true, toZone: { x: st.cx, y: st.cy, r: Math.max(w, st.r - w * 1.5) }, maxCells: 10, now: Date.now() });
            log('     debug: prot', fair.isProtected(p), 'inStorm', p._inStorm, 'path', path2 && path2.length, 'alive', p.isDead && p.isDead(), 'at', Math.round(p.x), Math.round(p.y));
        }
        assert.ok(p._walledAt > 0, 'tunnelled');
        // not again until the cooldown
        const at = p._walledAt;
        p._rescueTryAt = 0;
        royale._tickSpawnRescue(at + 3000);
        assert.equal(p._walledAt, at);
        // the way in is open now
        const sr = require(path.join(SERVER, 'game', 'terrain', 'spawnReach.js'));
        const w = grid._cellWorld || 110;
        const left = sr.exitPath(grid, p.x, p.y, { rescue: true, toZone: { x: st.cx, y: st.cy, r: Math.max(w, st.r - w * 1.5) }, maxCells: 10, now: Date.now() });
        assert.ok(left && left.filter(r => r.alive).length === 0, 'no live rock left on the way in');
        players.splice(players.indexOf(p.socket.player), 1);
        p.kill(); loop(2);
    }
}

function stampProtect(p, prot) {
    // (protected on purpose: whatever the socket's clock says)
    if (prot && p.socket) p.socket._fpOut = '';
    fair.stamp(p, prot ? { stage: 0, newness: 1, struggle: 0 } : { stage: 3, newness: 0, struggle: 0 });
}

test('runaway: far ahead of every human; stops growing, gets ganged up on, leaves protected players be', () => {
    assert.equal(fair.isRunaway(14000, 731, true), true, 'the playtest: eli 14k vs 731');
    assert.equal(fair.isRunaway(14000, 731, false), false, 'nobody protected in the raid');
    assert.equal(fair.isRunaway(2000, 0, true), false, 'below RUNAWAY_MIN');
    assert.equal(fair.isRunaway(9000, 5000, true), false, 'a good human keeps it close');
    const G = ioTypes.digWarsGoals;
    // somewhere inside the circle and clear of every vault's ring
    const st = storm.snapshot();
    let x = st.cx, y = st.cy;
    for (let i = 0; i < 200; i++) {
        const a = i * 2.39996, d = 300 + (i % 10) * 120;
        const qx = st.cx + Math.cos(a) * d, qy = st.cy + Math.sin(a) * d;
        if (![-600, 0, 450].some(o => fair.inRing(qx + o, qy) || fair.vaultNear(qx + o, qy))) { x = qx; y = qy; break; }
    }
    const p = spawn(0, x, y);
    bare(p); stampProtect(p, true);
    const r = bot('basic', x + 450, y), other = bot('basic', x - 600, y);
    r.growthMult = 1.3;
    fair.stampRunaway(r, true);
    assert.equal(r.growthCap, 1.3, 'growth held');
    const cr = new G(r), co = new G(other);
    loop(2); waitScan();
    const now = Date.now();
    cr.senseAt = 0; cr.sense(now);
    assert.notEqual(cr.view.enemy, p, 'the runaway does not pick a protected player');
    assert.equal(cr.canInitiateFight(p, now), false, 'nor start on one');
    assert.equal(fair.aimMult(r, p, now), T.RUNAWAY_AIM, 'and aims worse at one (aim only)');
    assert.equal(fair.aimMult(other, p, now), 1, 'a normal bot aims normally');
    r._lastDamageSource = p; r._lastDamageAt = now; r._dmgBy = new Map([[p.id, r.health.max * 0.25]]); // round 9: 25% dealt
    assert.equal(fair.spared(r, p, now), false, 'shot by them: fights back');
    r._lastDamageSource = null; r._lastDamageAt = 0; r._dmgBy = null;
    // another bot takes it on at a worse trade than usual
    co.threatCache.clear();
    co.threatCache.set(r.id, { ratio: 1.2, until: Date.now() + 5000 });
    assert.equal(co.canInitiateFight(r, Date.now()), true, 'gang up');
    fair.stampRunaway(r, false);
    assert.equal(r.growthCap, 0, 'growth free again');
    co.threatCache.set(r.id, { ratio: 1.2, until: Date.now() + 5000 });
    assert.equal(co.canInitiateFight(r, Date.now()), false, 'a normal bot at that trade: no');
    // dig_royale stamps it from the board once a second (no board row: not a runaway)
    royale._stampRunaways([r, other]);
    assert.equal(!!r._fpRunaway, false);
    for (const o of [p, r, other]) o.kill();
    loop(2);
});

test('farming: a bot that keeps killing the same player leaves them be for a while', () => {
    const G = ioTypes.digWarsGoals;
    const st = storm.snapshot();
    const x = st.cx + 200, y = st.cy - 300;
    const p = spawn(0, x, y), v = spawn(120, x, y + 40);
    bare(p); bare(v);
    stampProtect(p, true); stampProtect(v, false);
    const b = bot('basic', x + 400, y);
    const c = new G(b);
    const t = Date.now();
    fair.noteBotKill(b, p, t, []);
    assert.equal(fair.farmed(b, p, t), false, 'once is a fight');
    fair.noteBotKill(b, p, t, []);
    assert.equal(fair.farmed(b, p, t), true, 'twice on a protected player');
    assert.equal(c.canInitiateFight(p, t), false);
    assert.equal(fair.farmed(b, p, t + T.FARM_MS + 1), false, 'wears off, the same window as anyone');
    assert.equal(T.FARM_PROTECT_MS, undefined, 'no longer window for protected players');
    b._lastDamageSource = p; b._lastDamageAt = t; b._dmgBy = new Map([[p.id, b.health.max * 0.25]]); // round 9: 25% dealt
    assert.equal(fair.farmed(b, p, t), false, 'they shoot it: fair fight');
    b._lastDamageSource = null; b._lastDamageAt = 0; b._dmgBy = null;
    fair.noteBotKill(b, v, t, []);
    assert.equal(fair.farmed(b, v, t), false, 'a veteran: once is a fight');
    fair.noteBotKill(b, v, t, []);
    assert.equal(fair.farmed(b, v, t), true, 'twice is farming, protected or not (round 4: shiny_wedge x3)');
    assert.equal(fair.farmed(b, v, t + T.FARM_MS + 1), false);
    for (const o of [p, v, b]) o.kill();
    loop(2);
});

test('farming: counted on the victim too (outlives the bot respawning), the next spawn keeps away, no chase, no director', () => {
    const G = ioTypes.digWarsGoals;
    const st = storm.snapshot();
    const x = st.cx - 200, y = st.cy + 300;
    const v = spawn(120, x, y);
    bare(v); stampProtect(v, false);
    const b = bot('basic', x + 500, y);
    b.botFamilyId = 4242;
    const t = Date.now();
    // the death hook (dig_royale onCombatantDead) books it on the victim's socket
    fair.noteKilledBy(v.socket, b, t - 200_000);
    fair.noteKilledBy(v.socket, b, t - 1000);
    assert.equal(fair.farmed(b, v, t), true, 'kills minutes apart still add up (FARM_COUNT_MS)');
    // the bot died and came back: a new entity, same family
    b.kill(); loop(1);
    const b2 = bot('basic', x + 500, y);
    b2.botFamilyId = 4242;
    assert.ok(!b2._fpKills);
    assert.equal(fair.farmed(b2, v, t), true, 'the same name coming back still leaves them be');
    const c2 = new G(b2);
    assert.equal(c2.canInitiateFight(v, t), false);
    // fighting back is allowed; once they stop shooting it lets them go
    b2._lastDamageSource = v; b2._lastDamageAt = t; b2._dmgBy = new Map([[v.id, b2.health.max * 0.25]]); // round 9: 25% dealt
    assert.equal(fair.farmed(b2, v, t), false, 'shot by them: fair fight');
    c2.goal = { kind: 'fight', target: v }; c2.goalStartedAt = t - 3000;
    b2._lastDamageAt = t - T.HIT_BACK_MS - 10;
    assert.equal(c2.stillValid(c2.goal, t), false, 'no chasing them down after');
    b2._lastDamageSource = null; b2._lastDamageAt = 0; b2._dmgBy = null;
    // the next respawn keeps FARM_SPAWN_R from it
    assert.deepEqual(fair.farmersOf(v, [b2], t), [b2]);
    const dg = royale._spawnDanger(v, [b2], t);
    assert.ok(dg && dg.near(b2.x + T.FARM_SPAWN_R - 100, b2.y), 'inside the keep-away');
    assert.equal(dg.near(b2.x + T.FARM_SPAWN_R + 100, b2.y), false);
    let worst = Infinity;
    for (let i = 0; i < 8; i++) {
        const h = royale._safeSpawnSpot(v, false, 0);
        worst = Math.min(worst, Math.hypot(h.x - b2.x, h.y - b2.y));
    }
    assert.ok(worst > 1200, 'respawns land well clear of it: closest ' + Math.round(worst));
    // a different bot is a different story
    const b3 = bot('basic', x + 600, y);
    assert.equal(fair.farmed(b3, v, t), false);
    // the director never sends the farmer their way
    for (const o of handler.bots) o._botDirectorUntil = Date.now() + 1e6;
    handler.bots.push(b2);
    b2._botDirectorUntil = 0; b2._botDirectorPoint = null; b2.x = x + 3000;
    handler.socketManagerPlayers = () => [v];
    try { handler.directorTick(); } finally { delete handler.socketManagerPlayers; handler.bots.splice(handler.bots.indexOf(b2), 1); }
    assert.ok(!b2._botDirectorPoint, 'not sent over');
    for (const o of [v, b2, b3]) o.kill();
    loop(2);
});

test('move on: a kill at a vault, the loot, then away and bank elsewhere', () => {
    const G = ioTypes.digWarsGoals;
    const b = bot('basic', V.x + 260, V.y);
    const victim = spawn(120, V.x + 320, V.y);
    const c = new G(b);
    const t = Date.now();
    fair.noteBotKill(b, victim, t);
    assert.ok(b._fpMoveOn, 'marked');
    assert.equal(fair.moveOnPoint(b, t + 1000), null, 'loot first');
    const mo = fair.moveOnPoint(b, t + T.MOVE_ON_LOOT_MS + 10);
    assert.ok(mo && Math.hypot(mo.x - V.x, mo.y - V.y) >= T.LEAVE_D - 1, 'then off');
    assert.equal(fair.avoidVault(b, V, t + 5000), true);
    assert.equal(fair.avoidVault(b, V, t + T.MOVE_ON_MS + 1), false);
    // the brain: an explore off the vault, ahead of banking
    gems.initSatchel(b); b.carriedGems = 500;
    b._fpMoveOn.lootUntil = 0;
    c.view.enemy = null; c.view.gem = null;
    const cand = c.candidate(Date.now());
    assert.equal(cand.kind, 'explore', 'moves on, does not bank here: ' + cand.kind);
    assert.ok(cand.vaultLeave);
    // far off: it banks, somewhere else if there is somewhere else
    b.x = mo.x; b.y = mo.y;
    assert.equal(fair.moveOnPoint(b, Date.now()), null);
    if (vault.getVaults().length > 1) assert.notEqual(c.ownVault(), V, 'banks elsewhere');
    // a kill away from every vault: nothing
    const b2 = bot('basic', V.x + 2600, V.y + 2600);
    const v2 = spawn(120, V.x + 2650, V.y + 2600);
    if (!fair.vaultNear(b2.x, b2.y) && !fair.inRing(b2.x, b2.y) && !fair.inRing(v2.x, v2.y)) {
        fair.noteBotKill(b2, v2, t);
        assert.equal(b2._fpMoveOn, undefined);
    }
    for (const o of [b, victim, b2, v2]) o.kill();
    loop(2);
});

test('duels: a small fish trades shots with a protected player; other bots stay out of it', () => {
    const G = ioTypes.digWarsGoals;
    const st = storm.snapshot();
    const x = st.cx - 300, y = st.cy + 200;
    const p = spawn(0, x, y);
    bare(p); stampProtect(p, true);
    const m = bot('basic', x + 400, y);
    fair.makeMinnow(m);
    const other = bot('basic', x - 450, y);
    const cm = new G(m), co = new G(other);
    loop(2); waitScan();
    const now = Date.now();
    assert.equal(fair.minnowDuel(m, p, now), true);
    cm.threatCache.set(p.id, { ratio: 3, until: now + 5000 });
    assert.equal(cm.feared(p, now), false, 'no fear');
    assert.equal(cm.canInitiateFight(p, now), true, 'takes them on even at a bad trade');
    // it holds on until MINNOW_DUEL_RETREAT
    cm.view.enemy = p; cm.view.enemyDistance = 400; cm.view.enemies = 1; cm.view.allies = 0;
    m.health.amount = m.health.max * 0.2;
    const cand = cm.candidate(now);
    assert.notEqual(cand.kind, 'survive', 'still in it at 20%: ' + cand.kind);
    m.health.amount = m.health.max * 0.05;
    assert.equal(cm.candidate(now).kind, 'survive', 'runs at 5%');
    m.health.amount = m.health.max;
    // the fight goal stays on through a bad trade, and others hold off
    cm.goal = { kind: 'fight', target: p }; cm.goalStartedAt = now - 5000;
    cm.fightMyHp = 1; cm.fightTheirHp = 1; m.health.amount = m.health.max * 0.5;
    assert.equal(cm.stillValid(cm.goal, now), true, 'no bailing');
    assert.ok(p._fpDuelUntil > now, 'the duel is marked');
    assert.equal(fair.spared(other, p, now), true, 'others hold off');
    assert.equal(fair.spared(m, p, now), false, 'the fish itself is in it');
    co.senseAt = 0; co.sense(now + 300);
    assert.notEqual(co.view.enemy, p, 'another bot does not pick them mid-duel');
    assert.equal(fair.spared(other, p, now + T.DUEL_MS + 10), false, 'over after DUEL_MS');
    // far apart: no duel
    m.x = x + 2000;
    assert.equal(fair.minnowDuel(m, p, now), false);
    for (const o of [p, m, other]) o.kill();
    loop(2);
});

test('tags: a tank far beyond a protected player is flagged TOO STRONG, never their own', () => {
    const viewer = { id: 1 };
    const big = { id: 2, growthMult: 2 };
    assert.equal(fair.tooStrong(true, big, 500, 4000, 0, viewer), true, 'grown and far ahead');
    assert.equal(fair.tooStrong(false, big, 500, 4000, 0, viewer), false, 'a veteran sees the plain tag');
    assert.equal(fair.tooStrong(true, viewer, 500, 4000, 0, viewer), false, 'never your own tank');
    assert.equal(fair.tooStrong(true, { id: 3 }, 500, 3000, 0, viewer), true, '3x the points');
    assert.equal(fair.tooStrong(true, { id: 3 }, 500, 900, 0, viewer), false, 'within reach');
    assert.equal(fair.tooStrong(true, { id: 4 }, 1000, 1100, 9, viewer), false, 'level on the board, whatever the streak');
    assert.equal(fair.tooStrong(true, { id: 4 }, 200, 1100, 4, viewer), true, 'a 4 streak far ahead');
    assert.equal(fair.tooStrong(true, { id: 5, isRoyaleBoss: true }, 0, 9000, 0, viewer), false, 'not a boss');
    const src = require('fs').readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.ok(/fairPlay\.tooStrong/.test(src) && /revenge\.tough = 1/.test(src) && /bountyTough = 1/.test(src), 'dig_royale sends the flags');
    assert.ok(/tooStrong:\s*\(body, e\)/.test(src), 'and no take-them-down contract on them');
});

// somewhere inside the circle, clear of every vault's ring along +x
function clearSpot(span = 600) {
    const st = storm.snapshot();
    for (let i = 0; i < 300; i++) {
        const a = i * 2.39996, d = 200 + (i % 12) * 90;
        const qx = st.cx + Math.cos(a) * d, qy = st.cy + Math.sin(a) * d;
        let ok = true;
        for (let o = -400; o <= span; o += 200) if (fair.inRing(qx + o, qy) || fair.vaultNear(qx + o, qy)) { ok = false; break; }
        if (ok) return { x: qx, y: qy };
    }
    return { x: st.cx, y: st.cy };
}

test('first kill: a small fish is sent to a player with no kill yet, plays them like a beginner, their first kill ends it', () => {
    const G = ioTypes.digWarsGoals;
    const { x, y } = clearSpot(1200);
    const h = spawn(0, x, y);
    bare(h);
    fair.stamp(h, { stage: 0, newness: 1, struggle: 0, raid: 77 });
    assert.equal(h._fpFirst, true, 'no kill this raid, protected: due');
    // who is due: protected with no kill this raid; a guest with none this session
    const s1 = fakeSocket(0); fair.noteKill(s1, 1);
    assert.equal(fair.firstKillDue(s1, true, 2), true, 'a kill last raid: due again this raid');
    assert.equal(fair.firstKillDue(s1, false, 2), false, 'a guest who has had one before, not protected');
    assert.equal(fair.firstKillDue(fakeSocket(0), false, 2), true, 'a guest who never has');
    assert.equal(fair.firstKillDue(fakeSocket(0, { account: { id: 5 } }), false, 2), false, 'a signed-in veteran');
    const m = bot('basic', x + 1100, y); fair.makeMinnow(m); m.botArmed = true;
    const big = bot('basic', x + 300, y); big.growthMult = 2; big.botArmed = true;
    const other = bot('basic', x - 500, y); other.botArmed = true;
    const t = Date.now();
    h.royaleBornAt = t - 5000;
    fair.tickFirstKill([h], [big, m, other], t, () => 0);
    assert.ok(!m._fpBait, 'not in the first seconds of a life');
    h.royaleBornAt = t - T.FIRST_AFTER_MS - 1;
    fair.tickFirstKill([h], [big, m, other], t, () => 0);
    assert.ok(m._fpBait, 'the small fish is picked');
    assert.ok(!big._fpBait && !other._fpBait, 'never a grown bot, and only one');
    assert.equal(h._fpBaitBot, m);
    assert.equal(fair.baitHost(m, t), h);
    // the brain: in it with them, no running off
    const cm = new G(m), co = new G(other);
    loop(2); waitScan();
    let now = Date.now();
    cm.view.enemy = h; cm.view.enemyDistance = 1100; cm.view.enemies = 1; cm.view.allies = 0;
    assert.equal(cm.candidate(now).kind, 'fight', 'takes them on');
    m.health.amount = m.health.max * 0.05;
    assert.equal(cm.candidate(now).kind, 'fight', 'no running at 5%');
    m.health.amount = m.health.max;
    m.x = x + T.FIRST_FIGHT_R + 200;
    const far = cm.candidate(now);
    assert.equal(far.kind, 'explore', 'walks over from further off');
    assert.ok(Math.hypot(far.point.x - h.x, far.point.y - h.y) < Math.hypot(m.x - h.x, m.y - h.y));
    m.x = x + 600;
    // other bots stay out of it: they leave the host to the fish, and the fish to the host
    assert.equal(fair.baitBusy(h, other), true, 'the fish is close');
    assert.equal(fair.spared(other, h, now), true, 'nobody bails the fish out');
    assert.equal(fair.spared(m, h, now), false, 'the fish itself takes them on');
    assert.equal(co.canInitiateFight(m, now), false, 'other bots leave the fish on duty to its host (bot-vs-bot only)');
    // every shot lands as dealt: no bait damage factors, no minimum chunk
    assert.equal(fair.baitShotMult, undefined, 'no bait damage factors');
    assert.equal(fair.baitTaken, undefined, 'no minimum chunk');
    const shell = (who) => ({ master: who });
    const hostIntoFish = shotMult(shell(h), m), otherIntoFish = shotMult(shell(other), m);
    const fishIntoHost = shotMult(shell(m), h), otherIntoHost = shotMult(shell(other), h);
    assert.equal(fishIntoHost, otherIntoHost, 'the fish hits the host like any bot');
    assert.equal(hostIntoFish, shotMult(shell(h), other), 'the host hits the fish like any bot');
    void otherIntoFish;
    // its aim at the host is a beginner's (aim error up), at anyone else its own
    cm.leadAim(h, now);
    assert.equal(cm._aimErrMult, T.FIRST_AIM_ERR, 'sloppier aim at its host');
    cm.leadAim(other, now);
    assert.equal(cm._aimErrMult, 1, 'its own aim at others');
    // short bursts with long gaps at its host
    cm.burstUntil = 0;
    cm.triggerHeld(now, h);
    const gap = cm.pauseUntil - now;
    assert.ok(gap >= T.FIRST_PAUSE_MS[0] - 1 && gap <= T.FIRST_PAUSE_MS[1] + 1, 'trigger gap ' + gap);
    // their first kill: it lets go and is a plain small fish again
    fair.noteKill(h.socket, 77);
    assert.equal(h._fpFirst, false);
    fair.tickFirstKill([h], [big, m, other], Date.now(), () => 0);
    assert.ok(!m._fpBait && !h._fpBaitBot, 'released');
    // switched off: nothing
    const h2 = spawn(0, x, y + 300); bare(h2);
    fair.stamp(h2, { stage: 0, newness: 1, struggle: 0, raid: 77 });
    h2.royaleBornAt = Date.now() - T.FIRST_AFTER_MS - 1;
    fair.setSwitch('first', false);
    try {
        fair.stamp(h2, { stage: 0, newness: 1, struggle: 0, raid: 77 });
        fair.tickFirstKill([h2], [m, other], Date.now(), () => 0);
        assert.ok(!m._fpBait && !other._fpBait, 'ROYALE_FAIR_FIRST_KILL=0');
    } finally { fair.setSwitch('first', true); }
    // a bait that dies: another one, after FIRST_RETRY_MS
    fair.stamp(h2, { stage: 0, newness: 1, struggle: 0, raid: 77 });
    fair.tickFirstKill([h2], [m, other], Date.now(), () => 0);
    assert.ok(m._fpBait, 'm again');
    m.kill(); loop(1);
    fair.tickFirstKill([h2], [other], Date.now(), () => 0);
    assert.ok(!other._fpBait, 'not straight away');
    fair.tickFirstKill([h2], [other], Date.now() + T.FIRST_RETRY_MS + 10, () => 0);
    assert.ok(other._fpBait, 'then the next one');
    for (const o of [h, h2, big, other]) o.kill();
    loop(2);
});

test('bosses: spawns keep off a live boss and its drones; its brood goes with it on a new raid', () => {
    const bosses = require(path.join(SERVER, 'game', 'terrain', 'bosses.js'));
    storm.ensureActive();
    const st = storm.snapshot();
    const boss = bosses.spawn('warden');
    assert.ok(boss, 'a boss');
    boss.x = st.cx + 150; boss.y = st.cy;
    const drone = new Entity({ x: st.cx - 700, y: st.cy + 200 });
    drone.define('drone'); drone.master = boss; drone.source = boss; drone.alwaysActive = true;
    try {
        const zones = fair.bossZones(boss, entities.values());
        assert.ok(zones.length >= 2, 'the boss and its drone');
        assert.ok(fair.inZones(zones, boss.x + T.BOSS_SPAWN_R - 50, boss.y));
        assert.ok(fair.inZones(zones, drone.x + T.MINION_SPAWN_R - 50, drone.y), 'its drone too');
        const h = spawn(120, st.cx + 1500, st.cy); bare(h);
        const dg = royale._spawnDanger(h, [], Date.now());
        assert.ok(dg && dg.near(boss.x + 400, boss.y), 'a human respawn (vault / action spots go through this)');
        let worstB = Infinity, worstD = Infinity;
        for (let i = 0; i < 10; i++) {
            for (const forBot of [false, true]) {
                const p = royale._safeSpawnSpot(forBot ? null : h, forBot, 0);
                worstB = Math.min(worstB, Math.hypot(p.x - boss.x, p.y - boss.y));
                worstD = Math.min(worstD, Math.hypot(p.x - drone.x, p.y - drone.y));
            }
        }
        assert.ok(worstB > T.BOSS_SPAWN_R * 0.9, 'closest to the boss ' + Math.round(worstB));
        assert.ok(worstD > T.MINION_SPAWN_R * 0.9, 'closest to its drone ' + Math.round(worstD));
        fair.setSwitch('bossSpawn', false);
        try { assert.equal(fair.bossZones(boss, entities.values()).length, 0); } finally { fair.setSwitch('bossSpawn', true); }
        h.kill();
    } finally {
        bosses.resetRaid();
        loop(2);
    }
    assert.ok(drone.isDead() || !entities.has(drone.id), 'the drone went with the boss');
    assert.equal(bosses.current(), null);
});

// ── the duel sim: a beginner with a bad aim against their small fish ───
// No rigging any more: the fish fights with its own aim and damage. A
// beginner whose 50 points were placed (by them, or by autoStats after
// 20 s) should still win most of these; one with no points at all mostly
// can't, which is why autoStats exists.
// On a fake clock (Date.now is stepped 33 ms a tick, and keeps running
// forward afterwards), the player re-aims every 120 ms (a 7-17 fps client),
// half of those right on the fish and half well wide, walks at it when it's
// off screen and otherwise stands and shoots.
test('first kill sim: a bad-aim Basic on the auto build beats its small fish in a fair fight', () => {
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => fake;
    const grid = global.gameManager.terrainGrid;
    let ticks = 0;
    const step = (n) => {
        for (let i = 0; i < n; i++) {
            fake += 1000 / 30;
            handler.gameloop();
            if (++ticks % 6 === 0) { try { handler.quickMaintainLoop(); } catch { /* */ } }
            if (ticks % 3 === 0) handler.regenHealthAndShield();
        }
    };
    const clear = (x, y, R) => {
        for (const rk of grid.rocks.values()) {
            if (!rk.alive) continue;
            const cx = rk.worldCx || rk.wx, cy = rk.worldCy || rk.wy;
            if (Math.hypot(cx - x, cy - y) < R) grid.damageRock(rk, rk.health + 1e9, cx, cy, false, null);
        }
        if (grid.addNoRegrowZone) grid.addNoRegrowZone(x, y, R, fake + 1e9);
    };
    const sm = global.gameManager.socketManager;
    const savedMods = global.royaleMods;
    global.royaleMods = {};
    const duel = (cls, raw) => {
        const o = clearSpot(900);
        clear(o.x + 250, o.y, 900);
        const s = fakeSocket(0);
        const pl = { socket: s, command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, autofire: 0 }, target: { x: 100, y: 0 } };
        const p = new Entity({ x: o.x, y: o.y });
        p.define(cls); p.isPlayer = true; p.team = -7; p.name = 'Newbie'; p.alwaysActive = true;
        p.socket = s; s.player = pl; pl.body = p; p.become(pl); p.reverseTank = 1; p.sendMessage = () => {};
        while (p.skill.level < 45) { p.skill.score += p.skill.levelScore; p.skill.maintain(); }
        p.skill.set(raw); p.refreshBodyAttributes();
        p.invuln = false; p.spawnGraceUntil = 0; bare(p); p.botNewbie = true;
        gems.initSatchel(p); p.carriedGems = 0;
        fair.stamp(p, { stage: 0, newness: 1, struggle: 0, raid: 900 });
        p.royaleBornAt = fake - T.FIRST_AFTER_MS - 1;
        sm.players = [pl]; sm.clients = [s];
        const before = handler.bots.length;
        handler.spawnBots({ x: o.x + 520, y: o.y }, -770 - (ids++ & 0xff), null, { respawnsRemaining: 0, minnow: true });
        const m = handler.bots[before];
        m.botGraceUntil = 0; m.botWakeAt = 0;
        step(90);
        handler.armBot(m); m.invuln = false; m.spawnGraceUntil = 0;
        fair.tickFirstKill([p], [m], fake, () => 0);
        assert.equal(m._fpBait && fair.baitHost(m, fake), p, 'assigned through the tick');
        const t0 = fake;
        let aimOff = 0, aimAt = 0, low = 1, end = 'timeout';
        while (fake - t0 < 60_000) {
            if (m.isDead()) { end = 'won'; break; }
            if (p.isDead()) { end = 'lost'; break; }
            if (fake >= aimAt) {
                aimAt = fake + 120;
                aimOff = Math.random() < 0.5 ? (Math.random() - 0.5) * 0.06 : (Math.random() < 0.5 ? -1 : 1) * (0.22 + Math.random() * 0.4);
            }
            const dx = m.x - p.x, dy = m.y - p.y, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx) + aimOff;
            pl.target = { x: Math.cos(a) * d, y: Math.sin(a) * d };
            pl.command.lmb = 1;
            const go = d > 250;
            pl.command.right = go && dx > 60 ? 1 : 0; pl.command.left = go && dx < -60 ? 1 : 0;
            pl.command.down = go && dy > 60 ? 1 : 0; pl.command.up = go && dy < -60 ? 1 : 0;
            low = Math.min(low, (p.health.amount + p.shield.amount) / (p.health.max + p.shield.max));
            if (ticks % 30 === 0) fair.tickFirstKill([p], [m], fake, () => 0);
            step(1);
        }
        const r = { end, secs: (fake - t0) / 1000, low, fish: m.label };
        sm.players = []; sm.clients = [];
        try { p.kill(); } catch { /* */ } try { m.kill(); } catch { /* */ }
        step(5);
        return r;
    };
    const runs = (cls, raw, n) => { const out = []; for (let i = 0; i < n; i++) out.push(duel(cls, raw)); return out; };
    const sum = (rs) => {
        const won = rs.filter(r => r.end === 'won'), lost = rs.filter(r => r.end === 'lost');
        const ks = won.map(r => r.secs).sort((a, b) => a - b);
        return { won: won.length, lost: lost.length, n: rs.length, median: ks.length ? ks[ks.length >> 1] : NaN,
            line: rs.map(r => r.end + ' ' + r.secs.toFixed(1) + 's low ' + r.low.toFixed(2) + ' (' + r.fish + ')').join('; ') };
    };
    try {
        // the build autoStats places for someone who never opened the stat bar
        const autoStats = require(path.join(SERVER, 'game', 'terrain', 'autoStats.js'));
        const built = autoStats.placeBuild(Array(11).fill(0), 50, Array(11).fill(9)).raw;
        const auto = sum(runs('basic', built, 4));
        log('     basic, auto build: won ' + auto.won + '/' + auto.n + ', median ' + auto.median.toFixed(1) + ' s :: ' + auto.line);
        assert.ok(auto.won >= 2, 'basic on the auto build: ' + auto.line);
        // one who never touched the stat bar: shown, not asserted (the root
        // cause of "new players do really low damage")
        const bare0 = sum(runs('basic', Array(11).fill(0), 2));
        log('     basic, no points: won ' + bare0.won + '/' + bare0.n + ' :: ' + bare0.line);
    } finally {
        global.royaleMods = savedMods;
        const off = fake - realNow();
        Date.now = () => realNow() + off;
    }
});

// ── round 5: late-raid respawns ────────────────────────────────────────
const quietVein = require(path.join(SERVER, 'game', 'terrain', 'quietVein.js'));
const freshCombatants = () => { const u = Date.now() + 25; while (Date.now() < u) { /* combatants() caches 16 ms */ } };
// safeSpawnSpot sees bots through the handler's list
const enlist = (...bs) => { for (const b of bs) handler.bots.push(b); };
const delist = (...bs) => { for (const b of bs) { const i = handler.bots.indexOf(b); if (i >= 0) handler.bots.splice(i, 1); } };
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };

test('safe spawn: a screen from the last two killers (all raid), 2x-score tanks and a held vault', () => {
    storm.ensureActive();
    storm.debugSeek(0);
    const st = storm.snapshot();
    const raid = royale._raidId();
    const me = spawn(120, st.cx, st.cy); bare(me); stampProtect(me, false);
    const t = Date.now();
    // gemme41 killed them 7.5 minutes ago, and someone else just now: one
    // kill each, so neither is a farmer, but both are their last killers
    // (all on the east side, so the west of a full circle clears them all)
    const k1 = bot('basic', st.cx + 700, st.cy); k1.botFamilyId = 5101;
    const k2 = bot('basic', st.cx + 900, st.cy + 300); k2.botFamilyId = 5102;
    fair.noteKilledBy(me.socket, k1, t - 450_000, raid);
    fair.noteKilledBy(me.socket, k2, t - 1000, raid);
    assert.equal(fair.farmersOf(me, [k1, k2], t).length, 0, 'one kill each: not farming');
    assert.deepEqual(fair.lastKillersOf(me, [k1, k2], raid), [k1, k2]);
    // a third killer pushes the oldest out
    const k0 = bot('basic', st.cx + 2200, st.cy); k0.botFamilyId = 5100;
    // (the list keeps the last two; re-noting k1 and k2 after k0 keeps them)
    fair.noteKilledBy(me.socket, k0, t - 500_000, raid);
    fair.noteKilledBy(me.socket, k1, t - 450_000, raid);
    fair.noteKilledBy(me.socket, k2, t - 1000, raid);
    assert.deepEqual(fair.lastKillersOf(me, [k0, k1, k2], raid).map(b => b.botFamilyId), [5101, 5102]);
    assert.equal(fair.lastKillersOf(me, [k1], raid + 1).length, 0, 'a new raid starts clean');
    // a grown tank, and twice your points
    const g = bot('basic', st.cx + 800, st.cy - 300); g.growthMult = 1.9;
    assert.equal(fair.bigThreat(2000, 1, 4100, 1), true, 'twice your points');
    assert.equal(fair.bigThreat(2000, 1, 2500, 1), false, 'a bit ahead of you');
    assert.equal(fair.bigThreat(0, 1, 1000, 1), false, 'a small score is no threat, even at 0');
    const keep = fair.spawnKeep(false).r;
    assert.ok(keep >= 1600, 'about a screen: ' + keep);
    assert.deepEqual(fair.spawnKeep(true), fair.spawnKeep(false), 'the same room for everyone');
    enlist(k0, k1, k2, g);
    try {
        freshCombatants();
        const dg = royale._spawnDanger(me, [k1, k2, g], t);
        assert.ok(dg && dg.killers.has(k1) && dg.killers.has(k2) && dg.set.has(g));
        assert.equal(dg.near(k1.x + keep - 100, k1.y), true, 'inside the room from a killer');
        assert.ok(dg.deficit(k1.x + 200, k1.y) > dg.deficit(g.x + 200, g.y), 'a killer outweighs a big tank');
        assert.equal(dg.homeBad(k2.x + 300, k2.y), true, 'no base respawn next to a killer either');
        let worst = Infinity;
        for (let i = 0; i < 12; i++) {
            const h = royale._safeSpawnSpot(me, false, 0);
            worst = Math.min(worst, ...[k1, k2, g].map(b => Math.hypot(h.x - b.x, h.y - b.y)));
        }
        assert.ok(worst >= keep * 0.97, 'a full circle: every respawn a screen clear, closest ' + Math.round(worst));
        // a vault an enemy is standing on: the vault picker goes elsewhere
        const occ = bot('basic', V.x + 40, V.y);
        freshCombatants();
        const dg2 = royale._spawnDanger(me, [occ], Date.now());
        assert.ok(dg2 && dg2.occ.includes(V), 'the held vault');
        assert.equal(dg2.near(V.x + 700, V.y + 300), true, 'near it is out');
        const dropIn = require(path.join(SERVER, 'game', 'terrain', 'dropIn.js'));
        for (let i = 0; i < 6; i++) {
            const vs = dropIn.vaultSpot(me, [occ], Date.now(), 0, dg2.near);
            if (vs) assert.ok(Math.hypot(vs.x - V.x, vs.y - V.y) >= T.VAULT_OCC_SPAWN_R, 'a first-bank landing away from the held vault');
        }
        occ.kill();
        // the switch off: round 4's rule (900 from big tanks, no killer list)
        fair.setSwitch('spawnSafe', false);
        try {
            assert.equal(fair.spawnKeep(false).r, T.SPAWN_BIG_R);
            assert.equal(fair.lastKillersOf(me, [k1, k2], raid).length, 0);
        } finally { fair.setSwitch('spawnSafe', true); }
    } finally {
        delist(k0, k1, k2, g);
        for (const o of [me, k0, k1, k2, g]) o.kill();
        loop(2);
    }
});

test('safe spawn: a small late circle relaxes big tanks before killers, and never the storm', () => {
    storm.ensureActive();
    storm.debugSeek(250);
    try {
        const st = storm.snapshot();
        const raid = royale._raidId();
        const me = spawn(120, st.cx, st.cy); bare(me); stampProtect(me, false);
        const off = Math.max(250, st.r * 0.45);
        const killer = bot('basic', st.cx + off, st.cy); killer.botFamilyId = 5201;
        const big = bot('basic', st.cx - off, st.cy); big.growthMult = 1.9;
        fair.noteKilledBy(me.socket, killer, Date.now() - 1000, raid);
        const dK = [], dB = [];
        enlist(killer, big);
        try {
            freshCombatants();
            for (let i = 0; i < 14; i++) {
                const h = royale._safeSpawnSpot(me, false, 0);
                assert.equal(storm.inStorm(h.x, h.y), false, 'never in the storm: ' + Math.round(h.x) + ',' + Math.round(h.y));
                dK.push(Math.hypot(h.x - killer.x, h.y - killer.y));
                dB.push(Math.hypot(h.x - big.x, h.y - big.y));
            }
            log('     circle r ' + Math.round(st.r) + ': median from killer ' + Math.round(median(dK)) + ', from big tank ' + Math.round(median(dB)));
            assert.ok(median(dK) > median(dB), 'leans away from the killer: ' + Math.round(median(dK)) + ' vs ' + Math.round(median(dB)));
        } finally {
            delist(killer, big);
            for (const o of [me, killer, big]) o.kill();
            loop(2);
        }
    } finally { storm.debugSeek(0); }
});

test('spawn shield: every respawn is shielded, bots ignore it, damage does not land', () => {
    const G = ioTypes.digWarsGoals;
    const st = storm.snapshot();
    const sock = fakeSocket(120);
    sock.lastRaidDeathAt = Date.now() - 5000;     // a respawn, not a first drop
    const p = spawn(120, st.cx + 100, st.cy + 100, sock);
    try {
        assert.equal(p.invuln, true, 'shielded');
        assert.ok(p.spawnGraceUntil - Date.now() > 3000, 'for the grace window');
        const b = bot('basic', p.x + 300, p.y);
        const c = new G(b);
        assert.equal(c.isEnemy(p), false, 'bots do not count a shielded spawn as an enemy');
        p.botGraceUntil = 0; p.botSoftUntil = 0;
        assert.equal(c.isEnemy(p), false, 'grace or not, the shield keeps them off');
        const hp = p.health.amount;
        p.damageReceived = 150;
        p.contemplationOfMortality();
        assert.equal(p.health.amount, hp, 'a shot that lands anyway does nothing');
        p.invuln = false;
        assert.equal(c.isEnemy(p), true, 'shield gone: fair game');
        b.kill();
    } finally { p.kill(); loop(2); }
});

test('fodder: a first-kill fish stays a small fish all raid and never comes back for its host; a beaten bot leaves a protected player be', () => {
    const G = ioTypes.digWarsGoals;
    const bosses = require(path.join(SERVER, 'game', 'terrain', 'bosses.js'));
    const st = storm.snapshot();
    fair.newRaid();
    const h = spawn(0, st.cx + 200, st.cy); bare(h); stampProtect(h, false);
    const fish = bot('basic', h.x + 500, h.y); fish.botFamilyId = 5301;
    const t = Date.now();
    assert.ok(fair.assignBait(fish, h, t));
    assert.equal(fair.isFodder(fish), true);
    assert.ok(fish.growthCap > 0 && fish.growthCap <= T.MINNOW_GROWTH_CAP, 'growth capped');
    fair.releaseBait(fish);
    fish.kill(); loop(1);
    // the same name comes back
    const back = bot('basic', h.x + 600, h.y); back.botFamilyId = 5301;
    royale.freshRaidBody(back);
    const boss = bosses.spawn('warden');
    try {
        assert.equal(back._fpFodder, true, 'still fodder after a respawn');
        assert.equal(back.botMinnow, true);
        back.growthMult = 1.6;
        assert.equal(fair.isBig(back), false, 'never a big tank to the rules');
        assert.ok(back.growthCap <= T.MINNOW_GROWTH_CAP);
        assert.equal(fair.fodderShare(back), T.FODDER_PTS, 'books a small share');
        // it never starts on its host again this raid (unless shot)
        const c = new G(back);
        bare(h);
        assert.equal(fair.beatBy(back, h), true, 'on the beaten-by list');
        assert.equal(fair.spared(back, h, Date.now()), true, 'leaves its old host be');
        assert.equal(c.canInitiateFight(h, Date.now()), false);
        // a protected player who beats a bot: that family leaves them be all raid
        const p2 = spawn(0, st.cx - 300, st.cy); bare(p2); stampProtect(p2, true);
        const v2 = spawn(120, st.cx - 300, st.cy + 60); bare(v2); stampProtect(v2, false);
        const b2 = bot('basic', p2.x + 400, p2.y); b2.botFamilyId = 5302;
        assert.equal(fair.noteBeat(p2, b2), true);
        assert.equal(fair.noteBeat(v2, b2), false, 'a veteran beating a regular bot: nothing');
        const b2back = bot('basic', p2.x + 450, p2.y); b2back.botFamilyId = 5302;
        assert.equal(fair.spared(b2back, p2, Date.now()), true, 'the family stays off them');
        // round 8: until they earn out of protection
        p2.socket._fpOut = 'kills'; stampProtect(p2, false);
        assert.equal(fair.spared(b2back, p2, Date.now()), false, 'earned out: the family may come back');
        stampProtect(p2, true);
        assert.equal(fair.spared(b2back, v2, Date.now()), false);
        b2back._lastDamageSource = p2; b2back._lastDamageAt = Date.now(); b2back._dmgBy = new Map([[p2.id, b2back.health.max * 0.25]]); // round 9: 25% dealt
        assert.equal(fair.spared(b2back, p2, Date.now()), false, 'shot by them: fights back');
        for (const o of [p2, v2, b2, b2back]) o.kill();
        // and leaves the boss to others
        boss.x = back.x + 400; boss.y = back.y; boss.hitAt = Date.now();
        const reg = bot('basic', back.x, back.y + 200);
        reg.health.amount = reg.health.max;
        const cr = new G(reg);
        assert.equal(cr.bossToHunt(Date.now(), 1), boss, 'a regular bot goes for an engaged boss');
        back._botBossHuntUntil = 0;
        assert.equal(c.bossToHunt(Date.now(), 1), null, 'the fish never does');
        reg.kill();
        // a new raid forgets it all; the switch turns it off
        fair.setSwitch('fodder', false);
        try { assert.equal(fair.isFodder(back), false); assert.equal(fair.fodderShare(back), 1); } finally { fair.setSwitch('fodder', true); }
        fair.newRaid();
        assert.equal(fair.isFodder(back), false);
    } finally {
        for (const o of [h, back]) o.kill();
        bosses.resetRaid();
        loop(2);
    }
});

test('quiet vein: a player with flat points for 70 s gets a rich vein close by', () => {
    const sock = fakeSocket(120);
    const st = storm.snapshot();
    const p = player(sock, st.cx, st.cy);
    p.royaleBornAt = Date.now() - 200_000;
    let score = 500;
    const fired = [];
    const fire = (b) => { fired.push(b); return { x: b.x + 400, y: b.y }; };
    const t0 = Date.now();
    try {
        assert.equal(quietVein.tick([p], () => score, 7, t0, fire), 0, 'first look');
        assert.equal(quietVein.tick([p], () => score, 7, t0 + 40_000, fire), 0, 'not yet');
        score = 650;
        assert.equal(quietVein.tick([p], () => score, 7, t0 + 60_000, fire), 0, 'points moved: clock restarts');
        assert.equal(quietVein.tick([p], () => score, 7, t0 + 100_000, fire), 0);
        sock.lastInputAt = t0 + 129_000;
        assert.equal(quietVein.tick([p], () => score, 7, t0 + 131_000, fire), 1, 'quiet for 71 s: a vein');
        assert.ok(msgs(sock).some(m => /Rich vein close by, to your east/.test(m)), msgs(sock).join(' | '));
        assert.equal(quietVein.tick([p], () => score, 7, t0 + 210_000, fire), 0, 'cooldown');
        // fighting is not a dead stretch
        p._lastDamageAt = t0 + 295_000;
        sock.lastInputAt = t0 + 300_000;
        assert.equal(quietVein.tick([p], () => score, 7, t0 + 300_000, fire), 0, 'in a fight');
        quietVein.setEnabled(false);
        try { assert.equal(quietVein.tick([p], () => score, 7, t0 + 900_000, fire), 0, 'switch off'); } finally { quietVein.setEnabled(true); }
        // the real placement puts ore near them
        const nd = require(path.join(SERVER, 'game', 'terrain', 'newcomerDirector.js'));
        const ev = nd.fireOre(p, Date.now());
        if (ev) assert.ok(Math.hypot(ev.x - p.x, ev.y - p.y) < 900 && ev.rocks.length >= 1, 'within reach');
    } finally { p.kill(); loop(1); }
});

test('earned out: kills, a streak, points, the top half, banks or 12 minutes end protection for the session, mid-life', () => {
    const E = fair.earnedOut;
    assert.equal(E({}), '', 'nothing yet');
    assert.equal(E({ raidKills: T.OUT_KILLS - 1, streak: T.OUT_STREAK - 1, points: T.OUT_POINTS - 1, banks: T.OUT_BANKS - 1, playMs: T.OUT_PLAY_MS - 1 }), '', 'just under each');
    assert.equal(E({ raidKills: 3 }), 'kills');
    assert.equal(E({ streak: 3 }), 'streak');
    assert.equal(E({ points: 2500 }), 'points');
    assert.equal(E({ points: 700, rank: 2, rows: 6 }), 'board', 'top half of six');
    assert.equal(E({ points: 700, rank: 4, rows: 6 }), '', 'bottom half');
    assert.equal(E({ points: 300, rank: 1, rows: 6 }), '', 'top of an empty board is not enough');
    assert.equal(E({ points: 700, rank: 1, rows: 3 }), '', 'too few on the board');
    assert.equal(E({ banks: 3 }), 'banks');
    assert.equal(E({ playMs: 12 * MIN }), 'time');
    assert.deepEqual([T.OUT_KILLS, T.OUT_STREAK, T.OUT_POINTS, T.OUT_BANKS, T.OUT_PLAY_MS], [3, 3, 2500, 3, 12 * MIN], 'the numbers');
    assert.equal(fair.protects({ stage: 0, newness: 1, struggle: 5, out: true }), false, 'out beats every reason');

    // a guest 30 minutes in: never protected, struggling or not, and not new
    const g = fakeSocket(30, { _careerLives: 1 });
    const gp = spawn(30, 0, -2000, g);
    assert.equal(gp._fpProtect, false, '30 minutes in: not protected');
    assert.equal(g._fpOut, 'time');
    assert.equal(gp.botNewbie, false);
    assert.ok(gp.botGraceUntil - Date.now() <= royale.FIRST_MINUTES.BOT_GRACE_MS + 50, 'the everyday bot grace');
    royale.onBanked(gp, 1);
    Object.assign(g._fp, { deaths: 6, kills: 0, banked: 0 });
    royale._stampBotDifficulty(gp);
    assert.equal(gp._fpProtect, false, 'still not, after a losing run');
    assert.ok(gp.botDifficulty > 0.5, 'and no losing-streak cap: ' + gp.botDifficulty);

    // a brand new player: protected, then 3 kills mid-life and it's gone
    const ns = fakeSocket(0, { _careerLives: 0 });
    const np = spawn(0, 0, -2000, ns);
    royale._stampBotDifficulty(np);
    assert.equal(np._fpProtect, true, 'brand new');
    assert.equal(np.botNewbie, true);
    assert.ok(np.botSoftUntil - Date.now() > 60_000, 'a long soft window');
    for (let i = 0; i < 3; i++) fair.noteKill(ns, royale._raidId());
    royale._stampBotDifficulty(np);
    assert.equal(np._fpProtect, false, '3 kills: out, in the same life');
    assert.equal(ns._fpOut, 'kills');
    assert.equal(np.botNewbie, false, 'not a newbie to the bots either');
    assert.ok(np.botSoftUntil - Date.now() <= royale.FIRST_MINUTES.BOT_SOFT_SHORT_MS + 50, 'soft window cut to the everyday one');
    assert.equal(np.nxScaryUntil || 0, 0, 'no scary-class hold-off');
    assert.equal(np._fpFirst, false, 'no first-kill fish');
    // ...and it holds: the next life is not protected either
    royale.freshRaidBody(np);
    assert.equal(np._fpProtect, false, 'latched for the session');
    assert.equal(np.botNewbie, false);

    // a streak, points, or banks do it too
    const a = spawn(0, 0, -2000, fakeSocket(0, { _careerLives: 0 }));
    royale.debugSetStreak(a, 3); royale._stampBotDifficulty(a);
    assert.equal(a._fpProtect, false, 'a streak of 3');
    const b = spawn(0, 0, -2000, fakeSocket(0, { _careerLives: 0 }));
    royale.debugSetScore(b, 2600); royale._stampBotDifficulty(b);
    assert.equal(b._fpProtect, false, '2,600 points');
    const c = spawn(0, 0, -2000, fakeSocket(0, { _careerLives: 0 }));
    for (let i = 0; i < 3; i++) fair.noteBank(c.socket, royale._raidId(), 20);
    royale._stampBotDifficulty(c);
    assert.equal(c._fpProtect, false, '3 deposits');
    for (const o of [gp, np, a, b, c]) o.kill();
    loop(2);
});

test('engage: once protection ends, real bots near a player pick and shoot them within a few seconds; a protected one is left be', () => {
    // a paced in-process sim (real clock, real bot spawns and brains)
    function run(minutes) {
        const sock = fakeSocket(minutes, { _careerLives: minutes ? 40 : 0, lastInputAt: Date.now() });
        const st = storm.snapshot();
        const p = spawn(minutes, st.cx, st.cy, sock);
        p.invuln = false; p.botGraceUntil = 0; p.botSoftUntil = 0; p.spawnGraceUntil = 0;
        royale._stampBotDifficulty(p);
        const bots = [];
        for (let i = 0; i < 3; i++) {
            const a = i / 3 * Math.PI * 2;
            handler.spawnBots({ x: p.x + Math.cos(a) * 700, y: p.y + Math.sin(a) * 700 }, -620 - i);
            bots.push(handler.bots[handler.bots.length - 1]);
        }
        let hits = 0, pickAt = 0, hitAt = 0;
        p.on('damage', () => { hits++; if (!hitAt) hitAt = Date.now() - t0; });
        const t0 = Date.now();
        let next = t0, qm = 0, stampAt = 0;
        while (Date.now() - t0 < 9000) {
            while (Date.now() < next);
            next += 33;
            const t = Date.now();
            sock.lastInputAt = t;
            p.health.amount = p.health.max;
            if (t - qm > 150) { qm = t; handler.quickMaintainLoop(); }
            if (t - stampAt > 1000) { stampAt = t; royale._stampBotDifficulty(p); }
            loop(1);
            if (!pickAt && bots.some(b => !b.isDead() && (b._botEnemyId === p.id || b._fightingPlayerId === p.id))) pickAt = t - t0;
        }
        const prot = p._fpProtect;
        for (const o of [p, ...bots]) { try { o.invuln = false; o.kill(); } catch { /* */ } }
        loop(3);
        return { prot, hits, pickAt, hitAt };
    }
    const vet = run(30);
    assert.equal(vet.prot, false);
    // bots sit still while they arm (~2 s), then go for them
    assert.ok(vet.hits > 0 && vet.hitAt < 7000, 'shot within a few seconds: ' + JSON.stringify(vet));
    log('     engaged (30 min guest): ' + JSON.stringify(vet));
    const fresh = run(0);
    assert.equal(fresh.prot, true);
    // never picked as a target; a stray shot aimed at a rock or another tank can still land
    assert.equal(fresh.pickAt, 0, 'a brand-new player is never picked: ' + JSON.stringify(fresh));
    assert.ok(fresh.hits <= 3 && fresh.hits < vet.hits, 'at most a stray hit or two: ' + JSON.stringify(fresh));
    log('     left be (brand new): ' + JSON.stringify(fresh));
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
