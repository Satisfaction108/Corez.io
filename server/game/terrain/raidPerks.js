// Raid perks: points on the raid board earn picks of one of three perks
// (the first at 5,000, each later one 5,000 points further off than the one
// before, at most MAX_PICKS). The build lives on your raid board row
// (dig_royale's raidStats), so every new body is handed it again, the way
// bought stat points come back (shop.applyStatPoints). A death costs two
// random perks (onDeath) and starts the milestones over from the new score.
// A new raid, or the /raidreset staging lobby, starts everyone with an empty build.
//
// Ported from the Dig Deep prototype (deepPerks.js) and retuned for PvP:
// mining, utility and mobility are strong and offered more often, anything
// that adds damage to a fight is small and offered less. Rock-only perks
// (blast, chain, crit, quake) never touch a tank.
//
// Effects go through systems that already exist, all reading body._pkfx (the
// effect table built here, null when the build is empty):
//   shop.applyPassives    speed, health, satchel size
//   mining.gearMult       dig power;  game/index.js: dig budget + shot perks
//   gun.js                reload
//   gems.js               magnet reach, ore value, gem surge
//   hidden guns           twin barrel, drone bay (mounted like shop sidearms
//                         and put back after an evolution)
//
// The pure parts (catalog, milestones, offers, picks, the effect table) need
// no game running; scripts/test/raidPerks.test.js covers them.
'use strict';

// Pick k comes STEP * k points after pick k-1: 5,000, 15,000, 30,000, 50,000...
// and nobody holds more than MAX_PICKS.
const STEP = 5000;
const MAX_PICKS = 15;
const OFFER_N = 3;

