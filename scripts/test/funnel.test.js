// Visit funnel and the first-play path: node scripts/test/funnel.test.js
//
//   events     POST /api/funnel writes one row per visit: every step lands in
//              its column, the first value wins, leave keeps the longest,
//              another browser can't write to a visit, old visits are
//              closed, junk is ignored (still 204), CSRF holds, the session's
//              account is attached, the sweep drops rows after 90 days
//   stats      medians, home->play / 1+ min / bounce math, the device and
//              source split, the settle window, the Discord /stats field
//   first-timers  no popups before the first raid: no welcome gate, no daily
//              strip / day-1 toast, no add-to-home tip, no autofocus fight;
//              hasPlayed, the CrazyGames auto-start rule, Enter/Space
//   play early the page's Play works before the client loads (a fake page:
//              a press is held, then fired once the menu is wired), and the
//              page sends load / home / ready / play / control / min1 / leave
//   migration  v13 -> v14 adds funnel_visits (STRICT), writes the backup
//   wiring     index.html, the build's HOT list, the font compression, no em
//              dashes in what this added
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const nodeCrypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-funnel-test-'));
const REPO = path.join(__dirname, '..', '..');
const PUB = path.join(REPO, 'public');
const GUILD = '222222222222222222', ADMIN = '333333333333333333';

process.env.DATA_DIR = path.join(ROOT, 'data');
for (const k of ['DB_PATH', 'PUBLIC_HOST', 'PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'TRUSTED_PROXIES', 'DISCORD_BOT_TOKEN', 'DISCORD_APP_ID', 'DISCORD_PUBLIC_KEY']) delete process.env[k];
Object.assign(process.env, {
    NODE_ENV: 'test', ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'funnel-test-secret-0123456789-abcdefghijkl', PORT: '3000',
    DISCORD_ADMIN_GUILD_ID: GUILD, ADMIN_DISCORD_IDS: ADMIN, WEB_PUSH: '0',
});

const accounts = require('../../server/accounts');
const dbmod = require('../../server/accounts/db');
const migrations = require('../../server/accounts/migrations');
const funnel = require('../../server/accounts/funnel');
const commands = require('../../server/accounts/discord/commands');
const F = require('../../public/client/funnel.js');

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const d = () => dbmod.handle();
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const hex = () => nodeCrypto.randomBytes(16).toString('hex');
const row = (v) => d().get('SELECT * FROM funnel_visits WHERE visit_id = ?', v);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let base = '', ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
async function post(body, { ip = freshIp(), cookie = '', origin = base, type = 'application/json' } = {}) {
    const headers = { 'Content-Type': type, 'X-Forwarded-For': ip };
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + '/api/funnel', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body || {}) });
    return r.status;
}
const ev = (v, e, t, extra = {}) => ({ v, e, t, d: 'desktop', ...extra });

// ── events ─────────────────────────────────────────────────────────────
test('events: every step of a visit lands in its column', async () => {
    const v = hex(), g = hex(), ip = freshIp();
    const steps = [['load', 2400], ['home', 1500], ['ready', 6100], ['play', 3200], ['control', 11800], ['min1', 72000]];
    for (const [e, t] of steps) assert.equal(await post(ev(v, e, t, { g, s: 'embed:crazygames.com', f: 1, d: 'mobile' }), { ip }), 204, e);
    const r = row(v);
    assert.equal(r.guest_id, g);
    assert.equal(r.device, 'mobile');
    assert.equal(r.source, 'embed:crazygames.com');
    assert.equal(r.first_visit, 1);
    assert.deepEqual([r.load_ms, r.home_ms, r.ready_ms, r.play_ms, r.control_ms, r.min1, r.left_ms, r.auto_start], [2400, 1500, 6100, 3200, 11800, 1, null, 0]);
    assert.equal(r.user_id, null);
});

test('events: the first value wins, leave keeps the longest, auto start is noted', async () => {
    const v = hex(), g = hex();
    await post(ev(v, 'home', 1000, { g }));
    await post(ev(v, 'home', 9000, { g }));
    assert.equal(row(v).home_ms, 1000, 'a replay cannot rewrite it');
    await post(ev(v, 'leave', 4000, { g }));
    await post(ev(v, 'leave', 2000, { g }));
    await post(ev(v, 'leave', 7000, { g }));
    assert.equal(row(v).left_ms, 7000);
    const v2 = hex();
    await post(ev(v2, 'play', 0, { g, a: 1 }));
    assert.equal(row(v2).auto_start, 1);
    assert.equal(row(v2).play_ms, 0);
});

