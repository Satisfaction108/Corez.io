// Loot chests: copper and epic. Six sit on the map at once (4 copper, 2
// epic), each parked in an EMPTY rock cell - a cell whose rock is gone and
// is held from regrowing until the chest is taken. Shoot or ram one to
// break it (about three seconds at full damage): it cracks as it goes, then
// bursts into a mixed spray of copper, azurite, shard and emerald gems.
// Epic chests always carry a kit item, copper ones rarely. A broken chest
// comes back somewhere else about 30 seconds later.
const gems = require('./gems.js');

const STORM_GRACE_MS = 6000;
const COPPER_ITEM_CHANCE = 0.15;
const CHEST_GEMS = { common: 250, epic: 500 };   // exact payouts
const PIT_CLEAR = 320;             // never share a spawn gap with a player
const RESPAWN_MS = 30000;
const WANT = { common: 4, epic: 2 };
// twists scale both (Loot Flood: twice the chests, half the wait)
function mods() { try { return require('./raidMods.js').get() || {}; } catch { return {}; } }
function want() { const m = mods().chestMult || 1; return { common: Math.round(WANT.common * m), epic: Math.round(WANT.epic * m) }; }
function respawnMs() { return RESPAWN_MS * (mods().chestRespawnMult || 1); }
let chests = [];
let nextId = 1;
let respawnQueue = [];       // { rare, at }
let lastSpawnErr = "";
let lastScheduleAt = 0;

function storm() { return require('./storm.js'); }

function alive() {
    chests = chests.filter(c => c && !c.isDead?.() && !c.isGhost);
    return chests;
}

// Every pad on the map, from the live modules first (their lists are the
// ones players actually stand on) and the grid's site lists as a fallback.
function allPads() {
    const out = [];
    try { for (const v of require('./vault.js').getVaults()) out.push(v); } catch { /* */ }
    try { for (const o of require('./outposts.js').getOutposts()) out.push(o); } catch { /* */ }
    try { for (const s of require('./shop.js').getShops()) out.push(s); } catch { /* */ }
    const tg = global.gameManager.terrainGrid;
    if (tg) {
        for (const v of (tg.vaultSites || [])) out.push(v);
        for (const o of (tg.outpostSites || [])) out.push(o);
        for (const s of (tg.shopSites || [])) out.push(s);
    }
    return out;
}
function padsBlocked(x, y, minD, pads = allPads()) {
    const tg = global.gameManager.terrainGrid;
    for (const s of pads) {
        // pads are drawn up to 1.4x their radius; keep the chest's own body
        // clear of that too
        const keep = Math.max(minD, ((s.r || 95) * 1.4) + 120);
        if ((s.x - x) ** 2 + (s.y - y) ** 2 < keep * keep) return true;
    }
    // spawn pits: a fresh drop must never land on top of a chest
    for (const pit of ((tg && tg.spawnPits) || [])) {
        if ((pit.x - x) ** 2 + (pit.y - y) ** 2 < PIT_CLEAR * PIT_CLEAR) return true;
    }
    return false;
}

// Players and bots only: walking every entity (gems, bullets, props) per
// candidate spot was a few hundred thousand checks whenever a chest kept
// failing to find a home, and that read as a hitch every second.
function tanks() {
    const out = [];
    try {
        for (const p of (global.gameManager.socketManager?.players || [])) if (p && p.body && !p.body.isDead?.()) out.push(p.body);
        for (const b of (global.gameManager.gameHandler?.bots || [])) if (b && !b.isDead?.()) out.push(b);
    } catch { /* */ }
    return out;
}
function tanksNear(x, y, minD, list = tanks()) {
    for (const e of list) {
        if ((e.x - x) ** 2 + (e.y - y) ** 2 < minD * minD) return true;
    }
    return false;
}
// Other chests: two of them side by side read as one lump and share a wall.
const CHEST_GAP = 300;
function chestNear(x, y, minD = CHEST_GAP) {
    for (const c of chests) {
        if (!c || c.isDead?.() || c._opened) continue;
        if ((c.x - x) ** 2 + (c.y - y) ** 2 < minD * minD) return true;
    }
    return false;
}
// A spot near (x, y) that is open ground and not on a pad or another chest.
function clearSpot(tg, x, y) {
    const pads = allPads();
    const ok = (px, py) => !(tg && tg.pointInRock && tg.pointInRock(px, py)) && (!tg || roomForChest(tg, px, py)) && !padsBlocked(px, py, 300, pads) && !chestNear(px, py);
    if (ok(x, y)) return { x, y };
    for (let ring = 1; ring <= 10; ring++) {
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + ring * 0.3;
            const nx = x + Math.cos(a) * 60 * ring, ny = y + Math.sin(a) * 60 * ring;
            if (ok(nx, ny)) return { x: nx, y: ny };
        }
    }
    return openGround(tg, x, y);
}

