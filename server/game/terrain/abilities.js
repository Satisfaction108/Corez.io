// Dash and quick abilities (Dig Royale and the tutorial).
//
// Dash: everyone has it. A short burst along the movement keys (or the aim
// when standing still), DASH.charges charges that refill one at a time.
// Movement only: rock still stops you, and it gives no damage immunity.
//
// Abilities: one equipped slot, bought at a shop with banked gems and owned
// for the rest of the raid: every storm cycle, every death, a reconnect or a
// page reload (the raid ledger below keys it to the player). Every owned one
// can be swapped in for free on a shop pad (the Equip button, or the ability
// key while standing on one). Each has its own cooldown, which
// rides along. The next raid wipes all of it.
//
// Placed abilities (Launch Pad, Barricade, the Shockwave and Smoke throws)
// go where you aim, up to their `place` range; the client shows a preview
// while the key is held. The slot only changes through the shop panel's
// Equip button (or buying one): no key, pad or pickup swaps it.
//
// Everything is server side. The client asks with the 'ab' packet:
//   ['ab', 0]          dash
//   ['ab', 1, wx, wy]  use the equipped ability at a world spot
//   ['ab', 3, wx, wy]  Barricade preview: which cells would rise there
// and hears back:
//   'AB' JSON          your dash / ability state (talkState)
//   'AF' kind, x, y, a, b, id   an effect to draw (nearby clients)
//   'AR' JSON          radar contacts [[x, y, flags], ...]
//   'AW' JSON          the Barricade preview { g: rising keys, r: blocked keys }
//
// ROYALE_ABILITIES=0 switches all of it off: no dash, no ability slot, and
// the shop goes back to the old item list (shop.js).
'use strict';

const ON = process.env.ROYALE_ABILITIES !== '0';
// one random ability for free on your first spawn of every raid
const FREE_ON = process.env.ROYALE_FREE_ABILITY !== '0';
// only the showy ones; Radar, Burrow, Adrenaline and Barricade are shop-only
const FREE_POOL = ['grapple', 'pad', 'shock', 'smoke'];

const DASH = {
    charges: 2,
    rechargeMs: 5000,
    ms: 220,            // the burst itself; the glide after it is friction
    mult: 4.5,          // times the top speed (moves ~3.7x: the engine adds accel on top)
    minSpeed: 3.5,      // a slow (grown) tank still gets a real dash
    gapMs: 140,         // two dashes can't land on the same tick
};

// cd in ms. `trial` marks the ones a first bank can hand out for free;
// `place` is the range of the ones you put down where you aim.
const ABILITIES = [
    { id: "grapple", name: "Grapple Hook", price: 700,  cd: 9000,  trial: true,
      desc: "Fires a hook up to 900m away. If it catches rock or a tank, it yanks you straight there." },
    { id: "burrow",  name: "Burrow Drill", price: 900,  cd: 45000,
      desc: "Lets you dig underground through rock for up to 10 seconds. You're slower and can't shoot, and you can press it again to come up." },
    { id: "shock",   name: "Shockwave",    price: 900,  cd: 14000, trial: true, place: 550,
      desc: "Throws a shock grenade up to 550m away that shatters rock and launches every tank in the blast, including you. Only enemies take damage." },
    { id: "radar",   name: "Radar Ping",   price: 600,  cd: 22000, retired: true,
      desc: "Shows every tank within 2.5km on your screen and minimap for 10 seconds. Tanks carrying lots of gems glow gold." },
    { id: "wall",    name: "Barricade",    price: 700,  cd: 18000, place: 600,
      desc: "Raises a wall of rock where you aim, almost instantly. It stands for 20 seconds." },
    { id: "smoke",   name: "Smoke Bomb",   price: 600,  cd: 14000, trial: true, place: 550,
      desc: "Throws a smoke bomb up to 550m away that hides anyone inside the cloud for 11 seconds, boosts speed by 15%, and heals you a little." },
    { id: "rush",    name: "Adrenaline",   price: 1000, cd: 40000, trial: true,
      desc: "You fire 20% faster and move 15% faster for 8 seconds." },
    { id: "pad",     name: "Launch Pad",   price: 600,  cd: 16000, trial: true, place: 600,
      desc: "Puts a pad where you aim that flings anyone who touches it. It lasts 30 seconds." },
];
const AB_BY_ID = new Map(ABILITIES.map(a => [a.id, a]));

// The hook flies at flyPerMs (units per ms) and the yank starts when it
// bites. A miss reels back in backMs and spends no cooldown, only missLockMs.
const GRAPPLE = { range: 910, step: 18, speed: 28, maxMs: 1400, flyPerMs: 4, backMs: 250, missLockMs: 400 };
// a channel: cooldown = cdBase + cdPerSec for every second spent down
const BURROW = { maxMs: 6000, minMs: 600, speedMult: 0.75, cdBase: 45000, cdPerSec: 0, alpha: 0.6, surfaceR: 1.7 };
// A thrown orb (throwSpeed units per ms) that blows where it lands, or on
// the first rock or tank it touches. Everyone in `radius` is flung: k = 1 -
// d / reach, launch speed fling0 + fling1 * k^1.1 (units per tick), easing
// off by `decay` each tick for flingMs, the input locked meanwhile. Grown
// tanks fly a little less, never under bigMin. Damage (enemies only) falls
// off from hpNear to hpFar of max health.
const SHOCK = {
    radius: 430, breakR: 180, crackFrac: 0.35, throwSpeed: 1.0, orbR: 14,
    fling0: 22, fling1: 50, flingMs: 450, decay: 0.91, bigMin: 0.8, bossPush: 0.15,
    hpNear: 0.16, hpFar: 0.03,
};
const RADAR = { radius: 2500, ms: 10000, everyMs: 500, carrier: 400 };
// riseMs: how long the rock takes to come up
// count cells in a straight row across the aim line, centred on the spot
const WALL = { count: 5, ms: 20000, riseMs: 300, gapMs: 20 };
// thrown (throwSpeed units per ms); the cloud hides anyone standing in it
// for cloudMs, except while they shoot (the thrower gets graceMs first)
const SMOKE = { ms: 11000, cloudMs: 11000, radius: 380, graceMs: 1400, throwSpeed: 1.35, speedMult: 1.15, healPerTick: 0.001 };
const RUSH = { ms: 8000, fire: 1.2, speed: 1.15 };
const PAD = { ms: 30000, armMs: 250, radius: 62, launchMs: 400, mult: 4.5, perOwner: 2, againMs: 900 };
const PLACE_CLEAR = 46;     // a pad needs this much open ground under it
const TRIAL_MS = 120000;

// kit items that move you (shop.js sells them; the effects live here)
const ROCKET = { ms: 5000, speed: 1.6 };
const FLARE = { range: 420 };

function now() { return Date.now(); }
function tg() { return global.gameManager && global.gameManager.terrainGrid; }
function live(b) { return !!b && !(b.isDead && b.isDead()) && !b.isGhost; }

// ── state ───────────────────────────────────────────────────────────────
// Per socket: what you own and the cooldowns, on the shop state. The raid
// ledger keeps the same object under the player's account or guest id, so a
// new connection in the same raid (reload, rejoin, a drop) picks it back up.
// resetRaid() empties the ledger.
const ledger = new Map();
function identity(socket) {
    const a = socket.account && socket.account.id;
    if (a) return "a:" + a;
    return socket.guestId ? "g:" + socket.guestId : null;
}
function freshAb() { return { own: [], eq: null, cd: {}, cdLen: {}, trial: null, twist: null, trialUsed: false, free: null }; }
function stateOf(socket) {
    if (!socket) return null;
    if (!socket.shop) { try { require('./shop.js').stateOf(socket); } catch { socket.shop = {}; } }
    const s = socket.shop;
    if (!s.ab) s.ab = freshAb();
    const key = identity(socket);
    if (key && s.ab._key !== key) {
        // the identity can turn up after the first look (the guest id packet)
        // what this connection picked up before it knew who it was joins
        // the ledger's copy; the ledger's slot wins, so nothing swaps
        const prev = ledger.get(key);
        if (prev && prev !== s.ab) {
            for (const id of s.ab.own) if (!prev.own.includes(id)) prev.own.push(id);
            if (!prev.eq || !prev.own.includes(prev.eq)) prev.eq = s.ab.eq;
            if (!prev.free) prev.free = s.ab.free;
            s.ab = prev;
        } else ledger.set(key, s.ab);
        s.ab._key = key;
    }
    return s.ab;
}
// A bot has no socket: its state rides on the body.
function botState(body) {
    if (!body._ab) body._ab = { own: [], eq: null, cd: {}, trial: null, twist: null, trialUsed: true };
    return body._ab;
}
function stateFor(body) { return body && body.socket ? stateOf(body.socket) : body ? botState(body) : null; }