test('events: another browser cannot write to a visit, an old visit is closed', async () => {
    const v = hex(), g = hex();
    await post(ev(v, 'home', 1200, { g }));
    await post(ev(v, 'play', 500, { g: hex() }));
    assert.equal(row(v).play_ms, null, 'a different guest id is ignored');
    const old = hex();
    assert.equal(funnel.record(funnel.clean(ev(old, 'home', 100, { g })), null, Date.now() - 7 * HOUR), 'ok');
    assert.equal(funnel.record(funnel.clean(ev(old, 'play', 100, { g }))), 'stale');
    assert.equal(row(old).play_ms, null);
});

test('events: junk is ignored with a 204, CSRF and the content type still hold', async () => {
    const before = d().get('SELECT count(*) AS n FROM funnel_visits').n;
    for (const bad of [
        { v: 'nothex', e: 'home', t: 1 }, { v: hex(), e: 'buy', t: 1 }, { v: hex(), e: 'home', t: -5 },
        { v: hex(), e: 'home', t: 'soon' }, { v: hex(), e: 'home', t: 9 * HOUR }, {},
    ]) assert.equal(await post(bad), 204);
    assert.equal(d().get('SELECT count(*) AS n FROM funnel_visits').n, before, 'nothing written');
    assert.equal(await post(ev(hex(), 'home', 1), { origin: 'https://evil.example' }), 403);
    assert.equal(await post(ev(hex(), 'home', 1), { origin: '' }), 403);
    assert.equal(await post(JSON.stringify(ev(hex(), 'home', 1)), { type: 'text/plain' }), 415);
    // a made-up source is dropped, not stored
    const v = hex();
    await post(ev(v, 'home', 1, { s: 'https://x.y/?q=<script>' }));
    assert.equal(row(v).source, null);
});

test('events: a logged-in visit carries the account (from the cookie, never the body)', async () => {
    const r = accounts.users.create({ username: 'fn_' + Math.floor(Math.random() * 1e6), recoveryHash: null });
    assert.ok(r.ok);
    const cookie = 'dw_sid=' + accounts.sessions.create(r.user.id, { method: 'password' }).token;
    const v = hex();
    await post(ev(v, 'home', 900, { u: 12345 }), { cookie });
    assert.equal(row(v).user_id, r.user.id);
    const v2 = hex();
    await post(ev(v2, 'home', 900, { u: r.user.id }));
    assert.equal(row(v2).user_id, null);
});

test('events: 60 a minute per IP', async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 61; i++) last = await post(ev(hex(), 'home', 1), { ip });
    assert.equal(last, 429);
});

test('events: the sweep drops visits after 90 days', () => {
    const v = hex();
    funnel.record(funnel.clean(ev(v, 'home', 1)), null, Date.now() - 91 * DAY);
    assert.ok(row(v));
    assert.ok(funnel.sweep() >= 1);
    assert.ok(!row(v));
    assert.ok(read(REPO, 'server', 'accounts', 'index.js').includes('funnel.sweep(now)'), 'index.js sweep calls it');
});

// ── stats ──────────────────────────────────────────────────────────────
test('stats: the median and the summary math', () => {
    assert.equal(funnel.median([]), null);
    assert.equal(funnel.median([5]), 5);
    assert.equal(funnel.median([9, 1, 5]), 5);
    assert.equal(funnel.median([1, 2, 3, 10]), 3, 'even: the mean of the middle two, rounded');
    assert.equal(funnel.median([null, 4, undefined, 2]), 3);
    const R = (o) => Object.assign({ home_ms: null, ready_ms: null, play_ms: null, control_ms: null, min1: 0 }, o);
    const s = funnel.summarize([
        R({ home_ms: 1000, ready_ms: 5000, play_ms: 2000, control_ms: 9000, min1: 1 }),
        R({ home_ms: 1400, ready_ms: 7000, play_ms: 800, control_ms: 13000 }),
        R({ home_ms: 1200, ready_ms: 6000 }),
        R({ home_ms: 3000 }),
        R({}),   // left before the menu showed
    ]);
    assert.equal(s.visits, 5);
    assert.equal(s.home, 4);
    assert.equal(s.play, 2);
    assert.equal(s.homeToPlay, 50, '2 of the 4 that saw the menu');
    assert.equal(s.min1Pct, 20, '1 of 5 visits');
    assert.equal(s.bouncePct, 60, '3 of 5 never pressed Play');
    assert.equal(s.medReady, 6000);
    assert.equal(s.medControl, 11000);
    assert.equal(s.medHome, 1300);
    assert.deepEqual(funnel.summarize([]).homeToPlay, null);
});

