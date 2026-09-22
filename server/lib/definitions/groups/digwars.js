

const GEM_CUT = [
    [-1, -0.38], [-0.55, -0.95], [0.55, -0.95], [1, -0.38], [0, 0.95],
];

Class.gemFacetCopper  = { SHAPE: GEM_CUT, COLOR: "#eda766", BORDERLESS: true };
Class.gemFacetVein    = { SHAPE: GEM_CUT, COLOR: "#7fb1f2", BORDERLESS: true };
Class.gemFacetShard   = { SHAPE: GEM_CUT, COLOR: "#d98af0", BORDERLESS: true };
Class.gemFacetEmerald = { SHAPE: GEM_CUT, COLOR: "#6ff5a8", BORDERLESS: true };
Class.gemFacetLoot    = { SHAPE: GEM_CUT, COLOR: "#f2cf7f", BORDERLESS: true };
Class.gemSparkle      = { SHAPE: GEM_CUT, COLOR: "#ffffff", BORDERLESS: true };

Class.gemPickupBase = {
    TYPE: "food",
    LABEL: "Gems",
    SHAPE: GEM_CUT,
    SIZE: 7,
    
    
    STROKE_WIDTH: 0.55,
    NO_COLLISIONS: true,
    IGNORED_BY_AI: true,
    DRAW_HEALTH: false,
    CAN_GO_OUTSIDE_ROOM: false,
    
    FACING_TYPE: ["spin", { speed: 0.02 }],
    
    DIE_AT_RANGE: true,
    VARIES_IN_SIZE: false,
    HEALTH_WITH_LEVEL: false,
    DAMAGE_EFFECTS: false,
    BODY: {
        DAMAGE: 0,
        HEALTH: 1000,
        SPEED: 0,
        PUSHABILITY: 0,
        DENSITY: 1,
        RANGE: 2700,
    },
};

Class.gemPickupCopper = {
    PARENT: "gemPickupBase",
    LABEL: "Copper",
    COLOR: "#c96f2e",
    GLOW: { RADIUS: 0.8, COLOR: "#e8a05c", ALPHA: 0.3 },
};

Class.gemPickupVein = {
    PARENT: "gemPickupBase",
    LABEL: "Azurite",
    COLOR: "#3b7ce0",
    GLOW: { RADIUS: 1, COLOR: "#6fa3f2", ALPHA: 0.35 },
};

Class.gemPickupShard = {
    PARENT: "gemPickupBase",
    LABEL: "Core Shard",
    COLOR: "#b13ecf",
    GLOW: { RADIUS: 1.4, COLOR: "#e08af5", ALPHA: 0.45 },
};

Class.gemPickupShardCore = {
    PARENT: "gemPickupBase",
    LABEL: "Core Shard",
    COLOR: "#b13ecf",
    GLOW: { RADIUS: 2, COLOR: "#e08af5", ALPHA: 0.55 },
};

Class.gemPickupEmerald = {
    PARENT: "gemPickupBase",
    LABEL: "Emerald",
    COLOR: "#1fbf6b",
    GLOW: { RADIUS: 1.8, COLOR: "#6ff5a8", ALPHA: 0.55 },
};

Class.gemPickupEmeraldCore = {
    PARENT: "gemPickupBase",
    LABEL: "Emerald",
    COLOR: "#1fbf6b",
    GLOW: { RADIUS: 2.4, COLOR: "#6ff5a8", ALPHA: 0.65 },
};

Class.gemPickupLoot = {
    PARENT: "gemPickupBase",
    LABEL: "Dropped Gems",
    COLOR: "#e0a63b",
    GLOW: { RADIUS: 1.2, COLOR: "#f5cf6e", ALPHA: 0.4 },
};

