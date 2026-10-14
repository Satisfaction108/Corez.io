let compressMovementOffsets = [
        { x: 1, y: 0},
        { x: 1, y: 1},
        { x: 0, y: 1},
        { x:-1, y: 1},
        { x:-1, y: 0},
        { x:-1, y:-1},
        { x: 0, y:-1},
        { x: 1, y:-1}
    ],
    compressMovement = (current, goal) => {
        let offset = compressMovementOffsets[Math.round(( Math.atan2(current.y - goal.y, current.x - goal.x) / (Math.PI * 2) ) * 8 + 4) % 8];
        return {
            x: current.x + offset.x,
            y: current.y + offset.y
        }
    },
    CLLonSegment = (p0, p1, q0, q1, r0, r1) => {
        return q0 <= Math.max(p0, r0) && q0 >= Math.min(p0, r0) && q1 <= Math.max(p1, r1) && q1 >= Math.min(p1, r1);
    },
    CLLorientation = (p0, p1, q0, q1, r0, r1) => {
        let v = (q1 - p1) * (r0 - q0) - (q0 - p0) * (r1 - q1);
        return !v ? 0 : v > 0 ? 1 : 2; // clock or counterclock wise
    },
    collisionLineLine = (p10, p11, q10, q11, p20, p21, q20, q21) => {
        // Find the four orientations needed for general and special cases
        let o1 = CLLorientation(p10, p11, q10, q11, p20, p21),
            o2 = CLLorientation(p10, p11, q10, q11, q20, q21),
            o3 = CLLorientation(p20, p21, q20, q21, p10, p11),
            o4 = CLLorientation(p20, p21, q20, q21, q10, q11);

        return (
            (o1 == 0 && CLLonSegment(p10, p11, p20, p21, q10, q11)) ||
            (o2 == 0 && CLLonSegment(p10, p11, q20, q21, q10, q11)) ||
            (o3 == 0 && CLLonSegment(p20, p21, p10, p11, q20, q21)) ||
            (o4 == 0 && CLLonSegment(p20, p21, q10, q11, q20, q21)) ||
            (o1 != o2 && o3 != o4)
        );
    },
    // me: { ...Vector }
    // enemy: data to calculte where it is gonna be soon
    // walls: Array<{ ...Vector, hitboxRadius, hitbox: Array<[Vector, Vector]> }>
    wouldHitWall = (me, enemy, directWallCheck = false) => {
        if (directWallCheck) {
            if (!me.justHittedAWallTimeout) me.justHittedAWallTimeout = "ready";
            if (me.justHittedAWall && me.justHittedAWallTimeout === "ready") {
                me.justHittedAWall = false;
                me.justHittedAWallTimeout = "null";
                setTimeout(() => {
                    me.justHittedAWallTimeout = "ready";
                    me.justHittedAWall = false;
                }, 300);
                return true;
            }
            return false;
        }
        // thing for culling off walls where theres no point of checking
        let inclusionCircle = {
            x: (me.x + enemy.x) / 2,
            y: (me.y + enemy.y) / 2,
            radius: util.getDistance(me, enemy) / 2
        };

        for (let i = 0; i < walls.length; i++) {
            let crate = walls[i];

            //avoid calculating collisions if it would just be a waste
            if (util.getDistanceSquared(inclusionCircle, crate) > (inclusionCircle.radius + crate.hitboxRadius) ** 2) continue;

            //if the crate intersects with the line, add them to the list of walls that have been hit
            //works by checking if the line from the gun end to the enemy position collides with any line from the crate hitbox
            for (let j = 0; j < crate.hitbox.length; j++) {
                let hitboxLine = crate.hitbox[j];
                if (collisionLineLine(
                    me.x, me.y,
                    enemy.x, enemy.y,
                    crate.x + hitboxLine[0].x, crate.y + hitboxLine[0].y,
                    crate.x + hitboxLine[1].x, crate.y + hitboxLine[1].y
                )) return true;
            }
        }
        return false;
    };

// Define IOs (AI)
class IO {
    constructor(body) {
        this.body = body
        this.acceptsFromTop = true
    }
    think() {
        return {
            target: null,
            goal: null,
            fire: null,
            main: null,
            alt: null,
            power: null,
        }
    }
}
class io_siegeAI extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.enabled = true;
        this.goalDefault = gameManager.room.center;
    }
    think(input) {
        let tile = global.gameManager.room.getAt(this.body);
        if (tile && tile.name == "stopAI") {
            this.enabled = false;
        }
        if (this.enabled) {
            return {
                goal: this.goalDefault
            }
        }
    }
}
class io_doNothing extends IO {
    constructor(body) {
        super(body)
        this.acceptsFromTop = false
    }
    think() {
        return {
            goal: {
                x: this.body.x,
                y: this.body.y,
            },
            main: false,
            alt: false,
            fire: false,
        }
    }
}
class io_moveInCircles extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.acceptsFromTop = false
        this.timer = ran.irandom(5) + 3
        this.pathAngle = ran.random(2 * Math.PI);
        this.goal = {
            x: this.body.x + 10 * Math.cos(this.pathAngle),
            y: this.body.y + 10 * Math.sin(this.pathAngle)
        }
    }
    think() {
        if (!this.timer--) {
            this.timer = 5
            this.goal = {
                x: this.body.x + 10 * Math.cos(this.pathAngle),
                y: this.body.y + 10 * Math.sin(this.pathAngle)
            }
            // turnWithSpeed turn speed (but condensed over 5 ticks)
            this.pathAngle -= ((this.body.velocity.length / 90) * Math.PI) / global.gameManager.runSpeed * 5;
        }
        return {
            goal: this.goal,
            power: this.body.ACCELERATION > 0.1 ? 0.2 : 1
        }
    }
}
class io_listenToPlayer extends IO {
    constructor(b, opts = { static: false }) {
        super(b);
        if ("object" != typeof opts.player) throw new Error('Required IO Option "player" is not an object');
        this.player = opts.player;
        this.static = opts.static;
        this.acceptsFromTop = false;
    }
    // THE PLAYER MUST HAVE A VALID COMMAND AND TARGET OBJECT
    think() {
        let fire = this.player.command.autofire || this.player.command.lmb,
            alt = this.player.command.autoalt || this.player.command.rmb,
            target = {
                x: this.player.target.x,
                y: this.player.target.y,
            };
        if (this.body.reverseTargetWithTank) {
            target.x *= this.body.reverseTank;
            target.y *= this.body.reverseTank;
        }
        this.body.facingLocked = this.player.command.spinlock;
        if (this.player.command.autospin && !this.player.body.settings.braindamagemode) {
            let kk = Math.atan2(this.body.control.target.y, this.body.control.target.x) + 0.04;
            if (this.body.autospinBoost) {
                let thing = 0.05 * 1 * this.body.autospinBoost;
                if (this.player.command.lmb) thing = thing * 1.5;
                if (this.player.command.rmb) thing = thing * -1;
                kk += thing;
            }
            target = {
                x: 100 * Math.cos(kk),
                y: 100 * Math.sin(kk),
            };
        }
        if (this.body.invuln) {
            // A fresh spawn keeps its shield through the grace window; after
            // that the first move or shot drops it. Fire inputs already down
            // when the shield went up (respawn click, autofire) are exempt
            // until released. Movement keys are never exempt, otherwise a
            // held key would keep a moving tank shielded (and unable to shoot).
            const c = this.player.command;
            const bits = (c.up ? 1 : 0) | (c.down ? 2 : 0) | (c.left ? 4 : 0) | (c.right ? 8 : 0) |
                (c.lmb ? 16 : 0) | (c.autofire ? 32 : 0);
            const graceUntil = this.body.spawnGraceUntil || 0;
            if (this._shieldBody !== this.body || this._shieldGrace !== graceUntil) {
                this._shieldBody = this.body;
                this._shieldGrace = graceUntil;
                this._heldAtShield = bits & (16 | 32);
            }
            this._heldAtShield &= bits;     // let go: pressing it again is fresh
            const tNow = Date.now();
            const grace = graceUntil && tNow < graceUntil;
            const uiBusy = spawnShield.uiBusy(this.body, tNow);
            let fresh = bits & ~this._heldAtShield;
            // Oct 8 (owner: "it doesn't let you shoot at all"): a shielded tank's
            // guns don't fire, so shooting always ends the shield: a fresh
            // press at once (even in the spawn grace), and a trigger already
            // held (autofire, the respawn click) once the grace is over
            if (!grace && !uiBusy) fresh |= bits & this._heldAtShield & (16 | 32);
            const shot = fresh & (16 | 32);
            // Second Wind (shop gear): only shooting counts for a while longer
            if ((this.body.spawnMoveShieldUntil || 0) > tNow) fresh &= 16 | 32;
            // round 9 timed shields (quick-death respawn 8 s, post-bank 3 s): moving keeps
            let endAt = this.body.shieldEndAt || 0;
            if (endAt && tNow >= endAt && this.body.shieldSoftEnd && !shot) {
                this.body.shieldEndAt = 0;
                this.body.shootEndsShield = false;
                this.body.shieldSoftEnd = false;
                endAt = 0;
            }
            if (spawnShield.capped(this.body, tNow)) {
                this.body.invuln = false;
                this.body.shieldEndAt = 0;
                this.body.shootEndsShield = false;
                this.body.shieldSoftEnd = false;
                if (graceUntil > tNow) this.body.spawnGraceUntil = 0;
            } else if (endAt && (tNow >= endAt || (this.body.shootEndsShield && shot))) {
                this.body.invuln = false;
                this.body.shieldEndAt = 0;
                this.body.shootEndsShield = false;
                if (graceUntil > Date.now()) this.body.spawnGraceUntil = 0;
            } else if (shot || (!grace && fresh)) {
                this.body.invuln = false;
                if (graceUntil > Date.now()) this.body.spawnGraceUntil = 0;
            }
        }
        this.body.autoOverride = this.player.command.override;
        // sidearm guns fire from their own key, not from alt (drone repel)
        this.body.sidearmFire = !!this.player.command.sidearm;
        return {
            target,
            fire,
            alt,
            goal: this.static ? null : this.player.command.analog ? {
                x: this.body.x + this.player.command.moveX * 100,
                y: this.body.y + this.player.command.moveY * 100,
            } : {
                x: this.body.x + this.player.command.right - this.player.command.left,
                y: this.body.y + this.player.command.down - this.player.command.up,
            },
            // touch sticks can ask for part speed (never more than full)
            power: this.player.command.analog ? Math.min(1, Math.hypot(this.player.command.moveX, this.player.command.moveY)) : undefined,
            main: fire || this.player.command.autospin
        };
    }
}
class io_mapTargetToGoal extends IO {
    constructor(b) {
        super(b)
    }
    think(input) {
        if (input.main || input.alt) {
            return {
                goal: {
                    x: input.target.x + this.body.x,
                    y: input.target.y + this.body.y,
                },
                power: 1,
            }
        }
    }
}
class io_boomerang extends IO {
    constructor(b) {
        super(b)
        this.r = 0
        this.b = b
        this.m = b.master
        this.turnover = false
        let len = 10 * util.getDistance({
            x: 0,
            y: 0
        }, b.master.control.target)
        this.myGoal = {
            x: 3 * b.master.control.target.x + b.master.x,
            y: 3 * b.master.control.target.y + b.master.y,
        }
    }
    think(input) {
        if (this.b.range > this.r) this.r = this.b.range
        let t = 1; //1 - Math.sin(2 * Math.PI * this.b.range / this.r) || 1
        if (!this.turnover) {
            if (this.r && this.b.range < this.r * 0.5) {
                this.turnover = true;
            }
            return {
                goal: this.myGoal,
                power: t,
            }
        } else {
            return {
                goal: {
                    x: this.m.x,
                    y: this.m.y,
                },
                power: t,
            }
        }
    }
}
class io_goToMasterTarget extends IO {
    constructor(body) {
        super(body)

        const master = body.master

        // Start with the raw mouse/input offset
        let offsetX = master.control.target.x
        let offsetY = master.control.target.y

        // Match how facing/turrets handle reverse:
        // reverse = 1 if reverseTargetWithTank is true,
        // otherwise use reverseTank (usually 1 or -1)
        const reverseTank = master.reverseTank != null ? master.reverseTank : 1
        const reverseTargetWithTank = !!master.reverseTargetWithTank
        const reverse = reverseTargetWithTank ? 1 : reverseTank

        // If reverseTank is -1 (and reverseTargetWithTank is false),
        // this flips the offset across the tank
        offsetX *= reverse
        offsetY *= reverse

        this.myGoal = {
            x: master.x + offsetX,
            y: master.y + offsetY,
        }
        this.countdown = 5;
    }
    think() {
        if (this.countdown) {
            if (util.getDistance(this.body, this.myGoal) < 5) {
                this.countdown--;
            }
            return {
                goal: {
                    x: this.myGoal.x,
                    y: this.myGoal.y,
                },
            }
        }
    }
}
class io_canRepel extends IO {
    constructor(b) {
        super(b)
    }
    think(input) {
        if (input.alt && input.target) {
            let x = this.body.master.master.x - this.body.x
            let y = this.body.master.master.y - this.body.y
            // if (x * x + y * y < 2250000) // (50 * 30) ^ 2
            return {
                target: {
                    x: -input.target.x,
                    y: -input.target.y,
                },
                main: true,
            }
        }
    }
}
class io_alwaysFire extends IO {
    constructor(body) {
        super(body)
    }
    think() {
        return {
            fire: true,
        }
    }
}
class io_targetSelf extends IO {
    constructor(body) {
        super(body)
    }
    think() {
        return {
            main: true,
            target: {
                x: 0,
                y: 0,
            },
        }
    }
}
class io_mapAltToFire extends IO {
    constructor(body) {
        super(body)
    }
    think(input) {
        if (input.alt) {
            return {
                fire: true,
            }
        }
    }
}
class io_mapFireToAlt extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.onlyIfHasAltFireGun = opts.onlyIfHasAltFireGun;
    }
    think(input) {
        if (input.fire) for (let i = 0; i < this.body.gunsArrayed.length; i++) if (!this.onlyIfHasAltFireGun || this.body.gunsArrayed[i].altFire) return { alt: true }
    }
}
class io_onlyAcceptInArc extends IO {
    constructor(body) {
        super(body)
    }
    think(input) {
        if (input.target && this.body.firingArc != null) {
            if (Math.abs(util.angleDifference(Math.atan2(input.target.y, input.target.x), this.body.firingArc[0])) >= this.body.firingArc[1]) {
                return {
                    fire: false,
                    alt: false,
                    main: false
                }
            }
        }
    }
}
class io_stackGuns extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.timeUntilFire = opts.timeUntilFire || 0;
    }
    think ({ target }) {

        //why even bother?
        if (!target) {
            return;
        }

        //find gun that is about to shoot
        let lowestReadiness = Infinity,
            readiestGun;
        for (let i = 0; i < this.body.guns.length; i++) {
            let gun = this.body.guns[i];
            if (!gun.canShoot || !gun.stack) continue;
            let reloadStat = (gun.calculator == "necro" || gun.calculator == "fixed reload") ? 1 : (gun.bulletStats === "master" ? this.body.skill : gun.bulletStats).rld,
                readiness = (1 - gun.cycle) / (gun.settings.reload * reloadStat);
            if (lowestReadiness > readiness) {
                lowestReadiness = readiness;
                readiestGun = gun;
            }
        }

        //if we aren't ready, don't spin yet
        if (!readiestGun || (this.timeUntilFire && this.timeUntilFire > lowestReadiness)) {
            return;
        }

        //rotate the target vector based on the gun
        let targetAngle = Math.atan2(target.y, target.x) - readiestGun.angle,
            targetLength = Math.sqrt(target.x ** 2 + target.y ** 2);
        return {
            target: {
                x: targetLength * Math.cos(targetAngle),
                y: targetLength * Math.sin(targetAngle)
            }
        };
    }
}
const BOT_SIC_TYPES = new Set(['drone', 'minion', 'swarm']);
const BOT_SIC_REACH = 1400;
class io_nearestDifferentMaster extends IO {
    static validEntityTypes = new Set(["tank", "miniboss", "crasher"]);
    constructor(body, opts = {}) {
        super(body);
        this.targetLock = undefined;
        this.tick = ran.irandom(30);
        this.lead = 0;
        this.timeout = opts.timeout || 90;
        this.lockThroughWalls = opts.lockThroughWalls;
        this.mapGoal = opts.mapGoal;
        this.validTargets = [];
        this.botAimAngle = null;
        this.botAimNoise = 0;
        this.botAimNoiseAt = 0;
        this.pendingTargetId = null;
        this.pendingTargetUntil = 0;
        this.targetLockStarted = 0;
    }
    validate(e, m, mm, sqrRange, sqrRangeMaster) {
        const aiSettings = this.body.aiSettings;
        // range first: it turns away most of the list for the price of a
        // few multiplications (every gun and turret runs this every 3 ticks)
        if (!aiSettings.BLIND) {
            if ((e.x - m.x) * (e.x - m.x) >= sqrRange) return false;
            if ((e.y - m.y) * (e.y - m.y) >= sqrRange) return false;
        }
        if (!aiSettings.SKYNET) {
            if ((e.x - mm.x) * (e.x - mm.x) >= sqrRangeMaster) return false;
            if ((e.y - mm.y) * (e.y - mm.y) >= sqrRangeMaster) return false;
        }
        const myMaster = this.body.master.master;
        const theirMaster = e.master.master;
        if (e.health.amount <= 0) return false;
        if (theirMaster.team === myMaster.team || theirMaster.team === TEAM_ROOM) return false;
        if (theirMaster.ignoredByAi || theirMaster.adminSpec) return false;
        if (e.bond) return false;
        if (e.invuln || e.godmode || theirMaster.godmode || theirMaster.passive || myMaster.passive) return false;
        // a bot's auto turrets / drones, and raid bosses, honour a fresh
        // spawn's bot grace too
        if ((myMaster.isBot || myMaster.isRoyaleBoss) && inBotGrace(theirMaster, Date.now())) return false;
        if (myMaster.isBot && softSpared(myMaster, theirMaster, Date.now())) return false;
        // a fresh life (anyone's) or a raid's first two minutes: bosses don't start on
        if (myMaster.isRoyaleBoss && theirMaster.isPlayer && bossGuard.freshSpared(theirMaster)) return false;
        // first raid (terrain/newcomerDirector.js): the scariest bot classes leave them
        if (myMaster.isBot && theirMaster.nxScaryUntil && newcomer.scarySpared(myMaster, theirMaster, Date.now())) return false;
        // a protected player banking, someone banking vs their killer or a far bigger
        if (myMaster.isBot && fairPlay.guarded(theirMaster) && fairPlay.spared(myMaster, theirMaster, Date.now())) return false;
        // a bot that farmed this player leaves them be
        if (myMaster.isBot && theirMaster.isPlayer && fairPlay.farmed(myMaster, theirMaster, Date.now())) return false;
        if (myMaster.isBot && theirMaster.isBot && myMaster !== theirMaster &&
            ((theirMaster._fpBait && fairPlay.baitOnDuty(theirMaster)) || (myMaster._fpBait && fairPlay.baitOnDuty(myMaster)))) return false;
        // Core truce (coreFinale.js): a bot's guns and drones leave players
        // alone unless that player hit the bot in the last few seconds
        // (a crowned player is never under it: crowns are fair game)
        if (myMaster.isBot && theirMaster.isPlayer && global.royaleCoreTruce && !theirMaster.crowned &&
            !(myMaster._lastDamageSource === theirMaster && Date.now() - (myMaster._lastDamageAt || 0) < 3000)) return false;
        if (isNaN(e.dangerValue)) return false;
        if (!(aiSettings.seeInvisible || this.body.isArenaCloser || e.alpha > 0.5)) return false;
        if (!io_nearestDifferentMaster.validEntityTypes.has(e.type)) {
            if ((aiSettings.IGNORE_SHAPES || myMaster.aiSettings.IGNORE_SHAPES) && e.type === "food") return false;
        }
        return true;
    }
    botSic() {
        const body = this.body;
        if (!BOT_SIC_TYPES.has(body.type)) return null;
        let root = body.master, hops = 0;
        while (root && root.master && root.master !== root && hops++ < 6) root = root.master;
        if (!root || root === body || !root.isBot) return null;
        const s = root.botSic;
        if (!s || Date.now() > s.until || (root.isDead && root.isDead())) return null;
        let x = s.x, y = s.y;
        if (s.e) {
            if ((s.e.isDead && s.e.isDead()) || !this.validate(s.e, body, root, Infinity, Infinity)) return null;
            x = s.e.x; y = s.e.y;
        }
        if ((x - root.x) * (x - root.x) + (y - root.y) * (y - root.y) > BOT_SIC_REACH * BOT_SIC_REACH) return null;
        this.targetLock = undefined;
        return { target: { x: x - body.x, y: y - body.y }, fire: true, main: true };
    }
    wouldHitWall(entity) {
        if (!this.lockThroughWalls) return wouldHitWall(this.body, entity);
        else return false;
    }
    buildList(range) {
        const sqrRange = range * range;
        const sqrRangeMaster = sqrRange * 4 / 3;
        const validCandidates = [];
        for (const e of targetableEntities.values()) {
            if (this.validate(e, this.body, this.body.master.master, sqrRange, sqrRangeMaster) && !this.wouldHitWall(e)) {
                if (this.body.aiSettings.view360 || Math.abs(util.angleDifference(util.getDirection(this.body, e), this.body.firingArc[0])) < this.body.firingArc[1]) {
                    validCandidates.push(e);
                }
            }
        }
        if (!validCandidates.length) {
            this.targetLock = undefined;
            return [];
        }
        let mostDangerous = 0;
        for (const e of validCandidates) {
            mostDangerous = Math.max(e.dangerValue, mostDangerous);
        }
        let keepTarget = false;
        // A raid boss is everyone's problem: its guns take the nearest tank,
        // not the highest tier in reach (a Basic next to it used to be
        // ignored while any upgraded tank was in range).
        // Dig Royale: a tank's auto turrets and drones take the nearest tank, any
        // tier (the highest DANGER in reach used to win, so they swung at some far
        // bot past the tank right next to you); tanks before shapes
        const royaleGun = Config.dig_royale && (this.body.master.master.isPlayer || this.body.master.master.isBot);
        const anyTier = this.body.aiSettings.farm || this.body.master.master.isRoyaleBoss || royaleGun;
        const tanksIn = royaleGun && validCandidates.some(e => io_nearestDifferentMaster.validEntityTypes.has(e.type));
        const finalTargets = validCandidates.filter((e) => {
            // Even more expensive
            return !this.wouldHitWall(e) && (!tanksIn || io_nearestDifferentMaster.validEntityTypes.has(e.type));
        }).filter(e => {
            if (anyTier || e.dangerValue === mostDangerous) {
                if (this.targetLock && e.id === this.targetLock.id) {
                    keepTarget = true;
                }
                return true;
            }
            return false;
        });
        // Reset target if it's not in there
        if (!keepTarget) {
            this.targetLock = undefined;
        }
        return finalTargets;
    }
    think(input) {
        if ((this.body.isBot && this.body._digWarsCollecting) || this.body.rockOnly) {
            // rockOnly (raid perk drones): never chase a tank, they chew rock
            this.targetLock = undefined;
            return {};
        }
        if (input.main || input.alt || this.body.master.autoOverride) {
            this.targetLock = undefined;
            return {};
        }
        const sic = this.botSic();
        if (sic) return sic;
        let tracking = this.body.topSpeed,
            range = this.body.fov;
        // Use whether we have functional guns to decide
        for (let i = 0; i < this.body.guns.length; i++) {
            if (this.body.guns[i].canShoot && !this.body.aiSettings.SKYNET) {
                let v = this.body.guns[i].getTracking();
                if (v.speed == 0 || v.range == 0) continue;
                tracking = v.speed;
                range = Math.min(range, (v.speed || 1.5) * (v.range < (this.body.size * 2) ? this.body.fov : v.range));
                break;
            }
        }
        if (!Number.isFinite(tracking)) {
            tracking = this.body.topSpeed + .01;
        }
        if (!Number.isFinite(range)) {
            range = 640 * this.body.FOV;
        }
        // Lets see if the entity still lives
        if (this.targetLock && (
            !this.validate(this.targetLock, this.body, this.body.master.master, range * range, range * range * 4 / 3) ||
            this.wouldHitWall(this.body, this.targetLock) // Very expensive
        )) {
            this.targetLock = undefined;
            this.pendingTargetId = null;
            this.tick = 100;
        }
        if (this.targetLock && this.body.isBot && this.targetLockStarted &&
            Date.now() - this.targetLockStarted > 2200 + (1 - util.clamp(this.body.botSkill ?? 0.5, 0, 1)) * 2800 &&
            this.tick % 30 === 0) {
            this.targetLock = undefined;
            this.targetLockStarted = 0;
        }
        // OK, now let's try reprocessing the targets!
        this.tick++;
        if (this.tick > 2) {
            this.tick = 0;
            this.validTargets = this.buildList(range);
            if (this.targetLock && this.validTargets.indexOf(this.targetLock) === -1) {
                this.targetLock = undefined;
            }
            // a boss gun takes anyone else before a new player (terrain/bossGuard.js)
            const bossGun = this.body.master.master.isRoyaleBoss;
            if (bossGun && this.targetLock && bossGuard.dropNewbieLock(this.targetLock, this.validTargets)) this.targetLock = undefined;
            // a royale tank's guns: someone much closer than the lock takes over
            if (!bossGun && this.targetLock && Config.dig_royale && this.validTargets.length > 1 && !this.body._digWarsCombatTarget) {
                const d2 = (e) => (e.x - this.body.x) ** 2 + (e.y - this.body.y) ** 2;
                const cur = d2(this.targetLock) * 0.5;   // ~0.7x the distance
                if (this.validTargets.some(e => e !== this.targetLock && d2(e) < cur)) this.targetLock = undefined;
            }
            if (this.targetLock == null && this.validTargets.length) {
                const preferred = this.body._digWarsCombatTarget && this.validTargets.find(target =>
                    target.id === this.body._digWarsCombatTarget.id
                );
                const candidate = preferred || (bossGun && bossGuard.pickTarget(this.validTargets, this.body)) ||
                    ((this.validTargets.length === 1) ? this.validTargets[0] : nearest(this.validTargets, {
                    x: this.body.x,
                    y: this.body.y
                }));
                if (this.body.isBot) {
                    const delay = 90 + (1 - util.clamp(this.body.botSkill ?? 0.5, 0, 1)) * 310;
                    if (this.pendingTargetId !== candidate.id) {
                        this.pendingTargetId = candidate.id;
                        this.pendingTargetUntil = Date.now() + delay;
                        return {};
                    }
                    if (Date.now() < this.pendingTargetUntil) return {};
                    this.pendingTargetId = null;
                }
                this.targetLock = candidate;
                this.targetLockStarted = Date.now();
                this.tick = -5;
            }
        }
        if (this.targetLock != null) {
            let radial = this.targetLock.velocity,
                diff = {
                    x: this.targetLock.x - this.body.x,
                    y: this.targetLock.y - this.body.y,
                };
            if (this.tick % 2 === 0) {
                this.lead = 0;
                if (!this.body.aiSettings.CHASE) {
                    let toi = timeOfImpact(diff, radial, tracking);
                    this.lead = toi;
                }
            }
            if (!Number.isFinite(this.lead)) {
                this.lead = 0;
            }
            let target = {
                x: diff.x + this.lead * radial.x,
                y: diff.y + this.lead * radial.y,
            };
            if (this.body.isBot) {
                const skill = util.clamp(this.body.botSkill ?? 0.5, 0, 1);
                // the target's bot difficulty (botDifficulty.js)
                let tr = this.targetLock, hops = 0;
                while (tr.master && tr.master !== tr && hops++ < 8) tr = tr.master;
                const diff = botDiff.of(tr);
                const desired = Math.atan2(target.y, target.x);
                if (this.botAimAngle == null) this.botAimAngle = desired;
                let turn = desired - this.botAimAngle;
                while (turn > Math.PI) turn -= Math.PI * 2;
                while (turn < -Math.PI) turn += Math.PI * 2;
                this.botAimAngle += turn * (0.12 + skill * 0.28) * botDiff.turretTurn(diff) * botDiff.gentleTurret(botDiff.gentle(tr));
                if (Date.now() >= this.botAimNoiseAt) {
                    this.botAimNoiseAt = Date.now() + 140;
                    this.botAimNoise = ran.gauss(0, (1 - skill) * 0.16 + botDiff.turretNoise(diff));
                }
                const c = Math.cos(this.botAimAngle + this.botAimNoise), s = Math.sin(this.botAimAngle + this.botAimNoise);
                const length = Math.hypot(target.x, target.y);
                target = { x: length * c, y: length * s };
            }
            return {
                target,
                goal: this.mapGoal ? {
                    x: this.targetLock.x,
                    y: this.targetLock.y,
                } : undefined,
                fire: true,
                main: true
            };
        }
        // Nothing hostile in reach: fall back to the nearest rock (rock is
        // terrain, not a targetable entity), so auto-turret-only tanks can mine.
        const rock = this.rockTarget(range);
        if (rock) return { target: rock, fire: true, main: true };
        return {};
    }
    // Throttled (nearestRock scans a grid neighbourhood). Player-owned turrets
    // only; bosses and sentries do not mine.
    rockTarget(range) {
        const b = this.body;
        if (!b || b.master.autoOverride) return null;
        // a drone dies on the rock it hits: an idle one stays by its tank
        if (b.type === 'drone') return null;
        let root = b, guard = 0;
        while (root.master && root.master !== root && guard++ < 8) root = root.master;
        if (!root.isPlayer && !root.isBot) return null;
        const tg = global.gameManager && global.gameManager.terrainGrid;
        if (!tg || !tg.nearestRock) return null;
        const now = Date.now();
        if (this._rockAt && now - this._rockAt < 400 && this._rock) {
            if (this._rock.alive) return { x: this._rock.wx - b.x, y: this._rock.wy - b.y };
            this._rock = null;
        }
        this._rockAt = now;
        // Prefer ore; plain rock only when it is close.
        this._rock = tg.nearestRockWhere
            ? (tg.nearestRockWhere(b.x, b.y, Math.min(range || 500, 620), rock => rock.ore) ||
               tg.nearestRockWhere(b.x, b.y, Math.min(range || 400, 420)))
            : tg.nearestRock(b.x, b.y, Math.min(range || 500, 620));
        if (!this._rock || !this._rock.alive) { this._rock = null; return null; }
        return { x: this._rock.wx - b.x, y: this._rock.wy - b.y };
    }
}
class io_healTeamMasters extends IO {
    constructor(body) {
        super(body);
        this.targetLock = undefined;
        this.tick = ran.irandom(30);
        this.lead = 0;
        this.validTargets = [];
        this.pendingTargetId = null;
        this.pendingTargetUntil = 0;
        this.targetLockStarted = 0;
    }
    validate(e) {
        const myMaster = this.body.master.master;
        const theirMaster = e.master.master;
        let fear = e.fear ?? 0.7;
        if (e.health.amount <= 0) return false;
        if (theirMaster.team !== myMaster.team) return false;
        if (theirMaster.ignoredByAi || theirMaster.adminSpec) return false;
        if (e.bond) return false;
        if (e.type !== "tank") return false;
        if (e.isDominator) return false;
        if (e.health.amount > e.health.max * fear) return false;
        if (e.invuln || e.godmode || theirMaster.godmode || theirMaster.passive || myMaster.passive) return false;
        if (isNaN(e.dangerValue)) return false;
        return true;
    }
    wouldHitWall(entity) {
        if (!this.lockThroughWalls) return wouldHitWall(this.body, entity);
        else return false;
    }
    buildList(range) {
        const sqrRange = range * range;
        const sqrRangeMaster = sqrRange * 4 / 3;
        const validCandidates = [];
        for (const e of targetableEntities.values()) {
            if (this.validate(e, this.body, this.body.master.master, sqrRange, sqrRangeMaster) && !this.wouldHitWall(e)) {
                if (this.body.aiSettings.view360 || Math.abs(util.angleDifference(util.getDirection(this.body, e), this.body.firingArc[0])) < this.body.firingArc[1]) {
                    validCandidates.push(e);
                }
            }
        }
        if (!validCandidates.length) {
            this.targetLock = undefined;
            return [];
        }
        let mostDangerous = 0;
        for (const e of validCandidates) {
            mostDangerous = Math.max(e.dangerValue, mostDangerous);
        }
        let keepTarget = false;
        const finalTargets = validCandidates.filter((e) => {
            // Even more expensive
            return !this.wouldHitWall(e);
        }).filter(e => {
            if (this.body.aiSettings.farm || e.dangerValue === mostDangerous) {
                if (this.targetLock && e.id === this.targetLock.id) {
                    keepTarget = true;
                }
                return true;
            }
            return false;
        });
        // Reset target if it's not in there
        if (!keepTarget) {
            this.targetLock = undefined;
        }
        return finalTargets;
    }
    think(input) {
        if (this.body.isBot && this.body._digWarsCollecting) {
            this.targetLock = undefined;
            return {};
        }
        if (input.main || input.alt || this.body.master.autoOverride) {
            this.targetLock = undefined;
            return {};
        }
        let tracking = this.body.topSpeed,
            range = this.body.fov;
        // Use whether we have functional guns to decide
        for (let i = 0; i < this.body.guns.length; i++) {
            if (this.body.guns[i].canShoot && !this.body.aiSettings.SKYNET) {
                let v = this.body.guns[i].getTracking();
                if (v.speed == 0 || v.range == 0) continue;
                tracking = v.speed;
                range = Math.min(range, (v.speed || 1.5) * (v.range < (this.body.size * 2) ? this.body.fov : v.range));
                break;
            }
        }
        if (!Number.isFinite(tracking)) {
            tracking = this.body.topSpeed + .01;
        }
        if (!Number.isFinite(range)) {
            range = 340 * this.body.FOV;
        }
        // Lets see if the entity still lives
        if (this.targetLock && (
            !this.validate(this.targetLock, this.body, this.body.master.master, range * range, range * range * 4 / 3) ||
            this.wouldHitWall(this.body, this.targetLock) // Very expensive
        )) {
            this.targetLock = undefined;
            this.pendingTargetId = null;
            this.tick = 100;
        }
        if (this.targetLock && this.body.isBot && this.targetLockStarted &&
            Date.now() - this.targetLockStarted > 2200 + (1 - util.clamp(this.body.botSkill ?? 0.5, 0, 1)) * 2800 &&
            this.tick % 30 === 0) {
            this.targetLock = undefined;
            this.targetLockStarted = 0;
        }
        // OK, now let's try reprocessing the targets!
        this.tick++;
        if (this.tick > 2) {
            this.tick = 0;
            this.validTargets = this.buildList(range);
            if (this.targetLock && this.validTargets.indexOf(this.targetLock) === -1) {
                this.targetLock = undefined;
            }
            if (this.targetLock == null && this.validTargets.length) {
                const preferred = this.body._digWarsCombatTarget && this.validTargets.find(target =>
                    target.id === this.body._digWarsCombatTarget.id
                );
                const candidate = preferred || ((this.validTargets.length === 1) ? this.validTargets[0] : nearest(this.validTargets, {
                    x: this.body.x,
                    y: this.body.y
                }));
                if (this.body.isBot) {
                    const delay = 90 + (1 - util.clamp(this.body.botSkill ?? 0.5, 0, 1)) * 310;
                    if (this.pendingTargetId !== candidate.id) {
                        this.pendingTargetId = candidate.id;
                        this.pendingTargetUntil = Date.now() + delay;
                        return {};
                    }
                    if (Date.now() < this.pendingTargetUntil) return {};
                    this.pendingTargetId = null;
                }
                this.targetLock = candidate;
                this.targetLockStarted = Date.now();
                this.tick = -5;
            }
        }
        if (this.targetLock != null) {
            let radial = this.targetLock.velocity,
                diff = {
                    x: this.targetLock.x - this.body.x,
                    y: this.targetLock.y - this.body.y,
                };
            if (this.tick % 2 === 0) {
                this.lead = 0;
            }
            if (!Number.isFinite(this.lead)) {
                this.lead = 0;
            }
            return {
                target: {
                    x: diff.x + this.lead * radial.x,
                    y: diff.y + this.lead * radial.y,
                },
                goal: undefined,
                fire: true,
                main: true
            };
        }
        return {};
    }
}
class io_avoid extends IO {
    constructor(body) {
        super(body)
    }
    think(input) {
        let masterId = this.body.master.id
        let range = this.body.size * this.body.size * 100
        this.avoid = nearest(entities, {
            x: this.body.x,
            y: this.body.y
        }, function (test, sqrdst) {
            return (test.master.id !== masterId && (test.type === 'bullet' || test.type === 'drone' || test.type === 'swarm' || test.type === 'trap' || test.type === 'block') && sqrdst < range);
        })
        // Aim at that target
        if (this.avoid != null) {
            // Consider how fast it's moving.
            let delt = new Vector(this.body.velocity.x - this.avoid.velocity.x, this.body.velocity.y - this.avoid.velocity.y)
            let diff = new Vector(this.avoid.x - this.body.x, this.avoid.y - this.body.y);
            let comp = (delt.x * diff.x + delt.y * diff.y) / delt.length / diff.length
            let goal = {}
            if (comp > 0) {
                if (input.goal) {
                    let goalDist = Math.sqrt(range / (input.goal.x * input.goal.x + input.goal.y * input.goal.y))
                    goal = {
                        x: input.goal.x * goalDist - diff.x * comp,
                        y: input.goal.y * goalDist - diff.y * comp,
                    }
                } else {
                    goal = {
                        x: -diff.x * comp,
                        y: -diff.y * comp,
                    }
                }
                return goal
            }
        }
    }
}
class io_minion extends IO {
    constructor(body, opts = {}) {
        super(body)
        this.turnwise = 1
        this.opts = opts;
    }
    think(input) {
        if (input.goal != null && (this.body._digWarsGoalLocked || this.body._digWarsGoal === 'mine')) return {};
        if (this.body.aiSettings.reverseDirection && ran.chance(0.005)) {
            this.turnwise = -1 * this.turnwise;
        }
        if (input.target != null && (input.alt || input.main)) {
            let sizeFactor = Math.sqrt(this.body.master.size / this.body.master.SIZE)
            let leash = 82 * sizeFactor
            let orbit = this.opts.turnwiserange ?? 140 * sizeFactor
            let repel = 142 * sizeFactor
            let goal
            let power = 1
            let target = new Vector(input.target.x, input.target.y)
            if (input.alt) {
                // Leash
                if (target.length < leash) {
                    goal = {
                        x: this.body.x + target.x,
                        y: this.body.y + target.y,
                    }
                    // Spiral repel
                } else if (target.length < repel) {
                    let dir = -this.turnwise * target.direction + Math.PI / 5
                    goal = {
                        x: this.body.x + Math.cos(dir),
                        y: this.body.y + Math.sin(dir),
                    }
                    // Free repel
                } else {
                    goal = {
                        x: this.body.x - target.x,
                        y: this.body.y - target.y,
                    }
                }
            } else if (input.main) {
                // Orbit point
                let dir = this.turnwise * target.direction + 0.01
                goal = {
                    x: this.body.x + target.x - orbit * Math.cos(dir),
                    y: this.body.y + target.y - orbit * Math.sin(dir),
                }
                if (Math.abs(target.length - orbit) < this.body.size * 2) {
                    power = 0.7
                }
            }
            return {
                goal: goal,
                power: power,
            }
        }
    }
}
class io_hangOutNearMaster extends IO {
    constructor(body) {
        super(body)
        this.acceptsFromTop = false
        this.orbit = 30
        this.currentGoal = {
            x: this.body.source.x,
            y: this.body.source.y,
        }
        this.timer = 0
    }
    think(input) {
        if (this.body.invisible[1]) return {}
        if (this.body.source !== this.body) {
            let bound1 = this.orbit * 0.8 + this.body.source.size + this.body.size
            let bound2 = this.orbit * 1.5 + this.body.source.size + this.body.size
            let dist = util.getDistance(this.body, this.body.source) + Math.PI / 8;
            let output = {
                target: {
                    x: this.body.velocity.x,
                    y: this.body.velocity.y,
                },
                goal: this.currentGoal,
                power: undefined,
            };
            // Set a goal
            if (dist > bound2 || this.timer > 30) {
                this.timer = 0
                let dir = util.getDirection(this.body, this.body.source) + Math.PI * ran.random(0.5);
                let len = ran.randomRange(bound1, bound2)
                let x = this.body.source.x - len * Math.cos(dir)
                let y = this.body.source.y - len * Math.sin(dir)
                this.currentGoal = { x: x, y: y };
            }
            if (dist < bound2) {
                output.power = 0.15
                if (ran.chance(0.3)) {
                    this.timer++;
                }
            }
            return output
        }
    }
}
class io_spin extends IO {
    constructor(b, opts = {}) {
        super(b)
        this.a = opts.startAngle || 0;
        this.speed = opts.speed ?? 0.04;
        this.onlyWhenIdle = opts.onlyWhenIdle;
        this.independent = opts.independent;
    }
    think(input) {
        if (this.onlyWhenIdle && input.target) {
            this.a = Math.atan2(input.target.y, input.target.x);
            return input;
        }
        this.a += this.speed;
        let offset = (this.independent && this.body.bond != null) ? this.body.bound.angle : 0;
        return {
            target: {
                x: Math.cos(this.a + offset),
                y: Math.sin(this.a + offset),
            },
            main: true,
        };
    }
}
class io_spin2 extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.speed = opts.speed ?? 0.04;
        this.reverseOnAlt = opts.reverseOnAlt ?? true;
        this.lastAlt = -1;
        this.reverseOnTheFly = opts.reverseOnTheFly ?? false;

        // On spawn logic
        let alt = this.body.master.control.alt;
        let reverse = (this.reverseOnAlt && alt) ? -1 : 1;
        this.body.facingType = "spin";
        this.body.facingTypeArgs = {speed: this.speed * reverse};
    }
    think(input) {
        if (!this.reverseOnTheFly || !this.reverseOnAlt) return;

        // Live logic
        let alt = this.body.master.control.alt;
        if (this.lastAlt != alt) {
            let reverse = alt ? -1 : 1;
            this.body.facingType = "spin";
            this.body.facingTypeArgs = {speed: this.speed * reverse};
            this.lastAlt = alt;
        }
    }
}
class io_fleeAtLowHealth extends IO {
    constructor(b) {
        super(b)
        this.fear = util.clamp(ran.gauss(0.7, 0.15), 0.1, 0.9);
        b.fear = this.fear;
    }
    think(input) {
        if (input.goal != null && this.body._digWarsGoalLocked) return {};
        if (input.fire && input.target != null && this.body.health.amount < this.body.health.max * this.fear) {
            return {
                goal: {
                    x: this.body.x - input.target.x,
                    y: this.body.y - input.target.y,
                },
            }
        }
    }
}

