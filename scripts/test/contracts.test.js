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
//              with one callout; the card counts down the 30 s breather and
//              the next one rolls after it
//   chest      cracking the contract's chest in the game loop completes it
//   chest gone a chest that leaves any other way (under the Core, destroyed,
//              unlisted) ends the job and drops the marker
//   expiry     a job that runs out is marked missed and a new one rolls after
//              the breather
//   zone       the safe-zone job is never offered to someone already safe (the
//              old loop), finishes the moment they're inside, pays once, then
//              waits out the breather; a miss never re-offers itself; stepping
//              back out brings it back early but unpaid; the storm cuts other
//              breathers short; a fresh spawn still gets a job in 1.5 s; the
//              last storm skips it when there's no time to get in
//   idle       an idle player gets nothing rolled, loses the running job and
//              is never paid; the coach being on holds contracts back
//   revenge    a bot that kills you is marked for you; killing it pays the
//              revenge bonus once
//   pacing     a quiet raid gets a supply drop or bounty after 60-90 s, a
//              beat resets the clock, the lock holds it off; the bounty pays
//              whoever takes the target down; supply drops sit outside the
//              chest budget
'use strict';
// pacing's own supply drop is the fallback for when the sky drops
// (supplyDrops.js, tested in raidHeat.test.js) are off; this file tests that path
if (process.env.ROYALE_SUPPLY == null) process.env.ROYALE_SUPPLY = '0';

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
    assert.match(c.text, /^Open the copper chest (to the east|nearby)$/);
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
    // more ticks, more deposits: never paid again, and nothing new during
    // the breather, which the card counts down
    for (let i = 0; i < 10; i++) at(t += 300);
    deposit(50); at(t += 300);
    assert.equal(kc(tank.socket, 'contract').length, 1, 'one callout');
    assert.equal(tank.socket.contract, c, 'still the breather');
    const wait = contracts.snapshotFor(tank.socket, tank, t);
    assert.equal(wait.st, 3);
    assert.ok(Math.abs(wait.ms - (c.endAt + contracts.COOLDOWN_MS - t)) < 5, 'counts down to the next: ' + wait.ms);
    assert.equal(contracts.COOLDOWN_MS, 15_000);
    activity.noteCommand(tank.socket, -310, 60, 0, c.endAt + contracts.COOLDOWN_MS - 200);
    at(c.endAt + contracts.COOLDOWN_MS - 300);
    assert.equal(tank.socket.contract, c, 'not a moment early');
    t = settle(tank, c.endAt + contracts.COOLDOWN_MS);
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

