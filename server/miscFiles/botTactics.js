// The fighting half of a lock-on bot (controllers.js io_digWarsGoals calls
// in here): where to aim so the shot meets a moving tank, which incoming
// bullet to sidestep, which rock to duck behind, and who is worth hunting.
// Everything scales with botDifficulty.tactics(d), so a bot facing a
// newcomer or a player under mercy never does any of it.
//
// ROYALE_BOT_TACTICS=0 turns off the dodging, cover, jukes, chases and
// third-partying (the aim lead and the targeting stay with the lock-on and
// hunt switches).
'use strict';

const TICK_MS = 1000 / 30;

let enabled = process.env.ROYALE_BOT_TACTICS !== '0';
let hunt = process.env.ROYALE_BOT_HUNT !== '0';
function setEnabled(v) { enabled = !!v; }
function setHunt(v) { hunt = !!v; }
function isEnabled() { return enabled; }
function huntOn() { return hunt; }

// ── aim ──────────────────────────────────────────────────────────────────
// Where a tank really goes, per tick, from its last few positions. An
// entity's velocity field reads low (the engine adds acceleration after
// friction), and a dash or a knockback never shows in it at all.
function trackVelocity(state, e, now) {
    let t = state.trk;
    if (!t || t.id !== e.id || now - t.at > 400) {
        t = state.trk = { id: e.id, x: e.x, y: e.y, at: now, vx: e.velocity?.x || 0, vy: e.velocity?.y || 0 };
        return t;
    }
    const dt = (now - t.at) / TICK_MS;
    if (dt >= 0.5) {
        const k = Math.min(1, 0.55 * dt);
        t.vx += ((e.x - t.x) / dt - t.vx) * k;
        t.vy += ((e.y - t.y) / dt - t.vy) * k;
        t.x = e.x; t.y = e.y; t.at = now;
    }
    return t;
}

// Smallest t >= 0 with |p + v t| = s t + m (m: the muzzle head start), or
// -1 when the shot can never catch up.
function intercept(px, py, vx, vy, s, m) {
    const a = vx * vx + vy * vy - s * s;
    const b = 2 * (px * vx + py * vy) - 2 * s * m;
    const c = px * px + py * py - m * m;
    if (Math.abs(a) < 1e-6) return b < 0 ? -c / b : -1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
    const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
    return lo >= 0 ? lo : hi >= 0 ? hi : -1;
}

// Bullets leave the barrel at v0 and slow toward their cruise speed s by
// a share every tick (measured: about 0.953 for every gun). Distance flown
// after t ticks:
const SLOW = 0.953;
function flown(t, s, v0) {
    return s * t + (v0 - s) * (1 - Math.pow(SLOW, t)) / (1 - SLOW);
}

// The aim offset (world units from the bot) that meets `e` with a shot
// leaving at `v0` and cruising at `s` per tick, or null. `out` is reused.
function leadPoint(state, bot, e, s, v0, now, out) {
    if (!(s > 0)) return null;
    if (!(v0 > s)) v0 = s;
    const v = trackVelocity(state, e, now);
    const px = e.x - bot.x, py = e.y - bot.y;
    // bullets start at the barrel tip
    const muzzle = (bot.realSize || bot.size || 20) * 1.5;
    // a constant-speed guess, then a few Newton steps on the real curve
    let t = intercept(px, py, v.vx, v.vy, (s + v0) / 2, muzzle);
    if (t < 0) t = Math.hypot(px, py) / v0;
    for (let i = 0; i < 4; i++) {
        const fx = px + v.vx * t, fy = py + v.vy * t;
        const need = Math.hypot(fx, fy) - muzzle;
        const f = flown(t, s, v0) - need;
        const df = s + (v0 - s) * Math.pow(SLOW, t) - (fx * v.vx + fy * v.vy) / (need + muzzle || 1);
        if (!(df > 0.05)) break;
        t = Math.max(0, t - f / df);
    }
    if (!(t >= 0) || t > 120) return null;
    out.x = px + v.vx * t;
    out.y = py + v.vy * t;
    return out;
}

