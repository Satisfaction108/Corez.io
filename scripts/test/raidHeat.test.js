// Raid heat: node scripts/test/raidHeat.test.js
//
//   hunted     1500 carried marks you, it stays on down to 1200, the biggest
//              carrier over 2500 is the top target (and keeps it until
//              someone passes them by 150), a brand new player is left alone
//              until their first bank, teammates are never hunters
//   bounty     15% / 20% of the haul, capped at 800, nothing for a teammate;
//              a real kill banks it for the killer and puts a feed line up
//   core       the site sits 330 from the Center Vault, the final circle
//              closes halfway between them, the Core surfaces when the last
//              storm starts, on open ground in a cleared arena with a lane to
//              the vault, never on the pad; breaking it erupts exactly its
//              gems and banks the last-hit bonus; the raid still ends on time
//              with both inside the last circle
//   dropin     a new player's first spot is 520-760 from a safe vault, open
//              and escapable, with soft ore on the way; the landing smashes
//              the plain rock around it (a crater on the first drop) and
//              turns rocks on the rim into soft ore; nothing is handed out
//   fall       while it falls the tank takes no input (moving, shooting,
//              dash, kit, upgrades) and the landing lifts only its own freeze
//   resume     a reload keeps its team and colour and drops back in on screen
//              only (no hold, no smash)
//   supply     a crate announced 10 s ahead near a player, falling in, an
//              epic chest that unlocks an ability; then one a minute or so;
//              anyone on the spot is rolled off, never left inside it
//   respawns   life after life through the real spawn path, every landing
//              breaks the plain rock in range (or reaches the nearest wall)
//   opening    a soft vein by every drop pit, the 1:30 meteor rush
//   rattler    only for new players carrying gems away from a vault, spawns
//              on the far side from the vault, one per raid, gives up when
//              they reach the pad
//   juice      the client's pure FX math (public/client/juiceMath.js)
//   switches   every feature has its env kill switch in server/.env.example
'use strict';

const emit = process.emitWarning;
process.emitWarning = (w, ...a) => { if (!/MODULE_TYPELESS|module syntax/.test(String(w) + a.join(' '))) emit.call(process, w, ...a); };

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

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

const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
const grid = mapGen.generate({ cols: 13, rows: 13, tileWidth: 420, fullLattice: true });
grid.buildVoronoiColliders();
global.gameManager.terrainGrid = grid;
try { require(path.join(SERVER, 'game', 'terrain', 'royaleLayout.js')).carveMatchPois(grid); } catch { /* */ }

const hunted = require(path.join(SERVER, 'game', 'terrain', 'hunted.js'));
const coreFinale = require(path.join(SERVER, 'game', 'terrain', 'coreFinale.js'));
const dropIn = require(path.join(SERVER, 'game', 'terrain', 'dropIn.js'));
const rattler = require(path.join(SERVER, 'game', 'terrain', 'rattler.js'));
const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
const vault = require(path.join(SERVER, 'game', 'terrain', 'vault.js'));
const spawnReach = require(path.join(SERVER, 'game', 'terrain', 'spawnReach.js'));
const padGeom = require(path.join(SERVER, 'game', 'terrain', 'padGeom.js'));
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── plain bodies for the hunted rules ───────────────────────────────────
let ids = 1;
function fake(carried, extra = {}) {
    return { id: ids++, x: 0, y: (ids * 3000) % 20000, carriedGems: carried, team: -ids, name: 'P' + ids, huntedLevel: 0, isDead: () => false, ...extra };
}
function sock() { const said = []; return { said, talk() {}, _careerLives: 100 }; }
let calls = [];
hunted.attach({ callout: (b, kind, text) => calls.push({ b, kind, text }), feed: (e) => calls.push({ feed: e }) });
let clock = 1_000_000;
const step = (list) => { clock += hunted.EVERY_MS; hunted.tick(clock, list); };

test('hunted: 1500 marks you, 1200 is where it comes off', () => {
    hunted.reset(); calls = [];
    const a = fake(1499, { socket: sock() });
    step([a]);
    assert.equal(a.huntedLevel, 0);
    a.carriedGems = 1500; step([a]);
    assert.equal(a.huntedLevel, 1);
    assert.equal(calls.filter(c => c.kind === 'hunted').length, 1, 'one banner on the way in');
    a.carriedGems = 1250; step([a]);
    assert.equal(a.huntedLevel, 1, 'hysteresis');
    a.carriedGems = 1199; a.vaultDeposit = { remaining: 1 }; step([a]);
    assert.equal(a.huntedLevel, 0);
    const safe = calls.filter(c => c.kind === 'safe');
    assert.equal(safe.length, 1, 'SAFE when it comes off');
    // the tick is throttled
    a.carriedGems = 3000;
    hunted.tick(clock + 10, [a]);
    assert.equal(a.huntedLevel, 0);
});

test('hunted: the biggest carrier over 2500 is the top target, sticky by 150', () => {
    hunted.reset(); calls = [];
    const a = fake(2600), b = fake(2700), c = fake(2400);
    step([a, b, c]);
    assert.deepEqual([a.huntedLevel, b.huntedLevel, c.huntedLevel], [1, 2, 1]);
    a.carriedGems = 2800; step([a, b, c]);
    assert.equal(b.huntedLevel, 2, 'not passed by enough');
    a.carriedGems = 2900; step([a, b, c]);
    assert.deepEqual([a.huntedLevel, b.huntedLevel], [2, 1]);
    assert.equal(hunted.topTarget(), a);
    assert.ok(calls.some(x => x.feed && x.feed.hunt), 'a feed line for the top target');
    // only one top target, and only above the bar
    c.carriedGems = 2450; a.carriedGems = 2450; b.carriedGems = 2450; step([a, b, c]);
    assert.equal(a.huntedLevel, 2, 'the top target keeps it a little under the bar');
    a.carriedGems = 2300; step([a, b, c]);
    assert.equal([a, b, c].filter(x => x.huntedLevel === 2).length, 0);
});

test('hunted: a brand new player waits for their first bank', () => {
    hunted.reset();
    const n = fake(3000, { socket: sock(), botNewbie: true });
    step([n]);
    assert.equal(n.huntedLevel, 0);
    hunted.onBanked(n);
    step([n]);
    assert.equal(n.huntedLevel, 2);
    // the next raid starts the window over
    hunted.reset(); n.huntedLevel = 0;
    step([n]);
    assert.equal(n.huntedLevel, 0);
    // bots and regulars are never exempt
    const bot = fake(1600, { isBot: true, botNewbie: true });
    step([bot]);
    assert.equal(bot.huntedLevel, 1);
});

test('hunted: hunters are enemies within range, never your teammate', () => {
    hunted.reset();
    const me = fake(2000, { x: 0, y: 0, team: -7 });
    const mate = fake(0, { x: 100, y: 0, team: -7 });
    const foe = fake(0, { x: 900, y: 0 });
    const far = fake(0, { x: 5000, y: 0 });
    step([me, mate, foe, far]);
    assert.equal(me._huntersNear, 1);
    assert.deepEqual(hunted.forClient(me), { l: 1, n: 1 });
    const snap = hunted.snapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].e, me.id);
    assert.equal(snap[0].g, 2000);
    assert.equal(snap[0].tm, -7, 'the client leaves its own team out');
});

test('bounty: 15% / 20% of the haul, capped, never a teammate', () => {
    const v = fake(0), k = fake(0);
    assert.deepEqual(hunted.onKill(k, v, 2000, 1), { gems: 300, pts: 150, level: 1 });
    assert.deepEqual(hunted.onKill(k, v, 3000, 2), { gems: 600, pts: 300, level: 2 });
    assert.equal(hunted.onKill(k, v, 4000, 2).gems, 800);
    assert.equal(hunted.onKill(k, v, 9000, 2).gems, hunted.BOUNTY_MAX);
    assert.equal(hunted.onKill(k, v, 3000, 0), null, 'not hunted, no bounty');
    const mate = fake(0, { team: v.team });
    assert.equal(hunted.onKill(mate, v, 3000, 1), null);
    assert.equal(hunted.onKill(v, v, 3000, 1), null);
});

