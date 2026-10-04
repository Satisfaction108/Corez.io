// First raids director: node scripts/test/newcomerDirector.test.js
//
//   stage      under 8 minutes played is a first raid (0), under 25 the
//              second (1), under 60 the third (2), then a veteran (3); fixed
//              for the whole raid, a reload included; the next raid looks again
//   bosses     never pick a first-raid player, their shots fade on contact
//              and the hull only pushes; everyone else is hit as before
//   bots       no X-Hunter / Penta / Octo class bot hunts a first-raid
//              player for 5 minutes (unless they shoot it); a Basic still
//              does, and so does the Penta once the 5 minutes are up
//   storm      0.4x the damage in a first raid, 0.7x in the second, full
//              after; a loud callout when a first-raid player is out in it
//   death      the first death drops half the satchel and the other half
//              comes back with the respawn (death packet and message say
//              so); the second death drops it all
//   moments    ore, crate, trial, chest and objective each fire close to the
//              player and do their thing; the schedule waits while they are
//              fighting, hiding or dead, then goes on
//   veterans   none of it, and ROYALE_NEWCOMER_DIRECTOR=0 turns it all off
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
const director = require(path.join(SERVER, 'game', 'terrain', 'newcomerDirector.js'));
const bossGuard = require(path.join(SERVER, 'game', 'terrain', 'bossGuard.js'));
const bosses = require(path.join(SERVER, 'game', 'terrain', 'bosses.js'));
const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
const gems = require(path.join(SERVER, 'game', 'terrain', 'gems.js'));
const chests = require(path.join(SERVER, 'game', 'terrain', 'chests.js'));
const supply = require(path.join(SERVER, 'game', 'terrain', 'supplyDrops.js'));
const abilities = require(path.join(SERVER, 'game', 'terrain', 'abilities.js'));
const { ORE, ORE_HP } = require(path.join(SERVER, 'game', 'terrain', 'terrainGrid.js'));
const { ioTypes } = require(path.join(SERVER, 'miscFiles', 'controllers.js'));
const T = director.TUNE;
const MIN = 60_000;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let ids = 9000, nextY = -2400;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
// minutes: time played before this raid
function fakeSocket(minutes = 0, extra = {}) {
    const s = { id: ids++, packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 3, _careerPlayMs: minutes * MIN, ...extra };
    s.talk = (...a) => s.packets.push(a);
    return s;
}
function player(socket, x = 0, y = (nextY += 600)) {
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
// a player of `minutes` played, fresh into the raid (the stage is stamped here)
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
// out of the bot grace and soft window, so only the director's rules are left
function bare(p) {
    p.invuln = false;
    p.botGraceUntil = 0;
    p.botSoftUntil = 0;
    p.botNewbie = false;
}
const kcs = (s, kind) => s.packets.filter(a => a[0] === 'KC' && (!kind || a[1] === kind));
const msgs = (s) => s.packets.filter(a => a[0] === 'm').map(a => String(a[2]));
const waitScan = () => { for (const t = Date.now(); Date.now() - t < 130;); };   // the shared bot scan refreshes every 110 ms

// the raid is on: the first tick starts it
royale.tick();

// ===================================================================

test('stage: 3 / 7 / 12 minutes played, moving up mid-raid; bosses leave you 8 minutes', () => {
    assert.deepEqual(T.STAGE_MIN, [3, 7, 12]);
    assert.equal(T.BOSS_SAFE_MIN, 8);
    const at = (m) => director.stageFor(m * MIN);
    assert.deepEqual([at(0), at(2.99), at(3), at(6.9), at(7), at(11.9), at(12), at(600)], [0, 0, 1, 1, 2, 2, 3, 3]);
    // through the real spawn path
    for (const [m, want, safe] of [[0, 0, true], [2, 0, true], [5, 1, true], [9, 2, false], [30, 3, false]]) {
        const p = spawn(m);
        assert.equal(p.nxStage, want, m + ' minutes');
        assert.equal(p.nxBossSafe, safe, m + ' minutes: boss grace');
        assert.equal(director.youFields(p.socket).nx, want);
        p.kill();
    }
    // a raid that started at stage 0 moves up as the minutes go by
    const q = spawn(2);
    assert.equal(q.nxStage, 0);
    const cl = global.gameManager.socketManager.clients;
    if (!cl.includes(q.socket)) cl.push(q.socket);
    const realNow = Date.now, t0 = realNow();
    try {
        q.royaleBornAt = t0 - 2 * MIN;           // two more minutes alive: 4 in all
        Date.now = () => t0 + 20_000;
        director.tick(t0 + 20_000);
    } finally { Date.now = realNow; }
    assert.equal(q.nxStage, 1, 'stage 1 mid-raid');
    assert.equal(director.youFields(q.socket).nx, 1);
    assert.equal(q.nxBossSafe, true, 'still under 8 minutes: bosses still leave them be');
    q.kill();
    for (const [m, want] of [[0, 0], [2, 0], [5, 1], [9, 2], [30, 3]]) {
        const p = spawn(m);
        assert.equal(p.nxStage, want, m + ' minutes');
        assert.equal(director.youFields(p.socket).nx, want);
        p.kill();
    }
    // a guest's play_ms counts too (the guests table, read once per socket)
    const guest = fakeSocket(0, { _careerLives: undefined, _careerPlayMs: undefined, guestId: 'f'.repeat(32) });
    const g = spawn(0, 0, (nextY += 600), guest);
    assert.equal(g.nxStage, 0, 'unknown guest: a first raid');
    g.kill();
    // a respawn or reload doesn't reset it (only the mid-raid check moves it up)
    const sock = fakeSocket(1, { guestId: 'a'.repeat(32) });
    const a = spawn(0, 0, (nextY += 600), sock);
    assert.equal(a.nxStage, 0);
    sock._royalePlayMs = 10 * MIN;
    a.kill();
    const a2 = spawn(0, 0, (nextY += 600), sock);
    assert.equal(a2.nxStage, 0, 'next life, same raid: same stage');
    const reload = fakeSocket(60, { guestId: 'a'.repeat(32) });
    const a3 = spawn(0, 0, (nextY += 600), reload);
    assert.equal(a3.nxStage, 0, 'a reload in the same raid keeps it');
    // the next raid looks again: 1 + 10 minutes is stage 2
    director.newRaid();
    const a4 = spawn(0, 0, (nextY += 600), sock);
    assert.equal(a4.nxStage, 2);
    for (const o of [a2, a3, a4]) o.kill();
    loop(2);
});

test('bosses: never pick a first-raid player, shots fade, the hull only pushes', () => {
    const y = (nextY += 1500);
    const boss = new Entity({ x: 0, y });
    boss.define(bosses.KINDS.warden.cls);
    boss.isRoyaleBoss = true;
    boss.bossKind = 'warden';
    boss.team = -100;
    boss.controllers = [];
    boss.alwaysActive = true;
    const p = spawn(0, 400, y), v = spawn(120, -400, y);
    bare(p); bare(v);
    assert.equal(p.nxBossSafe, true);
    assert.equal(v.nxBossSafe, false);
    const shot = () => { const s = new Entity({ x: 200, y }, boss); s.define('bullet'); s.team = boss.team; return s; };
    const s1 = shot();
    assert.equal(bossGuard.intoPlayer(p, s1, 50), 0, 'a shot does nothing to them');
    assert.ok(s1.health.amount <= 0, 'and fades');
    const s2 = shot();
    assert.ok(bossGuard.intoPlayer(v, s2, 50) > 0, 'a veteran is hit');
    assert.ok(s2.health.amount > 0);
    assert.equal(bossGuard.intoPlayer(p, boss, 80), 0, 'the hull hurts nobody new');
    assert.ok(!(boss.health.amount <= 0), 'and nothing happens to the boss');
    // the boss's guns never pick them
    const aim = new ioTypes.nearestDifferentMaster(boss);
    assert.equal(aim.validate(p, boss, boss, 1e12, 1e12), false);
    assert.equal(aim.validate(v, boss, boss, 1e12, 1e12), true);
    // a real shot from a boss gun, point blank, through the game loop
    for (const t of boss.turrets.values()) t.controllers = [];
    const g = [...boss.guns.values()].find(gg => gg.bulletType);
    p.health.amount = p.health.max;
    p.shield.amount = p.shield.max;
    const pool = p.health.amount + p.shield.amount;
    const before = new Set(entities.keys());
    g.fire(0, 0);
    const made = [...entities.values()].filter(e => !before.has(e.id));
    for (const m of made.slice(1)) m.kill();
    const b = made[0];
    b.x = p.x - (p.realSize + (b.realSize || 8) + 4); b.y = p.y;
    b.velocity.x = 6; b.velocity.y = 0;
    b.alwaysActive = true;
    loop(20);
    assert.equal(p.health.amount + p.shield.amount, pool, 'not a scratch');
    assert.ok(b.isDead() || b.health.amount <= 0, 'the shot is gone');
    for (const o of [boss, p, v, s2]) o.kill();
    loop(2);
});

test('bots: no X-Hunter / Penta / Octo class on a first-raid player for 5 minutes', () => {
    const G = ioTypes.digWarsGoals;
    for (const label of ['Penta Shot', 'X-Hunter', 'Octo Tank']) assert.ok(director.SCARY.has(label), label);
    const penta = bot('pentaShot', 0, (nextY += 4000));
    assert.equal(penta.label, 'Penta Shot');
    const basic = bot('basic', 0, (nextY += 4000));
    const p = spawn(0, penta.x + 600, penta.y), q = spawn(0, basic.x + 600, basic.y);
    bare(p); bare(q);
    assert.ok(Math.abs(p.nxScaryUntil - (Date.now() + T.SCARY_MS[0])) < 2000);
    const cp = new G(penta), cb = new G(basic);
    loop(2); waitScan();
    let now = Date.now();
    cp.senseAt = 0; cp.sense(now);
    assert.equal(cp.view.enemy, null, 'the Penta leaves them alone');
    assert.equal(cp.canInitiateFight(p, now), false);
    assert.equal(new ioTypes.nearestDifferentMaster(penta).validate(p, penta, penta, 1e12, 1e12), false, 'its guns too');
    cb.senseAt = 0; cb.sense(now);
    assert.equal(cb.view.enemy, q, 'a Basic still comes for them');
    // they shoot the Penta: it shoots back
    penta._lastDamageSource = p; penta._lastDamageAt = Date.now();
    now = Date.now() + 200;
    cp.senseAt = 0; cp.sense(now);
    assert.equal(cp.view.enemy, p, 'fought back');
    penta._lastDamageSource = null; penta._lastDamageAt = 0;
    // five minutes on: fair game
    p.nxScaryUntil = Date.now() - 1;
    now = Date.now() + 400;
    cp.senseAt = 0; cp.sense(now);
    assert.equal(cp.view.enemy, p, 'after the window');
    // the soft window is 3 minutes a life in a first raid
    const r = spawn(0);
    assert.ok(Math.abs(r.botSoftUntil - (Date.now() + T.SOFT_MS[0])) < 2000);
    assert.equal(T.SOFT_MS[0], 180_000);
    for (const o of [penta, basic, p, q, r]) o.kill();
    loop(2);
});

test('storm: 0.4x in a first raid, 0.7x in the second, full after, and a loud warning', () => {
    storm.setCycles(3);
    storm.start();
    const st = storm.snapshot();
    const out = (i) => ({ x: st.cx + st.r + 500 + i * 300, y: st.cy });
    const bodies = [0, 5, 120].map((m, i) => { const o = out(i); return spawn(m, o.x, o.y); });
    for (const b of bodies) { b.spawnGraceUntil = 0; b.invuln = false; b.health.amount = b.health.max; b.shield.amount = b.shield.max; b._stormExpMs = 0; b._stormSeenAt = 0; }
    const pool = (b) => b.health.amount + b.shield.amount;
    const start = bodies.map(pool);
    let t = Date.now();
    for (let i = 0; i < 40; i++) { storm.tickDamage(t); t += 250; }
    const lost = bodies.map((b, i) => start[i] - pool(b));
    assert.ok(lost[2] > 0, 'the veteran takes damage');
    assert.ok(Math.abs(lost[0] / lost[2] - 0.4) < 0.03, 'first raid ' + (lost[0] / lost[2]).toFixed(3));
    assert.ok(Math.abs(lost[1] / lost[2] - 0.7) < 0.03, 'second raid ' + (lost[1] / lost[2]).toFixed(3));
    // the HUD's storm multiplier says the same
    assert.ok(Math.abs(storm.exposureOf(bodies[0]).mult / storm.exposureOf(bodies[2]).mult - 0.4) < 0.01);
    // the warning (first raid only)
    global.gameManager.socketManager.clients = bodies.map(b => b.socket);
    director.tick(Date.now() + 5000);
    assert.equal(kcs(bodies[0].socket, 'nxstorm').length, 1, 'first raid warned');
    assert.equal(kcs(bodies[1].socket, 'nxstorm').length, 0);
    assert.equal(kcs(bodies[2].socket, 'nxstorm').length, 0);
    director.tick(Date.now() + 6000);
    assert.equal(kcs(bodies[0].socket, 'nxstorm').length, 1, 'not every tick');
    global.gameManager.socketManager.clients = [];
    for (const b of bodies) b.kill();
    loop(2);
});

function droppedNear(x, y, before) {
    let sum = 0;
    for (const e of entities.values()) if (e.isGemPickup && !before.has(e.id) && Math.hypot(e.x - x, e.y - y) < 400) sum += e.gemValue;
    return sum;
}
function die(p, carried) {
    gems.initSatchel(p);
    p.carriedGems = carried;
    const before = new Set(entities.keys());
    const x = p.x, y = p.y;
    p.invuln = false;
    p.kill();
    loop(2);
    return droppedNear(x, y, before);
}

test('death: a first death drops half and the other half comes back; the second drops it all', () => {
    const sock = fakeSocket(0);
    const p = spawn(0, 0, (nextY += 1200), sock);
    assert.equal(die(p, 400), 200, 'half on the ground');
    assert.equal(sock.gemDeathKept, 200);
    assert.equal(sock.gemDeathCarried, 200, 'the death card shows what was lost');
    assert.ok(msgs(sock).some(m => /only dropped half/.test(m) && /200/.test(m)), 'and says so');
    assert.equal(director.youFields(sock).nxKept, 200);
    // the respawn brings it back, with a word
    const p2 = spawn(0, 0, (nextY += 1200), sock);
    gems.initSatchel(p2);
    director.onSpawn(p2, true);
    assert.equal(p2.carriedGems | 0, 200);
    assert.equal(director.youFields(sock).nxKept, undefined);
    assert.ok(kcs(sock, 'nx').some(k => k[2] === 'Back in the raid' && /200/.test(k[4])));
    // second death: all of it
    assert.equal(die(p2, 300), 300);
    assert.equal(sock.gemDeathKept, 0);
    // a near-empty first death doesn't use it up
    const s2 = fakeSocket(0);
    const e = spawn(0, 0, (nextY += 1200), s2);
    die(e, 5);
    assert.equal(s2.gemDeathKept, 0);
    const e2 = spawn(0, 0, (nextY += 1200), s2);
    assert.equal(die(e2, 600), 300, 'still there for the first real one');
    // a veteran (and a second raid) drops everything
    for (const m of [12, 120]) {
        const v = spawn(m, 0, (nextY += 1200));
        assert.equal(die(v, 400), 400, m + ' minutes');
        assert.equal(v.socket.gemDeathKept, 0);
    }
    // the death packet carries it
    const src = require('fs').readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.ok(/royaleRespawnAt - Date\.now\(\)\) : 0\) \| 0,\s+\/\/[^\n]*\n\s+\(socket && socket\.gemDeathKept\) \| 0,\s+\];/.test(src), 'm[18 + killers]');
});

