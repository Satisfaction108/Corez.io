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
    const at = (name) => RUNGS.indexOf(name) + 1;
    assert.deepEqual(RUNGS, ['noShake', 'fxLow', 'noGlow', 'fewerFx', 'simpleTerrain', 'fps30'], 'shake first, then effects, the cap last; resolution after all of them');
    assert.equal(startRung({ cores: 12, memory: 8, dpr: 2 }), 0, 'strong desktop: full quality');
    assert.equal(startRung({}), 0, 'nothing known: full quality');
    assert.equal(startRung({ cores: 4, memory: 8 }), at('fewerFx'), 'four cores');
    assert.equal(startRung({ cores: 8, memory: 4 }), at('fewerFx'), '4 GB');
    assert.equal(startRung({ cores: 8, softGl: true }), at('simpleTerrain'), 'software WebGL');
    assert.equal(startRung({ cores: 2 }), at('simpleTerrain'), 'two cores');
    assert.equal(startRung({ cores: 8, memory: 8, mobile: true }), at('fxLow'), 'phone');
    assert.equal(startRung({ cores: 6, memory: 8, dpr: 3 }), at('fxLow'), 'sharp panel, mid chip');

    // down: 30 ms frames step one rung after SLOW_FOR, then wait out the cooldown
    {
        const L = new Ladder(0);
        let [t, steps] = run(L, 0, TUNE.SLOW_FOR - 500, 30);
        assert.equal(steps.length, 0, 'not before SLOW_FOR');
        [t, steps] = run(L, t, TUNE.SLOW_FOR + 1200, 30);
        assert.equal(steps.length, 1, 'one step');
        assert.equal(L.rung, 1);
        assert.ok(L.on('noShake') && !L.on('fxLow'), 'screen shake goes first');
        const t1 = steps[0][0];
        [t, steps] = run(L, t, t1 + TUNE.COOLDOWN + TUNE.SLOW_FOR - 200, 30);
        assert.equal(steps.length, 0, 'cooldown and a fresh slow stretch before the next');
        const order = [];
        for (let i = 0; i < 8 && !L.exhausted(); i++) {
            [t, steps] = run(L, t, t + TUNE.COOLDOWN + TUNE.SLOW_FOR + 500, 30);
            for (const s of steps) order.push(RUNGS[s[2] - 1]);
        }
        assert.deepEqual(order, ['fxLow', 'noGlow', 'fewerFx', 'simpleTerrain', 'fps30'], 'then the effects one at a time, the cap last');
        assert.ok(L.exhausted(), 'resolution is next');
        [t, steps] = run(L, t, t + 10000, 30);
        assert.equal(steps.length, 0, 'nothing past the last rung');
    }
    {
        const L = new Ladder(0);
        const seen = [];
        let t = 0, firstExhausted = 0;
        while (t < 60000) {
            t += 120;
            const s = L.frame(t, 120, 60);
            if (s > 0) seen.push(RUNGS[L.rung - 1]);
            if (!firstExhausted && L.exhausted()) firstExhausted = t;
        }
        assert.deepEqual(seen, ['noShake', 'fxLow', 'noGlow', 'fewerFx', 'simpleTerrain'], 'every effect before resolution (no cap for 60 ms of work)');
        assert.ok(firstExhausted > 0 && firstExhausted < 30000, 'a collapsed frame rate gets to resolution in under 30 s: ' + firstExhausted);
    }
    // the cap can't help frames that take longer than 33 ms to draw: resolution's turn
    {
        const L = new Ladder(at('simpleTerrain'));
        run(L, 0, 20000, 45, { work: 40 });
        assert.equal(L.rung, at('simpleTerrain'), 'no cap on 40 ms frames');
        assert.ok(L.exhausted(), 'resolution next');
        const M = new Ladder(at('simpleTerrain'));
        run(M, 0, TUNE.SLOW_FOR + 1200, 30, { work: 20 });
        assert.equal(M.rung, at('fps30'), 'cap on 20 ms of work running at 30 ms');
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
        assert.ok(L.on('noShake') && !L.on('fxLow'), 'shake first there too');
    }
    // sustained-dip rule: a short dip, one GC burst or a tab refocus never
    // steps down; only slow frames held for several seconds do
    {
        const L = new Ladder(0);
        let [t, steps] = run(L, 0, 60000, 16.7, { work: 5 });
        [t, steps] = run(L, t, t + 2500, 30);
        [t, steps] = run(L, t, t + 8000, 16.7, { work: 5 });
        assert.equal(L.rung, 0, 'a short dip is not lag');
        [t, steps] = run(L, t, t + 1500, 70);
        [t, steps] = run(L, t, t + 8000, 16.7, { work: 5 });
        assert.equal(L.rung, 0, 'a short collapse is not lag either');
        for (let i = 0; i < 12; i++) { t += 80; L.frame(t, 80, 6); }
        [t, steps] = run(L, t, t + 8000, 16.7, { work: 5 });
        assert.equal(L.rung, 0, 'one burst of hitches is not lag');
        t += 5000; L.frame(t, 5000, 2);
        [t, steps] = run(L, t, t + TUNE.GRACE - 100, 60);
        [t, steps] = run(L, t, t + 8000, 16.7, { work: 5 });
        assert.equal(L.rung, 0, 'warm-up after a refocus is not lag');
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
        assert.ok(L.on('noShake') && !L.on('fxLow'), 'effects come back before shake');
        const back = [];
        const F = new Ladder(RUNGS.length);
        let tf = 0;
        for (let i = 0; i < 10 && F.rung > 0; i++) {
            let st;
            [tf, st] = run(F, tf, tf + TUNE.UP_AFTER + TUNE.COOLDOWN + 1500, 16.7, { work: 4 });
            for (const s of st) back.push(RUNGS[s[2]]);
        }
        assert.deepEqual(back, ['fps30', 'simpleTerrain', 'fewerFx', 'noGlow', 'fxLow', 'noShake'], 'the way back is the way down reversed');
    }
    {
        const L = new Ladder(RUNGS.length);
        L.setResLow(true);
        let [t, steps] = run(L, 0, 60000, 16.7, { work: 4 });
        assert.equal(steps.length, 0, 'effects wait for the resolution');
        L.setResLow(false);
        [t, steps] = run(L, t, t + TUNE.UP_AFTER + 1500, 16.7, { work: 4 });
        assert.deepEqual(steps.map(s => s[1]), [-1], 'then step back up');
    }
    // the 30 fps cap comes off only when a frame's work fits 60 fps easily
    {
        const L = new Ladder(at('fps30'));
        let [t, steps] = run(L, 0, 60000, 1000 / 30, { capped: true, work: 14 });
        assert.equal(steps.length, 0, 'busy frames keep the cap');
        [t, steps] = run(L, t, t + 8000, 1000 / 30, { capped: true, work: 4 });
        assert.equal(L.rung, at('simpleTerrain'), 'light frames lose it');
    }
    // capped: a steady 30 fps is not lag
    {
        const L = new Ladder(at('fps30'));
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
        const N = new Ladder(0);
        [t, steps] = run(N, 0, TUNE.SLOW_FOR + 1500, 1000 / 30, { work: 25 });
        assert.equal(N.rung, 1, 'heavy 30 fps steps down');
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
        L.setSkip(['noGlow', 'fewerFx', 'simpleTerrain']);
        let [t] = run(L, 0, TUNE.SLOW_FOR + 1200, 30);
        assert.equal(L.rung, 1);
        [t] = run(L, t, t + TUNE.COOLDOWN + TUNE.SLOW_FOR + 500, 30);
        assert.equal(L.rung, 2);
        [t] = run(L, t, t + TUNE.COOLDOWN + TUNE.SLOW_FOR + 500, 30);
        assert.equal(L.rung, at('fps30'), 'straight past the player\'s rungs to the cap');
        assert.ok(L.on('fps30') && !L.on('fewerFx') && !L.on('simpleTerrain') && !L.on('noGlow'));
        assert.ok(L.exhausted());
        [t] = run(L, t, t + TUNE.UP_AFTER + TUNE.COOLDOWN + 2000, 1000 / 30, { capped: true, work: 4 });
        assert.equal(L.rung, at('simpleTerrain'), 'cap off');
        [t] = run(L, t, t + 3 * (TUNE.UP_AFTER + TUNE.COOLDOWN + 2000), 16.7, { work: 4 });
        assert.equal(L.rung, 0, 'and back to full');
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

    {
        const L = new Ladder(at('simpleTerrain'));
        assert.ok(L.setRecording(true, 0), 'recording starts');
        assert.equal(L.rung, 0, 'every effect comes back for the recording');
        assert.ok(!L.exhausted(), 'resolution is never its turn while recording');
        let [t, steps] = run(L, 0, 60000, 30);
        assert.equal(steps.length, 0, '33 fps while recording keeps every effect');
        let t2 = t;
        for (let i = 0; i < 40; i++) { const dt = i % 4 ? 16 : 90; t2 += dt; L.frame(t2, dt, 6); }
        assert.equal(L.rung, 0, 'hitches while recording keep every effect');
        [t, steps] = run(L, t2, t2 + 120000, 60, { work: 50 });
        assert.deepEqual(steps.map(s => RUNGS[s[2] - 1]), ['noShake', 'fxLow'], 'a collapse drops only shake, then minor effects');
        assert.ok(!L.exhausted(), 'still never resolution');
        L.setRecording(false, t);
        assert.equal(L.rung, at('simpleTerrain'), 'the trim from before the recording comes back after');
        const S = new Ladder(0);
        S.setSkip(['noShake']);
        S.setRecording(true, 0);
        run(S, 0, 60000, 60, { work: 50 });
        assert.equal(S.rung, 2, 'a player\'s own no-shake is passed over');
        assert.ok(S.on('fxLow') && !S.on('noGlow'));
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
        [t, steps] = res(G, t, t + 30000, 200 / 3 * 2, () => false);
        assert.equal(G.level, 0, 'even at 7 fps, effects go first');
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
    assert.ok(!/emaMs > 60/.test(glue), 'no shortcut puts resolution ahead of the effects');
    assert.match(app, /autoRes\.hold \|\| global\.recording\) \{ autoRes\.pause\(now\)/, 'resolution never moves while recording');
    assert.match(app, /autoQ\.resolutionLow\(autoRes\.level > 0\)/, 'effects come back only after the resolution');
    assert.match(app, /if \(global\.recording\) \{ global\.lowFx = false;/, 'no automatic glow trim while recording');
    assert.match(juice, /if \(global\.recording\) Q = 1;/, 'full particles while recording');
    const canvasJs = fs.readFileSync(path.join(CLIENT, 'canvas.js'), 'utf8');
    assert.match(canvasJs, /global\.recordQuality\(true\)/, 'a recording lifts the trim and the resolution first');
    assert.match(canvasJs, /global\.recordQuality\(false\)/, 'and hands them back after');
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
