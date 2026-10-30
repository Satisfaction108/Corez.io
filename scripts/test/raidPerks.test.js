// Raid perks: node scripts/test/raidPerks.test.js
//
//   milestones   a pick of three at 5,000, 20,000, 45,000... board points
//                (each one costs much more than the last), no overall cap;
//                points lost later never take one back
//   sanitize     an old or restored build loses removed perks; stacks stop
//                at tier IV
//   offers       three different perks with room left, mining and utility
//                offered more than damage; a pick must be on the offer;
//                holding a perk that can still level up puts at least one
//                upgrade on every offer (owned ones weighted 2x) next to at
//                least one new perk
//   queue        milestones reached together wait behind the open offer
//   raid         the build lives on the board row: every new body gets it,
//                a death halves the score, takes two random perks and the
//                open offer and starts the milestones over from the new
//                score; a new raid and the /raidreset staging wipe clear it
//   bodies       effects on the body (health, speed, the hidden barrels),
//                re-applied after an evolution
//   bots         a bot takes a random pick a few seconds after a milestone
//   ranked       a pick adds nothing to the board or the rank basis
//   keys         Shift+1/2/3 picks, plain digits stay the stat keys, Y U I
//                stay the tank-upgrade keys
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const CLIENT = path.join(REPO, 'public', 'client');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `raidperks-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-raidperks-test-'));
fs.mkdirSync(ROOT, { recursive: true });
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ACCOUNTS_ENABLED', 'ROYALE_PERKS']) delete process.env[k];

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
const loop = (n = 1) => { for (let i = 0; i < n; i++) handler.gameloop(); };

const T = p => require(path.join(SERVER, 'game', 'terrain', p));
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const perks = T('raidPerks.js');
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

// a seeded rng, so offers are the same every run
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

let seq = 0;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'pk' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    global.gameManager.socketManager.clients.push(s);
    return s;
}
function body(sock, x = 0, y = 0) {
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (++seq);
    t.name = 'Perker' + seq;
    t.alwaysActive = true;
    t.sendMessage = () => {};
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
function bot(x, y) {
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
// the last PK packet this socket got, parsed
function lastPK(sock) {
    for (let i = sock.packets.length - 1; i >= 0; i--) if (sock.packets[i][0] === 'PK') return JSON.parse(sock.packets[i][1]);
    return null;
}
let clock = Date.now();
const realNow = Date.now;
function at(ms, fn) { clock = Math.max(clock, realNow()) + ms; Date.now = () => clock; try { return fn(); } finally { Date.now = realNow; } }
const perkTick = (ms = 300, frozen = false) => at(ms, () => royale._tickPerks(Date.now(), frozen));
const setScore = (b, n) => royale.debugSetScore(b, n);
const perkGuns = (b) => [...b.guns.values()].filter(g => g.isRaidPerk);

// ── the pure rules ──────────────────────────────────────────────────────
test('milestones: a pick every 5,000 points, no overall cap', () => {
    assert.equal(perks.STEP, 5000);
    assert.equal(perks.MAX_TIER, 4);
    assert.equal(perks.pickAt(1), 5000);
    assert.equal(perks.pickAt(2), 10000);
    assert.equal(perks.pickAt(3), 15000);
    assert.equal(perks.pickAt(4), 20000);
    assert.equal(perks.earnedAt(4999), 0);
    assert.equal(perks.earnedAt(5000), 1);
    assert.equal(perks.earnedAt(9999), 1);
    assert.equal(perks.earnedAt(10000), 2);
    assert.equal(perks.earnedAt(15000), 3);
    assert.equal(perks.earnedAt(-200), 0);
    assert.equal(perks.earnedAt(200000), 40, 'two hundred thousand points is 40 picks');
    assert.equal(perks.nextAt(0), 5000);
    assert.equal(perks.nextAt(2), 15000);
    assert.equal(perks.nextAt(40), 205000, 'there is always a next one');
    const b = perks.newBuild(), r = rng(1);
    assert.equal(perks.syncScore(b, 4999, r), 0);
    assert.equal(b.offer, null);
    assert.equal(perks.syncScore(b, 5000, r), 1);
    assert.equal(b.offer.length, 3);
    assert.equal(perks.syncScore(b, 9999, r), 0, 'nothing new below 10,000');
    perks.pick(b, b.offer[0], r);
    assert.equal(perks.syncScore(b, 2000, r), 0, 'a score that fell (a death with gems) takes nothing back');
    assert.equal(perks.totalPicks(b), 1);
    assert.equal(perks.syncScore(b, 10000, r), 1, 'the next one is still at 10,000');
    const big = perks.newBuild();
    perks.syncScore(big, 200000, r);
    while (big.offer) perks.pick(big, big.offer[0], r);
    assert.equal(perks.totalPicks(big), 40, 'no cap on picks');
    assert.equal(perks.snapshot(big).next, 205000, 'the next one is still shown');
    assert.equal(perks.snapshot(big).step, 5000, 'always 5,000 apart');
});

test('sanitize: removed perks go, stacks stop at tier IV, no total cap', () => {
    const r = rng(4);
    const old = perks.newBuild();
    delete old.rules;
    for (const p of perks.CATALOG) old.perks[p.id] = p.max;
    old.perks.drill = 9;
    old.perks.vamp = 4; old.perks.plating = 5;
    old.granted = 1200; old.pending = 40; old.offer = ['vamp', 'drill', 'hide'];
    perks.sanitize(old);
    assert.ok(!('vamp' in old.perks) && !('plating' in old.perks), 'Gem Leech and Ore Plating are gone');
    assert.equal(old.perks.drill, perks.MAX_TIER, 'a stack above tier IV is cut');
    assert.equal(perks.totalPicks(old), perks.CATALOG.reduce((n, p) => n + p.max, 0), 'every valid stack stays');
    assert.equal(old.granted, 1200, 'progression is not clamped any more');
    assert.deepEqual(old.offer, ['drill', 'hide']);
    assert.equal(old.pending, 40);
    assert.equal(perks.syncScore(old, 6e6, r), 0, 'a high-water mark never takes one back');
    assert.equal(perks.computeFx(old.perks).vamp, undefined);
    const clean = perks.newBuild();
    perks.syncScore(clean, 5000, r);
    const offer = clean.offer.slice();
    perks.sanitize(clean);
    assert.deepEqual(clean.offer, offer);
    assert.ok(!perks.BY_ID.has('vamp') && !perks.BY_ID.has('plating'));
});

test('offers: three different perks with room left; only what was offered can be picked', () => {
    const b = perks.newBuild(), r = rng(7);
    perks.grant(b, 1, r);
    assert.equal(new Set(b.offer).size, 3);
    assert.equal(perks.pick(b, 'nope', r), false);
    const off = perks.CATALOG.find(p => !b.offer.includes(p.id)).id;
    assert.equal(perks.pick(b, off, r), false, 'a real perk that was not offered');
    assert.equal(perks.pick(b, 42, r), false);
    const id = b.offer[1];
    assert.equal(perks.pick(b, id, r), true);
    assert.equal(b.perks[id], 1);
    assert.equal(b.offer, null);
    assert.equal(perks.pick(b, id, r), false, 'no offer, no pick');
    // a maxed perk is never offered again
    const full = perks.newBuild();
    full.perks.drill = perks.BY_ID.get('drill').max;
    for (let i = 0; i < 300; i++) assert.ok(!perks.rollOffer(full, rng(i)).includes('drill'));
    // with everything maxed there is nothing to offer, and the queue empties
    const all = perks.newBuild();
    for (const p of perks.CATALOG) all.perks[p.id] = p.max;
    assert.equal(perks.grant(all, 2, r), false);
    assert.equal(all.offer, null);
});

test('offers: mining and utility come up more than damage', () => {
    const count = {};
    const r = rng(99);
    for (let i = 0; i < 4000; i++) for (const id of perks.rollOffer(perks.newBuild(), r)) count[id] = (count[id] | 0) + 1;
    const kindOf = id => perks.BY_ID.get(id).kind;
    const avg = (k) => { const ids = perks.CATALOG.filter(p => p.kind === k).map(p => p.id); return ids.reduce((a, id) => a + (count[id] | 0), 0) / ids.length; };
    assert.ok(avg('mine') > avg('fight') * 1.8, 'mine ' + avg('mine') + ' vs fight ' + avg('fight'));
    assert.ok(kindOf('reload') === 'fight' && kindOf('velocity') === 'fight');
});

test('offers: a perk you hold below its max comes up as an upgrade on every offer, next to something new', () => {
    assert.equal(perks.UPGRADE_W, 2);
    const owned = (b, o) => o.filter(id => (b.perks[id] | 0) > 0);
    // one perk held: it is on every offer, with two new ones beside it
    const one = perks.newBuild();
    one.perks.drill = 1;
    for (let i = 0; i < 500; i++) {
        const o = perks.rollOffer(one, rng(i));
        assert.equal(o.length, 3);
        assert.equal(new Set(o).size, 3);
        assert.ok(o.includes('drill'), 'Power Drill II on offer ' + i + ': ' + o);
    }
    // the upgrade isn't always in the same slot
    const slots = new Set();
    for (let i = 0; i < 200; i++) slots.add(perks.rollOffer(one, rng(i)).indexOf('drill'));
    assert.equal(slots.size, 3, 'shuffled');
    // several held: always at least one upgrade and at least one new perk
    const many = perks.newBuild();
    Object.assign(many.perks, { drill: 1, magnet: 2, hide: 1, satchel: 1, reload: 1 });
    let ups = 0, n = 0;
    const r = rng(11);
    for (let i = 0; i < 3000; i++) {
        const o = perks.rollOffer(many, r);
        const k = owned(many, o).length;
        assert.ok(k >= 1, 'an upgrade: ' + o);
        assert.ok(k <= 2, 'and something new: ' + o);
        ups += k; n += 3;
    }
    assert.ok(ups / (n / 3) > 1.15, 'upgrades come up often: ' + (ups / (n / 3)).toFixed(2) + ' per offer');
    const maxed = perks.newBuild();
    maxed.perks.drill = perks.BY_ID.get('drill').max;
    for (let i = 0; i < 200; i++) assert.ok(!perks.rollOffer(maxed, rng(i)).includes('drill'));
    assert.equal(owned(perks.newBuild(), perks.rollOffer(perks.newBuild(), rng(5))).length, 0);
    const late = perks.newBuild();
    for (const p of perks.CATALOG) late.perks[p.id] = 1;
    const lo = perks.rollOffer(late, rng(2));
    assert.equal(lo.length, 3);
    const end = perks.newBuild();
    for (const p of perks.CATALOG) end.perks[p.id] = p.max;
    end.perks.drill = perks.BY_ID.get('drill').max - 1; end.perks.hide = 1;
    assert.deepEqual(perks.rollOffer(end, rng(3)).sort(), ['drill', 'hide']);
});

test('queue: milestones reached together wait behind the open offer', () => {
    const b = perks.newBuild(), r = rng(3);
    assert.equal(perks.syncScore(b, 15000, r), 3);
    assert.equal(b.offer.length, 3);
    assert.equal(b.pending, 2);
    const snap = perks.snapshot(b);
    assert.equal(snap.q, 2);
    assert.equal(snap.next, 20000);
    assert.equal(snap.step, 5000);
    perks.pick(b, b.offer[0], r);
    assert.ok(b.offer && b.offer.length === 3, 'the next one rolls at once');
    assert.equal(b.pending, 1);
    perks.pick(b, b.offer[0], r);
    perks.pick(b, b.offer[0], r);
    assert.equal(b.offer, null);
    assert.equal(b.pending, 0);
    assert.equal(perks.totalPicks(b), 3);
});

test('balance: no perk gives a real edge; rock breakers and gem bonuses are gone', () => {
    const maxed = Object.fromEntries(perks.CATALOG.map(p => [p.id, p.max]));
    const fx = perks.computeFx(maxed);
    assert.ok(fx.reload <= 1.08 + 1e-9, 'reload ' + fx.reload);
    assert.ok(fx.health <= 1.1 + 1e-9, 'health ' + fx.health);
    assert.ok(fx.speed <= 1.08 + 1e-9, 'speed ' + fx.speed);
    assert.ok(fx.mine <= 1.16 + 1e-9, 'mine ' + fx.mine);
    assert.ok(fx.velocity <= 1.08 + 1e-9, 'velocity ' + fx.velocity);
    assert.equal(fx.value, 1, 'gems always pay the same');
    assert.equal(fx.chipper, 1);
    for (const k of ['blastR', 'chain', 'pierce', 'crit', 'quake', 'shatter', 'twin', 'drones', 'prospector']) assert.equal(fx[k], 0, k);
    assert.equal(perks.computeFx({}), null, 'an empty build costs the hooks nothing');
    assert.equal(perks.gunDefs(fx).length, 0, 'no hidden perk barrels');
    for (const gone of ['blast', 'quake', 'chain', 'pierce', 'shatter', 'crit', 'twin', 'drones', 'rich', 'prospector', 'chipper']) assert.ok(!perks.BY_ID.has(gone), gone + ' removed');
    for (const p of perks.CATALOG) assert.ok(p.max >= 2 && p.max <= perks.MAX_TIER, p.id);
    assert.equal(perks.computeFx({ satchel: 3 }).satchel, 3);
    assert.equal(perks.CATALOG.length, 13);
});

test('raid: stat caps stay at the tank\'s full 9 (no raid-wide cut)', () => {
    const s = mkSocket();
    const p = body(s);
    assert.deepEqual(p.skill.caps, Array(11).fill(9), 'caps ' + p.skill.caps.join(','));
});

test('raid: the offer reaches the client, bogus picks are refused, a pick lands on the body', () => {
    const s = mkSocket();
    const p = body(s);
    setScore(p, 5200);
    perkTick();
    const pk = lastPK(s);
    assert.ok(pk && pk.o.length === 3, 'offer sent: ' + JSON.stringify(pk));
    assert.equal(pk.next, 10000);
    const n0 = s.packets.length;
    assert.equal(royale.pickPerk(s, 'notaperk'), false);
    assert.ok(s.packets.length > n0 && lastPK(s).o.length === 3, 'refused, and the real offer is sent again');
    // pin the offer so the effect is known
    const b = royale._perkBuild(p);
    b.offer = ['hide', 'speed', 'grind'];
    const hp0 = p.health.max, sp0 = p.topSpeed;
    assert.equal(royale.pickPerk(s, 'drill'), false, 'not on this offer');
    assert.equal(royale.pickPerk(s, 'hide'), true);
    assert.ok(Math.abs(p.health.max / hp0 - 1.025) < 0.01, 'Thick Hide: ' + p.health.max + ' vs ' + hp0);
    assert.equal(p.topSpeed, sp0);
    assert.deepEqual(lastPK(s).b.map(x => x.id + x.n), ['hide1']);
    assert.equal(lastPK(s).o.length, 0, 'offer closed');
});

test('raid: a death keeps a quarter of the board score, half the perks and the open offer, and the milestones start over', () => {
    const s = mkSocket();
    const p = body(s);
    setScore(p, 15000);
    perkTick();
    const b = royale._perkBuild(p);
    b.offer = ['speed', 'hide', 'grind'];
    assert.equal(royale.pickPerk(s, 'speed'), true);
    b.offer = ['speed', 'hide', 'grind'];
    assert.equal(royale.pickPerk(s, 'speed'), true);
    b.offer = ['speed', 'hide', 'grind'];
    assert.equal(royale.pickPerk(s, 'hide'), true);
    setScore(p, 20000); perkTick();
    b.offer = ['hide', 'grind', 'drill'];
    assert.equal(royale.pickPerk(s, 'hide'), true);
    assert.equal(b.offer, null);
    setScore(p, 25000); perkTick();
    assert.ok(b.offer, 'an offer open at death');
    p.kill(); royale.onCombatantDead(p); loop(2);
    s.lastRaidDeathAt = Date.now();
    assert.equal(royale.boardSnapshot().find(r => r.name === p.name).score, 6250, 'a quarter of the board score');
    assert.equal(perks.totalPicks(b), 2, 'half the perks are lost: ' + JSON.stringify(b.perks));
    assert.ok(b.offer && b.offer.length === 3, 'the open offer is kept');
    assert.equal(b.granted, 0);
    const q = body(s, 500, 0);
    perkTick();
    assert.equal(royale.pickPerk(s, b.offer[0]), true, 'and can still be picked');
    assert.equal(lastPK(s).next, 11250, 'the next pick is 5,000 past the new score');
    setScore(q, 11249); perkTick();
    assert.equal(b.offer, null);
    setScore(q, 11250); perkTick();
    assert.ok(b.offer && b.offer.length === 3, 'offered at 11,250');
    assert.equal(lastPK(s).next, 16250, 'then 5,000 more');
});

test('death: perks pure rules', () => {
    const b = perks.newBuild();
    b.perks = { drill: 3, hide: 1, speed: 2 };
    b.offer = ['grind', 'magnet', 'reload'];
    b.pending = 2;
    b.granted = 6;
    const lost = perks.onDeath(b, 12000, rng(3));
    assert.equal(lost.length, 3, 'half of 6 picks');
    assert.equal(perks.totalPicks(b), 3);
    assert.deepEqual(b.offer, ['grind', 'magnet', 'reload'], 'the open offer stays');
    assert.equal(b.pending, 2);
    assert.equal(b.granted, 0);
    assert.equal(b.base, 12000);
    assert.equal(perks.syncScore(b, 16999, rng(3)), 0);
    assert.equal(perks.syncScore(b, 17000, rng(3)), 1);
    assert.equal(perks.snapshot(b).next, 22000);
    const one = perks.newBuild();
    one.perks = { drill: perks.MAX_TIER };
    assert.equal(perks.onDeath(one, 0, rng(1)).length, 2);
    assert.deepEqual(one.perks, { drill: 2 });
    const single = perks.newBuild();
    single.perks = { hide: 1 };
    assert.deepEqual(perks.onDeath(single, 0, rng(1)), [], 'one pick: half rounds down');
    assert.deepEqual(perks.onDeath(perks.newBuild(), 0), []);
});

test('raid: the build survives evolution with no extra barrels', () => {
    const s = mkSocket();
    const p = body(s);
    setScore(p, 20000);
    perkTick();
    const b = royale._perkBuild(p);
    b.offer = ['speed', 'hide', 'grind'];
    assert.equal(royale.pickPerk(s, 'speed'), true);
    assert.ok(b.offer && b.offer.length === 3, 'the second milestone opened right after');
    assert.equal(perkGuns(p).length, 0, 'perks add no barrels');
});

test('raid: effects come back after an evolution', async () => {
    const s = mkSocket();
    const p = body(s);
    setScore(p, 15000);
    perkTick();
    const b = royale._perkBuild(p);
    const sp = p.topSpeed;
    b.offer = ['speed', 'hide', 'grind'];
    royale.pickPerk(s, 'speed');
    assert.ok(p.topSpeed > sp, 'Swift Treads');
    p.upgrades = [];
    p.define('twin');
    p.refreshBodyAttributes();
    await new Promise(r => setImmediate(r));
    assert.equal(perkGuns(p).length, 0);
    shop.applyPassives(p);
    assert.ok(p.bonusSpeedMult > 1.01, 'speed still applied after the evolution');
});

test('raid: a pick puts nothing on the board or the rank basis', () => {
    const s = mkSocket();
    const p = body(s);
    setScore(p, 5000);
    perkTick();
    const before = royale.boardSnapshot().find(r => r.id === p.id).score;
    const b = royale._perkBuild(p);
    royale.pickPerk(s, b.offer[0]);
    perkTick();
    const after = royale.boardSnapshot().find(r => r.id === p.id).score;
    assert.equal(after, before);
    const src = fs.readFileSync(path.join(SERVER, 'accounts', 'game', 'rankHooks.js'), 'utf8');
    assert.ok(!/perk|_pkfx/i.test(src), 'rankHooks never reads perks');
});

test('bots: a random pick a few seconds after the milestone', () => {
    const b = bot(900, 0);
    royale.boardSnapshot();      // gives it a board row
    // (round 9: a bot's points past 2500 come in on a log curve, so 9000 shows ~5700)
    setScore(b, 9000);
    perkTick(10);
    const build = royale._perkBuild(b);
    assert.ok(build.offer, 'offered');
    perkTick(8000);
    assert.equal(perks.totalPicks(build), 1, 'picked');
    assert.equal(build.offer, null);
    perkTick(300);
    assert.ok(b._pkfx, 'on the bot');
});

test('new raid: everyone starts with an empty build', () => {
    const s = mkSocket();
    const p = body(s);
    setScore(p, 5000);
    perkTick();
    const b = royale._perkBuild(p);
    b.offer = ['twin', 'hide', 'speed'];
    royale.pickPerk(s, 'twin');
    assert.equal(perkGuns(p).length, 1);
    // the raid runs out with nobody who played 30 s: a quiet restart (startRaid)
    royale.debugEndRaid();
    at(50, () => royale.tick());
    assert.equal(p._pkfx, null, 'effects off');
    assert.equal(perkGuns(p).length, 0, 'barrel off');
    perkTick();
    const pk = lastPK(s);
    assert.equal(pk.b.length, 0, 'the HUD hears the build is empty');
    assert.equal(pk.o.length, 0);
    assert.equal(perks.totalPicks(royale._perkBuild(p)), 0);
});

test('/raidreset: the staging wipe clears builds; the lobby grants nothing', () => {
    const s = mkSocket();
    const p = body(s);
    setScore(p, 12000);
    perkTick();
    royale.pickPerk(s, royale._perkBuild(p).offer[0]);
    royale.beginStaging(60_000);
    at(1500, () => royale.tick());      // past the board wipe
    const pk = lastPK(s);
    assert.equal(pk.b.length, 0, 'empty build sent: ' + JSON.stringify(pk));
    assert.equal(pk.o.length, 0, 'no offer');
    const q = body(s, 0, 0);            // the lobby respawn
    assert.equal(q._pkfx, null);
    setScore(q, 20000);
    perkTick(300, true);
    assert.equal(royale._perkBuild(q).offer, null, 'no milestones while staging');
    // start the raid so later tests run in a live one
    at(61_000, () => royale.tick());
    at(1500, () => royale.tick());
    assert.equal(royale.staging(), false);
});

// ── the client ──────────────────────────────────────────────────────────
test('keys: Shift+1/2/3 picks; plain digits and Y U I keep their jobs', async () => {
    const L = await import(pathToFileURL(path.join(CLIENT, 'raidPerksLogic.js')).href);
    const k = (code, o = {}) => Object.assign({ code, key: code.slice(-1), keyCode: code.startsWith('Digit') ? 48 + +code.slice(-1) : code.charCodeAt(3), shiftKey: false }, o);
    assert.equal(L.perkKeyIndex(k('Digit1', { shiftKey: true }), 3, false), 0);
    assert.equal(L.perkKeyIndex(k('Digit3', { shiftKey: true }), 3, false), 2);
    assert.equal(L.perkKeyIndex(k('Digit3', { shiftKey: true }), 2, false), -1, 'only as many as there are cards');
    assert.equal(L.perkKeyIndex(k('Digit4', { shiftKey: true }), 3, false), -1);
    for (const d of ['Digit1', 'Digit2', 'Digit3']) assert.equal(L.perkKeyIndex(k(d), 3, false), -1, 'plain ' + d + ' stays a stat key');
    for (const c of ['KeyY', 'KeyU', 'KeyI']) assert.equal(L.perkKeyIndex(k(c, { shiftKey: true }), 3, false), -1, c);
    assert.equal(L.perkKeyIndex(k('Numpad1', { shiftKey: true }), 3, false), -1, 'the numpad stays a stat path');
    assert.equal(L.perkKeyIndex(k('Digit1', { shiftKey: true, ctrlKey: true }), 3, false), -1);
    assert.equal(L.perkKeyIndex(k('Digit1', { shiftKey: true, repeat: true }), 3, false), -1);
    assert.equal(L.perkKeyIndex(k('Digit1', { shiftKey: true }), 3, true), -1, 'not while chatting');
    // the defaults: digits upgrade stats, Y U I H J K pick tank upgrades,
    // nothing is bound to Shift plus a digit
    const g = fs.readFileSync(path.join(CLIENT, 'global.js'), 'utf8');
    const bind = (name) => +new RegExp(name + ':\\s*(-?\\d+)').exec(g)[1];
    const stats = ['ATK', 'HTL', 'SPD', 'STR', 'PEN', 'DAM', 'RLD', 'MOB', 'RGN', 'SHI'].map(n => bind('KEY_UPGRADE_' + n));
    assert.deepEqual(stats.slice().sort((a, b) => a - b), [48, 49, 50, 51, 52, 53, 54, 55, 56, 57]);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(i => bind('KEY_CHOOSE_' + i)), [89, 85, 73, 72, 74, 75]);
    // canvas.js asks raidPerks before the stat keys, and the stat keys
    // never look at Shift (so with no offer up, Shift+1 still upgrades)
    const cv = fs.readFileSync(path.join(CLIENT, 'canvas.js'), 'utf8');
    const royaleKeys = cv.indexOf('royaleKeyDown(event) {');
    const perkKey = cv.indexOf('raidPerks.key(event)');
    const keyDown = cv.indexOf('    keyDown(event) {');
    const skillAt = cv.indexOf('if (global.canSkill) {');
    assert.ok(royaleKeys > 0 && perkKey > royaleKeys && perkKey < keyDown, 'the perk key is in royaleKeyDown');
    assert.ok(cv.indexOf('if (this.royaleKeyDown(event)) return;') < skillAt, 'which runs before the stat keys');
    assert.ok(!/shiftKey/.test(cv.slice(skillAt, skillAt + 1500)), 'the stat keys ignore Shift');
});

test('client: cards sit low in the middle, clear of the tank, stat bars and minimap; the chip and strip', async () => {
    const L = await import(pathToFileURL(path.join(CLIENT, 'raidPerksLogic.js')).href);
    const W = 2240, H = 1260;
    const bottom = H - 115, minTop = L.tankFloor(H, 40);
    const lay = L.cardLayout(W, 3, { bottom, minTop, left: 248, right: W - 268 });
    // centred on the screen even when the clear room is lopsided
    for (const [lft, rgt] of [[248, W - 268], [420, W - 180], [200, W - 600]]) {
        const ly = L.cardLayout(W, 3, { bottom, minTop, left: lft, right: rgt });
        const mid = (ly.rects[0].x + ly.rects[2].x + ly.rects[2].w) / 2;
        assert.ok(Math.abs(mid - W / 2) <= 1, 'cards centred: ' + mid + ' vs ' + W / 2);
        assert.ok(ly.rects[0].x >= lft - 1 && ly.rects[2].x + ly.rects[2].w <= rgt + 1, 'and clear of both sides');
    }
    assert.equal(lay.rects.length, 3);
    assert.equal(lay.compact, false);
    for (const r of lay.rects) {
        assert.ok(r.y + r.h <= bottom && r.y >= minTop, 'between the tank and the name');
        assert.ok(r.x >= 248 && r.x + r.w <= W - 268, 'clear of the stat bars and the minimap');
    }
    assert.ok(lay.head.y >= minTop - 1, 'the header too');
    const mid = (lay.rects[0].x + lay.rects[2].x + lay.rects[2].w) / 2;
    assert.ok(Math.abs(mid - W / 2) < 2, 'centred');
    // a big tank pushes it compact
    const tight = L.cardLayout(W, 3, { bottom, minTop: L.tankFloor(H, 380), left: 248, right: W - 268 });
    assert.equal(tight.compact, true);
    for (const r of tight.rects) assert.ok(r.y >= L.tankFloor(H, 380), 'still under the tank');
    // no chip, no folding: an offer stays as cards until it's picked
    assert.equal(L.viewFor({ folded: false, openedAt: 0 }, { now: 1000, key: 'a' }), 'cards');
    assert.equal(L.viewFor({ folded: false, openedAt: 0 }, { now: 60_000, key: 'a' }), 'cards', 'ignored for a minute: still cards');
    assert.equal(L.viewFor({ folded: true, openedAt: 0 }, { now: 10, key: 'a' }), 'cards');
    assert.equal(L.viewFor({ folded: false, openedAt: 0 }, { now: 10, key: 'a', blocked: true }), '', 'hidden while a panel owns the screen');
    assert.equal(L.viewFor({ folded: false, openedAt: 0 }, { now: 10, key: '' }), '');
    assert.equal(L.viewFor({ openedAt: 0 }, { now: 2000, key: 'a', hurtAt: 1900 }), '', 'a fresh offer waits out a fight');
    assert.equal(L.viewFor({ openedAt: 0 }, { now: 2000, key: 'a', hold: true }), '', 'and a callout');
    assert.equal(L.viewFor({ openedAt: 0 }, { now: L.MAX_WAIT_MS + 10, key: 'a', hurtAt: L.MAX_WAIT_MS, dealtAt: L.MAX_WAIT_MS, hold: true }), 'cards', 'never waits more than MAX_WAIT_MS');
    assert.equal(L.viewFor({ openedAt: 0 }, { now: L.MAX_WAIT_MS + 10, key: 'a', blocked: true }), '', 'a panel still hides it');
    // playtest 9: a fresh offer waits for 3 s with no hit taken OR dealt, and
    // for the middle to be free (a callout, a slam, a new crown's card)
    assert.equal(L.viewFor({ shown: false }, { now: 10_000, key: 'a', dealtAt: 8_000 }), '', 'shooting someone: waits');
    assert.equal(L.viewFor({ shown: false }, { now: 11_100, key: 'a', dealtAt: 8_000, hurtAt: 1 }), 'cards', 'calm 3 s: out');
    assert.equal(L.viewFor({ shown: false }, { now: 60_000, key: 'a', hold: true }), '', 'centre stage busy: waits');
    assert.equal(L.viewFor({ shown: true }, { now: 10_000, key: 'a', dealtAt: 9_990, hold: true }), 'cards', 'once out, it stays');
    // the strip ends left of the satchel pills
    const wallet = { x: W / 2 - 150, y: H - 61, w: 300, h: 18 };
    const st = L.stripLayout(wallet, 4, 120, 248);
    assert.equal(st.icons.length, 4);
    assert.ok(st.icons[3].x + st.icons[3].w <= wallet.x - 10);
    assert.ok(st.badge.x + st.badge.w <= st.icons[0].x);
    assert.ok(st.badge.x >= 248);
    // labelled chips take their own widths, and say when they don't fit
    const lab = L.stripLayout(wallet, 3, 26, 248, [130, 120, 140]);
    assert.ok(lab.fit);
    assert.deepEqual(lab.icons.map(r => r.w), [130, 120, 140]);
    assert.ok(lab.icons[0].x + lab.icons[0].w <= lab.icons[1].x && lab.icons[1].x + lab.icons[1].w <= lab.icons[2].x, 'no overlap');
    assert.equal(L.stripLayout(wallet, 9, 26, 248, Array(9).fill(140)).fit, false, 'nine named perks need the short form');
    // named chips wrap upward, newest nearest the satchel, badge bottom left
    const rows = L.stripRows(wallet, Array(7).fill(130), 26, 248, 3);
    assert.ok(rows.fit && rows.rows >= 2, 'seven names take more than one row');
    assert.ok(rows.icons.every(r => r.x >= 248 && r.x + r.w <= wallet.x - 10));
    assert.ok(rows.icons[6].y > rows.icons[0].y, 'the newest sits on the bottom row');
    assert.ok(rows.badge.x >= 248 && rows.icons.filter(r => r.y === rows.badge.y).every(r => r.x >= rows.badge.x + rows.badge.w));
    assert.equal(L.stripRows(wallet, Array(16).fill(160), 26, 248, 3).fit, false, 'sixteen names fall back to the short form');
    // the packet and the death line
    const parsed = L.parseState(JSON.stringify(perks.snapshot((() => { const b = perks.newBuild(); b.perks.drill = 2; b.granted = 2; return b; })())));
    assert.equal(parsed.offer, null);
    assert.deepEqual(parsed.build.map(p => [p.id, p.n]), [['drill', 2]]);
    assert.equal(parsed.next, 15000);
    assert.equal(parsed.step, 5000);
    assert.equal(L.badgeTip(parsed, 12000), 'You get a new perk every 5,000 points. Next one at 15,000, you have 12,000.');
    assert.equal(L.badgeTip({ next: 0 }, 9e6), 'You have every perk the raid offers.');
    assert.equal(L.deathLine(parsed.build), 'Dying halved your points. You kept all your perks.');
    assert.equal(L.deathLine([]), '');
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