// ── the moments ───────────────────────────────────────────────────────
// a first-raid player standing in open ground well inside the zone
function openSpot() {
    const st = storm.snapshot();
    for (let i = 0; i < 400; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.random() * Math.min(1400, st.r * 0.6);
        const x = st.cx + Math.cos(a) * d, y = st.cy + Math.sin(a) * d;
        if (grid.pointInRock(x, y)) continue;
        let ok = true;
        for (const v of require(path.join(SERVER, 'game', 'terrain', 'vault.js')).getVaults()) if (Math.hypot(v.x - x, v.y - y) < 500) ok = false;
        if (ok) return { x, y };
    }
    return { x: st.cx, y: st.cy };
}
function newbie() {
    const o = openSpot();
    const p = spawn(0, o.x, o.y);
    p.royaleBornAt = Date.now() - 60_000;
    p.spawnGraceUntil = 0;
    global.gameManager.socketManager.players = [p.socket.player];
    return p;
}
const near = (ev, p, r = 900) => ev && Math.hypot(ev.x - p.x, ev.y - p.y) <= r;

test('moments: the vein turns rock rich and soft close by', () => {
    const p = newbie();
    const t = Date.now();
    const ev = director._fire(p, 'ore', t);
    assert.ok(ev && ev.kind === 'ore', 'fired');
    assert.ok(near(ev, p, T.ORE_RING[1] + 50), 'close');
    assert.ok(ev.rocks.length >= 2 && ev.rocks.every(r => r.alive && r.ore >= ORE.VEIN), ev.rocks.map(r => r.ore).join(','));
    assert.ok(ev.rocks.some(r => r.ore === ORE.SHARD));
    assert.ok(ev.rocks.every(r => Math.abs(r.maxHealth - grid.plainRockHealth * ORE_HP[r.ore] * T.ORE_SOFT) < 1 && r.health <= r.maxHealth), 'soft');
    assert.ok(p.socket.packets.some(a => a[0] === 'FX' && a[3] === 'bloom'));
    const y = director.youFields(p.socket);
    assert.equal(y.nxEvent.kind, 'ore');
    assert.equal(y.nxEvent.state, 'live');
    // mined out: done
    for (const r of ev.rocks) grid.damageRock(r, r.health + 1, r.wx, r.wy, false, null);
    global.gameManager.socketManager.clients = [p.socket];
    director.tick(Date.now() + 1000);
    assert.equal(director.youFields(p.socket).nxEvent.state, 'done');
    global.gameManager.socketManager.clients = [];
    p.kill(); loop(1);
});

