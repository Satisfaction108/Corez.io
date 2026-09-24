// The hub's Account pane: username, password, Discord link, recovery code,
// sessions and account deletion. Anything that needs a fresh Discord login
// (Discord-only accounts) stores what it was doing in sessionStorage, goes
// through /auth/discord/start?mode=reauth, and main.js resumes it when the
// callback lands on /?auth=reauth-ok.
import * as api from './api.js';
import * as store from './state.js';
import * as welcome from './welcome.js';
import { h, icon, clear, modal, confirm, formModal, toast, humanError, showAlert, setBusy, avatar, fmtDate, fmtDust, copyText, expandIn, collapseOut } from './ui.js';
import { usernameField, passwordPair, passwordInput } from './fields.js';
import { rankView, badgeImg } from './menu.js';

const INTENT_KEY = 'dwReauthIntent';
let hooks = { refresh() {}, onLoggedOut() {}, onDeleted() {}, setUser() {} };
// which inline forms are expanded, kept across re-renders
const expanded = { username: false, password: false };

export function init(hs) { Object.assign(hooks, hs); }

export function onClose() {
    expanded.username = expanded.password = false;
}

const errCode = (r) => (r && r.data && r.data.error && r.data.error.code) || '';

function reauth(intent) {
    try { sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent)); } catch (e) { /* */ }
    location.href = api.discordStartUrl('reauth');
}

async function askReauth(intent, what) {
    const ok = await confirm({
        title: 'Confirm with Discord',
        message: 'To keep your account safe, ' + what + ' needs a quick Discord check. You’ll pop right back here.',
        confirmLabel: 'Continue to Discord',
    });
    if (ok) reauth(intent);
}

export function takeIntent() {
    let raw = null;
    try { raw = sessionStorage.getItem(INTENT_KEY); sessionStorage.removeItem(INTENT_KEY); } catch (e) { /* */ }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return { action: raw }; }
}

export function clearIntent() {
    try { sessionStorage.removeItem(INTENT_KEY); } catch (e) { /* */ }
}

/* ── pane ───────────────────────────────────────────────────────────── */
export function render(el, opts) {
    const u = store.get('user');
    if (!u) {
        el.appendChild(h('p', { class: 'as-p', text: 'You’re not logged in.' }));
        return;
    }
    if (opts && opts.focus === 'username') expanded.username = true;
    el.append(
        profile(u),
        h('div', { class: 'as-list' }, usernameCard(u), passwordCard(u), discordCard(u), recoveryCard(u)),
        footer());
    if (opts && opts.focus === 'username') focusIn(el.querySelector('.as-card-username'));
}

// Rebuild one card in place, so opening one form never clears another.
function swap(cardEl, build) {
    const u = store.get('user');
    if (!u || !cardEl) return null;
    const next = build(u);
    cardEl.replaceWith(next);
    return next;
}
function focusIn(cardEl, value) {
    if (!cardEl) return;
    setTimeout(() => {
        const inp = cardEl.querySelector('input');
        if (!inp) return;
        if (value != null) { inp.value = value; inp.dispatchEvent(new Event('input')); }
        inp.focus();
    }, 40);
}
// Open a row's form (it grows in under the row) or close it (it shrinks
// away first, then the row goes back to one line).
async function setRow(key, rowEl, build, open) {
    if (!rowEl || rowEl._dwBusy) return null;
    expanded[key] = open;
    if (!open) {
        rowEl._dwBusy = true;
        await collapseOut(rowEl.querySelector('.as-form'));
        return swap(rowEl, build);
    }
    const next = swap(rowEl, build);
    if (next) { expandIn(next.querySelector('.as-form')); focusIn(next); }
    return next;
}
const toggler = (key, build, open) => (e) => { setRow(key, e.currentTarget.closest('.as-row'), build, open); };

// One line per setting: what it is, what it's set to, one button. A form
// opens underneath when there's something to fill in.
function row(cls, label, value, action, below) {
    return h('div', { class: 'as-row ' + cls },
        h('div', { class: 'as-row-main' },
            h('span', { class: 'as-row-label', text: label }),
            h('span', { class: 'as-row-value' }, value),
            h('div', { class: 'as-row-act' }, action)),
        below || null);
}
const smallBtn = (text, onclick, extra) => h('button', Object.assign({ type: 'button', class: 'dw-btn sm', text, onclick }, extra || {}));

