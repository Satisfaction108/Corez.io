// Upgrade grid paging, badge and Tier 5 HUD state: node scripts/test/upgradeGrid.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const REPO = path.join(__dirname, '..', '..');

(async () => {
    const G = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'upgradeGridLogic.js')).href);
    const B = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'buildButtonsLogic.js')).href);
    const tests = [];
    const test = (n, f) => tests.push([n, f]);

    test('pages: sizes, clamping, turning, keys pick from the page', () => {
        assert.equal(G.pageSize(false), 6); assert.equal(G.pageSize(true), 8);
        assert.deepStrictEqual(G.pageOf(5, 6, 0), { pages: 1, page: 0, start: 0, end: 5 });
        assert.deepStrictEqual(G.pageOf(12, 6, 1), { pages: 2, page: 1, start: 6, end: 12 });
        assert.deepStrictEqual(G.pageOf(12, 6, 9), { pages: 2, page: 1, start: 6, end: 12 });
        assert.deepStrictEqual(G.pageOf(11, 8, 1), { pages: 2, page: 1, start: 8, end: 11 });
        assert.equal(G.turn(1, 2, 1), 1, 'no wrap past the last page'); assert.equal(G.turn(0, 2, -1), 0, 'nor before the first'); assert.equal(G.turn(0, 2, 1), 1); assert.equal(G.turn(0, 1, 1), 0);
        assert.equal(G.keyPick(0, 12, 6, 1), 6); assert.equal(G.keyPick(5, 12, 6, 1), 11);
        assert.equal(G.keyPick(5, 9, 6, 1), -1, 'no 6th option on a short page');
        assert.equal(G.keyPick(2, 4, 6, 0), 2);
        assert.equal(G.optionsKey([[0, '', { index: 3 }], [0, '', { index: 9 }]]), '3,9,');
    });

    test('fit: desktop grid clears the stat bars, touch panel fits a phone', () => {
        // desktop (app.js drawAvailableUpgrades): spacing 20, topPad 46, 100-unit tiles
        const STAT_BAR_H = 19, STAT_BAR_GAP = 4;  // close to app.js
        // HUD units: a 16:9 screen is 1920x1080 at Normal whatever its pixels
        for (const H of [1080, 950, 810]) {
            const floor = H - 20 - 5.5 - STAT_BAR_H - 10 * (STAT_BAR_H + STAT_BAR_GAP) - 34 - 60;   // minus a kit box
            const rows = 2, gridTop = 20 + 5 + 46, gridBottom = gridTop + rows * 115 - 15;
            const bottom = gridBottom + 15 - 5 + 30 + 24 + 8.5;
            assert.ok(bottom < floor, `desktop ${H}: grid bottom ${bottom} vs floor ${floor}`);
        }
        // touch: HUD units are the long side at 1100 (util.getScreenRatio on mobile)
        for (const [w, h] of [[844, 390], [390, 844]]) {
            const k = 1100 / Math.max(w, h), W = w * k, Hh = h * k;
            const cols = G.COLS_TOUCH, len = 74, gap = 12, rows = Math.ceil(G.PAGE_TOUCH / cols), pagerH = 36;
            const pw = Math.max(cols * (len + gap) - gap + 32, 330), ph = 60 + rows * (len + gap) + 34 + pagerH;
            assert.ok(pw <= W - 16 && ph <= Hh - 40, `${w}x${h}: panel ${pw}x${ph} in ${W.toFixed(0)}x${Hh.toFixed(0)}`);
        }
    });

    test('t5: ring, gold and the 2x texts', () => {
        assert.equal(G.t5State(null), null);
        assert.equal(G.t5State({}), null);
        const r = G.t5State({ t5: [4, 0, 150, 200] });
        assert.ok(r.ring && !r.gold && !r.unlocked);
        assert.equal(r.progress, 0.5);
        assert.equal(G.ringTitle(r), 'Grow to 2x this life to unlock Tier 5');
        assert.equal(G.ringSub(r), "You're at 1.5x now, and your score makes you grow.");
        const g = G.t5State({ t5: [4, 1, 210, 200] });
        assert.ok(g.gold && !g.ring && g.progress === 1);
        const five = G.t5State({ t5: [5, 1, 230, 200] });
        assert.ok(!five.ring && !five.gold);
        assert.equal(G.ringTitle(G.t5State({ t5: [4, 0, 100, 150] })), 'Grow to 1.5x this life to unlock Tier 5');
        for (const s of [G.ringTitle(r), G.ringSub(r)]) assert.ok(!/[–—]/.test(s));
    });

    test('respawn as: a gated Tier 5 build names the Tier 4 parent', () => {
        assert.deepStrictEqual(B.respawnAs({ lt: 'Harmony', ltg: 200 }, 'Castanet'), { label: 'Respawn as Harmony', sub: 'Grow to 2x this life to unlock Tier 5' });
        assert.deepStrictEqual(B.respawnAs({ lt: 'Castanet' }, 'Castanet'), { label: 'Respawn as Castanet', sub: 'Same tank and stats' });
    });

    test('pager: +N more on the right, < +N more on the left, no wrap, fits under the grid', () => {
        const p0 = G.pageOf(10, 6, 0), p1 = G.pageOf(10, 6, 1);
        assert.equal(G.nextLabel(10, p0, 6), '+4 more  >', 'page 1: the 4 on page 2');
        assert.equal(G.prevLabel(10, p0, 6), '', 'page 1: nothing to the left');
        assert.equal(G.nextLabel(10, p1, 6), '', 'last page: nothing to the right');
        assert.equal(G.prevLabel(10, p1, 6), '<  +6 more', 'last page: back to the 6');
        const m = G.pageOf(15, 6, 1);
        assert.equal(G.prevLabel(15, m, 6), '<  +6 more'); assert.equal(G.nextLabel(15, m, 6), '+3 more  >', 'middle page: both');
        assert.equal(G.nextLabel(5, G.pageOf(5, 6, 0), 6), '', 'one page: no pager');
        assert.equal(G.pagerPulse(new Set([0]), 2), true, 'page 2 not seen yet');
        assert.equal(G.pagerPulse(new Set([0, 1]), 2), false, 'both seen');
        const w = (t, s) => t.length * s * 0.62;
        for (const [mobile, gridW] of [[false, 3 * 100 + 2 * 15], [true, 4 * 74 + 3 * 12]]) {
            const A = G.pagerLayout(500, 300, 2, '', '+4 more  >', w, mobile);
            assert.equal(A.prev, null, 'no left button on page 1');
            assert.ok(A.next && A.dots.x + A.dots.w < A.next.x, 'dots then next');
            const Z = G.pagerLayout(500, 300, 2, '<  +6 more', '', w, mobile);
            assert.equal(Z.next, null, 'no right button on the last page');
            assert.ok(Z.prev && Z.prev.x + Z.prev.w < Z.dots.x, 'prev then dots');
            const M = G.pagerLayout(500, 300, 3, '<  +6 more', '+3 more  >', w, mobile);
            assert.ok(M.w <= gridW + 40, (mobile ? 'touch' : 'desktop') + ' pager ' + M.w + ' fits near the grid ' + gridW);
            assert.ok(Math.abs(M.prev.x + M.w / 2 - 500) < 1e-9, 'centred');
            if (mobile) assert.ok(M.h >= 30, 'thumb-sized on touch');
        }
    });

    test('badge: RAMS ROCK under the name, inside the band and the tile, off the tank', () => {
        const w = (s) => 'RAMS ROCK'.length * s * 0.62;
        for (const len of [100, 74, 60]) for (const down of [0, 2 * len / 100]) {
            const k = len / 100, b = G.ramBadge(len, len, w, down), t = G.tankBox(len, len);
            const faceH = len - 4 * k, bandTop = down + faceH * 0.75, bandBottom = down + faceH;
            assert.ok(b.y >= bandTop && b.y + b.h <= bandBottom, len + ': the chip sits in the name band');
            assert.ok(b.y + b.h <= len, len + ': wholly inside the tile (the bitmap cut it in half)');
            assert.ok(b.nameMid > bandTop && b.nameMid + b.nameMax / 2 <= b.y + 1e-9, len + ': the name sits over the chip');
            assert.ok(b.y > t.cy + t.size / 2, len + ': clear of the tank box');
            assert.ok(Math.abs(b.x + b.w / 2 - len / 2) < 1e-9, 'centred');
            assert.ok(b.w < len * 0.8, len + ': a chip, not a bar');
        }
        const t = G.tankBox(100, 100);
        assert.ok(t.size > 55, 'the tank is bigger than the old 55% of the tile: ' + t.size);
        assert.ok(t.cy - t.size / 2 >= 0 && t.cy + t.size / 2 <= 96 * 0.75 + 5, 'and stays in the face above the band');
        assert.equal(G.isRamMockup({ guns: [] }), true);
        assert.equal(G.isRamMockup({ guns: [{}], statnames: { reload: 'Engine Acceleration' } }), true, 'thrusters + smasher set');
        assert.equal(G.isRamMockup({ guns: [{}], statnames: { reload: 'Reload' } }), false);
        assert.equal(G.isRamMockup(null), false);
        assert.equal(G.isRamMockup({ guns: [], turrets: [{ guns: [{}] }] }), false, 'Architect: launchers on its turrets, it shoots');
        assert.equal(G.isRamMockup({ guns: [], turrets: [{ guns: [] }] }), true, 'Smasher: a spiked body turret, no guns');
    });

    let failed = 0;
    for (const [n, f] of tests) {
        try { f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + e.message); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
