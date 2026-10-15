'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const T = (...p) => path.join(SERVER, 'game', 'terrain', ...p);

process.env.ROYALE_FREE_ABILITY = '0';
global.Config = { dig_royale: true };
const sockets = [];
global.gameManager = { socketManager: { clients: sockets, players: [] }, gameHandler: { bots: [] } };

const ab = require(T('abilities.js'));
const drops = require(T('abilityDrops.js'));
const classBalance = require(T('classBalance.js'));
const mining = require(T('mining.js'));

let seq = 0;
function mkSocket() {
    const s = { id: 'd' + (++seq), packets: [], guestId: String(seq).padStart(32, 'a'), shop: null, camera: { x: 0, y: 0 } };
    s.talk = (...a) => s.packets.push(a);
    sockets.push(s);
    return s;
}
function player(x, y) {
    const s = mkSocket();
    const b = { id: 1000 + seq, socket: s, x, y, realSize: 30, velocity: { x: 0, y: 0 }, isDead: () => false };
    s.player = { body: b };
    return b;
}
function bot(x, y) { return { id: 5000 + (++seq), isBot: true, x, y, realSize: 30, isDead: () => false }; }
const lastMsg = (s) => { const p = [...s.packets].reverse().find(x => x[0] === 'AB'); return p ? JSON.parse(p[1]).msg : null; };
const lastAB = (s) => { const p = [...s.packets].reverse().find(x => x[0] === 'AB'); return p ? JSON.parse(p[1]) : null; };
const actorsOf = (...bs) => bs.map(b => b.socket ? { body: b } : b);
const fresh = () => { ab.resetRaid(); drops.reset(); sockets.length = 0; };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('odds live in one table: crates always, epic chests usually, copper chests sometimes', () => {
    assert.deepEqual(drops.ODDS, { crate: 1, epic: 0.75, copper: 0.25 });
    fresh();
    const roll = (chest, r) => drops.fromChest(chest, null, () => r);
    assert.ok(roll({ x: 0, y: 0, supplyDrop: true, chestRare: true }, 0.99), 'crate');
    assert.ok(roll({ x: 0, y: 0, chestRare: true }, 0.7), 'epic at 0.7');
    assert.equal(roll({ x: 0, y: 0, chestRare: true }, 0.8), null, 'epic at 0.8');
    assert.ok(roll({ x: 0, y: 0 }, 0.2), 'copper at 0.2');
    assert.equal(roll({ x: 0, y: 0 }, 0.3), null, 'copper at 0.3');
    assert.equal(drops.list().length, 3);
});

test('the drop prefers an ability the opener does not have yet', () => {
    fresh();
    const p = player(0, 0);
    const st = ab.stateOf(p.socket);
    st.own = ab.ABILITIES.map(a => a.id).filter(id => id !== 'smoke');
    st.eq = 'grapple';
    for (let i = 0; i < 20; i++) assert.equal(drops.pickFor(p), 'smoke');
});

test('an empty slot: running over it equips it for good', () => {
    fresh();
    const p = player(0, 0);
    const d = drops.spawn(40, 0, 'grapple', { kind: 'copper', t: 1000 });
    drops.tick(actorsOf(p), 1000 + 100);
    assert.equal(drops.list().length, 1, 'not before it lands');
    drops.tick(actorsOf(p), 1000 + drops.ARM_MS + 1);
    assert.equal(drops.list().length, 0, 'picked up');
    const st = ab.stateOf(p.socket);
    assert.equal(st.eq, 'grapple');
    assert.ok(st.own.includes('grapple'));
    assert.equal(lastMsg(p.socket), "You picked up Grapple Hook! It's in your ability slot now.");
    const af = p.socket.packets.find(x => x[0] === 'AF' && x[1] === 'abget');
    assert.ok(af && af[5] === p.id && af[6] === d.id, 'everyone near sees the pop');
});

test('a full slot: a 60 s trial on Q that never touches the equipped slot, then Q goes back', () => {
    fresh();
    const p = player(0, 0);
    ab.grant(p.socket, 'radar');
    const t0 = Date.now();
    drops.spawn(0, 0, 'smoke', { kind: 'epic', t: t0 });
    drops.tick(actorsOf(p), t0 + 500);
    const st = ab.stateOf(p.socket);
    assert.equal(st.eq, 'radar', 'the slot is untouched');
    assert.equal(ab.equippedOf(st, t0 + 600), 'smoke', 'Q fires the pickup for now');
    assert.ok(!st.own.includes('smoke'), 'a chest pickup is a trial, not a purchase');
    assert.equal(lastMsg(p.socket), "You picked up Smoke Bomb! It's on Q for 60 seconds.");
    assert.equal(drops.TRIAL_MS, 60000);
    assert.equal(lastAB(p.socket).tr.id, 'smoke');
    drops.tick([], t0 + 500 + 59_000);
    assert.equal(st.trial && st.trial.id, 'smoke');
    drops.tick([], t0 + 500 + 60_001);
    assert.equal(st.trial, null);
    assert.equal(ab.equippedOf(st, t0 + 60_600), 'radar');
    assert.equal(lastMsg(p.socket), 'Your Smoke Bomb ran out, so Q is back to Radar Ping.');
});

