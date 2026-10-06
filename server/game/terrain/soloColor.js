// A solo player's tank colour through one raid's lives
'use strict';

// Round 9: the memory is keyed by the person (account id, else guest id), not the
const byWho = new Map();     // who -> { raid, c }
function whoOf(socket) {
    if (!socket) return null;
    if (socket.account && socket.account.id) return 'a:' + socket.account.id;
    if (socket.guestId) return 'g:' + socket.guestId;
    return null;
}

// socket: carries _raidColor {raid, c}; team: this life's id
function colorFor(socket, team, raidId, kept) {
    let c;
    const who = whoOf(socket);
    const rc = (who && byWho.get(who)) || (socket && socket._raidColor);
    if (kept && kept.color != null) c = kept.color;
    else if (raidId && rc && rc.raid === raidId && rc.c != null) {
        c = rc.c;
        if (global.royaleTeamColors) global.royaleTeamColors.set(team, c);
    } else c = global.assignTeamColor(team);
    if (raidId && socket) socket._raidColor = { raid: raidId, c };
    if (raidId && who) {
        if (byWho.size > 2000) for (const [k, v] of byWho) if (v.raid !== raidId) byWho.delete(k);
        byWho.set(who, { raid: raidId, c });
    }
    return c;
}

module.exports = { colorFor, whoOf, _byWho: byWho };
