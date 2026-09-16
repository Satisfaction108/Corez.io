

const gems = require('./gems.js');

const CHAMBER_SIZE    = 160;      
const CHAMBER_RADIUS  = 160;      
const CHAMBER_SIDES   = 15;       
const CHAMBER_INNER   = 148;      
const HEAL_FRAC_PS    = 0.005;    
const HEAL_GRACE_MS   = 60000;    
const REGROW_DELAY_MS = 20000;    
const REGROW_MS       = 280000;   
const REGROW_START_SCALE = 0.05;  
const WAVE_SPREAD     = 0.05;     

const ORBIT_SPEED_MIN = 0.0008;
const ORBIT_SPEED_SPAN = 0.0017;

// The treasury gems are the same size the loose ore gems of that class spawn
// at (the deposit radii spawn copper ~14-19, vein ~17-23, shard ~16-34,
// emerald 34) so a chamber hoard reads as the real gems, just a lot of them.
const TREASURY = [
    { cls: 'gemPickupEmerald', size: 34, value: 500, count: 2,  at: 0.95 },
    { cls: 'gemPickupShard',   size: 30, value: 150, count: 10, at: 0.75 },
    { cls: 'gemPickupVein',    size: 20, value: 30,  count: 30, at: 0.55 },
    { cls: 'gemPickupCopper',  size: 16, value: 15,  count: 40, at: 0.35 },
];

let chambers = null;

function chamberHash(id, x, y) {
    const base = (Math.imul(id + 1013, 2654435761) +
                  Math.imul(Math.round(x), 40503) +
                  Math.imul(Math.round(y), 45131)) >>> 0;
    return (i, s) => {
        let n = (base + Math.imul(i + 1, 374761393) + Math.imul(s + 7, 668265263)) >>> 0;
        n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
        return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
}

function chamberRotFor(id, x, y) {
    return (chamberHash(id, x, y)(0, 110) - 0.5) * 0.6;
}

// Radial distance from the center to the polygon edge along angle `ang`.

function polygonEdgeR(sides, apothem, rot, ang) {
    const half = Math.PI / sides;
    const sector = Math.PI * 2 / sides;
    let a = (ang - rot) % sector;
    if (a < 0) a += sector;
    return apothem / Math.cos(a - half);
}

function polygonNormal(sides, rot, ang) {
    const half = Math.PI / sides;
    const sector = Math.PI * 2 / sides;
    let a = (ang - rot) % sector;
    if (a < 0) a += sector;
    const mid = ang - (a - half);
    return { nx: Math.cos(mid), ny: Math.sin(mid) };
}

const APOTHEM_OUTER = CHAMBER_RADIUS * Math.cos(Math.PI / CHAMBER_SIDES);
// The drawn ring's inner outline is a 15-gon with VERTICES at CHAMBER_INNER,
// so its apothem is the boundary the treasury gems must never cross.
const APOTHEM_INNER = CHAMBER_INNER * Math.cos(Math.PI / CHAMBER_SIDES);

// The outward unit normal of the face at `ang` for the chamber's rotation.
function chamberNormal(chamber, ang) {
    return polygonNormal(CHAMBER_SIDES, chamber.chamberRot || 0, ang);
}

// The outer face radius at `ang` for the chamber's current growth scale.
function chamberFaceRadius(chamber, ang) {
    const scale = chamber.sizeMultiplier ?? 1;
    return polygonEdgeR(CHAMBER_SIDES, APOTHEM_OUTER * scale, chamber.chamberRot || 0, ang);
}

// True if the body's circle overlaps the polygon (the ring's outer boundary
// and everything inside it). The interior is solid for collision even though
// the ring is drawn hollow: nothing can be inside while it stands - the face
// blocks every body and absorbs/deflects every bullet - and a ring that grows
// around a body must push it out rather than swallow it.
function chamberRingHit(chamber, body) {
    const scale = chamber.sizeMultiplier ?? 1;
    const dx = body.x - chamber.x, dy = body.y - chamber.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) return true;
    const ang = Math.atan2(dy, dx);
    const outer = polygonEdgeR(CHAMBER_SIDES, APOTHEM_OUTER * scale, chamber.chamberRot || 0, ang);
    const r = body.realSize || body.size || 1;
    return d - r < outer;
}

