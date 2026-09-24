// Chat with one friend, inside the Friends pane. friendsPane.js mounts it
// (and slides it in); this file owns the conversation: the newest 50 from
// GET /api/friends/messages, "load older" at the top, optimistic sends with a
// retry, read receipts both ways, and live messages from social.js.
// Threads stay cached per friend for the page's life, so reopening is instant.
import * as api from './api.js';
import * as social from './social.js';
import { h, icon, clear, animate, T_MID } from './ui.js';
import { rankOf, badge, nameEl, presenceText, presenceState } from './people.js';

const MAX = 300;
const GAP_MS = 15 * 60 * 1000;     // a quiet stretch this long gets a time line
const GROUP_MS = 3 * 60 * 1000;    // bubbles closer than this stack tight
const threads = new Map();         // userId -> {msgs, hasMore, loaded}
let tmpSeq = 0;

const thread = (id) => {
    let t = threads.get(id);
    if (!t) threads.set(id, t = { msgs: [], hasMore: false, loaded: false });
    return t;
};
export function forget(id) { threads.delete(id); }
// unfriended / blocked / another account: nothing of theirs stays around
social.on((d, why) => {
    if (why === 'reset') { threads.clear(); return; }
    if (!d.loaded) return;
    for (const id of Array.from(threads.keys())) if (!social.isFriend(id)) threads.delete(id);
});
const len = (s) => Array.from(s).length;
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function upsert(t, m) {
    const i = t.msgs.findIndex((x) => x.id === m.id);
    if (i >= 0) t.msgs[i] = Object.assign({}, t.msgs[i], m);
    else t.msgs.push(m);
    // confirmed messages in id order, anything still sending after them
    t.msgs.sort((a, b) => (a.tmp ? Infinity : a.id) - (b.tmp ? Infinity : b.id) || 0);
}

/* ── times ──────────────────────────────────────────────────────────── */
const DAY = 86400000;
function clock(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}
function when(ms) {
    const d = new Date(ms), now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= start) return 'Today ' + clock(ms);
    if (ms >= start - DAY) return 'Yesterday ' + clock(ms);
    if (ms >= start - 6 * DAY) return d.toLocaleDateString([], { weekday: 'long' }) + ' ' + clock(ms);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString([], opts) + ', ' + clock(ms);
}