// ── real bodies ─────────────────────────────────────────────────────────
let nextY = -9000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function fakeSocket(extra = {}) {
    return { id: ids++, talk() {}, status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, ...extra };
}
function player(x = 0, y = (nextY += 1200), socket = fakeSocket()) {
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

test('bounty: killing a hunted player banks it for the killer, with a feed line', () => {
    captureRY();   // the raid is on (the first tick starts it)
    const victim = player(), killer = player();
    victim.carriedGems = 2000;
    victim.huntedLevel = 1;
    victim.finalKillers = [killer];
    victim.socket.gemDeathCarried = 2000;
    royale.freshRaidBody(victim); royale.freshRaidBody(killer);
    victim.huntedLevel = 1;
    const before = killer.socket.gemBanked | 0;
    let kc = null;
    killer.socket.talk = (...m) => { if (m[0] === 'KC') kc = m; };
    royale.onCombatantDead(victim);
    assert.equal((killer.socket.gemBanked | 0) - before, 300);
    assert.equal(victim.huntedLevel, 0);
    assert.ok(kc && /BOUNTY CASHED/.test(kc[2]), 'callout ' + (kc && kc[2]));
    assert.equal(kc[1], 'huntkill');
    const st = JSON.parse(captureRY());
    assert.ok(st.feed.some(f => f.bounty && f.g === 300 && f.name === victim.name), 'feed line');
    victim.kill(); killer.kill();
});

function captureRY() {
    let out = null;
    const c = { id: ids++, talk: (k, p) => { if (k === 'RY') out = p; }, status: {}, player: null };
    global.gameManager.socketManager.clients = [c];
    // broadcast is internal: drive it through tick
    royale.tick._broadcastAt = 0;
    try { royale.tick(); } catch { /* */ }
    global.gameManager.socketManager.clients = [];
    return out || '{"feed":[]}';
}

// ── the Core ────────────────────────────────────────────────────────────
const centre = () => vault.getVaults().reduce((b, v) => !b || Math.hypot(v.x, v.y) < Math.hypot(b.x, b.y) ? v : b, null);

test('core: the site is 330 from the Center Vault and the final circle aims between them', () => {
    storm.setCycles(3);
    storm.start();
    coreFinale.newRaid();
    const s = coreFinale.siteOf();
    const v = centre();
    assert.ok(v, 'a centre vault');
    assert.ok(Math.abs(Math.hypot(s.x - v.x, s.y - v.y) - coreFinale.CORE_OFFSET) < 1);
    assert.ok(Math.abs(s.mid.x - (s.x + v.x) / 2) < 1e-6);
    // early cycles: a random centre, the Core is not up
    assert.equal(coreFinale.current(), null);
    coreFinale.tick(Date.now(), []);
    assert.equal(coreFinale.current(), null);
    assert.equal(coreFinale.snapshot(), undefined, 'nothing to show before the warning');
    // into the last cycle: the circle moves onto the site
    storm.debugFinal(storm.CYCLE_MS / 1000 - 1);
    const st = storm.snapshot();
    assert.equal(st.fin, 1);
    assert.ok(Math.abs(st.cx - s.mid.x) < 1e-6 && Math.abs(st.cy - s.mid.y) < 1e-6, 'final centre ' + st.cx + ',' + st.cy);
});

test('core: surfaces with the last storm in a cleared arena, off the pad, reachable', () => {
    const p = player(0, 900);
    global.gameManager.socketManager.players = [{ body: p }];
    const announced = [];
    coreFinale.attach({ humans: () => [p], fighters: () => [p], announce: (k, t) => announced.push(k), feed() {}, fxAt() {}, toast() {}, payGems() {}, addPts() {}, callout() {} });
    coreFinale.tick(Date.now(), [p]);
    const c = coreFinale.current();
    assert.ok(c, 'the Core is up ' + JSON.stringify(coreFinale._state()));
    assert.ok(announced.includes('core'));
    const s = coreFinale.siteOf();
    assert.ok(Math.hypot(c.x - s.x, c.y - s.y) < 1);
    assert.equal(c.health.max, coreFinale.healthFor(1, 0));
    assert.equal(c.isLootChest && c.isRoyaleCore, true);
    // the arena: nothing alive inside ARENA_R, the lane to the vault is open
    assert.ok(!grid.pointInRock(c.x, c.y));
    let live = 0;
    for (const r of grid.rocks.values()) if (r.alive && Math.hypot(r.worldCx - c.x, r.worldCy - c.y) < coreFinale.ARENA_R - 40 && r.ore !== 4) live++;
    assert.equal(live, 0, 'rock left in the arena');
    const v = centre();
    for (let k = 0; k <= 1; k += 0.1) {
        const x = c.x + (v.x - c.x) * k, y = c.y + (v.y - c.y) * k;
        assert.ok(!grid.pointInRock(x, y), 'lane blocked at ' + k.toFixed(1));
    }
    // the Core never sits on the pad
    const cr = c.realSize || 74;
    assert.ok(!padGeom.insidePad(v, c.x, c.y, cr + 20), 'core on the pad');
    // you can get out of the arena (spawnReach), and in: open ground around it
    spawnReach.invalidate();
    const zone = { x: 0, y: 0, r: 2800 };
    let ok = 0, n = 0;
    for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2, x = c.x + Math.cos(a) * (cr + 90), y = c.y + Math.sin(a) * (cr + 90);
        if (grid.pointInRock(x, y)) continue;
        n++;
        if (spawnReach.check(grid, x, y, { zone }).ok) ok++;
    }
    assert.ok(n >= 10 && ok === n, 'reach ' + ok + '/' + n);
    // the final circle holds both at the very end
    const end = storm.endAt();
    const st = storm.snapshot(end - 1);
    assert.ok(Math.hypot(c.x - st.cx, c.y - st.cy) + cr * 0.5 < st.r, 'core inside the last circle');
    assert.ok(Math.hypot(v.x - st.cx, v.y - st.cy) < st.r, 'vault inside the last circle');
});

test('core: it fights back as it breaks, every attack telegraphed; no mercy for newcomers', () => {
    const c = coreFinale.current();
    assert.ok(c, 'the Core is up');
    const p = global.gameManager.socketManager.players[0].body;
    const fx = [];
    coreFinale.attach({ humans: () => [p], fighters: () => [p], announce() {}, feed() {}, fxAt: (x, y, k, ...e) => fx.push([k, ...e]), toast() {}, payGems() {}, addPts() {}, callout() {} });
    const place = () => { p.x = c.x + 300; p.y = c.y; p.velocity.x = 0; p.velocity.y = 0; p.invuln = false; p.spawnGraceUntil = 0; p.padSafe = false; p.botNewness = 0; p.botNewbie = false; p.health.amount = p.health.max; if (p.shield) p.shield.amount = 0; };
    let t = Date.now() + 10_000;
    // run the Core for `ms`; what it did (FX kinds) and the health p lost (share of max)
    const run = (ms) => {
        const t0 = fx.length, hp0 = p.health.amount;
        for (let k = 0; k < ms; k += 33) { t += 33; place0(); coreFinale.tick(t, [p]); }
        return { kinds: fx.slice(t0).map(f => f[0]), lost: (hp0 - p.health.amount) / p.health.max, fx: fx.slice(t0) };
    };
    // stand still next to it, full health each tick unless we are measuring
    let keepFull = true;
    const place0 = () => { const hp = p.health.amount; place(); if (!keepFull) p.health.amount = hp; };
    keepFull = false;
    coreFinale.debugHp(0.8);
    place();
    let r = run(9000);
    assert.ok(r.kinds.includes('corecharge') && r.kinds.includes('corepulse'), 'a telegraphed shockwave: ' + r.kinds.join(','));
    assert.ok(r.kinds.indexOf('corecharge') < r.kinds.indexOf('corepulse'), 'the warning comes first');
    assert.ok(!r.kinds.includes('coreshard'), 'no shards above half');
    assert.equal(r.lost, 0, 'healthy, the shockwave only shoves');
    coreFinale.debugHp(0.4);
    place();
    r = run(3200);
    assert.ok(r.kinds.includes('coreshard'), 'shards from half health: ' + r.kinds.join(','));
    const charge = r.fx.findIndex(f => f[0] === 'corecharge' && f[2] === 0), shot = r.kinds.indexOf('coreshard');
    assert.ok(charge >= 0 && charge < shot, 'shards are telegraphed too');
    assert.ok(r.lost >= coreFinale.SHARD_DMG * 0.99, 'and they hurt: ' + r.lost.toFixed(3));
    coreFinale.debugHp(0.2);
    place();
    r = run(9000);
    const nShard = r.kinds.filter(k => k === 'coreshard').length;
    assert.ok(nShard >= 4, 'faster below a quarter: ' + nShard);
    assert.ok(r.lost > coreFinale.SHARD_RAGE_DMG * 2, 'it is dangerous now: ' + r.lost.toFixed(2));
    // a brand new player gets no boss mercy from the Core: the full hit
    place(); p.botNewness = 1; p.health.amount = p.health.max;
    const n0 = p.health.amount;
    for (let k = 0; k < 3000; k += 33) { t += 33; p.x = c.x + 300; p.y = c.y; p.velocity.x = 0; p.velocity.y = 0; coreFinale.tick(t, [p]); }
    assert.ok(n0 - p.health.amount >= p.health.max * coreFinale.SHARD_RAGE_DMG * 0.99, 'newcomers take the full hit: ' + ((n0 - p.health.amount) / p.health.max).toFixed(3));
    p.botNewness = 0; p.health.amount = p.health.max;
    coreFinale.debugHp(1);
});

