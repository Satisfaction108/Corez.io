// Expanded tank tree: node scripts/test/tanksExpansion.test.js
'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');

// ---- child: load the definitions under the given env and describe the tree
if (process.argv[2] === '--dump') {
    const log = console.log; console.log = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        if (process.env.DUMP_TUTORIAL === '1') Config.tutorial = true;
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = log; }
    const B = require(path.join(REPO, 'scripts', 'tanks', 'budget.js'));
    const N = require(path.join(REPO, 'scripts', 'tanks', 'neat.js'));
    const D = require(path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js'));
    B.setConstants(D.constants); B.setRamK(D.constants.ram);
    const tier = { basic: 1 }, parents = { basic: [] }, slots = {}, q = ['basic'];
    while (q.length) {
        const k = q.shift();
        for (let t = 1; t <= 4; t++) for (const u of (Class[k]['UPGRADES_TIER_' + t] || [])) {
            if (typeof u !== 'string') continue;
            if (!(u in tier)) { tier[u] = t + 1; parents[u] = []; q.push(u); }
            parents[u].push(k); (slots[u] = slots[u] || new Set()).add(t);
        }
    }
    const tanks = {}, flat = {};
    for (const k in tier) {
        const f = B.flatten(k), p = B.power(f); flat[k] = f;
        const armed = t => t.def && (t.def.guns.some(x => x.typed) || t.def.turrets.some(armed));
        const inv = B.get(Class[k], 'INVISIBLE');
        tanks[k] = { tier: tier[k], parents: parents[k], slots: [...(slots[k] || [])], label: f.label, O: p.O, S: p.S, P: p.P,
            shoots: f.guns.some(x => x.typed) || f.turrets.some(t => !t.prop && armed(t)), smasher: f.smasher, shape: f.shape || 0,
            invisible: Array.isArray(inv) && !!(inv[0] || inv[1]) };
        { const ov = N.overlap(f), tu = N.turrets(f); Object.assign(tanks[k], { sym: N.symmetry(f), ov: ov.worst, tu, sb: N.stubby(f) }); }
    }
    // tanks sharing a barrel layout, and upgrades that only add turrets
    const sig = {}; for (const k in flat) (sig[N.layoutSig(flat[k])] = sig[N.layoutSig(flat[k])] || []).push(k);
    const bare = f => ({ ...f, turrets: f.turrets.filter(t => !N.armed(t)) });
    for (const k in flat) if (k.startsWith('xp_')) {
        tanks[k].same = sig[N.layoutSig(flat[k])].filter(o => o !== k && N.sameLayout(flat[k], flat[o]));
        tanks[k].lazy = parents[k].filter(p => N.sameLayout(bare(flat[k]), bare(flat[p])) && flat[k].turrets.filter(N.armed).length > flat[p].turrets.filter(N.armed).length);
    }
    // dead barrels, line identity, sibling bolt-ons (scripts/tanks/neat.js, as gen-tanks.js uses them)
    const decos = new Set(); for (const k of [...Object.keys(flat).filter(k => !k.startsWith('xp_')), ...(Class.desmos ? ['desmos'] : [])]) for (const x of (flat[k] || B.flatten(k)).guns) if (!x.typed) decos.add(N.decoSig(x));
    const byParent = {}; for (const k in tier) for (const p of parents[k]) (byParent[p + ':' + tier[k]] = byParent[p + ':' + tier[k]] || []).push(k);
    for (const k in flat) if (k.startsWith('xp_')) {
        const f = flat[k];
        tanks[k].dead = N.deadGuns(f, { decos, valid: x => typeof x.type === 'string' && !!Class[x.type] && (!B.isStock(x.type) || x.max > 0 || f.maxChildren > 0) }).length;
        tanks[k].line = parents[k].filter(p => !N.lineOK(f, flat[p])).map(p => p + ' ' + N.mainKind(flat[p]) + '>' + N.mainKind(f));
        tanks[k].conv = /^xp_g\d+$/.test(k) && N.converted(f, flat[parents[k][0]]) && !N.hybrid(flat[parents[k][0]]);
        tanks[k].bolt = /^xp_g\d+$/.test(k) ? [...new Set(parents[k].flatMap(p => byParent[p + ':' + tier[k]].filter(o => o !== k && N.boltOn(f, flat[o]))))] : [];
    }
    process.stdout.write(JSON.stringify({ tanks, xp: Object.keys(Class).filter(k => k.startsWith('xp_')).length, hash: B.treeHash(), basic1: Class.basic.UPGRADES_TIER_1 }), () => process.exit(0));
    return;
}

