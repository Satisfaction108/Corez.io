// The welcome gate (#dwWelcome): choose Guest / Discord / username, the
// log in + sign up forms, the Discord "pick a username" step, the recovery
// code screen and recovery-code login. The choose view is static markup in
// index.html so it can show before any script runs; the rest render into
// #wlDyn.
import * as api from './api.js';
import * as store from './state.js';
import { h, icon, clear, pushLayer, popLayer, focusFirst, toast, humanError, showAlert, setBusy, copyText, downloadText, avatar, fmtDate } from './ui.js';
import { usernameField, passwordPair, passwordInput } from './fields.js';

const root = document.getElementById('dwWelcome');
const chooseView = document.getElementById('wlChoose');
const dyn = document.getElementById('wlDyn');
const closeBtn = document.getElementById('wlClose');

let opened = false;
let dismissable = false;
let view = null;
let hooks = { onAuthed() {}, onGuest() {} };

const cachedName = () => { try { return localStorage.getItem('dwAcctName') || ''; } catch (e) { return ''; } };

export function init(h0) {
    Object.assign(hooks, h0);
    document.getElementById('wlGuest').onclick = () => hooks.onGuest();
    document.getElementById('wlDiscord').onclick = () => { location.href = api.discordStartUrl('login'); };
    document.getElementById('wlPassword').onclick = () => show('auth', { tab: cachedName() ? 'login' : 'signup' });
    closeBtn.onclick = () => { if (dismissable) close(); };
}

export function setAvailability(accounts, discord) {
    root.classList.toggle('wl-offline', !accounts);
    root.classList.toggle('wl-nodiscord', accounts && !discord);
}

export const isOpen = () => opened;
export const currentView = () => view;

// view: 'choose' | 'auth' | 'pick' | 'code' | 'recover'
export function open(name, opts) {
    opts = opts || {};
    dismissable = !!opts.dismissable;
    root.classList.toggle('wl-dismissable', dismissable);
    if (!opened) {
        opened = true;
        root.classList.add('open');
        document.documentElement.classList.add('dw-wl-open');
        pushLayer(root, { onEsc, autofocus: false });
    }
    show(name, opts);
}

export function close() {
    if (!opened) return;
    opened = false;
    view = null;
    root.classList.remove('open');
    document.documentElement.classList.remove('dw-wl-open');
    popLayer(root);
    clear(dyn);
    dyn.hidden = true;
    chooseView.hidden = false;
}

function onEsc() {
    if (view === 'code') return; // must tick the box first
    if (view === 'recover') return show('auth', { tab: 'login' });
    if (view && view !== 'choose') return show('choose');
    if (dismissable) close();
}

function show(name, opts) {
    opts = opts || {};
    view = name;
    root.dataset.view = name;
    if (name === 'choose') {
        clear(dyn);
        dyn.hidden = true;
        chooseView.hidden = false;
        closeBtn.hidden = !dismissable;
        return settle();
    }
    chooseView.hidden = true;
    closeBtn.hidden = true;
    clear(dyn);
    dyn.hidden = false;
    const build = { auth: viewAuth, pick: viewPick, code: viewCode, recover: viewRecover }[name];
    dyn.appendChild(build(opts));
    settle(opts.focus);
}

function settle(selector) {
    const card = document.getElementById('wlCard');
    card.classList.remove('wl-swap');
    void card.offsetWidth; // restart the fade for the new view
    card.classList.add('wl-swap');
    setTimeout(() => { if (opened) focusFirst(view === 'choose' ? chooseView : dyn, selector); }, 30);
}

/* ── pieces ─────────────────────────────────────────────────────────── */
function topBar(back, backLabel) {
    return h('div', { class: 'wl-top' },
        back ? h('button', { type: 'button', class: 'wl-back', onclick: back }, icon('back'), backLabel || 'Back') : h('span'),
        dismissable ? h('button', { type: 'button', class: 'wl-x', title: 'Close', 'aria-label': 'Close', onclick: close }, icon('close')) : null);
}

