// Dash, quick abilities and the ability-era shop: node scripts/test/abilities.test.js
//
//   dash       2 charges, one back every 5 s, a burst along the keys (the
//              aim when standing still), stopped by rock, never through it
//   abilities  each one's core effect: grapple pulls (rock, tank, miss),
//              burrow eats rock, a thrown shockwave launches everyone in
//              the blast (you too) and chips enemies only,
//              radar lists contacts, barricade raises rock and crumbles,
//              smoke hides until you shoot, adrenaline, launch pad
//   shop       buy with banked gems, owned through death, free swap,
//              swap by key on a pad, first-bank trial, retired items gone,
//              Rocket Boots and Escape Flare
//   saves      abilities ride in a save; retired gear/kit come back as gems
//   off        ROYALE_ABILITIES=0 brings back the old shop and no dash
//   wiring     'ab' packet, keybinds, touch buttons
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

// the free raid ability is checked in its own child process (below); the
// rest of the file runs without it so ownership lists stay predictable
if (process.argv[2] === '--free') {
    global.Config = { dig_royale: true };
    const ab = require(path.join(SERVER, 'game', 'terrain', 'abilities.js'));
    const mk = () => { const s = { packets: [], guestId: 'e'.repeat(32), shop: null }; s.talk = (...a) => s.packets.push(a); return s; };
    const body = (s) => ({ socket: s, x: 0, y: 0, velocity: { x: 0, y: 0 }, isDead: () => false });
    const s = mk(), b = body(s);
    s.player = { body: b };
    ab.onSpawn(b);
    const st = ab.stateOf(s);
    const first = JSON.parse(s.packets.filter(p => p[0] === 'AB').pop()[1]);
    ab.onSpawn(b);
    const second = JSON.parse(s.packets.filter(p => p[0] === 'AB').pop()[1]);
    const trial = ab.onBanked(b, 100);
    const eqAfterBank = ab.equipped(b);
    // a reload in the same raid: no second free one
    const s2 = mk(), b2 = body(s2); s2.player = { body: b2 };
    ab.onSpawn(b2);
    const again = ab.stateOf(s2).own.slice();
    ab.resetRaid();
    const s3 = mk(), b3 = body(s3); s3.player = { body: b3 };
    ab.onSpawn(b3);
    process.stdout.write(JSON.stringify({ pool: ab.FREE_POOL, free: st.free, own: first.own, eq: first.eq, fn1: first.fn, fn2: second.fn, own2: second.own, trial, eqAfterBank, again, next: ab.stateOf(s3).own }));
    process.exit(0);
}
process.env.ROYALE_FREE_ABILITY = '0';

// the off switch is checked in a child process with the env set
if (process.argv[2] === '--off') {
    process.env.ROYALE_ABILITIES = '0';
    global.Config = { dig_royale: true };
    const shop = require(path.join(SERVER, 'game', 'terrain', 'shop.js'));
    const ab = require(path.join(SERVER, 'game', 'terrain', 'abilities.js'));
    const raidMods = require(path.join(SERVER, 'game', 'terrain', 'raidMods.js'));
    const ids = shop.catalog().map(i => i.id);
    const body = { x: 0, y: 0, velocity: { x: 0, y: 0 }, isDead: () => false };
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(raidMods.roll().id);
    process.stdout.write(JSON.stringify({ ids, dash: ab.dash(body, 1, 0), on: ab.ON, hook: seen.has('hook_storm'), magnet: seen.has('magnet_storm') }));
    process.exit(0);
}

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
const mapGen = require(path.join(SERVER, 'game', 'terrain', 'mapGen.js'));
const grid = mapGen.generate({ cols: 13, rows: 13, tileWidth: 420, fullLattice: true });
grid.buildVoronoiColliders();
// the build carves core-chamber pockets at random spots each boot: fill them
// back in so every run tests the same rock
for (const r of grid.rocks.values()) {
    if (!r.canyon || !r.worldPoly) continue;
    r.canyon = false; r.alive = true;
    r.maxHealth = r.maxHealth || grid.baseRockHealth || 500; r.health = r.maxHealth;
}
global.gameManager = {
    room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1.5, clients: [], terrainGrid: grid,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager);
global.gameManager.gameHandler = handler;

const ab = require(path.join(SERVER, 'game', 'terrain', 'abilities.js'));
const shop = require(path.join(SERVER, 'game', 'terrain', 'shop.js'));
const saveCodes = require(path.join(SERVER, 'game', 'terrain', 'saveCodes.js'));
const gems = require(path.join(SERVER, 'game', 'terrain', 'gems.js'));

// one clock for the game and the ability timers
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── open ground: clear a disc of rock (and keep it clear) ───────────────
function clearDisc(x, y, R) {
    for (const r of grid.rocks.values()) {
        if (!r.worldPoly || r.canyon) continue;
        if (Math.hypot(r.worldCx - x, r.worldCy - y) > R) continue;
        r.alive = false; r.growing = false; r.health = 0; r.diedAt = clock; r.noRegrowUntil = clock + 1e9;
    }
}
function solidAt(x, y) { return !!grid.pointInRock(x, y); }

let seq = 0;
function level45(t) {
    while (t.skill.level < 45) { t.skill.score += t.skill.levelScore; t.skill.maintain(); }
    t.refreshBodyAttributes();
}
function mkSocket() {
    const s = { id: 'ab' + (++seq), packets: [], status: {}, camera: { x: 0, y: 0 }, readyState: 1, OPEN: 1 };
    s.talk = (...a) => s.packets.push(a);
    global.gameManager.socketManager.clients.push(s);
    return s;
}
function tank(x, y, socket) {
    const t = new Entity({ x, y });
    t.define('basic');
    t.isPlayer = !!socket;
    t.team = -100 - (++seq);
    t.name = 'T' + seq;
    t.alwaysActive = true;
    t.sendMessage = () => {};
    level45(t);
    if (socket) {
        const player = { socket, body: t, target: { x: 120, y: 0 },
            command: { up: 0, down: 0, left: 0, right: 0, lmb: 0, mmb: 0, rmb: 0, sidearm: 0, autofire: false, autospin: false, override: false, autoalt: false, spinlock: false } };
        t.socket = socket;
        t.become(player);
        socket.player = player;
        global.gameManager.socketManager.players.push(player);
    }
    gems.initSatchel && gems.initSatchel(t);
    // tanks without a socket stand in for bots (abilities scan players + bots)
    if (!socket) { t.isBot = true; t.controllers = []; handler.bots.push(t); }
    return t;
}
function cleanup(...bodies) {
    for (const b of bodies) { try { b.kill(); } catch { /* */ } }
    global.gameManager.socketManager.players.length = 0;
    global.gameManager.socketManager.clients.length = 0;
    step(2);
    handler.bots.length = 0;
    ab.resetRaid();
}
// one game tick: the loop (physics, friction), the terrain pass's tank
// push, then the ability tick, 33 ms apart
function step(n = 1) {
    for (let i = 0; i < n; i++) {
        clock += 33;
        handler.gameloop();
        for (const e of entities.values()) {
            if (e && e.type === 'tank' && !e.isDead()) {
                const p = grid.settleTank(e, e.realSize, clock, false);
                if (process.env.DBG_AB && (p.dx || p.dy)) log('  push', e.id, p.dx.toFixed(1), p.dy.toFixed(1));
                if (p.dx || p.dy) {
                    const l = Math.hypot(p.dx, p.dy), nx = p.dx / l, ny = p.dy / l;
                    const vd = e.velocity.x * nx + e.velocity.y * ny;
                    if (vd < 0) { e.velocity.x -= vd * nx; e.velocity.y -= vd * ny; }
                }
            }
        }
        ab.tick(global.gameManager.socketManager.players.concat(handler.bots));
    }
}
const lastAB = (s) => { const p = [...s.packets].reverse().find(x => x[0] === 'AB'); return p ? JSON.parse(p[1]) : null; };

// a cleared arena at the edge of the map
const AX = -1500, AY = -1500;
clearDisc(AX, AY, 1000);

// ── dash ────────────────────────────────────────────────────────────────
test('dash: two charges, a third press does nothing, one back every 5 s', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    ab.onSpawn(t);
    assert.equal(lastAB(s).d, 2);
    assert.ok(ab.dash(t, 1, 0));
    step(6);
    assert.ok(ab.dash(t, 1, 0));
    assert.equal(ab.dashOf(t).n, 0);
    step(6);
    assert.equal(ab.dash(t, 1, 0), false, 'out of charges');
    assert.equal(lastAB(s).d, 0);
    clock += ab.DASH.rechargeMs - 400;
    step(5);
    assert.equal(ab.dashOf(t).n, 1, 'first charge back after ~5 s');
    assert.equal(lastAB(s).d, 1, 'the HUD hears about it');
    clock += ab.DASH.rechargeMs;
    step(2);
    assert.equal(ab.dashOf(t).n, 2, 'then the second');
    cleanup(t);
});

test('dash: a burst along the keys, 3-4x normal speed, then back to normal', () => {
    const s = mkSocket();
    const t = tank(AX - 400, AY, s);
    ab.onSpawn(t);
    // normal driving speed first
    s.player.command.right = 1;
    step(40);
    const vNormal = Math.hypot(t.velocity.x, t.velocity.y);
    s.player.command.right = 0; s.player.command.down = 1;
    const y0 = t.y;
    assert.ok(ab.dash(t, 0, 0), 'dash with the down key held');
    step(1);
    const vDash = Math.hypot(t.velocity.x, t.velocity.y);
    assert.ok(t.velocity.y > Math.abs(t.velocity.x), 'goes the way the keys point (down)');
    assert.ok(vDash > vNormal * 3 && vDash < vNormal * 5, 'burst ' + vDash.toFixed(1) + ' vs ' + vNormal.toFixed(1));
    step(5);
    const during = t.y - y0;
    s.player.command.down = 0;
    step(30);
    const total = t.y - y0;
    assert.ok(during > 85, 'covers ground in the burst: ' + during.toFixed(0));
    assert.ok(total > 120 && total < 320, 'dash length ' + total.toFixed(0));
    log('     dash: ' + during.toFixed(0) + ' in the burst, ' + total.toFixed(0) + ' with the glide (normal ' + vNormal.toFixed(1) + '/tick)');
    assert.ok(Math.hypot(t.velocity.x, t.velocity.y) < vNormal * 0.5, 'and settles');
    assert.equal(t._abMove, null);
    cleanup(t);
});

