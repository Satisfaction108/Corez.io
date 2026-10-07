// Raid bosses take their damage in measured doses, so a boss fight takes
// real time whoever shows up. Without this a grown tank, a Constructor's
// traps or an Annihilator at point blank could drop one in two hits.
//
//   per hit     no single collision tick lands more than HIT_SHARE of the
//               boss's pool (health + shield max)
//   per second  off since Oct 3 (the owner wanted damage to land as dealt);
//               ROYALE_BOSS_RATE_CAP=1 brings back the per tank
//               (TANK_SHARE_S) and everyone (ALL_SHARE_S) limits
//   regen       a boss hit in the last FIGHT_MS does not regenerate (its
//               full-shield health regen alone would out-heal the per tank
//               share)
//
// With the defaults a strong solo player needs at least ~36 s (more when
// they stop to dodge), a group of three ~13-15 s.
// ROYALE_BOSS_CAP=0 turns it off.
//
// Bosses treat every player alike (Oct 5 2026)
//
// Fresh tanks, anyone's: a life younger than FRESH_LIFE_MS, or a life in the
'use strict';

const HIT_SHARE = 0.0175;
// A drone lands far fewer hits than a stream of bullets (the boss's hull
// keeps killing it), and a huge shell lands one hit where a gun lands ten,
// so each may take a bigger bite: Big Cheese's one drone and an
// Annihilator's shells were capped to a small bullet's share and did next to
// nothing. Minions keep the bullet share (they press and shoot all along).
const DRONE_HIT_SHARE = 0.06;
const BIG_SHOT_HIT_SHARE = 0.045;
const BIG_SHOT_SIZE = 16;
const TANK_SHARE_S = 0.028;
const ALL_SHARE_S = 0.075;
// a second of game time: 30 ticks (wall clock only outside the game loop)
const WINDOW_TICKS = 30, WINDOW_MS = 1000;
const FIGHT_MS = 3000;

const ANGER_AT = 0.25, ANGER_FULL = 0.6, ANGER_MIN = 0.3, ANGER_RAMP_MS = 25000;
const NEWBIE_DMG_MIN = 0.25, NEWBIE_FLOOR_AT = 0.25, ATTACK_MS = 8000, NEWBIE_AIM_PENALTY = 900;

let enabled = process.env.ROYALE_BOSS_CAP !== '0';
let rateCap = process.env.ROYALE_BOSS_RATE_CAP === '1';
// Oct 7: the expansion's damage floor made bosses melt in seconds; every
// tank's damage into a raid boss counts this much (same for everyone)
const TANK_DMG_MULT = (() => { const v = parseFloat(process.env.ROYALE_BOSS_DMG_MULT); return v > 0 ? v : 0.5; })();
function setRateCap(v) { rateCap = !!v; }
let spare = process.env.ROYALE_BOSS_NEWBIE === '1';
let freshOn = process.env.ROYALE_BOSS_FRESH !== '0';
function setFresh(v) { freshOn = !!v; }
// was 75 s / 0.3x, plus 150 s for a stock Basic and never the last point)
const FRESH_LIFE_MS = 45_000, RAID_EARLY_MS = 120_000, BASIC_LIFE_MS = 0, FRESH_DMG = 0.6;
function setEnabled(v) { enabled = !!v; }
function isEnabled() { return enabled; }
function setSpare(v) { spare = !!v; }
let activity = null;
function idle(body, now) {
    try { return (activity || (activity = require('../network/activity.js'))).unprotected(body, now); } catch { return false; }
}

function rootOf(e) {
    let r = e, hops = 0;
    while (r && r.master && r.master !== r && hops++ < 8) r = r.master;
    return r || e;
}
function poolOf(boss) {
    return Math.max(1, (boss.health?.max || 0) + (boss.shield?.max || 0));
}