class io_zoom extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.distance = opts.distance || 225;
        this.dynamic = opts.dynamic;
        this.permanent = opts.permanent;
    }

    think(input) {
        if (this.permanent || (input.alt && input.target)) {
            if (this.dynamic || this.body.cameraOverrideX === null) {
                let direction = Math.atan2(input.target.y, input.target.x);
                this.body.cameraOverrideX = this.body.x + this.distance * Math.cos(direction);
                this.body.cameraOverrideY = this.body.y + this.distance * Math.sin(direction);
            }
        } else {
            this.body.cameraOverrideX = null;
            this.body.cameraOverrideY = null;
        }
    }
}
class io_wanderAroundMap extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.lookAtGoal = opts.lookAtGoal;
        this.replicatePlayerMovement = opts.replicatePlayerMovement;
        this.spot = ran.choose(global.gameManager.room.spawnableDefault).randomInside();

        this.bossWander = opts.diepBossWander;
        this.howFarAwayFromEdgeOfMap = 15;
        this.tick = 0;
        this.currentGoal = {x:0,y:0};
        this.i = 0;
        this.enabled = true;
        this.botMoveEnabled = true;
    }
    think(input) {
        if (Config.BOT_MOVE && this.botMoveEnabled) {
            this.enabled = false;
            for (let e of Config.BOT_MOVE) {
                if ((e.TEAM === "any" || this.body.team == e.TEAM) && e.MOVEMENT && !input.fire) {
                    if (!this.moveArray) this.botMove_active = true, this.moveArray = 0, this.arrayLength = e.MOVEMENT.length - 1; // Set flags
                    let i = e.MOVEMENT[this.moveArray];
                    let [locX, locY] = i;
                    if (new Vector( this.body.x - locX * 30, this.body.y - locY * 30 ).isShorterThan(e.RANGE ?? 50)) {
                        if (this.moveArray == this.arrayLength) this.botMoveEnabled = false, this.enabled = true;
                        this.moveArray++;
                    }
                    if (input.goal == null && !this.body.autoOverride) {
                        let loc = compressMovement(this.body, { x: locX * 30, y: locY * 30 });
                        return {
                            target: (this.lookAtGoal && input.target == null) ? {
                                x: locX * 30 - this.body.x,
                                y: locY * 30 - this.body.y
                            } : null,
                            goal: loc,
                        };
                    }
                }
            }
            if (!this.botMove_active) this.botMoveEnabled = false, this.enabled = true;
        }
        if (this.enabled) {
            if (this.bossWander) {
                let points = [{
                    x: global.gameManager.room.width / this.howFarAwayFromEdgeOfMap, // top left
                    y: global.gameManager.room.height / this.howFarAwayFromEdgeOfMap
                }, {
                    x: global.gameManager.room.width - (global.gameManager.room.width / this.howFarAwayFromEdgeOfMap), // top right
                    y: global.gameManager.room.height / this.howFarAwayFromEdgeOfMap
                }, {
                    x: global.gameManager.room.width - (global.gameManager.room.width / this.howFarAwayFromEdgeOfMap), // bottom right
                    y: global.gameManager.room.height - (global.gameManager.room.height / this.howFarAwayFromEdgeOfMap)
                }, {
                    x: global.gameManager.room.width / this.howFarAwayFromEdgeOfMap, // bottom left
                    y: global.gameManager.room.height - (global.gameManager.room.height / this.howFarAwayFromEdgeOfMap)
                }]
                this.tick++
                this.currentGoal = points[this.i]
                let distanceFromPoint = util.getDistance(this.body, this.currentGoal)
                if (this.tick >= 100 + distanceFromPoint + (this.body.SPEED < 5 ? 1000 : 0)) {
                    this.tick = 0
                    if (this.i >= points.length - 1) {
                        this.i = 0
                    } else {
                        this.i++
                    }
                    this.currentGoal = points[this.i]
                }
                return {
                    goal: {
                        x: this.currentGoal.x,
                        y: this.currentGoal.y
                    },
                    target: this.lookAtGoal ? {
                        x: this.currentGoal.x,
                        y: this.currentGoal.y
                    } : null
                }
            }
            if (new Vector( this.body.x - this.spot.x, this.body.y - this.spot.y ).isShorterThan(50) || wouldHitWall(this.body, this.spot, true)) {
                this.spot = ran.choose(global.gameManager.room.spawnableDefault).randomInside();
            }
            if (input.goal == null && !this.body.autoOverride) {
                let goal = this.spot;
                if (this.replicatePlayerMovement) {
                    goal = compressMovement(this.body, goal);
                }
                return {
                    target: (this.lookAtGoal && input.target == null) ? {
                        x: this.spot.x - this.body.x,
                        y: this.spot.y - this.body.y
                    } : null,
                    goal
                };
            }
        }
    }
}
// returns deviation from origin angle in radians
let io_formulaTarget_sineDefault = (frame, body) => Math.sin(frame / 30);
class io_formulaTarget extends IO {
    constructor (b, opts = {}) {
        super(b);
        this.masterAngle = opts.masterAngle;
        this.formula = opts.formula || io_formulaTarget_sineDefault;
        //this.updateOriginAngle = opts.updateOriginAngle;
        this.originAngle = this.masterAngle ? b.master.facing : b.facing;
        this.frame = 0;
    }
    think () {
        // if (this.updateOriginAngle) {
        //     this.originAngle = this.masterAngle ? b.master.facing : getTheGunThatSpawnedMe("how do i do that????").angle;
        // }

        let angle = this.originAngle + this.formula(this.frame += 1 / global.gameManager.runSpeed, this.body);
        return {
            goal: {
                x: this.body.x + Math.sin(angle),
                y: this.body.y + Math.cos(angle)
            }
        };
    }
}
class io_whirlwind extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.body.useOwnMaster = opts.useOwnMaster;
        this.body.angle = 0;
        this.minDistance = opts.minDistance ?? 3.5;
        this.maxDistance = opts.maxDistance ?? 10;
        this.body.dist = opts.initialDist || this.minDistance * this.body.size;
        this.body.inverseDist = this.maxDistance * this.body.size - this.body.dist + this.minDistance * this.body.size;
        this.radiusScalingSpeed = opts.radiusScalingSpeed || 10;
    }

    think(input) {
        this.body.angle += (this.body.skill.spd * 2 + this.body.aiSettings.SPEED) * Math.PI / 180;
        let trueMaxDistance = this.maxDistance * this.body.size;
        let trueMinDistance = this.minDistance * this.body.size;
        if(input.fire){
            if(this.body.dist <= trueMaxDistance) {
                this.body.dist += this.radiusScalingSpeed;
                this.body.inverseDist -= this.radiusScalingSpeed;
            }
        }
        else if(input.alt){
            if(this.body.dist >= trueMinDistance) {
                this.body.dist -= this.radiusScalingSpeed;
                this.body.inverseDist += this.radiusScalingSpeed;
            }
        }
        this.body.dist = Math.min(trueMaxDistance, Math.max(trueMinDistance, this.body.dist));
        this.body.inverseDist = Math.min(trueMaxDistance, Math.max(trueMinDistance, this.body.inverseDist));
    }
}
class io_orbit extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.realDist = 0;
        this.invert = opts.invert ?? false;
    }

    think(input) {
        let invertFactor = this.invert ? -1 : 1,
            master = this.body.master.useOwnMaster ? this.body.master : this.body.master.master,
            dist = this.invert ? master.inverseDist : master.dist,
            angle = (this.body.angle * Math.PI / 180 + master.angle) * invertFactor;

        if(this.realDist > dist){
            this.realDist -= Math.min(10, Math.abs(this.realDist - dist));
        }
        else if(this.realDist < dist){
            this.realDist += Math.min(10, Math.abs(dist - this.realDist));
        }
        this.body.x = master.x + Math.cos(angle) * this.realDist;
        this.body.y = master.y + Math.sin(angle) * this.realDist;

        this.body.facing = angle;
    }
}
class io_snake extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.waveInvert = opts.invert ? -1 : 1;
        this.wavePeriod = opts.period ?? 5;
        this.waveAmplitude = opts.amplitude ?? 150;
        this.yOffset = opts.yOffset ?? 0;

        this.reverseWave = this.body.master.control.alt ? -1 : 1;
        this.velocityMagnitude = 0;
        this.body.damp = 0;
        this.waveAngle = this.body.master.facing + (opts.angle ?? 0);
        this.startX = this.body.x;
        this.startY = this.body.y;
        this.body.x += Math.cos(this.body.velocity.direction) * this.body.size * Config.bullet_spawn_offset + 0;
        this.body.y += Math.sin(this.body.velocity.direction) * this.body.size * Config.bullet_spawn_offset + 0;
        // Clamp scale to [45, 75]
        // Attempts to get the bullets to intersect with the cursor
        this.waveHorizontalScale = util.clamp(util.getDistance(this.body.master.master.control.target, {x: 0, y: 0}) / Math.PI, 45, 75);
    }
    think(input) {
        // Define a sin wave for the bullet to follow
        let waveX = this.waveHorizontalScale * (this.body.RANGE - this.body.range) / this.wavePeriod;
        let waveY = this.waveAmplitude * Math.sin(waveX / this.waveHorizontalScale) * this.waveInvert * this.reverseWave + this.yOffset;
        // Rotate the sin wave
        let trueWaveX = Math.cos(this.waveAngle) * waveX - Math.sin(this.waveAngle) * waveY;
        let trueWaveY = Math.sin(this.waveAngle) * waveX + Math.cos(this.waveAngle) * waveY;
        // Follow the sin wave
        this.body.x = util.lerp(this.body.x, this.startX + trueWaveX, this.velocityMagnitude);
        this.body.y = util.lerp(this.body.y, this.startY + trueWaveY, this.velocityMagnitude);
        // Accelerate after spawning
        this.velocityMagnitude = Math.min(0.1, this.velocityMagnitude + 0.01 / global.gameManager.runSpeed)
    }
}

