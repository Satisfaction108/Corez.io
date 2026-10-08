// The Achievements panel: every achievement as a medal card, with progress
// bars for the counting ones, how rare each is ("12% of players have
// this"), and secret ones as ??? until found. Accounts and guests alike
// (POST /api/achievements with the browser's guest id); a guest sees what
// their rewards come to and a Sign up button.
//
// Opens from its own button on the home rail (#homeSidebar, added here) and
// from the profile's Medals section (profile.js). Self contained: styles in
// public/achievements.css, loaded on first open.
import * as api from './api.js';
import * as store from './state.js';
import { h, clear, modal, fmtDate } from './ui.js';
import { glyphIcon, loadCatalog } from './achievements.js';

const NEW_KEY = 'dwAchNew_v1';     // ids unlocked in a raid since the panel was last opened (achievementCard.js writes it)
const CATS = [
    { id: 'first', name: 'First Steps', color: '#7ad3ff' },
    { id: 'combat', name: 'Combat', color: '#ff7a6b' },
    { id: 'mining', name: 'Mining', color: '#e0a060' },
    { id: 'banking', name: 'Banking', color: '#4fe08f' },
    { id: 'tanks', name: 'Tanks', color: '#c3a6ff' },
    { id: 'abilities', name: 'Abilities', color: '#6ee0d6' },
    { id: 'raid', name: 'Raid', color: '#ffc665' },
    { id: 'secret', name: 'Secret', color: '#ff8fcf' },
];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
const fmt = (n) => (Math.round(+n || 0)).toLocaleString('en-US');
const dustTxt = (milli) => { const v = (+milli || 0) / 1000; return Number.isInteger(v) ? String(v) : String(+v.toFixed(2)); };

function lsGet(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } }

function guestId() {
    let g = '';
    try { g = localStorage.getItem('dwGuestId') || ''; } catch (e) { /* */ }
    if (!/^[a-f0-9]{32}$/.test(g)) {
        try {
            g = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem('dwGuestId', g);
        } catch (e) { g = ''; }
    }
    return g;
}

let cssDone = false;
function css() {
    if (cssDone) return;
    cssDone = true;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('../../achievements.css', import.meta.url).href;
    document.head.appendChild(l);
}

// ── the home rail button ──────────────────────────────────────────────
let railBtn = null;
function mountRail() {
    if (railBtn || typeof document === 'undefined') return;
    const bar = document.getElementById('homeSidebar');
    if (!bar) return;
    css();
    railBtn = h('button', { type: 'button', class: 'social-btn', id: 'homeAchBtn', title: 'Achievements', 'aria-label': 'Achievements', onclick: () => open() },
        glyphIcon('cup'));
    const after = document.getElementById('homeChangelogBtn');
    if (after && after.parentNode === bar) after.insertAdjacentElement('afterend', railBtn);
    else bar.appendChild(railBtn);
    refreshDot();
    window.addEventListener('storage', (e) => { if (e.key === NEW_KEY) refreshDot(); });
    // back from a raid: maybe new ones
    new MutationObserver(refreshDot).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
function refreshDot() {
    if (!railBtn) return;
    const n = lsGet(NEW_KEY, []).length;
    railBtn.classList.toggle('has-new', n > 0);
    railBtn.title = n > 0 ? 'Achievements (' + n + ' new)' : 'Achievements';
}

// ── the panel ─────────────────────────────────────────────────────────
let openCard = null;
export async function open(opts) {
    css();
    if (openCard) return;
    const fresh = new Set(lsGet(NEW_KEY, []));
    lsSet(NEW_KEY, []);
    refreshDot();
    const body = h('div', { class: 'ach-body' }, h('div', { class: 'ach-empty', text: 'Loading...' }));
    const m = modal({ title: 'Achievements', cls: 'ach-modal', body, onClose: () => { openCard = null; } });
    openCard = m;
    loadCatalog();
    const r = await api.achievements(guestId());
    if (openCard !== m) return;
    clear(body);
    if (!r.ok || !r.data || !Array.isArray(r.data.achievements)) {
        body.appendChild(head(null, m));
        body.appendChild(h('div', { class: 'ach-empty', text: store.get('offline') ? 'Achievements are down right now. You can still play.' : 'Couldn’t load your achievements. Try again in a bit.' }));
        return;
    }
    render(body, r.data, m, fresh, (opts && opts.cat) || 'all');
}

function head(d, m) {
    const list = d ? d.achievements : [];
    const got = list.filter((a) => a.unlockedAt != null).length;
    const pct = list.length ? Math.round((got / list.length) * 100) : 0;
    const dust = list.filter((a) => a.unlockedAt != null).reduce((s, a) => s + (a.rewardMilli | 0), 0);
    const bar = h('i');
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = pct + '%'; }));
    return h('div', { class: 'ach-top' },
        h('span', { class: 'ach-top-medal' }, glyphIcon('cup')),
        h('div', { class: 'ach-top-txt' },
            h('div', { class: 'ach-title', text: d ? 'Achievements ' + got + ' / ' + list.length : 'Achievements' }),
            d ? h('div', { class: 'ach-sub', text: got ? pct + '% done · ' + dustTxt(dust) + ' gemdust earned' : 'Play a raid and they start popping.' }) : null,
            d ? h('div', { class: 'ach-bar' }, bar) : null),
        h('button', { type: 'button', class: 'ach-close', 'aria-label': 'Close', text: '✕', onclick: () => m.close() }));
}

