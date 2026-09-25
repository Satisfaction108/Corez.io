// Form fields shared by the welcome screen and the Account pane: a username
// input with live rule hints and a debounced availability check, and a
// new-password + confirm pair.
import * as api from './api.js';
import { h, nameReason } from './ui.js';

const RULE_HINT = '3–16 letters, numbers or _';

// Mirrors the server rule /^[A-Za-z0-9_]{3,16}$/, not all underscores, no "___".
// Returns null when the name passes, else { level: 'hint'|'bad', text }.
export function localNameProblem(n) {
    if (!n) return { level: 'hint', text: RULE_HINT };
    if (/[^A-Za-z0-9_]/.test(n)) return { level: 'bad', text: 'Letters, numbers and _ only' };
    if (/^_+$/.test(n) || n.indexOf('___') >= 0) return { level: 'bad', text: 'Too many underscores in a row' };
    if (n.length < 3) return { level: 'hint', text: '3 letters minimum' };
    if (n.length > 16) return { level: 'bad', text: '16 letters max' };
    return null;
}

function setHint(hint, input, level, text) {
    hint.className = 'dw-hint' + (level === 'ok' ? ' ok' : level === 'bad' ? ' bad' : '');
    hint.textContent = text || '';
    input.classList.toggle('bad', level === 'bad');
}

// opts: { label, placeholder, value, current, check, autocomplete, onChange(status) }
// status: 'empty' | 'bad' | 'checking' | 'ok' | 'taken' | 'same' | 'unknown'
export function usernameField(opts) {
    opts = opts || {};
    const input = h('input', {
        class: 'dw-input', type: 'text', name: 'username', maxlength: 16, spellcheck: 'false',
        autocapitalize: 'off', autocomplete: opts.autocomplete || 'username',
        placeholder: opts.placeholder || 'your name', value: opts.value || '',
    });
    const hint = h('div', { class: 'dw-hint', 'aria-live': 'polite' });
    const el = h('label', { class: 'dw-field' },
        opts.label === false ? null : h('span', { class: 'field-label', text: opts.label || 'Name' }), input, opts.check ? hint : null);
    let status = 'empty', timer = 0, seq = 0;
    const notify = () => { if (opts.onChange) opts.onChange(status); };

    function update() {
        const n = input.value.trim();
        clearTimeout(timer);
        const my = ++seq;
        if (!opts.check) { status = n ? 'ok' : 'empty'; return notify(); }
        const p = localNameProblem(n);
        if (p) { status = p.level === 'bad' ? 'bad' : 'empty'; setHint(hint, input, p.level, p.text); return notify(); }
        if (opts.current && n === opts.current) { status = 'same'; setHint(hint, input, 'hint', 'That’s your name already'); return notify(); }
        if (opts.current && n.toLowerCase() === opts.current.toLowerCase()) { status = 'ok'; setHint(hint, input, 'ok', 'Just changing the capitals'); return notify(); }
        status = 'checking';
        setHint(hint, input, 'hint', 'checking...');
        notify();
        timer = setTimeout(async () => {
            const r = await api.usernameAvailable(n);
            if (my !== seq) return;
            if (r.ok && r.data && r.data.available === true) { status = 'ok'; setHint(hint, input, 'ok', n + ' is free'); }
            else if (r.ok && r.data && r.data.available === false) { status = 'taken'; setHint(hint, input, 'bad', nameReason(r.data.reason || 'taken')); }
            else { status = 'unknown'; setHint(hint, input, 'hint', 'Couldn’t check. Try it anyway'); }
            notify();
        }, 400);
    }
    input.addEventListener('input', update);
    if (opts.check) update();

    return {
        el, input,
        get status() { return status; },
        get value() { return input.value.trim(); },
        // why the name can't be submitted yet, or '' when it can
        problem() {
            const n = input.value.trim();
            if (!n) return 'Pick a name first';
            const p = localNameProblem(n);
            if (p) return p.level === 'bad' ? p.text : RULE_HINT + '.';
            if (status === 'taken' || status === 'bad') return hint.textContent || 'Can’t use that name';
            if (status === 'same') return 'That’s your name already';
            return '';
        },
        setError(msg) { status = 'taken'; setHint(hint, input, 'bad', msg); notify(); },
        focus() { input.focus(); },
    };
}

// New password + confirm. opts: { label, confirmLabel, username: () => string, onChange(valid) }
export function passwordPair(opts) {
    opts = opts || {};
    const mk = (name, ph) => h('input', { class: 'dw-input', type: 'password', name, autocomplete: 'new-password', maxlength: 128, placeholder: ph });
    const pw = mk('new-password', 'password');
    const cf = mk('confirm-password', 'same again');
    const pwHint = h('div', { class: 'dw-hint', 'aria-live': 'polite' });
    const cfHint = h('div', { class: 'dw-hint', 'aria-live': 'polite' });
    let valid = false;

    function problem() {
        const p = pw.value, c = cf.value, u = (opts.username ? opts.username() : '') || '';
        if (p.length < 8) return 'Password needs 8+ characters';
        if (u && p.toLowerCase() === u.toLowerCase()) return 'Password can’t be your name';
        if (c !== p) return c ? 'Passwords don’t match' : 'Type the password again';
        return '';
    }
    function update() {
        const p = pw.value, c = cf.value, u = (opts.username ? opts.username() : '') || '';
        let pOk = false;
        if (!p) setHint(pwHint, pw, 'hint', '8+ characters');
        else if (p.length < 8) setHint(pwHint, pw, 'hint', (8 - p.length) + ' more to go');
        else if (u && p.toLowerCase() === u.toLowerCase()) setHint(pwHint, pw, 'bad', 'Can’t be your name');
        else { setHint(pwHint, pw, 'ok', 'good'); pOk = true; }
        if (!c) setHint(cfHint, cf, 'hint', '');
        else if (c !== p) setHint(cfHint, cf, 'bad', 'Doesn’t match');
        else setHint(cfHint, cf, pOk ? 'ok' : 'hint', pOk ? 'matches' : '');
        valid = !problem();
        if (opts.onChange) opts.onChange(valid);
    }
    pw.addEventListener('input', update);
    cf.addEventListener('input', update);
    update();

    const els = [
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: opts.label || 'Password' }), pw, pwHint),
        h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: opts.confirmLabel || 'Again' }), cf, cfHint),
    ];
    return {
        els, pw, cf, update, problem,
        get valid() { return valid; },
        get value() { return pw.value; },
    };
}

// Plain single password input (current password prompts).
export function passwordInput(label, opts) {
    opts = opts || {};
    const input = h('input', { class: 'dw-input', type: 'password', name: opts.name || 'current-password', autocomplete: opts.autocomplete || 'current-password', maxlength: 128, placeholder: opts.placeholder || '' });
    const el = h('label', { class: 'dw-field' }, h('span', { class: 'field-label', text: label }), input);
    return { el, input, get value() { return input.value; } };
}
