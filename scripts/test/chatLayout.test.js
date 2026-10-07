// Chat bubble wrap + layout (public/client/chatLayout.js)
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const REPO = path.join(__dirname, '..', '..');

(async () => {
    const L = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'chatLayout.js')).href);
    const tests = [];
    const test = (n, f) => tests.push([n, f]);
    const measure = (s) => s.length * 10;   // 10 px a character
    const box = (it) => ({ x: it.x + (it.dx || 0) - it.w / 2, y: it.y + it.dy - it.h, w: it.w, h: it.h });
    const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const item = (id, x, y, w = 120, h = 40) => ({ id, x, y, w, h, dx: 0, dy: 0, hide: false });

    test('wrap: words fill lines up to the width, never past it', () => {
        const out = L.wrapText('gg that was a close one my friend', 100, measure, 5, []);
        assert.deepStrictEqual(out, ['gg that', 'was a', 'close one', 'my friend']);
        for (const l of out) assert.ok(measure(l) <= 100, l);
    });
    test('wrap: too many lines end in an ellipsis that fits', () => {
        const out = L.wrapText('one two three four five six seven eight nine ten', 100, measure, 2, []);
        assert.equal(out.length, 2);
        assert.ok(out[1].endsWith('…'));
        assert.ok(measure(out[1]) <= 100);
    });
    test('wrap: a word wider than a line is broken by characters', () => {
        const out = L.wrapText('aaaaaaaaaaaaaaaaaaaaaaaaa', 100, measure, 5, []);
        assert.deepStrictEqual(out, ['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa']);
    });
    test('wrap: spaces collapse, empty text gives no lines', () => {
        assert.deepStrictEqual(L.wrapText('  hi    there  ', 200, measure, 3, []), ['hi there']);
        assert.deepStrictEqual(L.wrapText('', 200, measure, 3, []), []);
    });
    test('layout: bubbles of tanks side by side stack, none overlaps', () => {
        const items = [item(1, 500, 400), item(2, 540, 405), item(3, 470, 398), item(4, 900, 400)];
        L.layoutChat(items, items.length, null, { gap: 4, maxShift: 1000 });
        for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
            if (items[i].hide || items[j].hide) continue;
            assert.ok(!hit(box(items[i]), box(items[j])), items[i].id + ' vs ' + items[j].id);
        }
        // the far one keeps its spot, the lowest of the pile keeps its spot
        assert.equal(items.find(i => i.id === 4).dy, 0);
        assert.equal(items.find(i => i.id === 2).dy, 0);
        for (const it of items) assert.ok(it.dy <= 0);
    });
    test('layout: your own bubble keeps its spot; a neighbour steps aside when that is shorter than up', () => {
        const me = Object.assign(item(1, 500, 300), { pri: 0 });
        const them = Object.assign(item(2, 600, 330, 120, 80), { pri: 1 });   // lower, overlaps my right edge by 20
        const items = [them, me];
        L.layoutChat(items, 2, null, { gap: 4 });
        assert.equal(me.dx, 0); assert.equal(me.dy, 0);
        assert.equal(them.dy, 0);
        assert.equal(them.dx, 24);
        assert.ok(!hit(box(me), box(them)));
    });
    test('layout: stable order for two tanks at one height', () => {
        const a = [item(7, 500, 400), item(3, 500, 400)];
        L.layoutChat(a, 2, null, {});
        assert.equal(a.find(i => i.id === 3).dy, 0);
        const b = [item(3, 500, 400), item(7, 500, 400)];
        L.layoutChat(b, 2, null, {});
        assert.equal(b.find(i => i.id === 3).dy, 0);
    });
    test('layout: a bubble under a HUD rect steps over it, or stays put over the HUD when that is too far', () => {
        const slam = { x: 300, y: 330, w: 400, h: 60 };
        const near = item(1, 500, 400);           // top 360: under the rect by 30
        L.layoutChat([near], 1, [slam], { gap: 4, maxShift: 200 });
        assert.ok(!near.hide);
        assert.ok(!hit(box(near), slam));
        const wide = { x: 0, y: 100, w: 1000, h: 600 };   // no room: it stays on its tank
        const stay = item(2, 500, 400);
        L.layoutChat([stay], 1, [wide], { gap: 4 });
        assert.ok(!stay.hide, 'chat never vanishes behind the HUD');
        assert.equal(stay.dy, 0);
        const card = { x: 0, y: 100, w: 1000, h: 600, hard: true };   // a centre card hides it
        const under = item(3, 500, 400);
        L.layoutChat([under], 1, [card], { gap: 4 });
        assert.ok(under.hide);
        assert.equal(under.dy, 0);
        const mine = Object.assign(item(4, 500, 400), { self: true });
        L.layoutChat([mine], 1, [slam], { gap: 4 });
        assert.ok(!mine.hide && mine.dy === 0, 'your own bubble stays on your tank');
    });
    test('layout: a big tank\'s bubble is pulled onto the screen, not hidden', () => {
        const top = item(1, 500, 30);             // top edge at -10
        L.layoutChat([top], 1, [{ x: 0, y: 0, w: 1000, h: 20 }], { top: 0, maxShift: 500 });
        assert.ok(!top.hide);
        assert.equal(top.y - top.h + top.dy, 0);
    });
    test('size: grows with the tank, never under the base or past 2.2x it, 2 px steps', () => {
        assert.equal(L.chatSizeFor(16, 20), 16, 'a small tank still gets readable text');
        assert.equal(L.chatSizeFor(16, 60), 30, 'half the tank on screen');
        assert.equal(L.chatSizeFor(16, 400), 36, 'capped at 2.2x the base (35.2, to 2 px)');
        assert.ok(L.chatSizeFor(16, 61) % 2 === 0);
        assert.ok(L.chatSizeFor(16, 80) > L.chatSizeFor(16, 50), 'a bigger tank, bigger chat');
    });
    test('layout: only the first n items are laid out (pooled array)', () => {
        const items = [item(1, 500, 400), item(2, 500, 400)];
        items[1].dy = 123;
        L.layoutChat(items, 1, null, {});
        assert.equal(items[1].dy, 123);
    });

    test('stack: up to 3 bubbles a tank (2 on a phone), older ones fade', () => {
        assert.equal(L.chatStackMax(false), 3);
        assert.equal(L.chatStackMax(true), 2);
        assert.equal(L.CHAT_LINES, 2);
        assert.equal(L.bubbleFade(0), 1);
        assert.ok(L.bubbleFade(1) < 1 && L.bubbleFade(2) < L.bubbleFade(1) && L.bubbleFade(2) > 0.4);
    });
    test('app.js: one bubble per message, no name header, your own stack is not cut to one', () => {
        const fs = require('fs');
        const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
        const fn = app.slice(app.indexOf('function drawChatMessages('), app.indexOf('function drawHealth('));
        assert.ok(fn.includes('chatStackMax(global.mobile)'));
        assert.ok(!fn.includes('nameSpr = chatBake') && !fn.includes('it.nameSpr'), 'no name inside the bubble');
        assert.ok(!/self && count >= 1/.test(fn), 'your own messages stack too');
        assert.ok(fn.includes('bubbleFade(count)'));
    });

    let fail = 0;
    for (const [n, f] of tests) {
        try { f(); console.log('ok  ', n); } catch (e) { fail++; console.log('FAIL', n, '\n   ', e.message); }
    }
    console.log(fail ? fail + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(fail ? 1 : 0);
})();