test('dash: standing still it goes where the gun points', () => {
    const s = mkSocket();
    const t = tank(AX, AY + 300, s);
    ab.onSpawn(t);
    s.player.target = { x: 0, y: -200 };
    const y0 = t.y;
    assert.ok(ab.dash(t, 0, 0));
    step(8);
    assert.ok(t.y < y0 - 100, 'up, toward the aim');
    cleanup(t);
});

test('dash: rock stops it, never through it', () => {
    // a solid cell with open ground on the near side
    const s = mkSocket();
    let wall = null;
    for (const r of grid.rocks.values()) {
        if (!r.alive || r.canyon || !r.worldPoly) continue;
        const d = Math.hypot(r.worldCx - 800, r.worldCy - 900);
        if (d < 120) { wall = r; break; }
    }
    clearDisc(800 - 520, 900, 330);
    const t = tank(800 - 520, 900, s);
    ab.onSpawn(t);
    let inside = 0;
    assert.ok(ab.dash(t, 1, 0));
    for (let i = 0; i < 30; i++) {
        step(1);
        if (solidAt(t.x, t.y)) inside++;
        if (i === 6) ab.dash(t, 1, 0);
    }
    assert.equal(inside, 0, 'never ends a tick with its centre in rock');
    assert.ok(t.x < 900, 'stopped at the wall: x ' + t.x.toFixed(0));
    cleanup(t);
});

test('dash: frozen, dead or switched-off tanks cannot; bots can through the API', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    t.royaleFrozen = true;
    assert.equal(ab.dash(t, 1, 0), false);
    t.royaleFrozen = false;
    const b = tank(AX + 300, AY, null);
    assert.ok(ab.canDash(b));
    assert.ok(ab.dash(b, 0, 1), 'bots: abilities.dash(body, dx, dy)');
    b.kill();
    assert.equal(ab.dash(b, 0, 1), false);
    cleanup(t);
});

// ── abilities ───────────────────────────────────────────────────────────
function owner(x, y, id) {
    const s = mkSocket();
    const t = tank(x, y, s);
    ab.onSpawn(t);
    ab.grant(s, id);
    return { s, t };
}

test('grapple: catches rock and yanks you to it', () => {
    clearDisc(0, 1600, 500);
    const { s, t } = owner(0, 1600, 'grapple');
    // aim at the rock edge east of the clearing
    let edge = null;
    for (let x = 0; x < 700; x += 10) if (solidAt(x, 1600)) { edge = x; break; }
    assert.ok(edge != null && edge < 650, 'rock in reach');
    assert.ok(ab.use(t, t.x + 1000, t.y));
    const af = s.packets.filter(p => p[0] === 'AF' && p[1] === 'hook').pop();
    assert.ok(af && af[5] > 300, 'the hook flies out to the rock');
    assert.equal(ab.GRAPPLE.range, 910, '650 + 40%');
    step(40);
    assert.ok(t.x > edge - 90, 'pulled to the wall: ' + t.x.toFixed(0) + ' vs edge ' + edge);
    assert.ok(!solidAt(t.x, t.y));
    assert.ok(lastAB(s).cd > 7000, 'full cooldown');
    cleanup(t);
});

test('grapple: a miss reels back and spends no cooldown (bots too); a tank hit pulls you to the tank once it bites', () => {
    clearDisc(AX, AY, 1000);
    const { s, t } = owner(AX, AY, 'grapple');
    assert.ok(ab.use(t, AX, AY - 900));      // straight up into the open arena
    assert.ok(s.packets.some(p => p[0] === 'AF' && p[1] === 'hookmiss'), 'the reel-back is drawn');
    assert.equal(lastAB(s).cd, 0, 'no cooldown on a miss');
    assert.equal(ab.use(t, AX, AY - 900), false, 'but not while it is still out');
    clock += 500;
    assert.ok(ab.canUse(t), 'ready again once it is back');
    const bot = tank(AX - 400, AY + 300, null);
    ab.giveBot(bot, 'grapple');
    assert.ok(ab.use(bot, bot.x, bot.y - 900));
    clock += 500;
    assert.equal(ab.cooldownLeft(bot), 0, 'a bot missing gets the same deal');
    const foe = tank(AX + 480, AY, null);
    step(1);
    const d0 = Math.hypot(foe.x - t.x, foe.y - t.y);
    const x0 = t.x;
    assert.ok(ab.use(t, foe.x, foe.y));
    assert.ok(lastAB(s).cd > 7000, 'a hit spends the full cooldown');
    step(2);
    assert.ok(Math.abs(t.x - x0) < 12, 'no yank while the hook is still flying');
    step(20);
    const d1 = Math.hypot(foe.x - t.x, foe.y - t.y);
    assert.ok(d1 < d0 * 0.4, 'closed in: ' + d0.toFixed(0) + ' -> ' + d1.toFixed(0));
    cleanup(t, foe, bot);
});

test('burrow: a channel up to 6 s through rock, slower, no shooting, up again on the key', () => {
    clearDisc(-1700, 900, 160);
    const { s, t } = owner(-1700, 900, 'burrow');
    let solidAhead = 0;
    for (let x = -1530; x < -1450; x += 10) if (solidAt(x, 900)) solidAhead++;
    assert.ok(solidAhead > 3, 'rock to the east');
    const sp0 = t.topSpeed;
    assert.ok(ab.use(t, t.x + 500, t.y));
    assert.ok(t.topSpeed < sp0 * 0.8, 'slower underground');
    assert.ok(t.alpha < 1 && t.alpha > 0.5, 'see-through, but bots still see it (alpha ' + t.alpha + ')');
    const gunSrc = fs.readFileSync(path.join(SERVER, 'game', 'entities', 'gun.js'), 'utf8');
    assert.match(gunSrc, /burrowUntil && Date\.now\(\) < this\.body\.master\.burrowUntil\) shootPermission = false/);
    s.player.command.right = 1;
    step(75);
    s.player.command.right = 0;
    assert.ok(t.x > -1470, 'got through: ' + t.x.toFixed(0));
    let left = 0;
    for (let x = -1530; x < -1450; x += 10) if (solidAt(x, 900)) left++;
    assert.ok(left < solidAhead / 2, 'tunnel behind');
    assert.ok(t.burrowUntil > clock, 'still down after 2.5 s');
    // the key again: up, a flat 45 s cooldown
    assert.ok(ab.use(t, 0, 0));
    assert.equal(t.burrowUntil, 0);
    assert.equal(t.alpha, 1);
    assert.ok(Math.abs(t.topSpeed - sp0) < 0.01);
    const cd = lastAB(s).cd;
    assert.ok(cd > 44000 && cd <= 45000, 'cooldown 45 s: ' + cd);
    assert.ok(!grid.rockHitByCircle(t.x, t.y, t.realSize * 0.8), 'comes up in the open');
    assert.ok(s.packets.some(p => p[0] === 'AF' && p[1] === 'surface'));
    cleanup(t);
});

test('burrow: runs out at 6 s and never leaves you inside rock', () => {
    const { s, t } = owner(0, 0, 'burrow');
    assert.equal(ab.BURROW.maxMs, 6000);
    assert.ok(ab.use(t, 0, 0));
    clock += ab.BURROW.maxMs + 100;
    step(1);
    assert.equal(t.burrowUntil, 0, 'surfaced on its own');
    assert.ok(lastAB(s).cd >= 44000, 'the 45 s cooldown');
    // up from the middle of a solid patch: the rock round the hull goes
    const r = [...grid.rocks.values()].find(q => q.alive && !q.canyon && q.ore !== 4 && Math.hypot(q.worldCx - 900, q.worldCy + 500) < 300);
    clock += 46000;
    t.x = r.worldCx; t.y = r.worldCy;
    assert.ok(ab.use(t, 0, 0));
    clock += 800;
    t.x = r.worldCx; t.y = r.worldCy;      // shoved back into it
    for (const q of grid.rocks.values()) if (Math.hypot(q.worldCx - t.x, q.worldCy - t.y) < 60) { q.alive = true; q.health = q.maxHealth; }
    assert.ok(ab.use(t, 0, 0));
    assert.ok(!solidAt(t.x, t.y), 'not stuck in rock');
    cleanup(t);
});

// throws at (x, y) and steps until it blows -> the 'shock' AF packet
function throwShock(s, t, x, y) {
    assert.ok(ab.use(t, x, y));
    assert.ok(s.packets.some(p => p[0] === 'AF' && p[1] === 'shockthrow'), 'the throw is drawn');
    for (let i = 0; i < 40 && ab.orbs.length; i++) step(1);
    assert.equal(ab.orbs.length, 0, 'it went off');
    return [...s.packets].reverse().find(p => p[0] === 'AF' && p[1] === 'shock');
}
const speed = (b) => Math.hypot(b.velocity.x, b.velocity.y);

test('shockwave: an aimed throw (550) that blows where it lands and launches everyone in it, you too', () => {
    clearDisc(AX, AY, 1000);
    const { s, t } = owner(AX, AY, 'shock');
    assert.equal(ab.placeRange('shock'), 550, 'aimed like a placed ability');
    const BX = AX + 420, BY = AY;              // where it lands
    const near = tank(BX + 90, BY + 60, null);
    const mid = tank(BX, BY + 330, null);
    const mate = tank(BX - 40, BY - 130, null); mate.team = t.team;
    const far = tank(BX + 900, BY, null);
    near.growthMult = 3;                        // a grown tank still flies
    step(1);
    const hp = (b) => b.health.amount + b.shield.amount;
    const hpN = hp(near), hpM = hp(mid), hpT = hp(t), hpMate = hp(mate);
    const x0 = t.x;
    const boom = throwShock(s, t, BX, BY);
    assert.ok(boom && Math.abs(boom[2] - BX) < 40 && Math.abs(boom[3] - BY) < 40, 'at the aim spot: ' + (boom && boom[2]));
    // launched: each one moving away from the blast, the closest fastest
    const vN = speed(near), vM = speed(mid), vMate = speed(mate);
    assert.ok(vN > 35, 'grown one, close: flies ' + vN.toFixed(1));
    assert.ok(vM > 12 && vM < vN, 'farther: less ' + vM.toFixed(1));
    assert.ok(mid.velocity.y > 0 && near.velocity.x > 0, 'away from the blast');
    assert.ok(vMate > 12 && mate.velocity.y < 0, 'teammates fly too ' + vMate.toFixed(1));
    assert.ok(t.velocity.x < -10, 'the thrower too, back the way it came: ' + t.velocity.x.toFixed(1));
    assert.ok(speed(far) < 2, 'out of range untouched');
    assert.equal(ab.canDash(near), false, 'no control mid-flight');
    for (const p of [s].flatMap(q => q.packets)) if (p[0] === 'AF' && (p[1] === 'fling' || p[1] === 'flinghit')) assert.ok(p[5] > 0);
    assert.ok(s.packets.some(p => p[0] === 'AF' && p[1] === 'flinghit' && p[6] === near.id), 'the hit tank is told');
    assert.ok(s.packets.some(p => p[0] === 'AF' && p[1] === 'fling' && p[6] === t.id), 'so is the thrower (no damage)');
    const nx0 = near.x;
    step(14);
    assert.ok(near.x - nx0 > 250, 'a real flight: ' + (near.x - nx0).toFixed(0));
    assert.ok(x0 - t.x > 60, 'thrower moved back ' + (x0 - t.x).toFixed(0));
    assert.ok(ab.canDash(near), 'control back after the flight');
    const lostN = hpN - hp(near), lostM = hpM - hp(mid);
    assert.ok(lostN > lostM && lostM > 0, 'damage falls off: ' + lostN.toFixed(1) + ' > ' + lostM.toFixed(1));
    assert.ok(hpT - hp(t) < 0.5 && hpMate - hp(mate) < 0.5, 'no damage to you or your team');
    cleanup(t, near, mid, mate, far);
});