function trialLive(st, t = now()) { return !!(st && st.trial && st.trial.until > t); }
function equippedOf(st, t = now()) {
    if (!st) return null;
    if (trialLive(st, t)) return st.trial.id;
    if (st.eq && (st.own.includes(st.eq) || st.eq === st.twist)) return st.eq;
    return st.twist || st.own[0] || null;
}
function owns(st, id) { return !!st && (st.own.includes(id) || st.twist === id || (trialLive(st) && st.trial.id === id)); }
function equipped(body) { return equippedOf(stateFor(body)); }

function dashOf(body) {
    if (!body._dash || body._dash.body !== body) {
        body._dash = { body, n: DASH.charges, nextAt: 0, lastAt: 0 };
    }
    return body._dash;
}

// bodies with something running this tick (motion, timers, recharge)
const busy = new Set();
const pads = [];
const walls = [];

// ── talking ─────────────────────────────────────────────────────────────
function talkState(socket, msg) {
    if (!ON || !socket || !socket.talk) return;
    const st = stateOf(socket);
    const body = socket.player && socket.player.body;
    const t = now();
    const d = body && live(body) ? dashOf(body) : { n: DASH.charges, nextAt: 0 };
    const eq = equippedOf(st, t);
    const def = eq ? AB_BY_ID.get(eq) : null;
    try {
        socket.talk('AB', JSON.stringify({
            d: d.n, dm: DASH.charges, dr: d.n < DASH.charges && d.nextAt ? Math.max(0, d.nextAt - t) : 0, drm: DASH.rechargeMs,
            eq, own: st.own.slice(), tw: st.twist || null,
            cd: eq ? Math.max(0, (st.cd[eq] || 0) - t) : 0, cdm: def ? (st.cdLen && st.cdLen[eq]) || def.cd : 0,
            tr: trialLive(st, t) ? { id: st.trial.id, left: st.trial.until - t } : null,
            act: activeOf(body, t),
            fr: st.free || null, fn: st._freeNew ? 1 : 0,
            msg: msg || "",
        }));
    } catch { /* closing */ }
}
// What is running on the tank right now, for the HUD chip (ms left).
function activeOf(body, t) {
    if (!body || !live(body)) return null;
    if (body.burrowUntil > t) return { k: "burrow", left: body.burrowUntil - t };
    if (body.smokeUntil > t) return { k: "smoke", left: body.smokeUntil - t };
    if (body.rushUntil > t) return { k: "rush", left: body.rushUntil - t };
    if (body.radarUntil > t) return { k: "radar", left: body.radarUntil - t };
    if (body.rocketUntil > t) return { k: "rocket", left: body.rocketUntil - t };
    return null;
}

const FX_RANGE = 2600;
function fx(kind, x, y, a = 0, b = 0, id = 0) {
    const clients = (global.gameManager && global.gameManager.socketManager && global.gameManager.socketManager.clients) || [];
    for (const c of clients) {
        const cam = c && c.camera;
        if (!cam || Math.abs(cam.x - x) > FX_RANGE || Math.abs(cam.y - y) > FX_RANGE) continue;
        try { c.talk('AF', kind, Math.round(x), Math.round(y), Math.round(a * 1000) / 1000, Math.round(b), id | 0); } catch { /* */ }
    }
}

function tell(body, msg) {
    if (body && body.socket) talkState(body.socket, msg);
}

// ── who's around ────────────────────────────────────────────────────────
function tanks() {
    const out = [];
    const gm = global.gameManager;
    if (!gm) return out;
    for (const p of (gm.socketManager && gm.socketManager.players) || []) {
        const b = p && p.body;
        if (live(b) && !b.royaleLobby) out.push(b);
    }
    for (const b of (gm.gameHandler && gm.gameHandler.bots) || gm.bots || []) if (live(b)) out.push(b);
    if (Config.dig_royale) { try { const boss = require('./bosses.js').current(); if (boss) out.push(boss); } catch { /* */ } }
    return out;
}
function titansNow() {
    if (!Config.royale_teams) return [];
    try {
        const titan = require('./titan.js');
        return [-1, -2].map(team => titan.aliveFor(team)).filter(o => live(o));
    } catch { return []; }
}
function hostile(a, b) { return a !== b && a.team !== b.team; }
function shielded(b) { return !!(b.invuln || b.godmode || b.passive || b.padSafe || b.royaleLobby); }
function radiusOf(b) { return b.realSize || b.size || 30; }

// Abilities and dashes count as moving, so a used spawn shield goes.
function dropShield(body) {
    if (!body.invuln) return;
    if ((body.spawnGraceUntil || 0) > now()) return;
    body.invuln = false;
}

// ── forced motion (dash, grapple, launch) ───────────────────────────────
// Each tick (after the terrain pass) the velocity is set to the burst; the
// next physics step moves the tank and the terrain pass still pushes it out
// of rock, so a burst can't go through a wall. A wall that eats most of a
// step ends it.
// A dash or a launch carries through incoming fire and bumps: knockback is
// damped (pushability) and wiped each tick, and only rock ends it early.
const BURSTS = { dash: 1, launch: 1, fling: 1 };
const BURST_PUSH = 0.08;
let tickNo = 0;
function startMotion(body, m) {
    m.lastX = body.x; m.lastY = body.y; m.ticks = 0; m.born = tickNo;
    if (body._abMove) endMotion(body, 0);
    body._abMove = m;
    if (BURSTS[m.kind] && body.pushability != null) body.pushability = Math.min(body.pushability, BURST_PUSH);
    busy.add(body);
    applyMotion(body, m, now());
}
function applyMotion(body, m, t) {
    if (m.kind === 'fling') return applyFling(body, m);
    // the hook is still in the air: nothing pulls yet
    if (m.startAt && t < m.startAt) return true;
    let vx = m.vx, vy = m.vy;
    if (m.tx != null || m.follow) {
        const tx = m.follow ? m.follow.x : m.tx, ty = m.follow ? m.follow.y : m.ty;
        const dx = tx - body.x, dy = ty - body.y, d = Math.hypot(dx, dy);
        const left = d - m.stop;
        if (left <= 2 || (m.follow && !live(m.follow))) return false;
        const sp = Math.min(m.speed, left);
        vx = dx / d * sp; vy = dy / d * sp;
    }
    // rock one step ahead: the burst ends at the face, it never tunnels
    const g = tg();
    if (g && g.pointInRock(body.x + vx * 1.2, body.y + vy * 1.2)) return false;
    body.velocity.x = vx;
    body.velocity.y = vy;
    // knockback a hit queued for the next step goes too
    if (BURSTS[m.kind] && body.accel) { body.accel.x = 0; body.accel.y = 0; }
    return true;
}
function endMotion(body, keep = 0.45) {
    const m = body._abMove;
    body._abMove = null;
    // the hook lets go (pulled in, its target gone, cut short): it reels back
    if (m && m.kind === 'grapple') fx('hookend', body.x, body.y, 0, 0, body.id);
    if (m && m.kind === 'fling' && body._flingBy && global.royaleAch) {
        const by = body._flingBy;
        body._flingBy = null;
        if (by.socket || body.socket) global.royaleAch.onFlingEnd(body, by);
    }
    if (!m || !body.velocity) return;
    if (BURSTS[m.kind] && body.PUSHABILITY != null) body.pushability = 1 * body.PUSHABILITY;
    // a little glide out of it, not a dead stop
    body.velocity.x *= keep;
    body.velocity.y *= keep;
}
function tickMotion(body, t) {
    const m = body._abMove;
    if (!m) return;
    if (!live(body) || t > m.until) { endMotion(body); return; }
    // started this very tick (a pad): nothing has moved yet. Bursts skip the
    // stall check: a hit from the front must not end a dash, rock still does
    if (m.born !== tickNo && !BURSTS[m.kind] && !(m.startAt && t < m.startAt + 70)) {
        const moved = Math.hypot(body.x - m.lastX, body.y - m.lastY);
        if (moved < Math.max(3, m.speed * 0.3)) { endMotion(body, 0.2); return; }
    }
    m.ticks++;
    m.lastX = body.x; m.lastY = body.y;
    if (m.wall) { endMotion(body, 0.1); return; }
    if (!applyMotion(body, m, t)) endMotion(body, 0.25);
}
// A Shockwave launch: the velocity eases off each tick. Rock ahead stops it
// at the face (the step is cut short there), so nobody gets driven into a
// wall or through one.
function applyFling(body, m) {
    if (m.ticks > 0) { m.vx *= m.decay; m.vy *= m.decay; }
    let vx = m.vx, vy = m.vy;
    const g = tg();
    if (g) {
        const r = radiusOf(body) * 0.75, sp = Math.hypot(vx, vy);
        const n = Math.max(1, Math.ceil(sp / 18));
        for (let k = 1; k <= n; k++) {
            const f = k / n;
            if (!g.rockHitByCircle(body.x + vx * f, body.y + vy * f, r)) continue;
            const safe = (k - 1) / n;
            vx *= safe; vy *= safe;
            m.wall = true;
            break;
        }
    }
    body.velocity.x = vx;
    body.velocity.y = vy;
    if (body.accel) { body.accel.x = 0; body.accel.y = 0; }
    return true;
}

