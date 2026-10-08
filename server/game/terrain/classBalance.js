// Per-class damage into other tanks (players and bots). Rock, chests and
// bosses are left alone, so a nerfed class still mines and loots the same.
// Keyed by the tank's label, the name players see.
// ROYALE_CLASS_BALANCE=0 turns it off.
const enabled = process.env.ROYALE_CLASS_BALANCE !== '0';

const POUNDER = 0.8;   // the pounder line hits players too hard
const VS_TANKS = {
    'Pounder': 0.85, 'Destroyer': POUNDER, 'Artillery': 0.85, 'Launcher': 0.85,
    'Shotgun': POUNDER, 'Eagle': POUNDER, 'Conqueror': POUNDER, 'Hybrid': POUNDER,
    'Annihilator': 0.7, 'Mortar': POUNDER, 'Ordnance': POUNDER, 'Beekeeper': 0.72,
    'Field Gun': POUNDER, 'Skimmer': POUNDER, 'Twister': POUNDER, 'Swarmer': POUNDER, 'Sidewinder': POUNDER,
    'Constructor': 0.8,
    'Octo Tank': 0.88,
    'Penta Shot': 1.12,
};
// Oct 7 2026 (owner: "nerf traps a little bit please"): every trap and block (any projectile of
// type 'trap': Trapper's triangles, Builder/Architect blocks, boomerangs, pillbox bodies), from
// every tank, classic or expanded, player or bot, lands 13% softer on other tanks. Rock, chests
// and bosses take the same as before.
const TRAP_VS_TANKS = 0.87;
// Oct 8 2026 (owner: "nerf the factory/spawner branch, holy op"): minions (Spawner, Factory and
// every tank that makes them, classic or expanded) hit other tanks 40% softer, by ramming and
// with their own guns. Rock, chests and bosses take the same as before.
const MINION_VS_TANKS = 0.6;

// The expanded tree (entityAddons/tanksExpansion.js)
let derived = null;
function multOf(label) {
    if (VS_TANKS[label] != null) return VS_TANKS[label];
    if (!derived) {
        derived = {};
        try {
            if (typeof Class !== 'undefined' && Class.xp_splitter) {
                const D = require('../../lib/definitions/tanks_expansion_data.js');
                const byKey = {};
                const labelOf = k => (Class[k] && Class[k].LABEL) || k;
                for (const t of [...D.tanks].sort((a, b) => a.tier - b.tier)) {
                    const ms = t.parents.map(p => byKey[p] ?? VS_TANKS[labelOf(p)] ?? 1);
                    const m = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length * 1000) / 1000;
                    byKey[t.key] = m;
                    if (m !== 1) derived[t.label] = m;
                }
            }
        } catch { /* */ }
    }
    return derived[label];
}

function rootTank(e) {
    let r = e, hops = 0;
    while (r && r.master && r.master !== r && hops++ < 8) r = r.master;
    return r;
}

// `amount` landing on `target` from `src` (collision hook)
function intoTank(target, src, amount) {
    if (!enabled || !(amount > 0) || !target || !(target.isPlayer || target.isBot) || target.isRoyaleBoss) return amount;
    const root = rootTank(src);
    if (!root || root === target || root.isRoyaleBoss) return amount;
    if (src.type === 'trap') amount *= TRAP_VS_TANKS;
    if (src.type === 'minion' || (src.master && src.master !== src && src.master.type === 'minion')) amount *= MINION_VS_TANKS;
    const m = multOf(root.label);
    return m ? amount * m : amount;
}

module.exports = { intoTank, VS_TANKS, TRAP_VS_TANKS, MINION_VS_TANKS, multOf };
