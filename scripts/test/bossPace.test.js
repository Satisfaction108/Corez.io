// Boss pace and boss damage intake: node scripts/test/bossPace.test.js
//
//   rate       bosses come ~2.5x as often (ROYALE_BOSS_RATE): first one 3
//              min in, the next ~5.6 min after; Warden's Watch multiplies
//              on top
//   per hit    no single collision tick takes more than 1.75% of a boss
//   per tank   (off by default since Oct 3; ROYALE_BOSS_RATE_CAP=1) one tank
//              gets at most 2.8% a second through, everyone together 7.5%
//   default    with the rate cap off, only the per-hit cap applies
//   ttk        a maxed Annihilator, a Constructor's traps and a grown tank
//              all need over 30 s alone, a maxed Basic 25-60 s, three
//              together less than half; switched off they shred it (a
//              Constructor in about a second)
//   regen      a boss under fire does not regenerate
//   payout     a boss killed through the cap still erupts its gems
//   newcomers  a boss treats a new player like anyone (Oct 5 2026): full
//              damage, it can finish them, its guns take the nearest; the
//              old mercy (a quarter of the damage, no last blow, guns looking
//              elsewhere) only comes back with ROYALE_BOSS_NEWBIE=1
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
    room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [{ check: () => true, add() {}, remove() {} }], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;
