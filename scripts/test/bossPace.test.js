// Boss pace and boss damage intake: node scripts/test/bossPace.test.js
//
//   rate       bosses come ~2.5x as often (ROYALE_BOSS_RATE): first one 3
//              min in, the next ~5.6 min after; Warden's Watch multiplies
//              on top
//   per hit    no single collision tick takes more than 1.75% of a boss
//   per tank   one tank gets at most 2.8% a second through, everyone
//              together 7.5%
//   ttk        a maxed Annihilator, a Constructor's traps and a grown tank
//              all need over 30 s alone, a maxed Basic 25-60 s, three
//              together less than half; switched off they shred it (a
//              Constructor in about a second)
//   regen      a boss under fire does not regenerate
//   payout     a boss killed through the cap still erupts its gems
//   newcomers  boss bullets and hull hit a new player for a quarter (back to
//              full as newness fades), never take them under 1 health unless
//              they shot the boss in the last 8 s, and boss guns take anyone
//              else in reach first; idle players and ROYALE_BOSS_NEWBIE=0 get
//              none of it
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

test('per hit and per tank: the cap itself', () => {
    const boss = makeBoss();
    const pool = guard.poolOf(boss);
    const a = { id: 1 }, b = { id: 2 }, c = { id: 3 }, d = { id: 4 };
    const now = 1e12;
    assert.ok(Math.abs(guard.capHit(boss, a, pool, now) - pool * guard.HIT_SHARE) < 1e-9, 'one huge hit');
    assert.equal(guard.capHit(boss, a, 1, now), 1, 'small hits pass');
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
});

test('ttk: big hitters need real time; off, they shred it', () => {
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
});

test('schedule: one boss per storm cycle, early in it, gone when it ends; none in the last storm', () => {
    const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
    raidMods.roll('copper_rush');   // no Warden's Watch (that one allows a second boss)
    storm.setCycles(3);
    storm.start();
    bosses.resetRaid();
    bosses.tick(Date.now(), 2);
    assert.equal(bosses.current(), null, 'not in the first seconds of a cycle');
    storm.debugSeek(30);
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

test('newcomers: boss damage softened, no last blow, guns look elsewhere first', () => {
    const boss = makeBoss();
    // the Drillhead hits at full strength, so only the newcomer rules show here
    boss.bossKind = 'drillhead';
    const turret = { master: boss, type: 'bullet' };
    const shot = { master: turret, type: 'bullet' };
    const p = { isPlayer: true, botNewbie: true, health: { amount: 200 }, damageReceived: 0 };
    const now = Date.now();
    assert.equal(guard.intoPlayer(p, shot, 40, now), 40 * guard.NEWBIE_DMG_MIN, 'a quarter at full newness');
    assert.equal(guard.intoPlayer(p, boss, 40, now), 40 * guard.NEWBIE_DMG_MIN, 'hull contact too');
    p.botNewbie = false; p.botNewness = 0.5;
    assert.ok(Math.abs(guard.intoPlayer(p, shot, 40, now) - 40 * 0.625) < 1e-9, 'fading back');
    p.botNewness = 0;
    assert.equal(guard.intoPlayer(p, shot, 40, now), 40, 'not new: full damage');
    // the Warden, Wraith and Colossus hit softer for everyone
    boss.bossKind = 'warden';
    assert.ok(Math.abs(guard.intoPlayer(p, shot, 40, now) - 24) < 1e-9, 'warden: 60%');
    boss.bossKind = 'wraith';
    assert.ok(Math.abs(guard.intoPlayer(p, shot, 40, now) - 22) < 1e-9, 'wraith: 55%');
    boss.bossKind = 'drillhead';
    // a bot's shot is none of this
    const bot = { isBot: true }; bot.master = bot;
    p.botNewbie = true;
    assert.equal(guard.intoPlayer(p, { master: bot }, 40, now), 40);
    // the last blow: never under 1 health from a boss...
    p.health.amount = 6;
    assert.ok(guard.intoPlayer(p, shot, 400, now) <= 5, 'kept at 1');
    p.damageReceived = 5;
    assert.equal(guard.intoPlayer(p, shot, 400, now), 0, 'already at the floor this tick');
    p.damageReceived = 0;
    // ...unless they are fighting it
    guard.capHit(boss, { master: p }, 1);
    assert.ok(p._hitBossAt >= now);
    assert.equal(guard.intoPlayer(p, shot, 400, now), 400 * guard.NEWBIE_DMG_MIN);
    p._hitBossAt = 0;
    // idle a minute: no mercy
    const idler = { isPlayer: true, botNewbie: true, health: { amount: 6 }, damageReceived: 0, socket: { lastInputAt: now - 10 * MIN } };
    assert.equal(guard.intoPlayer(idler, shot, 40, now), 40);
    // switched off
    guard.setSpare(false);
    try { assert.equal(guard.intoPlayer(p, shot, 400, now), 400); } finally { guard.setSpare(true); }
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

test('newcomers: a boss in full fire cannot finish one off', () => {
    for (const newbie of [true, false]) {
        const boss = bossArmed();
        const p = player(-(boss.realSize + 140), 0, newbie);
        let ticks = 0, low = Infinity;
        for (; ticks < 30 * 25 && !p.isDead(); ticks++) {
            boss.x = 0; boss.y = 0; boss.velocity.x = boss.velocity.y = 0;
            p.x = -(boss.realSize + 140); p.y = 0; p.velocity.x = p.velocity.y = 0; p.invuln = false;
            loop(1);
            if (ticks % 3 === 0) handler.regenHealthAndShield();
            low = Math.min(low, p.health.amount);
        }
        if (newbie) {
            assert.ok(!p.isDead(), 'the newcomer lives');
            assert.ok(low >= 0.99, 'held at 1 health or more: ' + low);
            assert.ok(low < p.health.max * 0.5, 'it was really under fire: ' + low);
        } else assert.ok(p.isDead(), 'a veteran in the same spot dies (' + (ticks / 30).toFixed(1) + ' s)');
        clearAll();
    }
});

test('newcomers: boss guns take someone else first', () => {
    const boss = bossArmed();
    const ctl = boss.controllers[0];
    const fresh = player(-(boss.realSize + 120), 0, true);
    const vet = player(boss.realSize + 260, 0, false);
    loop(1);
    const aims = () => { ctl.targetLock = undefined; ctl.tick = 99; ctl.think({}); return ctl.targetLock; };
    assert.equal(aims(), vet, 'the veteran, though further');
    // locked on the newcomer already: lets go once someone else is in reach
    ctl.targetLock = fresh; ctl.tick = 99; ctl.think({});
    assert.equal(ctl.targetLock, vet);
    // a newcomer shooting the boss is fair game
    fresh._hitBossAt = Date.now();
    assert.equal(aims(), fresh, 'picked the fight: nearest again');
    fresh._hitBossAt = 0;
    // alone, the newcomer is still a target (only the damage is soft)
    vet.kill(); loop(2);
    assert.equal(aims(), fresh);
    clearAll();
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
