// Shared DOM helpers for the account UI: an element builder, the overlay
// stack (Esc, focus trap, and keeping keys away from app.js so Enter never
// starts a game behind a dialog), modals, toasts and formatters.

const SVG_NS = 'http://www.w3.org/2000/svg';

// h('div', { class: 'x', onclick: fn, text: 'hi' }, child, 'text', [more])
// Strings always become text nodes, so user data is never parsed as HTML.
export function h(tag, props, ...kids) {
    const svg = tag === 'svg' || tag === 'use';
    const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    if (props) {
        for (const k in props) {
            const v = props[k];
            if (v == null || v === false) continue;
            if (k === 'class') el.setAttribute('class', v);
            else if (k === 'text') el.textContent = v;
            else if (k === 'style' && typeof v === 'object') { for (const sk in v) { if (sk.startsWith('--')) el.style.setProperty(sk, v[sk]); else el.style[sk] = v[sk]; } }
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else if (k === 'value' && !svg) el.value = v;
            else if (k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = !!v;
            else el.setAttribute(k, v === true ? '' : v);
        }
    }
    append(el, kids);
    return el;
}

function append(el, kids) {
    for (const c of kids) {
        if (c == null || c === false) continue;
        if (Array.isArray(c)) append(el, c);
        else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

// <svg><use href="#i-name"></svg> from the sprite in index.html
export function icon(name, cls) {
    const s = h('svg', { class: 'dw-ic' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', focusable: 'false' });
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
}

export function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

/* ── motion ──────────────────────────────────────────────────────────── */
// One easing and three durations for every account UI animation (the CSS
// side uses the same values: --dw-ease, --dw-t1/2/3 in home.css). Only
// transform and opacity move, except the row forms, which grow in height.
export const EASE = 'cubic-bezier(.2,.8,.2,1)';
export const T_FAST = 150, T_MID = 220, T_SLOW = 300;
export function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}
// el.animate() that resolves when done, and does nothing (resolves at once)
// under reduced motion or without Web Animations.
export function animate(el, frames, opts) {
    if (!el || !el.animate || reducedMotion()) return Promise.resolve();
    const a = el.animate(frames, Object.assign({ duration: T_MID, easing: EASE }, opts || {}));
    return new Promise((res) => { a.onfinish = res; a.oncancel = res; });
}
// A block that just appeared grows from nothing to its height.
export function expandIn(el) {
    if (!el || reducedMotion()) return Promise.resolve();
    const hgt = el.offsetHeight;
    if (!hgt) return Promise.resolve();
    el.style.overflow = 'hidden';
    return animate(el, [{ height: '0px', opacity: 0 }, { height: hgt + 'px', opacity: 1 }], { duration: T_MID })
        .then(() => { el.style.overflow = ''; });
}
// ...and shrinks away before it is removed.
export function collapseOut(el) {
    if (!el || reducedMotion()) return Promise.resolve();
    const hgt = el.offsetHeight;
    if (!hgt) return Promise.resolve();
    el.style.overflow = 'hidden';
    return animate(el, [{ height: hgt + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: T_FAST + 30, fill: 'forwards' });
}
// Siblings slide into the space an element leaves (FLIP, transform only).
function glideSiblings(parent, removeFn) {
    const kids = Array.prototype.slice.call(parent.children);
    const before = new Map(kids.map((k) => [k, k.getBoundingClientRect().top]));
    removeFn();
    if (reducedMotion()) return;
    for (const k of parent.children) {
        const b = before.get(k);
        if (b == null) continue;
        const dy = b - k.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) animate(k, [{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: T_MID });
    }
}

/* ── overlay stack ───────────────────────────────────────────────────── */
const layers = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
}
function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), (el) => visible(el) && !el.closest('[hidden]') && !el.closest('.dw-no-tab'));
}
export function focusFirst(root, selector) {
    let el = selector ? root.querySelector(selector) : null;
    if (!el || !visible(el)) {
        const list = focusables(root);
        el = list.find((x) => x.matches('[data-autofocus]')) || list.find((x) => x.matches('input')) || list[0];
    }
    if (el) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
    else if (root.focus) { if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1'); root.focus(); }
}

function trapTab(e, root) {
    const list = focusables(root);
    e.preventDefault();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i >= list.length - 1 ? 0 : i + 1);
    list[next].focus();
}

function onLayerKey(e) {
    const top = layers[layers.length - 1];
    if (top && top.el === e.currentTarget) {
        if (e.key === 'Escape') { e.preventDefault(); if (top.onEsc) top.onEsc(); }
        else if (e.key === 'Tab') trapTab(e, top.el);
    }
    // app.js listens on document; nothing typed in an overlay belongs to it
    e.stopPropagation();
}

// opts: { onEsc, focus (selector), allow: [elements focus may visit outside] }
export function pushLayer(el, opts) {
    opts = opts || {};
    const L = { el, onEsc: opts.onEsc || null, allow: opts.allow || [], restore: document.activeElement };
    const old = layers.findIndex((l) => l.el === el);
    if (old >= 0) layers.splice(old, 1);
    layers.push(L);
    if (!el._dwLayerKey) { el.addEventListener('keydown', onLayerKey); el._dwLayerKey = true; }
    if (opts.autofocus !== false) setTimeout(() => { if (layers[layers.length - 1] === L) focusFirst(el, opts.focus); }, 30);
    return L;
}

export function popLayer(el) {
    const i = layers.findIndex((l) => l.el === el);
    if (i < 0) return;
    const [L] = layers.splice(i, 1);
    const top = layers[layers.length - 1];
    if (top) {
        if (!top.el.contains(document.activeElement)) focusFirst(top.el);
    } else if (L.restore && document.contains(L.restore) && visible(L.restore)) {
        try { L.restore.focus({ preventScroll: true }); } catch (e) { /* */ }
    } else if (document.activeElement && el.contains(document.activeElement)) {
        document.activeElement.blur();
    }
}

export const hasLayers = () => layers.length > 0;
export const topLayer = () => layers[layers.length - 1] || null;

function outsideAllowed(L, target) {
    return L.allow.some((a) => a && a.contains(target));
}

// Keys whose target is outside the top layer (focus fell to <body>, say)
// must not reach app.js either.
const playing = () => document.body.classList.contains('in-game');
document.addEventListener('keydown', (e) => {
    const top = layers[layers.length - 1];
    if (!top || playing() || top.el.contains(e.target)) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (top.onEsc) top.onEsc(); return; }
    if (outsideAllowed(top, e.target)) return;
    if (e.key === 'Tab') { e.preventDefault(); focusFirst(top.el); return; }
    if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
}, true);

