// The raid chat panel's model (public/client/chatPanelLogic.js) and its
// wiring: node scripts/test/chatPanel.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const REPO = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

(async () => {
    const L = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'chatPanelLogic.js')).href);
    const tests = [];
    const test = (n, f) => tests.push([n, f]);
    const measure = (s) => Array.from(s).length * 10;   // 10 px a character

    test('history: newest last, capped, duplicates (same id) dropped', () => {
        const log = L.createLog(5);
        for (let i = 1; i <= 8; i++) L.pushMessage(log, { id: i, name: 'P' + i, text: 'line ' + i }, i);
        assert.equal(log.list.length, 5);
        assert.deepStrictEqual(log.list.map(l => l.id), [4, 5, 6, 7, 8]);
        assert.equal(L.pushMessage(log, { id: 8, name: 'P8', text: 'again' }, 9), null, 'a resend of id 8');
        assert.equal(L.pushMessage(log, { name: 'X', text: '   ' }, 9), null, 'empty');
        const team = L.pushMessage(log, { name: 'Mate', text: 'left side', team: true }, 10);
        assert.ok(team.id < 0, 'a line without a server id gets a local one');
        assert.equal(log.list.length, 5);
        L.clearLog(log);
        assert.equal(log.list.length, 0);
    });

    test('fade: full for the hold, then out; open shows the history in full', () => {
        const F = L.CHAT_FADE_MS, O = L.CHAT_FADE_OUT_MS;
        assert.ok(F >= 20000 && F <= 30000, 'about 20-30 s');
        assert.equal(L.lineAlpha(0, false), 1);
        assert.equal(L.lineAlpha(F - 1, false), 1);
        assert.ok(Math.abs(L.lineAlpha(F + O / 2, false) - 0.5) < 1e-9);
        assert.equal(L.lineAlpha(F + O, false), 0);
        assert.equal(L.lineAlpha(F * 10, true), 1, 'typing: old lines come back');
        const log = L.createLog();
        L.pushMessage(log, { id: 1, name: 'Old', text: 'old' }, 0);
        L.pushMessage(log, { id: 2, name: 'New', text: 'new' }, F + O + 5000);
        const now = F + O + 6000;
        assert.deepStrictEqual(L.visibleLines(log, now, false).map(v => v.line.text), ['new']);
        assert.deepStrictEqual(L.visibleLines(log, now, true).map(v => v.line.text), ['old', 'new']);
    });

    test('visible: the last N, oldest first (newest at the bottom)', () => {
        const log = L.createLog();
        for (let i = 1; i <= 12; i++) L.pushMessage(log, { id: i, name: 'P', text: 't' + i }, 1000 + i);
        const v = L.visibleLines(log, 2000, false, L.CHAT_SHOW);
        assert.ok(L.CHAT_SHOW >= 6 && L.CHAT_SHOW <= 8);
        assert.equal(v.length, L.CHAT_SHOW);
        assert.equal(v[v.length - 1].line.text, 't12');
        assert.equal(v[0].line.text, 't' + (13 - L.CHAT_SHOW));
        assert.ok(L.CHAT_SHOW_TOUCH < L.CHAT_SHOW, 'fewer on a phone');
    });

    test('wrap: the first line starts after the name, the rest use the full width', () => {
        const out = L.wrapMessage('meet me at the vault right now', 50, 120, measure);
        assert.deepStrictEqual(out, ['meet me', 'at the vault', 'right now']);
        assert.ok(measure(out[0]) <= 70, 'first line fits beside the name');
        for (let i = 1; i < out.length; i++) assert.ok(measure(out[i]) <= 120, out[i]);
    });

    test('wrap: past the line limit ends in an ellipsis that fits', () => {
        const out = L.wrapMessage('one two three four five six seven eight nine ten eleven twelve', 0, 100, measure, 2);
        assert.equal(out.length, 2);
        assert.ok(out[1].endsWith('…'));
        assert.ok(measure(out[1]) <= 100);
    });

    test('wrap: a word wider than a line breaks by characters; short text is one line', () => {
        const out = L.wrapMessage('aaaaaaaaaaaaaaaaaaaaaaaaa', 0, 100, measure, 5);
        assert.deepStrictEqual(out, ['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa']);
        assert.deepStrictEqual(L.wrapMessage('gg', 60, 200, measure), ['gg']);
        // the name leaves no room on the first line: the text starts on the next
        const late = L.wrapMessage('hello', 195, 200, measure);
        assert.deepStrictEqual(late, ['', 'hello']);
    });

    test('names: long ones are cut with an ellipsis', () => {
        assert.equal(L.shortName('Ann'), 'Ann');
        const n = L.shortName('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        assert.equal(Array.from(n).length, L.NAME_MAX);
        assert.ok(n.endsWith('…'));
        assert.equal(L.shortName(''), 'Unnamed');
    });

    test('colour: bright body colours stay, dark ones lighten until readable, junk falls back', () => {
        assert.equal(L.readableColor('#3ca4cb'), '#3ca4cb', 'arras blue reads already');
        assert.equal(L.readableColor('#F14E54'), '#f14e54');
        const dark = L.readableColor('#1a1a40');
        assert.notEqual(dark, '#1a1a40');
        assert.ok(L.luminance(L.parseHex(dark)) >= L.MIN_LUM - 0.002, dark);
        assert.ok(L.luminance(L.parseHex(dark)) < 0.35, 'only as light as it has to be');
        const black = L.readableColor('#000');
        assert.ok(L.luminance(L.parseHex(black)) >= L.MIN_LUM - 0.002);
        assert.equal(L.readableColor(null, '#abcdef'), '#abcdef');
        assert.equal(L.readableColor('rgb(1,2,3)', '#abcdef'), '#abcdef');
        assert.equal(L.readableColor('11 0 1 0 false', 'X'), 'X', 'a compiled colour is resolved before this');
    });

    test('wiring: the overhead bubbles and their box are gone, the panel is in', () => {
        const app = read('public', 'client', 'app.js');
        for (const gone of ['drawChatMessages', 'flushChat', 'chatAvoidRebuild', 'drawChatInput', 'chatLayout', 'drawTeamChatFeed', 'ingameChatModeBtn'])
            assert.ok(!app.includes(gone), gone + ' removed');
        assert.ok(!fs.existsSync(path.join(REPO, 'public', 'client', 'chatLayout.js')));
        assert.match(app, /if \(chatPanelRect\) out\.push\(chatPanelRect\);/, 'a HUD avoid rect');
        assert.match(app, /drawRoyaleHUD\(\);\n\s+if \(!global\.died\) \{ try \{ drawChatPanel\(\); \}/);
        const si = read('public', 'client', 'socketinit.js');
        assert.ok(!si.includes('CHAT_MESSAGE_ENTITY'));
        assert.match(si, /case 'CH': \{/);
        assert.match(si, /pushChat\(chatLog, \{ sid: bid \|\| \(mine \? gui\.playerid : 0\), name, text, team: true, mine \}/, 'duo team lines join the panel');
        const cv = read('public', 'client', 'canvas.js');
        assert.match(cv, /this\.chatInput\.maxLength = 56;/);
        assert.match(cv, /else this\.socket\.talk\('M', text, 0\);/);
        const so = read('server', 'game', 'network', 'sockets.js');
        assert.ok(!so.includes('chatLoop') && !so.includes('CHAT_MESSAGE_ENTITY'), 'no 200 ms chat loop');
        assert.ok(!read('server', 'game', 'index.js').includes('chatLoop'));
        assert.match(read('server', 'game', 'entities', 'entity.js'), /require\('\.\.\/network\/raidChat\.js'\)\.send\(\{ body: this, text: message \}\)/, 'bots talk to the raid');
        assert.equal(L.CHAT_MAX_LEN, 56);
        // player-facing text: no em dashes
        const panel = app.slice(app.indexOf('function drawChatPanel()'), app.indexOf('window.dwChatPanel'));
        assert.ok(!panel.includes(String.fromCharCode(0x2014)));
    });

    let failed = 0;
    for (const [n, f] of tests) {
        try { f(); console.log('ok   ' + n); }
        catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
})();
