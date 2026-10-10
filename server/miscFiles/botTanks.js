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

// ── the expanded tree: every Tier 4 tank with a full path, weighted for variety ──
const tier5 = require('../game/terrain/tier5.js');
const expandedOn = () => typeof Class !== 'undefined' && !!Class.xp_splitter && process.env.ROYALE_BOT_TANKS !== 'classic';
const DRONE_BOTS_MAX = 3;          // living bots on a drone carrier at once (server load)
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const resolve = t => typeof t === 'string' ? Class[t] : Array.isArray(t) ? resolve(t[0]) : (t && typeof t === 'object' ? t : null);
function getP(def, k, n = 0) {
    if (!def || n > 30) return undefined;
    if (def[k] !== undefined) return def[k];
    const ps = arr(def.PARENT);
    for (let i = ps.length - 1; i >= 0; i--) { const v = getP(resolve(ps[i]), k, n + 1); if (v !== undefined) return v; }
    return undefined;
}
// what a tank's guns and turrets throw
const kinds = new Map();
function kindOf(key) {
    if (kinds.has(key)) return kinds.get(key);
    const def = Class[key];
    const k = { drone: 0, trap: 0, bullet: 0, autos: 0, dirs: 0, invis: false, heal: false, smasher: false, necro: false, isNew: String(key).startsWith('xp_') };
    if (def) {
        const dirs = new Set();
        for (const g of arr(getP(def, 'GUNS'))) {
            const pr = g && g.PROPERTIES;
            if (!pr || !pr.SHOOT_SETTINGS) continue;
            const pd = resolve(pr.TYPE), type = String((pd && getP(pd, 'TYPE')) || 'bullet');
            // the Necromancer line turns food into drones: a raid has none
            if (pr.STAT_CALCULATOR === 'necro') { k.necro = true; continue; }
            if (type === 'drone' || type === 'minion' || pr.MAX_CHILDREN) k.drone++;
            else if (type === 'trap' || type === 'block') k.trap++;
            else k.bullet++;
            const P = g.POSITION, a = Array.isArray(P) ? P[5] : P && P.ANGLE;
            dirs.add(Math.round((((+a || 0) % 360) + 360) % 360 / 30));
        }
        for (const t of arr(getP(def, 'TURRETS'))) {
            const td = resolve(t && t.TYPE);
            if (td && arr(getP(td, 'GUNS')).some(g => g && g.PROPERTIES && g.PROPERTIES.SHOOT_SETTINGS)) k.autos++;
        }
        k.dirs = dirs.size;
        const inv = getP(def, 'INVISIBLE');
        k.invis = Array.isArray(inv) && !!(inv[0] || inv[1]);
        k.heal = !!getP(def, 'HEALING_TANK');
        k.smasher = !!getP(def, 'IS_SMASHER') || (!k.drone && !k.trap && !k.bullet && !k.autos);
    }
    kinds.set(key, k);
    return k;
}
// the stat build that fits (game/index.js configureBotStats)
let branchOf = null;
const ramTanks = require('../lib/definitions/ramTanks.js');
function buildKind(bot) {
    const key = keyOf(bot && bot.defs && bot.defs[0]);
    if (!key) return 'gun';
    // ram tanks (definitions/ramTanks.js): the smasher build
    { const r = ramTanks.classify(Class[key]); if (r.ram) return r.kind; }
    const k = kindOf(key);
    if (k.drone && !k.bullet && !k.autos) return 'drone';
    if (k.trap && !k.bullet && !k.drone) return 'trap';
    if (k.isNew) {
        if (!branchOf) { branchOf = new Map(); try { for (const t of require('../lib/definitions/tanks_expansion_data.js').tanks) branchOf.set(t.key, t.branch); } catch { /* */ } }
        const b = branchOf.get(key);
        if (b === 'sniper') return 'sniper';
        if (b === 'pounder') return 'heavy';
    }
    return '';
}
function weightOf(key) {
    const k = kindOf(key);
    if (k.heal || k.smasher || (k.necro && k.bullet + k.autos + k.trap < 2)) return 0;
    let w = POOL[key] || (k.isNew ? 2.5 : 2);
    if (k.drone) w *= k.bullet || k.autos ? 0.7 : 0.45;
    if (k.trap && !k.bullet && !k.drone) w *= 0.55;
    if (k.dirs >= 6) w *= 0.5;
    if (k.invis) w *= 0.5;
    return w;
}
// QA (ROYALE_DEBUG only): ROYALE_BOT_KIND=drone|trap|invis|autos keeps the pool to one
const QA_KIND = process.env.ROYALE_DEBUG ? process.env.ROYALE_BOT_KIND || '' : '';
function qaKeep(k) {
    if (!QA_KIND) return true;
    if (QA_KIND === 'drone') return k.drone > 0;
    if (QA_KIND === 'trap') return k.trap > 0 && !k.bullet;
    if (QA_KIND === 'invis') return k.invis;
    if (QA_KIND === 'autos') return k.autos > 0;
    return true;
}
function expandedPool(excluded) {
    const out = [];
    for (const [name, path] of allPaths()) {
        const lower = name.toLowerCase();
        if (BANNED.has(lower) || excluded.has(lower) || !Class[name]) continue;
        const weight = weightOf(name);
        if (weight > 0 && qaKeep(kindOf(name))) out.push({ name, weight, path, drone: kindOf(name).drone > 0 });
    }
    return out;
}
// a Tier 5 tank's path: its first Tier 4 parent's path, then itself
function pathFor(name, excluded = new Set()) {
    const all = allPaths();
    if (all.has(name)) return all.get(name);
    if (tier5.tierOf(name) !== 5) return null;
    for (const p of tier5.t4ParentsOf(name)) if (all.has(p)) return [...all.get(p), name];
    return null;
}
// Tier 5 for a bot that just earned it (dig_royale onTier5)
function tier5Up(body, handler = null, counts = null, rand = Math.random) {
    if (!body || !body.upgrades || (body.isDead && body.isDead())) return false;
    if (!counts) {
        counts = new Map();
        for (const o of (handler && handler.bots) || []) if (o && o !== body && !(o.isDead && o.isDead())) { const k = String(o.defs && o.defs[0] || '').toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); }
    }
    const opts = [];
    body.upgrades.forEach((u, i) => {
        if (!u || (u.tier | 0) !== tier5.T5_ENGINE_TIER || !Array.isArray(u.class) || u.class.length !== 1 || u.redefineAll) return;
        if (!tier5.open(body, u)) return;
        const name = keyOf(u.class[0]);
        if (!name) return;
        const w = weightOf(name) || 0.02;
        opts.push({ i, name, w: (counts.get(name.toLowerCase()) || 0) >= 2 ? w * 0.1 : w });
    });
    if (!opts.length) return false;
    let tot = 0; for (const o of opts) tot += o.w;
    let r = rand() * tot, pickO = opts[opts.length - 1];
    for (const o of opts) { r -= o.w; if (r <= 0) { pickO = o; break; } }
    const before = body.defs && body.defs[0];
    body.upgrade(pickO.i);
    const took = body.defs && body.defs[0] !== before;
    if (took && handler && handler.configureBotStats) { try { handler.configureBotStats(body); } catch { /* */ } }
    return took;
}

// the pool as it stands: on a full path, defined, not banned, not excluded
function pool(excluded = new Set()) {
    if (expandedOn()) return expandedPool(excluded);
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
    let all = pool(excluded);
    if (!all.length) return null;
    // drone carriers: a few at a time (each one fields a swarm)
    if (counts.droneBots >= DRONE_BOTS_MAX) { const nd = all.filter(o => !o.drone); if (nd.length) all = nd; }
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

module.exports = { POOL, BANNED, pool, pick, climb, allPaths, setEnabled, isEnabled, expandedOn, kindOf, weightOf, buildKind, pathFor, tier5Up, DRONE_BOTS_MAX };
