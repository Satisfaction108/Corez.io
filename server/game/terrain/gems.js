

const { ORE } = require('./terrainGrid.js');

const DEPOSIT_VALUE = {
    [ORE.COPPER]:  15,
    [ORE.VEIN]:    30,
    [ORE.SHARD]:   150,  
    [ORE.EMERALD]: 500,  
};
const SHARD_BIG = 150;  
const ORE_CLASS = {
    [ORE.COPPER]:  'gemPickupCopper',
    [ORE.VEIN]:    'gemPickupVein',
    [ORE.SHARD]:   'gemPickupShard',
    [ORE.EMERALD]: 'gemPickupEmerald',
};

const FACET_CLASS = {
    gemPickupCopper:      'gemFacetCopper',
    gemPickupVein:        'gemFacetVein',
    gemPickupShard:       'gemFacetShard',
    gemPickupShardCore:   'gemFacetShard',
    gemPickupEmerald:     'gemFacetEmerald',
    gemPickupEmeraldCore: 'gemFacetEmerald',
    gemPickupLoot:        'gemFacetLoot',
};

const SATCHEL_CAP  = 4000;

const DEATH_DROP   = 0.85;  

const BANK_DEATH_LOSS = 0.4;
const MAGNET_BONUS = 110;
// A full gem radius of grab slack: at 0.6 a gem sliding past a moving tank
// could stay just outside the touch ring for its whole flyby, which read as
// "the gem passed straight through me".
const PICKUP_SLOP  = 1.0;

const GEM_MAX_SPEED = 6;

function spawnGem(x, y, value, cls, size, vx = 0, vy = 0) {
    const o = new Entity({ x, y });
    o.define(cls);
    o.team = TEAM_ROOM;
    o.isGemPickup = true;
    o.gemValue = value;
    o.coreSize = o.SIZE = size;
    o.velocity.x = vx;
    o.velocity.y = vy;
    
    
    
    o.RANGE = o.range = 5400 + Math.random() * 900;
    o.gemBornAt = Date.now();
    o.refreshBodyAttributes();
    
    const facetCls = FACET_CLASS[cls];
    if (facetCls) {
        const facet = new Prop([10.5, 0, -1.2, 0, 1], o);
        facet.define(facetCls);
        const sparkle = new Prop([4, -2.2, -3.4, 12, 1], o);
        sparkle.define('gemSparkle');
    }
    return o;
}

function spawnOreBurst(rock, breaker) {
    if (!rock.ore) return;
    // BR lobby is pure destruction for fun - no gems until the match starts.
    if (breaker && breaker.royaleLobby) return;
    const cls = ORE_CLASS[rock.ore];
    const deposits = rock.deposits && rock.deposits.length
        ? rock.deposits
        : [{ wx: rock.wx, wy: rock.wy, wr: 9, big: false }];
    for (const d of deposits) {
        
        
        const value = d.big && rock.ore === ORE.SHARD ? SHARD_BIG : DEPOSIT_VALUE[rock.ore];
        const bigCls = rock.ore === ORE.EMERALD ? 'gemPickupEmeraldCore' : 'gemPickupShardCore';
        
        
        const size  = Math.max(6, Math.min(34, d.wr));
        const ang   = breaker && breaker.x !== undefined
            ? Math.atan2(breaker.y - d.wy, breaker.x - d.wx)
            : (Math.atan2(d.wy - rock.wy, d.wx - rock.wx) || Math.random() * Math.PI * 2);
        const gem = spawnGem(d.wx, d.wy, value, d.big ? bigCls : cls, size,
                             Math.cos(ang) * 1.5, Math.sin(ang) * 1.5);
        if (gem && breaker && breaker.id !== undefined) gem.gemSourceId = breaker.id;
        // (The old tutorial ran inside live matches and had to reserve its
        // drops so a passing veteran could not vulture the one pickup a lesson
        // asked for. The tutorial now runs on its own server in an isolated
        // plot, where nobody else can reach the gems, so no reservation.)
    }
}