test('core: breaking it banks 20,000 by damage share (bots unpaid), the last hit on top, only a little on the ground', () => {
    const c = coreFinale.current();
    const p = global.gameManager.socketManager.players[0].body;
    const sock2 = fakeSocket({ packets: [] }); sock2.talk = (...a) => sock2.packets.push(a);
    const p2 = player(c.x + 400, c.y, sock2);
    const bot = player(c.x - 400, c.y); bot.socket = null; bot.isBot = true; bot.isPlayer = false;
    const tiny = fakeSocket({ packets: [] }); tiny.talk = (...a) => tiny.packets.push(a);
    const p3 = player(c.x, c.y + 400, tiny);
    const banked = new Map(), calls = [];
    coreFinale.attach({ humans: () => [p, p2, p3], fighters: () => [p, p2, p3, bot], announce() {}, feed: (f) => calls.push(f), fxAt() {}, toast() {},
        bank: (b, n) => { banked.set(b, (banked.get(b) || 0) + n); return n; }, payGems() { throw new Error('the Core banks, it does not pay out loose'); },
        addPts() {}, callout: (b, k, t) => calls.push({ b, k, t }) });
    // damage as the death check reports it: what lands, and who did it
    const hit = (who, n) => { c.damageReceived = n; c.emit('damage', { damageInflictor: [who] }); c.damageReceived = 0; };
    hit(p, 50_000); hit(p2, 30_000); hit(bot, 19_000); hit(p3, 1_000);
    const before = new Set([...entities.values()].filter(e => e.isGemPickup).map(e => e.id));
    c.finalKillers = [p];
    c.kill();
    coreFinale.tick(Date.now(), [p, p2, p3, bot]);
    const B = coreFinale.CORE_BANK;
    assert.equal(banked.get(p), Math.round(B * 0.5 / 10) * 10 + coreFinale.LAST_HIT_GEMS, 'half, and the last hit');
    assert.equal(banked.get(p2), Math.round(B * 0.3 / 10) * 10);
    assert.equal(banked.get(bot), undefined, 'a bot share is not paid');
    assert.equal(banked.get(p3), Math.round(B * 0.01 / 10) * 10, 'a 1% helper (under the minimum-share line) gets their 1%');
    assert.ok(calls.some(x => x.k === 'corepay' && x.b === p2 && /BANKED \+6,000/.test(x.t)), 'the slam');
    assert.ok(calls.some(x => x.k === 'corebreak' && x.b === p));
    assert.ok(calls.some(x => x.core && x.broke && x.g === B), 'the feed line');
    let sum = 0;
    for (const e of entities.values()) if (e.isGemPickup && !before.has(e.id)) sum += e.gemValue;
    assert.ok(sum <= coreFinale.SPRAY_GEMS * 2, 'only a little on the ground: ' + sum);
    assert.equal(coreFinale.current(), null);
    assert.equal(coreFinale.snapshot().s, 'down');
    // the minimum share for a real helper
    const m = coreFinale.splitPayout(new Map([[1, { body: p, dmg: 97.8 }], [2, { body: p2, dmg: 2.2 }]]));
    assert.equal(m.get(p2), coreFinale.MIN_SHARE);
    assert.ok(coreFinale.healthFor(5, 1) > coreFinale.healthFor(1, 5));
    assert.equal(coreFinale.gemsFor(20, 0), B);
    assert.equal(coreFinale.healthFor(30, 0), coreFinale.HP_MAX);
    // ten times the old base; at ~1000 a second per human and ~400 per bot of
    // focused fire, a full raid needs a minute and a half to two
    const ttk = (h, b) => coreFinale.healthFor(h, b) / (1000 * h + 400 * b);
    for (const h of [6, 10, 15, 20]) assert.ok(ttk(h, 0) >= 60 && ttk(h, 0) <= 125, h + ' humans: ' + ttk(h, 0).toFixed(0) + ' s');
    assert.ok(ttk(1, 5) >= 60 && ttk(1, 5) <= 130, 'one player and five bots: ' + ttk(1, 5).toFixed(0) + ' s');
    assert.ok(coreFinale.healthFor(1, 5) >= 10 * 51_000 * 0.7, 'about ten times harder');
    for (const e of entities.values()) if (e.isGemPickup) e.kill();
    p2.kill(); p3.kill(); bot.kill();
});

test('core: the bank path counts a Core payout like vault banking', () => {
    const vault = require(path.join(SERVER, 'game', 'terrain', 'vault.js'));
    const sock = fakeSocket({ packets: [] }); sock.talk = (...a) => sock.packets.push(a);
    const q = player(0, 0, sock);
    sock.gemBanked = 100;
    assert.equal(vault.creditBank(q, 6000), 6000);
    // (a bank milestone it crossed adds its own bonus on top, like at a vault)
    assert.ok(sock.gemBanked >= 6100, 'in the bank: ' + sock.gemBanked);
    assert.equal(q.carriedGems | 0, 0, 'not in the satchel');
    q.kill();
});

test('core: a new raid clears it and plans a new site; the raid clock is unchanged', () => {
    storm.setCycles(3);
    storm.start();
    const t0 = Date.now();
    coreFinale.newRaid();
    assert.equal(coreFinale.current(), null);
    assert.equal(coreFinale._state().state, 'planned');
    assert.ok(Math.abs(storm.endAt() - (t0 + 3 * storm.CYCLE_MS)) < 50);
    assert.equal(royale.RAID_CYCLES, 3);
    coreFinale.clear();
});

// ── drop-in ─────────────────────────────────────────────────────────────
test('dropin: a new player lands 520-760 from a safe vault, open and escapable, ore on the way', () => {
    storm.setCycles(3);
    storm.start();
    const n = player(0, 0);
    let got = null;
    for (let i = 0; i < 20 && !got; i++) got = dropIn.vaultSpot(n, [n]);
    assert.ok(got, 'a spot');
    const d = Math.hypot(got.x - got.vault.x, got.y - got.vault.y);
    assert.ok(d >= dropIn.VAULT_RING[0] - 1 && d <= dropIn.VAULT_RING[1] + 1, 'distance ' + d);
    assert.ok(!grid.pointInRock(got.x, got.y), 'open ground');
    spawnReach.invalidate();
    assert.ok(spawnReach.check(grid, got.x, got.y, { zone: { x: 0, y: 0, r: 2800 } }).ok, 'escapable');
    // ore seeded on the way, soft (through solid rock: an outer vault)
    let seeded = 0;
    for (const v of vault.getVaults()) {
        if (Math.hypot(v.x, v.y) < 200) continue;
        const before = grid.rockEvents.length;
        const sx = v.x * 0.6, sy = v.y * 0.6;
        const k = dropIn.seedOreOnWay(grid, sx, sy, v);
        assert.ok(grid.rockEvents.length - before === k && grid.rockEvents.slice(grid.rockEvents.length - k).every(e => e.bl === 1 && e.ore > 0));
        seeded += k;
    }
    assert.ok(seeded >= 2, 'seeded ' + seeded);
    // nobody else crowding the landing
    const crowd = player(got.x + 100, got.y);
    for (let i = 0; i < 10; i++) {
        const g2 = dropIn.vaultSpot(n, [n, crowd]);
        if (g2) assert.ok(Math.hypot(g2.x - crowd.x, g2.y - crowd.y) >= 1100);
    }
    crowd.kill(); n.kill();
});

