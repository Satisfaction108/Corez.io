// Personal banking milestones for Dig Wars: one-time popups as a player's
// lifetime deposits climb, each paying a bonus into the bank.
// Progress lives on the socket, not the body, so a respawn can't re-collect
// rungs.

const gems = require('./gems.js');

// at: banked threshold that triggers the popup. bonus: gems paid on top.
const BANK_MILESTONES = [
    { at: 100,    bonus: 25 },
    { at: 500,    bonus: 100 },
    { at: 1000,   bonus: 250 },
    { at: 2500,   bonus: 750 },
    { at: 5000,   bonus: 2000 },
    { at: 10000,  bonus: 5000 },
    { at: 25000,  bonus: 15000 },
    { at: 50000,  bonus: 40000 },
    { at: 100000, bonus: 100000 },
];

// Called on every bank (vault.js, outposts.js, flash vault) with the amount
// deposited. Rungs count real deposits only (sock.gemDeposited): bonuses
// don't count toward the next rung, so payouts can't cascade, and shop
// spending doesn't push progress back.
function checkBanked(body, deposited) {
    // not in the tutorial (the lesson HUD owns the screen)
    if (Config.tutorial || !body || !body.socket) return;
    const sock = body.socket;
    if (deposited > 0) sock.gemDeposited = (sock.gemDeposited || 0) + deposited;
    // base deposits arrive in 0.8-gem steps: don't let float dust miss a rung
    const total = Math.floor((sock.gemDeposited || 0) + 1e-6);

    let idx = sock._milestoneIdx;
    if (idx === undefined) idx = 0;

    let bonusPaid = 0;
    while (idx < BANK_MILESTONES.length && total >= BANK_MILESTONES[idx].at) {
        const ms = BANK_MILESTONES[idx];
        const cur = (sock.gemBanked || 0) | 0;
        gems.setBanked(body, cur + ms.bonus);
        sock.talk('MS', 0, ms.at, ms.bonus);
        bonusPaid += ms.bonus;
        idx++;
    }
    sock._milestoneIdx = idx;

    if (bonusPaid) gems.talkGems(body, 0);
    // the raid board tracks banked separately, so forward the bonus
    if (bonusPaid && Config.dig_royale) {
        try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, bonusPaid); } catch { /* */ }
    }
}

module.exports = { checkBanked, BANK_MILESTONES };
