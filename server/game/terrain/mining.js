// Rock damage per hit is in grid.baseRockHealth units, before Mining Power.
// A shot digs by its gun's power (damage x health, 1 for a basic bullet), and
// a gun slower than a basic one gets its slower reload back as extra dig per
// shot: heavy shells break a plain rock outright, rapid fire digs by volume.
const classBalance = require('./classBalance.js');
const BASIC_POWER = 0.75;       // basic gun damage x health
const BASIC_RELOAD = 10.5;
const BASIC_DIG = 0.1;
// A destroyer's reload. Slower guns (necro spawners, which converted shapes
// also feed) dig no harder per shot than that.
const SLOW_CAP = 4;
const TYPE_DIG = { trap: 0.8, drone: 0.8, swarm: 0.8 };
// An Annihilator shell. Sidearm shells are combat guns, not drills (the Drill
// Lance digs through ROCK_POWER instead).
const SIDEARM_DIG_CAP = 12;

// Per-tank nudges for tanks the gun formula leaves far off the pack.
const MINE_BIAS = {
    annihilator: 1.2,
    underseer: 5, necromancer: 2.8, maleficitor: 3, infestor: 1.5,
    // minions orbit and only shoot the rock part of the time
    spawner: 2.2, factory: 2.0, autoSpawner: 1.6,
    manager: 1.4,
    rifle: 1.6, revolver: 1.6, bushwhacker: 1.5, musket: 1.3,
    minigun: 1.2, nailgun: 1.8, vulture: 1.5, focal: 1.2, phoenix: 1.2,
    desmos: 1.2, swarmer: 1.6,
    triAngle: 1.2, fighter: 1.2, booster: 1.2, bomber: 1.2, falcon: 1.2,
    barricade: 1.8, boomer: 2, gunnerTrapper: 1.9, triTrapper: 1.3, trapGuard: 1.2,
    hexaTank: 1.25, octoTank: 1.35, cyclone: 1.35,
    pentaShot: 1.35, spreadshot: 1.35, bentDouble: 1.35, tripleShot: 1.25,
    xp_g175: 1.5, // Fiddle
    // a rammer whose only gun is one small turret
    autoSmasher: 4,
    commander: 0.75, beekeeper: 0.7, battleship: 0.8, carrier: 1.4,
};

function digPower(settings) {
    if (!settings || !(settings.reload > 0)) return 1;
    const power = (settings.damage * settings.health) / BASIC_POWER;
    return power * Math.min(SLOW_CAP, Math.max(1, settings.reload / BASIC_RELOAD));
}

function tankBias(owner) {
    if (!owner || !Array.isArray(owner.defs)) return 1;
    for (let i = owner.defs.length - 1; i >= 0; i--) {
        const d = owner.defs[i];
        if (typeof d === 'string' && MINE_BIAS[d]) return MINE_BIAS[d];
    }
    return 1;
}

const HELPER_DIG = 0.45;
const SWARM_DIG = 0.8;

function rockDamageFor(owner, projectile) {
    let dig = projectile.digPower || 1;
    if (projectile.fromSidearm) dig = Math.min(dig, SIDEARM_DIG_CAP);
    else dig *= tankBias(owner);
    const helper = classBalance.helperKind(projectile);
    const kind = helper === 'swarm' ? SWARM_DIG : helper ? HELPER_DIG : (TYPE_DIG[projectile.type] || 1);
    return BASIC_DIG * kind * dig;
}

// Shop and event multipliers stacked on top of the skill bar (drills,
// overdrive, raid modifiers).
let _shopMod = null, _raidMods = null;
function gearMult(owner) {
    let m = 1;
    if (!owner) return m;
    try {
        _shopMod ||= require('./shop.js');
        m *= _shopMod.miningMult(owner);
    } catch { }
    if (owner.overdriveUntil && Date.now() < owner.overdriveUntil) m *= 2;
    if (owner._pkfx) m *= owner._pkfx.mine || 1;
    try {
        _raidMods ||= require('./raidMods.js');
        m *= _raidMods.num('miningMult', 1);
    } catch { }
    return m;
}

// THE mining speed knob (playtests: "mining is glacial without Mining
// Power"). Everyone's bare dig rate (tanks and bots, shots and ramming) is
// BASE_BOOST times the old one; a full bar is FULL_TRIM of the old full bar,
// so Mining Power still adds on top but over a slightly flatter curve.
//   shots:  0.4x -> 2.0x  became  0.54x -> 1.90x
//   grind:  0.55x -> 2.0x became  0.7425x -> 1.90x
// ROYALE_MINE_BASE_BOOST=1 with ROYALE_MINE_FULL_TRIM=1 is the old curve.
const envNum = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const BASE_BOOST = envNum('ROYALE_MINE_BASE_BOOST', 2.4);
const FULL_TRIM = envNum('ROYALE_MINE_FULL_TRIM', 1.25);
const SHOT_BARE = 0.4 * BASE_BOOST, SHOT_SPAN = 2.0 * FULL_TRIM - SHOT_BARE;
const GRIND_BARE = 0.55 * BASE_BOOST, GRIND_SPAN = 2.0 * FULL_TRIM - GRIND_BARE;

// Share of a normal 9-point Mining Power bar. Smasher hulls cap the stat at 12
// like their other stats, so they can go past 1 the same way.
function miningInvested(owner) {
    const cap = Config.skill_cap || 9;
    const top = Math.max(cap, (owner.skill.caps && owner.skill.caps[10]) || 0);
    return Math.max(0, Math.min(top, owner.skill.raw[10] || 0)) / cap;
}

// Mining Power (skill index 10) is the dig stat. Zero points still digs, so a
// pure fighter is slow, not stuck.
function skillFactor(owner) {
    const raw = owner && owner.skill && owner.skill.raw;
    let f = 1;
    if (raw) {
        const invested = miningInvested(owner);
        f = SHOT_BARE + SHOT_SPAN * invested;      // 0.54x bare to 1.90x maxed
    }
    if (owner && owner.weakDrillUntil && Date.now() < owner.weakDrillUntil) f *= 0.55;
    return f * gearMult(owner);
}

// ── Body grinding: how ram tanks (and ram builds) mine ───────────────────

// Smasher-family hulls grind this much faster than a ram build on a gun tank.
const RAM_DIG = 1.3;

// raw[6] is body damage (see skcnv in entities/skills.js - the internal skill
// order is NOT the order the skill bar displays).
function grindSecondsFor(owner) {
    const raw = owner && owner.skill && owner.skill.raw;
    const b = raw ? raw[6] : 0;
    const gunless = !!(owner && owner.guns && owner.guns.size === 0);
    let sec;
    if (gunless) sec = 18.5 / Math.max(b, 3);
    else {
        if (!(b >= 1)) return null;
        sec = 18.5 / b;
    }
    if (raw) {
        sec /= GRIND_BARE + GRIND_SPAN * miningInvested(owner);
    }
    if (owner.settings && owner.settings.reloadToAcceleration) sec /= RAM_DIG;
    if (owner.weakDrillUntil && Date.now() < owner.weakDrillUntil) sec *= 1.8;
    if (owner && owner._pkfx && owner._pkfx.grind > 1) sec /= owner._pkfx.grind;
    sec /= Math.max(0.25, gearMult(owner));
    return sec;
}

module.exports = { digPower, rockDamageFor, skillFactor, grindSecondsFor, gearMult, MINE_BIAS, HELPER_DIG, SWARM_DIG, TYPE_DIG, BASE_BOOST, FULL_TRIM, SHOT_BARE, SHOT_SPAN, GRIND_BARE, GRIND_SPAN };