// `lost` marks the one case where the satchel was emptied by DEATH rather than
// by banking, so the client can play the loss sting for it and nothing else.
// Banking already reports delta 0 (the vault decrements carriedGems itself and
// then re-syncs), so today a negative delta could only be a death - but that is
// an accident of the deposit path, not a contract. The flag says it outright.
function talkGems(body, delta, lost = 0) {
    if (body.socket) {
        body.socket.talk('GEM', body.carriedGems | 0, body.gemCap | 0, delta | 0,
                         (body.socket.gemBanked || 0) | 0, lost | 0);
    }
}

function actorBody(actor) {
    return actor && actor.body ? actor.body : actor;
}

function bankedFor(body) {
    return body.socket ? (body.socket.gemBanked || 0) | 0 : (body.botBanked || 0) | 0;
}

function setBanked(body, amount) {
    amount = Math.max(0, Math.round(amount));
    if (body.socket) body.socket.gemBanked = amount;
    else body.botBanked = amount;
    body.bankedGems = amount;
    return amount;
}

// How far back the pack rides, in hull radii. Just past 1 so it reads as worn
// ON the tank rather than embedded in it - the hull covers its inner edge,
// which is what sells "backpack" instead of "floating gem".
const SATCHEL_OFFSET = 1.02;

// The pack wears the CURRENT team's colour, re-applied whenever the team
// changes rather than baked in when the prop is built.
//
// It has to work this way: sockets.js spawns the body and calls initSatchel()
// BEFORE the gamemode switch assigns body.team, so at construction time every
// player's team is undefined and they all fell through to the blue class -
// which is why a red player carried a blue satchel while bots (whose team IS
// set first) were correct. Re-defining also picks up any later team change for
// free. Prop.define() only touches shape/colour/stroke, never bound, so this is
// safe to call on a live prop.
function applySatchelTeamColor(body) {
    if (body._satchelTeam === body.team) return;
    body._satchelTeam = body.team;
    const kind = body.team === TEAM_RED ? 'gemHoardShard' : 'gemHoardEmerald';
    if (body.gemHoardProp) body.gemHoardProp.define(kind);
    if (body.gemHoardFacetProp) body.gemHoardFacetProp.define(kind + 'Facet');
}

// Entity.define() unconditionally clears body.props, but only re-fires the
// 'define' event (which is what re-attached these) when its emitEvent argument
// is true. armBot() defines with emitEvent=false, so every bot lost its satchel
// the moment it was armed - bots carried gems that nobody could see, while
// players were fine because their defines do emit. Re-attaching at the point of
// use is immune to that: it does not care who cleared the map, or why.
function ensureSatchelProps(body) {
    const p = body.gemHoardProp, f = body.gemHoardFacetProp;
    if (!body.props) return;
    if (p && body.props.get(p.id) !== p) body.props.set(p.id, p);
    if (f && body.props.get(f.id) !== f) body.props.set(f.id, f);
}

// Whole-gem buckets, not a continuous load curve. Banking used to scale the
// pack by leftover dust: empty a satchel and a 0.6 residue still drew the
// minimum bag, bank half a small haul and the curve shrank it until it
// looked gone. These rungs are the only sizes the pack is allowed to be.
const SATCHEL_SIZE_RUNGS = [
    { min: 1,    size: 0.26 },
    { min: 100,  size: 0.32 },
    { min: 400,  size: 0.38 },
    { min: 1000, size: 0.44 },
    { min: 2000, size: 0.50 },
    { min: 3200, size: 0.56 },
];

function satchelVisualSize(carried) {
    if (carried < 1) return 0;
    let size = 0;
    for (const rung of SATCHEL_SIZE_RUNGS) {
        if (carried >= rung.min) size = rung.size;
    }
    return size;
}

function updateSatchel(body) {
    const p = body.gemHoardProp, f = body.gemHoardFacetProp;
    applySatchelTeamColor(body);
    ensureSatchelProps(body);
    if (p) {
        // Truncate, same as the HUD (`carried | 0`). Rounding a banking
        // residue like 0.6 kept a ghost pack on an "empty" tank.
        const carried = (body.carriedGems || 0) | 0;
        const size = satchelVisualSize(carried);
        p.bound.size = size;
        p.bound.offset = size > 0 ? SATCHEL_OFFSET : 0;
        if (f) {
            f.bound.size = size * 0.52;
            f.bound.offset = p.bound.offset;
        }
    }
    body.refreshBodyAttributes();
}