/* ── the view ───────────────────────────────────────────────────────── */
// mount(host, friend, {onBack, openProfile, isShown}) -> {el, destroy(), focus()}
export function mount(host, friend, opts) {
    const peer = friend.userId;
    const t = thread(peer);
    let alive = true, loadingOlder = false, loadFailed = false, readTimer = 0;
    const fresh = new Set();   // ids to animate in on the next paint

    const shown = () => alive && el.isConnected && opts.isShown() && document.visibilityState !== 'hidden';

    // header
    const back = h('button', { type: 'button', class: 'fr-back', title: 'Back to friends', 'aria-label': 'Back to friends', onclick: () => opts.onBack() }, icon('back'));
    const badgeWrap = h('span', { class: 'fr-chat-badge' });
    const nameWrap = h('div', { class: 'fr-name' });
    const dot = h('span', { class: 'fr-dot' });
    const presLine = h('span', { class: 'fr-chat-pres-t' });
    const who = h('button', { type: 'button', class: 'fr-chat-who', title: 'View profile', onclick: () => opts.openProfile(social.friendById(peer) || friend) },
        badgeWrap, h('div', { class: 'fr-txt' }, nameWrap, h('div', { class: 'fr-sub fr-chat-pres' }, dot, presLine)));
    const head = h('div', { class: 'fr-chat-head' }, back, who);

    // log
    const top = h('div', { class: 'fr-chat-top' });
    const list = h('div', { class: 'fr-chat-msgs', role: 'log', 'aria-live': 'polite' });
    const log = h('div', { class: 'fr-chat-log' }, top, list);
    const pill = h('button', { type: 'button', class: 'fr-chat-pill', onclick: () => toBottom(true) }, 'New message');

    // input
    const input = h('input', {
        class: 'dw-input fr-chat-in', type: 'text', maxlength: MAX, autocomplete: 'off', spellcheck: 'true', enterkeyhint: 'send',
        placeholder: 'Say something…', 'aria-label': 'Message ' + friend.username,
    });
    const left = h('span', { class: 'fr-chat-left', 'aria-live': 'polite' });
    const send = h('button', { type: 'submit', class: 'dw-btn primary fr-chat-send', text: 'Send', disabled: true });
    const form = h('form', { class: 'fr-chat-form', novalidate: true }, h('div', { class: 'fr-chat-inwrap' }, input, left), send);
    const el = h('div', { class: 'fr-chat' }, head, h('div', { class: 'fr-chat-logwrap' }, log, pill), form);
    host.appendChild(el);

    function paintHead() {
        const f = social.friendById(peer) || friend;
        const v = rankOf(f.rank);
        clear(badgeWrap).appendChild(badge(v.div, 30, 'fr-badge', { legendNo: v.legendNo }));
        clear(nameWrap).appendChild(nameEl(f.username, f.nameStyleNid, f.nameColor, 15));
        const st = presenceState(f.presence);
        dot.className = 'fr-dot ' + st;
        presLine.className = 'fr-chat-pres-t st-' + st;
        presLine.textContent = presenceText(f.presence, f.rank);
    }

    function paintTop() {
        clear(top);
        if (loadFailed) {
            top.appendChild(h('button', { type: 'button', class: 'fr-chat-retry', text: 'Couldn’t load. Try again', onclick: () => (t.loaded ? older() : first()) }));
        } else if (!t.loaded || loadingOlder) {
            top.appendChild(h('div', { class: 'fr-chat-hint', text: 'Loading…' }));
        } else if (t.hasMore) {
            top.appendChild(h('button', { type: 'button', class: 'fr-chat-older', text: 'Load older', onclick: older }));
        } else if (t.msgs.length) {
            top.appendChild(h('div', { class: 'fr-chat-hint', text: 'This is the start of your chat with ' + friend.username + '.' }));
        }
    }

    function paintList() {
        clear(list);
        if (t.loaded && !t.msgs.length) {
            list.appendChild(h('div', { class: 'fr-chat-empty' },
                icon('friends'),
                h('div', { class: 'fr-empty-h', text: 'Say hi to ' + friend.username + '!' }),
                h('div', { class: 'fr-empty-p', text: 'Only you two can see this chat.' })));
            return;
        }
        let prev = null;
        let lastMine = -1;
        t.msgs.forEach((m, i) => { if (m.from === 'me' && !m.tmp) lastMine = i; });
        t.msgs.forEach((m, i) => {
            if (!prev || m.at - prev.at >= GAP_MS) list.appendChild(h('div', { class: 'fr-chat-time', text: when(m.at) }));
            const cont = prev && prev.from === m.from && m.at - prev.at < GROUP_MS;
            const next = t.msgs[i + 1];
            const tail = !next || next.from !== m.from || next.at - m.at >= GROUP_MS;
            const cls = 'fr-msg ' + (m.from === 'me' ? 'me' : 'them') + (cont ? ' cont' : '') + (tail ? ' tail' : '') +
                (m.state === 'sending' ? ' sending' : '') + (m.state === 'failed' ? ' failed' : '');
            const b = h('div', { class: cls, title: when(m.at) }, h('div', { class: 'fr-bubble', text: m.body }));
            if (fresh.has(m.id)) {
                animate(b, [{ opacity: 0, transform: 'translateY(6px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
            }
            list.appendChild(b);
            if (m.state === 'failed') {
                list.appendChild(h('button', { type: 'button', class: 'fr-msg-retry', onclick: () => retry(m) }, (m.why || 'Didn’t send') + ' · ', h('b', { text: 'Retry' })));
            } else if (i === lastMine && m.read) {
                list.appendChild(h('div', { class: 'fr-msg-seen', text: 'Seen' }));
            }
            prev = m;
        });
        fresh.clear();
    }

    const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    function toBottom(smooth) {
        pill.classList.remove('show');
        if (smooth && log.scrollTo) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
        else log.scrollTop = log.scrollHeight;
    }
    function repaint(stick) {
        const was = stick || nearBottom();
        paintTop();
        paintList();
        if (was) toBottom(false);
    }

    /* loading */
    async function first() {
        loadFailed = false;
        paintTop();
        const r = await api.friendMessages(peer);
        if (!alive) return;
        if (!r.ok) {
            if (r.status === 403) { opts.onBack(); return; }
            loadFailed = true;
            paintTop();
            return;
        }
        const pending = t.msgs.filter((m) => m.tmp);
        t.msgs = (r.data.messages || []).slice();
        pending.forEach((m) => t.msgs.push(m));
        t.hasMore = !!r.data.hasMore;
        t.loaded = true;
        repaint(true);
        markRead();
    }
    async function older() {
        if (loadingOlder || !t.hasMore || !t.loaded) return;
        const oldest = t.msgs.find((m) => !m.tmp);
        if (!oldest) return;
        loadingOlder = true;
        loadFailed = false;
        paintTop();
        const r = await api.friendMessages(peer, oldest.id);
        loadingOlder = false;
        if (!alive) return;
        if (!r.ok) { loadFailed = true; paintTop(); return; }
        const h0 = log.scrollHeight, y0 = log.scrollTop;
        const have = new Set(t.msgs.map((m) => m.id));
        t.msgs = (r.data.messages || []).filter((m) => !have.has(m.id)).concat(t.msgs);
        t.hasMore = !!r.data.hasMore;
        paintTop();
        paintList();
        log.scrollTop = log.scrollHeight - h0 + y0;   // stay where you were reading
    }
    log.addEventListener('scroll', () => {
        if (log.scrollTop < 40) older();
        if (nearBottom()) pill.classList.remove('show');
    }, { passive: true });

    /* read receipts */
    function markRead() {
        clearTimeout(readTimer);
        readTimer = setTimeout(() => {
            if (!shown()) return;
            let upTo = 0;
            for (const m of t.msgs) if (m.from === 'them' && !m.read && !m.tmp && m.id > upTo) upTo = m.id;
            social.markReadLocal(peer);
            if (!upTo) return;
            for (const m of t.msgs) if (m.from === 'them' && m.id <= upTo) m.read = true;
            api.friendRead(peer, upTo);
        }, 250);
    }
    const onVis = () => { if (document.visibilityState === 'visible') markRead(); };
    document.addEventListener('visibilitychange', onVis);

    /* sending */
    function setLeft() {
        const n = len(input.value);
        send.disabled = !tidy(input.value);
        const rest = MAX - n;
        left.textContent = rest <= 50 ? String(rest) : '';
        left.className = 'fr-chat-left' + (rest <= 50 ? ' show' : '') + (rest <= 10 ? ' warn' : '');
    }
    input.addEventListener('input', setLeft);
    // nothing typed here belongs to the game (the hub layer stops it too)
    input.addEventListener('keydown', (e) => { e.stopPropagation(); });
    input.addEventListener('keyup', (e) => e.stopPropagation());

    async function deliver(m) {
        m.state = 'sending';
        repaint(true);
        const r = await api.friendSend(peer, m.body);
        if (!threads.has(peer)) return;
        if (r.ok && r.data && r.data.message) {
            t.msgs = t.msgs.filter((x) => x !== m);
            upsert(t, r.data.message);
            social.setLast(peer, r.data.message);
        } else {
            const code = r.data && r.data.error && r.data.error.code;
            if (code === 'not_friends') { t.msgs = t.msgs.filter((x) => x !== m); if (alive) opts.onBack('gone'); return; }
            m.state = 'failed';
            m.why = r.status === 429 ? 'Slow down a sec!' : code === 'too_long' ? 'Too long.' : '';
        }
        if (alive) repaint(false);
    }
    function retry(m) {
        if (m.state !== 'failed') return;
        deliver(m);
    }
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const body = tidy(input.value);
        if (!body) { input.focus(); return; }
        const m = { id: 'tmp' + (++tmpSeq), tmp: true, from: 'me', body, at: Date.now(), read: false, state: 'sending' };
        t.msgs.push(m);
        fresh.add(m.id);
        input.value = '';
        setLeft();
        input.focus();
        deliver(m);
    });

    /* live */
    const offDm = social.onDm((ev) => {
        if (ev.peer !== peer) return;
        if (ev.type === 'dm') {
            const m = ev.message;
            if (m.from === 'me') {
                // our own send from this tab: the POST answer swaps it in
                const mine = t.msgs.find((x) => x.tmp && x.state === 'sending' && x.body === m.body);
                if (mine) t.msgs = t.msgs.filter((x) => x !== mine);
            }
            const stick = m.from === 'me' || nearBottom();
            if (!t.msgs.some((x) => x.id === m.id)) fresh.add(m.id);
            upsert(t, m);
            if (!alive) return;
            repaint(stick);
            if (!stick) pill.classList.add('show');
            if (m.from === 'them') markRead();
        } else if (ev.type === 'dmRead' && ev.by === 'them') {
            let any = false;
            for (const m of t.msgs) if (m.from === 'me' && !m.tmp && m.id <= ev.upTo && !m.read) { m.read = true; any = true; }
            if (any && alive) repaint(false);
        } else if (ev.type === 'dmRead' && ev.by === 'me') {
            for (const m of t.msgs) if (m.from === 'them' && m.id <= ev.upTo) m.read = true;
        }
    });
    const offSocial = social.on((d, why) => {
        if (!alive) return;
        if (d.loaded && !social.isFriend(peer)) { forget(peer); opts.onBack('gone'); return; }
        paintHead();
        // a reconnect brought news we missed: fetch the newest again
        const f = social.friendById(peer);
        if (why === 'lists' && f && (f.unread | 0) > 0 && t.loaded) first();
    });

    social.setActiveChat(peer, shown);
    paintHead();
    setLeft();
    if (t.loaded) repaint(true);
    else paintTop();
    first();

    return {
        el,
        peer,
        focus() { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } },
        destroy() {
            if (!alive) return;
            alive = false;
            clearTimeout(readTimer);
            offDm(); offSocial();
            document.removeEventListener('visibilitychange', onVis);
            social.setActiveChat(null);
        },
        onShow() { markRead(); },
    };
}