test('moments: the supply drop comes down near them, and bots leave it to them', () => {
    supply.reset();
    const p = newbie();
    const t = Date.now();
    const ev = director._fire(p, 'crate', t);
    assert.ok(ev && ev.kind === 'crate', 'fired');
    const cur = supply.current(t);
    assert.equal(cur.state, 'soon');
    assert.ok(near(cur, p, 1150), 'near them: ' + Math.round(Math.hypot(cur.x - p.x, cur.y - p.y)));
    assert.equal(ev.x, cur.x);
    // a second ask while it falls gets nothing new
    assert.equal(supply.requestNear(p, t), null);
    supply.tick(cur.at + 1);
    const down = supply.current(cur.at + 1);
    assert.equal(down.state, 'down');
    assert.equal(down.entity._botClaim.id, p.id, 'held for them');
    supply.reset();
    down.entity._opened = true; down.entity._cleared = true;
    try { down.entity.kill(); } catch { /* */ }
    p.kill(); loop(2);
});

test('moments: a free Grapple or Launch Pad trial (never the Shockwave)', () => {
    for (let i = 0; i < 8; i++) {
        const p = newbie();
        const ev = director._fire(p, 'trial', Date.now());
        assert.ok(ev && ev.kind === 'trial');
        const st = abilities.stateOf(p.socket);
        assert.ok(T.TRIAL_POOL.includes(ev.ab) || T.TRIAL_FALLBACK.includes(ev.ab), ev.ab);
        assert.notEqual(ev.ab, 'shock');
        assert.equal(st.trial.id, ev.ab);
        assert.ok(Math.abs(st.trial.until - Date.now() - abilities.TRIAL_MS) < 1000);
        assert.notEqual(abilities.equippedOf(st), null);
        assert.ok(p.socket.packets.some(a => a[0] === 'AB' && JSON.parse(a[1]).tr && JSON.parse(a[1]).tr.id === ev.ab), 'the FREE TRIAL card');
        p.kill();
    }
    // nor is the raid's free ability ever the Shockwave in a first raid
    for (let i = 0; i < 30; i++) {
        const p = newbie();
        abilities.onSpawn(p);
        assert.notEqual(abilities.stateOf(p.socket).free, 'shock');
        p.kill();
    }
    loop(2);
});