// A turret that finds its own target instead of pointing where the hull does.
// This is the property that actually matters for placing the pack, so it is
// tested directly rather than by trusting a definition flag.
function isAutoTurret(t) {
    return !!(t && t.controllers && t.controllers.some(
        c => c && c.constructor && c.constructor.name === 'io_nearestDifferentMaster'));
}

function autofireOn(body) {
    const cmd = body.socket && body.socket.player && body.socket.player.command;
    // Bots have no command object and never stop shooting, so they count as
    // permanently auto-firing.
    return cmd ? !!cmd.autofire : true;
}

// Where the pack hangs. "Back" is not one thing in this game, because the
// archetypes disagree about what "forward" means:
//
//   rammers        - the hull SPINS, so body.facing is meaningless. Forward is
//                    where they are driving.
//   auto smasher   - a spinning hull with one self-aiming turret. That turret
//                    is the only thing on it that points anywhere, so it is
//                    forward.
//   radial autos   - Auto-3/4/5: spinning hull, several self-aiming weapons.
//                    Auto-firing means the player is aiming with the mouse, so
//                    forward is the aim; otherwise fall back to movement.
//   everything else- including auto assassin / auto gunner, whose bolted-on
//                    turret is a sidearm rather than the tank's nose: forward
//                    is where the player is pointing.
//
// Returns undefined when there is no meaningful answer this frame (a parked
// rammer), so the caller can hold the last good angle instead of snapping.
// Entity.guns / .turrets are Maps, but Prop and Turret hold plain arrays for the
// same fields. Take either rather than assuming one and crashing the tick loop.
function listOf(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v.values === 'function') return [...v.values()];
    return [];
}

function satchelBackAngle(body) {
    const autos = listOf(body.turrets).filter(isAutoTurret);
    const hasOwnGuns = listOf(body.guns).length > 0;
    // IS_SMASHER is the definition flag for a rammer hull; at runtime it only
    // survives as settings.reloadToAcceleration (entity.js maps it there,
    // because for a smasher the reload stat drives acceleration). Indirect, but
    // it is the real marker - and it is what separates a smasher from an
    // Auto-3, which ALSO has no hull guns and would otherwise be mistaken for
    // a rammer.
    const isSmasherHull = !!(body.settings && body.settings.reloadToAcceleration);

    const moveAway = () => {
        const v = body.velocity;
        const sp = v ? Math.hypot(v.x, v.y) : 0;
        // Below a crawl the heading is numerical noise and the pack would
        // jitter around a parked tank.
        if (sp < 0.05) return undefined;
        return Math.atan2(-v.y, -v.x);
    };
    const aimAway = () => {
        const t = body.control && body.control.target;
        if (!t || (!t.x && !t.y)) return body.facing + Math.PI;
        return Math.atan2(-t.y, -t.x);
    };

    if (isSmasherHull) {
        // Auto smasher: the bolted-on turret is the only part of it that points
        // anywhere, so the pack hides behind that.
        if (autos.length) return autos[0].facing + Math.PI;
        return moveAway();
    }
    if (!hasOwnGuns && autos.length >= 2) {
        return autofireOn(body) ? aimAway() : moveAway();
    }
    return aimAway();
}

// Shortest-arc ease, so the pack swings around the hull instead of spinning the
// long way when the angle wraps past PI.
function easeAngle(from, to, k) {
    if (from === undefined || !isFinite(from)) return to;
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return from + d * k;
}

