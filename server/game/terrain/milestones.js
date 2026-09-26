// Personal achievement "dings" for Dig Wars.
//
// The base loop rewards once per mine→carry→bank cycle, so these fire small,
// one-time congratulations as a miner's lifetime banked total climbs - the
// same trick arras uses with levels, but tied to the gem economy instead of
// XP. Every rung also pays a bonus straight into the player's bank, so the
// popup is a real reward, not just a pat on the back.
//
// Progress is stored on the SOCKET (not the body) because banked gems survive
// death; if it lived on the body, a respawned tank would re-collect every
// rung it had already passed and farm the bonuses.

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

// Called every time a player banks (vault.js, outposts.js, the flash vault),
// with the amount that deposit put in the bank. Rungs are reached by REAL
// deposits only (sock.gemDeposited): the bonuses land in the bank and on the
// score but never count toward the next rung, or one rung's payout would
// cascade into the next (45k of deposits used to snowball past 200k banked).
// Spending in the shop does not push progress back either.
function checkBanked(body, deposited) {
    // Tutorial: the lesson HUD already guides the learner step by step, and a
    // second set of reward toasts would talk over it. Real server only.
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
    // Raid board tracks banked separately: forward the bonus or the board
    // permanently undercounts the wallet.
    if (bonusPaid && Config.dig_royale) {
        try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, bonusPaid); } catch { /* */ }
    }
}

module.exports = { checkBanked, BANK_MILESTONES };
