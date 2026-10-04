// Reasons to come back, on the menu (accounts and guests alike):
//
//   the strip     under Play (#dailyStrip): the 7-day track, tomorrow's
//                 reward with a live countdown (or today's, with Claim), the
//                 streak flame, and one quiet line of reasons: the bank, a
//                 sidekick on today's shelf, the next Raid Night when the
//                 event card above Play isn't already saying it
//   welcome back  a returning player whose reward is ready gets one short
//                 card on load: the bank, the day, a big Claim, then Play.
//                 Only when nothing else is open (never a card on a card)
//   day 1         a first-time player's day 1 is claimed quietly on their
//                 first visit, so tomorrow already has something waiting
//   pings         after a player's first raid (never on a first load), one
//                 soft ask under the strip for a push ping when the reward is
//                 ready and before Raid Night. Asked once; the bell on the
//                 strip turns them off again
//
// Rules, rewards and the clock live on the server (server/accounts/
// retention.js, shared/daily.js); this only draws what /api/daily says.
import * as api from './api.js';
import * as store from './state.js';
import { h, icon, clear, modal, toast, animate, reducedMotion, hasLayers, T_MID } from './ui.js';
import { achIcon } from './achievements.js';
import * as skArt from '../sidekickArt.js';

const DY = window.DWDaily, EV = window.DWEvents, C = window.DWCosmetics;
const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } },
};
const ASK_KEY = 'dwPushAsk';        // 'yes' | 'no': the soft ask was answered
const RAIDS_KEY = 'dwRaidsEnded';   // raidFinale.js counts finished raids
const SESS_KEY = 'dwSessions';      // games left to the menu after a while
const SYNC_KEY = 'dwPushSync';      // the day the subscription was last re-sent

let strip = null, hooks = { onSignup() {}, playing: () => false };
let st = null, skew = 0, loadSeq = 0, timer = 0, lastLine = '', welcomed = false, askOpen = false, claiming = false;
let gameAt = 0, freshLoad = true, booted = false, ownerSig = '';

const inGame = () => document.body.classList.contains('in-game');
const embedded = () => !!window.dwEmbed;
const fmt = (n) => (Math.round(+n || 0)).toLocaleString('en-US');
const dustTxt = (milli) => { const v = (+milli || 0) / 1000; return Number.isInteger(v) ? String(v) : String(+v.toFixed(2)); };

function guestId() {
    let g = ls.get('dwGuestId');
    if (!/^[a-f0-9]{32}$/.test(g || '')) {
        try {
            g = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
            ls.set('dwGuestId', g);
        } catch (e) { g = ''; }
    }
    return g || '';
}

export function init(hs) {
    Object.assign(hooks, hs || {});
    strip = document.getElementById('dailyStrip');
    if (!strip || !DY) return;
    // logging in or out, or accounts going down: a different owner
    store.on((s) => {
        const sig = s.mode + '|' + (s.user ? s.user.userId : '') + '|' + (s.offline ? 1 : 0);
        if (sig === ownerSig) return;
        ownerSig = sig;
        if (booted) refresh();
    });
    let was = inGame();
    new MutationObserver(() => {
        const now = inGame();
        if (now === was) return;
        was = now;
        if (now) { gameAt = Date.now(); stopTick(); return; }
        // back on the menu: a real game counts as a session (the ask waits for one)
        if (gameAt && Date.now() - gameAt > 60000) ls.set(SESS_KEY, String((+ls.get(SESS_KEY) || 0) + 1));
        freshLoad = false;
        setTimeout(refresh, 450);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return stopTick();
        if (st && !inGame()) { paint(); if (Date.now() - (st._at || 0) > 10 * 60000) refresh(); }
    });
}

// The menu's owner is known: main.js calls this once /api/me answered.
export function start() { booted = true; refresh(); }

