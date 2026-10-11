'use strict';
const assert = require('assert');
const H = require('./headlessGame.js');
const { sleep } = H;

const why = H.available();
if (why) { console.log('skipped: ' + why); process.exit(0); }

const RECORD = `(() => {
    const R = window.__pt = { on: true, f: [], c: [] };
    const s = window.royaleState().socket;
    if (!s.__ptWatched) {
        const talk = s.talk;
        s.talk = (...m) => { if (m[0] === 'C' && R.on) R.c.push(m.length - 1); return talk.apply(s, m); };
        s.__ptWatched = true;
    }
    const loop = () => {
        if (!R.on) return;
        requestAnimationFrame(loop);
        const g = window.global;
        if (!g || !g.player) return;
        R.f.push([performance.now(), g.player.cx.animX, g.player.cy.animY, g.player.cx.x, g.player.cy.y, g.player.predOn ? 1 : 0]);
    };
    requestAnimationFrame(loop);
    return true;
})()`;

const WALL = `(() => {
    const P = window.dwPredict, tr = window.terrainRenderer, g = window.global;
    const x = g.player.cx.x, y = g.player.cy.y;
    const dirs = [['d', 1, 0], ['a', -1, 0], ['s', 0, 1], ['w', 0, -1]];
    let best = null;
    for (const [k, dx, dy] of dirs) for (let d = 60; d < 1400; d += 20) if (P.pointInRock(tr, x + dx * d, y + dy * d)) { if (!best || d < best.d) best = { k, d }; break; }
    return best;
})()`;

const KEYS = { d: ['d', 'KeyD', 68], a: ['a', 'KeyA', 65], w: ['w', 'KeyW', 87], s: ['s', 'KeyS', 83] };
const DIR = { d: [1, 0], a: [-1, 0], w: [0, -1], s: [0, 1] };
const kd = (page, k) => page.keyDown(...KEYS[k]);
const ku = (page, k) => page.keyUp(...KEYS[k]);

function settle(f, tUp, ms, dir) {
    const win = f.filter(r => r[0] >= tUp && r[0] <= tUp + ms);
    assert.ok(win.length > 10, 'frames after the release: ' + win.length);
    const last = win[win.length - 1];
    let over = 0, back = 0;
    for (let i = 1; i < win.length; i++) {
        const p = (win[i][1] - last[3]) * dir[0] + (win[i][2] - last[4]) * dir[1];
        if (p > over) over = p;
        const st = (win[i][1] - win[i - 1][1]) * dir[0] + (win[i][2] - win[i - 1][2]) * dir[1];
        if (st < 0) back -= st;
    }
    return { over, back, end: last };
}