// Raw damage `amount` from `src` (a bullet, trap, drone or hull) about to be
// added to the boss's damageReceived: what is let through.
function capHit(boss, src, amount, now) {
    if (!(amount > 0)) return amount;
    const root0 = rootOf(src);
    // who is picking a fight with a boss (the newcomer last-blow rule)
    if (root0 && root0.isPlayer) root0._hitBossAt = Date.now();
    // the tutorial's practice boss is meant to drop in a few seconds
    if (!enabled || boss.isTutorialBot) return note(boss, root0, amount);
    const pool = poolOf(boss);
    const share = !src ? HIT_SHARE
        : src.type === 'drone' ? DRONE_HIT_SHARE
        : src.type === 'bullet' && (src.size || 0) >= BIG_SHOT_SIZE ? BIG_SHOT_HIT_SHARE
        : HIT_SHARE;
    let dmg = Math.min(amount * TANK_DMG_MULT, pool * share);
    if (!rateCap) return note(boss, root0, dmg);
    const ticks = now == null && global.gameTick != null;
    if (now == null) now = ticks ? global.gameTick : Date.now();
    const span = ticks ? WINDOW_TICKS : WINDOW_MS;
    const win = boss._dmgWin || (boss._dmgWin = { at: now, all: 0, by: new Map() });
    if (now - win.at >= span || now < win.at) { win.at = now; win.all = 0; win.by.clear(); }
    const root = rootOf(src);
    const key = root && root.id != null ? root.id : -1;
    const used = win.by.get(key) || 0;
    dmg = Math.min(dmg, pool * TANK_SHARE_S - used, pool * ALL_SHARE_S - win.all);
    if (!(dmg > 0)) return 0;
    win.by.set(key, used + dmg);
    win.all += dmg;
    return note(boss, root, dmg);
}
// what each tank has landed on this boss, for the anger rule
function note(boss, root, dmg) {
    if (dmg > 0 && root && root.isPlayer && root.nxBossSafe) {
        const m = boss._dealtBy || (boss._dealtBy = new Map());
        const was = m.get(root.id) || 0;
        m.set(root.id, was + dmg);
        const pool = poolOf(boss);
        if (was < pool * ANGER_AT && was + dmg >= pool * ANGER_AT) {
            (boss._angryAt || (boss._angryAt = new Map())).set(root.id, Date.now());
            try { if (root.sendMessage) root.sendMessage("The boss noticed you. It's fighting back now."); } catch { /* */ }
        }
    }
    return dmg;
}
// 0: the boss leaves this first-minutes player alone; else the share of its
// damage it hits them with (ANGER_MIN up to 1)
function angerOf(boss, p, now = Date.now()) {
    if (!boss || !p || !boss._dealtBy) return 0;
    const share = (boss._dealtBy.get(p.id) || 0) / poolOf(boss);
    if (share < ANGER_AT) return 0;
    const at = (boss._angryAt && boss._angryAt.get(p.id)) || now;
    const k = Math.max((share - ANGER_AT) / (ANGER_FULL - ANGER_AT), (now - at) / ANGER_RAMP_MS);
    return Math.min(1, ANGER_MIN + (1 - ANGER_MIN) * Math.max(0, k));
}

