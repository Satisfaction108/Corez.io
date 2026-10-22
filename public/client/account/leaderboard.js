// The Leaderboard pane: four boards, Ranked (Top 100 by RP), Banked (most
// gems banked, all time), Wins (raid wins) and Tanks (best run per tank).
// Places 1-3 wear gold, silver and bronze; Legend and up show their Legend #N;
// your own row is marked, and pinned to the bottom when you're outside the list.
import * as api from './api.js';
import * as store from './state.js';
import { h, clear, humanError, animate, T_MID } from './ui.js';
import { rankOf, badge, nameEl, tierColor, fmtNum, fmtAgo } from './people.js';
import * as pv from './previews.js';

let hooks = { openProfile() {}, onLogin() {} };
export function init(hs) { Object.assign(hooks, hs); }

const BOARDS = {
    ranked: { tab: 'Ranked', sub: 'by RP', col: 'RP', val: (r) => r.rp, empty: ['Nobody’s ranked yet', 'Play 3 placement games to get on the board.'] },
    banked: { tab: 'Banked', sub: 'by gems banked', col: 'Banked', val: (r) => r.value, empty: ['Nothing banked yet', 'Bank some gems to take the top spot.'] },
    wins: { tab: 'Wins', sub: 'by raid wins', col: 'Wins', val: (r) => r.value, empty: ['No winners yet', 'Win a raid to take the top spot.'] },
    tanks: { tab: 'Tanks', sub: 'best run per tank', col: 'Score', val: (r) => r.score, empty: ['No tank records yet', 'Play a run to set the first record on a tank.'] },
};
function valCell(v) {
    const text = v >= 10e6 ? (v / 1e6).toFixed(v >= 100e6 ? 0 : 1) + 'M' : fmtNum(v);
    return h('span', { class: 'lb-rp' + (text.length >= 9 ? ' long' : ''), role: 'cell', text, title: fmtNum(v) });
}
function fmtDuration(ms) {
    const totalSec = Math.max(0, Math.round((+ms || 0) / 1000));
    if (totalSec <= 0) return '—';
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0) return hrs + 'h ' + mins + 'm';
    if (mins > 0) return mins + 'm ' + String(secs).padStart(2, '0') + 's';
    return secs + 's';
}
let board = 'ranked';
let tankQuery = '';
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

function localTankFallbackRows() {
    const out = [];
    const seen = new Set();
    try {
        const m = window.mockups;
        if (Array.isArray(m) && m.length) {
            const basic = m.find(x => x && x.className === 'basic') || m[0];
            if (basic) {
                const tiers = new Map([[basic.index, 1]]);
                const q = [basic.index];
                while (q.length) {
                    const idx = q.shift(), mk = m[idx];
                    const t0 = tiers.get(idx) || 1;
                    if (!mk || !Array.isArray(mk.upgrades)) continue;
                    for (const u of mk.upgrades) {
                        if (!u || u.index == null || tiers.has(u.index)) continue;
                        tiers.set(u.index, (u.tier | 0) + 1 || (t0 + 1));
                        q.push(u.index);
                    }
                }
                for (const [idx, tier] of tiers) {
                    const mk = m[idx];
                    if (!mk) continue;
                    const name = String(mk.upgradeName || mk.name || '').trim();
                    if (!name || name === '?' || seen.has(name)) continue;
                    seen.add(name);
                    out.push({ place: out.length + 1, tank: name, tankTier: tier, hasRecord: false, score: 0, playMs: 0 });
                }
            }
        }
    } catch {}
    if (!out.length) {
        const pool = (window.tankRecords && typeof window.tankRecords.dailyFeaturedFor === 'function')
            ? ['Basic', 'Twin', 'Sniper', 'Machine Gun', 'Flank Guard', 'Director', 'Pounder', 'Trapper', 'Splitter',
               'Triple Shot', 'Quad Tank', 'Twin Flank', 'Assassin', 'Hunter', 'Minigun', 'Destroyer', 'Builder', 'Overseer', 'Cruiser', 'Smasher',
               'Triplet', 'Penta Shot', 'Spreadshot', 'Ranger', 'Stalker', 'Predator', 'Streamliner', 'Annihilator', 'Hybrid', 'Skimmer',
               'Overlord', 'Manager', 'Factory', 'Battleship', 'Fighter', 'Booster', 'Bomber', 'Auto-Gunner', 'Nailgun', 'Sprayer', 'Gunner Trapper']
            : ['Basic'];
        for (const t of pool) {
            if (seen.has(t)) continue;
            seen.add(t);
            out.push({ place: out.length + 1, tank: t, tankTier: 1, hasRecord: false, score: 0, playMs: 0 });
        }
    }
    return out;
}

