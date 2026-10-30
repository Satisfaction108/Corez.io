'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const OUT = path.join(SERVER, 'lib', 'definitions', 'armsrace_merge_data.js');
const MAX_SLOT = 4;
const UNFINISHED = /SHOOT_SETTINGS|placeholder|does not function|not been implemented/i;
const BROKEN_IN_PLAY = [
    'spiral', 'repeater', 'coil', 'duplicator', 'oroboros', 'python', 'iterator', 'autoSpiral_AR', 'autoRepeater_AR',
    'autoDiesel_AR', 'crowbar_AR', 'autoHoncho_AR', 'autoSplitShot_AR', 'autoWidget_AR', 'autoFrother_AR', 'autoFoamer_AR',
    'megaAutoDiesel_AR', 'tripleAutoDiesel_AR', 'megaAutoHoncho_AR', 'tripleAutoHoncho_AR',
];

function dumpTree(armsRace) {
    for (const k of ['ROYALE_TANKS', 'ROYALE_TANKS_T5_FREE', 'ROYALE_ARMS_RACE']) delete process.env[k];
    const quiet = console.log, info = console.info, warn = console.warn;
    console.log = console.info = console.warn = () => {};
    try {
        require(path.join(SERVER, 'loaders', 'loader.js'));
        Config.dig_royale = true;
        Config.arms_race = armsRace;
        Config.armsrace_merge = false;
        new definitionCombiner({ groups: path.join(SERVER, 'lib', 'definitions', 'groups'), addonsFolder: path.join(SERVER, 'lib', 'definitions', 'entityAddons') }).loadDefinitions();
    } finally { console.log = quiet; console.info = info; console.warn = warn; }
    const keyOf = new Map();
    for (const k in Class) if (!keyOf.has(Class[k])) keyOf.set(Class[k], k);
    const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
    const placeholderish = (k, n = 0) => {
        const d = Class[k];
        if (!d || n > 30) return false;
        if (/placeholder/i.test(k)) return true;
        if (UNFINISHED.test(d.UPGRADE_TOOLTIP || '')) return true;
        return arr(d.PARENT).some(p => typeof p === 'string' ? placeholderish(p, n + 1) : (keyOf.has(p) && placeholderish(keyOf.get(p), n + 1)));
    };
    const tier = new Map([['basic', 1]]), edges = [], q = ['basic'];
    while (q.length) {
        const k = q.shift(), d = Class[k];
        for (let t = 1; t <= MAX_SLOT; t++) for (let e of (d && d['UPGRADES_TIER_' + t]) || []) {
            if (Array.isArray(e)) { if (e.length !== 1) continue; e = e[0]; }
            const ck = typeof e === 'string' ? e : keyOf.get(e);
            if (!ck || !Class[ck]) continue;
            edges.push([k, ck, t]);
            if (!tier.has(ck)) { tier.set(ck, t + 1); q.push(ck); }
        }
    }
    const info2 = {};
    for (const [k, t] of tier) info2[k] = { t, label: String(Class[k].LABEL || k).trim().toLowerCase(), ph: placeholderish(k) };
    return { tanks: info2, edges };
}

function measure(keys) {
    const B = require('./tanks/budget.js');
    B.setConstants(require('./tanks/calibration.json').constants);
    const out = {};
    for (const k of keys) {
        if (!Class[k]) continue;
        try {
            const p = B.power(B.flatten(k));
            if (Number.isFinite(p.O) && Number.isFinite(p.S) && p.O > 0 && p.S > 0) out[k] = { O: p.O, S: p.S, G: p.guns, R: p.ram };
        } catch (e) {}
    }
    return out;
}

if (process.argv[2] === '--dump') {
    const tree = dumpTree(process.argv[3] === 'ar');
    if (process.argv[5]) tree.power = measure(JSON.parse(fs.readFileSync(process.argv[5], 'utf8')));
    fs.writeFileSync(process.argv[4], JSON.stringify(tree));
    process.exit(0);
}

const run = (mode, keys) => {
    const file = path.join(require('os').tmpdir(), `armsrace-merge-${mode}-${process.pid}.json`);
    const args = [__filename, '--dump', mode, file];
    const keyFile = file + '.keys';
    if (keys) { fs.writeFileSync(keyFile, JSON.stringify(keys)); args.push(keyFile); }
    execFileSync(process.execPath, args, { cwd: REPO, stdio: 'ignore' });
    const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    if (keys) fs.unlinkSync(keyFile);
    return tree;
};
const X = require(path.join(SERVER, 'lib', 'definitions', 'tanks_expansion_data.js'));
const ar = run('ar');
const cur = run('cur', Object.keys(ar.tanks));
const removed = new Set([...X.removed, ...BROKEN_IN_PLAY]);