document.addEventListener('focusin', (e) => {
    const top = layers[layers.length - 1];
    if (!top || playing() || top.el.contains(e.target) || outsideAllowed(top, e.target)) return;
    focusFirst(top.el);
});

/* ── modals ──────────────────────────────────────────────────────────── */
let modalDepth = 0;

// modal({ title, message, body, dismissable, onClose }) -> { card, close }
export function modal(opts) {
    const root = document.getElementById('dwModalRoot') || document.body;
    const dismissable = opts.dismissable !== false;
    const card = h('div', { class: 'dw-modal' + (opts.cls ? ' ' + opts.cls : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Dialog' },
        opts.title ? h('div', { class: 'dw-modal-h', text: opts.title }) : null,
        opts.message ? (opts.message instanceof Node ? h('div', { class: 'dw-modal-p' }, opts.message) : h('div', { class: 'dw-modal-p', text: opts.message })) : null,
        opts.body || null);
    const layerEl = h('div', { class: 'dw-layer' }, card);
    layerEl.style.zIndex = String(320 + 20 * modalDepth);
    modalDepth++;
    let closed = false;
    function close(result) {
        if (closed) return;
        closed = true;
        modalDepth = Math.max(0, modalDepth - 1);
        popLayer(layerEl);
        // fade and settle out, then go; clicks already pass through
        layerEl.classList.add('closing');
        Promise.all([
            animate(layerEl, [{ opacity: 1 }, { opacity: 0 }], { duration: T_FAST, fill: 'forwards' }),
            animate(card, [{ transform: 'none' }, { transform: 'translateY(4px) scale(.97)' }], { duration: T_FAST, fill: 'forwards' }),
        ]).then(() => layerEl.remove());
        if (opts.onClose) opts.onClose(result);
    }
    layerEl.addEventListener('mousedown', (e) => { if (e.target === layerEl && dismissable) close(null); });
    root.appendChild(layerEl);
    pushLayer(layerEl, { onEsc: () => { if (dismissable) close(null); }, focus: opts.focus });
    return { card, close, layer: layerEl };
}

export function closeAllModals() {
    const root = document.getElementById('dwModalRoot');
    if (!root) return;
    Array.prototype.slice.call(root.children).forEach((l) => { popLayer(l); l.remove(); });
    modalDepth = 0;
}

export function confirm(opts) {
    return new Promise((resolve) => {
        let answer = false;
        const m = modal({
            title: opts.title, message: opts.message,
            body: h('div', { class: 'dw-modal-actions' },
                h('button', { type: 'button', class: 'dw-btn', text: opts.cancelLabel || 'Cancel', onclick: () => m.close() }),
                h('button', { type: 'button', class: 'dw-btn ' + (opts.danger ? 'danger' : 'accent-fill'), 'data-autofocus': '', text: opts.confirmLabel || 'OK', onclick: () => { answer = true; m.close(); } })),
            onClose: () => resolve(answer),
        });
    });
}

// A small form in a modal that stays open until submit() succeeds, showing
// the server's error inline. Resolves with submit's value, or null.
// fields: [{ name, label, type, placeholder, autocomplete }]
// submit(values) -> Promise<{ ok:true, value } | { ok:false, error:string }>
export function formModal(opts) {
    return new Promise((resolve) => {
        let result = null;
        const inputs = {};
        const alert = h('div', { class: 'dw-alert', role: 'alert' });
        const go = h('button', { type: 'submit', class: 'dw-btn ' + (opts.danger ? 'danger' : 'accent-fill'), text: opts.confirmLabel || 'Continue' });
        const fields = (opts.fields || []).map((f) => {
            const inp = h('input', { class: 'dw-input', type: f.type || 'text', name: f.name, placeholder: f.placeholder || '', autocomplete: f.autocomplete || 'off', spellcheck: 'false', maxlength: f.maxlength || 128 });
            inputs[f.name] = inp;
            return h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: f.label }), inp);
        });
        const form = h('form', { class: 'dw-form', novalidate: true }, fields, alert,
            h('div', { class: 'dw-modal-actions' },
                h('button', { type: 'button', class: 'dw-btn', text: 'Cancel', onclick: () => m.close() }), go));
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const values = {};
            for (const k in inputs) values[k] = inputs[k].value;
            setBusy(go, true, opts.busyLabel || 'Checking…');
            showAlert(alert, '');
            const r = await opts.submit(values);
            setBusy(go, false);
            if (r && r.ok) { result = r.value === undefined ? true : r.value; m.close(); }
            else showAlert(alert, (r && r.error) || 'Something went wrong. Try again.');
        });
        const m = modal({ title: opts.title, message: opts.message, body: form, onClose: () => resolve(result) });
    });
}