test('shockwave: a tank in the way sets it off early; rock shatters in the blast; rock stops a flight without crushing', () => {
    clearDisc(AX, AY, 1000);
    const { s, t } = owner(AX, AY, 'shock');
    const block = tank(AX + 200, AY, null);
    step(1);
    const boom = throwShock(s, t, AX + 500, AY);
    assert.ok(boom[2] < AX + 260, 'blew on the tank: ' + (boom[2] - AX));
    assert.ok(block.velocity.x > 30, 'and that tank flew');
    cleanup(t, block);
    // into rock: blows at the face, the rock round it goes
    const spot = { x: 600, y: -1300 };
    clearDisc(spot.x - 420, spot.y, 140);
    const inner = [...grid.rocks.values()].filter(r => r.alive && !r.canyon && r.ore !== 4 && Math.hypot(r.worldCx - spot.x, r.worldCy - spot.y) < 200);
    assert.ok(inner.length > 3);
    const { s: s2, t: t2 } = owner(spot.x - 420, spot.y, 'shock');
    const boom2 = throwShock(s2, t2, spot.x, spot.y);
    assert.ok(boom2[2] < spot.x - 200, 'stopped at the face: ' + (boom2[2] - spot.x));
    const broke = [...grid.rocks.values()].filter(r => !r.alive && !r.canyon && Math.hypot(r.worldCx - boom2[2], r.worldCy - boom2[3]) < ab.SHOCK.breakR - 40);
    assert.ok(broke.length >= 2, 'shattered round the blast: ' + broke.length);
    cleanup(t2);
    // a tank flung at a wall stops at it, never inside it
    clearDisc(-1700, 900, 160);
    const { s: s3, t: t3 } = owner(-1700, 900, 'shock');
    const victim = tank(-1640, 900, null);
    step(1);
    throwShock(s3, t3, -1660, 900);
    for (let i = 0; i < 16; i++) {
        step(1);
        assert.ok(!grid.rockHitByCircle(victim.x, victim.y, victim.realSize * 0.6), 'not driven into rock (tick ' + i + ')');
    }
    assert.ok(!victim.isDead(), 'alive');
    cleanup(t3, victim);
    // thrown point blank into the wall you're against: you bounce off it
    clearDisc(-1700, 900, 160);
    const { s: s4, t: t4 } = owner(-1700, 900, 'shock');
    let face = -1700;
    while (!solidAt(face + 10, 900) && face < -1300) face += 10;
    t4.x = face - t4.realSize - 4;
    step(1);
    const x4 = t4.x;
    throwShock(s4, t4, t4.x + 400, 900);
    step(10);
    assert.ok(x4 - t4.x > 120, 'flew back off the wall: ' + (x4 - t4.x).toFixed(0));
    clearDisc(AX, AY, 1000);
    cleanup(t4);
});

test('barricade preview: exactly the cells the cast raises, red where a tank stands', () => {
    clearDisc(AX, AY, 1000);
    const { s, t } = owner(AX, AY, 'wall');
    const blocker = tank(AX + 450, AY + 60, null);
    ab.stateOf(s).eq = 'wall';
    ab.preview(s, AX + 450, AY);
    const aw = JSON.parse(s.packets.filter(p => p[0] === 'AW').pop()[1]);
    assert.ok(aw.g.length >= 3 && aw.r.length >= 1 && aw.g.length + aw.r.length <= 5, 'rising ' + aw.g.length + ', blocked ' + aw.r.length);
    const before = new Set([...grid.rocks.values()].filter(r => r.growing).map(r => r.k));
    assert.ok(ab.use(t, AX + 450, AY));
    const rose = [...grid.rocks.values()].filter(r => r.growing && !before.has(r.k)).map(r => r.k).sort();
    assert.deepEqual(rose, aw.g.slice().sort(), 'what you see is what you get');
    for (const k of aw.r) assert.ok(!rose.includes(k), 'nothing grows under the tank');
    const so = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.match(so, /abil\.preview\(socket, m\[1\], m\[2\]\)/);
    clearDisc(AX, AY, 1000);
    cleanup(t, blocker);
});

test('equip: crossing a shop pad with the ability key held never changes the slot', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    ab.onSpawn(t);
    s.gemBanked = 5000;
    t.shopOnPad = true; t.padSafe = true;
    assert.ok(shop.buy(s, 'grapple'));
    assert.ok(shop.buy(s, 'pad'));
    assert.ok(shop.buy(s, 'grapple'), 'Equip');
    assert.equal(ab.equipped(t), 'grapple');
    // Q held / mashed while on the pad and riding over it, plus a shop tick each step
    for (let i = 0; i < 20; i++) {
        t.shopOnPad = i % 3 !== 2; t.padSafe = t.shopOnPad;
        ab.cycle(s);
        ab.use(t, AX + 100, AY);
        shop.tick && shop.tick(global.gameManager.socketManager.players);
        step(1);
        assert.equal(ab.equipped(t), 'grapple', 'tick ' + i);
    }
    const cv = fs.readFileSync(path.join(REPO, 'public', 'client', 'canvas.js'), 'utf8');
    assert.doesNotMatch(cv, /talk\('ab', 2\)/, 'the client never asks for a swap');
    assert.match(cv, /this\.shopPressed === shopClick/, 'a panel click only counts when the press began there');
    const so = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.doesNotMatch(so, /abil\.cycle\(socket\)/, 'and the server has no swap packet');
    t.shopOnPad = false; t.padSafe = false;
    cleanup(t);
});

test('aim mode: Q aims a placed ability, a left click puts it down without firing, right click / Esc / Q again cancel for free', () => {
    const cv = fs.readFileSync(path.join(REPO, 'public', 'client', 'canvas.js'), 'utf8');
    assert.match(cv, /global\.abilAim\.mode = "click";/, 'Q enters aim mode');
    assert.match(cv, /if \(global\.abilAim && global\.abilAim\.mode === "click"\) \{ abilityFx\.cancelAim\(\); gameSound\.uiClick\(\); return; \}/, 'Q again cancels');
    const down = cv.slice(cv.indexOf('    mouseDown(mouse) {'), cv.indexOf('    toggleBigMap() {'));
    const place = down.indexOf('this.placeAim();'), fire = down.indexOf('this.socket.cmd.set(primaryFire, true)');
    assert.ok(place > 0 && fire > place && /this\.placeAim\(\);\s+this\.aimClickHeld = true;\s+break;/.test(down), 'the placing click breaks out before the gun fires');
    assert.match(down, /aim mode: right click backs out of it/);
    // the Deposit bug: an aim left on while walking onto a vault stole the click
    assert.match(down, /if \(global\.abilAim && global\.abilAim\.mode === "click" && \(onAnyPad\(\) \|\| overHudButton\(mpos\)\)\) abilityFx\.cancelAim\(\);/, 'a HUD button or a pad click is never swallowed by aim mode');
    assert.ok(down.indexOf('overHudButton(mpos)') < down.indexOf('this.placeAim();'), 'checked before placing');
    assert.match(cv, /function overHudButton\(mpos\) \{[\s\S]{0,120}c\.vault\.check\(mpos\) !== -1/, 'the vault panel counts as a HUD button');
    assert.match(down, /this\.aimClickHeld = false;[^\n]*\n[^\n]*global\.kitDrag = null; global\.chipDrag = null;[^\n]*\n\s+switch \(mouse\.button\)/, 'a stale swallow or drag never eats the next click (Deposit)');
    const fxSrc2 = fs.readFileSync(path.join(REPO, 'public', 'client', 'abilityFx.js'), 'utf8');
    assert.match(fxSrc2, /global\.vault && global\.vault\.onPad\)\) \{ cancelAim\(\); return; \}/, 'stepping onto a pad ends aim mode');
    assert.match(cv, /kc === global\.KEY_ESC && global\.abilAim\) \{ abilityFx\.cancelAim\(\)/, 'Esc cancels');
    assert.match(cv, /royaleKeyUp\(event\) \{\s+if \(event && event\.keyCode === global\.KEY_ABILITY && global\.abilAim\) return true;/, 'the key coming up never casts');
    // cancelling spends nothing: aim mode is client only, the server only hears the placement
    const { s, t } = owner(AX, AY, 'pad');
    assert.equal(ab.cooldownLeft(t), 0);
    assert.ok(ab.canUse(t), 'nothing was spent by aiming and backing out');
    for (const id of ['pad', 'wall', 'shock', 'smoke']) assert.ok(ab.placeRange(id) > 0, id + ' is aimed');
    cleanup(t);
});

test('free starter: only the showy ones (grapple, launch pad, shockwave, smoke)', () => {
    assert.deepEqual(ab.FREE_POOL.slice().sort(), ['grapple', 'pad', 'shock', 'smoke']);
    for (const id of ['radar', 'burrow', 'rush', 'wall']) assert.ok(!ab.FREE_POOL.includes(id), id + ' is shop-only');
});

