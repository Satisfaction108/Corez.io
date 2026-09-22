// Dig Royale raid bosses and loot chests. Arras-styled: layered turrets,
// real guns, props for silhouette. Tuned for one or two determined level-45
// tanks over a couple of minutes.
const { combineStats, skillSet, weaponArray } = require('../facilitators.js');
const { base } = require('../constants.js');
const g = require('../gunvals.js');

const GEM_CUT = [[-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95]];
// a cut box: the gem silhouette widened into a chest
const CHEST = [[-1, 0.3], [-1, -0.34], [-0.62, -0.8], [0.62, -0.8], [1, -0.34], [1, 0.3], [0.68, 0.8], [-0.68, 0.8]];

Class.royaleBossBase = {
    PARENT: "genericTank",
    TYPE: "miniboss",
    LABEL: "Raid Boss",
    DANGER: 9,
    LEVEL: 45,
    SKILL: skillSet({ rld: 0.7, dam: 0.85, pen: 0.9, str: 0.9, spd: 0.6, atk: 0.5, hlt: 1, shi: 0.6, rgn: 0.5, mob: 0.3 }),
    CONTROLLERS: [["nearestDifferentMaster", { lockThroughWalls: true }], "royaleBoss", "canRepel"],
    FACING_TYPE: ["spin", { speed: 0.012 }],
    HITS_OWN_TYPE: "hardOnlyBosses",
    RENDER_ON_LEADERBOARD: false,
    CAN_BE_ON_LEADERBOARD: false,
    DRAW_HEALTH: true,
    DISPLAY_NAME: true,
    GIVE_KILL_MESSAGE: false,
    ACCEPTS_SCORE: true,
    HEALTH_WITH_LEVEL: true,
    AI: { NO_LEAD: false },
    BODY: {
        PUSHABILITY: 0.03,
        FOV: 1.4,
        ACCELERATION: 0.45,
        SPEED: base.SPEED * 0.34,
        HEALTH: base.HEALTH * 7,
        SHIELD: base.SHIELD * 1.8,
        REGEN: base.REGEN * 0.13,
        DAMAGE: base.DAMAGE * 1.45,
        RESIST: 1.12,
        DENSITY: 6,
    },
    VALUE: 8e4,
};

// ── Vault Warden: armour, sixteen barrels, nine turrets ────────────────
Class.royaleWardenRing = { SHAPE: 8, COLOR: "#efc74b", STROKE_WIDTH: 1.6 };
Class.royaleWardenCore = { SHAPE: 8, COLOR: "#241d33", STROKE_WIDTH: 1 };
Class.royaleWardenGem = { SHAPE: GEM_CUT, COLOR: "#c9a8ff", BORDERLESS: true };

Class.royaleVaultWarden = {
    PARENT: "royaleBossBase",
    LABEL: "Vault Warden",
    NAME: "Vault Warden",
    COLOR: "#8d6adf",
    SHAPE: 8,
    SIZE: 36,
    BODY: { HEALTH: base.HEALTH * 6.5, SHIELD: base.SHIELD * 2.0, DAMAGE: base.DAMAGE * 1.4, RESIST: 1.14, SPEED: base.SPEED * 0.3 },
    GUNS: [
        ...weaponArray({
            POSITION: [16, 9, 1, 0, 0, 22.5, 0],
            PROPERTIES: {
                SHOOT_SETTINGS: combineStats([g.basic, g.pounder, { reload: 2.1, damage: 1.1, speed: 0.9, maxSpeed: 0.9, health: 1.2 }]),
                TYPE: "bullet", COLOR: "#4c4f5c",
            },
        }, 8),
        ...weaponArray([
            { POSITION: [11, 7, 1, 0, 0, 0, 0] },
            {
                POSITION: [2, 7, 1.3, 11, 0, 0, 0],
                PROPERTIES: {
                    SHOOT_SETTINGS: combineStats([g.trap, g.setTrap, { reload: 2.9, health: 1.3, damage: 0.75 }]),
                    TYPE: "unsetTrap", STAT_CALCULATOR: "block", COLOR: "#4c4f5c",
                },
            },
        ], 8),
    ],
    TURRETS: [
        ...weaponArray({ POSITION: [8.5, 9.4, 0, 45, 170, 0], TYPE: ["trapTurret", { INDEPENDENT: true, COLOR: "#6a4fb5" }] }, 4),
        ...weaponArray({ POSITION: [8, 9.4, 0, 0, 170, 0], TYPE: ["autoTurret", { INDEPENDENT: true, COLOR: "#6a4fb5" }] }, 4),
        { POSITION: [13, 0, 0, 0, 360, 2], TYPE: ["megaAutoTurret", { INDEPENDENT: true, COLOR: "#8d6adf" }] },
    ],
    PROPS: [
        { POSITION: [15, 0, 0, 22.5, 1], TYPE: "royaleWardenRing" },
        { POSITION: [11, 0, 0, 22.5, 1], TYPE: "royaleWardenCore" },
        ...weaponArray({ POSITION: [3.2, 6.4, 0, 0, 1], TYPE: "royaleWardenGem" }, 8),
    ],
};

