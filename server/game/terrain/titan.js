'use strict';

const L = require('./teamLayout.js');
const { IO, ioTypes } = require('../../miscFiles/controllers.js');

const PROTECTOR_DAMAGE_MULT = 0.025;
const HP_BASE = 6000, HP_PER_FOE = 2000, HP_MIN = 10000, HP_MAX = 30000;
const WAYPOINT_R = 150;
const SIEGE_R = 170;
const SIEGE_HOLD_R = 700;
const ENGAGE_R = 520;
const SLAM_MS = 4000;
const SLAM_R = 680;
const SLAM_FRAC = 0.08;
const SLAM_PTS = 250;
const BOUNTY_PTS = 2000;
const BOUNTY_GEMS = 1200;
const DEATH_GEMS = 6000;
const COOLDOWN_MS = 90_000;
const CLEAR_AHEAD = 1.35;
const LEASH = 420;

let hooks = {};
const titans = new Map();
const cooldownUntil = new Map();

function attach(h) { hooks = Object.assign({}, hooks, h || {}); }
function hook(name, ...a) { try { return hooks[name] ? hooks[name](...a) : undefined; } catch (e) { console.error('[TITAN] hook ' + name, e && e.stack || e); return undefined; } }
const alive = b => !!b && !b.isGhost && !(b.isDead && b.isDead());
const rootOf = e => { let r = e, n = 0; while (r && r.master && r.master !== r && n++ < 8) r = r.master; return r; };
function teamMode() { return require('./teamMode.js'); }

function segPoint(a, b, x, y) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
    return { x: a.x + dx * k, y: a.y + dy * k };
}

class io_titanMarch extends IO {
    constructor(body, opts = {}) {
        super(body);
        this.opts = opts;
    }
    think(input) {
        const b = this.body;
        const path = b.titanPath;
        if (!path || !path.length || b.royaleFrozen) return { goal: { x: b.x, y: b.y }, power: 0 };
        let i = b.titanWp | 0;
        while (i < path.length - 1 && Math.hypot(path[i].x - b.x, path[i].y - b.y) < WAYPOINT_R) i++;
        b.titanWp = i;
        const goal = path[i];
        const last = i === path.length - 1;
        const toGoal = Math.hypot(goal.x - b.x, goal.y - b.y);
        if (last && (toGoal < SIEGE_R || (b.titanSieging && toGoal < SIEGE_HOLD_R))) {
            b.titanState = 'siege';
            if (toGoal > 60) return { goal, power: 0.35 };
            return { goal: { x: b.x, y: b.y }, power: 0 };
        }
        const prev = path[Math.max(0, i - 1)];
        const onLane = segPoint(prev, goal, b.x, b.y);
        const off = Math.hypot(onLane.x - b.x, onLane.y - b.y);
        const fighting = !!(input.target && (input.main || input.alt));
        const near = fighting && Math.hypot(input.target.x, input.target.y) < ENGAGE_R;
        b.titanState = fighting ? 'fight' : 'march';
        const want = near ? 0.35 : fighting ? 0.6 : 1;
        b.titanPower = (b.titanPower || want) + (want - (b.titanPower || want)) * 0.08;
        if (off >= LEASH) return { goal: onLane, power: Math.max(0.6, b.titanPower) };
        return { goal, power: b.titanPower };
    }
}
ioTypes.titanMarch = io_titanMarch;

function cooldownLeft(team, t = Date.now()) { return Math.max(0, (cooldownUntil.get(team) || 0) - t); }

function aliveFor(team) {
    const o = titans.get(team);
    return alive(o) ? o : null;
}

function intoTitan(titan, attacker, dmg) {
    const root = rootOf(attacker);
    const prot = !!(root && (root.isRoyaleProtector || root.label === 'Base'));
    return dmg * (titan.titanArmor || 1) * (prot ? PROTECTOR_DAMAGE_MULT : 1);
}

