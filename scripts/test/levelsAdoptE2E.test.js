'use strict';

const assert = require('node:assert/strict');
const HG = require('./headlessGame');
const { sleep } = HG;

const RECORD = `(() => {
  window.__lvPaint = [];
  const look = () => {
    const r = document.getElementById('lvRow');
    const t = r && !r.hidden && r.offsetParent !== null ? r.querySelector('.lv-lv') : null;
    const s = t ? t.textContent : '';
    const l = window.__lvPaint;
    if (s && l[l.length - 1] !== s) l.push(s);
  };
  setInterval(look, 4);
  const raf = () => { look(); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
})();`;

async function waitFor(page, expr, ms = 20000, step = 200) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const v = await page.eval(expr).catch(() => null);
        if (v) return v;
        await sleep(step);
    }
    return null;
}

async function main() {
    const why = HG.available();
    if (why) { console.log('skip: ' + why); return 0; }
    const PREP = `try {
  localStorage.setItem('digRoyaleTutorialDone_v1','1'); localStorage.setItem('digwarsTutorialDone_v3','1');
  localStorage.setItem('dwCoach_v1', JSON.stringify({status:'veteran',done:{}}));
  localStorage.setItem('dwChipHints_v1', JSON.stringify({all:1}));
} catch (e) {}
${RECORD}`;
    const h = await HG.start({ port: +process.env.TEST_PORT || 5800, prep: PREP, env: { ACCOUNTS_ALLOW_DEBUG: '1', ROYALE_ALWAYS_ON: process.env.ROYALE_ALWAYS_ON || '0' } });
    const { page, origin } = h;
    const T = (...a) => page.eval(`window.royaleTalk(${a.map(x => JSON.stringify(x)).join(',')}), true`);
    const api = (p, body) => page.eval(`fetch(${JSON.stringify(p)}, { method: 'POST', credentials: 'same-origin', headers: { 'X-DW': '1', 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body || {}))} }).then(r => r.json())`);
    let guestId = '', level = 0, name = '';
    let results = [false];
    try {
        results = await HG.runChecks([
            ['guest: banking gems in a raid earns levels on the server', async () => {
                await HG.play(page, origin);
                await sleep(5000);
                await T('DBG', 'god');
                await T('DBG', 'carry', 4200);
                let lv = null;
                for (let v = 0; v < 4 && !lv; v++) {
                    await T('DBG', 'vault', v);
                    await sleep(700);
                    await T('vd', 100000);
                    lv = await waitFor(page, `(() => { const s = window.dwLevelsHud && window.dwLevelsHud.state(); return s && s.lv >= 4 ? s.lv : 0; })()`, 9000);
                }
                assert.ok(lv, 'the in-game level reached 4: ' + JSON.stringify(await page.eval('window.dwLevelsHud && window.dwLevelsHud.state()')));
                guestId = await page.eval(`localStorage.getItem('dwGuestId')`);
                assert.match(guestId, /^[a-f0-9]{32}$/);
                await sleep(5600);
                const r = await (await fetch(origin + '/api/levels', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ guestId }) })).json();
                assert.equal(r.owner, 'guest');
                assert.ok(r.level >= 4, 'saved on the server: ' + r.level);
                level = r.level;
                assert.ok(r.saved.items.some(i => i.id === 'ns_lv_sprout'), 'the Sprout name style waits for sign up');
                return 'guest level ' + level;
            }],
            ['menu: Keep my stuff leaves the raid and the menu shows the guest level', async () => {
                await page.eval(`(() => {
                    window.royaleState().exit();
                    const open = (a) => a && a.openSignup && a.openSignup({ headline: 'Keep your stuff' });
                    if (window.dwAccount) open(window.dwAccount);
                    else window.DWFunnel.withAccountUi(open);
                    return 1;
                })()`);
                assert.ok(await waitFor(page, `!document.body.classList.contains('in-game') && document.querySelector('#dwWelcome.open input') ? 1 : 0`, 15000), 'the quick sign up sheet opened on the menu');
                const shown = await waitFor(page, `(() => { const r = document.getElementById('lvRow'); return r && !r.hidden && r.querySelector('.lv-lv').textContent === 'Lvl ${level}'; })()`, 8000);
                if (!shown) {
                    const now = await page.eval(`localStorage.getItem('dwGuestId')`);
                    const srv = await (await fetch(origin + '/api/levels', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ guestId }) })).json();
                    assert.fail('the bar shows the guest level: ' + JSON.stringify({ was: guestId, now, srvLevel: srv.level, srvXp: srv.xp, st: await page.eval('window.dwLevels && window.dwLevels.state()') }));
                }
                const saved = await page.eval(`(() => { const s = document.querySelector('#lvRow .lv-saved'); return s && !s.hidden ? s.textContent : ''; })()`);
                assert.match(saved, /Saved for when you sign up/);
            }],
            ['signup: the one tap sign up through the real sheet carries the level with no flash of level 1', async () => {
                name = 'Carry' + Math.floor(Math.random() * 9000 + 1000);
                await page.eval(`window.__lvPaint = [], true`);
                const typed = await page.eval(`(() => {
                    const i = document.querySelector('#dwWelcome.open form input');
                    if (!i) return 'no input';
                    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    set.call(i, ${JSON.stringify(name)});
                    i.dispatchEvent(new Event('input', { bubbles: true }));
                    return 'ok';
                })()`);
                assert.equal(typed, 'ok');
                await sleep(900);
                await page.eval(`(() => { const b = document.querySelector('#dwWelcome.open form button[type=submit]'); b.click(); return 1; })()`);
                const user = await waitFor(page, `window.dwAccount.me() && window.dwAccount.me().username`, 10000);
                assert.equal(user, name);
                await sleep(2500);
                const seen = await page.eval('window.__lvPaint.slice()');
                assert.ok(seen.length >= 1, 'the bar stayed up');
                assert.deepEqual(Array.from(new Set(seen)), ['Lvl ' + level], 'only the carried level was ever shown: ' + JSON.stringify(seen));
                const toast = await page.eval(`Array.from(document.querySelectorAll('.dw-toast-msg')).map(t => t.textContent).join(' | ')`);
                assert.match(toast, new RegExp('Your guest progress came with you! You are Level ' + level));
                assert.match(toast, /Sprout name style/);
                assert.doesNotMatch(toast, /[\u2013\u2014]/);
                const saved = await page.eval(`(() => { const s = document.querySelector('#lvRow .lv-saved'); return s && !s.hidden ? s.textContent : ''; })()`);
                assert.equal(saved, '', 'nothing is waiting for sign up any more');
                return toast;
            }],
            ['server: /api/levels shows the carried level for the account, and the guest row is empty', async () => {
                const me = await api('/api/levels', { guestId });
                assert.equal(me.owner, 'account');
                assert.equal(me.level, level);
                assert.equal(me.adoptedNow, null, 'carried once, at sign up');
                const g = await (await fetch(origin + '/api/levels', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ guestId }) })).json();
                assert.equal(g.owner, 'guest');
                assert.equal(g.level, 1);
                assert.equal(g.moved, true);
            }],
            ['locker: the level unlocks are in the Locker', async () => {
                await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
                await sleep(500);
                await page.eval(`(() => { const b = Array.from(document.querySelectorAll('#dwWelcome.open button')).find(x => /done|got it|continue|saved/i.test(x.textContent)); if (b) b.click(); return 1; })()`);
                await sleep(600);
                await page.eval(`(() => { const e = document.querySelector('[data-pane="locker"]'); if (e) e.click(); return 1; })()`);
                const txt = await waitFor(page, `(() => { const t = document.body.innerText; return /Sprout/.test(t) ? t.slice(0, 50) : ''; })()`, 10000);
                assert.ok(txt, 'Sprout shows in the Locker');
                const owned = await page.eval(`fetch('/api/locker', { credentials: 'same-origin' }).then(r => r.json()).then(d => (d.owned || []).map(x => typeof x === 'string' ? x : x.id))`);
                assert.ok(owned.includes('ns_lv_sprout'), JSON.stringify(owned));
            }],
            ['reload: the early paint uses this account\'s cached level, never level 1', async () => {
                await page.send('Page.navigate', { url: origin + '/?r=' + Date.now() });
                await waitFor(page, `document.readyState === 'complete' && !!window.dwAccount && window.dwLevelsReady`, 20000);
                await sleep(2500);
                const seen = await page.eval('window.__lvPaint.slice()');
                assert.deepEqual(Array.from(new Set(seen)), ['Lvl ' + level], JSON.stringify(seen));
            }],
            ['logout: the guest never sees the account\'s level', async () => {
                await page.eval(`fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-DW': '1', 'Content-Type': 'application/json' }, body: '{}' }).then(() => localStorage.setItem('dwAcctHint', 'guest'))`);
                await page.send('Page.navigate', { url: origin + '/?o=' + Date.now() });
                await waitFor(page, `document.readyState === 'complete' && !!window.dwAccount && window.dwLevelsReady`, 20000);
                await sleep(3000);
                const seen = await page.eval('window.__lvPaint.slice()');
                assert.ok(!seen.includes('Lvl ' + level), JSON.stringify(seen));
                assert.equal(seen[seen.length - 1], 'Lvl 1');
            }],
        ]);
        const errs = page.errors.filter(e => !/favicon|ERR_|WebSocket|net::/.test(e));
        if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 8).join('\n  '));
    } finally { await h.stop(); }
    const failed = results.filter(x => !x).length;
    console.log(failed ? `${failed} of ${results.length} failed (server log ${h.logFile})` : `all ${results.length} passed`);
    if (!failed) { try { require('fs').rmSync(h.root, { recursive: true, force: true }); } catch (e) { void e; } }
    return failed ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
