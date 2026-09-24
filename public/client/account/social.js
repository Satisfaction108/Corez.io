// Friends data and the live connection. One copy of the lists (friends,
// requests both ways, blocked) that the Friends pane, the nav badge and the
// gift picker read; it is filled by GET /api/friends and kept fresh by the
// Server-Sent Events stream at /api/events while the menu shows. If the
// stream can't be used, /api/friends is polled every 15 s instead. The
// stream closes when a game starts and opens again back in the menu.
// Chat: each friend row carries {unread, last}; the open chat view
// (chat.js) says which friend it shows, so their messages don't count as
// unread or toast. DMs that land while in a raid (or while the stream was
// closed for one) come back as one toast in the menu.
import * as api from './api.js';
import * as store from './state.js';
import { toast } from './ui.js';
import { rankOf } from './people.js';

const POLL_MS = 15000;
const ES_RETRY_MS = 120000;   // after falling back, try the stream again this often

const data = { loaded: false, friends: [], incoming: [], outgoing: [], blocked: [] };
const subs = new Set();
const dmSubs = new Set();
let activeChat = null;   // userId of the chat on screen, or null
let hooks = { onRevoked() {}, refreshMe() {}, openPane() {}, onStoreReset() {} };

export const get = () => data;
export function on(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit(why) {
    paintBadge();
    subs.forEach((fn) => { try { fn(data, why); } catch (e) { console.error(e); } });
}

// fn({type:'dm', peer, message} | {type:'dmRead', peer, upTo, by})
export function onDm(fn) { dmSubs.add(fn); return () => dmSubs.delete(fn); }
function emitDm(ev) { dmSubs.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } }); }
let activeShown = null;
// shown(): whether that chat is really on screen right now (the hub can
// switch panes without closing the Friends one)
export function setActiveChat(id, shown) { activeChat = id || null; activeShown = id ? shown || null : null; }
const chatOnScreen = (id) => !!activeChat && activeChat === id && (!activeShown || activeShown());
export const totalUnread = () => data.friends.reduce((n, f) => n + (f.unread | 0), 0);
export const friendById = (id) => data.friends.find((f) => f.userId === id) || null;
function patchFriend(id, fn) {
    let hit = false;
    data.friends = data.friends.map((f) => { if (f.userId !== id) return f; hit = true; return Object.assign({}, f, fn(f)); });
    return hit;
}
// The chat view read everything up to now.
export function markReadLocal(id) {
    const f = friendById(id);
    if (!f || !(f.unread | 0)) return;
    patchFriend(id, () => ({ unread: 0 }));
    emit('read');
}
// After a send / an incoming message: the row's preview line.
export function setLast(id, m) {
    if (!m) return;
    const f = friendById(id);
    if (f && f.last && (f.last.at || 0) > (m.at || 0)) return;
    patchFriend(id, () => ({ last: { body: m.body, at: m.at, from: m.from } }));
}

const inGame = () => document.body.classList.contains('in-game');
const loggedIn = () => !!store.get('user') && store.get('mode') === 'user';

/* ── the lists ──────────────────────────────────────────────────────── */
const arr = (x) => (Array.isArray(x) ? x : []);
function setLists(d, opts) {
    if (!d || typeof d !== 'object') return;
    const before = new Set(data.incoming.map((x) => x.userId));
    const unreadBefore = new Map(data.friends.map((f) => [f.userId, f.unread | 0]));
    const had = data.loaded;
    data.friends = arr(d.friends);
    data.incoming = arr(d.incoming);
    data.outgoing = arr(d.outgoing);
    data.blocked = arr(d.blocked);
    data.loaded = true;
    // requests that came in while we weren't listening get one toast
    if (had && opts && opts.announce) {
        const fresh = data.incoming.filter((x) => !before.has(x.userId));
        if (fresh.length === 1) requestToast(fresh[0]);
        else if (fresh.length > 1) menuToast(fresh.length + ' new friend requests!', { actions: [{ label: 'View', onClick: () => hooks.openPane('friends', { tab: 'requests' }) }] });
        // messages that came in while the stream was closed (a raid, a blip)
        for (const f of data.friends) {
            const n = (f.unread | 0) - (unreadBefore.get(f.userId) || 0);
            if (n <= 0 || chatOnScreen(f.userId)) continue;
            dmPend.n += n;
            dmPend.last = f.last && f.last.from === 'them' ? { userId: f.userId, username: f.username, body: f.last.body } : null;
        }
        flushDm();
    }
    emit('lists');
}