function launch(team, laneName, caller, t = Date.now()) {
    if (!L.isTeam(team) || aliveFor(team) || cooldownLeft(team, t) > 0) return null;
    const path = L.lane(team, laneName);
    const start = path[0];
    let o;
    try {
        o = new Entity({ x: start.x, y: start.y });
        o.define(team === L.BLUE ? 'royaleTitanBlue' : 'royaleTitanRed');
    } catch (e) { console.error('[TITAN] spawn', e && e.stack || e); return null; }
    o.team = team;
    o.color.base = team === L.BLUE ? 'blue' : 'red';
    o.isTitan = true;
    o.titanTeam = team;
    o.baseImmune = true;
    o.alwaysActive = true;
    o.bossDigs = true;
    o.bossDigRate = 0.45;
    o.titanPath = path;
    o.titanLane = laneName === 'flank' ? 'flank' : 'middle';
    o.titanWp = 0;
    o.titanState = 'march';
    o.titanBornAt = t;
    o.titanSlamAt = t + SLAM_MS;
    o.titanSieging = false;
    o.titanCaller = caller ? (caller.name || '') : '';
    o.titanDamage = new Map();
    o.name = L.teamName(team) + " Titan";
    try { o.refreshBodyAttributes(); } catch { /* */ }
    let foes = 0;
    for (const e of (hooks.fighters ? hooks.fighters() : [])) if (alive(e) && e.team !== team) foes++;
    const hp = Math.round(Math.max(HP_MIN, Math.min(HP_MAX, HP_BASE + HP_PER_FOE * foes)));
    o.titanArmor = Math.min(1, Math.max(0.01, ((o.health && o.health.max) || hp) / hp));
    if (o.shield) { o.shield.max = 0; o.shield.amount = 0; }
    o.on('damage', ({ damageInflictor = [], damageTotal = 0 } = {}) => {
        let root = null;
        for (const s of damageInflictor) { const r = rootOf(s); if (r && r.team !== o.team && (r.isPlayer || r.isBot)) { root = r; break; } }
        if (!root) return;
        const amount = damageTotal > 0 ? damageTotal : 1;
        const prev = o.titanDamage.get(root) || 0;
        o.titanDamage.set(root, prev + amount);
    });
    o.on('dead', () => onDead(o));
    titans.set(team, o);
    hook('fx', start.x, start.y, 'titanrise', L.teamNo(team));
    return o;
}

function killerTeamOf(o) {
    for (const k of o.finalKillers || []) {
        const r = rootOf(k);
        if (r && L.isTeam(r.team) && r.team !== o.team) return r.team;
    }
    let best = 0, bestTeam = 0;
    const by = new Map();
    for (const [body, d] of o.titanDamage) if (body && L.isTeam(body.team) && body.team !== o.team) by.set(body.team, (by.get(body.team) || 0) + d);
    for (const [team, d] of by) if (d > best) { best = d; bestTeam = team; }
    return bestTeam;
}

function erupt(x, y, total) {
    let gems = null;
    try { gems = require('./gems.js'); } catch { return 0; }
    const pieces = gems.splitValue(total, { share: { 4: 0.25, 3: 0.35, 2: 0.25, 1: 0.15 }, shardValue: 150, maxPieces: 80 });
    const t = Date.now();
    pieces.forEach((p, i) => {
        const ang = (i / pieces.length) * Math.PI * 2 * 3 + Math.random() * 0.6;
        const sp = 4 + Math.random() * 10;
        const g = gems.spawnGem(x + Math.cos(ang) * 60, y + Math.sin(ang) * 60, p.v, p.cls, p.size, Math.cos(ang) * sp, Math.sin(ang) * sp, p.ore);
        if (g) { g.gemNoMagnetUntil = t + 900 + (i % 30) * 25; g.gemLong = true; }
    });
    return pieces.length;
}

function onDead(o) {
    if (titans.get(o.titanTeam) === o) titans.delete(o.titanTeam);
    if (o._titanEnded) return;
    o._titanEnded = true;
    cooldownUntil.set(o.titanTeam, Date.now() + COOLDOWN_MS);
    hook('fx', o.x, o.y, 'titandown', L.teamNo(o.titanTeam));
    try { erupt(o.x, o.y, DEATH_GEMS); } catch (e) { console.error('[TITAN] erupt', e && e.stack || e); }
    const team = killerTeamOf(o);
    if (!team) return;
    teamMode().onTitanKilled(o, team, BOUNTY_PTS);
    let total = 0;
    const shares = [];
    for (const [body, d] of o.titanDamage) if (body && body.team === team && alive(body)) { total += d; shares.push([body, d]); }
    if (total > 0) for (const [body, d] of shares) {
        const gemsN = Math.max(10, Math.round(BOUNTY_GEMS * d / total / 5) * 5);
        hook('payGems', body, gemsN, 'titan');
    }
    hook('teamCallout', team, 'titandown', "Titan down!", "Your team took down the " + o.name + ". +" + BOUNTY_PTS.toLocaleString('en-US') + " team points.", 3600);
    hook('teamCallout', o.titanTeam, 'titanlost', "Your Titan fell", "The " + L.teamName(team) + " team brought it down. A new one can be called in " + Math.round(COOLDOWN_MS / 1000) + " seconds.", 3600);
}