// ---- child: build every tank's mockup and spawn it in the real engine for a few ticks
if (process.argv[2] === '--ram') {
    const log = console.log; console.log = () => {};
    let classicCaps;
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = log; }
    Config.dig_royale = true;
    const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
    global.gameManager = {
        room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
        views: [{ check: () => true, add() {}, remove() {} }], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
        socketManager: { players: [], clients: [], broadcast() {} },
    };
    new gameHandler(global.gameManager);
    const R = require(path.join(SERVER, 'lib', 'definitions', 'ramTanks.js'));
    const botTanks = require(path.join(SERVER, 'miscFiles', 'botTanks.js'));
    const C = require(path.join(SERVER, 'lib', 'definitions', 'constants.js'));
    const keys = []; { const seen = new Set(['basic']), q = ['basic']; while (q.length) { const k = q.shift(); keys.push(k); for (let t = 1; t <= 4; t++) for (const u of (Class[k]['UPGRADES_TIER_' + t] || [])) if (typeof u === 'string' && !seen.has(u)) { seen.add(u); q.push(u); } } }
    const byLabel = l => keys.find(k => Class[k].LABEL === l);
    const getP = (d, k, n = 0) => !d || n > 30 ? undefined : d[k] !== undefined ? d[k] : [].concat(d.PARENT || []).reverse().map(p => getP(typeof p === 'string' ? Class[p] : p, k, n + 1)).find(v => v !== undefined);
    const out = { tanks: {}, autoSmasherCaps: getP(Class.autoSmasher, 'SKILL_CAP'), genericCaps: getP(Class.genericSmasher, 'SKILL_CAP'), smasherNames: C.statnames.smasher };
    for (const k of keys) {
        const d = Class[k], c = R.classify(d);
        const e = new Entity({ x: 0, y: 0 }); e.define(k);
        out.tanks[k] = { label: d.LABEL, ram: c.ram, kind: c.kind, autos: c.autos, front: c.front, thrusters: c.thrusters, caps: getP(d, 'SKILL_CAP'), namesSmasher: getP(d, 'STAT_NAMES') === C.statnames.smasher,
            reload: e.settings.skillNames && e.settings.skillNames.reload, live: e.skill.caps.slice(), accel: !!e.settings.reloadToAcceleration, build: botTanks.buildKind({ defs: [k] }) };
        e.destroy && e.destroy();
    }
    out.labels = { bumper: byLabel('Bumper'), grinder: byLabel('Grinder'), wrecker: byLabel('Wrecker'), auto3: 'auto3', booster: 'booster', fighter: 'fighter' };
    process.stdout.write(JSON.stringify(out));
    return;
}
if (process.argv[2] === '--spawn') {
    const log = console.log; console.log = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = log; }
    Config.dig_royale = true;
    const { gameHandler } = require(path.join(SERVER, 'game', 'index.js'));
    global.gameManager = {
        room: { width: 20000, height: 20000, topPlayerID: -1, isIn: () => false, getAt: () => null, isInNorm: () => true },
        views: [{ check: () => true, add() {}, remove() {} }], minimap: [], roomSpeed: 1, runSpeed: 1, clients: [], terrainGrid: null,
        socketManager: { players: [], clients: [], broadcast() {} },
    };
    const handler = new gameHandler(global.gameManager); global.gameManager.gameHandler = handler;
    const { buildMockup } = require(path.join(SERVER, 'miscFiles', 'mockups.js'));
    const keys = []; { const seen = new Set(['basic']), q = ['basic']; while (q.length) { const k = q.shift(); keys.push(k); for (let t = 1; t <= 4; t++) for (const u of (Class[k]['UPGRADES_TIER_' + t] || [])) if (typeof u === 'string' && !seen.has(u)) { seen.add(u); q.push(u); } } }
    const out = { n: keys.length, errors: [], mockMax: 0, mockSlow: '', shots: 0, silent: [] };
    for (const k of keys) { const t0 = performance.now(); try { buildMockup(k, global.gameManager); } catch (e) { out.errors.push('mockup ' + k + ': ' + e.message); } const ms = performance.now() - t0; if (ms > out.mockMax) { out.mockMax = ms; out.mockSlow = k; } }
    for (let i = 0; i < keys.length; i += 40) {
        const batch = [];
        for (const k of keys.slice(i, i + 40)) {
            try {
                const e = new Entity({ x: (batch.length % 8) * 900 - 3600, y: Math.floor(batch.length / 8) * 900 - 2000 }); e.define(k);
                e.team = -1 - batch.length; e.alwaysActive = true; e.controllers = []; e.invuln = false;
                e.isPlayer = true; e.socket = { talk() {}, status: {}, camera: { x: 0, y: 0 }, _careerLives: 100 }; e.sendMessage = () => {};
                Object.defineProperty(e.control, 'fire', { get: () => true, set() {}, configurable: true });
                while (e.skill.level < 45) { e.skill.score += e.skill.levelScore; e.skill.maintain(); }
                e.refreshBodyAttributes(); batch.push([k, e]);
            } catch (err) { out.errors.push('define ' + k + ': ' + err.message); }
        }
        const before = entities.size;
        for (let tick = 0; tick < 90; tick++) {
            for (const [, e] of batch) e.control.target = { x: 0, y: -100 };
            try { handler.gameloop(); } catch (err) { out.errors.push('tick: ' + err.message); break; }
        }
        for (const [k, e] of batch) { const kids = [...entities.values()].filter(x => x.master === e && x !== e && !x.bond).length; if (!kids && !e.isSmasher && !Class[k].IS_SMASHER && !(e.guns && e.guns.size === 0)) out.silent.push(k); }
        out.shots += Math.max(0, entities.size - before);
        for (const x of [...entities.values()]) { try { x.kill(); } catch { /* */ } }
        for (let tick = 0; tick < 3; tick++) handler.gameloop();
    }
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
    return;
}