test('radar: lists every tank within 2,500, carriers flagged, for 10 s', () => {
    const { s, t } = owner(AX, AY, 'radar');
    const a = tank(AX + 1200, AY, null); a.carriedGems = 900;
    const b = tank(AX + 2000, AY + 1200, null);     // 2,330 away
    const c = tank(AX + 3000, AY, null);            // out of range
    assert.ok(ab.use(t, 0, 0));
    const ar = JSON.parse(s.packets.filter(p => p[0] === 'AR').pop()[1]);
    assert.equal(ar.length, 2);
    const ra = ar.find(r => r[3] === a.id);
    assert.ok(ra && (ra[2] & 1), 'carrier flag');
    assert.ok(ar.find(r => r[3] === b.id));
    clock += 6000;
    step(20);
    assert.notEqual(s.packets.filter(p => p[0] === 'AR').pop()[1], '[]', 'still on at 6 s');
    clock += 4500;
    step(2);
    assert.equal(s.packets.filter(p => p[0] === 'AR').pop()[1], '[]', 'cleared when it ends');
    cleanup(t, a, b, c);
});

test('barricade: 5 rocks in a row where you aim (up to 600), across the aim line, gone after 20 s', () => {
    const { s, t } = owner(AX, AY, 'wall');
    const before = new Set([...grid.rocks.values()].filter(r => r.growing));
    assert.ok(ab.use(t, AX + 450, AY));
    const rising = [...grid.rocks.values()].filter(r => r.growing && !before.has(r));
    assert.equal(rising.length, 5, 'five rocks: ' + rising.length);
    // in a straight row: each one about a cell from the next, all across the line
    const sorted = rising.slice().sort((a, b) => a.worldCy - b.worldCy);
    const size = (grid._voroRockSz || 1) * grid.cellSize;
    for (let i = 1; i < sorted.length; i++) {
        const gap = Math.hypot(sorted[i].worldCx - sorted[i - 1].worldCx, sorted[i].worldCy - sorted[i - 1].worldCy);
        assert.ok(gap > size * 0.4 && gap < size * 1.8, 'neighbours in the row: ' + gap.toFixed(0) + ' (cell ' + size.toFixed(0) + ')');
    }
    const riseMs = Math.max(...rising.map(r => (16000 - (r.growE0 || 0)) / r.growRate + (r.growAt - clock)));
    assert.ok(riseMs <= 450, 'up almost at once: ' + riseMs.toFixed(0) + ' ms');
    const client = fs.readFileSync(path.join(REPO, 'public', 'client', 'terrainRenderer.js'), 'utf8');
    assert.match(client, /Math\.min\(64, s\)/, 'the client draws that pace');
    for (const r of rising) assert.ok(Math.abs(r.worldCx - (AX + 450)) < size * 0.9, 'on the aim spot, across the line: ' + (r.worldCx - AX).toFixed(0));
    const ys = rising.map(r => r.worldCy);
    assert.ok(Math.max(...ys) - Math.min(...ys) > size * 2.5, 'a wall, not a lump');
    // aimed past the range: held to 600
    clearDisc(AX, AY, 1000);
    clock += 19000;
    for (const w of ab.walls) grid.completeRegrow(w.rock);
    const ws = ab.walls.slice();
    clock += 1200;
    step(1);
    assert.ok(ws.every(w => !w.rock.alive), 'crumbled after 20 s');
    clearDisc(AX, AY, 1000);
    clock += 19000;
    const before2 = new Set([...grid.rocks.values()].filter(r => r.growing));
    assert.ok(ab.use(t, AX + 2000, AY));
    const rising2 = [...grid.rocks.values()].filter(r => r.growing && !before2.has(r));
    for (const r of rising2) assert.ok(r.worldCx - AX < 700, 'held to the range');
    for (const w of ab.walls) { w.until = 0; }
    step(1);
    clearDisc(AX, AY, 1000);
    cleanup(t);
});

test('barricade: carved floor (open layout canyon cells) is placeable and green, a tank only blocks the cell it stands on, the floor never regrows after', () => {
    clearDisc(AX, AY, 1000);
    const { s, t } = owner(AX, AY, 'wall');
    const ring = [...grid.rocks.values()].filter(r => r.worldPoly && Math.hypot(r.worldCx - (AX + 450), r.worldCy - AY) < 330);
    for (const r of ring) r.canyon = true;
    ab.stateOf(s).eq = 'wall';
    ab.preview(s, AX + 450, AY);
    let aw = JSON.parse(s.packets.filter(p => p[0] === 'AW').pop()[1]);
    assert.equal(aw.r.length, 0, 'nothing red on open floor');
    assert.ok(aw.g.length >= 4, 'green: ' + aw.g.length);
    const blocker = tank(AX + 450, AY, null);
    s._abPreviewAt = 0;
    ab.preview(s, AX + 450, AY);
    aw = JSON.parse(s.packets.filter(p => p[0] === 'AW').pop()[1]);
    assert.ok(aw.r.length >= 1 && aw.r.length <= 2, 'only the cells under the tank: ' + aw.r.length);
    assert.ok(aw.g.length >= 3, 'the rest stays green: ' + aw.g.length);
    blocker.kill(); step(1);
    s._abPreviewAt = 0;
    ab.preview(s, AX + 450, AY);
    aw = JSON.parse(s.packets.filter(p => p[0] === 'AW').pop()[1]);
    assert.ok(ab.use(t, AX + 450, AY), 'it builds');
    const raised = aw.g.map(k => grid.rocks.get(k));
    assert.ok(raised.length >= 4 && raised.every(r => r.growing && !r.canyon), 'a wall of rock on the floor');
    for (const w of ab.walls) grid.completeRegrow(w.rock);
    clock += 21000;
    step(1);
    assert.ok(raised.every(r => !r.alive && !r.growing && r.canyon), 'gone after 20 s, carved floor again');
    for (const r of raised) assert.equal(grid.startRegrow(r, clock), false, 'and it never regrows on its own');
    for (const r of ring) r.canyon = false;
    clearDisc(AX, AY, 1000);
    cleanup(t);
});

test('smoke: thrown to the aim (550), a big cloud for 8 s where it lands, a second of grace on the trigger', () => {
    clearDisc(AX, AY, 1000);
    const { s, t } = owner(AX, AY, 'smoke');
    assert.equal(ab.placeRange('smoke'), 550, 'aimed like a placed ability');
    const CX = AX + 450;
    const friend = tank(CX + 200, AY, null);       // inside the 300 cloud
    const outside = tank(CX + 600, AY, null);
    assert.ok(ab.use(t, CX, AY));
    assert.ok(s.packets.some(p => p[0] === 'AF' && p[1] === 'smokethrow'), 'the throw is drawn');
    step(1);
    assert.equal(friend.alpha, 1, 'still in the air');
    step(14);
    const pop = s.packets.find(p => p[0] === 'AF' && p[1] === 'smoke');
    assert.ok(pop && Math.abs(pop[2] - CX) < 2, 'pops at the aim spot');
    assert.equal(friend.alpha, 0, 'in the cloud: hidden');
    assert.equal(outside.alpha, 1, 'outside it: not');
    assert.equal(t.alpha, 1, 'the thrower, far from it, is seen');
    // walk into it: hidden; a shot in the first second does not give you away
    t.x = CX - 100;
    step(2);
    assert.equal(t.alpha, 0);
    s.player.command.lmb = 1;
    step(2);
    assert.equal(t.alpha, 0, 'grace');
    clock += 1400;
    step(2);
    assert.equal(t.alpha, 1, 'after it, shooting gives you away');
    s.player.command.lmb = 0;
    step(1);
    assert.equal(t.alpha, 0, 'stop shooting: hidden again');
    t.x = AX - 700;
    step(2);
    assert.equal(t.alpha, 1);
    assert.equal(t.smokeHidden, false);
    clock += 10500; step(1);
    assert.equal(friend.alpha, 1, 'and it runs out');
    const so = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.match(so, /other\.smokeHidden \? 150 : 300/, 'only a faint peek up close');
    cleanup(t, friend, outside);
});

