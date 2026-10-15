'use strict';

const db = require('./db');

const CHAMP_DUST_MILLI = [15000, 10000, 5000];
const WHO_RE = /^(a:\d{1,12}|g:[a-f0-9]{32})$/;

let readyFor = null;
function h() {
    const d = db.handle();
    if (!d) return null;
    if (readyFor !== d) {
        try { ensure(d); readyFor = d; } catch (e) { console.error('[daily] table setup failed: ' + ((e && e.message) || e)); return null; }
    }
    return d;
}

function ensure(d) {
    d.exec(`CREATE TABLE IF NOT EXISTS ao_daily_scores (
        day        TEXT    NOT NULL,
        who        TEXT    NOT NULL,
        world      TEXT    NOT NULL DEFAULT '',
        name       TEXT,
        score      INTEGER NOT NULL DEFAULT 0,
        play_ms    INTEGER NOT NULL DEFAULT 0,
        data       TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day, who)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ao_daily_scores_rank ON ao_daily_scores(day, score);
    CREATE TABLE IF NOT EXISTS ao_daily_champs (
        day        TEXT    NOT NULL,
        place      INTEGER NOT NULL,
        who        TEXT    NOT NULL,
        name       TEXT,
        score      INTEGER NOT NULL DEFAULT 0,
        dust_milli INTEGER NOT NULL DEFAULT 0,
        paid_at    INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (day, place)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ao_daily_bots (
        day        TEXT    NOT NULL,
        world      TEXT    NOT NULL,
        fam        TEXT    NOT NULL,
        name       TEXT,
        data       TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day, world, fam)
    ) STRICT;`);
}

function available() { return !!h(); }
function validWho(w) { return typeof w === 'string' && WHO_RE.test(w); }

function save(day, world, rows, now = Date.now()) {
    const d = h();
    if (!d || !rows || !rows.length) return 0;
    let n = 0;
    d.tx(() => {
        for (const r of rows) {
            if (!r || !validWho(r.who)) continue;
            d.run(`INSERT INTO ao_daily_scores (day, who, world, name, score, play_ms, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(day, who) DO UPDATE SET world = excluded.world, name = excluded.name, score = excluded.score,
                   play_ms = excluded.play_ms, data = excluded.data, updated_at = excluded.updated_at`,
                String(day), r.who, String(world || ''), String(r.name || 'Unnamed').slice(0, 32), Math.max(0, Math.floor(+r.score || 0)),
                Math.max(0, Math.floor(+r.playMs || 0)), JSON.stringify(r.data || {}), now);
            n++;
        }
    });
    return n;
}

function parse(row) {
    if (!row) return null;
    let data = {};
    try { data = JSON.parse(row.data || '{}') || {}; } catch (e) { data = {}; }
    return { who: row.who, world: row.world, name: row.name || 'Unnamed', score: row.score | 0, playMs: Number(row.play_ms) || 0, data };
}

function loadOne(day, who) {
    const d = h();
    if (!d || !validWho(who)) return null;
    return parse(d.get('SELECT * FROM ao_daily_scores WHERE day = ? AND who = ?', String(day), who));
}

function loadWorld(day, world, limit = 60) {
    const d = h();
    if (!d) return [];
    return d.all('SELECT * FROM ao_daily_scores WHERE day = ? AND world = ? ORDER BY score DESC LIMIT ?', String(day), String(world || ''), Math.max(1, limit | 0)).map(parse);
}

function top(day, n = 10) {
    const d = h();
    if (!d) return [];
    return d.all('SELECT * FROM ao_daily_scores WHERE day = ? AND score > 0 ORDER BY score DESC, updated_at ASC LIMIT ?', String(day), Math.max(1, n | 0)).map(parse);
}

function champs(day) {
    const d = h();
    if (!d) return [];
    return d.all('SELECT * FROM ao_daily_champs WHERE day = ? ORDER BY place', String(day)).map(r => ({
        place: r.place | 0, who: r.who, name: r.name || 'Unnamed', score: r.score | 0, dustMilli: r.dust_milli | 0, paid: r.paid_at != null,
    }));
}