function topSpeedOf(body) { return Math.max(DASH.minSpeed, body.topSpeed || 0); }

// ── dash ────────────────────────────────────────────────────────────────
// The way the keys point; standing still, the way the gun points.
function dashDir(body) {
    const c = body.socket && body.socket.player && body.socket.player.command;
    let dx = 0, dy = 0;
    if (c) {
        if (c.analog && (c.moveX || c.moveY)) { dx = c.moveX; dy = c.moveY; }
        else { dx = (c.right ? 1 : 0) - (c.left ? 1 : 0); dy = (c.down ? 1 : 0) - (c.up ? 1 : 0); }
    }
    if (!dx && !dy) {
        const tgt = body.socket && body.socket.player && body.socket.player.target;
        if (tgt && (tgt.x || tgt.y)) { dx = tgt.x; dy = tgt.y; }
        else { dx = Math.cos(body.facing || 0); dy = Math.sin(body.facing || 0); }
    }
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
}

function canDash(body) {
    if (!ON || !live(body) || body.royaleFrozen || body.royaleLobby) return false;
    const d = dashOf(body);
    return d.n > 0 && now() - d.lastAt >= DASH.gapMs && !(body._abMove && (body._abMove.kind === 'grapple' || body._abMove.kind === 'fling'));
}

// Bots call this too (dx, dy: any length; 0,0 = the way it faces).
function dash(body, dx, dy) {
    if (!canDash(body)) return false;
    const t = now();
    const d = dashOf(body);
    let dir;
    if (dx || dy) { const l = Math.hypot(dx, dy) || 1; dir = { x: dx / l, y: dy / l }; }
    else dir = dashDir(body);
    d.n--;
    d.lastAt = t;
    if (!d.nextAt || d.nextAt < t) d.nextAt = t + DASH.rechargeMs;
    const sp = topSpeedOf(body) * DASH.mult;
    startMotion(body, { kind: 'dash', vx: dir.x * sp, vy: dir.y * sp, speed: sp, until: t + DASH.ms });
    dropShield(body);
    busy.add(body);
    fx('dash', body.x, body.y, Math.atan2(dir.y, dir.x), Math.round(sp * DASH.ms / 33), body.id);
    if (body.socket) talkState(body.socket);
    return true;
}

function tickDash(body, t) {
    const d = body._dash;
    if (!d || d.n >= DASH.charges) return false;
    if (d.nextAt && t >= d.nextAt) {
        d.n++;
        d.nextAt = d.n < DASH.charges ? t + DASH.rechargeMs : 0;
        if (body.socket) talkState(body.socket);
    }
    return d.n < DASH.charges;
}

// ── abilities ───────────────────────────────────────────────────────────
function aimAt(body, tx, ty) {
    let dx = (+tx || 0) - body.x, dy = (+ty || 0) - body.y;
    let d = Math.hypot(dx, dy);
    if (!(d > 1)) { dx = Math.cos(body.facing || 0); dy = Math.sin(body.facing || 0); d = 1; }
    return { x: dx / d, y: dy / d, d };
}
function onAnyPad(body) { return !!(body.padSafe || body.vaultOnPad || body.onVaultPad || body.shopOnPad); }
// Where a placed ability lands: the aim spot, held to `range`.
function placeAt(body, tx, ty, range) {
    const dir = aimAt(body, tx, ty);
    const d = Math.min(range, dir.d > 1 ? dir.d : 0);
    return { x: body.x + dir.x * d, y: body.y + dir.y * d, dir, d };
}
// Can a pad go down here? Open ground under it, not on a vault or shop pad.
function padSpotOk(x, y) { return !padSpotWhy(x, y); }
function padSpotWhy(x, y) {
    const g = tg();
    if (g && (g.rockHitByCircle(x, y, PLACE_CLEAR) || (g.growingRockHitByCircle && g.growingRockHitByCircle(x, y, PLACE_CLEAR, now())))) return 'rock';
    if (padOnSite(x, y)) return 'site';
    return null;
}
function padOnSite(x, y) {
    const clear = PAD.radius + 12;
    try {
        const padGeom = require('./padGeom.js');
        const list = [];
        if (Config.dig_royale) { for (const v of require('./vault.js').getVaults() || []) list.push(v); }
        for (const sp of require('./shop.js').getShops() || []) list.push(sp);
        try { for (const o of require('./outposts.js').getOutposts() || []) if (o && Number.isFinite(o.x)) list.push(o); } catch { /* */ }
        for (const p of list) if (p && padGeom.insidePad(p, x, y, clear)) return true;
    } catch { /* */ }
    try {
        if (require('./teamMode.js').isActive()) {
            const L = require('./teamLayout.js');
            if (L.baseAt(x, y, clear)) return true;
            for (const t of L.TEAMS) {
                const m = L.sitesFor(t).mouth;
                if (m && (x - m.x) ** 2 + (y - m.y) ** 2 <= (L.YARD_R + clear) ** 2) return true;
            }
            for (const w of L.warPads()) if ((x - w.x) ** 2 + (y - w.y) ** 2 <= (w.r + clear) ** 2) return true;
        }
    } catch { /* */ }
    return false;
}
const PAD_NO_REGROW_R = PAD.radius + 110;
function padGone(p, t = now()) {
    if (p && p.zone) p.zone.until = Math.min(p.zone.until, t);
}

// The cells a Barricade would raise at an aim spot, and the ones in its band
// it has to skip (a tank on it, a chest holding it). The preview packet and
// the cast use this same list, so the preview is exactly what you get.
const REGROW_MS = 16000;    // terrainGrid REGROW.GROW_MS
function wallPlan(body, tx, ty) {
    const g = tg();
    if (!g || !g.rocks) return null;
    const P = placeAt(body, tx, ty, AB_BY_ID.get('wall').place);
    const ux = -P.dir.y, uy = P.dir.x;              // along the wall
    const size = (g._voroRockSz || 1) * (g.cellSize || 100);
    const near = tanks().filter(o => Math.hypot(o.x - P.x, o.y - P.y) < size * WALL.count + 400);
    const pads = padsNear(P.x, P.y, size * WALL.count + 600);
    const cellAt = require('./spawnReach.js').cellAt;
    const rise = [], blocked = [], seen = new Set();
    // the cells under count points spaced a cell apart across the aim line
    const half = (WALL.count - 1) / 2;
    for (let k = 0; k < WALL.count; k++) {
        const off = (k - half) * size;
        let rock = cellAt(g, P.x + ux * off, P.y + uy * off);
        if (rock && seen.has(rock.k)) rock = cellAt(g, P.x + ux * off * 1.15, P.y + uy * off * 1.15);
        if (!rock || seen.has(rock.k)) continue;
        seen.add(rock.k);
        if (rock.alive || rock.growing || !rock.worldPoly) continue;
        if (wallBlocked(g, rock, near, pads)) { blocked.push(rock); continue; }
        rise.push(rock);
    }
    return { x: P.x, y: P.y, ang: Math.atan2(P.dir.y, P.dir.x), rise, blocked };
}
function padsNear(x, y, R) {
    const out = [];
    const add = (list) => { for (const p of list || []) if (p && Math.hypot(p.x - x, p.y - y) < R + (p.r || 120) * 1.5) out.push(p); };
    try { if (Config.dig_royale) add(require('./vault.js').getVaults()); } catch { }
    try { add(require('./outposts.js').getOutposts()); } catch { }
    try { add(require('./shop.js').getShops()); } catch { }
    return out;
}
function wallBlocked(g, rock, near, pads) {
    if (rock.chestLock || rock._chestHolds > 0) return true;
    const wx = rock.worldCx || rock.wx, wy = rock.worldCy || rock.wy;
    const face = g.constructor && g.constructor._polyFace;
    for (const o of near) {
        const r = radiusOf(o);
        if ((o.x - wx) ** 2 + (o.y - wy) ** 2 > (r + (rock.maxPolyRadius || 120)) ** 2) continue;
        if (!face) { if (Math.hypot(o.x - wx, o.y - wy) < r + 40) return true; continue; }
        const f = face(rock.worldPoly, o.x, o.y);
        if (f.inside || f.dist < r * 0.9) return true;
    }
    if (pads.length) {
        const padGeom = require('./padGeom.js');
        for (const p of pads) {
            if (padGeom.insidePad(p, wx, wy, 10)) return true;
            for (const q of rock.worldPoly) if (padGeom.insidePad(p, q[0], q[1], 0)) return true;
        }
    }
    return false;
}
// ['ab', 3, x, y] while the Barricade is aimed: the plan, a few times a second
function preview(socket, tx, ty) {
    const body = socket && socket.player && socket.player.body;
    if (!ON || !live(body) || equippedOf(stateOf(socket)) !== 'wall') return;
    const t = now();
    if (t - (socket._abPreviewAt || 0) < 70) return;
    socket._abPreviewAt = t;
    const plan = wallPlan(body, tx, ty);
    if (!plan) return;
    try { socket.talk('AW', JSON.stringify({ x: Math.round(plan.x), y: Math.round(plan.y), g: plan.rise.map(r => r.k), r: plan.blocked.map(r => r.k) })); } catch { /* */ }
}