test('smoke hides everyone in it from the outside: not sent, no radar, HUD marks hold where they went in', () => {
    clearDisc(AX, AY, 1000);
    const { s, t } = owner(AX - 600, AY, 'smoke');
    const inA = tank(AX, AY, null), inB = tank(AX + 120, AY + 60, null);
    const mate = tank(AX - 900, AY, null); mate.team = inA.team;
    const near = tank(AX + 90, AY - 50, null);     // an enemy right on top of inA
    const far = tank(AX + 900, AY, null);
    const sR = mkSocket(), radarOwner = tank(AX - 1500, AY, sR);
    ab.use(t, AX, AY);
    step(20);
    assert.ok(inA.smokeHidden && inB.smokeHidden && near.smokeHidden, 'everyone in the cloud, bots too');
    const x0 = inA.x, y0 = inA.y;
    assert.equal(ab.smokeView(far, inA), -1, 'outside: not sent');
    assert.equal(ab.smokeView(t, inA), -1, 'the thrower outside the cloud: not sent either');
    assert.ok(ab.smokeView(mate, inA) >= 0.4, 'a teammate sees a ghost');
    assert.ok(ab.smokeView(inA, inA) > 0, 'you see yourself');
    assert.equal(ab.smokeView(inB, inA), -1, 'an enemy in the same cloud: not sent');
    assert.equal(ab.smokeView(near, inA), -1, 'an enemy right on top of it: not sent');
    assert.ok(ab.smokeView(far, far) === 1, 'not hidden: as normal');
    // walk out a little: still hidden, and the HUD keeps the spot it went in
    inA.x += 60;
    step(1);
    const at = ab.shownAt(inA);
    assert.ok(Math.abs(at.x - x0) < 1 && Math.abs(at.y - y0) < 1, 'HUD marks hold where it vanished');
    // radar: a hostile in smoke is not listed
    ab.grant(sR, 'radar');
    radarOwner.x = AX - 300;
    ab.use(radarOwner, 0, 0);
    const ar = JSON.parse(sR.packets.filter(p => p[0] === 'AR').pop()[1]);
    assert.ok(!ar.some(r => r[3] === inA.id || r[3] === inB.id), 'radar loses them');
    assert.ok(ar.some(r => r[3] === far.id), 'but still sees the rest');
    const so = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.match(so, /\.smokeView\(player\.body, smoked\)/, 'the view filter uses it');
    assert.match(so, /if \(sa < 0\) continue;/);
    for (const f of [['terrain', 'hunted.js'], ['terrain', 'pacing.js'], ['terrain', 'contracts.js'], ['gamemodes', 'scripts', 'dig_royale.js']]) {
        assert.match(fs.readFileSync(path.join(SERVER, 'game', ...f), 'utf8'), /shownAt\(/, f.join('/') + ' holds the mark');
    }
    cleanup(t, inA, inB, mate, near, far, radarOwner);
});

test('hints: tooltips draw after the upgrade tiles; on touch a long press shows them instead of using the button', () => {
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    const up = app.indexOf('if (global.GUIStatus.renderUpgrades && !finaleHud) drawAvailableUpgrades(spacing, alcoveSize);');
    const tips = app.indexOf('if (global.GUIStatus.renderPlayerBars && !finaleHud) drawTooltips();');
    assert.ok(up > 0 && tips > up, 'tooltips after the upgrade tiles');
    const tc = fs.readFileSync(path.join(REPO, 'public', 'client', 'touch.js'), 'utf8');
    assert.match(tc, /const LONG_MS = 400;/);
    assert.match(tc, /if \(h && h\.tip\) \{/, 'a long press does not use the button');
    assert.match(tc, /if \(name === "dash"\) return;/, 'dash goes off on release');
    const fxSrc = fs.readFileSync(path.join(REPO, 'public', 'client', 'abilityFx.js'), 'utf8');
    assert.match(fxSrc, /unlockSeen\("tip:" \+ S\.eq\)/, 'first ability in the slot on a phone: its tooltip once');
});

test('adrenaline: 8 s faster, faster reload, then back', () => {
    const { s, t } = owner(AX, AY, 'rush');
    const sp0 = t.topSpeed;
    assert.ok(ab.use(t, 0, 0));
    assert.ok(Math.abs(t.topSpeed / sp0 - ab.RUSH.speed) < 0.01, 'speed x' + (t.topSpeed / sp0).toFixed(2));
    assert.equal(ab.fireMult(t), ab.RUSH.fire);
    assert.equal(ab.RUSH.ms, 8000);
    const gunSrc = fs.readFileSync(path.join(SERVER, 'game', 'entities', 'gun.js'), 'utf8');
    assert.match(gunSrc, /rushUntil && Date\.now\(\) < this\.body\.rushUntil\) \? 1\.2/);
    clock += ab.RUSH.ms + 50;
    step(1);
    assert.ok(Math.abs(t.topSpeed - sp0) < 0.01, 'back to normal');
    cleanup(t);
});

test('launch pad: goes where you aim (held to 600), flings whoever touches it onward, 30 s', () => {
    clearDisc(AX, AY, 1000);
    const { s, t } = owner(AX, AY, 'pad');
    assert.ok(ab.use(t, AX, AY - 400));       // aimed north
    const pad = ab.pads[ab.pads.length - 1];
    assert.ok(Math.abs(pad.y - (AY - 400)) < 1 && Math.abs(pad.x - AX) < 1, 'on the aim spot');
    assert.ok(pad.until - clock >= 29000, 'lasts 30 s');
    const other = tank(AX, AY - 400, null);
    step(20);
    assert.ok(other.y < AY - 520, 'flung north: ' + (other.y - AY).toFixed(0));
    cleanup(t, other);
    // into rock: refused, no cooldown
    const { s: s2, t: t2 } = owner(AX, AY, 'pad');
    const rock = [...grid.rocks.values()].find(r => r.alive && !r.canyon && Math.hypot(r.worldCx - AX, r.worldCy - AY) < 1300 && Math.hypot(r.worldCx - AX, r.worldCy - AY) > 950);
    t2.x = rock.worldCx - 400; t2.y = rock.worldCy;
    assert.equal(ab.use(t2, rock.worldCx, rock.worldCy), false, 'no pad inside rock');
    assert.equal(lastAB(s2).cd, 0);
    assert.ok(!ab.padSpotOk(rock.worldCx, rock.worldCy) && ab.padSpotOk(AX, AY));
    cleanup(t2);
});

test('dash: a hit from the front does not stop it (knockback damped), rock still does', () => {
    clearDisc(AX, AY, 1000);
    const run = (withFoe) => {
        const s = mkSocket();
        const t = tank(AX - 300, AY + 200, s);
        ab.onSpawn(t);
        // a tank in the way, shooting straight back at the dash
        const foe = withFoe ? tank(AX - 300 + 75, AY + 200, null) : null;
        if (foe) { foe.facing = Math.PI; foe.control.target = { x: -100, y: 0 }; }
        step(1);
        const x0 = t.x;
        assert.ok(ab.dash(t, 1, 0));
        assert.ok(t.pushability <= 0.1, 'pushability damped: ' + t.pushability);
        for (let i = 0; i < 7; i++) { if (foe) { foe.control.fire = true; foe.control.target = { x: t.x - foe.x, y: t.y - foe.y }; } step(1); }
        const moved = t.x - x0;
        step(6);
        assert.equal(t._abMove, null);
        assert.ok(t.pushability > 0.5, 'pushability back after');
        cleanup(t, ...(foe ? [foe] : []));
        return moved;
    };
    const free = run(false), hit = run(true);
    log('     dash with a tank shooting from the front: ' + hit.toFixed(0) + ' of ' + free.toFixed(0));
    assert.ok(hit > free * 0.7, 'carried through: ' + hit.toFixed(0) + ' vs ' + free.toFixed(0));
});

test('abilities: cooldown holds, nothing on a pad, the equipped one only', () => {
    const { s, t } = owner(AX, AY, 'shock');
    assert.ok(ab.use(t, 0, 0));
    clock += 400;
    assert.equal(ab.use(t, 0, 0), false, 'on cooldown');
    assert.equal(ab.use(t, 0, 0, 'grapple'), false, 'not owned');
    clock += 14000;
    t.padSafe = true;
    assert.equal(ab.use(t, 0, 0), false, 'pads are safe rooms');
    t.padSafe = false;
    assert.ok(ab.use(t, 0, 0));
    cleanup(t);
});

test('persist: owned abilities and cooldowns ride through storm cycles, deaths and a new connection; the next raid wipes them', () => {
    const s = mkSocket(); s.guestId = 'f'.repeat(32);
    const t = tank(AX, AY, s);
    ab.grant(s, 'shock'); ab.grant(s, 'pad');
    assert.ok(ab.use(t, AX, AY - 300));
    const cd = ab.cooldownLeft(t, 'pad');
    // a reload: a brand new socket, same guest
    t.kill(); step(1);
    const s2 = mkSocket(); s2.guestId = 'f'.repeat(32);
    const t2 = tank(AX, AY, s2);
    ab.onSpawn(t2);
    assert.deepEqual(lastAB(s2).own, ['shock', 'pad']);
    assert.equal(lastAB(s2).eq, 'pad');
    assert.ok(Math.abs(ab.cooldownLeft(t2, 'pad') - cd) < 2000, 'cooldown rode along');
    // the guest id can arrive after the first look
    const s3 = mkSocket();
    ab.stateOf(s3);
    s3.guestId = 'f'.repeat(32);
    assert.deepEqual(ab.stateOf(s3).own, ['shock', 'pad']);
    // next raid: gone
    shop.resetAll();
    assert.deepEqual(ab.stateOf(s2).own, []);
    const s4 = mkSocket(); s4.guestId = 'f'.repeat(32);
    assert.deepEqual(ab.stateOf(s4).own, [], 'the ledger is empty too');
    cleanup(t2);
});

test('bots: giveBot, canUse, use with a placement target, same cooldowns', () => {
    clearDisc(AX, AY, 1000);
    const b = tank(AX, AY, null);
    assert.equal(ab.canUse(b), false, 'owns nothing');
    assert.ok(ab.giveBot(b, 'pad'));
    assert.ok(ab.canUse(b));
    assert.equal(ab.placeRange('pad'), 600);
    assert.equal(ab.placeRange('shock'), 550);
    assert.ok(ab.use(b, AX + 300, AY));
    assert.ok(ab.pads.some(p => p.owner === b && Math.abs(p.x - (AX + 300)) < 1), 'placed where it aimed');
    assert.equal(ab.canUse(b), false, 'cooling down');
    assert.ok(Math.abs(ab.cooldownLeft(b) - ab.AB_BY_ID.get('pad').cd) < 50, 'the same cooldown players get');
    assert.ok(ab.giveBot(b, 'burrow'));
    clock += 400;
    assert.ok(ab.use(b, 0, 0));
    assert.ok(ab.burrowing(b));
    clock += 1000;
    assert.ok(ab.canUse(b), 'can come up');
    assert.ok(ab.use(b, 0, 0));
    assert.ok(!ab.burrowing(b));
    cleanup(b);
});

// ── shop ────────────────────────────────────────────────────────────────
test('shop: the shelves (4 gear, mobility kit, 7 abilities; the OP items retired)', () => {
    const cat = shop.catalog();
    const ids = cat.map(i => i.id);
    for (const gone of ['cloak', 'boots', 'plating', 'express', 'mark', 'wind', 'strut', 'overdrive']) assert.ok(!ids.includes(gone), gone + ' retired');
    assert.equal(cat.filter(i => i.cat === 'gear').length, 4);
    for (const keep of ['scanner', 'magnet', 'insurance', 'satchel', 'medkit', 'flash', 'decoy', 'bulwark', 'rocket', 'flare']) assert.ok(ids.includes(keep), keep);
    for (const gone of ['statpt', 'charge', 'barrage', 'flak', 'lance', 'pod']) assert.ok(!ids.includes(gone), gone + ' retired');
    const abil = cat.filter(i => i.cat === 'ability');
    assert.equal(abil.length, 7);
    assert.ok(!ids.includes('radar'), 'radar retired');
    for (const a of abil) {
        assert.ok(a.cd >= 8000 && a.cd <= (a.id === 'burrow' ? 45000 : a.id === 'rush' ? 40000 : 25000), a.id + ' cd');
        assert.ok(a.desc && !/—/.test(a.desc), a.id + ' desc');
    }
    assert.ok(Math.min(...abil.map(a => a.price)) <= 900, 'a first ability after a bank or two');
    for (const i of cat) assert.ok(!/—/.test(i.desc + i.name), 'no em dashes: ' + i.id);
});

test('shop: buy an ability with banked gems, keep it through death, swap for free', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    ab.onSpawn(t);
    s.gemBanked = 2000;
    t.shopOnPad = true;
    assert.ok(shop.buy(s, 'grapple'));
    assert.equal(s.gemBanked, 950);
    assert.equal(ab.equipped(t), 'grapple');
    assert.ok(shop.buy(s, 'pad'));
    assert.equal(s.gemBanked, 50);
    assert.equal(ab.equipped(t), 'pad', 'the new one goes in the slot');
    assert.ok(shop.buy(s, 'grapple'), 'owned: equip');
    assert.equal(s.gemBanked, 50, 'for free');
    assert.equal(ab.equipped(t), 'grapple');
    assert.equal(shop.buy(s, 'grapple'), false, 'already equipped');
    // the ability key never swaps, pad or no pad
    t.padSafe = true;
    assert.equal(ab.cycle(s), false);
    assert.equal(ab.equipped(t), 'grapple');
    t.padSafe = false; t.shopOnPad = false;
    assert.equal(ab.cycle(s), false, 'not off a pad');
    // death: still yours
    shop.onDeath(t);
    t.kill();
    const t2 = tank(AX, AY, s);
    ab.onSpawn(t2);
    assert.deepEqual(lastAB(s).own, ['grapple', 'pad']);
    assert.equal(lastAB(s).eq, 'grapple');
    assert.equal(lastAB(s).d, 2, 'fresh dash charges every life');
    cleanup(t2);
});

