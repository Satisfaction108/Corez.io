// Account UI boot. home.js has already set <html data-acct> from
// localStorage.dwAcctHint before first paint ('new', stored on log out, shows the welcome gate
// from CSS alone); this module confirms the real state with /api/me, handles
// the ?auth= / ?link= redirects from Discord, and exposes window.dwAccount
// for app.js (playName, blocksEnter).
import * as api from './api.js';
import * as store from './state.js';
import * as ui from './ui.js';
import * as welcome from './welcome.js';
import * as hub from './hub.js';
import * as menu from './menu.js';
import * as account from './accountSettings.js';
import * as rankCeremony from './rankCeremony.js';
import * as shop from './shop.js';
import * as locker from './locker.js';
import * as social from './social.js';
import * as friendsPane from './friendsPane.js';
import * as profile from './profile.js';
import * as leaderboard from './leaderboard.js';
import * as dailyQuests from './dailyQuests.js';
import * as ingameChat from './ingameChat.js';
import * as gameToasts from './gameToasts.js';
import * as invite from './invite.js';
import * as feedback from './feedback.js';
import * as eventCard from './eventCard.js';
import * as retention from './retention.js';
import * as achHome from './achHome.js';
import * as levels from './levels.js';

const html = document.documentElement;
const HINT = 'dwAcctHint';
const NAME = 'dwAcctName';
const POLL_MS = 60000;

const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } },
};
const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* */ } },
};
const inGame = () => document.body.classList.contains('in-game');

function setMode(mode) {
    html.setAttribute('data-acct', mode);
    store.set({ mode });
}

// Only publish a user object when something in it actually changed, so the
// 60 s poll doesn't re-render open forms.
let userSig = 'null';
function setUser(user) {
    // a rank-up the player never saw (settled after they left a raid, or on
    // a disconnect) is owed from the rank this browser last showed
    try {
        if (user && user.userId && rankCeremony.setUser(user.userId, user.rank) && !inGame()) {
            setTimeout(() => { if (!inGame() && !welcome.isOpen()) rankCeremony.playPending(); }, 700);
        }
    } catch (e) { /* the menu must never break over this */ }
    const sig = JSON.stringify(user || null);
    if (sig === userSig) return;
    userSig = sig;
    store.set({ user: user || null });
    if (user) {
        ls.set(HINT, 'user');
        ls.set(NAME, user.username);
        ls.set('dwPlayed', '1');
        try { document.documentElement.classList.remove('dw-fresh'); } catch (e) { void e; }
        setMode('user');
    }
}

window.dwAccount = {
    // the name app.js should play under, or null to use the guest name input
    playName() {
        const u = store.get('user');
        if (u) return u.username;
        return store.get('mode') === 'user' ? (ls.get(NAME) || null) : null;
    },
    // true while any account overlay is up; app.js then ignores Enter
    blocksEnter() {
        return ui.hasLayers() || html.getAttribute('data-acct') === 'new';
    },
    me() { return store.get('user'); },
    canSignUp() { return !store.get('offline') && !store.get('user'); },
    // what you have on, as wire numbers: { nameStyle, skin, customColor }
    equippedCos() {
        const u = store.get('user'), eq = u && u.equipped, C = window.DWCosmetics;
        if (!eq || !C) return { nameStyle: 0, skin: 0, customColor: null };
        const ns = C.byId(eq.nameStyle), sk = C.byId(eq.skin);
        return { nameStyle: ns ? ns.nid : 0, skin: sk ? sk.nid : 0, customColor: eq.customColor || null };
    },
    refresh: () => refresh(),
    // the raid death screen's "Get an account" and the post-raid "Keep my
    // stuff" card: the one-tap sheet (the full sign-up is a link in it),
    // once the menu is back (the game is still sliding away when it is called)
    // opts: { headline }
    openSignup(opts) {
        if (store.get('offline') || store.get('user')) return;
        if (inGame()) { signupOnMenu = opts || {}; return; }
        openQuick(opts);
    },
    openLogin() {
        if (store.get('user')) return openAccount();
        if (store.get('offline')) return ui.toast('Accounts are down right now. Please try again soon.');
        welcome.open('auth', { tab: 'login', dismissable: true });
    },
};
let signupOnMenu = null;
// The raid's achievements replay on the home screen (achHome.js), once the
// rank ceremony, the hub and any sheet are out of the way.
let achTimer = 0;
function achMoment(delay) {
    clearTimeout(achTimer);
    let tries = 0;
    const go = () => {
        if (inGame() || achHome.isPlaying() || !achHome.waiting()) return;
        if (welcome.isOpen() || ui.hasLayers() || hub.isOpen() || rankCeremony.playing() || rankCeremony.pending()) {
            if (++tries < 50) achTimer = setTimeout(go, 600);
            return;
        }
        achHome.play({ onKeep: () => openQuick() });
    };
    achTimer = setTimeout(go, delay);
}
function openQuick(opts) {
    if (store.get('offline') || store.get('user')) return;
    welcome.open('quick', Object.assign({}, opts || {}, { dismissable: true }));
}

