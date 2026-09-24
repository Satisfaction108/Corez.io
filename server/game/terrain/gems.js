

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

let _shopMod = null;
function shopMod() { return _shopMod || (_shopMod = require('./shop.js')); }
// gemdust rides on gems (accounts/game/dustHooks.js); raid only, never throws out of here
let _dustMod = null;
function dustMod() { return _dustMod || (_dustMod = require('../../accounts/game/dustHooks.js')); }

function spawnGem(x, y, value, cls, size, vx = 0, vy = 0, ore = null) {
    const o = new Entity({ x, y });
    o.define(cls);
    o.team = TEAM_ROOM;
    o.isGemPickup = true;
    o.gemValue = value;
    o.gemOre = ore;
    o.coreSize = o.SIZE = size;
    o.velocity.x = vx;
    o.velocity.y = vy;
    
    
    
    o.RANGE = o.range = 5400 + Math.random() * 900;
    o.gemBornAt = Date.now();
    // every gem turns at its own pace and direction, from its own angle, so a
    // pile of them never spins in lockstep
    o.facing = Math.random() * Math.PI * 2;
    o.gemSpin = (0.008 + Math.random() * 0.026) * (Math.random() < 0.5 ? -1 : 1);
    o.facingTypeArgs = { speed: o.gemSpin };
    // which way it curls in when a magnet grabs it, so a haul spirals in
    // from all sides instead of forming a single file
    o.gemSwirl = (0.35 + Math.random() * 0.55) * (Math.random() < 0.5 ? -1 : 1);
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

// Pity: nobody whiffs the opening. A tank that broke 3+ rocks with no payout
// and is still holding pocket change forces its next dry break to pay
// copper. gemsMined++ on payout resets the drought automatically; fresh
// bodies start fresh. Lobby excluded (bursts don't pay there anyway).
function pityBurst(rock, breaker) {
    if (!rock || rock.ore || rock.growing) return false;
    if (!breaker || breaker.isDead?.() || breaker.royaleLobby) return false;
    if ((breaker.carriedGems | 0) >= 60) return false;
    if (((breaker.rocksMined | 0) - (breaker.gemsMined | 0)) < 3) return false;
    const { ORE, ORE_HP } = require('./terrainGrid.js');
    const tg = global.gameManager && global.gameManager.terrainGrid;
    rock.ore = ORE.COPPER;
    if (tg) {
        rock.maxHealth = (tg.baseRockHealth * 1.3) * (ORE_HP[ORE.COPPER] || 1);
        try { rock.deposits = tg._buildDeposits(rock); } catch { rock.deposits = null; }
    }
    return true;
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
        
        
        let value = d.big && rock.ore === ORE.SHARD ? SHARD_BIG : DEPOSIT_VALUE[rock.ore];
        try { value = Math.round(value * require('./raidMods.js').gemValueMult(rock.ore)); } catch { /* */ }
        const bigCls = rock.ore === ORE.EMERALD ? 'gemPickupEmeraldCore' : 'gemPickupShardCore';
        
        
        const size  = Math.max(14, Math.min(34, d.wr));
        const ang   = breaker && breaker.x !== undefined
            ? Math.atan2(breaker.y - d.wy, breaker.x - d.wx)
            : (Math.atan2(d.wy - rock.wy, d.wx - rock.wx) || Math.random() * Math.PI * 2);
        const gem = spawnGem(d.wx, d.wy, value, d.big ? bigCls : cls, size,
                             Math.cos(ang) * 1.5, Math.sin(ang) * 1.5, rock.ore);
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
function talkGems(body, delta, lost = 0, combo = null) {
    if (body.socket) {
        body.socket.talk('GEM', body.carriedGems | 0, body.gemCap | 0, delta | 0,
                         (body.socket.gemBanked || 0) | 0, lost | 0,
                         (combo ?? body._comboN) | 0);
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
    // the hoard classes mirror the hull colour, so one class fits every team
    if (body.gemHoardProp) body.gemHoardProp.define('gemHoardEmerald');
    if (body.gemHoardFacetProp) body.gemHoardFacetProp.define('gemHoardEmeraldFacet');
}

// Split a gem total into real ore pieces whose values add up EXACTLY to the
// total. share: fraction of the value per ore tier (4 emerald, 3 shard,
// 2 azurite, 1 copper); whatever the shares leave over becomes copper, and
// the last rounding remainder folds into the final piece. Never yellow.
const PIECE_VALUE = { 4: 110, 3: 60, 2: 30, 1: 15 };
// the same sizes the wall's own deposits use, so a burst never sprinkles
// smaller "dust" copper next to regular copper
const PIECE_SIZE = { 4: 30, 3: 26, 2: 20, 1: 16 };
function splitValue(total, opts = {}) {
    total = Math.max(0, Math.round(total));
    const share = opts.share || { 4: 0.2, 3: 0.3, 2: 0.3, 1: 0.2 };
    const maxPieces = opts.maxPieces || 40;
    const val = Object.assign({}, PIECE_VALUE);
    if (opts.shardValue) val[3] = opts.shardValue;
    const pieces = [];
    let left = total;
    for (const ore of [4, 3, 2, 1]) {
        let budget = Math.round(total * (share[ore] || 0));
        while (budget >= val[ore] && left >= val[ore] && pieces.length < maxPieces) {
            pieces.push({ ore, v: val[ore], cls: ORE_CLASS[ore], size: PIECE_SIZE[ore] });
            budget -= val[ore]; left -= val[ore];
        }
    }
    while (left >= val[1] && pieces.length < maxPieces) { pieces.push({ ore: 1, v: val[1], cls: ORE_CLASS[1], size: PIECE_SIZE[1] }); left -= val[1]; }
    if (left > 0) {
        if (pieces.length) pieces[pieces.length - 1].v += left;
        else pieces.push({ ore: 1, v: left, cls: ORE_CLASS[1], size: PIECE_SIZE[1] });
    }
    return pieces;
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
        const decoy = !!(body.decoyUntil && Date.now() < body.decoyUntil);
        body._decoyShown = decoy;
        const size = decoy ? SATCHEL_SIZE_RUNGS[SATCHEL_SIZE_RUNGS.length - 1].size : satchelVisualSize(carried);
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
    if (!p) return;
    // Nothing else re-sizes the pack when a Decoy lapses, so watch the window
    // flip here; and orient whenever the pack is drawn (a decoy pack on an
    // empty tank used to keep angle 0, i.e. it sat on the barrel).
    const decoyOn = !!(body.decoyUntil && Date.now() < body.decoyUntil);
    if (!!body._decoyShown !== decoyOn) updateSatchel(body);
    if (!(p.bound.size > 0)) return;
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
    body.gemCap = SATCHEL_CAP * ((global.royaleMods && global.royaleMods.satchelMult) || 1);
    if (body.socket) { try { body.gemCap = require('./shop.js').satchelCap(body); } catch { /* */ } }
    
    
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
    body._comboN = 0;
    // Death replays what you ate: tier history (newest first) dresses the
    // drop, so a shard haul bursts purple, not generic yellow loot.
    const deathHist = ((body.gemTierHist || []).filter(t => t && t.o && t.v > 0) || []).slice(-48).reverse();
    body.gemTierHist = [];
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
    // insurance: a quarter of the satchel goes to the bank before the drop
    let insured = 0;
    if (raidMode && body.socket && carried > 0) {
        try {
            if (require('./shop.js').hasGear(body, "insurance")) insured = Math.floor(carried * 0.25);
        } catch { /* */ }
    }
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
    if (carried <= 0 && bankLoss <= 0) {
        if (raidMode) { try { dustMod().onDeathDrop(body, []); } catch { /* */ } }
        return;
    }
    body.carriedGems = 0;
    if (bankLoss > 0) setBanked(body, banked - bankLoss);
    if (insured > 0) {
        setBanked(body, bankedFor(body) + insured);
        if (body.socket) body.socket.gemDeathInsured = insured;
        // a quarter of the carried dust is banked with the insured gems
        try { dustMod().onInsured(body); } catch { /* */ }
        try { require('../gamemodes/scripts/dig_royale.js').onBanked(body, insured); } catch { /* */ }
    } else if (body.socket) body.socket.gemDeathInsured = 0;
    updateSatchel(body);
    talkGems(body, -carried, 1);
    // Raid drops the FULL satchel minus insurance. (2TDM keeps its 85% tax.)
    const drop = Math.floor((carried - insured) * (raidMode ? 1 : DEATH_DROP)) + bankLoss;
    if (drop <= 0) {
        if (raidMode) { try { dustMod().onDeathDrop(body, []); } catch { /* */ } }
        return;
    }

    // 1:1 identity: newest pickups drop back as themselves at full size, so
    // 9 coppers + a vein + a shard comes back out as exactly that. Banking
    // shrinks the satchel without trimming history, so oldest entries merge
    // away first until the individuals fit the drop. Whatever the history
    // can't account for (starter dust, combo bonus, bank loss) rides as
    // generic loot filler. Capped at 24 individuals + 3 filler so a copper
    // mountain can't flood the world with entities.
    const indiv = deathHist.slice(0, 24);
    let indivTotal = indiv.reduce((a, e) => a + (e.v | 0), 0);
    while (indiv.length && indivTotal > drop) {
        const old = indiv.pop();
        indivTotal -= old.v | 0;
    }
    const drops = indiv.map(e => ({ v: e.v | 0, tier: e.o }));
    let filler = drop - indivTotal;
    if (filler > 0) {
        // untracked value comes back as real ore, never as yellow "loot"
        for (const p of splitValue(filler, { share: { 3: 0.4, 2: 0.35, 1: 0.25 }, shardValue: SHARD_BIG, maxPieces: 6 })) {
            drops.push({ v: p.v, tier: p.ore });
        }
    }
    // the rest of the carried dust rides on the pieces, split by value
    let dustShares = null;
    if (raidMode) { try { dustShares = dustMod().onDeathDrop(body, drops.map(g => g.v)); } catch { /* */ } }
    const dropNow = Date.now();
    drops.forEach((g, i) => {
        if (g.v <= 0) return;
        // spread evenly round the wreck with a bit of wobble, and fast enough
        // to actually leave the spot: a slow drop just sat there as one pile
        const ang = (i / drops.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
        const sp  = 4.2 * (0.55 + Math.random() * 0.45);
        const cls = ORE_CLASS[g.tier] || ORE_CLASS[ORE.COPPER];
        // one size per ore, the same the wall's deposits use
        const gem = spawnGem(body.x, body.y, g.v, cls,
                 PIECE_SIZE[g.tier] || PIECE_SIZE[1],
                 Math.cos(ang) * sp, Math.sin(ang) * sp, g.tier);
        // fly free for a beat before any magnet can pull them back into a heap
        if (gem) gem.gemNoMagnetUntil = dropNow + 700 + i * 25;
        // A player's death drop is reserved from unrelated bots for a grace
        // window so the player can run back for it. The bot that made the
        // kill gets an immediate claim and can collect its winnings.
        if (gem) {
            gem.gemLootFromPlayer = !!body.socket;
            if (killerBotIds.length) gem.gemLootKillerIds = killerBotIds;
            if (dustShares) gem.gemDust = dustShares[i] | 0;
        }
    });
}

// Loose gems do not litter the floor: ten seconds at rest and they fade out.
// A dead player's drop gets longer so the run back is still worth it.
const GEM_TTL_MS = 10_000;
const GEM_TTL_PLAYER_MS = 30_000;
const GEM_FADE_MS = 2_000;
const GEM_STILL_SPEED = 0.35;
const GEM_REACH2 = 1400 * 1400;   // beyond this an actor cannot touch or pull a gem
const GEM_MAX_LIFE_MS = 45_000;
function tickGem(gem, tg, players) {
    const now = Date.now();
    if (gem.gemOwnerId === undefined && !gem.chamberBias) {
        const sp2 = gem.velocity.x * gem.velocity.x + gem.velocity.y * gem.velocity.y;
        if (sp2 > GEM_STILL_SPEED * GEM_STILL_SPEED || !gem.gemRestAt) gem.gemRestAt = now;
        const ttl = gem.gemLootFromPlayer ? GEM_TTL_PLAYER_MS : GEM_TTL_MS;
        const idle = now - gem.gemRestAt;
        if (idle > ttl || now - (gem.gemBornAt || now) > GEM_MAX_LIFE_MS) { gem.kill(); return; }
        // the client blinks invuln entities: that is the fade-out warning
        const fading = idle > ttl - GEM_FADE_MS;
        if (fading !== !!gem.invuln) gem.invuln = fading;
    }
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
        const d2 = dx * dx + dy * dy;
        if (d2 > GEM_REACH2) continue;              // far actors: nothing to do
        const d = Math.sqrt(d2) || 1;
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
        // Mining combo: chain pickups inside 2.5s for up to +50% dust.
        // Banking keeps it (fun), death resets it (dropGemsOnDeath).
        const tnow = Date.now();
        if (tnow < (toucher._comboUntil || 0)) toucher._comboN = (toucher._comboN || 0) + 1;
        else toucher._comboN = 1;
        toucher._comboUntil = tnow + 2500;
        // Fresh haul, fresh memory: tier history restarts from empty so a
        // death drop replays THIS run's mix, not last life's leftovers.
        if ((toucher.carriedGems | 0) <= 0) toucher.gemTierHist = [];
        if (gem.gemOre) {
            // Identity memory: every gem is remembered (tier + full value)
            // so the death drop replays the run 1:1. Combo bonus lands as
            // filler later - only the gem's own worth is recorded.
            const hist = toucher.gemTierHist || (toucher.gemTierHist = []);
            hist.push({ o: gem.gemOre, v: gem.gemValue });
            if (hist.length > 48) hist.shift();
        }
        const bonus = Math.min(0.5, 0.05 * ((toucher._comboN || 1) - 1));
        const v = gem.gemValue + Math.round(gem.gemValue * bonus);
        gem.gemValue = 0;
        toucher.carriedGems = (toucher.carriedGems | 0) + v;
        // dust per gem entity, never per value: the combo bonus mints none
        if (Config.dig_royale) { try { dustMod().onPickup(toucher, gem); } catch { /* */ } }
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
    // boss eruptions and chest bursts fly free for a beat before the magnet grabs them
    if (gem.gemNoMagnetUntil && now < gem.gemNoMagnetUntil) return;

    let magBoost = 1;
    if (best.socket) { try { magBoost = shopMod().magnetMult(best); } catch { /* */ } }
    const magR = (best.realSize * 2.6 + MAGNET_BONUS) * (bias ? 1.45 : 1) * magBoost;
    if (bestD < magR) {
        
        
        const pull  = 1 - bestD / magR;
        const speed = 1.4 * pull + 4 * pull * pull;
        const ux = (best.x - gem.x) / bestD, uy = (best.y - gem.y) / bestD;
        // curl in sideways while still far out, straight in for the last bit,
        // so a pile of gems arrives as a spiral rather than a stack
        const swirl = (gem.gemSwirl || 0) * (1 - pull) * (1 - pull);
        const wx = ux - uy * swirl, wy = uy + ux * swirl;
        gem.velocity.x += (wx * speed - gem.velocity.x) * 0.4;   // 30 Hz tick
        gem.velocity.y += (wy * speed - gem.velocity.y) * 0.4;
        // keep spinning at its own pace: lining every gem up with its path
        // is what made a haul look like one stacked, sliding block
        if (gem.facingType !== 'spin') { gem.facingType = 'spin'; gem.facingTypeArgs = { speed: gem.gemSpin || 0.02 }; }
    } else if (gem.facingType !== 'spin') {
        gem.facingType = 'spin';
        gem.facingTypeArgs = { speed: gem.gemSpin || 0.02 };
    }
}

module.exports = { spawnOreBurst, pityBurst, spawnGem, initSatchel, updateSatchel, orientSatchel, dropGemsOnDeath, tickGem, talkGems, setBanked, splitValue, SATCHEL_CAP };