test('shop: retired items cannot be bought; Rocket Boots and Escape Flare work', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    s.gemBanked = 5000;
    t.shopOnPad = true;
    assert.equal(shop.buy(s, 'cloak'), false);
    assert.equal(s.gemBanked, 5000);
    assert.ok(shop.buy(s, 'rocket'));
    assert.ok(shop.buy(s, 'flare'));
    t.shopOnPad = false;
    const sp0 = t.topSpeed;
    const st = shop.stateOf(s);
    assert.ok(shop.useKit(s, st.kitOrder.indexOf('rocket'), 0, 0));
    assert.ok(t.topSpeed > sp0 * 1.5, 'rocket boots: ' + (t.topSpeed / sp0).toFixed(2) + 'x');
    assert.ok(ab.ROCKET.ms >= 4000 && ab.ROCKET.ms <= 6000, 'they last ' + ab.ROCKET.ms);
    assert.ok(s.packets.some(p => p[0] === 'AF' && p[1] === 'rocket' && p[5] === ab.ROCKET.ms), 'flames for the whole burn');
    clock += ab.ROCKET.ms - 1000;
    step(1);
    assert.ok(t.topSpeed > sp0 * 1.5, 'still lit near the end');
    clock += 1100;
    step(1);
    assert.ok(Math.abs(t.topSpeed - sp0) < 0.01, 'and they burn out');
    // the flare: toward the nearest vault, through rock, onto open ground
    const vault = require(path.join(SERVER, 'game', 'terrain', 'vault.js'));
    const real = vault.getVaults;
    vault.getVaults = () => [{ x: AX + 3000, y: AY, r: 100 }];
    clock += 1000;
    const x0 = t.x;
    assert.ok(shop.useKit(s, shop.stateOf(s).kitOrder.indexOf('flare'), 0, 0));
    vault.getVaults = real;
    assert.ok(t.x > x0 + 80 && t.x <= x0 + ab.FLARE.range + 1, 'blinked east ' + (t.x - x0).toFixed(0));
    assert.ok(!grid.rockHitByCircle(t.x, t.y, t.realSize), 'lands clear');
    cleanup(t);
});

test('flare: boxed in by rock with no open ground that way, it still blinks and blasts a pocket', () => {
    // a spot whose whole flare line east is solid rock
    let sx = null, sy = null;
    for (let y = -2600; y <= 2600 && sx == null; y += 130) {
        for (let x = -3200; x <= 2200 && sx == null; x += 130) {
            let solid = true;
            for (let d = 90; d <= ab.FLARE.range; d += 20) if (!grid.rockHitByCircle(x + d, y, 34)) { solid = false; break; }
            if (solid) { sx = x; sy = y; }
        }
    }
    assert.ok(sx != null, 'found a boxed-in spot');
    clearDisc(sx, sy, 60);
    const s = mkSocket();
    const t = tank(sx, sy, s);
    s.gemBanked = 5000;
    t.shopOnPad = true;
    assert.ok(shop.buy(s, 'flare'));
    t.shopOnPad = false;
    const vault = require(path.join(SERVER, 'game', 'terrain', 'vault.js'));
    const real = vault.getVaults;
    vault.getVaults = () => [{ x: sx + 3000, y: sy, r: 100 }];
    clock += 1000;
    const x0 = t.x;
    const used = shop.useKit(s, shop.stateOf(s).kitOrder.indexOf('flare'), 0, 0);
    vault.getVaults = real;
    assert.ok(used, 'the flare goes off');
    assert.ok(t.x > x0 + 80, 'blinked east ' + (t.x - x0).toFixed(0));
    assert.ok(!grid.rockHitByCircle(t.x, t.y, t.realSize * 0.9), 'and the landing spot got blasted open');
    cleanup(t);
});

test('trial: a first bank with no ability hands one out for 2 minutes, once a raid', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    ab.onSpawn(t);
    const id = ab.onBanked(t, 120);
    assert.ok(id && ab.AB_BY_ID.get(id).trial);
    assert.equal(ab.equipped(t), id);
    assert.ok(lastAB(s).tr && lastAB(s).tr.left > 100000);
    assert.equal(ab.onBanked(t, 500), null, 'once');
    clock += ab.TRIAL_MS + 100;
    assert.equal(ab.equipped(t), null, 'runs out');
    // somebody who already bought one gets no trial
    const s2 = mkSocket();
    const t2 = tank(AX + 200, AY, s2);
    ab.grant(s2, 'radar');
    assert.equal(ab.onBanked(t2, 300), null);
    // nor somebody holding a found one
    const s3 = mkSocket();
    const t3 = tank(AX + 400, AY, s3);
    ab.addFound(s3, 'burrow');
    assert.equal(ab.onBanked(t3, 300), null);
    assert.equal(ab.equipped(t3), 'burrow', 'never swapped by a trial');
    cleanup(t, t2, t3);
});

test('twist: Hook Storm hands out a grapple and takes it back', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    ab.grantTwist(t, 'grapple');
    assert.equal(ab.equipped(t), 'grapple');
    ab.revokeTwist(s);
    assert.equal(ab.equipped(t), null);
    const raidMods = require(path.join(SERVER, 'game', 'terrain', 'raidMods.js'));
    const ids = new Set();
    for (let i = 0; i < 300; i++) ids.add(raidMods.roll().id);
    assert.ok(!ids.has('magnet_storm'), 'the magnet twist is retired with the magnet');
    assert.ok(ids.has('hook_storm'));
    cleanup(t);
});

// ── saves ───────────────────────────────────────────────────────────────
test('saves: abilities come back; retired gear and kit turn into banked gems', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    ab.grant(s, 'shock'); ab.grant(s, 'grapple');
    const rec = saveCodes.shopRecord(s, clock);
    assert.deepEqual(rec.ab.own, ['shock', 'grapple']);
    assert.equal(rec.ab.eq, 'grapple');
    // a save from before the revamp: magnet gear with half its time, 2 struts
    const s2 = mkSocket();
    const t2 = tank(AX + 300, AY, s2);
    s2.gemBanked = 100;
    const old = { drill: 2, gear: { magnet: 150000, scanner: 60000 }, kit: { strut: 2, medkit: 1 }, kitOrder: ['strut', 'medkit'], arm: null, armLeft: 0 };
    assert.doesNotThrow(() => saveCodes.applyShop(s2, t2, old, clock));
    const st2 = shop.stateOf(s2);
    assert.ok(st2.gear.magnet > clock, 'the magnet is sold again, so it comes back');
    assert.ok(st2.gear.scanner, 'scanner is still sold, so it comes back');
    assert.ok(!st2.kit.strut && st2.kit.medkit === 1);
    assert.equal(s2.gemBanked, 100 + 500, 'two struts');
    // and a new save restores abilities
    const s3 = mkSocket();
    const t3 = tank(AX + 600, AY, s3);
    saveCodes.applyShop(s3, t3, rec, clock);
    assert.equal(ab.equipped(t3), 'grapple');
    assert.equal(ab.onBanked(t3, 200), null, 'no trial on top of a restored ability');
    // a save never swaps out what you hold now
    const s4 = mkSocket();
    const t4 = tank(AX + 900, AY, s4);
    ab.grant(s4, 'burrow');
    saveCodes.applyShop(s4, t4, rec, clock);
    assert.equal(ab.equipped(t4), 'burrow');
    assert.deepEqual(ab.stateOf(s4).own.sort(), ['burrow', 'grapple', 'shock']);
    cleanup(t, t2, t3, t4);
});

// ── kill switch ─────────────────────────────────────────────────────────
test('off: ROYALE_ABILITIES=0 is the old shop, no dash, the old twist', () => {
    const r = spawnSync(process.execPath, [__filename, '--off'], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.on, false);
    assert.equal(out.dash, false);
    for (const id of ['magnet', 'boots', 'plating', 'strut', 'overdrive']) assert.ok(out.ids.includes(id), id + ' back');
    for (const id of ['rocket', 'flare', 'grapple', 'shock']) assert.ok(!out.ids.includes(id), id + ' gone');
    assert.ok(out.magnet && !out.hook);
});

test('free ability: one random fun one on the first spawn of a raid, kept for the raid, never swapped by a trial', () => {
    const r = spawnSync(process.execPath, [__filename, '--free'], { encoding: 'utf8', env: Object.assign({}, process.env, { ROYALE_FREE_ABILITY: '1' }) });
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.ok(o.pool.includes(o.free), o.free);
    assert.deepEqual(o.own, [o.free]);
    assert.equal(o.eq, o.free, 'in the slot');
    assert.equal(o.fn1, 1, 'the client slams it once');
    assert.equal(o.fn2, 0, 'not on later lives');
    assert.deepEqual(o.own2, [o.free], 'no second one on a respawn');
    assert.equal(o.trial, null, 'no first-bank trial over the free one');
    assert.equal(o.eqAfterBank, o.free, 'still the free one after the bank');
    assert.deepEqual(o.again, [o.free], 'a reload in the same raid keeps it, no new one');
    assert.equal(o.next.length, 1, 'next raid: a new free one');
    const ex = fs.readFileSync(path.join(SERVER, '.env.example'), 'utf8');
    assert.match(ex, /ROYALE_FREE_ABILITY=1/);
    const fxSrc = fs.readFileSync(path.join(REPO, 'public', 'client', 'abilityFx.js'), 'utf8');
    assert.ok(!/YOUR ABILITY: /.test(fxSrc), 'the free ability arrives without a slam');
});

