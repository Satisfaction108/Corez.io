// Raid bots spawn straight into a final (tier 3, level 45) tank from a
// short list the bot brain actually plays well: guns that point forward,
// no drone carriers, no trap builders, nothing that sprays in every
// direction. Twin and Hexa Tank (and every other tier 1/2 class) are out
// by construction: only the end of a basic -> tier 1 -> tier 2 -> tier 3
// path qualifies. BOT_TANK_CHECKLIST.md exclusions still apply on top.
//
// ROYALE_BOT_T3=0 goes back to the old random walk up the tree.
'use strict';

// relative pick weights
const POOL = {
    pentaShot: 6, spreadshot: 4, triplet: 5,
    autoGunner: 4, nailgun: 3,
    ranger: 4, autoAssassin: 2,
    predator: 4, xHunter: 3,
    streamliner: 5,
    redistributor: 3, focal: 3,
    fighter: 6, autoTriAngle: 3,
    annihilator: 4, hybrid: 2,
    musket: 2, crossbow: 2,
    mortar: 2,
};
// never, whatever the pool or the checklist says
const BANNED = new Set(['twin', 'hexatank', 'octotank', 'cyclone', 'basic']);

let enabled = process.env.ROYALE_BOT_T3 !== '0';
function setEnabled(v) { enabled = !!v; }
function isEnabled() { return enabled; }

const keyOf = c => {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object') {
        for (const k in Class) if (Class[k] === c) return k;
    }
    return null;
};
const listOf = (cls, tier) => {
    const def = Class[cls];
    const list = def && def['UPGRADES_TIER_' + tier];
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
        // a combined upgrade (array of classes) is not a plain tank
        if (Array.isArray(entry)) continue;
        const k = keyOf(entry);
        if (k) out.push(k);
    }
    return out;
};

// final class -> [tier1, tier2, final], from the live definitions
let paths = null;
function allPaths() {
    if (paths) return paths;
    paths = new Map();
    const root = (typeof Config !== 'undefined' && Config.spawn_class) || 'basic';
    for (const t1 of listOf(root, 1)) {
        for (const t2 of listOf(t1, 2)) {
            for (const t3 of listOf(t2, 3)) {
                if (!paths.has(t3)) paths.set(t3, [t1, t2, t3]);
            }
        }
    }
    return paths;
}

// the pool as it stands: on a full path, defined, not banned, not excluded
function pool(excluded = new Set()) {
    const all = allPaths();
    const out = [];
    for (const [name, weight] of Object.entries(POOL)) {
        const lower = name.toLowerCase();
        if (BANNED.has(lower) || excluded.has(lower) || !Class[name]) continue;
        const path = all.get(name);
        if (!path) continue;
        out.push({ name, weight, path });
    }
    return out;
}

// counts: Map lowercase class -> living bots in it. At most two of a tank
// at once while there is anything else to pick.
function pick(excluded, counts = new Map(), rand = Math.random) {
    const all = pool(excluded);
    if (!all.length) return null;
    const open = all.filter(o => (counts.get(o.name.toLowerCase()) || 0) < 2);
    const from = open.length ? open : all;
    let total = 0;
    for (const o of from) total += o.weight;
    let roll = rand() * total;
    for (const o of from) {
        roll -= o.weight;
        if (roll <= 0) return o;
    }
    return from[from.length - 1];
}

// Walks `body` up `path` right now (it must already be past level 45).
// Returns true when it ends in the final class.
function climb(body, path) {
    for (const step of path) {
        const want = Class[step];
        const i = (body.upgrades || []).findIndex(u =>
            u && Array.isArray(u.class) && u.class.length === 1 &&
            (u.class[0] === step || u.class[0] === want));
        if (i < 0) return false;
        body.upgrade(i);
    }
    const last = body.defs && body.defs[0];
    return last === path[path.length - 1] || keyOf(last) === path[path.length - 1];
}

module.exports = { POOL, BANNED, pool, pick, climb, allPaths, setEnabled, isEnabled };
