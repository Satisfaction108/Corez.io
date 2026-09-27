// Duo team chat and pings (server/game/duo/duoComms.js):
//   node scripts/test/duoComms.test.js
//
// A real duo team book (duoRaid.book) with fake sockets: team chat and pings
// reach the partner and the sender only, never a stranger, work with no body
// (dead / spectating), respect blocks, and are rate limited. No game server.
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const DUO = path.join(__dirname, '..', '..', 'server', 'game', 'duo');
// outposts.js pulls in the whole terrain stack; a ping only needs the pads
const opPath = require.resolve(path.join(__dirname, '..', '..', 'server', 'game', 'terrain', 'outposts.js'));
const pads = [];
require.cache[opPath] = { id: opPath, filename: opPath, loaded: true, exports: { getOutposts: () => pads } };

global.Config = { royale_duos: true };
global.entities = new Map();
const clients = [];
global.gameManager = { socketManager: { clients }, room: { width: 4000, height: 4000 }, terrainGrid: null };

const duoRaid = require(path.join(DUO, 'duoRaid.js'));
const comms = require(path.join(DUO, 'duoComms.js'));

let clock = 1_000_000;
comms.hooks.now = () => clock;

let nextId = 1;
function sock(mk, name, opts = {}) {
    const s = { id: nextId++, duoKey: mk, got: [], talk(...m) { this.got.push(m); } };
    if (opts.body !== false) {
        const body = { id: 100 + s.id, name, team: opts.team, x: opts.x || 0, y: opts.y || 0, size: 20, isPlayer: true, isDead: () => false };
        s.player = { body };
        global.entities.set(body.id, body);
    } else s.player = { body: null };
    if (opts.account) s.account = { id: opts.account, blocked: new Set(opts.blocks || []) };
    clients.push(s);
    return s;
}
const got = (s, type) => s.got.filter(m => m[0] === type);
const reset = (...ss) => { for (const s of ss) s.got.length = 0; };

