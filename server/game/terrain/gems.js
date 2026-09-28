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
// A full gem radius of grab slack; less lets a gem sliding past a moving tank
// stay just outside the touch ring for its whole flyby.
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
    // random spin speed/direction so a pile never spins in lockstep
    o.facing = Math.random() * Math.PI * 2;
    o.gemSpin = (0.008 + Math.random() * 0.026) * (Math.random() < 0.5 ? -1 : 1);
    o.facingTypeArgs = { speed: o.gemSpin };
    // curl direction under a magnet, so a haul spirals in instead of queuing
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

// Pity: a tank that broke 3+ rocks with no payout and carries under 60 turns
// its next dry break into copper. gemsMined++ on payout resets the drought.
// Lobby excluded (bursts don't pay there anyway).
function pityBurst(rock, breaker) {
    if (!rock || rock.ore || rock.growing) return false;
    if (!breaker || breaker.isDead?.() || breaker.royaleLobby) return false;
    if ((breaker.carriedGems | 0) >= 60) return false;
    if (((breaker.rocksMined | 0) - (breaker.gemsMined | 0)) < 3) return false;
    const { ORE, ORE_HP } = require('./terrainGrid.js');
    const tg = global.gameManager && global.gameManager.terrainGrid;
    rock.ore = ORE.COPPER;
    if (tg) {
        rock.maxHealth = tg.plainRockHealth * (ORE_HP[ORE.COPPER] || 1);
        try { rock.deposits = tg._buildDeposits(rock); } catch { rock.deposits = null; }
    }
    return true;
}

function spawnOreBurst(rock, breaker) {
    if (!rock.ore) return;
    // no gems in the BR lobby
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
    }
}

// GEM packet: carried, cap, delta, banked, lost, combo.
// `lost` is set only when death emptied the satchel (client plays the loss
// sting). Don't infer death from a negative delta; that is not a contract.
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

// Pack offset in hull radii. Just past 1 so the hull covers its inner edge
// and it reads as worn rather than floating.
const SATCHEL_OFFSET = 1.02;

// Re-applies the pack colour whenever the team changes. It can't be baked in
// at build time: sockets.js calls initSatchel() before the gamemode assigns
// body.team. Prop.define() only touches shape/colour/stroke, never bound, so
// this is safe on a live prop.
function applySatchelTeamColor(body) {
    if (body._satchelTeam === body.team) return;
    body._satchelTeam = body.team;
    // the hoard classes mirror the hull colour, so one class fits every team
    if (body.gemHoardProp) body.gemHoardProp.define('gemHoardEmerald');
    if (body.gemHoardFacetProp) body.gemHoardFacetProp.define('gemHoardEmeraldFacet');
}

// Split a gem total into ore pieces whose values sum exactly to the total.
// share: fraction of value per tier (4 emerald, 3 shard, 2 azurite, 1 copper);
// the leftover becomes copper and the rounding remainder folds into the last
// piece. Never yellow loot.
const PIECE_VALUE = { 4: 110, 3: 60, 2: 30, 1: 15 };
// same sizes as the wall's own deposits
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

// Entity.define() always clears body.props but only emits 'define' (the
// re-attach hook below) when emitEvent is true; armBot() passes false. So the
// satchel props are re-attached at the point of use as well.
function ensureSatchelProps(body) {
    const p = body.gemHoardProp, f = body.gemHoardFacetProp;
    if (!body.props) return;
    if (p && body.props.get(p.id) !== p) body.props.set(p.id, p);
    if (f && body.props.get(f.id) !== f) body.props.set(f.id, f);
}

// Discrete pack sizes by whole gems carried (not a continuous curve).
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
        // truncate like the HUD, so a fractional residue draws no pack
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

// A turret that picks its own target rather than following the hull.
function isAutoTurret(t) {
    return !!(t && t.controllers && t.controllers.some(
        c => c && c.constructor && c.constructor.name === 'io_nearestDifferentMaster'));
}