export async function refresh() {
    if (!strip || !booted || inGame()) return;
    const s = store.get();
    if (s.mode === 'new' || s.offline) { st = null; paint(); return; }
    const seq = ++loadSeq;
    const r = await api.daily(guestId());
    if (seq !== loadSeq || inGame()) return;
    if (!r.ok || !r.data || !r.data.on) { st = null; paint(); return; }
    take(r.data);
    if (r.data.adoptedNow && r.data.adoptedNow.items && r.data.adoptedNow.items.length) {
        toast('Your guest streak came with you, plus ' + r.data.adoptedNow.items.map(itemName).join(' and ') + '!', { kind: 'ok', duration: 6000 });
    }
    syncPush();
    // a brand new player: day 1 is theirs on the first visit, no card about it
    if (st.claims === 0 && st.ready) { await claim({ quiet: true }); return; }
    paint();
    if (st.ready && st.claims > 0 && !welcomed && freshLoad) openWelcomeSoon();
}

function take(data) {
    st = data;
    st._at = Date.now();
    skew = (+data.now || Date.now()) - Date.now();
}

/* ── claiming ───────────────────────────────────────────────────────── */
async function claim(opts = {}) {
    if (claiming) return null;
    claiming = true;
    const r = await api.dailyClaim(guestId());
    claiming = false;
    if (r.ok && r.data && r.data.status) {
        take(r.data.status);
        if (r.data.push) st.push = r.data.push;
        const c = r.data.claimed;
        if (opts.quiet) toast('Day 1 reward: +' + fmt(c.gems) + ' gems in your bank. More tomorrow!', { kind: 'ok', duration: 5200 });
        if (typeof r.data.balanceMilli === 'number' && hooks.onDust) hooks.onDust(r.data.balanceMilli / 1000);
        paint(c);
        return c;
    }
    const code = r.data && r.data.error && r.data.error.code;
    if (code === 'not_ready' || code === 'already_claimed') { refresh(); return null; }
    if (code === 'adopted') { toast('Your streak lives on your account now. Log in to claim it.'); return null; }
    if (!opts.quiet) toast((r.data && r.data.error && r.data.error.message) || 'Couldn’t claim it. Try again in a sec.', { kind: 'error' });
    return null;
}

/* ── words ──────────────────────────────────────────────────────────── */
function itemName(it) {
    if (!it) return '';
    return it.cat === 'sidekick' ? it.name + ' sidekick' : it.cat === 'sdSkin' ? it.name + ' skin' : it.name;
}
// "500 gems + 1.5 dust", "750 gems + Buddy sidekick"
export function rewardText(r, opts = {}) {
    if (!r) return '';
    const bits = [fmt(r.gems) + ' gems'];
    if (r.item) bits.push(itemName(r.item));
    else if (r.dustMilli > 0) bits.push(dustTxt(r.dustMilli) + ' dust');
    return bits.join(opts.sep || ' + ');
}

/* ── little art ─────────────────────────────────────────────────────── */
const SVG_NS = 'http://www.w3.org/2000/svg';
function gemIcon(cls) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'dw-ic dy-gem' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M7 4h10l4.5 5.5L12 21 2.5 9.5z');
    const f = document.createElementNS(SVG_NS, 'path');
    f.setAttribute('d', 'M7 4l-1.6 5.5H18.6L17 4M12 21 5.4 9.5M12 21l6.6-11.5');
    f.setAttribute('class', 'dy-gem-f');
    s.append(p, f);
    return s;
}
// A sidekick (or Buddy wearing a skin) drawn by the game's own art.
function itemArt(it, size) {
    const item = it && C ? C.byId(it.id) : null;
    if (!item) return gemIcon();
    const kickItem = item.cat === 'sidekick' ? item : C.byId(C.BASIC_SIDEKICK_ID);
    const look = item.cat === 'sdSkin' ? item.look : null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.round(size * dpr);
    cv.className = 'dy-art';
    cv.style.width = cv.style.height = size + 'px';
    try {
        const c = cv.getContext('2d');
        c.scale(dpr, dpr);
        c.translate(size / 2, size / 2 + size * 0.04);
        skArt.drawSidekick(c, kickItem.kick, look, size * 0.27, null, -0.6);
    } catch (e) { return gemIcon(); }
    return cv;
}
function flame(n, cls) {
    return h('span', { class: 'dy-flame' + (cls ? ' ' + cls : ''), title: n + ' days in a row' }, achIcon('streaker'), h('b', { text: String(n) }));
}

