// Engine-only duel simulator for the tank budget calibration
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const [planFile, outFile] = process.argv.slice(2);
const arg = (k, d) => process.argv.includes(k) ? +process.argv[process.argv.indexOf(k) + 1] : d;
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
for (const k of ['ROYALE_TANKS', 'ROYALE_TANKS_T5_FREE']) delete process.env[k];
process.env.ROYALE_TANKS = 'classic';   // plan.env may say 'expanded'
Object.assign(process.env, plan.env || {});
{
    const log = console.log; console.log = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = log; }
}
Config.dig_royale = true;
const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
global.gameManager = {
    room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [{ check: () => true, add() {}, remove() {} }], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
const handler = new gameHandler(global.gameManager); global.gameManager.gameHandler = handler;
const B = require('./budget.js');

const ZONE = arg('--zone', 200);          // radius of the contested zone
const AIM = arg('--aim', 0.08);           // aim wobble, radians (about 1 sigma)
const MAX_TICKS = arg('--ticks', 1800);           // 60 s of game time
const GUN_BUILD = [7, 7, 5, 7, 4, 2, 0, 5, 2, 5, 0];   // autoStats.js templates, mining slot zeroed
const RAM_BUILD = [0, 0, 0, 0, 0, 8, 9, 9, 7, 9, 0];
let seed = 1;
// the engine's own dice (spread, shudder) roll from the same seeded stream
Math.random = () => rnd();
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

function style(key) {
    const f = B.flatten(key);
    const kinds = f.guns.filter(x => x.typed).map(x => B.isStock(x.type) ? 'drone' : /trap|pillbox|box|block/i.test(x.type || '') ? 'trap' : 'bullet');
    if (f.smasher) return { range: 0, ram: true };
    const n = k => kinds.filter(x => x === k).length;
    if (n('drone') >= n('bullet') && n('drone')) return { range: 560 };
    if (n('trap') > n('bullet')) return { range: 220 };
    return { range: 400, gun: true };
}
function spawn(key, x, y, team) {
    const e = new Entity({ x, y }); e.define(key);
    e.team = team; e.alwaysActive = true; e.invuln = false;
    const me = { e, cmd: { fire: true, main: true, alt: false, power: 1 } };
    e.controllers = [{ acceptsFromTop: true, think: () => me.cmd }];
    e.isPlayer = true; e.socket = { talk() {}, status: {}, camera: { x, y }, _careerLives: 100 }; e.sendMessage = () => {}; e.reverseTank = 1;
    while (e.skill.level < 45) { e.skill.score += e.skill.levelScore; e.skill.maintain(); }
    const st = style(key);
    e.skill.set(st.ram ? RAM_BUILD : GUN_BUILD);
    e.refreshSkills && e.refreshSkills();
    e.refreshBodyAttributes();
    e.health.amount = e.health.max; e.shield.amount = e.shield.max;
    return Object.assign(me, { st, shot: 18, flip: 15 + rnd() * 35, wob: 0, err: 0, dir: rnd() < 0.5 ? 1 : -1 });
}
function pilot(me, foe) {
    const e = me.e, o = foe.e, dx = o.x - e.x, dy = o.y - e.y, d = Math.hypot(dx, dy) || 1;
    // lead the target by the flight time of my own shots (measured)
    const t = Math.min(40, d / Math.max(4, me.shot));
    // a human hand: the aim wobbles a few degrees, re-picked every few ticks
    if (--me.wob <= 0) { me.wob = 4 + rnd() * 8; me.err = (rnd() + rnd() + rnd() - 1.5) * 2 * AIM; }
    const tx = dx + o.velocity.x * t, ty = dy + o.velocity.y * t, c = Math.cos(me.err), s = Math.sin(me.err);
    me.cmd.target = { x: tx * c - ty * s, y: tx * s + ty * c };
    if (--me.flip <= 0) { me.dir = -me.dir; me.flip = 15 + rnd() * 35; }
    const ux = dx / d, uy = dy / d;
    // gunners back off at half speed at most (no endless kiting in the open) a gunner
    const want = me.st.gun ? Math.max(180, Math.min(480, me.shot * 24)) : me.st.range;
    const radial = me.st.ram ? 1 : Math.max(-0.5, Math.min(1, (d - want) / 150));
    const side = me.st.ram ? 0.8 : 1;
    let gx = ux * radial - uy * me.dir * side, gy = uy * radial + ux * me.dir * side;
    // both hold a contested zone (a gem, a chest): nobody can kite forever
    const r = Math.hypot(e.x, e.y);
    if (r > ZONE) { const k = Math.min(2, (r - ZONE) / 150); gx -= e.x / r * k; gy -= e.y / r * k; }
    me.cmd.goal = { x: e.x + gx * 200, y: e.y + gy * 200 };
}
function measureShots(me, all) {
    let s = 0, n = 0;
    for (const x of all) if (x.master === me.e && x !== me.e && !x.bond && x.type === 'bullet') { s += Math.hypot(x.velocity.x, x.velocity.y); n++; }
    if (n) me.shot = 0.7 * me.shot + 0.3 * (s / n);
}
function hp(e) { return Math.max(0, e.health.amount) / e.health.max * 0.8 + Math.max(0, e.shield.amount) / Math.max(1, e.shield.max) * 0.2; }
function duel(a, b, sd) {
    seed = sd;
    const ang = rnd() * Math.PI * 2, R = 450;
    const A = spawn(a, Math.cos(ang) * R, Math.sin(ang) * R, -1), Bt = spawn(b, -Math.cos(ang) * R, -Math.sin(ang) * R, -2);
    let tick = 0, win = null;
    for (; tick < MAX_TICKS; tick++) {
        if (A.e.isDead() || Bt.e.isDead()) break;
        pilot(A, Bt); pilot(Bt, A);
        handler.gameloop();
        if (tick % 15 === 7) { const all = [...entities.values()]; measureShots(A, all); measureShots(Bt, all); }
    }
    const da = A.e.isDead(), db = Bt.e.isDead();
    const ha = da ? 0 : hp(A.e), hb = db ? 0 : hp(Bt.e);
    if (da && !db) win = 0; else if (db && !da) win = 1; else win = Math.abs(ha - hb) < 0.05 ? 0.5 : ha > hb ? 1 : 0;
    for (const x of [...entities.values()]) { try { x.kill(); } catch { /* */ } }
    for (let t = 0; t < 3; t++) handler.gameloop();
    return { a, b, seed: sd, win, ticks: tick, ha: +ha.toFixed(3), hb: +hb.toFixed(3), ko: da || db };
}
module.exports = { duel };
if (require.main === module) {
    const from = arg('--from', 0), count = arg('--count', plan.duels.length);
    const list = plan.duels.slice(from, from + count);
    const t0 = Date.now();
    for (const [a, b, sd] of list) {
        let r;
        try { r = duel(a, b, sd); } catch (e) { r = { a, b, seed: sd, error: String(e.message).slice(0, 200) }; for (const x of [...entities.values()]) { try { x.kill(); } catch { /* */ } } }
        fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
    }
    process.stdout.write(list.length + ' duels in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s\n', () => process.exit(0));
}
