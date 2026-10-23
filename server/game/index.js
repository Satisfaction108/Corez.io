const CHEST_HITTERS = new Set(["bullet", "drone", "trap", "satellite", "swarm"]);
let chestRam = null;      // terrain/chests.js, loaded on the first ram
const bossGuard = require('./terrain/bossGuard.js');
const MINION_BOSS_DMG = 6;     // a minion's hull into a boss, per touching tick (x its body damage)
const MINION_BOSS_TICKS = 45;  // ticks of contact a minion lasts against a boss
const fs = require('fs');
const path = require('path');
const gems = require('./terrain/gems.js');
const mining = require('./terrain/mining.js');
const vault = require('./terrain/vault.js');
const outposts = require('./terrain/outposts.js');
const shop = require('./terrain/shop.js');
const padGeom = require('./terrain/padGeom.js');
const coreChambers = require('./terrain/coreChambers.js');
const { REGROW: TG_REGROW } = require('./terrain/terrainGrid.js');
const { inEnemyBase } = require('../miscFiles/controllers.js');
const { chamberRingHit, chamberFaceRadius, chamberNormal } = coreChambers;

// Mirror bounce: the ring reflects a shot off the face it struck, keeping its
// speed but redirecting it along the surface normal (grazing shots slide off,
// dead-on shots bounce back).
const REBOUND_KEEP = 0.85;    // how much of the shot's speed survives the bounce
// Bot bullets, drones and traps deal this share of their normal damage
// (into another bot; into a player it follows that player's difficulty)
const BOT_SHOT_MULT = 0.8;
const botDiff = require('../miscFiles/botDifficulty.js');
const fairPlay = require('./terrain/fairPlay.js');
const tier5 = require('./terrain/tier5.js');
const botTanks = require('../miscFiles/botTanks.js');
const botTactics = require('../miscFiles/botTactics.js');
const activity = require('./network/activity.js');
const predictInput = require('./network/predictInput.js');

function deflectBullet(chamber, body) {
    const dx = body.x - chamber.x, dy = body.y - chamber.y;
    const d = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy, dx);
    const { nx, ny } = chamberNormal(chamber, ang);
    // mirror the velocity across the face normal, then keep a little momentum
    const vn = body.velocity.x * nx + body.velocity.y * ny;
    if (vn < 0) {
        body.velocity.x -= 2 * vn * nx;
        body.velocity.y -= 2 * vn * ny;
        body.velocity.x *= REBOUND_KEEP;
        body.velocity.y *= REBOUND_KEEP;
    }
    body.accel.x = 0;
    body.accel.y = 0;
    const outR = chamberFaceRadius(chamber, ang) + (body.realSize || body.size || 1) + 1;
    body.x = chamber.x + nx * outR;
    body.y = chamber.y + ny * outR;
}

function pushOutOfChamberRing(chamber, body) {
    const dx = body.x - chamber.x, dy = body.y - chamber.y;
    const d = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy, dx);
    const { nx, ny } = chamberNormal(chamber, ang);
    const r = body.realSize || body.size || 1;
    const rest = chamberFaceRadius(chamber, ang) + r;
    if (d < rest) {
        body.x += nx * (rest - d);
        body.y += ny * (rest - d);
        const vn = body.velocity.x * nx + body.velocity.y * ny;
        if (vn < 0) {
            body.velocity.x -= vn * nx;
            body.velocity.y -= vn * ny;
        }
        const an = body.accel.x * nx + body.accel.y * ny;
        if (an < 0) {
            body.accel.x -= an * nx;
            body.accel.y -= an * ny;
        }
    }
}

// Advanced collision impulses are soft, so two fast tanks can stay inside each
// other for a frame. Bots must never share a hull with a player or teammate,
// so resolve the remaining penetration after the normal collision response.
let teamModeMod = null;
function teamsLive() {
    try { return (teamModeMod ||= require('./terrain/teamMode.js')).isActive(); } catch { return false; }
}
const TEAM_SOFT = { push: 0.12, deep: 0.55, deepPush: 0.3, spring: 0.035, damp: 0.25 };
const TITAN_SOFT = { push: 0.45, damp: 0.85, carry: 0.6 };
function isTeamTank(e) { return e.type === 'tank' && (e.isPlayer || e.isBot) && !e.isTitan; }
function pairNormal(a, b) {
    let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d < 0.001) {
        const v = a.isTitan ? a.velocity : b.velocity;
        const vl = v ? Math.hypot(v.x, v.y) : 0;
        if (vl > 0.01) { dx = v.x / vl; dy = v.y / vl; }
        else {
            const angle = (((a.id || 0) * 0.754877666) + ((b.id || 1) * 1.324717957)) % (Math.PI * 2);
            dx = Math.cos(angle); dy = Math.sin(angle);
        }
        return { nx: dx, ny: dy, d: 0 };
    }
    return { nx: dx / d, ny: dy / d, d };
}
function softTeamPush(a, b) {
    const ra = a.realSize || a.size || 1, rb = b.realSize || b.size || 1;
    const min = ra + rb;
    const { nx, ny, d } = pairNormal(a, b);
    if (d >= min) return;
    const overlap = min - d;
    const aShare = (rb * rb) / (ra * ra + rb * rb);
    const k = overlap > min * TEAM_SOFT.deep ? TEAM_SOFT.deepPush : TEAM_SOFT.push;
    a.x -= nx * overlap * k * aShare; a.y -= ny * overlap * k * aShare;
    b.x += nx * overlap * k * (1 - aShare); b.y += ny * overlap * k * (1 - aShare);
    const spring = overlap * TEAM_SOFT.spring;
    a.velocity.x -= nx * spring * aShare; a.velocity.y -= ny * spring * aShare;
    b.velocity.x += nx * spring * (1 - aShare); b.velocity.y += ny * spring * (1 - aShare);
    const rel = (b.velocity.x - a.velocity.x) * nx + (b.velocity.y - a.velocity.y) * ny;
    if (rel < 0) {
        const j = -rel * TEAM_SOFT.damp;
        a.velocity.x -= nx * j * aShare; a.velocity.y -= ny * j * aShare;
        b.velocity.x += nx * j * (1 - aShare); b.velocity.y += ny * j * (1 - aShare);
    }
}
function titanPush(titan, body) {
    const rt = titan.realSize || titan.size || 1, rb = body.realSize || body.size || 1;
    const min = rt + rb;
    const { nx, ny, d } = pairNormal(titan, body);
    if (d >= min) return;
    const overlap = min - d;
    const both = !!(body.isTitan || body.isRoyaleBoss);
    const bShare = both ? 0.5 : 1;
    const move = overlap * (d < rt ? Math.max(TITAN_SOFT.push, 1 - d / rt) : TITAN_SOFT.push);
    body.x += nx * move * bShare; body.y += ny * move * bShare;
    if (both) { titan.x -= nx * move * 0.5; titan.y -= ny * move * 0.5; }
    const rel = (body.velocity.x - titan.velocity.x) * nx + (body.velocity.y - titan.velocity.y) * ny;
    if (rel < 0) {
        const j = -rel * TITAN_SOFT.damp;
        body.velocity.x += nx * j * bShare; body.velocity.y += ny * j * bShare;
        if (both) { titan.velocity.x -= nx * j * 0.5; titan.velocity.y -= ny * j * 0.5; }
    }
    if (!both) {
        const carry = (titan.velocity.x * nx + titan.velocity.y * ny) * TITAN_SOFT.carry;
        if (carry > 0) {
            const bv = body.velocity.x * nx + body.velocity.y * ny;
            if (bv < carry) { body.velocity.x += nx * (carry - bv); body.velocity.y += ny * (carry - bv); }
        }
    }
}

function separateBotTanks(first, second) {
    if (first.type !== 'tank' || second.type !== 'tank' ||
        (!first.isBot && !second.isBot)) return;
    if (first.team === second.team && teamsLive()) return;
    const firstRadius = first.realSize || first.size || 1;
    const secondRadius = second.realSize || second.size || 1;
    let dx = second.x - first.x, dy = second.y - first.y;
    let distance = Math.hypot(dx, dy);
    if (distance >= firstRadius + secondRadius) return;
    if (distance < 0.001) {
        const angle = (((first.id || 0) * 0.754877666) + ((second.id || 1) * 1.324717957)) % (Math.PI * 2);
        dx = Math.cos(angle); dy = Math.sin(angle); distance = 1;
    }
    const nx = dx / distance, ny = dy / distance;
    const overlap = firstRadius + secondRadius - distance + 0.75;
    const firstShare = first.isBot && second.isBot ? 0.5 : (first.isBot ? 0.58 : 0.42);
    first.x -= nx * overlap * firstShare;
    first.y -= ny * overlap * firstShare;
    second.x += nx * overlap * (1 - firstShare);
    second.y += ny * overlap * (1 - firstShare);

    const relativeVelocity = (second.velocity.x - first.velocity.x) * nx +
        (second.velocity.y - first.velocity.y) * ny;
    if (relativeVelocity < 0) {
        const impulse = -relativeVelocity * 0.45;
        first.velocity.x -= nx * impulse * firstShare;
        first.velocity.y -= ny * impulse * firstShare;
        second.velocity.x += nx * impulse * (1 - firstShare);
        second.velocity.y += ny * impulse * (1 - firstShare);
    }
}

// The trap push is a spring scaled by 1 / mass, and mass grows with size
// squared, so big set traps (Builder, Constructor, ...) barely feel it. Their
// motor drives them onto the aim point and damps any push, so they end up
// stacked inside each other. Ease the leftover overlap out here, the heavier
// trap moving less. Enemy pairs keep a sliver of overlap so they still grind.
const TRAP_SEPARATE = 0.8;
// A set trap that runs into a trap lying between it and its aim point stops
// there, instead of shoving the pile along until it expires.
function settleSetTrap(trap, other) {
    for (const io of trap.controllers) {
        if (!io.myGoal || !io.countdown) continue;
        const mine = Math.hypot(trap.x - io.myGoal.x, trap.y - io.myGoal.y);
        const theirs = Math.hypot(other.x - io.myGoal.x, other.y - io.myGoal.y);
        if (theirs < mine) io.countdown = 0;
    }
}
function separateTraps(first, second, slack = 0) {
    if (first.bond != null || second.bond != null) return;
    let dx = second.x - first.x, dy = second.y - first.y;
    let distance = Math.hypot(dx, dy);
    if (distance >= first.size + second.size) return;
    settleSetTrap(first, second);
    settleSetTrap(second, first);
    const overlap = first.size + second.size - slack - distance;
    if (overlap <= 0) return;
    if (distance < 0.001) {
        const angle = (((first.id || 0) * 0.754877666) + ((second.id || 1) * 1.324717957)) % (Math.PI * 2);
        dx = Math.cos(angle); dy = Math.sin(angle); distance = 1;
    }
    const nx = dx / distance, ny = dy / distance;
    const firstGive = (first.pushability || 0) / (first.mass || 1);
    const secondGive = (second.pushability || 0) / (second.mass || 1);
    if (firstGive + secondGive <= 0) return;
    const firstShare = firstGive / (firstGive + secondGive);
    const step = overlap * TRAP_SEPARATE;
    first.x -= nx * step * firstShare;
    first.y -= ny * step * firstShare;
    second.x += nx * step * (1 - firstShare);
    second.y += ny * step * (1 - firstShare);

    const closing = (second.velocity.x - first.velocity.x) * nx +
        (second.velocity.y - first.velocity.y) * ny;
    if (closing < 0) {
        first.velocity.x += nx * closing * firstShare;
        first.velocity.y += ny * closing * firstShare;
        second.velocity.x -= nx * closing * (1 - firstShare);
        second.velocity.y -= ny * closing * (1 - firstShare);
    }
}

class gameHandler {
    constructor(parent) {
        this.gameManager = parent;
        this.loopCounter = 0;
        this.loophealCounter = 0;
        this.bots = [];
        this.foods = [];
        this.nestFoods = [];
        this.enemyFoods = [];
        this.auraCollideTypes = ["miniboss", "tank", "food", "crasher"]
        this.naturallySpawnedBosses = [];
        this.bossTimer = 0;
        this.active = false;
        this.botStats = new Map();
        this.botTelemetryAt = Date.now();
        this.soakMspt = [];
        this.soakStartedAt = Date.now();
        this.pendingBotRespawns = 0;
        this.nextBotSpawnAt = 0;
        this.enemyMarkers = [];
        this.botChatAt = 0;
        this.botChatAiAvailable = null;
        this.botChatAiRetryAt = 0;
        Events.on('chatMessage', payload => this.handleBotChat(payload));
    }
    // Keep the simulation alive while bots are present, even if no human has
    // joined a team yet.
    checkUsers = () => global.gameManager.clients.length >= 1 ||
        this.bots.some(bot => bot && !bot.isDead() && !bot.isGhost) ||
        !!Config.bot_soak_mode;

    // Gem and vault systems consume body-like actors. Keep socket players in
    // their existing wrapper shape and append bot bodies, which have no socket.
    gemActors = () => {
        // one reusable buffer: the list is consumed synchronously within a tick
        const actors = this._gemActorsBuf || (this._gemActorsBuf = []);
        actors.length = 0;
        for (const player of global.gameManager.socketManager.players) {
            const body = player && player.body;
            if (body && !body.isDead() && !body.isGhost && !body.adminSpec) actors.push(player);
        }
        for (const bot of this.bots) {
            if (bot && !bot.isDead() && !bot.isGhost) actors.push(bot);
        }
        return actors;
    };