function loop(n = 1) { for (let i = 0; i < n; i++) handler.gameloop(); }
const bosses = require(path.join(SERVER, 'game', 'terrain', 'bosses.js'));
const guard = require(path.join(SERVER, 'game', 'terrain', 'bossGuard.js'));
const raidMods = require(path.join(SERVER, 'game', 'terrain', 'raidMods.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const clearAll = () => { for (const e of [...entities.values()]) { try { e.kill(); } catch { /* */ } } loop(3); };
const MIN = 60_000;

test('rate: about 2.5x as many bosses, Warden\'s Watch on top', () => {
    assert.equal(bosses.RATE, 2.5);
    assert.ok(Math.abs(bosses.firstDelay() - 3 * MIN) < 1, 'first at 3 min (it was 5)');
    const samples = (n = 200) => {
        let sum = 0;
        for (let i = 0; i < n; i++) { bosses.scheduleNext(); sum += bosses.nextIn(); }
        return sum / n;
    };
    const plain = samples();
    assert.ok(Math.abs(plain - bosses.BASE_INTERVAL_MS / 2.5) < 0.25 * MIN, 'next ~5.6 min: ' + (plain / MIN).toFixed(2));
    // a 21 min raid where every boss dies 2.5 min after it shows up
    let t = bosses.firstDelay(), n = 0;
    while (t < 21 * MIN) { n++; t += 2.5 * MIN + bosses.BASE_INTERVAL_MS / bosses.RATE; }
    assert.ok(n >= 3, n + ' bosses a raid (it was 1-2)');
    // Warden's Watch multiplies
    const prev = raidMods.get();
    raidMods.roll('wardens_watch');
    try {
        assert.equal(raidMods.num('bossRateMult', 1), 2.5);
        const watched = samples();
        assert.ok(watched < plain / 2, 'the twist still counts: ' + (watched / MIN).toFixed(2));
    } finally { if (prev) raidMods.roll(prev.id); }
    // a boss left alone burrows sooner than before
    assert.ok(bosses.LIFETIME_MS <= 6 * MIN);
});

function makeBoss(kind = 'warden') {
    const cls = bosses.KINDS[kind].cls;
    const boss = new Entity({ x: 0, y: 0 });
    boss.define(cls);
    boss.team = TEAM_ENEMIES; boss.isRoyaleBoss = true; boss.bossKind = kind; boss.alwaysActive = true;
    bosses.tune(boss, kind);
    boss.refreshBodyAttributes();
    boss.controllers = [];
    return boss;
}
function attacker(cls, build, x, growth = 1) {
    const t = new Entity({ x, y: 0 });
    t.define(cls);
    t.isPlayer = true; t.team = -1; t.alwaysActive = true; t.reverseTank = 1;
    t.socket = { talk() {}, status: {}, camera: { x: 0, y: 0 } }; t.sendMessage = () => {};
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.skill.set(build);
    t.refreshBodyAttributes();
    if (growth > 1) { t.growthMult = growth; t.SIZE *= growth; t.refreshBodyAttributes(); }
    t.health.set(1e7); t.health.amount = 1e7;
    return t;
}
const MAXED = [9, 9, 9, 9, 9, 0, 0, 0, 0, 5, 0];
// seconds for one tank to take a pinned, unarmed boss down (capped at `limit`)
function ttk(cls, opts = {}) {
    const boss = makeBoss(opts.kind);
    const crew = [];
    for (let i = 0; i < (opts.count || 1); i++) {
        const t = attacker(cls, opts.build || MAXED, 0, opts.growth);
        const a = Math.PI + (i - ((opts.count || 1) - 1) / 2) * 0.7;
        t.home = { x: Math.cos(a) * -(opts.dist ?? -(boss.realSize + 120)), y: Math.sin(a) * -(opts.dist ?? -(boss.realSize + 120)) };
        t.team = -1 - i;
        t.controllers = [{ think: () => ({ target: { x: boss.x - t.x, y: boss.y - t.y }, goal: { x: t.x, y: t.y }, fire: true, alt: !!opts.alt, main: true }) }];
        crew.push(t);
    }
    let worst = 0, last = boss.health.amount + boss.shield.amount, ticks = 0;
    const pool = guard.poolOf(boss);
    const limit = (opts.limit || 120) * 30;
    for (; ticks < limit; ticks++) {
        if (boss.isDead() || boss.health.amount <= 0) break;
        boss.x = 0; boss.y = 0; boss.velocity.x = boss.velocity.y = 0;
        for (const t of crew) { t.x = t.home.x; t.y = t.home.y; t.velocity.x = t.velocity.y = 0; t.invuln = false; }
        loop(1);
        guard.regenGate(boss, bosses.TUNING.regenEvery);
        if (ticks % 3 === 0) handler.regenHealthAndShield();
        if (boss.isDead() || boss.health.amount <= 0) { ticks++; break; }
        const now = boss.health.amount + boss.shield.amount;
        if (last - now > worst) worst = last - now;
        last = now;
    }
    const out = { secs: ticks / 30, dead: boss.isDead() || boss.health.amount <= 0, worstTick: worst / pool };
    clearAll();
    return out;
}

test('per hit and per tank: the cap itself (rate cap switched on)', () => {
    guard.setRateCap(true);
    try { capChecks(); } finally { guard.setRateCap(false); }
});
function capChecks() {
    const boss = makeBoss();
    const pool = guard.poolOf(boss);
    const a = { id: 1 }, b = { id: 2 }, c = { id: 3 }, d = { id: 4 };
    const now = 1e12;
    assert.ok(Math.abs(guard.capHit(boss, a, pool, now) - pool * guard.HIT_SHARE) < 1e-9, 'one huge hit');
    assert.equal(guard.capHit(boss, a, 1, now), guard.TANK_DMG_MULT, 'small hits pass (at the tank damage cut)');
    let got = 0;
    for (let i = 0; i < 60; i++) got += guard.capHit(boss, a, pool * 0.01, now + i);
    assert.ok(got <= pool * guard.TANK_SHARE_S + 1e-6, 'one tank, one second');
    // a bullet counts for the tank that fired it
    const shot = { id: 99, master: b };
    let gb = 0;
    for (let i = 0; i < 60; i++) gb += guard.capHit(boss, shot, pool * 0.01, now + i);
    assert.ok(gb > pool * 0.02, 'a second tank has its own share');
    for (let i = 0; i < 60; i++) { guard.capHit(boss, c, pool * 0.01, now + i); guard.capHit(boss, d, pool * 0.01, now + i); }
    const all = boss._dmgWin.all;
    assert.ok(all <= pool * guard.ALL_SHARE_S + 1e-6, 'everyone together');
    // the next second starts fresh
    assert.ok(guard.capHit(boss, a, pool * 0.01, now + 1000) > 0);
    // the tutorial's practice boss is left alone
    boss.isTutorialBot = true;
    assert.equal(guard.capHit(boss, a, pool, now + 2000), pool);
    clearAll();
}

test('per hit: a drone or a big shell takes a bigger bite than a small bullet', () => {
    const boss = makeBoss();
    const pool = guard.poolOf(boss);
    const now = 1e12;
    assert.ok(Math.abs(guard.capHit(boss, { id: 1, type: 'bullet', size: 6 }, pool, now) - pool * guard.HIT_SHARE) < 1e-6, 'small bullet');
    assert.ok(Math.abs(guard.capHit(boss, { id: 2, type: 'drone', size: 30 }, pool, now + 1) - pool * guard.DRONE_HIT_SHARE) < 1e-6, 'drone');
    assert.ok(Math.abs(guard.capHit(boss, { id: 3, type: 'bullet', size: 24 }, pool, now + 2) - pool * guard.BIG_SHOT_HIT_SHARE) < 1e-6, 'big shell');
    assert.ok(Math.abs(guard.capHit(boss, { id: 4, type: 'minion', size: 20 }, pool, now + 3) - pool * guard.HIT_SHARE) < 1e-6, 'minions keep the bullet share');
    // a maxed Big Cheese gets a boss down in real time now
    const cheese = ttk('bigCheese', { limit: 60 });
    log('     big cheese ttk s: ' + cheese.secs.toFixed(1));
    assert.ok(cheese.dead && cheese.secs < 25, 'big cheese took ' + cheese.secs + ' s');
    clearAll();
});

test('default: no per-second cap, only the per-hit one', () => {
    const boss = makeBoss();
    const pool = guard.poolOf(boss);
    const a = { id: 1 };
    let got = 0;
    for (let i = 0; i < 60; i++) got += guard.capHit(boss, a, pool * 0.01, 1e12 + i);
    assert.ok(got > pool * 0.5 * guard.TANK_DMG_MULT, 'one tank lands what it deals (cut to TANK_DMG_MULT): ' + (got / pool * 100).toFixed(1) + '% in a second');
    assert.ok(Math.abs(guard.capHit(boss, a, pool, 1e12 + 99) - pool * guard.HIT_SHARE) < 1e-9, 'one huge hit is still capped');
    const anni = ttk('annihilator', { limit: 60 });
    const basic = ttk('basic', { limit: 150 });
    log('     uncapped ttk s: annihilator ' + anni.secs.toFixed(1) + ', basic ' + basic.secs.toFixed(1));
    assert.ok(anni.dead && basic.dead, 'both get it done');
    clearAll();
});

test('ttk (rate cap on): big hitters need real time; off, they shred it', () => {
    guard.setRateCap(true);
    try { ttkChecks(); } finally { guard.setRateCap(false); }
});
function ttkChecks() {
    const anni = ttk('annihilator');
    const construct = ttk('construct', { dist: -60 });
    const grown = ttk('destroyer', { growth: 2.6 });
    for (const [name, r] of [['annihilator', anni], ['construct', construct], ['grown destroyer', grown]]) {
        assert.ok(r.worstTick <= guard.TANK_SHARE_S + 1e-6, name + ' worst tick ' + (r.worstTick * 100).toFixed(2) + '%');
        assert.ok(!r.dead || r.secs >= 30, name + ' took ' + r.secs + ' s');
    }
    // a maxed Basic still kills it alone in under a minute; three of them
    // in well under half that
    const basic = ttk('basic', { limit: 150 });
    assert.ok(basic.dead && basic.secs >= 25 && basic.secs < 60, 'basic took ' + basic.secs + ' s');
    const group = ttk('basic', { limit: 60, count: 3 });
    assert.ok(group.dead && group.secs < basic.secs * 0.5, 'three basics took ' + group.secs + ' s');
    // switched off: the annihilator does it far faster
    guard.setEnabled(false);
    try {
        const off = ttk('annihilator', { limit: 60 });
        assert.ok(off.dead && off.secs < anni.secs * 0.6, 'off ' + off.secs + ' s vs ' + anni.secs);
    } finally { guard.setEnabled(true); }
    log('     ttk s: annihilator ' + anni.secs.toFixed(1) + ', construct ' + construct.secs.toFixed(1) +
        ', grown destroyer ' + grown.secs.toFixed(1) + ', basic ' + basic.secs.toFixed(1) + ', three basics ' + group.secs.toFixed(1));
}

test('schedule: one boss per storm cycle, early in it, gone when it ends; none in the last storm', () => {
    const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
    raidMods.roll('copper_rush');   // no Warden's Watch (that one allows a second boss)
    storm.setCycles(3);
    storm.start();
    bosses.resetRaid();
    bosses.tick(Date.now(), 2);
    assert.equal(bosses.current(), null, 'not in the first seconds of a cycle');
    // (round 7) a raid's first cycle: not before 3 minutes
    storm.debugSeek(30);
    bosses.tick(Date.now(), 2);
    assert.equal(bosses.current(), null, 'not 30 s into a new raid');
    storm.debugSeek(bosses.FIRST_CYCLE_DELAY_MS / 1000 + 5);
    bosses.tick(Date.now(), 2);
    const b = bosses.current();
    assert.ok(b, 'surfaces early in the cycle');
    assert.ok(Math.abs(bosses.snapshot().until - storm.resetAt()) < 50, 'burrows when the cycle ends');
    b.controllers = [];
    b.kill();
    bosses.tick(Date.now(), 2);
    bosses.tick(Date.now(), 2);
    const after = bosses.current();
    assert.ok(!after || after === b, 'one per cycle: no second boss after a kill');
    // the last storm is the Core's
    storm.debugFinal(6 * 60);
    bosses.tick(Date.now(), 2);
    assert.equal(bosses.current(), null, 'no boss in the last storm');
    assert.equal(bosses.nextIn(), Infinity);
    storm.stop && storm.stop();
    clearAll();
});

test('payout: a boss killed through the cap still erupts its gems', () => {
    const spots = () => [...entities.values()].filter(e => e.isGemPickup && !e.isDead()).length;
    const before = spots();
    const boss = bosses.spawn('warden');
    assert.ok(boss, 'spawned');
    boss.controllers = [];
    const t = attacker('annihilator', MAXED, boss.x - (boss.realSize + 120));
    t.y = boss.y;
    t.controllers = [{ think: () => ({ target: { x: boss.x - t.x, y: boss.y - t.y }, goal: { x: t.x, y: t.y }, fire: true, main: true }) }];
    boss.health.amount = boss.health.max * 0.03; boss.shield.amount = 0;
    const bx = boss.x, by = boss.y;
    for (let i = 0; i < 30 * 20 && !boss.isDead(); i++) {
        boss.x = bx; boss.y = by; boss.velocity.x = boss.velocity.y = 0; t.invuln = false;
        loop(1);
        bosses.tick(Date.now(), 2);
    }
    assert.ok(boss.isDead(), 'killed');
    bosses.tick(Date.now(), 2);
    assert.equal(bosses.current(), null);
    assert.ok(spots() > before + 5, 'gems erupted: ' + (spots() - before));
    assert.ok(bosses.damageBy(t) >= 0);
    clearAll();
});

test('first minutes: a boss no longer ignores a first-minutes player', () => {
    const boss = makeBoss();
    boss.bossKind = 'drillhead';
    const p = { id: 4242, isPlayer: true, nxBossSafe: true, health: { amount: 200 }, damageReceived: 0, sendMessage(m) { this.told = m; } };
    const shot = { master: boss, type: 'bullet', kill() { this.killed = true; } };
    const now = Date.now();
    assert.equal(guard.intoPlayer(p, shot, 40, now), 40, 'full damage');
    assert.ok(!shot.killed, 'the shot is real');
    const nd = require(path.join(SERVER, 'game', 'terrain', 'newcomerDirector.js'));
    assert.equal(nd.TUNE.BOSS_SAFE_MIN, undefined, 'the director no longer grants boss immunity');
    clearAll();
});

test('newcomers: boss damage is the same as anyone\'s (the old mercy only with ROYALE_BOSS_NEWBIE=1)', () => {
    const boss = makeBoss();
    boss.bossKind = 'drillhead';
    const turret = { master: boss, type: 'bullet' };
    const shot = { master: turret, type: 'bullet' };
    const p = { isPlayer: true, botNewbie: true, health: { amount: 200 }, damageReceived: 0 };
    const v = { isPlayer: true, botNewbie: false, botNewness: 0, health: { amount: 200 }, damageReceived: 0 };
    const now = Date.now();
    assert.equal(guard.intoPlayer(p, shot, 40, now), guard.intoPlayer(v, shot, 40, now), 'newcomer = veteran');
    assert.equal(guard.intoPlayer(p, shot, 40, now), 40, 'full damage');
    assert.equal(guard.intoPlayer(p, boss, 40, now), 40, 'hull contact too');
    // the last blow lands
    p.health.amount = 6;
    assert.equal(guard.intoPlayer(p, shot, 400, now), 400, 'no floor at 1 health');
    p.health.amount = 200;
    // the Warden, Wraith and Colossus hit softer for everyone
    boss.bossKind = 'warden';
    assert.ok(Math.abs(guard.intoPlayer(p, shot, 40, now) - 24) < 1e-9, 'warden: 60%');
    boss.bossKind = 'wraith';
    assert.ok(Math.abs(guard.intoPlayer(p, shot, 40, now) - 22) < 1e-9, 'wraith: 55%');
    boss.bossKind = 'drillhead';
    // the env switch still brings the old rule back (off by default)
    guard.setSpare(true);
    try { assert.equal(guard.intoPlayer(p, shot, 40, now), 40 * guard.NEWBIE_DMG_MIN, 'ROYALE_BOSS_NEWBIE=1: the old quarter'); }
    finally { guard.setSpare(process.env.ROYALE_BOSS_NEWBIE === '1'); }
    clearAll();
});

function player(x, y, newbie) {
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = true; t.team = -100 - (Math.random() * 1e5 | 0); t.alwaysActive = true; t.reverseTank = 1;
    t.socket = { talk() {}, status: {}, camera: { x: 0, y: 0 } }; t.sendMessage = () => {};
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
    t.botNewbie = !!newbie; t.botNewness = newbie ? 1 : 0;
    t.controllers = [];
    return t;
}
function bossArmed() {
    const boss = makeBoss('warden');
    boss.define({ CONTROLLERS: ['nearestDifferentMaster'] }, false, true, false);
    boss.controllers = boss.controllers.filter(c => c.constructor && c.constructor.name === 'io_nearestDifferentMaster');
    return boss;
}

test('newcomers: a boss in full fire finishes a newcomer like a veteran', () => {
    for (const newbie of [true, false]) {
        const boss = bossArmed();
        const p = player(-(boss.realSize + 140), 0, newbie);
        let ticks = 0;
        for (; ticks < 30 * 25 && !p.isDead(); ticks++) {
            boss.x = 0; boss.y = 0; boss.velocity.x = boss.velocity.y = 0;
            p.x = -(boss.realSize + 140); p.y = 0; p.velocity.x = p.velocity.y = 0; p.invuln = false;
            loop(1);
            if (ticks % 3 === 0) handler.regenHealthAndShield();
        }
        assert.ok(p.isDead(), (newbie ? 'a newcomer' : 'a veteran') + ' in that spot dies (' + (ticks / 30).toFixed(1) + ' s)');
        clearAll();
    }
});

test('newcomers: boss guns take the nearest, newcomer or not', () => {
    const boss = bossArmed();
    const ctl = boss.controllers[0];
    const fresh = player(-(boss.realSize + 120), 0, true);
    const vet = player(boss.realSize + 260, 0, false);
    loop(1);
    const aims = () => { ctl.targetLock = undefined; ctl.tick = 99; ctl.think({}); return ctl.targetLock; };
    assert.equal(aims(), fresh, 'the nearer newcomer');
    vet.kill(); fresh.kill(); loop(2);
    clearAll();
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
