// Dead-link timing for hidden tabs: node scripts/test/linkWatch.test.js
//
//   visible   a silent socket is dropped after 12 s, not before
//   hidden    a tab that said it went hidden gets 30 s; one that came back,
//             or is freezing (its socket won't survive), is on the 12 s clock
//   packet    the client's VZ packet is checked and fed to the watch
//   client    socketinit.js sends VZ on visibilitychange, freeze and resume,
//             and again on every new socket while hidden
//   idle      the 5 minute idle kick is untouched by any of it
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

for (const k of ['ROYALE_DEBUG', 'DEAD_LINK_MS', 'HIDDEN_DEAD_LINK_MS']) delete process.env[k];
const REPO = path.join(__dirname, '..', '..');
const linkWatch = require(path.join(REPO, 'server', 'lib', 'linkWatch.js'));
const activity = require(path.join(REPO, 'server', 'game', 'network', 'activity.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('visible: dropped after 12 s of silence', () => {
    assert.equal(linkWatch.DEAD_AFTER_MS, 12000);
    const s = { _seenAt: 1000 };
    assert.equal(linkWatch.isDead(s, 1000 + 12000), false);
    assert.equal(linkWatch.isDead(s, 1000 + 12001), true);
    assert.equal(linkWatch.isDead({}, 5000), false, 'never seen yet: not dead');
});

test('hidden: 30 s while the tab is hidden, 12 s again once it is back or freezes', () => {
    assert.equal(linkWatch.HIDDEN_DEAD_MS, 30000);
    const s = { _seenAt: 1000 };
    linkWatch.noteVisibility(s, 1, 2000);
    assert.equal(linkWatch.deadAfter(s), 30000);
    assert.equal(linkWatch.isDead(s, 1000 + 13000), false, 'the 13 s drop from the report');
    assert.equal(linkWatch.isDead(s, 1000 + 29000), false);
    assert.equal(linkWatch.isDead(s, 1000 + 30001), true, 'a truly dead hidden tab still goes');
    linkWatch.noteVisibility(s, 1, 9000);
    assert.equal(s._tabHiddenAt, 2000, 'a second notice keeps the first time');
    linkWatch.noteVisibility(s, 0, 10000);
    assert.equal(linkWatch.deadAfter(s), 12000, 'visible again');
    assert.equal(linkWatch.isDead(s, 1000 + 13000), true);
    // a frozen page can't answer and Chrome closes its socket when it wakes:
    // out of the world at the normal time, the raid held for the resume
    const f = { _seenAt: 1000 };
    linkWatch.noteVisibility(f, 1, 2000);
    linkWatch.noteVisibility(f, 2, 3000);
    assert.equal(linkWatch.deadAfter(f), 12000, 'frozen');
    assert.equal(linkWatch.isDead(f, 1000 + 12001), true);
});

test('packet: sockets.js takes VZ 0/1/2 only and feeds the watch', () => {
    const src = fs.readFileSync(path.join(REPO, 'server', 'game', 'network', 'sockets.js'), 'utf8');
    const i = src.indexOf('case "VZ"');
    assert.ok(i > 0, 'VZ handled');
    const body = src.slice(i, src.indexOf('} break;', i));
    assert.match(body, /m\.length !== 1/);
    assert.match(body, /m\[0\] !== 0 && m\[0\] !== 1 && m\[0\] !== 2/);
    assert.match(body, /linkWatch\.noteVisibility\(socket, m\[0\]/);
    assert.match(src, /linkWatch\.isDead\(socket, t\)/, 'checkLinks uses the watch');
});

test('client: VZ goes out on visibilitychange, freeze and resume, and on reconnect', () => {
    const src = fs.readFileSync(path.join(REPO, 'public', 'client', 'socketinit.js'), 'utf8');
    assert.match(src, /addEventListener\("visibilitychange", \(\) => tellTabState\(document\.hidden \? 1 : 0\)\)/);
    assert.match(src, /addEventListener\("freeze", \(\) => tellTabState\(2\)\)/);
    assert.match(src, /addEventListener\("resume"/);
    assert.match(src, /talk\('RZ', resumeToken\);[\s\S]{0,200}if \(document\.hidden\) tellTabState\(1\)/);
});

test('idle: the 5 minute kick does not care about the tab', () => {
    assert.equal(activity.IDLE_KICK_MS, 5 * 60 * 1000);
    const s = { lastInputAt: 1000 };
    linkWatch.noteVisibility(s, 1, 2000);
    assert.equal(activity.idleMs(s, 1000 + 5 * 60 * 1000), 5 * 60 * 1000, 'hidden time is idle time');
});

let failed = 0;
for (const t of tests) {
    try { t.fn(); console.log('ok   ' + t.name); } catch (e) {
        failed++;
        console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n     '));
    }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
