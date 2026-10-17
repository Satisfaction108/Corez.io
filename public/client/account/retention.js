// Reasons to come back, on the menu (accounts and guests alike):
//
// the strip in the come-back card left of the menu (#dailyStrip): the 7-day
//                 reward with a live countdown (or today's, with Claim), the
// streak flame, and one quiet line of reasons: the gemdust balance (or a guest's
//                 sidekick on today's shelf, the next Raid Night when the
//                 event card above Play isn't already saying it
//   welcome back  a returning player whose reward is ready gets one short
// card on load: the gemdust, the day, a big Claim, then Play
//                 Only when nothing else is open (never a card on a card)
//   day 1         a first-time player's day 1 is claimed quietly when they
//                 come back to the menu from their first raid, so tomorrow
//                 already has something waiting. Before that first raid a
//                 guest sees none of this: just Play (client/funnel.js)
// every day clicking the card (or All days) opens a small panel with all 7 days
//   pings         after a player's first raid (never on a first load), one
//                 soft ask under the strip for a push ping when the reward is
//                 ready and before Raid Night. Asked once; the bell on the
//                 strip turns them off again
//
// The track pays gemdust (the Store / Locker currency) and two common items a
// Rules, rewards and the clock live on the server (server/accounts/
// retention.js, shared/daily.js); this only draws what /api/daily says.
import * as api from './api.js';
import * as store from './state.js';
import { h, icon, clear, modal, toast, animate, reducedMotion, hasLayers, fmtDust, T_MID } from './ui.js';
import { achIcon } from './achievements.js';
import * as skArt from '../sidekickArt.js';
import * as pv from './previews.js';
import * as view from './dailyView.js';

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
let skinFrom = null;
function cheapestSkin() {
    if (skinFrom != null) return skinFrom;
    const C = window.DWCosmetics;
    let best = 0;
    if (C && Array.isArray(C.ITEMS)) for (const it of C.ITEMS) if (it.cat === 'skin' && it.price > 0 && !it.exclusive && (!best || it.price < best)) best = it.price;
    skinFrom = best ? dustTxt(best) : '';
    return skinFrom;
}
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
    // the card (not its buttons) opens every day's prize
    strip.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('button, a, input, .dy-ask')) return;
        openDays();
    });
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
    if (s.mode === 'new' || s.offline || (s.mode !== 'user' && !playedBefore())) { st = null; paint(); return; }
    const seq = ++loadSeq;
    const r = await api.daily(guestId());
    if (seq !== loadSeq || inGame()) return;
    if (!r.ok || !r.data || !r.data.on) { st = null; paint(); return; }
    take(r.data);
    const brought = r.data.adoptedNow ? adoptedText(r.data.adoptedNow) : '';
    if (brought) toast('Your guest streak came with you, plus ' + brought + '!', { kind: 'ok', duration: 6000 });
    syncPush();
    // a brand new player: day 1 is theirs on the first visit, no card about it
    if (st.claims === 0 && st.ready) { await claim({ quiet: true }); return; }
    paint();
    if (st.ready && st.claims > 0 && !welcomed && freshLoad) openWelcomeSoon();
}

// A guest who hasn't been in a raid yet: no strip, no claim, no toast.
function playedBefore() {
    const F = window.DWFunnel;
    return !F || !F.hasPlayed || F.hasPlayed();
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
        if (opts.quiet) {
            toast(c.signup ? 'Day 1 reward: ' + rewardText(c) + ', saved for when you sign up. Come back tomorrow for more!'
                : 'Day 1 reward: +' + rewardText(c) + ' to spend in the shop. Come back tomorrow for more!', { kind: 'ok', duration: 5200 });
        }
        if (typeof r.data.balanceMilli === 'number' && hooks.onDust) hooks.onDust(r.data.balanceMilli / 1000);
        paint(c);
        return c;
    }
    const code = r.data && r.data.error && r.data.error.code;
    if (code === 'not_ready' || code === 'already_claimed') { refresh(); return null; }
    if (code === 'adopted') { toast('Your streak is on your account now. Log in to claim it.'); return null; }
    if (!opts.quiet) toast((r.data && r.data.error && r.data.error.message) || 'Couldn’t claim it. Please try again in a moment.', { kind: 'error' });
    return null;
}

/* ── words ──────────────────────────────────────────────────────────── */
function itemName(it) {
    if (!it) return '';
    if (it.cat === 'sidekick') return it.name + ' sidekick';
    if (it.cat === 'sdSkin') return it.name + ' skin';
    if (it.cat === 'sdName') return it.name + ' sidekick name';
    if (it.cat === 'nameStyle') return it.name + ' name style';
    if (it.cat === 'skin') return it.name + ' skin';
    return it.name;
}
// "1.5 gemdust", "Buddy sidekick" (an item day pays dust only when the item is
export function rewardText(r, opts = {}) {
    if (!r) return '';
    const bits = [];
    if (r.item) bits.push(itemName(r.item));
    if (r.dustMilli > 0) bits.push(dustTxt(r.dustMilli) + ' gemdust');
    return bits.join(opts.sep || ' + ');
}
function adoptedText(a) {
    const bits = (a.items || []).map(itemName);
    if (a.dustMilli > 0) bits.push(dustTxt(a.dustMilli) + ' gemdust');
    return bits.join(' and ');
}
// the line's bold part: amethyst when it's just dust
function rewardB(r) {
    return h('b', { class: r && !r.item ? 'dy-dust-amt' : null, text: rewardText(r) });
}