    collide = (instance, other) => {
        if (instance.noclip || other.noclip) return 0;
        // raid perk shots (Twin Drill, Drone Bay) only drill rock: they pass through
        if ((instance.rockOnly && other.type !== "wall") || (other.rockOnly && instance.type !== "wall")) return 0;

        // Remove an existing bot/tank overlap before advancedcollide computes
        // its direction vector; coincident centers otherwise produce NaNs.
        separateBotTanks(instance, other);
        instance.emit('collide', { body: instance, instance, other });
        other.emit('collide', { body: other, instance: other, other: instance });

        if (instance.tickHandler) instance.tickHandler(instance, instance, other);
        if (other.tickHandler) other.tickHandler(other, other, instance);

        if (instance.settings.no_collisions || 
            instance.master.master.settings.no_collisions || 
            other.settings.no_collisions || 
            other.master.master.settings.no_collisions
        )  return 0;

        for (const obj of [instance, other]) {
            if (obj.isGhost || obj.isDead()) {
                // a chest pays out from its own death check, so it is never
                // removed from under it here
                if (obj.isInGrid && !(obj.isLootChest && !obj.isGhost)) {
                    obj.destroy();
                }
                return 0;
            }
        }

        if (
            (instance.isArenaCloser && !instance.alpha) ||
            (other.isArenaCloser && !other.alpha)
        ) return 0;

        if (
            instance.settings.hitsOwnType === "never" &&
            other.settings.hitsOwnType === "never" &&
            instance.team === other.team &&
            instance.type === "wall" && other.type === "wall"
        ) return;
        switch (true) {
            case instance.isPortal || other.isPortal:
                let [portal, otherBody] = instance.isPortal ? [instance, other] : [other, instance];

                if (portal.settings.destination && otherBody.isPlayer && otherBody.socket) {
                    global.gameManager.socketManager.sendToServer(otherBody.socket, portal.settings.destination);
                } else if (["bullet", "drone", "trap", "satellite"].includes(otherBody.type)) {
                    if (otherBody.master !== portal) otherBody.kill();
                }
                else if (!["wall", "aura"].includes(otherBody.type)) advancedcollide(portal, otherBody, false, false);
                break;
            case instance.type === "wall" || other.type === "wall":
                if (instance.type === "wall" && other.type === "wall") return;
                if (instance.type === "aura" || other.type === "aura") return;
                if (instance.type === "satellite" || other.type === "satellite") return;
                let wall = instance.type === "wall" ? instance : other;
                let entity = instance.type === "wall" ? other : instance;
                if (entity.isArenaCloser || entity.master.isArenaCloser) return;
                switch (wall.shape) {
                    case 4:
                        switch (wall.walltype) {
                            case 1:
                                mazewallcollide(wall, entity);
                                break;
                            default:
                                mazewallcustomcollide(wall, entity);
                                break;
                        }
                        break;
                    default:
                        mooncollide(wall, entity);
                        break;
                }
                break;
            case instance.isOutpostBanner || other.isOutpostBanner: {
                const banner = instance.isOutpostBanner ? instance : other;
                const body = instance.isOutpostBanner ? other : instance;
                if (Config.dig_royale && banner.padSite && (body.isPlayer || body.isBot)) {
                    // Dig Royale: the pad's drawn octagon is the wall. Applied inside the physics
                    // pass so a hull stops at the border instead of sinking in and bouncing off.
                    const dr = this._royaleScript || (this._royaleScript = require('./gamemodes/scripts/dig_royale.js'));
                    try { dr.baseWall(body, banner.padSite); } catch { /* */ }
                    if (banner.pinX !== undefined) {
                        banner.x = banner.pinX; banner.y = banner.pinY;
                        banner.velocity.x = 0;  banner.velocity.y = 0;
                        banner.accel.x = 0;     banner.accel.y = 0;
                    }
                    return;
                }
                if (banner.team === body.team) return;
                if (["bullet", "drone", "trap", "satellite", "swarm"].includes(body.type)) {
                    advancedcollide(instance, other, true, true);
                    body.velocity.x = 0; body.velocity.y = 0;
                    body.accel.x = 0;    body.accel.y = 0;
                    body.kill();
                } else {
                    advancedcollide(instance, other, true, true);
                    firmcollide(instance, other, 2);

                    if (banner.pinX !== undefined) {
                        banner.x = banner.pinX; banner.y = banner.pinY;
                        banner.velocity.x = 0;  banner.velocity.y = 0;
                        banner.accel.x = 0;     banner.accel.y = 0;
                    }
                }
            } break;
            case instance.isCoreChamber || other.isCoreChamber: {
                const chamber = instance.isCoreChamber ? instance : other;
                const body = instance.isCoreChamber ? other : instance;
                if (chamber.isDead?.()) break;
                if (!chamberRingHit(chamber, body)) break;
                if (["bullet", "drone", "trap", "satellite", "swarm"].includes(body.type)) {
                    const enemy = chamber.team !== body.team;
                    if (enemy && chamber.chamberAlive) {
                        // the ring drinks hostile fire: absorbed outright
                        advancedcollide(instance, other, true, true);
                        body.velocity.x = 0; body.velocity.y = 0;
                        body.accel.x = 0;    body.accel.y = 0;
                        body.kill();
                    } else {
                        // friendly fire (and drones & friends) mirror off the face
                        deflectBullet(chamber, body);
                    }
                } else {
                    pushOutOfChamberRing(chamber, body);

                    if (chamber.pinX !== undefined) {
                        chamber.x = chamber.pinX; chamber.y = chamber.pinY;
                        chamber.velocity.x = 0;  chamber.velocity.y = 0;
                        chamber.accel.x = 0;     chamber.accel.y = 0;
                    }
                }
            } break;
            case instance.isLootChest || other.isLootChest: {
                // Ore chests are hard cover: a projectile deals its damage
                // (players only, see collisionFunctions) and dies on the rim.
                const chest = instance.isLootChest ? instance : other;
                const hit = chest === instance ? other : instance;
                if (hit.isLootChest || chest.isDead?.() || hit.type === 'wall') break;
                if (CHEST_HITTERS.has(hit.type)) {
                    advancedcollide(instance, other, true, true);
                    hit.velocity.x = 0; hit.velocity.y = 0;
                    hit.accel.x = 0;    hit.accel.y = 0;
                    hit.kill();
                } else {
                    // a hull meets the chest like it meets rock: placed back on
                    // the rim, no bounce; a player ramming it grinds it down
                    const dx = hit.x - chest.x, dy = hit.y - chest.y;
                    const d = Math.hypot(dx, dy) || 1;
                    const min = (chest.realSize || chest.size || 36) + (hit.realSize || hit.size || 30);
                    if (d < min) {
                        const nx = dx / d, ny = dy / d;
                        hit.x += nx * (min - d); hit.y += ny * (min - d);
                        const vIn = hit.velocity.x * nx + hit.velocity.y * ny;
                        if (vIn < 0) { hit.velocity.x -= vIn * nx; hit.velocity.y -= vIn * ny; }
                        // grinding lands through damageReceived like a hit: a
                        // chest killed mid-tick was destroyed by the next thing
                        // touching it, before its death check paid out
                        let root = hit, hops = 0;
                        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
                        // (a chest held for one player only grinds for them)
                        const held = chest.nxOwnerId && chest.nxOwnerUntil > Date.now() && root && root.id !== chest.nxOwnerId;
                        if (root && (root.isPlayer || root.isBot) && chest.health && !held) {
                            let grind = (hit.damage || 0) * 0.35;
                            // the tank's own hull: a ram (chests.ramDamage)
                            if (hit === root && hit.type === 'tank') grind = Math.max(grind, (chestRam ||= require('./terrain/chests.js')).ramDamage(chest, hit));
                            if (grind > 0) { chest.damageReceived += grind; chest.collisionArray.push(hit); }
                        }
                        // a raid boss ploughs straight through: the chest bursts
                        // in a few ticks instead of pinning the boss in place
                        if (root && root.isRoyaleBoss && chest.health && !chest.isRoyaleCore) chest.damageReceived += chest.health.max * 0.34;
                    }
                }
                chest.velocity.x = 0; chest.velocity.y = 0;
                chest.accel.x = 0;    chest.accel.y = 0;
                if (chest.pinX !== undefined) { chest.x = chest.pinX; chest.y = chest.pinY; }
            } break;
            case (instance.isRoyaleBoss && other.type === "minion") || (other.isRoyaleBoss && instance.type === "minion"): {
                // A minion's hull against a raid boss: the plain hull trade
                // killed a 20 health minion in one tick for no damage (the
                // death factor scales what it deals by what it survives), so it
                // vanished into the boss as if it passed through. It's a body:
                // put back on the rim, it grinds the boss (bossGuard measures
                // it like any hit) and the boss grinds it down over a second or so.
                const boss = instance.isRoyaleBoss ? instance : other;
                const min = boss === instance ? other : instance;
                if (boss.isDead?.() || min.isDead?.()) break;
                const dx = min.x - boss.x, dy = min.y - boss.y;
                const d = Math.hypot(dx, dy) || 1;
                const reach = (boss.realSize || boss.size) + (min.realSize || min.size);
                if (d >= reach) break;
                const nx = dx / d, ny = dy / d;
                min.x += nx * (reach - d); min.y += ny * (reach - d);
                const vIn = min.velocity.x * nx + min.velocity.y * ny;
                if (vIn < 0) { min.velocity.x -= vIn * nx; min.velocity.y -= vIn * ny; }
                if (boss.team === min.team) break;
                const raw = (min.damage || 0) * MINION_BOSS_DMG;
                const dealt = bossGuard.capHit(boss, min, raw);
                if (dealt > 0) { boss.damageReceived += dealt; boss.collisionArray.push(min); }
                if (min.health && min.health.max > 0) { min.damageReceived += min.health.max / MINION_BOSS_TICKS; min.collisionArray.push(boss); }
            } break;
            case (instance.isTitan && !other.isRoyaleProtector && (other.type === "tank" || other.isTitan || other.isRoyaleBoss)) ||
                (other.isTitan && !instance.isRoyaleProtector && (instance.type === "tank" || instance.isTitan || instance.isRoyaleBoss)): {
                const titan = instance.isTitan ? instance : other;
                const body = titan === instance ? other : instance;
                if (titan.isDead?.() || body.isDead?.()) break;
                if (titan.team !== body.team) advancedcollide(instance, other, true, true);
                titanPush(titan, body);
            } break;
            case instance.team === other.team && isTeamTank(instance) && isTeamTank(other) &&
                !instance.isDominator && !other.isDominator && teamsLive():
                softTeamPush(instance, other);
                break;
            case instance.team === other.team &&
                (instance.settings.hitsOwnType === "pushOnlyTeam" ||
                    other.settings.hitsOwnType === "pushOnlyTeam"):
                {
                    let pusher = instance.settings.hitsOwnType === "pushOnlyTeam" ? instance : other;
                    let entity = instance.settings.hitsOwnType === "pushOnlyTeam" ? other : instance;

                    if (
                        instance.settings.hitsOwnType === other.settings.hitsOwnType ||
                        entity.settings.hitsOwnType === "never"
                    ) return;
                    let a = 1 + 10 / (Math.max(entity.velocity.length, pusher.velocity.length) + 10);
                    advancedcollide(pusher, entity, false, false, a);
                }
                break;
            case instance.team === other.team &&
                (instance.settings.hitsOwnType === "droneCollision" &&
                    other.settings.hitsOwnType === "droneCollision"):
                {
                    let a = 1 + 10 / (Math.max(instance.velocity.length, other.velocity.length));
                    firmcollide(instance, other, a);
                }
                break;
            case (instance.type === "crasher" && other.type === "food" && instance.team === other.team) ||
                (other.type === "crasher" && instance.type === "food" && other.team === instance.team):
                firmcollide(instance, other);
                break;
            case instance.team !== other.team ||
                (instance.team === other.team && (instance.healer && instance.master.id !== other.id) || (other.healer && other.master.id !== instance.id)):

                if (instance.type === "aura") {
                    if (!(this.auraCollideTypes.includes(other.type))) return;
                } else if (other.type === "aura") {
                    if (!(this.auraCollideTypes.includes(instance.type))) return;
                }
                advancedcollide(instance, other, true, true);
                if (instance.type === "trap" && other.type === "trap" && instance.team !== other.team &&
                    instance.settings.hitsOwnType !== "never" && other.settings.hitsOwnType !== "never" &&
                    !instance.isDead() && !other.isDead()) {
                    separateTraps(instance, other, 1);
                }
                break;
            case instance.settings.hitsOwnType == "never" ||
                other.settings.hitsOwnType == "never":
                break;
            case instance.settings.hitsOwnType === other.settings.hitsOwnType:
                switch (instance.settings.hitsOwnType) {
                    case 'assembler': {
                        if (instance.assemblerLevel == null) instance.assemblerLevel = 1;
                        if (other.assemblerLevel == null) other.assemblerLevel = 1;
                        const [target1, target2] = (instance.id > other.id) ? [instance, other] : [other, instance];
                        if (
                            target2.assemblerLevel >= 10 || target1.assemblerLevel >= 10 ||
                            target1.isDead() || target2.isDead() ||
                            (target1.parent.id !== target2.parent.id &&
                                target1.parent.id != null &&
                                target2.parent.id != null)
                        ) {
                            advancedcollide(instance, other, false, false); 
                            break;
                        }
                        const better = (state) => (target1[state] > target2[state] ? target1[state] : target2[state]);
                        target1.assemblerLevel = Math.min(target2.assemblerLevel + target1.assemblerLevel, 10);
                        target1.SIZE = better('SIZE') * 1.15;
                        target1.SPEED = better('SPEED') * 0.9;
                        target1.HEALTH = better('HEALTH') * 1.2;
                        target1.health.amount = target1.health.max;
                        target1.DAMAGE = better('DAMAGE') * 1.1;
                        target2.kill();
                        target1.refreshBodyAttributes();
                        for (let i = 0; i < 10; ++i) {
                            const o = new Entity(target1, target1);
                            o.define('assemblerEffect');
                            o.team = target1.team;
                            o.color = target1.color;
                            o.SIZE = target1.SIZE / 1.5;
                            o.velocity = new Vector((Math.random() - 0.5) * 25, (Math.random() - 0.5) * 15);
                            o.refreshBodyAttributes();
                            o.life();
                        }
                    } // don't break
                    case "push":
                        advancedcollide(instance, other, false, false);
                        if (instance.settings.hitsOwnType === "push" && instance.type === "trap" && other.type === "trap") {
                            separateTraps(instance, other);
                        }
                        break;
                    case "hard":
                        firmcollide(instance, other);
                        break;
                    case "hardWithBuffer":
                        firmcollide(instance, other, 30);
                        break;
                    case "hardOnlyTanks":
                        if (
                            instance.type === "tank" &&
                            other.type === "tank" &&
                            !instance.isDominator &&
                            !other.isDominator
                        ) {
                            switch (Config.train) {
                                case true:
                                    firmcollidehard(instance, other, 20);
                                    break;
                                default: 
                                    firmcollide(instance, other);
                                    break;
                            }
                        };
                        break;
                    case "hardOnlyBosses":
                        if (instance.type === other.type && instance.type === "miniboss")
                            firmcollide(instance, other);
                        break;
                    case "repel":
                        simplecollide(instance, other);
                        break;
                }
                break;
        }
        // Keep this after the regular response: advancedcollide may move the
        // pair to its time-of-impact and reintroduce a visible overlap.
        separateBotTanks(instance, other);
    };

