// The Daily Quests card beside the main menu card (#lobbySide): three
// quests with a bar and a gemdust reward each, and when they change.
// Guests get one quiet line instead. Hidden on narrow screens (CSS).
import * as api from './api.js';
import * as store from './state.js';
import { h, icon, clear, animate, T_MID } from './ui.js';

const side = document.getElementById('lobbySide');
let hooks = { onLogin() {} };
let data = null, fetchedAt = 0, loadSeq = 0, tickTimer = 0, sig = '';

const inGame = () => document.body.classList.contains('in-game');

export function init(hs) {
    Object.assign(hooks, hs);
    if (!side) return;
    store.on((s, changed) => {
        if (!changed.some((k) => k === 'user' || k === 'mode' || k === 'offline')) return;
        const id = s.user ? s.user.userId : '';
        if (id !== sigUser) { sigUser = id; data = null; }
        refresh();
    });
    let was = inGame();
    new MutationObserver(() => {
        const now = inGame();
        if (now === was) return;
        was = now;
        if (!now) setTimeout(refresh, 400);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && data && Date.now() - fetchedAt > 5 * 60000) refresh(); });
    refresh();
}
let sigUser = '';

export async function refresh() {
    if (!side || inGame()) return;
    const s = store.get();
    if (s.mode !== 'user' || !s.user) { data = null; paint(); return; }
    paint();
    const seq = ++loadSeq;
    const r = await api.quests();
    if (seq !== loadSeq) return;
    if (r.ok && r.data && Array.isArray(r.data.quests)) {
        data = r.data;
        data._skew = (r.data.now ? r.data.now : Date.now()) - Date.now();
        fetchedAt = Date.now();
    } else if (!data) data = { failed: true };
    paint();
}

function fmtIn(ms) {
    const m = Math.max(1, Math.ceil(ms / 60000));
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h';
}
const fmtReward = (milli) => { const v = (+milli || 0) / 1000; return Number.isInteger(v) ? String(v) : String(+v.toFixed(2)); };

function paint() {
    clearInterval(tickTimer);
    const s = store.get();
    // guests: one quiet line; new visitors and offline accounts: nothing
    if (s.mode !== 'user') {
        const next = s.mode === 'guest' && !s.offline ? 'guest' : 'none';
        if (sig === next) return;
        sig = next;
        clear(side);
        side.hidden = next === 'none';
        if (next === 'guest') {
            side.appendChild(h('button', { type: 'button', class: 'q-guest', onclick: () => hooks.onLogin() },
                icon('quest'), h('span', { text: 'Log in for daily quests' })));
        }
        return;
    }
    if (!data || data.failed) {
        const next = data && data.failed ? 'none' : 'loading';
        if (sig === next) return;
        sig = next;
        clear(side);
        side.hidden = next === 'none';
        if (next === 'loading') side.appendChild(h('div', { class: 'q-card q-skel' }, h('div', { class: 'q-head' }, h('span', { class: 'q-title', text: 'Quests' }))));
        return;
    }
    const next = JSON.stringify(data.quests.map((q) => [q.id, q.progress, q.done])) + data.day;
    const resetEl = h('span', { class: 'q-reset' });
    const tick = () => {
        const left = (+data.resetsAt || 0) - (Date.now() + (data._skew || 0));
        resetEl.textContent = left > 0 ? 'new in ' + fmtIn(left) : 'new ones soon';
        if (left <= 0) { clearInterval(tickTimer); setTimeout(refresh, 3000); }
    };
    if (sig === next && side.querySelector('.q-reset')) {
        // same quests: just keep the clock running
        const old = side.querySelector('.q-reset');
        old.replaceWith(resetEl);
        tick();
        tickTimer = setInterval(tick, 30000);
        return;
    }
    const first = sig !== next && !sig.startsWith('[');
    sig = next;
    clear(side);
    side.hidden = false;
    const quests = data.quests.slice().sort((a, b) => a.slot - b.slot);
    const doneN = quests.filter((q) => q.done).length;
    const card = h('div', { class: 'q-card' + (doneN === quests.length && quests.length ? ' all' : '') },
        h('div', { class: 'q-head' }, h('span', { class: 'q-title', text: 'Quests' }), resetEl),
        h('div', { class: 'q-list' }, quests.map(row)),
        doneN === quests.length && quests.length ? h('div', { class: 'q-foot', text: 'All done. Come back tomorrow' }) : null);
    side.appendChild(card);
    tick();
    tickTimer = setInterval(tick, 30000);
    if (first) animate(card, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
    // bars grow to their value
    requestAnimationFrame(() => requestAnimationFrame(() => {
        card.querySelectorAll('.q-fill').forEach((f) => { f.style.width = f.dataset.w; });
    }));
}

function row(q) {
    const goal = Math.max(1, q.goal | 0);
    const prog = Math.min(goal, Math.max(0, q.progress | 0));
    const pct = q.done ? 100 : Math.round((prog / goal) * 100);
    return h('div', { class: 'q-row' + (q.done ? ' done' : '') },
        h('div', { class: 'q-line' },
            h('span', { class: 'q-text', text: q.text || 'Quest' }),
            h('span', { class: 'q-reward', title: 'Gemdust' }, icon('dust'), h('span', { text: '+' + fmtReward(q.rewardMilli) }))),
        h('div', { class: 'q-barrow' },
            h('span', { class: 'q-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(goal), 'aria-valuenow': String(prog), 'aria-label': (q.text || 'Quest') + ', ' + prog + ' of ' + goal },
                h('span', { class: 'q-fill', dataset: { w: pct + '%' } })),
            q.done ? h('span', { class: 'q-done' }, icon('check'), h('span', { text: 'done' }))
                : h('span', { class: 'q-num', text: fmtNum(prog) + '/' + fmtNum(goal) })));
}
const fmtNum = (n) => (Math.round(+n || 0)).toLocaleString();
