// One twist per raid, shown on the banner. Every knob other modules read
// goes through num()/get() so a mod is just data.
const MODS = [
    { id: "copper_rush",   name: "Copper Rush",        desc: "All the ore is copper, and copper is worth triple.", weight: 1, ore: "copper", gemValueMult: { 1: 3 } },
    // growth mode (royale_growth) replaces this one, see terrain/growth.js
    { id: "giants",        name: "Giants",             desc: "Everyone's tank is 50% bigger, so good luck hiding!", weight: 1.1, sizeMult: 1.5, noGrowth: true },
    { id: "overclocked",   name: "Overclocked",        desc: "Everyone gets ten extra skill points.", weight: 1.2, extraSkill: 10 },
    { id: "arsenal",       name: "Annihilator Arsenal", desc: "Everyone gets an Annihilator sidearm for the whole raid.", weight: 1.2, freeArm: "flak" },
    { id: "glass_cannons", name: "Glass Cannons",      desc: "Everyone does double damage but has half the health.", weight: 1.1, damageMult: 2, healthMult: 0.5 },
    { id: "demolition",    name: "Demolition Day",     desc: "Everyone starts with three Seismic Charges, and the rock breaks 40% easier.", weight: 1, kitStart: { charge: 3 }, rockHpMult: 0.6 },
    { id: "loot_flood",    name: "Loot Flood",         desc: "There are twelve chests instead of six, and they come back after 15 seconds.", weight: 1, chestMult: 2, chestRespawnMult: 0.5 },
    // Magnet Storm with the ability system off; Hook Storm with it on
    { id: "magnet_storm",  name: "Magnet Storm",       desc: "Everyone gets a Gem Magnet, and every gem is worth 25% more.", weight: 1, freeGear: ["magnet"], gemValueMult: 1.25, legacy: true },
    { id: "hook_storm",    name: "Hook Storm",         desc: "Everyone gets a Grapple Hook, and every gem is worth 25% more.", weight: 1, freeAbility: "grapple", gemValueMult: 1.25, abilities: true },
    { id: "rocket_fuel",   name: "Rocket Fuel",        desc: "Everyone moves 35% faster.", weight: 1, speedMult: 1.35 },
    { id: "fast_storm",    name: "Fast Storm",         desc: "The storm closes in almost twice as fast, then holds for longer.", weight: 1, stormShrinkMult: 0.55 },
    { id: "bounty_week",   name: "Hunting Season",        desc: "Kills are worth double points.", weight: 1, killScoreMult: 2 },
    { id: "meteor_season", name: "Meteor Season",      desc: "Meteor showers and gem rain happen twice as often.", weight: 1, eventRateMult: 2.5 },
    { id: "wardens_watch", name: "Warden's Watch",     desc: "Bosses show up twice as often.", weight: 1, bossRateMult: 2.5 },
    { id: "emerald_fever", name: "Emerald Fever",      desc: "There are six emeralds in the rock instead of three, and they come back after 30 seconds.", weight: 0.9, extraEmeralds: 3, emeraldRespawnMs: 30000 },
    { id: "deep_pockets",  name: "Deep Pockets",       desc: "Satchels hold 12,000 gems, or 16,000 with a Reinforced Satchel, and vaults pay out 110%.", weight: 0.8, satchelDeep: true, bankMult: 1.1 },
];

let active = null;
let lastId = null;

// the twists that fit the shop's era (ROYALE_ABILITIES, abilities.js)
function inEra(m) {
    const on = process.env.ROYALE_ABILITIES !== '0';
    return on ? !m.legacy : !m.abilities;
}
function roll(force) {
    let pool = MODS.filter(m => m.id !== lastId && !(m.noGrowth && Config.royale_growth) && inEra(m));
    if (force) pool = MODS.filter(m => m.id === force);
    if (!pool.length) pool = MODS.filter(inEra);
    let total = 0;
    for (const m of pool) total += m.weight || 1;
    let r = Math.random() * total;
    let pick = pool[pool.length - 1];
    for (const m of pool) { r -= (m.weight || 1); if (r <= 0) { pick = m; break; } }
    active = pick;
    lastId = pick.id;
    global.royaleMods = Object.assign({}, pick);
    return pick;
}

function clear() {
    active = null;
    global.royaleMods = {};
    return null;
}
function get() { return active; }
function num(key, dflt) {
    const v = active ? active[key] : undefined;
    return typeof v === "number" ? v : dflt;
}
function snapshot() {
    return active ? { id: active.id, name: active.name, desc: active.desc } : null;
}

// Gem payout multiplier per ore tier (number or per-tier map).
function gemValueMult(ore) {
    if (!active || active.gemValueMult == null) return 1;
    const gv = active.gemValueMult;
    if (typeof gv === "number") return gv;
    return gv[ore] || 1;
}

module.exports = { MODS, roll, clear, get, num, snapshot, gemValueMult };
