// The Leaderboard pane: the Top 100 by RP. Places 1-3 wear gold, silver and
// bronze; Legends show their Legend #N; your own row is marked, and pinned
// to the bottom when you're outside the list. Guests can look too.
import * as api from './api.js';
import * as store from './state.js';
import { h, clear, humanError, animate, T_MID } from './ui.js';
import { rankOf, badge, nameEl, tierColor, fmtNum, fmtAgo } from './people.js';
import * as pv from './previews.js';

let hooks = { openProfile() {}, onLogin() {} };
export function init(hs) { Object.assign(hooks, hs); }

let paneEl = null, loadSeq = 0, cache = null, cachedAt = 0;

export function render(el) {
    paneEl = el;
    pv.stopUnder(el);
    clear(el);
    if (cache && Date.now() - cachedAt < 60000 && cache._for === who()) paint(el, cache);
    else el.appendChild(h('div', { class: 'shop-loading', text: 'Loading the leaderboard…' }));
    load(el);
}
export function onClose() { if (paneEl) pv.stopUnder(paneEl); }
const who = () => { const u = store.get('user'); return u ? u.userId : ''; };

async function load(el) {
    const seq = ++loadSeq;
    const r = await api.leaderboard(100);
    if (seq !== loadSeq || el !== paneEl) return;
    if (!r.ok || !r.data || !Array.isArray(r.data.rows)) {
        if (cache) return;
        clear(el);
        el.appendChild(h('div', { class: 'shop-empty' },
            h('div', { class: 'shop-empty-h', text: 'The leaderboard didn’t load' }),
            h('div', { class: 'shop-empty-p', text: humanError(r) }),
            h('button', { type: 'button', class: 'dw-btn sm', text: 'Try again', onclick: () => render(el) })));
        return;
    }
    const sig = JSON.stringify([r.data.updatedAt, r.data.rows.length, r.data.me && r.data.me.rp]);
    const same = cache && cache._sig === sig && el.querySelector('.lb-table');
    cache = r.data;
    cache._sig = sig;
    cache._for = who();
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
    const head = h('div', { class: 'lb-top' },
        h('div', { class: 'lb-title' }, h('span', { text: 'Top 100' }), h('span', { class: 'lb-sub', text: 'by rank points' })),
        d.updatedAt ? h('span', { class: 'lb-upd', text: 'Updated ' + fmtAgo(d.updatedAt) }) : null);
    const table = h('div', { class: 'lb-table', role: 'table', 'aria-label': 'Top 100 players' },
        h('div', { class: 'lb-row lb-head', role: 'row' },
            h('span', { class: 'lb-place', role: 'columnheader', text: '#' }),
            h('span', { class: 'lb-player', role: 'columnheader', text: 'Player' }),
            h('span', { class: 'lb-rank', role: 'columnheader', text: 'Rank' }),
            h('span', { class: 'lb-rp', role: 'columnheader', text: 'RP' })));
    if (!d.rows.length) {
        el.append(head, h('div', { class: 'fr-empty' },
            h('div', { class: 'fr-empty-h', text: 'Nobody’s ranked yet' }),
            h('div', { class: 'fr-empty-p', text: 'Finish your 3 placement lives to be the first on the board.' })));
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
    el.append(head, table);
    if (me && !inList) {
        el.appendChild(h('div', { class: 'lb-pin' }, row(me, true, loggedIn)));
    } else if (!loggedIn) {
        el.appendChild(h('div', { class: 'lb-guest' },
            h('span', { text: 'Want your name up here? Make a free account to get ranked.' }),
            h('button', { type: 'button', class: 'dw-btn sm accent-fill', text: 'Log in', onclick: () => hooks.onLogin() })));
    } else if (!me) {
        el.appendChild(h('div', { class: 'lb-guest', text: 'Finish your 3 placement lives to get on the board.' }));
    }
    animate(table, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
}

function row(r, mine, clickable) {
    const v = rankOf({ division: r.division, name: r.name, tier: r.tier, legendNo: r.legendNo });
    const medal = r.place === 1 ? ' gold' : r.place === 2 ? ' silver' : r.place === 3 ? ' bronze' : '';
    const color = tierColor(r);
    const kids = [
        h('span', { class: 'lb-place', role: 'cell' }, h('span', { class: 'lb-pl' + medal, text: String(r.place) })),
        h('span', { class: 'lb-player', role: 'cell' },
            badge(v.div, 26, 'lb-badge', { legendNo: v.legendNo }),
            nameEl(r.username, r.nameStyleNid, r.nameColor, 14, 'lb-name'),
            mine ? h('span', { class: 'lb-you', text: 'You' }) : null),
        h('span', { class: 'lb-rank', role: 'cell', style: color ? { '--tc': color } : null, text: v.text }),
        h('span', { class: 'lb-rp', role: 'cell', text: fmtNum(r.rp) }),
    ];
    const cls = 'lb-row' + (mine ? ' me' : '') + (r.place <= 3 ? ' top' + medal : '');
    if (!clickable) return h('div', { class: cls, role: 'row' }, kids);
    return h('button', { type: 'button', class: cls + ' click', role: 'row', title: 'View ' + r.username + '’s profile', onclick: () => hooks.openProfile(r) }, kids);
}