    gameloop() {
        this._tickStart = performance.now();
        // tick count (terrain/bossGuard.js meters boss damage per 30 ticks)
        global.gameTick = (global.gameTick || 0) + 1;
        predictInput.tick(global.gameManager.clients, Config);
        logs.loops.tally();
        logs.master.set();

        logs.entities.set();
        grid.clear();
        const _prof = this._stageProf || (this._stageProf = { mortality: 0, physics: 0, selfie: 0, misc: 0, aabb: 0, activation: 0, tick: 0 });
        for (const instance of entities.values()) {
            const _p0 = performance.now();
            const _dead = instance.contemplationOfMortality() === 1;
            _prof.mortality += performance.now() - _p0;
            if (_dead) {
                if (Config.outbreak && !instance.zombified && (instance.isPlayer || instance.isBot)) {
                    instance.zombified = true;
                    instance.settings.no_collisions = true;
                    instance.alpha = 0;
                    instance.takeSelfie();
                    Config.OURBREAK_FUNCTIONS.zombify(instance);
                } else instance.destroy();
                continue;
            }

            instance.collisionArray.length = 0;

            // Handle physics only if not bonded
            const _p1 = performance.now();
            if (instance.bond == null) {
                instance.physics();
            }
            _prof.physics += performance.now() - _p1;

            if (instance.activation.active || instance.isPlayer) {
                logs.entities.tally();
                const _lt0 = performance.now();
                instance.life();
                const _lt = performance.now() - _lt0;
                if (_lt > 0.5) { const key = instance.isBot ? "bot" : instance.isPlayer ? "player" : (instance.type || "?"); const prof = this._lifeProf || (this._lifeProf = {}); prof[key] = (prof[key] || 0) + _lt; }
                const _p2 = performance.now();
                instance.takeSelfie();
                _prof.selfie += performance.now() - _p2;
                const _p3 = performance.now();
                instance.friction();
                instance.confinementToTheseEarthlyShackles();
                _prof.misc += performance.now() - _p3;
            }

            // Terrain collision handled by the dedicated terrain loop below

            const _p4 = performance.now();
            instance.updateAABB(instance.activation.active);
            _prof.aabb += performance.now() - _p4;
            const _ct0 = performance.now();
            for (const other of grid.query(instance.minX, instance.minY, instance.maxX, instance.maxY)) {
                this.collide(instance, other);
            }
            this._collideMs = (this._collideMs || 0) + (performance.now() - _ct0);
            if (instance.isInGrid) grid.insert(instance, instance.minX, instance.minY, instance.maxX, instance.maxY);
            if ((instance.touchingSizeWall === false || instance.collisionArray.length === 0) && instance.originalSize) {
                instance.SIZE = instance.originalSize;
                instance.originalSize = undefined;
            }
            if ((instance.touchingFovWall === false || instance.collisionArray.length === 0) && instance.originalFov) {
                instance.FOV = instance.originalFov;
                instance.originalFov = undefined;
            }
            const _p5 = performance.now();
            instance.activation.update();
            _prof.activation += performance.now() - _p5;
            const _p6 = performance.now();
            instance.emit('tick', { body: instance });
            _prof.tick += performance.now() - _p6;
        }
        logs.entities.mark();
        logs.master.mark();
        if (this.terrainPass) {
            try { this.terrainPass(); } catch (e) {
                if (Date.now() - (this._terrainErrAt || 0) > 10000) {
                    this._terrainErrAt = Date.now();
                    console.error('[TERRAIN] pass failed:', e && e.stack || e);
                }
            }
        }
        const _tGaze0 = performance.now();
        this._tickEntMs = _tGaze0 - (this._tickStart || _tGaze0);
        // lastCycle is stamped on an even grid (one cycleSpeed per tick, drifting 10%
        // toward the wall clock), not the raw clock: the client interpolates over the
        // gap between stamps while entities move one fixed step per tick, so raw-clock
        // jitter would show up as micro-stutter.
        {
            const wall = util.time(), step = global.gameManager.room.cycleSpeed, prev = this._stampClock;
            let stamp = prev == null ? wall : prev + step + (wall - (prev + step)) * 0.1;
            if (Math.abs(stamp - wall) > 150) stamp = wall;   // resync after a real stall
            if (prev != null && stamp <= prev) stamp = prev + 1;
            this._stampClock = stamp;
            global.gameManager.room.lastCycle = stamp;
        }
        for (let i = 0; i < global.gameManager.clients.length; i++) {
            let client = global.gameManager.clients[i];
            if (client.status.readyToBroadcast) {
                client.view.gazeUpon();
            }
        }
        this._tickGazeMs = performance.now() - _tGaze0;
    };

    foodloop() {
        if (global.gameManager.arenaClosed) return;

        // Helper to pick a type from a weighted set
        const pickFromChanceSet = (set) => {
            while (Array.isArray(set)) {
                set = set[ran.chooseChance(...set.map(e => e[0]))][1];
            }
            return set;
        };

        // Helper to spawn a food entity
        const spawnFoodEntity = (tile, layeredSet) => {
            const o = new Entity(tile);
            const type = pickFromChanceSet(layeredSet);
            o.define(type);
            o.facing = ran.randomAngle();
            o.team = TEAM_ENEMIES;
            o.isFood = true;
            return o;
        };

        if (Math.random() >= 0.1) return; // 1/10 chance to spawn food

        let totalFoods = 1;
        if (Math.random() < 0.2) { // 1/5 chance to spawn a group
            totalFoods = 1 + Math.floor(Math.random() * Config.food_group_cap);
        }

        // Helper for cleanup interval
        const setupCleanup = (arr, o) => {
            const loop = setInterval(() => {
                if (o.isDead()) {
                    util.remove(arr, arr.indexOf(o));
                    clearInterval(loop);
                }
            }, 1500);
        };

        // Nest food/enemy spawn
        if (Math.random() < 1 / 3 && global.gameManager.room.spawnable[TEAM_ENEMIES]) {
            // Enemy spawn
            if (Config.classic_food && Math.random() < 1 / 3 && this.enemyFoods.length < Config.enemy_cap_nest) {
                const tile = ran.choose(global.gameManager.room.spawnable[TEAM_ENEMIES]).randomInside();
                const o = spawnFoodEntity(tile, Config.classic_enemy_types_nest);
                this.enemyFoods.push(o);
                setupCleanup(this.enemyFoods, o);
            }
            // Nest food spawn
            if (this.nestFoods.length < Config.food_cap_nest) {
                const tile = ran.choose(global.gameManager.room.spawnable[TEAM_ENEMIES]).randomInside();
                for (let i = 0; i < totalFoods; i++) {
                    if (Config.classic_food) {
                        const o = spawnFoodEntity(tile, Config.classic_food_types_nest);
                        this.nestFoods.push(o);
                        setupCleanup(this.nestFoods, o);
                    } else {
                        const o = spawnFoodEntity(tile, Config.food_types_nest);
                        this.nestFoods.push(o);
                        setupCleanup(this.nestFoods, o);
                    }
                }
            }
        } else if (this.foods.length < Config.food_cap) {
            // Regular food spawn
            const tile = ran.choose(global.gameManager.room.spawnableDefault).randomInside();
            for (let i = 0; i < totalFoods; i++) {
                if (Config.classic_food) {
                    const o = spawnFoodEntity(tile, Config.classic_food_types);
                    this.foods.push(o);
                    setupCleanup(this.foods, o);
                } else {
                    const o = spawnFoodEntity(tile, Config.food_types);
                    this.foods.push(o);
                    setupCleanup(this.foods, o);
                }
            }
        }
    }

    regenHealthAndShield() {
        const storm = Config.dig_royale ? require('./terrain/storm.js') : null;
        for (let instance of entities.values()) {
            if (instance._inStorm) continue;
            // raid bosses only heal on one tick in regenEvery (terrain/bosses.js)
            if (instance.regenEvery > 1 && ((instance._regenTick = (instance._regenTick | 0) + 1) % instance.regenEvery)) continue;
            if (storm && storm.inStorm(instance.x, instance.y)) continue;
            if (instance.shield.max) {
                instance.shield.regenerate();
            }
            if (instance.health.amount) {
                instance.health.regenerate(instance.shield.max && instance.shield.max === instance.shield.amount);
            }
        }
    };

    maintainloop = () => {   
        // Upgrade bots's skill
        for (let i = 0; i < this.bots.length; i++) {
            let o = this.bots[i];
            if (o.skill.level < Config.level_cap && o.skill.level >= Config.bot_start_level) {
                o.skill.score += Config.bot_xp_gain;            
            }
        }

        if (this.checkUsers() && Config.enable_bosses && !this.naturallySpawnedBosses.length && this.bossTimer++ > Config.boss_spawn_cooldown) {
            this.bossTimer = -Config.boss_spawn_delay - 2;
            let selection = Config.boss_types[ran.chooseChance(...Config.boss_types.map((selection) => selection.chance))],
                amount = ran.chooseChance(...selection.amount) + 1;
            if (selection.message) {
                global.gameManager.socketManager.broadcast(selection.message);
            }
            global.gameManager.socketManager.broadcast(amount > 1 ? "Visitors are coming." : "A visitor is coming.");
            setSyncedTimeout(() => {
                let names = ran.chooseBossName(selection.nameType, amount);

                for (let i = 0; i < amount; i++) {
                    let spot, attempts = 30, name = names[i];
                    do { spot = getSpawnableArea(TEAM_ENEMIES, global.gameManager); } while (attempts-- && dirtyCheck(spot, 500));

                    let boss = new Entity(spot);
                    boss.define(selection.bosses.sort(() => 0.5 - Math.random())[i % selection.bosses.length]);
                    boss.team = TEAM_ENEMIES;
                    if (name) {
                        boss.name = name;
                    }

                    this.naturallySpawnedBosses.push(boss);
                    boss.on('dead', () => util.remove(this.naturallySpawnedBosses, this.naturallySpawnedBosses.indexOf(boss)));
                }

                global.gameManager.socketManager.broadcast(`${util.listify(names)} ${names.length == 1 ? 'has' : 'have'} arrived!`);
            }, Config.boss_spawn_delay * 30);
        }
    };

    botSpawnTeam() {
        if (Config.mode !== 'tdm' && Config.mode !== 'tag') return undefined;
        const totals = { [TEAM_BLUE]: 0, [TEAM_RED]: 0 };
        for (const player of global.gameManager.socketManager.players) {
            const body = player && player.body;
            if (body && body.team in totals) totals[body.team] += (body.bankedGems || 0) + (body.carriedGems || 0);
        }
        for (const bot of this.bots) {
            if (bot && !bot.isDead() && bot.team in totals)
                totals[bot.team] += (bot.botBanked || 0) + (bot.carriedGems || 0);
        }
        if (Math.abs(totals[TEAM_BLUE] - totals[TEAM_RED]) >= 100)
            return this.botBalancedTeam(totals[TEAM_BLUE] < totals[TEAM_RED] ? TEAM_BLUE : TEAM_RED);
        return this.botBalancedTeam(getWeakestTeam(global.gameManager));
    }

    botTeamCount(team) {
        let count = 0;
        for (const bot of this.bots) if (bot && !bot.isDead() && bot.team === team) count++;
        return count;
    }

    // Per-team ceiling on bots. Whatever picked the team (gem balance, weakest
    // team, or a respawning bot keeping its old side), a full team hands the slot
    // to the other side instead of stacking past the cap.
    botBalancedTeam(preferred) {
        if (preferred !== TEAM_BLUE && preferred !== TEAM_RED) return preferred;
        const cap = Config.bot_team_cap || Infinity;
        if (this.botTeamCount(preferred) < cap) return preferred;
        const other = preferred === TEAM_BLUE ? TEAM_RED : TEAM_BLUE;
        return this.botTeamCount(other) < cap ? other : preferred;
    }

    addEnemyMarker(team, x, y, by) {
        const now = Date.now();
        this.enemyMarkers = this.enemyMarkers.filter(marker =>
            marker.expiresAt > now && !(marker.team === team && marker.by === by)
        );
        this.enemyMarkers.push({ team, x, y, by, expiresAt: now + 20_000 });
        if (this.enemyMarkers.length > 16) this.enemyMarkers.splice(0, this.enemyMarkers.length - 16);
    }

    activeEnemyMarkers(team) {
        const now = Date.now();
        this.enemyMarkers = this.enemyMarkers.filter(marker => marker.expiresAt > now);
        return this.enemyMarkers.filter(marker => marker.team === team);
    }

