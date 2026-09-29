// Death log: one row per human death in a raid (accounts and guests), so we
// can see what kills people and how long their lives last. Best effort like
// guests.js; a failed write never touches the game.
'use strict';

const db = require('./db');

const CAUSES = new Set(['bot', 'player', 'boss', 'storm', 'other']);
const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

// {userId, guestId, serverId, cause, killerName, killerTank, lifeMs, lifeNo, newbie}
function record(r, now = Date.now()) {
    const d = db.handle();
    if (!d || !r) return false;
    const cause = CAUSES.has(r.cause) ? r.cause : 'other';
    try {
        d.run(`INSERT INTO deaths (at, user_id, guest_id, server_id, cause, killer_name, killer_tank, life_ms, life_no, newbie)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            now, r.userId || null, r.userId ? null : clip(r.guestId, 32), clip(r.serverId, 32), cause,
            clip(r.killerName, 40), clip(r.killerTank, 40),
            Math.max(0, Math.floor(+r.lifeMs || 0)), Math.max(0, r.lifeNo | 0), r.newbie ? 1 : 0);
        return true;
    } catch (e) {
        console.error('[accounts] death log: ' + ((e && e.message) || e));
        return false;
    }
}

// Deaths since `since`: counts per cause and the median life length.
function summary(since) {
    const d = db.handle();
    const out = { total: 0, bot: 0, player: 0, boss: 0, storm: 0, other: 0, medianLifeMs: 0 };
    if (!d) return out;
    for (const row of d.all('SELECT cause, count(*) AS n FROM deaths WHERE at >= ? GROUP BY cause', since)) {
        if (out[row.cause] !== undefined) out[row.cause] = row.n | 0;
        out.total += row.n | 0;
    }
    if (out.total) {
        const mid = d.get('SELECT life_ms FROM deaths WHERE at >= ? ORDER BY life_ms LIMIT 1 OFFSET ?', since, (out.total - 1) >> 1);
        out.medianLifeMs = mid ? mid.life_ms | 0 : 0;
    }
    return out;
}

module.exports = { record, summary, CAUSES };