(async () => {
    const t0 = Date.now();
    const { page, origin, stop } = await H.start({ port: 4760, env: { ROYALE_FILL_CAP: '2' } });
    let results = [];
    try {
        await H.play(page, origin);
        await page.eval('window.royaleState().canvas.cv.focus(), true').catch(() => {});
        await page.move(900, 320);
        await sleep(6000);
        for (const k of ['w', 's']) { await kd(page, k); await sleep(60); await ku(page, k); await sleep(900); }
        let on = false;
        for (let i = 0; i < 60 && !on; i++) { await sleep(250); on = await page.eval('!!(window.dwPredict && window.dwPredict.active())'); }
        await sleep(800);
        results = await H.runChecks([
            ['the server turns prediction on and acks inputs', async () => {
                assert.ok(on, 'predictor never anchored: ' + JSON.stringify(await page.eval('window.dwPredict && window.dwPredict.stats()')));
                await page.eval(RECORD);
                await sleep(600);
                const c = await page.eval('window.__pt.c.slice()');
                assert.ok(c.length >= 10, 'C packets per tick: ' + c.length);
                assert.ok(c.every(n => n === 6), 'every C packet carries the input seq: ' + JSON.stringify(c.slice(0, 12)));
                return c.length + ' C packets in 0.6 s';
            }],
            ['tap D: no phantom move after the key-up', async () => {
                await page.eval('window.__pt.f.length = 0, true');
                const before = await page.eval('[window.global.player.cx.x, window.global.player.cy.y]');
                const tDown = await page.eval('performance.now()');
                await kd(page, 'd');
                await sleep(60);
                await ku(page, 'd');
                const tUp = await page.eval('performance.now()');
                await sleep(1400);
                const f = await page.eval('window.__pt.f.slice()');
                assert.ok(f.filter(r => r[0] > tDown).every(r => r[5] === 1), 'prediction stayed on through the tap');
                const r = settle(f, tUp, 1300, DIR.d);
                const moved = r.end[3] - before[0];
                assert.ok(moved > 1, 'the server moved the tank for the tap: ' + moved.toFixed(2));
                assert.ok(r.over < 1.5, 'predicted motion past where the server stopped: ' + r.over.toFixed(2));
                assert.ok(r.back < 1.5, 'pulled back after the release: ' + r.back.toFixed(2));
                assert.ok(Math.abs(r.end[1] - r.end[3]) < 0.5 && Math.abs(r.end[2] - r.end[4]) < 0.5, 'rests where the server rests');
                return 'moved ' + moved.toFixed(1) + ', past the stop ' + r.over.toFixed(2) + ', back ' + r.back.toFixed(2);
            }],
            ['drive into a rock wall and slide along it', async () => {
                const w = await page.eval(WALL);
                assert.ok(w, 'no rock near the spawn');
                const s0 = await page.eval('window.dwPredict.stats()');
                await page.eval('window.__pt.f.length = 0, true');
                const perp = w.k === 'd' || w.k === 'a' ? 'w' : 'd';
                await kd(page, w.k);
                await sleep(Math.min(2600, 500 + w.d * 6));
                await kd(page, perp);
                await sleep(1200);
                await ku(page, perp);
                await ku(page, w.k);
                const tUp = await page.eval('performance.now()');
                await sleep(1300);
                const s1 = await page.eval('window.dwPredict.stats()');
                const f = await page.eval('window.__pt.f.slice()');
                const inRock = await page.eval(`(() => { const P = window.dwPredict, tr = window.terrainRenderer; let n = 0; for (const r of window.__pt.f) if (P.pointInRock(tr, r[1], r[2])) n++; return n; })()`);
                const n = s1.errN - s0.errN;
                const errAvg = n ? (s1.errSum - s0.errSum) / n : 0;
                assert.equal(s1.fallbacks, 0, 'fell back: ' + s1.why);
                assert.ok(f.every(r => r[5] === 1), 'prediction stayed on');
                assert.equal(inRock, 0, 'the predicted tank went into the rock');
                assert.ok(errAvg < 1.5, 'average reconcile error at the wall: ' + errAvg.toFixed(2));
                const dir = [DIR[w.k][0] + DIR[perp][0], DIR[w.k][1] + DIR[perp][1]];
                const L = Math.hypot(dir[0], dir[1]);
                const r = settle(f, tUp, 1200, [dir[0] / L, dir[1] / L]);
                assert.ok(r.over < 2, 'motion past the stop after the slide: ' + r.over.toFixed(2));
                const slid = Math.abs((r.end[3] - f[0][3]) * DIR[perp][0] + (r.end[4] - f[0][4]) * DIR[perp][1]);
                assert.ok(slid > 20, 'slid along the wall: ' + slid.toFixed(1));
                return 'wall ' + w.k + ' at ' + w.d + ', reconcile err avg ' + errAvg.toFixed(2) + ' max ' + (s1.errMax || 0).toFixed(1) + ', slid ' + slid.toFixed(0);
            }],
            ['the dwPredict kill switch drops back to the old path', async () => {
                await page.eval(`localStorage.setItem('dwPredict', '0'), true`);
                await sleep(1500);
                await page.eval('window.__pt.c.length = 0, true');
                await sleep(500);
                const st = await page.eval('({ sending: window.dwPredict.sending(), c: window.__pt.c.slice() })');
                assert.equal(st.sending, false);
                assert.ok(st.c.length > 3 && st.c.every(n => n === 4 || n === 5), 'old command packets: ' + JSON.stringify(st.c.slice(0, 8)));
                await page.eval(`localStorage.removeItem('dwPredict'), true`);
                let back = false;
                for (let i = 0; i < 20 && !back; i++) { await sleep(250); back = await page.eval('window.dwPredict.active()'); }
                assert.ok(back, 'prediction came back when the switch was cleared');
            }],
            ['no page errors', async () => {
                const errs = page.errors.filter(e => !/favicon|net::ERR|Failed to load resource/.test(e));
                assert.deepEqual(errs, []);
            }],
        ]);
    } catch (e) {
        console.log('FAIL setup\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
        results.push(false);
    } finally {
        await page.eval('window.__pt && (window.__pt.on = false), true').catch(() => {});
        await stop();
    }
    const failed = results.filter(r => !r).length;
    console.log(`${results.length - failed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    process.exit(failed ? 1 : 0);
})();
