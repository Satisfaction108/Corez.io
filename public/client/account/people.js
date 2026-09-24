// Small pieces shared by the Friends, Profile and Leaderboard panes: a
// player's name (in their name style when we know it), rank badges, the
// presence line and "3h ago" times.
import { h } from './ui.js';
import { badgeDataUrl, TIER_COLORS } from './rankBadges.js';
import * as pv from './previews.js';
import * as cos from './cosmetics.js';

// RankLite {division|null, name, tier|null} or a RankSnap -> what we show.
export function rankOf(rank) {
    if (!rank || rank.division == null) {
        const pl = rank && rank.placement;
        const lives = (pl && pl.lives) | 0;
        return { div: 'placement', text: pl && !pl.done && lives > 0 ? 'Placement ' + Math.min(3, lives) + '/' + (pl.of || 3) : (rank && rank.name && rank.name !== 'Unranked' ? rank.name : 'Unranked'), legendNo: 0 };
    }
    const div = rank.division | 0;
    const legendNo = rank.legendNo | 0;
    const R = window.DWRanks;
    const name = rank.name || (R ? R.nameOf(div) : 'Ranked');
    return { div, text: div === 18 && legendNo > 0 ? 'Legend #' + legendNo : name, legendNo };
}

export function badge(div, px, cls, opts) {
    let src = '';
    try { src = badgeDataUrl(div, px, opts); } catch (e) { src = ''; }
    if (!src) return h('span', { class: (cls || '') + ' pp-nobadge', style: { width: px + 'px', height: px + 'px' } });
    return h('img', { class: cls || '', src, alt: '', 'aria-hidden': 'true', width: px, height: px, draggable: 'false' });
}

// The tier's text colour, for rank names on dark panels.
export function tierColor(rank) {
    const t = rank && (rank.tier || (rank.division == null ? 'placement' : null));
    return (t && TIER_COLORS[t] && TIER_COLORS[t].text) || '';
}

// A name, drawn in its name style when one is known, else plain text.
export function nameEl(name, nameStyleNid, nameColor, px, cls) {
    const st = nameStyleNid ? cos.nameStyleOf(nameStyleNid) : null;
    const useStyle = st && !(st.id === cos.CUSTOM_ID && !nameColor);
    if (!useStyle) return h('span', { class: 'pp-name' + (cls ? ' ' + cls : ''), text: name, title: name });
    const cv = pv.nameCanvas(name, st, { px: px || 14, stroke: true, custom: nameColor || null, cls: 'dw-name-cv pp-name-cv' + (cls ? ' ' + cls : ''), maxW: 220 });
    cv.title = name;
    return cv;
}

export function fmtAgo(ms) {
    const s = Math.max(0, (Date.now() - (+ms || 0)) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h ago';
    const d = Math.floor(hr / 24);
    if (d < 30) return d + 'd ago';
    const mo = Math.floor(d / 30);
    return mo < 12 ? mo + 'mo ago' : Math.floor(mo / 12) + 'y ago';
}

export const fmtNum = (n) => (Math.round(+n || 0)).toLocaleString();

// "In menu" / "In raid · Gold II · 1,240 pts" / "Offline · 3h ago"
export function presenceText(p, rank) {
    const st = (p && p.state) || 'offline';
    if (st === 'raid') {
        const bits = ['In a raid'];
        const r = rank && rank.division != null ? rankOf(rank).text : '';
        if (r) bits.push(r);
        if (p.score != null && p.alive !== false) bits.push(fmtNum(p.score) + ' pts');
        else if (p.alive === false) bits.push('respawning');
        return bits.join(' · ');
    }
    if (st === 'menu') return 'In the lobby';
    return p && p.lastSeen ? 'Offline · ' + fmtAgo(p.lastSeen) : 'Offline';
}
export const presenceState = (p) => (p && (p.state === 'raid' || p.state === 'menu') ? p.state : 'offline');
const ORDER = { raid: 0, menu: 1, offline: 2 };
export function byPresence(a, b) {
    const sa = presenceState(a.presence), sb = presenceState(b.presence);
    if (sa !== sb) return ORDER[sa] - ORDER[sb];
    if (sa === 'offline') {
        const la = (a.presence && a.presence.lastSeen) || 0, lb = (b.presence && b.presence.lastSeen) || 0;
        if (la !== lb) return lb - la;
    }
    return String(a.username).localeCompare(String(b.username), undefined, { sensitivity: 'base' });
}
