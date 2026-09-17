

const MINE_HITS = {
    
    
    
    basic: 10, twin: 10, doubleTwin: 10, tripleTwin: 10, hewnDouble: 10,
    triplet: 9.5, tripleShot: 9.5, pentaShot: 9, spreadshot: 9,
    octoTank: 10, hexaTank: 10, flankGuard: 10, auto3: 10, auto5: 9.5,
    machineGun: 11, sprayer: 11, gunner: 12, autoGunner: 11.5,
    minigun: 10.5, streamliner: 11, nailgun: 12, atomizer: 11,
    triAngle: 10, fighter: 9.5, booster: 9.5, falcon: 9.5,
    sniper: 7, assassin: 6, hunter: 6.5, rifle: 7, marksman: 5.5,
    ranger: 5, stalker: 6, predator: 5.5, xHunter: 5.5, dual: 7,
    pounder: 4.5, eagle: 4, destroyer: 2.5, conqueror: 3, shotgun: 7,
    annihilator: 2, hybrid: 3, blower: 3.5,
    launcher: 4.5, skimmer: 4, twister: 4.5, rocketeer: 4, sidewinder: 5,
    fieldGun: 5, artillery: 6, mortar: 5.5, ordnance: 5.5,

    
    trapper: 7, triTrapper: 7.5, hexaTrapper: 8, septaTrapper: 8,
    megaAutoTrapper: 4.5, gunnerTrapper: 7.5, overtrapper: 7.5, autoTrapper: 7.5,
    tripleAutoTrapper: 7.5, beekeeper: 7,
    barricade: 6.5, fortress: 7,
    builder: 4, autoBuilder: 4.5, engineer: 4, boomer: 5.5,
    assembler: 4.5, architect: 4,
    construct: 2.4,   

    
    director: 10, overseer: 9, overlord: 8, manager: 9, banshee: 9,
    autoOverseer: 9.5, autoDouble: 10.5, underseer: 10, necromancer: 10,
    maleficitor: 10, infestor: 9.5,
    factory: 8, autoSpawner: 9.5, spawner: 9,
    bigCheese: 2.2, fork: 9, hive: 10,
    
    cruiser: 13, battleship: 13, carrier: 12.5, swarmer: 12,

    
    single: 9, deadeye: 6, revolver: 8, musket: 7, prodigy: 7.5,
};

const MINE_HITS_DEFAULT = {
    bullet: 9,
    trap: 6.5,
    drone: 9,
    satellite: 9,
    swarm: 13,
};

function rockHitsFor(owner, projectile) {
    if (owner && Array.isArray(owner.defs)) {
        for (let i = owner.defs.length - 1; i >= 0; i--) {
            const d = owner.defs[i];
            if (typeof d === 'string' && MINE_HITS[d]) return MINE_HITS[d];
        }
    }
    return MINE_HITS_DEFAULT[projectile.type] || 9;
}

function skillFactor(owner) {
    const raw = owner && owner.skill && owner.skill.raw;
    let f = 1;
    if (raw) {
        const cap = Config.skill_cap || 9;
        const invested = (raw[1] + raw[2] + raw[3]) / (3 * cap);
        f = 0.1 + 0.9 * Math.min(1, invested);
    }
    if (owner && owner.weakDrillUntil && Date.now() < owner.weakDrillUntil) f *= 0.55;
    return f;
}

// ── Body grinding: how ram tanks (and ram builds) mine ───────────────────

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
    if (owner && owner.weakDrillUntil && Date.now() < owner.weakDrillUntil) sec *= 1.8;
    return sec;
}

module.exports = { rockHitsFor, skillFactor, grindSecondsFor, MINE_HITS, MINE_HITS_DEFAULT };
