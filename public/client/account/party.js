// SOLO | DUOS on the menu (remembered in localStorage) and the duo party
// panel: you plus one slot, filled by inviting a friend, sharing the party
// code (guests too: their party identity is a per-tab sessionStorage token),
// or "Fill" (the duo server pairs lone players).
// Play: app.js startGame() asks wantsDuo(); arm() gets a signed ticket (POST
// /api/party/launch, which also pulls the mate in), points the socket at
// <host>/duo and restarts. The socket sends the ticket in 'DQ' after hello.
import * as api from './api.js';
import * as store from './state.js';
import * as social from './social.js';
import { h, icon, clear, toast, setBusy } from './ui.js';
import * as gameToasts from './gameToasts.js';

const MODE_KEY = 'dwPlayMode';
const FILL_KEY = 'dwDuoFill';
const GUEST_KEY = 'dwPartyGuest';
const POLL_MENU_MS = 3000;
const POLL_IDLE_MS = 15000;

const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } },
};
const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* */ } },
};
const inGame = () => document.body.classList.contains('in-game');
const loggedIn = () => !!store.get('user') && store.get('mode') === 'user';

const st = {
    mode: ls.get(MODE_KEY) === 'duo' ? 'duo' : 'solo',
    fill: ls.get(FILL_KEY) !== '0',
    party: null,          // the server's view of your party, or null
    invites: [],          // incoming invites (accounts)
    seenSeq: null,        // last launch.seq we saw (the mate pressing Play moves it)
    adding: false,        // the "add a teammate" drawer is open
    arming: false,
    loaded: false,
};
const inviteToasts = new Map();   // invite id -> toast handle

let els = null;

/* ── errors ─────────────────────────────────────────────────────────── */
const ERR = {
    no_party: 'That party’s gone',
    bad_code: 'Party codes are 5 letters',
    party_full: 'That party’s already full',
    already_in_party: 'Leave your party first',
    already_together: 'You’re already teamed up',
    in_party: 'They’re already in a party',
    in_raid: 'They’re in a raid right now',
    offline: 'They’re offline',
    not_friends: 'You can only invite friends',
    cant_invite: 'You can’t invite them',
    cant_join: 'You can’t join that party',
    invite_gone: 'That invite’s gone',
    self: 'That’s you lol',
    accounts_unavailable: 'Invites are down rn. Share your code instead',
};
function errText(r) {
    const code = r && r.data && r.data.error && r.data.error.code;
    if (code && ERR[code]) return ERR[code];
    if (r && r.status === 429) return 'Slow down a sec';
    if (r && r.status === 0) return 'Couldn’t reach the server';
    return (r && r.data && r.data.error && r.data.error.message) || 'Didn’t work. Try again?';
}

/* ── state from the server ──────────────────────────────────────────── */
function guestName() {
    const inp = document.getElementById('playerNameInput');
    return (inp && inp.value.trim()) || '';
}

function takeGuestToken(d) {
    if (d && d.guestToken) { ss.set(GUEST_KEY, d.guestToken); api.setPartyGuest(d.guestToken); }
}

function applyParty(p, why, who) {
    const before = st.party;
    st.party = p || null;
    // the mate pressed Play: follow them in (menu only, never over a dialog)
    const seq = p && p.launch ? p.launch.seq | 0 : null;
    // (a stale one, say from while you were in a solo raid, only changes the hint)
    if (p && p.launch && !p.launch.byYou && st.seenSeq !== null && seq > st.seenSeq && (p.launch.ago | 0) < 20000) followLaunch(p.launch.by);
    st.seenSeq = seq === null ? (p ? 0 : null) : seq;
    if (why && who && before) {
        if (why === 'join' && !before.full) toast(who + ' joined your party', { kind: 'ok' });
        else if (why === 'left' || why === 'timeout') toast(who + (why === 'timeout' ? ' dropped out of' : ' left') + ' the party');
        else if (why === 'declined') toast(who + ' can’t duo right now');
        else if (why === 'inviteExpired') toast('No answer from ' + who);
    }
    if (p && p.full && st.mode !== 'duo') setMode('duo');
    render();
    // just got a party: poll at the party rate from now on
    if (p && !before) schedule();
}

