// The welcome gate (#dwWelcome): choose Guest / Discord / username, the
// log in + sign up forms, the Discord "pick a username" step, the recovery
// code screen and recovery-code login. The choose view is static markup in
// index.html so it can show before any script runs; the rest render into
// #wlDyn.
import * as api from './api.js';
import * as store from './state.js';
import { h, icon, clear, pushLayer, popLayer, focusFirst, toast, humanError, showAlert, setBusy, copyText, downloadText, avatar, fmtDate, animate, reducedMotion, T_FAST, T_MID } from './ui.js';
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

// view: 'choose' | 'auth' | 'pick' | 'code' | 'recover' | 'reset'
export function open(name, opts) {
    opts = opts || {};
    dismissable = !!opts.dismissable;
    root.classList.toggle('wl-dismissable', dismissable);
    if (!opened) {
        opened = true;
        stopClosing();
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
    // the menu comes back underneath while the gate fades away
    document.documentElement.classList.remove('dw-wl-open');
    popLayer(root);
    const reset = () => {
        // a finished fill:'forwards' fade would keep the gate invisible the
        // next time it opens
        if (closing) closing.cancel();
        closing = null;
        if (opened) return;
        root.classList.remove('open', 'wl-closing');
        clear(dyn);
        dyn.hidden = true;
        chooseView.hidden = false;
    };
    if (reducedMotion() || !root.animate) return reset();
    root.classList.add('wl-closing');
    closing = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T_MID, easing: 'ease', fill: 'forwards' });
    animate(document.getElementById('wlCard'), [{ transform: 'none' }, { transform: 'translateY(6px) scale(.98)' }], { duration: T_MID, fill: 'forwards' });
    closing.onfinish = reset;
}
let closing = null;
function stopClosing() {
    if (!closing) return;
    closing.onfinish = null;
    closing.cancel();
    closing = null;
    root.classList.remove('wl-closing');
    const card = document.getElementById('wlCard');
    if (card.getAnimations) card.getAnimations().forEach((a) => a.cancel());
}

function onEsc() {
    if (view === 'code') return; // must tick the box first
    if (view === 'recover') return show('auth', { tab: 'login' });
    if (view === 'reset' && dismissable) return close();
    if (view && view !== 'choose') return show('choose');
    if (dismissable) close();
}

// Order of the views, so a change slides forward (in from the right) or
// back (in from the left).
const DEPTH = { choose: 0, auth: 1, pick: 1, reset: 1, recover: 2, code: 3 };

function show(name, opts) {
    opts = opts || {};
    const prev = view;
    const swap = beginSwap(prev, name);
    view = name;
    root.dataset.view = name;
    if (name === 'choose') {
        clear(dyn);
        dyn.hidden = true;
        chooseView.hidden = false;
        closeBtn.hidden = !dismissable;
        swap(chooseView);
        return settle();
    }
    chooseView.hidden = true;
    closeBtn.hidden = true;
    clear(dyn);
    dyn.hidden = false;
    const build = { auth: viewAuth, pick: viewPick, code: viewCode, recover: viewRecover, reset: viewReset }[name];
    dyn.appendChild(build(opts));
    swap(dyn);
    settle(opts.focus);
}

function settle(selector) {
    setTimeout(() => { if (opened) focusFirst(view === 'choose' ? chooseView : dyn, selector); }, 30);
}