test('dropin: the landing smashes the rock around and seeds ore on the rim, handing nothing out', () => {
    // a spot in solid rock, so the smash is visible
    let rock = null;
    for (const r of grid.rocks.values()) if (r.alive && !r.ore && Math.hypot(r.worldCx, r.worldCy) > 900 && Math.hypot(r.worldCx, r.worldCy) < 1800) { rock = r; break; }
    const p = player(rock.worldCx, rock.worldCy);
    const before = new Set([...entities.values()].filter(e => e.isGemPickup).map(e => e.id));
    const t = Date.now();
    const spill = dropIn.spillFor(true, true);
    assert.equal(spill, dropIn.SEED.newbie);
    assert.equal(dropIn.spillFor(false, true), 0, 'a respawn seeds nothing');
    const evAt = grid.rockEvents.length;
    const drop = dropIn.land(p, spill, t);
    assert.equal(drop.ms, dropIn.FALL_MS.first, 'a first drop falls the long way');
    // in the air it stays on its spot, whatever it tries
    p.velocity.x = 20; p.x += 50;
    dropIn.tick(t + 10);
    assert.ok(rock.alive, 'nothing before it lands');
    assert.equal(p.x, drop.x, 'held on the landing spot');
    assert.equal(p.velocity.x, 0);
    assert.equal(dropIn.inAir(p, t + 10), true);
    dropIn.tick(t + drop.ms + 1);
    assert.equal(dropIn.inAir(p, t + drop.ms + 1), false);
    assert.equal(rock.alive, false);
    let loose = 0;
    for (const e of entities.values()) if (e.isGemPickup && !before.has(e.id)) loose++;
    // nothing is handed out: no loose gems, nothing in the satchel; the gems
    // are in soft ore on the crater rim, for shooting
    assert.equal(loose, 0, 'loose gems at the landing');
    assert.equal(p.carriedGems | 0, 0, 'nothing went into the satchel');
    const seeded = grid.rockEvents.slice(evAt).filter(e => e.bl === 1 && e.ore > 0);
    assert.equal(seeded.length, spill, 'ore rocks on the rim');
    for (const ev of seeded) {
        const r = [...grid.rocks.values()].find(q => q.k === ev.k);
        const dd = Math.hypot(r.worldCx - p.x, r.worldCy - p.y);
        assert.ok(r.alive && r.ore && dd > dropIn.CRATER_R - 60 && dd < dropIn.CRATER_R + 200, 'rim rock at ' + Math.round(dd));
        assert.ok(r.health <= grid.plainRockHealth * 2, 'soft');
    }
    // a plain rock in the crater went, an ore rock did not
    let oreLeft = 0;
    for (const r of grid.rocks.values()) if (r.alive && r.ore && r.ore !== 4 && Math.hypot(r.worldCx - p.x, r.worldCy - p.y) < dropIn.CRATER_R - 60) oreLeft++;
    let plainLeft = 0;
    for (const r of grid.rocks.values()) if (r.alive && !r.ore && Math.hypot(r.worldCx - p.x, r.worldCy - p.y) < dropIn.CRATER_R - 60) plainLeft++;
    assert.equal(plainLeft, 0, 'plain rock left in the crater');
    p.kill();
    for (const e of entities.values()) if (e.isGemPickup) e.kill();
});

// how far (x, y) is from a rock's outline (0 inside)
const rockGap = (r, x, y) => { const f = grid.constructor._polyFace(r.worldPoly, x, y); return f.inside ? 0 : f.dist; };
test('dropin: a respawn in a mined-out pocket smashes the wall round it, wider for a grown tank', () => {
    for (const grown of [false, true]) {
        // one dead cell in solid plain rock: the walls are the cell's flat sides
        let cell = null;
        for (const r of grid.rocks.values()) {
            if (!r.alive || r.ore || r.canyon || !r.worldPoly) continue;
            const d = Math.hypot(r.worldCx, r.worldCy);
            if (d < 700 || d > 2000) continue;
            let solid = true;
            for (const q of grid.rocks.values()) if (q !== r && q.worldPoly && Math.hypot(q.worldCx - r.worldCx, q.worldCy - r.worldCy) < 260 && (!q.alive || q.ore === 4)) { solid = false; break; }
            if (solid) { cell = r; break; }
        }
        assert.ok(cell, 'a cell in solid rock');
        grid.damageRock(cell, cell.health + 1);
        const p = player(cell.worldCx, cell.worldCy);
        if (grown) { p.coreSize = p.SIZE * 3; p.refreshBodyAttributes(); }
        const t = Date.now();
        const drop = dropIn.land(p, 0, t);
        assert.ok(drop.r >= dropIn.IMPACT_R && drop.r >= p.realSize * 1.6 + 89, 'sized to the tank: ' + drop.r + ' for ' + Math.round(p.realSize));
        dropIn.tick(t + drop.ms + 1);
        let left = 0;
        for (const r of grid.rocks.values()) if (r.alive && !r.ore && r.worldPoly && rockGap(r, p.x, p.y) <= drop.r - 1) left++;
        assert.equal(left, 0, 'plain rock left inside ' + drop.r + (grown ? ' (grown)' : ''));
        p.kill();
    }
});

// the real spawn path, life after life: onHumanJoin queues the landing at
// level 1, sockets.js fills the levels after it (the hull doubles), the hit
// breaks every plain rock in range, and a landing in an open crater still
// reaches out to the nearest wall
test('dropin: die and respawn again and again, every landing smashes the rock round it', () => {
    const sk = fakeSocket({ packets: [] }); sk.talk = (...a) => sk.packets.push(a);
    try { royale.tick(); } catch { /* */ }
    const plainIn = (x, y, R) => { let n = 0; for (const r of grid.rocks.values()) if (r.alive && !r.ore && !r.canyon && r.worldPoly && rockGap(r, x, y) <= R) n++; return n; };
    for (let life = 0; life < 8; life++) {
        const p = new Entity({ x: 0, y: 0 });
        p.define('basic');
        p.isPlayer = true; p.team = -60 - life; p.name = 'Cycle'; p.alwaysActive = true;
        p.socket = sk; sk.player = { body: p }; p.sendMessage = () => {};
        sk.lastRaidDeathAt = life ? Date.now() - 4000 : 0;
        sk.packets.length = 0;
        const oreBefore = new Map();
        for (const r of grid.rocks.values()) if (r.alive) oreBefore.set(r.k, r.ore | 0);
        const evJoin = grid.rockEvents.length;
        royale.onHumanJoin(p);
        level45(p);
        if (life === 5) { p.sizeMultiplier = 3; p.refreshBodyAttributes(); }
        const fx = sk.packets.find(a => a[0] === 'FX' && a[3] === 'dropin');
        assert.ok(fx, 'life ' + life + ': it drops in');
        const R = Math.max(fx[5], dropIn.smashR(p, 0));
        assert.ok(fx[5] >= (life ? dropIn.IMPACT_R : dropIn.CRATER_R), 'radius ' + fx[5]);
        const near = plainIn(p.x, p.y, 380);
        const evAt = grid.rockEvents.length;
        dropIn.tick(Date.now() + fx[6] + 5);
        assert.equal(plainIn(p.x, p.y, R - 1), 0, 'life ' + life + ': plain rock left inside ' + R);
        const broke = grid.rockEvents.slice(evAt).filter(e => e.d === 1).length;
        if (near) assert.ok(broke > 0, 'life ' + life + ': rock within reach, so something broke');
        // what's left standing is ore, and the clients were told so (the spawn's
        // soft copper rock used to turn ore without a word: drawn as plain rock,
        // it looked like the landing had missed it)
        const told = grid.rockEvents.slice(evJoin);
        for (const r of grid.rocks.values()) {
            if (!r.alive || !r.ore || !r.worldPoly || rockGap(r, p.x, p.y) > R) continue;
            if (oreBefore.get(r.k) === r.ore) continue;
            assert.ok(told.some(e => e.k === r.k && e.bl === 1 && e.ore === r.ore), 'life ' + life + ': rock ' + r.k + ' turned ore ' + r.ore + ' unannounced');
        }
        p.kill();
        for (let i = 0; i < 3; i++) handler.gameloop();
    }
});

