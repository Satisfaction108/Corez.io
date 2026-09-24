// The Profile pane: yours from the nav, anyone's from a friend or
// leaderboard row. A big badge with the rank bar and peak, their tank in
// the skin they wear, the seven tier emblems, 12 achievements and six stats,
// plus Add friend / Remove / Block depending on how you know them.
import * as api from './api.js';
import * as store from './state.js';
import * as social from './social.js';
import { h, clear, toast, setBusy, humanError, animate, fmtDate, T_MID } from './ui.js';
import { rankOf, badge, nameEl, tierColor, presenceText, presenceState, fmtNum } from './people.js';
import { ACHIEVEMENTS, achIcon } from './achievements.js';
import * as pv from './previews.js';
import * as cos from './cosmetics.js';
import { removeFriend, blockUser } from './friendsPane.js';

let hooks = { openPane() {}, setTitle() {} };
export function init(hs) { Object.assign(hooks, hs); }

let paneEl = null, loadSeq = 0, lastOpts = {};
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'emerald', 'legend'];
const TIER_NAME = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', emerald: 'Emerald', legend: 'Legend' };
const BACK = { friends: 'Friends', leaderboard: 'Leaderboard' };

const myName = () => { const u = store.get('user'); return u ? u.username : ''; };

export function render(el, opts) {
    paneEl = el;
    lastOpts = opts && (opts.u || opts.from) ? opts : (opts && opts.keep ? lastOpts : {});
    pv.stopUnder(el);
    clear(el);
    el.appendChild(h('div', { class: 'shop-loading', text: 'Loading profile…' }));
    load(el, lastOpts);
}
export function onClose() { if (paneEl) pv.stopUnder(paneEl); }

async function load(el, opts) {
    const seq = ++loadSeq;
    const who = opts.u || myName();
    hooks.setTitle(!opts.u || who === myName() ? 'Your profile' : 'Profile');
    const r = await api.profile(who);
    if (seq !== loadSeq || el !== paneEl) return;
    pv.stopUnder(el);
    clear(el);
    if (!r.ok || !r.data || !r.data.username) {
        el.appendChild(backLink(opts));
        el.appendChild(h('div', { class: 'shop-empty' },
            h('div', { class: 'shop-empty-h', text: r.status === 404 ? 'Player not found' : 'The profile didn’t load' }),
            h('div', { class: 'shop-empty-p', text: r.status === 404 ? 'They may have changed their name.' : humanError(r) }),
            r.status === 404 ? null : h('button', { type: 'button', class: 'dw-btn sm', text: 'Try again', onclick: () => render(el, opts) })));
        return;
    }
    const p = r.data;
    hooks.setTitle(p.relation === 'self' ? 'Your profile' : p.username);
    paint(el, p, opts);
}

function backLink(opts) {
    const to = opts && BACK[opts.from];
    if (!to) return null;
    return h('button', { type: 'button', class: 'wl-back pf-back', onclick: () => hooks.openPane(opts.from) },
        h('svg', { class: 'dw-ic', 'aria-hidden': 'true' }, h('use', { href: '#i-back' })), to);
}

function paint(el, p, opts) {
    const v = rankOf(p.rank);
    const R = window.DWRanks;
    const rk = p.rank || {};
    const color = tierColor(rk);
    // the bar under the rank
    let barPct = 0, barText = '';
    if (rk.division == null) {
        const pl = rk.placement || { lives: 0, of: 3 };
        const left = Math.max(0, (pl.of || 3) - (pl.lives | 0));
        barPct = (pl.lives | 0) / (pl.of || 3);
        barText = left > 0 ? left + ' placement ' + (left === 1 ? 'life' : 'lives') + ' to go' : 'Rank coming up';
    } else if ((rk.division | 0) >= 18) {
        barPct = 1;
        barText = fmtNum(rk.rp) + ' RP';
    } else {
        barPct = Math.max(0, Math.min(1, +rk.pct || (rk.size ? rk.into / rk.size : 0)));
        const next = R && R.DIVISIONS[(rk.division | 0) + 1];
        barText = fmtNum(rk.into) + ' / ' + fmtNum(rk.size) + ' RP' + (next ? ' · next ' + next.name : '');
    }
    const fill = h('span', { class: 'pf-fill' });
    const meta = [];
    if (p.peak && p.peak.division != null) meta.push('Peak ' + (p.peak.name || (R ? R.nameOf(p.peak.division) : '')));
    if (p.relation === 'friend' && p.friendsSince) meta.push('Friends since ' + fmtDate(p.friendsSince));
    else meta.push('Joined ' + fmtDate(p.createdAt));
    const pres = p.presence && p.relation === 'friend' ? h('div', { class: 'pf-pres st-' + presenceState(p.presence) }, h('span', { class: 'fr-dot ' + presenceState(p.presence) }), h('span', { text: presenceText(p.presence, p.rank) })) : null;
    const skin = p.skinNid ? cos.skinOf(p.skinNid) : null;
    const tank = h('div', { class: 'pf-tank', title: skin ? skin.name : 'No skin' },
        pv.tankPreview({ w: 150, h: 128, skin: skin || 0, size: 34, cls: 'dw-prev pf-tankcv' }),
        h('span', { class: 'pf-tank-l', text: skin ? skin.name : 'Plain hull' }));

    const top = h('div', { class: 'pf-top' },
        h('div', { class: 'pf-badge' }, badge(v.div, 112, 'pf-badge-img', { legendNo: v.legendNo })),
        h('div', { class: 'pf-id' },
            h('div', { class: 'pf-name' }, nameEl(p.username, p.nameStyleNid, p.nameColor, 24)),
            h('div', { class: 'pf-rank', style: color ? { '--tc': color } : null, text: v.text }),
            h('div', { class: 'pf-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(barPct * 100)), 'aria-label': barText }, fill),
            h('div', { class: 'pf-bartext', text: barText }),
            h('div', { class: 'pf-meta', text: meta.join(' · ') }),
            pres),
        tank);
    if (color) fill.style.setProperty('--tc', color);

    el.append(backLink(opts) || '', top, actions(p), tiers(p), achievements(p), stats(p));
    // the bar eases up to its value
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (barPct * 100).toFixed(1) + '%'; }));
    animate(top, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: T_MID });
}

