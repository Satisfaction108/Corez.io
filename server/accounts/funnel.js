// The visit funnel: how far each page visit gets, from the page loading to a
// minute in a raid. client/funnel.js sends one small POST per step to
// /api/funnel (routes/funnel.js); this keeps one row per visit
// (funnel_visits, migration v14) and sums it up for the Discord /stats card.
//
// A step is written once (the first value wins, so a replayed request can't
// rewrite history), except left_ms, which keeps the longest. A visit only
// takes steps for 6 hours, and only from the browser that started it.
// Everything is best effort: a failed write never reaches the player.
'use strict';

const db = require('./db');
const guests = require('./guests');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const VISIT_TTL_MS = 6 * HOUR;
const KEEP_MS = 90 * DAY;
// a visit younger than this may still be going, so the stats leave it out
const SETTLE_MS = 15 * 60 * 1000;
const MAX_MS = VISIT_TTL_MS;

const VISIT_RE = /^[a-f0-9]{32}$/;
// event -> column (min1 is a flag)
const COLUMN = { load: 'load_ms', home: 'home_ms', ready: 'ready_ms', play: 'play_ms', control: 'control_ms', min1: 'min1', leave: 'left_ms' };
const EVENTS = Object.keys(COLUMN);

// A request body -> a clean event, or null. Body: {v, e, t, g?, d, s?, f?, a?}
function clean(b) {
    if (!b || typeof b !== 'object') return null;
    const visit = typeof b.v === 'string' && VISIT_RE.test(b.v) ? b.v : null;
    const event = typeof b.e === 'string' && Object.prototype.hasOwnProperty.call(COLUMN, b.e) ? b.e : null;
    const t = Number(b.t);
    if (!visit || !event || !Number.isFinite(t) || t < 0 || t > MAX_MS) return null;
    return {
        visit, event, ms: Math.round(t),
        guestId: guests.valid(b.g) ? b.g : null,
        device: b.d === 'mobile' ? 'mobile' : 'desktop',
        source: guests.cleanSource(b.s),
        first: b.f === 1 || b.f === true ? 1 : 0,
        auto: b.a === 1 || b.a === true ? 1 : 0,
    };
}