// ---- parent
const D = require(path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js'));
function dump(env) {
    const e = { ...process.env, ...env };
    for (const k of ['ROYALE_TANKS', 'ROYALE_TANKS_T5_FREE']) if (!(k in env)) delete e[k];
    return JSON.parse(execFileSync(process.execPath, [__filename, '--dump'], { env: e, maxBuffer: 64 << 20, cwd: REPO }).toString());
}
const OFF = dump({ ROYALE_TANKS: 'classic' }), ON = dump({}), FREE = dump({ ROYALE_TANKS_T5_FREE: '1' });
const TUT = dump({ DUMP_TUTORIAL: '1' });
const results = [];
function test(name, fn) { try { fn(); results.push([name, null]); console.log('ok   ' + name); } catch (e) { results.push([name, e]); console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 6).join('\n     ')); } }

test('off: the tree is exactly today\'s, nothing new defined', () => {
    assert.equal(OFF.xp, 0, 'xp_ classes defined with the switch off');
    assert.equal(OFF.hash, D.base.hash, 'tree differs from the one the data was generated from (re-run scripts/gen-tanks.js)');
    assert.ok(OFF.basic1.includes('desmos'));
    assert.ok(!Object.keys(OFF.tanks).some(k => k.startsWith('xp_')));
    // the tutorial keeps the small classic tree whatever the switch says
    assert.equal(TUT.xp, 0, 'xp_ classes in the tutorial');
    assert.equal(TUT.hash, D.base.hash);
});

