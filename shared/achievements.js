// Achievements catalog, shared by the server (require) and the client
// (<script> served at /shared/achievements.js, exposes window.DWAchievements).
//
// One entry per achievement. Fields:
//   id      stored in user_achievements / guest_achievements; never renamed
//           (the first 12 ids are older than this file and keep their rows)
//   cat     first | combat | mining | banking | tanks | abilities | raid | secret
//   name    short and fun; desc says how to get it, one line
//   icon    a glyph key (public/client/account/achievements.js draws them)
//   color   the medal colour (defaults to the category's)
//   diff    1..5, sets the dust reward (DUST_MILLI)
//   track   counter it reads (progress row 'c:<track>'), with goal; entries
//           on one track are tiers I, II, III in goal order
//   mode    'add' (default: a running total), 'max' (the best value seen) or
//           'set' (distinct things, e.g. tanks tried; the row keeps the list)
//   secret  hidden as ??? until unlocked
//   item    a cosmetic it also gives (an exclusive in shared/cosmetics.js)
//
// Rewards are small on purpose: the whole list pays about as much as one
// rare name style. Guests earn them too; the dust and items wait until they
// sign up (achievements.adoptGuest).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWAchievements = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CATS = Object.freeze([
        { id: 'first',     name: 'First Steps', color: '#7ad3ff' },
        { id: 'combat',    name: 'Combat',      color: '#ff7a6b' },
        { id: 'mining',    name: 'Mining',      color: '#e0a060' },
        { id: 'banking',   name: 'Banking',     color: '#4fe08f' },
        { id: 'tanks',     name: 'Tanks',       color: '#c3a6ff' },
        { id: 'abilities', name: 'Abilities',   color: '#6ee0d6' },
        { id: 'raid',      name: 'Raid',        color: '#ffc665' },
        { id: 'secret',    name: 'Secret',      color: '#ff8fcf' },
    ].map(Object.freeze));
    const CAT_BY_ID = new Map(CATS.map(c => [c.id, c]));

    // diff -> gemdust in milli (1000 = 1 dust)
    const DUST_MILLI = Object.freeze([0, 250, 500, 1000, 2500, 5000]);

    const BIOME_UI = { sandstone: '#e8bf84', clay: '#f0a476', moss: '#9ae0a4', crystal: '#8fdcf5', magma: '#ff8a5c', obsidian: '#c3a6ff' };
    const ORE_UI = { copper: '#e0915a', vein: '#5aa8ff', shard: '#b07aff', emerald: '#1fbf6b' };

    const A = (cat, id, name, desc, icon, diff, extra) => Object.assign({ cat, id, name, desc, icon, diff }, extra || {});
    const RAW = [
        // ---- First Steps: the first few minutes ----
        A('first', 'fs_rock',    'Rock On',        'Break your first rock',                  'rock', 1),
        A('first', 'fs_gem',     'Ooh, Shiny',     'Pick up a gem',                          'gem', 1),
        A('first', 'fs_stat',    'Point Taken',    'Spend a stat point',                     'stat', 1),
        A('first', 'fs_tank',    'Glow Up',        'Upgrade to a new tank',                  'tank', 1),
        A('first', 'fs_bank',    'Safe and Sound', 'Bank some gems at a vault',              'vault', 1),
        A('first', 'fs_ko',      'Bonk',           'Knock out another tank',                'bonk', 1),
        A('first', 'fs_grow',    'Growth Spurt',   'Grow a size bigger',                     'grow', 1),
        A('first', 'fs_ability', 'Party Trick',    'Use an ability',                         'bolt', 1),

        // ---- Combat ----
        A('combat', 'first_blood', 'First Blood',     'Knock out another player',                 'crosshair', 2, { track: 'kills', goal: 1, solo: true }),
        A('combat', 'kills_1',     'Scrapper',        'Knock out 25 players',                     'swords', 2, { track: 'kills', goal: 25 }),
        A('combat', 'kills_2',     'Brawler',         'Knock out 150 players',                    'swords', 3, { track: 'kills', goal: 150 }),
        A('combat', 'kills_3',     'Menace',          'Knock out 600 players',                    'swords', 4, { track: 'kills', goal: 600 }),
        A('combat', 'bot_buster',  'Tank Buster',     'Knock out 50 tanks in raids',              'crosshair', 2, { track: 'botkills', goal: 50 }),
        A('combat', 'botkills_2',  'Wrecking Crew',   'Knock out 500 tanks in raids',             'crosshair', 3, { track: 'botkills', goal: 500 }),
        A('combat', 'streaker',    'Streaker',        'Get a 5 knockout streak',                  'fire', 3),
        A('combat', 'revenge',     'Payback',         'Knock out the player who last got you',    'revenge', 2),
        A('combat', 'crown_ko',    'Royal Pain',      'Knock out a player wearing a crown',       'crown', 3),
        A('combat', 'crown_steal', 'Finders Keepers', 'Steal a crown',                            'crownhand', 3),
        A('combat', 'boss_slayer', 'Boss Slayer',     'Land the final hit on a boss',             'sword', 3),
        A('combat', 'core_hit',    'Knock Knock',     'Land a hit on the Core',                   'core', 2),
        A('combat', 'core_break',  'Core Breaker',    'Land the final hit on the Core',           'core', 5, { item: 'ns_corebreaker', color: '#ff6a3d' }),

        // ---- Mining ----
        A('mining', 'rocks_1',      'Pebble Pusher',   'Break 300 rocks',                          'pick', 1, { track: 'rocks', goal: 300 }),
        A('mining', 'rocks_2',      'Rock Breaker',    'Break 3,000 rocks',                        'pick', 3, { track: 'rocks', goal: 3000 }),
        A('mining', 'rocks_3',      'Mountain Mover',  'Break 25,000 rocks',                       'pick', 4, { track: 'rocks', goal: 25000 }),
        A('mining', 'bi_sandstone', 'Struck Gold',     'Mine ore in the Sandstone Flats',          'biome', 1, { color: BIOME_UI.sandstone }),
        A('mining', 'bi_clay',      'Seeing Red',      'Break 100 rocks in the Red Clay Badlands', 'biome', 2, { color: BIOME_UI.clay, track: 'b_clay', goal: 100 }),
        A('mining', 'bi_moss',      'Moss Boss',       'Mine 25 ore rocks in the Mossy Hollows',   'biome', 2, { color: BIOME_UI.moss, track: 'bo_moss', goal: 25 }),
        A('mining', 'bi_crystal',   'Crystal Clear',   'Mine a purple shard in the Crystal Caves', 'biome', 2, { color: BIOME_UI.crystal }),
        A('mining', 'bi_magma',     'Hot Hands',       'Break 50 rocks in the Magma Veins',        'biome', 2, { color: BIOME_UI.magma, track: 'b_magma', goal: 50 }),
        A('mining', 'bi_obsidian',  'Deep Diver',      'Break a rock in the Obsidian Deep',        'biome', 2, { color: BIOME_UI.obsidian }),
        A('mining', 'ore_copper',   'Penny Pincher',   'Mine 50 copper ore rocks',                 'gem', 2, { color: ORE_UI.copper, track: 'ore1', goal: 50 }),
        A('mining', 'ore_vein',     'Feeling Blue',    'Mine an azurite vein',                     'gem', 1, { color: ORE_UI.vein }),
        A('mining', 'ore_shard',    'Purple Patch',    'Mine a purple shard',                      'gem', 2, { color: ORE_UI.shard }),
        A('mining', 'ore_emerald',  'Green With Envy', 'Mine an emerald, the rarest ore there is', 'gem', 3, { color: ORE_UI.emerald }),
        A('mining', 'emerald_eye',  'Emerald Eye',     'Grab 25 emeralds',                         'eye', 4, { color: ORE_UI.emerald, track: 'emeralds', goal: 25, solo: true }),
        A('mining', 'chain_blast',  'Chain Reaction',  'Break 3 rocks at once with Blast Rounds or Chain Spark', 'blast', 3),

        // ---- Banking ----
        A('banking', 'banker',      'Piggy Bank',  'Bank 10,000 gems',                     'vault', 2, { track: 'banked', goal: 10000 }),
        A('banking', 'bank_2',      'Banker',      'Bank 75,000 gems',                     'vault', 3, { track: 'banked', goal: 75000 }),
        A('banking', 'tycoon',      'Tycoon',      'Bank 250,000 gems',                    'tycoon', 4, { track: 'banked', goal: 250000 }),
        A('banking', 'fat_stack',   'Fat Stack',   'Bank 2,000 gems in one deposit',       'sack', 3),
        A('banking', 'close_call',  'Close Call',  'Finish a deposit with under 10% health', 'heart', 3),
        A('banking', 'flash_vault', 'In a Flash',  'Bank with a Flash Vault',              'flash', 2),
        A('banking', 'hoarder',     'Hoarder',     'Carry 3,000 gems at once',             'sack', 3),

        // ---- Tanks ----
        A('tanks', 'tank_t3',  'Big Guns',       'Reach a tier 3 tank',          'tank', 2, { track: 'tier', mode: 'max', goal: 2, solo: true }),
        A('tanks', 'tank_t4',  'Final Form',     'Reach a tier 4 tank',          'tank', 3, { track: 'tier', mode: 'max', goal: 3, solo: true }),
        A('tanks', 'tank_t5',  'Apex',           'Grow to 2x and reach a tier 5 tank', 'tank', 3, { track: 'tier', mode: 'max', goal: 4, solo: true }),
        A('tanks', 'tried_10', 'Test Driver',    'Try 10 different tanks',       'garage', 2, { track: 'tanks', mode: 'set', goal: 10 }),
        A('tanks', 'tried_25', 'Tank Collector', 'Try 25 different tanks',       'garage', 3, { track: 'tanks', mode: 'set', goal: 25 }),
        A('tanks', 'stat_max', 'Maxed Out',      'Max out a stat',               'stat', 2),
        A('tanks', 'grow_2',   'Heavyweight',    'Grow to twice your size',      'grow', 2, { track: 'size', mode: 'max', goal: 200 }),
        A('tanks', 'grow_4',   'Absolute Unit',  'Grow to four times your size', 'grow', 4, { track: 'size', mode: 'max', goal: 400 }),

        // ---- Abilities ----
        A('abilities', 'ab_grapple',     'Get Over Here',   'Use the Grapple Hook',  'hook', 1),
        A('abilities', 'ab_burrow',      'Mole Mode',       'Burrow underground',    'drill', 1),
        A('abilities', 'ab_shock',       'Personal Space',  'Set off a Shockwave',   'wave', 1),
        A('abilities', 'ab_radar',       'Ping!',           'Use a Radar Ping',      'radar', 1),
        A('abilities', 'ab_wall',        'Not Today',       'Put up a Barricade',    'wall', 1),
        A('abilities', 'ab_smoke',       'Now You See Me',  'Throw a Smoke Bomb',    'smoke', 1),
        A('abilities', 'ab_rush',        'Zoomies',         'Use Adrenaline',        'rush', 1),
        A('abilities', 'ab_pad',         'Liftoff',         'Drop a Launch Pad',     'pad', 1),
        A('abilities', 'ab_all',         'Swiss Army Tank', 'Use every ability',     'star', 3, { track: 'abils', mode: 'set', goal: 8, solo: true }),
        A('abilities', 'pad_kill',       'Air Mail',        'Knock out a tank you sent flying with your Launch Pad', 'pad', 4),
        A('abilities', 'grapple_escape', 'Great Escape',    'Grapple out on low health and live to tell it', 'hook', 3),
        A('abilities', 'fling_storm',    'Get Out',         'Shockwave a tank out into the storm', 'wave', 4),

        // ---- Raid ----
        A('raid', 'raid_survive', 'Still Standing',      'Be alive when a raid ends',          'shield', 2),
        A('raid', 'final_circle', 'Inner Circle',        'Make it to the final storm circle',  'ring', 2),
        A('raid', 'survivor',     'Survivor',            'Survive 15 minutes without dying',   'shield', 3),
        A('raid', 'chest_open',   'Treasure Hunter',     'Open a chest',                       'chest', 1),
        A('raid', 'podium',       'Podium',              'Finish a raid in the top 3',         'podium', 3),
        A('raid', 'champion',     'Champion',            'Win a raid',                         'cup', 4, { track: 'wins', goal: 1 }),
        A('raid', 'wins_2',       'Dynasty',             'Win 10 raids',                       'cup', 5, { track: 'wins', goal: 10 }),
        A('raid', 'crown_win',    'Heavy Is the Head',   'Wear a crown to the final bell',     'crown', 4, { item: 'ns_crownkeeper', color: '#ffd84d' }),
        A('raid', 'games_1',      'Regular',             'Play 25 games',                      'chevron', 2, { track: 'games', goal: 25 }),
        A('raid', 'games_2',      'Lifer',               'Play 100 games',                     'chevron', 3, { track: 'games', goal: 100 }),
        A('raid', 'veteran',      'Veteran',             'Play 250 games',                     'chevron', 4, { track: 'games', goal: 250 }),

        // ---- Secret: ??? until you stumble into them ----
        A('secret', 'rock_bottom',   'Rock Bottom',            'Get crushed by a rock growing back',             'rockdown', 2, { secret: true, item: 'ns_bedrock' }),
        A('secret', 'pacifist',      'Pacifist',               'Bank 2,000 gems in one life without hitting a tank', 'dove', 4, { secret: true, item: 'ns_olive' }),
        A('secret', 'tourist',       'Tourist',                'Mine in all 6 biomes in one raid',               'pin', 3, { secret: true }),
        A('secret', 'butterfingers', 'Butterfingers',          'Get knocked out carrying 1,000 gems or more',    'drop', 2, { secret: true }),
        A('secret', 'cookie_jar',    'Hand in the Cookie Jar', 'Get knocked out halfway through a deposit',     'jar', 2, { secret: true }),
        A('secret', 'forecast',      'Under the Weather',      'Get caught by the storm',                        'cloud', 1, { secret: true }),
        A('secret', 'yeet',          'Self Yeet',              'Shockwave yourself out into the storm',          'wave', 2, { secret: true }),
        A('secret', 'icarus',        'Icarus',                 'Get knocked out by the Core',                    'sun', 2, { secret: true }),
    ];

    // tiers: entries sharing a track, numbered I, II, III by goal (a track
    // with one entry, or marked solo, has no numeral)
    const byTrack = new Map();
    for (const a of RAW) {
        if (!a.track) continue;
        if (!byTrack.has(a.track)) byTrack.set(a.track, []);
        byTrack.get(a.track).push(a);
    }
    for (const list of byTrack.values()) {
        list.sort((x, y) => x.goal - y.goal);
        const tiered = list.filter(a => !a.solo);
        if (tiered.length > 1) tiered.forEach((a, i) => { a.tier = i + 1; });
    }

    (function validate() {
        const ids = new Set();
        for (const a of RAW) {
            const where = 'achievements: ' + a.id;
            if (!/^[a-z0-9_]{2,24}$/.test(a.id) || ids.has(a.id)) throw new Error(where + ' bad or duplicate id');
            ids.add(a.id);
            if (!CAT_BY_ID.has(a.cat)) throw new Error(where + ' bad cat');
            if (!(a.diff >= 1 && a.diff <= 5)) throw new Error(where + ' bad diff');
            if (a.track && !(a.goal > 0)) throw new Error(where + ' a track needs a goal');
            if (a.mode && ['add', 'max', 'set'].indexOf(a.mode) < 0) throw new Error(where + ' bad mode');
            if (/—|–/.test(a.name + a.desc)) throw new Error(where + ' no dashes in the copy');
        }
    })();

    const DEFS = Object.freeze(RAW.map(a => Object.freeze(Object.assign({
        goal: 1, mode: a.track ? 'add' : null, secret: false, item: null, tier: 0,
        color: CAT_BY_ID.get(a.cat).color, rewardMilli: DUST_MILLI[a.diff],
    }, a))));
    const BY_ID = new Map(DEFS.map(a => [a.id, a]));
    // track -> its entries, lowest goal first
    const TRACKS = new Map();
    for (const a of DEFS) {
        if (!a.track) continue;
        if (!TRACKS.has(a.track)) TRACKS.set(a.track, []);
        TRACKS.get(a.track).push(a);
    }
    for (const list of TRACKS.values()) list.sort((x, y) => x.goal - y.goal);

    const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
    function tierLabel(a) { return a && a.tier ? ROMAN[a.tier] || String(a.tier) : ''; }
    function byId(id) { return (typeof id === 'string' && BY_ID.get(id)) || null; }
    function catOf(id) { return CAT_BY_ID.get(id) || null; }
    // What the panel and the unlock card show for one achievement.
    function view(a) {
        return {
            id: a.id, cat: a.cat, name: a.name, desc: a.desc, icon: a.icon, color: a.color, tier: a.tier,
            goal: a.goal, secret: a.secret, rewardMilli: a.rewardMilli, item: a.item,
        };
    }
    // stage 0 of the newcomer HUD only raises First Steps; the rest wait
    function showsAtStage(a, stage) {
        if (!a) return false;
        return stage == null || stage >= 1 || a.cat === 'first';
    }

    return Object.freeze({
        CATS, DEFS, BY_ID, TRACKS, DUST_MILLI, ROMAN,
        byId, catOf, tierLabel, view, showsAtStage,
    });
});