test('chest gone: a chest that leaves the world any other way ends the job and its marker', () => {
    clearWorld();
    const tank = spawnTank(0, nextY += 2000);
    const coreFinale = T('coreFinale.js');
    // three ways a chest can go without being cracked: retired under the Core,
    // taken off the world without dying, dropped from the chest list
    const ways = [
        ['core', (ch) => chests.retireNear(ch.x, ch.y, 50)],
        ['destroyed', (ch) => { entities.delete(ch.id); }],
        ['unlisted', (ch) => { ch._cleared = true; }],
    ];
    let t = Date.now();
    for (const [why, gone] of ways) {
        tank.socket.contractNextAt = 0;
        tank.socket.contract = null;
        const chest = chests.spawnChest(tank.x + 450, tank.y, false, { item: null });
        chest.alwaysActive = true;
        t = settle(tank, t + 3000);
        const c = tank.socket.contract;
        assert.equal(c.kind, 'chest', why);
        assert.equal(contracts.snapshotFor(tank.socket, tank, t).e, chest.id, why + ': points at it');
        gone(chest);
        // no marker the moment it's gone, the job ends on the next pass
        const snap = contracts.snapshotFor(tank.socket, tank, t);
        assert.equal(snap.e, undefined, why + ': no marker on a missing chest');
        at(t += 300);
        assert.equal(c.state, 2, why + ': the job ends');
        assert.equal(c.why, 'The chest is gone', why);
        try { if (entities.has(chest.id)) chest.kill(); } catch { /* */ }
        loop(2);
    }
    // the Core never surfaces on a chest: its arena is kept clear of them
    assert.ok(chests.CORE_KEEP >= coreFinale.ARENA_R + 100);
    remove(tank);
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
    assert.equal(tank.socket.contract, c, 'a miss waits out the breather too');
    activity.noteCommand(tank.socket, 301, 50, 0, c.until + contracts.COOLDOWN_MS);
    at(c.until + contracts.COOLDOWN_MS + 400);
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

// Safe-zone job. Positions are relative to the zone's own "safe" line (the
// edge ZONE_LEAD_MS ahead, ZONE_MARGIN in), measured at the time t used.
function zoneR(t) { return storm.radius(t + contracts.ZONE_LEAD_MS, true) - contracts.ZONE_MARGIN; }
function placeAt(tank, d, t) {
    const st = storm.snapshot(t);
    tank.x = st.cx + d; tank.y = st.cy;
}
function keepActive(tank, t) { activity.noteAction(tank.socket, t); }

test('zone: never offered while safe, done the moment you are inside, paid once, then the breather', () => {
    clearWorld();
    contracts.attach(royaleHooks());
    const tank = spawnTank(0, 0);
    tank.royaleBornAt = Date.now() - 60_000;
    const sock = tank.socket;
    shop.stateOf(sock).spent = 1;
    let t = Date.now() + 1000;
    // inside the current circle but the edge gets there within 20 s: the old
    // director offered the job here, it finished on the next tick, paid and
    // rolled again 2 s later, forever
    placeAt(tank, zoneR(t) - 40, t);
    assert.equal(contracts.MAKERS.zone(tank, t), null, 'already safe: not offered');
    sock.contract = null; sock.contractNextAt = 0;
    const bank0 = sock.gemBanked | 0;
    let zones = 0;
    for (let i = 0; i < 400; i++) {
        t += 300;
        keepActive(tank, t);
        placeAt(tank, Math.min(zoneR(t) - 40, storm.radius(t) - 60), t);
        at(t);
        const c = sock.contract;
        if (c && c.kind === 'zone') zones++;
        // clear any other job out of the way so the director keeps choosing
        if (c && c.state === 0 && c.kind !== 'zone') { c.until = t; }
    }
    assert.equal(zones, 0, 'no safe-zone job for someone who is safe');
    assert.equal(kc(sock, 'contract').filter(p => /\+60 /.test(p[4] || '')).length, 0);

    // out in the storm: offered at once
    sock.contract = null; sock.contractNextAt = 0;
    t += 300; keepActive(tank, t);
    placeAt(tank, storm.radius(t) + 300, t);
    at(t);
    let c = sock.contract;
    assert.equal(c.kind, 'zone');
    assert.equal(c.reward, contracts.REWARDS.zone);
    const snap = contracts.snapshotFor(sock, tank, t);
    assert.equal(snap.z, 1, 'the client lights the whole circle for this one');
    // still outside a few ticks: still running
    for (let i = 0; i < 4; i++) { t += 300; keepActive(tank, t); placeAt(tank, storm.radius(t) + 250, t); at(t); }
    assert.equal(c.state, 0);
    // just inside the edge but not past the margin: not yet
    t += 300; keepActive(tank, t); placeAt(tank, zoneR(t) + 30, t); at(t);
    assert.equal(c.state, 0, 'the margin counts');
    // inside: done, paid once
    const paid0 = sock.gemBanked | 0;
    t += 300; keepActive(tank, t); placeAt(tank, zoneR(t) - 5, t); at(t);
    assert.equal(c.state, 1, 'done as soon as inside');
    assert.equal((sock.gemBanked | 0) - paid0, contracts.REWARDS.zone, 'paid');
    // sit right at the line for the whole breather: nothing re-rolls, no second pay
    const endAt = c.endAt;
    for (; t < endAt + contracts.COOLDOWN_MS - 400;) {
        t += 300; keepActive(tank, t);
        placeAt(tank, zoneR(t) - 10, t);
        at(t);
    }
    assert.equal(sock.contract, c, 'the breather held');
    assert.equal((sock.gemBanked | 0) - paid0, contracts.REWARDS.zone, 'paid once');
    assert.equal(contracts.snapshotFor(sock, tank, t).st, 3);
    // after it, something else (well inside now, so not the zone)
    placeAt(tank, zoneR(t) - 600, t);
    keepActive(tank, endAt + contracts.COOLDOWN_MS);
    t = settle(tank, endAt + contracts.COOLDOWN_MS);
    assert.ok(sock.contract !== c && sock.contract.kind !== 'zone', 'got ' + sock.contract.kind);
    assert.ok((sock.gemBanked | 0) >= bank0);
    remove(tank);
});

test('zone: a miss waits the breather; stepping back out brings it back early, unpaid; the storm cuts other breathers short', () => {
    clearWorld();
    contracts.attach(royaleHooks());
    const tank = spawnTank(0, 0);
    tank.royaleBornAt = Date.now() - 60_000;
    const sock = tank.socket;
    shop.stateOf(sock).spent = 1;
    let t = Date.now() + 1000;
    const out = (k = 300) => placeAt(tank, storm.radius(t) + k, t);
    const safe = () => placeAt(tank, zoneR(t) - 50, t);
    const step = (where) => { t += 300; keepActive(tank, t); where(); at(t); };

    // miss: stuck outside until time's up
    sock.contract = null; sock.contractNextAt = 0;
    step(out);
    let c = sock.contract;
    assert.equal(c.kind, 'zone');
    t = c.until - 300;
    step(out);
    assert.equal(c.state, 2);
    assert.equal(c.why, "Time's up");
    const missAt = c.endAt;
    while (t < missAt + contracts.COOLDOWN_MS - 400) step(out);
    assert.equal(sock.contract, c, 'a missed safe-zone job never re-offers itself in the breather');
    t = missAt + contracts.COOLDOWN_MS - 300;
    step(out); step(out);
    assert.ok(sock.contract !== c && sock.contract.kind === 'zone' && sock.contract.state === 0, 'back after the breather');
    assert.equal(sock.contract.reward, contracts.REWARDS.zone, 'nothing paid yet, so it pays');

    // done, then straight back out: not for the first ZONE_OUT_MS, then yes, unpaid
    c = sock.contract;
    step(safe);
    assert.equal(c.state, 1);
    const paid = sock.gemBanked | 0;
    step(safe); step(safe); step(safe); step(safe); step(safe); step(safe); step(safe); step(safe);
    const outFrom = t + 300;
    while (t < outFrom + contracts.ZONE_OUT_MS - 400) step(out);
    assert.equal(sock.contract, c, 'a short step out is not enough');
    for (let i = 0; i < 4; i++) step(out);
    const again = sock.contract;
    assert.ok(again !== c && again.kind === 'zone' && again.state === 0, 'properly outside: back early');
    assert.equal(again.reward, 0, 'but a quick repeat pays nothing');
    step(safe);
    assert.equal(again.state, 1);
    assert.equal(sock.gemBanked | 0, paid, 'and nothing was paid');

    // another job's breather: the storm reaching you cuts it short
    t = again.endAt + contracts.COOLDOWN_MS + 100;
    sock.contract = null; sock.contractNextAt = 0;
    tank.carriedGems = 0;
    step(safe);
    const m = sock.contract;
    assert.equal(m.kind, 'mine', 'got ' + m.kind);
    m.until = t + 300;
    step(safe);
    assert.equal(m.state, 2);
    // the result shows first
    step(out);
    assert.equal(sock.contract, m, 'the result shows before anything cuts in');
    for (let i = 0; i < 8; i++) step(out);
    assert.equal(sock.contract.kind, 'zone', 'the storm cut the breather short');
    assert.ok(t < m.endAt + 5000);
    remove(tank);
});

test('zone: a fresh spawn still gets a job within 1.5 s; the last storm skips it when there is no time', () => {
    clearWorld();
    contracts.attach(royaleHooks());
    const tank = spawnTank(0, 0);
    const sock = tank.socket;
    // a breather running from before the death
    sock.contractNextAt = Date.now() + 25_000;
    const t0 = Date.now();
    contracts.onSpawn(tank, t0);
    keepActive(tank, t0 + 100);
    placeAt(tank, zoneR(t0) - 200, t0);
    at(t0 + 500);
    assert.equal(sock.contract, null);
    let t = t0 + contracts.FIRST_ROLL_MS;
    at(t);
    assert.ok(sock.contract && sock.contract.state === 0, 'first job on time');

    // last storm, 12 s to go: far outside is hopeless, a step outside is not
    const realFinal = storm.isFinal, realPhase = storm.cyclePhase, realEnd = storm.endAt;
    try {
        storm.isFinal = () => true;
        storm.cyclePhase = () => 'hold';
        storm.endAt = () => t + 12_000;
        tank.royaleBornAt = t - 60_000;
        placeAt(tank, storm.radius(t) + 3000, t);
        assert.equal(contracts.MAKERS.zone(tank, t), null, 'no way in before the end');
        placeAt(tank, storm.radius(t) + 150, t);
        const c = contracts.MAKERS.zone(tank, t);
        assert.ok(c && c.kind === 'zone', 'close enough to make it');
        assert.ok(c.ms <= 12_000);
    } finally {
        storm.isFinal = realFinal; storm.cyclePhase = realPhase; storm.endAt = realEnd;
    }
    remove(tank);
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
