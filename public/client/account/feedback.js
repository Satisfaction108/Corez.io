// The Feedback button on the menu's left rail (#homeFeedbackBtn) and its
// modal: a text box, optional category chips, and a small bundle of context
// the player can switch off (game version, browser, screen size, region and
// server, plus who is sending: the account or the guest id). Sends to
// POST /api/feedback, which works for guests and accounts alike, also when
// the game runs inside a portal's iframe.
import * as api from './api.js';
import * as store from './state.js';
import * as ui from './ui.js';

const { h } = ui;
const MAX = 1000;
const MIN = 3;
const CATEGORIES = [['bug', 'Bug'], ['idea', 'Idea'], ['balance', 'Balance'], ['other', 'Other']];
const THANKS = 'Thanks! ZyroX reads every one.';
const DRAFT_KEY = 'dwFeedbackDraft';

const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } },
};

// "Chrome 131 on macOS", "Firefox 133 on Windows", or "" if we can't tell.
export function shortBrowser(ua) {
    ua = String(ua || '');
    let name = '', ver = '';
    const pick = (re, label) => { if (name) return; const m = re.exec(ua); if (m) { name = label; ver = m[1]; } };
    pick(/Edg\/(\d+)/, 'Edge');
    pick(/OPR\/(\d+)/, 'Opera');
    pick(/Firefox\/(\d+)/, 'Firefox');
    pick(/CriOS\/(\d+)/, 'Chrome');
    pick(/Chrome\/(\d+)/, 'Chrome');
    pick(/Version\/(\d+)[\d.]* .*Safari\//, 'Safari');
    let os = '';
    if (/Windows/.test(ua)) os = 'Windows';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Linux/.test(ua)) os = 'Linux';
    const b = name ? name + ' ' + ver : '';
    return b && os ? b + ' on ' + os : b || os;
}

function guestId() {
    const g = ls.get('dwGuestId');
    return /^[a-f0-9]{32}$/.test(g || '') ? g : '';
}

function regionName() {
    const sel = document.querySelector('#regionSelector .region-option.selected');
    if (!sel) return '';
    const n = sel.querySelector('.region-name');
    return ((n && n.textContent) || sel.dataset.region || '').trim();
}

function serverName() {
    const g = window.global;
    if (!g || !g.serverAdd) return '';
    return String(g.serverAdd) + (g.serverPath ? String(g.serverPath) : '');
}

function embedSite() {
    if (!window.dwEmbed) return '';
    const s = ls.get('dwSrc') || '';
    return s.replace(/^embed:/, '') || 'a portal';
}

let versionCache = '';
async function gameVersion() {
    if (versionCache) return versionCache;
    try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (j && j.v) versionCache = String(j.v).slice(0, 40);
    } catch (e) { /* offline: fall back to the page stamp */ }
    if (!versionCache) {
        const meta = document.querySelector('meta[name="client-version"]');
        versionCache = (meta && meta.getAttribute('content')) || '';
    }
    return versionCache;
}

function collectContext(version) {
    const dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    const c = {
        version,
        browser: shortBrowser(navigator.userAgent),
        screen: `${window.innerWidth}x${window.innerHeight}` + (dpr !== 1 ? `@${dpr}x` : ''),
        region: regionName(),
        server: serverName(),
    };
    const embed = embedSite();
    if (embed && embed !== 'a portal') c.embed = embed;
    if (document.body.classList.contains('in-game')) c.inGame = true;
    return c;
}

// "game version 1.2.3, Chrome 131 on macOS, 1440x900 window, US East, your username (ZyroX)"
function contextSummary(c) {
    const user = store.get('user');
    const who = user && user.username ? 'your username (' + user.username + ')' : guestId() ? 'your guest id' : '';
    const bits = [];
    if (c.version) bits.push('game version ' + c.version);
    if (c.browser) bits.push(c.browser);
    if (c.screen) bits.push(c.screen.replace(/@.*$/, '') + ' window');
    if (c.region) bits.push(c.region + (c.server ? ' (' + c.server + ')' : ''));
    if (who) bits.push(who);
    return bits.join(', ');
}

let open = null;