test('dropin: while it falls nothing gets through: no moving, no shooting, no dash or ability; then it all works', () => {
    const { ioTypes } = require(path.join(SERVER, 'miscFiles', 'controllers.js'));
    const p = player(1200, -1200);
    p.invuln = false; p.spawnGraceUntil = 0;
    const cmd = { up: true, down: false, left: false, right: true, lmb: true, autofire: false, moveX: 0, moveY: 0 };
    p.controllers = [new ioTypes.listenToPlayer(p, { player: { command: cmd, target: { x: 300, y: 0 } } })];
    const t = Date.now();
    const drop = dropIn.land(p, 0, t);
    assert.equal(drop.ms, dropIn.FALL_MS.respawn);
    assert.equal(global.royaleInFall(p), true, 'held from the moment it is queued');
    assert.equal(!!p.royaleFrozen, false, 'only the input: the raid itself goes on (damage, contracts, idle)');
    const x0 = p.x, y0 = p.y;
    const shots = () => [...entities.values()].filter(e => e.type === 'bullet' && e.master && e.master.id === p.id && !e.isDead()).length;
    for (let i = 0; i < 12; i++) { handler.gameloop(); dropIn.tick(Date.now()); }
    assert.equal(p.x, x0); assert.equal(p.y, y0);
    assert.equal(shots(), 0, 'no shots out');
    assert.equal(p.control.fire, false);
    // the socket handlers refuse upgrades, stat points and kit items too
    const sk = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    const inFall = 'global.royaleInFall && global.royaleInFall(player.body)';
    const guardAfter = (marker) => { const i = sk.indexOf(marker); return i >= 0 && sk.slice(i, i + 800).includes(inFall); };
    assert.ok(guardAfter('case "U": {'), 'U guard');
    assert.ok(guardAfter('case "x": {'), 'x guard');
    { const i = sk.indexOf('// kit use: slot, world x, world y'); assert.ok(i >= 0 && sk.slice(i, i + 700).includes(inFall), 'kit guard'); }
    assert.ok(guardAfter("// dash (0), ability at a world spot"), 'ability guard');
    assert.ok(/royaleInFall\(player\.body\)\)\)\) \{\s+player\.command\.lmb = player\.command\.mmb/.test(sk), 'C packet zeroed (touch analog too)');
    // landing: the freeze is lifted, the keys work
    dropIn.tick(t + drop.ms + 1);
    assert.equal(global.royaleInFall(p), false);
    for (let i = 0; i < 8; i++) handler.gameloop();
    assert.ok(Math.hypot(p.x - x0, p.y - y0) > 1, 'moves after the landing');
    // the client side holds its keys and banners for the fall
    const cl = fs.readFileSync(path.join(REPO, 'public', 'client', 'socketinit.js'), 'utf8');
    assert.ok(/held = raidHeat\.inputHeld\(\)/.test(cl) && /if \(held\) \{ socket\.talk\('C', [^\n]*global\.reverseTank, 0\); return; \}/.test(cl));
    p.kill();
});

test('dropin: the raid-end freeze is not lifted by a landing; the hold lifts on its own', () => {
    const p = player(1400, -1400);
    const drop = dropIn.land(p, 0, Date.now());
    p.royaleFrozen = true;            // the raid ended mid-fall (setFrozen)
    dropIn.tick(Date.now() + drop.ms + 1);
    assert.equal(p.royaleFrozen, true);
    // nothing ticking: past its time it's over anyway
    const q = player(1500, -1500);
    q._dropHoldUntil = Date.now() - 1;
    assert.equal(global.royaleInFall(q), false);
    p.kill(); q.kill();
});

test('resume: a reload keeps its team and colour, and drops back in on screen only', () => {
    captureRY();
    const sock = fakeSocket({ resumeToken: 'tokHeat' + ids + 'abcdefgh', packets: [] });
    sock.talk = (...a) => sock.packets.push(a);
    const tank = player(800, 800, sock);
    tank.team = -4321;
    global.royaleTeamColors.set(-4321, 13);
    tank.color.base = 13;
    tank.invuln = false; tank.carriedGems = 200;   // something to protect: it resumes in place
    royale.disconnectCleanup(sock, tank);
    tank.kill(); for (let i = 0; i < 2; i++) handler.gameloop();
    // while it waits nobody else is handed that colour
    for (let i = 0; i < 12; i++) assert.notEqual(global.assignTeamColor(-5000 - i), 13, 'the waiting colour went to someone else');
    const back = fakeSocket({ resumeToken: sock.resumeToken, packets: [] });
    back.talk = (...a) => back.packets.push(a);
    assert.equal(royale.claimResume(back, sock.resumeToken), true);
    const kept = royale.resumeTeam(back);
    assert.deepEqual(kept, { team: -4321, color: 13 });
    // the spawn path uses it
    const sk = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.ok(/if \(kept\) team = kept\.team;/.test(sk) && /const c = kept \? kept\.color : global\.assignTeamColor\(team\);/.test(sk));
    const body = player(0, 0, back);
    body.team = kept.team; body.color.base = kept.color;
    const before = new Set([...grid.rocks.values()].filter(r => r.alive).map(r => r.k));
    royale.applyPendingResume(back);
    const fx = back.packets.filter(p => p[0] === 'FX' && p[3] === 'dropin');
    assert.equal(fx.length, 1, 'a drop is drawn');
    assert.equal(fx[0][7], 1, 'marked as just a picture');
    assert.equal(fx[0][6], dropIn.FALL_MS.first, 'the full first fall, drawn');
    assert.equal(fx[0][5], dropIn.CRATER_R);
    assert.equal(!!body.royaleFrozen, false, 'nothing held');
    assert.equal(dropIn.inAir(body), false);
    // the resume itself opens up rock that grew into the hull's spot; past
    // the hull nothing goes (no crater)
    const gone = [...grid.rocks.values()].filter(r => before.has(r.k) && !r.alive);
    for (const r of gone) assert.ok(Math.hypot(r.worldCx - body.x, r.worldCy - body.y) < (body.realSize || 30) * 1.5 + 140, 'rock smashed past the hull');
    // a team someone alive holds now is not handed back
    const sock2 = fakeSocket({ resumeToken: 'tokHeatB' + ids + 'abcdefgh' });
    const t2 = player(900, 900, sock2); t2.team = -4400;
    royale.disconnectCleanup(sock2, t2); t2.kill(); handler.gameloop();
    const squatter = player(950, 950); squatter.team = -4400;
    const back2 = fakeSocket({ resumeToken: sock2.resumeToken });
    royale.claimResume(back2, sock2.resumeToken);
    assert.equal(royale.resumeTeam(back2), null);
    body.kill(); squatter.kill();
});

