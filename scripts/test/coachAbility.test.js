'use strict';
// Playtest 9: "Use your ability" sat on screen all of raid 2. The guide's
// ability step must end for good once any ability or kit item is used, stay
// gone after a new raid (a new page load), and retire on its own when ignored.
//   node scripts/test/coachAbility.test.js

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CLIENT = path.join(__dirname, '..', '..', 'public', 'client');
const imp = (f) => import(pathToFileURL(path.join(CLIENT, f)).href);
const src = (f) => fs.readFileSync(path.join(CLIENT, f), 'utf8');

function memStore() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
const allButAbility = { tutorial: 1, move: 1, mine: 1, bank: 1, upgrade: 1 };

(async () => {
    const L = await imp('coachLogic.js');
    const tests = [];
    const t = (n, f) => tests.push([n, f]);

    t('the guide is move, mine, bank and upgrade; then it is done', () => {
        const s = memStore();
        let rec = L.load(s, 1);
        assert.deepEqual(L.ORDER, ['move', 'mine', 'bank', 'upgrade']);
        assert.equal(L.nextStep(rec, () => false), 'move');
        Object.assign(rec.done, { move: 1, mine: 1, bank: 1, upgrade: 1 });
        assert.equal(L.nextStep(rec, () => false), 'final', 'no ability step after the basics');
        assert.equal(L.abilityUsed(rec, s), true);
        rec = L.load(s, 2);
        assert.equal(rec.done.ability, 1);
        assert.notEqual(L.nextStep(rec, () => false), 'ability');
    });

    t('the ability flag survives the guide record being rewritten or lost', () => {
        const s = memStore();
        const rec = L.load(s, 1);
        L.abilityUsed(rec, s);
        s.setItem(L.KEY, JSON.stringify(L.blank(5)));   // something saved a stale/blank record over it
        assert.equal(L.load(s, 6).done.ability, 1);
        s.removeItem(L.KEY);
        assert.equal(L.load(s, 7).done.ability, 1);
    });

    t('a use before the guide reached the step (kit, trial, other page) counts too', () => {
        const s = memStore();
        s.setItem(L.ABILITY_KEY, '1');   // canvas.js writes it on every ability / kit use
        const rec = L.load(s, 1);
        Object.assign(rec.done, allButAbility);
        assert.equal(L.nextStep(rec, () => false), 'final');
    });

    t('ignored, it retires: after ABILITY_NAG_MS on screen', () => {
        const s = memStore();
        const rec = L.load(s, 1);
        Object.assign(rec.done, allButAbility);
        let retired = false;
        for (let ms = 0; ms < L.ABILITY_NAG_MS + 100 && !retired; ms += 16) retired = L.abilityShown(rec, s, 16, 11);
        assert.ok(retired);
        assert.equal(L.load(s, 2).done.ability, 1);
    });

    t('ignored, it retires: shown in raid 1, a new raid starts', () => {
        const s = memStore();
        let rec = L.load(s, 1);
        Object.assign(rec.done, allButAbility);
        assert.equal(L.abilityShown(rec, s, 16, 11), false);
        L.save(s, rec);
        rec = L.load(s, 2);
        assert.equal(L.abilityShown(rec, s, 16, 12), true, 'raid 12 after raid 11: gone');
        assert.equal(L.nextStep(L.load(s, 3), () => false), 'final');
    });

    t('hidden gaps do not count as screen time', () => {
        const s = memStore();
        const rec = L.load(s, 1);
        L.abilityShown(rec, s, 60_000, 11);   // one huge dt is clamped
        assert.ok(rec.ab.ms <= 1000);
    });

    t('wiring: coach.js uses coachLogic, canvas.js writes the key on ability and kit use', () => {
        const co = src('coach.js');
        assert.match(co, /import \* as CL from "\.\/coachLogic\.js"/);
        assert.match(co, /CL\.abilityUsed\(rec, store\(\)\)/);
        assert.ok(!/case "ability"/.test(co) && !/case "tutorial"/.test(co), 'no ability or tutorial card');
        const cv = src('canvas.js');
        assert.equal((cv.match(/localStorage\.setItem\("dwAbilityUsed_v1", "1"\)/g) || []).length, 2);
        assert.equal(L.ABILITY_KEY, 'dwAbilityUsed_v1');
    });

    let fail = 0;
    for (const [n, f] of tests) {
        try { await f(); console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
    }
    console.log(fail ? fail + ' failed' : tests.length + ' passed');
    process.exit(fail ? 1 : 0);
})();
