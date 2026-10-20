'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const MIN = 60 * 1000;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

let SL = null;

test('life length: the longer of the server count and the client clock', () => {
    assert.equal(SL.lifeMs({ serverSecs: 700, diedAt: 0, spawnedAt: 0 }), 700000);
    assert.equal(SL.lifeMs({ serverSecs: 30, diedAt: 900000, spawnedAt: 100000 }), 800000);
    assert.equal(SL.lifeMs({ serverSecs: 0, diedAt: 100, spawnedAt: 500 }), 0, 'a spawn after the death never counts');
    assert.equal(SL.lifeMs({ serverSecs: NaN, diedAt: 5000, spawnedAt: 0 }), 0);
    assert.equal(SL.lifeMs({ serverSecs: 4, diedAt: 5000, spawnedAt: -715000 }), 720000, 'a clock backdated past page load still counts');
    assert.equal(SL.lifeMs(null), 0);
});

test('decide: guests only, and only after 10 minutes', () => {
    const T = 1e12;
    assert.equal(SL.LONG_LIFE_MS, 10 * MIN);
    assert.equal(SL.decide({ guest: true, lifeMs: 10 * MIN, now: T }, mem()), true);
    assert.equal(SL.decide({ guest: true, lifeMs: 10 * MIN - 1, now: T }, mem()), false);
    assert.equal(SL.decide({ guest: false, lifeMs: 60 * MIN, now: T }, mem()), false);
    assert.equal(SL.decide({ guest: true, blocked: true, lifeMs: 60 * MIN, now: T }, mem()), false, 'another sign-up prompt is up');
    assert.equal(SL.decide({ guest: true, lifeMs: 20 * MIN, now: T }, null), true, 'no storage still works');
});

test('decide: at most once a day', () => {
    const T = 1e12, st = mem();
    assert.equal(SL.decide({ guest: true, lifeMs: 12 * MIN, now: T }, st), true);
    SL.markShown(st, T);
    assert.equal(SL.decide({ guest: true, lifeMs: 12 * MIN, now: T + 60 * MIN }, st), false);
    assert.equal(SL.decide({ guest: true, lifeMs: 12 * MIN, now: T + SL.DAY_MS - 1 }, st), false);
    assert.equal(SL.decide({ guest: true, lifeMs: 12 * MIN, now: T + SL.DAY_MS }, st), true);
});

test('decide: two "Not now" presses stop it for good', () => {
    const T = 1e12, st = mem();
    assert.equal(SL.notNow(st), 1);
    assert.equal(SL.decide({ guest: true, lifeMs: 30 * MIN, now: T }, st), true);
    assert.equal(SL.notNow(st), 2);
    assert.equal(SL.decide({ guest: true, lifeMs: 30 * MIN, now: T + 30 * SL.DAY_MS }, st), false);
    assert.equal(SL.notNow(null), 0);
});

test('storage that throws never breaks it', () => {
    const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(SL.decide({ guest: true, lifeMs: 15 * MIN, now: 1e12 }, bad), true);
    SL.markShown(bad, 1e12);
    assert.equal(SL.notNow(bad), 1);
});

test('text: neat and friendly, with how long the run was', () => {
    assert.equal(SL.TITLE, 'That was a great run!');
    assert.equal(SL.lastedText(10 * MIN), '10 minutes');
    assert.equal(SL.lastedText(10 * MIN + 59999), '10 minutes');
    assert.equal(SL.lastedText(60 * MIN), '1 hour');
    assert.equal(SL.lastedText(61 * MIN), '1 hour and 1 minute');
    assert.equal(SL.lastedText(135 * MIN), '2 hours and 15 minutes');
    const b = SL.body(12 * MIN + 30000);
    assert.equal(b, 'You lasted 12 minutes. Make an account to keep your gemdust, rank and unlocks.');
    for (const s of [SL.TITLE, SL.HEADLINE, b]) {
        assert.ok(!/[\u2013\u2014]/.test(s), 'no dashes: ' + s);
        assert.match(s, /^[A-Z]/, 'starts with a capital: ' + s);
    }
});