function profile(u) {
    const idBtn = h('button', { type: 'button', class: 'as-copy', title: 'Copy player ID', 'aria-label': 'Copy player ID' }, icon('copy'));
    idBtn.onclick = async () => {
        const ok = await copyText(u.userId);
        toast(ok ? 'Player ID copied!' : 'Couldn’t copy. Select the ID and copy it yourself.', { kind: ok ? 'ok' : 'error' });
    };
    return h('div', { class: 'as-profile' },
        avatar(u.username, u.discord && u.discord.avatarUrl, 56),
        h('div', { class: 'as-who' },
            h('div', { class: 'as-uname', text: u.username }),
            h('div', { class: 'as-meta' },
                (() => { const v = rankView(u.rank); return h('span', { class: 'as-rank' }, badgeImg(v.div, 18, 'as-badge'), h('span', { text: v.text })); })(),
                h('span', { class: 'as-dot', text: '·' }),
                h('span', { class: 'as-dustline' }, icon('dust'), fmtDust(u.dust) + ' gemdust'),
                u.createdAt ? h('span', { class: 'as-dot', text: '·' }) : null,
                u.createdAt ? h('span', { text: 'Joined ' + fmtDate(u.createdAt) }) : null)),
        h('div', { class: 'as-id' },
            h('span', { class: 'field-label', text: 'Player ID' }),
            h('div', { class: 'as-id-row', title: 'Locked out? An admin can find you with this ID' }, h('span', { class: 'as-id-val', text: u.userId }), idBtn)));
}

/* ── username ───────────────────────────────────────────────────────── */
function usernameCard(u) {
    const wait = +u.usernameChangeAt > Date.now();
    if (wait) {
        return row('as-card-username', 'Username', u.username,
            h('span', { class: 'as-row-note', text: 'Can change again ' + fmtDate(u.usernameChangeAt) }));
    }
    if (!expanded.username) {
        return row('as-card-username', 'Username', u.username, smallBtn('Change', toggler('username', usernameCard, true)));
    }
    const uf = usernameField({ label: 'New username', current: u.username, check: true, autocomplete: 'off', placeholder: 'New username' });
    const pw = u.hasPassword ? passwordInput('Current password') : null;
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = h('button', { type: 'submit', class: 'dw-btn accent-fill', text: 'Save' });
    const form = h('form', { class: 'dw-form as-form', novalidate: true },
        uf.el, pw ? pw.el : null,
        h('p', { class: 'as-p as-small', text: 'You can change your name once every 14 days.' }),
        alert,
        h('div', { class: 'as-actions' },
            h('button', { type: 'button', class: 'dw-btn', text: 'Cancel', onclick: toggler('username', usernameCard, false) }), go));
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const bad = uf.problem();
        if (bad) return showAlert(alert, bad);
        if (pw && !pw.value) return showAlert(alert, 'Enter your current password.');
        showAlert(alert, '');
        setBusy(go, true, 'Saving…');
        const r = await api.changeUsername(uf.value, pw ? pw.value : undefined);
        setBusy(go, false);
        if (r.ok && r.data && r.data.user) {
            expanded.username = false;
            await collapseOut(form);
            hooks.setUser(r.data.user);
            toast('You’re now ' + r.data.user.username + '!', { kind: 'ok' });
            return;
        }
        const c = errCode(r);
        if (c === 'reauth_required') return askReauth({ action: 'username', value: uf.value }, 'changing your username');
        if (c === 'username_taken' || c === 'invalid_username') uf.setError(humanError(r));
        if (c === 'cooldown') { hooks.refresh(); }
        showAlert(alert, humanError(r));
    });
    return row('as-card-username', 'Username', u.username, null, form);
}

export function focusUsername(value) {
    expanded.username = true;
    const cur = document.querySelector('#dwHub .as-card-username');
    const next = swap(cur, usernameCard);
    if (next) expandIn(next.querySelector('.as-form'));
    focusIn(next, value || '');
}

