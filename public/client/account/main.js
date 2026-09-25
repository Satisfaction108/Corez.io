// Account UI boot. home.js has already set <html data-acct> from
// localStorage.dwAcctHint before first paint ('new' shows the welcome gate
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
    // what you have on, as wire numbers: { nameStyle, skin, customColor }
    equippedCos() {
        const u = store.get('user'), eq = u && u.equipped, C = window.DWCosmetics;
        if (!eq || !C) return { nameStyle: 0, skin: 0, customColor: null };
        const ns = C.byId(eq.nameStyle), sk = C.byId(eq.skin);
        return { nameStyle: ns ? ns.nid : 0, skin: sk ? sk.nid : 0, customColor: eq.customColor || null };
    },
    refresh: () => refresh(),
    // the raid death screen's "Create account": opens sign-up once the
    // menu is back (the game is still sliding away when it is called)
    openSignup() {
        if (store.get('offline')) return;
        if (inGame()) { signupOnMenu = true; return; }
        welcome.open('auth', { tab: 'signup', dismissable: true });
    },
};
let signupOnMenu = false;

/* ── transitions ────────────────────────────────────────────────────── */
function goGuest() {
    ls.set(HINT, 'guest');
    setMode('guest');
    welcome.close();
    const inp = document.getElementById('playerNameInput');
    if (inp) setTimeout(() => inp.focus(), 40);
}

function onAuthed(user) {
    ss.del('dwPickDismissed');
    setUser(user);
    setMode('user');
}

function loggedOut(message) {
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
    loggedOut('Your account is deleted. Thanks for playing!');
}

function openAccount(opts) {
    if (!store.get('user')) return;
    if (welcome.isOpen()) return;
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
            if (!offlineToastShown) { offlineToastShown = true; ui.toast('Accounts are down right now, so you’re playing as a guest.'); }
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
        ui.toast('You were logged out.', { actions: [{ label: 'Log in', onClick: () => welcome.open('auth', { tab: 'login' }) }] });
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
    discord_disabled: 'Discord login isn’t set up on this server yet.',
    access_denied: 'Discord login cancelled.',
    cancelled: 'Discord login cancelled.',
    state: 'That Discord login link expired. Please try again.',
    bad_state: 'That Discord login link expired. Please try again.',
    invalid_state: 'That Discord login link expired. Please try again.',
    expired: 'That Discord login link expired. Please try again.',
    banned: 'This account is banned.',
    rate_limited: 'Whoa, too many tries! Wait a minute and try again.',
    not_logged_in: 'Log in first, then link Discord.',
    no_session: 'Log in first, then link Discord.',
    reauth_mismatch: 'That wasn’t the Discord account linked to this Corez.io account.',
    wrong_account: 'That wasn’t the Discord account linked to this Corez.io account.',
    accounts_disabled: 'Accounts are down right now.',
    accounts_unavailable: 'Accounts are down right now.',
    reauth_required: 'Confirm your password first, then link Discord.',
    already_linked: 'This account already has a Discord linked. Unlink it first.',
    busy: 'The server’s busy. Try again in a few seconds!',
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
    if (p.auth === 'ok' && user) ui.toast('Welcome, ' + user.username + '!', { kind: 'ok' });
    if (p.auth === 'pick-username' && !store.get('pending') && !user) ui.toast('That Discord login timed out. Please try again.', { kind: 'error' });
    if (p.auth === 'error') {
        account.clearIntent();
        const why = DISCORD_ERRORS[String(p.reason || '').toLowerCase()] || 'Discord login didn’t work. Please try again.';
        if (p.reason) console.warn('[account] discord error:', p.reason);
        ui.toast(why, { kind: 'error' });
    }
    if (p.auth === 'reauth-ok') resumeIntent();
    if (p.link === 'ok' && user) { ui.toast('Discord linked!', { kind: 'ok' }); openAccount(); }
    if (p.link === 'already_linked') { ui.toast('This account already has a Discord linked. Unlink it first to link a different one.', { kind: 'error', duration: 6000 }); openAccount(); }
    if (p.link === 'taken') { ui.toast('That Discord account is already linked to another Corez.io account.', { kind: 'error', duration: 6000 }); openAccount(); }
}

