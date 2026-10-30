// Per-class damage into other tanks (players and bots). Rock, chests and
// bosses are left alone, so a nerfed class still mines and loots the same.
// Keyed by the tank's label, the name players see.
// ROYALE_CLASS_BALANCE=0 turns it off.
const enabled = process.env.ROYALE_CLASS_BALANCE !== '0';

const POUNDER = 1.0;   // Arras pounder/destroyer line hits cleanly
const VS_TANKS = {
    'Pounder': 1.0, 'Destroyer': POUNDER, 'Artillery': 1.0, 'Launcher': 1.0,
    'Shotgun': POUNDER, 'Eagle': POUNDER, 'Conqueror': POUNDER, 'Hybrid': POUNDER,
    'Annihilator': 0.95, 'Mortar': POUNDER, 'Ordnance': POUNDER, 'Beekeeper': 0.9,
    'Field Gun': POUNDER, 'Skimmer': POUNDER, 'Twister': POUNDER, 'Swarmer': POUNDER, 'Sidewinder': POUNDER,
    'Constructor': 0.92,
    'Cyclone': 0.9,
    'Octo Tank': 0.95,
    'Penta Shot': 1.0,
    'Factory': 0.72, 'Flotilla': 0.72, 'Kumquat': 0.72, 'Pomelo': 0.72,
    'Big Cheese': 1.22,
};
// Oct 22 2026 (owner: trapper traps chunk ~1/3 of a tank's HP at 7/6/7
// bullet stats): every trap and block lands 30% softer on other tanks.
// Rock, chests and bosses take the same as before, so trap mining is
// untouched and only tank-vs-tank damage drops.
const TRAP_VS_TANKS = 0.70;
// Minions (Spawner, Factory, etc.) have 6 basic-gun turrets; keep minion PvP
// damage measured so 6 minions don't instagib or steamroll everything.
const MINION_VS_TANKS = 0.72;
// Drones (Overseer/Overlord branch) keep a modest PvP trim so 8 drones don't
// one-shot big tanks in a single claw.
const HELPER_VS_TANKS = 0.82;
const SWARM_VS_TANKS = 1.1;
function helperKind(e) {
    if (!e || e.fromSidearm || e.rockOnly) return null;
    if (e.type === 'drone' || e.type === 'minion') return e.type;
    if (e.type === 'swarm') return e.motionType === 'swarm' ? 'swarm' : null;
    const src = e.source;
    return src && src !== e && src.type === 'minion' ? 'minion' : null;
}
function helperShot(e) { return !!helperKind(e); }

// The expanded tree (entityAddons/tanksExpansion.js)
let derived = null;
let budgetOn = null;
function multOf(label) {
    if (budgetOn === null) {
        budgetOn = false;
        if (typeof Config === 'undefined' || Config.power_budget !== false) { try { require('../../lib/definitions/power_budget_data.js'); budgetOn = true; } catch { budgetOn = false; } }
    }
    if (budgetOn) return undefined;
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
    if (root.isPlayer || root.isBot) {
        const kind = helperKind(src);
        if (kind) amount *= kind === 'swarm' ? SWARM_VS_TANKS : HELPER_VS_TANKS;
    }
    const m = multOf(root.label);
    return m ? amount * m : amount;
}

module.exports = { intoTank, helperShot, helperKind, SWARM_VS_TANKS, VS_TANKS, TRAP_VS_TANKS, MINION_VS_TANKS, HELPER_VS_TANKS, multOf };