test('shockwave from a bot: thrown at a player, it launches them (a grown one clearly) and tells them', () => {
    clearDisc(AX, AY, 1000);
    const bot = tank(AX, AY, null);
    assert.ok(ab.giveBot(bot, 'shock'));
    const s1 = mkSocket(), p1 = tank(AX + 380, AY, s1);
    const s2 = mkSocket(), p2 = tank(AX + 380, AY + 160, s2);
    p2.growthMult = 3;
    step(1);
    p1.velocity.x = 0; p2.velocity.x = 0;
    assert.ok(ab.use(bot, p1.x, p1.y));
    for (let i = 0; i < 30 && ab.orbs.length; i++) step(1);
    assert.ok(speed(p1) > 35, 'player launched: ' + speed(p1).toFixed(1));
    assert.ok(speed(p2) > 20, 'grown one launched clearly: ' + speed(p2).toFixed(1));
    assert.ok(s1.packets.some(p => p[0] === 'AF' && p[1] === 'flinghit' && p[6] === p1.id), 'victim told (shake + glitch)');
    const x0 = p1.x;
    step(8);
    assert.ok(Math.abs(p1.x - x0) > 120, 'and it actually moves: ' + (p1.x - x0).toFixed(0));
    cleanup(bot, p1, p2);
});

test('cards: NEW ITEM / NEW ABILITY once per item ever, then a glide; never over the sky drop', () => {
    const si = fs.readFileSync(path.join(REPO, 'public', 'client', 'socketinit.js'), 'utf8');
    assert.match(si, /abilityFx\.unlockSeen\("kit:" \+ id\)\) \{ abilityFx\.glide\(id, ""\)/);
    const fxSrc = fs.readFileSync(path.join(REPO, 'public', 'client', 'abilityFx.js'), 'utf8');
    assert.match(fxSrc, /const SEEN_UNLOCKS = "dwSeenUnlocks_v1"/, 'once per item, ever');
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.match(app, /if \(land > 0\) unlockHoldUntil = land \+ 600;/);
    assert.match(app, /function drawKitGlides\(now\)/, 'later gains glide into the slot');
});

test('found abilities (supply crate) join what you own; they only take an empty slot; swaps are shop-only', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    ab.addFound(s, 'radar');
    assert.equal(ab.equipped(t), 'radar', 'empty slot: it goes in');
    assert.match(lastAB(s).msg, /Radar Ping added/);
    ab.addFound(s, 'grapple');
    assert.equal(ab.equipped(t), 'radar', 'already holding one: not swapped');
    assert.deepEqual(ab.stateOf(s).own, ['radar', 'grapple']);
    assert.equal(lastAB(s).msg, 'Grapple Hook added. Equip it at a shop.');
    t.vaultOnPad = true; t.padSafe = true;
    assert.equal(ab.cycle(s), false, 'not on a vault');
    t.vaultOnPad = false; t.shopOnPad = true;
    assert.equal(ab.cycle(s), false, 'nor on a shop pad: Equip only');
    assert.equal(ab.equipped(t), 'radar');
    const cs = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'chests.js'), 'utf8');
    assert.match(cs, /require\('\.\/abilityDrops\.js'\)\.fromChest\(chest, body\)/);
    const sd = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'supplyDrops.js'), 'utf8');
    assert.doesNotMatch(sd, /addFound\(|giveBot\(/, 'the crate drops a pickup instead of handing the ability over');
    t.shopOnPad = false; t.padSafe = false;
    cleanup(t);
});

test('the slot rule: only the free starter (empty slot), a purchase or Equip change it; every other path just adds', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    ab.onSpawn(t);
    ab.grant(s, 'burrow');                      // bought: in the slot
    const held = () => ab.equipped(t);
    assert.equal(held(), 'burrow');
    // a supply crate (chest.onOpened -> supplyDrops reward -> addFound)
    ab.addFound(s, 'shock');
    assert.equal(held(), 'burrow', 'crate');
    assert.doesNotMatch(lastAB(s).msg, /press|Q /i, 'never says press Q for one that is not equipped');
    // a chest broken open: kit and gems only, the slot stays
    const chests = require(path.join(SERVER, 'game', 'terrain', 'chests.js'));
    const chest = chests.spawnChest(AX + 120, AY, true, { gems: 0, item: 'medkit' });
    if (chest) { chests.openChest(chest, t); step(2); }
    assert.equal(held(), 'burrow', 'chest');
    // the first bank: no trial over it
    assert.equal(ab.onBanked(t, 500), null);
    assert.equal(held(), 'burrow', 'bank');
    // a raid twist (Hook Storm) hands one out: owned for the cycle, not equipped
    ab.grantTwist(t, 'grapple');
    assert.equal(held(), 'burrow', 'twist');
    assert.equal(lastAB(s).tw, 'grapple');
    ab.revokeTwist(s);
    assert.equal(held(), 'burrow', 'twist over');
    // a respawn
    t.kill();
    const t2 = tank(AX, AY, s);
    ab.onSpawn(t2);
    assert.equal(ab.equipped(t2), 'burrow', 'respawn');
    // a second connection in the same raid that grabbed a free one before
    // its guest id turned up: the ledger's slot wins
    s.guestId = 'f'.repeat(32);
    ab.stateOf(s);
    const sB = mkSocket();
    const tB = tank(AX + 300, AY, sB);
    ab.stateOf(sB).own.push('radar'); ab.stateOf(sB).eq = 'radar';
    sB.guestId = s.guestId;
    assert.equal(ab.equippedOf(ab.stateOf(sB)), 'burrow', 'reconnect keeps the slot');
    assert.ok(ab.stateOf(sB).own.includes('radar'), 'and keeps what it picked up');
    // the shop's Equip and the key on a shop pad do swap
    t2.shopOnPad = true;
    s.gemBanked = 0;
    assert.ok(shop.buy(s, 'shock'), 'owned: equip for free');
    assert.equal(ab.equipped(t2), 'shock');
    t2.shopOnPad = false;
    // a found one with nothing in the slot goes straight in
    const s3 = mkSocket();
    const t3 = tank(AX - 300, AY, s3);
    ab.addFound(s3, 'pad');
    assert.equal(ab.equipped(t3), 'pad');
    assert.match(lastAB(s3).msg, /in your ability slot/);
    cleanup(t2, tB, t3);
});

test('client: a pickup that is not equipped says equip it at a shop, never press Q', () => {
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.match(app, /u\.spare \? "Added\. Equip it at a shop\."/);
    // the unlock card is a small edge card now: no screen dim, no rays, no
    // burst, no hiding the vault's Deposit or its input
    const card = app.slice(app.indexOf('    function drawKitUnlock() {'), app.indexOf('    // ── shop panel'));
    assert.doesNotMatch(card, /vignetteSprite|raySprite|fillRect\(0, 0, sw, shh\)|starPath|clickables\.vault\.hide|vaultInput/, 'quiet and out of the way');
    assert.doesNotMatch(card, /hudCardUp/, 'it is not a big card');
    assert.match(card, /const W = 290, H = 62/);
    const fxSrc = fs.readFileSync(path.join(REPO, 'public', 'client', 'abilityFx.js'), 'utf8');
    assert.match(fxSrc, /spare: fresh !== S\.eq/);
});

test('gem magnet: back on the shelf, pulls from almost twice as far for 5 minutes', () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    s.gemBanked = 2000;
    t.shopOnPad = true;
    assert.equal(shop.magnetMult(t), 1);
    assert.ok(shop.buy(s, 'magnet'));
    assert.equal(s.gemBanked, 650);
    assert.ok(shop.magnetMult(t) >= 1.8 && shop.magnetMult(t) < 2);
    clock += 5 * 60 * 1000 + 100;
    assert.equal(shop.magnetMult(t), 1, 'runs out');
    t.shopOnPad = false;
    cleanup(t);
});

test('bulwark: raises the dug-out ring out to 420 fast, and speeds up rock already rising on its own', () => {
    clearDisc(AX, AY, 700);
    const t = tank(AX, AY, mkSocket());
    const B = shop.BULWARK;
    // one cell already rising at the normal pace, inside the ring
    const ring = [...grid.rocks.values()].filter(r => r.worldPoly && !r.canyon && !r.alive && Math.hypot(r.worldCx - AX, r.worldCy - AY) > 200 && Math.hypot(r.worldCx - AX, r.worldCy - AY) < 380);
    assert.ok(ring.length > 4, 'dug-out cells in the ring');
    const slow = ring[0];
    slow.noRegrowUntil = 0;
    grid.startRegrow(slow, clock, 0);
    assert.equal(slow.growRate, require(path.join(SERVER, 'game', 'terrain', 'terrainGrid.js')).REGROW.RISE_RATE, 'rising at the normal pace');
    const n = shop.bulwarkRaise(grid, t, clock);
    assert.ok(n >= Math.min(B.max, ring.length), 'raised ' + n);
    assert.ok(slow.growFast && slow.growRate === B.rate, 'the slow one sped up: ' + slow.growRate);
    for (const r of ring) if (r.growing) assert.ok(r.growRate >= B.rate, 'quick rise');
    const far = [...grid.rocks.values()].filter(r => r.growing && Math.hypot(r.worldCx - AX, r.worldCy - AY) > B.r + 1);
    assert.equal(far.length, 0, 'nothing past the ring');
    const under = [...grid.rocks.values()].filter(r => r.growing && Math.hypot(r.worldCx - AX, r.worldCy - AY) < (t.realSize || 30) + B.gap - 1);
    assert.equal(under.length, 0, 'nothing under the tank');
    for (const r of grid.rocks.values()) if (r.growing) { r.growing = false; r.growFast = false; r.growRate = 1; }
    cleanup(t);
});

test('kit effects: every kit item sends its look, the decoy only to its owner', () => {
    clearDisc(AX, AY, 1000);
    const s = mkSocket();
    const t = tank(AX, AY, s);
    const other = mkSocket(); other.camera = { x: AX, y: AY };
    for (const id of ['charge', 'medkit', 'anchor', 'bulwark', 'barrage']) {
        s.packets.length = 0; other.packets.length = 0;
        ab.kitFx(id, t, AX + 300, AY);
        assert.ok(other.packets.some(p => p[0] === 'AF' && p[1] === 'k_' + id && p[6] === t.id), id);
    }
    s.packets.length = 0; other.packets.length = 0;
    ab.kitFx('decoy', t, 0, 0);
    assert.ok(s.packets.some(p => p[0] === 'AF' && p[1] === 'k_decoy'), 'owner sees the decoy');
    assert.ok(!other.packets.some(p => p[0] === 'AF' && p[1] === 'k_decoy'), 'nobody else does');
    const shopSrc = fs.readFileSync(path.join(SERVER, 'game', 'terrain', 'shop.js'), 'utf8');
    assert.match(shopSrc, /abilities\.kitFx\(id, body, tx, ty\)/);
    cleanup(t);
});