test('moments: a chest only they can crack, outside the chest budget', () => {
    const p = newbie();
    const t = Date.now();
    const ev = director._fire(p, 'chest', t);
    assert.ok(ev && ev.kind === 'chest', 'fired');
    assert.ok(near(ev, p, T.CHEST_RING[1] + 300), 'close');
    const c = ev.ent;
    assert.ok(c.isLootChest && c.chestExtra && !c.chestRare);
    assert.equal(c.chestGems, T.CHEST_GEMS);
    assert.ok(c.chestItem, 'with a kit item');
    assert.equal(c.nxOwnerId, p.id);
    assert.equal(c._botClaim.id, p.id);
    assert.ok(chests.alive().includes(c));
    // the budget never trims it
    const live = chests.alive().filter(x => !x._opened && !x.chestExtra).length;
    chests.schedule();
    assert.ok(!c._opened, 'still there');
    void live;
    // someone else's shots don't count yet; theirs do
    const other = spawn(120, c.x + 300, c.y);
    c.alwaysActive = true;
    // one real shot from `who`'s gun, just off the rim and flying in
    const hitBy = (who) => {
        const gun = [...who.guns.values()].find(g => g.bulletType);
        const before = new Set(entities.keys());
        gun.fire(0, 0);
        const s = [...entities.values()].find(e => !before.has(e.id));
        const d = (c.realSize || 40) + (s.realSize || 10) + 6;
        s.x = c.x - d; s.y = c.y;
        s.velocity.x = Math.max(4, s.velocity.length || 0); s.velocity.y = 0;
        s.alwaysActive = true;
        const h0 = c.health.amount + (c.shield ? c.shield.amount : 0);
        loop(4);
        try { s.kill(); } catch { /* */ }
        return h0 - (c.health.amount + (c.shield ? c.shield.amount : 0));
    };
    assert.equal(hitBy(other), 0, 'held from everyone else');
    assert.ok(hitBy(p) > 0, 'but not from them');
    c.nxOwnerUntil = Date.now() - 1;
    assert.ok(hitBy(other) > 0, 'open to all once the hold is up');
    c._opened = true; c._cleared = true;
    c.kill(); other.kill(); p.kill();
    loop(2);
});