test('defined: every new tank exists and is reachable, Splitter replaces Desmos', () => {
    const missing = D.tanks.filter(t => !(t.key in ON.tanks)).map(t => t.label);
    assert.deepEqual(missing, [], 'unreachable: ' + missing.join(', '));
    assert.ok(ON.basic1.includes(D.root) && !ON.basic1.includes('desmos'));
    assert.ok(!('desmos' in ON.tanks), 'desmos still reachable');
    for (const k of ['helix', 'triplex', 'quadruplex']) assert.ok(k in ON.tanks, k + ' lost');
    const oldCount = Object.keys(OFF.tanks).length;
    assert.equal(Object.keys(ON.tanks).length, oldCount - 1 + D.tanks.length);
    for (const [k, t] of Object.entries(ON.tanks)) if (k !== 'basic') assert.ok(t.parents.length >= 1, k + ' has no parent');
    const multi = Object.values(ON.tanks).filter(t => t.parents.length > 1).length;
    assert.ok(multi > 20, 'expected a graph with shared children, got ' + multi);
    for (const t of D.tanks) assert.equal(ON.tanks[t.key].tier, t.tier, t.label + ' tier');
});

test('labels: unique, short, no placeholder or blank tanks', () => {
    const seen = new Map(), dup = [];
    for (const [k, t] of Object.entries(ON.tanks)) {
        assert.ok(t.label && t.label !== 'Unknown Class' && !/^(placeholder|todo|unknown)$|^\s*$/i.test(t.label), k + ' label ' + t.label);
        const l = t.label.toLowerCase(); if (seen.has(l)) dup.push(t.label + ' (' + seen.get(l) + ', ' + k + ')'); seen.set(l, k);
        assert.ok(t.shoots || t.smasher, k + ' neither shoots nor rams');
    }
    assert.deepEqual(dup, [], 'duplicate labels: ' + dup.join(', '));
    for (const t of D.tanks) assert.ok(t.label.length <= 14 && /^[A-Z][A-Za-z]+$/.test(t.label), 'name ' + t.label);
});

test('balance: today\'s tanks untouched, new tanks balanced against their parents', () => {
    const bad = [], steps = D.tolerance.steps, [tlo, thi] = D.tolerance.tough;
    for (const [k, t] of Object.entries(ON.tanks)) {
        if (!k.startsWith('xp_')) {
            if (k in D.balance) bad.push(k + ' (old) has a balance entry');
            const o = OFF.tanks[k];
            if (!o || Math.abs(o.P - t.P) > 1e-9 || Math.abs(o.O - t.O) > 1e-9 || Math.abs(o.S - t.S) > 1e-9) bad.push(k + ' (old) changed: power ' + (o && o.P) + ' -> ' + t.P);
            continue;
        }
        const [, , target] = D.balance[k];
        // a parent counts at its target (a generated one) or its power times the premium (today's)
        const ps = t.parents.map(p => p.startsWith('xp_') ? D.balance[p][2] : ON.tanks[p].P * (t.tier >= 4 ? D.tolerance.oldPremium || 1 : 1)), want = ps.reduce((a, b) => a + b, 0) / ps.length * steps[t.tier];
        const kk = D.balance[k][3] || 1, sref = D.sref[t.tier], s = t.S / sref, o = t.O / (target * kk / sref);
        if (Math.abs(target / want - 1) > 0.03) bad.push(`${k} T${t.tier} target ${target.toFixed(1)} vs parents x step ${want.toFixed(1)}`);
        if (Math.abs(t.P / (target * kk) - 1) > 0.03) bad.push(`${k} T${t.tier} power x${(t.P / target).toFixed(3)} of its target (duel factor ${kk})`);
        if (kk < 0.4 || kk > 2.5) bad.push(`${k} duel factor ${kk} (with its parents') out of reason`);
        if (s < tlo - 0.02 || s > thi + 0.02 || o < tlo - 0.02 || o > thi + 0.02) bad.push(`${k} T${t.tier} O x${o.toFixed(2)} S x${s.toFixed(2)}`);
    }
    assert.deepEqual(bad, [], bad.length + ' off budget:\n' + bad.slice(0, 12).join('\n'));
});