function getChambers() {
    if (chambers) return chambers;
    const tg = global.gameManager && global.gameManager.terrainGrid;
    if (!tg || !tg.coreChamberSites || !tg.coreChamberSites.length) return [];
    chambers = tg.coreChamberSites.map(s => ({
        id: s.id,
        name: s.name,
        team: s.team,
        x: s.x,
        y: s.y,
        r: CHAMBER_RADIUS,
        state: 'alive',          // 'alive' | 'destroyed' | 'regrowing'
        entity: null,            // the collision/damage body
        containedGems: [],       // gem entities currently locked inside
        _pending: [],            // treasury gems waiting for their wave
        _armed: false,           // boot-time hoard already raised
        _exposed: false,         // 50%-health warning fired for this life
        _hpTrack: 0,
        _lastHitAt: 0,
        destroyedAt: 0,
        regrowStart: 0,
    }));
    return chambers;
}

// Static sites for the TG snapshot (positions never change).
function snapshot() {
    return getChambers().map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y, r: c.r, team: c.team }));
}

// Live state for the 250ms CC broadcast.
// st: 0 = alive, 1 = destroyed (empty pocket), 2 = regrowing.
function stateSnapshot() {
    const now = Date.now();
    return getChambers().map(c => ({
        id: c.id,
        st: c.state === 'alive' ? 0 : c.state === 'destroyed' ? 1 : 2,
        h: c.state === 'alive' && c.entity && !c.entity.isDead()
            ? Math.max(0, Math.min(1, c.entity.health.amount / c.entity.health.max))
            : 0,
        s: c.state === 'regrowing' ? growScale(c, now) : 1,
    }));
}

function announce(msg) {
    // Tutorial: capture/destruction fanfare is noise while someone is being
    // taught - every event on that server is a scripted lesson beat anyway.
    if (Config.tutorial) return;
    global.gameManager.socketManager.broadcast(msg);
}

const teamName = team => team === TEAM_BLUE ? "Blue" : "Red";

