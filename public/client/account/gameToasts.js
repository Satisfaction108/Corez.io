// In-raid notifications: a friend's DM and a duo invite, as small cards at
// top centre under the raid clock, in the in-game plate style (dark face,
// ink outline, hard drop, Lilita titles). They never block the game: clicks
// on a card stay on the card, keys only when a key hint says so.
//
//   dm({userId, username, body})     "Sam: hey where are you"   Esc to reply
//   invite(iv, {accept, decline})    "Sam wants to duo"  [Join] [No thanks], F2 joins
//   note(text, opts)                 a plain line (after accepting: "Leave raid")
//
// Spam: at most 3 cards; DMs from one friend merge into one card (latest
// line, a count), and each friend's card beeps at most once per 4 s.
import { h, clear } from './ui.js';
import { global } from '../global.js';

const MAX = 3;
const DM_MS = 6000, NOTE_MS = 6500;
const SOUND_GAP_MS = 4000;

let stack = null;
const cards = [];          // {key, el, timer, until}
const lastSound = new Map();

const inGame = () => document.body.classList.contains('in-game');
const clip = (s, n) => { const a = Array.from(String(s || '')); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
function keyText(id, dflt) {
    const el = document.querySelector('#controlSettings b[data-key="' + id + '"]');
    const t = el ? el.textContent.trim() : '';
    return el ? t : dflt;
}

function build() {
    if (stack) return;
    stack = h('div', { id: 'dwGameToasts', class: 'gt-stack', 'aria-live': 'polite' });
    document.body.appendChild(stack);
    // sit just under the raid clock cluster (app.js publishes where it ends)
    setInterval(place, 400);
    place();
}
let placedAt = -1;
function place() {
    if (!stack) return;
    const top = Math.max(56, Math.min(window.innerHeight * 0.4, (global.hudTopPx | 0) + 8));
    if (Math.abs(top - placedAt) < 2) return;
    placedAt = top;
    stack.style.top = top + 'px';
}

function beep(key, kind) {
    const now = Date.now();
    if (now - (lastSound.get(key) || 0) < SOUND_GAP_MS) return;
    lastSound.set(key, now);
    const s = window.gameSound;
    try { if (kind === 'invite') s.dustBank(); else s.dustPop(); } catch (e) { /* */ }
}

function remove(card) {
    const i = cards.indexOf(card);
    if (i < 0) return;
    cards.splice(i, 1);
    clearTimeout(card.timer);
    card.el.classList.add('out');
    setTimeout(() => card.el.remove(), 180);
}
function removeKey(key) { const c = cards.find((x) => x.key === key); if (c) remove(c); }
function arm(card, ms) {
    clearTimeout(card.timer);
    card.until = Date.now() + ms;
    card.timer = setTimeout(() => remove(card), ms);
}
function stopClicks(el) {
    for (const t of ['mousedown', 'mouseup', 'click', 'contextmenu', 'touchstart', 'wheel']) {
        el.addEventListener(t, (e) => e.stopPropagation(), t === 'touchstart' || t === 'wheel' ? { passive: true } : undefined);
    }
}
// one card: an accent tag, a title line, an optional sub line, buttons
function card(key, o) {
    build();
    let c = cards.find((x) => x.key === key);
    const el = c ? clear(c.el) : h('div', { class: 'gt-card' + (o.kind ? ' gt-' + o.kind : ''), role: 'status' });
    if (!c) {
        stopClicks(el);
        c = { key, el, timer: 0, until: 0 };
        // newest on top; the oldest goes when there are too many
        cards.unshift(c);
        stack.prepend(el);
        while (cards.length > MAX) remove(cards[cards.length - 1]);
    }
    el.className = 'gt-card' + (o.kind ? ' gt-' + o.kind : '');
    const head = h('div', { class: 'gt-head' },
        h('span', { class: 'gt-tag', text: o.tag }),
        h('span', { class: 'gt-title', text: o.title }),
        o.count > 1 ? h('span', { class: 'gt-count', text: '×' + o.count }) : null);
    el.append(head);
    if (o.sub) el.append(h('div', { class: 'gt-sub', text: o.sub }));
    if (o.buttons && o.buttons.length || o.hint) {
        const row = h('div', { class: 'gt-row' });
        for (const b of o.buttons || []) {
            row.append(h('button', { type: 'button', class: 'gt-btn' + (b.primary ? ' primary' : ''), onclick: (e) => { e.stopPropagation(); b.onClick(); } },
                b.label, b.key ? h('kbd', { text: b.key }) : null));
        }
        if (o.hint) row.append(h('span', { class: 'gt-hint' }, o.hint.key ? h('kbd', { text: o.hint.key }) : null, ' ' + o.hint.text));
        el.append(row);
    }
    if (o.onClick) { el.classList.add('click'); el.onclick = (e) => { if (e.target.closest('button')) return; o.onClick(); }; }
    else el.onclick = null;
    return c;
}

/* ── DMs ────────────────────────────────────────────────────────────── */
const dmCount = new Map();
export function dm(p, onOpen) {
    if (!inGame() || !p) return;
    const key = 'dm:' + p.userId;
    const had = cards.find((x) => x.key === key);
    const n = had ? (dmCount.get(key) || 1) + 1 : 1;
    dmCount.set(key, n);
    const k = keyText('KEY_FRIEND_CHAT', 'Esc');
    const c = card(key, {
        kind: 'dm', tag: 'Message', title: clip(p.username, 16), count: n, sub: clip(p.body, 60),
        hint: k ? { key: k, text: 'to reply' } : null,
        onClick: () => { removeKey(key); if (onOpen) onOpen(); },
    });
    arm(c, DM_MS + Math.min(4000, (n - 1) * 1500));
    beep(key, 'dm');
}
export function clearDm(userId) { removeKey('dm:' + userId); dmCount.delete('dm:' + userId); }
export const hasDm = (userId) => cards.some((x) => x.key === 'dm:' + userId);

/* ── duo invites ────────────────────────────────────────────────────── */
let inviteKeyFor = null;   // the invite card F2 answers
export function invite(iv, handlers) {
    if (!inGame() || !iv || !iv.id) return false;
    const key = 'iv:' + iv.id;
    const name = (iv.from && iv.from.username) || 'A friend';
    const left = Math.max(3000, Math.min(60000, (iv.exp || 0) - Date.now()));
    const k = keyText('KEY_PARTY_ACCEPT', 'F2');
    let busy = false;
    const answer = async (yes) => {
        if (busy) return;
        busy = true;
        removeKey(key);
        if (inviteKeyFor === key) inviteKeyFor = null;
        try { await (yes ? handlers.accept() : handlers.decline()); } catch (e) { /* the handler reports */ }
    };
    const c = card(key, {
        kind: 'invite', tag: 'Duos', title: clip(name, 16) + ' wants to duo',
        sub: 'Join now and play together next raid',
        buttons: [
            { label: 'Join', key: k || null, primary: true, onClick: () => answer(true) },
            { label: 'No thanks', onClick: () => answer(false) },
        ],
    });
    c.answer = answer;
    inviteKeyFor = key;
    arm(c, left);
    beep(key, 'invite');
    return true;
}
export function inviteGone(id) { removeKey('iv:' + id); }

// a plain card: "You're teamed up with Sam" [Leave raid]
export function note(key, title, opts = {}) {
    if (!inGame()) return;
    const c = card('note:' + key, { kind: opts.kind || 'ok', tag: opts.tag || 'Duos', title, sub: opts.sub, buttons: opts.buttons });
    arm(c, opts.ms || NOTE_MS);
}

function onKey(e) {
    if (!inGame() || !inviteKeyFor || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = global.KEY_PARTY_ACCEPT;
    if (!(k > 0) || (e.keyCode || e.which) !== k) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const c = cards.find((x) => x.key === inviteKeyFor);
    if (!c || !c.answer) return;
    e.preventDefault(); e.stopPropagation();
    c.answer(true);
}

export function init() {
    window.addEventListener('keydown', onKey, true);
    // back on the menu: the menu's own toasts take over
    new MutationObserver(() => {
        if (inGame()) return;
        for (const c of cards.slice()) remove(c);
        dmCount.clear();
        inviteKeyFor = null;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.dwGameToasts = { dm, invite, note, inviteGone };
}
