// Automatic low-end trim: node scripts/test/autoQuality.test.js
//
//   start     weak devices start rungs down: few cores or little memory,
//             software WebGL, phones, sharp panels on mid chips; a strong
//             desktop starts at full quality
//   down      sustained slow frames (or a run of hitches) step down one rung,
//             never two inside the cooldown; tab stalls are not slow frames;
//             the 30 fps cap only when a frame's work fits inside 33 ms
//   up        a long smooth stretch steps back up, the 30 fps cap only comes
//             off with room to spare, and a step down right after a step up
//             holds the ladder down
//   skip      rungs the player set themselves are never switched, either way
//   capped    a steady 30 fps under the cap is not lag
//   pinned    nor is a steady 30 with cheap frames and no cap (battery saver)
//   wiring    loadSettings puts the rungs on top of the player's choices,
//             frames feed the ladder, resolution waits its turn, glitches
//             stay on (rarer) under the trim
'use strict';

const emit = process.emitWarning;
process.emitWarning = (w, ...a) => { if (!/MODULE_TYPELESS|module syntax/.test(String(w) + a.join(' '))) emit.call(process, w, ...a); };

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const CLIENT = path.join(__dirname, '../../public/client');

// run frames of dt ms from t until `until`, return [now, steps]
function run(L, t, until, dt, opts = {}) {
    const steps = [];
    while (t < until) {
        t += dt;
        const s = L.frame(t, dt, opts.work != null ? opts.work : dt * 0.5, !!opts.capped);
        if (s) steps.push([Math.round(t), s, L.rung]);
    }
    return [t, steps];
}