    configureBotStats(bot) {
        const kind = botTanks.buildKind(bot);
        // ram tanks (definitions/ramTanks.js) build like a smasher
        const rammer = !bot.guns || bot.guns.size === 0 || kind === 'ram' || kind === 'ramAuto';
        const defs = (bot.defs || []).join(' ').toLowerCase();
        // A 35-point base (a level-45 player has 50), shaped like the builds
        // players win with, per class archetype, so a player who spends their
        // points out-stats the bot. Bullet health must stay high enough that
        // max-pen player builds don't delete bot bullets on contact.
        // Order: [rld, pen, str, dam, spd, shi, atk, hlt, rgn, mob].
        // 11th slot is mining power: bots dig like a player who bought in (a
        // little deeper than before the combat cut, so they still dig as fast)
        // the expanded tree (miscFiles/botTanks.js buildKind)
        bot.botDroneSteer = kind === 'drone';
        let raw;
        if (rammer && kind === 'ramAuto') raw = [2, 3, 2, 3, 0, 5, 6, 6, 3, 4, 7];
        else if (rammer) raw = [0, 0, 0, 0, 0, 7, 7, 7, 5, 8, 7];
        else if (kind === 'drone') raw = [5, 6, 5, 7, 6, 0, 0, 2, 0, 4, 7];
        else if (kind === 'trap') raw = [7, 6, 7, 7, 1, 0, 0, 4, 0, 3, 7];
        else if (kind === 'sniper') raw = [5, 7, 3, 7, 6, 0, 0, 3, 0, 4, 7];
        else if (kind === 'heavy') raw = [5, 7, 6, 7, 2, 0, 0, 4, 0, 4, 7];
        else if (/sniper|assassin|ranger|marksman|stalker|rifle|predator|hunter|deadeye|sidewinder|musket|crossbow/.test(defs))
            raw = [5, 7, 3, 7, 6, 0, 0, 3, 0, 4, 7];
        else if (/destroyer|artillery|mortar|launcher|ordnance|annihilator|hybrid/.test(defs))
            raw = [5, 7, 6, 7, 2, 0, 0, 4, 0, 4, 7];
        else
            raw = [7, 6, 5, 7, 3, 0, 0, 3, 0, 4, 7];
        // High-skill bots invest a little deeper, up to ~5 extra points spread
        // over the stats they already use.
        let bonus = Math.round(util.clamp(bot.botSkill ?? 0.5, 0, 1) * 6);
        for (let pass = 0; pass < 3 && bonus > 0; pass++) {
            for (let i = 0; i < raw.length && bonus > 0; i++) {
                if (raw[i] > 0 && raw[i] < 9) { raw[i]++; bonus--; }
            }
        }
        if (bot.botMinnow) raw = fairPlay.minnowRaw(raw);
        bot.skill.set(raw);
        bot.skill.points = 0;
        bot.skill.update();
        bot.botStatTotal = raw.reduce((sum, value) => sum + value, 0);
        bot.botIsRammer = rammer;
        bot.refreshBodyAttributes();
        bot.syncSkillsToGuns();
    }

    coordinateBotPushes() {
        const now = Date.now();
        const byTeam = new Map();
        for (const bot of this.bots) {
            if (!bot || bot.isDead() || bot.isGhost || bot.team == null) continue;
            // A bot the director sent toward a player must not also be drafted into an
            // outpost push on the far side of the map; the two would pull it opposite ways.
            if ((bot._botDirectorUntil || 0) > now) {
                bot._botPushTarget = null;
                bot._botPushTargetUntil = 0;
                continue;
            }
            if (!byTeam.has(bot.team)) byTeam.set(bot.team, []);
            byTeam.get(bot.team).push(bot);
        }
        for (const members of byTeam.values()) {
            // Group squads by proximity so they can actually push together: take whoever
            // is left, then pull in its two nearest unassigned teammates.
            const pool = members.slice();
            const squads = [];
            while (pool.length) {
                const lead = pool.shift();
                pool.sort((a, b) =>
                    Math.hypot(a.x - lead.x, a.y - lead.y) - Math.hypot(b.x - lead.x, b.y - lead.y));
                const squad = [lead];
                // only recruit people close enough to genuinely fight alongside
                while (squad.length < 3 && pool.length &&
                       Math.hypot(pool[0].x - lead.x, pool[0].y - lead.y) < 2200) {
                    squad.push(pool.shift());
                }
                squads.push(squad);
            }
            for (const squad of squads) {
                // Chambers count as push targets too. Solo bots cannot out-damage a
                // chamber's self-heal, so chambers only ever fall to a squad.
                const candidate = squad.find(bot =>
                    bot._digWarsGoal === 'objective' &&
                    (bot._digWarsObjectiveKind === 'outpost' || bot._digWarsObjectiveKind === 'chamber') &&
                    bot._digWarsObjectivePoint
                );
                const existing = squad.find(bot =>
                    bot._botPushTarget && (bot._botPushTargetUntil || 0) > now &&
                    (bot._botPushTarget.team === 0 || bot._botPushTarget.team !== bot.team)
                );
                const target = candidate?._digWarsObjectivePoint || existing?._botPushTarget || null;
                const markers = this.activeEnemyMarkers(squad[0].team);
                const marker = markers.sort((a, b) => {
                    const da = Math.min(...squad.map(bot => Math.hypot(bot.x - a.x, bot.y - a.y)));
                    const db = Math.min(...squad.map(bot => Math.hypot(bot.x - b.x, bot.y - b.y)));
                    return da - db;
                })[0] || null;
                for (let slot = 0; slot < squad.length; slot++) {
                    const bot = squad[slot];
                    bot._botPushSlot = slot;
                    bot._botPushSize = squad.length;
                    bot._botPushTarget = target;
                    bot._botPushTargetUntil = target ? now + 3000 : 0;
                    bot._botHelpMarker = marker;
                }
            }
        }
    }

    botTankExclusions() {
        // The editable checklist is the source of truth, read at selection time so an
        // admin can change [x] entries and restart the match without a code edit. A
        // missing file means no extra exclusions beyond the built-in filters below.
        // The maintain loop asks for it per bot with an upgrade pending, so a
        // read is kept for a few seconds (a synchronous file read per call
        // was ~2% of a raid worker). Callers only read the set.
        const now = Date.now();
        const cached = this._botExclCache;
        if (cached && now - cached.at < 5000) return cached.set;
        const set = this._readBotTankExclusions();
        this._botExclCache = { at: now, set };
        return set;
    }

    _readBotTankExclusions() {
        try {
            const checklist = fs.readFileSync(
                path.join(__dirname, '..', '..', 'BOT_TANK_CHECKLIST.md'),
                'utf8'
            );
            const excluded = new Set();
            for (const rawLine of checklist.split(String.fromCharCode(10))) {
                const line = rawLine.trim();
                if (!line.toLowerCase().startsWith('- [x]')) continue;
                const start = line.indexOf('(`');
                const end = start < 0 ? -1 : line.indexOf('`)', start + 2);
                if (start >= 0 && end > start + 2) {
                    excluded.add(line.slice(start + 2, end).trim().toLowerCase());
                }
            }
            return excluded;
        } catch {
            return new Set();
        }
    }

    // Relative pick weights per class key (lowercase); unlisted keys weigh 1.
    // Stronger meta tanks weigh more, and the tier 1-2 branches leading to them are
    // boosted too or the final-tier weights would never matter. This only shapes
    // odds; the max-2-per-tank rule below is what stops a lobby of copies.
    static BOT_TANK_WEIGHTS = {
        // tier 1 branches
        twin: 3, machinegun: 3, flankguard: 3, pounder: 3, sniper: 2,
        // tier 2 branches
        tripleshot: 4, gunner: 3, minigun: 3, sprayer: 3, triangle: 4,
        hexatank: 3, destroyer: 4, assassin: 3, hunter: 3, launcher: 2,
        // tier 3 finals
        pentashot: 6, spreadshot: 6, triplet: 6, octotank: 6, streamliner: 6,
        annihilator: 6, fighter: 6, booster: 6, predator: 5, ranger: 5,
        hybrid: 4, autogunner: 4, cyclone: 4, tripletwin: 4, gunnertrapper: 4,
        redistributor: 4, conqueror: 3, skimmer: 3, sidewinder: 3,
    };

    // Walks a fresh bot up to a tier 3 tank on the spot (no upgrade
    // timers, nobody sees a Basic or a Twin). Same two-of-a-kind rule as
    // botUpgradeIndex.
    botStartTank(o, same = null) {
        // a small fish stops a tier short (terrain/fairPlay.js)
        const pathOf = (c) => o.botMinnow ? fairPlay.minnowPath(c.path) : c.path;
        // a bot respawning as itself climbs back into its own tank
        let own = same ? botTanks.pool(this.botTankExclusions()).find(c => c.name === same || (o.botMinnow && fairPlay.minnowPath(c.path)[1] === same)) : null;
        // a Tier 5 tank (expanded tree): back through its Tier 4 parent
        if (!own && same && !o.botMinnow) { const p = botTanks.pathFor(same); if (p && p.length === 4) own = { name: same, path: p }; }
        if (own && (botTanks.climb(o, pathOf(own)) || (own.path.length === 4 && (o.defs && o.defs[0]) === own.path[2]))) {
            o.botRammerAllowed = false; o.leftoverUpgrades = 0;
            this.configureBotStats(o);
            return true;
        }
        const counts = new Map();
        for (const other of this.bots) {
            if (!other || other === o || other.isDead?.()) continue;
            const key = String(other.defs?.[0] || '').toLowerCase();
            if (key) counts.set(key, (counts.get(key) || 0) + 1);
            if (other.defs?.[0] && botTanks.kindOf(other.defs[0]).drone) counts.droneBots = (counts.droneBots || 0) + 1;
        }
        const choice = botTanks.pick(this.botTankExclusions(), counts);
        if (!choice) return false;
        o.botRammerAllowed = false;
        if (!botTanks.climb(o, pathOf(choice))) return false;
        // When Tier 5 is unlocked from spawn (T5_GROWTH <= 1), ~55% of non-minnow bots also step into a Tier 5 tank for variety
        if (!o.botMinnow && tier5.T5_GROWTH <= 1 && Math.random() < 0.55) {
            try { botTanks.tier5Up(o, this, counts); } catch { /* */ }
        }
        o.leftoverUpgrades = 0;
        this.configureBotStats(o);
        return true;
    }

    botUpgradeIndex(bot) {
        if (!bot.upgrades?.length) return null;
        const options = bot.upgrades.map((upgrade, index) => ({ upgrade, index }));
        const excluded = this.botTankExclusions();
        const classIdsFor = ({ upgrade }) => {
            const classes = Array.isArray(upgrade.class) ? upgrade.class : [upgrade.class];
            return [upgrade.index, ...classes.map(entry =>
                typeof entry === 'string' ? entry : entry?.index || entry?.LABEL || '')]
                .filter(Boolean)
                .map(value => String(value).trim().toLowerCase());
        };
        const textFor = option => classIdsFor(option).join(' ');
        const rammer = /(?:^|[-_ ])(?:smasher|spike|landmine|autosmasher|megasmasher|jumpsmasher|bonker|mace|flail)(?:$|[-_ ])/i;
        const weak = /director|desmos|healer|overseer|underseer|spawner|cruiser|carrier|battleship|factory|manager|overlord|overtrapper|necromancer|maleficitor|infestor/;
        let usable = options.filter(option => {
            const ids = classIdsFor(option);
            if (ids.some(id => excluded.has(id))) return false;
            const text = textFor(option);
            if (bot.botRammerAllowed) return rammer.test(text);
            return !rammer.test(text) && !weak.test(text);
        });
        // A permitted rammer may have already taken its one body branch; keep
        // it alive rather than forcing a random weak upgrade afterward.
        if (!usable.length && bot.botRammerAllowed)
            usable = options.filter(option =>
                !classIdsFor(option).some(id => excluded.has(id)) &&
                !weak.test(textFor(option))
            );
        if (!usable.length) usable = options.filter(option =>
            !classIdsFor(option).some(id => excluded.has(id)) &&
            !rammer.test(textFor(option)) &&
            !weak.test(textFor(option))
        );
        if (!usable.length) return null;
        // Lobby variety: at most two living bots may be the same tank at once. Drop
        // options that would make a third copy, unless that removes every option.
        const classCounts = new Map();
        for (const other of this.bots) {
            if (!other || other === bot || other.isDead?.()) continue;
            const key = String(other.defs?.[0] || '').toLowerCase();
            if (key) classCounts.set(key, (classCounts.get(key) || 0) + 1);
        }
        const keysFor = option => String(option.upgrade.index).toLowerCase().split('-');
        const uncrowded = usable.filter(option =>
            keysFor(option).every(key => (classCounts.get(key) || 0) < 2));
        const pool = uncrowded.length ? uncrowded : usable;
        // Weighted pick so stronger tanks show up more often than filler.
        const weightFor = option => Math.max(...keysFor(option).map(key =>
            this.constructor.BOT_TANK_WEIGHTS[key] || 1));
        let total = 0;
        for (const option of pool) total += weightFor(option);
        let roll = Math.random() * total;
        for (const option of pool) {
            roll -= weightFor(option);
            if (roll <= 0) return option.index;
        }
        return pool[pool.length - 1].index;
    }

    quickMaintainLoop = () => {
        this.coordinateBotPushes();
        this.directorTick();
        const now = Date.now();
        for (let i = 0; i < this.bots.length; i++) {
            let o = this.bots[i];
            if (!o.botStatsFixed) {
                o.skill.maintain();
                o.skillUp([ "atk", "hlt", "spd", "str", "pen", "dam", "rld", "mob", "rgn", "shi", "min" ][ran.chooseChance(...Config.bot_skill_upgrade_chances)]);
                o.refreshSkills();
            }
            const upgradeIndex = o.botStatsFixed ? this.botUpgradeIndex(o) : ran.irandomRange(0, o.upgrades.length);
            // Entity.upgrade() returns no success flag, so watch the class id. A failed
            // pick means this tank is done upgrading: dump the rest instead of waiting.
            if (o.leftoverUpgrades && now >= (o.botNextUpgradeAt || 0)) {
                const prev = o.defs?.[0];
                if (upgradeIndex !== null) o.upgrade(upgradeIndex);
                if (o.defs?.[0] !== prev) {
                    o.leftoverUpgrades--;
                    o.botDidUpgrade = true;
                    o.botNextUpgradeAt = now + 650 + Math.floor(Math.random() * 250);
                    if (!o.leftoverUpgrades) o.botSettleAt = now + 400;
                    if (o.botStatsFixed) this.configureBotStats(o);
                } else {
                    o.leftoverUpgrades = 0;
                    o.botSettleAt = now + (o.botDidUpgrade ? 400 : 0);
                }
            }
            if (!o.botArmed && now >= (o.botWakeAt || 0)) {
                const settling = o.botDidUpgrade && now < (o.botSettleAt || 0);
                const stuck = now >= (o.botWakeAt || 0) + 8000;
                if ((!o.leftoverUpgrades && !settling) || stuck) this.armBot(o);
            }
        }

        // nobody connected: stop refilling, and after a while stand the bots down
        const anyClients = (global.gameManager.socketManager?.clients || []).length > 0 || !!Config.bot_soak_mode;
        if (!anyClients) {
            if (!this._idleSince) this._idleSince = now;
            else if (now - this._idleSince > 45_000 && this.bots.length) {
                for (const b of this.bots.slice()) { try { b.invuln = false; b.kill(); } catch { /* */ } }
            }
        } else this._idleSince = 0;
        if (anyClients && !global.gameManager.arenaClosed && !global.cannotRespawn && !Config.dig_royale &&
            this.bots.length + this.pendingBotRespawns < Config.bot_cap && Date.now() >= this.nextBotSpawnAt) {
            this.nextBotSpawnAt = Date.now() + 900 + Math.random() * 700;
            let team = this.botSpawnTeam(),
            limit = 20, 
            loc;
            do {
                loc = this.botSpawnLocation(team);
            } while (limit-- && dirtyCheck(loc, 50, global.gameManager))

            this.spawnBots(loc, team);
        }

        // Keep the lobby's player count honest as bots spawn and die, not
        // just when a human connects or leaves.
        if (global.gameManager.parentPort && global.gameManager.reportedPlayerCount) {
            const reported = global.gameManager.reportedPlayerCount();
            if (reported !== this._lastReportedCount) {
                this._lastReportedCount = reported;
                global.gameManager.parentPort.postMessage([true, reported]);
            }
        }
    }