test('moments: bank N in 60 s pays +250 and a kit item; running out of time pays nothing', () => {
    const p = newbie();
    gems.initSatchel(p);
    p.carriedGems = 120;
    global.gameManager.socketManager.clients = [p.socket];
    const t = Date.now();
    const ev = director._fire(p, 'objective', t);
    assert.ok(ev && ev.kind === 'objective');
    assert.equal(ev.goal, 200, 'carried + 100, rounded');
    assert.ok(ev.goal >= T.JOB_GOAL[0] && ev.goal <= T.JOB_GOAL[1]);
    assert.ok(p.socket.contractNextAt >= t + T.JOB_MS, 'no contract on top of it');
    director.tick(t + 300);
    assert.ok(near(ev, p, 99999) && ev.x != null, 'points at a vault');
    const before = p.socket.gemBanked | 0;
    royale.onBanked(p, 120);
    assert.equal(director.youFields(p.socket).nxEvent.prog, 120);
    royale.onBanked(p, 90);
    director.tick(t + 700);
    const y = director.youFields(p.socket).nxEvent;
    assert.equal(y.state, 'done');
    assert.equal(y.done, 1);
    assert.equal((p.socket.gemBanked | 0) - before, T.JOB_REWARD, 'paid into the bank');
    assert.ok(p.socket.packets.some(a => a[0] === 'SHP' || a[0] === 'm'), 'told');
    // a missed one
    const q = newbie();
    global.gameManager.socketManager.clients = [q.socket];
    const ev2 = director._fire(q, 'objective', Date.now());
    const b2 = q.socket.gemBanked | 0;
    director.tick(Date.now() + T.JOB_MS + 1000);
    assert.equal(director.youFields(q.socket).nxEvent.state, 'failed');
    assert.equal(q.socket.gemBanked | 0, b2);
    void ev2;
    global.gameManager.socketManager.clients = [];
    p.kill(); q.kill(); loop(2);
});