test('bodies: round, squares only down the Necromancer line', () => {
    const square = new Set(['underseer', 'necromancer', 'maleficitor']);
    for (const t of [...D.tanks].sort((a, b) => a.tier - b.tier)) if (ON.tanks[t.key].shape === 4 && t.parents.some(p => square.has(p))) square.add(t.key);
    const bad = D.tanks.filter(t => { const sh = ON.tanks[t.key].shape; return sh !== 0 && !(sh === 4 && square.has(t.key)); }).map(t => t.label + ' ' + ON.tanks[t.key].shape);
    assert.deepEqual(bad, [], 'not round: ' + bad.join(', '));
});

test('neat: symmetric, nothing piled up, turrets on the body, no stubs', () => {
    const bad = [];
    for (const t of D.tanks) {
        const x = ON.tanks[t.key], par = t.parents.map(p => ON.tanks[p]).filter(p => p && p.tu);
        const pOv = Math.max(0, ...par.map(p => p.ov)), pSb = Math.min(Infinity, ...par.map(p => p.sb ?? Infinity)), sb = x.sb ?? Infinity;
        if (!x.sym) bad.push(t.label + ': not symmetric');
        if (x.ov > Math.max(0.45, pOv + 0.02)) bad.push(t.label + ': barrels overlap ' + x.ov);
        if (x.tu.off > 0.6 || x.tu.pile || x.tu.cover) bad.push(t.label + ': turrets ' + JSON.stringify(x.tu));
        if (sb < Math.min(0.45, pSb)) bad.push(t.label + ': stub barrel ' + sb.toFixed(2));
    }
    assert.deepEqual(bad, [], bad.length + ' untidy:\n' + bad.slice(0, 12).join('\n'));
});

test('layouts: no duplicate barrel layouts, no turret-only upgrades', () => {
    const dup = D.tanks.filter(t => ON.tanks[t.key].same.length).map(t => t.label + ' = ' + ON.tanks[t.key].same.map(k => ON.tanks[k].label).join('/'));
    assert.deepEqual(dup, [], dup.length + ' duplicates: ' + dup.slice(0, 12).join(', '));
    for (const k of ['chorus', 'tripod']) assert.ok(!D.tanks.some(t => t.key === 'xp_' + k), k + ' is back');
    const lazy = D.tanks.filter(t => ON.tanks[t.key].lazy.length).map(t => t.label + ' < ' + ON.tanks[t.key].lazy.map(k => ON.tanks[k].label).join('/'));
    assert.deepEqual(lazy, [], lazy.length + ' lazy: ' + lazy.slice(0, 12).join(', '));
});

test('weapons: no dead barrels, drone and trap lines keep their weapon, no conversions, no sibling bolt-ons', () => {
    const lab = k => ON.tanks[k].label;
    const dead = D.tanks.filter(t => ON.tanks[t.key].dead).map(t => t.label);
    assert.deepEqual(dead, [], dead.length + ' with barrels that fire nothing: ' + dead.slice(0, 12).join(', '));
    const line = D.tanks.filter(t => ON.tanks[t.key].line.length).map(t => t.label + ' (' + ON.tanks[t.key].line.join('; ') + ')');
    assert.deepEqual(line, [], line.length + ' left their line: ' + line.slice(0, 12).join(', '));
    const conv = D.tanks.filter(t => ON.tanks[t.key].conv).map(t => t.label);
    assert.deepEqual(conv, [], conv.length + ' turned a weapon into another kind on a parent that does not mix kinds: ' + conv.slice(0, 12).join(', '));
    const bolt = D.tanks.filter(t => ON.tanks[t.key].bolt.length).map(t => t.label + ' ~ ' + ON.tanks[t.key].bolt.map(lab).join('/'));
    assert.deepEqual(bolt, [], bolt.length + ' sibling plus a bolt-on: ' + bolt.slice(0, 12).join(', '));
});