// ── Magma Drillhead: fast, digs, two cannons and a triple thruster ─────
Class.royaleMagmaShell = { SHAPE: 3, COLOR: "#3a2120", STROKE_WIDTH: 1.4 };
Class.royaleMagmaCore = { SHAPE: 3, COLOR: "#ffb55a", BORDERLESS: true };

Class.royaleMagmaDrillhead = {
    PARENT: "royaleBossBase",
    LABEL: "Magma Drillhead",
    NAME: "Magma Drillhead",
    COLOR: "#ff6c3a",
    SHAPE: 3,
    SIZE: 30,
    FACING_TYPE: "smoothToTarget",
    BODY: { HEALTH: base.HEALTH * 4.2, SHIELD: base.SHIELD * 1.1, DAMAGE: base.DAMAGE * 1.3, RESIST: 1.03, SPEED: base.SPEED * 0.48, ACCELERATION: 0.8, FOV: 1.45 },
    GUNS: [
        {
            POSITION: [24, 12, 1, 0, -8, 0, 0],
            PROPERTIES: { SHOOT_SETTINGS: combineStats([g.basic, g.pounder, g.destroyer, { reload: 2.1, damage: 0.85, speed: 0.9, maxSpeed: 0.9 }]), TYPE: "bullet", COLOR: "#3a2120" },
        },
        {
            POSITION: [24, 12, 1, 0, 8, 0, 0.5],
            PROPERTIES: { SHOOT_SETTINGS: combineStats([g.basic, g.pounder, g.destroyer, { reload: 2.1, damage: 0.85, speed: 0.9, maxSpeed: 0.9 }]), TYPE: "bullet", COLOR: "#3a2120" },
        },
        {
            POSITION: [18, 6, 1, 4, -2.5, 0, 0.25],
            PROPERTIES: { SHOOT_SETTINGS: combineStats([g.basic, g.machineGun, { reload: 1.6, damage: 0.5 }]), TYPE: "bullet", COLOR: "#3a2120" },
        },
        {
            POSITION: [18, 6, 1, 4, 2.5, 0, 0.75],
            PROPERTIES: { SHOOT_SETTINGS: combineStats([g.basic, g.machineGun, { reload: 1.6, damage: 0.5 }]), TYPE: "bullet", COLOR: "#3a2120" },
        },
        ...[-7, 0, 7].map((y, i) => ({
            POSITION: [14, 8, 1, -7, y, 180, i * 0.33],
            PROPERTIES: { SHOOT_SETTINGS: combineStats([g.basic, g.triAngle, g.thruster, { reload: 0.9 }]), TYPE: "bullet", COLOR: "#3a2120" },
        })),
    ],
    TURRETS: [
        { POSITION: [9, 7.5, -6, -120, 190, 0], TYPE: ["machineGunTurret", { INDEPENDENT: true, COLOR: "#ff9a5a" }] },
        { POSITION: [9, 7.5, 6, 120, 190, 0], TYPE: ["machineGunTurret", { INDEPENDENT: true, COLOR: "#ff9a5a" }] },
        { POSITION: [11, 0, 0, 0, 360, 2], TYPE: ["destroyerTurret", { INDEPENDENT: true, COLOR: "#ff6c3a" }] },
    ],
    PROPS: [
        { POSITION: [12, 0, 0, 0, 1], TYPE: "royaleMagmaShell" },
        { POSITION: [6, 0, 0, 0, 1], TYPE: "royaleMagmaCore" },
    ],
};

// ── Geode Colossus: the wall, thirteen turrets, glittering facets ──────
Class.royaleGeodeFacet = { SHAPE: GEM_CUT, COLOR: "#e8fff4", BORDERLESS: true };
Class.royaleGeodeCore = { SHAPE: 6, COLOR: "#173a31", STROKE_WIDTH: 1.4 };
Class.royaleGeodeHeart = { SHAPE: 6, COLOR: "#b6ffe0", BORDERLESS: true };

Class.royaleGeodeColossus = {
    PARENT: "royaleBossBase",
    LABEL: "Geode Colossus",
    NAME: "Geode Colossus",
    COLOR: "#62caa7",
    SHAPE: 6,
    SIZE: 40,
    BODY: { HEALTH: base.HEALTH * 8.5, SHIELD: base.SHIELD * 2.5, DAMAGE: base.DAMAGE * 1.05, RESIST: 1.25, SPEED: base.SPEED * 0.22, ACCELERATION: 0.3, REGEN: base.REGEN * 0.09, DENSITY: 9 },
    TURRETS: [
        ...weaponArray({ POSITION: [7.5, 9.8, 0, 30, 140, 0], TYPE: ["swarmTurret", { INDEPENDENT: true, COLOR: "#3f9a7a" }] }, 6),
        ...weaponArray({ POSITION: [6.5, 8.6, 0, 0, 150, 0], TYPE: ["autoTurret", { INDEPENDENT: true, COLOR: "#3f9a7a" }] }, 6),
        { POSITION: [17, 0, 0, 0, 360, 2], TYPE: ["megaAutoTurret", { INDEPENDENT: true, COLOR: "#62caa7" }] },
    ],
    PROPS: [
        { POSITION: [12.5, 0, 0, 30, 1], TYPE: "royaleGeodeCore" },
        { POSITION: [6, 0, 0, 30, 1], TYPE: "royaleGeodeHeart" },
        ...weaponArray({ POSITION: [4, 6.4, 0, 30, 1], TYPE: "royaleGeodeFacet" }, 6),
    ],
};

