// Fits the power budget (budget.js) to measured duel results (duel.js)
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const [cmd, dir, extra] = process.argv.slice(2);
const OUT = path.join(__dirname, 'calibration.json');
process.env.ROYALE_TANKS = 'classic';   // fitted on today's tree
{
    const log = console.log; console.log = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = log; }
}
const B = require('./budget.js');
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
let seed = 7;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const tier = { basic: 1 }; { const q = ['basic']; while (q.length) { const k = q.shift(); for (let t = 1; t <= 4; t++) for (const u of arr(Class[k]['UPGRADES_TIER_' + t])) if (typeof u === 'string' && !(u in tier)) { tier[u] = t + 1; q.push(u); } } }
const flat = {}; for (const k in tier) flat[k] = B.flatten(k);
// necromancer chips are made from squares, and an open arena has none
const needsFood = k => flat[k].guns.some(x => x.typed && /chip/i.test(x.type || ''));
const sample = k => tier[k] >= 2 && tier[k] <= 4 && !flat[k].smasher && k !== 'desmos' && !needsFood(k);

if (cmd === 'plan') {
    fs.mkdirSync(dir, { recursive: true });
    const duels = [], pairs = new Set();
    for (const t of [2, 3, 4]) {
        const L = Object.keys(tier).filter(k => tier[k] === t && sample(k));
        const per = Math.min(L.length - 1, 8);
        for (const a of L) {
            const others = L.filter(b => b !== a).sort(() => rnd() - 0.5);
            let n = [...pairs].filter(p => p.split('|').includes(a)).length;
            for (const b of others) { if (n >= per) break; const key = [a, b].sort().join('|'); if (pairs.has(key)) continue; pairs.add(key); n++; }
        }
    }
    let s = 1;
    for (const p of pairs) { const [a, b] = p.split('|'); for (let i = 0; i < 2; i++) { duels.push([a, b, s]); duels.push([b, a, s]); s++; } }
    for (let i = 0; i < 20; i++) duels.push(['basic', 'basic', 1000 + i]);   // control: a mirror match is a coin flip
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ env: {}, duels }));
    console.log(pairs.size + ' pairs, ' + duels.length + ' duels ->', path.join(dir, 'plan.json'));
    process.exit(0);
}
const read = f => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r => !r.error);
if (cmd === 'fit') {
    const all = read(path.join(dir, 'duels.jsonl'));
    const ctrl = all.filter(r => r.a === 'basic' && r.b === 'basic');
    const rows = all.filter(r => r.a !== r.b && sample(r.a) && sample(r.b));
    const keys = [...new Set(rows.flatMap(r => [r.a, r.b]))];
    const PRIOR = { ...B.C };
    const BOUNDS = { hExp: [0.25, 1], pExp: [0.25, 1], trap: [0.3, 1.3], swarm: [0.4, 1.3], drone: [0.15, 1], minion: [0.15, 1], side: [0.05, 0.6], turret: [0.3, 1.3], rateExp: [0.6, 1.4], reachExp: [0, 0.6] };
    const LAMBDA = 1.5;
    function loss(c, beta) {
        B.setConstants(c);
        const lp = {}; for (const k of keys) lp[k] = Math.log(Math.max(1e-9, B.power(flat[k]).P));
        let dev = 0;
        for (const r of rows) {
            const p = 1 / (1 + Math.exp(-beta * (lp[r.a] - lp[r.b]))), q = Math.min(1 - 1e-6, Math.max(1e-6, p));
            dev -= r.win * Math.log(q) + (1 - r.win) * Math.log(1 - q);
        }
        let reg = 0; for (const k in BOUNDS) reg += Math.pow(Math.log(c[k] + 0.05) - Math.log(PRIOR[k] + 0.05), 2);
        return { dev, tot: dev + LAMBDA * reg };
    }
    const bestBeta = c => { let b = 1, best = null; for (const x of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6]) { const l = loss(c, x).tot; if (!best || l < best) { best = l; b = x; } }
        for (let step = b / 4; step > 0.01; step /= 2) for (const x of [b - step, b + step]) if (x > 0) { const l = loss(c, x).tot; if (l < best) { best = l; b = x; } } return b; };
    let c = { ...PRIOR }, beta = bestBeta(c);
    const before = { ...loss(c, beta), beta };
    for (let round = 0; round < 5; round++) {
        for (const k of Object.keys(BOUNDS)) {
            const [lo, hi] = BOUNDS[k]; let bestV = c[k], bestL = loss(c, beta).tot;
            const span = (hi - lo) / Math.pow(2, round);
            for (let i = 0; i <= 8; i++) { const v = Math.min(hi, Math.max(lo, bestV - span / 2 + span * i / 8)); const l = loss({ ...c, [k]: v }, beta).tot; if (l < bestL - 1e-9) { bestL = l; bestV = v; } }
            c[k] = +bestV.toFixed(3);
        }
        beta = bestBeta(c);
    }
    const after = { ...loss(c, beta), beta };
    // how well each set predicts the winner
    const acc = cc => { B.setConstants(cc); const lp = {}; for (const k of keys) lp[k] = Math.log(B.power(flat[k]).P); let ok = 0, n = 0; for (const r of rows) { if (r.win === 0.5) continue; n++; if ((lp[r.a] > lp[r.b]) === (r.win === 1)) ok++; } return +(ok / n).toFixed(3); };
    const out = { generated: 'scripts/tanks/calibrate.js fit', duels: rows.length, tanks: keys.length, control: { n: ctrl.length, winA: +(ctrl.reduce((s, r) => s + r.win, 0) / Math.max(1, ctrl.length)).toFixed(3) },
        prior: PRIOR, constants: c, beta: +beta.toFixed(3),
        deviancePerDuel: { prior: +(before.dev / rows.length).toFixed(4), fitted: +(after.dev / rows.length).toFixed(4), coinFlip: +Math.log(2).toFixed(4) },
        accuracy: { prior: acc(PRIOR), fitted: acc(c) } };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
}
if (cmd === 'check') {
    // a validation run (balanced tanks): per-tank win rate spread
    const rows = read(extra || path.join(dir, 'validate.jsonl'));
    const w = {}; for (const r of rows) { for (const [k, x] of [[r.a, r.win], [r.b, 1 - r.win]]) { (w[k] = w[k] || [0, 0]); w[k][0] += x; w[k][1]++; } }
    const rates = Object.entries(w).map(([k, [s, n]]) => [k, s / n, n]).sort((a, b) => a[1] - b[1]);
    const sd = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); };
    console.log('duels', rows.length, 'tanks', rates.length, 'win-rate sd', sd(rates.map(r => r[1])).toFixed(3));
    console.log('lowest', rates.slice(0, 6).map(r => r[0] + ' ' + r[1].toFixed(2)).join(', '));
    console.log('highest', rates.slice(-6).map(r => r[0] + ' ' + r[1].toFixed(2)).join(', '));
    process.exit(0);
}
console.log('usage: calibrate.js plan|fit|check <dir>');