// The seven days. claimed: how many of this week's are done; cur: the one
// the next claim pays; ready: it can be claimed now.
function pips(size) {
    // a finished week shows all seven until day 1 comes round again
    const done = !st.ready && st.step === 7 ? 7 : st.day - 1;
    const row = h('div', { class: 'dy-pips dy-sz-' + size, role: 'list', 'aria-label': 'Daily rewards, day ' + st.day + ' of 7' });
    for (let i = 1; i <= 7; i++) {
        const r = st.track[i - 1];
        const cls = i <= done ? ' done' : i === st.day && done < 7 ? (st.ready ? ' now' : ' next') : '';
        const art = r.item ? itemArt(r.item, size === 'big' ? 30 : 18) : gemIcon();
        row.appendChild(h('div', { class: 'dy-pip' + cls + (r.item ? ' item' : ''), role: 'listitem', title: 'Day ' + i + ': ' + rewardText(r) + (r.signup ? ' (sign up to claim the ' + itemName(r.item) + ')' : '') },
            size === 'big' ? h('span', { class: 'dy-pip-d', text: 'Day ' + i }) : null,
            art,
            size === 'big' ? h('span', { class: 'dy-pip-g', text: r.item ? (r.signup ? 'sign up' : 'free') : fmt(r.gems) }) : null,
            i <= done ? h('span', { class: 'dy-pip-ok' }, icon('check')) : null));
    }
    return row;
}

/* ── the strip ──────────────────────────────────────────────────────── */
let cdEl = null, reasonsEl = null;
function stopTick() { clearInterval(timer); timer = 0; }

