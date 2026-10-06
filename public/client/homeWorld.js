// The menu's background: a slice of a raid
(function () {
    'use strict';

    var TAU = Math.PI * 2, DEG = Math.PI / 180;
    // the ore's cut (terrainRenderer.js GEM_CUT)
    var GEM_CUT = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
    // by tier (terrainRenderer.js ORE_PAL): dark, mid, light, core
    var ORE = {
        1: ['#5a2c0e', '#c96f2e', '#eda766', '#ffe9d1'],
        2: ['#0e2c5a', '#3b7ce0', '#7fb1f2', '#e2f0ff'],
        3: ['#3d0e4a', '#b13ecf', '#d98af0', '#fbe6ff'],
        4: ['#12804a', '#1fbf6b', '#6ff5a8', '#e6fff1']
    };
    // a break's streaks (terrainRenderer.js FW_COLORS / ORE_FX) and crack colours of
    var FW_CSS = ['rgb(164,14,14)', 'rgb(230,80,0)', 'rgb(230,119,0)', 'rgb(47,127,51)', 'rgb(23,78,166)', 'rgb(123,31,163)'];
    var ORE_FX_CSS = {
        1: ['rgb(201,111,46)', 'rgb(237,167,102)', 'rgb(160,80,30)'],
        2: ['rgb(59,124,224)', 'rgb(127,177,242)', 'rgb(35,90,180)'],
        3: ['rgb(177,62,207)', 'rgb(217,138,240)', 'rgb(130,40,160)'],
        4: ['rgb(31,191,107)', 'rgb(111,245,168)', 'rgb(18,128,72)']
    };
    var CRACK_ORE = {
        1: { hot: [235, 140, 60], hair: [255, 218, 175] },
        2: { hot: [80, 150, 255], hair: [190, 222, 255] },
        3: { hot: [200, 95, 240], hair: [242, 205, 255] },
        4: { hot: [60, 225, 135], hair: [205, 255, 228] }
    };
    // the raid's team colours, a darker rim, the same grey barrels
    var TANKS = [['#00b2e1', '#0a5d78'], ['#f14e54', '#86262a'], ['#be7ff5', '#5d3a85'], ['#00e16e', '#0b7a41']];
    var GUN = '#a7a7af', GUN_LINE = '#55555c';
    var FLOOR = '#1b191f', FLOOR_RGB = [27, 25, 31];
    var FONT = "px 'Lilita One', Rubik, sans-serif";

    // Tank builds, from server/lib/definitions/groups/tanks.js
    function mirror(g) { return [g, [g[0], g[1], g[2], g[3], -g[4], -g[5], g[6]]]; }
    var BUILDS = [
        { n: 'Triplet', R: 0.55, D: 1, V: 18, guns: mirror([17.5, 8, 1, 0, 5.5, 0, 0.5]).concat([[21, 8, 1, 0, 0, 0, 0]]) },
        { n: 'Penta Shot', R: 0.62, D: 1, V: 18, guns: mirror([16, 8, 1, 0, 3, 30, 2 / 3]).concat(mirror([19, 8, 1, 0, 2, 15, 1 / 3]), [[22, 8, 1, 0, 0, 0, 0]]) },
        { n: 'Twin', R: 0.5, D: 1, V: 18, guns: [[20, 8, 1, 0, 5.5, 0, 0], [20, 8, 1, 0, -5.5, 0, 0.5]] },
        { n: 'Machine Gun', R: 0.2, D: 0.36, V: 18, spread: 0.12, guns: [[12, 10, 1.4, 8, 0, 0, 0]] },
        { n: 'Minigun', R: 0.48, D: 0.95, V: 18, guns: [[21, 8, 1, 0, 0, 0, 0], [19, 8, 1, 0, 0, 0, 1 / 3], [17, 8, 1, 0, 0, 0, 2 / 3]] },
        { n: 'Sniper', R: 0.95, D: 1.7, V: 28, guns: [[24, 8, 1, 0, 0, 0, 0]] },
        { n: 'Assassin', R: 1.05, D: 1.9, V: 30, guns: [[27, 8, 1, 0, 0, 0, 0], [13, 8, -2.2, 0, 0, 0, -1]] },
        { n: 'Pounder', R: 0.85, D: 1.6, V: 15, guns: [[20.5, 12, 1, 0, 0, 0, 0]] },
        { n: 'Destroyer', R: 1.15, D: 2.3, V: 13, guns: [[20.5, 14, 1, 0, 0, 0, 0]] },
        { n: 'Spreadshot', R: 0.72, D: 1, V: 18, guns: mirror([13, 4, 1, 0, 0.8, 71.5, 5 / 6]).concat(mirror([14.5, 4, 1, 0, 1, 56.5, 4 / 6]), mirror([16, 4, 1, 0, 1.2, 41.5, 3 / 6]), mirror([17.5, 4, 1, 0, 1.4, 26.5, 2 / 6]), mirror([19, 4, 1, 0, 1, 15, 1 / 6]), [[20, 8, 1, 0, 0, 0, 0]]) },
        { n: 'Octo Tank', R: 0.5, D: 0.9, V: 18, guns: [0, 1, 2, 3].reduce(function (a, k) { return a.concat([[18, 8, 1, 0, 0, 45 + k * 90, 0.5], [18, 8, 1, 0, 0, k * 90, 0]]); }, []) },
        { n: 'Triple Shot', R: 0.55, D: 1, V: 18, guns: mirror([19, 8, 1, 0, 2, 18, 0.5]).concat([[22, 8, 1, 0, 0, 0, 0]]) }
    ];
    // per build: guns in radians
    BUILDS.forEach(function (b) {
        var nMain = 0;
        b.g = b.guns.map(function (q) {
            var a = q[5] > 180 ? q[5] - 360 : q[5];
            var o = { L: q[0] / 10, Wd: q[1] / 10, asp: q[2], X: q[3] / 10, Y: q[4] / 10, a: a * DEG, delay: q[6], fire: q[6] >= 0 && Math.abs(a) <= 75, main: q[6] >= 0 && Math.abs(a) <= 20 };
            if (o.main) nMain++;
            return o;
        });
        b.nMain = nMain || 1;
    });

    // cell states
    var OPEN = 0, SOLID = 1, DUG = 2, LIFT = 3, GROW = 4;
    // tank modes
    var DIG = 0, BANK = 1, DUEL = 2;

    var W = 0, H = 0, dpr = 1, light = false;
    var s = 70, cols = 0, rows = 0, NR = 0, P = 0;
    var Z = null;      // the scene being drawn or simulated (live, or the bake's)
    var live = null;   // the scene on screen
    var bake = null;   // the one being baked
    var vign = null, vignFor = '';
    var off = 0, lastT = 0;
    var seed = 1;
    var rs = 1;        // the script's own random stream (repeatable)
    function rnd() { rs = (rs * 16807) % 2147483647; return (rs - 1) / 2147483646; }

    function setScene(S) {
        Z = S; var g = S.g;
        W = g.W; H = g.H; dpr = g.dpr; light = g.light; s = g.s; cols = g.cols; rows = g.rows; NR = g.NR; P = g.P;
    }

    function h2(i, j, k) {
        var x = Math.sin(i * 127.1 + j * 311.7 + k * 74.7 + seed * 13.13) * 43758.5453;
        return x - Math.floor(x);
    }
    function wrapI(i) { return ((i % cols) + cols) % cols; }
    function seedAt(i, j) {
        var ii = wrapI(i), sh = (i - ii) / cols * P;
        return [(ii + 0.5 + (h2(ii, j, 1) - 0.5) * 0.8) * s + sh, (j + 0.5 + (h2(ii, j, 2) - 0.5) * 0.8) * s];
    }
    // half-plane clip: keep the side of the bisector nearer a
    function clip(poly, a, b) {
        var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, nx = b[0] - a[0], ny = b[1] - a[1];
        var out = [];
        for (var k = 0; k < poly.length; k++) {
            var p = poly[k], q = poly[(k + 1) % poly.length];
            var dp = (p[0] - mx) * nx + (p[1] - my) * ny, dq = (q[0] - mx) * nx + (q[1] - my) * ny;
            if (dp <= 0) out.push(p);
            if ((dp < 0) !== (dq < 0) && dp !== dq) {
                var t = dp / (dp - dq);
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
        return out;
    }
    function cellPoly(i, j) {
        var a = seedAt(i, j);
        var poly = [[a[0] - 2 * s, a[1] - 2 * s], [a[0] + 2 * s, a[1] - 2 * s], [a[0] + 2 * s, a[1] + 2 * s], [a[0] - 2 * s, a[1] + 2 * s]];
        for (var di = -2; di <= 2; di++) for (var dj = -2; dj <= 2; dj++) {
            if (!di && !dj) continue;
            poly = clip(poly, a, seedAt(i + di, j + dj));
            if (poly.length < 3) break;
        }
        return poly;
    }
    // distance from a point to a polygon's border, and whether it is inside (the
    var PD = { d: 0, inside: false, qx: 0, qy: 0 };
    function polyDist(poly, ori, px, py) {
        var m = poly.length, bd = Infinity, inside = true;
        for (var e = 0; e < m; e++) {
            var a = poly[e], b = poly[e + 1 < m ? e + 1 : 0];
            var ex = b[0] - a[0], ey = b[1] - a[1];
            if ((ex * (py - a[1]) - ey * (px - a[0])) * ori < 0) inside = false;
            var L2 = ex * ex + ey * ey || 1e-9;
            var t = ((px - a[0]) * ex + (py - a[1]) * ey) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            var qx = a[0] + ex * t, qy = a[1] + ey * t, d = (px - qx) * (px - qx) + (py - qy) * (py - qy);
            if (d < bd) { bd = d; PD.qx = qx; PD.qy = qy; }
        }
        PD.d = Math.sqrt(bd); PD.inside = inside;
        return PD;
    }
    function polyOri(poly) {
        var a = 0;
        for (var k = 0; k < poly.length; k++) { var p = poly[k], q = poly[(k + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
        return a < 0 ? -1 : 1;
    }
    // the point deepest inside a cell (its pole of inaccessibility, like the game
    function poleOf(poly, ori) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (var v = 0; v < poly.length; v++) { x0 = Math.min(x0, poly[v][0]); x1 = Math.max(x1, poly[v][0]); y0 = Math.min(y0, poly[v][1]); y1 = Math.max(y1, poly[v][1]); }
        var bx = (x0 + x1) / 2, by = (y0 + y1) / 2, br = -1, sx = (x1 - x0) / 8, sy = (y1 - y0) / 8;
        for (var pass = 0; pass < 3; pass++) {
            var cx = bx, cy = by;
            for (var i = -4; i <= 4; i++) for (var j = -4; j <= 4; j++) {
                var px = cx + i * sx, py = cy + j * sy, q = polyDist(poly, ori, px, py);
                if (q.inside && q.d > br) { br = q.d; bx = px; by = py; }
            }
            sx /= 4; sy /= 4;
        }
        return [bx, by, Math.max(0, br)];
    }
    // the shortest x distance on the wrapped strip
    function dxw(a, b) { var d = a - b; d -= Math.round(d / P) * P; return d; }
    function segDist(px, py, a, b) {
        var ax = a[0], ay = a[1], bx = ax + dxw(b[0], ax), by = b[1];
        var qx = ax + dxw(px, ax);
        var vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy || 1;
        var t = Math.max(0, Math.min(1, ((qx - ax) * vx + (py - ay) * vy) / L));
        return Math.hypot(qx - ax - vx * t, py - ay - vy * t);
    }

    // a biome blend along the strip, so a pan walks through several
    var ORDER = ['crystal', 'moss', 'sandstone', 'clay', 'magma', 'obsidian'];
    function biomeTones(x, y) {
        var B = window.DWBiomes && window.DWBiomes.BIOMES;
        if (!B) return null;
        var u = ((x / P) + 0.08 * Math.sin(y / H * 5.1 + 1.3) + 1) % 1;
        var f = u * ORDER.length, i0 = Math.floor(f) % ORDER.length, i1 = (i0 + 1) % ORDER.length, t = f - Math.floor(f);
        t = t < 0.78 ? 0 : (t - 0.78) / 0.22; t = t * t * (3 - 2 * t);
        var a = B[window.DWBiomes.IDX[ORDER[i0]]], b = B[window.DWBiomes.IDX[ORDER[i1]]];
        var out = {};
        ['ink', 'dark', 'face', 'light', 'rim'].forEach(function (k) {
            out[k] = [0, 1, 2].map(function (q) { return a[k][q] + (b[k][q] - a[k][q]) * t; });
        });
        out.rimA = a.rimA + (b.rimA - a.rimA) * t;
        return out;
    }
    function css(c, m, a) {
        m = m || 0;
        return 'rgba(' + Math.round(Math.min(255, c[0] * (1 + m))) + ',' + Math.round(Math.min(255, c[1] * (1 + m))) + ',' + Math.round(Math.min(255, c[2] * (1 + m))) + ',' + (a == null ? 1 : a) + ')';
    }
    // the colour as it looks under the scrim baked over the field (the bake is dimmed
    var DIM_DARK = [10, 8, 14, 0.1], DIM_LIGHT = [234, 219, 182, 0.3];
    function dimOf() { return light ? DIM_LIGHT : DIM_DARK; }
    function cssDim(c, m, a) {
        var D = dimOf(), k = 1 + (m || 0), d = D[3];
        return 'rgba(' + Math.round(Math.min(255, c[0] * k) * (1 - d) + D[0] * d) + ',' + Math.round(Math.min(255, c[1] * k) * (1 - d) + D[1] * d) + ',' + Math.round(Math.min(255, c[2] * k) * (1 - d) + D[2] * d) + ',' + (a == null ? 1 : a) + ')';
    }
    function dimCss() { var D = dimOf(); return 'rgba(' + D[0] + ',' + D[1] + ',' + D[2] + ',' + D[3] + ')'; }

    function gemPath(c, x, y, r, rot, sc, ox, oy) {
        var cs = Math.cos(rot), sn = Math.sin(rot);
        c.beginPath();
        for (var k = 0; k < GEM_CUT.length; k++) {
            var px = GEM_CUT[k][0] * r * sc + ox, py = GEM_CUT[k][1] * r * sc + oy;
            var wx = px * cs - py * sn, wy = px * sn + py * cs;
            if (k) c.lineTo(x + wx, y + wy); else c.moveTo(x + wx, y + wy);
        }
        c.closePath();
    }
    function drawGem(c, x, y, r, rot, tier, halo) {
        var o = ORE[tier] || ORE[1];
        if (halo) {
            c.fillStyle = 'rgba(8,6,10,0.35)';
            c.beginPath(); c.arc(x, y, r * 1.55, 0, TAU); c.fill();
        }
        c.lineJoin = 'round';
        gemPath(c, x, y, r, rot, 1, 0, 0);
        c.fillStyle = o[1]; c.fill();
        c.lineWidth = Math.max(1.5, r * 0.22); c.strokeStyle = o[0]; c.stroke();
        gemPath(c, x, y, r, rot, 0.52, 0, -r * 0.12); c.fillStyle = o[2]; c.fill();
        gemPath(c, x, y, r, rot, 0.2, -r * 0.22, -r * 0.3); c.fillStyle = o[3]; c.fill();
    }
    // the game's gun: a trapezoid from its base (X, Y turned by its angle) out along
    function gunPath(c, x, y, ang, g, r, rec) {
        var a = ang + g.a, ca = Math.cos(a), sa = Math.sin(a);
        var bx = x + (g.X * ca - g.Y * sa) * r, by = y + (g.X * sa + g.Y * ca) * r;
        var L = g.L * r * (1 - rec * 0.1), hw = g.Wd * r / 2;
        var hm = g.asp > 0 ? hw * g.asp : hw, hb = g.asp > 0 ? hw : -hw * g.asp;
        c.beginPath();
        c.moveTo(bx - sa * hb, by + ca * hb);
        c.lineTo(bx + ca * L - sa * hm, by + sa * L + ca * hm);
        c.lineTo(bx + ca * L + sa * hm, by + sa * L - ca * hm);
        c.lineTo(bx + sa * hb, by - ca * hb);
        c.closePath();
    }
    function drawTank(c, x, y, t) {
        var r = t.r, G = t.build.g;
        c.lineJoin = 'round';
        c.lineWidth = Math.max(2, r * 0.16);
        c.fillStyle = GUN; c.strokeStyle = GUN_LINE;
        for (var k = 0; k < G.length; k++) {
            gunPath(c, x, y, t.ang, G[k], r, t.rec[k]);
            c.fill(); c.stroke();
        }
        c.beginPath(); c.arc(x, y, r, 0, TAU);
        c.fillStyle = t.col[0]; c.fill(); c.strokeStyle = t.col[1]; c.stroke();
    }
    function drawVault(c, x, y, R) {
        function oct(rr, oy) {
            c.beginPath();
            for (var k = 0; k < 8; k++) { var a = Math.PI / 8 + k * Math.PI / 4; var px = x + Math.cos(a) * rr, py = y + (oy || 0) + Math.sin(a) * rr; if (k) c.lineTo(px, py); else c.moveTo(px, py); }
            c.closePath();
        }
        oct(R * 1.22, R * 0.08); c.fillStyle = 'rgba(8,6,10,0.55)'; c.fill();
        oct(R * 1.22); c.fillStyle = '#26324a'; c.fill(); c.lineWidth = 3; c.strokeStyle = '#0e1220'; c.stroke();
        oct(R * 1.08); c.lineWidth = Math.max(2, R * 0.07); c.strokeStyle = '#7fb1f2'; c.stroke();
        c.beginPath(); c.arc(x, y, R * 0.86, 0, TAU); c.fillStyle = '#2a2a33'; c.fill(); c.lineWidth = Math.max(2.5, R * 0.08); c.strokeStyle = '#c5cad6'; c.stroke();
        c.lineWidth = Math.max(2, R * 0.06); c.strokeStyle = '#8a8f9c';
        for (var k = 0; k < 3; k++) {
            var a = -Math.PI / 2 + k * TAU / 3;
            c.beginPath(); c.moveTo(x + Math.cos(a) * R * 0.3, y + Math.sin(a) * R * 0.3); c.lineTo(x + Math.cos(a) * R * 0.72, y + Math.sin(a) * R * 0.72); c.stroke();
        }
        drawGem(c, x, y + R * 0.02, R * 0.3, 0, 2, false);
        c.font = Math.round(Math.max(13, R * 0.34)) + FONT;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 4; c.strokeStyle = '#0c0a0e'; c.strokeText('Vault', x, y - R * 1.5);
        c.fillStyle = '#fff3d9'; c.fillText('Vault', x, y - R * 1.5);
    }

    var LIT = [-0.55, -0.83];
    function facetCenter(poly) {
        var cx = 0, cy = 0, m = poly.length;
        for (var v = 0; v < m; v++) { cx += poly[v][0]; cy += poly[v][1]; }
        return [cx / m + LIT[0] * s * 0.12, cy / m + LIT[1] * s * 0.12];
    }
    function facetTone(tn, p0, p1) {
        var ex = p1[0] - p0[0], ey = p1[1] - p0[1], el = Math.hypot(ex, ey) || 1;
        // the edge's outward normal against the light
        var dot = (ey / el) * LIT[0] + (-ex / el) * LIT[1];
        return dot > 0.3 ? tn.light : dot < -0.3 ? tn.dark : tn.face;
    }
    function inkW() { return Math.max(2.5, s * 0.06); }
    // the ore gem: at the cell's pole, small enough that its halo clears the cell's
    function gemFit(ce) {
        return Math.min(s * 0.2, Math.max(0, ce.pr - inkW() * 0.5 - 1) / 1.55);
    }
    function drawCell(c, ce, shift) {
        var tn = ce.tn;
        if (!tn) return;
        var vary = (h2(ce.i, ce.j, 16) - 0.5) * 0.12;
        var poly = ce.poly, m = poly.length;
        c.save();
        c.translate(shift, 0);
        // the facet point, nudged toward the light
        var fc = facetCenter(poly), cx = fc[0], cy = fc[1];
        for (var e = 0; e < m; e++) {
            var p0 = poly[e], p1 = poly[(e + 1) % m];
            var col = css(facetTone(tn, p0, p1), vary);
            c.beginPath(); c.moveTo(cx, cy); c.lineTo(p0[0], p0[1]); c.lineTo(p1[0], p1[1]); c.closePath();
            c.fillStyle = col; c.fill();
            c.lineWidth = 0.8; c.strokeStyle = col; c.stroke();
        }
        polyPath(c, poly, 0);
        c.save(); c.clip();
        c.lineWidth = s * 0.08; c.strokeStyle = css(tn.rim, 0, Math.min(0.5, tn.rimA + 0.1)); c.stroke();
        c.restore();
        c.lineJoin = 'round'; c.lineWidth = inkW(); c.strokeStyle = css(tn.ink, -0.25); c.stroke();
        var gr = gemFit(ce);
        if (ce.ore && gr > 2) drawGem(c, ce.px, ce.py, gr, (h2(ce.i, ce.j, 19) - 0.5) * 0.9, ce.ore, true);
        c.restore();
    }
    function bakeCellAt(ce, shift, c) { drawCell(c, ce, shift); }
    function polyPath(c, poly, ox) {
        c.beginPath();
        for (var v = 0; v < poly.length; v++) { if (v) c.lineTo(poly[v][0] + ox, poly[v][1]); else c.moveTo(poly[v][0] + ox, poly[v][1]); }
        c.closePath();
    }

    // ── the bake ──────────────────────────────────────────────────────
    function build(w, h, ratio, isLight) {
        var t0 = performance.now();
        var G = { W: w, H: h, light: !!isLight };
        G.s = Math.max(46, Math.min(78, Math.round(Math.min(w, h * 1.6) / 15)));
        G.cols = Math.max(8, Math.ceil(w / G.s));
        G.P = G.cols * G.s;
        G.rows = Math.ceil(h / G.s) + 1;
        G.NR = G.rows + 2;
        G.dpr = Math.min(ratio || 1, 2, Math.sqrt(7e6 / Math.max(1, G.P * h)));
        var S = { g: G };
        var prev = Z;
        setScene(S);
        seed = 3; rs = 977;
        // baked into a second canvas a slice at a time (step), swapped in when it is
        var cv = document.createElement('canvas');
        cv.width = Math.ceil(P * dpr); cv.height = Math.ceil(H * dpr);
        var c = cv.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.fillStyle = FLOOR; c.fillRect(0, 0, P, H);
        // floor grit
        c.fillStyle = 'rgba(0,0,0,0.28)';
        for (var g = 0; g < P * H / 2600; g++) {
            c.beginPath(); c.arc(h2(g, 7, 5) * P, h2(g, 9, 6) * H, 1 + h2(g, 3, 7) * 3.5, 0, TAU); c.fill();
        }

        // the scene: a vault, tanks at the ends of the tunnels they dug
        var small = W < 700;
        var vault = [P * 0.16, H * (small ? 0.78 : 0.64)];
        var spots = small
            ? [[P * 0.52, H * 0.86, -0.4], [P * 0.86, H * 0.2, 2.6]]
            : [[P * 0.42, H * 0.84, -0.5], [P * 0.66, H * 0.3, 0.3], [P * 0.88, H * 0.72, 2.9], [P * 0.3, H * 0.16, -2.2]];
        var tunnels = [];
        spots.forEach(function (sp) {
            var mid = [(vault[0] + sp[0]) / 2 + (h2(sp[0], 1, 9) - 0.5) * s * 3, (vault[1] + sp[1]) / 2 + (h2(sp[1], 2, 9) - 0.5) * s * 2];
            tunnels.push([vault, mid], [mid, [sp[0], sp[1]]]);
        });
        var n = cols * NR;
        S.n = n;
        S.SX = new Float32Array(n); S.SY = new Float32Array(n);
        S.ST = new Uint8Array(n); S.BLOCK = new Uint8Array(n);
        S.DUGAT = new Float32Array(n); S.CELL = new Array(n);
        var cells = [], loose = [];
        for (var i = 0; i < cols; i++) for (var j = -1; j <= rows; j++) {
            var gi = i * NR + j + 1;
            var sd = seedAt(i, j);
            S.SX[gi] = sd[0]; S.SY[gi] = sd[1];
            var vd = Math.hypot(dxw(sd[0], vault[0]), sd[1] - vault[1]);
            // tanks keep off the screen's edge rows and out of the vault
            if (j < 0 || j >= rows || sd[1] < s * 0.6 || sd[1] > H - s * 0.6 || vd < s * 1.25) S.BLOCK[gi] = 1;
            var open = vd < s * 1.9;
            for (var q = 0; q < tunnels.length && !open; q++) if (segDist(sd[0], sd[1], tunnels[q][0], tunnels[q][1]) < s * 0.5) open = true;
            if (!open && h2(i, j, 11) < 0.035) open = true;
            if (open) {
                S.ST[gi] = OPEN;
                // a loose gem now and then where the rock was dug out
                if (h2(i, j, 12) < 0.16) loose.push({ x: sd[0], y: sd[1], tier: 1 + (h2(i, j, 13) * 3 | 0) });
                continue;
            }
            var ore = h2(i, j, 14) < 0.2 ? (h2(i, j, 15) < 0.55 ? 1 : h2(i, j, 15) < 0.85 ? 2 : 3) : 0;
            var poly = cellPoly(i, j), ori = polyOri(poly);
            var x0 = Infinity, x1 = -Infinity;
            for (var v = 0; v < poly.length; v++) { x0 = Math.min(x0, poly[v][0]); x1 = Math.max(x1, poly[v][0]); }
            var pole = poleOf(poly, ori);
            var tn = biomeTones(sd[0], sd[1]);
            var cell = { i: i, j: j, g: gi, poly: poly, ori: ori, x: sd[0], y: sd[1], px: pole[0], py: pole[1], pr: pole[2], ore: ore, x0: x0, x1: x1, tn: tn,
                ink: tn ? cssDim(tn.ink, -0.25) : '#000', fx: null, crk: null };
            S.CELL[gi] = cell; S.ST[gi] = SOLID;
            cells.push(cell);
        }
        S.solid0 = cells.length;
        S.dug = 0;

        // who borders whom: a pair of cells a tank can drive between (no third seed
        S.NB = new Int16Array(n * 8); S.NBN = new Uint8Array(n);
        for (var a = 0; a < n; a++) {
            var ai = (a / NR) | 0, aj = a % NR;
            for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
                if (!di && !dj) continue;
                var bj = aj + dj; if (bj < 0 || bj >= NR) continue;
                var b = wrapI(ai + di) * NR + bj;
                var mx = S.SX[a] + dxw(S.SX[b], S.SX[a]) / 2, my = (S.SY[a] + S.SY[b]) / 2;
                var r2 = Math.pow(dxw(S.SX[a], mx), 2) + Math.pow(S.SY[a] - my, 2);
                var ok = true;
                for (var ci = -1; ci <= 2 && ok; ci++) for (var cj = -1; cj <= 2 && ok; cj++) {
                    var oi = ai + (di < 0 ? ci - 1 : ci), oj = aj + (dj < 0 ? cj - 1 : cj);
                    if (oj < 0 || oj >= NR) continue;
                    var o = wrapI(oi) * NR + oj;
                    if (o === a || o === b) continue;
                    if (Math.pow(dxw(S.SX[o], mx), 2) + Math.pow(S.SY[o] - my, 2) < r2 * 1.08) ok = false;
                }
                if (ok && S.NBN[a] < 8) S.NB[a * 8 + S.NBN[a]++] = b;
            }
        }
        // path search scratch
        S.D = new Float32Array(n); S.PV = new Int16Array(n); S.DONE = new Uint8Array(n);
        S.HQ = new Int32Array(n * 9 + 8); S.HPR = new Float32Array(n * 9 + 8);

        S.vault = vault;
        S.floor = cssDim(FLOOR_RGB);
        var Dm = dimOf(), fg = FLOOR_RGB[1], fd = fg * (1 - Dm[3]) + Dm[1] * Dm[3];
        S.grit = 'rgba(0,0,0,' + Math.max(0.03, 1 - (fg * 0.72 * (1 - Dm[3]) + Dm[1] * Dm[3]) / fd).toFixed(3) + ')';
        S.dim = dimCss();
        S.ring = cssDim([110, 100, 125]);
        S.fontPop = Math.round(s * 0.26) + FONT;
        S.fontBank = Math.round(Math.max(15, s * 0.32)) + FONT;
        S.t = 0; S.nextDuel = 24 + rnd() * 14; S.nextGrow = 6;
        S.stat = { breaks: 0, gems: 0, banks: 0, regrows: 0, duels: 0, shots: 0, stuck: 0 };
        // a different mix of builds every visit (window.dwHomeWorldBuilds pins them, for
        var pick = BUILDS.slice(), pinned = window.dwHomeWorldBuilds;
        for (var pi = pick.length - 1; pi > 0; pi--) { var pj = (Math.random() * (pi + 1)) | 0, tmp = pick[pi]; pick[pi] = pick[pj]; pick[pj] = tmp; }
        S.tanks = spots.map(function (sp, k) {
            // start on open floor: the nearest tunnel cell to the spot
            var bestG = -1, bestD = Infinity;
            for (var q1 = 0; q1 < n; q1++) {
                if (S.ST[q1] !== OPEN || S.BLOCK[q1]) continue;
                var dd = Math.hypot(dxw(S.SX[q1], sp[0]), S.SY[q1] - sp[1]);
                if (dd < bestD) { bestD = dd; bestG = q1; }
            }
            if (bestG >= 0) sp = [S.SX[bestG], S.SY[bestG], sp[2]];
            var bd = pick[k];
            if (pinned && pinned[k]) for (var q2 = 0; q2 < BUILDS.length; q2++) if (BUILDS[q2].n === pinned[k]) bd = BUILDS[q2];
            return { k: k, x: sp[0], y: sp[1], cur: nodeAt(sp[0], sp[1]), ang: sp[2], col: TANKS[k % TANKS.length], r: s * 0.34, build: bd,
                rec: new Float32Array(bd.g.length), gq: new Float32Array(bd.g.length).fill(-1),
                home: sp[0], mode: DIG, path: new Int16Array(64), pi: 0, pn: 0, wait: 0.35 + k * 0.3, fire: 0, hit: 0,
                gems: 0, bankAt: 90 + ((rnd() * 4) | 0) * 15, foe: -1, volleys: 0, slot: -1, vslot: -1, blk: -1, hitG: -1, hitT: 0,
                bestD: Infinity, prog: 0, unstick: 0, ghost: 0, idle: 0 };
        });
        S.bullets = pool(48, function () { return { on: 0, x: 0, y: 0, vx: 0, vy: 0, d: 0, t: 0, k: 0, kind: 0, tgt: 0, g: -1, dmg: 0, v: 620, r: 4 }; });
        S.chips = pool(40, function () { return { on: 0, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, t: 0, life: 1, col: '', sz: 0 }; });
        S.bursts = pool(6, function () { return { on: 0, t: 0, ce: null, x: 0, y: 0, parts: new Float32Array(BURST_CHIPS * 8), sparks: new Float32Array(BURST_SPARKS * 3), nS: 0, pal: FW_CSS, cc: null }; });
        S.pops = pool(14, function () { return { on: 0, kind: 0, t: 0, x: 0, y: 0, tk: 0, tier: 1, rot: 0, label: '', n: 0 }; });
        S.slots = pool(8, function () { return { on: 0, cv: null, c: null, g: 0, mode: LIFT, owner: -1, hp: 0, hp0: 0, pend: 0, stage: 0, flash: 0, shake: 0, t: 0, ox: 0, oy: 0 }; });

        bake = { S: S, cv: cv, c: c, cells: cells, loose: loose, n: 0, vault: vault, ms: performance.now() - t0, slices: 1 };
        S.cv = cv; S.c = c;
        if (prev) setScene(prev);
    }
    function pool(n, mk) { var a = []; for (var i = 0; i < n; i++) a.push(mk()); return a; }
    function shifts(ce, fn, arg) {
        fn(ce, 0, arg);
        if (ce.x0 < 0) fn(ce, P, arg);
        if (ce.x1 > P) fn(ce, -P, arg);
    }
    // Draw rocks for up to `budget` ms
    function step(budget) {
        var b = bake;
        if (!b) return !!(live && live.cv);
        var prev = Z;
        setScene(b.S);
        var t0 = performance.now(), c = b.c, cells = b.cells;
        b.slices++;
        while (b.n < cells.length) {
            var ce = cells[b.n++];
            // a rock across the strip's seam is drawn on both sides of it
            shifts(ce, bakeCellAt, c);
            if ((b.n & 15) === 0 && performance.now() - t0 > budget) {
                b.ms += performance.now() - t0;
                if (prev && prev !== b.S) setScene(prev);
                return false;
            }
        }
        for (var lz = 0; lz < b.loose.length; lz++) drawGem(c, b.loose[lz].x, b.loose[lz].y, s * 0.11, h2(lz, 2, 3) * 2, b.loose[lz].tier, false);
        // dim it all: the menu's panels sit on this
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.fillStyle = dimCss();
        c.fillRect(0, 0, b.cv.width, b.cv.height);
        // the vault is its own sprite over the field, so a rock dug out next to it never
        var R = s * 0.92, vw = R * 3.6, vh = R * 3.6, vc = document.createElement('canvas');
        vc.width = Math.ceil(vw * dpr); vc.height = Math.ceil(vh * dpr);
        var vx = vc.getContext('2d');
        vx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawVault(vx, vw / 2, R * 2, R);
        vx.setTransform(1, 0, 0, 1, 0, 0);
        vx.globalCompositeOperation = 'source-atop';
        vx.fillStyle = b.S.dim; vx.fillRect(0, 0, vc.width, vc.height);
        b.S.vcv = vc; b.S.vw = vw; b.S.vh = vh; b.S.vy0 = b.vault[1] - R * 2;
        if (live && live.cv) { live.cv.width = 0; live.cv.height = 0; live.vcv.width = 0; }
        // the old scene's sprites are the new one's if the size matches
        if (live) for (var q = 0; q < live.slots.length; q++) b.S.slots[q].cv = live.slots[q].cv;
        live = b.S; bake = null;
        vignFor = '';
        b.ms += performance.now() - t0;
        window.dwHomeWorldStat = { bakeMs: Math.round(b.ms), slices: b.slices, at: Math.round(performance.now()), px: live.cv.width + 'x' + live.cv.height, cell: s };
        return true;
    }

    // ── the field, live: lifting, breaking and growing back ──────────────
    function nodeAt(x, y) {
        x = ((x % P) + P) % P;
        var i0 = Math.floor(x / s), j0 = Math.floor(y / s), best = -1, bd = Infinity;
        for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
            var j = j0 + dj; if (j < -1 || j > rows) continue;
            var g = wrapI(i0 + di) * NR + j + 1;
            var dx = dxw(Z.SX[g], x), dy = Z.SY[g] - y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = g; }
        }
        return best;
    }
    function isOpen(st) { return st === OPEN || st === DUG; }
    // the cell's place in the bake becomes floor
    function floorAt(ce, shift) {
        var c = Z.c, poly = ce.poly;
        c.setTransform(dpr, 0, 0, dpr, shift * dpr, 0);
        c.lineJoin = 'round';
        polyPath(c, poly, 0);
        c.fillStyle = Z.floor; c.fill();
        c.lineWidth = inkW() + 1; c.strokeStyle = Z.floor; c.stroke();
        c.save(); c.clip();
        c.fillStyle = Z.grit;
        for (var k = 0; k < 3; k++) {
            c.beginPath();
            c.arc(ce.x + (h2(ce.i, ce.j, 40 + k) - 0.5) * s * 0.8, ce.y + (h2(ce.i, ce.j, 50 + k) - 0.5) * s * 0.8, 1 + h2(ce.i, ce.j, 60 + k) * 3, 0, TAU);
            c.fill();
        }
        c.restore();
        c.lineWidth = inkW();
        for (var di = -2; di <= 2; di++) for (var dj = -2; dj <= 2; dj++) {
            if (!di && !dj) continue;
            var jj = ce.j + dj + 1; if (jj < 0 || jj >= NR) continue;
            var ii = ce.i + di, g = wrapI(ii) * NR + jj;
            if (Z.ST[g] !== SOLID) continue;
            var nb = Z.CELL[g];
            if (!nb) continue;
            var sh2 = ii < 0 ? -P : ii >= cols ? P : 0;
            polyPath(c, nb.poly, sh2);
            c.strokeStyle = nb.ink; c.stroke();
        }
    }
    function stampAt(ce, shift, sl) {
        var c = Z.c;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.drawImage(sl.cv, sl.ox + shift * dpr, sl.oy);
    }
    var HALF_K = 1.35;
    // a rock alone on its sprite, with `stage` cracks, under the scrim
    function renderSprite(sl, ce, stage) {
        var half = s * HALF_K, sz = Math.ceil(half * 2 * dpr) + 2;
        if (!sl.cv) { sl.cv = document.createElement('canvas'); }
        if (sl.cv.width !== sz) { sl.cv.width = sz; sl.cv.height = sz; }
        var c = sl.c = sl.cv.getContext('2d');
        sl.ox = Math.floor((ce.x - half) * dpr); sl.oy = Math.floor((ce.y - half) * dpr);
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
        c.clearRect(0, 0, sz, sz);
        c.setTransform(dpr, 0, 0, dpr, -sl.ox, -sl.oy);
        drawCell(c, ce, 0);
        if (stage > 0) drawCracks(c, ce, stage);
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = 'source-atop';
        c.fillStyle = Z.dim; c.fillRect(0, 0, sz, sz);
        c.globalCompositeOperation = 'source-over';
    }
    // Cracks the game's way (terrainRenderer.js _getCrackPath and its draw): one more
    var CRACK_STAGES = 5;
    function drawCracks(c, ce, stage) {
        if (!ce.crk) {
            var poly = ce.poly, out = [], off0 = h2(ce.i, ce.j, 70);
            for (var st = 0; st < CRACK_STAGES; st++) {
                var ta = (off0 + st / 5) * TAU, tx = Math.cos(ta), ty = Math.sin(ta), best = -Infinity, sv = poly[0];
                for (var v = 0; v < poly.length; v++) {
                    var dx = poly[v][0] - ce.x, dy = poly[v][1] - ce.y, dl = Math.hypot(dx, dy) || 1;
                    var dd = (dx * tx + dy * ty) / dl;
                    if (dd > best) { best = dd; sv = poly[v]; }
                }
                var line = [sv[0] + (ce.px - sv[0]) * 0.05, sv[1] + (ce.py - sv[1]) * 0.05];
                var reach = 0.55 + h2(ce.i, st, 71) * 0.4, segs = 3 + ((h2(ce.j, st, 76) * 2) | 0);
                for (var k = 1; k <= segs; k++) {
                    var u = reach * k / segs, jx = (h2(ce.i + k, ce.j + st, 72) - 0.5) * s * 0.2, jy = (h2(ce.i + k, ce.j + st, 73) - 0.5) * s * 0.2;
                    line.push(sv[0] + (ce.px - sv[0]) * u + jx, sv[1] + (ce.py - sv[1]) * u + jy);
                }
                // a short branch off the second joint, now and then
                if (h2(ce.i, st, 77) > 0.4) {
                    var bx = line[4], by = line[5];
                    line.push(NaN, NaN, bx, by, bx + (h2(ce.i, ce.j + st, 74) - 0.5) * s * 0.4, by + (h2(ce.i, ce.j + st, 75) - 0.5) * s * 0.4);
                }
                out.push(line);
            }
            var tn = ce.tn || { ink: [20, 16, 24], light: [200, 200, 200] }, oc = CRACK_ORE[ce.ore];
            ce.crk = { lines: out, base: css(tn.ink, -0.38, 0.85), hot: oc ? css(oc.hot, 0, 0.8) : css(tn.ink, -0.58, 0.8),
                hair: oc ? oc.hair : [Math.min(255, tn.light[0] * 1.1), Math.min(255, tn.light[1] * 1.1), Math.min(255, tn.light[2] * 1.1)], hairCss: [] };
        }
        var C = ce.crk, w = s * 0.035 * (0.28 + 0.075 * stage) * 2.2;
        c.save();
        polyPath(c, ce.poly, 0); c.clip();
        c.lineJoin = 'miter'; c.lineCap = 'butt'; c.miterLimit = 3;
        c.beginPath();
        for (var q = 0; q < Math.min(CRACK_STAGES, stage); q++) {
            var L = C.lines[q], mv = true;
            for (var p = 0; p < L.length; p += 2) {
                if (L[p] !== L[p]) { mv = true; continue; }
                if (mv) c.moveTo(L[p], L[p + 1]); else c.lineTo(L[p], L[p + 1]);
                mv = false;
            }
        }
        c.strokeStyle = C.base; c.lineWidth = w * 1.25; c.stroke();
        c.strokeStyle = C.hot; c.lineWidth = w * 0.5; c.stroke();
        c.translate(0, w * 0.85);
        c.strokeStyle = C.hairCss[stage] || (C.hairCss[stage] = css(C.hair, 0, Math.min(1, 0.22 + 0.03 * stage)));
        c.lineWidth = w * 0.32; c.stroke();
        c.restore();
    }
    function freeSlot() {
        for (var i = 0; i < Z.slots.length; i++) if (!Z.slots[i].on) return i;
        return -1;
    }
    function freeSlots() { var n = 0; for (var i = 0; i < Z.slots.length; i++) n += Z.slots[i].on ? 0 : 1; return n; }
    function lift(g, t) {
        var si = freeSlot();
        if (si < 0) return false;
        var sl = Z.slots[si], ce = Z.CELL[g];
        renderSprite(sl, ce, 0);
        shifts(ce, floorAt);
        Z.ST[g] = LIFT;
        sl.on = 1; sl.g = g; sl.mode = LIFT; sl.owner = t.k; sl.stage = 0; sl.flash = 0; sl.shake = 0; sl.pend = 0;
        sl.hp = sl.hp0 = 3 + (ce.ore ? 1 : 0) + (rnd() < 0.45 ? 1 : 0);
        t.slot = si;
        return true;
    }
    // put a lifted rock back as it was (its tank went off to do something else)
    function unlift(t) {
        if (t.slot < 0) return;
        var sl = Z.slots[t.slot], ce = Z.CELL[sl.g];
        t.slot = -1;
        if (!sl.on || sl.mode !== LIFT || sl.owner !== t.k) return;
        renderSprite(sl, ce, 0);
        shifts(ce, stampAt, sl);
        Z.ST[sl.g] = SOLID; sl.on = 0;
    }
    // small chips knocked off by a hit
    function spawnChip(x, y, vx, vy, col, life, sz) {
        var fs = Z.chips;
        for (var i = 0; i < fs.length; i++) {
            var f = fs[i];
            if (f.on) continue;
            f.on = 1; f.x = x; f.y = y; f.vx = vx; f.vy = vy; f.rot = rnd() * TAU; f.vr = (rnd() - 0.5) * 9;
            f.t = 0; f.life = life; f.col = col; f.sz = sz;
            return f;
        }
        return null;
    }
    function cellFx(ce) {
        if (!ce.fx) {
            var tn = ce.tn || { ink: [30, 30, 30], light: [120, 120, 120], rim: [150, 150, 150] };
            // the game's biome chips: seam ink, lit face, bright edge
            ce.fx = [cssDim(tn.ink, -0.1), cssDim(tn.light), cssDim(tn.rim)];
        }
        return ce.fx;
    }
    function chips(ce, x, y, n, dx, dy) {
        var cc = cellFx(ce);
        for (var k = 0; k < n; k++) {
            var a = Math.atan2(-dy, -dx) + (rnd() - 0.5) * 2.2, v = 50 + rnd() * 80;
            spawnChip(x, y, Math.cos(a) * v, Math.sin(a) * v, cc[k % 3], 0.3 + rnd() * 0.25, s * (0.02 + rnd() * 0.025));
        }
    }
    // A rock's break, as the game draws it (terrainRenderer.js _spawnShatter and its
    var BURST_CHIPS = 46, BURST_SPARKS = 36, BURST_MS = 0.62, BURST_K = 0.8;
    function burst(ce) {
        var bs = Z.bursts, b = null, old = 0;
        for (var i = 0; i < bs.length; i++) {
            if (!bs[i].on) { b = bs[i]; break; }
            if (bs[i].t > bs[old].t) old = i;
        }
        if (!b) b = bs[old];
        var Pp = b.parts;
        for (var e = 0; e < BURST_CHIPS; e++) {
            var o = e * 8;
            Pp[o] = rnd() * TAU; Pp[o + 1] = 0.7 + rnd() * 3.6; Pp[o + 2] = 0.018 + rnd() * 0.04; Pp[o + 3] = (rnd() * 3) | 0;
            Pp[o + 4] = (rnd() - 0.5) * 14; Pp[o + 5] = 0.5 + rnd() * 0.5; Pp[o + 6] = (rnd() - 0.5) * 1.1; Pp[o + 7] = (rnd() - 0.5) * 1.1;
        }
        b.pal = ORE_FX_CSS[ce.ore] || FW_CSS;
        b.nS = ce.ore ? (ce.ore === 3 ? 34 : 30) : 22;
        for (var q = 0; q < b.nS; q++) {
            b.sparks[q * 3] = rnd() * TAU; b.sparks[q * 3 + 1] = 1.2 + rnd() * 3.4; b.sparks[q * 3 + 2] = (rnd() * b.pal.length) | 0;
        }
        b.on = 1; b.t = 0; b.ce = ce; b.x = ce.px; b.y = ce.py; b.cc = cellFx(ce);
    }
    function breakCell(sl) {
        var ce = Z.CELL[sl.g], t = Z.tanks[sl.owner];
        burst(ce);
        if (ce.ore && t) {
            var po = spawnPop(0);
            if (po) { po.x = ce.px; po.y = ce.py; po.tk = t.k; po.tier = ce.ore; po.rot = rnd() * 2; po.n = ce.ore * 15; po.t = -0.12; }
        }
        Z.ST[sl.g] = DUG; Z.DUGAT[sl.g] = Z.t; Z.dug++;
        Z.stat.breaks++;
        sl.on = 0;
        if (t) { t.slot = -1; if (t.blk === sl.g) t.blk = -1; }
    }
    function spawnPop(kind) {
        for (var i = 0; i < Z.pops.length; i++) {
            var p = Z.pops[i];
            if (p.on) continue;
            p.on = 1; p.kind = kind; p.t = 0;
            return p;
        }
        return null;
    }
    // how far a shot flies from (x, y) along (dx, dy) before it meets rock: the face
    var RAY = { d: 0, g: -1 };
    function rayRock(x, y, dx, dy, maxD) {
        var stp = s * 0.18;
        for (var d = 0; d < maxD; d += stp) {
            var g = nodeAt(x + dx * d, y + dy * d);
            if (g < 0) break;
            var st = Z.ST[g];
            if (st === SOLID || st === LIFT || st === GROW) {
                // back off to the face: the last point outside that cell
                var ce = Z.CELL[g], lo = Math.max(0, d - stp), hi = d;
                for (var it = 0; it < 4; it++) {
                    var mid = (lo + hi) / 2, px = ce.x + dxw(x + dx * mid, ce.x);
                    if (polyDist(ce.poly, ce.ori, px, y + dy * mid).inside) hi = mid; else lo = mid;
                }
                RAY.d = lo; RAY.g = g;
                return RAY;
            }
        }
        RAY.d = maxD; RAY.g = -1;
        return RAY;
    }
    // one gun of a tank fires: from its muzzle along its own angle
    function fireGun(t, k, kind, tgt) {
        var g = t.build.g[k], bs = Z.bullets, b = null;
        for (var i = 0; i < bs.length; i++) if (!bs[i].on) { b = bs[i]; break; }
        if (!b) return;
        var a = t.ang + g.a + (t.build.spread ? (rnd() - 0.5) * t.build.spread : 0), ca = Math.cos(a), sa = Math.sin(a);
        var a0 = t.ang + g.a, c0 = Math.cos(a0), s0 = Math.sin(a0);
        var mx = t.x + (g.X * c0 - g.Y * s0) * t.r + c0 * (g.X + g.L) * t.r, my = t.y + (g.X * s0 + g.Y * c0) * t.r + s0 * (g.X + g.L) * t.r;
        b.on = 1; b.k = t.k; b.t = 0; b.x = mx; b.y = my; b.vx = ca; b.vy = sa;
        b.v = t.build.V * t.r * 1.15; b.r = Math.max(2.5, g.Wd * t.r * 0.4);
        if (kind === 1) {
            var f = Z.tanks[tgt], fd = Math.hypot(dxw(f.x, mx), f.y - my);
            var ray = rayRock(mx, my, ca, sa, fd);
            b.kind = ray.g >= 0 ? 2 : g.main ? 1 : 3; b.tgt = ray.g >= 0 ? ray.g : tgt; b.d = Math.max(3, ray.g < 0 ? (g.main ? fd - f.r : s * 2.5) : ray.d); b.dmg = 0;
        } else {
            var r2 = rayRock(mx, my, ca, sa, s * 4.5);
            var sl = tgt >= 0 ? Z.slots[tgt] : null;
            // the guns pointing ahead carry the volley's damage to the rock being mined (a
            if (sl && sl.on && sl.mode === LIFT && sl.g === t.vg && sl.owner === t.k && g.main) { b.kind = 0; b.tgt = tgt; b.g = sl.g; b.dmg = t.build.D / t.build.nMain; sl.pend += b.dmg; }
            else { b.kind = r2.g < 0 ? 3 : 2; b.tgt = r2.g; b.dmg = 0; }
            b.d = Math.max(3, r2.d);
        }
        t.rec[k] = 1; Z.stat.shots++;
    }
    // start a volley: every gun that fires, each after its own delay
    function volley(t, kind, tgt) {
        var G = t.build.g;
        for (var k = 0; k < G.length; k++) if (G[k].fire) t.gq[k] = G[k].delay * t.build.R * 0.9;
        t.vkind = kind; t.vtgt = tgt; t.vg = kind === 0 && tgt >= 0 ? Z.slots[tgt].g : -1;
        t.fire = t.build.R;
    }

    // a path over the lattice: rock costs more than tunnel (it has to be dug), other
    function plan(t, goalFn) {
        var n = Z.n, D = Z.D, PV = Z.PV, DONE = Z.DONE, HQ = Z.HQ, HPR = Z.HPR, ST = Z.ST;
        for (var i = 0; i < n; i++) { D[i] = Infinity; PV[i] = -1; DONE[i] = 0; }
        var hn = 0;
        t.cur = nodeAt(t.x, t.y);
        D[t.cur] = 0; HQ[0] = t.cur; HPR[0] = 0; hn = 1;
        while (hn > 0) {
            var g = HQ[0];
            var lastG = HQ[--hn], lastP = HPR[hn], k2 = 0;
            while (true) {
                var c1 = 2 * k2 + 1; if (c1 >= hn) break;
                if (c1 + 1 < hn && HPR[c1 + 1] < HPR[c1]) c1++;
                if (HPR[c1] >= lastP) break;
                HQ[k2] = HQ[c1]; HPR[k2] = HPR[c1]; k2 = c1;
            }
            if (hn > 0) { HQ[k2] = lastG; HPR[k2] = lastP; }
            if (DONE[g]) continue;
            DONE[g] = 1;
            for (var e = 0; e < Z.NBN[g]; e++) {
                var b = Z.NB[g * 8 + e];
                if (DONE[b] || Z.BLOCK[b]) continue;
                var st = ST[b], cst = Math.hypot(dxw(Z.SX[b], Z.SX[g]), Z.SY[b] - Z.SY[g]) / s;
                if (st === SOLID) cst += Z.CELL[b] && Z.CELL[b].ore ? 1.8 : 2.6;
                else if (st === LIFT) { var so = slotOf(b); cst += so >= 0 && Z.slots[so].owner === t.k ? 1 : 40; }
                else if (st === GROW) cst += 40;
                // keep clear of the other tanks
                for (var q = 0; q < Z.tanks.length; q++) {
                    var o = Z.tanks[q];
                    if (o === t) continue;
                    var od = Math.hypot(dxw(Z.SX[b], o.x), Z.SY[b] - o.y);
                    if (od < s * 1.6) cst += 12 * (1 - od / (s * 1.6)) + 2;
                }
                var nd = D[g] + cst;
                if (nd < D[b]) {
                    D[b] = nd; PV[b] = g;
                    var k = hn++;
                    while (k > 0) { var pk = (k - 1) >> 1; if (HPR[pk] <= nd) break; HQ[k] = HQ[pk]; HPR[k] = HPR[pk]; k = pk; }
                    HQ[k] = b; HPR[k] = nd;
                }
            }
        }
        // pick the goal
        var best = -1, bs = Infinity;
        for (var g2 = 0; g2 < n; g2++) {
            if (!(D[g2] < Infinity) || g2 === t.cur) continue;
            var sc = goalFn(t, g2, D[g2]);
            if (sc < bs) { bs = sc; best = g2; }
        }
        t.pi = 0; t.pn = 0; t.bestD = Infinity; t.prog = 0;
        if (best < 0) return false;
        var len = 0;
        for (var w = best; w !== t.cur && w >= 0; w = PV[w]) len++;
        var skip = Math.max(0, len - t.path.length);
        var idx = len - skip;
        for (var w2 = best; w2 !== t.cur && w2 >= 0; w2 = PV[w2]) {
            if (skip > 0) { skip--; continue; }
            t.path[--idx] = w2;
        }
        t.pn = Math.min(len, t.path.length);
        return true;
    }
    function slotOf(g) {
        for (var i = 0; i < Z.slots.length; i++) if (Z.slots[i].on && Z.slots[i].g === g) return i;
        return -1;
    }
    // the next rock to mine: a few steps out, in the tank's own patch, ore first
    function digGoal(t, g, d) {
        if (Z.ST[g] !== SOLID || d > 14) return Infinity;
        var away = Math.abs(dxw(Z.SX[g], t.home)) / P, crowd = 0;
        for (var q = 0; q < Z.tanks.length; q++) {
            var o = Z.tanks[q];
            if (o === t) continue;
            if (Math.hypot(dxw(Z.SX[g], o.x), Z.SY[g] - o.y) < s * 2.6) crowd += 6;
        }
        return Math.abs(d - 4.5) + h2(g, Z.stat.breaks + t.k * 7, 31) * 3 - (Z.CELL[g].ore ? 2.5 : 0) + Math.max(0, away - 0.17) * 40 + crowd;
    }
    // the open ground round the vault
    function bankGoal(t, g, d) {
        var vd = Math.hypot(dxw(Z.SX[g], Z.vault[0]), Z.SY[g] - Z.vault[1]);
        if (vd > s * 2.3 || Z.ST[g] === SOLID) return Infinity;
        return d;
    }
    function nearVault(t) { return Math.hypot(dxw(t.x, Z.vault[0]), t.y - Z.vault[1]) < s * 2.6; }
    function turn(t, to, dt) {
        var d = to - t.ang;
        d -= Math.round(d / TAU) * TAU;
        var m = 5.5 * dt;
        t.ang += Math.max(-m, Math.min(m, d));
        return Math.abs(d);
    }
    // rock is solid: push the tank out of any cell it overlaps, and note the rock
    function collide(t, dt) {
        var g0 = nodeAt(t.x, t.y), i0 = (g0 / NR) | 0, j0 = g0 % NR, worst = 0, wg = -1;
        for (var it = 0; it < 2; it++) {
            for (var di = -2; di <= 2; di++) for (var dj = -2; dj <= 2; dj++) {
                var jj = j0 + dj; if (jj < 0 || jj >= NR) continue;
                var g = wrapI(i0 + di) * NR + jj, st = Z.ST[g];
                if (st !== SOLID && st !== LIFT && st !== GROW) continue;
                var ce = Z.CELL[g], dx = dxw(t.x, ce.x), dy = t.y - ce.y;
                if (dx * dx + dy * dy > Math.pow(s * 1.25 + t.r, 2)) continue;
                var px = ce.x + dx, q = polyDist(ce.poly, ce.ori, px, t.y);
                var pen = 0, nx = 0, ny = 0;
                if (q.inside) { pen = q.d + t.r; nx = (q.qx - px) / (q.d || 1); ny = (q.qy - t.y) / (q.d || 1); }
                else if (q.d < t.r) { pen = t.r - q.d; nx = (px - q.qx) / (q.d || 1); ny = (t.y - q.qy) / (q.d || 1); }
                if (pen <= 0) continue;
                t.x += nx * pen; t.y += ny * pen;
                if (pen > worst) { worst = pen; wg = g; }
            }
        }
        if (wg >= 0) { t.hitG = wg; t.hitT = 0.35; }
        else if ((t.hitT -= dt) <= 0) t.hitG = -1;
        // and the tanks keep their distance from each other
        if (!t.ghost) for (var k = 0; k < Z.tanks.length; k++) {
            var o = Z.tanks[k];
            if (o === t || o.ghost) continue;
            var ox = dxw(t.x, o.x), oy = t.y - o.y, od = Math.hypot(ox, oy), want = (t.r + o.r) * 1.12;
            if (od < want && od > 0.01) { var pp = (want - od) / 2; t.x += ox / od * pp; t.y += oy / od * pp; o.x -= ox / od * pp; o.y -= oy / od * pp; }
        }
        t.y = Math.max(t.r, Math.min(H - t.r, t.y));
        t.x = ((t.x % P) + P) % P;
    }
    function aimAt(t, g, dt) {
        var dx = dxw(Z.CELL[g].px, t.x), dy = Z.CELL[g].py - t.y;
        return turn(t, Math.atan2(dy, dx), dt);
    }
    // a rock in reach: the tank stops at it and mines it
    function mine(t, g, dt) {
        var st = Z.ST[g];
        if (st === GROW) return false;
        if (st === LIFT) {
            var so = slotOf(g);
            if (so < 0 || Z.slots[so].owner !== t.k) return false;
        } else if (t.slot >= 0 && Z.slots[t.slot].g !== g) unlift(t);
        var ce = Z.CELL[g], q = polyDist(ce.poly, ce.ori, ce.x + dxw(t.x, ce.x), t.y);
        if (q.d > t.r + s * 0.22 && !q.inside) return null;   // not there yet
        if (st === SOLID && !lift(g, t)) return false;
        var sl = Z.slots[t.slot];
        var offA = aimAt(t, g, dt);
        t.prog = 0;
        if (t.fire <= 0 && offA < 0.14 && sl.pend < sl.hp - 0.001) volley(t, 0, t.slot);
        return true;
    }
    function think(t, dt) {
        var G = t.build.g;
        for (var k = 0; k < G.length; k++) {
            t.rec[k] = Math.max(0, t.rec[k] - dt * 7);
            if (t.gq[k] >= 0 && (t.gq[k] -= dt) < 0) { t.gq[k] = -1; fireGun(t, k, t.vkind, t.vtgt); }
        }
        t.hit = Math.max(0, t.hit - dt * 4);
        t.fire -= dt;
        t.ghost = Math.max(0, t.ghost - dt);
        collide(t, dt);
        if (t.wait > 0) { t.wait -= dt; return; }
        if (t.mode === DUEL) {
            var f = Z.tanks[t.foe];
            var off0 = turn(t, Math.atan2(f.y - t.y, dxw(f.x, t.x)), dt);
            if (t.volleys > 0 && t.fire <= 0 && off0 < 0.12) { volley(t, 1, f.k); t.volleys--; }
            else if (t.volleys <= 0 && t.fire < -0.5) { t.mode = DIG; t.pn = 0; }
            return;
        }
        // a rock in the way that the path did not plan for: dig it first
        if (t.blk >= 0 && !(Z.ST[t.blk] === SOLID || Z.ST[t.blk] === LIFT)) t.blk = -1;
        if (t.blk >= 0) {
            var mb = mine(t, t.blk, dt);
            if (mb === false) { t.blk = -1; t.pn = 0; }
            else if (mb === null) {
                // it moved out of reach (pushed): head for it
                var bc = Z.CELL[t.blk], bdx = dxw(bc.px, t.x), bdy = bc.py - t.y, bdd = Math.hypot(bdx, bdy) || 1;
                turn(t, Math.atan2(bdy, bdx), dt);
                drive(t, bdx / bdd, bdy / bdd, dt);
                if ((t.prog += dt) > 1) { t.blk = -1; t.pn = 0; }
            }
            return;
        }
        if (t.pi >= t.pn) {
            if (t.mode === BANK && nearVault(t)) {
                // bank: the gems stream into the vault, then the total
                var got = t.gems;
                t.gems = 0; t.mode = DIG; t.wait = 0.6; t.bankAt = 90 + ((rnd() * 4) | 0) * 15;
                for (var b = 0; b < 3; b++) {
                    var p = spawnPop(1);
                    if (p) { p.x = t.x; p.y = t.y; p.t = -b * 0.16; p.tier = 1 + ((b + t.k) % 3); p.rot = b; }
                }
                var bp = spawnPop(2);
                if (bp) { bp.t = -0.55; bp.x = Z.vault[0]; bp.y = Z.vault[1] - s * 1.95; bp.label = 'BANKED +' + got; }
                Z.stat.banks++;
                return;
            }
            unlift(t);
            if (t.mode === DIG && t.gems >= t.bankAt) t.mode = BANK;
            if (!plan(t, t.mode === BANK ? bankGoal : digGoal)) { t.wait = 0.4; if (t.mode === BANK) t.mode = DIG; }
            return;
        }
        var g = t.path[t.pi], st = Z.ST[g];
        if (st === SOLID || st === LIFT || st === GROW) {
            var m = mine(t, g, dt);
            if (m === false) { t.pn = 0; return; }     // someone else's rock: another plan
            if (m === true) return;
        }
        // drive toward the waypoint (or up to the rock face)
        var dx = dxw(Z.SX[g], t.x), dy = Z.SY[g] - t.y, d = Math.hypot(dx, dy) || 1;
        if (isOpen(st) && d < s * 0.3) { t.cur = g; t.pi++; t.bestD = Infinity; t.prog = 0; t.unstick = 0; return; }
        turn(t, Math.atan2(dy, dx), dt);
        drive(t, dx / d, dy / d, dt);
        // not getting closer: a rock corner is in the way (dig it), or a tank (another
        if (d < t.bestD - 2) { t.bestD = d; t.prog = 0; }
        else if ((t.prog += dt) > 0.7) {
            t.prog = 0; t.bestD = Infinity; Z.stat.stuck++;
            if (t.hitG >= 0 && Z.ST[t.hitG] !== GROW && Z.ST[t.hitG] !== LIFT) t.blk = t.hitG;
            else if (++t.unstick >= 2) { t.ghost = 1.2; t.unstick = 0; }
            else t.pn = 0;
        }
    }
    function drive(t, ux, uy, dt) {
        var v = s * 1.35 * dt;
        t.x += ux * v; t.y += uy * v;
    }
    // a clear line of tunnel between two tanks?
    function clearLine(a, b) {
        var dx = dxw(b.x, a.x), dy = b.y - a.y, d = Math.hypot(dx, dy), n = Math.ceil(d / (s * 0.3));
        for (var k = 1; k < n; k++) if (!isOpen(Z.ST[nodeAt(a.x + dx * k / n, a.y + dy * k / n)])) return false;
        return true;
    }
    function tryDuel() {
        var T = Z.tanks;
        for (var i = 0; i < T.length; i++) for (var j = i + 1; j < T.length; j++) {
            var a = T[i], b = T[j];
            if (a.mode !== DIG || b.mode !== DIG || a.slot >= 0 || b.slot >= 0 || a.blk >= 0 || b.blk >= 0) continue;
            var d = Math.hypot(dxw(b.x, a.x), b.y - a.y);
            if (d < s * 2.4 || d > s * 8 || !clearLine(a, b)) continue;
            a.mode = b.mode = DUEL; a.foe = j; b.foe = i; a.volleys = b.volleys = 2;
            a.fire = 0.25; b.fire = 0.55; a.wait = b.wait = 0; a.pn = b.pn = 0;
            Z.stat.duels++;
            return true;
        }
        return false;
    }
    // the oldest broken rock nobody is near grows back (sooner when a lot is dug)
    function regrow() {
        var need = 0;
        for (var q0 = 0; q0 < Z.tanks.length; q0++) if (Z.tanks[q0].slot < 0) need++;
        if (freeSlots() <= need) return;
        var si = freeSlot();
        var many = Z.dug > Z.solid0 * 0.15, best = -1, bt = Infinity;
        for (var g = 0; g < Z.n; g++) {
            if (Z.ST[g] !== DUG) continue;
            var age = Z.t - Z.DUGAT[g];
            if (age < (many ? 14 : 38 + h2(g, 3, 33) * 30) || Z.DUGAT[g] >= bt) continue;
            var ok = true;
            for (var q = 0; q < Z.tanks.length && ok; q++) {
                var t = Z.tanks[q];
                if (Math.hypot(dxw(Z.SX[g], t.x), Z.SY[g] - t.y) < s * 3.2) ok = false;
                for (var p = t.pi; p < t.pn && ok; p++) if (t.path[p] === g) ok = false;
            }
            if (ok) { best = g; bt = Z.DUGAT[g]; }
        }
        if (best < 0) return;
        var ce = Z.CELL[best], sl = Z.slots[si];
        ce.ore = h2(best, Z.stat.regrows, 34) < 0.22 ? 1 + ((h2(best, 1, 35) * 3) | 0) : 0;
        ce.crk = null;
        renderSprite(sl, ce, 0);
        sl.on = 1; sl.g = best; sl.mode = GROW; sl.t = 0; sl.owner = -1;
        Z.ST[best] = GROW;
    }

    function simulate(dt) {
        Z.t += dt;
        for (var k = 0; k < Z.tanks.length; k++) {
            var tk0 = Z.tanks[k], px0 = tk0.x, py0 = tk0.y;
            think(tk0, dt);
            // QA: time spent neither moving nor shooting
            if (Math.abs(dxw(tk0.x, px0)) + Math.abs(tk0.y - py0) < 0.05 && tk0.fire < -0.4) tk0.idle += dt;
        }
        if (Z.t > Z.nextDuel) Z.nextDuel = Z.t + (tryDuel() ? 40 + rnd() * 25 : 2);
        if (Z.t > Z.nextGrow) { Z.nextGrow = Z.t + 0.5; regrow(); }
        // bullets
        var bs = Z.bullets;
        for (var b = 0; b < bs.length; b++) {
            var bu = bs[b];
            if (!bu.on) continue;
            bu.t += bu.v * dt;
            if (bu.t < bu.d) continue;
            bu.on = 0;
            var hx = bu.x + bu.vx * bu.d, hy = bu.y + bu.vy * bu.d;
            if (bu.kind === 1) { Z.tanks[bu.tgt].hit = 1; continue; }
            if (bu.kind === 3) continue;
            if (bu.kind === 2) {
                var oc = bu.tgt >= 0 ? Z.CELL[bu.tgt] : null;
                if (oc) chips(oc, hx, hy, 1, bu.vx, bu.vy);
                continue;
            }
            var sl = Z.slots[bu.tgt];
            if (!sl.on || sl.mode !== LIFT || sl.g !== bu.g) continue;
            var ce = Z.CELL[sl.g];
            sl.pend = Math.max(0, sl.pend - bu.dmg);
            sl.hp -= bu.dmg; sl.flash = 1; sl.shake = 1;
            chips(ce, hx, hy, 2, bu.vx, bu.vy);
            if (sl.hp <= 0.001) { breakCell(sl); continue; }
            var stg = Math.min(CRACK_STAGES, Math.ceil((1 - sl.hp / sl.hp0) * CRACK_STAGES));
            if (stg !== sl.stage) { sl.stage = stg; renderSprite(sl, ce, stg); }
        }
        // sprites
        for (var i = 0; i < Z.slots.length; i++) {
            var q = Z.slots[i];
            if (!q.on) continue;
            q.flash = Math.max(0, q.flash - dt / 0.15);
            q.shake = Math.max(0, q.shake - dt * 6);
            if (q.mode === GROW) {
                q.t += dt / 1.8;
                if (q.t >= 1) {
                    var cg = Z.CELL[q.g];
                    shifts(cg, stampAt, q);
                    Z.ST[q.g] = SOLID; Z.dug--; q.on = 0; Z.stat.regrows++;
                }
            }
        }
        var fs = Z.chips;
        for (var f = 0; f < fs.length; f++) {
            var fr = fs[f];
            if (!fr.on) continue;
            fr.t += dt;
            if (fr.t >= fr.life) { fr.on = 0; continue; }
            var drag = Math.exp(-3.2 * dt);
            fr.vx *= drag; fr.vy *= drag;
            fr.x += fr.vx * dt; fr.y += fr.vy * dt; fr.rot += fr.vr * dt;
        }
        var bz = Z.bursts;
        for (var z = 0; z < bz.length; z++) if (bz[z].on && (bz[z].t += dt / BURST_MS) >= 1) bz[z].on = 0;
        var ps = Z.pops;
        for (var p = 0; p < ps.length; p++) {
            var po = ps[p];
            if (!po.on) continue;
            var t0 = po.t;
            po.t += dt / (po.kind === 2 ? 1.6 : 0.85);
            if (po.kind === 0 && t0 < 1 && po.t >= 1) { var tk = Z.tanks[po.tk]; tk.gems += po.n; Z.stat.gems += po.n; po.label = '+' + po.n + ' gems'; }
            if (po.t >= (po.kind === 0 ? 1.55 : 1)) po.on = 0;
        }
    }

    function vignette(c) {
        var key = W + 'x' + H + light;
        if (vignFor !== key) {
            vignFor = key;
            vign = c.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.22, W / 2, H * 0.45, Math.hypot(W, H) * 0.62);
            if (light) { vign.addColorStop(0, 'rgba(234,219,182,0.42)'); vign.addColorStop(1, 'rgba(234,219,182,0)'); }
            else { vign.addColorStop(0, 'rgba(12,9,16,0.4)'); vign.addColorStop(0.55, 'rgba(12,9,16,0.08)'); vign.addColorStop(1, 'rgba(12,9,16,0.26)'); }
        }
        c.fillStyle = vign; c.fillRect(0, 0, W, H);
    }

    // ── a frame ───────────────────────────────────────────────────────
    var SPEED = 12;   // px per second
    // where a strip x lands on screen: [0, P)
    function scr(x) { var v = (x - off) % P; return v < 0 ? v + P : v; }
    function drawBurst(c, b, ox, A) {
        var t = b.t, u = s * BURST_K, cx = ox, cy = b.y;
        var eo = 1 - Math.pow(1 - t, 4), fade = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
        // hard white flash filling the rock's silhouette
        if (t < 0.12) {
            c.globalAlpha = A * (1 - t / 0.12) * 0.9;
            c.fillStyle = 'rgb(240,232,250)';
            polyPath(c, b.ce.poly, ox - b.x);
            c.fill();
        }
        // fast double dust ring
        c.strokeStyle = Z.ring;
        for (var rg = 0; rg < 2; rg++) {
            var rt = rg === 0 ? t : (t - 0.07) / 0.93;
            if (rt <= 0 || rt >= 1) continue;
            var rq = 1 - Math.pow(1 - rt, 4);
            c.globalAlpha = A * Math.pow(1 - rt, 1.5) * 0.6;
            c.beginPath(); c.arc(cx, cy, (0.25 + (rg ? 1.9 : 3.0) * rq) * u, 0, TAU);
            c.lineWidth = 0.12 * u * (1 - rt) + 0.5;
            c.stroke();
        }
        // firework streaks flying out with the debris, one path per colour
        var pal = b.pal, S = b.sparks;
        c.lineCap = 'round';
        c.lineWidth = Math.max(1, 0.028 * u * (1 - t * 0.5));
        c.globalAlpha = A * fade * 0.9;
        for (var ci = 0; ci < pal.length; ci++) {
            var any = false;
            for (var e = 0; e < b.nS; e++) {
                if (S[e * 3 + 2] !== ci) continue;
                if (!any) { any = true; c.beginPath(); }
                var r2 = eo * S[e * 3 + 1] * u, r1 = r2 * 0.6, ca = Math.cos(S[e * 3]), sa = Math.sin(S[e * 3]);
                c.moveTo(cx + ca * r1, cy + sa * r1); c.lineTo(cx + ca * r2, cy + sa * r2);
            }
            if (any) { c.strokeStyle = pal[ci]; c.stroke(); }
        }
        // rock chips: little turned oblongs, one path per shade
        c.globalAlpha = A * fade;
        var Pp = b.parts, shrink = 1 - t * 0.6;
        for (var sh = 0; sh < 3; sh++) {
            c.beginPath();
            for (var k = 0; k < BURST_CHIPS; k++) {
                var o = k * 8;
                if (Pp[o + 3] !== sh) continue;
                var ang = Pp[o], dist = eo * Pp[o + 1] * u;
                var px = cx + Pp[o + 6] * u * 0.3 + Math.cos(ang) * dist, py = cy + Pp[o + 7] * u * 0.3 + Math.sin(ang) * dist;
                var hw = Pp[o + 2] * u * shrink * 2.2, hh = hw * Pp[o + 5];
                var rr = ang + Pp[o + 4] * eo, cr = Math.cos(rr), sr = Math.sin(rr);
                var ax = cr * hw, ay = sr * hw, bx = -sr * hh, by = cr * hh;
                c.moveTo(px - ax - bx, py - ay - by); c.lineTo(px + ax - bx, py + ay - by);
                c.lineTo(px + ax + bx, py + ay + by); c.lineTo(px - ax + bx, py - ay + by);
                c.closePath();
            }
            c.fillStyle = b.cc[sh]; c.fill();
        }
        c.globalAlpha = A;
    }
    function draw(c, now, still, alpha) {
        if (!live || !live.cv) return;
        setScene(live);
        var dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0;
        lastT = now;
        if (still) dt = 0;
        off = (off + SPEED * dt) % P;
        if (dt > 0) simulate(dt);
        var A = alpha == null ? 1 : alpha;
        c.globalAlpha = A;
        var x0 = -off;
        c.drawImage(Z.cv, x0, 0, P, H);
        if (x0 + P < W) c.drawImage(Z.cv, x0 + P, 0, P, H);
        if (x0 + 2 * P < W) c.drawImage(Z.cv, x0 + 2 * P, 0, P, H);
        var M = s * 1.6, cp, ox;
        var vsx = scr(Z.vault[0]);
        for (cp = 0; cp < 2; cp++) {
            ox = cp ? vsx - P : vsx;
            if (ox < -Z.vw || ox > W + Z.vw) continue;
            c.drawImage(Z.vcv, ox - Z.vw / 2, Z.vy0, Z.vw, Z.vh);
        }
        // rocks being shot (shaking, flashing) and rocks growing back
        for (var i = 0; i < Z.slots.length; i++) {
            var sl = Z.slots[i];
            if (!sl.on) continue;
            var ce = Z.CELL[sl.g], sx = scr(ce.x), half = s * HALF_K;
            var sw = sl.cv.width / dpr, bx = sl.ox / dpr - ce.x, by = sl.oy / dpr;
            var jx = sl.shake ? Math.sin(Z.t * 97 + i) * 2.2 * sl.shake : 0, jy = sl.shake ? Math.cos(Z.t * 83 + i) * 1.6 * sl.shake : 0;
            for (cp = 0; cp < 2; cp++) {
                ox = cp ? sx - P : sx;
                if (ox < -half || ox > W + half) continue;
                if (sl.mode === GROW) {
                    var e = sl.t < 0 ? 0 : sl.t * sl.t * (3 - 2 * sl.t), k = 0.8 + 0.2 * e;
                    c.save();
                    c.globalAlpha = A * e;
                    c.translate(ox, ce.y); c.scale(k, k);
                    c.drawImage(sl.cv, bx, by - ce.y, sw, sw);
                    c.restore();
                    continue;
                }
                c.drawImage(sl.cv, ox + bx + jx, by + jy, sw, sw);
                if (sl.flash > 0) {
                    c.globalAlpha = A * 0.32 * sl.flash;
                    c.save(); c.translate(jx, jy);
                    polyPath(c, ce.poly, ox - ce.x);
                    c.fillStyle = '#fff4e6'; c.fill();
                    c.restore();
                    c.globalAlpha = A;
                }
            }
        }
        // breaks
        var bz = Z.bursts;
        for (var z = 0; z < bz.length; z++) {
            var bu0 = bz[z];
            if (!bu0.on) continue;
            var bsx = scr(bu0.x), R = s * 3.5;
            for (cp = 0; cp < 2; cp++) {
                ox = cp ? bsx - P : bsx;
                if (ox < -R || ox > W + R) continue;
                drawBurst(c, bu0, ox, A);
            }
        }
        // hit chips
        var fs = Z.chips;
        for (var f = 0; f < fs.length; f++) {
            var fr = fs[f];
            if (!fr.on) continue;
            var uu = fr.t / fr.life, fsx = scr(fr.x);
            c.globalAlpha = A * (uu < 0.6 ? 1 : 1 - (uu - 0.6) / 0.4);
            c.fillStyle = fr.col;
            var cs = Math.cos(fr.rot), sn = Math.sin(fr.rot), zz = fr.sz;
            for (cp = 0; cp < 2; cp++) {
                ox = cp ? fsx - P : fsx;
                if (ox < -M || ox > W + M) continue;
                c.beginPath();
                c.moveTo(ox + cs * zz, fr.y + sn * zz); c.lineTo(ox - sn * zz * 0.6, fr.y + cs * zz * 0.6); c.lineTo(ox - cs * zz, fr.y - sn * zz); c.lineTo(ox + sn * zz * 0.6, fr.y - cs * zz * 0.6);
                c.closePath(); c.fill();
            }
        }
        c.globalAlpha = A;
        // bullets
        var bs = Z.bullets;
        c.lineWidth = 2;
        for (var b = 0; b < bs.length; b++) {
            var bu = bs[b];
            if (!bu.on) continue;
            var bxs = scr(bu.x + bu.vx * bu.t), bys = bu.y + bu.vy * bu.t, col = Z.tanks[bu.k].col;
            if (bu.kind === 3) c.globalAlpha = A * Math.max(0, 1 - bu.t / bu.d);
            for (cp = 0; cp < 2; cp++) {
                ox = cp ? bxs - P : bxs;
                if (ox < -M || ox > W + M) continue;
                c.beginPath(); c.arc(ox, bys, bu.r, 0, TAU);
                c.fillStyle = col[0]; c.fill(); c.strokeStyle = col[1]; c.stroke();
            }
            c.globalAlpha = A;
        }
        // tanks
        for (var t2 = 0; t2 < Z.tanks.length; t2++) {
            var st = Z.tanks[t2], tsx = scr(st.x);
            for (cp = 0; cp < 2; cp++) {
                ox = cp ? tsx - P : tsx;
                if (ox < -M || ox > W + M) continue;
                drawTank(c, ox, st.y, st);
                if (st.hit > 0) {
                    c.globalAlpha = A * 0.55 * st.hit;
                    c.beginPath(); c.arc(ox, st.y, st.r, 0, TAU); c.fillStyle = '#ffffff'; c.fill();
                    c.globalAlpha = A;
                }
            }
        }
        // gem pops: out of the rock, an arc, into the tank, a "+gems" tag
        c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
        var ps = Z.pops;
        for (var p = 0; p < ps.length; p++) {
            var po = ps[p];
            if (!po.on || po.t < 0) continue;
            var gx, gy, txt = null, tyy = 0, ta = 1, gold = '#f2b83c', fnt = Z.fontPop;
            if (po.kind === 0) {
                var sq = Z.tanks[po.tk];
                if (po.t < 1) {
                    var u2 = po.t, e2 = u2 * u2 * (3 - 2 * u2);
                    gx = po.x + dxw(sq.x, po.x) * e2; gy = po.y + (sq.y - po.y) * e2 - Math.sin(u2 * Math.PI) * s * 0.9;
                } else { gx = sq.x; txt = po.label; tyy = sq.y - sq.r - 10 - (po.t - 1) * 30; ta = 1 - (po.t - 1) / 0.55; }
            } else if (po.kind === 1) {
                var u3 = Math.min(1, po.t), e3 = u3 * u3 * (3 - 2 * u3);
                gx = po.x + dxw(Z.vault[0], po.x) * e3; gy = po.y + (Z.vault[1] - po.y) * e3 - Math.sin(u3 * Math.PI) * s * 0.7;
            } else {
                gx = po.x; txt = po.label; fnt = Z.fontBank; gold = '#ffd36b';
                tyy = po.y - po.t * s * 0.5; ta = po.t < 0.7 ? 1 : 1 - (po.t - 0.7) / 0.3;
            }
            var gsx = scr(gx);
            for (cp = 0; cp < 2; cp++) {
                ox = cp ? gsx - P : gsx;
                if (ox < -M * 2 || ox > W + M * 2) continue;
                if (txt === null) {
                    var uq = Math.min(1, po.t);
                    drawGem(c, ox, gy, s * (0.12 + 0.06 * Math.sin(uq * Math.PI)), po.rot + uq * 4, po.tier, false);
                } else {
                    c.globalAlpha = A * Math.max(0, ta);
                    c.font = fnt;
                    c.lineWidth = 4; c.strokeStyle = '#0c0a0e'; c.strokeText(txt, ox, tyy);
                    c.fillStyle = gold; c.fillText(txt, ox, tyy);
                    c.globalAlpha = A;
                }
            }
        }
        vignette(c);
        c.globalAlpha = 1;
    }

    // in a raid the menu is hidden: drop the bake (home.js builds it again on the way
    function release() {
        if (live && live.cv) { live.cv.width = 0; live.cv.height = 0; if (live.vcv) live.vcv.width = 0; }
        if (live) for (var i = 0; i < live.slots.length; i++) if (live.slots[i].cv) { live.slots[i].cv.width = 0; live.slots[i].cv = null; }
        live = null; bake = null; Z = null; vign = null; vignFor = ''; lastT = 0;
    }
    function stat() {
        if (!live) return null;
        var S = live, on = function (a) { var n = 0; for (var i = 0; i < a.length; i++) n += a[i].on; return n; };
        return { t: Math.round(S.t * 10) / 10, off: Math.round(off), P: P, dug: S.dug, solid0: S.solid0, slots: on(S.slots), chips: on(S.chips), bursts: on(S.bursts), bullets: on(S.bullets), pops: on(S.pops),
            breaks: S.stat.breaks, gems: S.stat.gems, banks: S.stat.banks, regrows: S.stat.regrows, duels: S.stat.duels, shots: S.stat.shots, stuck: S.stat.stuck,
            tanks: S.tanks.map(function (t) { return { b: t.build.n, m: t.mode, gems: t.gems, x: Math.round(t.x), y: Math.round(t.y), r: Math.round(t.r), blk: t.blk, idle: Math.round(t.idle * 10) / 10, left: Math.max(0, t.pn - t.pi) }; }) };
    }
    // QA: how deep the tanks are in rock right now (0 = none overlap), and whether
    function check() {
        if (!live) return null;
        setScene(live);
        var worst = 0, gemOut = 0;
        for (var k = 0; k < Z.tanks.length; k++) {
            var t = Z.tanks[k], g0 = nodeAt(t.x, t.y), i0 = (g0 / NR) | 0, j0 = g0 % NR;
            for (var di = -2; di <= 2; di++) for (var dj = -2; dj <= 2; dj++) {
                var jj = j0 + dj; if (jj < 0 || jj >= NR) continue;
                var g = wrapI(i0 + di) * NR + jj, st = Z.ST[g];
                if (st !== SOLID && st !== LIFT && st !== GROW) continue;
                var ce = Z.CELL[g], q = polyDist(ce.poly, ce.ori, ce.x + dxw(t.x, ce.x), t.y);
                var pen = q.inside ? q.d + t.r : t.r - q.d;
                if (pen > worst) { worst = pen; check.why = t.build.n + ' st' + st + ' g' + g + ' ghost' + t.ghost.toFixed(2) + ' m' + t.mode + ' blk' + t.blk; }
            }
        }
        for (var g2 = 0; g2 < Z.n; g2++) {
            var c2 = Z.CELL[g2];
            if (!c2 || !c2.ore) continue;
            var gr = gemFit(c2), q2 = polyDist(c2.poly, c2.ori, c2.px, c2.py);
            if (!q2.inside || q2.d < gr * 1.55 + inkW() * 0.5 - 0.01) gemOut++;
        }
        return { penPx: Math.round(worst * 10) / 10, gemOut: gemOut, why: worst > 3 ? check.why : '' };
    }
    window.dwHomeWorld = { build: build, step: step, draw: draw, release: release, stat: stat, check: check, builds: BUILDS.map(function (b) { return b.n; }), ready: function () { return !!(live && live.cv) && W > 0; } };
})();
