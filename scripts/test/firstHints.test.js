'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const REPO = path.join(__dirname, '..', '..');

(async () => {
    const L = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'firstHintsLogic.js')).href);
    const tests = [];
    const test = (n, f) => tests.push([n, f]);
    const run = (s, from, to, ctx) => { let r = null; for (let t = from; t <= to; t += 100) r = L.step(s, t, ctx); return r; };
    const vis = (...ids) => ({ visible: new Set(ids) });

    test('storage key is new and versioned, so every player sees the hints once', () => {
        assert.equal(L.KEY, 'dwSeenHints_v2');
        assert.deepStrictEqual([...L.parseSeen(null)], []);
        assert.deepStrictEqual([...L.parseSeen('not json')], []);
        assert.deepStrictEqual([...L.parseSeen('["vault","bogus","shop"]')].sort(), ['shop', 'vault']);
        assert.deepStrictEqual([...L.parseSeen('{"shard":1,"vault":0}')], ['shard']);
        assert.equal(L.serializeSeen(new Set(['vault', 'shard', 'nope'])), '["shard","vault"]');
    });

    test('one at a time, in the order they were noticed, each once', () => {
        const s = L.createState();
        assert.ok(L.notice(s, 'vault'));
        assert.ok(L.notice(s, 'shop'));
        assert.ok(!L.notice(s, 'vault'), 'no duplicates in the queue');
        assert.ok(!L.notice(s, 'nothing'), 'unknown ids are ignored');
        let r = L.step(s, 1000, vis('vault', 'shop'));
        assert.equal(r.show, 'vault');
        assert.equal(r.started, 'vault');
        assert.ok(s.seen.has('vault'), 'seen as soon as it shows');
        r = run(s, 1100, 1000 + L.SHOW_MS - 200, vis('vault', 'shop'));
        assert.equal(r.show, 'vault', 'only one card on screen');
        r = run(s, 1000 + L.SHOW_MS - 100, 1000 + L.SHOW_MS + 100, vis('vault', 'shop'));
        assert.equal(r.show, null, 'the first one times out');
        r = run(s, 1000 + L.SHOW_MS + 200, 1000 + L.SHOW_MS + L.GAP_MS - 100, vis('vault', 'shop'));
        assert.equal(r.show, null, 'a short gap before the next');
        r = run(s, 1000 + L.SHOW_MS + L.GAP_MS + 200, 1000 + L.SHOW_MS + L.GAP_MS + 400, vis('vault', 'shop'));
        assert.equal(r.show, 'shop');
        assert.ok(!L.notice(s, 'vault'), 'a seen hint never queues again');
    });

    test('shows for about 7 seconds, between 6 and 8', () => {
        assert.ok(L.SHOW_MS >= 6000 && L.SHOW_MS <= 8000);
    });

    test('closing with X or reaching the thing ends it at once', () => {
        const s = L.createState();
        L.notice(s, 'vault'); L.notice(s, 'shop');
        L.step(s, 0, vis('vault', 'shop'));
        assert.equal(s.cur, 'vault');
        assert.ok(L.dismiss(s, 'vault', 500));
        assert.equal(s.cur, null);
        let r = run(s, 600, 600 + L.GAP_MS + 300, vis('vault', 'shop'));
        assert.equal(r.show, 'shop');
        r = L.step(s, 2500, { visible: new Set(['shop']), reached: new Set(['shop']) });
        assert.equal(r.show, null);
        assert.equal(r.why, 'reached');
        assert.ok(s.seen.has('shop'));
    });

    test('a queued hint waits until its thing is on screen again', () => {
        const s = L.createState();
        L.notice(s, 'shard');
        let r = L.step(s, 0, vis());
        assert.equal(r.show, null);
        assert.ok(s.queue.includes('shard'));
        assert.ok(!s.seen.has('shard'), 'not used up while it was off screen');
        r = L.step(s, 100, vis('shard'));
        assert.equal(r.show, 'shard');
    });

    test('a hint you are standing on never starts', () => {
        const s = L.createState();
        L.notice(s, 'vault');
        const r = L.step(s, 0, { visible: new Set(['vault']), reached: new Set(['vault']) });
        assert.equal(r.show, null);
        assert.ok(!s.seen.has('vault'));
    });

    test('a big card or no room holds the hint and its clock', () => {
        const s = L.createState();
        L.notice(s, 'core');
        L.step(s, 0, vis('core'));
        run(s, 100, 3000, vis('core'));
        const before = s.shownMs;
        let r = run(s, 3100, 9000, { visible: new Set(['core']), blocked: true });
        assert.equal(r.show, null);
        assert.equal(r.held, 'core');
        assert.equal(s.shownMs, before, 'the clock does not run while it is hidden');
        r = L.step(s, 9100, vis('core'));
        assert.equal(r.show, 'core', 'it comes back afterwards');
    });

    test('placement: right of centre, clear of the HUD, never over the middle', () => {
        const W = 1280, H = 800;
        const r = L.place(W, H, 300, 110, []);
        assert.ok(r, 'room on an empty screen');
        assert.ok(r.x >= W / 2 + 40, 'starts right of centre');
        assert.ok(r.x + r.w <= W - 12 && r.y + r.h <= H - 12);
        const tankBox = { x: W / 2 - 40, y: H / 2 - 40, w: 80, h: 80 };
        assert.ok(!(r.x < tankBox.x + tankBox.w && r.x + r.w > tankBox.x && r.y < tankBox.y + tankBox.h && r.y + r.h > tankBox.y), 'clear of your tank');
        const minimap = { x: W - 252, y: H - 262, w: 252, h: 262 };
        const perk = { x: r.x - 20, y: r.y - 20, w: 400, h: 200 };
        const r2 = L.place(W, H, 300, 110, [minimap, perk]);
        assert.ok(r2, 'finds another spot');
        for (const a of [minimap, perk]) assert.ok(!(r2.x < a.x + a.w && r2.x + r2.w > a.x && r2.y < a.y + a.h && r2.y + r2.h > a.y), 'no overlap');
        const full = L.place(W, H, 300, 110, [{ x: W / 2, y: 0, w: W / 2, h: H }]);
        assert.equal(full, null, 'no room: wait rather than cover the HUD');
    });

    test('hint copy is neat and human (no em or en dashes, proper sentences)', () => {
        const ids = Object.keys(L.HINTS).sort();
        assert.deepStrictEqual(ids, ['core', 'shard', 'shop', 'vault']);
        for (const id of ids) {
            const h = L.HINTS[id];
            for (const txt of [h.title, h.body]) {
                assert.ok(!/[–—]/.test(txt), id + ' has a dash');
                assert.ok(/^[A-Z]/.test(txt), id + ' starts with a capital');
            }
            assert.ok(/[.!]$/.test(h.body), id + ' body ends a sentence');
            assert.ok(h.body.length < 160, id + ' body is short');
        }
        assert.ok(/spiky/i.test(L.HINTS.shard.body) && /Core shard/.test(L.HINTS.shard.body));
        assert.ok(/bank/i.test(L.HINTS.vault.body) && /die/.test(L.HINTS.vault.body));
        assert.ok(/banked gems/i.test(L.HINTS.shop.body));
    });

    test('the client wires it in: frame hook, avoid rect, storage wrapped in try', () => {
        const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');
        assert.ok(app.includes("import * as firstHints from './firstHints.js'"));
        assert.ok(/firstHints\.hook\(hudAvoidRects\)/.test(app));
        assert.ok(/global\.hintRect\) out\.push\(global\.hintRect\)/.test(app));
        const src = fs.readFileSync(path.join(REPO, 'public', 'client', 'firstHints.js'), 'utf8');
        assert.ok(/try \{ return L\.parseSeen\(localStorage\.getItem/.test(src));
        assert.ok(/try \{ localStorage\.setItem\(L\.KEY/.test(src));
        assert.ok(!/\/\/|\/\*/.test(src.replace(/https?:\/\/[^\s"']+/g, '')), 'no comments');
    });

    let failed = 0;
    for (const [n, f] of tests) {
        try { await f(); console.log('ok   ' + n); }
        catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