let failed = 0;
function test(name, fn) {
    try { fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}

// a party of two (Ann + Bob) and a stranger (Cy) on his own team
const tA = duoRaid.book.join({ mk: 'u:1', pid: 'P1', name: 'Ann' }).team;
duoRaid.book.join({ mk: 'u:2', pid: 'P1', name: 'Bob' });
const tC = duoRaid.book.join({ mk: 'u:3', pid: 'P2', name: 'Cy' }).team;
const A = sock('u:1', 'Ann', { team: tA.id, account: 1 });
const B = sock('u:2', 'Bob', { team: tA.id, account: 2, x: 3000 - 2000, y: 1500 });
const C = sock('u:3', 'Cy', { team: tC.id, account: 3, x: 400, y: 400 });

test('the book pairs Ann and Bob; Cy is alone', () => {
    assert.equal(duoRaid.mateSocket(A), B);
    assert.equal(duoRaid.mateSocket(B), A);
    assert.equal(duoRaid.mateSocket(C), null);
});

test('team chat reaches the partner (any distance) and echoes to the sender, never a stranger', () => {
    reset(A, B, C);
    assert.equal(comms.teamChat(A, '  on my way  '), true);
    assert.deepEqual(got(B, 'TC'), [['TC', 'Ann', 'on my way', A.player.body.id, 0]]);
    assert.deepEqual(got(A, 'TC'), [['TC', 'Ann', 'on my way', A.player.body.id, 1]]);
    assert.equal(got(C, 'TC').length, 0);
});

test('a stranger with no partner only hears himself', () => {
    reset(A, B, C);
    clock += 20000;
    assert.equal(comms.teamChat(C, 'anyone?'), false);
    assert.equal(got(C, 'TC').length, 1);
    assert.equal(got(A, 'TC').length + got(B, 'TC').length, 0);
});

test('a dead player (no body) can still talk to the partner, under the book name', () => {
    reset(A, B, C);
    clock += 20000;
    const keep = B.player.body;
    B.player.body = null;
    B._duoName = undefined;
    try {
        assert.equal(comms.teamChat(B, 'I died, left side'), true);
        assert.deepEqual(got(A, 'TC'), [['TC', 'Bob', 'I died, left side', 0, 0]]);
    } finally { B.player.body = keep; }
});

test('chat rate limit: 600 ms between messages, 3 per 10 s', () => {
    reset(A, B, C);
    clock += 20000;
    assert.equal(comms.teamChat(A, 'one'), true);
    clock += 100;
    assert.equal(comms.teamChat(A, 'too fast'), false, 'under 600 ms');
    clock += 700;
    assert.equal(comms.teamChat(A, 'two'), true);
    clock += 700;
    assert.equal(comms.teamChat(A, 'three'), true);
    clock += 700;
    assert.equal(comms.teamChat(A, 'four'), false, 'fourth in 10 s');
    assert.deepEqual(got(B, 'TC').map(m => m[2]), ['one', 'two', 'three']);
    assert.ok(got(A, 'm').length >= 1, 'the sender hears why');
    clock += 10000;
    assert.equal(comms.teamChat(A, 'later'), true, 'the window slides');
});

test('empty, non-string and too-long messages are dropped', () => {
    reset(A, B, C);
    clock += 20000;
    assert.equal(comms.teamChat(A, '   '), false);
    assert.equal(comms.teamChat(A, 42), false);
    assert.equal(comms.teamChat(A, 'x'.repeat(comms.CHAT_MAX + 1)), false);
    assert.equal(got(B, 'TC').length, 0);
});

test('a block either way keeps chat and pings from the partner', () => {
    reset(A, B, C);
    clock += 20000;
    B.account.blocked.add(1);
    try {
        comms.teamChat(A, 'hi');
        comms.ping(A, 10, 10);
        assert.equal(got(B, 'TC').length + got(B, 'PG').length, 0);
        assert.equal(got(A, 'TC').length, 1, 'the sender still sees their own line');
    } finally { B.account.blocked.delete(1); }
});

test('ping reaches the partner only, with the spot and the sender', () => {
    reset(A, B, C);
    clock += 20000;
    assert.equal(comms.ping(A, -1200.4, 90.6), true);
    assert.deepEqual(got(B, 'PG'), [['PG', -1200, 91, 'here', 'Ann', A.player.body.id, 0]]);
    assert.deepEqual(got(A, 'PG'), [['PG', -1200, 91, 'here', 'Ann', A.player.body.id, 1]]);
    assert.equal(got(C, 'PG').length, 0);
});

test('ping rate limit: one per second', () => {
    reset(A, B, C);
    clock += 20000;
    assert.equal(comms.ping(A, 0, 0), true);
    clock += 400;
    assert.equal(comms.ping(A, 5, 5), false);
    clock += 700;
    assert.equal(comms.ping(A, 5, 5), true);
    assert.equal(got(B, 'PG').length, 2);
});

test('ping kinds: an enemy tank, a base pad, loose gems, else here; the partner is not an enemy', () => {
    reset(A, B, C);
    clock += 20000;
    comms.ping(A, 410, 395);                        // on Cy
    clock += 1100;
    comms.ping(A, B.player.body.x, B.player.body.y); // on Bob, your own partner
    clock += 1100;
    pads.push({ x: -1500, y: -1500, r: 150 });
    comms.ping(A, -1450, -1520);                    // on a base pad
    clock += 1100;
    const gem = { id: 999, x: 1700, y: -1700, isGemPickup: true, isDead: () => false };
    global.entities.set(gem.id, gem);
    comms.ping(A, 1730, -1690);                     // on loose gems
    clock += 1100;
    comms.ping(A, 99999, -99999);                   // off the map: clamped, nothing there
    assert.deepEqual(got(B, 'PG').map(m => m[3]), ['enemy', 'here', 'base', 'gems', 'here']);
    const last = got(B, 'PG').pop();
    assert.deepEqual([last[1], last[2]], [2000, -2000], 'clamped to the room');
});

test('a dead player can ping; their own partner still does not read as an enemy', () => {
    reset(A, B, C);
    clock += 20000;
    const keep = A.player.body;
    A.player.body = null;
    try {
        assert.equal(comms.ping(A, B.player.body.x, B.player.body.y), true);
        assert.equal(got(B, 'PG')[0][3], 'here');
        assert.equal(got(B, 'PG')[0][5], 0, 'no body id while dead');
    } finally { A.player.body = keep; }
});

test('bad input and a non-duo server do nothing', () => {
    reset(A, B, C);
    clock += 20000;
    assert.equal(comms.ping(A, NaN, 0), false);
    assert.equal(comms.ping(A, '1', 0), false);
    global.Config.royale_duos = false;
    try {
        assert.equal(comms.teamChat(A, 'hello'), false);
        assert.equal(comms.ping(A, 1, 1), false);
    } finally { global.Config.royale_duos = true; }
    assert.equal(A.got.length + B.got.length, 0);
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