function resumeIntent() {
    const intent = account.takeIntent();
    if (!store.get('user')) return;
    openAccount();
    const act = intent && intent.action;
    if (act === 'delete') account.openDelete({ reauthed: true });
    else if (act === 'recovery') account.regenAfterReauth();
    else if (act === 'username') { account.focusUsername(intent.value); ui.toast('Discord says it’s you. Hit Save to finish.', { kind: 'ok' }); }
    else ui.toast('Discord says it’s you. Go ahead and try that again!', { kind: 'ok' });
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
    if (store.get('offline')) { ui.toast('Accounts are down right now. Try the link again later.', { kind: 'error' }); return; }
    hub.close();
    welcome.open('reset', { token, dismissable: store.get('mode') !== 'new' });
}

/* ── boot ───────────────────────────────────────────────────────────── */
async function boot() {
    welcome.init({ onAuthed, onGuest: goGuest });
    account.init({ refresh, onLoggedOut: loggedOut, onDeleted, setUser });
    hub.register('account', { title: 'Account', render: account.render, onClose: account.onClose });
    hub.register('shop', { title: 'Item Shop', render: shop.render, onClose: shop.onClose });
    hub.register('locker', { title: 'Locker', render: locker.render, onClose: locker.onClose });
    // the leaderboard is open to guests; every other pane needs an account
    const openPane = (p, opts) => {
        if (welcome.isOpen()) return;
        if (p === 'play') return hub.close();
        if (p === 'leaderboard' || store.get('user')) hub.open(p, opts);
    };
    const openProfile = (from) => (p) => openPane('profile', { u: p.userId || p.username, from });
    hub.register('friends', { title: 'Friends', render: friendsPane.render, onClose: friendsPane.onClose });
    hub.register('profile', { title: 'Profile', render: profile.render, onClose: profile.onClose });
    hub.register('leaderboard', { title: 'Leaderboard', render: leaderboard.render, onClose: leaderboard.onClose });
    friendsPane.init({ openProfile: openProfile('friends') });
    ingameChat.init();
    profile.init({ openPane, setTitle: hub.setTitle });
    leaderboard.init({ openProfile: openProfile('leaderboard'), onLogin: () => welcome.open('choose', { dismissable: true }) });
    dailyQuests.init({ onLogin: () => { if (!store.get('offline')) welcome.open('choose', { dismissable: true }); } });
    social.init({
        onRevoked: () => loggedOut('You were logged out.'),
        refreshMe: () => refresh(true),
        openPane,
        onStoreReset() { menu.render(); dailyQuests.refresh(); },
    });
    shop.init({
        refreshMe: () => refresh(true),
        openLocker: () => openPane('locker'),
        // the chip shows the new balance at once, before /api/me answers
        onBalance(dust) { const u = store.get('user'); if (u && typeof dust === 'number' && u.dust !== dust) setUser(Object.assign({}, u, { dust })); },
    });
    locker.init({ refreshMe: () => refresh(true), openShop: () => openPane('shop') });
    menu.init({
        onChip() {
            if (store.get('user')) return hub.isOpen() && hub.currentPane() === 'account' ? hub.close() : openAccount();
            if (store.get('offline')) return ui.toast('Accounts are down right now. Try again soon!');
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
    store.on((s, changed) => {
        if (changed.indexOf('user') >= 0 && hub.currentPane() === 'account') hub.refresh('account');
    });

    const hint = ls.get(HINT);
    setMode(hint === 'user' ? 'user' : hint === 'guest' ? 'guest' : 'new');
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
    schedule();
    social.sync();
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
            hub.close();
            ui.closeAllModals();
            if (welcome.isOpen()) welcome.close();
        } else {
            if (html.getAttribute('data-acct') === 'new') welcome.open('choose');
            refresh();
            schedule();
            if (signupOnMenu) {
                signupOnMenu = false;
                setTimeout(() => { if (!inGame() && !store.get('user')) welcome.open('auth', { tab: 'signup', dismissable: true }); }, 350);
            }
            // a rank-up the game never got to show plays here
            setTimeout(() => { if (!inGame() && !welcome.isOpen()) rankCeremony.playPending(); }, 700);
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

boot().catch((e) => {
    // never leave a player stuck behind the gate
    console.error('[account] boot failed', e);
    if (html.getAttribute('data-acct') === 'new') { welcome.close(); html.setAttribute('data-acct', 'guest'); }
});