function openGround(tg, x, y) {
    if (!tg || !tg.pointInRock || !tg.pointInRock(x, y)) return { x, y };
    for (let ring = 1; ring <= 8; ring++) {
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + ring * 0.3;
            const nx = x + Math.cos(a) * 55 * ring, ny = y + Math.sin(a) * 55 * ring;
            if (!tg.pointInRock(nx, ny)) return { x: nx, y: ny };
        }
    }
    return null;
}

// ── empty cells ────────────────────────────────────────────────────────
// A cell is empty when its rock is dead and not growing back. The chest
// holds the cell (noRegrowUntil) so nothing grows over it, and lets go the
// moment it is opened. At least one side must be open ground, so the chest
// is never sealed inside solid wall.
function hasOpenSide(tg, rock) {
    if (!tg.pointInRock) return true;
    const s = (tg._voroRockSz || 1) * (tg.cellSize || 40);
    return !tg.pointInRock(rock.wx + s, rock.wy) || !tg.pointInRock(rock.wx - s, rock.wy) ||
           !tg.pointInRock(rock.wx, rock.wy + s) || !tg.pointInRock(rock.wx, rock.wy - s);
}

// Chest hulls are SIZE 36/40; this is the clear radius around the centre.
const CHEST_CLEAR_R = 58;
const CHEST_ZONE_R = 130;      // neighbours inside this may not regrow into it
function roomForChest(tg, x, y) {
    if (tg.rockHitByCircle && tg.rockHitByCircle(x, y, CHEST_CLEAR_R)) return false;
    if (tg.growingRockHitByCircle && tg.growingRockHitByCircle(x, y, CHEST_CLEAR_R, Date.now())) return false;
    return true;
}

// No spot with room (a fresh map is all rock but the small spawn pits): the
// chest smashes a landing pocket out of the rock it would overlap. Never
// through an emerald. The pocket stays open until the chest is opened.
function carvePocket(tg, x, y) {
    const hits = [];
    for (const rock of tg.rocks.values()) {
        if (!rock || !(rock.alive || rock.growing) || !rock.worldPoly) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        if ((rx - x) ** 2 + (ry - y) ** 2 > (CHEST_CLEAR_R + 160) ** 2) continue;
        let touch = (rx - x) ** 2 + (ry - y) ** 2 <= CHEST_CLEAR_R * CHEST_CLEAR_R;
        if (!touch) for (const p of rock.worldPoly) { if ((p[0] - x) ** 2 + (p[1] - y) ** 2 <= CHEST_CLEAR_R * CHEST_CLEAR_R) { touch = true; break; } }
        if (touch) hits.push(rock);
    }
    if (hits.some(r => r.ore === 4)) return false;
    for (const rock of hits) tg.damageRock(rock, rock.health + 1, rock.worldCx || rock.wx, rock.worldCy || rock.wy, false, null);
    return !tg.rockHitByCircle || !tg.rockHitByCircle(x, y, CHEST_CLEAR_R);
}