let loadSeq = 0;
export async function load() {
    if (!loggedIn()) return null;
    const seq = ++loadSeq;
    const r = await api.friends();
    if (seq !== loadSeq) return r;
    if (r.ok && r.data) setLists(r.data, { announce: true });
    else if (r.status === 401) hooks.refreshMe();
    return r;
}

const drop = (list, id) => list.filter((x) => x.userId !== id);
const upsert = (list, row) => drop(list, row.userId).concat([row]);

// After a POST that changed things: patch the lists without a round trip.
export function apply(kind, row) {
    const id = row && row.userId;
    if (!id) return;
    switch (kind) {
        case 'friend':
            data.friends = upsert(data.friends, row);
            data.incoming = drop(data.incoming, id);
            data.outgoing = drop(data.outgoing, id);
            break;
        case 'outgoing': data.outgoing = upsert(data.outgoing, row); break;
        case 'declined': data.incoming = drop(data.incoming, id); break;
        case 'canceled': data.outgoing = drop(data.outgoing, id); break;
        case 'removed': data.friends = drop(data.friends, id); break;
        case 'blocked':
            data.friends = drop(data.friends, id);
            data.incoming = drop(data.incoming, id);
            data.outgoing = drop(data.outgoing, id);
            data.blocked = upsert(data.blocked, row);
            break;
        case 'unblocked': data.blocked = drop(data.blocked, id); break;
    }
    emit(kind);
}

export const isFriend = (id) => data.friends.some((f) => f.userId === id);

/* ── the nav badge ──────────────────────────────────────────────────── */
function paintBadge() {
    const b = document.querySelector('.dw-nav-btn[data-pane="friends"]');
    if (!b) return;
    const reqs = loggedIn() ? data.incoming.length : 0, unread = loggedIn() ? totalUnread() : 0;
    const n = reqs + unread;
    let pill = b.querySelector('.dw-nav-count');
    if (!n) { if (pill) pill.remove(); b.removeAttribute('data-count'); return; }
    if (!pill) { pill = document.createElement('span'); pill.className = 'dw-nav-count'; b.appendChild(pill); }
    pill.textContent = n > 9 ? '9+' : String(n);
    b.setAttribute('data-count', String(n));
    const bits = [];
    if (reqs) bits.push(reqs + ' request' + (reqs === 1 ? '' : 's'));
    if (unread) bits.push(unread + ' unread message' + (unread === 1 ? '' : 's'));
    b.setAttribute('aria-label', 'Friends, ' + bits.join(', '));
}

/* ── toasts (menu only) ─────────────────────────────────────────────── */
const queued = [];
function menuToast(msg, opts) {
    if (inGame()) { if (queued.length < 4) queued.push([msg, opts]); return; }
    toast(msg, opts);
}
export function flushToasts() {
    while (queued.length && !inGame()) { const [m, o] = queued.shift(); toast(m, o); }
    flushDm();
}

