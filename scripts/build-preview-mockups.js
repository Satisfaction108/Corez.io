'use strict';

const fs = require('fs');
const path = require('path');
const { loadTree, buildMockups } = require('./build-tanks.js');

const OUT = process.env.PREVIEW_OUT || path.join(__dirname, '..', 'public', 'client', 'account', 'preview-mockups.json');
const DROP = ['upgrades', 'statnames', 'upgradeTooltip', 'upgradeName', 'upgradeColor', 'rerootUpgradeTree', 'sendAllMockups', 'displayScore', 'visibleOnBlackout', 'className'];

function slim(m) {
    if (Array.isArray(m)) return m.map(slim);
    if (!m || typeof m !== 'object') return typeof m === 'number' ? Math.round(m * 1e4) / 1e4 : m;
    const out = {};
    for (const k of Object.keys(m)) {
        if (DROP.includes(k) || m[k] === undefined) continue;
        out[k] = slim(m[k]);
    }
    return out;
}

let keyOfIndex = null;
function classOf(index) {
    if (!keyOfIndex) {
        keyOfIndex = new Map();
        for (const k of Object.keys(Class)) if (Class[k] && Class[k].index !== undefined && !keyOfIndex.has(String(Class[k].index))) keyOfIndex.set(String(Class[k].index), k);
    }
    return keyOfIndex.get(String(index));
}

function turretClasses(m, into) {
    for (const t of m.turrets || []) {
        into.set(String(t.index), classOf(t.index));
        turretClasses(t, into);
    }
    return into;
}

function addTurrets(m, mockups) {
    const want = [...turretClasses(m, new Map())].filter(([index]) => mockups[index] === undefined);
    const keys = want.map(([, k]) => k).filter(k => k && Class[k]);
    const built = buildMockups(keys);
    for (const [index, k] of want) {
        const b = built.get(k);
        if (!b || String(b.index) !== index) throw new Error('[preview] no mockup for turret ' + index + ' (' + k + ')');
        mockups[index] = slim(b);
        addTurrets(b, mockups);
    }
}

function main() {
    const t0 = Date.now();
    const T = loadTree();
    const mocks = buildMockups(T.order);
    const mockups = {}, names = {}, tanks = [], seen = new Map();
    for (const k of T.order) {
        const m = mocks.get(k);
        if (!m) continue;
        const label = String(Class[k].LABEL || m.name || k);
        const tier = T.tier.get(k);
        const look = JSON.stringify(slim(Object.assign({}, m, { index: 0, name: '', position: null })));
        const twin = seen.get(label + '|' + look);
        if (twin) { names[k] = names[twin]; continue; }
        seen.set(label + '|' + look, k);
        mockups[m.index] = slim(m);
        addTurrets(m, mockups);
        names[k] = String(m.index);
        tanks.push([k, label, tier]);
    }
    const count = new Map();
    for (const t of tanks) count.set(t[1], (count.get(t[1]) || 0) + 1);
    const nth = new Map();
    for (const t of tanks) {
        if (count.get(t[1]) < 2) continue;
        const n = (nth.get(t[1]) || 0) + 1;
        nth.set(t[1], n);
        if (n > 1) t[1] += ' ' + n;
    }
    const data = { v: 3, mockups, names, tanks };
    fs.writeFileSync(OUT, JSON.stringify(data));
    const size = fs.statSync(OUT).size;
    console.log(`[preview] ${tanks.length} tanks, ${Object.keys(mockups).length} mockups, ${(size / 1024).toFixed(0)} KB in ${path.relative(process.cwd(), OUT)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main();
process.exit(0);
