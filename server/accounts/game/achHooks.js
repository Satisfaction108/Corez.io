// Achievements in the game thread, for accounts and guests alike.
//
// The game calls the on*() functions below at the moment something happens
// (dig_royale.js, terrain modules through global.royaleAch, sockets.js).
// Every one of them is O(1): a bot (no socket) or an achievement already
// held returns after a property read and a Set lookup. Nothing here scans
// entities per tick; tick() walks only the sockets that loaded a state, and
// only every few seconds.
//
// State per socket (socket._ach), loaded from the database the first time
// it is needed (one query, plus the old lifetime stats as counter seeds):
//   owner     {kind:'a', id} for an account, {kind:'g', id} for a guest
//   have      Set of unlocked ids
//   n         Map track -> counter value; sets: Map track -> Set of keys
//   dirty     tracks changed since the last save (written every SAVE_MS)
//   raid      per raid: {id, biomes:Set}
// Per life the state sits on the body (body._achPeace for Pacifist, ...).
//
// Packet (server -> client), JSON as one string:
//   ACH {id, cat, name, desc, icon, color, tier, secret, rewardMilli, item, guest}
// The client decides when to show it (newcomer stage 0 only raises First
// Steps, the rest wait). An account's unlock also goes to the main thread
// ({t:'ach', userId, id}: the 'ach' SSE event for an open menu) and its dust
// to the HUD (DU kind 7).
'use strict';

const C = require('../../../shared/achievements.js');

const SAVE_MS = 5000;
const TICK_MS = 1000;
const SURVIVOR_MS = 15 * 60 * 1000;
const HOARD_AT = 3000;
const STREAK_AT = 5;
const KILL_MIN_ALIVE_MS = 5000;      // a player knocked out sooner doesn't count (spawn kills)
const PAD_KILL_MS = 8000;
const ESCAPE_HP = 0.3;
const ESCAPE_HIT_MS = 3000;
const ESCAPE_LIVE_MS = 6000;
const COOKIE_MS = 3000;
const BIG_DEPOSIT = 2000;
const PACIFIST_AT = 2000;
const BUTTERFINGERS_AT = 1000;
const BIOME_IDS = ['sandstone', 'clay', 'moss', 'crystal', 'magma', 'obsidian'];
const ORE_IDS = [null, 'copper', 'vein', 'shard', 'emerald'];
const ABILITIES = new Set(['grapple', 'burrow', 'shock', 'radar', 'wall', 'smoke', 'rush', 'pad']);

let bridgeMod = null, dbMod = null;
function bridge() { return bridgeMod || (bridgeMod = require('./bridge')); }
function store() { return dbMod || (dbMod = require('../achievements')); }
let lvMod = null;
function levels() { return lvMod || (lvMod = require('./levelHooks')); }

// Accounts on in the royale, not a plain ROYALE_DEBUG run (bridge.rankedOn).
// Tests can force it.
let forced = null;
// ACHIEVEMENTS=off turns them off (a kill switch; the ranked e2e test uses it).
const OFF = process.env.ACHIEVEMENTS === 'off';
function on() {
    if (forced != null) return forced;
    if (OFF) return false;
    try { return bridge().rankedOn(); } catch (e) { return false; }
}

let errAt = 0;
function logErr(what, e) {
    const t = Date.now();
    if (t - errAt < 10000) return;
    errAt = t;
    console.error('[achievements] ' + what + ' failed: ' + ((e && e.stack) || e));
}

const live = new Set();       // sockets with a loaded state
let raidNow = 0;
let finalRaid = -1;
let lastTickAt = 0, lastSaveAt = 0;
let hooks = { isFinal: null, humans: null, inStorm: null };

function ownerOf(socket) {
    if (socket.account && socket.account.id) return { kind: 'a', id: socket.account.id };
    if (typeof socket.guestId === 'string' && /^[a-f0-9]{32}$/.test(socket.guestId)) return { kind: 'g', id: socket.guestId };
    return null;
}