// max: how many times it stacks. w: how often it's offered (mining and
// utility 3, survival 2, anything that adds damage to a fight 1).
// icon: the client's glyph key (raidPerks.js GLYPH).
const CATALOG = [
    { id: 'drill',      name: 'Power Drill',     icon: 'drill',      max: 5, w: 3, kind: 'mine',  desc: 'You mine 20% faster.' },
    { id: 'blast',      name: 'Blast Rounds',    icon: 'blast',      max: 5, w: 3, kind: 'mine',  desc: 'Shots that hit rock crack the rock around them.' },
    { id: 'rich',       name: 'Rich Veins',      icon: 'rich',       max: 5, w: 3, kind: 'mine',  desc: 'Ore you break drops 12% more gems.' },
    { id: 'magnet',     name: 'Ore Magnet',      icon: 'magnet',     max: 5, w: 3, kind: 'util',  desc: 'Gems fly to you from 40% farther away.' },
    { id: 'quake',      name: 'Seismic Pulse',   icon: 'quake',      max: 4, w: 3, kind: 'mine',  desc: 'Every few seconds a pulse cracks the rock around you.' },
    { id: 'chain',      name: 'Chain Spark',     icon: 'chain',      max: 5, w: 3, kind: 'mine',  desc: 'Hitting rock can send a spark into nearby rock.' },
    { id: 'pierce',     name: 'Piercing Rounds', icon: 'pierce',     max: 5, w: 3, kind: 'mine',  desc: 'Shots punch through one more rock.' },
    { id: 'crit',       name: 'Lucky Strike',    icon: 'crit',       max: 5, w: 3, kind: 'mine',  desc: '12% of your shots hit rock for triple damage.' },
    { id: 'grind',      name: 'Hull Grinder',    icon: 'grind',      max: 5, w: 3, kind: 'mine',  desc: 'Ramming rock grinds it down 25% faster.' },
    { id: 'prospector', name: 'Prospector',      icon: 'prospector', max: 5, w: 3, kind: 'mine',  desc: 'Plain rocks you break have a higher chance to drop bonus copper.' },
    { id: 'shatter',    name: 'Quake Shatter',   icon: 'shatter',    max: 5, w: 3, kind: 'mine',  desc: 'Breaking a rock blasts neighboring rocks for 18% of their health.' },
    { id: 'chipper',    name: 'Chip Collector',  icon: 'chipper',    max: 5, w: 3, kind: 'mine',  desc: 'Chipping ore rocks pays out 25% more gems right into your satchel.' },
    { id: 'satchel',    name: 'Deep Pockets',    icon: 'satchel',    max: 3, w: 3, kind: 'util',  desc: 'Your satchel holds 4,000 more gems per stack.' },
    { id: 'tractor',    name: 'Tractor Beam',    icon: 'tractor',    max: 5, w: 3, kind: 'util',  desc: 'Gems pulled by your magnet fly into your tank 30% faster.' },
    { id: 'stormward',  name: 'Storm Ward',      icon: 'stormward',  max: 5, w: 2, kind: 'util',  desc: 'You take 15% less damage from the storm circle.' },
    { id: 'speed',      name: 'Swift Treads',    icon: 'speed',      max: 5, w: 3, kind: 'move',  desc: 'You move 6% faster.' },
    { id: 'surge',      name: 'Gem Surge',       icon: 'surge',      max: 5, w: 3, kind: 'move',  desc: 'Picking up a gem boosts your speed by 8% for 3 seconds.' },
    { id: 'hide',       name: 'Thick Hide',      icon: 'hide',       max: 5, w: 2, kind: 'tough', desc: 'You get 7% more max health.' },
    { id: 'regen',      name: 'Field Repair',    icon: 'regen',      max: 4, w: 2, kind: 'tough', desc: 'After 5 seconds out of a fight, you heal 1.2% of your health per second.' },
    { id: 'aegis',      name: 'Aegis Shield',    icon: 'aegis',      max: 5, w: 2, kind: 'tough', desc: 'Your shield holds 15% more and recovers faster.' },
    { id: 'twin',       name: 'Twin Drill',      icon: 'twin',       max: 3, w: 1, kind: 'fight', desc: 'Your barrels fire an extra shot that only drills rock.' },
    { id: 'drones',     name: 'Drone Bay',       icon: 'drones',     max: 3, w: 1, kind: 'fight', desc: 'Adds swarm drones that only chew rock.' },
    { id: 'reload',     name: 'Overclock',       icon: 'reload',     max: 5, w: 1, kind: 'fight', desc: 'You reload 5% faster.' },
    { id: 'velocity',   name: 'High Velocity',   icon: 'velocity',   max: 5, w: 1, kind: 'fight', desc: 'Your shots fly 6% faster and reach farther.' },
];
const BY_ID = new Map(CATALOG.map(p => [p.id, p]));

// ── milestones ───────────────────────────────────────────────────────────
// The score pick k (1-based) comes at.
function pickAt(k) { return STEP * k * (k + 1) / 2; }
// How many picks a board score has earned in all.
function earnedAt(score) {
    const s = +score || 0;
    let k = 0;
    while (k < MAX_PICKS && pickAt(k + 1) <= s) k++;
    return k;
}
// The score the next pick comes at, once `granted` have been earned (0: none left).
function nextAt(granted) { return (granted | 0) >= MAX_PICKS ? 0 : pickAt((granted | 0) + 1); }

// A build from anywhere (a save, an update, an older rule set) brought in line
// with today's catalog and cap: perks that are gone or past their max are cut,
// then the biggest stacks give back levels until it fits under MAX_PICKS.
const RULES = 2;
function sanitize(build) {
    if (!build || build.rules === RULES) return build;
    const perks = {};
    for (const id of Object.keys(build.perks || {})) {
        const p = BY_ID.get(id);
        const n = Math.min(p ? p.max : 0, build.perks[id] | 0);
        if (n > 0) perks[id] = n;
    }
    let total = 0;
    for (const id in perks) total += perks[id];
    while (total > MAX_PICKS) {
        let top = null;
        for (const id in perks) if (!top || perks[id] > perks[top]) top = id;
        if (--perks[top] <= 0) delete perks[top];
        total--;
    }
    build.perks = perks;
    build.granted = Math.min(build.granted | 0, MAX_PICKS);
    const room = Math.max(0, MAX_PICKS - total);
    const offer = Array.isArray(build.offer) ? build.offer.filter(id => BY_ID.has(id)) : null;
    build.offer = room > 0 && offer && offer.length ? offer : null;
    build.pending = Math.max(0, Math.min(build.pending | 0, room - (build.offer ? 1 : 0)));
    if (!build.offer && build.pending > 0) { build.pending--; build.offer = rollOffer(build); if (!build.offer.length) { build.offer = null; build.pending = 0; } }
    build.rules = RULES;
    build.v = (build.v | 0) + 1;
    return build;
}

