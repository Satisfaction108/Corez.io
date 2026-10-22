// The shop's Stat Point: node scripts/test/statPoint.test.js
//
//   buy        1,000 banked gems for one extra upgrade point, as many as fit
//   raid       a respawned tank gets its bought points again, once
//   full       refused once every stat is maxed
//   flash      the Flash Vault banks up to 1,000 (minus its 30% fee)
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
global.gameManager = {
    room: { width: 6000, height: 6000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
    views: [], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
    socketManager: { players: [], clients: [], broadcast() {} },
};
global.gameManager.gameHandler = new gameHandler(global.gameManager);
const shop = require(path.join(SERVER, 'game', 'terrain', 'shop.js'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function player(sock) {
    const t = new Entity({ x: 0, y: 0 });
    t.define('basic');
    t.isPlayer = true; t.team = -1;
    t.socket = sock; sock.player = { body: t };
    t.sendMessage = () => {};
    t.shopOnPad = true;
    return t;
}
function socket() {
    const s = { packets: [], gemBanked: 0, talk(...a) { this.packets.push(a); } };
    global.gameManager.socketManager.clients.push(s);
    return s;
}

test('buy: 1,500 banked gems for one extra point, as many as fit', () => {
    const s = socket();
    const b = player(s);
    s.gemBanked = 3500;
    const p0 = b.skill.points;
    assert.equal(shop.buy(s, 'statpt'), true);
    assert.equal(b.skill.points, p0 + 1);
    assert.equal(s.gemBanked, 2000);
    assert.equal(shop.buy(s, 'statpt'), true, 'again');
    assert.equal(b.skill.points, p0 + 2);
    assert.equal(shop.buy(s, 'statpt'), false, 'not enough gems for a third');
    assert.equal(b.skill.points, p0 + 2);
});

test('raid: a respawned tank gets its bought points again, once', () => {
    const s = socket();
    const b = player(s);
    s.gemBanked = 1500;
    shop.buy(s, 'statpt');
    const b2 = player(s);
    const p0 = b2.skill.points;
    shop.applyPassives(b2);
    assert.equal(b2.skill.points, p0 + 1, 'the new body gets it');
    shop.applyPassives(b2);
    assert.equal(b2.skill.points, p0 + 1, 'and only once');
    void b;
});

test('full: refused once every stat is maxed', () => {
    const s = socket();
    const b = player(s);
    b.skill.set(b.skill.caps.slice());
    b.skill.points = 0;
    s.gemBanked = 5000;
    assert.equal(shop.buy(s, 'statpt'), false);
    assert.equal(s.gemBanked, 5000, 'nothing charged');
    assert.ok(s.packets.some(p => JSON.stringify(p).includes('maxed out')), 'told why');
});

test('cap: at most 10 bought a raid, the 11th is refused and not charged', () => {
    const s = socket();
    const b = player(s);
    b.skill.points = 0;
    s.gemBanked = 100000;
    let n = 0;
    for (let i = 0; i < 20; i++) if (shop.buy(s, 'statpt')) n++;
    assert.equal(shop.STATPT_MAX, 10);
    assert.equal(n, 10, 'bought ' + n);
    assert.equal(s.gemBanked, 100000 - 10 * 1500, 'the extra tries cost nothing');
    assert.ok(s.packets.some(p => JSON.stringify(p).includes('most stat points')), 'told why');
});

test('flash: the Flash Vault banks up to 1,000 of the satchel, minus 30%', () => {
    const it = shop.ITEMS ? shop.ITEMS.find(i => i.id === 'flash') : null;
    const src = require('fs').readFileSync(path.join(SERVER, 'game', 'terrain', 'shop.js'), 'utf8');
    assert.match(src, /const take = Math\.min\(1000, carried\);/);
    if (it) assert.match(it.desc, /up to 1,000/);
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n     ')); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