// The socket's state, loaded on first use. null for bots, no owner yet,
// accounts off, or a closed socket.
function stateOf(socket) {
    if (!socket || socket.terminated) return null;
    if (socket._ach !== undefined) return socket._ach;
    if (!on()) return null;
    const owner = ownerOf(socket);
    if (!owner) return null;
    let st = null;
    try {
        const raw = store().load(owner);
        st = { owner, have: new Set(raw.have.keys()), n: new Map(), sets: new Map(), dirty: new Set(), raid: { id: 0, biomes: new Set() }, quietIds: [] };
        for (const [track, c] of raw.counters) {
            st.n.set(track, c.n);
            if (c.set && c.set.length) { st.sets.set(track, new Set(c.set)); st.n.set(track, Math.max(c.n, c.set.length)); }
        }
        // the lifetime totals the stat tables already had
        const sd = store().seeds(owner);
        for (const k of Object.keys(sd)) {
            if ((sd[k] | 0) > (st.n.get(k) | 0)) { st.n.set(k, sd[k] | 0); st.dirty.add(k); }
        }
    } catch (e) { logErr('load', e); st = null; }
    socket._ach = st;
    if (st) {
        live.add(socket);
        // counters that were already past a goal unlock quietly (no card)
        for (const track of st.n.keys()) checkTrack(socket, st, track, true);
    }
    return st;
}
const stOf = (body) => (body && body.socket ? stateOf(body.socket) : null);

function sendJson(socket, type, obj) {
    if (!socket || socket.terminated) return;
    try { socket.talk(type, JSON.stringify(obj)); } catch (e) { /* closing */ }
}

// -> true when this call unlocked it
function unlock(socket, st, id, quiet = false) {
    if (!st || st.have.has(id)) return false;
    const def = C.BY_ID.get(id);
    if (!def) return false;
    st.have.add(id);
    let res;
    try { res = store().unlock(st.owner, id, Date.now(), def.track ? st.n.get(def.track) | 0 : 0); } catch (e) {
        // busy: forget it so the next event retries
        st.have.delete(id);
        logErr('unlock', e);
        return false;
    }
    if (!res.fresh) return false;
    const guest = st.owner.kind !== 'a';
    if (!quiet) {
        sendJson(socket, 'ACH', {
            id, cat: def.cat, name: def.name, desc: def.desc, icon: def.icon, color: def.color, tier: def.tier,
            secret: def.secret ? 1 : 0, rewardMilli: def.rewardMilli, item: def.item || '', guest: guest ? 1 : 0,
        });
    }
    if (!guest) {
        const userId = st.owner.id;
        try { require('../index').bus.toMain({ t: 'ach', userId, id }); } catch (e) { /* main gone */ }
        if (res.rewardMilli) {
            try {
                require('./dustHooks').noteExternalCredit(userId, res.rewardMilli, res.balanceMilli);
                bridge().du(socket, res.rewardMilli, 7, true);
            } catch (e) { /* the balance syncs on the next DU */ }
        }
    }
    return true;
}

function checkTrack(socket, st, track, quiet = false) {
    const list = C.TRACKS.get(track);
    if (!list) return;
    const n = st.n.get(track) | 0;
    for (const a of list) {
        if (n < a.goal) break;
        if (!st.have.has(a.id)) unlock(socket, st, a.id, quiet);
    }
}

// Counters. Tracks no achievement reads are ignored (nothing stored).
function add(socket, st, track, by = 1) {
    if (!C.TRACKS.has(track) || !(by > 0)) return;
    st.n.set(track, (st.n.get(track) | 0) + by);
    st.dirty.add(track);
    checkTrack(socket, st, track);
}
function max(socket, st, track, v) {
    if (!C.TRACKS.has(track) || !((v | 0) > (st.n.get(track) | 0))) return;
    st.n.set(track, v | 0);
    st.dirty.add(track);
    checkTrack(socket, st, track);
}
function setAdd(socket, st, track, key) {
    if (!C.TRACKS.has(track) || !key) return;
    let s = st.sets.get(track);
    if (!s) st.sets.set(track, s = new Set());
    if (s.has(key) || s.size >= store().SET_MAX) return;
    s.add(key);
    if (s.size > (st.n.get(track) | 0)) st.n.set(track, s.size);
    st.dirty.add(track);
    checkTrack(socket, st, track);
}

function raidOf(st) {
    if (st.raid.id !== raidNow) st.raid = { id: raidNow, biomes: new Set() };
    return st.raid;
}

// ---- game events ----