/* ── transitions ────────────────────────────────────────────────────── */
function goGuest() {
    ls.set(HINT, 'guest');
    setMode('guest');
    welcome.close();
    const inp = document.getElementById('playerNameInput');
    if (inp) setTimeout(() => inp.focus(), 40);
}

function onAuthed(user, how, data) {
    ss.del('dwPickDismissed');
    try { levels.carried(user, data); } catch (e) { console.error('[levels] carry over failed', e); }
    setUser(user);
    setMode('user');
}

function loggedOut(message) {
    achHome.stop();
    setUser(null);
    ls.del('dwAcctRank');
    ls.set(HINT, 'new');
    hub.close();
    ui.closeAllModals();
    setMode('new');
    welcome.open('choose');
    if (message) ui.toast(message);
}

function onDeleted() {
    ls.del(NAME);
    loggedOut('Your account was deleted. Thanks for playing!');
}

function openAccount(opts) {
    if (!store.get('user')) return;
    if (welcome.isOpen()) return;
    // password, Discord linking and account deletion never run inside
    // someone else's frame
    if (welcome.embedded()) return welcome.openInTab('/#account');
    hub.open('account', opts);
}

/* ── /api/me ────────────────────────────────────────────────────────── */
let offlineToastShown = false;
function applyMe(res, initial) {
    const good = res && res.ok && res.data && typeof res.data === 'object' && 'user' in res.data;
    if (!good || store.get('offline')) {
        // No usable answer: accounts are off, or the API is missing/unreachable.
        if (!initial) return;
        if (html.getAttribute('data-acct') === 'user') {
            // keep the hint so they're recognised once accounts are back
            setMode('guest');
            if (!offlineToastShown) { offlineToastShown = true; ui.toast('Accounts are down right now, so you’re playing as a guest for now.'); }
        } else if (html.getAttribute('data-acct') === 'new') {
            welcome.open('choose');
        }
        return;
    }
    const user = res.data.user || null;
    const pending = res.data.pendingDiscord || null;
    store.set({ pending });
    if (user) {
        setUser(user);
        if (welcome.isOpen() && welcome.currentView() !== 'code' && welcome.currentView() !== 'reset') welcome.close();
        return;
    }
    const wasUser = store.get('mode') === 'user';
    setUser(null);
    if (pending && !ss.get('dwPickDismissed')) {
        if (wasUser) { ls.set(HINT, 'new'); setMode('new'); }
        hub.close();
        welcome.open('pick', { dismissable: store.get('mode') === 'guest' });
        return;
    }
    if (wasUser) {
        hub.close();
        ui.closeAllModals();
        ls.set(HINT, 'new');
        setMode('new');
        welcome.open('choose');
        ui.toast('You got logged out.', { actions: [{ label: 'Log in', onClick: () => welcome.open('auth', { tab: 'login' }) }] });
        return;
    }
    if (store.get('mode') === 'new' && !welcome.isOpen()) welcome.open('choose');
}

