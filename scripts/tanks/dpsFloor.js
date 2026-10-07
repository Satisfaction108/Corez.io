// Aimed damage floor for the generated tanks (scripts/gen-tanks.js reads dpsFloor.json)
//   node scripts/tanks/dpsFloor.js measure <out.json> [--from n --count n]   engine, expanded tree
//   node scripts/tanks/dpsFloor.js fit <measured.json>                        write dpsFloor.json
//   node scripts/tanks/dpsFloor.js report <before.json> <after.json> [labels...]
// Run measure only through `nice -n 20`, a couple of hundred tanks at a time (8 GB machine).
//
// Why: the power budget (budget.js) counts every barrel, side and rear ones at half a front one,
// and ignores spray. A design with many barrels (or a wide spray) is "expensive", so its damage
// factor drops until the one gun you can aim does almost nothing (Hailstorm's children fired
// bullets at a third of their nominal damage). The duel pass (sanity.js) only nudges inside a
// 0.7-1.35 band. This measures what a player actually gets: a level 45 tank with a maxed offence
// build, standing still and aiming perfectly at a Basic 180 and 340 units away (target refilled
// every tick, so it is damage per second, with the per-class vs-tank multipliers). The aim is the
// best of the cursor on the target or 8 / 16 degrees off it, as a player lines up a fork's prong.
// Rule: a generated tank's aimed damage is at least FLOOR of its parents' mean (after the
// parents' own floors). The factor only multiplies damage, like every other balance factor; it is
// not inherited by children (their own measurement already includes the parent's factors).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const OUT = path.join(__dirname, 'dpsFloor.json');
const [cmd, file, file2] = process.argv.slice(2);
const arg = (k, d) => process.argv.includes(k) ? +process.argv[process.argv.indexOf(k) + 1] : d;
const FLOOR = 0.85;          // a child keeps at least 85% of its parent's aimed damage
const MAX_UP = 2.2;          // one factor never more than doubles (and a bit) a design's damage
// Oct 7 2026 (Glacis: 661 aimed against its parents' 194): the mirror of the floor. A generated
// tank's aimed damage is at most CEIL of its parents' mean; above it the factor scales its damage
// down to land there (a ceiling only ever lowers, and never under MAX_DOWN of the design). It needs
// a real reading of the parents: a parent this test cannot score (Underseer's line converts food
// into drones and has none here; a ram; a short-range trap ring) measures near zero, so parents
// whose mean is under REF_MIN of the generated tanks' median leave the child alone.
const CEIL = 1.25, MAX_DOWN = 0.35, REF_MIN = 0.25;
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const designHash = d => crypto.createHash('sha1').update(JSON.stringify([d.PARENT, d.GUNS, d.TURRETS, d.SHAPE || 0, d.MAX_CHILDREN || 0])).digest('hex').slice(0, 12);
const aimed = r => r && !r.error ? (r.near + r.far) / 2 : null;

