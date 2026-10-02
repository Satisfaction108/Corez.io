// The Rattler: a new player's first chase. Once a new player is carrying a
// handful of gems away from a vault, a small orange digger bursts out of the
// rock behind them (on the far side from the nearest vault) and comes after
// them. It is slower than any tank and soft, its shots sting more than they
// hurt: run to the vault and it gives up, turn and fight and it pops. Either
// way it is gone in CHASE_MS. One per player per raid.
//
// ROYALE_RATTLER=0 turns it off.
'use strict';

const gems = require('./gems.js');
const { ioTypes, IO } = require('../../miscFiles/controllers.js');

const ON = process.env.ROYALE_RATTLER !== '0';
const EVERY_MS = 500;
const MIN_LIFE_MS = 12_000;        // not before this far into the life
const MAX_LIFE_MS = 150_000;       // ...nor after
const MIN_CARRY = 150;
const MIN_NEWNESS = 0.5;           // botDifficulty newness: only fairly new players
const VAULT_FAR = 450;             // they have somewhere to run to, but not right there
const SPAWN_BEHIND = 640;
const CHASE_MS = 25_000;
const MAX_ALIVE = 3;
const FIRE_R = 700;
const DROP_GEMS = 120;
const SHOT_MULT = 0.6;
const SPARE_BELOW = 0.35;          // of the prey's health
const IDLE_MS = 3000;              // nobody at the keys: no chase (it waits until they move)

let hooks = {};
let list = [];
let lastAt = 0;
let epoch = 1;

// dig_royale.js: callout(body, kind, text, pts, sub, dur), fxAt(x, y, kind),
// newness(body) 0..1, idleMs(socket) since their last real input
function attach(h) { hooks = h || {}; }
function enabled() { return ON && !!Config.dig_royale && !Config.tutorial; }

const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());
function tg() { return global.gameManager && global.gameManager.terrainGrid; }
function storm() { return require('./storm.js'); }

// Chase the prey, weaving a little, a short way off so it doesn't ram.
class io_royaleRattler extends IO {
    constructor(body) {
        super(body);
        this.acceptsFromTop = false;
        this.phase = Math.random() * Math.PI * 2;
    }
    think() {
        const b = this.body, prey = b.rattlerPrey;
        if (!alive(prey) || b.royaleFrozen || b._rattlerGone) return { goal: { x: b.x, y: b.y }, fire: false, main: false, power: 0 };
        const dx = prey.x - b.x, dy = prey.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const weave = Math.sin(Date.now() / 520 + this.phase) * (d > 320 ? 0.45 : 0.15);
        const ang = Math.atan2(dy, dx) + weave;
        const step = d > 190 ? Math.min(d, 420) : -110;
        return {
            target: { x: dx, y: dy },
            goal: { x: b.x + Math.cos(ang) * step, y: b.y + Math.sin(ang) * step },
            // it scares, it never finishes anyone: it holds fire on a badly hurt prey
            fire: d < FIRE_R && (prey.spawnGraceUntil || 0) < Date.now() && !(prey.health && prey.health.amount < prey.health.max * SPARE_BELOW),
            main: true,
            power: 1,
        };
    }
}
ioTypes.royaleRattler = io_royaleRattler;

function nearestVault(x, y, st) {
    let best = null, bd = Infinity;
    try {
        for (const v of require('./vault.js').getVaults()) {
            if (st && st.a && Math.hypot(v.x - st.cx, v.y - st.cy) > (st.r || 0) - 120) continue;
            const d = Math.hypot(v.x - x, v.y - y);
            if (d < bd) { bd = d; best = v; }
        }
    } catch { /* */ }
    return best ? { v: best, d: bd } : null;
}

// '' when this body should get its chase now, else why not (DBG rattler)
function whyNot(body, t) {
    if (!alive(body) || !body.socket || body.royaleFrozen) return 'not a live player';
    if (body.socket._rattlerEpoch === epoch) return 'had one this raid';
    const n = hooks.newness ? hooks.newness(body) : (body.botNewness || 0);
    if (!(n >= MIN_NEWNESS)) return 'not new (' + (+n).toFixed(2) + ')';
    const life = t - (body.royaleBornAt || t);
    if (life < MIN_LIFE_MS || life > MAX_LIFE_MS) return 'life ' + Math.round(life / 1000) + 's';
    if ((body.carriedGems | 0) < MIN_CARRY) return 'carrying ' + (body.carriedGems | 0);
    if (body.vaultOnPad || body.onVaultPad || body._inStorm) return 'on a pad or in the storm';
    if ((body.spawnGraceUntil || 0) > t) return 'spawn shield';
    if (hooks.idleMs && hooks.idleMs(body.socket) > IDLE_MS) return 'idle';
    return '';
}
function wants(body, t) { return whyNot(body, t) === ''; }

