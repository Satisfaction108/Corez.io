// The Friends pane: add by username, then Friends / Requests / Blocked.
// Friends are sorted in a raid, then in the menu, then offline, and show
// what they're up to. Everything reads social.js, so a live event (a new
// request, a friend starting a raid) repaints the open pane in place.
// Clicking a friend slides their chat in (chat.js) over the lists.
import * as api from './api.js';
import * as social from './social.js';
import * as chat from './chat.js';
import { h, icon, clear, confirm, toast, setBusy, animate, collapseOut, avatar, T_MID } from './ui.js';
import { rankOf, badge, nameEl, presenceText, presenceState, byPresence, fmtAgo } from './people.js';
import * as pv from './previews.js';

let hooks = { openProfile() {} };
export function init(hs) { Object.assign(hooks, hs); }

let paneEl = null, tab = 'friends', unsub = null, listEl = null, tabsEl = null;
let homeEl = null, chatView = null, chatWith = null;   // chatWith: userId whose chat is open

const hubOpen = () => { const hub = document.getElementById('dwHub'); return !!hub && hub.classList.contains('open'); };
const paneShown = () => !!paneEl && paneEl.isConnected && paneEl.classList.contains('active') && hubOpen();

export function render(el, opts) {
    paneEl = el;
    if (opts && opts.tab) { tab = opts.tab; if (!opts.chat) chatWith = null; }
    if (opts && opts.chat) { chatWith = opts.chat; tab = 'friends'; }
    closeChat(false);
    pv.stopUnder(el);
    clear(el);
    homeEl = h('div', { class: 'fr-home' });
    homeEl.appendChild(addForm());
    tabsEl = h('div', { class: 'lk-tabs fr-tabs', role: 'tablist' });
    listEl = h('div', { class: 'fr-list', role: 'tabpanel' });
    homeEl.append(tabsEl, listEl);
    el.appendChild(homeEl);
    paint(false);
    if (unsub) unsub();
    unsub = social.on((d, why) => {
        if (!paneEl || !paneEl.isConnected || !paneEl.classList.contains('active')) return;
        paint(false, why);
        // a chat asked for before the lists arrived (a toast's Reply)
        if (chatWith && !chatView && d.loaded) { const f = social.friendById(chatWith); if (f) openChat(f, false); else chatWith = null; }
    });
    social.load();
    if (chatWith) { const f = social.friendById(chatWith); if (f) openChat(f, false); else if (social.get().loaded) chatWith = null; }
}
export function onClose() {
    if (unsub) { unsub(); unsub = null; }
    closeChat(false);
    chatWith = null;
    if (paneEl) pv.stopUnder(paneEl);
}