class io_disableOnOverride extends IO {
    constructor(body) {
        super(body);
        this.pacify = false;
        this.lastPacify = false;
        this.savedDamage = 0;
    }

    think(input) {
        if (!this.initialAlpha) {
            this.initialAlpha = this.body.alpha;
            this.targetAlpha = this.initialAlpha;
        }

        this.pacify = (this.body.parent.master.autoOverride || this.body.parent.master.master.autoOverride);
        if (this.pacify && !this.lastPacify) {
            this.targetAlpha = 0;
            this.savedDamage = this.body.DAMAGE;
            this.body.DAMAGE = 0;
            this.body.refreshBodyAttributes();
        } else if (!this.pacify && this.lastPacify) {
            this.targetAlpha = this.initialAlpha;
            this.body.DAMAGE = this.savedDamage;
            this.body.refreshBodyAttributes();
        }
        this.lastPacify = this.pacify;

        if (this.body.alpha != this.targetAlpha) {
            this.body.alpha += util.clamp(this.targetAlpha - this.body.alpha, -0.05, 0.05);
            if (this.body.flattenedPhoto) this.body.flattenedPhoto.alpha = this.body.alpha;
        }
    }
}

class io_scaleWithMaster extends IO {
    constructor(body) {
        super(body);
        this.storedSize = 0;
    }
    think(input) {
        let masterSize = this.body.master.size;
        if (masterSize != this.storedSize) {
            this.storedSize = masterSize;
            this.body.SIZE = masterSize * this.body.size / this.body.master.size;
        }
    }
}

// ── Dig Wars bots ────────────────────────────────────────────────────────
// BotNav owns "how do I get there"; io_digWarsGoals owns "where am I going
// and what am I shooting at". Keeping them apart stops routes being
// re-decided every tick.
const digWarsVault = require('../game/terrain/vault.js');
const digWarsOutposts = require('../game/terrain/outposts.js');
const digWarsChambers = require('../game/terrain/coreChambers.js');
const padGeom = require('../game/terrain/padGeom.js');
// per-target bot difficulty (0 new player .. 1 the hardest we allow)
const botDiff = require('./botDifficulty.js');
const drive = require('./drive.js');
const SENSE_MAX_R = 2500;       // the radar ping's reach, the widest a bot ever sees
const tactics = require('./botTactics.js');
const bossGuard = require('../game/terrain/bossGuard.js');
const activity = require('../game/network/activity.js');
const spawnShield = require('../game/terrain/spawnShield.js');
const newcomer = require('../game/terrain/newcomerDirector.js');
// who bots leave alone (vaults, banking, bullies, small fish, first kills) and
const fairPlay = require('../game/terrain/fairPlay.js');
// Shop pads are a no-go zone for bots (they cannot buy, and a bot on the pad
// shoves the shopper). Refreshed once a second.
let shopPadCache = { at: 0, pads: [] };
function royaleShopPads() {
    const now = Date.now();
    if (now - shopPadCache.at > 1000) {
        shopPadCache.at = now;
        try { shopPadCache.pads = Config.dig_royale ? require('../game/terrain/shop.js').getShops() : []; } catch { shopPadCache.pads = []; }
    }
    return shopPadCache.pads;
}

const TAU = Math.PI * 2;
const wrapAngle = a => {
    a %= TAU;
    if (a > Math.PI) a -= TAU;
    if (a < -Math.PI) a += TAU;
    return a;
};

// Base tiles kill any wrong-team entity outright, so to a bot every enemy
// base tile is a wall.
const baseTileCache = { room: null, owners: null };
function baseTileOwner(x, y) {
    const room = global.gameManager && global.gameManager.room;
    if (!room || !room.getAt) return undefined;
    if (baseTileCache.room !== room) {
        baseTileCache.room = room;
        baseTileCache.owners = new Map();
        const spawnable = room.spawnable || {};
        for (const key of Object.keys(spawnable)) {
            const tiles = spawnable[key];
            if (!Array.isArray(tiles)) continue;
            for (const tile of tiles) baseTileCache.owners.set(tile, Number(key));
        }
    }
    const tile = room.getAt({ x, y });
    return tile ? baseTileCache.owners.get(tile) : undefined;
}
function inEnemyBase(team, x, y) {
    const owner = baseTileOwner(x, y);
    return owner !== undefined && owner !== team;
}

// Shared view of the world for bot AI (tanks and gems), rebuilt at most
// every 110ms and reused by every bot.
const botScan = { at: 0, tanks: [], gems: [] };
// Dig Royale fresh-spawn rules (dig_royale.js FIRST_MINUTES): a player in
// bot grace is invisible to bots until it expires or they shoot a bot; a new
// player is ranked lower and only NEW_MAX_HUNTERS bots may be on them at once.
let firstMinutesCfg = null;
function firstMinutes() {
    if (firstMinutesCfg) return firstMinutesCfg;
    try { firstMinutesCfg = require('../game/gamemodes/scripts/dig_royale.js').FIRST_MINUTES || null; } catch { /* */ }
    return firstMinutesCfg || { NEW_TARGET_PENALTY: 600, NEW_MAX_HUNTERS: 1, SOFT_CLOSE_R: 320, SOFT_HIT_MS: 4000, MAX_HUNTERS: 2, BOT_SOFT_MS: 120_000 };
}
// A player with no real input for a minute (network/activity.js) gets none
// of it: grace, the soft window and the newcomer difficulty are for someone
// playing, not for a tank left standing on autofire.
function inBotGrace(root, now) {
    return !!(root && (root.isPlayer || root.isBot) && (root.botGraceUntil || 0) > now && !activity.unprotected(root, now));
}
// Round 11 (Oct 6 2026): raid-opening grace, the same for every human. In
// the first ROYALE_OPEN_GRACE_S (180) seconds of a raid bots mostly mine and
// fight each other: only a share of bots (ROYALE_OPEN_SHARE, 0.3, a fixed
// roll per bot and player) start a fight with a human from range, the rest
// only if the human comes within OPEN_CLOSE_R or shoots them. Humans rank
// farther off as targets and bots take longer to react. Fighting back is
// never blocked. 0 turns it off.
function envNum(k, d) { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; }
const OPEN_GRACE_MS = envNum('ROYALE_OPEN_GRACE_S', 180) * 1000;
const OPEN_SHARE = Math.min(1, envNum('ROYALE_OPEN_SHARE', 0.3));
const OPEN_CLOSE_R = 360;
const OPEN_TARGET_PENALTY = 500;
const OPEN_REACT = 1.6;
function raidOpening(now) {
    if (!OPEN_GRACE_MS || typeof Config === 'undefined' || !Config.dig_royale || Config.tutorial) return false;
    const t0 = global.royaleRaidStartAt || 0;
    return t0 > 0 && now >= t0 && now - t0 < OPEN_GRACE_MS;
}
// should this bot hold off starting a fight with this human right now?
function openSpared(bot, target, now) {
    if (!bot || !bot.isBot || !target || !target.isPlayer || !raidOpening(now)) return false;
    if (bot._lastDamageSource === target && now - (bot._lastDamageAt || 0) < 4000) return false;
    const roll = (((bot.id | 0) * 2654435761 + (target.id | 0) * 40503) >>> 0) % 1000 / 1000;
    if (roll < OPEN_SHARE) return false;
    return (target.x - bot.x) ** 2 + (target.y - bot.y) ** 2 > OPEN_CLOSE_R * OPEN_CLOSE_R;
}
botDiff.setOpening(raidOpening);
// Round 12 leader hunt (pacing.js sets global.royaleLeaderHunt after the
// opening grace while the #1 leads #2 by 1.5x or more, human or bot): bots
// within LEADER_R treat them as a priority target, more the bigger the lead
// (LEADER_PULL per 1x of lead past 1x, capped). The soft window does not hide
// a runaway leader; spawn grace, the bank/vault holds, anti-farm, bot mercy
// and the opening grace all still do. At most leaderCap bots go after them.
const LEADER_R = 2400, LEADER_PULL = 520, LEADER_PULL_MAX = 1100;
function leaderHunt(root, now) {
    const h = global.royaleLeaderHunt;
    if (!h || !root || root.id !== h.id || raidOpening(now)) return null;
    return h;
}
function leaderPull(h) { return h ? Math.min(LEADER_PULL_MAX, LEADER_PULL * Math.max(0, h.ratio - 1)) : 0; }
function leaderCap(h) { return h ? (h.ratio >= 2.5 ? 4 : h.ratio >= 2 ? 3 : 2) : 0; }
function leaderHunters(id, self) {
    let n = 0;
    for (const tank of botWorldScan().tanks) {
        if (!tank.isBot || tank === self || tank.isDead?.()) continue;
        if (tank._leaderHuntId === id || tank._botEnemyId === id || tank._fightingPlayerId === id) n++;
    }
    return n;
}
// A player in the soft window (the start of every life, or any life of a
// new player) is only fought by a bot they walk right up to or shoot. The
// window is long while a player is new and short after (body.botSoftMs,
// dig_royale freshRaidBody), and shrinks with their bot difficulty on top:
// all of it at 0, a third at the hardest (botDifficulty.js softShare).
function botSoft(root, now) {
    if (!root || !root.isPlayer) return false;
    if (activity.unprotected(root, now)) return false;
    if (root.botNewbie) return true;
    const until = root.botSoftUntil || 0;
    if (until <= now) return false;
    const full = root.botSoftMs || firstMinutes().BOT_SOFT_MS || 120_000;
    return now < until - full + full * botDiff.softShare(botDiff.of(root, now));
}
function softSpared(bot, target, now) {
    if (!botSoft(target, now)) return false;
    const fm = firstMinutes();
    // round 9: shot for 25% of the bot's health (fairPlay.provoked), not once
    if ((!fairPlay.on('hit25') || fairPlay.provoked(bot, target)) &&
        bot._lastDamageSource === target && now - (bot._lastDamageAt || 0) < (fm.SOFT_HIT_MS || 4000)) return false;
    const r = (fm.SOFT_CLOSE_R || 320) / 320 * botDiff.softCloseR(botDiff.of(target, now));
    return (target.x - bot.x) ** 2 + (target.y - bot.y) ** 2 > r * r;
}
// Round 9 target scoring: a bot mostly fights tanks near its own size
const SIZE_PREF = process.env.ROYALE_BOT_SIZE_PREF !== '0';
const SIZE_HI = 2, SIZE_LO = 0.5, SIZE_FLOOR = 150, SIZE_PENALTY = 420;
function sizePenalty(bot, target) {
    if (!SIZE_PREF || !bot || !target || !bot.isBot) return 0;
    const b = Math.max(SIZE_FLOOR, +bot._fpPts || 0), r = Math.max(SIZE_FLOOR, +target._fpPts || 0);
    const ratio = r / b;
    return ratio > SIZE_HI || ratio < SIZE_LO ? SIZE_PENALTY : 0;
}
// how many bots may be on one player at once (a third on a rich veteran)
function hunterCap(root, now) {
    const lh = leaderHunt(root, now);
    if (lh) return leaderCap(lh);
    if (botSoft(root, now)) return firstMinutes().NEW_MAX_HUNTERS;
    const cap = botDiff.maxHunters(botDiff.of(root, now), root.carriedGems, root.huntedLevel);
    // a crowned player gets fought like anyone, never by a pack
    // (crowns.js MAX_HUNTERS)
    if (root.crowned) return Math.min(cap, CROWN_MAX_HUNTERS);
    return cap > 2 ? cap : Math.min(firstMinutes().MAX_HUNTERS || 2, cap);
}
const CROWN_MAX_HUNTERS = 2;
// bots other than `self` currently aiming at / chasing `target`
function botsOn(target, self) {
    let n = 0;
    for (const tank of botWorldScan().tanks) {
        if (!tank.isBot || tank === self || tank.isDead?.()) continue;
        if (tank._botEnemyId === target.id || tank._fightingPlayerId === target.id) n++;
    }
    return n;
}

function botWorldScan() {
    const now = Date.now();
    if (now - botScan.at < 110) return botScan;
    botScan.at = now;
    const tanks = [], gems = [], shots = [];
    const dodge = tactics.isEnabled() && botDiff.isLockOn();
    const targetable = global.targetableEntities;
    if (targetable) {
        for (const entity of targetable.values()) {
            const type = entity.type;
            if (type === 'tank' || type === 'miniboss' || type === 'crasher') tanks.push(entity);
        }
    }
    if (global.entities) {
        for (const entity of global.entities.values()) {
            // gems locked inside a standing core chamber are unreachable
            if (entity.isGemPickup && entity.gemValue > 0 && entity.chamberHome === undefined &&
                !entity.isDead?.()) gems.push(entity);
            else if (dodge && tactics.isShot(entity)) shots.push(entity);
        }
    }
    botScan.tanks = tanks;
    botScan.gems = gems;
    // live bullets by cell, for lock-on bots sidestepping fire (botTactics.threat)
    botScan.shots = dodge ? tactics.bucketShots(shots) : null;
    // Per-scan precomputation shared by every bot (too expensive per bot):
    // gems not on a shop pad, and structures to path around as circles.
    const pads = royaleShopPads();
    botScan.gemsFree = pads.length ? gems.filter(g => !pads.some(pd => padGeom.insidePad(pd, g.x, g.y, 20))) : gems;
    const blockers = [];
    try {
        for (const chamber of digWarsChambers.getChambers()) {
            const entity = chamber.entity;
            if (!entity || entity.isDead?.()) continue;
            blockers.push({ src: chamber, x: chamber.x, y: chamber.y, r: chamber.r * (entity.sizeMultiplier ?? 1) });
        }
        for (const outpost of digWarsOutposts.getOutposts()) {
            const banner = outpost.banner;
            if (!banner || banner.isDead?.()) continue;
            blockers.push({ src: outpost, x: banner.x, y: banner.y, r: (banner.realSize || banner.size || 30) });
        }
        for (const pad of pads) blockers.push({ src: pad, pad, x: pad.x, y: pad.y, r: (pad.r || 95) * 1.25 });
    } catch { /* */ }
    botScan.blockers = blockers;
    return botScan;
}

// Steering directions are tried nearest-first so the straight line wins
// whenever it is open and the fan is only paid for when it is not.
const NAV_OFFSETS = [0, 0.36, -0.36, 0.72, -0.72, 1.1, -1.1, 1.5, -1.5,
                     1.95, -1.95, 2.4, -2.4, 2.85, -2.85, Math.PI];

// Coarse route planning for a bot teammate regrouping with its human.
// Only for the last stretch (past REGROUP_MAX_D dig_royale's catch-up moves
// the bot closer), so a plan stays a few hundred cells.
const REGROUP_CELL = 140, REGROUP_ROCK_COST = 5, REGROUP_MARGIN = 420, REGROUP_MAX_CELLS = 700, REGROUP_MAX_D = 1800;
function planRoute(body, to, nav) {
    const tg = global.gameManager && global.gameManager.terrainGrid;
    if (!tg || !tg.rockHitByCircle) return null;
    if (Math.hypot(to.x - body.x, to.y - body.y) > REGROUP_MAX_D) return null;
    const C = REGROUP_CELL;
    const x0 = Math.min(body.x, to.x) - REGROUP_MARGIN, y0 = Math.min(body.y, to.y) - REGROUP_MARGIN;
    const w = Math.ceil((Math.abs(body.x - to.x) + 2 * REGROUP_MARGIN) / C) + 1;
    const h = Math.ceil((Math.abs(body.y - to.y) + 2 * REGROUP_MARGIN) / C) + 1;
    if (w * h > REGROUP_MAX_CELLS) return null;
    const mapR = (tg.circleRadius || 3000) - 120;
    const radius = Math.max(body.realSize || body.size || 12, 10);
    const cost = new Float32Array(w * h);       // 0 = unknown, -1 = wall
    const cellCost = (i) => {
        if (cost[i]) return cost[i];
        const cx = x0 + (i % w) * C + C / 2, cy = y0 + Math.floor(i / w) * C + C / 2;
        let c = 1;
        if (Math.hypot(cx, cy) > mapR || inEnemyBase(body.team, cx, cy) || (nav && nav.structureBlocks(cx, cy, radius))) c = -1;
        else if (tg.rockHitByCircle(cx, cy, radius * 0.9)) c = REGROUP_ROCK_COST;
        cost[i] = c;
        return c;
    };
    const idx = (x, y) => {
        const cx = Math.floor((x - x0) / C), cy = Math.floor((y - y0) / C);
        return cx < 0 || cy < 0 || cx >= w || cy >= h ? -1 : cy * w + cx;
    };
    const start = idx(body.x, body.y), goal = idx(to.x, to.y);
    if (start < 0 || goal < 0) return null;
    const g = new Float32Array(w * h).fill(Infinity), from = new Int32Array(w * h).fill(-1);
    const heap = [];   // [f, i] binary heap
    const push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    const gx = goal % w, gy = Math.floor(goal / w);
    const hEst = (i) => Math.hypot((i % w) - gx, Math.floor(i / w) - gy);
    g[start] = 0; push(hEst(start), start);
    let found = false, pops = 0;
    while (heap.length && pops++ < REGROUP_MAX_CELLS) {
        const [, i] = pop();
        if (i === goal) { found = true; break; }
        const ix = i % w, iy = Math.floor(i / w);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = ix + dx, ny = iy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            const cj = j === goal ? 1 : cellCost(j);
            if (cj < 0) continue;
            const ng = g[i] + cj * (dx && dy ? 1.414 : 1);
            if (ng < g[j]) { g[j] = ng; from[j] = i; push(ng + hEst(j), j); }
        }
    }
    if (!found) return null;
    const cells = [];
    for (let i = goal; i >= 0 && i !== start; i = from[i]) cells.push(i);
    cells.reverse();
    // every other cell is plenty of waypoints; mark the rock ones (dig there)
    const out = [];
    for (let k = 0; k < cells.length; k++) {
        if (k % 2 && k !== cells.length - 1) continue;
        const i = cells[k];
        out.push({ x: x0 + (i % w) * C + C / 2, y: y0 + Math.floor(i / w) * C + C / 2, rock: cost[i] === REGROUP_ROCK_COST });
    }
    return out;
}

// One committed heading per bot, turned smoothly toward the best open
// direction. A bot with two equally good ways around a boulder must keep
// the one it picked, or it oscillates.
class BotNav {
    constructor(body) {
        this.body = body;
        this.heading = ran.randomAngle();
        this.nextProbeAt = 0;
        this.samples = [];
        this.escapeUntil = 0;
        this.lastEscapeAt = 0;
        this.escalation = 0;
        this.blocked = [];
        this.arrived = false;
    }

    radius() {
        return Math.max(this.body.realSize || this.body.size || 12, 10);
    }

    structureBlocks(x, y, radius) {
        // Only a rammer, and only for the structure it is attacking, may treat
        // a structure as passable (ramming needs contact). Everything else is
        // a wall; gun bots siege from a standoff orbit.
        const attacking = this.body.botIsRammer ? this.body._digWarsObjectivePoint : null;
        const blockers = botWorldScan().blockers || [];
        for (const b of blockers) {
            if (b.src === attacking) continue;
            const reach = b.r + radius;
            const dx = x - b.x, dy = y - b.y;
            if (dx * dx + dy * dy >= reach * reach) continue;
            // shop pads are hexagons: the circle is the cheap pre-check
            if (b.pad) { if (padGeom.insidePad(b.pad, x, y, radius + 6)) return true; continue; }
            return true;
        }
        return false;
    }

    // 0 means blocked immediately, 1 means open for the whole probe.
    clearance(angle, radius, reach) {
        const tg = global.gameManager && global.gameManager.terrainGrid;
        const room = global.gameManager && global.gameManager.room;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const steps = 3;
        let clear = 0;
        for (let i = 1; i <= steps; i++) {
            const x = this.body.x + cos * reach * i / steps;
            const y = this.body.y + sin * reach * i / steps;
            if (room && (Math.abs(x) > room.width / 2 - radius - 30 ||
                         Math.abs(y) > room.height / 2 - radius - 30)) break;
            if (inEnemyBase(this.body.team, x, y)) break;
            if (tg && !this.body.bossDigs && tg.rockHitByCircle(x, y, radius * (i === 1 ? 1.1 : 0.92))) break;
            if (this.structureBlocks(x, y, radius)) break;
            clear++;
        }
        return clear / steps;
    }

    // Directions that recently jammed this tank stay unattractive for a few
    // seconds, so an escape does not immediately walk back into the wall.
    blockedPenalty(angle, now) {
        let worst = 0;
        for (const arc of this.blocked) {
            if (arc.until < now) continue;
            const difference = Math.abs(wrapAngle(angle - arc.angle));
            if (difference < 0.9) worst = Math.max(worst, (1 - difference / 0.9) * 2.6);
        }
        return worst;
    }

    repoint(desired, radius, reach, now) {
        if (this.blocked.length > 6) this.blocked = this.blocked.filter(arc => arc.until > now);
        let bestAngle = desired, bestScore = -Infinity;
        for (const offset of NAV_OFFSETS) {
            const angle = desired + offset;
            const open = this.clearance(angle, radius, reach);
            if (offset === 0 && open >= 1) { bestAngle = desired; break; }
            // Offsets are nearest-first, so the first fully open direction
            // without a hard turn is good enough (keeps probes cheap).
            if (open >= 1 && Math.abs(wrapAngle(angle - this.heading)) < 1.2 &&
                this.blockedPenalty(angle, now) === 0) { bestAngle = angle; break; }
            const score = open * 2.6
                - Math.abs(offset) * 0.85
                - Math.abs(wrapAngle(angle - this.heading)) * 0.7
                - this.blockedPenalty(angle, now);
            if (score > bestScore) { bestScore = score; bestAngle = angle; }
        }
        this.heading = wrapAngle(this.heading + util.clamp(wrapAngle(bestAngle - this.heading), -0.42, 0.42));
    }

    bestEscape(around, radius, now) {
        let bestAngle = around, bestScore = -Infinity;
        for (let i = 0; i < 12; i++) {
            const angle = around + (i % 2 ? -1 : 1) * Math.ceil(i / 2) * 0.52;
            const score = this.clearance(angle, radius, radius * 7) * 3
                - Math.abs(wrapAngle(angle - around)) * 0.4
                - this.blockedPenalty(angle, now);
            if (score > bestScore) { bestScore = score; bestAngle = angle; }
        }
        return bestAngle;
    }

    track(now, wantsMove) {
        if (!wantsMove) { this.samples.length = 0; return; }
        const body = this.body;
        const last = this.samples[this.samples.length - 1];
        if (!last || now - last.t > 180) this.samples.push({ x: body.x, y: body.y, t: now });
        while (this.samples.length > 1 && now - this.samples[0].t > 2000) this.samples.shift();
        if (now < this.escapeUntil || this.samples.length < 9) return;
        const first = this.samples[0], latest = this.samples[this.samples.length - 1];
        if (Math.hypot(latest.x - first.x, latest.y - first.y) > Math.max(8, this.radius() * 0.5)) return;
        this.escape(now);
    }

    escape(now) {
        const body = this.body;
        body._unstickCount = (body._unstickCount || 0) + 1;
        this.escalation = now - this.lastEscapeAt < 5000 ? Math.min(3, this.escalation + 1) : 0;
        this.lastEscapeAt = now;
        this.blocked.push({ angle: this.heading, until: now + 4000 });
        // Each bot keeps one preferred slide side: alternating on every jam
        // produces a left-right shuffle.
        this.side ??= ran.chance(0.5) ? 1 : -1;
        const away = this.heading + (this.escalation >= 2
            ? Math.PI
            : (this.escalation === 1 ? -this.side : this.side) * 1.9);
        this.heading = this.bestEscape(away, this.radius(), now);
        this.escapeUntil = now + 750 + Math.random() * 450;
        this.samples.length = 0;
    }