let loadSeq = 0;
async function load() {
    const seq = ++loadSeq;
    const r = await api.party();
    if (seq !== loadSeq) return;
    if (!r.ok || !r.data) return;
    st.loaded = true;
    if (!r.data.you && ss.get(GUEST_KEY) && !loggedIn()) { ss.del(GUEST_KEY); api.setPartyGuest(''); }
    applyParty(r.data.party);
    const inv = Array.isArray(r.data.invites) ? r.data.invites : [];
    for (const iv of inv) showInvite(iv);
    st.invites = inv;
}

/* ── invites ────────────────────────────────────────────────────────── */
function showInvite(iv) {
    if (!iv || !iv.id || inviteToasts.has(iv.id)) return;
    const left = Math.max(3000, (iv.exp || 0) - Date.now());
    const name = (iv.from && iv.from.username) || 'A friend';
    // in a raid: the in-game card (Join / No thanks, F2 joins)
    if (inGame() && gameToasts.invite(iv, { accept: () => respond(iv, true), decline: () => respond(iv, false) })) {
        inviteToasts.set(iv.id, { dismiss: () => gameToasts.inviteGone(iv.id), game: true });
        setTimeout(() => inviteToasts.delete(iv.id), Math.min(60000, left) + 500);
        return;
    }
    const t = toast(name + ' wants to duo', {
        duration: Math.min(60000, left),
        actions: [
            { label: 'Join', onClick: () => respond(iv, true) },
            { label: 'No thanks', onClick: () => respond(iv, false) },
        ],
    });
    inviteToasts.set(iv.id, t);
    setTimeout(() => inviteToasts.delete(iv.id), Math.min(60000, left) + 500);
}

async function respond(iv, accept) {
    inviteToasts.delete(iv.id);
    const r = await api.partyRespond(iv.id, accept);
    const name = (iv.from && iv.from.username) || 'your friend';
    if (!r.ok) {
        if (!accept) return;
        if (inGame()) gameToasts.note('err' + iv.id, errText(r), { kind: 'error', tag: 'Duos' });
        else toast(errText(r), { kind: 'error' });
        return;
    }
    if (accept) {
        setMode('duo');
        applyParty(r.data.party);
        if (inGame()) {
            // mid-raid: the party is formed; you join them when this raid is
            // done, or leave now (the menu then has Duos + them ready)
            const g = window.global;
            gameToasts.note('joined' + iv.id, 'Teamed up with ' + name, {
                sub: 'You’ll join ' + name + ' after this raid', ms: 9000,
                buttons: [{ label: 'Leave raid to join', primary: true, onClick: () => { if (g && g.exit) g.exit(); } }],
            });
        } else toast('You’re teamed up with ' + name, { kind: 'ok' });
    }
}

export async function inviteFriend(f) {
    if (!f || !f.userId) return false;
    const r = await api.partyInvite(f.userId);
    if (!r.ok) { toast(errText(r), { kind: 'error' }); return false; }
    setMode('duo');
    applyParty(r.data.party);
    toast('Invite sent to ' + f.username + '. It lasts a minute', { kind: 'ok' });
    return true;
}
export const partyHas = (userId) => !!(st.party && st.party.members.some((m) => m.userId === userId));
export const invitePending = (username) => !!(st.party && (st.party.pending || []).some((p) => p.to === username));

function onPartyEvent(type, d) {
    if (type === 'party') applyParty(d.party || null, d.why, d.who);
    else if (type === 'partyInvite') showInvite(d);
    else if (type === 'partyInviteGone') {
        const t = inviteToasts.get(d.id);
        if (t) { t.dismiss(); inviteToasts.delete(d.id); }
    }
}

/* ── actions ────────────────────────────────────────────────────────── */
async function createParty(btn) {
    setBusy(btn, true, '...');
    const r = await api.partyCreate(guestName());
    setBusy(btn, false);
    if (!r.ok) { toast(errText(r), { kind: 'error' }); return; }
    takeGuestToken(r.data);
    loadSeq++;   // a load still in flight predates this party
    applyParty(r.data.party);
}