test('stats: by device and source, without visits still going; the Discord field', () => {
    d().run('DELETE FROM funnel_visits');
    const now = Date.now();
    const add = (at, o) => {
        const v = hex();
        funnel.record(funnel.clean({ v, e: 'home', t: o.home ?? 1000, d: o.d || 'desktop', s: o.s, f: o.f, g: hex() }), null, at);
        for (const [e, t] of Object.entries(o.steps || {})) funnel.record(funnel.clean({ v, e, t }), null, at);
        return v;
    };
    for (let i = 0; i < 6; i++) add(now - DAY, { s: 'embed:crazygames.com', d: 'mobile', f: 1, steps: { ready: 8000, play: 1000, control: 12000, min1: 70000 } });
    for (let i = 0; i < 4; i++) add(now - 2 * DAY, { s: 'direct', steps: i < 1 ? { ready: 4000, play: 3000, control: 7000 } : { ready: 4000 } });
    add(now - 5 * MIN, { s: 'direct' });           // still going: left out
    add(now - 8 * DAY, { s: 'direct' });           // too old: left out
    const st = funnel.stats(now - 7 * DAY, now - funnel.SETTLE_MS);
    assert.equal(st.all.visits, 10);
    assert.equal(st.mobile.visits, 6);
    assert.equal(st.mobile.min1Pct, 100);
    assert.equal(st.desktop.homeToPlay, 25);
    assert.equal(st.desktop.bouncePct, 75);
    assert.equal(st.firstVisits.visits, 6);
    assert.deepEqual(st.sources.map(s => s.name), ['embed:crazygames.com', 'direct']);
    assert.equal(st.all.homeToPlay, 70);
    assert.equal(st.all.medControl, 12000);
    const txt = funnel.weekText(now);
    assert.ok(txt.length <= 1024);
    assert.match(txt, /\*\*All\*\* 10: 70% home→play · 60% 1\+ min · 30% bounce · ready 8\.0 s · control 12 s/);
    assert.match(txt, /crazygames\.com \(embed\) 6: 100% home→play/);
    assert.match(txt, /Mobile 6:/);
    // the admin /stats card has it
    const res = commands.handle({ type: 2, guild_id: GUILD, member: { user: { id: ADMIN, username: 'tester' } }, data: { name: 'stats' } });
    const fields = res.data.embeds[0].fields;
    const f = fields.find(x => x.name === 'Funnel (7 days)');
    assert.ok(f, 'the field is on /stats');
    assert.equal(f.value, txt);
    assert.equal(funnel.text(null), 'No visits measured yet.');
});