    // The only entry point. Returns a movement goal (with a throttle in
    // `power`), or null once arrived.
    steer(destination, arriveAt, now, contact = false) {
        const body = this.body;
        const radius = this.radius();
        const dx = destination.x - body.x, dy = destination.y - body.y;
        const distance = Math.hypot(dx, dy);
        if (now < this.escapeUntil) {
            this.track(now, true);
            const reach = radius * 8;
            return { x: body.x + Math.cos(this.heading) * reach, y: body.y + Math.sin(this.heading) * reach, power: 1 };
        }
        const lead = distance > 0 && !contact ? drive.coastLead(body, dx / distance, dy / distance, global.gameManager.roomSpeed) : 0;
        if (distance <= arriveAt + lead) {
            this.arrived = true;
            this.track(now, false);
            return null;
        }
        // Arrival is sticky; drifting waypoints (orbits around a rock or a
        // fight) are followed at low throttle rather than stop-then-lurch.
        if (this.arrived) {
            if (distance < arriveAt * 2 + 25) {
                this.track(now, false);
                return { x: destination.x, y: destination.y, power: 0.3 };
            }
            this.arrived = false;
        }
        // Grinding a rock is progress even though the hull is not moving, so
        // contact goals suppress the stuck check while the hull is in contact.
        this.track(now, !(contact && body.grindTouchUntil > now));
        const probeBucket = (now / 16) | 0;
        if (probeBucket !== BotNav._probeBucket) { BotNav._probeBucket = probeBucket; BotNav._probesThisTick = 0; }
        if (now >= this.nextProbeAt && BotNav._probesThisTick < 3) {
            BotNav._probesThisTick++;
            this.nextProbeAt = now + 110 + Math.random() * 50;
            this.repoint(Math.atan2(dy, dx), radius, util.clamp(distance, 120, 260), now);
        }
        const reach = Math.max(90, Math.min(distance, 240));
        // Ease off near the goal to avoid overshooting. Contact goals (ramming,
        // grinding a rock) want full speed into impact.
        const power = !contact && distance < arriveAt * 2 + 60 ? 0.55 : 1;
        return { x: body.x + Math.cos(this.heading) * reach, y: body.y + Math.sin(this.heading) * reach, power };
    }
}

// Higher wins; a candidate only interrupts the running job when it scores
// above it. Objective sits above collect so sieges are not abandoned for
// every nearby gem. candidate() only returns fight when justified (attacked,
// or etiquette satisfied), so its high value is mostly self-defense.
const GOAL_PRIORITY = {
    survive: 100, regroup: 90, bank: 75, fight: 70, objective: 65, rally: 63,
    collect: 60, defend: 58, aoshoot: 52, aogo: 50, chest: 45, mine: 30, explore: 10,
};
// Duos, a human's bot teammate: past TEAM_LEASH_FAR from its human it drops
// whatever it is doing and regroups; past TEAM_LEASH it does when nothing is
// on it. Fights it picks itself stay within TEAM_FIGHT_R of the human.
const TEAM_LEASH = 900, TEAM_LEASH_FAR = 1300, TEAM_FIGHT_R = 1000;
// bots that may take on a raid boss at once
const BOSS_HUNTERS = 3;
// a bot starts a fight with another bot only when the trade looks at least
// this good (threatRatio; players follow botDifficulty.initThreat)
const BOT_FIGHT_THREAT = 0.9;
const GOAL_HOLD = {
    survive: 2200, regroup: 3000, bank: 7000, fight: 2800, collect: 2600,
    defend: 4500, objective: 9000, rally: 6000, chest: 7000, mine: 5000, explore: 9000, aoshoot: 6000, aogo: 6000,
};

// A bot's hands on a keyboard. Players drive with WASD: eight directions,
// full speed or none, direction changes in whole key presses. Every bot
// movement goes through this so bots move the same way; the brain decides
// where to go, this turns it into key presses.
const OCT_VEC = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
class BotKeys {
    constructor(body) {
        this.body = body;
        this.oct = -1;          // held direction, -1 = no keys down
        this.changedAt = 0;
        this.holdMs = 0;
        this.settling = false;
        this.pressing = false;
    }
    skill() { return util.clamp(this.body.botSkill ?? 0.5, 0, 1); }
    // out.goal is a world point, out.power a throttle; returns the same
    // shape a player's keys produce (goal = body + key vector, no power).
    apply(out, now, urgent = false) {
        const body = this.body;
        if (!out || !out.goal) return out;
        const dx = out.goal.x - body.x, dy = out.goal.y - body.y;
        const dist = Math.hypot(dx, dy);
        const p = out.power ?? 1;
        // Settling onto a drifting point (a mining spot, an orbit slot):
        // stand still, and only tap back when it has drifted a real distance.
        let want = true;
        if (p <= 0.35) {
            if (!this.settling) { this.settling = true; this.pressing = false; }
            if (!this.pressing && dist > 60) this.pressing = true;
            else if (this.pressing && dist < 22 + (dist > 0 ? drive.coastLead(body, dx / dist, dy / dist, global.gameManager.roomSpeed) : 0)) this.pressing = false;
            want = this.pressing;
        } else {
            this.settling = false;
            want = p > 0.05 && dist > 6;
        }
        const skill = this.skill();
        if (!want) {
            // letting go of the keys takes a moment too
            if (this.oct !== -1 && now - this.changedAt >= 40 + (1 - skill) * 60) { this.oct = -1; this.changedAt = now; }
        } else {
            const theta = Math.atan2(dy, dx);
            const c = ((Math.round(theta / (Math.PI / 4)) % 8) + 8) % 8;
            if (this.oct === -1) {
                this.oct = c; this.changedAt = now;
                this.holdMs = 60 + Math.random() * (70 + (1 - skill) * 90);
            } else if (c !== this.oct) {
                const off = Math.abs(wrapAngle(theta - this.oct * Math.PI / 4));
                // stay on the held keys until the wanted heading is clearly
                // closer to another direction, and never faster than a finger
                if (off > Math.PI / 8 + 0.14 && (urgent || now - this.changedAt >= this.holdMs)) {
                    this.oct = c; this.changedAt = now;
                    this.holdMs = 60 + Math.random() * (70 + (1 - skill) * 90);
                }
            }
        }
        const v = this.oct === -1 ? [0, 0] : OCT_VEC[this.oct];
        out.goal = { x: body.x + v[0], y: body.y + v[1] };
        delete out.power;
        return out;
    }
}

class io_digWarsGoals extends IO {
    constructor(body) {
        super(body);
        this.nav = new BotNav(body);
        this.keys = new BotKeys(body);
        this.goal = null;
        this.goalStartedAt = 0;
        this.holdUntil = 0;
        this.senseAt = 0;
        this.view = { enemy: null, enemyDistance: Infinity, enemies: 0, allies: 0, gem: null, defense: null, objective: null, rock: null };
        // Bank on a realistic haul, not a full satchel (4000 gems vs 15 per
        // copper deposit would mean never banking).
        this.bankAt = 60 + Math.random() * 200;
        this.bornAt = Date.now();
        // Miners feed the vault, raiders hit outposts and cores, guards stay
        // near home. The mix keeps gems flowing into the map.
        this.role = ran.chance(0.45) ? 'miner' : ran.chance(0.62) ? 'raider' : 'guard';
        body._botRole = this.role;
        this.objectiveReach = this.role === 'raider' ? 4800 : this.role === 'guard' ? 2000 : 2800;
        this.orbit = null;
        this.minePlan = null;
        this.aimError = 0;
        this.aimErrorAt = 0;
        this.rockBlacklist = new Map();
        this.objectiveBlacklist = new Map();
        // Players this bot recently gave up chasing (no hounding one person).
        this.playerBreakUntil = new Map();
        this.rockAt = 0;
        this.losCache = new Map();
        this.rangeAt = 0;
        this.range = 0;
        this.threatCache = new Map();
        // Enemies who beat this bot in a recent trade, or whose build is
        // simply out of its league. Fights with them are refused.
        this.fearUntil = new Map();
    }

    // ── personality ──────────────────────────────────────────────────────
    skill() {
        return util.clamp(this.body.botSkill ?? 0.5, 0, 1);
    }

    retreatAt() {
        const temperament = this.body.botTemperament || 'balanced';
        let at = temperament === 'aggressive' ? 0.32 : temperament === 'passive' ? 0.55 : 0.42;
        // Against a visibly stronger tank, retreat much earlier (up to 75%).
        const threat = this.view?.enemy;
        if (threat && this.view.enemyDistance < 1000) {
            const ratio = this.threatRatio(threat);
            if (ratio > 1.2) at = Math.max(at, Math.min(0.75, 0.4 + (ratio - 1.2) * 0.3));
        }
        return at;
    }

    // Guess at how a straight trade with this enemy goes: build size (bullet
    // stats plus some body damage) times remaining health. Above 1 means they
    // probably win. Cached for 1s.
    threatRatio(enemy) {
        if (!enemy) return 0;
        const now = Date.now();
        const cached = this.threatCache.get(enemy.id);
        if (cached && now < cached.until) return cached.ratio;
        const offense = e => {
            const raw = e.skill?.raw;
            if (!raw) return 18;
            return Math.max(6, raw[0] + raw[1] + raw[2] + raw[3] + raw[6] * 0.8);
        };
        const pool = e => Math.max(1, (e.health?.amount || 1) + (e.shield?.amount || 0));
        const ratio = (offense(enemy) * pool(enemy)) / (offense(this.body) * pool(this.body));
        if (this.threatCache.size > 16) this.threatCache.clear();
        this.threatCache.set(enemy.id, { ratio, until: now + 1000 });
        return ratio;
    }

    // An enemy this bot should not trade with: the numbers say so, or a
    // recent fight against them proved it.
    feared(enemy, now) {
        if (!enemy) return false;
        // a small fish next to a protected player stands and trades (fairPlay)
        if (this.body.botMinnow && fairPlay.minnowDuel(this.body, enemy, now)) return false;
        if ((this.fearUntil.get(enemy.id) || 0) > now) return true;
        return this.threatRatio(enemy) > 1.45;
    }

    isRammer() {
        return this.body.botIsRammer ?? (!this.body.guns || this.body.guns.size === 0);
    }

    // ── perception helpers ───────────────────────────────────────────────
    rootOf(entity) {
        let root = entity, hops = 0;
        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
        return root || entity;
    }

    isEnemy(root) {
        // padSafe: someone shopping or banking is untouchable
        return root && root !== this.body && root.team !== this.body.team &&
            root.team !== TEAM_ROOM && !root.godmode && !root.passive && !root.invuln && !root.padSafe &&
            !root.ignoredByAi && !(root.isDead && root.isDead());
    }

    distanceTo(point) {
        return Math.hypot(point.x - this.body.x, point.y - this.body.y);
    }

    // Duos: the living bot this one is paired with (same team), or null.
    duoMate() {
        const m = this.body.duoMate;
        return m && !m.isDead?.() && m.team === this.body.team ? m : null;
    }

    // The human a bot teammate looks after (null for every other bot).
    teamHuman() {
        if (!this.body.isTeamBot || !Config.royale_duos) return null;
        const m = this.duoMate();
        return m && m.isPlayer ? m : null;
    }

    ownVault() {
        if (Config.dig_royale) {
            const mine = digWarsOutposts.getOutposts().find(site => site.ownerId === this.body.id || digWarsOutposts.isOwner(site, this.body));
            if (mine) return mine;
            const vaults = digWarsVault.getVaults();
            // fairPlay: not the one we were just kicked off, nor one a protected player is
            const now = Date.now(), body = this.body;
            const players = fairPlay.on('vault') ? botWorldScan().tanks.filter(e => e.isPlayer && e._fpProtect) : null;
            let best = null, bestD = Infinity;
            for (const vault of vaults) {
                let d = this.distanceTo(vault);
                if (players) {
                    if (body._padReentryPad === vault && (body._padReentryUntil || 0) > now) d += 2500;
                    if (body._fpMoveOn && fairPlay.avoidVault(body, vault, now)) d += 2500;
                    if (players.length && !fairPlay.vaultFreeFor(body, vault, players, now)) d += 4000;
                }
                if (d < bestD) { bestD = d; best = vault; }
            }
            return best;
        }
        return digWarsVault.getVaults().find(vault => vault.team === this.body.team) || null;
    }

    // A bot teammate banks only where its human is (the team base or a vault
    // close to them), not on a trip across the map.
    bankNearHuman(human) {
        const v = this.ownVault();
        return !!v && Math.hypot(v.x - human.x, v.y - human.y) < TEAM_LEASH_FAR;
    }

    weaponRange() {
        const now = Date.now();
        if (now - this.rangeAt < 4000 && this.range) return this.range;
        this.rangeAt = now;
        const fov = this.body.fov || 1200;
        let range = 0;
        for (const gun of this.body.guns?.values?.() || []) {
            if (!gun.canShoot || !gun.getTracking) continue;
            const tracking = gun.getTracking();
            if (!tracking || !tracking.speed) continue;
            const reach = tracking.speed * (tracking.range < this.body.size * 2 ? fov : tracking.range);
            range = Math.max(range, Math.min(reach, fov));
        }
        return this.range = range || fov * 0.7;
    }

    desiredRange() {
        if (this.isRammer()) return 0;
        const defs = (this.body.defs || []).join(' ').toLowerCase();
        let want = 170;
        if (/sniper|assassin|ranger|marksman|stalker|rifle|predator|hunter|deadeye/.test(defs)) want = 330;
        else if (/destroyer|artillery|mortar|launcher|ordnance|annihilator|hybrid/.test(defs)) want = 250;
        // Floor at 140 so short-range builds (trappers) do not end up hull-to-hull.
        return Math.max(140, Math.min(want, this.weaponRange() * 0.8));
    }

    engageRange() {
        const fov = this.body.fov || 1200;
        if (this.isRammer()) return fov * 0.85;
        return Math.max(520, Math.min(fov * 1.1, this.weaponRange() * 1.4));
    }

    // Line of sight: is rock or a structure in the way? Cached briefly.
    clearShot(entity) {
        if (Config.dig_royale) return true;
        if (this.isRammer()) return true;
        const body = this.body;
        const distance = Math.hypot(entity.x - body.x, entity.y - body.y);
        if (distance < 90) return true;
        const now = Date.now();
        const key = entity.id ?? `${Math.round(entity.x)}:${Math.round(entity.y)}`;
        const cached = this.losCache.get(key);
        if (cached && now < cached.until) return cached.ok;
        const tg = global.gameManager && global.gameManager.terrainGrid;
        const steps = Math.min(10, Math.max(3, Math.round(distance / 110)));
        let ok = true;
        for (let i = 1; i < steps && ok; i++) {
            const t = i / steps;
            const x = body.x + (entity.x - body.x) * t, y = body.y + (entity.y - body.y) * t;
            if (tg?.pointInRock && tg.pointInRock(x, y) && !Config.dig_royale) ok = false;
            else if (this.nav.structureBlocks(x, y, 6)) ok = false;
        }
        if (this.losCache.size > 24) this.losCache.clear();
        this.losCache.set(key, { ok, until: now + 300 });
        return ok;
    }

    // All hull aim funnels through here so the cursor behaves like a wrist:
    // it turns toward the target instead of snapping, with a slowly
    // re-rolled error.
    // `diff` is the target's bot difficulty (rocks and idle glances: neutral).
    // `gentle`: botDiff.gentle of the target (a human: a softer spring and more error)
    aimVector(x, y, now, skill = this.skill(), diff = botDiff.NEUTRAL, gentle = 0) {
        const desired = Math.atan2(y, x);
        if (this.aimAngle == null) { this.aimAngle = desired; this.aimVel = 0; }
        const turn = wrapAngle(desired - this.aimAngle);
        // Damped spring: slight overshoot before settling, more at low skill.
        const stiff = botDiff.aimStiff(skill, diff) * botDiff.gentleStiff(gentle), damp = botDiff.aimDamp(skill, diff);
        this.aimVel = (this.aimVel || 0) * damp + turn * stiff;
        this.aimAngle = wrapAngle(this.aimAngle + this.aimVel);
        if (now - this.aimErrorAt > 110) {
            this.aimErrorAt = now;
            this.aimError = ran.gauss(0, botDiff.aimError(skill, diff) * botDiff.gentleAimErr(gentle)) * (this._aimErrMult || 1);
        }
        const tremor = Math.sin(now / 47 + (this.body.id % 9)) * 0.006 * (1.2 - skill);
        const a = this.aimAngle + this.aimError + tremor;
        const length = Math.hypot(x, y) || 1;
        return { x: length * Math.cos(a), y: length * Math.sin(a) };
    }

    // Feathered trigger: bursts with brief releases. Combat only; holding
    // fire on a rock is normal.
    triggerHeld(now, target) {
        if (!this.burstUntil || now > this.burstUntil) {
            const d = botDiff.of(target ? this.rootOf(target) : null, now);
            this.pauseUntil = now + botDiff.pauseMs(this.skill(), d, Math.random());
            this.burstUntil = this.pauseUntil + botDiff.burstMs(d, Math.random());
            // a first-kill bait at its host: short bursts, long gaps (fairPlay)
            if (this.body._fpBait && target && fairPlay.isBaitPair(this.body, this.rootOf(target), now)) {
                const [lo, hi] = fairPlay.TUNE.FIRST_PAUSE_MS;
                this.pauseUntil = now + lo + Math.random() * (hi - lo);
                this.burstUntil = this.pauseUntil + botDiff.burstMs(d, Math.random()) * fairPlay.TUNE.FIRST_BURST;
            }
        }
        return now >= this.pauseUntil;
    }

    leadAim(entity, now) {
        const dx = entity.x - this.body.x, dy = entity.y - this.body.y;
        const distance = Math.hypot(dx, dy);
        let speed = 0, muzzleSpeed = 0;
        for (const gun of this.body.guns?.values?.() || []) {
            if (!gun.canShoot || !gun.getTracking) continue;
            const tracking = gun.getTracking();
            if (tracking && tracking.speed > speed) {
                speed = tracking.speed;
                const sk = gun.bulletStats === 'master' ? this.body.skill : gun.bulletStats;
                muzzleSpeed = (gun.settings?.speed || 0) * (sk?.spd || 1) * (global.gameManager?.runSpeed || 1);
            }
        }
        // A player under mercy or in the soft window gets sloppier lead and
        // wider spray; how sloppy follows their bot difficulty.
        const diff = botDiff.of(this.rootOf(entity), now);
        const gentle = botDiff.gentle(this.rootOf(entity));
        let skill = this.skill();
        if (entity.isPlayer && (entity.socket?.botMercyUntil || 0) > now) skill *= 0.45;
        else if (botSoft(entity, now)) skill *= botDiff.softAim(diff);
        // a bot running away with the raid, at a protected player (fairPlay)
        if (this.body._fpRunaway && entity._fpProtect) skill *= fairPlay.aimMult(this.body, entity, now);
        // a first-kill bait at its host: a beginner's aim (fairPlay)
        const bait = !!this.body._fpBait && fairPlay.isBaitPair(this.body, entity, now);
        if (bait) skill *= fairPlay.TUNE.FIRST_AIM_SKILL;
        this._aimErrMult = bait ? fairPlay.TUNE.FIRST_AIM_ERR : 1;
        // Lead time is capped at 1.2s; a lower cap undershoots moving targets
        // past medium range.
        const lead = speed > 0 ? util.clamp(distance / speed, 0, 1.2) * botDiff.leadShare(skill, diff) * botDiff.gentleLead(gentle) : 0.2;
        let ax = dx + (entity.velocity?.x || 0) * lead, ay = dy + (entity.velocity?.y || 0) * lead;
        // Lock-on: aim where the shot actually meets them (their tracked
        // motion, the bullet's speed, the barrel tip), blended in with the
        // difficulty. Mercy and the soft window never get it.
        const lock = skill === this.skill() ? botDiff.lockShare(diff) * botDiff.gentleLock(gentle) : 0;
        if (lock > 0) {
            const p = tactics.leadPoint(this, this.body, entity, speed, muzzleSpeed, now, this._leadOut || (this._leadOut = { x: 0, y: 0 }));
            if (p) { ax += (p.x - ax) * lock; ay += (p.y - ay) * lock; }
        }
        return this.aimVector(ax, ay, now, skill, diff, gentle);
    }

    // Shooting into smoke: at a guess of where they are (refreshed every
    // half second or so, off by ~120), sprayed wide, with a slow wrist.
    blindAim(e, now) {
        const body = this.body;
        let g = this.blind;
        if (!g || g.id !== e.id) g = this.blind = { id: e.id, x: e.x, y: e.y, at: 0, spreadAt: 0, ox: 0, oy: 0 };
        if (now >= g.at) {
            g.at = now + 450 + Math.random() * 500;
            g.x += (e.x + ran.gauss(0, 120) - g.x) * 0.6;
            g.y += (e.y + ran.gauss(0, 120) - g.y) * 0.6;
        }
        if (now >= g.spreadAt) {
            g.spreadAt = now + 200 + Math.random() * 150;
            const d = Math.hypot(g.x - body.x, g.y - body.y);
            g.ox = ran.gauss(0, 50 + d * 0.15); g.oy = ran.gauss(0, 50 + d * 0.15);
        }
        return this.aimVector(g.x + g.ox - body.x, g.y + g.oy - body.y, now, 0.15, 0);
    }