// The same two for the portal (portal.js): an instant multiplayer start
// makes a party at once, an invite link joins the one in it. No buttons,
// so they answer true / false and toast their own errors.
async function quickCreate() {
    if (st.party) return true;
    const r = await api.partyCreate(guestName());
    if (!r.ok) { toast(errText(r), { kind: 'error' }); return false; }
    takeGuestToken(r.data);
    loadSeq++;   // a load still in flight predates this party
    setMode('duo');
    st.adding = true;
    applyParty(r.data.party);
    toast('Invite a friend to duo, or flip to Solo to go alone', { kind: 'ok', duration: 6000 });
    return true;
}

async function quickJoin(raw) {
    const code = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
    if (code.length !== 5) return false;
    setMode('duo');
    if (st.party && st.party.code === code) return true;
    if (st.party) {
        const out = await api.partyLeave();
        if (!out.ok) { toast(errText(out), { kind: 'error' }); return false; }
        applyParty(null);
    }
    const r = await api.partyJoin(code, guestName());
    if (!r.ok) { toast(errText(r), { kind: 'error' }); return false; }
    takeGuestToken(r.data);
    loadSeq++;   // a load still in flight predates this party
    st.adding = false;
    applyParty(r.data.party);
    const mate = r.data.party && r.data.party.members.find((m) => !m.you);
    const name = mate ? mate.name : 'your friend';
    if (inGame()) {
        const g = window.global;
        gameToasts.note('joined' + code, 'Teamed up with ' + name, {
            sub: 'You’ll join ' + name + ' after this raid', ms: 9000,
            buttons: [{ label: 'Leave raid to join', primary: true, onClick: () => { if (g && g.exit) g.exit(); } }],
        });
    } else toast(mate ? 'You’re in ' + mate.name + '’s party' : 'Joined', { kind: 'ok' });
    return true;
}

async function joinCode(input, btn) {
    const code = input.value.replace(/[\s-]/g, '').toUpperCase();
    if (code.length !== 5) { input.classList.add('bad'); input.focus(); return; }
    setBusy(btn, true, '...');
    const r = await api.partyJoin(code, guestName());
    setBusy(btn, false);
    if (!r.ok) { input.classList.add('bad'); toast(errText(r), { kind: 'error' }); return; }
    takeGuestToken(r.data);
    loadSeq++;   // a load still in flight predates this party
    st.adding = false;
    applyParty(r.data.party);
    const mate = r.data.party && r.data.party.members.find((m) => !m.you);
    toast(mate ? 'You’re in ' + mate.name + '’s party' : 'Joined', { kind: 'ok' });
}

async function leaveParty(btn) {
    setBusy(btn, true, '...');
    const r = await api.partyLeave();
    setBusy(btn, false);
    if (!r.ok) { toast(errText(r), { kind: 'error' }); return; }
    st.adding = false;
    applyParty(null);
}

// On a portal with its own invite links (CrazyGames) the link is what gets
// shared; anywhere else it's '' and the code is
function portalLink(code) {
    try { return (window.dwPortalInvite && window.dwPortalInvite(code)) || ''; } catch (e) { return ''; }
}

function copyCode(code) {
    const link = portalLink(code);
    const what = link || code;
    const done = () => toast((link ? 'Invite link' : 'Code') + ' copied. Send it to your friend', { kind: 'ok' });
    const fail = () => toast(link ? 'Your party code is ' + code : 'Your code is ' + code);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(what).then(done, fail); return; }
    } catch (e) { /* */ }
    fail();
}

/* ── mode ───────────────────────────────────────────────────────────── */
export function setMode(m) {
    st.mode = m === 'duo' ? 'duo' : 'solo';
    ls.set(MODE_KEY, st.mode);
    render();
}
export const mode = () => st.mode;

function setFill(v) {
    st.fill = !!v;
    ls.set(FILL_KEY, st.fill ? '1' : '0');
}

function duoServer() {
    const list = (window.global && window.global.servers) || [];
    return list.find((s) => s && s.mode === 'duo') || null;
}