test('a supply crate pickup is also yours to equip at a shop later', () => {
    fresh();
    const p = player(0, 0);
    ab.grant(p.socket, 'radar');
    drops.spawn(0, 0, 'pad', { kind: 'crate', t: 0 });
    drops.tick(actorsOf(p), 1000);
    const st = ab.stateOf(p.socket);
    assert.equal(st.eq, 'radar');
    assert.ok(st.own.includes('pad'));
    assert.match(lastMsg(p.socket), /on Q for 60 seconds\. It's yours to equip at a shop too\.$/);
});

test('the one you already have equipped: its cooldown resets', () => {
    fresh();
    const p = player(0, 0);
    ab.grant(p.socket, 'shock');
    const st = ab.stateOf(p.socket);
    st.cd.shock = Date.now() + 10_000;
    drops.spawn(0, 0, 'shock', { kind: 'copper', t: 0 });
    drops.tick(actorsOf(p), 1000);
    assert.equal(st.cd.shock, 0);
    assert.equal(st.trial, null);
    assert.equal(lastMsg(p.socket), "You picked up Shockwave! It's ready to use again.");
});

test('bots and burrowed tanks leave it, the opener gets first grab, and it is gone after 45 s', () => {
    fresh();
    const b = bot(0, 0);
    const opener = player(500, 0);
    const other = player(0, 0);
    const d = drops.spawn(0, 0, 'rush', { kind: 'epic', opener, t: 0 });
    drops.tick(actorsOf(b, other), 1000);
    assert.equal(drops.list().length, 1, 'the opener has it for a moment');
    other.burrowUntil = 1e15;
    drops.tick(actorsOf(b, other), drops.OPENER_MS + 10);
    assert.equal(drops.list().length, 1, 'bots never, nor anyone underground');
    other.burrowUntil = 0;
    drops.tick(actorsOf(b, other), drops.OPENER_MS + 20);
    assert.equal(drops.list().length, 0, 'then anyone');
    assert.equal(ab.stateOf(other.socket).eq, 'rush');
    drops.spawn(900, 900, 'radar', { t: 0 });
    drops.tick(actorsOf(other), drops.LIFE_MS - 1);
    assert.equal(drops.list().length, 1);
    drops.tick(actorsOf(other), drops.LIFE_MS);
    assert.equal(drops.list().length, 0, 'despawned');
    assert.ok(d.id > 0);
});

test('the RY rows: id, ability, spot, age and time left', () => {
    fresh();
    assert.equal(drops.snapshot(0), undefined, 'nothing to send');
    const d = drops.spawn(10.4, -20.6, 'wall', { t: 1000 });
    assert.deepEqual(drops.snapshot(3000), [{ i: d.id, k: 'wall', x: 10, y: -21, a: 2000, l: drops.LIFE_MS - 2000 }]);
    const dr = fs.readFileSync(path.join(SERVER, 'game', 'gamemodes', 'scripts', 'dig_royale.js'), 'utf8');
    assert.match(dr, /abd: abilityDrops\.snapshot\(t\)/);
    const si = fs.readFileSync(path.join(REPO, 'public', 'client', 'socketinit.js'), 'utf8');
    assert.match(si, /r\.abd = d\.abd \|\| null;/);
});

test('the tutorial and the off switch drop nothing', () => {
    fresh();
    Config.tutorial = true;
    assert.equal(drops.fromChest({ x: 0, y: 0, supplyDrop: true }, null, () => 0), null);
    Config.tutorial = false;
    assert.ok(drops.fromChest({ x: 0, y: 0, supplyDrop: true }, null, () => 0));
});

test('drone nerf: every drone and minion hits other tanks 25% softer, stacked on the old nerfs; swarm drones hit 10% harder', () => {
    assert.equal(classBalance.HELPER_VS_TANKS, 0.75);
    const tank = (label, extra = {}) => { const r = { label, isPlayer: true, team: 1, ...extra }; r.master = r; return r; };
    const hit = (root, src, target = { isPlayer: true, team: 2 }) => classBalance.intoTank(target, Object.assign(src, { master: root }), 100);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
    const ov = tank('Overseer');
    near(hit(ov, { type: 'drone', source: ov }), 75);
    const fac = tank('Factory');
    const minion = { type: 'minion', source: fac };
    near(hit(fac, minion), 100 * 0.5 * 0.6 * 0.75);
    near(hit(fac, { type: 'bullet', source: minion }), 100 * 0.5 * 0.75);
    const sp = tank('Spawner');
    near(hit(sp, { type: 'bullet', source: { type: 'minion', source: sp } }), 75);
    const bee = tank('Beekeeper');
    assert.equal(classBalance.SWARM_VS_TANKS, 1.1);
    near(hit(bee, { type: 'swarm', motionType: 'swarm', source: bee }), 100 * 0.72 * 1.1);
    const cr = tank('Cruiser');
    near(hit(cr, { type: 'swarm', motionType: 'swarm', source: cr }), 110, 'the cruiser line');
    const sg = tank('Shotgun');
    near(hit(sg, { type: 'swarm', motionType: 'motor', source: sg }), 80, 'shotgun shells are typed swarm but are no drones');
    const botRoot = tank('Overseer', { isPlayer: false, isBot: true });
    near(hit(botRoot, { type: 'drone', source: botRoot }), 75);
    near(hit(ov, { type: 'swarm', motionType: 'swarm', source: ov, fromSidearm: true }), 100, 'the shop sidearm');
    near(hit(ov, { type: 'swarm', motionType: 'swarm', source: ov, rockOnly: true }), 100, 'the Drone Bay perk');
    near(hit(ov, { type: 'bullet', source: ov }), 100, 'a plain bullet');
    near(hit(ov, { type: 'drone', source: ov }, { isRoyaleBoss: true, isBot: true }), 100, 'bosses take the same');
    near(hit(ov, { type: 'drone', source: ov }, { isLootChest: true }), 100, 'chests take the same');
});

test('drone mining: a drone, minion or minion bullet digs 30% of a normal bullet, a swarm drone 60%', () => {
    assert.equal(mining.HELPER_DIG, 0.3);
    const owner = { defs: ['basic'] };
    const normal = mining.rockDamageFor(owner, { type: 'bullet', digPower: 1 });
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
    near(mining.rockDamageFor(owner, { type: 'drone', digPower: 1 }), normal * 0.3);
    near(mining.rockDamageFor(owner, { type: 'swarm', motionType: 'swarm', digPower: 1 }), normal * 0.6);
    near(mining.rockDamageFor(owner, { type: 'swarm', motionType: 'motor', digPower: 1 }), normal * 0.8);
    near(mining.rockDamageFor(owner, { type: 'bullet', digPower: 1, source: { type: 'minion' } }), normal * 0.3);
    near(mining.rockDamageFor(owner, { type: 'trap', digPower: 1 }), normal * 0.8);
    near(mining.rockDamageFor(owner, { type: 'swarm', motionType: 'swarm', digPower: 1, rockOnly: true }), normal * 0.8);
    const fac = { defs: ['factory'] };
    near(mining.rockDamageFor(fac, { type: 'bullet', digPower: 1, source: { type: 'minion' } }), normal * mining.MINE_BIAS.factory * 0.3);
});

test('client: the pickup draws from abilityFx, baked once per ability, in the HOT build list, with no code comments', () => {
    const client = fs.readFileSync(path.join(REPO, 'public', 'client', 'abilityDrops.js'), 'utf8');
    const server = fs.readFileSync(T('abilityDrops.js'), 'utf8');
    for (const src of [client, server]) assert.doesNotMatch(src, /\/\/|\/\*/, 'no comments');
    assert.match(client, /const sprites = new Map\(\);/);
    const fx = fs.readFileSync(path.join(REPO, 'public', 'client', 'abilityFx.js'), 'utf8');
    assert.match(fx, /drops\.drawFloor\(c, px, py, ratio\)/);
    assert.match(fx, /drops\.drawPops\(c, px, py, ratio\)/);
    assert.match(fx, /if \(kind === "abget"\)/);
    const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
    assert.match(app, /paintGlyph: \(c, id, u\) => paintKitGlyph\(/);
    const build = fs.readFileSync(path.join(REPO, 'scripts', 'build-client.js'), 'utf8');
    assert.ok(build.indexOf('"client/abilityDrops.js"') > 0 && build.indexOf('"client/abilityDrops.js"') < build.indexOf('"client/funnel.js"'));
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