// Point at the first thing to fix. A problem already shown in red under its
// field just gets focus; anything else is spelled out in the alert.
function stopAtFirstProblem(alert, uf, pp) {
    const ub = uf.problem();
    if (ub) {
        showAlert(alert, uf.status === 'taken' || uf.status === 'bad' ? '' : ub);
        uf.focus();
        return true;
    }
    const pb = pp ? pp.problem() : '';
    if (pb) {
        const longEnough = pp.pw.value.length >= 8;
        const mismatch = longEnough && pp.cf.value && pp.cf.value !== pp.pw.value;
        showAlert(alert, mismatch ? '' : pb);
        (longEnough ? pp.cf : pp.pw).focus();
        return true;
    }
    showAlert(alert, '');
    return false;
}

function submitBtn(label) {
    return h('button', { type: 'submit', class: 'dw-btn primary block', text: label });
}

/* ── log in / sign up ───────────────────────────────────────────────── */
function viewAuth(opts) {
    let tab = opts.tab === 'login' ? 'login' : 'signup';
    const tLogin = h('button', { type: 'button', class: 'wl-tab', role: 'tab', text: 'Log in', onclick: () => render('login') });
    const tSignup = h('button', { type: 'button', class: 'wl-tab', role: 'tab', text: 'Sign up', onclick: () => render('signup') });
    const body = h('div', { class: 'wl-tabbody' });
    const wrap = h('div', { class: 'wl-auth' },
        topBar(() => show('choose')),
        h('div', { class: 'wl-tabs', role: 'tablist' }, tLogin, tSignup),
        body);

    function render(t) {
        tab = t;
        tLogin.classList.toggle('active', t === 'login');
        tSignup.classList.toggle('active', t === 'signup');
        tLogin.setAttribute('aria-selected', String(t === 'login'));
        tSignup.setAttribute('aria-selected', String(t === 'signup'));
        clear(body).appendChild(t === 'login' ? loginForm(opts) : signupForm());
        if (opened && view === 'auth') setTimeout(() => focusFirst(body), 0);
    }
    render(tab);
    return wrap;
}

function loginForm(opts) {
    const user = h('input', { class: 'dw-input', type: 'text', name: 'username', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', maxlength: 16, placeholder: 'Username', value: opts.username || cachedName() });
    const pw = passwordInput('Password', { placeholder: 'Password' });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Log in');
    const form = h('form', { class: 'wl-form', novalidate: true },
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: 'Username' }), user),
        pw.el, alert, go,
        h('div', { class: 'wl-foot' },
            h('button', { type: 'button', class: 'dw-link', text: 'Forgot password?', onclick: () => show('recover', { username: user.value.trim() }) })));
    // focus the empty field
    if (user.value) pw.input.setAttribute('data-autofocus', '');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = user.value.trim();
        if (!name || !pw.value) return showAlert(alert, 'Enter your username and password.');
        showAlert(alert, '');
        setBusy(go, true, 'Logging in…');
        const r = await api.login(name, pw.value);
        setBusy(go, false);
        if (r.ok && r.data && r.data.user) {
            hooks.onAuthed(r.data.user, 'login');
            close();
            toast('Welcome back, ' + r.data.user.username + '!', { kind: 'ok' });
            return;
        }
        showAlert(alert, humanError(r));
        if (r.status === 401) { pw.input.value = ''; pw.input.focus(); }
    });
    return form;
}