// The satchel a carrying tank wears on its back. Emerald = blue team, Shard =
// red team (the names are historical; the colour is now the team's).
//
// Colour is expressed as the team colour plus a brightness shift rather than a
// literal hex, so it stays a LIGHTER VERSION OF THE TEAM COLOUR under custom
// themes instead of drifting off-palette the moment somebody reskins the game.
// The facet is the same colour lifted further - it is the lit face of the gem.
// Kept modest on purpose: the client adds this straight onto the base colour's
// HSL lightness, so a big lift clips to white and throws away the team read -
// which is the entire point of colouring the pack by team.
const HOARD_LIFT = 16;   // +0.16 lightness (the client divides this by 100)
const HOARD_FACET_LIFT = 30;
// SHAPE 0 is a circle (drawBody treats a falsy side count as an arc). A round
// bag reads as a satchel; the faceted gem cut read as a jewel stuck to the hull.
// The facet is a smaller concentric disc - the lighter front panel of the bag.
Class.gemHoardEmerald = {
    LABEL: "Hoard",
    SHAPE: 0,
    COLOR: { BASE: "mirror", BRIGHTNESS_SHIFT: HOARD_LIFT },
    STROKE_WIDTH: 1.1,
};
Class.gemHoardEmeraldFacet = { LABEL: "Hoard", SHAPE: 0,
    COLOR: { BASE: "mirror", BRIGHTNESS_SHIFT: HOARD_FACET_LIFT }, BORDERLESS: true };
Class.gemHoardShard = {
    LABEL: "Hoard",
    SHAPE: 0,
    COLOR: { BASE: "mirror", BRIGHTNESS_SHIFT: HOARD_LIFT },
    STROKE_WIDTH: 1.1,
};
Class.gemHoardShardFacet = { LABEL: "Hoard", SHAPE: 0,
    COLOR: { BASE: "mirror", BRIGHTNESS_SHIFT: HOARD_FACET_LIFT }, BORDERLESS: true };

Class.outpostBanner = {
    PARENT: "genericTank",
    LABEL: "Outpost",
    TYPE: "structure",
    ON_MINIMAP: false,
    DANGER: 5,
    LEVEL: 45,
    LEVEL_CAP: 45,
    SIZE: 60,
    
    
    
    SHAPE: 8,
    
    
    
    
    
    BODY: {
        RESIST: 50,
        SPEED: 0,
        ACCELERATION: 0,
        
        
        
        
        
        HEALTH: 9000,
        DAMAGE: 0,
        PENETRATION: 0.25,
        FOV: 0.5,
        PUSHABILITY: 0,
        REGEN: 0,
        SHIELD: 0,
    },
    FACING_TYPE: ["spin", { speed: 0.02 }],
    CONTROLLERS: [],
    
    DISPLAY_NAME: false,
    DRAW_HEALTH: true,
    CAN_BE_ON_LEADERBOARD: false,
    GIVE_KILL_MESSAGE: false,
    ACCEPTS_SCORE: false,
    IGNORED_BY_AI: true,
    HITS_OWN_TYPE: "pushOnlyTeam",
};

Class.coreChamber = {
    PARENT: "genericTank",
    LABEL: "Core Chamber",
    TYPE: "structure",
    ON_MINIMAP: false,
    DANGER: 0,
    LEVEL: 45,
    LEVEL_CAP: 45,
    SIZE: 160,            
    SHAPE: 15,             
    
    
    
    BODY: {
        RESIST: 50,
        SPEED: 0,
        ACCELERATION: 0,
        HEALTH: 18000,     
        DAMAGE: 0,
        PENETRATION: 0.25,
        FOV: 0.5,
        PUSHABILITY: 0,
        REGEN: 0,
        SHIELD: 0,
    },
    FACING_TYPE: ["spin", { speed: 0.02 }],
    CONTROLLERS: [],
    DISPLAY_NAME: false,
    DRAW_HEALTH: false,   
    CAN_BE_ON_LEADERBOARD: false,
    GIVE_KILL_MESSAGE: false,
    ACCEPTS_SCORE: false,
    IGNORED_BY_AI: true,
    HITS_OWN_TYPE: "never",   
};