function settleDay(day, now = Date.now(), fallback = null) {
    const d = h();
    if (!d) return { fresh: false, champs: [] };
    let fresh = false;
    d.tx(() => {
        if (d.get('SELECT 1 AS x FROM ao_daily_champs WHERE day = ? LIMIT 1', String(day))) return;
        let list = top(day, 3);
        if (!list.length && fallback) list = fallback.filter(r => r && validWho(r.who) && r.score > 0).slice(0, 3);
        const dust = require('./dust');
        list.forEach((r, i) => {
            const milli = CHAMP_DUST_MILLI[i] | 0;
            let paidAt = null;
            const m = /^a:(\d+)$/.exec(r.who);
            if (m && milli > 0) {
                const bal = dust.creditExempt(+m[1], milli, 'placement', 'champ:' + day + ':' + (i + 1), now);
                if (bal != null) paidAt = now;
            }
            d.run('INSERT INTO ao_daily_champs (day, place, who, name, score, dust_milli, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                String(day), i + 1, r.who, String(r.name || 'Unnamed').slice(0, 32), Math.max(0, r.score | 0), milli, paidAt, now);
        });
        fresh = true;
    });
    return { fresh, champs: champs(day) };
}

function saveBots(day, world, rows, now = Date.now()) {
    const d = h();
    if (!d || !rows || !rows.length) return 0;
    let n = 0;
    d.tx(() => {
        for (const r of rows) {
            if (!r || typeof r.fam !== 'string' || !r.fam || r.fam.length > 64) continue;
            d.run(`INSERT INTO ao_daily_bots (day, world, fam, name, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(day, world, fam) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`,
                String(day), String(world || ''), r.fam, String(r.name || 'A bot').slice(0, 32), JSON.stringify(r.data || {}), now);
            n++;
        }
    });
    return n;
}

function loadBots(day, world) {
    const d = h();
    if (!d) return [];
    return d.all('SELECT fam, name, data FROM ao_daily_bots WHERE day = ? AND world = ? ORDER BY updated_at', String(day), String(world || '')).map(r => {
        let data = {};
        try { data = JSON.parse(r.data || '{}') || {}; } catch (e) { data = {}; }
        return { fam: r.fam, name: r.name || 'A bot', data };
    });
}

function dropBots(day, world, fams) {
    const d = h();
    if (!d || !fams || !fams.length) return 0;
    let n = 0;
    d.tx(() => { for (const f of fams) n += d.run('DELETE FROM ao_daily_bots WHERE day = ? AND world = ? AND fam = ?', String(day), String(world || ''), String(f)).changes | 0; });
    return n;
}

function pruneBots(day) {
    const d = h();
    if (!d) return 0;
    return d.run('DELETE FROM ao_daily_bots WHERE day < ?', String(day)).changes | 0;
}

function owedFor(guestId) {
    const d = h();
    if (!d || !/^[a-f0-9]{32}$/.test(String(guestId || ''))) return 0;
    const r = d.get('SELECT coalesce(sum(dust_milli), 0) AS m FROM ao_daily_champs WHERE who = ? AND paid_at IS NULL', 'g:' + guestId);
    return (r && r.m) | 0;
}

function mergeData(a, b) {
    const out = Object.assign({}, a || {});
    for (const [k, v] of Object.entries(b || {})) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = k === 'bestStreak' ? Math.max(+out[k] || 0, v) : (+out[k] || 0) + v;
        else if (out[k] == null) out[k] = v;
    }
    return out;
}
function adoptScores(d, guestId, userId, now) {
    const from = 'g:' + guestId, to = 'a:' + userId;
    const u = d.get('SELECT username FROM users WHERE id = ?', userId);
    const uname = u && u.username ? String(u.username).slice(0, 32) : null;
    for (const g of d.all('SELECT * FROM ao_daily_scores WHERE who = ?', from)) {
        const a = d.get('SELECT * FROM ao_daily_scores WHERE day = ? AND who = ?', g.day, to);
        if (!a) {
            d.run('UPDATE ao_daily_scores SET who = ?, name = coalesce(?, name), updated_at = ? WHERE day = ? AND who = ?', to, uname, now, g.day, from);
            continue;
        }
        const ga = parse(g), aa = parse(a);
        d.run('UPDATE ao_daily_scores SET score = ?, play_ms = ?, data = ?, updated_at = ? WHERE day = ? AND who = ?',
            (aa.score | 0) + (ga.score | 0), (aa.playMs || 0) + (ga.playMs || 0), JSON.stringify(mergeData(aa.data, ga.data)), now, g.day, to);
        d.run('DELETE FROM ao_daily_scores WHERE day = ? AND who = ?', g.day, from);
    }
}

