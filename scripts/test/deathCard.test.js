// Raid death card text block + menu background: node scripts/test/deathCard.test.js
//
//   death card   the Points line, the extras (streak over, savings lost...)
//                and the perks row sat crammed under the stat tiles and got
//                cut with "..." (owner, Oct 5 2026). deathCardLogic lays them
//                out: room under the tiles, lines wrap and are never cut, the
//                card grows with them, and a card taller than the screen is
//                drawn scaled down so the buttons below stay clear
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const CLIENT = path.join(REPO, 'public', 'client');
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');
const imp = (f) => import(pathToFileURL(path.join(CLIENT, f)).href);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ~0.55 em a letter in bold Rubik
const measure = (t, s) => String(t).length * s * 0.55;
const EX = ["Your insurance saved 640 of it", "Your 18 kill streak is over", "Your drill dropped a tier",
    "Dying cost 1,166 of your savings. This raid's banked gems are safe"];
const PTS = "Points: 31,328 (lost 1,500: xX_kai_the_destroyer_Xx took your crown)";

test('death card: nothing is cut, every line fits the column', async () => {
    const D = await imp('deathCardLogic.js');
    for (const w of [490, 436, 300, 200]) {
        const b = D.layoutText({ pts: PTS, extras: EX, perkLine: "Your perks stay until the raid ends.", perkIcons: 9, w, measure });
        const words = b.rows.filter(r => r.text).map(r => r.text).join(' ');
        assert.ok(!/…/.test(words), 'no ellipsis at ' + w);
        for (const r of b.rows) if (r.text) assert.ok(measure(r.text, r.size) + (r.iconsW || 0) <= w + 0.01, `"${r.text}" fits ${w}`);
        for (const e of EX) for (const word of e.split(' ')) assert.ok(words.includes(word), word + ' kept at ' + w);
        assert.ok(b.rows.every(r => r.kind === 'icons' || r.size >= 11), 'readable sizes at ' + w);
    }
});

test('death card: room under the tiles, rows never overlap, the block grows', async () => {
    const D = await imp('deathCardLogic.js');
    const one = D.layoutText({ pts: "Points: 900 (lost 0: banked gems are safe)", extras: [], sub: "", perkLine: "", w: 490, measure });
    const many = D.layoutText({ pts: PTS, extras: EX, perkLine: "Your perks stay until the raid ends.", perkIcons: 9, w: 300, measure });
    assert.ok(many.h > one.h + 60, 'more lines, taller block');
    const first = many.rows[0];
    assert.ok(first.y - first.size / 2 >= 12, 'clear of the tiles');
    for (let i = 1; i < many.rows.length; i++) {
        const a = many.rows[i - 1], b = many.rows[i];
        const ha = a.kind === 'icons' ? 16 : a.size, hb = b.kind === 'icons' ? 16 : b.size;
        assert.ok(b.y - hb / 2 >= a.y + ha / 2 - 0.01, 'row ' + i + ' under row ' + (i - 1));
    }
    const last = many.rows[many.rows.length - 1];
    assert.ok(many.h - (last.y + 8) >= 6, 'room above the next thing');
    // a narrow card puts the perk icons on a row of their own
    assert.ok(many.rows.some(r => r.kind === 'icons') || many.rows.some(r => r.kind === 'perk' && r.iconsW));
});

test('death card: app.js sizes the card from the block and fits it on screen', () => {
    const app = src('app.js');
    const a = app.indexOf('const gameDrawDeadRoyale = () => {'), b = app.indexOf('function playAgainState()');
    const card = app.slice(a, b);
    assert.match(app, /import \* as deathText from '\.\/deathCardLogic\.js';/);
    assert.match(card, /const leftH = tilesH \+ block\.h;/);
    assert.match(card, /k = Math\.max\(0\.62, k \* room \/ need\);/);
    assert.match(card, /if \(k !== 1\) \{ c\.save\(\); c\.scale\(k, k\); \}/);
    assert.match(card, /if \(k !== 1\) c\.restore\(\);\n    \};/);
    assert.ok(!/fitLine\(ex/.test(card) && !/drawDeathPerkLine\(c, perkLine, hx/.test(card), 'the old one-line fit is gone');
    // the camera lift is in real GUI units
    assert.match(card, /global\.deathCamLift = Math\.max\(0, sh \/ 2 - Math\.max\(110, py \/ 2 \+ 10\)\) \* k;/);
});

test('home: a live mining world behind the menu in the in-game rock art, capped and paused, still under reduced motion', () => {
    const html = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(REPO, 'public', 'home.css'), 'utf8');
    assert.ok(html.indexOf('/shared/rockBiomes.js') < html.indexOf('./client/homeWorld.js'), 'biomes first');
    assert.ok(html.indexOf('./client/homeWorld.js') < html.indexOf('./client/home.js'));
    assert.match(html, /<div id="homeBackdrop" aria-hidden="true">\s*<canvas id="homeWorldCanvas"/);
    assert.ok(!/<ol class="hero-loop"/.test(html), 'the Mine > Bank > Win strip is gone');
    const hw = src('homeWorld.js');
    for (const fn of ['simulate', 'simTank', 'hitCell', 'breakCell', 'regrow', 'bank', 'repaint']) assert.match(hw, new RegExp('function ' + fn + '\\('), fn);
    assert.match(hw, /g\.fillStyle = SIDE_INK; g\.fill\(solid\);/, 'raised side face');
    assert.match(hw, /g\.lineWidth = outlineW; g\.strokeStyle = OUTLINE_INK; g\.stroke\(open\);/, 'bold silhouette outline');
    assert.match(hw, /var CRACK = \{ base: 'rgba\(0,0,0,0\.55\)'/, 'the game dark cracks');
    assert.match(hw, /polyPath\(c, x, y, h \* 1\.22, 8, Math\.PI \/ 8\);/, 'the in-game octagon vault');
    assert.match(hw, /S\.cacheL !== S\.light/, 'a theme switch rebakes');
    assert.match(hw, /var TEAM = \['#00b2e1', '#f14e54'/, 'diep player colours');
    assert.match(hw, /frame: frameStat\(S\)/, 'per frame cost is measured');
    assert.ok(!/requestAnimationFrame/.test(hw), 'home.js owns the loop');
    assert.match(css, /#homeBackdrop::after \{[^}]*radial-gradient/, 'a static calm patch behind the menu');
    assert.match(css, /html\[data-theme\] #dwJoin:not\(\.see\) \{\n    background-image: var\(--home-gems\)/, 'the connecting screen keeps the CSS floor');
    const home = src('home.js');
    assert.match(home, /if \(!reduceMotion && now - homeFxLast < 32\) return;/, 'capped near 30 fps');
    assert.match(home, /world\.build\(W, H, cheap \? 0\.5 : dpr, root\.getAttribute\('data-theme'\) === 'light'\)/);
    assert.match(home, /done = world\.step\(8\);/, 'baked in idle slices');
    assert.match(home, /if \(world\) \{ world\.release\(\); worldIn = 0; \}/, 'let go while a game runs');
    assert.match(home, /window\.dwHomeWorld = window\.dwHomeWorld \|\| \{/);
    assert.match(src('app.js'), /if \(!global\.mobile && !window\.dwHomeWorld\) \{/);
    const b = fs.readFileSync(path.join(REPO, 'scripts', 'build-client.js'), 'utf8');
    assert.match(b, /"client\/homeWorld\.js",/);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + ((e && e.stack) || e).toString().split('\n').slice(0, 8).join('\n     ')); }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