test('dropin: bots fall in too and are held; spawns near the action keep their distance', () => {
    storm.setCycles(3); storm.start();
    const seen = [];
    const cam = fakeSocket({ camera: { x: 1700, y: 300 } }); cam.talk = (...a) => seen.push(a);
    dropIn.attach({ clients: () => [cam], live: () => true });
    const b = player(1700, 300);
    b.isPlayer = false; b.socket = null; b.isBot = true;
    const d = dropIn.landBot(b);
    assert.equal(d.ms, dropIn.FALL_MS.bot);
    assert.equal(global.royaleInFall(b), true, 'held');
    assert.ok(seen.some(a => a[0] === 'FX' && a[3] === 'dropin' && a[4] === b.id), 'drawn for whoever sees it');
    b.kill();
    assert.ok(dropIn.FALL_MS.first >= 1900 && dropIn.FALL_MS.respawn >= 1100, 'longer falls');
    // near the action: a fight going on, 520-900 away from every enemy
    const me = player(-1800, -300);
    const a1 = player(400, 400), a2 = player(520, 420);
    a1._lastDamageAt = Date.now();
    let got = null;
    for (let i = 0; i < 10 && !got; i++) got = dropIn.actionSpot(me, [me, a1, a2]);
    assert.ok(got, 'a spot');
    for (const o of [a1, a2]) assert.ok(Math.hypot(got.x - o.x, got.y - o.y) >= dropIn.ACTION_RING[0], 'not on top of an enemy');
    assert.ok(!grid.pointInRock(got.x, got.y));
    me.kill(); a1.kill(); a2.kill();
});

test('meteors: each one is announced falling before it lands, and spills 2-3 gems', () => {
    const raidEvents = require(path.join(SERVER, 'game', 'terrain', 'raidEvents.js'));
    raidEvents.reset();
    const sent = [];
    const c = fakeSocket(); c.talk = (...a) => sent.push(a);
    global.gameManager.socketManager.clients = [c];
    const t = Date.now();
    const ev = raidEvents.startMeteor(t);
    assert.ok(ev);
    raidEvents.tick(ev.liveAt - 600);
    const fall = sent.filter(a => a[0] === 'FX' && a[3] === 'meteorfall');
    assert.equal(fall.length, 1, 'the first one is on its way');
    assert.ok(fall[0][4] > 0 && fall[0][4] <= 800);
    const before = new Set([...entities.values()].filter(e => e.isGemPickup).map(e => e.id));
    raidEvents.tick(ev.liveAt + 1);
    const hit = sent.filter(a => a[0] === 'FX' && a[3] === 'meteor');
    assert.ok(Math.abs(hit.length ? hit[0][1] - fall[0][1] : 0) <= 1, 'lands where it was drawn falling');
    const spilled = [...entities.values()].filter(e => e.isGemPickup && !before.has(e.id) && Math.hypot(e.x - fall[0][1], e.y - fall[0][2]) < 140).length;
    assert.ok(spilled >= 2, 'gems ' + spilled);
    global.gameManager.socketManager.clients = [];
    raidEvents.reset();
    for (const e of entities.values()) if (e.isGemPickup) e.kill();
});

// ── supply drops / the opening ─────────────────────────────────────────
test('supply: announced 10 s ahead near a player, falls, lands as a crate that unlocks an ability', () => {
    const supply = require(path.join(SERVER, 'game', 'terrain', 'supplyDrops.js'));
    const chests = require(path.join(SERVER, 'game', 'terrain', 'chests.js'));
    const abilities = require(path.join(SERVER, 'game', 'terrain', 'abilities.js'));
    storm.setCycles(3); storm.start();
    supply.reset();
    const sock = fakeSocket({ packets: [] }); sock.talk = (...a) => sock.packets.push(a);
    const p = player(-900, 600, sock);
    const other = player(-700, 500);
    const said = [];
    let age = 0;
    supply.attach({ humans: () => [p], fighters: () => [p, other], clients: () => [sock], idle: () => false, live: () => true,
        raidAge: () => age, announce: (text) => said.push(text), compass: () => 'the west' });
    const t0 = Date.now();
    age = 20_000; supply.tick(t0);
    age = 34_000; supply.tick(t0 + 14_000);
    assert.equal(supply.snapshot(t0 + 14_000), undefined, 'nothing before 35 s');
    age = 35_100; supply.tick(t0 + 15_100);
    const soon = supply.snapshot(t0 + 15_100);
    assert.equal(soon.s, 'soon');
    assert.ok(Math.abs(soon.left - supply.WARN_MS) < 200);
    assert.ok(said.some(x => /Supply drop incoming/.test(x)));
    const dP = Math.hypot(soon.x - p.x, soon.y - p.y);
    // 450-800 out; a crowded first pass widens to 350-1100
    assert.ok(dP >= 340 && dP <= 1110, 'near the player: ' + Math.round(dP));
    assert.ok(Math.hypot(soon.x - other.x, soon.y - other.y) >= 320, 'not on anyone');
    assert.ok(sock.packets.some(a => a[0] === 'FX' && a[3] === 'supplysoon'), 'map ping');
    const at = t0 + 15_100 + supply.WARN_MS;
    supply.tick(at - supply.FALL_MS + 10);
    assert.ok(sock.packets.some(a => a[0] === 'FX' && a[3] === 'supplyfall'), 'falls in');
    supply.tick(at + 1);
    const down = supply.snapshot(at + 1);
    assert.equal(down.s, 'down');
    const crate = chests.alive().find(c => c.isSupplyCrate);
    assert.ok(crate && crate.chestRare && crate.supplyDrop && crate.chestItem, 'an epic chest with a kit item');
    assert.equal(crate.chestGems, supply.CRATE_GEMS);
    assert.ok(Math.hypot(crate.x - soon.x, crate.y - soon.y) < 1, 'exactly on its marker: ' + Math.round(Math.hypot(crate.x - soon.x, crate.y - soon.y)));
    assert.equal(Math.round(crate.size), supply.CRATE_SIZE, 'a crate is bigger than a chest');
    assert.equal(soon.z, supply.CRATE_SIZE, 'the marker knows its size');
    const fall = sock.packets.find(a => a[0] === 'FX' && a[3] === 'supplyfall');
    assert.equal(fall[1], soon.x); assert.equal(fall[2], soon.y); assert.equal(fall[5], supply.CRATE_SIZE);
    const foot = (r) => r.worldPoly && rockGap(r, crate.x, crate.y) <= crate.size + 10;
    for (const r of grid.rocks.values()) if ((r.alive || r.growing) && foot(r)) assert.fail('rock under the crate: ' + r.k);
    // minutes later, nothing has grown back into it
    const realNow = Date.now;
    try {
        let skew = 0;
        Date.now = () => realNow() + skew;
        for (let i = 0; i < 400; i++) { skew += 500; grid.regrowTick(Date.now()); }
        for (const r of grid.rocks.values()) if ((r.alive || r.growing) && foot(r)) assert.fail('rock grew over the crate: ' + r.k);
    } finally { Date.now = realNow; }
    assert.equal(supply.current().state, 'down');
    // open it: a new ability for the raid
    const before = abilities.ON ? (abilities.stateOf(sock).own || []).slice() : [];
    chests.openChest(crate, p);
    for (let i = 0; i < 3; i++) handler.gameloop();
    if (abilities.ON) {
        const own = abilities.stateOf(sock).own || [];
        assert.equal(own.length, before.length + 1, 'an ability unlocked');
    }
    supply.tick(at + 100);
    assert.equal(supply.snapshot(at + 100), undefined);
    // the next one is a minute or so later
    age = 50_000; supply.tick(at + 100 + 59_000);
    assert.equal(supply.snapshot(at + 100 + 59_000), undefined);
    supply.tick(at + 100 + 76_000);
    assert.equal(supply.snapshot(at + 100 + 76_000).s, 'soon');
    supply.reset();
    for (const e of entities.values()) if (e.isGemPickup || e.isLootChest) e.kill();
    p.kill(); other.kill();
});