function signupForm() {
    const uf = usernameField({ check: true, autocomplete: 'username', placeholder: 'Pick a username' });
    const pp = passwordPair({ username: () => uf.value });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Create account');
    const form = h('form', { class: 'wl-form', novalidate: true }, uf.el, pp.els, alert, go);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (stopAtFirstProblem(alert, uf, pp)) return;
        setBusy(go, true, 'Creating account…');
        const r = await api.signup(uf.value, pp.value);
        setBusy(go, false);
        if (r.ok && r.data && r.data.user) {
            hooks.onAuthed(r.data.user, 'signup');
            show('code', { code: r.data.recoveryCode, username: r.data.user.username, context: 'signup' });
            return;
        }
        const code = r.data && r.data.error && r.data.error.code;
        if (code === 'username_taken' || code === 'invalid_username') { uf.setError(humanError(r)); uf.focus(); }
        showAlert(alert, humanError(r));
    });
    return form;
}

/* ── Discord: pick a username ───────────────────────────────────────── */
function viewPick() {
    const pend = store.get('pending') || {};
    const suggestion = String(pend.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
    const uf = usernameField({ check: true, label: false, autocomplete: 'username', placeholder: 'Username', value: suggestion.length >= 3 ? suggestion : '' });
    const pp = passwordPair({ username: () => uf.value, label: 'Password (optional)' });
    const pwBox = h('div', { class: 'wl-optional', hidden: true }, pp.els);
    const pwToggle = h('button', { type: 'button', class: 'dw-link wl-addpw', onclick: () => { pwBox.hidden = false; pwToggle.hidden = true; pp.pw.focus(); } },
        'Add a password too (optional)');
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Create account');
    const form = h('form', { class: 'wl-form', novalidate: true }, uf.el, pwToggle, pwBox, alert, go);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const usePw = !pwBox.hidden && (pp.pw.value || pp.cf.value);
        if (stopAtFirstProblem(alert, uf, usePw ? pp : null)) return;
        setBusy(go, true, 'Creating account…');
        const r = await api.discordComplete(uf.value, usePw ? pp.value : undefined);
        setBusy(go, false);
        if (r.ok && r.data && r.data.user) {
            store.set({ pending: null });
            hooks.onAuthed(r.data.user, 'discord');
            show('code', { code: r.data.recoveryCode, username: r.data.user.username, context: 'discord' });
            return;
        }
        const code = r.data && r.data.error && r.data.error.code;
        if (code === 'username_taken' || code === 'invalid_username') { uf.setError(humanError(r)); uf.focus(); }
        if (r.status === 401 || r.status === 410 || /pending|expired/.test(code || '')) {
            showAlert(alert, 'Your Discord sign-in expired. Start again with Log in with Discord.');
            return;
        }
        showAlert(alert, humanError(r));
    });
    return h('div', { class: 'wl-pick' },
        topBar(() => { try { sessionStorage.setItem('dwPickDismissed', '1'); } catch (e) { /* */ } show('choose'); }, 'Cancel'),
        h('div', { class: 'wl-who' },
            avatar(pend.name || '?', pend.avatarUrl, 48),
            h('div', { class: 'wl-who-txt' },
                h('span', { class: 'wl-who-k', text: 'Signed in with Discord' }),
                h('b', { text: pend.name || 'Discord user' }))),
        h('div', { class: 'wl-h', text: 'Choose a username' }),
        form);
}