// A rock broken by this tank (terrainGrid.damageRock, not regrowing rock).
function onRock(owner, rock) {
    const st = stOf(owner);
    if (!st) return;
    const s = owner.socket;
    unlock(s, st, 'fs_rock');
    add(s, st, 'rocks', 1);
    const bi = rock && rock.biome >= 0 ? BIOME_IDS[rock.biome] : null;
    const ore = rock ? ORE_IDS[rock.ore | 0] : null;
    if (bi) {
        add(s, st, 'b_' + bi, 1);
        if (ore) add(s, st, 'bo_' + bi, 1);
        if (bi === 'obsidian') unlock(s, st, 'bi_obsidian');
        else if (bi === 'sandstone' && ore) unlock(s, st, 'bi_sandstone');
        else if (bi === 'crystal' && ore === 'shard') unlock(s, st, 'bi_crystal');
        const r = raidOf(st);
        if (!r.biomes.has(bi)) {
            r.biomes.add(bi);
            if (r.biomes.size >= BIOME_IDS.length) unlock(s, st, 'tourist');
        }
    }
    if (ore) {
        add(s, st, 'ore' + (rock.ore | 0), 1);
        if (ore === 'vein') unlock(s, st, 'ore_vein');
        else if (ore === 'shard') unlock(s, st, 'ore_shard');
        else if (ore === 'emerald') unlock(s, st, 'ore_emerald');
    }
}

// Blast Rounds / Chain Spark broke `n` rocks off one hit.
function onPerkBurst(owner, n) {
    if (!(n >= 3)) return;
    const st = stOf(owner);
    if (st) unlock(owner.socket, st, 'chain_blast');
}

// A gem went into the satchel (gems.js). ore: 1..4, 0 for a loose drop.
function onGem(body, ore) {
    const st = stOf(body);
    if (!st) return;
    const s = body.socket;
    unlock(s, st, 'fs_gem');
    if (ore === 4) add(s, st, 'emeralds', 1);
    if ((body.carriedGems | 0) >= HOARD_AT) unlock(s, st, 'hoarder');
}

// Any bank credit (vault chunk, base, Core payout, Flash Vault).
function onBank(body, amount) {
    levels().onBank(body, amount);
    const st = stOf(body);
    if (!st || !(amount > 0)) return;
    const s = body.socket;
    unlock(s, st, 'fs_bank');
    add(s, st, 'banked', Math.floor(amount));
    // Pacifist: nothing this life ever hit a tank (index.js / dig_royale
    // stamp _dealtAt on every hit)
    if (!body._dealtAt) {
        body._achPeace = (body._achPeace || 0) + amount;
        if (body._achPeace >= PACIFIST_AT) unlock(s, st, 'pacifist');
    }
}

// A vault deposit finished (vault.js): total banked in it.
function onDeposit(body, total) {
    const st = stOf(body);
    if (!st) return;
    const s = body.socket;
    if ((total | 0) >= BIG_DEPOSIT) unlock(s, st, 'fat_stack');
    const hp = body.health && body.health.max > 0 ? body.health.amount / body.health.max : 1;
    if (hp < 0.1) unlock(s, st, 'close_call');
}
// a deposit cut short by a hit (the Cookie Jar looks at it on death)
function onDepositCut(body) { if (body && body.socket) body._achDepCutAt = Date.now(); }

function onFlash(body) {
    const st = stOf(body);
    if (st) unlock(body.socket, st, 'flash_vault');
}

// An ability fired (abilities.use).
function onAbility(body, id, t = Date.now()) {
    const st = stOf(body);
    if (!st || !ABILITIES.has(id)) return;
    const s = body.socket;
    unlock(s, st, 'fs_ability');
    unlock(s, st, 'ab_' + id);
    setAdd(s, st, 'abils', id);
    // grapple out on low health while under fire: it counts if you live
    if (id === 'grapple' && !st.have.has('grapple_escape') && body.health && body.health.max > 0) {
        const hp = body.health.amount / body.health.max;
        const hitAt = Math.max(body.hitAt || 0, body._lastDamageAt || 0);
        if (hp < ESCAPE_HP && t - hitAt < ESCAPE_HIT_MS) {
            body._achEscapeAt = t;
            escapes.add(body);
        }
    }
}
const escapes = new Set();