// ── reachability ───────────────────────────────────────────────────────
// Room around the chest is not enough: a pocket of dead cells ringed by live
// rock (or one carvePocket smashed out of solid wall) is a chest sealed in
// stone, and from outside it just looks like another rock. A chest only
// lands where a walk over open cells reaches carved floor (the canyon cells:
// lanes, pads, pits, the arena - they never regrow), and that walk is held
// open for as long as the chest stands.
const PATH_MAX = 24;           // cells (~110u each)
const PASS_R = 24;             // a tank must fit through each step
function lat(tg, i, j) { return tg.rocks.get(i * 100003 + j); }
function openCell(r) { return r && !r.alive && !r.growing && r.worldPoly && Number.isFinite(r.wx); }
function exitPath(tg, start) {
    if (!openCell(start)) return null;
    if (start.canyon) return [start];
    const prev = new Map([[start.k, null]]);
    let frontier = [start];
    for (let depth = 0; depth < PATH_MAX && frontier.length; depth++) {
        const next = [];
        for (const r of frontier) {
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nb = lat(tg, r.vi + di, r.vj + dj);
                if (!openCell(nb) || prev.has(nb.k)) continue;
                const mx = (r.wx + nb.wx) / 2, my = (r.wy + nb.wy) / 2;
                if (tg.rockHitByCircle && tg.rockHitByCircle(mx, my, PASS_R)) continue;
                if (tg.growingRockHitByCircle && tg.growingRockHitByCircle(mx, my, PASS_R)) continue;
                prev.set(nb.k, r);
                if (nb.canyon) {
                    const path = [];
                    for (let c = nb; c; c = prev.get(c.k)) path.push(c);
                    return path;
                }
                next.push(nb);
            }
        }
        frontier = next;
    }
    return null;
}

// Every rock (live or dead) whose outline comes within `r` of (x, y).
function rocksTouching(tg, x, y, r) {
    const out = [];
    for (const rock of tg.rocks.values()) {
        if (!rock || !rock.worldPoly) continue;
        const rx = rock.worldCx || rock.wx, ry = rock.worldCy || rock.wy;
        const reach = (rock.maxPolyRadius || 120) + r;
        if ((rx - x) ** 2 + (ry - y) ** 2 > reach * reach) continue;
        if (polyDist(rock.worldPoly, x, y) <= r) out.push(rock);
    }
    return out;
}
function polyDist(poly, x, y) {
    let inside = false, best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, ay] = poly[j], [bx, by] = poly[i];
        if (((ay > y) !== (by > y)) && x < (bx - ax) * (y - ay) / ((by - ay) || 1e-9) + ax) inside = !inside;
        const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
        const d = Math.hypot(x - (ax + t * ex), y - (ay + t * ey));
        if (d < best) best = d;
    }
    return inside ? 0 : best;
}

function pickCell(opts = {}) {
    const tg = global.gameManager.terrainGrid;
    if (!tg || !tg.rocks) return null;
    const st = opts.anywhere ? null : storm().snapshot(Date.now());
    const cells = [];
    // Carved floor (canyon cells: pads, lanes, the arena) counts as empty
    // too - on a fresh map it is nearly all the empty ground there is.
    for (const rock of tg.rocks.values()) {
        if (!rock || rock.alive || rock.growing || !rock.worldPoly || rock.chestLock) continue;
        if (!Number.isFinite(rock.wx) || !Number.isFinite(rock.wy)) continue;
        cells.push(rock);
    }
    if (!cells.length) return null;
    const near = opts.near || null;
    const pads = allPads();
    const tankList = tanks();
    const tight = [];
    for (let i = 0; i < 90; i++) {
        const rock = cells[(Math.random() * cells.length) | 0];
        const x = rock.wx, y = rock.wy;
        if (near && (x - near.x) ** 2 + (y - near.y) ** 2 > near.r * near.r) continue;
        if (st && st.active !== false && !global.royaleFinal90 && Math.hypot(x - (st.cx || 0), y - (st.cy || 0)) > (st.r || 1000) * 0.85) continue;
        if (tg.circleRadius && Math.hypot(x, y) > tg.circleRadius - 180) continue;
        if (padsBlocked(x, y, 300, pads)) continue;
        if (chestNear(x, y)) continue;
        if (tanksNear(x, y, near ? 120 : 380, tankList)) continue;
        if (!hasOpenSide(tg, rock)) continue;
        // sealed pockets are out, whatever their size
        const path = exitPath(tg, rock);
        if (!path) continue;
        // the whole boulder has to fit: a small dead cell with one open side
        // used to put a chest half on top of the live rock around it
        if (!roomForChest(tg, x, y)) { if (tight.length < 8) tight.push({ rock, path }); continue; }
        rock._exitPath = path;
        return rock;
    }
    // carving only removes rock, so a tight cell that already has a way out
    // keeps it
    for (const t of tight) if (carvePocket(tg, t.rock.wx, t.rock.wy)) { t.rock._exitPath = t.path; return t.rock; }
    return null;
}