/* ── the chat view ──────────────────────────────────────────────────── */
function openChat(f, slide = true) {
    if (!paneEl || !homeEl) return;
    closeChat(false);
    chatWith = f.userId;
    chatView = chat.mount(paneEl, f, {
        onBack: () => backToList(),
        openProfile: (p) => hooks.openProfile(p),
        isShown: paneShown,
    });
    homeEl.hidden = true;
    const body = paneEl.closest('.hub-body');
    if (body) body.scrollTop = 0;
    if (slide) animate(chatView.el, [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
    setTimeout(() => { if (chatView) chatView.focus(); }, slide ? 60 : 30);
}
function closeChat(show) {
    if (chatView) {
        chatView.destroy();
        chatView.el.remove();
        chatView = null;
    }
    if (show && homeEl) homeEl.hidden = false;
}
function backToList() {
    if (!chatView) return;
    const id = chatWith;
    chatWith = null;
    closeChat(true);
    paint(false);
    animate(homeEl, [{ opacity: 0, transform: 'translateX(-16px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
    const r = id && rowOf(id);
    if (r) { const b = r.querySelector('.fr-main'); if (b) try { b.focus({ preventScroll: true }); } catch (e) { /* */ } }
}

function addForm() {
    const input = h('input', { class: 'dw-input fr-add-in', type: 'text', maxlength: 16, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', placeholder: 'Add a friend by name', 'aria-label': 'Username to add' });
    const go = h('button', { type: 'submit', class: 'dw-btn primary fr-add-go', text: 'Add' });
    const msg = h('div', { class: 'fr-add-msg', role: 'status' });
    const form = h('form', { class: 'fr-add', novalidate: true }, h('div', { class: 'fr-add-row' }, input, go), msg);
    const say = (text, kind) => { msg.textContent = text || ''; msg.className = 'fr-add-msg' + (text ? ' show' : '') + (kind ? ' ' + kind : ''); };
    input.addEventListener('input', () => say(''));
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        setBusy(go, true, 'Adding…');
        const r = await api.friendRequest(name);
        setBusy(go, false);
        if (!r.ok) { say(social.friendError(r), 'bad'); return; }
        const u = (r.data && r.data.user) || { username: name };
        input.value = '';
        if (r.data && r.data.status === 'accepted') {
            social.apply('friend', r.data.friend || Object.assign({ since: Date.now(), presence: null }, u));
            say('You and ' + u.username + ' are now friends!', 'ok');
        } else {
            social.apply('outgoing', Object.assign({ at: Date.now() }, u));
            say('Friend request sent to ' + u.username + '!', 'ok');
        }
    });
    return form;
}

function paintTabs() {
    const d = social.get();
    clear(tabsEl);
    // Requests counts both ways; only incoming ones get the red "look here"
    const defs = [['friends', 'Friends', d.friends.length, 0], ['requests', 'Requests', d.incoming.length + d.outgoing.length, d.incoming.length], ['blocked', 'Blocked', d.blocked.length, 0]];
    for (const [k, label, n, hot] of defs) {
        tabsEl.appendChild(h('button', {
            type: 'button', class: 'lk-tab' + (tab === k ? ' on' : ''), role: 'tab', 'aria-selected': tab === k ? 'true' : 'false',
            'aria-label': label + ', ' + n + (hot ? ', ' + hot + ' new' : ''),
            onclick: () => { if (tab === k) return; tab = k; paint(true); },
        }, h('span', { text: label }), (k !== 'blocked' || n) ? h('span', { class: 'lk-count', text: String(n) }) : null,
        hot ? h('span', { class: 'fr-hotdot', title: hot + ' waiting for you' }) : null));
    }
}

function paint(fade, why) {
    if (!listEl) return;
    paintTabs();
    // presence changes arrive every few seconds: when the order
    // holds, only the words and dots change, so nothing jumps or loses focus
    if (PATCHABLE.has(why) && tab === 'friends' && patchFriends()) return;
    const d = social.get();
    pv.stopUnder(listEl);
    clear(listEl);
    if (!d.loaded) { listEl.appendChild(h('div', { class: 'shop-loading', text: 'Finding your friends…' })); return; }
    if (tab === 'friends') paintFriends(d);
    else if (tab === 'requests') paintRequests(d);
    else paintBlocked(d);
    if (fade) animate(listEl, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
}

const PATCHABLE = new Set(['presence', 'dm', 'dmRead', 'read']);

function empty(title, text) {
    return h('div', { class: 'fr-empty' }, icon('friends'), h('div', { class: 'fr-empty-h', text: title }), h('div', { class: 'fr-empty-p', text }));
}

function who(p, sub, subCls) {
    const v = rankOf(p.rank);
    return h('div', { class: 'fr-who' },
        badge(v.div, 26, 'fr-badge', { legendNo: v.legendNo }),
        h('div', { class: 'fr-txt' },
            h('div', { class: 'fr-name' }, nameEl(p.username, p.nameStyleNid, p.nameColor, 14)),
            h('div', { class: 'fr-sub' + (subCls ? ' ' + subCls : ''), text: sub })));
}

function row(p, sub, actions, opts) {
    opts = opts || {};
    const st = opts.presence ? presenceState(p.presence) : null;
    const main = h('button', { type: 'button', class: 'fr-main', title: opts.chat ? 'Chat' : 'View profile', onclick: () => (opts.chat ? openChat(p) : hooks.openProfile(p)) },
        h('span', { class: 'fr-avwrap' }, avatarFor(p), st ? h('span', { class: 'fr-dot ' + st, title: st === 'raid' ? 'In a raid' : st === 'menu' ? 'In the lobby' : 'Offline' }) : null),
        who(p, sub, opts.subCls || (st ? 'st-' + st : '')));
    return h('div', { class: 'fr-row' + (st ? ' st-' + st : ''), 'data-id': p.userId }, main, h('div', { class: 'fr-acts' }, actions));
}
const avatarFor = (p) => avatar(p.username, null, 34);

function icBtn(name, label, fn, cls) {
    return h('button', { type: 'button', class: 'fr-ic' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label, onclick: fn }, icon(name));
}

async function leave(rowEl) {
    if (rowEl) await collapseOut(rowEl);
}
const rowOf = (id) => listEl && listEl.querySelector('.fr-row[data-id="' + CSS.escape(id) + '"]');

function patchFriends() {
    const list = social.get().friends.slice().sort(byPresence);
    const rows = listEl.querySelectorAll('.fr-row');
    if (rows.length !== list.length) return false;
    for (let i = 0; i < list.length; i++) {
        if (rows[i].dataset.id !== list[i].userId) return false;
        const prev = rows[i].className.match(/st-(\w+)/);
        if (!prev || prev[1] !== presenceState(list[i].presence)) return false;
    }
    list.forEach((f, i) => {
        const s = subOf(f);
        const sub = rows[i].querySelector('.fr-sub');
        if (sub) { sub.textContent = s.text; sub.className = 'fr-sub ' + s.cls; }
        const acts = rows[i].querySelector('.fr-acts');
        const old = acts && acts.querySelector('.fr-unread');
        const n = f.unread | 0;
        if (old && !n) old.remove();
        else if (n && old) old.textContent = n > 99 ? '99+' : String(n);
        else if (n && acts) acts.insertBefore(unreadPill(n), acts.firstChild);
    });
    return true;
}

// A friend's second line: their newest unread message, else what they're up to.
function subOf(f) {
    if ((f.unread | 0) > 0 && f.last && f.last.from === 'them') return { text: f.last.body, cls: 'st-msg' };
    return { text: presenceText(f.presence, f.rank), cls: 'st-' + presenceState(f.presence) };
}
function unreadPill(n) {
    return h('span', { class: 'fr-unread', title: n + ' unread', text: n > 99 ? '99+' : String(n) });
}

function paintFriends(d) {
    const list = d.friends.slice().sort(byPresence);
    if (!list.length) {
        listEl.appendChild(empty('No friends yet', 'Add someone by name up top. Once they say yes, you can chat and see when they’re online!'));
        return;
    }
    const groups = { raid: [], menu: [], offline: [] };
    for (const f of list) groups[presenceState(f.presence)].push(f);
    const label = { raid: 'In a raid', menu: 'Online', offline: 'Offline' };
    for (const k of ['raid', 'menu', 'offline']) {
        if (!groups[k].length) continue;
        listEl.appendChild(h('div', { class: 'fr-h', text: label[k] + ' · ' + groups[k].length }));
        for (const f of groups[k]) {
            const s = subOf(f);
            listEl.appendChild(row(f, s.text, [
                (f.unread | 0) > 0 ? unreadPill(f.unread | 0) : null,
                h('button', { type: 'button', class: 'dw-btn sm', text: 'Profile', onclick: () => hooks.openProfile(f) }),
                icBtn('unfriend', 'Remove friend', () => removeFriend(f)),
                icBtn('block', 'Block', () => blockUser(f), 'bad'),
            ], { presence: true, chat: true, subCls: s.cls }));
        }
    }
}

function paintRequests(d) {
    if (!d.incoming.length && !d.outgoing.length) {
        listEl.appendChild(empty('No requests', 'Friend requests you send or get show up here.'));
        return;
    }
    if (d.incoming.length) {
        listEl.appendChild(h('div', { class: 'fr-h', text: 'Wants to be friends · ' + d.incoming.length }));
        for (const p of d.incoming.slice().sort((a, b) => (b.at || 0) - (a.at || 0))) {
            listEl.appendChild(row(p, 'Sent ' + fmtAgo(p.at), [
                h('button', { type: 'button', class: 'dw-btn sm primary', text: 'Accept', onclick: async (e) => {
                    const b = e.currentTarget; setBusy(b, true);
                    const el = rowOf(p.userId);
                    const r = await api.friendRespond(p.userId, true);
                    setBusy(b, false);
                    if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return; }
                    await leave(el);
                    social.apply('friend', (r.data && r.data.friend) || Object.assign({ since: Date.now(), presence: null }, p));
                    toast('You and ' + p.username + ' are now friends!', { kind: 'ok' });
                } }),
                h('button', { type: 'button', class: 'dw-btn sm', text: 'Decline', onclick: async (e) => {
                    const b = e.currentTarget; setBusy(b, true);
                    const el = rowOf(p.userId);
                    const r = await api.friendRespond(p.userId, false);
                    setBusy(b, false);
                    if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return; }
                    await leave(el);
                    social.apply('declined', p);
                } }),
                icBtn('block', 'Block', () => blockUser(p), 'bad'),
            ]));
        }
    }
    if (d.outgoing.length) {
        listEl.appendChild(h('div', { class: 'fr-h', text: 'Sent · ' + d.outgoing.length }));
        for (const p of d.outgoing.slice().sort((a, b) => (b.at || 0) - (a.at || 0))) {
            listEl.appendChild(row(p, 'Waiting · sent ' + fmtAgo(p.at), [
                h('button', { type: 'button', class: 'dw-btn sm', text: 'Cancel', onclick: async (e) => {
                    const b = e.currentTarget; setBusy(b, true);
                    const el = rowOf(p.userId);
                    const r = await api.friendCancel(p.userId);
                    setBusy(b, false);
                    if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return; }
                    await leave(el);
                    social.apply('canceled', p);
                } }),
            ]));
        }
    }
}

function paintBlocked(d) {
    if (!d.blocked.length) {
        listEl.appendChild(empty('Nobody blocked', 'Blocked players can’t add you or see your profile.'));
        return;
    }
    for (const p of d.blocked.slice().sort((a, b) => (b.at || 0) - (a.at || 0))) {
        const el = h('div', { class: 'fr-row blocked', 'data-id': p.userId },
            h('div', { class: 'fr-main static' }, h('span', { class: 'fr-avwrap' }, avatarFor(p)),
                h('div', { class: 'fr-who' }, h('div', { class: 'fr-txt' },
                    h('div', { class: 'fr-name' }, h('span', { class: 'pp-name', text: p.username })),
                    h('div', { class: 'fr-sub', text: 'Blocked ' + fmtAgo(p.at) })))),
            h('div', { class: 'fr-acts' }, h('button', { type: 'button', class: 'dw-btn sm', text: 'Unblock', onclick: async (e) => {
                const b = e.currentTarget; setBusy(b, true);
                const r = await api.friendUnblock(p.userId);
                setBusy(b, false);
                if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return; }
                await leave(el);
                social.apply('unblocked', p);
                toast(p.username + ' is unblocked.');
            } })));
        listEl.appendChild(el);
    }
}

/* ── remove / block (also used by the Profile pane) ─────────────────── */
export async function removeFriend(p) {
    const yes = await confirm({ title: 'Remove ' + p.username + '?', message: 'You can always add each other again later.', confirmLabel: 'Remove', danger: true });
    if (!yes) return false;
    const r = await api.friendRemove(p.userId);
    if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return false; }
    await leave(rowOf(p.userId));
    chat.forget(p.userId);
    social.apply('removed', p);
    toast(p.username + ' is no longer your friend.');
    return true;
}

export async function blockUser(p) {
    const yes = await confirm({ title: 'Block ' + p.username + '?', message: 'They’ll be unfriended and won’t be able to add you or see your profile.', confirmLabel: 'Block', danger: true });
    if (!yes) return false;
    const r = await api.friendBlock(p.userId || p.username);
    if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return false; }
    await leave(rowOf(p.userId));
    chat.forget(p.userId);
    social.apply('blocked', (r.data && r.data.blocked) || { userId: p.userId, username: p.username, at: Date.now() });
    toast(p.username + ' is blocked.');
    return true;
}
