// Menu chrome that reflects the account: the chip in the top-right, the
// "Playing as" name box that replaces the name input, and the top nav.
import * as store from './state.js';
import { h, icon, clear, avatar, guestAvatar, fmtDust, toast, modal } from './ui.js';
import { badgeDataUrl } from './rankBadges.js';
import * as pv from './previews.js';
import { hasNew as shopHasNew } from './shop.js';

// Panes that exist; anything else in the nav would say "Coming soon".
const READY = new Set(['shop', 'locker', 'friends', 'profile', 'leaderboard']);

const chip = document.getElementById('accountChip');
const nameBox = document.getElementById('acctNameBox');
const nameText = document.getElementById('acctNameText');
const nav = document.getElementById('menuNav');

let handlers = { onChip() {}, onNameBox() {}, onNav() {}, onLogin() {} };

// What a guest is told about each account-only pane. The nav keeps these
// visible (with a lock) so guests can see what an account gets them.
const LOCKED = {
    shop: { tip: 'Log in to use the Item Shop', title: 'The Item Shop needs an account' },
    locker: { tip: 'Log in to use your Locker', title: 'The Locker needs an account' },
    friends: { tip: 'Log in to add friends', title: 'Friends need an account' },
    profile: { tip: 'Log in to see your profile', title: 'Your profile needs an account' },
};

export function init(hs) {
    Object.assign(handlers, hs);
    chip.addEventListener('click', () => handlers.onChip());
    nameBox.addEventListener('click', () => handlers.onNameBox());
    nav.querySelectorAll('.dw-nav-btn').forEach((b) => {
        b.addEventListener('click', () => {
            const pane = b.dataset.pane;
            if (b.classList.contains('locked')) return lockedPrompt(pane);
            if (b.getAttribute('aria-disabled') === 'true') {
                toast(b.dataset.label + ' is coming soon.');
                return;
            }
            handlers.onNav(pane);
        });
    });
    store.on((s, changed) => {
        if (changed.some((k) => k === 'user' || k === 'mode' || k === 'offline')) render();
    });
}

// "The Item Shop needs an account" [Not now] [Log in]
function lockedPrompt(pane) {
    const L = LOCKED[pane];
    if (!L) return;
    if (store.get('offline')) { toast('Accounts are offline right now.'); return; }
    const m = modal({
        title: L.title, cls: 'dw-modal-sm dw-modal-lock',
        message: 'It’s free, and it keeps your rank and gemdust.',
        body: h('div', { class: 'dw-modal-actions' },
            h('button', { type: 'button', class: 'dw-btn', text: 'Not now', onclick: () => m.close() }),
            h('button', { type: 'button', class: 'dw-btn primary', 'data-autofocus': '', text: 'Log in', onclick: () => { m.close(); handlers.onLogin(); } })),
    });
}

