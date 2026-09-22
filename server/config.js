// Render exposes a single port and sets RENDER_EXTERNAL_URL automatically.
// PUBLIC_HOST is an optional manual override for custom domains.
const fs = require('fs');
const path = require('path');
const publicHost = (
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.PUBLIC_HOST ? `https://${process.env.PUBLIC_HOST}` : "")
).replace(/^https?:\/\//, "");

let localBotChatKey = "";
for (const keyFile of ["../nvidiaapikey.txt", "../deepseekapikey.txt"]) {
    if (localBotChatKey) break;
    try {
        localBotChatKey = fs.readFileSync(path.join(__dirname, keyFile), "utf8").trim();
    } catch { }
}

module.exports = {

    devBuild: false,

    main_menu: 'index.html',
    host: publicHost || 'localhost:3000',
    port: parseInt(process.env.PORT) || 3000,

    visible_list_interval: 250,
    startup_logs: true,
    load_all_mockups: false,

    servers: [
        {
            // Render runs one process on one exposed port, so the game server
            // must share the lobby's port/process there. Set SINGLE_PROCESS=true
            // as an env var on Render (locally this stays false / worker mode).
            share_client_server: process.env.SINGLE_PROCESS === "true",

            // BR_PORT lets a second local copy run beside the main one (profiling).
            host: publicHost || ('localhost:' + (parseInt(process.env.BR_PORT) || 3100)),
            port: process.env.SINGLE_PROCESS === "true" ? (parseInt(process.env.PORT) || 3000) : (parseInt(process.env.BR_PORT) || 3100),
            id: 'br',

            region: "Local",
            gamemode: ['dig_royale'],
            player_cap: 20,

            featured: true,
            unlisted: false,
            private: false,

            properties: {
                teams: 1,
                bot_cap: 0
            }
        },
        // Dig Wars 2TDM is parked for now: no worker, and #dw routes nowhere.
        // {
        //     share_client_server: false,
        //     host: publicHost ? publicHost + ':3102' : 'localhost:3102',
        //     port: 3102,
        //     id: 'dw',
        // 
        //     region: "Local",
        //     gamemode: ['dig_wars'],
        //     player_cap: 16,
        // 
        //     featured: false,
        //     unlisted: true,
        //     private: false,
        // 
        //     properties: {
        //         teams: 2,
        //         bot_cap: 16
        //     }
        // },
        {
            // TUTORIAL. Deliberately `unlisted` so it never appears on the
            // region/server picker - the only way in is the homepage Tutorial
            // button, which connects to this id directly. One room split into
            // isolated learner plots (see game/terrain/tutorialPlots.js), so
            // the cap is the number of plots, not a balance choice.
            // NEVER share the main process. Only one server may do that (see
            // "Only one server can be loaded via through the main server" in
            // server.js) and that slot belongs to the live game - claiming it
            // here takes the whole site down. The tutorial always runs as its
            // own worker on its own port.
            share_client_server: false,

            // PUBLIC_HOST carries no port, so it must be appended here or the
            // client dials the main domain - i.e. the live game - instead.
            // NOTE: this only works once port 3101 is reachable from outside;
            // by default the host proxies only the main port.
            host: publicHost ? publicHost + ':3101' : ('localhost:' + (parseInt(process.env.TUT_PORT) || 3101)),
            port: parseInt(process.env.TUT_PORT) || 3101,
            id: 'tut',

            region: "Tutorial",
            gamemode: ['tutorial'],
            player_cap: 4,   // one per plot - see tutorialPlots.plotCount()

            featured: false,
            unlisted: true,
            private: false,

            properties: {
                teams: 2,
                bot_cap: 0
            }
        },
    ],

    allow_ACAO: false,

    map_tile_width: 420,
    map_tile_height: 420,

    spawn_message: "You have spawned! Welcome to the game.\n"
                 + "You will be invulnerable until you move or shoot.\n"
                 + "Please report any bugs you encounter!",
    token_message: "Friendly reminder: Please do not repeatedly kill others with an overpowered tank.",

    chat_message_duration: 9_000,
    popup_message_duration: 10_000,
    sanitize_chat_input: true,

    fireworks: false,
    thanksgiving: false,
    spooky_theme: false,

    game_speed: 1,
    run_speed: 1.5,
    max_heartbeat_interval: 300_000,
    respawn_delay: 0,

    bullet_spawn_offset: 1,
    damage_multiplier: 1,
    knockback_multiplier: 1.1,
    glass_health_factor: 2,
    room_bound_force: 0.01,
    soft_max_skill: 0.59,

    // 50 points at level 45: 2..39 pay one each (38), 40..45 pay two (12).
    defineLevelSkillPoints: level => {
        if (level < 2) return 0;
        if (level <= 39) return 1;
        if (level <= 45) return 2;
        return 0;
    },

    level_cap: 100,
    level_cap_cheat: 45,

    // DIG WARS: everyone spawns straight at level 45, full size, with all
    // skill points — progression lives in the gem economy, not levels.
    spawn_at_max_level: true,
    // The old level-up paths (options-menu checkbox + 'L' key) — disabled,
    // not removed. Flip to true to bring manual leveling back.
    manual_level_up: false,
    // Incognito is gone in Dig Wars — wealth is public by design. The
    // client UI no longer offers it; this also ignores the spawn flag.
    allow_incognito: false,

    // DIG WARS: team war effort. Banking gems (and holding outposts) feeds a
    // live blue/red score bar. There is no win target - the bar is just a
    // running tally of who has contributed more this match.
    war_enabled: true,
    war_target: parseInt(process.env.WAR_TARGET, 10) || 25000,
    war_outpost_trickle: 6,    // war points per second per owned outpost
    war_win_bonus: 2000,       // gems added to each winner's personal bank
    war_round_over_ms: 9000,   // victory screen length before the reset

    skill_cap: 9,
    tier_cap: 100,
    tier_multiplier: 15,

    // Keep matches populated without drowning the sim. 16 total, 8 per side.
    bot_cap: 16,
    bot_team_cap: 8,
    bot_xp_gain: 60,
    bot_start_level: 100,
    bot_skill_upgrade_chances: [1, 1, 3, 4, 4, 4, 4, 2, 1, 1, 3],
    bot_class_upgrade_chances: [1, 5, 20, 37, 37],
    // Bots use procedurally generated names that are indistinguishable from
    // real players. Leave the prefix empty so the leaderboard stays clean.
    // The soak harness and debug overlay provide bot identification instead.
    bot_name_prefix: "",
    // Bots count on the live global/default leaderboard. The players-only
    // board remains explicitly human-only; no bot records are persisted.
    bots_count_on_scoreboard: true,

    bot_soak_mode: process.env.BOT_SOAK_MODE === "true",
    bot_soak_report_path: process.env.BOT_SOAK_REPORT || "",
    bot_soak_duration_ms: Math.max(0, (parseInt(process.env.BOT_SOAK_SECONDS, 10) || 0) * 1000),
    // NVIDIA NIM's hosted OpenAI-compatible endpoint is the default provider.
    // The 8B instruct model keeps chat inexpensive while still handling short
    // casual conversations well; both values remain overridable for testing.
    bot_chat_ai_enabled: process.env.BOT_CHAT_AI !== "false",
    bot_chat_api_url: process.env.BOT_CHAT_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
    bot_chat_model: process.env.BOT_CHAT_MODEL || "meta/llama-3.1-8b-instruct",
    bot_chat_api_key: process.env.BOT_CHAT_API_KEY || localBotChatKey,
    bot_chat_timeout_ms: Math.max(800, parseInt(process.env.BOT_CHAT_TIMEOUT_MS, 10) || 4500),

    spawn_class: 'basic',

    regenerate_tick: 100,

    enable_food: true,
    food_cap: 70,
    food_cap_nest: 15,
    enemy_cap_nest: 10,
    food_group_cap: 6,

    food_types: Array(3).fill().map((_, i, a) => [

        4 ** (a.length - i),

        Array(3).fill().map((_, j, b) => [

            5 ** (b.length - j),

            Array(6).fill().map((_, k, c) => [

                k ? 10 ** (c.length - k - 1) : 200_000_000,

                [
                    [24, `laby_${i}_${j}_${k}_0`],

                ]
            ])
        ])
    ]),
    food_types_nest: Array(2).fill().map((_, i, a) => [

        4 ** (a.length - i),

        Array(3).fill().map((_, j, b) => [

            5 ** (b.length - j),

            Array(6).fill().map((_, k, c) => [

                k ? 10 ** (c.length - k - 1) : 200_000_000,

                [
                    [24, `laby_${i + 3}_${j}_${k}_0`],

                ]
            ])
        ])
    ]),

    classic_food: true,
    classic_food_types: [
        [1, [
            [65, 'egg'], [64, 'triangle'], [45, 'square'], [7, 'pentagon']
        ]],
        [1/50000, [
            [625, 'gem'], [125, 'shinyTriangle'], [25, 'shinySquare'], [5, 'shinyPentagon']
        ]],
        [1/1000000, [
            [1296, 'jewel'], [216, 'legendaryTriangle'], [36, 'legendarySquare'], [6, 'legendaryPentagon']
        ]]
    ],
    classic_food_types_nest: [
        [1, [
            [16, 'pentagon'], [4, 'betaPentagon'], [1, 'alphaPentagon']
        ]]
    ],
    classic_enemy_types_nest: [
        [1, [
            [1, 'crasher']
        ]],
        [1/20, [
            [1, 'sentryGun'], [1, 'sentrySwarm'], [1, 'sentryTrap']
        ]]
    ],

    enable_bosses: false,
    boss_spawn_cooldown: 20,
    boss_spawn_delay: 6,
    boss_types: [

        {
            bosses: ['paladin', 'freyja', 'zaphkiel', 'nyx', 'theia'],
            amount: [1], chance: 50,
            message: 'The world tremors as the celestials are reborn anew!',
        },
        {
            bosses: ['julius', 'genghis', 'napoleon'],
            amount: [1], chance: 50,
            message: 'The darkness arrives as the realms are torn apart!',
        }
    ],

    team_weights: {},

    brain_damage: false,
    random_body_colors: false,

    gamemode_name_prefixes: [],
    arena_shape: 'rect',
    arms_race: false,
    blackout: false,
    clan_wars: false,
    diep: false,
    domination: false,
    growth: false,
    groups: false,
    march_madness: false,
    mode: 'tdm',
    mothership: false,
    siege: false,
    space_physics: false,
    spawn_confinement: {},
    tag: false,
    teams: 2,
    train: false,
    use_limited_waves: false,

    room_setup: ['room_default'],
}