export function showAlert(el, msg, kind) {
    el.textContent = msg || '';
    el.className = 'dw-alert' + (msg ? ' show' : '') + (kind ? ' ' + kind : '');
}

export function setBusy(btn, busy, label) {
    if (busy) {
        if (btn._dwLabel == null) btn._dwLabel = btn.textContent;
        btn.disabled = true;
        btn.classList.add('busy');
        if (label) btn.textContent = label;
    } else {
        btn.disabled = false;
        btn.classList.remove('busy');
        if (btn._dwLabel != null) { btn.textContent = btn._dwLabel; btn._dwLabel = null; }
    }
}

/* ── toasts ──────────────────────────────────────────────────────────── */
// Same look as home.js showToast (it lives in that file's closure), plus a
// kind colour and optional action buttons.
export function toast(message, opts) {
    opts = opts || {};
    const box = document.getElementById('toastContainer');
    if (!box) return null;
    const t = h('div', { class: 'toast dw-toast' + (opts.kind ? ' ' + opts.kind : ''), role: 'status' },
        h('span', { class: 'dw-toast-msg', text: message }));
    const dismiss = () => {
        if (t._gone) return;
        t._gone = true;
        t.classList.add('hide');
        // after it fades up and out, the toasts under it glide into place
        setTimeout(() => { if (t.parentNode) glideSiblings(t.parentNode, () => t.remove()); }, T_MID);
    };
    (opts.actions || []).forEach((a) => {
        t.appendChild(h('button', { type: 'button', class: 'dw-toast-act', text: a.label, onclick: () => { dismiss(); a.onClick && a.onClick(); } }));
    });
    box.appendChild(t);
    setTimeout(dismiss, opts.duration || (opts.actions && opts.actions.length ? 7000 : 3600));
    return { dismiss };
}

/* ── errors → words ──────────────────────────────────────────────────── */
const NAME_REASONS = {
    taken: 'That username is taken.',
    username_taken: 'That username is taken.',
    reserved: 'That name is reserved.',
    profane: 'That name isn’t allowed.',
    profanity: 'That name isn’t allowed.',
    offensive: 'That name isn’t allowed.',
    held: 'That name was used recently and is on hold for now.',
    too_short: 'Use at least 3 characters.',
    short: 'Use at least 3 characters.',
    too_long: 'Use at most 16 characters.',
    long: 'Use at most 16 characters.',
    invalid_chars: 'Only letters, numbers and _ are allowed.',
    chars: 'Only letters, numbers and _ are allowed.',
    charset: 'Only letters, numbers and _ are allowed.',
    format: 'Only letters, numbers and _ are allowed.',
    invalid: 'Only letters, numbers and _ are allowed.',
    underscores: 'Too many underscores.',
    same: 'That’s already your username.',
};
const PASSWORD_REASONS = {
    too_short: 'Use at least 8 characters.',
    short: 'Use at least 8 characters.',
    too_long: 'Use at most 128 characters.',
    long: 'Use at most 128 characters.',
    same_as_username: 'Your password can’t be your username.',
    username: 'Your password can’t be your username.',
    common: 'That password is too common. Pick something harder to guess.',
    too_common: 'That password is too common. Pick something harder to guess.',
};

