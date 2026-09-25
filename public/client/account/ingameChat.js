// Friend chat while playing. A key (KEY_FRIEND_CHAT, Esc unless rebound in
// Controls) opens a small panel on the right edge: friends with an online
// dot and unread count, click one for the conversation (chat.js, the same
// view the Friends pane uses). Only chat: no locker, shop or profile here.
//
// Input: while focus is inside the panel nothing reaches the game (the
// canvas never gets the keys, and the root stops them for document
// listeners); opening it drops held movement / fire; closing hands focus
// back to the canvas. Clicks land on the panel, not the canvas, so they
// never shoot.
//
// DMs arrive over the same /api/events stream the menu uses (social.js
// keeps it open in a raid). A DM with the panel shut shows a small toast by
// the chat pip. Everything here runs on events; nothing touches the DOM per
// frame.
import * as social from './social.js';
import * as store from './state.js';
import * as chat from './chat.js';
import { h, icon, clear, animate, T_MID, avatar } from './ui.js';
import { nameEl, presenceText, presenceState, byPresence } from './people.js';
import { global } from '../global.js';

const TOAST_MS = 5000;

const inGame = () => document.body.classList.contains('in-game');
const loggedIn = () => !!store.get('user') && store.get('mode') === 'user' && !store.get('offline');
const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

let root = null, bodyEl = null, hintEl = null, titleEl = null, pip = null, pipCount = null, toastEl = null;
let open = false, view = null, listEl = null, toastTimer = 0, guestHinted = false, shownCount = -1;

// what the Controls table says the key is ("Esc", "L", or "" when unbound)
function keyName() {
    const el = document.querySelector('#controlSettings b[data-key="KEY_FRIEND_CHAT"]');
    return el ? el.textContent.trim() : 'Esc';
}

/* ── DOM (built on first use) ───────────────────────────────────────── */
function build() {
    if (root) return;
    titleEl = h('span', { class: 'igc-title', text: 'Friends' });
    hintEl = h('span', { class: 'igc-hint' });
    const x = h('button', { type: 'button', class: 'igc-x', title: 'Close', 'aria-label': 'Close', onclick: () => close() }, icon('close'));
    bodyEl = h('div', { class: 'igc-body' });
    root = h('div', { id: 'dwIgc', class: 'igc', role: 'dialog', 'aria-label': 'Friend chat', hidden: true },
        h('div', { class: 'igc-head' }, titleEl, hintEl, x), bodyEl);
    // nothing in the panel belongs to the game: keys, clicks, wheel
    for (const t of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'contextmenu', 'touchstart', 'wheel']) {
        root.addEventListener(t, (e) => e.stopPropagation(), t === 'wheel' || t === 'touchstart' ? { passive: true } : undefined);
    }
    pipCount = h('span', { class: 'igc-pip-n' });
    pip = h('button', { type: 'button', class: 'igc-pip', title: 'Friend chat', 'aria-label': 'Friend chat', onclick: () => (open ? close() : openPanel()) }, icon('chat'), pipCount);
    toastEl = h('button', { type: 'button', class: 'igc-toast', 'aria-live': 'polite' });
    for (const el of [pip, toastEl]) {
        for (const t of ['mousedown', 'mouseup', 'click', 'touchstart']) el.addEventListener(t, (e) => e.stopPropagation(), t === 'touchstart' ? { passive: true } : undefined);
    }
    document.body.append(root, pip, toastEl);
}

/* ── the pip: a tiny chat icon with the unread count ────────────────── */
function paintPip() {
    if (!pip) return;
    const show = inGame() && loggedIn() && !open;
    pip.classList.toggle('show', show);
    const n = show ? social.totalUnread() : 0;
    if (n === shownCount) return;
    shownCount = n;
    pip.classList.toggle('hot', n > 0);
    pipCount.textContent = n ? (n > 9 ? '9+' : String(n)) : '';
    const k = keyName();
    pip.title = 'Friend chat' + (k ? ' (' + k + ')' : '');
    pip.setAttribute('aria-label', 'Friend chat' + (n ? ', ' + n + ' unread' : ''));
}

/* ── the toast ──────────────────────────────────────────────────────── */
const clip = (s, n) => { const a = Array.from(String(s || '')); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
function showToast(text, onClick) {
    build();
    clearTimeout(toastTimer);
    const k = keyName();
    clear(toastEl).append(h('span', { class: 'igc-toast-t', text }), onClick && k ? h('span', { class: 'igc-toast-k' }, h('kbd', { text: k }), ' to reply') : null);
    toastEl.onclick = (e) => { e.stopPropagation(); hideToast(); if (onClick) onClick(); };
    toastEl.classList.remove('show');
    void toastEl.offsetWidth;   // restart the slide when one replaces another
    toastEl.classList.add('show');
    toastTimer = setTimeout(hideToast, TOAST_MS);
}
function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.classList.remove('show');
}
let toastPeer = null;
function onGameDm(p) {
    if (!inGame()) return;
    if (open) { if (!view) paintList(); return; }   // the list shows the new count
    toastPeer = p.userId;
    showToast(p.username + ': ' + clip(p.body, 40), () => openPanel(p.userId));
}

/* ── open / close ───────────────────────────────────────────────────── */
function releaseGame() {
    const s = global.socket;
    if (s && s.cmd) for (let i = 0; i < 8; i++) { try { s.cmd.set(i, false); } catch (e) { /* */ } }
}