function keepOutOfBase(o) {
    const r = L.baseRect(L.other(o.team));
    if (!r) return;
    const pad = (o.realSize || 80) + 40;
    if (!L.inRect(r, o.x, o.y, pad)) return;
    const opts = [
        { d: o.x - (r.x0 - pad), x: r.x0 - pad, y: o.y, nx: -1, ny: 0 },
        { d: (r.x1 + pad) - o.x, x: r.x1 + pad, y: o.y, nx: 1, ny: 0 },
        { d: o.y - (r.y0 - pad), x: o.x, y: r.y0 - pad, nx: 0, ny: -1 },
        { d: (r.y1 + pad) - o.y, x: o.x, y: r.y1 + pad, nx: 0, ny: 1 },
    ].sort((a, b) => a.d - b.d)[0];
    o.x = opts.x; o.y = opts.y;
    const vd = o.velocity.x * opts.nx + o.velocity.y * opts.ny;
    if (vd < 0) { o.velocity.x -= vd * opts.nx; o.velocity.y -= vd * opts.ny; }
}

function clearRock(o) {
    const tg = global.gameManager && global.gameManager.terrainGrid;
    if (!tg || !tg.rockHitByCircle || !tg.damageRock) return;
    const r = (o.realSize || 120) * CLEAR_AHEAD;
    const sp = Math.hypot(o.velocity.x, o.velocity.y);
    const ax = sp > 0.1 ? o.velocity.x / sp : Math.cos(o.facing || 0), ay = sp > 0.1 ? o.velocity.y / sp : Math.sin(o.facing || 0);
    const spots = [[o.x, o.y], [o.x + ax * r * 0.6, o.y + ay * r * 0.6]];
    for (const [x, y] of spots) {
        for (let k = 0; k < 6; k++) {
            const rock = tg.rockHitByCircle(x, y, r);
            if (!rock) break;
            try {
                const destroyed = tg.damageRock(rock, (rock.maxHealth || 100) * 4, x, y, false, null);
                if (destroyed && rock.ore) require('./gems.js').spawnOreBurst(rock, null);
                if (!destroyed) break;
            } catch { break; }
        }
    }
}

function slam(o, t) {
    o.titanSlamAt = t + SLAM_MS;
    const R2 = SLAM_R * SLAM_R;
    let hit = 0;
    for (const e of (hooks.fighters ? hooks.fighters() : [])) {
        if (!alive(e) || e.team === o.team || e.isTitan) continue;
        const dx = e.x - o.x, dy = e.y - o.y, d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        const max = (e.health && e.health.max) || 100;
        e.damageReceived = (e.damageReceived || 0) + max * SLAM_FRAC;
        if (Array.isArray(e.collisionArray)) e.collisionArray.push(o);
        const d = Math.sqrt(d2) || 1;
        e.velocity.x += dx / d * 14;
        e.velocity.y += dy / d * 14;
        hit++;
    }
    teamMode().onSiege(o.team, SLAM_PTS);
    hook('fx', o.x, o.y, 'titanslam', L.teamNo(o.team));
    return hit;
}

function tick(t = Date.now()) {
    for (const [team, o] of titans) {
        if (!alive(o)) { titans.delete(team); continue; }
        keepOutOfBase(o);
        if (t - (o._titanClearAt || 0) >= 90) { o._titanClearAt = t; clearRock(o); }
        if (o.health) o.health.regen = 0;
        if (o.shield && o.shield.max) { o.shield.max = 0; o.shield.amount = 0; }
        if (o.titanState === 'siege') {
            if (!o.titanSieging) {
                o.titanSieging = true;
                o.titanSlamAt = t + 1500;
                hook('teamCallout', L.other(team), 'titansiege', "The " + o.name + " is at your base", "Get back and take it down!", 3600);
                hook('teamCallout', team, 'titansiege', "Your Titan reached their base", "Every slam it lands scores for your team.", 3000);
            }
            if (t >= o.titanSlamAt) slam(o, t);
        }
    }
}

function snapshot() {
    const out = [];
    for (const [team, o] of titans) {
        if (!alive(o)) continue;
        const hp = o.health && o.health.max ? o.health.amount / o.health.max : 1;
        out.push({ e: o.id, t: L.teamNo(team), x: Math.round(o.x), y: Math.round(o.y), hp: Math.round(hp * 1000) / 1000, lane: o.titanLane, st: o.titanState || 'march', n: o.name });
    }
    return out;
}

function reset() { cooldownUntil.clear(); }

function clearAll() {
    for (const o of titans.values()) { try { o._titanEnded = true; o.kill(); } catch { /* */ } }
    titans.clear();
}

module.exports = { PROTECTOR_DAMAGE_MULT, BOUNTY_PTS, SLAM_PTS, COOLDOWN_MS, attach, launch, tick, snapshot, aliveFor, cooldownLeft, intoTitan, clearAll, reset };