/* ── recovery code ──────────────────────────────────────────────────── */
function viewCode(opts) {
    const code = String(opts.code || '');
    const name = opts.username || '';
    const title = { recover: 'You’re back in', regen: 'Your new recovery code' }[opts.context] || 'Save your recovery code';
    const lead = {
        discord: 'It gets you back in if you ever lose your Discord.',
        recover: 'Here’s a fresh recovery code. The old one won’t work anymore.',
        regen: 'The old one won’t work anymore.',
    }[opts.context] || 'It gets you back in if you forget your password.';

    const copyBtn = h('button', { type: 'button', class: 'dw-btn' }, icon('copy'), h('span', { text: 'Copy' }));
    copyBtn.onclick = async () => {
        const ok = await copyText(code);
        copyBtn.lastChild.textContent = ok ? 'Copied' : 'Copy failed';
        copyBtn.classList.toggle('done', ok);
        setTimeout(() => { copyBtn.lastChild.textContent = 'Copy'; copyBtn.classList.remove('done'); }, 1800);
    };
    const dlBtn = h('button', { type: 'button', class: 'dw-btn', onclick: () => {
        const origin = (store.get('config') && store.get('config').publicOrigin) || location.origin;
        downloadText('digwars-recovery-' + name.replace(/[^A-Za-z0-9_]/g, '') + '.txt', [
            'Dig Wars recovery code',
            '',
            'Username: ' + name,
            'Recovery code: ' + code,
            'Saved: ' + fmtDate(Date.now()),
            '',
            'Forgot your password? Go to ' + origin + ', choose "Username & password",',
            'then "Forgot password? Use a recovery code". Each code works once;',
            'you get a new one when you use it. Keep this file private.',
            '',
        ].join('\r\n'));
    } }, icon('download'), h('span', { text: 'Download' }));
    const check = h('input', { type: 'checkbox', class: 'checkbox' });
    const go = h('button', { type: 'button', class: 'dw-btn primary block', text: 'Continue', disabled: true });
    check.onchange = () => { go.disabled = !check.checked; };
    go.onclick = () => {
        close();
        if (opts.onDone) opts.onDone();
        else if (opts.context === 'signup' || opts.context === 'discord') toast('You’re all set, ' + name + '!', { kind: 'ok' });
    };
    return h('div', { class: 'wl-codeview' },
        h('div', { class: 'wl-badge' }, icon('key')),
        h('div', { class: 'wl-h', text: title }),
        h('p', { class: 'wl-p', text: lead }),
        h('div', { class: 'wl-code', tabindex: '0', 'aria-label': 'Recovery code ' + code.split('').join(' '), text: code }),
        h('div', { class: 'wl-code-actions' }, copyBtn, dlBtn),
        h('label', { class: 'container wl-check' }, check, h('span', { class: 'checkmark' }), 'I’ve saved it'),
        go);
}

/* ── log in with a recovery code ────────────────────────────────────── */
function viewRecover(opts) {
    const user = h('input', { class: 'dw-input', type: 'text', name: 'username', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', maxlength: 16, placeholder: 'Username', value: opts.username || cachedName() });
    const codeIn = h('input', { class: 'dw-input mono', type: 'text', name: 'recovery-code', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', maxlength: 24, placeholder: 'XXXX-XXXX-XXXX' });
    const pp = passwordPair({ username: () => user.value.trim(), label: 'New password', confirmLabel: 'Confirm new password' });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Reset password');
    if (user.value) codeIn.setAttribute('data-autofocus', '');
    const form = h('form', { class: 'wl-form', novalidate: true },
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: 'Username' }), user),
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: 'Recovery code' }), codeIn),
        pp.els, alert, go);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = user.value.trim();
        const code = codeIn.value.trim();
        if (!name || !code) return showAlert(alert, 'Enter your username and recovery code.');
        const bad = pp.problem();
        if (bad) return showAlert(alert, bad);
        showAlert(alert, '');
        setBusy(go, true, 'Checking code…');
        const r = await api.recover(name, code, pp.value);
        setBusy(go, false);
        if (r.ok && r.data && r.data.user) {
            hooks.onAuthed(r.data.user, 'recover');
            show('code', { code: r.data.recoveryCode, username: r.data.user.username, context: 'recover' });
            return;
        }
        const ec = (r.data && r.data.error && r.data.error.code) || '';
        if (r.status === 401 || /credential|code|recovery/.test(ec)) showAlert(alert, 'That username and recovery code don’t match.');
        else showAlert(alert, humanError(r));
    });
    return h('div', { class: 'wl-recover' },
        topBar(() => show('auth', { tab: 'login' })),
        h('div', { class: 'wl-h', text: 'Forgot password?' }),
        h('p', { class: 'wl-p', text: 'Use the recovery code you saved to set a new one.' }),
        form);
}
