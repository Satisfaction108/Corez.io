// Reconnect resume and rock contact for big tanks: node scripts/test/resume.test.js
//
//   push       one rock push never throws a hull further than its cap, and
//              a grown hull sunk in solid rock settles near where it was
//   resume     a grown tank that drops and comes back gets its size, health
//              and spot back; rock that grew into the spot meanwhile is
//              cleared like a spawn pocket (no ejection), it is never crushed
//              or flung in the ticks after, and the resume happens once
//   reload     with nothing to protect a reload drops you somewhere new
//              (build, bank, raid kept; no new life or starter gems; the big
//              fall); gems, a fight or a hunted mark keep the spot, the full
//              fall drawn only
//   emerald    an emerald where the hull would land moves it to the nearest
//              spot it fits, a short way off
//   small      a normal tank resting against a wall keeps that wall
//   bounds     huge tanks (spawns, respawns, resumes, rock closing over them,
//              a spot past the edge) always end up on the map with their hull,
//              never in the empty ring outside the disk, and spawns land in
//              the storm's safe circle
//
// The raid runs in this process on a real Dig Royale terrain build (no game
// server, no sockets). Data goes under $DATA_DIR if set, else the OS temp
// dir, and is removed when everything passes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
for (const k of ['ROYALE_DEBUG', 'ROYALE_RESUME_MS', 'DEAD_LINK_MS']) delete process.env[k];
const ROOT = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, `resume-test-${process.pid}-${Date.now()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dw-resume-test-'));
process.env.DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

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
Config.royale_growth = true;
Config.tutorial = false;

const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
global.gameManager = {
    room: { width: 13 * 420, height: 9 * 420, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
// the raid's own map: the disk is cut (royaleLayout) as on the server
const grid = mapGen.generate({ cols: 13, rows: 9, tileWidth: 420, fullLattice: true });
grid.buildContour();
global.gameManager.terrainGrid = grid;
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;
const loop = (n = 1) => { for (let i = 0; i < n; i++) handler.gameloop(); };

const royale = require(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'));
const storm = require(path.join(SERVER, 'game', 'terrain', 'storm.js'));
const growth = require(path.join(SERVER, 'game', 'terrain', 'growth.js'));
storm.inStorm = () => false;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
// seeded, so a failure comes back the same way
let seed = 0x5eed1234;
function rnd() {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

let seq = 0;
function mkSocket(extra = {}) {
    const s = {
        id: 'res' + (++seq), packets: [], readyState: 1, OPEN: 1,
        status: {}, camera: { x: 0, y: 0 }, _careerLives: 100, resumeToken: 'tokRes' + seq + 'abcdefgh',
        ...extra,
    };
    s.talk = (...a) => s.packets.push(a);
    s.close = () => {};
    s.terminate = () => {};
    return s;
}
function spawnTank(socket) {
    const t = new Entity({ x: 0, y: 0 });
    t.define('basic');
    t.isPlayer = true;
    t.team = -1 - seq;
    t.name = 'Res' + seq;
    t.alwaysActive = true;
    const player = {
        socket, body: t, target: { x: 120, y: 0 },
        command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, sidearm: 0, autofire: false, autospin: false, override: false, autoalt: false, spinlock: false },
    };
    socket.player = player;
    t.socket = socket;
    t.become(player);
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
    global.gameManager.socketManager.clients.push(socket);
    global.gameManager.socketManager.players.push(player);
    royale.onHumanJoin(t);
    return t;
}
// grown inside this life: the whole growth score counts, at full size now
function grow(body, pts) {
    royale.addGrowth(body, pts);
    const s = royale.growthScore(body);
    growth.onSpawn(body, s, s);
}
// a spot in solid rock, well inside the map and away from emeralds
function solidSpot(r, used) {
    for (let k = 0; k < 4000; k++) {
        const x = (rnd() - 0.5) * 3600, y = (rnd() - 0.5) * 2400;
        if (!grid.pointInRock(x, y) || Math.hypot(x, y) > grid.circleRadius - r - 100) continue;
        if (used.some(u => Math.hypot(u.x - x, u.y - y) < r * 4)) continue;
        const hits = [];
        grid.rocksHitByCircle(x, y, r * 2, hits);
        if (hits.length < 4 || hits.some(h => h.ore === 4 || h.canyon)) continue;
        used.push({ x, y });
        return { x, y };
    }
    throw new Error('no solid spot');
}
// the terrain pass's rock contact for one tank, ticks times
function settle(body, ticks, onTick) {
    let entombed = 0;
    for (let i = 0; i < ticks; i++) {
        const now = Date.now();
        grid.regrowTick(now);
        const p = grid.settleTank(body, body.realSize, now, grid.growingRocks().length > 0,
            body.growthMult > 1 ? (b) => royale.breakOutGrown(b) > 0 : null);
        if (p.entombed) entombed++;
        if (onTick) onTick(i);
    }
    return entombed;
}
function blockingRocks(x, y, r) {
    const hits = [];
    grid.rocksHitByCircle(x, y, r, hits);
    grid.growingRocksHitByCircle(x, y, r, Date.now(), hits);
    return hits.filter(h => !h.canyon && h.ore !== 4);
}

test('push: one call never moves a hull past its cap', () => {
    const used = [];
    for (const r of [30, 120, 220, 360]) {
        for (let i = 0; i < 20; i++) {
            const s = solidSpot(60, used.length > 200 ? (used.length = 0, used) : used);
            const pos = { x: s.x, y: s.y };
            const cap = Math.max(48, r * 0.35);
            const p = grid.pushCircleFromVoronoi(pos, r, cap);
            assert.ok(Math.hypot(p.dx, p.dy) <= cap + 1e-6, 'r ' + r + ' moved ' + Math.hypot(p.dx, p.dy));
        }
    }
    // uncapped (placements, gems) is unchanged
    const s = solidSpot(60, []);
    const pos = { x: s.x, y: s.y };
    const p = grid.pushCircleFromVoronoi(pos, 220);
    assert.ok(Math.hypot(p.dx, p.dy) > 0);
});

test('push: a grown hull buried in solid rock cracks out where it is', () => {
    const sock = mkSocket();
    const tank = spawnTank(sock);
    grow(tank, 200000);
    const r = tank.realSize;
    assert.ok(tank.growthMult > 3.9 && r > 80, 'the biggest a tank gets: ' + tank.growthMult.toFixed(2) + 'x r ' + r.toFixed(0));
    tank.invuln = false;
    const s = solidSpot(r, []);
    tank.x = s.x; tank.y = s.y;
    const hp = tank.health.amount;
    const entombed = settle(tank, 60);
    const moved = Math.hypot(tank.x - s.x, tank.y - s.y);
    assert.ok(moved < r * 0.75, 'stayed put: moved ' + moved.toFixed(0) + ' (r ' + r.toFixed(0) + ')');
    assert.ok(entombed <= 1, 'entombed for ' + entombed + ' ticks');
    assert.equal(blockingRocks(tank.x, tank.y, r * 0.9).length, 0, 'room cleared');
    assert.ok(tank.health.amount >= hp - 1, 'no crush damage');
    tank.kill(); loop(2);
});

test('resume: a grown tank comes back at its size and spot, the rock that grew in is cleared, nothing throws it', () => {
    const sock = mkSocket();
    const tank = spawnTank(sock);
    grow(tank, 60000);
    const g0 = tank.growthMult, r = tank.realSize;
    const s = solidSpot(r, []);
    // it sat in a pocket it made; then the rock grew back while it was gone
    tank.x = s.x; tank.y = s.y;
    tank.health.amount = tank.health.max * 0.8;
    tank.invuln = false;
    tank.carriedGems = 200;   // something to protect: it comes back where it was
    royale.disconnectCleanup(sock, tank);
    tank.kill(); loop(2);
    assert.ok(grid.pointInRock(s.x, s.y), 'the spot is rock now');

    const back = mkSocket({ resumeToken: sock.resumeToken });
    assert.equal(royale.claimResume(back, sock.resumeToken), true, 'claimed');
    const body = spawnTank(back);
    royale.applyPendingResume(back);
    assert.equal(back._resume, null, 'applied once');
    royale.applyPendingResume(back);   // the spawn path running it again is a no-op
    assert.ok(Math.abs(body.growthMult - g0) < 1e-6, 'size back: ' + body.growthMult + ' vs ' + g0);
    assert.ok(Math.abs(body.realSize - r) < 1, 'hull ' + body.realSize.toFixed(1) + ' vs ' + r.toFixed(1));
    assert.ok(Math.abs(body.health.amount / body.health.max - 0.8) < 0.01, 'health back');
    const off = Math.hypot(body.x - s.x, body.y - s.y);
    assert.ok(off < r * 0.5, 'back on its spot: ' + off.toFixed(0) + ' off (r ' + r.toFixed(0) + ')');
    assert.equal(blockingRocks(body.x, body.y, r * 0.9).length, 0, 'the spot was opened up');
    assert.equal(body.velocity.x, 0); assert.equal(body.velocity.y, 0);
    const x1 = body.x, y1 = body.y, hp = body.health.amount;
    const entombed = settle(body, 90);
    const drift = Math.hypot(body.x - x1, body.y - y1);
    assert.ok(drift < r * 0.3, 'not thrown: drifted ' + drift.toFixed(0));
    assert.equal(entombed, 0, 'never buried');
    assert.ok(body.health.amount >= hp - 1, 'no crush damage');
    // one body for this player in the world
    const mine = [...entities.values()].filter(e => e.socket === back && e.type === 'tank' && !e.isDead());
    assert.equal(mine.length, 1);
    body.kill(); loop(2);
});

// the reload rule: nothing to protect drops you in somewhere new (same
// build, bank and raid, no new life, no starter gems, the big fall); gems,
// a fight or a hunted mark keep the tank where it was
function reload(tank, sock) {
    royale.disconnectCleanup(sock, tank);
    tank.kill(); loop(2);
    const back = mkSocket({ resumeToken: sock.resumeToken });
    assert.equal(royale.claimResume(back, sock.resumeToken), true, 'claimed');
    const body = spawnTank(back);
    royale.applyPendingResume(back);
    return { back, body };
}
test('reload: nothing to protect drops you in somewhere new with the big fall, build and bank kept', () => {
    const dropIn = require(path.join(SERVER, 'game', 'terrain', 'dropIn.js'));
    const sock = mkSocket();
    const tank = spawnTank(sock);
    tank.upgrades = [];
    tank.define('twin'); tank.refreshBodyAttributes();
    const raw = tank.skill.raw.slice();
    sock.gemBanked = 640;
    const lives = sock._royaleLives | 0;
    tank.x = 600; tank.y = -400;
    tank.carriedGems = 75;   // the starter gems alone are nothing to protect
    tank._lastDamageAt = 0; tank.hitAt = 0; tank._dealtAt = 0; tank.huntedLevel = 0;
    const { back, body } = reload(tank, sock);
    // a resume puts it back within a few units; a fresh spawn is picked anew
    // (it can land in the same area by chance, never on the old spot)
    assert.ok(Math.hypot(body.x - 600, body.y + 400) > 40, 'a new spot: ' + (body.x | 0) + ',' + (body.y | 0));
    assert.deepEqual(body.defs, tank.defs, 'same tank');
    assert.deepEqual(body.skill.raw, raw, 'same build');
    assert.equal(back.gemBanked, 640, 'bank kept');
    assert.equal(body.carriedGems, 75, 'the gems come along, no second starter grant on top');
    assert.equal(back._royaleLives | 0, lives, 'not a new life');
    assert.equal(back.lastRaidDeathAt | 0, 0, 'not a death');
    const fx = back.packets.filter(a => a[0] === 'FX' && a[3] === 'dropin');
    assert.equal(fx.length, 1, 'it drops in');
    assert.equal(fx[0][6], dropIn.FALL_MS.first, 'the long first fall');
    assert.ok(fx[0][5] >= dropIn.CRATER_R, 'with a crater');
    assert.notEqual(fx[0][7], 1, 'a real landing, not a picture');
    assert.equal(dropIn.inAir(body), true, 'held until it lands');
    body.kill(); loop(2);
});
test('reload: gems, a fight or a hunted mark keep the tank where it was, with the full fall drawn', () => {
    const dropIn = require(path.join(SERVER, 'game', 'terrain', 'dropIn.js'));
    const cases = [
        ['gems', (t) => { t.carriedGems = 130; }],
        ['hurt', (t) => { t.carriedGems = 0; t._lastDamageAt = Date.now() - 3000; }],
        ['hurting', (t) => { t.carriedGems = 0; t._dealtAt = Date.now() - 2000; }],
        ['hunted', (t) => { t.carriedGems = 0; t.huntedLevel = 1; }],
    ];
    for (const [why, set] of cases) {
        const sock = mkSocket();
        const tank = spawnTank(sock);
        for (let i = 0; i < 6; i++) grid.pushCircleFromVoronoi(tank, tank.realSize);
        const x0 = tank.x, y0 = tank.y;
        tank._lastDamageAt = 0; tank.hitAt = 0; tank._dealtAt = 0; tank.huntedLevel = 0;
        set(tank);
        const { back, body } = reload(tank, sock);
        assert.ok(Math.hypot(body.x - x0, body.y - y0) < 30, why + ': same spot');
        const fx = back.packets.filter(a => a[0] === 'FX' && a[3] === 'dropin');
        assert.equal(fx.length, 1, why + ': drawn');
        assert.equal(fx[0][7], 1, why + ': only a picture');
        assert.equal(fx[0][6], dropIn.FALL_MS.first, why + ': the full fall');
        assert.equal(dropIn.inAir(body), false, why + ': nothing held');
        body.kill(); loop(2);
    }
});

test('emerald: a hull that would land on one goes to the nearest spot it fits', () => {
    // an emerald well inside the map (one is planted if the build has none there)
    let emerald = [...grid.rocks.values()].find(rk => rk.ore === 4 && rk.alive && Math.abs(rk.worldCx) < 1800 && Math.abs(rk.worldCy) < 1100);
    if (!emerald) {
        emerald = [...grid.rocks.values()].find(rk => rk.alive && !rk.canyon && !rk.ore && Math.abs(rk.worldCx) < 1500 && Math.abs(rk.worldCy) < 900);
        emerald.ore = 4;
    }
    const sock = mkSocket();
    const tank = spawnTank(sock);
    grow(tank, 20000);
    const r = tank.realSize;
    tank.x = emerald.worldCx + r * 0.3; tank.y = emerald.worldCy;
    tank.carriedGems = 200;   // something to protect: it comes back where it was
    royale.disconnectCleanup(sock, tank);
    tank.kill(); loop(2);
    const back = mkSocket({ resumeToken: sock.resumeToken });
    assert.equal(royale.claimResume(back, sock.resumeToken), true);
    const body = spawnTank(back);
    royale.applyPendingResume(back);
    assert.ok(emerald.alive, 'the emerald is still there');
    const hits = [];
    grid.rocksHitByCircle(body.x, body.y, r * 0.9, hits);
    assert.ok(!hits.includes(emerald), 'clear of the emerald');
    const off = Math.hypot(body.x - (emerald.worldCx + r * 0.3), body.y - emerald.worldCy);
    assert.ok(off < r * 4 + 300, 'a short way off: ' + off.toFixed(0));
    body.kill(); loop(2);
});

test('small: a normal tank resting on a wall gets its spot back and the wall stays', () => {
    const sock = mkSocket();
    const tank = spawnTank(sock);
    assert.ok(!(tank.growthMult > 1));
    const r = tank.realSize;
    // open ground right up against a live rock face
    let spot = null;
    for (let k = 0; k < 5000 && !spot; k++) {
        const pos = { x: (rnd() - 0.5) * 3600, y: (rnd() - 0.5) * 2200 };
        if (grid.pointInRock(pos.x, pos.y) || Math.hypot(pos.x, pos.y) > grid.circleRadius - 200) continue;
        for (let i = 0; i < 6; i++) grid.pushCircleFromVoronoi(pos, r);
        if (grid.pointInRock(pos.x, pos.y)) continue;
        const hits = [];
        grid.rocksHitByCircle(pos.x, pos.y, r * 1.02, hits);
        const rk = hits.find(h => !h.canyon && !h.ore);
        if (rk) spot = { x: pos.x, y: pos.y, rk };
    }
    assert.ok(spot, 'found a wall');
    tank.x = spot.x; tank.y = spot.y;
    tank.carriedGems = 200;   // something to protect: it comes back where it was
    royale.disconnectCleanup(sock, tank);
    tank.kill(); loop(2);
    const back = mkSocket({ resumeToken: sock.resumeToken });
    assert.equal(royale.claimResume(back, sock.resumeToken), true);
    const body = spawnTank(back);
    royale.applyPendingResume(back);
    assert.ok(spot.rk.alive, 'the wall it leaned on is still there');
    assert.ok(Math.hypot(body.x - spot.x, body.y - spot.y) < 12, 'same spot');
    body.kill(); loop(2);
});

test('bounds: huge tanks never land off the map, spawns stay in the safe circle', () => {
    const R = grid.circleRadius;
    assert.ok(R > 1000 && R < 2000, 'the disk is cut: ' + R);
    const st = storm.snapshot(Date.now());
    const onMap = (b) => Math.hypot(b.x, b.y) <= R - Math.min(b.realSize, R * 0.5) + 1;
    // a resume may keep a spot on the rim's open ground (and rock contact
    // nudges it a little), but never out in the empty ring
    const onRim = (b) => Math.hypot(b.x, b.y) <= Math.min(R, R - Math.min(b.realSize, R * 0.5) + 200);
    const bad = [];
    for (let i = 0; i < 24; i++) {
        const sock = mkSocket();
        const tank = spawnTank(sock);
        // spawns and respawns: a quarter of the score, capped at 2x
        if (!onMap(tank)) bad.push('spawn ' + i + ' at ' + (tank.x | 0) + ',' + (tank.y | 0));
        if (Math.hypot(tank.x - st.cx, tank.y - st.cy) > st.r) bad.push('spawn ' + i + ' in the storm');
        // admin growth, up to 14x, then a drop and a resume from a spot near
        // (or past) the edge, rock grown back over it
        grow(tank, [20000, 200000, 2000000][i % 3]);
        const a = rnd() * Math.PI * 2, d = R * (0.7 + rnd() * 0.5);
        tank.x = Math.cos(a) * d; tank.y = Math.sin(a) * d;
        tank.carriedGems = 200;
        royale.disconnectCleanup(sock, tank);
        tank.kill(); loop(1);
        const back = mkSocket({ resumeToken: sock.resumeToken });
        royale.claimResume(back, sock.resumeToken);
        const body = spawnTank(back);
        royale.applyPendingResume(back);
        if (!onRim(body)) bad.push('resume ' + i + ' r ' + (body.realSize | 0) + ' at ' + (body.x | 0) + ',' + (body.y | 0) + ' |' + (Math.hypot(body.x, body.y) | 0) + '|');
        // a few seconds of rock contact (and anything closing over it)
        settle(body, 45);
        if (!onRim(body)) bad.push('settled ' + i + ' at |' + (Math.hypot(body.x, body.y) | 0) + '|');
        body.kill(); loop(1);
    }
    // the per-tick rescue for a centre buried in rock never picks a spot past the edge
    for (let i = 0; i < 200; i++) {
        const a = rnd() * Math.PI * 2, d = R * (0.85 + rnd() * 0.15);
        const x = Math.cos(a) * d, y = Math.sin(a) * d;
        if (!grid.pointInRock(x, y)) continue;
        const o = grid.openSpotNear(x, y, 300);
        if (o && Math.hypot(o.x, o.y) > R - Math.min(340, R * 0.5) + 1) bad.push('rescue to |' + (Math.hypot(o.x, o.y) | 0) + '|');
    }
    assert.deepEqual(bad, []);
    // a NaN position goes to the middle, not nowhere
    const p = { x: NaN, y: 5 };
    assert.equal(grid.clampToPlay(p, 50), true);
    assert.deepEqual(p, { x: 0, y: 0 });
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            const note = await t.fn();
            console.log('ok   ' + t.name + (note ? ' (' + note + ')' : ''));
        } catch (e) {
            failed++;
            console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
        }
    }
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