// Holds are counted so two chests sharing a corridor cell don't release it
// for each other. terrainGrid.startRegrow refuses any held rock.
function holdRock(chest, rock) {
    if (!rock || rock.canyon || chest._held.has(rock)) return;
    chest._held.add(rock);
    rock._chestHolds = (rock._chestHolds | 0) + 1;
}

// Lock the area a chest stands in: its own cell, every rock whose outline
// comes near the hull (a neighbour can't grow into it), and the walk out.
function lockArea(chest, x, y, rock, path) {
    const tg = global.gameManager.terrainGrid;
    chest._held = chest._held || new Set();
    if (rock) {
        rock.chestLock = chest.chestId;            // one chest per cell
        chest.lockRock = rock;
    }
    if (!tg || !tg.rocks) return;
    for (const r of rocksTouching(tg, x, y, CHEST_CLEAR_R + 30)) if (!r.alive) holdRock(chest, r);
    for (const r of (path || [])) holdRock(chest, r);
    try { if (tg.addNoRegrowZone) chest._zone = tg.addNoRegrowZone(x, y, CHEST_ZONE_R, Number.MAX_SAFE_INTEGER); } catch { /* */ }
}
function lockCell(chest, rock) {
    if (!rock) return;
    lockArea(chest, rock.wx, rock.wy, rock, rock._exitPath);
    rock._exitPath = null;
}

function releaseCell(chest) {
    if (!chest) return;
    const rock = chest.lockRock;
    const until = Date.now() + 8000;
    if (rock && rock.chestLock === chest.chestId) {
        rock.chestLock = 0;
        // a short grace so the rock does not pop back over the loose gems
        if (!rock.canyon) rock.noRegrowUntil = until;
    }
    if (chest._held) {
        for (const r of chest._held) {
            r._chestHolds = Math.max(0, (r._chestHolds | 0) - 1);
            if (!r.canyon && !r._chestHolds) r.noRegrowUntil = Math.max(r.noRegrowUntil || 0, until);
        }
        chest._held = null;
    }
    if (chest._zone) {
        // the neighbours get the same short grace, then may regrow
        chest._zone.until = until;
        chest._zone = null;
    }
    // (debug / tutorial chests never had a cell: leave lockRock undefined so
    // onTaken queues no replacement for them)
    if (rock) chest.lockRock = null;
}

function spawnChest(x, y, rare, opts = {}) {
    const tg = global.gameManager.terrainGrid;
    const spot = opts.cell ? { x: opts.cell.wx, y: opts.cell.wy } : clearSpot(tg, x, y);
    if (!spot) return null;
    let o;
    try {
        o = new Entity({ x: spot.x, y: spot.y });
        o.define(rare ? 'lootChestRare' : 'lootChest');
    } catch (e) { lastSpawnErr = String(e && e.stack || e); return null; }
    o.team = TEAM_ROOM;
    o.isLootChest = true;
    o.chestId = nextId++;
    o.chestRare = !!rare;
    o.chestGems = opts.gems != null ? opts.gems : (rare ? CHEST_GEMS.epic : CHEST_GEMS.common);
    // epic chests always carry a kit item; copper ones rarely
    o.chestItem = opts.item !== undefined ? opts.item : (rare || Math.random() < COPPER_ITEM_CHANCE ? require('./shop.js').randomKitId() : null);
    o.chestBornAt = Date.now();
    o.facing = 0;
    o.refreshBodyAttributes();
    if (o.health) o.health.amount = o.health.max;
    o.hitters = new Map();
    o.on('damage', ({ damageInflictor = [] } = {}) => {
        o._dmgN = (o._dmgN | 0) + 1; o._lastDmgAt = Date.now();
        for (const src of damageInflictor) {
            let root = src, hops = 0;
            while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
            if (root && (root.isPlayer || root.isBot)) o.hitters.set(root.id, { body: root, at: Date.now() });
        }
    });
    o.on('dead', () => { try { onDestroyed(o); } catch (e) { console.error('[CHEST] onDestroyed', e && e.stack); } });
    if (opts.cell) lockCell(o, opts.cell);
    else {
        try { if (tg && tg.pushCircleFromVoronoi) tg.pushCircleFromVoronoi(o, o.realSize || 24); } catch { /* */ }
        // tutorial / debug drops: nothing may grow back over these either
        lockArea(o, o.x, o.y, null, null);
    }
    o.pinX = o.x; o.pinY = o.y;        // a ram never budges it
    chests.push(o);
    return o;
}