function adoptGuest(guestId, userId, now = Date.now()) {
    const d = h();
    if (!d || !/^[a-f0-9]{32}$/.test(String(guestId || '')) || !Number.isInteger(userId)) return 0;
    let paid = 0;
    d.tx(() => {
        adoptScores(d, guestId, userId, now);
        const rows = d.all('SELECT day, place, dust_milli FROM ao_daily_champs WHERE who = ? AND paid_at IS NULL', 'g:' + guestId);
        const dust = require('./dust');
        for (const r of rows) {
            const milli = r.dust_milli | 0;
            if (!d.run('UPDATE ao_daily_champs SET paid_at = ?, who = ? WHERE day = ? AND place = ? AND paid_at IS NULL', now, 'a:' + userId, r.day, r.place).changes) continue;
            if (milli > 0 && dust.creditExempt(userId, milli, 'placement', 'champ:' + r.day + ':' + r.place, now) != null) paid += milli;
        }
    });
    return paid;
}

function placeOf(day, who) {
    const d = h();
    if (!d || !validWho(who)) return null;
    const me = d.get('SELECT score FROM ao_daily_scores WHERE day = ? AND who = ?', String(day), who);
    if (!me || !(me.score > 0)) return null;
    const above = d.get('SELECT COUNT(*) AS n FROM ao_daily_scores WHERE day = ? AND score > ?', String(day), me.score | 0);
    const all = d.get('SELECT COUNT(*) AS n FROM ao_daily_scores WHERE day = ? AND score > 0', String(day));
    return { place: ((above && above.n) | 0) + 1, of: (all && all.n) | 0, score: me.score | 0 };
}

function dailyPlacement(day, now = Date.now(), minMs = 5 * 60 * 1000) {
    const d = h();
    if (!d) return [];
    const rows = d.all('SELECT who, score, play_ms FROM ao_daily_scores WHERE day = ? AND score > 0 ORDER BY score DESC, updated_at ASC', String(day));
    const out = [];
    let rankStore = null;
    try { rankStore = require('./rankStore'); } catch (e) { return out; }
    rows.forEach((r, i) => {
        const m = /^a:(\d+)$/.exec(r.who);
        if (!m || Number(r.play_ms) < minMs) return;
        try {
            const res = rankStore.applyRaidPlacement({
                raidKey: 'day:' + day, userId: +m[1], place: i + 1, rows: rows.length, score: r.score | 0,
                raidMs: Number(r.play_ms) || 0, now, played: true, active: true,
            });
            if (res) out.push({ userId: +m[1], place: res.place, rp: res.bonusRP, dustMilli: res.bonusDustMilli });
        } catch (e) { console.error('[daily] placement failed: ' + ((e && e.message) || e)); }
    });
    return out;
}

module.exports = { CHAMP_DUST_MILLI, available, validWho, placeOf, save, saveBots, loadBots, dropBots, pruneBots, loadOne, loadWorld, top, champs, settleDay, owedFor, adoptGuest, dailyPlacement, _ensure: ensure };
