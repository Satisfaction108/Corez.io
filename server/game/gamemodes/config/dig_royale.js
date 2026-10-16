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
        // Oct 8 2026: 20 x 20 (was 16 x 16, 15 before that). The raid is the
        // rock disk inscribed in this square, radius ~4190 (was ~3350), 1.56x
        // the area. Rocks keep their size (the lattice is capped at 120
        // columns, terrainGrid.js), so the map gets ~3500 rocks instead of
        // ~2250. Things that should not grow with it read terrain/mapScale.js:
        // the storm's hold and final circles keep their old size and the
        // shrink is front-loaded, so few-player raids meet up as before.
        room_width: 20,
        room_height: 20,
        open_layout: {
            open_target: 0.34,
            center_plaza: 210,
            vault_plaza: 560,
            shop_plaza: 380,
            bank_plaza: 460,
            corridor_width: 540,
            corridor_wander: 0.1,
            extra_links: 2,
            center_links: 2,
            cave_cells: 10,
            rim_wall: 400,
            pillars_per_vault: 0,
            min_island_cells: 4,
            min_pocket_cells: 12,
            ore_share: 0.32,
        },
    },
};
