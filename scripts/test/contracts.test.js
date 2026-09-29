// Contracts and pacing: node scripts/test/contracts.test.js
//
// Runs the real game loop (the chestKill pattern) with the raid script
// loaded, so rewards go through the same bank, board and callouts a live
// raid uses.
//
//   fresh      a new spawn gets an easy job near it inside 10 s (the chest
//              next to it), with the "Drop in!" cue naming it
//   context    a full satchel gets a bank job pointing at a safe vault, the
//              boss gets a boss job, the storm closing in a zone job, a
//              fight a hunt job
//   complete   a bank job pays its reward once, into the bank and the board,
//              with one callout; the next one rolls after the gap
//   chest      cracking the contract's chest in the game loop completes it
//   expiry     a job that runs out is marked missed and a new one rolls
//   idle       an idle player gets nothing rolled, loses the running job and
//              is never paid; the coach being on holds contracts back
//   revenge    a bot that kills you is marked for you; killing it pays the
//              revenge bonus once
//   pacing     a quiet raid gets a supply drop or bounty after 60-90 s, a
//              beat resets the clock, the lock holds it off; the bounty pays
//              whoever takes the target down; supply drops sit outside the
//              chest budget
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `contracts-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-contracts-test-'));
fs.mkdirSync(ROOT, { recursive: true });
process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['ROYALE_DEBUG', 'ACCOUNTS_ENABLED']) delete process.env[k];

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
const contracts = T('contracts.js');
const pacing = T('pacing.js');
const chests = T('chests.js');
const bosses = T('bosses.js');
const storm = T('storm.js');
const vault = T('vault.js');
const shop = T('shop.js');
const milestones = T('milestones.js');
const activity = require(path.join(SERVER, 'game', 'network', 'activity.js'));

// Two vaults and a shop, cached by their modules; the game loop itself runs
// with no terrain grid.
global.gameManager.terrainGrid = {
    vaultSites: [{ x: 0, y: -3000, r: 95 }, { x: 0, y: 6000, r: 95 }],
    shopSites: [{ id: 0, name: 'Shop', x: 3000, y: 0, r: 95 }],
    outpostSites: [], spawnPits: [],
};
vault.getVaults(); shop.getShops();
global.gameManager.terrainGrid = null;
storm.start();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let seq = 0, nextY = -8000;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'ct' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    return s;
}
function spawnTank(x, y) {
    const sock = mkSocket();
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - (++seq);
    t.name = 'Tester' + seq;
    t.alwaysActive = true;
    t.sendMessage = () => {};
    const player = { socket: sock, body: t, target: { x: 120, y: 0 }, command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, autofire: false, autospin: false, override: false } };
    sock.player = player;
    t.socket = sock;
    level45(t);
    global.gameManager.socketManager.clients.push(sock);
    global.gameManager.socketManager.players.push(player);
    royale.onHumanJoin(t);
    // put it back where the case wants it (the spawn picker moved it)
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
function remove(...list) {
    for (const e of list) {
        if (!e) continue;
        const sm = global.gameManager.socketManager;
        if (e.socket) {
            sm.players = sm.players.filter(p => p.body !== e);
            sm.clients = sm.clients.filter(c => c !== e.socket);
        }
        const bots = global.gameManager.gameHandler.bots;
        const i = bots.indexOf(e);
        if (i >= 0) bots.splice(i, 1);
        try { e.kill(); } catch { /* */ }
    }
    loop(2);
}
const kc = (sock, kind) => sock.packets.filter(p => p[0] === 'KC' && p[1] === kind);
// run the director at time t (it throttles itself to 4 Hz)
function at(t) { contracts.tick(t); return t; }
function settle(tank, t0 = Date.now()) {
    let t = t0;
    for (let i = 0; i < 12 && !(tank.socket.contract && tank.socket.contract.state === 0); i++) at(t += 300);
    return t;
}
function clearWorld() {
    chests.clearAll();
    const b = bosses.current();
    if (b) { b.bossBurrowed = true; b.kill(); }
    loop(2);
}

test('fresh: a new spawn gets the chest next to it within 10 s, and the drop-in cue names it', () => {
    clearWorld();
    const tank = spawnTank(0, nextY += 2000);
    const chest = chests.spawnChest(tank.x + 500, tank.y, false, { item: null });
    const t0 = Date.now();
    at(t0 + 200);
    assert.equal(tank.socket.contract, null, 'nothing before the tank has settled');
    const t = settle(tank, t0);
    assert.ok(t - t0 <= 10_000, 'rolled at +' + (t - t0));
    const c = tank.socket.contract;
    assert.equal(c.kind, 'chest');
    assert.equal(c.ent, chest);
    assert.match(c.text, /^Crack the copper chest (to the east|nearby)$/);
    assert.equal(c.reward, contracts.REWARDS.chest);
    const cue = kc(tank.socket, 'dropin');
    assert.equal(cue.length, 1);
    assert.equal(cue[0][2], 'Drop in!');
    assert.equal(cue[0][4], c.text);
    // the raid packet's view of it: points at the chest entity
    const snap = contracts.snapshotFor(tank.socket, tank, t);
    assert.equal(snap.k, 'chest');
    assert.equal(snap.e, chest.id);
    assert.equal(snap.st, 0);
    assert.ok(snap.ms > 30_000);
    remove(tank);
    clearWorld();
});

test('context: full satchel -> bank at the nearest safe vault; boss up -> boss; storm closing -> zone; a fight -> hunt', () => {
    clearWorld();
    // well past fresh
    const tank = spawnTank(0, -2000);
    tank.royaleBornAt = Date.now() - 60_000;
    tank.carriedGems = 1000;
    let t = settle(tank);
    let c = tank.socket.contract;
    assert.equal(c.kind, 'bank', 'got ' + c.kind);
    assert.equal(c.goal, 800);
    assert.deepEqual([c.target.x, c.target.y], [0, -3000], 'the near vault');
    assert.equal(c.reward, 120);
    tank.socket.contract = null; tank.socket.contractNextAt = 0;

    // the boss (not a full satchel any more)
    tank.carriedGems = 50;
    const boss = bosses.spawn('warden');
    boss.x = tank.x + 900; boss.y = tank.y;
    t = settle(tank, t + 1000);
    c = tank.socket.contract;
    assert.equal(c.kind, 'boss', 'got ' + c.kind);
    assert.equal(c.goal, Math.round(boss.health.max * 0.1));
    bosses.debugHit(tank, c.goal * 0.4);
    at(t += 300);
    assert.ok(c.prog > 0 && c.state === 0);
    bosses.debugHit(tank, c.goal * 0.7);
    at(t += 300);
    assert.equal(c.state, 1, 'done at 10%');
    assert.equal(kc(tank.socket, 'contract').length, 1);
    assert.match(kc(tank.socket, 'contract')[0][4], /^\+300 gems/);
    boss.bossBurrowed = true; boss.kill(); loop(2);

    // the storm about to reach you: nothing beats getting out
    tank.socket.contract = null; tank.socket.contractNextAt = 0;
    const st = storm.snapshot();
    const r = storm.radius(Date.now() + 5000, true);
    tank.x = st.cx + r + 200; tank.y = st.cy;
    t = settle(tank, t + 3000);
    c = tank.socket.contract;
    assert.equal(c.kind, 'zone');
    tank.x = st.cx; tank.y = st.cy;
    at(t += 300);
    assert.equal(c.state, 1);

    // someone shooting at you (and nothing bought yet would offer the shop too)
    tank.socket.contract = null; tank.socket.contractNextAt = 0;
    shop.stateOf(tank.socket).spent = 1;
    const foe = bot(tank.x + 500, tank.y);
    tank._lastDamageAt = t + 3000;
    activity.noteCommand(tank.socket, -250, 40, 0, t + 3000);
    t = settle(tank, t + 3000);
    c = tank.socket.contract;
    assert.equal(c.kind, 'hunt', 'got ' + c.kind);
    assert.equal(c.ent, foe);
    assert.equal(c.text, 'Take down ' + foe.name);
    remove(tank, foe);
});

test('complete: a bank job pays once into the bank and the board, then the next rolls', () => {
    clearWorld();
    const tank = spawnTank(0, -2400);
    tank.royaleBornAt = Date.now() - 60_000;
    tank.carriedGems = 500;
    let t = settle(tank);
    const c = tank.socket.contract;
    assert.equal(c.kind, 'bank');
    const bank0 = tank.socket.gemBanked | 0;
    // what vault.js does per chunk
    const deposit = n => { tank.carriedGems -= n; tank.socket.gemBanked = (tank.socket.gemBanked | 0) + n; royale.onBanked(tank, n); milestones.checkBanked(tank, n); };
    deposit(200); at(t += 300);
    assert.equal(c.prog, 200);
    assert.equal(c.state, 0);
    deposit(c.goal - 200); at(t += 300);
    assert.equal(c.state, 1);
    const milestoneBonus = milestones.BANK_MILESTONES.filter(m => m.at <= tank.socket.gemDeposited).reduce((a, m) => a + m.bonus, 0);
    assert.equal(tank.socket.gemBanked, bank0 + c.goal + milestoneBonus + c.reward, 'the reward landed once');
    const row = royale.boardSnapshot().find(r => r.id === tank.id);
    assert.ok(row && row.gems >= c.goal + c.reward, 'the board counts it');
    // the done card shows for the gap
    const snap = contracts.snapshotFor(tank.socket, tank, c.endAt + 500);
    assert.equal(snap && snap.st, 1);
    // more ticks, more deposits: never paid again, and a new one rolls
    for (let i = 0; i < 10; i++) at(t += 300);
    deposit(50); at(t += 300);
    assert.equal(kc(tank.socket, 'contract').length, 1, 'one callout');
    assert.ok(tank.socket.contract && tank.socket.contract.id !== c.id && tank.socket.contract.state === 0, 'next one rolled');
    remove(tank);
});

test('chest: cracking the contract chest in the game loop completes it and pays on top of the chest', () => {
    clearWorld();
    const tank = spawnTank(0, nextY += 2000);
    const chest = chests.spawnChest(tank.x + 400, tank.y, true, { item: null });
    chest.alwaysActive = true;
    let t = settle(tank);
    const c = tank.socket.contract;
    assert.equal(c.kind, 'chest');
    assert.equal(c.reward, contracts.REWARDS.chestEpic);
    const bank0 = tank.socket.gemBanked | 0;
    chests.openChest(chest, tank);
    loop(3);
    at(t += 300);
    assert.equal(c.state, 1);
    assert.equal(tank.socket.gemBanked, bank0 + c.reward);
    // a chest someone else takes is a miss
    tank.socket.contractNextAt = 0;
    const other = chests.spawnChest(tank.x - 400, tank.y, false, { item: null });
    other.alwaysActive = true;
    t = settle(tank, t + 3000);
    const c2 = tank.socket.contract;
    assert.equal(c2.ent, other);
    const thief = bot(other.x + 200, other.y);
    chests.openChest(other, thief);
    loop(3);
    at(t += 300);
    assert.equal(c2.state, 2);
    assert.equal(c2.why, 'Someone else got it');
    assert.equal(kc(tank.socket, 'contract').length, 1, 'no second payout');
    remove(tank, thief);
    clearWorld();
});

test('expiry: a job that runs out is missed and a new one rolls', () => {
    clearWorld();
    const tank = spawnTank(0, nextY += 2000);
    tank.royaleBornAt = Date.now() - 60_000;
    let t = settle(tank);
    const c = tank.socket.contract;
    assert.equal(c.kind, 'mine');
    const bank0 = tank.socket.gemBanked | 0;
    // keep the player active while the clock runs out
    activity.noteCommand(tank.socket, -300, 50, 0, c.until - 1000);
    at(c.until + 10);
    assert.equal(c.state, 2);
    assert.equal(c.why, "Time's up");
    assert.equal(tank.socket.gemBanked | 0, bank0, 'nothing paid');
    at(c.until + 2000);
    activity.noteCommand(tank.socket, 300, 50, 0, c.until + 2000);
    at(c.until + 2400);
    const n = tank.socket.contract;
    assert.ok(n && n.id !== c.id && n.state === 0, 'rolled again');
    remove(tank);
});

test('idle: nothing rolls, the running job fails unpaid; the coach holds contracts back', () => {
    clearWorld();
    const tank = spawnTank(0, nextY += 2000);
    tank.royaleBornAt = Date.now() - 60_000;
    const sock = tank.socket;
    // idle before the first roll
    const base = Date.now();
    sock.lastInputAt = base - contracts.IDLE_MS - 5000;
    sock._idleFrom = 0;
    for (let i = 0; i < 20; i++) at(base + i * 300);
    assert.equal(sock.contract, null, 'nothing rolled while idle');
    // back at it
    activity.noteCommand(sock, -400, 90, 0, base + 7000);
    let t = settle(tank, base + 7000);
    const c = sock.contract;
    assert.ok(c && c.state === 0);
    // walks away mid-job: the mine job would complete, but idle comes first
    c.kind = 'mine';
    const bank0 = sock.gemBanked | 0;
    const later = base + 7000 + contracts.IDLE_MS + 1000;
    tank.carriedGems = (tank.carriedGems | 0) + 10_000;
    at(later);
    assert.equal(c.state, 2);
    assert.equal(c.why, 'You went idle');
    assert.equal(sock.gemBanked | 0, bank0, 'not paid');
    for (let i = 1; i < 20; i++) at(later + i * 300);
    assert.equal(sock.contract, c, 'no new one while idle');
    assert.equal(contracts.snapshotFor(sock, tank, later + 6000), null, 'the card goes away');
    // the coach is on: nothing at all
    activity.noteCommand(sock, 400, -90, 0, later + 7000);
    sock.coachOn = true;
    for (let i = 0; i < 20; i++) at(later + 7000 + i * 300);
    assert.equal(sock.contract, null);
    sock.coachOn = false;
    t = settle(tank, later + 14_000);
    assert.ok(sock.contract && sock.contract.state === 0, 'starts once the coach is done');
    remove(tank);
});

test('revenge: your killer is marked for you; taking them down pays the bonus once', () => {
    clearWorld();
    const tank = spawnTank(0, nextY += 2000);
    const killer = bot(tank.x + 300, tank.y);
    // the bot kills the player
    tank.finalKillers = [killer];
    tank.deathCause = '';
    royale.onCombatantDead(tank);
    const rv = tank.socket.revenge;
    assert.ok(rv && rv.id === killer.id, 'marked');
    assert.match(tank.socket.contractNext, /where you land/);
    const snap = contracts.revengeFor(tank.socket, new Map(), Date.now());
    assert.equal(snap.alive, 1);
    assert.equal(snap.e, killer.id);
    remove(tank);
    // back in: a new body, the same socket
    const sock = tank.socket;
    const t2 = new Entity({ x: killer.x - 300, y: killer.y });
    t2.define('basic'); t2.isPlayer = true; t2.team = -900 - seq; t2.name = tank.name; t2.alwaysActive = true; t2.sendMessage = () => {};
    level45(t2);
    t2.socket = sock; sock.player.body = t2;
    global.gameManager.socketManager.players.push(sock.player);
    global.gameManager.socketManager.clients.push(sock);
    royale.onHumanJoin(t2);
    assert.ok(sock.revenge, 'still marked after the respawn');
    const bank0 = sock.gemBanked | 0;
    killer.finalKillers = [t2];
    killer.deathCause = '';
    royale.onCombatantDead(killer);
    const call = kc(sock, 'revenge');
    assert.equal(call.length, 1);
    assert.match(call[0][2], /^REVENGE: /);
    assert.equal(sock.gemBanked | 0, bank0 + contracts.REVENGE_GEMS);
    assert.equal(sock.revenge, null, 'cleared');
    remove(t2, killer);
});

test('pacing: a quiet raid gets a filler after 60-90 s; beats and the lock hold it off; the bounty pays the taker', () => {
    clearWorld();
    const fired = [];
    const people = [];
    let score = new Map();
    pacing.attach({
        humans: () => people.filter(b => !b.isDead()),
        fighters: () => people.filter(b => !b.isDead()),
        scoreOf: b => score.get(b) || 0,
        keyOf: b => 'k' + b.id,
        pay: (b, n, why) => fired.push({ pay: n, to: b, why }),
        callout: () => {},
        announce: (text, feed) => fired.push({ text, feed }),
        fxAt: () => {},
        live: () => true,
        idle: () => false,
    });
    const realDrop = chests.spawnSupplyDrop;
    let drops = 0;
    chests.spawnSupplyDrop = (x, y) => { drops++; const o = chests.spawnChest(x + 700, y, true, { item: 'medkit', gems: chests.SUPPLY_GEMS }); if (o) o.supplyDrop = true; return o; };
    try {
        // at the storm's centre: the zone is not the job here
        const sc = storm.snapshot();
        const a = spawnTank(sc.cx, sc.cy);
        const b = bot(a.x + 800, a.y);
        people.push(a, b);
        score.set(b, 900);
        const t0 = Date.now();
        pacing.reset(t0);
        pacing.tick(t0 + pacing.GAP_MIN_MS - 1000);
        assert.equal(fired.length, 0, 'nothing inside the minimum gap');
        // a real beat restarts the clock
        pacing.note('bloom', t0 + 50_000);
        pacing.tick(t0 + 50_000 + pacing.GAP_MIN_MS - 1000);
        assert.equal(fired.length, 0, 'the bloom counted');
        pacing.tick(t0 + 50_000 + pacing.GAP_MAX_MS + 10);
        assert.equal(drops, 1, 'a supply drop first');
        assert.match(fired[0].text, /^Supply drop landing in /);
        const sd = chests.alive().find(c => c.supplyDrop);
        assert.ok(sd, 'it is on the map');
        // the schedule never trims it or replaces it
        const before = chests.alive().length;
        chests.schedule();
        assert.ok(chests.alive().includes(sd), 'not trimmed');
        assert.ok(chests.snapshot().some(r => r.sd === 1));
        // next quiet spell: the bounty, on the leader
        const t1 = t0 + 50_000 + pacing.GAP_MAX_MS + 10;
        pacing.tick(t1 + pacing.GAP_MAX_MS + 10);
        const cur = pacing.current();
        assert.ok(cur && cur.body === b, 'bounty on the leader');
        assert.ok(fired.some(f => /^Bounty on /.test(f.text || '')));
        // a contract on the bounty for the player
        a.royaleBornAt = Date.now() - 60_000;
        chests.clearAll();
        a.socket.contract = null; a.socket.contractNextAt = 0;
        activity.noteCommand(a.socket, -222, 33, 0, t1 + pacing.GAP_MAX_MS + 50);
        contracts.attach(Object.assign({}, royaleHooks(), { bounty: () => pacing.current() }));
        settle(a, t1 + pacing.GAP_MAX_MS + 100);
        assert.equal(a.socket.contract.kind, 'bounty', 'got ' + a.socket.contract.kind);
        // the player takes the bounty
        assert.equal(pacing.onKill(a, b), pacing.BOUNTY_GEMS);
        assert.ok(fired.some(f => f.pay === pacing.BOUNTY_GEMS && f.to === a && f.why === 'bounty'));
        assert.equal(pacing.current(), null);
        assert.equal(pacing.onKill(a, b), 0, 'paid once');
        // the storm lock holds fillers off
        const t2 = t1 + 3 * pacing.GAP_MAX_MS;
        pacing.note('x', t2);
        const n0 = fired.length;
        const realLocked = storm.locked;
        storm.locked = () => true;
        pacing.tick(t2 + pacing.GAP_MAX_MS + 10);
        storm.locked = realLocked;
        assert.equal(fired.length, n0, 'not in the lock');
        remove(a, b);
        assert.ok(before >= 1);
    } finally {
        chests.spawnSupplyDrop = realDrop;
        clearWorld();
    }
});

// the hooks dig_royale.js attached, rebuilt for the pacing case
function royaleHooks() {
    return {
        pay: (body, n) => { body.socket.gemBanked = (body.socket.gemBanked | 0) + n; },
        callout: (body, kind, text, pts, sub, dur) => royale.callout(body, kind, text, pts, sub, dur),
        isNew: () => false, streakOf: () => 0, keyOf: b => 'k' + b.id, inRaid: () => true,
    };
}

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
if (!failed) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ } }
process.exit(failed ? 1 : 0);
