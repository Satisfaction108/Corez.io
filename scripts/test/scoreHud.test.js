// Bottom score HUD: node scripts/test/scoreHud.test.js
//
//   Points   your score as a share of the #1 leaderboard score
//   Carried  your satchel against its cap
//   kill bar its own bright row, clear of the wallet and ability chips
//   banked   the spendable total, over the HP / shield bars by the minimap
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(REPO, 'public', 'client', 'app.js'), 'utf8');

(async () => {
    const SL = await import(pathToFileURL(path.join(REPO, 'public', 'client', 'scoreLogic.js')).href);

    assert.equal(SL.pointsFrac(5000, 10000), 0.5);
    assert.equal(SL.pointsFrac(20000, 10000), 1, 'leads the board: full');
    assert.equal(SL.pointsFrac(0, 10000), 0);
    assert.equal(SL.pointsFrac(-5, 10000), 0);
    assert.equal(SL.pointsFrac(500, 0), 1, 'no board yet: your score is the top');
    assert.equal(SL.carriedFrac(4000, 8000), 0.5);
    assert.equal(SL.carriedFrac(12000, 8000), 1);
    assert.equal(SL.carriedFrac(10, 0), 0);
    assert.equal(SL.carriedFrac(0, 8000), 0);

    const self = app.slice(app.indexOf('function drawSelfInfo('), app.indexOf('// Bank pops (bankPopLogic.js)'));
    assert.ok(self.length > 2000);
    assert.match(self, /const pointsFill = scoreText\.pointsFrac\(totalPts, topBoardScore \|\| max \|\| 0\);/);
    assert.match(self, /const carryFill = scoreText\.carriedFrac\(carried, g\.cap\);/);
    assert.match(self, /hudBar\(ctx\[2\], walletX, pillTop, barW, pillH, pointsFill, HUD\.gold\);/);
    assert.match(self, /hudBar\(ctx\[2\], walletX \+ barW \+ gap, pillTop, barW, pillH, carryFill, /);
    assert.match(self, /const pTxt = "Points " \+ util\.formatLargeNumber\(totalPts\);/);
    assert.match(self, /const cTxt = "Carried " \+ util\.formatLargeNumber\(carried\) \+ " \/ " \+ util\.formatLargeNumber\(g\.cap \| 0\);/);
    assert.ok(!/Score:.*carried\)/.test(self), 'the old combined score pill is gone');

    // kill bar: own row under the wallet in a raid (and the score row moves
    // above it outside one), bright amber rather than a black/grey well
    assert.match(self, /if \(raid\) killY = walletY \+ height \+ kbGap;\s*else \{ walletY -= kbH \+ kbGap; killY = y; \}/);
    assert.match(self, /if \(kbOn && kbW >= 180\) drawKillbar\(\(global\.screenWidth - kbW\) \/ 2, killY, kbW, kbH\);/);
    assert.match(app, /function drawKillbar\(x, y, w, h\) \{\s*const kills = gui\.__s\.getKills\(\);\s*hudBar\(ctx\[2\], x, y, w, h, Math\.min\(1, \(kills\[0\] \| 0\)\), "#ffe08a", "#c98a1c"\);/);

    // banked label is part of the vitals keep-out, directly over HP/shield
    const vit = app.slice(app.indexOf('function drawVitals() {'), app.indexOf('function vitalLabel('));
    assert.match(vit, /const bankTxt = "Banked " \+ fmtNum\(banked\), bankH = 14;/);
    assert.match(vit, /const bankY = y0 - bankH - 2;/);
    assert.match(vit, /hudTitle\(bankTxt, x \+ w \/ 2, bankY \+ bankH \/ 2, bs, HUD\.gold, "center", 1, c\);/);
    assert.match(vit, /vitalsRect = \{ x: x - 4, y: bankY - 4, w: w \+ 8, h: \(y0 - bankY\) \+ total \+ 8 \};/);

    console.log('all passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