/* ── password ───────────────────────────────────────────────────────── */
function passwordCard(u) {
    const value = u.hasPassword ? h('span', { class: 'as-dots', text: '••••••••' }) : h('span', { class: 'as-muted', text: 'Not set' });
    if (!expanded.password) {
        return row('as-card-password', 'Password', value, smallBtn(u.hasPassword ? 'Change' : 'Add', toggler('password', passwordCard, true)));
    }
    const cur = u.hasPassword ? passwordInput('Current password') : null;
    const pp = passwordPair({ username: () => u.username, label: 'New password', confirmLabel: 'Confirm new password' });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = h('button', { type: 'submit', class: 'dw-btn accent-fill', text: 'Save' });
    const form = h('form', { class: 'dw-form as-form', novalidate: true },
        cur ? cur.el : null, pp.els, alert,
        h('div', { class: 'as-actions' },
            h('button', { type: 'button', class: 'dw-btn', text: 'Cancel', onclick: toggler('password', passwordCard, false) }), go));
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (cur && !cur.value) return showAlert(alert, 'Enter your current password.');
        const bad = pp.problem();
        if (bad) return showAlert(alert, bad);
        showAlert(alert, '');
        setBusy(go, true, 'Saving…');
        const r = await api.changePassword(cur ? cur.value : undefined, pp.value);
        setBusy(go, false);
        if (r.ok) {
            await setRow('password', form.closest('.as-row'), passwordCard, false);
            toast(u.hasPassword ? 'Password changed!' : 'Password added! Now you can log in with your username too.', { kind: 'ok' });
            hooks.refresh();
            return;
        }
        if (errCode(r) === 'reauth_required') return askReauth({ action: 'password' }, 'setting a password');
        showAlert(alert, humanError(r));
    });
    return row('as-card-password', 'Password', value, null, form);
}

/* ── Discord ────────────────────────────────────────────────────────── */
function discordCard(u) {
    const cfg = store.get('config') || {};
    if (u.discord) {
        const unlink = smallBtn('Unlink', null, { disabled: !u.hasPassword, title: u.hasPassword ? '' : 'Add a password first, so you can still log in' });
        unlink.onclick = async () => {
            const done = await formModal({
                title: 'Unlink Discord?',
                message: 'You’ll log in with your username and password from now on.',
                fields: [{ name: 'pw', label: 'Current password', type: 'password', autocomplete: 'current-password' }],
                confirmLabel: 'Unlink Discord', danger: true,
                submit: async (v) => {
                    if (!v.pw) return { ok: false, error: 'Enter your current password.' };
                    const r = await api.unlinkDiscord(v.pw);
                    return r.ok ? { ok: true } : { ok: false, error: humanError(r) };
                },
            });
            if (done) { toast('Discord unlinked!', { kind: 'ok' }); hooks.refresh(); }
        };
        return row('as-card-discord', 'Discord',
            h('span', { class: 'as-linked' }, avatar(u.discord.name, u.discord.avatarUrl, 22), h('span', { text: u.discord.name })),
            unlink);
    }
    const can = cfg.discordLogin !== false;
    return row('as-card-discord', 'Discord', h('span', { class: 'as-muted', text: can ? 'Not linked' : 'Not available yet' }),
        h('button', { type: 'button', class: 'dw-btn sm discord', disabled: !can, onclick: linkDiscord }, icon('discord'), 'Link'));
}

// Linking needs a fresh sign-in, so a borrowed session can't attach its own
// Discord and take the account over.
async function linkDiscord() {
    const ok = await formModal({
        title: 'Link Discord',
        message: 'Enter your password, then pick your Discord account.',
        fields: [{ name: 'pw', label: 'Current password', type: 'password', autocomplete: 'current-password' }],
        confirmLabel: 'Continue to Discord',
        submit: async (v) => {
            if (!v.pw) return { ok: false, error: 'Enter your current password.' };
            const r = await api.reauthPassword(v.pw);
            return r.ok ? { ok: true } : { ok: false, error: humanError(r) };
        },
    });
    if (ok) location.href = api.discordStartUrl('link');
}

/* ── recovery code ──────────────────────────────────────────────────── */
function showNewCode(code) {
    const u = store.get('user');
    welcome.open('code', { code, username: u ? u.username : '', context: 'regen', onDone: () => toast('New recovery code saved!', { kind: 'ok' }) });
}

