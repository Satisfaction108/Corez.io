// Cosmetics catalog, shared by the server (require) and the client (<script>
// served at /shared/cosmetics.js, exposes window.DWCosmetics). The server
// prices, rotates and validates from this table; the client draws from the
// same render params, so a new item is one entry here.
//
// Stability rules:
//   nid  the number on the wire (nameplate [25] name style, [27] skin, board
//        row `ns`). Never reused or renumbered: retire an item by setting
//        `retired: true`, never by deleting it. 0 always means "none".
//        Name styles use 1..99, skins 101..199.
//   id   the string stored in the database (owned_items, users.equip_*).
//   price in milli-dust (1 gemdust = 1000).
//   exclusive  never sold or gifted, only granted (invite rewards); price 0.
//
// Name style render params (item.style). The fill is a small baked tile
// laid over the text box as a pattern, so a name costs no allocation a frame.
//   kind   'solid'    one colour (Custom Color: the player's own hex)
//          'linear'   a static gradient across the text box, stops left->right
//          'vertical' a static gradient top->bottom (metals, soft two-tones)
//          'split'    a hard two-tone, stops[0] on top, stops[1] below
//          'scroll'   the stops scroll along the text (last stop = first, so
//                     it tiles), `speed` in text-widths per second
//          'prism'    full hue cycle scrolling along the text, `speed` as above
//   stops  hex colours (every one passes isColorAllowed)
//   shade  0..0.3, a subtle top-light / bottom-dark bevel over the fill
//   rim    the outline colour instead of the usual near-black (keep it dark)
//   halo   a soft outer ring in this colour (dropped with No Glow)
//   pulse  the halo breathes, cycles per second (legendary)
//   glint  a highlight rides along with the scroll (legendary)
//   glyph  suffix glyph drawn after the name (legendary), `glyphColor`
//
// Skin render params (item.skin)
//   pattern   the design (public/client/account/cosmetics.js PAINT)
//   seed      deterministic seed for the little randomness some designs use
//   scale     cell size as a fraction of the hull radius (grid designs)
//   angle / rivets / arms   per-design shape knobs
// emissive null, or {kind, speed (cycles per second)}
//
// Sidekicks (cat 'sidekick', nid 201..299): a tiny arras tank with a smiley
// face that follows its owner around a raid (server/game/terrain/sidekicks.js,
// drawn by public/client/sidekicks.js). item.kick is the look, read by
// public/client/sidekickArt.js:
//   body   circle | pumpkin | smasher (a spiky hexagon behind the circle)
//   col    body colour (the Locker colour replaces it)
//   guns   [degrees off the facing, length, width, aspect, side offset, kind],
//          in body radii like the game's mockups (a Basic barrel is
//          [0, 1.8, 0.8]); aspect > 1 widens toward the muzzle, < 1 narrows;
//          kind: '' | 'trap' (a trap lip on the end, shoots traps) |
//          'drone' (a spawner, shoots drones) | 'launch' (a launcher tube)
//   turret one small auto turret riding the back of the rim:
//          {at: degrees off the facing, r: its radius in body radii}
//   move   how it gets about (public/client/sidekickMath.js MOVES)
//   size   radius multiplier
// Every sidekick wears the same smiley; nothing in the catalog changes it.
// blurb is the shop line.
// Sidekick skins (cat 'sdSkin', nid 301..399): item.look = {fill}, a
// decoration for the body only (never the face or the barrels), in shades
// of the sidekick's own (or Locker) colour; like tank skins they never
// recolour it:
//   stripes | dots | twoTone | checker | camo | frost | gold | galaxy
// Sidekick name styles (cat 'sdName', nid 401..499): item.style = {kind,
// ...}, their own look, baked by sidekickArt.js bakeName:
//   sticker | bubbly | candy | pixel | sparkle
// rim is always the dark outermost line (like the player name styles).
// RETIRED lists sidekick items taken out of the catalog (their owners were
// refunded by migration v11); only kept for the purchase history's names.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWCosmetics = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CATALOG_VERSION = 2;
    const MILLI = 1000;

    const RARITIES = Object.freeze({
        common:    Object.freeze({ id: 'common',    name: 'Common',    order: 0, color: '#b4b8bd' }),
        uncommon:  Object.freeze({ id: 'uncommon',  name: 'Uncommon',  order: 1, color: '#5fd068' }),
        rare:      Object.freeze({ id: 'rare',      name: 'Rare',      order: 2, color: '#4aa3ff' }),
        epic:      Object.freeze({ id: 'epic',      name: 'Epic',      order: 3, color: '#b06bff' }),
        legendary: Object.freeze({ id: 'legendary', name: 'Legendary', order: 4, color: '#ffb23d' }),
    });
    const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

    const CATS = Object.freeze(['nameStyle', 'skin', 'sidekick', 'sdSkin', 'sdName']);
    // the categories that go on your own tank (the original shop rotation)
    const TANK_CATS = Object.freeze(['nameStyle', 'skin']);
    const SIDEKICK_CATS = Object.freeze(['sidekick', 'sdSkin', 'sdName']);
    const CUSTOM_COLOR_ID = 'ns_custom';
    const INVITE_STYLE_ID = 'ns_ringleader';
    const BASIC_SIDEKICK_ID = 'sd_buddy';

    function ns(nid, id, name, rarity, priceDust, style, extra) {
        return Object.assign({ nid, id, cat: 'nameStyle', name, rarity, price: Math.round(priceDust * MILLI), style }, extra || {});
    }
    // Tank skin pattern colours: [main, alternate]
    const SKIN_SWATCHES = Object.freeze({
        gold:     Object.freeze(['#ffc665', '#b47a26']),
        orange:   Object.freeze(['#ef8a4c', '#a8502a']),
        red:      Object.freeze(['#f0505f', '#9e2f3d']),
        lava:     Object.freeze(['#f26a3a', '#ffc665']),
        copper:   Object.freeze(['#e0965a', '#9a5a2e']),
        sapphire: Object.freeze(['#3b7ce0', '#a9cdf7']),
        ice:      Object.freeze(['#cdeeff', '#4f97c8']),
        teal:     Object.freeze(['#6ecedc', '#2f8f9c']),
        emerald:  Object.freeze(['#4fc08a', '#1f7a4c']),
        purple:   Object.freeze(['#9673e8', '#5d3fae']),
        amethyst: Object.freeze(['#b46ee0', '#6a3496']),
        void:     Object.freeze(['#3d2a5c', '#8e6ad6']),
        pink:     Object.freeze(['#ef99c3', '#b0457f']),
        white:    Object.freeze(['#f2f2f2', '#8f8c9a']),
        ghost:    Object.freeze(['#e2dcf5', '#7a6fa0']),
        steel:    Object.freeze(['#c4c6d0', '#6f7180']),
        slate:    Object.freeze(['#4a4658', '#8a86a0']),
        stone:    Object.freeze(['#9a93ab', '#5c566b']),
        ink:      Object.freeze(['#26232e', '#5a5666']),
    });
    const SKIN_NEAR = 110;    // colorDistance under which a swatch swaps shade

    function sk(nid, id, name, rarity, priceDust, skin) {
        return { nid, id, cat: 'skin', name, rarity, price: Math.round(priceDust * MILLI), skin };
    }
    function sd(nid, id, name, rarity, priceDust, kick, blurb, extra) {
        return Object.assign({ nid, id, cat: 'sidekick', name, rarity, price: Math.round(priceDust * MILLI), kick, blurb }, extra || {});
    }
    function lv(item, level) { return Object.assign(item, { exclusive: true, lvl: level }); }
    function sds(nid, id, name, rarity, priceDust, look, blurb) {
        return { nid, id, cat: 'sdSkin', name, rarity, price: Math.round(priceDust * MILLI), look, blurb };
    }
    function sdn(nid, id, name, rarity, priceDust, style, blurb) {
        return { nid, id, cat: 'sdName', name, rarity, price: Math.round(priceDust * MILLI), style, blurb };
    }
    // n equal barrels spaced round the body
    function ring(n, len, wid, start) {
        const out = [];
        for (let i = 0; i < n; i++) out.push([(start || 0) + i * 360 / n, len, wid, 1, 0]);
        return out;
    }

    // what the sidekick art knows how to draw (sidekickArt.js)
    const BODIES = Object.freeze({ circle: 1, pumpkin: 1, smasher: 1 });
    const GUN_KINDS = Object.freeze({ trap: 1, drone: 1, launch: 1 });
    const SKIN_FILLS = Object.freeze({ stripes: 1, dots: 1, twoTone: 1, checker: 1, camo: 1, frost: 1, gold: 1, galaxy: 1 });
    const NAME_KINDS = Object.freeze({ sticker: 1, bubbly: 1, candy: 1, pixel: 1, sparkle: 1 });
    const INK_RIM = '#120e15';   // the HUD ink
    // Sidekick items that were in an earlier catalog (refunded by migrations
    // v11 and v16, accounts/migrations.js), by id: their names for old receipts.
    const RETIRED = Object.freeze({
        sd_squint: 'Squint', sd_boxer: 'Boxer', sd_pebble: 'Pebble', sd_sprout: 'Sprout', sd_bubbles: 'Bubbles', sd_chip: 'Chip',
        sd_prickles: 'Prickles', sd_robo: 'Robo', sd_frosty: 'Frosty', sd_candy: 'Candy Twin', sd_drillbit: 'Drillbit',
        sd_spooky: 'Spooky', sd_shardy: 'Shardy', sd_hothead: 'Hothead', sd_clank: 'Sir Clank', sd_buzz: 'Buzz',
        sd_majesty: 'Your Majesty', sd_disco: 'Disco', sd_drako: 'Drako', sd_astro: 'Astro', sd_twinkle: 'Twinkle', sd_ember: 'Ember',
        sds_shades: 'Cool Shades', sds_sleepy: 'Sleepy', sds_blush: 'Blushing', sds_hearts: 'Heart Eyes', sds_wink: 'Cheeky',
        sds_grumpy: 'Grumpy', sds_starry: 'Starstruck', sds_party: 'Party Hat',
        sdn_bubble: 'Bubble', sdn_lemonade: 'Lemonade', sdn_mint: 'Minty', sdn_berry: 'Berry', sdn_sunbeam: 'Sunbeam', sdn_starlight: 'Starlight',
        sdn_sticker: 'Sticker', sdn_bubbly: 'Bubbly', sdn_candy: 'Candy', sdn_pixel: 'Pixel', sdn_sparkle: 'Sparkle',
    });

    const RAW = [
        // ---- name styles (nid 1..99) ----
        ns(1, CUSTOM_COLOR_ID, 'Custom Color', 'common', 8,
            { kind: 'solid', stops: ['#ffffff'], custom: true },
            { permanent: true }),
        ns(2, 'ns_sunset', 'Sunset', 'common', 25,
            { kind: 'linear', stops: ['#ffb347', '#ff6a5c', '#c850c0'], shade: 0.12 }),
        ns(3, 'ns_copper_vein', 'Copper Vein', 'common', 30,
            { kind: 'vertical', stops: ['#ffd0a1', '#e08a4f', '#c26a35'], rim: '#3a1a08' }),
        ns(4, 'ns_glacier', 'Glacier', 'common', 35,
            { kind: 'linear', stops: ['#e8f8ff', '#8fd3ff', '#4aa8ff'], shade: 0.12 }),
        ns(15, 'ns_frost', 'Frost', 'common', 25,
            { kind: 'vertical', stops: ['#ffffff', '#bfe9ff'], rim: '#0f2a40' }),
        ns(16, 'ns_lemon', 'Lemon', 'common', 25,
            { kind: 'vertical', stops: ['#fff49a', '#ffd23f'], rim: '#3d2c00' }),
        ns(17, 'ns_coral', 'Coral', 'common', 30,
            { kind: 'vertical', stops: ['#ffc2b3', '#ff7361'], rim: '#40130c' }),
        ns(18, 'ns_lilac', 'Lilac', 'common', 30,
            { kind: 'vertical', stops: ['#efe3ff', '#b996ff'], rim: '#24154a' }),
        ns(19, 'ns_seafoam', 'Seafoam', 'common', 30,
            { kind: 'linear', stops: ['#c4fff0', '#5fe3c0'], shade: 0.12, rim: '#0b3329' }),
        ns(20, 'ns_ash', 'Ash', 'common', 25,
            { kind: 'vertical', stops: ['#ece6e0', '#b0a79e'], rim: '#28221d' }),

        ns(5, 'ns_candy', 'Candy', 'uncommon', 40,
            { kind: 'linear', stops: ['#ff8fcf', '#ffd1ec', '#8fd8ff'], shade: 0.12 }),
        ns(6, 'ns_mint_rush', 'Mint Rush', 'uncommon', 45,
            { kind: 'linear', stops: ['#b6ffe6', '#3ee6a0', '#7dffcb'], shade: 0.12 }),
        ns(21, 'ns_bubblegum', 'Bubblegum', 'uncommon', 40,
            { kind: 'split', stops: ['#ffd6ee', '#ff7ac8'], rim: '#4a0f33' }),
        ns(22, 'ns_tangerine', 'Tangerine', 'uncommon', 40,
            { kind: 'split', stops: ['#ffd899', '#ff8a2a'], rim: '#3f1a00' }),
        ns(23, 'ns_lagoon', 'Lagoon', 'uncommon', 45,
            { kind: 'linear', stops: ['#8ff5ff', '#4a9dff', '#8ff5ff'], shade: 0.14, rim: '#07234a' }),
        ns(24, 'ns_peach', 'Peach', 'uncommon', 40,
            { kind: 'vertical', stops: ['#ffe6cc', '#ff9e7a'], rim: '#4a1f10' }),
        ns(25, 'ns_lime_soda', 'Lime Soda', 'uncommon', 45,
            { kind: 'split', stops: ['#f4ffb0', '#a0f542'], rim: '#1f3a00' }),
        ns(26, 'ns_clear_sky', 'Clear Sky', 'uncommon', 45,
            { kind: 'vertical', stops: ['#ffffff', '#7ad3ff'], rim: '#0d2e57' }),

        ns(7, 'ns_ember', 'Ember', 'rare', 50,
            { kind: 'linear', stops: ['#ffd35c', '#ff8a3d', '#ff5040'], shade: 0.14, rim: '#3a0d05' }),
        ns(8, 'ns_amethyst', 'Amethyst', 'rare', 60,
            { kind: 'vertical', stops: ['#f0dcff', '#b07aff', '#8c5cff'], rim: '#1e0f3d' }),
        ns(9, 'ns_toxic', 'Toxic', 'rare', 65,
            { kind: 'linear', stops: ['#e2ff5c', '#7dff3d', '#3dffa0'], shade: 0.12, rim: '#0d2e0a', halo: '#6dff3d' }),
        ns(27, 'ns_gold', 'Gold', 'rare', 60,
            { kind: 'vertical', stops: ['#fff4b8', '#ffd23f', '#e09b16'], rim: '#422600' }),
        ns(28, 'ns_silver', 'Silver', 'rare', 55,
            { kind: 'vertical', stops: ['#ffffff', '#dfe4ea', '#9eaab7'], rim: '#1c232b' }),
        ns(29, 'ns_sapphire', 'Sapphire', 'rare', 60,
            { kind: 'vertical', stops: ['#d4ecff', '#6fa8ff', '#4a7dff'], rim: '#0a1a45' }),
        ns(30, 'ns_ruby', 'Ruby', 'rare', 60,
            { kind: 'vertical', stops: ['#ffd1d8', '#ff6b85', '#ff4060'], rim: '#420010' }),
        ns(31, 'ns_neon', 'Neon', 'rare', 65,
            { kind: 'vertical', stops: ['#f6ffd6', '#b8ff4a', '#86f23a'], rim: '#122900', halo: '#9dff3d' }),
        ns(32, 'ns_crimson', 'Crimson', 'rare', 55,
            { kind: 'split', stops: ['#ffa3a3', '#f0404a'], rim: '#360006' }),

        ns(10, 'ns_magma_flow', 'Magma Flow', 'epic', 110,
            { kind: 'scroll', stops: ['#ff4a24', '#ff9a1f', '#ffd84d', '#ff9a1f', '#ff4a24'], speed: 0.35, shade: 0.14, rim: '#380a00' }),
        ns(11, 'ns_aurora', 'Aurora', 'epic', 125,
            { kind: 'scroll', stops: ['#4dffb8', '#4dc3ff', '#b88cff', '#4dc3ff', '#4dffb8'], speed: 0.25, shade: 0.12, rim: '#0d1f33' }),
        ns(33, 'ns_storm', 'Storm', 'epic', 115,
            { kind: 'scroll', stops: ['#d6ecff', '#ffffff', '#7ab8ff', '#d6ecff'], speed: 0.3, shade: 0.12, rim: '#0b1d3a', halo: '#5aa4ff' }),
        ns(34, 'ns_wildfire', 'Wildfire', 'epic', 110,
            { kind: 'vertical', stops: ['#fff3a8', '#ff9a2a', '#ff4a24'], rim: '#3a0800', halo: '#ff6a2a' }),
        ns(35, 'ns_vaporwave', 'Vaporwave', 'epic', 120,
            { kind: 'scroll', stops: ['#ff7ad9', '#7ad3ff', '#b98cff', '#ff7ad9'], speed: 0.22, shade: 0.12, rim: '#2a0d3d' }),
        ns(36, 'ns_wraith', 'Wraith', 'epic', 115,
            { kind: 'vertical', stops: ['#ffe0f7', '#ff7ae0', '#e050c8'], rim: '#330a2e', halo: '#e050c8' }),
        ns(37, 'ns_warden', 'Warden', 'epic', 110,
            { kind: 'scroll', stops: ['#ffe29a', '#fff8e6', '#ffbf3d', '#ffe29a'], speed: 0.22, shade: 0.14, rim: '#3d2200', halo: '#ffb23d' }),
        ns(38, 'ns_geode', 'Geode', 'epic', 125,
            { kind: 'scroll', stops: ['#c9a4ff', '#7ae0ff', '#e8fbff', '#7ae0ff', '#c9a4ff'], speed: 0.28, shade: 0.12, rim: '#1d1240' }),

        ns(12, 'ns_emerald_crown', 'Emerald Crown', 'legendary', 240,
            { kind: 'scroll', stops: ['#1fd67a', '#7dffb6', '#ffd84d', '#7dffb6', '#1fd67a'], speed: 0.3, shade: 0.12,
              rim: '#062e18', glint: true, glyph: '♛', glyphColor: '#ffd84d' }),
        ns(13, 'ns_prism_shard', 'Prism Shard', 'legendary', 250,
            { kind: 'prism', stops: ['#ff6b6b', '#ffd84d', '#6bff8f', '#6bd8ff', '#b88cff', '#ff6b6b'], speed: 0.4,
              saturation: 0.85, lightness: 0.7, shade: 0.1, glint: true, glyph: '◆', glyphColor: '#ffffff' }),
        ns(39, 'ns_supernova', 'Supernova', 'legendary', 250,
            { kind: 'vertical', stops: ['#ffffff', '#fff0a8', '#ffc23d'], rim: '#4a2600', halo: '#ffb23d', pulse: 0.5,
              glyph: '★', glyphColor: '#ffe07a' }),
        ns(40, 'ns_void', 'Void', 'legendary', 240,
            { kind: 'scroll', stops: ['#d9c7ff', '#8f66ff', '#f0e8ff', '#8f66ff', '#d9c7ff'], speed: 0.2, shade: 0.12,
              rim: '#140833', halo: '#8a5cff', pulse: 0.35, glyph: '◈', glyphColor: '#c9b3ff' }),
        // invite reward (3 friends): a fast copper-to-violet loop with a hot
        // cream core and a quick glint, so it reads as live even when small
        ns(14, 'ns_ringleader', 'Ringleader', 'legendary', 0,
            { kind: 'scroll', stops: ['#ff8a3d', '#ffd166', '#fff1c9', '#ff5fa2', '#c77dff', '#ff5fa2', '#ff8a3d'], speed: 0.55,
              shade: 0.1, rim: '#2e0d1f', glint: true, glyph: '✦', glyphColor: '#ffd166' },
            { exclusive: true }),
        // achievement rewards (shared/achievements.js `item`): never sold,
        // granted with the achievement (`earn` names it for the Locker)
        ns(41, 'ns_corebreaker', 'Corebreaker', 'legendary', 0,
            { kind: 'scroll', stops: ['#ff6a3d', '#ffd166', '#fff3d6', '#ffd166', '#ff6a3d'], speed: 0.45, shade: 0.12,
              rim: '#3a0d00', halo: '#ff6a3d', glyph: '⬢', glyphColor: '#ffd166' },
            { exclusive: true, earn: 'core_break' }),
        ns(42, 'ns_crownkeeper', 'Crown Keeper', 'epic', 0,
            { kind: 'vertical', stops: ['#fff6c2', '#ffd84d', '#e0a516'], rim: '#3d2600', halo: '#ffd84d', glyph: '♛', glyphColor: '#ffe680' },
            { exclusive: true, earn: 'crown_win' }),
        ns(43, 'ns_bedrock', 'Bedrock', 'rare', 0,
            { kind: 'split', stops: ['#d6d0c8', '#8f877e'], shade: 0.18, rim: '#1f1b17' },
            { exclusive: true, earn: 'rock_bottom' }),
        ns(44, 'ns_olive', 'Olive Branch', 'epic', 0,
            { kind: 'vertical', stops: ['#f2ffe0', '#b9e07a', '#7fae45'], rim: '#1c2e08', halo: '#b9e07a' },
            { exclusive: true, earn: 'pacifist' }),
        ns(45, 'ns_lv_sprout', 'Sprout', 'common', 0,
            { kind: 'vertical', stops: ['#eaffd6', '#8fe36a'], rim: '#173d0a' },
            { exclusive: true, lvl: 3 }),
        ns(46, 'ns_lv_deep', 'Deep Diver', 'epic', 0,
            { kind: 'scroll', stops: ['#8fe0ff', '#4a8fff', '#d6f6ff', '#4a8fff', '#8fe0ff'], speed: 0.25, shade: 0.12, rim: '#071a3a', halo: '#4a8fff' },
            { exclusive: true, lvl: 20 }),
        ns(47, 'ns_lv_ore', 'Ore Glow', 'rare', 0,
            { kind: 'vertical', stops: ['#fff1c9', '#ffb347', '#f08a3a'], rim: '#3a1d00', halo: '#ffb347' },
            { exclusive: true, lvl: 33 }),
        ns(48, 'ns_lv_sunforge', 'Sunforge', 'epic', 0,
            { kind: 'scroll', stops: ['#ffe07a', '#ff9a3d', '#fff6d6', '#ff9a3d', '#ffe07a'], speed: 0.3, shade: 0.12, rim: '#3d1a00', halo: '#ffb23d' },
            { exclusive: true, lvl: 43 }),
        ns(49, 'ns_lv_legend', 'Legend', 'legendary', 0,
            { kind: 'prism', stops: ['#ff6b6b', '#ffd84d', '#6bff8f', '#6bd8ff', '#b88cff', '#ff6b6b'], speed: 0.5,
              saturation: 0.9, lightness: 0.72, shade: 0.1, glint: true, halo: '#ffd84d', pulse: 0.4, glyph: '✪', glyphColor: '#ffe680' },
            { exclusive: true, lvl: 50 }),
        ns(50, 'ns_lv_plasma', 'Plasma Core', 'rare', 0,
            { kind: 'linear', stops: ['#a8f5ff', '#5cc8ff', '#a88cff'], shade: 0.12, rim: '#0a1838', halo: '#5cc8ff' },
            { exclusive: true, lvl: 53 }),
        ns(51, 'ns_lv_nebula', 'Nebula', 'epic', 0,
            { kind: 'scroll', stops: ['#ff85e4', '#a685ff', '#6be5ff', '#a685ff', '#ff85e4'], speed: 0.3, shade: 0.12, rim: '#1d0a38', halo: '#b88cff' },
            { exclusive: true, lvl: 63 }),
        ns(52, 'ns_lv_solar', 'Solar Flare', 'epic', 0,
            { kind: 'scroll', stops: ['#fff4b8', '#ffb347', '#ff5e4d', '#ffb347', '#fff4b8'], speed: 0.38, shade: 0.12, rim: '#380d00', halo: '#ff8a3d' },
            { exclusive: true, lvl: 73 }),
        ns(53, 'ns_lv_celestial', 'Celestial', 'legendary', 0,
            { kind: 'scroll', stops: ['#ffffff', '#a8f0ff', '#ffd84d', '#a8f0ff', '#ffffff'], speed: 0.35, shade: 0.1,
              rim: '#0a1f3d', glint: true, halo: '#8fd8ff', pulse: 0.35, glyph: '✦', glyphColor: '#ffe680' },
            { exclusive: true, lvl: 83 }),
        ns(54, 'ns_lv_overlord', 'Overlord', 'legendary', 0,
            { kind: 'prism', stops: ['#ff6b6b', '#ffd84d', '#6bff8f', '#6bd8ff', '#b88cff', '#ff6b6b'], speed: 0.65,
              saturation: 0.92, lightness: 0.74, shade: 0.1, glint: true, halo: '#ffd84d', pulse: 0.45, glyph: '♛', glyphColor: '#fff099' },
            { exclusive: true, lvl: 100 }),

        // ---- skins (nid 101..199) ----
        sk(101, 'sk_hazard_stripes', 'Hazard Stripes', 'common', 35,
            { pattern: 'stripes', seed: 1101, colors: ['gold', 'ink'], scale: 0.3, angle: 90, emissive: null }),
        sk(102, 'sk_riveted_plate', 'Riveted Plate', 'common', 35,
            { pattern: 'rim', seed: 1102, colors: ['steel', 'gold'], rivets: 8, emissive: null }),
        sk(113, 'sk_racer', 'Racer', 'common', 30,
            { pattern: 'racer', seed: 1113, colors: ['white', 'red'], emissive: null }),
        sk(114, 'sk_split', 'Split', 'common', 30,
            { pattern: 'halves', seed: 1114, colors: ['white', 'ink'], emissive: null }),
        sk(115, 'sk_bullseye', 'Bullseye', 'common', 35,
            { pattern: 'rings', seed: 1115, colors: ['red', 'white'], emissive: null }),
        sk(116, 'sk_polka', 'Polka', 'common', 30,
            { pattern: 'dots', seed: 1116, colors: ['white'], scale: 0.56, emissive: null }),
        sk(117, 'sk_checkers', 'Checkers', 'common', 35,
            { pattern: 'checker', seed: 1117, colors: ['white', 'ink'], scale: 0.5, emissive: null }),
        sk(118, 'sk_pip', 'Pip', 'common', 30,
            { pattern: 'core', seed: 1118, colors: ['gold'], emissive: null }),
        sk(119, 'sk_sash', 'Sash', 'common', 30,
            { pattern: 'sash', seed: 1119, colors: ['red', 'gold'], angle: -35, emissive: null }),

        sk(103, 'sk_cave_camo', 'Cave Camo', 'uncommon', 65,
            { pattern: 'camo', seed: 1103, colors: ['emerald', 'copper'], emissive: null }),
        sk(104, 'sk_strata', 'Strata', 'uncommon', 65,
            { pattern: 'strata', seed: 1104, colors: ['copper', 'gold'], emissive: null }),
        sk(105, 'sk_hex_armor', 'Hex Armor', 'uncommon', 65,
            { pattern: 'hex', seed: 1105, colors: ['steel', 'sapphire'], scale: 0.36, emissive: null }),
        sk(120, 'sk_chevron', 'Chevron', 'uncommon', 60,
            { pattern: 'chevrons', seed: 1120, colors: ['orange', 'gold'], emissive: null }),
        sk(121, 'sk_copper_trim', 'Copper Trim', 'uncommon', 70,
            { pattern: 'trim', seed: 1121, colors: ['copper'], rivets: 6, emissive: null }),
        sk(122, 'sk_sunburst', 'Sunburst', 'uncommon', 70,
            { pattern: 'sunburst', seed: 1122, colors: ['gold', 'orange'], emissive: null }),
        sk(123, 'sk_quarters', 'Quarters', 'uncommon', 60,
            { pattern: 'quarters', seed: 1123, colors: ['white'], emissive: null }),
        sk(124, 'sk_pinwheel', 'Pinwheel', 'uncommon', 70,
            { pattern: 'pinwheel', seed: 1124, colors: ['pink', 'gold', 'white'], emissive: null }),
        sk(125, 'sk_tiger', 'Tiger', 'uncommon', 75,
            { pattern: 'tiger', seed: 1125, colors: ['orange', 'ink'], emissive: null }),

        sk(106, 'sk_drill_circuit', 'Drill Circuit', 'rare', 125,
            { pattern: 'circuit', seed: 1106, colors: ['teal', 'gold', 'ink'], emissive: { kind: 'pulse', speed: 0.6 } }),
        sk(107, 'sk_crystal_facets', 'Crystal Facets', 'rare', 125,
            { pattern: 'facets', seed: 1107, colors: ['ice'], emissive: { kind: 'twinkle', speed: 0.9 } }),
        sk(108, 'sk_gold_vein', 'Gold Vein', 'rare', 125,
            { pattern: 'vein', seed: 1108, colors: ['gold'], emissive: { kind: 'shimmer', every: 3 } }),
        sk(126, 'sk_sapphire', 'Sapphire', 'rare', 130,
            { pattern: 'gem', seed: 1126, colors: ['sapphire'], emissive: { kind: 'twinkle', speed: 0.8 } }),
        sk(127, 'sk_amethyst', 'Amethyst', 'rare', 130,
            { pattern: 'geode', seed: 1127, colors: ['amethyst'], emissive: { kind: 'twinkle', speed: 0.8 } }),
        sk(128, 'sk_storm_front', 'Storm Front', 'rare', 120,
            { pattern: 'bolt', seed: 1128, colors: ['gold', 'purple'], emissive: { kind: 'flash', speed: 0.3 } }),
        sk(129, 'sk_cyclone', 'Cyclone', 'rare', 120,
            { pattern: 'spiral', seed: 1129, colors: ['teal', 'white'], arms: 4, emissive: { kind: 'spin', speed: 0.3 } }),
        sk(130, 'sk_crosshair', 'Crosshair', 'rare', 110,
            { pattern: 'crosshair', seed: 1130, colors: ['red', 'white'], emissive: { kind: 'spin', speed: 0.08 } }),
        sk(131, 'sk_warden', 'Warden', 'rare', 140,
            { pattern: 'vault', seed: 1131, colors: ['steel', 'gold'], emissive: { kind: 'spin', speed: 0.06 } }),

        sk(109, 'sk_lava_cracks', 'Lava Cracks', 'epic', 250,
            { pattern: 'cracks', seed: 1109, colors: ['lava', 'gold'], emissive: { kind: 'pulse', speed: 0.6 } }),
        sk(110, 'sk_permafrost', 'Permafrost', 'epic', 250,
            { pattern: 'frost', seed: 1110, colors: ['ice', 'white'], emissive: { kind: 'twinkle', speed: 0.9 } }),
        sk(132, 'sk_drillhead', 'Drillhead', 'epic', 240,
            { pattern: 'drill', seed: 1132, colors: ['steel', 'gold'], emissive: { kind: 'spin', speed: 0.25 } }),
        sk(133, 'sk_geode', 'Geode', 'epic', 250,
            { pattern: 'druse', seed: 1133, colors: ['copper', 'teal'], emissive: { kind: 'twinkle', speed: 0.8 } }),
        sk(134, 'sk_wraith', 'Wraith', 'epic', 240,
            { pattern: 'shards', seed: 1134, colors: ['ghost', 'purple'], emissive: { kind: 'spiral', speed: 0.3 } }),
        sk(135, 'sk_thunderhead', 'Thunderhead', 'epic', 260,
            { pattern: 'storm', seed: 1135, colors: ['white', 'gold'], emissive: { kind: 'flash', speed: 0.3 } }),
        sk(136, 'sk_gilded', 'Gilded', 'epic', 260,
            { pattern: 'gilded', seed: 1136, colors: ['gold', 'white'], emissive: { kind: 'shimmer', every: 3 } }),

        sk(111, 'sk_emerald_heart', 'Emerald Heart', 'legendary', 500,
            { pattern: 'heart', seed: 1111, colors: ['emerald', 'gold'], emissive: { kind: 'shimmer', every: 2.6 } }),
        sk(112, 'sk_molten_core', 'Molten Core', 'legendary', 500,
            { pattern: 'molten', seed: 1112, colors: ['lava', 'gold'], arms: 3, emissive: { kind: 'spiral', speed: 0.4 } }),
        sk(137, 'sk_aurora', 'Aurora', 'legendary', 480,
            { pattern: 'aurora', seed: 1137, colors: ['teal', 'emerald', 'purple'], emissive: { kind: 'shift', speed: 0.12, spin: 0.03 } }),
        sk(138, 'sk_prism', 'Prism', 'legendary', 500,
            { pattern: 'prism', seed: 1138, colors: ['pink', 'gold', 'teal'], emissive: { kind: 'shimmer', every: 3, spin: 0.05 } }),
        sk(139, 'sk_supernova', 'Supernova', 'legendary', 480,
            { pattern: 'nova', seed: 1139, colors: ['gold', 'orange'], emissive: { kind: 'pulse', speed: 0.45, spin: 0.04 } }),
        sk(140, 'sk_void', 'Void', 'legendary', 450,
            { pattern: 'void', seed: 1140, colors: ['void', 'amethyst', 'ghost'], emissive: { kind: 'spiral', speed: 0.3 } }),
        lv(sk(141, 'sk_lv_pumpkin', 'Pumpkin', 'common', 0,
            { pattern: 'pumpkin', seed: 1141, colors: ['orange', 'ink'], emissive: null }), 8),
        lv(sk(142, 'sk_lv_coil', 'Copper Coil', 'uncommon', 0,
            { pattern: 'spiral', seed: 1142, colors: ['copper', 'gold'], arms: 3, emissive: null }), 16),
        lv(sk(143, 'sk_lv_crust', 'Geode Crust', 'rare', 0,
            { pattern: 'facets', seed: 1143, colors: ['amethyst'], emissive: { kind: 'twinkle', speed: 0.9 } }), 27),
        lv(sk(144, 'sk_lv_magma', 'Magma Vein', 'epic', 0,
            { pattern: 'vein', seed: 1144, colors: ['lava'], emissive: { kind: 'pulse', speed: 0.5 } }), 30),
        lv(sk(145, 'sk_lv_starforged', 'Starforged', 'legendary', 0,
            { pattern: 'nova', seed: 1145, colors: ['white', 'sapphire'], emissive: { kind: 'pulse', speed: 0.4, spin: 0.04 } }), 40),
        lv(sk(146, 'sk_lv_cobalt', 'Cobalt Ward', 'rare', 0,
            { pattern: 'vault', seed: 1146, colors: ['sapphire', 'white'], emissive: { kind: 'spin', speed: 0.06 } }), 60),
        lv(sk(147, 'sk_lv_tempest', 'Tempest', 'epic', 0,
            { pattern: 'storm', seed: 1147, colors: ['teal', 'gold'], emissive: { kind: 'flash', speed: 0.35 } }), 70),
        lv(sk(148, 'sk_lv_abyssal', 'Abyssal Core', 'epic', 0,
            { pattern: 'molten', seed: 1148, colors: ['amethyst', 'teal'], arms: 3, emissive: { kind: 'spiral', speed: 0.35 } }), 80),
        lv(sk(149, 'sk_lv_astral', 'Astral Crown', 'legendary', 0,
            { pattern: 'aurora', seed: 1149, colors: ['gold', 'teal', 'purple'], emissive: { kind: 'shift', speed: 0.15, spin: 0.03 } }), 90),
        lv(sk(150, 'sk_lv_eternal', 'Eternal Sovereign', 'legendary', 0,
            { pattern: 'prism', seed: 1150, colors: ['gold', 'white', 'emerald'], emissive: { kind: 'shimmer', every: 2.2, spin: 0.05 } }), 93),

        // ---- sidekicks (nid 201..299): plain arras tanks, one smiley each ----
        sd(201, BASIC_SIDEKICK_ID, 'Buddy', 'common', 20,
            { body: 'circle', col: '#7ed957', guns: [[0, 1.8, 0.8]], move: 'orbit' },
            'A pocket Basic with one barrel and a big grin. It’s always in the shop.', { permanent: true }),
        sd(202, 'sd_twinny', 'Twinny', 'common', 35,
            { body: 'circle', col: '#4fc3f7', guns: [[0, 1.9, 0.75, 1, 0.5], [0, 1.9, 0.75, 1, -0.5]], move: 'sway' },
            'A tiny Twin that waves both of its barrels around.'),
        sd(204, 'sd_flanky', 'Flanky', 'common', 35,
            { body: 'circle', col: '#ff9f43', guns: [[0, 1.8, 0.8], [180, 1.6, 0.8]], move: 'orbitBack' },
            'A little Flank Guard that watches your back, and your front too.'),
        sd(231, 'sd_bonk', 'Bonk', 'common', 40,
            { body: 'circle', col: '#b48cff', guns: [[0, 1.8, 1.1]], move: 'hover' },
            'A pocket Pounder with one fat barrel that’s all bark.'),
        sd(232, 'sd_sprinkles', 'Sprinkles', 'common', 40,
            { body: 'circle', col: '#ff8fab', guns: [[0, 1.55, 0.85, 1.45]], move: 'sway' },
            'A mini Machine Gun that sprays happiness everywhere.'),
        sd(233, 'sd_trappy', 'Trappy', 'common', 45,
            { body: 'circle', col: '#d9a066', guns: [[0, 1.8, 0.75, 1, 0, 'trap']], move: 'orbit' },
            'A tiny Trapper whose traps never catch anything.'),

        sd(234, 'sd_zippy', 'Zippy', 'uncommon', 75,
            { body: 'circle', col: '#ff6b6b', guns: [[0, 1.8, 0.8], [150, 1.55, 0.8], [210, 1.55, 0.8]], move: 'zip' },
            'A little Tri-Angle that laps you just because it can.'),
        sd(235, 'sd_trio', 'Trio', 'uncommon', 80,
            { body: 'circle', col: '#ffc857', guns: [[0, 1.75, 0.7, 1, 0.48], [0, 1.75, 0.7, 1, -0.48], [0, 2.05, 0.7]], move: 'hover' },
            'A pocket Triplet with three barrels all pointing the same way.'),
        sd(236, 'sd_quaddy', 'Quaddy', 'uncommon', 80,
            { body: 'circle', col: '#6f9bff', guns: ring(4, 1.75, 0.75), move: 'spin' },
            'A mini Quad Tank that covers every side at once.'),
        sd(210, 'sd_octo', 'Mini Octo', 'uncommon', 90,
            { body: 'circle', col: '#ff7a8a', guns: ring(8, 1.6, 0.62), move: 'spin' },
            'It has eight barrels and absolutely no aim.'),
        sd(211, 'sd_rocket', 'Rocket', 'uncommon', 95,
            { body: 'circle', col: '#eef3f8', guns: [[0, 1.95, 0.95, 1, 0, 'launch']], move: 'zip' },
            'A little Rocketeer with a launcher on top that fires confetti.'),

        sd(224, 'sd_bossy', 'Bossy', 'rare', 140,
            { body: 'circle', col: '#2dd4bf', guns: [[90, 1.45, 0.9, 1.35, 0, 'drone'], [-90, 1.45, 0.9, 1.35, 0, 'drone']], move: 'orbit' },
            'A tiny Overseer that bosses the air around.'),
        sd(237, 'sd_boomer', 'Boomer', 'rare', 130,
            { body: 'circle', col: '#9b7bff', guns: [[0, 1.85, 1.4]], move: 'hover' },
            'A mini Destroyer with a huge barrel and a gentle soul.'),
        sd(238, 'sd_hexie', 'Hexie', 'rare', 150,
            { body: 'circle', col: '#7adbba', guns: ring(6, 1.7, 0.7), move: 'spin' },
            'A little Hexa Tank with six barrels and a spin move.'),
        sd(217, 'sd_jack', 'Jack', 'legendary', 650,
            { body: 'pumpkin', col: '#ff8a1f', guns: [[0, 1.75, 0.8]], move: 'bounce' },
            'A pumpkin tank with a stem on top that grins all year round.'),

        sd(239, 'sd_smashy', 'Smashy', 'epic', 280,
            { body: 'smasher', col: '#a3e635', guns: [], move: 'orbit' },
            'A pocket Smasher with no barrels, just spikes and hugs.'),
        sd(240, 'sd_otto', 'Otto', 'epic', 270,
            { body: 'circle', col: '#ff7ac8', guns: [[0, 1.8, 0.8]], turret: { at: 180, r: 0.42 }, move: 'sway' },
            'A mini Auto tank whose little turret looks out behind you.'),
        sd(241, 'sd_zoomer', 'Zoomer', 'epic', 290,
            { body: 'circle', col: '#38bdf8', guns: [[0, 1.8, 0.8], [135, 1.35, 0.8], [225, 1.35, 0.8], [155, 1.6, 0.8], [205, 1.6, 0.8]], move: 'zip' },
            'A little Booster with four thrusters, always in a hurry.'),
        sd(242, 'sd_pepper', 'Pepper', 'epic', 260,
            { body: 'circle', col: '#ff8a65', guns: [[0, 1.25, 0.36, 1, 0.68], [0, 1.25, 0.36, 1, -0.68], [0, 1.6, 0.36, 1, 0.34], [0, 1.6, 0.36, 1, -0.34]], move: 'hover' },
            'A pocket Gunner whose four skinny barrels make lots of tiny pops.'),

        sd(228, 'sd_closer', 'Mini Closer', 'legendary', 550,
            { body: 'circle', col: '#ffe14d', guns: [[0, 1.45, 1.0]], move: 'guard', size: 1.08 },
            'A pocket Arena Closer. It looks scary, but it isn’t.'),

        // ---- sidekick skins (nid 301..399): paint for the body, never the face ----
        sds(311, 'sds_stripes', 'Stripes', 'common', 20, { fill: 'stripes' }, 'Bold diagonal stripes in a lighter shade.'),
        sds(312, 'sds_dots', 'Polka Dots', 'common', 20, { fill: 'dots' }, 'White polka dots all over.'),
        sds(313, 'sds_twotone', 'Two-Tone', 'common', 25, { fill: 'twoTone' }, 'A darker bottom half, like a little jacket.'),
        sds(314, 'sds_checker', 'Checker', 'uncommon', 40, { fill: 'checker' }, 'A racing checkerboard.'),
        sds(315, 'sds_camo', 'Camo', 'uncommon', 45, { fill: 'camo' }, 'Camo blotches in darker shades of its own colour.'),
        sds(316, 'sds_frost', 'Frosted', 'rare', 70, { fill: 'frost' }, 'A frosted rim and an icy cap, in its own colour.'),
        sds(309, 'sds_gold', 'Solid Gold', 'epic', 140, { fill: 'gold' }, 'A gilded rim with studs and a little shine.'),
        sds(310, 'sds_galaxy', 'Galaxy', 'legendary', 260, { fill: 'galaxy' }, 'An orbit ring and twinkling stars over its own colour.'),
    ];

    // A catalog mistake should stop the server at boot, not show up as a
    // broken shop row: every item is checked once here.
    (function validate() {
        for (const it of RAW) {
            const where = 'cosmetics: ' + it.id;
            if (!/^(ns|sk|sd|sds|sdn)_[a-z0-9_]+$/.test(it.id)) throw new Error(where + ' bad id');
            if (!RARITIES[it.rarity]) throw new Error(where + ' bad rarity');
            if (!(it.price >= 0) || (it.exclusive && it.price !== 0)) throw new Error(where + ' bad price');
            if (it.cat === 'nameStyle') {
                if (!(it.nid >= 1 && it.nid <= 99) || !it.style || !Array.isArray(it.style.stops) || !it.style.stops.length) throw new Error(where + ' bad name style');
            } else if (it.cat === 'skin') {
                if (!(it.nid >= 101 && it.nid <= 199) || !it.skin || !it.skin.pattern) throw new Error(where + ' bad skin');
                // the body keeps the team colour: no hex
                if (/#[0-9a-f]{3,6}\b|accent|tint|body|fill|recolou?r/i.test(JSON.stringify(it.skin))) throw new Error(where + ' a skin recolours the body');
                const cs = it.skin.colors;
                if (!Array.isArray(cs) || !cs.length || cs.length > 3 || cs.some(k => !Object.prototype.hasOwnProperty.call(SKIN_SWATCHES, k))) throw new Error(where + ' bad skin colours');
            } else if (it.cat === 'sidekick') {
                const k = it.kick;
                if (!(it.nid >= 201 && it.nid <= 299) || !k || !BODIES[k.body] || !/^#[0-9a-f]{6}$/.test(k.col) || !Array.isArray(k.guns) || !k.move || !it.blurb) throw new Error(where + ' bad sidekick');
                if (!k.guns.length && k.body !== 'smasher') throw new Error(where + ' a sidekick needs a barrel');
                for (const g of k.guns) {
                    if (!Array.isArray(g) || g.length < 3 || !(g[1] > 0 && g[1] <= 2.2) || !(g[2] > 0 && g[2] <= 1.5) || (g[5] && !GUN_KINDS[g[5]])) throw new Error(where + ' bad barrel');
                }
            } else if (it.cat === 'sdSkin') {
                if (!(it.nid >= 301 && it.nid <= 399) || !it.look || !SKIN_FILLS[it.look.fill] || !it.blurb) throw new Error(where + ' bad sidekick skin');
                if (Object.keys(it.look).some(k => k !== 'fill')) throw new Error(where + ' a sidekick skin only decorates (no colour)');
            } else if (it.cat === 'sdName') {
                if (!(it.nid >= 401 && it.nid <= 499) || !it.style || !NAME_KINDS[it.style.kind] || !it.blurb) throw new Error(where + ' bad sidekick name style');
            } else throw new Error(where + ' bad cat');
        }
    })();

    function deepFreeze(o) {
        if (o && typeof o === 'object' && !Object.isFrozen(o)) {
            for (const k of Object.keys(o)) deepFreeze(o[k]);
            Object.freeze(o);
        }
        return o;
    }

    const ITEMS = deepFreeze(RAW.map(it => Object.assign({ permanent: false, retired: false, exclusive: false }, it)));
    const BY_ID = new Map(ITEMS.map(it => [it.id, it]));
    const BY_NID = new Map(ITEMS.map(it => [it.nid, it]));
    if (BY_ID.size !== ITEMS.length || BY_NID.size !== ITEMS.length) throw new Error('cosmetics: duplicate id or nid');

    function byId(id) { return (typeof id === 'string' && BY_ID.get(id)) || null; }
    function byNid(nid) { return BY_NID.get(nid | 0) || null; }
    function isCat(cat) { return CATS.indexOf(cat) >= 0; }

    // ---- colours ----

    function parseHex(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    // WCAG 2 relative luminance of a hex colour, 0..1 (NaN if not a colour).
    function luminance(hex) {
        const rgb = parseHex(hex);
        if (!rgb) return NaN;
        const lin = rgb.map(v => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    }

    function contrast(a, b) {
        const la = luminance(a), lb = luminance(b);
        const hi = Math.max(la, lb), lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    // Custom name colour rule: lowercase #rrggbb with luminance >= 0.137,
    // i.e. at least 3:1 against the floor colour #1e1d1b. Server and client
    // both call this; the server stores the lowercase form.
    const MIN_LUMINANCE = 0.137;
    const FLOOR_COLOR = '#1e1d1b';
    function normalizeColor(hex) {
        return typeof hex === 'string' ? hex.trim().toLowerCase() : '';
    }
    function isColorAllowed(hex) {
        if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/.test(hex)) return false;
        return luminance(hex) >= MIN_LUMINANCE;
    }

    // How far apart two colours look ("redmean" weighted RGB distance,
    // 0..~765). Hue counts here, unlike luminance contrast: red on blue is
    // easy to read even though both are about as bright.
    function colorDistance(a, b) {
        const x = parseHex(a), y = parseHex(b);
        if (!x || !y) return NaN;
        const r = (x[0] + y[0]) / 2, dr = x[0] - y[0], dg = x[1] - y[1], db = x[2] - y[2];
        return Math.sqrt((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db);
    }

    // A skin's pattern colours for a hull of this team colour (hex list)
    function skinColors(item, teamHex) {
        const cs = item && item.skin && item.skin.colors;
        if (!cs) return [];
        return cs.map(k => {
            const sw = SKIN_SWATCHES[k];
            if (!sw) return '#f2f2f2';
            const dm = colorDistance(sw[0], teamHex);
            if (!(dm < SKIN_NEAR)) return sw[0];
            return colorDistance(sw[1], teamHex) > dm ? sw[1] : sw[0];
        });
    }

    function priceDust(item) { return item ? item.price / MILLI : 0; }

    // ---- sidekicks ----

    // The Locker's colour choices for a sidekick (null = its own colour).
    const SIDEKICK_COLORS = Object.freeze(['#ff6b6b', '#ff9f43', '#ffd84d', '#a3e635', '#4ade80', '#2dd4bf',
        '#38bdf8', '#818cf8', '#c084fc', '#f472b6', '#f2f2f2', '#a8a29e']);
    const SIDEKICK_NAME_MAX = 16;
    const SIDEKICK_OWN = 'own';
    function isSidekickColor(hex) { return hex === SIDEKICK_OWN || SIDEKICK_COLORS.indexOf(hex) >= 0; }
    // Letters, digits, spaces and a little punctuation, one space at a time,
    // at most SIDEKICK_NAME_MAX characters. '' when nothing is left (the
    // sidekick then goes by its own name). Swear words are the caller's job
    // (shared/profanity.js).
    function cleanSidekickName(raw) {
        let s = String(raw == null ? '' : raw).normalize('NFC');
        s = s.replace(/[^\p{L}\p{N} '._!-]/gu, '').replace(/\s+/g, ' ').trim();
        return Array.from(s).slice(0, SIDEKICK_NAME_MAX).join('').trim();
    }

    // Sidekicks help you mine (server/game/terrain/sidekickDig.js): their shots hit
    const SIDEKICK_DIG_LINE = 'It helps you mine, but it only shoots rocks.';
    const SIDEKICK_DIG_BANDS = Object.freeze({
        common: [0.10, 0.15], uncommon: [0.22, 0.28], rare: [0.37, 0.43], epic: [0.52, 0.58], legendary: [0.72, 0.78],
    });
    let digPrices = null;
    function sidekickDigShare(item) {
        if (!item || item.cat !== 'sidekick') return 0;
        const band = SIDEKICK_DIG_BANDS[item.rarity];
        if (!band) return 0;
        if (!digPrices) {
            digPrices = {};
            for (const it of ITEMS) {
                if (it.cat !== 'sidekick' || it.retired || it.exclusive) continue;
                const p = digPrices[it.rarity] || (digPrices[it.rarity] = [Infinity, -Infinity]);
                p[0] = Math.min(p[0], it.price); p[1] = Math.max(p[1], it.price);
            }
        }
        const p = digPrices[item.rarity];
        const k = p && p[1] > p[0] ? Math.max(0, Math.min(1, (item.price - p[0]) / (p[1] - p[0]))) : 0.5;
        return band[0] + (band[1] - band[0]) * k;
    }

    return Object.freeze({
        CATALOG_VERSION, MILLI, RARITIES, RARITY_ORDER, CATS, TANK_CATS, SIDEKICK_CATS, CUSTOM_COLOR_ID, INVITE_STYLE_ID, BASIC_SIDEKICK_ID, ITEMS,
        MIN_LUMINANCE, FLOOR_COLOR, SIDEKICK_COLORS, SIDEKICK_OWN, SIDEKICK_NAME_MAX, RETIRED, SIDEKICK_DIG_LINE, SIDEKICK_DIG_BANDS,
        byId, byNid, isCat, parseHex, luminance, contrast, normalizeColor, isColorAllowed, colorDistance, priceDust,
        SKIN_SWATCHES, SKIN_NEAR, skinColors,
        isSidekickColor, cleanSidekickName, sidekickDigShare,
    });
});