// Reasons may arrive as short codes or as ready-made sentences.
function reasonText(map, reason, fallback) {
    if (!reason) return fallback;
    const key = String(reason).toLowerCase();
    if (map[key]) return map[key];
    if (/\s/.test(reason)) return String(reason);
    return fallback;
}
export const nameReason = (reason) => reasonText(NAME_REASONS, reason, 'That name isn’t available.');

export function humanError(res) {
    const err = (res && res.data && res.data.error) || {};
    const code = err.code || '';
    switch (code) {
        case 'network': return 'Can’t reach the server. Check your connection and try again.';
        case 'timeout': return 'The server took too long to answer. Try again.';
        case 'bad_credentials': return 'That username and password don’t match.';
        case 'bad_password': return 'That password isn’t right.';
        case 'username_taken': return 'That username is taken.';
        case 'invalid_username': return reasonText(NAME_REASONS, err.reason, err.message || 'That username isn’t allowed.');
        case 'weak_password': return reasonText(PASSWORD_REASONS, err.reason, err.message || 'Pick a stronger password.');
        case 'rate_limited': return 'Too many attempts. Try again ' + fmtRetry(err.retryAfter) + '.';
        case 'banned': return 'This account is banned' + (err.until ? ' until ' + fmtDateTime(err.until) : '') + '.' + (err.reason ? ' Reason: ' + err.reason : '');
        case 'cooldown': return 'You can change your username again on ' + fmtDate(err.availableAt) + '.';
        case 'no_password': return 'Set a password first, so you can still log in without Discord.';
        case 'reauth_required': return 'Please confirm with Discord first.';
        case 'unauthorized': case 'not_logged_in': case 'no_session': return 'You’re not logged in any more. Log in again.';
        case 'accounts_disabled': case 'accounts_unavailable': return 'Accounts are offline right now. You can still play as a guest.';
        case 'busy': return 'The server is busy. Try again in a few seconds.';
        case 'already_linked': return 'This account already has a Discord linked. Unlink it first.';
    }
    if (res && res.status === 429) return 'Too many attempts. Try again ' + fmtRetry(err.retryAfter) + '.';
    if (err.message && /\s/.test(err.message)) return err.message;
    if (res && res.status >= 500) return 'The server had a problem. Try again in a moment.';
    return 'Something went wrong' + (res && res.status ? ' (' + res.status + ')' : '') + '. Try again.';
}

/* ── formatters ──────────────────────────────────────────────────────── */
export function fmtDate(ms) {
    const d = new Date(+ms || 0);
    try { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return d.toDateString(); }
}
export function fmtDateTime(ms) {
    const d = new Date(+ms || 0);
    try { return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return d.toString(); }
}
// retryAfter is seconds; tolerate an epoch-ms timestamp too.
export function fmtRetry(v) {
    let s = +v || 0;
    if (s > 1e11) s = (s - Date.now()) / 1000;
    s = Math.max(1, Math.ceil(s));
    if (s < 60) return 'in ' + s + ' second' + (s === 1 ? '' : 's');
    const m = Math.ceil(s / 60);
    if (m < 60) return 'in ' + m + ' minute' + (m === 1 ? '' : 's');
    const hr = Math.ceil(m / 60);
    return 'in ' + hr + ' hour' + (hr === 1 ? '' : 's');
}
export function fmtDust(n) {
    const v = Math.max(0, +n || 0);
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ── avatars ─────────────────────────────────────────────────────────── */
// Flat circle in one of the menu's tank colours, picked by a stable hash.
const TANKS = ['a', 'b', 'c', 'd', 'e'];
export function nameHash(s) {
    let x = 2166136261;
    s = String(s || '').toLowerCase();
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
}
export function avatar(name, url, size) {
    const el = h('span', { class: 'dw-av t-' + TANKS[nameHash(name) % TANKS.length], 'aria-hidden': 'true' });
    if (size) el.style.setProperty('--sz', size + 'px');
    const initial = () => { clear(el); el.classList.remove('img'); el.textContent = (String(name || '?').replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase(); };
    if (url) {
        el.classList.add('img');
        const img = h('img', { src: url, alt: '', referrerpolicy: 'no-referrer', draggable: 'false' });
        img.onerror = initial;
        el.appendChild(img);
    } else initial();
    return el;
}
export function guestAvatar(size) {
    const el = h('span', { class: 'dw-av guest', 'aria-hidden': 'true' }, icon('user'));
    if (size) el.style.setProperty('--sz', size + 'px');
    return el;
}

/* ── clipboard / files ───────────────────────────────────────────────── */
export async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through */ }
    try {
        const ta = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) { return false; }
}
export function downloadText(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = h('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}
