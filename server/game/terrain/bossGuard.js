// Raid bosses take their damage in measured doses, so a boss fight takes
// real time whoever shows up. Without this a grown tank, a Constructor's
// traps or an Annihilator at point blank could drop one in two hits.
//
//   per hit     no single collision tick lands more than HIT_SHARE of the
//               boss's pool (health + shield max)
//   per tank    one tank (its bullets, drones, traps and hull together) gets
//               at most TANK_SHARE_S of the pool through per second
//   all         everyone together at most ALL_SHARE_S per second
//   regen       a boss hit in the last FIGHT_MS does not regenerate (its
//               full-shield health regen alone would out-heal the per tank
//               share)
//
// With the defaults a strong solo player needs at least ~36 s (more when
// they stop to dodge), a group of three ~13-15 s.
// ROYALE_BOSS_CAP=0 turns it off.
//
// The other way round, bosses go easy on new players (botNewness, stamped
// by dig_royale: 1 for the first ~5 minutes / 5 lives, fading to 0 by 12
// minutes / the 9th life):
//   damage      boss bullets, turrets and hull hit a newcomer for
//               NEWBIE_DMG_MIN at full newness, back up to full as it fades
//   last blow   while still mostly new (NEWBIE_FLOOR_AT) a boss cannot take
//               them below 1 health, unless they shot the boss in the last
//               ATTACK_MS (picking that fight is on them)
//   targeting   boss guns take anyone else in reach first
// A player idle for a minute gets none of it. ROYALE_BOSS_NEWBIE=0 turns it
// off.
'use strict';

const HIT_SHARE = 0.0175;
const TANK_SHARE_S = 0.028;
const ALL_SHARE_S = 0.075;
// a second of game time: 30 ticks (wall clock only outside the game loop)
const WINDOW_TICKS = 30, WINDOW_MS = 1000;
const FIGHT_MS = 3000;

const NEWBIE_DMG_MIN = 0.25, NEWBIE_FLOOR_AT = 0.25, ATTACK_MS = 8000, NEWBIE_AIM_PENALTY = 900;

let enabled = process.env.ROYALE_BOSS_CAP !== '0';
let spare = process.env.ROYALE_BOSS_NEWBIE !== '0';
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
    if (!enabled || boss.isTutorialBot) return amount;
    const pool = poolOf(boss);
    let dmg = Math.min(amount, pool * HIT_SHARE);
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
    return dmg;
}

// 0 not new .. 1 brand new, as far as boss mercy goes
function newnessOf(p, now = Date.now()) {
    if (!spare || !p || !p.isPlayer) return 0;
    const n = p.botNewbie ? 1 : +p.botNewness || 0;
    if (!(n > 0) || idle(p, now)) return 0;
    return n > 1 ? 1 : n;
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

module.exports = {
    HIT_SHARE, TANK_SHARE_S, ALL_SHARE_S, FIGHT_MS, NEWBIE_DMG_MIN, ATTACK_MS,
    capHit, regenGate, setEnabled, isEnabled, poolOf,
    setSpare, newnessOf, intoPlayer, aimPenalty, pickTarget, dropNewbieLock,
};
