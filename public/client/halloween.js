// Halloween dressing for the menu background, on while html.dw-halloween is
// set (index.html picks the dates, halloween.css does the rest of the page).
// home.js calls build() when the screen or the theme changes, then every
// frame back(), body() for each tank (its round hull becomes a carved ore
// rock lit from inside) and front() for the bats and the near storm bank.
// app.js hands its menu fireworks to burst() / corn(), which throw candy
// corn instead of shapes. Everything is baked into canvases up front and the
// candy corn lives in a fixed pool, so a frame is drawImage calls and some
// arithmetic, nothing allocated.
(function () {
    'use strict';

    var TAU = Math.PI * 2;
    // same cut as the ore in the rock (terrainRenderer.js GEM_CUT)
    var GEM_CUT = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
    // copper crack tones (terrainRenderer.js CRACK_PAL[0]): the carved holes
    var CUT_DEEP = 'rgb(150,35,0)', CUT_HOT = 'rgb(255,124,28)', CUT_HAIR = 'rgb(255,225,140)';
    var COPPER = ['rgb(90,44,14)', 'rgb(201,111,46)', 'rgb(237,167,102)', 'rgb(255,233,209)'];

    var PAL = {
        dark: {
            ink: '#0c0a0e',
            // the rock's shadowed / main / lit facets, a step up from the
            // in-raid tones so they read on the menu's night
            rock: ['#24202d', '#363044', '#524a69'],
            rockA: 1,
            halo: 'rgba(255,122,30,0.08)',
            glow: 'rgba(255,150,52,0.5)',
            bat: ['#2a2536', '#3b3450', '#584d76'],
            guns: { iron: '#3d3749', ink: '#0c0a0e', tips: ['#ee7418', '#7448d6'] },
            batA: 0.92,
            fogFar: { shadow: 'rgba(9,6,22,0.55)', body: '#261d45', lit: '#32285a', base: '#211a3c' },
            fogNear: { shadow: 'rgba(8,5,20,0.6)', body: '#35286a', lit: '#4c3c8e', base: '#2e235c' },
            fogA: [0.75, 0.9],
            flash: 0.6
        },
        light: {
            ink: '#3d3248',
            rock: ['#7f7590', '#958ba4', '#b0a7be'],
            rockA: 1,
            halo: null,
            glow: 'rgba(255,140,40,0.55)',
            bat: ['#3a3146', '#4b4158', '#62577a'],
            guns: { iron: '#6c6279', ink: '#3d3248', tips: ['#ee7418', '#7a52da'] },
            batA: 0.78,
            fogFar: { shadow: 'rgba(96,66,140,0.22)', body: '#cdb9e2', lit: '#ddd0ee', base: '#c7b2de' },
            fogNear: { shadow: 'rgba(84,54,128,0.26)', body: '#b9a0d8', lit: '#d0c0ea', base: '#b298d4' },
            fogA: [0.5, 0.78],
            flash: 0
        }
    };

    var W = 0, H = 0, dpr = 1, pal = PAL.dark;
    var bodies = [], bodyR = 0, bats = [], batFrames = [], batPad = 0;
    var fogFar = null, fogNear = null, fogW = 0, fogH = 0;
    var t = 0;
    // now and then the storm lights up from inside: a quick flash, a
    // second smaller one, then it fades
    var FLASH = new Float32Array(48);
    for (var fi = 0; fi < FLASH.length; fi++) {
        FLASH[fi] = (fi < 3 ? fi / 3 : Math.exp(-(fi - 3) / 5)) + (fi >= 11 ? 0.55 * Math.exp(-(fi - 11) / 9) : 0);
    }
    var flashAt = 300, flashI = FLASH.length;

    function rnd(a, b) { return a + Math.random() * (b - a); }

    function sprite(pad) {
        var c = document.createElement('canvas');
        c.width = c.height = Math.max(1, Math.ceil(pad * 2 * dpr));
        var g = c.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);
        return { canvas: c, g: g, pad: pad };
    }

    // a boulder outline: a few jittered corners, rounded off like the cells
    function rockPath(g, pts, round) {
        var n = pts.length;
        g.beginPath();
        var lx = (pts[n - 1][0] + pts[0][0]) / 2, ly = (pts[n - 1][1] + pts[0][1]) / 2;
        g.moveTo(lx, ly);
        for (var i = 0; i < n; i++) {
            var p = pts[i], q = pts[(i + 1) % n];
            g.arcTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, round);
        }
        g.closePath();
    }

    function polyPath(g, pts, s, ox, oy) {
        g.beginPath();
        for (var i = 0; i < pts.length; i++) {
            var x = ox + pts[i][0] * s, y = oy + pts[i][1] * s;
            if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.closePath();
    }

    // the lit wedge points up, the shadowed one down, both 141 degrees and
    // meeting at the seed, main tone in the slivers between (as in the rock)
    function facets(g, sx, sy, R, tones) {
        var WA = Math.acos(1 / 3);
        g.fillStyle = tones[1];
        g.fillRect(-R, -R, R * 2, R * 2);
        for (var k = 0; k < 2; k++) {
            var a0 = k ? Math.PI / 2 : -Math.PI / 2;
            g.fillStyle = k ? tones[0] : tones[2];
            g.beginPath();
            g.moveTo(sx, sy);
            g.lineTo(sx + Math.cos(a0 - WA) * R, sy + Math.sin(a0 - WA) * R);
            g.lineTo(sx + Math.cos(a0) * R, sy + Math.sin(a0) * R);
            g.lineTo(sx + Math.cos(a0 + WA) * R, sy + Math.sin(a0 + WA) * R);
            g.closePath();
            g.fill();
        }
    }

    function gem(g, x, y, r, rot) {
        var c = Math.cos(rot), s = Math.sin(rot);
        var put = function (scale, ox, oy) {
            g.beginPath();
            for (var i = 0; i < GEM_CUT.length; i++) {
                var px = GEM_CUT[i][0] * r * scale + ox, py = GEM_CUT[i][1] * r * scale + oy;
                var wx = x + px * c - py * s, wy = y + px * s + py * c;
                if (i) g.lineTo(wx, wy); else g.moveTo(wx, wy);
            }
            g.closePath();
        };
        g.lineJoin = 'round';
        g.lineWidth = Math.max(1.4, r * 0.32);
        g.strokeStyle = pal.ink;
        put(1, 0, 0); g.fillStyle = COPPER[1]; g.stroke(); g.fill();
        put(0.52, 0, -r * 0.12); g.fillStyle = COPPER[2]; g.fill();
        put(0.2, -r * 0.22, -r * 0.3); g.fillStyle = COPPER[3]; g.fill();
    }

    // Carved faces, in units of the rock's radius: two eyes and a mouth.
    var FACES = [
        {   // the classic: triangle eyes, a grin with two teeth up and one down
            eyes: [[[-0.5, 0.0], [-0.12, 0.0], [-0.3, -0.34]], [[0.12, 0.0], [0.5, 0.0], [0.3, -0.34]]],
            mouth: [[-0.6, 0.14], [-0.34, 0.27], [-0.25, 0.17], [-0.13, 0.29], [0.13, 0.29], [0.25, 0.17], [0.34, 0.27], [0.6, 0.14],
                    [0.44, 0.42], [0.14, 0.54], [0.06, 0.44], [-0.06, 0.44], [-0.14, 0.54], [-0.44, 0.42]]
        },
        {   // grumpy: slanted brows and a zigzag
            eyes: [[[-0.52, -0.22], [-0.1, -0.04], [-0.38, 0.06]], [[0.1, -0.04], [0.52, -0.22], [0.38, 0.06]]],
            mouth: [[-0.5, 0.26], [-0.32, 0.18], [-0.18, 0.3], [0, 0.18], [0.18, 0.3], [0.32, 0.18], [0.5, 0.26],
                    [0.36, 0.44], [0.18, 0.38], [0, 0.48], [-0.18, 0.38], [-0.36, 0.44]]
        },
        {   // surprised: diamond eyes, a round-ish shout with one tooth
            eyes: [[[-0.44, -0.12], [-0.29, -0.32], [-0.14, -0.12], [-0.29, 0.06]], [[0.14, -0.12], [0.29, -0.32], [0.44, -0.12], [0.29, 0.06]]],
            mouth: [[-0.26, 0.2], [-0.08, 0.15], [0, 0.25], [0.08, 0.15], [0.26, 0.2], [0.3, 0.38], [0.14, 0.52], [-0.14, 0.52], [-0.3, 0.38]]
        },
        {   // sly: one squint, a lopsided smile
            eyes: [[[-0.5, -0.06], [-0.14, -0.06], [-0.3, -0.3]], [[0.12, -0.1], [0.5, -0.16], [0.46, -0.04], [0.14, -0.02]]],
            mouth: [[-0.52, 0.2], [-0.2, 0.3], [-0.1, 0.22], [0.02, 0.32], [0.3, 0.26], [0.58, 0.04],
                    [0.5, 0.3], [0.2, 0.5], [-0.2, 0.46]]
        }
    ];

    function eachHole(face, fn) {
        fn(face.eyes[0]); fn(face.eyes[1]); fn(face.mouth);
    }

    function bakeRock(L) {
        var r = L.r;
        var spr = sprite(Math.ceil(r * (pal.halo ? 1.9 : 1.45)));
        var g = spr.g;
        g.lineJoin = 'round';
        if (pal.halo) {
            var hg = g.createRadialGradient(0, r * 0.1, r * 0.3, 0, r * 0.1, r * 1.85);
            hg.addColorStop(0, pal.halo);
            hg.addColorStop(1, 'rgba(255,122,30,0)');
            g.fillStyle = hg;
            g.fillRect(-spr.pad, -spr.pad, spr.pad * 2, spr.pad * 2);
        }
        g.globalAlpha = pal.rockA;
        // silhouette under the rock, dropped a hair
        g.save();
        g.translate(0, r * 0.03);
        rockPath(g, L.pts, r * 0.3);
        g.lineWidth = r * 0.24;
        g.strokeStyle = pal.ink;
        g.stroke();
        g.restore();
        g.save();
        rockPath(g, L.pts, r * 0.3);
        g.clip();
        facets(g, L.seed[0], L.seed[1], r * 2.4, pal.rock);
        // warm light spilling out of the cuts onto the stone
        var gg = g.createRadialGradient(0, r * 0.16, r * 0.1, 0, r * 0.16, r * 0.95);
        gg.addColorStop(0, 'rgba(255,140,40,0.34)');
        gg.addColorStop(1, 'rgba(255,140,40,0)');
        g.fillStyle = gg;
        g.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
        for (var i = 0; i < L.gems.length; i++) {
            var d = L.gems[i];
            gem(g, d[0] * r, d[1] * r, d[2] * r, d[3]);
        }
        g.restore();
        g.globalAlpha = 1;
        var face = FACES[L.face], s = r * L.fs;
        // the cut wall first, then the lit inside seen through it, then
        // the candle-bright middle
        eachHole(face, function (h) {
            polyPath(g, h, s, 0, L.fy);
            g.lineWidth = Math.max(1.6, r * 0.075);
            g.strokeStyle = pal.ink;
            g.fillStyle = CUT_DEEP;
            g.stroke();
            g.fill();
            g.save();
            g.clip();
            polyPath(g, h, s, 0, L.fy + r * 0.07);
            g.fillStyle = CUT_HOT;
            g.fill();
            g.restore();
        });
        L.base = spr;

        // flicker layer: the glow and the hot middles, faded in and out
        var fl = sprite(Math.ceil(r * 1.3));
        var f = fl.g;
        f.save();
        rockPath(f, L.pts, r * 0.3);
        f.clip();
        var fg = f.createRadialGradient(0, L.fy + r * 0.12, r * 0.05, 0, L.fy + r * 0.12, r * 0.8);
        fg.addColorStop(0, pal.glow);
        fg.addColorStop(1, 'rgba(255,140,40,0)');
        f.fillStyle = fg;
        f.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
        f.restore();
        eachHole(face, function (h) {
            var cx = 0, cy = 0;
            for (var i = 0; i < h.length; i++) { cx += h[i][0]; cy += h[i][1]; }
            cx = cx / h.length * s; cy = cy / h.length * s + L.fy;
            f.save();
            polyPath(f, h, s, 0, L.fy);
            f.clip();
            polyPath(f, h, s * 0.55, cx * 0.45, cy * 0.45 + L.fy * 0.55 + r * 0.06);
            f.fillStyle = CUT_HAIR;
            f.fill();
            f.restore();
        });
        L.flick = fl;
    }

    // Bats: a shard body with ears and two wings of three shards each. Three
    // wing poses, baked once and shared.
    function bakeBat(pose) {
        var S = 20;
        var spr = sprite(batPad);
        var g = spr.g;
        g.lineJoin = 'round';
        g.lineWidth = 2.2;
        g.strokeStyle = pal.ink;
        var lift = [-0.62, -0.1, 0.42][pose];
        var reach = [0.86, 1, 0.82][pose];
        for (var side = -1; side <= 1; side += 2) {
            var shx = side * 0.16 * S, shy = -0.12 * S;
            // three shards fanned from the shoulder, tips falling off down the wing
            var tips = [[1.05, -0.42], [0.86, 0.02], [0.55, 0.28]];
            for (var k = 0; k < 3; k++) {
                var a0 = k ? tips[k - 1] : [0.3, -0.36];
                var a1 = tips[k];
                var ax = side * a0[0] * S * reach, ay = (a0[1] + lift * (a0[0] / 1.05)) * S;
                var bx = side * a1[0] * S * reach, by = (a1[1] + lift * (a1[0] / 1.05)) * S;
                // small gap between shards: pull each one a little toward its own middle
                var mx = (shx + ax + bx) / 3, my = (shy + ay + by) / 3;
                var sh = 0.9;
                g.beginPath();
                g.moveTo(mx + (shx - mx) * sh, my + (shy - my) * sh);
                g.lineTo(mx + (ax - mx) * sh, my + (ay - my) * sh);
                g.lineTo(mx + (bx - mx) * sh, my + (by - my) * sh);
                g.closePath();
                g.fillStyle = pal.bat[k === 0 ? 2 : k === 1 ? 1 : 0];
                g.stroke();
                g.fill();
            }
        }
        // body and ears
        var body = [[0, -0.5], [0.12, -0.36], [0.2, -0.62], [0.27, -0.24], [0.22, 0.3], [0, 0.52], [-0.22, 0.3], [-0.27, -0.24], [-0.2, -0.62], [-0.12, -0.36]];
        polyPath(g, body, S, 0, 0);
        g.fillStyle = pal.bat[1];
        g.stroke();
        g.fill();
        polyPath(g, [[-0.27, -0.24], [0.27, -0.24], [0.22, 0.3], [0, 0.04]], S, 0, 0);
        g.fillStyle = pal.bat[0];
        g.fill();
        g.fillStyle = CUT_HOT;
        g.fillRect(-0.15 * S, -0.27 * S, 0.1 * S, 0.08 * S);
        g.fillRect(0.05 * S, -0.27 * S, 0.1 * S, 0.08 * S);
        return spr;
    }

    // The storm bank: a strip that wraps sideways, its top edge rolling in
    // billows (two sizes of scallop, so it never looks tiled), with a lit
    // rim and a darker underside, flat like the in-raid storm clouds.
    function bakeFog(seed, tones, tall) {
        var c = document.createElement('canvas');
        c.width = Math.ceil(fogW * dpr);
        c.height = Math.ceil(fogH * dpr);
        var g = c.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        var big = Math.max(3, Math.round(fogW / 260)), small = Math.max(7, Math.round(fogW / 74));
        var p1 = seed * 0.37, p2 = seed * 1.13;
        var top = fogH * (1 - tall);
        var edge = function (x, lift) {
            var u = x / fogW;
            var b1 = Math.pow(Math.abs(Math.sin(Math.PI * (u * big + p1))), 0.6);
            var b2 = Math.abs(Math.sin(Math.PI * (u * small + p2)));
            var calm = 1 - Math.min(1, lift / (fogH * tall)) * 0.7;
            return top + fogH * tall * (0.5 - (0.32 * b1 + 0.16 * b2) * calm) + lift;
        };
        var band = function (lift, color) {
            g.fillStyle = color;
            g.beginPath();
            g.moveTo(0, fogH);
            for (var x = 0; x < fogW; x += 3) g.lineTo(x, edge(x, lift));
            g.lineTo(fogW, edge(fogW, lift));
            g.lineTo(fogW, fogH);
            g.closePath();
            g.fill();
        };
        band(0, tones.lit);
        band(fogH * tall * 0.07, tones.body);
        band(fogH * tall * 0.42, tones.base);
        band(fogH * tall * 0.62, tones.shadow);
        return c;
    }

    function build(w, h, ratio, light, hullR) {
        var want = light ? PAL.light : PAL.dark;
        if (bodies.length && ratio === dpr && want === pal && hullR === bodyR) {
            // only the size changed (a window being dragged): keep the baked
            // hulls and bats, spread the bats over the new size, redo the fog
            for (var bi = 0; bi < bats.length; bi++) { bats[bi].x *= w / W; bats[bi].y0 *= h / H; }
            W = w; H = h;
            bakeFogs();
            return;
        }
        W = w; H = h; dpr = ratio;
        pal = want;
        bodyR = hullR;
        var small = Math.min(W, H) < 500;
        var k = small ? 0.72 : 1;

        // a handful of hulls, shared round-robin by the tanks
        bodies = [];
        for (var i = 0; i < 10; i++) {
            var r = hullR;
            var pts = [], m = 7 + (Math.random() * 3 | 0), a0 = Math.random() * TAU;
            for (var j = 0; j < m; j++) {
                var a = a0 + (j + rnd(-0.2, 0.2)) / m * TAU;
                var rr = r * rnd(0.94, 1.07);
                // a touch wider than tall, like a pumpkin
                pts.push([Math.cos(a) * rr * 1.05, Math.sin(a) * rr * 0.93]);
            }
            var gems = [];
            if (Math.random() < 0.8) gems.push([rnd(0.42, 0.62), rnd(-0.62, -0.46), rnd(0.13, 0.17), rnd(-0.5, 0.5)]);
            if (Math.random() < 0.5) gems.push([rnd(-0.78, -0.62), rnd(0.28, 0.42), rnd(0.1, 0.13), rnd(-0.6, 0.6)]);
            var L = {
                r: r, pts: pts, gems: gems,
                seed: [rnd(-0.2, 0.2) * r, rnd(-0.28, -0.12) * r],
                face: i % FACES.length,
                fs: rnd(0.88, 1),
                fy: rnd(0, 0.06) * r,
                base: null, flick: null
            };
            bakeRock(L);
            bodies.push(L);
        }

        batPad = 30;
        batFrames = [bakeBat(0), bakeBat(1), bakeBat(2)];
        bats = [];
        var nb = small ? 3 : 5;
        var flock = Math.random() < 0.5 ? 1 : -1;
        for (var b = 0; b < nb; b++) {
            var lead = b % 3 === 0;
            bats.push({
                x: Math.random() * W,
                y0: rnd(0.07, 0.42) * H,
                vx: flock * rnd(1.3, 2.1) * (lead ? 1 : 1.05),
                amp: rnd(8, 22), ph: Math.random() * TAU, phS: rnd(0.025, 0.045),
                flap: Math.random() * TAU, flapS: rnd(0.22, 0.32),
                sc: rnd(1, 1.3) * k
            });
        }

        bakeFogs();
        if (!corn) bakeCorn();
    }

    function bakeFogs() {
        fogW = Math.round(Math.min(1200, Math.max(700, W)));
        fogH = Math.round(Math.max(60, Math.min(150, H * 0.16)));
        fogFar = bakeFog(17, pal.fogFar, 1);
        fogNear = bakeFog(53, pal.fogNear, 0.62);
    }

    function drawFog(ctx, cv, off, y) {
        // whole pixels, or the joins between copies show as hairlines
        var x = -Math.round(off % fogW);
        if (x > 0) x -= fogW;
        for (; x < W; x += fogW) ctx.drawImage(cv, x, y, fogW, fogH);
    }

    // behind the tanks: the far storm bank
    function back(ctx, still) {
        if (!bodies.length) return;
        if (!still) t++;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = pal.fogA[0];
        drawFog(ctx, fogFar, t * 0.18, H - fogH * 1.08);
        if (pal.flash && !still) {
            if (t >= flashAt) { flashI = 0; flashAt = t + 480 + Math.random() * 480; }
            if (flashI < FLASH.length) {
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = Math.min(1, FLASH[flashI++] * pal.flash);
                drawFog(ctx, fogFar, t * 0.18, H - fogH * 1.08);
                ctx.globalCompositeOperation = 'source-over';
            }
        }
        ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // in front of the tanks: the near storm bank and the bats
    function front(ctx, still) {
        if (!bodies.length) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = pal.fogA[1];
        drawFog(ctx, fogNear, t * 0.42 + fogW * 0.37, H - fogH * 0.86);
        ctx.globalAlpha = pal.batA;
        var pad = 60;
        for (var i = 0; i < bats.length; i++) {
            var b = bats[i];
            if (!still) {
                b.x += b.vx;
                b.ph += b.phS;
                b.flap += b.flapS;
            }
            if (b.x > W + pad) { b.x = -pad; b.y0 = (0.07 + Math.random() * 0.35) * H; }
            else if (b.x < -pad) { b.x = W + pad; b.y0 = (0.07 + Math.random() * 0.35) * H; }
            var fs = Math.sin(b.flap);
            var spr = batFrames[fs > 0.35 ? 0 : fs < -0.35 ? 2 : 1];
            var tilt = Math.cos(b.ph) * b.amp * b.phS * 0.6 * (b.vx > 0 ? 1 : -1);
            var c = Math.cos(tilt) * dpr * b.sc, s = Math.sin(tilt) * dpr * b.sc;
            ctx.setTransform(c, s, -s, c, b.x * dpr, (b.y0 + Math.sin(b.ph) * b.amp) * dpr);
            ctx.drawImage(spr.canvas, -spr.pad, -spr.pad, spr.pad * 2, spr.pad * 2);
        }
        ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // A tank's hull, drawn upright over its turning barrels: it only rocks
    // a little, so the face never ends up on its side.
    function body(ctx, key, x, y, still) {
        if (!bodies.length) return;
        var L = bodies[key % bodies.length], ph = key * 7.31;
        var a = Math.sin(t * 0.011 + ph) * 0.09;
        var c = Math.cos(a) * dpr, s = Math.sin(a) * dpr;
        ctx.setTransform(c, s, -s, c, x * dpr, y * dpr);
        var p = L.base.pad, q = L.flick.pad;
        ctx.globalAlpha = 1;
        ctx.drawImage(L.base.canvas, -p, -p, p * 2, p * 2);
        // a candle: a slow breath with a quicker shiver on top
        var fl = 0.62 + 0.24 * Math.sin(t * 0.045 + ph) + 0.14 * Math.sin(t * 0.21 + ph * 1.7);
        ctx.globalAlpha = still ? 0.8 : Math.max(0, Math.min(1, fl));
        ctx.drawImage(L.flick.canvas, -q, -q, q * 2, q * 2);
        ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── candy corn from the menu fireworks (app.js) ────────────────────
    // The same piece as the one after RAID NIGHT (halloween.css): white tip,
    // orange middle, yellow base, ink rim. One sprite, a fixed pool.
    var corn = null, CORN_W = 13, CORN_H = 15;
    function bakeCorn() {
        var S = 3, pw = CORN_W + 4, ph = CORN_H + 4;
        corn = document.createElement('canvas');
        corn.width = pw * S;
        corn.height = ph * S;
        var g = corn.getContext('2d');
        g.setTransform(S * CORN_W / 24, 0, 0, S * CORN_H / 28, S * 2, S * 2);
        var shape = function () {
            g.beginPath();
            g.moveTo(12, 2.5);
            g.quadraticCurveTo(14, 2.5, 15, 5);
            g.lineTo(21.6, 21.4);
            g.quadraticCurveTo(23, 25.5, 18.6, 25.5);
            g.lineTo(5.4, 25.5);
            g.quadraticCurveTo(1, 25.5, 2.4, 21.4);
            g.lineTo(9, 5);
            g.quadraticCurveTo(10, 2.5, 12, 2.5);
            g.closePath();
        };
        g.save();
        shape();
        g.clip();
        g.fillStyle = '#ffc53a'; g.fillRect(0, 0, 24, 28);
        g.fillStyle = '#f27a1a'; g.fillRect(0, 0, 24, 18);
        g.fillStyle = '#fff4dc'; g.fillRect(0, 0, 24, 10.5);
        g.restore();
        shape();
        g.lineJoin = 'round';
        g.lineWidth = 2.6;
        g.strokeStyle = '#1b1510';
        g.stroke();
    }

    var CN = 160;
    var cx = new Float32Array(CN), cy = new Float32Array(CN), cvx = new Float32Array(CN), cvy = new Float32Array(CN);
    var ca = new Float32Array(CN), cs = new Float32Array(CN), cl = new Float32Array(CN), csc = new Float32Array(CN);
    var cNext = 0, cLive = 0;

    function burst(x, y) {
        if (!corn) bakeCorn();
        var n = 11 + (Math.random() * 6 | 0);
        for (var i = 0; i < n; i++) {
            var k = cNext;
            cNext = (cNext + 1) % CN;
            var ang = (i + Math.random()) / n * TAU;
            var spd = 1.8 + Math.random() * 3;
            cx[k] = x; cy[k] = y;
            cvx[k] = Math.cos(ang) * spd;
            cvy[k] = Math.sin(ang) * spd - 1.4;
            ca[k] = Math.random() * TAU;
            cs[k] = (Math.random() - 0.5) * 0.26;
            cl[k] = 70 + Math.random() * 40;
            csc[k] = 0.85 + Math.random() * 0.45;
        }
        cLive = CN;
    }

    // ticks and draws the pool onto ctx, whose plain transform is ratio
    function drawCorn(ctx, ratio) {
        if (!cLive) return;
        var any = 0, w = CORN_W + 4, h = CORN_H + 4;
        for (var k = 0; k < CN; k++) {
            if (cl[k] <= 0) continue;
            any = 1;
            cvy[k] += 0.13;
            cvx[k] *= 0.985;
            cvy[k] *= 0.99;
            cx[k] += cvx[k];
            cy[k] += cvy[k];
            ca[k] += cs[k];
            cl[k] -= 1;
            var c = Math.cos(ca[k]) * ratio * csc[k], s = Math.sin(ca[k]) * ratio * csc[k];
            ctx.setTransform(c, s, -s, c, cx[k] * ratio, cy[k] * ratio);
            ctx.globalAlpha = Math.min(1, cl[k] / 22);
            ctx.drawImage(corn, -w / 2, -h / 2, w, h);
        }
        if (!any) cLive = 0;
        ctx.globalAlpha = 1;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function guns() { return pal.guns; }

    window.dwHalloweenFx = { build: build, back: back, front: front, body: body, guns: guns, burst: burst, corn: drawCorn };
})();
