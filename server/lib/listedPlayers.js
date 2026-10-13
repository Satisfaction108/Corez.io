'use strict';

const RAID_FLOOR = 4;

function aoFloor() {
    if (process.env.ROYALE_ALWAYS_ON !== '1') return 0;
    const tanks = parseInt(process.env.ROYALE_AO_TANKS, 10);
    if (tanks > 0) return tanks;
    const bots = parseInt(process.env.ROYALE_AO_BOTS, 10);
    return Number.isFinite(bots) && bots >= 0 ? bots : 10;
}

function listedPlayers(row) {
    const n = Math.max(0, (row && row.players) | 0);
    if (!row || (row.mode !== 'solo' && row.mode !== 'duo')) return n;
    return Math.max(n, RAID_FLOOR, aoFloor());
}

module.exports = { listedPlayers, RAID_FLOOR };