function paintCounts() {
    if (!els) return;
    const list = (window.global && window.global.servers) || [];
    let solo = 0, duo = 0, soloUp = false, duoUp = false;
    for (const s of list) {
        if (!s) continue;
        if (s.mode === 'duo') { duo += Number(s.players) || 0; duoUp = true; }
        else { solo += Number(s.players) || 0; soloUp = true; }
    }
    els.countSolo.textContent = soloUp ? String(solo) : '';
    els.countDuo.textContent = duoUp ? String(duo) : '';
}

/* ── the panel ──────────────────────────────────────────────────────── */
function initial(name) { return (Array.from(String(name || '?').trim())[0] || '?').toUpperCase(); }

function slot(m, opts = {}) {
    const stateText = { menu: 'In the lobby', playing: 'In the raid', away: 'Away' };
    return h('div', { class: 'duo-slot filled' + (m.you ? ' you' : '') },
        h('span', { class: 'duo-av', 'aria-hidden': 'true', text: initial(m.name) }),
        h('span', { class: 'duo-who' },
            h('span', { class: 'duo-name', title: m.name }, m.name, m.you ? h('span', { class: 'duo-you', text: ' (you)' }) : null),
            h('span', { class: 'duo-sub st-' + (m.you ? 'menu' : m.state), text: m.leader && opts.showLeader ? (m.you ? 'Party leader' : 'Leader · ' + (stateText[m.state] || '')) : (m.you ? 'Ready' : stateText[m.state] || '') })),
        m.leader && opts.showLeader ? h('span', { class: 'duo-crown', title: 'Party leader', 'aria-label': 'Party leader' }) : null);
}

function meName() {
    const u = store.get('user');
    return (u && u.username) || guestName() || 'You';
}

function friendsDrawer() {
    const d = social.get();
    const list = d.friends.slice().sort((a, b) => {
        const o = { menu: 0, raid: 1, offline: 2 };
        const sa = (a.presence && a.presence.state) || 'offline', sb = (b.presence && b.presence.state) || 'offline';
        return (o[sa] - o[sb]) || String(a.username).localeCompare(String(b.username));
    }).slice(0, 12);
    const box = h('div', { class: 'duo-friends' });
    if (!d.loaded) { box.appendChild(h('div', { class: 'duo-note', text: 'Finding your friends...' })); social.load(); return box; }
    if (!list.length) { box.appendChild(h('div', { class: 'duo-note', text: 'No friends yet. Add some in Friends, or use a code.' })); return box; }
    for (const f of list) {
        const s = (f.presence && f.presence.state) || 'offline';
        const inParty = partyHas(f.userId), pending = invitePending(f.username);
        const can = (s === 'menu' || s === 'raid') && !inParty;
        const why = inParty ? 'Teamed up' : pending ? 'Invited' : s === 'raid' ? (f.presence && f.presence.mode === 'duo' ? 'In a duo raid' : 'In a raid') : s === 'offline' ? 'Offline' : 'In the lobby';
        const btn = h('button', { type: 'button', class: 'dw-btn sm' + (can && !pending ? ' primary' : ''), text: pending ? 'Again' : 'Invite', disabled: !can,
            onclick: async (e) => { const b = e.currentTarget; setBusy(b, true, '...'); await inviteFriend(f); setBusy(b, false); } });
        box.appendChild(h('div', { class: 'duo-friend st-' + s },
            h('span', { class: 'duo-dot st-' + s, 'aria-hidden': 'true' }),
            h('span', { class: 'duo-fname', text: f.username, title: f.username }),
            h('span', { class: 'duo-fsub', text: why }),
            btn));
    }
    return box;
}

function codeJoinRow() {
    const input = h('input', { class: 'dw-input mono duo-code-in', type: 'text', maxlength: 7, spellcheck: 'false', autocapitalize: 'characters', autocomplete: 'off', placeholder: 'CODE', 'aria-label': 'Party code' });
    const go = h('button', { type: 'button', class: 'dw-btn sm', text: 'Join', onclick: () => joinCode(input, go) });
    input.addEventListener('input', () => input.classList.remove('bad'));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); joinCode(input, go); } });
    return h('div', { class: 'duo-join' }, h('span', { class: 'duo-lbl', text: 'Got a code?' }), input, go);
}