let lastFetch = 0, pollTimer = 0, inflight = null;
async function refresh(force) {
    if (inGame() || store.get('offline')) return;
    if (inflight && !force) return inflight;
    lastFetch = Date.now();
    inflight = api.me().then((r) => { inflight = null; if (!inGame()) applyMe(r, false); });
    return inflight;
}
function schedule() {
    clearTimeout(pollTimer);
    if (inGame() || document.hidden || store.get('offline')) return;
    pollTimer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
}

/* ── ?auth= / ?link= ────────────────────────────────────────────────── */
const DISCORD_ERRORS = {
    discord_disabled: 'Discord login isn’t available on this server yet.',
    access_denied: 'Discord login was cancelled.',
    cancelled: 'Discord login was cancelled.',
    state: 'That Discord login expired. Please try again.',
    bad_state: 'That Discord login expired. Please try again.',
    invalid_state: 'That Discord login expired. Please try again.',
    expired: 'That Discord login expired. Please try again.',
    banned: 'This account is banned.',
    rate_limited: 'Too many tries. Please wait a minute.',
    not_logged_in: 'Please log in first, then link Discord.',
    no_session: 'Please log in first, then link Discord.',
    reauth_mismatch: 'That’s a different Discord. Please use the one linked to this account.',
    wrong_account: 'That’s a different Discord. Please use the one linked to this account.',
    accounts_disabled: 'Accounts are down right now.',
    accounts_unavailable: 'Accounts are down right now.',
    reauth_required: 'Please enter your password first, then link Discord.',
    already_linked: 'This account already has a Discord linked. Unlink it first.',
    busy: 'The server is busy. Please try again in a moment.',
};

function readParams() {
    const p = new URLSearchParams(location.search);
    const out = { auth: p.get('auth'), link: p.get('link'), reason: p.get('reason') };
    if (out.auth !== null || out.link !== null) {
        p.delete('auth'); p.delete('link'); p.delete('reason');
        const q = p.toString();
        try { history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) { /* */ }
    }
    return out;
}

function handleParams(p) {
    const user = store.get('user');
    if (p.auth === 'ok' && user) ui.toast('Hi, ' + user.username + '!', { kind: 'ok' });
    if (p.auth === 'pick-username' && !store.get('pending') && !user) ui.toast('Discord login timed out. Please try again.', { kind: 'error' });
    if (p.auth === 'error') {
        account.clearIntent();
        const why = DISCORD_ERRORS[String(p.reason || '').toLowerCase()] || 'Discord login didn’t work. Please try again.';
        if (p.reason) console.warn('[account] discord error:', p.reason);
        ui.toast(why, { kind: 'error' });
    }
    if (p.auth === 'reauth-ok') resumeIntent();
    if (p.link === 'ok' && user) { ui.toast('Discord linked!', { kind: 'ok' }); openAccount(); }
    if (p.link === 'already_linked') { ui.toast('This account already has a Discord linked. Unlink it first.', { kind: 'error', duration: 6000 }); openAccount(); }
    if (p.link === 'taken') { ui.toast('That Discord is already linked to another account.', { kind: 'error', duration: 6000 }); openAccount(); }
}

function resumeIntent() {
    const intent = account.takeIntent();
    if (!store.get('user')) return;
    openAccount();
    const act = intent && intent.action;
    if (act === 'delete') account.openDelete({ reauthed: true });
    else if (act === 'recovery') account.regenAfterReauth();
    else if (act === 'username') { account.focusUsername(intent.value); ui.toast('Discord confirmed it’s you. Now press Save.', { kind: 'ok' }); }
    else ui.toast('Discord confirmed it’s you. Please try that again.', { kind: 'ok' });
}