const USES = {
    grapple(body, tx, ty) {
        const g = tg();
        const dir = aimAt(body, tx, ty);
        const r = radiusOf(body);
        const others = tanks().concat(titansNow()).filter(o => o !== body && Math.hypot(o.x - body.x, o.y - body.y) < GRAPPLE.range + radiusOf(o) + r);
        let hit = null, hx = body.x + dir.x * (r + GRAPPLE.range), hy = body.y + dir.y * (r + GRAPPLE.range);
        for (let s = r + 6; s <= r + GRAPPLE.range; s += GRAPPLE.step) {
            const x = body.x + dir.x * s, y = body.y + dir.y * s;
            for (const o of others) {
                const rr = radiusOf(o) + 6;
                if ((o.x - x) ** 2 + (o.y - y) ** 2 <= rr * rr) { hit = o; break; }
            }
            if (hit) { hx = x; hy = y; break; }
            if (g && g.pointInRock(x, y)) { hit = 'rock'; hx = x - dir.x * GRAPPLE.step * 0.5; hy = y - dir.y * GRAPPLE.step * 0.5; break; }
        }
        if (!hit) {
            fx('hookmiss', body.x, body.y, Math.atan2(dir.y, dir.x), GRAPPLE.range, body.id);
            // out and back, then it's ready again
            return { ok: true, cd: 0, lock: Math.max(GRAPPLE.missLockMs, GRAPPLE.range / GRAPPLE.flyPerMs + GRAPPLE.backMs), msg: "" };
        }
        const t = now();
        const dist0 = Math.hypot(hx - body.x, hy - body.y);
        const bite = t + dist0 / GRAPPLE.flyPerMs;
        const m = { kind: 'grapple', speed: GRAPPLE.speed, until: bite + GRAPPLE.maxMs, stop: r + 4, startAt: bite };
        if (hit === 'rock') { m.tx = hx; m.ty = hy; }
        else { m.follow = hit; m.stop = r + radiusOf(hit) + 8; }
        startMotion(body, m);
        fx('hook', body.x, body.y, Math.atan2(dir.y, dir.x), dist0, body.id);
        return { ok: true };
    },

    // The cooldown is set when you come up (endBurrow), by how long you stayed.
    burrow(body) {
        const t = now();
        body.burrowAt = t;
        body.burrowUntil = t + BURROW.maxMs;
        if (body._burrowAlpha == null) body._burrowAlpha = body.alpha == null ? 1 : body.alpha;
        body.alpha = Math.min(body.alpha == null ? 1 : body.alpha, BURROW.alpha);
        refresh(body);
        busy.add(body);
        tickBurrow(body, t);
        fx('burrow', body.x, body.y, 0, BURROW.maxMs, body.id);
        return { ok: true, cd: 0, msg: "You're underground. Press it again to come up." };
    },

    // Thrown: it flies to the aim spot (held to the range) and blows there,
    // or on the first rock or tank in the way (tickOrbs).
    shock(body, tx, ty) {
        const P = placeAt(body, tx, ty, AB_BY_ID.get('shock').place);
        const t = now();
        orbs.push({ owner: body, x0: body.x, y0: body.y, ux: P.dir.x, uy: P.dir.y, dist: P.d, done: 0, born: t, dur: Math.max(90, P.d / SHOCK.throwSpeed) });
        if (orbs.length > 24) orbs.shift();
        busy.add(body);
        fx('shockthrow', body.x, body.y, Math.atan2(P.dir.y, P.dir.x), P.d, body.id);
        return { ok: true };
    },

    radar(body) {
        body.radarUntil = now() + RADAR.ms;
        body._radarAt = 0;
        busy.add(body);
        tickRadar(body, now());
        fx('radar', body.x, body.y, 0, RADAR.radius, body.id);
        return { ok: true };
    },

    // A straight wall across the aim line, centred on the aim spot.
    wall(body, tx, ty) {
        const g = tg();
        const plan = wallPlan(body, tx, ty);
        if (!plan) return { ok: false, msg: "There's no rock to raise here." };
        const t = now();
        const rate = REGROW_MS / WALL.riseMs;
        let n = 0;
        for (const rock of plan.rise) {
            rock.noRegrowUntil = 0;
            const canyon = !!rock.canyon;
            rock.canyon = false;
            let ok = false;
            try { ok = g.startRegrow(rock, t + n * WALL.gapMs, 0, { fast: true, rate }) !== false; } catch { ok = false; }
            if (!ok) { rock.canyon = canyon; continue; }
            walls.push({ rock, gen: rock.gen, until: t + WALL.ms, canyon });
            n++;
        }
        if (!n) return { ok: false, msg: "There's nothing to raise there. Aim at ground you've dug out." };
        fx('wall', plan.x, plan.y, plan.ang, n, body.id);
        return { ok: true };
    },

    // Thrown: the cloud pops where it lands (tickSmoke), after the flight.
    smoke(body, tx, ty) {
        const P = placeAt(body, tx, ty, AB_BY_ID.get('smoke').place);
        const t = now();
        const fly = Math.max(120, P.d / SMOKE.throwSpeed);
        clouds.push({ x: P.x, y: P.y, at: t + fly, until: t + fly + SMOKE.cloudMs, r: SMOKE.radius, owner: body, popped: false });
        if (clouds.length > 16) clouds.shift();
        body.smokeAt = t + fly;
        body.smokeUntil = t + fly + SMOKE.cloudMs;
        refresh(body);
        busy.add(body);
        fx('smokethrow', body.x, body.y, Math.atan2(P.dir.y, P.dir.x), P.d, body.id);
        return { ok: true };
    },

    rush(body) {
        body.rushUntil = now() + RUSH.ms;
        refresh(body);
        busy.add(body);
        fx('rush', body.x, body.y, 0, RUSH.ms, body.id);
        return { ok: true };
    },

    pad(body, tx, ty) {
        const P = placeAt(body, tx, ty, AB_BY_ID.get('pad').place);
        const why = padSpotWhy(P.x, P.y);
        if (why === 'site') return { ok: false, msg: "Launch Pads can't go on vaults, shops, Outposts or bases. Try open ground nearby." };
        if (why) return { ok: false, msg: "There's no room for a pad there. Aim at open ground." };
        const t = now();
        const mine = pads.filter(p => p.owner === body);
        while (mine.length >= PAD.perOwner) { const old = mine.shift(); pads.splice(pads.indexOf(old), 1); padGone(old, t); fx('padgone', old.x, old.y, 0, 0, old.id); }
        const id = (++padSeq) & 0x7fffffff;
        const ang = Math.atan2(P.dir.y, P.dir.x);
        const pad = { id, x: P.x, y: P.y, ang, until: t + PAD.ms, armAt: t + PAD.armMs, owner: body, told: new Set(), toldAt: 0, zone: null };
        const g = tg();
        if (g && g.addNoRegrowZone) { try { pad.zone = g.addNoRegrowZone(P.x, P.y, PAD_NO_REGROW_R, pad.until); } catch { /* */ } }
        pads.push(pad);
        announcePad(pad, t);
        return { ok: true };
    },
};
let padSeq = 0;