    // Keeps the world feeling inhabited. A player sees only ~618 units of a
    // multi-thousand-unit world, so free-roaming bots diffuse and the server looks
    // dead. This nudges a few of the nearest idle bots toward each player. It never
    // teleports or targets the player directly: it sets a destination in their
    // region and lets the bot drive there.
    directorTick() {
        const now = Date.now();
        // Players under mercy are not hosts: don't funnel fresh bots toward someone
        // who is already losing (unless they stopped playing: idle is no mercy).
        const humans = (this.socketManagerPlayers?.() || [])
            .filter(b => b && !b.isDead?.() && !b.isGhost &&
                (!((b.socket?.botMercyUntil || 0) > now) || activity.unprotected(b, now)));
        if (!humans.length) return;

        const live = this.bots.filter(b => b && !b.isDead() && !b.isGhost);
        if (!live.length) return;

        // NEAR must stay close to what the player can actually SEE (~618 units), or
        // bots two screens away count as company and the director idles while the
        // player sees nobody. 900 = on screen or one beat from walking onto it.
        // Two is company; four was a pack closing on one player. How many
        // follows the player's bot difficulty: one for a newcomer, three for
        // the best (miscFiles/botDifficulty.js company).
        const NEAR = 900;
        const teamLayout = Config.royale_teams && Config.dig_royale && !Config.tutorial ? require('./terrain/teamLayout.js') : null;
        for (const host of humans) {
            const WANT = botDiff.company(botDiff.of(host, now));
            const near = live.filter(b => Math.hypot(b.x - host.x, b.y - host.y) <= NEAR);
            if (near.length >= WANT) continue;

            // a protected player (terrain/fairPlay.js) gets the small fish first and never a
            const prot = fairPlay.isProtected(host, now);
            if (teamLayout && teamLayout.isTeam(host.team)) {
                this.directTeamCompany(host, live, near, WANT - near.length, prot, now, teamLayout);
                continue;
            }
            const candidates = live
                .filter(b => !near.includes(b) && now >= (b._botDirectorUntil || 0) && !(prot && fairPlay.isBig(b)) &&
                    // a bait has its own host
                    !b._fpBait && !fairPlay.farmed(b, host, now))
                .sort((a, b) => (prot ? (b.botMinnow ? 1 : 0) - (a.botMinnow ? 1 : 0) : 0) ||
                    Math.hypot(a.x - host.x, a.y - host.y) - Math.hypot(b.x - host.x, b.y - host.y));

            for (const bot of candidates.slice(0, WANT - near.length)) {
                const angle = Math.random() * Math.PI * 2;
                // Stay inside NEAR: a bot dropped past it does not count as company, so the
                // director would re-task somebody else for the same player.
                const dist = 380 + Math.random() * 440;
                bot._botDirectorPoint = {
                    x: host.x + Math.cos(angle) * dist,
                    y: host.y + Math.sin(angle) * dist,
                };
                // long enough to walk there on a compact map, then free to be re-tasked
                // (a bigger raid map gives the walk longer: terrain/mapScale.js)
                bot._botDirectorUntil = now + Math.round(14000 * require('./terrain/mapScale.js').lin());
            }
        }
    }

    directTeamCompany(host, live, near, need, prot, now, L) {
        if (need <= 0) return;
        if (L.inBase(host.team, host.x, host.y, 200) || L.inDroneZone(host.team, host.x, host.y, 150)) return;
        const free = b => !near.includes(b) && now >= (b._botDirectorUntil || 0) && !b._fpBait;
        const fromHost = b => Math.hypot(b.x - host.x, b.y - host.y);
        const mates = live.filter(b => b.team === host.team && free(b)).sort((a, b) => fromHost(a) - fromHost(b));
        const foes = live.filter(b => b.team !== host.team && L.isTeam(b.team) && free(b) &&
            !(prot && fairPlay.isBig(b)) && !fairPlay.farmed(b, host, now))
            .sort((a, b) => (prot ? (b.botMinnow ? 1 : 0) - (a.botMinnow ? 1 : 0) : 0) || fromHost(a) - fromHost(b));
        const walk = Math.round(14000 * require('./terrain/mapScale.js').lin());
        let turn = 0;
        while (need > 0 && (mates.length || foes.length)) {
            const pickFoe = foes.length > 0 && (!mates.length || turn % 2 === 1);
            const bot = pickFoe ? foes.shift() : mates.shift();
            turn++;
            const dist = 380 + Math.random() * 440;
            let angle = Math.random() * Math.PI * 2;
            if (pickFoe) {
                const home = L.sitesFor(bot.team).mouth;
                angle = Math.atan2(home.y - host.y, home.x - host.x) + (Math.random() - 0.5) * 1.8;
            }
            const x = host.x + Math.cos(angle) * dist, y = host.y + Math.sin(angle) * dist;
            const enemyOf = pickFoe ? host.team : L.other(host.team);
            if (L.inBase(enemyOf, x, y, 150) || L.inDroneZone(enemyOf, x, y, 150)) continue;
            bot._botDirectorPoint = { x, y };
            bot._botDirectorUntil = now + walk;
            need--;
        }
    }

    socketManagerPlayers() {
        return (global.gameManager.socketManager?.players || [])
            .map(p => p && p.body)
            .filter(b => b && b.isPlayer);
    }

    // Base at match start. Once the team holds an outpost, mix home and pad so
    // they don't all pour out of one hole; never the open map.
    botSpawnLocation(team) {
        const base = () => getSpawnableArea(team, global.gameManager);
        const pads = typeof outposts.ownedBy === "function" ? outposts.ownedBy(team) : [];
        if (!pads.length || Math.random() < 0.4) return base();
        const pad = ran.choose(pads);
        const a = Math.random() * Math.PI * 2;
        const loc = {
            x: pad.x + Math.cos(a) * (pad.r || 95) * 0.4,
            y: pad.y + Math.sin(a) * (pad.r || 95) * 0.4,
        };
        global.gameManager.terrainGrid?.pushCircleFromVoronoi?.(loc, 60);
        if (inEnemyBase(team, loc.x, loc.y)) return base();
        return loc;
    }

    // Sit still and invuln until upgrades finish, then hand the tank its AI.
    armBot(o) {
        if (!o || o.isDead() || o.botArmed) return;
        o.botArmed = true;
        const botName = o.name;
        let CC = Class[o.defs[0]];
        if (!CC) CC = {};
        o.controllers = [];
        o.define({
            CONTROLLERS: CC.CONTROLLERS ? [...Class.bot.CONTROLLERS, ...CC.CONTROLLERS] : Class.bot.CONTROLLERS,
            FACING_TYPE: CC.FACING_TYPE ? CC.FACING_TYPE : Class.bot.FACING_TYPE,
            AI: Class.bot.AI,
        }, false, true, false);
        if (CC && CC.HEALING_TANK) {
            o.controllers = [];
            o.define({
                CONTROLLERS: ["healTeamMasters", "minion", ["wanderAroundMap", { replicatePlayerMovement: true, lookAtGoal: true }]],
                FACING_TYPE: CC.FACING_TYPE ? CC.FACING_TYPE : Class.bot.FACING_TYPE,
                AI: Class.bot.AI,
            }, false, true, false);
        }
        o.name = botName;
        this.configureBotStats(o);
        o.refreshBodyAttributes();
        o.invuln = false;
        o.on("define", () => {
            let next = Class[o.defs[0]];
            if (next && next.HEALING_TANK) {
                o.controllers = [];
                o.define({
                    CONTROLLERS: ["healTeamMasters", "minion", ["wanderAroundMap", { replicatePlayerMovement: true, lookAtGoal: true }]],
                    FACING_TYPE: next.FACING_TYPE ? next.FACING_TYPE : Class.bot.FACING_TYPE,
                    AI: Class.bot.AI,
                }, false, true, false);
            } else {
                const wantControllers = (next && next.CONTROLLERS)
                    ? [...Class.bot.CONTROLLERS, ...next.CONTROLLERS]
                    : Class.bot.CONTROLLERS;
                if (!o.controllers || !o.controllers.length) {
                    o.define({ CONTROLLERS: wantControllers }, false, true, false);
                }
            }
            o.define({ FACING_TYPE: next && next.FACING_TYPE ? next.FACING_TYPE : Class.bot.FACING_TYPE, AI: Class.bot.AI, }, false, true, false);
            this.configureBotStats(o);
        });
    }