    // ── sensing ──────────────────────────────────────────────────────────
    sense(now) {
        if (now < this.senseAt) return;
        // locked on to a strong player in a fight: eyes open wider
        const sharp = this.goal && this.goal.kind === 'fight' && this.view.enemy &&
            botDiff.lockShare(botDiff.of(this.view.enemy, now)) > 0.5;
        this.senseAt = now + (sharp ? 100 + (1 - this.skill()) * 50 : 150 + (1 - this.skill()) * 120);
        const body = this.body, view = this.view;
        // a grown bot's camera opens up (terrain/growth.js); its senses don't
        const fov = Math.min(body.fov || 1200, 2000);
        const seeInvisible = !!body.aiSettings?.seeInvisible;
        let best = null, bestScore = Infinity, enemies = 0, allies = 0;
        let allyInTrouble = null, allyTroubleDistance = Infinity;
        // bot vs bot spell (botDifficulty.prefersBot): humans score PREFER_R
        // farther, except the one we're already on (no mid-fight swaps)
        const preferBot = !!body.isBot && botDiff.prefersBot(this, now);

        for (const entity of botWorldScan().tanks) {
            const root = this.rootOf(entity);
            if (!root.health || root.health.amount <= 0) continue;
            const distance = Math.hypot(root.x - body.x, root.y - body.y);
            if (root === body) continue;
            if (root.team === body.team) {
                if (distance < 1100 && (root.isBot || root.isPlayer)) allies++;
                // Teammate taking fire nearby: bots stamp _lastDamageAt; for
                // humans, missing health is the best signal available.
                const inTrouble = root.isBot
                    ? now - (root._lastDamageAt || 0) < 2500
                    : root.isPlayer && root.health.max && root.health.amount < root.health.max * 0.75;
                if (inTrouble && distance > 300 && distance < 1600 && distance < allyTroubleDistance) {
                    allyTroubleDistance = distance;
                    allyInTrouble = root;
                }
                continue;
            }
            // nobody past the widest sense range (hunted mark, radar) counts:
            // skip the rest of the checks for them
            const lh = root.id === (global.royaleLeaderHunt && global.royaleLeaderHunt.id) ? leaderHunt(root, now) : null;
            if (distance > SENSE_MAX_R && distance > fov * 1.85 && !(lh && distance < LEADER_R)) continue;
            if (!this.isEnemy(root)) continue;
            // smoke: a bot already on them keeps at it (blindAim); a new one
            // only spots them point blank. Other invisibility hides fully.
            if (root.alpha != null && root.alpha <= 0.5 && !seeInvisible &&
                !(tactics.smoked(root) && (root === this._lastEnemy || distance < tactics.SMOKE_SPOT_R))) continue;
            // the raid's hunted mark shows a carrier from further off
            const marked = root.isPlayer && tactics.huntOn() ? Math.min(2, root.huntedLevel | 0) : 0;
            // a radar ping (its own ability) shows everyone out to 2500
            const radar = (body.radarUntil || 0) > now ? 2500 : 0;
            if (distance > Math.max(radar, fov * (1.25 + marked * 0.3), lh ? LEADER_R : 0)) continue;
            // fresh spawn in bot grace: not a target, not even counted
            if (inBotGrace(root, now)) continue;
            if (root.adminSpec) continue;
            // the Core is up: bots leave players to it (one who shoots us
            // still gets fought, through the attacker override below)
            // (a crowned player is fair game: the Crown Contest)
            if (root.isPlayer && global.royaleCoreTruce && !root.crowned) continue;
            // soft window (first minutes of a life, or a new player): only
            // if they come right up to us or shoot us
            if (!lh && softSpared(body, root, now)) continue;
            // raid opening (round 11): most bots leave humans be for now
            if (openSpared(body, root, now)) continue;
            // first raid: no X-Hunter / Penta / Octo class bot on them yet
            if (root.nxScaryUntil && newcomer.scarySpared(body, root, now)) continue;
            // fairPlay: a protected player on the way in to bank, and grown bots never pick a
            if (fairPlay.guarded(root) && fairPlay.spared(body, root, now)) continue;
            // and nobody we've killed again and again lately)
            if (root.isPlayer && fairPlay.farmed(body, root, now)) continue;
            // a first-kill bait on duty: nobody else's, and it minds its host
            if (root.isBot && ((root._fpBait && fairPlay.baitOnDuty(root, now)) || (body._fpBait && fairPlay.baitOnDuty(body, now)))) continue;
            // enough bots on this player already: leave them to it
            // (self-defence still wins below through the attacker override)
            if (root.isPlayer && botsOn(root, body) >= hunterCap(root, now)) continue;
            // Counted a bit past visual range so a second attacker hanging
            // back still registers as being outnumbered.
            if (distance < 1100) enemies++;
            // A player ranks as if farther off the lower their difficulty
            // (the hardest rank like a bot), a soft one farther still. A heavy
            // satchel draws a little, and a lot once bots lock on to that
            // player (botTactics.carrierPull); so does someone already
            // losing a fight with somebody else.
            const rd = root.isPlayer ? botDiff.of(root, now) : botDiff.NEUTRAL;
            const soft = !lh && botSoft(root, now);
            const lock = root.isPlayer && !soft ? botDiff.lockShare(rd) : 0;
            const base = distance
                + (root.isPlayer ? botDiff.targetPenalty(rd) + botDiff.gentlePenalty(botDiff.gentle(root, now)) : 0)
                // bot vs bot: half the time a bot nearby wins over a human at a similar range
                + (root.isPlayer && preferBot && root !== this._lastEnemy ? botDiff.PREFER_R : 0)
                + (soft ? firstMinutes().NEW_TARGET_PENALTY : 0)
                + (root.isPlayer && raidOpening(now) ? OPEN_TARGET_PENALTY : 0)
                - tactics.carrierPull(root, lock)
                - (lock > 0 && tactics.isEnabled() ? tactics.thirdParty(root, now) * 320 * lock : 0)
                // a bot running away with the raid draws the others (fairPlay)
                - (root._fpRunaway ? fairPlay.gangPull(body, root) : 0)
                // round 12: the runaway leader draws everyone near (no size rule)
                - leaderPull(lh)
                // round 9: mostly tanks near our own size
                + (lh ? 0 : sizePenalty(body, root));
            // the line of sight (a terrain raycast) can only add to the
            // score, so it's only worth casting for someone who could win
            if (base >= bestScore) continue;
            const score = base + (this.clearShot(root) ? 0 : 220);
            if (score < bestScore) { bestScore = score; best = root; }
        }

        // Whoever is actually shooting us outranks the scoring above.
        const attacker = body._lastDamageSource && now - (body._lastDamageAt || 0) < 3000
            ? body._lastDamageSource : null;
        // A bot duo covers its partner: the partner's attacker comes next,
        // after our own attacker. (A human partner's attacker is kept in
        // _duoHitBy by duoRaid.watchHits.)
        const mate = Config.royale_duos ? this.duoMate() : null;
        const mSrc = mate ? (mate.isPlayer ? mate._duoHitBy : mate._lastDamageSource) : null;
        const mAt = mate ? (mate.isPlayer ? mate._duoHitAt : mate._lastDamageAt) || 0 : 0;
        const mateAttacker = mSrc && now - mAt < 3000 &&
            this.isEnemy(mSrc) && mSrc.health?.amount > 0 &&
            Math.hypot(mSrc.x - body.x, mSrc.y - body.y) < fov * 1.4
            ? mSrc : null;
        if (mateAttacker && !inBotGrace(mateAttacker, now)) best = mateAttacker;
        if (attacker && this.isEnemy(attacker) && attacker.health?.amount > 0 &&
            Math.hypot(attacker.x - body.x, attacker.y - body.y) < fov * 1.25 &&
            // a protected player under the 25% rule stays ignored until provoked)
            !(fairPlay.on('hit25') && (softSpared(body, attacker, now) || (fairPlay.guarded(attacker) && fairPlay.spared(body, attacker, now))))) best = attacker;
        // a first-kill bait keeps its eyes on its host (fairPlay)
        if (body._fpBait) {
            const host = fairPlay.baitHost(body, now);
            if (host && !inBotGrace(host, now) && Math.hypot(host.x - body.x, host.y - body.y) < fov * 1.4) best = host;
        }
        view.mateAttacker = mateAttacker;

        if (best !== this._lastEnemy) {
            // a new face takes a moment to register before the bot commits
            this._lastEnemy = best;
            this._enemySeenAt = now;
            this.reactionMs = botDiff.reactionMs(this.skill(), botDiff.of(best, now), Math.random()) * botDiff.gentleReact(botDiff.gentle(best, now));
            if (best && best.isPlayer && raidOpening(now)) this.reactionMs *= OPEN_REACT;
        }
        view.enemy = best;
        body._botEnemyId = best ? best.id : 0;   // read by botsOn() (new-player hunter cap)
        view.enemyDistance = best ? Math.hypot(best.x - body.x, best.y - body.y) : Infinity;
        view.enemies = enemies;
        view.allies = allies;
        view.allyInTrouble = allyInTrouble;
        view.gem = this.findGem(now);
        view.defense = this.findDefense();
        // rammers siege too: body damage against a banner or ring counts
        view.objective = this.findObjective();
        view.rock = this.findRock(now);
    }

    // A gem inside a standing or regrowing chamber ring is unreachable (or
    // a pocket that is about to close).
    gemSealedInChamber(gem) {
        return !!this.chamberEnclosing(gem.x, gem.y, gem.realSize || 8);
    }

    findGem(now) {
        const body = this.body;
        const human = this.teamHuman();
        if ((body.carriedGems || 0) >= (body.gemCap || 4000) * 0.98) return null;
        let best = null, bestScore = Infinity;
        const scan = botWorldScan();
        for (const gem of (scan.gemsFree || scan.gems)) {
            // chamber loot repels its owning team
            if (gem.chamberBias && gem.chamberBias === body.team) continue;
            // owner-only pickups
            if (gem.gemOwnerId !== undefined && gem.gemOwnerId !== body.id) continue;
            // A dead player's scattered gems are left for them to reclaim for
            // 15s; the bot that made the kill may collect immediately.
            const isKillerBot = body.isBot && gem.gemLootKillerIds?.includes(body.id);
            if (gem.gemLootFromPlayer && !isKillerBot &&
                now - (gem.gemBornAt || 0) < 15000) continue;
            const distance = this.distanceTo(gem);
            if (distance > 700) continue;
            // a bot teammate leaves its human's loot alone: their kill's drop,
            // and anything lying nearer to them than to us
            if (human && (gem.gemLootKillerIds?.includes(human.id) ||
                Math.hypot(gem.x - human.x, gem.y - human.y) < Math.min(450, distance))) continue;
            const killerPriority = isKillerBot && now < (body._collectLootUntil || 0) ? 1000 : 0;
            const score = distance - killerPriority
                - (gem.gemSourceId === body.id ? 350 : 0)
                - Math.min(250, gem.gemValue * 0.4);
            if (score >= bestScore) continue;
            // the chamber geometry test is the expensive part: only run it
            // for a gem that would actually win
            if (this.gemSealedInChamber(gem)) continue;
            bestScore = score; best = gem;
        }
        return best;
    }

    findEnemyNear(point, range) {
        let best = null, bestDistance = Infinity;
        for (const entity of botWorldScan().tanks) {
            const root = this.rootOf(entity);
            if (!this.isEnemy(root) || !root.health || root.health.amount <= 0) continue;
            const fromPoint = Math.hypot(root.x - point.x, root.y - point.y);
            if (fromPoint > range) continue;
            const fromBot = this.distanceTo(root);
            if (fromBot < bestDistance) { bestDistance = fromBot; best = root; }
        }
        return best;
    }

    findDefense() {
        const states = new Map(digWarsOutposts.stateSnapshot().map(state => [state.id, state]));
        let best = null, bestScore = Infinity;
        for (const site of digWarsOutposts.getOutposts()) {
            if (site.team !== this.body.team || !site.banner || site.banner.isDead()) continue;
            const distance = this.distanceTo(site);
            if (distance > 2000) continue;
            const state = states.get(site.id);
            const health = state ? state.h : 1;
            const threat = this.findEnemyNear(site, 850);
            if (!threat && health > 0.75) continue;
            const score = distance + health * 200 - (threat ? 400 : 0);
            if (score < bestScore) { bestScore = score; best = { point: site, target: threat }; }
        }
        return best;
    }

    findObjective() {
        const body = this.body;
        const options = [];
        const nowMs = Date.now();
        if (this.objectiveBlacklist.size > 8) {
            for (const [key, until] of this.objectiveBlacklist) if (until < nowMs) this.objectiveBlacklist.delete(key);
        }
        const outpostStates = new Map(digWarsOutposts.stateSnapshot().map(state => [state.id, state]));
        for (const site of digWarsOutposts.getOutposts()) {
            // (duos: the partner's base counts as ours, its banner can't be hurt anyway)
            const owned = Config.dig_royale ? (site.ownerId === body.id || digWarsOutposts.isOwner(site, body)) : site.team === body.team;
            if (owned || !site.banner || site.banner.isDead()) continue;
            if ((this.objectiveBlacklist.get(site) || 0) > nowMs) continue;
            const state = outpostStates.get(site.id);
            let score = this.distanceTo(site) + (state ? state.h : 1) * 260 - (site.team === 0 || !site.ownerId ? 300 : 0);
            if (Config.dig_royale) {
                const storm = require('../game/terrain/storm.js');
                if (storm.inStorm(site.x, site.y)) continue;
                const r = storm.radius();
                const d = Math.hypot(site.x, site.y);
                if (r > 80 && d > r - 450) score -= 220;
            }
            options.push({
                kind: 'outpost', point: site,
                score,
            });
        }
        const chamberStates = new Map(digWarsChambers.stateSnapshot().map(state => [state.id, state]));
        if (!Config.dig_royale) {
        for (const chamber of digWarsChambers.getChambers()) {
            const state = chamberStates.get(chamber.id);
            if (!state || state.st !== 0) continue;
            if (chamber.team == null || chamber.team === TEAM_ROOM || chamber.team === body.team) continue;
            if (!chamber.entity || chamber.entity.isDead?.()) continue;
            if ((this.objectiveBlacklist.get(chamber) || 0) > nowMs) continue;
            // chambers are valid targets at any health
            options.push({
                kind: 'chamber', point: chamber,
                score: this.distanceTo(chamber) * 0.7 + state.h * 380,
            });
        }
        }
        const push = body._botPushTarget && (body._botPushTargetUntil || 0) > Date.now()
            ? body._botPushTarget : null;
        if (push) {
            const match = options.find(option => option.point === push);
            if (match) match.score -= 900;
        }
        // How far a bot travels for a structure depends on its role.
        const reach = this.objectiveReach;
        return options
            .filter(option => this.distanceTo(option.point) <= reach)
            .sort((a, b) => a.score - b.score)[0] || null;
    }

    findRock(now) {
        const current = this.view.rock;
        if (current && current.alive && now < this.rockAt && this.distanceTo({ x: current.wx, y: current.wy }) < 1100)
            return current;
        this.rockAt = now + 1200;
        const tg = global.gameManager && global.gameManager.terrainGrid;
        if (!tg || !tg.nearestRockWhere) return null;
        if (this.rockBlacklist.size > 12) {
            for (const [rock, until] of this.rockBlacklist) if (until < now) this.rockBlacklist.delete(rock);
        }
        // Courtesy: a rock with a human next to it is that human's rock.
        const humans = (global.gameManager.socketManager?.players || [])
            .map(player => player && player.body)
            .filter(b => b && b.isPlayer && !b.isDead?.() && !b.isGhost);
        const unclaimed = rock => !humans.some(h =>
            (h.x - rock.wx) * (h.x - rock.wx) + (h.y - rock.wy) * (h.y - rock.wy) < 260 * 260);
        // rocks on a base apron are never mined
        const usable = rock => rock.alive && (this.rockBlacklist.get(rock) || 0) < now &&
            unclaimed(rock) && baseTileOwner(rock.wx, rock.wy) === undefined;
        // Bloomed ore first, then ore within walking range, then plain rock
        // only when it is close.
        return tg.nearestRockWhere(this.body.x, this.body.y, 900, rock => rock.bloomed && rock.ore && usable(rock)) ||
               tg.nearestRockWhere(this.body.x, this.body.y, 1100, rock => rock.ore && usable(rock)) ||
               tg.nearestRockWhere(this.body.x, this.body.y, 450, usable);
    }

    // The chamber (if any) whose standing or regrowing ring encloses a point.
    chamberEnclosing(x, y, margin = 0) {
        for (const chamber of digWarsChambers.getChambers()) {
            const entity = chamber.entity;
            if (!entity || entity.isDead?.() || chamber.state === 'destroyed') continue;
            const inner = chamber.r * (entity.sizeMultiplier ?? 1) + margin;
            const dx = x - chamber.x, dy = y - chamber.y;
            if (dx * dx + dy * dy < inner * inner) return chamber;
        }
        return null;
    }

    // Nudge a destination onto safe ground: not a base tile (enemy tiles
    // kill; aprons are just loitering) and not inside a chamber ring pocket
    // (it can regrow around the bot).
    safePoint(x, y) {
        const team = this.body.team;
        for (let i = 0; i < 8; i++) {
            const ring = this.chamberEnclosing(x, y, 60);
            if (ring) {
                const dx = x - ring.x, dy = y - ring.y;
                const away = Math.hypot(dx, dy) || 1;
                const want = ring.r * (ring.entity?.sizeMultiplier ?? 1) + 180;
                x = ring.x + (dx / away) * want;
                y = ring.y + (dy / away) * want;
                continue;
            }
            if (inEnemyBase(team, x, y) || baseTileOwner(x, y) !== undefined) {
                const toCenter = Math.hypot(x, y) || 1;
                x -= (x / toCenter) * 300;
                y -= (y / toCenter) * 300;
                continue;
            }
            break;
        }
        return { x, y };
    }

    royaleRoamPoint(now) {
        const body = this.body;
        let st = null;
        try { st = require('../game/terrain/storm.js').snapshot(); } catch { return null; }
        if (!st || !st.a || !(st.r > 0)) return null;
        const tg = global.gameManager && global.gameManager.terrainGrid;
        const mapR = ((tg && tg.circleRadius) || 3000) - 260;
        let x, y;
        if (ran.chance(0.4)) {
            // somewhere in the circle this cycle closes to
            const tr = Math.max(500, st.to || st.r * 0.5);
            x = (st.tx || 0) + ran.gauss(0, tr * 0.6);
            y = (st.ty || 0) + ran.gauss(0, tr * 0.6);
        } else {
            x = body.x + ran.gauss(0, 1500);
            y = body.y + ran.gauss(0, 1500);
        }
        // inside the zone (with a margin) and on the map
        const keep = Math.max(150, st.r - 300);
        const dx = x - st.cx, dy = y - st.cy, d = Math.hypot(dx, dy);
        if (d > keep) { x = st.cx + dx / d * keep * 0.9; y = st.cy + dy / d * keep * 0.9; }
        const m = Math.hypot(x, y);
        if (m > mapR) { x = x / m * mapR; y = y / m * mapR; }
        return { ...this.safePoint(x, y), until: now + 16000 };
    }

    explorePoint(now) {
        const body = this.body;
        // bot duo: roam where the partner is, not across the map from them
        const mate = Config.royale_duos ? this.duoMate() : null;
        const human = this.teamHuman();
        if (human) return { ...this.safePoint(human.x + ran.gauss(0, 380), human.y + ran.gauss(0, 380)), until: now + 8000 };
        if (mate && ran.chance(0.75)) {
            return { ...this.safePoint(mate.x + ran.gauss(0, 520), mate.y + ran.gauss(0, 520)), until: now + 12000 };
        }
        const director = body._botDirectorPoint;
        if (director && now < (body._botDirectorUntil || 0) &&
            Math.hypot(director.x - body.x, director.y - body.y) > 300)
            return { ...this.safePoint(director.x, director.y), until: now + 14000 };
        const marker = body._botHelpMarker && body._botHelpMarker.expiresAt > now ? body._botHelpMarker : null;
        if (marker && this.distanceTo(marker) > 300)
            return { ...this.safePoint(marker.x, marker.y), until: now + 14000 };
        // Dig Royale free roam: the map is big (20 tiles, terrain/mapScale.js)
        // and a solo raid holds 5 tanks, so a roaming bot drifts the way the
        // players do, toward where this storm closes, and never picks a spot
        // out in the storm. That is what brings a small raid together. The
        // rest of the time it goes about its old errands (bases, a long walk).
        if (Config.dig_royale && !Config.tutorial && ran.chance(0.55)) {
            const roam = this.royaleRoamPoint(now);
            if (roam) return roam;
        }
        const room = global.gameManager && global.gameManager.room;
        const halfWidth = (room?.width || 6300) / 2, halfHeight = (room?.height || 6300) / 2;
        const all = digWarsOutposts.getOutposts();
        const sites = this.role === 'guard'
            ? all.filter(site => site.team === body.team)
            : this.role === 'raider'
                ? all.filter(site => site.team !== body.team)
                : all;
        if (sites.length && ran.chance(0.65)) {
            const site = ran.choose(sites);
            return {
                ...this.safePoint(
                    util.clamp(site.x + ran.gauss(0, 260), -halfWidth + 280, halfWidth - 280),
                    util.clamp(site.y + ran.gauss(0, 260), -halfHeight + 280, halfHeight - 280)),
                until: now + 16000,
            };
        }
        return {
            ...this.safePoint(
                util.clamp(body.x + ran.gauss(0, 1500), -halfWidth + 280, halfWidth - 280),
                util.clamp(body.y + ran.gauss(0, 1500), -halfHeight + 280, halfHeight - 280)),
            until: now + 16000,
        };
    }

    // ── deciding ─────────────────────────────────────────────────────────
    bankTarget() {
        return Math.min(this.bankAt, (this.body.gemCap || 8000) * 0.9);
    }

    retreatPoint() {
        const body = this.body, threat = this.view.enemy;
        // Dig Royale (fairPlay): no running home to a vault to heal laps round it
        if (Config.dig_royale && fairPlay.on('vault')) {
            if (!threat) return fairPlay.outsideVaults({ x: body.x, y: body.y });
            const away = Math.hypot(body.x - threat.x, body.y - threat.y) || 1;
            return fairPlay.outsideVaults(this.safePoint(body.x + (body.x - threat.x) / away * 1000, body.y + (body.y - threat.y) / away * 1000));
        }
        const vault = this.ownVault();
        if (!threat) return vault ? { x: vault.x, y: vault.y } : { x: body.x, y: body.y };
        const away = Math.hypot(body.x - threat.x, body.y - threat.y) || 1;
        const ax = (body.x - threat.x) / away, ay = (body.y - threat.y) / away;
        if (vault) {
            const toVault = Math.hypot(vault.x - body.x, vault.y - body.y) || 1;
            // only run home when home is away from the shooter
            if (((vault.x - body.x) / toVault) * ax + ((vault.y - body.y) / toVault) * ay > -0.2)
                return { x: vault.x, y: vault.y };
        }
        return this.safePoint(body.x + ax * 1000, body.y + ay * 1000);
    }