function render(body, d, m, fresh, cat) {
    const list = d.achievements;
    body.appendChild(head(d, m));
    if (d.guest) {
        const owed = list.filter((a) => a.unlockedAt != null).reduce((s, a) => s + (a.rewardMilli | 0), 0);
        const items = list.filter((a) => a.unlockedAt != null && a.item).length;
        body.appendChild(h('div', { class: 'ach-guest' },
            h('span', {},
                'You’re playing as a guest. ',
                owed || items ? h('b', { text: (owed ? dustTxt(owed) + ' gemdust' : '') + (owed && items ? ' and ' : '') + (items ? items + (items === 1 ? ' name style' : ' name styles') : '') }) : null,
                owed || items ? ' waiting for you. Keep your rewards, no password needed.' : 'Keep your rewards, no password needed.'),
            h('button', { type: 'button', text: 'Keep my stuff', onclick: () => {
                m.close();
                // the one-tap sheet; the account chip's full sign-up if it isn't there
                const a = window.dwAccount;
                if (a && a.openSignup) return a.openSignup();
                const c = document.getElementById('accountChip'); if (c) c.click();
            } })));
    }
    if (d.adoptedNow && d.adoptedNow.ids && d.adoptedNow.ids.length) {
        body.appendChild(h('div', { class: 'ach-guest' }, h('span', { text: d.adoptedNow.ids.length + ' achievements came over from playing as a guest: +' + dustTxt(d.adoptedNow.rewardMilli) + ' gemdust.' })));
    }
    const chips = h('div', { class: 'ach-chips', role: 'tablist' });
    const scroll = h('div', { class: 'ach-scroll' });
    const players = d.players | 0;
    const paint = (which) => {
        clear(scroll);
        const grid = h('div', { class: 'ach-grid' });
        for (const c of CATS) {
            if (which !== 'all' && which !== c.id) continue;
            const mine = list.filter((a) => a.cat === c.id);
            if (!mine.length) continue;
            const n = mine.filter((a) => a.unlockedAt != null).length;
            grid.appendChild(h('div', { class: 'ach-cat-h' }, h('span', { text: c.name }), h('small', { text: n + ' / ' + mine.length })));
            for (const a of mine) grid.appendChild(card(a, players, fresh.has(a.id)));
        }
        scroll.appendChild(grid);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            scroll.querySelectorAll('.ach-prog i').forEach((f) => { f.style.width = f.dataset.w; });
        }));
    };
    const all = [{ id: 'all', name: 'All', color: 'var(--accent)' }].concat(CATS);
    for (const c of all) {
        const mine = c.id === 'all' ? list : list.filter((a) => a.cat === c.id);
        const n = mine.filter((a) => a.unlockedAt != null).length;
        const b = h('button', { type: 'button', class: 'ach-chip' + (c.id === cat ? ' on' : ''), role: 'tab', style: { '--cc': c.color },
            onclick: () => { chips.querySelectorAll('.ach-chip').forEach((x) => x.classList.toggle('on', x === b)); paint(c.id); scroll.scrollTop = 0; } },
        h('i'), c.name, h('em', { text: n + '/' + mine.length }));
        chips.appendChild(b);
    }
    body.appendChild(chips);
    body.appendChild(scroll);
    // the body itself is the scroll area's column
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.minHeight = '0';
    body.style.flex = '1 1 auto';
    paint(cat);
}

function rarityText(a, players) {
    if (!players) return '';
    const p = +a.rarity || 0;
    if (p <= 0) return 'Nobody has this yet';
    if (p < 1) return 'Under 1% of players have this';
    return (p >= 10 ? Math.round(p) : p) + '% of players have this';
}

function itemName(id) {
    try { const it = window.DWCosmetics && window.DWCosmetics.byId(id); return it ? it.name : 'A new'; } catch (e) { return 'A new'; }
}

function card(a, players, isNew) {
    const on = a.unlockedAt != null;
    const counting = !on && a.goal > 1 && !(a.secret);
    const pct = counting ? Math.min(100, Math.round((a.progress / a.goal) * 100)) : 0;
    const rare = rarityText(a, players);
    const tier = ROMAN[a.tier | 0] || '';
    const label = (on ? a.name + ' unlocked ' + fmtDate(a.unlockedAt) : a.name + ', locked: ' + a.desc) + (rare ? '. ' + rare : '');
    return h('div', {
        class: 'ach-card' + (on ? ' on' : '') + (a.secret ? ' secret' : '') + (isNew && on ? ' new' : ''),
        style: { '--ac': a.color }, role: 'listitem', 'aria-label': label,
    },
        h('span', { class: 'ach-medal' }, glyphIcon(a.icon || 'star'), tier ? h('span', { class: 'ach-tier', text: tier }) : null),
        h('div', { class: 'ach-name' }, h('span', { text: a.name })),
        h('div', { class: 'ach-desc', text: a.desc }),
        h('div', { class: 'ach-meta' },
            !a.secret || on ? h('span', { class: 'ach-reward' + (a.item ? ' item' : ''), text: a.item ? '+' + dustTxt(a.rewardMilli) + ' dust · ' + itemName(a.item) + ' style' : '+' + dustTxt(a.rewardMilli) + ' gemdust' }) : null,
            on ? h('span', { text: fmtDate(a.unlockedAt) }) : null,
            rare ? h('span', { class: 'ach-rare' + ((+a.rarity || 0) < 5 && on ? ' rare' : ''), text: rare }) : null),
        counting ? h('div', { class: 'ach-prog' },
            h('span', { class: 'ach-bar' }, h('i', { dataset: { w: pct + '%' } })),
            h('b', { text: fmt(a.progress) + ' / ' + fmt(a.goal) })) : null);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountRail);
    else mountRail();
}
window.dwAchPanel = (o) => open(o);
