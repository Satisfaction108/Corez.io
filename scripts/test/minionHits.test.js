// What a tank's helpers hit: node scripts/test/minionHits.test.js
//
// A Factory's minions (their hulls and their bullets), an Overseer's drones
// and a Trapper's traps must all hurt an enemy player, an enemy bot, a loot
// chest, a supply crate, a raid boss and the Core. A chest broken by a
// minion pays out to the Factory's owner.
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

const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
const grid = mapGen.generate({ cols: 13, rows: 13, tileWidth: 420, fullLattice: true });
grid.buildVoronoiColliders();
global.gameManager = {
    room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1.5, clients: [], terrainGrid: grid,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;
const loop = (n = 1) => { for (let i = 0; i < n; i++) handler.gameloop(); };
const chests = require(path.join(SERVER, 'game', 'terrain', 'chests.js'));

// open ground for everything
const AX = -1500, AY = -1500;
for (const r of grid.rocks.values()) {
    if (!r.worldPoly || Math.hypot(r.worldCx - AX, r.worldCy - AY) > 1400) continue;
    r.alive = false; r.growing = false; r.health = 0; r.noRegrowUntil = Date.now() + 1e9; r.canyon = false;
}

let seq = 0;
function owner(cls) {
    const t = new Entity({ x: AX - 600, y: AY - 600 });
    t.define(cls);
    t.isPlayer = true; t.team = -1; t.name = 'Owner';
    t.packets = [];
    t.socket = { talk: (...a) => t.packets.push(a) };
    t.sendMessage = () => {}; t.alwaysActive = true;
    t.invuln = false;
    return t;
}
function target(kind) {
    const x = AX + (++seq % 5) * 120, y = AY + 200;
    let o;
    if (kind === 'player' || kind === 'bot') {
        o = new Entity({ x, y });
        o.define('basic');
        o.team = -10 - seq;
        if (kind === 'player') { o.isPlayer = true; o.socket = { talk() {} }; o.sendMessage = () => {}; }
        else { o.isBot = true; o.controllers = []; }
        o.invuln = false;
    } else if (kind === 'chest' || kind === 'crate') {
        o = chests.spawnChest(x, y, kind === 'crate', { gems: 0, item: null });
        if (kind === 'crate') { o.supplyDrop = true; o.isSupplyCrate = true; }
    } else if (kind === 'boss') {
        o = new Entity({ x, y });
        o.define('royaleVaultWarden');
        o.isRoyaleBoss = true;
        o.refreshBodyAttributes();
        o.health.set(50_000); o.health.amount = 50_000;
    } else if (kind === 'core') {
        o = new Entity({ x, y });
        o.define('royaleCore');
        o.team = TEAM_ROOM; o.isLootChest = true; o.isRoyaleCore = true;
        o.refreshBodyAttributes();
        o.health.set(50_000); o.health.amount = 50_000;
        o.pinX = o.x; o.pinY = o.y;
    }
    o.alwaysActive = true;
    if (o.shield) { o.shield.max = 0; o.shield.amount = 0; }
    return o;
}
const hp = (o) => o.health.amount + (o.shield ? o.shield.amount : 0);

// fire every gun of `body` once -> the new entities it made
function spawnFrom(body) {
    const before = new Set(entities.keys());
    for (const g of body.guns.values()) { try { g.fire(0, 0); } catch (e) { /* some guns need a child count */ } }
    loop(1);
    return [...entities.values()].filter(e => !before.has(e.id) && e.master && e.id !== body.id);
}
// one helper pressed into the target: did the target lose health?
function hits(proj, tgt) {
    proj.alwaysActive = true;
    proj.controllers = [];
    const h0 = hp(tgt);
    for (let i = 0; i < 12 && !proj.isDead() && !tgt.isDead(); i++) {
        const dx = tgt.x - proj.x, dy = tgt.y - proj.y, d = Math.hypot(dx, dy) || 1;
        const touch = (tgt.realSize || tgt.size) + (proj.realSize || proj.size) - 4;
        if (d > touch) { proj.x = tgt.x - dx / d * touch; proj.y = tgt.y - dy / d * touch; }
        proj.velocity.x = dx / d * 6; proj.velocity.y = dy / d * 6;
        loop(1);
    }
    loop(2);     // what landed is paid out on the next tick
    return h0 - hp(tgt);
}

const TARGETS = ['player', 'bot', 'chest', 'crate', 'boss', 'core'];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

for (const [cls, kind] of [['factory', 'minion'], ['overseer', 'drone'], ['trapper', 'trap']]) {
    test(cls + ': its ' + kind + 's hurt every kind of target', () => {
        for (const tk of TARGETS) {
            const own = owner(cls);
            const tgt = target(tk);
            const made = spawnFrom(own).filter(e => e.type === kind);
            assert.ok(made.length, cls + ' made a ' + kind);
            const dealt = hits(made[0], tgt);
            assert.ok(dealt > 0, cls + ' ' + kind + ' vs ' + tk + ': ' + dealt.toFixed(2));
            for (const e of made) e.kill();
            own.kill(); if (!tgt.isDead()) tgt.kill();
            loop(2);
        }
    });
}

test('factory: its minions\' bullets hurt every kind of target', () => {
    for (const tk of TARGETS) {
        const own = owner('factory');
        const tgt = target(tk);
        const min = spawnFrom(own).find(e => e.type === 'minion');
        assert.ok(min, 'a minion');
        min.alwaysActive = true; min.controllers = [];
        const shots = spawnFrom(min).filter(e => e.type === 'bullet');
        assert.ok(shots.length, 'the minion fired');
        const dealt = hits(shots[0], tgt);
        assert.ok(dealt > 0, 'minion bullet vs ' + tk + ': ' + dealt.toFixed(2));
        for (const e of shots) e.kill();
        min.kill(); own.kill(); if (!tgt.isDead()) tgt.kill();
        loop(2);
    }
});

test('a chest broken by a minion\'s bullet pays the Factory\'s owner', () => {
    const own = owner('factory');
    const chest = target('chest');
    chest.health.amount = 1;
    const min = spawnFrom(own).find(e => e.type === 'minion');
    min.alwaysActive = true; min.controllers = [];
    const shot = spawnFrom(min).find(e => e.type === 'bullet');
    hits(shot, chest);
    loop(3);
    assert.ok(chest.isDead(), 'broken');
    assert.ok(chest.hitters && chest.hitters.has(own.id), 'counted to the owner');
    assert.ok(own.packets.some(p => p[0] === 'KC' && p[1] === 'chest'), 'and the owner gets the chest');
    own.kill(); min.kill();
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