const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } },
};
const cachedName = () => ls.get('dwAcctName') || '';
// The last rank we saw, so the chip and name box paint with their badge
// right away instead of popping it in when /api/me answers.
function cachedRank() {
    try { const r = JSON.parse(ls.get('dwAcctRank') || 'null'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; }
}
function rememberRank(rank) {
    if (!rank) return;
    ls.set('dwAcctRank', JSON.stringify({ division: rank.division, name: rank.name, legendNo: rank.legendNo | 0, placement: rank.placement || null }));
}

// A RankSnap -> what the badge and the text say.
export function rankView(rank) {
    if (!rank) return { div: 'placement', text: 'Unranked' };
    let div = rank.division, text = rank.name || 'Unranked';
    if (div == null) {
        const lives = (rank.placement && rank.placement.lives) | 0;
        div = 'placement';
        text = lives > 0 ? 'Placement ' + Math.min(3, lives) + '/' + ((rank.placement && rank.placement.of) || 3) : 'Unranked';
    } else if ((div | 0) === 18 && rank.legendNo > 0) {
        text = 'Legend #' + rank.legendNo;
    }
    return { div, text };
}
export function badgeImg(div, px, cls) {
    let src = '';
    try { src = badgeDataUrl(div, px); } catch (e) { src = ''; }
    return src ? h('img', { class: cls, src, alt: '', 'aria-hidden': 'true', width: px, height: px, draggable: 'false' }) : null;
}

// The chip's name, in your name style when you have one on.
function chipName(name, u) {
    const st = styleOf(u);
    const el = h('span', { class: 'ac-name', title: name });
    if (st) el.appendChild(styledName(name, st, 13, 'dw-name-cv ac-name-cv', 150));
    else el.textContent = name;
    return el;
}

// The chip's second line: a tiny badge and the rank.
function rankLine(rank) {
    const v = rankView(rank);
    return h('span', { class: 'ac-sub ac-rank' }, badgeImg(v.div, 16, 'ac-badge'), h('span', { text: v.text }));
}

// The "Playing as" box: badge, then the name. Only rebuilt when the
// rank or name changes, so the badge never blinks on a re-render.
let nameSig = '';
function renderNameBox(name, rank, st) {
    const v = rankView(rank);
    const sig = name + '|' + (name ? String(v.div) : '') + '|' + (st ? st.it.id + (st.custom || '') : '');
    if (sig === nameSig) return;
    nameSig = sig;
    const old = nameBox.querySelector('.an-badge');
    if (old) old.remove();
    pv.stopUnder(nameText);
    nameText.textContent = '';
    if (name && st) nameText.appendChild(styledName(name, st, 15, 'dw-name-cv an-name'));
    else nameText.textContent = name;
    nameBox.title = name ? (v.text + '. Change your username in Account settings') : 'Change your username in Account settings';
    if (!name) return;
    const img = badgeImg(v.div, 22, 'an-badge');
    if (img) nameBox.insertBefore(img, nameText);
}

function renderNav(s) {
    const guest = s.mode !== 'user';
    nav.querySelectorAll('.dw-nav-btn').forEach((b) => {
        const L = LOCKED[b.dataset.pane];
        if (!L) {
            // open to everyone (the leaderboard)
            if (READY.has(b.dataset.pane)) { b.removeAttribute('aria-disabled'); b.classList.remove('locked'); b.title = ''; }
            return;
        }
        b.classList.toggle('locked', guest);
        if (guest) {
            b.removeAttribute('aria-disabled');
            b.title = s.offline ? 'Accounts are offline right now' : L.tip;
            b.setAttribute('aria-label', b.dataset.label + ', needs an account');
        } else if (READY.has(b.dataset.pane)) {
            b.removeAttribute('aria-disabled');
            b.title = '';
            b.removeAttribute('aria-label');
        } else {
            b.setAttribute('aria-disabled', 'true');
            b.title = 'Coming soon';
            b.removeAttribute('aria-label');
        }
        // friend requests waiting (the pill itself is social.js's)
        if (b.dataset.pane === 'friends' && !guest && b.dataset.count) b.setAttribute('aria-label', 'Friends, ' + b.dataset.count + ' waiting');
        // a new shop rotation you haven't looked at yet
        if (b.dataset.pane === 'shop') {
            const dot = !guest && shopHasNew();
            b.classList.toggle('has-new', dot);
            if (dot) b.setAttribute('aria-label', 'Item Shop, new items');
        }
    });
}

// Your name in your equipped name style (a canvas), or null for plain text.
function styleOf(u) {
    const eq = u && u.equipped, C = window.DWCosmetics;
    const it = eq && C ? C.byId(eq.nameStyle) : null;
    if (!it) return null;
    if (it.id === 'ns_custom' && !eq.customColor) return null;
    return { it, custom: eq.customColor || null };
}
function styledName(name, st, px, cls, maxW) {
    return pv.nameCanvas(name, st.it, { px, stroke: true, custom: st.custom, font: 'Ubuntu, Rubik, sans-serif', cls, maxW });
}

export function render() {
    const s = store.get();
    const u = s.user;
    if (u && u.rank) rememberRank(u.rank);
    const rank = u ? u.rank : cachedRank();
    pv.stopUnder(chip);
    clear(chip);
    if (s.mode === 'user' && (u || cachedName())) {
        const name = u ? u.username : cachedName();
        chip.classList.remove('guest');
        chip.title = 'Account settings';
        chip.setAttribute('aria-label', 'Account settings for ' + name);
        chip.append(
            avatar(name, u && u.discord && u.discord.avatarUrl, 26),
            h('span', { class: 'ac-text' },
                chipName(name, u),
                rankLine(rank)),
            h('span', { class: 'ac-dust', title: 'Gemdust' }, icon('dust'), h('span', { text: u ? fmtDust(u.dust) : '–' })));
        renderNameBox(name, rank, styleOf(u));
    } else {
        chip.classList.add('guest');
        chip.title = s.offline ? 'Accounts are offline right now' : 'Create an account';
        chip.setAttribute('aria-label', s.offline ? 'Playing as guest. Accounts are offline.' : 'Playing as guest. Create an account.');
        chip.append(
            guestAvatar(26),
            h('span', { class: 'ac-text' },
                h('span', { class: 'ac-name', text: 'Guest' }),
                s.offline
                    ? h('span', { class: 'ac-sub', text: 'Accounts offline' })
                    : h('span', { class: 'ac-sub ac-link', text: 'Create account' })));
        renderNameBox('', null);
    }
    renderNav(s);
    // the chip fades in on its first paint instead of popping
    chip.classList.add('ready');
}