    // Serpentine: aim at a point ahead on the way to `point`, displaced side
    // to side so a runner is harder to hit. Higher skill weaves faster and wider.
    weavePoint(point, now, intensity = 1) {
        const body = this.body;
        const dx = point.x - body.x, dy = point.y - body.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 160) return point;
        const skill = this.skill();
        const side = Math.sin(now / (200 + 90 * (1 - skill)) + (body.id % 12) * 0.9) *
            (70 + 110 * intensity) * (0.55 + skill * 0.45);
        const ahead = Math.min(distance, 380);
        return {
            x: body.x + (dx / distance) * ahead - (dy / distance) * side,
            y: body.y + (dy / distance) * ahead + (dx / distance) * side,
        };
    }

    // Etiquette for starting fights with humans. Self-defense (the human shot
    // first) and bot-vs-bot fights skip it.
    canInitiateFight(target, now) {
        // A bot teammate only picks fights near its human (someone who shot
        // at it, or at the human, is handled before this).
        const human = this.teamHuman();
        if (human && Math.hypot(target.x - human.x, target.y - human.y) > TEAM_FIGHT_R &&
            !(this.body._lastDamageSource === target && now - (this.body._lastDamageAt || 0) < 3000)) return false;
        // a fresh bot gets going (mines, grows) before it looks for trouble
        if (inBotGrace(this.body, now)) return false;
        // never start a fight the numbers say we lose (against a player, how
        // bad a trade still looks worth it depends on their difficulty;
        // another bot is only picked on when it is the weaker one, so the
        // winners get big instead of every bot trading lives)
        const diff = botDiff.of(target, now);
        // fairPlay: a small fish takes on a protected player close by
        const duel = this.body.botMinnow && fairPlay.minnowDuel(this.body, target, now);
        const threatCap = target.isPlayer ? botDiff.initThreat(diff) : BOT_FIGHT_THREAT * (target._fpRunaway ? fairPlay.gangThreat(this.body, target) : 1);
        if (!duel && (this.threatRatio(target) > threatCap ||
            (this.fearUntil.get(target.id) || 0) > now)) return false;
        // nor one already wounded
        const health = this.body.health.max ? this.body.health.amount / this.body.health.max : 1;
        if (health < (duel ? 0.3 : 0.55)) return false;
        // Someone in an outpost pocket behind its walls is not a duel; the
        // objective logic sieges the outpost itself.
        if (!this.clearShot(target) && !Config.dig_royale) {
            for (const site of digWarsOutposts.getOutposts()) {
                const dx = target.x - site.x, dy = target.y - site.y;
                if (dx * dx + dy * dy < 300 * 300) return false;
            }
        }
        // no bot-on-bot brawls round a vault (fairPlay): the crossfire camps it for
        if (!target.isPlayer && Config.dig_royale &&
            (fairPlay.inRing(this.body.x, this.body.y) || fairPlay.inRing(target.x, target.y))) return false;
        // a first-kill bait on duty is its host's (fairPlay)
        if (!target.isPlayer && target._fpBait && fairPlay.baitOnDuty(target, now)) return false;
        if (!target.isPlayer) return true;
        const attackedMe = this.body._lastDamageSource === target &&
            now - (this.body._lastDamageAt || 0) < 3000;
        if (attackedMe) return true;
        // fresh spawn (bot grace), or the soft window: bots don't start it
        if (inBotGrace(target, now) || (!leaderHunt(target, now) && botSoft(target, now))) return false;
        if (openSpared(this.body, target, now)) return false;
        if (target.nxScaryUntil && newcomer.scarySpared(this.body, target, now)) return false;
        if (fairPlay.guarded(target) && fairPlay.spared(this.body, target, now)) return false;
        if (fairPlay.farmed(this.body, target, now)) return false;
        // recently gave up chasing them
        if ((this.playerBreakUntil.get(target.id) || 0) > now) return false;
        // Mercy: a player dying repeatedly to bots is left alone until they
        // kill a bot themselves.
        if ((target.socket?.botMercyUntil || 0) > now) return false;
        // dogpile cap: one or two bots on one player, by difficulty
        const cap = hunterCap(target, now);
        let fighting = 0;
        for (const tank of botWorldScan().tanks) {
            if (tank.isBot && tank !== this.body && tank._fightingPlayerId === target.id &&
                ++fighting >= cap) return false;
        }
        return true;
    }

    // Enclosed by a chamber ring that regrew around us; the only way out is
    // to shoot through it.
    trappedInChamber() {
        const body = this.body;
        for (const chamber of digWarsChambers.getChambers()) {
            const entity = chamber.entity;
            if (!entity || entity.isDead?.() || chamber.state === 'destroyed') continue;
            const inner = chamber.r * (entity.sizeMultiplier ?? 1);
            const dx = body.x - chamber.x, dy = body.y - chamber.y;
            if (dx * dx + dy * dy < inner * inner) return chamber;
        }
        return null;
    }

    candidate(now) {
        const body = this.body, view = this.view;
        const health = body.health.max ? body.health.amount / body.health.max : 1;
        const outnumbered = view.enemies > view.allies + 1;
        const threatened = view.enemy && view.enemyDistance < 900;

        // walled in by a regrown ring: blast an exit before anything else
        const trap = this.trappedInChamber();
        if (trap) return { kind: 'objective', point: trap, structure: 'chamber', trapped: true };

        // A bot teammate stays with its human: too far and it heads back,
        // whatever it was doing (the weapon layer still returns fire).
        const human = this.teamHuman();
        if (human) {
            const dm = this.distanceTo(human);
            if (dm > TEAM_LEASH_FAR || (dm > TEAM_LEASH && !(threatened && view.enemyDistance < 600)))
                return { kind: 'regroup', mate: human, expiresAt: now + 6000 };
        }

        // round 12 leader hunt: close in on a runaway #1 we can see from afar
        body._leaderHuntId = 0;
        const lhunt = Config.dig_royale && view.enemy && !human ? leaderHunt(view.enemy, now) : null;
        if (lhunt && health > 0.45 && view.enemyDistance < LEADER_R &&
            view.enemyDistance >= (view.enemy.isPlayer ? botDiff.initRange(botDiff.of(view.enemy, now)) : 1400) &&
            !inEnemyBase(body.team, view.enemy.x, view.enemy.y) &&
            leaderHunters(view.enemy.id, body) < leaderCap(lhunt) && this.canInitiateFight(view.enemy, now)) {
            body._leaderHuntId = view.enemy.id;
            const e = view.enemy, a = Math.atan2(body.y - e.y, body.x - e.x);
            return { kind: 'explore', point: { ...this.safePoint(e.x + Math.cos(a) * 500, e.y + Math.sin(a) * 500), until: now + 3500 }, hunt: 1 };
        }
        if (Config.dig_royale && view.enemy &&
            view.enemyDistance < (view.enemy.isPlayer ? botDiff.initRange(botDiff.of(view.enemy, now)) * botDiff.gentleRange(botDiff.gentle(view.enemy)) : 1400) &&
            now - (this._enemySeenAt || 0) >= (this.reactionMs || 250) &&
            this.canInitiateFight(view.enemy, now))
            return { kind: 'fight', target: view.enemy };
        if (Config.dig_royale) {
            const royale = require('../game/gamemodes/scripts/dig_royale.js');
            const flee = royale.stormFleePoint && royale.stormFleePoint(body);
            if (flee && !(view.enemy && view.enemyDistance < 1100))
                return { kind: 'survive', point: flee };
        }
        // a first-kill bait (fairPlay): over to its host, then into it and no running off
        if (Config.dig_royale && body._fpBait && !human) {
            const host = fairPlay.baitHost(body, now);
            if (host && !inBotGrace(host, now)) {
                const d = this.distanceTo(host);
                if (d < fairPlay.TUNE.FIRST_FIGHT_R) return { kind: 'fight', target: host };
                const a = Math.atan2(body.y - host.y, body.x - host.x);
                return { kind: 'explore', point: { ...this.safePoint(host.x + Math.cos(a) * 600, host.y + Math.sin(a) * 600), until: now + 4000 } };
            }
        }

        // below a quarter health, disengage regardless of temperament (a small fish
        const duel = body.botMinnow && view.enemy && fairPlay.minnowDuel(body, view.enemy, now);
        if (duel ? health < fairPlay.TUNE.MINNOW_DUEL_RETREAT
            : (health < 0.25 || (threatened && (health < this.retreatAt() || (outnumbered && health < 0.6) ||
            (this.feared(view.enemy, now) && health < 0.75)))))
            return { kind: 'survive', point: this.retreatPoint() };
        // killed someone at a vault: grab the loot, then move on (fairPlay)
        if (Config.dig_royale && !human && body._fpMoveOn) {
            const mo = fairPlay.moveOnPoint(body, now);
            if (mo) return { kind: 'explore', point: { ...this.safePoint(mo.x, mo.y), until: mo.until }, vaultLeave: true };
        }
        const back = this.comebackTarget(now, health);
        if (back) return { kind: 'fight', target: back };
        // bank on threshold, and also periodically
        const bankOverdue = (body.carriedGems || 0) >= 25 &&
            now - (body._lastBankAt || this.bornAt) > 75000;
        // (a crown can't bank in sudden death: crowns.js)
        if (!body.crownLocked && ((body.carriedGems || 0) >= this.bankTarget() || body.vaultDeposit || bankOverdue) &&
            (!human || body.vaultDeposit || this.bankNearHuman(human)))
            return { kind: 'bank' };
        // Fighting back comes first; picking fights comes near the bottom, so
        // a bot keeps its errand when an enemy merely wanders past.
        const attackedBy = body._lastDamageSource && now - (body._lastDamageAt || 0) < 2500 &&
            this.isEnemy(body._lastDamageSource) && body._lastDamageSource.health?.amount > 0 &&
            !inEnemyBase(body.team, body._lastDamageSource.x, body._lastDamageSource.y) &&
            this.distanceTo(body._lastDamageSource) < this.engageRange() * 1.2
            ? body._lastDamageSource : null;
        // Not against someone who already wins the trade: keep to the errand
        // (the weapon layer still returns fire) until survive kicks in.
        if (attackedBy && !(outnumbered && health < 0.55) &&
            !(this.feared(attackedBy, now) && health < 0.85))
            return { kind: 'fight', target: attackedBy };
        // no hanging round a vault without banking (fairPlay): move on
        if (Config.dig_royale && !human) {
            const leave = fairPlay.lingerCheck(body, false, now);
            if (leave) return { kind: 'explore', point: { ...this.safePoint(leave.x, leave.y), until: leave.until }, vaultLeave: true };
        }
        // bot duo: someone is on our partner, go help
        if (view.mateAttacker && health > 0.35 && this.distanceTo(view.mateAttacker) < 1500 &&
            !(this.feared(view.mateAttacker, now) && health < 0.6))
            return { kind: 'fight', target: view.mateAttacker };
        if (view.gem)
            return { kind: 'collect', gem: view.gem };
        // bot duo: past ~1300 from the partner, head back over
        if (Config.dig_royale && Config.royale_duos) {
            const mate = this.duoMate();
            if (mate && this.distanceTo(mate) > 1300 && !(view.enemy && view.enemyDistance < 700))
                return { kind: 'rally', point: this.safePoint(mate.x + ran.gauss(0, 160), mate.y + ran.gauss(0, 160)), expiresAt: now + 5000 };
        }
        if (view.defense)
            return { kind: 'defend', point: view.defense.point, target: view.defense.target };
        if (view.objective)
            return { kind: 'objective', point: view.objective.point, structure: view.objective.kind };
        // a teammate is fighting somewhere close: go take part
        const marker = body._botHelpMarker && body._botHelpMarker.expiresAt > now ? body._botHelpMarker : null;
        if (marker && this.distanceTo(marker) < 3000 && this.distanceTo(marker) > 300)
            return { kind: 'rally', point: this.safePoint(marker.x, marker.y), expiresAt: marker.expiresAt };
        if (view.allyInTrouble)
            return { kind: 'rally', point: this.safePoint(view.allyInTrouble.x, view.allyInTrouble.y), expiresAt: now + 6000 };
        if (Config.dig_royale && !human) {
            const ev = this.eventGoal(now, health);
            if (ev) return ev;
        }
        // never chase someone into their own base (the tiles kill us)
        if (view.enemy && view.enemyDistance < this.engageRange() && !outnumbered &&
            !inEnemyBase(body.team, view.enemy.x, view.enemy.y) &&
            this.canInitiateFight(view.enemy, now))
            return { kind: 'fight', target: view.enemy };
        // A raid boss is the richest thing on the map: a healthy bot goes
        // for it (a grown one opens, the rest join once it is taken on)
        if (Config.dig_royale && this.role !== 'guard' && !human) {
            const boss = this.bossToHunt(now, health);
            if (boss) return { kind: 'fight', target: boss };
        }
        // an ore bloom is a magnet for miners: walk over, then mine as usual
        if (Config.dig_royale && this.role !== 'guard') {
            try {
                const bl = require('../game/terrain/blooms.js').current();
                if (bl && !(human && Math.hypot(bl.x - human.x, bl.y - human.y) > TEAM_LEASH)) {
                    const dBl = this.distanceTo(bl);
                    if (dBl > 420 && dBl < 2600 && (body.carriedGems || 0) < this.bankTarget() * 0.8)
                        return { kind: 'explore', point: { x: bl.x + (Math.random() - 0.5) * 220, y: bl.y + (Math.random() - 0.5) * 220, until: Math.min(bl.until, now + 20000) } };
                }
            } catch { /* */ }
        }
        // a chest nearby is worth more than any rock: one bot per chest
        if (Config.dig_royale && this.role !== 'guard') {
            const ch = this.nearChest(now);
            if (ch) return { kind: 'chest', target: ch };
        }
        if (view.rock)
            return { kind: 'mine', rock: view.rock };
        return { kind: 'explore', point: this.explorePoint(now) };
    }

    // A locked-on bot does not let a player with a real satchel (or the
    // raid's hunted mark) walk away.
    chasesCarrier(target, now) {
        if (!target || !target.isPlayer || !tactics.huntOn() || botSoft(target, now)) return false;
        if (botDiff.lockShare(botDiff.of(target, now)) < 0.5) return false;
        return (target.carriedGems || 0) >= 400 || (target.huntedLevel | 0) >= 1;
    }

    // Healed up after running from a fight: go back for whoever chased us
    // off, if they are still around.
    comebackTarget(now, health) {
        const cb = this.comeback;
        if (!cb || now > cb.until || health < 0.8 || !tactics.isEnabled()) return null;
        const t = cb.target;
        if (!t || t.isDead?.() || !this.isEnemy(t) || inBotGrace(t, now) || softSpared(this.body, t, now) ||
            (fairPlay.guarded(t) && fairPlay.spared(this.body, t, now)) || fairPlay.farmed(this.body, t, now) ||
            this.distanceTo(t) > 1500 || inEnemyBase(this.body.team, t.x, t.y)) { this.comeback = null; return null; }
        if (t.isPlayer && botDiff.lockShare(botDiff.of(t, now)) <= 0) { this.comeback = null; return null; }
        if (!this.canInitiateFight(t, now)) return null;
        this.comeback = null;
        return t;
    }

    // The boss, if this bot should be on it now. At most BOSS_HUNTERS bots
    // at once; nobody who is hurt, heavy with gems, a rammer or still wary
    // of it after a bad trade.
    bossToHunt(now, health) {
        if (now < (this.bossCheckAt || 0)) return this.bossPick && !this.bossPick.isDead?.() ? this.bossPick : null;
        this.bossCheckAt = now + 700;
        this.bossPick = null;
        const body = this.body;
        if (health < 0.7 || this.isRammer() || (body.carriedGems || 0) >= this.bankTarget() * 0.7) return null;
        // a first-kill fish never goes after the boss (terrain/fairPlay.js fodder)
        if (body._fpFodder && fairPlay.isFodder(body)) return null;
        let boss = null;
        try { boss = require('../game/terrain/bosses.js').current(); } catch { return null; }
        if (!boss || (this.fearUntil.get(boss.id) || 0) > now || this.distanceTo(boss) > 1800) return null;
        let hunters = 0;
        for (const tank of botWorldScan().tanks) {
            if (tank.isBot && tank !== body && (tank._botBossHuntUntil || 0) > now) hunters++;
        }
        if (hunters >= BOSS_HUNTERS) return null;
        const hurt = boss.health.max ? boss.health.amount / boss.health.max < 0.8 : false;
        const engaged = hunters > 0 || now - (boss.hitAt || 0) < 4000;
        if (!engaged && !hurt && (body.growthMult || 1) < 1.3) return null;
        body._botBossHuntUntil = now + 3000;
        this.bossPick = boss;
        return boss;
    }

    eventGoal(now, health) {
        const body = this.body;
        if (body.isTeamBot || health < 0.4) return null;
        let g = null;
        try { g = require('../game/terrain/alwaysOn.js').botGoal(body, now); } catch { return null; }
        if (!g) return null;
        const fish = body._fpBait || (body._fpFodder && fairPlay.isFodder(body));
        if (fish && g.fight) return null;
        if (g.kind === 'boss' && g.target && !g.target.isDead?.()) {
            if (this.isRammer() || (this.fearUntil.get(g.target.id) || 0) > now) return null;
            if (this.distanceTo(g.target) < 1500) { body._botBossHuntUntil = now + 3000; return { kind: 'fight', target: g.target }; }
            return { kind: 'aogo', point: { x: g.x, y: g.y }, arrive: 400, until: now + 8000 };
        }
        if (g.kind === 'shoot' && g.target && !g.target.isDead?.()) {
            if (this.isRammer()) return null;
            return { kind: 'aoshoot', target: g.target, r: g.r || 100 };
        }
        if (g.kind === 'go') return { kind: 'aogo', point: this.safePoint(g.x, g.y), arrive: g.arrive || 150, until: now + 9000 };
        return null;
    }

    nearChest(now) {
        if (now < (this.chestCheckAt || 0)) return this.chestPick || null;
        this.chestCheckAt = now + 500;
        this.chestPick = null;
        if (now < (this.chestSkipUntil || 0)) return null;
        let list = [];
        try { list = require('../game/terrain/chests.js').alive(); } catch { return null; }
        const body = this.body;
        let best = null, bd = 900 * 900;
        for (const c of list) {
            if (!c || c._opened || c.isDead?.()) continue;
            if (c._botClaim && c._botClaim.id !== body.id && c._botClaim.until > now) continue;
            const d = (c.x - body.x) ** 2 + (c.y - body.y) ** 2;
            if (d < bd) { bd = d; best = c; }
        }
        if (best) best._botClaim = { id: body.id, until: now + 8000 };
        this.chestPick = best;
        return best;
    }

    sameGoal(a, b) {
        if (a.kind !== b.kind) return false;
        switch (a.kind) {
            case 'fight': return a.target === b.target;
            case 'collect': return a.gem === b.gem;
            case 'chest': return a.target === b.target;
            case 'aoshoot': return a.target === b.target;
            case 'aogo': return Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) < 120;
            // any rock is the same job, so a nearer one never replaces a
            // half-broken one
            case 'mine': return true;
            case 'objective':
            case 'defend': return a.point === b.point;
            default: return true;
        }
    }

    stillValid(goal, now) {
        const body = this.body;
        switch (goal.kind) {
            case 'survive': {
                // leave the healing loiter a little early
                const health = body.health.max ? body.health.amount / body.health.max : 1;
                return health < this.retreatAt() + 0.08;
            }
            case 'aoshoot': {
                const c = goal.target;
                if (!c || c.isDead?.() || !(c.health && c.health.amount > 0)) return false;
                return this.distanceTo(c) < 3200;
            }
            case 'aogo':
                return !!goal.point && now < (goal.until || 0) && this.distanceTo(goal.point) > (goal.arrive || 150) + 40;
            case 'chest': {
                const c = goal.target;
                if (!c || c._opened || c.isDead?.()) return false;
                if (this.distanceTo(c) > 1400) { this.chestSkipUntil = now + 15000; return false; }
                if (now - this.goalStartedAt > 25000) { this.chestSkipUntil = now + 20000; return false; }
                return true;
            }
            case 'bank':
                return !body.crownLocked && (!!body.vaultDeposit || (body.carriedGems || 0) >= 15);
            case 'fight': {
                if (!goal.target || goal.target.isDead?.() || !(goal.target.health?.amount > 0) ||
                    this.distanceTo(goal.target) >= (body.fov || 1200) * 1.4 ||
                    inEnemyBase(body.team, goal.target.x, goal.target.y)) return false;
                // a protected player made it to a vault's approach: let them bank
                if (fairPlay.guarded(goal.target) && fairPlay.spared(body, goal.target, now)) {
                    this.playerBreakUntil.set(goal.target.id, now + 8000);
                    return false;
                }
                // killed them twice lately: fought back while shot, now let them go
                if (goal.target.isPlayer && fairPlay.farmed(body, goal.target, now)) {
                    this.playerBreakUntil.set(goal.target.id, now + 15000);
                    return false;
                }
                // a small fish trading shots with a protected player sees it through (fairPlay)
                const duel = body.botMinnow && fairPlay.minnowDuel(body, goal.target, now);
                if (duel) fairPlay.noteDuel(goal.target, now);
                // a losing 1v2 is a fight to leave
                if (!duel && this.view.enemies > this.view.allies + 1 &&
                    (body.health.max ? body.health.amount / body.health.max : 1) < 0.55) return false;
                // Score the trade while it runs: if our health drains much
                // faster than theirs, leave and fear them for a while so the
                // bot does not re-engage straight away.
                const myHp = body.health.max ? body.health.amount / body.health.max : 1;
                const theirHp = goal.target.health?.max
                    ? goal.target.health.amount / goal.target.health.max : 1;
                const myLoss = (this.fightMyHp ?? myHp) - myHp;
                const theirLoss = (this.fightTheirHp ?? theirHp) - theirHp;
                if (!duel && now - this.goalStartedAt > 2000 && myHp < 0.7 &&
                    myLoss > 0.2 && myLoss > theirLoss * 1.5) {
                    if (this.fearUntil.size > 12) {
                        for (const [id, until] of this.fearUntil) if (until < now) this.fearUntil.delete(id);
                    }
                    this.fearUntil.set(goal.target.id, now + 15000);
                    return false;
                }
                // Five straight seconds without a clear shot (outpost pocket,
                // rock wall): give up and remember them so the bot does not
                // re-lock immediately.
                if (this.clearShot(goal.target)) {
                    this.fightBlockedSince = 0;
                } else if (!this.fightBlockedSince) {
                    this.fightBlockedSince = now;
                } else if (now - this.fightBlockedSince > 5000) {
                    this.fightBlockedSince = 0;
                    if (this.playerBreakUntil.size > 8) {
                        for (const [id, until] of this.playerBreakUntil) if (until < now) this.playerBreakUntil.delete(id);
                    }
                    this.playerBreakUntil.set(goal.target.id, now + 20000);
                    return false;
                }
                // 12s chasing a human who is not shooting back: let them go
                // (a locked-on bot runs a fleeing carrier down for 25s)
                if (goal.target.isPlayer && now - this.goalStartedAt > (this.chasesCarrier(goal.target, now) ? 25000 : 12000) &&
                    !(body._lastDamageSource === goal.target && now - (body._lastDamageAt || 0) < 3000)) {
                    if (this.playerBreakUntil.size > 8) {
                        for (const [id, until] of this.playerBreakUntil) if (until < now) this.playerBreakUntil.delete(id);
                    }
                    this.playerBreakUntil.set(goal.target.id, now + 15000);
                    return false;
                }
                return true;
            }
            case 'collect':
                return goal.gem && goal.gem.gemValue > 0 && !goal.gem.isDead?.() &&
                    this.distanceTo(goal.gem) < 900 && !this.gemSealedInChamber(goal.gem);
            case 'defend':
                return !!goal.point && goal.point.team === body.team && !!goal.point.banner;
            case 'objective': {
                if (!goal.point) return false;
                // breaking out: valid while still inside, own-team rings included
                if (goal.trapped) return this.trappedInChamber() === goal.point;
                const alive = goal.structure === 'chamber'
                    ? goal.point.state === 'alive' && goal.point.team !== body.team
                    : !!goal.point.banner && !goal.point.banner.isDead() && goal.point.team !== body.team;
                if (!alive) return false;
                // Chambers self-heal, so only a health drop counts as siege
                // progress; a dry siege blacklists the structure for a while.
                const hp = goal.structure === 'chamber'
                    ? goal.point.entity?.health?.amount
                    : goal.point.banner?.health?.amount;
                if (hp !== undefined) {
                    if (hp < (this.objHealth ?? Infinity) - 1e-6) {
                        this.objHealth = hp;
                        this.objProgressAt = now;
                    }
                    // the dry-siege clock only runs while in siege range
                    const besieging = this.distanceTo(goal.point) <
                        this.structureClearance(goal.point) + Math.max(320, this.weaponRange());
                    // Alone, give up after 9s; with teammates on the same
                    // target, combined fire can beat the self-heal, so hold 25s.
                    let squadAttackers = 0;
                    for (const tank of botWorldScan().tanks) {
                        if (tank !== body && tank.isBot && tank.team === body.team &&
                            tank._digWarsObjectivePoint === goal.point &&
                            Math.hypot(tank.x - body.x, tank.y - body.y) < 1100) squadAttackers++;
                    }
                    const patience = squadAttackers > 0 ? 25000 : 9000;
                    if (!besieging) {
                        this.objProgressAt = now;
                    } else if (now - (this.objProgressAt || this.goalStartedAt) > patience) {
                        this.objectiveBlacklist.set(goal.point, now + 30000);
                        return false;
                    }
                }
                return true;
            }
            case 'mine': {
                if (!goal.rock || !goal.rock.alive) return false;
                if ((this.rockBlacklist.get(goal.rock) || 0) >= now) return false;
                // Stay on one rock until it breaks (spreading damage over many
                // rocks breaks none).
                if (goal.rock.health < (this.mineHealth ?? Infinity) - 1e-6) {
                    this.mineHealth = goal.rock.health;
                    this.mineProgressAt = now;
                }
                // Six seconds in range with no damage landing: blacklist it.
                // The clock only runs once the rock is in firing range.
                if (this.distanceTo({ x: goal.rock.wx, y: goal.rock.wy }) - (goal.rock.maxPolyRadius || 60) >
                    this.weaponRange() * 0.9) {
                    this.mineProgressAt = now;
                } else if (now - (this.mineProgressAt || this.goalStartedAt) > 6000) {
                    this.rockBlacklist.set(goal.rock, now + 20000);
                    return false;
                }
                return true;
            }
            case 'rally':
                return now < (goal.expiresAt || 0) && this.distanceTo(goal.point) > 260;
            case 'regroup':
                return now < (goal.expiresAt || 0) && !!goal.mate && !goal.mate.isDead?.() &&
                    goal.mate.team === body.team && this.distanceTo(goal.mate) > 380;
            case 'explore':
                return goal.point && now < goal.point.until && this.distanceTo(goal.point) > 220;
        }
        return false;
    }

    decide(now) {
        const current = this.goal;
        const valid = current ? this.stillValid(current, now) : false;
        // The candidate only changes with what the bot sees (sense, every
        // 100-270 ms) or a hit; between those a running, valid goal inside its
        // hold just carries on (candidate() used to run every tick per bot).
        const hp = this.body.health.max ? this.body.health.amount / this.body.health.max : 1;
        if (current && valid && now < this.holdUntil && this._planSense === this.senseAt && hp > (this._planHp ?? 1) - 0.05) return;
        this._planSense = this.senseAt;
        this._planHp = hp;
        const candidate = this.candidate(now);
        const mustSwitch = !current || !valid || now >= this.holdUntil ||
            GOAL_PRIORITY[candidate.kind] > GOAL_PRIORITY[current.kind];
        if (!mustSwitch) return;
        if (current && valid && this.sameGoal(current, candidate)) {
            this.holdUntil = now + GOAL_HOLD[candidate.kind];
            return;
        }
        // ran off to heal: remember who from, to come back for them
        if (candidate.kind === 'survive' && this.view.enemy && (!current || current.kind !== 'survive'))
            this.comeback = { target: this.view.enemy, until: now + 25000 };
        // a change of plan costs a short hesitation
        if (!current || current.kind !== candidate.kind) this.hesitateUntil = candidate.kind === 'survive' ? 0 : now + 90 + Math.random() * 240;
        this.goal = candidate;
        this.goalStartedAt = now;
        this.fightBlockedSince = 0;
        if (candidate.kind === 'mine') {
            this.mineHealth = candidate.rock.health;
            this.mineProgressAt = now;
        }
        if (candidate.kind === 'fight') {
            const target = candidate.target;
            this.fightMyHp = this.body.health.max ? this.body.health.amount / this.body.health.max : 1;
            this.fightTheirHp = target?.health?.max ? target.health.amount / target.health.max : 1;
        }
        if (candidate.kind === 'objective') {
            this.objHealth = candidate.structure === 'chamber'
                ? candidate.point.entity?.health?.amount
                : candidate.point.banner?.health?.amount;
            this.objProgressAt = now;
        }
        this.holdUntil = now + GOAL_HOLD[candidate.kind] * (0.75 + Math.random() * 0.5);
        this.nav.nextProbeAt = 0;
        this.nav.arrived = false;
        this.body._digWarsGoal = candidate.kind;
        this.body._digWarsObjectivePoint = candidate.kind === 'objective' ? candidate.point : null;
        this.body._digWarsObjectiveKind = candidate.kind === 'objective' ? candidate.structure : null;
        // advertised so teammates can honor the dogpile cap
        this.body._fightingPlayerId = candidate.kind === 'fight' && candidate.target?.isPlayer
            ? candidate.target.id : null;
    }

    // ── acting ───────────────────────────────────────────────────────────
    // Standoff that clears the whole structure (a chamber ring is far larger
    // than an outpost banner).
    structureClearance(target) {
        if (target.entity !== undefined) return (target.r || 160) + 26;
        const banner = target.banner;
        return Math.max(target.r || 95, banner ? (banner.realSize || banner.size || 40) + 25 : 60);
    }

    orbitPoint(key, target, radius, now, spread = 0, rateScale = 1) {
        if (!this.orbit || this.orbit.key !== key) {
            this.orbit = {
                key,
                at: now,
                phase: Math.atan2(this.body.y - target.y, this.body.x - target.x) + ran.gauss(0, 0.25),
                rate: (0.00025 + Math.random() * 0.0004) * rateScale * (ran.chance(0.5) ? 1 : -1),
            };
        }
        // the radius breathes a few percent so the orbit is not a perfect circle
        radius *= 1 + 0.06 * Math.sin(now / 1150 + (this.body.id % 7));
        const angle = this.orbit.phase + (now - this.orbit.at) * this.orbit.rate + spread;
        // same neighbour-rock dodge as minePoint
        const tg = global.gameManager && global.gameManager.terrainGrid;
        const stride = this.orbit.rate >= 0 ? 0.55 : -0.55;
        for (let i = 0; i < 6; i++) {
            const a = angle + i * stride;
            const x = target.x + Math.cos(a) * radius, y = target.y + Math.sin(a) * radius;
            if (!tg?.pointInRock || !tg.pointInRock(x, y)) return { x, y };
        }
        return { x: target.x + Math.cos(angle) * radius, y: target.y + Math.sin(angle) * radius };
    }

    combatPoint(target, now) {
        // rammers weave in on the approach rather than charging straight
        if (this.isRammer())
            return this.distanceTo(target) > 260 ? this.weavePoint(target, now, 0.8) : target;
        // stand off wider against a clearly stronger tank
        let range = this.desiredRange();
        if (this.threatRatio(target) > 1.15)
            range = Math.min(this.weaponRange() * 0.9, range * 1.45);
        // a boss is wide: keep the standoff from its rim, not its centre
        if (target.isRoyaleBoss) range = Math.min(this.weaponRange() * 0.9, range + (target.realSize || 0) * 0.6);
        // kite while hurt: the lower the health, the wider the standoff
        const health = this.body.health.max ? this.body.health.amount / this.body.health.max : 1;
        if (health < 0.65)
            range = Math.min(this.weaponRange() * 0.95, range * (1 + (0.65 - health) * 1.6));
        // Lock-on (a strong player): duck behind rock to peek-shoot when
        // hurt, run a fleeing carrier down, juke more often.
        const lock = target.isPlayer && tactics.isEnabled() && !botSoft(target, now)
            ? botDiff.lockShare(botDiff.of(target, now)) : 0;
        if (lock > 0) {
            const cover = this.coverPoint(target, now, health, false);
            if (cover) return cover;
            if (lock > 0.5 && this.chasesCarrier(target, now)) {
                const tv = target.velocity || { x: 0, y: 0 };
                const away = (target.x - this.body.x) * tv.x + (target.y - this.body.y) * tv.y;
                // heading away and out of our sweet spot: cut them off
                // (and burn a dash to close a long gap)
                if (away > 0 && this.distanceTo(target) > range * 1.15) {
                    if (this.distanceTo(target) > range * 2) this.botDash(now, target.x - this.body.x, target.y - this.body.y, 0.04 * lock);
                    return { x: target.x + tv.x * 14, y: target.y + tv.y * 14 };
                }
            }
        } else this.cover = null;
        // Strafe hard and flip direction at random intervals to break the
        // opponent's aim lead.
        if (now > (this.strafeFlipAt || 0)) {
            this.strafeFlipAt = now + (650 + Math.random() * 1200) * (1 - 0.55 * lock);
            if (this.orbit && ran.chance(0.55 + 0.2 * lock)) this.orbit.rate = -this.orbit.rate;
        }
        // Combat rhythm: strafe, press in, back off in irregular beats, each
        // bot at its own preferred radius.
        if (!this.rhythm || now > this.rhythm.until) {
            const r = Math.random();
            this.rhythm = { mode: r < 0.55 ? 'strafe' : r < 0.8 ? 'press' : 'back', until: now + 900 + Math.random() * 2100 };
        }
        const bias = this.body.botOrbitBias || (this.body.botOrbitBias = 0.85 + Math.random() * 0.35);
        range *= bias * (this.rhythm.mode === 'press' ? 0.72 : this.rhythm.mode === 'back' ? 1.3 : 1);
        // a first-kill bait stands off where a beginner's shots connect (fairPlay)
        if (this.body._fpBait && fairPlay.isBaitPair(this.body, target, now)) range = Math.max(range, fairPlay.TUNE.FIRST_RANGE);
        const point = this.orbitPoint(`f${target.id}`, target, range, now, 0, 3);
        // long approaches are weaved
        return this.distanceTo(target) > range * 1.6 ? this.weavePoint(point, now, 0.9) : point;
    }

    // Behind the nearest rock that blocks `target`'s line, in a hide / peek
    // beat (survive: hide only, for a few seconds). Null when there is no
    // such rock or no reason to hide.
    coverPoint(target, now, health, surviving) {
        const body = this.body;
        const tg = global.gameManager && global.gameManager.terrainGrid;
        let c = this.cover;
        if (this.isRammer() || !tg || this.distanceTo(target) > 950 ||
            (surviving ? health > 0.6 : health > 0.72) ||
            (c && (!c.rock.alive || c.target !== target || (c.stopAt && now > c.stopAt)))) {
            if (c && c.stopAt && now > c.stopAt) this.coverSkipUntil = now + 6000;
            this.cover = c = null;
        }
        if (!c) {
            if ((!surviving && health > 0.5) || now < (this.coverCheckAt || 0) || now < (this.coverSkipUntil || 0)) return null;
            this.coverCheckAt = now + 600;
            const spot = tactics.coverSpot(body, target, tg, 340, this._coverBuf || (this._coverBuf = []));
            if (!spot) return null;
            c = this.cover = {
                target, rock: spot.rock, rr: spot.rr, peek: false, side: ran.chance(0.5) ? 1 : -1,
                until: now + 900 + Math.random() * 700, stopAt: surviving ? now + 4000 : 0,
            };
        }
        if (!surviving && now > c.until) {
            c.peek = !c.peek;
            c.until = now + (c.peek ? 600 + Math.random() * 600 : 800 + Math.random() * 800);
            if (c.peek && ran.chance(0.4)) c.side = -c.side;
        }
        if (surviving) c.peek = false;
        // keep the rock between us as they move; a peek steps out to one side
        const r = this.nav.radius();
        let a = Math.atan2(c.rock.wy - target.y, c.rock.wx - target.x);
        if (c.peek) a += c.side * 0.8;
        const d = c.rr + r + 14;
        return { x: c.rock.wx + Math.cos(a) * d, y: c.rock.wy + Math.sin(a) * d };
    }

    // An enemy shot about to land: a short sidestep, if this bot reads it in
    // time. Only while fighting a player bots are locked on to.
    dodgeVector(now) {
        if (now < (this.dodgeUntil || 0)) return this.dodgeDir;
        if (now < (this.dodgeCheckAt || 0) || !tactics.isEnabled()) return null;
        this.dodgeCheckAt = now + 90 + Math.random() * 60;
        const enemy = this.view.enemy;
        if (!enemy || this.view.enemyDistance > 1100 || this.isRammer()) return null;
        const lock = enemy.isPlayer ? (botSoft(enemy, now) ? 0 : botDiff.lockShare(botDiff.of(enemy, now))) : 0;
        if (lock <= 0) return null;
        const th = tactics.threat(this.body, botWorldScan().shots);
        if (!th) return null;
        // not every shot gets read
        if (Math.random() > 0.3 + 0.5 * lock) { this.dodgeCheckAt = now + 260; return null; }
        const tg = global.gameManager && global.gameManager.terrainGrid;
        const r = this.nav.radius();
        if (tg && tg.rockHitByCircle && tg.rockHitByCircle(this.body.x + th.ax * r * 2.2, this.body.y + th.ay * r * 2.2, r * 0.9)) return null;
        this.dodgeDir = th;
        this.dodgeUntil = now + 180 + Math.random() * 140;
        // a heavy shot or a close call: sometimes a dash instead of a step
        if (th.t < 12) this.botDash(now, th.ax, th.ay, 0.55 * lock);
        return th;
    }

    // Dash (terrain/abilities.js), when this raid has it: now and then, with
    // a few seconds between, the way a player spends charges.
    botDash(now, dx, dy, chance) {
        if (now < (this.dashAt || 0) || Math.random() > chance) return false;
        this.dashAt = now + 1500 + Math.random() * 2500;
        return tactics.abDash(this.body, dx, dy);
    }

    // How hard to play abilities against `enemy`: 0 for a newcomer (or the
    // soft window, or anyone below 0.25), rising to 1 at full lock-on. Other
    // bots 0.4, a boss 0.6.
    abilityHeat(enemy, now) {
        if (!enemy) return 0;
        if (enemy.isRoyaleBoss) return 0.6;
        if (!enemy.isPlayer) return 0.4;
        if (enemy.botNewbie || botSoft(enemy, now)) return 0;
        return util.clamp((botDiff.of(enemy, now) - 0.25) / 0.75, 0, 1);
    }

    // A soft player (the soft window at the start of a life) within `r`: no area
    softPlayerNear(r, now) {
        for (const t of botWorldScan().tanks) {
            const root = this.rootOf(t);
            if (!root.isPlayer || root.team === this.body.team) continue;
            if (!(root.botNewbie || botSoft(root, now))) continue;
            if ((root.x - this.body.x) ** 2 + (root.y - this.body.y) ** 2 < r * r) return true;
        }
        return false;
    }

    // The secondary ability (botTactics.equipBot), fired the way a player
    // who knows it would: against a locked-on player nearly every time it is
    // off cooldown and the moment fits. Decided every ~half second; the API
    // owns cooldowns. Dash jukes ride on the same beat.
    useAbilities(now) {
        if (now < (this.abAt || 0) || !tactics.abilitiesEnabled()) return;
        this.abAt = now + 400 + Math.random() * 300;
        const body = this.body, id = body.botAbility;
        const view = this.view, goal = this.goal, kind = goal && goal.kind;
        // a first-kill bait has no tricks for its host (fairPlay)
        if (body._fpBait && fairPlay.baitHost(body, now)) return;
        const enemy = view.enemy, dist = view.enemyDistance;
        const heat = this.abilityHeat(enemy, now);
        const fight = kind === 'fight' && !!enemy && goal.target === enemy;
        // dash: a sidestep or a lunge every few seconds of a real fight
        if (fight && heat > 0 && dist < 900) {
            const dx = enemy.x - body.x, dy = enemy.y - body.y, d = Math.hypot(dx, dy) || 1;
            const side = this.orbit && this.orbit.rate < 0 ? -1 : 1;
            const lunge = d > this.weaponRange() * 0.85;
            this.botDash(now, lunge ? dx / d : -dy / d * side, lunge ? dy / d : dx / d * side, 0.35 * heat);
        }
        if (!id || !tactics.abReady(body, id)) return;
        const health = body.health.max ? body.health.amount / body.health.max : 1;
        const carried = body.carriedGems || 0;
        const fleeing = !!enemy && dist < 800 && (kind === 'survive' || (kind === 'bank' && carried >= 600));
        const away = fleeing && goal.point ? goal.point : fleeing && enemy
            ? { x: body.x * 2 - enemy.x, y: body.y * 2 - enemy.y } : null;
        const chasing = fight && enemy.isPlayer && this.chasesCarrier(enemy, now);
        // under fire right now
        const hit = now - (body._lastDamageAt || 0) < 2000;
        // offensive uses scale with heat (0 against a newcomer); escapes do not
        const hot = 0.95 * heat, safe = 0.9;
        let at = null, chance = 0;
        switch (id) {
            case 'smoke':
                // vanish when hurt, running, or hauling a fat satchel
                if (enemy && dist < 800 && (fleeing || health < 0.45 || (fight && hit && health < 0.7))) { at = body; chance = safe; }
                break;
            case 'shock': {
                if (heat <= 0 || this.softPlayerNear(360, now)) break;
                let close = 0, gx = 0, gy = 0;
                for (const t of botWorldScan().tanks) {
                    const r = this.rootOf(t);
                    if (r === body || r.team === body.team || !this.isEnemy(r)) continue;
                    if ((r.x - body.x) ** 2 + (r.y - body.y) ** 2 < 300 * 300) { close++; gx += r.x; gy += r.y; }
                }
                // a thrown blast: on them (led a little) mid-fight, into the
                // middle of a crowd, between us when running so both sides
                // fly apart
                const pinned = fight && dist < 320 + (enemy.realSize || 0);
                if (fleeing && dist < 300) { at = { x: (body.x + enemy.x) / 2, y: (body.y + enemy.y) / 2 }; chance = safe; }
                else if (close >= 2) { at = { x: gx / close, y: gy / close }; chance = hot; }
                else if (fight && dist < 540 && (pinned || dist > 200)) {
                    const v = enemy.velocity || { x: 0, y: 0 };
                    const lead = Math.min(18, dist / 30);
                    at = { x: enemy.x + v.x * lead, y: enemy.y + v.y * lead };
                    chance = hot;
                }
                break;
            }
            case 'grapple':
                // hook onto them to close in (a fleeing carrier above all), or
                // onto rock on the way out
                if (fight && heat > 0 && dist > 260 && dist < 640) { at = enemy; chance = chasing ? hot : 0.8 * hot; }
                else if (fleeing && away && dist < 600) { at = away; chance = safe; }
                break;
            case 'pad': {
                // placed just ahead along where we want to go, aimed that way;
                // the bot drives over it and gets flung
                let to = null;
                if (fight && heat > 0) {
                    if (dist > this.weaponRange() * 0.75) to = enemy;
                    else {
                        // close in already: fling past them sideways to flank
                        const dx = enemy.x - body.x, dy = enemy.y - body.y, d = Math.hypot(dx, dy) || 1;
                        const side = Math.random() < 0.5 ? 1 : -1;
                        to = { x: body.x - dy / d * 300 * side + dx / d * 120, y: body.y + dx / d * 300 * side + dy / d * 120 };
                    }
                    chance = hot;
                } else if (fleeing && away && dist < 600) { to = away; chance = safe; }
                if (to) {
                    const dx = to.x - body.x, dy = to.y - body.y, d = Math.hypot(dx, dy) || 1;
                    const ahead = Math.min(110, d * 0.5);
                    at = { x: body.x + dx / d * ahead, y: body.y + dy / d * ahead, aimX: dx / d, aimY: dy / d };
                }
                break;
            }
            case 'wall':
                // a wall halfway to whoever is shooting at us
                if (enemy && dist > 180 && dist < 750 && (fleeing || (fight && (hit || health < 0.6)))) {
                    const dx = enemy.x - body.x, dy = enemy.y - body.y, d = Math.hypot(dx, dy) || 1;
                    const mid = Math.max(140, Math.min(d * 0.45, 600));
                    at = { x: body.x + dx / d * mid, y: body.y + dy / d * mid };
                    chance = fleeing ? safe : hot;
                }
                break;
            case 'rush':
                if (fight && heat > 0 && health > 0.45 && dist < this.weaponRange() * 1.1) { at = body; chance = hot; }
                break;
            case 'radar':
                if ((!enemy || dist > 1600) && (kind === 'explore' || kind === 'mine' || kind === 'collect')) { at = body; chance = 0.3; }
                // mid-fight: see who else is coming
                else if (fight && heat > 0) { at = body; chance = 0.6 * hot; }
                break;
            case 'burrow': {
                // through rock to safety, or through rock at them
                if (fleeing && away && dist < 650) { at = away; chance = safe; break; }
                if (!(fight && heat > 0 && dist < 700)) break;
                const rock = this.firstRockAlong(enemy);
                if (rock && this.distanceTo({ x: rock.wx, y: rock.wy }) < dist - 60) { at = { x: enemy.x, y: enemy.y }; chance = hot; }
                else if (health < 0.6) {
                    // hurt: dive into the nearest wall, away from them
                    at = { x: body.x * 2 - enemy.x, y: body.y * 2 - enemy.y }; chance = hot;
                }
                break;
            }
        }
        if (!at || Math.random() > chance) return;
        if (!tactics.abUse(body, at.x, at.y, id)) return;
        body.botAbilityAt = now;
        body.botAbilityN = (body.botAbilityN | 0) + 1;
        // smoke breaks on the first shot: hold the trigger while it covers us
        if (id === 'smoke') this.holdFireUntil = now + tactics.smokeHoldMs();
        if (id === 'burrow') { this.burrowGoUntil = now + 1500; this.burrowTo = { x: at.x, y: at.y }; }
        // run over our own pad (and a little past it)
        if (id === 'pad') { this.burrowGoUntil = now + 900; this.burrowTo = { x: at.x + at.aimX * 80, y: at.y + at.aimY * 80 }; }
    }

    structurePoint(target, now) {
        const clearance = this.structureClearance(target);
        if (this.isRammer()) return target;
        const slot = this.body._botPushSlot ?? 0;
        const size = this.body._botPushSize || 1;
        const offset = slot - (size - 1) / 2;
        const jitter = this.body.botSlotJitter ?? (this.body.botSlotJitter = ran.gauss(0, 22));
        const radius = clearance + Math.min(this.desiredRange(), this.weaponRange() * 0.55) + Math.abs(offset) * 26 + jitter;
        return this.orbitPoint(`s${target.id}:${target.name || ''}`, target, radius, now, offset * (0.5 + ((this.body.id % 7) - 3) * 0.04));
    }

    // The rock in the straight line toward the human a regrouping teammate
    // is walking to (within digging reach), cached briefly.
    regroupRock(goal) {
        const now = Date.now();
        if (now - (goal.rockAt || 0) < 300) return goal.rock && goal.rock.alive ? goal.rock : null;
        goal.rockAt = now;
        const body = this.body, m = goal.aim || goal.mate;
        const dx = m.x - body.x, dy = m.y - body.y, d = Math.hypot(dx, dy) || 1;
        const reach = Math.min(d, Math.max(420, this.weaponRange() * 1.2));
        goal.rock = this.firstRockAlong({ x: body.x + dx / d * reach, y: body.y + dy / d * reach });
        return goal.rock && goal.rock.alive ? goal.rock : null;
    }

    // The next point on a planned route to `to` (replanned every ~2 s), or
    // null when there is no route worth following. A* over REGROUP_CELL
    // cells: open ground costs 1, rock REGROUP_ROCK_COST (dug through), the
    // map edge, enemy bases and structures are walls.
    regroupWaypoint(goal, to, now) {
        const body = this.body;
        if (!goal.path || now >= (goal.planAt || 0)) {
            goal.planAt = now + 2000;
            goal.path = planRoute(body, to, this.nav) || null;
            goal.pi = 0;
        }
        const path = goal.path;
        if (!path || !path.length) return null;
        while (goal.pi < path.length - 1 && Math.hypot(path[goal.pi].x - body.x, path[goal.pi].y - body.y) < 110) goal.pi++;
        return path[goal.pi];
    }

    // The rock a bullet reaches first is the rock this tank is really mining.
    firstRockAlong(target) {
        const tg = global.gameManager && global.gameManager.terrainGrid;
        if (!tg || !tg.pointInRock) return null;
        const body = this.body;
        const dx = target.x - body.x, dy = target.y - body.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 1) return null;
        const steps = Math.min(24, Math.max(3, Math.round(distance / 22)));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const rock = tg.pointInRock(body.x + dx * t, body.y + dy * t);
            if (rock) return rock;
        }
        return null;
    }

    minePoint(rock, now) {
        if (this.isRammer()) return { x: rock.wx, y: rock.wy };
        const key = `r${rock.k}`;
        if (!this.minePlan || this.minePlan.key !== key) {
            this.minePlan = {
                key, at: now,
                phase: Math.atan2(this.body.y - rock.wy, this.body.x - rock.wx),
                rate: (0.00008 + Math.random() * 0.00014) * (ran.chance(0.5) ? 1 : -1),
            };
        }
        // stand off comfortably, but never beyond the guns' range
        const rockR = rock.maxPolyRadius || 60;
        const hullMin = rockR + this.nav.radius() + 30;
        const standoff = Math.max(120, rockR + this.nav.radius() + 55);
        const radius = Math.min(standoff, Math.max(hullMin, this.weaponRange() * 0.6 + rockR));
        const angle = this.minePlan.phase + (now - this.minePlan.at) * this.minePlan.rate;
        // Rocks cluster: if the orbit slot lands inside a neighbour, walk
        // around the ring until open ground (otherwise the hull jams on it).
        const tg = global.gameManager && global.gameManager.terrainGrid;
        const stride = this.minePlan.rate >= 0 ? 0.55 : -0.55;
        for (let i = 0; i < 6; i++) {
            const a = angle + i * stride;
            const x = rock.wx + Math.cos(a) * radius, y = rock.wy + Math.sin(a) * radius;
            if (!tg?.pointInRock || !tg.pointInRock(x, y)) return { x, y };
        }
        return { x: rock.wx + Math.cos(angle) * radius, y: rock.wy + Math.sin(angle) * radius };
    }

    // Weapons are resolved separately from movement so a bot on any errand
    // still shoots back at whatever is shooting it.
    weapon(now) {
        const body = this.body, goal = this.goal;
        // Idle cursor: a slow random walk around the direction of travel,
        // with an occasional glance at a gem, rock, far tank or nothing.
        const drift = this.idleDrift || (this.idleDrift = { off: 0, at: now, glance: null, nextGlance: now + 1500 + Math.random() * 3000 });
        const dt = Math.min(200, now - drift.at); drift.at = now;
        drift.off = util.clamp(drift.off * (1 - 0.0015 * dt) + ran.gauss(0, 0.012 * Math.sqrt(dt)), -0.9, 0.9);
        if (now > drift.nextGlance) {
            const v = this.view, pts = [];
            if (v.gem) pts.push(v.gem);
            if (v.rock) pts.push({ x: v.rock.wx, y: v.rock.wy });
            if (v.enemy && v.enemyDistance < 1800) pts.push(v.enemy);
            const pick = pts.length && ran.chance(0.75) ? pts[(Math.random() * pts.length) | 0] : null;
            const ang = pick ? Math.atan2(pick.y - body.y, pick.x - body.x) : this.nav.heading + ran.gauss(0, 1.2);
            drift.glance = { ang, until: now + 350 + Math.random() * 700, dist: 90 + Math.random() * 220 };
            drift.nextGlance = now + 2000 + Math.random() * 4500;
        }
        const glancing = drift.glance && now < drift.glance.until;
        const wander = glancing ? drift.glance.ang : this.nav.heading + drift.off;
        const reach = glancing ? drift.glance.dist : 120;
        // lazy: aimVector advances the aim spring, so call it at most once a tick
        const forward = () => this.aimVector(Math.cos(wander) * reach, Math.sin(wander) * reach, now);
        if (this.isRammer()) {
            const target = goal.kind === 'fight' && goal.target ? goal.target
                : goal.kind === 'mine' && goal.rock ? { x: goal.rock.wx, y: goal.rock.wy } : null;
            return { target: target ? { x: target.x - body.x, y: target.y - body.y } : forward(), fire: false };
        }
        if (goal.kind === 'aoshoot' && goal.target && !goal.target.isDead?.() && now - (body._lastDamageAt || 0) > 2500 &&
            this.distanceTo(goal.target) < this.weaponRange() + (goal.r || 100) * 0.8) {
            if (this.clearShot(goal.target))
                return { target: this.aimVector(goal.target.x - body.x, goal.target.y - body.y, now), fire: true };
            const rock = this.firstRockAlong(goal.target);
            if (rock && rock.alive)
                return { target: this.aimVector(rock.wx - body.x, rock.wy - body.y, now), fire: true };
        }
        const enemy = this.view.enemy;
        // Any enemy inside weapon range gets shot at; etiquette (mercy,
        // dogpile caps, chase break-offs) only governs pursuit. A new target
        // first waits out a reaction time (by skill and the target's difficulty).
        const noticed = now - (this._enemySeenAt || 0) >= (this.reactionMs || 250);
        // ducked behind cover: keep the aim on them, finger off the trigger
        const hiding = this.cover && !this.cover.peek && this.cover.target === enemy;
        if (enemy && noticed && this.view.enemyDistance < this.weaponRange() && tactics.smoked(enemy))
            return { target: this.blindAim(enemy, now), fire: !hiding && this.triggerHeld(now, enemy) };
        if (enemy && noticed && this.view.enemyDistance < this.weaponRange() && this.clearShot(enemy))
            return { target: this.leadAim(enemy, now), fire: !hiding && this.triggerHeld(now, enemy) };
        if (goal.kind === 'fight' && goal.target && this.distanceTo(goal.target) < this.weaponRange()) {
            // Shoot the target only with a clear line; if a rock blocks it,
            // dig through the rock.
            if (this.clearShot(goal.target))
                return { target: this.leadAim(goal.target, now), fire: this.triggerHeld(now, goal.target) };
            const rock = this.firstRockAlong(goal.target);
            if (rock && rock.alive)
                return { target: this.aimVector(rock.wx - body.x, rock.wy - body.y, now), fire: true };
        }
        if (goal.kind === 'defend' && goal.target)
            return { target: this.leadAim(goal.target, now), fire: this.triggerHeld(now, goal.target) };
        // regrouping: dig the straight way to the human
        if (goal.kind === 'regroup' && goal.mate) {
            const rock = this.regroupRock(goal);
            if (rock && this.distanceTo({ x: rock.wx, y: rock.wy }) - (rock.maxPolyRadius || 60) < this.weaponRange() * 0.95)
                return { target: this.aimVector(rock.wx - body.x, rock.wy - body.y, now), fire: true };
        }
        // trapped inside a ring: fire outward at the wall
        if (goal.kind === 'objective' && goal.trapped) {
            const ox = body.x - goal.point.x, oy = body.y - goal.point.y;
            const away = Math.hypot(ox, oy) || 1;
            return { target: { x: (ox / away) * 220 || 220, y: (oy / away) * 220 }, fire: true };
        }
        // only open fire once the shells can land
        if (goal.kind === 'objective' && goal.point && this.distanceTo(goal.point) <
            this.structureClearance(goal.point) + this.weaponRange())
            return { target: this.aimVector(goal.point.x - body.x, goal.point.y - body.y, now), fire: true };
        if (goal.kind === 'chest' && goal.target && !goal.target.isDead?.() &&
            this.distanceTo(goal.target) < this.weaponRange() && this.clearShot(goal.target))
            return { target: this.aimVector(goal.target.x - body.x, goal.target.y - body.y, now), fire: true };
        if (goal.kind === 'mine' && goal.rock && goal.rock.alive &&
            this.distanceTo({ x: goal.rock.wx, y: goal.rock.wy }) - (goal.rock.maxPolyRadius || 60) <
                this.weaponRange() * 0.9)
            return { target: this.aimVector(goal.rock.wx - body.x, goal.rock.wy - body.y, now), fire: true };
        // Traveling with nothing to shoot: chew through the rock ahead (digs
        // bots out of the rock mazes around chambers).
        if (now - (this.travelRockAt || 0) > 250) {
            this.travelRockAt = now;
            const probe = Math.min(this.weaponRange() * 0.85, 420);
            this.travelRock = this.firstRockAlong({
                x: body.x + Math.cos(this.nav.heading) * probe,
                y: body.y + Math.sin(this.nav.heading) * probe,
            });
        }
        if (this.travelRock && this.travelRock.alive)
            return { target: this.aimVector(this.travelRock.wx - body.x, this.travelRock.wy - body.y, now), fire: true };
        return { target: forward(), fire: false };
    }

    sicChildren(now, weapon) {
        const body = this.body;
        if (body.botDroneSteer || !weapon || !weapon.fire || !weapon.target) return;
        const v = this.view, g = this.goal, reach = this.weaponRange() * 1.3;
        let foe = v && v.enemy && v.enemyDistance < reach ? v.enemy : null;
        if (!foe && g && (g.kind === 'fight' || g.kind === 'defend') && g.target && !(g.target.isDead && g.target.isDead()) &&
            this.distanceTo(g.target) < reach) foe = g.target;
        if (!foe) return;
        const tx = weapon.target.x, ty = weapon.target.y;
        const at = Math.atan2(ty, tx), to = Math.atan2(foe.y - body.y, foe.x - body.x);
        const onFoe = Math.abs(util.angleDifference(at, to)) < 0.6;
        const s = body.botSic || (body.botSic = { e: null, x: 0, y: 0, until: 0 });
        s.e = onFoe ? foe : null;
        s.x = body.x + tx; s.y = body.y + ty;
        s.until = now + 500;
    }

    // Keys are on or off: a change of plan is a beat with the keys up, not
    // part throttle.
    tempo(now) {
        return now < (this.hesitateUntil || 0) ? 0 : 1;
    }

    act(now) {
        const body = this.body, goal = this.goal;
        let destination = null, arrive = 60, contact = false;
        switch (goal.kind) {
            case 'survive':
                // Lock-on: a shooter right behind us, a rock right here: duck
                // behind it for a few seconds before running.
                if (this.view.enemy && this.view.enemyDistance < 650 && this.view.enemy.isPlayer &&
                    tactics.isEnabled() && !botSoft(this.view.enemy, now) &&
                    botDiff.lockShare(botDiff.of(this.view.enemy, now)) > 0) {
                    const health = body.health.max ? body.health.amount / body.health.max : 1;
                    const cover = this.coverPoint(this.view.enemy, now, health, true);
                    if (cover) { destination = cover; arrive = 20; break; }
                    // no rock to hide behind and they are right on us: dash out
                    if (this.view.enemyDistance < 450)
                        this.botDash(now, goal.point.x - body.x, goal.point.y - body.y, 0.05);
                }
                // Circle the safe spot while healing rather than parking on
                // it; weave on the way out while the shooter is close.
                destination = this.distanceTo(goal.point) < 280
                    ? this.orbitPoint('sv', goal.point, 180, now)
                    : this.view.enemy && this.view.enemyDistance < 1100
                        ? this.weavePoint(goal.point, now, 1)
                        : goal.point;
                arrive = 40;
                break;
            case 'bank': {
                const vault = this.ownVault();
                if (!vault) break;
                // a protected player is heading in (or we were just kicked off): wait outside the
                if (Config.dig_royale && !body.vaultOnPad && fairPlay.on('vault') &&
                    (((body._padReentryUntil || 0) > now && body._padReentryPad === vault) ||
                     !fairPlay.vaultFreeFor(body, vault, botWorldScan().tanks.filter(e => e.isPlayer && e._fpProtect), now))) {
                    destination = fairPlay.outsideVaults({ x: vault.x + (body.x - vault.x) * 0.01, y: vault.y + (body.y - vault.y) * 0.01 });
                    arrive = 80;
                    break;
                }
                if (body.vaultOnPad) {
                    if (!body.vaultDeposit && (body.carriedGems || 0) >= 15) {
                        digWarsVault.depositFor(body, body.carriedGems);
                        body._lastBankAt = now;
                    }
                    break;
                }
                destination = vault;
                arrive = 28;
                break;
            }
            case 'fight':
                destination = this.combatPoint(goal.target, now);
                arrive = this.isRammer() ? 0 : 45;
                contact = this.isRammer();
                break;
            case 'chest':
                if (goal.target) goal.target._botClaim = { id: body.id, until: now + 3000 };
                destination = this.isRammer() ? goal.target : this.orbitPoint('c' + goal.target.id, goal.target, 210, now, 0, 1.2);
                arrive = this.isRammer() ? 0 : 40;
                contact = this.isRammer();
                break;
            case 'collect':
                destination = goal.gem;
                arrive = 0;
                break;
            case 'aoshoot': {
                const r = (goal.r || 100) + Math.max(240, Math.min(480, this.weaponRange() * 0.7));
                destination = this.orbitPoint('ao' + goal.target.id, goal.target, r, now, 0, 0.8);
                arrive = 45;
                break;
            }
            case 'aogo':
                destination = goal.point;
                arrive = goal.arrive || 150;
                break;
            case 'defend':
                destination = goal.target && this.clearShot(goal.target)
                    ? this.combatPoint(goal.target, now) : goal.point;
                arrive = 70;
                break;
            case 'objective':
                // Trapped inside a ring: hold near the middle while shooting
                // the exit, instead of grinding the hull on the wall.
                if (goal.trapped) {
                    if (this.isRammer()) {
                        // no guns: press against the ring and grind it down
                        const ox = body.x - goal.point.x, oy = body.y - goal.point.y;
                        const away = Math.hypot(ox, oy) || 1;
                        destination = { x: body.x + (ox / away) * 300 || body.x + 300, y: body.y + (oy / away) * 300 };
                        arrive = 0;
                        contact = true;
                    } else {
                        destination = { x: goal.point.x, y: goal.point.y };
                        arrive = 40;
                    }
                    break;
                }
                destination = this.structurePoint(goal.point, now);
                arrive = this.isRammer() ? 0 : 36;
                contact = this.isRammer();
                break;
            case 'mine':
                if (!this.isRammer() && now - (this.aimCheckAt || 0) > 300) {
                    this.aimCheckAt = now;
                    const hit = this.firstRockAlong({ x: goal.rock.wx, y: goal.rock.wy });
                    if (hit && hit !== goal.rock && hit.alive) {
                        goal.rock = hit;
                        this.mineHealth = hit.health;
                        this.mineProgressAt = now;
                        this.minePlan = null;
                    }
                }
                destination = this.minePoint(goal.rock, now);
                arrive = this.isRammer() ? 0 : 30;
                contact = this.isRammer();
                break;
            case 'rally':
                destination = goal.point;
                arrive = 200;
                break;
            case 'regroup': {
                // to the near side of the human, not onto them
                const m = goal.mate;
                const dx = body.x - m.x, dy = body.y - m.y, d = Math.hypot(dx, dy) || 1;
                destination = { x: m.x + dx / d * 230, y: m.y + dy / d * 230 };
                arrive = 120;
                // far off, follow a coarse route through the rock maze
                const wp = d > 520 ? this.regroupWaypoint(goal, destination, now) : null;
                if (wp) { destination = wp; arrive = 50; }
                goal.aim = destination;
                // No ground made for a few seconds and rock in the straight
                // line: stand off from it and dig through (weapon() fires at it).
                if (goal.best == null || d < goal.best - 40) { goal.best = d; goal.bestAt = now; }
                const rock = this.regroupRock(goal);
                if (rock && (now - (goal.bestAt || now) > 2200 || (wp && wp.rock))) {
                    const rx = rock.wx - body.x, ry = rock.wy - body.y, rd = Math.hypot(rx, ry) || 1;
                    const stand = Math.max(0, rd - (rock.maxPolyRadius || 60) - this.weaponRange() * 0.5);
                    destination = { x: body.x + rx / rd * stand, y: body.y + ry / rd * stand };
                    arrive = 30;
                }
                if (process.env.ROYALE_DEBUG) body._regroupDbg = { wp: wp ? [Math.round(wp.x), Math.round(wp.y), wp.rock ? 1 : 0] : null, n: goal.path ? goal.path.length : -1, pi: goal.pi | 0, rock: !!rock, dest: [Math.round(destination.x), Math.round(destination.y)] };
                break;
            }
            case 'explore':
                destination = goal.point;
                arrive = 150;
                break;
        }
        const movement = destination ? this.nav.steer(destination, arrive, now, contact) : null;
        const weapon = this.weapon(now);
        this.sicChildren(now, weapon);
        return {
            goal: movement ? { x: movement.x, y: movement.y } : { x: body.x, y: body.y },
            power: movement ? (movement.power ?? 1) * this.tempo(now) : 0,
            target: weapon.target,
            fire: weapon.fire,
            // main must stay false: auto-turret IOs treat input.main as "the
            // pilot is aiming, follow their cursor", and bots fire nearly
            // constantly, so main:true would disable their autos
            main: !!(body.botDroneSteer && weapon.fire),
            alt: false,
        };
    }

    think(input) {
        const out = this.thinkInner(input);
        const body = this.body, now = Date.now();
        if (!out || !out.goal || body.royaleFrozen) return out;
        // Occasional brief distraction, only when calm (no enemy near,
        // nothing urgent).
        const kind = this.goal && this.goal.kind;
        const calm = this.view.enemyDistance > 1300 && kind !== 'survive' && kind !== 'fight' && kind !== 'defend';
        if (!this.distractAt) this.distractAt = now + 15000 + Math.random() * 40000;
        if (calm && now > this.distractAt) {
            this.distractUntil = now + 450 + Math.random() * 1300;
            this.distractAt = now + 25000 + Math.random() * 60000;
        }
        if (now < (this.distractUntil || 0)) {
            if (!calm) this.distractUntil = 0;
            else out.goal = { x: body.x, y: body.y }, out.power = 0;
        }
        // a shot about to land: sidestep it (keys, like anyone would)
        const dodge = !calm && kind !== 'bank' ? this.dodgeVector(now) : null;
        if (dodge) { out.goal = { x: body.x + dodge.ax * 200, y: body.y + dodge.ay * 200 }; out.power = 1; }
        // the secondary ability; smoke holds the trigger, burrow drives straight
        this.useAbilities(now);
        if (now < (this.holdFireUntil || 0)) out.fire = false;
        if (now < (this.burrowGoUntil || 0) && this.burrowTo) { out.goal = { x: this.burrowTo.x, y: this.burrowTo.y }; out.power = 1; }
        return this.keys.apply(out, now, now < this.nav.escapeUntil || kind === 'survive' || !!dodge);
    }

    thinkInner(input) {
        const body = this.body, now = Date.now();
        if (!body.isBot || body.type !== 'tank') return {};
        if (body.royaleFrozen) {
            return { goal: { x: body.x, y: body.y }, fire: false, main: false, alt: false };
        }
        if (body.royaleLobby) {
            const plaza = (Config.dig_royale && require('../game/gamemodes/scripts/dig_royale.js').lobbyPos)
                ? require('../game/gamemodes/scripts/dig_royale.js').lobbyPos()
                : { x: 0, y: 0, r: 280 };
            if (!this._lobbyUntil || now > this._lobbyUntil) {
                this._lobbyIdle = Math.random() < 0.4;
                const r = (plaza.r || 280) * 0.55;
                this._lobbyGoal = {
                    x: plaza.x + (Math.random() - 0.5) * r * 2,
                    y: plaza.y + (Math.random() - 0.5) * r * 2,
                };
                this._lobbyUntil = now + 700 + Math.random() * 2200;
            }
            if (this._lobbyIdle) {
                return { goal: { x: body.x, y: body.y }, fire: false, main: false, alt: false };
            }
            return {
                goal: this._lobbyGoal,
                target: { x: this._lobbyGoal.x - body.x, y: this._lobbyGoal.y - body.y },
                fire: false, main: false, alt: false,
            };
        }
        // a bot replying in chat stops for a beat
        if (body._chatPending || (body._chatPauseUntil || 0) > now) {
            this.nav.samples.length = 0;
            return { goal: { x: body.x, y: body.y }, target: { x: 0, y: 0 }, fire: false, main: false, alt: false };
        }
        // bots never override their auto turrets' own targeting
        body.autoOverride = false;
        this.sense(now);
        // After a kill, unless something hostile is close: a beat of
        // stillness with guns quiet; the cursor drifts to the nearest gem (or
        // nowhere in particular) and the tank eases half a step back.
        if ((body._victoryEmoteUntil || 0) > now && this.view.enemyDistance > 500) {
            if (!this.emote || this.emote.until !== body._victoryEmoteUntil) {
                const cur = Math.atan2(body.control.target?.y || 0, body.control.target?.x || 1);
                const gem = this.view.gem;
                const look = gem ? Math.atan2(gem.y - body.y, gem.x - body.x) : cur + ran.gauss(0, 0.9);
                this.emote = {
                    until: body._victoryEmoteUntil, look,
                    backX: body.x - Math.cos(this.nav.heading) * 70, backY: body.y - Math.sin(this.nav.heading) * 70,
                    step: ran.chance(0.6),
                };
                this.aimAngle = cur; this.aimVel = 0;
            }
            this.nav.samples.length = 0;
            const aim = this.aimVector(Math.cos(this.emote.look) * 120, Math.sin(this.emote.look) * 120, now, 0.35);
            return {
                goal: this.emote.step ? { x: this.emote.backX, y: this.emote.backY } : { x: body.x, y: body.y },
                power: 0.35,
                target: aim,
                fire: false, main: false, alt: false,
            };
        }
        this.decide(now);
        if (!this.goal) return {};
        body._digWarsGoal = this.goal.kind;
        return this.act(now);
    }
}