// A pad is drawn by whoever was told about it, and it lasts PAD.ms: anyone
// who comes into view later hears about it then (with the time it has
// left), or it would launch them from thin air.
function announcePad(p, t) {
    p.toldAt = t;
    const clients = (global.gameManager && global.gameManager.socketManager && global.gameManager.socketManager.clients) || [];
    for (const c of clients) {
        if (!c || p.told.has(c)) continue;
        const cam = c.camera;
        if (!cam || Math.abs(cam.x - p.x) > FX_RANGE || Math.abs(cam.y - p.y) > FX_RANGE) continue;
        p.told.add(c);
        try { c.talk('AF', 'pad', Math.round(p.x), Math.round(p.y), Math.round(p.ang * 1000) / 1000, Math.max(0, Math.round(p.until - t)), p.id | 0); } catch { /* */ }
    }
}

// Damages every rock within R (outside `skip`) by frac of its max health;
// frac >= 1 shatters it. Emeralds only crack. -> how many broke.
function crackRocks(owner, x, y, R, frac, skip = 0) {
    const g = tg();
    if (!g || !g.rocks) return 0;
    const gems = require('./gems.js');
    let broke = 0;
    for (const rock of g.rocks.values()) {
        if (!rock || (!rock.alive && !rock.growing) || rock.canyon) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        const d2 = (rx - x) ** 2 + (ry - y) ** 2;
        if (d2 > R * R || d2 < skip * skip) continue;
        const f = rock.ore === 4 && frac >= 1 ? 0.5 : frac;
        const wasGrowing = rock.growing;
        if (g.damageRock(rock, rock.maxHealth * f, rx, ry, false, owner)) {
            broke++;
            if (!owner) continue;
            owner.rocksMined = (owner.rocksMined || 0) + 1;
            if (!wasGrowing && rock.ore) { owner.gemsMined = (owner.gemsMined || 0) + 1; try { gems.spawnOreBurst(rock, owner); } catch { /* */ } }
        }
    }
    return broke;
}

// ── shockwave orbs ──────────────────────────────────────────────────────
const orbs = [];
function tickOrbs(t) {
    if (!orbs.length) return;
    const g = tg();
    const list = tanks();
    for (let i = orbs.length - 1; i >= 0; i--) {
        const o = orbs[i];
        const to = o.dist * Math.min(1, (t - o.born) / o.dur);
        let hx = null, hy = null;
        // walk the stretch flown since the last tick: rock or a tank ends it
        for (let q = Math.min(to, o.done + 16); ; q = Math.min(to, q + 16)) {
            const x = o.x0 + o.ux * q, y = o.y0 + o.uy * q;
            if (g && q > 0 && g.pointInRock(x, y)) {
                const b = Math.max(0, q - 16);
                hx = o.x0 + o.ux * b; hy = o.y0 + o.uy * b;
                break;
            }
            for (const b of list) {
                if (b === o.owner || b.royaleLobby || b.burrowUntil > t) continue;
                const rr = radiusOf(b) + SHOCK.orbR;
                if ((b.x - x) ** 2 + (b.y - y) ** 2 <= rr * rr) { hx = x; hy = y; break; }
            }
            if (hx != null || q >= to) break;
        }
        o.done = to;
        if (hx == null && to >= o.dist) { hx = o.x0 + o.ux * o.dist; hy = o.y0 + o.uy * o.dist; }
        if (hx == null) continue;
        orbs.splice(i, 1);
        try { detonate(o, hx, hy, t, list); } catch { /* */ }
    }
}
function detonate(o, x, y, t, list) {
    const R = SHOCK.radius;
    const owner = live(o.owner) ? o.owner : null;
    let n = 0;
    for (const b of list || tanks()) {
        if (!live(b) || b.royaleLobby || b.padSafe || b.burrowUntil > t) continue;
        const dx = b.x - x, dy = b.y - y, d = Math.hypot(dx, dy);
        const reach = R + radiusOf(b);
        if (d > reach) continue;
        const k = Math.max(0, 1 - d / reach);
        let ux, uy;
        if (d > 8) { ux = dx / d; uy = dy / d; }
        else if (b === o.owner) {
            // thrown into a wall at point blank: you bounce back off it
            ux = -o.ux; uy = -o.uy;
        } else {
            // right on top of it: along the way it's moving, else the throw
            const v = Math.hypot(b.velocity.x, b.velocity.y);
            if (v > 1) { ux = b.velocity.x / v; uy = b.velocity.y / v; } else { ux = o.ux; uy = o.uy; }
        }
        const big = b.growthMult > 1 ? Math.max(SHOCK.bigMin, 1 / Math.pow(b.growthMult, 0.2)) : 1;
        const power = (SHOCK.fling0 + SHOCK.fling1 * Math.pow(k, 1.1)) * big;
        const foe = !!o.owner && hostile(o.owner, b);
        if (b.isRoyaleBoss) {
            b.velocity.x += ux * power * SHOCK.bossPush;
            b.velocity.y += uy * power * SHOCK.bossPush;
        } else {
            if (b._abMove) endMotion(b, 0);
            startMotion(b, { kind: 'fling', vx: ux * power, vy: uy * power, speed: power, decay: SHOCK.decay, until: t + SHOCK.flingMs });
            busy.add(b);
        }
        b._shockedAt = t;
        // who threw it (achievements: a fling that ends in the storm)
        b._flingBy = o.owner || null;
        // damage through the normal path (shield first), credited to the thrower
        const hurt = foe && owner && !shielded(b);
        if (hurt) {
            const frac = SHOCK.hpFar + (SHOCK.hpNear - SHOCK.hpFar) * k;
            const dmg = (b.health && b.health.max || 0) * frac * (b.isRoyaleBoss ? 0.2 : 1);
            if (dmg > 0) {
                b.damageReceived = (b.damageReceived || 0) + dmg;
                b.collisionArray.push(owner);
                b._lastDamageSource = owner;
                b._lastDamageAt = t;
            }
            n++;
        }
        fx(hurt ? 'flinghit' : 'fling', b.x, b.y, Math.atan2(uy, ux), Math.round(power), b.id);
    }
    // the rock in the middle shatters, the rest of the blast cracks
    crackRocks(owner, x, y, SHOCK.breakR, 10);
    crackRocks(owner, x, y, R, SHOCK.crackFrac, SHOCK.breakR);
    fx('shock', x, y, 0, R, o.owner ? o.owner.id : 0);
    if (owner && owner.socket && n) tell(owner, n === 1 ? "Shockwave hit 1 tank." : "Shockwave hit " + n + " tanks.");
}

function cdOf(st, id) { return Math.max(0, (st.cd[id] || 0) - now()); }

// The one entry point for players and bots. -> true when it fired.
function use(body, tx, ty, id) {
    if (!ON || !live(body) || body.royaleFrozen || body.royaleLobby) return false;
    const st = stateFor(body);
    id = id || equippedOf(st);
    if (!id || !owns(st, id) || !USES[id]) {
        if (body.socket) tell(body, "You don't have an ability yet. You can buy one at a shop.");
        return false;
    }
    const t = now();
    // already down: the key brings you up
    if (id === 'burrow' && body.burrowUntil > t) {
        if (t - (body.burrowAt || 0) < BURROW.minMs) return false;
        endBurrow(body, t);
        return true;
    }
    if (onAnyPad(body)) {
        if (body.socket) tell(body, "You can't use abilities on a pad.");
        return false;
    }
    if (cdOf(st, id) > 0) return false;
    if (body._abCdUntil && t < body._abCdUntil) return false;
    let res;
    try { res = USES[id](body, tx, ty) || { ok: false }; } catch (e) { res = { ok: false }; }
    if (res.ok) {
        const def = AB_BY_ID.get(id);
        const cd = res.cd != null ? res.cd : def.cd;
        st.cdLen = st.cdLen || {};
        if (cd > 0) { st.cd[id] = t + cd; st.cdLen[id] = cd; }
        body._abCdUntil = t + (res.lock || 300);
        dropShield(body);
        body.abilityUses = (body.abilityUses | 0) + 1;
        if (body.socket && global.royaleAch) global.royaleAch.onAbility(body, id, t);
        if (body.socket && body.socket._saving) { try { require('./saveCodes.js').interrupt(body.socket, "You used an ability, so the save stopped."); } catch { /* */ } }
    }
    if (body.socket) talkState(body.socket, res.msg || "");
    return !!res.ok;
}

