// Raid chat broadcast (server/game/network/raidChat.js):
//   node scripts/test/raidChat.test.js
//
// Fake sockets, the real spam filter (addons/basicChatModeration.js) on a
// real event bus, the real profanity mask. Every line reaches everyone in
// the raid once ('CH'), far away or dead; blocks either way hide it; team
// lines stay on the team; spam and long lines are stopped. No game server.
'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..');
global.Events = new EventEmitter();
global.Config = { popup_message_duration: 3000 };
const clients = [];
global.gameManager = { clients };

require(path.join(ROOT, 'server', 'game', 'addons', 'basicChatModeration.js'));
const chat = require(path.join(ROOT, 'server', 'game', 'network', 'raidChat.js'));
// the account block check, as accounts/game/bridge.js does it
chat.hooks.chatHidden = (viewer, speaker) => {
    const b = viewer && viewer.account && viewer.account.blocked;
    return !!(b && b.size && speaker && speaker.accountId && b.has(speaker.accountId));
};

let nextId = 1;
function sock(name, opts = {}) {
    const s = { id: nextId++, got: [], status: {}, talk(...m) { this.got.push(m); } };
    if (opts.body === false) s.player = { body: null, team: opts.team };
    else {
        const body = { id: 100 + s.id, name, team: opts.team != null ? opts.team : -s.id, color: { compiled: opts.color || '12 0 1 0 false' }, accountId: opts.account || 0, x: opts.x || 0, y: opts.y || 0 };
        s.player = { body };
    }
    if (opts.account) s.account = { id: opts.account, blocked: new Set(opts.blocks || []) };
    clients.push(s);
    return s;
}
const lines = (s) => s.got.filter(m => m[0] === 'CH');
const popups = (s) => s.got.filter(m => m[0] === 'm').map(m => m[2]);
const reset = () => { for (const s of clients) s.got.length = 0; };

let failed = 0;
function test(name, fn) {
    try { reset(); fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}

const ann = sock('Ann', { account: 1, color: '10 0 1 0 false' });
const bob = sock('Bob', { account: 2, x: 9000, y: 9000 });     // the far side of the map
const cy = sock('Cy', { account: 3, blocks: [1] });             // Cy blocked Ann
const dee = sock('Dee', { body: false });                       // dead / spectating
const eve = sock('Eve', { account: 5 });

test('a line reaches everyone in the raid once, far away or dead, the sender too', () => {
    assert.equal(chat.fromPlayer(bob, 'meet at the vault', 0), 5);
    for (const s of clients) {
        const got = lines(s);
        assert.equal(got.length, 1, s.player.body ? s.player.body.name : 'dead');
        const [, id, bid, name, col, text, team] = got[0];
        assert.ok(id > 0);
        assert.equal(bid, bob.player.body.id);
        assert.equal(name, 'Bob');
        assert.equal(col, '12 0 1 0 false', 'the compiled body colour');
        assert.equal(text, 'meet at the vault');
        assert.equal(team, 0);
    }
});

test('each line has its own id', () => {
    chat.send({ body: eve.player.body, socket: eve, text: 'one' });
    chat.send({ body: eve.player.body, socket: eve, text: 'two' });
    const ids = lines(ann).map(m => m[1]);
    assert.equal(ids.length, 2);
    assert.ok(ids[1] > ids[0]);
});

test('a block either way: neither sees the other, everyone else does', () => {
    // Cy blocked Ann: Ann's line never reaches Cy
    chat.send({ body: ann.player.body, socket: ann, text: 'hello all' });
    assert.equal(lines(cy).length, 0, 'Cy blocked Ann');
    assert.equal(lines(ann).length, 1, 'Ann sees her own line');
    assert.equal(lines(bob).length, 1);
    reset();
    // ...and Cy's line never reaches Ann (the block works both ways)
    chat.send({ body: cy.player.body, socket: cy, text: 'anyone?' });
    assert.equal(lines(ann).length, 0, 'Ann was blocked by Cy');
    assert.equal(lines(cy).length, 1, 'Cy sees his own line');
    assert.equal(lines(eve).length, 1);
});

test('team lines only reach the team', () => {
    const t1 = sock('Tom', { team: -77 }), t2 = sock('Tia', { team: -77 }), t3 = sock('Ted', { body: false, team: -77 });
    reset();
    assert.equal(chat.fromPlayer(t1, 'push left', 1), 3);
    assert.equal(lines(t1).length, 1);
    assert.equal(lines(t2).length, 1);
    assert.equal(lines(t3).length, 1, 'a dead teammate still hears it');
    assert.equal(lines(t2)[0][6], 1, 'flagged as team');
    for (const s of [ann, bob, cy, dee, eve]) assert.equal(lines(s).length, 0);
    for (const s of [t1, t2, t3]) clients.splice(clients.indexOf(s), 1);
});

test('swears are masked for everyone, the rest of the line stays', () => {
    chat.fromPlayer(eve, 'what the fuck was that', 0);
    const text = lines(bob)[0][5];
    assert.ok(!/fuck/i.test(text), text);
    assert.match(text, /^what the \*+ was that$/);
});

test('spam: the fourth line in 10 s is stopped with a popup, long lines too', () => {
    const sam = sock('Sam');
    reset();
    assert.equal(chat.fromPlayer(sam, 'a', 0) > 0, true);
    assert.equal(chat.fromPlayer(sam, 'b', 0) > 0, true);
    assert.equal(chat.fromPlayer(sam, 'c', 0) > 0, true);
    assert.equal(chat.fromPlayer(sam, 'd', 0), 0, 'fourth in 10 s');
    assert.ok(popups(sam).some(t => /Slow down/.test(t)));
    assert.equal(lines(ann).length, 3);
    const lou = sock('Lou');
    reset();
    assert.equal(chat.fromPlayer(lou, 'x'.repeat(57), 0), 0, 'over 56 characters');
    assert.ok(popups(lou).includes('Too long!'));
    assert.equal(lines(ann).length, 0);
    clients.splice(clients.indexOf(sam), 1); clients.splice(clients.indexOf(lou), 1);
});

test('empty, control characters, no body', () => {
    assert.equal(chat.fromPlayer(dee, 'I am dead', 0), 0, 'no body: no raid chat');
    assert.equal(chat.send({ body: ann.player.body, socket: ann, text: '   ' }), 0);
    chat.send({ body: ann.player.body, socket: ann, text: 'one\ntwo\u0007' });
    assert.equal(lines(bob)[0][5], 'one two');
});

test('"$toggle" muted clients and other tutorial plots hear nothing', () => {
    eve.status.disablechat = true;
    ann._tutorialPlot = 0; bob._tutorialPlot = 1;
    chat.send({ body: ann.player.body, socket: ann, text: 'plot zero' });
    assert.equal(lines(eve).length, 0, 'muted');
    assert.equal(lines(bob).length, 0, 'another plot');
    assert.equal(lines(ann).length, 1);
    eve.status.disablechat = false;
    delete ann._tutorialPlot; delete bob._tutorialPlot;
});

test('a bot talks to the whole raid (Entity.say)', () => {
    const bot = { id: 999, name: 'Rocky', team: -999, color: { compiled: '5 0 1 0 false' } };
    assert.equal(chat.send({ body: bot, text: 'gg' }), clients.length);
    assert.deepEqual(lines(dee)[0].slice(2), [999, 'Rocky', '5 0 1 0 false', 'gg', 0]);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
// the spam filter's decay timers would hold the process for 10 s
process.exit(failed ? 1 : 0);
