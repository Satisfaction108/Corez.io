// Duel sanity for the generated tanks (scripts/gen-tanks.js), engine-only (duel.js)
//   node scripts/tanks/sanity.js gamma|turrets|pass <dir>   write <dir>/plan.json
//   node scripts/tanks/sanity.js run <dir> [--from n --count n] play it into <dir>/duels.jsonl
//   node scripts/tanks/sanity.js fit-gamma|fit-turrets|check <dir>
// Run duels only through `nice -n 20`, a few hundred at a time (8 GB machine).
// gamma: how much a 30% damage edge moves the win odds (the duel's own sensitivity)
// turrets: turret tanks vs their parents and turret-less siblings, refits the turret value
// pass: every new tank vs its primary parent and two siblings; check writes duelSanity.json
//       (a damage factor per design, inside a band; what stays out of it is flagged)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server');
const [cmd, dir] = process.argv.slice(2);
const arg = (k, d) => process.argv.includes(k) ? +process.argv[process.argv.indexOf(k) + 1] : d;
const OUT = path.join(__dirname, 'duelSanity.json');
const CALF = path.join(__dirname, 'calibration.json');
const DATA = path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js');
const plan = () => JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));

// ---- run: duel.js with the expanded (balanced) tree, plus damage probes
if (cmd === 'run') {
    const p = plan(), from = arg('--from', 0), count = arg('--count', p.duels.length);
    process.argv = [process.argv[0], path.join(__dirname, 'duel.js'), path.join(dir, 'plan.json'), path.join(dir, 'duels.jsonl')];
    const { duel } = require('./duel.js');
    const copy = x => JSON.parse(JSON.stringify(x));
    const B = require('./budget.js');
    for (const [key, base, k] of p.probes || []) {
        const guns = copy(B.get(Class[base], 'GUNS') || []).map(g => { const ss = g.PROPERTIES && g.PROPERTIES.SHOOT_SETTINGS; if (ss) ss.damage *= k; return g; });
        Class[key] = { PARENT: base, GUNS: guns };
    }
    const out = path.join(dir, 'duels.jsonl'), t0 = Date.now();
    const list = p.duels.slice(from, from + count);
    for (const [a, b, sd] of list) {
        let r;
        try { r = duel(a, b, sd); } catch (e) { r = { a, b, seed: sd, error: String(e.message).slice(0, 200) }; for (const x of [...entities.values()]) { try { x.kill(); } catch { /* */ } } }
        fs.appendFileSync(out, JSON.stringify(r) + '\n');
    }
    process.stdout.write(list.length + ' duels in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s\n', () => process.exit(0));
    return;
}

// ---- everything else: today's tree plus the raw (unbalanced) new designs
process.env.ROYALE_TANKS = 'classic';
{
    const log = console.log; console.log = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = log; }
}
const B = require('./budget.js');
const N = require('./neat.js');
const D = require(DATA);
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
for (const t of D.tanks) Class[t.key] = JSON.parse(JSON.stringify(t.def));
const byKey = Object.fromEntries(D.tanks.map(t => [t.key, t]));
const tier = { basic: 1 };
{ const q = ['basic']; while (q.length) { const k = q.shift(); for (let t = 1; t <= 4; t++) for (const u of arr(Class[k]['UPGRADES_TIER_' + t])) if (typeof u === 'string' && !(u in tier)) { tier[u] = t + 1; q.push(u); } } }
for (const t of D.tanks) tier[t.key] = t.tier;
const flat = {}; const fl = k => flat[k] || (flat[k] = B.flatten(k));
const label = k => (byKey[k] && byKey[k].label) || (Class[k] && Class[k].LABEL) || k;
// the duel arena has no food: the Necromancer line (chips from squares) cannot be measured
const needsFood = k => fl(k).guns.some(x => x.typed && /chip|necro/i.test(x.type || ''));
let seed = 11;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const designHash = d => crypto.createHash('sha1').update(JSON.stringify([d.PARENT, d.GUNS, d.TURRETS, d.SHAPE || 0, d.MAX_CHILDREN || 0])).digest('hex').slice(0, 12);
const liveTurrets = k => fl(k).turrets.filter(t => !t.prop && N.armed(t)).length;
const readRows = () => { const seen = new Set(); return fs.readFileSync(path.join(dir, 'duels.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r => !r.error && !seen.has(r.a + '|' + r.b + '|' + r.seed) && seen.add(r.a + '|' + r.b + '|' + r.seed)); };
const writePlan = (duels, probes = []) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ env: { ROYALE_TANKS: 'expanded', ROYALE_TANKS_T5_FREE: '1' }, probes, duels }));
    console.log(duels.length + ' duels ->', path.join(dir, 'plan.json'));
};
const both = (out, a, b, s) => { out.push([a, b, s], [b, a, s]); };
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { k: {} };
const sib = {}; for (const t of D.tanks) for (const p of t.parents) (sib[p + ':' + t.tier] = sib[p + ':' + t.tier] || []).push(t.key);
const logit = p => Math.log(p / (1 - p));