// The ability key never swaps abilities, on a pad or off it: the shop
// panel's Equip button is the only way (shop.buy -> equip).
function cycle(socket) {
    if (ON && socket) talkState(socket, "Equip abilities with the Equip button in the shop.");
    return false;
}

// ── shop hooks (shop.js buy) ────────────────────────────────────────────
function canBuy(socket, item) {
    const st = stateOf(socket);
    if (st.own.includes(item.id)) {
        if (equippedOf(st) === item.id && !trialLive(st)) return { ok: false, why: "That's already equipped." };
        return { ok: true, equip: true };
    }
    return { ok: true };
}
// Paid (or just equipped): it's yours for the raid and goes in the slot.
function grant(socket, id) {
    const st = stateOf(socket);
    if (!AB_BY_ID.has(id)) return false;
    if (!st.own.includes(id)) st.own.push(id);
    st.eq = id;
    // buying ends a trial early: the slot is yours now
    if (st.trial && st.trial.id !== id) st.trial = null;
    if (st.trial && st.trial.id === id) st.trial = null;
    return true;
}
// The slot is yours to fill: only the free starter (into an empty slot), a
// purchase or the shop's Equip button put something in it. Anything found
// (a crate, a chest, a twist, a restored save) joins what you own and only
// goes in when nothing is equipped.
function slotEmpty(st) { return !(st.eq && (st.own.includes(st.eq) || st.eq === st.twist)) && !st.twist; }
function addFound(socket, id) {
    const st = stateOf(socket);
    if (!AB_BY_ID.has(id)) return false;
    if (!st.own.includes(id)) st.own.push(id);
    const name = AB_BY_ID.get(id).name;
    if (slotEmpty(st)) { st.eq = id; talkState(socket, name + " added. It's in your ability slot."); }
    else talkState(socket, name + " added. Equip it at a shop.");
    return true;
}
function equip(socket, id) {
    const st = stateOf(socket);
    if (!owns(st, id)) return false;
    st.eq = id;
    if (st.trial) st.trial = null;
    return true;
}

// ── raid hooks ──────────────────────────────────────────────────────────
// Every life starts with full dash charges. The first spawn of a raid also
// hands out a free ability, owned for the raid like a bought one.
function onSpawn(body) {
    if (!ON || !body) return;
    body._dash = null;
    dashOf(body);
    body._abMove = null;
    body.burrowUntil = 0; body.smokeUntil = 0; body.rushUntil = 0; body.radarUntil = 0; body.rocketUntil = 0;
    if (!body.socket) return;
    const st = stateOf(body.socket);
    if (FREE_ON && !st.free && !Config.tutorial) {
        // a first raid (newcomerDirector.js) doesn't open on the Shockwave:
        // flinging yourself around is a lot before you know the basics
        const pool = FREE_POOL.filter(id => AB_BY_ID.has(id) && !st.own.includes(id) && !(id === 'shock' && body.nxStage === 0));
        if (pool.length) {
            const id = pool[(Math.random() * pool.length) | 0];
            st.free = id;
            st.own.push(id);
            if (!st.eq || !st.own.includes(st.eq)) st.eq = id;
            st._freeNew = true;
        } else st.free = st.own[0] || 'none';
    }
    talkState(body.socket);
    st._freeNew = false;
}

// A first bank in a raid with nothing in the ability slot hands one out on
// trial. Gems in the vault should feel like they bought you something. It
// never covers an ability you already have (the raid's free one included).
function onBanked(body, amount) {
    if (!ON || !live(body) || !body.socket || !(amount > 0) || Config.tutorial) return null;
    if (process.env.ROYALE_ABILITY_TRIAL === '0') return null;
    const st = stateOf(body.socket);
    if (st.trialUsed || st.own.length || st.twist || equippedOf(st)) return null;
    st.trialUsed = true;
    // the cells under count points spaced a cell apart across the aim line
    const pool = ABILITIES.filter(a => a.trial && !a.retired && !st.own.includes(a.id));
    if (!pool.length) return null;
    const pick = pool[(Math.random() * pool.length) | 0];
    st.trial = { id: pick.id, until: now() + TRIAL_MS };
    talkState(body.socket, "Free trial: " + pick.name + " for 2 minutes. Buy it at a shop to keep it.");
    return pick.id;
}

// Bots own nothing by default; the bot brain can hand one an ability here
// and fire it with use(body, x, y).
function giveBot(body, id) {
    if (!ON || !body || body.socket || !AB_BY_ID.has(id)) return false;
    const st = botState(body);
    if (!st.own.includes(id)) st.own.push(id);
    st.eq = id;
    return true;
}
function cooldownLeft(body, id) {
    const st = stateFor(body);
    id = id || equippedOf(st);
    return st && id ? cdOf(st, id) : 0;
}
// Would use() fire right now? (bots ask before they commit to a plan)
function canUse(body, id) {
    if (!ON || !live(body) || body.royaleFrozen || body.royaleLobby || onAnyPad(body)) return false;
    const st = stateFor(body);
    id = id || equippedOf(st);
    if (!id || !owns(st, id) || !USES[id]) return false;
    if (id === 'burrow' && body.burrowUntil > now()) return true;    // surfacing
    return cdOf(st, id) <= 0 && !(body._abCdUntil && now() < body._abCdUntil);
}
// Range of a placed ability (0 = it goes off on you).
function placeRange(id) { const d = AB_BY_ID.get(id); return (d && d.place) || 0; }

// A raid override hands everyone one (raidMods freeAbility).
function grantTwist(body, id) {
    if (!ON || !body || !AB_BY_ID.has(id)) return;
    const st = stateFor(body);
    st.twist = id;
    if (body.socket) talkState(body.socket);
}
function revokeTwist(socketOrBody) {
    const st = socketOrBody && socketOrBody.talk ? stateOf(socketOrBody) : socketOrBody ? botState(socketOrBody) : null;
    if (!st || !st.twist) return;
    if (st.eq === st.twist && !st.own.includes(st.eq)) st.eq = null;
    st.twist = null;
    if (socketOrBody.talk) talkState(socketOrBody);
}

// ── kit items that move you (shop.useKit) ───────────────────────────────
function rocketBoots(body) {
    body.rocketUntil = now() + ROCKET.ms;
    refresh(body);
    busy.add(body);
    fx('rocket', body.x, body.y, 0, ROCKET.ms, body.id);
    return true;
}
// Blink toward the nearest vault: the farthest open spot on the line, rock
// in between or not. -> false when there's nowhere to land.
function escapeFlare(body) {
    const g = tg();
    let vx = null, vy = null;
    try {
        const vaults = require('./vault.js').getVaults() || [];
        let best = Infinity;
        for (const v of vaults) { const d = Math.hypot(v.x - body.x, v.y - body.y); if (d < best) { best = d; vx = v.x; vy = v.y; } }
    } catch { /* */ }
    let dx, dy;
    if (vx == null) { dx = Math.cos(body.facing || 0); dy = Math.sin(body.facing || 0); }
    else { dx = vx - body.x; dy = vy - body.y; }
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    const r = radiusOf(body);
    const reach = Math.min(FLARE.range, vx == null ? FLARE.range : Math.max(0, d - 40));
    for (let s = reach; s >= 90; s -= 20) {
        const x = body.x + dx * s, y = body.y + dy * s;
        if (g && g.rockHitByCircle(x, y, r + 2)) continue;
        if (g && g.growingRockHitByCircle && g.growingRockHitByCircle(x, y, r + 2, now())) continue;
        const ox = body.x, oy = body.y;
        body.x = x; body.y = y;
        body.velocity.x = dx * topSpeedOf(body); body.velocity.y = dy * topSpeedOf(body);
        if (body._abMove) endMotion(body, 0);
        fx('blink', ox, oy, Math.atan2(dy, dx), s, body.id);
        return true;
    }
    // Boxed in: no open ground that way. Blink as far as it goes anyway and
    // blow a pocket where you land (plain rock and ore, never emeralds, never
    // onto a pad), so the flare always gets you out.
    if (!g) return false;
    for (let s = reach; s >= 90; s -= 30) {
        const x = body.x + dx * s, y = body.y + dy * s;
        if (!flareSpotFree(x, y, r)) continue;
        const R = r * 1.35 + 10;
        g.rocksHitByCircle(x, y, R, flareHits);
        if (g.growingRocksHitByCircle) g.growingRocksHitByCircle(x, y, R, now(), flareHits);
        const blocked = flareHits.some(rock => rock && (rock.canyon || rock.ore === 4) && rock.alive);
        if (blocked) { flareHits.length = 0; continue; }
        for (const rock of flareHits) {
            if (!rock) continue;
            g.damageRock(rock, rock.health + 1, x, y, false, body, true);
        }
        flareHits.length = 0;
        const ox = body.x, oy = body.y;
        body.x = x; body.y = y;
        body.velocity.x = 0; body.velocity.y = 0;
        if (body._abMove) endMotion(body, 0);
        fx('blink', ox, oy, Math.atan2(dy, dx), s, body.id);
        return true;
    }
    return false;
}
const flareHits = [];
// not on a vault or shop pad (rock is fine, the flare clears it)
function flareSpotFree(x, y, r) {
    try {
        const padGeom = require('./padGeom.js');
        const list = [];
        if (Config.dig_royale) { for (const v of require('./vault.js').getVaults() || []) list.push(v); }
        for (const sp of require('./shop.js').getShops() || []) list.push(sp);
        for (const p of list) if (padGeom.insidePad(p, x, y, r)) return false;
    } catch { /* */ }
    return true;
}