// ── incoming fire ────────────────────────────────────────────────────────
// Rebuilt with the shared bot scan (controllers.js botWorldScan): every
// live bullet and swarm, bucketed by 400 unit cells.
const CELL = 400;
function cellKey(cx, cy) { return (cx + 4096) * 8192 + (cy + 4096); }
function rootOf(e) {
    let r = e, hops = 0;
    while (r && r.master && r.master !== r && hops++ < 8) r = r.master;
    return r || e;
}
function isShot(e) {
    return (e.type === 'bullet' || e.type === 'swarm') && !e.isDead?.() && e.velocity;
}
function bucketShots(list) {
    const grid = new Map();
    for (const e of list) {
        const k = cellKey(Math.floor(e.x / CELL), Math.floor(e.y / CELL));
        const cell = grid.get(k);
        if (cell) cell.push(e); else grid.set(k, [e]);
    }
    return grid;
}

// The most urgent enemy shot about to hit `bot` within `horizon` ticks:
// { ax, ay } a unit sidestep, or null.
function threat(bot, grid, horizon = 22) {
    if (!grid || !grid.size) return null;
    const r = (bot.realSize || bot.size || 20) + 10;
    const cx = Math.floor(bot.x / CELL), cy = Math.floor(bot.y / CELL);
    const bvx = bot.velocity?.x || 0, bvy = bot.velocity?.y || 0;
    let best = null, bestT = Infinity;
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            const cell = grid.get(cellKey(cx + i, cy + j));
            if (!cell) continue;
            for (const s of cell) {
                if (s.isDead?.()) continue;
                const root = rootOf(s);
                if (!root || root === bot || root.team === bot.team) continue;
                const px = s.x - bot.x, py = s.y - bot.y;
                const vx = s.velocity.x - bvx, vy = s.velocity.y - bvy;
                const vv = vx * vx + vy * vy;
                if (vv < 1) continue;
                const t = -(px * vx + py * vy) / vv;
                if (t <= 0 || t > horizon || t >= bestT) continue;
                const mx = px + vx * t, my = py + vy * t;
                const reach = r + (s.realSize || s.size || 6);
                if (mx * mx + my * my > reach * reach) continue;
                bestT = t;
                // step away from where it passes; dead centre: either side
                const vl = Math.sqrt(vv);
                let nx = -vy / vl, ny = vx / vl;
                if (nx * mx + ny * my > 0) { nx = -nx; ny = -ny; }
                best = { ax: nx, ay: ny, t };
            }
        }
    }
    return best;
}

// ── cover ────────────────────────────────────────────────────────────────
// A spot just behind a rock, as seen from `enemy`, within `reach` of the
// bot: { x, y, rock } or null. Peeking is the caller's rhythm.
function coverSpot(bot, enemy, tg, reach = 340, out = []) {
    if (!tg || !tg.rocksHitByCircle) return null;
    out.length = 0;
    tg.rocksHitByCircle(bot.x, bot.y, reach, out);
    const r = (bot.realSize || bot.size || 20);
    let best = null, bestD = Infinity;
    for (const rock of out) {
        if (!rock || !rock.alive) continue;
        const rr = rock.maxPolyRadius || 50;
        if (rr < r * 0.9) continue;
        const ex = rock.wx - enemy.x, ey = rock.wy - enemy.y;
        const el = Math.hypot(ex, ey) || 1;
        // the rock must stand between us and them, not behind them
        if (el < 160) continue;
        const sx = rock.wx + ex / el * (rr + r + 14), sy = rock.wy + ey / el * (rr + r + 14);
        if (tg.rockHitByCircle(sx, sy, r * 0.9)) continue;
        const d = Math.hypot(sx - bot.x, sy - bot.y);
        if (d < bestD && d < reach) { bestD = d; best = { x: sx, y: sy, rock, rr }; }
    }
    return best;
}

// ── who to hunt ──────────────────────────────────────────────────────────
// How much nearer (world units) a player looks for what they carry and the
// raid's hunted mark. Newcomers and the soft window get the old trickle.
function carrierPull(root, lock) {
    const carried = Math.max(0, +root.carriedGems || 0);
    const old = Math.min(200, carried * 0.06);
    if (!hunt || !(lock > 0)) return old;
    const level = root.huntedLevel | 0;
    const pull = Math.min(900, Math.sqrt(carried) * 16) + level * 260;
    return old + (pull - old) * lock;
}
// A tank busy trading with someone else and losing health: easy pickings.
function thirdParty(root, now) {
    const hp = root.health?.max ? root.health.amount / root.health.max : 1;
    const busy = now - (root.hitAt || 0) < 2500 || now - (root._lastDamageAt || 0) < 2500;
    return busy && hp < 0.75 ? 1 - hp : 0;
}