async function regenerate() {
    const u = store.get('user');
    if (!u) return;
    if (u.hasPassword) {
        const code = await formModal({
            title: 'Make a new recovery code?',
            message: 'Your old code will stop working.',
            fields: [{ name: 'pw', label: 'Current password', type: 'password', autocomplete: 'current-password' }],
            confirmLabel: 'Make new code',
            submit: async (v) => {
                if (!v.pw) return { ok: false, error: 'Enter your current password.' };
                const r = await api.regenRecoveryCode(v.pw);
                if (r.ok && r.data && r.data.recoveryCode) return { ok: true, value: r.data.recoveryCode };
                return { ok: false, error: humanError(r) };
            },
        });
        if (code) showNewCode(code);
        return;
    }
    const ok = await confirm({ title: 'Make a new recovery code?', message: 'Your old code will stop working.', confirmLabel: 'Make new code' });
    if (!ok) return;
    const r = await api.regenRecoveryCode();
    if (r.ok && r.data && r.data.recoveryCode) return showNewCode(r.data.recoveryCode);
    if (errCode(r) === 'reauth_required') return reauth({ action: 'recovery' });
    toast(humanError(r), { kind: 'error' });
}

export async function regenAfterReauth() {
    const r = await api.regenRecoveryCode();
    if (r.ok && r.data && r.data.recoveryCode) return showNewCode(r.data.recoveryCode);
    toast(humanError(r), { kind: 'error' });
}

function recoveryCard() {
    return row('as-card-recovery', 'Recovery code', h('span', { class: 'as-muted', text: 'Your backup if you forget your password' }), smallBtn('New code', regenerate));
}

/* ── log out / delete ───────────────────────────────────────────────── */
function footer() {
    const out = h('button', { type: 'button', class: 'dw-btn' }, icon('logout'), 'Log out');
    out.onclick = async () => {
        setBusy(out, true, 'Logging out…');
        const r = await api.logout();
        setBusy(out, false);
        if (r.ok || r.status === 401) hooks.onLoggedOut('Logged out. See you soon!');
        else toast(humanError(r), { kind: 'error' });
    };
    const all = h('button', { type: 'button', class: 'dw-link as-quiet', text: 'Log out on all devices' });
    all.onclick = async () => {
        const ok = await confirm({
            title: 'Log out on all devices?',
            message: 'This one too.',
            confirmLabel: 'Log out', danger: true,
        });
        if (!ok) return;
        const r = await api.logoutAll();
        if (r.ok || r.status === 401) hooks.onLoggedOut('Logged out everywhere. See you soon!');
        else toast(humanError(r), { kind: 'error' });
    };
    return h('div', { class: 'as-foot' },
        out, all, h('span', { class: 'as-foot-gap' }),
        h('button', { type: 'button', class: 'dw-link as-quiet as-del', text: 'Delete account', onclick: () => openDelete() }));
}

export function openDelete(opts) {
    opts = opts || {};
    const u = store.get('user');
    if (!u) return;
    const pw = u.hasPassword ? passwordInput('Current password') : null;
    const typed = h('input', { class: 'dw-input mono', type: 'text', name: 'confirm-delete', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', maxlength: 6, placeholder: 'DELETE' });
    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const go = h('button', { type: 'submit', class: 'dw-btn danger', text: 'Delete my account', disabled: true });
    const sync = () => { go.disabled = !(typed.value === 'DELETE' && (!pw || pw.value.length > 0)); };
    typed.addEventListener('input', sync);
    if (pw) pw.input.addEventListener('input', sync);
    let note = null;
    if (!u.hasPassword) {
        note = opts.reauthed
            ? h('div', { class: 'dw-alert show info', text: 'Discord says it’s you. Type DELETE to finish.' })
            : h('p', { class: 'as-p as-small', text: 'We’ll ask Discord to make sure it’s you.' });
    }
    const form = h('form', { class: 'dw-form', novalidate: true },
        pw ? pw.el : null,
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label' }, 'Type ', h('b', { class: 'as-kbd', text: 'DELETE' }), ' to confirm'), typed),
        note, alert,
        h('div', { class: 'dw-modal-actions' },
            h('button', { type: 'button', class: 'dw-btn', text: 'Cancel', onclick: () => m.close() }), go));
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (go.disabled) return;
        showAlert(alert, '');
        setBusy(go, true, 'Deleting…');
        const r = await api.deleteAccount(pw ? pw.value : undefined);
        setBusy(go, false);
        sync();
        if (r.ok) { m.close(); clearIntent(); hooks.onDeleted(); return; }
        if (errCode(r) === 'reauth_required') { reauth({ action: 'delete' }); return; }
        showAlert(alert, humanError(r));
    });
    const m = modal({
        title: 'Delete your account?', cls: 'dw-modal-danger',
        message: h('span', null, h('b', { text: u.username }), ', its rank, gemdust and items will be gone for good.'),
        body: form,
        focus: pw ? 'input[type=password]' : 'input[name=confirm-delete]',
    });
    return m;
}