// Kit items get effects like the abilities ('AF' k_<id>), pinned to the tank
// that used it. Rocket Boots and the flare send their own. The decoy only
// shows to its owner: anyone else would see through it.
const KIT_FX_MS = { anchor: 15000, decoy: 20000 };
function kitFx(id, body, tx, ty) {
    if (!body || id === 'rocket' || id === 'flare') return;
    let a = 0, b = KIT_FX_MS[id] || 0;
    if (id === 'charge' || id === 'barrage') {
        const dx = (+tx || 0) - body.x, dy = (+ty || 0) - body.y;
        a = Math.atan2(dy, dx);
        if (id === 'charge') b = Math.min(500, Math.hypot(dx, dy));
    }
    if (id === 'decoy') {
        if (body.socket) { try { body.socket.talk('AF', 'k_decoy', Math.round(body.x), Math.round(body.y), 0, b, body.id | 0); } catch { /* */ } }
        return;
    }
    fx('k_' + id, body.x, body.y, a, b, body.id);
}

// Speed the abilities add on top of the shop's passives (shop.applyPassives).
function speedMult(body, t = now()) {
    if (!body) return 1;
    let m = 1;
    if (body.rushUntil > t) m *= RUSH.speed;
    if (body.burrowUntil > t) m *= BURROW.speedMult;
    if (body.rocketUntil > t) m *= ROCKET.speed;
    if (body.smokeHidden || body.smokeUntil > t) m *= SMOKE.speedMult;
    return m;
}
// Reload boost (gun.js), on top of the kit Overdrive's.
function fireMult(body, t = now()) {
    return body && body.rushUntil > t ? RUSH.fire : 1;
}
function refresh(body) {
    try { require('./shop.js').applyPassives(body); } catch { try { body.refreshBodyAttributes(); } catch { /* */ } }
}

// ── tick (game/index.js terrain pass, after the shop) ───────────────────
const burrowHits = [];
function tickBurrow(body, t) {
    const g = tg();
    if (!g) return;
    const r = radiusOf(body);
    const vx = body.velocity.x, vy = body.velocity.y, v = Math.hypot(vx, vy);
    const ax = v > 0.5 ? vx / v : Math.cos(body.facing || 0), ay = v > 0.5 ? vy / v : Math.sin(body.facing || 0);
    // clear two ticks of travel ahead, so the hull never touches a face (a
    // touch would kill its speed before the rock goes)
    const reach = r + Math.max(v, topSpeedOf(body)) * 2;
    const spots = [[body.x, body.y, r * 1.2], [body.x + ax * reach * 0.6, body.y + ay * reach * 0.6, r * 1.25], [body.x + ax * reach, body.y + ay * reach, r * 1.25]];
    for (const [x, y, R] of spots) {
        g.rocksHitByCircle(x, y, R, burrowHits);
        if (g.growingRocksHitByCircle) g.growingRocksHitByCircle(x, y, R, t, burrowHits);
        for (const rock of burrowHits) {
            if (!rock || rock.canyon || rock.ore === 4) continue;   // emeralds still need shooting
            if (g.damageRock(rock, rock.health + 1, x, y, false, body, true)) body.rocksMined = (body.rocksMined || 0) + 1;
        }
        burrowHits.length = 0;
    }
}

// Up you come: the cooldown scales with the time spent down, the rock round
// the hull blows out, and if anything is still on top of you, you are moved
// to the nearest open ground. Never leaves you stuck.
function endBurrow(body, t = now(), quiet = false) {
    if (!body.burrowUntil) return;
    const used = Math.max(0, Math.min(BURROW.maxMs, t - (body.burrowAt || t)));
    body.burrowUntil = 0;
    body.alpha = body._burrowAlpha == null ? 1 : body._burrowAlpha;
    body._burrowAlpha = null;
    const st = stateFor(body);
    if (st) {
        const cd = BURROW.cdBase + Math.round(used / 1000 * BURROW.cdPerSec);
        st.cd.burrow = t + cd;
        st.cdLen = st.cdLen || {};
        st.cdLen.burrow = cd;
    }
    refresh(body);
    if (!live(body)) return;
    const g = tg();
    if (g) {
        const r = radiusOf(body);
        crackRocks(body, body.x, body.y, r * BURROW.surfaceR + 40, 10);
        if (g.pointInRock(body.x, body.y) || g.rockHitByCircle(body.x, body.y, r * 0.8)) {
            const o = g.openSpotNear(body.x, body.y, r);
            if (o) { body.x = o.x; body.y = o.y; }
        }
    }
    if (!quiet) fx('surface', body.x, body.y, 0, Math.round(used), body.id);
    if (body.socket) talkState(body.socket);
}
function burrowing(body) { return !!(body && body.burrowUntil > now()); }

// ── smoke ───────────────────────────────────────────────────────────────
// Hidden = alpha 0 (bots skip anything at 0.5 or under, other players' view
// only shows it faintly up close, sockets.js) and smokeHidden for that.
const clouds = [];
const hidden = new Set();
function hideBody(body) {
    // where it went in: HUD marks (hunted, bounty, revenge, streaks) hold there
    const wasHidden = hidden.has(body);
    if (!wasHidden) { body._smokeX = body.x; body._smokeY = body.y; }
    if (body._smokeAlpha == null) body._smokeAlpha = body.alpha == null ? 1 : body.alpha;
    body.alpha = 0;
    body.smokeHidden = true;
    hidden.add(body);
    if (!wasHidden) refresh(body);
}
function unhideBody(body) {
    const wasHidden = hidden.has(body);
    hidden.delete(body);
    body.smokeHidden = false;
    if (body._smokeAlpha != null) {
        body.alpha = body.burrowUntil > now() ? Math.min(body._smokeAlpha, BURROW.alpha) : body._smokeAlpha;
        body._smokeAlpha = null;
    }
    if (wasHidden) refresh(body);
}
// Who sees a tank the smoke hides (sockets.js view): -1 = not sent at all,
// else the alpha to draw it at. Its own player and teammates see it as a
// ghost; to an enemy it's gone, however close, even from inside the cloud.
const SMOKE_PEEK = 0;
function smokeView(viewer, other) {
    if (!other || !other.smokeHidden) return 1;
    if (!viewer || !live(viewer)) return -1;
    if (viewer === other) return 0.35;
    if (viewer.team === other.team) return 0.5;
    return -1;
}
// Where the HUD may show a tank: where it went into the smoke while hidden.
function shownAt(body) {
    if (body && body.smokeHidden && body._smokeX != null) return { x: body._smokeX, y: body._smokeY };
    return body;
}

