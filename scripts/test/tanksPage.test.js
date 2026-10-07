// The /tanks page data (scripts/build-tanks.js)
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const REPO = path.join(__dirname, '..', '..');
const PUB = path.join(REPO, 'public', 'tanks');

const results = [];
function test(name, fn) { try { fn(); results.push(true); console.log('ok   ' + name); } catch (e) { results.push(false); console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 6).join('\n     ')); } }

// a fresh build of the data (no Chrome) next to the committed pictures
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-page-'));
for (const f of ['atlas-s.webp', 'atlas-l.webp']) if (fs.existsSync(path.join(PUB, f))) fs.copyFileSync(path.join(PUB, f), path.join(OUT, f));
const log = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'build-tanks.js'), '--no-atlas'], { env: { ...process.env, TANKS_OUT: OUT }, cwd: REPO }).toString();
const D = JSON.parse(fs.readFileSync(path.join(OUT, 'tanks.json'), 'utf8'));
const ALL = D.tanks.map(([name, tier, branch, parents, kids, cell, x, y, prim, real, col]) => ({ name, tier, branch, parents, kids, cell, x, y, prim, real: real == null ? -1 : real, col }));
// copy tiles (a tank shown under its other parents) come after the real rows
const T = ALL.filter(t => t.real < 0);
const COPIES = ALL.filter(t => t.real >= 0);

test('builds: every tank, tiers 1 to 5, Basic at the root', () => {
    assert.ok(/\[tanks\] \d+ tanks/.test(log), log);
    assert.equal(D.count, T.length);
    assert.ok(T.length >= 700, 'tanks ' + T.length);
    assert.equal(T[0].name, 'Basic'); assert.equal(T[0].tier, 1);
    for (let t = 1; t <= 5; t++) assert.ok(T.some(x => x.tier === t), 'no Tier ' + t);
    assert.equal(new Set(T.map(t => t.name)).size, T.length, 'names are unique');
});

test('tree: parents and upgrades agree, one tier apart in the game\'s slots', () => {
    T.forEach((t, i) => {
        if (i) assert.ok(t.parents.length >= 1 && t.parents.includes(t.prim), t.name + ' has no parent');
        for (const p of t.parents) assert.ok(T[p].kids.includes(i), T[p].name + ' does not list ' + t.name);
        for (const k of t.kids) assert.ok(T[k].parents.includes(i), t.name + ' -> ' + T[k].name);
        if (i) assert.ok(T[t.prim].tier < t.tier, t.name + ' above its parent');
    });
    assert.ok(T.filter(t => t.tier === 5).every(t => t.parents.every(p => T[p].tier === 4)), 'Tier 5 comes from Tier 4');
});

test('layout: no two tiles overlap, all inside the page, every tank in a line', () => {
    const S = D.tile;
    const sorted = [...ALL].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j].y < sorted[i].y + S + 12; j++) {
        const a = sorted[i], b = sorted[j];
        assert.ok(Math.abs(a.x - b.x) >= S + 8 || Math.abs(a.y - b.y) >= S + 12, a.name + ' overlaps ' + b.name);
    }
    for (const t of T) assert.ok(t.x >= 0 && t.y >= 0 && t.x + S <= D.w && t.y + S <= D.h, t.name + ' outside');
    // every extra parent shows a copy of the tank under it, pointing back at the real one
    const realIdx = new Map(ALL.map((t, i) => [t, i]));
    for (const t of T) for (const p of t.parents.slice(1)) {
        assert.ok(COPIES.some(c => c.real === realIdx.get(t) && c.prim === p), t.name + ' missing under ' + ALL[p].name);
    }
    assert.ok(T.slice(1).every(t => t.branch >= 0 && t.branch < D.branches.length), 'a tank without a line');
    assert.deepEqual(D.branches.map(b => b.name).slice(0, 3), ['Twin', 'Sniper', 'Machine Gun']);
});