// ── first-timers ───────────────────────────────────────────────────────
function mem(init = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

test('first-timers: hasPlayed, the CrazyGames auto start and the play keys', () => {
    assert.equal(F.hasPlayed(mem()), false);
    assert.equal(F.hasPlayed(mem({ dwGuestId: 'a'.repeat(32), dwAcctHint: 'guest', dwSrc: 'direct' })), false, 'a visit is not a raid');
    for (const k of [{ dwPlayed: '1' }, { dwRaidsEnded: '2' }, { dwSessions: '1' }, { digRoyaleTutorialDone_v1: '1' }, { dwAcctHint: 'user' }]) {
        assert.equal(F.hasPlayed(mem(k)), true, JSON.stringify(k));
    }
    assert.equal(F.hasPlayed(null), false);
    const cg = { portal: 'crazygames', played: false, search: '?crazygames', hash: '' };
    assert.equal(F.shouldAutoStart(cg), true);
    assert.equal(F.shouldAutoStart({ ...cg, played: true }), false, 'returning players get the menu');
    assert.equal(F.shouldAutoStart({ ...cg, portal: '' }), false, 'direct visitors get the menu');
    assert.equal(F.shouldAutoStart({ ...cg, search: '?crazygames&party=ABCDE' }), false, 'an invite goes through the party');
    assert.equal(F.shouldAutoStart({ ...cg, search: '?crazygames&instantMultiplayer=true' }), false);
    assert.equal(F.shouldAutoStart({ ...cg, hash: '#tut' }), false);
    const K = (key, o = {}) => ({ key, code: key === ' ' ? 'Space' : key, ...o });
    const menu = { blocked: false, typing: '', onButton: false };
    assert.equal(F.isPlayKey(K('Enter'), menu), true);
    assert.equal(F.isPlayKey(K(' '), menu), true);
    assert.equal(F.isPlayKey(K('a'), menu), false);
    assert.equal(F.isPlayKey(K(' ', { repeat: true }), menu), false);
    assert.equal(F.isPlayKey(K('Enter', { ctrlKey: true }), menu), false);
    assert.equal(F.isPlayKey(K('Enter'), { ...menu, blocked: true }), false, 'a dialog is open');
    assert.equal(F.isPlayKey(K('Enter'), { ...menu, typing: 'name' }), true, 'Enter in the name box plays');
    assert.equal(F.isPlayKey(K(' '), { ...menu, typing: 'name' }), false, 'Space in the name box is a space');
    assert.equal(F.isPlayKey(K('Enter'), { ...menu, typing: 'other' }), false, 'other boxes keep their keys');
    assert.equal(F.isPlayKey(K(' '), { ...menu, onButton: true }), false, 'a focused button presses itself');
    assert.equal(F.progress(0), 0.04);
    assert.equal(F.progress(1e6), 0.95);
});

test('first-timers: no gate, no daily strip or toast, no tip, no autofocus before the first raid', () => {
    const html = read(PUB, 'index.html');
    const home = read(PUB, 'client', 'home.js');
    const main = read(PUB, 'client', 'account', 'main.js');
    const ret = read(PUB, 'client', 'account', 'retention.js');
    // the gate: only a stored 'new' (logged out here) shows it
    assert.match(home, /localStorage\.getItem\('dwAcctHint'\) \|\| 'guest'/);
    assert.match(main, /setMode\(hint === 'user' \? 'user' : hint === 'new' && !welcome\.embedded\(\) \? 'new' : 'guest'\)/);
    // simulate home.js's first lines for the three kinds of visitor
    const acct = (hint, embed) => { const h = hint || 'guest'; return embed && h === 'new' ? 'guest' : h; };
    assert.equal(acct(null, false), 'guest', 'first visit: no gate');
    assert.equal(acct('new', false), 'new', 'logged out here: the gate');
    assert.equal(acct('new', true), 'guest', 'a portal frame never');
    // the daily track, the day-1 claim toast and the welcome back card wait for a raid
    assert.match(ret, /s\.mode !== 'user' && !playedBefore\(\)\)\) \{ st = null; paint\(\); return; \}/);
    const refresh = ret.slice(ret.indexOf('export async function refresh'), ret.indexOf('function take('));
    assert.ok(refresh.indexOf('playedBefore()') < refresh.indexOf('api.daily('), 'checked before asking the server');
    assert.ok(refresh.indexOf('playedBefore()') < refresh.indexOf('claim({ quiet: true })'), 'no day-1 toast');
    assert.ok(refresh.indexOf('playedBefore()') < refresh.indexOf('openWelcomeSoon()'), 'no welcome back card');
    // the iPhone add-to-home tip
    const tip = home.slice(home.indexOf('function initA2hsTip'), home.indexOf('function initA2hsTip') + 600);
    assert.match(tip, /window\.DWFunnel && !window\.DWFunnel\.hasPlayed\(\)\) return;/);
    // the name is optional and doesn't grab the keyboard (Space plays)
    const name = /<input[^>]*id="playerNameInput"[^>]*>/.exec(html)[0];
    assert.ok(!/autofocus/.test(name), 'no autofocus');
    assert.match(name, /placeholder="optional"/);
    // the push ask was already after a raid only
    assert.match(ret, /function wantAsk\(\)[\s\S]*playedOnce\(\)/);
});