function paint(justClaimed) {
    stopTick();
    if (!strip) return;
    if (!st || !st.on || inGame()) { strip.hidden = true; clear(strip); return; }
    clear(strip);
    strip.hidden = false;
    strip.classList.toggle('ready', !!st.ready);
    const head = h('div', { class: 'dy-head' }, h('span', { class: 'dy-title', text: 'Daily rewards' }));
    if (st.streak >= 2) head.appendChild(flame(st.streak));
    const asking = askOpen || wantAsk();
    // the ask says it all; the bell comes back once it's answered
    const bell = asking ? null : bellButton();
    if (bell) head.appendChild(bell);
    strip.appendChild(head);
    strip.appendChild(pips('small'));
    cdEl = null;
    if (st.ready) {
        const lead = st.missed ? 'Back on day ' + st.day + ':' : 'Day ' + st.day + ' is ready:';
        strip.appendChild(h('div', { class: 'dy-line' },
            h('span', { class: 'dy-what' }, h('span', { class: 'dy-lead', text: lead + ' ' }), h('b', { text: rewardText(st.today) })),
            h('button', { type: 'button', class: 'dw-btn primary sm dy-claim', text: 'Claim', onclick: (e) => { e.currentTarget.disabled = true; claim(); } })));
        const su = st.today.signup ? signupLine(st.today) : null;
        if (su) strip.appendChild(su);
    } else {
        cdEl = h('span', { class: 'dy-cd' });
        const tmr = st.tomorrow || st.today;
        const lead = justClaimed ? 'Got it! Tomorrow:' : st.step === 7 ? 'Week done! Tomorrow:' : 'Tomorrow:';
        strip.appendChild(h('div', { class: 'dy-line' },
            h('span', { class: 'dy-what' }, h('span', { class: 'dy-lead', text: lead + ' ' }), h('b', { text: rewardText(tmr) })),
            cdEl));
        const su = tmr.signup ? signupLine(tmr) : null;
        if (su) strip.appendChild(su);
    }
    reasonsEl = h('div', { class: 'dy-reasons' });
    strip.appendChild(reasonsEl);
    lastLine = '';
    paintReasons();
    if (asking) strip.appendChild(askCard());
    tick();
    timer = setInterval(tick, 1000);
    if (justClaimed && !reducedMotion()) {
        const p = strip.querySelector('.dy-pip.done:nth-child(' + justClaimed.day + ')') || strip.querySelector('.dy-pips');
        animate(p, [{ transform: 'scale(1.35)' }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.3,1.5,.6,1)' });
    }
}

function signupLine(r) {
    if (store.get('mode') === 'user') return null;
    return h('div', { class: 'dy-signup' },
        h('span', { text: 'The ' + itemName(r.item) + ' needs an account. ' }),
        h('button', { type: 'button', class: 'dy-link', text: 'Sign up to claim it', onclick: () => hooks.onSignup() }));
}

// "Bank 3,200 gems · On the shelf: Hexie · Raid Night Sat 8:00 PM (in 2d 4h)"
function paintReasons() {
    if (!reasonsEl) return;
    const bits = [];
    if (st.bank > 0) bits.push(['Bank ', fmt(st.bank) + ' gems']);
    if (st.shop) bits.push(['On the shelf: ', st.shop.name]);
    const card = document.getElementById('eventCard');
    const c = EV && (!card || card.hidden) ? EV.current(EV.now()) : null;
    if (c && !c.live && c.ms < 21 * 864e5) bits.push([c.ev.name + ' ', EV.localWhen(c.ev, EV.now()) + ' (in ' + EV.countdown(c.ms) + ')']);
    const line = JSON.stringify(bits);
    if (line === lastLine) return;
    lastLine = line;
    clear(reasonsEl);
    reasonsEl.hidden = !bits.length;
    bits.forEach((b, i) => {
        if (i) reasonsEl.appendChild(h('span', { class: 'dy-dot', text: ' · ', 'aria-hidden': 'true' }));
        reasonsEl.appendChild(h('span', null, b[0], h('b', { text: b[1] })));
    });
}

function tick() {
    if (!st) return;
    if (cdEl) {
        const left = DY.leftMs(st.readyAt, Date.now(), skew);
        cdEl.textContent = 'in ' + DY.countdown(left);
        // it unlocked while the menu was open
        if (left <= 0) { stopTick(); setTimeout(refresh, 1500); return; }
    }
    paintReasons();
}

/* ── welcome back ───────────────────────────────────────────────────── */
function openWelcomeSoon() {
    let n = 0;
    const tryOpen = () => {
        if (welcomed || inGame() || !st || !st.ready) return;
        const s = store.get();
        const busy = hasLayers() || s.mode === 'new' || hooks.playing();
        if (!busy) return openWelcome();
        if (++n < 10) setTimeout(tryOpen, 1000);   // something else is up: the strip's Claim covers it
    };
    setTimeout(tryOpen, 700);
}

export function openWelcome() {
    if (!st || !st.ready) return;
    welcomed = true;
    const r = st.today;
    const user = store.get('user');
    const rewardEl = h('div', { class: 'dy-big' },
        r.item ? itemArt(r.item, 46) : gemIcon('big'),
        h('div', { class: 'dy-big-txt' },
            h('div', { class: 'dy-big-k', text: st.missed ? 'Back on day ' + st.day : 'Day ' + st.day + ' reward ready' }),
            h('div', { class: 'dy-big-v', text: rewardText(r) })));
    const note = st.missed
        ? h('p', { class: 'dy-note', text: 'You missed a day, so you dropped back to day ' + st.day + '. Not to zero, promise.' })
        : st.streak >= 2 ? h('p', { class: 'dy-note' }, flame(st.streak, 'inline'), ' days in a row. Keep it going!') : null;
    const btn = h('button', { type: 'button', class: 'wl-opt wl-opt-guest dy-go', 'data-autofocus': '' }, h('span', { text: 'Claim' }));
    const tmrEl = h('p', { class: 'dy-after', hidden: true });
    const body = h('div', { class: 'dy-back' },
        h('div', { class: 'dy-back-h', text: user ? 'Welcome back, ' + user.username + '!' : 'Welcome back!' }),
        h('div', { class: 'dy-back-bank' }, gemIcon(), h('span', null, 'Your bank: ', h('b', { text: fmt(st.bank) + ' gems' }))),
        pips('big'),
        rewardEl,
        r.signup && store.get('mode') !== 'user' ? h('p', { class: 'dy-note' }, 'The ' + itemName(r.item) + ' needs an account. ',
            h('button', { type: 'button', class: 'dy-link', text: 'Sign up to claim it', onclick: () => { m.close(); hooks.onSignup(); } })) : null,
        note,
        tmrEl,
        btn);
    const m = modal({ cls: 'dy-modal', title: null, body, dismissable: true, focus: '.dy-go', onClose: () => paint() });
    m.card.prepend(h('button', { type: 'button', class: 'wl-x dy-x', 'aria-label': 'Close', onclick: () => m.close() }, icon('close')));
    let claimed = false;
    btn.onclick = async () => {
        if (claimed) {
            m.close();
            const play = document.getElementById('startButton');
            if (play && !play.disabled) setTimeout(() => play.click(), 60);
            return;
        }
        btn.disabled = true;
        const c = await claim();
        btn.disabled = false;
        if (!c) { m.close(); return; }
        claimed = true;
        rewardEl.querySelector('.dy-big-k').textContent = 'Claimed!';
        rewardEl.querySelector('.dy-big-v').textContent = '+' + rewardText(c);
        rewardEl.classList.add('got');
        const old = body.querySelector('.dy-pips');
        if (old) old.replaceWith(pipsAfter(c));
        const t = st.tomorrow;
        tmrEl.textContent = 'Tomorrow: ' + rewardText(t) + ', in ' + DY.countdown(DY.leftMs(st.readyAt, Date.now(), skew)) + '.';
        tmrEl.hidden = false;
        btn.firstChild.textContent = 'Play';
        btn.prepend(icon('play'));
        animate(rewardEl, [{ transform: 'scale(1.08)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.3,1.5,.6,1)' });
        btn.focus();
    };
}
function pipsAfter(c) {
    const p = pips('big');
    const cell = p.children[c.day - 1];
    if (cell && !reducedMotion()) animate(cell, [{ transform: 'scale(1.3) rotate(-6deg)' }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.3,1.5,.6,1)' });
    return p;
}

/* ── push ───────────────────────────────────────────────────────────── */
const pushable = () => !embedded() && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
function playedOnce() {
    return (+ls.get(RAIDS_KEY) || 0) >= 1 || (+ls.get(SESS_KEY) || 0) >= 1;
}
// one soft ask, only after a raid, never on the first load of the site
function wantAsk() {
    return !!(st && st.push && st.push.on && !st.push.subscribed && pushable() && Notification.permission === 'default'
        && !ls.get(ASK_KEY) && playedOnce() && !(freshLoad && !ls.get(RAIDS_KEY)));
}
function askCard() {
    askOpen = true;
    const box = h('div', { class: 'dy-ask', role: 'group', 'aria-label': 'Pings' },
        h('p', { text: 'Want a ping when your daily reward is ready and when Raid Night starts?' }),
        h('div', { class: 'dy-ask-btns' },
            h('button', { type: 'button', class: 'dw-btn primary sm', text: 'Sure, ping me', onclick: () => { askOpen = false; ls.set(ASK_KEY, 'yes'); turnOn(true); } }),
            h('button', { type: 'button', class: 'dw-btn sm', text: 'No thanks', onclick: () => { askOpen = false; ls.set(ASK_KEY, 'no'); paint(); } })));
    return box;
}
function b64uBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}
async function registration() {
    return navigator.serviceWorker.register('/service-worker.js');
}
async function sendSub(sub) {
    const r = await api.pushSubscribe({ subscription: sub.toJSON ? sub.toJSON() : sub, guestId: guestId() });
    return r.ok;
}
async function turnOn(loud) {
    if (!st || !st.push || !st.push.on || !pushable()) return;
    try {
        // the worker starts installing while the browser asks
        const regP = registration();
        const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        if (perm !== 'granted') {
            if (loud) toast('No pings then. You can switch them on with the bell any time.');
            paint();
            return;
        }
        await regP;
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(st.push.key) });
        if (!(await sendSub(sub))) throw new Error('subscribe failed');
        ls.set(SYNC_KEY, String(Math.floor(Date.now() / 864e5)));
        st.push.subscribed = true;
        if (loud) toast('Pings on. Only your daily reward and Raid Night, nothing else.', { kind: 'ok', duration: 5000 });
    } catch (e) {
        if (loud) toast('This browser wouldn’t do pings. Sorry!', { kind: 'error' });
    }
    paint();
}
async function turnOff() {
    try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        const sub = reg && await reg.pushManager.getSubscription();
        if (sub) { await api.pushUnsubscribe(sub.endpoint); await sub.unsubscribe(); }
    } catch (e) { /* the server side still drops it on the next 410 */ }
    if (st && st.push) st.push.subscribed = false;
    ls.set(ASK_KEY, 'no');
    toast('Pings off.');
    paint();
}
function bellButton() {
    if (!st || !st.push || !st.push.on || !pushable() || Notification.permission === 'denied') return null;
    const on = !!st.push.subscribed && Notification.permission === 'granted';
    // before the first raid there's nothing to ring about yet
    if (!on && !playedOnce()) return null;
    return h('button', {
        type: 'button', class: 'dy-bell' + (on ? ' on' : ''), title: on ? 'Pings are on. Click to turn them off' : 'Get a ping when your reward is ready',
        'aria-label': on ? 'Turn pings off' : 'Turn pings on', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => (on ? turnOff() : turnOn(true)),
    }, bellSvg(on));
}
function bellSvg(on) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'dw-ic');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0');
    s.appendChild(p);
    if (!on) {
        const x = document.createElementNS(SVG_NS, 'path');
        x.setAttribute('d', 'M4 4l16 16');
        x.setAttribute('class', 'dy-bell-x');
        s.appendChild(x);
    }
    return s;
}
// Visits keep the subscription fresh on the server (once a day), and a
// browser that lost it (cleared, or a new key on the server) gets it back.
async function syncPush() {
    if (!st || !st.push || !st.push.on || !pushable() || Notification.permission !== 'granted') return;
    const today = String(Math.floor(Date.now() / 864e5));
    try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        if (!reg) return;
        let sub = await reg.pushManager.getSubscription();
        const key = sub && sub.options && sub.options.applicationServerKey;
        if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== st.push.key) {
            await sub.unsubscribe();
            sub = null;
        }
        if (!sub && ls.get(ASK_KEY) === 'yes') sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(st.push.key) });
        if (!sub) return;
        if (ls.get(SYNC_KEY) === today && st.push.subscribed) return;
        if (await sendSub(sub)) { ls.set(SYNC_KEY, today); st.push.subscribed = true; paint(); }
    } catch (e) { /* quietly try again next visit */ }
}

// QA hook (standalone renders): draw from a canned status
window.dwDaily = { state: () => st, paint: (s) => { take(s); paint(); }, welcome: (s) => { if (s) take(s); welcomed = false; openWelcome(); }, ask: () => { askOpen = true; paint(); } };
