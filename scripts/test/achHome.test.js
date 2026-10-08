// The home-screen achievement moment's rules: node scripts/test/achHome.test.js
// (public/client/achHomeLogic.js: what waits, played once, folding, words;
// and that the ACH packet path and the menu return are wired to it)
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const ach = (id, rewardMilli, extra) => Object.assign({ id, name: 'Name ' + id, icon: 'star', color: '#fff', rewardMilli, item: '', guest: 0 }, extra || {});

(async () => {
    const L = await import(path.join(ROOT, 'public', 'client', 'achHomeLogic.js'));
    const tests = [];
    const test = (n, f) => tests.push([n, f]);

    test('note + take: each achievement plays once, in order', () => {
        const st = mem();
        assert.equal(L.note(st, ach('a', 1500)), true);
        assert.equal(L.note(st, ach('b', 2500)), true);
        assert.equal(L.note(st, ach('a', 1500)), false, 'already waiting');
        assert.equal(L.waiting(st), 2);
        const got = L.take(st);
        assert.deepEqual(got.map((d) => d.id), ['a', 'b']);
        assert.equal(got[0].rewardMilli, 1500);
        assert.equal(L.waiting(st), 0);
        assert.deepEqual(L.take(st), [], 'nothing twice');
        assert.equal(L.note(st, ach('a', 1500)), false, 'played ids are not queued again');
        assert.deepEqual(L.take(st), []);
    });

    test('note: ignores junk, summaries and keeps the guest flag', () => {
        const st = mem();
        assert.equal(L.note(st, null), false);
        assert.equal(L.note(st, { name: 'x' }), false);
        assert.equal(L.note(st, { summary: 3, id: 's' }), false);
        L.note(st, ach('g', 2000, { guest: 1, item: 'ns_x', rewardMilli: -5 }));
        const [d] = L.take(st);
        assert.equal(d.guest, 1);
        assert.equal(d.item, 1);
        assert.equal(d.rewardMilli, 0, 'never negative');
    });

    test('caps: the waiting list and the played list stay bounded', () => {
        const st = mem();
        for (let i = 0; i < L.PENDING_MAX + 10; i++) L.note(st, ach('p' + i, 100));
        assert.equal(L.waiting(st), L.PENDING_MAX);
        const got = L.take(st);
        assert.equal(got[got.length - 1].id, 'p' + (L.PENDING_MAX + 9), 'the newest kept');
        for (let i = 0; i < L.SEEN_MAX + 20; i++) { L.note(st, ach('s' + i, 0)); L.take(st); }
        assert.ok(JSON.parse(st.getItem(L.SEEN_KEY)).length <= L.SEEN_MAX);
    });

    test('storage that throws (private mode) never breaks anything', () => {
        const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
        assert.doesNotThrow(() => L.note(bad, ach('x', 1)));
        assert.deepEqual(L.take(bad), []);
        assert.equal(L.waiting(null), 0);
        assert.deepEqual(L.take(null), []);
    });

    test('plan: up to five cards, the rest fold into one "+N more" with their dust', () => {
        const five = [1, 2, 3, 4, 5].map((i) => ach('c' + i, 1000));
        assert.equal(L.plan(five).length, 5);
        const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ach('c' + i, 1000));
        const p = L.plan(eight);
        assert.equal(p.length, 5);
        assert.deepEqual(p[4], { more: 4, rewardMilli: 4000 });
        assert.equal(L.totalMilli(eight), 8000);
        assert.ok(L.cardMs(1) >= 1500 && L.cardMs(1) <= 2000);
        assert.ok(L.cardMs(4) < L.cardMs(1), 'quicker when several wait');
    });

    test('words: account and guest cards, no em dashes', () => {
        let w = L.words(ach('a', 1500), false);
        assert.deepEqual(w, { label: 'Achievement completed', title: 'Name a', reward: '+1.5 gemdust', foot: '' });
        w = L.words(ach('a', 1500, { guest: 1 }), true);
        assert.equal(w.foot, 'Sign up to keep it');
        w = L.words(ach('n', 0, { item: 1 }), false);
        assert.equal(w.reward, 'New name style');
        w = L.words(ach('z', 0), true);
        assert.equal(w.foot, '', 'nothing to keep, no nag');
        w = L.words({ more: 3, rewardMilli: 2250 }, false);
        assert.equal(w.title, '+3 more achievements');
        assert.equal(w.reward, '+2.25 gemdust');
        const src = fs.readFileSync(path.join(ROOT, 'public', 'client', 'achHomeLogic.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public', 'client', 'account', 'achHome.js'), 'utf8');
        assert.ok(!src.includes('—'), 'no em dashes');
    });

    test('tick: the counter climbs from start to end as specks land', () => {
        assert.equal(L.tick(1, 3, 0, 4), 1);
        assert.equal(L.tick(1, 3, 2, 4), 2);
        assert.equal(L.tick(1, 3, 4, 4), 3);
        assert.equal(L.tick(1, 3, 9, 4), 3);
        assert.equal(L.tick(1, 3, 0, 0), 3);
    });

    test('wiring: the ACH packet notes it, the menu return plays it', () => {
        const card = fs.readFileSync(path.join(ROOT, 'public', 'client', 'achievementCard.js'), 'utf8');
        assert.match(card, /HL\.note\(window\.localStorage, d\)/);
        const main = fs.readFileSync(path.join(ROOT, 'public', 'client', 'account', 'main.js'), 'utf8');
        assert.match(main, /achMoment\(1100\)/);
        assert.match(main, /achHome\.stop\(\)/);
    });

    let failed = 0;
    for (const [n, f] of tests) {
        try { await f(); console.log('ok   ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n     ')); }
    }
    console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
