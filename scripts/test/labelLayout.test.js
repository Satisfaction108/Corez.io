// World label de-overlap (public/client/labelLayout.js): node scripts/test/labelLayout.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const REPO = path.join(__dirname, '..', '..');

(async () => {
    const L = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'labelLayout.js')).href);
    const tests = [];
    const test = (n, f) => tests.push([n, f]);
    const lab = (x, y, pri = 2, d = 0, w = 100, h = 20) => ({ x, y, w, h, pri, d });
    const box = (it) => ({ x: it.x - it.w / 2, y: it.y + it.dy - it.h / 2, w: it.w, h: it.h });
    const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    test('two labels on one spot: the higher priority keeps it, the other moves a row up', () => {
        const crate = lab(500, 300, 1), epic = lab(510, 300, 2);
        const items = [epic, crate], placed = [];
        L.layoutLabels(items, null, placed);
        assert.equal(crate.dy, 0);
        assert.equal(epic.dy, -(epic.h + L.NUDGE_GAP));
        assert.ok(!hit(box(crate), box(epic)));
        assert.equal(placed.length, 2);
    });
    test('a pile of labels never overlaps; a label under a HUD rect steps out from under it', () => {
        const items = [lab(400, 200, 0), lab(405, 205, 1), lab(395, 198, 2, 10), lab(402, 202, 3)];
        L.layoutLabels(items, null, []);
        for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) assert.ok(!hit(box(items[i]), box(items[j])), i + ' vs ' + j);
        // the Epic chest label would go up under the objective card: it goes below the crate's
        const hud = [{ x: 300, y: 0, w: 400, h: 108 }];
        const crate = lab(500, 120, 1), epic = lab(500, 118, 2);
        L.layoutLabels([epic, crate], hud, []);
        assert.ok(epic.dy > 0 && !hit(box(epic), hud[0]) && !hit(box(epic), box(crate)), 'below, clear of the card: ' + epic.dy);
        // alone under the card it stays (labelAlpha fades it there)
        const lone = lab(500, 60, 2);
        L.layoutLabels([lone], hud, []);
        assert.equal(lone.dy, 0);
    });
    test('nudges are capped: with every row taken it stays put, marked blocked', () => {
        const items = [];
        for (let k = 0; k < 1 + L.MAX_NUDGE * 2; k++) items.push(lab(300, 300, 0, k));
        const extra = lab(300, 300, 5);
        items.push(extra);
        L.layoutLabels(items, null, []);
        assert.equal(extra.blocked, true);
        assert.equal(extra.dy, 0);
        assert.ok(items.slice(0, -1).every(i => !i.blocked));
    });
    test('the arrays are reused, and app.js routes the world labels through it', () => {
        const placed = [1, 2, 3, 4, 5, 6];
        const n = L.layoutLabels([lab(0, 0)], null, placed);
        assert.equal(n, 1); assert.equal(placed.length, 1);
        const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
        assert.ok(app.includes("import { layoutLabels } from './labelLayout.js';"));
        assert.ok(/drawOutpostLabels\(px, py, ratio\);\s*flushWorldLabels\(\);/.test(app), 'flushed after the world draws');
        assert.ok(app.includes('worldLabel(c, CHEST_LABEL[k]'), 'chest and crate labels');
        assert.ok(app.includes('worldLabel(c, "Vault"') && app.includes('worldLabel(c, sl, sx, sy - R * 1.4'), 'pad labels');
        // one label per pad (the shop's name used to sit under it as well), fading by distance
        assert.ok(!app.includes('String(s.name || "").replace(" Shop", "")'), 'no second shop label');
        assert.ok(app.includes('labelAlpha(it.x, ly, it.w, it.h) * labelNear(it.x, ly)'), 'labels fade toward the edges');
        assert.ok(!app.includes('drawSpawnShieldHint'), 'the shield line left the tank');
        assert.ok(app.includes('try { push(spawnShieldNote()); }'), 'and is a note under the clock');
    });

    let ok = 0;
    for (const [n, f] of tests) {
        try { f(); ok++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n    ' + (e && e.stack || e)); }
    }
    console.log(ok === tests.length ? 'all ' + ok + ' passed' : (tests.length - ok) + ' failed');
    process.exit(ok === tests.length ? 0 : 1);
})();