// ── bot cost profile (read by the slow-tick log in index.js) ──────────
global.botProf = global.botProf || {};
// BOT_PROF_ALL=1 times every bot-brain method (profiling only)
const _botProfAll = process.env.BOT_PROF_ALL ? [
    [BotNav.prototype, Object.getOwnPropertyNames(BotNav.prototype).filter(k => k !== "constructor")],
    [io_digWarsGoals.prototype, Object.getOwnPropertyNames(io_digWarsGoals.prototype).filter(k => k !== "constructor")],
] : null;
// (by default only the whole think: wrapping the hot little probes cost a
// pair of performance.now() calls each, thousands of times a tick)
for (const [proto, names] of _botProfAll || [[io_digWarsGoals.prototype, ["think"]]]) {
    for (const n of names) {
        const orig = proto[n];
        if (typeof orig !== "function") continue;
        proto[n] = function (...a) {
            const t0 = performance.now();
            const r = orig.apply(this, a);
            const p = global.botProf || (global.botProf = {});
            p[n] = (p[n] || 0) + (performance.now() - t0);
            return r;
        };
    }
}

// Drones stay within DRONE_LEASH of their tank: a goal past it (the cursor on
// a zoomed-out screen, a repel, a far target) is pulled onto the leash circle.
const DRONE_LEASH = 1600;
class io_droneLeash extends IO {
    think(input) {
        const home = this.body.master && this.body.master.master;
        const g = input.goal;
        if (!home || home === this.body || !g) return;
        const gx = g.x - home.x, gy = g.y - home.y, gl = Math.hypot(gx, gy);
        if (gl <= DRONE_LEASH) return;
        return { goal: { x: home.x + gx / gl * DRONE_LEASH, y: home.y + gy / gl * DRONE_LEASH }, power: 1 };
    }
}