test('supply: a crowd round every player still gets a drop (the search widens), and no spot at all retries soon', () => {
    const supply = require(path.join(SERVER, 'game', 'terrain', 'supplyDrops.js'));
    storm.setCycles(3); storm.start();
    supply.reset();
    const p = player(-900, 600);
    // tanks all round the ring the first pass looks in
    const crowd = [];
    for (let i = 0; i < 18; i++) {
        const a = i / 18 * Math.PI * 2;
        crowd.push({ x: p.x + Math.cos(a) * 620, y: p.y + Math.sin(a) * 620, isDead: () => false, realSize: 30, velocity: { x: 0, y: 0 } });
    }
    let fighters = [p, ...crowd];
    let humans = [p];
    supply.attach({ humans: () => humans, fighters: () => fighters, clients: () => [], idle: () => false, live: () => true,
        raidAge: () => 60_000, announce() {}, compass: () => 'the west' });
    for (let k = 0; k < 20; k++) {
        const spot = supply.pickSpot(Date.now());
        assert.ok(spot, 'a spot, try ' + k);
        for (const o of fighters) assert.ok(Math.hypot(o.x - spot.x, o.y - spot.y) >= 140, 'never on a tank');
    }
    // nobody to drop it for: no plan, and it looks again within a few seconds
    humans = [];
    const t0 = Date.now();
    supply.debugNow(t0);
    assert.equal(supply.snapshot(t0), undefined);
    humans = [p]; fighters = [p];
    supply.tick(t0 + 3500);
    assert.equal((supply.snapshot(t0 + 3500) || {}).s, 'soon', 'it came anyway');
    supply.reset();
    p.kill();
});

test('supply: a new drop never lands near another crate (900 away) or on a chest', () => {
    const supply = require(path.join(SERVER, 'game', 'terrain', 'supplyDrops.js'));
    const chests = require(path.join(SERVER, 'game', 'terrain', 'chests.js'));
    storm.setCycles(3); storm.start();
    supply.reset();
    const p = player(-900, 600);
    supply.attach({ humans: () => [p], fighters: () => [p], clients: () => [], idle: () => false, live: () => true,
        raidAge: () => 60_000, announce() {}, compass: () => 'the west' });
    // a crate already down right next to the player, and a chest the other side
    const old = chests.spawnChest(p.x + 600, p.y, true, { exact: true, size: supply.CRATE_SIZE });
    old.supplyDrop = true;
    const chest = chests.spawnChest(p.x - 500, p.y, false, { exact: true });
    for (let k = 0; k < 40; k++) {
        const s = supply.pickSpot(Date.now());
        assert.ok(s, 'still a spot');
        assert.ok(Math.hypot(s.x - old.x, s.y - old.y) >= supply.CRATE_GAP, 'too near the other crate: ' + Math.hypot(s.x - old.x, s.y - old.y).toFixed(0));
        assert.ok(Math.hypot(s.x - chest.x, s.y - chest.y) >= supply.CHEST_GAP, 'on a chest');
    }
    old.kill(); chest.kill(); p.kill();
    for (let i = 0; i < 2; i++) handler.gameloop();
    supply.reset();
});

test('supply: anyone on the landing spot is rolled off and warned, and nobody ends up inside the crate', () => {
    const supply = require(path.join(SERVER, 'game', 'terrain', 'supplyDrops.js'));
    const chests = require(path.join(SERVER, 'game', 'terrain', 'chests.js'));
    storm.setCycles(3); storm.start();
    supply.reset();
    const sock = fakeSocket({ packets: [] });
    const said = [];
    const p = player(-1200, -900, sock);
    p.sendMessage = (m) => said.push(m);
    const bot = player(-1200, -500); bot.socket = null; bot.isBot = true;
    let age = 40_000;
    const fighters = [p, bot];
    supply.attach({ humans: () => [p], fighters: () => fighters, clients: () => [sock], idle: () => false, live: () => true,
        raidAge: () => age, announce() {}, compass: () => 'the west' });
    const t0 = Date.now();
    const plan = supply.debugNow(t0);
    assert.ok(plan, 'a drop is coming');
    // both stand right on it
    p.x = plan.x + 20; p.y = plan.y; bot.x = plan.x - 10; bot.y = plan.y + 5;
    for (const b of fighters) { b.velocity.x = 0; b.velocity.y = 0; }
    supply.tick(t0 + 50);
    for (const b of fighters) {
        const out = (b.x - plan.x) * b.velocity.x + (b.y - plan.y) * b.velocity.y;
        assert.ok(out > 0 && Math.hypot(b.velocity.x, b.velocity.y) >= 6, 'rolled outward');
    }
    assert.ok(said.some(m => /Move! Supply drop incoming/.test(m)), 'the player is told');
    const said0 = said.length;
    supply.tick(t0 + 100);
    assert.equal(said.length, said0, 'not every tick');
    // the bot stands its ground: still on it at the hit, it goes to the rim
    bot.x = plan.x; bot.y = plan.y;
    p.x = plan.x + 600; p.y = plan.y;
    supply.tick(plan.at + 1);
    const crate = chests.alive().find(c => c.isSupplyCrate);
    assert.ok(crate, 'it landed');
    const gap = Math.hypot(bot.x - crate.x, bot.y - crate.y) - crate.realSize - bot.realSize;
    assert.ok(gap >= 0, 'not inside the crate: ' + gap.toFixed(1));
    supply.reset();
    for (const e of entities.values()) if (e.isGemPickup || e.isLootChest) e.kill();
    p.kill(); bot.kill();
});

test('opening: every drop pit gets a soft vein nearby; the 1:30 meteor rush lands round the busiest player', () => {
    const opening = require(path.join(SERVER, 'game', 'terrain', 'raidOpening.js'));
    const raidEvents = require(path.join(SERVER, 'game', 'terrain', 'raidEvents.js'));
    const { ORE } = require(path.join(SERVER, 'game', 'terrain', 'terrainGrid.js'));
    global.royaleMods = {};
    const n = opening.seedPits();
    assert.ok(n >= grid.spawnPits.length * 0.8, 'seeded ' + n + ' for ' + grid.spawnPits.length + ' pits');
    let veinNear = 0;
    for (const pit of grid.spawnPits) {
        if ([...grid.rocks.values()].some(r => r.alive && r.ore >= ORE.VEIN && r.ore !== ORE.EMERALD && Math.hypot(r.worldCx - pit.x, r.worldCy - pit.y) <= 430)) veinNear++;
    }
    assert.ok(veinNear >= grid.spawnPits.length * 0.8, 'pits with better than copper close by: ' + veinNear);
    raidEvents.reset();
    const busy = player(800, -800), mate1 = player(900, -700), lone = player(-1600, 1200);
    let age = 0;
    const evs = [];
    opening.attach({ humans: () => [lone, busy], fighters: () => [busy, mate1, lone], compass: () => 'the east', onEvent: (e) => evs.push(e), raidAge: () => age, live: () => true });
    opening.newRaid();
    age = 80_000; opening.tick(Date.now());
    assert.equal(evs.length, 0);
    age = 91_000; opening.tick(Date.now());
    assert.equal(evs.length, 1, 'the rush');
    const ev = raidEvents.current();
    assert.equal(ev.kind, 'meteor');
    const d = Math.hypot(ev.x - busy.x, ev.y - busy.y);
    assert.ok(d >= 250 && d <= 430, 'round the busiest player: ' + Math.round(d));
    age = 200_000; opening.tick(Date.now());
    assert.equal(evs.length, 1, 'once a raid');
    raidEvents.reset();
    busy.kill(); mate1.kill(); lone.kill();
});

// ── rattler ─────────────────────────────────────────────────────────────
test('rattler: new players only, behind them from the vault, once a raid, gives up at the pad', () => {
    storm.setCycles(3);
    storm.start();
    rattler.reset();
    const said = [];
    rattler.attach({ callout: (b, k) => said.push(k), fxAt() {}, newness: (b) => b._testNew });
    const v = centre();
    const p = player(v.x + 900, v.y);
    p.royaleBornAt = Date.now() - 20_000;
    p.spawnGraceUntil = 0;
    p.carriedGems = 300;
    p._testNew = 0;
    assert.equal(rattler.wants(p, Date.now()), false, 'a regular gets real bots, not this');
    p._testNew = 1;
    assert.equal(rattler.wants(p, Date.now()), true);
    p.carriedGems = 40;
    assert.equal(rattler.wants(p, Date.now()), false, 'nothing to lose yet');
    p.carriedGems = 300;
    rattler.tick(Date.now() + 1000, [p]);
    const r = rattler.alive()[0];
    assert.ok(r, 'spawned');
    assert.ok(said.includes('rattler'));
    // on the far side of the player from the vault
    assert.ok(Math.hypot(r.x - v.x, r.y - v.y) > Math.hypot(p.x - v.x, p.y - v.y) + 300);
    assert.equal(r.rattlerPrey, p);
    assert.equal(rattler.wants(p, Date.now()), false, 'once a raid');
    // reaching the vault pad ends it
    p.vaultOnPad = true;
    rattler.tick(Date.now() + 2000, [p]);
    assert.equal(rattler.alive().length, 0);
    assert.ok(said.includes('escaped'));
    rattler.reset();
    p._testNew = 1; p.vaultOnPad = false;
    assert.equal(rattler.wants(p, Date.now()), true, 'a new raid, a new chase');
    p.kill();
});