const curByLabel = new Map();
for (const [k, v] of Object.entries(cur.tanks)) if (!curByLabel.has(v.label)) curByLabel.set(v.label, k);
const inCurrent = k => !!cur.tanks[k] || curByLabel.has(ar.tanks[k].label);
const fresh = Object.keys(ar.tanks).filter(k => !inCurrent(k) && !ar.tanks[k].ph && !removed.has(k));
const freshSet = new Set(fresh);
const mapParent = k => X.removed.includes(k) ? X.root : removed.has(k) ? null : cur.tanks[k] ? k : (ar.tanks[k] && curByLabel.get(ar.tanks[k].label)) || (freshSet.has(k) ? k : null);

const tierOf = new Map(Object.entries(cur.tanks).map(([k, v]) => [k, v.t]));
const links = [];
const seen = new Set();
let pending = [...fresh];
for (let pass = 0; pass < 10 && pending.length; pass++) {
    const left = [];
    for (const k of pending) {
        let placed = false;
        for (const [p, c] of ar.edges) {
            if (c !== k) continue;
            const mp = mapParent(p);
            if (!mp || !tierOf.has(mp)) continue;
            const slot = tierOf.get(mp);
            if (slot > MAX_SLOT) continue;
            if (tierOf.has(k) && tierOf.get(k) !== slot + 1) continue;
            const id = mp + '>' + k;
            if (seen.has(id)) continue;
            seen.add(id);
            links.push([mp, k, slot]);
            if (!tierOf.has(k)) tierOf.set(k, slot + 1);
            placed = true;
        }
        if (!placed) left.push(k);
    }
    if (left.length === pending.length) { pending = left; break; }
    pending = left;
}

const arSource = fs.readFileSync(path.join(SERVER, 'lib', 'definitions', 'entityAddons', 'armsRace', 'tanks.js'), 'utf8');
const arKeyOf = label => label.charAt(0).toLowerCase() + label.slice(1).replaceAll(' ', '').replaceAll('-', '') + '_AR';
for (const m of arSource.matchAll(/quickMake\("([^"]+)", \{([^}]*)\}\)/g)) {
    const base = mapParent(m[1]);
    for (const v of m[2].matchAll(/\w+: "([^"]+)"/g)) {
        const variant = ar.tanks[arKeyOf(v[1])] ? mapParent(arKeyOf(v[1])) : curByLabel.get(v[1]);
        if (!base || !variant || !tierOf.has(base) || !tierOf.has(variant)) continue;
        const slot = tierOf.get(base);
        if (slot > MAX_SLOT || tierOf.get(variant) !== slot + 1) continue;
        const id = base + '>' + variant;
        if (seen.has(id)) continue;
        seen.add(id);
        links.push([base, variant, slot]);
    }
}

const added = [...new Set(links.filter(l => freshSet.has(l[1])).map(l => l[1]))];
const byTier = {};
for (const k of added) byTier[tierOf.get(k)] = (byTier[tierOf.get(k)] || 0) + 1;

const MIN_SCALE = 0.35, MAX_SCALE = 1.4, TOUGH = [0.82, 1.22];
const balance = {};
const unmeasured = [];
for (const k of added) {
    const p = cur.power[k], t = tierOf.get(k);
    if (!p) { unmeasured.push(k); continue; }
    const sr = p.S / X.sref[t];
    let hp = 1;
    if (sr > TOUGH[1]) hp = TOUGH[1] / sr; else if (sr < TOUGH[0]) hp = TOUGH[0] / sr;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, X.targets[t] / (p.O * p.S * hp)));
    balance[k] = [+s.toFixed(4), +hp.toFixed(4)];
}
const body = "'use strict';\nmodule.exports = " + JSON.stringify({ generator: 'scripts/gen-armsrace-merge.js', links, balance }, null, 0).replace(/\],\[/g, '],\n[').replace(/\],"/g, '],\n"') + ';\n';
fs.writeFileSync(OUT, body);
console.log(`current ${Object.keys(cur.tanks).length}, arms race ${Object.keys(ar.tanks).length}, new ${fresh.length}, placed ${added.length}, skipped ${pending.length}, total ${Object.keys(cur.tanks).length + added.length}`);
console.log('new tanks by tier', JSON.stringify(byTier));
const scales = Object.values(balance).map(b => b[0]).sort((a, b) => a - b);
console.log(`balanced ${scales.length}, unmeasured ${unmeasured.length}, damage scale min ${scales[0]} median ${scales[scales.length >> 1]} max ${scales[scales.length - 1]}, clamped low ${scales.filter(x => x === MIN_SCALE).length}, clamped high ${scales.filter(x => x === MAX_SCALE).length}`);
if (unmeasured.length) console.log('unmeasured:', unmeasured.slice(0, 20).join(', '));
if (pending.length) console.log('skipped:', pending.slice(0, 30).join(', '));
console.log('wrote', path.relative(REPO, OUT));