/* ── little art ─────────────────────────────────────────────────────── */
const SVG_NS = 'http://www.w3.org/2000/svg';
// the gemdust icon the Store and quests use
const dustIcon = () => icon('dust', 'dy-dust');
// A sidekick (or Buddy wearing a skin) drawn by the game's own art.
function itemArt(it, size) {
    const item = it && C ? C.byId(it.id) : null;
    if (!item) return dustIcon();
    try {
        if (item.cat === 'nameStyle') return pv.nameCanvas('Aa', item, { px: Math.max(12, Math.round(size * 0.48)), stroke: true, h: size, maxW: Math.max(size, 36), cls: 'dy-art dw-name-cv' });
        if (item.cat === 'skin') return pv.tankPreview({ w: size, h: size, skin: item, color: pv.TEAM_COLORS[0].col, size: size * 0.29, rot: -0.55, cls: 'dy-art dw-prev' });
    } catch (e) { void e; }
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
    } catch (e) { return dustIcon(); }
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
        const art = r.item ? itemArt(r.item, size === 'big' ? 30 : 18) : dustIcon();
        row.appendChild(h('div', { class: 'dy-pip' + cls + (r.item ? ' item' : ''), role: 'listitem', title: 'Day ' + i + ': ' + rewardText(r) + (r.signup ? ' (sign up to claim it)' : '') },
            size === 'big' ? h('span', { class: 'dy-pip-d', text: 'Day ' + i }) : null,
            art,
            size === 'big' ? h('span', { class: 'dy-pip-g', text: r.item ? (r.signup ? 'sign up' : 'free') : dustTxt(r.dustMilli) }) : null,
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
    const head = h('div', { class: 'dy-head' }, h('span', { class: 'dy-title', text: 'Daily rewards' }),
        h('button', { type: 'button', class: 'dy-link dy-all', text: 'All days', 'aria-haspopup': 'dialog', onclick: () => openDays() }));
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
            h('span', { class: 'dy-what' }, h('span', { class: 'dy-lead', text: lead + ' ' }), rewardB(st.today)),
            h('button', { type: 'button', class: 'dw-btn primary sm dy-claim', text: 'Claim', onclick: (e) => { e.currentTarget.disabled = true; claim(); } })));
        const su = st.today.signup ? signupLine(st.today) : null;
        if (su) strip.appendChild(su);
    } else {
        cdEl = h('span', { class: 'dy-cd' });
        const tmr = st.tomorrow || st.today;
        const lead = justClaimed ? 'Got it! Tomorrow:' : st.step === 7 ? 'Week complete! Tomorrow:' : 'Tomorrow:';
        strip.appendChild(h('div', { class: 'dy-line' },
            h('span', { class: 'dy-what' }, h('span', { class: 'dy-lead', text: lead + ' ' }), rewardB(tmr)),
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

// "The Buddy sidekick needs an account." / "Gemdust needs an account."
function signupWords(r) {
    return (r.item ? 'You need an account for the ' + itemName(r.item) : 'You need an account for gemdust') + '. ';
}
function signupLine(r) {
    if (store.get('mode') === 'user') return null;
    return h('div', { class: 'dy-signup' },
        h('span', { text: signupWords(r) }),
        h('button', { type: 'button', class: 'dy-link', text: 'Sign up to claim it', onclick: () => hooks.onSignup() }));
}
// an account's gemdust balance (the chip's number), or null
function dustBalance() {
    const u = store.get('mode') === 'user' ? store.get('user') : null;
    return u && typeof u.dust === 'number' ? u.dust : null;
}

// "Gemdust 12.50 · On the shelf: Hexie · Raid Night Sat 8:00 PM (in 2d 4h)" (a
function paintReasons() {
    if (!reasonsEl) return;
    const bits = [];
    const bal = dustBalance();
    if (bal != null) bits.push(['Gemdust ', fmtDust(bal)]);
    else if (st.owedMilli > 0) bits.push(['Saved for when you sign up: ', dustTxt(st.owedMilli) + ' gemdust']);
    const from = cheapestSkin();
    if (from) bits.push(['Skins from ', from + ' gemdust']);
    if (st.shop) bits.push(['In the shop: ', st.shop.name + (st.shop.price > 0 ? ' (' + st.shop.price + ' gemdust)' : '')]);
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

/* ── every day's prize ──────────────────────────────────────────────── */
let daysM = null;
export function openDays() {
    if (!st || !st.on || daysM || inGame()) return;
    const guest = store.get('mode') !== 'user';
    const v = view.rows(st, DY, { guest });
    const list = h('ol', { class: 'dyd-list' });
    for (const r of v.rows) {
        let tag = view.STATE_WORDS[r.state];
        if (r.state === 'next' && !st.ready) tag = 'In ' + DY.countdown(DY.leftMs(st.readyAt, Date.now(), skew));
        list.appendChild(h('li', { class: 'dyd-row ' + r.state + (r.item ? ' item' : '') },
            h('span', { class: 'dyd-day', text: 'Day ' + r.day }),
            h('span', { class: 'dyd-art' }, r.item ? itemArt(r.item, 26) : dustIcon()),
            h('span', { class: 'dyd-txt' }, h('b', { text: r.text }), r.note ? h('small', { text: r.note }) : null),
            r.state === 'done' ? h('span', { class: 'dyd-tag done', 'aria-label': 'Claimed' }, icon('check'))
                : tag ? h('span', { class: 'dyd-tag', text: tag }) : null));
    }
    const body = h('div', { class: 'dyd' },
        h('div', { class: 'dyd-h' }, h('span', { text: 'Daily rewards' }), st.streak >= 2 ? flame(st.streak, 'inline') : null),
        list,
        h('p', { class: 'dyd-rule', text: v.rule }),
        guest ? h('p', { class: 'dyd-su' }, h('span', { text: 'You need an account for gemdust and items. ' }),
            h('button', { type: 'button', class: 'dy-link', text: 'Sign up to claim them', onclick: () => { m.close(); hooks.onSignup(); } })) : null);
    const m = modal({ cls: 'dyd-modal', title: null, body, dismissable: true, onClose: () => { daysM = null; } });
    m.card.setAttribute('aria-label', 'Daily rewards, all 7 days');
    m.card.prepend(h('button', { type: 'button', class: 'wl-x dy-x', 'aria-label': 'Close', 'data-autofocus': '', onclick: () => m.close() }, icon('close')));
    daysM = m;
    return m;
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
        r.item ? itemArt(r.item, 46) : dustIcon(),
        h('div', { class: 'dy-big-txt' },
            h('div', { class: 'dy-big-k', text: st.missed ? 'Back on day ' + st.day : 'Your day ' + st.day + ' reward is ready' }),
            h('div', { class: 'dy-big-v', text: rewardText(r) })));
    const note = st.missed
        ? h('p', { class: 'dy-note', text: 'You missed a day, so you dropped back to day ' + st.day + '. Don’t worry, it never drops to zero.' })
        : st.streak >= 2 ? h('p', { class: 'dy-note' }, flame(st.streak, 'inline'), ' days in a row. Keep it going!') : null;
    const btn = h('button', { type: 'button', class: 'wl-opt wl-opt-guest dy-go', 'data-autofocus': '' }, h('span', { text: 'Claim' }));
    const tmrEl = h('p', { class: 'dy-after', hidden: true });
    const body = h('div', { class: 'dy-back' },
        h('div', { class: 'dy-back-h', text: user ? 'Welcome back, ' + user.username + '!' : 'Welcome back!' }),
        dustLine(),
        pips('big'),
        rewardEl,
        r.signup && store.get('mode') !== 'user' ? h('p', { class: 'dy-note' }, signupWords(r),
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
        rewardEl.querySelector('.dy-big-v').textContent = (c.signup ? 'Saved: ' : '+') + rewardText(c);
        rewardEl.classList.add('got');
        const bankEl = body.querySelector('.dy-back-bank'), fresh = dustLine();
        if (bankEl && fresh) bankEl.replaceWith(fresh);
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
// "Your gemdust: 12.50" (accounts), "Saved for sign up: 2.5 gemdust" (a guest
function dustLine() {
    const bal = dustBalance();
    if (bal == null && !(st.owedMilli > 0)) return null;
    return h('div', { class: 'dy-back-bank' }, dustIcon(), bal != null
        ? h('span', null, 'Your gemdust: ', h('b', { class: 'dy-dust-amt', text: fmtDust(bal) }))
        : h('span', null, 'Saved for when you sign up: ', h('b', { class: 'dy-dust-amt', text: dustTxt(st.owedMilli) + ' gemdust' })));
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
            if (loud) toast('Okay, no pings. You can turn them on with the bell any time.');
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
        if (loud) toast('Pings are on. We’ll only ping you for your daily reward and Raid Night.', { kind: 'ok', duration: 5000 });
    } catch (e) {
        if (loud) toast('Sorry, this browser doesn’t support pings.', { kind: 'error' });
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
    toast('Pings are off.');
    paint();
}
function bellButton() {
    if (!st || !st.push || !st.push.on || !pushable() || Notification.permission === 'denied') return null;
    const on = !!st.push.subscribed && Notification.permission === 'granted';
    // before the first raid there's nothing to ring about yet
    if (!on && !playedOnce()) return null;
    return h('button', {
        type: 'button', class: 'dy-bell' + (on ? ' on' : ''), title: on ? 'Pings are on. Click to turn them off.' : 'Get a ping when your reward is ready',
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
window.dwDaily = { days: () => openDays(), state: () => st, paint: (s) => { take(s); paint(); }, welcome: (s) => { if (s) take(s); welcomed = false; openWelcome(); }, ask: () => { askOpen = true; paint(); } };
