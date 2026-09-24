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
//
// Name style render params (item.style):
//   kind   'solid'  one colour (Custom Color: the player's own hex)
//          'linear' a static gradient across the text box, stops left->right
//          'scroll' the stops scroll along the text (last stop = first, so it
//                   tiles), `speed` in text-widths per second
//          'prism'  full hue cycle scrolling along the text, `speed` as above
//   stops  hex colours (every one passes isColorAllowed)
//   glint  a highlight sweep every `glintEvery` seconds (legendary)
//   glyph  suffix glyph drawn after the name (legendary), `glyphColor`
//
// Skin render params (item.skin): a pattern painted over the team colour.
//   pattern   stripes | rivets | camo | strata | hex | circuit | facets |
//             vein | cracks | frost | heart | spiral
//   seed      deterministic seed for the pattern's randomness
//   scale     pattern cell size as a fraction of the hull radius
//   accent    main pattern colour; altAccent when it clashes with the team
//             colour (see accentFor)
//   opacity   pattern alpha over the hull
//   emissive  null, or {kind: pulse | twinkle | spinGlow | spiral, color,
//             speed (cycles per second)} drawn additively on top
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DWCosmetics = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CATALOG_VERSION = 1;
    const MILLI = 1000;

    const RARITIES = Object.freeze({
        common:    Object.freeze({ id: 'common',    name: 'Common',    order: 0, color: '#b4b8bd' }),
        uncommon:  Object.freeze({ id: 'uncommon',  name: 'Uncommon',  order: 1, color: '#5fd068' }),
        rare:      Object.freeze({ id: 'rare',      name: 'Rare',      order: 2, color: '#4aa3ff' }),
        epic:      Object.freeze({ id: 'epic',      name: 'Epic',      order: 3, color: '#b06bff' }),
        legendary: Object.freeze({ id: 'legendary', name: 'Legendary', order: 4, color: '#ffb23d' }),
    });
    const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

    const CATS = Object.freeze(['nameStyle', 'skin']);
    const CUSTOM_COLOR_ID = 'ns_custom';

    function ns(nid, id, name, rarity, priceDust, style, extra) {
        return Object.assign({ nid, id, cat: 'nameStyle', name, rarity, price: Math.round(priceDust * MILLI), style }, extra || {});
    }
    function sk(nid, id, name, rarity, priceDust, skin) {
        return { nid, id, cat: 'skin', name, rarity, price: Math.round(priceDust * MILLI), skin };
    }

    const RAW = [
        // ---- name styles ----
        ns(1, CUSTOM_COLOR_ID, 'Custom Color', 'common', 10,
            { kind: 'solid', stops: ['#ffffff'], custom: true },
            { permanent: true }),
        ns(2, 'ns_sunset', 'Sunset', 'common', 30,
            { kind: 'linear', stops: ['#ffb347', '#ff6a5c', '#c850c0'] }),
        ns(3, 'ns_copper_vein', 'Copper Vein', 'common', 35,
            { kind: 'linear', stops: ['#e08a4f', '#ffd0a1', '#c26a35'] }),
        ns(4, 'ns_glacier', 'Glacier', 'common', 40,
            { kind: 'linear', stops: ['#e8f8ff', '#8fd3ff', '#4aa8ff'] }),
        ns(5, 'ns_candy', 'Candy', 'uncommon', 45,
            { kind: 'linear', stops: ['#ff8fcf', '#ffd1ec', '#8fd8ff'] }),
        ns(6, 'ns_mint_rush', 'Mint Rush', 'uncommon', 55,
            { kind: 'linear', stops: ['#b6ffe6', '#3ee6a0', '#7dffcb'] }),
        ns(7, 'ns_ember', 'Ember', 'rare', 60,
            { kind: 'linear', stops: ['#ffd35c', '#ff8a3d', '#ff5040'] }),
        ns(8, 'ns_amethyst', 'Amethyst', 'rare', 70,
            { kind: 'linear', stops: ['#e6c2ff', '#b07aff', '#8c5cff'] }),
        ns(9, 'ns_toxic', 'Toxic', 'rare', 80,
            { kind: 'linear', stops: ['#e2ff5c', '#7dff3d', '#3dffa0'] }),
        ns(10, 'ns_magma_flow', 'Magma Flow', 'epic', 130,
            { kind: 'scroll', stops: ['#ff4a24', '#ff9a1f', '#ffd84d', '#ff9a1f', '#ff4a24'], speed: 0.35 }),
        ns(11, 'ns_aurora', 'Aurora', 'epic', 150,
            { kind: 'scroll', stops: ['#4dffb8', '#4dc3ff', '#b88cff', '#4dc3ff', '#4dffb8'], speed: 0.25 }),
        ns(12, 'ns_emerald_crown', 'Emerald Crown', 'legendary', 280,
            { kind: 'scroll', stops: ['#1fd67a', '#7dffb6', '#ffd84d', '#7dffb6', '#1fd67a'], speed: 0.3,
              glint: true, glintEvery: 2.6, glyph: '♛', glyphColor: '#ffd84d' }),
        ns(13, 'ns_prism_shard', 'Prism Shard', 'legendary', 300,
            { kind: 'prism', stops: ['#ff6b6b', '#ffd84d', '#6bff8f', '#6bd8ff', '#b88cff', '#ff6b6b'], speed: 0.4,
              saturation: 0.85, lightness: 0.68, glint: true, glintEvery: 2.2, glyph: '◆', glyphColor: '#ffffff' }),

        // ---- skins ----
        sk(101, 'sk_hazard_stripes', 'Hazard Stripes', 'common', 40,
            { pattern: 'stripes', seed: 1101, scale: 0.35, accent: '#ffd23f', altAccent: '#2a2724', opacity: 0.7, angle: 45, emissive: null }),
        sk(102, 'sk_riveted_plate', 'Riveted Plate', 'common', 40,
            { pattern: 'rivets', seed: 1102, scale: 0.3, accent: '#d4d8de', altAccent: '#50555c', opacity: 0.75, emissive: null }),
        sk(103, 'sk_cave_camo', 'Cave Camo', 'uncommon', 80,
            { pattern: 'camo', seed: 1103, scale: 0.45, accent: '#5e4e3b', altAccent: '#b5a283', accent2: '#8a7456', opacity: 0.6, emissive: null }),
        sk(104, 'sk_strata', 'Strata', 'uncommon', 80,
            { pattern: 'strata', seed: 1104, scale: 0.22, accent: '#d9a066', altAccent: '#6e4a2c', accent2: '#8f6a45', opacity: 0.6, emissive: null }),
        sk(105, 'sk_hex_armor', 'Hex Armor', 'uncommon', 80,
            { pattern: 'hex', seed: 1105, scale: 0.28, accent: '#8fd8ff', altAccent: '#2f5d7a', opacity: 0.55, emissive: null }),
        sk(106, 'sk_drill_circuit', 'Drill Circuit', 'rare', 150,
            { pattern: 'circuit', seed: 1106, scale: 0.2, accent: '#4dffb8', altAccent: '#1f7a58', opacity: 0.75, emissive: null }),
        sk(107, 'sk_crystal_facets', 'Crystal Facets', 'rare', 150,
            { pattern: 'facets', seed: 1107, scale: 0.4, accent: '#e0f4ff', altAccent: '#6f8cff', opacity: 0.5, emissive: null }),
        sk(108, 'sk_gold_vein', 'Gold Vein', 'rare', 150,
            { pattern: 'vein', seed: 1108, scale: 0.35, accent: '#ffd84d', altAccent: '#a8780a', opacity: 0.85, emissive: null }),
        sk(109, 'sk_lava_cracks', 'Lava Cracks', 'epic', 300,
            { pattern: 'cracks', seed: 1109, scale: 0.4, accent: '#ff5a1f', altAccent: '#ffd84d', opacity: 0.9,
              emissive: { kind: 'pulse', color: '#ff7a2f', speed: 0.8 } }),
        sk(110, 'sk_permafrost', 'Permafrost', 'epic', 300,
            { pattern: 'frost', seed: 1110, scale: 0.3, accent: '#c4ecff', altAccent: '#4f9dff', opacity: 0.75,
              emissive: { kind: 'twinkle', color: '#eefaff', speed: 1.2 } }),
        sk(111, 'sk_emerald_heart', 'Emerald Heart', 'legendary', 600,
            { pattern: 'heart', seed: 1111, scale: 0.5, accent: '#1fd67a', altAccent: '#0f7a45', accent2: '#ffd84d', opacity: 0.85,
              emissive: { kind: 'spinGlow', color: '#7dffb6', speed: 0.5 } }),
        sk(112, 'sk_molten_core', 'Molten Core', 'legendary', 600,
            { pattern: 'spiral', seed: 1112, scale: 0.5, accent: '#ff8a1f', altAccent: '#ff3d1f', accent2: '#ffd84d', opacity: 0.85,
              emissive: { kind: 'spiral', color: '#ffd84d', speed: 0.6 } }),
    ];

    function deepFreeze(o) {
        if (o && typeof o === 'object' && !Object.isFrozen(o)) {
            for (const k of Object.keys(o)) deepFreeze(o[k]);
            Object.freeze(o);
        }
        return o;
    }

    const ITEMS = deepFreeze(RAW.map(it => Object.assign({ permanent: false, retired: false }, it)));
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

    // Skin accent for a given team colour: altAccent when the accent is too
    // close to the team colour to read (contrast under 1.6:1).
    function accentFor(item, teamHex) {
        const s = item && item.skin;
        if (!s) return null;
        if (!teamHex || !parseHex(teamHex)) return s.accent;
        return contrast(s.accent, teamHex) < 1.6 ? s.altAccent : s.accent;
    }

    function priceDust(item) { return item ? item.price / MILLI : 0; }

    return Object.freeze({
        CATALOG_VERSION, MILLI, RARITIES, RARITY_ORDER, CATS, CUSTOM_COLOR_ID, ITEMS,
        MIN_LUMINANCE, FLOOR_COLOR,
        byId, byNid, isCat, parseHex, luminance, contrast, normalizeColor, isColorAllowed, accentFor, priceDust,
    });
});
