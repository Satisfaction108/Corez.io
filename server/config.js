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
        {
            // DUOS: the Battle Royale with teams of two (parties, fill, shared bases,
            // team standings: game/duo/). Always its own worker on a loopback port,
            // spliced through at <host>/duo (HTTP upgrade) like the tutorial, since the
            // box exposes one public port. royale_duos is copied onto Config in that
            // worker only, so the solo raid never sees it.
            share_client_server: false,
            host: publicHost ? publicHost + ':' + (parseInt(process.env.DUO_PORT) || 3102) : ('localhost:' + (parseInt(process.env.DUO_PORT) || 3102)),
            port: parseInt(process.env.DUO_PORT) || 3102,
            id: 'duo',
            proxyPath: '/duo',

            region: "Local",
            gamemode: ['dig_royale'],
            player_cap: 20,

            featured: false,
            unlisted: false,
            private: false,

            properties: {
                teams: 1,
                bot_cap: 0,
                royale_duos: true,
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
            // TUTORIAL: `unlisted`, so the only way in is the homepage Tutorial button,
            // which connects to this id directly. One room split into isolated learner
            // plots (game/terrain/tutorialPlots.js), so the cap is the number of plots.
            // Never share the main process: that one slot belongs to the live game.
            share_client_server: false,

            // PUBLIC_HOST carries no port, so append it here or the client dials the
            // live game instead. Only works if port 3101 is reachable from outside; by
            // default the host proxies only the main port.
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

    spawn_message: "You have spawned! Welcome to Corez.io.\n"
                 + "You will be invulnerable until you move or shoot.\n"
                 + "Please report any bugs you encounter!",
    token_message: "Friendly reminder: Please do not repeatedly kill others with an overpowered tank.",

    chat_message_duration: 9_000,
    popup_message_duration: 10_000,
    sanitize_chat_input: true,
    // Stripped from player names (sockets.js 's'). '§' opens the in-name
    // colour codes, so typing it would fake a paid name colour; control,
    // zero-width and bidi-override characters hide or reorder text.
    banned_characters: /[\u00a7\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,

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
    // how much a full Max Health bar adds to health (1 = double)
    max_health_skill: 1,
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
    // skill points; progression lives in the gem economy, not levels.
    spawn_at_max_level: true,
    // Manual leveling (options-menu checkbox + 'L' key); off in Dig Wars.
    manual_level_up: false,
    // No incognito in Dig Wars: wealth is public by design. Also ignores the
    // spawn flag.
    allow_incognito: false,

    // DIG WARS: team war effort. Banking gems (and holding outposts) feeds a
    // live blue/red score bar, a running tally with no win target.
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
    // Bots get generated names indistinguishable from players' and no prefix;
    // the soak harness and debug overlay identify bots instead.
    bot_name_prefix: "",
    // Bots count on the live global/default leaderboard. The players-only
    // board remains explicitly human-only; no bot records are persisted.
    bots_count_on_scoreboard: true,

    bot_soak_mode: process.env.BOT_SOAK_MODE === "true",
    bot_soak_report_path: process.env.BOT_SOAK_REPORT || "",
    bot_soak_duration_ms: Math.max(0, (parseInt(process.env.BOT_SOAK_SECONDS, 10) || 0) * 1000),
    // Bot chat provider: NVIDIA NIM's hosted OpenAI-compatible endpoint, with
    // the inexpensive 8B instruct model. Both are overridable.
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

// Overflow solo raids for a crowd. The solo raid on the main thread holds
// player_cap humans; past that a new player needs another raid, and the engine
// runs one room per thread, so each extra raid is a worker on a loopback port.
// server.js hands a new "/" websocket to the first raid with room, so the
// client never knows. They are unlisted: the menu still shows one Solo row with
// the counts added up. SOLO_RAIDS is the total number of solo raids (default 4
// in production, 1 elsewhere so local test servers stay light).
{
    const solo = module.exports.servers.find(s => s.id === 'br');
    const wanted = parseInt(process.env.SOLO_RAIDS);
    const total = Math.max(1, Math.min(8, isFinite(wanted) ? wanted : (process.env.NODE_ENV === 'production' ? 4 : 1)));
    const basePort = parseInt(process.env.SOLO_OVERFLOW_PORT) || ((parseInt(process.env.DUO_PORT) || 3102) + 1);
    for (let i = 1; i < total && solo; i++) {
        module.exports.servers.push({
            share_client_server: false,
            host: solo.host,
            port: basePort + i - 1,
            id: 'br' + (i + 1),
            soloOverflow: true,
            region: solo.region,
            gamemode: solo.gamemode.slice(),
            player_cap: solo.player_cap,
            featured: false,
            unlisted: true,
            private: false,
            properties: { ...solo.properties },
        });
    }
}