// A Shockwave fling ended (abilities.endMotion). by: who threw it.
function onFlingEnd(body, by) {
    if (!by || !hooks.inStorm) return;
    let inside = false;
    try { inside = !!hooks.inStorm(body.x, body.y); } catch (e) { return; }
    if (!inside) return;
    if (by === body) {
        const st = stOf(body);
        if (st) unlock(body.socket, st, 'yeet');
        return;
    }
    const st = stOf(by);
    if (st) unlock(by.socket, st, 'fling_storm');
}

function onGrow(body, stage) {
    const st = stOf(body);
    if (!st) return;
    unlock(body.socket, st, 'fs_grow');
    max(body.socket, st, 'size', Math.round((+stage || 1) * 100));
}

// A tank upgrade (entity 'upgrade'). tier: the upgrade row's tier (1 = the
// first upgrade off the Basic), label: the new tank's name.
function onUpgrade(body, tier, label) {
    const st = stOf(body);
    if (!st) return;
    const s = body.socket;
    unlock(s, st, 'fs_tank');
    if (label) setAdd(s, st, 'tanks', String(label).slice(0, 32));
}

// A stat point went in (entity 'skillUp').
function onSkillUp(body, stat) {
    const st = stOf(body);
    if (!st) return;
    unlock(body.socket, st, 'fs_stat');
    try {
        if (body.skill && body.skill.amount(stat) >= body.skill.cap(stat)) unlock(body.socket, st, 'stat_max');
    } catch (e) { /* a skill this body doesn't have */ }
}

function onBoss(killer) {
    const st = stOf(killer);
    if (st) unlock(killer.socket, st, 'boss_slayer');
}
function onChest(body) {
    const st = stOf(body);
    if (st) unlock(body.socket, st, 'chest_open');
}
function onCoreHit(body) {
    const st = stOf(body);
    if (st) unlock(body.socket, st, 'core_hit');
}
function onCoreBreak(body) {
    const st = stOf(body);
    if (st) { unlock(body.socket, st, 'core_hit'); unlock(body.socket, st, 'core_break'); }
}

// dig_royale onCombatantDead, once per death.
// i: {killer, victimBot, avenged, crown ({how}) , carried, streak, raidEnd, cause}
function onDeath(victim, i) {
    levels().onDeath(victim, i);
    const t = Date.now();
    const killer = i.killer;
    if (killer && killer !== victim && killer.socket) {
        const st = stateOf(killer.socket);
        if (st) {
            const s = killer.socket;
            unlock(s, st, 'fs_ko');
            if (i.victimBot) add(s, st, 'botkills', 1);
            else if (!victim.royaleBornAt || t - victim.royaleBornAt >= KILL_MIN_ALIVE_MS) add(s, st, 'kills', 1);
            if ((i.streak | 0) >= STREAK_AT) unlock(s, st, 'streaker');
            if (i.avenged) unlock(s, st, 'revenge');
            if (i.crown) {
                unlock(s, st, 'crown_ko');
                if (i.crown.how === 'steal') unlock(s, st, 'crown_steal');
            }
            if (victim._padBy === killer && t - (victim._padAt || 0) < PAD_KILL_MS) unlock(s, st, 'pad_kill');
        }
    }
    if (!victim.socket) return;
    escapes.delete(victim);
    const st = stateOf(victim.socket);
    if (!st) return;
    const s = victim.socket;
    if (i.cause === 'despawn') return;
    add(s, st, 'games', 1);
    if (i.raidEnd) return;
    if (i.cause === 'rock') unlock(s, st, 'rock_bottom');
    else if (i.cause === 'storm') unlock(s, st, 'forecast');
    else if (i.cause === 'core') unlock(s, st, 'icarus');
    if ((i.carried | 0) >= BUTTERFINGERS_AT) unlock(s, st, 'butterfingers');
    if (victim._achDepCutAt && t - victim._achDepCutAt < COOKIE_MS) unlock(s, st, 'cookie_jar');
}

// endRaid, per connected player: place on the board, alive at the bell,
// still wearing a crown, and whether they really played this raid.
function onRaidEnd(socket, r) {
    levels().onRaidEnd(socket, r);
    const st = stateOf(socket);
    if (!st || !r || !r.played) return;
    if (r.alive) unlock(socket, st, 'raid_survive');
    if (r.place >= 1 && r.place <= 3) unlock(socket, st, 'podium');
    if (r.place === 1) add(socket, st, 'wins', 1);
    if (r.crown) unlock(socket, st, 'crown_win');
    // the raid is over: write now, before the mass death
    save(socket, st);
}