    spawnBots(loc, team, existingName = null, lifecycle = null) {
        const nameKey = lifecycle?.nameKey || (existingName ? null : ran.chooseBotName());
        let botName = existingName || Config.bot_name_prefix + nameKey;
        let o = new Entity(loc);
        o.define(Config.spawn_class);
        o.controllers = [];
        o.refreshBodyAttributes();
        o.isBot = true;
        // Bots are exempt from view-based activation: their AI must keep simulating
        // before any camera reaches them.
        o.alwaysActive = true;
        o.botFamilyId = lifecycle?.familyId ?? o.id;
        o.botNameKey = nameKey;
        o.botRespawnsRemaining = lifecycle?.respawnsRemaining ?? ran.irandomRange(2, 3);
        // This value changes decisions, not damage or movement stats. A broad
        // spread keeps a lobby from feeling like eight copies of one machine.
        o.botSkill = util.clamp(ran.gauss(0.4, 0.2), 0.08, 0.8);
        // every bot shot lands softer than a player's (subFunctions shotMult)
        o.botShotMult = BOT_SHOT_MULT;
        // A few bots are playful instead of perfectly task-focused. Their
        // showoff moments are brief and never interrupt an actual player fight.
        o.botStyle = ran.choose(['normal', 'normal', 'normal', 'dancer', 'spinner']);
        o.botTemperament = Config.dig_royale
            ? ran.choose(['aggressive', 'aggressive', 'aggressive', 'balanced'])
            : ran.choose(['aggressive', 'aggressive', 'balanced', 'balanced', 'passive']);
        // Body-only tanks are rare (about one rammer in fifty bots). The upgrade
        // picker below forces the body branch only for this group.
        o.botRammerAllowed = ran.chance(0.02);
        // a small fish (terrain/fairPlay.js): weak tank, few points, low skill
        if (Config.dig_royale && lifecycle?.minnow) { fairPlay.makeMinnow(o); o.botRammerAllowed = false; }
        // ...and a first-kill fish's family comes back as one all raid (fairPlay fodder)
        else if (Config.dig_royale && fairPlay.isFodder(o)) { fairPlay.makeMinnow(o); o.botRammerAllowed = false; fairPlay.applyFodder(o); }
        o.name = botName;
        o.invuln = true;
        o.leftoverUpgrades = ran.chooseChance(...Config.bot_class_upgrade_chances);
        o.botWakeAt = Config.dig_royale ? 0 : Date.now() + 2000;
        o.botNextUpgradeAt = o.botWakeAt;
        o.botArmed = false;
        o.botDidUpgrade = false;
        o.botSettleAt = 0;
        let color = Config.dig_royale ? global.assignTeamColor(team)
            : (Config.random_body_colors ? Math.floor(Math.random() * 20) : team ? getTeamColor(team) : "darkGrey");
        o.color.base = color;
        o.leaderboardColor = color;
        o.minimapColor = color;
        o.skill.reset();
        while (o.skill.level < Config.bot_start_level) {
            o.skill.score += o.skill.levelScore;
            o.skill.maintain();
        }
        this.configureBotStats(o);
        o.botStatsFixed = true;
        // Dig Royale: straight into a final tank from the bot pool
        if (Config.dig_royale && botTanks.isEnabled()) {
            this.botStartTank(o, lifecycle?.tank);
            o.leftoverUpgrades = 0;
            this.armBot(o);
        }
        // ...with dash and one secondary ability (miscFiles/botTactics.js)
        if (Config.dig_royale) botTactics.equipBot(o, this.bots, Math.random, lifecycle?.ability);
        if (Config.dig_royale) o.botRespawnsRemaining = 0;
        if (team) o.team = team;
        if (Config.dig_wars || Config.dig_royale) gems.initSatchel(o);
        // Last enemy that damaged this tank: the goal controller uses it for a short
        // "fight back or run" reaction instead of mining through incoming fire.
        o.on('damage', ({ damageInflictor = [], amount = 0 }) => {
            const attacker = damageInflictor
                .map(source => {
                    let root = source, hops = 0;
                    while (root?.master && root.master !== root && hops++ < 8) root = root.master;
                    return root;
                })
                .find(root => root && root.team !== o.team && (root.isBot || root.isPlayer));
            if (attacker) {
                o._lastDamageSource = attacker;
                o._lastDamageAt = Date.now();
                // cumulative damage per attacker this life (fairPlay.provoked: a protected player
                if (amount > 0) {
                    const m = o._dmgBy || (o._dmgBy = new Map());
                    m.set(attacker.id, (m.get(attacker.id) || 0) + amount);
                    if (m.size > 24) m.delete(m.keys().next().value);
                }
                // and the shooter is in a fight too (dig_royale's reload rule)
                attacker._dealtAt = o._lastDamageAt;
                // a fresh spawn (player or bot) that shoots a bot has ended its
                // own bot grace (dig_royale FIRST_MINUTES; read in controllers.js)
                if (attacker.botGraceUntil) attacker.botGraceUntil = 0;
                // Tell the team: nearby teammates rally to this marker, so a skirmish grows
                // into a fight.
                if (Date.now() - (o._lastMarkerAt || 0) > 8000) {
                    o._lastMarkerAt = Date.now();
                    this.addEnemyMarker(o.team, attacker.x, attacker.y, o.id);
                }
            }
        });
        o.on('kill', ({ entity } = {}) => {
            let victim = entity, hops = 0;
            while (victim?.master && victim.master !== victim && hops++ < 8) victim = victim.master;
            if (victim && (victim.isBot || victim.isPlayer)) {
                o._lastKillAt = Date.now();
                o._collectLootUntil = o._lastKillAt + 5000;
            }
            // Comeback valve: a player repeatedly losing to bots gets breathing room (bots
            // stop initiating on them and aim worse) until they take a bot down themselves.
            if (victim?.isPlayer && victim.socket) {
                const s = victim.socket, now = Date.now();
                s.botDeathStreak = now - (s.botDeathLastAt || 0) < 90_000 ? (s.botDeathStreak || 0) + 1 : 1;
                s.botDeathLastAt = now;
                // Mercy is for someone genuinely spiraling, not a switch that makes the lobby
                // passive; a low threshold leaves bots around an active fighter inert.
                if (s.botDeathStreak >= 3)
                    s.botMercyUntil = now + 30_000;
                o._victoryEmoteUntil = now + 1300;
                // fairPlay: no farming the same player, no parking on a vault
                if (Config.dig_royale) fairPlay.noteBotKill(o, victim, now);
            }
        });
        this.bots.push(o);
        this.botStats.set(o.id, {
            id: o.id,
            name: o.name,
            skill: o.botSkill,
            statPoints: o.botStatTotal,
            statLayout: o.skill.raw.slice(),
            spawnedAt: Date.now(),
            deaths: 0,
            gemsMined: 0,
            gemsBanked: 0,
            stuckEvents: 0,
            kills: 0,
            goalSeconds: {},
            stationarySeconds: 0,
            stationaryOver3s: 0,
            stationaryReported: false,
            lastX: o.x,
            lastY: o.y,
        });
        if (Config.tag) Config.tag_data.addBot(o), global.nextTagBotTeam = null;
        o.on('dead', () => {
            const stats = this.botStats.get(o.id);
            if (stats) stats.deaths++;
            util.remove(this.bots, this.bots.indexOf(o));

            // Killing a bot ends mercy.
            const avenger = o._lastDamageSource;
            if (avenger?.isPlayer && avenger.socket && Date.now() - (o._lastDamageAt || 0) < 8000) {
                avenger.socket.botDeathStreak = 0;
                avenger.socket.botMercyUntil = 0;
            }

            // A bot keeps its name through a small run of deaths, then the slot gets a
            // new bot with a new name.
            const respawnsRemaining = Config.dig_royale ? 0 : (o.botRespawnsRemaining || 0);
            if (Config.dig_royale) {
                try { require('./gamemodes/scripts/dig_royale.js').onCombatantDead(o); } catch (e) { /* */ }
                // a bot waiting to respawn as itself keeps its name (terrain/botRoster.js)
                if (!o._botKeepName) ran.releaseBotName(o.botNameKey);
                return;
            }
            if (respawnsRemaining > 0 && !global.gameManager.arenaClosed && !global.cannotRespawn) {
                this.pendingBotRespawns++;
                setTimeout(() => {
                    this.pendingBotRespawns = Math.max(0, this.pendingBotRespawns - 1);
                    if (global.gameManager.arenaClosed || global.cannotRespawn) {
                        ran.releaseBotName(o.botNameKey);
                        return;
                    }
                    const respawnTeam = this.botBalancedTeam(o.team);
                    const respawnLoc = this.botSpawnLocation(respawnTeam);
                    this.spawnBots(respawnLoc, respawnTeam, botName, {
                        familyId: o.botFamilyId,
                        nameKey: o.botNameKey,
                        respawnsRemaining: respawnsRemaining - 1,
                    });
                }, 6500 + Math.floor(Math.random() * 4500));
            } else {
                ran.releaseBotName(o.botNameKey);
                this.pendingBotRespawns++;
                setTimeout(() => {
                    this.pendingBotRespawns = Math.max(0, this.pendingBotRespawns - 1);
                    if (global.gameManager.arenaClosed || global.cannotRespawn) return;
                    const team = this.botBalancedTeam(global.nextTagBotTeam || o.team);
                    this.spawnBots(this.botSpawnLocation(team), team);
                }, 6500 + Math.floor(Math.random() * 4500));
            }
        });
    };

    botChatReply(bot, rawMessage) {
        // Small, deterministic fallback: a failed model request must never turn
        // into a random reaction.
        const message = String(rawMessage || '').trim().toLowerCase();
        const addressed = this.botNameMentioned(message, bot);
        const saysNo = /^(nah|no|nope|dont|don't|i dont|i don't|not really|maybe not)\b/.test(message);
        if (bot._askedDiscordAt && Date.now() - bot._askedDiscordAt < 25_000) {
            bot._askedDiscordAt = 0;
            return saysNo ? 'all good lol' : 'bet, ill add u';
        }
        if (/\b(kill|shoot|die|destroy)\b/.test(message)) return 'yo im chill';
        if (/discord|dc\b/.test(message)) {
            bot._askedDiscordAt = Date.now();
            return 'whats ur discord';
        }
        if (addressed && message.split(/\s+/).length <= 4) {
            if (message.split(/\s+/).length === 1) return 'yeah?';
            if (/^(hi|hello|hiya)\b/.test(message)) return 'hey';
            if (/^(hey|heyy)\b/.test(message)) return 'yo';
            if (/^(wsp|wassup|sup)\b/.test(message)) return 'wsp';
            if (/^(yo|hyd)\b/.test(message)) return 'yo';
            return null;
        }
        if (/^(hi|hello|hiya)\b/.test(message)) return 'hey';
        if (/^(hey|heyy)\b/.test(message)) return 'yo';
        if (/^(wsp|wassup|sup)\b/.test(message)) return 'wsp';
        if (/^(yo|hyd)\b/.test(message)) return 'yo';
        if (/^(thanks|thx|ty)\b/.test(message)) return 'np';
        if (/^(bye|cya|later)\b/.test(message)) return 'later';
        // Unknown messages are safer as silence than an irrelevant agreement.
        return null;
    }