// ── abilities ────────────────────────────────────────────────────────────
// Raid bots carry dash (everyone has it) plus one secondary ability from
// terrain/abilities.js, picked to suit the tank. Only that file's API is
// used: giveBot, use, cooldownLeft, canDash, dash.
// ROYALE_BOT_ABILITIES=0: no secondary, no bot dashes.
let abilitiesOn = process.env.ROYALE_BOT_ABILITIES !== '0';
function setAbilities(v) { abilitiesOn = !!v; }
function abilitiesEnabled() { return abilitiesOn; }
let api;
function abApi() {
    if (api === undefined) { try { api = require('../game/terrain/abilities.js'); } catch { api = null; } }
    return api && api.ON ? api : null;
}
// secondary ability pools by build
const KITS = {
    sniper:    ['smoke', 'grapple', 'wall'],
    brawler:   ['shock', 'rush', 'pad', 'grapple'],
    spray:     ['rush', 'shock', 'wall', 'pad', 'burrow'],
    artillery: ['wall', 'smoke', 'burrow'],
};
function kitOf(body) {
    const defs = (body.defs || []).join(' ').toLowerCase();
    if (/ranger|predator|hunter|musket|crossbow|assassin|sniper|rifle/.test(defs)) return 'sniper';
    if (/mortar|artillery|ordnance/.test(defs)) return 'artillery';
    if (/fighter|triangle|annihilator|hybrid|destroyer|nailgun|streamliner/.test(defs)) return 'brawler';
    return 'spray';
}
// Picks the bot's secondary (the least common one among `others` in its
// pool, ties at random) and hands it over. Returns the id or null.
function equipBot(body, others = [], rand = Math.random, same = null) {
    const ab = abApi();
    if (!abilitiesOn || !ab || !ab.giveBot || !body || body.socket || body.isRoyaleBoss) return null;
    // a bot respawning as itself gets its own ability back
    if (same && ab.giveBot(body, same)) { body.botAbility = same; return same; }
    const pool = KITS[kitOf(body)].filter(id => ab.AB_BY_ID ? ab.AB_BY_ID.has(id) : true);
    if (!pool.length) return null;
    const count = id => others.reduce((n, o) => n + (o && o !== body && o.botAbility === id && !o.isDead?.() ? 1 : 0), 0);
    let best = [], low = Infinity;
    for (const id of pool) {
        const c = count(id);
        if (c < low) { low = c; best = [id]; } else if (c === low) best.push(id);
    }
    const id = best[(rand() * best.length) | 0];
    if (!ab.giveBot(body, id)) return null;
    body.botAbility = id;
    return id;
}
function abReady(body, id) {
    const ab = abApi();
    if (!abilitiesOn || !ab || !id || body.padSafe || body.vaultOnPad || body.shopOnPad || body.royaleFrozen) return false;
    try {
        // a second burrow press surfaces early: never on purpose
        if (ab.burrowing && ab.burrowing(body)) return false;
        if (ab.canUse) return !!ab.canUse(body, id);
        return !(ab.cooldownLeft(body, id) > 0);
    } catch { return false; }
}
// how long a bot keeps its finger off the trigger after smoking up
function smokeHoldMs() {
    const ab = abApi();
    const ms = ab && ab.SMOKE && ab.SMOKE.ms || 3000;
    return Math.min(ms * 0.85, 5000);
}
function abUse(body, x, y, id) {
    const ab = abApi();
    if (!abilitiesOn || !ab || !ab.use) return false;
    try { return !!ab.use(body, x, y, id); } catch { return false; }
}
function abDash(body, dx, dy) {
    const ab = abApi();
    if (!abilitiesOn || !ab || !ab.dash) return false;
    try { return (!ab.canDash || ab.canDash(body)) && !!ab.dash(body, dx, dy); } catch { return false; }
}

// Inside a smoke cloud (abilities.js marks the body smokeHidden). Bots that
// were already on them keep shooting blind; nobody new picks them out
// unless they are right on top of them.
const SMOKE_SPOT_R = 160;
function smoked(root) { return !!(root && root.smokeHidden); }

module.exports = {
    SMOKE_SPOT_R, smoked,
    KITS, kitOf, equipBot, abReady, abUse, abDash, smokeHoldMs, setAbilities, abilitiesEnabled,
    TICK_MS, setEnabled, setHunt, isEnabled, huntOn,
    trackVelocity, intercept, flown, leadPoint, isShot, bucketShots, threat, coverSpot, carrierPull, thirdParty, rootOf,
};