test('wiring: the death card drives it, it sits above the card, the other prompts give way', () => {
    const app = read('public', 'client', 'app.js');
    assert.match(app, /import \* as signupPrompt from '\.\/signupPrompt\.js';/);
    assert.match(app, /longLifeUp = signupPrompt\.update\(deadShow\)/);
    assert.match(app, /!longLifeUp && !!sc/, 'the create-account button hides while the long-life card is up');
    assert.match(app, /raidFinale\.active\(\)\) \{[\s\S]{0,400}signupPrompt\.update\(false\)/, 'never over the raid results');
    const sp = read('public', 'client', 'signupPrompt.js');
    assert.match(sp, /keepNudge\.wanted\(\)/, 'the raid results card wins');
    assert.match(sp, /Keep my stuff/);
    assert.match(sp, /Not now/);
    assert.match(sp, /openSignup\(/, 'the one-tap sign-up sheet');
    assert.match(sp, /deathCardFrac/);
    const css = read('public', 'ingame.css');
    assert.match(css, /#dwLongLife \{[\s\S]*?transform: translate\(-50%, -100%\)/, 'its bottom edge sits on the top value');
    const build = read('scripts', 'build-client.js');
    const hot = build.slice(build.indexOf('const HOT'), build.indexOf(']);', build.indexOf('const HOT')));
    assert.ok(hot.indexOf('"client/signupPrompt.js"') > 0 && hot.indexOf('"client/signupPrompt.js"') < hot.indexOf('"client/funnel.js"'), 'in HOT before funnel.js');
    for (const f of [['public', 'client', 'signupPrompt.js'], ['public', 'client', 'signupPromptLogic.js']]) {
        const src = read(...f);
        assert.ok(!/\/\/|\/\*/.test(src.replace(/https?:\/\//g, '')), f.join('/') + ' has no comments');
    }
});

async function headless() {
    if (process.env.SKIP_HEADLESS === '1') return 'skipped (SKIP_HEADLESS=1)';
    const H = require('./headlessGame.js');
    const why = H.available();
    if (why) return 'skipped: ' + why;
    const { sleep } = H;
    const g = await H.start({ port: 4900 });
    const { page, origin } = g;
    const state = () => page.eval(`(() => { const e = document.getElementById('dwLongLife'); const f = window.royaleState().deathCardFrac; const a = document.getElementById('royaleDomPlayAgain'); const s = document.getElementById('royaleDomSignup');
        const r = e && e.classList.contains('open') ? e.getBoundingClientRect() : null; const ar = a && a.style.display !== 'none' ? a.getBoundingClientRect() : null;
        return { open: !!r, rect: r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, cardTop: f ? f.y * innerHeight : null, again: ar && { top: ar.top, bottom: ar.bottom },
            text: e ? e.innerText : '', signupShown: !!(s && s.style.display !== 'none'), no: localStorage.getItem('dwLongLifeNo'), at: localStorage.getItem('dwLongLifeAskAt'), died: !!window.royaleState().died }; })()`);
    const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(250); } return v; };
    const die = async () => {
        let ok = false;
        for (let i = 0; i < 12 && !ok; i++) {
            await page.eval(`window.royaleTalk('DBG', 'kill'), true`);
            ok = await waitFor(async () => (await state()).died, 1500);
        }
        assert.ok(ok, 'DBG kill did not take');
        await sleep(1200);
    };
    const respawn = async () => {
        await sleep(3500);
        await page.eval(`(() => { const a = document.getElementById('royaleDomPlayAgain'); if (a) a.click(); return 1; })()`);
        const ok = await waitFor(async () => !(await state()).died && await page.eval('window.dwPlaying()'), 20000);
        assert.ok(ok, 'never respawned');
        await sleep(2500);
    };
    try {
        await H.play(page, origin);
        await sleep(3000);
        await page.eval(`window.dwLongLife.backdate(11 * 60 * 1000), true`);
        await die();
        const s1 = await waitFor(async () => { const s = await state(); return s.open && s.cardTop ? s : null; }, 8000) || await state();
        assert.ok(s1.open, 'the prompt shows after an 11 minute life: ' + JSON.stringify(s1));
        assert.match(s1.text, /That was a great run!/);
        assert.match(s1.text, /You lasted 11 minutes\./);
        assert.match(s1.text, /Keep my stuff/);
        assert.match(s1.text, /Not now/);
        assert.ok(s1.rect.bottom <= s1.cardTop + 1, 'above the card: ' + JSON.stringify(s1));
        assert.ok(!s1.again || s1.rect.bottom <= s1.again.top, 'clear of Respawn');
        assert.equal(s1.signupShown, false, 'one sign-up prompt at a time');
        assert.ok(+s1.at > 0, 'the day is marked');
        await page.eval(`document.querySelector('#dwLongLife .ll-no').click(), true`);
        await sleep(300);
        const s2 = await state();
        assert.equal(s2.open, false, '"Not now" closes it');
        assert.equal(s2.no, '1');
        await respawn();
        await die();
        const s3 = await state();
        assert.equal(s3.open, false, 'a short life never asks');
        await respawn();
        await page.eval(`window.dwLongLife.backdate(15 * 60 * 1000), true`);
        await die();
        const s4 = await state();
        assert.equal(s4.open, false, 'once a day only');
        await page.eval(`localStorage.setItem('dwLongLifeAskAt', String(Date.now() - 25 * 3600 * 1000)), true`);
        await respawn();
        await page.eval(`window.dwLongLife.backdate(15 * 60 * 1000), true`);
        await die();
        const s5 = await waitFor(async () => { const s = await state(); return s.open ? s : null; }, 6000) || await state();
        assert.equal(s5.open, true, 'a day later it asks again');
        await page.eval(`document.querySelector('#dwLongLife .ll-no').click(), true`);
        await respawn();
        await page.eval(`localStorage.setItem('dwLongLifeAskAt', String(Date.now() - 25 * 3600 * 1000)), true`);
        await page.eval(`window.dwLongLife.backdate(15 * 60 * 1000), true`);
        await die();
        const s6 = await state();
        assert.equal(s6.open, false, 'two "Not now" presses stop it');
        assert.equal(s6.no, '2');
        const errs = page.errors.filter(e => !/favicon|ERR_|net::/i.test(e));
        assert.deepEqual(errs, [], 'page errors');
        return 'shown, dismissed, capped';
    } finally {
        await g.stop();
    }
}

async function main() {
    SL = await import(require('url').pathToFileURL(path.join(REPO, 'public', 'client', 'signupPromptLogic.js')).href);
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')); }
    }
    try { const note = await headless(); console.log('ok   headless: guest dies after a long life' + (note ? ' (' + note + ')' : '')); }
    catch (e) { failed++; console.log('FAIL headless: guest dies after a long life\n     ' + String((e && e.stack) || e).split('\n').slice(0, 8).join('\n     ')); }
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
