'use strict';
process.env.ROYALE_OPEN_GRACE_S = '0';

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

const realNow = Date.now;
let fake = realNow();
Date.now = () => fake;

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
try { require(path.join(SERVER, 'game', 'terrain', 'royaleLayout.js')).carveMatchPois(grid); } catch { }
const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const fair = require(path.join(SERVER, 'game', 'terrain', 'fairPlay.js'));
const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
const tier5 = require(path.join(SERVER, 'game', 'terrain', 'tier5.js'));
const T = require(path.join(SERVER, 'miscFiles', 'botTanks.js'));
royale.tick();

let ticks = 0;
const step = (n) => {
    for (let i = 0; i < n; i++) {
        fake += 1000 / 30;
        handler.gameloop();
        if (++ticks % 6 === 0) { try { handler.quickMaintainLoop(); } catch { } }
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
function openSpot() {
    const st = storm.snapshot();
    for (let i = 0; i < 300; i++) {
        const a = i * 2.39996, d = 200 + (i % 12) * 90;
        const qx = st.cx + Math.cos(a) * d, qy = st.cy + Math.sin(a) * d;
        let ok = true;
        for (let o = -400; o <= 900; o += 200) if (fair.inRing(qx + o, qy) || fair.vaultNear(qx + o, qy)) { ok = false; break; }
        if (ok) return { x: qx, y: qy };
    }
    return { x: st.cx, y: st.cy };
}
const CHILD = new Set(['drone', 'minion', 'swarm']);
const rootOf = (e) => { let r = e, h = 0; while (r.master && r.master !== r && h++ < 8) r = r.master; return r; };
const kidsOf = (m) => [...entities.values()].filter(e => e !== m && !e.isDead() && CHILD.has(e.type) && rootOf(e) === m);

let ids = 9000;
function target(o) {
    const p = new Entity({ x: o.x, y: o.y });
    p.define('basic'); p.isPlayer = true; p.team = -7; p.name = 'Target'; p.alwaysActive = true;
    const s = { id: ids++, packets: [], status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, _careerPlayMs: 3_600_000, talk() {} };
    p.socket = s; s.player = { body: p }; p.sendMessage = () => {}; p.reverseTank = 1;
    global.gameManager.socketManager.clients = [s];
    while (p.skill.level < 45) { p.skill.score += p.skill.levelScore; p.skill.maintain(); }
    p.refreshBodyAttributes();
    royale.freshRaidBody(p);
    p.invuln = false; p.botGraceUntil = 0; p.botNewbie = false; p.botSoftUntil = 0; p.botDifficulty = 1; p.spawnGraceUntil = 0;
    return p;
}
function botIn(name, o) {
    const t5 = tier5.tierOf(name) === 5;
    const before = handler.bots.length;
    handler.spawnBots({ x: o.x + 650, y: o.y }, -770 - (ids++ & 0xff), null, { respawnsRemaining: 0, tank: t5 ? T.pathFor(name)[2] : name });
    const m = handler.bots[before];
    if (t5) {
        const g0 = m._growTarget; m._growTarget = tier5.T5_GROWTH; tier5.note(m); m._growTarget = g0;
        while (m.skill.level < 60) { m.skill.score += m.skill.levelScore; m.skill.maintain(); }
        const i = m.upgrades.findIndex(u => u && Array.isArray(u.class) && u.class.length === 1 && (u.class[0] === name || u.class[0] === Class[name]));
        if (i >= 0) { m.upgrade(i); handler.configureBotStats(m); }
    }
    m.botGraceUntil = 0; m.botWakeAt = 0;
    step(60);
    handler.armBot(m); m.invuln = false; m.spawnGraceUntil = 0;
    return m;
}
function duel(name, secs, each = null) {
    const o = openSpot();
    clear(o.x + 300, o.y, 1100);
    const p = target(o);
    const m = botIn(name, o);
    assert.equal(String(m.defs[0]), name, 'the bot is in ' + name);
    const r = { spawned: new Set(), near: 0, mainTicks: 0, n: 0 };
    const end = fake + secs * 1000;
    while (fake < end && !m.isDead() && !p.isDead()) {
        step(1);
        if (!p.isDead()) { p.health.amount = p.health.max; if (p.shield) p.shield.amount = p.shield.max; }
        if (!m.isDead()) m.health.amount = Math.max(m.health.amount, m.health.max * 0.6);
        p.x = o.x; p.y = o.y; p.velocity.x = 0; p.velocity.y = 0;
        m.x = o.x + 650; m.y = o.y; m.velocity.x = 0; m.velocity.y = 0;
        const ks = kidsOf(m);
        for (const k of ks) r.spawned.add(k.id);
        if (ks.some(k => Math.hypot(k.x - p.x, k.y - p.y) < 260)) r.near++;
        if (m.control.main) r.mainTicks++;
        r.n++;
        if (each) each(m, p, ks);
    }
    r.near /= Math.max(1, r.n);
    r.main = r.mainTicks / Math.max(1, r.n);
    r.droneSteer = !!m.botDroneSteer;
    for (const e of [...entities.values()]) if (rootOf(e) === m || rootOf(e) === p) { try { e.kill(); } catch { } }
    step(5);
    return r;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SAMPLE = ['hybrid', 'xp_g652', 'banshee', 'xp_g654', 'beekeeper', 'overlord', 'factory', 'xp_g810'];
for (const name of SAMPLE) {
    test(name + ': spawns its helpers and sends them at a tank 650 away', () => {
        const r = duel(name, 9);
        assert.ok(r.spawned.size > 0, name + ' spawned nothing');
        assert.ok(r.near >= 0.35, name + ' helpers reached the target on ' + r.near.toFixed(2) + ' of ticks');
        if (!r.droneSteer) assert.ok(r.main < 0.05, name + ' hull main stays off for its auto turrets: ' + r.main.toFixed(2));
    });
}

test('a spared player is left alone by the helpers too', () => {
    let checked = 0;
    duel('hybrid', 5, (m, p, ks) => {
        if (fake < (m._t0 || (m._t0 = fake + 2500))) return;
        p.botGraceUntil = fake + 60_000;
        for (const k of ks) {
            const io = k.controllers.find(c => c && typeof c.botSic === 'function');
            if (!io) continue;
            m.botSic = { e: p, x: p.x, y: p.y, until: fake + 500 };
            assert.equal(io.botSic(), null, 'no sic on a player in bot grace');
            p.botGraceUntil = 0;
            const s = io.botSic();
            assert.ok(s && s.main && Math.abs(s.target.x - (p.x - k.x)) < 1, 'sic on the same player out of grace');
            p.botGraceUntil = fake + 60_000;
            checked++;
        }
    });
    assert.ok(checked > 0, 'checked a helper');
});

test('necro tanks with one other gun are out of the bot pool', () => {
    assert.equal(T.weightOf('xp_g74'), 0);
    assert.equal(T.weightOf('xp_g76'), 0);
    assert.ok(T.weightOf('xp_g653') > 0, 'two swarm guns besides: stays');
    const pool = T.pool(handler.botTankExclusions()).map(o => o.name);
    assert.ok(!pool.includes('xp_g74') && !pool.includes('xp_g76'));
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); log('ok   ' + t.name); }
        catch (e) { failed++; log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
