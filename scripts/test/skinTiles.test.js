// Skin tile cache tests: node scripts/test/skinTiles.test.js
//
//   sizes      tiles follow the hull's device pixels: octaves to 256, half
//              octaves past it, up to 4096 (2048 with Fewer Effects)
//   huge       a hull filling a 4K screen is painted from a 4096 tile, not
//              a 256 one scaled up 12x
//   budget     two huge skins on screen at once never rebuild each other
//              every frame; ones that left the screen make room for a new one
'use strict';

// the client files are ES modules in a CommonJS package: skip node's notice
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => { if (!/MODULE_TYPELESS|module syntax/.test(String(w) + a.join(' '))) emit.call(process, w, ...a); };

const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// just enough browser for config.js and the tile canvases
const noop = () => {};
function fakeCtx(cv) {
    const T = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return new Proxy({ canvas: cv }, {
        get(o, k) {
            if (k in o) return o[k];
            if (k === 'getTransform') return () => T;
            if (k === 'drawImage') return (img) => { drawn.push(img); };
            return noop;
        },
        set(o, k, v) { o[k] = v; return true; },
    });
}
const built = [], drawn = [];
class FakeOffscreen {
    constructor(w, h) { this.width = w; this.height = h; built.push(this); }
    getContext() { return fakeCtx(this); }
}
globalThis.window = globalThis;
globalThis.OffscreenCanvas = FakeOffscreen;
globalThis.localStorage = { getItem: () => null, setItem: noop };
globalThis.location = { hash: '', search: '', href: 'http://x/', protocol: 'http:', host: 'x', hostname: 'x' };
globalThis.document = {
    getElementById: () => null, addEventListener: noop, body: {}, documentElement: { style: {} },
    createElement: () => new FakeOffscreen(1, 1),
};
globalThis.DWCosmetics = require('../../shared/cosmetics.js');
let clock = 1e6;
performance.now = () => clock;

(async () => {
    const C = await import(pathToFileURL(path.join(__dirname, '../../public/client/account/cosmetics.js')).href);
    const opts = () => ({ statusColor: null, blend: 0, flash: false, flashColor: null, hitBlend: 0, hitColor: null,
        borderless: false, fill: true, lowFx: false, force: false, time: 0.3 });
    const NOVA = 139, MOLTEN = 112, AURORA = 137;
    const paint = (r, nid) => { drawn.length = 0; C.paintHull(fakeCtx(null), 0, 0, r, 0, 0, nid, '#00b2e1', opts()); return drawn[0]; };

    // sizes
    {
        let last = 0;
        for (let dev = 4; dev < 3000; dev *= 1.1) {
            const px = C.tilePx(dev, false);
            assert.ok(px >= last, 'never shrinks as the hull grows');
            assert.ok(px >= Math.min(4096, dev * 2.5), dev + ' px hull gets a ' + px + ' px tile');
            if (dev * 2.5 > 256) assert.ok(px <= dev * 2.5 * 1.5, 'no more than half an octave over at ' + dev);
            assert.ok(C.tilePx(dev, true) <= 2048);
            last = px;
        }
        assert.equal(C.tilePx(100, false), 256);
        assert.equal(C.tilePx(5000, false), 4096);
        assert.equal(C.tilePx(5000, true), 2048);
        console.log('ok   sizes');
    }

    // huge: a hull 1500 px in radius (as wide as a 4K screen)
    {
        clock += 1000;
        const img = paint(1500, NOVA);
        assert.ok(img && img.width === 4096, 'tile ' + (img && img.width));
        // its glow layer comes at half res at the most, never 128 px
        const glows = built.filter(cv => cv.width === 2048);
        assert.ok(glows.length >= 1, 'glow layer ' + built.map(c => c.width));
        // a normal tank keeps its small tile
        clock += 1000;
        assert.ok(paint(25, NOVA).width <= 64);
        console.log('ok   huge');
    }

    // budget
    {
        // two different huge skins drawn every frame for 10 s
        clock += 2000;
        const before = built.length;
        for (let f = 0; f < 300; f++) {
            clock += 33;
            assert.ok(paint(1500, NOVA), 'nova stays drawn');
            assert.ok(paint(1500, MOLTEN), 'molten stays drawn');
        }
        const builds = built.length - before;
        assert.ok(builds <= 6, builds + ' tile builds in 300 frames');
        // both leave the screen; a third huge skin gets the room they held
        let got = null;
        for (let f = 0; f < 90 && !(got && got.width === 4096); f++) { clock += 33; got = paint(1500, AURORA); }
        assert.ok(got && got.width === 4096, 'aurora at full size once the others are gone, got ' + (got && got.width));
        assert.ok(C.cacheSize() < 20, 'cache ' + C.cacheSize());
        console.log('ok   budget');
    }
    console.log('all 3 passed');
})().catch(e => { console.error(e); process.exit(1); });