test('tiles: the game\'s upgrade-tile colours, no branch strip, tier labels on every line', () => {
    assert.equal(D.tiles.length, 12, 'the 12-colour cycle of the upgrade tiles');
    const lum = h => { const v = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return 0.3 * v[0] + 0.59 * v[1] + 0.11 * v[2]; };
    for (const [face, lip] of D.tiles) { assert.ok(/^#[0-9a-f]{6}$/.test(face) && /^#[0-9a-f]{6}$/.test(lip), face + ' ' + lip); assert.ok(lum(lip) < lum(face) * 0.75, 'lip ' + lip + ' not darker than ' + face); }
    assert.equal(new Set(D.tiles.map(t => t[0])).size, 12, 'twelve different faces');
    // the first face is the game's: dark-theme blue calmed toward the HUD well
    assert.equal(D.tiles[0][0], '#3977d7');
    assert.ok(ALL.every(t => Number.isInteger(t.col) && t.col >= 0), 'a tile without a colour');
    // brothers side by side never share a colour (up to the 12 of the cycle)
    const under = new Map(); for (const t of ALL) if (t.prim >= 0) { if (!under.has(t.prim)) under.set(t.prim, []); under.get(t.prim).push(t.col % 12); }
    for (const [p, cs] of under) if (cs.length <= 12) assert.equal(new Set(cs).size, cs.length, ALL[p].name + "'s upgrades repeat a colour");
    const js = fs.readFileSync(path.join(PUB, 'tanks.js'), 'utf8');
    assert.ok(!/D\.branches\[t\.branch\]\.color/.test(js), 'the branch-colour strip is back on the tiles');
    assert.ok(/D\.tiles/.test(js) && /strokeText/.test(js), 'tiles coloured from D.tiles, names with a halo');
    for (const b of D.blocks) { assert.ok(b.t && b.t.some(r => r[0] === 5), 'line ' + b.b + ' has no tier labels'); for (const [tr, y] of b.t) assert.ok(tr >= 2 && tr <= 5 && y >= b.y, 'tier label ' + tr); }
});

test('pictures: one atlas cell per tank, drawn by the game renderer, under 3 MB in all', () => {
    assert.ok(T.every(t => t.cell >= 0), T.filter(t => t.cell < 0).length + ' tanks without a picture (run node scripts/build-tanks.js --atlas)');
    let bytes = 0;
    for (const f of ['tanks.json', 'atlas-s.webp', 'atlas-l.webp']) bytes += fs.statSync(path.join(f === 'tanks.json' ? OUT : PUB, f)).size;
    for (const f of ['index.html', 'tanks.js']) bytes += fs.statSync(path.join(PUB, f)).size;
    assert.ok(bytes < 3 * 1048576, (bytes / 1048576).toFixed(2) + ' MB');
    const map = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'tanks', 'atlas.map.json'), 'utf8'));
    assert.equal(map.count, Math.max(...T.map(t => t.cell)) + 1);
});

test('public: no class keys or balance numbers ship, plain words, served and obfuscated', () => {
    const raw = fs.readFileSync(path.join(OUT, 'tanks.json'), 'utf8');
    assert.ok(!/xp_|"key"|damage|health|SKILL|balance/i.test(raw), 'internal data in tanks.json');
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), js = fs.readFileSync(path.join(PUB, 'tanks.js'), 'utf8');
    for (const s of [html, js]) assert.ok(!/[–—]/.test(s), 'an en or em dash');
    assert.ok(html.includes('Lilita One') && html.includes('/font.css') && html.includes('/tanks/tanks.js'));
    assert.ok(!/gradient|backdrop-filter/.test(html), 'no gradients or glass');
    const server = fs.readFileSync(path.join(REPO, 'server', 'server.js'), 'utf8');
    assert.ok(/case "\/tanks":/.test(server), 'the /tanks route');
    assert.ok(/build-tanks\.js/.test(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts.build), 'npm run build runs it');
    assert.ok(fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8').includes('href="/tanks"'), 'linked from the homepage');
});

fs.rmSync(OUT, { recursive: true, force: true });
const failed = results.filter(r => !r).length;
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