function openPanel(peer) {
    if (!inGame()) return;
    if (!loggedIn()) {
        if (!guestHinted) { guestHinted = true; showToast('Log in to chat with friends', null); }
        return;
    }
    build();
    hideToast();
    releaseGame();
    const k = keyName();
    hintEl.textContent = k ? k + ' to close' : '';
    if (!open) {
        open = true;
        root.hidden = false;
        animate(root, [{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
    }
    const f = peer && social.friendById(peer);
    if (f) showChat(f, false);
    else showList(false);
    paintPip();
    social.load();   // fresh presence and unread counts
}

function close() {
    if (!open) return;
    open = false;
    if (view) { view.destroy(); view = null; }
    const had = root.contains(document.activeElement);
    root.hidden = true;
    listEl = null;
    clear(bodyEl);
    shownCount = -1;
    paintPip();
    if (had || document.activeElement === document.body) {
        const cv = document.getElementById('gameCanvas');
        if (cv) try { cv.focus({ preventScroll: true }); } catch (e) { cv.focus(); }
    }
}

/* ── views ──────────────────────────────────────────────────────────── */
function showList(slide) {
    if (view) { view.destroy(); view = null; }
    clear(bodyEl);
    titleEl.textContent = 'Friends';
    listEl = h('div', { class: 'igc-list' });
    bodyEl.appendChild(listEl);
    paintList();
    if (slide) animate(listEl, [{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
    setTimeout(() => {
        if (!open || view || !listEl) return;
        const b = listEl.querySelector('.igc-row');
        try { (b || root.querySelector('.igc-x')).focus({ preventScroll: true }); } catch (e) { /* */ }
    }, 30);
}

function paintList() {
    if (!listEl) return;
    const d = social.get();
    const had = listEl.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    clear(listEl);
    if (!d.loaded) { listEl.appendChild(h('div', { class: 'igc-empty', text: 'Finding your friends…' })); return; }
    if (!d.friends.length) { listEl.appendChild(h('div', { class: 'igc-empty', text: 'No friends yet. Add some from the menu!' })); return; }
    // unread first, then who's around
    const list = d.friends.slice().sort((a, b) => ((b.unread | 0) > 0) - ((a.unread | 0) > 0) || byPresence(a, b));
    for (const f of list) {
        const st = presenceState(f.presence);
        const n = f.unread | 0;
        const msg = n > 0 && f.last && f.last.from === 'them';
        const b = h('button', { type: 'button', class: 'igc-row st-' + st, 'data-id': f.userId, onclick: () => showChat(f, true) },
            h('span', { class: 'fr-avwrap' }, avatar(f.username, null, 28), h('span', { class: 'fr-dot ' + st })),
            h('span', { class: 'fr-txt' },
                h('span', { class: 'fr-name' }, nameEl(f.username, f.nameStyleNid, f.nameColor, 13)),
                h('span', { class: 'fr-sub ' + (msg ? 'st-msg' : 'st-' + st), text: msg ? f.last.body : presenceText(f.presence, f.rank) })),
            n ? h('span', { class: 'fr-unread', text: n > 99 ? '99+' : String(n) }) : null);
        listEl.appendChild(b);
    }
    if (had) { const b = listEl.querySelector('.igc-row[data-id="' + CSS.escape(had) + '"]'); if (b) try { b.focus({ preventScroll: true }); } catch (e) { /* */ } }
}

function showChat(f, slide) {
    if (view) { view.destroy(); view = null; }
    listEl = null;
    clear(bodyEl);
    titleEl.textContent = 'Chat';
    view = chat.mount(bodyEl, f, {
        onBack: () => showList(true),
        openProfile() { /* chat only in a raid */ },
        isShown: () => open && inGame(),
    });
    if (slide) animate(view.el, [{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
    setTimeout(() => { if (view) view.focus(); }, 40);
}

/* ── the key ────────────────────────────────────────────────────────── */
function onKey(e) {
    if (!inGame()) return;
    const k = global.KEY_FRIEND_CHAT;
    const code = e.keyCode || e.which;
    const inside = !!root && root.contains(e.target);
    if (open && inside) {
        // Esc always closes; a rebound letter only when not typing it
        if (e.key === 'Escape' || (k > 0 && code === k && !isTyping(e.target))) {
            e.preventDefault(); e.stopPropagation();
            close();
        }
        return;
    }
    if (k == null || k < 0 || code !== k || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target) || !global.gameStart) return;   // game chat box, vault amount, menu
    if (code === 27) {
        // Esc's own jobs in a raid come first
        if (global.shop && global.shop.onPad && !global.shop.dismissed) return;
        if (global.showTree && global.searchBarActive) return;
    }
    e.preventDefault(); e.stopPropagation();
    if (open) close(); else openPanel(toastEl && toastEl.classList.contains('show') ? toastPeer : null);
}

/* ── boot ───────────────────────────────────────────────────────────── */
export function init() {
    window.addEventListener('keydown', onKey, true);
    social.setGameDmHandler(onGameDm);
    social.on((d, why) => {
        if (why === 'reset' && open) close();
        if (open && listEl) paintList();
        paintPip();
    });
    store.on(() => { if (open && !loggedIn()) close(); shownCount = -1; paintPip(); });
    let was = inGame();
    new MutationObserver(() => {
        const now = inGame();
        if (now === was) return;
        was = now;
        if (now) { if (loggedIn()) build(); }
        else { close(); hideToast(); }
        shownCount = -1;
        paintPip();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