test('duel sanity: new tanks vs parents and siblings (scripts/tanks/sanity.js)', () => {
    const S = require(path.join(REPO, 'scripts', 'tanks', 'duelSanity.json'));
    const s = S.summary;
    console.log(`     round ${S.round}, ${S.duels} duels, ${s.tanks} tanks: mean vs parent ${s.meanVsParent}, child loses clearly ${s.childLosesClearly}, sibling dominates ${s.siblingDominates}, flagged ${S.flagged.length}`);
    for (const v of Object.values(S.k)) assert.ok(v >= S.band[0] - 1e-9 && v <= S.band[1] + 1e-9, 'factor ' + v);
    assert.ok(s.meanVsParent >= 0.4 && s.meanVsParent <= 0.75, 'children vs parents ' + s.meanVsParent);
    // a light pass (a few duels a tank): flagged tanks are reported, not failed on
    if (S.flagged.length) console.log('     flagged (first 15): ' + S.flagged.slice(0, 15).join(', '));
    const used = new Set(Object.keys(D.balance).filter(k => D.balance[k][3]).map(k => D.balance[k][3]));
    assert.ok(Object.keys(S.k).length === 0 || used.size > 0, 'duel factors not applied (re-run scripts/gen-tanks.js)');
});

test('children: every Tier 3 tank has 3+ Tier 4 children, every Tier 4 tank 3+ Tier 5', () => {
    const kids = {}; for (const [k, t] of Object.entries(ON.tanks)) for (const p of t.parents) { const key = p + ':' + t.tier; kids[key] = (kids[key] || 0) + 1; }
    const short = Object.entries(ON.tanks).filter(([k, t]) => (t.tier === 3 || t.tier === 4) && (kids[k + ':' + (t.tier + 1)] || 0) < 3).map(([k, t]) => t.label + ' T' + t.tier + ' ' + (kids[k + ':' + (t.tier + 1)] || 0));
    assert.deepEqual(short, [], short.length + ' short: ' + short.join(', '));
    const n = D.tanks.length; assert.ok(n >= 550 && n <= 720, 'new tanks ' + n);
});

test('invisible: everything under Stalker, Manager or Landmine fades too', () => {
    const inv = new Set(Object.entries(ON.tanks).filter(([, t]) => t.invisible && t.tier <= 4).map(([k]) => k));
    for (const k of ['stalker', 'manager', 'landmine']) assert.ok(inv.has(k), k + ' not invisible');
    const bad = [];
    for (const t of [...D.tanks].sort((a, b) => a.tier - b.tier)) {
        const from = t.parents.filter(p => inv.has(p));
        if (from.length && !ON.tanks[t.key].invisible) bad.push(t.label + ' (under ' + from.join('/') + ')');
        if (ON.tanks[t.key].invisible) inv.add(t.key);
    }
    assert.deepEqual(bad, [], bad.join(', '));
    assert.ok(D.tanks.filter(t => ON.tanks[t.key].invisible).length >= 6, 'expected invisible descendants');
});