function inCloud(body, t) {
    for (const c of clouds) if (c.at <= t && c.until > t && (body.x - c.x) ** 2 + (body.y - c.y) ** 2 <= c.r * c.r) return true;
    return false;
}
// Once per tick: clouds that land pop, and whoever stands in one is hidden
// unless they shoot (the thrower gets a second of grace after the pop).
function tickSmoke(t) {
    for (let i = clouds.length - 1; i >= 0; i--) {
        const c = clouds[i];
        if (c.until <= t) { clouds.splice(i, 1); continue; }
        if (!c.popped && c.at <= t) {
            c.popped = true;
            fx('smoke', c.x, c.y, c.r, c.until - t, c.owner ? c.owner.id : 0);
        }
    }
    if (!clouds.length && !hidden.size) return;
    const list = clouds.length ? tanks() : [...hidden];
    for (const b of list) {
        if (!live(b)) { if (hidden.has(b)) unhideBody(b); continue; }
        const grace = b.smokeUntil > t && t - (b.smokeAt || 0) < SMOKE.graceMs;
        const hide = !b.isRoyaleBoss && inCloud(b, t) && (grace || !firing(b));
        if (hide) {
            if (!hidden.has(b) || b.alpha !== 0) hideBody(b);
            if (b.health && b.health.max > 0 && b.health.amount < b.health.max) {
                b.health.amount = Math.min(b.health.max, b.health.amount + b.health.max * SMOKE.healPerTick);
            }
        }
        else if (hidden.has(b)) {
            unhideBody(b);
            if (inCloud(b, t) && t - (b._unsmokeAt || 0) > 600) { b._unsmokeAt = t; fx('unsmoke', b.x, b.y, 0, 0, b.id); }
        }
    }
    // anyone hidden who walked out of every cloud (not in the tank list)
    for (const b of hidden) {
        if (!live(b) || !inCloud(b, t)) unhideBody(b);
    }
}

function tickRadar(body, t) {
    if (!body.socket) return;
    if (t - (body._radarAt || 0) < RADAR.everyMs) return;
    body._radarAt = t;
    const out = [];
    for (const o of tanks()) {
        if (o === body) continue;
        // in the smoke: the radar loses it too
        if (o.smokeHidden && hostile(body, o)) continue;
        const d = Math.hypot(o.x - body.x, o.y - body.y);
        if (d > RADAR.radius) continue;
        let f = 0;
        if ((o.carriedGems | 0) >= RADAR.carrier) f |= 1;
        if (o.isBot) f |= 2;
        if (o.isRoyaleBoss) f |= 4;
        if ((o.huntedLevel | 0) > 0) f |= 8;
        if (!hostile(body, o)) f |= 16;
        out.push([Math.round(o.x), Math.round(o.y), f, o.id | 0]);
        if (out.length >= 40) break;
    }
    try { body.socket.talk('AR', JSON.stringify(out)); } catch { /* */ }
}

function firing(body) {
    return !!(body.control && (body.control.fire || body.control.alt)) || !!body.sidearmFire;
}

function tickBody(body, t) {
    let more = false;
    if (!live(body)) {
        if (hidden.has(body)) unhideBody(body);
        if (body._abMove) endMotion(body, 0);
        if (body.burrowUntil) endBurrow(body, t, true);
        return false;
    }
    if (body._abMove) { tickMotion(body, t); more = more || !!body._abMove; }
    if (body._dash && tickDash(body, t)) more = true;
    if (body.burrowUntil) {
        if (body.burrowUntil > t) { tickBurrow(body, t); more = true; }
        else endBurrow(body, t);
    }
    if (body.smokeUntil) {
        if (body.smokeUntil > t) more = true;
        else { body.smokeUntil = 0; refresh(body); }
    }
    if (body.rushUntil) {
        if (body.rushUntil > t) more = true;
        else { body.rushUntil = 0; refresh(body); }
    }
    if (body.rocketUntil) {
        if (body.rocketUntil > t) more = true;
        else { body.rocketUntil = 0; refresh(body); }
    }
    if (body.radarUntil) {
        if (body.radarUntil > t) { tickRadar(body, t); more = true; }
        else { body.radarUntil = 0; if (body.socket) { try { body.socket.talk('AR', '[]'); } catch { /* */ } } }
    }
    return more;
}

function bigBodies() {
    const out = [];
    try {
        const ti = require('./titan.js');
        for (const team of [-1, -2]) { const o = ti.aliveFor(team); if (o) out.push(o); }
    } catch { /* */ }
    try { const b = require('./bosses.js').current(); if (b) out.push(b); } catch { /* */ }
    try { const c = require('./coreFinale.js').current(); if (c) out.push(c); } catch { /* */ }
    return out;
}

function tickPads(t, actors) {
    let big = null;
    for (let i = pads.length - 1; i >= 0; i--) {
        const p = pads[i];
        if (t > p.until) { padGone(p, t); pads.splice(i, 1); continue; }
        if (p.told && t - (p.toldAt || 0) >= 400) announcePad(p, t);
        if (t < p.armAt) continue;
        if (!big) big = bigBodies();
        for (const a of big.length ? actors.concat(big) : actors) {
            const b = a && a.body ? a.body : a;
            if (!live(b) || b.royaleLobby || b.padSafe || b.isRoyaleProtector) continue;
            const rr = PAD.radius + radiusOf(b) * 0.5;
            if ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 > rr * rr) continue;
            if (t - (b._padLaunchAt || 0) < PAD.againMs) continue;
            b._padLaunchAt = t;
            // whose pad it was (achievements: Air Mail)
            b._padBy = p.owner || null;
            b._padAt = t;
            const sp = topSpeedOf(b) * PAD.mult;
            if (b._abMove) endMotion(b, 0);
            startMotion(b, { kind: 'launch', vx: Math.cos(p.ang) * sp, vy: Math.sin(p.ang) * sp, speed: sp, until: t + PAD.launchMs });
            fx('launch', b.x, b.y, p.ang, Math.round(sp * PAD.launchMs / 33), b.id);
        }
    }
}

function tickWalls(t) {
    if (!walls.length) return;
    const g = tg();
    for (let i = walls.length - 1; i >= 0; i--) {
        const w = walls[i];
        const rock = w.rock;
        const mine = !!rock && rock.gen === w.gen;
        const up = mine && (rock.alive || rock.growing);
        if (up && t < w.until) continue;
        walls.splice(i, 1);
        if (up && g) { try { g.damageRock(rock, rock.health + 1, rock.worldCx || rock.wx, rock.worldCy || rock.wy, false, null); } catch { } }
        if (w.canyon && rock) rock.canyon = true;
    }
}

function tick(actors) {
    if (!ON) return;
    const t = now();
    tickNo++;
    if (pads.length) tickPads(t, actors || []);
    tickWalls(t);
    tickSmoke(t);
    tickOrbs(t);
    try { drops().tick(actors || [], t); } catch { }
    if (!busy.size) return;
    for (const body of busy) {
        let keep = false;
        try { keep = tickBody(body, t); } catch { keep = false; }
        if (!keep) busy.delete(body);
    }
}

// New raid: pads, walls and running effects go.
function resetRaid() {
    for (const p of pads) padGone(p);
    pads.length = 0;
    for (const w of walls) if (w.canyon && w.rock) w.rock.canyon = true;
    walls.length = 0;
    orbs.length = 0;
    clouds.length = 0;
    for (const b of [...hidden]) unhideBody(b);
    for (const b of busy) {
        b._abMove = null;
        if (b.burrowUntil) { b.burrowUntil = 0; b.alpha = b._burrowAlpha == null ? 1 : b._burrowAlpha; b._burrowAlpha = null; }
    }
    busy.clear();
    ledger.clear();
    try { drops().reset(); } catch { }
}
function drops() { return require('./abilityDrops.js'); }

function catalog() {
    return ABILITIES.filter(a => !a.retired).map(a => ({ id: a.id, cat: "ability", tier: 0, name: a.name, price: a.price, max: 0, desc: a.desc, cd: a.cd, place: a.place || 0 }));
}

module.exports = {
    ON, FREE_ON, FREE_POOL, DASH, ABILITIES, AB_BY_ID, GRAPPLE, BURROW, SHOCK, RADAR, WALL, SMOKE, RUSH, PAD, TRIAL_MS, ROCKET, FLARE,
    stateOf, stateFor, equipped, equippedOf, owns, dashOf, canDash, dash, use, cycle, canBuy, grant, addFound, equip, giveBot, cooldownLeft,
    canUse, placeRange, padSpotOk, burrowing, endBurrow, clouds, ledger, SMOKE_HIDDEN: hidden, wallPlan, preview, smokeView, shownAt, SMOKE_PEEK,
    onSpawn, onBanked, grantTwist, revokeTwist, rocketBoots, escapeFlare, speedMult, fireMult,
    tick, resetRaid, talkState, catalog, pads, walls, orbs, kitFx,
    _busy: busy,
};