function onRaidStart(id) { raidNow = id | 0; }

// ---- the slow loop (dig_royale tick) ----

function tick(t = Date.now()) {
    levels().tick(t);
    if (t - lastTickAt < TICK_MS) return;
    lastTickAt = t;
    if (!live.size && !escapes.size) return;
    // Great Escape: still alive a few seconds after the grapple
    if (escapes.size) {
        for (const b of Array.from(escapes)) {
            if (!b.socket || (b.isDead && b.isDead()) || b.royaleAlive === false) { escapes.delete(b); continue; }
            if (t - (b._achEscapeAt || 0) >= ESCAPE_LIVE_MS) {
                escapes.delete(b);
                const st = stOf(b);
                if (st) unlock(b.socket, st, 'grapple_escape');
            }
        }
    }
    // the final storm circle, once per raid, for everyone alive in it
    let fin = false;
    if (finalRaid !== raidNow && hooks.isFinal) {
        try { fin = !!hooks.isFinal(); } catch (e) { fin = false; }
        if (fin) finalRaid = raidNow;
    }
    for (const s of Array.from(live)) {
        if (s.terminated) { onClose(s); continue; }
        const st = s._ach;
        if (!st) { live.delete(s); continue; }
        const b = s.player && s.player.body;
        const alive = b && b.socket === s && !(b.isDead && b.isDead()) && b.royaleAlive !== false && !b.royaleLobby;
        if (!alive) continue;
        if (fin) unlock(s, st, 'final_circle');
        if (b.royaleBornAt && t - b.royaleBornAt >= SURVIVOR_MS) unlock(s, st, 'survivor');
    }
    if (t - lastSaveAt >= SAVE_MS) {
        lastSaveAt = t;
        for (const s of live) if (s._ach && s._ach.dirty.size) save(s, s._ach);
    }
}

function save(socket, st) {
    if (!st || !st.dirty.size) return true;
    const list = [];
    for (const track of st.dirty) {
        const set = st.sets.get(track);
        list.push({ track, n: st.n.get(track) | 0, set: set ? Array.from(set) : null });
    }
    try { store().saveCounters(st.owner, list); } catch (e) { logErr('save', e); return false; }
    st.dirty.clear();
    return true;
}

function onClose(socket) {
    levels().onClose(socket);
    live.delete(socket);
    const st = socket && socket._ach;
    if (st) save(socket, st);
}

// A guest browser just signed up (bridge.onGuestId): its achievements move
// onto the account, and this socket reloads its state.
function adoptGuest(socket, guestId, userId) {
    let res = null;
    try { res = store().adoptGuest(guestId, userId); } catch (e) { logErr('adopt', e); return null; }
    if (socket) {
        if (socket._ach) save(socket, socket._ach);
        live.delete(socket);
        socket._ach = undefined;
    }
    if (res && res.rewardMilli && socket) {
        try {
            require('./dustHooks').noteExternalCredit(userId, res.rewardMilli, res.balanceMilli);
            bridge().du(socket, res.rewardMilli, 7, true);
        } catch (e) { /* */ }
    }
    return res;
}

function saveAll() { levels().saveAll(); for (const s of live) if (s._ach) save(s, s._ach); }

function init(h) { hooks = Object.assign({ isFinal: null, humans: null, inStorm: null }, h || {}); }

const api = {
    SAVE_MS, init, on, stateOf, tick, save, saveAll, onClose, adoptGuest, onRaidStart, onRaidEnd,
    onRock, onPerkBurst, onGem, onBank, onDeposit, onDepositCut, onFlash, onAbility, onFlingEnd, onGrow,
    onUpgrade, onSkillUp, onBoss, onChest, onCoreHit, onCoreBreak, onDeath,
    _force(v) { forced = v; }, _unlock: unlock, _live: live, _escapes: escapes,
};
// a bug in here must never reach the game loop (rock damage, pickups...)
for (const k of Object.keys(api)) {
    const fn = api[k];
    if (!/^on[A-Z]|^tick$/.test(k) || typeof fn !== 'function') continue;
    api[k] = function guarded(a, b, c, d) {
        try { return fn(a, b, c, d); } catch (e) { logErr(k, e); return undefined; }
    };
}
// terrain modules reach it without a require (absent in tests and tools
// that never load the royale)
global.royaleAch = api;
module.exports = api;
