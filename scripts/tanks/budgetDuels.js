'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const REPO = path.join(__dirname, '..', '..');
const DATA = path.join(REPO, 'server', 'lib', 'definitions', 'power_budget_data.js');
const arg = (k, d) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d;
const ROUNDS = +arg('--rounds', 4);
const PER = +arg('--per', 10);
const PROCS = +arg('--procs', 2);
const REPORT = arg('--report', null);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-duels-'));

const BAND = [0.38, 0.62];
const SNEAKY_BAND = [0.3, 0.55];
const STEP = [0.6, 0.5, 0.4, 0.35, 0.3, 0.3];
const STEP_CLAMP = [0.75, 1.33];
const FIGHT_CLAMP = [0.25, 3];

const report = JSON.parse(fs.readFileSync(arg('--tanks'), 'utf8'));
const pb = require(DATA);
const tierNerf = pb.tierNerf;
const byTier = {};
for (const r of report) (byTier[r.t] = byTier[r.t] || []).push(r);
const duelS = {};
for (const r of report) duelS[r.key] = arg('--resume', null) && pb.fight[r.key] ? pb.fight[r.key] / tierNerf[r.t] : 1;

let seed = 20261029;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) | 0; return ((seed >>> 8) & 0xffffff) / 0x1000000; };

function writeData() {
    const fight = {};
    for (const r of report) {
        if (r.heal) continue;
        const v = Math.round(duelS[r.key] * tierNerf[r.t] * 10000) / 10000;
        if (Math.abs(v - 1) > 1e-4) fight[r.key] = v;
    }
    const data = { ...pb, generator: 'scripts/gen-power-budget.js + scripts/tanks/budgetDuels.js', fight };
    fs.writeFileSync(DATA, "'use strict';\nmodule.exports = " + JSON.stringify(data, null, 0).replace(/,"/g, ',\n"') + ';\n');
}

function runChunk(list, i) {
    const plan = path.join(WORK, 'plan' + i + '.json'), out = path.join(WORK, 'out' + i + '.jsonl');
    fs.writeFileSync(plan, JSON.stringify({ env: { ROYALE_TANKS: 'expanded' }, duels: list }));
    try { fs.unlinkSync(out); } catch { }
    return new Promise((res) => {
        const ch = spawn('nice', ['-n', '20', process.execPath, path.join(__dirname, 'duel.js'), plan, out], { stdio: 'ignore' });
        ch.on('exit', () => {
            let lines = [];
            try { lines = fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { }
            res(lines);
        });
    });
}

async function round(n) {
    const duels = [];
    for (const t of Object.keys(byTier)) {
        const pool = byTier[t].filter(r => !r.heal);
        if (pool.length < 3) continue;
        for (const r of pool) for (let k = 0; k < PER; k++) {
            let o = pool[Math.floor(rnd() * pool.length)];
            if (o.key === r.key) o = pool[(pool.indexOf(o) + 1) % pool.length];
            duels.push([r.key, o.key, Math.floor(rnd() * 1e9)]);
        }
    }
    const chunks = Array.from({ length: PROCS }, () => []);
    duels.forEach((d, i) => chunks[i % PROCS].push(d));
    const t0 = Date.now();
    const results = (await Promise.all(chunks.map(runChunk))).flat();
    const score = {}, games = {};
    let errors = 0;
    for (const r of results) {
        if (r.error || r.win == null) { errors++; continue; }
        score[r.a] = (score[r.a] || 0) + r.win; games[r.a] = (games[r.a] || 0) + 1;
        score[r.b] = (score[r.b] || 0) + (1 - r.win); games[r.b] = (games[r.b] || 0) + 1;
    }
    let moved = 0, out = 0;
    const step = STEP[Math.min(n, STEP.length - 1)];
    for (const r of report) {
        if (r.heal || !games[r.key]) continue;
        const wr = score[r.key] / games[r.key];
        r.wr = wr;
        const [lo, hi] = r.sneaky > 1 ? SNEAKY_BAND : BAND;
        if (wr >= lo && wr <= hi) continue;
        out++;
        const aim = wr < lo ? lo + 0.04 : hi - 0.04;
        const f = Math.min(STEP_CLAMP[1], Math.max(STEP_CLAMP[0], Math.pow(aim / Math.max(0.02, Math.min(0.98, wr)), step * 2)));
        duelS[r.key] = Math.min(FIGHT_CLAMP[1], Math.max(FIGHT_CLAMP[0], duelS[r.key] * f));
        moved++;
    }
    writeData();
    console.log(`round ${n + 1}: ${results.length} duels (${errors} errors) in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${out} outside the band, ${moved} moved`);
}

(async () => {
    writeData();
    for (let n = 0; n < ROUNDS; n++) await round(n);
    const vals = report.filter(r => !r.heal).map(r => duelS[r.key]).sort((a, b) => a - b);
    console.log(`duel factor min ${vals[0].toFixed(3)} med ${vals[vals.length >> 1].toFixed(3)} max ${vals[vals.length - 1].toFixed(3)}`);
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(report.map(r => ({ key: r.key, label: r.label, t: r.t, wr: r.wr, s: duelS[r.key] })), null, 1));
    fs.rmSync(WORK, { recursive: true, force: true });
})();
