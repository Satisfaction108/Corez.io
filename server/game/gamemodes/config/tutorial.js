// Dig Wars tutorial. Same mechanics as the real game (dig_wars: true keeps
// mining, gems, satchels, vaults, outposts and core chambers switched on) but
// the room is split into isolated learner plots - see terrain/tutorialPlots.js.
module.exports = {
    mode: "tdm",
    teams: 2,
    do_not_override_room: false,
    room_setup: ["room_tutorial"],
    enable_food: false,
    arms_race: false,

    dig_wars: true,
    tutorial: true,

    // The lesson cards narrate everything; the stock spawn broadcast would
    // talk over the very first one.
    spawn_message: "Welcome to training.",

    // The tutorial script spawns its own scripted bots (a stationary dummy and
    // a deliberately weak fighter) at the right moment, per plot. The ambient
    // bot filler must stay out of it.
    bot_cap: 0,

    dig_wars_terrain: {
        seed: 7,
        extrusion_chance: 0.40,
    },
};
