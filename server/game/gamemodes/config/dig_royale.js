// Solo battle royale. Dig Wars 2TDM stays on its own unlisted server.
module.exports = {
    mode: "ffa",
    teams: 1,
    do_not_override_room: false,
    room_setup: ["room_dig_royale"],
    enable_food: false,
    arms_race: false,
    dig_wars: false,
    dig_royale: true,
    war_enabled: false,
    random_body_colors: true,
    arena_shape: "square",
    bot_cap: 0,
    bot_team_cap: 0,
    dig_royale_terrain: {
        seed: 11,
        extrusion_chance: 0.40,
        room_width: 15,
        room_height: 15,
    },
};
