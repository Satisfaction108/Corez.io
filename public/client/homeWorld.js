(function () {
    'use strict';

    var TAU = Math.PI * 2, DEG = Math.PI / 180;
    var GEM_CUT = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
    var ORE_PAL = {
        1: ['rgba(90,44,14,0.9)', 'rgba(201,111,46,0.95)', 'rgba(237,167,102,0.95)', 'rgba(255,233,209,0.9)'],
        2: ['rgba(14,44,90,0.9)', 'rgba(59,124,224,0.95)', 'rgba(127,177,242,0.95)', 'rgba(226,240,255,0.9)'],
        3: ['rgba(61,14,74,0.9)', 'rgba(177,62,207,0.95)', 'rgba(217,138,240,0.95)', 'rgba(251,230,255,0.9)'],
        4: ['rgba(8,66,38,0.92)', 'rgba(31,191,107,0.95)', 'rgba(111,245,168,0.95)', 'rgba(232,255,242,0.95)']
    };
    var ORE_HALO = [0.011, 0.026, 0.041, 0.056, 0.07, 0.085];
    var ORE_FX_CSS = {
        1: ['rgb(201,111,46)', 'rgb(237,167,102)', 'rgb(160,80,30)'],
        2: ['rgb(59,124,224)', 'rgb(127,177,242)', 'rgb(35,90,180)'],
        3: ['rgb(177,62,207)', 'rgb(217,138,240)', 'rgb(130,40,160)'],
        4: ['rgb(31,191,107)', 'rgb(111,245,168)', 'rgb(18,128,72)']
    };
    var FLOOR = {
        light: { floor: '#cbcbcb', camo: ['rgba(0,0,0,0.035)', 'rgba(255,255,255,0.06)', 'rgba(0,0,0,0.06)'], grid: 'rgba(0,0,0,0.075)', ring: 'rgba(60,60,60,0.55)',
            padInk: '#555555', padFace: '#f4f4f4', padWell: '#dadada', padBand: '#b4b4b4', padTooth: '#d0d0d0', padTint: 0.45, padLine: -0.4 },
        dark: { floor: '#2a2b30', camo: ['rgba(0,0,0,0.1)', 'rgba(255,255,255,0.03)', 'rgba(0,0,0,0.17)'], grid: 'rgba(255,255,255,0.06)', ring: 'rgba(230,230,240,0.5)',
            padInk: '#111114', padFace: '#4b4d55', padWell: '#3a3c43', padBand: '#61636c', padTooth: '#6e7079', padTint: -0.3, padLine: -0.68 }
    };
    var VAULT_TEAM = '#3d8fff';
    var OUTLINE_INK = 'rgba(0,0,0,0.5)', BEVEL_LIGHT = 'rgba(255,255,255,0.3)', BEVEL_DARK = 'rgba(0,0,0,0.2)', SEAM_INK = 'rgba(0,0,0,0.5)';
    var CELL_LIGHT = 'rgba(255,255,255,0.34)', CELL_DARK = 'rgba(0,0,0,0.14)', SIDE_INK = 'rgba(0,0,0,0.42)', SIDE_EDGE_INK = 'rgba(0,0,0,0.5)', SHADOW_INK = 'rgba(0,0,0,0.085)';
    var CRACK = { base: 'rgba(0,0,0,0.55)', hot: 'rgba(0,0,0,0.3)', fill: 'rgb(0,0,0)', hairCss: [] };
    for (var cst = 0; cst <= 5; cst++) CRACK.hairCss.push('rgba(255,248,226,' + (0.32 + 0.05 * cst).toFixed(2) + ')');
    var TEAM = ['#00b2e1', '#f14e54', '#00e16e', '#bf7ff5', '#ffe869', '#2ee8c8'];
    var GUN = '#999999', BORDER = '#000000', BORDER_K = 0.25;
    var ORE_ODDS = [0.5, 0.28, 0.16, 0.06];

    function mirror(g) { return [g, [g[0], g[1], g[2], g[3], -g[4], -g[5], g[6]]]; }
    var BUILDS = [
        { n: 'Twin', R: 0.5, D: 1, V: 18, guns: [[20, 8, 1, 0, 5.5, 0, 0], [20, 8, 1, 0, -5.5, 0, 0.5]] },
        { n: 'Triple Shot', R: 0.55, D: 1, V: 18, guns: mirror([19, 8, 1, 0, 2, 18, 0.5]).concat([[22, 8, 1, 0, 0, 0, 0]]) },
        { n: 'Sniper', R: 0.9, D: 1.7, V: 26, guns: [[24, 8, 1, 0, 0, 0, 0]] },
        { n: 'Machine Gun', R: 0.22, D: 0.4, V: 18, spread: 0.12, guns: [[12, 10, 1.4, 8, 0, 0, 0]] },
        { n: 'Pounder', R: 0.85, D: 1.6, V: 15, guns: [[20.5, 12, 1, 0, 0, 0, 0]] },
        { n: 'Penta Shot', R: 0.62, D: 1, V: 18, guns: mirror([16, 8, 1, 0, 3, 30, 2 / 3]).concat(mirror([19, 8, 1, 0, 2, 15, 1 / 3]), [[22, 8, 1, 0, 0, 0, 0]]) },
        { n: 'Triplet', R: 0.55, D: 1, V: 18, guns: mirror([17.5, 8, 1, 0, 5.5, 0, 0.5]).concat([[21, 8, 1, 0, 0, 0, 0]]) },
        { n: 'Minigun', R: 0.45, D: 0.95, V: 18, guns: [[21, 8, 1, 0, 0, 0, 0], [19, 8, 1, 0, 0, 0, 1 / 3], [17, 8, 1, 0, 0, 0, 2 / 3]] },
        { n: 'Destroyer', R: 1.1, D: 2.3, V: 13, guns: [[20.5, 14, 1, 0, 0, 0, 0]] }
    ];
    for (var bi = 0; bi < BUILDS.length; bi++) {
        var bd0 = BUILDS[bi], nMain = 0;
        bd0.g = [];
        for (var gi = 0; gi < bd0.guns.length; gi++) {
            var q = bd0.guns[gi], a = q[5] > 180 ? q[5] - 360 : q[5];
            var o = { L: q[0] / 10, Wd: q[1] / 10, asp: q[2], X: q[3] / 10, Y: q[4] / 10, a: a * DEG, delay: q[6], main: Math.abs(a) <= 20 };
            if (o.main) nMain++;
            bd0.g.push(o);
        }
        bd0.nMain = nMain || 1;
    }

    var SOLID = 0, DUG = 1, OPEN = 2;
    var NBUF = 1024, AHEAD = 72, LUTN = 32;

    var world = null, bake = null, lastT = 0;
    var rs = 1;
    function rnd() { rs = (rs * 16807) % 2147483647; return (rs - 1) / 2147483646; }
    function hash(x, y, s) {
        var h = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 1284865837) ^ Math.imul((s | 0) + 1, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1540483477);
        h ^= h >>> 15;
        return (h >>> 0) / 4294967296;
    }
    function vh2(i, j) {
        var f = Math.fround;
        var px = f(f(i) * f(5.3983));
        px = f(px - Math.floor(px));
        var py = f(f(j) * f(5.4427));
        py = f(py - Math.floor(py));
        var d = f(f(py * f(f(px) + f(21.5351))) + f(f(px) * f(f(py) + f(14.3137))));
        px = f(px + d); py = f(py + d);
        var pxy = f(px * py);
        var rx = f(pxy * f(95.4307)); rx = f(rx - Math.floor(rx));
        var ry = f(pxy * f(97.597)); ry = f(ry - Math.floor(ry));
        rx = f(f(0.5) + f(f(rx - f(0.5)) * f(0.55)));
        ry = f(f(0.5) + f(f(ry - f(0.5)) * f(0.55)));
        return [Math.round(rx * 255) / 255, Math.round(ry * 255) / 255];
    }
    function clip(poly, mx, my, ndx, ndy) {
        var out = [], n = poly.length;
        for (var i = 0; i < n; i++) {
            var ax = poly[i][0], ay = poly[i][1], bx = poly[(i + 1) % n][0], by = poly[(i + 1) % n][1];
            var da = (ax - mx) * ndx + (ay - my) * ndy;
            var db = (bx - mx) * ndx + (by - my) * ndy;
            if (da <= 0) out.push([ax, ay]);
            if ((da < 0) !== (db < 0)) {
                var t = da / (da - db);
                out.push([ax + t * (bx - ax), ay + t * (by - ay)]);
            }
        }
        return out;
    }
    function wrap(i, n) { return ((i % n) + n) % n; }
    function fmod(x, p) { var v = x % p; return v < 0 ? v + p : v; }
    function smooth(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }
    function hexRgb(h) { var v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
    function mixHex(a, b, t) {
        var x = hexRgb(a), y = hexRgb(b);
        return 'rgb(' + Math.round(x[0] + (y[0] - x[0]) * t) + ',' + Math.round(x[1] + (y[1] - x[1]) * t) + ',' + Math.round(x[2] + (y[2] - x[2]) * t) + ')';
    }
    function tonesCss(t, o, dark) {
        var B = window.DWBiomes, out = [];
        for (var q = 0; q < 5; q++) {
            var r = t[o + q * 3], g = t[o + q * 3 + 1], b = t[o + q * 3 + 2];
            if (dark && B && B.deepTone) { var d = B.deepTone([r, g, b]); r = d[0]; g = d[1]; b = d[2]; }
            out.push('rgb(' + r + ',' + g + ',' + b + ')');
        }
        return out;
    }
    function worldMix(hex, k) {
        var c = hexRgb(hex);
        var f = function (v) { return Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k)); };
        return 'rgb(' + f(c[0]) + ',' + f(c[1]) + ',' + f(c[2]) + ')';
    }
    function polyPath(c, x, y, r, n, rot) {
        c.beginPath();
        for (var i = 0; i < n; i++) {
            var a = rot + i * TAU / n;
            if (i) c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        c.closePath();
    }
    function pickOdds(odds) {
        var u = rnd(), acc = 0;
        for (var i = 0; i < odds.length; i++) { acc += odds[i]; if (u < acc) return i + 1; }
        return odds.length;
    }

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
    function rayPoly(poly, px, py, dx, dy) {
        var m = poly.length, best = Infinity;
        for (var e = 0; e < m; e++) {
            var a = poly[e], b = poly[e + 1 < m ? e + 1 : 0];
            var ex = b[0] - a[0], ey = b[1] - a[1], den = dx * ey - dy * ex;
            if (Math.abs(den) < 1e-9) continue;
            var wx = a[0] - px, wy = a[1] - py;
            var t = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
            if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
        }
        return best;
    }

    function depositLayout(tier, poly, cx, cy, rockSz, h) {
        var want = tier === 4 ? 1 : tier === 3 ? 1 : tier === 2 ? 2 + (h(0, 220) < 0.5 ? 0 : 1) : 3 + (h(0, 220) < 0.5 ? 0 : 1);
        var baseR = (tier === 4 ? 0.14 : tier === 3 ? 0.15 : tier === 2 ? 0.16 : 0.13) * rockSz;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var pi = 0; pi < poly.length; pi++) {
            var p = poly[pi];
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
        }
        function inPoly(x, y) {
            var inside = false;
            for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
                if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
            }
            return inside;
        }
        function distToBorder(x, y) {
            var best = Infinity;
            for (var i = 0; i < poly.length; i++) {
                var a = poly[i], b = poly[(i + 1) % poly.length];
                var dx = b[0] - a[0], dy = b[1] - a[1];
                var L2 = dx * dx + dy * dy || 1e-12;
                var t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
                var ddx = x - (a[0] + t * dx), ddy = y - (a[1] + t * dy);
                var d = ddx * ddx + ddy * ddy;
                if (d < best) best = d;
            }
            return Math.sqrt(best);
        }
        var out = [];
        if (tier === 3 || tier === 4) {
            var bx = cx, by = cy, bdd = inPoly(cx, cy) ? distToBorder(cx, cy) : -1;
            var sx = (maxX - minX) / 8, sy = (maxY - minY) / 8, ox = minX, oy = minY;
            for (var pass = 0; pass < 2; pass++) {
                for (var gy = 0; gy <= 8; gy++) {
                    for (var gx = 0; gx <= 8; gx++) {
                        var x = ox + gx * sx, y = oy + gy * sy;
                        if (!inPoly(x, y)) continue;
                        var dd = distToBorder(x, y);
                        if (dd > bdd) { bdd = dd; bx = x; by = y; }
                    }
                }
                ox = bx - sx; oy = by - sy; sx /= 4; sy /= 4;
            }
            var r0 = (tier === 4 ? 0.34 : 0.30) * rockSz;
            out.push({ x: bx, y: by, r: bdd > 0 ? Math.min(r0, bdd * 0.78) : r0, rot: (h(1, 221) - 0.5) * 0.7, big: true });
        }
        for (var t = 0; t < 40 && out.length < want; t++) {
            var x2 = minX + h(t, 222) * (maxX - minX);
            var y2 = minY + h(t, 223) * (maxY - minY);
            if (!inPoly(x2, y2)) continue;
            if (distToBorder(x2, y2) < baseR * 1.5) continue;
            var ok = true;
            for (var di = 0; di < out.length; di++) {
                var d0 = out[di], ex = x2 - d0.x, ey = y2 - d0.y, need = (d0.r + baseR) * 1.7;
                if (ex * ex + ey * ey < need * need) { ok = false; break; }
            }
            if (!ok) continue;
            out.push({ x: x2, y: y2, r: baseR * (0.85 + h(t, 224) * 0.3), rot: (h(t, 225) - 0.5) * 0.9, big: false });
        }
        return out;
    }
    function putCut(path, x, y, r, rot, scale, ox, oy) {
        var c = Math.cos(rot), s = Math.sin(rot);
        for (var i = 0; i < GEM_CUT.length; i++) {
            var px = GEM_CUT[i][0] * r * scale + ox, py = GEM_CUT[i][1] * r * scale + oy;
            var wx = x + px * c - py * s, wy = y + px * s + py * c;
            if (i === 0) path.moveTo(wx, wy); else path.lineTo(wx, wy);
        }
        path.closePath();
    }

    function layout(w, h) {
        var small = Math.min(w, h) < 560;
        var s0 = small ? Math.min(w, h * 1.7) / 8.5 : Math.min(w, h * 1.7) / 21;
        var s = Math.max(small ? 44 : 56, Math.min(84, Math.round(s0 / 4) * 4));
        var cols = Math.max(16, Math.ceil(w * 1.35 / s / 8) * 8), rows = Math.max(16, Math.ceil(h * 1.35 / s / 8) * 8);
        return { s: s, cols: cols, rows: rows, small: small };
    }

    function biomeTones(S, seed) {
        var B = window.DWBiomes, cols = S.cols, rows = S.rows, n = cols * rows;
        var tone = new Uint8Array(n * 21);
        S.tone = tone;
        if (!B || !B.weightsAt || !B.tonesFor) {
            for (var f = 0; f < n; f++) {
                var base = [64, 42, 26, 122, 88, 54, 158, 118, 74, 196, 156, 96, 214, 176, 112, 255, 206, 92, 40, 30, 60];
                for (var q = 0; q < 21; q++) tone[f * 21 + q] = base[q];
            }
            return;
        }
        var A = 0.045 * cols / TAU, Bv = 0.05 * rows / TAU, raw = new Array(n);
        for (var j = 0; j < rows; j++) for (var i = 0; i < cols; i++) {
            var U = TAU * (i + 0.5) / cols, V = TAU * (j + 0.5) / rows;
            raw[j * cols + i] = B.weightsAt(0.42 + A * Math.cos(U) + Bv * Math.cos(V), 0.03 + A * Math.sin(U) + Bv * Math.sin(V), seed, new Array(B.N));
        }
        var w = new Array(B.N), K = [1, 2, 1];
        for (var jj = 0; jj < rows; jj++) for (var ii = 0; ii < cols; ii++) {
            for (var z = 0; z < B.N; z++) w[z] = 0;
            for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) {
                var rw = raw[wrap(jj + dj, rows) * cols + wrap(ii + di, cols)], kk = K[di + 1] * K[dj + 1] / 16;
                for (var z2 = 0; z2 < B.N; z2++) w[z2] += rw[z2] * kk;
            }
            var vl = B.hash(ii, jj, seed * 5 + 901) * 2 - 1, vh = B.hash(ii, jj, seed * 5 + 902) * 2 - 1;
            B.tonesFor(w, tone, (jj * cols + ii) * 21, vl, vh);
        }
    }

    function makeCells(S) {
        var cols = S.cols, rows = S.rows, s = S.s, n = cols * rows, t = S.tone;
        S.cell = new Array(n);
        for (var jj = 0; jj < rows; jj++) for (var ii = 0; ii < cols; ii++) {
            var c = jj * cols + ii;
            var hs = vh2(ii, jj), sx = ii + hs[0], sy = jj + hs[1];
            var poly = [[sx - 3, sy - 3], [sx + 3, sy - 3], [sx + 3, sy + 3], [sx - 3, sy + 3]];
            for (var dj = -2; dj <= 2 && poly.length >= 3; dj++) {
                for (var di = -2; di <= 2 && poly.length >= 3; di++) {
                    if (di === 0 && dj === 0) continue;
                    var nh = vh2(wrap(ii + di, cols), wrap(jj + dj, rows));
                    var tx = ii + di + nh[0], ty = jj + dj + nh[1];
                    poly = clip(poly, (sx + tx) / 2, (sy + ty) / 2, tx - sx, ty - sy);
                }
            }
            var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0, ar = 0;
            var path = new Path2D();
            for (var v = 0; v < poly.length; v++) {
                poly[v][0] *= s; poly[v][1] *= s;
                var px = poly[v][0], py = poly[v][1];
                if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
                cx += px; cy += py;
                if (v) path.lineTo(px, py); else path.moveTo(px, py);
            }
            path.closePath();
            for (var v2 = 0; v2 < poly.length; v2++) { var p0 = poly[v2], p1 = poly[(v2 + 1) % poly.length]; ar += p0[0] * p1[1] - p1[0] * p0[1]; }
            var ori = ar < 0 ? -1 : 1, la = (hs[0] - 0.5) * 0.8, o = c * 21;
            var cell = { c: c, ii: ii, jj: jj, sx: sx * s, sy: sy * s, poly: poly, path: path, ori: ori, x0: x0, y0: y0, x1: x1, y1: y1,
                cx: cx / poly.length, cy: cy / poly.length, ldx: Math.sin(la), ldy: -Math.cos(la), up: Math.atan2(-Math.cos(la), Math.sin(la)),
                tl: tonesCss(t, o, false), td: tonesCss(t, o, true),
                px: 0, py: 0, pr: 0, crk: null, ore: 0, dep: null, oBody: null, oFacet: null, oCore: null, kk: ((ii * 100003 + jj) & 0xffff) };
            var best = -1, bx = cell.cx, by = cell.cy, stx = (x1 - x0) / 8, sty = (y1 - y0) / 8;
            for (var pass = 0; pass < 3; pass++) {
                var ccx = bx, ccy = by;
                for (var gx = -4; gx <= 4; gx++) for (var gy = -4; gy <= 4; gy++) {
                    var qx = ccx + gx * stx, qy = ccy + gy * sty, qd = polyDist(poly, ori, qx, qy);
                    if (qd.inside && qd.d > best) { best = qd.d; bx = qx; by = qy; }
                }
                stx /= 4; sty /= 4;
            }
            cell.px = bx; cell.py = by; cell.pr = Math.max(0, best);
            S.cell[c] = cell;
        }
    }
    function setOre(S, cell, tier) {
        cell.ore = tier; cell.dep = null; cell.oBody = cell.oFacet = cell.oCore = null; cell.crk = null;
        if (!tier) return;
        var salt = S.salt, kk = cell.kk;
        var dep = depositLayout(tier, cell.poly, cell.cx, cell.cy, S.s, function (i, sv) { return hash(i, kk, (sv + salt) | 0); });
        if (!dep.length) { cell.ore = 0; return; }
        var body = new Path2D(), facet = new Path2D(), core = new Path2D();
        for (var i = 0; i < dep.length; i++) {
            var d = dep[i];
            putCut(body, d.x, d.y, d.r, d.rot, 1, 0, 0);
            putCut(facet, d.x, d.y, d.r, d.rot, 0.52, 0, -d.r * 0.12);
            putCut(core, d.x, d.y, d.r, d.rot, 0.2, -d.r * 0.22, -d.r * 0.3);
        }
        cell.dep = dep; cell.oBody = body; cell.oFacet = facet; cell.oCore = core;
    }
    function crackPal() {
        return CRACK;
    }
    function crackPath(S, cell, stage) {
        if (!cell.crk) cell.crk = [null, null, null, null, null, null];
        if (cell.crk[stage]) return cell.crk[stage];
        var poly = cell.poly, s = S.s, path = new Path2D(), off0 = hash(cell.ii, cell.jj, 70);
        for (var st = 0; st < stage; st++) {
            var ta = (off0 + st / 5) * TAU, tx = Math.cos(ta), ty = Math.sin(ta), best = -Infinity, sv = poly[0];
            for (var v = 0; v < poly.length; v++) {
                var dx = poly[v][0] - cell.cx, dy = poly[v][1] - cell.cy, dl = Math.hypot(dx, dy) || 1;
                var dd = (dx * tx + dy * ty) / dl;
                if (dd > best) { best = dd; sv = poly[v]; }
            }
            var lx = sv[0] + (cell.px - sv[0]) * 0.05, ly = sv[1] + (cell.py - sv[1]) * 0.05;
            path.moveTo(lx, ly);
            var reach = 0.55 + hash(cell.ii, st, 71) * 0.4, segs = 3 + ((hash(cell.jj, st, 76) * 2) | 0), bx = lx, by = ly;
            for (var k = 1; k <= segs; k++) {
                var u = reach * k / segs, jx = (hash(cell.ii + k, cell.jj + st, 72) - 0.5) * s * 0.2, jy = (hash(cell.ii + k, cell.jj + st, 73) - 0.5) * s * 0.2;
                var nx = sv[0] + (cell.px - sv[0]) * u + jx, ny = sv[1] + (cell.py - sv[1]) * u + jy;
                path.lineTo(nx, ny);
                if (k === 2) { bx = nx; by = ny; }
            }
            if (hash(cell.ii, st, 77) > 0.4) {
                path.moveTo(bx, by);
                path.lineTo(bx + (hash(cell.ii, cell.jj + st, 74) - 0.5) * s * 0.4, by + (hash(cell.ii, cell.jj + st, 75) - 0.5) * s * 0.4);
            }
        }
        cell.crk[stage] = path;
        return path;
    }

    function cellAt(S, i, j) { return S.cell[wrap(j, S.rows) * S.cols + wrap(i, S.cols)]; }
    var HIT = { c: -1, ox: 0, oy: 0 };
    function hitSolid(S, x, y, r) {
        var s = S.s, i0 = Math.floor(x / s), j0 = Math.floor(y / s), cols = S.cols, rows = S.rows;
        for (var dj = -2; dj <= 2; dj++) for (var di = -2; di <= 2; di++) {
            var i = i0 + di, j = j0 + dj, ii = wrap(i, cols), jj = wrap(j, rows), c = jj * cols + ii;
            if (S.ST[c] !== SOLID) continue;
            var cell = S.cell[c], ox = (i - ii) * s, oy = (j - jj) * s, lx = x - ox, ly = y - oy;
            if (lx < cell.x0 - r || lx > cell.x1 + r || ly < cell.y0 - r || ly > cell.y1 + r) continue;
            var q = polyDist(cell.poly, cell.ori, lx, ly);
            if (q.inside || q.d < r) { HIT.c = c; HIT.ox = ox; HIT.oy = oy; return true; }
        }
        return false;
    }
    function nearest(S, x, y) {
        var s = S.s, i0 = Math.floor(x / s), j0 = Math.floor(y / s), best = -1, bd = Infinity;
        for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) {
            var i = i0 + di, j = j0 + dj, ii = wrap(i, S.cols), jj = wrap(j, S.rows), c = jj * S.cols + ii, cell = S.cell[c];
            var dx = cell.sx + (i - ii) * s - x, dy = cell.sy + (j - jj) * s - y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = c; HIT.ox = (i - ii) * s; HIT.oy = (j - jj) * s; }
        }
        HIT.c = best;
        return best;
    }
    function wdx(S, a, b) { var d = a - b; return d - Math.round(d / S.P) * S.P; }
    function wdy(S, a, b) { var d = a - b; return d - Math.round(d / S.Q) * S.Q; }
    function tdist(S, ax, ay, bx, by) { return Math.hypot(wdx(S, ax, bx), wdy(S, ay, by)); }

    function carve(S, x, y, rad, kind) {
        var s = S.s, i0 = Math.floor(x / s), j0 = Math.floor(y / s), m = Math.ceil(rad / s) + 1;
        for (var dj = -m; dj <= m; dj++) for (var di = -m; di <= m; di++) {
            var i = i0 + di, j = j0 + dj, c = wrap(j, S.rows) * S.cols + wrap(i, S.cols), cell = S.cell[c];
            if (Math.hypot(cell.sx + (i - wrap(i, S.cols)) * s - x, cell.sy + (j - wrap(j, S.rows)) * s - y) > rad) continue;
            if (S.ST[c] === OPEN) continue;
            S.ST[c] = kind;
            S.DUGAT[c] = S.t - rnd() * 30;
        }
    }
    function carveLine(S, ax, ay, bx, by, rad, kind) {
        var L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / (S.s * 0.3)));
        for (var k = 0; k <= n; k++) carve(S, ax + (bx - ax) * k / n, ay + (by - ay) * k / n, rad, kind);
    }

    function makeTank(S, k, home, build, col) {
        var s = S.s, r = s * 0.33;
        var t = { k: k, hx: home[0], hy: home[1], R0: home[2], build: build, col: col, line: mixHex(col, BORDER, BORDER_K), r: r,
            buf: new Float64Array(NBUF * 2), wn: 0, u: 0, carry: 0, cp: new Float64Array(8), lut: new Float64Array(LUTN + 1), lxy: new Float64Array((LUTN + 1) * 2),
            x: 0, y: 0, v: 0, ang: 0, rec: new Float32Array(build.g.length), gq: new Float32Array(build.g.length).fill(-1),
            fire: 0.3 + k * 0.2, tc: -1, tox: 0, toy: 0, gems: 0, gulp: 0, bankCD: 0, dStop: Infinity, spin: rnd() < 0.5 ? 1 : -1 };
        var a0 = rnd() * TAU, sx = home[0] + Math.cos(a0) * home[2], sy = home[1] + Math.sin(a0) * home[2];
        var hd = a0 + t.spin * Math.PI / 2, L = s * 2;
        t.cp[0] = sx - Math.cos(hd) * L; t.cp[1] = sy - Math.sin(hd) * L;
        t.cp[2] = sx; t.cp[3] = sy;
        nextPoint(S, t, sx, sy, hd, 4);
        nextPoint(S, t, t.cp[4], t.cp[5], Math.atan2(t.cp[5] - sy, t.cp[4] - sx), 6);
        carve(S, sx, sy, s * 1.05, DUG);
        t.x = sx; t.y = sy; t.ang = hd;
        return t;
    }
    function nextPoint(S, t, px, py, hd, slot) {
        var s = S.s, best = -Infinity, bx = px, by = py;
        for (var q = 0; q < 9; q++) {
            var dl = (q - 4) * 0.21 + (rnd() - 0.5) * 0.12, L = s * (1.7 + rnd() * 0.9);
            var x = px + Math.cos(hd + dl) * L, y = py + Math.sin(hd + dl) * L;
            var dh = tdist(S, x, y, t.hx, t.hy), sc = -Math.abs(dh - t.R0) / s * 1.2 - Math.abs(dl) * 0.5 + rnd() * 0.35;
            var tanks = S.tanks;
            for (var o = 0; tanks && o < tanks.length; o++) {
                var ot = tanks[o];
                if (ot === t) continue;
                var d1 = tdist(S, x, y, ot.x, ot.y), d2 = tdist(S, x, y, ot.cp[6], ot.cp[7]);
                if (d1 < s * 3.2) sc -= (s * 3.2 - d1) / s * 2;
                if (d2 < s * 3) sc -= (s * 3 - d2) / s * 2;
            }
            if (sc > best) { best = sc; bx = x; by = y; }
        }
        t.cp[slot] = bx; t.cp[slot + 1] = by;
    }
    function appendSeg(S, t) {
        var cp = t.cp, lut = t.lut, lxy = t.lxy;
        var p0x = cp[0], p0y = cp[1], p1x = cp[2], p1y = cp[3], p2x = cp[4], p2y = cp[5], p3x = cp[6], p3y = cp[7];
        var L = 0, lx = p1x, ly = p1y;
        lut[0] = 0; lxy[0] = p1x; lxy[1] = p1y;
        for (var i = 1; i <= LUTN; i++) {
            var u = i / LUTN, u2 = u * u, u3 = u2 * u;
            var x = 0.5 * (2 * p1x + (-p0x + p2x) * u + (2 * p0x - 5 * p1x + 4 * p2x - p3x) * u2 + (-p0x + 3 * p1x - 3 * p2x + p3x) * u3);
            var y = 0.5 * (2 * p1y + (-p0y + p2y) * u + (2 * p0y - 5 * p1y + 4 * p2y - p3y) * u2 + (-p0y + 3 * p1y - 3 * p2y + p3y) * u3);
            L += Math.hypot(x - lx, y - ly);
            lut[i] = L; lxy[i * 2] = x; lxy[i * 2 + 1] = y;
            lx = x; ly = y;
        }
        var ds = S.ds, d = t.carry, li = 0;
        while (d < L) {
            while (li < LUTN - 1 && lut[li + 1] < d) li++;
            var span = lut[li + 1] - lut[li] || 1, f = (d - lut[li]) / span, w = (t.wn % NBUF) * 2;
            t.buf[w] = lxy[li * 2] + (lxy[li * 2 + 2] - lxy[li * 2]) * f;
            t.buf[w + 1] = lxy[li * 2 + 1] + (lxy[li * 2 + 3] - lxy[li * 2 + 1]) * f;
            t.wn++;
            d += ds;
        }
        t.carry = d - L;
        cp[0] = p1x; cp[1] = p1y; cp[2] = p2x; cp[3] = p2y; cp[4] = p3x; cp[5] = p3y;
        nextPoint(S, t, p3x, p3y, Math.atan2(p3y - p2y, p3x - p2x), 6);
    }
    var SP = { x: 0, y: 0 };
    function sampleAt(t, u) {
        var i = Math.floor(u), f = u - i, a = (i % NBUF) * 2, b = ((i + 1) % NBUF) * 2, B = t.buf;
        SP.x = B[a] + (B[b] - B[a]) * f; SP.y = B[a + 1] + (B[b + 1] - B[a + 1]) * f;
        return SP;
    }

    function newWorld(w, h) {
        var L = layout(w, h);
        var S = { W: w, H: h, s: L.s, cols: L.cols, rows: L.rows, small: L.small, P: L.cols * L.s, Q: L.rows * L.s, light: false, t: 0,
            seed: 1 + ((Math.random() * 97) | 0), salt: (Math.random() * 100000) | 0, ds: L.s * 0.08, cache: null, cacheK: 0, ov: null, ovKey: '', zoneAt: 0, zone: null,
            vs: null, vsD: 0, stat: { breaks: 0, gems: 0, banks: 0, shots: 0, regrows: 0, hits: 0 }, regrowAt: 2, vx: 0, vy: 0 };
        rs = (Math.floor(Math.random() * 2147483646) + 1);
        var n = S.cols * S.rows;
        S.ST = new Uint8Array(n); S.HP = new Float32Array(n); S.HP0 = new Float32Array(n); S.DUGAT = new Float32Array(n);
        biomeTones(S, S.seed);
        makeCells(S);
        var odds = ORE_ODDS;
        for (var c = 0; c < n; c++) {
            setOre(S, S.cell[c], rnd() < 0.11 ? pickOdds(odds) : 0);
            S.HP0[c] = S.HP[c] = hpOf(S.cell[c]);
        }
        var s = S.s;
        S.vault = [S.P * (0.35 + rnd() * 0.3), S.Q * (0.35 + rnd() * 0.3)];
        S.vaultR = s * 1.0;
        carve(S, S.vault[0], S.vault[1], s * 1.75, OPEN);
        var V = S.vault;
        S.camA = (rnd() < 0.5 ? 0.35 : Math.PI - 0.35) + (rnd() - 0.5) * 0.3; S.camT = rnd() * 100; S.camV = S.small ? 9 : 13;
        var vxs = S.small ? 0.5 : Math.cos(S.camA) > 0 ? 0.7 : 0.3;
        S.camX = V[0] - w * vxs; S.camY = V[1] - h * (S.small ? 0.8 : 0.72);
        S.vx = fmod(S.camX, S.P); S.vy = fmod(S.camY, S.Q);
        var nt = L.small ? 4 : w >= 1400 ? 7 : w >= 1000 ? 6 : 5;
        var homes = [], R0 = L.small ? 1.9 : 2.6;
        var a0 = rnd() * TAU;
        homes.push([S.vault[0] + Math.cos(a0) * s * 2.7, S.vault[1] + Math.sin(a0) * s * 2.7, s * (R0 + rnd() * 0.5)]);
        for (var k = 1; k < nt; k++) {
            var bx = 0, by = 0, bs = -1;
            for (var tr = 0; tr < 48; tr++) {
                var vis = k < 4 && tr < 32, x = vis ? S.camX + w * (0.16 + rnd() * 0.68) : rnd() * S.P, y = vis ? S.camY + h * (0.24 + rnd() * 0.56) : rnd() * S.Q;
                var md = tdist(S, x, y, S.vault[0], S.vault[1]) * 0.8;
                for (var h2 = 0; h2 < homes.length; h2++) md = Math.min(md, tdist(S, x, y, homes[h2][0], homes[h2][1]));
                var zx = (x - S.camX) / w, zy = (y - S.camY) / h;
                if (vis && zx > 0.3 && zx < 0.7 && zy < 0.55) md *= 0.4;
                if (md > bs) { bs = md; bx = x; by = y; }
            }
            homes.push([bx, by, s * (R0 + rnd() * 0.6)]);
        }
        for (var h3 = 0; h3 < homes.length; h3++) {
            var hx = homes[h3][0], hy = homes[h3][1], vx = S.vault[0] + wdx(S, hx, S.vault[0]), vy = S.vault[1] + wdy(S, hy, S.vault[1]);
            if (h3 < 2 || rnd() < 0.5) {
                var mx = (hx + vx) / 2 + (rnd() - 0.5) * s * 2, my = (hy + vy) / 2 + (rnd() - 0.5) * s * 2;
                carveLine(S, vx, vy, mx, my, s * 0.55, OPEN);
                carveLine(S, mx, my, hx + (rnd() - 0.5) * s, hy + (rnd() - 0.5) * s, s * 0.55, OPEN);
            }
        }
        for (var c2 = 0; c2 < n; c2++) if (S.ST[c2] === SOLID && rnd() < 0.025) { S.ST[c2] = OPEN; }
        var pool = BUILDS.slice(), pinned = window.dwHomeWorldBuilds, team = TEAM;
        for (var pi = pool.length - 1; pi > 0; pi--) { var pj = (rnd() * (pi + 1)) | 0, tmp = pool[pi]; pool[pi] = pool[pj]; pool[pj] = tmp; }
        S.tanks = [];
        var toff = (rnd() * team.length) | 0;
        for (var k2 = 0; k2 < nt; k2++) {
            var bd = pool[k2 % pool.length];
            if (pinned && pinned[k2]) for (var q2 = 0; q2 < BUILDS.length; q2++) if (BUILDS[q2].n === pinned[k2]) bd = BUILDS[q2];
            S.tanks.push(makeTank(S, k2, homes[k2], bd, team[(k2 + toff) % team.length]));
        }
        for (var k3 = 0; k3 < nt; k3++) { var tk = S.tanks[k3]; while (tk.wn < AHEAD + 4) appendSeg(S, tk); }
        S.bullets = pool0(40, function () { return { on: 0, x: 0, y: 0, dx: 0, dy: 0, d: 0, tr: 0, v: 0, r: 3, k: 0, kind: 0, c: -1, dmg: 0 }; });
        S.chips = pool0(56, function () { return { on: 0, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, t: 0, life: 1, col: '', sz: 0 }; });
        S.bursts = pool0(6, function () { return { on: 0, t: 0, c: -1, x: 0, y: 0, parts: new Float32Array(46 * 8), sparks: new Float32Array(40 * 3), nS: 0, pal: null, cc: null }; });
        S.gems = pool0(48, function () { return { on: 0, kind: 0, x0: 0, y0: 0, px: 0, py: 0, t: 0, dur: 1, tier: 1, rot: 0, vr: 0, r: 4, tk: 0 }; });
        S.dmg = pool0(12, function () { return { on: 0, c: -1, stage: 0, flash: 0, snap: 0 }; });
        S.vaultPulse = 0;
        for (var it = 0; it < 240; it++) simulate(S, 1 / 30);
        return S;
    }
    function hpOf(cell) { return cell.ore ? 2.8 + cell.ore * 0.5 : 2.1 + hash(cell.ii, cell.jj, 5) * 0.7; }
    function pool0(n, mk) { var a = []; for (var i = 0; i < n; i++) a.push(mk()); return a; }

    function floorTile(F, k, art) {
        var tile = document.createElement('canvas');
        tile.width = tile.height = F;
        var t = tile.getContext('2d'), seed = 11, area = (F / k) * (F / k) / (768 * 768);
        function rng() { seed = (Math.imul(seed, 1597334677) + 926135893) | 0; return ((seed >>> 8) & 0xffffff) / 0x1000000; }
        t.fillStyle = art.floor;
        t.fillRect(0, 0, F, F);
        var counts = [13, 11, 12], sizes = [[70, 140], [55, 120], [26, 62]];
        for (var layer = 0; layer < 3; layer++) {
            t.beginPath();
            var n0 = Math.max(2, Math.round(counts[layer] * area));
            for (var b = 0; b < n0; b++) {
                var x = rng() * F, y = rng() * F, r = (sizes[layer][0] + rng() * (sizes[layer][1] - sizes[layer][0])) * k;
                var stretch = 1 + rng() * 0.9, rot = rng() * Math.PI, ca = Math.cos(rot), sa = Math.sin(rot);
                var n = 11 + (rng() * 5 | 0), wob = rng() * 6.28, pts = [];
                for (var i = 0; i < n; i++) {
                    var a = (i / n) * TAU, rr = r * (0.62 + 0.38 * Math.sin(a * 2 + wob) * 0.5 + rng() * 0.42);
                    var px = Math.cos(a) * rr * stretch, py = Math.sin(a) * rr;
                    pts.push([x + px * ca - py * sa, y + px * sa + py * ca]);
                }
                for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
                    var ox = dx * F, oy = dy * F;
                    t.moveTo((pts[n - 1][0] + pts[0][0]) / 2 + ox, (pts[n - 1][1] + pts[0][1]) / 2 + oy);
                    for (var q = 0; q < n; q++) {
                        var p = pts[q], nx = pts[(q + 1) % n];
                        t.quadraticCurveTo(p[0] + ox, p[1] + oy, (p[0] + nx[0]) / 2 + ox, (p[1] + nx[1]) / 2 + oy);
                    }
                    t.closePath();
                }
            }
            t.fillStyle = art.camo[layer];
            t.fill();
        }
        return tile;
    }
    var speckle = null;
    function speckleTile() {
        if (speckle) return speckle;
        var N = 256, cv = document.createElement('canvas');
        cv.width = cv.height = N;
        var g = cv.getContext('2d'), seed = 41;
        var rng = function () { seed = (Math.imul(seed, 1597334677) + 926135893) | 0; return ((seed >>> 8) & 0xffffff) / 0x1000000; };
        var dot = function (x, y, r) {
            for (var ox = -N; ox <= N; ox += N) for (var oy = -N; oy <= N; oy += N) {
                if (x + ox + r < 0 || x + ox - r > N || y + oy + r < 0 || y + oy - r > N) continue;
                g.moveTo(x + ox + r, y + oy);
                g.arc(x + ox, y + oy, r, 0, TAU);
            }
        };
        for (var pass = 0; pass < 3; pass++) {
            g.beginPath();
            var count = pass === 0 ? 70 : pass === 1 ? 900 : 260;
            for (var i = 0; i < count; i++) {
                var r = pass === 0 ? 7 + rng() * 14 : pass === 1 ? 0.7 + rng() * 1.3 : 0.6 + rng() * 1.1;
                dot(rng() * N, rng() * N, r);
            }
            g.fillStyle = pass === 0 ? 'rgba(0,0,0,0.035)' : pass === 1 ? 'rgba(0,0,0,0.11)' : 'rgba(255,255,255,0.13)';
            g.fill();
        }
        speckle = cv;
        return cv;
    }
    function grainTile(T) {
        var cv = document.createElement('canvas');
        cv.width = cv.height = T;
        cv.getContext('2d').drawImage(speckleTile(), 0, 0, T, T);
        return cv;
    }

    function newBake(S, k) {
        var F = Math.round(S.s * 8 * k), T = F * Math.max(1, Math.round(1024 / F));
        var Pd = Math.round(S.P * k), Qd = Math.round(S.Q * k);
        var fl = floorTile(F, k, S.light ? FLOOR.light : FLOOR.dark), gr = grainTile(Math.round(S.s * 2 * k));
        var B = { k: k, light: S.light, T: T, Pd: Pd, Qd: Qd, fl: fl, gr: gr, tl: [], tiles: [], n: 0, dirty: [], ms: 0, slices: 0, g: null, grainPat: null, floorPat: null, tx: 0, ty: 0, w: 0, h: 0 };
        for (var Y = 0; Y < Qd; Y += T) for (var X = 0; X < Pd; X += T) {
            var cv = document.createElement('canvas');
            cv.width = Math.min(T, Pd - X); cv.height = Math.min(T, Qd - Y);
            var g = cv.getContext('2d');
            B.tl.push({ cv: cv, g: g, X: X, Y: Y, w: cv.width, h: cv.height, floorPat: g.createPattern(fl, 'repeat'), grainPat: g.createPattern(gr, 'repeat') });
            B.tiles.push([X / k, Y / k, (X + cv.width) / k, (Y + cv.height) / k]);
        }
        return B;
    }
    function wedge(g, ox, oy, a0, R) {
        var WA = Math.acos(1 / 3);
        g.beginPath();
        g.moveTo(ox, oy);
        g.lineTo(ox + Math.cos(a0 - WA) * R, oy + Math.sin(a0 - WA) * R);
        g.lineTo(ox + Math.cos(a0) * R, oy + Math.sin(a0) * R);
        g.lineTo(ox + Math.cos(a0 + WA) * R, oy + Math.sin(a0 + WA) * R);
        g.closePath();
    }
    function paintRect(S, B, x0, y0, x1, y1) {
        var k = B.k;
        var X0 = Math.max(0, Math.floor(x0 * k)), Y0 = Math.max(0, Math.floor(y0 * k));
        var X1 = Math.min(B.Pd, Math.ceil(x1 * k)), Y1 = Math.min(B.Qd, Math.ceil(y1 * k));
        if (X1 <= X0 || Y1 <= Y0) return;
        for (var i = 0; i < B.tl.length; i++) {
            var t = B.tl[i], a0 = Math.max(X0, t.X), b0 = Math.max(Y0, t.Y), a1 = Math.min(X1, t.X + t.w), b1 = Math.min(Y1, t.Y + t.h);
            if (a1 <= a0 || b1 <= b0) continue;
            B.g = t.g; B.grainPat = t.grainPat; B.floorPat = t.floorPat; B.tx = t.X; B.ty = t.Y;
            paintTile(S, B, a0, b0, a1, b1);
        }
    }
    function paintTile(S, B, X0, Y0, X1, Y1) {
        var g = B.g, k = B.k, s = S.s, cols = S.cols, rows = S.rows, tx = B.tx, ty = B.ty, art = B.light ? FLOOR.light : FLOOR.dark;
        var wx0 = X0 / k, wy0 = Y0 / k, wx1 = X1 / k, wy1 = Y1 / k;
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        g.beginPath(); g.rect(X0 - tx, Y0 - ty, X1 - X0, Y1 - Y0); g.clip();
        g.fillStyle = B.floorPat; g.fillRect(X0 - tx, Y0 - ty, X1 - X0, Y1 - Y0);
        var gp = s / 2, lw = Math.max(1, Math.round(k));
        g.fillStyle = art.grid;
        for (var m = Math.floor(wx0 / gp); m * gp <= wx1; m++) g.fillRect(Math.round(m * gp * k) - tx, Y0 - ty, lw, Y1 - Y0);
        for (var m2 = Math.floor(wy0 / gp); m2 * gp <= wy1; m2++) g.fillRect(X0 - tx, Math.round(m2 * gp * k) - ty, X1 - X0, lw);
        var M = s * 0.45;
        var ia = Math.max(-1, Math.floor((wx0 - M) / s) - 1), ib = Math.min(cols, Math.floor((wx1 + M) / s) + 1);
        var ja = Math.max(-1, Math.floor((wy0 - M) / s) - 1), jb = Math.min(rows, Math.floor((wy1 + M) / s) + 1);
        var solid = new Path2D(), open = new Path2D(), list = [], i, j, ii, jj, c, cell, ox, oy;
        for (j = ja; j <= jb; j++) for (i = ia; i <= ib; i++) {
            ii = wrap(i, cols); jj = wrap(j, rows); c = jj * cols + ii;
            cell = S.cell[c]; ox = (i - ii) * s; oy = (j - jj) * s;
            if (cell.x1 + ox < wx0 - M || cell.x0 + ox > wx1 + M || cell.y1 + oy < wy0 - M || cell.y0 + oy > wy1 + M) continue;
            var mtx = { a: 1, b: 0, c: 0, d: 1, e: ox, f: oy };
            if (S.ST[c] === SOLID) { solid.addPath(cell.path, mtx); list.push(cell, ox, oy); }
            else open.addPath(cell.path, mtx);
        }
        if (list.length) {
            var sideE = Math.min(5, 0.12 * s), outlineW = Math.min(11.2, 0.26 * s), bevD = Math.min(3.6, 0.16 * s);
            var seamW = Math.min(3.4, 0.09 * s), bev = Math.min(2.4, 0.06 * s), R = 3 * s, q, tn;
            g.setTransform(k, 0, 0, k, -tx, -ty);
            g.lineJoin = 'round';
            g.lineCap = 'round';
            g.save();
            g.translate(sideE * 1.5, sideE * 1.5);
            g.strokeStyle = SHADOW_INK;
            g.lineWidth = sideE * 3.4; g.stroke(solid);
            g.lineWidth = sideE * 1.9; g.stroke(solid);
            g.restore();
            g.save();
            g.translate(sideE, sideE);
            for (q = 0; q < list.length; q += 3) {
                cell = list[q];
                g.save(); g.translate(list[q + 1], list[q + 2]);
                g.fillStyle = (B.light ? cell.tl : cell.td)[1]; g.fill(cell.path);
                g.restore();
            }
            g.fillStyle = SIDE_INK; g.fill(solid);
            g.lineWidth = Math.min(2.2, sideE); g.strokeStyle = SIDE_EDGE_INK; g.stroke(solid);
            g.restore();
            for (q = 0; q < list.length; q += 3) {
                cell = list[q]; tn = B.light ? cell.tl : cell.td;
                g.save();
                g.translate(list[q + 1], list[q + 2]);
                g.clip(cell.path);
                g.fillStyle = tn[2]; g.fill(cell.path);
                wedge(g, cell.sx, cell.sy, cell.up, R); g.fillStyle = tn[3]; g.fill();
                wedge(g, cell.sx, cell.sy, cell.up + Math.PI, R); g.fillStyle = tn[1]; g.fill();
                g.lineWidth = seamW + bev * 2;
                g.translate(bev, bev); g.strokeStyle = CELL_LIGHT; g.stroke(cell.path);
                g.translate(-2 * bev, -2 * bev); g.strokeStyle = CELL_DARK; g.stroke(cell.path);
                g.restore();
            }
            g.lineWidth = seamW; g.strokeStyle = SEAM_INK; g.stroke(solid);
            g.save();
            g.clip(solid);
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.fillStyle = B.grainPat;
            g.fillRect(X0 - tx, Y0 - ty, X1 - X0, Y1 - Y0);
            g.restore();
            for (q = 0; q < list.length; q += 3) {
                cell = list[q];
                if (!cell.ore || !cell.oBody) continue;
                g.save();
                g.translate(list[q + 1], list[q + 2]);
                g.clip(cell.path);
                g.strokeStyle = 'rgb(8,6,12)';
                g.globalAlpha = 0.3;
                for (var hI = ORE_HALO.length - 1; hI >= 0; hI--) { g.lineWidth = ORE_HALO[hI] * s; g.stroke(cell.oBody); }
                g.globalAlpha = 1;
                var pal = ORE_PAL[cell.ore];
                g.fillStyle = pal[1]; g.fill(cell.oBody);
                g.strokeStyle = pal[0]; g.lineWidth = 0.022 * s; g.stroke(cell.oBody);
                g.fillStyle = pal[2]; g.fill(cell.oFacet);
                g.fillStyle = pal[3]; g.fill(cell.oCore);
                g.restore();
            }
            g.save();
            g.clip(solid);
            g.lineWidth = outlineW + bevD * 2;
            g.translate(bevD, bevD); g.strokeStyle = BEVEL_LIGHT; g.stroke(open);
            g.translate(-2 * bevD, -2 * bevD); g.strokeStyle = BEVEL_DARK; g.stroke(open);
            g.translate(bevD, bevD);
            g.lineWidth = outlineW; g.strokeStyle = OUTLINE_INK; g.stroke(open);
            g.restore();
        }
        g.restore();
    }
    function repaint(S, c) {
        var cell = S.cell[c], m = S.s * 0.45;
        var x0 = cell.x0 - m, y0 = cell.y0 - m, x1 = cell.x1 + m, y1 = cell.y1 + m;
        for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) {
            var ax0 = Math.max(0, x0 + a * S.P), ax1 = Math.min(S.P, x1 + a * S.P), ay0 = Math.max(0, y0 + b * S.Q), ay1 = Math.min(S.Q, y1 + b * S.Q);
            if (ax1 <= ax0 || ay1 <= ay0) continue;
            if (S.cacheB) paintRect(S, S.cacheB, ax0, ay0, ax1, ay1);
            if (bake && bake.S === S) bake.dirty.push([ax0, ay0, ax1, ay1]);
        }
    }

    function makeVault(D, R, light) {
        var art = light ? FLOOR.light : FLOOR.dark, Sw = R * 2, px = Math.max(16, Math.ceil(Sw * D)), S0 = 256, C = 128, INK = art.padInk, LW = 6, team = VAULT_TEAM;
        function layer(fn) {
            var cv = document.createElement('canvas');
            cv.width = cv.height = px;
            var c = cv.getContext('2d');
            c.setTransform(px / S0, 0, 0, px / S0, 0, 0);
            c.translate(C, C);
            c.lineJoin = 'round'; c.lineCap = 'round';
            fn(c);
            return cv;
        }
        function disc(c, r, fill, lw) {
            c.beginPath(); c.arc(0, 0, r, 0, TAU);
            c.fillStyle = fill; c.fill();
            if (lw) { c.lineWidth = lw; c.strokeStyle = INK; c.stroke(); }
        }
        var plate = layer(function (c) {
            disc(c, S0 * 0.46, art.padFace, LW);
            c.lineWidth = S0 * 0.032; c.strokeStyle = team;
            c.beginPath(); c.arc(0, 0, S0 * 0.425, 0, TAU); c.stroke();
            c.lineWidth = 3; c.strokeStyle = INK;
            c.beginPath(); c.arc(0, 0, S0 * 0.405, 0, TAU); c.stroke();
            disc(c, S0 * 0.325, art.padWell, LW);
        });
        var cog = layer(function (c) {
            c.lineWidth = S0 * 0.045 + LW; c.strokeStyle = INK;
            c.beginPath(); c.arc(0, 0, S0 * 0.365, 0, TAU); c.stroke();
            c.lineWidth = S0 * 0.045; c.strokeStyle = art.padBand; c.stroke();
            for (var i = 0; i < 12; i++) {
                c.save();
                c.rotate((i / 12) * TAU);
                c.beginPath(); c.rect(S0 * 0.335, -S0 * 0.019, S0 * 0.06, S0 * 0.038);
                c.fillStyle = i % 3 === 0 ? team : art.padTooth; c.fill();
                c.lineWidth = 3; c.strokeStyle = INK; c.stroke();
                c.restore();
            }
        });
        var wheel = layer(function (c) {
            function spoke(w, col) {
                c.lineWidth = w; c.strokeStyle = col;
                c.beginPath();
                for (var i = 0; i < 3; i++) {
                    var a = (i / 3) * TAU - Math.PI / 2;
                    c.moveTo(Math.cos(a) * S0 * 0.12, Math.sin(a) * S0 * 0.12);
                    c.lineTo(Math.cos(a) * S0 * 0.25, Math.sin(a) * S0 * 0.25);
                }
                c.stroke();
            }
            spoke(S0 * 0.045 + LW, INK);
            spoke(S0 * 0.045, art.padBand);
            function gem() {
                c.beginPath();
                for (var i = 0; i < GEM_CUT.length; i++) {
                    var x = GEM_CUT[i][0] * S0 * 0.15, y = GEM_CUT[i][1] * S0 * 0.15;
                    if (i) c.lineTo(x, y); else c.moveTo(x, y);
                }
                c.closePath();
            }
            gem(); c.fillStyle = team; c.fill();
            c.save(); gem(); c.clip();
            c.fillStyle = 'rgba(255,255,255,0.35)';
            c.fillRect(-S0 * 0.15, -S0 * 0.15, S0 * 0.3, S0 * 0.085);
            c.restore();
            gem(); c.lineWidth = LW; c.strokeStyle = worldMix(team, -0.4); c.stroke();
        });
        return { plate: plate, cog: cog, wheel: wheel, Sw: Sw, D: D, light: !!light, padFill: worldMix(team, art.padTint), padLine: worldMix(team, art.padLine), lw: Math.max(1.5, R * 0.035) };
    }

    function build(w, h, ratio, isLight) {
        var t0 = performance.now();
        var L = layout(w, h), S = world;
        if (!S || S.s !== L.s || S.cols !== L.cols || S.rows !== L.rows) {
            if (S) release();
            S = world = newWorld(w, h);
        }
        S.W = w; S.H = h; S.light = !!isLight;
        var k = Math.min(ratio || 1, 2), cap = Math.sqrt((S.small ? 5e6 : 9e6) / (S.P * S.Q));
        k = Math.max(0.5, Math.floor(Math.min(k, cap) * 4) / 4);
        if ((!S.cache || S.cacheK !== k || S.cacheL !== S.light) && !(bake && bake.S === S && bake.k === k && bake.light === S.light)) {
            if (bake) dropBake(bake);
            bake = newBake(S, k);
            bake.S = S;
        }
        var D = Math.min(window.devicePixelRatio || 1, 2);
        if (!S.vs || S.vs.D !== D || S.vs.light !== S.light) S.vs = makeVault(D, S.vaultR, S.light);
        S.buildMs = performance.now() - t0;
    }
    function dropBake(B) {
        for (var i = 0; i < B.tl.length; i++) { var t = B.tl[i]; t.cv.width = 0; t.cv.height = 0; t.floorPat = t.grainPat = null; t.g = null; }
        B.tl.length = 0;
        if (B.fl) B.fl.width = 0;
        if (B.gr) B.gr.width = 0;
        B.floorPat = B.grainPat = null; B.g = null;
    }
    function step(budget) {
        var B = bake;
        if (!B) return !!(world && world.cache);
        var S = B.S, t0 = performance.now(), lim = budget || 8;
        B.slices++;
        while (B.n < B.tiles.length) {
            var r = B.tiles[B.n++];
            paintRect(S, B, r[0], r[1], r[2], r[3]);
            if (performance.now() - t0 > lim && B.n < B.tiles.length) { B.ms += performance.now() - t0; return false; }
        }
        for (var d = 0; d < B.dirty.length; d++) { var q = B.dirty[d]; paintRect(S, B, q[0], q[1], q[2], q[3]); }
        B.dirty.length = 0;
        if (S.cacheB && S.cacheB !== B) dropBake(S.cacheB);
        S.cache = B; S.cacheK = B.k; S.cacheB = B; S.cacheL = B.light;
        bake = null;
        B.ms += performance.now() - t0;
        window.dwHomeWorldStat = { bakeMs: Math.round(B.ms * 10) / 10, buildMs: Math.round((S.buildMs || 0) * 10) / 10, slices: B.slices, at: Math.round(performance.now()), px: B.Pd + 'x' + B.Qd, tiles: B.tl.length, T: B.T, cell: S.s, tanks: S.tanks.length, k: B.k };
        return true;
    }

    function fireGun(S, t, gk) {
        var g = t.build.g[gk], bs = S.bullets, b = null;
        for (var i = 0; i < bs.length; i++) if (!bs[i].on) { b = bs[i]; break; }
        if (!b) return;
        var a = t.ang + g.a + (t.build.spread ? (rnd() - 0.5) * t.build.spread : 0), ca = Math.cos(a), sa = Math.sin(a);
        var a0 = t.ang + g.a, c0 = Math.cos(a0), s0 = Math.sin(a0);
        var mx = t.x + (g.X * c0 - g.Y * s0) * t.r + c0 * (g.X + g.L) * t.r, my = t.y + (g.X * s0 + g.Y * c0) * t.r + s0 * (g.X + g.L) * t.r;
        b.on = 1; b.k = t.k; b.tr = 0; b.x = mx; b.y = my; b.dx = ca; b.dy = sa;
        b.v = t.build.V * t.r * 1.15; b.r = Math.max(2.5, g.Wd * t.r * 0.42); b.dmg = 0; b.c = -1;
        var hitD = Infinity;
        if (t.tc >= 0 && g.main) {
            var cell = S.cell[t.tc], lx = mx - t.tox, ly = my - t.toy;
            if (polyDist(cell.poly, cell.ori, lx, ly).inside) hitD = 0;
            else hitD = rayPoly(cell.poly, lx, ly, ca, sa);
            if (hitD < S.s * 3.2 && S.ST[t.tc] === SOLID) { b.kind = 0; b.c = t.tc; b.d = Math.max(1, hitD); b.dmg = t.build.D / t.build.nMain; t.rec[gk] = 1; S.stat.shots++; return; }
        }
        var stp = S.s * 0.15, d = 0;
        for (; d < S.s * 2.6; d += stp) if (hitSolid(S, mx + ca * d, my + sa * d, 0.5)) break;
        if (d < S.s * 2.6) { b.kind = 1; b.c = HIT.c; b.d = Math.max(1, d); }
        else { b.kind = 2; b.d = S.s * 2.6; }
        t.rec[gk] = 1; S.stat.shots++;
    }
    function volley(t) {
        var G = t.build.g;
        for (var k = 0; k < G.length; k++) if (G[k].delay >= 0) t.gq[k] = G[k].delay * t.build.R * 0.9;
        t.fire = t.build.R;
    }
    function simTank(S, t, dt) {
        var G = t.build.g, s = S.s;
        for (var k = 0; k < G.length; k++) {
            t.rec[k] = Math.max(0, t.rec[k] - dt * 7);
            if (t.gq[k] >= 0 && (t.gq[k] -= dt) < 0) { t.gq[k] = -1; fireGun(S, t, k); }
        }
        t.fire -= dt;
        t.gulp = Math.max(0, t.gulp - dt * 5);
        t.bankCD -= dt;
        while (t.wn - t.u < AHEAD) appendSeg(S, t);
        var i0 = Math.floor(t.u), fr = t.u - i0, mb = -1, LA = Math.ceil(s * 3 / S.ds);
        t.tc = -1;
        for (var m = 1; m <= LA; m += m < 16 ? 1 : 2) {
            var p = sampleAt(t, i0 + m);
            if (hitSolid(S, p.x, p.y, t.r * 1.02)) { mb = m; t.tc = HIT.c; t.tox = HIT.ox; t.toy = HIT.oy; break; }
        }
        var dStop = mb < 0 ? Infinity : Math.max(0, (mb - 2 - fr) * S.ds);
        t.dStop = dStop;
        var vmax = s * (S.small ? 1.05 : 1.25), cap = mb < 0 ? vmax : Math.sqrt(2 * s * 2.2 * Math.max(0, dStop - s * 0.02));
        t.v += (vmax - t.v) * (1 - Math.exp(-2.6 * dt));
        if (t.v > cap) t.v = cap;
        if (t.v < 0) t.v = 0;
        var du = t.v * dt / S.ds;
        if (mb >= 0) du = Math.min(du, Math.max(0, i0 + mb - 2 - t.u));
        t.u += du;
        var P = sampleAt(t, t.u);
        t.x = P.x; t.y = P.y;
        var ax, ay, aiming = t.tc >= 0 && dStop < s * 2.3;
        if (aiming) { var tc = S.cell[t.tc]; ax = tc.px + t.tox; ay = tc.py + t.toy; }
        else { var la = sampleAt(t, t.u + 16); ax = la.x; ay = la.y; }
        var want = Math.atan2(ay - t.y, ax - t.x), diff = want - t.ang;
        diff -= Math.round(diff / TAU) * TAU;
        var stepA = diff * (1 - Math.exp(-7 * dt)), mx = 3.4 * dt;
        t.ang += stepA > mx ? mx : stepA < -mx ? -mx : stepA;
        if (aiming && dStop < s * 2.1 && Math.abs(diff) < 0.12 && t.fire <= 0) volley(t);
        if (t.gems >= 6 && t.bankCD <= 0 && tdist(S, t.x, t.y, S.vault[0], S.vault[1]) < s * 2.2) bank(S, t);
    }
    function bank(S, t) {
        var n = Math.min(7, t.gems);
        for (var i = 0; i < n; i++) {
            var gm = spawnGem(S);
            if (!gm) break;
            gm.kind = 1; gm.x0 = gm.px = t.x; gm.y0 = gm.py = t.y; gm.t = -i * 0.08; gm.dur = 0.7; gm.tier = 1 + ((i + t.k) % 4); gm.rot = rnd() * TAU; gm.vr = (rnd() - 0.5) * 6; gm.r = S.s * 0.1; gm.tk = t.k;
        }
        S.stat.banks++;
        t.gems = 0; t.bankCD = 10;
    }
    function spawnGem(S) {
        for (var i = 0; i < S.gems.length; i++) if (!S.gems[i].on) { S.gems[i].on = 1; return S.gems[i]; }
        return null;
    }
    function spawnChip(S, x, y, vx, vy, col, life, sz) {
        var fs = S.chips;
        for (var i = 0; i < fs.length; i++) {
            var f = fs[i];
            if (f.on) continue;
            f.on = 1; f.x = x; f.y = y; f.vx = vx; f.vy = vy; f.rot = rnd() * TAU; f.vr = (rnd() - 0.5) * 9; f.t = 0; f.life = life; f.col = col; f.sz = sz;
            return;
        }
    }
    function chipsAt(S, cell, x, y, n, dx, dy) {
        var tn = S.light ? cell.tl : cell.td, cc = [tn[1], tn[3], tn[2]];
        for (var k = 0; k < n; k++) {
            var a = Math.atan2(-dy, -dx) + (rnd() - 0.5) * 2.2, v = 50 + rnd() * 80;
            spawnChip(S, x, y, Math.cos(a) * v, Math.sin(a) * v, cc[k % 3], 0.3 + rnd() * 0.25, S.s * (0.022 + rnd() * 0.026));
        }
    }
    function dmgOf(S, c, make) {
        var D = S.dmg, free = null;
        for (var i = 0; i < D.length; i++) { if (D[i].on && D[i].c === c) return D[i]; if (!D[i].on && !free) free = D[i]; }
        if (!make || !free) return null;
        free.on = 1; free.c = c; free.stage = 0; free.flash = 0; free.snap = 0;
        return free;
    }
    function hitCell(S, b) {
        var c = b.c;
        if (S.ST[c] !== SOLID) return;
        var cell = S.cell[c];
        S.HP[c] -= b.dmg;
        S.stat.hits++;
        var e = dmgOf(S, c, true);
        if (e) {
            e.flash = 1;
            var st = Math.min(5, Math.ceil((1 - Math.max(0, S.HP[c]) / S.HP0[c]) * 5));
            if (st > e.stage) { e.stage = st; e.snap = 1; }
        }
        chipsAt(S, cell, b.x + b.dx * b.d, b.y + b.dy * b.d, 2, b.dx, b.dy);
        if (S.HP[c] <= 0.001) breakCell(S, c, b.k, b.x + b.dx * b.d - cell.px, b.y + b.dy * b.d - cell.py);
    }
    function breakCell(S, c, tk, hx, hy) {
        var cell = S.cell[c], t = S.tanks[tk];
        var ox = Math.round(hx / S.P) * S.P, oy = Math.round(hy / S.Q) * S.Q;
        var e = dmgOf(S, c, false);
        if (e) e.on = 0;
        S.ST[c] = DUG; S.DUGAT[c] = S.t;
        S.stat.breaks++;
        burst(S, cell, ox, oy);
        if (cell.ore && cell.dep) {
            for (var i = 0; i < cell.dep.length; i++) gemFrom(S, cell, cell.dep[i].x + ox, cell.dep[i].y + oy, cell.ore, cell.dep[i].r, t, i);
        } else if (hash(cell.ii, cell.jj, S.stat.breaks) < 0.6) gemFrom(S, cell, cell.px + ox, cell.py + oy, 1, S.s * 0.1, t, 0);
        repaint(S, c);
    }
    function gemFrom(S, cell, x, y, tier, r, t, i) {
        var gm = spawnGem(S);
        if (!gm) return;
        var dx = x - cell.cx, dy = y - cell.cy, dl = Math.hypot(dx, dy) || 1, a = Math.atan2(dy, dx) + (rnd() - 0.5) * 0.8, pd = S.s * (0.35 + rnd() * 0.25);
        if (dl < 2) a = rnd() * TAU;
        gm.kind = 0; gm.x0 = x; gm.y0 = y; gm.px = x + Math.cos(a) * pd; gm.py = y + Math.sin(a) * pd; gm.t = -i * 0.06; gm.dur = 0.8 + rnd() * 0.2;
        gm.tier = tier; gm.rot = rnd() * TAU; gm.vr = (rnd() - 0.5) * 7; gm.r = Math.max(S.s * 0.09, Math.min(r, S.s * 0.16)); gm.tk = t ? t.k : 0;
    }
    function burst(S, cell, ox, oy) {
        var bs = S.bursts, b = null, old = 0;
        for (var i = 0; i < bs.length; i++) { if (!bs[i].on) { b = bs[i]; break; } if (bs[i].t > bs[old].t) old = i; }
        if (!b) b = bs[old];
        var Pp = b.parts;
        for (var e = 0; e < 46; e++) {
            var o = e * 8;
            Pp[o] = rnd() * TAU; Pp[o + 1] = 0.7 + rnd() * 3.6; Pp[o + 2] = 0.018 + rnd() * 0.04; Pp[o + 3] = (rnd() * 3) | 0;
            Pp[o + 4] = (rnd() - 0.5) * 14; Pp[o + 5] = 0.5 + rnd() * 0.5; Pp[o + 6] = (rnd() - 0.5) * 1.1; Pp[o + 7] = (rnd() - 0.5) * 1.1;
        }
        var tn = S.light ? cell.tl : cell.td;
        b.pal = ORE_FX_CSS[cell.ore] || [tn[3], tn[4], tn[2]];
        b.nS = cell.ore ? (cell.ore >= 3 ? 38 : 32) : 24;
        for (var q = 0; q < b.nS; q++) { b.sparks[q * 3] = rnd() * TAU; b.sparks[q * 3 + 1] = 1.2 + rnd() * 3.4; b.sparks[q * 3 + 2] = (rnd() * b.pal.length) | 0; }
        b.on = 1; b.t = 0; b.c = cell.c; b.x = cell.px + ox; b.y = cell.py + oy;
        b.cc = [tn[1], tn[2], tn[3]];
    }
    function regrow(S) {
        var s = S.s, n = S.cols * S.rows, many = 0, best = -1, bt = Infinity;
        for (var c0 = 0; c0 < n; c0++) if (S.ST[c0] === DUG) many++;
        var age = many > n * 0.12 ? 16 : 34;
        for (var c = 0; c < n; c++) {
            if (S.ST[c] !== DUG || S.t - S.DUGAT[c] < age || S.DUGAT[c] >= bt) continue;
            var cell = S.cell[c], sx = scrX(S, cell.sx), sy = scrY(S, cell.sy);
            if (sx > -s * 1.6 && sx < S.W + s * 1.6 && sy > -s * 1.6 && sy < S.H + s * 1.6) continue;
            var ok = true;
            for (var k = 0; k < S.tanks.length && ok; k++) {
                var t = S.tanks[k];
                if (tdist(S, cell.sx, cell.sy, t.x, t.y) < s * 3) { ok = false; break; }
                for (var m = 0; m < AHEAD - 4 && ok; m += 6) { var p = sampleAt(t, t.u + m); if (tdist(S, cell.sx, cell.sy, p.x, p.y) < s * 1.4) ok = false; }
            }
            if (ok) { best = c; bt = S.DUGAT[c]; }
        }
        if (best < 0) return;
        var ce = S.cell[best];
        setOre(S, ce, rnd() < 0.12 ? pickOdds(ORE_ODDS) : 0);
        S.ST[best] = SOLID; S.HP0[best] = S.HP[best] = hpOf(ce);
        S.stat.regrows++;
        repaint(S, best);
    }
    function simulate(S, dt) {
        S.t += dt;
        for (var k = 0; k < S.tanks.length; k++) simTank(S, S.tanks[k], dt);
        var bs = S.bullets;
        for (var b = 0; b < bs.length; b++) {
            var bu = bs[b];
            if (!bu.on) continue;
            bu.tr += bu.v * dt;
            if (bu.tr < bu.d) continue;
            bu.on = 0;
            if (bu.kind === 0) hitCell(S, bu);
            else if (bu.kind === 1 && bu.c >= 0) chipsAt(S, S.cell[bu.c], bu.x + bu.dx * bu.d, bu.y + bu.dy * bu.d, 1, bu.dx, bu.dy);
        }
        var fs = S.chips, drag = Math.exp(-3.2 * dt);
        for (var f = 0; f < fs.length; f++) {
            var fr = fs[f];
            if (!fr.on) continue;
            fr.t += dt;
            if (fr.t >= fr.life) { fr.on = 0; continue; }
            fr.vx *= drag; fr.vy *= drag;
            fr.x += fr.vx * dt; fr.y += fr.vy * dt; fr.rot += fr.vr * dt;
        }
        var bz = S.bursts;
        for (var z = 0; z < bz.length; z++) if (bz[z].on && (bz[z].t += dt / 0.62) >= 1) bz[z].on = 0;
        var gs = S.gems;
        for (var g = 0; g < gs.length; g++) {
            var gm = gs[g];
            if (!gm.on) continue;
            gm.t += dt; gm.rot += gm.vr * dt;
            if (gm.t >= gm.dur) {
                gm.on = 0;
                if (gm.kind === 0) { var tk = S.tanks[gm.tk]; if (tk) { tk.gems++; tk.gulp = 1; } S.stat.gems++; }
                else S.vaultPulse = 1;
            }
        }
        var D = S.dmg;
        for (var d = 0; d < D.length; d++) {
            var e = D[d];
            if (!e.on) continue;
            e.flash = Math.max(0, e.flash - dt / 0.15);
            e.snap = Math.max(0, e.snap - dt / 0.22);
            if (S.ST[e.c] !== SOLID) e.on = 0;
        }
        S.vaultPulse = Math.max(0, S.vaultPulse - dt * 2.5);
        if (S.t > S.regrowAt) { S.regrowAt = S.t + 0.5; regrow(S); }
    }
    function moveCam(S, dt) {
        S.camT += dt;
        var h = S.camA + 0.42 * Math.sin(S.camT / 34);
        S.camX += Math.cos(h) * S.camV * dt;
        S.camY += Math.sin(h) * S.camV * 0.8 * dt;
    }
    function scrX(S, x) { var v = fmod(x - S.vx, S.P); return v > S.W + (S.P - S.W) / 2 ? v - S.P : v; }
    function scrY(S, y) { var v = fmod(y - S.vy, S.Q); return v > S.H + (S.Q - S.H) / 2 ? v - S.Q : v; }

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
    function drawGem(c, x, y, r, rot, tier) {
        var o = ORE_PAL[tier] || ORE_PAL[1];
        gemPath(c, x, y, r, rot, 1, 0, 0);
        c.fillStyle = o[1]; c.fill();
        c.lineWidth = Math.max(1.2, r * 0.2); c.strokeStyle = o[0]; c.stroke();
        gemPath(c, x, y, r, rot, 0.52, 0, -r * 0.12); c.fillStyle = o[2]; c.fill();
        gemPath(c, x, y, r, rot, 0.2, -r * 0.22, -r * 0.3); c.fillStyle = o[3]; c.fill();
    }
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
    var GUN_LINE = mixHex(GUN, BORDER, BORDER_K);
    function drawTank(c, x, y, t) {
        var r = t.r * (1 + 0.06 * t.gulp), G = t.build.g;
        c.lineJoin = 'round';
        c.lineWidth = Math.max(2.5, t.r * 0.17);
        c.fillStyle = GUN; c.strokeStyle = GUN_LINE;
        for (var k = 0; k < G.length; k++) { gunPath(c, x, y, t.ang, G[k], t.r, t.rec[k]); c.fill(); c.stroke(); }
        c.beginPath(); c.arc(x, y, r, 0, TAU);
        c.fillStyle = t.col; c.fill(); c.strokeStyle = t.line; c.stroke();
    }
    function drawBurst(c, S, b, x, y, A) {
        var t = b.t, u = S.s * 0.8, cell = S.cell[b.c];
        var eo = 1 - Math.pow(1 - t, 4), fade = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
        if (t < 0.12) {
            c.save();
            c.translate(x - cell.px, y - cell.py);
            c.globalAlpha = A * (1 - t / 0.12) * 0.9;
            c.fillStyle = 'rgb(240,232,250)';
            c.fill(cell.path);
            c.restore();
        }
        c.strokeStyle = S.light ? FLOOR.light.ring : FLOOR.dark.ring;
        for (var rg = 0; rg < 2; rg++) {
            var rt = rg === 0 ? t : (t - 0.07) / 0.93;
            if (rt <= 0 || rt >= 1) continue;
            var rq = 1 - Math.pow(1 - rt, 4);
            c.globalAlpha = A * Math.pow(1 - rt, 1.5) * 0.6;
            c.beginPath(); c.arc(x, y, (0.25 + (rg ? 1.9 : 3.0) * rq) * u, 0, TAU);
            c.lineWidth = 0.12 * u * (1 - rt) + 0.5;
            c.stroke();
        }
        var pal = b.pal, Sp = b.sparks;
        c.lineCap = 'round';
        c.lineWidth = Math.max(1, 0.028 * u * (1 - t * 0.5));
        c.globalAlpha = A * fade * 0.9;
        for (var ci = 0; ci < pal.length; ci++) {
            var any = false;
            for (var e = 0; e < b.nS; e++) {
                if (Sp[e * 3 + 2] !== ci) continue;
                if (!any) { any = true; c.beginPath(); }
                var r2 = eo * Sp[e * 3 + 1] * u, r1 = r2 * 0.6, ca = Math.cos(Sp[e * 3]), sa = Math.sin(Sp[e * 3]);
                c.moveTo(x + ca * r1, y + sa * r1); c.lineTo(x + ca * r2, y + sa * r2);
            }
            if (any) { c.strokeStyle = pal[ci]; c.stroke(); }
        }
        c.globalAlpha = A * fade;
        var Pp = b.parts, shrink = 1 - t * 0.6;
        for (var sh = 0; sh < 3; sh++) {
            c.beginPath();
            for (var k = 0; k < 46; k++) {
                var o = k * 8;
                if (Pp[o + 3] !== sh) continue;
                var ang = Pp[o], dist = eo * Pp[o + 1] * u;
                var px = x + Pp[o + 6] * u * 0.3 + Math.cos(ang) * dist, py = y + Pp[o + 7] * u * 0.3 + Math.sin(ang) * dist;
                var hw = Pp[o + 2] * u * shrink * 2.2, hh = hw * Pp[o + 5];
                var rr = ang + Pp[o + 4] * eo, cr = Math.cos(rr), sr = Math.sin(rr);
                var ax = cr * hw, ay = sr * hw, bx = -sr * hh, by = cr * hh;
                c.moveTo(px - ax - bx, py - ay - by); c.lineTo(px + ax - bx, py + ay - by);
                c.lineTo(px + ax + bx, py + ay + by); c.lineTo(px - ax + bx, py - ay + by);
                c.closePath();
            }
            c.fillStyle = b.cc[sh]; c.fill();
        }
        c.lineCap = 'butt';
        c.globalAlpha = A;
    }
    function drawDamage(c, S, A, D) {
        var dm = S.dmg, s = S.s;
        for (var i = 0; i < dm.length; i++) {
            var e = dm[i];
            if (!e.on) continue;
            var cell = S.cell[e.c], tx = scrX(S, cell.sx) - cell.sx, ty = scrY(S, cell.sy) - cell.sy;
            if (cell.x1 + tx < -s || cell.x0 + tx > S.W + s || cell.y1 + ty < -s || cell.y0 + ty > S.H + s) continue;
            c.setTransform(D, 0, 0, D, tx * D, ty * D);
            c.save();
            c.clip(cell.path);
            var ck = crackPal(cell), st = e.stage;
            if (st >= 1) { c.globalAlpha = A * (0.04 * st + 0.12 * Math.pow(st / 5, 2)); c.fillStyle = ck.fill; c.fill(cell.path); c.globalAlpha = A; }
            if (st >= 1) {
                var path = crackPath(S, cell, st), w = 0.035 * s * (0.28 + 0.075 * st) * 1.9 * (1 + e.snap);
                c.lineJoin = 'miter'; c.lineCap = 'butt'; c.miterLimit = 3;
                c.strokeStyle = ck.base; c.lineWidth = w * 1.25; c.stroke(path);
                c.strokeStyle = ck.hot; c.lineWidth = w * 0.5; c.stroke(path);
                c.translate(0, w * 0.85);
                c.strokeStyle = ck.hairCss[st]; c.lineWidth = w * 0.32; c.stroke(path);
                c.translate(0, -w * 0.85);
            }
            if (e.flash > 0) { c.globalAlpha = A * 0.3 * e.flash; c.fillStyle = '#fff4e6'; c.fill(cell.path); c.globalAlpha = A; }
            c.restore();
        }
        c.setTransform(D, 0, 0, D, 0, 0);
        c.lineJoin = 'round';
    }

    function draw(c, now, still, alpha) {
        var S = world;
        if (!S || !S.cache) return;
        var f0 = performance.now();
        var dt = 0;
        if (!still && lastT) dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
        lastT = now;
        if (dt > 0) { moveCam(S, dt); simulate(S, dt); }
        var A = alpha == null ? 1 : alpha;
        var cw = c.canvas.width, ch = c.canvas.height, D = cw / S.W;
        if (!(D > 0)) D = 1;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = 'source-over';
        c.globalAlpha = A;
        c.imageSmoothingEnabled = true;
        var C = S.cache, k = S.cacheK, Pd = C.Pd, Qd = C.Qd, TL = C.tl, ti, tl, X, Y;
        var ox = fmod(S.camX, S.P), oy = fmod(S.camY, S.Q), xx, yy;
        var sc = D / k, pw = S.P * D, qh = S.Q * D;
        S.vx = ox; S.vy = oy;
        for (yy = -oy * D; yy < ch; yy += qh) for (xx = -ox * D; xx < cw; xx += pw) for (ti = 0; ti < TL.length; ti++) {
            tl = TL[ti]; X = xx + tl.X * sc; Y = yy + tl.Y * sc;
            var W2 = tl.w * sc + 0.5, H2 = tl.h * sc + 0.5;
            if (X + W2 <= 0 || X >= cw || Y + H2 <= 0 || Y >= ch) continue;
            c.drawImage(tl.cv, X, Y, W2, H2);
        }
        c.setTransform(D, 0, 0, D, 0, 0);
        var s = S.s, M = s * 1.6, i, x, y;
        var V = S.vs;
        if (V) {
            x = scrX(S, S.vault[0]); y = scrY(S, S.vault[1]);
            if (x > -V.Sw && x < S.W + V.Sw && y > -V.Sw && y < S.H + V.Sw) {
                var h = V.Sw / 2;
                c.lineJoin = 'round';
                polyPath(c, x, y, h * 1.22, 8, Math.PI / 8);
                c.fillStyle = V.padFill; c.fill();
                c.lineWidth = V.lw * 1.6; c.strokeStyle = V.padLine; c.stroke();
                polyPath(c, x, y, h * 1.11, 8, Math.PI / 8);
                c.lineWidth = Math.max(2, h * 0.065); c.strokeStyle = VAULT_TEAM; c.stroke();
                c.drawImage(V.plate, x - h, y - h, V.Sw, V.Sw);
                var ra = S.t * 0.25, ca = Math.cos(ra) * D, sa = Math.sin(ra) * D;
                c.setTransform(ca, sa, -sa, ca, x * D, y * D);
                c.drawImage(V.cog, -h, -h, V.Sw, V.Sw);
                c.setTransform(D, 0, 0, D, 0, 0);
                c.drawImage(V.wheel, x - h, y - h, V.Sw, V.Sw);
                if (S.vaultPulse > 0) {
                    c.globalAlpha = A * S.vaultPulse * 0.7;
                    c.lineWidth = 3; c.strokeStyle = '#ffd36b';
                    c.beginPath(); c.arc(x, y, S.vaultR * (1 + (1 - S.vaultPulse) * 0.35), 0, TAU); c.stroke();
                    c.globalAlpha = A;
                }
            }
        }
        drawDamage(c, S, A, D);
        var bz = S.bursts;
        for (i = 0; i < bz.length; i++) {
            var b0 = bz[i];
            if (!b0.on) continue;
            x = scrX(S, b0.x); y = scrY(S, b0.y);
            if (x < -s * 3.5 || x > S.W + s * 3.5 || y < -s * 3.5 || y > S.H + s * 3.5) continue;
            drawBurst(c, S, b0, x, y, A);
        }
        var fs = S.chips;
        for (i = 0; i < fs.length; i++) {
            var fr = fs[i];
            if (!fr.on) continue;
            x = scrX(S, fr.x); y = scrY(S, fr.y);
            if (x < -M || x > S.W + M || y < -M || y > S.H + M) continue;
            var uu = fr.t / fr.life, cs = Math.cos(fr.rot), sn = Math.sin(fr.rot), zz = fr.sz;
            c.globalAlpha = A * (uu < 0.6 ? 1 : 1 - (uu - 0.6) / 0.4);
            c.fillStyle = fr.col;
            c.beginPath();
            c.moveTo(x + cs * zz, y + sn * zz); c.lineTo(x - sn * zz * 0.6, y + cs * zz * 0.6); c.lineTo(x - cs * zz, y - sn * zz); c.lineTo(x + sn * zz * 0.6, y - cs * zz * 0.6);
            c.closePath(); c.fill();
        }
        c.globalAlpha = A;
        var bs = S.bullets;
        c.lineWidth = Math.max(1.5, s * 0.03);
        for (i = 0; i < bs.length; i++) {
            var bu = bs[i];
            if (!bu.on) continue;
            x = scrX(S, bu.x + bu.dx * bu.tr); y = scrY(S, bu.y + bu.dy * bu.tr);
            if (x < -M || x > S.W + M || y < -M || y > S.H + M) continue;
            var tb = S.tanks[bu.k];
            if (bu.kind === 2) c.globalAlpha = A * Math.max(0, 1 - bu.tr / bu.d);
            c.beginPath(); c.arc(x, y, bu.r, 0, TAU);
            c.fillStyle = tb.col; c.fill(); c.strokeStyle = tb.line; c.stroke();
            c.globalAlpha = A;
        }
        var T = S.tanks;
        for (i = 0; i < T.length; i++) {
            var tk = T[i];
            x = scrX(S, tk.x); y = scrY(S, tk.y);
            if (x < -M || x > S.W + M || y < -M || y > S.H + M) continue;
            drawTank(c, x, y, tk);
        }
        var gs = S.gems;
        c.lineJoin = 'round';
        for (i = 0; i < gs.length; i++) {
            var gm = gs[i];
            if (!gm.on || gm.t < 0) continue;
            var u = gm.t / gm.dur, gx, gy, sz = gm.r;
            if (u < 0.22) {
                var e1 = 1 - (1 - u / 0.22) * (1 - u / 0.22);
                gx = gm.x0 + (gm.px - gm.x0) * e1; gy = gm.y0 + (gm.py - gm.y0) * e1;
                sz *= 0.7 + 0.3 * e1;
            } else {
                var e2 = (u - 0.22) / 0.78, ee = e2 * e2 * (3 - 2 * e2), tx2, ty2;
                if (gm.kind === 0) { var to = T[gm.tk]; tx2 = gm.px + wdx(S, to.x, gm.px); ty2 = gm.py + wdy(S, to.y, gm.py); }
                else { tx2 = gm.px + wdx(S, S.vault[0], gm.px); ty2 = gm.py + wdy(S, S.vault[1], gm.py); }
                var ddx = tx2 - gm.px, ddy = ty2 - gm.py, dl = Math.hypot(ddx, ddy) || 1, arc = Math.sin(ee * Math.PI) * Math.min(dl * 0.3, s * 0.5);
                gx = gm.px + ddx * ee - ddy / dl * arc; gy = gm.py + ddy * ee + ddx / dl * arc;
                if (e2 > 0.7) sz *= 1 - (e2 - 0.7) / 0.3 * 0.65;
            }
            x = scrX(S, gx); y = scrY(S, gy);
            if (x < -M || x > S.W + M || y < -M || y > S.H + M) continue;
            drawGem(c, x, y, sz, gm.rot, gm.tier);
        }
        c.globalAlpha = 1;
        var FT = S.ft || (S.ft = { buf: new Float32Array(120), n: 0 });
        FT.buf[FT.n % 120] = performance.now() - f0;
        FT.n++;
    }

    function release() {
        if (bake) dropBake(bake);
        var S = world;
        if (S) {
            if (S.cacheB) dropBake(S.cacheB);
            if (S.vs) { S.vs.plate.width = 0; S.vs.cog.width = 0; S.vs.wheel.width = 0; }
            S.cache = null; S.cacheB = null; S.vs = null;
        }
        world = null; bake = null; lastT = 0;
    }
    function frameStat(S) {
        var FT = S.ft;
        if (!FT || !FT.n) return null;
        var n = Math.min(FT.n, 120), a = Array.prototype.slice.call(FT.buf, 0, n).sort(function (x, y) { return x - y; }), sum = 0;
        for (var i = 0; i < n; i++) sum += a[i];
        return { avg: Math.round(sum / n * 100) / 100, p95: Math.round(a[Math.min(n - 1, Math.floor(n * 0.95))] * 100) / 100, max: Math.round(a[n - 1] * 100) / 100, n: FT.n };
    }
    function stat() {
        var S = world;
        if (!S) return null;
        var on = function (a) { var n = 0; for (var i = 0; i < a.length; i++) n += a[i].on; return n; };
        var dug = 0, solid = 0, ore = 0;
        for (var c = 0; c < S.ST.length; c++) { if (S.ST[c] === SOLID) { solid++; if (S.cell[c].ore) ore++; } else dug++; }
        return { t: Math.round(S.t * 10) / 10, cam: [Math.round(S.camX * 100) / 100, Math.round(S.camY * 100) / 100], s: S.s, cols: S.cols, rows: S.rows, P: S.P, Q: S.Q, k: S.cacheK, light: S.light, frame: frameStat(S),
            dug: dug, solid: solid, ore: ore, bullets: on(S.bullets), chips: on(S.chips), bursts: on(S.bursts), gemsFlying: on(S.gems), damaged: on(S.dmg),
            breaks: S.stat.breaks, gems: S.stat.gems, banks: S.stat.banks, shots: S.stat.shots, hits: S.stat.hits, regrows: S.stat.regrows,
            tanks: S.tanks.map(function (t) { return { sx: Math.round(scrX(S, t.x)), sy: Math.round(scrY(S, t.y)), b: t.build.n, x: Math.round(t.x * 100) / 100, y: Math.round(t.y * 100) / 100, v: Math.round(t.v), ang: Math.round(t.ang * 1000) / 1000, gems: t.gems, tgt: t.tc, stop: t.dStop === Infinity ? -1 : Math.round(t.dStop) }; }) };
    }
    function check() {
        var S = world;
        if (!S) return null;
        var worst = 0, gemOut = 0, why = '';
        for (var k = 0; k < S.tanks.length; k++) {
            var t = S.tanks[k], i0 = Math.floor(t.x / S.s), j0 = Math.floor(t.y / S.s);
            for (var dj = -2; dj <= 2; dj++) for (var di = -2; di <= 2; di++) {
                var i = i0 + di, j = j0 + dj, ii = wrap(i, S.cols), jj = wrap(j, S.rows), c = jj * S.cols + ii;
                if (S.ST[c] !== SOLID) continue;
                var cell = S.cell[c], q = polyDist(cell.poly, cell.ori, t.x - (i - ii) * S.s, t.y - (j - jj) * S.s);
                var pen = q.inside ? q.d + t.r : t.r - q.d;
                if (pen > worst) { worst = pen; why = t.build.n + ' c' + c; }
            }
        }
        for (var c2 = 0; c2 < S.cell.length; c2++) {
            var ce = S.cell[c2];
            if (!ce.ore || !ce.dep) continue;
            for (var d = 0; d < ce.dep.length; d++) { var q2 = polyDist(ce.poly, ce.ori, ce.dep[d].x, ce.dep[d].y); if (!q2.inside || q2.d < ce.dep[d].r * 0.9) gemOut++; }
        }
        return { penPx: Math.round(worst * 10) / 10, gemOut: gemOut, why: worst > 3 ? why : '' };
    }

    window.dwHomeWorld = { build: build, step: step, draw: draw, release: release, stat: stat, check: check, builds: BUILDS.map(function (b) { return b.n; }), ready: function () { return !!(world && world.cache) && world.W > 0; } };
})();