if (cmd === 'gamma') {
    const pool = D.tanks.filter(t => t.tier >= 4 && !liveTurrets(t.key) && !needsFood(t.key) && !fl(t.key).smasher);
    const pickN = [...pool].sort(() => rnd() - 0.5).slice(0, 24);
    const duels = [], probes = []; let s = 1;
    for (const t of pickN) { const pk = 'probe_' + t.key; probes.push([pk, t.key, 1.3]); for (let i = 0; i < 2; i++) both(duels, pk, t.key, s++); }
    writePlan(duels, probes);
    process.exit(0);
}
if (cmd === 'fit-gamma') {
    const rows = readRows(); let w = 0;
    for (const r of rows) w += r.a.startsWith('probe_') ? r.win : 1 - r.win;
    const rate = (w + 1) / (rows.length + 2), gamma = logit(rate) / Math.log(1.3);
    console.log('probe win rate', (w / rows.length).toFixed(3), 'over', rows.length, '-> gamma', gamma.toFixed(2));
    const cal = JSON.parse(fs.readFileSync(CALF, 'utf8'));
    cal.duelGamma = { probe: 1.3, duels: rows.length, winRate: +(w / rows.length).toFixed(3), gamma: +gamma.toFixed(3) };
    fs.writeFileSync(CALF, JSON.stringify(cal, null, 2) + '\n');
    process.exit(0);
}
if (cmd === 'turrets') {
    const duels = []; let s = 1;
    for (const t of D.tanks) {
        if (t.tier < 3 || !liveTurrets(t.key) || needsFood(t.key)) continue;
        const p = t.parents[0];
        if (liveTurrets(p) !== liveTurrets(t.key) && !needsFood(p)) both(duels, t.key, p, s++);
        const bare = (sib[p + ':' + t.tier] || []).filter(o => o !== t.key && !liveTurrets(o) && !needsFood(o));
        if (bare.length) both(duels, t.key, bare[Math.floor(rnd() * bare.length)], s++);
    }
    writePlan(duels);
    process.exit(0);
}
if (cmd === 'fit-turrets') {
    const cal = JSON.parse(fs.readFileSync(CALF, 'utf8'));
    const gamma = cal.duelGamma.gamma, c0 = { ...D.constants }; delete c0.ram;
    B.setRamK(D.constants.ram);
    const rows = readRows(), keys = [...new Set(rows.flatMap(r => [r.a, r.b]))];
    const lnP = c => { B.setConstants(c); const o = {}; for (const k of keys) { const p = B.power(fl(k)); o[k] = byKey[k] ? Math.log(D.balance[k][2]) + Math.log(p.O) : Math.log(p.P); } return o; };
    B.setConstants(c0); const base = {}; for (const k of keys) base[k] = byKey[k] ? Math.log(B.power(fl(k)).O) : 0;
    // the budget's own errors blur a duel: fit the slope with the turret value, then keep the value
    // children of every kind tend to lose to their parents in a duel (the pass below fixes
    // that per tank): a child-vs-parent offset is fitted with them so it does not land on turrets
    const pp = r => (byKey[r.a] && byKey[r.a].parents[0] === r.b) ? 1 : (byKey[r.b] && byKey[r.b].parents[0] === r.a) ? -1 : 0;
    const cache = new Map(), lpOf = x => { if (!cache.has(x)) cache.set(x, lnP({ ...c0, turret: x })); return cache.get(x); };
    let bA = 0;
    const loss = (x, g, al = bA) => { const lp = lpOf(x); let dev = 0; for (const r of rows) { const d = (lp[r.a] - base[r.a]) - (lp[r.b] - base[r.b]); const q = Math.min(1 - 1e-6, Math.max(1e-6, 1 / (1 + Math.exp(-(g * d + al * pp(r)))))); dev -= r.win * Math.log(q) + (1 - r.win) * Math.log(1 - q); } return dev / rows.length; };
    let best = c0.turret, bg = gamma, bl = Infinity;
    for (const g of [0.5, 1, 1.5, 2, 3, 4, 6, 8, 10]) for (let x = 0.2; x <= 4.0001; x += 0.05) for (let al = -2; al <= 1.0001; al += 0.1) { const l = loss(x, g, al); if (l < bl) { bl = l; best = +x.toFixed(2); bg = g; bA = +al.toFixed(2); } }
    console.log('child-vs-parent offset', bA, 'profile', [0.324, 0.6, 1, 1.5, 2, 2.5, 3, 4].map(x => x + ':' + loss(x, bg).toFixed(4)).join(' '));
    console.log('fitted slope', bg, 'deviance at the old value with that slope', loss(c0.turret, bg).toFixed(4));
    // today's tree (calibrate.js duels, raw tanks) pulls the other way: pure turret tanks
    // (Auto-3, Auto-5) duel poorly. --old <calibration duels.jsonl>: the value both agree on
    const oldFile = process.argv.includes('--old') ? process.argv[process.argv.indexOf('--old') + 1] : null;
    let joint = null;
    if (oldFile) {
        const orows = fs.readFileSync(oldFile, 'utf8').trim().split('\n').map(JSON.parse).filter(r => !r.error && r.a !== r.b && Class[r.a] && Class[r.b]);
        const ok = [...new Set(orows.flatMap(r => [r.a, r.b]))];
        const odev = x => { B.setConstants({ ...cal.constants, turret: x }); const lp = {}; for (const k of ok) lp[k] = Math.log(Math.max(1e-9, B.power(fl(k)).P)); let b = Infinity;
            for (const beta of [0.5, 0.75, 1, 1.25, 1.5]) { let d = 0; for (const r of orows) { const q = Math.min(1 - 1e-6, Math.max(1e-6, 1 / (1 + Math.exp(-beta * (lp[r.a] - lp[r.b]))))); d -= r.win * Math.log(q) + (1 - r.win) * Math.log(1 - q); } b = Math.min(b, d); } return b; };
        let bx = null, bt = Infinity;
        for (let x = 0.3; x <= 3.0001; x += 0.1) { const tot = odev(x) + loss(x, bg) * rows.length; if (tot < bt) { bt = tot; bx = +x.toFixed(2); } }
        joint = { oldDuels: orows.length, value: bx };
        console.log('joint with', orows.length, 'duels of today\'s tree:', bx);
        best = bx; bl = loss(bx, bg);
    }
    const tw = rows.filter(r => liveTurrets(r.a) > liveTurrets(r.b)).reduce((s, r) => s + r.win, 0) + rows.filter(r => liveTurrets(r.b) > liveTurrets(r.a)).reduce((s, r) => s + 1 - r.win, 0);
    const tn = rows.filter(r => liveTurrets(r.a) !== liveTurrets(r.b)).length;
    console.log('duels', rows.length, 'more-turret side won', (tw / tn).toFixed(3), 'turret', c0.turret, '->', best, 'deviance', loss(c0.turret, gamma).toFixed(4), '->', bl.toFixed(4));
    cal.turretRefit = { from: c0.turret, to: best, duels: rows.length, moreTurretsWon: +(tw / tn).toFixed(3), deviance: [+loss(c0.turret, bg).toFixed(4), +bl.toFixed(4)], slope: bg, childOffset: bA, joint };
    cal.constants.turret = best;
    fs.writeFileSync(CALF, JSON.stringify(cal, null, 2) + '\n');
    process.exit(0);
}
// ---- the parent / sibling pass
const measurable = k => !needsFood(k) && tier[k] >= 2;
function passPairs(only) {
    const par = [], sibs = new Set();
    for (const t of D.tanks) {
        if (t.tier < 3 || !measurable(t.key) || (only && !only.has(t.key))) continue;
        if (measurable(t.parents[0])) par.push([t.key, t.parents[0]]);
        const L = [...new Set(t.parents.flatMap(p => sib[p + ':' + t.tier] || []))].filter(o => o !== t.key && measurable(o)).sort();
        const i = L.findIndex(o => o > t.key);
        for (const o of [L[(i < 0 ? 0 : i) % L.length], L[((i < 0 ? 0 : i) + 1) % L.length]]) if (o && o !== t.key) sibs.add([t.key, o].sort().join('|'));
    }
    return { par, sibs: [...sibs].map(x => x.split('|')) };
}
if (cmd === 'pass') {
    // --changed: only the designs the last check moved or flagged (and their siblings' pairs)
    const only = process.argv.includes('--changed') ? new Set(D.tanks.filter(t => (prev.k[designHash(t.def)] || 1) !== 1 || (prev.flagged || []).includes(t.label) || !(prev.results || {})[designHash(t.def)]).map(t => t.key)) : null;
    const { par, sibs } = passPairs(only); const duels = []; let s = 1;
    for (const [a, p] of par) for (let i = 0; i < 2; i++) both(duels, a, p, s++);
    for (const [a, b] of sibs) both(duels, a, b, s++);
    writePlan(duels);
    process.exit(0);
}
if (cmd === 'check') {
    const cal = JSON.parse(fs.readFileSync(CALF, 'utf8')), gamma = cal.duelGamma.effective || cal.duelGamma.gamma;
    const rows = readRows(), st = {};
    const add = (k, kind, w) => { const s = st[k] = st[k] || { p: [0, 0], s: [0, 0], pairs: {} }; s[kind][0] += w; s[kind][1]++; };
    for (const r of rows) {
        const A = byKey[r.a], Bt = byKey[r.b];
        if (A && A.parents[0] === r.b) add(r.a, 'p', r.win);
        else if (Bt && Bt.parents[0] === r.a) add(r.b, 'p', 1 - r.win);
        else if (A && Bt) { add(r.a, 's', r.win); add(r.b, 's', 1 - r.win); for (const [x, y, w] of [[r.a, r.b, r.win], [r.b, r.a, 1 - r.win]]) { const q = st[x].pairs[y] = st[x].pairs[y] || [0, 0]; q[0] += w; q[1]++; } }
    }
    // the latest measurement of each design (an earlier round's stays for designs not re-run)
    const K = { ...prev.k }, R = { ...(prev.results || {}) }, LO = 0.7, HI = 1.35, moved = [];
    const live = new Map(D.tanks.map(t => [designHash(t.def), t]));
    for (const [k, s] of Object.entries(st)) {
        const t = byKey[k], h = designHash(t.def), rp = s.p[1] ? s.p[0] / s.p[1] : null, rs = s.s[1] ? s.s[0] / s.s[1] : null;
        // only a sibling's opponent this round (a few duels): keep its earlier, fuller measurement
        if (!s.p[1] && R[h] && measurable(t.parents[0])) continue;
        // a child should win about 50-65% against its parent (aim 0.575), siblings about even;
        // a handful of duels is noisy: shrink toward the aim, move only on a clear miss, and
        // at most 20% a round (the band holds the total)
        const np = s.p[1], ns = s.s[1], n = np + ns;
        const ep = np ? logit((s.p[0] + 2 * 0.575) / (np + 2)) - logit(0.575) : 0, es = ns ? logit((s.s[0] + 1) / (ns + 2)) : 0;
        const e = n ? (np * ep + ns * es) / n : 0;
        let kk = K[h] || 1;
        if (Math.abs(e) > 0.4) {
            const step = Math.min(0.2, Math.max(-0.2, -e / gamma * n / (n + 6)));
            const nk = Math.min(HI, Math.max(LO, kk * Math.exp(step)));
            if (Math.abs(nk / kk - 1) > 0.01) { moved.push(t.label); kk = +nk.toFixed(3); }
        }
        if (kk !== 1) K[h] = kk; else delete K[h];
        const dom = Object.entries(s.pairs).filter(([, [w, n]]) => n >= 2 && w / n > 0.7).map(([o]) => label(o));
        // measured at the factor it had then (kk is what the next build uses)
        R[h] = [rp == null ? null : +rp.toFixed(3), rs == null ? null : +rs.toFixed(3), np, ns, rs != null && rs > 0.7 ? dom.slice(0, 3) : []];
    }
    for (const h of Object.keys(R)) if (!live.has(h)) delete R[h];
    for (const h of Object.keys(K)) if (!live.has(h)) delete K[h];
    const rows2 = [...live].filter(([h]) => R[h]).map(([h, t]) => ({ label: t.label, tier: t.tier, rp: R[h][0], rs: R[h][1], np: R[h][2], ns: R[h][3], k: K[h] || 1, dom: R[h][4] }));
    // clearly: lost every duel to its parent, or beat (lost to) its siblings in 80% of 4+ duels
    const bad = r => (r.rp === 0 && r.np >= 4) || (r.rs != null && r.ns >= 4 && (r.rs >= 0.8 || r.rs <= 0.2));
    const flagged = rows2.filter(bad).map(r => r.label);
    const mean = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null;
    const out = { generated: 'scripts/tanks/sanity.js check', round: (prev.round || 0) + 1, gamma, duels: rows.length + (prev.duels || 0), band: [LO, HI],
        rule: 'aim: child beats its primary parent 0.575, siblings even; factors move on a clear miss (shrunk logit off by 0.4+), 20% a round at most; flagged: lost every duel to its parent, or 80%+ (20%-) against its siblings',
        summary: { tanks: rows2.length, unmeasured: D.tanks.length - rows2.length, meanVsParent: mean(rows2.filter(r => r.rp != null).map(r => r.rp)),
            childLosesClearly: rows2.filter(r => r.rp === 0 && r.np >= 4).length, siblingDominates: rows2.filter(r => r.rs != null && r.ns >= 4 && r.rs >= 0.8).length,
            movedThisRound: moved.length, adjusted: Object.keys(K).length, atBandEdge: Object.values(K).filter(v => v <= LO || v >= HI).length },
        flagged, k: Object.fromEntries(Object.entries(K).sort()), results: Object.fromEntries(Object.entries(R).sort()) };
    fs.writeFileSync(OUT, JSON.stringify(out) .replace(/,"(k|results|flagged|summary)":/g, ',\n"$1":') + '\n');
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rows2, null, 1));
    console.log(JSON.stringify(out.summary), 'flagged', flagged.length + ':', flagged.slice(0, 40).join(', '));
    process.exit(0);
}
console.log('usage: sanity.js gamma|turrets|pass|run|fit-gamma|fit-turrets|check <dir>');