function mergeLocalTankRecords(rows) {
    const u = store.get('user');
    const myName = (u && u.username) || (typeof localStorage !== 'undefined' && localStorage.getItem('playerNameInput')) || 'You';
    const myId = u ? u.userId : null;
    const eq = u && u.equipped;
    const C = typeof window !== 'undefined' ? window.DWCosmetics : null;
    const ns = eq && C && typeof C.byId === 'function' ? C.byId(eq.nameStyle) : null;
    let myStyleNid = (ns ? (ns.nid | 0) : 0) || (u && u.nameStyleNid | 0) || 0;
    let myNameColor = (eq && eq.customColor) || (u && u.nameColor) || null;
    if (!myStyleNid && myId && Array.isArray(rows)) {
        const ownRow = rows.find(r => r && r.userId === myId && r.nameStyleNid);
        if (ownRow) {
            myStyleNid = ownRow.nameStyleNid | 0;
            if (!myNameColor && ownRow.nameColor) myNameColor = ownRow.nameColor;
        }
    }
    const byTank = new Map();
    for (const r of rows || []) {
        const copy = Object.assign({}, r);
        if (myId && copy.userId === myId) {
            if (myStyleNid) copy.nameStyleNid = myStyleNid;
            if (myNameColor) copy.nameColor = myNameColor;
            if (u && u.username) copy.username = u.username;
        }
        byTank.set(copy.tank, copy);
    }
    try {
        const local = window.tankRecords && typeof window.tankRecords.allRecords === 'function' ? window.tankRecords.allRecords() : [];
        for (const rec of local) {
            if (!rec || !rec.tank || !(rec.score > 0)) continue;
            const cur = byTank.get(rec.tank);
            if (!cur) {
                byTank.set(rec.tank, {
                    place: byTank.size + 1,
                    tank: rec.tank,
                    tankTier: 4,
                    hasRecord: true,
                    userId: myId,
                    username: myName,
                    score: rec.score | 0,
                    kills: rec.kills | 0,
                    playMs: rec.playMs | 0,
                    nameStyleNid: myStyleNid,
                    nameColor: myNameColor,
                    localMine: true,
                });
            } else if ((rec.score | 0) > (cur.score | 0)) {
                cur.hasRecord = true;
                cur.userId = myId;
                cur.username = myName;
                cur.score = rec.score | 0;
                cur.kills = rec.kills | 0;
                cur.playMs = (rec.playMs | 0) || (cur.playMs | 0);
                cur.nameStyleNid = myStyleNid || cur.nameStyleNid || 0;
                cur.nameColor = myNameColor || cur.nameColor || null;
                cur.localMine = true;
            }
        }
    } catch {}
    return [...byTank.values()];
}

async function load(el) {
    const seq = ++loadSeq;
    const want = board;
    const r = await api.leaderboard(want === 'tanks' ? 500 : 100, want);
    if (want !== board) return;
    if (seq !== loadSeq || el !== paneEl) return;
    if ((!r.ok || !r.data || !Array.isArray(r.data.rows)) && want === 'tanks') {
        const fallback = { type: 'tanks', updatedAt: Date.now(), rows: mergeLocalTankRecords(localTankFallbackRows()), me: null };
        cache = fallback;
        cache._sig = 'tanks-fallback-' + fallback.rows.length;
        cache._for = who();
        cache._board = want;
        cachedAt = Date.now();
        pv.stopUnder(el);
        clear(el);
        paint(el, cache);
        return;
    }
    if (!r.ok || !r.data || !Array.isArray(r.data.rows)) {
        if (cache) return;
        clear(el);
        el.appendChild(h('div', { class: 'shop-empty' },
            h('div', { class: 'shop-empty-h', text: 'The leaderboard didn’t load' }),
            h('div', { class: 'shop-empty-p', text: humanError(r) }),
            h('button', { type: 'button', class: 'dw-btn sm', text: 'Retry', onclick: () => render(el) })));
        return;
    }
    if (want === 'tanks') {
        r.data.rows = mergeLocalTankRecords(r.data.rows.length ? r.data.rows : localTankFallbackRows());
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
        h('div', { class: 'lb-title' }, h('span', { text: board === 'tanks' ? 'Tank Records' : 'Best miners' }), h('span', { class: 'lb-sub', text: B.sub })),
        d.updatedAt ? h('span', { class: 'lb-upd', text: 'Updated ' + fmtAgo(d.updatedAt) }) : null);
    if (board === 'tanks') {
        paintTankBoard(el, d, tabs, head, meId, loggedIn);
        return;
    }
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
            h('span', { text: board === 'ranked' ? 'Get an account and play ranked to show up here.' : 'Get an account to show up here.' }),
            h('button', { type: 'button', class: 'dw-btn sm accent-fill', text: 'Log in', onclick: () => hooks.onLogin() })));
    } else if (!me && d.hidden) {
        el.appendChild(h('div', { class: 'lb-guest', text: 'Your account is kept off the leaderboards.' }));
    } else if (!me) {
        el.appendChild(h('div', { class: 'lb-guest', text: board === 'ranked' ? 'Play your 3 placement games to show up here.' : board === 'banked' ? 'Bank some gems to show up here.' : 'Win a raid to show up here.' }));
    }
    animate(table, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
}