function autofireOn(body) {
    const cmd = body.socket && body.socket.player && body.socket.player.command;
    // bots have no command object and always fire
    return cmd ? !!cmd.autofire : true;
}

// Where the pack hangs (see satchelBackAngle). "Forward" depends on archetype:
//
//   rammers         - spinning hull; forward is the movement direction
//   auto smasher    - forward is its single self-aiming turret
//   radial autos    - Auto-3/4/5: the aim when autofiring, else movement
//   everything else - the aim (incl. auto assassin/gunner, whose turret is a sidearm)
// Returns undefined when there is no answer this frame (a parked rammer), so
// the caller holds the last angle.
//
// Entity.guns/.turrets are Maps; Prop and Turret use plain arrays. Accept both.
function listOf(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v.values === 'function') return [...v.values()];
    return [];
}

function satchelBackAngle(body) {
    const autos = listOf(body.turrets).filter(isAutoTurret);
    const hasOwnGuns = listOf(body.guns).length > 0;
    // IS_SMASHER only survives at runtime as settings.reloadToAcceleration
    // (entity.js maps it there). This is what separates a smasher from an
    // Auto-3, which also has no hull guns.
    const isSmasherHull = !!(body.settings && body.settings.reloadToAcceleration);

    const moveAway = () => {
        const v = body.velocity;
        const sp = v ? Math.hypot(v.x, v.y) : 0;
        // below a crawl the heading is noise
        if (sp < 0.05) return undefined;
        return Math.atan2(-v.y, -v.x);
    };
    const aimAway = () => {
        const t = body.control && body.control.target;
        if (!t || (!t.x && !t.y)) return body.facing + Math.PI;
        return Math.atan2(-t.y, -t.x);
    };

    if (isSmasherHull) {
        // auto smasher: hide behind the turret
        if (autos.length) return autos[0].facing + Math.PI;
        return moveAway();
    }
    if (!hasOwnGuns && autos.length >= 2) {
        return autofireOn(body) ? aimAway() : moveAway();
    }
    return aimAway();
}

// Shortest-arc angle ease.
function easeAngle(from, to, k) {
    if (from === undefined || !isFinite(from)) return to;
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return from + d * k;
}

// Runs every tick per carrier; bails early on an empty (undrawn) pack.
function orientSatchel(body) {
    const p = body.gemHoardProp;
    if (!p) return;
    // Nothing else re-sizes the pack when a Decoy lapses, so watch for the
    // window flipping here. Orient whenever the pack is drawn, decoy included.
    const decoyOn = !!(body.decoyUntil && Date.now() < body.decoyUntil);
    if (!!body._decoyShown !== decoyOn) updateSatchel(body);
    if (!(p.bound.size > 0)) return;
    applySatchelTeamColor(body);
    ensureSatchelProps(body);

    let want = satchelBackAngle(body);
    if (want === undefined) want = body._satchelAngle;
    if (want === undefined) want = body.facing + Math.PI;
    body._satchelAngle = easeAngle(body._satchelAngle, want, 0.22);

    // The client places a prop at (direction + angle + hullFacing) and, with
    // mirrorMasterAngle (Prop default), faces it at (hullFacing + angle). All
    // rotation in `angle` with direction 0 puts both position and tilt on the
    // absolute target angle.
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
        // layer 0: drawn before the hull, so the pack sits behind the tank
        const p = new Prop([0, 0, 0, 0, 0], body);
        p.define(kind);
        body.gemHoardProp = p;
        // created after the pack so it draws on top of it, still behind the hull
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
    // tier history (newest first) decides what the drop looks like
    const deathHist = ((body.gemTierHist || []).filter(t => t && t.o && t.v > 0) || []).slice(-48).reverse();
    body.gemTierHist = [];
    const raidMode = !!Config.dig_royale;
    // Bot killers skip the anti-vulture grace period on the loot they made.
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
    // Death screen shows carried + banked before the drop. Snapshot here: this
    // runs on 'dead', before records() builds the death packet.
    if (body.socket) {
        body.socket.gemDeathScore = carried + banked;
        // Split too, since carriedGems is zeroed below. Banked is pre-loss so
        // score = carried + banked.
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

    // Newest pickups drop back 1:1 as themselves. Banking doesn't trim history,
    // so the oldest entries are dropped until the individuals fit. Value the
    // history can't account for (starter dust, combo bonus, bank loss) becomes
    // filler. Capped at 24 individuals + 6 filler pieces to bound entity count.
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
        // spread evenly with wobble, fast enough to actually leave the wreck
        const ang = (i / drops.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
        const sp  = 4.2 * (0.55 + Math.random() * 0.45);
        const cls = ORE_CLASS[g.tier] || ORE_CLASS[ORE.COPPER];
        // one size per ore, the same the wall's deposits use
        const gem = spawnGem(body.x, body.y, g.v, cls,
                 PIECE_SIZE[g.tier] || PIECE_SIZE[1],
                 Math.cos(ang) * sp, Math.sin(ang) * sp, g.tier);
        // fly free for a beat before any magnet can pull them back into a heap
        if (gem) gem.gemNoMagnetUntil = dropNow + 700 + i * 25;
        // A player's drop is off-limits to unrelated bots for a grace window;
        // the killer bot can claim it immediately.
        if (gem) {
            gem.gemLootFromPlayer = !!body.socket;
            if (killerBotIds.length) gem.gemLootKillerIds = killerBotIds;
            if (dustShares) gem.gemDust = dustShares[i] | 0;
        }
    });
}