/* ── #reset=<token> ─────────────────────────────────────────────────── */
// A password-reset link. The token leaves the address bar at once, so it
// isn't kept in history or shared by accident.
function readResetToken() {
    const m = /(?:^#|&)reset=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    let token = '';
    try { token = decodeURIComponent(m[1]); } catch (e) { token = m[1]; }
    const rest = location.hash.replace(/^#/, '').split('&').filter((x) => x && !/^reset=/.test(x)).join('&');
    try { history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : '')); } catch (e) { /* */ }
    return token || null;
}
function openReset(token) {
    if (store.get('offline')) { ui.toast('Accounts are down right now. Please try the link again later.', { kind: 'error' }); return; }
    hub.close();
    welcome.open('reset', { token, dismissable: store.get('mode') !== 'new' });
}

/* ── #login / #account ──────────────────────────────────────────────── */
// A framed copy of the game (on a portal) opens these in a new tab.
function openFromHash() {
    const want = (location.hash || '').replace(/^#/, '');
    if (want !== 'login' && want !== 'account') return;
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* */ }
    if (welcome.embedded() || store.get('offline')) return;
    if (store.get('user')) { if (want === 'account') openAccount(); return; }
    welcome.open('auth', { tab: 'login', dismissable: store.get('mode') !== 'new' });
}

