const fs = require('fs');
const path = require('path');
const gems = require('./terrain/gems.js');
const mining = require('./terrain/mining.js');
const vault = require('./terrain/vault.js');
const outposts = require('./terrain/outposts.js');
const coreChambers = require('./terrain/coreChambers.js');
const { REGROW: TG_REGROW } = require('./terrain/terrainGrid.js');
const { inEnemyBase } = require('../miscFiles/controllers.js');
const { chamberRingHit, chamberFaceRadius, chamberNormal } = coreChambers;

// A natural mirror bounce: the ring reflects a shot off the face it struck,
// keeping the incoming speed but redirecting it along the surface normal -
// grazing shots slide off, dead-on shots bounce back. No freeze, no swallow.
const REBOUND_KEEP = 0.85;    // how much of the shot's speed survives the bounce

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

// Advanced collision impulses are intentionally soft, but two fast tanks can
// still remain visibly inside each other for a frame. Bots should never occupy
// the same hull as a player or teammate, so resolve the remaining penetration
// explicitly after the normal collision response.
function separateBotTanks(first, second) {
    if (first.type !== 'tank' || second.type !== 'tank' ||
        (!first.isBot && !second.isBot)) return;
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
    // finished joining a team yet. Previously the whole game loop paused until
    // a client entered the match, which made idle bots appear frozen.
    checkUsers = () => global.gameManager.clients.length >= 1 ||
        this.bots.some(bot => bot && !bot.isDead() && !bot.isGhost) ||
        !!Config.bot_soak_mode;

    // Gem and vault systems consume body-like actors. Keep socket players in
    // their existing wrapper shape and append bot bodies, which have no socket.
    gemActors = () => {
        const actors = [];
        for (const player of global.gameManager.socketManager.players) {
            const body = player && player.body;
            if (body && !body.isDead() && !body.isGhost) actors.push(player);
        }
        for (const bot of this.bots) {
            if (bot && !bot.isDead() && !bot.isGhost) actors.push(bot);
        }
        return actors;
    };
    
    collide = (instance, other) => {

        
        if (instance.noclip || other.noclip) return 0;

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
                if (obj.isInGrid) {
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
        logs.loops.tally();
        logs.master.set();

        // Do entities life
        logs.entities.set();
        grid.clear();
        for (const instance of entities.values()) {
            if (instance.contemplationOfMortality() === 1) {
                if (Config.outbreak && !instance.zombified && (instance.isPlayer || instance.isBot)) {
                    instance.zombified = true;
                    instance.settings.no_collisions = true;
                    instance.alpha = 0;
                    instance.takeSelfie();
                    Config.OURBREAK_FUNCTIONS.zombify(instance);
                } else instance.destroy();
                continue;
            }

            // Reset collision array once at the beginning
            instance.collisionArray.length = 0;

            // Handle physics only if not bonded
            if (instance.bond == null) {
                instance.physics();
            }

            if (instance.activation.active || instance.isPlayer) {
                logs.entities.tally();
                instance.life();
                instance.takeSelfie();
                instance.friction();
                instance.confinementToTheseEarthlyShackles();
            }

            // Terrain collision handled by the dedicated terrain loop below

            instance.updateAABB(instance.activation.active);
            for (const other of grid.query(instance.minX, instance.minY, instance.maxX, instance.maxY)) {
                this.collide(instance, other);
            }
            if (instance.isInGrid) grid.insert(instance, instance.minX, instance.minY, instance.maxX, instance.maxY);
            if ((instance.touchingSizeWall === false || instance.collisionArray.length === 0) && instance.originalSize) {
                instance.SIZE = instance.originalSize;
                instance.originalSize = undefined;
            }
            if ((instance.touchingFovWall === false || instance.collisionArray.length === 0) && instance.originalFov) {
                instance.FOV = instance.originalFov;
                instance.originalFov = undefined;
            }
            instance.activation.update();

            instance.emit('tick', { body: instance });
        }
        logs.entities.mark();
        logs.master.mark();
        // Update lastCycle only once
        global.gameManager.room.lastCycle = util.time();
        for (let i = 0; i < global.gameManager.clients.length; i++) {
            let client = global.gameManager.clients[i];
            if (client.status.readyToBroadcast) {
                client.view.gazeUpon();
            }
        }
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
        for (let instance of entities.values()) {
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

    // Per-team ceiling on bots. Whatever picked the team - gem balance,
    // weakest-team, or a respawning bot keeping its old side - a full team
    // hands the slot to the other side instead of stacking past the cap.
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
        const rammer = !bot.guns || bot.guns.size === 0;
        const defs = (bot.defs || []).join(' ').toLowerCase();
        // A 42-point base - the same budget a level-45 player has - shaped
        // like the builds players actually win with, per class archetype.
        // Order: [rld, pen, str, dam, spd, shi, atk, hlt, rgn, mob].
        // The old one-size spread put bullet health at 2, so any max-pen
        // player build deleted bot bullets on contact and every trade was
        // lost before it started.
        let raw;
        if (rammer) raw = [0, 0, 0, 0, 0, 9, 9, 9, 6, 9];
        else if (/sniper|assassin|ranger|marksman|stalker|rifle|predator|hunter|deadeye|sidewinder/.test(defs))
            raw = [6, 9, 4, 9, 7, 0, 0, 3, 0, 4];
        else if (/destroyer|artillery|mortar|launcher|ordnance|annihilator|hybrid/.test(defs))
            raw = [6, 9, 8, 9, 2, 0, 0, 4, 0, 4];
        else
            raw = [9, 8, 6, 9, 3, 0, 0, 3, 0, 4];
        // High-skill bots invest deeper, up to ~14 extra points spread over
        // the stats they already use. Without this, every bot fought like a
        // half-built tank and a maxed player build shredded the whole lobby
        // without ever being pressured.
        let bonus = Math.round(util.clamp(bot.botSkill ?? 0.5, 0, 1) * 14);
        for (let pass = 0; pass < 3 && bonus > 0; pass++) {
            for (let i = 0; i < raw.length && bonus > 0; i++) {
                if (raw[i] > 0 && raw[i] < 9) { raw[i]++; bonus--; }
            }
        }
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
            // A bot the director sent toward a player must not also be drafted
            // into an outpost push on the far side of the map. The two systems
            // were pulling the same bots in opposite directions and encounters
            // dropped by roughly half.
            if ((bot._botDirectorUntil || 0) > now) {
                bot._botPushTarget = null;
                bot._botPushTargetUntil = 0;
                continue;
            }
            if (!byTeam.has(bot.team)) byTeam.set(bot.team, []);
            byTeam.get(bot.team).push(bot);
        }
        for (const members of byTeam.values()) {
            // Squads were sliced out of an id-sorted list, so "teammates" were
            // often on opposite sides of the map and could never actually push
            // together. Group by proximity instead: take whoever is left, then
            // pull in its two nearest unassigned teammates.
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
                // Chambers count as push targets too. Solo bots cannot
                // out-damage a chamber's self-heal, so chambers only ever
                // fall to a squad - which is exactly the coordinated moment
                // players enjoy fighting over.
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
        // Keep the player-editable checklist as the source of truth. Read it
        // at selection time so an admin can change [x] entries and restart the
        // match without another code edit. A missing file means no extra
        // exclusions, preserving the existing built-in safety filters below.
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

    // Relative pick weights per class key (lowercase). Anything not listed
    // rolls at weight 1. Stronger meta tanks get higher weights so lobbies
    // skew toward good builds; tier 1-2 branches that lead to those tanks
    // are boosted too, otherwise the final-tier weights never get a chance
    // to matter. This shapes odds only - the max-2-per-tank rule below is
    // what actually stops a lobby from filling with copies.
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
        // Lobby variety: at most two living bots may be the same tank at
        // once. Drop any option that would create a third copy - unless
        // that removes every option, in which case a duplicate beats a
        // bot stuck refusing to upgrade.
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
                o.skillUp([ "atk", "hlt", "spd", "str", "pen", "dam", "rld", "mob", "rgn", "shi" ][ran.chooseChance(...Config.bot_skill_upgrade_chances)]);
                o.refreshSkills();
            }
            const upgradeIndex = o.botStatsFixed ? this.botUpgradeIndex(o) : ran.irandomRange(0, o.upgrades.length);
            // Entity.upgrade() does not return a success flag, so we watch the
            // class id. A failed pick means this tank is done upgrading - dump
            // the rest and let it go instead of waiting forever.
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
        
        if (!global.gameManager.arenaClosed && !global.cannotRespawn && !Config.dig_royale &&
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

    // Keeps the world feeling inhabited.
    //
    // Bots roam and mine perfectly well on their own, but a player sees only
    // about a 618 unit radius of a multi-thousand-unit world. Left alone they
    // diffuse and the player meets nobody, which reads as a dead server even
    // though everything is running. This nudges a few of the nearest idle bots
    // toward whoever is playing, so encounters actually happen. It never
    // teleports and never targets the player directly: it sets a destination in
    // their region and lets the bot drive there.
    directorTick() {
        const now = Date.now();
        // Players under mercy are not hosts: funneling fresh bots toward
        // somebody who is already losing is manufactured frustration.
        const humans = (this.socketManagerPlayers?.() || [])
            .filter(b => b && !b.isDead?.() && !b.isGhost &&
                !((b.socket?.botMercyUntil || 0) > now));
        if (!humans.length) return;

        const live = this.bots.filter(b => b && !b.isDead() && !b.isGhost);
        if (!live.length) return;

        // NEAR must stay in the same order of magnitude as what the player can
        // actually SEE (~618 units), not what the server considers close. At
        // 1500 the director counted bots two screens away as company and went
        // back to sleep while the player stared at an empty tunnel - the exact
        // failure it exists to prevent. 900 means "on screen or one beat from
        // walking onto it".
        const NEAR = 900, WANT = 4;
        for (const host of humans) {
            const near = live.filter(b => Math.hypot(b.x - host.x, b.y - host.y) <= NEAR);
            if (near.length >= WANT) continue;

            const candidates = live
                .filter(b => !near.includes(b) && now >= (b._botDirectorUntil || 0))
                .sort((a, b) =>
                    Math.hypot(a.x - host.x, a.y - host.y) - Math.hypot(b.x - host.x, b.y - host.y));

            for (const bot of candidates.slice(0, WANT - near.length)) {
                const angle = Math.random() * Math.PI * 2;
                // Stay inside NEAR: a bot dropped past it does not count as
                // company, so the director would immediately re-task somebody
                // else for the same player and thin the crowd it just built.
                const dist = 380 + Math.random() * 440;
                bot._botDirectorPoint = {
                    x: host.x + Math.cos(angle) * dist,
                    y: host.y + Math.sin(angle) * dist,
                };
                // long enough to actually walk there, then they are free again.
                // Shorter than it used to be: on a compact map the trip is
                // shorter, and a bot released sooner can be re-tasked toward
                // the next player instead of sitting on a stale lease.
                bot._botDirectorUntil = now + 14000;
            }
        }
    }

    socketManagerPlayers() {
        return (global.gameManager.socketManager?.players || [])
            .map(p => p && p.body)
            .filter(b => b && b.isPlayer);
    }

    // Base at match start. Once the team holds an outpost, mix home and pad
    // so they don't all pour out of one hole - never the open map.
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
            }
            o.define({ FACING_TYPE: next.FACING_TYPE ? next.FACING_TYPE : Class.bot.FACING_TYPE, AI: Class.bot.AI, }, false, true, false);
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
        // Bots should not be put to sleep by view-based activation. Their AI
        // must keep simulating before a teammate's camera reaches them.
        o.alwaysActive = true;
        o.botFamilyId = lifecycle?.familyId ?? o.id;
        o.botNameKey = nameKey;
        o.botRespawnsRemaining = lifecycle?.respawnsRemaining ?? ran.irandomRange(2, 3);
        // This value changes decisions, not damage or movement stats. A broad
        // spread keeps a lobby from feeling like eight copies of one machine.
        o.botSkill = util.clamp(ran.gauss(0.55, 0.25), 0.1, 0.95);
        // A few bots are playful instead of perfectly task-focused. Their
        // showoff moments are brief and never interrupt an actual player fight.
        o.botStyle = ran.choose(['normal', 'normal', 'normal', 'dancer', 'spinner']);
        o.botTemperament = ran.choose(['aggressive', 'aggressive', 'balanced', 'balanced', 'passive']);
        // Body-only tanks are a rare spice - roughly one rammer in fifty
        // bots. The upgrade picker below also forces the body branch only
        // for this small group.
        o.botRammerAllowed = ran.chance(0.02);
        o.name = botName;
        o.invuln = true;
        o.leftoverUpgrades = ran.chooseChance(...Config.bot_class_upgrade_chances);
        o.botWakeAt = Date.now() + 2000;
        o.botNextUpgradeAt = o.botWakeAt;
        o.botArmed = false;
        o.botDidUpgrade = false;
        o.botSettleAt = 0;
        let color = Config.random_body_colors ? Math.floor(Math.random() * 20) : team ? getTeamColor(team) : "darkGrey";
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
        if (Config.dig_royale) o.botRespawnsRemaining = 0;
        if (team) o.team = team;
        if (Config.dig_wars || Config.dig_royale) gems.initSatchel(o);
        // Remember the last enemy that actually damaged this tank. The goal
        // controller uses this for a short, common-sense "fight back or run"
        // reaction instead of continuing to mine through incoming fire.
        o.on('damage', ({ damageInflictor = [] }) => {
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
                // Tell the team. Nearby teammates rally to this marker, which
                // is how a skirmish grows into a fight instead of staying a
                // series of unrelated 1v1s.
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
            // Comeback pressure valve: a player losing to bots repeatedly gets
            // breathing room - bots stop initiating on them and aim worse -
            // until they take a bot down themselves. Nobody re-queues after
            // being farmed by machines.
            if (victim?.isPlayer && victim.socket) {
                const s = victim.socket, now = Date.now();
                s.botDeathStreak = now - (s.botDeathLastAt || 0) < 90_000 ? (s.botDeathStreak || 0) + 1 : 1;
                s.botDeathLastAt = now;
                // Mercy is a soft touch for someone genuinely spiraling, not
                // a switch that turns the lobby passive. At two deaths it was
                // firing constantly and bots around an active fighter went
                // inert, which read as "the bots do nothing".
                if (s.botDeathStreak >= 4)
                    s.botMercyUntil = now + 30_000;
                o._victoryEmoteUntil = now + 1300;
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

            // Killing a bot is the comeback: the moment a player lands one,
            // mercy ends and bots treat them normally again.
            const avenger = o._lastDamageSource;
            if (avenger?.isPlayer && avenger.socket && Date.now() - (o._lastDamageAt || 0) < 8000) {
                avenger.socket.botDeathStreak = 0;
                avenger.socket.botMercyUntil = 0;
            }

            // A bot is a little persistent character, not a disposable tank.
            // Keep its name through a small run of deaths, then let the slot
            // receive a genuinely new bot with a new name.
            const respawnsRemaining = Config.dig_royale ? 0 : (o.botRespawnsRemaining || 0);
            if (Config.dig_royale) {
                try { require('./gamemodes/scripts/dig_royale.js').onCombatantDead(o); } catch (e) { /* */ }
                ran.releaseBotName(o.botNameKey);
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
        // This is intentionally a small, deterministic emergency fallback.
        // A failed model request must never turn into a random reaction.
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
        // Reject the exact low-information reactions that made the old
        // fallback feel random. DeepSeek may still use casual slang, but it
        // must contribute an actual answer.
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
        // Every ordinary player message that reaches a nearby bot is sent to
        // the configured NVIDIA NIM chat model, including short messages such
        // as just the bot's name. The local reply is only a provider-failure
        // fallback.
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
        // Bot chat is switched off for now (owner request). The machinery
        // below stays so it can be re-enabled by deleting this line.
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
        // A message aimed at a bot who is farther away must not accidentally
        // make a random nearby bot answer it.
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
        // Bot-to-bot ambient lines were not player conversation and frequently
        // looked like random NPC noise. Keep chat player-triggered only.
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
        let gameLoop = setInterval(() => {
            if (!this.active) return clearInterval(gameLoop);
            if (this.checkUsers()) {
                try {
                    const cycleStarted = performance.now();
                    this.gameloop();
                    if (Config.bot_soak_mode) {
                        this.soakMspt.push(performance.now() - cycleStarted);
                        if (this.soakMspt.length > 3000) this.soakMspt.shift();
                    }
                    syncedDelaysLoop();
                    if (Config.enable_food) this.foodloop();
                    global.gameManager.roomLoop();
                    global.gameManager.gamemodeManager.request("quickloop");
                } catch (e) {
                    global.gameManager.gameSpeedCheckHandler.onError(e);
                    this.stop();
                };
            }
        }, global.gameManager.room.cycleSpeed);
        let maintainloop = setInterval(() => {
            if (!this.active) return clearInterval(maintainloop);
            global.gameManager.gameSpeedCheckHandler.update();
            global.gameManager.gamemodeManager.request("loop");
            this.maintainloop();
        }, 1000);
        let otherloop = setInterval(() => {
            if (!this.active) return clearInterval(otherloop);
            this.quickMaintainLoop();
            this.sampleBotTelemetry();
            this.botAmbientChat();
            global.gameManager.socketManager.chatLoop();
        }, 200)
        let healingLoop = setInterval(() => {
            if (!this.active) return clearInterval(healingLoop);
            this.regenHealthAndShield();
        }, Config.regenerate_tick);

        
        
        
        
        const mineBudget = new Map(); 
        
        
        const announceEmerald = (miner) => {
            const who = miner && miner.name ? miner.name : "An unnamed player";
            global.gameManager.socketManager.broadcast(`${who} has destroyed an emerald shard!`);
        };
        const rootMaster = (e) => {
            let m = e, hops = 0;
            while (m.master && m.master !== m && hops++ < 4) m = m.master;
            return m;
        };
        
        
        
        
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
        let lastTerrainTick = Date.now();
        let terrainLoop = setInterval(() => {
            if (!this.active) return clearInterval(terrainLoop);
            const _tg = global.gameManager.terrainGrid;
            if (!_tg || !_tg._voronoiMap) return;
            if (mineBudget.size > 256) mineBudget.clear(); // stale-id backstop
            
            
            const tickNow = Date.now();
            const tickMs = Math.min(50, tickNow - lastTerrainTick) || 8;
            lastTerrainTick = tickNow;
            _tg.regrowTick(tickNow);
            const growingNow = _tg.growingRocks().length > 0;
            const gemActors = this.gemActors();
            for (const instance of global.entities.values()) {
                if (!instance) continue;
                if (instance.isGemPickup) {
                    if (instance.isDead?.()) continue;
                    if (instance.noclip || instance.godmode || instance.isArenaCloser) continue;
                    if (instance.chamberHome !== undefined) {
                        coreChambers.tickContainedGem(instance);
                    } else {
                        gems.tickGem(instance, _tg, gemActors);
                        if (growingNow) _tg.pushCircleFromGrowing(instance, instance.realSize, tickNow);
                    }
                    continue;
                }
                if (instance.type !== 'tank' && instance.type !== 'miniboss' && instance.type !== 'minion' &&
                    instance.type !== 'bullet' && instance.type !== 'drone' && instance.type !== 'trap' &&
                    instance.type !== 'satellite' && instance.type !== 'swarm') continue;
                if (instance.isDead?.()) continue;
                if (instance.noclip || instance.godmode || instance.isArenaCloser) continue;
                if (instance.isOutpostBanner || instance.isCoreChamber) continue;
                if (instance.type === 'tank' || instance.type === 'miniboss' || instance.type === 'minion') {
                    // Keep the satchel on the tank's back. Has to run per tick
                    // rather than on gem change, because "back" tracks movement
                    // and aim, which change constantly while the load does not.
                    gems.orientSatchel(instance);
                    const r = instance.realSize;
                    const p = _tg.pushCircleFromVoronoi(instance, r);
                    let dx = p.dx, dy = p.dy;
                    const nowT = tickNow;
                    
                    
                    
                    
                    let entombed = false;
                    if (growingNow) {
                        const g = _tg.pushCircleFromGrowing(instance, r, tickNow);
                        entombed = g.entombed;
                        if (g.dx !== 0 || g.dy !== 0) { dx += g.dx; dy += g.dy; }
                        
                        
                        if (g.buried) {
                            instance.velocity.x = 0; instance.velocity.y = 0;
                            instance.accel.x = 0;    instance.accel.y = 0;
                        }
                    }
                    
                    
                    
                    
                    if (_tg.pointInRock(instance.x, instance.y)) {
                        entombed = true;
                        instance.velocity.x = 0; instance.velocity.y = 0;
                        instance.accel.x = 0;    instance.accel.y = 0;
                    }
                    if (entombed && !instance.invuln) crush(instance, tickMs);
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
                    }
                    
                    
                    
                    
                    
                    
                    if (instance.type === 'tank' && instance.grindTouchUntil > nowT) {
                        const gsec = mining.grindSecondsFor(instance);
                        if (gsec) {
                            instance.grindAcc = Math.min(
                                _tg.baseRockHealth * 0.6, 
                                (instance.grindAcc || 0) + (_tg.baseRockHealth / gsec) * 0.008
                            );
                            if (!instance.grindLast || nowT - instance.grindLast >= 150) {
                                instance.grindLast = nowT;
                                const rock = _tg.rockHitByCircle(instance.x, instance.y, r * 1.06)
                                    || (growingNow ? _tg.growingRockHitByCircle(instance.x, instance.y, r * 1.06, tickNow) : null);
                                if (rock) {
                                    let mb = mineBudget.get(instance.id);
                                    if (!mb || nowT - mb.t >= 1000) {
                                        mb = { t: nowT, left: _tg.baseRockHealth * 1.5 };
                                        mineBudget.set(instance.id, mb);
                                    }
                                    const dmg = Math.min(instance.grindAcc, mb.left);
                                    if (dmg > 0) {
                                        mb.left -= dmg;
                                        instance.grindAcc -= dmg;
                                        // soft spark at the hull contact point
                                        const wasGrowing = rock.growing;
                                        const destroyed = _tg.damageRock(rock, dmg,
                                            instance.x - (instance.grindNx || 0) * r,
                                            instance.y - (instance.grindNy || 0) * r,
                                            true, instance);
                                        
                                        
                                        if (destroyed) instance.rocksMined = (instance.rocksMined || 0) + 1;
                                        if (destroyed && rock.ore && !wasGrowing) {
                                            instance.gemsMined = (instance.gemsMined || 0) + 1;
                                            gems.spawnOreBurst(rock, instance);
                                            if (rock.ore === 4) announceEmerald(instance);
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else if (instance.type === 'bullet' || instance.type === 'drone' ||
                           instance.type === 'trap'   || instance.type === 'satellite' ||
                           instance.type === 'swarm') {
                    
                    
                    
                    
                    
                    
                    
                    const rock = _tg.rockHitByCircle(instance.x, instance.y, instance.realSize)
                        || (growingNow ? _tg.growingRockHitByCircle(instance.x, instance.y, instance.realSize, tickNow) : null);
                    if (rock) {
                        const owner = rootMaster(instance);
                        const nowT = Date.now();
                        let mb = mineBudget.get(owner.id);
                        if (!mb || nowT - mb.t >= 1000) {
                            
                            mb = { t: nowT, left: _tg.baseRockHealth * 3 };
                            mineBudget.set(owner.id, mb);
                        }
                        
                        
                        
                        
                        
                        
                        
                        const raw = _tg.baseRockHealth / mining.rockHitsFor(owner, instance)
                                  * mining.skillFactor(owner);
                        const dmg = Math.min(raw, mb.left);
                        if (dmg > 0) {
                            mb.left -= dmg;
                            const wasGrowing = rock.growing;
                            const destroyed = _tg.damageRock(rock, dmg, instance.x, instance.y, false, owner);
                            // breaking an ore cell erupts its gem payout -
                            
                            
                            if (destroyed) owner.rocksMined = (owner.rocksMined || 0) + 1;
                            if (destroyed && rock.ore && !wasGrowing) {
                                owner.gemsMined = (owner.gemsMined || 0) + 1;
                                gems.spawnOreBurst(rock, owner);
                                if (rock.ore === 4) announceEmerald(owner);
                            }
                        }
                        
                        
                        instance.velocity.x = 0; instance.velocity.y = 0;
                        instance.accel.x = 0;    instance.accel.y = 0;
                        instance.kill();
                    }
                }
            }

            
            const vNow = Date.now();
            vault.tick(gemActors,
                       Math.min(50, vNow - (this._lastVaultTick || vNow)) || 8);
            
            outposts.tick(global.gameManager.socketManager.players,
                          Math.min(50, vNow - (this._lastVaultTick || vNow)) || 8);
            if (!Config.dig_royale) {
                coreChambers.tick(Math.min(50, vNow - (this._lastVaultTick || vNow)) || 8);
            }
            this._lastVaultTick = vNow;
            if (Config.dig_royale) {
                try { require('./gamemodes/scripts/dig_royale.js').tick(); } catch (e) { /* */ }
            }

            
            
            
            
            
            if (_tg.rockEvents.length) {
                const payload = JSON.stringify(_tg.rockEvents);
                _tg.rockEvents.length = 0;
                for (const client of global.gameManager.socketManager.clients) {
                    client.talk('TR', payload);
                }
            }
        }, 8);
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