// Cross-fade between two views: a copy of the old one fades and slides
// out on top while the new one slides in, and the card's height glides
// from one to the other. Returns a function to call once the new view is
// in the DOM.
function beginSwap(from, to) {
    const card = document.getElementById('wlCard');
    if (!opened || from == null || from === to && to === 'choose' || reducedMotion() || !card.animate) return () => {};
    const old = !chooseView.hidden ? chooseView : !dyn.hidden ? dyn : null;
    const h0 = card.offsetHeight;
    const dir = (DEPTH[to] || 0) >= (DEPTH[from] || 0) ? 1 : -1;
    let ghost = null;
    if (old) {
        ghost = old.cloneNode(true);
        // the copy loses its ids (no duplicates), so it keeps the layout
        // and the hidden bits the ids gave it by value instead
        const cs = getComputedStyle(old);
        for (const k of ['display', 'flexDirection', 'textAlign', 'gap']) ghost.style[k] = cs[k];
        const src = old.querySelectorAll('*'), dst = ghost.querySelectorAll('*');
        for (let i = 0; i < src.length && i < dst.length; i++) {
            if (src[i].id && getComputedStyle(src[i]).display === 'none') dst[i].style.display = 'none';
        }
        ghost.removeAttribute('id');
        ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
        ghost.setAttribute('aria-hidden', 'true');
        ghost.setAttribute('inert', '');
        ghost.classList.add('wl-ghost');
        Object.assign(ghost.style, { top: old.offsetTop + 'px', left: old.offsetLeft + 'px', width: old.offsetWidth + 'px' });
    }
    return (neu) => {
        if (ghost) {
            card.appendChild(ghost);
            animate(ghost, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(' + (-dir * 16) + 'px)' }], { duration: T_FAST, fill: 'forwards' })
                .then(() => ghost.remove());
        }
        animate(neu, [{ opacity: 0, transform: 'translateX(' + (dir * 16) + 'px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID, delay: 40, fill: 'backwards' });
        const h1 = card.offsetHeight;
        if (Math.abs(h1 - h0) > 1) {
            card.style.overflow = 'hidden';
            animate(card, [{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: T_MID }).then(() => { card.style.overflow = ''; });
        }
    };
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
    const tSignup = h('button', { type: 'button', class: 'wl-tab', role: 'tab', text: 'New account', onclick: () => render('signup') });
    const body = h('div', { class: 'wl-tabbody' });
    // the active pill is one element that slides between the two tabs
    const tabs = h('div', { class: 'wl-tabs', role: 'tablist' }, h('span', { class: 'wl-tab-pill', 'aria-hidden': 'true' }), tLogin, tSignup);
    let tabDir = 0;
    const wrap = h('div', { class: 'wl-auth' },
        topBar(() => show('choose')),
        tabs,
        body);

    function render(t) {
        tab = t;
        tLogin.classList.toggle('active', t === 'login');
        tSignup.classList.toggle('active', t === 'signup');
        tLogin.setAttribute('aria-selected', String(t === 'login'));
        tSignup.setAttribute('aria-selected', String(t === 'signup'));
        const was = body.firstChild ? tabDir : 0;
        clear(body).appendChild(t === 'login' ? loginForm(opts) : signupForm());
        tabs.dataset.tab = t;
        if (was) {
            // the form slides in from the side of the tab you picked
            const dx = t === 'signup' ? 14 : -14;
            animate(body, [{ opacity: 0, transform: 'translateX(' + dx + 'px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
        }
        tabDir = 1;
        if (opened && view === 'auth') setTimeout(() => focusFirst(body), 0);
    }
    render(tab);
    return wrap;
}

function loginForm(opts) {
    const user = h('input', { class: 'dw-input', type: 'text', name: 'username', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', maxlength: 16, placeholder: 'your name', value: opts.username || cachedName() });
    const pw = passwordInput('Password', { placeholder: 'password' });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Log in');
    const form = h('form', { class: 'wl-form', novalidate: true },
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: 'Name' }), user),
        pw.el, alert, go,
        h('div', { class: 'wl-foot' },
            h('button', { type: 'button', class: 'dw-link', text: 'forgot password?', onclick: () => show('recover', { username: user.value.trim() }) })));
    // focus the empty field
    if (user.value) pw.input.setAttribute('data-autofocus', '');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = user.value.trim();
        if (!name || !pw.value) return showAlert(alert, 'Need your name and password');
        showAlert(alert, '');
        setBusy(go, true, 'Logging in...');
        const r = await api.login(name, pw.value);
        setBusy(go, false);
        if (r.ok && r.data && r.data.user) {
            hooks.onAuthed(r.data.user, 'login');
            close();
            toast('Hey ' + r.data.user.username + ', welcome back', { kind: 'ok' });
            return;
        }
        showAlert(alert, humanError(r));
        if (r.status === 401) { pw.input.value = ''; pw.input.focus(); }
    });
    return form;
}

function signupForm() {
    const uf = usernameField({ check: true, autocomplete: 'username', placeholder: 'pick a name' });
    const pp = passwordPair({ username: () => uf.value });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Make it');
    const form = h('form', { class: 'wl-form', novalidate: true }, uf.el, pp.els, alert, go);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (stopAtFirstProblem(alert, uf, pp)) return;
        setBusy(go, true, 'Making it...');
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
    const uf = usernameField({ check: true, label: false, autocomplete: 'username', placeholder: 'your name', value: suggestion.length >= 3 ? suggestion : '' });
    const pp = passwordPair({ username: () => uf.value, label: 'Password (optional)' });
    const pwBox = h('div', { class: 'wl-optional', hidden: true }, pp.els);
    const pwToggle = h('button', { type: 'button', class: 'dw-link wl-addpw', onclick: () => { pwBox.hidden = false; pwToggle.hidden = true; pp.pw.focus(); } },
        '+ add a password too');
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Done');
    const form = h('form', { class: 'wl-form', novalidate: true }, uf.el, pwToggle, pwBox, alert, go);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const usePw = !pwBox.hidden && (pp.pw.value || pp.cf.value);
        if (stopAtFirstProblem(alert, uf, usePw ? pp : null)) return;
        setBusy(go, true, 'Saving...');
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
            showAlert(alert, 'Discord login timed out. Hit Discord again');
            return;
        }
        showAlert(alert, humanError(r));
    });
    return h('div', { class: 'wl-pick' },
        topBar(() => { try { sessionStorage.setItem('dwPickDismissed', '1'); } catch (e) { /* */ } show('choose'); }, 'Cancel'),
        h('div', { class: 'wl-who' },
            avatar(pend.name || '?', pend.avatarUrl, 48),
            h('div', { class: 'wl-who-txt' },
                h('span', { class: 'wl-who-k', text: 'From Discord' }),
                h('b', { text: pend.name || 'Discord user' }))),
        h('div', { class: 'wl-h', text: 'Pick your name' }),
        form);
}

/* ── recovery code ──────────────────────────────────────────────────── */
function viewCode(opts) {
    const code = String(opts.code || '');
    const name = opts.username || '';
    const title = { recover: 'You’re back in', regen: 'New backup code' }[opts.context] || 'Save this code';
    const lead = {
        discord: 'If you ever lose your Discord, this gets you back in.',
        recover: 'Here’s a fresh one. The old one is dead now.',
        regen: 'The old one is dead now.',
    }[opts.context] || 'Forget your password? This gets you back in.';

    const copyBtn = h('button', { type: 'button', class: 'dw-btn' }, icon('copy'), h('span', { text: 'Copy' }));
    copyBtn.onclick = async () => {
        const ok = await copyText(code);
        copyBtn.lastChild.textContent = ok ? 'Copied' : 'Didn’t copy';
        copyBtn.classList.toggle('done', ok);
        setTimeout(() => { copyBtn.lastChild.textContent = 'Copy'; copyBtn.classList.remove('done'); }, 1800);
    };
    const dlBtn = h('button', { type: 'button', class: 'dw-btn', onclick: () => {
        const origin = (store.get('config') && store.get('config').publicOrigin) || location.origin;
        downloadText('corez-recovery-' + name.replace(/[^A-Za-z0-9_]/g, '') + '.txt', [
            'Corez.io recovery code',
            '',
            'Username: ' + name,
            'Recovery code: ' + code,
            'Saved: ' + fmtDate(Date.now()),
            '',
            'Forgot your password? Go to ' + origin + ', hit "Username",',
            'then "forgot password?" and use this code. Each code works once,',
            'you get a new one after. Don\'t share this file.',
            '',
        ].join('\r\n'));
    } }, icon('download'), h('span', { text: 'Save' }));
    const check = h('input', { type: 'checkbox', class: 'checkbox' });
    const go = h('button', { type: 'button', class: 'dw-btn primary block', text: 'Done', disabled: true });
    check.onchange = () => { go.disabled = !check.checked; };
    go.onclick = () => {
        close();
        if (opts.onDone) opts.onDone();
        else if (opts.context === 'signup' || opts.context === 'discord') toast('You’re in, ' + name, { kind: 'ok' });
    };
    return h('div', { class: 'wl-codeview' },
        h('div', { class: 'wl-badge' }, icon('key')),
        h('div', { class: 'wl-h', text: title }),
        h('p', { class: 'wl-p', text: lead }),
        h('div', { class: 'wl-code', tabindex: '0', 'aria-label': 'Recovery code ' + code.split('').join(' '), text: code }),
        h('div', { class: 'wl-code-actions' }, copyBtn, dlBtn),
        h('label', { class: 'container wl-check' }, check, h('span', { class: 'checkmark' }), 'I saved it'),
        go);
}

/* ── log in with a recovery code ────────────────────────────────────── */
function viewRecover(opts) {
    const user = h('input', { class: 'dw-input', type: 'text', name: 'username', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', maxlength: 16, placeholder: 'your name', value: opts.username || cachedName() });
    const codeIn = h('input', { class: 'dw-input mono', type: 'text', name: 'recovery-code', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', maxlength: 24, placeholder: 'XXXX-XXXX-XXXX' });
    const pp = passwordPair({ username: () => user.value.trim(), label: 'New password', confirmLabel: 'Again' });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Reset');
    if (user.value) codeIn.setAttribute('data-autofocus', '');
    const form = h('form', { class: 'wl-form', novalidate: true },
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: 'Name' }), user),
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: 'Backup code' }), codeIn),
        pp.els, alert, go);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = user.value.trim();
        const code = codeIn.value.trim();
        if (!name || !code) return showAlert(alert, 'Need your name and code');
        const bad = pp.problem();
        if (bad) return showAlert(alert, bad);
        showAlert(alert, '');
        setBusy(go, true, 'Checking...');
        const r = await api.recover(name, code, pp.value);
        setBusy(go, false);
        if (r.ok && r.data && r.data.user) {
            hooks.onAuthed(r.data.user, 'recover');
            show('code', { code: r.data.recoveryCode, username: r.data.user.username, context: 'recover' });
            return;
        }
        const ec = (r.data && r.data.error && r.data.error.code) || '';
        if (r.status === 401 || /credential|code|recovery/.test(ec)) showAlert(alert, 'That code isn’t for that name');
        else showAlert(alert, humanError(r));
    });
    return h('div', { class: 'wl-recover' },
        topBar(() => show('auth', { tab: 'login' })),
        h('div', { class: 'wl-h', text: 'Forgot it?' }),
        h('p', { class: 'wl-p', text: 'Use the backup code you saved to set a new one.' }),
        form);
}

