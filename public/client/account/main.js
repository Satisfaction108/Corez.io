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
    refresh: () => refresh(),
};

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
    ls.set(HINT, 'new');
    hub.close();
    ui.closeAllModals();
    setMode('new');
    welcome.open('choose');
    if (message) ui.toast(message);
}

function onDeleted() {
    ls.del(NAME);
    loggedOut('Your account was deleted.');
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
            if (!offlineToastShown) { offlineToastShown = true; ui.toast('Accounts are offline right now, so you’re playing as a guest.'); }
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
        if (welcome.isOpen() && welcome.currentView() !== 'code') welcome.close();
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
async function refresh() {
    if (inGame() || store.get('offline')) return;
    if (inflight) return inflight;
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
    access_denied: 'Discord login was cancelled.',
    cancelled: 'Discord login was cancelled.',
    state: 'That Discord login link expired. Please try again.',
    bad_state: 'That Discord login link expired. Please try again.',
    invalid_state: 'That Discord login link expired. Please try again.',
    expired: 'That Discord login link expired. Please try again.',
    banned: 'This account is banned.',
    rate_limited: 'Too many attempts. Wait a minute, then try again.',
    not_logged_in: 'Log in first, then link Discord.',
    no_session: 'Log in first, then link Discord.',
    reauth_mismatch: 'That wasn’t the Discord account linked to this Dig Wars account.',
    wrong_account: 'That wasn’t the Discord account linked to this Dig Wars account.',
    accounts_disabled: 'Accounts are offline right now.',
    accounts_unavailable: 'Accounts are offline right now.',
    reauth_required: 'Confirm your password first, then link Discord.',
    already_linked: 'This account already has a Discord linked. Unlink it first.',
    busy: 'The server is busy. Try again in a few seconds.',
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
    if (p.auth === 'ok' && user) ui.toast('Logged in as ' + user.username + '.', { kind: 'ok' });
    if (p.auth === 'pick-username' && !store.get('pending') && !user) ui.toast('That Discord sign-in expired. Please try again.', { kind: 'error' });
    if (p.auth === 'error') {
        account.clearIntent();
        const why = DISCORD_ERRORS[String(p.reason || '').toLowerCase()] || 'Discord login didn’t work. Please try again.';
        if (p.reason) console.warn('[account] discord error:', p.reason);
        ui.toast(why, { kind: 'error' });
    }
    if (p.auth === 'reauth-ok') resumeIntent();
    if (p.link === 'ok' && user) { ui.toast('Discord linked.', { kind: 'ok' }); openAccount(); }
    if (p.link === 'already_linked') { ui.toast('This account already has a Discord linked. Unlink it first to link a different one.', { kind: 'error', duration: 6000 }); openAccount(); }
    if (p.link === 'taken') { ui.toast('That Discord account is already linked to another Dig Wars account.', { kind: 'error', duration: 6000 }); openAccount(); }
}

function resumeIntent() {
    const intent = account.takeIntent();
    if (!store.get('user')) return;
    openAccount();
    const act = intent && intent.action;
    if (act === 'delete') account.openDelete({ reauthed: true });
    else if (act === 'recovery') account.regenAfterReauth();
    else if (act === 'username') { account.focusUsername(intent.value); ui.toast('Discord confirmed it’s you. Press Save to finish.', { kind: 'ok' }); }
    else ui.toast('Discord confirmed it’s you. Try that again now.', { kind: 'ok' });
}

/* ── boot ───────────────────────────────────────────────────────────── */
async function boot() {
    welcome.init({ onAuthed, onGuest: goGuest });
    account.init({ refresh, onLoggedOut: loggedOut, onDeleted, setUser });
    hub.register('account', { title: 'Account', render: account.render, onClose: account.onClose });
    menu.init({
        onChip() {
            if (store.get('user')) return hub.isOpen() && hub.currentPane() === 'account' ? hub.close() : openAccount();
            if (store.get('offline')) return ui.toast('Accounts are offline right now.');
            welcome.open('auth', { tab: 'signup', dismissable: true });
        },
        onNameBox() { openAccount({ focus: 'username' }); },
        onNav(pane) {
            if (pane === 'play') return hub.close();
            if (hub.has(pane)) openAccount(); // later phases register their panes
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
    if (params.auth === 'pick-username') ss.del('dwPickDismissed');

    const [cfg, me] = await Promise.all([api.config(), api.me()]);
    const config = cfg.ok && cfg.data && typeof cfg.data.accounts === 'boolean' ? cfg.data : { accounts: false, discordLogin: false };
    store.set({ config, offline: !config.accounts });
    welcome.setAvailability(!!config.accounts, !!(config.accounts && config.discordLogin));
    lastFetch = Date.now();
    applyMe(me, true);
    handleParams(params);
    schedule();

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
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

boot().catch((e) => {
    // never leave a player stuck behind the gate
    console.error('[account] boot failed', e);
    if (html.getAttribute('data-acct') === 'new') { welcome.close(); html.setAttribute('data-acct', 'guest'); }
});