// Called every tick for every tank that can carry. Cheap: bails immediately on
// the (common) empty satchel, since an empty pack is not drawn anyway.
function orientSatchel(body) {
    const p = body.gemHoardProp;
    if (!p || ((body.carriedGems || 0) | 0) < 1) return;
    applySatchelTeamColor(body);
    ensureSatchelProps(body);

    let want = satchelBackAngle(body);
    if (want === undefined) want = body._satchelAngle;
    if (want === undefined) want = body.facing + Math.PI;
    body._satchelAngle = easeAngle(body._satchelAngle, want, 0.22);

    // The client positions a prop at (direction + angle + hullFacing) and - with
    // mirrorMasterAngle on, which is the Prop default - gives it a facing of
    // (hullFacing + angle). Putting the whole rotation into `angle` and leaving
    // `direction` at zero therefore lands BOTH the position and the pack's own
    // tilt on the absolute angle we want, whatever the hull is doing.
    const rel = body._satchelAngle - body.facing;
    p.bound.angle = rel;
    p.bound.direction = 0;
    const f = body.gemHoardFacetProp;
    if (f) { f.bound.angle = rel; f.bound.direction = 0; }
}

function initSatchel(body) {
    body.carriedGems ??= 0;
    body.gemCap = SATCHEL_CAP;
    
    
    body.botBanked ??= 0;
    if (body.socket) body.bankedGems = body.socket.gemBanked = body.socket.gemBanked || 0;
    else body.bankedGems = body.botBanked;
    if (!body.gemHoardProp) {
        
        
        const kind = body.team === TEAM_RED ? 'gemHoardShard' : 'gemHoardEmerald';
        // LAYER 0, not 1. The client draws layer-0 props BEFORE the hull and
        // layer-1 props after it, so 0 is what tucks the pack behind the tank
        // and makes it read as worn rather than stuck on the front.
        const p = new Prop([0, 0, 0, 0, 0], body);
        p.define(kind);
        body.gemHoardProp = p;
        // Created after the pack so it draws after it within the same layer -
        // the lit facet sits on the pack, still behind the hull.
        const f = new Prop([0, 0, -0.06, 0, 0], body);
        f.define(kind + 'Facet');
        body.gemHoardFacetProp = f;
        
        body.on('define', () => {
            if (body.gemHoardProp) body.props.set(body.gemHoardProp.id, body.gemHoardProp);
            if (body.gemHoardFacetProp) body.props.set(body.gemHoardFacetProp.id, body.gemHoardFacetProp);
        });
        body.on('dead', ({ killers } = {}) => dropGemsOnDeath(body, killers));
    }
    updateSatchel(body);
    talkGems(body, 0);
}

function dropGemsOnDeath(body, killers = []) {
    const carried = body.carriedGems | 0;
    const raidMode = !!Config.dig_royale;
    // Keep the bot killers attached to the loot they created. A player can
    // still reclaim the drop, but the bot that earned it should not have to
    // wait through the normal anti-vulture grace period.
    const killerBotIds = killers
        .map(killer => killer && killer.master ? killer.master : killer)
        .filter(killer => killer && killer.isBot && killer.id !== undefined)
        .map(killer => killer.id);
    
    const banked  = bankedFor(body);
    const bankLoss = raidMode ? 0 : Math.floor(banked * BANK_DEATH_LOSS);
    // The death screen shows the wealth you had at the moment you died -
    // carried + banked BEFORE the drop. Snapshot it here because this runs
    // (on 'dead') before the death packet's records() is built.
    if (body.socket) {
        body.socket.gemDeathScore = carried + banked;
        // Snapshot the split too. records() reads body.carriedGems, which this
        // function zeroes a few lines down, so the death screen was always
        // reporting 0 carried. Banked is captured pre-loss so that the three
        // figures still add up: score = carried + banked.
        body.socket.gemDeathCarried = carried;
        body.socket.gemDeathBanked = banked;
    }
    if (carried <= 0 && bankLoss <= 0) return;
    body.carriedGems = 0;
    if (bankLoss > 0) setBanked(body, banked - bankLoss);
    updateSatchel(body);
    talkGems(body, -carried, 1);
    const drop = Math.floor(carried * DEATH_DROP) + bankLoss;
    if (drop <= 0) return;
    
    const n = Math.min(8, Math.max(3, Math.ceil(drop / 150)));
    const values = [];
    let left = drop;
    for (let i = n; i > 1; i--) {
        const v = Math.max(1, Math.round(left / i * (0.7 + Math.random() * 0.6)));
        values.push(Math.min(v, left - (i - 1)));
        left -= values[values.length - 1];
    }
    values.push(left);
    for (const v of values) {
        if (v <= 0) continue;
        const ang = Math.random() * Math.PI * 2;

        const sp  = 1.6 * (0.45 + Math.random() * 0.55);
        const gem = spawnGem(body.x, body.y, v, 'gemPickupLoot',
                 Math.max(6.5, Math.min(15, 4.5 + 1.1 * Math.sqrt(v))),
                 Math.cos(ang) * sp, Math.sin(ang) * sp);
        // A player's death drop is reserved from unrelated bots for a grace
        // window so the player can run back for it. The bot that made the
        // kill gets an immediate claim and can collect its winnings.
        if (gem) {
            gem.gemLootFromPlayer = !!body.socket;
            if (killerBotIds.length) gem.gemLootKillerIds = killerBotIds;
        }
    }
}

