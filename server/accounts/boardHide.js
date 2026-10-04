// Accounts kept off the account leaderboards: LEADERBOARD_HIDE in
// server/.env (comma list of usernames, any case; config.leaderboardHide).
//
// A hidden account is left out of the Ranked, Banked and Wins boards (site
// and Discord /leaderboard) and takes no place number there: it is not
// counted in anyone else's place or Legend #N, and has no Legend #N of its
// own. Everything else about it (profile, rank, RP, tier-ups, the raid
// board in game) works as usual.
'use strict';

const config = require('./config');

function names() { return [...(config.leaderboardHide || [])]; }

function isHidden(row) {
    if (!row) return false;
    const set = config.leaderboardHide;
    if (!set || !set.size) return false;
    return set.has(String(row.username_lc || row.username || '').toLowerCase());
}

// SQL that leaves hidden accounts out, for a WHERE clause: {sql, params}.
// `col` is the users.username_lc column as the query names it.
function excludeSql(col = 'username_lc') {
    const n = names();
    if (!n.length) return { sql: '', params: [] };
    return { sql: ` AND ${col} NOT IN (${n.map(() => '?').join(', ')})`, params: n };
}

module.exports = { names, isHidden, excludeSql };