function openModal() {
    if (open) return;
    let category = '';
    let sent = false;
    const text = h('textarea', {
        class: 'dw-input fb-text', maxlength: MAX, rows: 5, spellcheck: 'true', 'data-autofocus': '',
        placeholder: 'Found a bug or got an idea? Tell us.', 'aria-label': 'Your feedback',
    });
    text.value = (ls.get(DRAFT_KEY) || '').slice(0, MAX);
    const counter = h('span', { class: 'fb-count', 'aria-live': 'polite' });
    const syncCount = () => {
        const n = text.value.length;
        counter.textContent = n + ' / ' + MAX;
        counter.classList.toggle('near', n > MAX - 100);
    };
    text.addEventListener('input', () => { syncCount(); ls.set(DRAFT_KEY, text.value); });
    // Ctrl/Cmd+Enter sends
    text.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(send); }
    });
    syncCount();

    const chips = CATEGORIES.map(([id, label]) => h('button', {
        type: 'button', class: 'dw-btn fb-chip', 'aria-pressed': 'false', dataset: { cat: id }, text: label,
        onclick: (e) => {
            category = category === id ? '' : id;
            chips.forEach((c) => {
                const on = c.dataset.cat === category;
                c.classList.toggle('on', on);
                c.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            e.currentTarget.blur();
        },
    }));

    let context = collectContext(versionCache);
    const attach = h('input', { type: 'checkbox', checked: true, class: 'fb-attach-box' });
    const note = h('span', { class: 'fb-note-text' });
    const renderNote = () => { note.textContent = 'Also sends: ' + (contextSummary(context) || 'nothing else') + '.'; };
    renderNote();
    gameVersion().then((v) => { context = collectContext(v); if (!sent) renderNote(); });

    const alert = h('div', { class: 'dw-alert', role: 'alert' });
    const send = h('button', { type: 'submit', class: 'dw-btn accent-fill', text: 'Send' });
    const form = h('form', { class: 'dw-form fb-form', novalidate: true },
        h('div', { class: 'fb-chips', role: 'group', 'aria-label': 'What is it about? (optional)' }, chips),
        h('label', { class: 'fb-field' }, text, counter),
        h('label', { class: 'fb-attach' }, attach, note),
        alert,
        h('div', { class: 'dw-modal-actions' },
            h('button', { type: 'button', class: 'dw-btn', text: 'Cancel', onclick: () => m.close() }), send));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = text.value.trim();
        if (body.length < MIN) { ui.showAlert(alert, 'Write a few words first.'); text.focus(); return; }
        ui.setBusy(send, true, 'Sending...');
        ui.showAlert(alert, '');
        const payload = { text: body };
        if (category) payload.category = category;
        const g = guestId();
        if (g && !store.get('user')) payload.guestId = g;
        if (attach.checked) payload.context = collectContext(await gameVersion());
        const r = await api.sendFeedback(payload);
        ui.setBusy(send, false);
        if (!r.ok) {
            const code = r.data && r.data.error && r.data.error.code;
            ui.showAlert(alert, code === 'accounts_unavailable' || r.status === 404
                ? 'Feedback is down rn. Hit us up on Discord instead.'
                : ui.humanError(r));
            return;
        }
        sent = true;
        ls.del(DRAFT_KEY);
        showThanks();
    });

    function showThanks() {
        ui.clear(m.card);
        const done = h('button', { type: 'button', class: 'dw-btn accent-fill', 'data-autofocus': '', text: 'Nice', onclick: () => m.close() });
        m.card.appendChild(h('div', { class: 'fb-thanks' },
            h('div', { class: 'fb-thanks-ic' }, ui.icon('check')),
            h('div', { class: 'dw-modal-h', text: THANKS }),
            h('div', { class: 'dw-modal-actions' }, done)));
        setTimeout(() => { try { done.focus({ preventScroll: true }); } catch (e) { /* */ } }, 30);
    }

    const m = ui.modal({
        title: 'Send feedback',
        message: 'Bugs, ideas, balance, anything. It goes straight to the dev.',
        body: form,
        cls: 'fb-modal',
        focus: '.fb-text',
        onClose: () => { open = null; },
    });
    open = m;
}

export function isOpen() { return !!open; }

export function init() {
    const btn = document.getElementById('homeFeedbackBtn');
    if (!btn) return;
    btn.addEventListener('click', () => { btn.blur(); openModal(); });
    // QA hook
    window.dwFeedback = { open: openModal, shortBrowser };
}