// Dig Wars: lets a player-controlled tank mine nearby rock when its pilot is
// not aiming. Bots skip this; their goal controller owns mining.
class io_minesRocks extends IO {
    constructor(body) {
        super(body);
        this.acceptsFromTop = false;
        this.tick = ran.irandom(8);
        this.rock = null;
        this.nextRockAt = 0;
    }
    think(input) {
        if (this.body.type !== 'tank' || this.body.isBot) return {};
        if (input.main || input.alt || input.target != null) return {};
        if (this.body.master.autoOverride) return {};
        const tg = global.gameManager && global.gameManager.terrainGrid;
        if (!tg || !tg._voronoiMap) return {};
        const now = Date.now();
        if (now < this.nextRockAt) return {};
        if (this.rock && !this.rock.alive) {
            this.rock = null;
            this.nextRockAt = now + 900 + Math.random() * 900;
            return {};
        }
        if (++this.tick >= 8 || !this.rock) {
            this.tick = 0;
            this.rock = tg.nearestRock(this.body.x, this.body.y, 420);
        }
        if (!this.rock || !this.rock.alive) return {};
        return {
            target: { x: this.rock.wx - this.body.x, y: this.rock.wy - this.body.y },
            goal: { x: this.rock.wx, y: this.rock.wy },
            fire: true,
            power: 1,
        };
    }
}

// Tutorial duelist: circles the learner at duelling range and shoots at
// them. Unlike io_digWarsGoals it never mines, banks or wanders, so it stays
// inside the view cull (vertical cull is about 1125 units).
class io_tutorialDuelist extends IO {
    constructor(body) {
        super(body);
        this.acceptsFromTop = false;
        // orbit radius, well inside the vertical cull
        this.range = 430;
        this.phase = Math.random() * Math.PI * 2;
        this.spin = Math.random() < 0.5 ? 1 : -1;
        this.turnAt = 0;
    }
    think() {
        const foe = this.body.tutorialFoe;
        if (!foe || foe.isGhost || (foe.isDead && foe.isDead())) {
            return { goal: { x: this.body.x, y: this.body.y }, fire: false, main: false };
        }
        const now = Date.now();
        // reverse the orbit occasionally so it is not a fixed circle
        if (now > this.turnAt) {
            this.turnAt = now + 2600 + Math.random() * 2600;
            this.spin = -this.spin;
        }
        const dx = foe.x - this.body.x, dy = foe.y - this.body.y;
        const dist = Math.hypot(dx, dy) || 1;
        const toFoe = Math.atan2(dy, dx);

        // Orbit angle: swing wide of the straight line by an amount that grows
        // as we close, so it spirals in to `range` and then circles.
        const closing = Math.max(-1, Math.min(1, (dist - this.range) / this.range));
        const lead = toFoe + this.spin * (1 - Math.abs(closing)) * 1.15;
        const step = Math.max(140, Math.min(dist, 520));
        const goal = {
            x: this.body.x + Math.cos(lead) * step,
            y: this.body.y + Math.sin(lead) * step,
        };
        // too far away: drop the orbit and come straight back
        if (dist > this.range * 2.4) { goal.x = foe.x; goal.y = foe.y; }

        return {
            target: { x: dx, y: dy },
            goal,
            fire: true,
            main: true,
            power: 1,
        };
    }
}

// No-op kept so existing CONTROLLERS lists stay valid; the goal controller
// owns unsticking.
class io_unstick extends IO {
    think() { return {}; }
}

// Raid boss movement. nearestDifferentMaster (earlier in the chain) supplies
// a target while a victim is in view; this closes to a preferred range, backs
// off when crowded, strafes otherwise. With no victim it roams the safe zone.
// bosses.js (vault no-loiter ring), or null in a test without it
function bossVaults() {
    if (!Config.dig_royale || Config.tutorial) return null;
    try { return require('../game/terrain/bosses.js'); } catch { return null; }
}
class io_royaleBoss extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.opts = opts;
        this.nav = new BotNav(body);
        this.roam = null;
        this.roamAt = 0;
        this.turn = ran.chance(0.5) ? 1 : -1;
        this.turnAt = 0;
        this.range = opts.range || 300;
    }
    pickRoam(now) {
        const body = this.body;
        const tg = global.gameManager && global.gameManager.terrainGrid;
        let cx = 0, cy = 0, r = 1200;
        if (body.bossHome) {
            cx = body.bossHome.x; cy = body.bossHome.y; r = body.bossHome.r || 300;
        } else try {
            const st = require('../game/terrain/storm.js').snapshot(now);
            cx = st.cx || 0; cy = st.cy || 0; r = Math.max(300, (st.r || 1200) * 0.6);
        } catch { /* */ }
        this.roam = null;
        const bossMod = bossVaults();
        for (let i = 0; i < 16; i++) {
            const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
            const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
            if (tg && tg.pointInRock && tg.pointInRock(x, y) && !body.bossDigs) continue;
            // round 10: no roaming around a vault (the tutorial's home roam aside)
            if (bossMod && !body.bossHome && bossMod.nearVault(x, y)) continue;
            this.roam = { x, y };
            break;
        }
        if (!this.roam) this.roam = bossMod && !body.bossHome ? bossMod.clearOfVaults({ x: cx, y: cy }) : { x: cx, y: cy };
        this.roamAt = now + 9000 + Math.random() * 6000;
        this.nav.arrived = false;
    }
    think(input) {
        const body = this.body, now = Date.now();
        if (body.royaleFrozen) return { goal: { x: body.x, y: body.y }, power: 0 };
        // the storm hurts bosses too: get back inside first
        if (!body.bossHome) {
            try {
                const storm = require('../game/terrain/storm.js');
                if (storm.inStorm(body.x, body.y)) {
                    const f = require('../game/gamemodes/scripts/dig_royale.js').stormFleePoint(body);
                    if (f) { this.roam = null; return { goal: f, power: 1, target: body.facingType === 'spin' ? undefined : { x: f.x - body.x, y: f.y - body.y } }; }
                }
            } catch { /* */ }
        }
        if (now > this.turnAt) {
            this.turnAt = now + 2500 + Math.random() * 3500;
            if (ran.chance(0.35)) this.turn = -this.turn;
        }
        if (input.target && (input.main || input.alt)) {
            const tx = body.x + input.target.x, ty = body.y + input.target.y;
            const d = Math.hypot(input.target.x, input.target.y) || 1;
            const want = this.range;
            let dest;
            if (body.bossContact || d > want * 1.2) dest = { x: tx, y: ty };
            else if (d < want * 0.6) dest = { x: body.x - input.target.x / d * 160, y: body.y - input.target.y / d * 160 };
            else {
                const a = Math.atan2(body.y - ty, body.x - tx) + this.turn * 0.55;
                dest = { x: tx + Math.cos(a) * want, y: ty + Math.sin(a) * want };
            }
            this.roamAt = 0;
            // round 10: a target on or by a vault is chased only to the ring's edge
            const bm = bossVaults();
            if (bm && !body.bossHome) dest = bm.clearOfVaults(dest);
            if (body.bossDigs) return { goal: dest, power: 1 };
            const st = this.nav.steer(dest, 40, now, !!body.bossContact);
            return st ? { goal: { x: st.x, y: st.y }, power: st.power } : { goal: { x: body.x, y: body.y }, power: 0 };
        }
        if (!this.roam || now > this.roamAt || this.nav.arrived) this.pickRoam(now);
        else if (!body.bossHome) { const bm = bossVaults(); if (bm && bm.nearVault(this.roam.x, this.roam.y)) this.pickRoam(now); }
        if (body.bossDigs) {
            const dd = Math.hypot(this.roam.x - body.x, this.roam.y - body.y);
            if (dd < 90) this.pickRoam(now);
            return { goal: this.roam, power: 0.7, target: body.facingType === 'spin' ? undefined : { x: this.roam.x - body.x, y: this.roam.y - body.y } };
        }
        const st = this.nav.steer(this.roam, 70, now);
        const out = st ? { goal: { x: st.x, y: st.y }, power: Math.min(st.power, 0.7) } : { goal: { x: body.x, y: body.y }, power: 0 };
        if (body.facingType !== 'spin') out.target = { x: this.roam.x - body.x, y: this.roam.y - body.y };
        return out;
    }
}

let ioTypes = {
    //misc
    zoom: io_zoom,
    doNothing: io_doNothing,
    listenToPlayer: io_listenToPlayer,
    alwaysFire: io_alwaysFire,
    mapAltToFire: io_mapAltToFire,
    mapFireToAlt: io_mapFireToAlt,
    whirlwind: io_whirlwind,
    disableOnOverride: io_disableOnOverride,
    scaleWithMaster: io_scaleWithMaster,

    //aiming related
    stackGuns: io_stackGuns,
    nearestDifferentMaster: io_nearestDifferentMaster,
    healTeamMasters: io_healTeamMasters,
    targetSelf: io_targetSelf,
    onlyAcceptInArc: io_onlyAcceptInArc,
    spin: io_spin,
    spin2: io_spin2,

    //movement related
    unstick: io_unstick,
    digWarsGoals: io_digWarsGoals,
    tutorialDuelist: io_tutorialDuelist,
    canRepel: io_canRepel,
    mapTargetToGoal: io_mapTargetToGoal,
    siegeAI: io_siegeAI,
    moveInCircles: io_moveInCircles,
    boomerang: io_boomerang,
    formulaTarget: io_formulaTarget,
    orbit: io_orbit,
    goToMasterTarget: io_goToMasterTarget,
    avoid: io_avoid,
    minion: io_minion,
    snake: io_snake,
    hangOutNearMaster: io_hangOutNearMaster,
    fleeAtLowHealth: io_fleeAtLowHealth,
    wanderAroundMap: io_wanderAroundMap,
    minesRocks: io_minesRocks,
    droneLeash: io_droneLeash,
    royaleBoss: io_royaleBoss,
};

module.exports = {
    sizePenalty, ioTypes, IO, inEnemyBase, raidOpening, openSpared, OPEN_GRACE_MS, OPEN_SHARE, leaderHunt, leaderPull, leaderCap, LEADER_R };