// -> 'ok' | 'stale' | 'mismatch' | 'off'
function record(ev, userId = null, now = Date.now()) {
    const d = db.handle();
    if (!d || !ev) return 'off';
    let out = 'ok';
    try {
        d.tx(() => {
            const row = d.get('SELECT guest_id, created_at FROM funnel_visits WHERE visit_id = ?', ev.visit);
            if (row) {
                if (row.created_at < now - VISIT_TTL_MS) { out = 'stale'; return; }
                if (row.guest_id && ev.guestId && row.guest_id !== ev.guestId) { out = 'mismatch'; return; }
            } else {
                d.run(`INSERT INTO funnel_visits (visit_id, guest_id, user_id, device, source, first_visit, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ev.visit, ev.guestId, userId, ev.device, ev.source, ev.first, now, now);
            }
            const col = COLUMN[ev.event];
            if (ev.event === 'min1') {
                d.run('UPDATE funnel_visits SET min1 = 1, updated_at = ? WHERE visit_id = ?', now, ev.visit);
            } else if (ev.event === 'leave') {
                d.run('UPDATE funnel_visits SET left_ms = max(COALESCE(left_ms, 0), ?), updated_at = ? WHERE visit_id = ?', ev.ms, now, ev.visit);
            } else {
                d.run(`UPDATE funnel_visits SET ${col} = COALESCE(${col}, ?), updated_at = ? WHERE visit_id = ?`, ev.ms, now, ev.visit);
            }
            if (ev.event === 'play' && ev.auto) d.run('UPDATE funnel_visits SET auto_start = 1 WHERE visit_id = ?', ev.visit);
            if (userId) d.run('UPDATE funnel_visits SET user_id = COALESCE(user_id, ?) WHERE visit_id = ?', userId, ev.visit);
            if (ev.guestId) d.run('UPDATE funnel_visits SET guest_id = COALESCE(guest_id, ?) WHERE visit_id = ?', ev.guestId, ev.visit);
        });
    } catch (e) {
        console.error('[accounts] funnel: ' + ((e && e.message) || e));
        return 'off';
    }
    return out;
}

function sweep(now = Date.now()) {
    const d = db.handle();
    if (!d) return 0;
    return d.run('DELETE FROM funnel_visits WHERE created_at <= ?', now - KEEP_MS).changes;
}

/* ── the numbers ─────────────────────────────────────────────────────── */
function median(list) {
    const xs = list.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!xs.length) return null;
    const m = xs.length >> 1;
    return xs.length % 2 ? xs[m] : Math.round((xs[m - 1] + xs[m]) / 2);
}

// rows -> {visits, home, play, control, min1, bounce, homeToPlay, min1Pct, bouncePct, medReady, medControl, medHome}
//   home→play  of the visits that showed the menu, how many pressed Play
//   1+ min     of all visits, how many had a minute in control
//   bounce     of all visits, how many never pressed Play
//   medians    Play ready / in control, ms from navigation start
function summarize(rows) {
    const n = rows.length;
    const home = rows.filter(r => r.home_ms != null).length;
    const play = rows.filter(r => r.play_ms != null).length;
    const playFromHome = rows.filter(r => r.play_ms != null && r.home_ms != null).length;
    const control = rows.filter(r => r.control_ms != null).length;
    const min1 = rows.filter(r => r.min1 === 1).length;
    const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : null);
    return {
        visits: n, home, play, control, min1, bounce: n - play,
        homeToPlay: pct(playFromHome, home),
        min1Pct: pct(min1, n),
        bouncePct: pct(n - play, n),
        medHome: median(rows.map(r => r.home_ms)),
        medReady: median(rows.map(r => r.ready_ms)),
        medControl: median(rows.map(r => r.control_ms)),
    };
}

// Visits created in [since, until): all, by device, the top sources.
function stats(since, until, opts = {}) {
    const d = db.handle();
    if (!d) return null;
    const rows = d.all(`SELECT device, source, first_visit, auto_start, home_ms, ready_ms, play_ms, control_ms, min1
        FROM funnel_visits WHERE created_at >= ? AND created_at < ?`, since, until);
    const by = (key) => {
        const m = new Map();
        for (const r of rows) {
            const k = key(r);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(r);
        }
        return m;
    };
    const devices = by(r => r.device);
    // portal frames ("embed:crazygames.com") are one source with their site
    const sources = [...by(r => r.source || 'unknown')].sort((a, b) => b[1].length - a[1].length).slice(0, opts.topSources || 3);
    return {
        all: summarize(rows),
        firstVisits: summarize(rows.filter(r => r.first_visit === 1)),
        desktop: summarize(devices.get('desktop') || []),
        mobile: summarize(devices.get('mobile') || []),
        sources: sources.map(([name, rs]) => ({ name, ...summarize(rs) })),
    };
}

function secs(ms) {
    if (ms == null) return '-';
    return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
}
function p(v) { return v == null ? '-' : v + '%'; }
function line(label, s) {
    if (!s || !s.visits) return `${label}: no visits`;
    return `${label} ${s.visits.toLocaleString('en-US')}: ${p(s.homeToPlay)} home→play · ${p(s.min1Pct)} 1+ min · ${p(s.bouncePct)} bounce · ` +
        `ready ${secs(s.medReady)} · control ${secs(s.medControl)}`;
}
function sourceName(name) {
    return name.startsWith('embed:') ? name.slice(6) + ' (embed)' : name;
}

// The /stats field (Discord caps a field at 1024 characters).
function text(st) {
    if (!st || !st.all.visits) return 'No visits measured yet.';
    const out = [
        line('**All**', st.all),
        line('First visits', st.firstVisits),
        line('Desktop', st.desktop),
        line('Mobile', st.mobile),
        ...st.sources.map(s => line(sourceName(s.name), s)),
        'medians from page open · bounce = never pressed Play · goals: 80% 1+ min, ready under 10 s',
    ];
    let s = out.join('\n');
    if (s.length > 1024) s = s.slice(0, 1021) + '...';
    return s;
}

// The last 7 days, without the last 15 minutes (those visits may still be going).
function weekText(now = Date.now()) {
    try { return text(stats(now - 7 * DAY, now - SETTLE_MS)); } catch (e) { return 'Funnel unavailable: ' + ((e && e.message) || e); }
}

module.exports = { EVENTS, COLUMN, VISIT_TTL_MS, KEEP_MS, SETTLE_MS, clean, record, sweep, median, summarize, stats, text, weekText };