/* ── boot ───────────────────────────────────────────────────────────── */
async function boot() {
    invite.capture();
    welcome.init({ onAuthed, onGuest: goGuest });
    account.init({ refresh, onLoggedOut: loggedOut, onDeleted, setUser });
    hub.register('account', { title: 'Account', render: account.render, onClose: account.onClose });
    hub.register('shop', { title: 'Shop', render: shop.render, onClose: shop.onClose });
    hub.register('locker', { title: 'Locker', render: locker.render, onClose: locker.onClose });
    // the leaderboard and the shop (its look-only View all) are open to guests
    const openPane = (p, opts) => {
        if (welcome.isOpen()) return;
        if (p === 'play') return hub.close();
        if (p === 'leaderboard' || p === 'shop' || store.get('user')) hub.open(p, opts);
    };
    const openProfile = (from) => (p) => openPane('profile', { u: p.userId || p.username, from });
    hub.register('friends', { title: 'Friends', render: friendsPane.render, onClose: friendsPane.onClose });
    hub.register('profile', { title: 'Profile', render: profile.render, onClose: profile.onClose });
    hub.register('leaderboard', { title: 'Top 100', render: leaderboard.render, onClose: leaderboard.onClose });
    friendsPane.init({ openProfile: openProfile('friends') });
    ingameChat.init();
    gameToasts.init();
    profile.init({ openPane, setTitle: hub.setTitle });
    leaderboard.init({ openProfile: openProfile('leaderboard'), onLogin: () => welcome.open('choose', { dismissable: true }) });
    dailyQuests.init({ onLogin: () => { if (!store.get('offline')) welcome.open('choose', { dismissable: true }); } });
    social.init({
        onRevoked: () => loggedOut('You got logged out.'),
        refreshMe: () => refresh(true),
        openPane,
        onStoreReset() { menu.render(); dailyQuests.refresh(); },
        onShopRotated() { shop.refresh(); },
        onInvite: () => invite.onEvent(),
        onStreak: () => { dailyQuests.refresh(); refresh(true); },
    });
    shop.init({
        refreshMe: () => refresh(true),
        onLogin: () => { if (store.get('offline')) ui.toast('Accounts are down right now. Please try again soon.'); else welcome.open('choose', { dismissable: true }); },
        openLocker: (tab) => { if (tab) locker.setTab(tab); openPane('locker'); },
        // the chip shows the new balance at once, before /api/me answers
        onBalance(dust) { const u = store.get('user'); if (u && typeof dust === 'number' && u.dust !== dust) setUser(Object.assign({}, u, { dust })); },
    });
    locker.init({ refreshMe: () => refresh(true), openShop: () => openPane('shop') });
    menu.init({
        onChip() {
            if (store.get('user')) return hub.isOpen() && hub.currentPane() === 'account' ? hub.close() : openAccount();
            if (store.get('offline')) return ui.toast('Accounts are down right now. Please try again soon.');
            welcome.open('auth', { tab: 'signup', dismissable: true });
        },
        onNameBox() { openAccount({ focus: 'username' }); },
        // a guest clicked a locked nav item and chose "Log in"
        onLogin() { welcome.open('choose', { dismissable: true }); },
        onNav(pane) {
            if (pane === 'play') return hub.close();
            if (hub.has(pane)) openPane(pane);
        },
    });
    invite.init({
        refreshMe: () => refresh(true),
        onSignup() { openQuick(); },
    });
    try { feedback.init(); } catch (e) { console.error('[feedback] init failed', e); }
    try { eventCard.init(); } catch (e) { console.error('[events] init failed', e); }
    try {
        retention.init({
            onSignup() { openQuick(); },
            playing: () => rankCeremony.playing(),
            onDust(dust) { const u = store.get('user'); if (u && typeof dust === 'number' && u.dust !== dust) setUser(Object.assign({}, u, { dust })); },
        });
    } catch (e) { console.error('[daily] init failed', e); }
    try { levels.init({ onSignup() { openQuick(); }, refreshMe: () => refresh(true) }); } catch (e) { console.error('[levels] init failed', e); }
    store.on((s, changed) => {
        if (changed.indexOf('user') >= 0 && hub.currentPane() === 'account') hub.refresh('account');
    });

    const hint = ls.get(HINT);
    // The gate only greets someone who logged out here. A first-time visitor
    // (no hint yet) and a portal frame play as a guest with nothing in the way;
    // the account chip, the locked tabs and the death screen offer sign up.
    setMode(hint === 'user' ? 'user' : hint === 'new' && !welcome.embedded() ? 'new' : 'guest');
    menu.render();
    if (store.get('mode') === 'new') welcome.open('choose');

    const params = readParams();
    const resetToken = readResetToken();
    if (params.auth === 'pick-username') ss.del('dwPickDismissed');

    const [cfg, me] = await Promise.all([api.config(), api.me()]);
    const config = cfg.ok && cfg.data && typeof cfg.data.accounts === 'boolean' ? cfg.data : { accounts: false, discordLogin: false };
    store.set({ config, offline: !config.accounts });
    welcome.setAvailability(!!config.accounts, !!(config.accounts && config.discordLogin));
    lastFetch = Date.now();
    applyMe(me, true);
    handleParams(params);
    if (resetToken) openReset(resetToken);
    openFromHash();
    achMoment(1500);
    schedule();
    social.sync();
    try { retention.start(); } catch (e) { console.error('[daily] start failed', e); }
    try { levels.start(); } catch (e) { console.error('[levels] start failed', e); }
    window.addEventListener('hashchange', () => { const t = readResetToken(); if (t) openReset(t); });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return clearTimeout(pollTimer);
        if (Date.now() - lastFetch > POLL_MS) refresh();
        schedule();
    });

    // body.in-game is toggled by home.js when the menu slides away
    let wasInGame = inGame();
    new MutationObserver(() => {
        const now = inGame();
        if (now === wasInGame) return;
        wasInGame = now;
        if (now) {
            clearTimeout(pollTimer);
            clearTimeout(achTimer);
            achHome.stop();
            hub.close();
            ui.closeAllModals();
            if (welcome.isOpen()) welcome.close();
        } else {
            if (html.getAttribute('data-acct') === 'new') welcome.open('choose');
            refresh();
            schedule();
            if (signupOnMenu) {
                const opts = signupOnMenu;
                signupOnMenu = null;
                setTimeout(() => { if (!inGame() && !store.get('user')) openQuick(opts); }, 350);
            }
            // a rank-up the game never got to show plays here
            setTimeout(() => { if (!inGame() && !welcome.isOpen()) rankCeremony.playPending(); }, 700);
            // then what the raid's achievements paid
            achMoment(1100);
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

boot().catch((e) => {
    // never leave a player stuck behind the gate
    console.error('[account] boot failed', e);
    if (html.getAttribute('data-acct') === 'new') { welcome.close(); html.setAttribute('data-acct', 'guest'); }
});