function spotFor(body, st) {
    const nv = nearestVault(body.x, body.y, st);
    if (!nv || nv.d < VAULT_FAR) return null;
    // behind them, on the far side from the vault, so running for it is
    // running away
    const ax = body.x - nv.v.x, ay = body.y - nv.v.y;
    const al = Math.hypot(ax, ay) || 1;
    const grid = tg();
    const mapR = (grid && grid.circleRadius) || 2700;
    for (const spread of [0, 0.5, -0.5, 1, -1]) {
        const a = Math.atan2(ay, ax) + spread;
        const x = body.x + Math.cos(a) * SPAWN_BEHIND, y = body.y + Math.sin(a) * SPAWN_BEHIND;
        if (Math.hypot(x, y) > mapR - 200) continue;
        if (st && st.a && Math.hypot(x - st.cx, y - st.cy) > (st.r || 0) - 150) continue;
        return { x, y, vault: nv.v };
    }
    return null;
}

function spawnFor(prey, t, st) {
    const spot = spotFor(prey, st);
    if (!spot) return null;
    let o;
    try {
        o = new Entity({ x: spot.x, y: spot.y });
        o.define('royaleRattler');
    } catch (e) { return null; }
    o.team = TEAM_ENEMIES;
    o.name = "Rattler";
    o.isRattler = true;
    o.rattlerPrey = prey;
    o.rattlerBornAt = t;
    o.bossDigs = true;          // it chews through the wall after you
    o.bossDigRate = 0.45;
    o.bossShotMult = SHOT_MULT;
    o.alwaysActive = true;
    o.settings.leaderboardable = false;
    o.refreshBodyAttributes();
    o.on('dead', () => onDead(o));
    prey.socket._rattlerEpoch = epoch;
    list.push(o);
    if (hooks.fxAt) hooks.fxAt(o.x, o.y, 'rattler');
    if (hooks.callout) hooks.callout(prey, 'rattler', "A RATTLER IS ON YOUR TAIL", 0, "Run for a vault, or turn and fight.", 3200);
    return o;
}

function rootOf(e) {
    let r = e, hops = 0;
    while (r && r.master && r.master !== r && hops++ < 8) r = r.master;
    return r;
}

function onDead(o) {
    if (o._rattlerGone) return;
    o._rattlerGone = true;
    list = list.filter(x => x !== o);
    let killer = null;
    for (const k of (o.finalKillers || [])) { const r = rootOf(k); if (r && (r.isPlayer || r.isBot) && alive(r)) { killer = r; break; } }
    const pieces = gems.splitValue(DROP_GEMS, { share: { 2: 0.5, 1: 0.5 }, maxPieces: 10 });
    pieces.forEach((p, i) => {
        const a = (i / pieces.length) * Math.PI * 2;
        gems.spawnGem(o.x, o.y, p.v, p.cls, p.size, Math.cos(a) * 3, Math.sin(a) * 3, p.ore);
    });
    if (killer && killer.socket && hooks.callout) hooks.callout(killer, 'rattlerdown', "RATTLER DOWN", 0, "+" + DROP_GEMS + " gems. Grab them.", 2200);
}

// gone without a fight: back into the rock, no drop
function burrow(o, why) {
    if (o._rattlerGone) return;
    o._rattlerGone = true;
    list = list.filter(x => x !== o);
    if (hooks.fxAt) hooks.fxAt(o.x, o.y, 'rattlergone');
    const prey = o.rattlerPrey;
    if (why && alive(prey) && hooks.callout) {
        if (why === 'vault') hooks.callout(prey, 'escaped', "ESCAPED", 0, "The Rattler gave up. Now bank it!", 2400);
        else if (why === 'time') hooks.callout(prey, 'escaped', "LOST IT", 0, "The Rattler gave up the chase.", 2200);
    }
    try { o.kill(); } catch { /* */ }
}

function tick(t, fighters) {
    if (!enabled()) return;
    for (const o of list.slice()) {
        if (!alive(o)) { onDead(o); continue; }
        const prey = o.rattlerPrey;
        if (!alive(prey)) burrow(o, '');
        else if (prey.vaultOnPad || prey.onVaultPad) burrow(o, 'vault');
        else if (t - o.rattlerBornAt > CHASE_MS) burrow(o, 'time');
    }
    if (t - lastAt < EVERY_MS) return;
    lastAt = t;
    if (list.length >= MAX_ALIVE) return;
    let st = null;
    for (const b of fighters || []) {
        if (!b || !b.socket || !wants(b, t)) continue;
        if (!st) { try { st = storm().snapshot(t); } catch { return; } }
        if (spawnFor(b, t, st) && list.length >= MAX_ALIVE) return;
    }
}

function reset() {
    for (const o of list.slice()) burrow(o, '');
    list = [];
    epoch++;
}

function alivList() { return list.filter(alive); }

module.exports = { ON, CHASE_MS, MIN_CARRY, MIN_NEWNESS, DROP_GEMS, attach, enabled, tick, reset, wants, whyNot, spotFor, alive: alivList, _spawnFor: spawnFor };