// 0 not new .. 1 brand new, as far as boss mercy goes
function newnessOf(p, now = Date.now()) {
    if (!spare || !p || !p.isPlayer) return 0;
    const n = p.botNewbie ? 1 : +p.botNewness || 0;
    if (!(n > 0) || idle(p, now)) return 0;
    return n > 1 ? 1 : n;
}
// a tank too fresh for a boss to start on (see the header)
function freshSpared(p, now = Date.now()) {
    if (!freshOn || !p || !p.isPlayer || p.isDead?.()) return false;
    if (now - (p._hitBossAt || 0) < ATTACK_MS) return false;
    if (idle(p, now)) return false;
    const life = p.royaleBornAt ? now - p.royaleBornAt : Infinity;
    if (life < FRESH_LIFE_MS) return true;
    // a raid's first minutes: bosses.js surfaces none before 3:00 at all
    const rs = global.royaleRaidStartAt || 0;
    return !!(rs && now - rs < RAID_EARLY_MS && life < RAID_EARLY_MS);
}
function bossRoot(e) {
    const r = rootOf(e);
    return r && r.isRoyaleBoss && !r.isTutorialBot ? r : null;
}
// Everything a boss hits a player with (guns, turrets, traps, its hull) is
// scaled per boss: the Warden and the Wraith hit too hard for their size.
const BOSS_OUT = { warden: 0.6, wraith: 0.55, colossus: 0.85 };
// Raw damage from `src` into player `p` (collision hook): what lands.
function intoPlayer(p, src, amount, now = Date.now()) {
    if (!(amount > 0)) return amount;
    const root = bossRoot(src);
    if (!root) return amount;
    amount *= BOSS_OUT[root.bossKind] || 1;
    // a fresh life (anyone's): a share of it, never a shield against dying
    if (freshSpared(p, now)) return amount * FRESH_DMG;
    if (!spare || !(p.botNewbie || p.botNewness > 0)) return amount;
    const n = newnessOf(p, now);
    if (!(n > 0)) return amount;
    let dmg = amount * (1 - (1 - NEWBIE_DMG_MIN) * n);
    if (n >= NEWBIE_FLOOR_AT && !(now - (p._hitBossAt || 0) < ATTACK_MS)) {
        // whatever the shield soaks, health never drops under 1 from this
        const room = (p.health?.amount || 0) - 1 - (p.damageReceived || 0);
        dmg = Math.min(dmg, Math.max(0, room));
    }
    return dmg;
}
// Boss guns: how much farther a target counts as (newcomers sit at the back
// of the queue while someone else is in reach).
function aimPenalty(e, now = Date.now()) {
    let r = e, hops = 0;
    while (r && r.master && r.master !== r && hops++ < 8) r = r.master;
    const n = newnessOf(r, now);
    if (!(n > 0) || now - (r._hitBossAt || 0) < ATTACK_MS) return 0;
    return NEWBIE_AIM_PENALTY * n;
}
// The target a boss gun should take from `list` (null: no preference).
function pickTarget(list, from, now = Date.now()) {
    if (!spare || !list || list.length < 2) return null;
    let best = null, bestD = Infinity;
    for (const e of list) {
        const d = Math.hypot(e.x - from.x, e.y - from.y) + aimPenalty(e, now);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}
// A boss gun locked on a newcomer lets go when anyone else is in reach.
function dropNewbieLock(lock, list, now = Date.now()) {
    if (!spare || !lock || !(aimPenalty(lock, now) > 0)) return false;
    for (const e of list) if (e !== lock && !(aimPenalty(e, now) > 0)) return true;
    return false;
}

// Once a tick from bosses.tick: no regen while the boss is under fire.
// `normal` is the boss's usual regenEvery.
function regenGate(boss, normal, now = Date.now()) {
    if (!boss) return;
    boss.regenEvery = enabled && now - (boss.hitAt || 0) < FIGHT_MS ? 1e9 : normal;
}

module.exports = { TANK_DMG_MULT,
    HIT_SHARE, DRONE_HIT_SHARE, BIG_SHOT_HIT_SHARE, BIG_SHOT_SIZE, TANK_SHARE_S, ALL_SHARE_S, FIGHT_MS, NEWBIE_DMG_MIN, ATTACK_MS,
    capHit, regenGate, setEnabled, isEnabled, setRateCap, poolOf, angerOf, ANGER_AT, ANGER_FULL, ANGER_MIN,
    setSpare, setFresh, freshSpared, FRESH_LIFE_MS, RAID_EARLY_MS, BASIC_LIFE_MS, FRESH_DMG, newnessOf, intoPlayer, aimPenalty, pickTarget, dropNewbieLock,
};
