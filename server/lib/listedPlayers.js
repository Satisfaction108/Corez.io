// The player number the menu shows for a raid row (/getServers.json): the people
'use strict';

const RAID_FLOOR = 4;

// row: { players, mode } as server.js builds it ('solo' | 'duo' for raids)
function listedPlayers(row) {
    const n = Math.max(0, (row && row.players) | 0);
    if (!row || (row.mode !== 'solo' && row.mode !== 'duo')) return n;
    return Math.max(n, RAID_FLOOR);
}

module.exports = { listedPlayers, RAID_FLOOR };