function paintTankBoard(el, d, tabs, head, meId, loggedIn) {
    const searchInput = h('input', {
        type: 'search',
        class: 'lb-tank-search',
        placeholder: 'Search any tank (' + d.rows.length + ' tanks)...',
        value: tankQuery,
        style: {
            width: '100%', boxSizing: 'border-box', marginBottom: '10px', padding: '8px 12px',
            borderRadius: '8px', border: '2px solid var(--line)', background: 'var(--bg)',
            color: 'var(--text)', font: '600 13px 'Noto Color Emoji', var(--ui)', outline: 'none',
        },
    });
    const body = h('div', {
        class: 'lb-body lb-tanks-body',
        role: 'rowgroup',
        style: { maxHeight: '420px', overflowY: 'auto' },
    });
    const renderRows = () => {
        clear(body);
        const q = tankQuery.trim().toLowerCase();
        const filtered = q
            ? d.rows.filter(r => String(r.tank || '').toLowerCase().includes(q) || String(r.username || '').toLowerCase().includes(q))
            : d.rows.slice();
        filtered.sort((a, b) => ((b.score | 0) - (a.score | 0)) || ((a.tankTier | 0) - (b.tankTier | 0)) || String(a.tank || '').localeCompare(String(b.tank || '')));
        if (!filtered.length) {
            body.appendChild(h('div', { class: 'fr-empty', style: { padding: '20px 12px' } },
                h('div', { class: 'fr-empty-h', text: 'No matching tanks' }),
                h('div', { class: 'fr-empty-p', text: 'Try another tank or player name.' })));
            return;
        }
        for (const r of filtered) {
            const mine = (!!meId && r.userId === meId) || !!r.localMine;
            body.appendChild(tankRow(r, mine, loggedIn));
        }
    };
    searchInput.addEventListener('input', () => {
        tankQuery = searchInput.value || '';
        renderRows();
    });
    renderRows();
    const table = h('div', { class: 'lb-table lb-tanks-table', role: 'table', 'aria-label': 'Best score per tank' },
        h('div', { class: 'lb-row lb-head lb-tank-row', role: 'row' },
            h('span', { class: 'lb-place', role: 'columnheader', text: 'Tier' }),
            h('span', { class: 'lb-tank-col', role: 'columnheader', text: 'Tank' }),
            h('span', { class: 'lb-player', role: 'columnheader', text: 'Top Player' }),
            h('span', { class: 'lb-rank', role: 'columnheader', text: 'Time' }),
            h('span', { class: 'lb-rp', role: 'columnheader', text: 'Score' })),
        body);
    el.append(tabs, head, searchInput, table);
    animate(table, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
}

function tankRow(r, mine, clickable) {
    const hasRec = !!(r.hasRecord && (r.score | 0) > 0);
    const tierBadge = h('span', {
        class: 'lb-pl',
        style: { fontSize: '12px', minWidth: '32px' },
        text: 'T' + (r.tankTier || 1),
    });
    const tankCell = h('span', {
        class: 'lb-tank-col',
        role: 'cell',
        style: { fontWeight: '700', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        text: r.tank,
        title: r.tank,
    });
    const playerCell = hasRec
        ? h('span', { class: 'lb-player', role: 'cell' },
            nameEl(r.username || 'Unnamed', r.nameStyleNid, r.nameColor, 14, 'lb-name'),
            mine ? h('span', { class: 'lb-you', text: 'You' }) : null)
        : h('span', { class: 'lb-player', role: 'cell', style: { opacity: '0.5', fontStyle: 'italic' }, text: 'Unclaimed' });
    const timeCell = h('span', {
        class: 'lb-rank',
        role: 'cell',
        style: { fontVariantNumeric: 'tabular-nums', opacity: hasRec ? '0.9' : '0.45' },
        text: hasRec ? fmtDuration(r.playMs) : '—',
    });
    const scoreCell = hasRec
        ? valCell(r.score | 0)
        : h('span', { class: 'lb-rp', role: 'cell', style: { opacity: '0.45' }, text: '—' });
    const kids = [
        h('span', { class: 'lb-place', role: 'cell' }, tierBadge),
        tankCell,
        playerCell,
        timeCell,
        scoreCell,
    ];
    const cls = 'lb-row lb-tank-row' + (mine ? ' me' : '');
    if (!clickable || !hasRec || !r.userId) return h('div', { class: cls, role: 'row' }, kids);
    return h('button', { type: 'button', class: cls + ' click', role: 'row', title: r.username + '’s profile', onclick: () => hooks.openProfile(r) }, kids);
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
        valCell(BOARDS[board].val(r) | 0),
    ];
    const cls = 'lb-row' + (mine ? ' me' : '') + (r.place <= 3 ? ' top' + medal : '');
    if (!clickable) return h('div', { class: cls, role: 'row' }, kids);
    return h('button', { type: 'button', class: cls + ' click', role: 'row', title: r.username + '’s profile', onclick: () => hooks.openProfile(r) }, kids);
}