test('tier 5: gated at level 60 unless ROYALE_TANKS_T5_FREE=1', () => {
    const t5 = D.tanks.filter(t => t.tier === 5);
    assert.ok(t5.length > 350, 'tier 5 count ' + t5.length);
    for (const t of t5) assert.deepEqual(ON.tanks[t.key].slots, [4], t.label + ' slots ' + ON.tanks[t.key].slots);
    for (const t of t5) assert.ok(t.key in FREE.tanks && FREE.tanks[t.key].slots.includes(3), t.label + ' not free');
    const kids = {}; for (const t of t5) for (const p of t.parents) kids[p] = (kids[p] || 0) + 1;
    assert.ok(!Object.values(kids).some(n => n > 5), 'a tier 4 tank with more than 5 tier 5 children');
});

test('engine: every tank builds a mockup and spawns, fires and ticks without error', () => {
    const r = JSON.parse(execFileSync(process.execPath, [__filename, '--spawn'], { env: { ...process.env, ROYALE_TANKS: 'expanded', ROYALE_TANKS_T5_FREE: '1' }, maxBuffer: 64 << 20, cwd: REPO }).toString());
    assert.deepEqual(r.errors.slice(0, 10), [], r.errors.length + ' errors');
    assert.equal(r.n, Object.keys(FREE.tanks).length);
    assert.ok(r.mockMax < 50, 'slowest mockup ' + r.mockSlow + ' ' + r.mockMax.toFixed(1) + ' ms');
    assert.ok(r.silent.length <= 10, r.silent.length + ' tanks fired nothing: ' + r.silent.slice(0, 20).join(', '));
    console.log('     ' + r.n + ' tanks, slowest mockup ' + r.mockSlow + ' ' + r.mockMax.toFixed(1) + ' ms, ' + r.silent.length + ' silent');
});

test('ram: ram tanks get the Smasher / Auto Smasher stat set, bot builds follow', () => {
    const r = JSON.parse(execFileSync(process.execPath, [__filename, '--ram'], { env: { ...process.env, ROYALE_TANKS: 'expanded' }, maxBuffer: 64 << 20, cwd: REPO }).toString());
    const T = r.tanks, L = r.labels;
    for (const k of [L.bumper, L.grinder, L.wrecker, 'smasher', 'autoSmasher', 'spike', 'landmine']) assert.ok(T[k] && T[k].ram, k + ' is a ram tank');
    for (const k of [L.auto3, L.booster, L.fighter, 'basic', 'twin', 'auto5', 'architect']) assert.ok(T[k] && !T[k].ram, k + ' is not a ram tank');
    assert.equal(T[L.wrecker].kind, 'ram', 'Wrecker: smasher body + thrusters only');
    assert.equal(T[L.grinder].kind, 'ramAuto', 'Grinder: smasher body + auto turrets');
    let rams = 0;
    for (const k in T) {
        const t = T[k];
        if (!t.ram) { assert.ok(!t.namesSmasher || t.label === 'Smasher', t.label + ' (gun tank) has smasher names'); continue; }
        rams++;
        assert.ok(t.namesSmasher, t.label + ' smasher stat names');
        assert.equal(t.reload, 'Engine Acceleration', t.label + ' reload name');
        assert.ok(t.accel, t.label + ' smasher hull');
        assert.deepEqual(t.caps, t.kind === 'ramAuto' ? r.autoSmasherCaps : r.genericCaps, t.label + ' caps');
        // live caps, raw order [rld, pen, str, dam, spd, ...]
        const bullet = t.live.slice(1, 5);
        if (t.kind === 'ram') assert.deepEqual(bullet, [0, 0, 0, 0], t.label + ' bullet caps ' + bullet);
        else assert.ok(bullet.every(v => v > 0), t.label + ' turret stats ' + bullet);
        assert.equal(t.build, t.kind, t.label + ' bot build');
    }
    assert.ok(rams >= 30, rams + ' ram tanks');
    // Auto Smasher itself keeps exactly what it had
    assert.deepEqual(T.autoSmasher.caps, r.autoSmasherCaps);
});

test('fresh: the generator reproduces the data file', () => {
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'gen-tanks.js'), '--check'], { cwd: REPO, stdio: 'pipe' });
});

const failed = results.filter(r => r[1]).length;
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