// A fake page, enough for funnel.js's boot: the button, the menu, the
// clock, the timers and fetch are all ours.
function fakePageWith(extra) { return fakePage({ extra }); }
function fakePage({ storage = mem(), portal = '', search = '', hash = '', extra = {} } = {}) {
    let clock = 0;
    const timers = [];
    const listeners = { doc: {}, win: {} };
    const sent = [];
    const classes = () => { const s = new Set(); return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)) }; };
    const label = { textContent: 'Play' };
    const button = {
        id: 'startButton', disabled: false, onclick: null, classList: classes(), children: [],
        querySelector: (q) => (q === 'b' ? label : null), appendChild(c) { this.children.push(c); }, contains(c) { return this.children.includes(c); },
        setAttribute() {}, closest(q) { return q === '#startButton' ? button : null; },
        click() {
            const e = { target: button, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
            for (const fn of listeners.doc.click || []) fn(e);
            if (!e.stopped && typeof button.onclick === 'function') button.onclick(e);
        },
    };
    const menuEl = { offsetParent: {} };
    const html = { attrs: { 'data-acct': 'guest' }, getAttribute(k) { return this.attrs[k] || null; } };
    const doc = {
        documentElement: html, visibilityState: 'visible',
        body: { classList: classes(), added: [], appendChild(el) { this.added.push(el.src); } },
        getElementById: id => (id === 'startButton' ? button : null),
        querySelector: q => (q === '.startMenu' ? menuEl : null),
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, className: '' }),
        querySelectorAll: () => [],
        addEventListener: (t, fn) => (listeners.doc[t] = listeners.doc[t] || []).push(fn),
    };
    const w = {
        document: doc, localStorage: storage, dwPortal: portal, location: { search, hash },
        navigator: { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Macintosh)' },
        matchMedia: () => ({ matches: true }),
        crypto: nodeCrypto.webcrypto,
        performance: { now: () => clock, getEntriesByType: (t) => (t === 'paint' ? [{ name: 'first-contentful-paint', startTime: 900 }] : t === 'navigation' ? [{ loadEventEnd: 4200 }] : []) },
        setTimeout: (fn, ms) => timers.push({ at: clock + (ms || 0), fn }),
        fetch: (url, opts) => { sent.push({ url, ...JSON.parse(opts.body), keepalive: opts.keepalive }); return Promise.resolve({}); },
        addEventListener: (t, fn) => (listeners.win[t] = listeners.win[t] || []).push(fn),
    };
    Object.assign(w, extra);
    w.DWFunnel = Object.assign({}, F);
    F.boot(w);
    const advance = (ms) => {
        const end = clock + ms;
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            const t = timers[0];
            if (!t || t.at > end) break;
            timers.shift();
            clock = t.at;
            t.fn();
        }
        clock = end;
    };
    const key = (k, target = { tagName: 'BODY' }) => {
        const e = { key: k, code: k === ' ' ? 'Space' : k, target, prevented: false, preventDefault() { this.prevented = true; } };
        for (const fn of listeners.doc.keydown || []) fn(e);
        return e;
    };
    const acct = () => doc.body.added.filter(x => x === './client/account/main.js').length;
    return { w, doc, button, label, sent, advance, key, listeners, storage, html, acct, events: () => sent.map(s => s.e) };
}
// what app.js does once the menu is wired
function wire(page, onStart) {
    page.w.global = { startGame() {}, gameLoading: false, gameStart: false };
    page.button.onclick = () => { page.w.global.gameLoading = true; onStart && onStart(); };
}

test('play early: a press before the client loads is held, shown, then fired once', () => {
    const p = fakePage();
    p.advance(300);
    assert.deepEqual(p.events(), ['home']);
    assert.equal(p.sent[0].t, 900, 'home counts from the first paint');
    assert.equal(p.button.classList.contains('dw-loading'), true, 'a progress bar while loading');
    p.advance(1200);
    p.button.click();
    assert.equal(p.button.classList.contains('dw-queued'), true);
    assert.equal(p.label.textContent, 'Starting…');
    let starts = 0;
    p.advance(1000);
    assert.equal(starts, 0, 'nothing to start yet');
    wire(p, () => starts++);
    p.advance(150);
    assert.equal(starts, 1, 'fired as soon as the menu is wired');
    assert.equal(p.label.textContent, 'Play');
    p.advance(2000);
    assert.equal(starts, 1, 'only once');
    assert.deepEqual(p.events(), ['home', 'ready', 'play']);
    assert.equal(p.sent[2].t, 1500 - 900, 'time on the menu: first paint to the press, not to the start');
    assert.equal(p.sent[2].a, undefined, 'a click, not an auto start');
});