/* ── a reset link (#reset=<token>) ──────────────────────────────────── */
function viewReset(opts) {
    const pp = passwordPair({ label: 'New password', confirmLabel: 'Again' });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = submitBtn('Save');
    pp.pw.setAttribute('data-autofocus', '');
    const form = h('form', { class: 'wl-form', novalidate: true }, pp.els, alert, go);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const bad = pp.problem();
        if (bad) {
            const longEnough = pp.pw.value.length >= 8;
            showAlert(alert, bad);
            (longEnough ? pp.cf : pp.pw).focus();
            return;
        }
        showAlert(alert, '');
        setBusy(go, true, 'Saving...');
        const r = await api.reset(opts.token || '', pp.value);
        setBusy(go, false);
        if (r.ok && r.data && r.data.user) {
            hooks.onAuthed(r.data.user, 'reset');
            close();
            toast('Saved. you’re in as ' + r.data.user.username, { kind: 'ok' });
            return;
        }
        const ec = (r.data && r.data.error && r.data.error.code) || '';
        if (ec === 'invalid_token' || /token/.test(ec)) {
            showAlert(alert, 'This link is old or already used. Get a new one');
            go.disabled = true;
        } else showAlert(alert, humanError(r));
    });
    return h('div', { class: 'wl-reset' },
        topBar(dismissable ? null : () => show('choose')),
        h('div', { class: 'wl-badge' }, icon('key')),
        h('div', { class: 'wl-h', text: 'New password' }),
        h('p', { class: 'wl-p', text: 'Pick one. You get logged in right after.' }),
        form);
}
