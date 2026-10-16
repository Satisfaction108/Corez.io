'use strict';

const db = require('./db');
const boardHide = require('./boardHide');

let readyFor = null;
function h() {
    const d = db.handle();
    if (!d) return null;
    if (readyFor !== d) {
        try {
            d.exec(`CREATE TABLE IF NOT EXISTS tank_records (
                tank            TEXT    NOT NULL PRIMARY KEY,
                who             TEXT    NOT NULL,
                user_id         INTEGER,
                public_id       TEXT,
                username        TEXT    NOT NULL,
                score           INTEGER NOT NULL DEFAULT 0,
                kills           INTEGER NOT NULL DEFAULT 0,
                play_ms         INTEGER NOT NULL DEFAULT 0,
                division        INTEGER,
                legend_no       INTEGER NOT NULL DEFAULT 0,
                name_style_nid  INTEGER NOT NULL DEFAULT 0,
                name_color      TEXT,
                updated_at      INTEGER NOT NULL
            ) STRICT`);
            readyFor = d;
        } catch (e) {
            return null;
        }
    }
    return d;
}

const memRecords = new Map();
let tankCatalogCache = null;

function buildCatalog() {
    if (tankCatalogCache) return tankCatalogCache;
    if (typeof Class === 'undefined' || !Class.basic) return [];
    const tiers = new Map();
    const keyOfDef = new Map();
    for (const k in Class) if (Class[k]) keyOfDef.set(Class[k], k);
    const rootKey = keyOfDef.get(Class.basic) || 'basic';
    tiers.set(rootKey, 1);
    const q = [rootKey];
    while (q.length) {
        const k = q.shift(), d = Class[k];
        if (!d) continue;
        for (let t = 1; t <= 4; t++) {
            for (let e of d['UPGRADES_TIER_' + t] || []) {
                if (Array.isArray(e)) { if (e.length !== 1) continue; e = e[0]; }
                const ck = typeof e === 'string' ? e : keyOfDef.get(e);
                if (!ck || tiers.has(ck) || !Class[ck]) continue;
                tiers.set(ck, t + 1);
                q.push(ck);
            }
        }
    }
    const byName = new Map();
    for (const [k, tier] of tiers) {
        const d = Class[k];
        if (!d) continue;
        const name = String(d.UPGRADE_LABEL || d.LABEL || k).trim();
        if (!name || name === '?' || /^generic/i.test(name)) continue;
        const prev = byName.get(name);
        if (!prev || tier < prev.tier) byName.set(name, { tank: name, tier, key: k });
    }
    const list = [...byName.values()];
    list.sort((a, b) => (a.tier - b.tier) || a.tank.localeCompare(b.tank));
    tankCatalogCache = list;
    return list;
}