// perks: id -> stacks. offer: the three on the table (or null). pending:
// milestones reached that wait behind the current offer. granted: milestones
// handed out since the last death (a high-water mark: points lost later never
// take one back). base: the score milestones count from (the score at the last
// respawn). v: bumps on every change, so a body and a client know they're stale.
function newBuild() {
    return { perks: {}, offer: null, pending: 0, granted: 0, base: 0, v: 0, rules: RULES };
}

// A death: two random perks go (every level of each), anything unpicked goes,
// and the milestones start over (5,000, 15,000, ...) from the new score.
const DEATH_LOSS = 2;
function onDeath(build, score, rng = Math.random) {
    if (!build) return [];
    const ids = Object.keys(build.perks || {}).filter(id => (build.perks[id] | 0) > 0);
    const lost = [];
    while (lost.length < DEATH_LOSS && ids.length) {
        const id = ids.splice(Math.floor(rng() * ids.length), 1)[0];
        delete build.perks[id];
        lost.push(id);
    }
    build.offer = null;
    build.pending = 0;
    build.granted = 0;
    build.base = Math.max(0, +score || 0);
    build.v = (build.v | 0) + 1;
    return lost;
}

// Three different perks that still have room, weighted toward mining and
// utility (fewer near the end when most are maxed)
const UPGRADE_W = 2;
function rollOffer(build, rng = Math.random) {
    const perks = (build && build.perks) || {};
    // Deep Pockets is already on for everyone during the twist of that name)
    const twistDeep = !!(global.royaleMods && global.royaleMods.satchelDeep);
    const pool = CATALOG.filter(p => (perks[p.id] | 0) < p.max && !(twistDeep && p.id === 'satchel'))
        .map(p => ({ id: p.id, up: (perks[p.id] | 0) > 0, w: p.w * ((perks[p.id] | 0) > 0 ? UPGRADE_W : 1) }));
    const out = [];
    // one weighted draw among the pool entries that pass `ok`
    const draw = (ok) => {
        let total = 0;
        for (const p of pool) if (ok(p)) total += p.w;
        if (!(total > 0)) return false;
        let r = rng() * total, k = -1;
        for (let i = 0; i < pool.length; i++) {
            if (!ok(pool[i])) continue;
            k = i;
            r -= pool[i].w;
            if (r < 0) break;
        }
        out.push(pool[k].id);
        pool.splice(k, 1);
        return true;
    };
    draw(p => p.up);                       // an upgrade, when one exists
    if (out.length < OFFER_N) draw(p => !p.up);   // and something new
    while (out.length < OFFER_N && draw(() => true));
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function roman(n) { return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || String(n); }
// The offer as the client gets it: a perk you already hold says which
// level this pick takes it to ("Power Drill II").
function describeOffer(build) {
    return (build && build.offer || []).map(id => {
        const p = BY_ID.get(id);
        const have = build.perks[id] | 0;
        return { id, name: p.name + (have ? ' ' + roman(have + 1) : ''), desc: p.desc, icon: p.icon, n: have, max: p.max, kind: p.kind };
    });
}
function perkList(build) {
    if (!build) return [];
    return CATALOG.filter(p => (build.perks[p.id] | 0) > 0).map(p => ({ id: p.id, n: build.perks[p.id] | 0, icon: p.icon, name: p.name, max: p.max }));
}
function totalPicks(build) {
    let n = 0;
    if (build) for (const id in build.perks) n += build.perks[id] | 0;
    return n;
}

// n more picks: the first opens an offer, the rest queue behind it.
// -> true when a new offer opened.
function grant(build, n = 1, rng = Math.random) {
    if (!build || !(n > 0)) return false;
    let opened = false;
    for (let i = 0; i < n; i++) {
        if (totalPicks(build) + (build.offer ? 1 : 0) + (build.pending | 0) >= MAX_PICKS) break;
        if (!build.offer) {
            const o = rollOffer(build, rng);
            if (!o.length) continue;      // everything is maxed out
            build.offer = o;
            opened = true;
        } else build.pending++;
    }
    build.v++;
    return opened;
}
// Catch the build up with a board score. -> how many picks it just earned.
function syncScore(build, score, rng = Math.random) {
    if (!build) return 0;
    const n = earnedAt((+score || 0) - (+build.base || 0)) - (build.granted | 0);
    if (n <= 0) return 0;
    build.granted += n;
    grant(build, n, rng);
    return n;
}
// Take perk `id` off the current offer. Anything that isn't on it is
// refused, so a client can't pick what it wasn't shown. The next queued
// offer rolls straight away.
function pick(build, id, rng = Math.random) {
    if (!build || !build.offer || typeof id !== 'string') return false;
    if (!build.offer.includes(id)) return false;
    const p = BY_ID.get(id);
    if (!p || (build.perks[id] | 0) >= p.max || totalPicks(build) >= MAX_PICKS) return false;
    build.perks[id] = (build.perks[id] | 0) + 1;
    build.offer = null;
    while (build.pending > 0 && !build.offer) {
        build.pending--;
        const o = rollOffer(build, rng);
        if (!o.length) { build.pending = 0; break; }
        build.offer = o;
    }
    build.v++;
    return true;
}
// A bot just takes one at random from what it was offered.
function botPick(build, rng = Math.random) {
    if (!build || !build.offer || !build.offer.length) return false;
    return pick(build, build.offer[Math.floor(rng() * build.offer.length)], rng);
}

// What the client is sent (the PK packet).
function snapshot(build) {
    const b = build || newBuild();
    const list = perkList(b).map(p => ({ id: p.id, n: p.n, max: p.max, name: p.name, desc: BY_ID.get(p.id).desc }));
    const full = totalPicks(b) + (b.offer ? 1 : 0) + (b.pending | 0) >= MAX_PICKS;
    const at = full ? 0 : nextAt(b.granted);
    const next = at ? at + (+b.base || 0) : 0;
    return { o: describeOffer(b), q: b.pending | 0, b: list, g: b.granted | 0, next, step: at ? at - pickAt(b.granted | 0) : 0, max: MAX_PICKS, v: b.v | 0 };
}

// The effect table every hook reads (body._pkfx). Null for an empty build,
// so the hooks cost nothing for most bodies.
function computeFx(perks) {
    const n = (id) => (perks && perks[id]) | 0;
    let any = false;
    for (const p of CATALOG) if (n(p.id) > 0) { any = true; break; }
    if (!any) return null;
    const mine = 1 + 0.2 * n('drill');
    return {
        mine,
        budget: mine * (1 + 0.2 * n('twin') + 0.15 * n('drones')),
        magnet: 1 + 0.4 * n('magnet'),
        satchel: n('satchel'),
        speed: 1 + 0.06 * n('speed'),
        health: 1 + 0.07 * n('hide'),
        reload: 1 + 0.05 * n('reload'),
        value: 1 + 0.12 * n('rich'),
        blastR: n('blast') ? 60 + 30 * n('blast') : 0,
        chain: n('chain'),
        pierce: n('pierce'),
        crit: Math.min(0.6, 0.12 * n('crit')),
        regen: 0.012 * n('regen'),
        quake: n('quake'),
        twin: n('twin'),
        drones: n('drones'),
        grind: 1 + 0.25 * n('grind'),
        prospector: n('prospector'),
        shatter: 0.18 * n('shatter'),
        chipper: 1 + 0.25 * n('chipper'),
        tractor: 1 + 0.3 * n('tractor'),
        stormward: Math.max(0.2, 1 - 0.15 * n('stormward')),
        surge: 0.08 * n('surge'),
        aegis: 1 + 0.15 * n('aegis'),
        velocity: 1 + 0.06 * n('velocity'),
    };
}

// ── on a live body ───────────────────────────────────────────────────────

const alive = (b) => !!b && !b.isGhost && !(b.isDead && b.isDead());

// Put a build on a body: multipliers, satchel size, the hidden guns. The
// health bar keeps its fraction, so a fresh body that gets Thick Hide a
// moment after spawning isn't drawn hurt.
function applyToBody(body, build) {
    if (!body) return;
    const fx = computeFx(build ? build.perks : null);
    const had = body._pkfx;
    body._pkfx = fx;
    body._pkV = build ? build.v : -1;
    body._pkBuild = build || null;
    if (!fx && !had && !(body._pkGuns && body._pkGuns.length)) return;
    let frac = 1;
    try { if (body.health && body.health.max > 0) frac = Math.max(0, Math.min(1, body.health.amount / body.health.max)); } catch { /* */ }
    try { require('./shop.js').applyPassives(body); } catch { /* */ }
    try { if (body.health && body.health.max > 0 && alive(body)) body.health.amount = body.health.max * frac; } catch { /* */ }
    try { require('./gems.js').updateSatchel(body); } catch { /* */ }
    try { attachGuns(body); } catch (e) { /* the build still works without the barrels */ }
}
function clearBody(body) {
    if (!body) return;
    applyToBody(body, null);
}

// Extra barrels
function mainBarrels(body) {
    const out = [];
    if (!body || !body.guns) return out;
    for (const gun of body.guns.values()) {
        if (!gun || gun.isRaidPerk || gun.isSidearm || !gun.canShoot || gun.hidden) continue;
        if (!gun.bulletType || gun.bulletType.TYPE !== 'bullet' || !gun.settings || !(gun.settings.reload > 0)) continue;
        out.push(gun);
    }
    return out;
}
const TWIN_SPREAD = 5;
function twinDef(src, i, stats) {
    const side = i % 2 ? -1 : 1;
    const delay = i === 2 ? 0.5 : (i ? 0.75 : 0.25);
    const settings = { ...stats, recoil: 0 };
    if (!src) return { POSITION: [16, 8, 1, 0, 0, side * TWIN_SPREAD, delay], settings };
    const len = src.offset * 10;
    settings.size = src.settings.size;
    settings.speed = src.settings.speed;
    settings.maxSpeed = src.settings.maxSpeed;
    settings.range = src.settings.range;
    return {
        POSITION: [src.length * 10, src.width * 10, src.aspect, len * Math.cos(src.direction), len * Math.sin(src.direction), src.angle * 180 / Math.PI + side * TWIN_SPREAD, delay],
        settings,
    };
}
function gunDefs(fx, body) {
    const { combineStats } = require('../../lib/definitions/facilitators.js');
    const g = require('../../lib/definitions/gunvals.js');
    const out = [];
    if (!fx) return out;
    const real = mainBarrels(body);
    const stats = combineStats([g.basic, { reload: 1.15, damage: 0.5 }]);
    for (let i = 0; i < Math.min(3, fx.twin); i++) {
        const d = twinDef(real.length ? real[i % real.length] : null, i, stats);
        out.push({
            POSITION: d.POSITION,
            PROPERTIES: {
                SHOOT_SETTINGS: d.settings,
                TYPE: "bullet", LABEL: "Twin Drill", COLOR: "mirror", HIDDEN: true, ROCK_ONLY: true,
            },
        });
    }
    const droneSlots = [[7, -4.5, 90, 0], [7, 4.5, 270, 0.5], [7, 4.5, 90, 0.25], [7, -4.5, 270, 0.75], [6, -6, 120, 0.12], [6, 6, 240, 0.62]];
    for (let i = 0; i < Math.min(6, fx.drones * 2); i++) {
        const [x, y, ang, delay] = droneSlots[i];
        out.push({
            POSITION: [9, 7, 0.7, x, y, ang, delay],
            PROPERTIES: {
                SHOOT_SETTINGS: combineStats([g.swarm, { reload: 0.8, damage: 0.6 }]),
                TYPE: "swarm", LABEL: "Drone Bay", COLOR: 16, HIDDEN: true, ROCK_ONLY: true,
                STAT_CALCULATOR: "swarm", MAX_CHILDREN: 5,
            },
        });
    }
    return out;
}
function detachGuns(body) {
    for (const gun of body._pkGuns || []) {
        try {
            for (const child of [...gun.children, ...gun.bulletchildren]) {
                if (child && !child.isGhost) { try { child.kill(); } catch { /* */ } }
            }
            body.guns.delete(gun.id);
            const i = body.gunsArrayed.indexOf(gun);
            if (i >= 0) body.gunsArrayed.splice(i, 1);
        } catch { /* */ }
    }
    body._pkGuns = [];
}
function gunKey(fx) { return fx ? (fx.twin | 0) + '/' + (fx.drones | 0) : '0/0'; }
function attachGuns(body) {
    if (!alive(body) || typeof Gun === 'undefined' || !body.guns) return;
    const want = gunKey(body._pkfx);
    const live = (body._pkGuns || []).every(gun => body.guns.get(gun.id) === gun);
    if (body._pkGunKey === want && live) return;
    detachGuns(body);
    body._pkGunKey = want;
    for (const def of gunDefs(body._pkfx, body)) {
        const gun = new Gun(body, def);
        gun.isRaidPerk = true;
        body.guns.set(gun.id, gun);
        body.gunsArrayed.push(gun);
        if (gun.syncChildren) gun.syncChildren();
        body._pkGuns.push(gun);
    }
    try { body.syncSkillsToGuns && body.syncSkillsToGuns(); } catch { /* */ }
    body.photo = undefined;
    // an evolution rebuilds the gun list: the perk barrels go back on
    if (!body._pkGunHooked && body.on) {
        body._pkGunHooked = true;
        body.on('define', () => {
            body._pkGunKey = null;
            body._pkGuns = [];
            setImmediate(() => { try { if (alive(body)) { attachGuns(body); } } catch { /* */ } });
        });
    }
}

// ── shots on rock (game/index.js) ────────────────────────────────────────

const scratch = [];
function tgOf() { return global.gameManager && global.gameManager.terrainGrid; }

// FX for whoever can see (x, y). Kinds: pkblast r, pkchain x1 y1 x2 y2...,
// pkquake r, pkcrit (the shooter only).
const FX_RANGE = 1800;
function fxNear(x, y, kind, ...extra) {
    const clients = (global.gameManager && global.gameManager.socketManager && global.gameManager.socketManager.clients) || [];
    for (const c of clients) {
        const cam = c && c.camera;
        if (!cam || Math.abs(cam.x - x) > FX_RANGE || Math.abs(cam.y - y) > FX_RANGE) continue;
        try { c.talk('FX', Math.round(x), Math.round(y), kind, ...extra); } catch { /* */ }
    }
}

// Damage one rock the way a shot would, ore payout included. A plain rock
// broken by a splash doesn't count toward rocksMined: that counter also
// drives the dry-streak copper (gems.pityBurst), and a blast breaking five
// rocks at once would farm it.
function breakRock(tg, rock, dmg, owner, x, y) {
    if (!rock || !(rock.alive || rock.growing) || !(dmg > 0)) return false;
    const gems = require('./gems.js');
    const wasGrowing = rock.growing;
    const destroyed = tg.damageRock(rock, dmg, x, y, false, owner);
    if (destroyed && !wasGrowing && rock.ore) {
        if (owner) {
            owner.rocksMined = (owner.rocksMined || 0) + 1;
            owner.gemsMined = (owner.gemsMined || 0) + 1;
        }
        gems.spawnOreBurst(rock, owner);
    }
    return destroyed;
}
const rockX = (r) => r.worldCx || r.wx;
const rockY = (r) => r.worldCy || r.wy;

// Lucky Strike: rolled once per shot, so a shot on a seam is one crit.
function critMult(shot, owner) {
    const fx = owner && owner._pkfx;
    if (!fx || !(fx.crit > 0)) return 1;
    if (shot._pkCrit === undefined) {
        shot._pkCrit = Math.random() < fx.crit ? 3 : 1;
        if (shot._pkCrit > 1 && owner.socket) {
            const t = Date.now();
            if (t - (owner._pkCritFxAt || 0) > 150) {
                owner._pkCritFxAt = t;
                try { owner.socket.talk('FX', Math.round(shot.x), Math.round(shot.y), 'pkcrit'); } catch { /* */ }
            }
        }
    }
    return shot._pkCrit;
}

// A piercing shot keeps going: drop the rocks it already went through.
function skipPassed(shot, hitRocks) {
    const seen = shot._pkHit;
    if (!seen) return;
    let w = 0;
    for (let i = 0; i < hitRocks.length; i++) if (!seen.has(hitRocks[i].k)) hitRocks[w++] = hitRocks[i];
    hitRocks.length = w;
}

// After a shot has done its normal damage to hitRocks: Blast Rounds and
// Chain Spark add rock damage around it, then Piercing Rounds may keep the
// shot going. -> true when the shot lives on.
const PIERCE_TANK_DAMAGE = 0.6;   // a shot that went through rock hits a tank softer
function afterRockHit(shot, owner, hitRocks, tg, raw) {
    const fx = owner && owner._pkfx;
    if (!fx || !tg || owner.royaleLobby) return false;
    const t = Date.now();
    const x = shot.x, y = shot.y;
    if (fx.shatter > 0 && hitRocks.length) {
        for (const hr of hitRocks) {
            if (!hr || hr.alive || hr.growing) continue;
            if (tg.rocksHitByCircle) {
                const hx = rockX(hr), hy = rockY(hr);
                scratch.length = 0;
                const nbs = tg.rocksHitByCircle(hx, hy, 110, scratch).slice();
                scratch.length = 0;
                for (const nb of nbs) {
                    if (nb === hr || hitRocks.includes(nb)) continue;
                    breakRock(tg, nb, (nb.maxHealth || raw) * fx.shatter, owner, rockX(nb), rockY(nb));
                }
            }
        }
    }
    if (fx.blastR > 0 && t - (owner._pkBlastAt || 0) >= 90) {
        owner._pkBlastAt = t;
        scratch.length = 0;
        const near = tg.rocksHitByCircle(x, y, fx.blastR, scratch).slice();
        scratch.length = 0;
        let broke = 0;
        for (const rock of near) {
            if (hitRocks.includes(rock)) continue;
            if (breakRock(tg, rock, raw * 0.45, owner, rockX(rock), rockY(rock))) broke++;
        }
        if (broke >= 3 && owner.socket && global.royaleAch) global.royaleAch.onPerkBurst(owner, broke);
        fxNear(x, y, 'pkblast', Math.round(fx.blastR));
    }
    if (fx.chain > 0 && t - (owner._pkChainAt || 0) >= 220 && Math.random() < 0.25 + 0.1 * fx.chain) {
        owner._pkChainAt = t;
        const R = 280;
        const cands = [];
        scratch.length = 0;
        for (const rock of tg.rocksHitByCircle(x, y, R, scratch)) {
            if (hitRocks.includes(rock) || !rock.alive) continue;
            const rx = rockX(rock), ry = rockY(rock);
            cands.push({ rock, d: (rx - x) ** 2 + (ry - y) ** 2, rx, ry });
        }
        scratch.length = 0;
        cands.sort((a, b) => a.d - b.d);
        const arcs = [];
        let broke = 0;
        for (const c of cands.slice(0, 1 + fx.chain)) {
            if (breakRock(tg, c.rock, raw * 0.6, owner, c.rx, c.ry)) broke++;
            arcs.push(Math.round(c.rx), Math.round(c.ry));
        }
        if (broke >= 3 && owner.socket && global.royaleAch) global.royaleAch.onPerkBurst(owner, broke);
        if (arcs.length) fxNear(x, y, 'pkchain', ...arcs);
    }
    if (fx.pierce > 0 && (shot._pkPierced | 0) < fx.pierce) {
        if (!shot._pkPierced && shot.damage > 0) shot.damage *= PIERCE_TANK_DAMAGE;
        shot._pkPierced = (shot._pkPierced | 0) + 1;
        const seen = shot._pkHit || (shot._pkHit = new Set());
        for (const rock of hitRocks) seen.add(rock.k);
        return true;
    }
    return false;
}

// ── per body, a few times a second (dig_royale.js) ───────────────────────

const REGEN_CALM_MS = 5000;
// Field Repair and Seismic Pulse. dt in ms.
function tickBody(body, t, dt) {
    const fx = body && body._pkfx;
    if (!fx || !alive(body) || body.royaleLobby || body.royaleFrozen) return;
    if (body._pkSurgeUntil && t >= body._pkSurgeUntil) {
        body._pkSurgeUntil = 0;
        try { require('./shop.js').applyPassives(body); } catch { /* */ }
    }
    if (fx.regen > 0 && body.health && body.health.amount < body.health.max &&
        t - Math.max(body._lastDamageAt || 0, body.hitAt || 0) >= REGEN_CALM_MS) {
        body.health.amount = Math.min(body.health.max, body.health.amount + body.health.max * fx.regen * dt / 1000);
    }
    if (fx.quake > 0) {
        if (!body._pkQuakeAt) body._pkQuakeAt = t + 2500;
        if (t >= body._pkQuakeAt) {
            body._pkQuakeAt = t + (fx.quake >= 2 ? 5000 : 7000);
            if (body.burrowUntil && t < body.burrowUntil) return;
            if (body.padSafe || body.onVaultPad || body.vaultOnPad) return;
            const tg = tgOf();
            if (tg && tg.rocksHitByCircle) {
                const R = (body.realSize || 30) + 130 + 50 * fx.quake;
                scratch.length = 0;
                const near = tg.rocksHitByCircle(body.x, body.y, R, scratch).slice();
                scratch.length = 0;
                for (const rock of near) {
                    breakRock(tg, rock, rock.maxHealth * (0.3 + 0.1 * fx.quake), body, rockX(rock), rockY(rock));
                }
                fxNear(body.x, body.y, 'pkquake', Math.round(R));
            }
        }
    }
}

function onGemHeal(body) {
    const fx = body && body._pkfx;
    if (!fx) return;
    if (fx.surge > 0) {
        const had = !!(body._pkSurgeUntil && Date.now() < body._pkSurgeUntil);
        body._pkSurgeUntil = Date.now() + 3000;
        if (!had) { try { require('./shop.js').applyPassives(body); } catch { /* */ } }
    }
}

module.exports = {
    STEP, MAX_PICKS, OFFER_N, UPGRADE_W, CATALOG, BY_ID, pickAt, earnedAt, nextAt, newBuild, sanitize, rollOffer, describeOffer, perkList, totalPicks,
    grant, syncScore, pick, botPick, snapshot, computeFx, onDeath, DEATH_LOSS,
    applyToBody, clearBody, attachGuns, detachGuns, gunDefs,
    critMult, skipPassed, afterRockHit, breakRock, tickBody, onGemHeal, fxNear, PIERCE_TANK_DAMAGE,
};