(async () => {
    const Q = await import(pathToFileURL(path.join(CLIENT, 'autoQualityLogic.js')).href);
    const { Ladder, startRung, RUNGS, TUNE } = Q;

    // start
    assert.equal(startRung({ cores: 12, memory: 8, dpr: 2 }), 0, 'strong desktop: full quality');
    assert.equal(startRung({}), 0, 'nothing known: full quality');
    assert.equal(startRung({ cores: 4, memory: 8 }), 2, 'four cores');
    assert.equal(startRung({ cores: 8, memory: 4 }), 2, '4 GB');
    assert.equal(startRung({ cores: 8, softGl: true }), 3, 'software WebGL');
    assert.equal(startRung({ cores: 2 }), 3, 'two cores');
    assert.equal(startRung({ cores: 8, memory: 8, mobile: true }), 1, 'phone');
    assert.equal(startRung({ cores: 6, memory: 8, dpr: 3 }), 1, 'sharp panel, mid chip');

    // down: 30 ms frames step one rung after SLOW_FOR, then wait out the cooldown
    {
        const L = new Ladder(0);
        let [t, steps] = run(L, 0, TUNE.SLOW_FOR - 500, 30);
        assert.equal(steps.length, 0, 'not before SLOW_FOR');
        [t, steps] = run(L, t, TUNE.SLOW_FOR + 1200, 30);
        assert.equal(steps.length, 1, 'one step');
        assert.equal(L.rung, 1);
        assert.ok(L.on('fxLow') && !L.on('fewerFx'), 'Effects Low first');
        const at = steps[0][0];
        [t, steps] = run(L, t, at + TUNE.COOLDOWN + TUNE.SLOW_FOR - 200, 30);
        assert.equal(steps.length, 0, 'cooldown and a fresh slow stretch before the next');
        [t, steps] = run(L, t, t + 30000, 30);
        assert.deepEqual(steps.map(s => s[2]), [2, 3, 4], 'then one rung at a time to the end');
        assert.ok(L.exhausted(), 'resolution is next');
        [t, steps] = run(L, t, t + 10000, 30);
        assert.equal(steps.length, 0, 'nothing past the last rung');
    }
    // the cap can't help frames that take longer than 33 ms to draw: resolution's turn
    {
        const L = new Ladder(3);
        run(L, 0, 20000, 45, { work: 40 });
        assert.equal(L.rung, 3, 'no cap on 40 ms frames');
        assert.ok(L.exhausted(), 'resolution next');
        const M = new Ladder(3);
        run(M, 0, TUNE.SLOW_FOR + 1200, 30, { work: 20 });
        assert.equal(M.rung, 4, 'cap on 20 ms of work running at 30 ms');
    }
    // a run of hitches is lag even when the average is fine
    {
        const L = new Ladder(0);
        let t = 0, step = 0;
        for (let i = 0; i < 400 && !step; i++) {
            const dt = i % 12 === 0 ? 70 : 14;
            t += dt;
            step = L.frame(t, dt, 6);
        }
        assert.equal(step, 1, 'hitches step down');
    }
    // sustained-dip rule: a short dip, one GC burst or a tab refocus never
    // steps down; only slow frames held for several seconds do
    {
        const L = new Ladder(0);
        let [t, steps] = run(L, 0, 60000, 16.7, { work: 5 });
        // a 2.5 s dip to ~33 fps, then smooth again
        [t, steps] = run(L, t, t + 2500, 30);
        [t, steps] = run(L, t, t + 8000, 16.7, { work: 5 });
        assert.equal(L.rung, 0, 'a short dip is not lag');
        // one GC burst: 12 hitches in a second, then smooth
        for (let i = 0; i < 12; i++) { t += 80; L.frame(t, 80, 6); }
        [t, steps] = run(L, t, t + 8000, 16.7, { work: 5 });
        assert.equal(L.rung, 0, 'one burst of hitches is not lag');
        // a refocus: a long gap, then a few seconds of slow warm-up frames
        t += 5000; L.frame(t, 5000, 2);
        [t, steps] = run(L, t, t + TUNE.GRACE - 100, 60);
        [t, steps] = run(L, t, t + 8000, 16.7, { work: 5 });
        assert.equal(L.rung, 0, 'warm-up after a refocus is not lag');
        // a sustained dip does step, once
        [t, steps] = run(L, t, t + TUNE.SLOW_FOR + 1500, 30);
        assert.deepEqual(steps.map(s => s[2]), [1], 'a sustained dip steps one rung');
    }
    // a hidden tab or a stall is not slow
    {
        const L = new Ladder(0);
        let t = 0;
        for (let i = 0; i < 50; i++) { t += 1000; assert.equal(L.frame(t, 1000, 2), 0); }
        assert.equal(L.rung, 0);
    }

    // up: smooth for UP_AFTER steps back up one rung
    {
        const L = new Ladder(2);
        let [t, steps] = run(L, 0, TUNE.UP_AFTER - 500, 16.7, { work: 5 });
        assert.equal(steps.length, 0, 'not before UP_AFTER');
        [t, steps] = run(L, t, TUNE.UP_AFTER + 1500, 16.7, { work: 5 });
        assert.deepEqual(steps.map(s => s[1]), [-1]);
        assert.equal(L.rung, 1);
    }
    // the 30 fps cap comes off only when a frame's work fits 60 fps easily
    {
        const L = new Ladder(4);
        let [t, steps] = run(L, 0, 60000, 1000 / 30, { capped: true, work: 14 });
        assert.equal(steps.length, 0, 'busy frames keep the cap');
        [t, steps] = run(L, t, t + 8000, 1000 / 30, { capped: true, work: 4 });
        assert.equal(L.rung, 3, 'light frames lose it');
    }
    // capped: a steady 30 fps is not lag
    {
        const L = new Ladder(4);
        L.setSkip([]);
        const r0 = L.rung;
        run(L, 0, 30000, 1000 / 30, { capped: true, work: 20 });
        assert.equal(L.rung, r0, 'steady under the cap');
    }
    // pinned: battery saver or a 30 Hz screen holds a dead steady 30 with
    // cheap frames; that never walks the ladder down, and lets it back up
    {
        const L = new Ladder(0);
        let [t, steps] = run(L, 0, 60000, 1000 / 30, { work: 6 });
        assert.equal(steps.length, 0, 'a pinned 30 is not lag');
        const M = new Ladder(3);
        run(M, 0, TUNE.UP_AFTER + 2000, 1000 / 30, { work: 6 });
        assert.equal(M.rung, 2, 'and a pinned 30 steps back up');
        // the same 30 fps with heavy frames is a slow machine
        const N = new Ladder(0);
        [t, steps] = run(N, 0, TUNE.SLOW_FOR + 1500, 1000 / 30, { work: 25 });
        assert.equal(N.rung, 1, 'heavy 30 fps steps down');
        // a jittery 30 (frames anywhere from 20 to 47 ms) is lag too
        const J = new Ladder(0);
        let tj = 0, sj = 0;
        for (let i = 0; i < 300 && !sj; i++) { const dt = i % 2 ? 20 : 47; tj += dt; sj = J.frame(tj, dt, 6); }
        assert.equal(sj, 1, 'jittery 30 steps down');
    }
    // bounce: slow again right after stepping up holds it down
    {
        const L = new Ladder(2);
        let [t] = run(L, 0, TUNE.UP_AFTER + 1500, 16.7, { work: 5 });
        assert.equal(L.rung, 1);
        let steps;
        [t, steps] = run(L, t, t + TUNE.COOLDOWN + TUNE.SLOW_FOR + 500, 30);
        assert.equal(L.rung, 2, 'back down');
        [t, steps] = run(L, t, t + 60000, 16.7, { work: 5 });
        assert.equal(steps.length, 0, 'held down after the bounce');
        assert.ok(L.holdUntil > t);
    }

    // skip: rungs the player owns are passed over both ways
    {
        const L = new Ladder(0);
        L.setSkip(['fewerFx', 'simpleTerrain']);
        let [t] = run(L, 0, TUNE.SLOW_FOR + 1200, 30);
        assert.equal(L.rung, 1);
        [t] = run(L, t, t + TUNE.COOLDOWN + TUNE.SLOW_FOR + 500, 30);
        assert.equal(L.rung, 4, 'straight past the player\'s rungs to the cap');
        assert.ok(L.on('fps30') && !L.on('fewerFx') && !L.on('simpleTerrain'));
        assert.ok(L.exhausted());
        [t] = run(L, t, t + TUNE.UP_AFTER + TUNE.COOLDOWN + 2000, 1000 / 30, { capped: true, work: 4 });
        assert.equal(L.rung, 3, 'cap off');
        [t] = run(L, t, t + TUNE.UP_AFTER + TUNE.COOLDOWN + 2000, 16.7, { work: 4 });
        assert.equal(L.rung, 0, 'and past them again on the way up');
        assert.ok(!L.active());
    }
    {
        const L = new Ladder(0);
        L.setSkip(RUNGS);
        assert.ok(L.exhausted(), 'all set by hand: resolution only');
        run(L, 0, 20000, 30);
        assert.equal(L.rung, 0);
        assert.ok(!L.active());
    }

    // automatic resolution: small steps after a sustained dip, back up gradually
    {
        const { ResGovernor, RES, resBudget, resLevels } = Q;
        const retina = 1728 * 1117 * 4;
        assert.equal(resBudget(0, retina), Infinity, 'level 0 is native');
        assert.ok(resBudget(1, retina) >= retina * 0.7, 'one step keeps most of the pixels');
        for (let l = 1; l < 12; l++) assert.ok(resBudget(l + 1, retina) <= resBudget(l, retina), 'monotonic');
        assert.equal(resBudget(40, retina), RES.FLOOR, 'never under the floor');
        assert.ok(resLevels(retina) >= 4 && resLevels(1024 * 768) === 0, 'levels per screen');
        const res = (G, t, until, dt, turn = () => true, max = 8) => {
            const steps = [];
            while (t < until) { t += dt; const s = G.frame(t, dt, turn, max); if (s) steps.push([Math.round(t), s, G.level]); }
            return [t, steps];
        };
        const G = new ResGovernor(0);
        let [t, steps] = res(G, 0, 20000, 16.7);
        [t, steps] = res(G, t, t + 3000, 50);
        [t, steps] = res(G, t, t + 6000, 16.7);
        assert.equal(G.level, 0, 'a 3 s dip keeps full resolution');
        t += 3000; G.frame(t, 3000);
        [t, steps] = res(G, t, t + RES.GRACE - 100, 120);
        assert.equal(G.level, 0, 'nor the frames after a refocus');
        [t, steps] = res(G, t, t + 4000, 16.7);
        [t, steps] = res(G, t, t + 4000, 30, () => false);
        assert.equal(G.level, 0, 'the effects ladder goes first');
        [t, steps] = res(G, t, t + RES.SLOW_FOR + 2000, 45);
        assert.deepEqual(steps.map(s => s[2]), [1], 'a sustained dip: one small step');
        [t, steps] = res(G, t, t + RES.UP_AFTER + RES.SETTLE + 1000, 16.7);
        assert.deepEqual(steps.map(s => s[1]), [-1], 'smooth again: back up one level');
        const W = new ResGovernor(0);
        [t, steps] = res(W, 0, 30000, 120);
        assert.ok(W.level >= 4, 'a genuinely weak device still walks down: ' + W.level);
        assert.ok(steps.every((s, i) => !i || s[0] - steps[i - 1][0] >= RES.SETTLE), 'one level at a time');
        res(W, t, t + 30000, 120, () => true, 2);
        assert.equal(W.level, 2, 'clamped when the screen has fewer levels');
    }

    // wiring
    const app = fs.readFileSync(path.join(CLIENT, 'app.js'), 'utf8');
    const glue = fs.readFileSync(path.join(CLIENT, 'autoQuality.js'), 'utf8');
    const juice = fs.readFileSync(path.join(CLIENT, 'juice.js'), 'utf8');
    assert.match(app, /import \* as autoQ from '\.\/autoQuality\.js'/);
    assert.match(app, /fpsCap30 = on\("opt30Fps"\);[\s\S]{0,200}autoQ\.applyTo\(config\.graphical\)/, 'rungs on top of loadSettings');
    assert.match(app, /renderFrame\(tick\);\s*\n\s*try \{ autoQ\.frame\(/, 'drawn frames feed the ladder');
    assert.match(app, /autoRes\.frame\(now, dt, \(ema\) => autoQ\.resolutionTurn\(ema\), autoResMax\(\)\)/, 'resolution waits its turn');
    assert.match(app, /scale < nat \* 0\.99 \? "auto" : ""/, 'a lowered resolution is filtered, not nearest-neighbour grain');
    const tr = fs.readFileSync(path.join(CLIENT, 'terrainRenderer.js'), 'utf8');
    assert.match(tr, /L\.d > want \* 1\.5 && !L\.keep/, 'the last good rock tiles stay up while the new ones shade');
    assert.ok(!/submitToLocalStorage|\.checked\s*=/.test(glue), 'never writes the player\'s settings');
    assert.match(glue, /e\.isTrusted/, 'only a real click makes a setting manual');
    assert.match(glue, /Effects were turned down to keep the game smooth\. You can change this in Settings\./);
    assert.match(juice, /autoTrim\(\) \? Q > 0\.25/, 'glitches stay on under the trim');
    assert.match(juice, /autoTrim\(\) && now - lastBurstAt < LOW_GLITCH_GAP/, 'and come rarer');

    console.log('ok   auto quality: start, down, sustained dip, up, skip, capped, resolution, wiring');
})().catch(e => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