function recordRun(body, tankName, score, kills, playMs, now = Date.now()) {
    const tank = String(tankName || (body && body.label) || '').trim().slice(0, 40);
    score = Math.max(0, Math.floor(+score || 0));
    kills = Math.max(0, Math.floor(+kills || 0));
    playMs = Math.max(1000, Math.floor(+playMs || 0));
    if (!tank || score <= 0 || !body || body.isBot || !body.socket) return false;
    const sock = body.socket;
    const acct = sock.account && sock.account.id ? sock.account : null;
    if (acct) {
        try {
            const users = require('./users');
            const uRow = users.byId(acct.id);
            if (uRow && boardHide.isHidden(uRow)) return false;
        } catch { /* */ }
    }
    const who = acct ? ('a:' + acct.id) : (sock.guestId ? ('g:' + sock.guestId) : ('s:' + (sock.id || '0')));
    const username = String((acct && acct.username) || body.name || 'Unnamed').trim().slice(0, 32) || 'Unnamed';
    const publicId = acct && acct.publicId ? String(acct.publicId) : null;
    const userId = acct ? (acct.id | 0) : null;
    let division = null, legendNo = 0, nameStyleNid = body.nameStyleNid | 0, nameColor = body.customNameColor || null;
    if (userId) {
        try {
            const users = require('./users');
            const rankStore = require('./rankStore');
            const store = require('./store');
            const uRow = users.byId(userId);
            if (uRow) {
                const snap = rankStore.snapshot(uRow, { now });
                if (snap && snap.division != null) { division = snap.division; legendNo = snap.legendNo | 0; }
                const cos = store.cosmeticsFor(uRow);
                if (cos) { nameStyleNid = cos.nameStyleNid | 0; nameColor = cos.nameColor || null; }
            }
        } catch { /* */ }
    }

    const curMem = memRecords.get(tank);
    if (!curMem || score > curMem.score || (score === curMem.score && playMs < curMem.playMs)) {
        memRecords.set(tank, {
            tank, who, userId, publicId, username, score, kills, playMs,
            division, legendNo, nameStyleNid, nameColor, updatedAt: now,
        });
    }

    const d = h();
    if (!d) return true;
    try {
        const prev = d.get('SELECT score, play_ms FROM tank_records WHERE tank = ?', tank);
        if (!prev || score > (prev.score | 0) || (score === (prev.score | 0) && playMs < (prev.play_ms | 0))) {
            d.run(`INSERT INTO tank_records (tank, who, user_id, public_id, username, score, kills, play_ms, division, legend_no, name_style_nid, name_color, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(tank) DO UPDATE SET
                       who = excluded.who, user_id = excluded.user_id, public_id = excluded.public_id,
                       username = excluded.username, score = excluded.score, kills = excluded.kills,
                       play_ms = excluded.play_ms, division = excluded.division, legend_no = excluded.legend_no,
                       name_style_nid = excluded.name_style_nid, name_color = excluded.name_color, updated_at = excluded.updated_at`,
                tank, who, userId, publicId, username, score, kills, playMs, division, legendNo, nameStyleNid, nameColor, now);
        }
    } catch { /* */ }
    return true;
}

function getAllRows() {
    const catalog = buildCatalog();
    const byTank = new Map();
    for (const [k, v] of memRecords) byTank.set(k, v);
    const d = h();
    if (d) {
        try {
            const rows = d.all('SELECT * FROM tank_records');
            for (const r of rows) {
                const cur = byTank.get(r.tank);
                if (!cur || (r.score | 0) >= (cur.score | 0)) {
                    byTank.set(r.tank, {
                        tank: r.tank,
                        who: r.who,
                        userId: r.user_id,
                        publicId: r.public_id,
                        username: r.username,
                        score: r.score | 0,
                        kills: r.kills | 0,
                        playMs: r.play_ms | 0,
                        division: r.division != null ? (r.division | 0) : null,
                        legendNo: r.legend_no | 0,
                        nameStyleNid: r.name_style_nid | 0,
                        nameColor: r.name_color || null,
                        updatedAt: r.updated_at || 0,
                    });
                }
            }
        } catch { /* */ }
    }
    const list = catalog.length ? catalog : [...byTank.keys()].map(t => ({ tank: t, tier: 1 }));
    const R = require('../../shared/ranks.js');
    return list.map((item, idx) => {
        const rec = byTank.get(item.tank) || null;
        const div = rec && rec.division != null ? rec.division : null;
        return {
            place: idx + 1,
            tank: item.tank,
            tankTier: item.tier || 1,
            hasRecord: !!(rec && rec.score > 0),
            userId: rec ? (rec.publicId || null) : null,
            username: rec ? rec.username : null,
            score: rec ? (rec.score | 0) : 0,
            kills: rec ? (rec.kills | 0) : 0,
            playMs: rec ? (rec.playMs | 0) : 0,
            division: div,
            name: div != null ? R.nameOf(div) : '',
            tier: div != null ? R.tierOf(div) : '',
            legendNo: rec ? (rec.legendNo | 0) : 0,
            nameStyleNid: rec ? (rec.nameStyleNid | 0) : 0,
            nameColor: rec ? rec.nameColor : null,
        };
    });
}

module.exports = { recordRun, getAllRows, buildCatalog };