// The smooth ease-in-out curve the living wall grows with - slow right
// after the sliver appears and slow as the ring closes in.
function easeGrowth(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function growScale(c, now) {
    if (c.state === 'alive') return 1;
    if (c.state === 'destroyed') return 0;
    const t = Math.max(0, Math.min(1, (now - c.regrowStart) / REGROW_MS));
    return REGROW_START_SCALE + (1 - REGROW_START_SCALE) * easeGrowth(t);
}

// ── structure body ───────────────────────────────────────────────────────
function spawnStructure(c) {
    const o = new Entity({ x: c.x, y: c.y });
    o.define('coreChamber');
    o.team = c.team;
    o.color.base = getTeamColor(c.team);
    // the ring's own label lives in drawChambers - no floating nameplate
    o.name = "";
    o.isCoreChamber = true;
    o.chamberAlive = c.state === 'alive';
    o.chamberRot = chamberRotFor(c.id, c.x, c.y);
    o.sizeMultiplier = growScale(c, Date.now());
    
    o.pinX = c.x;
    o.pinY = c.y;
    // Tutorial: a real ring is meant to take a team a while, which is a fine
    // design and a terrible lesson - the learner would be holding fire for
    // half a minute to see what happens. Thin it down; the objective is the
    // hoard spilling out, not the grind to get there.
    if (Config.tutorial && o.health && o.health.max) {
        o.health.max *= 0.18;
        o.health.amount = o.health.max;
        if (o.shield) { o.shield.max = 0; o.shield.amount = 0; }
    }
    o.on('dead', () => onChamberDeath(c));
    c.entity = o;
    c._hpTrack = o.health.max;
    c._lastHitAt = 0;
    refreshAABB(o);
}

function refreshAABB(o) {
    const s = o.size;
    o.minX = o.x - s; o.minY = o.y - s;
    o.maxX = o.x + s; o.maxY = o.y + s;
}

function onChamberDeath(c) {
    c.entity = null;
    c.state = 'destroyed';
    c.destroyedAt = Date.now();
    c._exposed = false;
    c._armed = false;
    releaseGems(c);
    announce(`The ${c.name} has shattered - its gems are released!`);
}

function armTreasury(c) {
    
    
    c._pending.length = 0;
    for (const tier of TREASURY) {
        for (let i = 0; i < tier.count; i++) {
            c._pending.push({ tier, at: tier.at + WAVE_SPREAD * (i + 1) / (tier.count + 1) });
        }
    }
}

function spawnContainedGem(c, tier, spawnScale) {
    const ang = Math.random() * Math.PI * 2;
    // spread across the full disk - the gems can ride out to the inner wall
    const rad = Math.random() * Math.max(2, APOTHEM_INNER * spawnScale * 0.9);
    const g = gems.spawnGem(c.x + Math.cos(ang) * rad, c.y + Math.sin(ang) * rad,
                            tier.value, tier.cls, tier.size);
    g.chamberHome = c;          // routes this gem to the containment tick
    // Stay on the spatial grid so cameras can still see them. Pulling them
    // out made the hoard vanish ~250ms after spawn (and after every regrow)
    // because the view list is rebuilt from grid queries. They already have
    // NO_COLLISIONS, so they will not fight tanks or each other.
    g.settings.diesAtRange = false;
    g.RANGE = g.range = 9e99;
    
    
    
    
    g._orbitA = ang;
    g._orbitR = Math.max(g.realSize + 2, rad);
    g._orbitW = ORBIT_SPEED_MIN + Math.random() * ORBIT_SPEED_SPAN;
    g._orbitDir = Math.random() < 0.5 ? 1 : -1;   // some drift clockwise, some against
    g._orbitWob = Math.random() * Math.PI * 2;
    // per-gem motion signature: angular speed breathes, the radius wobbles on
    // two out-of-phase sine trains, and the whole track is mildly elliptical -
    // so no two gems ever ride the same uniform circle
    g._orbitJit = 0.5 + Math.random() * 0.25;
    g._orbitRA  = 0.04 + Math.random() * 0.05;
    g._orbitJag = 0.02 + Math.random() * 0.03;
    g._orbitEcc = 0.08 + Math.random() * 0.10;
    g._orbitBreathe = 0.05 + Math.random() * 0.06;
    c.containedGems.push(g);
    return g;
}

function pruneContainedGems(c) {
    for (let i = c.containedGems.length - 1; i >= 0; i--) {
        const g = c.containedGems[i];
        if (!g || g.isDead?.()) c.containedGems.splice(i, 1);
    }
}

function refillTreasuryIfEmpty(c) {
    pruneContainedGems(c);
    if (c.containedGems.length || c._pending.length) return;
    armTreasury(c);
    spawnPendingGems(c, 1);
}

function spawnPendingGems(c, scale) {
    if (!c._pending.length) return;
    const ready = [];
    for (let i = c._pending.length - 1; i >= 0; i--) {
        if (c._pending[i].at <= scale) ready.push(c._pending.splice(i, 1)[0]);
    }
    for (const p of ready) spawnContainedGem(c, p.tier, scale);
}

function tickContainedGem(gem) {
    const c = gem.chamberHome;
    if (!c || !c.entity || c.state === 'destroyed') {
        
        if (c) {
            const i = c.containedGems.indexOf(gem);
            if (i >= 0) c.containedGems.splice(i, 1);
        }
        gem.chamberHome = undefined;
        gem.settings.diesAtRange = true;
        gem.range = 5400 + Math.random() * 900;
        return;
    }
    const scale = growScale(c, Date.now());
    // the gems may use the whole pocket - the limit is the ring's inner wall
    // (its apothem × scale) minus the gem's own half-width
    const lim = Math.max(gem.realSize + 2, APOTHEM_INNER * scale - gem.realSize);

    // non-monotonous revolution: the angular speed swells and eases around the
    // track (never stalls or backtracks), the radius rides two wobbles plus a
    // slow breathe, and a per-gem eccentricity drifts the whole path off-centre
    const a0 = gem._orbitA || 0;
    const w = gem._orbitW || 0.001;
    const wob = gem._orbitWob || 0;
    gem._orbitA = a0 + (gem._orbitDir || 1) * w * (1 + (gem._orbitJit || 0.5) * Math.sin(0.4 * a0 + wob));
    const a = gem._orbitA;
    const amp = 1 + (gem._orbitRA || 0.06) + (gem._orbitJag || 0.04) + (gem._orbitEcc || 0.12) + (gem._orbitBreathe || 0.08);
    const baseR = Math.min(gem._orbitR || 0, Math.max(gem.realSize + 2, lim / amp));
    const r = baseR * (1 + (gem._orbitRA || 0) * Math.sin(1.7 * a + wob) +
                              (gem._orbitJag || 0) * Math.sin(3.1 * a + wob * 2)) *
                      (1 + (gem._orbitEcc || 0) * Math.cos(a + wob * 0.5)) *
                      (1 + (gem._orbitBreathe || 0) * Math.sin(0.11 * a + wob * 3));
    gem.x = c.x + Math.cos(a) * r;
    gem.y = c.y + Math.sin(a) * r;
    gem.velocity.x = 0;
    gem.velocity.y = 0;
    gem.range = 9e99;
}

function releaseGems(c) {
    for (const g of c.containedGems) {
        if (!g || g.isDead?.()) continue;
        g.chamberHome = undefined;
        g.chamberBias = c.team;     
        
        
        g.settings.diesAtRange = true;
        g.range = 5400 + Math.random() * 900;
        
        
        const ang = Math.atan2(g.y - c.y, g.x - c.x);
        const sp = 1.2 + Math.random() * 1.2;
        g.velocity.x += Math.cos(ang) * sp;
        g.velocity.y += Math.sin(ang) * sp;
    }
    c.containedGems.length = 0;
    c._pending.length = 0;
}

function tick(dtMs) {
    const list = getChambers();
    if (!list.length) return;
    const now = Date.now();

    for (const c of list) {
        
        if (!c.entity && (c.state === 'alive' || c.state === 'regrowing')) spawnStructure(c);

        if (c.state === 'alive') {
            const b = c.entity;
            if (b && !b.isDead()) {
                
                
                if (!c._armed) {
                    c._armed = true;
                    armTreasury(c);
                    spawnPendingGems(c, 1);
                } else {
                    refillTreasuryIfEmpty(c);
                }
                
                
                
                if (b.health.amount < (c._hpTrack ?? b.health.amount)) c._lastHitAt = now;
                c._hpTrack = b.health.amount;
                if (b.health.amount < b.health.max &&
                    now - (c._lastHitAt || 0) >= HEAL_GRACE_MS) {
                    b.health.amount = Math.min(b.health.max,
                        b.health.amount + b.health.max * HEAL_FRAC_PS * (dtMs / 1000));
                }
                // 50% health = exposed: one global warning per life
                if (!c._exposed && b.health.amount < b.health.max * 0.5) {
                    c._exposed = true;
                    announce(`The ${c.name} is exposed!`);
                }
            }
        } else if (c.state === 'destroyed') {
            
            
            if (now - c.destroyedAt >= REGROW_DELAY_MS) {
                c.state = 'regrowing';
                c.regrowStart = now;
                c._hpTrack = 0;
                c._armed = true;
                armTreasury(c);
                spawnStructure(c);
            }
        } else if (c.state === 'regrowing') {
            const b = c.entity;
            if (!b) continue;
            const scale = growScale(c, now);
            b.sizeMultiplier = scale;
            b.chamberAlive = false;
            refreshAABB(b);
            
            spawnPendingGems(c, scale);
            if (scale >= 1) {
                
                b.sizeMultiplier = 1;
                b.chamberAlive = true;
                b.health.amount = b.health.max;
                refreshAABB(b);
                c.state = 'alive';
                c._exposed = false;
                c._lastHitAt = now;
                c._armed = true;
                spawnPendingGems(c, 1);
                refillTreasuryIfEmpty(c);
                announce(`The ${c.name} has reformed.`);
            }
        }

        
        const b = c.entity;
        if (b) {
            b.x = c.x; b.y = c.y;
            b.velocity.x = 0; b.velocity.y = 0;
            b.accel.x = 0;    b.accel.y = 0;
        }
    }
}

module.exports = {
    tick, snapshot, stateSnapshot, tickContainedGem, getChambers,
    chamberRingHit, chamberFaceRadius, chamberNormal, polygonNormal,
};

