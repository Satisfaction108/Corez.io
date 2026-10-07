// Tier 5 unlock
'use strict';

const T5_GROWTH = (() => { const v = parseFloat(process.env.ROYALE_T5_GROWTH); return v > 1 ? v : 2; })();
const T5_ENGINE_TIER = 4;      // upgrade.tier of a Tier 5 option (UPGRADES_TIER_4)
const T4_LEVEL = 45;           // a Tier 4 tank's level (Config.tier_multiplier * 3)

let raidOf = () => 0;
function setRaidOf(fn) { if (typeof fn === 'function') raidOf = fn; }

function cfg() { return typeof Config !== 'undefined' ? Config : {}; }
function expanded() { return typeof Class !== 'undefined' && !!Class.xp_splitter; }
function active() {
    const C = cfg();
    return !!(C.dig_royale && !C.tutorial && expanded() && process.env.ROYALE_TANKS_T5_FREE !== '1');
}

// earned this life: a flag on the body (a respawn is a new body)
function has(body) {
    return !!(body && body._t5Life === true && body._t5Raid === raidOf());
}
function grant(body) {
    if (!body) return;
    body._t5Life = true;
    body._t5Raid = raidOf();
}
function growthOf(body) {
    if (!body) return 1;
    const g = body._growTarget != null ? body._growTarget : body.growthMult;
    return g > 0 ? g : 1;
}
// growth tick: true the first time this life reaches the mark
function note(body) {
    if (!body || growthOf(body) < T5_GROWTH - 1e-6) return false;
    if (!active() || has(body)) return false;
    grant(body);
    return true;
}

// The one gate. u: an entry of body.upgrades
function open(body, u) {
    if (!body || !u || !body.skill) return false;
    if ((u.tier | 0) === T5_ENGINE_TIER && active()) return body.skill.level >= T4_LEVEL && has(body);
    return body.skill.level >= u.level;
}

// owner tiers (Basic = 1, Tier 5 = the UPGRADES_TIER_4 layer), from the live tree
let tierCache = null, tierRoot = null;
function tiers() {
    if (typeof Class === 'undefined') return new Map();
    const root = (Class && Class[String(cfg().spawn_class || 'basic')]) || (Class && Class.basic);
    if (tierCache && tierRoot === root) return tierCache;
    tierRoot = root; tierCache = new Map();
    if (!root) return tierCache;
    const keyOfDef = new Map(); for (const k in Class) keyOfDef.set(Class[k], k);
    const start = keyOfDef.get(root);
    tierCache.set(start, 1);
    const q = [start];
    while (q.length) {
        const k = q.shift(), d = Class[k];
        for (let t = 1; t <= 4; t++) for (let e of (d && d['UPGRADES_TIER_' + t]) || []) {
            if (Array.isArray(e)) { if (e.length !== 1) continue; e = e[0]; }
            const ck = typeof e === 'string' ? e : keyOfDef.get(e);
            if (!ck || tierCache.has(ck)) continue;
            tierCache.set(ck, t + 1); q.push(ck);
        }
    }
    return tierCache;
}
const defKeys = new WeakMap();
function keyOfClass(d) {
    if (typeof d === 'string') return d;
    if (!d || typeof d !== 'object' || typeof Class === 'undefined') return null;
    if (defKeys.has(d)) return defKeys.get(d);
    let out = null;
    for (const k in Class) if (Class[k] === d) { out = k; break; }
    defKeys.set(d, out);
    return out;
}
function tierOf(d) { const k = keyOfClass(d); return (k && tiers().get(k)) || 0; }
function bodyTier(body) { return body && body.defs && body.defs.length === 1 ? tierOf(body.defs[0]) : 0; }

// a Tier 5 tank's Tier 4 parents (UPGRADES_TIER_4 lists that name it)
let parentCache = null, parentRoot = null;
function t4ParentsOf(key) {
    if (typeof Class === 'undefined') return [];
    if (!parentCache || parentRoot !== tierRoot) {
        tiers(); parentRoot = tierRoot; parentCache = new Map();
        for (const [k, t] of tiers()) {
            if (t !== 4) continue;
            for (const c of (Class[k] && Class[k].UPGRADES_TIER_4) || []) {
                const ck = typeof c === 'string' ? c : keyOfClass(c);
                if (!ck) continue;
                if (!parentCache.has(ck)) parentCache.set(ck, []);
                parentCache.get(ck).push(k);
            }
        }
    }
    return parentCache.get(key) || [];
}
// the Tier 4 parent of Tier 5 tank `key` that a life came through (via: the classes it upgraded
// from, entity.tankPath), else the tree's first. Oct 7 2026: Architect -> Glacis came back as
// Mega-3, Glacis's first parent in the tree, not the Architect the player had picked.
function t4ParentFor(key, via) {
    const ps = t4ParentsOf(keyOfClass(key));
    if (Array.isArray(via)) for (let i = via.length - 1; i >= 0; i--) { const k = keyOfClass(via[i]); if (k && ps.includes(k)) return k; }
    return ps[0] || null;
}
// A saved build's class for this body: a Tier 5 tank this life has not earned
function gateDef(body, def, via = null) {
    if (!active() || has(body)) return { def, gated: false };
    const k = keyOfClass(def);
    if (!k || tierOf(k) !== 5) return { def, gated: false };
    const p = t4ParentFor(k, via);
    return p ? { def: p, gated: true } : { def, gated: false };
}

// the RY you-packet: t5 = [your tier, earned 0/1, growth x100, the mark x100]
function youFields(body) {
    if (!active() || !body || (body.isDead && body.isDead())) return null;
    const tr = bodyTier(body);
    if (tr < 4) return null;
    return { t5: [tr, has(body) ? 1 : 0, Math.round(growthOf(body) * 100), Math.round(T5_GROWTH * 100)] };
}

// Mockups are built on first request (sockets generateMockup)
const warmQ = [];
let warming = false;
function warm(body) {
    if (!active() || !body || !body.upgrades || typeof mockupMap === 'undefined') return 0;
    let n = 0;
    for (const u of body.upgrades) {
        if (!u || (u.tier | 0) !== T5_ENGINE_TIER) continue;
        for (const c of u.class || []) {
            const k = keyOfClass(c), d = k && Class[k];
            if (d && d.index != null && mockupMap[d.index] === undefined && !warmQ.includes(k)) { warmQ.push(k); n++; }
        }
    }
    if (!warming && warmQ.length) { warming = true; setTimeout(warmStep, 0); }
    return n;
}
function warmStep() {
    const k = warmQ.shift();
    try { if (k && Class[k] && mockupMap[Class[k].index] === undefined) require('../../miscFiles/mockups.js').buildMockup(k, global.gameManager); } catch { /* sent on demand instead */ }
    if (warmQ.length) setTimeout(warmStep, 4); else warming = false;
}

module.exports = { warm, T5_GROWTH, T5_ENGINE_TIER, setRaidOf, active, has, note, open, tierOf, bodyTier, t4ParentsOf, t4ParentFor, gateDef, youFields };