    sanitizeBotReply(reply) {
        return String(reply || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/^['"`]+|['"`]+$/g, '')
            .trim()
            .toLowerCase()
            .slice(0, 96);
    }

    chatReplyIsUsable(reply, rawMessage, bot) {
        const text = this.sanitizeBotReply(reply);
        const message = String(rawMessage || '').trim().toLowerCase();
        if (!text || text.length < 2 || text.length > 96) return false;
        if (bot._lastChatReply && text === bot._lastChatReply) return false;
        if (/[<>${}]/.test(text) || /\b(as an ai|as a bot|language model|i cannot comply)\b/.test(text)) return false;
        // Reject low-information reactions. Casual slang is fine, but the reply must
        // contribute an actual answer.
        if (/^(fr|lol yeah|true|same tbh|no way lol|yeah i feel that|lmao|yeah)\W*$/.test(text)) return false;
        if (/\b(discord|dc)\b/.test(message) && !/\b(discord|dc|add|send|drop|have)\b/.test(text)) return false;
        if (/\b(kill|shoot|die|destroy)\b/.test(message) && !/\b(chill|why|me|nah|no|stop|lol|please|fight)\b/.test(text)) return false;
        if (this.botNameMentioned(message, bot) && message.split(/\s+/).length <= 4) {
            const greeting = /^(hi|hey|hello|yo|sup|heyy|hiya|wsp|wassup|hyd)\b/.test(message) ||
                message.split(/\s+/).length === 1;
            const directAnswer = greeting
                ? /\b(yo|hey|hi|sup|wsp|what|up|here)\b|\?/.test(text)
                : !/^(fr|lol|true|same|yeah|yep|nah|lmao)\b/.test(text);
            if (!directAnswer) return false;
        }
        return true;
    }

    botChatActivity(bot) {
        switch (bot._digWarsGoal) {
            case 'objective': return 'attacking an enemy outpost or core chamber';
            case 'defend': return 'defending a friendly outpost';
            case 'fight': return 'fighting another player';
            case 'collect': return 'picking up loose gems';
            case 'mine': return 'shooting a rock for gems';
            case 'bank': return 'taking gems back to the vault';
            case 'survive': return 'trying to stay alive';
            case 'explore': return 'moving across the map';
            default: return 'roaming around the map';
        }
    }

    botNameMentioned(message, bot) {
        const messageWords = message.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        const nameWords = bot.name.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3);
        return nameWords.some(word => messageWords.includes(word));
    }

    async aiBotChatReply(bot, rawMessage) {
        const fallback = this.botChatReply(bot, rawMessage);
        const now = Date.now();
        // Every ordinary player message that reaches a nearby bot goes to the
        // configured NVIDIA NIM chat model, even just the bot's name. The local reply
        // is only a provider-failure fallback.
        if (!Config.bot_chat_ai_enabled || typeof fetch !== 'function') return fallback;

        bot._chatHistory ??= [];
        const history = bot._chatHistory.slice(-8);
        const system = `you are ${bot.name}, a casual human-like player in a fast multiplayer tank game. right now you are ${this.botChatActivity(bot)}. answer the player's latest message directly in one short casual sentence, mostly lowercase, using natural slang. respond to what they actually said, not to a random imagined conversation. never use empty reactions like "lol yeah", "fr", "true", or "same tbh" as the whole answer. if you do not understand, ask a short clarification instead of inventing context. if the message is only your name, greet them and ask what is up. if they say a greeting plus your name, greet them back. if they ask a question, answer that question. if they ask about discord, respond naturally. if they threaten to kill you, respond as yourself. never ignore the exact message or the fact that your name was addressed. do not sound like an assistant, do not write paragraphs, do not claim actions outside the game, and do not mention being a bot or an ai.`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Config.bot_chat_timeout_ms);
        try {
            const headers = {
                'content-type': 'application/json',
                accept: 'application/json',
            };
            if (Config.bot_chat_api_key) headers.authorization = `Bearer ${Config.bot_chat_api_key}`;
            const response = await fetch(Config.bot_chat_api_url, {
                method: 'POST',
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                    model: Config.bot_chat_model,
                    stream: false,
                    messages: [
                        { role: 'system', content: system },
                        ...history,
                        { role: 'user', content: `the player just said: "${String(rawMessage).slice(0, 160)}"\nreply directly to that message as ${bot.name}.` },
                    ],
                    temperature: 0.35,
                    top_p: 0.75,
                    max_tokens: 40,
                }),
            });
            if (!response.ok) throw new Error(`chat api ${response.status}`);
            const data = await response.json();
            const reply = this.sanitizeBotReply(data?.message?.content || data?.choices?.[0]?.message?.content);
            if (!this.chatReplyIsUsable(reply, rawMessage, bot)) throw new Error('irrelevant chat reply');
            this.botChatAiAvailable = true;
            bot._chatHistory.push({ role: 'user', content: `the player just said: "${String(rawMessage).slice(0, 160)}"` });
            bot._chatHistory.push({ role: 'assistant', content: reply });
            bot._chatHistory = bot._chatHistory.slice(-8);
            return reply;
        } catch {
            this.botChatAiAvailable = false;
            this.botChatAiRetryAt = now + 60_000;
            return fallback;
        } finally {
            clearTimeout(timer);
        }
    }

    handleBotChat({ message, socket }) {
        // Bot chat is disabled; delete this return to re-enable it.
        return;
        if (!Config.dig_wars || !socket?.player?.body || typeof message !== 'string') return;
        const player = socket.player.body;
        const text = message.trim();
        if (!text || text.startsWith('$') || player.isDead()) return;

        const nearby = this.bots.filter(bot => bot && !bot.isDead() && !bot.isGhost)
            .map(bot => ({ bot, distance: Math.hypot(bot.x - player.x, bot.y - player.y) }))
            .filter(entry => entry.distance <= 760)
            .sort((a, b) => a.distance - b.distance);
        if (!nearby.length) return;

        const addressed = nearby.filter(({ bot }) => this.botNameMentioned(text, bot));
        const canAnswer = ({ bot }) => !bot._chatPending && Date.now() >= (bot._nextChatAt || 0);
        const mentionsAnyBot = this.bots.some(bot => bot && !bot.isDead() && this.botNameMentioned(text, bot));
        // A message aimed at a farther-away bot must not make a random nearby bot answer.
        if (mentionsAnyBot && !addressed.length) return;
        // A named bot gets first refusal. If it is still thinking or on
        // cooldown, stay quiet rather than handing the message to somebody
        // else or making the same bot spam a repeated line.
        const selected = addressed.length
            ? addressed.find(canAnswer)
            : nearby.find(canAnswer);
        if (!selected) return;

        const bot = selected.bot;
        bot._chatPendingCount = (bot._chatPendingCount || 0) + 1;
        bot._chatPending = true;
        bot._chatPauseUntil = Date.now() + 5000;
        bot._nextChatAt = Date.now() + 5000 + Math.random() * 3500;
        setTimeout(async () => {
            try {
                const reply = await this.aiBotChatReply(bot, text);
                if (reply && reply !== bot._lastChatReply && this.hasRealPlayers() && !bot.isDead() && !bot.isGhost && Math.hypot(bot.x - player.x, bot.y - player.y) <= 900) {
                    bot._lastChatReply = reply;
                    bot.say(reply);
                    bot._chatPauseUntil = Date.now() + 700 + Math.random() * 900;
                }
            } finally {
                bot._chatPendingCount = Math.max(0, (bot._chatPendingCount || 1) - 1);
                bot._chatPending = bot._chatPendingCount > 0;
            }
        }, 1100 + Math.random() * 1500);
    }

    hasRealPlayers() {
        return !!this.gameManager?.socketManager?.players?.some(player =>
            player?.body && !player.body.isDead() && !player.body.isGhost
        );
    }

    botAmbientChat() {
        // Bot chat is player-triggered only (no bot-to-bot ambient lines).
        return;
    }

    sampleBotTelemetry() {
        const now = Date.now();
        const dt = Math.min(1, Math.max(0, now - this.botTelemetryAt) / 1000);
        this.botTelemetryAt = now;
        for (const bot of this.bots) {
            let stats = this.botStats.get(bot.id);
            if (!stats) {
                stats = {
                    id: bot.id,
                    name: bot.name,
                    skill: bot.botSkill,
                    statPoints: bot.botStatTotal,
                    statLayout: bot.skill.raw.slice(),
                    spawnedAt: now,
                    deaths: 0,
                    gemsMined: 0,
                    gemsBanked: 0,
                    stuckEvents: 0,
                    kills: 0,
                    goalSeconds: {},
                    stationarySeconds: 0,
                    stationaryOver3s: 0,
                    stationaryReported: false,
                    lastX: bot.x,
                    lastY: bot.y,
                };
                this.botStats.set(bot.id, stats);
            }
            const goal = bot._digWarsGoal || 'wander';
            stats.goalSeconds[goal] = (stats.goalSeconds[goal] || 0) + dt;
            stats.gemsMined = bot.gemsMined || 0;
            stats.rocksMined = bot.rocksMined || 0;
            stats.carried = Math.round(bot.carriedGems || 0);
            stats.role = bot._botRole || '';
            stats.gemsBanked = bot.botBanked || 0;
            stats.statPoints = bot.botStatTotal || bot.skill.raw.reduce((sum, value) => sum + value, 0);
            stats.statLayout = bot.skill.raw.slice();
            stats.stuckEvents = bot._unstickCount || 0;
            stats.kills = bot.killCount ? bot.killCount.solo | 0 : 0;
            const moved = Math.hypot(bot.x - stats.lastX, bot.y - stats.lastY);
            // Holding a firing position on a rock, a banner or a vault pad is
            // a decision, not a freeze. Only unexplained stillness counts.
            const deliberate = bot.control?.fire || bot.grindTouchUntil > now ||
                (goal === 'bank' && bot.vaultOnPad);
            if (!deliberate && moved < Math.max(0.5, (bot.size || 1) * 0.05)) {
                stats.stationarySeconds += dt;
                if (stats.stationarySeconds > 3 && !stats.stationaryReported) {
                    stats.stationaryOver3s++;
                    stats.stationaryReported = true;
                }
            } else {
                stats.stationarySeconds = 0;
                stats.stationaryReported = false;
            }
            stats.lastX = bot.x;
            stats.lastY = bot.y;
        }
    }

    writeBotSoakReport() {
        if (!Config.bot_soak_report_path) return;
        this.sampleBotTelemetry();
        const bots = Array.from(this.botStats.values()).map(stats => ({
            ...stats,
            alive: this.bots.some(bot => bot.id === stats.id),
            stationaryReported: undefined,
            lastX: undefined,
            lastY: undefined,
        }));
        const elapsedSeconds = Math.max(1, (Date.now() - this.soakStartedAt) / 1000);
        const totalGoalSeconds = bots.reduce((sum, bot) =>
            sum + Object.values(bot.goalSeconds).reduce((a, b) => a + b, 0), 0);
        const wanderSeconds = bots.reduce((sum, bot) => sum + (bot.goalSeconds.wander || 0), 0);
        const report = {
            elapsedSeconds,
            botCap: Config.bot_cap,
            msptAverage: this.soakMspt.length
                ? this.soakMspt.reduce((a, b) => a + b, 0) / this.soakMspt.length
                : 0,
            bots,
            summary: {
                botInstances: bots.length,
                botsBankedAtLeastOnce: bots.filter(bot => bot.gemsBanked > 0).length,
                wanderPercent: totalGoalSeconds ? wanderSeconds / totalGoalSeconds * 100 : 0,
                stationaryBotsOver3s: bots.filter(bot => bot.stationaryOver3s > 0).length,
                stuckEventsPerBotPerMinute: bots.length
                    ? bots.reduce((sum, bot) => sum + bot.stuckEvents, 0) / bots.length / (elapsedSeconds / 60)
                    : 0,
            },
        };
        try {
            fs.writeFileSync(Config.bot_soak_report_path, JSON.stringify(report, null, 2));
        } catch (error) {
            console.error(`[BOT SOAK] Could not write report: ${error.message}`);
        }
    }

    run() {
        this.active = true;
        if (Config.bot_soak_mode && Config.bot_soak_duration_ms > 0) {
            this.soakTimer = setTimeout(() => {
                this.writeBotSoakReport();
                this.stop();
            }, Config.bot_soak_duration_ms);
        }
        // Tick health: every stage is timed and a slow tick is logged at most once
        // per second with its breakdown.
        const tickStats = global.tickStats = { n: 0, ema: 0, max: 0, slow: 0, lastLog: 0, terrainEma: 0, terrainMax: 0, modeMax: 0 };
        let lastTickAt = performance.now();
        let gameLoop = setInterval(() => {
            if (!this.active) return clearInterval(gameLoop);
            // measured every interval, occupied or not, so the first tick after idling
            // doesn't log as "late"
            const cycleStarted = performance.now();
            const late = cycleStarted - lastTickAt - 1000 / 30;
            lastTickAt = cycleStarted;
            if (this.checkUsers()) {
                try {
                    this._lifeProf = null; this._collideMs = 0; this._stageProf = null; global.botProf = {};
                    this.gameloop();
                    const tEnt = this._tickEntMs || 0, tGaze = this._tickGazeMs || 0;
                    const tA = performance.now();
                    if (Config.bot_soak_mode) {
                        this.soakMspt.push(tA - cycleStarted);
                        if (this.soakMspt.length > 3000) this.soakMspt.shift();
                    }
                    syncedDelaysLoop();
                    if (Config.enable_food) this.foodloop();
                    global.gameManager.roomLoop();
                    global.gameManager.gamemodeManager.request("quickloop");
                    const total = performance.now() - cycleStarted;
                    // TICK_TRACE=1: avg / p95 / max tick every 10 s (local profiling only)
                    if (process.env.TICK_TRACE) {
                        const tr = this._tickTrace || (this._tickTrace = { at: performance.now(), ms: [] });
                        tr.ms.push(total);
                        if (performance.now() - tr.at > 10000) {
                            const v = tr.ms.slice().sort((a, b) => a - b), avg = v.reduce((a, b) => a + b, 0) / v.length;
                            let bots = 0; for (const e of entities.values()) if (e.isBot && !e.isDead()) bots++;
                            const bp = global.botProf || {}, bpTop = Object.entries(bp).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, ms]) => k + ' ' + ms.toFixed(0)).join(', ');
                            console.log(`[TICK-TRACE] n ${v.length} avg ${avg.toFixed(2)} p95 ${v[Math.floor(v.length * 0.95)].toFixed(2)} p99 ${v[Math.floor(v.length * 0.99)].toFixed(2)} max ${v[v.length - 1].toFixed(1)} entities ${entities.size} bots ${bots} | bot ms/10s: ${bpTop}`);
                            for (const k in bp) bp[k] = 0;
                            tr.at = performance.now(); tr.ms.length = 0;
                        }
                    }
                    tickStats.n++;
                    tickStats.ema = tickStats.ema ? tickStats.ema * 0.95 + total * 0.05 : total;
                    if (total > tickStats.max) tickStats.max = total;
                    if (total > 33) tickStats.over33 = (tickStats.over33 | 0) + 1;
                    if (late > 25) tickStats.lateN = (tickStats.lateN | 0) + 1;
                    if (performance.now() - (tickStats.minuteAt || 0) > 60000) {
                        if (tickStats.minuteAt && (tickStats.over33 || tickStats.lateN))
                            console.log(`[TICK] last minute: ${tickStats.over33 | 0} ticks over 33ms, ${tickStats.lateN | 0} started 25ms+ late, avg ${tickStats.ema.toFixed(1)}ms, max ${tickStats.max.toFixed(0)}ms`);
                        tickStats.minuteAt = performance.now();
                        tickStats.over33 = 0; tickStats.lateN = 0; tickStats.max = 0;
                    }
                    if ((total > 40 || late > 120) && performance.now() - tickStats.lastLog > 1000) {
                        tickStats.slow++;
                        tickStats.lastLog = performance.now();
                        const prof = this._lifeProf || {};
                        const top = Object.entries(prof).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + "=" + v.toFixed(0)).join(" ");
                        const sp = this._stageProf || {};
                        const stages = Object.entries(sp).map(([k, v]) => k + "=" + v.toFixed(0)).join(" ");
                        const bp = Object.entries(global.botProf || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + "=" + v.toFixed(0)).join(" ");
                        console.log(`[SLOW TICK] life: ${top} collide=${(this._collideMs || 0).toFixed(0)} | ${stages} | bots: ${bp}`);
                        console.log(`[SLOW TICK] ${total.toFixed(0)}ms (entities ${tEnt.toFixed(0)} / views ${tGaze.toFixed(0)} / rest ${(total - (tA - cycleStarted)).toFixed(0)})` +
                            (late > 120 ? ` started ${late.toFixed(0)}ms late (event loop blocked elsewhere)` : "") +
                            ` entities=${entities.size} clients=${global.gameManager.clients.length} terrainMax=${tickStats.terrainMax.toFixed(0)} modeMax=${tickStats.modeMax.toFixed(0)}`);
                        tickStats.terrainMax = 0; tickStats.modeMax = 0;
                    }
                } catch (e) {
                    global.gameManager.gameSpeedCheckHandler.onError(e);
                    this.stop();
                };
            }
        }, global.gameManager.room.cycleSpeed);
        let maintainloop = setInterval(() => {
            if (!this.active) return clearInterval(maintainloop);
            global.gameManager.gameSpeedCheckHandler.update();
            const _modeT0 = performance.now();
            global.gameManager.gamemodeManager.request("loop");
            const _modeMs = performance.now() - _modeT0;
            if (global.tickStats && _modeMs > global.tickStats.modeMax) global.tickStats.modeMax = _modeMs;
            this.maintainloop();
        }, 1000);
        let otherloop = setInterval(() => {
            if (!this.active) return clearInterval(otherloop);
            this.quickMaintainLoop();
            this.sampleBotTelemetry();
            this.botAmbientChat();
        }, 200)
        let healingLoop = setInterval(() => {
            if (!this.active) return clearInterval(healingLoop);
            this.regenHealthAndShield();
        }, Config.regenerate_tick);

        const mineBudget = new Map(); 
        const bulletRockHits = [];

        const announceEmerald = (miner) => {
            const who = miner && miner.name ? miner.name : "An unnamed player";
            global.gameManager.socketManager.broadcast(`${who} has destroyed an emerald shard!`);
        };
        const rootMaster = (e) => {
            let m = e, hops = 0;
            while (m.master && m.master !== m && hops++ < 4) m = m.master;
            return m;
        };
        // a grown tank (terrain/growth.js) digs every hit harder, and its dig
        // budget rises by the same factor
        const growMine = (e) => (e.growthMult > 1 && global.royaleGrowth) ? global.royaleGrowth.mineMult(e.growthMult) : 1;
        // raid perks (terrain/raidPerks.js): Power Drill and the extra barrels
        // raise the dig budget (the drill's damage side is in mining.gearMult),
        // and the shot perks (blast, chain, pierce, crit) live in raidPerks
        const perkMine = (e) => e._pkfx ? Math.min(mining.GEAR_CAP, e._pkfx.budget || 1) : 1;
        let raidPerksMod = null;
        const raidPerks = () => raidPerksMod || (raidPerksMod = require('./terrain/raidPerks.js'));

        const crush = (instance, ms) => {
            if (!instance.health || !(instance.health.max > 0)) return;
            const dmg = instance.health.max * TG_REGROW.CRUSH_DPS_FRAC * (ms / 1000);
            instance.health.amount -= dmg;
            if (instance.health.amount <= 0 && !instance._crushedNoted) {
                instance._crushedNoted = true;
                instance.deathCause = "rock";
                instance.dontSendDeathMessage = true;
                if (instance.sendMessage) instance.sendMessage("You were crushed by the living wall.");
            }
        };
        // a grown hull buried by the rock (it closed over a parked tank, or a
        // placement went wrong) cracks it open instead of being crushed or
        // thrown out across the map
        const breakOutGrown = (body) => {
            if (!Config.dig_royale || Config.tutorial) return false;
            try { return (digRoyaleMod ||= require('./gamemodes/scripts/dig_royale.js')).breakOutGrown(body) > 0; } catch (e) { return false; }
        };
        let lastTerrainTick = Date.now();
        // required once, lazily (both pull in half the game at load time)
        let chestsMod = null, digRoyaleMod = null, abilitiesMod = null;
        // Called from the game loop above once per tick (that callback only runs
        // after run() returns, so this const exists by then).
        const terrainPass = this.terrainPass = () => {
            if (!this.active) return;
            const _tg = global.gameManager.terrainGrid;
            if (!_tg || !_tg._voronoiMap) return;
            // An empty server (the tutorial worker with nobody in it) has no
            // one to mine, magnet or crush: skip the whole pass and give the
            // CPU to the worker that has players.
            if (!this.checkUsers()) return;
            if (mineBudget.size > 256) mineBudget.clear(); // stale-id backstop

            const tickNow = Date.now();
            const tickMs = Math.min(66, tickNow - lastTerrainTick) || 33;
            lastTerrainTick = tickNow;
            const _terrainT0 = performance.now();
            this._terrainTimer = _terrainT0;
            _tg.regrowTick(tickNow);
            this._terrainRegrowMs = performance.now() - _terrainT0;
            const growingNow = _tg.growingRocks().length > 0;
            const gemActors = this.gemActors();
            const raidPads = Config.dig_royale ? vault.getVaults() : null;
            const shopPads = Config.dig_royale ? shop.getShops() : null;
            const gemsThisTick = true;
            for (const instance of global.entities.values()) {
                if (!instance) continue;
                if (instance.isGemPickup) {
                    if (instance.isDead?.()) continue;
                    if (instance.noclip || instance.godmode || instance.isArenaCloser) continue;
                    if (instance.chamberHome !== undefined) {
                        coreChambers.tickContainedGem(instance);
                    } else if (gemsThisTick) {
                        gems.tickGem(instance, _tg, gemActors);
                        if (growingNow) _tg.pushCircleFromGrowing(instance, instance.realSize, tickNow);
                    }
                    if (!instance.isDead?.() && instance.activation.active) instance.takeSelfie();
                    continue;
                }
                if (instance.type !== 'tank' && instance.type !== 'miniboss' && instance.type !== 'minion' &&
                    instance.type !== 'bullet' && instance.type !== 'drone' && instance.type !== 'trap' &&
                    instance.type !== 'satellite' && instance.type !== 'swarm') continue;
                if (instance.isDead?.()) continue;
                if (instance.noclip || instance.godmode || instance.isArenaCloser) continue;
                if (instance.isOutpostBanner || instance.isCoreChamber) continue;
                if (raidPads && instance.type === 'minion') {
                    const root = instance.master;
                    for (let vi = 0; vi < raidPads.length; vi++) {
                        const v = raidPads[vi];
                        if (vault.onPadShape(v, instance.x - v.x, instance.y - v.y)) {
                            if (!root || !root.vaultOnPad) {
                                instance.kill();
                            }
                            break;
                        }
                    }
                    if (instance.isDead?.()) continue;
                }
                if (instance.type === 'tank' || instance.type === 'miniboss' || instance.type === 'minion') {
                    // Keep the satchel on the tank's back. Has to run per tick
                    // rather than on gem change, because "back" tracks movement
                    // and aim, which change constantly while the load does not.
                    gems.orientSatchel(instance);
                    const r = instance.realSize;
                    // the drillhead boss chews straight through the wall
                    if (instance.bossDigs && (!instance._digAt || tickNow - instance._digAt >= 140)) {
                        instance._digAt = tickNow;
                        const drock = _tg.rockHitByCircle(instance.x, instance.y, r * 1.15)
                            || (growingNow ? _tg.growingRockHitByCircle(instance.x, instance.y, r * 1.15, tickNow) : null);
                        if (drock) {
                            const wasGrowing = drock.growing;
                            const destroyed = _tg.damageRock(drock, drock.maxHealth * (instance.bossDigRate || 0.3), instance.x, instance.y, false, null);
                            if (destroyed && !wasGrowing && drock.ore) gems.spawnOreBurst(drock, null);
                        }
                    }
                    // A tutorial glide (tutorialSession.teleportTo) moves the tank in a straight
                    // line through rock and lands on open ground; resolving rock contacts mid-glide
                    // would pin it against the first wall. Collide after it lands.
                    const gliding = !!instance._tutorialGlide;
                    const p = gliding ? { dx: 0, dy: 0, entombed: false } : _tg.settleTank(instance, r, tickNow, growingNow, instance.growthMult > 1 ? breakOutGrown : null);
                    let dx = p.dx, dy = p.dy;
                    const nowT = tickNow;
                    const entombed = p.entombed;
                    if (entombed && !instance.invuln && !instance.royaleLobby) crush(instance, tickMs);
                    else instance._crushedNoted = false;
                    if (dx !== 0 || dy !== 0) {
                        const pLen = Math.hypot(dx, dy);
                        const nx = dx / pLen, ny = dy / pLen;
                        const vDot = instance.velocity.x * nx + instance.velocity.y * ny;
                        if (vDot < 0) {
                            instance.velocity.x -= vDot * nx;
                            instance.velocity.y -= vDot * ny;
                        }

                        instance.grindTouchUntil = nowT + 300;
                        instance.grindNx = nx;
                        instance.grindNy = ny;
                        if (instance.activation.active || instance.isPlayer) instance.takeSelfie();
                    }

                    if (instance.type === 'tank' && instance.grindTouchUntil > nowT) {
                        const gsec = mining.grindSecondsFor(instance);
                        if (gsec) {
                            instance.grindAcc = Math.min(
                                _tg.baseRockHealth * 0.6, 
                                // 0.008 per 16 ms pass, scaled to the real pass length
                                (instance.grindAcc || 0) + (_tg.baseRockHealth / gsec) * 0.008 * (tickMs / 16) * growMine(instance)
                            );
                            if (!instance.grindLast || nowT - instance.grindLast >= 150) {
                                instance.grindLast = nowT;
                                const rock = _tg.rockHitByCircle(instance.x, instance.y, r * 1.06)
                                    || (growingNow ? _tg.growingRockHitByCircle(instance.x, instance.y, r * 1.06, tickNow) : null);
                                if (rock) {
                                    // the RY dig flag (Mining Power tip): hull mining counts too
                                    instance._grindDigAt = nowT;
                                    let mb = mineBudget.get(instance.id);
                                    if (!mb || nowT - mb.t >= 1000) {
                                        mb = { t: nowT, left: _tg.baseRockHealth * 1.5 * growMine(instance) };
                                        mineBudget.set(instance.id, mb);
                                    }
                                    const dmg = Math.min(instance.grindAcc, mb.left);
                                    if (dmg > 0) {
                                        mb.left -= dmg;
                                        instance.grindAcc -= dmg;
                                        // soft spark at the hull contact point
                                        const wasGrowing = rock.growing;
                                        const destroyed = _tg.damageRock(rock, rock.ore ? dmg : dmg * gems.PLAIN_ROCK_MULT,
                                            instance.x - (instance.grindNx || 0) * r,
                                            instance.y - (instance.grindNy || 0) * r,
                                            true, instance);

                                        if (destroyed) instance.rocksMined = (instance.rocksMined || 0) + 1;
                                        if (destroyed && !wasGrowing) {
                                            if (!rock.ore) gems.pityBurst(rock, instance);
                                            if (rock.ore) {
                                                instance.gemsMined = (instance.gemsMined || 0) + 1;
                                                gems.spawnOreBurst(rock, instance);
                                                if (rock.ore === 4) announceEmerald(instance);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else if (instance.type === 'bullet' || instance.type === 'drone' ||
                           instance.type === 'trap'   || instance.type === 'satellite' ||
                           instance.type === 'swarm') {
                    if (raidPads) {
                        for (let vi = 0; vi < raidPads.length; vi++) {
                            const v = raidPads[vi];
                            const vdx = instance.x - v.x, vdy = instance.y - v.y;
                            const vr = v.r * 1.15 + 8 + (instance.realSize || 0);
                            if (vdx * vdx + vdy * vdy > vr * vr) continue;
                            if (vault.onPadShape(v, vdx, vdy, 8)) {
                                instance.velocity.x = 0; instance.velocity.y = 0;
                                instance.accel.x = 0;    instance.accel.y = 0;
                                if (instance.cameraInfo) { instance.cameraInfo.vx = 0; instance.cameraInfo.vy = 0; }
                                instance.kill();
                                break;
                            }
                        }
                        if (instance.isDead?.()) continue;
                        for (let si = 0; si < shopPads.length; si++) {
                            const sp = shopPads[si];
                            const sdx = instance.x - sp.x, sdy = instance.y - sp.y;
                            const sr = sp.r * 1.25 + 8 + (instance.realSize || 0);
                            if (sdx * sdx + sdy * sdy > sr * sr) continue;
                            if (padGeom.insidePad(sp, instance.x, instance.y, 8)) {
                                instance.velocity.x = 0; instance.velocity.y = 0;
                                instance.accel.x = 0;    instance.accel.y = 0;
                                if (instance.cameraInfo) { instance.cameraInfo.vx = 0; instance.cameraInfo.vy = 0; }
                                instance.kill();
                                break;
                            }
                        }
                        if (instance.isDead?.()) continue;
                    }

                    // A shot landing on a seam between cells chips every cell it
                    // touches, then dies once like a single hit.
                    const hitRocks = _tg.rocksHitByCircle(instance.x, instance.y, instance.realSize, bulletRockHits);
                    if (growingNow) _tg.growingRocksHitByCircle(instance.x, instance.y, instance.realSize, tickNow, hitRocks);
                    // a piercing shot (raid perk) never hits the same rock twice
                    if (instance._pkHit && hitRocks.length) raidPerks().skipPassed(instance, hitRocks);
                    if (hitRocks.length) {
                        const owner = rootMaster(instance);
                        const perkFx = owner._pkfx || null;
                        const nowT = Date.now();
                        // mining: its guns kick less while the shots land on rock (gun.js recoil)
                        owner._rockHitAt = nowT;
                        let mb = mineBudget.get(owner.id);
                        if (!mb || nowT - mb.t >= 1000) {
                            mb = { t: nowT, left: _tg.baseRockHealth * 3 * growMine(owner) * perkMine(owner) };
                            mineBudget.set(owner.id, mb);
                        }

                        const rp = instance.rockPower || 0;
                        const raw = _tg.baseRockHealth * mining.rockDamageFor(owner, instance)
                                  * mining.skillFactor(owner) * (rp || 1) * growMine(owner)
                                  * (perkFx ? raidPerks().critMult(instance, owner) : 1);
                        for (let hi = 0; hi < hitRocks.length; hi++) {
                            const rock = hitRocks[hi];
                            // lance bolts are rate-limited by their own reload, not the budget
                            const dmg = rp ? raw : Math.min(raw, mb.left);
                            if (!(dmg > 0)) break;
                            mb.left -= dmg;
                            const wasGrowing = rock.growing;
                            // round 9: plain rock breaks ~30% faster (ore keeps its toughness)
                            const hitDmg = rock.ore ? dmg : dmg * gems.PLAIN_ROCK_MULT;
                            const hpBefore = rock.health;
                            const destroyed = _tg.damageRock(rock, hitDmg, instance.x, instance.y, false, owner);
                            // round 9: ore pays a gem chip per hit out of its break payout, plain rock sends
                            if (Config.dig_royale && owner.socket) gems.chipHit(rock, owner, Math.min(hitDmg, Math.max(0, hpBefore)), instance.x, instance.y, wasGrowing);
                            // breaking an ore cell erupts its gem payout

                            if (destroyed) owner.rocksMined = (owner.rocksMined || 0) + 1;
                            if (destroyed && !wasGrowing) {
                                if (!rock.ore) gems.pityBurst(rock, owner);
                                if (rock.ore) {
                                    owner.gemsMined = (owner.gemsMined || 0) + 1;
                                    gems.spawnOreBurst(rock, owner);
                                    if (rock.ore === 4) announceEmerald(owner);
                                }
                            }
                        }
                        // raid perks: blast and chain around the hit, and a
                        // piercing shot lives on
                        if (perkFx && raidPerks().afterRockHit(instance, owner, hitRocks, _tg, raw)) {
                            hitRocks.length = 0;
                            continue;
                        }
                        hitRocks.length = 0;

                        instance.velocity.x = 0; instance.velocity.y = 0;
                        instance.accel.x = 0;    instance.accel.y = 0;
                        if (instance.cameraInfo) { instance.cameraInfo.vx = 0; instance.cameraInfo.vy = 0; }
                        instance.kill();
                    }
                }
            }

            const _tEnt = performance.now();
            const vNow = Date.now();
            const padDt = Math.min(66, vNow - (this._lastVaultTick || vNow)) || 33;
            // One bad pad must not take the whole server down with it.
            this._padTickErr ||= (name, e) => {
                const t = Date.now(); this._padErrAt ||= {};
                if (t - (this._padErrAt[name] || 0) > 10000) { this._padErrAt[name] = t; console.error('[' + name + ']', e); }
            };
            try { vault.tick(gemActors, padDt); } catch (e) { this._padTickErr('vault.tick', e); }
            try { outposts.tick(gemActors, padDt); } catch (e) { this._padTickErr('outposts.tick', e); }
            if (Config.dig_royale || Config.tutorial) {
                try { shop.tick(gemActors); } catch (e) { /* */ }
                try { (abilitiesMod ||= require('./terrain/abilities.js')).tick(gemActors); } catch (e) { this._padTickErr('abilities.tick', e); }
                try { (chestsMod ||= require('./terrain/chests.js')).tick(gemActors, _tg); } catch (e) { /* */ }
            }
            if (!Config.dig_royale) {
                try { coreChambers.tick(padDt); } catch (e) { this._padTickErr('coreChambers.tick', e); }
            }
            this._lastVaultTick = vNow;
            const _tPads = performance.now();
            if (Config.dig_royale) {
                try { (digRoyaleMod ||= require('./gamemodes/scripts/dig_royale.js')).tick(); } catch (e) {
                    const tNow = Date.now();
                    if (tNow - (this._raidTickErrAt || 0) > 10000) {
                        this._raidTickErrAt = tNow;
                        console.error('[RAID] tick failed:', e && e.stack || e);
                    }
                }
            }

            const _tMode = performance.now();
            this._terrainStages = [(_tEnt - _terrainT0) | 0, (_tPads - _tEnt) | 0, (_tMode - _tPads) | 0];
            if (_tg.rockEvents.length) {
                const payload = JSON.stringify(_tg.rockEvents);
                _tg.rockEvents.length = 0;
                for (const client of global.gameManager.socketManager.clients) {
                    client.talk('TR', payload);
                }
            }
            if (global.tickStats && this._terrainTimer) {
                const _tMs = performance.now() - this._terrainTimer;
                global.tickStats.terrainEma = global.tickStats.terrainEma ? global.tickStats.terrainEma * 0.95 + _tMs * 0.05 : _tMs;
                if (_tMs > global.tickStats.terrainMax) global.tickStats.terrainMax = _tMs;
                if (_tMs > 60 && performance.now() - (this._terrainLogAt || 0) > 1000) {
                    this._terrainLogAt = performance.now();
                    const _st = this._terrainStages || [];
                    console.log(`[SLOW TERRAIN] ${_tMs.toFixed(0)}ms entities-pass=${_st[0]} pads=${_st[1]} raid=${_st[2]} regrow=${(this._terrainRegrowMs || 0).toFixed(0)} gems=${gemActors ? gemActors.length : 0} growing=${growingNow ? 1 : 0} entities=${entities.size}`);
                }
            }
        };
    }
    stop() {
        this.active = false;
        if (this.soakTimer) {
            clearTimeout(this.soakTimer);
            this.soakTimer = null;
        }
    }
}

module.exports = { gameHandler };