if (cmd === 'measure') {
    process.env.ROYALE_TANKS = 'expanded'; process.env.ROYALE_TANKS_T5_FREE = '1';
    { const log = console.log; console.log = () => {}; try { require(path.join(SERVER, 'loaders', 'loader.js')); new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions(); } finally { console.log = log; } }
    Config.dig_royale = true;
    const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
    global.gameManager = {
        room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
        views: [{ check: () => true, add() {}, remove() {} }], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
        socketManager: { players: [], clients: [], broadcast() {} },
    };
    const handler = new gameHandler(global.gameManager); global.gameManager.gameHandler = handler;
    const mining = require(path.join(SERVER, 'game', 'terrain', 'mining.js'));
    let seed = 5;
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    Math.random = () => rnd();
    const OFF = [9, 9, 9, 9, 8, 0, 0, 0, 0, 0, 0];         // raw order rld, pen, str, dam, spd, ...: maxed offence
    const TGT = [7, 7, 5, 7, 4, 2, 0, 5, 2, 5, 0];         // duel.js GUN_BUILD
    const mk = (key, x, y, team, build) => {
        const e = new Entity({ x, y }); e.define(key);
        e.team = team; e.alwaysActive = true; e.invuln = false;
        const me = { e, cmd: { fire: true, main: true, alt: false, power: 1, target: { x: 1, y: 0 }, goal: { x, y } } };
        e.controllers = [{ acceptsFromTop: true, think: () => me.cmd }];
        e.isPlayer = true; e.socket = { talk() {}, status: {}, camera: { x, y }, _careerLives: 100 }; e.sendMessage = () => {}; e.reverseTank = 1;
        while (e.skill.level < 45) { e.skill.score += e.skill.levelScore; e.skill.maintain(); }
        e.skill.set(build); e.refreshSkills && e.refreshSkills(); e.refreshBodyAttributes();
        e.health.amount = e.health.max; e.shield.amount = e.shield.max;
        return me;
    };
    const TICKS = 330, WARM = 60;
    function measure(key, dist, off = 0) {
        seed = 5;
        const X0 = -300, Y0 = 137, A = mk(key, X0, Y0, -1, OFF), T = mk('basic', X0 + dist, Y0, -2, TGT);
        T.cmd.fire = false;
        // Bird fronts fire on the alt button (drone tanks keep alt for pulling drones back)
        const gs = [...A.e.guns.values()];
        if (gs.some(g => g.altFire) && !gs.some(g => g.countsOwnKids)) A.cmd.alt = true;
        const c = Math.cos(off * Math.PI / 180), sn = Math.sin(off * Math.PI / 180);
        let dmg = 0;
        for (let t = 0; t < TICKS; t++) {
            const dx = T.e.x - A.e.x, dy = T.e.y - A.e.y;
            A.cmd.target = { x: dx * c - dy * sn, y: dx * sn + dy * c }; A.cmd.goal = { x: X0, y: Y0 };
            T.cmd.target = { x: -1, y: 0 }; T.cmd.goal = { x: X0 + dist, y: Y0 };
            handler.gameloop();
            if (t >= WARM) dmg += (T.e.health.max - T.e.health.amount) + (T.e.shield.max - T.e.shield.amount);
            T.e.health.amount = T.e.health.max; T.e.shield.amount = T.e.shield.max;
        }
        // rock dug per second by the tank's own barrels (mining.js formula, before Mining Power)
        let rock = 0;
        for (const g of A.e.guns.values()) {
            if (!g.canShoot || !(g.settings.reload > 0) || g.countsOwnKids || g.autofire) continue;
            rock += mining.rockDamageFor(A.e, { digPower: g.digPower || 1, type: (g.bulletType && g.bulletType.TYPE) || 'bullet' }) * 30 / g.settings.reload;
        }
        const hp = T.e.health.max + T.e.shield.max;
        for (const x of [...entities.values()]) { try { x.kill(); } catch { /* */ } }
        for (let t = 0; t < 3; t++) handler.gameloop();
        return { dps: +(dmg / ((TICKS - WARM) / 30)).toFixed(3), rock: +rock.toFixed(3), hp };
    }
    const keys = []; { const seen = new Set(['basic']), q = ['basic']; while (q.length) { const k = q.shift(); keys.push(k); for (let t = 1; t <= 4; t++) for (const u of arr(Class[k]['UPGRADES_TIER_' + t])) if (typeof u === 'string' && !seen.has(u)) { seen.add(u); q.push(u); } } }
    // --only <labels.json>: just those tanks (a re-measure of the ones a fit raised)
    if (process.argv.includes('--only')) { const L = new Set(JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--only') + 1], 'utf8'))); keys.splice(0, keys.length, ...keys.filter(k => L.has(Class[k].LABEL))); }
    const from = arg('--from', 0), count = arg('--count', keys.length);
    const res = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const t0 = Date.now();
    for (const k of keys.slice(from, from + count)) {
        // a player aims the gun that lands: the best of the cursor on the target or 8 / 16 deg off
        // (a fork's prong, a side barrel), at each range
        const best = d => [0, 8, 16].map(o => measure(k, d, o)).reduce((x, y) => y.dps > x.dps ? y : x);
        try { const a = best(180), b = best(340); res[k] = { label: Class[k].LABEL, near: a.dps, far: b.dps, rock: a.rock, targetHp: a.hp }; }
        catch (e) { res[k] = { label: Class[k] && Class[k].LABEL, error: String(e.message).slice(0, 120) }; for (const x of [...entities.values()]) { try { x.kill(); } catch { /* */ } } }
    }
    fs.writeFileSync(file, JSON.stringify(res));
    process.stdout.write(Math.min(count, keys.length - from) + ' tanks in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s (' + keys.length + ' in the tree)\n', () => process.exit(0));
    return;
}

const D = require(path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js'));
if (cmd === 'fit') {
    const M = JSON.parse(fs.readFileSync(file, 'utf8'));
    const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { f: {} };
    const after = {}, f = {}, rows = [];
    const dpsOf = k => after[k] ?? aimed(M[k]);
    const gen = D.tanks.map(t => aimed(M[t.key])).filter(x => x != null).sort((x, y) => x - y), refMin = REF_MIN * (gen[gen.length >> 1] || 0);
    const smash = t => /smasher|landmine|spike/i.test(JSON.stringify(t.def.PARENT)) || t.branch === 'smasher';
    for (const t of [...D.tanks].sort((a, b) => a.tier - b.tier)) {
        // its parents' mean, as the power budget aims a child at its parents' mean
        const h = designHash(t.def), own = aimed(M[t.key]), p = t.parents[0], pds = t.parents.map(dpsOf).filter(x => x != null), pd = pds.length ? pds.reduce((x, y) => x + y, 0) / pds.length : null;
        // the factor this data was measured with is already in `own`
        const had = prev.f[h] || 1;
        if (own == null || pd == null || smash(t) || !(pd > 0)) { after[t.key] = own; if (had !== 1) f[h] = had; continue; }
        let k = had;
        if (own < FLOOR * pd) k = Math.min(MAX_UP, had * FLOOR * pd / Math.max(own, 1e-6));
        else if (own > CEIL * pd && pd >= refMin) k = Math.max(MAX_DOWN, Math.min(had, had * CEIL * pd / own));
        k = +k.toFixed(3);
        after[t.key] = own * k / had;
        if (k !== 1) f[h] = k;
        if (k !== had) rows.push([t.label, t.tier, t.parents.map(q => M[q] && M[q].label).join('/'), +own.toFixed(2), +pd.toFixed(2), +(own / pd).toFixed(2), k]);
    }
    const out = { generated: 'scripts/tanks/dpsFloor.js fit', rule: `aimed damage (level 45, maxed offence, standing aim at a Basic 180/340 away) at least ${FLOOR} and at most ${CEIL} of its parents' mean; damage factor only, ${MAX_DOWN}x to ${MAX_UP}x, not inherited`,
        floor: FLOOR, ceil: CEIL, refMin: +refMin.toFixed(2), maxUp: MAX_UP, maxDown: MAX_DOWN, raised: Object.values(f).filter(v => v > 1).length, lowered: Object.values(f).filter(v => v < 1).length, f: Object.fromEntries(Object.entries(f).sort()) };
    fs.writeFileSync(OUT, JSON.stringify(out).replace(/,"f":/, ',\n"f":') + '\n');
    rows.sort((a, b) => a[5] - b[5]);
    console.log('changed', rows.length, '(label, tier, parent, dps, parent dps, ratio, factor); lowered by the ceiling', rows.filter(r => r[6] < 1).length);
    for (const r of rows) console.log('  ' + r.join('  '));
    process.exit(0);
}
if (cmd === 'report') {
    const A = JSON.parse(fs.readFileSync(file, 'utf8')), Bm = JSON.parse(fs.readFileSync(file2, 'utf8'));
    const want = process.argv.slice(5);
    const byKey = Object.fromEntries(D.tanks.map(t => [t.key, t]));
    const rows = [];
    for (const k in Bm) { const t = byKey[k]; if (!t) continue; const p = t.parents[0]; const mean = (M, ks) => { const v = ks.map(q => aimed(M[q])).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; }; const a = aimed(Bm[k]), pa = mean(Bm, t.parents); if (a == null || pa == null || !(pa > 0)) continue; rows.push({ k, label: Bm[k].label, tier: t.tier, before: aimed(A[k]), after: a, parent: t.parents.map(q => Bm[q] && Bm[q].label).join('/'), pAfter: pa, r0: aimed(A[k]) / mean(A, t.parents), r1: a / pa, rock0: A[k] && A[k].rock, rock1: Bm[k].rock }); }
    const lt = x => rows.filter(r => r.r1 < x).length, lt0 = x => rows.filter(r => r.r0 < x).length;
    console.log('generated tanks measured', rows.length, '; below 0.85 of parent before', lt0(0.85 - 1e-9), 'after', lt(0.85 - 1e-9), '; below 0.5 before', lt0(0.5), 'after', lt(0.5), '; above ' + CEIL + ' before', rows.filter(r => r.r0 > CEIL + 1e-9).length, 'after', rows.filter(r => r.r1 > CEIL + 1e-9).length);
    for (const r of rows.filter(r => !want.length || want.includes(r.label))) console.log(`  ${r.label} T${r.tier}: aimed dps ${r.before?.toFixed(2)} -> ${r.after.toFixed(2)} (parent ${r.parent} ${r.pAfter.toFixed(2)}, ratio ${r.r0.toFixed(2)} -> ${r.r1.toFixed(2)}), rock ${r.rock0} -> ${r.rock1}`);
    process.exit(0);
}
console.log('usage: dpsFloor.js measure|fit|report');
