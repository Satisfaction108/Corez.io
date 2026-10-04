// The Leaderboard pane: three boards, Ranked (Top 100 by RP), Banked (most
// gems banked, all time) and Wins (raid wins). Places 1-3 wear gold, silver
// and bronze; Legend and up show their Legend #N; your own row is marked, and
// pinned to the bottom when you're outside the list. Guests can look too.
import * as api from './api.js';
import * as store from './state.js';
import { h, clear, humanError, animate, T_MID } from './ui.js';
import { rankOf, badge, nameEl, tierColor, fmtNum, fmtAgo } from './people.js';
import * as pv from './previews.js';

let hooks = { openProfile() {}, onLogin() {} };
export function init(hs) { Object.assign(hooks, hs); }

const BOARDS = {
    ranked: { tab: 'Ranked', sub: 'by RP', col: 'RP', val: (r) => r.rp, empty: ['Nobody’s ranked yet', 'Play 3 placement games and #1 is yours.'] },
    banked: { tab: 'Banked', sub: 'most gems banked', col: 'Banked', val: (r) => r.value, empty: ['Nothing banked yet', 'Bank some gems and claim #1.'] },
    wins: { tab: 'Wins', sub: 'raid wins', col: 'Wins', val: (r) => r.value, empty: ['No winners yet', 'Be the last one standing and you’re on top.'] },
};
let board = 'ranked';
let paneEl = null, loadSeq = 0, cache = null, cachedAt = 0;

export function render(el) {
    paneEl = el;
    pv.stopUnder(el);
    clear(el);
    if (cache && Date.now() - cachedAt < 60000 && cache._for === who() && cache._board === board) paint(el, cache);
    else el.appendChild(h('div', { class: 'shop-loading', text: 'Loading...' }));
    load(el);
}
export function onClose() { if (paneEl) pv.stopUnder(paneEl); }
const who = () => { const u = store.get('user'); return u ? u.userId : ''; };

async function load(el) {
    const seq = ++loadSeq;
    const want = board;
    const r = await api.leaderboard(100, want);
    if (want !== board) return;
    if (seq !== loadSeq || el !== paneEl) return;
    if (!r.ok || !r.data || !Array.isArray(r.data.rows)) {
        if (cache) return;
        clear(el);
        el.appendChild(h('div', { class: 'shop-empty' },
            h('div', { class: 'shop-empty-h', text: 'Didn’t load' }),
            h('div', { class: 'shop-empty-p', text: humanError(r) }),
            h('button', { type: 'button', class: 'dw-btn sm', text: 'Retry', onclick: () => render(el) })));
        return;
    }
    const sig = JSON.stringify([want, r.data.updatedAt, r.data.rows.length, r.data.me && (r.data.me.rp + ':' + r.data.me.value)]);
    const same = cache && cache._sig === sig && el.querySelector('.lb-table');
    cache = r.data;
    cache._sig = sig;
    cache._for = who();
    cache._board = want;
    cachedAt = Date.now();
    if (same) return;
    pv.stopUnder(el);
    clear(el);
    paint(el, cache);
}

function paint(el, d) {
    const me = d.me || null;
    const meId = me ? me.userId : who();
    const loggedIn = !!store.get('user');
    const B = BOARDS[board];
    const tabs = h('div', { class: 'lb-tabs', role: 'tablist' }, ...Object.keys(BOARDS).map(k =>
        h('button', {
            type: 'button', class: 'lb-tab' + (k === board ? ' on' : ''), role: 'tab', 'aria-selected': k === board ? 'true' : 'false',
            text: BOARDS[k].tab,
            onclick: () => { if (k === board) return; board = k; cache = null; render(paneEl); },
        })));
    const head = h('div', { class: 'lb-top' },
        h('div', { class: 'lb-title' }, h('span', { text: 'Best miners' }), h('span', { class: 'lb-sub', text: B.sub })),
        d.updatedAt ? h('span', { class: 'lb-upd', text: 'updated ' + fmtAgo(d.updatedAt) }) : null);
    const table = h('div', { class: 'lb-table', role: 'table', 'aria-label': 'Top 100 players' },
        h('div', { class: 'lb-row lb-head', role: 'row' },
            h('span', { class: 'lb-place', role: 'columnheader', text: '#' }),
            h('span', { class: 'lb-player', role: 'columnheader', text: 'Player' }),
            h('span', { class: 'lb-rank', role: 'columnheader', text: 'Rank' }),
            h('span', { class: 'lb-rp', role: 'columnheader', text: B.col })));
    if (!d.rows.length) {
        el.append(tabs, head, h('div', { class: 'fr-empty' },
            h('div', { class: 'fr-empty-h', text: B.empty[0] }),
            h('div', { class: 'fr-empty-p', text: B.empty[1] })));
        return;
    }
    const body = h('div', { class: 'lb-body', role: 'rowgroup' });
    let inList = false;
    for (const r of d.rows) {
        const mine = !!meId && r.userId === meId;
        if (mine) inList = true;
        body.appendChild(row(r, mine, loggedIn));
    }
    table.appendChild(body);
    el.append(tabs, head, table);
    if (me && !inList) {
        el.appendChild(h('div', { class: 'lb-pin' }, row(me, true, loggedIn)));
    } else if (!loggedIn) {
        el.appendChild(h('div', { class: 'lb-guest' },
            h('span', { text: board === 'ranked' ? 'Want your name here? Get an account and play ranked.' : 'Want your name here? Get an account and it counts.' }),
            h('button', { type: 'button', class: 'dw-btn sm accent-fill', text: 'Log in', onclick: () => hooks.onLogin() })));
    } else if (!me && d.hidden) {
        el.appendChild(h('div', { class: 'lb-guest', text: 'Your account is kept off the leaderboards.' }));
    } else if (!me) {
        el.appendChild(h('div', { class: 'lb-guest', text: board === 'ranked' ? 'Play your 3 placement games to show up here.' : board === 'banked' ? 'Bank some gems to show up here.' : 'Win a raid to show up here.' }));
    }
    animate(table, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
}

function row(r, mine, clickable) {
    const unranked = r.division == null;
    const v = unranked ? { div: null, text: 'Unranked', legendNo: 0 } : rankOf({ division: r.division, name: r.name, tier: r.tier, legendNo: r.legendNo });
    const medal = r.place === 1 ? ' gold' : r.place === 2 ? ' silver' : r.place === 3 ? ' bronze' : '';
    const color = unranked ? null : tierColor(r);
    const kids = [
        h('span', { class: 'lb-place', role: 'cell' }, h('span', { class: 'lb-pl' + medal, text: String(r.place) })),
        h('span', { class: 'lb-player', role: 'cell' },
            unranked ? h('span', { class: 'lb-badge pp-nobadge', style: { width: '28px', height: '28px' } }) : badge(v.div, 28, 'lb-badge', { legendNo: v.legendNo }),
            nameEl(r.username, r.nameStyleNid, r.nameColor, 14, 'lb-name'),
            mine ? h('span', { class: 'lb-you', text: 'You' }) : null),
        h('span', { class: 'lb-rank', role: 'cell', style: color ? { '--tc': color } : null, text: v.text }),
        h('span', { class: 'lb-rp', role: 'cell', text: fmtNum(BOARDS[board].val(r) | 0) }),
    ];
    const cls = 'lb-row' + (mine ? ' me' : '') + (r.place <= 3 ? ' top' + medal : '');
    if (!clickable) return h('div', { class: cls, role: 'row' }, kids);
    return h('button', { type: 'button', class: cls + ' click', role: 'row', title: r.username + '’s profile', onclick: () => hooks.openProfile(r) }, kids);
}