test('ability tour: once per browser, only after the landing and the slam, never in the tutorial or over a card', async () => {
    const L = await import(path.join(REPO, 'public', 'client', 'abilityIntroLogic.js'));
    const mem = new Map();
    const store = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
    assert.equal(L.INTRO_KEY, 'dwAbilityIntro_v1');
    assert.equal(L.introDone(store), false, 'a new browser has not seen it');
    const ok = { done: false, tutorial: false, playing: true, abilOn: true, eq: 'grapple', falling: false, landedAgo: L.START_DELAY + 1, slam: false, card: false, busy: false };
    assert.equal(L.canStart(ok), true);
    for (const [k, v, why] of [['falling', true, 'not during the fall'], ['landedAgo', 500, 'not right on landing'], ['slam', true, 'not over the ability slam'],
        ['card', true, 'not over another card'], ['busy', true, 'not over a panel or the map'], ['tutorial', true, 'not in the tutorial'], ['eq', null, 'needs an ability'], ['playing', false, 'only while playing']]) {
        assert.equal(L.canStart({ ...ok, [k]: v }), false, why);
    }
    L.markDone(store);
    assert.equal(L.introDone(store), true);
    assert.equal(L.canStart({ ...ok, done: L.introDone(store) }), false, 'once: never again in this browser');
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(L.introDone(blocked), true, 'storage blocked: never nag');
    // using the thing moves it on; the last step ends it
    assert.equal(L.advance(0, 'dash'), 1);
    assert.equal(L.advance(0, 'ability'), 0, 'only its own thing moves a step');
    assert.equal(L.advance(1, 'ability'), 2);
    assert.equal(L.advance(2, 'shop'), -1);
    // the shop tab badge
    assert.equal(L.tabSeen(store), false);
    L.markTabSeen(store);
    assert.equal(L.tabSeen(store), true);
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.match(app, /abilityIntro\.draw\(ctx\[2\]/);
    assert.match(app, /if \(id === "ability" && !abTabSeen\)/, 'NEW on the Abilities tab until seen');
});

test('rearranging: kit slots swap on the server (validated), the keys follow; the chip order is a saved layout choice', async () => {
    const s = mkSocket();
    const t = tank(AX, AY, s);
    const st = shop.stateOf(s);
    shop.grantKit(s, 'medkit'); shop.grantKit(s, 'bulwark');
    assert.deepEqual(st.kitOrder, ['medkit', 'bulwark']);
    assert.ok(shop.swapKit(s, 0, 1));
    assert.deepEqual(st.kitOrder, ['bulwark', 'medkit'], 'swapped');
    assert.deepEqual(JSON.parse(s.packets.filter(p => p[0] === 'SHP').pop()[1]).kitOrder, ['bulwark', 'medkit'], 'the client hears it');
    // onto the empty third slot: it stays there, leaving a hole
    assert.ok(shop.swapKit(s, 0, 2));
    assert.deepEqual(st.kitOrder, [null, 'medkit', 'bulwark'], 'moved into slot 3');
    // bad requests change nothing (an empty slot can't be dragged)
    for (const [a, b] of [[0, 1], [1, 1], [-1, 1], [1, 3], [0.5, 1], ['1', 2], [1, 9]]) {
        assert.equal(shop.swapKit(s, a, b), false, 'refused ' + a + ' -> ' + b);
        assert.deepEqual(st.kitOrder, [null, 'medkit', 'bulwark']);
    }
    // keys follow the slot: key 1 is empty, key 2 the medkit
    st.kit.medkit = 1;
    t.health.amount = t.health.max * 0.3;
    assert.equal(shop.useKit(s, 0, AX, AY), false, 'slot 1 is empty');
    assert.ok(shop.useKit(s, 1, AX, AY), 'slot 2 is the medkit');
    assert.ok(t.health.amount > t.health.max * 0.45);
    assert.deepEqual(st.kitOrder, [null, null, 'bulwark'], 'used up: its slot empties, the charge stays put');
    // something new fills the first empty slot
    shop.grantKit(s, 'anchor');
    assert.deepEqual(st.kitOrder, ['anchor', null, 'bulwark']);
    shop.grantKit(s, 'flash');
    assert.deepEqual(st.kitOrder, ['anchor', 'flash', 'bulwark']);
    assert.equal(shop.grantKit(s, 'decoy'), false, 'three kinds: full');
    // a hole at the end is trimmed, a hole in the middle stays through normalising
    assert.ok(shop.dropKit(s, 1));
    assert.deepEqual(shop.stateOf(s).kitOrder, ['anchor', null, 'bulwark']);
    // a save keeps the slots, holes included
    const rec = saveCodes.shopRecord(s, clock);
    assert.deepEqual(rec.kitOrder, ['anchor', null, 'bulwark'], 'saved as arranged');
    const s2 = mkSocket();
    const t2 = tank(AX + 300, AY, s2);
    saveCodes.applyShop(s2, t2, rec, clock);
    assert.deepEqual(shop.stateOf(s2).kitOrder.slice(0, 3), ['anchor', null, 'bulwark'], 'restored into the same slots');
    // a use names the item it SHOWED: a slot index from before a swap
    // landed still fires that item, never its neighbour
    const sk = shop.stateOf(s);
    sk.kit.bulwark = 2;
    assert.deepEqual(sk.kitOrder, ['anchor', null, 'bulwark']);
    s.packets.length = 0;
    clock += 1000;       // past the kit's half-second lockout
    assert.ok(shop.useKit(s, 0, AX + 200, AY, 'bulwark'), 'stale slot 1, but the charge was pressed');
    assert.equal(sk.kit.bulwark, 1, 'the charge fired');
    assert.ok(sk.kit.anchor > 0, 'not the anchor in slot 1');
    assert.equal(shop.useKit(s, 1, AX, AY, 'medkit'), false, 'an item you no longer have does nothing');
    const cvSrc = fs.readFileSync(path.join(REPO, 'public', 'client', 'canvas.js'), 'utf8');
    assert.match(cvSrc, /this\.socket\.talk\('sk', slot, Math\.round\(wx\), Math\.round\(wy\), String\(ko\[slot\]\)\)/, 'the client always names the item');
    assert.match(cvSrc, /window\.addEventListener\("mouseup"/, 'a release is never lost (no stuck drag eating the next click)');
    assert.match(cvSrc, /if \(mouse\.button === 0\) \{ global\.kitDrag = null; global\.chipDrag = null; \}/);
    // the shop's KIT FULL counts items, not slots
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.match(app, /\(st\.kitOrder \|\| \[\]\)\.filter\(Boolean\)\.length >= 3\) return \{ text: "KIT FULL"/);
    cleanup(t2);
    const so = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.match(so, /case "ko": \{[\s\S]{0,300}swapKit\(socket, m\[0\], m\[1\]\)/);
    // chips: client-only layout
    const O = await import(path.join(REPO, 'public', 'client', 'chipOrder.js'));
    assert.deepEqual(O.parseOrder(null), ['dash', 'ability'], 'default');
    assert.deepEqual(O.parseOrder('ability,dash'), ['ability', 'dash']);
    assert.deepEqual(O.parseOrder('ability,ability'), ['dash', 'ability'], 'junk -> default');
    assert.deepEqual(O.swapOrder(['dash', 'ability'], 'dash', 'ability'), ['ability', 'dash']);
    assert.deepEqual(O.swapOrder(['dash', 'ability'], 'dash', 'sidearm'), ['dash', 'ability'], 'unknown ids change nothing');
    const mem = new Map(), store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    O.saveOrder(store, ['ability', 'dash']);
    assert.deepEqual(O.loadOrder(store), ['ability', 'dash'], 'remembered');
    const cv = fs.readFileSync(path.join(REPO, 'public', 'client', 'canvas.js'), 'utf8');
    const down = cv.slice(cv.indexOf('    mouseDown(mouse) {'), cv.indexOf('    toggleBigMap() {'));
    assert.ok(/global\.chipDrag = \{[^}]*\};\s+break;/.test(down) && down.indexOf('global.chipDrag =') < down.indexOf('cmd.set(primaryFire, true)'), 'a chip drag never fires the gun');
    const tc = fs.readFileSync(path.join(REPO, 'public', 'client', 'touch.js'), 'utf8');
    assert.match(tc, /if \(h\.tip && !h\.drag && Math\.hypot\(x - h\.tx, y - h\.ty\) > 12\)/, 'touch: long press, then a 12 px move drags');
    cleanup(t);
});

// ── wiring ──────────────────────────────────────────────────────────────
test('wiring: ab packet, keybinds (Shift dash, Q ability, comma kit 2, R override, period screenshot), touch buttons, HUD', () => {
    const sockets = fs.readFileSync(path.join(SERVER, 'game', 'network', 'sockets.js'), 'utf8');
    assert.match(sockets, /case "ab": \{/);
    assert.match(sockets, /abil\.dash\(player\.body, 0, 0\)/);
    const g = fs.readFileSync(path.join(REPO, 'public', 'client', 'global.js'), 'utf8');
    assert.match(g, /KEY_DASH: 18/);
    assert.match(g, /KEY_ABILITY: 81/);
    assert.match(g, /KEY_KIT_2: 188/);
    assert.match(g, /KEY_OVER_RIDE: 82/);
    assert.match(g, /KEY_SCREENSHOT: 190/);
    const html = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
    assert.match(html, /data-key="KEY_DASH"/);
    assert.match(html, /data-key="KEY_ABILITY"/);
    const cv = fs.readFileSync(path.join(REPO, 'public', 'client', 'canvas.js'), 'utf8');
    assert.match(cv, /kc === global\.KEY_DASH/);
    assert.match(cv, /kc === global\.KEY_ABILITY/);
    const tc = fs.readFileSync(path.join(REPO, 'public', 'client', 'touch.js'), 'utf8');
    assert.match(tc, /"dash"/);
    assert.match(tc, /"ability"/);
    const si = fs.readFileSync(path.join(REPO, 'public', 'client', 'socketinit.js'), 'utf8');
    assert.match(si, /case 'AB':/);
    assert.match(si, /case 'AF':/);
    assert.match(si, /case 'AR':/);
    const index = fs.readFileSync(path.join(SERVER, 'game', 'index.js'), 'utf8');
    assert.match(index, /require\('\.\/terrain\/abilities\.js'\)\)\.tick\(gemActors\)/);
});

// ===================================================================

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
