// HUD round 8: node scripts/test/hud8.test.js
//
//   intro card    "DIG. BANK. WIN." stays up ~65% longer; Esc lets it go
//   the flash     the raid's OVERRIDE popup came out during the sky drop and
//                 vanished the moment the raid card took over ("a popup from
//                 the top that lasts a millisecond"): plates now wait from
//                 the join until the card has played; the storm banner never
//                 flashes before your tank has landed
//   perk cards    bigger (full description), level as a roman badge (never
//                 "Overclock2"), hover says it all, the row lifts over a HUD
//                 piece that grazes it instead of shrinking
//   perk strip    at most 2 rows; then icon + level chips; then "+N"
//   bank pops     centred on the screen like the name above them
//   chest labels  "Copper chest" / "Epic chest" / "Supply crate"
//   distances     "570m", "2.1km" everywhere (server texts too)
//   HP / shield   two bars over the minimap with exact numbers
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const CLIENT = path.join(REPO, 'public', 'client');
const SERVER = path.join(REPO, 'server');
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');
const ssrc = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');
const imp = (f) => import(pathToFileURL(path.join(CLIENT, f)).href);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('intro card: about 65% longer, Esc lets it go', async () => {
    const L = await imp('firstSecondsLogic.js');
    const n = L.planFor({ newcomer: true }), v = L.planFor({ newcomer: false }), r = L.planFor({ newRaid: true });
    assert.ok(n.intro >= 3400 * 1.6 && n.intro <= 3400 * 1.8, 'new: ' + n.intro);
    assert.ok(v.intro >= 2300 * 1.6 && v.intro <= 2300 * 1.8, 'vet: ' + v.intro);
    assert.ok(r.intro >= 3600 * 1.6 && r.intro <= 3600 * 1.8, 'new raid: ' + r.intro);
    // the rest still comes in after it, in order, and the guide is not held long
    assert.ok(n.intro <= n.tiles && n.tiles < n.stats && n.stats < n.ability && n.ability < n.coach && n.coach <= 9500);
    assert.equal(L.introAlpha(n, n.intro - 1000), 1, 'still fully up a second before the end');
    assert.ok(L.introAlpha(n, 1500, 300) === 0, 'let go early: gone fast');
    const fsj = src('firstSeconds.js');
    assert.match(fsj, /global\.introSkip = skip;/);
    assert.match(fsj, /export function skip\(\) \{\s*if \(!S\.plan \|\| released\(\) \|\| S\.age < 0\) return false;\s*S\.relAt = now\(\);/);
    assert.match(src('canvas.js'), /kc === global\.KEY_ESC && !event\.repeat && global\.introCardUp && global\.introSkip && global\.introSkip\(\)/);
});

test('the millisecond popup: plates wait from the join until the card has played', () => {
    const fsj = src('firstSeconds.js');
    assert.match(fsj, /global\.introWait = inRaid\(\) && !global\.tutorialMode &&\s*\(\(!S\.used && !global\.died\) \|\| \(!!S\.plan && !released\(\) && \(S\.age < 0 \|\| S\.age < S\.plan\.intro\)\)\);/);
    const app = src('app.js');
    assert.match(app, /\|\| global\.introCardUp \|\| global\.introWait \|\| card;/, 'platesWait holds the OVERRIDE popup and Drop in!');
    // the override popup is a plate (it waits like one)
    // round 9: no override popup mid-fight any more (the raid card and the pill)
    assert.ok(!/global\.callouts\.push\(\{ kind: "override"/.test(src('socketinit.js')));
    // the storm banner: not before your tank is down, never a one-frame flash
    assert.match(app, /hs\.inside = !!s && !global\.died && placed && playerInStorm\(\);/);
    assert.match(src('stormFx.js'), /if \(age < 120\) return;/);
});

test('perk cards: big enough for the whole line, centred, compact only when short on room', async () => {
    const L = await imp('raidPerksLogic.js');
    // a 1920 x 1080 HUD (Normal UI scale on a 16:9 screen)
    const W = 1920, H = 1080, bottom = H - 128, minTop = L.tankFloor(H, 40);
    const lay = L.cardLayout(W, 3, { bottom, minTop, left: 248, right: W - 268 });
    assert.equal(lay.compact, false);
    for (const r of lay.rects) {
        assert.ok(r.w >= 280 && r.h >= 118, 'big: ' + r.w + 'x' + r.h);
        assert.ok(r.y >= minTop && r.y + r.h <= bottom);
    }
    // three description lines at 13 px fit the full card, two the compact one
    assert.ok(70 + 2 * L.DESC_LH + 8 <= L.CARD.h && 48 + 2 * L.DESC_LH + 8 <= L.CARD.hc, "three lines on both");
    // narrow: they shrink, never below the compact width
    const nar = L.cardLayout(W, 3, { bottom, minTop, left: 700, right: W - 700 });
    assert.ok(nar.rects.every(r => r.w >= L.CARD.minW), 'min width ' + nar.rects[0].w);
    assert.ok(L.CARD.minW >= 180, 'the compact card still holds two lines of words');
});

test('perk cards: the level is a badge, never glued to the name; hover says everything', async () => {
    const L = await imp('raidPerksLogic.js');
    assert.equal(L.baseName('Overclock II'), 'Overclock');
    assert.equal(L.baseName('Power Drill'), 'Power Drill');
    assert.equal(L.baseName('Seismic Pulse III'), 'Seismic Pulse');
    assert.equal(L.roman(L.nextLevel({ n: 1 })), 'II');
    assert.equal(L.roman(L.nextLevel({ n: 0 })), 'I');
    const p = { id: 'quake', name: 'Seismic Pulse', desc: 'Every few seconds a pulse cracks the rock around you.', n: 0, max: 2 };
    const h = L.hoverText(p);
    assert.equal(h.title, 'Seismic Pulse  I');
    assert.ok(h.body.startsWith(p.desc), 'the whole description: ' + h.body);
    const h2 = L.hoverText({ id: 'reload', name: 'Overclock II', desc: 'Reload 5% faster.', n: 1, max: 3 });
    assert.equal(h2.title, 'Overclock  II');
    assert.match(h2.body, /You have level I\. This takes it to II of III/);
    assert.ok(!/—/.test(JSON.stringify([h, h2])), 'no em dashes');
    const rp = src('raidPerks.js');
    assert.match(rp, /const lv = L\.roman\(L\.nextLevel\(p\)\);/);
    assert.match(rp, /A\.hudTitle\(name, nx, nameY, ns, H\.head, "left"\);/, 'the bare name');
    assert.match(rp, /if \(S\.tip\) A\.queueTip\(S\.tip\.title, S\.tip\.body, r\.x \+ r\.w \/ 2, r\.y - 6\);/, 'hover tooltip');
    // the row lifts over the dash / ability chips instead of narrowing to them
    const app = src('app.js');
    assert.match(app, /const want = 3 \* raidPerks\.CARD_W \+ 2 \* 16;/);
    assert.match(app, /bottom = Math\.min\(bottom, r\.y - 8\);/);
    // and the cards keep above the build strip
    assert.match(rp, /if \(S\.stripBox && S\.stripBox\.y - 10 < o\.bottom\)/);
});

test('perk strip: never more than 2 rows, never past its limits, "+N" for the rest', async () => {
    const L = await imp('raidPerksLogic.js');
    const W = 1920, H = 1080;
    const wallet = { x: W / 2 - 158, y: H - 71, w: 316, h: 18 };
    const right = wallet.x - L.STRIP.lead;
    for (const minX of [248, 420, 640]) {
        for (let n = 0; n <= 16; n++) {
            const full = Array.from({ length: n }, (_, i) => 120 + (i % 3) * 14);
            const lvl = Array.from({ length: n }, (_, i) => 44 + (i % 2) * 8);
            const pl = L.stripPlan(wallet, full, lvl, 26, minX, 38);
            assert.ok(pl, 'a plan for ' + n + ' at ' + minX);
            const rects = pl.icons.filter(Boolean).concat(pl.more ? [pl.more] : [], pl.badge ? [pl.badge] : []);
            const rows = new Set(rects.map(r => r.y));
            assert.ok(rows.size <= 2, n + ' perks at ' + minX + ': ' + rows.size + ' rows');
            for (const r of rects) assert.ok(r.x >= minX - 0.5 && r.x + r.w <= right + 0.5, 'inside ' + minX + '..' + right + ': ' + JSON.stringify(r));
            // no two chips overlap
            for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!L.overlaps(rects[i], rects[j]), 'overlap at n=' + n);
            const shown = pl.icons.filter(Boolean).length;
            assert.equal(shown + (pl.more ? pl.more.n : 0), n, 'every perk shown or counted');
            assert.equal(pl.hidden.length, pl.more ? pl.more.n : 0);
            // above the satchel pills' row, never on them
            assert.ok(pl.box.y + pl.box.h <= wallet.y + wallet.h + 5 && pl.box.x + pl.box.w <= wallet.x);
        }
    }
    // a roomy strip names its perks
    assert.equal(L.stripPlan(wallet, [130, 130], [44, 44], 26, 248).mode, 2);
    // a crowded one goes to icon + level, then "+N"
    const crowd = L.stripPlan(wallet, Array(14).fill(150), Array(14).fill(48), 26, 640, 38);
    assert.equal(crowd.mode, 0);
    assert.ok(crowd.more && crowd.more.n > 0);
    const rp = src('raidPerks.js');
    assert.match(rp, /S\.strip = L\.stripPlan\(w0, lvl, lvl, chip0, minX, 38\);/, 'planned once per build, icons and levels only');
    assert.match(src('app.js'), /wallet, bottom, minTop, left, right, blocked, stripLeft,/);
});

test('bank pops: centred on the screen, under your name', () => {
    const app = src('app.js');
    assert.match(app, /drawBankPops\(global\.screenWidth \/ 2, Math\.round\(walletY - 10 - 4\) - 1 - 30\);/);
    assert.match(app, /drawText\(p\.str, cx \+ \(sz \+ config\.graphical\.fontSizeBoost\) \/ 20, yy/);
});

test('chest labels: rarity in words, constant strings, faded by distance and under HUD text', () => {
    const app = src('app.js');
    assert.match(app, /const CHEST_LABEL = \{ copper: "Copper chest", epic: "Epic chest", crate: "Supply crate" \};/);
    assert.match(app, /drawChestLabel\(c, x, y - R \* 1\.12, R, instance, kind, alpha\);/);
    const fn = app.slice(app.indexOf('function drawChestLabel('), app.indexOf('function drawChestLabel(') + 900);
    // Oct 6: queued for the de-overlap pass, which fades it under HUD text (labelLayout.js)
    assert.match(fn, /worldLabel\(c, CHEST_LABEL\[k\], x, ly, size, CHEST_LABEL_COL\[k\], a, /);
    // (and toward the screen edges: labelNear, Oct 7 2026 declutter)
    assert.match(app, /const a = it\.alpha \* \(it\.blocked \? 0\.3 : 1\) \* labelAlpha\(it\.x, ly, it\.w, it\.h\) \* labelNear\(it\.x, ly\);/);
    assert.ok(!/\+ "|`|\[\]|\{ /.test(fn.replace(/CHEST_LABEL(_COL)?\[k\]/g, '')), 'no strings or objects built per frame');
});

test('distances: metres everywhere', async () => {
    const NL = await imp('newcomerLogic.js');
    assert.equal(NL.bannerFor({ kind: 'crate', t: 'Supply drop coming to you' }, { dist: 570 }).title, 'Supply drop coming, 570m away');
    assert.match(NL.bannerFor({ kind: 'crate', t: 'Supply crate down' }, { dist: 2140 }).title, /2\.1km away$/);
    const CL = await imp('crownsLogic.js');
    assert.equal(CL.distText(640, false), '640m');
    const fmt = /function fmtDist\(d\) \{ return d >= 1000 \? \(d \/ 1000\)\.toFixed\(1\) \+ "km" : Math\.round\(d\) \+ "m"; \}/;
    assert.match(src('app.js'), fmt);
    assert.match(src('coach.js'), fmt);
    assert.match(src('tutorial.js'), /\(dd \/ 1000\)\.toFixed\(1\) \+ "km" : Math\.max\(1, Math\.round\(dd\)\) \+ "m"/);
    // the server's range texts
    const ab = ssrc('game/terrain/abilities.js'), sh = ssrc('game/terrain/shop.js');
    for (const t of ['up to 900m', 'up to 550m', 'within 2.5km']) assert.ok(ab.includes(t), t);
    for (const t of ['within 1.5km', 'up to 500m away', 'within 150m', 'up to 420m', 'within 420m']) assert.ok(sh.includes(t), t);
    assert.ok(!/\b\d{3,}\s+away\b/.test(ab + sh), 'no bare numbers before "away"');
});

test('HP / shield bars: exact numbers over the minimap, cheap, hidden when down', () => {
    const app = src('app.js');
    const fn = app.slice(app.indexOf('function drawVitals() {'), app.indexOf('window.dwVitals'));
    assert.ok(fn.length > 200);
    assert.match(fn, /global\.died \|\| global\.royaleSpectating/);
    assert.match(fn, /if \(hp !== V\.hp \|\| hpMax !== V\.hpMax\)/, 'the words rebuild only when a number changes');
    assert.match(fn, /HP_COLS\[/, 'colours precomputed');
    assert.match(fn, /global\.mobile \? mm\.y \+ mm\.h \+ 18 : mm\.y - 22 - total/, 'desktop over the FPS line, touch under the map');
    assert.match(app, /global\.selfEnt = instance;/);
    assert.match(app, /if \(vitalsRect\) out\.push\(vitalsRect\);/, 'other HUD keeps clear of it');
    assert.match(ssrc('game/gamemodes/scripts/dig_royale.js'), /shm: bodyLive && body\.shield && body\.shield\.max > 0 \? Math\.round\(body\.shield\.max\) : undefined,/);
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