// DMs: "Sam: hey!" [Reply] in the menu; in a raid they add up and come
// back as one toast.
const dmPend = { n: 0, last: null };
const clip = (s, n) => { const a = Array.from(String(s || '')); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
function showDm(p) {
    toast(p.username + ': ' + clip(p.body, 48), {
        duration: 6000,
        actions: [{ label: 'Reply', onClick: () => hooks.openPane('friends', { chat: p.userId }) }],
    });
}
function dmToast(p) {
    dmPend.n++;
    dmPend.last = p;
    flushDm();
}
function flushDm() {
    if (inGame() || !dmPend.n) return;
    const { n, last } = dmPend;
    dmPend.n = 0; dmPend.last = null;
    if (n === 1 && last) return showDm(last);
    toast(n + ' new message' + (n === 1 ? '' : 's'), { duration: 6000, actions: [{ label: 'View', onClick: () => hooks.openPane('friends', { tab: 'friends' }) }] });
}

function requestToast(p) {
    menuToast(p.username + ' wants to be friends!', {
        duration: 8000,
        actions: [{ label: 'Accept', onClick: () => acceptRequest(p) }],
    });
}

export async function acceptRequest(p) {
    const r = await api.friendRespond(p.userId, true);
    if (!r.ok) { toast(friendError(r), { kind: 'error' }); return false; }
    apply('friend', (r.data && r.data.friend) || { userId: p.userId, username: p.username, since: Date.now(), rank: p.rank, presence: null });
    toast('You and ' + p.username + ' are now friends!', { kind: 'ok' });
    return true;
}

const ERR = {
    user_not_found: 'Couldn’t find anyone with that name.',
    self: 'That’s you!',
    already_friends: 'You’re already friends.',
    you_blocked: 'You blocked them. Unblock them first!',
    outgoing_limit: 'Too many requests waiting. Cancel a few first.',
    friend_limit: 'Your friends list is full!',
    their_friend_limit: 'Their friends list is full!',
    not_found: 'That request is gone.',
};
export function friendError(r) {
    const code = r && r.data && r.data.error && r.data.error.code;
    if (code && ERR[code]) return ERR[code];
    if (r && r.status === 404) return ERR.user_not_found;
    if (r && r.status === 429) return 'Whoa, slow down! Try again in a minute.';
    return (r && r.data && r.data.error && r.data.error.message) || 'That didn’t work. Try again!';
}

/* ── live events ────────────────────────────────────────────────────── */
function onEvent(type, d) {
    switch (type) {
        case 'hello': setLists(d, { announce: true }); break;
        case 'presence': {
            const ups = arr(d && d.updates);
            if (!ups.length) break;
            const by = new Map(ups.map((u) => [u.userId, u]));
            data.friends = data.friends.map((f) => {
                const u = by.get(f.userId);
                if (!u) return f;
                const p = { state: u.state, alive: u.alive, score: u.score, place: u.place, lastSeen: u.lastSeen };
                return Object.assign({}, f, { presence: p });
            });
            emit('presence');
            break;
        }
        case 'friendRequest':
            if (!d || !d.userId) break;
            data.incoming = upsert(data.incoming, d);
            emit('friendRequest');
            requestToast(d);
            break;
        case 'friendRequestCanceled':
            if (!d || !d.userId) break;
            data.incoming = drop(data.incoming, d.userId);
            emit('friendRequestCanceled');
            break;
        case 'outgoingAdded':
            if (!d || !d.userId || isFriend(d.userId)) break;
            data.outgoing = upsert(data.outgoing, d);
            emit('outgoing');
            break;
        case 'outgoingRemoved':
            if (!d || !d.userId) break;
            data.outgoing = drop(data.outgoing, d.userId);
            emit('canceled');
            break;
        case 'friendAccepted':
            if (!d || !d.userId) break;
            apply('friend', d);
            menuToast(d.username + ' accepted your friend request.', { kind: 'ok' });
            break;
        case 'friendRemoved':
            if (!d || !d.userId) break;
            apply('removed', d);
            break;
        case 'friendRankUp': {
            if (!d || !d.userId) break;
            const rank = { division: d.division, name: d.name, tier: d.tier };
            data.friends = data.friends.map((f) => (f.userId === d.userId ? Object.assign({}, f, { rank }) : f));
            emit('rank');
            const R = window.DWRanks;
            const tierName = R && d.tier && R.TIER_NAMES ? R.TIER_NAMES[d.tier] : null;
            menuToast(d.tierUp && tierName ? d.username + ' reached ' + tierName + '!' : d.username + ' ranked up to ' + rankOf(rank).text + '!', {
                actions: [{ label: 'Profile', onClick: () => hooks.openPane('profile', { u: d.userId, from: 'friends' }) }],
            });
            break;
        }
        case 'gift': {
            const C = window.DWCosmetics;
            const it = C && d ? C.byId(d.itemId) : null;
            const who = (d && d.from && d.from.username) || 'A friend';
            hooks.refreshMe();
            menuToast(who + ' sent you ' + (it ? it.name : 'a gift') + '!', {
                kind: 'ok', duration: 8000,
                actions: [{ label: 'Locker', onClick: () => hooks.openPane('locker') }],
            });
            break;
        }
        case 'dm': {
            const m = d && d.message;
            if (!m || !m.id || !d.from || !d.to) break;
            const peer = m.from === 'me' ? d.to : d.from;
            if (!isFriend(peer.userId)) break;
            setLast(peer.userId, m);
            const mine = m.from === 'me';
            if (!mine && !chatOnScreen(peer.userId)) {
                patchFriend(peer.userId, (f) => ({ unread: (f.unread | 0) + 1 }));
                dmToast({ userId: peer.userId, username: peer.username, body: m.body });
            }
            emitDm({ type: 'dm', peer: peer.userId, message: m });
            emit('dm');
            break;
        }
        case 'dmRead':
            if (!d || !d.userId) break;
            if (d.by === 'me') patchFriend(d.userId, () => ({ unread: 0 }));
            emitDm({ type: 'dmRead', peer: d.userId, upTo: d.upTo | 0, by: d.by });
            emit('dmRead');
            break;
        case 'storeReset': hooks.onStoreReset(d); break;
        case 'sessionRevoked':
            revoked = true;
            stop();
            hooks.onRevoked();
            break;
    }
}

const TYPES = ['hello', 'presence', 'friendRequest', 'friendRequestCanceled', 'outgoingAdded', 'outgoingRemoved', 'friendAccepted', 'friendRemoved', 'friendRankUp', 'gift', 'dm', 'dmRead', 'storeReset', 'sessionRevoked'];
let es = null, esFails = 0, pollTimer = 0, esRetryTimer = 0, revoked = false;

function openStream() {
    if (es || typeof EventSource !== 'function') return false;
    try { es = new EventSource(api.EVENTS_URL, { withCredentials: true }); } catch (e) { es = null; return false; }
    const me = es;
    for (const t of TYPES) {
        me.addEventListener(t, (ev) => {
            if (es !== me) return;
            let d = null;
            try { d = ev.data ? JSON.parse(ev.data) : {}; } catch (e) { return; }
            onEvent(t, d);
        });
    }
    me.onopen = () => { if (es !== me) return; esFails = 0; stopPolling(); };
    me.onerror = () => {
        if (es !== me) return;
        esFails++;
        // closed for good (401, 404, a proxy that can't stream), or it keeps
        // failing to reconnect: poll instead, and try the stream later
        if (me.readyState === 2 || esFails >= 3) {
            closeStream();
            startPolling();
            clearTimeout(esRetryTimer);
            esRetryTimer = setTimeout(() => { if (wanted()) { esFails = 0; openStream(); } }, ES_RETRY_MS);
        }
    };
    return true;
}
function closeStream() {
    if (!es) return;
    try { es.close(); } catch (e) { /* */ }
    es = null;
}
function startPolling() {
    if (pollTimer) return;
    const tick = async () => {
        pollTimer = 0;
        if (!wanted()) return;
        await load();
        if (wanted() && !es) pollTimer = setTimeout(tick, POLL_MS);
    };
    pollTimer = setTimeout(tick, POLL_MS);
}
function stopPolling() { clearTimeout(pollTimer); pollTimer = 0; }

function stop() {
    closeStream();
    stopPolling();
    clearTimeout(esRetryTimer);
}

const wanted = () => loggedIn() && !inGame() && !revoked && !store.get('offline');

// Match the connection to the page: open in the menu, closed in a game or
// when logged out.
export function sync() {
    if (!wanted()) { stop(); return; }
    if (es || pollTimer) return;
    if (!openStream()) { load(); startPolling(); }
}

let lastUserId = null;
export function init(hs) {
    Object.assign(hooks, hs);
    store.on((s, changed) => {
        if (!changed.some((k) => k === 'user' || k === 'mode' || k === 'offline')) return;
        const id = s.user ? s.user.userId : null;
        if (id !== lastUserId) {
            // a different (or no) account: forget the old lists
            lastUserId = id;
            revoked = false;
            stop();
            Object.assign(data, { loaded: false, friends: [], incoming: [], outgoing: [], blocked: [] });
            dmPend.n = 0; dmPend.last = null; activeChat = null; activeShown = null;
            emit('reset');
        }
        sync();
    });
    new MutationObserver(() => {
        sync();
        if (!inGame()) setTimeout(flushToasts, 600);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
