// Solo battle royale. Dig Wars 2TDM stays on its own unlisted server.
module.exports = {
    mode: "ffa",
    teams: 1,
    do_not_override_room: false,
    room_setup: ["room_dig_royale"],
    enable_food: false,
    // ROYALE_ARMS_RACE=1: the Arms Race tank tree (entityAddons/armsRace)
    arms_race: process.env.ROYALE_ARMS_RACE === '1',
    dig_wars: false,
    dig_royale: true,
    war_enabled: false,
    random_body_colors: true,
    arena_shape: "circle",
    bot_cap: 0,
    bot_team_cap: 0,
    // class upgrades a raid bot takes (index = count, 3+ = a full tier-4
    // tank; was 74%): mostly tier 3 now, so a new Basic is not always outclassed
    bot_class_upgrade_chances: [3, 17, 45, 30, 5],
    // tanks grow with their raid score (terrain/growth.js); false = fixed size
    royale_growth: true,
    // the raid sends its own shield line, so the stock invuln/bug lines only repeat it
    spawn_message: "Welcome to Corez.io. Good luck down there!",
    dig_royale_terrain: {
        seed: 11,
        extrusion_chance: 0.40,
        room_width: 16,    // was 15: a little more room to roam
        room_height: 16,
    },
};
