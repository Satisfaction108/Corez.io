// Touch stick tests: node scripts/test/touchInput.test.js
//
//   stick     dead zone, soft curve, full speed before the rim, direction kept
//   bits      the eight-way movement bits the server still reads
//   packet    the analog move survives the trip through the command packet
//             (client packMove -> server unpackMove) and can't ask for more
//             than full speed
//   assist    aim bends toward a target inside the cone, never outside it
//   device    touch play only for a touch-first device: phones, tablets and
//             iPads yes; a touch screen laptop or a PC whose browser says
//             "Android" no
//   switch    a moving or clicking mouse turns touch play off, game keys do
//             when there is a pointer to aim with, a touch turns it back on;
//             the browser's copied mouse events after a tap never count
//   wiring    canvas.js, app.js and touch.js use these, aim assist only runs
//             in touch play, the server has no aim assist of its own
'use strict';

// the client files are ES modules in a CommonJS package: skip node's notice
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => { if (!/MODULE_TYPELESS|module syntax/.test(String(w) + a.join(' '))) emit.call(process, w, ...a); };

const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { unpackMove: serverUnpack } = require('../../server/lib/touchMove.js');

(async () => {
    const T = await import(pathToFileURL(path.join(__dirname, '../../public/client/touchInput.js')).href);
    const { STICK, stickVector, moveBits, packMove, unpackMove, assistAim } = T;
    const R = STICK.R;

    // stick
    {
        assert.equal(stickVector(0, 0).mag, 0, 'centre is still');
        assert.equal(stickVector(R * STICK.DEAD * 0.9, 0).mag, 0, 'inside the dead zone is still');
        const crawl = stickVector(R * (STICK.DEAD + 0.01), 0);
        assert.ok(crawl.mag >= STICK.FLOOR && crawl.mag < STICK.FLOOR + 0.05, 'just past the dead zone crawls');
        assert.equal(stickVector(R * STICK.FULL, 0).mag, 1, 'full speed at FULL');
        assert.equal(stickVector(R * 3, 0).mag, 1, 'never more than full');
        let last = 0;
        for (let r = STICK.DEAD + 0.01; r <= 1; r += 0.02) {
            const m = stickVector(R * r, 0).mag;
            assert.ok(m >= last - 1e-9, 'speed only grows with the push');
            last = m;
        }
        const d = stickVector(-30, 30);
        assert.ok(Math.abs(d.ang - Math.atan2(30, -30)) < 1e-9, 'direction is the push direction');
        assert.ok(Math.abs(Math.hypot(d.x, d.y) - d.mag) < 1e-9, 'x, y carry the magnitude');
    }

    // bits (up 1, down 2, left 4, right 8)
    {
        const at = deg => moveBits(stickVector(Math.cos(deg * Math.PI / 180) * R, Math.sin(deg * Math.PI / 180) * R));
        assert.equal(at(0), 8, 'right');
        assert.equal(at(180), 4, 'left');
        assert.equal(at(-90), 1, 'up (screen y grows down)');
        assert.equal(at(90), 2, 'down');
        assert.equal(at(-45), 1 | 8, 'up-right');
        assert.equal(at(135), 2 | 4, 'down-left');
        assert.equal(at(10), 8, 'a little off right is still right');
        assert.equal(moveBits(stickVector(1, 1)), 0, 'dead zone sends nothing');
    }

    // packet
    {
        assert.equal(packMove(stickVector(0, 0)), 0, 'no push packs to 0');
        assert.equal(serverUnpack(0), null);
        assert.equal(serverUnpack(-5), null);
        assert.equal(serverUnpack(70000), null, 'out of range');
        assert.equal(serverUnpack(1.5), null, 'not an integer');
        assert.equal(serverUnpack('33000'), null, 'not a number');
        assert.equal(serverUnpack(128 * 256 + 128), null, 'centre is no move');
        for (let a = -180; a < 180; a += 15) {
            for (const r of [0.3, 0.6, 1, 2]) {
                const v = stickVector(Math.cos(a * Math.PI / 180) * R * r, Math.sin(a * Math.PI / 180) * R * r);
                if (!v.mag) continue;
                const n = packMove(v);
                assert.ok(n > 0 && n <= 65535 && Number.isInteger(n));
                const s = serverUnpack(n), c = unpackMove(n);
                assert.ok(s && c, 'decodes');
                assert.ok(Math.abs(s.x - v.x) < 0.012 && Math.abs(s.y - v.y) < 0.012, 'server gets the same vector');
                assert.ok(Math.abs(c.x - s.x) < 1e-9 && Math.abs(c.y - s.y) < 1e-9, 'client and server decode alike');
                assert.ok(Math.hypot(s.x, s.y) <= 1 + 1e-9, 'never faster than full');
            }
        }
        // a forged corner value is clamped to length 1
        const f = serverUnpack(255 * 256 + 255);
        assert.ok(Math.abs(Math.hypot(f.x, f.y) - 1) < 1e-9);
    }

    // assist
    {
        const cands = [{ ang: 0.1, dist: 400, pri: 1 }];
        const pulled = assistAim(0, cands);
        assert.ok(pulled.ang > 0 && pulled.ang <= 0.1, 'bends toward the target, never past it');
        assert.equal(pulled.dist, 400);
        assert.equal(assistAim(0, [{ ang: 0.6, dist: 400, pri: 1 }]).ang, 0, 'outside the cone: untouched');
        const pick = assistAim(0, [{ ang: 0.15, dist: 300, pri: 1 }, { ang: -0.05, dist: 900, pri: 1 }]);
        assert.ok(pick.ang < 0, 'the one nearest the aim line wins');
        const rock = assistAim(0, [{ ang: 0.05, dist: 300, pri: 0.55 }, { ang: -0.08, dist: 300, pri: 1 }]);
        assert.ok(rock.ang < 0, 'a tank beats a rock at a similar angle');
        // wraps across +-pi
        const wrap = assistAim(Math.PI - 0.02, [{ ang: -Math.PI + 0.02, dist: 200, pri: 1 }]);
        assert.ok(Math.abs(Math.atan2(Math.sin(wrap.ang), Math.cos(wrap.ang))) > Math.PI - 0.03, 'handles the wrap');
    }

    // device
    {
        const { touchPrimary } = T;
        const UA = {
            win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
            android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
            iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
            linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        };
        const dev = (ua, maxTouchPoints, coarse, fine) => touchPrimary({ ua, maxTouchPoints, coarse, fine });
        assert.equal(dev(UA.win, 0, false, true), false, 'desktop PC');
        assert.equal(dev(UA.win, 10, false, true), false, 'touch screen laptop: the trackpad is primary');
        assert.equal(dev(UA.android, 0, false, true), false, 'a PC whose browser says Android (UA switcher, devtools)');
        assert.equal(dev(UA.android, 10, false, true), false, 'Android UA on a touch laptop');
        assert.equal(dev(UA.mac, 0, false, true), false, 'a Mac');
        assert.equal(dev(UA.android, 5, true, false), true, 'Android phone');
        assert.equal(dev(UA.linux, 5, true, false), true, 'Android tablet asking for the desktop site');
        assert.equal(dev(UA.iphone, 5, true, false), true, 'iPhone');
        assert.equal(dev(UA.mac, 5, true, false), true, 'iPad (says Mac)');
        assert.equal(dev(UA.mac, 5, true, true), true, 'iPad with a trackpad starts on touch (the trackpad flips it)');
        assert.equal(dev(UA.win, 10, true, false), true, 'Windows tablet, no keyboard');
        assert.equal(dev(UA.android, 5, null, null), true, 'no matchMedia: the user agent decides');
        assert.equal(dev(UA.win, 10, null, null), false);
    }

    // switch
    {
        const { inputModeWatch, MODE } = T;
        const w = inputModeWatch({ fine: true });
        let t = 10000;
        assert.equal(w.mouseMove(100, 100, t, true), null, 'the first event only marks the spot');
        assert.equal(w.mouseMove(105, 100, t += 16, true), null, 'a nudge is not enough');
        assert.equal(w.mouseMove(130, 100, t += 16, true), false, 'a real move: mouse and keys');
        assert.equal(w.mouseMove(200, 100, t += 16, false), null, 'already on mouse and keys');
        // a slow creep with long pauses (a resting mouse on a wobbly desk) never adds up
        let flips = 0;
        for (let i = 0; i < 40; i++) if (w.mouseMove(300 + i * 6, 300, t += MODE.GAP_MS + 50, true) === false) flips++;
        assert.equal(flips, 0, 'creeping mouse');
        assert.equal(w.touch(t += 100), true, 'a touch on the game: touch play');
        // the browser's mouse copies right after a tap
        assert.equal(w.mouseMove(10, 10, t += 5, true), null);
        assert.equal(w.mouseMove(400, 400, t += 5, true), null, 'copied events after a tap');
        assert.equal(w.mouseDown(t += 5, true), null, 'copied click after a tap');
        t += MODE.AFTER_TOUCH_MS + 10;
        assert.equal(w.mouseDown(t, true), false, 'a real click');
        assert.equal(w.key(t, true), false, 'game keys with a trackpad: mouse and keys');
        assert.equal(w.key(t, false), null);
        const ipad = inputModeWatch({ fine: false });
        assert.equal(ipad.key(t, true), null, 'an iPad with only a keyboard keeps its aim stick');
        assert.equal(inputModeWatch({ fine: null }).key(t, true), null);
        // read fresh each time: a trackpad plugged in mid-raid counts
        const env = { fine: false };
        const live = inputModeWatch(() => env);
        assert.equal(live.key(t, true), null);
        env.fine = true;
        assert.equal(live.key(t, true), false);
    }

    // wiring
    {
        const fs = require('fs');
        const read = (f) => fs.readFileSync(path.join(__dirname, '../../public/client', f), 'utf8');
        const app = read('app.js'), canvas = read('canvas.js'), touch = read('touch.js');
        assert.match(app, /global\.mobile = touchPrimary\(global\.inputEnv\(\)\)/, 'app.js decides with touchPrimary');
        assert.doesNotMatch(app, /global\.mobile = \/Android/, 'no user-agent-only decision left');
        assert.match(canvas, /touch\.attach\(this\);/);
        assert.match(canvas, /e\.pointerType === "mouse"\) flip\(watch\.mouseMove/);
        assert.match(canvas, /addEventListener\("mousemove", \(event\) => \{if \(!global\.mobile/, 'mouse handlers wait while touch plays');
        // aim assist sits behind the enabled check in frame()
        const fr = touch.slice(touch.indexOf('    frame(now) {'));
        assert.ok(fr.indexOf('if (!sock || !this.enabled) return;') < fr.indexOf('assistAim('), 'assist only in touch play');
        assert.match(touch, /setActive\(on\) \{\s*this\.enabled = !!on;/);
        // the server has no aim assist: the C packet's fifth field is movement only
        const srv = fs.readFileSync(path.join(__dirname, '../../server/lib/touchMove.js'), 'utf8');
        assert.doesNotMatch(srv, /assist|aim/i);
    }

    console.log('touchInput: all passed');
})().catch(e => { console.error(e); process.exit(1); });