function spawnInCell(rare, opts = {}) {
    const cell = pickCell(opts);
    if (!cell) return null;
    return spawnChest(cell.wx, cell.wy, rare, { cell });
}

// Mixed spray of real ore, summing exactly to the chest's value.
function eruptGems(x, y, total, opener, rare) {
    const raidMods = require('./raidMods.js');
    const pieces = gems.splitValue(total, {
        share: rare ? { 4: 0.3, 3: 0.3, 2: 0.25, 1: 0.15 } : { 4: 0, 3: 0.2, 2: 0.4, 1: 0.4 },
        shardValue: 60, maxPieces: 40,
    });
    const now = Date.now();
    pieces.forEach((p, i) => {
        const ang = (i / pieces.length) * Math.PI * 2 + Math.random() * 0.5;
        const sp = 3 + Math.random() * 3.5;
        const gem = gems.spawnGem(x, y, Math.round(p.v * raidMods.gemValueMult(p.ore)), p.cls, p.size,
            Math.cos(ang) * sp, Math.sin(ang) * sp, p.ore);
        if (gem) gem.gemNoMagnetUntil = now + 900 + i * 40;
    });
}

function rootKiller(chest) {
    for (const k of (chest.finalKillers || [])) {
        let root = k, hops = 0;
        while (root && root.master && root.master !== root && hops++ < 8) root = root.master;
        if (root && (root.isPlayer || root.isBot) && !root.isDead?.()) return root;
    }
    let best = null, bestAt = 0;
    for (const h of (chest.hitters ? chest.hitters.values() : [])) {
        if (h.body && !h.body.isDead?.() && h.at > bestAt) { best = h.body; bestAt = h.at; }
    }
    return best;
}

function onTaken(chest) {
    releaseCell(chest);
    // a chest cleared by a raid reset or a budget trim owes no replacement
    if (chest.lockRock !== undefined && !chest.isTutorialBot && !chest._cleared) {
        respawnQueue.push({ rare: !!chest.chestRare, at: Date.now() + respawnMs() });
    }
}

// The chest broke: whoever landed the last hit gets the kit item, the gems
// spray for anyone quick enough.
function onDestroyed(chest) {
    if (!chest || chest._opened) return;
    chest._opened = true;
    const body = rootKiller(chest);
    const socket = body && body.socket;
    let itemMsg = "";
    let bonus = 0;
    if (chest.chestItem) {
        const shop = require('./shop.js');
        const item = shop.BY_ID.get(chest.chestItem);
        if (socket && shop.grantKit(socket, chest.chestItem)) itemMsg = item ? item.name : "";
        else if (socket) { bonus = 150; itemMsg = "kit full, +150 gems"; }
    }
    eruptGems(chest.x, chest.y, chest.chestGems + bonus, body, chest.chestRare);
    if (Config.dig_royale) try {
        const dr = require('../gamemodes/scripts/dig_royale.js');
        if (body) dr.onChestOpened(body, chest, itemMsg);
        else dr.fxAt(chest.x, chest.y, chest.chestRare ? "chestrare" : "chest");   // broken by a boss: still bursts
    } catch { /* */ }
    else if (socket) {
        try { socket.talk('KC', 'chest', itemMsg ? "Chest: " + itemMsg : "Chest opened", 0); } catch { /* */ }
        try { socket.talk('FX', Math.round(chest.x), Math.round(chest.y), chest.chestRare ? "chestrare" : "chest"); } catch { /* */ }
    }
    onTaken(chest);
}

// Kept for the tutorial and debug paths: force a chest open without shooting.
function openChest(chest, body) {
    if (!chest || chest.isDead?.() || chest._opened) return;
    if (body) chest.hitters.set(body.id, { body, at: Date.now() });
    try { chest.kill(); } catch { /* */ }
}