// ── Shard Wraith: summoner, four hatches, four lances, sniper spine ────
Class.royaleWraithPlate = { SHAPE: 4, COLOR: "#3a1a3a", STROKE_WIDTH: 1.4 };
Class.royaleWraithCore = { SHAPE: 4, COLOR: "#ffb8f5", BORDERLESS: true };

Class.royaleShardWraith = {
    PARENT: "royaleBossBase",
    LABEL: "Shard Wraith",
    NAME: "Shard Wraith",
    COLOR: "#d153cc",
    SHAPE: 4,
    SIZE: 33,
    FACING_TYPE: "smoothToTarget",
    MAX_CHILDREN: 8,
    BODY: { HEALTH: base.HEALTH * 5.4, SHIELD: base.SHIELD * 1.6, DAMAGE: base.DAMAGE * 1.3, RESIST: 1.12, SPEED: base.SPEED * 0.52, ACCELERATION: 0.7, FOV: 1.45 },
    GUNS: [
        ...weaponArray({
            POSITION: [4, 8, 1.3, 9, 0, 45, 0],
            PROPERTIES: {
                SHOOT_SETTINGS: combineStats([g.drone, g.nestKeeper, { reload: 1.1, speed: 1.6, maxSpeed: 1.6, health: 1.5, damage: 1.3 }]),
                TYPE: ["drone", { LABEL: "Shard", COLOR: "#d153cc", DRAW_HEALTH: true }],
                AUTOFIRE: true,
                STAT_CALCULATOR: "drone",
            },
        }, 4),
        ...weaponArray({
            POSITION: [22, 5.5, 1, 0, 0, 0, 0],
            PROPERTIES: {
                SHOOT_SETTINGS: combineStats([g.basic, g.sniper, { reload: 2.2, damage: 1.3, speed: 1.3, maxSpeed: 1.3, health: 1.4 }]),
                TYPE: "bullet", COLOR: "#3a1a3a",
            },
        }, 4),
    ],
    TURRETS: [
        { POSITION: [8, 7.5, 0, 90, 200, 0], TYPE: ["sniperTurret", { INDEPENDENT: true, COLOR: "#b13ecf" }] },
        { POSITION: [8, 7.5, 0, -90, 200, 0], TYPE: ["sniperTurret", { INDEPENDENT: true, COLOR: "#b13ecf" }] },
        { POSITION: [11, 0, 0, 0, 360, 2], TYPE: ["rifleTurret", { INDEPENDENT: true, COLOR: "#d153cc" }] },
    ],
    PROPS: [
        { POSITION: [12, 0, 0, 45, 1], TYPE: "royaleWraithPlate" },
        { POSITION: [5.5, 0, 0, 45, 1], TYPE: "royaleWraithCore" },
    ],
};

// ── loot chests: a cut box in the gem family, facet and sparkle, still ─
Class.lootChestFacet = { SHAPE: GEM_CUT, COLOR: "#eaa76a", BORDERLESS: true };
Class.lootChestFacetRare = { SHAPE: GEM_CUT, COLOR: "#dc9bf5", BORDERLESS: true };

Class.lootChestBase = {
    TYPE: "food",
    LABEL: "Copper Chest",
    SHAPE: CHEST,
    SIZE: 36,
    STROKE_WIDTH: 0.6,
    IGNORED_BY_AI: true,
    DRAW_HEALTH: false,
    CAN_GO_OUTSIDE_ROOM: false,
    FACING_TYPE: ["spin", { speed: 0 }],
    DIE_AT_RANGE: false,
    VARIES_IN_SIZE: false,
    HEALTH_WITH_LEVEL: false,
    DAMAGE_EFFECTS: false,
    // the engine doubles BODY.HEALTH at definition time (2800 / 3800 in
    // play, about 3-4s of a maxed tank's fire); the client draws cracks from
    // the health fraction
    BODY: { DAMAGE: 0, HEALTH: 1400, RESIST: 1, SPEED: 0, PUSHABILITY: 0, DENSITY: 4 },
};

Class.lootChest = {
    PARENT: "lootChestBase",
    COLOR: "#c97a3e",
    PROPS: [],
};

Class.lootChestRare = {
    PARENT: "lootChestBase",
    LABEL: "Epic Chest",
    COLOR: "#a43fd0",
    SIZE: 40,
    BODY: { DAMAGE: 0, HEALTH: 1900, RESIST: 1, SPEED: 0, PUSHABILITY: 0, DENSITY: 4 },
    PROPS: [],
};