function actions(p) {
    const row = h('div', { class: 'pf-acts' });
    const reload = () => render(paneEl, Object.assign({}, lastOpts, { keep: true }));
    const btn = (label, cls, fn) => h('button', { type: 'button', class: 'dw-btn sm' + (cls ? ' ' + cls : ''), text: label, onclick: async (e) => {
        const b = e.currentTarget; setBusy(b, true);
        let ok = false;
        try { ok = await fn(); } finally { if (b.isConnected) setBusy(b, false); }
        if (ok) reload();
    } });
    const person = { userId: p.userId, username: p.username, rank: p.rank };
    switch (p.relation) {
        case 'self':
            row.append(
                h('button', { type: 'button', class: 'dw-btn sm', text: 'Change look', onclick: () => hooks.openPane('locker') }),
                h('button', { type: 'button', class: 'dw-btn sm', text: 'Account', onclick: () => hooks.openPane('account') }));
            break;
        case 'friend':
            row.append(btn('Remove friend', '', () => removeFriend(person)), btn('Block', 'danger-outline', () => blockUser(person)));
            break;
        case 'incoming':
            row.append(
                h('span', { class: 'pf-note', text: p.username + ' wants to be friends.' }),
                btn('Accept', 'primary', () => social.acceptRequest(person)),
                btn('Decline', '', async () => {
                    const r = await api.friendRespond(p.userId, false);
                    if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return false; }
                    social.apply('declined', person);
                    return true;
                }));
            break;
        case 'outgoing':
            row.append(
                h('span', { class: 'pf-note', text: 'Friend request sent.' }),
                btn('Cancel request', '', async () => {
                    const r = await api.friendCancel(p.userId);
                    if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return false; }
                    social.apply('canceled', person);
                    return true;
                }));
            break;
        default:
            row.append(
                btn('Add friend', 'primary', async () => {
                    const r = await api.friendRequest(p.username);
                    if (!r.ok) { toast(social.friendError(r), { kind: 'error' }); return false; }
                    if (r.data && r.data.status === 'accepted') {
                        social.apply('friend', r.data.friend || Object.assign({ since: Date.now(), presence: null }, person));
                        toast('You and ' + p.username + ' are now friends.', { kind: 'ok' });
                    } else {
                        social.apply('outgoing', Object.assign({ at: Date.now() }, person));
                        toast('Request sent to ' + p.username + '.', { kind: 'ok' });
                    }
                    return true;
                }),
                btn('Block', 'danger-outline', () => blockUser(person)));
    }
    return row;
}

function section(title, right, body) {
    return h('div', { class: 'pf-sec' },
        h('div', { class: 'pf-h' }, h('span', { text: title }), right ? h('span', { class: 'pf-h-r', text: right }) : null),
        body);
}

function tiers(p) {
    const have = new Set(Array.isArray(p.tiers) ? p.tiers : []);
    const row = h('div', { class: 'pf-tiers' });
    TIERS.forEach((t, i) => {
        const on = have.has(t);
        const div = i === 6 ? 18 : i * 3;
        row.appendChild(h('div', { class: 'pf-tier' + (on ? ' on' : ''), title: on ? TIER_NAME[t] + ' reached' : TIER_NAME[t] + ' not reached yet' },
            badge(div, 48, 'pf-tier-img'),
            h('span', { class: 'pf-tier-l', text: TIER_NAME[t] })));
    });
    return section('Tiers', have.size + ' of 7', row);
}

function achievements(p) {
    const got = new Map((Array.isArray(p.achievements) ? p.achievements : []).map((a) => [a.id, a.unlockedAt]));
    const grid = h('div', { class: 'pf-achs' });
    for (const a of ACHIEVEMENTS) {
        const at = got.get(a.id);
        const on = at != null;
        grid.appendChild(h('div', {
            class: 'pf-ach' + (on ? ' on' : ''), style: { '--ac': a.color },
            title: on ? a.name + ': unlocked ' + fmtDate(at) : a.name + ': ' + a.desc,
        },
            h('span', { class: 'pf-ach-ic' }, achIcon(a.id)),
            h('span', { class: 'pf-ach-txt' },
                h('span', { class: 'pf-ach-n', text: a.name }),
                h('span', { class: 'pf-ach-d', text: on ? 'Unlocked ' + fmtDate(at) : a.desc }))));
    }
    return section('Achievements', got.size + ' of ' + ACHIEVEMENTS.length, grid);
}

function stats(p) {
    const s = p.stats || {};
    const tiles = [
        ['Lives played', fmtNum(s.lives)],
        ['Knockouts', fmtNum(s.kills)],
        ['Raid wins', fmtNum(s.raidWins)],
        ['Top 3 finishes', fmtNum(s.top3)],
        ['Gems banked', fmtNum(s.gemsBanked)],
        ['Best life', fmtNum(s.bestLife) + ' pts'],
    ];
    return section('Stats', null, h('div', { class: 'pf-stats' },
        tiles.map(([k, val]) => h('div', { class: 'pf-stat' }, h('span', { class: 'pf-stat-v', text: val }), h('span', { class: 'pf-stat-k', text: k })))));
}