function tick(actors) {
    const list = alive();
    if (!list.length) return;
    const now = Date.now();
    const st = storm();
    for (const chest of list) {
        if (chest._opened) continue;
        if (st.inStorm(chest.x, chest.y)) {
            if (!chest._stormAt) chest._stormAt = now;
            else if (now - chest._stormAt > STORM_GRACE_MS) {
                chest._opened = true;
                onTaken(chest);
                try { chest.kill(); } catch { /* */ }
            }
        } else chest._stormAt = 0;
    }
}

// Replacements only ever come through the 30s queue now.
function ensureNearSpawn() { /* no-op: fixed budget, timed respawns */ }

// Keep exactly four copper and two epic chests in play; each taken chest
// respawns RESPAWN_MS later, somewhere else.
function schedule() {
    const now = Date.now();
    if (now - lastScheduleAt < 1000) return;
    lastScheduleAt = now;
    const live = alive().filter(c => !c._opened);
    const liveEpic = live.filter(c => c.chestRare).length;
    const liveCommon = live.length - liveEpic;
    // Due entries leave the queue; they become part of the deficit below
    // (counting them again here is how the map once held ten chests).
    respawnQueue = respawnQueue.filter(q => q.at > now);
    const queuedEpic = respawnQueue.filter(q => q.rare).length;
    const queuedCommon = respawnQueue.length - queuedEpic;
    const W = want();
    let needCommon = Math.min(W.common - liveCommon, W.common - liveCommon - queuedCommon);
    let needEpic = Math.min(W.epic - liveEpic, W.epic - liveEpic - queuedEpic);
    // Over budget (debug spawns, an old bug): retire the oldest extras
    // without a replacement so the map settles back to 4 + 2.
    const trim = (list, over) => {
        list.sort((a, b) => (a.chestBornAt || 0) - (b.chestBornAt || 0));
        for (let i = 0; i < over && i < list.length; i++) {
            const c = list[i];
            c._cleared = true; c._opened = true;
            releaseCell(c);
            try { c.kill(); } catch { /* */ }
        }
    };
    if (liveCommon > W.common) trim(live.filter(c => !c.chestRare), liveCommon - W.common);
    if (liveEpic > W.epic) trim(live.filter(c => c.chestRare), liveEpic - W.epic);
    // Anything the queue still owes is not a deficit; whatever is left over
    // (raid start, storm losses) spawns now, two per second at most.
    let budget = 2;
    while (budget-- > 0 && (needCommon > 0 || needEpic > 0)) {
        const rare = needEpic > 0 && (needCommon <= 0 || Math.random() < 0.5);
        if (!spawnInCell(rare)) break;
        if (rare) needEpic--; else needCommon--;
    }
}

function snapshot() {
    const now = Date.now();
    // e: entity id (the client links the row to the drawn boulder); a: age in
    // ms so a fresh chest plays its landing once, even for late joiners.
    return alive().filter(c => !c._opened).map(c => ({ id: c.chestId, e: c.id, x: Math.round(c.x), y: Math.round(c.y), rare: c.chestRare ? 1 : 0, a: Math.min(60000, now - (c.chestBornAt || now)) }));
}

function clearAll() {
    for (const c of alive()) { c._opened = true; c._cleared = true; releaseCell(c); try { c.kill(); } catch { /* */ } }
    chests = [];
    respawnQueue = [];
}

// Local verification helper (DBG chests): how the spawner sees the map.
function debugInfo() {
    const tg = global.gameManager.terrainGrid;
    let cells = 0, dead = 0, canyon = 0, noPoly = 0, locked = 0, total = 0;
    if (tg && tg.rocks) for (const rock of tg.rocks.values()) {
        total++;
        if (!rock) continue;
        if (rock.canyon) canyon++;
        if (!rock.worldPoly) noPoly++;
        if (!rock.alive && !rock.growing) dead++;
        if (rock.chestLock) locked++;
        if (!rock.alive && !rock.growing && rock.worldPoly && !rock.chestLock) cells++;
    }
    const pick = pickCell();
    return { alive: alive().length, queue: respawnQueue.length, total, dead, canyon, noPoly, locked, candidates: cells, pick: pick ? [Math.round(pick.wx), Math.round(pick.wy)] : null, lastSpawnErr: lastSpawnErr.slice(0, 300) };
}

module.exports = { spawnChest, spawnInCell, openChest, tick, ensureNearSpawn, schedule, snapshot, clearAll, eruptGems, alive, WANT, RESPAWN_MS, debugInfo };