function render() {
    if (!els) return;
    const duo = st.mode === 'duo';
    els.opts.forEach((b) => {
        const on = b.dataset.mode === st.mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    els.duoOpt.classList.toggle('has-party', !!(st.party && st.party.full) && !duo);
    document.documentElement.setAttribute('data-play-mode', st.mode);
    const start = document.getElementById('startButton');
    if (start && !st.arming) {
        const b = start.querySelector('b');
        if (b) b.textContent = duo ? 'Play Duos' : 'Play';
    }
    const panel = els.panel;
    panel.hidden = !duo;
    if (!duo) return;
    clear(panel);
    const p = st.party;
    const me = p ? p.members.find((m) => m.you) : { name: meName(), you: true, state: 'menu' };
    const mate = p ? p.members.find((m) => !m.you) : null;
    const slots = h('div', { class: 'duo-slots' }, slot(me, { showLeader: !!mate }));
    if (mate) slots.appendChild(slot(mate, { showLeader: true }));
    else {
        slots.appendChild(h('button', { type: 'button', class: 'duo-slot empty' + (st.adding ? ' open' : ''), 'aria-expanded': st.adding ? 'true' : 'false',
            onclick: () => { st.adding = !st.adding; render(); } },
            h('span', { class: 'duo-plus', 'aria-hidden': 'true', text: '+' }),
            h('span', { class: 'duo-who' }, h('span', { class: 'duo-name', text: 'Add a mate' }),
                h('span', { class: 'duo-sub' + (p && (p.pending || []).length ? ' st-menu' : ''), text: p && (p.pending || []).length ? 'Invite sent' : st.fill ? 'or go random' : 'invite or use a code' }))));
    }
    panel.appendChild(slots);

    if (!mate && st.adding) {
        const drawer = h('div', { class: 'duo-drawer' });
        if (loggedIn() && !store.get('offline')) {
            drawer.appendChild(h('div', { class: 'duo-h', text: 'Invite a friend' }));
            drawer.appendChild(friendsDrawer());
        }
        drawer.appendChild(h('div', { class: 'duo-h', text: loggedIn() ? 'Or use a party code' : 'Party code' }));
        if (p) {
            drawer.appendChild(h('div', { class: 'duo-code' },
                h('span', { class: 'duo-lbl', text: 'Your code' }),
                h('span', { class: 'duo-code-val', text: p.code, title: 'Your party code' }),
                h('button', { type: 'button', class: 'dw-btn sm', onclick: () => copyCode(p.code) }, icon('copy'), portalLink(p.code) ? 'Copy link' : 'Copy')));
        } else {
            drawer.appendChild(h('div', { class: 'duo-code' },
                h('span', { class: 'duo-lbl', text: 'Make a code your friend can type in' }),
                h('button', { type: 'button', class: 'dw-btn sm accent-fill', text: 'Get code', onclick: (e) => createParty(e.currentTarget) })));
        }
        drawer.appendChild(codeJoinRow());
        panel.appendChild(drawer);
    }

    const foot = h('div', { class: 'duo-foot' });
    if (!mate) {
        const cb = h('input', { type: 'checkbox', id: 'duoFillCb', checked: st.fill, onchange: (e) => { setFill(e.currentTarget.checked); render(); } });
        foot.appendChild(h('label', { class: 'duo-fill', for: 'duoFillCb' }, cb, h('span', { class: 'duo-check', 'aria-hidden': 'true' }),
            h('span', { text: 'Fill with a random teammate' })));
    } else {
        foot.appendChild(h('span', { class: 'duo-note', text: mate.state === 'playing' ? mate.name + ' is in the raid. Hit Play to join them.' : 'Hit Play and you both drop in.' }));
    }
    if (p) foot.appendChild(h('button', { type: 'button', class: 'dw-btn sm duo-leave', text: 'Leave', onclick: (e) => leaveParty(e.currentTarget) }));
    panel.appendChild(foot);
}

/* ── launching ──────────────────────────────────────────────────────── */
export function wantsDuo() { return st.mode === 'duo'; }

// Get a ticket (when in a party), point the socket at the duo server, and
// start the game for real. follow: the mate pressed Play first.
export async function arm(follow = false) {
    const g = window.global;
    if (!g || st.arming) return;
    const sv = duoServer();
    if (!sv) { toast('Duos isn’t up right now. Try Solo?', { kind: 'error' }); return; }
    if (sv.maxPlayers && sv.players >= sv.maxPlayers) { toast('The duo server is full. Try again in a minute', { kind: 'error' }); return; }
    st.arming = true;
    const start = document.getElementById('startButton');
    if (start) { start.disabled = true; const b = start.querySelector('b'); if (b) b.textContent = 'Joining...'; }
    let ticket = null;
    try {
        if (st.party) {
            const r = follow ? await api.partyTicket(st.fill) : await api.partyLaunch(st.fill);
            if (r.ok && r.data) { ticket = r.data.ticket || null; st.party = r.data.party || st.party; st.seenSeq = st.party && st.party.launch ? st.party.launch.seq | 0 : st.seenSeq; }
            else if (r.status !== 404) toast(errText(r) + '. Going in without the party', { kind: 'error' });
        }
    } finally {
        st.arming = false;
        if (start) start.disabled = false;
    }
    g.duoArmed = { ticket, fill: st.fill, path: sv.proxyPath || '/duo' };
    render();
    g.startGame();
}

let followTimer = 0;
function followLaunch(byName) {
    if (inGame() || st.arming) return;
    const g = window.global;
    if (!g || g.gameStart || g.gameLoading) return;
    const blocked = window.dwAccount && window.dwAccount.blocksEnter && window.dwAccount.blocksEnter();
    if (blocked) { toast((byName || 'Your mate') + ' dropped in. Hit Play to join them'); return; }
    setMode('duo');
    toast((byName || 'Your mate') + ' hit Play. Dropping you in...', { kind: 'ok', duration: 2200 });
    clearTimeout(followTimer);
    followTimer = setTimeout(() => { if (!inGame() && !(window.global && window.global.gameStart)) arm(true); }, 700);
}

/* ── polling ────────────────────────────────────────────────────────── */
let pollTimer = 0;
function schedule() {
    clearTimeout(pollTimer);
    const ms = inGame() ? POLL_IDLE_MS * 2 : st.party ? POLL_MENU_MS : POLL_IDLE_MS;
    pollTimer = setTimeout(async () => {
        // in a party: keep the mate's status fresh (guests have no stream);
        // an account with its event stream down: still catch invites
        const need = st.party || (loggedIn() && !social.streamOpen());
        if (need && !document.hidden) { try { await load(); } catch (e) { /* */ } }
        schedule();
    }, ms);
}

/* ── boot ───────────────────────────────────────────────────────────── */
export function init() {
    const toggle = document.getElementById('modeToggle');
    const panel = document.getElementById('duoPanel');
    if (!toggle || !panel) return;
    const opts = Array.from(toggle.querySelectorAll('.mode-opt'));
    els = {
        toggle, panel, opts,
        duoOpt: opts.find((b) => b.dataset.mode === 'duo'),
        countSolo: toggle.querySelector('[data-count="solo"]'),
        countDuo: toggle.querySelector('[data-count="duo"]'),
    };
    opts.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    const tok = ss.get(GUEST_KEY);
    if (tok) api.setPartyGuest(tok);
    social.onParty(onPartyEvent);
    render();
    paintCounts();
    setInterval(paintCounts, 2500);
    load();
    schedule();
    // a login / logout changes who you are to the party server
    store.on((s, changed) => {
        if (changed.includes('user')) { st.party = null; st.seenSeq = null; load(); render(); }
    });
    // back on the menu: fresh state at once
    new MutationObserver(() => {
        if (inGame()) return;
        for (const [id, t] of inviteToasts) if (t && t.game) inviteToasts.delete(id);
        load(); render();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.dwParty = { wantsDuo, arm, mode, setMode, inviteFriend, partyHas, invitePending, showInvite, state: () => st,
        create: quickCreate, join: quickJoin, openInvite: () => { st.adding = true; setMode('duo'); } };
}