function tickGem(gem, tg, players) {
    const now = Date.now();
    const p = tg.pushCircleFromVoronoi(gem, gem.realSize);
    if (p.dx !== 0 || p.dy !== 0) {
        const pl = Math.hypot(p.dx, p.dy);
        const nx = p.dx / pl, ny = p.dy / pl;
        const vDot = gem.velocity.x * nx + gem.velocity.y * ny;
        if (vDot < 0) {
            gem.velocity.x -= vDot * nx;
            gem.velocity.y -= vDot * ny;
        }
    }
    
    
    
    
    if (tg.pointInRock(gem.x, gem.y)) {
        const safeStillOpen = gem.gemSafeX !== undefined && !tg.pointInRock(gem.gemSafeX, gem.gemSafeY);
        if (safeStillOpen) {
            gem.x = gem.gemSafeX;
            gem.y = gem.gemSafeY;
        } else {
            // Rock regrew over the last known open spot, so the gem has no
            // memory to fall back on and used to sit inside the boulder until
            // somebody mined it out. Walk outward for the nearest free ground.
            const now = Date.now();
            if (now - (gem.gemDigOutAt || 0) > 400) {
                gem.gemDigOutAt = now;
                const step = Math.max(18, gem.realSize * 2);
                let freed = false;
                for (let ring = 1; ring <= 6 && !freed; ring++) {
                    for (let i = 0; i < 12; i++) {
                        const a = (i / 12) * Math.PI * 2 + ring * 0.26;
                        const x = gem.x + Math.cos(a) * step * ring;
                        const y = gem.y + Math.sin(a) * step * ring;
                        if (tg.pointInRock(x, y)) continue;
                        gem.x = x; gem.y = y;
                        gem.gemSafeX = x; gem.gemSafeY = y;
                        freed = true;
                        break;
                    }
                }
            }
        }
        gem.velocity.x = 0;
        gem.velocity.y = 0;
    } else {
        gem.gemSafeX = gem.x;
        gem.gemSafeY = gem.y;
    }

    if (!(gem.gemValue > 0)) return;

    // Two separate questions: who is the gem flying toward (one actor, the
    // magnet), and who is actually touching it (anyone). They used to be the
    // same answer, so a gem reserved by a distant miner could not be picked up
    // by the player standing on top of it - it simply passed through them.
    let best = null, bestD = Infinity, bestScore = Infinity;
    let toucher = null, toucherD = Infinity;
    const bias = gem.chamberBias;
    for (const actor of players) {
        const body = actorBody(actor);
        if (!body || body.isDead() || body.isGhost) continue;
        // Unrelated bots keep their hands off a dead player's loot during
        // the reclaim window. The bot that made the kill is explicitly
        // allowed through so it can pick up the gems it earned.
        const isKillerBot = body.isBot &&
            gem.gemLootKillerIds?.includes(body.id);
        if (body.isBot && gem.gemLootFromPlayer && !isKillerBot &&
            now - (gem.gemBornAt || 0) < 15000) continue;
        const dx = body.x - gem.x, dy = body.y - gem.y;
        const d = Math.hypot(dx, dy) || 1;
        // A drop reserved for a tutorial player behaves toward everyone else
        // exactly like loot does around a full satchel: shoved away, never
        // collected. Trapping it or body-blocking it changes nothing.
        if (gem.gemOwnerId !== undefined && body.id !== gem.gemOwnerId) {
            const repR = body.realSize * 1.8 + MAGNET_BONUS * 0.5;
            if (d < repR) {
                const push = (1 - d / repR) * 1.5;
                gem.velocity.x -= (dx / d) * push;
                gem.velocity.y -= (dy / d) * push;
            }
            continue;
        }
        if (bias) {
            
            
            
            
            if (body.team === bias) {
                const repR = body.realSize * 1.8 + MAGNET_BONUS * 0.7;
                if (d < repR) {
                    const push = (1 - d / repR) * 1.5;
                    gem.velocity.x -= (dx / d) * push;
                    gem.velocity.y -= (dy / d) * push;
                }
                continue;
            }
        }
        const full = (body.carriedGems | 0) >= (body.gemCap | 0);
        if (full) {
            // full satchel: a firm bubble that shoves loot out of the way
            const repR = body.realSize * 1.8 + MAGNET_BONUS * 0.5;
            if (d < repR) {
                const push = (1 - d / repR) * 1.5;
                gem.velocity.x -= (dx / d) * push;
                gem.velocity.y -= (dy / d) * push;
            }
            continue;
        }
        const pickR = body.realSize + gem.realSize * PICKUP_SLOP;
        if (d <= pickR && d < toucherD) { toucherD = d; toucher = body; }
        // No ownership: loose gems belong to whoever is closest, full stop.
        // Every "breaker gets a head start" variant ended the same way - a
        // gem fleeing from the player standing on it toward the bot that
        // mined it, which felt like the gem had no collision at all.
        const killerPriority = isKillerBot && now < (body._collectLootUntil || 0) ? 850 : 0;
        if (d - killerPriority < bestScore) {
            bestScore = d - killerPriority;
            bestD = d;
            best = body;
        }
    }

    if (toucher) {
        const v = gem.gemValue;
        gem.gemValue = 0;
        toucher.carriedGems = (toucher.carriedGems | 0) + v;
        updateSatchel(toucher);
        talkGems(toucher, v);
        gem.kill();
        return;
    }

    // hard ceiling: loot never outruns a tank - the shove bubbles above
    
    
    const spNow = Math.hypot(gem.velocity.x, gem.velocity.y);
    if (spNow > GEM_MAX_SPEED) {
        gem.velocity.x *= GEM_MAX_SPEED / spNow;
        gem.velocity.y *= GEM_MAX_SPEED / spNow;
    }
    if (!best) return;

    const magR = (best.realSize * 2.6 + MAGNET_BONUS) * (bias ? 1.45 : 1);
    if (bestD < magR) {
        
        
        const pull  = 1 - bestD / magR;
        const speed = 1.4 * pull + 4 * pull * pull;
        const ux = (best.x - gem.x) / bestD, uy = (best.y - gem.y) / bestD;
        gem.velocity.x += (ux * speed - gem.velocity.x) * 0.25;
        gem.velocity.y += (uy * speed - gem.velocity.y) * 0.25;
        // the crystal leans into the pull: pavilion point easing onto its
        
        
        
        const want = Math.atan2(uy, ux) - Math.PI / 2;
        let turn = want - gem.facing;
        while (turn >  Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        gem.facingType = 'manual';
        gem.facingTypeArgs = { angle: gem.facing + turn * 0.15 };
    } else if (gem.facingType !== 'spin') {
        // out of everyone's reach again - resume the lazy treasure spin
        gem.facingType = 'spin';
        gem.facingTypeArgs = { speed: 0.02 };
    }
}

module.exports = { spawnOreBurst, spawnGem, initSatchel, updateSatchel, orientSatchel, dropGemsOnDeath, tickGem, talkGems, setBanked, SATCHEL_CAP };
