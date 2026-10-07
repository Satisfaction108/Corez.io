// Tier 5 unlock (server/game/terrain/tier5.js)
'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

if (process.argv[2] === '--env') {
    process.stdout.write(String(require(path.join(SERVER, 'game', 'terrain', 'tier5.js')).T5_GROWTH));
    return;
}
if (process.argv[2] === '--classic') {
    const log = console.log; console.log = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = log; }
    Config.dig_royale = true;
    const t5 = require(path.join(SERVER, 'game', 'terrain', 'tier5.js'));
    process.stdout.write(JSON.stringify({ xp: !!Class.xp_splitter, active: t5.active() }));
    return;
}

delete process.env.ROYALE_TANKS; delete process.env.ROYALE_TANKS_T5_FREE; delete process.env.ROYALE_T5_GROWTH;
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
const tier5 = require(path.join(SERVER, 'game', 'terrain', 'tier5.js'));
const rb = require(path.join(SERVER, 'game', 'terrain', 'respawnBuild.js'));
const botTanks = require(path.join(SERVER, 'miscFiles', 'botTanks.js'));
const D = require(path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js'));

let raid = 1;
tier5.setRaidOf(() => raid);
rb.setRaidOf(() => raid);

let sid = 0;
function mkSocket() { const s = { id: 'sock' + (++sid), status: {}, msgs: [], talk() {}, camera: { x: 0, y: 0 } }; return s; }
function mkBody(socket, opts = {}) {
    const e = new Entity({ x: 0, y: 0 });
    e.define(Config.spawn_class || 'basic');
    e.controllers = []; e.alwaysActive = true;
    if (socket) { e.socket = socket; e.isPlayer = true; socket.player = { body: e }; }
    Object.assign(e, opts);
    e.sendMessage = (m) => { (e._msgs = e._msgs || []).push(m); };
    while (e.skill.level < 45) { e.skill.score += e.skill.levelScore; e.skill.maintain(); }
    e.refreshBodyAttributes();
    return e;
}
const T5 = D.tanks.find(t => t.tier === 5 && t.parents.length >= 1 && botTanks.pathFor(t.key) && botTanks.pathFor(t.key).length === 4);
const T4 = botTanks.pathFor(T5.key)[2];
const path4 = botTanks.pathFor(T5.key).slice(0, 3);
const t5Index = b => b.upgrades.findIndex(u => u.tier === 4 && u.class.length === 1 && (u.class[0] === T5.key || u.class[0] === Class[T5.key]));
const key0 = b => { const d = b.defs[0]; return typeof d === 'string' ? d : Object.keys(Class).find(k => Class[k] === d); };
const menu = b => b.upgrades.filter(u => tier5.open(b, u));

const results = [];
function test(name, fn) { try { fn(); results.push([name, null]); console.log('ok   ' + name); } catch (e) { results.push([name, e]); console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')); } }

let sock, body;
test('gate: Tier 5 is refused below 2x and opens at 2x', () => {
    assert.ok(tier5.active(), 'gate active in a raid with the expanded tree');
    assert.equal(tier5.T5_GROWTH, 2);
    sock = mkSocket(); body = mkBody(sock);
    assert.ok(botTanks.climb(body, path4), 'climbs to ' + T4);
    assert.equal(key0(body), T4);
    assert.equal(tier5.bodyTier(body), 4);
    const i = t5Index(body);
    assert.ok(i >= 0, 'the Tier 5 option is in the raw list');
    assert.equal(menu(body).length, 0, 'not in the menu yet');
    body.upgrade(i);
    assert.equal(key0(body), T4, 'an unearned Tier 5 upgrade is refused');
    assert.deepEqual(tier5.youFields(body).t5.slice(0, 2), [4, 0]);
    body._growTarget = 1.99;
    assert.equal(tier5.note(body), false);
    body._growTarget = 2;
    assert.equal(tier5.note(body), true, 'earned at 2x');
    assert.equal(tier5.note(body), false, 'only once');
    assert.ok(menu(body).length >= 3, 'Tier 5 options in the menu');
    assert.deepEqual(tier5.youFields(body).t5.slice(0, 2), [4, 1]);
    body.upgrade(t5Index(body));
    assert.equal(key0(body), T5.key, 'upgraded to Tier 5');
    assert.equal(tier5.bodyTier(body), 5);
});

test('per life: a respawn closes Tier 5 until the new life is 2x', () => {
    rb.save(sock, body, raid);
    const fresh = mkBody(sock);
    assert.equal(fresh._growTarget, undefined);
    assert.ok(!tier5.has(fresh), 'the new life has to earn it again');
    assert.ok(botTanks.climb(fresh, path4));
    assert.equal(menu(fresh).length, 0, 'no Tier 5 in the menu at 1x');
    fresh.upgrade(t5Index(fresh));
    assert.equal(key0(fresh), T4, 'refused at 1x');
    assert.deepEqual(tier5.youFields(fresh).t5.slice(0, 2), [4, 0], 'the ring shows again');
    fresh._growTarget = 2;
    assert.ok(tier5.note(fresh), 'earned again at 2x this life');
    assert.ok(menu(fresh).length >= 3);
    // Respawn as: back as the Tier 4 parent, Tier 5 again at 2x
    sock._rbWant = true;
    const again = mkBody(sock);
    assert.ok(rb.onSpawn(sock, again));
    assert.equal(key0(again), T4, 'Respawn as stops at the Tier 4 parent');
    assert.equal(rb.youFields(sock, again).ltg, 200, 'the gate note while this life is under 2x');
    assert.ok((again._msgs || []).some(m => /Grow to 2x this life to unlock Tier 5/.test(m)), (again._msgs || []).join(' | '));
    again._growTarget = 2.1; assert.ok(tier5.note(again));
    assert.ok(!rb.youFields(sock, again).ltg, 'no gate note once this life is 2x');
});

test('reset: a new raid closes Tier 5 again', () => {
    raid++;
    const b = mkBody(sock);
    assert.ok(!tier5.has(b));
    assert.ok(botTanks.climb(b, path4));
    const i = t5Index(b);
    b.upgrade(i);
    assert.equal(key0(b), T4);
    assert.equal(menu(b).length, 0);
});

test('respawn: a Tier 5 build comes back as the Tier 4 parent', () => {
    const s = mkSocket(), b = mkBody(s);
    botTanks.climb(b, path4); b._growTarget = 2.2; tier5.note(b); b.upgrade(t5Index(b));
    assert.equal(key0(b), T5.key);
    rb.save(s, b, raid);
    const yf = rb.youFields(s, null);
    assert.equal(yf.lt, Class[T4].LABEL, 'the death card names the Tier 4 parent');
    assert.equal(yf.ltg, 200);
    s._rbWant = true;
    const nb = mkBody(s);
    rb.onSpawn(s, nb);
    assert.equal(key0(nb), T4, 'back as the Tier 4 parent');
    assert.ok((nb._msgs || []).some(m => /Grow to 2x this life to unlock Tier 5/.test(m)), 'and says so: ' + (nb._msgs || []).join(' | '));
    // Last tank button: same stop
    const nb2 = mkBody(s);
    rb.applyTank(nb2, rb.last(s));
    assert.equal(key0(nb2), T4);
    // fairPlay's keep-build restore takes the parent too
    assert.equal(tier5.gateDef(nb2, T5.key).def, T4);
});

test('bots: 2x growth takes a Tier 5 child; after a respawn it stops at Tier 4 until 2x again', () => {
    const bot = mkBody(null, { isBot: true, botFamilyId: 9001 });
    assert.ok(botTanks.climb(bot, path4));
    assert.equal(botTanks.tier5Up(bot, handler), false, 'nothing below 2x');
    bot._growTarget = 2.05;
    assert.ok(tier5.note(bot));
    assert.ok(botTanks.tier5Up(bot, handler), 'took a Tier 5');
    const got = key0(bot);
    assert.equal(tier5.tierOf(got), 5, got + ' is Tier 5');
    const p = botTanks.pathFor(got);
    assert.ok(p && p.length === 4);
    const back = mkBody(null, { isBot: true, botFamilyId: 9001 });
    botTanks.climb(back, p);
    assert.equal(key0(back), p[2], 'the respawned bot stops at the Tier 4 parent');
    assert.equal(botTanks.tier5Up(back, handler), false, 'no Tier 5 at 1x');
    back._growTarget = 2;
    assert.ok(tier5.note(back));
    assert.ok(botTanks.tier5Up(back, handler), 'Tier 5 again once this life is 2x');
    assert.equal(tier5.tierOf(key0(back)), 5);
    const other = mkBody(null, { isBot: true, botFamilyId: 9002 });
    botTanks.climb(other, p);
    assert.equal(key0(other), p[2], 'another family stops at the Tier 4 parent');
});

test('bots: the spawn pool is the whole expanded Tier 4 layer, weighted', () => {
    assert.ok(botTanks.expandedOn());
    const pool = botTanks.pool(new Set());
    const fresh = pool.filter(c => c.name.startsWith('xp_')).length;
    assert.ok(pool.length > 150, 'pool ' + pool.length);
    assert.ok(fresh > 80, 'new Tier 4 tanks in the pool: ' + fresh);
    assert.ok(pool.every(c => c.path.length === 3 && c.weight > 0));
    assert.ok(pool.some(c => c.drone), 'drone carriers allowed');
    // a lobby of picks spreads out and keeps drone carriers few
    const counts = new Map(); counts.droneBots = 3;
    for (let i = 0; i < 40; i++) { const c = botTanks.pick(new Set(), counts); assert.ok(!c.drone, 'no 4th drone carrier'); }
    const seen = new Set(); for (let i = 0; i < 200; i++) seen.add(botTanks.pick(new Set(), new Map()).name);
    assert.ok(seen.size > 60, 'varied picks: ' + seen.size);
    // builds that fit the tank
    const kinds = {};
    for (const c of pool) { const k = botTanks.buildKind({ defs: [c.name] }) || 'gun'; kinds[k] = (kinds[k] || 0) + 1; }
    assert.ok(kinds.drone > 0 && kinds.trap > 0 && kinds.sniper > 0 && kinds.heavy > 0, JSON.stringify(kinds));
});

test('off: the classic tree and the tutorial have no Tier 5 and no gate', () => {
    for (const env of [{ ROYALE_TANKS: 'classic' }]) {
        const r = JSON.parse(execFileSync(process.execPath, [__filename, '--classic'], { env: { ...process.env, ...env }, cwd: REPO }).toString());
        assert.deepEqual(r, { xp: false, active: false });
    }
});

test('env: ROYALE_T5_GROWTH moves the mark', () => {
    assert.equal(execFileSync(process.execPath, [__filename, '--env'], { env: { ...process.env, ROYALE_T5_GROWTH: '1.5' } }).toString(), '1.5');
    assert.equal(execFileSync(process.execPath, [__filename, '--env'], { env: { ...process.env, ROYALE_T5_GROWTH: 'x' } }).toString(), '2');
});

const failed = results.filter(r => r[1]).length;
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
