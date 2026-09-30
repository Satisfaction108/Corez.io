// Touch stick tests: node scripts/test/touchInput.test.js
//
//   stick     dead zone, soft curve, full speed before the rim, direction kept
//   bits      the eight-way movement bits the server still reads
//   packet    the analog move survives the trip through the command packet
//             (client packMove -> server unpackMove) and can't ask for more
//             than full speed
//   assist    aim bends toward a target inside the cone, never outside it
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

    console.log('touchInput: all passed');
})().catch(e => { console.error(e); process.exit(1); });