test('play early: a press caught by the inline <head> catcher before funnel.js ran still starts', () => {
    const html = read(PUB, 'index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /window\.dwPlayEarly = 1;/);
    // run the catcher against a tiny document, then boot with what it kept
    const L = {};
    const btn = { classList: { add(c) { btn.cls = c; } }, querySelector: () => ({ textContent: 'Play' }) };
    const win = {}, docu = { addEventListener: (t, fn) => (L[t] = fn), getElementById: () => btn };
    const src = /<script>\s*\/\/ \.\.\.and until it runs[\s\S]*?<\/script>/.exec(head)[0].replace(/<\/?script>/g, '');
    new Function('window', 'document', src)(win, docu);
    L.keydown({ key: ' ', target: { tagName: 'INPUT', id: 'playerNameInput' } });
    assert.equal(win.dwPlayEarly, undefined, 'Space in the name box is a space');
    L.click({ target: { closest: () => btn } });
    assert.equal(win.dwPlayEarly, 1);
    assert.equal(btn.cls, 'dw-queued');
    const p = fakePage();
    assert.equal(p.label.textContent, 'Play');
    let starts = 0;
    const r = fakePageWith({ dwPlayEarly: 1 });
    assert.equal(r.label.textContent, 'Starting\u2026');
    wire(r, () => starts++);
    r.advance(200);
    assert.equal(starts, 1);
});

test('play early: Enter or Space before or after, but not while typing elsewhere or behind a dialog', () => {
    const p = fakePage();
    p.advance(100);
    const e1 = p.key(' ', { tagName: 'INPUT', id: 'feedbackText', type: 'text' });
    assert.equal(e1.prevented, false, 'typing in another box');
    const e2 = p.key('Enter', { tagName: 'INPUT', id: 'playerNameInput', type: 'text' });
    assert.equal(e2.prevented, true, 'Enter in the name box queues Play');
    let starts = 0;
    wire(p, () => starts++);
    p.advance(150);
    assert.equal(starts, 1);
    // back on the menu after a raid: Space presses Play, Enter is app.js's
    const q = fakePage();
    wire(q, () => starts++);
    q.advance(150);
    q.html.attrs['data-acct'] = 'new';
    assert.equal(q.key(' ').prevented, false, 'the login gate is up');
    q.html.attrs['data-acct'] = 'guest';
    assert.equal(q.key('Enter').prevented, false, 'Enter: app.js handles it');
    const before = starts;
    assert.equal(q.key(' ').prevented, true);
    assert.equal(starts, before + 1);
});

test('play early: a first-timer on CrazyGames starts by itself; the steps are all sent', () => {
    const p = fakePage({ portal: 'crazygames', search: '?crazygames' });
    assert.equal(p.label.textContent, 'Starting…', 'queued at once');
    let starts = 0;
    wire(p, () => starts++);
    p.advance(200);
    assert.equal(starts, 1);
    const play = p.sent.find(s => s.e === 'play');
    assert.equal(play.a, 1, 'marked as an auto start');
    assert.equal(play.f, 1, 'a first visit');
    assert.match(play.g, /^[a-f0-9]{32}$/, 'the guest id it made');
    assert.equal(p.storage.getItem('dwGuestId'), play.g);
    // in control for a minute
    p.w.dwPlaying = () => true;
    p.advance(1000);
    assert.equal(p.storage.getItem('dwPlayed'), '1', 'now it has played');
    assert.equal(p.w.DWFunnel.hasPlayed(), true);
    p.advance(61000);
    for (const l of p.listeners.win.load || []) l();
    p.advance(10);
    assert.deepEqual(p.events().sort(), ['control', 'home', 'load', 'min1', 'play', 'ready']);
    assert.equal(p.sent.find(s => s.e === 'load').t, 4200);
    assert.ok(p.sent.every(s => s.url === '/api/funnel' && s.keepalive && s.v === p.sent[0].v), 'one visit id, keepalive');
    // a returning player on CrazyGames gets the menu
    const r = fakePage({ portal: 'crazygames', search: '?crazygames', storage: mem({ dwPlayed: '1', dwGuestId: 'b'.repeat(32) }) });
    assert.equal(r.label.textContent, 'Play');
    wire(r, () => starts++);
    const n = starts;
    r.advance(500);
    assert.equal(starts, n, 'no auto start');
    assert.equal(r.sent.find(s => s.e === 'home').f, 0, 'not a first visit');
});

test('play early: closing the page before Play is a leave, after Play it is not', () => {
    const p = fakePage();
    p.advance(2500);
    p.doc.visibilityState = 'hidden';
    for (const fn of p.listeners.doc.visibilitychange || []) fn();
    const leave = p.sent.find(s => s.e === 'leave');
    assert.ok(leave);
    assert.equal(leave.t, 2500);
    const q = fakePage();
    wire(q);
    q.advance(200);
    q.button.click();
    q.advance(200);
    for (const fn of q.listeners.win.pagehide || []) fn();
    assert.ok(!q.events().includes('leave'));
});

test('account UI: at once for accounts, else on an idle menu or after the raid, never during a start', () => {
    assert.equal(F.accountUiNow({ hint: 'user' }), true);
    assert.equal(F.accountUiNow({ hint: 'new' }), true, 'logged out here: the gate needs it');
    assert.equal(F.accountUiNow({ hint: null, search: '?auth=ok' }), true);
    assert.equal(F.accountUiNow({ hint: null, search: '?ref=AB12CD' }), true);
    assert.equal(F.accountUiNow({ hint: null, hash: '#reset=xyz' }), true);
    assert.equal(F.accountUiNow({ hint: 'guest', search: '?crazygames' }), false);
    assert.equal(F.accountUiNow({ hint: null, search: '?crazygames&party=ABCDE' }), true, 'a portal duo invite needs the party panel');
    assert.equal(F.accountUiNow({ hint: null }), false);
    const due = (o) => F.accountUiDue(Object.assign({ ready: true, starting: false, inGame: false, idleMs: 0, waitedMs: 0, asked: false }, o));
    assert.equal(due({ idleMs: 100 }), false);
    assert.equal(due({ idleMs: F.ACCT_IDLE_MS }), true);
    assert.equal(due({ idleMs: 9e9, starting: true }), false, 'Play was pressed');
    assert.equal(due({ idleMs: 9e9, inGame: true }), false, 'in a raid');
    assert.equal(due({ ready: false, waitedMs: 50000 }), true, 'the client never came: give up waiting');
    assert.equal(due({ starting: true, asked: true }), true, 'a tap on its tabs');

    // the fake page: idle menu
    const p = fakePage();
    p.advance(500);
    assert.equal(p.acct(), 0, 'not before the client');
    wire(p);
    p.advance(1000);
    assert.equal(p.acct(), 0, 'not straight away');
    p.advance(1000);
    assert.equal(p.acct(), 1, 'once the menu sat idle');
    p.advance(5000);
    assert.equal(p.acct(), 1, 'once');
    // Play pressed early: it waits for the menu to come back
    const q = fakePage();
    q.button.click();
    wire(q);
    q.advance(300);
    q.doc.body.classList.add('in-game');
    q.w.global.gameLoading = true;
    q.advance(60000);
    assert.equal(q.acct(), 0, 'nothing loads during the raid');
    q.doc.body.classList.remove('in-game');
    q.w.global.gameLoading = false;
    q.advance(3000);
    assert.equal(q.acct(), 1, 'back on the menu');
    // an account, or a tap on the tabs
    assert.equal(fakePage({ storage: mem({ dwAcctHint: 'user' }) }).acct(), 1);
    const r = fakePage();
    for (const fn of r.listeners.doc.pointerdown || []) fn({ target: { closest: (q2) => (q2.includes('#menuNav') ? {} : null) } });
    assert.equal(r.acct(), 1);
    // the death card's "Create account" before the account UI is in
    const z = fakePage();
    z.w.global = { gameLoading: true };
    let opened = 0;
    z.w.DWFunnel.withAccountUi((a) => a.openSignup());
    assert.equal(z.acct(), 1, 'loaded on demand');
    z.advance(200);
    z.w.dwAccount = { openSignup: () => opened++ };
    z.advance(100);
    assert.equal(opened, 1);
    assert.match(read(PUB, 'client', 'app.js'), /DWFunnel\.withAccountUi\(\(a\) => a\.openSignup/);
});

// ── migration ──────────────────────────────────────────────────────────
test('migration v14: from v13 the funnel table is added and the backup written', () => {
    const dir = path.join(ROOT, 'mig');
    fs.mkdirSync(dir, { recursive: true });
    const raw = dbmod.open({ path: path.join(dir, 'v13.db'), migrate: false });
    for (const m of migrations.MIGRATIONS.filter(m => m.version <= 13)) raw.tx(() => { m.up(raw); raw.exec('PRAGMA user_version = ' + m.version); });
    raw.run("INSERT INTO users (public_id, username, username_lc, created_at) VALUES ('DW-AAAAAAAA', 'Old', 'old', 1)");
    const r = migrations.apply(raw, { backupDir: path.join(dir, 'backups') });
    assert.deepEqual(r.applied, migrations.MIGRATIONS.filter(m => m.version >= 14).map(m => m.version));
    assert.equal(r.applied[0], 14);
    assert.match(path.basename(r.backup), /^pre-migrate-v14-.+\.db$/);
    assert.ok(fs.existsSync(r.backup));
    assert.equal(raw.userVersion(), migrations.latestVersion());
    assert.match(raw.get("SELECT sql FROM sqlite_master WHERE name = 'funnel_visits'").sql, /\)\s*STRICT\s*$/);
    assert.ok(raw.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'funnel_visits_created'"));
    assert.equal(raw.get('SELECT username FROM users').username, 'Old', 'nothing else touched');
    const ins = (o) => raw.run(`INSERT INTO funnel_visits (visit_id, device, created_at, updated_at, min1) VALUES (?, ?, 1, 1, ?)`, o.v || hex(), o.d || 'desktop', o.min1 ?? 0);
    ins({});
    assert.throws(() => ins({ v: 'short' }), /CHECK/);
    assert.throws(() => ins({ d: 'fridge' }), /CHECK/);
    assert.throws(() => ins({ min1: 2 }), /CHECK/);
    // a deleted account keeps its visits, anonymous
    raw.run('INSERT INTO funnel_visits (visit_id, device, user_id, created_at, updated_at) VALUES (?, ?, 1, 1, 1)', hex(), 'mobile');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.run('DELETE FROM users WHERE id = 1');
    assert.equal(raw.get('SELECT count(*) AS n FROM funnel_visits WHERE user_id IS NULL').n, 2);
    assert.deepEqual(migrations.apply(raw).applied, [], 'nothing left to do');
    raw.close();
});

// ── wiring ─────────────────────────────────────────────────────────────
test('wiring: index.html, the build, the fonts; the progress estimate matches the graph; no em dashes', () => {
    const html = read(PUB, 'index.html');
    const funnelTag = html.indexOf('<script defer src="./client/funnel.js"></script>');
    assert.ok(funnelTag > 0 && funnelTag < html.indexOf('</head>'), 'deferred in <head>');
    assert.ok(funnelTag < html.indexOf('src="./client/app.js"'), 'before the modules');
    assert.ok(!/jquery/i.test(html), 'the unused jQuery is gone');
    assert.ok(!/<script type="module" src="\.\/client\/account\/main\.js">/.test(html), 'the account UI is not on the critical path');
    assert.match(read(PUB, 'client', 'funnel.js'), /s\.src = '\.\/client\/account\/main\.js'/);
    assert.match(html, /fonts\.googleapis\.com[^>]*media="print" onload="this\.media='all'"/);
    assert.match(read(REPO, 'scripts', 'build-client.js'), /"client\/funnel\.js",\n\]\);/);
    assert.match(read(REPO, 'server', 'server.js'), /const FONTS = new Set\(\["ttf", "otf"\]\)/);
    assert.match(read(PUB, 'client', 'app.js'), /document\.addEventListener\("DOMContentLoaded", onMenuReady, \{ once: true \}\)/);
    assert.ok(!/window\.onload\s*=/.test(read(PUB, 'client', 'app.js')), 'Play no longer waits for every font and picture');
    assert.ok(accounts.owns('/api/funnel'));
    // the bar's estimate: the script files the menu loads before Play works
    const seen = new Set();
    const walk = (f) => {
        if (seen.has(f) || !fs.existsSync(f)) return;
        seen.add(f);
        const src = fs.readFileSync(f, 'utf8');
        const re = /(?:^|\n|;)\s*import\s+(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/g;
        let m;
        while ((m = re.exec(src))) walk(path.resolve(path.dirname(f), m[1]));
    };
    for (const m of html.matchAll(/<script (?:type="module" |defer )?src="\.\/(client\/[^"]+)"/g)) walk(path.join(PUB, m[1]));
    const shared = (html.match(/<script src="\/shared\//g) || []).length;
    const count = seen.size + shared;
    assert.ok(Math.abs(count - F.EXPECTED_JS) / count < 0.25, `EXPECTED_JS ${F.EXPECTED_JS} vs ${count} scripts`);
    for (const f of [path.join(PUB, 'client', 'funnel.js'), path.join(REPO, 'server', 'accounts', 'funnel.js'), path.join(REPO, 'server', 'accounts', 'routes', 'funnel.js'), __filename]) {
        assert.ok(!read(f).includes(String.fromCharCode(0x2014)), path.basename(f) + ' has no em dash');
    }
    const priv = read(PUB, 'privacy.html');
    assert.match(priv, /deleted after 90 days/);
});

// ===================================================================
async function main() {
    const quietLog = console.log, quietWarn = console.warn;
    console.log = (...a) => { if (!/^\[(accounts|backup|discord|clientIp|push)\]/.test(String(a[0]))) quietLog(...a); };
    console.warn = (...a) => { if (!/^\[(accounts|backup|discord|clientIp|push)\]/.test(String(a[0]))) quietWarn(...a); };
    assert.equal(accounts.initMain(), true, 'initMain');
    const server = http.createServer((req, res) => { if (!accounts.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    let failed = 0;
    const t0 = Date.now();
    for (const t of tests) {
        try { await t.fn(); quietLog('ok   ' + t.name); }
        catch (e) { failed++; quietLog('FAIL ' + t.name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 8).join('\n     ')); }
    }
    server.close();
    accounts.shutdown();
    quietLog(`\n${tests.length - failed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
    else quietLog('test data kept in ' + ROOT);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