test('moments: the schedule waits while fighting, hiding or dead, then goes on', () => {
    const p = newbie();
    global.gameManager.socketManager.clients = [p.socket];
    const st = director.stateOf(p.socket);
    let t = Date.now() + 1000;
    st.since = t - 31_000;
    st.dueAt = t - 1;
    assert.equal(st.next, 0);
    // fighting
    p.hitAt = t - 1000;
    director.tick(t);
    assert.equal(st.next, 0, 'not while fighting');
    assert.equal(st.event, null);
    assert.ok(st.dueAt >= t + T.RETRY_MS - 10, 'tried again a bit later');
    assert.equal(director.busyWhy(p, t), 'fighting');
    p.hitAt = 0;
    // hiding
    p.burrowUntil = t + 5000;
    assert.equal(director.busyWhy(p, t), 'hiding');
    p.burrowUntil = 0;
    p.padSafe = true;
    assert.equal(director.busyWhy(p, t), 'pad');
    p.padSafe = false;
    // a bot on them close by is a fight too
    const b = bot('basic', p.x + 300, p.y);
    b._botEnemyId = p.id;
    handler.bots.push(b);
    assert.equal(director.busyWhy(p, t), 'fighting');
    handler.bots.splice(handler.bots.indexOf(b), 1);
    b.kill();
    // clear: it fires
    t += 6000;
    st.dueAt = t - 1;
    director.tick(t);
    assert.equal(st.next, 1, 'fired once clear');
    assert.equal(st.event.kind, 'ore');
    assert.ok(st.dueAt >= t + T.MIN_GAP_MS - 10, 'the next one waits its turn');
    // dead
    t += 300;
    st.event = null;
    st.dueAt = t - 1;
    p.kill();
    loop(1);
    director.tick(t);
    assert.equal(st.next, 1, 'not while dead');
    // past the window nothing more fires
    const q = newbie();
    global.gameManager.socketManager.clients = [q.socket];
    const sq = director.stateOf(q.socket);
    sq.since = Date.now() - T.WINDOW_MS - 1000;
    sq.dueAt = 0;
    director.tick(Date.now() + 2000);
    assert.equal(sq.event, null);
    assert.equal(sq.next, T.MOMENTS.length);
    global.gameManager.socketManager.clients = [];
    q.kill(); loop(2);
});