// ── client FX math ──────────────────────────────────────────────────────
test('juice: shake is capped, glitch slices stay on screen, the particle pool never grows', async () => {
    const J = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'juiceMath.js')).href);
    assert.equal(J.shakeFor(0), 0);
    assert.ok(J.shakeFor(1e6) <= J.SHAKE_MAX);
    assert.ok(J.shakeFor(50) > J.shakeFor(10));
    const out = J.makeSlices(8);
    for (let seed = 1; seed < 200; seed++) {
        const n = J.planGlitch(seed, Math.random(), 1920, 1080, out);
        assert.ok(n >= 0 && n <= out.length);
        for (let i = 0; i < n; i++) {
            const s = out[i];
            assert.ok(s.y >= 0 && s.h > 0 && s.y + s.h <= 1080, 'slice in view');
            assert.ok(s.x >= 0 && s.w > 0 && s.x + s.w <= 1920, 'block in view');
            assert.ok(Math.abs(s.dx) <= J.GLITCH_DX_MAX * 1920 / 1000 + 1e-6);
        }
    }
    assert.equal(J.planGlitch(5, 0, 1920, 1080, out), 0, 'no strength, no slices');
    const pool = J.makePool(16);
    for (let i = 0; i < 100; i++) J.emit(pool, 0, 0, Math.random() * 6, 3, 400, 0, i);
    assert.equal(pool.items.length, 16);
    assert.equal(J.liveCount(pool, 0), 16);
    assert.equal(J.liveCount(pool, 10_000), 0);
    // heartbeat: faster with a closer, aiming enemy, never past the floor
    assert.ok(J.threatOf(200, 0.1, 900) > J.threatOf(800, 0.1, 900));
    assert.ok(J.threatOf(200, 0.1, 900) > J.threatOf(200, 2.5, 900));
    assert.equal(J.threatOf(2000, 0, 900), 0);
    assert.ok(J.huntTension(1, 1) <= 1 && J.huntTension(1, 0) > 0.3 && J.huntTension(0, 1) === 0);
});

test('juice: the sky drop falls faster as it comes down, the camera dives and settles', async () => {
    const J = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'juiceMath.js')).href);
    assert.equal(J.fallHeight(0), 1);
    assert.equal(J.fallHeight(1), 0);
    // speeding up: the last tenth covers more height than the first
    assert.ok((J.fallHeight(0.9) - J.fallHeight(1)) > (J.fallHeight(0) - J.fallHeight(0.1)) * 5);
    for (let k = 0; k < 1; k += 0.05) assert.ok(J.fallHeight(k + 0.05) <= J.fallHeight(k), 'never goes back up');
    // the camera: high at the start, past normal just before the hit, back to 1 after
    assert.equal(J.dropZoom(0), J.DROP_ZOOM_FROM);
    assert.ok(J.dropZoom(0.99) > 1 && J.dropZoom(0.99) <= 1 + J.DROP_DIVE + 1e-9);
    assert.ok(J.dropZoom(1, 0) > 1);
    assert.equal(J.dropZoom(1, 400), 1);
    for (let k = 0; k < 0.9; k += 0.05) assert.ok(J.dropZoom(k + 0.05) >= J.dropZoom(k));
    // high up for a drop-in: a big chunk of the map, a respawn starts lower
    assert.ok(J.DROP_ZOOM_FROM >= 0.35 && J.DROP_ZOOM_FROM <= 0.4);
    assert.equal(J.dropZoom(0, 0, 0.5), 0.5);
    // it hangs up there a beat, then dives: the second half covers most of it
    assert.ok(J.dropZoom(0.5) - J.dropZoom(0) < J.dropZoom(0.9) - J.dropZoom(0.5));
    // the view never runs off the room: near the edge the widest zoom is held back
    assert.ok(J.edgeZoom(1000, 1, 3000, 0) < 0.4, 'mid-map: free to go far out');
    assert.ok(J.edgeZoom(1000, 1, 3000, 2600) > 0.9, 'by the edge: held near normal');
    assert.ok(Math.max(J.dropZoom(0), J.edgeZoom(1000, 1, 3000, 2000)) * 1 * (3000 - 2000) >= 1000 - 1e-6, 'view inside the room');
});

test('juice: quality drops on slow frames, climbs back slowly, ignores stalls; counts scale', async () => {
    const J = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'juiceMath.js')).href);
    let q = 1;
    for (let i = 0; i < 60; i++) q = J.nextQuality(q, 33);
    assert.equal(q, 0.25, 'floor');
    const slow = q;
    for (let i = 0; i < 20; i++) q = J.nextQuality(q, 16);
    assert.ok(q > slow && q < 0.5, 'slow recovery ' + q);
    assert.equal(J.nextQuality(0.8, 5000), 0.8, 'a hidden tab is not a slow machine');
    assert.equal(J.fxScale(0, 1), J.LEVEL_MULT[0]);
    assert.equal(J.fxScale(2, 1), J.LEVEL_MULT[2]);
    assert.ok(J.fxScale(1, 0.25) < J.fxScale(1, 1));
    assert.equal(J.countFor(0, 2), 0);
    assert.equal(J.countFor(5, 0.01), 1, 'at least one when asked');
    assert.equal(J.countFor(10, 1.6), 16);
});

test('juice: cracks are fixed per seed and stay in reach; counters roll up; kills combo', async () => {
    const J = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'juiceMath.js')).href);
    const a = J.crackPaths(7, 9, 5, 1), b = J.crackPaths(7, 9, 5, 1);
    assert.deepEqual(a, b);
    assert.equal(a.length, 9);
    for (const p of a) {
        assert.equal(p.length, 12);
        for (let i = 0; i < p.length; i += 2) assert.ok(Math.hypot(p[i], p[i + 1]) <= 1 + 1e-9);
    }
    assert.equal(J.rollValue(0, 1240, 0), 0);
    assert.equal(J.rollValue(0, 1240, 1), 1240);
    assert.ok(J.rollValue(0, 1240, 0.5) > 620, 'fast then slow');
    let n = 0, at = -1e9;
    n = J.comboAfter(n, at, 1000); at = 1000;
    assert.equal(n, 1); assert.equal(J.comboLabel(n), '');
    n = J.comboAfter(n, at, 4000); at = 4000;
    n = J.comboAfter(n, at, 9000); at = 9000;
    assert.equal(J.comboLabel(n), 'x3');
    assert.equal(J.comboAfter(n, at, 9000 + J.COMBO_MS + 1), 1, 'the window closes');
});

test('switches: every kill switch is documented', () => {
    const env = fs.readFileSync(path.join(SERVER, '.env.example'), 'utf8');
    for (const k of ['ROYALE_HUNTED', 'ROYALE_CORE', 'ROYALE_DROPIN', 'ROYALE_FIRST_VAULT', 'ROYALE_RATTLER', 'ROYALE_SUPPLY', 'ROYALE_EARLY_ORE', 'ROYALE_RUSH']) assert.ok(new RegExp('^#?\\s*' + k + '=', 'm').test(env), k);
    assert.equal(hunted.ON, process.env.ROYALE_HUNTED !== '0');
    assert.equal(coreFinale.ON, process.env.ROYALE_CORE !== '0');
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
