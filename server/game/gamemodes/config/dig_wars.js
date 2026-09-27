module.exports = {
    mode: "tdm",
    teams: 2,
    do_not_override_room: false,
    room_setup: ["room_dig_wars"],
    enable_food: false,
    arms_race: false,
    dig_wars: true,
    dig_wars_terrain: {
        seed: 7,
        extrusion_chance: 0.40,
        // World size in tiles (map_tile_width units each, 420 by default).
        // Read by room_dig_wars.js - see the comment there before changing.
        // This is the density dial: halve the area and every tank on the map
        // becomes twice as likely to run into another one. Width is the haul
        // distance (keep it long enough to hurt), height is just spread.
        //   13 x 9 -> 5460 x 3780 (20.6M sq units)
        room_width: 13,
        room_height: 9,
    },
};