test('veterans: none of it; ROYALE_NEWCOMER_DIRECTOR=0 turns it all off', () => {
    const v = spawn(120);
    assert.equal(v.nxStage, 3);
    assert.equal(v.nxBossSafe, false);
    assert.equal(v.nxScaryUntil, 0);
    assert.equal(v.nxStormMult || 0, 0);
    assert.ok(v.botSoftMs < T.SOFT_MS[1], 'their usual soft window');
    // no moments ever
    global.gameManager.socketManager.clients = [v.socket];
    const st = director.stateOf(v.socket);
    st.dueAt = 0;
    v.royaleBornAt = Date.now() - 60_000;
    director.tick(Date.now() + 3000);
    assert.equal(st.event, null);
    assert.deepEqual(director.youFields(v.socket), { nx: 3, nxEvent: null });
    global.gameManager.socketManager.clients = [];
    v.kill();
    // switched off
    director.setEnabled(false);
    try {
        const p = spawn(0);
        assert.equal(p.nxStage, undefined);
        assert.equal(p.nxBossSafe, false);
        assert.equal(director.youFields(p.socket), null);
        assert.equal(die(p, 400), 400, 'no kept half');
    } finally { director.setEnabled(true); }
    const env = require('fs').readFileSync(path.join(SERVER, '.env.example'), 'utf8');
    assert.ok(/^ROYALE_NEWCOMER_DIRECTOR=1$/m.test(env));
    loop(2);
});

test('the raid snapshot carries nx and nxEvent', () => {
    const p = newbie();
    royale.onBanked(p, 1);    // a row on the board
    director._fire(p, 'objective', Date.now());
    let out = null;
    const c = p.socket;
    const talk = c.talk;
    c.talk = (k, payload) => { if (k === 'RY') out = payload; else talk(k, payload); };
    global.gameManager.socketManager.clients = [c];
    royale.tick._broadcastAt = 0;
    try { royale.tick(); } catch { /* */ }
    global.gameManager.socketManager.clients = [];
    assert.ok(out, 'RY sent');
    const you = JSON.parse(out).you;
    assert.equal(you.nx, 0);
    assert.equal(you.nxEvent.kind, 'objective');
    assert.equal(you.nxEvent.t, you.nxEvent.title);
    assert.ok(you.nxEvent.left > 0 && you.nxEvent.left <= T.JOB_MS);
    p.kill(); loop(2);
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