// Loose gems fade after 15s at rest; a dead player's drop gets longer.
const GEM_TTL_MS = 15_000;
const GEM_TTL_PLAYER_MS = 40_000;
const GEM_FADE_MS = 3_000;
const GEM_STILL_SPEED = 0.35;
const GEM_REACH2 = 1400 * 1400;   // beyond this an actor cannot touch or pull a gem
const GEM_MAX_LIFE_MS = 60_000;
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
            // rock regrew over the last open spot: search outward for free ground
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

    // Magnet target (best) and toucher are tracked separately: anyone touching
    // a gem collects it, whoever it is flying toward.
    let best = null, bestD = Infinity, bestScore = Infinity;
    let toucher = null, toucherD = Infinity;
    const bias = gem.chamberBias;
    for (const actor of players) {
        const body = actorBody(actor);
        if (!body || body.isDead() || body.isGhost) continue;
        // unrelated bots skip a dead player's loot during the reclaim window
        const isKillerBot = body.isBot &&
            gem.gemLootKillerIds?.includes(body.id);
        if (body.isBot && gem.gemLootFromPlayer && !isKillerBot &&
            now - (gem.gemBornAt || 0) < 15000) continue;
        const dx = body.x - gem.x, dy = body.y - gem.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > GEM_REACH2) continue;              // far actors: nothing to do
        const d = Math.sqrt(d2) || 1;
        // an owned gem is shoved away from everyone else, never collected
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
        // Loose gems go to whoever is closest (no breaker head start: that made
        // gems flee from the player on top of them).
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
        // tier history restarts with each fresh haul
        if ((toucher.carriedGems | 0) <= 0) toucher.gemTierHist = [];
        if (gem.gemOre) {
            // record tier + base value for the 1:1 death drop (combo bonus excluded)
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

    // hard speed ceiling: loot never outruns a tank

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
        // keep its own spin; aligning to the path makes a haul look like one block
        if (gem.facingType !== 'spin') { gem.facingType = 'spin'; gem.facingTypeArgs = { speed: gem.gemSpin || 0.02 }; }
    } else if (gem.facingType !== 'spin') {
        gem.facingType = 'spin';
        gem.facingTypeArgs = { speed: gem.gemSpin || 0.02 };
    }
}

module.exports = { spawnOreBurst, pityBurst, spawnGem, initSatchel, updateSatchel, orientSatchel, dropGemsOnDeath, tickGem, talkGems, setBanked, splitValue, SATCHEL_CAP };
